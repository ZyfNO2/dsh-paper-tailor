/**
 * Phase 2 wire contracts: source fixing, adaptation, mechanism checks, lightweight runs, and
 * executable registration.
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md. Shared owner/idempotency/budget/publication rules:
 * docs/mvp/RESEARCH-EXECUTION-ARCHITECTURE.md.
 *
 * Deliberately separate from ./research.ts (P5/P6/P7, which must never carry execution-layer
 * fields) and from ./index.ts (the frozen P0-P4 contracts). The three stay parallel: a Phase 2
 * object may name an implementation hash, a research card may not.
 *
 * Nothing here runs training. A published object is evidence about an implementation, never a
 * scientific performance claim.
 */

import { typedHash, sha256Hex } from '../domain/research-canonical.ts';

export const EXPERIMENT_SCHEMA_VERSION = 1;
export const EXPERIMENT_STAGE = 'phase2';

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// ----------------- Error codes -----------------

export const EXPERIMENT_ERROR_CODES = [
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
  'RECONCILIATION_REQUIRED',
  'BUDGET_EXHAUSTED',
  /** A field the run depends on is still unset in the frozen configuration table. */
  'CONFIG_INCOMPLETE',
  /** Repair attempts are used up; the first error is kept instead of retrying forever. */
  'REPAIR_EXHAUSTED',
  'DEPENDENCY_NOT_READY',
] as const;

export type ExperimentErrorCode = (typeof EXPERIMENT_ERROR_CODES)[number];

export class ExperimentError extends Error {
  readonly code: ExperimentErrorCode;
  readonly retryable: boolean;
  readonly fieldPaths: string[];
  readonly diagnosticRef: ArtifactRef | null;

  constructor(
    code: ExperimentErrorCode,
    message: string,
    opts: { retryable?: boolean; fieldPaths?: string[]; diagnosticRef?: ArtifactRef | null } = {}
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ExperimentError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.fieldPaths = opts.fieldPaths ?? [];
    this.diagnosticRef = opts.diagnosticRef ?? null;
  }

  toExecutionError(): ExecutionError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      fieldPaths: this.fieldPaths,
      diagnosticRef: this.diagnosticRef,
    };
  }
}

// ----------------- Vocabularies -----------------

export const EXECUTION_SCOPES = ['development', 'frozen_eval', 'final_test'] as const;
export type ExecutionScope = (typeof EXECUTION_SCOPES)[number];

