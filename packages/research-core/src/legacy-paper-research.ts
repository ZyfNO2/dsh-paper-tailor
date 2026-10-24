import { createHash } from 'node:crypto';
import { ResearchBootstrapIntentService } from '../../evolver/src/application/research-bootstrap-intent-service.ts';
import { ResearchBootstrapGraphService } from '../../evolver/src/application/research-bootstrap-graph-service.ts';
import type { ResearchBootstrapStore } from '../../evolver/src/application/research-bootstrap-store.ts';
import type { ActorContext } from '../../research-contracts/src/index.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';
import { workspacePaperLibrary, workspacePaperResolver } from './legacy-papers.ts';

export const PAPER_RESEARCH_ACTIONS = ['start_research', 'save_research_contract', 'confirm_research_contract', 'confirm_research_baseline', 'edit_research_idea', 'begin_research_brainstorm', 'fail_research_brainstorm', 'publish_research_ideas', 'publish_research_graph', 'select_research_ideas', 'set_slot_locked', 'set_slot_component'];
/** Real domain writes with externally supplied drafts; generation never pretends a native Agent ran. */
export function paperResearchAction(workspace: string, store: ResearchBootstrapStore, body: Record<string, unknown>, identity: string, actor?: ActorContext) {
  const resolver = workspacePaperResolver(workspace), intent = new ResearchBootstrapIntentService(store, { resolver }), graph = new ResearchBootstrapGraphService(store, { resolver });
  const operationId = body.operationId as string, baseRevision = body.baseRevision as number, researchId = body.researchId as string;
  const write = { operationId, baseRevision, researchId }, trusted = { identity, actionId: operationId }, user = !actor || actor.kind === 'user';
  const human = () => { if (!user) throw new ResearchCoreError('INVALID_INPUT', 'trusted user action required'); };
  const child = (suffix: string) => createHash('sha256').update(`${operationId}:${suffix}`).digest('hex');
  if (body.type === 'start_research' || body.type === 'save_research_contract') {
    if (body.confirm === true) human();
    const raw = body.patch ?? body.draft;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ResearchCoreError('INVALID_INPUT', 'contract patch/draft required');
    const value = raw as Record<string, unknown>, patch: Record<string, unknown> = {};
    const allowed = ['question', 'objective', 'dataTarget', 'baselineName', 'metricTarget', 'title', 'researchQuestion', 'goal', 'baseline', 'dataDescription', 'metrics', 'guardrails', 'editableScope', 'lockedScope', 'computeBudget', 'timeBudget', 'pendingQuestions'];
    if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ResearchCoreError('INVALID_INPUT', 'unknown contract patch field');
    // UI field names are translated; native domain field names remain available to external agents.
    const names: Record<string, string> = { question: 'researchQuestion', objective: 'goal', dataTarget: 'dataDescription' };
    for (const [key, val] of Object.entries(value)) {
      if (key === 'baselineName') patch.baseline = { status: 'proposed', name: val };
      else if (key === 'metricTarget') patch.metrics = val === null ? [] : [val];
      else patch[names[key] ?? key] = val;
    }
    const saved = intent.saveResearchContract({ ...write, researchId: researchId ?? null, patch, origin: { kind: user ? 'user_action' : 'tool', identity, actionId: operationId } });
    if (body.confirm !== true) return saved;
    return intent.confirmResearchContract({ operationId: child('confirm'), baseRevision: store.readStateOrEmpty().revision, researchId: saved.result.researchId, actor: trusted, note: '独立工作台显式用户确认' });
  }
  if (!researchId) throw new ResearchCoreError('INVALID_INPUT', 'researchId required');
  if (body.type === 'confirm_research_contract') { human(); return intent.confirmResearchContract({ ...write, actor: trusted, note: body.note as string }); }
  if (body.type === 'confirm_research_baseline') { human(); return intent.confirmBaseline({ ...write, actor: trusted, proposal: body.proposal as Parameters<typeof intent.confirmBaseline>[0]['proposal'], note: body.note as string }); }
  if (body.type === 'select_research_ideas') { human(); return graph.selectResearchIdeas({ ...write, ideaIds: body.ideaIds as string[], actor: trusted }); }
  if (body.type === 'set_slot_locked') { human(); return graph.setSlotLocked({ ...write, slotId: body.slotId as string, locked: body.locked as boolean, actor: trusted }); }
  if (body.type === 'edit_research_idea') {
    const input = body.patch as Record<string, unknown>;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ResearchCoreError('INVALID_INPUT', 'idea patch required');
    const allowed = ['title', 'hypothesis', 'rationale', 'basis', 'exploratoryNote', 'evidenceRefs', 'proposedSlot', 'atomicChange', 'validationPlan', 'targetMetrics', 'targetMetric', 'costNote', 'riskNote', 'pendingQuestions'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new ResearchCoreError('INVALID_INPUT', 'unknown or unsupported idea patch field (reviewNotes is not persisted by the original service)');
    const { targetMetric, ...patch } = input;
    return intent.updateResearchIdea({ ...write, ideaId: body.ideaId as string, patch: { ...patch, ...(targetMetric === undefined ? {} : { targetMetrics: targetMetric === null ? [] : [targetMetric] }) } as never, origin: { kind: user ? 'user_action' : 'tool', identity } });
  }
  if (['begin_research_brainstorm', 'fail_research_brainstorm', 'publish_research_ideas'].includes(body.type as string)) {
    for (const key of ['agentIdentity', 'modelIdentity', 'run', 'status']) if (key in body) throw new ResearchCoreError('INVALID_INPUT', `${key} is not a trusted transport field`);
    const state = store.readStateOrEmpty(), research = state.researches.find((r) => r.researchId === researchId);
    const receipt = state.receipts.find((r) => r.operationId === operationId);
    const priorRunId = (receipt?.result as { runId?: string } | undefined)?.runId;
    const owned = (id: unknown) => {
      if (typeof id !== 'string' || !id) throw new ResearchCoreError('INVALID_INPUT', 'existing runId required');
      const run = research?.brainstormRuns.find((r) => r.runId === id);
      if (!run || run.agentIdentity !== identity) throw new ResearchCoreError('INVALID_INPUT', 'brainstorm run belongs to another client or is missing');
      return run;
    };
    if (priorRunId) owned(priorRunId);
    if (body.runId !== undefined) owned(body.runId);
    if (body.type === 'begin_research_brainstorm') return intent.beginBrainstormRun({ ...write, contractRevision: body.contractRevision as number, agentIdentity: identity, modelIdentity: null, runId: body.runId as string | undefined, inputRefs: body.inputRefs as never, inputNotes: '外部客户端已显式开始候选工作；未验证模型调用' });
    if (body.type === 'fail_research_brainstorm') {
      const run = owned(body.runId);
      if (typeof body.code !== 'string' || !body.code.trim() || typeof body.message !== 'string' || !body.message.trim()) throw new ResearchCoreError('INVALID_INPUT', 'actual first-error code and message required');
      return intent.setBrainstormRunStatus({ ...write, runId: run.runId, status: 'failed', error: { code: body.code, message: body.message } });
    }
    return intent.publishResearchIdeas({ ...write, contractRevision: body.contractRevision as number, ideas: body.ideas as Parameters<typeof intent.publishResearchIdeas>[0]['ideas'], emptyResultReason: body.emptyResultReason as string | undefined, itemErrors: body.itemErrors as never, run: { runId: body.runId as string | undefined, agentIdentity: identity, modelIdentity: null, inputRefs: body.inputRefs as never, inputNotes: '外部提交的候选草稿；未声称原生 Agent Team 或模型执行' } });
  }
  if (body.type === 'publish_research_graph') return graph.initializeGraph({ ...write, contractRevision: body.contractRevision as number, selectedIdeaIds: body.selectedIdeaIds as string[], slotDrafts: body.slotDrafts as Parameters<typeof graph.initializeGraph>[0]['slotDrafts'], candidateDrafts: body.candidateDrafts as Parameters<typeof graph.initializeGraph>[0]['candidateDrafts'] });
  if (body.type === 'set_slot_component') {
    const token = typeof body.ref === 'string' ? body.ref : (body.ref as { token?: string })?.token;
    if (typeof token !== 'string') throw new ResearchCoreError('INVALID_INPUT', 'current candidate token required');
    const ideaToken = /^idea:([^@]+)@(\d+)@([0-9a-f]{64})$/.exec(token);
    if (ideaToken) {
      const idea = store.readStateOrEmpty().researches.find((r) => r.researchId === researchId)?.ideas.find((i) => i.ideaId === ideaToken[1]);
      if (!idea || idea.revision !== Number(ideaToken[2]) || idea.contentHash !== ideaToken[3]) throw new ResearchCoreError('REVISION_CONFLICT', 'idea candidate token is stale');
      return graph.setSlotComponent({ ...write, nodeId: body.nodeId as string, slotId: body.slotId as string, ref: { kind: 'design_idea', ideaId: idea.ideaId, contentRevision: idea.revision, contentHash: idea.contentHash, title: idea.title } });
    }
    const paperToken = /^paper:(paper-[0-9a-f]{64}):(\d+)@([^@]+)@([0-9a-f]{64})$/.exec(token);
    if (!paperToken) throw new ResearchCoreError('INVALID_INPUT', 'invalid component token');
    const paper = workspacePaperLibrary(workspace).get(workspace, paperToken[1]), index = Number(paperToken[2]), component = paper.components[index];
    if (!component) throw new ResearchCoreError('NOT_FOUND', 'paper component missing');
    return graph.setSlotComponent({ ...write, nodeId: body.nodeId as string, slotId: body.slotId as string, ref: { kind: 'paper_component', paperId: paper.id, componentIndex: index, assetRevision: paperToken[3], contentHash: paperToken[4], sourceSha256: paper.sha256, name: component.name, componentKind: component.kind } });
  }
  throw new ResearchCoreError('INVALID_INPUT', 'unsupported paper research action');
}
