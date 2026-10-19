/**
 * Research Bootstrap shared contracts (schemaVersion 1).
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-SHARED-SPEC-2026-10-10.md (§2–§5),
 * docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-02-GRAPH-SPEC-2026-10-10.md (§2).
 *
 * This is the single persisted fact source for research bootstrap:
 * `<workspace>/.dsh/research/bootstrap/state.json`. It never copies the paper library;
 * evidence refs point back at `LibraryPaper` objects by identity (paperId + sourceSha256 +
 * contentHash + revision + entry locator) and carry a bounded snapshot of the entry that was
 * actually used, so a later library update can be judged entry-by-entry instead of by index.
 *
 * Nothing here runs training, installs anything, or touches the old experiment pipeline:
 * autonomy is fixed to `plan_only` at the type level, and no field can carry an absolute
 * workspace path (locators are workspace-relative strings).
 *
 * Ownership: BE-02 (backend batch). BE-01 consumes; BE-03 wires. Renames or new required
 * fields must be synced into the shared SPEC before wiring.
 */

import * as crypto from 'node:crypto';
import { validateGeneralResearch, type GeneralResearch } from './general-research.ts';
import { validateTakeoverList, type TakeoverRecord } from './research-takeover.ts';
import { canonicalJsonV1, sha256Hex } from '../domain/research-canonical.ts';

export const BOOTSTRAP_SCHEMA_VERSION = 1;

// ----------------- Error codes -----------------

/**
 * Stable failure vocabulary for the whole bootstrap boundary (BE-01/BE-02 tools, services and
 * the BE-03 adapter must all speak these codes; the UI maps them, never re-invents them).
 */
export const BOOTSTRAP_ERROR_CODES = [
  'INVALID_INPUT',
  'SCHEMA_VIOLATION',
  'NOT_FOUND',
  'OWNER_MISMATCH',
  'POLICY_DENIED',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'STATE_CORRUPT',
  'STATE_WRITE_FAILED',
  'HOST_BUSY',
  'LOCK_STALE',
  'SOURCE_MISSING',
  'SOURCE_STALE',
  'INVALID_GRAPH',
  'SLOT_LOCKED',
  'INCOMPATIBLE_BINDING',
  'USER_SELECTION_MISMATCH',
  'MERGE_CONFLICT',
  'CONTRACT_REVISION_MISMATCH',
  'CONFIRMATION_REQUIRED',
  'DOMAIN_SLOT_REQUIRES_BASELINE',
  'DEPENDENCY_NOT_READY',
] as const;

export type BootstrapErrorCode = (typeof BOOTSTRAP_ERROR_CODES)[number];

export class BootstrapError extends Error {
  readonly code: BootstrapErrorCode;
  constructor(code: BootstrapErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'BootstrapError';
    this.code = code;
  }
}

function fail(code: BootstrapErrorCode, detail?: string): never { throw new BootstrapError(code, detail); }

// ----------------- Vocabularies -----------------

export const CONTRACT_STATUSES = ['draft', 'confirmed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const BASELINE_STATUSES = ['undecided', 'proposed', 'confirmed'] as const;
export type BaselineStatus = (typeof BASELINE_STATUSES)[number];

/** Fixed for this whole phase; a request that asks for more autonomy is refused, never stored. */
export const BOOTSTRAP_AUTONOMY = 'plan_only' as const;

export const OBSERVATION_STATUSES = ['observed', 'unavailable', 'failed', 'not_run'] as const;
export type ObservationStatus = (typeof OBSERVATION_STATUSES)[number];

/** The fixed, bounded probe set BE-01 runs; nothing else may be submitted as an observation. */
export const PROBE_NAMES = ['host_identity', 'python_version', 'gpu', 'cuda', 'torch', 'repo_summary'] as const;
export type ProbeName = (typeof PROBE_NAMES)[number];

export const RUN_STATUSES = ['pending', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const IDEA_STATUSES = ['candidate', 'selected', 'rejected', 'archived'] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

export const IDEA_BASES = ['grounded', 'exploratory'] as const;
export type IdeaBasis = (typeof IDEA_BASES)[number];

export const EVIDENCE_KINDS = ['wiki', 'component', 'source'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const NODE_KINDS = ['goal', 'protocol', 'baseline', 'hypothesis'] as const;
export type GraphNodeKind = (typeof NODE_KINDS)[number];

export const PLANNING_STATUSES = ['draft', 'needs_confirmation', 'confirmed', 'needs_validation'] as const;
export type PlanningStatus = (typeof PLANNING_STATUSES)[number];

export const EDGE_RELATIONS = ['depends_on', 'derived_from'] as const;
export type EdgeRelation = (typeof EDGE_RELATIONS)[number];

export const SLOT_SCOPES = ['universal', 'domain'] as const;
export type SlotScope = (typeof SLOT_SCOPES)[number];

export const SLOT_STATUSES = ['draft', 'needs_confirmation', 'confirmed'] as const;
export type SlotStatus = (typeof SLOT_STATUSES)[number];

export const CANDIDATE_ASSESSMENTS = ['proposed', 'needs_review', 'incompatible'] as const;
export type CandidateAssessment = (typeof CANDIDATE_ASSESSMENTS)[number];

/** Node review flags are explicit, additive markers; nothing is ever silently dropped. */
export const GRAPH_REVIEW_FLAGS = ['contract_updated', 'idea_updated', 'idea_not_reselected', 'parent_baseline_updated'] as const;
export type GraphReviewFlag = (typeof GRAPH_REVIEW_FLAGS)[number];

// ----------------- Bounds -----------------
/** Documented structural bounds; validators enforce them and tests pin the important ones. */
export const BOOTSTRAP_BOUNDS = Object.freeze({
  maxResearches: 50,
  maxRunsPerResearch: 100,
  maxIdeasPerResearch: 200,
  maxIdeasPerRun: 12,
  maxObservationsPerResearch: 50,
  maxNodes: 40,
  maxEdges: 80,
  maxSlots: 40,
  maxCandidatesPerSlot: 50,
  maxSnapshotsPerNode: 100,
  maxEvidenceRefsPerObject: 20,
});

// ----------------- Small helpers -----------------

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const isBootstrapId = (value: unknown): value is string =>
  typeof value === 'string' && ID_PATTERN.test(value);
export const isHex64 = (value: unknown): value is string =>
  typeof value === 'string' && HEX64_PATTERN.test(value);
export const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && ISO_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Strict-keys guard: unknown fields are refused, never silently stored. */
function keys<R>(raw: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(raw)) fail('SCHEMA_VIOLATION', `${label} must be an object`);
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('SCHEMA_VIOLATION', `${label} has unknown field(s): ${unknown.join(', ')}`);
  return raw as Record<string, unknown>;
}

const reqId = (value: unknown, label: string): string => {
  if (!isBootstrapId(value)) fail('SCHEMA_VIOLATION', `${label} must be a stable id`);
  return value;
};
const reqHex64 = (value: unknown, label: string): string => {
  if (!isHex64(value)) fail('SCHEMA_VIOLATION', `${label} must be a lowercase sha256 hex string`);
  return value;
};
const reqIso = (value: unknown, label: string): string => {
  if (!isIsoTimestamp(value)) fail('SCHEMA_VIOLATION', `${label} must be an ISO-8601 UTC timestamp`);
  return value;
};
const reqInt = (value: unknown, label: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail('SCHEMA_VIOLATION', `${label} must be an integer in [${minimum}, ${maximum === Number.MAX_SAFE_INTEGER ? '∞' : maximum}]`);
  }
  return value;
};
const reqText = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    fail('SCHEMA_VIOLATION', `${label} must be non-empty text of at most ${max} characters`);
  }
  return value;
};
const optText = (value: unknown, label: string, max: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) fail('SCHEMA_VIOLATION', `${label} must be text of at most ${max} characters or null`);
  return value;
};
const reqEnum = <T extends string>(value: unknown, allowed: readonly T[], label: string): T => {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail('SCHEMA_VIOLATION', `${label} must be one of: ${allowed.join(' | ')}`);
  }
  return value as T;
};
const reqArray = (value: unknown, label: string, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) fail('SCHEMA_VIOLATION', `${label} must be an array of at most ${max} items`);
  return value;
};
/** Workspace-relative locator: never absolute, never a drive/device path, no traversal. */
const reqLocator = (value: unknown, label: string): string => {
  const text = reqText(value, label, 500);
  if (/^([A-Za-z]:|\\\\|\/)/.test(text) || text.includes('..') || text.includes('\0')) {
    fail('SCHEMA_VIOLATION', `${label} must be a workspace-relative locator without traversal or absolute path`);
  }
  return text;
};

