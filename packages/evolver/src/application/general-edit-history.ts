import { BootstrapError } from '../contracts/research-bootstrap.ts';
import type { GeneralResearch } from '../contracts/general-research.ts';
import { validateGeneralEditHistory, type GeneralGraph, type GeneralEditTransaction } from '../contracts/general-workflow.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';

export const sameEditValue = (a: unknown, b: unknown) => cycleContentHash('general-edit-value-v1', a) === cycleContentHash('general-edit-value-v1', b);
/** Sparse editing deltas preserve unrelated later facts, graph changes and layout. */
export function recordGeneralEdit(g: GeneralResearch, before: GeneralGraph, layout: GeneralResearch['layout'], operationId: string, createdAt: string): void {
  const diff = <T>(previous: T[], current: T[], key: (item: T) => string) => [...new Set([...previous, ...current].map(key))].flatMap(id => { const a = previous.find(n => key(n) === id) ?? null, b = current.find(n => key(n) === id) ?? null; return sameEditValue(a, b) ? [] : [{ before: a, after: b }]; });
  const nodes = diff(before.nodes, g.graph.nodes, n => n.nodeId), edges = diff(before.edges, g.graph.edges, e => e.edgeId);
  const positions = [...new Set([...Object.keys(layout), ...Object.keys(g.layout)])].flatMap(nodeId => { const before = Object.hasOwn(layout, nodeId) ? layout[nodeId] : null, after = Object.hasOwn(g.layout, nodeId) ? g.layout[nodeId] : null; return sameEditValue(before, after) ? [] : [{ nodeId, before, after }]; });
  if (!nodes.length && !edges.length && !positions.length) return;
  g.editHistory = validateGeneralEditHistory({ past: [...g.editHistory.past, structuredClone({ operationId, createdAt, nodes, edges, positions })], future: [] });
}
export function applyGeneralEdit(g: GeneralResearch, edit: GeneralEditTransaction, direction: 'undo' | 'redo', assertRemove: (id: string) => void): void {
  const expected = direction === 'undo' ? 'after' : 'before', target = direction === 'undo' ? 'before' : 'after';
  for (const d of edit.nodes) { const id = (d.before ?? d.after)!.nodeId; if (!sameEditValue(g.graph.nodes.find(n => n.nodeId === id) ?? null, d[expected])) throw new BootstrapError('REVISION_CONFLICT', 'Edited node changed outside this transaction; undo cannot overwrite it'); if (d[target] === null) assertRemove(id); }
  for (const d of edit.edges) { const id = (d.before ?? d.after)!.edgeId; if (!sameEditValue(g.graph.edges.find(e => e.edgeId === id) ?? null, d[expected])) throw new BootstrapError('REVISION_CONFLICT', 'Edited edge changed outside this transaction'); }
  for (const d of edit.positions) if (!sameEditValue(Object.hasOwn(g.layout, d.nodeId) ? g.layout[d.nodeId] : null, d[expected])) throw new BootstrapError('REVISION_CONFLICT', 'Edited position changed outside this transaction');
  if (edit.nodes.length || edit.edges.length) g.graphHistory.push(structuredClone(g.graph));
  for (const d of edit.nodes) { const id = (d.before ?? d.after)!.nodeId; const index = g.graph.nodes.findIndex(n => n.nodeId === id); if (d[target]) { if (index < 0) g.graph.nodes.push(structuredClone(d[target]!)); else g.graph.nodes[index] = structuredClone(d[target]!); } else g.graph.nodes = g.graph.nodes.filter(n => n.nodeId !== id); }
  for (const d of edit.edges) { const id = (d.before ?? d.after)!.edgeId; const index = g.graph.edges.findIndex(e => e.edgeId === id); if (d[target]) { if (index < 0) g.graph.edges.push(structuredClone(d[target]!)); else g.graph.edges[index] = structuredClone(d[target]!); } else g.graph.edges = g.graph.edges.filter(e => e.edgeId !== id); }
  for (const d of edit.positions) { if (d[target] === null) delete g.layout[d.nodeId]; else Object.defineProperty(g.layout, d.nodeId, { value: structuredClone(d[target]), enumerable: true, configurable: true, writable: true }); }
  if (edit.nodes.length || edit.edges.length) g.graph.revision++;
}
