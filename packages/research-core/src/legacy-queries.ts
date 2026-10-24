import { GeneralDataService } from '../../evolver/src/application/general-data-service.ts';
import { GeneralWikiService } from '../../evolver/src/application/general-wiki-service.ts';
import { GeneralKnowledgeService } from '../../evolver/src/application/general-knowledge-service.ts';
import { GeneralAnalysisService } from '../../evolver/src/application/general-analysis-service.ts';
import { GeneralInferenceService } from '../../evolver/src/application/general-inference-service.ts';
import { GeneralReportService } from '../../evolver/src/application/general-report-service.ts';
import { assertGeneralSourceAccess } from '../../evolver/src/application/general-source-access.ts';
import { PaperLibrary } from '../../evolver/src/application/paper-library.ts';
import { legacyScope } from './legacy-domain.ts';
import { TakeoverService } from '../../evolver/src/application/takeover-service.ts';
import { GeneralPackageService } from '../../evolver/src/application/general-package-service.ts';
import { readPrototypeHistory } from './prototype-migration.ts';
import { readWorkspaceCycle } from './legacy-cycle.ts';
import { externalResultProjection } from './legacy-external-results.ts';
import { searchHistory } from './legacy-search.ts';
import { ResearchFoundationsService } from '../../evolver/src/application/research-foundations-service.ts';

export function legacyQuery(workspaceDir: string, route: string, query: URLSearchParams): { json?: unknown; bytes?: Buffer; filename?: string; mediaType?: string } {
  const { store } = legacyScope(workspaceDir);
  if (route === 'prototype-history') return { json: readPrototypeHistory(workspaceDir) };
  const required = (key: string) => { const value = query.get(key); if (!value) throw new Error(`${key} required`); return value; };
  const number = (key: string) => { const value = query.get(key); if (value === null) return undefined; const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw new Error(`invalid ${key}`); return n; };
  if (route === 'takeover') {
    const takeover = new TakeoverService(store, { sourceWorkspaceRoot: workspaceDir });
    const id = query.get('takeoverId');
    return { json: id ? takeover.projection(id) : { takeovers: takeover.list().map((r) => ({ takeoverId: r.takeoverId, title: r.title, roots: r.roots, scopeNote: r.scopeNote, status: r.status, researchId: r.researchId, revision: r.snapshot.revision, updatedAt: r.updatedAt, firstError: r.firstError })) } };
  }
  const researchId = required('researchId');
  if (route === 'literature-searches') return { json: searchHistory(new ResearchFoundationsService(store), researchId, query) };
  if (route === 'external-results') return { json: externalResultProjection(workspaceDir, researchId, number('offset') ?? 0, number('limit') ?? 20) };
  if (route === 'cycle') return { json: readWorkspaceCycle(workspaceDir, researchId, query) };
  if (route === 'package') {
    const packages = new GeneralPackageService(store), importId = query.get('importId');
    return { json: importId ? packages.readImportedHistory(researchId, importId) : packages.export(researchId) };
  }
  if (route === 'research' || route === 'graph') {
    const state = store.readStateOrEmpty(), research = state.researches.find((r) => r.researchId === researchId);
    if (!research) throw new Error('researchId is not in this workspace');
    if (route === 'graph') return { json: { revision: state.revision, researchId, graph: research.general?.graph ?? research.graph } };
    const offset = number('offset') ?? 0, limit = number('limit') ?? 20;
    if (limit < 1 || limit > 100) throw new Error('limit must be 1–100');
    const knowledge = research.general?.knowledge ?? [];
    const latest = knowledge.filter((k) => !knowledge.some((other) => other.entryId === k.entryId && other.version > k.version));
    return { json: { revision: state.revision, researchId, title: research.title, contract: research.contract, offset, limit,
      sources: (research.general?.sources ?? []).slice(offset, offset + limit), knowledge: latest.slice(offset, offset + limit),
      ideas: (research.general?.ideas ?? research.ideas).slice(offset, offset + limit),
      wikiTasks: (research.general?.wiki?.tasks ?? []).slice(offset, offset + limit) } };
  }
  if (route === 'wiki-task') return { json: new GeneralWikiService(store).taskContext(researchId, required('taskId')) };
  if (route === 'wiki') {
    const wiki = new GeneralWikiService(store);
    switch (query.get('op')) {
      case 'source': return { json: wiki.source(researchId, required('sourceId')) };
      case 'lint': return { json: wiki.lint(researchId) };
      case 'okf': return { json: wiki.exportOkf(researchId) };
      case 'papers': return { json: { papers: new PaperLibrary(path.join(store.workspaceRoot, '.dsh/research/papers'), workspaceDir).list(workspaceDir).map((p) => ({ paperId: p.id, title: p.title, revision: p.revision, sha256: p.sha256, sections: p.sections })) } };
      default: throw new Error('unsupported Wiki operation');
    }
  }
  if (route === 'knowledge-graph' || route === 'export') return { json: new GeneralKnowledgeService(store).export(researchId, query.get('includeRaw') === 'true') };
  if (route === 'data') return { json: { schemaVersion: 1, scope: 'workspace-files', preview: new GeneralDataService(store).preview({ researchId, sourceId: query.get('sourceId') ?? undefined, datasetId: query.get('datasetId') ?? undefined, tableId: query.get('tableId') ?? undefined, version: number('version'), offset: number('offset'), limit: number('limit') }) } };
  if (route === 'source') {
    const research = store.readStateOrEmpty().researches.find((r) => r.researchId === researchId);
    const source = research?.general?.sources.find((s) => s.sourceId === required('sourceId'));
    if (!source || !research?.general) throw new Error('SOURCE_MISSING');
    assertGeneralSourceAccess(research.general, source.sourceId);
    return { bytes: new GeneralDataService(store).materials.readRaw(source), filename: source.filename, mediaType: query.get('inline') === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(source.mediaType) ? source.mediaType : 'application/octet-stream' };
  }
  const result = route === 'calculation' ? new GeneralAnalysisService(store).readCalculation(researchId, required('calculationId'))
    : route === 'inference' ? new GeneralInferenceService(store).read(researchId, required('runId'))
    : route === 'report' ? new GeneralReportService(store).read(researchId, required('packId'), number('version')) : undefined;
  if (result === undefined) throw new Error(`UNSUPPORTED_ROUTE: ${route}`);
  return { json: { schemaVersion: 1, scope: 'workspace-files', result } };
}
import * as path from 'node:path';
