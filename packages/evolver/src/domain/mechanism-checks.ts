/**
 * Phase 2 mechanism check engine: "按机制检查，避免空操作".
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md section 4.
 *
 * The engine picks the REQUIRED check set from a module's `MechanismKind` -- never from a module
 * name, and never from a P6 `interventionAxis` label. Every check is decided by NUMBERS produced
 * by a real CPU run (`experiments/phase2-probe/mechanism_probe.py`). A model explanation may
 * suggest a mechanism difference; it can never substitute for a measurement.
 *
 * THREE RULES THIS FILE ENFORCES
 * ------------------------------
 * 1. A missing capability is `blocked`, never silently `passed`. If the probe could not measure
 *    something -- no job for the declared kind, a fixture that does not exist, a probe-level
 *    failure -- the affected checks come back `blocked` with the missing capability named.
 * 2. A measured non-finite value (NaN/Inf, which the probe reports as JSON `null`) is `failed`.
 *    "We measured it and it was not a number" is a defect in the code under test, not a gap in
 *    the host's capability.
 * 3. Check rules are HOST-owned. The probe specification is built here, from the trusted profile,
 *    and the patch under test can neither supply it nor modify the files that define it
 *    (`assertPatchCannotChangeCheckRules`).
 *
 * Every mechanism assertion is `required: true`, because the frozen `aggregateCheckStatus`
 * deliberately ignores non-required checks: a profile that declares no required check would
 * otherwise be a pass.
 *
 * SPEC SECTION 4 ROW -> RULE ID MAP
 * ---------------------------------
 *   parameterized_feature  parameterized.shape_dtype_device, .forward_participation, .finiteness,
 *                          .output_difference, .optimizer_covers_parameters, .gradients_finite,
 *                          .gradient_norm, .parameter_update
 *   parameter_free_operator parameter_free.reference_output_tolerance, .mask_is_read, .mask_boundary,
 *                          .input_output_equivalence, .gradient_finite, .parameter_count
 *   loss                   loss.term_added_to_total, .coefficient, .reduction_rule,
 *                          .gradient_wrt_logits, .gradient_wrt_parameters, .gradient_contribution,
 *                          .label_and_ignore_mask, .finite
 *   training_hook          hook.fires_at_declared_position, .seed_reproducible,
 *                          .batch_and_sample_coverage, .schedule_effective
 *   data_policy            data_policy.targets_constructed, .sample_coverage, .seed_reproducible
 *   combination            combination.members_pass_alone, .run_present, .order,
 *                          .duplicate_function, .shared_state, .extra_parameter_sources
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  ExperimentError,
  artifactRefFor,
  type ArtifactRef,
  type CheckReport,
  type CheckStatus,
  type MechanismKind,
  MECHANISM_KINDS,
} from '../contracts/experiments.ts';
import { typedHash } from './research-canonical.ts';
import {
  buildCheckReport,
  evidenceText,
  type CheckOutcome,
  type CheckSpec,
} from './check-report.ts';

export const MECHANISM_CHECK_PROFILE_DOMAIN = 'phase2-mechanism-check-profile';
export const MECHANISM_PROBE_EXECUTOR = 'phase2-probe-v1';
export const MECHANISM_PROBE_SCRIPT = 'experiments/phase2-probe/mechanism_probe.py';

// ---------------------------------------------------------------------------
// Tolerances: declared numbers with a dtype and a reason. No unexplained defaults.
// ---------------------------------------------------------------------------

export interface Tolerance {
  id: string;
  dtype: string;
  /** Passes when observed <= abs. */
  abs?: number;
  /** Passes when observed <= rel * referenceMagnitude. */
  rel?: number;
  /** Passes when observed >= min. */
  min?: number;
  rationale: string;
}

function tol(
  id: string,
  dtype: string,
  bounds: { abs?: number; rel?: number; min?: number },
  rationale: string
): Tolerance {
  return { id, dtype, ...bounds, rationale };
}

/**
 * The v1 tolerance table. Each entry is an absolute/relative bound for a stated dtype, per SPEC
 * section 3 ("toleranceRef 逐检查列绝对/相对容差和适用 dtype，不接受未说明的默认容差").
 *
 * `dtype: 'exact'` marks a rule that compares declared strings or counts exactly; it is not an
 * unstated default, it is the statement that no numeric band applies.
 */
export const MECHANISM_TOLERANCES_V1: readonly Tolerance[] = [
  tol('parameterized.shape_dtype_device', 'exact', {}, 'shape/dtype/device are exact contract fields, not measurements'),
  tol('parameterized.forward.participation', 'count', { min: 1 }, 'a module that is attached must run at least once per declared forward pass'),
  tol('parameterized.output.difference', 'float32', { min: 1e-6 }, 'a real transformation of a fixed input must move the output by more than float32 noise'),
  tol('parameterized.finiteness', 'exact', {}, 'NaN/Inf is a defect, not a tolerance question'),
  tol('parameterized.grad.norm', 'float32', { min: 1e-12 }, 'a trainable parameter with an all-zero gradient is not being trained'),
  tol('parameterized.optimizer.coverage', 'count', {}, 'optimizer coverage compares two measured counts exactly; there is no tolerance band'),
  tol('parameterized.param.update', 'float32', { min: 1e-7 }, 'a parameter that does not move over the declared steps was never optimized'),
  tol('parameter_free.reference.abs', 'float32', { abs: 1e-6 }, 'an equivalent replacement is expected to stay close to the reference output'),
  tol('parameter_free.reference.rel', 'float32', { rel: 1e-5 }, 'the relative bound scales the absolute bound with the reference magnitude'),
  tol('parameter_free.mask.zero', 'float32', { abs: 1e-6 }, 'where the mask declares a position invalid the operator must emit zero'),
  tol('parameter_free.mask.boundary', 'float32', { abs: 1e-5 }, 'the worst disagreement is allowed at a mask boundary, but only within this bound'),
  tol('parameter_free.mask.sensitivity', 'float32', { min: 1e-9 }, 'an operator that ignores its mask produces the same tensor with and without it'),
  tol('parameter_free.gradient', 'float32', { abs: 1e-6 }, 'gradient equivalence is checked only when the operator is used in training'),
  tol('parameter_free.finiteness', 'exact', {}, 'NaN/Inf in an equivalence gradient is a defect, not a tolerance question'),
  tol('parameter_free.parameter.count', 'count', {}, 'a parameter-free operator declares exactly zero parameters'),
  tol('loss.total.vs.ce', 'float32', { min: 1e-9 }, 'the total loss must differ from the bare cross-entropy, or the term was never added'),
  tol('loss.coefficient.abs', 'float32', { abs: 1e-5 }, 'the effective coefficient is recovered from (total - ce) / term, so it is a measured number'),
  tol('loss.coefficient.rel', 'float32', { rel: 1e-4 }, 'the relative bound covers float32 cancellation when the term is much smaller than ce'),
  tol('loss.gradient.contribution', 'float32', { min: 1e-9 }, 'the term must reach backward, not only the forward total'),
  tol('loss.gradient.logits', 'float32', { min: 1e-12 }, 'a term that does not touch the specified logits has no gradient to contribute'),
  tol('loss.reduction', 'exact', {}, 'mean vs sum is a declared rule, not a tolerance'),
  tol('loss.label.active.count', 'count', {}, 'ignore-mask semantics are exact: the number of active labels is declared'),
  tol('hook.fire.count', 'count', { min: 1 }, 'a hook whose branch the training path never enters has a fire count of zero'),
  tol('hook.position', 'exact', {}, 'the declared hook position is an exact string'),
  tol('hook.seed.reproducible', 'exact', {}, 'a declared seed must reproduce the same draw'),
  tol('hook.sample.coverage', 'count', {}, 'coverage compares the observed sample set against the declared steps exactly'),
  tol('hook.schedule.distinct', 'count', { min: 2 }, 'a schedule that is declared but never applied leaves one distinct value'),
  tol('data_policy.targets.constructed', 'count', { min: 1 }, 'a target that is never constructed cannot drive a training step'),
  tol('combination.order', 'exact', {}, 'the observed module order must equal the declared order'),
  tol('combination.member.alone', 'exact', {}, 'each member must have its own passing report; a per-module ready is not a combination result'),
  tol('combination.run', 'exact', {}, 'the combination must have a real run of its own; there is no tolerance for reusing per-module results'),
  tol('combination.function.ownership', 'exact', {}, 'function ownership is a declared mapping, compared exactly'),
  tol('combination.shared_state', 'exact', {}, 'shared state is a declared set, compared exactly'),
  tol('combination.parameter_sources', 'count', {}, 'parameter attribution compares an owner whitelist and its counts exactly'),
];

// ---------------------------------------------------------------------------
// Rule catalogue
// ---------------------------------------------------------------------------

export type ProbeJobKey = 'parameterized' | 'operator' | 'loss' | 'hook' | 'combination';

export interface DeclaredMechanism {
  moduleId: string;
  mechanismKind: MechanismKind;
  /** Which probe job measures this mechanism. */
  probeJob: Exclude<ProbeJobKey, 'combination'>;
  modulePath: string;
  className: string;
  /** Required for `parameter_free_operator`: the reference implementation to compare against. */
  referenceClassName?: string;
  referenceModulePath?: string;
  /** Declared input/output contract. */
  expectedShape: number[];
  expectedDtype: string;
  expectedDevice: string;
  /** Declared training steps the module must be updated within. */
  steps: number;
  /** loss: declared coefficient, reduction and ignore-mask semantics. */
  coefficient?: number;
  reduction?: 'mean' | 'sum';
  ignoreIndex?: number;
  ignoredPositions?: number[];
  numClasses?: number;
  inFeatures?: number;
  /** training_hook / data_policy: declared position, coverage and schedule. */
  hookPosition?: string;
  sampleCount?: number;
  batchSize?: number;
  scheduleDeclared?: boolean;
  targetsDeclared?: boolean;
  /**
   * Host-side probe overrides. This is how the HOST builds a negative fixture (bypass mode,
   * optimizer mode, ...). It is part of the host profile input, never of a submitted patch.
   */
  probeOverrides?: Partial<Record<Exclude<ProbeJobKey, 'combination'>, Record<string, unknown>>>;
}

export interface RuleContext {
  job: Record<string, unknown>;
  declared: DeclaredMechanism;
  tolerance: Tolerance;
  /** Resolves another declared tolerance by id, so a rule with two bounds stays declarative. */
  toleranceFor: (id: string) => Tolerance;
}

export interface RuleVerdict {
  status: CheckStatus;
  observed: string;
  rationale: string;
}

export interface MechanismRule {
  id: string;
  mechanismKind: MechanismKind;
  title: string;
  toleranceId: string;
  /** Probe measurement keys this rule reads. */
  measurementRefs: string[];
  evaluate: (ctx: RuleContext) => RuleVerdict;
}

// --- measurement accessors -------------------------------------------------

