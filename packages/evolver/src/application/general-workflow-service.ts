import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch, validateTeamTaskDraft, type GeneralResearch } from '../contracts/general-research.ts';
import { validateGeneralGraph, validateGeneralNode, validateGeneralProfile, validateNodeConfirmation, type GeneralProfile, type GeneralNode, type GeneralEdge, type GeneralNodeConfirmation } from '../contracts/general-workflow.ts';
import { ResearchBootstrapStore, requireResearch, type MutationResult } from './research-bootstrap-store.ts';
import { GeneralMaterialStore } from './general-material-store.ts';
import { nodeHash, calculationFreshness, reviewFreshness, generalContextHash } from './general-analysis-service.ts';
import type { GeneralNodeState } from '../contracts/general-workflow.ts';
import { dependencySnapshotHash, currentConditionGuards } from './general-graph-context.ts';
import { assertGeneralSourceAccess, generalSourceAllowed } from './general-source-access.ts';
import { recordGeneralEdit, applyGeneralEdit } from './general-edit-history.ts';
import { ResearchCycleStore } from './research-cycle-store.ts';

interface Write { operationId: string; baseRevision: number; researchId: string }
export type { GeneralNodeState } from '../contracts/general-workflow.ts';
export function confirmationFreshness(g: GeneralResearch, c: GeneralNodeConfirmation): { current: boolean; reasons: string[] } {
  const reasons: string[] = [], node = g.graph.nodes.find(n => n.nodeId === c.nodeId);
  if (!node || nodeHash(node) !== c.nodeSnapshotHash) reasons.push('节点说明或完成标准已变更。');
  if (c.dependencySnapshotHash !== dependencySnapshotHash(g, c.nodeId)) reasons.push('节点前置关系或上游协议已变更。');
  if (JSON.stringify(c.guards) !== JSON.stringify(currentConditionGuards(g, c.nodeId))) reasons.push('本节点所属条件分支的审查版本已变更。');
  if (c.profileRevision !== g.profileRevision) reasons.push('研究契约已更新，需要重新确认授权范围。');
  if (c.idea && g.ideas.some(i => i.ideaId === c.idea!.ideaId && i.revision !== c.idea!.revision)) reasons.push('研究问题 / Idea 已更新。');
  if (c.sourceRefs.some(id => g.sources.some(s => s.previousSourceId === id))) reasons.push('原始材料已有新版本。');
  if (c.sourceRefs.some(id => !generalSourceAllowed(g, id))) reasons.push('确认来源证据使用权限已撤销。');
  if (c.datasets.some(ref => g.datasets.some(d => d.datasetId === ref.datasetId && d.version > ref.version))) reasons.push('确认的数据字典已有新版本。');
  return { current: reasons.length === 0, reasons };
}

