/**
 * W2 报告展示层 · 纯展示逻辑辅助（无 React、无 DOM，可被 node --test 直接导入）。
 *
 * 原则：只决定“如何呈现输入”，不计算任何新数值——
 * - 0 与 null/未知严格分开：null 显示“未测”，绝不当 0；
 * - 单位不一致时显式标注双方单位；
 * - 不可比较保持不可比较：delta 为 null 时不产出差值文本；
 * - 状态一律用文字标注呈现，不只靠颜色；
 * - 只使用输入实际提供的比较理由，不自行计算差值或推断排名。
 */
import type { GeneralMetric, GeneralMetricProtocol, MetricCell, MetricMatrixRow } from '../../../../../../evolver/src/contracts/general-metrics.ts';
import type { SummaryRow } from '../../../../../../evolver/src/contracts/general-analysis.ts';
import type { GeneralReportFactPack } from '../../../../../../evolver/src/contracts/general-report.ts';

/** null 值的固定展示：未知/未测，绝不显示为 0。 */
export const UNKNOWN_VALUE_TEXT = '未测';

/** 数值展示：0 显示为 0；null 显示“未测”；单位仅在输入提供时附加。 */
export function formatMetricValue(value: number | null, unit: string | null): string {
  if (value === null) return UNKNOWN_VALUE_TEXT;
  const text = String(value);
  return unit === null || unit === '' ? text : `${text} ${unit}`;
}

/** 差值文本：只在输入提供了 delta 时产出；delta 为 null（不可比较/未提供）时返回 null，不显示差值。 */
export function deltaText(delta: number | null): string | null {
  if (delta === null) return null;
  return delta > 0 ? `+${delta}` : String(delta);
}

/** 单个指标单元格的展示决策。 */
export interface MetricCellDisplay {
  /** unknown = 值缺失（null），绝不渲染成 0 */
  kind: 'value' | 'unknown';
  valueText: string;
  /** 单位不一致标注（含双方单位）；一致时为 null */
  unitNote: string | null;
  /** 以文字呈现的状态标注（不只靠颜色） */
  notes: string[];
}

export function describeMetricCell(cell: MetricCell, metric: GeneralMetric | undefined): MetricCellDisplay {
  const notes: string[] = [];
  if (cell.status === 'missing') notes.push('未测');
  if (cell.status === 'unit_mismatch') notes.push('单位不一致');
  if (cell.targetStatus === 'met') notes.push('达标');
  if (cell.targetStatus === 'not_met') notes.push('未达标');
  if (cell.targetStatus === 'unknown') notes.push('目标无法判定');
  return {
    kind: cell.value === null ? 'unknown' : 'value',
    valueText: formatMetricValue(cell.value, cell.unit),
    unitNote:
      cell.status === 'unit_mismatch'
        ? `单位不一致：协议单位 ${metric?.unit ?? '未定义'}，记录单位 ${cell.unit ?? '未提供'}`
        : null,
    notes,
  };
}

/** 指标目标文本：只呈现输入配置的 min/max，不做方向推断。未配置时返回 null。 */
export function metricTargetText(metric: GeneralMetric): string | null {
  const min = metric.target.min;
  const max = metric.target.max;
  const unit = metric.unit === null || metric.unit === '' ? '' : ` ${metric.unit}`;
  if (min !== null && max !== null) return `目标 ${min}–${max}${unit}`;
  if (min !== null) return `目标 ≥ ${min}${unit}`;
  if (max !== null) return `目标 ≤ ${max}${unit}`;
  return null;
}

/** 指标表列选择：协议指标在前，行内出现但协议未覆盖的 metricId 追加在后并去重。 */
export interface MetricColumn {
  metricId: string;
  name: string;
  unit: string | null;
  targetText: string | null;
}