/** Canonical hash of a bootstrap content object; same content ⇒ same hash, key order irrelevant. */
export function bootstrapContentHash(typeName: string, value: unknown): string {
  return sha256Hex(`${typeName}\n${canonicalJsonV1(value)}`);
}

// ----------------- Evidence references -----------------

/** Bounded snapshot of the library entry this ref pointed at when it was recorded. */
export interface EvidenceEntrySnapshot {
  /** wiki section heading or component name; source refs carry the paper title. */
  label: string;
  kind: string | null;
  description: string | null;
  page: number | null;
  quote: string | null;
}

export interface EvidenceRef {
  paperId: string;
  sourceSha256: string;
  /** Joint library revision at use time; null only for whole-source refs. */
  assetRevision: string | null;
  assetKind: EvidenceKind;
  /** Zero-based section/component index; null for whole-source refs. */
  entryIndex: number | null;
  /** wiki/component: content hash of the entry itself. source: equals sourceSha256. */
  contentHash: string;
  page: number | null;
  quote: string | null;
  locator: string | null;
  snapshot: EvidenceEntrySnapshot;
}

const EVIDENCE_SNAPSHOT_MAX = { label: 300, description: 2000, quote: 2000 } as const;

function validateEvidenceSnapshot(raw: unknown, label: string): EvidenceEntrySnapshot {
  const o = keys(raw, ['label', 'kind', 'description', 'page', 'quote'], label);
  return {
    label: reqText(o.label, `${label}.label`, EVIDENCE_SNAPSHOT_MAX.label),
    kind: optText(o.kind, `${label}.kind`, 100),
    description: optText(o.description, `${label}.description`, EVIDENCE_SNAPSHOT_MAX.description),
    page: o.page === null || o.page === undefined ? null : reqInt(o.page, `${label}.page`, 1, 10000),
    quote: optText(o.quote, `${label}.quote`, EVIDENCE_SNAPSHOT_MAX.quote),
  };
}

/** Validates a stored EvidenceRef. Reference resolution against the live library is a service job. */
export function validateEvidenceRef(raw: unknown, label = 'evidenceRef'): EvidenceRef {
  const o = keys(raw, ['paperId', 'sourceSha256', 'assetRevision', 'assetKind', 'entryIndex', 'contentHash', 'page', 'quote', 'locator', 'snapshot'], label);
  const paperId = reqId(o.paperId, `${label}.paperId`);
  const sourceSha256 = reqHex64(o.sourceSha256, `${label}.sourceSha256`);
  const assetKind = reqEnum(o.assetKind, EVIDENCE_KINDS, `${label}.assetKind`);
  const entryIndex = o.entryIndex === null || o.entryIndex === undefined ? null : reqInt(o.entryIndex, `${label}.entryIndex`, 0, 9999);
  const assetRevision = optText(o.assetRevision, `${label}.assetRevision`, 200);
  if (assetKind === 'source') {
    if (entryIndex !== null) fail('SCHEMA_VIOLATION', `${label}: a source ref has no entry index`);
  } else {
    if (entryIndex === null) fail('SCHEMA_VIOLATION', `${label}: a ${assetKind} ref requires its entry index`);
    if (assetRevision === null) fail('SCHEMA_VIOLATION', `${label}: a ${assetKind} ref requires the library revision it was taken from`);
  }
  const contentHash = reqHex64(o.contentHash, `${label}.contentHash`);
  if (assetKind === 'source' && contentHash !== sourceSha256) {
    fail('SCHEMA_VIOLATION', `${label}: a source ref hashes its own source`);
  }
  return {
    paperId, sourceSha256, assetRevision, assetKind, entryIndex, contentHash,
    page: o.page === null || o.page === undefined ? null : reqInt(o.page, `${label}.page`, 1, 10000),
    quote: optText(o.quote, `${label}.quote`, EVIDENCE_SNAPSHOT_MAX.quote),
    locator: optText(o.locator, `${label}.locator`, 500),
    snapshot: validateEvidenceSnapshot(o.snapshot, `${label}.snapshot`),
  };
}

export function validateEvidenceRefs(raw: unknown, label: string): EvidenceRef[] {
  return reqArray(raw, label, BOOTSTRAP_BOUNDS.maxEvidenceRefsPerObject).map((entry, index) => validateEvidenceRef(entry, `${label}[${index}]`));
}

// ----------------- Contract -----------------

export interface ContractBaseline {
  status: BaselineStatus;
  name: string | null;
  paperRef: EvidenceRef | null;
  repoLocator: string | null;
}

export interface PendingQuestion {
  questionId: string;
  field: string;
  question: string;
  status: 'open' | 'answered' | 'skipped';
  answer: string | null;
  answeredAt: string | null;
  /** Actor identity only when the answer really came from a user input/native action. */
  answeredBy: string | null;
}

export interface ContractConfirmation {
  field: string;
  kind: 'user_action' | 'ask_answer';
  actionId: string | null;
  actorIdentity: string;
  at: string;
  note: string | null;
}

export interface ResearchContract {
  revision: number;
  status: ContractStatus;
  researchQuestion: string | null;
  goal: string | null;
  baseline: ContractBaseline;
  dataDescription: string | null;
  metrics: string[];
  guardrails: string[];
  editableScope: string[];
  lockedScope: string[];
  computeBudget: string | null;
  timeBudget: string | null;
  autonomy: typeof BOOTSTRAP_AUTONOMY;
  pendingQuestions: PendingQuestion[];
  confirmations: ContractConfirmation[];
  updatedAt: string;
}

const CONTRACT_TEXT_MAX = { question: 2000, goal: 2000, description: 4000, listEntry: 300, budget: 1000, note: 1000 } as const;

function validateContractBaseline(raw: unknown, label: string): ContractBaseline {
  const o = keys(raw, ['status', 'name', 'paperRef', 'repoLocator'], label);
  return {
    status: reqEnum(o.status, BASELINE_STATUSES, `${label}.status`),
    name: optText(o.name, `${label}.name`, 300),
    paperRef: o.paperRef === null || o.paperRef === undefined ? null : validateEvidenceRef(o.paperRef, `${label}.paperRef`),
    repoLocator: o.repoLocator === null || o.repoLocator === undefined ? null : reqLocator(o.repoLocator, `${label}.repoLocator`),
  };
}

function stringList(raw: unknown, label: string, max: number): string[] {
  return reqArray(raw, label, max).map((entry, index) => reqText(entry, `${label}[${index}]`, CONTRACT_TEXT_MAX.listEntry));
}

function validatePendingQuestion(raw: unknown, label: string): PendingQuestion {
  const o = keys(raw, ['questionId', 'field', 'question', 'status', 'answer', 'answeredAt', 'answeredBy'], label);
  return {
    questionId: reqId(o.questionId, `${label}.questionId`),
    field: reqText(o.field, `${label}.field`, 100),
    question: reqText(o.question, `${label}.question`, CONTRACT_TEXT_MAX.question),
    status: reqEnum(o.status, ['open', 'answered', 'skipped'] as const, `${label}.status`),
    answer: optText(o.answer, `${label}.answer`, CONTRACT_TEXT_MAX.question),
    answeredAt: o.answeredAt === null || o.answeredAt === undefined ? null : reqIso(o.answeredAt, `${label}.answeredAt`),
    answeredBy: optText(o.answeredBy, `${label}.answeredBy`, 200),
  };
}

