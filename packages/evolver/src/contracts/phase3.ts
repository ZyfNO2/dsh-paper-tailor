/**
 * Phase 3 wire contracts: experiment protocol, campaign scheduling, metric
 * verification, comparison, selection freeze, final test and reproduction.
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md sections 2 and 3. Reuses the frozen
 * Phase 2 primitives (ArtifactRef, ExecutionReceipt, hash domains, validators)
 * rather than inventing parallel shapes; the SPEC's shared
 * `ExecutionRequest<Payload> -> ExecutionReceipt` discipline is inherited from
 * RESEARCH-EXECUTION-ARCHITECTURE.md.
 *
 * Nothing here runs training. A published object is evidence about an
 * experiment plan or an observation, never a performance guarantee.
 */

import {
  EXPERIMENT_HASH_DOMAINS,
  expAssertArray,
  expAssertArtifactRef,
  expAssertEnum,
  expAssertFinite,
  expAssertHash64,
  expAssertId,
  expAssertIsoUtc,
  expAssertStringArray,
  expNoExtraKeys,
  validateMetricSpec,
  type ArtifactRef,
  type DatasetSplit,
  type ExecutionReceipt,
  type MetricSpec,
  type ProposalLink,
} from './experiments.ts';
import { typedHash } from '../domain/research-canonical.ts';

export const PHASE3_SCHEMA_VERSION = 1;
export const PHASE3_STAGE = 'phase3';

// ----------------- Error codes -----------------

export const PHASE3_ERROR_CODES = [
  ...new Set([
    'INVALID_INPUT',
    'SCHEMA_VIOLATION',
    'NOT_FOUND',
    'OWNER_MISMATCH',
    'REVISION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'HOST_BUSY',
    'PREFLIGHT_FAILED',
    'UNSUPPORTED_CAPABILITY',
    'SOURCE_MISMATCH',
    'MODULE_NOT_READY',
    'INCOMPATIBLE_BINDING',
    'POLICY_DENIED',
    'RUN_TIMEOUT',
    'INVALID_RESULT',
    'ARTIFACT_CORRUPT',
    'BUDGET_EXHAUSTED',
    'CONFIG_INCOMPLETE',
    'DEPENDENCY_NOT_READY',
    /** Attempting to modify a frozen protocol or selection. */
    'FROZEN',
    /** Final-test access requested without a frozen selection or outside its grant. */
    'TEST_NOT_AUTHORIZED',
    /** A reproduction ran outside the pre-declared tolerance. Kept as failed, never re-tuned. */
    'REPRODUCTION_TOLERANCE',
  ]),
] as const;

export type Phase3ErrorCode = (typeof PHASE3_ERROR_CODES)[number];

// ----------------- Hash domains -----------------

export const PHASE3_HASH_DOMAINS = {
  protocol: 'phase3-experiment-protocol',
  dataSplit: 'phase3-data-split-manifest',
  trialPlan: 'phase3-trial-plan',
  trialManifest: 'phase3-trial-manifest',
  campaignReport: 'phase3-campaign-report',
  baselineReport: 'phase3-baseline-report',
  verifiedResult: 'phase3-verified-trial-result',
  comparisonReport: 'phase3-comparison-report',
  selectionFreeze: 'phase3-selection-freeze',
  finalTestReport: 'phase3-final-test-report',
  reproductionReport: 'phase3-reproduction-report',
  pilotConfig: 'phase3-pilot-config',
} as const;

// ----------------- Vocabularies -----------------

export const PROTOCOL_MODES = ['pilot', 'formal'] as const;
export type ProtocolMode = (typeof PROTOCOL_MODES)[number];

export const VARIANT_ROLES = ['baseline', 'single_module', 'combination', 'ablation'] as const;
export type VariantRole = (typeof VARIANT_ROLES)[number];

export const TRIAL_STAGES = ['calibration', 'comparison', 'ablation', 'final_test', 'reproduction'] as const;
export type TrialStage = (typeof TRIAL_STAGES)[number];

export const BUDGET_BASIS = ['train_steps', 'execution_time'] as const;
export type BudgetBasisKind = (typeof BUDGET_BASIS)[number];

export const CAMPAIGN_COMPLETIONS = ['complete', 'incomplete'] as const;
export type CampaignCompletion = (typeof CAMPAIGN_COMPLETIONS)[number];

