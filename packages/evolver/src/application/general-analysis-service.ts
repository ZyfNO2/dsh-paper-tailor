import * as fs from 'node:fs';
import * as path from 'node:path';
import { BootstrapError, type BootstrapState } from '../contracts/research-bootstrap.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';
import { validateAnalysisPlan, validateCalculation, validateCalculationArtifact, validateGeneralReview, type GeneralAnalysisPlan, type GeneralCalculation, type GeneralReview, type GeneralJudgment, type CalculationArtifact, type GeneralAnalysisProjection, type GeneralNextAction } from '../contracts/general-analysis.ts';
import { validateGeneralResearch, type GeneralResearch } from '../contracts/general-research.ts';
import { ResearchBootstrapStore, requireResearch, type MutationResult } from './research-bootstrap-store.ts';
import { GeneralMaterialStore } from './general-material-store.ts';
import { ResearchCycleStore } from './research-cycle-store.ts';
import { calculateDescriptive, CalculationBlocked, DESCRIPTIVE_TOOL, ANALYSIS_LIMITS } from './general-descriptive.ts';
import { dependencySnapshotHash } from './general-graph-context.ts';
import { validateMetricContext } from '../contracts/general-metrics.ts';
import { assertGeneralSourceAccess, generalSourceAllowed } from './general-source-access.ts';
import { generalNodeStates } from './general-workflow-service.ts';
import { GeneralFollowupService } from './general-followup-service.ts';