export const EXECUTION_STATUSES = [
  'accepted',
  'running',
  'stopping',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const CHECK_STATUSES = ['passed', 'failed', 'blocked'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const SOURCE_QUALITY_STATUSES = ['provisional', 'reviewed'] as const;
export type SourceQualityStatus = (typeof SOURCE_QUALITY_STATUSES)[number];

/** `provisional` is evidence quality. It is not the same axis as UsageScope. */
export const SOURCE_KINDS = ['vcs', 'offline_archive'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const TASK_KINDS = ['segmentation', 'detection', 'language_model'] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const SLOT_KINDS = ['feature', 'operator', 'loss', 'training_hook'] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

/**
 * Mechanism classes from PHASE2-SPEC section 4. The check set is chosen by this class, not by the
 * module's name, and never by the interventionAxis label on a P6 card.
 */
export const MECHANISM_KINDS = [
  'parameterized_feature',
  'parameter_free_operator',
  'loss',
  'training_hook',
  'data_policy',
  'combination',
] as const;
export type MechanismKind = (typeof MECHANISM_KINDS)[number];

export const PATCH_PROVIDERS = ['human', 'agent'] as const;
export type PatchProvider = (typeof PATCH_PROVIDERS)[number];

export const LIGHTWEIGHT_MODES = ['smoke', 'tiny'] as const;
export type LightweightMode = (typeof LIGHTWEIGHT_MODES)[number];

/** A smoke run may not claim a measured improvement. */
export const LIGHTWEIGHT_CONCLUSIONS = ['runnable', 'needs_revision', 'inconclusive'] as const;
export type LightweightConclusion = (typeof LIGHTWEIGHT_CONCLUSIONS)[number];

export const PROPOSAL_KINDS = ['research', 'manual'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** Per-entry verdict on how the adaptation changed a mechanism. */
export const MECHANISM_DIFF_STATUSES = ['expected', 'preserved', 'changed', 'unknown'] as const;
export type MechanismDiffStatus = (typeof MECHANISM_DIFF_STATUSES)[number];

export const LIMIT_KINDS = ['steps', 'wall_time'] as const;
export type LimitKind = (typeof LIMIT_KINDS)[number];

export const METRIC_DIRECTIONS = ['maximize', 'minimize'] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export const DATASET_SPLITS = ['train', 'validation', 'test'] as const;
export type DatasetSplit = (typeof DATASET_SPLITS)[number];

// ----------------- Hash domains -----------------

export const EXPERIMENT_HASH_DOMAINS = {
  sourceBundle: 'experiment-source-bundle',
  adaptationPlan: 'experiment-adaptation-plan',
  implementation: 'experiment-implementation',
  executable: 'experiment-executable',
  checkReport: 'experiment-check-report',
  lightweightResult: 'experiment-lightweight-result',
  protocol: 'experiment-lightweight-protocol',
  request: 'experiment-request',
} as const;

// ----------------- Primitive assertions -----------------

export function expAssertId(val: unknown, fieldPath: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be a non-empty string`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function expAssertHash64(val: unknown, fieldPath: string): string {
  if (typeof val !== 'string' || !HEX64.test(val)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be 64-char lowercase hex`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function expAssertIsoUtc(val: unknown, fieldPath: string): string {
  if (typeof val !== 'string' || !ISO_UTC.test(val)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be UTC ISO 8601`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function expAssertFinite(val: unknown, fieldPath: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `Field "${fieldPath}" must be a finite number in [${min},${max}]`,
      { fieldPaths: [fieldPath] }
    );
  }
  return val;
}

export function expAssertBool(val: unknown, fieldPath: string): boolean {
  if (typeof val !== 'boolean') {
    throw new ExperimentError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be a boolean`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function expAssertEnum<T extends string>(val: unknown, allowed: readonly T[], fieldPath: string): T {
  if (typeof val !== 'string' || !(allowed as readonly string[]).includes(val)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be one of ${allowed.join('|')}`, {
      fieldPaths: [fieldPath],
    });
  }
  return val as T;
}

export function expNoExtraKeys(raw: unknown, allowed: readonly string[], context: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const received = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    throw new ExperimentError('SCHEMA_VIOLATION', `"${context}" must be a plain object, received ${received}`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new ExperimentError('SCHEMA_VIOLATION', `Unknown field "${key}" in ${context}`, {
        fieldPaths: [`${context}.${key}`],
      });
    }
  }
  return obj;
}

export function expAssertArray(val: unknown, fieldPath: string): unknown[] {
  if (!Array.isArray(val)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be an array`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function expAssertStringArray(val: unknown, fieldPath: string): string[] {
  return expAssertArray(val, fieldPath).map((item, i) => expAssertId(item, `${fieldPath}[${i}]`));
}

export function expAssertArtifactRef(val: unknown, fieldPath: string): ArtifactRef {
  const o = expNoExtraKeys(val, ['id', 'sha256'], fieldPath);
  return {
    id: expAssertId(o.id, `${fieldPath}.id`),
    sha256: expAssertHash64(o.sha256, `${fieldPath}.sha256`),
  };
}

// ----------------- Shared DTOs -----------------

/** Opaque host-resolved artifact handle. An id is not a filesystem path. */
export interface ArtifactRef {
  id: string;
  sha256: string;
}

export interface ExecutionError {
  code: string;
  message: string;
  retryable: boolean;
  fieldPaths: string[];
  diagnosticRef: ArtifactRef | null;
}

export interface ExecutionReceipt {
  operationId: string;
  commandId: string;
  requestHash: string;
  taskRevision: number;
}

export interface ExecutionOperation {
  id: string;
  ownerSessionId: string;
  taskId: string;
  stage: typeof EXPERIMENT_STAGE;
  parentOperationId: string | null;
  revision: number;
  status: ExecutionStatus;
  resultRefs: ArtifactRef[];
  diagnosticRefs: ArtifactRef[];
  error: ExecutionError | null;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetPolicy {
  wallClockDeadline: string;
  maxModelCalls: number;
  maxTotalTokens: number;
  maxExecutionSeconds: number;
  maxRepairAttempts: number;
  maxTrials: number;
  perAttemptTimeoutMs: number;
  allowedDevices: string[];
  maxMemoryBytes: number;
  maxDiskBytes: number;
}

// ----------------- ProposalLink -----------------

export interface ProposalLink {
  kind: ProposalKind;
  /** Present when kind === 'research'. */
  synthesisResultRef?: ArtifactRef;
  candidateId?: string;
  candidateHash?: string;
  /** Present when kind === 'manual'. */
  proposalRef?: ArtifactRef;
  selectionReason?: string;
  /** Optional: explains scheduling only. It never authorises a candidate. */
  rankingResultRef?: ArtifactRef;
}

const PROPOSAL_LINK_KEYS = [
  'kind',
  'synthesisResultRef',
  'candidateId',
  'candidateHash',
  'proposalRef',
  'selectionReason',
  'rankingResultRef',
] as const;

export function validateProposalLink(raw: unknown, fieldPath = 'ProposalLink'): ProposalLink {
  const o = expNoExtraKeys(raw, PROPOSAL_LINK_KEYS, fieldPath);
  const kind = expAssertEnum(o.kind, PROPOSAL_KINDS, `${fieldPath}.kind`);

  if (kind === 'research') {
    if (o.synthesisResultRef === undefined || o.candidateId === undefined || o.candidateHash === undefined) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `${fieldPath}: kind "research" requires synthesisResultRef, candidateId and candidateHash`,
        { fieldPaths: [`${fieldPath}.candidateId`] }
      );
    }
    if (o.proposalRef !== undefined || o.selectionReason !== undefined) {
      throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: kind "research" may not carry manual fields`, {
        fieldPaths: [`${fieldPath}.proposalRef`],
      });
    }
  } else {
    if (o.proposalRef === undefined || o.selectionReason === undefined) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `${fieldPath}: kind "manual" requires proposalRef and selectionReason`,
        { fieldPaths: [`${fieldPath}.selectionReason`] }
      );
    }
    if (o.synthesisResultRef !== undefined || o.candidateId !== undefined || o.candidateHash !== undefined) {
      throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: kind "manual" may not carry research fields`, {
        fieldPaths: [`${fieldPath}.candidateId`],
      });
    }
  }

  return {
    kind,
    ...(o.synthesisResultRef !== undefined
      ? { synthesisResultRef: expAssertArtifactRef(o.synthesisResultRef, `${fieldPath}.synthesisResultRef`) }
      : {}),
    ...(o.candidateId !== undefined ? { candidateId: expAssertId(o.candidateId, `${fieldPath}.candidateId`) } : {}),
    ...(o.candidateHash !== undefined
      ? { candidateHash: expAssertHash64(o.candidateHash, `${fieldPath}.candidateHash`) }
      : {}),
    ...(o.proposalRef !== undefined
      ? { proposalRef: expAssertArtifactRef(o.proposalRef, `${fieldPath}.proposalRef`) }
      : {}),
    ...(o.selectionReason !== undefined
      ? { selectionReason: expAssertId(o.selectionReason, `${fieldPath}.selectionReason`) }
      : {}),
    ...(o.rankingResultRef !== undefined
      ? { rankingResultRef: expAssertArtifactRef(o.rankingResultRef, `${fieldPath}.rankingResultRef`) }
      : {}),
  };
}

// ----------------- SourceBundle -----------------

/**
 * One pinned code source. `commit` is required for a VCS checkout; an offline archive instead
 * carries `contentHash` and says so through `sourceKind`.
 */
export interface SourceEntry {
  id: string;
  role: 'baseline' | 'module';
  sourceKind: SourceKind;
  sourceUri: string;
  commit: string | null;
  contentHash: string | null;
  treeRef: string;
  entrypoint: string;
  licenseRef: string;
  weightRefs: string[];
}

export interface SourceBundle {
  schemaVersion: number;
  proposal: ProposalLink;
  baseline: SourceEntry;
  modules: SourceEntry[];
  dataRef: ArtifactRef;
  environmentRef: ArtifactRef;
  qualityStatus: SourceQualityStatus;
  /** Gaps the resolver could not close. Non-empty means the bundle is not a clean pin. */
  unresolved: string[];
  sourceBundleHash: string;
}

const SOURCE_ENTRY_KEYS = [
  'id',
  'role',
  'sourceKind',
  'sourceUri',
  'commit',
  'contentHash',
  'treeRef',
  'entrypoint',
  'licenseRef',
  'weightRefs',
] as const;

export function validateSourceEntry(raw: unknown, fieldPath: string): SourceEntry {
  const o = expNoExtraKeys(raw, SOURCE_ENTRY_KEYS, fieldPath);
  const sourceKind = expAssertEnum(o.sourceKind, SOURCE_KINDS, `${fieldPath}.sourceKind`);
  const commit = o.commit === null ? null : expAssertId(o.commit, `${fieldPath}.commit`);
  const contentHash = o.contentHash === null ? null : expAssertHash64(o.contentHash, `${fieldPath}.contentHash`);

  if (sourceKind === 'vcs' && commit === null) {
    throw new ExperimentError('SOURCE_MISMATCH', `${fieldPath}: a vcs source must pin a commit`, {
      fieldPaths: [`${fieldPath}.commit`],
    });
  }
  if (sourceKind === 'offline_archive' && contentHash === null) {
    throw new ExperimentError(
      'SOURCE_MISMATCH',
      `${fieldPath}: an offline_archive source must carry a contentHash in place of a commit`,
      { fieldPaths: [`${fieldPath}.contentHash`] }
    );
  }

  return {
    id: expAssertId(o.id, `${fieldPath}.id`),
    role: expAssertEnum(o.role, ['baseline', 'module'] as const, `${fieldPath}.role`),
    sourceKind,
    sourceUri: expAssertId(o.sourceUri, `${fieldPath}.sourceUri`),
    commit,
    contentHash,
    treeRef: expAssertId(o.treeRef, `${fieldPath}.treeRef`),
    entrypoint: expAssertId(o.entrypoint, `${fieldPath}.entrypoint`),
    licenseRef: expAssertId(o.licenseRef, `${fieldPath}.licenseRef`),
    // An empty array is meaningful: the source needs no weights.
    weightRefs: expAssertStringArray(o.weightRefs, `${fieldPath}.weightRefs`),
  };
}

const SOURCE_BUNDLE_KEYS = [
  'schemaVersion',
  'proposal',
  'baseline',
  'modules',
  'dataRef',
  'environmentRef',
  'qualityStatus',
  'unresolved',
  'sourceBundleHash',
] as const;

/** Body without its own hash, so the hash can be computed and then verified. */
export function sourceBundleBody(bundle: SourceBundle): Record<string, unknown> {
  const { sourceBundleHash: _omit, ...body } = bundle;
  return body;
}

export function computeSourceBundleHash(body: Record<string, unknown>): string {
  return typedHash(EXPERIMENT_HASH_DOMAINS.sourceBundle, body);
}

export function validateSourceBundle(raw: unknown, fieldPath = 'SourceBundle'): SourceBundle {
  const o = expNoExtraKeys(raw, SOURCE_BUNDLE_KEYS, fieldPath);
  const baseline = validateSourceEntry(o.baseline, `${fieldPath}.baseline`);
  if (baseline.role !== 'baseline') {
    throw new ExperimentError('SOURCE_MISMATCH', `${fieldPath}.baseline must have role "baseline"`, {
      fieldPaths: [`${fieldPath}.baseline.role`],
    });
  }
  const modules = expAssertArray(o.modules, `${fieldPath}.modules`).map((m, i) =>
    validateSourceEntry(m, `${fieldPath}.modules[${i}]`)
  );
  for (const [i, m] of modules.entries()) {
    if (m.role !== 'module') {
      throw new ExperimentError('SOURCE_MISMATCH', `${fieldPath}.modules[${i}] must have role "module"`, {
        fieldPaths: [`${fieldPath}.modules[${i}].role`],
      });
    }
  }
  const ids = [...modules.map((m) => m.id), baseline.id];
  if (new Set(ids).size !== ids.length) {
    throw new ExperimentError('SOURCE_MISMATCH', `${fieldPath}: source entry ids must be unique`, {
      fieldPaths: [`${fieldPath}.modules`],
    });
  }

  const bundle: SourceBundle = {
    schemaVersion: expAssertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1, 1),
    proposal: validateProposalLink(o.proposal, `${fieldPath}.proposal`),
    baseline,
    modules,
    dataRef: expAssertArtifactRef(o.dataRef, `${fieldPath}.dataRef`),
    environmentRef: expAssertArtifactRef(o.environmentRef, `${fieldPath}.environmentRef`),
    qualityStatus: expAssertEnum(o.qualityStatus, SOURCE_QUALITY_STATUSES, `${fieldPath}.qualityStatus`),
    unresolved: expAssertStringArray(o.unresolved, `${fieldPath}.unresolved`),
    sourceBundleHash: expAssertHash64(o.sourceBundleHash, `${fieldPath}.sourceBundleHash`),
  };

  const recomputed = computeSourceBundleHash(sourceBundleBody(bundle));
  if (recomputed !== bundle.sourceBundleHash) {
    throw new ExperimentError(
      'SOURCE_MISMATCH',
      `${fieldPath}: sourceBundleHash mismatch (declared ${bundle.sourceBundleHash.slice(0, 12)}..., computed ${recomputed.slice(0, 12)}...)`,
      { fieldPaths: [`${fieldPath}.sourceBundleHash`] }
    );
  }
  return bundle;
}

// ----------------- TaskProfile and SlotContract -----------------

export interface SlotContract {
  slotId: string;
  kind: SlotKind;
  inputSchemaRef: string;
  outputSchemaRef: string;
  allowedModuleKinds: MechanismKind[];
  orderRuleRef: string;
}

const SLOT_CONTRACT_KEYS = [
  'slotId',
  'kind',
  'inputSchemaRef',
  'outputSchemaRef',
  'allowedModuleKinds',
  'orderRuleRef',
] as const;

export function validateSlotContract(raw: unknown, fieldPath: string): SlotContract {
  const o = expNoExtraKeys(raw, SLOT_CONTRACT_KEYS, fieldPath);
  const allowedModuleKinds = expAssertArray(o.allowedModuleKinds, `${fieldPath}.allowedModuleKinds`).map((k, i) =>
    expAssertEnum(k, MECHANISM_KINDS, `${fieldPath}.allowedModuleKinds[${i}]`)
  );
  if (allowedModuleKinds.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.allowedModuleKinds may not be empty`, {
      fieldPaths: [`${fieldPath}.allowedModuleKinds`],
    });
  }
  return {
    slotId: expAssertId(o.slotId, `${fieldPath}.slotId`),
    kind: expAssertEnum(o.kind, SLOT_KINDS, `${fieldPath}.kind`),
    inputSchemaRef: expAssertId(o.inputSchemaRef, `${fieldPath}.inputSchemaRef`),
    outputSchemaRef: expAssertId(o.outputSchemaRef, `${fieldPath}.outputSchemaRef`),
    allowedModuleKinds,
    orderRuleRef: expAssertId(o.orderRuleRef, `${fieldPath}.orderRuleRef`),
  };
}

/**
 * A trusted host configuration that binds real functions. It is never a request parameter: a
 * caller cannot point a run at an arbitrary executable.
 */
export interface TaskProfile {
  id: string;
  version: number;
  taskKind: TaskKind;
  runnerRef: string;
  compilerRef: string;
  verifierRef: string;
  slots: SlotContract[];
  capabilities: string[];
  isolationPolicyRef: string;
  /** How many modules this profile can actually run. Declared, not inferred. */
  maxModules: number;
  /** The source contract this profile may consume. Guards against a v1/v2 mix-up. */
  sourceContractMax: number;
}

const TASK_PROFILE_KEYS = [
  'id',
  'version',
  'taskKind',
  'runnerRef',
  'compilerRef',
  'verifierRef',
  'slots',
  'capabilities',
  'isolationPolicyRef',
  'maxModules',
  'sourceContractMax',
] as const;

export function validateTaskProfile(raw: unknown, fieldPath = 'TaskProfile'): TaskProfile {
  const o = expNoExtraKeys(raw, TASK_PROFILE_KEYS, fieldPath);
  const slots = expAssertArray(o.slots, `${fieldPath}.slots`).map((s, i) =>
    validateSlotContract(s, `${fieldPath}.slots[${i}]`)
  );
  if (slots.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.slots may not be empty`, {
      fieldPaths: [`${fieldPath}.slots`],
    });
  }
  const slotIds = slots.map((s) => s.slotId);
  if (new Set(slotIds).size !== slotIds.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: slotId values must be unique`, {
      fieldPaths: [`${fieldPath}.slots`],
    });
  }
  return {
    id: expAssertId(o.id, `${fieldPath}.id`),
    version: expAssertFinite(o.version, `${fieldPath}.version`, 1),
    taskKind: expAssertEnum(o.taskKind, TASK_KINDS, `${fieldPath}.taskKind`),
    runnerRef: expAssertId(o.runnerRef, `${fieldPath}.runnerRef`),
    compilerRef: expAssertId(o.compilerRef, `${fieldPath}.compilerRef`),
    verifierRef: expAssertId(o.verifierRef, `${fieldPath}.verifierRef`),
    slots,
    capabilities: expAssertStringArray(o.capabilities, `${fieldPath}.capabilities`),
    isolationPolicyRef: expAssertId(o.isolationPolicyRef, `${fieldPath}.isolationPolicyRef`),
    maxModules: expAssertFinite(o.maxModules, `${fieldPath}.maxModules`, 1, 64),
    sourceContractMax: expAssertFinite(o.sourceContractMax, `${fieldPath}.sourceContractMax`, 1, 64),
  };
}

// ----------------- AdaptationPlan -----------------

export interface PlanBinding {
  slotId: string;
  orderedModuleIds: string[];
  configRef: string;
}

export interface AdaptationPlan {
  sourceBundleRef: ArtifactRef;
  profileRef: string;
  bindings: PlanBinding[];
  allowedPaths: string[];
  forbiddenPaths: string[];
  dependencyPolicyRef: string;
  mechanismChecks: string[];
  patchProvider: PatchProvider;
  maxRepairAttempts: number;
  planHash: string;
}

const PLAN_BINDING_KEYS = ['slotId', 'orderedModuleIds', 'configRef'] as const;
const ADAPTATION_PLAN_KEYS = [
  'sourceBundleRef',
  'profileRef',
  'bindings',
  'allowedPaths',
  'forbiddenPaths',
  'dependencyPolicyRef',
  'mechanismChecks',
  'patchProvider',
  'maxRepairAttempts',
  'planHash',
] as const;

export function validatePlanBinding(raw: unknown, fieldPath: string): PlanBinding {
  const o = expNoExtraKeys(raw, PLAN_BINDING_KEYS, fieldPath);
  const orderedModuleIds = expAssertStringArray(o.orderedModuleIds, `${fieldPath}.orderedModuleIds`);
  if (new Set(orderedModuleIds).size !== orderedModuleIds.length) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', `${fieldPath}: duplicate module id in a binding`, {
      fieldPaths: [`${fieldPath}.orderedModuleIds`],
    });
  }
  return {
    slotId: expAssertId(o.slotId, `${fieldPath}.slotId`),
    orderedModuleIds,
    configRef: expAssertId(o.configRef, `${fieldPath}.configRef`),
  };
}

export function adaptationPlanBody(plan: AdaptationPlan): Record<string, unknown> {
  const { planHash: _omit, ...body } = plan;
  return body;
}

export function computeAdaptationPlanHash(body: Record<string, unknown>): string {
  return typedHash(EXPERIMENT_HASH_DOMAINS.adaptationPlan, body);
}

export function validateAdaptationPlan(raw: unknown, fieldPath = 'AdaptationPlan'): AdaptationPlan {
  const o = expNoExtraKeys(raw, ADAPTATION_PLAN_KEYS, fieldPath);
  const bindings = expAssertArray(o.bindings, `${fieldPath}.bindings`).map((b, i) =>
    validatePlanBinding(b, `${fieldPath}.bindings[${i}]`)
  );
  if (bindings.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.bindings may not be empty`, {
      fieldPaths: [`${fieldPath}.bindings`],
    });
  }
  const slotIds = bindings.map((b) => b.slotId);
  if (new Set(slotIds).size !== slotIds.length) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', `${fieldPath}: one binding per slot is allowed`, {
      fieldPaths: [`${fieldPath}.bindings`],
    });
  }

  const allowedPaths = expAssertStringArray(o.allowedPaths, `${fieldPath}.allowedPaths`);
  const forbiddenPaths = expAssertStringArray(o.forbiddenPaths, `${fieldPath}.forbiddenPaths`);
  if (allowedPaths.length === 0) {
    throw new ExperimentError('POLICY_DENIED', `${fieldPath}.allowedPaths may not be empty`, {
      fieldPaths: [`${fieldPath}.allowedPaths`],
    });
  }
  const overlap = allowedPaths.filter((p) => forbiddenPaths.includes(p));
  if (overlap.length > 0) {
    throw new ExperimentError('POLICY_DENIED', `${fieldPath}: path is both allowed and forbidden: ${overlap[0]}`, {
      fieldPaths: [`${fieldPath}.forbiddenPaths`],
    });
  }

  const plan: AdaptationPlan = {
    sourceBundleRef: expAssertArtifactRef(o.sourceBundleRef, `${fieldPath}.sourceBundleRef`),
    profileRef: expAssertId(o.profileRef, `${fieldPath}.profileRef`),
    bindings,
    allowedPaths,
    forbiddenPaths,
    dependencyPolicyRef: expAssertId(o.dependencyPolicyRef, `${fieldPath}.dependencyPolicyRef`),
    mechanismChecks: expAssertStringArray(o.mechanismChecks, `${fieldPath}.mechanismChecks`),
    patchProvider: expAssertEnum(o.patchProvider, PATCH_PROVIDERS, `${fieldPath}.patchProvider`),
    maxRepairAttempts: expAssertFinite(o.maxRepairAttempts, `${fieldPath}.maxRepairAttempts`, 0, 100),
    planHash: expAssertHash64(o.planHash, `${fieldPath}.planHash`),
  };

  const recomputed = computeAdaptationPlanHash(adaptationPlanBody(plan));
  if (recomputed !== plan.planHash) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `${fieldPath}: planHash mismatch (declared ${plan.planHash.slice(0, 12)}..., computed ${recomputed.slice(0, 12)}...)`,
      { fieldPaths: [`${fieldPath}.planHash`] }
    );
  }
  return plan;
}

