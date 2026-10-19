/**
 * Demo fixtures for the redesigned workbench.
 *
 * SPEC §7: every value here is 演示数据. Scenarios are switchable from the
 * demo-only toolbar so each state (loading/empty/error/blocked/stale, the
 * mechanical non-DL sample, incomparable metrics and action rejection) is
 * reproducible without a backend.
 */
import type {
  ActivityEntry,
  ComponentView,
  ExperimentView,
  PaperView,
  PositionView,
  PreconditionNote,
  ResearchEdgeView,
  ResearchNodeView,
  TaskView,
  TreeData,
  WorkbenchSnapshot,
} from '../view-model.ts';

// ---------------------------------------------------------------------------
// scenario 1: general A/B/C research sample (ML-ish, matching the references)
// ---------------------------------------------------------------------------

const taskDL: TaskView = {
  taskKey: 'task-demo-dl',
  displayName: '演示任务：小样本图像分类改进',
  researchGoal: '在每类仅 20 张样本的条件下，把缺陷分类准确率从 78% 提升到 85% 以上。',
  phase: '方案对比',
  preconditions: ['数据已冻结为 split-2026-09', '评估指标与基线已确认'],
  revision: 'rev-14',
};

const preconditionsDL: PreconditionNote[] = [
  { id: 'pc-1', severity: 'info', text: '数据为冻结快照 split-2026-09；实验 C 尚未运行，相关节点为计划状态。' },
  { id: 'pc-2', severity: 'warning', text: '方案 A 与方案 B 在不同随机种子下运行，单次结果差距小于种子方差，结论待复核。' },
];

const dlNodes: ResearchNodeView[] = [
  {
    id: 'n-q1', kind: 'question', branch: 'main', status: 'done',
    title: '问题：小样本准确率不足', childCount: 1, x: 10, y: 230,
    summary: '每类 20 张样本时基线 ResNet-18 验证准确率仅 78%，不满足上线门槛 85%。',
    rationale: '来自上线评审提出的主要差距，已被三次离线复现确认。',
    outcome: '差距 7 个百分点，定义为本任务目标。',
    links: [{ kind: 'paper', key: 'p-p1', label: '综述：小样本分类挑战' }],
    actor: { role: '研究负责人', status: '已确认' },
  },
  {
    id: 'n-h1', kind: 'hypothesis', branch: 'main', status: 'retained',
    title: '假设：增强 + 参数高效适配', childCount: 2, x: 185, y: 230,
    summary: '假设任务相关增强配合少量可训练参数，可在小样本上降低过拟合并提升泛化。',
    rationale: '保留：与冻结数据条件兼容；剪枝掉“扩大数据采集”分支，因本周期无法获得新样本。',
    outcome: '拆为方案 A（适配器）与方案 B（正则微调）对照验证。',
    links: [{ kind: 'paper', key: 'p-p2', label: '参数高效适配相关研究' }],
    actor: { role: '方法设计 Agent', status: '已保留' },
  },
  {
    id: 'n-sa', kind: 'scheme', branch: 'A', status: 'expanded',
    title: '方案 A：LoRA 适配器 + 任务增强', childCount: 3, x: 365, y: 80,
    summary: '冻结主干，在注意力投影上挂载低秩适配器，训练时叠加任务相关增强。',
    rationale: '扩展：可训练参数占比 0.6%，训练成本最低，先做主对照。',
    outcome: '进入实验 A 验证。',
    links: [{ kind: 'component', key: 'c-lora', revision: 'rev-3', label: 'LoRA 适配器' }],
    actor: { role: '方法设计 Agent', status: '已扩展' },
  },
  {
    id: 'n-ea', kind: 'experiment', branch: 'A', status: 'done',
    title: '实验 A：适配器对照', childCount: 4, x: 545, y: 80,
    summary: '3 个随机种子，单卡训练；记录增强开关与秩 r 的影响。',
    rationale: null,
    outcome: '已完成，3/3 有效。',
    links: [{ kind: 'experiment', key: 'exp-a', label: '实验 A 记录（单模块×3 种子）' }],
    actor: { role: '实验执行 Agent', status: '完成' },
  },
  {
    id: 'n-ra', kind: 'result', branch: 'A', status: 'done',
    title: '结果 A：86.2%', childCount: 2, x: 725, y: 80,
    summary: '验证准确率均值 86.2%（±0.9），达到门槛；训练时长与基线相当。',
    rationale: null,
    outcome: '相对基线 +8.2pp，主要变化来自适配器，增强贡献 +1.4pp。',
    links: [{ kind: 'experiment', key: 'exp-a', label: '实验 A 指标行' }],
    actor: null,
  },
  {
    id: 'n-sb', kind: 'scheme', branch: 'B', status: 'retained',
    title: '方案 B：正则化全量微调', childCount: 2, x: 365, y: 300,
    summary: '放开全部参数，使用权重衰减 + early stop 抑制小样本过拟合。',
    rationale: '保留：作为适配器方案的必要对照，区分“参数高效”本身的贡献。',
    outcome: '进入实验 B。',
    links: [{ kind: 'component', key: 'c-reg', revision: 'rev-2', label: '正则微调策略' }],
    actor: { role: '方法设计 Agent', status: '已保留' },
  },
  {
    id: 'n-eb', kind: 'experiment', branch: 'B', status: 'failed',
    title: '实验 B：微调对照', childCount: 3, x: 545, y: 300,
    summary: '3 个种子中 2 个有效；第 3 次因磁盘写满中断。',
    rationale: null,
    outcome: '2 次有效运行均值 83.1%；1 次失败（非方案被剪枝）。',
    failureNote: '失败原因为环境磁盘写满，与方法本身无关；已安排补跑。',
    links: [{ kind: 'experiment', key: 'exp-b', label: '实验 B 记录（含失败诊断）' }],
    actor: { role: '实验执行 Agent', status: '部分失败' },
  },
  {
    id: 'n-rb', kind: 'result', branch: 'B', status: 'done',
    title: '结果 B：83.1%', childCount: 2, x: 725, y: 300,
    summary: '有效运行均值 83.1%，未达门槛；方差大于方案 A。',
    rationale: null,
    outcome: '相对基线 +5.1pp。',
    links: [{ kind: 'experiment', key: 'exp-b', label: '实验 B 指标行' }],
    actor: null,
  },
  {
    id: 'n-sc', kind: 'scheme', branch: 'C', status: 'planned',
    title: '方案 C（备选）：测试时提示集成', childCount: 1, x: 365, y: 452,
    summary: '不更新权重，在推理时组合多个增强提示；作为 A 达标后的低成本加严对照。',
    rationale: '计划中：仅在方案 A 复核通过后投入，避免并行占用训练资源。',
    outcome: '待评审，未开始实验。',
    links: [],
    actor: { role: '研究负责人', status: '待评审' },
  },
  {
    id: 'n-ec', kind: 'experiment', branch: 'C', status: 'planned',
    title: '实验 C（待进行）', childCount: 0, x: 545, y: 452,
    summary: '计划 2 个种子，评估提示数量对准确率与延迟的影响。',
    rationale: null,
    outcome: '尚未运行，无结果。',
    links: [],
    actor: null,
  },
  {
    id: 'n-sx', kind: 'scheme', branch: 'X', status: 'pruned',
    title: '方案 X：扩大数据采集（已剪枝）', childCount: 0, x: 10, y: 452,
    summary: '通过追加采集扩大每类样本数。',
    rationale: '剪枝原因：本周期无法获得新样本，评审记录 2026-10-06。',
    outcome: '已剪枝，不进入实验；与“实验失败”是不同状态。',
    links: [], actor: { role: '研究负责人', status: '已剪枝' },
  },
  {
    id: 'n-conc', kind: 'conclusion', branch: 'main', status: 'retained',
    title: '结论：方案 A 阶段领先', childCount: 1, x: 940, y: 190,
    summary: '方案 A 在有效运行中达到 86.2%，领先方案 B 3.1pp；但差距接近种子方差，需补跑确认。',
    rationale: '保留：A 达标且成本低；未剪枝 B，等待失败种子补跑后复核。',
    outcome: '下一步：补跑 B 的失败种子，并启动方案 C 加严对照。',
    links: [
      { kind: 'experiment', key: 'exp-a', label: '结果 A 证据' },
      { kind: 'experiment', key: 'exp-b', label: '结果 B 证据' },
    ],
    actor: { role: '研究负责人', status: '阶段性' },
  },
];

