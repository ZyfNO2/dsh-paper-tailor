import { ResearchCoreError, type ActorKind, type ActorSource } from './index.ts';

const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

export interface KnowledgeCard {
  cardId: string;
  revision: number;
  kind: 'brief' | 'method' | 'evaluation';
  title: string;
  body: string;
  sourceIds: string[];
  unknowns: string[];
  updatedAt: string;
  citations?: Array<{ sourceId: string; sha256: string; startByte: number; endByte: number; quote: string }>;
}

export interface ResearchIdeaRecord {
  ideaId: string;
  revision: number;
  title: string;
  hypothesis: string;
  change: string;
  mechanism: string;
  falsifier: string;
  sourceIds: string[];
  status: 'candidate' | 'selected';
  updatedAt: string;
}

export interface ExperimentPlanRecord {
  planId: string;
  revision: number;
  ideaId: string;
  baseline: string;
  variable: string;
  fixedConditions: string[];
  split: string;
  seedPolicy: string;
  metric: string;
  metricUnit: string;
  budget: string;
  stopCondition: string;
  status: 'draft';
  contentHash: string;
  updatedAt: string;
}

export interface AssignmentRecord {
  assignmentId: string;
  planId: string;
  planRevision: number;
  planHash: string;
  role: 'engineer';
  reviewMode: 'self_review';
  status: 'prepared';
  expectedOutputs: ['patch', 'run-manifest', 'validation-report'];
  createdAt: string;
}

export interface MetricPin {
  name: string;
  value: number | null;
  unit: string;
  row: number;
  column: number;
  token: string;
}

export interface ExperimentRunRecord {
  runId: string;
  planId: string;
  planRevision: number;
  planHash: string;
  assignmentId: string;
  manifestSha256: string;
  metricsSha256: string;
  execution: 'succeeded' | 'failed' | 'unknown';
  recordKind: 'external_reported' | 'mock';
  attestation: 'external_reported' | 'mock_not_executed';
  metrics: MetricPin[];
  split: string;
  configHash: string;
  comparability: 'pending' | 'comparable' | 'incomparable';
  comparabilityReason: string;
  freshness: 'current' | 'stale';
  createdAt: string;
}

export interface ReviewRecord {
  reviewId: string;
  runIds: string[];
  judgment: 'supported' | 'contradicted' | 'inconclusive';
  reviewMode: 'self_review';
  reason: string;
  nextStep: string;
  subjectHash: string;
  actorKind: ActorKind;
  actorSource: ActorSource;
  createdAt: string;
}

export interface SearchRecord {
  searchId: string;
  query: string;
  provider: null;
  status: 'search_incomplete';
  reason: string;
  createdAt: string;
}

function fail(detail: string): never {
  throw new ResearchCoreError('SCHEMA_VIOLATION', detail);
}

function object(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${label} must be an object`);
  const obj = value as Record<string, unknown>;
  const unknown = Object.keys(obj).filter((key) => !fields.includes(key));
  if (unknown.length) fail(`${label} has unknown field(s): ${unknown.join(', ')}`);
  const missing = fields.filter((key) => !Object.prototype.hasOwnProperty.call(obj, key));
  if (missing.length) fail(`${label} is missing field(s): ${missing.join(', ')}`);
  return obj;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) fail(`${label} must be non-empty text`);
  return value;
}

function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID.test(value)) fail(`${label} must be a stable id`);
  return value;
}

function hex(value: unknown, label: string): string {
  if (typeof value !== 'string' || !HEX64.test(value)) fail(`${label} must be a sha256`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ISO.test(value)) fail(`${label} must be UTC`);
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(`${label} must be an integer >= ${minimum}`);
  return value;
}

function one<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) fail(`${label} is not an allowed value`);
  return value as T;
}

function list(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be a list of at most ${max} items`);
  return value;
}

