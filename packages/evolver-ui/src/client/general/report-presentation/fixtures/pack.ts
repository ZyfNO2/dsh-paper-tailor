/**
 * W1 报告展示层 · 报告事实包 fixture（GeneralReportFactPack 形状，只读 DTO 对齐）。
 *
 * 覆盖（全部为模拟数据）：
 * - 三种来源性质：user_observation（真实观测·模拟场景）、literature（来源报告）、simulation（模拟）；
 * - 计算：completed（current）、completed（needs_review 待重审）、failed（保留首次错误）、blocked（保留原因）；
 * - 知识条目 + 证据状态 needs_review；审查判断 insufficient（证据不足 → 保留未知）；
 * - 冻结协议 v2 与旧协议 v1 并存；未知项与边界文字明确。
 *
 * 说明：本 fixture 供展示层开发使用；它刻意保持了内部的 id 引用一致性
 * （selection/来源/计算/知识/审查互相匹配），但不作为 wire 校验回归数据使用。
 */
import type { GeneralReportFactPack, GeneralReportSelection } from '../../../../../../evolver/src/contracts/general-report.ts';
import type { DatasetVersion, MaterialSource } from '../../../../../../evolver/src/contracts/general-data.ts';
import type { GeneralAnalysisPlan, GeneralCalculation, GeneralReview, DatasetInputRef } from '../../../../../../evolver/src/contracts/general-analysis.ts';
import type { GeneralKnowledgeEntry } from '../../../../../../evolver/src/contracts/general-knowledge.ts';
import type { GeneralEvidenceCheck } from '../../../../../../evolver/src/contracts/general-evidence.ts';
import { SIMULATED_METRIC_PROJECTION_FIXTURE } from './metric-projection.ts';
import { rpSimulatedFixture, type RpSimulatedFixture } from './simulation.ts';

/** 生成显然合成的 64 位十六进制演示哈希（8 位种子重复 8 次，非任何真实内容指纹）。 */
const hex = (seed: string): string => seed.repeat(8);
const H_OBS = hex('a1b2c3d4');
const H_LIT = hex('b2c3d4e5');
const H_SIM = hex('c3d4e5f6');
const H_CTX = hex('9a8b7c6d');
const H_INPUTS = hex('8b7c6d5e');
const H_NODE = hex('7c6d5e4f');
const H_DICT_OBS = hex('6d5e4f3a');
const H_DICT_SIM = hex('5e4f3a2b');
const T0 = '2026-10-13T08:00:00.000Z';
const T1 = '2026-10-13T08:30:00.000Z';
const T2 = '2026-10-13T09:00:00.000Z';
const T3 = '2026-10-13T09:30:00.000Z';
const T4 = '2026-10-13T10:00:00.000Z';

/** 模拟来源 1：真实观测性质（模拟场景）。 */
const SOURCE_OBS: MaterialSource = {
  sourceId: 'src-obs-001', revision: 2, previousSourceId: 'src-obs-000',
  filename: 'sim-observation-batch.csv（模拟）', mediaType: 'text/csv',
  sha256: H_OBS, bytes: 20480, nature: 'user_observation',
  description: '演示用模拟观测数据（虚构，仅展示）', purpose: '为 W1 展示层提供虚构的基线/候选输入',
  acquiredAt: T0, parser: 'csv-generic（模拟）', parsedSha256: hex('4f3a2b1c'), parseStatus: 'parsed', firstError: null,
  tables: [{ tableId: 'tbl-obs-main', name: '模拟观测主表', rowCount: 120, columnCount: 6 }],
};

/** 模拟来源 2：文献性质（来源报告）。 */
const SOURCE_LIT: MaterialSource = {
  sourceId: 'src-lit-002', revision: 1, previousSourceId: null,
  filename: 'sim-paper-x.pdf（虚构）', mediaType: 'application/pdf',
  sha256: H_LIT, bytes: 1048576, nature: 'literature',
  description: '虚构文献 X（模拟，仅展示）', purpose: '演示"来源报告"与"单位不一致"状态',
  acquiredAt: T0, parser: 'pdf-text（模拟）', parsedSha256: hex('3a2b1c0d'), parseStatus: 'parsed', firstError: null,
  tables: [{ tableId: 'tbl-lit-x3', name: '表 3（虚构）', rowCount: 8, columnCount: 5 }],
};

