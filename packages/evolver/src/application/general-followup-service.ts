import * as fs from 'node:fs';
import * as path from 'node:path';
import { BootstrapError, type BootstrapState } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch, type GeneralResearch } from '../contracts/general-research.ts';
import { validateGeneralFollowupOrigin, validateGeneralFollowupTask, validateGeneralNode, type GeneralFollowupOrigin, type GeneralNode } from '../contracts/general-workflow.ts';
import { ResearchBootstrapStore, requireResearch } from './research-bootstrap-store.ts';
import { ResearchCycleStore } from './research-cycle-store.ts';
import { genericDecision } from '../contracts/general-cycle.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';
import { GeneralMaterialStore } from './general-material-store.ts';
import { assertGeneralSourceAccess } from './general-source-access.ts';
import { GeneralAnalysisService, generalContextHash, nodeHash, reviewFreshness } from './general-analysis-service.ts';
import { dependencySnapshotHash } from './general-graph-context.ts';
import { object, str } from '../contracts/general-data.ts';
import type { GeneralCycleBaseGraph } from './general-cycle-context.ts';
import { GeneralEvidenceReader } from './general-evidence-service.ts';

/** Explicit user adoption creates future base work; it never rewrites outputs or runs an Agent. */
export class GeneralFollowupService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }
  private publications(researchId: string) {
    if (!/^[\w-]+$/.test(researchId)) throw new BootstrapError('POLICY_DENIED', 'Invalid followup namespace');
    let current = this.store.workspaceRoot;
    for (const part of ['', '.dsh', 'research', 'cycles', researchId, 'artifacts']) { if (part) current = path.join(current, part); if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory())) throw new BootstrapError('POLICY_DENIED', 'Followup artifact namespace contains a link'); }
    return new ResearchCycleStore(this.store.workspaceRoot, researchId);
  }
  resolve(researchId: string, originInput: GeneralFollowupOrigin, snapshot?: BootstrapState) {
    const state = snapshot ?? this.store.readStateOrEmpty(), g = requireResearch(state, researchId).general;
    if (!g) throw new BootstrapError('INVALID_INPUT', 'Followup needs a generic research');
    const origin = validateGeneralFollowupOrigin(originInput), sourceIds = new Set<string>(), calculationIds = new Set<string>(), priorArtifacts: { id: string; sha256: string }[] = [];
    let suggestion: string, parentNodeId: string;
    if (origin.kind === 'human_review') {
      const review = g.reviews.find(r => r.reviewId === origin.reviewId);
      if (!review) throw new BootstrapError('NOT_FOUND', 'Review does not belong to this research');
      if (reviewFreshness(g, review).status !== 'current') throw new BootstrapError('SOURCE_STALE', 'Review inputs or protocol changed; re-review before adopting');
      suggestion = review.nextActions[origin.actionIndex]; parentNodeId = review.nodeId;
      review.sourceRefs.forEach(id => sourceIds.add(id)); review.calculationIds.forEach(id => calculationIds.add(id));
    } else {
      const publications = this.publications(researchId), cycle = publications.readStateOrEmpty();
      const run = cycle.runs.find(r => r.runId === origin.runId), reviewer = cycle.steps.find(s => s.runId === origin.runId && s.role === 'reviewer');
      if (!run || run.mode !== 'general' || run.status !== 'completed' || !reviewer || reviewer.status !== 'completed' || !reviewer.outputRefs.some(r => r.id === origin.decisionRef.id && r.sha256 === origin.decisionRef.sha256) || !cycle.appliedDecisions.some(d => d.runId === run.runId && d.decisionRef.sha256 === origin.decisionRef.sha256)) throw new BootstrapError('POLICY_DENIED', 'Only a completed registered Reviewer decision can seed future work');
      if (!cycle.artifacts.some(a => a.runId === run.runId && a.stepId === reviewer.stepId && a.kind === 'decision' && a.ref.sha256 === origin.decisionRef.sha256)) throw new BootstrapError('POLICY_DENIED', 'Decision artifact is not registered to this Reviewer');
      const decision = genericDecision(publications.readArtifactJson(origin.decisionRef)), action = decision.nextActions.find(a => a.actionId === origin.actionId);
      if (!action || decision.nextActions.filter(a => a.actionId === origin.actionId).length !== 1) throw new BootstrapError('NOT_FOUND', 'Reviewer action is missing or ambiguous in this decision');
      suggestion = `${action.title}：${action.detail}`; parentNodeId = run.nodeId!;
      const base = publications.readArtifactJson(run.baseGraphRef) as GeneralCycleBaseGraph;
      if (base.mode !== 'general' || base.contextHash !== generalContextHash(g) || dependencySnapshotHash({ ...g, graph: base.graph }, parentNodeId) !== dependencySnapshotHash(g, parentNodeId)) throw new BootstrapError('SOURCE_STALE', 'Decision task context changed; re-review before adopting');
      for (const ref of run.generalInputRefs ?? []) {
        const input = publications.readArtifactJson(ref) as Record<string, any>;
        if (input.kind === 'general_material_snapshot') { const source = g.sources.find(s => s.sourceId === input.source.sourceId); if (!source || source.sha256 !== input.source.sha256 || g.sources.some(s => s.previousSourceId === source.sourceId)) throw new BootstrapError('SOURCE_STALE', 'Decision source version changed'); sourceIds.add(source.sourceId); const datasets = g.datasets.filter(d => d.sourceId === source.sourceId && !g.datasets.some(n => n.datasetId === d.datasetId && n.version > d.version)); if (cycleContentHash('followup-dictionaries-v1', datasets) !== cycleContentHash('followup-dictionaries-v1', input.datasets)) throw new BootstrapError('SOURCE_STALE', 'Decision dictionary versions changed'); }
        if (input.kind === 'general_existing_calculation') calculationIds.add(input.calculation.calculationId);
      }
      const reader = new GeneralEvidenceReader(this.store, researchId, state);
      for (const ref of run.generalInputRefs ?? []) { const input = publications.readArtifactJson(ref) as Record<string, any>; if (input.kind === 'general_evidence_pack') for (const hit of input.hits) { for (const locator of hit.locators) if (reader.assertLocator(locator, [...sourceIds]).reasons.length) throw new BootstrapError('SOURCE_STALE', 'Decision evidence locator changed'); if (hit.knowledgeRef) { const entry = g.knowledge.find(e => e.entryId === hit.knowledgeRef.entryId && e.version === hit.knowledgeRef.version); if (!entry || reader.check(entry, [...sourceIds]).status !== 'current') throw new BootstrapError('SOURCE_STALE', 'Decision Wiki evidence changed'); } } }
      priorArtifacts.push(decision.proposalRef, decision.planRef, decision.evidenceRef, origin.decisionRef);
      for (const ref of priorArtifacts) { if (!cycle.artifacts.some(a => a.runId === run.runId && a.ref.id === ref.id && a.ref.sha256 === ref.sha256)) throw new BootstrapError('POLICY_DENIED', 'Decision predecessor artifact is not registered to this run'); publications.readArtifact(ref); }
    }
    if (typeof suggestion !== 'string' || !suggestion.trim()) throw new BootstrapError('NOT_FOUND', 'No registered suggestion at this action identity');
    const analysis = new GeneralAnalysisService(this.store);
    for (const id of calculationIds) { const c = analysis.readCalculation(researchId, id, state); if (!c.content || c.freshness.status !== 'current') throw new BootstrapError('SOURCE_STALE', 'Followup calculation is unavailable or stale'); sourceIds.add(c.calculation.input.sourceId); if (c.calculation.artifact) priorArtifacts.push(c.calculation.artifact); }
    const material = new GeneralMaterialStore(this.store.workspaceRoot);
    for (const id of sourceIds) { assertGeneralSourceAccess(g, id); const s = g.sources.find(s => s.sourceId === id)!; if (g.sources.some(n => n.previousSourceId === id)) throw new BootstrapError('SOURCE_STALE', 'Followup source has a newer version'); if (s.parseStatus === 'parsed') material.readParsed(s); else material.readRaw(s); }
    return { origin, suggestion, parentNodeId, sourceIds: [...sourceIds].sort(), calculationIds: [...calculationIds].sort(), priorArtifacts: [...new Map(priorArtifacts.map(r => [r.sha256, r])).values()] };
  }
  adopt(input: { operationId: string; baseRevision: number; researchId: string; authorize: boolean; origin: GeneralFollowupOrigin; task: { title: string; goal: string; method: string; completionCriterion: string } }, identity: string) {
    if (input.authorize !== true) throw new BootstrapError('POLICY_DENIED', 'Explicit adoption authorization is required; viewing suggestions never creates work');
    const task = object(input.task, ['title', 'goal', 'method', 'completionCriterion'], 'future task');
    for (const [key, value] of Object.entries(task)) str(value, key, key === 'title' ? 300 : 4000, true);
    const origin = validateGeneralFollowupOrigin(input.origin);
    return this.store.mutate({ ...input, kind: 'adopt_general_review_action', requestPayload: { researchId: input.researchId, authorize: true, origin, task }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general!;
      const resolved = this.resolve(input.researchId, origin, context.state);
      if (g.graph.nodes.some(n => n.task && cycleContentHash('followup-origin-v1', n.task.origin) === cycleContentHash('followup-origin-v1', origin))) throw new BootstrapError('IDEMPOTENCY_CONFLICT', 'This Reviewer suggestion already has adopted future work');
      const node = validateGeneralNode({ nodeId: context.mint('followup-node'), kind: 'analysis', ...task, inputs: [], output: '本节点的未来产物；尚未执行或验证', join: 'all', execution: 'not_started', task: validateGeneralFollowupTask({ kind: 'review_followup', origin, suggestion: resolved.suggestion, sourceIds: resolved.sourceIds, calculationIds: resolved.calculationIds, priorArtifacts: resolved.priorArtifacts, actor: { identity, actionId: input.operationId }, createdAt: context.now() }) });
      g.graphHistory.push(structuredClone(g.graph)); g.graph.nodes.push(node); g.graph.edges.push({ edgeId: context.mint('followup-edge'), from: node.nodeId, to: resolved.parentNodeId, kind: 'derived_from', condition: null }); g.graph.revision++;
      g.layout[node.nodeId] = { x: 50, y: 360 + g.graph.nodes.length * 20 }; g.revision++; r.general = validateGeneralResearch(g); r.updatedAt = context.now();
      return { changed: true, result: { nodeId: node.nodeId, graphRevision: g.graph.revision } };
    } });
  }
  freeze(researchId: string, node: GeneralNode, sourceIds: string[], snapshot: BootstrapState) {
    if (!node.task) return null;
    const resolved = this.resolve(researchId, node.task.origin, snapshot);
    if (resolved.sourceIds.some(id => !sourceIds.includes(id))) throw new BootstrapError('POLICY_DENIED', 'Followup inputs must include every prior evidence source');
    if (cycleContentHash('followup-dependencies-v1', { sourceIds: resolved.sourceIds, calculationIds: resolved.calculationIds, priorArtifacts: resolved.priorArtifacts, suggestion: resolved.suggestion }) !== cycleContentHash('followup-dependencies-v1', { sourceIds: node.task.sourceIds, calculationIds: node.task.calculationIds, priorArtifacts: node.task.priorArtifacts, suggestion: node.task.suggestion })) throw new BootstrapError('SOURCE_STALE', 'Adopted Reviewer scope changed');
    return { nodeId: node.nodeId, title: node.title, goal: node.goal, method: node.method, completionCriterion: node.completionCriterion, nodeSnapshotHash: nodeHash(node), ...node.task };
  }
}
