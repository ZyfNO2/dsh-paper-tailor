import { validateGeneralSchedule, type GeneralSchedule } from './general-schedule.ts';
/**
 * Research Cycle shared contracts (Phase2 研究循环, schemaVersion 1).
 *
 * Plan: docs/mvp/redesign-2026-10-08/PHASE2-RESEARCH-LOOP-BRIEF-PLAN-2026-10-10.md,
 * architecture: docs/mvp/redesign-2026-10-08/PHASE2-RESEARCH-LOOP-ARCHITECTURE-2026-10-10.md.
 *
 * This is the persisted fact source for ONE research's Phase2 evidence loops:
 * `<workspace>/.dsh/research/cycles/<researchId>/state.json` plus immutable
 * content-addressed artifacts in `artifacts/`. The Phase1 bootstrap state
 * (`.dsh/research/bootstrap/state.json`) stays the fact source for research
 * inputs; the cycle layer never rewrites it.
 *
 * Hard boundaries (from the architecture doc):
 * - The base planning graph stays the Phase1 Bootstrap graph. Cycle layers add
 *   proposal / experiment_plan / evidence_report / decision / next_action nodes as
 *   INCREMENTS; they are never pushed into the Bootstrap NODE_KINDS enum.
 * - `plan_only` autonomy is preserved: nothing here runs training, executes code,
 *   or registers observations as verified science. `sourceNature` separates
 *   literature / existing experiment facts from clearly-marked simulation.
 * - EvidenceRef (Phase1 paper library origin) and ArtifactRef (published cycle
 *   content) are different things and never impersonate each other.
 */

import { canonicalJsonV1, sha256Hex } from '../domain/research-canonical.ts';
import type { ArtifactRef } from './experiments.ts';
import { expAssertArtifactRef } from './experiments.ts';
import {
  isBootstrapId,
  isHex64,
  isIsoTimestamp,
  validateEvidenceRef,
  type EvidenceRef,
  type IdeaRef,
  type OperationReceipt,
  type ResearchIdea,
} from './research-bootstrap.ts';

/** The idempotency receipt shape is shared with the bootstrap boundary. */
export type { OperationReceipt };

export const CYCLE_SCHEMA_VERSION = 1;

// ----------------- Error codes -----------------

/** Same vocabulary as the bootstrap boundary so hosts/UI map them uniformly. */
export const CYCLE_ERROR_CODES = [
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
  'SOURCE_MISMATCH',
  'INVALID_GRAPH',
  'INVALID_RESULT',
  'RECONCILIATION_REQUIRED',
  'DEPENDENCY_NOT_READY',
  'UNSUPPORTED_CAPABILITY',
  'BASE_GRAPH_CHANGED',
] as const;

export type CycleErrorCode = (typeof CYCLE_ERROR_CODES)[number];

export class CycleError extends Error {
  readonly code: CycleErrorCode;
  constructor(code: CycleErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CycleError';
    this.code = code;
  }
}

function fail(code: CycleErrorCode, detail?: string): never {
  throw new CycleError(code, detail);
}

// ----------------- Vocabularies -----------------

/** Business research roles for the evidence loop. Underlying runtime roles stay separate. */
export const CYCLE_ROLES = ['hypothesis', 'planner', 'evidence', 'reviewer'] as const;
export type CycleRole = (typeof CYCLE_ROLES)[number];

/** The four formal handoff artifact kinds. Input snapshots are not deliverables. */
export const CYCLE_ARTIFACT_KINDS = ['proposal', 'experiment_plan', 'evidence_report', 'decision'] as const;
export type CycleArtifactKind = (typeof CYCLE_ARTIFACT_KINDS)[number];