/** 模拟来源 3：模拟性质（显式 simulation 标记）。 */
const SOURCE_SIM: MaterialSource = {
  sourceId: 'src-sim-003', revision: 1, previousSourceId: null,
  filename: 'sim-demo-dataset.csv（模拟）', mediaType: 'text/csv',
  sha256: H_SIM, bytes: 8192, nature: 'simulation',
  description: '明确标记为模拟的演示数据（仅展示）', purpose: '演示"模拟"来源性质与斜纹视觉标识',
  acquiredAt: T0, parser: 'csv-generic（模拟）', parsedSha256: hex('2b1c0d9e'), parseStatus: 'parsed', firstError: null,
  tables: [{ tableId: 'tbl-sim-main', name: '模拟演示主表', rowCount: 48, columnCount: 5 }],
};

/** 数据集输入引用（plan.dataset 与 calculation.input 共用同一常量，保证输入一致）。 */
const DATASET_OBS_REF: DatasetInputRef = {
  datasetId: 'ds-obs-001', version: 1, sourceId: 'src-obs-001', sourceSha256: H_OBS,
  tableId: 'tbl-obs-main', dictionarySha256: H_DICT_OBS,
};
const DATASET_SIM_REF: DatasetInputRef = {
  datasetId: 'ds-sim-001', version: 1, sourceId: 'src-sim-003', sourceSha256: H_SIM,
  tableId: 'tbl-sim-main', dictionarySha256: H_DICT_SIM,
};

/** 数据集版本（模拟）：字段带单位与缺失值标记。 */
const DATASET_OBS: DatasetVersion = {
  datasetId: 'ds-obs-001', version: 1, sourceId: 'src-obs-001', sourceSha256: H_OBS, tableId: 'tbl-obs-main',
  fields: [
    { column: 0, label: '样本编号', type: 'text', role: 'sample', unit: null, missingValues: [], conversion: null },
    { column: 1, label: '方法', type: 'category', role: 'group', unit: null, missingValues: [], conversion: null },
    { column: 2, label: 'F1（模拟）', type: 'number', role: 'outcome', unit: 'ratio', missingValues: ['NA'], conversion: null },
    { column: 3, label: '准确率（模拟）', type: 'number', role: 'outcome', unit: 'ratio', missingValues: ['NA'], conversion: null },
    { column: 4, label: '延迟（模拟）', type: 'number', role: 'variable', unit: 'ms', missingValues: ['NA'], conversion: null },
    { column: 5, label: '公平性差距（模拟）', type: 'number', role: 'uncertainty', unit: 'ratio', missingValues: ['NA'], conversion: null },
  ],
  conditions: [{ name: '任务', value: '问答（模拟）', unit: null }],
  excludedRows: [],
  processingReason: '演示用模拟数据，无排除行（虚构）',
  createdAt: T0,
};
const DATASET_SIM: DatasetVersion = {
  datasetId: 'ds-sim-001', version: 1, sourceId: 'src-sim-003', sourceSha256: H_SIM, tableId: 'tbl-sim-main',
  fields: [
    { column: 0, label: '样本编号', type: 'text', role: 'sample', unit: null, missingValues: [], conversion: null },
    { column: 1, label: '来源', type: 'category', role: 'group', unit: null, missingValues: [], conversion: null },
    { column: 2, label: 'F1（模拟）', type: 'number', role: 'outcome', unit: 'ratio', missingValues: ['NA'], conversion: null },
    { column: 3, label: '准确率（模拟）', type: 'number', role: 'outcome', unit: 'ratio', missingValues: ['NA'], conversion: null },
    { column: 4, label: '延迟（模拟）', type: 'number', role: 'variable', unit: 'ms', missingValues: ['NA'], conversion: null },
  ],
  conditions: [{ name: '任务', value: '问答（模拟）', unit: null }],
  excludedRows: [3, 7],
  processingReason: '排除构造错误的模拟行（虚构）',
  createdAt: T0,
};

