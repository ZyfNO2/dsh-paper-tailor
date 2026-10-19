/**
 * Batch 1 takeover tools: the Agent-facing surface of the read-only takeover.
 *
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-01-WORKER-PLAN-2026-10-16.md §2.1, §2.2, §5.
 *
 * Ownership rule enforced here: the workspace root ALWAYS comes from the caller's session
 * registration, never from arguments. Roots are workspace-relative only; '.' means the whole
 * workspace and is explicitly allowed by the frozen contract.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { BootstrapError } from '../../contracts/research-bootstrap.ts';
import { isSafeRelativePath, type TakeoverSnapshot, type TakeoverScan } from '../../contracts/research-takeover.ts';
import { ResearchBootstrapStore } from '../../application/research-bootstrap-store.ts';
import { TakeoverService, type TakeoverServiceOptions } from '../../application/takeover-service.ts';
import { TakeoverAdoptionService, type TakeoverAdoptionRequestItem, type TakeoverAdoptionRequestRelation } from '../../application/takeover-adoption.ts';
import { ExternalResultService, type ExternalConditionInput, type ExternalValueInput, type TrustedUserMessage } from '../../application/external-result-service.ts';
import type { ExternalResultAction } from '../../contracts/external-result.ts';

export const RESEARCH_TAKEOVER_TOOL_NAMES = Object.freeze([
  'evolver_start_research_takeover',
  'evolver_refresh_research_takeover',
  'evolver_read_research_takeover',
  'evolver_save_research_takeover_snapshot',
  'evolver_bind_research_takeover',
  'evolver_check_takeover_freshness',
  'evolver_adopt_research_takeover',
  'evolver_register_external_result',
  'evolver_review_external_results',
  'evolver_decide_external_result',
]);

/** A request must never carry owner, actor or host paths — those come from the session. */
const BOOTSTRAP_FORBIDDEN_PAYLOAD_FIELDS: readonly string[] = Object.freeze([
  'actor', 'owner', 'ownerSessionId', 'sessionId', 'agentId', 'userId', 'caller', 'workspaceRoot', 'workspace', 'root', 'cwd', 'path',
]);

function assertNoForbiddenFields(payload: unknown, context: string): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  for (const field of BOOTSTRAP_FORBIDDEN_PAYLOAD_FIELDS) {
    if (field in (payload as Record<string, unknown>)) {
      throw new BootstrapError('INVALID_INPUT', `${context}: "${field}" is owned by the host and must never be sent by the caller`);
    }
  }
}

function normalizeRoots(roots: unknown): string[] {
  if (roots === undefined || roots === null) return ['.'];
  if (!Array.isArray(roots)) throw new BootstrapError('INVALID_INPUT', 'roots must be an array of workspace-relative paths');
  const normalized = roots.map((root) => String(root).replace(/\\/g, '/').replace(/\/+$/, '') || '.');
  for (const root of normalized) {
    if (root !== '.' && !isSafeRelativePath(root)) {
      throw new BootstrapError('INVALID_INPUT', `roots: "${root}" is not a workspace-relative path (absolute paths and ".." are refused)`);
    }
  }
  return [...new Set(normalized)];
}

function requireString(value: unknown, field: string, context: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BootstrapError('INVALID_INPUT', `${context}: ${field} is required`);
  }
  return value;
}

function requireRevision(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new BootstrapError('INVALID_INPUT', `${context}: baseRevision must be a non-negative integer (0 when the state does not exist yet)`);
  }
  return value as number;
}

