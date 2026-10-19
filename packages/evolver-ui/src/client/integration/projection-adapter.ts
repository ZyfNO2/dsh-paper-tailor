import type { GraphNode, ModuleCard, PaperCardV3, WorkbenchSnapshotV3 } from '../../wire.ts';
import { graphDefects } from '../format.ts';
import type { ComponentView, ExperimentView, ObjectLink, PaperView, ResearchNodeView, TreeData, TailorData, PapersData, WorkbenchSnapshot, Region, RegionStatus } from '../redesign/view-model.ts';

export const WRITE_UNAVAILABLE = '当前 Host 只开放读取；写入需通过实际 Agent 授权的领域命令，尚未安装网页命令桥。';
export const unavailableActions = {
  create_trial: WRITE_UNAVAILABLE,
  attach_citation: WRITE_UNAVAILABLE,
  request_implementation: WRITE_UNAVAILABLE,
  request_branch_action: WRITE_UNAVAILABLE,
  save_note: '尚未安装持久备注服务。',
  add_component: '组件注册需通过实际 Agent 的授权工具。',
  paper_similarity: '尚未安装论文相似度服务。',
};

export function region<T>(status: RegionStatus, data: T | null, reason: string | null = null): Region<T> {
  return { state: { status, reason }, data };
}
export function blankSnapshot(taskKey: string, status: RegionStatus, reason: string): WorkbenchSnapshot {
  return {
    task: { taskKey, displayName: taskKey || '科研工作台', researchGoal: '', phase: '未知', preconditions: [], revision: 'unknown' },
    preconditions: [], tree: region<TreeData>(status, null, reason), tailor: region<TailorData>(status, null, reason), papers: region<PapersData>(status, null, reason),
  };
}

function link(kind: ObjectLink['kind'], key: string, label: string, ref?: string | null): ObjectLink {
  return { kind, key, label, ref };
}
function nodeStatus(node: GraphNode): ResearchNodeView['status'] {
  switch (node.executionStatus) {
    case 'running': return 'in_progress';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'not_started': return 'planned';
    case 'succeeded': return 'done';
    case 'unknown': return 'unknown';
  }
}
function safeSourceUrl(uri: string | null): string | null {
  if (uri === null) return null;
  try { const url = new URL(uri); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

/** Position all actual edges, including execution/data-flow; reject invalid graphs. */
function positions(snapshot: WorkbenchSnapshotV3): Map<string, { x: number; y: number }> {
  const { nodes, edges } = snapshot.graph;
  const defects = graphDefects(nodes, edges);
  if (defects.length) throw new Error(`图结构无效：${defects.join('；')}`);
  const depths = new Map<string, number>();
  const visiting = new Set<string>();
  if (new Set(nodes.map((n) => n.id)).size !== nodes.length) throw new Error('图包含重复节点标识。');
  const depth = (id: string): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (visiting.has(id)) throw new Error(`图包含循环关系：${id}`);
    visiting.add(id);
    const parents = edges.filter((e) => e.target === id);
    const result = parents.length ? Math.max(...parents.map((e) => depth(e.source))) + 1 : 0;
    visiting.delete(id); depths.set(id, result); return result;
  };
  const rows = new Map<number, number>(), placed = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const d = depth(node.id), row = rows.get(d) ?? 0;
    placed.set(node.id, { x: 30 + d * 220, y: 50 + row * 130 }); rows.set(d, row + 1);
  }
  return placed;
}