function validateConfirmation(raw: unknown, label: string): ContractConfirmation {
  const o = keys(raw, ['field', 'kind', 'actionId', 'actorIdentity', 'at', 'note'], label);
  return {
    field: reqText(o.field, `${label}.field`, 100),
    kind: reqEnum(o.kind, ['user_action', 'ask_answer'] as const, `${label}.kind`),
    actionId: optText(o.actionId, `${label}.actionId`, 200),
    actorIdentity: reqText(o.actorIdentity, `${label}.actorIdentity`, 200),
    at: reqIso(o.at, `${label}.at`),
    note: optText(o.note, `${label}.note`, CONTRACT_TEXT_MAX.note),
  };
}

export function validateResearchContract(raw: unknown, label = 'contract'): ResearchContract {
  const o = keys(raw, ['revision', 'status', 'researchQuestion', 'goal', 'baseline', 'dataDescription', 'metrics', 'guardrails',
    'editableScope', 'lockedScope', 'computeBudget', 'timeBudget', 'autonomy', 'pendingQuestions', 'confirmations', 'updatedAt'], label);
  const autonomy = o.autonomy;
  if (autonomy !== BOOTSTRAP_AUTONOMY) fail('POLICY_DENIED', `${label}.autonomy is fixed to "${BOOTSTRAP_AUTONOMY}" in this phase`);
  return {
    revision: reqInt(o.revision, `${label}.revision`, 1),
    status: reqEnum(o.status, CONTRACT_STATUSES, `${label}.status`),
    researchQuestion: optText(o.researchQuestion, `${label}.researchQuestion`, CONTRACT_TEXT_MAX.question),
    goal: optText(o.goal, `${label}.goal`, CONTRACT_TEXT_MAX.goal),
    baseline: validateContractBaseline(o.baseline, `${label}.baseline`),
    dataDescription: optText(o.dataDescription, `${label}.dataDescription`, CONTRACT_TEXT_MAX.description),
    metrics: stringList(o.metrics, `${label}.metrics`, 20),
    guardrails: stringList(o.guardrails, `${label}.guardrails`, 20),
    editableScope: stringList(o.editableScope, `${label}.editableScope`, 40),
    lockedScope: stringList(o.lockedScope, `${label}.lockedScope`, 40),
    computeBudget: optText(o.computeBudget, `${label}.computeBudget`, CONTRACT_TEXT_MAX.budget),
    timeBudget: optText(o.timeBudget, `${label}.timeBudget`, CONTRACT_TEXT_MAX.budget),
    autonomy: BOOTSTRAP_AUTONOMY,
    pendingQuestions: reqArray(o.pendingQuestions, `${label}.pendingQuestions`, 20).map((entry, index) => validatePendingQuestion(entry, `${label}.pendingQuestions[${index}]`)),
    confirmations: reqArray(o.confirmations, `${label}.confirmations`, 50).map((entry, index) => validateConfirmation(entry, `${label}.confirmations[${index}]`)),
    updatedAt: reqIso(o.updatedAt, `${label}.updatedAt`),
  };
}

/**
 * Semantic identity of a contract: everything a brainstorm/graph depends on. Explicitly excludes
 * revision/updatedAt/status/confirmations (provenance), so re-confirming unchanged content does
 * not fork graph init signatures.
 */
export function contractSemanticView(contract: ResearchContract): Record<string, unknown> {
  return {
    researchQuestion: contract.researchQuestion,
    goal: contract.goal,
    baseline: { status: contract.baseline.status, name: contract.baseline.name, paperHash: contract.baseline.paperRef?.contentHash ?? null, repoLocator: contract.baseline.repoLocator },
    dataDescription: contract.dataDescription,
    metrics: contract.metrics,
    guardrails: contract.guardrails,
    editableScope: contract.editableScope,
    lockedScope: contract.lockedScope,
    computeBudget: contract.computeBudget,
    timeBudget: contract.timeBudget,
    pendingQuestions: contract.pendingQuestions.map((q) => ({ questionId: q.questionId, field: q.field, question: q.question, status: q.status, answer: q.answer })),
  };
}

export function contractSemanticHash(contract: ResearchContract): string {
  return bootstrapContentHash('research-bootstrap-contract-v1', contractSemanticView(contract));
}

// ----------------- Environment observations -----------------

export interface EnvironmentObservation {
  observationId: string;
  probe: ProbeName;
  status: ObservationStatus;
  at: string;
  /** Probe-specific structured value; only meaningful when status is "observed". */
  value: unknown;
  error: { code: string; message: string } | null;
  /** How this fact was really obtained; commands carry their exact fixed template. */
  source: { kind: 'structured_host' } | { kind: 'command'; template: string } | { kind: 'file_read'; locator: string };
  durationMs: number;
}

/** Validates one stored observation; probe names are limited to the fixed probe set. */
export function validateEnvironmentObservation(raw: unknown, label = 'observation'): EnvironmentObservation {
  return validateObservation(raw, label);
}

function validateObservation(raw: unknown, label: string): EnvironmentObservation {  const o = keys(raw, ['observationId', 'probe', 'status', 'at', 'value', 'error', 'source', 'durationMs'], label);
  const probe = reqEnum(o.probe, PROBE_NAMES, `${label}.probe`);
  const status = reqEnum(o.status, OBSERVATION_STATUSES, `${label}.status`);
  const rawSource = keys(o.source, ['kind', 'template', 'locator'], `${label}.source`);
  const sourceKind = reqEnum(rawSource.kind, ['structured_host', 'command', 'file_read'] as const, `${label}.source.kind`);
  const source = sourceKind === 'structured_host'
    ? { kind: 'structured_host' as const }
    : sourceKind === 'command'
      ? { kind: 'command' as const, template: reqText(rawSource.template, `${label}.source.template`, 500) }
      : { kind: 'file_read' as const, locator: reqLocator(rawSource.locator, `${label}.source.locator`) };
  let error: EnvironmentObservation['error'] = null;
  if (o.error !== null && o.error !== undefined) {
    const rawError = keys(o.error, ['code', 'message'], `${label}.error`);
    error = { code: reqText(rawError.code, `${label}.error.code`, 100), message: reqText(rawError.message, `${label}.error.message`, 2000) };
  }
  if (status === 'observed' && o.value === undefined) fail('SCHEMA_VIOLATION', `${label}: an observed probe must carry its value`);
  return {
    observationId: reqId(o.observationId, `${label}.observationId`),
    probe, status,
    at: reqIso(o.at, `${label}.at`),
    value: o.value === undefined ? null : o.value,
    error, source,
    durationMs: reqInt(o.durationMs, `${label}.durationMs`, 0, 10 * 60 * 1000),
  };
}

// ----------------- Brainstorm runs and ideas -----------------

