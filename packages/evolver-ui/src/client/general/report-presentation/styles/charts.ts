/**
 * W1 报告展示层 · 图表与图例样式（作用域 `.rp`）。
 *
 * 硬性约定：
 * - 每张图旁边必须保留数值表或文本替代（图表 + .rp-chart-table 成对出现）；
 * - 模拟系列用斜纹填充 + ▨ 符号 + 文字标注三重标识，不只靠颜色；
 * - 缺失值在图上显示「○ 未知」占位而不是 0 高度的柱子；
 * - 不画虚构误差线 / 显著性星号；如输入未提供区间，就不出现区间图形；
 * - prefers-reduced-motion 下柱条不做生长动画（core.ts 已全局关闭动画，这里保持静态渲染）。
 */

export const RP_CHARTS_CSS = `
.rp .rp-chart-pair{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:14px;min-width:0;align-items:start}
.rp .rp-chart{border:1px solid var(--rp-line);border-radius:10px;padding:14px;background:#fbfcfe;min-width:0}
.rp .rp-chart-title{font-size:12px;font-weight:650;margin-bottom:10px;overflow-wrap:anywhere}
.rp .rp-chart-svg{width:100%;height:auto;display:block}
.rp .rp-chart-svg text{font-family:inherit}
.rp .rp-bars{display:grid;gap:10px;min-width:0}
.rp .rp-bar-row{display:grid;grid-template-columns:minmax(90px,26%) 1fr auto;gap:10px;align-items:center;min-width:0}
.rp .rp-bar-label{font-size:11px;overflow-wrap:anywhere}
.rp .rp-bar-track{position:relative;height:16px;border-radius:4px;background:#e8edf3;border:1px solid var(--rp-line);min-width:0}
.rp .rp-bar{position:absolute;inset:0 auto 0 0;border-radius:3px 0 0 3px;background:var(--rp-blue)}
.rp .rp-bar-calc{background:var(--rp-green)}
.rp .rp-bar-sim{background:repeating-linear-gradient(45deg,#f0b429 0 5px,#f7d37b 5px 10px);border:1px dashed var(--rp-amber)}
.rp .rp-bar-null{position:absolute;inset:0;display:flex;align-items:center;padding-left:6px;font-size:10px;color:var(--rp-muted)}
.rp .rp-bar-null::before{content:"○"}
.rp .rp-bar-value{font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.rp .rp-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--rp-muted);margin-top:6px;border-top:1px solid var(--rp-line);padding-top:4px}
.rp .rp-chart-table{min-width:0}
.rp .rp-legend{display:flex;flex-wrap:wrap;gap:8px 14px;padding:10px 12px;border:1px solid var(--rp-line);border-radius:8px;background:var(--rp-surface);font-size:11px}
.rp .rp-legend-item{display:inline-flex;align-items:center;gap:6px;min-width:0}
.rp .rp-legend-item::before{content:attr(data-symbol);font-size:12px;font-style:normal;flex-shrink:0}
.rp .rp-legend-item[data-variant="sim"]{background:repeating-linear-gradient(45deg,#fff7e6 0 5px,#ffedb8 5px 10px);border:1px dashed var(--rp-amber);border-radius:5px;padding:1px 6px;color:#7a520b}
.rp .rp-legend-item[data-variant="unknown"]{border:1px dashed #9aa7b6;border-radius:5px;padding:1px 6px;color:var(--rp-muted)}
.rp .rp-legend-item[data-variant="failed"]{color:var(--rp-red);border:1px solid #efd4d4;border-radius:5px;padding:1px 6px}
.rp .rp-legend-item[data-variant="source"]{color:var(--rp-blue);border:1px solid #b7c9ee;border-radius:5px;padding:1px 6px}
.rp .rp-legend-item[data-variant="calc"]{color:var(--rp-green);border:1px solid #b9dcc9;border-radius:5px;padding:1px 6px}
.rp .rp-legend-item span{overflow-wrap:anywhere}
.rp figure.rp-figure{margin:0;min-width:0}
.rp figure.rp-figure figcaption{font-size:11px;color:var(--rp-muted);margin-top:8px;overflow-wrap:anywhere}
@media (max-width:960px){.rp .rp-chart-pair{grid-template-columns:1fr}}
`;

/** 图表 class 名注册表。 */
export const RP_CHART_CLASS_NAMES = Object.freeze({
  chartPair: 'rp-chart-pair',
  chart: 'rp-chart',
  chartTitle: 'rp-chart-title',
  chartSvg: 'rp-chart-svg',
  bars: 'rp-bars',
  barRow: 'rp-bar-row',
  barLabel: 'rp-bar-label',
  barTrack: 'rp-bar-track',
  bar: 'rp-bar',
  barCalc: 'rp-bar-calc',
  barSim: 'rp-bar-sim',
  barNull: 'rp-bar-null',
  barValue: 'rp-bar-value',
  axis: 'rp-axis',
  chartTable: 'rp-chart-table',
  legend: 'rp-legend',
  legendItem: 'rp-legend-item',
  figure: 'rp-figure',
});
