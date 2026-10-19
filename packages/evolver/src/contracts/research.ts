/**
 * Paper-only (P5/P6/P7) wire contracts, controlled vocabularies, and strict validators.
 * Parallel to the frozen execution-layer contracts in ./index.ts; these types must never
 * carry implementationHash, tensor contracts, or readyReportId.
 * Spec: docs/mvp/PAPER-ONLY-CONTRACTS.md sections 3-5, 9.1 and phases/P5-P7-SPEC.md.
 */

export const PROTOCOL_ID = 'paper-only-v1';
export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 1;

const HEX64 = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// ----------------- Error codes (paper-only only; P0-P4 codes untouched) -----------------

export const RESEARCH_ERROR_CODES = [
  'INVALID_INPUT',
  'SCHEMA_VIOLATION',
  'SOURCE_MISMATCH',
  'EVIDENCE_INVALID',
  'OWNER_MISMATCH',
  'POLICY_DENIED',
  'IDEMPOTENCY_CONFLICT',
  'DEPENDENCY_NOT_READY',
  'MODEL_UNAVAILABLE',
  'BUDGET_EXHAUSTED',
  'MODEL_TIMEOUT',
  'MODEL_RESPONSE_ERROR',
  'CANCELLED',
  'INTERRUPTED',
] as const;

export type ResearchErrorCode = (typeof RESEARCH_ERROR_CODES)[number];

export class ResearchError extends Error {
  readonly code: ResearchErrorCode;
  readonly retryable: boolean;
  readonly fieldPaths: string[];
  readonly diagnosticRef?: ArtifactRef | null;

  constructor(
    code: ResearchErrorCode,
    message: string,
    opts: { retryable?: boolean; fieldPaths?: string[]; diagnosticRef?: ArtifactRef | null } = {}
  ) {
    super(`[${code}] ${message}`);
    this.name = 'ResearchError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.fieldPaths = opts.fieldPaths ?? [];
    this.diagnosticRef = opts.diagnosticRef ?? null;
  }

  toResearchError(): ResearchErrorDto {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      fieldPaths: this.fieldPaths,
      diagnosticRef: this.diagnosticRef ?? null,
    };
  }
}

// ----------------- Vocabularies (public: legal values only, never paper->label answers) -----------------

export const EVIDENCE_STATUSES = ['source_reported', 'inferred', 'hypothesis', 'unknown'] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const ROLES = ['baseline', 'module', 'both', 'unclear'] as const;
export type Role = (typeof ROLES)[number];

export const INTERVENTION_AXES = [
  'feature_path',
  'loss',
  'training_parameterization',
  'attention_implementation',
  'other',
] as const;
export type InterventionAxis = (typeof INTERVENTION_AXES)[number];

export const TASK_DOMAINS = [
  'vision_segmentation',
  'vision_detection',
  'sequence_modeling',
  'cross_domain',
  'other',
] as const;
export type TaskDomain = (typeof TASK_DOMAINS)[number];

export const METRIC_DIRECTIONS = ['higher', 'lower', 'unknown'] as const;
export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export const COVERAGE_VALUES = ['complete', 'partial', 'insufficient_evidence'] as const;
export type Coverage = (typeof COVERAGE_VALUES)[number];

export const COMPARABILITY_VALUES = ['unknown', 'incomparable', 'context_matched'] as const;
export type Comparability = (typeof COMPARABILITY_VALUES)[number];

export const CARD_STATUSES = ['proposed'] as const;
export type ResearchCardStatus = (typeof CARD_STATUSES)[number];

export const PERFORMANCE_STATUSES = ['NOT_VERIFIED'] as const;

export const COMPATIBILITY_DECISIONS = [
  'compatible',
  'conditionally_compatible',
  'reject_for_mvp',
  'insufficient_evidence',
] as const;
export type CompatibilityDecision = (typeof COMPATIBILITY_DECISIONS)[number];

export const CANDIDATE_DECISIONS = ['proposed', 'conditional', 'rejected', 'insufficient_evidence'] as const;
export type CandidateDecision = (typeof CANDIDATE_DECISIONS)[number];