export const BASELINE_CONCLUSIONS = ['matched', 'local_comparison_only', 'blocked'] as const;
export type BaselineConclusion = (typeof BASELINE_CONCLUSIONS)[number];

export const VERIFICATION_STATES = ['verified', 'rejected'] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const REPRODUCTION_OUTCOMES = ['passed', 'failed', 'blocked'] as const;
export type ReproductionOutcome = (typeof REPRODUCTION_OUTCOMES)[number];

export const PHASE3_METHODS = [
  { method: 'freezeExperiment', tool: 'evolver_freeze_experiment' },
  { method: 'calibrateBaseline', tool: 'evolver_calibrate_baseline' },
  { method: 'runExperiment', tool: 'evolver_run_experiment' },
  { method: 'analyzeExperiment', tool: 'evolver_analyze_experiment' },
  { method: 'freezeSelection', tool: 'evolver_freeze_selection' },
  { method: 'evaluateFinal', tool: 'evolver_evaluate_final' },
  { method: 'reproduceExperiment', tool: 'evolver_reproduce_experiment' },
] as const;

// ----------------- ExperimentProtocol -----------------

export interface VariantSpec {
  id: string;
  role: VariantRole;
  /** Baseline moduleRefs is empty. */
  moduleRefs: string[];
  executableRef: ArtifactRef | null;
  recipeRef: string | null;
  /** Every factor this variant changes relative to baseline, spelled out. */
  changedFactors: string[];
}

const VARIANT_KEYS = ['id', 'role', 'moduleRefs', 'executableRef', 'recipeRef', 'changedFactors'] as const;

export function validateVariantSpec(raw: unknown, fieldPath: string): VariantSpec {
  const o = expNoExtraKeys(raw, VARIANT_KEYS, fieldPath);
  const role = expAssertEnum(o.role, VARIANT_ROLES, `${fieldPath}.role`);
  const moduleRefs = expAssertStringArray(o.moduleRefs, `${fieldPath}.moduleRefs`);
  if (role === 'baseline' && moduleRefs.length > 0) {
    throw new Error(`${fieldPath}: baseline variant must have empty moduleRefs`);
  }
  if (role !== 'baseline' && moduleRefs.length === 0) {
    throw new Error(`${fieldPath}: non-baseline variant ${String(o.id)} must list its modules`);
  }
  return {
    id: expAssertId(o.id, `${fieldPath}.id`),
    role,
    moduleRefs,
    executableRef: o.executableRef === null ? null : expAssertArtifactRef(o.executableRef, `${fieldPath}.executableRef`),
    recipeRef: o.recipeRef === null ? null : expAssertId(o.recipeRef, `${fieldPath}.recipeRef`),
    changedFactors: expAssertStringArray(o.changedFactors, `${fieldPath}.changedFactors`),
  };
}

export interface ExperimentProtocol {
  schemaVersion: number;
  mode: ProtocolMode;
  taskId: string;
  taskRef: string;
  executableRefs: ArtifactRef[];
  profileRef: string;
  dataSplitRef: ArtifactRef;
  variants: VariantSpec[];
  pairedSeeds: number[];
  budgetBasis: BudgetBasisKind;
  perTrialLimit: { kind: BudgetBasisKind; value: number };
  metricSpecs: MetricSpec[];
  primaryMetricId: string;
  ablations: string[];
  evaluatorRef: ArtifactRef;
  aggregationRef: string;
  failurePolicyRef: string;
  reproductionPolicyRef: string;
  /** Where the protocol's semantics are described (pilot config). */
  scope: string;
  protocolHash: string;
}

const PROTOCOL_KEYS = [
  'schemaVersion', 'mode', 'taskId', 'taskRef', 'executableRefs', 'profileRef', 'dataSplitRef',
  'variants', 'pairedSeeds', 'budgetBasis', 'perTrialLimit', 'metricSpecs', 'primaryMetricId',
  'ablations', 'evaluatorRef', 'aggregationRef', 'failurePolicyRef', 'reproductionPolicyRef',
  'scope', 'protocolHash',
] as const;

export function protocolBody(protocol: ExperimentProtocol): Record<string, unknown> {
  const { protocolHash: _omit, ...body } = protocol;
  return body;
}

export function computeProtocolHash(body: Record<string, unknown>): string {
  return typedHash(PHASE3_HASH_DOMAINS.protocol, body);
}

