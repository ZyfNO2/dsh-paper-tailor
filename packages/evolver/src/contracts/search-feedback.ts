import type { ArtifactRef } from './experiments.ts';
import { SearchError, validateSearchArtifactRef } from './search.ts';
import { typedHash } from '../domain/research-canonical.ts';

export type SearchFeedbackRecordKind = 'feedback_pack' | 'selection_decision' | 'proposal_input' | 'proposal_receipt';

export interface SearchFeedbackBase {
  schemaVersion: 1;
  kind: SearchFeedbackRecordKind;
  recordId: string;
  searchId: string;
  planRef: ArtifactRef;
  basisRevision: number;
  treeHash: string;
  round: number;
}

export interface SearchMetricEvidence {
  seed: number;
  metricId: string;
  value: number;
  unit: string;
  split: 'validation';
  verifiedRef: ArtifactRef;
}

export interface SearchFeedbackNodeEvidence {
  nodeId: string;
  depth: number;
  round: number;
  resultRefs: ArtifactRef[];
  costRef: ArtifactRef;
  verifierRef: ArtifactRef | null;
  actualExecutionMs: number;
  metricEvidence: SearchMetricEvidence[];
}

export interface SearchFeedbackPack extends SearchFeedbackBase {
  kind: 'feedback_pack';
  scope: 'development';
  primaryMetricId: string;
  metricDenominator: Array<{ seed: number; metricId: string }>;
  eligibleParents: SearchFeedbackNodeEvidence[];
  excludedNodes: Array<{ nodeId: string; status: string; reason: string }>;
  legalNextPrefixes: Array<{ parentNodeId: string; candidateId: string; orderedModuleIds: string[]; addedModuleId: string }>;
  explorationPolicy: {
    id: string;
    topK: number;
    tieBreak: ['primaryMetricDirection', 'actualExecutionMs', 'nodeId'];
    continueAfterNonImprovingValidNode: true;
    requiresVerifiedDevelopmentResult: true;
    failedOrNonFiniteNodesMayParent: false;
    testAccess: 'forbidden';
  };
  usage: {
    proposalAttempts: number;
    maxProposalAttempts: number;
    modelCalls: number;
    maxModelCalls: number;
    totalTokens: number;
    maxTotalTokens: number;
  };
}

export interface SearchSelectionDecision extends SearchFeedbackBase {
  kind: 'selection_decision';
  feedbackPackRef: ArtifactRef;
  rankedParents: Array<{ nodeId: string; primaryMetricMean: number; actualExecutionMs: number; costRef: ArtifactRef }>;
  excludedParents: Array<{ nodeId: string; reason: string }>;
  selected: {
    parentNodeId: string;
    candidateId: string;
    orderedModuleIds: string[];
    addedModuleId: string;
    selectionReason: 'best_verified_parent' | 'continue_after_non_improving_parent';
  } | null;
  stopReason: string | null;
}

export interface SearchProposalRequestEnvelope {
  taskId: string;
  scope: 'development';
  round: number;
  primaryMetricId: string;
  candidateSpace: {
    slotId: string;
    orderedModuleIds: string[];
    legalPrefixes: Array<{ variantId: string; moduleIds: string[] }>;
    forbiddenChanges: string[];
  };
  experimentTemplate: {
    profileRef: string;
    dataSubsetRef: ArtifactRef;
    evaluatorRef: ArtifactRef;
    pairedSeeds: number[];
    trialLimit: { kind: 'steps'; value: number };
    testAccess: 'forbidden';
  };
  feedbackPack: SearchFeedbackPack;
  selectionDecision: SearchSelectionDecision;
  outputSchema: 'append_module_candidate_or_rejection-v1';
}

export interface SearchProposalInput extends SearchFeedbackBase {
  kind: 'proposal_input';
  feedbackPackRef: ArtifactRef;
  selectionDecisionRef: ArtifactRef;
  envelope: SearchProposalRequestEnvelope;
  inputHash: string;
}

export interface SearchProposalCandidate {
  parentNodeId: string;
  candidateId: string;
  mutationKind: 'append_module';
  slotId: string;
  orderedModuleIds: string[];
  addedModuleIds: string[];
  hypothesis: string;
  hypothesisScope: string;
}