export const REASON_CODES = [
  'TASK_MISMATCH',
  'REQUIRED_OPERATOR_ABSENT',
  'REQUIRED_TARGET_ABSENT',
  'SCOPE_EXCLUDED',
  'MECHANISM_CONFLICT',
  'CONDITION_UNRESOLVED',
  'EVIDENCE_MISSING',
  'DISTINCT_INTERVENTION_AXES',
  'SOURCE_SUPPORTED_COMPOSITION',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const REJECTING_REASON_CODES: ReasonCode[] = [
  'TASK_MISMATCH',
  'REQUIRED_OPERATOR_ABSENT',
  'REQUIRED_TARGET_ABSENT',
  'SCOPE_EXCLUDED',
  'MECHANISM_CONFLICT',
];

export const REQUIREMENT_CATEGORIES = [
  'existing_feature_hook',
  'loss_target_transform',
  'parameter_selection',
  'operator_replacement',
  'new_data_annotation',
  'architecture_change',
  'environment_constraint',
  'other',
] as const;
export type RequirementCategory = (typeof REQUIREMENT_CATEGORIES)[number];

export const REQUIREMENT_RESOLUTIONS = ['satisfied', 'unresolved', 'conflicting', 'unknown'] as const;
export type RequirementResolution = (typeof REQUIREMENT_RESOLUTIONS)[number];

export const BINDING_RELATIONS = [
  'transforms_features',
  'adds_objective',
  'reparameterizes',
  'replaces_operator',
  'other',
] as const;
export type BindingRelation = (typeof BINDING_RELATIONS)[number];

export const CONSTRAINT_KINDS = ['task_requirement', 'resource_limit', 'scope_exclusion'] as const;
export type ConstraintKind = (typeof CONSTRAINT_KINDS)[number];

export const ABLATION_STATUSES = ['planned'] as const;

export const RESEARCH_LIFECYCLE = [
  'accepted',
  'running',
  'stopping',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type ResearchOperationStatus = (typeof RESEARCH_LIFECYCLE)[number];

export const RESEARCH_PHASES = ['p5_discover', 'p6_synthesize', 'p7_rank'] as const;
export type ResearchPhase = (typeof RESEARCH_PHASES)[number];

export const INTERFACE_STATUSES = ['NOT_VERIFIED'] as const;

export const RANKING_GROUPS = ['eligible', 'conditional', 'not_rankable', 'excluded'] as const;
export type RankingGroup = (typeof RANKING_GROUPS)[number];

export const EXECUTION_STATUSES = ['completed', 'failed', 'blocked'] as const;
export type CaseExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export const VERDICT_STATUSES = ['pass', 'fail', 'blocked'] as const;
export type CaseVerdict = (typeof VERDICT_STATUSES)[number];

export const REPORT_SCOPES = ['connectivity', 'basic', 'formal'] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

export const GOLD_EXPECTATIONS = ['expect_value', 'expect_unknown', 'not_annotated'] as const;
export type GoldExpectation = (typeof GOLD_EXPECTATIONS)[number];

// ----------------- Base wire types (contract section 9.1) -----------------

export interface ArtifactRef {
  id: string;
  sha256: string;
}

export interface ProtocolRef {
  id: string;
  version: number;
  publicHash: string;
}

export interface ResearchBudget {
  maxCalls: number;
  maxInputTokensPerCall: number;
  maxOutputTokensPerCall: number;
  callTimeoutMs: number;
  totalTimeoutMs: number;
}

export interface ResearchRequestBase {
  commandId: string;
  protocolRef: ProtocolRef;
  evalInvocationId: string;
  sampleKey: string;
  budget: ResearchBudget;
}

export interface CardRef {
  id: string;
  revision: number;
  sha256: string;
  producerOperationId: string;
}

export interface ResearchErrorDto {
  code: string;
  message: string;
  retryable: boolean;
  fieldPaths: string[];
  diagnosticRef: ArtifactRef | null;
}

export interface ResearchReceipt {
  operationId: string;
  commandId: string;
  requestHash: string;
}

export interface AttemptRecord {
  sequence: number;
  startedAt: string;
  endedAt: string | null;
  route: string;
  inputTokens: number | null;
  outputTokens: number | null;
  rawResponseRef: ArtifactRef | null;
  exitReason: string;
  isFormatCorrection: boolean;
  /** Set on the attempt that triggered a format correction: the contract requires the first error to survive. */
  formatError?: string | null;
}

export interface ResearchOperation {
  id: string;
  ownerSessionId: string;
  /**
   * Which host process created this operation. Restart reconciliation needs it: an operation left
   * non-terminal by a *dead* process is interrupted, but one a *live* peer is still working on
   * belongs to that peer and must not be cancelled by an unrelated process starting up.
   * Absent on descriptors written before attribution existed, which stay interruptible.
   */
  ownerIdentity?: string;
  commandId: string;
  requestHash: string;
  phase: ResearchPhase;
  status: ResearchOperationStatus;
  resultRefs: ArtifactRef[];
  error: ResearchErrorDto | null;
  attempts: AttemptRecord[];
  evalInvocationId: string;
  sampleKey: string;
  createdAt: string;
  updatedAt: string;
}

// ----------------- Evidence field model (contract section 3) -----------------

export interface EvidenceField<T> {
  value: T | null;
  status: EvidenceStatus;
  evidenceRefs: string[];
  reason: string | null;
}

export interface ScoringPolicyRef {
  policyId: string;
  sha256: string;
}

export interface EvidenceSpan {
  id: string;
  paperId: string;
  documentHash: string;
  section: string;
  start: number;
  end: number;
  quote: string;
  quoteHash: string;
}

export interface MetricSpec {
  name: string;
  direction: MetricDirection;
}

export interface ReportedResult {
  metric: EvidenceField<MetricSpec>;
  value: EvidenceField<string>;
  unit: EvidenceField<string>;
  dataset: EvidenceField<string>;
  split: EvidenceField<string>;
  baseline: EvidenceField<string>;
  configuration: EvidenceField<string>;
  hardware: EvidenceField<string>;
  comparability: Comparability;
  sourceEvidence: string[];
}

export interface UnresolvedField {
  fieldPath: string;
  reason: string;
}

// ----------------- P5 types -----------------

export interface PaperInput {
  paperId: string;
  title: string;
  version: string;
  sourceUri: string;
  localTextRef: ArtifactRef;
  documentHash: string;
  availableSections: string[];
}

export interface PaperIdentification {
  paperId: string;
  documentHash: string;
  taskDomain: EvidenceField<TaskDomain>;
  role: EvidenceField<Role>;
  contributedMethods: EvidenceField<string>[];
  builtOnBaselines: EvidenceField<string>[];
  comparisonBaselines: EvidenceField<string>[];
  moduleMentions: EvidenceField<string>[];
  limitations: EvidenceField<string>[];
  reportedResults: ReportedResult[];
  ablations: EvidenceField<string>[];
  evidenceSpans: string[];
  coverage: Coverage;
  unresolvedFields: UnresolvedField[];
}

export interface ResearchBaselineCard {
  id: string;
  revision: number;
  paperId: string;
  name: EvidenceField<string>;
  taskDomain: EvidenceField<TaskDomain>;
  methodSummary: EvidenceField<string>;
  requirements: EvidenceField<string>[];
  evidenceRefs: string[];
  status: ResearchCardStatus;
  producerOperationId: string;
  documentHash: string;
}

export interface ResearchModuleCard {
  id: string;
  revision: number;
  paperId: string;
  name: EvidenceField<string>;
  mechanism: EvidenceField<string>;
  interventionAxis: EvidenceField<InterventionAxis>;
  requirements: EvidenceField<string>[];
  modifies: EvidenceField<string>;
  expectedOutput: EvidenceField<string>;
  builtOnBaselines: EvidenceField<string>[];
  limitations: EvidenceField<string>[];
  evidenceRefs: string[];
  status: ResearchCardStatus;
  producerOperationId: string;
  documentHash: string;
}

export interface DiscoveryResult {
  schemaVersion: number;
  identifications: PaperIdentification[];
  baselineCards: ResearchBaselineCard[];
  moduleCards: ResearchModuleCard[];
  evidenceSpans: EvidenceSpan[];
  producerOperationId: string;
}

// ----------------- P6 types -----------------

export interface TaskConstraint {
  id: string;
  kind: ConstraintKind;
  value: string;
  evidenceRefs: string[];
}

export interface ResearchTaskBrief {
  taskId: string;
  researchQuestion: string;
  domain: TaskDomain;
  baselineCardRef: CardRef;
  allowedModuleRefs: CardRef[];
  constraints: TaskConstraint[];
  corpusHash: string;
}

export interface Requirement {
  id: string;
  category: RequirementCategory;
  description: EvidenceField<string>;
  resolution: RequirementResolution;
  basisRefs: string[];
}

export interface ConceptualBinding {
  moduleRef: CardRef;
  axis: InterventionAxis;
  targetConcept: EvidenceField<string>;
  relation: BindingRelation;
  requiredInputs: EvidenceField<string>[];
}

export interface CompatibilityAssessment {
  baselineCardRef: CardRef;
  moduleCardRefs: CardRef[];
  scope: 'mechanism_only';
  decision: CompatibilityDecision;
  requirements: Requirement[];
  unresolvedConditions: string[];
  reasonCodes: ReasonCode[];
  rationale: string;
  evidenceRefs: string[];
  interfaceStatus: 'NOT_VERIFIED';
}

export interface AblationRow {
  variantId: string;
  moduleRefs: string[];
  baselineCardRef: CardRef;
  taskBriefHash: string;
  status: 'planned';
  controlledVariables: Record<string, string>;
  evaluationQuestions: string[];
}

export interface ResearchCandidate {
  /** Absent means frozen v1; v2 is an explicitly opted-in synthesis sub-contract. */
  contractVersion?: 2;
  id: string;
  candidateHash: string;
  taskBriefHash: string;
  baselineCardRef: CardRef;
  moduleCardRefs: CardRef[];
  compatibility: CompatibilityAssessment;
  mechanismHypothesis: EvidenceField<string>;
  conceptualBindings: ConceptualBinding[];
  expectedEffects: EvidenceField<string>[];
  risks: EvidenceField<string>[];
  requiredValidation: EvidenceField<string>[];
  ablationMatrix: AblationRow[];
  evidenceRefs: string[];
  decision: CandidateDecision;
  performanceStatus: 'NOT_VERIFIED';
}

export interface SynthesisResult {
  schemaVersion: number;
  taskBriefHash: string;
  assessments: CompatibilityAssessment[];
  candidates: ResearchCandidate[];
  proposalRef: ArtifactRef;
  producerOperationId: string;
}

// ----------------- P7 types -----------------

export const SCORING_DIMENSIONS = [
  'evidence_strength',
  'mechanism_compatibility',
  'mechanism_complementarity',
  'implementation_simplicity',
] as const;
export type ScoringDimension = (typeof SCORING_DIMENSIONS)[number];

/** scoring-policy-v1 integer weights; design_score = scoreNumerator / 200. */
export const SCORING_POLICY_V1 = {
  policyId: 'scoring-policy-v1',
  rubricVersion: 'rubric-v1',
  weights: {
    evidence_strength: 30,
    mechanism_compatibility: 30,
    mechanism_complementarity: 25,
    implementation_simplicity: 15,
  } as Record<ScoringDimension, number>,
  /** level -> fraction: 0 -> 0, 1 -> 0.5, 2 -> 1. */
  levels: [0, 1, 2] as number[],
  denominator: 200,
} as const;

export interface DimensionResult {
  value: number | null;
  level: number | null;
  ruleId: string;
  inputPaths: string[];
  evidenceRefs: string[];
  rationaleTemplateId: string;
}

export interface Uncertainty {
  nullDimensionCount: number;
  unsupportedRubricDimensions: ScoringDimension[];
}

export interface RankingItem {
  candidateId: string;
  candidateHash: string;
  originalDecision: CandidateDecision;
  group: RankingGroup;
  dimensionResults: Record<ScoringDimension, DimensionResult>;
  scoreNumerator: number | null;
  design_score: number | null;
  rank: number | null;
  reasonCodes: ReasonCode[];
  unresolvedConditions: string[];
  uncertainty: Uncertainty;
  exclusionReasons: string[];
}

export interface RankingResult {
  schemaVersion: number;
  candidateSetHash: string;
  scoringPolicyHash: string;
  rubricVersion: string;
  eligibleIds: string[];
  conditionalIds: string[];
  notRankableIds: string[];
  excludedIds: string[];
  items: RankingItem[];
  calibrationStatus: 'uncalibrated';
  performanceStatus: 'NOT_VERIFIED';
  producerOperationId: string;
}

// ----------------- Reports (contract section 7) -----------------

export interface CaseResult {
  id: string;
  subcaseId: string;
  executionStatus: CaseExecutionStatus;
  verdict: CaseVerdict;
  firstError: string | null;
  evidenceRefs: ArtifactRef[];
  /** How this subcase was produced: replay, authored draft, or a real DSH route. */
  source: 'replay' | 'authored_draft' | 'live' | 'none';
}

export interface HardCheck {
  id: string;
  verdict: CaseVerdict;
  detail: string;
}

export interface PhaseReport {
  schemaVersion: number;
  protocolId: string;
  protocolHash: string;
  scope: ReportScope;
  phase: ResearchPhase;
  invocationId: string;
  /** Repo-relative artifact root the phase wrote to; an independent verifier reads it back. */
  storageRootRef: string;
  inputRefs: ArtifactRef[];
  inputHash: string;
  goldSetHash: string | null;
  modelRoute: string | null;
  skillVersion: string | null;
  caseResults: CaseResult[];
  hardChecks: HardCheck[];
  qualityMetrics: Record<string, number | string | null>;
  unresolvedGaps: string[];
  rawResponseRefs: ArtifactRef[];
  /** Draft payloads a report was computed from; a verifier may recompute from these. */
  draftPaths: ArtifactRef[];
  attempted: number;
  llmCalls: number;
  status: CaseVerdict;
  startedAt: string;
  finishedAt: string;
  reportHash: string;
}

// ----------------- Primitive assertions -----------------

export function assertHash64(val: unknown, fieldPath: string): string {
  if (typeof val !== 'string' || !HEX64.test(val)) {
    throw new ResearchError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be 64-char lowercase hex`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function assertIsoUtc(val: unknown, fieldPath: string): string {
  if (val === null) return val as unknown as string;
  if (typeof val !== 'string' || !ISO_UTC.test(val)) {
    throw new ResearchError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be UTC ISO 8601`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function assertId(val: unknown, fieldPath: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be a non-empty string`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function assertFinite(val: unknown, fieldPath: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val < min || val > max) {
    throw new ResearchError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be a finite number in [${min},${max}]`, {
      fieldPaths: [fieldPath],
    });
  }
  return val;
}

export function assertNoExtraKeys(raw: unknown, allowed: readonly string[], context: string): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    const received = raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw;
    throw new ResearchError('SCHEMA_VIOLATION', `"${context}" must be a plain object, received ${received}`);
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      // Checked at this single choke point so no call-site ordering can turn an authority
      // violation into a retryable "unknown field" shape error.
      if ((FORBIDDEN_EXECUTION_FIELDS as readonly string[]).includes(key)) {
        throw new ResearchError('POLICY_DENIED', `Execution-layer field "${key}" is forbidden on ${context}`, {
          fieldPaths: [`${context}.${key}`],
        });
      }
      throw new ResearchError('SCHEMA_VIOLATION', `Unknown field "${key}" in ${context}`, {
        fieldPaths: [`${context}.${key}`],
      });
    }
  }
  return obj;
}

