import type { GeneralResearch } from '../contracts/general-research.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';
/** Only the selected node and its execution prerequisites; layout/unrelated additions do not invalidate it. */
export function dependencySnapshotHash(g: GeneralResearch, nodeId: string): string {
  const ids = new Set<string>();
  function visit(id: string): void { if (ids.has(id)) return; ids.add(id); for (const edge of g.graph.edges) if (edge.from === id && ['depends_on', 'condition'].includes(edge.kind)) visit(edge.to); }
  visit(nodeId);
  return cycleContentHash('general-dependency-context-v1', { ideaInputs: g.graph.nodes.some(n => ids.has(n.nodeId) && ['goal', 'protocol'].includes(n.kind)) ? g.ideas.map(i => ({ ideaId: i.ideaId, revision: i.revision })) : [], nodes: g.graph.nodes.filter(n => ids.has(n.nodeId)).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0), edges: g.graph.edges.filter(e => ids.has(e.from) && ids.has(e.to) && ['depends_on', 'condition'].includes(e.kind)).sort((a, b) => a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0) });
}
export function currentConditionGuards(g: GeneralResearch, nodeId: string): { nodeId: string; reviewId: string }[] {
  const ids = new Set<string>();
  function visit(id: string): void { if (ids.has(id)) return; ids.add(id); for (const edge of g.graph.edges) if (edge.from === id && ['depends_on', 'condition'].includes(edge.kind)) visit(edge.to); }
  visit(nodeId);
  const guards = new Set(g.graph.edges.filter(e => ids.has(e.from) && e.kind === 'condition').map(e => e.to));
  return [...guards].map(id => ({ nodeId: id, reviewId: [...g.reviews].reverse().find(r => r.nodeId === id)?.reviewId ?? '' })).sort((a, b) => a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0);
}