function knowledge(value: unknown, label: string): KnowledgeCard {
  const hasCitations = typeof value === 'object' && value !== null && Object.hasOwn(value, 'citations');
  const obj = object(value, ['cardId', 'revision', 'kind', 'title', 'body', 'sourceIds', 'unknowns', 'updatedAt', ...(hasCitations ? ['citations'] : [])], label);
  return {
    cardId: id(obj.cardId, `${label}.cardId`),
    revision: integer(obj.revision, `${label}.revision`, 1),
    kind: one(obj.kind, ['brief', 'method', 'evaluation'] as const, `${label}.kind`),
    title: text(obj.title, `${label}.title`, 300),
    body: text(obj.body, `${label}.body`, 4000),
    sourceIds: list(obj.sourceIds, `${label}.sourceIds`, 20).map((entry, index) => id(entry, `${label}.sourceIds[${index}]`)),
    unknowns: list(obj.unknowns, `${label}.unknowns`, 20).map((entry, index) => text(entry, `${label}.unknowns[${index}]`, 300)),
    updatedAt: iso(obj.updatedAt, `${label}.updatedAt`),
    ...(hasCitations ? { citations: list(obj.citations, `${label}.citations`, 20).map((entry) => {
      const c = object(entry, ['sourceId', 'sha256', 'startByte', 'endByte', 'quote'], 'citation');
      return { sourceId: id(c.sourceId, 'citation.sourceId'), sha256: hex(c.sha256, 'citation.sha256'), startByte: integer(c.startByte, 'citation.startByte', 0), endByte: integer(c.endByte, 'citation.endByte', 1), quote: text(c.quote, 'citation.quote', 2000) };
    }) } : {}),
  };
}

function idea(value: unknown, label: string): ResearchIdeaRecord {
  const obj = object(value, ['ideaId', 'revision', 'title', 'hypothesis', 'change', 'mechanism', 'falsifier', 'sourceIds', 'status', 'updatedAt'], label);
  const sourceIds = list(obj.sourceIds, `${label}.sourceIds`, 20).map((entry, index) => id(entry, `${label}.sourceIds[${index}]`));
  if (!sourceIds.length) fail(`${label} requires a source`);
  return {
    ideaId: id(obj.ideaId, `${label}.ideaId`),
    revision: integer(obj.revision, `${label}.revision`, 1),
    title: text(obj.title, `${label}.title`, 300),
    hypothesis: text(obj.hypothesis, `${label}.hypothesis`, 2000),
    change: text(obj.change, `${label}.change`, 2000),
    mechanism: text(obj.mechanism, `${label}.mechanism`, 2000),
    falsifier: text(obj.falsifier, `${label}.falsifier`, 2000),
    sourceIds,
    status: one(obj.status, ['candidate', 'selected'] as const, `${label}.status`),
    updatedAt: iso(obj.updatedAt, `${label}.updatedAt`),
  };
}

function plan(value: unknown, label: string): ExperimentPlanRecord {
  const obj = object(value, ['planId', 'revision', 'ideaId', 'baseline', 'variable', 'fixedConditions', 'split', 'seedPolicy', 'metric', 'metricUnit', 'budget', 'stopCondition', 'status', 'contentHash', 'updatedAt'], label);
  return {
    planId: id(obj.planId, `${label}.planId`),
    revision: integer(obj.revision, `${label}.revision`, 1),
    ideaId: id(obj.ideaId, `${label}.ideaId`),
    baseline: text(obj.baseline, `${label}.baseline`, 500),
    variable: text(obj.variable, `${label}.variable`, 500),
    fixedConditions: list(obj.fixedConditions, `${label}.fixedConditions`, 20).map((entry, index) => text(entry, `${label}.fixedConditions[${index}]`, 300)),
    split: text(obj.split, `${label}.split`, 200),
    seedPolicy: text(obj.seedPolicy, `${label}.seedPolicy`, 200),
    metric: text(obj.metric, `${label}.metric`, 200),
    metricUnit: text(obj.metricUnit, `${label}.metricUnit`, 80),
    budget: text(obj.budget, `${label}.budget`, 200),
    stopCondition: text(obj.stopCondition, `${label}.stopCondition`, 500),
    status: one(obj.status, ['draft'] as const, `${label}.status`),
    contentHash: hex(obj.contentHash, `${label}.contentHash`),
    updatedAt: iso(obj.updatedAt, `${label}.updatedAt`),
  };
}