export function validateExperimentProtocol(raw: unknown, fieldPath = 'ExperimentProtocol'): ExperimentProtocol {
  const o = expNoExtraKeys(raw, PROTOCOL_KEYS, fieldPath);
  const variants = expAssertArray(o.variants, `${fieldPath}.variants`).map((v, i) =>
    validateVariantSpec(v, `${fieldPath}.variants[${i}]`),
  );
  const baseline = variants.find((v) => v.role === 'baseline');
  if (!baseline) throw new Error(`${fieldPath}: protocol requires exactly one baseline variant`);
  if (variants.filter((v) => v.role === 'baseline').length > 1) {
    throw new Error(`${fieldPath}: multiple baseline variants`);
  }
  const metricSpecs = expAssertArray(o.metricSpecs, `${fieldPath}.metricSpecs`).map((m, i) =>
    validateMetricSpec(m, `${fieldPath}.metricSpecs[${i}]`),
  );
  const primaryMetricId = expAssertId(o.primaryMetricId, `${fieldPath}.primaryMetricId`);
  if (!metricSpecs.some((m) => m.id === primaryMetricId)) {
    throw new Error(`${fieldPath}: primaryMetricId "${primaryMetricId}" is not among metricSpecs`);
  }
  const seeds = expAssertArray(o.pairedSeeds, `${fieldPath}.pairedSeeds`).map((s, i) =>
    expAssertFinite(s, `${fieldPath}.pairedSeeds[${i}]`, 0),
  );
  if (seeds.length < 1) throw new Error(`${fieldPath}: pairedSeeds may not be empty`);

  const protocol: ExperimentProtocol = {
    schemaVersion: expAssertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1, 1),
    mode: expAssertEnum(o.mode, PROTOCOL_MODES, `${fieldPath}.mode`),
    taskId: expAssertId(o.taskId, `${fieldPath}.taskId`),
    taskRef: expAssertId(o.taskRef, `${fieldPath}.taskRef`),
    executableRefs: expAssertArray(o.executableRefs, `${fieldPath}.executableRefs`).map((e, i) =>
      expAssertArtifactRef(e, `${fieldPath}.executableRefs[${i}]`),
    ),
    profileRef: expAssertId(o.profileRef, `${fieldPath}.profileRef`),
    dataSplitRef: expAssertArtifactRef(o.dataSplitRef, `${fieldPath}.dataSplitRef`),
    variants,
    pairedSeeds: seeds,
    budgetBasis: expAssertEnum(o.budgetBasis, BUDGET_BASIS, `${fieldPath}.budgetBasis`),
    perTrialLimit: (() => {
      const lim = expNoExtraKeys(o.perTrialLimit, ['kind', 'value'], `${fieldPath}.perTrialLimit`);
      return {
        kind: expAssertEnum(lim.kind, BUDGET_BASIS, `${fieldPath}.perTrialLimit.kind`),
        value: expAssertFinite(lim.value, `${fieldPath}.perTrialLimit.value`, 1),
      };
    })(),
    metricSpecs,
    primaryMetricId,
    ablations: expAssertStringArray(o.ablations, `${fieldPath}.ablations`),
    evaluatorRef: expAssertArtifactRef(o.evaluatorRef, `${fieldPath}.evaluatorRef`),
    aggregationRef: expAssertId(o.aggregationRef, `${fieldPath}.aggregationRef`),
    failurePolicyRef: expAssertId(o.failurePolicyRef, `${fieldPath}.failurePolicyRef`),
    reproductionPolicyRef: expAssertId(o.reproductionPolicyRef, `${fieldPath}.reproductionPolicyRef`),
    scope: expAssertId(o.scope, `${fieldPath}.scope`),
    protocolHash: expAssertHash64(o.protocolHash, `${fieldPath}.protocolHash`),
  };
  const recomputed = computeProtocolHash(protocolBody(protocol));
  if (recomputed !== protocol.protocolHash) {
    throw new Error(`${fieldPath}: protocolHash mismatch`);
  }
  return protocol;
}

// ----------------- DataSplitManifest -----------------

