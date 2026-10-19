/**
 * Workbench tool adapter: `evolver_get_stage_context` and `evolver_submit_design`.
 *
 * Spec: docs/mvp/WORKBENCH-RESEARCH-SPEC.md section 6.
 *
 * What these tools are for
 * ------------------------
 * They let a DSH conversation CONTROL the research workbench with structured
 * JSON, so the page follows a real submission instead of being retyped by hand.
 * Two tools, deliberately:
 *
 *  - `evolver_get_stage_context` — read. What stage this task is in, what the
 *    model may do, what it must produce, what unblocks it, and which Skill
 *    applies. NO model call: everything is derived from stored facts, so
 *    polling it costs nothing and cannot drift from the store.
 *  - `evolver_submit_design` — write. A CLOSED union of five actions, each
 *    validated and CAS-guarded by the sidecar service.
 *
 * The owner is the invoking Agent, never a payload field
 * --------------------------------------------------------
 * `resolveActor` reads `ToolRunContext.agent.id ?? .sessionId` and throws
 * `OWNER_MISMATCH` when absent. `assertNoOwnerInPayload` then refuses any
 * request that names its own owner, and `assertNoForbiddenRequestFields`
 * separately refuses OUTPUT values (`revision`, `metric`, `verified`, …). Those
 * are different rules with different reasons, so they are separate functions:
 * one check named "no owner" quietly growing to cover everything would make
 * its name a lie. This follows `experiment-tools.ts` — a tool that accepts an
 * owner field is a privilege-escalation oracle, and the check belongs here
 * rather than in a prompt.
 *
 * What the prompt does NOT do
 * --------------------------
 * The stage Skill tells the model what to do. It does NOT enforce it. Hard
 * constraints live in `WorkbenchResearchService` (shape, size, CAS, owner,
 * source chain) and in the original P5/P6 and Phase 2/3 services, which keep
 * their own prerequisites. This file does NOT claim to sandbox every legacy
 * tool, because it does not.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { EvolverError } from '../../contracts/index.ts';
import { resolveRepoPath } from './repo-root.ts';

import {
  WorkbenchResearchService,
  WorkbenchContractError,
  createHostSourceResolver,
  publishedRootOf,
  type StageFacts,
} from '../../application/workbench-research-service.ts';
import { canonicalCommandKey } from '../../application/workbench-publication-coordinator.ts';
import {
  DiagramPublisher,
  scratchWorkspaceFor,
  type DiagramScratchConfig,
} from './workbench-diagram-publication.ts';
// A VALUE import, not `import type`: the projection is now constructed and
// provided here (see `applyWorkbenchTools`), so it must exist at runtime.
import { WorkbenchResearchStore as WorkbenchResearchProjection } from './workbench-research-projection.ts';
import {
  DIAGRAM_FORMATS,
  WORKBENCH_STAGES,
  validateCandidateBindingInput,
  validateModuleExplanation,
  validateCompositionExplanation,
  validateRegisterDiagramV2,
  type BoundRef,
  type CandidateBindingInput,
  type DiagramFormat,
  type StageContext,
  type WorkbenchStage,
  type WorkbenchTaskRecord,
} from '../../contracts/workbench.ts';

export const name = 'evolver-workbench-tools';

export interface WorkbenchToolConfig {
  repoRoot?: string;
  /** The sidecar root (repo-relative). */
  workbenchResearchRoot?: string;
  researchExecutionRoot?: string;
  paperOnlyRoot?: string;
  phase3ExperimentRoot?: string;
  /**
   * Stage policy + skill reference, read from TRUSTED host config.
   *
   * Never taken from a request: a model that could name its own stage policy
   * could grant itself permissions, which is exactly what SPEC section 6.3
   * rules out.
   */
  stagePolicyPath?: string;
  /**
   * Diagram scratch + published roots (repo-relative), for the W7 registrar.
   *
   * When absent the registrar and `evolver_register_diagram_output` are NOT
   * registered at all. That is the honest behaviour: without a scratch root the
   * host has nowhere to tell a diagram Skill to write, so offering the tool
   * would invite a call that can only fail.
   */
  diagram?: {
    scratchRoot: string;
  };
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    evolverWorkbenchTools?: WorkbenchResearchService;
    /**
     * The W7 diagram registrar, present only when the host configured
     * `workbenchResearch.diagram.scratchRoot`.
     *
     * Exposed so `attach_diagram` can read a registered draft back. It is NOT a
     * general file reader: it only resolves refs this plugin itself published.
     */
    evolverDiagramPublisher?: DiagramPublisher;
    /**
     * The v3 read-only projection, when the host configured the workbench roots.
     *
     * Present so the diagram registrar can compare a submitted mapping against
     * the structure the workbench itself renders, rather than against whatever
     * the submitter says the structure is.
     */
    evolverResearchProjection?: WorkbenchResearchProjection;
  }
}

/**
 * Owner fields a payload may never carry (mirrors experiment-tools.ts).
 *
 * Deliberately does NOT include `revision`: that is not an owner field, and a
 * check named "no owner in payload" should not silently grow into "no output
 * values either". `revision` is refused by REQUEST_FORBIDDEN_FIELDS below, for
 * the SPEC section 5.1 reason (a submission may not carry an output value).
 */
export const PAYLOAD_OWNER_FIELDS = Object.freeze([
  'actor', 'owner', 'ownerSessionId', 'sessionId', 'agentId', 'userId', 'caller',
]);

