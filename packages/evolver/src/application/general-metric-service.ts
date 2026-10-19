import { BootstrapError, type BootstrapState } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch, type GeneralResearch } from '../contracts/general-research.ts';
import { METRIC_PROJECTION_LIMITS, validateMetricProtocol, validateMetricReport, validateMetricIdentityHistory, suggestMetricProtocol, type GeneralMetricProtocol, type GeneralMetricReport, type GeneralMetric, type MetricCell, type MetricMatrixRow, type GeneralMetricProjection } from '../contracts/general-metrics.ts';
import type { CalculationArtifact, SummaryRow } from '../contracts/general-analysis.ts';
import { ResearchBootstrapStore, requireResearch } from './research-bootstrap-store.ts';
import { GeneralAnalysisService, generalContextHash, calculationFreshness } from './general-analysis-service.ts';
import { GeneralMaterialStore } from './general-material-store.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { externalResultLocator } from '../contracts/external-result-locator.ts';
interface Write { operationId: string; baseRevision: number; researchId: string }
export type { MetricCell, MetricMatrixRow, GeneralMetricProjection } from '../contracts/general-metrics.ts';
function cell(metric: GeneralMetric, value: number | null, unit: string | null): MetricCell {
  const mismatch = value !== null && (metric.unit === null || metric.unit !== unit);
  const targetConfigured = metric.target.min !== null || metric.target.max !== null;
  return { metricId: metric.metricId, value, unit, status: mismatch ? 'unit_mismatch' : value === null ? 'missing' : 'recorded', delta: null,
    targetStatus: !targetConfigured ? 'not_configured' : value === null || mismatch ? 'unknown' : (metric.target.min === null || value >= metric.target.min) && (metric.target.max === null || value <= metric.target.max) ? 'met' : 'not_met' };
}
function rowPolicy(row: MetricMatrixRow, protocol: GeneralMetricProtocol): void {
  const constraints = protocol.metrics.filter(m => m.role === 'constraint').map(m => row.cells.find(c => c.metricId === m.metricId)!);
  row.constraintsStatus = !constraints.length ? 'not_configured' : constraints.some(c => c.targetStatus === 'not_met') ? 'failed' : constraints.every(c => c.targetStatus === 'met') ? 'passed' : 'unknown';
  if (row.constraintsStatus === 'failed') row.blockers.push('硬约束未满足，不能由其他高指标抵消。');
  if (row.constraintsStatus === 'unknown') row.blockers.push('硬约束未测或单位不一致。');
  for (const m of protocol.metrics.filter(m => m.required)) if (row.cells.find(c => c.metricId === m.metricId)!.status !== 'recorded') row.blockers.push('必需指标「' + m.name + '」未完整测量。');
  if (row.origin === 'source_reported') row.blockers.push('来源报告不是本地验证观察，不能自动晋升候选。');
  if (!['user_observation', 'user_result'].includes(row.inputNature)) row.blockers.push('输入为 ' + row.inputNature + '；不作为实测科研收益。');
  row.selectionStatus = row.blockers.length ? 'not_eligible' : 'needs_validation';
}
export class GeneralMetricService {
  readonly store: ResearchBootstrapStore;
  private readonly limits: { maxRows: number; maxArtifactBytes: number };
  /** Trusted configuration may tighten resource ceilings; no request can increase them. */
  constructor(store: ResearchBootstrapStore, limits: { maxRows?: number; maxArtifactBytes?: number } = {}) {
    this.store = store; this.limits = { ...METRIC_PROJECTION_LIMITS, ...limits };
    for (const key of ['maxRows', 'maxArtifactBytes'] as const) if (!Number.isSafeInteger(this.limits[key]) || this.limits[key] < 1 || this.limits[key] > METRIC_PROJECTION_LIMITS[key]) throw new BootstrapError('INVALID_INPUT', '指标投影限额只能收紧既定上限。');
  }
  suggest(input: Write & { protocolId?: string | null }) {
    return this.store.mutate({ ...input, kind: 'suggest_general_metrics', requestPayload: { researchId: input.researchId, protocolId: input.protocolId ?? null }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究');
      const previous = input.protocolId ? g.metricProtocols.filter(p => p.protocolId === input.protocolId).sort((a, b) => a.version - b.version).at(-1) : undefined;
      if (input.protocolId && !previous) throw new BootstrapError('NOT_FOUND', '指标协议不属于该研究');
      const protocol = suggestMetricProtocol({ protocolId: previous?.protocolId ?? context.mint('metric-protocol'), version: (previous?.version ?? 0) + 1, question: g.ideas.map(i => i.question).join('；'), datasets: g.datasets, now: context.now() });
      g.metricProtocols.push(protocol); g.revision++; r.general = validateGeneralResearch(g); r.updatedAt = context.now();
      return { changed: true, result: { protocolId: protocol.protocolId, version: protocol.version } };
    } });
  }
  save(input: Write & { protocolId?: string | null; protocol: Omit<GeneralMetricProtocol, 'protocolId' | 'version' | 'createdAt' | 'contextHash'> }) {
    return this.store.mutate({ ...input, kind: 'save_general_metric_protocol', requestPayload: { researchId: input.researchId, protocolId: input.protocolId ?? null, protocol: input.protocol }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究');
      const previous = input.protocolId ? g.metricProtocols.filter(p => p.protocolId === input.protocolId).sort((a, b) => a.version - b.version).at(-1) : undefined;
      if (input.protocolId && !previous) throw new BootstrapError('NOT_FOUND', '指标协议不属于该研究');
      // Always append. Freezing or editing never rewrites historical definitions/results.
      const protocol = validateMetricProtocol({ ...input.protocol, protocolId: previous?.protocolId ?? context.mint('metric-protocol'), version: (previous?.version ?? 0) + 1, contextHash: input.protocol.status === 'frozen' ? generalContextHash(g) : null, createdAt: context.now() });
      try { validateMetricIdentityHistory([...g.metricProtocols, protocol]); }
      catch (error) { throw new BootstrapError('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }
      g.metricProtocols.push(protocol); g.revision++; r.general = validateGeneralResearch(g); r.updatedAt = context.now();
      return { changed: true, result: { protocolId: protocol.protocolId, version: protocol.version } };
    } });
  }
  report(input: Write & { report: Omit<GeneralMetricReport, 'reportId' | 'createdAt'> }) {
    return this.store.mutate({ ...input, kind: 'register_general_metric_report', requestPayload: { researchId: input.researchId, report: input.report }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究');
      const report = validateMetricReport({ ...input.report, reportId: context.mint('metric-report'), createdAt: context.now() });
      const source = g.sources.find(s => s.sourceId === report.sourceId);
      if (!source) throw new BootstrapError('SOURCE_MISSING', '报告来源不属于该研究');
      assertGeneralSourceAccess(g, source.sourceId);
      new GeneralMaterialStore(this.store.workspaceRoot).readRaw(source);
      g.metricReports.push(report); g.revision++; r.general = validateGeneralResearch(g); r.updatedAt = context.now();
      return { changed: true, result: { reportId: report.reportId } };
    } });
  }
  projection(researchId: string, snapshot?: BootstrapState): GeneralMetricProjection | null {
    const state = snapshot ?? this.store.readStateOrEmpty();
    const g = requireResearch(state, researchId).general;
    if (!g) return null;
    const rows: MetricMatrixRow[] = [], errors: GeneralMetricProjection['errors'] = [];
    const actual = new Map<string, CalculationArtifact>();
    const boundary = '来源与格式检查不等于独立实验验证；不提供综合分或自动排名。差值仅为冻结口径下的数值比较，不证明显著性、因果或科研收益。未绑定指标协议的旧运行保持原样，不补造新指标。';
    let artifactBytes = 0;
    const overLimit = (calculationId: string, message: string): GeneralMetricProjection => ({ protocols: g.metricProtocols, reports: g.metricReports, rows: [], errors: [...errors, { calculationId, message }], boundary: boundary + ' 本次矩阵不可用：' + message + '；没有截断后挑选参照或生成差值，历史记录仍保留。' });
    const analysis = new GeneralAnalysisService(this.store), materials = new GeneralMaterialStore(this.store.workspaceRoot);
    const sourceChecks = new Map<string, string | null>();
    const checkSource = (sourceId: string, parsed: boolean): string | null => {
      const key = sourceId + (parsed ? ':parsed' : ':raw');
      if (sourceChecks.has(key)) return sourceChecks.get(key)!;
      const source = g.sources.find(s => s.sourceId === sourceId)!;
      let error: string | null = null;
      try { assertGeneralSourceAccess(g, source.sourceId); if (parsed) { materials.readParsed(source); sourceChecks.set(sourceId + ':raw', null); } else materials.readRaw(source); }
      catch (e) { error = '来源资料不可核验：' + (e instanceof Error ? e.message : String(e)); }
      sourceChecks.set(key, error); return error;
    };
    const contextHash = generalContextHash(g);
    for (const calculation of g.calculations) {
      const plan = g.plans.find(p => p.planId === calculation.planId && p.version === calculation.planVersion)!;
      const ref = plan.metricContext;
      if (!ref) continue;
      const protocol = g.metricProtocols.find(p => p.protocolId === ref.protocolId && p.version === ref.version)!;
      let content: CalculationArtifact | null = null;
      try {
        content = analysis.readCalculation(researchId, calculation.calculationId, state).content;
        if (content) { const sourceError = checkSource(calculation.input.sourceId, true); if (sourceError) throw new Error(sourceError); }
      }
      catch (e) { content = null; errors.push({ calculationId: calculation.calculationId, message: e instanceof Error ? e.message : String(e) }); }
      const summaries = new Map<string, Map<string, SummaryRow>>();
      if (content) {
        artifactBytes += Buffer.byteLength(JSON.stringify(content), 'utf8');
        if (artifactBytes > this.limits.maxArtifactBytes) return overLimit(calculation.calculationId, '校验后产物内容累计超过指标投影字节上限');
        for (const summary of content.summaries) { const group = JSON.stringify(summary.group); if (!summaries.has(group)) summaries.set(group, new Map()); summaries.get(group)!.set(summary.label, summary); }
      }
      const groups = summaries.size ? [...summaries.keys()] : ['[]'];
      if (rows.length + groups.length > this.limits.maxRows) return overLimit(calculation.calculationId, '结果行超过指标投影行数上限');
      const freshness = calculationFreshness(g, calculation);
      for (let i = 0; i < groups.length; i++) {
        const group = groups[i];
        const row: MetricMatrixRow = { rowId: calculation.calculationId + ':' + i, protocolId: ref.protocolId, version: ref.version, label: ref.label, role: ref.role, variantKey: ref.variantKey, parentKey: ref.parentKey, origin: 'system_calculation', inputNature: calculation.inputNature, status: calculation.status, check: content ? 'provenance_checked' : 'unavailable', calculationId: calculation.calculationId, sourceId: calculation.input.sourceId, locator: plan.dataset.tableId + ' rows [' + plan.rowRange.start + ', ' + plan.rowRange.end + ')', attempt: calculation.attempt, group,
          cells: protocol.metrics.map(m => { const summary = m.binding ? summaries.get(group)?.get(m.binding.fieldLabel) : undefined; return cell(m, summary && m.binding ? summary.statistics[m.binding.statistic] : null, m.binding?.statistic === 'count' ? '1' : summary?.unit ?? null); }), blockers: [], comparisonReasons: [], comparedTo: null, constraintsStatus: 'unknown', selectionStatus: 'needs_validation' };
        if (!content) row.blockers.push(calculation.firstError?.message ?? errors.find(e => e.calculationId === calculation.calculationId)?.message ?? '实际产物不可读取或不完整。');
        row.blockers.push(...freshness.reasons);
        if (protocol.contextHash !== contextHash) row.blockers.push('研究目标或约束已变化，指标协议待重审。');
        rowPolicy(row, protocol); rows.push(row);
        if (content) actual.set(row.rowId, content);
      }
    }
    if (rows.length + g.metricReports.length > this.limits.maxRows) return overLimit('', '结果与来源报告合计超过指标投影行数上限');
    for (const report of g.metricReports) {
      const protocol = g.metricProtocols.find(p => p.protocolId === report.protocolId && p.version === report.version)!;
      const source = g.sources.find(s => s.sourceId === report.sourceId)!;
      const row: MetricMatrixRow = { rowId: report.reportId, protocolId: report.protocolId, version: report.version, label: report.label, role: 'reference', variantKey: null, parentKey: null, origin: 'source_reported', inputNature: source.nature, status: 'reported', check: 'source_reported', calculationId: null, sourceId: source.sourceId, locator: externalResultLocator(report), attempt: null, group: '[]', cells: protocol.metrics.map(m => { const value = report.values.find(v => v.metricId === m.metricId); return cell(m, value?.value ?? null, value?.unit ?? null); }), blockers: [], comparisonReasons: ['来源报告与本地计算并列展示，不假定评价方法/条件已独立核验。', ...(report.comparabilityReason ? [report.comparabilityReason] : []), ...(report.match ? ['实验匹配：' + report.match + (report.matchReason ? '。' + report.matchReason : '')] : [])], comparedTo: null, constraintsStatus: 'unknown', selectionStatus: 'not_eligible' };
      const sourceError = checkSource(source.sourceId, false);
      if (sourceError) { row.check = 'unavailable'; row.blockers.push(sourceError); }
      if (protocol.contextHash !== contextHash) row.blockers.push('研究目标或约束已变化，指标协议待重审。');
      if (g.sources.some(s => s.previousSourceId === source.sourceId)) row.blockers.push('报告来源已有新版本，待复核。');
      rowPolicy(row, protocol); rows.push(row);
    }
    const baselineIndex = new Map<string, MetricMatrixRow[]>(), variantIndex = new Map<string, MetricMatrixRow[]>();
    const indexKey = (row: MetricMatrixRow, variant: string | null = null) => JSON.stringify([row.protocolId, row.version, row.group, variant]);
    const index = (map: Map<string, MetricMatrixRow[]>, key: string, row: MetricMatrixRow) => { if (!map.has(key)) map.set(key, []); map.get(key)!.push(row); };
    for (const row of rows) if (row.origin === 'system_calculation') { if (row.role === 'baseline') index(baselineIndex, indexKey(row), row); index(variantIndex, indexKey(row, row.variantKey), row); }
    for (const row of rows.filter(r => r.origin === 'system_calculation')) {
      if (row.role === 'baseline' && !row.parentKey) { row.comparisonReasons.push('参照行；未通过挑选最佳 attempt 生成基线。'); continue; }
      const candidates = (row.parentKey ? variantIndex.get(indexKey(row, row.parentKey)) : baselineIndex.get(indexKey(row)))?.filter(b => b.rowId !== row.rowId) ?? [];
      if (candidates.length !== 1) { row.comparisonReasons.push(candidates.length ? '有多个同条件参照 attempt，请保留全体记录并明确配对，不自动择优。' : '没有同版本、同分组的唯一 Baseline/父方案。'); continue; }
      const baseline = candidates[0], a = actual.get(row.rowId), b = actual.get(baseline.rowId);
      const protocol = g.metricProtocols.find(p => p.protocolId === row.protocolId && p.version === row.version)!;
      const reasons = this.comparisonReasons(g, protocol, row, baseline, a ?? null, b ?? null);
      row.comparisonReasons.push(...reasons);
      if (!reasons.length) {
        row.comparedTo = baseline.rowId;
        for (const c of row.cells) { const reference = baseline.cells.find(v => v.metricId === c.metricId)!; if (c.status === 'recorded' && reference.status === 'recorded') { const delta = c.value! - reference.value!; if (Number.isFinite(delta)) c.delta = delta; else row.comparisonReasons.push('差值溢出，不登记有限数值。'); } }
      }
    }
    return { protocols: g.metricProtocols, reports: g.metricReports, rows, errors, boundary };
  }
  private comparisonReasons(g: GeneralResearch, protocol: GeneralMetricProtocol, a: MetricMatrixRow, b: MetricMatrixRow, ca: CalculationArtifact | null, cb: CalculationArtifact | null): string[] {
    const reasons: string[] = [];
    if (!ca || !cb) return ['参照或当前实际产物不可用。'];
    if (a.blockers.length || b.blockers.length) reasons.push('当前或参照存在缺项、过期输入或约束问题，不能直接比较。');
    if (a.inputNature !== b.inputNature) reasons.push('来源性质不同，不将模拟与实测混合比较。');
    if (ca.plan.method !== cb.plan.method || ca.plan.missingPolicy !== cb.plan.missingPolicy || ca.plan.missingGroupPolicy !== cb.plan.missingGroupPolicy) reasons.push('统计方法或缺失/聚合口径不一致。');
    if (ca.plan.comparisonScope !== cb.plan.comparisonScope) reasons.push('分析方案比较范围说明不同，需先对齐。');
    for (const c of a.cells) { const ref = b.cells.find(v => v.metricId === c.metricId)!; if (c.status === 'recorded' && ref.status === 'recorded' && c.unit !== ref.unit) reasons.push('指标单位不同，不隐式换算或排名。'); }
    const da = g.datasets.find(d => d.datasetId === ca.plan.dataset.datasetId && d.version === ca.plan.dataset.version)!, db = g.datasets.find(d => d.datasetId === cb.plan.dataset.datasetId && d.version === cb.plan.dataset.version)!;
    for (const name of protocol.requiredConditions) {
      const x = da.conditions.find(c => c.name === name), y = db.conditions.find(c => c.name === name);
      if (!x?.value?.trim() || !y?.value?.trim()) reasons.push('所需条件「' + name + '」未知。');
      else if (x.value !== y.value || x.unit !== y.unit) reasons.push('所需条件「' + name + '」不一致。');
    }
    const controls = (d: typeof da) => d.conditions.filter(c => !protocol.variedConditions.includes(c.name)).sort((x, y) => x.name.localeCompare(y.name));
    if (JSON.stringify(controls(da)) !== JSON.stringify(controls(db))) reasons.push('实际固定条件不一致；变量只能在冻结协议中显式声明。');
    if (controls(da).some(c => !c.value?.trim()) || controls(db).some(c => !c.value?.trim())) reasons.push('实际固定条件含未知项。');
    if (a.sourceId !== b.sourceId && !protocol.requiredConditions.length) reasons.push('跨来源比较缺少明确控制条件，不能仅凭单位相同排名。');
    const fieldRecipe = (d: typeof da, p: CalculationArtifact['plan']) => {
      const fields = (columns: number[]) => columns.map(c => d.fields.find(f => f.column === c)!).map(f => ({ label: f.label, type: f.type, role: f.role, unit: f.unit, missingValues: [...new Set(f.missingValues)].sort(), conversion: f.conversion ? { scale: f.conversion.scale, offset: f.conversion.offset, targetUnit: f.conversion.targetUnit } : null })).sort((x, y) => x.label.localeCompare(y.label));
      const sharedBindings = protocol.metrics.filter(m => m.binding && a.cells.find(c => c.metricId === m.metricId)!.status === 'recorded' && b.cells.find(c => c.metricId === m.metricId)!.status === 'recorded').map(m => d.fields.find(f => f.label === m.binding!.fieldLabel)!.column);
      return { metrics: fields(sharedBindings), samples: fields(p.sampleColumns), groups: fields(p.groupBy), exclusions: [...d.excludedRows].sort((x, y) => x - y), range: p.rowRange, requiredConditions: [...p.requiredConditions].sort() };
    };
    if (JSON.stringify(fieldRecipe(da, ca.plan)) !== JSON.stringify(fieldRecipe(db, cb.plan))) reasons.push('指标处理/缺失值、分组或样本聚合、选择范围、条件要求或排除口径不同。');
    return [...new Set(reasons)];
  }
}
