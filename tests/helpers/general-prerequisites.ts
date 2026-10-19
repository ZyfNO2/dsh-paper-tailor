import * as assert from 'node:assert/strict';
import { GeneralWorkflowService, generalNodeStates } from '../../packages/evolver/src/application/general-workflow-service.ts';
import type { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';

/** Positive fixtures explicitly confirm real prerequisites through the same services as the UI. */
export function confirmGeneralPrerequisites(store: ResearchBootstrapStore, researchId: string): void {
  const workflow = new GeneralWorkflowService(store);
  for (let pass = 0; pass < 3; pass++) {
    const state = store.readStateOrEmpty(), g = state.researches.find(r => r.researchId === researchId)!.general!;
    const node = g.graph.nodes.find(n => ['goal', 'materials', 'protocol'].includes(n.kind) && generalNodeStates(g).find(s => s.nodeId === n.nodeId)!.status === 'ready');
    if (!node) return;
    workflow.confirmNode({ researchId, operationId: `fixture-confirm-${node.nodeId}-${state.revision}`, baseRevision: state.revision, nodeId: node.nodeId, sourceRefs: node.kind === 'goal' ? [] : g.sources.filter(s => !g.sources.some(newer => newer.previousSourceId === s.sourceId)).map(s => s.sourceId), reason: '测试 fixture 显式确认当前前置，不授予科研成功' }, 'test:prerequisite-review');
  }
  const g = store.readStateOrEmpty().researches.find(r => r.researchId === researchId)!.general!;
  assert.ok(generalNodeStates(g).filter(s => g.graph.nodes.some(n => n.nodeId === s.nodeId && ['goal', 'materials', 'protocol'].includes(n.kind))).every(s => ['manual_confirmed', 'policy_ready'].includes(s.status)), 'Positive fixture prerequisites must actually be ready');
}