/**
 * Non-owner values a submission envelope may never carry (SPEC section 5.1).
 *
 * `revision` is here because the spec forbids "revision 输出值": a caller may
 * only send `expectedDesignRevision` as a CAS input, never a claimed revision
 * back. Without a named rule the rejection still happened — `assertNoExtraKeys`
 * treats `revision` as an unknown key — but the diagnostic then said "unknown
 * key" rather than naming the policy, which is exactly the confusion this list
 * exists to prevent.
 */
export const REQUEST_FORBIDDEN_FIELDS = Object.freeze([
  'revision', 'metric', 'score', 'ready', 'verified', 'operationStatus',
  'resultRefs', 'status',
]);

export function assertNoOwnerInPayload(payload: unknown, context = 'payload'): void {
  if (typeof payload !== 'object' || payload === null) return;
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (PAYLOAD_OWNER_FIELDS.includes(key)) {
      throw new EvolverError('OWNER_MISMATCH', `${context}.${key} is not accepted: the owner is the invoking Agent, never a request field`);
    }
  }
}

/**
 * Refuse an output value on the request ENVELOPE, by name.
 *
 * Runs on the top level and on `payload`, because a submitter that puts
 * `metric` inside the payload should learn it is forbidden there too, not that
 * some nested key was unexpected.
 */
export function assertNoForbiddenRequestFields(request: unknown, context = 'request'): void {
  const scan = (obj: unknown, where: string): void => {
    if (typeof obj !== 'object' || obj === null) return;
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      if (REQUEST_FORBIDDEN_FIELDS.includes(key)) {
        throw new WorkbenchContractError(
          'SCHEMA_VIOLATION',
          `${where}.${key} 不接受：提交只能携带输入与期望版本（expectedDesignRevision），不能自带结论字段（revision/metric/score/ready/verified/operationStatus）。`,
          { fieldPaths: [`${where}.${key}`] },
        );
      }
    }
  };
  scan(request, context);
  scan((request as Record<string, unknown> | null)?.payload, `${context}.payload`);
}

function resolveActor(_ctx: Context, exec: ToolRunContext): { ownerSessionId: string } {
  const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
  // `agent.id` first, exactly like every other evolver tool. Reading a context
  // property instead would throw "cannot get property ... without inject" and
  // abort every call.
  const sessionId = agent?.id ?? agent?.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new EvolverError('OWNER_MISMATCH', 'Caller context must provide a non-empty session owner');
  }
  return { ownerSessionId: sessionId.trim() };
}

function toErrorResult(err: unknown): { error: { code: string; message: string; retryable: boolean; fieldPaths?: string[] } } {
  if (err instanceof WorkbenchContractError) {
    return { error: { code: err.code, message: err.message, retryable: err.retryable, fieldPaths: err.fieldPaths } };
  }
  if (err instanceof EvolverError) {
    return { error: { code: err.code, message: err.message, retryable: false } };
  }
  return {
    error: {
      code: 'PREFLIGHT_FAILED',
      message: String(err instanceof Error ? err.message : err),
      retryable: false,
    },
  };
}

// ----------------- stage policy (trusted host config) -----------------

interface StagePolicyEntry {
  objectiveZh: string;
  allowedActions: Array<{ tool: string; purposeZh: string }>;
  expectedOutputs: string[];
  exitCriteriaZh: string[];
}

interface StagePolicy {
  schemaVersion: 1;
  stages: Record<string, StagePolicyEntry>;
  skill: { name: string; version: string; sha256: string };
}

/**
 * Load the stage policy from a trusted file.
 *
 * A missing or malformed policy is a HARD failure at load time, not a silent
 * default: a stage context with invented objectives would tell the model to do
 * things the host never authorised.
 */
function loadStagePolicy(repoRoot: string, policyPath: string | undefined): { policy: StagePolicy; ref: BoundRef } {
  const resolved = path.resolve(repoRoot, policyPath ?? 'configs/workbench/stage-policy.json');
  const body = fs.readFileSync(resolved, 'utf8');
  const policy = JSON.parse(body) as StagePolicy;
  if (policy.schemaVersion !== 1) {
    throw new EvolverError('POLICY_DENIED', `stage policy schemaVersion must be 1, got ${String(policy.schemaVersion)}`);
  }
  for (const stage of WORKBENCH_STAGES) {
    const entry = policy.stages[stage];
    if (entry === undefined) {
      throw new EvolverError('POLICY_DENIED', `stage policy is missing stage "${stage}"; every stage must declare its objective and exit criteria`);
    }
  }
  // The skill hash defaults to the policy file's own hash, so a changed Skill
  // or policy is visible in the operation diagnostics. An EMPTY string counts
  // as unpinned: `?? ` would not fall back for `''`, which would ship a stage
  // context whose skillRef proves nothing.
  const pinned = policy.skill?.sha256;
  const sha256 = typeof pinned === 'string' && /^[0-9a-f]{64}$/.test(pinned)
    ? pinned
    : createHash('sha256').update(body).digest('hex');
  return {
    policy: { ...policy, skill: { ...policy.skill, sha256 } },
    ref: {
      store: 'workbench',
      ref: {
        id: path.relative(repoRoot, resolved).split(path.sep).join('/'),
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    },
  };
}

// ----------------- the semantic graph, for the diagram stage -----------------

/**
 * The candidate a context is about.
 *
 * The same rule the context itself applies: an explicitly named candidate, else
 * the only one, else none. Picking the first of several would be exactly the
 * "silently choose a branch" behaviour SPEC §6.1 forbids.
 */
function stageContextCandidateKey(
  requested: string | undefined,
  task: WorkbenchTaskRecord,
): string | null {
  if (requested !== undefined && requested !== '') return requested;
  return task.candidateBindings.length === 1 ? (task.candidateBindings[0] as { candidateKey: string }).candidateKey : null;
}

/**
 * The Host's own semantic graph for a candidate, with the workspace each diagram
 * format must be written to.
 *
 * Deliberately built from the SAME projection the page renders, so the hash the
 * agent draws against is the hash the registrar will check against. A graph
 * assembled here by a second code path could drift from the page's and the
 * mapping check would then reject a correct diagram.
 */
type GraphContextResolution = {
  graph: StageContext['semanticGraph'];
  unresolved: Array<{ code: string; reasonZh: string }>;
  warnings?: Array<{ code: string; reasonZh: string }>;
};

function matchesBoundRef(raw: unknown, expected: BoundRef): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const object = raw as Record<string, unknown>;
  const ref = object.ref;
  if (typeof ref !== 'object' || ref === null || Array.isArray(ref)) return false;
  const artifact = ref as Record<string, unknown>;
  return object.store === expected.store
    && artifact.id === expected.ref.id
    && artifact.sha256 === expected.ref.sha256;
}

