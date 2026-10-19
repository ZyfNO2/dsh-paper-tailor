import { validateInferencePlan, validateInferenceRun, type InferencePlan, type InferenceRun } from './general-inference-records.ts';
import { validateGeneralImportedHistory, type GeneralImportedHistory } from './general-import.ts';
import { validateMetricProtocol, validateMetricReport, validateMetricIdentityHistory, suggestMetricProtocol, type GeneralMetricProtocol, type GeneralMetricReport } from './general-metrics.ts';
import { validateExternalResultDecision, validateExternalResultReview, type ExternalResultDecision, type ExternalResultReview } from './external-result.ts';
import { validateGeneralKnowledge, type GeneralKnowledgeEntry } from './general-knowledge.ts';
import { emptyWikiWorkspace, validateWikiWorkspace, type WikiWorkspace } from './general-wiki.ts';
import { validateGeneralSourceAccess, type GeneralSourceAccess } from './general-evidence.ts';
import { validateGeneralFactPackRecord, GENERAL_REPORT_LIMITS, type GeneralFactPackRecord } from './general-report.ts';
/** Generic research planning. Legacy paper/algorithm contracts remain unchanged. */
import { validateSource, validateDataset, type MaterialSource, type DatasetVersion } from './general-data.ts';
import { validateAnalysisPlan, validateCalculation, validateGeneralReview, type GeneralAnalysisPlan, type GeneralCalculation, type GeneralReview } from './general-analysis.ts';
import { validateGeneralEditHistory, type GeneralEditHistory, validateGeneralGraph, validateGeneralProfile, validateNodeConfirmation, type GeneralNode, type GeneralEdge, type GeneralGraph, type GeneralProfile, type GeneralNodeConfirmation } from './general-workflow.ts';
import { validateGeneralKnowledgeRelation, type GeneralKnowledgeRelation } from './general-knowledge.ts';
export type { GeneralNode, GeneralEdge } from './general-workflow.ts';
export type { GeneralKnowledgeRelation } from './general-knowledge.ts';
export const GENERAL_METHODS = ['engineering', 'observation', 'algorithm', 'survey', 'review'] as const;
export type GeneralMethod = typeof GENERAL_METHODS[number];
export type SourceNature = 'literature' | 'user_observation' | 'user_result' | 'system_calculation' | 'simulation' | 'hypothesis' | 'inference' | 'unknown';
export interface GeneralIdea {
  ideaId: string;
  revision: number;
  question: string;
  rationale: string;
  verificationPlan: string;
  sourceRefs: string[];
  nature: 'hypothesis';
  updatedAt: string;
}
export interface GeneralResearch {
  inferencePlans: InferencePlan[]; inferenceRuns: InferenceRun[];
  importedHistory: GeneralImportedHistory[];
  editHistory: GeneralEditHistory;
  sourceAccess: GeneralSourceAccess[];
  factPacks: GeneralFactPackRecord[];
  metricProtocols: GeneralMetricProtocol[];
  metricReports: GeneralMetricReport[];
  /** Model suggestions about external results. Distinct from human reviews. */
  resultReviews: ExternalResultReview[];
  /** The user's accept / modify / reject / defer. Distinct from the model suggestion. */
  resultDecisions: ExternalResultDecision[];
  knowledge: GeneralKnowledgeEntry[];
  wiki?: WikiWorkspace;
  requireHumanConfirmation: boolean;
  schemaVersion: 1;
  revision: number;
  domains: string[];
  methods: GeneralMethod[];
  entryMode: 'idea_only' | 'design_first' | 'existing_data';
  reference: { status: 'unknown' | 'applicable' | 'not_applicable'; description: string; reason: string };
  constraints: string[];
  pendingQuestions: string[];
  ideas: GeneralIdea[];
  ideaHistory: GeneralIdea[];
  sources: MaterialSource[];
  datasets: DatasetVersion[];
  plans: GeneralAnalysisPlan[];
  calculations: GeneralCalculation[];
  reviews: GeneralReview[];
  profileRevision: number;
  profileHistory: GeneralProfile[];
  graph: GeneralGraph;
  graphHistory: GeneralGraph[];
  nodeConfirmations: GeneralNodeConfirmation[];
  /** F04: saved (not executed) Team task inputs; start_cycle only accepts these frozen versions. */
  teamTaskDrafts: GeneralTeamTaskDraft[];
  /** F08: 人工知识关系（related / evidence_for+locator）与图谱布局（仅坐标）。 */
  knowledgeRelations: GeneralKnowledgeRelation[];
  knowledgeLayout: Record<string, { x: number; y: number }>;
  layout: Record<string, { x: number; y: number }>;
  limits: { maxAttempts: number; maxRounds: number; deadline: string | null };
}

