/**
 * 模拟数据，仅展示测试，不是真实研究数据。
 * 模拟数据，仅展示测试，不是真实研究数据。不是任何真实实验的结果。
 *
 * W2 组件开发/测试用的最小合法切片；形状对齐 evolver 真实只读契约。
 * 真实报告输入由旗舰接线提供；不得把这里的数字当作已验证科研结论。
 */
import type { GeneralFactPackRead, GeneralReportSelection, GeneralReportFactPack } from '../../../../../../evolver/src/contracts/general-report.ts';
import type { GeneralMetricProtocol, MetricMatrixRow } from '../../../../../../evolver/src/contracts/general-metrics.ts';
import type { GeneralAnalysisPlan, GeneralCalculation, SummaryRow } from '../../../../../../evolver/src/contracts/general-analysis.ts';

export const FIXTURE_MOCK_NOTICE = '模拟数据，仅展示测试，不是真实研究数据';

const MOCK_SHA256 = 'ab'.repeat(32);
const MOCK_ISO = '2026-10-13T00:00:00.000Z';

const mockSelection: GeneralReportSelection = {
  sourceIds: ['src-mock-1'],
  calculationIds: ['calc-mock-1', 'calc-mock-2'],
  knowledgeRefs: [{ entryId: 'kn-mock-1', version: 1 }],
  reviewIds: ['rev-mock-1'],
  inferenceRunIds: [],
};

/** 指标协议切片：覆盖 max/min 目标、未配置目标与单位。 */
export const mockMetricProtocols: GeneralMetricProtocol[] = [
  {
    protocolId: 'proto-mock-1',
    version: 1,
    status: 'frozen',
    goal: '模拟：比较基线 A 与变体 B',
    metrics: [
      {
        metricId: 'metric-f1',
        name: 'F1',
        definition: '模拟：精确率与召回率的调和平均',
        role: 'primary',
        priority: 1,
        direction: 'maximize',
        unit: null,
        required: true,
        target: { min: 0.75, max: null },
        rationale: '模拟说明',
        binding: null,
      },
      {
        metricId: 'metric-acc',
        name: '准确率',
        definition: '模拟：正确行数占比',
        role: 'auxiliary',
        priority: 2,
        direction: 'observe',
        unit: '%',
        required: false,
        target: { min: null, max: null },
        rationale: '模拟说明',
        binding: null,
      },
      {
        metricId: 'metric-lat',
        name: '延迟',
        definition: '模拟：单步耗时',
        role: 'constraint',
        priority: 3,
        direction: 'minimize',
        unit: 'ms',
        required: true,
        target: { min: null, max: 200 },
        rationale: '模拟说明',
        binding: null,
      },
    ],
    requiredConditions: ['模拟：同一数据集'],
    variedConditions: ['模拟：模型变体'],
    comparisonScope: '同一数据集内分组对比',
    contextHash: MOCK_SHA256,
    reason: '模拟：协议示例',
    createdAt: MOCK_ISO,
  },
];