export interface SearchProposalReceipt extends SearchFeedbackBase {
  kind: 'proposal_receipt';
  proposalInputRef: ArtifactRef;
  inputHash: string;
  source: 'scripted_fixture' | 'live_model';
  provider: string | null;
  model: string | null;
  route: string | null;
  environmentHash: string | null;
  callRef: ArtifactRef | null;
  actualModelCalls: number;
  inputTokens: number;
  outputTokens: number;
  result:
    | { kind: 'candidate'; candidate: SearchProposalCandidate }
    | { kind: 'rejection'; code: string; message: string };
}

export type SearchFeedbackRecord = SearchFeedbackPack | SearchSelectionDecision | SearchProposalInput | SearchProposalReceipt;

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ARRAY_MODULES = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROFILE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

function obj(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SearchError('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: string[], at: string): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SearchError('SCHEMA_VIOLATION', `${at} contains unknown field "${key}"`, [`${at}.${key}`]);
  for (const key of expected) if (!(key in value)) throw new SearchError('SCHEMA_VIOLATION', `${at}.${key} is required`, [`${at}.${key}`]);
}

function str(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim() || (pattern && !pattern.test(value))) {
    throw new SearchError('SCHEMA_VIOLATION', `${at} must be a trimmed non-empty string`, [at]);
  }
  return value;
}

function int(value: unknown, at: string, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new SearchError('SCHEMA_VIOLATION', `${at} must be a safe integer >= ${min}`, [at]);
  return value as number;
}

function finite(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SearchError('SCHEMA_VIOLATION', `${at} must be finite`, [at]);
  return value;
}

function stringList(value: unknown, at: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new SearchError('SCHEMA_VIOLATION', `${at} must be a non-empty array`, [at]);
  const items = value.map((item, index) => str(item, `${at}[${index}]`, pattern));
  if (new Set(items).size !== items.length) throw new SearchError('SCHEMA_VIOLATION', `${at} contains duplicates`, [at]);
  return items;
}

function stringListAllowEmpty(value: unknown, at: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value)) throw new SearchError('SCHEMA_VIOLATION', `${at} must be an array`, [at]);
  if (value.length === 0) return [];
  return stringList(value, at, pattern);
}

function base(raw: Record<string, unknown>, kind: SearchFeedbackRecordKind): SearchFeedbackBase {
  if (raw.schemaVersion !== 1 || raw.kind !== kind) throw new SearchError('SCHEMA_VIOLATION', `unsupported ${kind} record version or kind`);
  return {
    schemaVersion: 1,
    kind,
    recordId: str(raw.recordId, `${kind}.recordId`, ID),
    searchId: str(raw.searchId, `${kind}.searchId`, ID),
    planRef: validateSearchArtifactRef(raw.planRef, `${kind}.planRef`),
    basisRevision: int(raw.basisRevision, `${kind}.basisRevision`),
    treeHash: str(raw.treeHash, `${kind}.treeHash`, HEX64),
    round: int(raw.round, `${kind}.round`, 1),
  };
}

function metricEvidence(value: unknown, at: string): SearchMetricEvidence {
  const raw = obj(value, at);
  keys(raw, ['seed', 'metricId', 'value', 'unit', 'split', 'verifiedRef'], at);
  if (raw.split !== 'validation') throw new SearchError('POLICY_DENIED', `${at}.split must be validation`);
  return {
    seed: int(raw.seed, `${at}.seed`), metricId: str(raw.metricId, `${at}.metricId`, ID),
    value: finite(raw.value, `${at}.value`), unit: str(raw.unit, `${at}.unit`), split: 'validation',
    verifiedRef: validateSearchArtifactRef(raw.verifiedRef, `${at}.verifiedRef`),
  };
}

