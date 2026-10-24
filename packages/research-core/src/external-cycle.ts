import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ResearchCycleService } from '../../evolver/src/application/research-cycle-service.ts';
import { ResearchCycleStore } from '../../evolver/src/application/research-cycle-store.ts';
import { ResearchCoreError, validateActorContext, type ActorContext } from '../../research-contracts/src/index.ts';
import { legacyScope } from './legacy-domain.ts';
import { workspacePaperResolver } from './legacy-papers.ts';
import { GENERAL_CYCLE_FIELDS } from '../../evolver/src/contracts/general-cycle.ts';
import { CYCLE_ROLE_REGISTRY } from '../../evolver/src/application/research-cycle-roles.ts';

const PAPER_FIELDS = {
  hypothesis: 'ideaRef:{ideaId,contentRevision,contentHash}, hypothesis,motivation,baseline,variable,expectedResult:string, sourceRefs:assigned CycleInputRef[], notes:string|null',
  planner: 'proposalRef:exact predecessor ArtifactRef, baseline,change,dataset,completionCriteria:string, fixedConditions,metrics,ablations,openQuestions:string[]',
  evidence: 'proposalRef,planRef:exact predecessor ArtifactRefs, findings:{claim,support,sourceNature:literature|existing_experiment|simulation,sourceRefs:assigned CycleInputRef[]}[], gaps:string[], summary:string',
  reviewer: 'proposalRef,planRef,evidenceRef:exact predecessor ArtifactRefs, decision:keep|pause|reject|needs_validation, reason:string, nextActions:{actionId,kind:validation|combination|analysis|literature,title,detail}[], graphPatch:{addNodes:[],addEdges:[],branchDecisions:[]}. Empty graph arrays are valid. Future actions stay unexecuted.',
};

const fields: Record<string, string[]> = {
  prepare: ['operationId', 'baseRevision', 'cycleRevision', 'ideaId', 'nodeId', 'sourceIds', 'authorize', 'taskDraftId'],
  claim: ['runId', 'stepId', 'attemptId', 'cycleRevision'],
  input: ['runId', 'stepId', 'inputRef'],
  publish: ['runId', 'stepId', 'attemptId', 'kind', 'payload'],
  submit: ['operationId', 'runId', 'stepId', 'attemptId', 'outputRefs', 'cycleRevision'],
  fail: ['runId', 'stepId', 'attemptId', 'code', 'message'],
  cancel: ['operationId', 'runId', 'cycleRevision', 'authorize'],
  retry: ['operationId', 'runId', 'stepId', 'cycleRevision', 'baseRevision', 'authorize'],
  apply: ['operationId', 'runId', 'decisionRef', 'cycleRevision', 'authorize'],
  adopt_action: ['operationId', 'runId', 'decisionRef', 'actionId', 'cycleRevision', 'authorize'],
};