interface Measured {
  present: boolean;
  finite: boolean;
  value: number | null;
}

/**
 * Reads one probe measurement.
 *
 * The probe emits JSON `null` for a NaN/Inf measurement, so `present && !finite` means "measured,
 * and it was not a number" -> a defect -> `failed`. `!present` means the probe did not report the
 * measurement at all -> the capability is missing -> `blocked`.
 */
function measured(job: Record<string, unknown>, key: string): Measured {
  if (!(key in job)) return { present: false, finite: false, value: null };
  const raw = job[key];
  if (raw === null) return { present: true, finite: false, value: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { present: true, finite: false, value: null };
  return { present: true, finite: true, value: raw };
}

function flag(job: Record<string, unknown>, key: string): boolean | null {
  const raw = job[key];
  return typeof raw === 'boolean' ? raw : null;
}

function stringList(job: Record<string, unknown>, key: string): string[] | null {
  const raw = job[key];
  if (!Array.isArray(raw)) return null;
  return raw.every((v) => typeof v === 'string') ? (raw as string[]) : null;
}

function numberList(job: Record<string, unknown>, key: string): number[] | null {
  const raw = job[key];
  if (!Array.isArray(raw)) return null;
  return raw.every((v) => typeof v === 'number') ? (raw as number[]) : null;
}

function blocked(_ctx: RuleContext, key: string, what: string): RuleVerdict {
  return {
    status: 'blocked',
    observed: `${key}=<missing>`,
    rationale: `capability missing: the probe reported no "${key}" measurement, so ${what} could not be measured`,
  };
}

function nonFinite(_ctx: RuleContext, key: string, what: string): RuleVerdict {
  return {
    status: 'failed',
    observed: `${key}=null (non-finite)`,
    rationale: `the probe measured ${what} and the value was not finite (NaN/Inf)`,
  };
}

/** `observed <= abs` and, when a reference magnitude is supplied, `observed <= rel * magnitude`. */
function atMost(
  ctx: RuleContext,
  key: string,
  what: string,
  referenceMagnitude?: number
): RuleVerdict {
  const m = measured(ctx.job, key);
  if (!m.present) return blocked(ctx, key, what);
  if (!m.finite) return nonFinite(ctx, key, what);
  const value = m.value as number;
  const absBound = ctx.tolerance.abs;
  const relBound =
    ctx.tolerance.rel !== undefined && referenceMagnitude !== undefined
      ? ctx.tolerance.rel * referenceMagnitude
      : undefined;
  const bound = Math.max(absBound ?? 0, relBound ?? 0);
  const detail =
    `abs=${absBound ?? 'n/a'} rel=${ctx.tolerance.rel ?? 'n/a'} referenceMagnitude=${referenceMagnitude ?? 'n/a'} bound=${bound}`;
  if (value <= bound) {
    return { status: 'passed', observed: `${key}=${value}`, rationale: `${what} within tolerance (${detail})` };
  }
  return { status: 'failed', observed: `${key}=${value}`, rationale: `${what} exceeds tolerance (${detail})` };
}

/** `observed >= min`. */
function atLeast(ctx: RuleContext, key: string, what: string): RuleVerdict {
  const m = measured(ctx.job, key);
  if (!m.present) return blocked(ctx, key, what);
  if (!m.finite) return nonFinite(ctx, key, what);
  const value = m.value as number;
  const min = ctx.tolerance.min ?? 0;
  if (value >= min) {
    return { status: 'passed', observed: `${key}=${value}`, rationale: `${what} >= declared min ${min}` };
  }
  return { status: 'failed', observed: `${key}=${value}`, rationale: `${what} is below the declared min ${min}` };
}

/** An exact boolean measurement. */
function flagTrue(ctx: RuleContext, key: string, what: string): RuleVerdict {
  const value = flag(ctx.job, key);
  if (value === null) return blocked(ctx, key, what);
  if (value) return { status: 'passed', observed: `${key}=true`, rationale: what };
  return { status: 'failed', observed: `${key}=false`, rationale: what };
}

// --- parameterized_feature -------------------------------------------------

function declaredShapeMatches(ctx: RuleContext, key: string): RuleVerdict {
  const raw = ctx.job[key];
  if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'number')) {
    return blocked(ctx, key, 'the output shape');
  }
  const actual = raw as number[];
  const expected = ctx.declared.expectedShape;
  const same = actual.length === expected.length && actual.every((v, i) => v === expected[i]);
  const observed = `${key}=[${actual.join(',')}] dtype=${String(ctx.job.outputDtype)} device=${String(ctx.job.outputDevice)}`;
  if (!same) {
    return {
      status: 'failed',
      observed,
      rationale: `declared output shape [${expected.join(',')}] was not preserved`,
    };
  }
  if (ctx.job.outputDtype !== ctx.declared.expectedDtype) {
    return {
      status: 'failed',
      observed,
      rationale: `declared output dtype "${ctx.declared.expectedDtype}" was not preserved`,
    };
  }
  if (ctx.job.outputDevice !== ctx.declared.expectedDevice) {
    return {
      status: 'failed',
      observed,
      rationale: `declared device "${ctx.declared.expectedDevice}" was not preserved`,
    };
  }
  return { status: 'passed', observed, rationale: 'declared shape, dtype and device are preserved' };
}

const PARAMETERIZED_RULES: MechanismRule[] = [
  {
    id: 'parameterized.shape_dtype_device',
    mechanismKind: 'parameterized_feature',
    title: 'declared output shape/dtype/device preserved',
    toleranceId: 'parameterized.shape_dtype_device',
    measurementRefs: ['outputShape', 'outputDtype', 'outputDevice'],
    evaluate: (ctx) => declaredShapeMatches(ctx, 'outputShape'),
  },
  {
    id: 'parameterized.forward_participation',
    mechanismKind: 'parameterized_feature',
    title: 'module really participates in forward',
    toleranceId: 'parameterized.forward.participation',
    measurementRefs: ['executionCount', 'expectedExecutionCount'],
    evaluate: (ctx) => {
      const observed = measured(ctx.job, 'executionCount');
      if (!observed.present) return blocked(ctx, 'executionCount', 'forward participation');
      if (!observed.finite) return nonFinite(ctx, 'executionCount', 'forward participation');
      const count = observed.value as number;
      // The expectation comes from the HOST DECLARATION first. The probe reports its own
      // `expectedExecutionCount` for readability, but a probe (or a patch that influenced it) must
      // not be able to lower the bar the engine holds it to.
      const reported = measured(ctx.job, 'expectedExecutionCount');
      const want =
        ctx.declared.steps > 0
          ? ctx.declared.steps
          : reported.present && reported.finite
            ? (reported.value as number)
            : NaN;
      if (!Number.isFinite(want)) return blocked(ctx, 'expectedExecutionCount', 'forward participation');
      if (count >= want && want >= 1) {
        return {
          status: 'passed',
          observed: `executionCount=${count} expectedExecutionCount=${want}`,
          rationale: 'the module ran on every declared forward pass',
        };
      }
      return {
        status: 'failed',
        observed: `executionCount=${count} expectedExecutionCount=${want}`,
        rationale:
          count === 0
            ? 'attached but bypassed: the module was present in the graph yet executed zero times'
            : 'the module executed fewer times than the declared forward passes',
      };
    },
  },
  {
    id: 'parameterized.finiteness',
    mechanismKind: 'parameterized_feature',
    title: 'forward output and loss are finite',
    toleranceId: 'parameterized.finiteness',
    measurementRefs: ['outputFinite', 'lossFinite'],
    evaluate: (ctx) => {
      const out = flag(ctx.job, 'outputFinite');
      const loss = flag(ctx.job, 'lossFinite');
      if (out === null || loss === null) return blocked(ctx, 'outputFinite', 'numerical finiteness');
      const observed = `outputFinite=${out} lossFinite=${loss}`;
      if (out && loss) return { status: 'passed', observed, rationale: 'forward output and loss are finite' };
      return { status: 'failed', observed, rationale: 'NaN/Inf detected in the forward output or the loss' };
    },
  },
  {
    id: 'parameterized.output_difference',
    mechanismKind: 'parameterized_feature',
    title: 'fixed input produces an interpretable output difference',
    toleranceId: 'parameterized.output.difference',
    measurementRefs: ['forwardDiffVsDisabled'],
    evaluate: (ctx) => atLeast(ctx, 'forwardDiffVsDisabled', 'output difference vs. the module-disabled path'),
  },
  {
    id: 'parameterized.optimizer_covers_parameters',
    mechanismKind: 'parameterized_feature',
    title: 'the optimizer really holds the module parameters',
    toleranceId: 'parameterized.optimizer.coverage',
    measurementRefs: ['trainableParamCount', 'optimizerModuleParamCount'],
    evaluate: (ctx) => {
      const trainable = measured(ctx.job, 'trainableParamCount');
      const covered = measured(ctx.job, 'optimizerModuleParamCount');
      if (!trainable.present || !covered.present) {
        return blocked(ctx, 'optimizerModuleParamCount', 'optimizer coverage of module parameters');
      }
      if (!trainable.finite || !covered.finite) {
        return nonFinite(ctx, 'optimizerModuleParamCount', 'optimizer coverage of module parameters');
      }
      const total = trainable.value as number;
      const inOptimizer = covered.value as number;
      const observed = `trainableParamCount=${total} optimizerModuleParamCount=${inOptimizer}`;
      if (total === 0) {
        return {
          status: 'failed',
          observed,
          rationale: 'a parameterized_feature module declares no trainable parameters; this is the wrong mechanism kind',
        };
      }
      if (inOptimizer === total) {
        return { status: 'passed', observed, rationale: 'every trainable module parameter is in an optimizer group' };
      }
      return {
        status: 'failed',
        observed,
        rationale: `optimizer is missing ${total - inOptimizer} of ${total} module parameters (constructed before the module was attached)`,
      };
    },
  },
  {
    id: 'parameterized.gradients_finite',
    mechanismKind: 'parameterized_feature',
    title: 'trainable-parameter gradients are finite',
    toleranceId: 'parameterized.finiteness',
    measurementRefs: ['finiteGrad', 'paramsWithGrad'],
    evaluate: (ctx) => {
      const finite = flag(ctx.job, 'finiteGrad');
      const withGrad = measured(ctx.job, 'paramsWithGrad');
      if (finite === null || !withGrad.present) return blocked(ctx, 'finiteGrad', 'parameter gradients');
      const observed = `finiteGrad=${finite} paramsWithGrad=${withGrad.value}`;
      if (!finite) return { status: 'failed', observed, rationale: 'NaN/Inf gradient detected on a trainable parameter' };
      if ((withGrad.value as number) < 1) {
        return { status: 'failed', observed, rationale: 'no trainable parameter received a gradient' };
      }
      return { status: 'passed', observed, rationale: 'all trainable-parameter gradients are finite' };
    },
  },
  {
    id: 'parameterized.gradient_norm',
    mechanismKind: 'parameterized_feature',
    title: 'max gradient norm is above the declared floor',
    toleranceId: 'parameterized.grad.norm',
    measurementRefs: ['maxGradNorm'],
    evaluate: (ctx) => atLeast(ctx, 'maxGradNorm', 'max gradient norm'),
  },
  {
    id: 'parameterized.parameter_update',
    mechanismKind: 'parameterized_feature',
    title: 'trainable parameters update within the declared steps',
    toleranceId: 'parameterized.param.update',
    measurementRefs: ['parameterUpdated', 'maxParameterDelta'],
    evaluate: (ctx) => {
      const updated = flag(ctx.job, 'parameterUpdated');
      const delta = measured(ctx.job, 'maxParameterDelta');
      if (updated === null || !delta.present) return blocked(ctx, 'parameterUpdated', 'parameter update');
      if (!delta.finite) return nonFinite(ctx, 'maxParameterDelta', 'parameter update');
      const observed = `parameterUpdated=${updated} maxParameterDelta=${delta.value}`;
      const min = ctx.tolerance.min ?? 0;
      if (updated && (delta.value as number) >= min) {
        return { status: 'passed', observed, rationale: `parameters moved by at least the declared ${min} over ${ctx.declared.steps} steps` };
      }
      return {
        status: 'failed',
        observed,
        rationale: `parameters did not move by the declared ${min} within ${ctx.declared.steps} steps (optimizer missing them, or learning rate 0)`,
      };
    },
  },
];