/** 指标行切片：0 与 null 分开、单位不一致、不可比较、阻塞行。 */
export const mockMetricRows: MetricMatrixRow[] = [
  {
    rowId: 'row-baseline',
    protocolId: 'proto-mock-1',
    version: 1,
    label: '基线 A',
    role: 'baseline',
    variantKey: null,
    parentKey: null,
    origin: 'system_calculation',
    inputNature: 'user_result',
    status: 'final',
    check: 'provenance_checked',
    calculationId: 'calc-mock-1',
    sourceId: '',
    locator: '',
    attempt: 1,
    group: '',
    cells: [
      { metricId: 'metric-f1', value: 0.72, unit: null, status: 'recorded', targetStatus: 'not_met', delta: null },
      { metricId: 'metric-acc', value: 0, unit: '%', status: 'recorded', targetStatus: 'not_configured', delta: null },
      { metricId: 'metric-lat', value: null, unit: 'ms', status: 'missing', targetStatus: 'unknown', delta: null },
    ],
    blockers: [],
    comparisonReasons: [],
    comparedTo: null,
    constraintsStatus: 'passed',
    selectionStatus: 'needs_validation',
  },
  {
    rowId: 'row-variant',
    protocolId: 'proto-mock-1',
    version: 1,
    label: '变体 B',
    role: 'variant',
    variantKey: 'variant-b',
    parentKey: 'row-baseline',
    origin: 'system_calculation',
    inputNature: 'user_result',
    status: 'final',
    check: 'provenance_checked',
    calculationId: 'calc-mock-1',
    sourceId: '',
    locator: '',
    attempt: 1,
    group: '',
    cells: [
      { metricId: 'metric-f1', value: 0.76, unit: null, status: 'recorded', targetStatus: 'met', delta: 0.04 },
      { metricId: 'metric-acc', value: 82.5, unit: '%', status: 'recorded', targetStatus: 'unknown', delta: null },
      { metricId: 'metric-lat', value: 0.21, unit: 's', status: 'unit_mismatch', targetStatus: 'not_met', delta: null },
    ],
    blockers: [],
    comparisonReasons: ['模拟：同一数据集、同一指标口径'],
    comparedTo: 'row-baseline',
    constraintsStatus: 'passed',
    selectionStatus: 'needs_validation',
  },
  {
    rowId: 'row-imported',
    protocolId: 'proto-mock-1',
    version: 1,
    label: '文献报告值 C',
    role: 'reference',
    variantKey: null,
    parentKey: null,
    origin: 'source_reported',
    inputNature: 'literature',
    status: 'draft',
    check: 'source_reported',
    calculationId: null,
    sourceId: 'src-mock-1',
    locator: 'table 2',
    attempt: null,
    group: '',
    cells: [{ metricId: 'metric-f1', value: null, unit: null, status: 'missing', targetStatus: 'not_configured', delta: null }],
    blockers: ['模拟：来源口径未验证'],
    comparisonReasons: [],
    comparedTo: null,
    constraintsStatus: 'not_configured',
    selectionStatus: 'not_eligible',
  },
];

/** 统计行切片：mean 有值、mean 为 null（未测）、含 sampleCount 重复模式。 */
export const mockSummaryRows: SummaryRow[] = [
  {
    group: [{ column: 1, label: '分组', value: '基线 A' }],
    column: 3,
    label: 'F1（按分组均值）',
    unit: '',
    rowCount: 120,
    sampleCount: null,
    statistics: { count: 120, missing: 3, mean: 0.72, median: 0.71, min: 0.62, max: 0.79, sampleSD: 0.041 },
  },
  {
    group: [{ column: 1, label: '分组', value: '变体 B' }],
    column: 3,
    label: 'F1（按分组均值）',
    unit: '',
    rowCount: 120,
    sampleCount: null,
    statistics: { count: 118, missing: 5, mean: 0.76, median: 0.75, min: 0.66, max: 0.83, sampleSD: 0.039 },
  },
  {
    group: [{ column: 1, label: '分组', value: '缺测组 C' }],
    column: 3,
    label: 'F1（按分组均值）',
    unit: '',
    rowCount: 12,
    sampleCount: 4,
    statistics: { count: 0, missing: 12, mean: null, median: null, min: null, max: null, sampleSD: null },
  },
];

