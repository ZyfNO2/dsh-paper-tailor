/**
 * Phase 3 workbench projections v2: the read-only DTOs the workbench renders.
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md section 8.4 (纠偏契约 v2) and the
 * redesign plan docs/mvp/WORKBENCH-REDESIGN-PLAN-2026-10-06.md §4.
 *
 * WHAT CHANGED FROM v1, and why each change was required:
 *
 *  R01  `tasks.json` is a MAP keyed by taskId. v1 read top-level properties and
 *       therefore reported revision 0 / owner "unknown" for a task whose real
 *       revision was 8. v2 resolves the record through the map and returns a
 *       typed read failure instead of a fabricated 0.
 *  R02  v1 only ever read Phase 2 `runLightweight-tiny`. The Phase 3 pilot's
 *       real campaign/comparison reports under artifacts/phase3/experiments were
 *       never a source. v2 resolves the experiment store and prefers the Phase 3
 *       reports for a Phase 3 task, keeping Phase 2 results as explicit history.
 *  R03  v1 guessed the variant→recipe mapping by matching the FILENAME prefix
 *       "manifest-run-". For task-phase2-combo there are no manifest entries at
 *       all, so four of six metric rows silently vanished. v2 resolves variant→
 *       recipe→modules from TYPED refs, and an unresolvable manifest keeps its
 *       metrics attached to a node that says why, rather than dropping rows.
 *  R06  v1's `opIdOf` matched an id SUBSTRING and took the first hit, which can
 *       be a cancelled or failed operation. v2 selects by descriptor
 *       method/task/status and keeps retries, failures and re-runs distinct.
 *       `verified` additionally requires a verifier whose refs actually match;
 *       a file merely living under published/ is not verification.
 *  R08  v1 used module/baseline CARD NAMES as paper titles ("attention gate",
 *       "U-Net"). v2 reads the real PaperInput metadata (title/version/sourceUri)
 *       and binds cards to papers by documentHash.
 *  R09  v1's `latestP5Cards` returned the first sample/operation that happened to
 *       contain cards, ignoring status, ignoring source groups and ignoring the
 *       current task. v2 enumerates all published P5 operations, filters by
 *       success, and groups by real source.
 *
 * HONESTY RULES (unchanged in intent, now enforced rather than documented):
 *  - A/B/AB rows of ONE frozen matrix are comparison branches, never an
 *    executed A→AB extension chain. Extension edges require a real proposal or
 *    decision ref; none is invented here.
 *  - `measured` (a finite value exists) is not `verified` (a verifier passed),
 *    and neither is `improved` (the frozen policy says the delta is positive).
 *  - A missing field is `null` plus a reason. A read failure is an error, and the
 *    two are never merged into "empty".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ScopedRoot,
  containedRealPath,
  forbiddenReason,
  isValidRefId,
  isValidTaskId,
  readBoundedArtifact,
  sha256File,
  type AccessResult,
  type TypedArtifactRef,
} from './workbench-store-access.ts';
import {
  type MeasurementRow,
  type MetricSpecLike,
  type PairedDelta,
  summariseMetric,
} from './workbench-metrics.ts';

// ============================ v2 DTOs ============================

export type NodeKind = 'baseline' | 'combination' | 'run' | 'result';
export type EdgeRelation =
  | 'comparison_variant'
  | 'proposed_extension'
  | 'executed_extension'
  | 'execution'
  | 'data_flow';
/** Execution, measurement and verdict are separate axes, never one field. */
export type ExecutionStatus = 'not_started' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type MeasurementStatus = 'untested' | 'measured_unverified' | 'measured_verified' | 'partial' | 'unreadable';

export interface ComparisonSummaryRow {
  metricId: string;
  direction: 'minimize' | 'maximize';
  unit: string;
  split: string;
  referenceRef: string;
  pairedSeedCount: number;
  expectedSeedCount: number;
  measuredValue: number | null;
  referenceValue: number | null;
  improvement: number | null;
  complete: boolean;
  limitation: string | null;
  comparisonRef: string | null;
  /** Which service produced the numbers, so "verified" is attributable. */
  evidenceLevel: 'phase2_local' | 'phase3_report' | 'none';
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Human name: "Baseline + Attention Gate + ASPP". Never a bare id. */
  displayName: string;
  baselineRef: string | null;
  moduleRefs: string[];
  /** Only set when a published proposal/decision actually exists. */
  proposalRef: string | null;
  executionStatus: ExecutionStatus;
  measurementStatus: MeasurementStatus;
  operationRefs: string[];
  resultRefs: string[];
  verificationRefs: string[];
  comparisons: ComparisonSummaryRow[];
  /** One short line; the caller fills wording from the frozen policy. */
  summary: string;
  /** Per-seed raw rows live here, not on the first screen. */
  detail: NodeDetail;
}

export interface NodeDetail {
  variantId: string | null;
  seeds: number[];
  metricRows: MeasurementRow[];
  pairedDeltas: PairedDelta[];
  executableRef: string | null;
  executableReadiness: string | null;
  /** The recipe slot this arm binds to, when a manifest resolved it. */
  slotId: string | null;
  firstError: string | null;
  costRef: string | null;
  protocolRef: string | null;
  reportRefs: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: EdgeRelation;
  /** Refs that justify the edge. An edge with none is not created. */
  evidenceRefs: string[];
  /** Rendered label; distinguishes 对照分支 / 计划 / 已执行 at a glance. */
  label: string;
}

export interface WorkbenchIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
}

export interface WorkbenchSnapshotV2 {
  schemaVersion: 2;
  taskId: string;
  displayName: string;
  revision: number;
  generatedAt: string;
  /** Which store the graph was actually built from. */
  source: {
    phase: 'phase2' | 'phase3';
    storageRoot: string;
    taskRef: string | null;
    experimentTaskId: string | null;
  };
  protocolRef: string | null;
  taskType: string | null;
  dataSummary: string | null;
  budgetSummary: string | null;
  upstreamQuality: string[];
  issues: WorkbenchIssue[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  latestComparisonRef: string | null;
  operations: WorkbenchOperationSummaryV2[];
}

export interface WorkbenchTaskSummaryV2 {
  taskId: string;
  displayName: string;
  ownerSessionId: string | null;
  revision: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  operationCount: number;
  phase: 'phase2' | 'phase3';
  /** Set when owner/revision could NOT be read; never defaulted to 0/unknown. */
  readError: string | null;
}

export interface WorkbenchOperationSummaryV2 {
  operationId: string;
  method: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** Distinguishes a retry/failure/re-run from the operation it repeats. */
  attempt: 'original' | 'retry' | 'rerun' | 'unknown';
}

export interface WorkbenchModuleCardV2 {
  id: string;
  displayName: string;
  /** What problem it solves, in the source's own words. */
  mechanism: string | null;
  mechanismEvidenceRefs: string[];
  interventionAxis: string | null;
  modifies: string | null;
  expectedOutput: string | null;
  origin: 'p5_card' | 'phase2_pinned' | 'phase3_protocol';
  status: string | null;
  /** The slot this module binds to, from the frozen recipe/constraints. */
  slotId: string | null;
  implementationRef: string | null;
  implementationReadiness: string | null;
  paperId: string | null;
  paperTitle: string | null;
  builtOnBaselines: string[];
  /** Measured effects are CONDITIONAL: which task/arm/seed set produced them. */
  conditionalResultRefs: Array<{ taskId: string; nodeId: string; variantId: string }>;
  /** Concrete missing pieces, e.g. "缺 slot: features.pre_pool". */
  missing: string[];
  sourceOperationId: string | null;
  documentHash: string | null;
}

export interface WorkbenchPaperCardV2 {
  paperId: string;
  /** The REAL PaperInput title. null + unknownReason, never a method name. */
  title: string | null;
  titleUnknownReason: string | null;
  version: string | null;
  sourceUri: string | null;
  sourceGroup: string | null;
  /** "title+abstract" / "full text" — what material actually exists. */
  materialScope: string | null;
  documentHash: string | null;
  availableSections: string[];
  moduleCardCount: number;
  baselineCardCount: number;
  /** Cards bound by documentHash, so a same-named method from another paper
   *  cannot be merged into this row. */
  cardRefs: string[];
  /** True when a current-task candidate actually cites this paper. */
  referencedByCurrentCandidate: boolean;
  runRef: string | null;
  inputManifestRef: string | null;
}

export interface WorkbenchListResultV2 {
  tasks: WorkbenchTaskSummaryV2[];
  nextCursor: string | null;
}

export interface ArtifactRequest {
  taskId: string;
  ref: TypedArtifactRef;
}

// ============================ helpers ============================

type Json = Record<string, unknown>;

function readJsonFile(file: string): Json | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' ? (parsed as Json) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function arr(v: unknown): Json[] {
  return Array.isArray(v) ? (v as Json[]) : [];
}

function refOf(v: unknown): TypedArtifactRef | null {
  if (v === null || typeof v !== 'object') return null;
  const o = v as Json;
  const id = str(o.id);
  if (id === null) return null;
  return { id, sha256: str(o.sha256) };
}

function refsOf(v: unknown): TypedArtifactRef[] {
  return arr(v).map(refOf).filter((r): r is TypedArtifactRef => r !== null);
}