function feedbackPack(raw: Record<string, unknown>): SearchFeedbackPack {
  keys(raw, ['schemaVersion', 'kind', 'recordId', 'searchId', 'planRef', 'basisRevision', 'treeHash', 'round', 'scope', 'primaryMetricId', 'metricDenominator', 'eligibleParents', 'excludedNodes', 'legalNextPrefixes', 'explorationPolicy', 'usage'], 'feedbackPack');
  const common = base(raw, 'feedback_pack');
  if (raw.scope !== 'development') throw new SearchError('POLICY_DENIED', 'feedback packs are restricted to development scope');
  if (!Array.isArray(raw.metricDenominator) || raw.metricDenominator.length === 0) throw new SearchError('SCHEMA_VIOLATION', 'feedbackPack.metricDenominator must not be empty');
  const metricDenominator = raw.metricDenominator.map((entry, index) => {
    const item = obj(entry, `feedbackPack.metricDenominator[${index}]`);
    keys(item, ['seed', 'metricId'], `feedbackPack.metricDenominator[${index}]`);
    return { seed: int(item.seed, `feedbackPack.metricDenominator[${index}].seed`), metricId: str(item.metricId, `feedbackPack.metricDenominator[${index}].metricId`, ID) };
  });
  const expectedPairs = new Set(metricDenominator.map((item) => `${item.seed}\u0000${item.metricId}`));
  if (expectedPairs.size !== metricDenominator.length) throw new SearchError('SCHEMA_VIOLATION', 'feedbackPack.metricDenominator contains duplicates');
  if (!Array.isArray(raw.eligibleParents)) throw new SearchError('SCHEMA_VIOLATION', 'feedbackPack.eligibleParents must be an array');
  const eligibleParents = raw.eligibleParents.map((entry, index) => {
    const at = `feedbackPack.eligibleParents[${index}]`;
    const item = obj(entry, at);
    keys(item, ['nodeId', 'depth', 'round', 'resultRefs', 'costRef', 'verifierRef', 'actualExecutionMs', 'metricEvidence'], at);
    if (!Array.isArray(item.resultRefs) || item.resultRefs.length === 0 || !Array.isArray(item.metricEvidence)) throw new SearchError('SCHEMA_VIOLATION', `${at} evidence arrays must not be empty`);
    const evidence = item.metricEvidence.map((metric, metricIndex) => metricEvidence(metric, `${at}.metricEvidence[${metricIndex}]`));
    if (evidence.length !== expectedPairs.size || new Set(evidence.map((metric) => `${metric.seed}\u0000${metric.metricId}`)).size !== expectedPairs.size ||
        evidence.some((metric) => !expectedPairs.has(`${metric.seed}\u0000${metric.metricId}`))) {
      throw new SearchError('SCHEMA_VIOLATION', `${at} metric evidence does not cover the complete frozen denominator`);
    }
    const verifierRef = item.verifierRef === null ? null : validateSearchArtifactRef(item.verifierRef, `${at}.verifierRef`);
    return {
      nodeId: str(item.nodeId, `${at}.nodeId`, ID), depth: int(item.depth, `${at}.depth`), round: int(item.round, `${at}.round`),
      resultRefs: item.resultRefs.map((ref, refIndex) => validateSearchArtifactRef(ref, `${at}.resultRefs[${refIndex}]`)),
      costRef: validateSearchArtifactRef(item.costRef, `${at}.costRef`), verifierRef,
      actualExecutionMs: int(item.actualExecutionMs, `${at}.actualExecutionMs`), metricEvidence: evidence,
    };
  });
  if (new Set(eligibleParents.map((item) => item.nodeId)).size !== eligibleParents.length) throw new SearchError('SCHEMA_VIOLATION', 'feedbackPack.eligibleParents contains duplicate node IDs');
  if (!Array.isArray(raw.excludedNodes) || !Array.isArray(raw.legalNextPrefixes)) throw new SearchError('SCHEMA_VIOLATION', 'feedbackPack excludedNodes and legalNextPrefixes must be arrays');
  const excludedNodes = raw.excludedNodes.map((entry, index) => {
    const at = `feedbackPack.excludedNodes[${index}]`;
    const item = obj(entry, at); keys(item, ['nodeId', 'status', 'reason'], at);
    return { nodeId: str(item.nodeId, `${at}.nodeId`, ID), status: str(item.status, `${at}.status`), reason: str(item.reason, `${at}.reason`) };
  });
  const legalNextPrefixes = raw.legalNextPrefixes.map((entry, index) => {
    const at = `feedbackPack.legalNextPrefixes[${index}]`;
    const item = obj(entry, at); keys(item, ['parentNodeId', 'candidateId', 'orderedModuleIds', 'addedModuleId'], at);
    const modules = stringList(item.orderedModuleIds, `${at}.orderedModuleIds`, ARRAY_MODULES);
    return { parentNodeId: str(item.parentNodeId, `${at}.parentNodeId`, ID), candidateId: str(item.candidateId, `${at}.candidateId`, ID), orderedModuleIds: modules, addedModuleId: str(item.addedModuleId, `${at}.addedModuleId`, ARRAY_MODULES) };
  });
  const policy = obj(raw.explorationPolicy, 'feedbackPack.explorationPolicy');
  keys(policy, ['id', 'topK', 'tieBreak', 'continueAfterNonImprovingValidNode', 'requiresVerifiedDevelopmentResult', 'failedOrNonFiniteNodesMayParent', 'testAccess'], 'feedbackPack.explorationPolicy');
  if (JSON.stringify(policy.tieBreak) !== JSON.stringify(['primaryMetricDirection', 'actualExecutionMs', 'nodeId']) ||
      policy.continueAfterNonImprovingValidNode !== true || policy.requiresVerifiedDevelopmentResult !== true ||
      policy.failedOrNonFiniteNodesMayParent !== false || policy.testAccess !== 'forbidden') {
    throw new SearchError('POLICY_DENIED', 'feedbackPack exploration policy weakens the frozen parent or split constraints');
  }
  const usage = obj(raw.usage, 'feedbackPack.usage');
  keys(usage, ['proposalAttempts', 'maxProposalAttempts', 'modelCalls', 'maxModelCalls', 'totalTokens', 'maxTotalTokens'], 'feedbackPack.usage');
  const parsedUsage = {
    proposalAttempts: int(usage.proposalAttempts, 'feedbackPack.usage.proposalAttempts'),
    maxProposalAttempts: int(usage.maxProposalAttempts, 'feedbackPack.usage.maxProposalAttempts'),
    modelCalls: int(usage.modelCalls, 'feedbackPack.usage.modelCalls'),
    maxModelCalls: int(usage.maxModelCalls, 'feedbackPack.usage.maxModelCalls'),
    totalTokens: int(usage.totalTokens, 'feedbackPack.usage.totalTokens'),
    maxTotalTokens: int(usage.maxTotalTokens, 'feedbackPack.usage.maxTotalTokens'),
  };
  if (parsedUsage.proposalAttempts > parsedUsage.maxProposalAttempts || parsedUsage.modelCalls > parsedUsage.maxModelCalls || parsedUsage.totalTokens > parsedUsage.maxTotalTokens) {
    throw new SearchError('BUDGET_EXHAUSTED', 'feedbackPack records usage above a frozen budget limit');
  }
  return {
    ...common, kind: 'feedback_pack', scope: 'development', primaryMetricId: str(raw.primaryMetricId, 'feedbackPack.primaryMetricId', ID),
    metricDenominator, eligibleParents, excludedNodes, legalNextPrefixes,
    explorationPolicy: {
      id: str(policy.id, 'feedbackPack.explorationPolicy.id', ID), topK: int(policy.topK, 'feedbackPack.explorationPolicy.topK', 1),
      tieBreak: ['primaryMetricDirection', 'actualExecutionMs', 'nodeId'], continueAfterNonImprovingValidNode: true,
      requiresVerifiedDevelopmentResult: true, failedOrNonFiniteNodesMayParent: false, testAccess: 'forbidden',
    }, usage: parsedUsage,
  };
}