/** 知识/证据切片：当前有效与已撤销（带输入原因）。 */
export const mockKnowledge: GeneralReportFactPack['knowledge'] = [
  {
    entry: {
      entryId: 'kn-mock-1',
      version: 1,
      kind: 'wiki',
      title: '基线方法说明（模拟）',
      category: 'mock',
      content: '模拟内容：基线 A 使用固定阈值；本条目仅为组件展示测试。',
      nature: 'inference',
      sourceRefs: ['src-mock-1'],
      calculationIds: ['calc-mock-1'],
      nodeIds: [],
      input: '模拟输入',
      output: '模拟输出',
      conditions: [],
      parameters: [],
      operation: 'manual',
      archived: false,
      createdAt: MOCK_ISO,
    },
    evidence: {
      status: 'current',
      reasons: [],
      sourceIds: ['src-mock-1'],
      inputNatures: ['literature'],
      check: 'locator_checked',
    },
  },
  {
    entry: {
      entryId: 'kn-mock-2',
      version: 2,
      kind: 'method',
      title: '外部方法引用（模拟，已撤销）',
      category: 'mock',
      content: '模拟内容：引用的外部方法条目，来源已被撤销。',
      nature: 'source_reported',
      sourceRefs: ['src-mock-2'],
      calculationIds: [],
      nodeIds: [],
      input: '模拟输入',
      output: '模拟输出',
      conditions: [],
      parameters: [],
      operation: 'external_not_connected',
      archived: true,
      createdAt: MOCK_ISO,
    },
    evidence: {
      status: 'revoked',
      reasons: ['模拟：来源文件已被撤销'],
      sourceIds: ['src-mock-2'],
      inputNatures: ['simulation'],
      check: 'unlocated',
    },
  },
];

/** 评审切片：部分支持 + 待复核（带输入原因）。 */
export const mockReviews: GeneralReportFactPack['reviews'] = [
  {
    review: {
      reviewId: 'rev-mock-1',
      nodeId: 'node-mock-1',
      calculationIds: ['calc-mock-1'],
      sourceRefs: ['src-mock-1'],
      judgment: 'partial',
      reason: '模拟：部分指标达标，但样本量有限，不能宣称显著提升',
      support: ['F1 绝对差值 +0.040（输入提供的差值）'],
      counterEvidence: ['延迟记录单位与协议不一致，不可比较'],
      gaps: ['缺少独立重复样本'],
      applicability: '仅适用于本模拟数据集',
      nextActions: ['补充独立重复样本'],
      reviewer: { kind: 'human', identity: 'mock-reviewer', actionId: 'act-mock-1' },
      createdAt: MOCK_ISO,
    },
    freshness: { status: 'needs_review', reasons: ['模拟：评审后底层计算已更新'] },
  },
];

/** 计划切片（模拟，仅展示）。 */
export const mockPlans: GeneralAnalysisPlan[] = [
  {
    planId: 'plan-mock-1',
    version: 1,
    nodeId: 'node-mock-1',
    nodeSnapshotHash: MOCK_SHA256,
    title: '分组描述统计（模拟）',
    goal: '模拟：比较基线 A 与变体 B 的 F1',
    dataset: { datasetId: 'ds-mock-1', version: 1, sourceId: 'src-mock-1', sourceSha256: MOCK_SHA256, tableId: 'tbl-mock-1', dictionarySha256: MOCK_SHA256 },
    idea: { ideaId: 'idea-mock-1', revision: 1 },
    method: 'grouped_descriptive',
    numericColumns: [3],
    groupBy: [1],
    sampleColumns: [],
    rowRange: { start: 0, end: 119 },
    missingPolicy: 'available_cases',
    missingGroupPolicy: 'separate',
    requiredConditions: [],
    comparisonScope: '同一数据集内分组对比',
    limitations: ['模拟：未做显著性检验'],
    createdAt: MOCK_ISO,
  },
];

const mockCalculationOk: GeneralCalculation = {
  calculationId: 'calc-mock-1',
  planId: 'plan-mock-1',
  planVersion: 1,
  nodeId: 'node-mock-1',
  attempt: 1,
  status: 'completed',
  provenance: 'system_calculation',
  inputNature: 'user_result',
  input: { datasetId: 'ds-mock-1', version: 1, sourceId: 'src-mock-1', sourceSha256: MOCK_SHA256, tableId: 'tbl-mock-1', dictionarySha256: MOCK_SHA256 },
  idea: { ideaId: 'idea-mock-1', revision: 1 },
  tool: { name: 'mock-tool', version: '1.0.0', runtime: 'mock-runtime' },
  artifact: { id: 'art-mock-1', sha256: MOCK_SHA256 },
  firstError: null,
  startedAt: MOCK_ISO,
  finishedAt: MOCK_ISO,
  checks: 'calculation_completed',
};