const dlEdges: ResearchEdgeView[] = [
  { id: 'e-1', sourceId: 'n-q1', targetId: 'n-h1', relation: '主流程', planned: false, reason: null },
  { id: 'e-2', sourceId: 'n-h1', targetId: 'n-sa', relation: '拆分', planned: false, reason: '主对照' },
  { id: 'e-3', sourceId: 'n-h1', targetId: 'n-sb', relation: '拆分', planned: false, reason: '必要对照' },
  { id: 'e-4', sourceId: 'n-sa', targetId: 'n-ea', relation: '验证', planned: false, reason: null },
  { id: 'e-5', sourceId: 'n-ea', targetId: 'n-ra', relation: '产出', planned: false, reason: null },
  { id: 'e-6', sourceId: 'n-sb', targetId: 'n-eb', relation: '验证', planned: false, reason: null },
  { id: 'e-7', sourceId: 'n-eb', targetId: 'n-rb', relation: '产出', planned: false, reason: null },
  { id: 'e-8', sourceId: 'n-ra', targetId: 'n-conc', relation: '汇聚', planned: false, reason: 'A 来源' },
  { id: 'e-9', sourceId: 'n-rb', targetId: 'n-conc', relation: '汇聚', planned: false, reason: 'B 来源' },
  { id: 'e-10', sourceId: 'n-h1', targetId: 'n-sc', relation: '关联/计划', planned: true, reason: '达标后加严对照' },
  { id: 'e-11', sourceId: 'n-sc', targetId: 'n-ec', relation: '计划', planned: true, reason: null },
  { id: 'e-12', sourceId: 'n-h1', targetId: 'n-sx', relation: '已剪枝', planned: true, reason: '本周期无法获得新样本' },
];

const dlActivity: ActivityEntry[] = [
  { id: 'a-1', time: '2026-10-06 09:12', action: '确认问题', actor: '研究负责人', target: { kind: 'node', key: 'n-q1', label: '问题 Q1' }, result: '差距复核通过' },
  { id: 'a-2', time: '2026-10-06 10:03', action: '剪枝分支', actor: '方法设计 Agent', target: { kind: 'node', key: 'n-h1', label: '假设 H1' }, result: '剪枝“扩大采集”分支', detail: '原因：本周期无法获得新样本。' },
  { id: 'a-3', time: '2026-10-06 14:20', action: '扩展方案', actor: '方法设计 Agent', target: { kind: 'node', key: 'n-sa', label: '方案 A' }, result: '生成实验配置草稿' },
  { id: 'a-4', time: '2026-10-07 08:45', action: '运行实验', actor: '实验执行 Agent', target: { kind: 'experiment', key: 'exp-a', label: '实验 A' }, result: '3/3 完成' },
  { id: 'a-5', time: '2026-10-07 15:10', action: '运行实验', actor: '实验执行 Agent', target: { kind: 'experiment', key: 'exp-b', label: '实验 B' }, result: '2/3 有效，1 次中断', rejected: false, detail: '中断原因：磁盘写满。' },
  { id: 'a-6', time: '2026-10-08 09:30', action: '创建 Trial 请求', actor: '研究成员', target: { kind: 'component', key: 'c-cam', label: '高速相机采集（机械库，不适用）' }, result: '已拒绝', rejected: true, rejectReason: '组件适用工况与本任务数据形态不匹配，且当前许可证不允许跨任务调用。' },
  { id: 'a-7', time: '2026-10-08 10:02', action: '提交阶段结论', actor: '研究负责人', target: { kind: 'node', key: 'n-conc', label: '阶段性结论' }, result: '保留 A/B，安排补跑与方案 C' },
];

const dlExperiments: ExperimentView[] = [
  {
    experimentKey: 'exp-a', attempt: 1, label: '实验 A：适配器对照', status: 'completed',
    verificationStatus: 'verified', combination: false,
    componentRefs: [{ kind: 'component', key: 'c-lora', revision: 'rev-3', label: 'LoRA 适配器' }],
    schemeKey: 'n-sa', positionKey: 'pos-process',
    config: [
      { name: '可训练参数占比', value: '0.6%', constraint: null },
      { name: '秩 r', value: '8', constraint: '候选 {4, 8, 16}' },
      { name: '随机种子', value: '11 / 23 / 47', constraint: '固定 3 个' },
    ],
    metricRows: [
      { name: '验证准确率', value: '86.2', unit: '%', comparable: true, note: '3 种子均值 ±0.9' },
      { name: '训练时长', value: '41', unit: 'min', comparable: true },
      { name: '增强消融增益', value: '+1.4', unit: 'pp', comparable: true },
    ],
    diagnostics: null,
    evidenceLinks: [{ kind: 'external', key: 'asset://runs/exp-a', label: '运行记录 exp-a（演示资产）' }],
    paperCitations: [{ kind: 'paper', key: 'p-p1', label: '文献：小样本适配' }],
    updatedAt: '2026-10-07',
  },
  {
    experimentKey: 'exp-b', attempt: 1, label: '实验 B：全量微调对照', status: 'failed',
    verificationStatus: 'inconclusive', combination: false,
    componentRefs: [{ kind: 'component', key: 'c-reg', revision: 'rev-2', label: '正则微调策略' }],
    schemeKey: 'n-sb', positionKey: 'pos-process',
    config: [
      { name: '权重衰减', value: '5e-4', constraint: null },
      { name: '随机种子', value: '11 / 23 / 59', constraint: '第 3 次中断' },
    ],
    metricRows: [
      { name: '验证准确率', value: '83.1', unit: '%', comparable: true, note: '仅 2 次有效运行' },
      { name: '训练时长', value: '76', unit: 'min', comparable: true },
    ],
    diagnostics: '第 3 次运行在 epoch 9 因磁盘写满中断；属环境故障，非方法失败。',
    evidenceLinks: [{ kind: 'external', key: 'asset://runs/exp-b', label: '运行记录 exp-b（含失败日志）' }],
    paperCitations: [],
    updatedAt: '2026-10-07',
  },
  {
    experimentKey: 'exp-c', attempt: null, label: '实验 C：提示集成（计划）', status: 'planned',
    verificationStatus: 'unverified', combination: false,
    componentRefs: [], schemeKey: 'n-sc', positionKey: 'pos-output',
    config: [{ name: '提示数量', value: '待定', constraint: '候选 {2, 4, 8}' }],
    metricRows: [{ name: '验证准确率', value: null, unit: '%', comparable: true }],
    diagnostics: null, evidenceLinks: [], paperCitations: [], updatedAt: null,
  },
  {
    experimentKey: 'exp-combo', attempt: 2, label: '组合实验：适配器 + 对比损失', status: 'completed',
    verificationStatus: 'verified', combination: true,
    componentRefs: [
      { kind: 'component', key: 'c-lora', revision: 'rev-3', label: 'LoRA 适配器' },
      { kind: 'component', key: 'c-contrast', revision: 'rev-1', label: '对比损失' },
    ],
    schemeKey: 'n-sa', positionKey: 'pos-analysis',
    config: [
      { name: '可训练参数占比', value: '0.9%', constraint: null },
      { name: '温度系数', value: '0.07', constraint: null },
    ],
    // 单模块与组合实验的指标口径不同（本行为跨设备口径），标记为不可比较。
    metricRows: [
      { name: '验证准确率', value: '87.4', unit: '%', comparable: false, note: '跨设备抽测口径，与 exp-a 不可直接比较' },
      { name: '端侧延迟', value: '12.3', unit: 'ms', comparable: false, note: '另一测量装置，单位口径不同' },
    ],
    diagnostics: null,
    evidenceLinks: [{ kind: 'external', key: 'asset://runs/exp-combo', label: '组合实验运行记录' }],
    paperCitations: [{ kind: 'paper', key: 'p-p1', label: '文献：小样本适配' }],
    updatedAt: '2026-10-08',
  },
];