/** Selected-branch joins and ordinary dependencies use different readiness rules. */
export function generalNodeStates(g: GeneralResearch): GeneralNodeState[] {
  const results = new Map<string, GeneralNodeState>();
  const satisfied = (state: GeneralNodeState): boolean => ['policy_ready', 'manual_confirmed', 'output_ready', 'reviewed'].includes(state.status);
  function read(nodeId: string): GeneralNodeState {
    const cached = results.get(nodeId); if (cached) return cached;
    const node = g.graph.nodes.find(n => n.nodeId === nodeId)!;
    const edges = g.graph.edges.filter(e => e.from === nodeId && ['depends_on', 'condition'].includes(e.kind));
    const state: GeneralNodeState = { nodeId, status: 'ready', reason: '没有未满足前置；仍需明确授权，查看状态不会启动运行。', prerequisiteIds: edges.map(e => e.to), judgment: null, confirmationId: null, reviewId: null, calculationIds: [] };
    const parents = edges.map(e => ({ edge: e, state: read(e.to) }));
    const guardMismatch = parents.find(p => p.edge.kind === 'condition' && p.state.judgment !== null && p.state.judgment !== p.edge.condition);
    const guardPending = parents.find(p => p.edge.kind === 'condition' && p.state.judgment === null);
    if (guardMismatch) { state.status = 'skipped'; state.reason = `未选中分支：审查为 ${guardMismatch.state.judgment}，本边只适用于 ${guardMismatch.edge.condition}；历史执行事实仍保留。`; results.set(nodeId, state); return state; }
    if (guardPending) { state.status = 'blocked'; state.reason = '条件分支等待当前版本有依据的审查，旧完成记录不能绕过条件。'; results.set(nodeId, state); return state; }
    if (node.join === 'all' && parents.some(p => p.state.status === 'skipped')) { state.status = 'skipped'; state.reason = '全部输入汇合包含未选中分支；请明确使用 selected 才能只等待有效分支。'; results.set(nodeId, state); return state; }
    if (node.join === 'selected' && parents.length && parents.every(p => p.state.status === 'skipped')) { state.status = 'skipped'; state.reason = '没有已选有效输入分支。'; results.set(nodeId, state); return state; }
    const requiredParents = node.join === 'selected' ? parents.filter(p => p.state.status !== 'skipped') : parents;
    const unmetParents = requiredParents.filter(p => !satisfied(p.state));
    if (unmetParents.length) { state.status = 'blocked'; state.reason = `等待前置：${unmetParents.map(p => g.graph.nodes.find(n => n.nodeId === p.state.nodeId)!.title).join('、')}；历史产物与人工确认不能绕过当前前置。`; results.set(nodeId, state); return state; }
    if (!g.requireHumanConfirmation && (['goal', 'protocol'].includes(node.kind) || node.kind === 'materials' && g.sources.some(s => generalSourceAllowed(g, s.sourceId)))) { state.status = 'policy_ready'; state.reason = '人工确认开关已关闭：已登记输入满足流程前置，自动放行；不是人工确认或科研验证。'; results.set(nodeId, state); return state; }
    const review = [...g.reviews].reverse().find(r => r.nodeId === nodeId);
    if (review && ['review', 'decision'].includes(node.kind) && reviewFreshness(g, review).status === 'current') {
      state.status = 'reviewed'; state.reason = '有依据的审查已登记；完成审查不等于假设被支持。'; state.judgment = review.judgment; state.reviewId = review.reviewId; results.set(nodeId, state); return state;
    }
    const currentCalculations = g.calculations.filter(c => c.nodeId === nodeId && c.status === 'completed' && calculationFreshness(g, c).status === 'current');
    if (currentCalculations.length && node.kind === 'analysis') {
      state.status = 'output_ready'; state.reason = '有可检查的真实工具产物；仅产物就绪，科研判断另行审查。'; state.calculationIds = currentCalculations.map(c => c.calculationId); results.set(nodeId, state); return state;
    }
    const confirmation = [...g.nodeConfirmations].reverse().find(c => c.nodeId === nodeId);
    if (confirmation && confirmationFreshness(g, confirmation).current) {
      state.status = 'manual_confirmed'; state.reason = `人工确认：${confirmation.reason}；这不是 AI 或仪器执行证明。`; state.confirmationId = confirmation.confirmationId; results.set(nodeId, state); return state;
    }
    const unmetCondition = parents.find(p => p.edge.kind === 'condition' && p.state.judgment === null);
    const wrongCondition = parents.find(p => p.edge.kind === 'condition' && p.state.judgment !== null && p.state.judgment !== p.edge.condition);
    if (wrongCondition) { state.status = 'skipped'; state.reason = `未选中分支：审查为 ${wrongCondition.state.judgment}，本边只适用于 ${wrongCondition.edge.condition}。`; }
    else if (unmetCondition) { state.status = 'blocked'; state.reason = '条件分支等待当前版本有依据的审查；仅标父节点完成不能解锁。'; }
    else {
      const required = node.join === 'selected' ? parents.filter(p => p.state.status !== 'skipped') : parents;
      if (parents.length && !required.length) { state.status = 'skipped'; state.reason = '所依赖的分支均未选中，本节点不作为有效汇合。'; }
      else if (node.join === 'all' && parents.some(p => p.state.status === 'skipped')) { state.status = 'skipped'; state.reason = '全部输入汇合依赖未选中分支；如只等待有效分支，请显式改为 selected。'; }
      else {
        const unmet = required.filter(p => !satisfied(p.state));
        if (unmet.length) { state.status = 'blocked'; state.reason = `等待前置：${unmet.map(p => g.graph.nodes.find(n => n.nodeId === p.state.nodeId)!.title).join('、')}。`; }
        else if (review && reviewFreshness(g, review).status !== 'current') { state.status = 'ready'; state.reason = '旧审查受输入或协议变更影响，需新版本审查；原判断未被覆盖。'; }
        else if (confirmation) state.reason = `旧人工确认待重审：${confirmationFreshness(g, confirmation).reasons.join(' ')}`;
      }
    }
    results.set(nodeId, state); return state;
  }
  return g.graph.nodes.map(n => read(n.nodeId));
}
export function generalProfile(title: string, g: GeneralResearch): GeneralProfile {
  return validateGeneralProfile({ requireHumanConfirmation: g.requireHumanConfirmation, revision: g.profileRevision, title, domains: g.domains, methods: g.methods, entryMode: g.entryMode, reference: g.reference, constraints: g.constraints, pendingQuestions: g.pendingQuestions, limits: g.limits });
}
export class GeneralWorkflowService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }

  private assertRemovableNode(g: GeneralResearch, researchId: string, nodeId: string): void {
    const cycles = new ResearchCycleStore(this.store.workspaceRoot, researchId).readStateOrEmpty();
    if (g.inferencePlans.some(p => p.nodeId === nodeId) || g.plans.some(p => p.nodeId === nodeId) || g.reviews.some(r => r.nodeId === nodeId) || g.nodeConfirmations.some(c => c.nodeId === nodeId) || g.knowledge.some(e => e.nodeIds.includes(nodeId)) || g.graph.nodes.some(n => n.nodeId === nodeId && n.task) || cycles.runs.some(r => r.nodeId === nodeId) || cycles.graphNodes.some(n => n.sourceNodeId === nodeId)) throw new BootstrapError('POLICY_DENIED', '节点已有方案 / 运行 / 审查 / 确认事实，不能删除历史归属。');
  }

  edit(input: Write & { direction: 'undo' | 'redo' }): MutationResult<{ graphRevision: number }> {
    if (!['undo', 'redo'].includes(input.direction)) throw new BootstrapError('INVALID_INPUT', 'Invalid edit direction');
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: `${input.direction}_general_graph_edit`, researchId: input.researchId, requestPayload: { researchId: input.researchId, direction: input.direction }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究图。');
      const source = input.direction === 'undo' ? g.editHistory.past : g.editHistory.future;
      const target = input.direction === 'undo' ? g.editHistory.future : g.editHistory.past;
      const edit = source.at(-1);
      if (!edit) throw new BootstrapError('NOT_FOUND', '没有可恢复的图编辑。');
      applyGeneralEdit(g, edit, input.direction, id => this.assertRemovableNode(g, input.researchId, id));
      source.pop(); target.push(edit); g.revision++;
      research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { graphRevision: g.graph.revision } };
    } });
  }

  clearEditHistory(input: Write): MutationResult<{ graphRevision: number }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'clear_general_edit_history', researchId: input.researchId, requestPayload: { researchId: input.researchId }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究图。');
      g.editHistory = { past: [], future: [] }; g.revision++;
      research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { graphRevision: g.graph.revision } };
    } });
  }

  saveProfile(input: Write & { profile: Omit<GeneralProfile, 'revision'> }): MutationResult<{ profileRevision: number }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'save_general_profile', researchId: input.researchId, requestPayload: { researchId: input.researchId, profile: input.profile }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '历史算法契约请使用原严格入口。');
      const next = validateGeneralProfile({ ...input.profile, revision: g.profileRevision + 1 });
      g.profileHistory.push(generalProfile(research.title, g));
      Object.assign(g, { requireHumanConfirmation: next.requireHumanConfirmation, profileRevision: next.revision, domains: next.domains, methods: next.methods, entryMode: next.entryMode, reference: next.reference, constraints: next.constraints, pendingQuestions: next.pendingQuestions, limits: next.limits });
      research.title = next.title; g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { profileRevision: next.revision } };
    } });
  }

  saveNode(input: Write & { nodeId?: string | null; node: Omit<GeneralNode, 'nodeId' | 'execution'>; position?: { x: number; y: number } }): MutationResult<{ nodeId: string; graphRevision: number }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'save_general_node', researchId: input.researchId, requestPayload: { researchId: input.researchId, nodeId: input.nodeId ?? null, node: input.node, position: input.position ?? null }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究图。');
      const existing = input.nodeId ? g.graph.nodes.find(n => n.nodeId === input.nodeId) : undefined;
      if (input.nodeId && !existing) throw new BootstrapError('NOT_FOUND', '节点不属于该研究。');
      if (Object.hasOwn(input.node, 'execution') || Object.hasOwn(input.node, 'status') || Object.hasOwn(input.node, 'task')) throw new BootstrapError('POLICY_DENIED', '布局 / 节点编辑不能授予执行状态。');
      const node = validateGeneralNode({ ...input.node, ...(existing?.task ? { task: existing.task } : {}), nodeId: existing?.nodeId ?? context.mint('node'), execution: 'not_started' });
      const beforeGraph = structuredClone(g.graph), beforeLayout = structuredClone(g.layout);
      g.graphHistory.push(structuredClone(g.graph));
      if (existing) g.graph.nodes[g.graph.nodes.indexOf(existing)] = node; else g.graph.nodes.push(node);
      g.graph.revision++; g.graph = validateGeneralGraph(g.graph);
      if (input.position) g.layout[node.nodeId] = input.position;
      else if (!existing) g.layout[node.nodeId] = { x: 50 + (g.graph.nodes.length - 1) * 270, y: 360 };
      recordGeneralEdit(g, beforeGraph, beforeLayout, input.operationId, context.now());
      g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { nodeId: node.nodeId, graphRevision: g.graph.revision } };
    } });
  }

  saveEdge(input: Write & { edgeId?: string | null; edge: Omit<GeneralEdge, 'edgeId'> }): MutationResult<{ edgeId: string; graphRevision: number }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'save_general_edge', researchId: input.researchId, requestPayload: { researchId: input.researchId, edgeId: input.edgeId ?? null, edge: input.edge }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究图。');
      const existing = input.edgeId ? g.graph.edges.find(e => e.edgeId === input.edgeId) : undefined;
      if (input.edgeId && !existing) throw new BootstrapError('NOT_FOUND', '连接不属于该研究。');
      const beforeGraph = structuredClone(g.graph), beforeLayout = structuredClone(g.layout);
      g.graphHistory.push(structuredClone(g.graph));
      const edge = { ...input.edge, edgeId: existing?.edgeId ?? context.mint('edge') };
      if (existing) g.graph.edges[g.graph.edges.indexOf(existing)] = edge; else g.graph.edges.push(edge);
      g.graph.revision++; g.graph = validateGeneralGraph(g.graph);
      recordGeneralEdit(g, beforeGraph, beforeLayout, input.operationId, context.now());
      g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { edgeId: edge.edgeId, graphRevision: g.graph.revision } };
    } });
  }

  /** F04：保存 Team 任务输入草稿（不执行）。冻结保存时的研究上下文 hash 与来源版本；启动时由 start_cycle 校验新鲜度。 */
  saveTeamTaskDraft(input: Write & { draftId?: string | null; draft: { nodeId: string; title: string; goal: string; method: string; completionCriterion: string; sourceIds: string[] } }): MutationResult<{ draftId: string; draftRevision: number }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'save_general_team_task', researchId: input.researchId, requestPayload: { researchId: input.researchId, draftId: input.draftId ?? null, draft: input.draft }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
      const node = g.graph.nodes.find(n => n.nodeId === input.draft.nodeId);
      if (!node) throw new BootstrapError('NOT_FOUND', '任务草稿的研究节点不属于该研究。');
      if (!Array.isArray(input.draft.sourceIds)) throw new BootstrapError('INVALID_INPUT', 'sourceIds 必须是已登记来源 ID 数组。');
      const frozenSources: Array<{ sourceId: string; revision: number }> = [];
      for (const s of input.draft.sourceIds) {
        const source = g.sources.find(x => x.sourceId === s);
        if (!source) throw new BootstrapError('SOURCE_MISSING', '来源不属于当前研究，不能绑定未知引用。');
        assertGeneralSourceAccess(g, s);
        frozenSources.push({ sourceId: source.sourceId, revision: source.revision });
      }
      const previous = input.draftId ? g.teamTaskDrafts.find(d => d.draftId === input.draftId) : undefined;
      if (input.draftId && !previous) throw new BootstrapError('NOT_FOUND', '任务草稿不属于该研究。');
      const now = context.now();
      const draft = validateTeamTaskDraft({
        ...(previous ?? {}), draftId: previous?.draftId ?? context.mint('team-task'), revision: (previous?.revision ?? 0) + 1,
        nodeId: node.nodeId, title: input.draft.title, goal: input.draft.goal, method: input.draft.method, completionCriterion: input.draft.completionCriterion,
        sources: frozenSources, ideaId: g.ideas[0]?.ideaId ?? null, ideaRevision: g.ideas[0]?.revision ?? null,
        profileRevision: g.profileRevision, contextHash: generalContextHash(g), status: 'draft',
        createdAt: previous?.createdAt ?? now, updatedAt: now,
      });
      if (previous) g.teamTaskDrafts[g.teamTaskDrafts.indexOf(previous)] = draft; else g.teamTaskDrafts.push(draft);
      g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = now;
      return { changed: true, result: { draftId: draft.draftId, draftRevision: draft.revision } };
    } });
  }

  remove(input: Write & { kind: 'node' | 'edge'; id: string }): MutationResult<{ graphRevision: number }> {    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'remove_general_graph_item', researchId: input.researchId, requestPayload: { researchId: input.researchId, kind: input.kind, id: input.id }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用图。');
      if (input.kind !== 'node' && input.kind !== 'edge') throw new BootstrapError('INVALID_INPUT', '只允许删除节点或连接。');
      const exists = input.kind === 'node' ? g.graph.nodes.some(n => n.nodeId === input.id) : g.graph.edges.some(e => e.edgeId === input.id);
      if (!exists) throw new BootstrapError('NOT_FOUND', '图对象不存在。');
      if (input.kind === 'node') this.assertRemovableNode(g, input.researchId, input.id);
      const beforeGraph = structuredClone(g.graph), beforeLayout = structuredClone(g.layout);
      g.graphHistory.push(structuredClone(g.graph));
      if (input.kind === 'edge') g.graph.edges = g.graph.edges.filter(e => e.edgeId !== input.id);
      else { g.graph.nodes = g.graph.nodes.filter(n => n.nodeId !== input.id); g.graph.edges = g.graph.edges.filter(e => e.from !== input.id && e.to !== input.id); for (const n of g.graph.nodes) n.inputs = n.inputs.filter(i => i !== input.id); delete g.layout[input.id]; }
      g.graph.revision++; g.graph = validateGeneralGraph(g.graph); recordGeneralEdit(g, beforeGraph, beforeLayout, input.operationId, context.now()); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { graphRevision: g.graph.revision } };
    } });
  }

  confirmNode(input: Write & { nodeId: string; sourceRefs: string[]; reason: string }, identity: string): MutationResult<{ confirmationId: string }> {
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'confirm_general_manual_node', researchId: input.researchId, requestPayload: { researchId: input.researchId, nodeId: input.nodeId, sourceRefs: input.sourceRefs, reason: input.reason }, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '没有通用研究。');
      const node = g.graph.nodes.find(n => n.nodeId === input.nodeId);
      if (!node || ['analysis', 'review', 'decision'].includes(node.kind)) throw new BootstrapError('POLICY_DENIED', '分析执行必须有真实工具 / Team 产物；审查必须登记有依据的判断，不能手填完成。');
      const readiness = generalNodeStates(g).find(s => s.nodeId === node.nodeId)!;
      if (['blocked', 'skipped'].includes(readiness.status)) throw new BootstrapError('DEPENDENCY_NOT_READY', readiness.reason);
      if (!Array.isArray(input.sourceRefs) || (node.kind === 'materials' && !input.sourceRefs.length)) throw new BootstrapError('SOURCE_MISSING', '材料确认需要至少一个真实已登记来源。');
      const materials = new GeneralMaterialStore(this.store.workspaceRoot);
      for (const id of input.sourceRefs) { assertGeneralSourceAccess(g, id); const source = g.sources.find(s => s.sourceId === id); if (!source) throw new BootstrapError('SOURCE_MISSING', '来源不属于该研究。'); materials.readRaw(source); }
      const idea = ['goal', 'protocol'].includes(node.kind) ? g.ideas[0] : null;
      const datasets = g.datasets.filter(d => input.sourceRefs.includes(d.sourceId) && !g.datasets.some(newer => newer.datasetId === d.datasetId && newer.version > d.version)).map(d => ({ datasetId: d.datasetId, version: d.version }));
      const confirmation = validateNodeConfirmation({ confirmationId: context.mint('confirmation'), nodeId: node.nodeId, nodeSnapshotHash: nodeHash(node), dependencySnapshotHash: dependencySnapshotHash(g, node.nodeId), guards: currentConditionGuards(g, node.nodeId), profileRevision: g.profileRevision, idea: idea ? { ideaId: idea.ideaId, revision: idea.revision } : null, sourceRefs: input.sourceRefs, datasets, reason: input.reason, actor: { identity, actionId: input.operationId }, createdAt: context.now() });
      g.nodeConfirmations.push(confirmation); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { confirmationId: confirmation.confirmationId } };
    } });
  }
}
