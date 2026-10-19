import type { ArtifactRef } from './experiments.ts';

export const SEARCH_SCHEMA_VERSION = 1 as const;
export const SEARCH_SCOPE = 'development' as const;

export const SEARCH_NODE_STATUSES = [
  'proposed', 'adapting', 'checking', 'evaluating', 'eligible', 'rejected', 'failed', 'cancelled', 'interrupted', 'duplicate',
] as const;
export type SearchNodeStatus = (typeof SEARCH_NODE_STATUSES)[number];

export const SEARCH_NODE_KINDS = ['baseline', 'combination', 'repair'] as const;
export type SearchNodeKind = (typeof SEARCH_NODE_KINDS)[number];

export type SearchErrorCode =
  | 'INVALID_INPUT'
  | 'SCHEMA_VIOLATION'
  | 'SOURCE_MISMATCH'
  | 'DEPENDENCY_NOT_READY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'RECONCILIATION_REQUIRED'
  | 'HOST_BUSY'
  | 'BUDGET_EXHAUSTED'
  | 'POLICY_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'INCOMPATIBLE_BINDING';

export class SearchError extends Error {
  readonly code: SearchErrorCode;
  readonly fieldPaths: string[];

  constructor(code: SearchErrorCode, message: string, fieldPaths: string[] = []) {
    super(`[${code}] ${message}`);
    this.name = 'SearchError';
    this.code = code;
    this.fieldPaths = fieldPaths;
  }
}

export interface SearchModulePin {
  moduleId: string;
  implementationSha256: string;
}

export interface SearchLegalPrefix {
  variantId: string;
  moduleIds: string[];
}

export interface SearchMetricSpec {
  id: string;
  direction: 'minimize' | 'maximize';
  unit: string;
  validRange: [number, number];
  split: 'validation';
  aggregation: 'mean';
  evaluatorOutputKey: string;
}

export interface SearchPlan {
  schemaVersion: 1;
  searchId: string;
  planRef: ArtifactRef;
  taskId: string;
  scope: 'development';
  baseline: {
    executableRef: ArtifactRef;
    campaignRef: ArtifactRef;
    runnerResultRef: ArtifactRef;
    costRef: ArtifactRef;
    observations: Array<{
      seed: number;
      metricId: string;
      value: number;
      unit: string;
      split: 'validation';
      verifiedRef: ArtifactRef;
    }>;
  };
  candidateSpace: {
    slotId: string;
    orderedModuleIds: string[];
    modulePins: SearchModulePin[];
    legalPrefixes: SearchLegalPrefix[];
    forbiddenChanges: string[];
  };
  experimentTemplate: {
    profileRef: string;
    dataSubsetRef: ArtifactRef;
    evaluatorRef: ArtifactRef;
    developmentSplits: ['train', 'validation'];
    testAccess: 'forbidden';
    primaryMetricId: string;
    metricSpecs: SearchMetricSpec[];
    pairedSeeds: number[];
    trialLimit: { kind: 'steps'; value: number };
  };
  limits: {
    maxNodes: number;
    maxDepth: number;
    topK: number;
    maxRepairsPerNode: number;
    maxProposalAttempts: number;
    requiredRounds: number;
    stopRule: string;
    searchSeed: number;
    tieBreak: ['primaryMetricDirection', 'actualExecutionMs', 'nodeId'];
    explorationPolicy: {
      id: string;
      continueAfterNonImprovingValidNode: boolean;
      requiresVerifiedDevelopmentResult: true;
      maxNonImprovingDepth: number;
      failedOrNonFiniteNodesMayParent: false;
      scope: string;
    };
  };
  rootBudgetRef: ArtifactRef;
  proposalProfile: {
    provider: string;
    maxModelCalls: number;
    maxTotalTokens: number;
    liveRoute: string | null;
    liveProviderBudgetVerified: boolean;
  };
  hashRules: {
    canonicalization: 'canonical-json-v1';
    proposalKeyFields: ['baselineRef', 'parentNodeId', 'orderedModuleIds', 'moduleHashes', 'slotId', 'hypothesisScope'];
    executionKeyFields: ['implementationHash', 'recipeHash', 'recipeModuleIds', 'profileRef', 'dataSubsetRef', 'evaluatorRef', 'pairedSeeds', 'trialLimit', 'primaryMetric'];
  };
}

export interface CandidateDraft {
  schemaVersion: 1;
  candidateId: string;
  parentNodeId: string;
  mutationKind: 'append_module';
  slotId: string;
  orderedModuleIds: string[];
  addedModuleIds: string[];
  hypothesis: string;
  hypothesisScope: string;
  evidenceRefs: ArtifactRef[];
  proposalRef: ArtifactRef | null;
  repairOfNodeId: string | null;
  createdAt: string;
}

