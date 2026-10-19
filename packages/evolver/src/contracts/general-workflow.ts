import { object, str, num, list, one, hash } from './general-data.ts';
import type { GeneralJudgment } from './general-analysis.ts';
import { evidenceArtifactRef, timestamp } from './general-evidence.ts';
export type GeneralFollowupOrigin = { kind: 'human_review'; reviewId: string; actionIndex: number } | { kind: 'cycle_decision'; runId: string; decisionRef: { id: string; sha256: string }; actionId: string };
export interface GeneralFollowupTask {
  kind: 'review_followup'; origin: GeneralFollowupOrigin; suggestion: string;
  sourceIds: string[]; calculationIds: string[]; priorArtifacts: { id: string; sha256: string }[];
  actor: { identity: string; actionId: string }; createdAt: string;
}
export function validateGeneralFollowupOrigin(v: unknown): GeneralFollowupOrigin {
  if (v === null || typeof v !== 'object') throw new Error('Invalid followup origin');
  if ((v as { kind?: unknown }).kind === 'human_review') { const r = object(v, ['kind', 'reviewId', 'actionIndex'], 'followup origin'); return { kind: 'human_review', reviewId: str(r.reviewId, 'reviewId', 200, true), actionIndex: num(r.actionIndex, 'actionIndex', 0, 99) }; }
  const r = object(v, ['kind', 'runId', 'decisionRef', 'actionId'], 'followup origin');
  return { kind: one(r.kind, ['cycle_decision'] as const, 'origin kind'), runId: str(r.runId, 'runId', 200, true), decisionRef: evidenceArtifactRef(r.decisionRef), actionId: str(r.actionId, 'actionId', 200, true) };
}
export function validateGeneralFollowupTask(v: unknown): GeneralFollowupTask {
  const t = object(v, ['kind', 'origin', 'suggestion', 'sourceIds', 'calculationIds', 'priorArtifacts', 'actor', 'createdAt'], 'followup task');
  const ids = (v: unknown) => { const a = list(v, 'task scope', 100).map(x => str(x, 'identity', 200, true)); if (new Set(a).size !== a.length) throw new Error('Duplicate task scope identity'); return a; };
  const a = object(t.actor, ['identity', 'actionId'], 'task actor');
  return { kind: one(t.kind, ['review_followup'] as const, 'task kind'), origin: validateGeneralFollowupOrigin(t.origin), suggestion: str(t.suggestion, 'suggestion', 4000, true), sourceIds: ids(t.sourceIds), calculationIds: ids(t.calculationIds), priorArtifacts: list(t.priorArtifacts, 'prior artifacts', 100).map(evidenceArtifactRef), actor: { identity: str(a.identity, 'actor identity', 200, true), actionId: str(a.actionId, 'actor actionId', 200, true) }, createdAt: timestamp(t.createdAt) };
}
export interface GeneralNodeState {
  nodeId: string;
  status: 'policy_ready' | 'ready' | 'blocked' | 'skipped' | 'manual_confirmed' | 'output_ready' | 'reviewed';
  reason: string; prerequisiteIds: string[]; judgment: GeneralJudgment | null;
  confirmationId: string | null; reviewId: string | null; calculationIds: string[];
}

