/**
 * U3 研究实验树的只读投影（纯函数，无 JSX）。
 *
 * F06 Top-K：仅冻结协议、可比（无 blockers/comparisonReasons）、主指标 delta 非空的行参与；
 * 按协议主指标方向排序；第 K 名的 delta 为 cutoff，并列全部保留。
 * 不挑 attempt、不混来源性质、不在这里下科学结论。
 */
import type { GeneralMetricProtocol, GeneralMetricProjection, MetricMatrixRow } from '../../../../evolver/src/contracts/general-metrics.ts';

export function computeTopK(rows: MetricMatrixRow[], protocols: GeneralMetricProtocol[], k: number): Set<string> {
  const result = new Set<string>();
  const bySet = new Map<string, Array<{ variantKey: string; delta: number; direction: string }>>();
  for (const r of rows) {
    if (!r.variantKey) continue;
    const protocol = protocols.find(p => p.protocolId === r.protocolId && p.version === r.version);
    if (!protocol || protocol.status !== 'frozen') continue;
    if (r.blockers.length > 0 || r.comparisonReasons.length > 0) continue;
    const primary = protocol.metrics.find(m => m.role === 'primary');
    if (!primary) continue;
    const cell = r.cells.find(c => c.metricId === primary.metricId);
    if (!cell || cell.delta === null) continue;
    const key = `${r.protocolId}:${r.version}:${r.group}`;
    const list = bySet.get(key) ?? [];
    list.push({ variantKey: r.variantKey, delta: cell.delta, direction: primary.direction });
    bySet.set(key, list);
  }
  for (const list of bySet.values()) {
    const direction = list[0].direction;
    const sorted = [...list].sort((a, b) => direction === 'minimize' ? a.delta - b.delta : b.delta - a.delta);
    // K 名截断保留并列：取第 K 名的 delta 为 cutoff，所有优于或等于 cutoff 的候选都保留。
    const cutoff = sorted[Math.min(k, sorted.length) - 1]?.delta;
    for (const item of sorted) {
      if (cutoff === undefined || item.delta === cutoff || (direction === 'minimize' ? item.delta < cutoff : item.delta > cutoff)) result.add(item.variantKey);
    }
  }
  return result;
}

export type { GeneralMetricProjection, MetricMatrixRow };