export interface BrainstormRun {
  runId: string;
  operationId: string | null;
  /** Invoking agent/session id recorded by the trusted boundary; never a payload field. */
  agentIdentity: string;
  /** Host model route identity when the host knows one; null when unknown — never invented. */
  modelIdentity: string | null;
  contractRevision: number;
  inputRefs: EvidenceRef[];
  inputEnvironmentIds: string[];
  inputNotes: string | null;
  status: RunStatus;
  ideaIds: string[];
  itemErrors: Array<{ label: string; code: string; message: string }>;
  duplicates: Array<{ submittedLabel: string; existingIdeaId: string }>;
  emptyResultReason: string | null;
  error: { code: string; message: string } | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface IdeaRef {
  ideaId: string;
  contentRevision: number;
  contentHash: string;
}

export interface ResearchIdea {
  ideaId: string;
  revision: number;
  contentHash: string;
  status: IdeaStatus;
  title: string;
  hypothesis: string;
  rationale: string | null;
  basis: IdeaBasis;
  /** Required when basis is exploratory: the explicit “exploratory, evidence pending” marker. */
  exploratoryNote: string | null;
  evidenceRefs: EvidenceRef[];
  proposedSlot: string | null;
  atomicChange: string;
  validationPlan: string;
  targetMetrics: string[];
  costNote: string | null;
  riskNote: string | null;
  pendingQuestions: string[];
  contractRevision: number;
  reviewNotes: string[];
  runId: string | null;
  editHistory: Array<{ at: string; actorIdentity: string; fields: string[] }>;
  createdAt: string;
  updatedAt: string;
}

const IDEA_TEXT_MAX = { title: 300, body: 4000, note: 2000, slot: 200 } as const;

function validateIdeaRef(raw: unknown, label: string): IdeaRef {
  const o = keys(raw, ['ideaId', 'contentRevision', 'contentHash'], label);
  return { ideaId: reqId(o.ideaId, `${label}.ideaId`), contentRevision: reqInt(o.contentRevision, `${label}.contentRevision`, 1), contentHash: reqHex64(o.contentHash, `${label}.contentHash`) };
}

/** Content fields whose change bumps an idea's revision/hash; status flips do NOT. */
export function ideaContentView(idea: Omit<ResearchIdea, 'revision' | 'contentHash' | 'status' | 'runId' | 'editHistory' | 'createdAt' | 'updatedAt' | 'reviewNotes'>): Record<string, unknown> {
  return {
    title: idea.title,
    hypothesis: idea.hypothesis,
    rationale: idea.rationale,
    basis: idea.basis,
    exploratoryNote: idea.exploratoryNote,
    evidenceRefs: idea.evidenceRefs.map((ref) => ({ paperId: ref.paperId, assetKind: ref.assetKind, entryIndex: ref.entryIndex, contentHash: ref.contentHash })),
    proposedSlot: idea.proposedSlot,
    atomicChange: idea.atomicChange,
    validationPlan: idea.validationPlan,
    targetMetrics: idea.targetMetrics,
    costNote: idea.costNote,
    riskNote: idea.riskNote,
    pendingQuestions: idea.pendingQuestions,
    contractRevision: idea.contractRevision,
  };
}

export function ideaContentHash(idea: Parameters<typeof ideaContentView>[0]): string {
  return bootstrapContentHash('research-bootstrap-idea-v1', ideaContentView(idea));
}

export function validateResearchIdea(raw: unknown, label = 'idea'): ResearchIdea {
  const o = keys(raw, ['ideaId', 'revision', 'contentHash', 'status', 'title', 'hypothesis', 'rationale', 'basis', 'exploratoryNote',
    'evidenceRefs', 'proposedSlot', 'atomicChange', 'validationPlan', 'targetMetrics', 'costNote', 'riskNote', 'pendingQuestions',
    'contractRevision', 'reviewNotes', 'runId', 'editHistory', 'createdAt', 'updatedAt'], label);
  const idea: ResearchIdea = {
    ideaId: reqId(o.ideaId, `${label}.ideaId`),
    revision: reqInt(o.revision, `${label}.revision`, 1),
    contentHash: reqHex64(o.contentHash, `${label}.contentHash`),
    status: reqEnum(o.status, IDEA_STATUSES, `${label}.status`),
    title: reqText(o.title, `${label}.title`, IDEA_TEXT_MAX.title),
    hypothesis: reqText(o.hypothesis, `${label}.hypothesis`, IDEA_TEXT_MAX.body),
    rationale: optText(o.rationale, `${label}.rationale`, IDEA_TEXT_MAX.body),
    basis: reqEnum(o.basis, IDEA_BASES, `${label}.basis`),
    exploratoryNote: optText(o.exploratoryNote, `${label}.exploratoryNote`, IDEA_TEXT_MAX.note),
    evidenceRefs: validateEvidenceRefs(o.evidenceRefs, `${label}.evidenceRefs`),
    proposedSlot: optText(o.proposedSlot, `${label}.proposedSlot`, IDEA_TEXT_MAX.slot),
    atomicChange: reqText(o.atomicChange, `${label}.atomicChange`, IDEA_TEXT_MAX.body),
    validationPlan: reqText(o.validationPlan, `${label}.validationPlan`, IDEA_TEXT_MAX.body),
    targetMetrics: stringList(o.targetMetrics, `${label}.targetMetrics`, 10),
    costNote: optText(o.costNote, `${label}.costNote`, IDEA_TEXT_MAX.note),
    riskNote: optText(o.riskNote, `${label}.riskNote`, IDEA_TEXT_MAX.note),
    pendingQuestions: stringList(o.pendingQuestions, `${label}.pendingQuestions`, 10),
    contractRevision: reqInt(o.contractRevision, `${label}.contractRevision`, 1),
    reviewNotes: stringList(o.reviewNotes, `${label}.reviewNotes`, 20),
    runId: o.runId === null || o.runId === undefined ? null : reqId(o.runId, `${label}.runId`),
    editHistory: reqArray(o.editHistory, `${label}.editHistory`, 50).map((entry, index) => {
      const e = keys(entry, ['at', 'actorIdentity', 'fields'], `${label}.editHistory[${index}]`);
      return { at: reqIso(e.at, `${label}.editHistory[${index}].at`), actorIdentity: reqText(e.actorIdentity, `${label}.editHistory[${index}].actorIdentity`, 200), fields: stringList(e.fields, `${label}.editHistory[${index}].fields`, 20) };
    }),
    createdAt: reqIso(o.createdAt, `${label}.createdAt`),
    updatedAt: reqIso(o.updatedAt, `${label}.updatedAt`),
  };
  if (idea.basis === 'grounded' && idea.evidenceRefs.length === 0) {
    fail('SCHEMA_VIOLATION', `${label}: a grounded idea requires at least one evidence ref`);
  }
  if (idea.basis === 'exploratory' && !idea.exploratoryNote) {
    fail('SCHEMA_VIOLATION', `${label}: an exploratory idea requires its explicit “exploratory, evidence pending” note`);
  }
  return idea;
}

// ----------------- Graph, slots, snapshots -----------------

export interface GraphNode {
  nodeId: string;
  kind: GraphNodeKind;
  title: string;
  planningStatus: PlanningStatus;
  ideaRef: IdeaRef | null;
  evidenceRefs: EvidenceRef[];
  note: string | null;
  snapshotRef: string | null;
  reviewFlags: string[];
}

export interface GraphEdge {
  edgeId: string;
  from: string;
  to: string;
  relation: EdgeRelation;
}

/** A concrete bindable object: a library component at a full version, or a design idea at a content version. */
export type SlotBindingRef =
  | { kind: 'paper_component'; paperId: string; sourceSha256: string; assetRevision: string; componentIndex: number; contentHash: string; name: string; componentKind: string }
  | { kind: 'design_idea'; ideaId: string; contentRevision: number; contentHash: string; title: string };

export interface SlotCandidate {
  candidateId: string;
  ref: SlotBindingRef;
  assessment: CandidateAssessment;
  reason: string;
  evidenceRefs: EvidenceRef[];
  /** Explicit “interface info missing” marker; similarity alone never implies integrability. */
  missingInterface: string | null;
  recommendedBy: string | null;
}

export interface Slot {
  slotId: string;
  name: string;
  role: string | null;
  scope: SlotScope;
  basis: string | null;
  inputs: string | null;
  outputs: string | null;
  constraints: string[];
  locked: boolean;
  lockedBy: { actorIdentity: string; at: string; source: 'user_action' } | null;
  status: SlotStatus;
  /**
   * Convenience mirror of the binding on the baseline node's current snapshot (the graph's
   * default scheme). Per-node bindings live in the node's snapshot, which stays the authority.
   */
  currentRef: SlotBindingRef | null;
  candidates: SlotCandidate[];
}

export interface SnapshotDeltaChange {
  slotId: string;
  from: SlotBindingRef | null;
  to: SlotBindingRef | null;
}

export interface SlotSnapshot {
  snapshotId: string;
  nodeId: string;
  revision: number;
  parentSnapshotRef: string | null;
  bindings: Record<string, SlotBindingRef>;
  delta: { fromSnapshotRef: string | null; changes: SnapshotDeltaChange[] };
  note: string | null;
  createdAt: string;
}

export interface ResearchGraph {
  graphId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  slots: Slot[];
  snapshots: SlotSnapshot[];
  initSignature: string;
  contractRevision: number;
  selectedIdeaRefs: IdeaRef[];
  /** The trusted native selection this graph was initialized from; null ⇒ no idea was selected. */
  selectionProof: { actionId: string; actorIdentity: string; at: string } | null;
  evidenceRefs: EvidenceRef[];
  baselineConfirmed: boolean;
  reviewNotes: string[];
  createdAt: string;
  updatedAt: string;
}

export function validateSlotBindingRef(raw: unknown, label: string): SlotBindingRef {
  const o = keys(raw, ['kind', 'paperId', 'sourceSha256', 'assetRevision', 'componentIndex', 'contentHash', 'name', 'componentKind',
    'ideaId', 'contentRevision', 'title'], label);
  const kind = reqEnum(o.kind, ['paper_component', 'design_idea'] as const, `${label}.kind`);
  if (kind === 'paper_component') {
    return {
      kind,
      paperId: reqId(o.paperId, `${label}.paperId`),
      sourceSha256: reqHex64(o.sourceSha256, `${label}.sourceSha256`),
      assetRevision: reqText(o.assetRevision, `${label}.assetRevision`, 200),
      componentIndex: reqInt(o.componentIndex, `${label}.componentIndex`, 0, 9999),
      contentHash: reqHex64(o.contentHash, `${label}.contentHash`),
      name: reqText(o.name, `${label}.name`, 300),
      componentKind: reqText(o.componentKind, `${label}.componentKind`, 100),
    };
  }
  return {
    kind,
    ideaId: reqId(o.ideaId, `${label}.ideaId`),
    contentRevision: reqInt(o.contentRevision, `${label}.contentRevision`, 1),
    contentHash: reqHex64(o.contentHash, `${label}.contentHash`),
    title: reqText(o.title, `${label}.title`, IDEA_TEXT_MAX.title),
  };
}

function validateSlotCandidate(raw: unknown, label: string): SlotCandidate {
  const o = keys(raw, ['candidateId', 'ref', 'assessment', 'reason', 'evidenceRefs', 'missingInterface', 'recommendedBy'], label);
  return {
    candidateId: reqId(o.candidateId, `${label}.candidateId`),
    ref: validateSlotBindingRef(o.ref, `${label}.ref`),
    assessment: reqEnum(o.assessment, CANDIDATE_ASSESSMENTS, `${label}.assessment`),
    reason: reqText(o.reason, `${label}.reason`, IDEA_TEXT_MAX.body),
    evidenceRefs: validateEvidenceRefs(o.evidenceRefs, `${label}.evidenceRefs`),
    missingInterface: optText(o.missingInterface, `${label}.missingInterface`, IDEA_TEXT_MAX.note),
    recommendedBy: optText(o.recommendedBy, `${label}.recommendedBy`, 200),
  };
}

function validateSlot(raw: unknown, label: string): Slot {
  const o = keys(raw, ['slotId', 'name', 'role', 'scope', 'basis', 'inputs', 'outputs', 'constraints', 'locked', 'lockedBy', 'status', 'currentRef', 'candidates'], label);
  let lockedBy: Slot['lockedBy'] = null;
  if (o.lockedBy !== null && o.lockedBy !== undefined) {
    const l = keys(o.lockedBy, ['actorIdentity', 'at', 'source'], `${label}.lockedBy`);
    lockedBy = { actorIdentity: reqText(l.actorIdentity, `${label}.lockedBy.actorIdentity`, 200), at: reqIso(l.at, `${label}.lockedBy.at`), source: reqEnum(l.source, ['user_action'] as const, `${label}.lockedBy.source`) };
  }
  return {
    slotId: reqId(o.slotId, `${label}.slotId`),
    name: reqText(o.name, `${label}.name`, 200),
    role: optText(o.role, `${label}.role`, 500),
    scope: reqEnum(o.scope, SLOT_SCOPES, `${label}.scope`),
    basis: optText(o.basis, `${label}.basis`, IDEA_TEXT_MAX.body),
    inputs: optText(o.inputs, `${label}.inputs`, IDEA_TEXT_MAX.note),
    outputs: optText(o.outputs, `${label}.outputs`, IDEA_TEXT_MAX.note),
    constraints: stringList(o.constraints, `${label}.constraints`, 20),
    locked: o.locked === true,
    lockedBy,
    status: reqEnum(o.status, SLOT_STATUSES, `${label}.status`),
    currentRef: o.currentRef === null || o.currentRef === undefined ? null : validateSlotBindingRef(o.currentRef, `${label}.currentRef`),
    candidates: reqArray(o.candidates, `${label}.candidates`, BOOTSTRAP_BOUNDS.maxCandidatesPerSlot).map((entry, index) => validateSlotCandidate(entry, `${label}.candidates[${index}]`)),
  };
}

function validateSnapshot(raw: unknown, label: string): SlotSnapshot {
  const o = keys(raw, ['snapshotId', 'nodeId', 'revision', 'parentSnapshotRef', 'bindings', 'delta', 'note', 'createdAt'], label);
  const rawDelta = keys(o.delta, ['fromSnapshotRef', 'changes'], `${label}.delta`);
  const bindings: Record<string, SlotBindingRef> = {};
  if (!isRecord(o.bindings)) fail('SCHEMA_VIOLATION', `${label}.bindings must be an object`);
  const bindingEntries = Object.entries(o.bindings);
  if (bindingEntries.length > BOOTSTRAP_BOUNDS.maxSlots) fail('SCHEMA_VIOLATION', `${label}.bindings exceeds the slot bound`);
  for (const [slotId, value] of bindingEntries) {
    bindings[reqId(slotId, `${label}.bindings.key`)] = validateSlotBindingRef(value, `${label}.bindings.${slotId}`);
  }
  return {
    snapshotId: reqId(o.snapshotId, `${label}.snapshotId`),
    nodeId: reqId(o.nodeId, `${label}.nodeId`),
    revision: reqInt(o.revision, `${label}.revision`, 1),
    parentSnapshotRef: o.parentSnapshotRef === null || o.parentSnapshotRef === undefined ? null : reqId(o.parentSnapshotRef, `${label}.parentSnapshotRef`),
    bindings,
    delta: {
      fromSnapshotRef: rawDelta.fromSnapshotRef === null || rawDelta.fromSnapshotRef === undefined ? null : reqId(rawDelta.fromSnapshotRef, `${label}.delta.fromSnapshotRef`),
      changes: reqArray(rawDelta.changes, `${label}.delta.changes`, BOOTSTRAP_BOUNDS.maxSlots).map((entry, index) => {
        const c = keys(entry, ['slotId', 'from', 'to'], `${label}.delta.changes[${index}]`);
        return {
          slotId: reqId(c.slotId, `${label}.delta.changes[${index}].slotId`),
          from: c.from === null || c.from === undefined ? null : validateSlotBindingRef(c.from, `${label}.delta.changes[${index}].from`),
          to: c.to === null || c.to === undefined ? null : validateSlotBindingRef(c.to, `${label}.delta.changes[${index}].to`),
        };
      }),
    },
    note: optText(o.note, `${label}.note`, IDEA_TEXT_MAX.note),
    createdAt: reqIso(o.createdAt, `${label}.createdAt`),
  };
}

function validateGraphNode(raw: unknown, label: string): GraphNode {
  const o = keys(raw, ['nodeId', 'kind', 'title', 'planningStatus', 'ideaRef', 'evidenceRefs', 'note', 'snapshotRef', 'reviewFlags'], label);
  return {
    nodeId: reqId(o.nodeId, `${label}.nodeId`),
    kind: reqEnum(o.kind, NODE_KINDS, `${label}.kind`),
    title: reqText(o.title, `${label}.title`, 300),
    planningStatus: reqEnum(o.planningStatus, PLANNING_STATUSES, `${label}.planningStatus`),
    ideaRef: o.ideaRef === null || o.ideaRef === undefined ? null : validateIdeaRef(o.ideaRef, `${label}.ideaRef`),
    evidenceRefs: validateEvidenceRefs(o.evidenceRefs, `${label}.evidenceRefs`),
    note: optText(o.note, `${label}.note`, IDEA_TEXT_MAX.body),
    snapshotRef: o.snapshotRef === null || o.snapshotRef === undefined ? null : reqId(o.snapshotRef, `${label}.snapshotRef`),
    reviewFlags: stringList(o.reviewFlags, `${label}.reviewFlags`, GRAPH_REVIEW_FLAGS.length),
  };
}

function validateGraphEdge(raw: unknown, label: string): GraphEdge {
  const o = keys(raw, ['edgeId', 'from', 'to', 'relation'], label);
  return { edgeId: reqId(o.edgeId, `${label}.edgeId`), from: reqId(o.from, `${label}.from`), to: reqId(o.to, `${label}.to`), relation: reqEnum(o.relation, EDGE_RELATIONS, `${label}.relation`) };
}

export function validateResearchGraph(raw: unknown, label = 'graph'): ResearchGraph {
  const o = keys(raw, ['graphId', 'nodes', 'edges', 'slots', 'snapshots', 'initSignature', 'contractRevision', 'selectedIdeaRefs',
    'selectionProof', 'evidenceRefs', 'baselineConfirmed', 'reviewNotes', 'createdAt', 'updatedAt'], label);
  const nodes = reqArray(o.nodes, `${label}.nodes`, BOOTSTRAP_BOUNDS.maxNodes).map((entry, index) => validateGraphNode(entry, `${label}.nodes[${index}]`));
  const edges = reqArray(o.edges, `${label}.edges`, BOOTSTRAP_BOUNDS.maxEdges).map((entry, index) => validateGraphEdge(entry, `${label}.edges[${index}]`));
  const slots = reqArray(o.slots, `${label}.slots`, BOOTSTRAP_BOUNDS.maxSlots).map((entry, index) => validateSlot(entry, `${label}.slots[${index}]`));
  const snapshots = reqArray(o.snapshots, `${label}.snapshots`, BOOTSTRAP_BOUNDS.maxNodes * BOOTSTRAP_BOUNDS.maxSnapshotsPerNode).map((entry, index) => validateSnapshot(entry, `${label}.snapshots[${index}]`));
  let selectionProof: ResearchGraph['selectionProof'] = null;
  if (o.selectionProof !== null && o.selectionProof !== undefined) {
    const s = keys(o.selectionProof, ['actionId', 'actorIdentity', 'at'], `${label}.selectionProof`);
    selectionProof = { actionId: reqText(s.actionId, `${label}.selectionProof.actionId`, 200), actorIdentity: reqText(s.actorIdentity, `${label}.selectionProof.actorIdentity`, 200), at: reqIso(s.at, `${label}.selectionProof.at`) };
  }
  const graph: ResearchGraph = {
    graphId: reqId(o.graphId, `${label}.graphId`),
    nodes, edges, slots, snapshots,
    initSignature: reqHex64(o.initSignature, `${label}.initSignature`),
    contractRevision: reqInt(o.contractRevision, `${label}.contractRevision`, 1),
    selectedIdeaRefs: reqArray(o.selectedIdeaRefs, `${label}.selectedIdeaRefs`, BOOTSTRAP_BOUNDS.maxIdeasPerRun).map((entry, index) => validateIdeaRef(entry, `${label}.selectedIdeaRefs[${index}]`)),
    selectionProof,
    evidenceRefs: validateEvidenceRefs(o.evidenceRefs, `${label}.evidenceRefs`),
    baselineConfirmed: o.baselineConfirmed === true,
    reviewNotes: stringList(o.reviewNotes, `${label}.reviewNotes`, 50),
    createdAt: reqIso(o.createdAt, `${label}.createdAt`),
    updatedAt: reqIso(o.updatedAt, `${label}.updatedAt`),
  };
  validateGraphTopology(graph, label);
  return graph;
}

/**
 * Structural graph rules: unique node/edge/slot/snapshot ids, no dangling edge endpoint, no
 * dangling snapshot/idea refs, acyclic edges, snapshot chains acyclic and per-node revisions
 * contiguous. A graph that fails this can never be written.
 */
export function validateGraphTopology(graph: ResearchGraph, label = 'graph'): void {
  const nodeIds = new Set(graph.nodes.map((node) => node.nodeId));
  if (nodeIds.size !== graph.nodes.length) fail('INVALID_GRAPH', `${label}: duplicate node id`);
  const edgeIds = new Set(graph.edges.map((edge) => edge.edgeId));
  if (edgeIds.size !== graph.edges.length) fail('INVALID_GRAPH', `${label}: duplicate edge id`);
  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) fail('INVALID_GRAPH', `${label}: edge ${edge.edgeId} dangles on a missing node`);
    if (edge.from === edge.to) fail('INVALID_GRAPH', `${label}: edge ${edge.edgeId} is a self loop`);
  }
  // Cycle check over all edges (both relations must stay acyclic; this is a planning DAG).
  const adjacency = new Map<string, string[]>(graph.nodes.map((node) => [node.nodeId, []]));
  for (const edge of graph.edges) adjacency.get(edge.from)!.push(edge.to);
  const state = new Map<string, 1 | 2>();
  const visit = (nodeId: string, trail: string[]): void => {
    const mark = state.get(nodeId);
    if (mark === 2) return;
    if (mark === 1) fail('INVALID_GRAPH', `${label}: cycle through ${[...trail, nodeId].join(' -> ')}`);
    state.set(nodeId, 1);
    for (const next of adjacency.get(nodeId)!) visit(next, [...trail, nodeId]);
    state.set(nodeId, 2);
  };
  for (const node of graph.nodes) visit(node.nodeId, []);
  const slotIds = new Set(graph.slots.map((slot) => slot.slotId));
  if (slotIds.size !== graph.slots.length) fail('INVALID_GRAPH', `${label}: duplicate slot id`);
  const snapshotIds = new Set(graph.snapshots.map((snapshot) => snapshot.snapshotId));
  if (snapshotIds.size !== graph.snapshots.length) fail('INVALID_GRAPH', `${label}: duplicate snapshot id`);
  for (const snapshot of graph.snapshots) {
    if (!nodeIds.has(snapshot.nodeId)) fail('INVALID_GRAPH', `${label}: snapshot ${snapshot.snapshotId} dangles on a missing node`);
    for (const slotId of Object.keys(snapshot.bindings)) {
      if (!slotIds.has(slotId)) fail('INVALID_GRAPH', `${label}: snapshot ${snapshot.snapshotId} binds unknown slot ${slotId}`);
    }
    if (snapshot.parentSnapshotRef !== null && !snapshotIds.has(snapshot.parentSnapshotRef)) {
      fail('INVALID_GRAPH', `${label}: snapshot ${snapshot.snapshotId} dangles on a missing parent snapshot`);
    }
  }
  for (const node of graph.nodes) {
    if (node.snapshotRef !== null && !snapshotIds.has(node.snapshotRef)) {
      fail('INVALID_GRAPH', `${label}: node ${node.nodeId} points at a missing snapshot`);
    }
    const chain = graph.snapshots.filter((snapshot) => snapshot.nodeId === node.nodeId).sort((a, b) => a.revision - b.revision);
    chain.forEach((snapshot, index) => {
      if (snapshot.revision !== index + 1) fail('INVALID_GRAPH', `${label}: node ${node.nodeId} snapshot revisions are not contiguous from 1`);
    });
  }
}

