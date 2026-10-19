/**
 * Phase 3 review-repair acceptance-evidence contracts (SPEC:
 * docs/mvp/PHASE3-ACCEPTANCE-EVIDENCE-SPEC.md).
 *
 * Scope discipline
 * ----------------
 * This file implements the SPEC's designed DTOs for the trusted acceptance
 * pipeline. It does NOT redefine any frozen research or workbench fact: the
 * types here are acceptance sidecars that DESCRIBE evidence produced by suites,
 * never the evidence itself.
 *
 * What this file enforces mechanically (SPEC §1.1):
 *  - a "pass" can only come from the full required assertion set with valid
 *    evidence — never from a suite's exit 0, a pass count, or a static
 *    `covered` field;
 *  - assertion ids match EXACTLY (no prefix / suffix guessing, SPEC §2.1);
 *  - every enum is validated strictly — an unknown status is a rejection, not
 *    a coercion (SPEC §4.1);
 *  - report identity (run/suite/attempt/manifestHash) is checked before any
 *    status is trusted (SPEC §3.1).
 */

import { createHash } from 'node:crypto';

import { assertEnum, assertHash64, assertId, assertIsoUtc, assertNoExtraKeys } from './research.ts';

// ----------------- vocabularies -----------------

export const CASE_STATUSES = ['pass', 'fail', 'blocked', 'not_run', 'partial'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const ACCEPTANCE_SCOPES = ['repair-engineering', 'workbench-research', 'phase3-mvp'] as const;
export type AcceptanceScope = (typeof ACCEPTANCE_SCOPES)[number];

export const EVIDENCE_LEVELS = [
  'unit',
  'component',
  'host_integration',
  'live_agent',
  'live_browser',
] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const SUITE_MODES = ['deterministic', 'live'] as const;
export type SuiteMode = (typeof SUITE_MODES)[number];

export const EXECUTION_DECLARATION_STATUSES = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'blocked',
] as const;
export type ExecutionDeclarationStatus = (typeof EXECUTION_DECLARATION_STATUSES)[number];

export const TERMINATIONS = [
  'normal_exit',
  'launch_error',
  'deadline',
  'user_cancel',
  'unexpected_termination',
] as const;
export type Termination = (typeof TERMINATIONS)[number];

export const CLEANUP_STATES = ['not_needed', 'completed', 'pending', 'failed'] as const;
export type CleanupState = (typeof CLEANUP_STATES)[number];

export const EVIDENCE_KINDS = [
  'host_event',
  'trajectory',
  'publication',
  'process_record',
  'raw_prediction',
  'verification',
  'dom_observation',
  'diagnostic',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const RECORDED_BY = ['host', 'browser_collector', 'independent_verifier'] as const;
export type RecordedBy = (typeof RECORDED_BY)[number];

export const REUSE_POLICIES = ['current_run_only', 'same_campaign_verified'] as const;
export type ReusePolicy = (typeof REUSE_POLICIES)[number];

export const REPORTS_SCHEMA_VERSION = 1 as const;

// ----------------- schema-level errors -----------------

export class AcceptanceContractError extends Error {
  readonly code: string;
  readonly fieldPaths: string[];

  constructor(code: string, message: string, fieldPaths: string[] = []) {
    super(`[${code}] ${message}`);
    this.name = 'AcceptanceContractError';
    this.code = code;
    this.fieldPaths = fieldPaths;
  }
}

function fail(code: string, message: string, fieldPaths: string[] = []): never {
  throw new AcceptanceContractError(code, message, fieldPaths);
}

function assertRequiredKeys(obj: Record<string, unknown>, required: readonly string[], context: string): void {
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) {
      fail('SCHEMA_VIOLATION', `missing required field ${context}.${key}`, [`${context}.${key}`]);
    }
  }
}

function assertBool(value: unknown, fieldPath: string): boolean {
  if (typeof value !== 'boolean') fail('SCHEMA_VIOLATION', `${fieldPath} must be a boolean`, [fieldPath]);
  return value;
}

function assertInt(value: unknown, fieldPath: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('SCHEMA_VIOLATION', `${fieldPath} must be an integer`, [fieldPath]);
  }
  return value;
}

function assertText(value: unknown, fieldPath: string, max: number): string {
  if (typeof value !== 'string') fail('SCHEMA_VIOLATION', `${fieldPath} must be a string`, [fieldPath]);
  if (value.length === 0) fail('SCHEMA_VIOLATION', `${fieldPath} must not be empty`, [fieldPath]);
  if (value.length > max) fail('SCHEMA_VIOLATION', `${fieldPath} exceeds ${max} chars`, [fieldPath]);
  return value;
}

// ----------------- shared refs -----------------

export interface ReportRef {
  id: string;
  sha256: string;
}