function assignment(value: unknown, label: string): AssignmentRecord {
  const obj = object(value, ['assignmentId', 'planId', 'planRevision', 'planHash', 'role', 'reviewMode', 'status', 'expectedOutputs', 'createdAt'], label);
  const outputs = list(obj.expectedOutputs, `${label}.expectedOutputs`, 3);
  if (outputs.join(',') !== 'patch,run-manifest,validation-report') fail(`${label}.expectedOutputs changed`);
  return {
    assignmentId: id(obj.assignmentId, `${label}.assignmentId`),
    planId: id(obj.planId, `${label}.planId`),
    planRevision: integer(obj.planRevision, `${label}.planRevision`, 1),
    planHash: hex(obj.planHash, `${label}.planHash`),
    role: one(obj.role, ['engineer'] as const, `${label}.role`),
    reviewMode: one(obj.reviewMode, ['self_review'] as const, `${label}.reviewMode`),
    status: one(obj.status, ['prepared'] as const, `${label}.status`),
    expectedOutputs: ['patch', 'run-manifest', 'validation-report'],
    createdAt: iso(obj.createdAt, `${label}.createdAt`),
  };
}

function metric(value: unknown, label: string): MetricPin {
  const obj = object(value, ['name', 'value', 'unit', 'row', 'column', 'token'], label);
  if (obj.value !== null && (typeof obj.value !== 'number' || !Number.isFinite(obj.value))) fail(`${label}.value must be a finite number or null`);
  return {
    name: text(obj.name, `${label}.name`, 200),
    value: obj.value as number | null,
    unit: text(obj.unit, `${label}.unit`, 80),
    row: integer(obj.row, `${label}.row`, 0),
    column: integer(obj.column, `${label}.column`, 0),
    token: text(obj.token, `${label}.token`, 80),
  };
}

function run(value: unknown, label: string): ExperimentRunRecord {
  const obj = object(value, ['runId', 'planId', 'planRevision', 'planHash', 'assignmentId', 'manifestSha256', 'metricsSha256', 'execution', 'recordKind', 'attestation', 'metrics', 'split', 'configHash', 'comparability', 'comparabilityReason', 'freshness', 'createdAt'], label);
  return {
    runId: id(obj.runId, `${label}.runId`),
    planId: id(obj.planId, `${label}.planId`),
    planRevision: integer(obj.planRevision, `${label}.planRevision`, 1),
    planHash: hex(obj.planHash, `${label}.planHash`),
    assignmentId: id(obj.assignmentId, `${label}.assignmentId`),
    manifestSha256: hex(obj.manifestSha256, `${label}.manifestSha256`),
    metricsSha256: hex(obj.metricsSha256, `${label}.metricsSha256`),
    execution: one(obj.execution, ['succeeded', 'failed', 'unknown'] as const, `${label}.execution`),
    recordKind: one(obj.recordKind, ['external_reported', 'mock'] as const, `${label}.recordKind`),
    attestation: one(obj.attestation, ['external_reported', 'mock_not_executed'] as const, `${label}.attestation`),
    metrics: list(obj.metrics, `${label}.metrics`, 20).map((entry, index) => metric(entry, `${label}.metrics[${index}]`)),
    split: text(obj.split, `${label}.split`, 200),
    configHash: hex(obj.configHash, `${label}.configHash`),
    comparability: one(obj.comparability, ['pending', 'comparable', 'incomparable'] as const, `${label}.comparability`),
    comparabilityReason: text(obj.comparabilityReason, `${label}.comparabilityReason`, 500),
    freshness: one(obj.freshness, ['current', 'stale'] as const, `${label}.freshness`),
    createdAt: iso(obj.createdAt, `${label}.createdAt`),
  };
}

