import { validateGeneralGraph, type GeneralNode } from '../contracts/general-workflow.ts';
import type { GeneralCycleBaseGraph } from './general-cycle-context.ts';
export type CycleBaseGraph = ResearchGraph | GeneralCycleBaseGraph;
/**
 * Research Cycle graph adapter (architecture §6): base graph stays Phase1,
 * increments live in the cycle store, the effective DAG is composed from both.
 *
 * What is validated here and nowhere else:
 * - Patch nodes are unique and never collide with the base graph or with
 *   already-applied increments.
 * - Patch edges reference existing nodes (base or increment), are no self
 *   loops, and keep the whole effective graph acyclic — including edges back
 *   into old nodes, which is how "new work points at existing outputs" is
 *   enforced without ever closing a cycle.
 * - Branch decisions target existing nodes; they are markers, never deletions.
 * - Artifact refs on patch nodes must be REGISTERED cycle artifacts (the four
 *   deliverable kinds) — a node cannot claim content that was never published
 *   and registered under a producer identity.
 *
 * The composed projection is read-only: no function here writes anything.
 */

import {
  CycleError,
  validateGraphPatchShape,
  type CycleArtifactRecord,
  type CycleBranchDecisionRecord,
  type CycleGraphEdge,
  type CycleGraphNode,
  type CycleGraphPatch,
  type CycleState,
} from '../contracts/research-cycle.ts';
import {
  bootstrapContentHash,
  validateResearchGraph,
  type GraphEdge,
  type GraphNode,
  type ResearchGraph,
} from '../contracts/research-bootstrap.ts';

/** Content identity of a base graph snapshot; used to detect base-graph drift. */
export function baseGraphContentHash(graph: CycleBaseGraph): string {
  return bootstrapContentHash('research-cycle-base-graph-v1', graph);
}

export interface EffectiveCycleGraph {
  /** Where this effective graph came from (provenance for the projection). */
  baseGraphHash: string;
  nodes: Array<GraphNode | GeneralNode | (CycleGraphNode & { origin: 'cycle' })>;
  edges: Array<GraphEdge | (CycleGraphEdge & { origin: 'cycle' })>;
  branchDecisions: CycleBranchDecisionRecord[];
}

/**
 * Composes the effective DAG: the Phase1 planning graph plus every accepted
 * cycle increment. Base nodes keep their planning status; cycle nodes carry
 * their run/round provenance. Nothing is copied into the bootstrap state.
 */
export function composeEffectiveGraph(baseGraph: CycleBaseGraph, state: CycleState): EffectiveCycleGraph {
  return {
    baseGraphHash: baseGraphContentHash(baseGraph),
    nodes: [...baseGraph.nodes, ...state.graphNodes.map((node) => ({ ...node, origin: 'cycle' as const }))],
    edges: [...baseGraph.edges, ...state.graphEdges.map((edge) => ({ ...edge, origin: 'cycle' as const }))],
    branchDecisions: [...state.branchDecisions],
  };
}

export interface GraphPatchValidationContext {
  /** The Phase1 planning graph snapshot this run started from. */
  baseGraph: CycleBaseGraph;
  /** Current cycle state (applied increments so far). */
  state: CycleState;
  /** Registered deliverable artifacts; patch nodes may only cite these. */
  artifacts: CycleArtifactRecord[];
}

export interface ValidatedGraphPatch {
  patch: CycleGraphPatch;
  /** Resolved provenance per patch node: 'base' or an existing cycle node. */
  sourceOrigins: Array<{ nodeId: string; source: 'base' | 'cycle' | null }>;
}

/**
 * Full semantic validation of a decision's proposed graph patch. Throws
 * INVALID_GRAPH / SOURCE_MISSING / POLICY_DENIED with the precise reason;
 * returns the normalized patch on success. Pure — no writes.
 */