// --- parameter_free_operator ----------------------------------------------

const OPERATOR_RULES: MechanismRule[] = [
  {
    id: 'parameter_free.reference_output_tolerance',
    mechanismKind: 'parameter_free_operator',
    title: 'candidate output matches the reference within the declared tolerance',
    toleranceId: 'parameter_free.reference.abs',
    measurementRefs: ['referenceVsCandidateMaxAbsDiff', 'referenceMagnitude', 'outputChangedVsReference'],
    evaluate: (ctx) => {
      const diff = measured(ctx.job, 'referenceVsCandidateMaxAbsDiff');
      if (!diff.present) return blocked(ctx, 'referenceVsCandidateMaxAbsDiff', 'reference equivalence');
      if (!diff.finite) return nonFinite(ctx, 'referenceVsCandidateMaxAbsDiff', 'reference equivalence');
      const magnitude = measured(ctx.job, 'referenceMagnitude');
      const referenceMagnitude = magnitude.present && magnitude.finite ? (magnitude.value as number) : undefined;
      const changed = flag(ctx.job, 'outputChangedVsReference');
      const verdict = atMost(ctx, 'referenceVsCandidateMaxAbsDiff', 'reference-vs-candidate difference', referenceMagnitude);
      if (verdict.status !== 'passed') {
        // The weak signal a "did anything change?" check would use, recorded next to the refusal so
        // the difference between the two questions stays visible in the report.
        return {
          ...verdict,
          observed: `${verdict.observed} outputChangedVsReference=${changed}`,
          rationale: `${verdict.rationale}; "the output changed" is not equivalence, and the reference-vs-candidate bound is what decides`,
        };
      }
      if (changed === null) return blocked(ctx, 'outputChangedVsReference', 'the output-change flag');
      return verdict;
    },
  },
  {
    id: 'parameter_free.mask_is_read',
    mechanismKind: 'parameter_free_operator',
    title: 'the candidate actually reads the mask',
    toleranceId: 'parameter_free.mask.sensitivity',
    measurementRefs: ['maskSensitivityMaxAbsDiff'],
    evaluate: (ctx) => atLeast(ctx, 'maskSensitivityMaxAbsDiff', 'output sensitivity to the mask'),
  },
  {
    id: 'parameter_free.mask_boundary',
    mechanismKind: 'parameter_free_operator',
    title: 'mask/numerical boundary behaviour matches the reference',
    toleranceId: 'parameter_free.mask.zero',
    measurementRefs: ['maskZeroMaxAbsDiff', 'maskBoundaryMaxAbsDiff', 'maskZeroCount', 'maskBoundaryCount'],
    evaluate: (ctx) => {
      const zero = atMost(ctx, 'maskZeroMaxAbsDiff', 'output where the mask declares the position invalid');
      if (zero.status !== 'passed') return zero;
      // The boundary bound is its own declared tolerance, not a silent default: the rule declares
      // `parameter_free.mask.boundary` as its second bound and resolves it through the profile.
      const boundaryCtx: RuleContext = { ...ctx, tolerance: ctx.toleranceFor('parameter_free.mask.boundary') };
      return atMost(boundaryCtx, 'maskBoundaryMaxAbsDiff', 'worst disagreement on a mask boundary');
    },
  },
  {
    id: 'parameter_free.input_output_equivalence',
    mechanismKind: 'parameter_free_operator',
    title: 'input and mask gradients are equivalent to the reference',
    toleranceId: 'parameter_free.gradient',
    measurementRefs: ['gradXMaxAbsDiff', 'gradMaskMaxAbsDiff'],
    evaluate: (ctx) => {
      const gradX = atMost(ctx, 'gradXMaxAbsDiff', 'gradient w.r.t. the input');
      if (gradX.status !== 'passed') return gradX;
      const available = flag(ctx.job, 'gradMaskAvailable');
      if (available === null) return blocked(ctx, 'gradMaskAvailable', 'gradient w.r.t. the mask');
      if (!available) return gradX;
      return atMost(ctx, 'gradMaskMaxAbsDiff', 'gradient w.r.t. the mask');
    },
  },
  {
    id: 'parameter_free.gradient_finite',
    mechanismKind: 'parameter_free_operator',
    title: 'equivalence gradients are finite',
    toleranceId: 'parameter_free.finiteness',
    measurementRefs: ['gradXFinite', 'gradMaskFinite'],
    evaluate: (ctx) => {
      const gx = flag(ctx.job, 'gradXFinite');
      if (gx === null) return blocked(ctx, 'gradXFinite', 'gradient finiteness');
      const gm = flag(ctx.job, 'gradMaskFinite');
      const observed = `gradXFinite=${gx} gradMaskFinite=${gm}`;
      if (!gx || gm === false) {
        return { status: 'failed', observed, rationale: 'NaN/Inf detected in an equivalence gradient' };
      }
      return { status: 'passed', observed, rationale: 'equivalence gradients are finite' };
    },
  },
  {
    id: 'parameter_free.parameter_count',
    mechanismKind: 'parameter_free_operator',
    title: 'the operator really is parameter-free',
    toleranceId: 'parameter_free.parameter.count',
    measurementRefs: ['parameterCount'],
    evaluate: (ctx) => {
      const count = measured(ctx.job, 'parameterCount');
      if (!count.present) return blocked(ctx, 'parameterCount', 'the parameter-free property');
      const observed = `parameterCount=${count.value}`;
      if ((count.value as number) === 0) {
        return { status: 'passed', observed, rationale: 'the operator holds no parameters, so no parameter-update check applies to it' };
      }
      return {
        status: 'failed',
        observed,
        rationale: 'a parameter_free_operator declares parameters; it must be checked as parameterized_feature instead',
      };
    },
  },
];

// --- loss ------------------------------------------------------------------