export interface SearchMetricValue {
  seed: number;
  metricId: string;
  value: number;
  unit: string;
  split: 'validation';
}

export interface SearchExecutionIdentity {
  implementationHash: string;
  recipeHash: string;
  recipeModuleIds: string[];
  profileRef: string;
  dataSubsetRef: ArtifactRef;
  evaluatorRef: ArtifactRef;
  pairedSeeds: number[];
  trialLimit: { kind: 'steps'; value: number };
  primaryMetric: string;
}

export interface SearchNode {
  schemaVersion: 1;
  searchId: string;
  nodeId: string;
  kind: SearchNodeKind;
  parentNodeId: string | null;
  depth: number;
  round: number;
  status: SearchNodeStatus;
  candidate: CandidateDraft | null;
  proposalKey: string | null;
  executionKey: string | null;
  executionIdentity: SearchExecutionIdentity | null;
  executableRef: ArtifactRef | null;
  phase3OperationId: string | null;
  phase2OperationId: string | null;
  resultRefs: ArtifactRef[];
  costRef: ArtifactRef | null;
  verifierRef: ArtifactRef | null;
  metricValues: SearchMetricValue[];
  duplicateOf: string | null;
  error: { code: string; message: string; diagnosticRef: ArtifactRef | null } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SearchCheckpoint {
  schemaVersion: 1;
  searchId: string;
  revision: number;
  treeHash: string;
  eventHeadHash: string;
  budgetLedgerRef: ArtifactRef;
  createdAt: string;
  checkpointHash: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,239}$/;
const MODULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROFILE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;
const LOWER_VARIANT = /^[a-z]+$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function objectAt(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SearchError('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: string[], at: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new SearchError('SCHEMA_VIOLATION', `${at} contains unknown field "${key}"`, [`${at}.${key}`]);
  for (const key of keys) if (!(key in value)) throw new SearchError('SCHEMA_VIOLATION', `${at}.${key} is required`, [`${at}.${key}`]);
}

function stringAt(value: unknown, at: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) throw new SearchError('SCHEMA_VIOLATION', `${at} must be a trimmed non-empty string`, [at]);
  if (pattern && !pattern.test(value)) throw new SearchError('SCHEMA_VIOLATION', `${at} has an invalid format`, [at]);
  return value;
}

function integerAt(value: unknown, at: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new SearchError('SCHEMA_VIOLATION', `${at} must be a safe integer in [${minimum}, ${maximum}]`, [at]);
  return value as number;
}

function finiteAt(value: unknown, at: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SearchError('SCHEMA_VIOLATION', `${at} must be finite`, [at]);
  return value;
}

function stringArrayAt(value: unknown, at: string, pattern?: RegExp, minimum = 1): string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new SearchError('SCHEMA_VIOLATION', `${at} must contain at least ${minimum} value(s)`, [at]);
  const result = value.map((entry, index) => stringAt(entry, `${at}[${index}]`, pattern));
  if (new Set(result).size !== result.length) throw new SearchError('SCHEMA_VIOLATION', `${at} contains duplicate values`, [at]);
  return result;
}

export function validateSearchArtifactRef(value: unknown, at: string): ArtifactRef {
  const ref = objectAt(value, at);
  exactKeys(ref, ['id', 'sha256'], at);
  return { id: stringAt(ref.id, `${at}.id`, ARTIFACT_ID), sha256: stringAt(ref.sha256, `${at}.sha256`, HEX64) };
}

function validateMetricSpec(value: unknown, at: string): SearchMetricSpec {
  const raw = objectAt(value, at);
  exactKeys(raw, ['id', 'direction', 'unit', 'validRange', 'split', 'aggregation', 'evaluatorOutputKey'], at);
  if (raw.direction !== 'minimize' && raw.direction !== 'maximize') throw new SearchError('SCHEMA_VIOLATION', `${at}.direction is unsupported`);
  if (raw.split !== 'validation' || raw.aggregation !== 'mean') throw new SearchError('POLICY_DENIED', `${at} must use the frozen validation/mean evaluator`);
  if (!Array.isArray(raw.validRange) || raw.validRange.length !== 2) throw new SearchError('SCHEMA_VIOLATION', `${at}.validRange must contain two finite values`);
  const low = finiteAt(raw.validRange[0], `${at}.validRange[0]`);
  const high = finiteAt(raw.validRange[1], `${at}.validRange[1]`);
  if (low > high) throw new SearchError('SCHEMA_VIOLATION', `${at}.validRange lower bound exceeds upper bound`);
  return {
    id: stringAt(raw.id, `${at}.id`, ID),
    direction: raw.direction,
    unit: stringAt(raw.unit, `${at}.unit`),
    validRange: [low, high],
    split: 'validation',
    aggregation: 'mean',
    evaluatorOutputKey: stringAt(raw.evaluatorOutputKey, `${at}.evaluatorOutputKey`, ID),
  };
}