export function assertEnum<T extends string>(val: unknown, allowed: readonly T[], fieldPath: string): T {
  if (typeof val !== 'string' || !(allowed as readonly string[]).includes(val)) {
    throw new ResearchError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be one of ${allowed.join('|')}`, {
      fieldPaths: [fieldPath],
    });
  }
  return val as T;
}

function assertStringArray(val: unknown, fieldPath: string): string[] {
  if (!Array.isArray(val)) {
    throw new ResearchError('SCHEMA_VIOLATION', `Field "${fieldPath}" must be an array of strings`, {
      fieldPaths: [fieldPath],
    });
  }
  return val.map((item, i) => assertId(item, `${fieldPath}[${i}]`));
}

// ----------------- Forbidden execution-layer fields -----------------

/** Research cards must never impersonate execution-layer cards. */
export const FORBIDDEN_EXECUTION_FIELDS = [
  'implementationHash',
  'implementationId',
  'inputContract',
  'outputContract',
  'allowedSlots',
  'readyReportId',
  'tensorShape',
  'dtype',
  'channels',
  'slotId',
] as const;

export function assertNoExecutionFields(raw: unknown, context: string): void {
  const stack: Array<{ node: unknown; path: string }> = [{ node: raw, path: context }];
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (Array.isArray(node)) {
      node.forEach((item, i) => stack.push({ node: item, path: `${path}[${i}]` }));
      continue;
    }
    if (typeof node !== 'object' || node === null) continue;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((FORBIDDEN_EXECUTION_FIELDS as readonly string[]).includes(key)) {
        throw new ResearchError('POLICY_DENIED', `Execution-layer field "${key}" is forbidden on ${path}`, {
          fieldPaths: [`${path}.${key}`],
        });
      }
      stack.push({ node: value, path: `${path}.${key}` });
    }
  }
}

/** A research card may only ever be proposed; it must never self-declare ready. */
export function assertNotSelfDeclaredReady(raw: unknown, context: string): void {
  if (typeof raw !== 'object' || raw === null) return;
  const status = (raw as Record<string, unknown>).status;
  if (typeof status === 'string' && status !== 'proposed') {
    throw new ResearchError('POLICY_DENIED', `Only status "proposed" is legal for ${context}, got "${status}"`, {
      fieldPaths: [`${context}.status`],
    });
  }
}

// ----------------- Field classification tables (contract section 4) -----------------

export type FieldClass = 'metadata' | 'evidence_field' | 'structural_set' | 'host_derived';

export const PAPER_IDENTIFICATION_FIELDS: Record<string, FieldClass> = {
  paperId: 'metadata',
  documentHash: 'metadata',
  taskDomain: 'evidence_field',
  role: 'evidence_field',
  contributedMethods: 'evidence_field',
  builtOnBaselines: 'evidence_field',
  comparisonBaselines: 'evidence_field',
  moduleMentions: 'evidence_field',
  limitations: 'evidence_field',
  reportedResults: 'structural_set',
  ablations: 'evidence_field',
  evidenceSpans: 'metadata',
  coverage: 'host_derived',
  unresolvedFields: 'host_derived',
};

export const BASELINE_CARD_FIELDS: Record<string, FieldClass> = {
  id: 'metadata',
  revision: 'metadata',
  paperId: 'metadata',
  name: 'evidence_field',
  taskDomain: 'evidence_field',
  methodSummary: 'evidence_field',
  requirements: 'evidence_field',
  evidenceRefs: 'metadata',
  status: 'metadata',
  producerOperationId: 'metadata',
  documentHash: 'metadata',
};

export const MODULE_CARD_FIELDS: Record<string, FieldClass> = {
  id: 'metadata',
  revision: 'metadata',
  paperId: 'metadata',
  name: 'evidence_field',
  mechanism: 'evidence_field',
  interventionAxis: 'evidence_field',
  requirements: 'evidence_field',
  modifies: 'evidence_field',
  expectedOutput: 'evidence_field',
  builtOnBaselines: 'evidence_field',
  limitations: 'evidence_field',
  evidenceRefs: 'metadata',
  status: 'metadata',
  producerOperationId: 'metadata',
  documentHash: 'metadata',
};

function isEvidenceFieldShape(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    'value' in node &&
    'status' in node &&
    'evidenceRefs' in node &&
    'reason' in node
  );
}

/**
 * Enforces the per-field declaration classes: an evidence_field key must carry an
 * EvidenceField wrapper (or an array of them); a metadata key must not be wrapped.
 */
export function assertFieldClasses(
  raw: Record<string, unknown>,
  table: Record<string, FieldClass>,
  context: string
): void {
  for (const [field, cls] of Object.entries(table)) {
    const value = raw[field];
    if (value === undefined) continue;
    if (cls === 'evidence_field') {
      if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (!isEvidenceFieldShape(item)) {
            throw new ResearchError(
              'SCHEMA_VIOLATION',
              `${context}.${field}[${i}] must be an EvidenceField (value/status/evidenceRefs/reason)`,
              { fieldPaths: [`${context}.${field}[${i}]`] }
            );
          }
        });
      } else if (!isEvidenceFieldShape(value)) {
        throw new ResearchError('SCHEMA_VIOLATION', `${context}.${field} must be an EvidenceField wrapper`, {
          fieldPaths: [`${context}.${field}`],
        });
      }
    } else if (cls === 'metadata') {
      if (isEvidenceFieldShape(value)) {
        throw new ResearchError('SCHEMA_VIOLATION', `${context}.${field} is metadata and must not be an EvidenceField`, {
          fieldPaths: [`${context}.${field}`],
        });
      }
    }
  }
}

/**
 * A bare reference list is only as sound as the spans behind it. When the caller knows which spans
 * were actually published, every entry must name one, so a proposal can never trace to a citation
 * that does not exist - the same rule P5 applies to an EvidenceField.
 */
export function assertResolvableRefs(refs: string[], fieldPath: string, opts: EvidenceFieldValidationOptions = {}): void {
  if (!opts.knownSpanIds) return;
  for (const ref of refs) {
    if (!opts.knownSpanIds.has(ref)) {
      throw new ResearchError('EVIDENCE_INVALID', `${fieldPath}: evidenceRef "${ref}" does not resolve`, {
        fieldPaths: [fieldPath],
      });
    }
  }
}

// ----------------- EvidenceField validation -----------------

export interface EvidenceFieldValidationOptions {
  /** Span ids that exist and resolve against the frozen inputs. */
  knownSpanIds?: Set<string>;
  /** Section names visible to this request; source_reported may not cite invisible ones. */
  visibleSections?: Set<string>;
  spansById?: Map<string, EvidenceSpan>;
  pathPrefix?: string;
}

export function validateEvidenceField(raw: unknown, fieldPath: string, opts: EvidenceFieldValidationOptions = {}): void {
  const ef = assertNoExtraKeys(raw, ['value', 'status', 'evidenceRefs', 'reason'], fieldPath);
  const status = assertEnum(ef.status, EVIDENCE_STATUSES, `${fieldPath}.status`);
  const refs = assertStringArray(ef.evidenceRefs, `${fieldPath}.evidenceRefs`);
  const reason = ef.reason;
  if (reason !== null && typeof reason !== 'string') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.reason must be a string or null`, {
      fieldPaths: [`${fieldPath}.reason`],
    });
  }

  if (status === 'unknown') {
    if (ef.value !== null) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: status=unknown requires value=null`, {
        fieldPaths: [`${fieldPath}.value`],
      });
    }
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: status=unknown requires a non-empty reason`, {
        fieldPaths: [`${fieldPath}.reason`],
      });
    }
  } else {
    if (ef.value === null) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: status=${status} requires a non-null value`, {
        fieldPaths: [`${fieldPath}.value`],
      });
    }
    if (refs.length === 0) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: status=${status} requires at least one evidenceRef`, {
        fieldPaths: [`${fieldPath}.evidenceRefs`],
      });
    }
    if (status === 'inferred' || status === 'hypothesis') {
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: status=${status} requires a reason`, {
          fieldPaths: [`${fieldPath}.reason`],
        });
      }
    }
  }

  if (opts.knownSpanIds) {
    for (const ref of refs) {
      if (!opts.knownSpanIds.has(ref)) {
        throw new ResearchError('EVIDENCE_INVALID', `${fieldPath}: evidenceRef "${ref}" does not resolve`, {
          fieldPaths: [`${fieldPath}.evidenceRefs`],
        });
      }
    }
  }

  if (opts.spansById && opts.visibleSections) {
    for (const ref of refs) {
      const span = opts.spansById.get(ref);
      if (span && !opts.visibleSections.has(span.section)) {        throw new ResearchError('EVIDENCE_INVALID', `${fieldPath}: cites invisible section "${span.section}"`, {
          fieldPaths: [`${fieldPath}.evidenceRefs`],
        });
      }
    }
  }

  if (status === 'source_reported' && reason !== null && reason.trim().length === 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: reason must be null or non-empty`, {
      fieldPaths: [`${fieldPath}.reason`],
    });
  }
}

export const REQUEST_BASE_KEYS = ['commandId', 'protocolRef', 'evalInvocationId', 'sampleKey', 'budget'] as const;

/**
 *集合断言规则：一个 EvidenceField 集合里，null 占位项（整体未知）不能与实值项混排。
 * Empty array means "nothing was extracted this run", not "the paper has none".
 */
export function validateEvidenceFieldList(raw: unknown, fieldPath: string, opts: EvidenceFieldValidationOptions = {}): void {
  if (!Array.isArray(raw)) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath} must be an array`, { fieldPaths: [fieldPath] });
  }
  raw.forEach((item, i) => validateEvidenceField(item, `${fieldPath}[${i}]`, opts));
  const nullItems = raw.filter((item) => (item as EvidenceField<unknown>).value === null).length;
  if (nullItems > 0 && nullItems !== raw.length) {
    throw new ResearchError(
      'SCHEMA_VIOLATION',
      `${fieldPath}: a null/unknown placeholder entry may not be mixed with valued entries`,
      { fieldPaths: [fieldPath] }
    );
  }
  if (nullItems > 1) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: at most one unknown placeholder entry per set`, {
      fieldPaths: [fieldPath],
    });
  }
}