const LOSS_RULES: MechanismRule[] = [
  {
    id: 'loss.term_added_to_total',
    mechanismKind: 'loss',
    title: 'the term is actually added to the total loss',
    toleranceId: 'loss.total.vs.ce',
    measurementRefs: ['totalLoss', 'crossEntropyLoss', 'callCount'],
    evaluate: (ctx) => {
      const total = measured(ctx.job, 'totalLoss');
      const ce = measured(ctx.job, 'crossEntropyLoss');
      const calls = measured(ctx.job, 'callCount');
      if (!total.present || !ce.present || !calls.present) {
        return blocked(ctx, 'totalLoss', 'whether the term is in the total loss');
      }
      if (!total.finite || !ce.finite) return nonFinite(ctx, 'totalLoss', 'the total loss');
      const delta = Math.abs((total.value as number) - (ce.value as number));
      const observed = `totalLoss=${total.value} crossEntropyLoss=${ce.value} |total-ce|=${delta} callCount=${calls.value}`;
      const min = ctx.tolerance.min ?? 0;
      if ((calls.value as number) < 1) {
        return {
          status: 'failed',
          observed,
          rationale: 'the loss term was defined but never called on the training path (callCount == 0)',
        };
      }
      if (delta >= min) {
        return { status: 'passed', observed, rationale: `the total loss differs from the bare cross-entropy by at least ${min}` };
      }
      return {
        status: 'failed',
        observed,
        rationale: `total loss equals the bare cross-entropy (delta ${delta} < ${min}): the term contributes nothing (weight 0 or not added)`,
      };
    },
  },
  {
    id: 'loss.coefficient',
    mechanismKind: 'loss',
    title: 'the declared coefficient is the one that is applied',
    toleranceId: 'loss.coefficient.abs',
    measurementRefs: ['effectiveCoefficient', 'coefficientDeclared'],
    evaluate: (ctx) => {
      const effective = measured(ctx.job, 'effectiveCoefficient');
      const declaredRaw = ctx.job.coefficientDeclared;
      const declared = typeof declaredRaw === 'number' ? declaredRaw : ctx.declared.coefficient;
      if (!effective.present) return blocked(ctx, 'effectiveCoefficient', 'the applied coefficient');
      if (!effective.finite) return nonFinite(ctx, 'effectiveCoefficient', 'the applied coefficient');
      if (declared === undefined) return blocked(ctx, 'coefficientDeclared', 'the declared coefficient');
      const value = effective.value as number;
      const bound = Math.max(ctx.tolerance.abs ?? 0, (ctx.tolerance.rel ?? 0) * Math.abs(declared));
      const observed = `effectiveCoefficient=${value} coefficientDeclared=${declared} bound=${bound}`;
      if (Math.abs(value - declared) <= bound) {
        return { status: 'passed', observed, rationale: 'the coefficient recovered from (total - ce) / term matches the declared one' };
      }
      return {
        status: 'failed',
        observed,
        rationale: `applied coefficient ${value} differs from the declared ${declared} by more than ${bound}`,
      };
    },
  },
  {
    id: 'loss.reduction_rule',
    mechanismKind: 'loss',
    title: 'the declared reduction rule is the one that is applied',
    toleranceId: 'loss.reduction',
    measurementRefs: ['observedReduction', 'reductionDeclared'],
    evaluate: (ctx) => {
      const observedReduction = ctx.job.observedReduction;
      const declaredReduction = ctx.job.reductionDeclared;
      if (typeof observedReduction !== 'string' || typeof declaredReduction !== 'string') {
        return blocked(ctx, 'observedReduction', 'the applied reduction rule');
      }
      const observed = `observedReduction=${observedReduction} reductionDeclared=${declaredReduction}`;
      if (observedReduction === declaredReduction) {
        return { status: 'passed', observed, rationale: 'the reduction rule recovered from the numbers matches the declared rule' };
      }
      return { status: 'failed', observed, rationale: 'the applied reduction rule differs from the declared rule' };
    },
  },
  {
    id: 'loss.gradient_wrt_logits',
    mechanismKind: 'loss',
    title: 'the term produces a finite, non-zero gradient w.r.t. the specified logits',
    toleranceId: 'loss.gradient.logits',
    measurementRefs: ['logitsGradFinite', 'logitsGradNonZero', 'logitsGradMaxAbs'],
    evaluate: (ctx) => {
      const finite = flag(ctx.job, 'logitsGradFinite');
      const nonZero = flag(ctx.job, 'logitsGradNonZero');
      const magnitude = measured(ctx.job, 'logitsGradMaxAbs');
      if (finite === null || nonZero === null || !magnitude.present) {
        return blocked(ctx, 'logitsGradFinite', 'the gradient w.r.t. the specified logits');
      }
      const observed = `logitsGradFinite=${finite} logitsGradNonZero=${nonZero} logitsGradMaxAbs=${magnitude.value}`;
      if (!finite) return { status: 'failed', observed, rationale: 'NaN/Inf gradient w.r.t. the logits' };
      if (!nonZero) return { status: 'failed', observed, rationale: 'the gradient w.r.t. the specified logits is all zero' };
      return { status: 'passed', observed, rationale: 'a finite, non-zero gradient reaches the specified logits' };
    },
  },
  {
    id: 'loss.gradient_wrt_parameters',
    mechanismKind: 'loss',
    title: 'the term produces finite, non-zero parameter gradients',
    toleranceId: 'loss.gradient.contribution',
    measurementRefs: ['parameterGradFinite', 'parameterGradMaxAbs'],
    evaluate: (ctx) => {
      const finite = flag(ctx.job, 'parameterGradFinite');
      const magnitude = measured(ctx.job, 'parameterGradMaxAbs');
      if (finite === null || !magnitude.present) return blocked(ctx, 'parameterGradFinite', 'parameter gradients');
      const observed = `parameterGradFinite=${finite} parameterGradMaxAbs=${magnitude.value}`;
      if (!finite) return { status: 'failed', observed, rationale: 'NaN/Inf parameter gradient from the total loss' };
      if ((magnitude.value as number) < (ctx.tolerance.min ?? 0)) {
        return { status: 'failed', observed, rationale: 'all parameter gradients are zero' };
      }
      return { status: 'passed', observed, rationale: 'finite, non-zero parameter gradients' };
    },
  },
  {
    id: 'loss.gradient_contribution',
    mechanismKind: 'loss',
    title: 'the term changes the backward pass, not only the forward total',
    toleranceId: 'loss.gradient.contribution',
    measurementRefs: ['totalVsCrossEntropyGradMaxAbsDiff'],
    evaluate: (ctx) => atLeast(ctx, 'totalVsCrossEntropyGradMaxAbsDiff', 'gradient difference between the total and the bare cross-entropy'),
  },
  {
    id: 'loss.label_and_ignore_mask',
    mechanismKind: 'loss',
    title: 'label and ignore-mask semantics are correct',
    toleranceId: 'loss.label.active.count',
    measurementRefs: ['activeCount', 'declaredActiveCount', 'labelsUsed', 'labelsDeclared', 'ignoreIndex'],
    evaluate: (ctx) => {
      const active = measured(ctx.job, 'activeCount');
      const declaredActive = measured(ctx.job, 'declaredActiveCount');
      if (!active.present || !declaredActive.present) return blocked(ctx, 'activeCount', 'ignore-mask semantics');
      const used = numberList(ctx.job, 'labelsUsed');
      const declared = numberList(ctx.job, 'labelsDeclared');
      if (used === null || declared === null) return blocked(ctx, 'labelsUsed', 'label semantics');
      const observed = `activeCount=${active.value} declaredActiveCount=${declaredActive.value} labelsUsed=[${used.join(',')}]`;
      if ((active.value as number) !== (declaredActive.value as number)) {
        return {
          status: 'failed',
          observed,
          rationale: 'the criterion saw a different number of active labels than the ignore mask declares',
        };
      }
      const mismatch = declared.some((v, i) => used[i] !== v);
      if (mismatch) {
        return {
          status: 'failed',
          observed,
          rationale: 'the label vector was rewritten before the criterion saw it, so the ignore mask never took effect',
        };
      }
      return { status: 'passed', observed, rationale: 'labels and ignore-mask semantics are preserved' };
    },
  },
  {
    id: 'loss.finite',
    mechanismKind: 'loss',
    title: 'total loss, cross-entropy and term value are finite',
    toleranceId: 'parameterized.finiteness',
    measurementRefs: ['totalLoss', 'crossEntropyLoss', 'termValueAtEval'],
    evaluate: (ctx) => {
      const keys = ['totalLoss', 'crossEntropyLoss', 'termValueAtEval'];
      const values = keys.map((k) => measured(ctx.job, k));
      if (values.some((v) => !v.present)) return blocked(ctx, 'totalLoss', 'loss finiteness');
      const observed = keys.map((k, i) => `${k}=${values[i].value}`).join(' ');
      if (values.some((v) => !v.finite)) {
        return { status: 'failed', observed, rationale: 'NaN/Inf detected in the loss values' };
      }
      return { status: 'passed', observed, rationale: 'all loss values are finite' };
    },
  },
];

// --- training_hook / data_policy ------------------------------------------

const HOOK_RULES: MechanismRule[] = [
  {
    id: 'hook.fires_at_declared_position',
    mechanismKind: 'training_hook',
    title: 'the hook fires, at the declared position',
    toleranceId: 'hook.fire.count',
    measurementRefs: ['fireCount', 'expectedFireCount', 'observedPositions'],
    evaluate: (ctx) => {
      const fired = measured(ctx.job, 'fireCount');
      const positions = stringList(ctx.job, 'observedPositions');
      if (!fired.present || positions === null) {
        return blocked(ctx, 'fireCount', 'whether the training path enters the hook branch');
      }
      // Same rule as forward participation: the declared step count is the bar, not whatever the
      // probe reports as its own expectation.
      const reported = measured(ctx.job, 'expectedFireCount');
      const expectedFireCount =
        ctx.declared.steps > 0
          ? ctx.declared.steps
          : reported.present && reported.finite
            ? (reported.value as number)
            : NaN;
      if (!Number.isFinite(expectedFireCount)) return blocked(ctx, 'expectedFireCount', 'the hook fire count');
      const declared = ctx.declared.hookPosition;
      const observed = `fireCount=${fired.value} expectedFireCount=${expectedFireCount} observedPositions=[${positions.join(',')}]`;
      if ((fired.value as number) < 1) {
        return {
          status: 'failed',
          observed,
          rationale: 'static code is present but the training path never enters that branch (fireCount == 0)',
        };
      }
      if ((fired.value as number) < expectedFireCount) {
        return {
          status: 'failed',
          observed,
          rationale: `the hook fired ${fired.value} times but the declared ${expectedFireCount} training steps require ${expectedFireCount}`,
        };
      }
      if (declared !== undefined && positions.some((p) => p !== declared)) {
        return {
          status: 'failed',
          observed,
          rationale: `the hook fired at a position other than the declared "${declared}"`,
        };
      }
      return { status: 'passed', observed, rationale: `the hook fired at the declared position "${declared ?? 'unspecified'}"` };
    },
  },
  {
    id: 'hook.seed_reproducible',
    mechanismKind: 'training_hook',
    title: 'the declared seed reproduces the same draw',
    toleranceId: 'hook.seed.reproducible',
    measurementRefs: ['seedReproducible'],
    evaluate: (ctx) => flagTrue(ctx, 'seedReproducible', 'the declared seed reproduces the same random draw'),
  },
  {
    id: 'hook.batch_and_sample_coverage',
    mechanismKind: 'training_hook',
    title: 'the declared batches and sample coverage really take effect',
    toleranceId: 'hook.sample.coverage',
    measurementRefs: ['batchesObserved', 'samplesCovered', 'declaredSampleCount'],
    evaluate: (ctx) => {
      const batches = ctx.job.batchesObserved;
      const covered = measured(ctx.job, 'samplesCovered');
      const declaredSamples = measured(ctx.job, 'declaredSampleCount');
      if (!Array.isArray(batches) || !covered.present || !declaredSamples.present) {
        return blocked(ctx, 'batchesObserved', 'batch and sample coverage');
      }
      const encoded = batches.map((b) => (Array.isArray(b) ? b.join('-') : String(b)));
      const observed = `batchesObserved=${encoded.join(' | ')} samplesCovered=${covered.value} declaredSampleCount=${declaredSamples.value}`;
      if (new Set(encoded).size < encoded.length) {
        return {
          status: 'failed',
          observed,
          rationale: 'the batch loader never advances: the same batch was trained on more than once',
        };
      }
      const batchSize = Array.isArray(batches[0]) ? (batches[0] as unknown[]).length : 0;
      const expectedCoverage = Math.min(declaredSamples.value as number, batchSize * encoded.length);
      if ((covered.value as number) < expectedCoverage) {
        return {
          status: 'failed',
          observed,
          rationale: `only ${covered.value} of the expected ${expectedCoverage} samples were covered by the declared steps`,
        };
      }
      return { status: 'passed', observed, rationale: 'each declared step used a distinct batch and the declared coverage was reached' };
    },
  },
  {
    id: 'hook.schedule_effective',
    mechanismKind: 'training_hook',
    title: 'the declared schedule actually changes the optimizer state',
    toleranceId: 'hook.schedule.distinct',
    measurementRefs: ['scheduleValues', 'scheduleDistinctValues', 'scheduleApplied'],
    evaluate: (ctx) => {
      const applied = flag(ctx.job, 'scheduleApplied');
      const distinct = measured(ctx.job, 'scheduleDistinctValues');
      const values = numberList(ctx.job, 'scheduleValues');
      if (applied === null || !distinct.present || values === null) {
        return blocked(ctx, 'scheduleDistinctValues', 'the declared schedule');
      }
      const observed = `scheduleApplied=${applied} scheduleDistinctValues=${distinct.value} scheduleValues=[${values.join(',')}]`;
      if (!applied) {
        return { status: 'failed', observed, rationale: 'the schedule is declared but was never applied on the training path' };
      }
      if ((distinct.value as number) < (ctx.tolerance.min ?? 2)) {
        return {
          status: 'failed',
          observed,
          rationale: 'the schedule produced a single distinct value, so it had no effect on the optimizer state',
        };
      }
      return { status: 'passed', observed, rationale: 'the schedule changed the optimizer state across the declared steps' };
    },
  },
];

