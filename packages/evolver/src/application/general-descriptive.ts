import type { DataField, DatasetVersion, RawCell, RawTable, MaterialNature } from '../contracts/general-data.ts';
import type { GeneralAnalysisPlan, CalculationArtifact, SummaryStatistics, SummaryRow } from '../contracts/general-analysis.ts';
import { interpretedCell } from './general-data-service.ts';
export const DESCRIPTIVE_TOOL = Object.freeze({ name: 'dsh-descriptive', version: '1.0.0' });
export const ANALYSIS_LIMITS = Object.freeze({ maxGroups: 200, maxMetrics: 50, maxSummaries: 10000, maxArtifactBytes: 16 * 1024 * 1024 });
export const DESCRIPTIVE_FORMULAE = [
  'mean = sum(valid values) / n; implemented with stable online mean',
  'median = middle value for odd n; average of two middle values for even n',
  'sampleSD = sqrt(sum((x - mean)^2) / (n - 1)); null when n < 2',
  'missing = selected included records without a valid value; never substituted by 0',
  'repeated_summary: first mean per real sample within each group, then describe those sample means',
  'No confidence intervals, significance tests, regression, causal inference or hypothesis validation',
];
export class CalculationBlocked extends Error {
  readonly code = 'CONDITIONS_UNSATISFIED';
  constructor(message: string) { super(message); this.name = 'CalculationBlocked'; }
}
export function describe(values: number[], missingCount = 0): SummaryStatistics {
  if (values.some(v => !Number.isFinite(v))) throw new Error('Cannot describe non-finite values');
  const count = values.length;
  if (!count) return { count: 0, missing: missingCount, mean: null, median: null, min: null, max: null, sampleSD: null };
  let mean = 0, m2 = 0, seen = 0;
  for (const value of values) { seen++; const delta = value - mean; mean += delta / seen; m2 += delta * (value - mean); }
  let sampleSD = count < 2 ? null : Math.sqrt(Math.max(0, m2 / (count - 1)));
  // Scale fallback only when direct accumulation overflows; results must still be finite.
  if (!Number.isFinite(mean) || (sampleSD !== null && (!Number.isFinite(sampleSD) || (sampleSD === 0 && values.some(v => v !== values[0]))))) {
    let scale = 0; for (const value of values) scale = Math.max(scale, Math.abs(value));
    let normalizedMean = 0, normalizedM2 = 0; seen = 0;
    for (const value of values) { seen++; const x = scale ? value / scale : 0; const delta = x - normalizedMean; normalizedMean += delta / seen; normalizedM2 += delta * (x - normalizedMean); }
    mean = normalizedMean * scale;
    sampleSD = count < 2 ? null : Math.sqrt(Math.max(0, normalizedM2 / (count - 1))) * scale;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const lower = sorted[Math.floor((count - 1) / 2)], upper = sorted[Math.floor(count / 2)];
  const median = count % 2 ? lower : lower === upper ? lower : Number.isFinite(upper - lower) ? lower + (upper - lower) / 2 : lower / 2 + upper / 2;
  if (!Number.isFinite(mean) || !Number.isFinite(median) || (sampleSD !== null && !Number.isFinite(sampleSD))) throw new Error('Descriptive arithmetic overflow; no fabricated finite result');
  return { count, missing: missingCount, mean, median, min: sorted[0], max: sorted[count - 1], sampleSD };
}
function field(dataset: DatasetVersion, column: number): DataField {
  const result = dataset.fields.find(f => f.column === column);
  if (!result) throw new CalculationBlocked(`未映射列 ${column}。`);
  return result;
}
export function calculateDescriptive(input: { plan: GeneralAnalysisPlan; dataset: DatasetVersion; table: RawTable; nature: MaterialNature; parsedHash: string; parser: string; runtime: string; startedAt: string; finishedAt: () => string }): CalculationArtifact {
  const { plan, dataset, table } = input;
  const selectedColumns = [...new Set([...plan.numericColumns, ...plan.groupBy, ...plan.sampleColumns])];
  for (const column of selectedColumns) {
    const f = field(dataset, column);
    if (plan.numericColumns.includes(column) && f.type !== 'number') throw new CalculationBlocked(`数值指标「${f.label}」尚未声明为数值。`);
    if (f.type === 'number' && !(f.conversion?.targetUnit ?? f.unit)?.trim()) throw new CalculationBlocked(`字段「${f.label}」单位未知；无量纲请明确填写 1。`);
    if (table.formulaColumns.includes(column)) throw new CalculationBlocked(`字段「${f.label}」含未计算的 Excel 公式，不能据此生成数值结果。`);
    if (plan.sampleColumns.includes(column) && f.role !== 'sample') throw new CalculationBlocked(`重复测量身份列「${f.label}」未确认 sample 角色，内部行 ID 不能替代真实样本。`);
  }
  for (const name of plan.requiredConditions) {
    const condition = dataset.conditions.find(c => c.name === name);
    if (!condition || condition.value === null || !condition.value.trim()) throw new CalculationBlocked(`本方法所需条件「${name}」未知。`);
  }
  if (plan.rowRange.end > table.rows.length) throw new CalculationBlocked('分析范围超过真实数据行数。');
  const excluded = new Set(dataset.excludedRows);
  const warnings = ['仅描述已有输入，不证明研究假设、不作因果或显著性结论。', '每个指标按明确的 available_cases 口径使用非缺失值；n 不是自动认定的独立样本量。'];
  if (input.nature === 'simulation') warnings.push('输入为模拟资料；本次计算是实际执行的数学汇总，但不构成用户实测观察。');
  if (['hypothesis', 'inference', 'unknown'].includes(input.nature)) warnings.push(`输入来源性质为 ${input.nature}，不能将汇总当作真实实验结果。`);
  if (plan.method !== 'repeated_summary' && dataset.fields.some(f => f.role === 'sample')) warnings.push('本模式汇总观察记录，不消除重复测量相关性；需要按样本等权汇总时使用 repeated_summary。');
  const groups = new Map<string, { values: RawCell[]; rows: { index: number; values: Map<number, RawCell> }[] }>();
  let excludedCount = 0, missingGroupRows = 0, includedRows = 0;
  for (let index = plan.rowRange.start; index < plan.rowRange.end; index++) {
    if (excluded.has(index)) { excludedCount++; continue; }
    const interpreted = new Map<number, RawCell>();
    for (const column of selectedColumns) {
      const result = interpretedCell(table.rows[index][column], field(dataset, column));
      if (result.error) throw new CalculationBlocked(`原始行 ${index} / 列 ${column}：${result.error}，需明确处理后再计算。`);
      interpreted.set(column, result.value);
    }
    const values = plan.groupBy.map(c => interpreted.get(c)!);
    if (values.some(v => v === null) && plan.missingGroupPolicy === 'exclude') { missingGroupRows++; continue; }
    if (plan.sampleColumns.some(c => interpreted.get(c) === null)) throw new CalculationBlocked(`原始行 ${index} 的真实样本身份缺失，无法重复测量汇总。`);
    const key = JSON.stringify(values);
    let group = groups.get(key);
    if (!group) { if (groups.size >= ANALYSIS_LIMITS.maxGroups) throw new CalculationBlocked(`分组数超过 ${ANALYSIS_LIMITS.maxGroups}；请明确缩小范围，不截断结果。`); group = { values, rows: [] }; groups.set(key, group); }
    group.rows.push({ index, values: interpreted }); includedRows++;
  }
  // Even an empty/all-excluded input produces an explicit null summary, never zero evidence.
  if (!groups.size && !plan.groupBy.length) groups.set('[]', { values: [], rows: [] });
  // Bound repeated group/metric text BEFORE constructing the serialized artifact.
  let estimatedBytes = Buffer.byteLength(JSON.stringify({ plan, fields: dataset.fields, conditions: dataset.conditions }), 'utf8');
  for (const group of groups.values()) {
    const descriptors = plan.groupBy.map((c, i) => ({ column: c, label: field(dataset, c).label, value: group.values[i] }));
    const groupBytes = Buffer.byteLength(JSON.stringify(descriptors), 'utf8');
    for (const column of plan.numericColumns) estimatedBytes += groupBytes * 2 + Buffer.byteLength(JSON.stringify(field(dataset, column)), 'utf8') + 1024;
  }
  if (estimatedBytes > ANALYSIS_LIMITS.maxArtifactBytes) throw new CalculationBlocked('分组 / 指标产物预计超过 16 MiB；请缩小范围或明确编码长文本，不截断结果。');
  const summaries: SummaryRow[] = [];
  for (const group of groups.values()) {
    for (const column of plan.numericColumns) {
      const f = field(dataset, column);
      let values: number[] = [], missingCount = 0, sampleCount: number | null = null;
      if (plan.method === 'repeated_summary') {
        const samples = new Map<string, number[]>();
        for (const row of group.rows) {
          const key = JSON.stringify(plan.sampleColumns.map(c => row.values.get(c)));
          if (!samples.has(key)) samples.set(key, []);
          const value = row.values.get(column);
          if (typeof value === 'number') samples.get(key)!.push(value);
        }
        sampleCount = samples.size;
        for (const measurements of samples.values()) { const mean = describe(measurements).mean; if (mean === null) missingCount++; else values.push(mean); }
      } else {
        for (const row of group.rows) { const value = row.values.get(column); if (typeof value === 'number') values.push(value); else missingCount++; }
      }
      summaries.push({ group: plan.groupBy.map((c, i) => ({ column: c, label: field(dataset, c).label, value: group.values[i] })), column, label: f.label, unit: f.conversion?.targetUnit ?? f.unit!, rowCount: group.rows.length, statistics: describe(values, missingCount), sampleCount });
    }
  }
  if (missingGroupRows) warnings.push(`按方案明确排除 ${missingGroupRows} 行分组值缺失记录，未偷偷归入有效组。`);
  if (!includedRows) warnings.push('选定范围没有纳入数据；空结果保留，不能视为科学证据。');
  return { schemaVersion: 1, kind: 'descriptive_calculation', plan: structuredClone(plan), sourceNature: input.nature,
    inputSnapshot: { sourceHash: dataset.sourceSha256, parsedHash: input.parsedHash, parser: input.parser, dictionaryHash: plan.dataset.dictionarySha256, excludedRows: [...dataset.excludedRows], fields: structuredClone(dataset.fields), conditions: structuredClone(dataset.conditions) },
    tool: { ...DESCRIPTIVE_TOOL, runtime: input.runtime, formulae: [...DESCRIPTIVE_FORMULAE] },
    selection: { totalRows: table.rows.length, rangeRows: plan.rowRange.end - plan.rowRange.start, excludedRows: excludedCount, missingGroupRows, includedRows }, summaries, warnings,
    chart: plan.numericColumns.map(column => ({ kind: 'mean_by_group', unit: field(dataset, column).conversion?.targetUnit ?? field(dataset, column).unit!, series: summaries.filter(s => s.column === column).map(s => ({ label: s.group.map(g => `${g.label}=${g.value === null ? '缺失分组' : g.value}`).join(' / ') || '全部纳入记录', mean: s.statistics.mean, count: s.statistics.count })) })),
    startedAt: input.startedAt, finishedAt: input.finishedAt() };
}
