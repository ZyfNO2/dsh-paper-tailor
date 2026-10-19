import { object, str, num, list, hash, one, validateSource, validateDataset } from './general-data.ts';
import { validateAnalysisPlan, validateCalculation, validateGeneralReview } from './general-analysis.ts';
import { validateGeneralKnowledge } from './general-knowledge.ts';
import { validateMetricProtocol, validateMetricReport } from './general-metrics.ts';
import { evidenceArtifactRef, timestamp, type GeneralEvidenceCheck } from './general-evidence.ts';
import type { MaterialSource, DatasetVersion } from './general-data.ts';
import type { GeneralAnalysisPlan, GeneralCalculation, GeneralReview, SummaryRow } from './general-analysis.ts';
import type { GeneralKnowledgeEntry } from './general-knowledge.ts';
import type { GeneralMetricProjection } from './general-metrics.ts';
import { validateInferencePlan, validateInferenceRun, type InferencePlan, type InferenceRun } from './general-inference-records.ts';
import type { InferenceResult } from './general-inference.ts';

export const GENERAL_REPORT_LIMITS = Object.freeze({ maxPacks: 200, maxItems: 100, maxBytes: 4 * 1024 * 1024 });
export interface GeneralReportSelection {
  sourceIds: string[]; calculationIds: string[]; knowledgeRefs: { entryId: string; version: number }[]; reviewIds: string[]; inferenceRunIds: string[];
}
export interface GeneralFactPackRecord extends GeneralReportSelection {
  packId: string; version: number; title: string; artifact: { id: string; sha256: string };
  contextHash: string; inputsHash: string; bootstrapRevision: number; createdAt: string;
}
export interface GeneralFactPackInference {
  run: InferenceRun; plan: InferencePlan; check: 'provenance_checked' | 'unavailable';
  freshness: { status: 'current' | 'needs_review'; reasons: string[] }; result: InferenceResult | null; error: string | null;
}
export interface GeneralReportFactPack {
  schemaVersion: 1; kind: 'general_report_fact_pack'; researchId: string; packId: string; version: number;
  title: string; createdAt: string; bootstrapRevision: number; contextHash: string; inputsHash: string;
  selection: GeneralReportSelection; questions: { ideaId: string; revision: number; question: string; nature: 'hypothesis' }[];
  constraints: string[]; sources: MaterialSource[]; datasets: DatasetVersion[]; plans: GeneralAnalysisPlan[];
  calculations: { calculation: GeneralCalculation; check: 'provenance_checked' | 'unavailable'; freshness: { status: 'current' | 'needs_review'; reasons: string[] }; summaries: SummaryRow[]; warnings: string[]; error: string | null }[];
  knowledge: { entry: GeneralKnowledgeEntry; evidence: GeneralEvidenceCheck }[];
  reviews: { review: GeneralReview; freshness: { status: 'current' | 'needs_review'; reasons: string[] } }[];
  metrics: GeneralMetricProjection; inferences: GeneralFactPackInference[]; unknowns: string[]; boundary: string;
}
export interface GeneralReportProjection { packs: (GeneralFactPackRecord & { access: 'allowed' | 'revoked'; freshness: 'current' | 'needs_review' })[]; boundary: string }
export interface GeneralFactPackRead {
  record: GeneralFactPackRecord; pack: GeneralReportFactPack;
  freshness: { status: 'current' | 'needs_review'; reasons: string[] };
}
const ids = (v: unknown, label: string): string[] => { const values = list(v, label, GENERAL_REPORT_LIMITS.maxItems).map(x => str(x, label, 200, true)); if (new Set(values).size !== values.length) throw new Error('Duplicate report selection identity'); return values; };
export function validateGeneralReportSelection(v: unknown): GeneralReportSelection {
  const s = object(v, ['sourceIds', 'calculationIds', 'knowledgeRefs', 'reviewIds', 'inferenceRunIds'], 'report selection', ['inferenceRunIds']);
  const knowledgeRefs = list(s.knowledgeRefs, 'knowledgeRefs', GENERAL_REPORT_LIMITS.maxItems).map(v => { const r = object(v, ['entryId', 'version'], 'knowledge reference'); return { entryId: str(r.entryId, 'entryId', 200, true), version: num(r.version, 'knowledge version', 1, 201) }; });
  if (new Set(knowledgeRefs.map(r => JSON.stringify([r.entryId, r.version]))).size !== knowledgeRefs.length) throw new Error('Duplicate report knowledge version');
  return { sourceIds: ids(s.sourceIds, 'sourceIds'), calculationIds: ids(s.calculationIds, 'calculationIds'), knowledgeRefs, reviewIds: ids(s.reviewIds, 'reviewIds'), inferenceRunIds: ids(s.inferenceRunIds ?? [], 'inferenceRunIds') };
}
export function validateGeneralFactPackRecord(v: unknown): GeneralFactPackRecord {
  const r = object(v, ['packId', 'version', 'title', 'artifact', 'contextHash', 'inputsHash', 'bootstrapRevision', 'createdAt', 'sourceIds', 'calculationIds', 'knowledgeRefs', 'reviewIds', 'inferenceRunIds'], 'fact pack record', ['inferenceRunIds']);
  const selection = validateGeneralReportSelection({ sourceIds: r.sourceIds, calculationIds: r.calculationIds, knowledgeRefs: r.knowledgeRefs, reviewIds: r.reviewIds, inferenceRunIds: r.inferenceRunIds ?? [] });
  return { ...selection, packId: str(r.packId, 'packId', 200, true), version: num(r.version, 'pack version', 1, 201), title: str(r.title, 'report title', 300, true), artifact: evidenceArtifactRef(r.artifact), contextHash: hash(r.contextHash), inputsHash: hash(r.inputsHash), bootstrapRevision: num(r.bootstrapRevision, 'bootstrapRevision', 0, Number.MAX_SAFE_INTEGER), createdAt: timestamp(r.createdAt) };
}