const dlPositions: PositionView[] = [
  { positionKey: 'pos-input', label: '输入', description: '采样、增强与入库前处理' },
  { positionKey: 'pos-process', label: '处理', description: '特征提取与模型适配' },
  { positionKey: 'pos-analysis', label: '分析', description: '损失、判别与归因分析' },
  { positionKey: 'pos-output', label: '输出', description: '结果导出与报告' },
  { positionKey: 'pos-eval', label: '评估', description: '指标计算与复核' },
];

const dlComponents: ComponentView[] = [
  {
    componentKey: 'c-lora', revision: 'rev-3', kind: 'Module', name: 'LoRA 适配器',
    description: '在注意力投影上挂载低秩矩阵，冻结主干进行参数高效微调，适用于小样本场景。',
    tags: ['参数高效', '小样本', '冻结主干'], positionKeys: ['pos-process'],
    capabilities: ['可训练参数占比 <1%', '支持秩 r 配置', '与现有训练管线兼容'],
    missing: [], integrable: true, integrableReason: null, validatedInTask: true, validatedElsewhere: null,
    trial: { count: 3, succeededInTask: true, lastAttemptAt: '2026-10-07' },
    rankScore: 98, lastUsedAt: '2026-10-07',
    source: { author: '算法平台组', origin: '内部组件库 / 参数高效适配', version: 'v2.1.0', license: '内部使用', url: null },
    problem: '小样本下全量微调过拟合、训练成本高。',
    recommendedPositions: ['处理'],
    experimentLinks: [{ kind: 'experiment', key: 'exp-a', label: '实验 A（单模块）' }, { kind: 'experiment', key: 'exp-combo', label: '组合实验' }],
    paperLinks: [{ kind: 'paper', key: 'p-p1', label: '相关文献：低秩适配综述' }],
    canCreateTrial: true, createTrialReason: null,
  },
  {
    componentKey: 'c-aug', revision: 'rev-5', kind: 'Method', name: '任务相关增强管线',
    description: '按缺陷形态生成旋转、弹性畸变与 MixUp 组合，采样强度可按类别配平。',
    tags: ['数据增强', '类别配平'], positionKeys: ['pos-input'],
    capabilities: ['每类样本配平', '增强强度可调'], missing: [],
    integrable: true, integrableReason: null, validatedInTask: false,
    validatedElsewhere: { taskLabel: '巡检缺陷识别任务', detail: '在另一任务上验证过配平逻辑，未在本任务验证。' },
    trial: { count: 1, succeededInTask: null, lastAttemptAt: '2026-10-05' },
    rankScore: 91, lastUsedAt: '2026-10-07',
    source: { author: '数据工程组', origin: '内部方法库', version: 'v1.4.2', license: '内部使用', url: null },
    problem: '类别间样本不均衡导致尾部类别召回低。', recommendedPositions: ['输入'],
    experimentLinks: [{ kind: 'experiment', key: 'exp-a', label: '实验 A 消融项' }], paperLinks: [],
    canCreateTrial: true, createTrialReason: null,
  },
  {
    componentKey: 'c-reg', revision: 'rev-2', kind: 'Baseline', name: '正则化全量微调基线',
    description: '放开全部参数，使用权重衰减、标签平滑与 early stop 的标准微调基线。',
    tags: ['基线', '全量微调'], positionKeys: ['pos-process'],
    capabilities: ['标准对照', '无需改架构'], missing: [],
    integrable: true, integrableReason: null, validatedInTask: false, validatedElsewhere: null,
    trial: { count: 1, succeededInTask: false, lastAttemptAt: '2026-10-07' },
    rankScore: 80, lastUsedAt: '2026-10-07',
    source: { author: '算法平台组', origin: '内部基线库', version: 'v0.9.1', license: 'MIT', url: null },
    problem: '需要无适配的对照基线。', recommendedPositions: ['处理'],
    experimentLinks: [{ kind: 'experiment', key: 'exp-b', label: '实验 B（含一次环境失败）' }],
    paperLinks: [], canCreateTrial: true, createTrialReason: null,
  },
  {
    componentKey: 'c-contrast', revision: 'rev-1', kind: 'Method', name: '监督对比损失',
    description: '在特征空间拉近同类、推远异类，可与适配器组合用于类间分离。',
    tags: ['表征学习', '可组合'], positionKeys: ['pos-analysis'],
    capabilities: ['支持与适配器组合', '温度系数可调'], missing: [],
    integrable: true, integrableReason: null, validatedInTask: false, validatedElsewhere: null,
    trial: { count: 1, succeededInTask: true, lastAttemptAt: '2026-10-08' },
    rankScore: 86, lastUsedAt: '2026-10-08',
    source: { author: '研究一组', origin: '内部方法库', version: 'v0.8.0', license: 'Apache-2.0', url: null },
    problem: '类间特征重叠导致混淆矩阵尾部类别差。', recommendedPositions: ['分析'],
    experimentLinks: [{ kind: 'experiment', key: 'exp-combo', label: '组合实验（口径不同）' }],
    paperLinks: [{ kind: 'paper', key: 'p-p2', label: '对比学习相关文献' }],
    canCreateTrial: true, createTrialReason: null,
  },
  {
    componentKey: 'c-export', revision: 'rev-4', kind: 'Module', name: '评估报告导出器',
    description: '把指标行、混淆矩阵与证据链接汇总为固定模板报告，支持本地留档。',
    tags: ['报告', '留档'], positionKeys: ['pos-output', 'pos-eval'],
    capabilities: ['模板化导出', '自动附带证据链接'], missing: [],
    integrable: true, integrableReason: null, validatedInTask: false, validatedElsewhere: null,
    trial: { count: 0, succeededInTask: null, lastAttemptAt: null },
    rankScore: 72, lastUsedAt: '2026-09-28',
    source: { author: '工具链组', origin: '内部工具库', version: 'v3.0.0', license: '内部使用', url: null },
    problem: '实验结论需要随证据一起留档。', recommendedPositions: ['输出', '评估'],
    experimentLinks: [], paperLinks: [], canCreateTrial: true, createTrialReason: null,
  },
  {
    componentKey: 'c-xai', revision: 'rev-0', kind: 'Module', name: '可解释性归因组件',
    description: '计划中的归因可视化组件，用于回答“适配器学到了什么”，当前实现缺失。',
    tags: ['归因', '待补齐'], positionKeys: ['pos-analysis'],
    capabilities: [], missing: ['缺归因算法实现', '缺与特征图管线的对接'],
    integrable: null, integrableReason: '实现缺失，暂无法评估可接入性。',
    validatedInTask: false, validatedElsewhere: null,
    trial: { count: 0, succeededInTask: null, lastAttemptAt: null },
    rankScore: 55, lastUsedAt: null,
    source: { author: '研究二组', origin: '立项草案', version: null, license: null, url: null },
    problem: '需要解释适配器提升的来源。', recommendedPositions: ['分析'],
    experimentLinks: [], paperLinks: [{ kind: 'paper', key: 'p-p5', label: '归因方法综述（未录入全文）', missingReason: '该文献只有题录，全文尚未入库。' }],
    canCreateTrial: false, createTrialReason: '实现缺失：补齐前不能创建 Trial。',
  },
  {
    componentKey: 'c-cam', revision: 'rev-9', kind: 'Experiment', name: '高速相机采集（机械库）',
    description: '来自机械实验库的高速影像采集组件，适用工况为冲压/切削，与本图像分类任务不匹配。',
    tags: ['机械库', '跨域', '不适用'], positionKeys: ['pos-input'],
    capabilities: ['每秒 5000 帧采集'], missing: ['缺与图像数据管线的接口'],
    integrable: false, integrableReason: '适用工况与本任务数据形态不匹配；许可证不允许跨任务调用。',
    validatedInTask: false,
    validatedElsewhere: { taskLabel: '冲压成形监控任务', detail: '在机械任务上已验证，不能标记为本任务已验证。' },
    trial: { count: 0, succeededInTask: null, lastAttemptAt: null },
    rankScore: 30, lastUsedAt: '2026-08-11',
    source: { author: '装备实验组', origin: '机械实验组件库', version: 'v5.2.0', license: '限装备实验组', url: null },
    problem: '不适用于本任务。', recommendedPositions: [],
    experimentLinks: [], paperLinks: [],
    canCreateTrial: false, createTrialReason: '许可证不允许跨任务调用，且工况不匹配。',
  },
  {
    componentKey: 'c-sweep', revision: 'rev-2', kind: 'Experiment', name: '超参自动扫描',
    description: '对秩、学习率、增强强度做网格/贝叶斯扫描，并输出参数-指标表。',
    tags: ['调参', '扫描'], positionKeys: ['pos-eval'],
    capabilities: ['网格 + 贝叶斯扫描', '参数-指标表导出'], missing: [],
    integrable: null, integrableReason: '是否接入待评估：需要占用额外 GPU 配额。',
    validatedInTask: false, validatedElsewhere: null,
    trial: { count: 2, succeededInTask: true, lastAttemptAt: '2026-10-02' },
    rankScore: 78, lastUsedAt: '2026-10-02',
    source: { author: '平台组', origin: '实验工具库', version: 'v1.7.0', license: '内部使用', url: null },
    problem: '人工枚举超参效率低。', recommendedPositions: ['评估'],
    experimentLinks: [], paperLinks: [], canCreateTrial: true, createTrialReason: null,
  },
];