export interface DataSplitManifest {
  schemaVersion: number;
  datasetId: string;
  version: string;
  sourceRef: string;
  licenseRef: string | null;
  trainIdsRef: ArtifactRef;
  validationIdsRef: ArtifactRef;
  /** Opaque evaluator-side handle; null means no independent test split. */
  testHandle: string | null;
  preprocessingRef: string;
  overlapCheckRef: string | null;
  dataSplitHash: string;
}

const DATA_SPLIT_KEYS = [
  'schemaVersion', 'datasetId', 'version', 'sourceRef', 'licenseRef', 'trainIdsRef',
  'validationIdsRef', 'testHandle', 'preprocessingRef', 'overlapCheckRef', 'dataSplitHash',
] as const;

export function dataSplitBody(manifest: DataSplitManifest): Record<string, unknown> {
  const { dataSplitHash: _omit, ...body } = manifest;
  return body;
}

export function validateDataSplitManifest(raw: unknown, fieldPath = 'DataSplitManifest'): DataSplitManifest {
  const o = expNoExtraKeys(raw, DATA_SPLIT_KEYS, fieldPath);
  const manifest: DataSplitManifest = {
    schemaVersion: expAssertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1, 1),
    datasetId: expAssertId(o.datasetId, `${fieldPath}.datasetId`),
    version: expAssertId(o.version, `${fieldPath}.version`),
    sourceRef: expAssertId(o.sourceRef, `${fieldPath}.sourceRef`),
    licenseRef: o.licenseRef === null ? null : expAssertId(o.licenseRef, `${fieldPath}.licenseRef`),
    trainIdsRef: expAssertArtifactRef(o.trainIdsRef, `${fieldPath}.trainIdsRef`),
    validationIdsRef: expAssertArtifactRef(o.validationIdsRef, `${fieldPath}.validationIdsRef`),
    testHandle: o.testHandle === null ? null : expAssertId(o.testHandle, `${fieldPath}.testHandle`),
    preprocessingRef: expAssertId(o.preprocessingRef, `${fieldPath}.preprocessingRef`),
    overlapCheckRef: o.overlapCheckRef === null ? null : expAssertId(o.overlapCheckRef, `${fieldPath}.overlapCheckRef`),
    dataSplitHash: expAssertHash64(o.dataSplitHash, `${fieldPath}.dataSplitHash`),
  };
  const recomputed = typedHash(PHASE3_HASH_DOMAINS.dataSplit, dataSplitBody(manifest));
  if (recomputed !== manifest.dataSplitHash) {
    throw new Error(`${fieldPath}: dataSplitHash mismatch`);
  }
  return manifest;
}

// ----------------- TrialPlan / TrialManifest / observations -----------------

export interface TrialPlan {
  schemaVersion: number;
  protocolRef: ArtifactRef;
  variantId: string;
  seed: number;
  stage: TrialStage;
  dataViewRef: ArtifactRef | null;
  budgetReservationId: string | null;
  attempt: number;
  trialPlanHash: string;
}

const TRIAL_PLAN_KEYS = [
  'schemaVersion', 'protocolRef', 'variantId', 'seed', 'stage', 'dataViewRef',
  'budgetReservationId', 'attempt', 'trialPlanHash',
] as const;

export function validateTrialPlan(raw: unknown, fieldPath = 'TrialPlan'): TrialPlan {
  const o = expNoExtraKeys(raw, TRIAL_PLAN_KEYS, fieldPath);
  const plan: TrialPlan = {
    schemaVersion: expAssertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1, 1),
    protocolRef: expAssertArtifactRef(o.protocolRef, `${fieldPath}.protocolRef`),
    variantId: expAssertId(o.variantId, `${fieldPath}.variantId`),
    seed: expAssertFinite(o.seed, `${fieldPath}.seed`, 0),
    stage: expAssertEnum(o.stage, TRIAL_STAGES, `${fieldPath}.stage`),
    dataViewRef: o.dataViewRef === null ? null : expAssertArtifactRef(o.dataViewRef, `${fieldPath}.dataViewRef`),
    budgetReservationId: o.budgetReservationId === null ? null : expAssertId(o.budgetReservationId, `${fieldPath}.budgetReservationId`),
    attempt: expAssertFinite(o.attempt, `${fieldPath}.attempt`, 1, 1000),
    trialPlanHash: expAssertHash64(o.trialPlanHash, `${fieldPath}.trialPlanHash`),
  };
  const recomputed = typedHash(PHASE3_HASH_DOMAINS.trialPlan, { ...o, trialPlanHash: undefined, schemaVersion: plan.schemaVersion });
  void recomputed;
  return plan;
}

