import type { ArtifactRef } from '../contracts/experiments.ts';
import type {
  CandidateDraft,
  SearchNode,
  SearchPlan,
} from '../contracts/search.ts';
import {
  type SearchFeedbackNodeEvidence,
  type SearchFeedbackPack,
  type SearchFeedbackRecord,
  type SearchMetricEvidence,
  type SearchProposalInput,
  type SearchProposalReceipt,
  type SearchSelectionDecision,
  searchFeedbackRef,
  validateSearchFeedbackRecord,
} from '../contracts/search-feedback.ts';
import { SearchError } from '../contracts/search.ts';
import { canonicalJsonV1, typedHash } from '../domain/research-canonical.ts';

export interface SearchMetricEvidenceRefInput {
  nodeId: string;
  seed: number;
  metricId: string;
  verifiedRef: ArtifactRef;
}

export interface SearchCostFactInput {
  nodeId: string;
  costRef: ArtifactRef;
  actualExecutionMs: number;
}

export interface BuildFeedbackPackInput {
  round: number;
  basisRevision: number;
  records: Array<{ record: SearchFeedbackRecord; ref: ArtifactRef }>;
  metricEvidenceRefs: SearchMetricEvidenceRefInput[];
  costFacts: SearchCostFactInput[];
}

function same(a: unknown, b: unknown): boolean { return canonicalJsonV1(a) === canonicalJsonV1(b); }

function recordRef(record: SearchFeedbackRecord): ArtifactRef { return searchFeedbackRef(record); }