export function validateSearchPlan(value: unknown): SearchPlan {
  const raw = objectAt(value, 'searchPlan');
  exactKeys(raw, ['schemaVersion', 'searchId', 'planRef', 'taskId', 'scope', 'baseline', 'candidateSpace', 'experimentTemplate', 'limits', 'rootBudgetRef', 'proposalProfile', 'hashRules'], 'searchPlan');
  if (raw.schemaVersion !== SEARCH_SCHEMA_VERSION) throw new SearchError('SCHEMA_VIOLATION', 'unsupported searchPlan schemaVersion');
  if (raw.scope !== SEARCH_SCOPE) throw new SearchError('POLICY_DENIED', 'search plans are restricted to development scope');

  const baselineRaw = objectAt(raw.baseline, 'searchPlan.baseline');
  exactKeys(baselineRaw, ['executableRef', 'campaignRef', 'runnerResultRef', 'costRef', 'observations'], 'searchPlan.baseline');
  if (!Array.isArray(baselineRaw.observations) || baselineRaw.observations.length === 0) throw new SearchError('SCHEMA_VIOLATION', 'baseline observations are required');
  const observations = baselineRaw.observations.map((entry, index) => {
    const at = `searchPlan.baseline.observations[${index}]`;
    const observation = objectAt(entry, at);
    exactKeys(observation, ['seed', 'metricId', 'value', 'unit', 'split', 'verifiedRef'], at);
    if (observation.split !== 'validation') throw new SearchError('POLICY_DENIED', `${at}.split must be validation`);
    return {
      seed: integerAt(observation.seed, `${at}.seed`, 0),
      metricId: stringAt(observation.metricId, `${at}.metricId`, ID),
      value: finiteAt(observation.value, `${at}.value`),
      unit: stringAt(observation.unit, `${at}.unit`),
      split: 'validation' as const,
      verifiedRef: validateSearchArtifactRef(observation.verifiedRef, `${at}.verifiedRef`),
    };
  });

  const spaceRaw = objectAt(raw.candidateSpace, 'searchPlan.candidateSpace');
  exactKeys(spaceRaw, ['slotId', 'orderedModuleIds', 'modulePins', 'legalPrefixes', 'forbiddenChanges'], 'searchPlan.candidateSpace');
  const orderedModuleIds = stringArrayAt(spaceRaw.orderedModuleIds, 'searchPlan.candidateSpace.orderedModuleIds', MODULE_ID);
  if (!Array.isArray(spaceRaw.modulePins) || spaceRaw.modulePins.length !== orderedModuleIds.length) throw new SearchError('SCHEMA_VIOLATION', 'modulePins must pin each ordered module exactly once');
  const modulePins = spaceRaw.modulePins.map((entry, index) => {
    const at = `searchPlan.candidateSpace.modulePins[${index}]`;
    const pin = objectAt(entry, at);
    exactKeys(pin, ['moduleId', 'implementationSha256'], at);
    return { moduleId: stringAt(pin.moduleId, `${at}.moduleId`, MODULE_ID), implementationSha256: stringAt(pin.implementationSha256, `${at}.implementationSha256`, HEX64) };
  });
  if (modulePins.some((pin, index) => pin.moduleId !== orderedModuleIds[index])) throw new SearchError('INCOMPATIBLE_BINDING', 'module pins must follow the frozen ordered module list');
  if (!Array.isArray(spaceRaw.legalPrefixes) || spaceRaw.legalPrefixes.length < 1) throw new SearchError('SCHEMA_VIOLATION', 'legalPrefixes must be non-empty');
  const legalPrefixes = spaceRaw.legalPrefixes.map((entry, index) => {
    const at = `searchPlan.candidateSpace.legalPrefixes[${index}]`;
    const prefix = objectAt(entry, at);
    exactKeys(prefix, ['variantId', 'moduleIds'], at);
    const variantId = stringAt(prefix.variantId, `${at}.variantId`, LOWER_VARIANT);
    const moduleIds = stringArrayAt(prefix.moduleIds, `${at}.moduleIds`, MODULE_ID);
    if (variantId.length !== moduleIds.length || moduleIds.length > orderedModuleIds.length || moduleIds.some((id, position) => id !== orderedModuleIds[position])) {
      throw new SearchError('INCOMPATIBLE_BINDING', `${at} is not an exact ordered prefix`);
    }
    return { variantId, moduleIds };
  });
  if (new Set(legalPrefixes.map((prefix) => prefix.variantId)).size !== legalPrefixes.length) throw new SearchError('SCHEMA_VIOLATION', 'legalPrefixes has duplicate variant ids');
  const forbiddenChanges = stringArrayAt(spaceRaw.forbiddenChanges, 'searchPlan.candidateSpace.forbiddenChanges');

  const templateRaw = objectAt(raw.experimentTemplate, 'searchPlan.experimentTemplate');
  exactKeys(templateRaw, ['profileRef', 'dataSubsetRef', 'evaluatorRef', 'developmentSplits', 'testAccess', 'primaryMetricId', 'metricSpecs', 'pairedSeeds', 'trialLimit'], 'searchPlan.experimentTemplate');
  if (templateRaw.testAccess !== 'forbidden') throw new SearchError('POLICY_DENIED', 'search plans may not request final test access');
  if (!Array.isArray(templateRaw.developmentSplits) || templateRaw.developmentSplits.length !== 2 ||
      templateRaw.developmentSplits[0] !== 'train' || templateRaw.developmentSplits[1] !== 'validation') {
    throw new SearchError('POLICY_DENIED', 'development splits must be exactly [train, validation]');
  }
  if (!Array.isArray(templateRaw.metricSpecs) || templateRaw.metricSpecs.length < 1) throw new SearchError('SCHEMA_VIOLATION', 'metricSpecs must be non-empty');
  const metricSpecs = templateRaw.metricSpecs.map((entry, index) => validateMetricSpec(entry, `searchPlan.experimentTemplate.metricSpecs[${index}]`));
  if (new Set(metricSpecs.map((metric) => metric.id)).size !== metricSpecs.length) throw new SearchError('SCHEMA_VIOLATION', 'metricSpecs contains duplicate ids');
  const primaryMetricId = stringAt(templateRaw.primaryMetricId, 'searchPlan.experimentTemplate.primaryMetricId', ID);
  if (!metricSpecs.some((metric) => metric.id === primaryMetricId)) throw new SearchError('SCHEMA_VIOLATION', 'primaryMetricId is not declared in metricSpecs');
  if (!Array.isArray(templateRaw.pairedSeeds) || templateRaw.pairedSeeds.length < 2) throw new SearchError('SCHEMA_VIOLATION', 'at least two paired seeds are required');
  const pairedSeeds = templateRaw.pairedSeeds.map((seed, index) => integerAt(seed, `searchPlan.experimentTemplate.pairedSeeds[${index}]`, 0));
  if (new Set(pairedSeeds).size !== pairedSeeds.length) throw new SearchError('SCHEMA_VIOLATION', 'pairedSeeds contains duplicates');
  const trialLimitRaw = objectAt(templateRaw.trialLimit, 'searchPlan.experimentTemplate.trialLimit');
  exactKeys(trialLimitRaw, ['kind', 'value'], 'searchPlan.experimentTemplate.trialLimit');
  if (trialLimitRaw.kind !== 'steps') throw new SearchError('POLICY_DENIED', 'only the frozen train-step limit is supported');

  const limitsRaw = objectAt(raw.limits, 'searchPlan.limits');
  exactKeys(limitsRaw, ['maxNodes', 'maxDepth', 'topK', 'maxRepairsPerNode', 'maxProposalAttempts', 'requiredRounds', 'stopRule', 'searchSeed', 'tieBreak', 'explorationPolicy'], 'searchPlan.limits');
  const tieBreak = limitsRaw.tieBreak;
  if (JSON.stringify(tieBreak) !== JSON.stringify(['primaryMetricDirection', 'actualExecutionMs', 'nodeId'])) throw new SearchError('POLICY_DENIED', 'tieBreak differs from the frozen deterministic rule');
  const explorationRaw = objectAt(limitsRaw.explorationPolicy, 'searchPlan.limits.explorationPolicy');
  exactKeys(explorationRaw, ['id', 'continueAfterNonImprovingValidNode', 'requiresVerifiedDevelopmentResult', 'maxNonImprovingDepth', 'failedOrNonFiniteNodesMayParent', 'scope'], 'searchPlan.limits.explorationPolicy');
  if (typeof explorationRaw.continueAfterNonImprovingValidNode !== 'boolean' || explorationRaw.requiresVerifiedDevelopmentResult !== true ||
      explorationRaw.failedOrNonFiniteNodesMayParent !== false) throw new SearchError('POLICY_DENIED', 'exploration policy may not waive verified development eligibility');
  const proposalRaw = objectAt(raw.proposalProfile, 'searchPlan.proposalProfile');
  exactKeys(proposalRaw, ['provider', 'maxModelCalls', 'maxTotalTokens', 'liveRoute', 'liveProviderBudgetVerified'], 'searchPlan.proposalProfile');
  if (proposalRaw.liveRoute !== null && typeof proposalRaw.liveRoute !== 'string') throw new SearchError('SCHEMA_VIOLATION', 'proposalProfile.liveRoute must be a string or null');
  if (typeof proposalRaw.liveProviderBudgetVerified !== 'boolean') throw new SearchError('SCHEMA_VIOLATION', 'liveProviderBudgetVerified must be boolean');

  const hashRaw = objectAt(raw.hashRules, 'searchPlan.hashRules');
  exactKeys(hashRaw, ['canonicalization', 'proposalKeyFields', 'executionKeyFields'], 'searchPlan.hashRules');
  const expectedProposalFields = ['baselineRef', 'parentNodeId', 'orderedModuleIds', 'moduleHashes', 'slotId', 'hypothesisScope'];
  const expectedExecutionFields = ['implementationHash', 'recipeHash', 'recipeModuleIds', 'profileRef', 'dataSubsetRef', 'evaluatorRef', 'pairedSeeds', 'trialLimit', 'primaryMetric'];
  if (hashRaw.canonicalization !== 'canonical-json-v1' || JSON.stringify(hashRaw.proposalKeyFields) !== JSON.stringify(expectedProposalFields) ||
      JSON.stringify(hashRaw.executionKeyFields) !== JSON.stringify(expectedExecutionFields)) {
    throw new SearchError('SOURCE_MISMATCH', 'search hash field lists differ from the host-pinned S2 key schema');
  }

  const result: SearchPlan = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    searchId: stringAt(raw.searchId, 'searchPlan.searchId', ID),
    planRef: validateSearchArtifactRef(raw.planRef, 'searchPlan.planRef'),
    taskId: stringAt(raw.taskId, 'searchPlan.taskId', ID),
    scope: SEARCH_SCOPE,
    baseline: {
      executableRef: validateSearchArtifactRef(baselineRaw.executableRef, 'searchPlan.baseline.executableRef'),
      campaignRef: validateSearchArtifactRef(baselineRaw.campaignRef, 'searchPlan.baseline.campaignRef'),
      runnerResultRef: validateSearchArtifactRef(baselineRaw.runnerResultRef, 'searchPlan.baseline.runnerResultRef'),
      costRef: validateSearchArtifactRef(baselineRaw.costRef, 'searchPlan.baseline.costRef'),
      observations,
    },
    candidateSpace: {
      slotId: stringAt(spaceRaw.slotId, 'searchPlan.candidateSpace.slotId', ID),
      orderedModuleIds,
      modulePins,
      legalPrefixes,
      forbiddenChanges,
    },
    experimentTemplate: {
      profileRef: stringAt(templateRaw.profileRef, 'searchPlan.experimentTemplate.profileRef', PROFILE_REF),
      dataSubsetRef: validateSearchArtifactRef(templateRaw.dataSubsetRef, 'searchPlan.experimentTemplate.dataSubsetRef'),
      evaluatorRef: validateSearchArtifactRef(templateRaw.evaluatorRef, 'searchPlan.experimentTemplate.evaluatorRef'),
      developmentSplits: ['train', 'validation'],
      testAccess: 'forbidden',
      primaryMetricId,
      metricSpecs,
      pairedSeeds,
      trialLimit: { kind: 'steps', value: integerAt(trialLimitRaw.value, 'searchPlan.experimentTemplate.trialLimit.value', 1) },
    },
    limits: {
      maxNodes: integerAt(limitsRaw.maxNodes, 'searchPlan.limits.maxNodes', 1),
      maxDepth: integerAt(limitsRaw.maxDepth, 'searchPlan.limits.maxDepth', 1),
      topK: integerAt(limitsRaw.topK, 'searchPlan.limits.topK', 1),
      maxRepairsPerNode: integerAt(limitsRaw.maxRepairsPerNode, 'searchPlan.limits.maxRepairsPerNode', 0),
      maxProposalAttempts: integerAt(limitsRaw.maxProposalAttempts, 'searchPlan.limits.maxProposalAttempts', 1),
      requiredRounds: integerAt(limitsRaw.requiredRounds, 'searchPlan.limits.requiredRounds', 1),
      stopRule: stringAt(limitsRaw.stopRule, 'searchPlan.limits.stopRule', ID),
      searchSeed: integerAt(limitsRaw.searchSeed, 'searchPlan.limits.searchSeed', 0),
      tieBreak: ['primaryMetricDirection', 'actualExecutionMs', 'nodeId'],
      explorationPolicy: {
        id: stringAt(explorationRaw.id, 'searchPlan.limits.explorationPolicy.id', ID),
        continueAfterNonImprovingValidNode: explorationRaw.continueAfterNonImprovingValidNode,
        requiresVerifiedDevelopmentResult: true,
        maxNonImprovingDepth: integerAt(explorationRaw.maxNonImprovingDepth, 'searchPlan.limits.explorationPolicy.maxNonImprovingDepth', 0),
        failedOrNonFiniteNodesMayParent: false,
        scope: stringAt(explorationRaw.scope, 'searchPlan.limits.explorationPolicy.scope'),
      },
    },
    rootBudgetRef: validateSearchArtifactRef(raw.rootBudgetRef, 'searchPlan.rootBudgetRef'),
    proposalProfile: {
      provider: stringAt(proposalRaw.provider, 'searchPlan.proposalProfile.provider', ID),
      maxModelCalls: integerAt(proposalRaw.maxModelCalls, 'searchPlan.proposalProfile.maxModelCalls', 0),
      maxTotalTokens: integerAt(proposalRaw.maxTotalTokens, 'searchPlan.proposalProfile.maxTotalTokens', 0),
      liveRoute: proposalRaw.liveRoute as string | null,
      liveProviderBudgetVerified: proposalRaw.liveProviderBudgetVerified,
    },
    hashRules: {
      canonicalization: 'canonical-json-v1',
      proposalKeyFields: expectedProposalFields as SearchPlan['hashRules']['proposalKeyFields'],
      executionKeyFields: expectedExecutionFields as SearchPlan['hashRules']['executionKeyFields'],
    },
  };
  if (result.limits.maxNodes < result.candidateSpace.legalPrefixes.length + 1 || result.limits.maxDepth > result.limits.maxNodes - 1) {
    throw new SearchError('SCHEMA_VIOLATION', 'search limits cannot contain the baseline and every frozen candidate depth');
  }
  if (result.limits.maxDepth > result.candidateSpace.orderedModuleIds.length) throw new SearchError('SCHEMA_VIOLATION', 'maxDepth exceeds the finite ordered module space');
  if (result.limits.requiredRounds > result.limits.maxDepth) throw new SearchError('SCHEMA_VIOLATION', 'requiredRounds exceeds maxDepth');
  const expectedBaselinePairs = new Set<string>();
  for (const seed of result.experimentTemplate.pairedSeeds) {
    for (const metric of result.experimentTemplate.metricSpecs) expectedBaselinePairs.add(`${seed}\u0000${metric.id}`);
  }
  const seenBaselinePairs = new Set<string>();
  for (const observation of result.baseline.observations) {
    const metric = result.experimentTemplate.metricSpecs.find((item) => item.id === observation.metricId);
    const key = `${observation.seed}\u0000${observation.metricId}`;
    if (!metric || !expectedBaselinePairs.has(key) || seenBaselinePairs.has(key) || observation.unit !== metric.unit ||
        observation.value < metric.validRange[0] || observation.value > metric.validRange[1]) {
      throw new SearchError('SCHEMA_VIOLATION', 'baseline evidence has an unknown, duplicate, or out-of-range seed/metric value');
    }
    seenBaselinePairs.add(key);
  }
  if (seenBaselinePairs.size !== expectedBaselinePairs.size) {
    throw new SearchError('SCHEMA_VIOLATION', 'baseline evidence must cover every frozen metric for every paired seed');
  }
  return result;
}