// ----------------- P5 validators -----------------

const PAPER_INPUT_KEYS = [
  'paperId',
  'title',
  'version',
  'sourceUri',
  'localTextRef',
  'documentHash',
  'availableSections',
] as const;

export function validatePaperInput(raw: unknown, fieldPath = 'PaperInput'): PaperInput {
  const o = assertNoExtraKeys(raw, PAPER_INPUT_KEYS, fieldPath);
  const ref = assertNoExtraKeys(o.localTextRef, ['id', 'sha256'], `${fieldPath}.localTextRef`);
  return {
    paperId: assertId(o.paperId, `${fieldPath}.paperId`),
    title: assertId(o.title, `${fieldPath}.title`),
    version: assertId(o.version, `${fieldPath}.version`),
    sourceUri: assertId(o.sourceUri, `${fieldPath}.sourceUri`),
    localTextRef: { id: assertId(ref.id, 'ref.id'), sha256: assertHash64(ref.sha256, 'ref.sha256') },
    documentHash: assertHash64(o.documentHash, `${fieldPath}.documentHash`),
    availableSections: assertStringArray(o.availableSections, `${fieldPath}.availableSections`),
  };
}

const PAPER_IDENTIFICATION_KEYS = Object.keys(PAPER_IDENTIFICATION_FIELDS);

export function validatePaperIdentification(
  raw: unknown,
  fieldPath = 'PaperIdentification',
  opts: EvidenceFieldValidationOptions = {}
): PaperIdentification {
  const o = assertNoExtraKeys(raw, PAPER_IDENTIFICATION_KEYS, fieldPath);
  assertFieldClasses(o, PAPER_IDENTIFICATION_FIELDS, fieldPath);
  assertNoExecutionFields(o, fieldPath);

  assertId(o.paperId, `${fieldPath}.paperId`);
  assertHash64(o.documentHash, `${fieldPath}.documentHash`);

  validateEvidenceField(o.taskDomain, `${fieldPath}.taskDomain`, opts);
  validateEvidenceField(o.role, `${fieldPath}.role`, opts);
  const taskDomainValue = (o.taskDomain as EvidenceField<TaskDomain>).value;
  if (taskDomainValue !== null) assertEnum(taskDomainValue, TASK_DOMAINS, `${fieldPath}.taskDomain.value`);
  const roleValue = (o.role as EvidenceField<Role>).value;
  if (roleValue !== null) assertEnum(roleValue, ROLES, `${fieldPath}.role.value`);

  for (const key of ['contributedMethods', 'builtOnBaselines', 'comparisonBaselines', 'moduleMentions', 'limitations', 'ablations'] as const) {
    validateEvidenceFieldList(o[key], `${fieldPath}.${key}`, opts);
  }

  if (!Array.isArray(o.reportedResults)) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.reportedResults must be an array`);
  }
  o.reportedResults.forEach((r, i) => validateReportedResult(r, `${fieldPath}.reportedResults[${i}]`, opts));

  assertStringArray(o.evidenceSpans, `${fieldPath}.evidenceSpans`).forEach((ref) => {
    if (opts.knownSpanIds && !opts.knownSpanIds.has(ref)) {
      throw new ResearchError('EVIDENCE_INVALID', `${fieldPath}.evidenceSpans: unresolved span "${ref}"`);
    }
  });

  const coverage = assertEnum(o.coverage, COVERAGE_VALUES, `${fieldPath}.coverage`);
  if (!Array.isArray(o.unresolvedFields)) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.unresolvedFields must be an array`);
  }
  const unresolved = o.unresolvedFields.map((u, i) => {
    const item = assertNoExtraKeys(u, ['fieldPath', 'reason'], `${fieldPath}.unresolvedFields[${i}]`);
    return { fieldPath: assertId(item.fieldPath, 'fieldPath'), reason: assertId(item.reason, 'reason') };
  });

  if (coverage === 'insufficient_evidence') {
    const hasValuedEntity =
      (roleValue !== null && roleValue !== 'unclear') ||
      (o.contributedMethods as EvidenceField<string>[]).some((e) => e.value !== null) ||
      (o.moduleMentions as EvidenceField<string>[]).some((e) => e.value !== null);
    if (hasValuedEntity) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: coverage=insufficient_evidence conflicts with valued entities`, {
        fieldPaths: [`${fieldPath}.coverage`],
      });
    }
  }

  return {
    paperId: o.paperId as string,
    documentHash: o.documentHash as string,
    taskDomain: o.taskDomain as EvidenceField<TaskDomain>,
    role: o.role as EvidenceField<Role>,
    contributedMethods: o.contributedMethods as EvidenceField<string>[],
    builtOnBaselines: o.builtOnBaselines as EvidenceField<string>[],
    comparisonBaselines: o.comparisonBaselines as EvidenceField<string>[],
    moduleMentions: o.moduleMentions as EvidenceField<string>[],
    limitations: o.limitations as EvidenceField<string>[],
    reportedResults: o.reportedResults as ReportedResult[],
    ablations: o.ablations as EvidenceField<string>[],
    evidenceSpans: o.evidenceSpans as string[],
    coverage,
    unresolvedFields: unresolved,
  };
}

const REPORTED_RESULT_KEYS = [
  'metric',
  'value',
  'unit',
  'dataset',
  'split',
  'baseline',
  'configuration',
  'hardware',
  'comparability',
  'sourceEvidence',
] as const;

export function validateReportedResult(
  raw: unknown,
  fieldPath = 'ReportedResult',
  opts: EvidenceFieldValidationOptions = {}
): ReportedResult {
  const o = assertNoExtraKeys(raw, REPORTED_RESULT_KEYS, fieldPath);
  validateEvidenceField(o.metric, `${fieldPath}.metric`, opts);
  const metricWrapper = o.metric as EvidenceField<MetricSpec>;
  if (metricWrapper.value !== null) {
    const m = assertNoExtraKeys(metricWrapper.value, ['name', 'direction'], `${fieldPath}.metric.value`);
    assertId(m.name, `${fieldPath}.metric.value.name`);
    assertEnum(m.direction, METRIC_DIRECTIONS, `${fieldPath}.metric.value.direction`);
  }
  for (const key of ['value', 'unit', 'dataset', 'split', 'baseline', 'configuration', 'hardware'] as const) {
    validateEvidenceField(o[key], `${fieldPath}.${key}`, opts);
  }
  const comparability = assertEnum(o.comparability, COMPARABILITY_VALUES, `${fieldPath}.comparability`);
  assertStringArray(o.sourceEvidence, `${fieldPath}.sourceEvidence`);
  return {
    metric: metricWrapper,
    value: o.value as EvidenceField<string>,
    unit: o.unit as EvidenceField<string>,
    dataset: o.dataset as EvidenceField<string>,
    split: o.split as EvidenceField<string>,
    baseline: o.baseline as EvidenceField<string>,
    configuration: o.configuration as EvidenceField<string>,
    hardware: o.hardware as EvidenceField<string>,
    comparability,
    sourceEvidence: o.sourceEvidence as string[],
  };
}

export function validateEvidenceSpan(raw: unknown, fieldPath = 'EvidenceSpan'): EvidenceSpan {
  const o = assertNoExtraKeys(raw, ['id', 'paperId', 'documentHash', 'section', 'start', 'end', 'quote', 'quoteHash'], fieldPath);
  const start = assertFinite(o.start, `${fieldPath}.start`);
  const end = assertFinite(o.end, `${fieldPath}.end`, 0);
  if (end <= start) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: end must be greater than start`, {
      fieldPaths: [`${fieldPath}.end`],
    });
  }
  const quote = typeof o.quote === 'string' ? o.quote : null;
  if (quote === null) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.quote must be a string`, { fieldPaths: [`${fieldPath}.quote`] });
  }
  return {
    id: assertId(o.id, `${fieldPath}.id`),
    paperId: assertId(o.paperId, `${fieldPath}.paperId`),
    documentHash: assertHash64(o.documentHash, `${fieldPath}.documentHash`),
    section: assertId(o.section, `${fieldPath}.section`),
    start,
    end,
    quote,
    quoteHash: assertHash64(o.quoteHash, `${fieldPath}.quoteHash`),
  };
}

const BASELINE_CARD_KEYS = Object.keys(BASELINE_CARD_FIELDS);
const MODULE_CARD_KEYS = Object.keys(MODULE_CARD_FIELDS);

export function validateBaselineCard(
  raw: unknown,
  fieldPath = 'ResearchBaselineCard',
  opts: EvidenceFieldValidationOptions = {}
): ResearchBaselineCard {
  const o = assertNoExtraKeys(raw, BASELINE_CARD_KEYS, fieldPath);
  assertFieldClasses(o, BASELINE_CARD_FIELDS, fieldPath);
  assertNoExecutionFields(o, fieldPath);
  assertNotSelfDeclaredReady(o, fieldPath);
  if (o.status !== 'proposed') {
    throw new ResearchError('POLICY_DENIED', `${fieldPath}.status must be "proposed"`, { fieldPaths: [`${fieldPath}.status`] });
  }
  assertId(o.id, `${fieldPath}.id`);
  assertFinite(o.revision, `${fieldPath}.revision`, 1);
  assertId(o.paperId, `${fieldPath}.paperId`);
  assertHash64(o.documentHash, `${fieldPath}.documentHash`);
  assertId(o.producerOperationId, `${fieldPath}.producerOperationId`);
  validateEvidenceField(o.name, `${fieldPath}.name`, opts);
  validateEvidenceField(o.taskDomain, `${fieldPath}.taskDomain`, opts);
  validateEvidenceField(o.methodSummary, `${fieldPath}.methodSummary`, opts);
  validateEvidenceFieldList(o.requirements, `${fieldPath}.requirements`, opts);
  assertStringArray(o.evidenceRefs, `${fieldPath}.evidenceRefs`);
  const taskDomainValue = (o.taskDomain as EvidenceField<TaskDomain>).value;
  if (taskDomainValue !== null) assertEnum(taskDomainValue, TASK_DOMAINS, `${fieldPath}.taskDomain.value`);
  return raw as ResearchBaselineCard;
}

export function validateModuleCard(
  raw: unknown,
  fieldPath = 'ResearchModuleCard',
  opts: EvidenceFieldValidationOptions = {}
): ResearchModuleCard {
  const o = assertNoExtraKeys(raw, MODULE_CARD_KEYS, fieldPath);
  assertFieldClasses(o, MODULE_CARD_FIELDS, fieldPath);
  assertNoExecutionFields(o, fieldPath);
  assertNotSelfDeclaredReady(o, fieldPath);
  if (o.status !== 'proposed') {
    throw new ResearchError('POLICY_DENIED', `${fieldPath}.status must be "proposed"`, { fieldPaths: [`${fieldPath}.status`] });
  }
  assertId(o.id, `${fieldPath}.id`);
  assertFinite(o.revision, `${fieldPath}.revision`, 1);
  assertId(o.paperId, `${fieldPath}.paperId`);
  assertHash64(o.documentHash, `${fieldPath}.documentHash`);
  assertId(o.producerOperationId, `${fieldPath}.producerOperationId`);
  validateEvidenceField(o.name, `${fieldPath}.name`, opts);
  validateEvidenceField(o.mechanism, `${fieldPath}.mechanism`, opts);
  validateEvidenceField(o.interventionAxis, `${fieldPath}.interventionAxis`, opts);
  validateEvidenceFieldList(o.requirements, `${fieldPath}.requirements`, opts);
  validateEvidenceField(o.modifies, `${fieldPath}.modifies`, opts);
  validateEvidenceField(o.expectedOutput, `${fieldPath}.expectedOutput`, opts);
  validateEvidenceFieldList(o.builtOnBaselines, `${fieldPath}.builtOnBaselines`, opts);
  validateEvidenceFieldList(o.limitations, `${fieldPath}.limitations`, opts);
  assertStringArray(o.evidenceRefs, `${fieldPath}.evidenceRefs`);

  const axis = o.interventionAxis as EvidenceField<InterventionAxis>;
  if (axis.value !== null) {
    assertEnum(axis.value, INTERVENTION_AXES, `${fieldPath}.interventionAxis.value`);
    if (axis.value === 'other' && !(typeof axis.reason === 'string' && axis.reason.trim().length > 0)) {
      throw new ResearchError(
        'SCHEMA_VIOLATION',
        `${fieldPath}: interventionAxis=other requires a reviewable mechanism-location reason`,
        { fieldPaths: [`${fieldPath}.interventionAxis.reason`] }
      );
    }
  }
  return raw as ResearchModuleCard;
}

export function validateDiscoveryResult(raw: unknown, fieldPath = 'DiscoveryResult', opts: EvidenceFieldValidationOptions = {}): DiscoveryResult {
  const o = assertNoExtraKeys(raw, ['schemaVersion', 'identifications', 'baselineCards', 'moduleCards', 'evidenceSpans', 'producerOperationId'], fieldPath);
  assertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1);
  assertId(o.producerOperationId, `${fieldPath}.producerOperationId`);
  if (!Array.isArray(o.identifications) || !Array.isArray(o.baselineCards) || !Array.isArray(o.moduleCards) || !Array.isArray(o.evidenceSpans)) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: all collections must be arrays`);
  }
  const spans = o.evidenceSpans.map((s, i) => validateEvidenceSpan(s, `${fieldPath}.evidenceSpans[${i}]`));
  const spanOpts: EvidenceFieldValidationOptions = {
    ...opts,
    knownSpanIds: new Set(spans.map((s) => s.id)),
    spansById: new Map(spans.map((s) => [s.id, s])),
  };
  o.identifications.forEach((idn, i) => validatePaperIdentification(idn, `${fieldPath}.identifications[${i}]`, spanOpts));
  o.baselineCards.forEach((c, i) => validateBaselineCard(c, `${fieldPath}.baselineCards[${i}]`, spanOpts));
  o.moduleCards.forEach((c, i) => validateModuleCard(c, `${fieldPath}.moduleCards[${i}]`, spanOpts));
  return {
    schemaVersion: o.schemaVersion as number,
    identifications: o.identifications as PaperIdentification[],
    baselineCards: o.baselineCards as ResearchBaselineCard[],
    moduleCards: o.moduleCards as ResearchModuleCard[],
    evidenceSpans: spans,
    producerOperationId: o.producerOperationId as string,
  };
}