const dlPapers: PaperView[] = [
  {
    paperKey: 'p-p1', sourceRevision: 'src-7',
    metadata: {
      title: '面向小样本视觉的低秩适配：一项对照研究',
      authors: ['Lin Wen', 'Zhao Yi'], year: 2025, venue: 'Journal of Efficient Learning',
      paperType: '期刊论文', doi: '10.0000/demo-lora-survey',
      url: 'https://example.org/demo/lora-survey',
      localSource: '本地样例：samples/p1-lora-survey.pdf（演示）',
    },
    relevance: { score: 0.92, basis: '直接研究冻结主干 + 低秩适配在小样本分类上的效果，与方案 A 同构。' },
    flags: ['highly_relevant', 'extracted', 'cited'],
    contributions: [
      {
        id: 'p1-c1', category: 'mechanism', title: '机制 / 观点：低秩约束抑制过拟合',
        text: '在每类样本很少时，把增量更新约束在低秩子空间内可减少有效自由度，从而降低过拟合。',
        tags: [{ label: 'claim', tone: 'blue' }, { label: '机制', tone: 'purple' }, { label: '对象：分类头', tone: 'gray' }],
        evidences: [
          { id: 'p1-c1-e1', source: 'paper', label: '论文 §4.2 表 3', locator: '第 7 页，表 3 第 2 行', condition: '每类 20 张', value: '过拟合差距收窄 31%', unit: null },
        ],
        componentLinks: [{ kind: 'component', key: 'c-lora', revision: 'rev-3', label: 'LoRA 适配器' }],
        parameters: null, datasetInfo: null, slotMapping: [],
      },
      {
        id: 'p1-c2', category: 'evidence', title: '实验结果 / 证据：准确率提升可复现',
        text: '论文报告在 4 个小样本基准上低秩适配相对全量微调平均提升 4.1pp；本地实验 A 在自有数据上观察到 +8.2pp。',
        tags: [{ label: '证据', tone: 'green' }, { label: '实验', tone: 'blue' }, { label: '结果', tone: 'gray' }, { label: '对象：验证集', tone: 'gray' }],
        evidences: [
          { id: 'p1-c2-e1', source: 'paper', label: '论文报告值（4 基准均值）', locator: '表 5', condition: '论文基准', value: '+4.1', unit: 'pp' },
          { id: 'p1-c2-e2', source: 'local', label: '本地观察（实验 A）', locator: 'exp-a 指标行', condition: 'split-2026-09', value: '+8.2', unit: 'pp' },
        ],
        componentLinks: [{ kind: 'component', key: 'c-lora', revision: 'rev-3', label: 'LoRA 适配器' }],
        parameters: 'r=8，3 个固定种子', datasetInfo: '4 个公开小样本基准', slotMapping: [],
      },
      {
        id: 'p1-c3', category: 'method', title: '方法 / 方案：适配器 + 任务增强',
        text: '提出把低秩适配与任务相关增强组合，并给出秩与学习率的推荐区间。',
        tags: [{ label: '方法', tone: 'yellow' }, { label: 'claim', tone: 'blue' }, { label: '对象：训练管线', tone: 'gray' }],
        evidences: [{ id: 'p1-c3-e1', source: 'paper', label: '论文 §5', locator: '第 9 页', condition: null, value: null, unit: null }],
        componentLinks: [
          { kind: 'component', key: 'c-lora', revision: 'rev-3', label: 'LoRA 适配器' },
          { kind: 'component', key: 'c-aug', revision: 'rev-5', label: '任务相关增强管线' },
        ],
        parameters: 'r ∈ {4, 8}；lr ∈ {1e-4, 5e-4}', datasetInfo: null, slotMapping: [],
      },
      {
        id: 'p1-c4', category: 'data', title: '数据 / 资源：小样本基准打包',
        text: '发布了统一切分的小样本评估包，含每类 5/10/20 张三档设置。',
        tags: [{ label: '数据集', tone: 'blue' }, { label: '来源 XX', tone: 'gray' }, { label: '对象：评估', tone: 'gray' }],
        evidences: [{ id: 'p1-c4-e1', source: 'paper', label: '论文附录 A', locator: '附录 A', condition: null, value: '三档：5/10/20', unit: '张/类' }],
        componentLinks: [], parameters: null, datasetInfo: '公开基准包，仅限研究用途', slotMapping: [],
      },
      {
        id: 'p1-c5', category: 'slot_mapping', title: '实体 / slot 映射：术语对齐',
        text: '论文的 “increment matrix” 对应本项目适配器组件中的“增量投影”，用于跨文献术语对齐。',
        tags: [{ label: 'slot/映射', tone: 'purple' }, { label: '对象：增量投影', tone: 'gray' }, { label: '术语对齐', tone: 'gray' }],
        evidences: [],
        componentLinks: [{ kind: 'component', key: 'c-lora', revision: 'rev-3', label: 'LoRA 适配器 · 增量投影' }],
        parameters: null, datasetInfo: null,
        slotMapping: [{ sourceTerm: 'increment matrix', targetLabel: 'LoRA 适配器 · 增量投影', target: { kind: 'component', key: 'c-lora', revision: 'rev-3', label: '增量投影' } }],
      },
    ],
    wikiLinks: [
      { key: 'wiki-31', title: 'Wiki：低秩适配与小样本过拟合', version: 'v12', statement: '在每类 ≤20 张的条件下，低秩适配相较全量微调更稳定，证据强度中等。', dependencies: ['p-p1#p1-c2', 'exp-a'], updatedAt: '2026-10-08' },
    ],
    citations: [{ kind: 'experiment', key: 'exp-a', label: '实验 A' }, { kind: 'experiment', key: 'exp-combo', label: '组合实验' }],
    similar: [{ kind: 'paper', key: 'p-p2', label: '相似：参数高效适配方法综述' }, { kind: 'paper', key: 'p-p9', label: '相似：提示集成初探', missingReason: '该相似项题录缺失（演示断链）。' }],
    note: '演示备注：方案 A 的核心依据之一；组合实验口径不同，引用时注意。',
  },
  {
    paperKey: 'p-p2', sourceRevision: 'src-7',
    metadata: { title: '参数高效适配方法综述', authors: ['Chen Hua'], year: 2024, venue: 'Conference on ML Systems', paperType: '会议论文', doi: '10.0000/demo-peft', url: null, localSource: '本地样例：samples/p2-peft.pdf（演示）' },
    relevance: { score: 0.87, basis: '系统比较适配器、前缀与提示方法，为方案选型提供依据。' },
    flags: ['highly_relevant', 'extracted'],
    contributions: [
      { id: 'p2-c1', category: 'method', title: '方法分类：三类参数高效路线', text: '将参数高效方法分为适配器、前缀调参与提示调参三类并比较成本。', tags: [{ label: '综述', tone: 'yellow' }], evidences: [{ id: 'p2-c1-e1', source: 'paper', label: '论文表 2', locator: '表 2', condition: null, value: null, unit: null }], componentLinks: [{ kind: 'component', key: 'c-lora', label: 'LoRA 适配器' }], parameters: null, datasetInfo: null, slotMapping: [] },
    ],
    wikiLinks: [], citations: [], similar: [{ kind: 'paper', key: 'p-p1', label: '低秩适配对照研究' }], note: null,
  },
  {
    paperKey: 'p-p3', sourceRevision: 'src-3',
    metadata: { title: '小样本场景下的数据增强边界', authors: ['Ma Lin', 'Sun Qi'], year: 2025, venue: 'Workshop on Data', paperType: '研讨会论文', doi: null, url: null, localSource: null },
    relevance: { score: 0.83, basis: '讨论增强强度边界，与增强管线参数设置相关。' },
    flags: ['highly_relevant', 'missing_evidence'],
    contributions: [
      { id: 'p3-c1', category: 'mechanism', title: '观点：过强增强改变类别形态', text: '增强强度超过阈值后会改变缺陷形态分布，反而损害尾部类别。', tags: [{ label: 'claim', tone: 'blue' }], evidences: [], componentLinks: [{ kind: 'component', key: 'c-aug', label: '增强管线' }], parameters: null, datasetInfo: null, slotMapping: [] },
    ],
    wikiLinks: [], citations: [], similar: [], note: null,
  },
  {
    paperKey: 'p-p4', sourceRevision: 'src-7',
    metadata: { title: '冻结表征的再训练代价', authors: ['Ito Aoi'], year: 2023, venue: 'ML Quarterly', paperType: '期刊论文', doi: '10.0000/demo-frozen', url: null, localSource: null },
    relevance: { score: 0.76, basis: '解释全量微调与冻结主干的成本差异。' },
    flags: ['extracted', 'cited'],
    contributions: [
      { id: 'p4-c1', category: 'evidence', title: '证据：训练成本对比', text: '全量微调训练时长约为适配器方案的 1.8 倍。', tags: [{ label: '证据', tone: 'green' }], evidences: [{ id: 'p4-c1-e1', source: 'paper', label: '论文图 3', locator: '图 3', condition: null, value: '1.8×', unit: '时长比' }], componentLinks: [{ kind: 'component', key: 'c-reg', label: '全量微调基线' }], parameters: null, datasetInfo: null, slotMapping: [] },
    ],
    wikiLinks: [], citations: [{ kind: 'experiment', key: 'exp-b', label: '实验 B' }], similar: [], note: null,
  },
  {
    paperKey: 'p-p5', sourceRevision: 'src-2',
    metadata: { title: '归因方法综述（仅题录）', authors: ['Group Authors'], year: 2024, venue: 'Preprint', paperType: '预印本', doi: null, url: null, localSource: null },
    relevance: { score: 0.71, basis: '与可解释性组件立项相关。' },
    flags: ['relevant'],
    contributions: [], wikiLinks: [], citations: [], similar: [], note: null,
  },
  {
    paperKey: 'p-p6', sourceRevision: 'src-1',
    metadata: { title: '极端少样本下的正则化经验', authors: ['Kaya Demir'], year: 2022, venue: 'Workshop', paperType: '研讨会论文', doi: null, url: null, localSource: null },
    relevance: { score: 0.68, basis: '权重衰减设置经验，但缺少本任务相关条件。' },
    flags: ['missing_evidence'],
    contributions: [], wikiLinks: [], citations: [], similar: [], note: null,
  },
  {
    paperKey: 'p-p7', sourceRevision: 'src-7',
    metadata: { title: '类别配平采样的工程实践', authors: ['Yu Nan'], year: 2025, venue: 'Engineering Notes', paperType: '技术报告', doi: null, url: null, localSource: null },
    relevance: { score: 0.63, basis: '增强管线配平逻辑的工程参考。' },
    flags: ['relevant', 'extracted'],
    contributions: [
      { id: 'p7-c1', category: 'method', title: '实践：按类配平采样', text: '给出按有效样本数反比配平的工程实现。', tags: [{ label: '工程', tone: 'gray' }], evidences: [{ id: 'p7-c1-e1', source: 'paper', label: '报告 §3', locator: '§3', condition: null, value: null, unit: null }], componentLinks: [{ kind: 'component', key: 'c-aug', label: '增强管线' }], parameters: null, datasetInfo: null, slotMapping: [] },
    ],
    wikiLinks: [], citations: [], similar: [], note: null,
  },
  {
    paperKey: 'p-p8', sourceRevision: 'src-4',
    metadata: { title: '延迟约束下的模型选择', authors: ['Noa Roth'], year: 2024, venue: 'Edge ML', paperType: '会议论文', doi: null, url: null, localSource: null },
    relevance: { score: 0.58, basis: '与端侧部署约束相关，本周期非重点。' },
    flags: ['relevant'],
    contributions: [], wikiLinks: [], citations: [], similar: [], note: null,
  },
  {
    paperKey: 'p-p9', sourceRevision: 'src-0',
    metadata: { title: '测试时提示集成初探（题录缺失）', authors: ['unknown'], year: null, venue: 'unknown', paperType: '未录入', doi: null, url: null, localSource: null },
    relevance: null,
    flags: ['missing_evidence'],
    contributions: [], wikiLinks: [], citations: [], similar: [], note: null,
  },
];