const DATA_POLICY_RULES: MechanismRule[] = [
  {
    id: 'data_policy.targets_constructed',
    mechanismKind: 'data_policy',
    title: 'the declared target construction actually takes effect',
    toleranceId: 'data_policy.targets.constructed',
    measurementRefs: ['targetsPresent', 'targetsSeen'],
    evaluate: (ctx) => {
      const present = flag(ctx.job, 'targetsPresent');
      const seen = measured(ctx.job, 'targetsSeen');
      if (present === null || !seen.present) return blocked(ctx, 'targetsPresent', 'target construction');
      const observed = `targetsPresent=${present} targetsSeen=${seen.value}`;
      if (!present || (seen.value as number) < (ctx.tolerance.min ?? 1)) {
        return {
          status: 'failed',
          observed,
          rationale: 'the declared target construction never ran on the training path, so the step trained on no target',
        };
      }
      return { status: 'passed', observed, rationale: 'the declared targets reached the training step' };
    },
  },
  {
    id: 'data_policy.sample_coverage',
    mechanismKind: 'data_policy',
    title: 'the declared sample coverage takes effect',
    toleranceId: 'hook.sample.coverage',
    measurementRefs: ['batchesObserved', 'samplesCovered', 'declaredSampleCount'],
    evaluate: (ctx) => HOOK_RULES[2].evaluate(ctx),
  },
  {
    id: 'data_policy.seed_reproducible',
    mechanismKind: 'data_policy',
    title: 'the declared seed reproduces the same data draw',
    toleranceId: 'hook.seed.reproducible',
    measurementRefs: ['seedReproducible'],
    evaluate: (ctx) => flagTrue(ctx, 'seedReproducible', 'the declared seed reproduces the same data draw'),
  },
];

// --- combination -----------------------------------------------------------

export interface CombinationInput {
  id: string;
  /** Declared ordered module ids, from the host plan binding. */
  declaredOrder: string[];
  /** Real per-module CheckReports produced by running each module ALONE. */
  perModule: Array<{ moduleId: string; report: CheckReport }>;
  /**
   * Real probe job for the COMBINATION run. Absent means the combination was never run, which is
   * the exact failure verdict of SPEC section 4 row 5.
   */
  combinationProbeJob?: Record<string, unknown>;
  /**
   * Host-side override of the build order, used to construct a real order-conflict negative case.
   * It is part of the host input, never of a submitted patch.
   */
  buildOrderOverride?: number[];
  declared: {
    functions: Array<{ function: string; moduleIds: string[] }>;
    sharedState: Array<{ name: string; moduleIds: string[] }>;
    /**
     * Declared parameter owners and how many parameters each is allowed to contribute to the
     * composition. This is a whitelist with counts, not a copy of the observation: a member that
     * grows parameters, or a head the plan never accounted for, changes an owner's count and fails.
     */
    parameterSources: Array<{ owner: string; parameterCount: number }>;
  };
  observed: {
    sharedState: Array<{ name: string; moduleIds: string[] }>;
  };
}

export interface CombinationRule {
  id: string;
  title: string;
  toleranceId: string;
  measurementRefs: string[];
  evaluate: (input: CombinationInput, tolerance: Tolerance) => RuleVerdict;
}