export function applyResearchTakeoverTools(ctx: Context, resolve: (sessionId: string) => ResearchBootstrapStore, options: TakeoverServiceOptions = {}): void {
  const scope = (exec: ToolRunContext): { store: ResearchBootstrapStore; service: TakeoverService; sessionId: string } => {
    const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
    const sessionId = agent?.id ?? agent?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new BootstrapError('OWNER_MISMATCH', 'the calling session is not registered to a DSH workspace; research bootstrap state cannot be located');
    }
    const store = resolve(sessionId);
    return { store, service: new TakeoverService(store, options), sessionId };
  };

  const output = { schema: { type: 'object' as const, additionalProperties: true }, render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };

  ctx.tools.register(defineTool({
    name: 'evolver_start_research_takeover',
    description:
      '接管一个已有的本地研究目录：只读盘点文件（论文/笔记/Wiki/代码/配置/指标/日志/权重），登记数量、相对路径、类型、大小、来源身份与读取/未读/失败/跳过原因。' +
      '永不修改、移动或执行原始目录中的任何文件；权重只登记元数据（不反序列化、不加载）。' +
      'roots 缺省 ["."]（整个工作区）；只有用户明确指定子目录时才传该子目录；只接受工作区相对路径，绝不接受绝对路径。' +
      '返回 takeoverId / scanId / counts / truncated / firstError 与 revision（下一次 baseRevision 必须用它）。' +
      'baseRevision 是 bootstrap 状态的 revision：已有研究时先调用 evolver_get_research_bootstrap，用它返回的 revision；只有状态还不存在时才传 0。冲突时用错误里的 revision 和同一个 operationId 重试。' +
      '同一批 roots 重复调用返回 reused=true，不会重复登记。',
    parameters: {
      operationId: { type: 'string', required: true },
      baseRevision: { type: 'number', required: true },
      roots: { type: 'array', items: { type: 'string' } },
      scopeNote: { type: 'string' },
      title: { type: 'string' },
      researchId: { type: 'string' },
    },
    output,
    execute: async (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'start_research_takeover');
      const input = args as { operationId: string; baseRevision: number; roots?: string[]; scopeNote?: string; title?: string; researchId?: string | null };
      const { service, sessionId } = scope(exec);
      const result = await service.start(
        {
          operationId: requireString(input.operationId, 'operationId', 'start_research_takeover'),
          baseRevision: requireRevision(input.baseRevision, 'start_research_takeover'),
          roots: normalizeRoots(input.roots),
          ...(input.scopeNote === undefined ? {} : { scopeNote: input.scopeNote }),
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.researchId === undefined ? {} : { researchId: input.researchId }),
        },
        `agent:${sessionId}`,
      );
      return { ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_refresh_research_takeover',
    description: '对既有接管重新只读盘点：追加一次新 scan 并设为当前 scan，保留历史 scan。原文件变更后用它更新，或先查 freshness。',
    parameters: { operationId: { type: 'string', required: true }, baseRevision: { type: 'number', required: true }, takeoverId: { type: 'string', required: true } },
    output,
    execute: async (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'refresh_research_takeover');
      const input = args as { operationId: string; baseRevision: number; takeoverId: string };
      const { service, sessionId } = scope(exec);
      const result = await service.refresh(
        {
          operationId: requireString(input.operationId, 'operationId', 'refresh_research_takeover'),
          baseRevision: requireRevision(input.baseRevision, 'refresh_research_takeover'),
          takeoverId: requireString(input.takeoverId, 'takeoverId', 'refresh_research_takeover'),
        },
        `agent:${sessionId}`,
      );
      return { ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_read_research_takeover',
    description:
      '读取接管的盘点范围、counts、当前快照与过期判定。省略 takeoverId 时返回本工作区所有接管的摘要列表。' +
      '只读，不启动 Agent、不重新扫描。快照里的引用只能指向 readStatus="read" 的条目。',
    parameters: { takeoverId: { type: 'string' } },
    output,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'read_research_takeover');
      const input = args as { takeoverId?: string };
      const { service } = scope(exec);
      if (input.takeoverId === undefined || input.takeoverId === null || String(input.takeoverId).trim().length === 0) {
        return { takeovers: service.list().map((record) => ({ takeoverId: record.takeoverId, title: record.title, roots: record.roots, status: record.status, researchId: record.researchId, revision: record.snapshot.revision, updatedAt: record.updatedAt, firstError: record.firstError })) };
      }
      const projection = service.projection(String(input.takeoverId));
      if (projection.record === null) throw new BootstrapError('NOT_FOUND', `no takeover "${String(input.takeoverId)}" exists in this workspace's bootstrap state`);
      return projection;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_save_research_takeover_snapshot',
    description:
      '保存由你依据「已读内容」撰写的 Research Snapshot（研究现状、材料与成果、实验资料分组、已知、未知、关系、下一步建议）。' +
      '硬约束：每条 citation 的 entryId 必须指向当前 scan 中 readStatus="read" 的条目，quote 必须逐字出现在该条目的 excerpt 中——不满足会被拒绝且不写入。' +
      '证据不足时 currentFocus 写「待确定」并填入 unknown，禁止编造研究问题、结论或指标。' +
      'materials 的 evidenceLevel 只能用真实依据：file_present（仅文件存在）/ content_read（正文已读）/ reported_complete（项目自述）/ verifiable_result（有可复核产物）。' +
      'groups 的 basis 为 same_directory 或 reported 时必须 limitedBasis=true 并在 basisNote 写明依据有限。' +
      '推测关系用 confidence="inferred" 或 "unverified"，不得标 evidenced。权重文件只有元数据，不得声称读到了权重内容。mtime 不得当实验时间或因果依据。' +
      'snapshot 只能使用这些字段名，多一个或少一个都会被拒绝：' +
      '{title, currentFocus, materials:[{materialId,label,evidenceLevel,detail,citationIds}], groups:[{groupId,label,basis,basisNote,entryIds,limitedBasis}], known:[string], unknown:[{unknownId,topic,detail,entryIds}], relations:[{relationId,fromLabel,toLabel,basis,confidence,note,citationIds}], nextSteps:[string], citations:[{citationId,entryId,quote,note}], watchedEntries:[], model:null}。' +
      'citations 必须是 snapshot 顶层数组。quote 用 excerpt 里的一行原文，不要自造换行。',
    parameters: {
      operationId: { type: 'string', required: true },
      baseRevision: { type: 'number', required: true },
      takeoverId: { type: 'string', required: true },
      snapshot: { type: 'object', additionalProperties: true },
      modelIdentity: { type: 'object', additionalProperties: true },
    },
    output,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'save_research_takeover_snapshot');
      const input = args as { operationId: string; baseRevision: number; takeoverId: string; snapshot: unknown; modelIdentity?: { agentIdentity: string; modelIdentity: string } | null };
      const { service, sessionId } = scope(exec);
      const draft = (input.snapshot ?? {}) as Omit<TakeoverSnapshot, 'snapshotId' | 'revision' | 'scanId' | 'researchId' | 'createdAt' | 'updatedAt'>;
      const result = service.saveSnapshot(
        {
          operationId: requireString(input.operationId, 'operationId', 'save_research_takeover_snapshot'),
          baseRevision: requireRevision(input.baseRevision, 'save_research_takeover_snapshot'),
          takeoverId: requireString(input.takeoverId, 'takeoverId', 'save_research_takeover_snapshot'),
          snapshot: draft,
          ...(input.modelIdentity === undefined ? {} : { modelIdentity: input.modelIdentity }),
        },
        `agent:${sessionId}`,
      );
      return { ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_bind_research_takeover',
    description: '把「目标待定」草稿接管绑定到真实研究：校验 researchId 存在后置 status="saved"。不要为了绑定而新建研究问题。',
    parameters: { operationId: { type: 'string', required: true }, baseRevision: { type: 'number', required: true }, takeoverId: { type: 'string', required: true }, researchId: { type: 'string', required: true } },
    output,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'bind_research_takeover');
      const input = args as { operationId: string; baseRevision: number; takeoverId: string; researchId: string };
      const { service, sessionId } = scope(exec);
      const result = service.bindResearch(
        {
          operationId: requireString(input.operationId, 'operationId', 'bind_research_takeover'),
          baseRevision: requireRevision(input.baseRevision, 'bind_research_takeover'),
          takeoverId: requireString(input.takeoverId, 'takeoverId', 'bind_research_takeover'),
          researchId: requireString(input.researchId, 'researchId', 'bind_research_takeover'),
        },
        `agent:${sessionId}`,
      );
      return { ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_check_takeover_freshness',
    description: '重新核对被监视条目的真实字节/mtime/哈希，返回 stale 与变化原因（missing/size/modified/hash）。只读，不写盘；过期意味着快照可能已不反映当前文件。',
    parameters: { takeoverId: { type: 'string', required: true } },
    output,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'check_takeover_freshness');
      const input = args as { takeoverId: string };
      const { service } = scope(exec);
      return service.checkFreshness(requireString(input.takeoverId, 'takeoverId', 'check_takeover_freshness'));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_adopt_research_takeover',
    description: '把当前 Research Snapshot 接进已有研究的 Wiki 和研究树。先用 evolver_get_research_bootstrap 的 revision 作为 baseRevision。researchId 省略时：接管已绑定则沿用；否则建立问题为「待确定」的草稿，不要编造研究问题。items 每项字段只能是 key、entryId、title、content、quote、nature、role，以及可选 materialNature。nature 是知识主张性质，只能是 source_reported、hypothesis、unknown。materialNature 是原始材料性质，可用 literature、user_observation、user_result、simulation、hypothesis、inference、unknown；用户明确为模拟资料时必须传 simulation，不能只在正文里写模拟。更正来源性质会追加来源与知识版本，保留旧记录。role 只能是 wiki、material、plan、metadata。quote 必须是原始文件中的连续原文，不能用摘录行号冒充 PDF 页码。relations 每项字段只能是 key、fromKey、toKey、basis、confidence、note；basis 用 quoted_text、config_reference、run_identifier、same_directory。same_directory 必须标 unverified。权重 role 用 metadata。不要把外部日志写成已执行或已验证。',
    parameters: {
      operationId: { type: 'string', required: true },
      baseRevision: { type: 'number', required: true },
      takeoverId: { type: 'string', required: true },
      researchId: { type: 'string' },
      items: { type: 'array', required: true },
      relations: { type: 'array' },
    },
    output,
    execute: async (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'adopt_research_takeover');
      const input = args as { operationId: string; baseRevision: number; takeoverId: string; researchId?: string; items: TakeoverAdoptionRequestItem[]; relations?: TakeoverAdoptionRequestRelation[] };
      const { store, sessionId } = scope(exec);
      const result = await new TakeoverAdoptionService(store, options).adopt({
        operationId: requireString(input.operationId, 'operationId', 'adopt_research_takeover'),
        baseRevision: requireRevision(input.baseRevision, 'adopt_research_takeover'),
        takeoverId: requireString(input.takeoverId, 'takeoverId', 'adopt_research_takeover'),
        researchId: typeof input.researchId === 'string' && input.researchId.trim() ? input.researchId.trim() : null,
        items: input.items,
        relations: input.relations,
      }, `agent:${sessionId}`);
      return result;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_register_external_result',
    description: '登记一份外部实验结果或失败日志，并把它对应到已有实验。先用 evolver_get_research_bootstrap 的 revision 作为 baseRevision。字段只能是 operationId、baseRevision、researchId、relativePath、nature、label、externalRunId、clarification、values、failureQuote、conditions。relativePath 是工作区相对路径。nature 只能是 simulation 或 user_result。values 每项是 name、value、unit、row、column；row/column 从 0 开始，不含表头。value 为空时不要写 0，并给出文件里的 failureQuote。conditions 每项是 name、value、unit，未知用 null。externalRunId 必须是文件里的 run_id，不知道就省略。多个实验都可能对应时先不要绑定，把用户点名的节点标题放进 clarification 再登记一次。不要把结果写成已执行或已验证。',
    parameters: {
      operationId: { type: 'string', required: true },
      baseRevision: { type: 'number', required: true },
      researchId: { type: 'string', required: true },
      relativePath: { type: 'string', required: true },
      nature: { type: 'string', required: true },
      label: { type: 'string', required: true },
      externalRunId: { type: 'string' },
      clarification: { type: 'string' },
      values: { type: 'array', required: true },
      failureQuote: { type: 'string' },
      conditions: { type: 'array', required: true },
    },
    output,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'register_external_result');
      const input = args as { operationId: string; baseRevision: number; researchId: string; relativePath: string; nature: 'simulation' | 'user_result'; label: string; externalRunId?: string | null; clarification?: string | null; values: ExternalValueInput[]; failureQuote?: string | null; conditions: ExternalConditionInput[] };
      const { store } = scope(exec);
      const asked = typeof input.clarification === 'string' ? input.clarification.trim() : '';
      const trusted = asked ? latestTrustedUserTurn(exec.agent) : null;
      const result = new ExternalResultService(store).register({
        operationId: requireString(input.operationId, 'operationId', 'register_external_result'),
        baseRevision: requireRevision(input.baseRevision, 'register_external_result'),
        researchId: requireString(input.researchId, 'researchId', 'register_external_result'),
        relativePath: requireString(input.relativePath, 'relativePath', 'register_external_result'),
        nature: input.nature,
        label: requireString(input.label, 'label', 'register_external_result'),
        externalRunId: input.externalRunId ?? null,
        clarification: input.clarification ?? null,
        values: input.values,
        failureQuote: input.failureQuote ?? null,
        conditions: input.conditions,
      }, trusted);
      return { ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_review_external_results',
    description: '根据已登记的外部结果写一条模型建议。字段只能是 operationId、baseRevision、researchId、reportIds、judgment、boundary、support、counterEvidence、gaps、nextActions。judgment 只能是 support、counter、insufficient、mixed。失败或不可比结果必须用 insufficient，不要排名，不要把空值写成 0。nextActions 每项必须有 title、reason、prerequisite、condition、verification、resource；资源未知就写「未知」。这条建议不会改研究图，也不能带 authorize。',
    parameters: {
      operationId: { type: 'string', required: true },
      baseRevision: { type: 'number', required: true },
      researchId: { type: 'string', required: true },
      reportIds: { type: 'array', required: true },
      judgment: { type: 'string', required: true },
      boundary: { type: 'string', required: true },
      support: { type: 'string', required: true },
      counterEvidence: { type: 'string', required: true },
      gaps: { type: 'string', required: true },
      nextActions: { type: 'array', required: true },
    },
    output,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'review_external_results');
      const input = args as { operationId: string; baseRevision: number; researchId: string; reportIds: string[]; judgment: 'support' | 'counter' | 'insufficient' | 'mixed'; boundary: string; support: string; counterEvidence: string; gaps: string; nextActions: ExternalResultAction[] };
      const { store, sessionId } = scope(exec);
      const result = new ExternalResultService(store).review({
        operationId: requireString(input.operationId, 'operationId', 'review_external_results'),
        baseRevision: requireRevision(input.baseRevision, 'review_external_results'),
        researchId: requireString(input.researchId, 'researchId', 'review_external_results'),
        reportIds: input.reportIds,
        judgment: input.judgment,
        boundary: requireString(input.boundary, 'boundary', 'review_external_results'),
        support: typeof input.support === 'string' ? input.support : '',
        counterEvidence: typeof input.counterEvidence === 'string' ? input.counterEvidence : '',
        gaps: requireString(input.gaps, 'gaps', 'review_external_results'),
        nextActions: input.nextActions,
      }, `agent:${sessionId}`);
      return { ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_decide_external_result',
    description: '保存用户对某条建议的决定。字段只能是 operationId、baseRevision、researchId、reviewId、actionIndex、choice、utterance、modifiedTitle。utterance 必须等于本会话最新一条用户消息的全文，由宿主核对，不能改写、不能引用更早的消息、也不能从文件里摘“接受”。choice 只能是 accept、modify、reject、defer，而且必须能从这条消息里读出来，并点名对应建议。accept 才把建议写成未开始的后续节点。协议、来源或授权变了以后必须重新审查。modify 时 modifiedTitle 必须出现在原话里。没有 authorize 字段。模型不能替用户接受。',
    parameters: {
      operationId: { type: 'string', required: true },
      baseRevision: { type: 'number', required: true },
      researchId: { type: 'string', required: true },
      reviewId: { type: 'string', required: true },
      actionIndex: { type: 'number', required: true },
      choice: { type: 'string', required: true },
      utterance: { type: 'string', required: true },
      modifiedTitle: { type: 'string' },
    },
    output,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'decide_external_result');
      const input = args as { operationId: string; baseRevision: number; researchId: string; reviewId: string; actionIndex: number; choice: 'accept' | 'modify' | 'reject' | 'defer'; utterance: string; modifiedTitle?: string | null };
      const { store, sessionId } = scope(exec);
      if (!Number.isSafeInteger(input.actionIndex) || input.actionIndex < 0) throw new BootstrapError('INVALID_INPUT', 'decide_external_result: actionIndex is required');
      const trusted = latestTrustedUserTurn(exec.agent);
      const result = new ExternalResultService(store).decide({
        operationId: requireString(input.operationId, 'operationId', 'decide_external_result'),
        baseRevision: requireRevision(input.baseRevision, 'decide_external_result'),
        researchId: requireString(input.researchId, 'researchId', 'decide_external_result'),
        reviewId: requireString(input.reviewId, 'reviewId', 'decide_external_result'),
        actionIndex: input.actionIndex,
        choice: input.choice,
        utterance: requireString(input.utterance, 'utterance', 'decide_external_result'),
        modifiedTitle: input.modifiedTitle ?? null,
      }, `agent:${sessionId}`, trusted);
      return { ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));
}

/** Latest human-origin user text. Runtime/skill/team injections and files are never decisions. */
export function latestTrustedUserTurn(agent: { id?: string; sessionId?: string; session?: { snapshotEvents?: () => { type: string; id?: string; data?: { id?: string; source?: { kind?: string }; content?: { type?: string; text?: string }[] } }[] } } | undefined): TrustedUserMessage | null {
  const sessionId = agent?.id ?? agent?.sessionId;
  if (!sessionId || typeof agent?.session?.snapshotEvents !== 'function') return null;
  const last = [...agent.session.snapshotEvents()].reverse().find(event => event.type === 'user/message' && event.data?.source?.kind === 'user');
  if (!last) return null;
  const text = (last.data?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n').trim();
  const messageId = (last.id ?? last.data?.id ?? '').trim();
  if (!text || !messageId) return null;
  return { sessionId, messageId, text };
}

/** Host-side helper so the HTTP layer can reuse the same信任边界 without duplicating it. */
export function takeoverServiceForSession(resolve: (sessionId: string) => ResearchBootstrapStore, sessionId: string, options: TakeoverServiceOptions = {}): TakeoverService {
  return new TakeoverService(resolve(sessionId), options);
}

export type { TakeoverScan };