// ----------------- ImplementationSnapshot -----------------

/**
 * One line of the mechanism diff. `changed` is not automatically a failure, but it invalidates the
 * P6 hypothesis and must be recorded as a revision rather than silently accepted.
 */
export interface MechanismDiffEntry {
  mechanism: string;
  status: MechanismDiffStatus;
  detail: string;
  evidenceRefs: string[];
}

export interface ImplementationSnapshot {
  sourceBundleRef: ArtifactRef;
  planRef: ArtifactRef;
  patchRef: ArtifactRef;
  codeTreeRef: ArtifactRef;
  dependencyLockRef: ArtifactRef;
  resolvedConfigRef: ArtifactRef;
  mechanismDiff: MechanismDiffEntry[];
  mechanismDiffRef: ArtifactRef;
  attemptRefs: ArtifactRef[];
  implementationHash: string;
}

const MECHANISM_DIFF_KEYS = ['mechanism', 'status', 'detail', 'evidenceRefs'] as const;
const IMPLEMENTATION_KEYS = [
  'sourceBundleRef',
  'planRef',
  'patchRef',
  'codeTreeRef',
  'dependencyLockRef',
  'resolvedConfigRef',
  'mechanismDiff',
  'mechanismDiffRef',
  'attemptRefs',
  'implementationHash',
] as const;