function selectionDecision(raw: Record<string, unknown>): SearchSelectionDecision {
  keys(raw, ['schemaVersion', 'kind', 'recordId', 'searchId', 'planRef', 'basisRevision', 'treeHash', 'round', 'feedbackPackRef', 'rankedParents', 'excludedParents', 'selected', 'stopReason'], 'selectionDecision');
  const common = base(raw, 'selection_decision');
  if (!Array.isArray(raw.rankedParents) || !Array.isArray(raw.excludedParents)) throw new SearchError('SCHEMA_VIOLATION', 'selection parent arrays are required');
  const rankedParents = raw.rankedParents.map((entry, index) => {
    const at = `selectionDecision.rankedParents[${index}]`;
    const item = obj(entry, at); keys(item, ['nodeId', 'primaryMetricMean', 'actualExecutionMs', 'costRef'], at);
    return { nodeId: str(item.nodeId, `${at}.nodeId`, ID), primaryMetricMean: finite(item.primaryMetricMean, `${at}.primaryMetricMean`), actualExecutionMs: int(item.actualExecutionMs, `${at}.actualExecutionMs`), costRef: validateSearchArtifactRef(item.costRef, `${at}.costRef`) };
  });
  const excludedParents = raw.excludedParents.map((entry, index) => {
    const at = `selectionDecision.excludedParents[${index}]`;
    const item = obj(entry, at); keys(item, ['nodeId', 'reason'], at);
    return { nodeId: str(item.nodeId, `${at}.nodeId`, ID), reason: str(item.reason, `${at}.reason`) };
  });
  let selected: SearchSelectionDecision['selected'] = null;
  if (raw.selected !== null) {
    const item = obj(raw.selected, 'selectionDecision.selected');
    keys(item, ['parentNodeId', 'candidateId', 'orderedModuleIds', 'addedModuleId', 'selectionReason'], 'selectionDecision.selected');
    if (item.selectionReason !== 'best_verified_parent' && item.selectionReason !== 'continue_after_non_improving_parent') throw new SearchError('SCHEMA_VIOLATION', 'selectionDecision.selected.selectionReason is unsupported');
    selected = {
      parentNodeId: str(item.parentNodeId, 'selectionDecision.selected.parentNodeId', ID), candidateId: str(item.candidateId, 'selectionDecision.selected.candidateId', ID),
      orderedModuleIds: stringList(item.orderedModuleIds, 'selectionDecision.selected.orderedModuleIds', ARRAY_MODULES), addedModuleId: str(item.addedModuleId, 'selectionDecision.selected.addedModuleId', ARRAY_MODULES),
      selectionReason: item.selectionReason,
    };
  }
  if (selected === null && raw.stopReason === null) throw new SearchError('SCHEMA_VIOLATION', 'selectionDecision must select a prefix or state a stop reason');
  if (selected !== null && raw.stopReason !== null) throw new SearchError('SCHEMA_VIOLATION', 'selectionDecision cannot select a prefix and stop at once');
  return {
    ...common, kind: 'selection_decision', feedbackPackRef: validateSearchArtifactRef(raw.feedbackPackRef, 'selectionDecision.feedbackPackRef'),
    rankedParents, excludedParents, selected, stopReason: raw.stopReason === null ? null : str(raw.stopReason, 'selectionDecision.stopReason'),
  };
}