const texts = (v: unknown, label: string, max = 10000) => list(v, label, max).map(x => str(x, label, 50000));
const freshness = (v: unknown) => { const f = object(v, ['status', 'reasons'], 'freshness'); return { status: one(f.status, ['current', 'needs_review'] as const, 'freshness status'), reasons: texts(f.reasons, 'freshness reasons') }; };
const finite = (v: unknown): number | null => { if (v === null) return null; if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid report numeric value'); return v; };
const optionalText = (v: unknown) => v === null ? null : str(v, 'optional text', 50000);
function evidence(v: unknown): GeneralEvidenceCheck {
  const e = object(v, ['status', 'reasons', 'sourceIds', 'inputNatures', 'check'], 'report evidence');
  return { status: one(e.status, ['current', 'needs_review', 'unavailable', 'revoked', 'unlocated'] as const, 'evidence status'), reasons: texts(e.reasons, 'evidence reasons'), sourceIds: texts(e.sourceIds, 'evidence sources', 100), inputNatures: texts(e.inputNatures, 'input natures', 100), check: one(e.check, ['locator_checked', 'unavailable', 'unlocated'] as const, 'evidence check') };
}
/** Pure bounded wire validation, also used by the client. Registration and live access stay in the Host. */
export function validateGeneralReportFactPack(v: unknown): GeneralReportFactPack {
  const p = object(v, ['schemaVersion', 'kind', 'researchId', 'packId', 'version', 'title', 'createdAt', 'bootstrapRevision', 'contextHash', 'inputsHash', 'selection', 'questions', 'constraints', 'sources', 'datasets', 'plans', 'calculations', 'knowledge', 'reviews', 'metrics', 'inferences', 'unknowns', 'boundary'], 'fact pack artifact', ['inferences']);
  if (p.schemaVersion !== 1 || p.kind !== 'general_report_fact_pack') throw new Error('Invalid fact pack kind/version');
  const selection = validateGeneralReportSelection(p.selection);
  const identity = { packId: str(p.packId, 'packId', 200, true), version: num(p.version, 'pack version', 1, 201), title: str(p.title, 'report title', 300, true), contextHash: hash(p.contextHash), inputsHash: hash(p.inputsHash), bootstrapRevision: num(p.bootstrapRevision, 'bootstrapRevision', 0, Number.MAX_SAFE_INTEGER), createdAt: timestamp(p.createdAt) };
  const sources = list(p.sources, 'pack sources', 100).map(validateSource), datasets = list(p.datasets, 'pack datasets', 2000).map(validateDataset), plans = list(p.plans, 'pack plans', 100).map(validateAnalysisPlan);
  const calculations = list(p.calculations, 'pack calculations', 100).map(v => {
    const c = object(v, ['calculation', 'check', 'freshness', 'summaries', 'warnings', 'error'], 'report calculation');
    const calculation = validateCalculation(c.calculation);
    const summaries = list(c.summaries, 'summaries', 10000).map(v => {
      const s = object(v, ['group', 'column', 'label', 'unit', 'rowCount', 'statistics', 'sampleCount'], 'report summary');
      const st = object(s.statistics, ['count', 'missing', 'mean', 'median', 'min', 'max', 'sampleSD'], 'report statistics');
      const group = list(s.group, 'summary group', 4).map(v => { const g = object(v, ['column', 'label', 'value'], 'summary group'); if (g.value !== null && typeof g.value !== 'string' && typeof g.value !== 'boolean') finite(g.value); return { column: num(g.column, 'column', 0, 199), label: str(g.label, 'label', 300), value: g.value as string | number | boolean | null }; });
      const rowCount = num(s.rowCount, 'rowCount', 0, 50000), sampleCount = s.sampleCount === null ? null : num(s.sampleCount, 'sampleCount', 0, rowCount);
      const statistics = { count: num(st.count, 'count', 0, 50000), missing: num(st.missing, 'missing', 0, 50000), mean: finite(st.mean), median: finite(st.median), min: finite(st.min), max: finite(st.max), sampleSD: finite(st.sampleSD) };
      if (statistics.count + statistics.missing !== (sampleCount ?? rowCount) || (statistics.count < 2) !== (statistics.sampleSD === null) || statistics.sampleSD !== null && statistics.sampleSD < 0) throw new Error('Invalid report summary counts/uncertainty');
      const values = [statistics.mean, statistics.median, statistics.min, statistics.max];
      if (statistics.count === 0 ? values.some(v => v !== null) : values.some(v => v === null)) throw new Error('Invalid empty/nonempty report statistics');
      if (statistics.min !== null && statistics.max !== null && (statistics.min > statistics.max || statistics.mean! < statistics.min || statistics.mean! > statistics.max || statistics.median! < statistics.min || statistics.median! > statistics.max)) throw new Error('Invalid report statistic extrema');
      return { group, column: num(s.column, 'column', 0, 199), label: str(s.label, 'label', 300), unit: str(s.unit, 'unit', 4000, true), rowCount, sampleCount, statistics };
    });
    const check = one(c.check, ['provenance_checked', 'unavailable'] as const, 'calculation check');
    if (check === 'provenance_checked' && calculation.status !== 'completed' || check === 'unavailable' && summaries.length) throw new Error('Report calculation check/content mismatch');
    return { calculation, check, freshness: freshness(c.freshness), summaries, warnings: texts(c.warnings, 'warnings'), error: optionalText(c.error) };
  });
  const knowledge = list(p.knowledge, 'pack knowledge', 100).map(v => { const k = object(v, ['entry', 'evidence'], 'report knowledge'); return { entry: validateGeneralKnowledge(k.entry), evidence: evidence(k.evidence) }; });
  const reviews = list(p.reviews, 'pack reviews', 100).map(v => { const r = object(v, ['review', 'freshness'], 'report review'); return { review: validateGeneralReview(r.review), freshness: freshness(r.freshness) }; });
  const inferenceResultView = (v: unknown): InferenceResult => {
    const r = object(v, ['estimand', 'method', 'confidence', 'unit', 'nA', 'nB', 'excludedA', 'excludedB', 'estimate', 'standardError', 'degreesOfFreedom', 'statistic', 'pValueTwoSided', 'confidenceInterval', 'standardizedEffect', 'assumptions', 'warnings', 'tool'], 'inference result view');
    const tool = object(r.tool, ['name', 'version', 'runtime'], 'inference tool');
    return { ...r, tool } as unknown as InferenceResult;
  };
  const inferences = list(p.inferences ?? [], 'pack inferences', 100).map(v => {
    const e = object(v, ['run', 'plan', 'check', 'freshness', 'result', 'error'], 'pack inference');
    const run = validateInferenceRun(e.run), plan = validateInferencePlan(e.plan);
    if (run.planId !== plan.planId || run.planVersion !== plan.version || run.nodeId !== plan.nodeId) throw new Error('Pack inference run/plan mismatch');
    const check = one(e.check, ['provenance_checked', 'unavailable'] as const, 'pack inference check');
    if (check === 'provenance_checked' ? e.result === null || e.error !== null : e.result !== null || typeof e.error !== 'string') throw new Error('Pack inference check/content mismatch');
    const view = e.result === null ? null : inferenceResultView(e.result);
    if (view !== null && (view.tool.name !== run.tool.name || view.tool.version !== run.tool.version || view.tool.runtime !== run.tool.runtime)) throw new Error('Pack inference result tool does not match registered run');
    return { run, plan, check, freshness: freshness(e.freshness), result: view, error: e.error as string | null };
  });
  const m = object(p.metrics, ['protocols', 'reports', 'rows', 'errors', 'boundary'], 'report metrics');
  const protocols = list(m.protocols, 'protocols', 500).map(validateMetricProtocol), reports = list(m.reports, 'metric reports', 1000).map(validateMetricReport);
  const rows = list(m.rows, 'metric rows', 10000).map(v => {
    const r = object(v, ['rowId', 'protocolId', 'version', 'label', 'role', 'variantKey', 'parentKey', 'origin', 'inputNature', 'status', 'check', 'calculationId', 'sourceId', 'locator', 'attempt', 'group', 'cells', 'blockers', 'comparisonReasons', 'comparedTo', 'constraintsStatus', 'selectionStatus'], 'metric row');
    const cells = list(r.cells, 'metric cells', 100).map(v => { const c = object(v, ['metricId', 'value', 'unit', 'status', 'targetStatus', 'delta'], 'metric cell'); return { metricId: str(c.metricId, 'metricId', 200, true), value: finite(c.value), unit: optionalText(c.unit), status: one(c.status, ['recorded', 'missing', 'unit_mismatch'] as const, 'cell status'), targetStatus: one(c.targetStatus, ['not_configured', 'met', 'not_met', 'unknown'] as const, 'target status'), delta: finite(c.delta) }; });
    return { rowId: str(r.rowId, 'rowId', 500, true), protocolId: str(r.protocolId, 'protocolId', 200, true), version: num(r.version, 'metric version', 1, 1000), label: str(r.label, 'label', 50000), role: str(r.role, 'role', 200), variantKey: optionalText(r.variantKey), parentKey: optionalText(r.parentKey), origin: one(r.origin, ['system_calculation', 'source_reported'] as const, 'origin'), inputNature: str(r.inputNature, 'nature', 200), status: str(r.status, 'status', 200), check: one(r.check, ['provenance_checked', 'source_reported', 'unavailable'] as const, 'metric check'), calculationId: optionalText(r.calculationId), sourceId: str(r.sourceId, 'sourceId', 200, true), locator: str(r.locator, 'locator', 50000), attempt: r.attempt === null ? null : num(r.attempt, 'attempt', 1, 10), group: str(r.group, 'group', 50000), cells, blockers: texts(r.blockers, 'blockers'), comparisonReasons: texts(r.comparisonReasons, 'comparison reasons'), comparedTo: optionalText(r.comparedTo), constraintsStatus: one(r.constraintsStatus, ['passed', 'failed', 'unknown', 'not_configured'] as const, 'constraints status'), selectionStatus: one(r.selectionStatus, ['needs_validation', 'not_eligible'] as const, 'selection status') };
  });
  const errors = list(m.errors, 'metric errors', 1000).map(v => { const e = object(v, ['calculationId', 'message'], 'metric error'); return { calculationId: str(e.calculationId, 'calculationId', 200, true), message: str(e.message, 'error', 50000) }; });
  const exactIds = (actual: string[], selected: string[]) => { if (new Set(actual).size !== actual.length || actual.length !== selected.length || actual.some(id => !selected.includes(id))) throw new Error('Fact pack selection/dependency mismatch'); };
  exactIds(sources.map(s => s.sourceId), selection.sourceIds); exactIds(calculations.map(c => c.calculation.calculationId), selection.calculationIds); exactIds(knowledge.map(k => JSON.stringify([k.entry.entryId, k.entry.version])), selection.knowledgeRefs.map(k => JSON.stringify([k.entryId, k.version]))); exactIds(reviews.map(r => r.review.reviewId), selection.reviewIds);
  const scopedSource = (id: string) => { if (!selection.sourceIds.includes(id)) throw new Error('Fact pack dependency outside source scope'); };
  const scopedCalculation = (id: string) => { if (!selection.calculationIds.includes(id)) throw new Error('Fact pack dependency outside calculation scope'); };
  const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) throw new Error('Duplicate fact pack dependency identity'); };
  unique(datasets.map(d => JSON.stringify([d.datasetId, d.version]))); unique(plans.map(p => JSON.stringify([p.planId, p.version]))); unique(protocols.map(p => JSON.stringify([p.protocolId, p.version]))); unique(reports.map(r => r.reportId));
  for (const d of datasets) { scopedSource(d.sourceId); const source = sources.find(s => s.sourceId === d.sourceId)!; if (d.sourceSha256 !== source.sha256 || !source.tables.some(t => t.tableId === d.tableId)) throw new Error('Fact pack dataset source mismatch'); }
  for (const plan of plans) { scopedSource(plan.dataset.sourceId); plan.nodeContext?.task?.sourceIds.forEach(scopedSource); plan.nodeContext?.task?.calculationIds.forEach(scopedCalculation); if (!datasets.some(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version && d.sourceId === plan.dataset.sourceId && d.sourceSha256 === plan.dataset.sourceSha256 && d.tableId === plan.dataset.tableId)) throw new Error('Fact pack plan dataset dependency missing'); }
  for (const { calculation: c } of calculations) { scopedSource(c.input.sourceId); const plan = plans.find(p => p.planId === c.planId && p.version === c.planVersion); if (!plan || JSON.stringify(c.input) !== JSON.stringify(plan.dataset) || c.inputNature !== sources.find(s => s.sourceId === c.input.sourceId)!.nature) throw new Error('Fact pack calculation plan/input dependency missing'); }
  for (const { entry, evidence } of knowledge) { entry.sourceRefs.forEach(scopedSource); entry.calculationIds.forEach(scopedCalculation); evidence.sourceIds.forEach(scopedSource); for (const claim of entry.claims ?? []) for (const l of claim.locators) { if (l.kind === 'calculation') scopedCalculation(l.calculationId); else { scopedSource(l.sourceId); if (l.kind === 'table' && !datasets.some(d => d.datasetId === l.datasetId && d.version === l.datasetVersion && d.sourceId === l.sourceId)) throw new Error('Fact pack locator dataset missing'); } } }
  for (const { review } of reviews) { review.sourceRefs.forEach(scopedSource); review.calculationIds.forEach(scopedCalculation); }
  exactIds(inferences.map(i => i.run.runId), selection.inferenceRunIds);
  for (const item of inferences) { scopedSource(item.plan.dataset.sourceId); item.plan.sourceRefs.forEach(scopedSource); }
  for (const report of reports) { scopedSource(report.sourceId); const protocol = protocols.find(p => p.protocolId === report.protocolId && p.version === report.version); if (!protocol || report.values.some(v => !protocol.metrics.some(m => m.metricId === v.metricId))) throw new Error('Fact pack source report protocol missing'); }
  unique(rows.map(r => r.rowId));
  for (const row of rows) { scopedSource(row.sourceId); if (row.calculationId !== null) scopedCalculation(row.calculationId); const protocol = protocols.find(p => p.protocolId === row.protocolId && p.version === row.version); if (!protocol || row.cells.some(c => !protocol.metrics.some(m => m.metricId === c.metricId)) || row.comparedTo !== null && !rows.some(r => r.rowId === row.comparedTo) || row.comparedTo === null && row.cells.some(c => c.delta !== null)) throw new Error('Fact pack metric dependency mismatch'); }
  errors.forEach(e => scopedCalculation(e.calculationId));
  const questions = list(p.questions, 'questions', 100).map(v => { const q = object(v, ['ideaId', 'revision', 'question', 'nature'], 'question'); return { ideaId: str(q.ideaId, 'ideaId', 200, true), revision: num(q.revision, 'revision', 1, Number.MAX_SAFE_INTEGER), question: str(q.question, 'question', 4000, true), nature: one(q.nature, ['hypothesis'] as const, 'question nature') }; });
  return { schemaVersion: 1, kind: 'general_report_fact_pack', researchId: str(p.researchId, 'researchId', 200, true), ...identity, selection, questions, constraints: texts(p.constraints, 'constraints', 100), sources, datasets, plans, calculations, knowledge, reviews, metrics: { protocols, reports, rows, errors, boundary: str(m.boundary, 'metrics boundary', 50000, true) }, inferences, unknowns: texts(p.unknowns, 'unknowns'), boundary: str(p.boundary, 'boundary', 50000, true) };
}

export function validateGeneralFactPackRead(v: unknown): GeneralFactPackRead {
  const r = object(v, ['record', 'pack', 'freshness'], 'fact pack read');
  const record = validateGeneralFactPackRecord(r.record), pack = validateGeneralReportFactPack(r.pack);
  for (const key of ['packId', 'version', 'title', 'createdAt', 'contextHash', 'inputsHash', 'bootstrapRevision'] as const) if (pack[key] !== record[key]) throw new Error('Fact pack response identity mismatch');
  if (JSON.stringify(pack.selection) !== JSON.stringify(validateGeneralReportSelection({ sourceIds: record.sourceIds, calculationIds: record.calculationIds, knowledgeRefs: record.knowledgeRefs, reviewIds: record.reviewIds, inferenceRunIds: record.inferenceRunIds ?? [] }))) throw new Error('Fact pack response scope mismatch');
  return { record, pack, freshness: freshness(r.freshness) };
}