export function validateMechanismDiffEntry(raw: unknown, fieldPath: string): MechanismDiffEntry {
  const o = expNoExtraKeys(raw, MECHANISM_DIFF_KEYS, fieldPath);
  return {
    mechanism: expAssertId(o.mechanism, `${fieldPath}.mechanism`),
    status: expAssertEnum(o.status, MECHANISM_DIFF_STATUSES, `${fieldPath}.status`),
    detail: expAssertId(o.detail, `${fieldPath}.detail`),
    evidenceRefs: expAssertStringArray(o.evidenceRefs, `${fieldPath}.evidenceRefs`),
  };
}

export function implementationBody(snapshot: ImplementationSnapshot): Record<string, unknown> {
  const { implementationHash: _omit, ...body } = snapshot;
  return body;
}

export function computeImplementationHash(body: Record<string, unknown>): string {
  return typedHash(EXPERIMENT_HASH_DOMAINS.implementation, body);
}

export function validateImplementationSnapshot(raw: unknown, fieldPath = 'ImplementationSnapshot'): ImplementationSnapshot {
  const o = expNoExtraKeys(raw, IMPLEMENTATION_KEYS, fieldPath);
  const mechanismDiff = expAssertArray(o.mechanismDiff, `${fieldPath}.mechanismDiff`).map((d, i) =>
    validateMechanismDiffEntry(d, `${fieldPath}.mechanismDiff[${i}]`)
  );
  const snapshot: ImplementationSnapshot = {
    sourceBundleRef: expAssertArtifactRef(o.sourceBundleRef, `${fieldPath}.sourceBundleRef`),
    planRef: expAssertArtifactRef(o.planRef, `${fieldPath}.planRef`),
    patchRef: expAssertArtifactRef(o.patchRef, `${fieldPath}.patchRef`),
    codeTreeRef: expAssertArtifactRef(o.codeTreeRef, `${fieldPath}.codeTreeRef`),
    dependencyLockRef: expAssertArtifactRef(o.dependencyLockRef, `${fieldPath}.dependencyLockRef`),
    resolvedConfigRef: expAssertArtifactRef(o.resolvedConfigRef, `${fieldPath}.resolvedConfigRef`),
    mechanismDiff,
    mechanismDiffRef: expAssertArtifactRef(o.mechanismDiffRef, `${fieldPath}.mechanismDiffRef`),
    attemptRefs: expAssertArray(o.attemptRefs, `${fieldPath}.attemptRefs`).map((a, i) =>
      expAssertArtifactRef(a, `${fieldPath}.attemptRefs[${i}]`)
    ),
    implementationHash: expAssertHash64(o.implementationHash, `${fieldPath}.implementationHash`),
  };
  const recomputed = computeImplementationHash(implementationBody(snapshot));
  if (recomputed !== snapshot.implementationHash) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `${fieldPath}: implementationHash mismatch (declared ${snapshot.implementationHash.slice(0, 12)}..., computed ${recomputed.slice(0, 12)}...)`,
      { fieldPaths: [`${fieldPath}.implementationHash`] }
    );
  }
  return snapshot;
}