// ----------------- P6 validators -----------------

const TASK_BRIEF_KEYS = ['taskId', 'researchQuestion', 'domain', 'baselineCardRef', 'allowedModuleRefs', 'constraints', 'corpusHash'] as const;

export function validateCardRef(raw: unknown, fieldPath = 'CardRef'): CardRef {
  const o = assertNoExtraKeys(raw, ['id', 'revision', 'sha256', 'producerOperationId'], fieldPath);
  return {
    id: assertId(o.id, `${fieldPath}.id`),
    revision: assertFinite(o.revision, `${fieldPath}.revision`, 1),
    sha256: assertHash64(o.sha256, `${fieldPath}.sha256`),
    producerOperationId: assertId(o.producerOperationId, `${fieldPath}.producerOperationId`),
  };
}

export function validateScoringPolicyRef(raw: unknown, fieldPath = 'scoringPolicyRef'): ScoringPolicyRef {
  const o = assertNoExtraKeys(raw, ['policyId', 'sha256'], fieldPath);
  return { policyId: assertId(o.policyId, `${fieldPath}.policyId`), sha256: assertHash64(o.sha256, `${fieldPath}.sha256`) };
}

export function validateTaskBrief(raw: unknown, fieldPath = 'ResearchTaskBrief'): ResearchTaskBrief {
  const o = assertNoExtraKeys(raw, TASK_BRIEF_KEYS, fieldPath);
  assertId(o.taskId, `${fieldPath}.taskId`);
  assertId(o.researchQuestion, `${fieldPath}.researchQuestion`);
  assertEnum(o.domain, TASK_DOMAINS, `${fieldPath}.domain`);
  assertHash64(o.corpusHash, `${fieldPath}.corpusHash`);
  const baselineCardRef = validateCardRef(o.baselineCardRef, `${fieldPath}.baselineCardRef`);
  if (!Array.isArray(o.allowedModuleRefs)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.allowedModuleRefs must be an array`);
  const allowedModuleRefs = o.allowedModuleRefs.map((r, i) => validateCardRef(r, `${fieldPath}.allowedModuleRefs[${i}]`));
  if (!Array.isArray(o.constraints)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.constraints must be an array`);
  const constraints = o.constraints.map((c, i) => {
    const item = assertNoExtraKeys(c, ['id', 'kind', 'value', 'evidenceRefs'], `${fieldPath}.constraints[${i}]`);
    assertId(item.id, 'constraint.id');
    assertEnum(item.kind, CONSTRAINT_KINDS, 'constraint.kind');
    assertId(item.value, 'constraint.value');
    assertStringArray(item.evidenceRefs, 'constraint.evidenceRefs');
    return item as unknown as TaskConstraint;
  });
  return {
    taskId: o.taskId as string,
    researchQuestion: o.researchQuestion as string,
    domain: o.domain as TaskDomain,
    baselineCardRef,
    allowedModuleRefs,
    constraints,
    corpusHash: o.corpusHash as string,
  };
}

const REQUIREMENT_KEYS = ['id', 'category', 'description', 'resolution', 'basisRefs'] as const;

export function validateRequirement(raw: unknown, fieldPath = 'Requirement', opts: EvidenceFieldValidationOptions = {}): Requirement {
  const o = assertNoExtraKeys(raw, REQUIREMENT_KEYS, fieldPath);
  assertId(o.id, `${fieldPath}.id`);
  assertEnum(o.category, REQUIREMENT_CATEGORIES, `${fieldPath}.category`);
  validateEvidenceField(o.description, `${fieldPath}.description`, opts);
  assertEnum(o.resolution, REQUIREMENT_RESOLUTIONS, `${fieldPath}.resolution`);
  assertStringArray(o.basisRefs, `${fieldPath}.basisRefs`);
  return raw as Requirement;
}

const ASSESSMENT_KEYS = [
  'baselineCardRef',
  'moduleCardRefs',
  'scope',
  'decision',
  'requirements',
  'unresolvedConditions',
  'reasonCodes',
  'rationale',
  'evidenceRefs',
  'interfaceStatus',
] as const;

