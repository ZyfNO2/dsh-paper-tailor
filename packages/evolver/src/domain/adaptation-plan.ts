/**
 * Adaptation Planner: turns a pinned SourceBundle + TaskProfile + frozen constraints into an
 * AdaptationPlan, or reports explicitly why the plan is BLOCKED.
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md sections 1, 2 and 3.
 *   - "未知 binding 明确 blocked" — an unknown slot is never silently coerced onto an existing one.
 *   - "不从 interventionAxis 标签直接推导可插入位置" — a P6 axis label is provenance only. It can
 *     never choose or create a slot; planning without an explicit profile slot is blocked.
 *   - "allowedPaths 非空；同一路径不得既允许又禁止" — enforced here and again by the frozen
 *     `validateAdaptationPlan`.
 *   - "机制检查规则由宿主 profile 提供，不能由待测补丁自改" — the checks and the path policy are
 *     declared by the host, never read from the candidate or the patch.
 *
 * `blocked` is a RESULT, not an exception: the caller needs the reason and the rejected bindings in
 * order to report them. Only structurally impossible input throws.
 */

import {
  ExperimentError,
  validateAdaptationPlan,
  validateTaskProfile,
  computeAdaptationPlanHash,
  adaptationPlanBody,
  expNoExtraKeys,
  expAssertArray,
  expAssertId,
  expAssertFinite,
  PATCH_PROVIDERS,
  type AdaptationPlan,
  type ArtifactRef,
  type PlanBinding,
  type PatchProvider,
  type TaskProfile,
  type SourceBundle,
} from '../contracts/experiments.ts';
import { INTERVENTION_AXES } from '../contracts/research.ts';

// ----------------- Fixed policy -----------------

/**
 * Baseline paths that are always forbidden on top of what a plan declares. The evaluator, the
 * held-out test split, the sealed gold data, the budget and the isolation policy are never
 * adaptation surface, and no plan may re-allow them.
 *
 * Which MECHANISM KINDS may occupy a slot is deliberately NOT restated here: that is the host
 * profile's `SlotContract.allowedModuleKinds`, and a second copy in this module would be a
 * competing source of truth that could silently drift from the profile it is meant to enforce.
 */
export const DEFAULT_FORBIDDEN_PATHS: readonly string[] = Object.freeze([
  'evaluator',
  'evaluator/**',
  '**/evaluator',
  '**/evaluator/**',
  'data/sealed/**',
  '**/gold/**',
  '**/test/**',
  '**/tests/**',
  'budget.json',
  'isolation/**',
  '.git/**',
]);

/** Explicit, machine-readable reasons a plan is not produced. */
export type PlanBlockReason =
  | 'INCOMPATIBLE_BINDING'
  | 'POLICY_DENIED'
  | 'CONFIG_INCOMPLETE'
  | 'SOURCE_MISMATCH'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_INPUT';

export interface BlockedBinding {
  slotId: string;
  reason: string;
}

export interface PlanningConstraints {
  /** Non-empty. The only paths a patch may touch. */
  allowedPaths: string[];
  forbiddenPaths?: string[];
  /** Trusted host reference for the dependency policy. Required. */
  dependencyPolicyRef: string;
  /** Check ids selected by the host profile. Required and non-empty. */
  mechanismChecks: string[];
  /** Hard stop for repair rounds. Defaults to 0: exactly one submission, no retry. */
  maxRepairAttempts?: number;
}

export interface AdaptationPlanRequest {
  taskId: string;
  sourceBundleRef: ArtifactRef;
  profile: TaskProfile;
  constraints: PlanningConstraints;
  /**
   * The caller's proposed bindings. Each `slotId` must exist in the profile and each module id
   * must be a pinned module source. Anything else is reported blocked.
   */
  bindings: PlanBinding[];
  patchProvider?: PatchProvider;
  /**
   * Provenance only. A P6 `interventionAxis` label explains why a candidate was proposed; it is
   * never a slot and never a position. Supplying it alone is a blocked plan.
   */
  interventionAxis?: string | null;
}