// ----------------- CheckReport -----------------

export interface CheckResult {
  id: string;
  status: CheckStatus;
  required: boolean;
  reason: string;
  evidenceRefs: ArtifactRef[];
}

export interface CheckReport {
  schemaVersion: number;
  subjectRef: ArtifactRef;
  profileRef: string;
  checks: CheckResult[];
  status: CheckStatus;
  reportHash: string;
}

const CHECK_RESULT_KEYS = ['id', 'status', 'required', 'reason', 'evidenceRefs'] as const;
const CHECK_REPORT_KEYS = ['schemaVersion', 'subjectRef', 'profileRef', 'checks', 'status', 'reportHash'] as const;

/**
 * Aggregate rule (architecture section 4): any required failure -> failed; else any required
 * blocked -> blocked; else passed. Non-required checks are still shown but do not decide the
 * aggregate, so a profile that declares no required check is a profile defect, not a pass.
 */
export function aggregateCheckStatus(checks: readonly CheckResult[]): CheckStatus {
  const required = checks.filter((c) => c.required);
  if (required.some((c) => c.status === 'failed')) return 'failed';
  if (required.some((c) => c.status === 'blocked')) return 'blocked';
  return 'passed';
}

export function checkReportBody(report: CheckReport): Record<string, unknown> {
  const { reportHash: _omit, ...body } = report;
  return body;
}

export function computeCheckReportHash(body: Record<string, unknown>): string {
  return typedHash(EXPERIMENT_HASH_DOMAINS.checkReport, body);
}

export function validateCheckReport(raw: unknown, fieldPath = 'CheckReport'): CheckReport {
  const o = expNoExtraKeys(raw, CHECK_REPORT_KEYS, fieldPath);
  const checks = expAssertArray(o.checks, `${fieldPath}.checks`).map((c, i): CheckResult => {
    const co = expNoExtraKeys(c, CHECK_RESULT_KEYS, `${fieldPath}.checks[${i}]`);
    return {
      id: expAssertId(co.id, `${fieldPath}.checks[${i}].id`),
      status: expAssertEnum(co.status, CHECK_STATUSES, `${fieldPath}.checks[${i}].status`),
      required: expAssertBool(co.required, `${fieldPath}.checks[${i}].required`),
      reason: expAssertId(co.reason, `${fieldPath}.checks[${i}].reason`),
      evidenceRefs: expAssertArray(co.evidenceRefs, `${fieldPath}.checks[${i}].evidenceRefs`).map((e, j) =>
        expAssertArtifactRef(e, `${fieldPath}.checks[${i}].evidenceRefs[${j}]`)
      ),
    };
  });
  const ids = checks.map((c) => c.id);
  if (new Set(ids).size !== ids.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: duplicate check id`, {
      fieldPaths: [`${fieldPath}.checks`],
    });
  }

  const report: CheckReport = {
    schemaVersion: expAssertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1, 1),
    subjectRef: expAssertArtifactRef(o.subjectRef, `${fieldPath}.subjectRef`),
    profileRef: expAssertId(o.profileRef, `${fieldPath}.profileRef`),
    checks,
    status: expAssertEnum(o.status, CHECK_STATUSES, `${fieldPath}.status`),
    reportHash: expAssertHash64(o.reportHash, `${fieldPath}.reportHash`),
  };

  // The aggregate is derived, so a report may not declare a friendlier status than its checks.
  const derived = aggregateCheckStatus(checks);
  if (derived !== report.status) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `${fieldPath}: status "${report.status}" does not follow its checks (${derived})`,
      { fieldPaths: [`${fieldPath}.status`] }
    );
  }
  const recomputed = computeCheckReportHash(checkReportBody(report));
  if (recomputed !== report.reportHash) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: reportHash mismatch`, {
      fieldPaths: [`${fieldPath}.reportHash`],
    });
  }
  return report;
}

