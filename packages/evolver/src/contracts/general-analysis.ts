import { validateGeneralImportedPlanOrigin, type GeneralImportedPlanOrigin } from './general-import.ts';
/** Deterministic calculation and human review are separate persisted facts. */
import { validateMetricContext, type GeneralMetricContext } from './general-metrics.ts';
import { object, str, num, list, one, hash, type MaterialNature } from './general-data.ts';
import { validateGeneralNode, type GeneralNode } from './general-workflow.ts';
export const ANALYSIS_METHODS = ['descriptive', 'grouped_descriptive', 'repeated_summary'] as const;
export type AnalysisMethod = typeof ANALYSIS_METHODS[number];
export interface DatasetInputRef {
  datasetId: string; version: number; sourceId: string; sourceSha256: string; tableId: string; dictionarySha256: string;
}
export interface GeneralAnalysisPlan {
  importedOrigin?: GeneralImportedPlanOrigin;
  nodeContext?: GeneralNode;
  metricContext?: GeneralMetricContext;
  planId: string; version: number; nodeId: string; nodeSnapshotHash: string; title: string; goal: string;
  /** Absent only on earlier generic drafts; new plans pin semantic research context. */
  contextHash?: string;
  dependencySnapshotHash?: string;
  dataset: DatasetInputRef;
  idea: { ideaId: string; revision: number } | null;
  method: AnalysisMethod;
  numericColumns: number[]; groupBy: number[]; sampleColumns: number[];
  rowRange: { start: number; end: number };
  missingPolicy: 'available_cases'; missingGroupPolicy: 'separate' | 'exclude';
  requiredConditions: string[];
  comparisonScope: string;
  limitations: string[];
  createdAt: string;
}
export interface SummaryStatistics {
  count: number; missing: number; mean: number | null; median: number | null; min: number | null; max: number | null; sampleSD: number | null;
}
export interface SummaryRow {
  group: { column: number; label: string; value: string | number | boolean | null }[];
  column: number; label: string; unit: string;
  rowCount: number; statistics: SummaryStatistics;
  /** Repeated mode: statistics above are over one mean per real sample, not measurement rows. */
  sampleCount: number | null;
}
export interface CalculationArtifact {
  schemaVersion: 1; kind: 'descriptive_calculation';
  plan: GeneralAnalysisPlan;
  sourceNature: MaterialNature;
  inputSnapshot: { sourceHash: string; parsedHash: string; parser: string; dictionaryHash: string; excludedRows: number[]; fields: unknown[]; conditions: unknown[] };
  tool: { name: string; version: string; runtime: string; formulae: string[] };
  selection: { totalRows: number; rangeRows: number; excludedRows: number; missingGroupRows: number; includedRows: number };
  summaries: SummaryRow[];
  warnings: string[];
  chart: { kind: 'mean_by_group'; unit: string; series: { label: string; mean: number | null; count: number }[] }[];
  startedAt: string; finishedAt: string;
}
export interface GeneralCalculation {
  calculationId: string; planId: string; planVersion: number; nodeId: string; attempt: number;
  status: 'completed' | 'blocked' | 'failed';
  provenance: 'system_calculation';
  inputNature: MaterialNature;
  input: DatasetInputRef;
  idea: GeneralAnalysisPlan['idea'];
  tool: { name: string; version: string; runtime: string };
  artifact: { id: string; sha256: string } | null;
  firstError: { code: string; message: string } | null;
  startedAt: string; finishedAt: string;
  /** Projection only; successful calculation never assigns a scientific decision. */
  checks: 'calculation_completed' | 'conditions_unsatisfied' | 'calculation_failed';
}
export interface GeneralNextAction {
  kind: 'materials' | 'plan' | 'calculate' | 'fix' | 'review' | 'reanalyse' | 'followup';
  label: string; reason: string; nodeId: string; page: 'data' | 'results' | 'flow';
}
export interface GeneralAnalysisProjection {
  nextActions: GeneralNextAction[];
  plans: GeneralAnalysisPlan[];
  calculations: (GeneralCalculation & { freshness: { status: 'current' | 'needs_review'; reasons: string[] } })[];
  reviews: (GeneralReview & { freshness: { status: 'current' | 'needs_review'; reasons: string[] } })[];
}
export const REVIEW_JUDGMENTS = ['supported', 'partial', 'not_supported', 'insufficient', 'paused'] as const;
export type GeneralJudgment = typeof REVIEW_JUDGMENTS[number];
export interface GeneralReview {
  reviewId: string; nodeId: string; calculationIds: string[]; sourceRefs: string[];
  /** 独立推断运行引用（显式类型，不伪装描述统计；可选，旧状态兼容）。 */
  inferenceRunIds?: string[];
  nodeSnapshotHash?: string; contextHash?: string; dependencySnapshotHash?: string;
  judgment: GeneralJudgment; reason: string; support: string[]; counterEvidence: string[]; gaps: string[]; applicability: string; nextActions: string[];
  /** Stamped by trusted host, NEVER by a request field. */
  reviewer: { kind: 'human'; identity: string; actionId: string };
  createdAt: string;
}
const iso = (v: unknown): string => { const s = str(v, 'timestamp', 100, true); if (!Number.isFinite(Date.parse(s))) throw new Error('Invalid analysis timestamp'); return s; };
const textList = (v: unknown, label: string): string[] => list(v, label, 100).map(x => str(x, label, 4000, true));
export function validateDatasetInputRef(v: unknown): DatasetInputRef {
  const d = object(v, ['datasetId', 'version', 'sourceId', 'sourceSha256', 'tableId', 'dictionarySha256'], 'dataset input');
  return { datasetId: str(d.datasetId, 'datasetId', 200, true), version: num(d.version, 'dataset version', 1, 1000), sourceId: str(d.sourceId, 'sourceId', 200, true), sourceSha256: hash(d.sourceSha256), tableId: str(d.tableId, 'tableId', 200, true), dictionarySha256: hash(d.dictionarySha256) };
}
function ideaRef(v: unknown): GeneralAnalysisPlan['idea'] {
  if (v === null) return null;
  const i = object(v, ['ideaId', 'revision'], 'idea input'); return { ideaId: str(i.ideaId, 'ideaId', 200, true), revision: num(i.revision, 'Idea revision', 1, 2001) };
}
const columns = (v: unknown, label: string, max: number): number[] => { const a = list(v, label, max).map(x => num(x, label, 0, 199)); if (new Set(a).size !== a.length) throw new Error(`Duplicate ${label}`); return a; };
export function validateAnalysisPlan(v: unknown): GeneralAnalysisPlan {
  const p = object(v, ['planId', 'version', 'nodeId', 'nodeSnapshotHash', 'title', 'goal', 'dataset', 'idea', 'method', 'numericColumns', 'groupBy', 'sampleColumns', 'rowRange', 'missingPolicy', 'missingGroupPolicy', 'requiredConditions', 'comparisonScope', 'limitations', 'createdAt', 'contextHash', 'dependencySnapshotHash', 'metricContext', 'nodeContext', 'importedOrigin'], 'analysis plan', ['contextHash', 'dependencySnapshotHash', 'metricContext', 'nodeContext', 'importedOrigin']);
  const method = one(p.method, ANALYSIS_METHODS, 'method');
  if (p.nodeContext !== undefined && validateGeneralNode(p.nodeContext).nodeId !== p.nodeId) throw new Error('Analysis node context identity mismatch');
  const range = object(p.rowRange, ['start', 'end'], 'row range');
  const rowRange = { start: num(range.start, 'range start', 0, 50000), end: num(range.end, 'range end', 0, 50000) };
  if (rowRange.end < rowRange.start) throw new Error('Invalid row range');
  const numericColumns = columns(p.numericColumns, 'numeric columns', 50), groupBy = columns(p.groupBy, 'group columns', 4), sampleColumns = columns(p.sampleColumns, 'sample columns', 4);
  if (!numericColumns.length) throw new Error('At least one numeric column is required');
  if (method === 'descriptive' && groupBy.length) throw new Error('Descriptive method cannot silently group rows');
  if (method === 'grouped_descriptive' && !groupBy.length) throw new Error('Grouped method requires grouping columns');
  if ((method === 'repeated_summary') !== (sampleColumns.length > 0)) throw new Error('Sample identity is required only for repeated summary');
  if (sampleColumns.some(c => numericColumns.includes(c) || groupBy.includes(c))) throw new Error('Sample identity cannot double as metric or group');
  return { ...(p.importedOrigin === undefined ? {} : { importedOrigin: validateGeneralImportedPlanOrigin(p.importedOrigin) }), ...(p.nodeContext === undefined ? {} : { nodeContext: validateGeneralNode(p.nodeContext) }), ...(p.metricContext === undefined ? {} : { metricContext: validateMetricContext(p.metricContext) }), ...(p.contextHash === undefined ? {} : { contextHash: hash(p.contextHash) }), ...(p.dependencySnapshotHash === undefined ? {} : { dependencySnapshotHash: hash(p.dependencySnapshotHash) }), planId: str(p.planId, 'planId', 200, true), version: num(p.version, 'plan version', 1, 1000), nodeId: str(p.nodeId, 'nodeId', 200, true), nodeSnapshotHash: hash(p.nodeSnapshotHash), title: str(p.title, 'title', 300, true), goal: str(p.goal, 'goal', 4000, true), dataset: validateDatasetInputRef(p.dataset), idea: ideaRef(p.idea), method, numericColumns, groupBy, sampleColumns, rowRange, missingPolicy: one(p.missingPolicy, ['available_cases'] as const, 'missingPolicy'), missingGroupPolicy: one(p.missingGroupPolicy, ['separate', 'exclude'] as const, 'missingGroupPolicy'), requiredConditions: textList(p.requiredConditions, 'required conditions'), comparisonScope: str(p.comparisonScope, 'comparisonScope', 4000, true), limitations: textList(p.limitations, 'limitations'), createdAt: iso(p.createdAt) };
}
/** Strict bounded wire validation. Integrity/ownership is checked against the saved snapshot by the service. */
export function validateCalculationArtifact(v: unknown): CalculationArtifact {
  const a = object(v, ['schemaVersion', 'kind', 'plan', 'sourceNature', 'inputSnapshot', 'tool', 'selection', 'summaries', 'warnings', 'chart', 'startedAt', 'finishedAt'], 'calculation artifact');
  if (a.schemaVersion !== 1 || a.kind !== 'descriptive_calculation') throw new Error('Invalid calculation artifact kind/version');
  const plan = validateAnalysisPlan(a.plan);
  const snapshot = object(a.inputSnapshot, ['sourceHash', 'parsedHash', 'parser', 'dictionaryHash', 'excludedRows', 'fields', 'conditions'], 'artifact input snapshot');
  const tool = object(a.tool, ['name', 'version', 'runtime', 'formulae'], 'artifact tool');
  const s = object(a.selection, ['totalRows', 'rangeRows', 'excludedRows', 'missingGroupRows', 'includedRows'], 'artifact selection');
  const selection = { totalRows: num(s.totalRows, 'totalRows', 0, 50000), rangeRows: num(s.rangeRows, 'rangeRows', 0, 50000), excludedRows: num(s.excludedRows, 'excludedRows', 0, 50000), missingGroupRows: num(s.missingGroupRows, 'missingGroupRows', 0, 50000), includedRows: num(s.includedRows, 'includedRows', 0, 50000) };
  if (selection.totalRows < plan.rowRange.end || selection.rangeRows !== plan.rowRange.end - plan.rowRange.start || selection.rangeRows !== selection.excludedRows + selection.missingGroupRows + selection.includedRows) throw new Error('Invalid calculation artifact selection counts');
  const finite = (v: unknown): number | null => { if (v === null) return null; if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid finite artifact statistic'); return v; };
  const summaries = list(a.summaries, 'artifact summaries', 10000).map(v => {
    const r = object(v, ['group', 'column', 'label', 'unit', 'rowCount', 'statistics', 'sampleCount'], 'artifact summary');
    const group = list(r.group, 'summary group', 4).map(v => { const g = object(v, ['column', 'label', 'value'], 'group'); if (g.value !== null && typeof g.value !== 'boolean' && typeof g.value !== 'string' && !(typeof g.value === 'number' && Number.isFinite(g.value))) throw new Error('Invalid group value'); return { column: num(g.column, 'group column', 0, 199), label: str(g.label, 'group label', 300, true), value: g.value as string | number | boolean | null }; });
    if (JSON.stringify(group.map(g => g.column)) !== JSON.stringify(plan.groupBy)) throw new Error('Artifact grouping differs from plan');
    const st = object(r.statistics, ['count', 'missing', 'mean', 'median', 'min', 'max', 'sampleSD'], 'artifact statistics');
    const statistics = { count: num(st.count, 'count', 0, 50000), missing: num(st.missing, 'missing', 0, 50000), mean: finite(st.mean), median: finite(st.median), min: finite(st.min), max: finite(st.max), sampleSD: finite(st.sampleSD) };
    const rowCount = num(r.rowCount, 'rowCount', 0, 50000), sampleCount = r.sampleCount === null ? null : num(r.sampleCount, 'sampleCount', 0, rowCount);
    if ((plan.method === 'repeated_summary') !== (sampleCount !== null) || statistics.count + statistics.missing !== (sampleCount ?? rowCount) || rowCount > selection.includedRows) throw new Error('Artifact sample/count semantics differ from plan');
    const values = [statistics.mean, statistics.median, statistics.min, statistics.max];
    if (statistics.count === 0 ? values.some(v => v !== null) : values.some(v => v === null)) throw new Error('Empty/nonempty artifact statistics disagree');
    if ((statistics.count < 2) !== (statistics.sampleSD === null) || statistics.sampleSD !== null && statistics.sampleSD < 0 || statistics.min !== null && statistics.max !== null && statistics.min > statistics.max) throw new Error('Invalid artifact uncertainty or extrema');
    const column = num(r.column, 'summary column', 0, 199); if (!plan.numericColumns.includes(column)) throw new Error('Artifact has an unselected metric column');
    return { group, column, label: str(r.label, 'summary label', 300, true), unit: str(r.unit, 'summary unit', 4000, true), rowCount, sampleCount, statistics };
  });
  const groups = new Map<string, { columns: Set<number>; rowCount: number }>();
  for (const r of summaries) { const key = JSON.stringify(r.group); if (!groups.has(key)) groups.set(key, { columns: new Set(), rowCount: r.rowCount }); const group = groups.get(key)!; if (group.columns.has(r.column) || group.rowCount !== r.rowCount) throw new Error('Duplicate/inconsistent artifact summary'); group.columns.add(r.column); }
  if (groups.size > 200 || [...groups.values()].some(g => g.columns.size !== plan.numericColumns.length) || [...groups.values()].reduce((n, g) => n + g.rowCount, 0) !== selection.includedRows) throw new Error('Incomplete or excessive artifact groups');
  if (!plan.groupBy.length && groups.size !== 1) throw new Error('Ungrouped artifact requires explicit empty/nonempty summary');
  const chart = list(a.chart, 'artifact charts', 50).map(v => { const c = object(v, ['kind', 'unit', 'series'], 'artifact chart'); return { kind: one(c.kind, ['mean_by_group'] as const, 'chart kind'), unit: str(c.unit, 'chart unit', 4000, true), series: list(c.series, 'chart series', 200).map(v => { const s = object(v, ['label', 'mean', 'count'], 'chart series'); return { label: str(s.label, 'series label', 50000), mean: finite(s.mean), count: num(s.count, 'series count', 0, 50000) }; }) }; });
  return { schemaVersion: 1, kind: 'descriptive_calculation', plan, sourceNature: one(a.sourceNature, ['literature', 'user_observation', 'user_result', 'simulation', 'hypothesis', 'inference', 'unknown'] as const, 'artifact nature'), inputSnapshot: { sourceHash: hash(snapshot.sourceHash), parsedHash: hash(snapshot.parsedHash), parser: str(snapshot.parser, 'snapshot parser', 200, true), dictionaryHash: hash(snapshot.dictionaryHash), excludedRows: list(snapshot.excludedRows, 'snapshot exclusions', 50000).map(v => num(v, 'excluded row', 0, 49999)), fields: list(snapshot.fields, 'snapshot fields', 200), conditions: list(snapshot.conditions, 'snapshot conditions', 100) }, tool: { name: str(tool.name, 'tool name', 200, true), version: str(tool.version, 'tool version', 100, true), runtime: str(tool.runtime, 'runtime', 100, true), formulae: list(tool.formulae, 'tool formulae', 100).map(v => str(v, 'tool formula', 4000, true)) }, selection, summaries, warnings: list(a.warnings, 'artifact warnings', 100).map(v => str(v, 'warning', 4000, true)), chart, startedAt: iso(a.startedAt), finishedAt: iso(a.finishedAt) };
}
export function validateCalculation(v: unknown): GeneralCalculation {
  const c = object(v, ['calculationId', 'planId', 'planVersion', 'nodeId', 'attempt', 'status', 'provenance', 'inputNature', 'input', 'idea', 'tool', 'artifact', 'firstError', 'startedAt', 'finishedAt', 'checks'], 'calculation');
  const tool = object(c.tool, ['name', 'version', 'runtime'], 'tool');
  let artifact: GeneralCalculation['artifact'] = null, firstError: GeneralCalculation['firstError'] = null;
  if (c.artifact !== null) { const a = object(c.artifact, ['id', 'sha256'], 'artifact'); const h = hash(a.sha256); if (a.id !== `artifacts/${h}.json`) throw new Error('Invalid calculation artifact locator'); artifact = { id: a.id as string, sha256: h }; }
  if (c.firstError !== null) { const e = object(c.firstError, ['code', 'message'], 'first error'); firstError = { code: str(e.code, 'error code', 100, true), message: str(e.message, 'error message', 4000, true) }; }
  const status = one(c.status, ['completed', 'blocked', 'failed'] as const, 'calculation status');
  if ((status === 'completed') !== (artifact !== null && firstError === null)) throw new Error('Calculation status/artifact mismatch');
  if (status !== 'completed' && (!firstError || artifact)) throw new Error('Failed calculation must retain first error without success artifact');
  const checks = one(c.checks, ['calculation_completed', 'conditions_unsatisfied', 'calculation_failed'] as const, 'checks');
  if (checks !== (status === 'completed' ? 'calculation_completed' : status === 'blocked' ? 'conditions_unsatisfied' : 'calculation_failed')) throw new Error('Calculation check/status mismatch');
  return { calculationId: str(c.calculationId, 'calculationId', 200, true), planId: str(c.planId, 'planId', 200, true), planVersion: num(c.planVersion, 'planVersion', 1, 1000), nodeId: str(c.nodeId, 'nodeId', 200, true), attempt: num(c.attempt, 'attempt', 1, 10), status, provenance: one(c.provenance, ['system_calculation'] as const, 'provenance'), inputNature: one(c.inputNature, ['literature', 'user_observation', 'user_result', 'simulation', 'hypothesis', 'inference', 'unknown'] as const, 'inputNature'), input: validateDatasetInputRef(c.input), idea: ideaRef(c.idea), tool: { name: str(tool.name, 'tool name', 200, true), version: str(tool.version, 'tool version', 100, true), runtime: str(tool.runtime, 'runtime', 100, true) }, artifact, firstError, startedAt: iso(c.startedAt), finishedAt: iso(c.finishedAt), checks };
}
export function validateGeneralReview(v: unknown): GeneralReview {
  const r = object(v, ['reviewId', 'nodeId', 'calculationIds', 'sourceRefs', 'inferenceRunIds', 'judgment', 'reason', 'support', 'counterEvidence', 'gaps', 'applicability', 'nextActions', 'reviewer', 'createdAt', 'nodeSnapshotHash', 'contextHash', 'dependencySnapshotHash'], 'review', ['inferenceRunIds', 'nodeSnapshotHash', 'contextHash', 'dependencySnapshotHash']);
  const reviewer = object(r.reviewer, ['kind', 'identity', 'actionId'], 'reviewer');
  return { ...(r.nodeSnapshotHash === undefined ? {} : { nodeSnapshotHash: hash(r.nodeSnapshotHash) }), ...(r.contextHash === undefined ? {} : { contextHash: hash(r.contextHash) }), ...(r.dependencySnapshotHash === undefined ? {} : { dependencySnapshotHash: hash(r.dependencySnapshotHash) }), reviewId: str(r.reviewId, 'reviewId', 200, true), nodeId: str(r.nodeId, 'nodeId', 200, true), calculationIds: textList(r.calculationIds, 'calculationIds'), sourceRefs: textList(r.sourceRefs, 'sourceRefs'), inferenceRunIds: [...new Set(textList(r.inferenceRunIds ?? [], 'inferenceRunIds'))], judgment: one(r.judgment, REVIEW_JUDGMENTS, 'judgment'), reason: str(r.reason, 'reason', 4000, true), support: textList(r.support, 'support'), counterEvidence: textList(r.counterEvidence, 'counterEvidence'), gaps: textList(r.gaps, 'gaps'), applicability: str(r.applicability, 'applicability', 4000, true), nextActions: textList(r.nextActions, 'nextActions'), reviewer: { kind: one(reviewer.kind, ['human'] as const, 'reviewer kind'), identity: str(reviewer.identity, 'identity', 200, true), actionId: str(reviewer.actionId, 'actionId', 200, true) }, createdAt: iso(r.createdAt) };
}