function proposalInput(raw: Record<string, unknown>): SearchProposalInput {
  keys(raw, ['schemaVersion', 'kind', 'recordId', 'searchId', 'planRef', 'basisRevision', 'treeHash', 'round', 'feedbackPackRef', 'selectionDecisionRef', 'envelope', 'inputHash'], 'proposalInput');
  const common = base(raw, 'proposal_input');
  const envelope = obj(raw.envelope, 'proposalInput.envelope');
  keys(envelope, ['taskId', 'scope', 'round', 'primaryMetricId', 'candidateSpace', 'experimentTemplate', 'feedbackPack', 'selectionDecision', 'outputSchema'], 'proposalInput.envelope');
  if (envelope.scope !== 'development' || envelope.outputSchema !== 'append_module_candidate_or_rejection-v1') throw new SearchError('POLICY_DENIED', 'proposal input has an unsupported scope or output contract');
  const parsedPack = feedbackPack(obj(envelope.feedbackPack, 'proposalInput.envelope.feedbackPack'));
  const parsedDecision = selectionDecision(obj(envelope.selectionDecision, 'proposalInput.envelope.selectionDecision'));
  const packRef = validateSearchArtifactRef(raw.feedbackPackRef, 'proposalInput.feedbackPackRef');
  const selectionRef = validateSearchArtifactRef(raw.selectionDecisionRef, 'proposalInput.selectionDecisionRef');
  if (parsedPack.round !== common.round || parsedDecision.round !== common.round || parsedDecision.feedbackPackRef.sha256 !== packRef.sha256) throw new SearchError('SOURCE_MISMATCH', 'proposal input embedded feedback refs or round do not match its envelope');
  const space = obj(envelope.candidateSpace, 'proposalInput.envelope.candidateSpace');
  keys(space, ['slotId', 'orderedModuleIds', 'legalPrefixes', 'forbiddenChanges'], 'proposalInput.envelope.candidateSpace');
  if (!Array.isArray(space.legalPrefixes)) throw new SearchError('SCHEMA_VIOLATION', 'proposal input legal prefixes are required');
  const legalPrefixes = space.legalPrefixes.map((entry, index) => {
    const at = `proposalInput.envelope.candidateSpace.legalPrefixes[${index}]`;
    const item = obj(entry, at); keys(item, ['variantId', 'moduleIds'], at);
    return { variantId: str(item.variantId, `${at}.variantId`, ID), moduleIds: stringList(item.moduleIds, `${at}.moduleIds`, ARRAY_MODULES) };
  });
  const template = obj(envelope.experimentTemplate, 'proposalInput.envelope.experimentTemplate');
  keys(template, ['profileRef', 'dataSubsetRef', 'evaluatorRef', 'pairedSeeds', 'trialLimit', 'testAccess'], 'proposalInput.envelope.experimentTemplate');
  if (template.testAccess !== 'forbidden') throw new SearchError('POLICY_DENIED', 'proposal input cannot include test access');
  const trialLimit = obj(template.trialLimit, 'proposalInput.envelope.experimentTemplate.trialLimit');
  keys(trialLimit, ['kind', 'value'], 'proposalInput.envelope.experimentTemplate.trialLimit');
  if (trialLimit.kind !== 'steps') throw new SearchError('POLICY_DENIED', 'proposal input trial limit must be frozen steps');
  if (!Array.isArray(template.pairedSeeds)) throw new SearchError('SCHEMA_VIOLATION', 'proposal input paired seeds are required');
  const parsedEnvelope: SearchProposalRequestEnvelope = {
    taskId: str(envelope.taskId, 'proposalInput.envelope.taskId', ID), scope: 'development', round: int(envelope.round, 'proposalInput.envelope.round', 1),
    primaryMetricId: str(envelope.primaryMetricId, 'proposalInput.envelope.primaryMetricId', ID),
    candidateSpace: {
      slotId: str(space.slotId, 'proposalInput.envelope.candidateSpace.slotId', ID), orderedModuleIds: stringList(space.orderedModuleIds, 'proposalInput.envelope.candidateSpace.orderedModuleIds', ARRAY_MODULES),
      legalPrefixes, forbiddenChanges: stringList(space.forbiddenChanges, 'proposalInput.envelope.candidateSpace.forbiddenChanges', ID),
    },
    experimentTemplate: {
      profileRef: str(template.profileRef, 'proposalInput.envelope.experimentTemplate.profileRef', PROFILE_REF),
      dataSubsetRef: validateSearchArtifactRef(template.dataSubsetRef, 'proposalInput.envelope.experimentTemplate.dataSubsetRef'),
      evaluatorRef: validateSearchArtifactRef(template.evaluatorRef, 'proposalInput.envelope.experimentTemplate.evaluatorRef'),
      pairedSeeds: template.pairedSeeds.map((seed, index) => int(seed, `proposalInput.envelope.experimentTemplate.pairedSeeds[${index}]`)),
      trialLimit: { kind: 'steps', value: int(trialLimit.value, 'proposalInput.envelope.experimentTemplate.trialLimit.value', 1) }, testAccess: 'forbidden',
    }, feedbackPack: parsedPack, selectionDecision: parsedDecision, outputSchema: 'append_module_candidate_or_rejection-v1',
  };
  const inputHash = str(raw.inputHash, 'proposalInput.inputHash', HEX64);
  if (typedHash('search-proposal-input-v1', parsedEnvelope) !== inputHash) throw new SearchError('SOURCE_MISMATCH', 'proposal input hash does not match its canonical envelope');
  return { ...common, kind: 'proposal_input', feedbackPackRef: packRef, selectionDecisionRef: selectionRef, envelope: parsedEnvelope, inputHash };
}