export function mapExperiments(snapshot: WorkbenchSnapshotV3): ExperimentView[] {
  return snapshot.graph.nodes.filter((n) => n.kind === 'run').map((n) => ({
    experimentKey: n.id, attempt: null, label: n.displayName,
    status: n.executionStatus === 'succeeded' ? 'completed' : n.executionStatus === 'not_started' ? 'planned' : n.executionStatus,
    verificationStatus: n.measurementStatus === 'measured_verified' ? 'verified' : n.measurementStatus === 'partial' ? 'inconclusive' : 'unverified',
    combination: n.moduleRefs.length > 1,
    componentRefs: n.moduleRefs.map((id) => link('component', id, id)), schemeKey: null, positionKey: n.detail.slotId,
    config: [
      { name: 'variant', value: n.detail.variantId ?? '未知', constraint: null },
      { name: 'paired seeds', value: n.detail.seeds.join(', ') || '未知', constraint: null },
      { name: 'protocol', value: n.detail.protocolRef ?? snapshot.protocolRef ?? '未知', constraint: null },
    ],
    metricRows: n.detail.metricRows.map((m) => ({ name: `${m.metricId} / seed ${m.seed}`, value: m.value === null ? null : String(m.value), unit: m.unit, comparable: false, note: '逐 seed 观察；比较口径见 Host comparison' })),
    diagnostics: n.detail.firstError, evidenceLinks: [], paperCitations: [], updatedAt: null,
  }));
}

export function mapTree(snapshot: WorkbenchSnapshotV3): TreeData {
  const placed = positions(snapshot);
  const runs = snapshot.graph.nodes.filter((n) => n.kind === 'run');
  const verified = runs.filter((n) => n.measurementStatus === 'measured_verified' && n.executionStatus === 'succeeded');
  const nodes: ResearchNodeView[] = snapshot.graph.nodes.map((n) => ({
    id: n.id, kind: n.kind === 'baseline' ? 'baseline' : n.kind === 'combination' ? 'scheme' : n.kind === 'run' ? 'experiment' : 'result',
    title: n.displayName, status: nodeStatus(n), summary: n.summary, branch: 'main',
    childCount: snapshot.graph.edges.filter((e) => e.source === n.id).length,
    ...placed.get(n.id)!, rationale: null,
    outcome: n.comparisons.length ? n.comparisons.map((c) => `${c.metricId}：${c.measuredValue ?? '未知'} ${c.unit}；${c.complete ? 'paired comparison 完整' : c.limitation ?? '比较不完整'}`).join('\n') : null,
    links: n.moduleRefs.map((id) => link('component', id, id)), actor: null,
    failureNote: n.detail.firstError,
    extraSections: [{ heading: '核验状态', body: n.measurementStatus }, { heading: '实际来源引用', body: [...n.resultRefs, ...n.verificationRefs, ...n.operationRefs].join('\n') || '暂无' }],
  }));
  const explanation = snapshot.candidateDesigns.flatMap((d) => d.rationale === null ? [] : [d.rationale.taskProblem, d.rationale.mechanismHypothesis, ...d.rationale.expectedEffects]);
  const narrative = explanation.map((c) => `${c.textZh ?? c.reasonZh ?? '未知'}（${c.status}）`).join('；');
  return {
    summary: {
      narrative: narrative || `当前任务发布了 ${snapshot.graph.nodes.length} 个图节点、${runs.length} 个运行节点。尚无独立发布的研究结论。`,
      statementStatus: '来源为 Host 已发布投影；不推断科研结论', evidenceLinks: [],
      statistics: [
        { key: 'totalExperiments', label: '运行节点', value: String(runs.length) },
        { key: 'validResults', label: '已核验运行节点', value: String(verified.length), tone: 'green' },
        { key: 'bestScheme', label: '最佳方案', value: null, tone: 'purple' },
        { key: 'mainChange', label: '主要提升', value: null, tone: 'purple' },
      ],
      metricComparison: snapshot.graph.nodes.filter((n) => n.comparisons.length).map((n) => ({ schemeName: n.displayName, cells: n.comparisons.map((c) => ({
        name: c.metricId, value: c.measuredValue === null ? null : String(c.measuredValue), unit: c.unit,
        comparable: c.complete, note: c.limitation,
      })) })),
      metricComparisonNote: '比较条件与完整性由 Host 提供；未发布最佳路径判定，不生成增益结论。', nextActions: [],
    }, nodes,
    edges: snapshot.graph.edges.map((e) => ({ id: e.id, sourceId: e.source, targetId: e.target, relation: e.label || e.relation, planned: e.relation === 'proposed_extension', reason: e.evidenceRefs.join(', ') || null })),
    activity: snapshot.graph.operations.map((o) => ({ id: o.operationId, time: o.updatedAt, action: o.method, actor: 'Host operation', target: null, result: o.status, rejected: o.error !== null, rejectReason: o.error, detail: `attempt: ${o.attempt}` })),
    defaultHiddenNodeIds: [],
  };
}