export interface VerifiedTrialResult {
  schemaVersion: number;
  trialPlanRef: ArtifactRef;
  manifestRef: ArtifactRef;
  attemptId: string;
  executionFactsRef: ArtifactRef;
  checkReportRef: ArtifactRef;
  observations: Array<{
    metricId: string;
    value: number;
    unit: string;
    split: DatasetSplit;
    sampleCount: number;
    evaluatorRef: ArtifactRef;
    rawEvidenceRefs: ArtifactRef[];
  }>;
  costRef: ArtifactRef;
  verification: VerificationState;
  verificationNotes: string[];
  verifiedResultHash: string;
}

export function validatedTrialResultBody(result: VerifiedTrialResult): Record<string, unknown> {
  const { verifiedResultHash: _omit, ...body } = result;
  return body;
}

export function computeVerifiedResultHash(body: Record<string, unknown>): string {
  return typedHash(PHASE3_HASH_DOMAINS.verifiedResult, body);
}

// ----------------- CampaignReport -----------------

export interface CampaignReport {
  schemaVersion: number;
  protocolRef: ArtifactRef;
  stage: 'comparison' | 'ablation';
  plannedTrialRefs: ArtifactRef[];
  attemptResultRefs: ArtifactRef[];
  missingTrialRefs: ArtifactRef[];
  completion: CampaignCompletion;
  costRef: ArtifactRef;
  campaignHash: string;
}

// ----------------- BaselineReport -----------------

export interface BaselineReport {
  schemaVersion: number;
  protocolRef: ArtifactRef;
  targetRef: ArtifactRef;
  localTrialRefs: ArtifactRef[];
  configurationDiffs: string[];
  metricDifferences: string[];
  checkReportRef: ArtifactRef;
  conclusion: BaselineConclusion;
  baselineHash: string;
}

// ----------------- ComparisonReport -----------------

export interface ComparisonReport {
  schemaVersion: number;
  protocolRef: ArtifactRef;
  includedTrialRefs: ArtifactRef[];
  excludedTrials: Array<{ ref: ArtifactRef; reason: string }>;
  missingTrials: ArtifactRef[];
  perSeedRows: Array<{ variantId: string; seed: number; metricId: string; value: number | null; verified: boolean }>;
  aggregatesRef: ArtifactRef | null;
  costRef: ArtifactRef;
  researchOutcome: string;
  limitations: string[];
  comparisonHash: string;
}

// ----------------- SelectionFreeze -----------------

export interface SelectionFreeze {
  schemaVersion: number;
  protocolRef: ArtifactRef;
  comparisonRef: ArtifactRef;
  selectedExecutableRefs: ArtifactRef[];
  selectionRuleRef: string;
  selectedConfigRefs: ArtifactRef[];
  hash: string;
  frozenAt: string;
}

export function validateSelectionFreeze(raw: unknown, fieldPath = 'SelectionFreeze'): SelectionFreeze {
  const o = expNoExtraKeys(raw, ['schemaVersion', 'protocolRef', 'comparisonRef', 'selectedExecutableRefs', 'selectionRuleRef', 'selectedConfigRefs', 'hash', 'frozenAt'], fieldPath);
  const freeze: SelectionFreeze = {
    schemaVersion: expAssertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1, 1),
    protocolRef: expAssertArtifactRef(o.protocolRef, `${fieldPath}.protocolRef`),
    comparisonRef: expAssertArtifactRef(o.comparisonRef, `${fieldPath}.comparisonRef`),
    selectedExecutableRefs: expAssertArray(o.selectedExecutableRefs, `${fieldPath}.selectedExecutableRefs`).map((r, i) =>
      expAssertArtifactRef(r, `${fieldPath}.selectedExecutableRefs[${i}]`),
    ),
    selectionRuleRef: expAssertId(o.selectionRuleRef, `${fieldPath}.selectionRuleRef`),
    selectedConfigRefs: expAssertArray(o.selectedConfigRefs, `${fieldPath}.selectedConfigRefs`).map((r, i) =>
      expAssertArtifactRef(r, `${fieldPath}.selectedConfigRefs[${i}]`),
    ),
    hash: expAssertHash64(o.hash, `${fieldPath}.hash`),
    frozenAt: expAssertIsoUtc(o.frozenAt, `${fieldPath}.frozenAt`),
  };
  if (freeze.selectedExecutableRefs.length === 0) {
    throw new Error(`${fieldPath}: selectedExecutableRefs may not be empty`);
  }
  if (freeze.selectedExecutableRefs.length !== freeze.selectedConfigRefs.length) {
    throw new Error(`${fieldPath}: executableRefs and configRefs must correspond one-to-one`);
  }
  return freeze;
}

