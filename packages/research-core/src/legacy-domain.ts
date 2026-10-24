import * as fs from 'node:fs';
import * as path from 'node:path';
import { ResearchBootstrapStore } from '../../evolver/src/application/research-bootstrap-store.ts';
import { GeneralResearchService } from '../../evolver/src/application/general-research-service.ts';
import { GeneralMetricService } from '../../evolver/src/application/general-metric-service.ts';
import { GeneralEvidenceService } from '../../evolver/src/application/general-evidence-service.ts';
import { GeneralReportService } from '../../evolver/src/application/general-report-service.ts';
import { analysisProjection } from '../../evolver/src/application/general-analysis-service.ts';
import { generalNodeStates } from '../../evolver/src/application/general-workflow-service.ts';
import { DATA_LIMITS } from '../../evolver/src/contracts/general-data.ts';
import { ResearchCoreError, validateActorContext, type ActorContext } from '../../research-contracts/src/index.ts';
import { generalAction } from './legacy-actions.ts';
import { DESCRIPTIVE_TOOL, ANALYSIS_LIMITS } from '../../evolver/src/application/general-descriptive.ts';
import { activeStore, initializeActiveStore, assetRestoreSummary } from './active-store.ts';
import { GeneralPackageService, validateGeneralPortablePackage } from '../../evolver/src/application/general-package-service.ts';
import * as os from 'node:os';
import { createGeneralExample } from '../../evolver/src/application/general-example-service.ts';
import { paperLibraryProjection, paperResearchEvidence } from './legacy-papers.ts';
import type { SlotBindingRef } from '../../evolver/src/contracts/research-bootstrap.ts';
import { readResearchResults } from '../../evolver/src/application/research-result-manifest.ts';
import { PAPER_RESEARCH_ACTIONS, paperResearchAction } from './legacy-paper-research.ts';
import { EXTERNAL_RESULT_ACTIONS, legacyExternalResultAction } from './legacy-external-results.ts';

