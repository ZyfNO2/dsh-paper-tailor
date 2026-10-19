import { knowledgeTextLinks, resolveKnowledgeTarget, type KnowledgeNetwork, type KnowledgeNode, type KnowledgeEdge } from './knowledge-network.ts';
import type { BootstrapReadPayload, BootstrapWireRef } from '../integration/research-bootstrap-view.ts';
import type { GeneralResearch } from '../../../../evolver/src/contracts/general-research.ts';
import type { GeneralKnowledgeEntry } from '../../../../evolver/src/contracts/general-knowledge.ts';
import type { WorkbenchSnapshot } from '../redesign/view-model.ts';

export interface StudioCard {
  id: string; title: string; body: string; kind: string; status: string;
  tags: string[]; source: string; sourceUrl?: string; nodeIds: string[]; ideaIds: string[];
  x?: number; y?: number; readable: boolean; category?: string; version?: string;
}
export interface StudioEdge { id: string; from: string; to: string; label: string }
export interface StudioNode extends StudioCard { output?: string; criterion?: string; candidate?: boolean }
export function studioSourceAllowed(g: GeneralResearch, id: string): boolean {
  return g.sources.some(s => s.sourceId === id) && g.sourceAccess.filter(a => a.sourceId === id).at(-1)?.allowed !== false;
}
export function studioKnowledgeSourceIds(g: GeneralResearch, e: GeneralKnowledgeEntry): string[] {
  const calculationSource = (id: string) => g.calculations.find(c => c.calculationId === id)?.input.sourceId ?? 'missing-source';
  return [...new Set([...e.sourceRefs, ...(e.images ?? []).map(i => i.sourceId), ...(e.claims ?? []).flatMap(c => c.locators.map(l => l.kind === 'calculation' ? calculationSource(l.calculationId) : l.sourceId)), ...(e.calculationIds ?? []).map(calculationSource)])];
}
export function studioKnowledgeReadable(g: GeneralResearch, e: GeneralKnowledgeEntry): boolean {
  return studioKnowledgeSourceIds(g, e).every(id => studioSourceAllowed(g, id));
}