function dlTree(): TreeData {
  return {
    summary: {
      narrative:
        '围绕小样本准确率不足的问题，我们完成了 2 个方案的对照实验：方案 A（LoRA 适配器）表现更优，验证准确率 86.2%（+8.2pp），验证了“低秩约束抑制过拟合”假设的有效性；方案 B 有一次环境失败待补跑。当前为阶段性结论。',
      statementStatus: '阶段性结论，待失败种子补跑复核',
      evidenceLinks: [
        { kind: 'experiment', key: 'exp-a', label: '实验 A 证据' },
        { kind: 'experiment', key: 'exp-b', label: '实验 B 证据（含失败）' },
      ],
      statistics: [
        { key: 'totalExperiments', label: '实验总数', value: '12', tone: 'default' },
        { key: 'validResults', label: '有效结果', value: '10', tone: 'green' },
        { key: 'bestScheme', label: '最佳方案', value: '方案 A', tone: 'purple', link: { kind: 'node', key: 'n-sa', label: '方案 A' } },
        { key: 'mainChange', label: '主要提升', value: '+12.5%', tone: 'pink' },
      ],
      metricComparison: [
        { schemeName: '方案 A · LoRA', cells: dlExperiments[0].metricRows.slice(0, 2) },
        { schemeName: '方案 B · 全量微调', cells: dlExperiments[1].metricRows },
        { schemeName: '组合实验（口径不同）', cells: dlExperiments[3].metricRows },
      ],
      metricComparisonNote: '组合实验为跨设备抽测口径，准确率与延迟两行均不与单模块实验直接比较。',
      nextActions: ['补跑实验 B 失败种子', '评审并启动实验 C', '复核方案 A/B 差距是否超过种子方差'],
    },
    nodes: dlNodes,
    edges: dlEdges,
    activity: dlActivity,
    defaultHiddenNodeIds: ['n-sx'],
  };
}

