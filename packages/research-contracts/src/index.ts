/**
 * Research facts that an external agent can address without a DSH session.
 * Actor and approval values are stored only after a trusted caller injects them.
 */
import {
  validateAssignmentList,
  validateIdeaList,
  validateKnowledgeList,
  validatePlanList,
  validateReviewList,
  validateRunList,
  validateSearchList,
  type AssignmentRecord,
  type ExperimentPlanRecord,
  type ExperimentRunRecord,
  type KnowledgeCard,
  type ResearchIdeaRecord,
  type ReviewRecord,
  type SearchRecord,
} from './records.ts';

export const RESEARCH_PROJECT_SCHEMA_VERSION = 1 as const;

export const ACTOR_KINDS = ['user', 'agent', 'system'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

export const ACTOR_SOURCES = ['cli', 'http', 'mcp', 'adapter'] as const;
export type ActorSource = (typeof ACTOR_SOURCES)[number];

export const APPROVAL_CAPABILITIES = ['select_idea', 'accept_decision', 'export_assignment'] as const;
export type ApprovalCapability = (typeof APPROVAL_CAPABILITIES)[number];

export const RESEARCH_CORE_ERROR_CODES = [
  'INVALID_INPUT',
  'NOT_FOUND',
  'STATE_CORRUPT',
  'STATE_WRITE_FAILED',
  'REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'HOST_BUSY',
  'PATH_ESCAPE',
  'QUOTA',
  'ALREADY_EXISTS',
  'SCHEMA_VIOLATION',
] as const;
export type ResearchCoreErrorCode = (typeof RESEARCH_CORE_ERROR_CODES)[number];

export class ResearchCoreError extends Error {
  readonly code: ResearchCoreErrorCode;
  constructor(code: ResearchCoreErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ResearchCoreError';
    this.code = code;
  }
}

/** Trusted caller. Tool arguments are not allowed to construct this value. */
export interface ActorContext {
  actorId: string;
  kind: ActorKind;
  source: ActorSource;
}

export interface ApprovalRecord {
  approvalId: string;
  projectId: string;
  subjectId: string;
  subjectRevision: number;
  subjectHash: string;
  capability: ApprovalCapability;
  actorId: string;
  actorKind: ActorKind;
  actorSource: ActorSource;
  createdAt: string;
}

export interface SourceRecord {
  filename?: string;
  sourceId: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  importedAt: string;
}

export interface ProjectReceipt {
  operationId: string;
  kind: string;
  requestHash: string;
  resultRevision: number;
  result: Record<string, unknown>;
  createdAt: string;
}

export interface ResearchProjectState {
  schemaVersion: typeof RESEARCH_PROJECT_SCHEMA_VERSION;
  projectId: string;
  goal: string;
  constraints: string[];
  revision: number;
  sources: SourceRecord[];
  approvals: ApprovalRecord[];
  receipts: ProjectReceipt[];
  knowledge: KnowledgeCard[];
  ideas: ResearchIdeaRecord[];
  plans: ExperimentPlanRecord[];
  assignments: AssignmentRecord[];
  runs: ExperimentRunRecord[];
  reviews: ReviewRecord[];
  searches: SearchRecord[];
  /** Relative legacy directory, or null when this project has no old workspace. */
  legacyRoot: '.dsh/research' | null;
  /** sha256 over the canonical project with this field removed. Hand edits fail closed. */
  stateHash: string;
}

export interface LegacyAdapterMetadata {
  present: boolean;
  authoritative: false;
  sessionId: string | null;
  grantId: string | null;
}

export interface ResultCatalogCounts {
  externalReportedSucceeded: number;
  externalReportedFailed: number;
  mock: number;
}

export interface LegacyInventory {
  bootstrapPresent: boolean;
  bootstrapRevision: number | null;
  researchCount: number;
  ideaCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  receiptCount: number;
  wikiEvidenceCount: number;
  sourceEvidenceCount: number;
  results: ResultCatalogCounts;
  legacyAdapter: LegacyAdapterMetadata;
}

const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const PROJECT_ID = /^proj-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function fail(code: ResearchCoreErrorCode, detail: string): never {
  throw new ResearchCoreError(code, detail);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('SCHEMA_VIOLATION', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  const obj = record(value, label);
  const unknown = Object.keys(obj).filter((key) => !allowed.includes(key));
  if (unknown.length) fail('SCHEMA_VIOLATION', `${label} has unknown field(s): ${unknown.join(', ')}`);
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(obj, key));
  if (missing.length) fail('SCHEMA_VIOLATION', `${label} is missing field(s): ${missing.join(', ')}`);
  return obj;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    fail('SCHEMA_VIOLATION', `${label} must be non-empty text of at most ${max} characters`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail('SCHEMA_VIOLATION', `${label} must be an integer >= ${minimum}`);
  }
  return value;
}

export function validateActorContext(value: unknown): ActorContext {
  const obj = exactKeys(value, ['actorId', 'kind', 'source'], 'actor');
  const kind = obj.kind;
  const source = obj.source;
  if (typeof kind !== 'string' || !(ACTOR_KINDS as readonly string[]).includes(kind)) fail('SCHEMA_VIOLATION', 'actor.kind is not a known kind');
  if (typeof source !== 'string' || !(ACTOR_SOURCES as readonly string[]).includes(source)) fail('SCHEMA_VIOLATION', 'actor.source is not a known source');
  return { actorId: text(obj.actorId, 'actor.actorId', 200), kind: kind as ActorKind, source: source as ActorSource };
}

export function validateApproval(value: unknown, label: string): ApprovalRecord {
  const obj = exactKeys(value, ['approvalId', 'projectId', 'subjectId', 'subjectRevision', 'subjectHash', 'capability', 'actorId', 'actorKind', 'actorSource', 'createdAt'], label);
  const capability = obj.capability;
  const actorKind = obj.actorKind;
  const actorSource = obj.actorSource;
  if (typeof capability !== 'string' || !(APPROVAL_CAPABILITIES as readonly string[]).includes(capability)) fail('SCHEMA_VIOLATION', `${label}.capability is not allowed`);
  if (typeof actorKind !== 'string' || !(ACTOR_KINDS as readonly string[]).includes(actorKind)) fail('SCHEMA_VIOLATION', `${label}.actorKind is not a known kind`);
  if (typeof actorSource !== 'string' || !(ACTOR_SOURCES as readonly string[]).includes(actorSource)) fail('SCHEMA_VIOLATION', `${label}.actorSource is not a known source`);
  const subjectHash = obj.subjectHash;
  const createdAt = obj.createdAt;
  if (typeof subjectHash !== 'string' || !HEX64.test(subjectHash)) fail('SCHEMA_VIOLATION', `${label}.subjectHash must be a sha256`);
  if (typeof createdAt !== 'string' || !ISO.test(createdAt)) fail('SCHEMA_VIOLATION', `${label}.createdAt must be UTC`);
  return {
    approvalId: text(obj.approvalId, `${label}.approvalId`, 200),
    projectId: text(obj.projectId, `${label}.projectId`, 80),
    subjectId: text(obj.subjectId, `${label}.subjectId`, 200),
    subjectRevision: integer(obj.subjectRevision, `${label}.subjectRevision`, 0),
    subjectHash,
    capability: capability as ApprovalCapability,
    actorId: text(obj.actorId, `${label}.actorId`, 200),
    actorKind: actorKind as ActorKind,
    actorSource: actorSource as ActorSource,
    createdAt,
  };
}

function validateSource(value: unknown, label: string): SourceRecord {
  const hasFilename = typeof value === 'object' && value !== null && Object.hasOwn(value, 'filename');
  const obj = exactKeys(value, ['sourceId', 'relativePath', 'sha256', 'bytes', 'mediaType', 'importedAt', ...(hasFilename ? ['filename'] : [])], label);
  const relativePath = text(obj.relativePath, `${label}.relativePath`, 500);
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    fail('SCHEMA_VIOLATION', `${label}.relativePath must stay inside the research root`);
  }
  const sha256 = obj.sha256;
  const importedAt = obj.importedAt;
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) fail('SCHEMA_VIOLATION', `${label}.sha256 must be a sha256`);
  if (typeof importedAt !== 'string' || !ISO.test(importedAt)) fail('SCHEMA_VIOLATION', `${label}.importedAt must be UTC`);
  return {
    sourceId: text(obj.sourceId, `${label}.sourceId`, 80),
    relativePath: relativePath.replaceAll('\\', '/'),
    sha256,
    bytes: integer(obj.bytes, `${label}.bytes`, 0),
    mediaType: text(obj.mediaType, `${label}.mediaType`, 100),
    importedAt,
    ...(hasFilename ? { filename: text(obj.filename, `${label}.filename`, 500) } : {}),
  };
}