export function pickMetricColumns(protocols: GeneralMetricProtocol[], rows: MetricMatrixRow[]): MetricColumn[] {
  const columns: MetricColumn[] = [];
  const seen = new Set<string>();
  for (const protocol of protocols) {
    for (const metric of protocol.metrics) {
      if (seen.has(metric.metricId)) continue;
      seen.add(metric.metricId);
      columns.push({ metricId: metric.metricId, name: metric.name, unit: metric.unit, targetText: metricTargetText(metric) });
    }
  }
  for (const row of rows) {
    for (const cell of row.cells) {
      if (seen.has(cell.metricId)) continue;
      seen.add(cell.metricId);
      columns.push({ metricId: cell.metricId, name: cell.metricId, unit: cell.unit, targetText: null });
    }
  }
  return columns;
}

/** 对比图切片选择：只取输入里带 summaries 的计算；标题来自输入标识，不生成结论。 */
export interface SummarySlice {
  title: string;
  summaries: SummaryRow[];
}

export function pickSummarySlices(calculations: GeneralReportFactPack['calculations']): SummarySlice[] {
  return calculations
    .filter((entry) => entry.summaries.length > 0)
    .map((entry) => ({
      title: `计算 ${entry.calculation.calculationId}（尝试 ${entry.calculation.attempt}）`,
      summaries: entry.summaries,
    }));
}

/** 新鲜度状态文本（报告整体 / 计算条目共用）。 */
export function freshnessStatusText(status: 'current' | 'needs_review'): string {
  return status === 'current' ? '最新' : '待复核';
}

/** 知识条目证据状态文本；原因列表由调用方原样展示。 */
export function evidenceStatusText(status: 'current' | 'needs_review' | 'unavailable' | 'revoked' | 'unlocated'): string {
  switch (status) {
    case 'current':
      return '证据当前有效';
    case 'needs_review':
      return '证据待复核';
    case 'unavailable':
      return '证据不可用';
    case 'revoked':
      return '证据已撤销';
    case 'unlocated':
      return '证据未定位';
  }
}

export function evidenceCheckText(check: 'locator_checked' | 'unavailable' | 'unlocated'): string {
  switch (check) {
    case 'locator_checked':
      return '已核定位';
    case 'unavailable':
      return '定位核验不可用';
    case 'unlocated':
      return '未能定位';
  }
}

export function calcCheckText(check: 'provenance_checked' | 'unavailable'): string {
  return check === 'provenance_checked' ? '来源已核' : '来源核验不可用';
}

export function calcStatusText(status: 'completed' | 'blocked' | 'failed'): string {
  switch (status) {
    case 'completed':
      return '已完成';
    case 'blocked':
      return '被阻塞';
    case 'failed':
      return '失败';
  }
}

export function reviewJudgmentText(judgment: 'supported' | 'partial' | 'not_supported' | 'insufficient' | 'paused'): string {
  switch (judgment) {
    case 'supported':
      return '支持';
    case 'partial':
      return '部分支持';
    case 'not_supported':
      return '不支持';
    case 'insufficient':
      return '证据不足';
    case 'paused':
      return '已暂停';
  }
}

export function knowledgeNatureText(nature: 'hypothesis' | 'inference' | 'source_reported' | 'unknown'): string {
  switch (nature) {
    case 'hypothesis':
      return '假设';
    case 'inference':
      return '推断';
    case 'source_reported':
      return '来源报告';
    case 'unknown':
      return '性质未知';
  }
}

export function matrixOriginText(origin: 'system_calculation' | 'source_reported'): string {
  return origin === 'system_calculation' ? '系统计算' : '来源报告';
}

export function matrixCheckText(check: 'provenance_checked' | 'source_reported' | 'unavailable'): string {
  switch (check) {
    case 'provenance_checked':
      return '来源已核';
    case 'source_reported':
      return '来源报告';
    case 'unavailable':
      return '来源核验不可用';
  }
}

export function constraintsStatusText(status: 'passed' | 'failed' | 'unknown' | 'not_configured'): string {
  switch (status) {
    case 'passed':
      return '约束满足';
    case 'failed':
      return '约束未满足';
    case 'unknown':
      return '约束状态未知';
    case 'not_configured':
      return '未配置约束';
  }
}

export function selectionStatusText(status: 'needs_validation' | 'not_eligible'): string {
  return status === 'needs_validation' ? '待验证' : '不在比较范围';
}