// ----------------- Receipts and the whole state -----------------

export interface OperationReceipt {
  operationId: string;
  kind: string;
  researchId: string | null;
  /** Hash over the semantic request (baseRevision excluded; it is a concurrency hint). */
  requestHash: string;
  /** State revision AFTER this operation; replay returns the original result without writing. */
  resultRevision: number;
  result: Record<string, unknown>;
  createdAt: string;
}

export interface ResearchBootstrap {
  /** Optional, strict generic extension. Legacy projects remain byte-semantically unchanged. */
  general?: GeneralResearch;
  researchId: string;
  title: string;
  contract: ResearchContract;
  environment: EnvironmentObservation[];
  brainstormRuns: BrainstormRun[];
  ideas: ResearchIdea[];
  graph: ResearchGraph | null;
  /**
   * The last trusted user selection of ideas (native action id + actor). Model-supplied idea id
   * lists are checked against this, so a model cannot smuggle unselected ideas into a graph.
   */
  selectionProof: { actionId: string; actorIdentity: string; at: string; ideaIds: string[] } | null;
  updatedAt: string;
}

export interface BootstrapState {
  schemaVersion: 1;
  revision: number;
  activeResearchId: string | null;
  researches: ResearchBootstrap[];
  receipts: OperationReceipt[];
  /**
   * Batch 1 「已有研究目录只读接管」 records. Optional so a legacy workspace stays byte-identical:
   * absent means "no takeover ever ran here", which is not the same as an empty list.
   */
  takeovers?: TakeoverRecord[];
}