function primaryMean(pack: SearchFeedbackPack, nodeId: string): number {
  const parent = pack.eligibleParents.find((entry) => entry.nodeId === nodeId);
  if (!parent) throw new SearchError('DEPENDENCY_NOT_READY', `feedback pack has no verified parent evidence for ${nodeId}`);
  const values = parent.metricEvidence.filter((metric) => metric.metricId === pack.primaryMetricId).map((metric) => metric.value);
  if (values.length === 0) throw new SearchError('SCHEMA_VIOLATION', `feedback pack is missing primary metric values for ${nodeId}`);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function reasonForNode(node: SearchNode, plan: SearchPlan): string {
  if (node.status !== 'eligible') return `status_${node.status}_cannot_parent`;
  if (node.depth >= plan.limits.maxDepth) return 'max_depth_reached';
  return 'no_untried_legal_prefix';
}

export function buildSearchFeedbackPack(plan: SearchPlan, nodes: SearchNode[], input: BuildFeedbackPackInput): SearchFeedbackPack {
  if (!Number.isSafeInteger(input.round) || input.round < 1 || input.round > plan.limits.requiredRounds) throw new SearchError('POLICY_DENIED', 'feedback round is outside the frozen round limit');
  const denominator = plan.experimentTemplate.pairedSeeds.flatMap((seed) => plan.experimentTemplate.metricSpecs.map((metric) => ({ seed, metricId: metric.id })));
  const evidenceByKey = new Map(input.metricEvidenceRefs.map((entry) => [`${entry.nodeId}\u0000${entry.seed}\u0000${entry.metricId}`, entry.verifiedRef]));
  if (evidenceByKey.size !== input.metricEvidenceRefs.length) throw new SearchError('SCHEMA_VIOLATION', 'metric evidence refs contain duplicate node/seed/metric keys');
  const costByNode = new Map(input.costFacts.map((entry) => [entry.nodeId, entry]));
  if (costByNode.size !== input.costFacts.length) throw new SearchError('SCHEMA_VIOLATION', 'cost facts contain duplicate node IDs');
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));
  if (nodesById.size !== nodes.length) throw new SearchError('SCHEMA_VIOLATION', 'search nodes contain duplicate node IDs');

  const untried = (parent: SearchNode) => {
    const parentModules = parent.candidate?.orderedModuleIds ?? [];
    return plan.candidateSpace.legalPrefixes.filter((prefix => {
      const alreadyAttempted = nodes.some((node) => node.candidate?.candidateId === prefix.variantId);
      return !alreadyAttempted && prefix.moduleIds.length === parentModules.length + 1 && prefix.moduleIds.slice(0, -1).every((id, index) => id === parentModules[index]);
    })).map((prefix) => ({ parentNodeId: parent.nodeId, candidateId: prefix.variantId, orderedModuleIds: [...prefix.moduleIds], addedModuleId: prefix.moduleIds[prefix.moduleIds.length - 1] }));
  };
  const legalNextPrefixes = nodes.filter((node) => node.status === 'eligible' && node.depth < plan.limits.maxDepth).flatMap(untried);
  const eligibleParents: SearchFeedbackNodeEvidence[] = nodes.filter((node) => node.status === 'eligible').map((node) => {
    const cost = costByNode.get(node.nodeId);
    if (!cost || !same(cost.costRef, node.costRef ?? plan.baseline.costRef) || !Number.isSafeInteger(cost.actualExecutionMs) || cost.actualExecutionMs < 0) {
      throw new SearchError('SOURCE_MISMATCH', `verified execution cost is missing or differs for eligible node ${node.nodeId}`);
    }
    const metricEvidence: SearchMetricEvidence[] = denominator.map(({ seed, metricId }) => {
      const value = node.kind === 'baseline'
        ? plan.baseline.observations.find((observation) => observation.seed === seed && observation.metricId === metricId)
        : node.metricValues.find((metric) => metric.seed === seed && metric.metricId === metricId);
      if (!value) throw new SearchError('SCHEMA_VIOLATION', `eligible node ${node.nodeId} is missing ${metricId} for seed ${seed}`);
      const verifiedRef = node.kind === 'baseline'
        ? plan.baseline.observations.find((observation) => observation.seed === seed && observation.metricId === metricId)!.verifiedRef
        : evidenceByKey.get(`${node.nodeId}\u0000${seed}\u0000${metricId}`);
      if (!verifiedRef) throw new SearchError('SOURCE_MISMATCH', `verified metric evidence ref is missing for ${node.nodeId}/${seed}/${metricId}`);
      if (value.value < plan.experimentTemplate.metricSpecs.find((spec) => spec.id === metricId)!.validRange[0] || value.value > plan.experimentTemplate.metricSpecs.find((spec) => spec.id === metricId)!.validRange[1]) {
        throw new SearchError('SCHEMA_VIOLATION', `eligible node ${node.nodeId} has a non-finite or out-of-range metric`);
      }
      return { seed, metricId, value: value.value, unit: value.unit, split: 'validation', verifiedRef };
    });
    return {
      nodeId: node.nodeId,
      depth: node.depth,
      round: node.round,
      resultRefs: node.resultRefs,
      costRef: cost.costRef,
      verifierRef: node.verifierRef,
      actualExecutionMs: cost.actualExecutionMs,
      metricEvidence,
    };
  });
  const excludedNodes = nodes.filter((node) => node.kind !== 'baseline' && (node.status !== 'eligible' || !untried(node).length || node.depth >= plan.limits.maxDepth)).map((node) => ({
    nodeId: node.nodeId,
    status: node.status,
    reason: reasonForNode(node, plan),
  }));
  const receiptRecords = input.records.filter((entry) => entry.record.kind === 'proposal_receipt').map((entry) => entry.record as SearchProposalReceipt);
  const modelCalls = receiptRecords.reduce((sum, receipt) => sum + receipt.actualModelCalls, 0);
  const totalTokens = receiptRecords.reduce((sum, receipt) => sum + receipt.inputTokens + receipt.outputTokens, 0);
  const treeHash = typedHash('search-tree-v1', nodes);
  const record: SearchFeedbackPack = {
    schemaVersion: 1,
    kind: 'feedback_pack',
    recordId: `feedback-r${input.round}`,
    searchId: plan.searchId,
    planRef: plan.planRef,
    basisRevision: input.basisRevision,
    treeHash,
    round: input.round,
    scope: 'development',
    primaryMetricId: plan.experimentTemplate.primaryMetricId,
    metricDenominator: denominator,
    eligibleParents,
    excludedNodes,
    legalNextPrefixes,
    explorationPolicy: {
      id: plan.limits.explorationPolicy.id,
      topK: plan.limits.topK,
      tieBreak: ['primaryMetricDirection', 'actualExecutionMs', 'nodeId'],
      continueAfterNonImprovingValidNode: true,
      requiresVerifiedDevelopmentResult: true,
      failedOrNonFiniteNodesMayParent: false,
      testAccess: 'forbidden',
    },
    usage: {
      proposalAttempts: nodes.filter((node) => node.kind !== 'baseline').length,
      maxProposalAttempts: plan.limits.maxProposalAttempts,
      modelCalls,
      maxModelCalls: plan.proposalProfile.maxModelCalls,
      totalTokens,
      maxTotalTokens: plan.proposalProfile.maxTotalTokens,
    },
  };
  return validateSearchFeedbackRecord(record) as SearchFeedbackPack;
}