// ----------------- LightweightProtocol -----------------

export interface MetricSpec {
  id: string;
  direction: MetricDirection;
  unit: string;
  validRange: [number, number] | null;
  split: DatasetSplit;
  aggregation: string;
  evaluatorOutputKey: string;
}

export interface LightweightLimit {
  kind: LimitKind;
  value: number;
}

export interface LightweightProtocol {
  profileRef: string;
  dataSubsetRef: ArtifactRef;
  variants: string[];
  seeds: number[];
  limit: LightweightLimit;
  metricSpecs: MetricSpec[];
  toleranceRef: ArtifactRef;
  /** Required for smoke: the input sample and the mechanism assertions it must satisfy. */
  inputSampleRef?: ArtifactRef;
  mechanismAssertionRefs?: ArtifactRef[];
  protocolHash: string;
}

const METRIC_SPEC_KEYS = [
  'id',
  'direction',
  'unit',
  'validRange',
  'split',
  'aggregation',
  'evaluatorOutputKey',
] as const;
const LIMIT_KEYS = ['kind', 'value'] as const;
const LIGHTWEIGHT_PROTOCOL_KEYS = [
  'profileRef',
  'dataSubsetRef',
  'variants',
  'seeds',
  'limit',
  'metricSpecs',
  'toleranceRef',
  'inputSampleRef',
  'mechanismAssertionRefs',
  'protocolHash',
] as const;

export function validateMetricSpec(raw: unknown, fieldPath: string): MetricSpec {
  const o = expNoExtraKeys(raw, METRIC_SPEC_KEYS, fieldPath);
  let validRange: [number, number] | null = null;
  if (o.validRange !== null) {
    const r = expAssertArray(o.validRange, `${fieldPath}.validRange`);
    if (r.length !== 2) {
      throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.validRange must be [min,max]`, {
        fieldPaths: [`${fieldPath}.validRange`],
      });
    }
    const lo = expAssertFinite(r[0], `${fieldPath}.validRange[0]`, -Number.MAX_VALUE);
    const hi = expAssertFinite(r[1], `${fieldPath}.validRange[1]`, -Number.MAX_VALUE);
    if (hi < lo) {
      throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.validRange max must be >= min`, {
        fieldPaths: [`${fieldPath}.validRange`],
      });
    }
    validRange = [lo, hi];
  }
  return {
    id: expAssertId(o.id, `${fieldPath}.id`),
    direction: expAssertEnum(o.direction, METRIC_DIRECTIONS, `${fieldPath}.direction`),
    unit: expAssertId(o.unit, `${fieldPath}.unit`),
    validRange,
    split: expAssertEnum(o.split, DATASET_SPLITS, `${fieldPath}.split`),
    aggregation: expAssertId(o.aggregation, `${fieldPath}.aggregation`),
    evaluatorOutputKey: expAssertId(o.evaluatorOutputKey, `${fieldPath}.evaluatorOutputKey`),
  };
}

export function lightweightProtocolBody(protocol: LightweightProtocol): Record<string, unknown> {
  const { protocolHash: _omit, ...body } = protocol;
  return body;
}

export function computeLightweightProtocolHash(body: Record<string, unknown>): string {
  return typedHash(EXPERIMENT_HASH_DOMAINS.protocol, body);
}

export function validateLightweightProtocol(raw: unknown, fieldPath = 'LightweightProtocol'): LightweightProtocol {
  const o = expNoExtraKeys(raw, LIGHTWEIGHT_PROTOCOL_KEYS, fieldPath);
  const variants = expAssertStringArray(o.variants, `${fieldPath}.variants`);
  if (variants.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.variants may not be empty`, {
      fieldPaths: [`${fieldPath}.variants`],
    });
  }
  if (new Set(variants).size !== variants.length) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.variants must be unique`, {
      fieldPaths: [`${fieldPath}.variants`],
    });
  }
  const seeds = expAssertArray(o.seeds, `${fieldPath}.seeds`).map((s, i) =>
    expAssertFinite(s, `${fieldPath}.seeds[${i}]`, 0)
  );
  if (seeds.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.seeds may not be empty`, {
      fieldPaths: [`${fieldPath}.seeds`],
    });
  }
  // Every variant shares one data slice and one pre-declared budget.
  const limitObj = expNoExtraKeys(o.limit, LIMIT_KEYS, `${fieldPath}.limit`);
  const limit: LightweightLimit = {
    kind: expAssertEnum(limitObj.kind, LIMIT_KINDS, `${fieldPath}.limit.kind`),
    value: expAssertFinite(limitObj.value, `${fieldPath}.limit.value`, 1),
  };
  const metricSpecs = expAssertArray(o.metricSpecs, `${fieldPath}.metricSpecs`).map((m, i) =>
    validateMetricSpec(m, `${fieldPath}.metricSpecs[${i}]`)
  );

  const protocol: LightweightProtocol = {
    profileRef: expAssertId(o.profileRef, `${fieldPath}.profileRef`),
    dataSubsetRef: expAssertArtifactRef(o.dataSubsetRef, `${fieldPath}.dataSubsetRef`),
    variants,
    seeds,
    limit,
    metricSpecs,
    toleranceRef: expAssertArtifactRef(o.toleranceRef, `${fieldPath}.toleranceRef`),
    ...(o.inputSampleRef !== undefined
      ? { inputSampleRef: expAssertArtifactRef(o.inputSampleRef, `${fieldPath}.inputSampleRef`) }
      : {}),
    ...(o.mechanismAssertionRefs !== undefined
      ? {
          mechanismAssertionRefs: expAssertArray(
            o.mechanismAssertionRefs,
            `${fieldPath}.mechanismAssertionRefs`
          ).map((a, i) => expAssertArtifactRef(a, `${fieldPath}.mechanismAssertionRefs[${i}]`)),
        }
      : {}),
    protocolHash: expAssertHash64(o.protocolHash, `${fieldPath}.protocolHash`),
  };

  const recomputed = computeLightweightProtocolHash(lightweightProtocolBody(protocol));
  if (recomputed !== protocol.protocolHash) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: protocolHash mismatch`, {
      fieldPaths: [`${fieldPath}.protocolHash`],
    });
  }
  return protocol;
}

/**
 * A smoke protocol carries no metrics but must carry the input sample and mechanism assertions;
 * otherwise "it ran" would be the whole evidence.
 */