function proposalReceipt(raw: Record<string, unknown>): SearchProposalReceipt {
  keys(raw, ['schemaVersion', 'kind', 'recordId', 'searchId', 'planRef', 'basisRevision', 'treeHash', 'round', 'proposalInputRef', 'inputHash', 'source', 'provider', 'model', 'route', 'environmentHash', 'callRef', 'actualModelCalls', 'inputTokens', 'outputTokens', 'result'], 'proposalReceipt');
  const common = base(raw, 'proposal_receipt');
  if (raw.source !== 'scripted_fixture' && raw.source !== 'live_model') throw new SearchError('SCHEMA_VIOLATION', 'proposalReceipt.source is unsupported');
  const nullableString = (value: unknown, at: string, pattern?: RegExp): string | null => value === null ? null : str(value, at, pattern);
  const callRef = raw.callRef === null ? null : validateSearchArtifactRef(raw.callRef, 'proposalReceipt.callRef');
  const actualModelCalls = int(raw.actualModelCalls, 'proposalReceipt.actualModelCalls');
  const inputTokens = int(raw.inputTokens, 'proposalReceipt.inputTokens');
  const outputTokens = int(raw.outputTokens, 'proposalReceipt.outputTokens');
  const provider = nullableString(raw.provider, 'proposalReceipt.provider', ID);
  const model = nullableString(raw.model, 'proposalReceipt.model', ID);
  const route = nullableString(raw.route, 'proposalReceipt.route');
  const environmentHash = nullableString(raw.environmentHash, 'proposalReceipt.environmentHash', HEX64);
  if (raw.source === 'scripted_fixture' && (actualModelCalls !== 0 || inputTokens !== 0 || outputTokens !== 0 || callRef !== null || provider !== null || model !== null || route !== null || environmentHash !== null)) {
    throw new SearchError('POLICY_DENIED', 'scripted fixture receipts must record zero live calls, tokens, and route metadata');
  }
  if (raw.source === 'live_model' && (actualModelCalls !== 1 || inputTokens + outputTokens < 1 || callRef === null || provider === null || model === null || route === null || environmentHash === null)) {
    throw new SearchError('SCHEMA_VIOLATION', 'live receipts require one call, token usage, route, environment, and call evidence');
  }
  const resultRaw = obj(raw.result, 'proposalReceipt.result');
  let result: SearchProposalReceipt['result'];
  if (resultRaw.kind === 'candidate') {
    keys(resultRaw, ['kind', 'candidate'], 'proposalReceipt.result');
    const candidate = obj(resultRaw.candidate, 'proposalReceipt.result.candidate');
    keys(candidate, ['parentNodeId', 'candidateId', 'mutationKind', 'slotId', 'orderedModuleIds', 'addedModuleIds', 'hypothesis', 'hypothesisScope'], 'proposalReceipt.result.candidate');
    if (candidate.mutationKind !== 'append_module') throw new SearchError('POLICY_DENIED', 'proposal receipt mutation must append a module');
    result = { kind: 'candidate', candidate: {
      parentNodeId: str(candidate.parentNodeId, 'proposalReceipt.result.candidate.parentNodeId', ID),
      candidateId: str(candidate.candidateId, 'proposalReceipt.result.candidate.candidateId', ID), mutationKind: 'append_module',
      slotId: str(candidate.slotId, 'proposalReceipt.result.candidate.slotId', ID),
      orderedModuleIds: stringList(candidate.orderedModuleIds, 'proposalReceipt.result.candidate.orderedModuleIds', ARRAY_MODULES),
      addedModuleIds: stringList(candidate.addedModuleIds, 'proposalReceipt.result.candidate.addedModuleIds', ARRAY_MODULES),
      hypothesis: str(candidate.hypothesis, 'proposalReceipt.result.candidate.hypothesis'), hypothesisScope: str(candidate.hypothesisScope, 'proposalReceipt.result.candidate.hypothesisScope', ID),
    } };
  } else if (resultRaw.kind === 'rejection') {
    keys(resultRaw, ['kind', 'code', 'message'], 'proposalReceipt.result');
    result = { kind: 'rejection', code: str(resultRaw.code, 'proposalReceipt.result.code', ID), message: str(resultRaw.message, 'proposalReceipt.result.message') };
  } else throw new SearchError('SCHEMA_VIOLATION', 'proposal receipt result kind is unsupported');
  return {
    ...common, kind: 'proposal_receipt', proposalInputRef: validateSearchArtifactRef(raw.proposalInputRef, 'proposalReceipt.proposalInputRef'),
    inputHash: str(raw.inputHash, 'proposalReceipt.inputHash', HEX64), source: raw.source, provider, model, route, environmentHash, callRef,
    actualModelCalls, inputTokens, outputTokens, result,
  };
}

export function validateSearchFeedbackRecord(value: unknown): SearchFeedbackRecord {
  const raw = obj(value, 'searchFeedbackRecord');
  switch (raw.kind) {
    case 'feedback_pack': return feedbackPack(raw);
    case 'selection_decision': return selectionDecision(raw);
    case 'proposal_input': return proposalInput(raw);
    case 'proposal_receipt': return proposalReceipt(raw);
    default: throw new SearchError('SCHEMA_VIOLATION', 'unsupported search feedback record kind');
  }
}

export function searchFeedbackRef(record: SearchFeedbackRecord): ArtifactRef {
  const validated = validateSearchFeedbackRecord(record);
  return { id: `search-evidence/${validated.searchId}/${validated.recordId}`, sha256: typedHash('search-feedback-record-v1', validated) };
}