function dlSnapshot(): WorkbenchSnapshot {
  return {
    task: structuredClone(taskDL),
    preconditions: structuredClone(preconditionsDL),
    tree: { state: { status: 'ready', reason: null }, data: dlTree() },
    tailor: {
      state: { status: 'ready', reason: null },
      data: { positions: structuredClone(dlPositions), components: structuredClone(dlComponents) as ComponentView[] },
    },
    papers: {
      state: { status: 'ready', reason: null },
      data: { papers: structuredClone(dlPapers) as PaperView[], experiments: structuredClone(dlExperiments) as ExperimentView[] },
    },
  };
}

// ---------------------------------------------------------------------------
// scenario 2: mechanical / experiment-management sample (no DL fields)
// ---------------------------------------------------------------------------

const taskMech: TaskView = {
  taskKey: 'task-demo-mech',
  displayName: '演示任务：冲压件表面粗糙度控制',
  researchGoal: '把支架冲压件 A 面粗糙度 Ra 从 1.6 μm 降到 0.8 μm 以下，且不增加整形工序。',
  phase: '测量对比',
  preconditions: ['材料批次已登记 MAT-2026-09-114', '三坐标与粗糙度仪校准记录在有效期内'],
  revision: 'rev-5',
};

const mechPreconditions: PreconditionNote[] = [
  { id: 'mpc-1', severity: 'info', text: '本样例为机械实验管理数据：不含任何深度学习专属字段，指标为粗糙度、振动与回弹角。' },
];

const mechNodes: ResearchNodeView[] = [
  {
    id: 'mn-q', kind: 'question', branch: 'main', status: 'done', childCount: 1, x: 10, y: 230,
    title: '问题：A 面 Ra 超标', summary: '连续 3 批支架冲压件 A 面 Ra 实测 1.5–1.7 μm，高于工艺要求 0.8 μm。',
    rationale: '来自终检不合格记录。', outcome: '定义改进目标 Ra < 0.8 μm。',
    links: [{ kind: 'external', key: 'asset://qc/batches', label: '三批终检记录（演示资产）' }], actor: { role: '工艺工程师', status: '已确认' },
  },
  {
    id: 'mn-h', kind: 'hypothesis', branch: 'main', status: 'retained', childCount: 2, x: 185, y: 230,
    title: '假设：压边力与润滑共同影响表面流动', summary: '假设压边力过大造成材料流动受阻，叠加润滑不均导致 A 面拉伤。',
    rationale: '保留：可在现有压机上通过参数组验证；剪枝“更换模具材料”，因成本与周期不允许。',
    outcome: '拆为方案 A（调压边力）与方案 B（改润滑工艺）。', links: [], actor: { role: '工艺工程师', status: '已保留' },
  },
  {
    id: 'mn-sa', kind: 'scheme', branch: 'A', status: 'expanded', childCount: 2, x: 365, y: 90,
    title: '方案 A：分级压边力', summary: '将恒定压边力改为拉延初期低、后期高的两级曲线。',
    rationale: '扩展：无需新硬件。', outcome: '进入试制 A。',
    links: [{ kind: 'component', key: 'mc-bhf', label: '压边力曲线模块' }], actor: { role: '工艺工程师', status: '已扩展' },
  },
  {
    id: 'mn-ea', kind: 'experiment', branch: 'A', status: 'done', childCount: 3, x: 545, y: 90,
    title: '试制 A：5 件样件', summary: '同一批次材料，5 件样件，按新曲线压制并测量。',
    rationale: null, outcome: '5 件全部有效。',
    links: [{ kind: 'experiment', key: 'm-exp-a', label: '试制 A 记录' }], actor: { role: '实验员', status: '完成' },
  },
  {
    id: 'mn-ra', kind: 'result', branch: 'A', status: 'done', childCount: 2, x: 725, y: 90,
    title: '结果 A：Ra 0.71 μm', summary: '5 件 Ra 均值 0.71 μm（0.66–0.78），达标；回弹角变化 <0.2°。',
    rationale: null, outcome: '达标，等待方案 B 对照。',
    links: [{ kind: 'experiment', key: 'm-exp-a', label: '试制 A 指标' }], actor: null,
  },
  {
    id: 'mn-sb', kind: 'scheme', branch: 'B', status: 'retained', childCount: 2, x: 365, y: 320,
    title: '方案 B：润滑涂布工艺优化', summary: '改用定量涂布并增加首件擦拭频次。',
    rationale: '保留：低成本对照。', outcome: '进入试制 B。',
    links: [{ kind: 'component', key: 'mc-lube', label: '定量涂布模块' }], actor: { role: '工艺工程师', status: '已保留' },
  },
  {
    id: 'mn-eb', kind: 'experiment', branch: 'B', status: 'blocked', childCount: 2, x: 545, y: 320,
    title: '试制 B：等待涂布工装', summary: '定量涂布工装仍在校准，试制暂缓。',
    rationale: null, outcome: '被阻塞，尚无结果（与失败不同）。',
    links: [], actor: { role: '实验员', status: '等待工装' },
  },
  {
    id: 'mn-sc', kind: 'scheme', branch: 'C', status: 'planned', childCount: 1, x: 365, y: 452,
    title: '方案 C（备选）：仿真寻优', summary: '用有限元仿真搜索压边力-润滑联合窗口，作为 A 达标后的推广依据。',
    rationale: '计划：先实物确认方向再投入仿真建模。', outcome: '未开始。',
    links: [{ kind: 'component', key: 'mc-fem', label: '有限元仿真模板' }], actor: { role: '仿真工程师', status: '计划' },
  },
];

const mechEdges: ResearchEdgeView[] = [
  { id: 'me-1', sourceId: 'mn-q', targetId: 'mn-h', relation: '主流程', planned: false, reason: null },
  { id: 'me-2', sourceId: 'mn-h', targetId: 'mn-sa', relation: '拆分', planned: false, reason: null },
  { id: 'me-3', sourceId: 'mn-h', targetId: 'mn-sb', relation: '拆分', planned: false, reason: null },
  { id: 'me-4', sourceId: 'mn-sa', targetId: 'mn-ea', relation: '试制', planned: false, reason: null },
  { id: 'me-5', sourceId: 'mn-ea', targetId: 'mn-ra', relation: '产出', planned: false, reason: null },
  { id: 'me-6', sourceId: 'mn-sb', targetId: 'mn-eb', relation: '试制', planned: false, reason: null },
  { id: 'me-7', sourceId: 'mn-h', targetId: 'mn-sc', relation: '关联/计划', planned: true, reason: '推广依据' },
];

const mechPositions: PositionView[] = [
  { positionKey: 'mp-cond', label: '工况', description: '压力、行程、压边力等工艺工况' },
  { positionKey: 'mp-spec', label: '样件', description: '材料批次与样件管理' },
  { positionKey: 'mp-meas', label: '测量', description: '粗糙度、三坐标与振动测量' },
  { positionKey: 'mp-sim', label: '仿真', description: '成形与回弹仿真' },
  { positionKey: 'mp-eval', label: '评估', description: '工艺窗口与合格判定' },
];

