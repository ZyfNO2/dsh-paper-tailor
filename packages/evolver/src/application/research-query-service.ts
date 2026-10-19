import { ExperimentError, type ArtifactRef } from '../contracts/experiments.ts';
import { typedHash } from '../domain/research-canonical.ts';
import { compareResearchObservations } from '../domain/research-metric-comparison.ts';
import { ResearchAssetService } from './research-asset-service.ts';
import { ResearchExperimentPlanService } from './research-experiment-plan-service.ts';
import { ResearchLoopService } from './research-loop-service.ts';
import { PublishedResearchObservationReader } from './research-observation-reader.ts';
import { SearchStateStore } from './search-state-store.ts';
import { TeamResearchService } from './team-research-service.ts';

/** Domain facts only; no page layout, fake similarity or UI-facing scientific inference. */
export class ResearchQueryService {
  private readonly options: { taskId: string; authorize(caller: unknown): void; assets: ResearchAssetService; store: SearchStateStore;
    loop: ResearchLoopService; reader: PublishedResearchObservationReader; plans?: ResearchExperimentPlanService; team?: TeamResearchService;
    baselineObservationRef?: ArtifactRef;
  };
  constructor(options: ResearchQueryService['options']) { this.options = options; }
  private versions(caller: unknown) {
    this.options.authorize(caller);
    return { search: this.options.store.getRevision(), assets: this.options.assets.listAssets(caller).storeRevision,
      plans: this.options.plans?.listExperimentPlans(caller).revision ?? null, team: this.options.team?.getTeamResearch(caller).revision ?? null,
      loop: typedHash('research-loop-query-version-v1', { operations: this.options.loop.listOperations(caller), requests: this.options.loop.listBranchRequests(caller) }) };
  }
  getExperiment(caller: unknown, attemptId: string) {
    this.options.authorize(caller);
    const operations = this.options.loop.listOperations(caller), round = operations.flatMap((operation) => operation.rounds).find((entry) => this.options.reader.readObservation(caller, entry.observationRef).attemptId === attemptId);
    if (!round) {
      const operation = operations.find((entry) => entry.activeAttemptId === attemptId);
      if (!operation) throw new ExperimentError('DEPENDENCY_NOT_READY', 'No visible experiment attempt');
      return { attemptId, executionStatus: operation.status, verification: 'not_verified', observation: null, diagnostics: operation.firstError ? [operation.firstError] : [], cost: null, operationId: operation.operationId };
    }
    const observation = this.options.reader.readObservation(caller, round.observationRef);
    return { attemptId, executionStatus: 'completed', verification: observation.verification, observation, diagnostics: observation.diagnostics, cost: observation.costRef,
      observationRef: round.observationRef, configRef: observation.configRef, protocolRef: observation.protocolRef, processFacts: round.executionFacts, writebackRefs: round.writebackRefs };
  }
  getOperations(caller: unknown) {
    this.options.authorize(caller);
    return { loops: this.options.loop.listOperations(caller), branchRequests: this.options.loop.listBranchRequests(caller), plans: this.options.plans?.listExperimentPlans(caller) ?? null };
  }
  getChanges(caller: unknown, previousVersionHash: string | null = null) {
    const versions = this.versions(caller), versionHash = typedHash('research-query-version-v1', versions);
    return { schemaVersion: 1, taskId: this.options.taskId, versions, versionHash, changed: previousVersionHash !== versionHash,
      atomic: false, consistency: 'sampled', regions: ['research_graph', 'assets', 'experiments', 'team', 'operations'] };
  }
  getTaskResearchState(caller: unknown) {
    const before = this.versions(caller), plan = this.options.store.getPlan(), nodes = this.options.store.getNodes(), operations = this.options.loop.listOperations(caller);
    const rounds = operations.flatMap((operation) => operation.rounds), observations = rounds.map((round) => ({ round, observation: this.options.reader.readObservation(caller, round.observationRef) }));
    const baseline = this.options.baselineObservationRef ? this.options.reader.readObservation(caller, this.options.baselineObservationRef) : null;
    let best: { nodeId: string; observationRef: ArtifactRef; metricMean: number; percentageImprovement: number | null; evidenceRefs: ArtifactRef[] } | null = null;
    if (baseline) for (const entry of observations) {
      const node = nodes.find((candidate) => candidate.nodeId === entry.round.nodeId);
      if (node?.status !== 'eligible') continue;
      const comparison = compareResearchObservations(baseline, entry.observation, plan.experimentTemplate.primaryMetricId);
      if (!comparison.comparable) continue;
      const metrics = entry.observation.metrics.filter((metric) => metric.metricId === plan.experimentTemplate.primaryMetricId), mean = metrics.reduce((sum, metric) => sum + metric.value!, 0) / metrics.length;
      const direction = plan.experimentTemplate.metricSpecs.find((metric) => metric.id === plan.experimentTemplate.primaryMetricId)!.direction;
      if (!best || (direction === 'minimize' ? mean < best.metricMean : mean > best.metricMean)) best = { nodeId: entry.round.nodeId, observationRef: entry.round.observationRef, metricMean: mean, percentageImprovement: comparison.percentageImprovement,
        evidenceRefs: [this.options.baselineObservationRef!, entry.round.observationRef, baseline.verifierRef!, entry.observation.verifierRef!, baseline.comparisonConditionsRef] };
    }
    const candidates = nodes.filter((node) => node.kind !== 'baseline'), failed = candidates.filter((node) => ['failed', 'rejected', 'cancelled', 'interrupted'].includes(node.status)).length;
    const completed = candidates.filter((node) => node.status === 'eligible').length, unrun = Math.max(0, plan.candidateSpace.legalPrefixes.length - candidates.length);
    const assets = this.options.assets.listAssets(caller), contributions = this.options.assets.listLinkedRecords(caller, 'contribution'), citations = this.options.assets.listLinkedRecords(caller, 'citation');
    const after = this.versions(caller);
    return { schemaVersion: 1, taskId: this.options.taskId, scope: plan.scope, phase: operations.some((operation) => operation.status === 'running') ? 'executing' : completed ? 'results_available' : 'planned',
      sourceRevisions: assets.assets.flatMap((entry) => entry.asset.sourceRefs), searchGraph: nodes, researchGraph: this.options.assets.listLinkedRecords(caller, 'process'),
      summary: { denominator: plan.candidateSpace.legalPrefixes.length, completed, failed, active: candidates.length - completed - failed, notRun: unrun,
        bestPath: best, metric: plan.experimentTemplate.metricSpecs.find((metric) => metric.id === plan.experimentTemplate.primaryMetricId),
        supportedClaims: observations.map((entry) => ({ nature: 'local_observation', ref: entry.round.observationRef, verification: entry.observation.verification })),
        unverifiedClaims: assets.assets.flatMap((entry) => entry.asset.claims), evidenceRefs: observations.map((entry) => entry.round.observationRef),
        blockers: [...(!baseline ? ['No independently verified comparable baseline observation mounted; best/gain unavailable'] : []), ...operations.filter((operation) => operation.firstError).map((operation) => operation.firstError!.message)],
        nextStep: operations.some((operation) => operation.status === 'failed') ? 'reconcile_failed_operation' : unrun ? 'evaluate_remaining_frozen_prefixes' : 'review_engineering_evidence' },
      assets, contributions, citations, team: this.options.team?.getTeamResearch(caller) ?? null,
      consistency: { atomic: false, status: typedHash('research-query-version-v1', before) === typedHash('research-query-version-v1', after) ? 'sampled_stable' : 'stale', before, after },
      capabilities: { paperSimilarity: { available: false, reason: 'No similarity scorer installed' }, relevanceScore: null, notes: { available: false, reason: 'No notes sidecar implemented' },
        hostRuntimeStatus: 'not_run', integratedStatus: 'not_run' } };
  }
}