async function semanticGraphFor(
  ctx: Context,
  task: WorkbenchTaskRecord,
  candidateKey: string | null,
  variantKey: string | null,
): Promise<GraphContextResolution> {
  if (candidateKey === null) {
    return {
      graph: null,
      unresolved: [{ code: 'CANDIDATE_REQUIRED', reasonZh: task.candidateBindings.length === 0 ? '尚无已绑定候选，无法生成候选语义图。' : '存在多个候选时必须指定 candidateKey。' }],
    };
  }
  // A missing host dependency or failed source read is not the same as a
  // legitimate "no graph" result. Let the structured error reach the caller.
  let projection: WorkbenchResearchProjection | undefined;
  let publisher: DiagramPublisher | undefined;
  try {
    projection = ctx.evolverResearchProjection;
    publisher = ctx.evolverDiagramPublisher;
  } catch {
    throw new WorkbenchContractError('UNSUPPORTED_CAPABILITY', 'Host graph resolver is unavailable.');
  }
  if (projection === undefined) throw new WorkbenchContractError('UNSUPPORTED_CAPABILITY', 'Host graph resolver is unavailable.');
  const result = await projection.dataflowV3(task.taskId, candidateKey, variantKey);
  if ('error' in result) {
    const unavailable = new Set(['DEPENDENCY_NOT_READY', 'SOURCE_MISSING', 'SOURCE_AMBIGUOUS', 'VARIANT_REQUIRED', 'VARIANT_NOT_FOUND']);
    if (unavailable.has(result.code)) {
      return { graph: null, unresolved: [{ code: result.code, reasonZh: result.message }] };
    }
    throw new WorkbenchContractError(result.code, result.message, {
      retryable: result.code === 'SNAPSHOT_BUSY' || result.code === 'SOURCE_IO_ERROR',
      fieldPaths: ['candidateKey', ...(variantKey === null ? [] : ['variantKey'])],
    });
  }
  return {
    graph: {
      contractVersion: 2,
      graphRef: result.graphRef,
      semanticHashAlgorithm: 'workbench-flow-sha256-v2',
      variantKey: result.snapshot.variantKey,
      flow: result.flow,
      semanticHash: result.flow.semanticHash,
      level: result.flow.level,
      diagramWorkspaces: publisher === undefined ? [] : DIAGRAM_FORMATS.map((format) => {
        const ws = publisher.workspaceFor(task.taskId, result.flow.semanticHash, format);
        return { format, dir: ws.dir, expectedFile: path.basename(ws.expectedFile), allowedSidecars: ['mapping.json', 'validation-receipt.json'] };
      }),
    },
    unresolved: publisher === undefined
      ? [{ code: 'DIAGRAM_PUBLISHER_UNAVAILABLE', reasonZh: '图稿登记器未配置；仍可查看语义图，但不能安全登记图稿。' }]
      : [],
    warnings: [{ code: 'UNSUPPORTED_CAPABILITY', reasonZh: '此 Host 尚未配置 Host-observed validation witness；登记后的图稿保持 unverified，不得标为 available。' }],
  };
}

// ----------------- plugin -----------------

/**
 * The node/edge ids of the structure a diagram claims to depict.
 *
 * Read through the projection the Host already provides, so the mapping check
 * compares the diagram against the SAME graph the workbench renders. Returns
 * null when no graph can be produced (no bound candidate, no recipe): the
 * caller then omits the expectation rather than passing an empty check.
 */
async function currentStructureFor(
  ctx: Context,
  taskId: string,
  candidateKey: string,
  variantKey: string | null,
): Promise<{
  nodeIds: string[];
  edgeIds: string[];
  nodeLabels: Record<string, string>;
  edgeEndpoints: Record<string, { source: string; sourcePort: string; target: string; targetPort: string; relation: 'tensor' | 'supervision' | 'control' }>;
  semanticHash: string;
  graphRef: BoundRef;
  variantKey: string | null;
}> {
  if (candidateKey.length === 0) throw new WorkbenchContractError('INVALID_INPUT', 'candidateKey is required', { fieldPaths: ['candidateKey'] });
  let projection: WorkbenchResearchProjection | undefined;
  try { projection = ctx.evolverResearchProjection; }
  catch { throw new WorkbenchContractError('UNSUPPORTED_CAPABILITY', 'Host graph resolver is unavailable.'); }
  if (projection === undefined) throw new WorkbenchContractError('UNSUPPORTED_CAPABILITY', 'Host graph resolver is unavailable.');
  const result = await projection.dataflowV3(taskId, candidateKey, variantKey);
  if ('error' in result) {
    throw new WorkbenchContractError(result.code, result.message, {
      retryable: result.code === 'SNAPSHOT_BUSY' || result.code === 'SOURCE_IO_ERROR',
      fieldPaths: ['candidateKey', ...(variantKey === null ? [] : ['variantKey'])],
    });
  }
  return {
    nodeIds: result.flow.nodes.map((n) => n.id),
    edgeIds: result.flow.edges.map((e) => e.id),
    nodeLabels: Object.fromEntries(result.flow.nodes.map((node) => [node.id, node.labelZh])),
    edgeEndpoints: Object.fromEntries(result.flow.edges.map((edge) => [edge.id, {
      source: edge.source, sourcePort: edge.sourcePort, target: edge.target, targetPort: edge.targetPort, relation: edge.kind,
    }])),
    semanticHash: result.flow.semanticHash,
    graphRef: result.graphRef,
    variantKey: result.snapshot.variantKey,
  };
}