const mechComponents: ComponentView[] = [
  {
    componentKey: 'mc-bhf', revision: 'rev-2', kind: 'Module', name: '压边力曲线模块',
    description: '为压机控制器配置两级压边力曲线，支持按行程段设值并回读实际曲线。',
    tags: ['压机', '压边力'], positionKeys: ['mp-cond'],
    capabilities: ['分段压力设定', '实际曲线回读'], missing: [],
    integrable: true, integrableReason: null, validatedInTask: true, validatedElsewhere: null,
    trial: { count: 1, succeededInTask: true, lastAttemptAt: '2026-10-05' },
    rankScore: 90, lastUsedAt: '2026-10-05',
    source: { author: '装备组', origin: '车间工艺组件库', version: 'v1.2.0', license: '厂内使用', url: null },
    problem: '恒定压边力导致初期材料流动受阻。', recommendedPositions: ['工况'],
    experimentLinks: [{ kind: 'experiment', key: 'm-exp-a', label: '试制 A' }], paperLinks: [],
    canCreateTrial: true, createTrialReason: null,
  },
  {
    componentKey: 'mc-lube', revision: 'rev-1', kind: 'Method', name: '定量涂布模块',
    description: '按单位面积涂油量定量涂布并记录首件擦拭频次。',
    tags: ['润滑', '涂布'], positionKeys: ['mp-spec'],
    capabilities: ['定量涂布', '涂油记录'], missing: ['缺定量涂布工装校准记录'],
    integrable: true, integrableReason: null, validatedInTask: false, validatedElsewhere: null,
    trial: { count: 0, succeededInTask: null, lastAttemptAt: null },
    rankScore: 70, lastUsedAt: null,
    source: { author: '车间班组', origin: '工艺方法库', version: 'v0.5.0', license: '厂内使用', url: null },
    problem: '润滑不均造成 A 面拉伤。', recommendedPositions: ['样件'],
    experimentLinks: [], paperLinks: [], canCreateTrial: false,
    createTrialReason: '定量涂布工装尚未完成校准，暂不能安排试制。',
  },
  {
    componentKey: 'mc-fem', revision: 'rev-4', kind: 'Experiment', name: '有限元成形仿真模板',
    description: '已标定材料卡的冲压成形-回弹一体化仿真模板，输出工艺窗口。',
    tags: ['仿真', '回弹'], positionKeys: ['mp-sim', 'mp-eval'],
    capabilities: ['成形极限预测', '回弹角计算'], missing: [],
    integrable: true, integrableReason: null, validatedInTask: false,
    validatedElsewhere: { taskLabel: '车门内板任务', detail: '在车门件上标定过，本材料卡需重新标定。' },
    trial: { count: 0, succeededInTask: null, lastAttemptAt: '2026-09-20' },
    rankScore: 75, lastUsedAt: '2026-09-20',
    source: { author: '仿真组', origin: '仿真模板库', version: 'v4.0.0', license: '厂内使用', url: null },
    problem: '需要联合参数窗口而非单点试错。', recommendedPositions: ['仿真', '评估'],
    experimentLinks: [], paperLinks: [], canCreateTrial: true, createTrialReason: null,
  },
  {
    componentKey: 'mc-ra', revision: 'rev-3', kind: 'Module', name: '粗糙度测量与判读',
    description: '粗糙度仪测量记录与合格判定，按测点组织并关联样件编号。',
    tags: ['粗糙度', '终检'], positionKeys: ['mp-meas'],
    capabilities: ['多点 Ra 测量', '按样件归档'], missing: [],
    integrable: true, integrableReason: null, validatedInTask: true, validatedElsewhere: null,
    trial: { count: 5, succeededInTask: true, lastAttemptAt: '2026-10-05' },
    rankScore: 92, lastUsedAt: '2026-10-05',
    source: { author: '质检组', origin: '测量组件库', version: 'v2.3.1', license: '厂内使用', url: null },
    problem: '需要可追溯的测点数据。', recommendedPositions: ['测量'],
    experimentLinks: [{ kind: 'experiment', key: 'm-exp-a', label: '试制 A 测量' }], paperLinks: [],
    canCreateTrial: true, createTrialReason: null,
  },
];

const mechExperiments: ExperimentView[] = [
  {
    experimentKey: 'm-exp-a', attempt: 1, label: '试制 A：分级压边力 5 件', status: 'completed',
    verificationStatus: 'verified', combination: false,
    componentRefs: [{ kind: 'component', key: 'mc-bhf', label: '压边力曲线模块' }, { kind: 'component', key: 'mc-ra', label: '粗糙度测量与判读' }],
    schemeKey: 'mn-sa', positionKey: 'mp-cond',
    config: [
      { name: '初期压边力', value: '180', constraint: 'kN，行程 0–40%' },
      { name: '后期压边力', value: '260', constraint: 'kN，行程 40–100%' },
      { name: '材料批次', value: 'MAT-2026-09-114', constraint: '同批 5 件' },
    ],
    metricRows: [
      { name: '粗糙度 Ra', value: '0.71', unit: 'μm', comparable: true, note: '5 件均值，范围 0.66–0.78' },
      { name: '回弹角变化', value: '0.18', unit: '°', comparable: true },
      { name: '压机振动峰值', value: '2.4', unit: 'mm/s', comparable: false, note: '手持测振仪测点，不与产线固定测点比较' },
    ],
    diagnostics: null,
    evidenceLinks: [{ kind: 'external', key: 'asset://trials/m-exp-a', label: '试制 A 原始测量单（演示资产）' }],
    paperCitations: [], updatedAt: '2026-10-05',
  },
];

const mechPapers: PaperView[] = [
  {
    paperKey: 'mp-1', sourceRevision: 'src-2',
    metadata: { title: '高强钢冲压表面拉伤的工艺因素分析', authors: ['王建设', '李群'], year: 2023, venue: '塑性工程学报', paperType: '期刊论文', doi: '10.0000/demo-stamping', url: null, localSource: '本地样例：samples/mp1-stamping.pdf（演示）' },
    relevance: { score: 0.81, basis: '研究压边力与润滑对 A 面拉伤的耦合影响，与本任务因素一致。' },
    flags: ['highly_relevant', 'extracted'],
    contributions: [
      { id: 'mp1-c1', category: 'evidence', title: '证据：压边力区间与 Ra 关系', text: '在 180–280 kN 区间内，初期压边力每降低 20 kN，Ra 平均改善约 0.09 μm。', tags: [{ label: '证据', tone: 'green' }], evidences: [{ id: 'mp1-e1', source: 'paper', label: '论文图 6', locator: '图 6', condition: '1.2 mm 高强钢', value: '-0.09', unit: 'μm / 20kN' }], componentLinks: [{ kind: 'component', key: 'mc-bhf', label: '压边力曲线模块' }], parameters: null, datasetInfo: null, slotMapping: [] },
      { id: 'mp1-c2', category: 'slot_mapping', title: '实体映射：blank holder force', text: '论文术语 blank holder force 对应本项目“压边力曲线模块”的分段设定值。', tags: [{ label: 'slot/映射', tone: 'purple' }], evidences: [], componentLinks: [{ kind: 'component', key: 'mc-bhf', label: '压边力曲线模块' }], parameters: null, datasetInfo: null, slotMapping: [{ sourceTerm: 'blank holder force (BHF)', targetLabel: '压边力曲线模块 · 分段设定值', target: { kind: 'component', key: 'mc-bhf', label: '分段压边力' } }] },
    ],
    wikiLinks: [], citations: [{ kind: 'experiment', key: 'm-exp-a', label: '试制 A' }], similar: [], note: null,
  },
];