interface Write { operationId: string; baseRevision: number; researchId: string }
export interface SaveAnalysisPlanInput extends Write {
  metricContext?: GeneralAnalysisPlan['metricContext'];
  planId?: string | null; nodeId: string; title: string; goal: string; datasetId: string; datasetVersion: number;
  ideaId?: string | null;
  method: GeneralAnalysisPlan['method']; numericColumns: number[]; groupBy: number[]; sampleColumns: number[];
  rowRange: GeneralAnalysisPlan['rowRange']; missingPolicy: GeneralAnalysisPlan['missingPolicy']; missingGroupPolicy: GeneralAnalysisPlan['missingGroupPolicy'];
  requiredConditions: string[]; comparisonScope: string; limitations: string[];
}
export const dictionaryHash = (dataset: unknown): string => cycleContentHash('general-dictionary-v1', dataset);
export const nodeHash = (node: unknown): string => cycleContentHash('general-node-v1', node);
export const generalContextHash = (g: GeneralResearch): string => cycleContentHash('general-profile-context-v1', { domains: g.domains, methods: g.methods, entryMode: g.entryMode, reference: g.reference, constraints: g.constraints, ideas: g.ideas.map(i => ({ ideaId: i.ideaId, revision: i.revision })) });
export function calculationFreshness(general: GeneralResearch, calculation: GeneralCalculation, ancestors = new Set<string>()): { status: 'current' | 'needs_review'; reasons: string[] } {
  const reasons: string[] = [];
  if (ancestors.has(calculation.calculationId)) return { status: 'needs_review', reasons: ['前轮依据形成循环，不能作为当前计算证据。'] };
  const lineage = new Set(ancestors); lineage.add(calculation.calculationId);
  const plan = general.plans.find(p => p.planId === calculation.planId && p.version === calculation.planVersion);
  if (!plan) return { status: 'needs_review', reasons: ['运行方案缺失。'] };
  for (const id of plan.nodeContext?.task?.sourceIds ?? []) { if (!generalSourceAllowed(general, id)) reasons.push('前轮来源已撤销。'); if (general.sources.some(s => s.previousSourceId === id)) reasons.push('前轮来源已有新版本。'); }
  for (const id of plan.nodeContext?.task?.calculationIds ?? []) { const previous = general.calculations.find(c => c.calculationId === id); if (!previous) reasons.push('前轮计算依据缺失。'); else reasons.push(...calculationFreshness(general, previous, lineage).reasons.map(r => `前轮依据：${r}`)); }
  if (!generalSourceAllowed(general, calculation.input.sourceId)) reasons.push('运行来源已撤销，历史产物不可重新作为证据。');
  if (plan.contextHash ? plan.contextHash !== generalContextHash(general) : general.profileRevision > 1) reasons.push('研究方法 / 约束 / 参照语义已更新；旧分析协议需重审。');
  if (general.datasets.some(d => d.datasetId === calculation.input.datasetId && d.version > calculation.input.version)) reasons.push('数据字典 / 处理版本已更新；旧运行输入未被覆盖。');
  if (general.sources.some(s => s.previousSourceId === calculation.input.sourceId)) reasons.push('原始资料登记了新版本；旧来源仍保留。');
  if (general.plans.some(p => p.planId === calculation.planId && p.version > calculation.planVersion)) reasons.push('分析协议已有新版本。');
  if (plan.dependencySnapshotHash ? plan.dependencySnapshotHash !== dependencySnapshotHash(general, plan.nodeId) : general.graph.revision > 1) reasons.push('分析节点的前置关系或上游方法 / 协议已变化。');
  const node = general.graph.nodes.find(n => n.nodeId === calculation.nodeId);
  if (!node || nodeHash(node) !== plan.nodeSnapshotHash) reasons.push('节点方法 / 完成标准已变更。');
  if (calculation.idea && general.ideas.some(i => i.ideaId === calculation.idea!.ideaId && i.revision !== calculation.idea!.revision)) reasons.push('Idea 有新版本。');
  return { status: reasons.length ? 'needs_review' : 'current', reasons };
}
export function reviewFreshness(general: GeneralResearch, review: GeneralReview): { status: 'current' | 'needs_review'; reasons: string[] } {
  const reasons = review.calculationIds.flatMap(id => {
    const calculation = general.calculations.find(c => c.calculationId === id);
    return calculation ? calculationFreshness(general, calculation).reasons : ['审查关联运行缺失。'];
  });
  for (const id of review.sourceRefs) {
    if (!generalSourceAllowed(general, id)) reasons.push('审查引用来源已撤销。');
    if (general.sources.some(s => s.previousSourceId === id)) reasons.push('审查引用的资料已有新版本。');
  }
  if (review.dependencySnapshotHash ? review.dependencySnapshotHash !== dependencySnapshotHash(general, review.nodeId) : general.graph.revision > 1) reasons.push('审查节点的前置或上游方法已变化。');
  const node = general.graph.nodes.find(n => n.nodeId === review.nodeId);
  if (review.nodeSnapshotHash ? !node || nodeHash(node) !== review.nodeSnapshotHash : general.graph.revision > 1) reasons.push('审查节点或判断协议变化，旧意见待重审。');
  if (review.contextHash ? review.contextHash !== generalContextHash(general) : general.profileRevision > 1) reasons.push('审查对应的研究约束 / 参照已变化。');
  return { status: reasons.length ? 'needs_review' : 'current', reasons: [...new Set(reasons)] };
}