export function validateCycleGraphPatch(context: GraphPatchValidationContext, rawPatch: unknown): ValidatedGraphPatch {
  const { baseGraph, state } = context;
  // Re-validate the stored snapshot: a corrupted base graph never enters the DAG.
  if ('mode' in baseGraph && baseGraph.mode === 'general') { const graph = validateGeneralGraph(baseGraph.graph); if (JSON.stringify(graph.nodes) !== JSON.stringify(baseGraph.nodes) || JSON.stringify(graph.edges.filter(e => ['depends_on', 'condition'].includes(e.kind)).map(e => ({ edgeId: e.edgeId, from: e.from, to: e.to, relation: 'depends_on' }))) !== JSON.stringify(baseGraph.edges)) throw new CycleError('INVALID_GRAPH', 'Generic base graph projection mismatch'); } else validateResearchGraph(baseGraph, 'baseGraph');

  if (rawPatch === null || rawPatch === undefined) {
    throw new CycleError('INVALID_GRAPH', 'decision carries no graphPatch');
  }
  const patch = validateGraphPatchShape(rawPatch, 'decision.graphPatch');
  const patchNodes = new Map<string, { kind: string; sourceNodeId: string | null; artifactRef: { id: string; sha256: string } | null }>();
  for (const node of patch.addNodes) {
    if (patchNodes.has(node.nodeId)) throw new CycleError('INVALID_GRAPH', `patch adds duplicate node id ${node.nodeId}`);
    if (baseGraph.nodes.some((base) => base.nodeId === node.nodeId) || state.graphNodes.some((existing) => existing.nodeId === node.nodeId)) {
      throw new CycleError('INVALID_GRAPH', `patch node id ${node.nodeId} collides with an existing node`);
    }
    if (node.sourceNodeId !== null && !baseGraph.nodes.some((base) => base.nodeId === node.sourceNodeId) &&
        !state.graphNodes.some((existing) => existing.nodeId === node.sourceNodeId) &&
        !patch.addNodes.some((added) => added.nodeId === node.sourceNodeId)) {
      throw new CycleError('INVALID_GRAPH', `patch node ${node.nodeId} cites missing source node ${node.sourceNodeId}`);
    }
    if (node.artifactRef !== null) {
      const registered = context.artifacts.find((artifact) => artifact.ref.sha256 === node.artifactRef!.sha256);
      if (registered === undefined) {
        throw new CycleError('POLICY_DENIED', `patch node ${node.nodeId} cites an unregistered artifact (${node.artifactRef.sha256.slice(0, 12)}…)`);
      }
    }
    patchNodes.set(node.nodeId, node);
  }

  const baseNodeIds = new Set(baseGraph.nodes.map((node) => node.nodeId));
  const cycleNodeIds = new Set(state.graphNodes.map((node) => node.nodeId));
  const patchEdgeIds = new Set<string>();
  for (const edge of patch.addEdges) {
    if (patchEdgeIds.has(edge.edgeId)) throw new CycleError('INVALID_GRAPH', `patch adds duplicate edge id ${edge.edgeId}`);
    patchEdgeIds.add(edge.edgeId);
    if (baseGraph.edges.some((base) => base.edgeId === edge.edgeId) || state.graphEdges.some((existing) => existing.edgeId === edge.edgeId)) {
      throw new CycleError('INVALID_GRAPH', `patch edge id ${edge.edgeId} collides with an existing edge`);
    }
    const fromKnown = baseNodeIds.has(edge.from) || cycleNodeIds.has(edge.from) || patchNodes.has(edge.from);
    const toKnown = baseNodeIds.has(edge.to) || cycleNodeIds.has(edge.to) || patchNodes.has(edge.to);
    if (!fromKnown) throw new CycleError('INVALID_GRAPH', `patch edge ${edge.edgeId} starts at missing node ${edge.from}`);
    if (!toKnown) throw new CycleError('INVALID_GRAPH', `patch edge ${edge.edgeId} ends at missing node ${edge.to}`);
    if (edge.from === edge.to) throw new CycleError('INVALID_GRAPH', `patch edge ${edge.edgeId} is a self loop`);
  }

  for (const branch of patch.branchDecisions) {
    if (!baseNodeIds.has(branch.targetNodeId) && !cycleNodeIds.has(branch.targetNodeId) && !patchNodes.has(branch.targetNodeId)) {
      throw new CycleError('INVALID_GRAPH', `branch decision targets missing node ${branch.targetNodeId}`);
    }
  }

  // Acyclicity over the UNION of base + applied + patch edges. A cycle here is
  // the one thing that must never enter the persisted DAG.
  const adjacency = new Map<string, string[]>();
  const push = (from: string, to: string): void => {
    const list = adjacency.get(from) ?? [];
    list.push(to);
    adjacency.set(from, list);
  };
  for (const node of baseGraph.nodes) adjacency.set(node.nodeId, []);
  for (const node of state.graphNodes) if (!adjacency.has(node.nodeId)) adjacency.set(node.nodeId, []);
  for (const nodeId of patchNodes.keys()) adjacency.set(nodeId, []);
  for (const edge of baseGraph.edges) push(edge.from, edge.to);
  for (const edge of state.graphEdges) push(edge.from, edge.to);
  for (const edge of patch.addEdges) push(edge.from, edge.to);
  assertAcyclic(adjacency);

  return {
    patch,
    sourceOrigins: patch.addNodes.map((node) => ({
      nodeId: node.nodeId,
      source: node.sourceNodeId === null ? null
        : baseNodeIds.has(node.sourceNodeId) ? 'base' as const : 'cycle' as const,
    })),
  };
}

function assertAcyclic(adjacency: Map<string, string[]>): void {
  const state = new Map<string, 1 | 2>();
  const visit = (nodeId: string, trail: string[]): void => {
    const mark = state.get(nodeId);
    if (mark === 2) return;
    if (mark === 1) throw new CycleError('INVALID_GRAPH', `graph patch closes a cycle through ${[...trail, nodeId].join(' -> ')}`);
    state.set(nodeId, 1);
    for (const next of adjacency.get(nodeId) ?? []) visit(next, [...trail, nodeId]);
    state.set(nodeId, 2);
  };
  for (const nodeId of adjacency.keys()) visit(nodeId, []);
}
