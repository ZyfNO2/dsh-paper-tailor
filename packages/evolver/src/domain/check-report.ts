/**
 * Phase 2 CheckReport assembly.
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md section 4, last paragraph:
 *
 *   "每个检查有 id、输入 fixture ref、期望/容差、执行器版本、required 和证据产物。
 *    无能力执行时 blocked；模型解释只提供机制差异建议，不能代替数值检查或真实运行。"
 *
 * A CheckReport is a frozen wire object (`CheckReport` in contracts/experiments.ts) that carries
 * only `{id, status, required, reason, evidenceRefs}` per check. The remaining required fields --
 * input fixture ref, expected/tolerance, executor version, evidence artifact -- are therefore
 * carried inside this module's own `CheckSpec`/`CheckOutcome` records and folded into the frozen
 * object as follows:
 *
 *   - input fixture ref, expected/tolerance, executor version  ->  the `reason` string, in a fixed
 *     `expected=... tolerance=... fixture=... executor=...` clause, so the frozen report remains
 *     self-describing and a reader can see what was demanded without a second lookup.
 *   - evidence artifact  ->  `evidenceRefs[]`, one ref per probe measurement that decided the check.
 *
 * The report hash is computed with the frozen `computeCheckReportHash`, and every report is passed
 * through `validateCheckReport` before it is returned, so a report can never claim a friendlier
 * status than its own checks.
 */

import {
  ExperimentError,
  aggregateCheckStatus,
  artifactRefFor,
  checkReportBody,
  computeCheckReportHash,
  validateCheckReport,
  type ArtifactRef,
  type CheckReport,
  type CheckResult,
  type CheckStatus,
  type MechanismKind,
} from '../contracts/experiments.ts';

export const CHECK_REPORT_SCHEMA_VERSION = 1;

/** The probe executor this report was produced by. Bound into every check reason. */
export const CHECK_EXECUTOR_VERSION = 'phase2-mechanism-checks-v1';

export interface CheckSpec {
  id: string;
  /** SPEC section 4 row this check implements, e.g. 'parameterized_feature'. */
  mechanismKind: MechanismKind;
  /** Human-readable statement of what is being measured. */
  title: string;
  /** The input fixture the measurement ran on (probe spec id + fixture path). */
  fixtureRef: string;
  /** What the number must be for the check to pass. */
  expected: string;
  /** The absolute/relative tolerance applied, or 'exact' when the rule is exact. */
  tolerance: string;
  /** A missing capability must become `blocked`; a check may not opt out of that rule. */
  required: true;
  /** Probe measurements this check depends on. */
  measurementRefs: string[];
}

/**
 * The verdict plus the evidence for one check.
 *
 * `status` is decided by the mechanism-check engine from probe numbers, never by a model and never
 * by the patch under test. `evidence` entries become real `ArtifactRef`s.
 */
export interface CheckOutcome {
  spec: CheckSpec;
  status: CheckStatus;
  /** Observed value, printed verbatim into the reason. */
  observed: string;
  /** Why this status, in the words of the rule that produced it. */
  rationale: string;
  /** Evidence artifacts. At least one is required for a check that is not `blocked`. */
  evidence: Array<{ id: string; content: string }>;
}

export interface CheckReportInput {
  subjectRef: ArtifactRef;
  profileRef: string;
  /**
   * The probe run this report was produced by. The frozen `CheckReport` has no field for it, so it
   * is folded into every check's evidence: a report that is not bound to one real run would be a
   * verdict without a measurement behind it.
   */
  probeRef: ArtifactRef;
  outcomes: CheckOutcome[];
}

/** Deterministic one-line encoding of a check's contract, used inside `reason`. */
export function describeCheck(spec: CheckSpec): string {
  return (
    `fixture=${spec.fixtureRef} expected=${spec.expected} tolerance=${spec.tolerance} ` +
    `executor=${CHECK_EXECUTOR_VERSION} measurement=${spec.measurementRefs.join('+')}`
  );
}

/** Full reason line: the contract, what was observed, and the rule that decided the status. */
export function formatReason(outcome: CheckOutcome): string {
  const { spec } = outcome;
  return `${spec.title} | observed: ${outcome.observed} | ${outcome.rationale} | ${describeCheck(spec)}`;
}

/**
 * A `blocked` check must say which capability was missing. `passed` and `failed` are decisions and
 * must carry at least one evidence artifact: an assertion with no artifact is exactly the
 * "empty operation" this stage exists to refuse.
 *
 * `probeRef` is appended to every check that is not `blocked`, so each verdict is traceable to the
 * one real probe run that produced its numbers.
 */
export function toCheckResult(outcome: CheckOutcome, probeRef: ArtifactRef): CheckResult {
  const { spec } = outcome;

  if (spec.required !== true) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `mechanism check "${spec.id}" must be declared required: aggregateCheckStatus ignores non-required checks by design`
    );
  }

  if (outcome.status === 'blocked') {
    if (outcome.rationale.trim().length === 0) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `blocked check "${spec.id}" must record the missing capability in its rationale`
      );
    }
  } else if (outcome.evidence.length === 0) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `check "${spec.id}" is "${outcome.status}" without an evidence artifact; a verdict with no evidence is refused`
    );
  }

  const evidenceRefs =
    outcome.status === 'blocked'
      ? []
      : [
          ...outcome.evidence.map((entry) => artifactRefFor(entry.id, entry.content)),
          artifactRefFor(`${spec.id}:probe-run`, probeRef.sha256),
        ];

  return {
    id: spec.id,
    status: outcome.status,
    required: true,
    reason: formatReason(outcome),
    evidenceRefs,
  };
}

/**
 * Builds and validates a frozen `CheckReport`. The aggregate status is derived by the frozen
 * `aggregateCheckStatus`, so the report cannot overstate its own result.
 */
export function buildCheckReport(input: CheckReportInput): CheckReport {
  if (input.outcomes.length === 0) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      'a CheckReport with no checks is refused: "no checks ran" is not a pass'
    );
  }
  const checks = input.outcomes.map((outcome) => toCheckResult(outcome, input.probeRef));
  const body = {
    schemaVersion: CHECK_REPORT_SCHEMA_VERSION,
    subjectRef: input.subjectRef,
    profileRef: input.profileRef,
    checks,
    status: aggregateCheckStatus(checks),
  };
  const report: CheckReport = { ...body, reportHash: computeCheckReportHash(body) } as CheckReport;

  // Re-hash through the frozen body function to be sure no field was smuggled in.
  const recomputed = computeCheckReportHash(checkReportBody(report));
  if (recomputed !== report.reportHash) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'CheckReport hash is not stable across a rebuild');
  }
  return validateCheckReport(report);
}

/** Compact, stable text for one check: the content that is hashed into its evidence ref. */
export function evidenceText(parts: Record<string, unknown>): string {
  return JSON.stringify(parts, Object.keys(parts).sort());
}

export interface CheckReportSummary {
  status: CheckStatus;
  total: number;
  passed: number;
  failed: number;
  blocked: number;
  failedIds: string[];
  blockedIds: string[];
}

export function summarizeCheckReport(report: CheckReport): CheckReportSummary {
  const count = (status: CheckStatus) => report.checks.filter((c) => c.status === status).length;
  return {
    status: report.status,
    total: report.checks.length,
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    failedIds: report.checks.filter((c) => c.status === 'failed').map((c) => c.id),
    blockedIds: report.checks.filter((c) => c.status === 'blocked').map((c) => c.id),
  };
}