function validateBrainstormRun(raw: unknown, label: string): BrainstormRun {
  const o = keys(raw, ['runId', 'operationId', 'agentIdentity', 'modelIdentity', 'contractRevision', 'inputRefs', 'inputEnvironmentIds',
    'inputNotes', 'status', 'ideaIds', 'itemErrors', 'duplicates', 'emptyResultReason', 'error', 'startedAt', 'finishedAt'], label);
  let error: BrainstormRun['error'] = null;
  if (o.error !== null && o.error !== undefined) {
    const e = keys(o.error, ['code', 'message'], `${label}.error`);
    error = { code: reqText(e.code, `${label}.error.code`, 100), message: reqText(e.message, `${label}.error.message`, 2000) };
  }
  return {
    runId: reqId(o.runId, `${label}.runId`),
    operationId: optText(o.operationId, `${label}.operationId`, 200),
    agentIdentity: reqText(o.agentIdentity, `${label}.agentIdentity`, 200),
    modelIdentity: optText(o.modelIdentity, `${label}.modelIdentity`, 200),
    contractRevision: reqInt(o.contractRevision, `${label}.contractRevision`, 1),
    inputRefs: validateEvidenceRefs(o.inputRefs, `${label}.inputRefs`),
    inputEnvironmentIds: reqArray(o.inputEnvironmentIds, `${label}.inputEnvironmentIds`, 50).map((entry, index) => reqId(entry, `${label}.inputEnvironmentIds[${index}]`)),
    inputNotes: optText(o.inputNotes, `${label}.inputNotes`, 2000),
    status: reqEnum(o.status, RUN_STATUSES, `${label}.status`),
    ideaIds: reqArray(o.ideaIds, `${label}.ideaIds`, BOOTSTRAP_BOUNDS.maxIdeasPerRun).map((entry, index) => reqId(entry, `${label}.ideaIds[${index}]`)),
    itemErrors: reqArray(o.itemErrors, `${label}.itemErrors`, 50).map((entry, index) => {
      const e = keys(entry, ['label', 'code', 'message'], `${label}.itemErrors[${index}]`);
      return { label: reqText(e.label, `${label}.itemErrors[${index}].label`, 200), code: reqText(e.code, `${label}.itemErrors[${index}].code`, 100), message: reqText(e.message, `${label}.itemErrors[${index}].message`, 2000) };
    }),
    duplicates: reqArray(o.duplicates, `${label}.duplicates`, 50).map((entry, index) => {
      const d = keys(entry, ['submittedLabel', 'existingIdeaId'], `${label}.duplicates[${index}]`);
      return { submittedLabel: reqText(d.submittedLabel, `${label}.duplicates[${index}].submittedLabel`, 200), existingIdeaId: reqId(d.existingIdeaId, `${label}.duplicates[${index}].existingIdeaId`) };
    }),
    emptyResultReason: optText(o.emptyResultReason, `${label}.emptyResultReason`, 2000),
    error,
    startedAt: reqIso(o.startedAt, `${label}.startedAt`),
    finishedAt: o.finishedAt === null || o.finishedAt === undefined ? null : reqIso(o.finishedAt, `${label}.finishedAt`),
  };
}