/** File-backed role handoffs. Clients do work elsewhere; no local LLM/Team or scripted executor is spawned. */
export async function externalCycleAction(workspace: string, researchId: string, value: Record<string, unknown>, caller?: ActorContext) {
  workspace = fs.realpathSync(workspace);
  const actor = caller ? validateActorContext(caller) : { actorId: `local-user:${os.userInfo().username}`, kind: 'user' as const, source: 'http' as const };
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.action !== 'string' || !fields[value.action]) throw new ResearchCoreError('INVALID_INPUT', 'supported external cycle action required');
  if (Object.keys(value).some((key) => key !== 'action' && !fields[value.action as string].includes(key))) throw new ResearchCoreError('INVALID_INPUT', 'unknown field or forged transport identity in external cycle payload');
  const action = value.action;
  const userAction = ['prepare', 'cancel', 'retry', 'apply', 'adopt_action'].includes(action);
  if (userAction && (actor.kind !== 'user' || value.authorize !== true)) throw new ResearchCoreError('INVALID_INPUT', 'explicit user authorization required');
  if (!userAction && actor.kind !== 'agent') throw new ResearchCoreError('INVALID_INPUT', 'role handoff actions require an agent transport identity');
  if (!/^[\w-]+$/.test(researchId)) throw new ResearchCoreError('INVALID_INPUT', 'valid researchId required');
  const { store, readOnly } = legacyScope(workspace);
  if (readOnly) throw new ResearchCoreError('INVALID_INPUT', 'MIGRATION_REQUIRED: external handoffs require the active store');
  if (!store.readStateOrEmpty().researches.some((r) => r.researchId === researchId)) throw new ResearchCoreError('NOT_FOUND', 'researchId outside this workspace');
  const cycleRoot = path.join(store.workspaceRoot, '.dsh/research/cycles', researchId);
  for (const candidate of [path.dirname(cycleRoot), cycleRoot, path.join(cycleRoot, 'state.json'), path.join(cycleRoot, 'artifacts')]) if (fs.existsSync(candidate)) {
    const relative = path.relative(fs.realpathSync(store.workspaceRoot), fs.realpathSync(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(candidate).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'cycle storage must remain in the selected store');
  }
  if (fs.existsSync(path.join(cycleRoot, 'artifacts'))) for (const entry of fs.readdirSync(path.join(cycleRoot, 'artifacts'), { withFileTypes: true })) if (!entry.isFile() || entry.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'cycle artifacts must be regular immutable files');
  const cycles = new ResearchCycleStore(store.workspaceRoot, researchId), service = new ResearchCycleService({ workspaceRoot: store.workspaceRoot, bootstrapStore: store, resolver: workspacePaperResolver(workspace) });
  const cycleActor = { identity: actor.actorId, kind: userAction ? 'user' as const : 'agent' as const, actionId: typeof value.operationId === 'string' ? value.operationId : null };
  const integer = (key: string) => { const number = value[key]; if (!Number.isSafeInteger(number) || (number as number) < 0) throw new ResearchCoreError('INVALID_INPUT', `${key} must be a nonnegative integer`); return number as number; };
  const text = (key: string) => { const result = value[key]; if (typeof result !== 'string' || !result.trim() || result.length > 200) throw new ResearchCoreError('INVALID_INPUT', `${key} required, at most 200 characters`); return result; };
  if (action === 'prepare') {
    const result = service.prepareExternalCycle(cycleActor, { commandId: text('operationId'), researchId, selectedIdeaId: text('ideaId'), nodeId: value.nodeId as string | undefined, sourceIds: value.sourceIds as string[] | undefined, taskDraftId: value.taskDraftId as string | undefined, authorize: true, expectedBootstrapRevision: integer('baseRevision'), expectedCycleRevision: integer('cycleRevision') });
    return { ok: true, ...result, mode: 'external_handoff', reviewMode: 'self_review', message: '外部交接已准备；尚无 Agent 接单，不是原生 Team 运行。' };
  }
  const runId = text('runId'), run = cycles.readStateOrEmpty().runs.find((r) => r.runId === runId);
  if (!run?.externalHandoff) throw new ResearchCoreError('INVALID_INPUT', 'run was not explicitly authorized as an external handoff');
  const write = () => ({ runId, stepId: text('stepId'), attemptId: text('attemptId') });
  if (action === 'claim') {
    const claimed = service.claimExternalStep(cycleActor, { researchId, ...write(), expectedCycleRevision: integer('cycleRevision') });
    const role = claimed.step.role;
    return { ok: true, ...claimed, outputContract: { schemaVersion: 1, kind: CYCLE_ROLE_REGISTRY[role].outputKind, ...(run.mode === 'general' ? { researchMode: 'general' } : {}), requiredFields: (run.mode === 'general' ? GENERAL_CYCLE_FIELDS : PAPER_FIELDS)[role], ...(role === 'reviewer' ? { graphPatchFormat: 'addNodes entries: {nodeId:unique ASCII stable id,kind:next_action,title:string,sourceNodeId:existing base node id or null,artifactRef:null,note:string|null}; addEdges entries: {edgeId:unique stable id,from:existing or added node id,to:existing or added node id,relation:depends_on|derived_from}; branchDecisions entries: {targetNodeId:existing node id,decision:keep|pause|reject|needs_validation,reason:string}. Propose only justified future work, never observed results. Empty arrays are valid.' } : {}), reviewMode: 'self_review', sourceRule: 'Use only assigned refs. Unknowns remain gaps. Do not invent observations or independent review.' } };
  }
  if (action === 'input') return { ok: true, ...service.readCycleInput(cycleActor, { researchId, runId, stepId: text('stepId'), inputRef: value.inputRef }) };
  if (action === 'publish') return { ok: true, ref: service.publishCycleArtifact(cycleActor, researchId, { ...write(), kind: value.kind as never, payload: value.payload as Record<string, unknown> }), cycleRevision: cycles.readStateOrEmpty().revision, reviewMode: 'self_review' };
  if (action === 'submit') return { ok: true, ...service.submitStepResult(cycleActor, researchId, { ...write(), commandId: text('operationId'), expectedCycleRevision: integer('cycleRevision'), outputRefs: value.outputRefs as never }) };
  if (action === 'fail') return { ok: true, ...service.failExternalStep(cycleActor, { researchId, ...write(), code: text('code'), message: typeof value.message === 'string' ? value.message : '' }) };
  if (action === 'cancel') return { ok: true, ...await service.cancelCycle(cycleActor, { commandId: text('operationId'), researchId, runId, expectedCycleRevision: integer('cycleRevision') }), remoteProcessStopVerified: false };
  if (action === 'adopt_action') return { ok: true, ...service.adoptDecisionAction(cycleActor, researchId, { commandId: text('operationId'), runId, actionId: text('actionId'), decisionRef: value.decisionRef as never, expectedCycleRevision: integer('cycleRevision'), authorize: true }), reviewMode: 'self_review' };
  const coordinator = { ...cycleActor, kind: 'coordinator' as const };
  if (action === 'retry') return { ok: true, ...service.retryStep(coordinator, researchId, { commandId: text('operationId'), runId, stepId: text('stepId'), expectedCycleRevision: integer('cycleRevision'), expectedBootstrapRevision: integer('baseRevision'), authorize: true }) };
  return { ok: true, ...service.applyCycleDecision(coordinator, researchId, { commandId: text('operationId'), runId, decisionRef: value.decisionRef as never, expectedCycleRevision: integer('cycleRevision') }), reviewMode: 'self_review' };
}