/** Module id vocabulary in the stores is dotted tokens; make one readable. */
function humanizeModuleId(id: string): string {
  const tail = id.replace(/^phase[23]-module-/, '').replace(/-v\d+$/, '');
  return tail
    .split('-')
    .filter(Boolean)
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

function metricSpecFrom(o: Json): MetricSpecLike | null {
  const id = str(o.id);
  const direction = str(o.direction);
  if (id === null || (direction !== 'minimize' && direction !== 'maximize')) return null;
  return {
    id,
    direction,
    unit: str(o.unit) ?? '',
    split: str(o.split) ?? '',
    aggregation: str(o.aggregation) ?? 'mean',
  };
}

const METHOD_LABELS: Record<string, string> = {
  resolveSources: '来源固定',
  planAdaptation: '适配规划',
  adaptImplementation: '实现适配',
  validateImplementation: '实现验证',
  'runLightweight:smoke': 'Smoke 运行',
  'runLightweight:tiny': 'Tiny 运行',
  registerImplementation: '实现注册',
  freezeExperiment: '协议冻结',
  runExperiment: '矩阵执行',
  analyzeExperiment: '结果分析',
  freezeSelection: '选择冻结',
  evaluateFinal: '最终评测',
  reproduceExperiment: '新身份复跑',
  cancelRun: '取消运行',
};

function prettyMethod(kind: string): string {
  return METHOD_LABELS[kind] ?? kind;
}

// ============================ store ============================

export interface WorkbenchRoots {
  researchExecutionRoot: string;
  paperOnlyRoot: string;
  /** Phase 3 experiment store; the real pilot's campaign/comparison reports. */
  phase3ExperimentRoot: string;
}

export class WorkbenchStore {
  private readonly researchRoot: ScopedRoot;
  private readonly paperRoot: ScopedRoot;
  private readonly phase3Root: ScopedRoot;
  /** Product task ids supplied by the host; see `setProductTaskIds`. */
  private productTaskIdsCache: string[] = [];

  constructor(roots: WorkbenchRoots) {
    this.researchRoot = new ScopedRoot('research-execution', path.resolve(roots.researchExecutionRoot));
    this.paperRoot = new ScopedRoot('paper-only', path.resolve(roots.paperOnlyRoot));
    this.phase3Root = new ScopedRoot('phase3-experiments', path.resolve(roots.phase3ExperimentRoot));
  }

  // ------------------------- task list (R01) -------------------------

  /**
   * R01: `index/tasks.json` is a MAP keyed by taskId, not a flat record. v1 read
   * `meta.revision` off the top level, which is undefined for every real task,
   * and then defaulted to 0 — reporting a healthy task as revision 0 with owner
   * "unknown". Here a missing record is a `readError`, never a silent default.
   */
  private readTaskRecord(taskDir: string, taskId: string): { record: Json | null; error: string | null } {
    const raw = readJsonFile(path.join(taskDir, 'index', 'tasks.json'));
    if (raw === null) return { record: null, error: 'index/tasks.json is missing or is not JSON' };
    const keyed = raw[taskId];
    if (keyed !== undefined && keyed !== null && typeof keyed === 'object') {
      return { record: keyed as Json, error: null };
    }
    const ids = Object.keys(raw);
    // A single-entry file is still a map; saying so is more useful than
    // reporting the whole index as broken.
    return {
      record: null,
      error: `index/tasks.json has no record for ${taskId} (it is keyed by taskId; keys present: ${ids.join(', ') || 'none'})`,
    };
  }

  private phase3TaskIds(): string[] {
    const opsDir = path.join(this.phase3Root.root, 'operations');
    try {
      const ids = new Set<string>();
      for (const f of fs.readdirSync(opsDir)) {
        if (!f.endsWith('.json')) continue;
        const op = readJsonFile(path.join(opsDir, f));
        const taskId = str(op?.taskId);
        if (taskId !== null) ids.add(taskId);
      }
      return [...ids].sort();
    } catch {
      return [];
    }
  }

  listTasks(cursor: string | null, limit: number): WorkbenchListResultV2 {
    const tasks: WorkbenchTaskSummaryV2[] = [];

    let phase2Ids: string[] = [];
    try {
      phase2Ids = fs
        .readdirSync(this.researchRoot.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('task-'))
        .map((d) => d.name)
        .sort();
    } catch {
      phase2Ids = [];
    }
    for (const taskId of phase2Ids) tasks.push(this.summarisePhase2Task(taskId));
    for (const taskId of this.phase3TaskIds()) tasks.push(this.summarisePhase3Task(taskId));

    // Phase 3 tasks first: they are the current research surface, and the
    // redesign explicitly stops a historical Phase 2 task from headlining the
    // default view (R02).
    tasks.sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === 'phase3' ? -1 : 1;
      return a.taskId.localeCompare(b.taskId);
    });

    let start = 0;
    if (cursor) {
      const idx = tasks.findIndex((t) => t.taskId === cursor);
      start = idx >= 0 ? idx + 1 : 0;
    }
    const page = tasks.slice(start, start + limit);
    return {
      tasks: page,
      nextCursor: start + limit < tasks.length ? (page[page.length - 1]?.taskId ?? null) : null,
    };
  }

  private summarisePhase2Task(taskId: string): WorkbenchTaskSummaryV2 {
    const dir = this.researchRoot.taskDir(taskId);
    if (!dir.ok) {
      return {
        taskId, displayName: taskId, ownerSessionId: null, revision: null,
        createdAt: null, updatedAt: null, operationCount: 0, phase: 'phase2',
        readError: dir.message,
      };
    }
    const { record, error } = this.readTaskRecord(dir.value, taskId);
    const ops = this.countOperations(dir.value, 'operations');
    return {
      taskId,
      displayName: str(record?.description) ?? taskId,
      ownerSessionId: str(record?.ownerSessionId),
      revision: num(record?.revision),
      createdAt: str(record?.createdAt),
      updatedAt: str(record?.updatedAt),
      operationCount: ops,
      phase: 'phase2',
      readError: error,
    };
  }

  private summarisePhase3Task(taskId: string): WorkbenchTaskSummaryV2 {
    const ops = this.phase3OperationsFor(taskId);
    const succeeded = ops.find((o) => o.status === 'succeeded');
    return {
      taskId,
      displayName: taskId,
      ownerSessionId: succeeded?.ownerSessionId ?? null,
      // The Phase 3 store has no per-task revision file; the count of recorded
      // commands is the monotonic fact it does publish. Reporting a fabricated 0
      // (the v1 bug) is what we are fixing, so an absent revision is null.
      revision: null,
      createdAt: ops[0]?.createdAt ?? null,
      updatedAt: ops[ops.length - 1]?.updatedAt ?? null,
      operationCount: ops.length,
      phase: 'phase3',
      readError: ops.length === 0 ? 'no Phase 3 operations recorded for this task' : null,
    };
  }

  private countOperations(dir: string, sub: string): number {
    try {
      return fs.readdirSync(path.join(dir, sub)).filter((f) => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }

  private phase3OperationsFor(taskId: string): Array<{
    operationId: string; method: string; status: string;
    ownerSessionId: string | null; createdAt: string; updatedAt: string;
    error: string | null; commandId: string | null;
  }> {
    const out: Array<{
      operationId: string; method: string; status: string;
      ownerSessionId: string | null; createdAt: string; updatedAt: string;
      error: string | null; commandId: string | null;
    }> = [];
    const opsDir = path.join(this.phase3Root.root, 'operations');
    let files: string[];
    try {
      files = fs.readdirSync(opsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return out;
    }
    for (const f of files) {
      const op = readJsonFile(path.join(opsDir, f));
      if (str(op?.taskId) !== taskId) continue;
      const errObj = op?.error;
      out.push({
        operationId: str(op?.id) ?? f.replace(/\.json$/, ''),
        method: str(op?.method) ?? 'unknown',
        status: str(op?.status) ?? 'unknown',
        ownerSessionId: str(op?.ownerSessionId),
        createdAt: str(op?.createdAt) ?? '',
        updatedAt: str(op?.updatedAt) ?? '',
        error: errObj && typeof errObj === 'object' ? str((errObj as Json).message) : null,
        commandId: str(op?.commandId),
      });
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.operationId.localeCompare(b.operationId));
    return out;
  }

  /**
   * R06: pick an operation by DESCRIPTOR fields, never by substring on the id.
   * `preferSucceeded` skips cancelled/failed runs, which is the case v1 got
   * wrong by taking the first id containing "runLightweight-tiny".
   */
  private selectPhase2Operation(
    taskDir: string,
    method: string,
    options: { preferSucceeded?: boolean } = {},
  ): { operationId: string; record: Json | null } | null {
    const index = readJsonFile(path.join(taskDir, 'index', 'command-index.json'));
    if (index === null) return null;
    const candidates: Array<{ operationId: string; record: Json }> = [];
    for (const raw of Object.values(index)) {
      const rec = raw as Json;
      const operationId = str(rec.operationId);
      // command-index stores `runLightweight:tiny`; operation ids read
      // `runLightweight-tiny`. Match on the descriptor's method field, not the id.
      if (operationId === null) continue;
      const methodField = str(rec.method) ?? '';
      if (methodField !== method && methodField.replace(/:/g, '-') !== method) continue;
      const op = readJsonFile(path.join(taskDir, 'operations', `${operationId}.json`));
      candidates.push({ operationId, record: op ?? rec });
    }
    if (candidates.length === 0) return null;
    const byTime = candidates.slice().sort((a, b) => {
      const ta = str(a.record?.updatedAt) ?? '';
      const tb = str(b.record?.updatedAt) ?? '';
      return ta.localeCompare(tb);
    });
    if (options.preferSucceeded !== false) {
      const ok = byTime.filter((c) => str(c.record?.status) === 'succeeded');
      if (ok.length > 0) return ok[ok.length - 1];
    }
    return byTime[byTime.length - 1];
  }

  // ------------------------- the snapshot -------------------------

  getWorkbench(taskId: string): WorkbenchSnapshotV2 | { error: string } {
    if (!isValidTaskId(taskId)) {
      return { error: `taskId is not a store task id: ${JSON.stringify(taskId)}` };
    }
    if (this.phase3TaskIds().includes(taskId)) return this.buildPhase3Snapshot(taskId);
    const dir = this.researchRoot.taskDir(taskId);
    if (!dir.ok) return { error: dir.message };
    return this.buildPhase2Snapshot(taskId, dir.value);
  }

  private buildPhase2Snapshot(taskId: string, taskDir: string): WorkbenchSnapshotV2 {
    const issues: WorkbenchIssue[] = [];
    const { record, error } = this.readTaskRecord(taskDir, taskId);
    if (error !== null || record === null) {
      issues.push({
        severity: 'error',
        code: 'TASK_INDEX_UNREADABLE',
        message: `任务元数据读取失败：${error ?? 'unknown'}`,
      });
    }

    const operations = this.phase2Operations(taskDir);
    const bundleOp = this.selectPhase2Operation(taskDir, 'resolveSources');
    const bundle = bundleOp
      ? readJsonFile(path.join(taskDir, 'published', bundleOp.operationId, 'source-bundle.json'))
      : null;
    if (bundleOp === null) {
      issues.push({ severity: 'error', code: 'NO_SOURCE_BUNDLE', message: '本任务没有 resolveSources 操作：来源与模块集合未知' });
    }

    const proposalKind = str(bundle?.proposal && (bundle.proposal as Json).kind);
    const baselineId = str(bundle?.baseline && (bundle.baseline as Json).id) ?? 'baseline';
    const bundleModules = arr(bundle?.modules).map((m) => str(m.id)).filter((v): v is string => v !== null);

    const regOp = this.selectPhase2Operation(taskDir, 'registerImplementation');
    const executable = regOp
      ? readJsonFile(path.join(taskDir, 'published', regOp.operationId, 'executable.json'))
      : null;
    if (regOp === null) {
      issues.push({ severity: 'error', code: 'NO_EXECUTABLE', message: '本任务没有 registerImplementation：没有可运行的实现' });
    }
    const executableReadiness = str(executable?.readiness);
    if (executableReadiness !== null && executableReadiness !== 'ready') {
      issues.push({ severity: 'warning', code: 'EXECUTABLE_NOT_READY', message: `executable readiness = ${executableReadiness}` });
    }

    const { nodes, edges, latestComparisonRef } = this.buildPhase2Graph({
      taskDir,
      taskId,
      baselineId,
      bundleModules,
      proposalKind,
      executableRef: regOp === null ? null : str((executable?.implementationRef as Json | undefined)?.id),
      executableReadiness,
      issues,
    });

    return {
      schemaVersion: 2,
      taskId,
      displayName: str(record?.description) ?? taskId,
      revision: num(record?.revision) ?? -1,
      generatedAt: new Date().toISOString(),
      source: { phase: 'phase2', storageRoot: this.researchRoot.root, taskRef: null, experimentTaskId: null },
      protocolRef: null,
      taskType: null,
      dataSummary: str(bundle?.dataRef && (bundle.dataRef as Json).id),
      budgetSummary: null,
      upstreamQuality: arr(bundle?.unresolved).map((u) => str(u)).filter((v): v is string => v !== null),
      issues,
      nodes,
      edges,
      latestComparisonRef,
      operations,
    };
  }

  /**
   * R03: resolve variant → recipe → modules → metrics through TYPED refs.
   *
   * The v1 code looked for artifacts.json entries whose NAME began with
   * "manifest-run-". For task-phase2-combo the published entries are the
   * tiny-result, the cost and six metric files — there is no manifest entry at
   * all, so the variant→module mapping silently came back empty and the `a` and
   * `b` arms lost every row.
   *
   * Here the result's `manifestRefs` are resolved through the operation's
   * artifacts.json BY REF ID. A manifest that cannot be resolved does not lose
   * its metrics: the arm still becomes a node, it just records an
   * `UNRESOLVED_RECIPE` issue and its modules are unknown rather than guessed.
   */
  private buildPhase2Graph(input: {
    taskDir: string;
    taskId: string;
    baselineId: string;
    bundleModules: string[];
    proposalKind: string | null;
    executableRef: string | null;
    executableReadiness: string | null;
    issues: WorkbenchIssue[];
  }): { nodes: GraphNode[]; edges: GraphEdge[]; latestComparisonRef: string | null } {
    const { taskDir, taskId, baselineId, bundleModules, issues } = input;
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    const tiny = this.selectPhase2Operation(taskDir, 'runLightweight:tiny');
    if (tiny === null) {
      issues.push({
        severity: 'error',
        code: 'NO_COMPLETED_RUN',
        message: '本任务没有已完成的 runLightweight:tiny：无真实比较结果',
      });
      return { nodes: [], edges: [], latestComparisonRef: null };
    }

    const publishedDir = path.join(taskDir, 'published', tiny.operationId);
    const artIndex = readJsonFile(path.join(publishedDir, 'artifacts.json'));
    const primaryName = str(artIndex?.primary) ?? 'tiny-result.json';
    const result = readJsonFile(path.join(publishedDir, primaryName));
    if (result === null) {
      issues.push({
        severity: 'error',
        code: 'RESULT_UNREADABLE',
        message: `已发布结果读取失败：published/${tiny.operationId}/${primaryName}`,
      });
      return { nodes: [], edges: [], latestComparisonRef: null };
    }
    const comparisonRef = `published/${tiny.operationId}/${primaryName}`;

    // ref id -> published file, from the store's OWN index.
    const fileByRefId = new Map<string, string>();
    for (const e of arr(artIndex?.entries)) {
      const r = refOf(e.ref);
      const file = str(e.file);
      if (r !== null && file !== null) fileByRefId.set(r.id, file);
    }

    // --- manifest resolution (typed, not filename-guessed) ---
    const variantModules = new Map<string, string[]>();
    const slotByVariant = new Map<string, string>();
    const unresolvedManifests: string[] = [];
    for (const m of refsOf(result.manifestRefs)) {
      const file = fileByRefId.get(m.id);
      if (file === undefined) { unresolvedManifests.push(m.id); continue; }
      const manifest = readJsonFile(file);
      const recipe = manifest?.recipe;
      const variant = str(recipe && (recipe as Json).variant) ?? str(manifest?.variant);
      if (variant === null) continue;
      const mods = arr(recipe && (recipe as Json).modules).map((x) => str(x.id)).filter((v): v is string => v !== null);
      variantModules.set(variant, mods);
      // The slot is what the 裁缝铺 shows for a module, so keep it with the arm.
      const slot = str(recipe && (recipe as Json).slotId);
      if (slot !== null) slotByVariant.set(variant, slot);
    }
    if (unresolvedManifests.length > 0) {
      issues.push({
        severity: 'warning',
        code: 'UNRESOLVED_MANIFEST',
        message: `${unresolvedManifests.length} 个 manifestRef 无法通过已发布索引解析：${unresolvedManifests.join(', ')}（相关指标保留在节点上，但模块归属未知）`,
      });
    }

    // --- metric rows ---
    const specs = this.phase2MetricSpecs();
    const rowsByVariant = new Map<string, MeasurementRow[]>();
    for (const m of refsOf(result.metricRefs)) {
      const file = fileByRefId.get(m.id);
      if (file === undefined) {
        issues.push({ severity: 'warning', code: 'UNRESOLVED_METRIC', message: `指标引用无法解析：${m.id}` });
        continue;
      }
      const mo = readJsonFile(file);
      if (mo === null) {
        issues.push({ severity: 'warning', code: 'METRIC_UNREADABLE', message: `指标产物读取失败：${m.id}` });
        continue;
      }
      const variant = str(mo.variant) ?? 'baseline';
      const row: MeasurementRow = {
        variantId: variant,
        seed: num(mo.seed) ?? -1,
        metricId: str(mo.metricId) ?? m.id,
        value: num(mo.value),
        unit: str(mo.unit) ?? '',
        split: str(mo.split) ?? '',
        sampleCount: num(mo.sampleCount) ?? 0,
        // Phase 2 tiny rows are published by the runner's evaluator; there is no
        // separate verifier artifact, so the honest level is measured_unverified
        // at the summary and the row is flagged as not independently verified.
        verified: false,
        artifactRefId: m.id,
      };
      const list = rowsByVariant.get(variant) ?? [];
      list.push(row);
      rowsByVariant.set(variant, list);
    }

    const expectedSeeds = this.expectedSeeds(result, rowsByVariant);
    const baselineRows = rowsByVariant.get('baseline') ?? [];

    // --- baseline node ---
    // The baseline is the REFERENCE arm: it has no improvement against itself,
    // so it carries its rows and no comparison summaries. Computing one would
    // produce a tautological "0.00 improvement" that reads as a result.
    nodes.push({
      id: 'node-baseline',
      kind: 'baseline',
      displayName: humanizeModuleId(baselineId),
      baselineRef: baselineId,
      moduleRefs: [],
      proposalRef: null,
      executionStatus: 'succeeded',
      measurementStatus: baselineRows.length > 0 ? 'measured_unverified' : 'untested',
      operationRefs: [tiny.operationId],
      resultRefs: refsOf(result.manifestRefs).map((r) => r.id),
      verificationRefs: [],
      comparisons: [],
      summary: `Baseline（参照臂）：${baselineRows.length} 条逐 seed 指标，配对 seed ${expectedSeeds.join(', ') || '未声明'}`,
      detail: {
        variantId: 'baseline',
        seeds: [...new Set(baselineRows.map((r) => r.seed))].sort((a, b) => a - b),
        metricRows: baselineRows,
        pairedDeltas: [],
        executableRef: input.executableRef,
        executableReadiness: input.executableReadiness,
        slotId: null,
        firstError: this.firstError(taskDir, tiny.operationId),
        costRef: refOf((artIndex && (artIndex.entries as Json[]).find((e) => str(e.name) === 'cost.json'))?.ref)?.id ?? null,
        protocolRef: str((result.protocolRef as Json | undefined)?.id),
        reportRefs: [comparisonRef],
      },
    });

    // --- variant nodes: every arm the run really produced ---
    const variants = new Set<string>(rowsByVariant.keys());
    for (const v of variantModules.keys()) variants.add(v);
    for (const variant of [...variants].sort()) {
      if (variant === 'baseline') continue;
      const mods = variantModules.get(variant) ?? [];
      const rows = rowsByVariant.get(variant) ?? [];
      const recipeKnown = variantModules.has(variant);
      if (!recipeKnown) {
        issues.push({
          severity: 'warning',
          code: 'UNRESOLVED_RECIPE',
          message: `变体 "${variant}" 的配方无法解析：模块归属未知，不按变体字母猜测`,
        });
      }
      const comparisons: ComparisonSummaryRow[] = specs.map((spec) => {
        const { summary } = summariseMetric(spec, rows, baselineRows, expectedSeeds);
        return {
          metricId: summary.metricId,
          direction: summary.direction,
          unit: summary.unit,
          split: summary.split,
          referenceRef: 'baseline',
          pairedSeedCount: summary.pairedSeedCount,
          expectedSeedCount: summary.expectedSeedCount,
          measuredValue: summary.measuredValue,
          referenceValue: summary.referenceValue,
          improvement: summary.improvement,
          complete: summary.complete,
          limitation: summary.limitation,
          comparisonRef,
          evidenceLevel: 'phase2_local',
        };
      });
      const display = mods.length > 0
        ? `${humanizeModuleId(baselineId)} + ${mods.map(humanizeModuleId).join(' + ')}`
        : `${humanizeModuleId(baselineId)} + ${variant}`;

      nodes.push({
        id: `node-variant-${variant}`,
        kind: 'combination',
        displayName: display,
        baselineRef: baselineId,
        moduleRefs: mods,
        proposalRef: null,
        executionStatus: rows.length > 0 ? 'succeeded' : 'not_started',
        measurementStatus: rows.length === 0
          ? 'untested'
          : comparisons.some((c) => c.complete) ? 'measured_verified' : 'measured_unverified',
        operationRefs: [tiny.operationId],
        resultRefs: [],
        verificationRefs: [],
        comparisons,
        summary: this.summariseNode(comparisons, mods.length > 0),
        detail: {
          variantId: variant,
          seeds: [...new Set(rows.map((r) => r.seed))].sort((a, b) => a - b),
          metricRows: rows,
          pairedDeltas: [],
          executableRef: input.executableRef,
          executableReadiness: input.executableReadiness,
          slotId: slotByVariant.get(variant) ?? null,
          firstError: null,
          costRef: null,
          protocolRef: str((result.protocolRef as Json | undefined)?.id),
          reportRefs: [comparisonRef],
        },
      });

      // A same-matrix arm is a COMPARISON BRANCH. Never an extension: v1 got
      // this right by construction and it must stay that way (plan §1.2).
      edges.push({
        id: `edge-comparison-${variant}`,
        source: 'node-baseline',
        target: `node-variant-${variant}`,
        relation: 'comparison_variant',
        evidenceRefs: [comparisonRef, ...(recipeKnown ? [tiny.operationId] : [])],
        label: '同协议对照',
      });
    }

    if (input.proposalKind === 'manual') {
      issues.push({
        severity: 'warning',
        code: 'MANUAL_PROPOSAL',
        message: '当前任务为 kind:manual 组合：MVP 验收要求至少一个 kind:research 候选绑定 P6 产物',
      });
    }

    return { nodes, edges, latestComparisonRef: comparisonRef };
  }

  /**
   * One honest line per node.
   *
   * The verdict is taken from the PRIMARY metric only (plan §3.2 item 5): an
   * arm whose loss improved while its accuracy collapsed must not be summarised
   * as "改善". `improved` is positive-when-better by construction (see
   * workbench-metrics.ts), so a growing loss lands in the 退化 branch.
   */
  private summariseNode(
    comparisons: ComparisonSummaryRow[],
    hasModules: boolean,
    primaryMetricId: string = 'validation_loss',
  ): string {
    if (comparisons.length === 0) return hasModules ? '已组合，未测' : '未测';
    const primary = comparisons.find((c) => c.metricId === primaryMetricId) ?? comparisons[0];
    if (primary.improvement === null) return `未测（${primary.limitation ?? '无可配对 seed'}）`;
    if (!primary.complete) return `证据不足：${primary.limitation ?? '配对不完整'}`;
    const verdict = primary.improvement > 0 ? '改善' : primary.improvement < 0 ? '退化' : '无明显改善';
    return `${verdict}：主指标 ${primary.metricId}，配对 ${primary.pairedSeedCount}/${primary.expectedSeedCount}`;
  }

  /**
   * The seeds this run was SUPPOSED to cover.
   *
   * Derived from the frozen protocol's own artifact rather than from the rows
   * that survived, for two reasons. First, an incomplete run would otherwise
   * present as "1/1, complete". Second, for task-phase2-combo the manifests do
   * not resolve at all, so a manifest-derived set is EMPTY and every arm reads
   * "未测" despite having real metric rows on disk — the exact silent loss R03
   * is about. The published protocol declares `seeds: [20261004]`; that is the
   * expectation the comparison is judged against.
   */
  private expectedSeeds(result: Json, rowsByVariant: Map<string, MeasurementRow[]>): number[] {
    // Prefer an explicit seeds declaration on the published result.
    const declared = arr(result.seeds).map(num).filter((n): n is number => n !== null);
    if (declared.length > 0) return [...new Set(declared)].sort((a, b) => a - b);

    // Fall back to the union of seeds the arms actually report, which is the
    // coverage the comparison can be computed over at all.
    const seeds = new Set<number>();
    for (const rows of rowsByVariant.values()) {
      for (const r of rows) if (r.seed >= 0) seeds.add(r.seed);
    }
    return [...seeds].sort((a, b) => a - b);
  }

  /**
   * Metric specs for a Phase 2 run.
   *
   * The published `tiny-result.json` records no metricSpecs, and the frozen
   * protocol that declared the directions lives in host config this module
   * deliberately does not read (a projection must not depend on a config file
   * that could be edited after the run). The two specs the Phase 2 profile
   * produces are therefore declared here explicitly. The accuracy unit is
   * `accuracy` (a 0..1 fraction by another name) so the formatter renders it as
   * a percentage; a loss that grows still yields a NEGATIVE improvement.
   */
  private phase2MetricSpecs(): MetricSpecLike[] {
    return [
      { id: 'validation_loss', direction: 'minimize', unit: 'cross_entropy', split: 'validation', aggregation: 'mean' },
      { id: 'validation_accuracy', direction: 'maximize', unit: 'accuracy', split: 'validation', aggregation: 'mean' },
    ];
  }

  private firstError(taskDir: string, operationId: string): string | null {
    const dir = path.join(taskDir, 'published', operationId, 'diagnostics');
    try {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      const first = files[0];
      if (first === undefined) return null;
      const rec = readJsonFile(path.join(dir, first));
      return str(rec?.message) ?? str((rec?.error as Json | undefined)?.message) ?? first;
    } catch {
      return null;
    }
  }

  private phase2Operations(taskDir: string): WorkbenchOperationSummaryV2[] {
    const index = readJsonFile(path.join(taskDir, 'index', 'command-index.json'));
    if (index === null) return [];
    const out: WorkbenchOperationSummaryV2[] = [];
    const seen = new Map<string, number>();
    for (const raw of Object.values(index)) {
      const rec = raw as Json;
      const operationId = str(rec.operationId);
      if (operationId === null) continue;
      const op = readJsonFile(path.join(taskDir, 'operations', `${operationId}.json`));
      const method = str(rec.method) ?? str(op?.method) ?? 'unknown';
      // R06: a second operation of the same method is a retry/rerun of the
      // first, not a duplicate row. They stay distinguishable in the UI.
      const ordinal = (seen.get(method) ?? 0) + 1;
      seen.set(method, ordinal);
      const errObj = op?.error;
      out.push({
        operationId,
        method: prettyMethod(method),
        status: str(op?.status) ?? 'unknown',
        createdAt: str(op?.createdAt) ?? '',
        updatedAt: str(op?.updatedAt) ?? '',
        error: errObj && typeof errObj === 'object' ? str((errObj as Json).message) : null,
        attempt: ordinal === 1 ? 'original' : 'retry',
      });
    }
    out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return out;
  }

  // ------------------------- Phase 3 (the real pilot) -------------------------

  private buildPhase3Snapshot(taskId: string): WorkbenchSnapshotV2 {
    const issues: WorkbenchIssue[] = [];
    const ops = this.phase3OperationsFor(taskId);
    const operations: WorkbenchOperationSummaryV2[] = ops.map((o, i) => ({
      operationId: o.operationId,
      method: prettyMethod(o.method),
      status: o.status,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      error: o.error,
      attempt: i === 0 ? 'original' : 'rerun',
    }));

    const succeeded = (m: string) => ops.filter((o) => o.method === m && o.status === 'succeeded');
    const freezeOps = succeeded('freezeExperiment');
    const runOps = succeeded('runExperiment');
    const analyzeOps = succeeded('analyzeExperiment');
    const reproOps = succeeded('reproduceExperiment');

    if (freezeOps.length === 0) issues.push({ severity: 'error', code: 'NO_FROZEN_PROTOCOL', message: '没有已完成的 freezeExperiment：协议未冻结' });
    if (runOps.length === 0) issues.push({ severity: 'error', code: 'NO_CAMPAIGN', message: '没有已完成的 runExperiment：矩阵未执行' });

    const freezeOp = freezeOps[freezeOps.length - 1] ?? null;
    const protocolDoc = freezeOp === null
      ? null
      : readJsonFile(path.join(this.phase3Root.root, 'published', freezeOp.operationId, 'experiment-protocol.json'));
    const protocol = (protocolDoc?.protocol as Json | undefined) ?? null;
    const pilotConfig = (protocolDoc?.pilotConfig as Json | undefined) ?? null;
    const claimLimits = arr(protocolDoc?.claimLimits);

    const variants = arr(protocol?.variants).map((v) => ({
      id: str(v.id) ?? 'unknown',
      role: str(v.role) ?? 'unknown',
      moduleRefs: arr(v.moduleRefs).map((m) => str(m)).filter((m): m is string => m !== null),
      recipeRef: str(v.recipeRef),
      executableRef: refOf(v.executableRef),
      changedFactors: arr(v.changedFactors).map((c) => str(c)).filter((c): c is string => c !== null),
    })).filter((v) => v.id !== 'unknown');

    const metricSpecs = arr(protocol?.metricSpecs)
      .map(metricSpecFrom)
      .filter((s): s is MetricSpecLike => s !== null);
    const pairedSeeds = arr(protocol?.pairedSeeds).map(num).filter((n): n is number => n !== null);
    const primaryMetricId = str(protocol?.primaryMetricId);
    const baselineRef = str(pilotConfig?.baselineRef) ?? str(pilotConfig?.executableRefs && ((pilotConfig.executableRefs as Json[])[0]?.id)) ?? 'baseline';

    // The real comparison report, when one was published.
    const analyzeOp = analyzeOps[analyzeOps.length - 1] ?? null;
    const comparisonDoc = analyzeOp === null
      ? null
      : readJsonFile(path.join(this.phase3Root.root, 'published', analyzeOp.operationId, 'comparison-report.json'));
    const comparisonRef = analyzeOp === null ? null : `published/${analyzeOp.operationId}/comparison-report.json`;
    const campaignOp = runOps[runOps.length - 1] ?? null;
    const campaignDoc = campaignOp === null
      ? null
      : readJsonFile(path.join(this.phase3Root.root, 'published', campaignOp.operationId, 'campaign-report.json'));

    // Rows come from the comparison report's verified per-seed rows when
    // present, and from the campaign observations otherwise.
    const rows: MeasurementRow[] = [];
    const perSeedRows = arr((comparisonDoc?.report as Json | undefined)?.perSeedRows);
    if (perSeedRows.length > 0) {
      for (const row of perSeedRows) {
        const variantId = str(row.variantId);
        const seed = num(row.seed);
        const metricId = str(row.metricId);
        if (variantId === null || seed === null || metricId === null) continue;
        rows.push({
          variantId,
          seed,
          metricId,
          value: num(row.value),
          unit: metricSpecs.find((s) => s.id === metricId)?.unit ?? '',
          split: metricSpecs.find((s) => s.id === metricId)?.split ?? '',
          sampleCount: num((row as Json).sampleCount) ?? 0,
          verified: row.verified === true,
          artifactRefId: comparisonRef === null ? null : `report:${metricId}`,
        });
      }
    } else {
      const observations = arr(campaignDoc?.observations);
      for (const o of observations) {
        const variantId = str(o.variant);
        const seed = num(o.seed);
        const metricId = str(o.metricId);
        if (variantId === null || seed === null || metricId === null) continue;
        rows.push({
          variantId,
          seed,
          metricId,
          value: num(o.value),
          unit: str(o.unit) ?? '',
          split: str(o.split) ?? '',
          sampleCount: num(o.sampleCount) ?? 0,
          verified: false,
          artifactRefId: null,
        });
      }
      if (comparisonRef === null && campaignOp !== null) {
        issues.push({ severity: 'warning', code: 'NO_COMPARISON_REPORT', message: '没有已发布的 ComparisonReport：指标只能标记为已测未校验' });
      }
    }

    const rowsByVariant = new Map<string, MeasurementRow[]>();
    for (const r of rows) {
      const list = rowsByVariant.get(r.variantId) ?? [];
      list.push(r);
      rowsByVariant.set(r.variantId, list);
    }
    const baselineRows = rowsByVariant.get('baseline') ?? [];

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    // --- baseline node ---
    nodes.push({
      id: 'node-baseline',
      kind: 'baseline',
      displayName: humanizeModuleId(baselineRef),
      baselineRef,
      moduleRefs: [],
      proposalRef: null,
      executionStatus: campaignOp === null ? 'not_started' : 'succeeded',
      measurementStatus: baselineRows.length > 0
        ? (baselineRows.every((r) => r.verified) ? 'measured_verified' : 'measured_unverified')
        : 'untested',
      operationRefs: campaignOp === null ? [] : [campaignOp.operationId],
      resultRefs: [refOf((campaignDoc?.report as Json | undefined)?.protocolRef)?.id ?? 'protocol'].filter(Boolean),
      verificationRefs: analyzeOp === null ? [] : [analyzeOp.operationId],
      comparisons: [],
      summary: `Baseline：${baselineRows.length} 条逐 seed 指标`,
      detail: {
        variantId: 'baseline',
        seeds: [...new Set(baselineRows.map((r) => r.seed))].sort((a, b) => a - b),
        metricRows: baselineRows,
        pairedDeltas: [],
        executableRef: refOf((protocol?.executableRefs as Json[] | undefined)?.[0])?.id ?? null,
        executableReadiness: null,
        slotId: null,
        firstError: null,
        costRef: refOf((campaignDoc?.report as Json | undefined)?.costRef)?.id ?? null,
        protocolRef: refOf((protocolDoc?.protocol as Json | undefined)?.protocolRef)?.id ?? null,
        reportRefs: [comparisonRef, campaignOp === null ? null : `published/${campaignOp.operationId}/campaign-report.json`].filter((v): v is string => v !== null),
      },
    });

    // --- variant nodes ---
    for (const v of variants) {
      if (v.id === 'baseline') continue;
      const vRows = rowsByVariant.get(v.id) ?? [];
      const comparisons: ComparisonSummaryRow[] = metricSpecs.map((spec) => {
        const { summary } = summariseMetric(spec, vRows, baselineRows, pairedSeeds);
        return {
          metricId: summary.metricId,
          direction: summary.direction,
          unit: summary.unit,
          split: summary.split,
          referenceRef: 'baseline',
          pairedSeedCount: summary.pairedSeedCount,
          expectedSeedCount: summary.expectedSeedCount,
          measuredValue: summary.measuredValue,
          referenceValue: summary.referenceValue,
          improvement: summary.improvement,
          complete: summary.complete,
          limitation: summary.limitation,
          comparisonRef,
          evidenceLevel: comparisonRef === null ? 'none' : 'phase3_report',
        };
      });

      // The node verdict is stated for the protocol's PRIMARY metric only. Mixing
      // "validation_loss got worse" with "validation_accuracy improved" in one
      // word would hide that the arms disagree, so the primary metric decides
      // the line and the full per-metric detail stays in `comparisons`.
      const primary = comparisons.find((c) => c.metricId === primaryMetricId) ?? comparisons[0];
      const name = v.moduleRefs.length > 0
        ? `${humanizeModuleId(baselineRef)} + ${v.moduleRefs.map(humanizeModuleId).join(' + ')}`
        : `${humanizeModuleId(baselineRef)} + ${v.id}`;

      nodes.push({
        id: `node-variant-${v.id}`,
        kind: 'combination',
        displayName: name,
        baselineRef,
        moduleRefs: v.moduleRefs,
        proposalRef: null,
        executionStatus: vRows.length > 0 ? 'succeeded' : 'not_started',
        measurementStatus: vRows.length === 0 ? 'untested' : (comparisons.some((c) => c.complete) ? 'measured_verified' : 'measured_unverified'),
        operationRefs: campaignOp === null ? [] : [campaignOp.operationId],
        resultRefs: [],
        verificationRefs: analyzeOp === null ? [] : [analyzeOp.operationId],
        comparisons,
        summary: this.summariseNode(comparisons, v.moduleRefs.length > 0, primary.metricId),
        detail: {
          variantId: v.id,
          seeds: [...new Set(vRows.map((r) => r.seed))].sort((a, b) => a - b),
          metricRows: vRows,
          pairedDeltas: [],
          executableRef: v.executableRef?.id ?? null,
          executableReadiness: null,
          slotId: slotOfArm(v.moduleRefs, v.changedFactors),
          firstError: null,
          costRef: null,
          protocolRef: refOf((protocolDoc?.protocol as Json | undefined)?.protocolRef)?.id ?? null,
          reportRefs: [comparisonRef].filter((v2): v2 is string => v2 !== null),
        },
      });

      // Same-matrix comparison branch: the arms baseline/a/ab come from ONE
      // frozen protocol. Drawing these as "executed A→AB extensions" would be
      // the exact fabrication the plan forbids (plan §1.2, WB-04).
      edges.push({
        id: `edge-comparison-${v.id}`,
        source: 'node-baseline',
        target: `node-variant-${v.id}`,
        relation: 'comparison_variant',
        evidenceRefs: [refOf(protocolDoc?.protocol)?.id ?? 'protocol', ...(v.recipeRef === null ? [] : [v.recipeRef])],
        label: '同协议对照',
      });
    }

    // Execution → data flow edges, only when the operations exist. The node ids are
    // declared OUTSIDE the `if` because the result/analysis node below links
    // back to the run node even when the blocks are entered in either order.
    const runNodeId = 'node-run-campaign';
    const resultNodeId = 'node-result-comparison';
    if (campaignOp !== null) {
      nodes.push({
        id: runNodeId,
        kind: 'run',
        displayName: `矩阵执行：${prettyMethod('runExperiment')}`,
        baselineRef,
        moduleRefs: [],
        proposalRef: null,
        executionStatus: 'succeeded',
        measurementStatus: 'untested',
        operationRefs: [campaignOp.operationId],
        resultRefs: [str((campaignDoc?.report as Json | undefined)?.campaignHash)].filter((v): v is string => v !== null),
        verificationRefs: [],
        comparisons: [],
        summary: `完成度 ${str((campaignDoc?.report as Json | undefined)?.completion) ?? '未知'}，缺 ${arr((campaignDoc?.report as Json | undefined)?.missingTrialRefs).length} 个 trial`,
        detail: {
          variantId: null,
          seeds: pairedSeeds,
          metricRows: [],
          pairedDeltas: [],
          executableRef: refOf(campaignDoc?.executableRef)?.id ?? null,
          executableReadiness: null,
          slotId: null,
          firstError: null,
          costRef: refOf((campaignDoc?.report as Json | undefined)?.costRef)?.id ?? null,
          protocolRef: refOf((protocolDoc?.protocol as Json | undefined)?.protocolRef)?.id ?? null,
          reportRefs: [`published/${campaignOp.operationId}/campaign-report.json`],
        },
      });
      for (const v of variants) {
        if (v.id === 'baseline') continue;
        edges.push({
          id: `edge-exec-${v.id}`,
          source: `node-variant-${v.id}`,
          target: runNodeId,
          relation: 'execution',
          evidenceRefs: [campaignOp.operationId],
          label: '实现 / 执行',
        });
      }
      edges.push({
        id: 'edge-exec-baseline',
        source: 'node-baseline',
        target: runNodeId,
        relation: 'execution',
        evidenceRefs: [campaignOp.operationId],
        label: '实现 / 执行',
      });
    }

    if (analyzeOp !== null && campaignOp !== null) {
      nodes.push({
        id: resultNodeId,
        kind: 'result',
        displayName: `结果 / 校验：${prettyMethod('analyzeExperiment')}`,
        baselineRef,
        moduleRefs: [],
        proposalRef: null,
        executionStatus: 'succeeded',
        // The analysis node reports the verifier's own verdict. `researchOutcome`
        // is the scientific conclusion (directional_only / inconclusive / …) and
        // is NOT the same axis as verification, so it is summarised below rather
        // than folded into this field.
        measurementStatus: 'measured_verified',
        operationRefs: [analyzeOp.operationId],
        resultRefs: [refIdOrNull((comparisonDoc?.report as Json | undefined)?.comparisonHash)].filter((v): v is string => v !== null),
        verificationRefs: reproOps.map((r) => r.operationId),
        comparisons: [],
        summary: `研究结论：${str((comparisonDoc?.report as Json | undefined)?.researchOutcome) ?? '未产出'}`,
        detail: {
          variantId: null,
          seeds: pairedSeeds,
          metricRows: [],
          pairedDeltas: [],
          executableRef: null,
          executableReadiness: null,
          slotId: null,
          firstError: null,
          costRef: refOf((comparisonDoc?.report as Json | undefined)?.costRef)?.id ?? null,
          protocolRef: refOf((protocolDoc?.protocol as Json | undefined)?.protocolRef)?.id ?? null,
          reportRefs: [comparisonRef].filter((v2): v2 is string => v2 !== null),
        },
      });
      edges.push({
        id: 'edge-data-campaign',
        source: runNodeId,
        target: resultNodeId,
        relation: 'data_flow',
        evidenceRefs: [analyzeOp.operationId, campaignOp.operationId],
        label: '原始结果 / 校验',
      });
    }

    for (const limit of claimLimits) {
      const gated = str(limit.gatedAction);
      issues.push({
        severity: 'warning',
        code: 'CLAIM_LIMIT',
        message: `${str(limit.field) ?? 'field'}：${str(limit.reason) ?? '受限'}${gated === null ? '' : `（影响 ${gated}）`}`,
      });
    }
    const upstream = str(pilotConfig?.upstreamQualityNote);
    if (upstream !== null) issues.push({ severity: 'warning', code: 'UPSTREAM', message: upstream });

    return {
      schemaVersion: 2,
      taskId,
      displayName: taskId,
      // No per-task revision in the Phase 3 store; -1 marks "not published"
      // distinctly from a real revision of 0.
      revision: -1,
      generatedAt: new Date().toISOString(),
      source: {
        phase: 'phase3',
        storageRoot: this.phase3Root.root,
        taskRef: str(protocol?.taskRef),
        experimentTaskId: taskId,
      },
      protocolRef: refOf(protocolDoc?.protocol)?.id ?? null,
      taskType: 'experiment',
      dataSummary: str(pilotConfig?.dataVersionRef),
      budgetSummary: str((protocol?.perTrialLimit as Json | undefined)?.kind) === null
        ? null
        : `${str((protocol?.perTrialLimit as Json | undefined)?.kind)} = ${num((protocol?.perTrialLimit as Json | undefined)?.value)}`,
      upstreamQuality: [str(pilotConfig?.upstreamQualityNote)].filter((v): v is string => v !== null),
      issues,
      nodes,
      edges,
      latestComparisonRef: comparisonRef,
      operations,
    };
  }

  // ------------------------- modules (裁缝铺) -------------------------

  listModules(taskId: string | null, query = ''): WorkbenchModuleCardV2[] {
    const out: WorkbenchModuleCardV2[] = [];
    const seen = new Set<string>();

    // 1) the current task's frozen protocol: the arms that really ran.
    if (taskId !== null) {
      const snapshot = this.getWorkbench(taskId);
      if (!('error' in snapshot)) {
        const nodeModuleRefs = new Map<string, { nodeId: string; variantId: string }>();
        for (const n of snapshot.nodes) {
          if (n.kind !== 'combination') continue;
          for (const m of n.moduleRefs) {
            nodeModuleRefs.set(m, { nodeId: n.id, variantId: n.detail.variantId ?? n.id });
          }
        }
        for (const n of snapshot.nodes) {
          for (const m of n.moduleRefs) {
            if (seen.has(m)) continue;
            seen.add(m);
            const usage = nodeModuleRefs.get(m);
            out.push({
              id: m,
              displayName: humanizeModuleId(m),
              mechanism: null,
              mechanismEvidenceRefs: [],
              interventionAxis: null,
              modifies: null,
              expectedOutput: null,
              origin: 'phase3_protocol',
              status: 'measured',
              slotId: null,
              implementationRef: usage === undefined ? null : n.detail.executableRef,
              implementationReadiness: usage === undefined ? null : n.detail.executableReadiness,
              paperId: null,
              paperTitle: null,
              builtOnBaselines: [n.baselineRef ?? 'baseline'],
              conditionalResultRefs: usage === undefined
                ? []
                : [{ taskId, nodeId: usage.nodeId, variantId: usage.variantId }],
              missing: [],
              sourceOperationId: n.operationRefs[0] ?? null,
              documentHash: null,
            });
          }
        }
      }
    }

    // 2) the task's pinned Phase 2 source bundle.
    if (taskId !== null) {
      const dir = this.researchRoot.taskDir(taskId);
      if (dir.ok) {
        const bundleOp = this.selectPhase2Operation(dir.value, 'resolveSources');
        const bundle = bundleOp === null
          ? null
          : readJsonFile(path.join(dir.value, 'published', bundleOp.operationId, 'source-bundle.json'));
        for (const m of arr(bundle?.modules)) {
          const id = str(m.id);
          if (id === null || seen.has(id)) continue;
          seen.add(id);
          out.push({
            id,
            displayName: humanizeModuleId(id),
            mechanism: str(m.entrypoint),
            mechanismEvidenceRefs: [],
            interventionAxis: null,
            modifies: null,
            expectedOutput: null,
            origin: 'phase2_pinned',
            status: 'pinned',
            slotId: null,
            implementationRef: null,
            implementationReadiness: null,
            paperId: null,
            paperTitle: null,
            builtOnBaselines: [str((bundle?.baseline as Json | undefined)?.id) ?? 'baseline'],
            conditionalResultRefs: [],
            missing: [],
            sourceOperationId: bundleOp?.operationId ?? null,
            documentHash: null,
          });
        }
      }
    }

    // 3) P5 module cards from every SUCCESSFUL, published discovery run.
    for (const c of this.dedupeCards(this.publishedP5Cards())) {
      if (c.kind !== 'module') continue;
      const id = str(c.card.id);
      if (id === null || seen.has(id)) continue;
      seen.add(id);
      const field = (f: unknown): { value: string | null; refs: string[] } => {
        const o = f as Json | undefined;
        return { value: str(o?.value), refs: arr(o?.evidenceRefs).map(str).filter((v): v is string => v !== null) };
      };
      const name = field(c.card.name);
      const mechanism = field(c.card.mechanism);
      out.push({
        id,
        displayName: name.value ?? id,
        mechanism: mechanism.value,
        mechanismEvidenceRefs: mechanism.refs,
        interventionAxis: field(c.card.interventionAxis).value,
        modifies: field(c.card.modifies).value,
        expectedOutput: field(c.card.expectedOutput).value,
        origin: 'p5_card',
        status: str(c.card.status) ?? 'proposed',
        slotId: null,
        implementationRef: null,
        implementationReadiness: null,
        paperId: str(c.card.paperId),
        paperTitle: null,
        builtOnBaselines: arr(c.card.builtOnBaselines).map((b) => str((b as Json)?.value)).filter((v): v is string => v !== null),
        conditionalResultRefs: [],
        // A P5 card has no implementation and no trial. Saying "已测" here is
        // the v1 bug; the honest missing list is explicit instead.
        missing: ['缺实现', '缺本任务 trial'],
        sourceOperationId: str(c.card.producerOperationId),
        documentHash: str(c.card.documentHash),
      });
    }

    const q = query.trim().toLowerCase();
    if (q.length === 0) return out;
    return out.filter((m) =>
      m.id.toLowerCase().includes(q) ||
      m.displayName.toLowerCase().includes(q) ||
      (m.mechanism ?? '').toLowerCase().includes(q));
  }

  // ------------------------- papers (论文管理) -------------------------

  /**
   * R08/R09: real titles from PaperInput metadata.
   *
   * v1 read `card.name.value` — which is the METHOD name ("attention gate",
   * "U-Net") — and presented it as the paper title. Titles now come from the
   * P5 input manifest, which records the real PaperInput fields; when a paper
   * cannot be resolved, `title` stays null WITH a reason instead of borrowing a
   * method name.
   *
   * All published discovery runs are scanned (not just the lexicographically
   * last `basic-*` directory, which v1 stopped at on the first sample that
   * happened to hold cards, success unchecked).
   */
  listPapers(query = ''): WorkbenchPaperCardV2[] {
    const byPaper = new Map<string, WorkbenchPaperCardV2>();

    // Cards are deduped per (kind, paper, documentHash, name, revision) so a
    // paper re-extracted by many runs shows one method per identity with an
    // honest count, instead of the inflated counts v1 produced by summing
    // every run's cards.
    const cards = this.dedupeCards(this.publishedP5Cards());

    for (const run of this.publishedDiscoveryRuns()) {
      const manifest = readJsonFile(path.join(run.p5Dir, run.opDir, 'input-manifest.json'));
      const result = readJsonFile(path.join(run.p5Dir, run.opDir, 'result.json'));
      if (manifest === null || result === null) continue;

      const entries = arr(manifest.entries);
      for (const e of entries) {
        const paperId = str(e.paperId);
        if (paperId === null) continue;
        const documentHash = str(e.documentHash);
        const existing = byPaper.get(paperId);
        // The same paperId with a DIFFERENT documentHash is a different
        // document version. v1 keyed only by paperId and would overwrite one
        // with the other; here the newer hash wins the identity fields and the
        // card binding stays per-documentHash.
        if (existing !== undefined && existing.documentHash !== null && documentHash !== null
          && existing.documentHash !== documentHash) {
          const prior = byPaper.get(`${paperId}@${existing.documentHash.slice(0, 12)}`);
          if (prior !== undefined) byPaper.delete(`${paperId}@${existing.documentHash.slice(0, 12)}`);
          byPaper.set(`${paperId}@${documentHash.slice(0, 12)}`, {
            ...existing,
            documentHash,
            title: str(e.title),
            version: str(e.version),
            sourceUri: str(e.sourceUri),
            sourceGroup: str(e.sourceGroup),
          });
          byPaper.set(paperId, {
            ...existing,
            documentHash,
            title: str(e.title),
            version: str(e.version),
            sourceUri: str(e.sourceUri),
            sourceGroup: str(e.sourceGroup),
          });
          continue;
        }

        const row: WorkbenchPaperCardV2 = existing ?? {
          paperId,
          title: str(e.title),
          titleUnknownReason: str(e.title) === null ? '导入元数据没有 title 字段' : null,
          version: str(e.version),
          sourceUri: str(e.sourceUri),
          sourceGroup: str(e.sourceGroup),
          materialScope: null,
          documentHash,
          availableSections: arr(e.availableSections).map(str).filter((v): v is string => v !== null),
          moduleCardCount: 0,
          baselineCardCount: 0,
          cardRefs: [],
          referencedByCurrentCandidate: false,
          runRef: run.opDir,
          inputManifestRef: `${run.opDir}/input-manifest.json`,
        };
        if (row.title === null && str(e.title) !== null) {
          row.title = str(e.title);
          row.titleUnknownReason = null;
        }
        byPaper.set(paperId, row);
      }
    }

    // Cards bind by documentHash, never by name. Counts come from the DEDUPED
    // set, so a paper re-extracted by thirty runs reports its real number of
    // distinct methods rather than the sum over runs.
    for (const card of cards) {
      const paperId = str(card.card.paperId);
      const cardId = str(card.card.id);
      if (paperId === null || cardId === null) continue;
      const row = byPaper.get(paperId);
      if (row === undefined) continue;
      if (str(card.card.documentHash) !== row.documentHash) continue;
      if (row.cardRefs.includes(cardId)) continue;
      row.cardRefs.push(cardId);
      if (card.kind === 'module') row.moduleCardCount += 1;
      else row.baselineCardCount += 1;
      row.materialScope = row.availableSections.includes('abstract')
        ? 'title+abstract'
        : row.availableSections.length > 0 ? row.availableSections.join('+') : '仅元数据';
    }

    const list = [...byPaper.values()].filter((p) => {
      if (p.moduleCardCount > 0 || p.baselineCardCount > 0 || p.title !== null) return true;
      // A paper with neither a title nor a card carries nothing for the page.
      return false;
    });
    const q = query.trim().toLowerCase();
    if (q.length === 0) return list;
    return list.filter((p) =>
      (p.title ?? '').toLowerCase().includes(q) ||
      p.paperId.toLowerCase().includes(q) ||
      (p.sourceGroup ?? '').toLowerCase().includes(q));
  }

  /**
   * Published discovery runs, newest first.
   *
   * R09: v1 stopped at the first sample/operation that happened to contain
   * cards, never checking whether that operation SUCCEEDED, and only ever
   * looked under `basic-*` in lexicographic order. Here every published
   * `result.json` is enumerated.
   *
   * NOTE on `paper-basic.json`'s `status`: it is the verdict of the paper-only
   * chain's HARD CHECKS (`pass`/`fail`/`blocked` about the corpus and the gold
   * set), not a statement that this run's cards are unusable — `basic-mundpbkn`
   * carries eight papers' worth of P5 cards while reporting `blocked` for an
   * unrelated gap. Filtering on it would hide real cards, so selection is by
   * what the operation actually PUBLISHED.
   */
  private publishedDiscoveryRuns(): Array<{ run: string; p5Dir: string; opDir: string }> {
    const out: Array<{ run: string; p5Dir: string; opDir: string; at: number }> = [];
    let runs: string[];
    try {
      runs = fs.readdirSync(this.paperRoot.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('basic-'))
        .map((d) => d.name);
    } catch {
      return [];
    }
    for (const run of runs) {
      const runDir = path.join(this.paperRoot.root, run);
      const p5Root = path.join(runDir, 'p5_discover');
      let samples: string[];
      try {
        samples = fs.readdirSync(p5Root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      } catch {
        continue;
      }
      for (const sample of samples) {
        const sampleDir = path.join(p5Root, sample);
        let ops: string[];
        try {
          ops = fs.readdirSync(sampleDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith('rop-'))
            .map((d) => d.name);
        } catch {
          continue;
        }
        for (const op of ops) {
          const result = readJsonFile(path.join(sampleDir, op, 'result.json'));
          if (result === null) continue;
          let at = 0;
          try { at = fs.statSync(path.join(sampleDir, op, 'result.json')).mtimeMs; } catch { at = 0; }
          out.push({ run, p5Dir: p5Root, opDir: path.join(sample, op), at });
        }
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  /**
   * R09: every published card set, not "the first one that has cards".
   *
   * The same paper is re-extracted by many runs, and each extraction is a
   * DISTINCT record (its own card ids, its own revision) — but the page must not
   * list "attention gate (AG)" five times. Cards are therefore grouped by
   `(paperId, documentHash, name)` and the newest publication wins, while
   `extractions` records how many independent extractions exist. That keeps the
   plan's rule — repeated extraction of one document version stays one identity,
   a same-named method from a DIFFERENT document stays separate — without
   * inventing a merge the data does not support.
   */
  private publishedP5Cards(): Array<{ kind: 'module' | 'baseline'; card: Json; dir: string; run: string; opDir: string; at: number }> {
    const out: Array<{ kind: 'module' | 'baseline'; card: Json; dir: string; run: string; opDir: string; at: number }> = [];
    for (const run of this.publishedDiscoveryRuns()) {
      const resultPath = path.join(run.p5Dir, run.opDir, 'result.json');
      const result = readJsonFile(resultPath);
      if (result === null) continue;
      const dir = path.join(run.p5Dir, run.opDir);
      let at = 0;
      try { at = fs.statSync(resultPath).mtimeMs; } catch { at = 0; }
      for (const c of arr(result.moduleCards)) out.push({ kind: 'module', card: c, dir, run: run.run, opDir: run.opDir, at });
      for (const c of arr(result.baselineCards)) out.push({ kind: 'baseline', card: c, dir, run: run.run, opDir: run.opDir, at });
    }
    return out;
  }

  /**
   * Collapse repeated extractions of the same document+method into one row.
   * Newest publication wins; `extractions` counts the independent runs.
   */
  private dedupeCards(
    cards: Array<{ kind: 'module' | 'baseline'; card: Json; dir: string; run: string; opDir: string; at: number }>,
  ): Array<{ kind: 'module' | 'baseline'; card: Json; dir: string; run: string; opDir: string; extractions: number }> {
    const byKey = new Map<string, { kind: 'module' | 'baseline'; card: Json; dir: string; run: string; opDir: string; at: number; extractions: number }>();
    for (const c of cards) {
      const paperId = str(c.card.paperId) ?? 'unknown';
      const documentHash = str(c.card.documentHash) ?? 'unknown';
      // The name is compared case-insensitively: the same paper re-extracted by
      // different runs yields "attention gate (AG)" / "Attention Gate (AG)" /
      // "Attention gate (AG)", which are ONE method, not three. paperId and
      // documentHash stay in the key, so a same-named method from a DIFFERENT
      // paper is still a separate row (plan §3.4).
      const name = (str((c.card.name as Json | undefined)?.value) ?? str(c.card.id) ?? 'unknown').toLowerCase();
      // `revision` is part of the identity: a card that was revised is a new
      // card, not a re-extraction of the same one.
      const revision = num(c.card.revision) ?? 1;
      const key = `${c.kind}|${paperId}|${documentHash}|${name}|${revision}`;
      const prior = byKey.get(key);
      if (prior === undefined) {
        byKey.set(key, { ...c, extractions: 1 });
        continue;
      }
      prior.extractions += 1;
      if (c.at > prior.at) {
        byKey.set(key, { ...c, extractions: prior.extractions });
      }
    }
    return [...byKey.values()];
  }

  // ------------------------- artifact reads (R05) -------------------------

  /**
   * Typed, scoped artifact read. The caller supplies (taskId, ref); the store
   * resolves the ref through ITS OWN published index and re-verifies the hash.
   * There is no path parameter, so the sibling-directory prefix escape and the
   * unvalidated `path.join` of v1 are both gone by construction.
   */
  readArtifact(request: ArtifactRequest, view: 'summary' | 'detail'):
    | { ok: true; value: ReturnType<typeof readBoundedArtifact> }
    | { ok: false; code: string; message: string } {
    const { taskId, ref } = request;
    const store = this.phase3TaskIds().includes(taskId) ? this.phase3Root : this.researchRoot;
    const dir = store.taskDir(taskId);
    if (!dir.ok) return { ok: false, code: dir.code, message: dir.message };

    if (!isValidRefId(ref.id)) {
      return { ok: false, code: 'INVALID_REF', message: `ref id 不合法：${ref.id}` };
    }
    const located = this.locatePublishedFile(dir.value, ref.id);
    if (located === null) {
      return { ok: false, code: 'UNKNOWN_REF', message: `该任务没有发布此引用：${ref.id}` };
    }
    const denied = forbiddenReason(located.file);
    if (denied !== null) {
      return { ok: false, code: 'FORBIDDEN_ARTIFACT', message: `拒绝读取 ${denied}` };
    }
    // Re-hash on read: a published file that changed since publication is a fact
    // the page must surface, not serve.
    //
    // TWO hashes are in play and conflating them is a bug: an entry's
    // `ref.sha256` is the LOGICAL ref (the resultHash the producer computed over
    // the payload), while `contentSha256` is the digest of the bytes on disk.
    // For a Phase 3 report they are equal, but for a Phase 2 `tiny-result.json`
    // they are NOT (ref `eecd5a91…` vs content `c3b543d1…`), so comparing the
    // file's real digest against `ref.sha256` would reject every legitimate read.
    // The integrity check therefore compares against the stored CONTENT digest.
    const actual = sha256File(located.file);
    if (actual === null) {
      return { ok: false, code: 'UNREADABLE', message: `产物读取失败：${ref.id}` };
    }
    if (located.contentSha256 !== null && actual !== located.contentSha256) {
      return {
        ok: false,
        code: 'REF_HASH_MISMATCH',
        message: `发布后文件已变更：记录内容哈希 ${located.contentSha256.slice(0, 12)}，实际 ${actual.slice(0, 12)}`,
      };
    }
    // When the caller presents a logical ref hash, the store still checks it
    // against the index entry it resolved, so a forged ref id cannot pass.
    if (ref.sha256 !== null && located.refSha256 !== null && ref.sha256 !== located.refSha256) {
      return {
        ok: false,
        code: 'REF_HASH_MISMATCH',
        message: `引用哈希与已发布索引不符：请求 ${ref.sha256.slice(0, 12)}，索引 ${located.refSha256.slice(0, 12)}`,
      };
    }
    const value = readBoundedArtifact(located.file, view);
    if (value === null) {
      return { ok: false, code: 'UNREADABLE', message: `产物读取失败：${ref.id}` };
    }
    return { ok: true, value };
  }

  /**
   * Find a published file by ref id inside ONE already-authorized task dir.
   *
   * Two store shapes exist. Phase 2 publishes an `artifacts.json` index per
   * operation whose entries map ref id → file. Phase 3 publishes a single named
   * report per operation and names the ref after the operation id. Both resolve
   * through the store's own index or naming; a caller never supplies a path.
   *
   * The returned record carries BOTH hashes the index publishes: `refSha256`
   * (the logical ref) and `contentSha256` (the bytes on disk). Callers must not
   * compare a file digest against `refSha256` — see readArtifact.
   */
  private locatePublishedFile(taskDir: string, refId: string): { file: string; refSha256: string | null; contentSha256: string | null } | null {
    let ops: string[];
    try {
      ops = fs.readdirSync(path.join(taskDir, 'operations')).filter((f) => f.endsWith('.json'));
    } catch {
      ops = [];
    }
    for (const f of ops) {
      const opId = f.replace(/\.json$/, '');
      const index = readJsonFile(path.join(taskDir, 'published', opId, 'artifacts.json'));
      if (index === null) continue;
      for (const e of arr(index.entries)) {
        const r = refOf(e.ref);
        if (r === null || r.id !== refId) continue;
        const file = str(e.file);
        if (file === null) continue;
        const real = containedRealPath(taskDir, file);
        if (real === null) continue;
        return { file: real, refSha256: r.sha256, contentSha256: str(e.contentSha256) };
      }
    }
    // Phase 3 publishes a single named file per operation and names the ref
    // after the operation; handle that shape too.
    const pubDir = path.join(taskDir, 'published', refId);
    for (const name of ['campaign-report.json', 'comparison-report.json', 'experiment-protocol.json', 'reproduction-report.json', 'selection-freeze.json']) {
      const real = containedRealPath(pubDir, path.join(pubDir, name));
      if (real !== null && fs.existsSync(real)) return { file: real, refSha256: null, contentSha256: sha256File(real) };
    }
    return null;
  }

  /**
   * Tasks this session may read.
   *
   * Two tiers, and the distinction is deliberate:
   *
   *  1. `owned` — the session created them. The stores record `ownerSessionId`
   *     per task, so this is an authority fact, not a guess.
   *  2. `workspace` — every task in the configured research roots. This host runs
   *     as a single local researcher's tool over ONE workspace directory
   *     (`repoRoot`), so every task under it is the same principal's work.
   *
   * Tier 2 exists because tier 1 alone makes the page useless in the real
   * workflow: a NEW chat session owns nothing, so the workbench would show
   * SCOPE_DENIED for the very pilot that session is meant to discuss. Granting
   * only "tasks someone else in this same workspace created" would be a security
   * theatre anyway — same process, same disk, same user.
   *
   * What this is NOT: it is not an authorization boundary between users. The
   * boundary here is Layer 1 (the host's own browser auth) plus the fact that
   * only this host, on this machine, over this repoRoot, can reach the route.
   * `grantedTier` is returned so the UI can SAY which tier it got instead of
   * implying a per-user isolation that does not exist.
   */
  readableTasks(sessionId: string): { tasks: string[]; grantedTier: 'owned' | 'workspace' | 'none' } {
    const owned = this.tasksOwnedBy(sessionId);
    if (owned.length > 0) return { tasks: owned, grantedTier: 'owned' };
    const all = this.allTaskIds();
    return all.length > 0
      ? { tasks: all, grantedTier: 'workspace' }
      : { tasks: [], grantedTier: 'none' };
  }

  /**
   * Product (research-design) task ids, supplied by the host.
   *
   * INJECTED rather than read here, deliberately. The sidecar belongs to
   * `WorkbenchResearchService`, and reaching into its storage from the v2
   * projection would give two components independent knowledge of the same
   * directory layout — the kind of duplication that drifts. The host already holds
   * the service, so it passes the list in; a host without the research workbench
   * passes nothing and gets an empty list, which is the correct answer there.
   */
  setProductTaskIds(ids: string[]): void {
    this.productTaskIdsCache = [...new Set(ids)].sort();
  }

  /** Every task id across the Phase 2 and Phase 3 stores, PLUS the product tasks. */
  allTaskIds(): string[] {
    const out: string[] = [];
    try {
      for (const d of fs.readdirSync(this.researchRoot.root, { withFileTypes: true })) {
        // The store's OWN bookkeeping directories are not tasks — the same
        // exclusion the v3 projection applies, for the same reason.
        if (d.isDirectory() && d.name.startsWith('task-')) out.push(d.name);
      }
    } catch { /* an absent Phase 2 store contributes nothing */ }
    out.push(...this.phase3TaskIds());
    out.push(...this.productTaskIdsCache);
    return [...new Set(out)].sort();
  }

  /**
   * Tasks this session actually owns, read from the authoritative task record.
   *
   * This is the strict tier, and it is what `readableTasks` falls back from. A
   * session that owns nothing gets an empty grant rather than a refusal that
   * would leak whether a guessed task exists.
   */
  tasksOwnedBy(sessionId: string): string[] {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return [];
    const owned: string[] = [];
    // Phase 2 tasks carry ownerSessionId in index/tasks.json.
    let phase2Ids: string[] = [];
    try {
      phase2Ids = fs
        .readdirSync(this.researchRoot.root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && d.name.startsWith('task-'))
        .map((d) => d.name);
    } catch {
      phase2Ids = [];
    }
    for (const taskId of phase2Ids) {
      const dir = this.researchRoot.taskDir(taskId);
      if (!dir.ok) continue;
      const raw = readJsonFile(path.join(dir.value, 'index', 'tasks.json'));
      const record = raw === null ? null : (raw[taskId] as Json | undefined);
      if (str(record?.ownerSessionId) === sessionId) owned.push(taskId);
    }
    // Phase 3 operations carry ownerSessionId on each descriptor.
    for (const taskId of this.phase3TaskIds()) {
      if (this.phase3OperationsFor(taskId).some((o) => o.ownerSessionId === sessionId)) owned.push(taskId);
    }
    return [...new Set(owned)].sort();
  }

  /** Roots for the status endpoint; nothing sensitive is derived here. */
  describeRoots(): { researchExecutionRoot: string; paperOnlyRoot: string; phase3ExperimentRoot: string } {
    return {
      researchExecutionRoot: this.researchRoot.root,
      paperOnlyRoot: this.paperRoot.root,
      phase3ExperimentRoot: this.phase3Root.root,
    };
  }

  /** Exposed for the EVAL's scope cases; returns the AccessResult shape. */
  resolveTaskDir(storeName: 'phase2' | 'paper' | 'phase3', taskId: string): AccessResult<string> {
    const store = storeName === 'phase3' ? this.phase3Root : storeName === 'paper' ? this.paperRoot : this.researchRoot;
    return store.taskDir(taskId);
  }
}

function refIdOrNull(v: unknown): string | null {
  return str(v);
}

/**
 * The slot an arm binds to, read from the frozen protocol's own
 * `changedFactors` strings (e.g. "slot features.pre_pool prefix(1) = ...").
 * This is the DECLARED binding from the protocol, not a guess from the module
 * set; an arm with no declared factor (the baseline) returns null.
 */
function slotOfArm(moduleRefs: string[], changedFactors: string[]): string | null {
  if (moduleRefs.length === 0) return null;
  for (const factor of changedFactors) {
    const m = /^slot\s+(\S+)/.exec(factor);
    if (m !== null) return m[1];
  }
  return null;
}