const mockCalculationFailed: GeneralCalculation = {
  calculationId: 'calc-mock-2',
  planId: 'plan-mock-1',
  planVersion: 1,
  nodeId: 'node-mock-1',
  attempt: 2,
  status: 'failed',
  provenance: 'system_calculation',
  inputNature: 'user_result',
  input: { datasetId: 'ds-mock-1', version: 1, sourceId: 'src-mock-1', sourceSha256: MOCK_SHA256, tableId: 'tbl-mock-1', dictionarySha256: MOCK_SHA256 },
  idea: { ideaId: 'idea-mock-1', revision: 1 },
  tool: { name: 'mock-tool', version: '1.0.0', runtime: 'mock-runtime' },
  artifact: null,
  firstError: { code: 'MOCK_ERROR', message: '模拟：分母为 0' },
  startedAt: MOCK_ISO,
  finishedAt: MOCK_ISO,
  checks: 'calculation_failed',
};

/** 计算条目切片：成功 + 失败（失败保留首错，状态与原因来自输入）。 */
export const mockCalculations: GeneralReportFactPack['calculations'] = [
  {
    calculation: mockCalculationOk,
    check: 'provenance_checked',
    freshness: { status: 'current', reasons: [] },
    summaries: mockSummaryRows,
    warnings: ['模拟：3 行存在缺测'],
    error: null,
  },
  {
    calculation: mockCalculationFailed,
    check: 'unavailable',
    freshness: { status: 'needs_review', reasons: ['模拟：计算失败后数据已更新'] },
    summaries: [],
    warnings: [],
    error: '模拟：计算失败（首错 MOCK_ERROR）',
  },
];

/** 术语切片：仅组件展示用。 */
export const mockTerms: { term: string; plain: string }[] = [
  { term: '均值（mean）', plain: '把一组数相加后除以个数，得到“平均水平”。它不能说明差异是否显著。' },
  { term: '绝对差值', plain: '两个数直接相减的结果，例如 0.760 − 0.720 = 0.040。绝对差值不等于显著性结论。' },
  { term: '未测（null）', plain: '输入没有提供这个值。它不同于 0：0 是测到的零，未测是根本没测。' },
];

/** 从切片拼装完整只读报告输入（模拟，仅展示测试）。 */
export function buildMockFactPackRead(): GeneralFactPackRead {
  return {
    record: {
      ...mockSelection,
      packId: 'pack-mock-1',
      version: 1,
      title: '模拟研究报告（仅展示）',
      artifact: { id: 'art-pack-mock-1', sha256: MOCK_SHA256 },
      contextHash: MOCK_SHA256,
      inputsHash: MOCK_SHA256,
      bootstrapRevision: 1,
      createdAt: MOCK_ISO,
    },
    pack: {
      schemaVersion: 1,
      kind: 'general_report_fact_pack',
      researchId: 'research-mock-1',
      packId: 'pack-mock-1',
      version: 1,
      title: '模拟研究报告（仅展示）',
      createdAt: MOCK_ISO,
      bootstrapRevision: 1,
      contextHash: MOCK_SHA256,
      inputsHash: MOCK_SHA256,
      selection: mockSelection,
      questions: [{ ideaId: 'idea-mock-1', revision: 1, question: '变体 B 的 F1 是否优于基线 A？', nature: 'hypothesis' }],
      constraints: ['模拟：不得把 +0.040 绝对差值宣称为显著提升'],
      sources: [],
      datasets: [],
      plans: mockPlans,
      calculations: mockCalculations,
      knowledge: mockKnowledge,
      reviews: mockReviews,
      metrics: {
        protocols: mockMetricProtocols,
        reports: [],
        rows: mockMetricRows,
        errors: [{ calculationId: 'calc-mock-2', message: '模拟：指标投影失败示例' }],
        boundary: '模拟：指标投影不包含显著性检验结论',
      },
      inferences: [],
      unknowns: ['模拟：延迟指标未测', '模拟：独立重复样本数量未知'],
      boundary: '模拟：所有数字均为演示用模拟值，不代表真实研究结果。',
    },
    freshness: { status: 'needs_review', reasons: ['模拟：来源数据在打包后已更新'] },
  };
}