export function generalNextActions(g: GeneralResearch): GeneralNextAction[] {
  const actions: GeneralNextAction[] = [];
  const analysisNode = g.graph.nodes.find(n => n.kind === 'analysis')?.nodeId ?? g.graph.nodes[0]?.nodeId ?? '';
  const materialsNode = g.graph.nodes.find(n => n.kind === 'materials')?.nodeId ?? analysisNode;
  if (!g.sources.length) return [{ kind: 'materials', label: '收集或导入已有材料', reason: '仅有 Idea；可以继续规划，不能生成虚构结果。', nodeId: materialsNode, page: 'data' }];
  for (const source of g.sources.filter(s => s.parseStatus === 'failed' && !g.sources.some(newer => newer.previousSourceId === s.sourceId))) actions.push({ kind: 'fix', label: `处理 ${source.filename} 的解析首错`, reason: source.firstError!.message, nodeId: materialsNode, page: 'data' });
  const latestPlans = g.plans.filter(p => !g.plans.some(newer => newer.planId === p.planId && newer.version > p.version));
  if (!latestPlans.length && g.datasets.length) actions.push({ kind: 'plan', label: '建立方法相关分析协议', reason: '材料已登记，但尚无保存的分析范围、方法或参数；不会自动启动。', nodeId: analysisNode, page: 'results' });
  for (const plan of latestPlans) {
    const calculation = g.calculations.filter(c => c.planId === plan.planId && c.planVersion === plan.version).sort((a, b) => b.attempt - a.attempt)[0];
    if (!calculation) actions.push({ kind: 'calculate', label: `检查并授权「${plan.title}」`, reason: `方案 v${plan.version} 已保存，未运行；执行前检查冻结字典 v${plan.dataset.version} 和条件。`, nodeId: plan.nodeId, page: 'results' });
    else if (calculation.status !== 'completed') actions.push({ kind: 'fix', label: `处理「${plan.title}」的${calculation.status === 'blocked' ? '阻塞' : '失败'}`, reason: calculation.firstError!.message, nodeId: plan.nodeId, page: 'data' });
    else if (calculationFreshness(g, calculation).status === 'needs_review') actions.push({ kind: 'reanalyse', label: `重审「${plan.title}」的输入变化`, reason: calculationFreshness(g, calculation).reasons.join(' '), nodeId: plan.nodeId, page: 'results' });
    else if (!g.reviews.some(r => r.calculationIds.includes(calculation.calculationId))) actions.push({ kind: 'review', label: `审查「${plan.title}」的实际产物`, reason: '工具执行已完成；研究判断仍未登记，不能自动授予支持。', nodeId: plan.nodeId, page: 'results' });
  }
  for (const review of g.reviews.filter(r => !g.reviews.some(newer => newer.nodeId === r.nodeId && g.reviews.indexOf(newer) > g.reviews.indexOf(r)))) {
    const freshness = reviewFreshness(g, review);
    if (freshness.status === 'needs_review') actions.push({ kind: 'reanalyse', label: '依据旧审查重新确认研究边界', reason: freshness.reasons.join(' '), nodeId: review.nodeId, page: 'results' });
    else for (const next of review.nextActions) actions.push({ kind: 'followup', label: next, reason: `来自 ${review.reviewer.identity} 的有依据审查建议；未自动运行下一轮。`, nodeId: review.nodeId, page: 'flow' });
  }
  if (!actions.length && !g.datasets.length) actions.push({ kind: 'plan', label: '整理附件依据与后续验证方案', reason: '已登记附件，但没有可解析数值表；可继续已有材料分析，不捏造数值计算。', nodeId: analysisNode, page: 'flow' });
  return actions;
}
export function analysisProjection(g: GeneralResearch): GeneralAnalysisProjection {
  return { nextActions: generalNextActions(g), plans: g.plans, calculations: g.calculations.map(c => ({ ...c, freshness: calculationFreshness(g, c) })), reviews: g.reviews.map(r => ({ ...r, freshness: reviewFreshness(g, r) })) };
}