export function validateCandidateDraft(value: unknown): CandidateDraft {
  const raw = objectAt(value, 'candidateDraft');
  exactKeys(raw, ['schemaVersion', 'candidateId', 'parentNodeId', 'mutationKind', 'slotId', 'orderedModuleIds', 'addedModuleIds', 'hypothesis', 'hypothesisScope', 'evidenceRefs', 'proposalRef', 'repairOfNodeId', 'createdAt'], 'candidateDraft');
  if (raw.schemaVersion !== SEARCH_SCHEMA_VERSION || raw.mutationKind !== 'append_module') throw new SearchError('SCHEMA_VIOLATION', 'candidateDraft schemaVersion or mutationKind is unsupported');
  if (raw.proposalRef !== null && (typeof raw.proposalRef !== 'object' || Array.isArray(raw.proposalRef))) throw new SearchError('SCHEMA_VIOLATION', 'proposalRef must be an ArtifactRef or null');
  if (raw.repairOfNodeId !== null && (typeof raw.repairOfNodeId !== 'string' || !ID.test(raw.repairOfNodeId))) throw new SearchError('SCHEMA_VIOLATION', 'repairOfNodeId must be an id or null');
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length === 0) throw new SearchError('SCHEMA_VIOLATION', 'candidate evidenceRefs must be non-empty');
  const addedModuleIds = stringArrayAt(raw.addedModuleIds, 'candidateDraft.addedModuleIds', MODULE_ID);
  if (addedModuleIds.length !== 1) throw new SearchError('POLICY_DENIED', 'the finite S2 search only appends one ordered module per node');
  const createdAt = stringAt(raw.createdAt, 'candidateDraft.createdAt', ISO_UTC);
  if (!Number.isFinite(Date.parse(createdAt))) throw new SearchError('SCHEMA_VIOLATION', 'createdAt is not a valid UTC timestamp');
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    candidateId: stringAt(raw.candidateId, 'candidateDraft.candidateId', LOWER_VARIANT),
    parentNodeId: stringAt(raw.parentNodeId, 'candidateDraft.parentNodeId', ID),
    mutationKind: 'append_module',
    slotId: stringAt(raw.slotId, 'candidateDraft.slotId', ID),
    orderedModuleIds: stringArrayAt(raw.orderedModuleIds, 'candidateDraft.orderedModuleIds', MODULE_ID),
    addedModuleIds,
    hypothesis: stringAt(raw.hypothesis, 'candidateDraft.hypothesis'),
    hypothesisScope: stringAt(raw.hypothesisScope, 'candidateDraft.hypothesisScope', ID),
    evidenceRefs: raw.evidenceRefs.map((ref, index) => validateSearchArtifactRef(ref, `candidateDraft.evidenceRefs[${index}]`)),
    proposalRef: raw.proposalRef === null ? null : validateSearchArtifactRef(raw.proposalRef, 'candidateDraft.proposalRef'),
    repairOfNodeId: raw.repairOfNodeId as string | null,
    createdAt,
  };
}