export function studioData(snapshot: WorkbenchSnapshot, read: BootstrapReadPayload | null) {
  const wire = read?.bootstrap;
  const research = wire?.researches.find(r => r.researchId === wire.activeResearchId);
  const general = research?.general;
  const selectedIds = wire?.selectedIdeaIds ?? [];
  const papers = snapshot.papers.data?.papers ?? [];
  const cards: StudioCard[] = [];
  const edges: StudioEdge[] = [];
  const networkNodes: KnowledgeNode[] = [], networkEdges: KnowledgeEdge[] = [], broken: KnowledgeNetwork['broken'] = [];
  for(const p of papers){const id=`paper-source:${p.paperKey}`;networkNodes.push({id,title:p.metadata.title,type:'source',category:'论文来源',version:p.sourceRevision??'版本未记录',readable:true,url:p.metadata.url??undefined});for(const w of p.wikiLinks)networkEdges.push({id:`source:${w.key}`,from:w.key,to:id,kind:'source',label:'论文 Wiki 来源'});}

  for (const p of papers) for (const [index, wiki] of p.wikiLinks.entries()) {
    // Entry identity, revision and kind all matter; a component or another section
    // in the same paper is not this Wiki entry. Stale uses remain visible as stale.
    const match = (ref: BootstrapWireRef) => ref.paperId === p.paperKey && ref.assetKind === 'wiki' && ref.entryIndex === index;
    const uses = (research?.ideas ?? []).filter(i => i.evidenceRefs.some(match));
    const current = (ref: BootstrapWireRef) => match(ref) && ref.assetRevision === wiki.version && ref.sourceSha256 === p.sourceRevision;
    const activeUses = uses.filter(i => i.evidenceRefs.some(current));
    const linked = (wire?.graph?.nodes ?? []).filter(n => n.evidenceRefs.some(current) || !!n.ideaRef && activeUses.some(i => i.ideaId === n.ideaRef!.ideaId && i.revision === n.ideaRef!.contentRevision && i.contentHash === n.ideaRef!.contentHash));
    const tags = [
      ...(activeUses.length ? ['被候选引用'] : []),
      ...(activeUses.some(i => selectedIds.includes(i.ideaId)) ? ['已选方向引用'] : []),
      ...(linked.length ? ['已关联研究节点'] : []),
      ...(linked.some(n => n.kind === 'hypothesis') ? ['已形成假设'] : []),
      ...(uses.length > activeUses.length ? ['存在旧版引用'] : []),
    ];
    cards.push({ id: wiki.key, title: wiki.title, body: wiki.statement, kind: '知识', status: '抽取草稿', tags,
      category:'论文 Wiki',version:wiki.version,source: p.metadata.title, sourceUrl: p.metadata.url ?? undefined, nodeIds: linked.map(n => n.nodeId), ideaIds: uses.map(i => i.ideaId), readable: true });
  }
  if (general) {
    const latest = general.knowledge.filter(e => !e.archived && !general.knowledge.some(n => n.entryId === e.entryId && n.version > e.version));
    for(const source of general.sources)networkNodes.push({id:`source:${source.sourceId}`,title:source.filename,type:'source',category:'原始资料',version:`v${source.revision}`,readable:studioSourceAllowed(general,source.sourceId),url:studioSourceAllowed(general,source.sourceId)&&research?`/evolver/research-bootstrap/source?${new URLSearchParams({sessionId:snapshot.task.taskKey,researchId:research.researchId,sourceId:source.sourceId})}`:undefined});
    for (const e of latest) {
      const readable = studioKnowledgeReadable(general, e);
      const nodeIds = e.nodeIds.filter(id => general.graph.nodes.some(n => n.nodeId === id));
      cards.push({ id: e.entryId, title: e.title, body: readable ? e.content : '依赖来源已撤权，正文暂不可读。',
        category:e.category,version:`v${e.version}`,kind: e.kind === 'method' ? '方法' : '知识', status: !readable ? '来源已撤权' : ({ hypothesis: '待验证假设', inference: '推断', source_reported: '来源报告', unknown: '待核对' }[e.nature]),
        tags: nodeIds.length ? ['已关联研究节点'] : [], source: readable ? e.sourceRefs.map(id => general.sources.find(s => s.sourceId === id)?.filename ?? '缺失来源').join(' · ') || '未记录来源' : '已撤权来源',
        sourceUrl: readable && e.sourceRefs.length && research ? `/evolver/research-bootstrap/source?${new URLSearchParams({ sessionId: snapshot.task.taskKey, researchId: research.researchId, sourceId: e.sourceRefs[0] })}` : undefined,
        nodeIds, ideaIds: [], readable });
      if(readable)for(const sourceId of studioKnowledgeSourceIds(general,e))if(general.sources.some(s=>s.sourceId===sourceId))networkEdges.push({id:`source:${e.entryId}:${sourceId}`,from:e.entryId,to:`source:${sourceId}`,kind:'source',label:'已登记来源引用'});
    }
    edges.push(...general.knowledgeRelations.filter(e => cards.some(c => c.id === e.fromEntryId) && cards.some(c => c.id === e.toEntryId)).map(e => ({ id: e.relationId, from: e.fromEntryId, to: e.toEntryId, label: e.kind === 'related' ? '条目关联' : '已登记证据关联' })));
  }
  for(const c of cards)networkNodes.push({id:c.id,title:c.title,type:c.kind==='方法'?'method':'knowledge',category:c.category??c.kind,version:c.version??'版本未记录',readable:c.readable});
  for(const e of general?.knowledgeRelations??[])if(cards.some(c=>c.id===e.fromEntryId&&c.readable)&&cards.some(c=>c.id===e.toEntryId&&c.readable)){const locator=e.locator;const sourceId=locator?.kind==='text'?locator.sourceId:locator?.kind==='calculation'?general!.calculations.find(c=>c.calculationId===locator.calculationId)?.input.sourceId:undefined;const readable=!e.locator||!!sourceId&&studioSourceAllowed(general!,sourceId);networkEdges.push({id:e.relationId,from:e.fromEntryId,to:e.toEntryId,kind:e.kind==='evidence_for'?'evidence':'related',available:readable,label:e.kind==='evidence_for'?readable?'已登记证据关系':'已登记证据关系 · 来源不可读':'已登记条目关联'});}
  for(const c of cards.filter(c=>c.readable))for(const target of knowledgeTextLinks(c.body)){const id=resolveKnowledgeTarget(target,cards);if(!id){broken.push({from:c.id,target});continue;}if(id!==c.id&&!networkEdges.some(e=>e.from===c.id&&e.to===id&&e.kind!=='source'))networkEdges.push({id:`link:${c.id}:${id}`,from:c.id,to:id,kind:'wikilink',label:'页面交叉引用'});}
  const network: KnowledgeNetwork={nodes:networkNodes,edges:networkEdges,broken};
  let nodes: StudioNode[] = (snapshot.tree.data?.nodes ?? []).map(n => ({ id: n.id, title: n.title, body: n.summary ?? n.rationale ?? '', kind: n.kind, status: n.status === 'done' ? '已记录产物' : n.status === 'in_progress' ? '运行中' : '规划中', tags: n.planningStatus ? [n.planningStatus] : [], source: '已保存研究图', nodeIds: [], ideaIds: n.ideaRef ? [n.ideaRef] : [], x: n.x, y: n.y, readable: true }));
  let treeEdges: StudioEdge[] = (snapshot.tree.data?.edges ?? []).map(e => ({ id: e.id, from: e.relation.startsWith('依赖') ? e.targetId : e.sourceId, to: e.relation.startsWith('依赖') ? e.sourceId : e.targetId, label: e.relation }));
  if (general) {
    const states: Record<string, string> = { ready: '可开始', blocked: '前置阻塞', skipped: '未选分支', policy_ready: '流程放行', manual_confirmed: '人工已确认', output_ready: '产物就绪', reviewed: '已有审查' };
    nodes = general.graph.nodes.map((n, i) => ({ id: n.nodeId, title: n.title, body: n.method || n.goal,
      kind: n.kind, status: states[research?.workflow?.find(w => w.nodeId === n.nodeId)?.status ?? ''] ?? '规划中',
      tags: [], source: '已保存研究图', nodeIds: [], ideaIds: [], x: general.layout[n.nodeId]?.x ?? 80 + (i % 3) * 300, y: general.layout[n.nodeId]?.y ?? 80 + Math.floor(i / 3) * 210, output: n.output, criterion: n.completionCriterion, readable: true }));
    treeEdges = general.graph.edges.map(e => ({ id: e.edgeId, from: e.kind === 'depends_on' || e.kind === 'condition' ? e.to : e.from, to: e.kind === 'depends_on' || e.kind === 'condition' ? e.from : e.to, label: e.condition ?? ({ depends_on: '前置依赖', condition: '审查条件', feedback: '修正关系', derived_from: '派生' }[e.kind]) }));
    for (const n of snapshot.cycle?.effectiveGraph.nodes.filter(n => n.origin === 'cycle') ?? []) if (!nodes.some(x => x.id === n.nodeId)) nodes.push({ id: n.nodeId, title: n.title, body: n.summary ?? '', kind: n.kind, status: n.artifactRef ? '已登记产物' : '未来任务', tags: [], source: '研究循环', nodeIds: [], ideaIds: [], readable: true });
    for (const e of snapshot.cycle?.effectiveGraph.edges ?? []) if (!treeEdges.some(x => x.id === e.edgeId)) treeEdges.push({ id: e.edgeId, from: e.relation === 'depends_on' ? e.to : e.from, to: e.relation === 'depends_on' ? e.from : e.to, label: e.relation });
  }
  const candidates: StudioNode[] = (research?.ideas ?? []).map(i => ({ id: i.ideaId, title: i.title, body: i.hypothesis ?? i.rationale ?? '', kind: '候选方向', status: selectedIds.includes(i.ideaId) ? '已选择' : '候选', tags: [i.basis === 'grounded' ? '有登记依据' : '探索性'], source: 'Brainstorm 候选；尚不代表已入研究树', nodeIds: [], ideaIds: [i.ideaId], candidate: true, output: i.validationPlan ?? undefined, readable: true }));
  return { network, research, general, cards, knowledgeEdges: edges, nodes, treeEdges, candidates, papers, selectedIds };
}
