/**
 * W2 报告展示层 · 对比图（只读 SVG + 必附数值表）。
 *
 * 硬性语义：条形长度只来自输入提供的 statistics.mean；mean 为 null 的行不画柱，
 * 显示“未测”（绝不当 0）；不绘制误差线、置信区间或显著性星号；不计算差值或排名；
 * 图表下方始终附完整数值表（含未测标注），状态与缺失用文字表达，不只靠颜色。
 */
import type { SummaryRow } from '../../../../../../evolver/src/contracts/general-analysis.ts';
import { UNKNOWN_VALUE_TEXT } from './formatValue.ts';

export interface ComparisonChartProps {
  summaries: SummaryRow[];
  title?: string;
}

const SVG_WIDTH = 640;
const ROW_HEIGHT = 34;
const LABEL_WIDTH = 150;
const PLOT_WIDTH = 420;
const VALUE_X = 610;
const BAR_HEIGHT = 18;

function groupLabel(row: SummaryRow): string {
  if (row.group.length === 0) return row.label;
  return row.group.map((g) => `${g.label}=${g.value === null ? '未提供' : String(g.value)}`).join('、');
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function stat(value: number | null): string {
  return value === null ? UNKNOWN_VALUE_TEXT : String(value);
}

export function ComparisonChart({ summaries, title }: ComparisonChartProps): JSX.Element {
  const chartTitle = title ?? '统计对比';
  const means = summaries.map((row) => row.statistics.mean);
  const hasNegative = means.some((mean) => mean !== null && mean < 0);
  const baselineX = hasNegative ? LABEL_WIDTH + PLOT_WIDTH / 2 : LABEL_WIDTH;
  const available = hasNegative ? PLOT_WIDTH / 2 : PLOT_WIDTH;
  const maxAbs = Math.max(0, ...means.map((mean) => (mean === null ? 0 : Math.abs(mean))));
  const svgHeight = summaries.length * ROW_HEIGHT + 10;
  return (
    <section className="rp-chart" aria-label={chartTitle}>
      <h3 className="rp-section-title">{chartTitle}</h3>
      {summaries.length === 0 ? (
        <p className="rp-empty">未提供可绘制的统计数据。</p>
      ) : (
        <>
          <p className="rp-chart-note">
            条形长度为各行输入提供的 mean；mean 未提供（null）的行不绘制条形并显示“{UNKNOWN_VALUE_TEXT}”。不绘制误差线或显著性标注，也不计算差值与排名。
          </p>
          <svg
            className="rp-chart-svg"
            role="img"
            aria-label={`${chartTitle}：均值条形图；精确数值以下方数值表为准`}
            viewBox={`0 0 ${SVG_WIDTH} ${svgHeight}`}
          >
            <title>{`${chartTitle}：均值条形图`}</title>
            <desc>各行为输入提供的均值；未提供均值的行显示未测。数值以随附表格为准。</desc>
            <line x1={baselineX} y1={0} x2={baselineX} y2={svgHeight} className="rp-chart-baseline" />
            {summaries.map((row, index) => {
              const mean = row.statistics.mean;
              const y = index * ROW_HEIGHT + 8;
              const barWidth = mean === null || maxAbs === 0 ? 0 : (Math.abs(mean) / maxAbs) * available;
              const barX = mean !== null && mean < 0 ? baselineX - barWidth : baselineX;
              return (
                <g key={`${row.label}-${index}`} className={mean === null ? 'rp-chart-row rp-chart-row-unknown' : 'rp-chart-row'}>
                  <text x={LABEL_WIDTH - 10} y={y + 14} textAnchor="end" className="rp-chart-label">
                    {truncate(groupLabel(row), 16)}
                  </text>
                  {mean === null ? null : <rect x={barX} y={y} width={barWidth} height={BAR_HEIGHT} className="rp-chart-bar" />}
                  <text x={VALUE_X} y={y + 14} textAnchor="end" className={mean === null ? 'rp-chart-value rp-chart-value-unknown' : 'rp-chart-value'}>
                    {stat(mean)}
                  </text>
                </g>
              );
            })}
          </svg>
          <div className="rp-table-wrap">
            <table className="rp-chart-table rp-table">
              <caption>数值表（与上图同一数据；数值以此表为准）</caption>
              <thead>
                <tr>
                  <th scope="col">分组</th>
                  <th scope="col">指标列</th>
                  <th scope="col">单位</th>
                  <th scope="col">行数</th>
                  <th scope="col">样本数</th>
                  <th scope="col">计数</th>
                  <th scope="col">缺失</th>
                  <th scope="col">均值</th>
                  <th scope="col">中位数</th>
                  <th scope="col">最小值</th>
                  <th scope="col">最大值</th>
                  <th scope="col">样本标准差</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((row, index) => (
                  <tr key={`${row.label}-t-${index}`} className={row.statistics.mean === null ? 'rp-chart-table-row-unknown' : undefined}>
                    <th scope="row">{groupLabel(row)}</th>
                    <td>
                      第 {row.column + 1} 列 · {row.label}
                    </td>
                    <td>{row.unit === '' ? '—' : row.unit}</td>
                    <td>{row.rowCount}</td>
                    <td>{row.sampleCount === null ? '—' : row.sampleCount}</td>
                    <td>{row.statistics.count}</td>
                    <td>{row.statistics.missing}</td>
                    <td>{stat(row.statistics.mean)}</td>
                    <td>{stat(row.statistics.median)}</td>
                    <td>{stat(row.statistics.min)}</td>
                    <td>{stat(row.statistics.max)}</td>
                    <td>{stat(row.statistics.sampleSD)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="rp-chart-sample-note">样本数一列有值时表示重复测量模式：统计量为“每个真实样本一个均值”之后的汇总（输入提供的语义）。</p>
        </>
      )}
    </section>
  );
}