export function mapComponents(cards: ModuleCard[], snapshot: WorkbenchSnapshotV3 | null): ComponentView[] {
  return cards.map((c) => {
    const associations = c.conditionalResultRefs.filter((r) => r.taskId === snapshot?.taskId);
    const runs = snapshot?.graph.nodes.filter((n) => n.kind === 'run' && (n.moduleRefs.includes(c.id) || associations.some((r) => r.nodeId === n.id))) ?? [];
    return {
      componentKey: c.id, revision: c.documentHash ?? 'unknown', kind: 'Module', name: c.displayName,
      description: c.mechanism ?? '来源未记载机制描述。', tags: [c.origin], positionKeys: c.slotId === null ? [] : [c.slotId],
      capabilities: [], missing: c.missing, integrable: null, integrableReason: '来源实现就绪信息不等于当前任务的执行能力验证。',
      validatedInTask: false, validatedElsewhere: null,
      trial: { count: runs.length, succeededInTask: runs.length ? runs.some((n) => n.executionStatus === 'succeeded') : null, lastAttemptAt: null },
      rankScore: null, lastUsedAt: null,
      source: { author: '未知', origin: c.origin, version: c.documentHash, license: null, url: null },
      problem: c.modifies ?? '来源未记载所解决的问题。', recommendedPositions: c.slotId === null ? [] : [c.slotId],
      experimentLinks: runs.map((n) => link('experiment', n.id, n.displayName)),
      paperLinks: c.paperId === null ? [] : [link('paper', c.paperId, c.paperTitle ?? c.paperId)],
      canCreateTrial: false, createTrialReason: WRITE_UNAVAILABLE,
    };
  });
}

export function mapPapers(cards: PaperCardV3[], components: ComponentView[]): PaperView[] {
  return cards.map((p) => ({
    paperKey: p.paperId, sourceRevision: p.documentHash ?? 'unknown',
    metadata: { title: p.title ?? `题录缺失：${p.paperId}`, authors: [], year: null, venue: p.legacy.sourceGroup ?? '未知', paperType: '未知', doi: null, url: safeSourceUrl(p.legacy.sourceUri), localSource: null },
    relevance: null, flags: p.methodTags.length ? ['extracted'] : ['missing_evidence'],
    contributions: p.methodTags.map((tag) => ({
      id: tag.methodKey, category: 'method', title: tag.nameZh ?? tag.canonicalName,
      text: `原文抽取方法：${tag.nameZh ?? tag.canonicalName}；关联类型：${tag.relation}。来源报告不代表本任务验证。`,
      tags: [{ label: '论文报告 / 方法抽取', tone: 'blue' }],
      evidences: tag.sources.map((s, i) => ({ id: `${tag.methodKey}:${i}`, source: 'paper', label: s.locator.kind,
        locator: `${s.locator.id}${s.locator.fieldPath === null ? '' : ` / ${s.locator.fieldPath}`}`, condition: null, value: null, unit: null })),
      componentLinks: components.filter((c) => c.paperLinks.some((l) => l.key === p.paperId) && c.componentKey === tag.cardRef?.id).map((c) => link('component', c.componentKey, c.name)),
      parameters: null, datasetInfo: null, slotMapping: [],
    })), wikiLinks: [], citations: [], similar: [], note: null,
  }));
}
