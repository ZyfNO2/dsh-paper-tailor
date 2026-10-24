import * as os from 'node:os';
import { legacyScope } from './legacy-domain.ts';
import { ResearchCoreError, validateActorContext, type ActorContext } from '../../research-contracts/src/index.ts';
import { ResearchFoundationsService, type FoundationCommand } from '../../evolver/src/application/research-foundations-service.ts';
import { ResearchExecutionRuntime, type RuntimeOptions } from '../../evolver/src/application/research-execution-runtime.ts';
import { ResearchArtifacts } from '../../evolver/src/application/research-artifacts.ts';
import { LiteratureConnector } from '../../evolver/src/application/research-literature.ts';
import { runLiteratureSearch, searchSummary, cancelSearch } from './legacy-search.ts';
import { record, id, text, choice } from '../../evolver/src/contracts/research-foundations.ts';

export interface FoundationOptions {
  runtime?: RuntimeOptions;
  openalexKey?: string; semanticScholarKey?: string; grobidEndpoint?: string;
  paperqaEnabled?: boolean; rscript?: string; latexmk?: string; statisticsImage?: string;
  literatureFetch?: typeof fetch;
}
/** Configuration belongs to the launching process, never to an action payload. */
export function foundationOptionsFromEnvironment(): FoundationOptions {
  return { runtime: { python: process.env.RESEARCH_PYTHON, docker: process.env.RESEARCH_DOCKER }, rscript: process.env.RESEARCH_RSCRIPT, latexmk: process.env.RESEARCH_LATEXMK,
    openalexKey: process.env.OPENALEX_API_KEY, semanticScholarKey: process.env.SEMANTIC_SCHOLAR_API_KEY, grobidEndpoint: process.env.RESEARCH_GROBID_ENDPOINT, paperqaEnabled: process.env.RESEARCH_PAPERQA_ENABLED === '1' };
}
const defaults = foundationOptionsFromEnvironment();
const capabilityCache = new WeakMap<FoundationOptions, { at: number; value: ReturnType<ResearchExecutionRuntime['doctor']> }>();
function services(workspace: string, options: FoundationOptions, writing = false) {
  const { store, readOnly } = legacyScope(workspace);
  if (writing && readOnly) throw new ResearchCoreError('INVALID_INPUT', 'MIGRATION_REQUIRED: foundations writes require the active store');
  const service = new ResearchFoundationsService(store), runtime = new ResearchExecutionRuntime(service, options.runtime);
  const artifacts = new ResearchArtifacts(service, { python: options.runtime?.python, docker: options.runtime?.docker, rscript: options.rscript, latexmk: options.latexmk, statisticsImage: options.statisticsImage });
  return { service, runtime, artifacts };
}
export function foundationSnapshot(workspace: string, researchId: string, options = defaults, capabilities = true) {
  const { service, runtime } = services(workspace, options), snapshot = { ...service.snapshot(id(researchId)), literature: searchSummary(service, researchId) };
  if (!capabilities) return snapshot;
  let cached = capabilityCache.get(options);
  if (!cached || Date.now() - cached.at > 60000) { cached = { at: Date.now(), value: runtime.doctor() }; capabilityCache.set(options, cached); }
  return { ...snapshot, capabilities: { ...cached.value, checkedAt: new Date(cached.at).toISOString(), grobid: !!options.grobidEndpoint, paperqa: options.paperqaEnabled === true } };
}
export function foundationArtifact(workspace: string, researchId: string, query: URLSearchParams, options = defaults) {
  const { runtime, artifacts } = services(workspace, options), kind = query.get('kind'), key = id(query.get('key')), name = text(query.get('name'), 'name', 200), digest = text(query.get('sha256'));
  const bytes = kind === 'jobs' ? runtime.artifact(id(researchId), key, name, digest)
    : artifacts.read(id(researchId), choice(kind, ['figures', 'analyses', 'reviews', 'reports', 'parses']), key, name, digest);
  return { bytes, filename: name, mediaType: 'application/octet-stream' };
}
export async function foundationAction(workspace: string, researchId: string, value: Record<string, unknown>, actor?: ActorContext, options = defaults) {
  if (actor) validateActorContext(actor);
  const identity = actor?.actorId ?? `local-user:${os.userInfo().username}`, human = !actor || actor.kind === 'user';
  const { service, runtime, artifacts } = services(workspace, options, true), action = text(value.action, 'action', 100);
  researchId = id(researchId);
  // Validate the research namespace before a provider request or worker side effect.
  service.snapshot(researchId);
  let result: unknown;
  if (action === 'search_literature') {
    record(value, ['action', 'provider', 'query', 'page']);
    result = await runLiteratureSearch(service, researchId, value as { provider: unknown; query: unknown; page?: unknown }, actor ?? { actorId: identity, kind: 'user', source: 'http' }, { openalexKey: options.openalexKey, semanticScholarKey: options.semanticScholarKey, fetch: options.literatureFetch });
  } else if (action === 'cancel_search') {
    record(value, ['action', 'attemptId', 'authorize']);
    if (!human || value.authorize !== true) throw new ResearchCoreError('INVALID_INPUT', 'explicit user authorization required');
    result = cancelSearch(service, researchId, id(value.attemptId), actor ?? { actorId: identity, kind: 'user', source: 'http' });
  } else if (action === 'parse_source' || action === 'query_papers') {
    record(value, ['action', 'sourceId', 'sourceIds', 'question', 'authorize']);
    if (!human || value.authorize !== true) throw new ResearchCoreError('INVALID_INPUT', 'explicit user authorization required');
    if (action === 'parse_source') {
      if (!options.grobidEndpoint) throw new ResearchCoreError('INVALID_INPUT', 'GROBID endpoint is not configured');
      result = await artifacts.parse(researchId, id(value.sourceId), options.grobidEndpoint);
    } else {
      if (!options.paperqaEnabled) throw new ResearchCoreError('INVALID_INPUT', 'PaperQA worker is not enabled/configured');
      result = artifacts.queryPapers(researchId, value.sourceIds as string[], text(value.question));
    }
  } else if (['submit_job', 'cancel_job', 'reconcile_job', 'generate_figure', 'analyze', 'compile_report', 'export_review', 'rank_screening', 'verify_citations', 'render_review'].includes(action)) {
    record(value, ['action', 'jobId', 'parentId', 'spec', 'authorize', 'tool']);
    if (!human || action !== 'reconcile_job' && value.authorize !== true) throw new ResearchCoreError('INVALID_INPUT', 'explicit user authorization required');
    if (action === 'submit_job') result = runtime.submit(researchId, id(value.jobId));
    else if (action === 'cancel_job') result = runtime.cancel(researchId, id(value.jobId));
    else if (action === 'reconcile_job') result = runtime.reconcile(researchId, id(value.jobId));
    else if (action === 'generate_figure') result = artifacts.figure(researchId, id(value.jobId), value.parentId == null ? null : id(value.parentId));
    else if (action === 'analyze') result = artifacts.analyze(researchId, value.spec);
    else if (action === 'compile_report') result = artifacts.manuscript(researchId);
    else if (action === 'export_review') result = artifacts.reviewExport(researchId);
    else if (action === 'verify_citations') result = await artifacts.verifyCitations(researchId, new LiteratureConnector(options));
    else if (action === 'render_review') result = artifacts.renderReview(researchId, choice(value.tool, ['PRISMA', 'ROB2', 'ROBINS-I']));
    else result = artifacts.rank(researchId);
  } else {
    record(value, ['action', 'operationId', 'baseRevision', 'payload']);
    result = service.command({ researchId, action, operationId: value.operationId, baseRevision: value.baseRevision, payload: value.payload } as FoundationCommand, { identity, human });
  }
  return { ok: true, result, revision: service.store.readStateOrEmpty().revision };
}