/** 分析计划（模拟）：plan-001 用于真实观测（模拟场景），plan-002 用于模拟数据演示。 */
const PLAN_001: GeneralAnalysisPlan = {
  planId: 'plan-001', version: 2, nodeId: 'node-eval（模拟）', nodeSnapshotHash: H_NODE,
  title: '基线与候选描述统计（模拟）', goal: '演示同一冻结协议下的对比计算（仅展示）',
  dataset: DATASET_OBS_REF, idea: { ideaId: 'idea-001', revision: 1 },
  method: 'grouped_descriptive', numericColumns: [2, 3, 4, 5], groupBy: [1], sampleColumns: [0],
  rowRange: { start: 0, end: 119 },
  missingPolicy: 'available_cases', missingGroupPolicy: 'exclude',
  requiredConditions: ['同一冻结协议 v2', '同一模拟数据划分'],
  comparisonScope: '基线 vs 候选，同输入（模拟场景）',
  limitations: ['模拟数据，仅展示', '无独立重复'],
  createdAt: T0,
};
const PLAN_002: GeneralAnalysisPlan = {
  planId: 'plan-002', version: 1, nodeId: 'node-sim-demo（模拟）', nodeSnapshotHash: H_NODE,
  title: '模拟演示描述统计', goal: '演示模拟行如何被明确标记并排除出真实比较（仅展示）',
  dataset: DATASET_SIM_REF, idea: null,
  method: 'descriptive', numericColumns: [2, 3, 4], groupBy: [], sampleColumns: [0],
  rowRange: { start: 0, end: 47 },
  missingPolicy: 'available_cases', missingGroupPolicy: 'separate',
  requiredConditions: ['仅演示（模拟）'],
  comparisonScope: '无比较（模拟演示）',
  limitations: ['模拟数据，仅展示', '不进入任何研究结论'],
  createdAt: T0,
};

/** 实际计算记录（模拟）：completed / failed / blocked 全覆盖。 */
const CALC_001: GeneralCalculation = {
  calculationId: 'calc-001', planId: 'plan-001', planVersion: 2, nodeId: 'node-eval（模拟）', attempt: 1,
  status: 'completed', provenance: 'system_calculation', inputNature: 'user_observation',
  input: DATASET_OBS_REF, idea: { ideaId: 'idea-001', revision: 1 },
  tool: { name: 'descriptive-basic（模拟）', version: '1.0.0', runtime: '演示运行时（虚构）' },
  artifact: { id: 'art-calc-001', sha256: hex('d4e5f6a7') }, firstError: null,
  startedAt: T1, finishedAt: T1, checks: 'calculation_completed',
};
const CALC_002: GeneralCalculation = {
  calculationId: 'calc-002', planId: 'plan-001', planVersion: 2, nodeId: 'node-eval（模拟）', attempt: 1,
  status: 'completed', provenance: 'system_calculation', inputNature: 'user_observation',
  input: DATASET_OBS_REF, idea: { ideaId: 'idea-001', revision: 1 },
  tool: { name: 'descriptive-basic（模拟）', version: '1.0.0', runtime: '演示运行时（虚构）' },
  artifact: { id: 'art-calc-002', sha256: hex('e5f6a7b8') }, firstError: null,
  startedAt: T2, finishedAt: T2, checks: 'calculation_completed',
};
const CALC_FAIL_003: GeneralCalculation = {
  calculationId: 'calc-fail-003', planId: 'plan-001', planVersion: 2, nodeId: 'node-eval（模拟）', attempt: 1,
  status: 'failed', provenance: 'system_calculation', inputNature: 'user_observation',
  input: DATASET_OBS_REF, idea: { ideaId: 'idea-001', revision: 1 },
  tool: { name: 'descriptive-basic（模拟）', version: '1.0.0', runtime: '演示运行时（虚构）' },
  artifact: null,
  firstError: { code: 'EXEC_TIMEOUT（模拟）', message: '第 1 次尝试失败：执行器超时（模拟文案，非真实运行错误）' },
  startedAt: T2, finishedAt: T2, checks: 'calculation_failed',
};
const CALC_BLOCK_004: GeneralCalculation = {
  calculationId: 'calc-block-004', planId: 'plan-001', planVersion: 2, nodeId: 'node-eval（模拟）', attempt: 1,
  status: 'blocked', provenance: 'system_calculation', inputNature: 'user_observation',
  input: DATASET_OBS_REF, idea: { ideaId: 'idea-001', revision: 1 },
  tool: { name: 'descriptive-basic（模拟）', version: '1.0.0', runtime: '演示运行时（虚构）' },
  artifact: null, firstError: null,
  startedAt: T3, finishedAt: T3, checks: 'conditions_unsatisfied',
};
const CALC_SIM_005: GeneralCalculation = {
  calculationId: 'calc-sim-005', planId: 'plan-002', planVersion: 1, nodeId: 'node-sim-demo（模拟）', attempt: 1,
  status: 'completed', provenance: 'system_calculation', inputNature: 'simulation',
  input: DATASET_SIM_REF, idea: null,
  tool: { name: 'descriptive-basic（模拟）', version: '1.0.0', runtime: '演示运行时（虚构）' },
  artifact: { id: 'art-calc-005', sha256: hex('f6a7b8c9') }, firstError: null,
  startedAt: T3, finishedAt: T3, checks: 'calculation_completed',
};