function validateResearchBootstrap(raw: unknown, label: string): ResearchBootstrap {
  const o = keys(raw, ['researchId', 'title', 'contract', 'environment', 'brainstormRuns', 'ideas', 'graph', 'selectionProof', 'updatedAt', 'general'], label);
  let general: GeneralResearch | undefined;
  if (o.general !== undefined) {
    try { general = validateGeneralResearch(o.general); }
    catch (error) { fail('SCHEMA_VIOLATION', `${label}.general: ${error instanceof Error ? error.message : String(error)}`); }
  }
  let selectionProof: ResearchBootstrap['selectionProof'] = null;
  if (o.selectionProof !== null && o.selectionProof !== undefined) {
    const s = keys(o.selectionProof, ['actionId', 'actorIdentity', 'at', 'ideaIds'], `${label}.selectionProof`);
    selectionProof = {
      actionId: reqText(s.actionId, `${label}.selectionProof.actionId`, 200),
      actorIdentity: reqText(s.actorIdentity, `${label}.selectionProof.actorIdentity`, 200),
      at: reqIso(s.at, `${label}.selectionProof.at`),
      ideaIds: reqArray(s.ideaIds, `${label}.selectionProof.ideaIds`, BOOTSTRAP_BOUNDS.maxIdeasPerRun).map((entry, index) => reqId(entry, `${label}.selectionProof.ideaIds[${index}]`)),
    };
  }
  return {
    ...(general === undefined ? {} : { general }),
    researchId: reqId(o.researchId, `${label}.researchId`),
    title: reqText(o.title, `${label}.title`, 300),
    contract: validateResearchContract(o.contract, `${label}.contract`),
    environment: reqArray(o.environment, `${label}.environment`, BOOTSTRAP_BOUNDS.maxObservationsPerResearch).map((entry, index) => validateObservation(entry, `${label}.environment[${index}]`)),
    brainstormRuns: reqArray(o.brainstormRuns, `${label}.brainstormRuns`, BOOTSTRAP_BOUNDS.maxRunsPerResearch).map((entry, index) => validateBrainstormRun(entry, `${label}.brainstormRuns[${index}]`)),
    ideas: reqArray(o.ideas, `${label}.ideas`, BOOTSTRAP_BOUNDS.maxIdeasPerResearch).map((entry, index) => validateResearchIdea(entry, `${label}.ideas[${index}]`)),
    graph: o.graph === null || o.graph === undefined ? null : validateResearchGraph(o.graph, `${label}.graph`),
    selectionProof,
    updatedAt: reqIso(o.updatedAt, `${label}.updatedAt`),
  };
}

function validateReceipt(raw: unknown, label: string): OperationReceipt {
  const o = keys(raw, ['operationId', 'kind', 'researchId', 'requestHash', 'resultRevision', 'result', 'createdAt'], label);
  return {
    operationId: reqText(o.operationId, `${label}.operationId`, 200),
    kind: reqText(o.kind, `${label}.kind`, 100),
    researchId: optText(o.researchId, `${label}.researchId`, 200),
    requestHash: reqHex64(o.requestHash, `${label}.requestHash`),
    resultRevision: reqInt(o.resultRevision, `${label}.resultRevision`, 1),
    result: isRecord(o.result) ? (o.result as Record<string, unknown>) : fail('SCHEMA_VIOLATION', `${label}.result must be an object`),
    createdAt: reqIso(o.createdAt, `${label}.createdAt`),
  };
}