export function validateReportRef(raw: unknown, fieldPath: string): ReportRef {
  if (typeof raw !== 'object' || raw === null) fail('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ['id', 'sha256'], fieldPath);
  assertRequiredKeys(obj, ['id', 'sha256'], fieldPath);
  return {
    id: assertText(obj.id, `${fieldPath}.id`, 512),
    sha256: assertHash64(obj.sha256, `${fieldPath}.sha256`),
  };
}

// ----------------- manifest (SPEC §2) -----------------

export interface ManifestEntrypointRef {
  id: string;
  sha256: string;
}

export interface ManifestSuite {
  suiteId: string;
  producerVersion: string;
  entrypointRef: ManifestEntrypointRef;
  mode: SuiteMode;
  expectedAssertionIds: string[];
  reportsSchemaVersion: 1;
}

export interface ManifestAssertion {
  assertionId: string;
  producer: { suiteId: string; producerAssertionId: string };
  evidenceLevel: EvidenceLevel;
  expected: unknown;
  prerequisiteIds: string[];
  reusePolicy: ReusePolicy;
}

export interface ManifestCase {
  caseId: string;
  requirementRef: { id: string; sha256: string; section: string };
  scopes: AcceptanceScope[];
  assertionRefs: Array<{ assertionId: string; required: boolean }>;
}

export interface AcceptanceManifest {
  schemaVersion: 1;
  manifestId: string;
  /** SHA-256 over the normalized manifest content EXCLUDING this field. */
  manifestHash: string;
  scopes: AcceptanceScope[];
  suiteRegistry: ManifestSuite[];
  assertionRegistry: ManifestAssertion[];
  cases: ManifestCase[];
  executionPolicyRef: ManifestEntrypointRef;
  fixtureOrPilotRef: ManifestEntrypointRef;
}

const MANIFEST_SUITE_KEYS = [
  'suiteId',
  'producerVersion',
  'entrypointRef',
  'mode',
  'expectedAssertionIds',
  'reportsSchemaVersion',
];
const MANIFEST_ASSERTION_KEYS = [
  'assertionId',
  'producer',
  'evidenceLevel',
  'expected',
  'prerequisiteIds',
  'reusePolicy',
];
const MANIFEST_CASE_KEYS = ['caseId', 'requirementRef', 'scopes', 'assertionRefs'];

export function validateAcceptanceManifest(raw: unknown): AcceptanceManifest {
  if (typeof raw !== 'object' || raw === null) fail('SCHEMA_VIOLATION', 'manifest must be an object');
  const obj = raw as Record<string, unknown>;
  const manifestKeys = ['schemaVersion', 'manifestId', 'manifestHash', 'scopes', 'suiteRegistry', 'assertionRegistry', 'cases', 'executionPolicyRef', 'fixtureOrPilotRef'] as const;
  assertNoExtraKeys(obj, manifestKeys, 'manifest');
  assertRequiredKeys(obj, manifestKeys, 'manifest');
  if (obj.schemaVersion !== 1) fail('SCHEMA_VIOLATION', `manifest.schemaVersion must be 1, got ${JSON.stringify(obj.schemaVersion)}`, ['manifest.schemaVersion']);

  const manifestId = assertId(obj.manifestId, 'manifest.manifestId');
  const manifestHash = assertHash64(obj.manifestHash, 'manifest.manifestHash');
  const scopes = validateScopeList(obj.scopes, 'manifest.scopes');

  // ---- suite registry ----
  if (!Array.isArray(obj.suiteRegistry)) fail('SCHEMA_VIOLATION', 'manifest.suiteRegistry must be an array', ['manifest.suiteRegistry']);
  const suiteRegistry: ManifestSuite[] = obj.suiteRegistry.map((entry, i) => {
    const at = `manifest.suiteRegistry[${i}]`;
    if (typeof entry !== 'object' || entry === null) fail('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
    const s = entry as Record<string, unknown>;
    assertNoExtraKeys(s, MANIFEST_SUITE_KEYS, at);
    assertRequiredKeys(s, MANIFEST_SUITE_KEYS, at);
    const expectedIds = s.expectedAssertionIds;
    if (!Array.isArray(expectedIds)) fail('SCHEMA_VIOLATION', `${at}.expectedAssertionIds must be an array`, [`${at}.expectedAssertionIds`]);
    return {
      suiteId: assertId(s.suiteId, `${at}.suiteId`),
      producerVersion: assertText(s.producerVersion, `${at}.producerVersion`, 64),
      entrypointRef: validateEntrypointRef(s.entrypointRef, `${at}.entrypointRef`),
      mode: assertEnum(s.mode, SUITE_MODES, `${at}.mode`) as SuiteMode,
      expectedAssertionIds: expectedIds.map((id, j) => assertText(id, `${at}.expectedAssertionIds[${j}]`, 256)),
      reportsSchemaVersion: assertReportsSchemaVersion(s.reportsSchemaVersion, `${at}.reportsSchemaVersion`),
    };
  });
  const suiteIds = new Set<string>();
  for (const s of suiteRegistry) {
    if (suiteIds.has(s.suiteId)) fail('MANIFEST_INTEGRITY', `duplicate suiteId ${s.suiteId}`, ['manifest.suiteRegistry']);
    suiteIds.add(s.suiteId);
    const expectedUnique = new Set<string>();
    for (const producerId of s.expectedAssertionIds) {
      if (expectedUnique.has(producerId)) fail('MANIFEST_INTEGRITY', `suite ${s.suiteId} repeats expected assertion id ${producerId}`, ['manifest.suiteRegistry']);
      expectedUnique.add(producerId);
    }
  }

  // ---- assertion registry ----
  if (!Array.isArray(obj.assertionRegistry)) fail('SCHEMA_VIOLATION', 'manifest.assertionRegistry must be an array', ['manifest.assertionRegistry']);
  const assertionRegistry: ManifestAssertion[] = obj.assertionRegistry.map((entry, i) => {
    const at = `manifest.assertionRegistry[${i}]`;
    if (typeof entry !== 'object' || entry === null) fail('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
    const a = entry as Record<string, unknown>;
    assertNoExtraKeys(a, MANIFEST_ASSERTION_KEYS, at);
    assertRequiredKeys(a, MANIFEST_ASSERTION_KEYS, at);
    if (typeof a.producer !== 'object' || a.producer === null) fail('SCHEMA_VIOLATION', `${at}.producer must be an object`, [`${at}.producer`]);
    const producer = a.producer as Record<string, unknown>;
    assertNoExtraKeys(producer, ['suiteId', 'producerAssertionId'], `${at}.producer`);
    assertRequiredKeys(producer, ['suiteId', 'producerAssertionId'], `${at}.producer`);
    if (!Object.prototype.hasOwnProperty.call(a, 'expected')) fail('SCHEMA_VIOLATION', `${at}.expected is required`, [`${at}.expected`]);
    const prerequisites = a.prerequisiteIds;
    if (!Array.isArray(prerequisites)) fail('SCHEMA_VIOLATION', `${at}.prerequisiteIds must be an array`, [`${at}.prerequisiteIds`]);
    return {
      assertionId: assertText(a.assertionId, `${at}.assertionId`, 256),
      producer: {
        suiteId: assertId(producer.suiteId, `${at}.producer.suiteId`),
        producerAssertionId: assertText(producer.producerAssertionId, `${at}.producer.producerAssertionId`, 256),
      },
      evidenceLevel: assertEnum(a.evidenceLevel, EVIDENCE_LEVELS, `${at}.evidenceLevel`) as EvidenceLevel,
      expected: a.expected,
      prerequisiteIds: prerequisites.map((id, j) => assertText(id, `${at}.prerequisiteIds[${j}]`, 256)),
      reusePolicy: assertEnum(a.reusePolicy, REUSE_POLICIES, `${at}.reusePolicy`) as ReusePolicy,
    };
  });

  // Global uniqueness + exact producer mapping (SPEC §2.1).
  const assertionIds = new Set<string>();
  const producerKeys = new Map<string, string>(); // suiteId::producerAssertionId -> assertionId
  for (const a of assertionRegistry) {
    if (assertionIds.has(a.assertionId)) {
      fail('MANIFEST_INTEGRITY', `duplicate assertionId ${a.assertionId}`, ['manifest.assertionRegistry']);
    }
    assertionIds.add(a.assertionId);
    if (!suiteIds.has(a.producer.suiteId)) {
      fail('MANIFEST_INTEGRITY', `assertion ${a.assertionId} references unknown suiteId ${a.producer.suiteId}`, ['manifest.assertionRegistry']);
    }
    const key = `${a.producer.suiteId}::${a.producer.producerAssertionId}`;
    const existing = producerKeys.get(key);
    if (existing !== undefined) {
      fail('MANIFEST_INTEGRITY', `suiteId+producerAssertionId ${key} maps to both ${existing} and ${a.assertionId}; the mapping must be exact and unambiguous`, ['manifest.assertionRegistry']);
    }
    producerKeys.set(key, a.assertionId);
    const suite = suiteRegistry.find((candidate) => candidate.suiteId === a.producer.suiteId);
    if (!suite?.expectedAssertionIds.includes(a.producer.producerAssertionId)) {
      fail('MANIFEST_INTEGRITY', `assertion ${a.assertionId} maps producer id ${a.producer.producerAssertionId} that is not listed in suite ${a.producer.suiteId}.expectedAssertionIds`, ['manifest.assertionRegistry']);
    }
  }
  for (const a of assertionRegistry) {
    for (const prerequisiteId of a.prerequisiteIds) {
      if (!assertionIds.has(prerequisiteId)) fail('MANIFEST_INTEGRITY', `assertion ${a.assertionId} has unknown prerequisiteId ${prerequisiteId}`, ['manifest.assertionRegistry']);
      if (prerequisiteId === a.assertionId) fail('MANIFEST_INTEGRITY', `assertion ${a.assertionId} depends on itself`, ['manifest.assertionRegistry']);
    }
  }
  // Reject dependency cycles so prerequisite evaluation cannot depend on input order.
  const prerequisiteById = new Map(assertionRegistry.map((a) => [a.assertionId, a.prerequisiteIds]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visitPrerequisite = (id: string): void => {
    if (visiting.has(id)) fail('MANIFEST_INTEGRITY', `prerequisite cycle includes assertion ${id}`, ['manifest.assertionRegistry']);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of prerequisiteById.get(id) ?? []) visitPrerequisite(dep);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of assertionIds) visitPrerequisite(id);

  // ---- cases ----
  if (!Array.isArray(obj.cases)) fail('SCHEMA_VIOLATION', 'manifest.cases must be an array', ['manifest.cases']);
  const cases: ManifestCase[] = obj.cases.map((entry, i) => {
    const at = `manifest.cases[${i}]`;
    if (typeof entry !== 'object' || entry === null) fail('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
    const c = entry as Record<string, unknown>;
    assertNoExtraKeys(c, MANIFEST_CASE_KEYS, at);
    assertRequiredKeys(c, MANIFEST_CASE_KEYS, at);
    if (typeof c.requirementRef !== 'object' || c.requirementRef === null) {
      fail('SCHEMA_VIOLATION', `${at}.requirementRef must be an object`, [`${at}.requirementRef`]);
    }
    const req = c.requirementRef as Record<string, unknown>;
    assertNoExtraKeys(req, ['id', 'sha256', 'section'], `${at}.requirementRef`);
    assertRequiredKeys(req, ['id', 'sha256', 'section'], `${at}.requirementRef`);
    const caseScopes = validateScopeList(c.scopes, `${at}.scopes`);
    if (caseScopes.length === 0) fail('MANIFEST_INTEGRITY', `${at} lists no scope`, [`${at}.scopes`]);
    const refs = c.assertionRefs;
    if (!Array.isArray(refs)) fail('SCHEMA_VIOLATION', `${at}.assertionRefs must be an array`, [`${at}.assertionRefs`]);
    const seen = new Set<string>();
    const assertionRefs = refs.map((r, j) => {
      const rat = `${at}.assertionRefs[${j}]`;
      if (typeof r !== 'object' || r === null) fail('SCHEMA_VIOLATION', `${rat} must be an object`, [rat]);
      const ro = r as Record<string, unknown>;
      assertNoExtraKeys(ro, ['assertionId', 'required'], rat);
      assertRequiredKeys(ro, ['assertionId', 'required'], rat);
      const assertionId = assertText(ro.assertionId, `${rat}.assertionId`, 256);
      if (seen.has(assertionId)) {
        fail('MANIFEST_INTEGRITY', `case ${String(c.caseId)} repeats assertionId ${assertionId}; a case may not reference the same assertion twice`, [rat]);
      }
      seen.add(assertionId);
      if (!assertionIds.has(assertionId)) {
        fail('MANIFEST_INTEGRITY', `case ${String(c.caseId)} references unknown assertionId ${assertionId}; dangling refs are a manifest error, not a vacuous pass`, [rat]);
      }
      return { assertionId, required: assertBool(ro.required, `${rat}.required`) };
    });
    if (caseScopes.some((s) => !scopes.includes(s))) {
      fail('MANIFEST_INTEGRITY', `case ${String(c.caseId)} has a scope not selected by the manifest`, [`${at}.scopes`]);
    }
    return {
      caseId: assertText(c.caseId, `${at}.caseId`, 128),
      requirementRef: {
        id: assertText(req.id, `${at}.requirementRef.id`, 256),
        sha256: assertHash64(req.sha256, `${at}.requirementRef.sha256`),
        section: assertText(req.section, `${at}.requirementRef.section`, 256),
      },
      scopes: caseScopes,
      assertionRefs,
    };
  });

  const caseIds = new Set<string>();
  for (const c of cases) {
    if (caseIds.has(c.caseId)) fail('MANIFEST_INTEGRITY', `duplicate caseId ${c.caseId}`, ['manifest.cases']);
    caseIds.add(c.caseId);
    if (!c.assertionRefs.some((ref) => ref.required)) {
      fail('MANIFEST_INTEGRITY', `case ${c.caseId} has no required assertionRefs; a required case cannot pass vacuously`, [`manifest.cases.${c.caseId}.assertionRefs`]);
    }
  }
  for (const scope of scopes) {
    if (!cases.some((c) => c.scopes.includes(scope))) {
      fail('MANIFEST_INTEGRITY', `selected scope ${scope} has no registered cases`, ['manifest.cases']);
    }
  }

  const executionPolicyRef = validateEntrypointRef(obj.executionPolicyRef, 'manifest.executionPolicyRef');
  const fixtureOrPilotRef = validateEntrypointRef(obj.fixtureOrPilotRef, 'manifest.fixtureOrPilotRef');
  const validated: AcceptanceManifest = {
    schemaVersion: 1,
    manifestId,
    manifestHash,
    scopes,
    suiteRegistry,
    assertionRegistry,
    cases,
    executionPolicyRef,
    fixtureOrPilotRef,
  };
  const computedHash = computeManifestHash(validated);
  if (computedHash !== manifestHash) {
    fail('MANIFEST_INTEGRITY', `manifestHash does not match normalized content (recorded ${manifestHash}, computed ${computedHash})`, ['manifest.manifestHash']);
  }
  return validated;
}

function validateEntrypointRef(raw: unknown, fieldPath: string): ManifestEntrypointRef {
  if (typeof raw !== 'object' || raw === null) fail('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ['id', 'sha256'], fieldPath);
  assertRequiredKeys(obj, ['id', 'sha256'], fieldPath);
  return {
    id: assertText(obj.id, `${fieldPath}.id`, 512),
    sha256: assertHash64(obj.sha256, `${fieldPath}.sha256`),
  };
}

function assertReportsSchemaVersion(value: unknown, fieldPath: string): 1 {
  if (value !== 1) fail('SCHEMA_VIOLATION', `${fieldPath} must be 1`, [fieldPath]);
  return 1;
}

function validateScopeList(raw: unknown, fieldPath: string): AcceptanceScope[] {
  if (!Array.isArray(raw)) fail('SCHEMA_VIOLATION', `${fieldPath} must be an array`, [fieldPath]);
  const scopes = raw.map((v, i) => assertEnum(v, ACCEPTANCE_SCOPES, `${fieldPath}[${i}]`) as AcceptanceScope);
  if (new Set(scopes).size !== scopes.length) fail('MANIFEST_INTEGRITY', `${fieldPath} contains duplicate scopes`, [fieldPath]);
  return scopes;
}

/**
 * SPEC §2.1: manifestHash is the SHA-256 of the normalized content EXCLUDING
 * the field itself. Normalization: UTF-8 JSON with recursively sorted object
 * keys, so two semantically equal manifests hash equal.
 */
export function computeManifestHash(manifest: Omit<AcceptanceManifest, 'manifestHash'> & { manifestHash?: string }): string {
  const copy = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
  delete copy.manifestHash;
  const canonical = sortedJsonStringify(copy);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Recursively sort object keys by Unicode code point; arrays keep order. */
export function sortedJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJsonStringify).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJsonStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// ----------------- suite report (SPEC §3.1) -----------------

export interface FirstFailure {
  code: string;
  message: string;
  diagnosticRef: ReportRef | null;
}

export interface AssertionResult {
  /** The PRODUCER's assertion id; mapped exactly through the manifest. */
  assertionId: string;
  status: CaseStatus;
  expected: unknown;
  actual: unknown;
  evidenceRefs: ReportRef[];
  firstFailure: FirstFailure | null;
  missingParts: string[];
  prerequisiteFailures: string[];
}

export interface SuiteReport {
  schemaVersion: 1;
  runId: string;
  attemptId: string;
  suiteId: string;
  producerVersion: string;
  manifestHash: string;
  inputSnapshotRef: ReportRef;
  deploymentRef: ReportRef | null;
  startedAt: string;
  finishedAt: string | null;
  assertions: AssertionResult[];
  evidenceLevel: EvidenceLevel;
  executionDeclaration: {
    status: ExecutionDeclarationStatus;
    declaredExitCode: number | null;
  };
}

const ASSERTION_RESULT_KEYS = [
  'assertionId',
  'status',
  'expected',
  'actual',
  'evidenceRefs',
  'firstFailure',
  'missingParts',
  'prerequisiteFailures',
];
const SUITE_REPORT_KEYS = [
  'schemaVersion',
  'runId',
  'attemptId',
  'suiteId',
  'producerVersion',
  'manifestHash',
  'inputSnapshotRef',
  'deploymentRef',
  'startedAt',
  'finishedAt',
  'assertions',
  'evidenceLevel',
  'executionDeclaration',
];

export function validateSuiteReport(raw: unknown): SuiteReport {
  if (typeof raw !== 'object' || raw === null) fail('SCHEMA_VIOLATION', 'suite report must be an object');
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, SUITE_REPORT_KEYS, 'suite');
  assertRequiredKeys(obj, SUITE_REPORT_KEYS, 'suite');
  if (obj.schemaVersion !== 1) fail('SCHEMA_VIOLATION', `suite.schemaVersion must be 1`, ['suite.schemaVersion']);

  const assertionsRaw = obj.assertions;
  if (!Array.isArray(assertionsRaw)) fail('SCHEMA_VIOLATION', 'suite.assertions must be an array', ['suite.assertions']);
  const assertions = assertionsRaw.map((entry, i): AssertionResult => {
    const at = `suite.assertions[${i}]`;
    if (typeof entry !== 'object' || entry === null) fail('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
    const a = entry as Record<string, unknown>;
    assertNoExtraKeys(a, ASSERTION_RESULT_KEYS, at);
    assertRequiredKeys(a, ASSERTION_RESULT_KEYS, at);
    if (!Object.prototype.hasOwnProperty.call(a, 'expected') || !Object.prototype.hasOwnProperty.call(a, 'actual')) {
      fail('SCHEMA_VIOLATION', `${at} must include expected and actual fields`, [at]);
    }
    const evidenceRefs = validateReportRefList(a.evidenceRefs, `${at}.evidenceRefs`);
    let firstFailure: FirstFailure | null = null;
    if (a.firstFailure !== null) {
      if (typeof a.firstFailure !== 'object') fail('SCHEMA_VIOLATION', `${at}.firstFailure must be an object or null`, [`${at}.firstFailure`]);
      const f = a.firstFailure as Record<string, unknown>;
      assertNoExtraKeys(f, ['code', 'message', 'diagnosticRef'], `${at}.firstFailure`);
      firstFailure = {
        code: assertText(f.code, `${at}.firstFailure.code`, 128),
        message: assertText(f.message, `${at}.firstFailure.message`, 2_000),
        diagnosticRef: f.diagnosticRef === null ? null : validateReportRef(f.diagnosticRef, `${at}.firstFailure.diagnosticRef`),
      };
    }
    const missingParts = a.missingParts;
    const prerequisiteFailures = a.prerequisiteFailures;
    if (!Array.isArray(missingParts)) fail('SCHEMA_VIOLATION', `${at}.missingParts must be an array`, [`${at}.missingParts`]);
    if (!Array.isArray(prerequisiteFailures)) fail('SCHEMA_VIOLATION', `${at}.prerequisiteFailures must be an array`, [`${at}.prerequisiteFailures`]);
    return {
      assertionId: assertText(a.assertionId, `${at}.assertionId`, 256),
      status: assertEnum(a.status, CASE_STATUSES, `${at}.status`) as CaseStatus,
      expected: a.expected,
      actual: a.actual,
      evidenceRefs,
      firstFailure,
      missingParts: missingParts.map((p, j) => assertText(p, `${at}.missingParts[${j}]`, 256)),
      prerequisiteFailures: prerequisiteFailures.map((p, j) => assertText(p, `${at}.prerequisiteFailures[${j}]`, 256)),
    };
  });

  const assertionIds = new Set<string>();
  for (const a of assertions) {
    if (assertionIds.has(a.assertionId)) {
      fail('REPORT_INTEGRITY', `duplicate assertionId ${a.assertionId} in suite report`, ['suite.assertions']);
    }
    assertionIds.add(a.assertionId);
  }

  // A pass without evidence refs is an evidence-integrity failure (SPEC §3.1).
  for (const a of assertions) {
    if (a.status === 'pass' && a.evidenceRefs.length === 0) {
      fail(
        'EVIDENCE_INTEGRITY',
        `assertion ${a.assertionId} is pass with zero evidenceRefs; text-only conclusions are rejected (SPEC §3.1)`,
        [`suite.assertions[${assertions.indexOf(a)}].evidenceRefs`],
      );
    }
  }

  if (typeof obj.executionDeclaration !== 'object' || obj.executionDeclaration === null) {
    fail('SCHEMA_VIOLATION', 'suite.executionDeclaration must be an object', ['suite.executionDeclaration']);
  }
  const decl = obj.executionDeclaration as Record<string, unknown>;
  assertNoExtraKeys(decl, ['status', 'declaredExitCode'], 'suite.executionDeclaration');
  const declaredExitCode = decl.declaredExitCode === null ? null : assertInt(decl.declaredExitCode, 'suite.executionDeclaration.declaredExitCode');

  return {
    schemaVersion: 1,
    runId: assertText(obj.runId, 'suite.runId', 128),
    attemptId: assertText(obj.attemptId, 'suite.attemptId', 128),
    suiteId: assertId(obj.suiteId, 'suite.suiteId'),
    producerVersion: assertText(obj.producerVersion, 'suite.producerVersion', 64),
    manifestHash: assertHash64(obj.manifestHash, 'suite.manifestHash'),
    inputSnapshotRef: validateReportRef(obj.inputSnapshotRef, 'suite.inputSnapshotRef'),
    deploymentRef: obj.deploymentRef === null ? null : validateReportRef(obj.deploymentRef, 'suite.deploymentRef'),
    startedAt: assertIsoUtc(obj.startedAt, 'suite.startedAt'),
    finishedAt: obj.finishedAt === null ? null : assertIsoUtc(obj.finishedAt, 'suite.finishedAt'),
    assertions,
    evidenceLevel: assertEnum(obj.evidenceLevel, EVIDENCE_LEVELS, 'suite.evidenceLevel') as EvidenceLevel,
    executionDeclaration: {
      status: assertEnum(decl.status, EXECUTION_DECLARATION_STATUSES, 'suite.executionDeclaration.status') as ExecutionDeclarationStatus,
      declaredExitCode,
    },
  };
}

function validateReportRefList(raw: unknown, fieldPath: string): ReportRef[] {
  if (!Array.isArray(raw)) fail('SCHEMA_VIOLATION', `${fieldPath} must be an array`, [fieldPath]);
  return raw.map((r, i) => validateReportRef(r, `${fieldPath}[${i}]`));
}

// ----------------- runner execution record (SPEC §3.1) -----------------

export interface RunnerExecutionRecord {
  schemaVersion: 1;
  runId: string;
  suiteId: string;
  attemptId: string;
  manifestHash: string;
  entrypointRef: ReportRef;
  launchSucceeded: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  observedExitCode: number | null;
  termination: Termination;
  deadlineOrCancelEventRef: ReportRef | null;
  launchErrorRef: ReportRef | null;
  reportRef: ReportRef | null;
  stdoutRef: ReportRef | null;
  stderrRef: ReportRef | null;
  cleanup: CleanupState;
}

const RUNNER_RECORD_KEYS = [
  'schemaVersion',
  'runId',
  'suiteId',
  'attemptId',
  'manifestHash',
  'entrypointRef',
  'launchSucceeded',
  'startedAt',
  'finishedAt',
  'observedExitCode',
  'termination',
  'deadlineOrCancelEventRef',
  'launchErrorRef',
  'reportRef',
  'stdoutRef',
  'stderrRef',
  'cleanup',
];

export function validateRunnerExecutionRecord(raw: unknown): RunnerExecutionRecord {
  if (typeof raw !== 'object' || raw === null) fail('SCHEMA_VIOLATION', 'runner record must be an object');
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, RUNNER_RECORD_KEYS, 'runner');
  assertRequiredKeys(obj, RUNNER_RECORD_KEYS, 'runner');
  if (obj.schemaVersion !== 1) fail('SCHEMA_VIOLATION', 'runner.schemaVersion must be 1', ['runner.schemaVersion']);
  const observedExitCode = obj.observedExitCode === null ? null : assertInt(obj.observedExitCode, 'runner.observedExitCode');
  const launchSucceeded = assertBool(obj.launchSucceeded, 'runner.launchSucceeded');
  const termination = assertEnum(obj.termination, TERMINATIONS, 'runner.termination') as Termination;
  const startedAt = obj.startedAt === null ? null : assertIsoUtc(obj.startedAt, 'runner.startedAt');
  const finishedAt = obj.finishedAt === null ? null : assertIsoUtc(obj.finishedAt, 'runner.finishedAt');
  const deadlineOrCancelEventRef = obj.deadlineOrCancelEventRef === null ? null : validateReportRef(obj.deadlineOrCancelEventRef, 'runner.deadlineOrCancelEventRef');
  const launchErrorRef = obj.launchErrorRef === null ? null : validateReportRef(obj.launchErrorRef, 'runner.launchErrorRef');
  const reportRef = obj.reportRef === null ? null : validateReportRef(obj.reportRef, 'runner.reportRef');
  if (!launchSucceeded) {
    if (termination !== 'launch_error' || launchErrorRef === null || startedAt !== null || finishedAt !== null || observedExitCode !== null) {
      fail('REPORT_INTEGRITY', 'launchSucceeded=false requires launch_error, launchErrorRef, null timestamps, and null observedExitCode', ['runner.launchSucceeded']);
    }
  }
  if (termination === 'launch_error' && launchSucceeded) fail('REPORT_INTEGRITY', 'termination=launch_error conflicts with launchSucceeded=true', ['runner.termination']);
  if (termination === 'normal_exit' && (!launchSucceeded || observedExitCode === null || startedAt === null || finishedAt === null)) {
    fail('REPORT_INTEGRITY', 'normal_exit requires a successful launch, observedExitCode, and both timestamps', ['runner.termination']);
  }
  if ((termination === 'deadline' || termination === 'user_cancel') && deadlineOrCancelEventRef === null) {
    fail('REPORT_INTEGRITY', `${termination} requires deadlineOrCancelEventRef`, ['runner.deadlineOrCancelEventRef']);
  }
  if (startedAt !== null && finishedAt !== null && Date.parse(finishedAt) < Date.parse(startedAt)) {
    fail('REPORT_INTEGRITY', 'runner.finishedAt precedes runner.startedAt', ['runner.finishedAt']);
  }
  if (reportRef !== null && !launchSucceeded) fail('REPORT_INTEGRITY', 'a suite that did not launch cannot have a reportRef', ['runner.reportRef']);
  return {
    schemaVersion: 1,
    runId: assertText(obj.runId, 'runner.runId', 128),
    suiteId: assertId(obj.suiteId, 'runner.suiteId'),
    attemptId: assertText(obj.attemptId, 'runner.attemptId', 128),
    manifestHash: assertHash64(obj.manifestHash, 'runner.manifestHash'),
    entrypointRef: validateReportRef(obj.entrypointRef, 'runner.entrypointRef'),
    launchSucceeded,
    startedAt,
    finishedAt,
    observedExitCode,
    termination,
    deadlineOrCancelEventRef,
    launchErrorRef,
    reportRef,
    stdoutRef: obj.stdoutRef === null ? null : validateReportRef(obj.stdoutRef, 'runner.stdoutRef'),
    stderrRef: obj.stderrRef === null ? null : validateReportRef(obj.stderrRef, 'runner.stderrRef'),
    cleanup: assertEnum(obj.cleanup, CLEANUP_STATES, 'runner.cleanup') as CleanupState,
  };
}

// ----------------- evidence envelope (SPEC §3.2) -----------------

export interface EvidenceEnvelope {
  schemaVersion: 1;
  runId: string;
  evidenceId: string;
  kind: EvidenceKind;
  subject: {
    sessionId: string | null;
    qualifiedTask: { store: string; taskId: string } | null;
    candidateKey: string | null;
    protocolRef: ReportRef | null;
    toolCallId: string | null;
    operationId: string | null;
    attemptId: string | null;
  };
  contentRef: ReportRef;
  recordedBy: RecordedBy;
  producedAt: string;
}

const ENVELOPE_KEYS = ['schemaVersion', 'runId', 'evidenceId', 'kind', 'subject', 'contentRef', 'recordedBy', 'producedAt'];

/** Registered stores for EvidenceEnvelope.subject.qualifiedTask.store (SPEC §3.2). */
export const REGISTERED_EVIDENCE_STORES = ['phase2', 'phase3', 'workbench'] as const;

export function validateEvidenceEnvelope(raw: unknown): EvidenceEnvelope {
  if (typeof raw !== 'object' || raw === null) fail('SCHEMA_VIOLATION', 'evidence envelope must be an object');
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ENVELOPE_KEYS, 'evidence');
  if (obj.schemaVersion !== 1) fail('SCHEMA_VIOLATION', 'evidence.schemaVersion must be 1', ['evidence.schemaVersion']);
  const subjectRaw = obj.subject;
  if (typeof subjectRaw !== 'object' || subjectRaw === null) fail('SCHEMA_VIOLATION', 'evidence.subject must be an object', ['evidence.subject']);
  const subject = subjectRaw as Record<string, unknown>;
  assertNoExtraKeys(subject, ['sessionId', 'qualifiedTask', 'candidateKey', 'protocolRef', 'toolCallId', 'operationId', 'attemptId'], 'evidence.subject');

  let qualifiedTask: { store: string; taskId: string } | null = null;
  if (subject.qualifiedTask !== null) {
    if (typeof subject.qualifiedTask !== 'object') fail('SCHEMA_VIOLATION', 'evidence.subject.qualifiedTask must be an object or null', ['evidence.subject.qualifiedTask']);
    const qt = subject.qualifiedTask as Record<string, unknown>;
    assertNoExtraKeys(qt, ['store', 'taskId'], 'evidence.subject.qualifiedTask');
    // The store string is narrowed to registered stores (SPEC §3.2): an
    // arbitrary path-like value must not open a read.
    const store = assertEnum(qt.store, REGISTERED_EVIDENCE_STORES, 'evidence.subject.qualifiedTask.store');
    qualifiedTask = { store, taskId: assertId(qt.taskId, 'evidence.subject.qualifiedTask.taskId') };
  }

  return {
    schemaVersion: 1,
    runId: assertText(obj.runId, 'evidence.runId', 128),
    evidenceId: assertId(obj.evidenceId, 'evidence.evidenceId'),
    kind: assertEnum(obj.kind, EVIDENCE_KINDS, 'evidence.kind') as EvidenceKind,
    subject: {
      sessionId: subject.sessionId === null ? null : assertText(subject.sessionId, 'evidence.subject.sessionId', 256),
      qualifiedTask,
      candidateKey: subject.candidateKey === null ? null : assertText(subject.candidateKey, 'evidence.subject.candidateKey', 256),
      protocolRef: subject.protocolRef === null ? null : validateReportRef(subject.protocolRef, 'evidence.subject.protocolRef'),
      toolCallId: subject.toolCallId === null ? null : assertText(subject.toolCallId, 'evidence.subject.toolCallId', 256),
      operationId: subject.operationId === null ? null : assertText(subject.operationId, 'evidence.subject.operationId', 256),
      attemptId: subject.attemptId === null ? null : assertText(subject.attemptId, 'evidence.subject.attemptId', 128),
    },
    contentRef: validateReportRef(obj.contentRef, 'evidence.contentRef'),
    recordedBy: assertEnum(obj.recordedBy, RECORDED_BY, 'evidence.recordedBy') as RecordedBy,
    producedAt: assertIsoUtc(obj.producedAt, 'evidence.producedAt'),
  };
}
