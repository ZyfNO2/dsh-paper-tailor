/**
 * W1 报告展示层 · 指标投影 fixture（GeneralMetricProjection 形状，只读 DTO 对齐）。
 *
 * 覆盖状态矩阵（全部为模拟数据）：
 * - 来源性质：● 实际计算（system_calculation / provenance_checked）、◆ 来源报告（source_reported）、
 *   ▨ 模拟（inputNature simulation）、失败行 check=unavailable + blockers（阻塞）；
 * - 单元格：0（实测）与 null（未知）并存、unit_mismatch（accuracy 75.3% vs 协议 ratio）、missing；
 * - 比较：可比较（comparedTo + comparisonReasons + delta）、不可比较（协议 v1 旧口径、跨性质模拟行）；
 * - 差值：仅系统计算行带 delta（F1 +0.040 = 0.760 − 0.720，绝对差值）；基线未知列不提供 delta；
 * - 错误：metrics.errors 保留失败计算的首次错误文案。
 */
import type { GeneralMetricProjection, GeneralMetricProtocol } from '../../../../../../evolver/src/contracts/general-metrics.ts';
import { rpSimulatedFixture, type RpSimulatedFixture } from './simulation.ts';

/** 演示用 64 位十六进制哈希（虚构，非任何真实内容指纹）。 */
const H1 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const T1 = '2026-10-13T08:00:00.000Z';
const T2 = '2026-10-13T09:30:00.000Z';

/** 冻结协议 v2（模拟）：五项指标，含目标区间与"observe"型指标。 */
const PROTOCOL_V2_FROZEN: GeneralMetricProtocol = {
  protocolId: 'proto-qa-metrics',
  version: 2,
  status: 'frozen',
  goal: '在模拟场景中评估候选方法相对基线在问答任务上的表现（仅展示，虚构）',
  metrics: [
    {
      metricId: 'f1', name: 'F1', definition: '精确率与召回率的调和平均（模拟演示口径）',
      role: 'primary', priority: 1, direction: 'maximize', unit: 'ratio', required: true,
      target: { min: 0.75, max: null }, rationale: '核心问题关注 F1 是否达到预设目标（模拟）',
      binding: { fieldLabel: 'F1（模拟）', statistic: 'mean' },
    },
    {
      metricId: 'accuracy', name: '准确率', definition: '预测正确比例（模拟演示口径）',
      role: 'auxiliary', priority: 2, direction: 'maximize', unit: 'ratio', required: true,
      target: { min: null, max: null }, rationale: '辅助视角（模拟）',
      binding: { fieldLabel: '准确率（模拟）', statistic: 'mean' },
    },
    {
      metricId: 'latency_ms', name: '响应延迟', definition: '平均响应时间（模拟演示口径）',
      role: 'auxiliary', priority: 3, direction: 'minimize', unit: 'ms', required: false,
      target: { min: null, max: 500 }, rationale: '工程约束参考（模拟）',
      binding: { fieldLabel: '延迟（模拟）', statistic: 'mean' },
    },
    {
      metricId: 'rule_violations', name: '规则违规数', definition: '违反输出约束的样本数（模拟演示口径）',
      role: 'constraint', priority: 4, direction: 'minimize', unit: 'count', required: true,
      target: { min: null, max: 0 }, rationale: '约束：违规数不得超过 0（模拟）',
      binding: null,
    },
    {
      metricId: 'fairness_gap', name: '公平性差距', definition: '组间表现差距（模拟演示口径）',
      role: 'auxiliary', priority: 5, direction: 'observe', unit: 'ratio', required: false,
      target: { min: null, max: null }, rationale: '观察项，不设置目标（模拟）',
      binding: { fieldLabel: '公平性差距（模拟）', statistic: 'mean' },
    },
  ],
  requiredConditions: ['同一冻结协议 v2', '同一模拟数据划分', '同一硬件描述（虚构）'],
  variedConditions: ['方法：基线 vs 候选'],
  comparisonScope: '允许比较：同协议 v2、同真实观测输入下的基线与候选；模拟行与来源报告不进入该比较（模拟场景）',
  contextHash: H1,
  reason: '冻结以固定演示口径，防止口径漂移（模拟）',
  createdAt: T1,
};

