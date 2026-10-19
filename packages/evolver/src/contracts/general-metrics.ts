/** Versioned evaluation protocols. Goals, source reports and actual calculations never collapse into a score. */
export interface MetricCell { metricId: string; value: number | null; unit: string | null; status: 'recorded' | 'missing' | 'unit_mismatch'; targetStatus: 'not_configured' | 'met' | 'not_met' | 'unknown'; delta: number | null }
export interface MetricMatrixRow {
  rowId: string; protocolId: string; version: number; label: string; role: string; variantKey: string | null; parentKey: string | null;
  origin: 'system_calculation' | 'source_reported'; inputNature: string; status: string; check: 'provenance_checked' | 'source_reported' | 'unavailable';
  calculationId: string | null; sourceId: string; locator: string; attempt: number | null; group: string;
  cells: MetricCell[]; blockers: string[]; comparisonReasons: string[]; comparedTo: string | null;
  constraintsStatus: 'passed' | 'failed' | 'unknown' | 'not_configured'; selectionStatus: 'needs_validation' | 'not_eligible';
}
export interface GeneralMetricProjection { protocols: GeneralMetricProtocol[]; reports: GeneralMetricReport[]; rows: MetricMatrixRow[]; errors: { calculationId: string; message: string }[]; boundary: string }
import { object, str, num, list, one, hash } from './general-data.ts';
import type { DatasetVersion } from './general-data.ts';
export const METRIC_PROJECTION_LIMITS = Object.freeze({ maxRows: 10000, maxArtifactBytes: 64 * 1024 * 1024 });
export const METRIC_STATISTICS = ['mean', 'median', 'min', 'max', 'sampleSD', 'count'] as const;
export type MetricStatistic = typeof METRIC_STATISTICS[number];
export interface GeneralMetric {
  metricId: string; name: string; definition: string; role: 'primary' | 'auxiliary' | 'constraint'; priority: number;
  direction: 'maximize' | 'minimize' | 'range' | 'observe'; unit: string | null; required: boolean;
  target: { min: number | null; max: number | null }; rationale: string;
  binding: { fieldLabel: string; statistic: MetricStatistic } | null;
}
export interface GeneralMetricProtocol {
  protocolId: string; version: number; status: 'draft' | 'frozen'; goal: string; metrics: GeneralMetric[];
  requiredConditions: string[]; variedConditions: string[]; comparisonScope: string;
  contextHash: string | null; reason: string; createdAt: string;
}
export interface GeneralMetricContext {
  protocolId: string; version: number; variantKey: string; label: string;
  role: 'baseline' | 'candidate' | 'parent' | 'ablation'; parentKey: string | null;
}
export interface GeneralMetricReport {
  reportId: string; protocolId: string; version: number; label: string; sourceId: string;
  locator: string; values: { metricId: string; value: number | null; unit: string }[];
  conditions: { name: string; value: string | null; unit: string | null }[];
  note: string; createdAt: string;
  /** External-result link. Absent on reports saved before batch 3. */
  nodeId?: string | null;
  externalRunId?: string | null;
  match?: 'evidenced' | 'pending' | 'unmatched';
  matchReason?: string;
  comparability?: 'comparable' | 'incomparable' | 'pending';
  comparabilityReason?: string;
}
const finite = (v: unknown, label: string): number | null => {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Invalid finite ' + label);
  return v;
};
function date(v: unknown): string { const s = str(v, 'createdAt', 100, true); if (!Number.isFinite(Date.parse(s))) throw new Error('Invalid metric timestamp'); return s; }
export function validateGeneralMetric(v: unknown): GeneralMetric {
  const m = object(v, ['metricId', 'name', 'definition', 'role', 'priority', 'direction', 'unit', 'required', 'target', 'rationale', 'binding'], 'metric');
  const t = object(m.target, ['min', 'max'], 'metric target');
  const target = { min: finite(t.min, 'target min'), max: finite(t.max, 'target max') };
  if (target.min !== null && target.max !== null && target.min > target.max) throw new Error('Metric target interval reversed');
  if (typeof m.required !== 'boolean') throw new Error('Metric required must be boolean');
  let binding: GeneralMetric['binding'] = null;
  if (m.binding !== null) { const b = object(m.binding, ['fieldLabel', 'statistic'], 'metric binding'); binding = { fieldLabel: str(b.fieldLabel, 'fieldLabel', 300, true), statistic: one(b.statistic, METRIC_STATISTICS, 'statistic') }; }
  if (binding?.statistic === 'count' && m.unit !== null && m.unit !== '1') throw new Error('Metric count requires dimensionless unit 1');
  return { metricId: str(m.metricId, 'metricId', 200, true), name: str(m.name, 'metric name', 300, true), definition: str(m.definition, 'definition', 4000, true), role: one(m.role, ['primary', 'auxiliary', 'constraint'] as const, 'metric role'), priority: num(m.priority, 'priority', 1, 100), direction: one(m.direction, ['maximize', 'minimize', 'range', 'observe'] as const, 'direction'), unit: m.unit === null ? null : str(m.unit, 'unit', 100, true), required: m.required, target, rationale: str(m.rationale, 'rationale', 4000, true), binding };
}
export function validateMetricProtocol(v: unknown): GeneralMetricProtocol {
  const p = object(v, ['protocolId', 'version', 'status', 'goal', 'metrics', 'requiredConditions', 'variedConditions', 'comparisonScope', 'contextHash', 'reason', 'createdAt'], 'metric protocol');
  const metrics = list(p.metrics, 'metrics', 50).map(validateGeneralMetric);
  if (!metrics.length || new Set(metrics.map(m => m.metricId)).size !== metrics.length) throw new Error('Metrics must be nonempty and have distinct identities');
  const strings = (v: unknown) => list(v, 'conditions', 100).map(x => str(x, 'condition', 300, true));
  const requiredConditions = strings(p.requiredConditions), variedConditions = strings(p.variedConditions);
  if (new Set(requiredConditions).size !== requiredConditions.length || new Set(variedConditions).size !== variedConditions.length || requiredConditions.some(c => variedConditions.includes(c))) throw new Error('Conditions must be distinct; controls cannot also be varied');
  const status = one(p.status, ['draft', 'frozen'] as const, 'protocol status');
  const contextHash = p.contextHash === null ? null : hash(p.contextHash);
  if ((status === 'frozen') !== (contextHash !== null)) throw new Error('Frozen protocol requires pinned research context');
  if (status === 'frozen' && metrics.some(m => m.role === 'constraint' && (m.target.min === null && m.target.max === null || !m.required || !m.unit))) throw new Error('Frozen hard constraints require bounds, units and required=true');
  return { protocolId: str(p.protocolId, 'protocolId', 200, true), version: num(p.version, 'metric version', 1, 201), status, goal: str(p.goal, 'metric goal', 4000, true), metrics, requiredConditions, variedConditions, comparisonScope: str(p.comparisonScope, 'comparisonScope', 4000, true), contextHash, reason: str(p.reason, 'change reason', 4000, true), createdAt: date(p.createdAt) };
}
export function validateMetricContext(v: unknown): GeneralMetricContext {
  const c = object(v, ['protocolId', 'version', 'variantKey', 'label', 'role', 'parentKey'], 'metric context');
  const result = { protocolId: str(c.protocolId, 'protocolId', 200, true), version: num(c.version, 'metric version', 1, 201), variantKey: str(c.variantKey, 'variantKey', 200, true), label: str(c.label, 'variant label', 300, true), role: one(c.role, ['baseline', 'candidate', 'parent', 'ablation'] as const, 'variant role'), parentKey: c.parentKey === null ? null : str(c.parentKey, 'parentKey', 200, true) };
  if (result.variantKey === result.parentKey) throw new Error('Variant cannot be its own parent');
  return result;
}
export function validateMetricReport(v: unknown): GeneralMetricReport {
  const r = object(v, ['reportId', 'protocolId', 'version', 'label', 'sourceId', 'locator', 'values', 'conditions', 'note', 'createdAt', 'nodeId', 'externalRunId', 'match', 'matchReason', 'comparability', 'comparabilityReason'], 'metric report', ['nodeId', 'externalRunId', 'match', 'matchReason', 'comparability', 'comparabilityReason']);
  const values = list(r.values, 'reported values', 50).map(v => { const x = object(v, ['metricId', 'value', 'unit'], 'reported value'); return { metricId: str(x.metricId, 'metricId', 200, true), value: finite(x.value, 'reported value'), unit: str(x.unit, 'reported unit', 100, true) }; });
  if (new Set(values.map(v => v.metricId)).size !== values.length) throw new Error('Duplicate reported metric');
  const conditions = list(r.conditions, 'reported conditions', 100).map(v => { const c = object(v, ['name', 'value', 'unit'], 'reported condition'); return { name: str(c.name, 'condition name', 300, true), value: c.value === null ? null : str(c.value, 'condition value'), unit: c.unit === null ? null : str(c.unit, 'condition unit', 100) }; });
  if (new Set(conditions.map(c => c.name)).size !== conditions.length) throw new Error('Duplicate reported condition');
  const report: GeneralMetricReport = { reportId: str(r.reportId, 'reportId', 200, true), protocolId: str(r.protocolId, 'protocolId', 200, true), version: num(r.version, 'metric version', 1, 201), label: str(r.label, 'report label', 300, true), sourceId: str(r.sourceId, 'report source', 200, true), locator: str(r.locator, 'source locator', 4000, true), values, conditions, note: str(r.note, 'report note', 4000, true), createdAt: date(r.createdAt) };
  if ('nodeId' in r) report.nodeId = r.nodeId === null ? null : str(r.nodeId, 'report node', 200, true);
  if ('externalRunId' in r) report.externalRunId = r.externalRunId === null ? null : str(r.externalRunId, 'external run id', 200, true);
  if ('match' in r) report.match = one(r.match, ['evidenced', 'pending', 'unmatched'] as const, 'report match');
  if ('matchReason' in r) report.matchReason = str(r.matchReason, 'match reason', 4000, true);
  if ('comparability' in r) report.comparability = one(r.comparability, ['comparable', 'incomparable', 'pending'] as const, 'comparability');
  if ('comparabilityReason' in r) report.comparabilityReason = str(r.comparabilityReason, 'comparability reason', 4000, true);
  if (report.match === 'evidenced' && !report.nodeId) throw new Error('Evidenced external result requires a research node');
  return report;
}
/** Identity survives removal/reintroduction; scoped to a protocol, not just its adjacent versions. */
export function validateMetricIdentityHistory(protocols: readonly GeneralMetricProtocol[]): void {
  const history = new Map<string, Map<string, string>>();
  for (const protocol of protocols) {
    let identities = history.get(protocol.protocolId);
    if (!identities) { identities = new Map(); history.set(protocol.protocolId, identities); }
    for (const metric of protocol.metrics) {
      const signature = JSON.stringify({ definition: metric.definition, unit: metric.unit, binding: metric.binding });
      const previous = identities.get(metric.metricId);
      if (previous !== undefined && previous !== signature) throw new Error('指标定义、单位或计算绑定改变时须使用新 metricId；身份不能跨历史版本复用。');
      identities.set(metric.metricId, signature);
    }
  }
}
/** Deterministic, explicitly provisional suggestions: no fabricated direction, target, unit or evaluator. */
export function suggestMetricProtocol(input: { protocolId: string; version: number; question: string; datasets: DatasetVersion[]; now: string }): GeneralMetricProtocol {
  const latest = input.datasets.filter(d => !input.datasets.some(n => n.datasetId === d.datasetId && n.version > d.version));
  const outcomes = latest.flatMap(d => d.fields.filter(f => f.type === 'number' && f.role === 'outcome'));
  const seen = new Set<string>();
  const units = new Map<string, Set<string | null>>();
  for (const field of outcomes) { if (!units.has(field.label)) units.set(field.label, new Set()); units.get(field.label)!.add(field.conversion?.targetUnit ?? field.unit); }
  const identity = (label: string, unit: string | null) => { let value = 14695981039346656037n; for (const ch of JSON.stringify([label, 'mean', unit])) { value ^= BigInt(ch.codePointAt(0)!); value = BigInt.asUintN(64, value * 1099511628211n); } return 'outcome-' + value.toString(16); };
  const metrics: GeneralMetric[] = outcomes.filter(f => { if (seen.has(f.label) || units.get(f.label)!.size > 1) return false; seen.add(f.label); return true; }).slice(0, 50).map((f, i) => ({ metricId: identity(f.label, f.conversion?.targetUnit ?? f.unit), name: f.label, definition: '已确认结果字段「' + f.label + '」的均值；聚合口径须在分析方案中固定。', role: i === 0 ? 'primary' : 'auxiliary', priority: i + 1, direction: 'observe', unit: f.conversion?.targetUnit ?? f.unit, required: i === 0, target: { min: null, max: null }, rationale: '来自本研究已登记结果字段，建议待确认；对应目标：' + input.question.slice(0, 2000), binding: { fieldLabel: f.label, statistic: 'mean' } }));
  if (!metrics.length) metrics.push({ metricId: 'research-outcome', name: '研究目标对应指标（待定义）', definition: '尚缺已确认结果字段与评价方法，不能把默认指标冒充适合所有学科。', role: 'primary', priority: 1, direction: 'observe', unit: null, required: true, target: { min: null, max: null }, rationale: '围绕研究问题「' + input.question.slice(0, 2000) + '」补充可检验指标；未生成目标值或结果。', binding: null });
  return validateMetricProtocol({ protocolId: input.protocolId, version: input.version, status: 'draft', goal: input.question, metrics, requiredConditions: [...new Set(latest.flatMap(d => d.conditions.map(c => c.name)))], variedConditions: [], comparisonScope: '仅按冻结指标定义和实际数据条件比较；条件未知时不排名。', contextHash: null, reason: '根据研究目标与已确认字段生成建议草案，待确认；建表不执行实验。', createdAt: input.now });
}