/**
 * The method keys this task may explain.
 *
 * Derived from the Host's own cards for the task, so the catalog and the page
 * cannot disagree about which methods exist.
 *
 * Returns null ONLY when the catalog genuinely cannot be determined — the
 * projection is not configured. An EMPTY catalog is a real answer ("this task
 * has no methods yet") and is returned as an empty Set, which REFUSES every
 * methodKey. Failing open on an empty catalog would let any string through,
 * which is the gap this function exists to close.
 */
async function methodCatalogFor(ctx: Context, taskId: string): Promise<Set<string> | null> {
  if (taskId.length === 0) return null;
  const projection = ctx.evolverResearchProjection;
  if (projection === undefined) return null;
  try {
    const designs = await projection.candidateDesignsFor(taskId);
    const keys = new Set<string>();
    for (const design of designs) {
      for (const tag of design.moduleTags) keys.add(tag.methodKey);
      // A bound candidate's raw card ids are also legitimate keys: the module
      // may be named by card identity before it has a method tag.
      for (const id of design.moduleCardRefs) keys.add(id);
      if (design.baselineCardRef !== null) keys.add(design.baselineCardRef);
    }
    return keys;
  } catch {
    return null;
  }
}

/**
 * Derive a stage's progress from what the store actually holds.
 *
 * SPEC section 6.1: "`working` 必须有对应非终态 operation；`complete` 必须满足
 * 对应发布条件". Both are therefore read, never assumed.
 *
 * The honest answer is often "nothing to report", and that is what this returns
 * when the store cannot answer: `workingOperationId` null and `completedBy`
 * null, plus an `unresolved` entry saying what is missing. Inventing a
 * completion here would let the model walk its own stage forward by asking.
 */
function stageProgress(
  service: WorkbenchResearchService,
  taskId: string,
  stage: WorkbenchStage,
): {
  inputRefs: BoundRef[];
  unresolved: Array<{ code: string; reasonZh: string }>;
  workingOperationId: string | null;
  completedBy: { operationId: string; resultRefs: BoundRef[] } | null;
} {
  const task = service.readTask(taskId);
  if (task === null) {
    return {
      inputRefs: [],
      unresolved: [{ code: 'TASK_NOT_FOUND', reasonZh: `产品任务 ${taskId} 不可读，无法判定阶段状态。` }],
      workingOperationId: null,
      completedBy: null,
    };
  }
  const operations = service.operationsForTask(taskId);

  // Stage-local input refs: what the model is allowed to consume for THIS stage.
  const inputRefs: BoundRef[] = [];
  if (stage === 'composition') {
    for (const binding of task.candidateBindings) {
      inputRefs.push({ store: 'paper_only', ref: binding.synthesisResultRef });
    }
  }

  // `working`: a NON-TERMINAL operation. Every committed design operation here is
  // terminal (succeeded), so this can only become true once a long-running
  // operation exists; until then it is honestly null.
  const working = operations.find((op) => op.status !== 'succeeded') ?? null;

  // `complete`: the publication that actually finishes this stage.
  //
  // composition completes on a bound candidate; every other stage needs an
  // experiment publication this store does not own, so it stays incomplete and
  // says why instead of being marked done.
  const completedBy = stage === 'composition' && task.candidateBindings.length > 0
    ? { operationId: operations[operations.length - 1]?.operationId ?? 'bind_candidate', resultRefs: [] }
    : null;

  const unresolved: Array<{ code: string; reasonZh: string }> = [];
  if (stage !== 'composition' && completedBy === null) {
    unresolved.push({
      code: 'STAGE_COMPLETION_EXTERNAL',
      reasonZh: `「${stage}」阶段的完成条件依赖实验发布，当前工作台侧车不持有该状态，因此不会判定为已完成；请以原服务的报告为准。`,
    });
  }
  if (stage === 'discovery' && inputRefs.length === 0 && task.annotationRefs.length === 0) {
    unresolved.push({
      code: 'NO_REGISTERED_SOURCE',
      reasonZh: '该任务尚未关联任何已登记资料；读论文阶段因此受阻。',
    });
  }

  return { inputRefs, unresolved, workingOperationId: working?.operationId ?? null, completedBy };
}