export interface AdaptationPlanProvenance {
  interventionAxis: string | null;
  /** Always false: recorded so a reviewer can see the axis was not used to place anything. */
  usedForPosition: false;
  notes: string[];
}

export interface PlannedAdaptationPlan {
  status: 'planned';
  taskId: string;
  plan: AdaptationPlan;
  bindings: PlanBinding[];
  provenance: AdaptationPlanProvenance;
}

export interface BlockedAdaptationPlan {
  status: 'blocked';
  taskId: string;
  code: PlanBlockReason;
  message: string;
  fieldPaths: string[];
  /** Every binding the caller asked for, kept so the caller can show what was refused. */
  bindings: PlanBinding[];
  blockedBindings: BlockedBinding[];
  provenance: AdaptationPlanProvenance;
}

export type AdaptationPlanOutcome = PlannedAdaptationPlan | BlockedAdaptationPlan;

// ----------------- Helpers -----------------

const PLAN_REQUEST_KEYS = [
  'taskId',
  'sourceBundleRef',
  'profile',
  'constraints',
  'bindings',
  'patchProvider',
  'interventionAxis',
] as const;
const CONSTRAINTS_KEYS = [
  'allowedPaths',
  'forbiddenPaths',
  'dependencyPolicyRef',
  'mechanismChecks',
  'maxRepairAttempts',
] as const;

function artifactRef(raw: unknown, fieldPath: string): ArtifactRef {
  const o = expNoExtraKeys(raw, ['id', 'sha256'], fieldPath);
  return {
    id: expAssertId(o.id, `${fieldPath}.id`),
    sha256: expAssertId(o.sha256, `${fieldPath}.sha256`),
  };
}

function isAxisToken(value: string): boolean {
  return (INTERVENTION_AXES as readonly string[]).includes(value);
}

function blocked(
  taskId: string,
  code: PlanBlockReason,
  message: string,
  fieldPaths: string[],
  bindings: PlanBinding[],
  blockedBindings: BlockedBinding[],
  provenance: AdaptationPlanProvenance
): BlockedAdaptationPlan {
  return { status: 'blocked', taskId, code, message, fieldPaths, bindings, blockedBindings, provenance };
}

function provenanceFor(interventionAxis: string | null, notes: string[]): AdaptationPlanProvenance {
  return { interventionAxis, usedForPosition: false, notes };
}

// ----------------- Post-hoc axis guard -----------------

/**
 * Re-asserts, on an already-built plan, that no insertable position came from a P6 axis label.
 *
 * An `AdaptationPlan` has no field for an axis label (the frozen schema rejects unknown keys), so
 * the only way an axis could leak into placement is through a slot id or a config reference. Both
 * are checked: slot ids must be profile-owned, and no config reference may carry an axis token.
 */
export function assertNoAxisDerivedPosition(plan: AdaptationPlan, profile: TaskProfile): void {
  const slotIds = new Set(profile.slots.map((slot) => slot.slotId));
  for (const [index, binding] of plan.bindings.entries()) {
    if (!slotIds.has(binding.slotId)) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `bindings[${index}].slotId "${binding.slotId}" is not a slot of profile "${profile.id}"`,
        { fieldPaths: [`bindings[${index}].slotId`] }
      );
    }
    if (isAxisToken(binding.slotId)) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `bindings[${index}].slotId is a P6 interventionAxis label, not a profile slot: "${binding.slotId}"`,
        { fieldPaths: [`bindings[${index}].slotId`] }
      );
    }
    for (const token of binding.configRef.split(/[^A-Za-z0-9_]+/)) {
      if (isAxisToken(token)) {
        throw new ExperimentError(
          'INCOMPATIBLE_BINDING',
          `bindings[${index}].configRef is derived from an interventionAxis label: "${binding.configRef}"`,
          { fieldPaths: [`bindings[${index}].configRef`] }
        );
      }
    }
  }
}

// ----------------- Planning -----------------

/**
 * Builds an AdaptationPlan, or reports `blocked` with a machine-readable reason.
 *
 * Nothing here reads the candidate's code, runs a model, or touches the filesystem: planning is a
 * pure function of pinned sources, the host profile and frozen constraints.
 */