export function assertSmokeProtocolShape(protocol: LightweightProtocol, fieldPath = 'LightweightProtocol'): void {
  if (!protocol.inputSampleRef) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `${fieldPath}: a smoke protocol requires inputSampleRef`,
      { fieldPaths: [`${fieldPath}.inputSampleRef`] }
    );
  }
  if (!protocol.mechanismAssertionRefs || protocol.mechanismAssertionRefs.length === 0) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `${fieldPath}: a smoke protocol requires at least one mechanism assertion`,
      { fieldPaths: [`${fieldPath}.mechanismAssertionRefs`] }
    );
  }
}

// ----------------- MetricObservation and LightweightResult -----------------

export interface MetricObservation {
  metricId: string;
  value: number;
  unit: string;
  split: DatasetSplit;
  sampleCount: number;
  evaluatorRef: ArtifactRef;
  rawEvidenceRefs: ArtifactRef[];
  variant?: string;
  seed?: number;
}

export interface LightweightResult {
  mode: LightweightMode;
  subjectRef: ArtifactRef;
  protocolRef: ArtifactRef;
  manifestRefs: ArtifactRef[];
  executionFactsRefs: ArtifactRef[];
  checkReportRef: ArtifactRef;
  metricRefs: ArtifactRef[];
  costRef: ArtifactRef;
  conclusion: LightweightConclusion;
  resultHash: string;
}

const METRIC_OBSERVATION_KEYS = [
  'metricId',
  'value',
  'unit',
  'split',
  'sampleCount',
  'evaluatorRef',
  'rawEvidenceRefs',
  'variant',
  'seed',
] as const;
const LIGHTWEIGHT_RESULT_KEYS = [
  'mode',
  'subjectRef',
  'protocolRef',
  'manifestRefs',
  'executionFactsRefs',
  'checkReportRef',
  'metricRefs',
  'costRef',
  'conclusion',
  'resultHash',
] as const;

export function validateMetricObservation(raw: unknown, fieldPath: string): MetricObservation {
  const o = expNoExtraKeys(raw, METRIC_OBSERVATION_KEYS, fieldPath);
  return {
    metricId: expAssertId(o.metricId, `${fieldPath}.metricId`),
    value: expAssertFinite(o.value, `${fieldPath}.value`, -Number.MAX_VALUE),
    unit: expAssertId(o.unit, `${fieldPath}.unit`),
    split: expAssertEnum(o.split, DATASET_SPLITS, `${fieldPath}.split`),
    sampleCount: expAssertFinite(o.sampleCount, `${fieldPath}.sampleCount`, 0),
    evaluatorRef: expAssertArtifactRef(o.evaluatorRef, `${fieldPath}.evaluatorRef`),
    rawEvidenceRefs: expAssertArray(o.rawEvidenceRefs, `${fieldPath}.rawEvidenceRefs`).map((r, i) =>
      expAssertArtifactRef(r, `${fieldPath}.rawEvidenceRefs[${i}]`)
    ),
    // Optional and additive: an observation published before these fields existed still loads, so
    // this is not a breaking change. They are REQUIRED in practice for a multi-variant run — a tiny
    // over baseline/a/ab emits one observation per (variant, seed, metric), and without the arm a
    // later comparison cannot separate the treatment from the control. A positional index is not a
    // substitute: it does not survive reordering, and the published file names are not a contract.
    ...(o.variant !== undefined ? { variant: expAssertId(o.variant, `${fieldPath}.variant`) } : {}),
    ...(o.seed !== undefined ? { seed: expAssertFinite(o.seed, `${fieldPath}.seed`, 0) } : {}),
  };
}

export function lightweightResultBody(result: LightweightResult): Record<string, unknown> {
  const { resultHash: _omit, ...body } = result;
  return body;
}

export function computeLightweightResultHash(body: Record<string, unknown>): string {
  return typedHash(EXPERIMENT_HASH_DOMAINS.lightweightResult, body);
}

export function validateLightweightResult(raw: unknown, fieldPath = 'LightweightResult'): LightweightResult {
  const o = expNoExtraKeys(raw, LIGHTWEIGHT_RESULT_KEYS, fieldPath);
  const mode = expAssertEnum(o.mode, LIGHTWEIGHT_MODES, `${fieldPath}.mode`);
  const result: LightweightResult = {
    mode,
    subjectRef: expAssertArtifactRef(o.subjectRef, `${fieldPath}.subjectRef`),
    protocolRef: expAssertArtifactRef(o.protocolRef, `${fieldPath}.protocolRef`),
    manifestRefs: expAssertArray(o.manifestRefs, `${fieldPath}.manifestRefs`).map((m, i) =>
      expAssertArtifactRef(m, `${fieldPath}.manifestRefs[${i}]`)
    ),
    executionFactsRefs: expAssertArray(o.executionFactsRefs, `${fieldPath}.executionFactsRefs`).map((f, i) =>
      expAssertArtifactRef(f, `${fieldPath}.executionFactsRefs[${i}]`)
    ),
    checkReportRef: expAssertArtifactRef(o.checkReportRef, `${fieldPath}.checkReportRef`),
    metricRefs: expAssertArray(o.metricRefs, `${fieldPath}.metricRefs`).map((m, i) =>
      expAssertArtifactRef(m, `${fieldPath}.metricRefs[${i}]`)
    ),
    costRef: expAssertArtifactRef(o.costRef, `${fieldPath}.costRef`),
    conclusion: expAssertEnum(o.conclusion, LIGHTWEIGHT_CONCLUSIONS, `${fieldPath}.conclusion`),
    resultHash: expAssertHash64(o.resultHash, `${fieldPath}.resultHash`),
  };
  if (mode === 'smoke' && result.metricRefs.length > 0) {
    // A smoke run has no metric budget; publishing metrics would invite a performance reading.
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: a smoke result may not carry metric refs`, {
      fieldPaths: [`${fieldPath}.metricRefs`],
    });
  }
  const recomputed = computeLightweightResultHash(lightweightResultBody(result));
  if (recomputed !== result.resultHash) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: resultHash mismatch`, {
      fieldPaths: [`${fieldPath}.resultHash`],
    });
  }
  return result;
}

// ----------------- ExecutableSnapshot -----------------

export interface ValidatedScope {
  taskKind: TaskKind;
  slotIds: string[];
  moduleIds: string[];
  devices: string[];
  dtypes: string[];
  testedInputBounds: string;
}

export interface ExecutableSnapshot {
  implementationRef: ArtifactRef;
  profileRef: string;
  validationRef: ArtifactRef;
  smokeRef: ArtifactRef;
  executableHash: string;
  readiness: 'ready';
  validatedScope: ValidatedScope;
}

const VALIDATED_SCOPE_KEYS = [
  'taskKind',
  'slotIds',
  'moduleIds',
  'devices',
  'dtypes',
  'testedInputBounds',
] as const;
const EXECUTABLE_KEYS = [
  'implementationRef',
  'profileRef',
  'validationRef',
  'smokeRef',
  'executableHash',
  'readiness',
  'validatedScope',
] as const;

