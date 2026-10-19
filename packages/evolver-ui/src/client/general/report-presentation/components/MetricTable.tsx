/**
 * W2 报告展示层 · 指标表（只读）。
 *
 * 语义：0 与 null 严格分开（null 显示“未测”）；单位不一致标注双方单位；
 * delta 为 null（不可比较/未提供）时不显示差值；比较理由只展示输入提供的文本；
 * 状态用文字标注呈现，不只靠颜色；长表格由 .rp-table-wrap 滚动，不破版。
 */
import { Fragment } from 'react';
import type { GeneralMetric, GeneralMetricProtocol, MetricMatrixRow } from '../../../../../../evolver/src/contracts/general-metrics.ts';
import {
  constraintsStatusText,
  deltaText,
  describeMetricCell,
  matrixCheckText,
  matrixOriginText,
  pickMetricColumns,
  selectionStatusText,
} from './formatValue.ts';

export interface MetricTableProps {
  rows: MetricMatrixRow[];
  protocols: GeneralMetricProtocol[];
}

function rowDetailPairs(row: MetricMatrixRow): { label: string; value: string }[] {
  const pairs: { label: string; value: string }[] = [
    { label: '状态', value: row.status },
    { label: '来源', value: `${matrixOriginText(row.origin)} · ${matrixCheckText(row.check)}` },
    { label: '输入性质', value: row.inputNature },
  ];
  if (row.calculationId !== null) pairs.push({ label: '计算引用', value: row.calculationId });
  if (row.sourceId !== '') pairs.push({ label: '来源引用', value: row.locator === '' ? row.sourceId : `${row.sourceId} @ ${row.locator}` });
  if (row.attempt !== null) pairs.push({ label: '尝试次数', value: String(row.attempt) });
  if (row.variantKey !== null) pairs.push({ label: '变体', value: row.variantKey });
  if (row.parentKey !== null) pairs.push({ label: '父条目', value: row.parentKey });
  if (row.group !== '') pairs.push({ label: '分组', value: row.group });
  pairs.push({ label: '约束', value: constraintsStatusText(row.constraintsStatus) });
  pairs.push({ label: '比较资格', value: selectionStatusText(row.selectionStatus) });
  pairs.push({ label: '比较对象', value: row.comparedTo === null ? '未提供（不可比较，不显示差值）' : row.comparedTo });
  if (row.comparisonReasons.length > 0) pairs.push({ label: '比较理由（输入提供）', value: row.comparisonReasons.join('；') });
  if (row.blockers.length > 0) pairs.push({ label: '阻塞（输入提供）', value: row.blockers.join('；') });
  return pairs;
}

export function MetricTable({ rows, protocols }: MetricTableProps): JSX.Element {
  const columns = pickMetricColumns(protocols, rows);
  const metricById = new Map<string, GeneralMetric>();
  for (const protocol of protocols) {
    for (const metric of protocol.metrics) metricById.set(metric.metricId, metric);
  }
  return (
    <section className="rp-metric-table" aria-label="指标矩阵">
      <h3 className="rp-section-title">指标</h3>
      {protocols.length > 0 ? (
        <ul className="rp-metric-protocols">
          {protocols.map((protocol) => (
            <li key={protocol.protocolId}>
              指标协议 {protocol.protocolId} v{protocol.version}（{protocol.status === 'frozen' ? '已冻结' : '草稿'}）：{protocol.goal}
              ；比较范围：{protocol.comparisonScope}
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length === 0 ? (
        <p className="rp-empty">暂无指标行。</p>
      ) : (
        <div className="rp-table-wrap">
          <table className="rp-table">
            <thead>
              <tr>
                <th scope="col">条目</th>
                {columns.map((column) => (
                  <th key={column.metricId} scope="col">
                    <span className="rp-metric-name">{column.name}</span>
                    {column.unit !== null && column.unit !== '' ? <span className="rp-metric-unit">（{column.unit}）</span> : null}
                    {column.targetText !== null ? <span className="rp-metric-target">{column.targetText}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const cellById = new Map(row.cells.map((cell) => [cell.metricId, cell]));
                return (
                  <Fragment key={row.rowId}>
                    <tr className="rp-metric-row">
                      <th scope="row">
                        <span className="rp-row-label">{row.label}</span>
                        <span className="rp-row-notes">
                          {matrixOriginText(row.origin)} · {matrixCheckText(row.check)} · {selectionStatusText(row.selectionStatus)}
                        </span>
                      </th>
                      {columns.map((column) => {
                        const cell = cellById.get(column.metricId);
                        if (cell === undefined) {
                          return (
                            <td key={column.metricId} className="rp-cell rp-cell-na">
                              —（未提供）
                            </td>
                          );
                        }
                        const display = describeMetricCell(cell, metricById.get(cell.metricId));
                        const delta = deltaText(cell.delta);
                        return (
                          <td key={column.metricId} className={display.kind === 'unknown' ? 'rp-cell rp-cell-unknown' : 'rp-cell'}>
                            <span className="rp-cell-value">{display.valueText}</span>
                            {display.unitNote !== null ? <span className="rp-unit-note">{display.unitNote}</span> : null}
                            {display.notes.length > 0 ? <span className="rp-notes">{display.notes.join(' · ')}</span> : null}
                            {delta !== null ? <span className="rp-delta">差值 {delta}</span> : null}
                          </td>
                        );
                      })}
                    </tr>
                    <tr className="rp-row-detail">
                      <td colSpan={columns.length + 1}>
                        <dl className="rp-detail-list">
                          {rowDetailPairs(row).map((pair, index) => (
                            <div key={`${pair.label}-${index}`} className="rp-detail-item">
                              <dt>{pair.label}</dt>
                              <dd>{pair.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