function mechSnapshot(): WorkbenchSnapshot {
  return {
    task: structuredClone(taskMech),
    preconditions: structuredClone(mechPreconditions),
    tree: {
      state: { status: 'ready', reason: null },
      data: {
        summary: {
          narrative:
            '围绕冲压件 A 面 Ra 超标问题，方案 A（分级压边力）首批 5 件样件 Ra 均值 0.71 μm，已达标；方案 B（定量涂布）因涂布工装校准被阻塞，尚未试制。方案 C 仿真寻优待 A 复核后启动。',
          statementStatus: '初步结论，待方案 B 对照',
          evidenceLinks: [{ kind: 'experiment', key: 'm-exp-a', label: '试制 A 测量单' }],
          statistics: [
            { key: 'totalExperiments', label: '试制组数', value: '2', tone: 'default' },
            { key: 'validResults', label: '有效样件', value: '5', tone: 'green' },
            { key: 'bestScheme', label: '当前最优', value: '方案 A', tone: 'purple' },
            { key: 'mainChange', label: '主要变化', value: 'Ra −0.9 μm', tone: 'pink' },
          ],
          metricComparison: null,
          metricComparisonNote: '方案 B 尚无有效测量，当前不做方案间数值比较。',
          nextActions: ['完成定量涂布工装校准', '安排试制 B', '达标后启动方案 C 仿真标定'],
        },
        nodes: structuredClone(mechNodes), edges: structuredClone(mechEdges),
        activity: [
          { id: 'ma-1', time: '2026-10-03 08:30', action: '确认问题', actor: '工艺工程师', target: { kind: 'node', key: 'mn-q', label: 'Ra 超标' }, result: '三批记录复核通过' },
          { id: 'ma-2', time: '2026-10-04 13:00', action: '试制', actor: '实验员', target: { kind: 'experiment', key: 'm-exp-a', label: '试制 A' }, result: '5/5 有效，Ra 达标' },
          { id: 'ma-3', time: '2026-10-05 16:20', action: '创建试制请求', actor: '工艺工程师', target: { kind: 'component', key: 'mc-lube', label: '定量涂布模块' }, result: '已拒绝', rejected: true, rejectReason: '定量涂布工装校准未完成，不允许安排试制。' },
        ],
        defaultHiddenNodeIds: [],
      },
    },
    tailor: {
      state: { status: 'ready', reason: null },
      data: { positions: structuredClone(mechPositions), components: structuredClone(mechComponents) as ComponentView[] },
    },
    papers: {
      state: { status: 'ready', reason: null },
      data: { papers: structuredClone(mechPapers) as PaperView[], experiments: structuredClone(mechExperiments) as ExperimentView[] },
    },
  };
}

// ---------------------------------------------------------------------------
// state scenarios
// ---------------------------------------------------------------------------

function baseTask(over: Partial<TaskView>): TaskView {
  return { ...structuredClone(taskDL), ...over };
}

function emptySnapshot(): WorkbenchSnapshot {
  return {
    task: baseTask({ taskKey: 'task-demo-empty', displayName: '演示任务：空任务', revision: 'rev-1' }),
    preconditions: [{ id: 'epc', severity: 'info', text: '该任务刚创建，尚无研究内容。' }],
    tree: { state: { status: 'empty', reason: '还没有研究节点：先在对话中明确问题与假设。' }, data: null },
    tailor: { state: { status: 'empty', reason: '该任务还没有可复用组件记录。' }, data: null },
    papers: { state: { status: 'empty', reason: '尚未导入或抽取任何文献。' }, data: null },
  };
}

function errorSnapshot(): WorkbenchSnapshot {
  const base = dlSnapshot();
  return {
    ...base,
    task: baseTask({ taskKey: 'task-demo-error', displayName: '演示任务：读取失败', revision: 'rev-14' }),
    preconditions: [{ id: 'xpc', severity: 'blocked', text: '部分区域读取失败；失败区域不会伪装成空数据，其他区域仍可浏览。' }],
    tree: { state: { status: 'error', reason: '读取失败（演示）：工作树服务返回 500，请求 req-77f1 已记录。' }, data: null },
    papers: { state: { status: 'blocked', reason: '证据库授权未完成（演示）：需要研究负责人确认访问范围。' }, data: null },
  };
}

function blockedSnapshot(): WorkbenchSnapshot {
  const base = mechSnapshot();
  return {
    ...base,
    task: baseTask({ taskKey: 'task-demo-blocked', displayName: '演示任务：证据不足', revision: 'rev-5' }),
    preconditions: [{ id: 'bpc', severity: 'warning', text: '证据不足：方案 B 没有有效测量，结论不能仅凭方案 A 单点结果外推。' }],
    papers: { state: { status: 'blocked', reason: '证据不足（演示）：关键因素“润滑均匀性”没有可追溯测量，暂不生成结论性评分。' }, data: null },
  };
}

function staleSnapshot(): WorkbenchSnapshot {
  const s = dlSnapshot();
  return {
    ...s,
    task: { ...s.task, taskKey: 'task-demo-stale', displayName: '演示任务：历史版本视图', revision: 'rev-15' },
    preconditions: [
      { id: 'spc', severity: 'warning', text: '当前展示的是 rev-12 的缓存内容，任务已发布 rev-15；旧快照不会覆盖新值，刷新后可更新。' },
    ],
    tree: { state: { status: 'stale', reason: '工作树数据停留在 rev-12，最新版本为 rev-15。', staleRevision: 'rev-12' }, data: s.tree.data },
    tailor: { state: { status: 'stale', reason: '组件目录停留在 rev-12。', staleRevision: 'rev-12' }, data: s.tailor.data },
    papers: { state: { status: 'ready', reason: null }, data: s.papers.data },
  };
}

function loadingSnapshot(): WorkbenchSnapshot {
  return {
    task: baseTask({ taskKey: 'task-demo-loading', displayName: '演示任务：加载中', revision: 'rev-1' }),
    preconditions: [],
    tree: { state: { status: 'loading', reason: '正在读取研究图…' }, data: null },
    tailor: { state: { status: 'loading', reason: '正在读取组件目录…' }, data: null },
    papers: { state: { status: 'loading', reason: '正在读取文献库…' }, data: null },
  };
}

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

export type ScenarioId =
  | 'dl'
  | 'mech'
  | 'empty'
  | 'error'
  | 'blocked'
  | 'stale'
  | 'loading';

export interface ScenarioDef {
  id: ScenarioId;
  label: string;
  description: string;
  build: () => WorkbenchSnapshot;
}

export const SCENARIOS: ScenarioDef[] = [
  { id: 'dl', label: '通用研究 A/B/C（完整）', description: '三页完整数据：A/B 对照、C 计划、单模块与组合实验、动作拒绝记录。', build: dlSnapshot },
  { id: 'mech', label: '机械实验管理样例', description: '工况/样件/测量/仿真/评估位置；粗糙度等机械指标；无深度学习字段。', build: mechSnapshot },
  { id: 'empty', label: '空任务', description: '三个区域均为真实空状态并给出原因。', build: emptySnapshot },
  { id: 'error', label: '读取失败', description: '工作树 error、论文 blocked、裁缝铺仍可读，验证区域级失败隔离。', build: errorSnapshot },
  { id: 'blocked', label: '证据不足 / 阻塞', description: '缺少关键测量，不生成结论性评分。', build: blockedSnapshot },
  { id: 'stale', label: '历史版本 stale', description: '工作树/裁缝铺停留在 rev-12，任务已到 rev-15。', build: staleSnapshot },
  { id: 'loading', label: '加载中', description: '三个区域独立 loading。', build: loadingSnapshot },
];

export function buildScenario(id: ScenarioId): WorkbenchSnapshot {
  const def = SCENARIOS.find((d) => d.id === id) ?? SCENARIOS[0];
  return def.build();
}