const COMBINATION_RULES: CombinationRule[] = [
  {
    id: 'combination.members_pass_alone',
    title: 'every member has its own passing report',
    toleranceId: 'combination.member.alone',
    measurementRefs: ['perModule'],
    evaluate: (input) => {
      if (input.perModule.length === 0) {
        return { status: 'blocked', observed: 'perModule=[]', rationale: 'capability missing: no per-module report was supplied for this combination' };
      }
      const missing = input.declaredOrder.filter((id) => !input.perModule.some((m) => m.moduleId === id));
      if (missing.length > 0) {
        return {
          status: 'failed',
          observed: `perModule=[${input.perModule.map((m) => m.moduleId).join(',')}] missing=[${missing.join(',')}]`,
          rationale: 'a member of the combination has no standalone report',
        };
      }
      const notPassed = input.perModule.filter((m) => m.report.status !== 'passed');
      const observed = `perModule=${input.perModule.map((m) => `${m.moduleId}:${m.report.status}`).join(' ')}`;
      if (notPassed.length > 0) {
        return {
          status: 'failed',
          observed,
          rationale: `member(s) ${notPassed.map((m) => m.moduleId).join(', ')} did not pass alone, so the combination cannot be assessed`,
        };
      }
      return { status: 'passed', observed, rationale: 'each member passed its own mechanism checks in isolation' };
    },
  },
  {
    id: 'combination.run_present',
    title: 'the combination itself was really run',
    toleranceId: 'combination.run',
    measurementRefs: ['combinationProbeJob'],
    evaluate: (input) => {
      if (!input.combinationProbeJob) {
        return {
          status: 'failed',
          observed: 'combinationProbeJob=<absent>',
          rationale: 'per-module ready was treated as proof of the combination; the combination itself was never run',
        };
      }
      const error = input.combinationProbeJob.error;
      if (typeof error === 'string' && error.length > 0) {
        return {
          status: 'failed',
          observed: `combinationProbeJob.error=${error}`,
          rationale: 'the combination run raised, so the combination was not exercised',
        };
      }
      return {
        status: 'passed',
        observed: `combinationProbeJob.id=${String(input.combinationProbeJob.id)}`,
        rationale: 'a real run of the combination exists',
      };
    },
  },
  {
    id: 'combination.order',
    title: 'the observed combination order equals the declared order',
    toleranceId: 'combination.order',
    measurementRefs: ['orderPerPass', 'expectedOrderPerPass', 'executionCounts'],
    evaluate: (input) => {
      const job = input.combinationProbeJob;
      const declaredOrder = `declaredOrder=[${input.declaredOrder.join(',')}]`;
      if (!job) {
        return { status: 'blocked', observed: declaredOrder, rationale: 'capability missing: the combination run reported no execution order because it never ran' };
      }
      const perPass = job.orderPerPass;
      const expected = stringList(job, 'expectedOrderPerPass');
      if (!Array.isArray(perPass) || expected === null) {
        return { status: 'blocked', observed: declaredOrder, rationale: 'capability missing: the combination probe reported no per-pass execution order' };
      }
      const chunks = perPass.map((chunk) => (Array.isArray(chunk) ? chunk.join('>') : String(chunk)));
      const expectedKey = expected.join('>');
      const observed = `expectedOrderPerPass=[${expectedKey}] observedPerPass=[${chunks.join(' | ')}]`;
      if (chunks.length === 0) {
        return { status: 'blocked', observed, rationale: 'capability missing: the combination run observed no forward pass' };
      }
      if (chunks.every((chunk) => chunk === expectedKey)) {
        return { status: 'passed', observed, rationale: 'the modules executed in the declared order on every forward pass' };
      }
      return {
        status: 'failed',
        observed,
        rationale: 'the modules executed in an order other than the declared order',
      };
    },
  },
  {
    id: 'combination.duplicate_function',
    title: 'no two members claim the same function',
    toleranceId: 'combination.function.ownership',
    measurementRefs: ['declared.functions'],
    evaluate: (input) => {
      if (input.declared.functions.length === 0) {
        return { status: 'blocked', observed: 'declared.functions=[]', rationale: 'capability missing: the combination declares no per-module function list' };
      }
      const duplicates = input.declared.functions.filter((f) => f.moduleIds.length > 1);
      const observed = `functions=${input.declared.functions.map((f) => `${f.function}:${f.moduleIds.join('+')}`).join(' ')}`;
      if (duplicates.length === 0) {
        return { status: 'passed', observed, rationale: 'each declared function is provided by exactly one member' };
      }
      return {
        status: 'failed',
        observed,
        rationale: `duplicate function(s) ${duplicates.map((f) => f.function).join(', ')} are provided by more than one member`,
      };
    },
  },
  {
    id: 'combination.shared_state',
    title: 'shared state is exactly the declared shared state',
    toleranceId: 'combination.shared_state',
    measurementRefs: ['sharedState.observed', 'sharedState.declared'],
    evaluate: (input) => {
      const declaredKey = input.declared.sharedState.map((s) => `${s.name}:${[...s.moduleIds].sort().join('+')}`).sort();
      const observedKey = input.observed.sharedState.map((s) => `${s.name}:${[...s.moduleIds].sort().join('+')}`).sort();
      const observed = `declared=[${declaredKey.join(',')}] observed=[${observedKey.join(',')}]`;
      if (declaredKey.length === 0 && observedKey.length === 0) {
        return { status: 'passed', observed, rationale: 'the combination declares and shares no state, so there is nothing to conflict' };
      }
      if (observedKey.length === 0) {
        return { status: 'blocked', observed, rationale: 'capability missing: the combination run reported no shared-state facts' };
      }
      if (declaredKey.join('|') === observedKey.join('|')) {
        return { status: 'passed', observed, rationale: 'the combination shares exactly the declared state' };
      }
      return { status: 'failed', observed, rationale: 'the combination shares state that was not declared, or misses declared shared state' };
    },
  },
  {
    id: 'combination.extra_parameter_sources',
    title: 'every extra parameter has an explicit source',
    toleranceId: 'combination.parameter_sources',
    measurementRefs: ['parameterSources', 'declared.parameterSources'],
    evaluate: (input) => {
      const job = input.combinationProbeJob;
      if (!job) {
        return {
          status: 'blocked',
          observed: 'parameterSources=<no combination run>',
          rationale: 'capability missing: the combination run reported no parameter attribution because it never ran',
        };
      }
      const raw = job.parameterSources;
      if (!Array.isArray(raw)) {
        return { status: 'blocked', observed: 'parameterSources=<missing>', rationale: 'capability missing: the combination probe reported no parameter sources' };
      }
      const observedSources = raw
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => ({ parameter: String(entry.parameter), source: String(entry.source) }));
      const observedByOwner = new Map<string, string[]>();
      for (const entry of observedSources) {
        const list = observedByOwner.get(entry.source) ?? [];
        list.push(entry.parameter);
        observedByOwner.set(entry.source, list);
      }
      const declaredOwners = new Set(input.declared.parameterSources.map((p) => p.owner));
      // Every owner the composition actually has must have been declared, with the declared count.
      // An undeclared head, or a member that grew parameters the plan never accounted for, is an
      // extra parameter source and must fail rather than be silently attributed to its module.
      const problems: string[] = [];
      for (const [owner, parameters] of observedByOwner) {
        const declaredEntry = input.declared.parameterSources.find((p) => p.owner === owner);
        if (!declaredEntry) {
          problems.push(`owner "${owner}" contributes ${parameters.length} parameter(s) but is not declared`);
          continue;
        }
        if (declaredEntry.parameterCount !== parameters.length) {
          problems.push(
            `owner "${owner}" contributes ${parameters.length} parameter(s) but ${declaredEntry.parameterCount} were declared`
          );
        }
      }
      for (const declaredEntry of input.declared.parameterSources) {
        if (!observedByOwner.has(declaredEntry.owner)) {
          problems.push(`declared owner "${declaredEntry.owner}" contributes no parameter in the real composition`);
        }
      }
      const detail = `observed=${[...observedByOwner].map(([o, p]) => `${o}:${p.length}`).join(',')} declared=${input.declared.parameterSources.map((p) => `${p.owner}:${p.parameterCount}`).join(',')}`;
      if (problems.length === 0) {
        return { status: 'passed', observed: detail, rationale: 'every parameter in the composition has a declared owner and count' };
      }
      return {
        status: 'failed',
        observed: detail,
        rationale: `extra parameter source(s) without a declaration: ${problems.slice(0, 4).join('; ')}`,
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Rule catalogue lookup
// ---------------------------------------------------------------------------

export const MECHANISM_RULES: Record<MechanismKind, readonly MechanismRule[]> = {
  parameterized_feature: PARAMETERIZED_RULES,
  parameter_free_operator: OPERATOR_RULES,
  loss: LOSS_RULES,
  training_hook: HOOK_RULES,
  data_policy: DATA_POLICY_RULES,
  combination: [],
};

export function mechanismRuleIds(kind: MechanismKind): string[] {
  if (kind === 'combination') return COMBINATION_RULES.map((r) => r.id);
  return MECHANISM_RULES[kind].map((r) => r.id);
}

export function allMechanismRuleIds(): string[] {
  return MECHANISM_KINDS.flatMap((kind) => mechanismRuleIds(kind));
}

// ---------------------------------------------------------------------------
// Host profile
// ---------------------------------------------------------------------------

export interface MechanismCheckProfile {
  profileRef: string;
  version: number;
  /** Host-owned. A request may never carry check rules. */
  source: 'host';
  executorRef: string;
  probeScript: string;
  /** Rule ids that must be evaluated, per mechanism kind. A gap here is a profile defect. */
  requiredRules: Record<MechanismKind, string[]>;
  tolerances: Tolerance[];
  /** Paths a patch under test may never modify: the check rules themselves. */
  protectedPaths: string[];
  profileHash: string;
}

export function mechanismCheckProfileBody(profile: MechanismCheckProfile): Record<string, unknown> {
  const { profileHash: _omit, ...body } = profile;
  return body;
}

export function computeMechanismCheckProfileHash(body: Record<string, unknown>): string {
  return typedHash(MECHANISM_CHECK_PROFILE_DOMAIN, body);
}

const PROFILE_KEYS = [
  'profileRef',
  'version',
  'source',
  'executorRef',
  'probeScript',
  'requiredRules',
  'tolerances',
  'protectedPaths',
  'profileHash',
] as const;

/**
 * Validates a mechanism-check profile loaded from a host config file.
 *
 * The rule set is fixed by the code above: a profile may not invent a rule, and it may not omit
 * one. That is what makes "the patch cannot change its own check rules" checkable rather than
 * aspirational.
 */
export function loadMechanismCheckProfile(raw: unknown): MechanismCheckProfile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile must be a plain object');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
      throw new ExperimentError('SCHEMA_VIOLATION', `Unknown field "${key}" in MechanismCheckProfile`);
    }
  }
  if (obj.source !== 'host') {
    throw new ExperimentError(
      'POLICY_DENIED',
      'MechanismCheckProfile.source must be "host": check rules come from the trusted host profile, never from a request or a patch'
    );
  }
  if (typeof obj.profileRef !== 'string' || obj.profileRef.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.profileRef must be a non-empty string');
  }
  if (typeof obj.version !== 'number' || !Number.isFinite(obj.version) || obj.version < 1) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.version must be a finite number >= 1');
  }
  if (typeof obj.executorRef !== 'string' || obj.executorRef.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.executorRef must be a non-empty string');
  }
  if (typeof obj.probeScript !== 'string' || obj.probeScript.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.probeScript must be a non-empty string');
  }
  if (typeof obj.requiredRules !== 'object' || obj.requiredRules === null || Array.isArray(obj.requiredRules)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.requiredRules must be an object');
  }
  const rawRules = obj.requiredRules as Record<string, unknown>;
  const requiredRules = {} as Record<MechanismKind, string[]>;
  for (const kind of MECHANISM_KINDS) {
    const declared = rawRules[kind];
    if (!Array.isArray(declared) || !declared.every((v) => typeof v === 'string')) {
      throw new ExperimentError('SCHEMA_VIOLATION', `requiredRules.${kind} must be an array of rule ids`);
    }
    const expected = mechanismRuleIds(kind);
    const missing = expected.filter((id) => !(declared as string[]).includes(id));
    const unknown = (declared as string[]).filter((id) => !expected.includes(id));
    if (missing.length > 0) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        `requiredRules.${kind} omits required rule(s): ${missing.join(', ')}. A profile may not drop a required mechanism check.`
      );
    }
    if (unknown.length > 0) {
      throw new ExperimentError('SCHEMA_VIOLATION', `requiredRules.${kind} declares unknown rule(s): ${unknown.join(', ')}`);
    }
    requiredRules[kind] = [...expected];
  }
  if (!Array.isArray(obj.tolerances)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.tolerances must be an array');
  }
  const tolerances = (obj.tolerances as unknown[]).map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ExperimentError('SCHEMA_VIOLATION', `tolerances[${i}] must be an object`);
    }
    const t = entry as Record<string, unknown>;
    for (const key of Object.keys(t)) {
      if (!['id', 'dtype', 'abs', 'rel', 'min', 'rationale'].includes(key)) {
        throw new ExperimentError('SCHEMA_VIOLATION', `Unknown field "${key}" in tolerances[${i}]`);
      }
    }
    if (typeof t.id !== 'string' || typeof t.dtype !== 'string' || typeof t.rationale !== 'string') {
      throw new ExperimentError('SCHEMA_VIOLATION', `tolerances[${i}] needs string id, dtype and rationale`);
    }
    // A tolerance may legitimately be "exact" (shape, dtype, device, a declared rule). What it may
    // NOT be is an unstated default: every entry carries a rationale, checked above, and every
    // numeric bound that is present must be finite and non-negative.
    const numeric = ['abs', 'rel', 'min'].filter((k) => t[k] !== undefined);
    for (const key of numeric) {
      const v = t[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new ExperimentError('SCHEMA_VIOLATION', `tolerances[${i}].${key} must be a finite number >= 0`);
      }
    }
    return { id: t.id, dtype: t.dtype, ...(t.abs !== undefined ? { abs: t.abs as number } : {}),
      ...(t.rel !== undefined ? { rel: t.rel as number } : {}), ...(t.min !== undefined ? { min: t.min as number } : {}),
      rationale: t.rationale } as Tolerance;
  });
  const toleranceIds = new Set(tolerances.map((t) => t.id));
  for (const kind of MECHANISM_KINDS) {
    const referenced = new Set<string>();
    if (kind === 'combination') {
      for (const rule of COMBINATION_RULES) referenced.add(rule.toleranceId);
    } else {
      for (const rule of MECHANISM_RULES[kind]) referenced.add(rule.toleranceId);
    }
    for (const id of referenced) {
      if (!toleranceIds.has(id)) {
        throw new ExperimentError('SCHEMA_VIOLATION', `requiredRules.${kind} references undeclared tolerance "${id}"`);
      }
    }
  }
  if (!Array.isArray(obj.protectedPaths) || !(obj.protectedPaths as unknown[]).every((v) => typeof v === 'string')) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.protectedPaths must be an array of strings');
  }
  if (typeof obj.profileHash !== 'string' || !/^[0-9a-f]{64}$/.test(obj.profileHash)) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'MechanismCheckProfile.profileHash must be 64-char lowercase hex');
  }

  const profile: MechanismCheckProfile = {
    profileRef: obj.profileRef,
    version: obj.version,
    source: 'host',
    executorRef: obj.executorRef,
    probeScript: obj.probeScript,
    requiredRules,
    tolerances,
    protectedPaths: [...(obj.protectedPaths as string[])],
    profileHash: obj.profileHash,
  };
  const recomputed = computeMechanismCheckProfileHash(mechanismCheckProfileBody(profile));
  if (recomputed !== profile.profileHash) {
    throw new ExperimentError(
      'SCHEMA_VIOLATION',
      `MechanismCheckProfile.profileHash mismatch (declared ${profile.profileHash.slice(0, 12)}..., computed ${recomputed.slice(0, 12)}...)`
    );
  }
  return profile;
}

/** A patch under test may not modify the files that define its own check rules. */
export function assertPatchCannotChangeCheckRules(profile: MechanismCheckProfile, changedPaths: string[]): void {
  const normalise = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const protectedNormalised = profile.protectedPaths.map(normalise);
  for (const raw of changedPaths) {
    const candidate = normalise(raw);
    const hit = protectedNormalised.find((p) => candidate === p || candidate.startsWith(`${p}/`));
    if (hit) {
      throw new ExperimentError(
        'POLICY_DENIED',
        `patch may not modify the check rules: "${raw}" is under protected path "${hit}"`,
        { fieldPaths: ['patch.changedPaths'] }
      );
    }
  }
}

function defaultProfileBody(): Record<string, unknown> {
  const requiredRules = {} as Record<MechanismKind, string[]>;
  for (const kind of MECHANISM_KINDS) requiredRules[kind] = mechanismRuleIds(kind);
  return {
    profileRef: 'phase2-mechanism-checks-v1',
    version: 1,
    source: 'host',
    executorRef: `${MECHANISM_PROBE_EXECUTOR}+phase2-mechanism-checks-v1`,
    probeScript: MECHANISM_PROBE_SCRIPT,
    requiredRules,
    tolerances: MECHANISM_TOLERANCES_V1.map((t) => ({ ...t })),
    protectedPaths: [
      'packages/evolver/src/domain/mechanism-checks.ts',
      'packages/evolver/src/domain/check-report.ts',
      'experiments/phase2-probe',
      'configs/phase2/tolerances.json',
    ],
  };
}

export const MECHANISM_CHECK_PROFILE_V1: MechanismCheckProfile = loadMechanismCheckProfile({
  ...defaultProfileBody(),
  profileHash: computeMechanismCheckProfileHash(defaultProfileBody()),
});

