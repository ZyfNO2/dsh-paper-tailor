import * as os from 'node:os';
import { legacyResearchAction, legacyScope } from './legacy-domain.ts';
import { initializeActiveStore } from './active-store.ts';
import { ResearchCoreError, validateActorContext, type ActorContext } from '../../research-contracts/src/index.ts';
import { TakeoverService } from '../../evolver/src/application/takeover-service.ts';
import { TakeoverAdoptionService } from '../../evolver/src/application/takeover-adoption.ts';
import { launchResearchGeneration } from './generation-launcher.ts';
import { configuredWorkspacePdfReader } from './legacy-papers.ts';

/** Async scans share the same scope, CAS and actor boundary as synchronous workbench actions. */
export async function legacyAsyncResearchAction(workspace: string, body: Record<string, unknown>, actor?: ActorContext) {
  if (body && ['generate_brainstorm', 'initialize_research_graph'].includes(body.type as string)) return launchResearchGeneration(workspace, body, actor);
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.type !== 'string' || !body.type.startsWith('takeover_')) return legacyResearchAction(workspace, body, actor);
  const supported = ['takeover_start', 'takeover_refresh', 'takeover_snapshot', 'takeover_bind_research', 'takeover_freshness', 'takeover_adopt'];
  if (!supported.includes(body.type)) throw new ResearchCoreError('INVALID_INPUT', `UNSUPPORTED_ACTION: ${body.type}`);
  for (const key of ['actor', 'identity', 'actorId', 'workspaceRoot', 'workspaceDir', 'sourceWorkspaceRoot', 'ownerSessionId', 'modelIdentity', 'readPdfText', 'pdfModulePath', 'RESEARCH_PDFJS_MODULE']) if (key in body) throw new ResearchCoreError('INVALID_INPUT', `${key} is supplied by trusted transport`);
  if (actor && validateActorContext(actor).kind !== 'user' && !['takeover_start', 'takeover_refresh', 'takeover_snapshot', 'takeover_freshness'].includes(body.type)) throw new ResearchCoreError('INVALID_INPUT', 'agent cannot adopt or bind research');
  if (typeof body.operationId !== 'string' || !body.operationId.trim() || body.operationId.length > 200 || !Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0) throw new ResearchCoreError('INVALID_INPUT', 'operationId and nonnegative baseRevision required');
  const { store, readOnly } = legacyScope(workspace);
  if (readOnly) throw new ResearchCoreError('INVALID_INPUT', 'MIGRATION_REQUIRED: migrate old assets before writing');
  const write = { operationId: body.operationId, baseRevision: body.baseRevision as number }, identity = actor?.actorId ?? `local-user:${os.userInfo().username}`;
  const options = { sourceWorkspaceRoot: workspace, readPdfText: configuredWorkspacePdfReader() }, service = new TakeoverService(store, options);
  if (body.type === 'takeover_start') {
    if (!Array.isArray(body.roots) || body.roots.some((r) => typeof r !== 'string')) throw new ResearchCoreError('INVALID_INPUT', 'roots must be a string array');
    initializeActiveStore(workspace);
    return service.start({ ...write, roots: body.roots as string[], title: body.title as string | undefined, scopeNote: body.scopeNote as string | undefined, researchId: body.researchId as string | null | undefined }, identity);
  }
  if (typeof body.takeoverId !== 'string' || !body.takeoverId) throw new ResearchCoreError('INVALID_INPUT', 'takeoverId required');
  const takeoverId = body.takeoverId;
  if (body.type === 'takeover_refresh') return service.refresh({ ...write, takeoverId }, identity);
  if (body.type === 'takeover_snapshot') return service.saveSnapshot({ ...write, takeoverId, snapshot: body.snapshot as Parameters<typeof service.saveSnapshot>[0]['snapshot'], modelIdentity: actor?.kind === 'agent' ? { agentIdentity: identity, modelIdentity: 'external_model_unverified' } : null }, identity);
  if (body.type === 'takeover_bind_research') return service.bindResearch({ ...write, takeoverId, researchId: body.researchId as string }, identity);
  if (body.type === 'takeover_freshness') return { revision: store.readStateOrEmpty().revision, replayed: false, result: { ...service.checkFreshness(takeoverId) } };
  const adopted = await new TakeoverAdoptionService(store, options).adopt({ ...write, takeoverId, researchId: typeof body.researchId === 'string' ? body.researchId : null, items: body.items as Parameters<TakeoverAdoptionService['adopt']>[0]['items'], relations: body.relations as Parameters<TakeoverAdoptionService['adopt']>[0]['relations'] }, identity);
  return { revision: store.readStateOrEmpty().revision, replayed: adopted.reused, result: { ...adopted } };
}
