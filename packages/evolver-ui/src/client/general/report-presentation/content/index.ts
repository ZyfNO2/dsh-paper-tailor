/**
 * W1 报告展示层 · content barrel（横幅/图例/术语/模式说明文案）。
 * W2 组件与四份静态示例共用这里的同一组文案常量。
 */
export {
  RP_BANNER_MAIN,
  RP_BANNER_NOTE,
  RP_BANNER_NOTE_SHORT,
  RP_CHART_FOOTNOTE,
  RP_DELTA_FOOTNOTE,
  RP_QUIZ_CAVEAT,
  RP_DEMO_NOTE,
  RP_UNKNOWN_NOTE,
  RP_UNIT_MISMATCH_NOTE,
  RP_INCOMPARABLE_NOTE,
  RP_FROZEN_NOTE,
  RP_REVOKED_NOTE,
  RP_NEEDS_REVIEW_NOTE,
  RP_FAILED_BLOCKED_NOTE,
} from './banner.ts';
export { RP_LEGEND_ENTRIES, rpLegendById, type RpLegendEntry } from './legend.ts';
export { RP_TERM_ENTRIES, rpTermById, type RpTermEntry } from './terms.ts';
export { RP_MODE_COPIES, rpModeCopy, type RpModeCopy, type RpModeId } from './modes.ts';