export function validateCompatibilityAssessment(
  raw: unknown,
  fieldPath = 'CompatibilityAssessment',
  opts: EvidenceFieldValidationOptions = {}
): CompatibilityAssessment {
  const o = assertNoExtraKeys(raw, ASSESSMENT_KEYS, fieldPath);
  if (o.scope !== 'mechanism_only') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.scope must be "mechanism_only"`, { fieldPaths: [`${fieldPath}.scope`] });
  }
  if (o.interfaceStatus !== 'NOT_VERIFIED') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.interfaceStatus must be "NOT_VERIFIED"`, {
      fieldPaths: [`${fieldPath}.interfaceStatus`],
    });
  }
  const decision = assertEnum(o.decision, COMPATIBILITY_DECISIONS, `${fieldPath}.decision`);
  validateCardRef(o.baselineCardRef, `${fieldPath}.baselineCardRef`);
  if (!Array.isArray(o.moduleCardRefs)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.moduleCardRefs must be an array`);
  o.moduleCardRefs.forEach((r, i) => validateCardRef(r, `${fieldPath}.moduleCardRefs[${i}]`));
  if (!Array.isArray(o.requirements)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.requirements must be an array`);
  o.requirements.forEach((r, i) => validateRequirement(r, `${fieldPath}.requirements[${i}]`, opts));
  const unresolvedConditions = assertStringArray(o.unresolvedConditions, `${fieldPath}.unresolvedConditions`);
  const reasonCodes = assertStringArray(o.reasonCodes, `${fieldPath}.reasonCodes`).map((c, i) =>
    assertEnum(c, REASON_CODES, `${fieldPath}.reasonCodes[${i}]`)
  ) as ReasonCode[];
  assertId(o.rationale, `${fieldPath}.rationale`);
  assertResolvableRefs(assertStringArray(o.evidenceRefs, `${fieldPath}.evidenceRefs`), `${fieldPath}.evidenceRefs`, opts);

  const hasRejecting = reasonCodes.some((c) => REJECTING_REASON_CODES.includes(c));
  if (hasRejecting && decision === 'compatible') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: a rejecting reasonCode cannot accompany compatible`, {
      fieldPaths: [`${fieldPath}.reasonCodes`, `${fieldPath}.decision`],
    });
  }
  if (decision === 'compatible' && unresolvedConditions.length > 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: compatible may not carry unresolved conditions`, {
      fieldPaths: [`${fieldPath}.unresolvedConditions`],
    });
  }
  if (decision === 'conditionally_compatible' && unresolvedConditions.length === 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: conditionally_compatible requires unresolved conditions`, {
      fieldPaths: [`${fieldPath}.unresolvedConditions`],
    });
  }
  if (decision === 'insufficient_evidence') {
    if (!reasonCodes.includes('EVIDENCE_MISSING')) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: insufficient_evidence requires EVIDENCE_MISSING`, {
        fieldPaths: [`${fieldPath}.reasonCodes`],
      });
    }
    if (reasonCodes.some((c) => REJECTING_REASON_CODES.includes(c))) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: insufficient_evidence may not assert a known conflict`, {
        fieldPaths: [`${fieldPath}.reasonCodes`],
      });
    }
  }
  if (reasonCodes.length === 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: reasonCodes may not be empty`, {
      fieldPaths: [`${fieldPath}.reasonCodes`],
    });
  }
  return raw as CompatibilityAssessment;
}

const CANDIDATE_KEYS = [
  'contractVersion',
  'id',
  'candidateHash',
  'taskBriefHash',
  'baselineCardRef',
  'moduleCardRefs',
  'compatibility',
  'mechanismHypothesis',
  'conceptualBindings',
  'expectedEffects',
  'risks',
  'requiredValidation',
  'ablationMatrix',
  'evidenceRefs',
  'decision',
  'performanceStatus',
] as const;

export const MAX_MODULES_PER_CANDIDATE = 3;
export const MAX_MODULES_PER_CANDIDATE_V2 = 8;
export type SynthesisContractVersion = 1 | 2;

export function validateSynthesisContractVersion(value: unknown): SynthesisContractVersion {
  if (value !== 1 && value !== 2) throw new ResearchError('SCHEMA_VIOLATION', 'Unsupported synthesis contract version');
  return value;
}

/** V1 is the frozen full factorial plan; v2 bounds planning cost with leave-one-out. */
export function synthesisVariants(refs: CardRef[], version: SynthesisContractVersion = 1): Array<{ variantId: string; moduleRefs: string[] }> {
  validateSynthesisContractVersion(version);
  const max = version === 1 ? MAX_MODULES_PER_CANDIDATE : MAX_MODULES_PER_CANDIDATE_V2;
  if (refs.length > max || new Set(refs.map(r => r.id)).size !== refs.length) {
    throw new ResearchError('SCHEMA_VIOLATION', `Synthesis v${version} requires unique modules, at most ${max}`, { fieldPaths: ['moduleCardRefs'] });
  }
  const sorted = [...refs].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : a.revision - b.revision);
  const full = (1 << sorted.length) - 1;
  const masks = version === 1 ? Array.from({ length: full + 1 }, (_, i) => i)
    : [...new Set([0, full, ...sorted.map((_, i) => full ^ (1 << i))])].sort((a, b) => a - b);
  return masks.map(mask => ({
    variantId: mask === 0 ? 'baseline' : sorted.map((_, i) => mask & (1 << i) ? String.fromCharCode(65 + i) : '').join(''),
    moduleRefs: sorted.filter((_, i) => mask & (1 << i)).map(r => r.id),
  }));
}

export function validateCandidate(raw: unknown, fieldPath = 'ResearchCandidate', opts: EvidenceFieldValidationOptions = {}): ResearchCandidate {
  const o = assertNoExtraKeys(raw, CANDIDATE_KEYS, fieldPath);
  assertNoExecutionFields(o, fieldPath);
  assertId(o.id, `${fieldPath}.id`);
  assertHash64(o.candidateHash, `${fieldPath}.candidateHash`);
  assertHash64(o.taskBriefHash, `${fieldPath}.taskBriefHash`);
  validateCardRef(o.baselineCardRef, `${fieldPath}.baselineCardRef`);
  if (!Array.isArray(o.moduleCardRefs)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.moduleCardRefs must be an array`);
  o.moduleCardRefs.forEach((r, i) => validateCardRef(r, `${fieldPath}.moduleCardRefs[${i}]`));
  const version = o.contractVersion === undefined ? 1 : validateSynthesisContractVersion(o.contractVersion);
  if (o.contractVersion !== undefined && version !== 2) throw new ResearchError('SCHEMA_VIOLATION', 'V1 candidates must omit contractVersion');
  const maxModules = version === 1 ? MAX_MODULES_PER_CANDIDATE : MAX_MODULES_PER_CANDIDATE_V2;
  if (o.moduleCardRefs.length > maxModules) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: at most ${maxModules} modules per candidate`, {
      fieldPaths: [`${fieldPath}.moduleCardRefs`],
    });
  }
  const decision = assertEnum(o.decision, CANDIDATE_DECISIONS, `${fieldPath}.decision`);
  if (o.performanceStatus !== 'NOT_VERIFIED') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.performanceStatus must be NOT_VERIFIED`, {
      fieldPaths: [`${fieldPath}.performanceStatus`],
    });
  }
  const assessment = validateCompatibilityAssessment(o.compatibility, `${fieldPath}.compatibility`, opts);
  const derived = deriveCandidateDecision(assessment.decision);
  if (derived !== decision) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: decision "${decision}" does not follow compatibility "${assessment.decision}"`, {
      fieldPaths: [`${fieldPath}.decision`],
    });
  }
  if (!Array.isArray(o.conceptualBindings)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.conceptualBindings must be an array`);
  o.conceptualBindings.forEach((b, i) => validateConceptualBinding(b, `${fieldPath}.conceptualBindings[${i}]`, opts));
  for (const key of ['expectedEffects', 'risks', 'requiredValidation'] as const) {
    validateEvidenceFieldList(o[key], `${fieldPath}.${key}`, opts);
  }
  validateEvidenceField(o.mechanismHypothesis, `${fieldPath}.mechanismHypothesis`, opts);
  const hypothesis = o.mechanismHypothesis as EvidenceField<string>;
  if (decision === 'proposed' || decision === 'conditional') {
    if (hypothesis.status !== 'hypothesis' || hypothesis.value === null) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: proposed/conditional candidates need a hypothesis-status mechanismHypothesis`, {
        fieldPaths: [`${fieldPath}.mechanismHypothesis.status`],
      });
    }
    for (const key of ['risks', 'requiredValidation'] as const) {
      if ((o[key] as EvidenceField<string>[]).length === 0 || (o[key] as EvidenceField<string>[]).every((e) => e.value === null)) {
        throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: ${key} must be non-empty for ${decision} candidates`, {
          fieldPaths: [`${fieldPath}.${key}`],
        });
      }
    }
  } else if (hypothesis.status !== 'unknown') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: rejected/insufficient candidates must not carry a hypothesis`, {
      fieldPaths: [`${fieldPath}.mechanismHypothesis.status`],
    });
  }
  assertResolvableRefs(assertStringArray(o.evidenceRefs, `${fieldPath}.evidenceRefs`), `${fieldPath}.evidenceRefs`, opts);
  if (!Array.isArray(o.ablationMatrix)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.ablationMatrix must be an array`);
  o.ablationMatrix.forEach((r, i) => validateAblationRow(r, `${fieldPath}.ablationMatrix[${i}]`));
  // The matrix is derived from the module set, so a truncated or padded one is a defect.
  const expectedVariants = synthesisVariants(o.moduleCardRefs as CardRef[], version);
  const requiredRows = expectedVariants.length;
  if (decision === 'proposed' || decision === 'conditional') {
    if (o.ablationMatrix.length !== requiredRows) {
      throw new ResearchError(
        'SCHEMA_VIOLATION',
        `${fieldPath}: ${o.moduleCardRefs.length} module(s) require exactly ${requiredRows} matrix rows, got ${o.ablationMatrix.length}`,
        { fieldPaths: [`${fieldPath}.ablationMatrix`] }
      );
    }
    const seenVariants = new Set<string>();
    for (const row of o.ablationMatrix as AblationRow[]) {
      if (seenVariants.has(row.variantId)) {
        throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: duplicate variant id "${row.variantId}"`, {
          fieldPaths: [`${fieldPath}.ablationMatrix`],
        });
      }
      seenVariants.add(row.variantId);
      const expected = expectedVariants.find(v => v.variantId === row.variantId);
      if (!expected || JSON.stringify([...row.moduleRefs].sort()) !== JSON.stringify([...expected.moduleRefs].sort())) {
        throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: incorrect module subset for variant ${row.variantId}`);
      }
      if (row.moduleRefs.length > o.moduleCardRefs.length) {
        throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: variant "${row.variantId}" references modules outside the candidate`, {
          fieldPaths: [`${fieldPath}.ablationMatrix`],
        });
      }
    }
  } else if (o.ablationMatrix.length > 0) {
    throw new ResearchError(
      'SCHEMA_VIOLATION',
      `${fieldPath}: a ${decision} candidate may not export an executable-looking experiment plan`,
      { fieldPaths: [`${fieldPath}.ablationMatrix`] }
    );
  }
  return raw as ResearchCandidate;
}