/**
 * Full-state validator, used on every read AND immediately before every write, so a committed
 * file can always be read back. A damaged or hand-edited state is STATE_CORRUPT, never “empty”.
 */
export function validateBootstrapState(raw: unknown, label = 'state'): BootstrapState {
  const o = keys(raw, ['schemaVersion', 'revision', 'activeResearchId', 'researches', 'receipts', 'takeovers'], label);
  if (o.schemaVersion !== BOOTSTRAP_SCHEMA_VERSION) fail('STATE_CORRUPT', `${label}: unsupported schemaVersion ${JSON.stringify(o.schemaVersion)}`);
  const researches = reqArray(o.researches, `${label}.researches`, BOOTSTRAP_BOUNDS.maxResearches).map((entry, index) => validateResearchBootstrap(entry, `${label}.researches[${index}]`));
  const researchIds = new Set(researches.map((research) => research.researchId));
  if (researchIds.size !== researches.length) fail('STATE_CORRUPT', `${label}: duplicate researchId`);
  const activeResearchId = o.activeResearchId === null || o.activeResearchId === undefined ? null : reqId(o.activeResearchId, `${label}.activeResearchId`);
  if (activeResearchId !== null && !researchIds.has(activeResearchId)) {
    fail('STATE_CORRUPT', `${label}: activeResearchId does not match any research`);
  }
  const receipts = reqArray(o.receipts, `${label}.receipts`, Number.MAX_SAFE_INTEGER).map((entry, index) => validateReceipt(entry, `${label}.receipts[${index}]`));
  const operationIds = new Set(receipts.map((receipt) => receipt.operationId));
  if (operationIds.size !== receipts.length) fail('STATE_CORRUPT', `${label}: duplicate operationId in receipts`);
  // Absent takeovers means "never ran here"; the key is omitted again on write so legacy stays byte-identical.
  let takeovers: TakeoverRecord[] | undefined;
  if (o.takeovers !== undefined && o.takeovers !== null) {
    try { takeovers = validateTakeoverList(o.takeovers, `${label}.takeovers`); }
    catch (error) { fail('SCHEMA_VIOLATION', `${label}.takeovers: ${error instanceof Error ? error.message : String(error)}`); }
    for (const takeover of takeovers!) {
      if (takeover.researchId !== null && !researchIds.has(takeover.researchId)) {
        fail('SCHEMA_VIOLATION', `${label}.takeovers: takeover ${takeover.takeoverId} refers to unknown research ${takeover.researchId}`);
      }
    }
  }
  return {
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    revision: reqInt(o.revision, `${label}.revision`, 0),
    activeResearchId,
    researches,
    receipts,
    ...(takeovers === undefined ? {} : { takeovers }),
  };
}

export function emptyBootstrapState(): BootstrapState {
  return { schemaVersion: BOOTSTRAP_SCHEMA_VERSION, revision: 0, activeResearchId: null, researches: [], receipts: [] };
}

// ----------------- Source resolution (paper library binding) -----------------

/** Structural snapshot of one library paper as seen through a resolver. */
export interface BootstrapPaperSnapshot {
  paperId: string;
  sourceSha256: string;
  /** Joint library revision; null when never published. */
  revision: string | null;
  title: string;
  sections: Array<{ heading: string; summary: string; page: number; quote: string }> | null;
  components: Array<{ kind: string; name: string; description: string; page: number; quote: string }> | null;
}

/** Read-only view of the workspace paper library; the adapter owns the real implementation. */
export interface BootstrapSourceResolver {
  /** null = the paperId does not exist in this workspace's library. */
  getPaper(paperId: string): BootstrapPaperSnapshot | null;
}

export const WIKI_ENTRY_HASH_DOMAIN = 'research-bootstrap-wiki-entry-v1';
export const COMPONENT_ENTRY_HASH_DOMAIN = 'research-bootstrap-component-entry-v1';

/** Content identity of one wiki section — stable across section list reordering. */
export function wikiEntryContentHash(entry: { heading: string; summary: string; page: number; quote: string }): string {
  return bootstrapContentHash(WIKI_ENTRY_HASH_DOMAIN, entry);
}

/** Content identity of one extracted component — stable across component list reordering. */
export function componentEntryContentHash(entry: { kind: string; name: string; description: string; page: number; quote: string }): string {
  return bootstrapContentHash(COMPONENT_ENTRY_HASH_DOMAIN, entry);
}

export type EvidenceStatus = 'current' | 'stale' | 'missing';

export interface EvidenceAssessment {
  status: EvidenceStatus;
  /** null when current without remarks; otherwise the precise, entry-level reason. */
  detail: string | null;
  /** When the same content still exists at another index: where it moved to. */
  movedToIndex: number | null;
}

/**
 * Entry-level reference check. Identity is (sourceSha256, entry contentHash) — the library
 * revision and list index are version locators, not identity, so “another field changed but the
 * target content is unchanged” stays `current` instead of being misreported as lost.
 */
export function assessEvidenceRef(ref: EvidenceRef, resolver: BootstrapSourceResolver): EvidenceAssessment {
  const paper = resolver.getPaper(ref.paperId);
  if (paper === null) return { status: 'missing', detail: `paper ${ref.paperId} is not in this workspace's library`, movedToIndex: null };
  if (paper.sourceSha256 !== ref.sourceSha256) {
    return { status: 'missing', detail: `paper ${ref.paperId} now carries a different source (${paper.sourceSha256.slice(0, 12)}…)`, movedToIndex: null };
  }
  if (ref.assetKind === 'source') return { status: 'current', detail: null, movedToIndex: null };
  const entries: Array<{ hash: string }> = [];
  if (ref.assetKind === 'wiki') {
    if (paper.sections === null) return { status: 'stale', detail: 'the paper has no published wiki anymore', movedToIndex: null };
    paper.sections.forEach((section) => entries.push({ hash: wikiEntryContentHash(section) }));
  } else {
    if (paper.components === null) return { status: 'stale', detail: 'the paper has no published components anymore', movedToIndex: null };
    paper.components.forEach((component) => entries.push({ hash: componentEntryContentHash(component) }));
  }
  const at = ref.entryIndex !== null ? entries[ref.entryIndex] : undefined;
  if (at !== undefined && at.hash === ref.contentHash) {
    const revisionNote = ref.assetRevision !== null && paper.revision !== null && paper.revision !== ref.assetRevision
      ? `; library revision changed to ${paper.revision.slice(0, 12)}… but this entry is content-identical`
      : null;
    return { status: 'current', detail: revisionNote, movedToIndex: null };
  }
  const moved = entries.findIndex((entry) => entry.hash === ref.contentHash);
  if (moved >= 0) {
    return { status: 'current', detail: `entry moved from index ${ref.entryIndex} to ${moved} (content identical)`, movedToIndex: moved };
  }
  return { status: 'stale', detail: `the referenced ${ref.assetKind} entry (hash ${ref.contentHash.slice(0, 12)}…) no longer exists in paper ${ref.paperId}`, movedToIndex: null };
}

// ----------------- Fixture builders (draft/confirmed/partial/graphless examples) -----------------

const nowIso = () => new Date().toISOString();
export const mintBootstrapId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;

/** A minimal valid draft contract (everything important still open — BE-I01's starting point). */
export function draftResearchContract(input: { goal?: string; researchQuestion?: string } = {}): ResearchContract {
  return {
    revision: 1,
    status: 'draft',
    researchQuestion: input.researchQuestion ?? null,
    goal: input.goal ?? null,
    baseline: { status: 'undecided', name: null, paperRef: null, repoLocator: null },
    dataDescription: null,
    metrics: [],
    guardrails: [],
    editableScope: [],
    lockedScope: [],
    computeBudget: null,
    timeBudget: null,
    autonomy: BOOTSTRAP_AUTONOMY,
    pendingQuestions: [],
    confirmations: [],
    updatedAt: nowIso(),
  };
}