export function applyWorkbenchTools(ctx: Context, config: WorkbenchToolConfig): WorkbenchResearchService {
  const repoRoot = resolveRepoPath(config.repoRoot ?? '.');
  const researchExecutionRoot = path.resolve(repoRoot, config.researchExecutionRoot ?? 'artifacts/research-execution');
  const paperOnlyRoot = path.resolve(repoRoot, config.paperOnlyRoot ?? 'artifacts/paper-only');
  const workbenchResearchRoot = path.resolve(repoRoot, config.workbenchResearchRoot ?? 'artifacts/phase3/workbench-research');
  const service = new WorkbenchResearchService({
    root: workbenchResearchRoot,
    resolver: createHostSourceResolver({
      repoRoot,
      researchExecutionRoot,
      paperOnlyRoot,
      workbenchResearchRoot,
      ...(config.phase3ExperimentRoot === undefined
        ? {}
        : { phase3ExperimentRoot: path.resolve(repoRoot, config.phase3ExperimentRoot) }),
    }),
  });

  // The v3 READ-ONLY projection, provided here because the tools read it.
  //
  // THIS WAS MISSING, and it made `evolver_register_diagram_output` unusable: the
  // tool asks the projection what structure the diagram claims to depict, and
  // reading `ctx.evolverResearchProjection` on a context where nothing declared it
  // via `inject` THROWS rather than yielding `undefined` — so every call failed
  // with `PREFLIGHT_FAILED: cannot get property "evolverResearchProjection"
  // without inject`, which names neither the missing provider nor the fix. The
  // offline suites did not catch it because they build a plain-object stub that
  // happily returns `undefined`.
  //
  // It is the same class of bug this file already documents for `agent.id`: a
  // context property read that nobody provides is not a missing value, it is a
  // throw. So the projection is constructed here and provided explicitly.
  const phase3ExperimentRoot = path.resolve(repoRoot, config.phase3ExperimentRoot ?? 'artifacts/phase3/experiments');
  const projection = new WorkbenchResearchProjection({
    repoRoot,
    researchService: service,
    roots: { researchExecutionRoot, paperOnlyRoot, phase3ExperimentRoot, workbenchResearchRoot },
  });
  ctx.provide('evolverResearchProjection', projection);

  const { policy, ref: policyRef } = loadStagePolicy(repoRoot, config.stagePolicyPath);

  const render = (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ];

  // ----------------- read: stage context -----------------

  ctx.tools.register(defineTool({
    name: 'evolver_get_stage_context',
    description:
      '科研工作台（只读）：获取当前阶段的目标、允许动作、输入 refs、预期产出、退出条件、未决项与对应 Skill。'
      + 'stageState 是 Host 从已发布事实派生的读模型，不是由请求设置的。'
      + '多候选任务在 implementation/analysis/next_proposal 阶段必须显式给出 candidateKey，否则返回 blocked。'
      + '本工具不做任何模型调用。',
    parameters: {
      taskId: { type: 'string', required: true, description: '产品任务 id（wb-…）；来源实验任务 id 不接受' },
      candidateKey: { type: 'string', description: '选定候选；读论文/任务级组合可省略，多候选的实现与分析阶段必须指定' },
      variantKey: { type: 'string', description: '冻结协议中的明确 variant；协议有多个 variant 时必须提供' },
      stage: { type: 'string', enum: [...WORKBENCH_STAGES], description: '请求的阶段；省略时由 Host 判定' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { stageContext: { type: 'object', additionalProperties: true }, error: { type: 'object', additionalProperties: true } } },
      render,
    },
    execute: async (args: unknown, exec: ToolRunContext) => {
      try {
        const actor = resolveActor(ctx, exec);
        const a = args as { taskId: string; candidateKey?: string; variantKey?: string; stage?: WorkbenchStage };
        assertNoOwnerInPayload(a);
        const task = service.readTask(a.taskId);
        if (task === null) {
          return { error: { code: 'DEPENDENCY_NOT_READY', message: `no product task ${a.taskId}; create one with evolver_submit_design action=create_task`, retryable: false } };
        }
        if (task.ownerSessionId !== actor.ownerSessionId) {
          // A workspace READ grant is not a write permission; the same applies to
          // the agent's own view of another session's task.
          return { error: { code: 'OWNER_MISMATCH', message: `task ${a.taskId} belongs to another session`, retryable: false } };
        }
        const entry = policy.stages[a.stage ?? 'discovery'];
        // `working` and `complete` are derived from the STORE, never from the
        // request: a model must not be able to declare its own work finished.
        //
        // They are computed from this task's OWN operations — the sidecar
        // records every committed design operation, and an experiment operation
        // for the same task is looked up through the same store. Until the
        // experiment store is wired into this tool, `complete` stays
        // unreachable for stages whose completion depends on a publication;
        // that is stated in `unresolved` rather than faked.
        const progress = stageProgress(service, a.taskId, a.stage ?? 'discovery');
        const facts: StageFacts = {
          objectiveZh: entry.objectiveZh,
          inputRefs: progress.inputRefs,
          allowedActions: entry.allowedActions,
          expectedOutputs: entry.expectedOutputs,
          exitCriteriaZh: entry.exitCriteriaZh,
          unresolved: progress.unresolved,
          workingOperationId: progress.workingOperationId,
          completedBy: progress.completedBy,
        };
        const graphContext = await semanticGraphFor(
          ctx,
          task,
          stageContextCandidateKey(a.candidateKey, task),
          a.variantKey ?? null,
        );
        const stageContext = await service.getStageContext(task, {
          ...(a.stage === undefined ? {} : { stage: a.stage }),
          ...(a.candidateKey === undefined ? {} : { candidateKey: a.candidateKey }),
          facts,
          policyRef,
          skillRef: policy.skill,
          budgetRef: null,
          // The complete content-addressed graph snapshot comes from the same
          // resolver the page and registrar use; it is not a hash-only hint.
          semanticGraph: graphContext.graph,
        });
        stageContext.unresolved = [...stageContext.unresolved, ...graphContext.unresolved];
        const workspacesReady = (graphContext.graph?.diagramWorkspaces.length ?? 0) > 0;
        stageContext.diagramCapability = {
          state: graphContext.graph === null || graphContext.unresolved.length > 0 || !workspacesReady ? 'blocked' : 'ready',
          reasons: [...graphContext.unresolved, ...(graphContext.warnings ?? [])],
        };
        return { stageContext };
      } catch (err) { return toErrorResult(err); }
    },
  }));

  // ----------------- write: structured submission -----------------

  ctx.tools.register(defineTool({
    name: 'evolver_submit_design',
    description:
      '科研工作台（写入）：以结构化 JSON 提交一个受约束动作，并返回真实回执。'
      + 'action 为封闭集合：create_task / bind_candidate / annotate_module / annotate_design / attach_diagram。'
      + '除 create_task 外必须提供 taskId 与 expectedDesignRevision（CAS）。'
      + '请求不得携带 owner、agentId、revision、metric、score、ready、verified、operationStatus 或任何文件路径。'
      + '中文解释不得把组合假设标为 source_reported，也不得携带实测数值。'
      + '本工具只增加工作台侧车版本，不会创建候选、执行检查或产出指标。',
    parameters: {
      commandId: { type: 'string', required: true, description: '幂等键（同一 owner 下重复提交同一 commandId 返回原回执；同键不同内容拒绝）' },
      request: { type: 'object', additionalProperties: true, required: true, description: 'UpdateDesignRequest：{schemaVersion,commandId,action,taskId,expectedDesignRevision,payload}' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          receipt: { type: 'object', additionalProperties: true },
          operation: { type: 'object', additionalProperties: true },
          task: { type: 'object', additionalProperties: true },
          error: { type: 'object', additionalProperties: true },
        },
      },
      render,
    },
    execute: async (args: unknown, exec: ToolRunContext) => {
      try {
        const actor = resolveActor(ctx, exec);
        const a = args as { commandId: string; request: unknown };
        assertNoOwnerInPayload(a.request, 'request');

        const request = a.request as Record<string, unknown>;
        assertNoForbiddenRequestFields(request, 'request');
        const action = String(request?.action ?? '');

        // create_task is a SEPARATE request shape. Routing it through the update
        // path with expectedDesignRevision=0 would make "task does not exist"
        // indistinguishable from "revision is stale".
        if (action === 'create_task') {
          const created = await service.createTask(
            request as never,
            actor,
          );
          return { receipt: created.receipt, operation: created.operation, task: created.task };
        }

        // Validate the action-specific payload HERE, before the service takes a
        // lock, so an illegal shape never reaches a lease or an index write.
        const payload = request?.payload as Record<string, unknown> | undefined;
        if (action === 'bind_candidate') {
          const candidate = validateCandidateBindingInput(payload?.candidate, 'request.payload.candidate');
          const pinResolution = ctx.evolverResearchProjection?.resolveCandidateGraphPins(candidate.sourceTaskRefs)
            ?? { ok: false as const, code: 'UNSUPPORTED_CAPABILITY', message: 'graph source resolver is unavailable' };
          const published = await service.bindCandidate(request as never, actor, candidate, pinResolution.ok ? pinResolution.pins : null);
          return {
            receipt: published.receipt,
            operation: published.operation,
            task: published.task,
            graphPins: pinResolution.ok
              ? { state: 'pinned', recipeRef: pinResolution.pins.recipeRef, protocolRef: pinResolution.pins.protocolRef, variantSelection: 'explicit-at-read' }
              : { state: 'unavailable', code: pinResolution.code, message: pinResolution.message },
          };
        }
        if (action === 'annotate_module') {
          const methodKey = String(payload?.methodKey ?? '');
          const explanation = validateModuleExplanation(payload?.explanation, 'request.payload.explanation');
          // The catalog comes from the Host's own cards for this task, so a
          // model cannot invent a method identity.
          const catalog = await methodCatalogFor(ctx, String(request?.taskId ?? ''));
          const published = await service.annotateModule(
            request as never,
            actor,
            { methodKey, explanation },
            // A null catalog DEFERES the check rather than passing it: the tool
            // must not pretend to have verified something it could not read.
            ...(catalog === null ? [] : [catalog]),
          );
          return { receipt: published.receipt, operation: published.operation, task: published.task };
        }
        if (action === 'annotate_design') {
          const candidateKey = String(payload?.candidateKey ?? '');
          const rawModules = Array.isArray(payload?.moduleExplanations) ? (payload.moduleExplanations as Array<Record<string, unknown>>) : [];
          const moduleExplanations = rawModules.map((m, i) => ({
            methodKey: String(m.methodKey ?? ''),
            explanation: validateModuleExplanation(m.explanation, `request.payload.moduleExplanations[${i}].explanation`),
          }));
          const compositionExplanation = validateCompositionExplanation(payload?.compositionExplanation, 'request.payload.compositionExplanation');
          const published = await service.annotateDesign(
            request as never,
            actor,
            { candidateKey, moduleExplanations, compositionExplanation },
          );
          return { receipt: published.receipt, operation: published.operation, task: published.task };
        }
        if (action === 'attach_diagram') {
          // W7: the diagram must already be REGISTERED. A bare path is refused,
          // so a diagram can only enter the sidecar through the registrar that
          // checked the scratch workspace, the fixed filename and the format.
          const draftRef = payload?.diagramDraftRef as BoundRef | undefined;
          if (draftRef === undefined || typeof draftRef?.ref?.id !== 'string') {
            return {
              error: {
                code: 'INVALID_INPUT',
                message: 'attach_diagram 需要 evolver_register_diagram_output 返回的 diagramDraftRef；不接受裸路径',
                retryable: false,
              },
            };
          }
          const publisher = ctx.evolverDiagramPublisher;
          if (publisher === undefined) {
            return {
              error: {
                code: 'UNSUPPORTED_CAPABILITY',
                message: '本宿主未配置绘图登记入口（diagram.scratchRoot 缺失），无法关联图稿',
                retryable: false,
              },
            };
          }
          // SPEC section R4.1: production readDraft resolves the ref through the
          // v2 commit index, so an uncommitted or non-draft object is refused here
          // rather than being decoded just because JSON sits at the ref.
          const draft = publisher.readDraft(draftRef);
          if (draft === null) {
            return { error: { code: 'DEPENDENCY_NOT_READY', message: `diagramDraftRef ${draftRef.ref.id} 不是已提交的图稿草稿；请先成功登记`, retryable: false } };
          }
          if (draft.schemaVersion !== 2) {
            return { error: { code: 'SCHEMA_VIOLATION', message: `diagramDraftRef ${draftRef.ref.id} 不是 draft v2；本轮只接受 v2 登记`, retryable: false } };
          }
          const candidateKey = String(payload?.candidateKey ?? '');
          if (draft.candidateKey !== candidateKey) {
            throw new WorkbenchContractError('SOURCE_MISMATCH', 'diagram draft candidateKey does not match attach payload', { fieldPaths: ['payload.candidateKey'] });
          }
          // SPEC section R4.3: an attach of a ref the task ALREADY carries is a
          // no-change replay of a committed command. The current GraphSnapshot
          // moves with every design revision, so re-checking the draft against it
          // here would make every legitimate replay fail with SOURCE_MISMATCH --
          // the graph content did not change, only the revision the snapshot was
          // cut at. Replay is answered from the commit index below instead, and
          // the fresh-structure check stays reserved for genuinely new commands.
          const replayRequest = request as { taskId?: string; commandId?: string };
          const alreadyAttached = service.readTask(String(replayRequest.taskId ?? ''))?.diagramRefs
            .some((existing) => existing.ref.id === draftRef.ref.id && existing.ref.sha256 === draftRef.ref.sha256) ?? false;
          const published = await service.attachDiagram(
            request as never,
            actor,
            { candidateKey, diagramDraftRef: draftRef },
            alreadyAttached
              ? undefined
              : async () => {
                const current = await currentStructureFor(ctx, String(replayRequest.taskId ?? ''), candidateKey, draft.variantKey ?? null);
                if (draft.semanticHash !== current.semanticHash || !matchesBoundRef(draft.graphRef, current.graphRef)) {
                  throw new WorkbenchContractError('SOURCE_MISMATCH', 'diagram draft no longer identifies the current GraphSnapshot; re-register it against the current candidate graph', { fieldPaths: ['payload.diagramDraftRef'] });
                }
                return [current.graphRef];
              },
          );
          return { receipt: published.receipt, operation: published.operation, task: published.task };
        }
        return {
          error: {
            code: 'SCHEMA_VIOLATION',
            message: `unknown action ${JSON.stringify(action)}; allowed: create_task, bind_candidate, annotate_module, annotate_design, attach_diagram`,
            retryable: false,
          },
        };
      } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.provide('evolverWorkbenchTools', service);

  // ----------------- W7: diagram output registration -----------------

  if (config.diagram !== undefined) {
    // Round-2 defect (SPEC section 1.1): the registrar used to publish into `R`
    // while `WorkbenchResearchService.resolveRefFile`, the projection and every
    // download consumer resolve workbench refs under `R/published`. The registrar
    // was therefore one directory too shallow for every other reader, and a
    // diagram it had just committed was reported as "no longer resolvable" by the
    // very attach that was supposed to consume it.
    //
    // The fix is not a second path constant: the published root is DERIVED from
    // the same resolver the service uses, so the two can never drift again.
    const diagramConfig: DiagramScratchConfig = {
      scratchRoot: path.resolve(repoRoot, config.diagram.scratchRoot),
      publishedRoot: publishedRootOf(workbenchResearchRoot),
      storeRoot: workbenchResearchRoot,
    };
    const publisher = new DiagramPublisher(diagramConfig);
    ctx.provide('evolverDiagramPublisher', publisher);

    ctx.tools.register(defineTool({
      name: 'evolver_register_diagram_output',
      description:
        '登记绘图 Skill 的产出（不是任意文件上传）。只接受固定工作区与固定文件名：'
        + 'archify_html → diagram.html，excalidraw → diagram.excalidraw。'
        + 'semanticHash 由 Host 依据当前结构计算，请求方不能自带。'
        + '本工具不增加 designRevision；关联到任务需另一次 attach_diagram。'
        + '登记不做视觉检查：没有 validation-receipt.json 时图稿状态为 unverified，这是诚实状态。',
      parameters: {
        schemaVersion: { type: 'number', required: true, description: '固定为数字 2；其它版本由严格 execute validator 拒绝' },
        outputKey: { type: 'string', required: true, description: '本轮只登记 main；其它 key 由严格 execute validator 拒绝' },
        commandId: { type: 'string', required: true, description: '幂等键' },
        taskId: { type: 'string', required: true, description: '产品任务 id' },
        candidateKey: { type: 'string', required: true, description: '图稿描述的候选' },
        variantKey: { type: 'json', required: true, description: '冻结协议中的 variant；字符串或 null，具体值由严格 execute validator 校验' },
        expectedDesignRevision: { type: 'number', required: true, description: '调用方认为当前的 designRevision；由严格 execute validator 校验并做 CAS' },
        semanticGraphRef: { type: 'object', required: true, additionalProperties: true, description: 'BoundRef：本次阶段上下文提供的 GraphSnapshot；Host 会重验' },
        format: { type: 'string', required: true, enum: ['archify_html', 'excalidraw'], description: '目标格式；一次只选一种' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            receipt: { type: 'object', additionalProperties: true },
            diagramDraftRef: { type: 'object', additionalProperties: true },
            workspace: { type: 'object', additionalProperties: true },
            error: { type: 'object', additionalProperties: true },
          },
        },
        render,
      },
      execute: async (args: unknown, exec2: ToolRunContext) => {
        try {
          const actor = resolveActor(ctx, exec2);
          const a = args as Record<string, unknown>;
          assertNoOwnerInPayload(a);

          // SPEC section R3.1: the tool validates the RAW arguments against
          // RegisterDiagramV2 before reading anything from them. The old wrapper
          // read `taskId` and `format` with `String(...)` and filled
          // `expectedDesignRevision` from the task it had just loaded, so a
          // request with no version, a string version, or a wrong CAS value was
          // silently coerced into a legal-looking registration.
          const validated = validateRegisterDiagramV2(a);
          if (!validated.ok) {
            throw new WorkbenchContractError(validated.code, validated.message, { fieldPaths: validated.fieldPaths });
          }
          const request = validated.value;
          const { taskId, candidateKey, format } = request;
          const variantKey = request.variantKey;

          const task = service.readTask(taskId);
          if (task === null) throw new WorkbenchContractError('DEPENDENCY_NOT_READY', `no product task ${taskId}`, { fieldPaths: ['taskId'] });
          if (task.ownerSessionId !== actor.ownerSessionId) {
            throw new WorkbenchContractError('OWNER_MISMATCH', `task ${taskId} belongs to another session`, { fieldPaths: ['taskId'] });
          }
          // SPEC section R3.2 / R4.3: a command that already committed is
          // answered from the commit index BEFORE any CAS check or graph
          // re-resolution. "后来 revision 变化不重执行原已提交命令" -- a later
          // revision change must not turn a replay into REVISION_CONFLICT, and
          // the fresh-structure check must not re-run against a snapshot that the
          // original commit already validated.
          const replayKey = canonicalCommandKey({ ownerSessionId: actor.ownerSessionId, action: 'register_diagram_output', commandId: request.commandId });
          const alreadyCommitted = publisher.publicationCoordinator.readCommitIndex().publications[replayKey];
          if (alreadyCommitted === undefined) {
            // SPEC section R3.4: the caller's CAS is CHECKED, never replaced. The
            // old wrapper passed `task.designRevision`, which compared the task to
            // itself and therefore always passed -- an unconditional write wearing
            // a compare-and-swap field.
            if (task.designRevision !== request.expectedDesignRevision) {
              throw new WorkbenchContractError(
                'REVISION_CONFLICT',
                `expectedDesignRevision ${request.expectedDesignRevision} does not match the current designRevision ${task.designRevision}`,
                { retryable: true, fieldPaths: ['expectedDesignRevision'] },
              );
            }

            // Re-resolve the current graph while handling registration. The
            // model's hash/ref are consistency claims only; the Host supplies the
            // values that the registrar stores and the mapping validator checks.
            const expected = await currentStructureFor(ctx, taskId, candidateKey, variantKey);
            const hostGraphRef = expected.graphRef;
            if (hostGraphRef.store !== 'workbench') {
              throw new WorkbenchContractError('SOURCE_MISMATCH', 'Host GraphSnapshot must be stored in the workbench store', { fieldPaths: ['semanticGraphRef'] });
            }
            const semanticGraphRef = { store: 'workbench' as const, ref: hostGraphRef.ref };
            if (!matchesBoundRef(a.semanticGraphRef, semanticGraphRef)) {
              throw new WorkbenchContractError('SOURCE_MISMATCH', 'semanticGraphRef does not identify the current Host GraphSnapshot', { fieldPaths: ['semanticGraphRef'] });
            }
            const workspace = scratchWorkspaceFor(diagramConfig, { taskId, semanticHash: expected.semanticHash, format });
            const registered = publisher.register({
              schemaVersion: 2,
              outputKey: 'main',
              taskId,
              commandId: request.commandId,
              ownerSessionId: actor.ownerSessionId,
              expectedDesignRevision: request.expectedDesignRevision,
              candidateKey,
              variantKey: expected.variantKey,
              semanticGraphRef,
              semanticHash: expected.semanticHash,
              format,
              expectedNodeIds: expected.nodeIds,
              expectedEdgeIds: expected.edgeIds,
              expectedNodeLabels: expected.nodeLabels,
              expectedEdgeEndpoints: expected.edgeEndpoints,
            });
            return { receipt: registered.receipt, diagramDraftRef: registered.diagramDraftRef, workspace };
          }

          // Committed replay path: answer from the commit index without
          // re-executing. The recorded requestHash already covers the original
          // canonical request, so nothing is recomputed here and no part of the
          // original request (including the Host-computed semantic hash) is
          // invented or substituted.
          const committedEntry = alreadyCommitted;
          if (committedEntry.diagramDraftRef === undefined) {
            throw new WorkbenchContractError('ARTIFACT_CORRUPT', `operation ${committedEntry.operationId} is committed without a diagram draft ref`, { retryable: false, fieldPaths: ['commandId'] });
          }
          return {
            receipt: { ...(committedEntry.receipt as Record<string, unknown>), reused: true },
            diagramDraftRef: committedEntry.diagramDraftRef,
          };
        } catch (err) { return toErrorResult(err); }
      },
    }));
  }

  return service;
}

export type { CandidateBindingInput };
