/**
 * W2 报告展示层 · 组件 barrel。
 *
 * W3 与旗舰集成从这里导入只读报告组件与纯展示逻辑；
 * 组件输出语义 rp- 类名，不 import 样式文件（视觉由 W1 样式/旗舰注入）。
 */
export { ReportPresentation } from './ReportPresentation.tsx';
export type { ReportPresentationProps } from './ReportPresentation.tsx';
export { MetricTable } from './MetricTable.tsx';
export type { MetricTableProps } from './MetricTable.tsx';
export { ComparisonChart } from './ComparisonChart.tsx';
export type { ComparisonChartProps } from './ComparisonChart.tsx';
export { EvidenceCards } from './EvidenceCards.tsx';
export type { EvidenceCardsProps } from './EvidenceCards.tsx';
export { LimitationsNotice } from './LimitationsNotice.tsx';
export type { LimitationsNoticeProps } from './LimitationsNotice.tsx';
export { TermDisclosure } from './TermDisclosure.tsx';
export type { TermDisclosureProps } from './TermDisclosure.tsx';
export { ProcessSteps } from './ProcessSteps.tsx';
export type { ProcessStepsProps } from './ProcessSteps.tsx';

export {
  UNKNOWN_VALUE_TEXT,
  formatMetricValue,
  deltaText,
  describeMetricCell,
  metricTargetText,
  pickMetricColumns,
  pickSummarySlices,
  freshnessStatusText,
  evidenceStatusText,
  evidenceCheckText,
  calcCheckText,
  calcStatusText,
  reviewJudgmentText,
  knowledgeNatureText,
  matrixOriginText,
  matrixCheckText,
  constraintsStatusText,
  selectionStatusText,
} from './formatValue.ts';
export type { MetricCellDisplay, MetricColumn, SummarySlice } from './formatValue.ts';

export {
  FIXTURE_MOCK_NOTICE,
  buildMockFactPackRead,
  mockMetricProtocols,
  mockMetricRows,
  mockSummaryRows,
  mockKnowledge,
  mockReviews,
  mockPlans,
  mockCalculations,
  mockTerms,
} from './fixtures.ts';
