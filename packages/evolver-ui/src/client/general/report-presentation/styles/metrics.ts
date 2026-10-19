/**
 * W1 报告展示层 · 指标矩阵与统计摘要样式（作用域 `.rp`）。
 *
 * 硬性约定：
 * - 0 与 null 严格区分：0 用实数值单元格；null 渲染为「未知（无值）」占位（○ 符号 + 虚线框），
 *   绝不把 null 显示为 0，也绝不把 0 显示为空。
 * - 差值列只展示输入实际提供的 delta，未提供的显示「—（未提供）」；绝对差值须带单位说明。
 * - 单位不一致单元格用波浪下划线 + ⇹ 符号标注，不做自动换算。
 * - 长表头可换行，长表在 .rp-table-wrap 内横向滚动（键盘可聚焦）。
 */

export const RP_METRICS_CSS = `
.rp .rp-table-wrap{overflow:auto;max-width:100%;min-width:0;border:1px solid var(--rp-line);border-radius:10px;scrollbar-width:thin}
.rp .rp-table-wrap:focus-visible{outline:3px solid #426cdf;outline-offset:2px}
.rp table.rp-table{border-collapse:separate;border-spacing:0;width:100%;min-width:640px;font-size:12px}
.rp table.rp-table caption{text-align:left;padding:10px 12px;font-size:11px;color:var(--rp-muted);border-bottom:1px solid var(--rp-line);overflow-wrap:anywhere}
.rp table.rp-table th,.rp table.rp-table td{padding:9px 12px;border-bottom:1px solid var(--rp-line);text-align:left;vertical-align:top;overflow-wrap:anywhere;min-width:0}
.rp table.rp-table thead th{position:sticky;top:0;background:var(--rp-surface);z-index:5;font-size:11px;letter-spacing:.2px;border-bottom:2px solid var(--rp-line);white-space:normal}
.rp table.rp-table tbody tr:last-child td,.rp table.rp-table tbody tr:last-child th{border-bottom:0}
.rp table.rp-table tbody th{font-weight:600;background:#fbfcfe;white-space:normal}
.rp table.rp-table td.rp-num,.rp table.rp-table th.rp-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.rp .rp-val{font-variant-numeric:tabular-nums;font-weight:600}
.rp .rp-val-zero{font-variant-numeric:tabular-nums;font-weight:600;color:var(--rp-ink)}
.rp .rp-val-zero::after{content:"（0 是实测值，不是缺失）";font-size:10px;font-weight:400;color:var(--rp-muted)}
.rp .rp-val-null{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums;color:var(--rp-muted);border:1px dashed #9aa7b6;border-radius:5px;padding:0 6px;font-size:11px}
.rp .rp-val-null::before{content:"○"}
.rp .rp-unit{font-size:11px;color:var(--rp-muted);font-weight:400;margin-left:4px;white-space:nowrap}
.rp .rp-cell-unit-mismatch .rp-val{text-decoration:underline wavy var(--rp-amber) 1px;text-underline-offset:3px}
.rp .rp-delta{font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--rp-ink)}
/* 差值只呈现符号与数值，不用颜色预设"好坏"：favorability 取决于指标方向（maximize/minimize），
   由 W2 组件按 protocol 方向渲染；本层不自行判断。 */
.rp .rp-delta-pos::before{content:"+ "}
.rp .rp-delta-neg::before{content:"− "}
.rp .rp-delta-neutral{color:var(--rp-muted)}
.rp .rp-delta-none{color:var(--rp-muted);font-size:11px}
.rp .rp-target{font-size:11px}
.rp .rp-rowgroup-note{font-size:11px;color:var(--rp-muted);padding:6px 12px;border-bottom:1px solid var(--rp-line);background:#fbfcfe;overflow-wrap:anywhere}
.rp .rp-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;min-width:0}
.rp .rp-stat{border:1px solid var(--rp-line);border-radius:8px;padding:10px 12px;background:#fbfcfe;min-width:0}
.rp .rp-stat dt{font-size:11px;color:var(--rp-muted)}
.rp .rp-stat dd{margin:2px 0 0;font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.rp .rp-stat .rp-stat-note{display:block;font-size:10px;font-weight:400;color:var(--rp-muted)}
@media (max-width:650px){.rp table.rp-table{min-width:520px}.rp .rp-val-zero::after{content:"（0=实测）"}}
`;

/** 指标表 class 名注册表。 */
export const RP_METRIC_CLASS_NAMES = Object.freeze({
  tableWrap: 'rp-table-wrap',
  table: 'rp-table',
  numeric: 'rp-num',
  value: 'rp-val',
  valueZero: 'rp-val-zero',
  valueNull: 'rp-val-null',
  unit: 'rp-unit',
  cellUnitMismatch: 'rp-cell-unit-mismatch',
  delta: 'rp-delta',
  deltaPos: 'rp-delta-pos',
  deltaNeg: 'rp-delta-neg',
  deltaNeutral: 'rp-delta-neutral',
  deltaNone: 'rp-delta-none',
  target: 'rp-target',
  rowGroupNote: 'rp-rowgroup-note',
  stats: 'rp-stats',
  stat: 'rp-stat',
  statNote: 'rp-stat-note',
});