export function buildAdaptationPlan(
  bundle: SourceBundle,
  request: AdaptationPlanRequest
): AdaptationPlanOutcome {
  const o = expNoExtraKeys(request, PLAN_REQUEST_KEYS, 'AdaptationPlanRequest');
  const taskId = expAssertId(o.taskId, 'AdaptationPlanRequest.taskId');
  const sourceBundleRef = artifactRef(o.sourceBundleRef, 'AdaptationPlanRequest.sourceBundleRef');
  const profile = validateTaskProfile(o.profile, 'AdaptationPlanRequest.profile');
  const rawBindings = expAssertArray(o.bindings, 'AdaptationPlanRequest.bindings');
  const requestedBindings: PlanBinding[] = rawBindings.map((raw, index) => {
    const b = expNoExtraKeys(raw, ['slotId', 'orderedModuleIds', 'configRef'], `AdaptationPlanRequest.bindings[${index}]`);
    return {
      slotId: expAssertId(b.slotId, `AdaptationPlanRequest.bindings[${index}].slotId`),
      orderedModuleIds: expAssertArray(b.orderedModuleIds, `AdaptationPlanRequest.bindings[${index}].orderedModuleIds`).map(
        (id, j) => expAssertId(id, `AdaptationPlanRequest.bindings[${index}].orderedModuleIds[${j}]`)
      ),
      configRef: expAssertId(b.configRef, `AdaptationPlanRequest.bindings[${index}].configRef`),
    };
  });

  let interventionAxis: string | null = null;
  if (o.interventionAxis !== undefined && o.interventionAxis !== null) {
    interventionAxis = expAssertId(o.interventionAxis, 'AdaptationPlanRequest.interventionAxis');
  }
  const notes: string[] = [];
  if (interventionAxis !== null) {
    notes.push(
      `interventionAxis "${interventionAxis}" was recorded as provenance only; it did not select a slot or a position.`
    );
  }
  const provenance = provenanceFor(interventionAxis, notes);

  // (1) The bundle ref must describe the bundle that was actually pinned.
  if (sourceBundleRef.sha256 !== bundle.sourceBundleHash) {
    return blocked(
      taskId,
      'SOURCE_MISMATCH',
      `sourceBundleRef.sha256 ${sourceBundleRef.sha256.slice(0, 12)}... does not match the pinned SourceBundle ${bundle.sourceBundleHash.slice(0, 12)}...`,
      ['sourceBundleRef.sha256'],
      requestedBindings,
      [],
      provenance
    );
  }

  // (2) An axis label is not a slot. Without an explicit profile slot there is nothing to plan.
  if (requestedBindings.length === 0) {
    if (interventionAxis !== null) {
      return blocked(
        taskId,
        'INCOMPATIBLE_BINDING',
        `interventionAxis "${interventionAxis}" is a P6 label, not a profile slot; an insertable position requires an explicit slotId from profile "${profile.id}"`,
        ['interventionAxis'],
        requestedBindings,
        [{ slotId: interventionAxis, reason: 'interventionAxis labels never resolve to a slot' }],
        provenance
      );
    }
    return blocked(
      taskId,
      'INCOMPATIBLE_BINDING',
      'at least one binding is required; the planner never invents a slot',
      ['bindings'],
      requestedBindings,
      [],
      provenance
    );
  }

  // (3) Constraints must be frozen and complete, or the dependent work is blocked.
  const constraintsRaw = expNoExtraKeys(o.constraints, CONSTRAINTS_KEYS, 'AdaptationPlanRequest.constraints');
  const allowedPaths = expAssertArray(constraintsRaw.allowedPaths, 'AdaptationPlanRequest.constraints.allowedPaths').map(
    (p, i) => expAssertId(p, `AdaptationPlanRequest.constraints.allowedPaths[${i}]`)
  );
  const declaredForbidden =
    constraintsRaw.forbiddenPaths === undefined
      ? []
      : expAssertArray(constraintsRaw.forbiddenPaths, 'AdaptationPlanRequest.constraints.forbiddenPaths').map((p, i) =>
          expAssertId(p, `AdaptationPlanRequest.constraints.forbiddenPaths[${i}]`)
        );
  const forbiddenPaths = Array.from(new Set([...declaredForbidden, ...DEFAULT_FORBIDDEN_PATHS]));
  const mechanismChecks = expAssertArray(
    constraintsRaw.mechanismChecks,
    'AdaptationPlanRequest.constraints.mechanismChecks'
  ).map((c, i) => expAssertId(c, `AdaptationPlanRequest.constraints.mechanismChecks[${i}]`));

  if (allowedPaths.length === 0) {
    return blocked(
      taskId,
      'CONFIG_INCOMPLETE',
      'constraints.allowedPaths is empty: nothing may be adapted, so no plan can be produced',
      ['constraints.allowedPaths'],
      requestedBindings,
      [],
      provenance
    );
  }
  if (mechanismChecks.length === 0) {
    return blocked(
      taskId,
      'CONFIG_INCOMPLETE',
      'constraints.mechanismChecks is empty: a plan without declared checks could not be validated',
      ['constraints.mechanismChecks'],
      requestedBindings,
      [],
      provenance
    );
  }
  if (constraintsRaw.dependencyPolicyRef === undefined) {
    return blocked(
      taskId,
      'CONFIG_INCOMPLETE',
      'constraints.dependencyPolicyRef is unset in the frozen configuration table',
      ['constraints.dependencyPolicyRef'],
      requestedBindings,
      [],
      provenance
    );
  }
  const dependencyPolicyRef = expAssertId(
    constraintsRaw.dependencyPolicyRef,
    'AdaptationPlanRequest.constraints.dependencyPolicyRef'
  );

  const overlap = allowedPaths.filter((p) => forbiddenPaths.includes(p));
  if (overlap.length > 0) {
    return blocked(
      taskId,
      'POLICY_DENIED',
      `path "${overlap[0]}" is both allowed and forbidden; the policy must be unambiguous`,
      ['constraints.forbiddenPaths'],
      requestedBindings,
      [],
      provenance
    );
  }

  let patchProvider: PatchProvider = 'human';
  if (o.patchProvider !== undefined) {
    const candidate = expAssertId(o.patchProvider, 'AdaptationPlanRequest.patchProvider');
    if (!(PATCH_PROVIDERS as readonly string[]).includes(candidate)) {
      return blocked(
        taskId,
        'INVALID_INPUT',
        `patchProvider must be one of ${PATCH_PROVIDERS.join('|')}, got "${candidate}"`,
        ['patchProvider'],
        requestedBindings,
        [],
        provenance
      );
    }
    patchProvider = candidate as PatchProvider;
  }

  const maxRepairAttempts =
    constraintsRaw.maxRepairAttempts === undefined
      ? 0
      : expAssertFinite(constraintsRaw.maxRepairAttempts, 'AdaptationPlanRequest.constraints.maxRepairAttempts', 0, 100);

  // (4) Every requested binding must resolve to a real slot and to pinned module sources.
  const profileSlots = new Map(profile.slots.map((slot) => [slot.slotId, slot]));
  const moduleIds = new Set(bundle.modules.map((module) => module.id));
  const blockedBindings: BlockedBinding[] = [];
  for (const binding of requestedBindings) {
    const slot = profileSlots.get(binding.slotId);
    if (!slot) {
      blockedBindings.push({
        slotId: binding.slotId,
        reason: isAxisToken(binding.slotId)
          ? 'slotId is a P6 interventionAxis label, not a slot of this profile'
          : `slot is not declared by profile "${profile.id}"`,
      });
      continue;
    }
    if (binding.orderedModuleIds.length > profile.maxModules) {
      blockedBindings.push({
        slotId: binding.slotId,
        reason: `binding has ${binding.orderedModuleIds.length} modules but profile "${profile.id}" supports at most ${profile.maxModules}`,
      });
      continue;
    }
    if (new Set(binding.orderedModuleIds).size !== binding.orderedModuleIds.length) {
      blockedBindings.push({ slotId: binding.slotId, reason: 'duplicate module id inside one binding' });
      continue;
    }
    const unknownModules = binding.orderedModuleIds.filter((id) => !moduleIds.has(id));
    if (unknownModules.length > 0) {
      blockedBindings.push({
        slotId: binding.slotId,
        reason: `module id not pinned by the SourceBundle: ${unknownModules.join(', ')}`,
      });
      continue;
    }
    if (slot.allowedModuleKinds.length === 0) {
      blockedBindings.push({ slotId: binding.slotId, reason: 'slot declares no allowedModuleKinds' });
      continue;
    }
    for (const token of binding.configRef.split(/[^A-Za-z0-9_]+/)) {
      if (isAxisToken(token)) {
        blockedBindings.push({
          slotId: binding.slotId,
          reason: `configRef is derived from an interventionAxis label: "${binding.configRef}"`,
        });
        break;
      }
    }
  }
  const slotIds = requestedBindings.map((binding) => binding.slotId);
  if (new Set(slotIds).size !== slotIds.length) {
    for (const slotId of slotIds) {
      if (slotIds.filter((id) => id === slotId).length > 1 && !blockedBindings.some((b) => b.slotId === slotId)) {
        blockedBindings.push({ slotId, reason: 'one binding per slot is allowed' });
      }
    }
  }
  if (blockedBindings.length > 0) {
    return blocked(
      taskId,
      'INCOMPATIBLE_BINDING',
      `binding refused: ${blockedBindings.map((b) => `${b.slotId} (${b.reason})`).join('; ')}`,
      blockedBindings.map((b) => `bindings[${b.slotId}]`),
      requestedBindings,
      blockedBindings,
      provenance
    );
  }

  // (5) Assemble the frozen plan shape and let the contract validate + hash it.
  const plan: AdaptationPlan = {
    sourceBundleRef,
    profileRef: `${profile.id}@${profile.version}`,
    bindings: requestedBindings.map((binding) => ({ ...binding, orderedModuleIds: [...binding.orderedModuleIds] })),
    allowedPaths: [...allowedPaths],
    forbiddenPaths: [...forbiddenPaths],
    dependencyPolicyRef,
    mechanismChecks: [...mechanismChecks],
    patchProvider,
    maxRepairAttempts,
    planHash: '',
  };
  plan.planHash = computeAdaptationPlanHash(adaptationPlanBody(plan));
  const validated = validateAdaptationPlan(plan, 'AdaptationPlan');
  assertNoAxisDerivedPosition(validated, profile);

  return { status: 'planned', taskId, plan: validated, bindings: validated.bindings, provenance };
}