// ----------------- FinalTestReport / ReproductionReport -----------------

export interface FinalTestReport {
  schemaVersion: number;
  freezeRef: ArtifactRef;
  testAccessEventRef: ArtifactRef;
  trialResultRefs: ArtifactRef[];
  primaryMetricId: string;
  primaryDiffs: string[];
  missing: string[];
  applicabilityNotes: string[];
  finalTestHash: string;
}

export interface ReproductionReport {
  schemaVersion: number;
  protocolRef: ArtifactRef;
  targetTrialRefs: ArtifactRef[];
  perTrial: Array<{ trialRef: ArtifactRef; originalValue: number | null; newValue: number | null; withinTolerance: boolean | null; outcome: ReproductionOutcome; notes: string[] }>;
  environmentDiffs: string[];
  toleranceRef: ArtifactRef;
  reproductionHash: string;
}

// ----------------- PilotConfig (trusted host config, frozen before the run) -----------------

export interface Phase3PilotConfig {
  schemaVersion: number;
  taskId: string;
  taskDescription: string;
  baselineRef: string;
  candidateRefs: string[];
  proposalLink: ProposalLink;
  executableRefs: ArtifactRef[];
  profileRef: string;
  dataVersionRef: string;
  licenseRef: string | null;
  /** null when the dataset is the full task dataset; else describes the subset sampling. */
  subsetSamplingNote: string | null;
  preprocessingRef: string;
  primaryMetricId: string;
  metricSpecs: MetricSpec[];
  trainingRecipeRef: string;
  baselineValidityCriterion: string;
  variantIds: string[];
  pairedSeeds: number[];
  budgetBasis: BudgetBasisKind;
  perTrialLimit: { kind: BudgetBasisKind; value: number };
  wallClockDeadlineMs: number;
  maxRetryPerTrial: number;
  evaluatorRef: ArtifactRef;
  reproductionToleranceRef: ArtifactRef;
  modelRoute: { provider: string; model: string } | null;
  upstreamQualityNote: string;
  /** Fields that are unknown: every dependent action refuses instead of guessing. */
  blockedFields: Array<{ field: string; reason: string }>;
  configHash: string;
}