export function deriveCandidateDecision(decision: CompatibilityDecision): CandidateDecision {
  switch (decision) {
    case 'compatible':
      return 'proposed';
    case 'conditionally_compatible':
      return 'conditional';
    case 'reject_for_mvp':
      return 'rejected';
    case 'insufficient_evidence':
      return 'insufficient_evidence';
  }
}

const BINDING_KEYS = ['moduleRef', 'axis', 'targetConcept', 'relation', 'requiredInputs'] as const;

export function validateConceptualBinding(
  raw: unknown,
  fieldPath = 'ConceptualBinding',
  opts: EvidenceFieldValidationOptions = {}
): ConceptualBinding {
  const o = assertNoExtraKeys(raw, BINDING_KEYS, fieldPath);
  validateCardRef(o.moduleRef, `${fieldPath}.moduleRef`);
  assertEnum(o.axis, INTERVENTION_AXES, `${fieldPath}.axis`);
  validateEvidenceField(o.targetConcept, `${fieldPath}.targetConcept`, opts);
  assertEnum(o.relation, BINDING_RELATIONS, `${fieldPath}.relation`);
  validateEvidenceFieldList(o.requiredInputs, `${fieldPath}.requiredInputs`, opts);
  return raw as ConceptualBinding;
}

const ABLATION_ROW_KEYS = [
  'variantId',
  'moduleRefs',
  'baselineCardRef',
  'taskBriefHash',
  'status',
  'controlledVariables',
  'evaluationQuestions',
] as const;

export const PENDING_FREEZE = 'to_be_frozen' as const;
export const CONTROLLED_VARIABLE_KEYS = ['dataset', 'split', 'seeds', 'budget', 'metric'] as const;

export function validateAblationRow(raw: unknown, fieldPath = 'AblationRow'): AblationRow {
  const o = assertNoExtraKeys(raw, ABLATION_ROW_KEYS, fieldPath);
  assertId(o.variantId, `${fieldPath}.variantId`);
  if (o.status !== 'planned') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.status must be "planned"`, { fieldPaths: [`${fieldPath}.status`] });
  }
  assertStringArray(o.moduleRefs, `${fieldPath}.moduleRefs`);
  validateCardRef(o.baselineCardRef, `${fieldPath}.baselineCardRef`);
  assertHash64(o.taskBriefHash, `${fieldPath}.taskBriefHash`);
  const cv = assertNoExtraKeys(o.controlledVariables, CONTROLLED_VARIABLE_KEYS, `${fieldPath}.controlledVariables`);
  for (const key of CONTROLLED_VARIABLE_KEYS) {
    const v = cv[key];
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.controlledVariables.${key} must be a non-empty string`, {
        fieldPaths: [`${fieldPath}.controlledVariables.${key}`],
      });
    }
  }
  const evaluationQuestions = assertStringArray(o.evaluationQuestions, `${fieldPath}.evaluationQuestions`);
  if (evaluationQuestions.length === 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.evaluationQuestions must be non-empty`, {
      fieldPaths: [`${fieldPath}.evaluationQuestions`],
    });
  }
  return raw as AblationRow;
}

export function validateSynthesisResult(raw: unknown, fieldPath = 'SynthesisResult', opts: EvidenceFieldValidationOptions = {}): SynthesisResult {
  const o = assertNoExtraKeys(raw, ['schemaVersion', 'taskBriefHash', 'assessments', 'candidates', 'proposalRef', 'producerOperationId'], fieldPath);
  const version = validateSynthesisContractVersion(o.schemaVersion);
  assertHash64(o.taskBriefHash, `${fieldPath}.taskBriefHash`);
  assertId(o.producerOperationId, `${fieldPath}.producerOperationId`);
  const ref = assertNoExtraKeys(o.proposalRef, ['id', 'sha256'], `${fieldPath}.proposalRef`);
  assertId(ref.id, 'proposalRef.id');
  assertHash64(ref.sha256, 'proposalRef.sha256');
  if (!Array.isArray(o.assessments) || !Array.isArray(o.candidates)) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: assessments/candidates must be arrays`);
  }
  o.assessments.forEach((a, i) => validateCompatibilityAssessment(a, `${fieldPath}.assessments[${i}]`, opts));
  o.candidates.forEach((c, i) => {
    const candidate = validateCandidate(c, `${fieldPath}.candidates[${i}]`, opts);
    if ((candidate.contractVersion ?? 1) !== version) throw new ResearchError('SCHEMA_VIOLATION', 'Synthesis result/candidate version mismatch');
  });
  return raw as SynthesisResult;
}

// ----------------- P7 validators -----------------

export function validateDimensionResult(raw: unknown, fieldPath = 'DimensionResult'): DimensionResult {
  const o = assertNoExtraKeys(raw, ['value', 'level', 'ruleId', 'inputPaths', 'evidenceRefs', 'rationaleTemplateId'], fieldPath);
  if (o.value !== null) {
    const v = assertFinite(o.value, `${fieldPath}.value`, 0, 1);
    if (Number.isNaN(v)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.value must not be NaN`);
  }
  if (o.level !== null) {
    const level = assertFinite(o.level, `${fieldPath}.level`, 0, 2);
    if (![0, 1, 2].includes(level)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.level must be 0, 1, or 2`);
  }
  if ((o.value === null) !== (o.level === null)) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: value and level must be null together`, {
      fieldPaths: [`${fieldPath}.value`, `${fieldPath}.level`],
    });
  }
  assertId(o.ruleId, `${fieldPath}.ruleId`);
  assertStringArray(o.inputPaths, `${fieldPath}.inputPaths`);
  assertStringArray(o.evidenceRefs, `${fieldPath}.evidenceRefs`);
  assertId(o.rationaleTemplateId, `${fieldPath}.rationaleTemplateId`);
  return raw as DimensionResult;
}

export function validateRankingItem(raw: unknown, fieldPath = 'RankingItem'): RankingItem {
  const o = assertNoExtraKeys(
    raw,
    [
      'candidateId',
      'candidateHash',
      'originalDecision',
      'group',
      'dimensionResults',
      'scoreNumerator',
      'design_score',
      'rank',
      'reasonCodes',
      'unresolvedConditions',
      'uncertainty',
      'exclusionReasons',
    ],
    fieldPath
  );
  assertId(o.candidateId, `${fieldPath}.candidateId`);
  assertHash64(o.candidateHash, `${fieldPath}.candidateHash`);
  assertEnum(o.originalDecision, CANDIDATE_DECISIONS, `${fieldPath}.originalDecision`);
  const group = assertEnum(o.group, RANKING_GROUPS, `${fieldPath}.group`);
  const dims = assertNoExtraKeys(o.dimensionResults, SCORING_DIMENSIONS, `${fieldPath}.dimensionResults`);
  for (const d of SCORING_DIMENSIONS) {
    validateDimensionResult(dims[d], `${fieldPath}.dimensionResults.${d}`);
  }
  if (o.scoreNumerator !== null) assertFinite(o.scoreNumerator, `${fieldPath}.scoreNumerator`, 0, 100);
  if (o.design_score !== null) assertFinite(o.design_score, `${fieldPath}.design_score`, 0, 1);
  if (o.rank !== null) assertFinite(o.rank, `${fieldPath}.rank`, 1);
  if (group === 'excluded') {
    if (o.scoreNumerator !== null || o.design_score !== null || o.rank !== null) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: excluded items may not carry a score or rank`, {
        fieldPaths: [`${fieldPath}.design_score`, `${fieldPath}.rank`],
      });
    }
    if ((o.exclusionReasons as string[]).length === 0) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: excluded items must record exclusion reasons`, {
        fieldPaths: [`${fieldPath}.exclusionReasons`],
      });
    }
  }
  if (group === 'not_rankable') {
    if (o.design_score !== null || o.rank !== null) {
      throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: not_rankable items may not carry a total score or rank`);
    }
  }
  if ((group === 'eligible' || group === 'conditional') && (o.design_score === null || o.rank === null)) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: ${group} items require design_score and rank`);
  }
  assertStringArray(o.reasonCodes, `${fieldPath}.reasonCodes`);
  assertStringArray(o.unresolvedConditions, `${fieldPath}.unresolvedConditions`);
  assertStringArray(o.exclusionReasons, `${fieldPath}.exclusionReasons`);
  const u = assertNoExtraKeys(o.uncertainty, ['nullDimensionCount', 'unsupportedRubricDimensions'], `${fieldPath}.uncertainty`);
  assertFinite(u.nullDimensionCount, `${fieldPath}.uncertainty.nullDimensionCount`, 0, 4);
  assertStringArray(u.unsupportedRubricDimensions, `${fieldPath}.uncertainty.unsupportedRubricDimensions`);
  return raw as RankingItem;
}

export function validateRankingResult(raw: unknown, fieldPath = 'RankingResult'): RankingResult {
  const o = assertNoExtraKeys(
    raw,
    [
      'schemaVersion',
      'candidateSetHash',
      'scoringPolicyHash',
      'rubricVersion',
      'eligibleIds',
      'conditionalIds',
      'notRankableIds',
      'excludedIds',
      'items',
      'calibrationStatus',
      'performanceStatus',
      'producerOperationId',
    ],
    fieldPath
  );
  assertFinite(o.schemaVersion, `${fieldPath}.schemaVersion`, 1);
  assertHash64(o.candidateSetHash, `${fieldPath}.candidateSetHash`);
  assertHash64(o.scoringPolicyHash, `${fieldPath}.scoringPolicyHash`);
  assertId(o.rubricVersion, `${fieldPath}.rubricVersion`);
  assertId(o.producerOperationId, `${fieldPath}.producerOperationId`);
  if (o.calibrationStatus !== 'uncalibrated') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.calibrationStatus must be "uncalibrated"`);
  }
  if (o.performanceStatus !== 'NOT_VERIFIED') {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.performanceStatus must be "NOT_VERIFIED"`);
  }
  const groups = ['eligibleIds', 'conditionalIds', 'notRankableIds', 'excludedIds'] as const;
  const lists = groups.map((g) => assertStringArray(o[g], `${fieldPath}.${g}`));
  const union = new Set(lists.flat());
  if (union.size !== lists.flat().length) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: group ids must be pairwise disjoint`, {
      fieldPaths: groups.map((g) => `${fieldPath}.${g}`),
    });
  }
  if (!Array.isArray(o.items)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.items must be an array`);
  o.items.forEach((item, i) => validateRankingItem(item, `${fieldPath}.items[${i}]`));
  const itemIds = new Set(o.items.map((item) => (item as RankingItem).candidateId));
  if (itemIds.size !== union.size || ![...itemIds].every((id) => union.has(id))) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: the four groups must cover exactly all ranked candidates`, {
      fieldPaths: groups.map((g) => `${fieldPath}.${g}`),
    });
  }
  return raw as RankingResult;
}