export function toleranceById(profile: MechanismCheckProfile, id: string): Tolerance {
  const found = profile.tolerances.find((t) => t.id === id);
  if (!found) {
    throw new ExperimentError(
      'UNSUPPORTED_CAPABILITY',
      `profile "${profile.profileRef}" declares no tolerance "${id}"; the check cannot be decided and must not default`
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Probe specification (host-built) and invocation
// ---------------------------------------------------------------------------

export interface ProbeSpec {
  schemaVersion: number;
  probeId: string;
  toleranceRef: string;
  /** One entry per declared mechanism, keyed by the module id the engine declared. */
  jobs: Array<{ jobKey: string; job: Record<string, unknown> }>;
  [key: string]: unknown;
}

function shapeAt(shape: number[], index: number, fallback: number): number {
  const v = shape[index];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The probe job for one declared mechanism. Keyed by module id, so two modules never collide. */
export function buildProbeJob(mechanism: DeclaredMechanism): { jobKey: string; job: Record<string, unknown> } {
  const overrides = mechanism.probeOverrides?.[mechanism.probeJob] ?? {};
  const batch = shapeAt(mechanism.expectedShape, 0, 4);
  const channels = shapeAt(mechanism.expectedShape, 1, 8);
  const height = shapeAt(mechanism.expectedShape, 2, 16);
  const width = shapeAt(mechanism.expectedShape, 3, 16);
  let job: Record<string, unknown>;
  if (mechanism.probeJob === 'parameterized') {
    job = {
      jobType: 'parameterized',
      id: mechanism.moduleId,
      modulePath: mechanism.modulePath,
      className: mechanism.className,
      channels,
      batchSize: batch,
      height,
      width,
      steps: mechanism.steps,
      forwardMode: 'attached',
      optimizerMode: 'full',
      lr: 0.01,
      seed: 20260929,
      ...overrides,
    };
  } else if (mechanism.probeJob === 'operator') {
    job = {
      jobType: 'operator',
      id: mechanism.moduleId,
      modulePath: mechanism.modulePath,
      className: mechanism.className,
      referenceClassName: mechanism.referenceClassName,
      batchSize: batch,
      channels,
      height,
      width,
      seed: 20260929,
      ...overrides,
    };
  } else if (mechanism.probeJob === 'loss') {
    job = {
      jobType: 'loss',
      id: mechanism.moduleId,
      modulePath: mechanism.modulePath,
      className: mechanism.className,
      coefficient: mechanism.coefficient ?? 0.5,
      reduction: mechanism.reduction ?? 'mean',
      ignoreIndex: mechanism.ignoreIndex ?? -100,
      ignoredPositions: mechanism.ignoredPositions ?? [3],
      callMode: 'wired',
      labelMode: 'correct',
      batchSize: batch,
      numClasses: mechanism.numClasses ?? 2,
      inFeatures: mechanism.inFeatures ?? 6,
      seed: 20260929,
      ...overrides,
    };
  } else {
    job = {
      jobType: 'hook',
      id: mechanism.moduleId,
      modulePath: mechanism.modulePath,
      className: mechanism.className,
      registeredPosition: mechanism.hookPosition ?? 'step_start',
      branchMode: 'reachable',
      batchMode: 'cycling',
      scheduleMode: mechanism.scheduleDeclared === false ? 'static' : 'declared',
      targetMode: mechanism.targetsDeclared === false ? 'absent' : 'declared',
      steps: mechanism.steps,
      batchSize: mechanism.batchSize ?? batch,
      sampleCount: mechanism.sampleCount ?? 16,
      initialLr: 0.01,
      seed: 20260929,
      ...overrides,
    };
  }
  return { jobKey: mechanism.moduleId, job };
}

/**
 * Builds the probe specification from the TRUSTED profile and the declared mechanisms.
 *
 * This function is the reason a patch cannot choose its own measurements: the spec is constructed
 * here, and `runMechanismProbe` accepts no caller-supplied spec.
 */
export function buildProbeSpec(profile: MechanismCheckProfile, declared: DeclaredMechanism[]): ProbeSpec {
  return {
    schemaVersion: 1,
    probeId: `${profile.profileRef}:${declared.map((d) => d.moduleId).join('+')}`,
    toleranceRef: `${profile.profileRef}#tolerances-v${profile.version}`,
    jobs: declared.map((mechanism) => buildProbeJob(mechanism)),
  };
}

export interface ProbeRunOptions {
  profile: MechanismCheckProfile;
  declared: DeclaredMechanism[];
  pythonPath?: string;
  repoRoot?: string;
  timeoutMs?: number;
}

export interface CombinationProbeOptions {
  profile: MechanismCheckProfile;
  combination: CombinationInput;
  members: DeclaredMechanism[];
  pythonPath?: string;
  repoRoot?: string;
  timeoutMs?: number;
}

export interface ProbeRun {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  command: string;
  spec: ProbeSpec;
  /** Parsed probe JSON, or null when the probe produced nothing parseable. */
  result: Record<string, unknown> | null;
  /** Set when the probe itself could not run: every affected check becomes `blocked`. */
  failure: string | null;
}

/** Shared invocation. Both entry points below build their spec from host-owned inputs only. */
function invokeProbe(options: {
  profile: MechanismCheckProfile;
  spec: ProbeSpec;
  pythonPath?: string;
  repoRoot?: string;
  timeoutMs?: number;
}): ProbeRun {
  const repoRoot = options.repoRoot ?? process.cwd();
  const pythonPath = options.pythonPath ?? 'G:\\Anaconda\\python.exe';
  const timeoutMs = options.timeoutMs ?? 120000;
  const script = path.resolve(repoRoot, options.profile.probeScript);
  const command = `${pythonPath} ${options.profile.probeScript} --spec-json <host-built spec>`;

  const base: ProbeRun = {
    ok: false,
    exitCode: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    command,
    spec: options.spec,
    result: null,
    failure: null,
  };

  if (!fs.existsSync(pythonPath)) {
    return { ...base, failure: `python interpreter not found at ${pythonPath}` };
  }
  if (!fs.existsSync(script)) {
    return { ...base, failure: `probe script not found at ${script}` };
  }

  const started = Date.now();
  const child = spawnSync(pythonPath, [script, '--spec-json', JSON.stringify(options.spec)], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const stdout = child.stdout ?? '';
  const stderr = child.stderr ?? '';

  if (child.error) {
    return { ...base, durationMs, stdout, stderr, failure: `probe could not be started: ${String(child.error)}` };
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (err) {
    return {
      ...base,
      durationMs,
      exitCode: child.status,
      stdout,
      stderr,
      failure: `probe output was not JSON (${String(err)}); stderr: ${stderr.slice(0, 400)}`,
    };
  }

  if (child.status !== 0) {
    return {
      ...base,
      durationMs,
      exitCode: child.status,
      stdout,
      stderr,
      result: parsed,
      failure: `probe exited with code ${child.status}: ${String(parsed.probeError ?? stderr.slice(0, 400))}`,
    };
  }

  return { ...base, ok: true, exitCode: child.status, durationMs, stdout, stderr, result: parsed };
}

/**
 * Runs the real CPU probe. The probe spec is built here from the trusted profile; there is no
 * parameter through which a caller -- let alone the patch under test -- could supply one.
 */
export function runMechanismProbe(options: ProbeRunOptions): ProbeRun {
  return invokeProbe({
    profile: options.profile,
    spec: buildProbeSpec(options.profile, options.declared),
    ...(options.pythonPath !== undefined ? { pythonPath: options.pythonPath } : {}),
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

/** Host-built spec for the combination job. Like `buildProbeSpec`, never caller-supplied. */
export function buildCombinationProbeSpec(
  profile: MechanismCheckProfile,
  combination: CombinationInput,
  members: DeclaredMechanism[]
): ProbeSpec {
  if (members.length === 0) {
    throw new ExperimentError('INVALID_INPUT', 'a combination probe needs at least one member');
  }
  const memberSpecs = members.map((m) => {
    if (m.probeJob !== 'parameterized') {
      throw new ExperimentError(
        'INVALID_INPUT',
        `combination member "${m.moduleId}" is not a parameterized feature module; the v1 combination job composes feature modules only`
      );
    }
    return { id: m.moduleId, modulePath: m.modulePath, className: m.className };
  });
  const byId = new Map(members.map((m) => [m.moduleId, m]));
  const missing = combination.declaredOrder.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new ExperimentError('INVALID_INPUT', `declared combination order names unknown member(s): ${missing.join(', ')}`);
  }
  const shape = members[0].expectedShape;
  // The build order comes from the declaration. A deliberate conflict is expressed by the HOST
  // passing a different `buildOrderOverride`, exactly as with the other probe jobs.
  const buildOrder =
    combination.buildOrderOverride ?? combination.declaredOrder.map((id) => memberSpecs.findIndex((m) => m.id === id));

  return {
    schemaVersion: 1,
    probeId: `${profile.profileRef}:combination:${combination.id}`,
    toleranceRef: `${profile.profileRef}#tolerances-v${profile.version}`,
    jobs: [
      {
        jobKey: combination.id,
        job: {
          jobType: 'combination',
          id: combination.id,
          members: memberSpecs,
          buildOrder,
          stackPath: 'fixtures/phase2-probe/stack_fixture.py',
          batchSize: shapeAt(shape, 0, 4),
          channels: shapeAt(shape, 1, 8),
          height: shapeAt(shape, 2, 16),
          width: shapeAt(shape, 3, 16),
          steps: 2,
          lr: 0.01,
          seed: 20260929,
        },
      },
    ],
  };
}

/** Runs the real combination probe: an ordered stack trained for the declared steps. */
export function runCombinationProbe(options: CombinationProbeOptions): ProbeRun {
  return invokeProbe({
    profile: options.profile,
    spec: buildCombinationProbeSpec(options.profile, options.combination, options.members),
    ...(options.pythonPath !== undefined ? { pythonPath: options.pythonPath } : {}),
    ...(options.repoRoot !== undefined ? { repoRoot: options.repoRoot } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface EvaluateMechanismInput {
  profile: MechanismCheckProfile;
  declared: DeclaredMechanism;
  probe: ProbeRun;
  subjectRef: ArtifactRef;
}

export interface MechanismEvaluation {
  outcomes: CheckOutcome[];
  job: Record<string, unknown> | null;
  /** Why the job is unusable, when it is. */
  jobFailure: { status: CheckStatus; reason: string } | null;
}

function classifyJobError(error: string): { status: CheckStatus; reason: string } {
  const missingFixture = /^(FileNotFoundError|ImportError|AttributeError|ModuleNotFoundError)/.test(error);
  if (missingFixture) {
    return { status: 'blocked', reason: `capability missing: the probe could not load the fixture (${error})` };
  }
  return { status: 'failed', reason: `the code under test raised during the probe (${error})` };
}

/**
 * The wire id of a check. The frozen `validateCheckReport` requires ids to be unique across the
 * whole report, and one report covers several modules, so the module id namespaces the rule id:
 * `<moduleId>::<ruleId>`. The rule id stays the mechanism-level identity and is what the profile's
 * `requiredRules` names.
 */
export function checkIdFor(moduleId: string, ruleId: string): string {
  return `${moduleId}::${ruleId}`;
}

function specFor(profile: MechanismCheckProfile, declared: DeclaredMechanism, rule: MechanismRule): CheckSpec {
  const tolerance = toleranceById(profile, rule.toleranceId);
  return {
    id: checkIdFor(declared.moduleId, rule.id),
    mechanismKind: declared.mechanismKind,
    title: rule.title,
    fixtureRef: `${declared.probeJob}:${declared.modulePath}#${declared.className}`,
    expected: rule.title,
    tolerance: `${tolerance.dtype}: ${tolerance.rationale}`,
    required: true,
    measurementRefs: rule.measurementRefs,
  };
}

/**
 * Reads one module's probe job out of the probe result.
 *
 * The probe keys every job by the module id the engine declared, so a two-module run yields two
 * independent measurements and neither can be attributed to the other.
 */
export function jobFor(probe: ProbeRun, jobKey: string): Record<string, unknown> | undefined {
  if (!probe.result) return undefined;
  const jobs = probe.result.jobs;
  if (jobs && typeof jobs === 'object' && !Array.isArray(jobs)) {
    const found = (jobs as Record<string, unknown>)[jobKey];
    if (found && typeof found === 'object') return found as Record<string, unknown>;
    return undefined;
  }
  // Single-job probe result: only unambiguous when the spec asked for exactly one job.
  if (probe.spec.jobs.length === 1) {
    const only = probe.spec.jobs[0].job.jobType;
    const found = probe.result[only as string];
    if (found && typeof found === 'object') return found as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Evaluates every required rule for one declared mechanism.
 *
 * A rule that has no measurement to read returns `blocked`; a rule that read a non-finite value
 * returns `failed`. Both are decided from the probe JSON, never from a model.
 */
export function evaluateMechanism(input: EvaluateMechanismInput): MechanismEvaluation {
  const { profile, declared, probe } = input;
  const rules = MECHANISM_RULES[declared.mechanismKind];
  const requiredIds = profile.requiredRules[declared.mechanismKind] ?? [];
  if (requiredIds.length === 0) {
    throw new ExperimentError(
      'UNSUPPORTED_CAPABILITY',
      `profile "${profile.profileRef}" declares no required rule for mechanism kind "${declared.mechanismKind}"; a mechanism with no required check must be blocked, not passed`
    );
  }

  const outcomes: CheckOutcome[] = [];
  const job = jobFor(probe, declared.moduleId);

  const emitBlocked = (rule: MechanismRule, reason: string) => {
    outcomes.push({
      spec: specFor(profile, declared, rule),
      status: 'blocked',
      observed: `${declared.probeJob}=<no measurement>`,
      rationale: reason,
      evidence: [],
    });
  };

  if (!job || typeof job !== 'object') {
    const reason = probe.failure
      ? `capability missing: ${probe.failure}`
      : `capability missing: the probe reported no "${declared.probeJob}" job for module "${declared.moduleId}"`;
    for (const id of requiredIds) {
      const rule = rules.find((r) => r.id === id);
      if (rule) emitBlocked(rule, reason);
    }
    return { outcomes, job: null, jobFailure: { status: 'blocked', reason } };
  }

  const jobError = job.error;
  if (typeof jobError === 'string' && jobError.length > 0) {
    const classified = classifyJobError(jobError);
    for (const id of requiredIds) {
      const rule = rules.find((r) => r.id === id);
      if (!rule) continue;
      outcomes.push({
        spec: specFor(profile, declared, rule),
        status: classified.status,
        observed: `job.error=${jobError}`,
        rationale: classified.reason,
        evidence:
          classified.status === 'blocked'
            ? []
            : [{ id: `${checkIdFor(declared.moduleId, rule.id)}:job-error`, content: evidenceText({ moduleId: declared.moduleId, error: jobError }) }],
      });
    }
    return { outcomes, job, jobFailure: classified };
  }

  for (const id of requiredIds) {
    const rule = rules.find((r) => r.id === id);
    if (!rule) {
      throw new ExperimentError(
        'UNSUPPORTED_CAPABILITY',
        `profile "${profile.profileRef}" requires rule "${id}" for kind "${declared.mechanismKind}" but the engine has no implementation for it`
      );
    }
    const tolerance = toleranceById(profile, rule.toleranceId);
    const verdict = rule.evaluate({
      job,
      declared,
      tolerance,
      toleranceFor: (tid: string) => toleranceById(profile, tid),
    });
    const evidenceKeys = rule.measurementRefs.filter((key) => key in job);
    outcomes.push({
      spec: specFor(profile, declared, rule),
      status: verdict.status,
      observed: verdict.observed,
      rationale: verdict.rationale,
      evidence:
        verdict.status === 'blocked'
          ? []
          : [
              {
                id: `${checkIdFor(declared.moduleId, rule.id)}:evidence`,
                content: evidenceText({
                  moduleId: declared.moduleId,
                  mechanismKind: declared.mechanismKind,
                  probeJob: declared.probeJob,
                  executor: profile.executorRef,
                  measurementRefs: rule.measurementRefs,
                  measurements: Object.fromEntries(evidenceKeys.map((key) => [key, job[key]])),
                  observed: verdict.observed,
                  status: verdict.status,
                }),
              },
            ],
    });
  }

  return { outcomes, job, jobFailure: null };
}

/** Evaluates the combination rules against real per-module reports and a real combination run. */
export function evaluateCombination(
  profile: MechanismCheckProfile,
  input: CombinationInput
): CheckOutcome[] {
  const requiredIds = profile.requiredRules.combination ?? [];
  if (requiredIds.length === 0) {
    throw new ExperimentError('UNSUPPORTED_CAPABILITY', 'the profile declares no required combination rule');
  }
  const outcomes: CheckOutcome[] = [];
  for (const id of requiredIds) {
    const rule = COMBINATION_RULES.find((r) => r.id === id);
    if (!rule) {
      throw new ExperimentError('UNSUPPORTED_CAPABILITY', `the engine has no implementation for combination rule "${id}"`);
    }
    const tolerance = toleranceById(profile, rule.toleranceId);
    const verdict = rule.evaluate(input, tolerance);
    const spec: CheckSpec = {
      id: checkIdFor(`combination:${input.id}`, rule.id),
      mechanismKind: 'combination',
      title: rule.title,
      fixtureRef: `combination:${input.id}`,
      expected: rule.title,
      tolerance: `${tolerance.dtype}: ${tolerance.rationale}`,
      required: true,
      measurementRefs: rule.measurementRefs,
    };
    outcomes.push({
      spec,
      status: verdict.status,
      observed: verdict.observed,
      rationale: verdict.rationale,
      evidence:
        verdict.status === 'blocked'
          ? []
          : [
              {
                id: `${checkIdFor(`combination:${input.id}`, rule.id)}:evidence`,
                content: evidenceText({
                  combinationId: input.id,
                  declaredOrder: input.declaredOrder,
                  executor: profile.executorRef,
                  observed: verdict.observed,
                  status: verdict.status,
                }),
              },
            ],
    });
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// Top-level entry point
// ---------------------------------------------------------------------------

export interface MechanismCheckRequest {
  profile: MechanismCheckProfile;
  subjectRef: ArtifactRef;
  declared: DeclaredMechanism[];
  /** Optional: a combination assessed on top of the per-module checks. */
  combination?: CombinationInput;
  pythonPath?: string;
  repoRoot?: string;
  timeoutMs?: number;
  /** A probe run to reuse (the tests use this to feed a REAL run through the engine). */
  probe?: ProbeRun;
  /** A combination probe run to reuse, for the same reason. */
  combinationProbe?: ProbeRun;
}

export interface MechanismCheckResult {
  report: CheckReport;
  probe: ProbeRun;
  evaluations: MechanismEvaluation[];
  combinationOutcomes: CheckOutcome[];
  combinationProbe: ProbeRun | null;
}

/**
 * The engine entry point: run the real probe, evaluate every required rule, and publish a frozen
 * `CheckReport`. Every mechanism assertion is `required: true`.
 */
export function runMechanismChecks(request: MechanismCheckRequest): MechanismCheckResult {
  const { profile, declared } = request;
  if (declared.length === 0) {
    throw new ExperimentError('INVALID_INPUT', 'no declared mechanism was supplied; nothing can be checked');
  }
  for (const mechanism of declared) {
    if (!MECHANISM_KINDS.includes(mechanism.mechanismKind)) {
      throw new ExperimentError('UNSUPPORTED_CAPABILITY', `unknown mechanism kind "${mechanism.mechanismKind}"`);
    }
    if (mechanism.mechanismKind === 'combination') {
      throw new ExperimentError(
        'INVALID_INPUT',
        'a combination is assessed through `combination`, not as a per-module declared mechanism'
      );
    }
  }

  const probe =
    request.probe ??
    runMechanismProbe({
      profile,
      declared,
      ...(request.pythonPath !== undefined ? { pythonPath: request.pythonPath } : {}),
      ...(request.repoRoot !== undefined ? { repoRoot: request.repoRoot } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    });

  const evaluations = declared.map((mechanism) =>
    evaluateMechanism({ profile, declared: mechanism, probe, subjectRef: request.subjectRef })
  );

  let combinationProbe: ProbeRun | null = null;
  let combinationInput = request.combination;
  if (combinationInput) {
    // The combination is measured by a REAL run of its own. Per-module reports are an input to the
    // combination check, never a substitute for it.
    if (!combinationInput.combinationProbeJob) {
      const unknown = combinationInput.declaredOrder.filter((id) => !declared.some((m) => m.moduleId === id));
      if (unknown.length > 0) {
        throw new ExperimentError(
          'INVALID_INPUT',
          `combination declares member(s) with no mechanism declaration: ${unknown.join(', ')}`
        );
      }
      const members = declared.filter((m) => combinationInput!.declaredOrder.includes(m.moduleId));
      combinationProbe =
        request.combinationProbe ??
        runCombinationProbe({
          profile,
          combination: combinationInput,
          members,
          ...(request.pythonPath !== undefined ? { pythonPath: request.pythonPath } : {}),
          ...(request.repoRoot !== undefined ? { repoRoot: request.repoRoot } : {}),
          ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        });
      const job = combinationProbe.result
        ? jobFor(combinationProbe, combinationInput.id)
        : undefined;
      combinationInput = {
        ...combinationInput,
        combinationProbeJob:
          job ?? { id: combinationInput.id, error: combinationProbe.failure ?? 'the combination probe produced no result' },
      };
    }
  }
  const combinationOutcomes = combinationInput ? evaluateCombination(profile, combinationInput) : [];

  const outcomes = [...evaluations.flatMap((e) => e.outcomes), ...combinationOutcomes];

  // The probe ref binds the report to ONE real run. Wall-clock durations are deliberately excluded:
  // they are execution facts, not semantics, and hashing them would make two identical runs produce
  // different reports. What is hashed is the identity of the run and its measurements.
  const { durationsMs: _timing, ...measuredResult } = (probe.result ?? {}) as Record<string, unknown>;
  const probeRef = artifactRefFor(
    `probe-run:${probe.spec.probeId}`,
    evidenceText({
      probeId: probe.spec.probeId,
      executor: profile.executorRef,
      probeScript: profile.probeScript,
      exitCode: probe.exitCode,
      ok: probe.ok,
      failure: probe.failure,
      spec: probe.spec,
      result: measuredResult,
    })
  );

  const report = buildCheckReport({
    subjectRef: request.subjectRef,
    profileRef: profile.profileRef,
    probeRef,
    outcomes,
  });

  return { report, probe, evaluations, combinationOutcomes, combinationProbe };
}

export { COMBINATION_RULES };