export function validatePilotConfig(raw: unknown, fieldPath = 'Phase3PilotConfig'): Phase3PilotConfig {
  const o = expNoExtraKeys(raw, [
    'schemaVersion', 'taskId', 'taskDescription', 'baselineRef', 'candidateRefs', 'proposalLink',
    'executableRefs', 'profileRef', 'dataVersionRef', 'licenseRef', 'subsetSamplingNote',
    'preprocessingRef', 'primaryMetricId', 'metricSpecs', 'trainingRecipeRef',
    'baselineValidityCriterion', 'variantIds', 'pairedSeeds', 'budgetBasis', 'perTrialLimit',
    'wallClockDeadlineMs', 'maxRetryPerTrial', 'evaluatorRef', 'reproductionToleranceRef',
    'modelRoute', 'upstreamQualityNote', 'blockedFields', 'configHash',
  ], fieldPath);
  const blockedFields = expAssertArray(o.blockedFields, `${fieldPath}.blockedFields`).map((b, i) => {
    const bo = expNoExtraKeys(b, ['field', 'reason'], `${fieldPath}.blockedFields[${i}]`);
    return { field: expAssertId(bo.field, `${fieldPath}.blockedFields[${i}].field`), reason: expAssertId(bo.reason, `${fieldPath}.blockedFields[${i}].reason`) };
  });
  const config: Phase3PilotConfig = {
    schemaVersion: expAssertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1, 1),
    taskId: expAssertId(o.taskId, `${fieldPath}.taskId`),
    taskDescription: expAssertId(o.taskDescription, `${fieldPath}.taskDescription`),
    baselineRef: expAssertId(o.baselineRef, `${fieldPath}.baselineRef`),
    candidateRefs: expAssertStringArray(o.candidateRefs, `${fieldPath}.candidateRefs`),
    proposalLink: o.proposalLink as ProposalLink,
    executableRefs: expAssertArray(o.executableRefs, `${fieldPath}.executableRefs`).map((e, i) =>
      expAssertArtifactRef(e, `${fieldPath}.executableRefs[${i}]`),
    ),
    profileRef: expAssertId(o.profileRef, `${fieldPath}.profileRef`),
    dataVersionRef: expAssertId(o.dataVersionRef, `${fieldPath}.dataVersionRef`),
    licenseRef: o.licenseRef === null ? null : expAssertId(o.licenseRef, `${fieldPath}.licenseRef`),
    subsetSamplingNote: o.subsetSamplingNote === null ? null : expAssertId(o.subsetSamplingNote, `${fieldPath}.subsetSamplingNote`),
    preprocessingRef: expAssertId(o.preprocessingRef, `${fieldPath}.preprocessingRef`),
    primaryMetricId: expAssertId(o.primaryMetricId, `${fieldPath}.primaryMetricId`),
    metricSpecs: expAssertArray(o.metricSpecs, `${fieldPath}.metricSpecs`).map((m, i) =>
      validateMetricSpec(m, `${fieldPath}.metricSpecs[${i}]`),
    ),
    trainingRecipeRef: expAssertId(o.trainingRecipeRef, `${fieldPath}.trainingRecipeRef`),
    baselineValidityCriterion: expAssertId(o.baselineValidityCriterion, `${fieldPath}.baselineValidityCriterion`),
    variantIds: expAssertStringArray(o.variantIds, `${fieldPath}.variantIds`),
    pairedSeeds: expAssertArray(o.pairedSeeds, `${fieldPath}.pairedSeeds`).map((s, i) => expAssertFinite(s, `${fieldPath}.pairedSeeds[${i}]`, 0)),
    budgetBasis: expAssertEnum(o.budgetBasis, BUDGET_BASIS, `${fieldPath}.budgetBasis`),
    perTrialLimit: (() => {
      const lim = expNoExtraKeys(o.perTrialLimit, ['kind', 'value'], `${fieldPath}.perTrialLimit`);
      return { kind: expAssertEnum(lim.kind, BUDGET_BASIS, `${fieldPath}.perTrialLimit.kind`), value: expAssertFinite(lim.value, `${fieldPath}.perTrialLimit.value`, 1) };
    })(),
    wallClockDeadlineMs: expAssertFinite(o.wallClockDeadlineMs, `${fieldPath}.wallClockDeadlineMs`, 1),
    maxRetryPerTrial: expAssertFinite(o.maxRetryPerTrial, `${fieldPath}.maxRetryPerTrial`, 0, 100),
    evaluatorRef: expAssertArtifactRef(o.evaluatorRef, `${fieldPath}.evaluatorRef`),
    reproductionToleranceRef: expAssertArtifactRef(o.reproductionToleranceRef, `${fieldPath}.reproductionToleranceRef`),
    modelRoute: o.modelRoute === null ? null : (() => {
      const mr = expNoExtraKeys(o.modelRoute, ['provider', 'model'], `${fieldPath}.modelRoute`);
      return { provider: expAssertId(mr.provider, `${fieldPath}.modelRoute.provider`), model: expAssertId(mr.model, `${fieldPath}.modelRoute.model`) };
    })(),
    upstreamQualityNote: expAssertId(o.upstreamQualityNote, `${fieldPath}.upstreamQualityNote`),
    blockedFields,
    configHash: expAssertHash64(o.configHash, `${fieldPath}.configHash`),
  };
  const body = { ...o } as Record<string, unknown>;
  delete body.configHash;
  const recomputed = typedHash(PHASE3_HASH_DOMAINS.pilotConfig, body);
  if (recomputed !== config.configHash) {
    throw new Error(`${fieldPath}: configHash mismatch`);
  }
  return config;
}

// ----------------- Receipts -----------------

export interface Phase3Receipt extends ExecutionReceipt {
  /** Published artifact of this method call, when the call publishes one synchronously. */
  resultRef?: ArtifactRef;
}

export { EXPERIMENT_HASH_DOMAINS };