/** 知识条目 + 证据检查（模拟）：evidence 状态 needs_review。 */
const KNOWLEDGE_ENTRY: GeneralKnowledgeEntry = {
  entryId: 'kn-001', version: 2, kind: 'wiki',
  title: '文献 X 的 F1 记录（模拟摘录）', category: '文献摘录（模拟）',
  content: '虚构文献 X 表 3 报告了问答任务的 F1 0.751；其准确率以百分数（75.3%）记录，与本协议口径（ratio）不一致。本条目仅用于演示"来源报告"与"单位不一致"，不是真实文献证据。',
  nature: 'source_reported', sourceRefs: ['src-lit-002'], calculationIds: [], nodeIds: [],
  input: '虚构文献 X 表 3', output: 'F1 0.751；准确率 75.3（单位 %）',
  conditions: ['问答任务（模拟）'], parameters: [], operation: 'manual', archived: false, createdAt: T2,
};
const KNOWLEDGE_EVIDENCE: GeneralEvidenceCheck = {
  status: 'needs_review', reasons: ['来源材料未重新核验（模拟场景）'],
  sourceIds: ['src-lit-002'], inputNatures: ['literature'], check: 'locator_checked',
};

/** 审查记录（模拟）：判断 insufficient（证据不足 → 保留未知）。 */
const REVIEW_001: GeneralReview = {
  reviewId: 'rev-001', nodeId: 'node-eval（模拟）',
  calculationIds: ['calc-001', 'calc-002'], sourceRefs: ['src-obs-001', 'src-lit-002'],
  judgment: 'insufficient',
  reason: '证据不足：缺少独立重复与统计材料（模拟场景），保留未知，不判断候选是否更优',
  support: ['同一冻结协议 v2 下，候选 F1 的绝对差值为 +0.040（模拟数值，非显著性结论）'],
  counterEvidence: ['来源报告的 accuracy 单位不一致，该列不参与比较（模拟）'],
  gaps: ['无独立样本量与方差材料', '候选计算待重审'],
  applicability: '仅适用于本模拟场景（虚构）',
  nextActions: ['补充独立重复后再审（模拟建议）'],
  reviewer: { kind: 'human', identity: '演示审查者（模拟）', actionId: 'act-demo-001' },
  createdAt: T4,
};

/** 报告选择（与 selection/来源/计算/知识/审查的 id 保持一致，模拟）。 */
const SELECTION: GeneralReportSelection = {
  sourceIds: ['src-obs-001', 'src-lit-002', 'src-sim-003'],
  calculationIds: ['calc-001', 'calc-002', 'calc-fail-003', 'calc-block-004', 'calc-sim-005'],
  knowledgeRefs: [{ entryId: 'kn-001', version: 2 }],
  reviewIds: ['rev-001'],
  inferenceRunIds: [],
};