/** 旧协议 v1（模拟）：口径不同，用于演示"不可比较（跨版本）"。 */
const PROTOCOL_V1_FROZEN: GeneralMetricProtocol = {
  protocolId: 'proto-qa-metrics',
  version: 1,
  status: 'frozen',
  goal: '旧口径下的问答表现记录（模拟，仅展示）',
  metrics: [
    {
      metricId: 'f1', name: 'F1（旧口径）', definition: '未对未见问题做分层的旧 F1 口径（模拟）',
      role: 'primary', priority: 1, direction: 'maximize', unit: 'ratio', required: true,
      target: { min: null, max: null }, rationale: '旧口径无目标区间（模拟）',
      binding: { fieldLabel: 'F1（模拟，旧口径）', statistic: 'mean' },
    },
    {
      metricId: 'accuracy', name: '准确率（旧口径）', definition: '旧口径准确率（模拟）',
      role: 'auxiliary', priority: 2, direction: 'maximize', unit: 'ratio', required: true,
      target: { min: null, max: null }, rationale: '辅助视角（模拟）',
      binding: { fieldLabel: '准确率（模拟，旧口径）', statistic: 'mean' },
    },
  ],
  requiredConditions: ['旧口径 v1（模拟）'],
  variedConditions: [],
  comparisonScope: '仅 v1 内部比较；不与 v2 建立 comparisonReasons 之外的比较（模拟）',
  contextHash: null,
  reason: '历史版本，保留以演示跨版本不可比较（模拟）',
  createdAt: '2026-09-01T08:00:00.000Z',
};

const GROUP_V2 = '同一冻结协议 v2 · 真实观测（模拟场景）';
const GROUP_SRC = '来源报告（模拟）';