function review(value: unknown, label: string): ReviewRecord {
  const obj = object(value, ['reviewId', 'runIds', 'judgment', 'reviewMode', 'reason', 'nextStep', 'subjectHash', 'actorKind', 'actorSource', 'createdAt'], label);
  const runIds = list(obj.runIds, `${label}.runIds`, 20).map((entry, index) => id(entry, `${label}.runIds[${index}]`));
  if (!runIds.length || new Set(runIds).size !== runIds.length) fail(`${label} needs distinct runs`);
  return {
    reviewId: id(obj.reviewId, `${label}.reviewId`),
    runIds,
    judgment: one(obj.judgment, ['supported', 'contradicted', 'inconclusive'] as const, `${label}.judgment`),
    reviewMode: one(obj.reviewMode, ['self_review'] as const, `${label}.reviewMode`),
    reason: text(obj.reason, `${label}.reason`, 4000),
    nextStep: text(obj.nextStep, `${label}.nextStep`, 2000),
    subjectHash: hex(obj.subjectHash, `${label}.subjectHash`),
    actorKind: one(obj.actorKind, ['user', 'agent', 'system'] as const, `${label}.actorKind`),
    actorSource: one(obj.actorSource, ['cli', 'http', 'mcp', 'adapter'] as const, `${label}.actorSource`),
    createdAt: iso(obj.createdAt, `${label}.createdAt`),
  };
}

function search(value: unknown, label: string): SearchRecord {
  const obj = object(value, ['searchId', 'query', 'provider', 'status', 'reason', 'createdAt'], label);
  if (obj.provider !== null) fail(`${label}.provider must be null until a provider is configured`);
  return {
    searchId: id(obj.searchId, `${label}.searchId`),
    query: text(obj.query, `${label}.query`, 500),
    provider: null,
    status: one(obj.status, ['search_incomplete'] as const, `${label}.status`),
    reason: text(obj.reason, `${label}.reason`, 500),
    createdAt: iso(obj.createdAt, `${label}.createdAt`),
  };
}

export function validateKnowledgeList(value: unknown): KnowledgeCard[] {
  return list(value, 'knowledge', 200).map((entry, index) => knowledge(entry, `knowledge[${index}]`));
}
export function validateIdeaList(value: unknown): ResearchIdeaRecord[] {
  const ideas = list(value, 'ideas', 200).map((entry, index) => idea(entry, `ideas[${index}]`));
  if (new Set(ideas.map((entry) => entry.ideaId)).size !== ideas.length) throw new ResearchCoreError('STATE_CORRUPT', 'duplicate ideaId');
  return ideas;
}
export function validatePlanList(value: unknown): ExperimentPlanRecord[] {
  const plans = list(value, 'plans', 200).map((entry, index) => plan(entry, `plans[${index}]`));
  if (new Set(plans.map((entry) => entry.planId)).size !== plans.length) throw new ResearchCoreError('STATE_CORRUPT', 'duplicate planId');
  return plans;
}
export function validateAssignmentList(value: unknown): AssignmentRecord[] {
  const assignments = list(value, 'assignments', 200).map((entry, index) => assignment(entry, `assignments[${index}]`));
  if (new Set(assignments.map((entry) => entry.assignmentId)).size !== assignments.length) throw new ResearchCoreError('STATE_CORRUPT', 'duplicate assignmentId');
  return assignments;
}
export function validateRunList(value: unknown): ExperimentRunRecord[] {
  const runs = list(value, 'runs', 500).map((entry, index) => run(entry, `runs[${index}]`));
  if (new Set(runs.map((entry) => entry.runId)).size !== runs.length) throw new ResearchCoreError('STATE_CORRUPT', 'duplicate runId');
  return runs;
}
export function validateReviewList(value: unknown): ReviewRecord[] {
  return list(value, 'reviews', 500).map((entry, index) => review(entry, `reviews[${index}]`));
}
export function validateSearchList(value: unknown): SearchRecord[] {
  return list(value, 'searches', 200).map((entry, index) => search(entry, `searches[${index}]`));
}