/** Old assets remain read-only until an explicit migration has selected the new store. */
export function legacyScope(workspaceDir: string) {
  workspaceDir = fs.realpathSync(workspaceDir);
  const realWorkspace = workspaceDir;
  if (fs.existsSync(path.join(workspaceDir, '.research-restore-incomplete.json'))) throw new ResearchCoreError('STATE_CORRUPT', 'Research restore did not complete; inspect the retained stage and first error before using this directory');
  const legacyFile = path.join(workspaceDir, '.dsh/research/bootstrap/state.json');
  const legacyPapers = fs.existsSync(path.join(workspaceDir, '.dsh/research/papers'));
  const activeRoot = path.join(workspaceDir, '.research/compat');
  for (const candidate of [path.join(workspaceDir, '.research'), activeRoot, path.join(activeRoot, '.dsh'), path.join(activeRoot, '.dsh/research'), path.join(workspaceDir, '.dsh/research')]) {
    if (!fs.existsSync(candidate)) continue;
    const relative = path.relative(realWorkspace, fs.realpathSync(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResearchCoreError('PATH_ESCAPE', 'research store redirects outside the workspace');
  }
  const selected = activeStore(workspaceDir);
  if (!selected && fs.existsSync(legacyFile) && fs.existsSync(path.join(activeRoot, '.dsh/research/bootstrap/state.json'))) throw new ResearchCoreError('STATE_CORRUPT', 'ambiguous legacy and compat stores; explicit migration recovery required');
  const migrated = selected !== null;
  const prototypeExists = fs.existsSync(path.join(workspaceDir, '.research/project.json'));
  const readOnly = (fs.existsSync(legacyFile) || legacyPapers || prototypeExists) && !migrated;
  const migrationKind = readOnly ? fs.existsSync(legacyFile) || legacyPapers ? 'dsh' : 'prototype' : null;
  return { store: new ResearchBootstrapStore(readOnly ? workspaceDir : activeRoot), readOnly, activeRoot, migrationKind };
}

export function readLegacyWorkbench(workspaceDir: string) {
  workspaceDir = fs.realpathSync(workspaceDir);
  const { store, readOnly, migrationKind } = legacyScope(workspaceDir);
  const state = store.readStateOrEmpty();
  const active = state.researches.find((r) => r.researchId === state.activeResearchId);
  const papers = paperLibraryProjection(workspaceDir).papers;
  const observed = readResearchResults(store.workspaceRoot, state);
  const token = (ref: SlotBindingRef) => ref.kind === 'design_idea' ? `idea:${ref.ideaId}@${ref.contentRevision}@${ref.contentHash}` : `paper:${ref.paperId}:${ref.componentIndex}@${ref.assetRevision}@${ref.contentHash}`;
  const slots = (active?.graph?.slots ?? []).map((slot) => {
    const graph = active!.graph!;
    const owner = graph.nodes.find((n) => n.snapshotRef !== null && graph.snapshots.find((s) => s.snapshotId === n.snapshotRef)?.bindings[slot.slotId] !== undefined) ?? graph.nodes.find((n) => n.kind === 'baseline');
    const snapshot = graph.snapshots.find((s) => s.snapshotId === owner?.snapshotRef), bound = snapshot?.bindings[slot.slotId];
    return { ...slot, nodeId: owner?.nodeId ?? null, lockedBy: slot.lockedBy?.actorIdentity ?? null, boundRef: bound ? { token: token(bound), kind: bound.kind, label: bound.kind === 'design_idea' ? bound.title : bound.name } : null,
      candidates: slot.candidates.map((c) => ({ token: token(c.ref), kind: c.ref.kind, label: c.ref.kind === 'design_idea' ? c.ref.title : c.ref.name, assessment: c.assessment, reason: c.reason, missingInterface: c.missingInterface, incompatibleReason: c.assessment === 'incompatible' ? c.reason : null })), snapshot: snapshot ? { snapshotId: snapshot.snapshotId, revision: snapshot.revision } : null };
  });
  return {
    schemaVersion: 1, scope: 'workspace-files', restoredAssetBackup: assetRestoreSummary(workspaceDir), workspace: { id: workspaceDir, title: path.basename(workspaceDir) },
    papersRevision: `${papers.length}:${papers.map((p) => `${p.id}@${p.revision ?? 'null'}`).join(',')}`, papers, generatedAt: new Date().toISOString(), readOnly, migrationKind,
    historicalPrototype: !readOnly && fs.existsSync(path.join(store.workspaceRoot, 'prototype-original/project.json')),
    bootstrap: {
      revision: state.revision, activeResearchId: state.activeResearchId, dataLimits: DATA_LIMITS,
      calculationCapability: { available: true, ...DESCRIPTIVE_TOOL, methods: ['descriptive', 'grouped_descriptive', 'repeated_summary'], limits: ANALYSIS_LIMITS },
      executionCapabilities: { descriptive: { available: true, tool: DESCRIPTIVE_TOOL }, statisticalInference: { available: true, tool: { name: 'dsh-student-t', version: '1.0.0' } }, simulation: { available: false, reason: '未接仿真执行器' }, instrument: { available: false, reason: '未接仪器' }, training: { available: false, reason: '独立工作台不直接启动训练' } },
      researches: state.researches.map((r) => ({ ...r, evidence: paperResearchEvidence(workspaceDir, r.researchId), ...(r.general ? {
        general: r.general, metrics: new GeneralMetricService(store).projection(r.researchId, state),
        knowledgeEvidence: new GeneralEvidenceService(store).projection(r.researchId, state),
        reports: new GeneralReportService(store).projection(r.researchId, state),
        analysis: analysisProjection(r.general), workflow: generalNodeStates(r.general),
      } : {}) })),
      graph: active?.graph ?? null, slots, selectedIdeaIds: active?.ideas.filter((i) => i.status === 'selected').map((i) => i.ideaId) ?? [],
      observedResults: observed.results, resultErrors: observed.errors,
    },
  };
}

export const AGENT_WORKSPACE_ACTIONS = ['register_external_result', 'review_external_results', 'create_general_research', 'save_general_idea', 'import_general_material', 'save_general_dictionary', 'save_general_knowledge', 'save_general_knowledge_relation', 'save_general_knowledge_layout', 'save_general_wiki_board', 'start_general_wiki_task', 'publish_general_wiki_task', 'save_general_node', 'save_general_edge', 'save_general_analysis_plan', 'save_general_inference_plan', 'save_general_metric_protocol', 'save_general_team_task'];

export function legacyResearchAction(workspaceDir: string, body: Record<string, unknown>, actor?: ActorContext) {
  workspaceDir = fs.realpathSync(workspaceDir);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ResearchCoreError('INVALID_INPUT', 'action body must be an object');
  for (const key of ['actor', 'identity', 'workspaceRoot', 'workspaceDir', 'actorId', 'ownerSessionId']) if (key in body) throw new ResearchCoreError('INVALID_INPUT', `${key} is supplied by trusted transport`);
  const agentPaperActions = ['start_research', 'save_research_contract', 'edit_research_idea', 'begin_research_brainstorm', 'fail_research_brainstorm', 'publish_research_ideas', 'publish_research_graph'];
  if (actor && validateActorContext(actor).kind !== 'user' && !AGENT_WORKSPACE_ACTIONS.includes(body.type as string) && !agentPaperActions.includes(body.type as string)) throw new ResearchCoreError('INVALID_INPUT', 'agent workspace actions cannot approve, confirm, execute or change source access');
  const { store, readOnly, activeRoot } = legacyScope(workspaceDir);
  if (readOnly) throw new ResearchCoreError('INVALID_INPUT', 'MIGRATION_REQUIRED: 旧研究只读，必须完成显式迁移才能写入。');
  if (typeof body.operationId !== 'string' || !Number.isSafeInteger(body.baseRevision)) throw new ResearchCoreError('INVALID_INPUT', 'operationId and integer baseRevision are required');
  if (EXTERNAL_RESULT_ACTIONS.includes(body.type as string)) return legacyExternalResultAction(workspaceDir, body, actor);
  const service = new GeneralResearchService(store);
  const write = { operationId: body.operationId, baseRevision: body.baseRevision as number };
  if (PAPER_RESEARCH_ACTIONS.includes(body.type as string)) {
    initializeActiveStore(workspaceDir);
    return paperResearchAction(workspaceDir, store, body, actor?.actorId ?? `local-user:${os.userInfo().username}`, actor);
  }
  if (body.type === 'create_general_example_research') {
    initializeActiveStore(workspaceDir);
    return createGeneralExample(store, write);
  }
  if (body.type === 'import_general_portable_package') {
    // Validate the complete archive before choosing an empty workspace's authority.
    // The service validates again under its normal import/CAS path.
    const packages = new GeneralPackageService(store);
    validateGeneralPortablePackage(body.package);
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 300) throw new ResearchCoreError('INVALID_INPUT', 'import title must be non-empty text of at most 300 characters');
    initializeActiveStore(workspaceDir);
    return packages.import({ ...write, title: body.title as string, package: body.package }, actor?.actorId ?? `local-user:${os.userInfo().username}`);
  }
  // Only trusted transport scope selects workspace, actor and operation kind.
  if (body.type === 'create_general_research') {
    initializeActiveStore(workspaceDir);
    fs.mkdirSync(activeRoot, { recursive: true });
    return service.create({ ...write, title: body.title as string, question: body.question as string, domains: body.domains as string[], methods: body.methods as never, entryMode: body.entryMode as never });
  }
  if (body.type === 'select_research' || body.type === 'select_general_research') return service.select({ ...write, researchId: body.researchId as string });
  if (body.type === 'save_general_layout') return service.saveLayout({ ...write, researchId: body.researchId as string, positions: body.positions as Parameters<typeof service.saveLayout>[0]['positions'] });
  if (body.type === 'save_general_idea') return service.saveIdea({ ...write, researchId: body.researchId as string, ideaId: body.ideaId as string, question: body.question as string, rationale: body.rationale as string, verificationPlan: body.verificationPlan as string, sourceRefs: body.sourceRefs as string[] });
  return generalAction(store, body, actor?.actorId);
}
