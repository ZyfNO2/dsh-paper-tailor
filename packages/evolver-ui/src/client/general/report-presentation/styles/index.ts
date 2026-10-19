/**
 * W1 报告展示层 · styles barrel。
 *
 * W2 组件与旗舰集成从这里导入局部样式常量；注入方式由调用方决定
 * （如 <style>{RP_ALL_CSS}</style> 或既有样式注入通道）。
 * 全部选择器都在 `.rp` 作用域内，不污染工作台全局样式。
 */
export { RP_BASE_CSS, RP_LAYOUT_CSS, RP_CLASS_NAMES } from './core.ts';
export { RP_STATUS_CSS, RP_STATUS_CLASS_NAMES } from './status.ts';
export { RP_METRICS_CSS, RP_METRIC_CLASS_NAMES } from './metrics.ts';
export { RP_CHARTS_CSS, RP_CHART_CLASS_NAMES } from './charts.ts';
export { RP_TEACHING_CSS, RP_TEACHING_CLASS_NAMES } from './teaching.ts';

import { RP_BASE_CSS, RP_LAYOUT_CSS } from './core.ts';
import { RP_STATUS_CSS } from './status.ts';
import { RP_METRICS_CSS } from './metrics.ts';
import { RP_CHARTS_CSS } from './charts.ts';
import { RP_TEACHING_CSS } from './teaching.ts';

/** 全量组合样式（按 base→layout→status→metrics→charts→teaching 顺序拼接）。 */
export const RP_ALL_CSS = [
  RP_BASE_CSS,
  RP_LAYOUT_CSS,
  RP_STATUS_CSS,
  RP_METRICS_CSS,
  RP_CHARTS_CSS,
  RP_TEACHING_CSS,
].join('\n');