/** F04 Team 任务输入草稿：保存≠执行；contextHash 冻结保存时的研究上下文，启动时校验新鲜度；来源带保存时版本，防止隐式换来源。 */
export interface GeneralTeamTaskDraft {
  draftId: string;
  revision: number;
  nodeId: string;
  title: string;
  goal: string;
  method: string;
  completionCriterion: string;
  sources: Array<{ sourceId: string; revision: number }>;
  ideaId: string | null;
  ideaRevision: number | null;
  profileRevision: number;
  contextHash: string;
  status: 'draft' | 'revoked';
  createdAt: string;
  updatedAt: string;
}

function invalid(message: string): never { throw new Error(`General research schema: ${message}`); }
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: unknown, fields: string[], label: string): Record<string, unknown> {
  const o = record(value, label);
  for (const key of Object.keys(o)) if (!fields.includes(key)) invalid(`${label}: unexpected ${key}`);
  for (const key of fields) if (!(key in o)) invalid(`${label}: missing ${key}`);
  return o;
}
function text(value: unknown, label: string, max = 4000, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(`${label}: invalid text`);
  return value as string;
}
function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(`${label}: invalid integer`);
  return value as number;
}
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${label}: invalid array`);
  return value as unknown[];
}
function strings(value: unknown, label: string, max = 100): string[] {
  return array(value, label, max).map((v, i) => text(v, `${label}[${i}]`, 4000, true));
}
function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(`${label}: unsupported value`);
  return value as T;
}
function date(value: unknown, label: string): string {
  const result = text(value, label, 100, true);
  if (!Number.isFinite(Date.parse(result))) invalid(`${label}: invalid date`);
  return result;
}

/** Strict extension validator; unknown properties and forged execution status fail closed. */
export function validateGeneralResearch(value: unknown): GeneralResearch {
  // Read compatibility for generic drafts saved before materials were introduced.
  const o = exact({ inferencePlans: [], inferenceRuns: [], importedHistory: [], editHistory: { past: [], future: [] }, factPacks: [], sourceAccess: [], metricProtocols: [], metricReports: [], resultReviews: [], resultDecisions: [], wiki: emptyWikiWorkspace(), knowledge: [], teamTaskDrafts: [], knowledgeRelations: [], knowledgeLayout: {}, requireHumanConfirmation: true, sources: [], datasets: [], plans: [], calculations: [], reviews: [], profileRevision: 1, profileHistory: [], graphHistory: [], nodeConfirmations: [], ...record(value, 'general') }, ['inferencePlans', 'inferenceRuns', 'importedHistory', 'editHistory', 'factPacks', 'sourceAccess', 'metricProtocols', 'metricReports', 'resultReviews', 'resultDecisions', 'knowledge', 'wiki', 'teamTaskDrafts', 'knowledgeRelations', 'knowledgeLayout', 'requireHumanConfirmation', 'schemaVersion', 'revision', 'domains', 'methods', 'entryMode', 'reference', 'constraints', 'pendingQuestions', 'ideas', 'ideaHistory', 'sources', 'datasets', 'plans', 'calculations', 'reviews', 'profileRevision', 'profileHistory', 'graph', 'graphHistory', 'nodeConfirmations', 'layout', 'limits'], 'general');
  const sources = array(o.sources, 'sources', 500).map(validateSource);
  const datasets = array(o.datasets, 'datasets', 2000).map(validateDataset);
  const sourceAccess = array(o.sourceAccess, 'sourceAccess', 2000).map(validateGeneralSourceAccess);
  if (new Set(sourceAccess.map(p => p.decisionId)).size !== sourceAccess.length || sourceAccess.some(p => !sources.some(s => s.sourceId === p.sourceId))) invalid('source access refers to unknown or duplicate identity');
  if (new Set(sources.map(s => s.sourceId)).size !== sources.length) invalid('duplicate source identity');
  for (const source of sources) {
    if (source.previousSourceId !== null) {
      const previous = sources.find(s => s.sourceId === source.previousSourceId);
      if (!previous || previous.revision + 1 !== source.revision) invalid('invalid source predecessor');
    }
  }
  const datasetKeys = new Set<string>();
  for (const dataset of datasets) {
    const source = sources.find(s => s.sourceId === dataset.sourceId);
    const table = source?.tables.find(t => t.tableId === dataset.tableId);
    if (!source || source.sha256 !== dataset.sourceSha256 || !table) invalid('dataset source/table mismatch');
    if (dataset.fields.some(f => f.column >= table.columnCount) || dataset.excludedRows.some(r => r >= table.rowCount)) invalid('dataset mapping exceeds table bounds');
    if (dataset.fields.length !== table.columnCount) invalid('dataset must explicitly map every original column');
    const key = `${dataset.datasetId}:${dataset.version}`;
    if (datasetKeys.has(key)) invalid('duplicate dataset version');
    datasetKeys.add(key);
  }
  for (const dataset of datasets) for (let version = 1; version < dataset.version; version++) {
    const previous = datasets.find(d => d.datasetId === dataset.datasetId && d.version === version);
    if (!previous || previous.sourceId !== dataset.sourceId || previous.tableId !== dataset.tableId) invalid('missing or mismatched dataset history');
  }
  if (o.schemaVersion !== 1) invalid('unsupported schema version');
  const ref = exact(o.reference, ['status', 'description', 'reason'], 'reference');
  const reference: GeneralResearch['reference'] = {
    status: choice(ref.status, ['unknown', 'applicable', 'not_applicable'], 'reference.status'),
    description: text(ref.description, 'reference.description'), reason: text(ref.reason, 'reference.reason'),
  };
  if (reference.status === 'not_applicable' && !reference.reason.trim()) invalid('not_applicable reference requires a reason');
  const parseIdeas = (values: unknown, label: string, max: number): GeneralIdea[] => array(values, label, max).map((value): GeneralIdea => {
    const i = exact(value, ['ideaId', 'revision', 'question', 'rationale', 'verificationPlan', 'sourceRefs', 'nature', 'updatedAt'], 'idea');
    return { ideaId: text(i.ideaId, 'ideaId', 200, true), revision: integer(i.revision, 'idea revision', 1, Number.MAX_SAFE_INTEGER), question: text(i.question, 'question', 4000, true), rationale: text(i.rationale, 'rationale'), verificationPlan: text(i.verificationPlan, 'verificationPlan'), sourceRefs: strings(i.sourceRefs, 'sourceRefs'), nature: choice(i.nature, ['hypothesis'], 'nature'), updatedAt: date(i.updatedAt, 'updatedAt') };
  });
  const ideas = parseIdeas(o.ideas, 'ideas', 100);
  const ideaHistory = parseIdeas(o.ideaHistory, 'ideaHistory', 2000);
  if (new Set(ideas.map(i => i.ideaId)).size !== ideas.length) invalid('duplicate idea identity');
  for (const idea of [...ideas, ...ideaHistory]) if (idea.sourceRefs.some(ref => !sources.some(s => s.sourceId === ref))) invalid('Idea refers to unknown source');
  const versions = new Set<string>();
  for (const old of ideaHistory) {
    const current = ideas.find(i => i.ideaId === old.ideaId);
    const key = `${old.ideaId}:${old.revision}`;
    if (!current || old.revision >= current.revision || versions.has(key)) invalid('invalid Idea history');
    versions.add(key);
  }
  for (const idea of ideas) {
    for (let revision = 1; revision < idea.revision; revision++) {
      if (!versions.has(`${idea.ideaId}:${revision}`)) invalid('missing Idea history version');
    }
  }
  const graph = validateGeneralGraph(o.graph), nodes = graph.nodes;
  for (const node of nodes) if (node.task) {
    if (node.task.sourceIds.some(id => !sources.some(s => s.sourceId === id))) invalid('followup task refers to unknown source');
  }
  const ids = new Set(nodes.map(n => n.nodeId));
  const graphHistory = array(o.graphHistory, 'graphHistory', 200).map(validateGeneralGraph);
  if (graphHistory.length !== graph.revision - 1 || graphHistory.some((g, i) => g.revision !== i + 1)) invalid('graph history missing or out of order');
  const profileRevision = integer(o.profileRevision, 'profileRevision', 1, 201);
  const profileHistory = array(o.profileHistory, 'profileHistory', 200).map(validateGeneralProfile);
  if (profileHistory.length !== profileRevision - 1 || profileHistory.some((p, i) => p.revision !== i + 1)) invalid('profile history missing or out of order');
  const nodeConfirmations = array(o.nodeConfirmations, 'nodeConfirmations', 1000).map(validateNodeConfirmation);
  if (new Set(nodeConfirmations.map(c => c.confirmationId)).size !== nodeConfirmations.length) invalid('duplicate node confirmation');
  for (const confirmation of nodeConfirmations) {
    if (!ids.has(confirmation.nodeId) || confirmation.profileRevision > profileRevision || confirmation.sourceRefs.some(id => !sources.some(s => s.sourceId === id))) invalid('confirmation references unknown node, profile or source');
    if (confirmation.idea && ![...ideas, ...ideaHistory].some(i => i.ideaId === confirmation.idea!.ideaId && i.revision === confirmation.idea!.revision)) invalid('confirmation references unknown Idea version');
    if (confirmation.datasets.some(ref => !datasets.some(d => d.datasetId === ref.datasetId && d.version === ref.version && confirmation.sourceRefs.includes(d.sourceId)))) invalid('confirmation refers to unknown dataset version');
  }
  const metricProtocols = array(o.metricProtocols, 'metricProtocols', 500).map(validateMetricProtocol);
  const metricKeys = new Set<string>();
  for (const protocol of metricProtocols) {
    const key = protocol.protocolId + ':' + protocol.version;
    if (metricKeys.has(key)) invalid('duplicate metric protocol version');
    metricKeys.add(key);
    for (let v = 1; v < protocol.version; v++) if (!metricProtocols.some(p => p.protocolId === protocol.protocolId && p.version === v)) invalid('metric protocol history missing');
  }
  validateMetricIdentityHistory(metricProtocols);
  const metricReports = array(o.metricReports, 'metricReports', 1000).map(validateMetricReport);
  if (new Set(metricReports.map(r => r.reportId)).size !== metricReports.length) invalid('duplicate metric report identity');
  for (const report of metricReports) {
    const protocol = metricProtocols.find(p => p.protocolId === report.protocolId && p.version === report.version);
    if (!protocol || protocol.status !== 'frozen' || !sources.some(s => s.sourceId === report.sourceId) || report.values.some(v => !protocol.metrics.some(m => m.metricId === v.metricId))) invalid('metric report refers to unknown protocol, metric or source');
    if (report.nodeId && !nodes.some(n => n.nodeId === report.nodeId)) invalid('metric report references unknown node');
  }
  const resultReviews = array(o.resultReviews, 'resultReviews', 500).map(validateExternalResultReview);
  if (new Set(resultReviews.map(r => r.reviewId)).size !== resultReviews.length) invalid('duplicate external result review');
  for (const review of resultReviews) {
    if (review.reportIds.some(id => !metricReports.some(r => r.reportId === id))) invalid('external result review references unknown report');
  }
  const resultDecisions = array(o.resultDecisions, 'resultDecisions', 500).map(validateExternalResultDecision);
  if (new Set(resultDecisions.map(d => d.decisionId)).size !== resultDecisions.length) invalid('duplicate external result decision');
  for (const decision of resultDecisions) {
    const review = resultReviews.find(r => r.reviewId === decision.reviewId);
    if (!review || decision.actionIndex >= review.nextActions.length) invalid('external result decision references unknown review action');
    if (decision.nodeId && !nodes.some(n => n.nodeId === decision.nodeId)) invalid('external result decision references unknown node');
  }
  const plans = array(o.plans, 'plans', 1000).map(validateAnalysisPlan);
  const importedHistory = array(o.importedHistory, 'importedHistory', 20).map(validateGeneralImportedHistory);
  for (const p of plans) if (p.importedOrigin) {
    const origin = p.importedOrigin, record = importedHistory.find(r => r.importId === origin.importId);
    if (!record || record.packageRef.sha256 !== origin.packageRef.sha256 || !record.idMap.some(m => m.kind === 'node' && m.current === p.nodeId)) invalid('Imported plan provenance does not belong to this research');
  }
  const inferencePlans = array(o.inferencePlans, 'inferencePlans', 1000).map(validateInferencePlan), inferenceRuns = array(o.inferenceRuns, 'inferenceRuns', 1000).map(validateInferenceRun);
  const inferenceKeys = new Set<string>();
  for (const plan of inferencePlans) {
    const key = plan.planId + ':' + plan.version;
    const dataset = datasets.find(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version);
    const source = sources.find(s => s.sourceId === plan.dataset.sourceId);
    if (inferenceKeys.has(key) || !ids.has(plan.nodeId) || !dataset || !source || dataset.sourceId !== source.sourceId || source.sha256 !== plan.dataset.sourceSha256 || source.parsedSha256 !== plan.parsedSha256 || dataset.tableId !== plan.dataset.tableId) invalid('inference plan scope mismatch');
    const table = source.tables.find(t => t.tableId === dataset.tableId);
    if (!table || plan.rowRange.end > table.rowCount || [plan.valueColumn, plan.sampleColumn, ...(plan.groups ? [plan.groups.column] : [])].some(c => c >= table.columnCount)) invalid('inference range/columns exceed table');
    if (!plan.sourceRefs.includes(source.sourceId) || new Set(plan.sourceRefs).size !== plan.sourceRefs.length || plan.sourceRefs.some(id => !sources.some(s => s.sourceId === id))) invalid('inference source scope mismatch');
    if (inferencePlans.some(p => p.planId === plan.planId && p.nodeId !== plan.nodeId)) invalid('inference plan node changed across versions');
    inferenceKeys.add(key);
  }
  for (const plan of inferencePlans) for (let v = 1; v < plan.version; v++) if (!inferenceKeys.has(plan.planId + ':' + v)) invalid('missing inference plan version');
  if (new Set(inferenceRuns.map(r => r.runId)).size !== inferenceRuns.length) invalid('duplicate inference run');
  const inferenceAttempts = new Set<string>();
  for (const run of inferenceRuns) {
    const plan = inferencePlans.find(p => p.planId === run.planId && p.version === run.planVersion);
    const key = run.planId + ':' + run.planVersion + ':' + run.attempt;
    if (!plan || plan.nodeId !== run.nodeId || inferenceAttempts.has(key) || run.nature !== sources.find(s => s.sourceId === plan.dataset.sourceId)!.nature) invalid('inference run binding mismatch');
    inferenceAttempts.add(key);
  }
  for (const run of inferenceRuns) for (let a = 1; a < run.attempt; a++) if (!inferenceAttempts.has(run.planId + ':' + run.planVersion + ':' + a)) invalid('missing inference attempt');
  const calculations = array(o.calculations, 'calculations', 1000).map(validateCalculation);
  const reviews = array(o.reviews, 'reviews', 1000).map(validateGeneralReview);
  for (const node of nodes) if (node.task) {
    if (node.task.calculationIds.some(id => !calculations.some(c => c.calculationId === id && node.task!.sourceIds.includes(c.input.sourceId)))) invalid('followup task refers to unknown calculation scope');
    if (node.task.origin.kind === 'human_review' && !reviews.some(r => r.reviewId === (node.task!.origin as { reviewId: string }).reviewId)) invalid('followup task refers to unknown human review');
  }
  const planKeys = new Set<string>();
  for (const plan of plans) {
    if (plan.metricContext && !metricProtocols.some(p => p.protocolId === plan.metricContext!.protocolId && p.version === plan.metricContext!.version && p.status === 'frozen')) invalid('analysis metric protocol must be a saved frozen version');
    const dataset = datasets.find(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version);
    if (!ids.has(plan.nodeId) || !dataset || dataset.sourceId !== plan.dataset.sourceId || dataset.sourceSha256 !== plan.dataset.sourceSha256 || dataset.tableId !== plan.dataset.tableId) invalid('analysis plan references wrong node/dataset');
    const table = sources.find(s => s.sourceId === dataset.sourceId)!.tables.find(t => t.tableId === dataset.tableId)!;
    if (plan.rowRange.end > table.rowCount || [...plan.numericColumns, ...plan.groupBy, ...plan.sampleColumns].some(c => c >= table.columnCount)) invalid('analysis plan range/columns exceed table');
    if (plan.idea && ![...ideas, ...ideaHistory].some(i => i.ideaId === plan.idea!.ideaId && i.revision === plan.idea!.revision)) invalid('analysis plan Idea version missing');
    const key = `${plan.planId}:${plan.version}`;
    if (planKeys.has(key)) invalid('duplicate analysis plan version');
    planKeys.add(key);
    for (let version = 1; version < plan.version; version++) if (!plans.some(p => p.planId === plan.planId && p.version === version && p.nodeId === plan.nodeId)) invalid('analysis plan history missing');
  }
  if (new Set(calculations.map(c => c.calculationId)).size !== calculations.length) invalid('duplicate calculation identity');
  for (const calculation of calculations) {
    const plan = plans.find(p => p.planId === calculation.planId && p.version === calculation.planVersion);
    if (!plan || plan.nodeId !== calculation.nodeId || JSON.stringify(plan.dataset) !== JSON.stringify(calculation.input) || JSON.stringify(plan.idea) !== JSON.stringify(calculation.idea)) invalid('calculation input differs from frozen plan');
    if (sources.find(s => s.sourceId === calculation.input.sourceId)?.nature !== calculation.inputNature) invalid('calculation input nature mismatch');
    const attempts = calculations.filter(c => c.planId === calculation.planId && c.planVersion === calculation.planVersion && c.attempt === calculation.attempt);
    if (attempts.length !== 1) invalid('duplicate calculation attempt');
    for (let attempt = 1; attempt < calculation.attempt; attempt++) if (!calculations.some(c => c.planId === calculation.planId && c.planVersion === calculation.planVersion && c.attempt === attempt)) invalid('missing calculation attempt');
  }
  if (new Set(reviews.map(r => r.reviewId)).size !== reviews.length) invalid('duplicate review identity');
  for (const review of reviews) {
    if (!ids.has(review.nodeId) || review.calculationIds.some(id => !calculations.some(c => c.calculationId === id)) || review.sourceRefs.some(id => !sources.some(s => s.sourceId === id))) invalid('review refers to unknown node or evidence');
    if (['supported', 'partial', 'not_supported'].includes(review.judgment) && !review.calculationIds.some(id => calculations.some(c => c.calculationId === id && c.status === 'completed')) && !review.sourceRefs.length) invalid('scientific judgment requires registered evidence, not task status');
  }
  for (const confirmation of nodeConfirmations) {
    const seen = new Set<string>();
    for (const guard of confirmation.guards) {
      const review = reviews.find(r => r.reviewId === guard.reviewId);
      if (seen.has(guard.nodeId) || !review || review.nodeId !== guard.nodeId || !ids.has(guard.nodeId)) invalid('confirmation condition guard refers to mismatched review/node');
      seen.add(guard.nodeId);
    }
  }
  validateGeneralProfile({ requireHumanConfirmation: o.requireHumanConfirmation, revision: profileRevision, title: 'current profile', domains: o.domains, methods: o.methods, entryMode: o.entryMode, reference, constraints: o.constraints, pendingQuestions: o.pendingQuestions, limits: o.limits });
  const knowledge = array(o.knowledge, 'knowledge', 2000).map(validateGeneralKnowledge);
  const knowledgeVersions = new Set<string>();
  for (const entry of knowledge) { const key = `${entry.entryId}:${entry.version}`; if (knowledgeVersions.has(key) || entry.sourceRefs.some(id => !sources.some(s => s.sourceId === id)) || entry.nodeIds.some(id => !ids.has(id)) || entry.calculationIds.some(id => !calculations.some(c => c.calculationId === id))) invalid('knowledge refers to unknown or duplicate identity'); knowledgeVersions.add(key); for (let v = 1; v < entry.version; v++) if (!knowledge.some(e => e.entryId === entry.entryId && e.version === v && e.kind === entry.kind)) invalid('knowledge history missing'); if (entry.nature === 'source_reported' && !entry.sourceRefs.length && !entry.calculationIds.length) invalid('reported knowledge requires source evidence'); }
  for (const entry of knowledge) for (const claim of entry.claims ?? []) for (const locator of claim.locators) {
    if (locator.kind === 'calculation') {
      const calculation = calculations.find(c => c.calculationId === locator.calculationId);
      if (!entry.calculationIds.includes(locator.calculationId) || !calculation?.artifact || calculation.artifact.sha256 !== locator.artifact.sha256) invalid('claim refers to an unregistered calculation artifact');
    } else {
      const source = sources.find(s => s.sourceId === locator.sourceId);
      if (!entry.sourceRefs.includes(locator.sourceId) || !source || source.sha256 !== locator.sourceSha256) invalid('claim source must be declared in entry sourceRefs');
      if (locator.kind === 'table' && (source.parsedSha256 !== locator.parsedSha256 || !datasets.some(d => d.datasetId === locator.datasetId && d.version === locator.datasetVersion && d.sourceId === locator.sourceId && d.tableId === locator.tableId))) invalid('claim table locator refers to a mismatched dataset version');
    }
  }
  const factPacks = array(o.factPacks, 'factPacks', GENERAL_REPORT_LIMITS.maxPacks).map(validateGeneralFactPackRecord);
  const packKeys = new Set<string>();
  for (const pack of factPacks) {
    const key = JSON.stringify([pack.packId, pack.version]);
    if (packKeys.has(key) || pack.sourceIds.some(id => !sources.some(s => s.sourceId === id)) || pack.calculationIds.some(id => !calculations.some(c => c.calculationId === id && pack.sourceIds.includes(c.input.sourceId))) || pack.knowledgeRefs.some(ref => !knowledge.some(e => e.entryId === ref.entryId && e.version === ref.version)) || pack.reviewIds.some(id => !reviews.some(r => r.reviewId === id)) || (pack.inferenceRunIds ?? []).some(id => !inferenceRuns.some(r => r.runId === id))) invalid('fact pack refers to unknown or duplicate identity');
    packKeys.add(key);
    for (let v = 1; v < pack.version; v++) if (!factPacks.some(p => p.packId === pack.packId && p.version === v)) invalid('fact pack history missing');
  }
  const layout: GeneralResearch['layout'] = {};
  for (const [id, value] of Object.entries(record(o.layout, 'layout'))) {
    if (!ids.has(id)) invalid('layout references missing node');
    const p = exact(value, ['x', 'y'], 'position');
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 100000 || p.y > 100000) invalid('invalid layout position');
    Object.defineProperty(layout, id, { value: { x: p.x, y: p.y }, enumerable: true, configurable: true, writable: true });
  }
  const l = exact(o.limits, ['maxAttempts', 'maxRounds', 'deadline'], 'limits');
  const teamTaskDrafts = array(o.teamTaskDrafts, 'teamTaskDrafts', 200).map(validateTeamTaskDraft);
  if (new Set(teamTaskDrafts.map(d => d.draftId)).size !== teamTaskDrafts.length) invalid('duplicate teamTaskDraft identity');
  for (const d of teamTaskDrafts) {
    if (!ids.has(d.nodeId)) invalid('teamTaskDraft references missing node');
    for (const s of d.sources) {
      const source = sources.find(x => x.sourceId === s.sourceId);
      if (!source) invalid('teamTaskDraft references unknown source');
      if (source.revision !== s.revision) invalid('teamTaskDraft source revision does not match the current source chain');
    }
    if (d.ideaId !== null && !ideas.some(i => i.ideaId === d.ideaId)) invalid('teamTaskDraft references unknown idea');
  }
  const knowledgeRelations = array(o.knowledgeRelations, 'knowledgeRelations', 2000).map(validateGeneralKnowledgeRelation);
  if (new Set(knowledgeRelations.map(r => r.relationId)).size !== knowledgeRelations.length) invalid('duplicate knowledgeRelation identity');
  const knowledgeEntryIds = new Set(knowledge.map(k => k.entryId));
  for (const r of knowledgeRelations) {
    if (!knowledgeEntryIds.has(r.fromEntryId) || !knowledgeEntryIds.has(r.toEntryId)) invalid('knowledgeRelation references unknown entry');
    if (r.fromEntryId === r.toEntryId) invalid('knowledgeRelation endpoints must differ');
    for (const l of (r.locator === null ? [] : [r.locator])) {
      if (l.kind === 'text' && !sources.some(s => s.sourceId === l.sourceId)) invalid('knowledgeRelation locator references unknown source');
      if (l.kind === 'calculation' && !calculations.some(c => c.calculationId === l.calculationId)) invalid('knowledgeRelation locator references unknown calculation');
    }
  }
  const knowledgeLayout: GeneralResearch['knowledgeLayout'] = {};
  for (const [id, value] of Object.entries(record(o.knowledgeLayout, 'knowledgeLayout'))) {
    if (!knowledgeEntryIds.has(id) && !sources.some(s => id === 'source:' + s.sourceId)) invalid('knowledgeLayout references missing entry');
    const p = exact(value, ['x', 'y'], 'knowledge position');
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0 || p.x > 100000 || p.y > 100000) invalid('invalid knowledge layout position');
    knowledgeLayout[id] = { x: p.x, y: p.y };
  }
  const wiki = validateWikiWorkspace(o.wiki);
  for (const board of wiki.boards) for (const card of board.cards) if (!knowledgeEntryIds.has(card.entryId)) invalid('whiteboard references missing knowledge');
  for (const entry of knowledge) for (const image of entry.images ?? []) if (!sources.some(s => s.sourceId === image.sourceId)) invalid('knowledge image references unknown source');
  return {
    wiki, inferencePlans, inferenceRuns, importedHistory, editHistory: validateGeneralEditHistory(o.editHistory), factPacks, sourceAccess, metricProtocols, metricReports, resultReviews, resultDecisions, knowledge, requireHumanConfirmation: o.requireHumanConfirmation as boolean, schemaVersion: 1, revision: integer(o.revision, 'revision', 1, Number.MAX_SAFE_INTEGER), domains: strings(o.domains, 'domains', 20),
    methods: array(o.methods, 'methods', 5).map(m => choice(m, GENERAL_METHODS, 'method')),
    entryMode: choice(o.entryMode, ['idea_only', 'design_first', 'existing_data'], 'entryMode'), reference,
    constraints: strings(o.constraints, 'constraints'), pendingQuestions: strings(o.pendingQuestions, 'pendingQuestions'), ideas, ideaHistory, sources, datasets, plans, calculations, reviews,
    profileRevision, profileHistory, graph, graphHistory, nodeConfirmations, teamTaskDrafts, knowledgeRelations, knowledgeLayout, layout,
    limits: { maxAttempts: integer(l.maxAttempts, 'maxAttempts', 1, 10), maxRounds: integer(l.maxRounds, 'maxRounds', 1, 10), deadline: l.deadline === null ? null : date(l.deadline, 'deadline') },
  };
}

/** 严格校验 Team 任务草稿；不携带任何执行状态字段（草稿永远不是运行）。 */
export function validateTeamTaskDraft(value: unknown): GeneralTeamTaskDraft {
  const o = exact(value, ['draftId', 'revision', 'nodeId', 'title', 'goal', 'method', 'completionCriterion', 'sources', 'ideaId', 'ideaRevision', 'profileRevision', 'contextHash', 'status', 'createdAt', 'updatedAt'], 'teamTaskDraft');
  const sources = array(o.sources, 'teamTaskDraft.sources', 10).map((entry, i) => {
    const s = exact(entry, ['sourceId', 'revision'], `teamTaskDraft.sources[${i}]`);
    return { sourceId: text(s.sourceId, `teamTaskDraft.sources[${i}].sourceId`, 200, true), revision: integer(s.revision, `teamTaskDraft.sources[${i}].revision`, 1, 2001) };
  });
  if (new Set(sources.map(s => s.sourceId)).size !== sources.length) invalid('teamTaskDraft: duplicate sources');
  return {
    draftId: text(o.draftId, 'teamTaskDraft.draftId', 200, true),
    revision: integer(o.revision, 'teamTaskDraft.revision', 1, 2001),
    nodeId: text(o.nodeId, 'teamTaskDraft.nodeId', 200, true),
    title: text(o.title, 'teamTaskDraft.title', 300, true),
    goal: text(o.goal, 'teamTaskDraft.goal', 4000, true),
    method: text(o.method, 'teamTaskDraft.method', 4000, true),
    completionCriterion: text(o.completionCriterion, 'teamTaskDraft.completionCriterion', 4000, true),
    sources,
    ideaId: o.ideaId === null ? null : text(o.ideaId, 'teamTaskDraft.ideaId', 200, true),
    ideaRevision: o.ideaRevision === null ? null : integer(o.ideaRevision, 'teamTaskDraft.ideaRevision', 1, 2001),
    profileRevision: integer(o.profileRevision, 'teamTaskDraft.profileRevision', 1, 201),
    contextHash: text(o.contextHash, 'teamTaskDraft.contextHash', 200, true),
    status: choice(o.status, ['draft', 'revoked'] as const, 'teamTaskDraft.status'),
    createdAt: date(o.createdAt, 'teamTaskDraft.createdAt'),
    updatedAt: date(o.updatedAt, 'teamTaskDraft.updatedAt'),
  };
}

/** Templates are suggestions, never completed tasks or scientific validation. */
export function createGeneralResearch(input: { question: string; domains: string[]; methods: GeneralMethod[]; entryMode: GeneralResearch['entryMode']; now: string; mint: (prefix: string) => string }): GeneralResearch {
  const nodes: GeneralNode[] = [];
  const add = (kind: GeneralNode['kind'], title: string, method: string, output: string): GeneralNode => {
    const n: GeneralNode = { nodeId: input.mint('node'), kind, title, goal: title, inputs: [], method, output, completionCriterion: '产出可检查记录；未知项与证据边界明确。', join: 'all', execution: 'not_started' };
    nodes.push(n); return n;
  };
  const goal = add('goal', '研究问题与范围', '人工确认研究目标与约束', '研究问题与待确认清单');
  const materials = add('materials', '资料与数据整理', '保留原始来源、字段、单位与条件', '资料清单与数据字典');
  const protocol = add('protocol', '方法与分析协议', '明确变量、控制条件、比较范围与缺口', '分析协议');
  const labels: Record<GeneralMethod, [string, string]> = {
    engineering: ['工程试验数据分析', '样本、批次、条件、测量单位与不确定性'],
    observation: ['理科观测与已有计算分析', '观察条件、测量误差与理论预期；推导待审查'],
    algorithm: ['算法与系统已有证据分析', '保留历史 Baseline/Slot/划分/seed 约束，不自动启动训练'],
    survey: ['问卷编码与已有证据分析', '量表、缺失编码、样本范围；关联不等于因果'],
    review: ['检索筛选与证据综合', '检索、纳入排除理由、编码与逐条来源'],
  };
  const methods = [...new Set(input.methods)];
  const analyses = methods.length ? methods.map(m => add('analysis', labels[m][0], labels[m][1], '证据报告与未计算项')) : [add('analysis', '已有材料分析（方法待确认）', '先确认研究方法、资料与计算范围，不预设工程或算法领域', '分析计划与证据缺口')];
  const review = add('review', '审查与下一步', '支持、反例、缺口与适用边界分别审查', '有依据的审查决定');
  const report = add('report', '研究包与未知项', '汇总实际资料和产物，不补造结果', '研究报告与来源清单');
  const edges: GeneralEdge[] = [];
  const dep = (n: GeneralNode, prerequisite: GeneralNode): void => { edges.push({ edgeId: input.mint('edge'), from: n.nodeId, to: prerequisite.nodeId, kind: 'depends_on', condition: null }); n.inputs.push(prerequisite.nodeId); };
  dep(materials, goal); dep(protocol, goal);
  if (input.entryMode !== 'design_first') dep(protocol, materials); else dep(materials, protocol);
  for (const a of analyses) { dep(a, materials); dep(a, protocol); dep(review, a); }
  dep(report, review);
  const general: GeneralResearch = {
    inferencePlans: [], inferenceRuns: [], importedHistory: [], editHistory: { past: [], future: [] }, sourceAccess: [], factPacks: [],
    metricProtocols: [suggestMetricProtocol({ protocolId: input.mint('metric-protocol'), version: 1, question: input.question, datasets: [], now: input.now })], metricReports: [], resultReviews: [], resultDecisions: [],
    knowledge: [], requireHumanConfirmation: true, schemaVersion: 1, revision: 1, domains: input.domains, methods: [...new Set(input.methods)], entryMode: input.entryMode,
    reference: { status: 'unknown', description: '', reason: '' }, constraints: [], pendingQuestions: input.entryMode === 'idea_only' ? ['尚无数据或证据；仅规划，不生成研究结论。'] : [],
    ideas: [{ ideaId: input.mint('idea'), revision: 1, question: input.question, rationale: '', verificationPlan: '', sourceRefs: [], nature: 'hypothesis', updatedAt: input.now }],
    ideaHistory: [], sources: [], datasets: [], plans: [], calculations: [], reviews: [],
    profileRevision: 1, profileHistory: [], graphHistory: [], nodeConfirmations: [], teamTaskDrafts: [], knowledgeRelations: [], knowledgeLayout: {},
    graph: { revision: 1, nodes, edges }, layout: Object.fromEntries(nodes.map((n, i) => [n.nodeId, { x: 50 + i * 270, y: 170 }])),
    limits: { maxAttempts: 3, maxRounds: 1, deadline: null },
  };
  return validateGeneralResearch(general);
}