// ----------------- Budget / protocol validators -----------------

const BUDGET_KEYS = ['maxCalls', 'maxInputTokensPerCall', 'maxOutputTokensPerCall', 'callTimeoutMs', 'totalTimeoutMs'] as const;

export function validateResearchBudget(raw: unknown, fieldPath = 'budget'): ResearchBudget {
  const o = assertNoExtraKeys(raw, BUDGET_KEYS, fieldPath);
  const maxCalls = assertFinite(o.maxCalls, `${fieldPath}.maxCalls`, 0, 1000);
  // A phase that makes no model call (P7) has no per-call token ceiling; a phase that does
  // must declare one, otherwise the estimate-before-send check has nothing to compare to.
  const tokenMin = maxCalls > 0 ? 1 : 0;
  return {
    maxCalls,
    maxInputTokensPerCall: assertFinite(o.maxInputTokensPerCall, `${fieldPath}.maxInputTokensPerCall`, tokenMin),
    maxOutputTokensPerCall: assertFinite(o.maxOutputTokensPerCall, `${fieldPath}.maxOutputTokensPerCall`, tokenMin),
    callTimeoutMs: assertFinite(o.callTimeoutMs, `${fieldPath}.callTimeoutMs`, 1),
    totalTimeoutMs: assertFinite(o.totalTimeoutMs, `${fieldPath}.totalTimeoutMs`, 1),
  };
}

export function validateProtocolRef(raw: unknown, fieldPath = 'protocolRef'): ProtocolRef {
  const o = assertNoExtraKeys(raw, ['id', 'version', 'publicHash'], fieldPath);
  if (o.id !== PROTOCOL_ID) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.id must be "${PROTOCOL_ID}"`, { fieldPaths: [`${fieldPath}.id`] });
  }
  if (o.version !== PROTOCOL_VERSION) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.version must be ${PROTOCOL_VERSION}`, { fieldPaths: [`${fieldPath}.version`] });
  }
  return { id: o.id as string, version: o.version as number, publicHash: assertHash64(o.publicHash, `${fieldPath}.publicHash`) };
}

export function validateRequestBase(
  raw: unknown,
  allowedExtras: readonly string[] = [],
  fieldPath = 'request'
): { base: ResearchRequestBase; rest: Record<string, unknown> } {
  const o = assertNoExtraKeys(raw, [...REQUEST_BASE_KEYS, ...allowedExtras], fieldPath);
  const base: ResearchRequestBase = {
    commandId: assertId(o.commandId, `${fieldPath}.commandId`),
    protocolRef: validateProtocolRef(o.protocolRef, `${fieldPath}.protocolRef`),
    evalInvocationId: assertId(o.evalInvocationId, `${fieldPath}.evalInvocationId`),
    sampleKey: assertId(o.sampleKey, `${fieldPath}.sampleKey`),
    budget: validateResearchBudget(o.budget, `${fieldPath}.budget`),
  };
  const rest: Record<string, unknown> = {};
  for (const key of allowedExtras) if (key in o) rest[key] = o[key];
  return { base, rest };
}

/** LLM single-call ceiling is 120 s (contract section 6/9.3). */
export const MAX_CALL_TIMEOUT_MS = 120_000;

export function assertBudgetLegal(budget: ResearchBudget): void {
  if (budget.callTimeoutMs > MAX_CALL_TIMEOUT_MS) {
    throw new ResearchError('INVALID_INPUT', `budget.callTimeoutMs exceeds the ${MAX_CALL_TIMEOUT_MS}ms per-call ceiling`, {
      fieldPaths: ['budget.callTimeoutMs'],
    });
  }
}

export function validateReceipt(raw: unknown, fieldPath = 'ResearchReceipt'): ResearchReceipt {
  const o = assertNoExtraKeys(raw, ['operationId', 'commandId', 'requestHash'], fieldPath);
  return {
    operationId: assertId(o.operationId, `${fieldPath}.operationId`),
    commandId: assertId(o.commandId, `${fieldPath}.commandId`),
    requestHash: assertHash64(o.requestHash, `${fieldPath}.requestHash`),
  };
}

export const TERMINAL_STATUSES: ResearchOperationStatus[] = ['succeeded', 'failed', 'cancelled', 'interrupted'];

export function isTerminal(status: ResearchOperationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Legal transitions (contract section 9.4). */
const ALLOWED_TRANSITIONS: Record<ResearchOperationStatus, ResearchOperationStatus[]> = {
  accepted: ['running', 'stopping', 'cancelled', 'interrupted'],
  running: ['succeeded', 'failed', 'stopping', 'cancelled', 'interrupted'],
  stopping: ['cancelled', 'failed', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function assertStatusTransition(from: ResearchOperationStatus, to: ResearchOperationStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new ResearchError('INVALID_INPUT', `Illegal research operation transition ${from} -> ${to}`, {
      fieldPaths: ['status'],
    });
  }
}

export function validateResearchOperation(raw: unknown, fieldPath = 'ResearchOperation'): ResearchOperation {
  const o = assertNoExtraKeys(
    raw,
    [
      'id',
      'ownerSessionId',
      'ownerIdentity',
      'commandId',
      'requestHash',
      'phase',
      'status',
      'resultRefs',
      'error',
      'attempts',
      'evalInvocationId',
      'sampleKey',
      'createdAt',
      'updatedAt',
    ],
    fieldPath
  );
  const status = assertEnum(o.status, RESEARCH_LIFECYCLE, `${fieldPath}.status`);
  assertEnum(o.phase, RESEARCH_PHASES, `${fieldPath}.phase`);
  assertId(o.id, `${fieldPath}.id`);
  assertId(o.ownerSessionId, `${fieldPath}.ownerSessionId`);
  assertId(o.commandId, `${fieldPath}.commandId`);
  assertHash64(o.requestHash, `${fieldPath}.requestHash`);
  assertIsoUtc(o.createdAt, `${fieldPath}.createdAt`);
  assertIsoUtc(o.updatedAt, `${fieldPath}.updatedAt`);
  if (!Array.isArray(o.attempts)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.attempts must be an array`);
  o.attempts.forEach((a, i) => {
    const item = assertNoExtraKeys(
      a,
      ['sequence', 'startedAt', 'endedAt', 'route', 'inputTokens', 'outputTokens', 'rawResponseRef', 'exitReason', 'isFormatCorrection', 'formatError'],
      `${fieldPath}.attempts[${i}]`
    );
    assertFinite(item.sequence, 'attempt.sequence', 1);
    assertIsoUtc(item.startedAt, 'attempt.startedAt');
    if (item.endedAt !== null) assertIsoUtc(item.endedAt, 'attempt.endedAt');
    assertId(item.route, 'attempt.route');
    if (item.inputTokens !== null) assertFinite(item.inputTokens, 'attempt.inputTokens', 0);
    if (item.outputTokens !== null) assertFinite(item.outputTokens, 'attempt.outputTokens', 0);
    assertId(item.exitReason, 'attempt.exitReason');
    if (item.formatError !== undefined && item.formatError !== null && typeof item.formatError !== 'string') {
      throw new ResearchError('SCHEMA_VIOLATION', 'attempt.formatError must be a string or null');
    }
    if (typeof item.isFormatCorrection !== 'boolean') {
      throw new ResearchError('SCHEMA_VIOLATION', 'attempt.isFormatCorrection must be boolean');
    }
  });
  if (!Array.isArray(o.resultRefs)) throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}.resultRefs must be an array`);
  if (status === 'succeeded' && o.resultRefs.length === 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: succeeded requires resultRefs`, { fieldPaths: [`${fieldPath}.resultRefs`] });
  }
  if ((status === 'failed' || status === 'cancelled' || status === 'interrupted') && o.error === null && o.resultRefs.length === 0) {
    throw new ResearchError('SCHEMA_VIOLATION', `${fieldPath}: ${status} requires an error or a reason`, {
      fieldPaths: [`${fieldPath}.error`],
    });
  }
  if (o.error !== null) {
    const e = assertNoExtraKeys(o.error, ['code', 'message', 'retryable', 'fieldPaths', 'diagnosticRef'], `${fieldPath}.error`);
    assertEnum(e.code, RESEARCH_ERROR_CODES, `${fieldPath}.error.code`);
  }
  return raw as ResearchOperation;
}