/** 报告事实包数据（模拟）：形状与 GeneralReportFactPack 只读 DTO 一致。 */
const SIMULATED_PACK_DATA: GeneralReportFactPack = {
  schemaVersion: 1,
  kind: 'general_report_fact_pack',
  researchId: 'research-sim-w1（模拟）',
  packId: 'pack-sim-w1',
  version: 3,
  title: 'W1 报告展示层模拟示例包（仅展示，虚构）',
  createdAt: T4,
  bootstrapRevision: 7,
  contextHash: H_CTX,
  inputsHash: H_INPUTS,
  selection: SELECTION,
  questions: [
    {
      ideaId: 'idea-001', revision: 1,
      question: '在同一冻结协议 v2 下，候选方法相对基线的 F1 绝对差值是多少？（模拟问题，不判断显著性）',
      nature: 'hypothesis',
    },
  ],
  constraints: [
    '全部数值为模拟演示数据（仅展示），不得作为真实研究证据',
    '差值仅展示绝对差值，不判断显著性',
    '模拟行不与真实观测行建立比较',
    '未知保留未知，不用 0 代替；0 是实测值',
  ],
  sources: [SOURCE_OBS, SOURCE_LIT, SOURCE_SIM],
  datasets: [DATASET_OBS, DATASET_SIM],
  plans: [PLAN_001, PLAN_002],
  calculations: [
    {
      calculation: CALC_001, check: 'provenance_checked',
      freshness: { status: 'current', reasons: [] },
      summaries: [
        {
          group: [{ column: 1, label: '方法', value: '基线（模拟）' }],
          column: 2, label: 'F1（模拟）', unit: 'ratio',
          rowCount: 60, sampleCount: null,
          statistics: { count: 59, missing: 1, mean: 0.7204, median: 0.721, min: 0.61, max: 0.791, sampleSD: 0.0412 },
        },
      ],
      warnings: [], error: null,
    },
    {
      calculation: CALC_002, check: 'provenance_checked',
      freshness: { status: 'needs_review', reasons: ['输入数据源 src-obs-001 在模拟场景中已更新，结果需重新审核（模拟）'] },
      summaries: [
        {
          group: [{ column: 1, label: '方法', value: '候选（模拟）' }],
          column: 2, label: 'F1（模拟）', unit: 'ratio',
          rowCount: 60, sampleCount: null,
          statistics: { count: 60, missing: 0, mean: 0.7601, median: 0.758, min: 0.662, max: 0.815, sampleSD: 0.0396 },
        },
      ],
      warnings: ['待重审状态下数值仅供参考（模拟）'], error: null,
    },
    {
      calculation: CALC_FAIL_003, check: 'unavailable',
      freshness: { status: 'current', reasons: [] },
      summaries: [], warnings: [],
      error: '第 1 次尝试失败：执行器超时（模拟文案，非真实运行错误）',
    },
    {
      calculation: CALC_BLOCK_004, check: 'unavailable',
      freshness: { status: 'needs_review', reasons: ['依赖数据集 ds-obs-001 的来源已过期（模拟场景）'] },
      summaries: [],
      warnings: ['未执行：依赖数据集 ds-obs-001 的来源已过期，需重新导入后才能计算（模拟场景）'],
      error: null,
    },
    {
      calculation: CALC_SIM_005, check: 'provenance_checked',
      freshness: { status: 'current', reasons: [] },
      summaries: [
        {
          group: [{ column: 1, label: '来源', value: '模拟演示（虚构）' }],
          column: 2, label: 'F1（模拟）', unit: 'ratio',
          rowCount: 46, sampleCount: null,
          statistics: { count: 45, missing: 1, mean: 0.7352, median: 0.736, min: 0.641, max: 0.802, sampleSD: 0.0388 },
        },
      ],
      warnings: ['本计算基于模拟数据（仅展示）'], error: null,
    },
  ],
  knowledge: [{ entry: KNOWLEDGE_ENTRY, evidence: KNOWLEDGE_EVIDENCE }],
  reviews: [{ review: REVIEW_001, freshness: { status: 'current', reasons: [] } }],
  metrics: SIMULATED_METRIC_PROJECTION_FIXTURE.data,
  inferences: [],
  unknowns: [
    'fairness_gap 基线为未知（无值），该列不参与比较（模拟场景）',
    '未提供独立样本量、方差与置信区间材料，不判断显著性（模拟场景）',
    '来源报告的 accuracy 单位为 %，与协议口径不一致，该列不参与差值（模拟场景）',
    '候选计算待重审，数值需重新审核后才能继续使用（模拟场景）',
  ],
  boundary:
    '本 Fact Pack 为 W1 展示层模拟 fixture：数据虚构、仅用于界面与文案演示；不可作为真实研究证据，不可用于验证、发布或对比真实实验。',
};

/** 报告事实包 fixture（带显式模拟标记）。 */
export const SIMULATED_PACK_FIXTURE: RpSimulatedFixture<GeneralReportFactPack> = rpSimulatedFixture(
  SIMULATED_PACK_DATA,
  '报告事实包 fixture（模拟）：覆盖三种来源性质、完成/失败/阻塞计算、待重审、证据不足审查与冻结协议。',
);

/** 供 record/read/projection 复用的选择字段（与 pack.selection 完全一致，模拟）。 */
export const SIMULATED_PACK_SELECTION: GeneralReportSelection = SELECTION;