function validateReceipt(value: unknown, label: string): ProjectReceipt {
  const obj = exactKeys(value, ['operationId', 'kind', 'requestHash', 'resultRevision', 'result', 'createdAt'], label);
  const requestHash = obj.requestHash;
  const createdAt = obj.createdAt;
  if (typeof requestHash !== 'string' || !HEX64.test(requestHash)) fail('SCHEMA_VIOLATION', `${label}.requestHash must be a sha256`);
  if (typeof createdAt !== 'string' || !ISO.test(createdAt)) fail('SCHEMA_VIOLATION', `${label}.createdAt must be UTC`);
  if (typeof obj.result !== 'object' || obj.result === null || Array.isArray(obj.result)) fail('SCHEMA_VIOLATION', `${label}.result must be an object`);
  return {
    operationId: text(obj.operationId, `${label}.operationId`, 200),
    kind: text(obj.kind, `${label}.kind`, 100),
    requestHash,
    resultRevision: integer(obj.resultRevision, `${label}.resultRevision`, 1),
    result: obj.result as Record<string, unknown>,
    createdAt,
  };
}

export function validateResearchProjectState(value: unknown): ResearchProjectState {
  const obj = exactKeys(value, ['schemaVersion', 'projectId', 'goal', 'constraints', 'revision', 'sources', 'approvals', 'receipts', 'knowledge', 'ideas', 'plans', 'assignments', 'runs', 'reviews', 'searches', 'legacyRoot', 'stateHash'], 'project');
  if (obj.schemaVersion !== RESEARCH_PROJECT_SCHEMA_VERSION) fail('STATE_CORRUPT', `unsupported project schemaVersion ${JSON.stringify(obj.schemaVersion)}`);
  if (typeof obj.projectId !== 'string' || !PROJECT_ID.test(obj.projectId)) fail('SCHEMA_VIOLATION', 'projectId is not a project id');
  if (!Array.isArray(obj.constraints) || obj.constraints.length > 40) fail('SCHEMA_VIOLATION', 'constraints must be a short list');
  if (!Array.isArray(obj.sources) || obj.sources.length > 500) fail('SCHEMA_VIOLATION', 'sources must be a list');
  if (!Array.isArray(obj.approvals) || obj.approvals.length > 500) fail('SCHEMA_VIOLATION', 'approvals must be a list');
  if (!Array.isArray(obj.receipts)) fail('SCHEMA_VIOLATION', 'receipts must be a list');
  if (obj.legacyRoot !== null && obj.legacyRoot !== '.dsh/research') fail('SCHEMA_VIOLATION', 'legacyRoot must be null or .dsh/research');
  if (typeof obj.stateHash !== 'string' || !HEX64.test(obj.stateHash)) fail('STATE_CORRUPT', 'project stateHash must be a sha256');
  const receipts = obj.receipts.map((entry, index) => validateReceipt(entry, `receipts[${index}]`));
  if (new Set(receipts.map((entry) => entry.operationId)).size !== receipts.length) fail('STATE_CORRUPT', 'duplicate operationId in receipts');
  return {
    schemaVersion: RESEARCH_PROJECT_SCHEMA_VERSION,
    projectId: obj.projectId,
    goal: text(obj.goal, 'goal', 2000),
    constraints: obj.constraints.map((entry, index) => text(entry, `constraints[${index}]`, 300)),
    revision: integer(obj.revision, 'revision', 0),
    sources: obj.sources.map((entry, index) => validateSource(entry, `sources[${index}]`)),
    approvals: obj.approvals.map((entry, index) => validateApproval(entry, `approvals[${index}]`)),
    receipts,
    knowledge: validateKnowledgeList(obj.knowledge),
    ideas: validateIdeaList(obj.ideas),
    plans: validatePlanList(obj.plans),
    assignments: validateAssignmentList(obj.assignments),
    runs: validateRunList(obj.runs),
    reviews: validateReviewList(obj.reviews),
    searches: validateSearchList(obj.searches),
    legacyRoot: obj.legacyRoot,
    stateHash: obj.stateHash,
  };
}

export type {
  AssignmentRecord,
  ExperimentPlanRecord,
  ExperimentRunRecord,
  KnowledgeCard,
  MetricPin,
  ResearchIdeaRecord,
  ReviewRecord,
  SearchRecord,
} from './records.ts';

export function emptyResultCounts(): ResultCatalogCounts {
  return { externalReportedSucceeded: 0, externalReportedFailed: 0, mock: 0 };
}