/** 指标投影数据（模拟）：形状与 GeneralMetricProjection 只读 DTO 一致。 */
const SIMULATED_PROJECTION_DATA: GeneralMetricProjection = {
    protocols: [PROTOCOL_V2_FROZEN, PROTOCOL_V1_FROZEN],
    reports: [
      {
        reportId: 'rep-lit-003', protocolId: 'proto-qa-metrics', version: 2,
        label: '文献 X 表 3（虚构，模拟）', sourceId: 'src-lit-002', locator: '文献 X（虚构）表 3，第 2 行',
        values: [
          { metricId: 'f1', value: 0.751, unit: 'ratio' },
          { metricId: 'accuracy', value: 75.3, unit: '%' },
          { metricId: 'latency_ms', value: 467, unit: 'ms' },
        ],
        conditions: [{ name: '任务', value: '问答（模拟）', unit: null }],
        note: '来源报告按原单位记录；accuracy 为百分数，与协议口径 ratio 不一致（模拟）',
        createdAt: T2,
      },
      {
        reportId: 'rep-lit-005', protocolId: 'proto-qa-metrics', version: 1,
        label: '文献 Y 表 1（虚构，模拟，旧协议 v1）', sourceId: 'src-lit-002', locator: '文献 Y（虚构）表 1',
        values: [
          { metricId: 'f1', value: 0.698, unit: 'ratio' },
          { metricId: 'accuracy', value: 0.664, unit: 'ratio' },
        ],
        conditions: [{ name: '任务', value: '问答（模拟，旧口径）', unit: null }],
        note: '旧协议 v1 口径，仅展示（模拟）',
        createdAt: '2026-09-02T08:00:00.000Z',
      },
    ],
    rows: [
      {
        rowId: 'row-base-001', protocolId: 'proto-qa-metrics', version: 2,
        label: '基线（模拟数据集 A）', role: 'baseline', variantKey: 'base', parentKey: null,
        origin: 'system_calculation', inputNature: 'user_observation', status: 'completed',
        check: 'provenance_checked', calculationId: 'calc-001', sourceId: 'src-obs-001',
        locator: '计算 calc-001（模拟）', attempt: 1, group: GROUP_V2,
        cells: [
          { metricId: 'f1', value: 0.720, unit: 'ratio', status: 'recorded', targetStatus: 'not_met', delta: null },
          { metricId: 'accuracy', value: 0.680, unit: 'ratio', status: 'recorded', targetStatus: 'not_configured', delta: null },
          { metricId: 'latency_ms', value: 412, unit: 'ms', status: 'recorded', targetStatus: 'met', delta: null },
          { metricId: 'rule_violations', value: 0, unit: 'count', status: 'recorded', targetStatus: 'met', delta: null },
          { metricId: 'fairness_gap', value: null, unit: 'ratio', status: 'missing', targetStatus: 'not_configured', delta: null },
        ],
        blockers: [], comparisonReasons: [], comparedTo: null,
        constraintsStatus: 'passed', selectionStatus: 'needs_validation',
      },
      {
        rowId: 'row-cand-002', protocolId: 'proto-qa-metrics', version: 2,
        label: '候选方法（模拟数据集 A）', role: 'candidate', variantKey: 'cand', parentKey: 'base',
        origin: 'system_calculation', inputNature: 'user_observation', status: 'completed',
        check: 'provenance_checked', calculationId: 'calc-002', sourceId: 'src-obs-001',
        locator: '计算 calc-002（模拟）', attempt: 1, group: GROUP_V2,
        cells: [
          { metricId: 'f1', value: 0.760, unit: 'ratio', status: 'recorded', targetStatus: 'met', delta: 0.040 },
          { metricId: 'accuracy', value: 0.705, unit: 'ratio', status: 'recorded', targetStatus: 'not_configured', delta: 0.025 },
          { metricId: 'latency_ms', value: 389, unit: 'ms', status: 'recorded', targetStatus: 'met', delta: -23 },
          { metricId: 'rule_violations', value: 0, unit: 'count', status: 'recorded', targetStatus: 'met', delta: 0 },
          { metricId: 'fairness_gap', value: 0.038, unit: 'ratio', status: 'recorded', targetStatus: 'not_configured', delta: null },
        ],
        blockers: [],
        comparisonReasons: ['同一冻结协议 v2、同一输入数据与划分，仅方法不同；差值为系统计算的绝对差值，随输入提供（模拟）'],
        comparedTo: 'row-base-001',
        constraintsStatus: 'passed', selectionStatus: 'needs_validation',
      },
      {
        rowId: 'row-src-003', protocolId: 'proto-qa-metrics', version: 2,
        label: '来源报告：文献 X 表 3（虚构，模拟）', role: 'external_report', variantKey: 'lit-x', parentKey: null,
        origin: 'source_reported', inputNature: 'literature', status: 'completed',
        check: 'source_reported', calculationId: null, sourceId: 'src-lit-002',
        locator: '文献 X（虚构）表 3，第 2 行', attempt: null, group: GROUP_SRC,
        cells: [
          { metricId: 'f1', value: 0.751, unit: 'ratio', status: 'recorded', targetStatus: 'met', delta: null },
          { metricId: 'accuracy', value: 75.3, unit: '%', status: 'unit_mismatch', targetStatus: 'unknown', delta: null },
          { metricId: 'latency_ms', value: 467, unit: 'ms', status: 'recorded', targetStatus: 'not_met', delta: null },
          { metricId: 'rule_violations', value: null, unit: 'count', status: 'missing', targetStatus: 'unknown', delta: null },
          { metricId: 'fairness_gap', value: null, unit: 'ratio', status: 'missing', targetStatus: 'not_configured', delta: null },
        ],
        blockers: [],
        comparisonReasons: ['来源报告与基线同属冻结协议 v2 且任务描述一致，允许参考对比；accuracy 单位为 % 与协议口径不一致，该列不参与差值（模拟）'],
        comparedTo: 'row-base-001',
        constraintsStatus: 'unknown', selectionStatus: 'not_eligible',
      },
      {
        rowId: 'row-sim-004', protocolId: 'proto-qa-metrics', version: 2,
        label: '模拟演示行（非真实观测）', role: 'demo', variantKey: 'sim-demo', parentKey: null,
        origin: 'system_calculation', inputNature: 'simulation', status: 'completed',
        check: 'provenance_checked', calculationId: 'calc-sim-005', sourceId: 'src-sim-003',
        locator: '模拟计算 calc-sim-005（演示，虚构）', attempt: 1, group: '模拟演示（非真实）',
        cells: [
          { metricId: 'f1', value: 0.735, unit: 'ratio', status: 'recorded', targetStatus: 'not_met', delta: null },
          { metricId: 'accuracy', value: 0.700, unit: 'ratio', status: 'recorded', targetStatus: 'not_configured', delta: null },
          { metricId: 'latency_ms', value: 371, unit: 'ms', status: 'recorded', targetStatus: 'met', delta: null },
          { metricId: 'rule_violations', value: 0, unit: 'count', status: 'recorded', targetStatus: 'met', delta: null },
          { metricId: 'fairness_gap', value: null, unit: 'ratio', status: 'missing', targetStatus: 'not_configured', delta: null },
        ],
        blockers: [],
        comparisonReasons: ['模拟输入与真实观测性质不同，不与真实行建立比较（模拟场景规则）'],
        comparedTo: null,
        constraintsStatus: 'passed', selectionStatus: 'not_eligible',
      },
      {
        rowId: 'row-old-005', protocolId: 'proto-qa-metrics', version: 1,
        label: '来源报告：文献 Y 表 1（旧协议 v1，虚构，模拟）', role: 'external_report', variantKey: 'lit-y', parentKey: null,
        origin: 'source_reported', inputNature: 'literature', status: 'completed',
        check: 'source_reported', calculationId: null, sourceId: 'src-lit-002',
        locator: '文献 Y（虚构）表 1', attempt: null, group: GROUP_SRC,
        cells: [
          { metricId: 'f1', value: 0.698, unit: 'ratio', status: 'recorded', targetStatus: 'not_configured', delta: null },
          { metricId: 'accuracy', value: 0.664, unit: 'ratio', status: 'recorded', targetStatus: 'not_configured', delta: null },
        ],
        blockers: [],
        comparisonReasons: ['该行属于协议 v1，与冻结协议 v2 口径不同，未建立比较（模拟）'],
        comparedTo: null,
        constraintsStatus: 'not_configured', selectionStatus: 'not_eligible',
      },
      {
        rowId: 'row-block-006', protocolId: 'proto-qa-metrics', version: 2,
        label: '候选（更新后数据集）——被阻塞（模拟）', role: 'candidate', variantKey: 'cand-replay', parentKey: 'base',
        origin: 'system_calculation', inputNature: 'user_observation', status: 'blocked',
        check: 'unavailable', calculationId: 'calc-block-004', sourceId: 'src-obs-001',
        locator: '计算 calc-block-004（模拟，未执行）', attempt: null, group: GROUP_V2,
        cells: [
          { metricId: 'f1', value: null, unit: 'ratio', status: 'missing', targetStatus: 'unknown', delta: null },
          { metricId: 'accuracy', value: null, unit: 'ratio', status: 'missing', targetStatus: 'unknown', delta: null },
          { metricId: 'latency_ms', value: null, unit: 'ms', status: 'missing', targetStatus: 'unknown', delta: null },
          { metricId: 'rule_violations', value: null, unit: 'count', status: 'missing', targetStatus: 'unknown', delta: null },
          { metricId: 'fairness_gap', value: null, unit: 'ratio', status: 'missing', targetStatus: 'unknown', delta: null },
        ],
        blockers: ['依赖数据集 ds-obs-001 的来源已过期（模拟场景），需重新导入后才能计算'],
        comparisonReasons: [], comparedTo: null,
        constraintsStatus: 'unknown', selectionStatus: 'not_eligible',
      },
    ],
    errors: [
      { calculationId: 'calc-fail-003', message: '第 1 次尝试失败：执行器超时（模拟文案，非真实运行错误）' },
    ],
    boundary: '指标投影边界（模拟）：本 fixture 为展示数据；不执行任何统计检验；差值仅为绝对差值；未知保留未知。',
  };

/** 指标投影 fixture（带显式模拟标记）。 */
export const SIMULATED_METRIC_PROJECTION_FIXTURE: RpSimulatedFixture<GeneralMetricProjection> = rpSimulatedFixture(
  SIMULATED_PROJECTION_DATA,
  '指标投影 fixture（模拟）：覆盖实际计算/来源报告/模拟/阻塞、0 与 null、单位不一致、可比较与不可比较、绝对差值 +0.040。',
);