export const CYCLE_RUN_STATUSES = ['queued', 'running', 'waiting_result', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type CycleStatus = (typeof CYCLE_RUN_STATUSES)[number];

export const CYCLE_STEP_STATUSES = ['pending', 'assigned', 'running', 'waiting_result', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type CycleStepStatus = (typeof CYCLE_STEP_STATUSES)[number];

export const RESEARCH_DECISIONS = ['keep', 'pause', 'reject', 'needs_validation'] as const;
export type ResearchDecision = (typeof RESEARCH_DECISIONS)[number];

/** Finding provenance. `simulation` is always explicit — never merged into verified facts. */
export const FINDING_SOURCE_NATURES = ['literature', 'existing_experiment', 'simulation'] as const;
export type FindingSourceNature = (typeof FINDING_SOURCE_NATURES)[number];

/** Node kinds added by cycle increments on top of the Phase1 planning graph. */
export const CYCLE_NODE_KINDS = ['proposal', 'experiment_plan', 'evidence_report', 'decision', 'next_action'] as const;
export type CycleNodeKind = (typeof CYCLE_NODE_KINDS)[number];

/** Only `depends_on` is an execution (scheduling) relation; `derived_from` is a source link. */
export const CYCLE_EDGE_RELATIONS = ['depends_on', 'derived_from'] as const;
export type CycleEdgeRelation = (typeof CYCLE_EDGE_RELATIONS)[number];

export const NEXT_ACTION_KINDS = ['validation', 'combination', 'analysis', 'literature'] as const;
export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

/** Structural bounds, enforced by validators. */
export const CYCLE_BOUNDS = Object.freeze({
  maxRunsPerResearch: 100,
  maxStepsPerRun: 40,
  maxArtifactsPerResearch: 500,
  maxGraphNodesPerResearch: 200,
  maxGraphEdgesPerResearch: 400,
  maxInputRefsPerStep: 30,
  maxFindingsPerReport: 30,
  maxNextActionsPerDecision: 10,
  maxBranchDecisionsPerPatch: 10,
  textShort: 300,
  textMedium: 2000,
  textLong: 8000,
});

// ----------------- Small helpers (same strictness as bootstrap) -----------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function keys<R>(raw: unknown, allowed: readonly string[], label: string): Record<string, unknown> {
  if (!isRecord(raw)) fail('SCHEMA_VIOLATION', `${label} must be an object`);
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) fail('SCHEMA_VIOLATION', `${label} has unknown field(s): ${unknown.join(', ')}`);
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
const textList = (value: unknown, label: string, max: number, maxItems: number, entryMax: number): string[] => {
  return reqArray(value, label, maxItems).map((entry, index) => reqText(entry, `${label}[${index}]`, entryMax));
};

/** Canonical content hash of one cycle artifact payload. */
export function cycleContentHash(typeName: string, value: unknown): string {
  return sha256Hex(`${typeName}\n${canonicalJsonV1(value)}`);
}

// ----------------- Input refs -----------------

/** Two honest input origins: Phase1 paper evidence, or a published cycle artifact. */
export type CycleInputRef =
  | { kind: 'paper_evidence'; ref: EvidenceRef }
  | { kind: 'artifact'; ref: ArtifactRef };

export function validateCycleInputRef(raw: unknown, label = 'inputRef'): CycleInputRef {
  const o = keys(raw, ['kind', 'ref'], label);
  const kind = reqEnum(o.kind, ['paper_evidence', 'artifact'] as const, `${label}.kind`);
  if (kind === 'paper_evidence') {
    return { kind, ref: validateEvidenceRef(o.ref, `${label}.ref`) };
  }
  return { kind, ref: expAssertArtifactRef(o.ref, `${label}.ref`) };
}

export function validateCycleInputRefs(raw: unknown, label: string): CycleInputRef[] {
  return reqArray(raw, label, CYCLE_BOUNDS.maxInputRefsPerStep).map((entry, index) => validateCycleInputRef(entry, `${label}[${index}]`));
}

/** Two input refs are the same when their origin and identity match. */
export function sameCycleInputRef(a: CycleInputRef, b: CycleInputRef): boolean {
  return canonicalJsonV1(a) === canonicalJsonV1(b);
}

// ----------------- The four artifact payloads -----------------

export interface CycleProposalPayload {
  schemaVersion: 1;
  kind: 'proposal';
  /** The selected Phase1 idea this proposal builds on; null only for round inputs without an idea. */
  ideaRef: IdeaRef | null;
  hypothesis: string;
  motivation: string;
  baseline: string;
  variable: string;
  /** Expected outcome — a prediction, never an observed result. */
  expectedResult: string;
  sourceRefs: CycleInputRef[];
  notes: string | null;
}

export function validateProposalPayload(raw: unknown, label = 'proposal'): CycleProposalPayload {
  const o = keys(raw, ['schemaVersion', 'kind', 'ideaRef', 'hypothesis', 'motivation', 'baseline', 'variable', 'expectedResult', 'sourceRefs', 'notes'], label);
  if (o.schemaVersion !== CYCLE_SCHEMA_VERSION || o.kind !== 'proposal') {
    fail('SCHEMA_VIOLATION', `${label}: expected a schemaVersion-1 proposal payload`);
  }
  return {
    schemaVersion: 1,
    kind: 'proposal',
    ideaRef: o.ideaRef === null || o.ideaRef === undefined ? null : validateIdeaRefInput(o.ideaRef, `${label}.ideaRef`),
    hypothesis: reqText(o.hypothesis, `${label}.hypothesis`, CYCLE_BOUNDS.textLong),
    motivation: reqText(o.motivation, `${label}.motivation`, CYCLE_BOUNDS.textLong),
    baseline: reqText(o.baseline, `${label}.baseline`, CYCLE_BOUNDS.textMedium),
    variable: reqText(o.variable, `${label}.variable`, CYCLE_BOUNDS.textMedium),
    expectedResult: reqText(o.expectedResult, `${label}.expectedResult`, CYCLE_BOUNDS.textLong),
    sourceRefs: validateCycleInputRefs(o.sourceRefs, `${label}.sourceRefs`),
    notes: optText(o.notes, `${label}.notes`, CYCLE_BOUNDS.textLong),
  };
}

function validateIdeaRefInput(raw: unknown, label: string): IdeaRef {
  const o = keys(raw, ['ideaId', 'contentRevision', 'contentHash'], label);
  return {
    ideaId: reqId(o.ideaId, `${label}.ideaId`),
    contentRevision: reqInt(o.contentRevision, `${label}.contentRevision`, 1),
    contentHash: reqHex64(o.contentHash, `${label}.contentHash`),
  };
}

export interface CycleExperimentPlanPayload {
  schemaVersion: 1;
  kind: 'experiment_plan';
  proposalRef: ArtifactRef;
  baseline: string;
  change: string;
  fixedConditions: string[];
  dataset: string;
  metrics: string[];
  ablations: string[];
  completionCriteria: string;
  openQuestions: string[];
}

export function validateExperimentPlanPayload(raw: unknown, label = 'experiment_plan'): CycleExperimentPlanPayload {
  const o = keys(raw, ['schemaVersion', 'kind', 'proposalRef', 'baseline', 'change', 'fixedConditions', 'dataset', 'metrics', 'ablations', 'completionCriteria', 'openQuestions'], label);
  if (o.schemaVersion !== CYCLE_SCHEMA_VERSION || o.kind !== 'experiment_plan') {
    fail('SCHEMA_VIOLATION', `${label}: expected a schemaVersion-1 experiment_plan payload`);
  }
  return {
    schemaVersion: 1,
    kind: 'experiment_plan',
    proposalRef: expAssertArtifactRef(o.proposalRef, `${label}.proposalRef`),
    baseline: reqText(o.baseline, `${label}.baseline`, CYCLE_BOUNDS.textMedium),
    change: reqText(o.change, `${label}.change`, CYCLE_BOUNDS.textLong),
    fixedConditions: textList(o.fixedConditions, `${label}.fixedConditions`, CYCLE_BOUNDS.maxInputRefsPerStep, 10, CYCLE_BOUNDS.textMedium),
    dataset: reqText(o.dataset, `${label}.dataset`, CYCLE_BOUNDS.textMedium),
    metrics: textList(o.metrics, `${label}.metrics`, 10, 10, CYCLE_BOUNDS.textShort),
    ablations: textList(o.ablations, `${label}.ablations`, 10, 10, CYCLE_BOUNDS.textMedium),
    completionCriteria: reqText(o.completionCriteria, `${label}.completionCriteria`, CYCLE_BOUNDS.textLong),
    openQuestions: textList(o.openQuestions, `${label}.openQuestions`, 10, 10, CYCLE_BOUNDS.textMedium),
  };
}

export interface CycleEvidenceFinding {
  claim: string;
  support: string;
  sourceNature: FindingSourceNature;
  sourceRefs: CycleInputRef[];
}

export interface CycleEvidenceReportPayload {
  schemaVersion: 1;
  kind: 'evidence_report';
  proposalRef: ArtifactRef;
  planRef: ArtifactRef;
  findings: CycleEvidenceFinding[];
  gaps: string[];
  summary: string;
}

export function validateEvidenceReportPayload(raw: unknown, label = 'evidence_report'): CycleEvidenceReportPayload {
  const o = keys(raw, ['schemaVersion', 'kind', 'proposalRef', 'planRef', 'findings', 'gaps', 'summary'], label);
  if (o.schemaVersion !== CYCLE_SCHEMA_VERSION || o.kind !== 'evidence_report') {
    fail('SCHEMA_VIOLATION', `${label}: expected a schemaVersion-1 evidence_report payload`);
  }
  return {
    schemaVersion: 1,
    kind: 'evidence_report',
    proposalRef: expAssertArtifactRef(o.proposalRef, `${label}.proposalRef`),
    planRef: expAssertArtifactRef(o.planRef, `${label}.planRef`),
    findings: reqArray(o.findings, `${label}.findings`, CYCLE_BOUNDS.maxFindingsPerReport).map((entry, index) => {
      const f = keys(entry, ['claim', 'support', 'sourceNature', 'sourceRefs'], `${label}.findings[${index}]`);
      return {
        claim: reqText(f.claim, `${label}.findings[${index}].claim`, CYCLE_BOUNDS.textLong),
        support: reqText(f.support, `${label}.findings[${index}].support`, CYCLE_BOUNDS.textLong),
        sourceNature: reqEnum(f.sourceNature, FINDING_SOURCE_NATURES, `${label}.findings[${index}].sourceNature`),
        sourceRefs: validateCycleInputRefs(f.sourceRefs, `${label}.findings[${index}].sourceRefs`),
      };
    }),
    gaps: textList(o.gaps, `${label}.gaps`, 10, 10, CYCLE_BOUNDS.textLong),
    summary: reqText(o.summary, `${label}.summary`, CYCLE_BOUNDS.textLong),
  };
}

export interface CycleNextAction {
  actionId: string;
  kind: NextActionKind;
  title: string;
  detail: string;
}

export interface CycleGraphPatch {
  addNodes: CyclePatchNode[];
  addEdges: CyclePatchEdge[];
  branchDecisions: Array<{ targetNodeId: string; decision: ResearchDecision; reason: string }>;
}

export interface CycleDecisionPayload {
  schemaVersion: 1;
  kind: 'decision';
  proposalRef: ArtifactRef;
  planRef: ArtifactRef;
  evidenceRef: ArtifactRef;
  decision: ResearchDecision;
  reason: string;
  nextActions: CycleNextAction[];
  graphPatch: CycleGraphPatch;
}

export function validateDecisionPayload(raw: unknown, label = 'decision'): CycleDecisionPayload {
  const o = keys(raw, ['schemaVersion', 'kind', 'proposalRef', 'planRef', 'evidenceRef', 'decision', 'reason', 'nextActions', 'graphPatch'], label);
  if (o.schemaVersion !== CYCLE_SCHEMA_VERSION || o.kind !== 'decision') {
    fail('SCHEMA_VIOLATION', `${label}: expected a schemaVersion-1 decision payload`);
  }
  return {
    schemaVersion: 1,
    kind: 'decision',
    proposalRef: expAssertArtifactRef(o.proposalRef, `${label}.proposalRef`),
    planRef: expAssertArtifactRef(o.planRef, `${label}.planRef`),
    evidenceRef: expAssertArtifactRef(o.evidenceRef, `${label}.evidenceRef`),
    decision: reqEnum(o.decision, RESEARCH_DECISIONS, `${label}.decision`),
    reason: reqText(o.reason, `${label}.reason`, CYCLE_BOUNDS.textLong),
    nextActions: reqArray(o.nextActions, `${label}.nextActions`, CYCLE_BOUNDS.maxNextActionsPerDecision).map((entry, index) => {
      const a = keys(entry, ['actionId', 'kind', 'title', 'detail'], `${label}.nextActions[${index}]`);
      return {
        actionId: reqId(a.actionId, `${label}.nextActions[${index}].actionId`),
        kind: reqEnum(a.kind, NEXT_ACTION_KINDS, `${label}.nextActions[${index}].kind`),
        title: reqText(a.title, `${label}.nextActions[${index}].title`, CYCLE_BOUNDS.textShort),
        detail: reqText(a.detail, `${label}.nextActions[${index}].detail`, CYCLE_BOUNDS.textLong),
      };
    }),
    graphPatch: validateGraphPatchShape(o.graphPatch, `${label}.graphPatch`),
  };
}

// ----------------- Graph patch (proposal; validated against the live graph at apply time) -----------------

export interface CyclePatchNode {
  nodeId: string;
  kind: CycleNodeKind;
  title: string;
  /** Base-graph or cycle node this node derives from; null for stand-alone nodes. */
  sourceNodeId: string | null;
  /** Deliverable artifact backing this node, when the kind has one. */
  artifactRef: ArtifactRef | null;
  note: string | null;
}

export interface CyclePatchEdge {
  edgeId: string;
  from: string;
  to: string;
  relation: CycleEdgeRelation;
}

/** Structural shape validation of a graph patch (shared by decision validation and the graph adapter). */
export function validateGraphPatchShape(raw: unknown, label: string): CycleGraphPatch {
  const o = keys(raw, ['addNodes', 'addEdges', 'branchDecisions'], label);
  return {
    addNodes: reqArray(o.addNodes, `${label}.addNodes`, 20).map((entry, index) => {
      const n = keys(entry, ['nodeId', 'kind', 'title', 'sourceNodeId', 'artifactRef', 'note'], `${label}.addNodes[${index}]`);
      return {
        nodeId: reqId(n.nodeId, `${label}.addNodes[${index}].nodeId`),
        kind: reqEnum(n.kind, CYCLE_NODE_KINDS, `${label}.addNodes[${index}].kind`),
        title: reqText(n.title, `${label}.addNodes[${index}].title`, CYCLE_BOUNDS.textShort),
        sourceNodeId: n.sourceNodeId === null || n.sourceNodeId === undefined ? null : reqId(n.sourceNodeId, `${label}.addNodes[${index}].sourceNodeId`),
        artifactRef: n.artifactRef === null || n.artifactRef === undefined ? null : expAssertArtifactRef(n.artifactRef, `${label}.addNodes[${index}].artifactRef`),
        note: optText(n.note, `${label}.addNodes[${index}].note`, CYCLE_BOUNDS.textLong),
      };
    }),
    addEdges: reqArray(o.addEdges, `${label}.addEdges`, 40).map((entry, index) => {
      const e = keys(entry, ['edgeId', 'from', 'to', 'relation'], `${label}.addEdges[${index}]`);
      return {
        edgeId: reqId(e.edgeId, `${label}.addEdges[${index}].edgeId`),
        from: reqId(e.from, `${label}.addEdges[${index}].from`),
        to: reqId(e.to, `${label}.addEdges[${index}].to`),
        relation: reqEnum(e.relation, CYCLE_EDGE_RELATIONS, `${label}.addEdges[${index}].relation`),
      };
    }),
    branchDecisions: reqArray(o.branchDecisions, `${label}.branchDecisions`, CYCLE_BOUNDS.maxBranchDecisionsPerPatch).map((entry, index) => {
      const b = keys(entry, ['targetNodeId', 'decision', 'reason'], `${label}.branchDecisions[${index}]`);
      return {
        targetNodeId: reqId(b.targetNodeId, `${label}.branchDecisions[${index}].targetNodeId`),
        decision: reqEnum(b.decision, RESEARCH_DECISIONS, `${label}.branchDecisions[${index}].decision`),
        reason: reqText(b.reason, `${label}.branchDecisions[${index}].reason`, CYCLE_BOUNDS.textLong),
      };
    }),
  };
}

// ----------------- Persisted records -----------------

/** Registration record for one of the four deliverable kinds. */
export interface CycleArtifactRecord {
  artifactId: string;
  kind: CycleArtifactKind;
  researchId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  /** Member identity written by the trusted boundary; never a payload field. */
  producer: string;
  ref: ArtifactRef;
  inputRefs: CycleInputRef[];
  createdAt: string;
}

function validateArtifactRecord(raw: unknown, label: string): CycleArtifactRecord {
  const o = keys(raw, ['artifactId', 'kind', 'researchId', 'runId', 'stepId', 'attemptId', 'producer', 'ref', 'inputRefs', 'createdAt'], label);
  return {
    artifactId: reqId(o.artifactId, `${label}.artifactId`),
    kind: reqEnum(o.kind, CYCLE_ARTIFACT_KINDS, `${label}.kind`),
    researchId: reqId(o.researchId, `${label}.researchId`),
    runId: reqId(o.runId, `${label}.runId`),
    stepId: reqId(o.stepId, `${label}.stepId`),
    attemptId: reqId(o.attemptId, `${label}.attemptId`),
    producer: reqText(o.producer, `${label}.producer`, CYCLE_BOUNDS.textShort),
    ref: expAssertArtifactRef(o.ref, `${label}.ref`),
    inputRefs: validateCycleInputRefs(o.inputRefs, `${label}.inputRefs`),
    createdAt: reqIso(o.createdAt, `${label}.createdAt`),
  };
}

export interface CycleRun {
  /** External clients submit artifacts; no native Team execution or independent review is implied. */
  externalHandoff?: { reviewMode: 'self_review'; preparedBy: string; preparedAt: string; contractRevision: number };
  coordinationRevision?: number;
  stopHistory?: { status: string; error: { code: string; message: string } | null; reason: string | null; recordedAt: string }[];
  mode?: 'general';
  generalInputRefs?: ArtifactRef[];
  executionPolicy?: { maxAttempts: number; maxRounds?: number; deadline: string | null };
  concurrencyPolicy?: { maxActiveRuns: 2; authorizedBy: string };
  chain?: { rootRunId: string; parentRunId: string | null; renewedFrom?: { runId: string; reason: string; authorizedBy: string } };
  runId: string;
  researchId: string;
  /** The research task this loop belongs to, when the host bound one; null for ad-hoc runs. */
  taskId: string | null;
  /** Immutable snapshot of the Phase1 planning graph this run started from. */
  baseGraphRef: ArtifactRef;
  /** Bootstrap state revision when the base graph snapshot was taken. */
  bootstrapRevision: number;
  status: CycleStatus;
  round: number;
  stepIds: string[];
  decisionRefs: ArtifactRef[];
  /** The single selected idea this round works on (Phase2 first version: one idea per run). */
  selectedIdeaRef: IdeaRef | null;
  /** Base-graph node the round targets (the hypothesis node of the selected idea). */
  nodeId: string | null;
  stopReason: string | null;
  error: { code: string; message: string } | null;
  startedBy: string;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

function validateRun(raw: unknown, label: string): CycleRun {
  const o = keys(raw, ['runId', 'researchId', 'taskId', 'baseGraphRef', 'bootstrapRevision', 'status', 'round', 'stepIds', 'decisionRefs',
    'selectedIdeaRef', 'nodeId', 'stopReason', 'error', 'startedBy', 'startedAt', 'updatedAt', 'finishedAt', 'mode', 'generalInputRefs', 'executionPolicy', 'concurrencyPolicy', 'chain', 'stopHistory', 'coordinationRevision', 'externalHandoff'], label);
  let error: CycleRun['error'] = null;
  if (o.mode === undefined && o.generalInputRefs !== undefined) throw new CycleError('SCHEMA_VIOLATION', 'Generic input refs require an explicit research mode');
  let executionPolicy: CycleRun['executionPolicy'];
  if (o.executionPolicy !== undefined) {
    if (o.mode !== 'general') throw new CycleError('SCHEMA_VIOLATION', 'Execution policy requires generic research mode');
    const p = keys(o.executionPolicy, ['maxAttempts', 'maxRounds', 'deadline'], 'execution policy');
    executionPolicy = { maxAttempts: reqInt(p.maxAttempts, 'maxAttempts', 1, 10), ...(p.maxRounds === undefined ? {} : { maxRounds: reqInt(p.maxRounds, 'maxRounds', 1, 10) }), deadline: p.deadline === null ? null : reqIso(p.deadline, 'deadline') };
  }
  if (o.error !== null && o.error !== undefined) {
    const e = keys(o.error, ['code', 'message'], `${label}.error`);
    error = { code: reqText(e.code, `${label}.error.code`, 100), message: reqText(e.message, `${label}.error.message`, CYCLE_BOUNDS.textMedium) };
  }
  return {
    ...(o.externalHandoff === undefined ? {} : { externalHandoff: (() => { const value = keys(o.externalHandoff, ['reviewMode', 'preparedBy', 'preparedAt', 'contractRevision'], 'external handoff'); if (value.preparedBy !== o.startedBy) fail('SCHEMA_VIOLATION', 'External handoff belongs to the run authorizer'); return { reviewMode: reqEnum(value.reviewMode, ['self_review'] as const, 'reviewMode'), preparedBy: reqText(value.preparedBy, 'preparedBy', CYCLE_BOUNDS.textShort), preparedAt: reqIso(value.preparedAt, 'preparedAt'), contractRevision: reqInt(value.contractRevision, 'contractRevision', 1) }; })() }),
    ...(o.coordinationRevision === undefined ? {} : { coordinationRevision: reqInt(o.coordinationRevision, 'coordinationRevision', 1) }),
    ...(o.concurrencyPolicy === undefined ? {} : { concurrencyPolicy: (() => { if (o.mode !== 'general') fail('SCHEMA_VIOLATION', 'Concurrency requires generic mode'); const p = keys(o.concurrencyPolicy, ['maxActiveRuns', 'authorizedBy'], 'concurrency policy'); if (p.maxActiveRuns !== 2 || p.authorizedBy !== o.startedBy) fail('SCHEMA_VIOLATION', 'Concurrency grant must be bounded and belong to starter'); return { maxActiveRuns: 2 as const, authorizedBy: reqText(p.authorizedBy, 'concurrency authorizer', 200) }; })() }),
    ...(o.stopHistory === undefined ? {} : { stopHistory: reqArray(o.stopHistory, 'stop history', 100).map(v => { const h = keys(v, ['status', 'error', 'reason', 'recordedAt'], 'past stop'), e = h.error === null ? null : keys(h.error, ['code', 'message'], 'past stop error'); return { status: reqEnum(h.status, CYCLE_RUN_STATUSES, 'stop status'), error: e === null ? null : { code: reqText(e.code, 'error code', 100), message: reqText(e.message, 'error message', CYCLE_BOUNDS.textMedium) }, reason: optText(h.reason, 'past stop reason', CYCLE_BOUNDS.textMedium), recordedAt: reqIso(h.recordedAt, 'stop recordedAt') }; }) }),
    ...(o.chain === undefined ? {} : { chain: (() => { if (o.mode !== 'general') fail('SCHEMA_VIOLATION', 'Chain metadata requires general mode'); const c = keys(o.chain, ['rootRunId', 'parentRunId', 'renewedFrom'], 'chain'); return { ...(c.renewedFrom === undefined ? {} : { renewedFrom: (() => { const r = keys(c.renewedFrom, ['runId', 'reason', 'authorizedBy'], 'chain renewal'); return { runId: reqId(r.runId, 'renewed runId'), reason: reqText(r.reason, 'renewal reason', 2000), authorizedBy: reqText(r.authorizedBy, 'renewal identity', 200) }; })() }), rootRunId: reqId(c.rootRunId, 'rootRunId'), parentRunId: c.parentRunId === null ? null : reqId(c.parentRunId, 'parentRunId') }; })() }),
    ...(executionPolicy === undefined ? {} : { executionPolicy }),
    ...(o.mode === undefined ? {} : { mode: reqEnum(o.mode, ['general'] as const, `${label}.mode`), generalInputRefs: reqArray(o.generalInputRefs, 'general inputs', 30).map(r => expAssertArtifactRef(r, 'general input')) }),
    runId: reqId(o.runId, `${label}.runId`),
    researchId: reqId(o.researchId, `${label}.researchId`),
    taskId: o.taskId === null || o.taskId === undefined ? null : reqId(o.taskId, `${label}.taskId`),
    baseGraphRef: expAssertArtifactRef(o.baseGraphRef, `${label}.baseGraphRef`),
    bootstrapRevision: reqInt(o.bootstrapRevision, `${label}.bootstrapRevision`, 0),
    status: reqEnum(o.status, CYCLE_RUN_STATUSES, `${label}.status`),
    round: reqInt(o.round, `${label}.round`, 1),
    stepIds: reqArray(o.stepIds, `${label}.stepIds`, CYCLE_BOUNDS.maxStepsPerRun).map((entry, index) => reqId(entry, `${label}.stepIds[${index}]`)),
    decisionRefs: reqArray(o.decisionRefs, `${label}.decisionRefs`, 10).map((entry, index) => expAssertArtifactRef(entry, `${label}.decisionRefs[${index}]`)),
    selectedIdeaRef: o.selectedIdeaRef === null || o.selectedIdeaRef === undefined ? null : validateIdeaRefInput(o.selectedIdeaRef, `${label}.selectedIdeaRef`),
    nodeId: o.nodeId === null || o.nodeId === undefined ? null : reqId(o.nodeId, `${label}.nodeId`),
    stopReason: optText(o.stopReason, `${label}.stopReason`, CYCLE_BOUNDS.textMedium),
    error,
    startedBy: reqText(o.startedBy, `${label}.startedBy`, CYCLE_BOUNDS.textShort),
    startedAt: reqIso(o.startedAt, `${label}.startedAt`),
    updatedAt: reqIso(o.updatedAt, `${label}.updatedAt`),
    finishedAt: o.finishedAt === null || o.finishedAt === undefined ? null : reqIso(o.finishedAt, `${label}.finishedAt`),
  };
}

export interface CycleStep {
  attemptHistory?: { attemptId: string; status: string; error: { code: string; message: string } | null; inputRefs: CycleInputRef[]; outputRefs: ArtifactRef[]; assignedMemberId: string | null; reason: string | null; recordedAt: string }[];
  stepId: string;
  runId: string;
  round: number;
  nodeId: string | null;
  role: CycleRole;
  /** Step ids (this or a previous round) that must be completed first. */
  dependsOn: string[];
  attemptId: string;
  assignedMemberId: string | null;
  nativeTask?: { teamId: string; taskId: string };
  retryCount?: number;
  handoffId: string | null;
  status: CycleStepStatus;
  inputRefs: CycleInputRef[];
  outputRefs: ArtifactRef[];
  error: { code: string; message: string } | null;
}

function validateStep(raw: unknown, label: string): CycleStep {
  const o = keys(raw, ['stepId', 'runId', 'round', 'nodeId', 'role', 'dependsOn', 'attemptId', 'assignedMemberId', 'handoffId',
    'status', 'inputRefs', 'outputRefs', 'error', 'nativeTask', 'retryCount', 'attemptHistory'], label);
  let error: CycleStep['error'] = null;
  if (o.error !== null && o.error !== undefined) {
    const e = keys(o.error, ['code', 'message'], `${label}.error`);
    error = { code: reqText(e.code, `${label}.error.code`, 100), message: reqText(e.message, `${label}.error.message`, CYCLE_BOUNDS.textMedium) };
  }
  return {
    ...(o.attemptHistory === undefined ? {} : { attemptHistory: reqArray(o.attemptHistory, 'attempt history', 9).map(v => { const h = keys(v, ['attemptId', 'status', 'error', 'inputRefs', 'outputRefs', 'assignedMemberId', 'reason', 'recordedAt'], 'past attempt'); const e = h.error === null ? null : keys(h.error, ['code', 'message'], 'past attempt error'); return { attemptId: reqId(h.attemptId, 'past attemptId'), status: reqEnum(h.status, CYCLE_STEP_STATUSES, 'past attempt status'), error: e === null ? null : { code: reqText(e.code, 'error code', 100), message: reqText(e.message, 'error message', CYCLE_BOUNDS.textMedium) }, inputRefs: validateCycleInputRefs(h.inputRefs, 'past inputs'), outputRefs: reqArray(h.outputRefs, 'past outputs', 10).map(r => expAssertArtifactRef(r, 'past output')), assignedMemberId: optText(h.assignedMemberId, 'past member', 200), reason: optText(h.reason, 'past reason', CYCLE_BOUNDS.textMedium), recordedAt: reqIso(h.recordedAt, 'recordedAt') }; }) }),
    stepId: reqId(o.stepId, `${label}.stepId`),
    runId: reqId(o.runId, `${label}.runId`),
    round: reqInt(o.round, `${label}.round`, 1),
    nodeId: o.nodeId === null || o.nodeId === undefined ? null : reqId(o.nodeId, `${label}.nodeId`),
    role: reqEnum(o.role, CYCLE_ROLES, `${label}.role`),
    dependsOn: reqArray(o.dependsOn, `${label}.dependsOn`, CYCLE_BOUNDS.maxStepsPerRun).map((entry, index) => reqId(entry, `${label}.dependsOn[${index}]`)),
    attemptId: reqId(o.attemptId, `${label}.attemptId`),
    ...(o.retryCount === undefined ? {} : { retryCount: reqInt(o.retryCount, `${label}.retryCount`, 0, 9) }),
    assignedMemberId: o.assignedMemberId === null || o.assignedMemberId === undefined ? null : reqText(o.assignedMemberId, `${label}.assignedMemberId`, CYCLE_BOUNDS.textShort),
    ...(o.nativeTask === undefined ? {} : { nativeTask: (() => {
      const task = keys(o.nativeTask, ['teamId', 'taskId'], `${label}.nativeTask`);
      return { teamId: reqText(task.teamId, `${label}.nativeTask.teamId`, 200), taskId: reqText(task.taskId, `${label}.nativeTask.taskId`, 200) };
    })() }),
    handoffId: o.handoffId === null || o.handoffId === undefined ? null : reqId(o.handoffId, `${label}.handoffId`),
    status: reqEnum(o.status, CYCLE_STEP_STATUSES, `${label}.status`),
    inputRefs: validateCycleInputRefs(o.inputRefs, `${label}.inputRefs`),
    outputRefs: reqArray(o.outputRefs, `${label}.outputRefs`, 10).map((entry, index) => expAssertArtifactRef(entry, `${label}.outputRefs[${index}]`)),
    error,
  };
}

/** Accepted graph increment node (applied decision content, immutable once written). */
export interface CycleGraphNode {
  nodeId: string;
  kind: CycleNodeKind;
  runId: string;
  round: number;
  title: string;
  sourceNodeId: string | null;
  artifactRef: ArtifactRef | null;
  note: string | null;
  addedAt: string;
}

function validateGraphNodeRecord(raw: unknown, label: string): CycleGraphNode {
  const o = keys(raw, ['nodeId', 'kind', 'runId', 'round', 'title', 'sourceNodeId', 'artifactRef', 'note', 'addedAt'], label);
  return {
    nodeId: reqId(o.nodeId, `${label}.nodeId`),
    kind: reqEnum(o.kind, CYCLE_NODE_KINDS, `${label}.kind`),
    runId: reqId(o.runId, `${label}.runId`),
    round: reqInt(o.round, `${label}.round`, 1),
    title: reqText(o.title, `${label}.title`, CYCLE_BOUNDS.textShort),
    sourceNodeId: o.sourceNodeId === null || o.sourceNodeId === undefined ? null : reqId(o.sourceNodeId, `${label}.sourceNodeId`),
    artifactRef: o.artifactRef === null || o.artifactRef === undefined ? null : expAssertArtifactRef(o.artifactRef, `${label}.artifactRef`),
    note: optText(o.note, `${label}.note`, CYCLE_BOUNDS.textLong),
    addedAt: reqIso(o.addedAt, `${label}.addedAt`),
  };
}

export interface CycleGraphEdge {
  edgeId: string;
  from: string;
  to: string;
  relation: CycleEdgeRelation;
}

function validateGraphEdgeRecord(raw: unknown, label: string): CycleGraphEdge {
  const o = keys(raw, ['edgeId', 'from', 'to', 'relation'], label);
  return {
    edgeId: reqId(o.edgeId, `${label}.edgeId`),
    from: reqId(o.from, `${label}.from`),
    to: reqId(o.to, `${label}.to`),
    relation: reqEnum(o.relation, CYCLE_EDGE_RELATIONS, `${label}.relation`),
  };
}

/** A kept decision about one branch, expressed as a marker; history is never deleted. */
export interface CycleBranchDecisionRecord {
  decisionId: string;
  runId: string;
  targetNodeId: string;
  decision: ResearchDecision;
  reason: string;
  decisionRef: ArtifactRef;
  at: string;
}

function validateBranchDecision(raw: unknown, label: string): CycleBranchDecisionRecord {
  const o = keys(raw, ['decisionId', 'runId', 'targetNodeId', 'decision', 'reason', 'decisionRef', 'at'], label);
  return {
    decisionId: reqId(o.decisionId, `${label}.decisionId`),
    runId: reqId(o.runId, `${label}.runId`),
    targetNodeId: reqId(o.targetNodeId, `${label}.targetNodeId`),
    decision: reqEnum(o.decision, RESEARCH_DECISIONS, `${label}.decision`),
    reason: reqText(o.reason, `${label}.reason`, CYCLE_BOUNDS.textLong),
    decisionRef: expAssertArtifactRef(o.decisionRef, `${label}.decisionRef`),
    at: reqIso(o.at, `${label}.at`),
  };
}

/** One applied decision: what was committed, exactly once per decision. */
export interface CycleAppliedDecision {
  decisionId: string;
  runId: string;
  decisionRef: ArtifactRef;
  appliedAt: string;
  nodeIds: string[];
  edgeIds: string[];
}

function validateAppliedDecision(raw: unknown, label: string): CycleAppliedDecision {
  const o = keys(raw, ['decisionId', 'runId', 'decisionRef', 'appliedAt', 'nodeIds', 'edgeIds'], label);
  return {
    decisionId: reqId(o.decisionId, `${label}.decisionId`),
    runId: reqId(o.runId, `${label}.runId`),
    decisionRef: expAssertArtifactRef(o.decisionRef, `${label}.decisionRef`),
    appliedAt: reqIso(o.appliedAt, `${label}.appliedAt`),
    nodeIds: reqArray(o.nodeIds, `${label}.nodeIds`, 20).map((entry, index) => reqId(entry, `${label}.nodeIds[${index}]`)),
    edgeIds: reqArray(o.edgeIds, `${label}.edgeIds`, 40).map((entry, index) => reqId(entry, `${label}.edgeIds[${index}]`)),
  };
}

// ----------------- The whole state -----------------

export interface CycleState {
  schedules: GeneralSchedule[];
  schemaVersion: 1;
  revision: number;
  researchId: string;
  runs: CycleRun[];
  steps: CycleStep[];
  artifacts: CycleArtifactRecord[];
  graphNodes: CycleGraphNode[];
  graphEdges: CycleGraphEdge[];
  branchDecisions: CycleBranchDecisionRecord[];
  appliedDecisions: CycleAppliedDecision[];
  receipts: OperationReceipt[];
}

export function validateCycleState(raw: unknown, label = 'cycleState'): CycleState {
  const o = keys(raw, ['schemaVersion', 'revision', 'researchId', 'runs', 'steps', 'artifacts', 'graphNodes', 'graphEdges',
    'branchDecisions', 'appliedDecisions', 'receipts', 'schedules'], label);
  if (o.schemaVersion !== CYCLE_SCHEMA_VERSION) {
    fail('STATE_CORRUPT', `${label}: unsupported schemaVersion ${JSON.stringify(o.schemaVersion)}`);
  }
  const state: CycleState = {
    schedules: reqArray(o.schedules ?? [], 'schedules', 100).map(validateGeneralSchedule),
    schemaVersion: 1,
    revision: reqInt(o.revision, `${label}.revision`, 0),
    researchId: reqId(o.researchId, `${label}.researchId`),
    runs: reqArray(o.runs, `${label}.runs`, CYCLE_BOUNDS.maxRunsPerResearch).map((entry, index) => validateRun(entry, `${label}.runs[${index}]`)),
    steps: reqArray(o.steps, `${label}.steps`, CYCLE_BOUNDS.maxRunsPerResearch * CYCLE_BOUNDS.maxStepsPerRun).map((entry, index) => validateStep(entry, `${label}.steps[${index}]`)),
    artifacts: reqArray(o.artifacts, `${label}.artifacts`, CYCLE_BOUNDS.maxArtifactsPerResearch).map((entry, index) => validateArtifactRecord(entry, `${label}.artifacts[${index}]`)),
    graphNodes: reqArray(o.graphNodes, `${label}.graphNodes`, CYCLE_BOUNDS.maxGraphNodesPerResearch).map((entry, index) => validateGraphNodeRecord(entry, `${label}.graphNodes[${index}]`)),
    graphEdges: reqArray(o.graphEdges, `${label}.graphEdges`, CYCLE_BOUNDS.maxGraphEdgesPerResearch).map((entry, index) => validateGraphEdgeRecord(entry, `${label}.graphEdges[${index}]`)),
    branchDecisions: reqArray(o.branchDecisions, `${label}.branchDecisions`, CYCLE_BOUNDS.maxGraphNodesPerResearch).map((entry, index) => validateBranchDecision(entry, `${label}.branchDecisions[${index}]`)),
    appliedDecisions: reqArray(o.appliedDecisions, `${label}.appliedDecisions`, CYCLE_BOUNDS.maxRunsPerResearch * 4).map((entry, index) => validateAppliedDecision(entry, `${label}.appliedDecisions[${index}]`)),
    receipts: reqArray(o.receipts, `${label}.receipts`, Number.MAX_SAFE_INTEGER).map((entry, index) => {
      const r = keys(entry, ['operationId', 'kind', 'researchId', 'requestHash', 'resultRevision', 'result', 'createdAt'], `${label}.receipts[${index}]`);
      return {
        operationId: reqText(r.operationId, `${label}.receipts[${index}].operationId`, 200),
        kind: reqText(r.kind, `${label}.receipts[${index}].kind`, 100),
        researchId: r.researchId === null || r.researchId === undefined ? null : reqText(r.researchId, `${label}.receipts[${index}].researchId`, 200),
        requestHash: reqHex64(r.requestHash, `${label}.receipts[${index}].requestHash`),
        resultRevision: reqInt(r.resultRevision, `${label}.receipts[${index}].resultRevision`, 1),
        result: isRecord(r.result) ? r.result : fail('SCHEMA_VIOLATION', `${label}.receipts[${index}].result must be an object`),
        createdAt: reqIso(r.createdAt, `${label}.receipts[${index}].createdAt`),
      } satisfies OperationReceipt;
    }),
  };
  // Cross-record integrity: identities are unique, steps belong to real runs.
  const runIds = new Set(state.runs.map((run) => run.runId));
  if (new Set(state.schedules.map(s => s.scheduleId)).size !== state.schedules.length || state.schedules.some(s => s.researchId !== state.researchId)) fail('STATE_CORRUPT', 'Invalid schedule ownership/identity');
  if (state.schedules.filter(s => s.status === 'running').length > 1) fail('STATE_CORRUPT', 'Only one live schedule per research');
  const scheduledRunIds = new Set<string>();
  for (const schedule of state.schedules) for (const task of schedule.tasks) if (task.runId) {
    const run = state.runs.find(r => r.runId === task.runId);
    if (!run || run.mode !== 'general' || run.nodeId !== task.nodeId || scheduledRunIds.has(task.runId) || task.status === 'completed' && run.status !== 'completed') fail('STATE_CORRUPT', 'Scheduled run binding/status mismatch');
    scheduledRunIds.add(task.runId);
  }
  const activeRuns = state.runs.filter(r => ['queued', 'running', 'waiting_result', 'cancelling'].includes(r.status));
  if (activeRuns.length > 1 && (activeRuns.length > 2 || activeRuns.some(r => !r.concurrencyPolicy || r.mode !== 'general') || new Set(activeRuns.map(r => r.nodeId)).size !== activeRuns.length)) fail('STATE_CORRUPT', 'Concurrent runs exceed or lack independent user grants');
  if (state.runs.some(run => run.researchId !== state.researchId)) fail('STATE_CORRUPT', 'Run belongs to a different research namespace');
  if (runIds.size !== state.runs.length) fail('STATE_CORRUPT', `${label}: duplicate runId`);
  const stepIds = new Set<string>();
  const chainRounds = new Set<string>();
  for (const run of state.runs) if (run.chain) {
    const root = state.runs.find(r => r.runId === run.chain!.rootRunId);
    if (run.chain.renewedFrom && (run.chain.rootRunId !== run.runId || run.chain.parentRunId !== null || run.chain.renewedFrom.authorizedBy !== run.startedBy || !state.runs.some(r => r.runId === run.chain!.renewedFrom!.runId && r.runId !== run.runId && r.mode === 'general' && r.status === 'completed'))) fail('STATE_CORRUPT', 'Renewed chain source or author is invalid');
    if (!root || root.chain?.rootRunId !== root.runId || root.chain.parentRunId !== null || root.round !== 1) fail('STATE_CORRUPT', 'Chain root is missing or invalid');
    if (root.executionPolicy?.maxRounds === undefined || run.executionPolicy?.maxRounds === undefined || run.executionPolicy.maxRounds > root.executionPolicy.maxRounds || run.executionPolicy.maxAttempts > root.executionPolicy.maxAttempts) fail('STATE_CORRUPT', 'Chain execution policy is missing or expands the root grant');
    if (root.executionPolicy.deadline !== null && (run.executionPolicy.deadline === null || Date.parse(run.executionPolicy.deadline) > Date.parse(root.executionPolicy.deadline))) fail('STATE_CORRUPT', 'Chain deadline expands the root grant');
    const key = `${root.runId}:${run.round}`; if (chainRounds.has(key)) fail('STATE_CORRUPT', 'Duplicate chain round'); chainRounds.add(key);
    if (run.runId === root.runId ? run.chain.parentRunId !== null : !state.runs.some(p => p.runId === run.chain!.parentRunId && p.chain?.rootRunId === root.runId && p.status === 'completed' && p.round < run.round)) fail('STATE_CORRUPT', 'Chain parent is missing, foreign, incomplete or cyclic');
    if (run.round > (root.executionPolicy?.maxRounds ?? 1)) fail('STATE_CORRUPT', 'Chain round exceeds frozen limit');
  }
  for (const root of state.runs.filter(r => r.chain?.rootRunId === r.runId)) { const length = state.runs.filter(r => r.chain?.rootRunId === root.runId).length; for (let round = 1; round <= length; round++) if (!chainRounds.has(`${root.runId}:${round}`)) fail('STATE_CORRUPT', 'Chain round reservations are missing or non-contiguous'); }
  for (const step of state.steps) {
    if (stepIds.has(step.stepId)) fail('STATE_CORRUPT', `${label}: duplicate stepId ${step.stepId}`);
    stepIds.add(step.stepId);
    if (step.attemptHistory && (new Set(step.attemptHistory.map(h => h.attemptId)).size !== step.attemptHistory.length || step.attemptHistory.some(h => h.attemptId === step.attemptId) || step.attemptHistory.length > (step.retryCount ?? 0))) fail('STATE_CORRUPT', 'Attempt history conflicts with the current attempt or retry count');
    if (!runIds.has(step.runId)) fail('STATE_CORRUPT', `${label}: step ${step.stepId} references a missing run`);
    if (step.round !== state.runs.find(r => r.runId === step.runId)!.round) fail('STATE_CORRUPT', 'Step round differs from its registered run');
    const policy = state.runs.find(r => r.runId === step.runId)!.executionPolicy;
    if (policy && (step.retryCount ?? 0) >= policy.maxAttempts) fail('STATE_CORRUPT', 'Step attempt count exceeds its frozen execution policy');
    if (!state.runs.find((run) => run.runId === step.runId)!.stepIds.includes(step.stepId)) {
      fail('STATE_CORRUPT', `${label}: step ${step.stepId} is not listed by its run`);
    }
    for (const dependency of step.dependsOn) {
      if (!stepIds.has(dependency)) fail('STATE_CORRUPT', `${label}: step ${step.stepId} depends on missing step ${dependency}`);
    }
  }
  for (const run of state.runs) if (new Set(run.stepIds).size !== run.stepIds.length || run.stepIds.some(id => !state.steps.some(s => s.stepId === id && s.runId === run.runId))) fail('STATE_CORRUPT', 'Run step identity is duplicate, missing or foreign');
  const artifactIds = new Set(state.artifacts.map((artifact) => artifact.artifactId));
  if (artifactIds.size !== state.artifacts.length) fail('STATE_CORRUPT', `${label}: duplicate artifactId`);
  for (const artifact of state.artifacts) {
    if (artifact.researchId !== state.researchId) fail('STATE_CORRUPT', 'Artifact belongs to a different research namespace');
    if (!runIds.has(artifact.runId)) fail('STATE_CORRUPT', `${label}: artifact ${artifact.artifactId} references a missing run`);
    if (!stepIds.has(artifact.stepId)) fail('STATE_CORRUPT', `${label}: artifact ${artifact.artifactId} references a missing step`);
    if (state.steps.find(s => s.stepId === artifact.stepId)!.runId !== artifact.runId) fail('STATE_CORRUPT', 'Artifact step belongs to a different run');
  }
  const nodeIds = new Set(state.graphNodes.map((node) => node.nodeId));
  if (nodeIds.size !== state.graphNodes.length) fail('STATE_CORRUPT', `${label}: duplicate graph node id`);
  const edgeIds = new Set(state.graphEdges.map((edge) => edge.edgeId));
  if (edgeIds.size !== state.graphEdges.length) fail('STATE_CORRUPT', `${label}: duplicate graph edge id`);
  for (const decision of state.appliedDecisions) {
    if (!runIds.has(decision.runId)) fail('STATE_CORRUPT', `${label}: applied decision references a missing run`);
  }
  return state;
}

export function emptyCycleState(researchId: string): CycleState {
  if (!isBootstrapId(researchId)) throw new CycleError('INVALID_INPUT', 'researchId must be a stable id');
  return {
    schemaVersion: CYCLE_SCHEMA_VERSION,
    revision: 0,
    researchId,
    schedules: [],
    runs: [],
    steps: [],
    artifacts: [],
    graphNodes: [],
    graphEdges: [],
    branchDecisions: [],
    appliedDecisions: [],
    receipts: [],
  };
}

/** Hash over the semantic request, mirroring bootstrap's idempotency engine. */
export function cycleRequestHash(payload: Record<string, unknown>): string {
  return cycleContentHash('research-cycle-request-v1', payload);
}

// ----------------- Actor -----------------

/**
 * Host-resolved trusted context. `kind` decides what the actor may do:
 * - `user`: start/cancel/query (native actions through the trusted bridge)
 * - `agent`: read assigned inputs, publish artifacts, submit step results
 * - `coordinator`: everything the loop coordination needs, including applying decisions
 */
export type CycleActorKind = 'user' | 'agent' | 'coordinator';
export interface CycleActor {
  identity: string;
  kind: CycleActorKind;
  actionId: string | null;
}

export function validateCycleActor(raw: unknown): CycleActor {
  const o = keys(raw, ['identity', 'kind', 'actionId'], 'actor');
  return {
    identity: reqText(o.identity, 'actor.identity', CYCLE_BOUNDS.textShort),
    kind: reqEnum(o.kind, ['user', 'agent', 'coordinator'] as const, 'actor.kind'),
    actionId: optText(o.actionId, 'actor.actionId', 200),
  };
}

// ----------------- Step execution seam -----------------

/**
 * The bounded input snapshot the coordinator publishes for one step: the role
 * instruction, the research summary, the selected idea content and the assigned
 * input refs. Published as an immutable artifact before the step runs.
 */
export interface CycleStepInputSnapshot {
  paperTask?: { nodeId: string; title: string; detail: string | null; parentRunId: string; decisionRef: ArtifactRef };
  general?: { idea: unknown; task?: unknown; domains: string[]; methods: string[]; reference: unknown; constraints: string[]; requireHumanConfirmation: boolean };
  schemaVersion: 1;
  runId: string;
  stepId: string;
  role: CycleRole;
  research: {
    researchId: string;
    title: string;
    goal: string | null;
    contractRevision: number;
    metrics: string[];
    baselineName: string | null;
    dataDescription: string | null;
  };
  selectedIdea: ResearchIdea | null;
  roundInputs: CycleInputRef[];
  instruction: string;
}

/**
 * What a role executor receives. `readInput` and `publish` are the ONLY service
 * capabilities an executor gets: reading assigned inputs and publishing this
 * step's deliverable. Everything else (submit, decisions, graph writes) stays
 * with the coordinator.
 */
export interface CycleStepExecution {
  step: CycleStep;
  run: CycleRun;
  snapshot: CycleStepInputSnapshot;
  snapshotRef: ArtifactRef;
  readInput(ref: CycleInputRef): unknown;
  publish(payload: Record<string, unknown>): ArtifactRef;
}