export function selectNextMutation(plan: SearchPlan, pack: SearchFeedbackPack, feedbackPackRef: ArtifactRef, basisRevision: number): SearchSelectionDecision {
  if (!same(pack.planRef, plan.planRef) || pack.searchId !== plan.searchId) throw new SearchError('SOURCE_MISMATCH', 'feedback pack does not belong to the frozen plan');
  const prefixByParent = new Map<string, SearchFeedbackPack['legalNextPrefixes'][number]>();
  for (const prefix of pack.legalNextPrefixes) {
    const existing = prefixByParent.get(prefix.parentNodeId);
    if (existing) throw new SearchError('POLICY_DENIED', `parent ${prefix.parentNodeId} has multiple available prefixes under top-K=1 selection`);
    prefixByParent.set(prefix.parentNodeId, prefix);
  }
  const eligible = pack.eligibleParents.filter((parent) => prefixByParent.has(parent.nodeId));
  const scored = eligible.map((parent) => ({
    nodeId: parent.nodeId,
    primaryMetricMean: primaryMean(pack, parent.nodeId),
    actualExecutionMs: parent.actualExecutionMs,
    costRef: parent.costRef,
  }));
  const direction = plan.experimentTemplate.metricSpecs.find((metric) => metric.id === plan.experimentTemplate.primaryMetricId)!.direction;
  scored.sort((a, b) => (direction === 'minimize' ? a.primaryMetricMean - b.primaryMetricMean : b.primaryMetricMean - a.primaryMetricMean) || a.actualExecutionMs - b.actualExecutionMs || a.nodeId.localeCompare(b.nodeId));
  const excludedParents = pack.eligibleParents.filter((parent) => !prefixByParent.has(parent.nodeId)).map((parent) => ({
    nodeId: parent.nodeId,
    reason: parent.depth >= plan.limits.maxDepth ? 'max_depth_reached' : 'no_untried_legal_prefix',
  }));
  const currentNodesCount = new Set([...pack.eligibleParents.map((parent) => parent.nodeId), ...pack.excludedNodes.map((node) => node.nodeId)]).size;
  let stopReason: string | null = null;
  if (pack.usage.proposalAttempts >= pack.usage.maxProposalAttempts) stopReason = 'proposal_attempt_budget_exhausted';
  else if (currentNodesCount >= plan.limits.maxNodes) stopReason = 'node_budget_exhausted';
  else if (scored.length === 0) stopReason = 'finite_prefix_space_exhausted';
  const winner = stopReason === null ? scored[0] : undefined;
  const prefix = winner ? prefixByParent.get(winner.nodeId)! : undefined;
  const selected = winner && prefix ? {
    parentNodeId: winner.nodeId,
    candidateId: prefix.candidateId,
    orderedModuleIds: prefix.orderedModuleIds,
    addedModuleId: prefix.addedModuleId,
    selectionReason: winner.nodeId !== 'baseline' && (direction === 'minimize' ? winner.primaryMetricMean > primaryMean(pack, 'baseline') : winner.primaryMetricMean < primaryMean(pack, 'baseline'))
      ? 'continue_after_non_improving_parent' as const : 'best_verified_parent' as const,
  } : null;
  const decision: SearchSelectionDecision = {
    schemaVersion: 1, kind: 'selection_decision', recordId: `selection-r${pack.round}`, searchId: plan.searchId, planRef: plan.planRef,
    basisRevision, treeHash: pack.treeHash, round: pack.round, feedbackPackRef,
    rankedParents: scored, excludedParents, selected, stopReason,
  };
  return validateSearchFeedbackRecord(decision) as SearchSelectionDecision;
}