/** Content-addressed handle for a planned adaptation. */
export function adaptationPlanRef(plan: AdaptationPlan, taskId: string): ArtifactRef {
  return { id: `adaptation-plan-${taskId}`, sha256: plan.planHash };
}

/**
 * Cheap guard for the execution service: the plan it is about to use must be the one the caller
 * asked for. `patchProvider` is part of the check because a human patch may not be replaced by an
 * agent-generated one (or the reverse) without a new plan.
 */
export function assertPlanMatchesRequest(
  plan: AdaptationPlan,
  expected: { sourceBundleRef: ArtifactRef; profileRef: string; patchProvider: PatchProvider }
): void {
  const recomputed = computeAdaptationPlanHash(adaptationPlanBody(plan));
  if (recomputed !== plan.planHash) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'planHash does not match the plan body', {
      fieldPaths: ['planHash'],
    });
  }
  if (plan.sourceBundleRef.sha256 !== expected.sourceBundleRef.sha256) {
    throw new ExperimentError('SOURCE_MISMATCH', 'plan was built for a different SourceBundle', {
      fieldPaths: ['sourceBundleRef'],
    });
  }
  if (plan.profileRef !== expected.profileRef) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', 'plan was built for a different profile', {
      fieldPaths: ['profileRef'],
    });
  }
  if (plan.patchProvider !== expected.patchProvider) {
    throw new ExperimentError('POLICY_DENIED', 'plan patchProvider does not match the request', {
      fieldPaths: ['patchProvider'],
    });
  }
}
