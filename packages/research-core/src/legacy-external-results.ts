import * as fs from 'node:fs';
import * as os from 'node:os';
import { ExternalResultService, type ExternalResultInput, type ExternalReviewInput, type ExternalDecisionInput, type ExternalResultUserAction } from '../../evolver/src/application/external-result-service.ts';
import { GeneralMaterialStore } from '../../evolver/src/application/general-material-store.ts';
import { assertGeneralSourceAccess } from '../../evolver/src/application/general-source-access.ts';
import { ResearchCoreError, validateActorContext, type ActorContext } from '../../research-contracts/src/index.ts';
import { legacyScope } from './legacy-domain.ts';

export const EXTERNAL_RESULT_ACTIONS = ['register_external_result', 'review_external_results', 'decide_external_result'];
const fields: Record<string, string[]> = {
  register_external_result: ['relativePath','nature','label','externalRunId','clarification','values','failureQuote','conditions'],
  review_external_results: ['reportIds','judgment','boundary','support','counterEvidence','gaps','nextActions'],
  decide_external_result: ['reviewId','actionIndex','choice','utterance','modifiedTitle','authorize'],
};
export function legacyExternalResultAction(workspace: string, body: Record<string, unknown>, actor?: ActorContext) {
  workspace = fs.realpathSync(workspace);
  if (typeof body.operationId !== 'string' || !body.operationId.trim() || body.operationId.length > 200 || !Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0 || typeof body.researchId !== 'string' || !body.researchId.trim()) throw new ResearchCoreError('INVALID_INPUT', 'External result operation/research ID and nonnegative baseRevision required');
  const type = body.type as string, allowed = ['type','operationId','baseRevision','researchId',...(fields[type] ?? [])];
  if (!fields[type] || Object.keys(body).some(key => !allowed.includes(key))) throw new ResearchCoreError('INVALID_INPUT', 'Unexpected external result field; identity, source root and provenance are transport-owned');
  const caller = actor ? validateActorContext(actor) : { actorId: `local-user:${os.userInfo().username}`, kind: 'user' as const, source: 'http' as const };
  const { store, readOnly } = legacyScope(workspace);
  if (readOnly) throw new ResearchCoreError('INVALID_INPUT', 'MIGRATION_REQUIRED: external results require the active store');
  const service = new ExternalResultService(store, { sourceWorkspaceRoot: workspace });
  const userAction = (text: string): ExternalResultUserAction => {
    if (caller.kind !== 'user' || !['http','cli'].includes(caller.source)) throw new ResearchCoreError('INVALID_INPUT', 'An explicit HTTP/CLI user operation is required; an MCP agent cannot clarify or adopt');
    return { kind: 'user_action', identity: caller.actorId, actionId: body.operationId as string, source: caller.source as 'http'|'cli', text };
  };
  if (type === 'register_external_result') {
    if (typeof body.relativePath !== 'string' || body.relativePath.replace(/\\/g,'/').split('/').some(part => ['.research','.dsh','.git','.codex','.claude','.agents','.aws','.ssh','.env'].includes(part.toLowerCase()) || part.toLowerCase().startsWith('.env.'))) throw new ResearchCoreError('INVALID_INPUT', 'Result path cannot read internal stores, client settings or credentials');
    const clarification = typeof body.clarification === 'string' ? body.clarification.trim() : '';
    const { type: _type, ...input } = body;
    return service.register(input as unknown as ExternalResultInput, clarification ? userAction(clarification) : null);
  }
  if (type === 'review_external_results') {
    if (caller.kind !== 'agent' || caller.source !== 'mcp') throw new ResearchCoreError('INVALID_INPUT', 'Submit model suggestions through the external MCP client; a manual user review must not be labeled as model output');
    const { type: _type, ...input } = body;
    return service.review(input as unknown as ExternalReviewInput, caller.actorId);
  }
  if (body.authorize !== true || typeof body.utterance !== 'string') throw new ResearchCoreError('INVALID_INPUT', 'Explicit user decision text and authorize:true required');
  const { type: _type, authorize: _authorize, ...input } = body;
  return service.decideFromUser(input as unknown as ExternalDecisionInput, userAction(body.utterance));
}
export function externalResultProjection(workspace: string, researchId: string, offset = 0, limit = 20) {
  const { store } = legacyScope(workspace), state = store.readStateOrEmpty(), research = state.researches.find(item => item.researchId === researchId);
  if (!research?.general) throw new ResearchCoreError('INVALID_INPUT', 'External results require an existing general research');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ResearchCoreError('INVALID_INPUT', 'offset >= 0 and limit 1-100 required');
  const general = research.general, service = new ExternalResultService(store, { sourceWorkspaceRoot: workspace });
  const reports = [...general.metricReports].reverse().filter(report => report.match).slice(offset, offset + limit), reviews = [...general.resultReviews].reverse().slice(offset, offset + limit);
  const sourceIds = new Set([...reports.map(report => report.sourceId), ...reviews.flatMap(review => review.reportIds.map(id => { const report = general.metricReports.find(report => report.reportId === id); if (!report) throw new ResearchCoreError('STATE_CORRUPT', 'External review references a missing report'); return report.sourceId; }))]);
  for (const sourceId of sourceIds) { assertGeneralSourceAccess(general, sourceId); new GeneralMaterialStore(store.workspaceRoot).readRaw(general.sources.find(source => source.sourceId === sourceId)!); }
  return { schemaVersion: 1, researchId, revision: state.revision, offset, limit, reviewMode: 'self_review', modelIdentity: null, reports, reviews: reviews.map(review => ({ ...review, freshness: service.reviewFreshness(researchId, review.reviewId) })), decisions: [...general.resultDecisions].reverse().slice(offset, offset + limit), boundary: '外部已有文件与建议；不是本系统执行、独立Reviewer或已验证科研收益。审批由用户HTTP/CLI显式完成。' };
}