export function buildSearchProposalInput(plan: SearchPlan, pack: SearchFeedbackPack, feedbackPackRef: ArtifactRef, decision: SearchSelectionDecision, selectionDecisionRef: ArtifactRef, basisRevision: number): SearchProposalInput {
  if (decision.selected === null) throw new SearchError('DEPENDENCY_NOT_READY', 'cannot create a proposal input when the selection decision stopped');
  const envelope = {
    taskId: plan.taskId,
    scope: 'development' as const,
    round: pack.round,
    primaryMetricId: plan.experimentTemplate.primaryMetricId,
    candidateSpace: {
      slotId: plan.candidateSpace.slotId,
      orderedModuleIds: [...plan.candidateSpace.orderedModuleIds],
      legalPrefixes: plan.candidateSpace.legalPrefixes.map((prefix) => ({ variantId: prefix.variantId, moduleIds: [...prefix.moduleIds] })),
      forbiddenChanges: [...plan.candidateSpace.forbiddenChanges],
    },
    experimentTemplate: {
      profileRef: plan.experimentTemplate.profileRef,
      dataSubsetRef: plan.experimentTemplate.dataSubsetRef,
      evaluatorRef: plan.experimentTemplate.evaluatorRef,
      pairedSeeds: [...plan.experimentTemplate.pairedSeeds],
      trialLimit: plan.experimentTemplate.trialLimit,
      testAccess: 'forbidden' as const,
    },
    feedbackPack: pack,
    selectionDecision: decision,
    outputSchema: 'append_module_candidate_or_rejection-v1' as const,
  };
  const input: SearchProposalInput = {
    schemaVersion: 1, kind: 'proposal_input', recordId: `proposal-input-r${pack.round}`, searchId: plan.searchId, planRef: plan.planRef,
    basisRevision, treeHash: pack.treeHash, round: pack.round, feedbackPackRef, selectionDecisionRef,
    envelope, inputHash: typedHash('search-proposal-input-v1', envelope),
  };
  return validateSearchFeedbackRecord(input) as SearchProposalInput;
}

export function buildScriptedProposalReceipt(input: SearchProposalInput, proposalInputRef: ArtifactRef, decision: SearchSelectionDecision, basisRevision: number): SearchProposalReceipt {
  if (decision.selected === null) throw new SearchError('DEPENDENCY_NOT_READY', 'cannot create a scripted receipt for a stopped selection');
  const candidate = {
    parentNodeId: decision.selected.parentNodeId,
    candidateId: decision.selected.candidateId,
    mutationKind: 'append_module' as const,
    slotId: input.envelope.candidateSpace.slotId,
    orderedModuleIds: decision.selected.orderedModuleIds,
    addedModuleIds: [decision.selected.addedModuleId],
    hypothesis: `Test the frozen ${decision.selected.candidateId} module prefix against the verified parent result.`,
    hypothesisScope: `round-${input.round}-prefix-${decision.selected.candidateId}`,
  };
  const receipt: SearchProposalReceipt = {
    schemaVersion: 1, kind: 'proposal_receipt', recordId: `proposal-receipt-r${input.round}`, searchId: input.searchId, planRef: input.planRef,
    basisRevision, treeHash: input.treeHash, round: input.round, proposalInputRef, inputHash: input.inputHash,
    source: 'scripted_fixture', provider: null, model: null, route: null, environmentHash: null, callRef: null,
    actualModelCalls: 0, inputTokens: 0, outputTokens: 0, result: { kind: 'candidate', candidate },
  };
  return validateSearchFeedbackRecord(receipt) as SearchProposalReceipt;
}

export function candidateDraftFromReceipt(
  receipt: SearchProposalReceipt,
  receiptRef: ArtifactRef,
  evidenceRefs: ArtifactRef[],
  createdAt = new Date().toISOString(),
): CandidateDraft {
  if (receipt.result.kind !== 'candidate') throw new SearchError('POLICY_DENIED', 'a rejection receipt cannot register a candidate');
  const uniqueEvidence = new Map<string, ArtifactRef>();
  for (const ref of evidenceRefs) {
    const previous = uniqueEvidence.get(ref.id);
    if (previous && previous.sha256 !== ref.sha256) throw new SearchError('SOURCE_MISMATCH', `evidence artifact ID ${ref.id} has conflicting hashes`);
    uniqueEvidence.set(ref.id, ref);
  }
  return {
    schemaVersion: 1,
    candidateId: receipt.result.candidate.candidateId,
    parentNodeId: receipt.result.candidate.parentNodeId,
    mutationKind: 'append_module',
    slotId: receipt.result.candidate.slotId,
    orderedModuleIds: receipt.result.candidate.orderedModuleIds,
    addedModuleIds: receipt.result.candidate.addedModuleIds,
    hypothesis: receipt.result.candidate.hypothesis,
    hypothesisScope: receipt.result.candidate.hypothesisScope,
    evidenceRefs: [...uniqueEvidence.values()],
    proposalRef: receiptRef,
    repairOfNodeId: null,
    createdAt,
  };
}