export const GENERAL_METHOD_NAMES = ['engineering', 'observation', 'algorithm', 'survey', 'review'] as const;
export interface GeneralNode {
  task?: GeneralFollowupTask;
  nodeId: string; title: string;
  kind: 'goal' | 'materials' | 'protocol' | 'analysis' | 'review' | 'report' | 'manual' | 'decision';
  goal: string; inputs: string[]; method: string; output: string; completionCriterion: string;
  join: 'all' | 'selected'; execution: 'not_started';
}
export interface GeneralEdge {
  edgeId: string; from: string; to: string;
  /** Dependent -> prerequisite; feedback is a research relation, never an execution cycle. */
  kind: 'depends_on' | 'condition' | 'feedback' | 'derived_from';
  condition: GeneralJudgment | null;
}
export interface GeneralGraph { revision: number; nodes: GeneralNode[]; edges: GeneralEdge[] }
export interface GeneralEditTransaction {
  operationId: string; createdAt: string;
  nodes: { before: GeneralNode | null; after: GeneralNode | null }[];
  edges: { before: GeneralEdge | null; after: GeneralEdge | null }[];
  positions: { nodeId: string; before: { x: number; y: number } | null; after: { x: number; y: number } | null }[];
}
export interface GeneralEditHistory { past: GeneralEditTransaction[]; future: GeneralEditTransaction[] }
export function validateGeneralEditHistory(v: unknown): GeneralEditHistory {
  const h = object(v, ['past', 'future'], 'edit history');
  const edge = (v: unknown): GeneralEdge | null => { if (v === null) return null; const e = object(v, ['edgeId', 'from', 'to', 'kind', 'condition'], 'edit edge'); return { edgeId: str(e.edgeId, 'edgeId', 200, true), from: str(e.from, 'from', 200, true), to: str(e.to, 'to', 200, true), kind: one(e.kind, ['depends_on', 'condition', 'feedback', 'derived_from'] as const, 'edge kind'), condition: e.condition === null ? null : one(e.condition, ['supported', 'partial', 'not_supported', 'insufficient', 'paused'] as const, 'edge condition') }; };
  const position = (v: unknown) => { if (v === null) return null; const p = object(v, ['x', 'y'], 'edit position'); for (const n of [p.x, p.y]) if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100000) throw new Error('Invalid edit position'); return { x: p.x as number, y: p.y as number }; };
  const parse = (v: unknown): GeneralEditTransaction => {
    const t = object(v, ['operationId', 'createdAt', 'nodes', 'edges', 'positions'], 'edit transaction');
    const nodes = list(t.nodes, 'edited nodes', 200).map(v => { const d = object(v, ['before', 'after'], 'node delta'); const before = d.before === null ? null : validateGeneralNode(d.before), after = d.after === null ? null : validateGeneralNode(d.after); if (!before && !after || before && after && before.nodeId !== after.nodeId) throw new Error('Edit node identity mismatch'); return { before, after }; });
    const edges = list(t.edges, 'edited edges', 500).map(v => { const d = object(v, ['before', 'after'], 'edge delta'), before = edge(d.before), after = edge(d.after); if (!before && !after || before && after && before.edgeId !== after.edgeId) throw new Error('Edit edge identity mismatch'); return { before, after }; });
    const positions = list(t.positions, 'edited positions', 200).map(v => { const p = object(v, ['nodeId', 'before', 'after'], 'position delta'); return { nodeId: str(p.nodeId, 'nodeId', 200, true), before: position(p.before), after: position(p.after) }; });
    for (const d of nodes) if (JSON.stringify(d.before?.task ?? null) !== JSON.stringify(d.after?.task ?? null)) throw new Error('Edit history cannot create or remove followup provenance');
    for (const d of edges) for (const e of [d.before, d.after]) if (e && ((e.kind === 'condition') !== (e.condition !== null))) throw new Error('Invalid edit edge condition');
    for (const ids of [nodes.map(d => (d.before ?? d.after)!.nodeId), edges.map(d => (d.before ?? d.after)!.edgeId), positions.map(d => d.nodeId)]) if (new Set(ids).size !== ids.length) throw new Error('Duplicate edit delta identity');
    if (!nodes.length && !edges.length && !positions.length) throw new Error('Empty edit transaction');
    return { operationId: str(t.operationId, 'edit operationId', 200, true), createdAt: timestamp(t.createdAt), nodes, edges, positions };
  };
  const result = { past: list(h.past, 'undo history', 100).map(parse), future: list(h.future, 'redo history', 100).map(parse) };
  const operations = [...result.past, ...result.future].map(t => t.operationId);
  if (new Set(operations).size !== operations.length) throw new Error('Duplicate edit operation identity');
  if (result.past.length + result.future.length > 100) throw new Error('Edit history exceeds 100 transactions; explicitly clear undo history to continue');
  if (new TextEncoder().encode(JSON.stringify(result)).length > 8 * 1024 * 1024) throw new Error('Edit history exceeds 8 MiB; no silent truncation');
  return result;
}
export interface GeneralProfile {
  requireHumanConfirmation: boolean;
  revision: number; title: string; domains: string[]; methods: (typeof GENERAL_METHOD_NAMES[number])[];
  entryMode: 'idea_only' | 'design_first' | 'existing_data';
  reference: { status: 'unknown' | 'applicable' | 'not_applicable'; description: string; reason: string };
  constraints: string[]; pendingQuestions: string[];
  limits: { maxAttempts: number; maxRounds: number; deadline: string | null };
}
export interface GeneralNodeConfirmation {
  confirmationId: string; nodeId: string; nodeSnapshotHash: string; dependencySnapshotHash: string; profileRevision: number;
  guards: { nodeId: string; reviewId: string }[];
  idea: { ideaId: string; revision: number } | null;
  sourceRefs: string[];
  datasets: { datasetId: string; version: number }[];
  reason: string;
  actor: { identity: string; actionId: string };
  createdAt: string;
}
const strings = (v: unknown, label: string, max = 100): string[] => list(v, label, max).map(value => str(value, label, 4000, true));
export function validateGeneralNode(v: unknown): GeneralNode {
  const n = object(v, ['nodeId', 'title', 'kind', 'goal', 'inputs', 'method', 'output', 'completionCriterion', 'join', 'execution', 'task'], 'node', ['task']);
  return { ...(n.task === undefined ? {} : { task: validateGeneralFollowupTask(n.task) }), nodeId: str(n.nodeId, 'nodeId', 200, true), title: str(n.title, 'title', 300, true), kind: one(n.kind, ['goal', 'materials', 'protocol', 'analysis', 'review', 'report', 'manual', 'decision'] as const, 'node kind'), goal: str(n.goal, 'goal'), inputs: strings(n.inputs, 'inputs'), method: str(n.method, 'method'), output: str(n.output, 'output'), completionCriterion: str(n.completionCriterion, 'completionCriterion'), join: one(n.join, ['all', 'selected'] as const, 'join'), execution: one(n.execution, ['not_started'] as const, 'execution') };
}
export function validateGeneralGraph(v: unknown): GeneralGraph {
  const g = object(v, ['revision', 'nodes', 'edges'], 'general graph');
  const nodes = list(g.nodes, 'nodes', 200).map(validateGeneralNode), ids = new Set(nodes.map(n => n.nodeId));
  if (ids.size !== nodes.length) throw new Error('Duplicate general node identity');
  const edges = list(g.edges, 'edges', 500).map(value => {
    const e = object(value, ['edgeId', 'from', 'to', 'kind', 'condition'], 'edge');
    const result: GeneralEdge = { edgeId: str(e.edgeId, 'edgeId', 200, true), from: str(e.from, 'from', 200, true), to: str(e.to, 'to', 200, true), kind: one(e.kind, ['depends_on', 'condition', 'feedback', 'derived_from'] as const, 'edge kind'), condition: e.condition === null ? null : one(e.condition, ['supported', 'partial', 'not_supported', 'insufficient', 'paused'] as const, 'condition') };
    if (!ids.has(result.from) || !ids.has(result.to) || result.from === result.to) throw new Error('Invalid general edge endpoint');
    if ((result.kind === 'condition') !== (result.condition !== null)) throw new Error('Condition edge must have an explicit judgment; other edges cannot carry one');
    if (result.kind === 'condition' && !nodes.some(n => n.nodeId === result.to && ['review', 'decision'].includes(n.kind))) throw new Error('Condition prerequisite must be a review or decision node');
    return result;
  });
  if (new Set(edges.map(e => e.edgeId)).size !== edges.length || new Set(edges.map(e => `${e.kind}:${e.from}:${e.to}:${e.condition}`)).size !== edges.length) throw new Error('Duplicate general edge identity/relation');
  const adjacency = new Map<string, string[]>();
  for (const e of edges) if (e.kind === 'depends_on' || e.kind === 'condition') adjacency.set(e.from, [...(adjacency.get(e.from) ?? []), e.to]);
  const visiting = new Set<string>(), done = new Set<string>();
  function visit(id: string): void { if (visiting.has(id)) throw new Error('General execution dependencies must be acyclic'); if (done.has(id)) return; visiting.add(id); for (const next of adjacency.get(id) ?? []) visit(next); visiting.delete(id); done.add(id); }
  for (const id of ids) visit(id);
  return { revision: num(g.revision, 'graph revision', 1, 201), nodes, edges };
}
export function validateGeneralProfile(v: unknown): GeneralProfile {
  const p = object(v, ['revision', 'title', 'domains', 'methods', 'entryMode', 'reference', 'constraints', 'pendingQuestions', 'limits', 'requireHumanConfirmation'], 'general profile', ['requireHumanConfirmation']);
  if (p.requireHumanConfirmation !== undefined && typeof p.requireHumanConfirmation !== 'boolean') throw new Error('requireHumanConfirmation must be a boolean');
  const r = object(p.reference, ['status', 'description', 'reason'], 'reference');
  const reference: GeneralProfile['reference'] = { status: one(r.status, ['unknown', 'applicable', 'not_applicable'] as const, 'reference status'), description: str(r.description, 'reference description'), reason: str(r.reason, 'reference reason') };
  if (reference.status === 'not_applicable' && !reference.reason.trim()) throw new Error('Not applicable reference requires a reason');
  const l = object(p.limits, ['maxAttempts', 'maxRounds', 'deadline'], 'limits');
  const deadline = l.deadline === null ? null : str(l.deadline, 'deadline', 100, true);
  if (deadline !== null && !Number.isFinite(Date.parse(deadline))) throw new Error('Invalid deadline');
  const methods = list(p.methods, 'methods', 5).map(v => one(v, GENERAL_METHOD_NAMES, 'method'));
  if (new Set(methods).size !== methods.length) throw new Error('Duplicate method template');
  return { requireHumanConfirmation: p.requireHumanConfirmation !== false, revision: num(p.revision, 'profile revision', 1, 201), title: str(p.title, 'research title', 300, true), domains: strings(p.domains, 'domains', 20), methods, entryMode: one(p.entryMode, ['idea_only', 'design_first', 'existing_data'] as const, 'entry mode'), reference, constraints: strings(p.constraints, 'constraints'), pendingQuestions: strings(p.pendingQuestions, 'pendingQuestions'), limits: { maxAttempts: num(l.maxAttempts, 'maxAttempts', 1, 10), maxRounds: num(l.maxRounds, 'maxRounds', 1, 10), deadline } };
}
export function validateNodeConfirmation(v: unknown): GeneralNodeConfirmation {
  const c = object(v, ['confirmationId', 'nodeId', 'nodeSnapshotHash', 'dependencySnapshotHash', 'guards', 'profileRevision', 'idea', 'sourceRefs', 'datasets', 'reason', 'actor', 'createdAt'], 'node confirmation');
  const actor = object(c.actor, ['identity', 'actionId'], 'actor');
  let idea: GeneralNodeConfirmation['idea'] = null;
  if (c.idea !== null) { const i = object(c.idea, ['ideaId', 'revision'], 'idea'); idea = { ideaId: str(i.ideaId, 'ideaId', 200, true), revision: num(i.revision, 'Idea revision', 1, 2001) }; }
  const createdAt = str(c.createdAt, 'createdAt', 100, true); if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid confirmation timestamp');
  return { confirmationId: str(c.confirmationId, 'confirmationId', 200, true), nodeId: str(c.nodeId, 'nodeId', 200, true), nodeSnapshotHash: hash(c.nodeSnapshotHash), dependencySnapshotHash: hash(c.dependencySnapshotHash), guards: list(c.guards, 'condition guards', 200).map(v => { const guard = object(v, ['nodeId', 'reviewId'], 'guard'); return { nodeId: str(guard.nodeId, 'guard nodeId', 200, true), reviewId: str(guard.reviewId, 'guard reviewId', 200, true) }; }), profileRevision: num(c.profileRevision, 'profileRevision', 1, 201), idea, sourceRefs: strings(c.sourceRefs, 'sourceRefs'), datasets: list(c.datasets, 'datasets', 100).map(v => { const d = object(v, ['datasetId', 'version'], 'dataset input'); return { datasetId: str(d.datasetId, 'datasetId', 200, true), version: num(d.version, 'dataset version', 1, 1000) }; }), reason: str(c.reason, 'confirmation reason', 4000, true), actor: { identity: str(actor.identity, 'actor identity', 200, true), actionId: str(actor.actionId, 'actor actionId', 200, true) }, createdAt };
}