export function validateSearchNode(value: unknown): SearchNode {
  const raw = objectAt(value, 'searchNode');
  exactKeys(raw, ['schemaVersion', 'searchId', 'nodeId', 'kind', 'parentNodeId', 'depth', 'round', 'status', 'candidate', 'proposalKey', 'executionKey', 'executionIdentity', 'executableRef', 'phase3OperationId', 'phase2OperationId', 'resultRefs', 'costRef', 'verifierRef', 'metricValues', 'duplicateOf', 'error', 'createdAt', 'updatedAt'], 'searchNode');
  if (raw.schemaVersion !== SEARCH_SCHEMA_VERSION || !SEARCH_NODE_KINDS.includes(raw.kind as SearchNodeKind) || !SEARCH_NODE_STATUSES.includes(raw.status as SearchNodeStatus)) {
    throw new SearchError('SCHEMA_VIOLATION', 'searchNode schemaVersion, kind or status is unsupported');
  }
  const nullableId = (value: unknown, at: string): string | null => value === null ? null : stringAt(value, at, ID);
  const nullableRef = (value: unknown, at: string): ArtifactRef | null => value === null ? null : validateSearchArtifactRef(value, at);
  const nullableKey = (value: unknown, at: string): string | null => value === null ? null : stringAt(value, at, HEX64);
  const candidate = raw.candidate === null ? null : validateCandidateDraft(raw.candidate);
  const executionIdentity = raw.executionIdentity === null ? null : (() => {
    const identity = objectAt(raw.executionIdentity, 'searchNode.executionIdentity');
    exactKeys(identity, ['implementationHash', 'recipeHash', 'recipeModuleIds', 'profileRef', 'dataSubsetRef', 'evaluatorRef', 'pairedSeeds', 'trialLimit', 'primaryMetric'], 'searchNode.executionIdentity');
    const trialLimit = objectAt(identity.trialLimit, 'searchNode.executionIdentity.trialLimit');
    exactKeys(trialLimit, ['kind', 'value'], 'searchNode.executionIdentity.trialLimit');
    if (trialLimit.kind !== 'steps') throw new SearchError('POLICY_DENIED', 'execution identity must use frozen step limits');
    if (!Array.isArray(identity.pairedSeeds)) throw new SearchError('SCHEMA_VIOLATION', 'execution identity pairedSeeds must be an array');
    const pairedSeeds = identity.pairedSeeds.map((seed, index) => integerAt(seed, `searchNode.executionIdentity.pairedSeeds[${index}]`, 0));
    if (new Set(pairedSeeds).size !== pairedSeeds.length) throw new SearchError('SCHEMA_VIOLATION', 'execution identity pairedSeeds contains duplicates');
    return {
      implementationHash: stringAt(identity.implementationHash, 'searchNode.executionIdentity.implementationHash', HEX64),
      recipeHash: stringAt(identity.recipeHash, 'searchNode.executionIdentity.recipeHash', HEX64),
      recipeModuleIds: stringArrayAt(identity.recipeModuleIds, 'searchNode.executionIdentity.recipeModuleIds', MODULE_ID, 0),
      profileRef: stringAt(identity.profileRef, 'searchNode.executionIdentity.profileRef', PROFILE_REF),
      dataSubsetRef: validateSearchArtifactRef(identity.dataSubsetRef, 'searchNode.executionIdentity.dataSubsetRef'),
      evaluatorRef: validateSearchArtifactRef(identity.evaluatorRef, 'searchNode.executionIdentity.evaluatorRef'),
      pairedSeeds,
      trialLimit: { kind: 'steps' as const, value: integerAt(trialLimit.value, 'searchNode.executionIdentity.trialLimit.value', 1) },
      primaryMetric: stringAt(identity.primaryMetric, 'searchNode.executionIdentity.primaryMetric', ID),
    };
  })();
  if ((raw.kind === 'baseline') !== (candidate === null) || (raw.kind === 'baseline') !== (raw.parentNodeId === null)) {
    throw new SearchError('SCHEMA_VIOLATION', 'baseline node must be the only node without a candidate or parent');
  }
  if (!Array.isArray(raw.resultRefs) || !Array.isArray(raw.metricValues)) throw new SearchError('SCHEMA_VIOLATION', 'resultRefs and metricValues must be arrays');
  const metricValues = raw.metricValues.map((entry, index) => {
    const at = `searchNode.metricValues[${index}]`;
    const metric = objectAt(entry, at);
    exactKeys(metric, ['seed', 'metricId', 'value', 'unit', 'split'], at);
    if (metric.split !== 'validation') throw new SearchError('POLICY_DENIED', `${at}.split must be validation`);
    return { seed: integerAt(metric.seed, `${at}.seed`, 0), metricId: stringAt(metric.metricId, `${at}.metricId`, ID), value: finiteAt(metric.value, `${at}.value`), unit: stringAt(metric.unit, `${at}.unit`), split: 'validation' as const };
  });
  const error = raw.error === null ? null : (() => {
    const item = objectAt(raw.error, 'searchNode.error');
    exactKeys(item, ['code', 'message', 'diagnosticRef'], 'searchNode.error');
    return { code: stringAt(item.code, 'searchNode.error.code', ID), message: stringAt(item.message, 'searchNode.error.message'), diagnosticRef: nullableRef(item.diagnosticRef, 'searchNode.error.diagnosticRef') };
  })();
  const createdAt = stringAt(raw.createdAt, 'searchNode.createdAt', ISO_UTC);
  const updatedAt = stringAt(raw.updatedAt, 'searchNode.updatedAt', ISO_UTC);
  if (!Number.isFinite(Date.parse(createdAt)) || !Number.isFinite(Date.parse(updatedAt))) throw new SearchError('SCHEMA_VIOLATION', 'search node timestamps must be valid UTC timestamps');
  const node: SearchNode = {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    searchId: stringAt(raw.searchId, 'searchNode.searchId', ID),
    nodeId: stringAt(raw.nodeId, 'searchNode.nodeId', ID),
    kind: raw.kind as SearchNodeKind,
    parentNodeId: nullableId(raw.parentNodeId, 'searchNode.parentNodeId'),
    depth: integerAt(raw.depth, 'searchNode.depth', 0),
    round: integerAt(raw.round, 'searchNode.round', 0),
    status: raw.status as SearchNodeStatus,
    candidate,
    proposalKey: nullableKey(raw.proposalKey, 'searchNode.proposalKey'),
    executionKey: nullableKey(raw.executionKey, 'searchNode.executionKey'),
    executionIdentity,
    executableRef: nullableRef(raw.executableRef, 'searchNode.executableRef'),
    phase3OperationId: nullableId(raw.phase3OperationId, 'searchNode.phase3OperationId'),
    phase2OperationId: nullableId(raw.phase2OperationId, 'searchNode.phase2OperationId'),
    resultRefs: raw.resultRefs.map((ref, index) => validateSearchArtifactRef(ref, `searchNode.resultRefs[${index}]`)),
    costRef: nullableRef(raw.costRef, 'searchNode.costRef'),
    verifierRef: nullableRef(raw.verifierRef, 'searchNode.verifierRef'),
    metricValues,
    duplicateOf: nullableId(raw.duplicateOf, 'searchNode.duplicateOf'),
    error,
    createdAt,
    updatedAt,
  };
  if (node.status === 'duplicate' && !node.duplicateOf) throw new SearchError('SCHEMA_VIOLATION', 'duplicate node needs duplicateOf');
  if (node.status === 'eligible' && node.kind !== 'baseline' &&
      (!node.executionKey || !node.executionIdentity || !node.executableRef || !node.phase2OperationId || !node.phase3OperationId || node.resultRefs.length === 0 || !node.costRef || !node.verifierRef || node.metricValues.length === 0)) {
    throw new SearchError('SCHEMA_VIOLATION', 'eligible candidate requires execution, verified results, and cost evidence');
  }
  return node;
}