/** Deterministic tools reuse CycleStore publications, not a second runtime or artifact namespace. */
export class GeneralAnalysisService {
  readonly store: ResearchBootstrapStore;
  readonly materials: GeneralMaterialStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; this.materials = new GeneralMaterialStore(store.workspaceRoot); }

  private publications(researchId: string): ResearchCycleStore {
    if (!/^[\w-]+$/.test(researchId)) throw new BootstrapError('POLICY_DENIED', '非法研究产物命名空间。');
    let current = this.store.workspaceRoot;
    for (const part of ['', '.dsh', 'research', 'cycles', researchId, 'artifacts']) {
      if (part) current = path.join(current, part);
      if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory())) throw new BootstrapError('POLICY_DENIED', '计算产物路径包含链接或非目录。');
    }
    return new ResearchCycleStore(this.store.workspaceRoot, researchId);
  }

  private calculationContent(researchId: string, calculation: GeneralCalculation, general: GeneralResearch): CalculationArtifact | null {
    if (!calculation.artifact) return null;
    const publications = this.publications(researchId);
    const file = path.join(publications.artifactsDir, `${calculation.artifact.sha256}.json`);
    if (fs.existsSync(file) && (fs.lstatSync(file).isSymbolicLink() || !fs.lstatSync(file).isFile() || fs.statSync(file).size > ANALYSIS_LIMITS.maxArtifactBytes)) throw new BootstrapError('SOURCE_STALE', '计算产物类型非法、为链接或已超限。');
    const raw = publications.readArtifactJson(calculation.artifact);
    let content: CalculationArtifact;
    try { content = validateCalculationArtifact(raw); }
    catch (error) { throw new BootstrapError('SOURCE_STALE', '计算产物结构无效：' + (error instanceof Error ? error.message : String(error))); }
    const plan = general.plans.find(p => p.planId === calculation.planId && p.version === calculation.planVersion)!;
    const dataset = general.datasets.find(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version)!;
    const source = general.sources.find(s => s.sourceId === plan.dataset.sourceId)!;
    const snapshot = { sourceHash: source.sha256, parsedHash: source.parsedSha256, parser: source.parser, dictionaryHash: dictionaryHash(dataset), excludedRows: dataset.excludedRows, fields: dataset.fields, conditions: dataset.conditions };
    const binding = (p: GeneralAnalysisPlan, input: CalculationArtifact['inputSnapshot'], nature: CalculationArtifact['sourceNature'], tool: GeneralCalculation['tool'], startedAt: string) => cycleContentHash('general-calculation-binding-v1', { plan: p, input, nature, tool, startedAt });
    const actualTool = { name: content.tool.name, version: content.tool.version, runtime: content.tool.runtime };
    if (snapshot.dictionaryHash !== calculation.input.dictionarySha256 || binding(content.plan, content.inputSnapshot, content.sourceNature, actualTool, content.startedAt) !== binding(plan, snapshot, calculation.inputNature, calculation.tool, calculation.startedAt)) throw new BootstrapError('SOURCE_STALE', '登记计算产物与冻结协议/输入快照不一致。');
    const table = source.tables.find(t => t.tableId === plan.dataset.tableId)!;
    if (content.selection.totalRows !== table.rowCount || content.summaries.some(s => {
      const field = dataset.fields.find(f => f.column === s.column)!;
      return s.label !== field.label || s.unit !== (field.conversion?.targetUnit ?? field.unit) || s.group.some(g => g.label !== dataset.fields.find(f => f.column === g.column)!.label);
    })) throw new BootstrapError('SOURCE_STALE', '计算产物字段、单位或选定表格与输入快照不一致。');
    const expectedChart = plan.numericColumns.map(column => ({ kind: 'mean_by_group', unit: dataset.fields.find(f => f.column === column)!.conversion?.targetUnit ?? dataset.fields.find(f => f.column === column)!.unit!, series: content.summaries.filter(s => s.column === column).map(s => ({ label: s.group.map(g => `${g.label}=${g.value === null ? '缺失分组' : g.value}`).join(' / ') || '全部纳入记录', mean: s.statistics.mean, count: s.statistics.count })) }));
    if (cycleContentHash('general-chart-v1', content.chart) !== cycleContentHash('general-chart-v1', expectedChart)) throw new BootstrapError('SOURCE_STALE', '计算产物图表与实际汇总不一致。');
    return content;
  }

  savePlan(input: SaveAnalysisPlanInput): MutationResult<{ planId: string; version: number }> {
    const { operationId, baseRevision, ...payload } = input;
    return this.store.mutate({ operationId, baseRevision, kind: 'save_general_analysis_plan', researchId: input.researchId, requestPayload: payload,
      apply: context => {
        const research = requireResearch(context.state, input.researchId), g = research.general;
        if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
        const node = g.graph.nodes.find(n => n.nodeId === input.nodeId);
        if (!node || node.kind !== 'analysis') throw new BootstrapError('INVALID_INPUT', '基础计算方案只能关联本研究分析节点。');
        if (node.task) new GeneralFollowupService(this.store).freeze(input.researchId, node, node.task.sourceIds, context.state);
        const previous = input.planId ? g.plans.filter(p => p.planId === input.planId).sort((a, b) => b.version - a.version)[0] : undefined;
        if (input.planId && (!previous || previous.nodeId !== node.nodeId)) throw new BootstrapError('NOT_FOUND', '原分析方案不属于该节点。');
        const dataset = g.datasets.find(d => d.datasetId === input.datasetId && d.version === input.datasetVersion);
        if (!dataset) throw new BootstrapError('SOURCE_MISSING', '指定数据字典版本不属于本研究。');
        const source = g.sources.find(s => s.sourceId === dataset.sourceId)!;
        assertGeneralSourceAccess(g, source.sourceId);
        this.materials.readParsed(source);
        const idea = input.ideaId ? g.ideas.find(i => i.ideaId === input.ideaId) : null;
        if (input.ideaId && !idea) throw new BootstrapError('SOURCE_MISSING', 'Idea 不属于本研究。');
        const metricContext = input.metricContext === undefined ? undefined : validateMetricContext(input.metricContext);
        if (metricContext) {
          const protocol = g.metricProtocols.find(p => p.protocolId === metricContext.protocolId && p.version === metricContext.version);
          if (!protocol || protocol.status !== 'frozen' || protocol.contextHash !== generalContextHash(g)) throw new BootstrapError('SOURCE_STALE', '指标协议尚未冻结或研究目标已变更，请确认新版本。');
          if (protocol.metrics.some(m => m.required && m.binding && !dataset.fields.some(f => f.label === m.binding!.fieldLabel && f.type === 'number' && input.numericColumns.includes(f.column)))) throw new BootstrapError('INVALID_INPUT', '必需指标绑定字段必须属于该数据字典并作为数值输出选入分析方案；未接入的可选指标保留未测。');
        }
        const plan = validateAnalysisPlan({ ...(metricContext ? { metricContext } : {}), planId: previous?.planId ?? context.mint('analysis-plan'), version: previous ? previous.version + 1 : 1, nodeId: node.nodeId, nodeSnapshotHash: nodeHash(node), nodeContext: structuredClone(node), contextHash: generalContextHash(g), dependencySnapshotHash: dependencySnapshotHash(g, node.nodeId), title: input.title, goal: input.goal,
          dataset: { datasetId: dataset.datasetId, version: dataset.version, sourceId: source.sourceId, sourceSha256: source.sha256, tableId: dataset.tableId, dictionarySha256: dictionaryHash(dataset) },
          idea: idea ? { ideaId: idea.ideaId, revision: idea.revision } : null, method: input.method, numericColumns: input.numericColumns, groupBy: input.groupBy, sampleColumns: input.sampleColumns, rowRange: input.rowRange,
          missingPolicy: input.missingPolicy, missingGroupPolicy: input.missingGroupPolicy, requiredConditions: input.requiredConditions, comparisonScope: input.comparisonScope, limitations: input.limitations, createdAt: context.now() });
        g.plans.push(plan); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
        return { changed: true, result: { planId: plan.planId, version: plan.version } };
      },
    });
  }

  calculate(input: Write & { planId: string; planVersion: number; authorize: true }): MutationResult<{ calculationId: string; status: GeneralCalculation['status']; firstError: GeneralCalculation['firstError'] }> {
    if (input.authorize !== true) throw new BootstrapError('POLICY_DENIED', '需要明确授权本方案、本数据版本和白名单能力；查看不启动计算。');
    return this.store.mutate({ operationId: input.operationId, baseRevision: input.baseRevision, kind: 'calculate_general_descriptive', researchId: input.researchId,
      requestPayload: { researchId: input.researchId, planId: input.planId, planVersion: input.planVersion, authorize: true }, apply: context => {
        const research = requireResearch(context.state, input.researchId), g = research.general;
        if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
        const plan = g.plans.find(p => p.planId === input.planId && p.version === input.planVersion);
        if (!plan) throw new BootstrapError('NOT_FOUND', '本研究没有指定分析方案版本。');
        const attempts = g.calculations.filter(c => c.planId === plan.planId && c.planVersion === plan.version);
        if (attempts.length >= g.limits.maxAttempts) throw new BootstrapError('POLICY_DENIED', `达到本方案 ${g.limits.maxAttempts} 次尝试上限；旧运行保留。`);
        if (g.limits.deadline !== null && Date.parse(context.now()) > Date.parse(g.limits.deadline)) throw new BootstrapError('POLICY_DENIED', '研究授权截止时间已到。');
        const source = g.sources.find(s => s.sourceId === plan.dataset.sourceId)!;
        assertGeneralSourceAccess(g, source.sourceId);
        const selectedNode = g.graph.nodes.find(n => n.nodeId === plan.nodeId);
        if (selectedNode?.task) new GeneralFollowupService(this.store).freeze(input.researchId, selectedNode, selectedNode.task.sourceIds, context.state);
        const startedAt = context.now(), tool = { ...DESCRIPTIVE_TOOL, runtime: process.version };
        let status: GeneralCalculation['status'] = 'completed', artifact: GeneralCalculation['artifact'] = null, firstError: GeneralCalculation['firstError'] = null;
        try {
          const readiness = generalNodeStates(g).find(n => n.nodeId === plan.nodeId);
          if (!readiness || ['blocked', 'skipped'].includes(readiness.status)) throw new CalculationBlocked(readiness?.reason ?? '分析节点已不存在。');
          if (plan.contextHash ? plan.contextHash !== generalContextHash(g) : g.profileRevision > 1) throw new CalculationBlocked('研究约束 / 参照 / 方法语义发生变化，请保存并授权新的分析方案。');
          const dataset = g.datasets.find(d => d.datasetId === plan.dataset.datasetId && d.version === plan.dataset.version)!;
          if (plan.dependencySnapshotHash ? plan.dependencySnapshotHash !== dependencySnapshotHash(g, plan.nodeId) : g.graph.revision > 1) throw new CalculationBlocked('上游方法 / 前置关系变更，请保存并授权新的分析方案。');
          if (dictionaryHash(dataset) !== plan.dataset.dictionarySha256) throw new Error('输入字典 hash 与方案冻结版本不一致。');
          if (g.graph.nodes.every(n => n.nodeId !== plan.nodeId || nodeHash(n) !== plan.nodeSnapshotHash)) throw new CalculationBlocked('节点协议发生变化，请保存新方案而非把旧运行归入新方法。');
          const parsed = this.materials.readParsed(source), table = parsed.tables.find(t => t.tableId === plan.dataset.tableId);
          if (!table) throw new Error('指定原始工作表不存在。');
          const result = calculateDescriptive({ plan, dataset, table, nature: source.nature, parsedHash: source.parsedSha256, parser: source.parser, runtime: process.version, startedAt, finishedAt: context.now });
          if (Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, 'utf8') > ANALYSIS_LIMITS.maxArtifactBytes) throw new CalculationBlocked('实际计算产物超过 16 MiB；请缩小范围，不会截断或登记不完整结果。');
          artifact = this.publications(input.researchId).publishArtifact(result);
        } catch (error) {
          status = error instanceof CalculationBlocked ? 'blocked' : 'failed';
          firstError = { code: error instanceof CalculationBlocked ? error.code : error instanceof BootstrapError ? error.code : 'CALCULATION_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) };
        }
        const calculation = validateCalculation({ calculationId: context.mint('calculation'), planId: plan.planId, planVersion: plan.version, nodeId: plan.nodeId, attempt: attempts.length + 1, status, provenance: 'system_calculation', inputNature: source.nature, input: structuredClone(plan.dataset), idea: plan.idea, tool, artifact, firstError, startedAt, finishedAt: context.now(), checks: status === 'completed' ? 'calculation_completed' : status === 'blocked' ? 'conditions_unsatisfied' : 'calculation_failed' });
        g.calculations.push(calculation); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
        return { changed: true, result: { calculationId: calculation.calculationId, status: calculation.status, firstError: calculation.firstError } };
      },
    });
  }

  /** A trusted host/service snapshot keeps metadata, artifact binding and freshness on one revision. */
  readCalculation(researchId: string, calculationId: string, snapshot?: BootstrapState): { calculation: GeneralCalculation; freshness: ReturnType<typeof calculationFreshness>; content: CalculationArtifact | null } {
    const research = requireResearch(snapshot ?? this.store.readStateOrEmpty(), researchId), g = research.general;
    const calculation = g?.calculations.find(c => c.calculationId === calculationId);
    if (!g || !calculation) throw new BootstrapError('NOT_FOUND', '计算记录不属于本研究。');
    assertGeneralSourceAccess(g, calculation.input.sourceId);
    const plan = g.plans.find(p => p.planId === calculation.planId && p.version === calculation.planVersion);
    for (const id of plan?.nodeContext?.task?.sourceIds ?? []) assertGeneralSourceAccess(g, id);
    const content = this.calculationContent(researchId, calculation, g);
    return { calculation, freshness: calculationFreshness(g, calculation), content };
  }

  review(input: Write & { nodeId: string; calculationIds: string[]; sourceRefs: string[]; inferenceRunIds?: string[]; judgment: GeneralJudgment; reason: string; support: string[]; counterEvidence: string[]; gaps: string[]; applicability: string; nextActions: string[] }, identity: string): MutationResult<{ reviewId: string }> {
    const { operationId, baseRevision, ...payload } = input;
    return this.store.mutate({ operationId, baseRevision, kind: 'review_general_evidence', researchId: input.researchId, requestPayload: payload, apply: context => {
      const research = requireResearch(context.state, input.researchId), g = research.general;
      if (!g) throw new BootstrapError('INVALID_INPUT', '需要通用研究。');
      if (!Array.isArray(input.calculationIds) || !Array.isArray(input.sourceRefs)) throw new BootstrapError('INVALID_INPUT', '审查依据必须为已登记 ID 数组。');
      let hasNumericalEvidence = false;
      for (const id of input.calculationIds) {
        const calculation = g.calculations.find(c => c.calculationId === id);
        if (!calculation) throw new BootstrapError('SOURCE_MISSING', '审查引用未知运行。');
        assertGeneralSourceAccess(g, calculation.input.sourceId);
        const content = this.calculationContent(input.researchId, calculation, g);
        if (content?.summaries.some(summary => summary.statistics.count > 0)) hasNumericalEvidence = true;
      }
      for (const id of input.sourceRefs) {
        const source = g.sources.find(s => s.sourceId === id);
        if (!source) throw new BootstrapError('SOURCE_MISSING', '审查引用未知资料。');
        assertGeneralSourceAccess(g, source.sourceId);
        this.materials.readRaw(source);
      }
      const inferenceRunIds = [...new Set(input.inferenceRunIds ?? [])];
      for (const id of inferenceRunIds) {
        const run = g.inferenceRuns.find(r => r.runId === id);
        if (!run) throw new BootstrapError('SOURCE_MISSING', '审查引用未知推断运行。');
        const plan = g.inferencePlans.find(p => p.planId === run.planId && p.version === run.planVersion);
        if (!plan) throw new BootstrapError('SOURCE_MISSING', '审查引用的推断方案缺失。');
        assertGeneralSourceAccess(g, plan.dataset.sourceId);
        for (const ref of plan.sourceRefs) assertGeneralSourceAccess(g, ref);
        if (run.status === 'completed' && run.artifact !== null) hasNumericalEvidence = true;
      }
      if (['supported', 'partial', 'not_supported'].includes(input.judgment) && !input.sourceRefs.length && !hasNumericalEvidence) throw new BootstrapError('INVALID_INPUT', '科学判断需要 registered evidence；空计算产物或任务完成不构成支持 / 反例。');
      const reviewNode = g.graph.nodes.find(n => n.nodeId === input.nodeId);
      if (!reviewNode) throw new BootstrapError('NOT_FOUND', '审查节点不属于本研究。');
      const review: GeneralReview = validateGeneralReview({ reviewId: context.mint('review'), nodeId: input.nodeId, nodeSnapshotHash: nodeHash(reviewNode), contextHash: generalContextHash(g), dependencySnapshotHash: dependencySnapshotHash(g, reviewNode.nodeId), calculationIds: input.calculationIds, sourceRefs: input.sourceRefs, inferenceRunIds, judgment: input.judgment, reason: input.reason, support: input.support, counterEvidence: input.counterEvidence, gaps: input.gaps, applicability: input.applicability, nextActions: input.nextActions, reviewer: { kind: 'human', identity, actionId: operationId }, createdAt: context.now() });
      g.reviews.push(review); g.revision++; research.general = validateGeneralResearch(g); research.updatedAt = context.now();
      return { changed: true, result: { reviewId: review.reviewId } };
    } });
  }

  projection(researchId: string) {
    const research = requireResearch(this.store.readStateOrEmpty(), researchId), g = research.general;
    if (!g) return null;
    return analysisProjection(g);
  }
}