export function validateValidatedScope(raw: unknown, fieldPath: string): ValidatedScope {
  const o = expNoExtraKeys(raw, VALIDATED_SCOPE_KEYS, fieldPath);
  return {
    taskKind: expAssertEnum(o.taskKind, TASK_KINDS, `${fieldPath}.taskKind`),
    slotIds: expAssertStringArray(o.slotIds, `${fieldPath}.slotIds`),
    moduleIds: expAssertStringArray(o.moduleIds, `${fieldPath}.moduleIds`),
    devices: expAssertStringArray(o.devices, `${fieldPath}.devices`),
    dtypes: expAssertStringArray(o.dtypes, `${fieldPath}.dtypes`),
    testedInputBounds: expAssertId(o.testedInputBounds, `${fieldPath}.testedInputBounds`),
  };
}

export function executableBody(snapshot: ExecutableSnapshot): Record<string, unknown> {
  const { executableHash: _omit, ...body } = snapshot;
  return body;
}

/**
 * `executableHash` binds the source tree, patch, dependency lock, resolved recipe, profile version
 * and check rules. Deduplication must not key on a candidate's display name.
 */
export function computeExecutableHash(body: Record<string, unknown>): string {
  return typedHash(EXPERIMENT_HASH_DOMAINS.executable, body);
}

export function validateExecutableSnapshot(raw: unknown, fieldPath = 'ExecutableSnapshot'): ExecutableSnapshot {
  const o = expNoExtraKeys(raw, EXECUTABLE_KEYS, fieldPath);
  const snapshot: ExecutableSnapshot = {
    implementationRef: expAssertArtifactRef(o.implementationRef, `${fieldPath}.implementationRef`),
    profileRef: expAssertId(o.profileRef, `${fieldPath}.profileRef`),
    validationRef: expAssertArtifactRef(o.validationRef, `${fieldPath}.validationRef`),
    smokeRef: expAssertArtifactRef(o.smokeRef, `${fieldPath}.smokeRef`),
    executableHash: expAssertHash64(o.executableHash, `${fieldPath}.executableHash`),
    readiness: expAssertEnum(o.readiness, ['ready'] as const, `${fieldPath}.readiness`),
    validatedScope: validateValidatedScope(o.validatedScope, `${fieldPath}.validatedScope`),
  };
  const recomputed = computeExecutableHash(executableBody(snapshot));
  if (recomputed !== snapshot.executableHash) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: executableHash mismatch`, {
      fieldPaths: [`${fieldPath}.executableHash`],
    });
  }
  return snapshot;
}

// ----------------- Cross-object consistency -----------------

/**
 * Registration checks the reference closure rather than trusting a request: the validation and
 * smoke reports must describe the same implementation and profile, and the required checks must
 * have passed.
 */
export function assertRegistrationClosure(input: {
  implementation: ImplementationSnapshot;
  validation: CheckReport;
  smoke: LightweightResult;
  implementationRef: ArtifactRef;
  validationRef: ArtifactRef;
  smokeRef: ArtifactRef;
  profileRef: string;
}): void {
  if (input.validation.subjectRef.sha256 !== input.implementationRef.sha256) {
    throw new ExperimentError(
      'MODULE_NOT_READY',
      'validation report does not describe the submitted implementation',
      { fieldPaths: ['validation.subjectRef'] }
    );
  }
  if (input.smoke.subjectRef.sha256 !== input.implementationRef.sha256) {
    throw new ExperimentError('MODULE_NOT_READY', 'smoke result does not describe the submitted implementation', {
      fieldPaths: ['smoke.subjectRef'],
    });
  }
  if (input.validation.profileRef !== input.profileRef) {
    throw new ExperimentError('MODULE_NOT_READY', 'validation report was produced under a different profile', {
      fieldPaths: ['validation.profileRef'],
    });
  }
  if (input.validation.status !== 'passed') {
    throw new ExperimentError(
      'MODULE_NOT_READY',
      `required checks did not pass (status ${input.validation.status})`,
      { fieldPaths: ['validation.status'] }
    );
  }
  if (input.smoke.checkReportRef.sha256 !== input.validationRef.sha256) {
    throw new ExperimentError('MODULE_NOT_READY', 'smoke result is not bound to this validation report', {
      fieldPaths: ['smoke.checkReportRef'],
    });
  }
  if (input.smoke.mode !== 'smoke') {
    throw new ExperimentError('MODULE_NOT_READY', 'registration requires a smoke result', {
      fieldPaths: ['smoke.mode'],
    });
  }
  if (input.smoke.conclusion === 'needs_revision') {
    throw new ExperimentError('MODULE_NOT_READY', 'smoke asked for a revision; nothing may be registered', {
      fieldPaths: ['smoke.conclusion'],
    });
  }
  if (input.smokeRef.sha256 !== input.smoke.resultHash) {
    throw new ExperimentError('MODULE_NOT_READY', 'smoke artifact hash does not match its content', {
      fieldPaths: ['smokeRef.sha256'],
    });
  }
  void input.implementation;
  void input.validationRef;
}

/**
 * Tiny may reuse a registered executable, but the executable must already have a passing smoke
 * result and the tiny protocol must target the same profile.
 */
export function assertTinyPreconditions(executable: ExecutableSnapshot, protocol: LightweightProtocol): void {
  if (executable.readiness !== 'ready') {
    throw new ExperimentError('MODULE_NOT_READY', 'tiny requires a registered executable snapshot', {
      fieldPaths: ['executable.readiness'],
    });
  }
  if (protocol.profileRef !== executable.profileRef) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', 'tiny protocol profile does not match the executable', {
      fieldPaths: ['protocol.profileRef'],
    });
  }
}

// ----------------- Request / receipt helpers -----------------

export interface ExperimentRequestBase {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  policyRef: ArtifactRef;
  budgetRef: ArtifactRef;
}

export function computeExperimentRequestHash(payload: Record<string, unknown>): string {
  const { commandId: _commandId, ...semantics } = payload;
  return typedHash(EXPERIMENT_HASH_DOMAINS.request, semantics);
}

export function artifactRefFor(id: string, content: string): ArtifactRef {
  return { id, sha256: sha256Hex(content) };
}

// ----------------- Method registry -----------------

/** The six Phase 2 write methods. The gate asserts tool registration parity against this list. */
export const PHASE2_METHODS = [
  { method: 'resolveSources', tool: 'evolver_resolve_sources' },
  { method: 'planAdaptation', tool: 'evolver_plan_adaptation' },
  { method: 'adaptImplementation', tool: 'evolver_adapt_implementation' },
  { method: 'validateImplementation', tool: 'evolver_validate_implementation' },
  { method: 'runLightweight', tool: 'evolver_run_lightweight' },
  { method: 'registerImplementation', tool: 'evolver_register_implementation' },
] as const;

/** The order PHASE2-SPEC section 3 requires. Each step waits for a terminal operation. */
export const PHASE2_SEQUENCE = [
  'resolveSources',
  'planAdaptation',
  'adaptImplementation',
  'validateImplementation',
  'runLightweight(smoke)',
  'registerImplementation',
  'runLightweight(tiny)',
] as const;
