/**
 * Phase 2 experiment application service.
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md sections 1, 2 and 3.
 * Shared owner / idempotency / budget / publication rules: docs/mvp/RESEARCH-EXECUTION-ARCHITECTURE.md.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 * The seven-step chain of SPEC section 3, in that exact order:
 *
 *   resolveSources -> planAdaptation -> adaptImplementation -> validateImplementation
 *     -> runLightweight(smoke) -> registerImplementation -> runLightweight(tiny)
 *
 * Every step is one write method with the frozen signature
 * `(request: ExecutionRequest<Payload>, actor: Actor) => Promise<ExecutionReceipt>` — here it also
 * returns the published result, so a caller never has to guess an operation id. Every step is one
 * `ExecutionOperation` that goes accepted -> running -> succeeded/failed, and every step reads only
 * PUBLISHED artifacts of terminal operations: `readPublishedArtifact` refuses a staging path and
 * `awaitTerminalOperation` refuses a non-terminal dependency, so a staging path cannot cross a step
 * boundary even by accident.
 *
 * THE RULES, EACH WITH WHERE IT IS ENFORCED
 * -----------------------------------------
 *   R1  owner binding from the caller actor                    assertActor / assertTaskOwnership
 *   R2  idempotency on ownerSessionId+taskId+method+commandId  reserveOrReuse, checked BEFORE the
 *       same request hash -> the original receipt, even after the task revision advanced
 *   R3  a different payload under the same key                 reserveOrReuse -> IDEMPOTENCY_CONFLICT
 *   R4  expectedRevision CAS                                   assertRevision -> REVISION_CONFLICT
 *   R5  accepted -> running -> succeeded/failed                 createOperation / transition
 *   R6  every step waits for a terminal operation and reads a  awaitTerminalOperation +
 *       PUBLISHED artifact, never a staging path               readPublishedArtifact
 *   R7  human patchProvider requires a submitted patch          applyHumanPatch
 *   R8  agent patches only enter through PatchWorkspace, whose  applyAgentPatch +
 *       path policy is evaluated before the first write        assertAdaptedPathAllowed
 *   R9  a required check failure never reaches smoke            runLightweight('smoke') preflight:
 *       a non-'passed' validation report is refused before any operation is created
 *   R10 a smoke failure never registers ready                   assertSmokeAppliesToProtocol +
 *                                                               frozen assertRegistrationClosure
 *   R11 a tiny failure does not revoke the smoke facts          tiny is its own operation and its
 *       failure never writes to the smoke operation's published artifacts
 *   R12 smoke and registration re-check validation.subjectRef   assertValidationAppliesTo
 *       against the current implementation content, same
 *       profile, required checks passed
 *   R13 registration also checks the smoke subjectRef against  assertSmokeAppliesToProtocol
 *       the run protocol range
 *   R14 a changed patch invalidates the old reports             the implementation hash IS the
 *       identity, so a re-patched implementation has a different one and the old subjectRef stops
 *       matching (tests/integration/phase2-service.spec.mjs proves it)
 *   R15 code generation/repair cannot touch the evaluator, the  PatchWorkspace (whole-patch policy
 *       original sources, the budget, test data or forbidden    before any write) +
 *       paths                                                    assertAdaptedPathAllowed
 *   R16 no infinite self-repair: maxRepairAttempts is a hard    applyAgentPatch; the FIRST error is
 *       stop and the first error is kept                         kept by PatchWorkspace.firstError()
 *   R17 source checkout and patch workspace are separate dirs    createPatchWorkspace +
 *                                                               assertSeparateRoots
 *   R18 the check rules come from the host, never from a patch  assertPlanChecksAreHostRules +
 *       or a request                                             assertPatchCannotChangeCheckRules
 *   R19 a request may never choose an executable or a path       assertNoRequestSuppliedExecutable
 *   R20 every host-owned object a request names is identified    assertHostRef
 *       by the host's frozen hash
 *
 * DELIBERATE BOUNDARIES, STATED RATHER THAN HIDDEN
 * ----------------------------------------------
 *  1. The six contract methods are exactly `PHASE2_METHODS`. This service additionally exposes three
 *     HOST-SIDE helpers that are not in that list and are not one of the seven chain steps:
 *     `submitPatch` (human patch intake), `getExecutionOperation` and `stopExecutionOperation`
 *     (query/stop, which PHASE2-FREEZE-CHECKLIST row B11 still leaves as a design draft). None of
 *     them can publish a chain artifact.
 *  2. Host configuration (`configs/phase2/**`) is read by the host directly, exactly as
 *     `loadResolvedProfile` already does. The isolation policy's readableRoots govern what a RUN may
 *     read (paths handed to a child process), which is why `configs/phase2/execution-config.json` is
 *     on the policy's deny list: a patch must neither read nor modify it. Host configuration loading
 *     is not a run-side read; every RUN-side path this service reads is checked with
 *     `assertHostReadable`.
 *  3. The adapted module tree lives under `work/research-execution`, which the isolation policy lists
 *     as a WRITABLE root, not a readable one. That is the point of the patch workspace: the host
 *     deliberately hands the pinned runner the adapted copy. Containment is therefore enforced here:
 *     a derived module path must be inside the workspace root AND covered by the plan's allowedPaths
 *     AND not always-forbidden (`assertAdaptedPathAllowed`).
 *  4. `repoRoot` must equal the process working directory. `assertIsolationPolicy` resolves the
 *     policy's relative roots against `process.cwd()`, so a different cwd would silently check the
 *     wrong roots; the constructor refuses that instead of pretending containment holds.
 *  5. The frozen `EXPERIMENT_ERROR_CODES` has no CANCELLED code, so `stopExecutionOperation` records
 *     `HOST_BUSY` with an explicit message and lets the `status` field carry the real fact.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  EXECUTION_STATUSES,
  ExperimentError,
  PHASE2_METHODS,
  PHASE2_SEQUENCE,
  assertRegistrationClosure,
  assertSmokeProtocolShape,
  assertTinyPreconditions,
  computeExecutableHash,
  computeExperimentRequestHash,
  computeLightweightResultHash,
  expAssertArtifactRef,
  expAssertEnum,
  expAssertFinite,
  expAssertId,
  expNoExtraKeys,
  validateAdaptationPlan,
  validateCheckReport,
  validateExecutableSnapshot,
  validateImplementationSnapshot,
  validateLightweightProtocol,
  validateLightweightResult,
  validateMetricObservation,
  validateSourceBundle,
  type AdaptationPlan,
  type ArtifactRef,
  type CheckReport,
  type ExecutionError,
  type ExecutionOperation,
  type ExecutionReceipt,
  type ExecutionStatus,
  type ExecutableSnapshot,
  type ImplementationSnapshot,
  type LightweightMode,
  type LightweightProtocol,
  type LightweightResult,
  type MechanismKind,
  type MetricObservation,
  type PatchProvider,
  type PlanBinding,
  type ProposalLink,
  type SourceBundle,
} from '../contracts/experiments.ts';
import { assertStatusTransition, isTerminal, type ResearchOperationStatus } from '../contracts/research.ts';
import { typedHash, sha256Hex, canonicalJsonV1 } from '../domain/research-canonical.ts';
import {
  MECHANISM_CHECK_PROFILE_V1,
  allMechanismRuleIds,
  assertPatchCannotChangeCheckRules,
  computeMechanismCheckProfileHash,
  mechanismCheckProfileBody,
  runMechanismChecks,
  type CombinationInput,
  type DeclaredMechanism,
  type MechanismCheckProfile,
  type ProbeRun,
} from '../domain/mechanism-checks.ts';
import { summarizeCheckReport } from '../domain/check-report.ts';
import { RootBudgetLedger, type RootTrialReservation } from './research-budget.ts';
import {
  assertSeparateRoots,
  createPatchWorkspace,
  hashFileTree,
  isAlwaysForbidden,
  isPathCovered,
  treeHash,
  type FullDiffReport,
  type PatchWorkspace,
} from '../domain/patch-workspace.ts';
import { assertPlanMatchesRequest, buildAdaptationPlan } from '../domain/adaptation-plan.ts';
import { assertModeProtocolShape } from '../domain/lightweight-runner.ts';
import {
  assertResourceMonitorAvailable,
  assertIsolationPolicy,
  assertNoRequestSuppliedExecutable,
  collectRunArtifacts,
  loadResolvedProfile,
  materializeManifest,
  prepareRun,
  runPhase2CpuSegRunner,
  verifyRun,
  type PreparedRun,
  type ResolvedTaskProfile,
  type RunFacts,
  type VerifiedRun,
  type PinnedModule,
} from '../domain/task-profile.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Directory names the Phase 2 store owns INSIDE a storage root.
 *
 * Exported because more than one reader now has to tell "a task" apart from
 * "this store's own bookkeeping". A reader that only lists directories cannot:
 * on a real storage root the names `index`, `operations`, `owners`, `published`
 * and `submitted` sit next to `task-*`, so a naive listing offers the store's
 * internals as if they were research tasks.
 *
 * It is declared here, next to the code that CREATES these directories, so a
 * new bookkeeping directory cannot be added without this list being the obvious
 * place to update.
 */
export const EXPERIMENT_STORE_RESERVED_DIRS = ['operations', 'published', 'submitted', 'index', 'owners'] as const;

export interface ExperimentCallerActor {
  sessionId: string;
  agentId?: string;
}

/** The frozen request envelope of the shared architecture. */
export interface ExperimentRequestBase {
  commandId: string;
  taskId: string;
  expectedRevision: number;
  /** Names the host isolation policy. Its sha256 must be the host's frozen hash. */
  policyRef: ArtifactRef;
  /** Names the host budget policy. Its sha256 must be the host's frozen hash. */
  budgetRef: ArtifactRef;
}

export interface ResolveSourcesRequest extends ExperimentRequestBase {
  proposal: ProposalLink;
  /** Names the host-registered source manifest. A caller cannot point the host at a downloader. */
  sourceManifestRef: ArtifactRef;
  profileRef: string;
}

export interface PlanAdaptationRequest extends ExperimentRequestBase {
  sourceBundleRef: ArtifactRef;
  profileRef: string;
  /** Names the host-owned planning constraints (bindings, allowed/forbidden paths, checks). */
  constraintsRef: ArtifactRef;
  patchProvider: PatchProvider;
  /** Provenance only: a P6 axis label never selects a slot or a position. */
  interventionAxis?: string | null;
}

export interface AdaptImplementationRequest extends ExperimentRequestBase {
  planRef: ArtifactRef;
  /** Required when the plan declares patchProvider 'human'. */
  submittedPatchRef?: ArtifactRef;
}

export interface ValidateImplementationRequest extends ExperimentRequestBase {
  implementationRef: ArtifactRef;
  profileRef: string;
}

export interface RunLightweightRequest extends ExperimentRequestBase {
  mode: LightweightMode;
  /** smoke: the implementation. tiny: the registered executable. */
  subjectRef: ArtifactRef;
  runProtocolRef: ArtifactRef;
  /** Required for smoke; for tiny the executable's own validation report is used. */
  validationRef?: ArtifactRef;
}

export interface RegisterImplementationRequest extends ExperimentRequestBase {
  implementationRef: ArtifactRef;
  validationRef: ArtifactRef;
  smokeRef: ArtifactRef;
}

export interface SubmitPatchRequest extends ExperimentRequestBase {
  patchText: string;
  description?: string;
}

export interface Phase2ChainStepReceipt {
  step: string;
  method: string;
  commandId: string;
  operationId: string | null;
  status: ExecutionStatus;
  resultRef: ArtifactRef | null;
  error: ExecutionError | null;
}

export interface Phase2ChainOutcome {
  taskId: string;
  steps: Phase2ChainStepReceipt[];
  completedSteps: string[];
  stoppedAt: string | null;
  /** Present once the step published. Kept even when a LATER step failed (the tiny failure rule). */
  sourceBundleRef: ArtifactRef | null;
  planRef: ArtifactRef | null;
  implementationRef: ArtifactRef | null;
  validationRef: ArtifactRef | null;
  smokeRef: ArtifactRef | null;
  executableRef: ArtifactRef | null;
  tinyRef: ArtifactRef | null;
  firstError: ExecutionError | null;
}

export interface ExperimentOutcome<T> {
  receipt: ExecutionReceipt;
  operation: ExecutionOperation;
  result?: T;
}

export interface Phase2ChainRequest extends ExperimentRequestBase {
  proposal: ProposalLink;
  sourceManifestRef: ArtifactRef;
  profileRef: string;
  constraintsRef: ArtifactRef;
  patchProvider: PatchProvider;
  submittedPatchRef?: ArtifactRef;
  runProtocolRefs: { smoke: ArtifactRef; tiny: ArtifactRef };
  commandIds: Record<string, string>;
  interventionAxis?: string | null;
}

// ---------------------------------------------------------------------------
// Host-owned configuration
// ---------------------------------------------------------------------------

/**
 * Host-owned planning constraints. SPEC section 3 has the request carry a `constraintsRef`, not the
 * constraints themselves, so a caller can neither invent an allowed path nor choose which module
 * sits in which slot: the bindings are part of "the task's inputs" and are host-owned too.
 *
 * `allowedPaths` and `forbiddenPaths` are WORKSPACE-RELATIVE, which is what `PatchWorkspace` and the
 * frozen `AdaptationPlan` already mean by them.
 */
export interface HostPlanningConstraints {
  id: string;
  bindings: PlanBinding[];
  allowedPaths: string[];
  forbiddenPaths?: string[];
  dependencyPolicyRef: string;
  mechanismChecks: string[];
  maxRepairAttempts?: number;
  /**
   * Maps a `SourceBundle.modules[].id` (what a binding names, and what the frozen planner checks the
   * binding against) to a `ProfileRegistryEntry.pinnedModules[].id` (what `compileRecipe` resolves).
   *
   * The two vocabularies are owned by different host files — the source pack pins sources, the profile
   * registry pins runnable module sources — so the mapping between them is host configuration, not a
   * request field. An id with no entry maps to itself, and a mapping that points at an id the profile
   * does not pin is refused at load time.
   */
  moduleIdMap?: Record<string, string>;
  /** Declared forward passes the mechanism probe holds a parameterized module to. */
  mechanismSteps?: number;
  /** Per-module declaration overrides for kinds whose job needs more than id/class/shape. */
  mechanismDeclarations?: Record<string, Partial<DeclaredMechanism>>;
  /**
   * Required as soon as one binding carries two or more modules: per-module ready is not a
   * combination result, so the host must declare the composition facts the combination rules read.
   */
  combination?: {
    functions: Array<{ function: string; moduleIds: string[] }>;
    sharedState: Array<{ name: string; moduleIds: string[] }>;
    parameterSources: Array<{ owner: string; parameterCount: number }>;
  };
}

export interface HostProtocolEntry {
  id: string;
  body: LightweightProtocol;
}

/** Budget ceiling the host declares. `wallClockDeadline: null` means "no absolute deadline". */
export interface HostBudgetPolicy {
  wallClockDeadline: string | null;
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

export interface AgentPatchRequest {
  taskId: string;
  plan: AdaptationPlan;
  workspaceRoot: string;
  sourceRoot: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  /** 1-based submission index: 1 is the initial submission, 2+ are repairs. */
  attemptIndex: number;
  /** The recorded first error, or null on the first attempt. */
  previousError: { code: string; message: string } | null;
  /** Content hash of the workspace the patch must apply to, so a repair targets the real tree. */
  workspaceTreeHash: string;
}

export type AgentPatchProvider = (request: AgentPatchRequest) => string | Promise<string>;

export interface ExperimentServiceOptions {
  storageRoot: string;
  /** Where throwaway work copies and run output live. Must be inside an isolation writable root. */
  workRoot?: string;
  repoRoot?: string;
  hostId?: string;
  ownerStaleMs?: number;
  /** Host-owned planning constraints, published to callers as `constraintsRef`. */
  constraints: HostPlanningConstraints;
  /** Host-owned run protocols, published to callers as `runProtocolRef`. */
  protocols: { smoke: HostProtocolEntry; tiny: HostProtocolEntry };
  /** The pinned source checkout the patch workspace copies. Default: `fixtures/modules`. */
  sourceCheckout?: string;
  /** The host-registered source manifest. Default: the Phase 2 source pack. */
  sourceManifest?: { id: string; path: string };
  /**
   * Which SourceBundle inside that manifest this service consumes. Host-owned
   * (a request cannot name it); default `bundle` keeps Phase 2 on the manual
   * pack, and `researchBundle` is the Phase 3 research-bound variant over the
   * same pinned sources.
   */
  sourceBundleKey?: string;
  /** The frozen configuration table the budget row is read from. */
  executionConfigPath?: string;
  /** Host-owned per-attempt timeout override. It may only LOWER the profile's declared value. */
  runTimeoutMs?: number;
  /** Only used when a plan declares patchProvider 'agent'. */
  agentPatchProvider?: AgentPatchProvider;
  pythonPath?: string;
  /** Test seam: replace the profile loader. Never set on the live path. */
  profileLoader?: (options?: { repoRoot?: string }) => ResolvedTaskProfile;
  /** Test seam: replace the mechanism check engine. */
  mechanismCheckRunner?: typeof runMechanismChecks;
  /** Test seam: replace the run executor. */
  runExecutor?: (
    resolved: ResolvedTaskProfile,
    prepared: PreparedRun,
    manifestPath: string,
    /** Aborts the CHILD PROCESS (not just the descriptor) when it fires. */
    signal?: AbortSignal,
    resourceLimits?: { maxWorkingSetBytes: number; maxOutputBytes: number },
  ) => Promise<RunFacts>;
  /** Search-only root accounting. Ordinary Phase 2 and legacy Phase 3 paths omit it. */
  rootBudget?: { ledger: RootBudgetLedger; attemptId: string; device: string };
}

interface CommandIndexEntry {
  operationId: string;
  requestHash: string;
  ownerSessionId: string;
  method: string;
  taskId: string;
  receipt: ExecutionReceipt | null;
}

interface TaskRecord {
  taskId: string;
  ownerSessionId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface SubmittedPatchRecord {
  ref: ArtifactRef;
  ownerSessionId: string;
  taskId: string;
  description: string | null;
  submittedAt: string;
}

interface PublishedArtifactEntry {
  name: string;
  file: string;
  ref: ArtifactRef;
  contentSha256: string;
}

interface PublishedSidecar {
  operationId: string;
  taskId: string;
  primary: string;
  entries: PublishedArtifactEntry[];
}

/** Records which throwaway workspace produced an implementation, so a later step can re-derive it. */
interface WorkspaceRecord {
  implementationHash: string;
  operationId: string;
  taskId: string;
  sourceRoot: string;
  workspaceRoot: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  sourceTreeHash: string;
  workspaceTreeHash: string;
  fullDiffHash: string;
}

interface StagedArtifact {
  name: string;
  file: string;
  /** The ref a consumer will hold. */
  ref: ArtifactRef;
  /**
   * `object` — `ref.sha256` is the published object's own typed hash (SourceBundle, AdaptationPlan,
   * CheckReport, ImplementationSnapshot, LightweightResult, ExecutableSnapshot), which is NOT the
   * sha256 of its JSON bytes. `bytes` — `ref.sha256` is the sha256 of the artifact bytes, so
   * publication can verify that the copy a consumer will read is the artifact that was staged.
   */
  refKind: 'object' | 'bytes';
}

interface OwnerRecord {
  identity: string;
  pid: number;
  startedAt: string;
  lastSeenAt: string;
  state: 'active' | 'closed';
}

export const EXPERIMENT_OPERATION_STAGE = 'phase2' as const;

const HOST_REF_DOMAINS = {
  constraints: 'phase2-host-planning-constraints',
  budget: 'phase2-host-budget-policy',
  isolation: 'phase2-host-isolation-policy',
  resolvedConfig: 'phase2-resolved-config',
  dependencyLock: 'phase2-dependency-lock',
  mechanismDiff: 'phase2-mechanism-diff',
  runImplementation: 'phase2-run-implementation',
  cost: 'phase2-cost',
} as const;

const PROCESS_IDENTITY = `${process.pid}-${Date.now()}`;
export const DEFAULT_OWNER_STALE_MS = 15 * 60 * 1000;

/** The DSH tool names the frozen contract declares, in contract order. */
export const PHASE2_CONTRACT_TOOL_NAMES: readonly string[] = PHASE2_METHODS.map((m) => m.tool);

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether the host that owns an operation is still working on this storage root. */
export function ownerIsAlive(
  record: OwnerRecord | undefined,
  nowMs: number,
  probe?: { staleMs?: number; pidAlive?: (pid: number) => boolean }
): boolean {
  if (!record) return false;
  if (record.state !== 'active') return false;
  if (!(probe?.pidAlive ?? isPidAlive)(record.pid)) return false;
  return nowMs - Date.parse(record.lastSeenAt) < (probe?.staleMs ?? DEFAULT_OWNER_STALE_MS);
}

/** An operation left non-terminal by a host that is gone becomes interrupted. */
export function shouldInterruptOperation(args: {
  status: string;
  ownerIdentity?: string;
  selfIdentity: string;
  ownerAlive: boolean;
}): boolean {
  if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(args.status)) return false;
  if (!args.ownerIdentity) return true;
  if (args.ownerIdentity === args.selfIdentity) return false;
  return !args.ownerAlive;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function sha256File(absPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJsonV1(a) === canonicalJsonV1(b);
}

function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return isTerminal(status as ResearchOperationStatus);
}

/**
 * The execution lifecycle IS the lifecycle `contracts/research.ts` froze (same seven statuses).
 * Reusing that transition table is deliberate: a second copy here could drift from the one the
 * P5/P6/P7 operations are held to.
 */
function assertExecutionTransition(from: ExecutionStatus, to: ExecutionStatus): void {
  try {
    assertStatusTransition(from as ResearchOperationStatus, to as ResearchOperationStatus);
  } catch {
    throw new ExperimentError('INVALID_INPUT', `Illegal execution transition ${from} -> ${to}`, {
      fieldPaths: ['status'],
    });
  }
}

/**
 * Local validator for the frozen `ExecutionOperation` shape. The frozen contract exports no
 * validator for it (unlike every published Phase 2 object), so one lives here rather than letting a
 * hand-built descriptor reach disk.
 */
export function validateExecutionOperation(raw: unknown, fieldPath = 'ExecutionOperation'): ExecutionOperation {
  const o = expNoExtraKeys(
    raw,
    [
      'id',
      'ownerSessionId',
      'taskId',
      'stage',
      'parentOperationId',
      'revision',
      'status',
      'resultRefs',
      'diagnosticRefs',
      'error',
      'createdAt',
      'updatedAt',
    ],
    fieldPath
  );
  if (o.stage !== EXPERIMENT_OPERATION_STAGE) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.stage must be "${EXPERIMENT_OPERATION_STAGE}"`);
  }
  const op = raw as ExecutionOperation;
  expAssertId(op.id, `${fieldPath}.id`);
  expAssertId(op.ownerSessionId, `${fieldPath}.ownerSessionId`);
  expAssertId(op.taskId, `${fieldPath}.taskId`);
  if (op.parentOperationId !== null) expAssertId(op.parentOperationId, `${fieldPath}.parentOperationId`);
  expAssertFinite(op.revision, `${fieldPath}.revision`, 1);
  expAssertEnum(op.status, EXECUTION_STATUSES, `${fieldPath}.status`);
  if (!Array.isArray(op.resultRefs)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.resultRefs must be an array`);
  }
  op.resultRefs.forEach((r, i) => expAssertArtifactRef(r, `${fieldPath}.resultRefs[${i}]`));
  if (!Array.isArray(op.diagnosticRefs)) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}.diagnosticRefs must be an array`);
  }
  op.diagnosticRefs.forEach((r, i) => expAssertArtifactRef(r, `${fieldPath}.diagnosticRefs[${i}]`));
  if (op.status === 'succeeded' && op.resultRefs.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: succeeded requires a published resultRef`, {
      fieldPaths: [`${fieldPath}.resultRefs`],
    });
  }
  if ((op.status === 'failed' || op.status === 'cancelled' || op.status === 'interrupted') && op.error === null) {
    throw new ExperimentError('SCHEMA_VIOLATION', `${fieldPath}: ${op.status} requires an error record`, {
      fieldPaths: [`${fieldPath}.error`],
    });
  }
  expAssertId(op.createdAt, `${fieldPath}.createdAt`);
  expAssertId(op.updatedAt, `${fieldPath}.updatedAt`);
  return op;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ExperimentService {
  readonly storageRoot: string;
  readonly workRoot: string;
  readonly repoRoot: string;
  readonly hostId: string;
  readonly ownerStaleMs: number;
  readonly constraints: HostPlanningConstraints;
  readonly protocols: { smoke: HostProtocolEntry; tiny: HostProtocolEntry };
  readonly sourceCheckoutAbs: string;
  readonly sourceManifest: { id: string; path: string; absPath: string; sha256: string };
  /**
   * Which SourceBundle inside the host-registered source manifest this service
   * consumes. HOST-OWNED, like the profile and the protocols: a request cannot
   * name it, and the proposal it pins is still compared byte-for-byte against
   * the request's proposal. The default (`bundle`) is the Phase 2 manual pack;
   * `researchBundle` is the same pinned sources with a research-bound proposal,
   * which is what the Phase 3 pilot asks for (SPEC 0.1/9.3 P3H-03).
   */
  readonly sourceBundleKey: string;
  readonly budget: HostBudgetPolicy;
  readonly policyRef: ArtifactRef;
  readonly budgetRef: ArtifactRef;
  readonly constraintsRef: ArtifactRef;
  readonly sourceManifestRef: ArtifactRef;
  readonly pythonPath: string;
  readonly runTimeoutMs: number;

  private readonly profileLoader: NonNullable<ExperimentServiceOptions['profileLoader']>;
  private readonly mechanismCheckRunner: typeof runMechanismChecks;
  private readonly runExecutor: NonNullable<ExperimentServiceOptions['runExecutor']>;
  private readonly rootBudgetBinding: ExperimentServiceOptions['rootBudget'];
  private readonly agentPatchProvider: AgentPatchProvider | undefined;
  /**
   * Live run abort controllers, keyed by operation id.
   *
   * A stop request aborts the controller, which KILLS the running child process.
   * This is what separates cancelling an experiment from merely marking its
   * descriptor: without it, a "cancelled" run would keep training.
   */
  private readonly runAborts = new Map<string, AbortController>();
  private resolvedProfile: ResolvedTaskProfile | null = null;

  /**
   * The abort controller for an operation's current child process, if one is
   * registered. Registered by {@link runLightweight} for the duration of the
   * sweep, and aborted by {@link stopExecutionOperation}.
   */
  private runAbortController(operationId: string): AbortController | undefined {
    return this.runAborts.get(operationId);
  }

  /** Register (and return) the controller for a running sweep. */
  private beginRunAborts(operationId: string): AbortController {
    const controller = new AbortController();
    this.runAborts.set(operationId, controller);
    return controller;
  }

  private endRunAborts(operationId: string): void {
    this.runAborts.delete(operationId);
  }

  constructor(options: ExperimentServiceOptions) {
    if (!options || typeof options.storageRoot !== 'string' || options.storageRoot.trim().length === 0) {
      throw new ExperimentError('INVALID_INPUT', 'storageRoot is required');
    }
    this.repoRoot = path.resolve(options.repoRoot ?? '.');
    // `assertIsolationPolicy` resolves the policy's relative roots against process.cwd(); a different
    // cwd would silently check the wrong roots, so refuse rather than pretend containment holds.
    if (path.resolve('.') !== this.repoRoot) {
      throw new ExperimentError(
        'CONFIG_INCOMPLETE',
        `repoRoot (${this.repoRoot}) must equal the process working directory (${path.resolve('.')}); the isolation policy resolves its roots against the working directory`,
        { fieldPaths: ['repoRoot'] }
      );
    }
    this.storageRoot = path.resolve(options.storageRoot);
    this.workRoot = path.resolve(options.workRoot ?? path.join(this.repoRoot, 'work', 'research-execution'));
    this.hostId = options.hostId ?? PROCESS_IDENTITY;
    this.ownerStaleMs = options.ownerStaleMs ?? DEFAULT_OWNER_STALE_MS;
    this.profileLoader = options.profileLoader ?? ((o) => loadResolvedProfile(o));
    this.mechanismCheckRunner = options.mechanismCheckRunner ?? runMechanismChecks;
    // The abort signal is per-OPERATION, not per-service: the Phase 3 cancel
    // path aborts the run it owns and leaves every other run alone.
    this.runExecutor =
      options.runExecutor
      ?? ((resolved, prepared, manifestPath, signal, resourceLimits) =>
        runPhase2CpuSegRunner(resolved, prepared, manifestPath, signal, resourceLimits
          ? { maxWorkingSetBytes: resourceLimits.maxWorkingSetBytes, maxOutputBytes: resourceLimits.maxOutputBytes }
          : undefined));
    this.rootBudgetBinding = options.rootBudget;
    this.agentPatchProvider = options.agentPatchProvider;
    this.pythonPath = options.pythonPath ?? 'G:\\Anaconda\\python.exe';

    if (!options.constraints || !Array.isArray(options.constraints.bindings)) {
      throw new ExperimentError('CONFIG_INCOMPLETE', 'host planning constraints with bindings are required');
    }
    this.constraints = options.constraints;
    if (!options.protocols?.smoke?.body || !options.protocols?.tiny?.body) {
      throw new ExperimentError('CONFIG_INCOMPLETE', 'host smoke and tiny protocols are required');
    }
    this.protocols = options.protocols;

    const resolved = this.profile();
    const checkout = path.resolve(this.repoRoot, options.sourceCheckout ?? 'fixtures/modules');
    if (!fs.existsSync(checkout) || !fs.statSync(checkout).isDirectory()) {
      throw new ExperimentError('CONFIG_INCOMPLETE', `pinned source checkout is not a directory: ${checkout}`);
    }
    this.sourceCheckoutAbs = checkout;

    const manifestRel = options.sourceManifest?.path ?? 'fixtures/phase2-source-pack/manifest.json';
    const manifestAbs = path.resolve(this.repoRoot, manifestRel);
    if (!fs.existsSync(manifestAbs)) {
      throw new ExperimentError('CONFIG_INCOMPLETE', `host-registered source manifest is missing: ${manifestAbs}`);
    }
    this.sourceManifest = {
      id: options.sourceManifest?.id ?? 'phase2-source-pack-v1',
      path: toPosix(manifestRel),
      absPath: manifestAbs,
      sha256: sha256File(manifestAbs),
    };
    const bundleKey = options.sourceBundleKey ?? 'bundle';
    if (typeof bundleKey !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(bundleKey)) {
      throw new ExperimentError('INVALID_INPUT', `sourceBundleKey "${String(bundleKey)}" is not a manifest key`, {
        fieldPaths: ['sourceBundleKey'],
      });
    }
    this.sourceBundleKey = bundleKey;

    // A timeout override may only LOWER the profile's declared per-attempt budget: SPEC section 3
    // says a request may not raise it, and a host config that could raise it would be the same hole.
    if (options.runTimeoutMs !== undefined) {
      if (!Number.isFinite(options.runTimeoutMs) || options.runTimeoutMs <= 0) {
        throw new ExperimentError('INVALID_INPUT', 'runTimeoutMs must be a positive finite number', {
          fieldPaths: ['runTimeoutMs'],
        });
      }
      if (options.runTimeoutMs > resolved.timeoutMs) {
        throw new ExperimentError(
          'POLICY_DENIED',
          `runTimeoutMs ${options.runTimeoutMs} exceeds the profile's declared per-attempt budget ${resolved.timeoutMs}; an override may only lower it`,
          { fieldPaths: ['runTimeoutMs'] }
        );
      }
      this.runTimeoutMs = options.runTimeoutMs;
    } else {
      this.runTimeoutMs = resolved.timeoutMs;
    }

    const budgetPath = path.resolve(this.repoRoot, options.executionConfigPath ?? 'configs/phase2/execution-config.json');
    this.budget = loadHostBudget(budgetPath);
    this.budgetRef = {
      id: 'phase2-execution-config-v1#budget',
      sha256: typedHash(HOST_REF_DOMAINS.budget, this.budget as unknown as Record<string, unknown>),
    };
    this.policyRef = {
      id: resolved.isolation.policyId,
      sha256: typedHash(HOST_REF_DOMAINS.isolation, resolved.isolation as unknown as Record<string, unknown>),
    };
    this.constraintsRef = {
      id: this.constraints.id,
      sha256: typedHash(HOST_REF_DOMAINS.constraints, this.constraints as unknown as Record<string, unknown>),
    };
    this.sourceManifestRef = { id: this.sourceManifest.id, sha256: this.sourceManifest.sha256 };

    // Ceilings the profile must fit inside, checked once at load so a run cannot start outside them
    // (SPEC section 6: a budget field that is unset blocks the work that needs it).
    if (this.runTimeoutMs > this.budget.perAttemptTimeoutMs) {
      throw new ExperimentError(
        'CONFIG_INCOMPLETE',
        `profile per-attempt timeout ${this.runTimeoutMs}ms exceeds the frozen budget ${this.budget.perAttemptTimeoutMs}ms`,
        { fieldPaths: ['perAttemptTimeoutMs'] }
      );
    }
    if (!this.budget.allowedDevices.includes(resolved.environment.device)) {
      throw new ExperimentError(
        'PREFLIGHT_FAILED',
        `environment device "${resolved.environment.device}" is not in the budget's allowedDevices (${this.budget.allowedDevices.join(', ')})`,
        { fieldPaths: ['allowedDevices'] }
      );
    }
    if (this.budget.wallClockDeadline !== null && Date.parse(this.budget.wallClockDeadline) <= Date.now()) {
      throw new ExperimentError(
        'BUDGET_EXHAUSTED',
        `the declared wallClockDeadline ${this.budget.wallClockDeadline} has passed`,
        { fieldPaths: ['wallClockDeadline'] }
      );
    }
    if ((this.constraints.maxRepairAttempts ?? 0) > this.budget.maxRepairAttempts) {
      throw new ExperimentError(
        'CONFIG_INCOMPLETE',
        `planning constraints allow ${this.constraints.maxRepairAttempts} repair attempt(s) but the frozen budget allows ${this.budget.maxRepairAttempts}`,
        { fieldPaths: ['maxRepairAttempts'] }
      );
    }

    // The patch workspace and the source checkout must be disjoint, checked before any operation
    // could create a workspace (SPEC section 5: source checkout 与 patch 工作区分离).
    assertSeparateRoots(this.sourceCheckoutAbs, path.join(this.workRoot, 'layout-probe'));

    // The work root must be a writable root under the isolation policy: a run's output directory and
    // the adapted tree both live there.
    const workVerdict = assertIsolationPolicy(resolved.isolation, this.workRoot, 'write');
    if (!workVerdict.allowed) {
      throw new ExperimentError('POLICY_DENIED', `workRoot is not writable under the isolation policy: ${workVerdict.reason}`, {
        fieldPaths: ['workRoot'],
      });
    }

    for (const dir of EXPERIMENT_STORE_RESERVED_DIRS) {
      fs.mkdirSync(path.join(this.storageRoot, dir), { recursive: true });
    }
    this.registerOwner();
    this.reconcileAfterRestart();
  }

  // -------------------------------------------------------------------------
  // Host configuration resolution
  // -------------------------------------------------------------------------

  /** The resolved trusted profile. Loaded once; a caller can never name a different executable. */
  profile(): ResolvedTaskProfile {
    if (!this.resolvedProfile) {
      this.resolvedProfile = this.profileLoader({ repoRoot: this.repoRoot });
    }
    return this.resolvedProfile;
  }

  /** Refuses a host-configuration path that is on the isolation deny list. */
  private assertHostReadable(absPath: string, what: string): void {
    const denied = this.profile().isolation.deniedPaths.map((d) => path.resolve(this.repoRoot, d));
    const abs = path.resolve(absPath);
    for (const d of denied) {
      if (abs === d || abs.startsWith(d + path.sep)) {
        throw new ExperimentError('POLICY_DENIED', `${what} resolves onto the isolation deny list: ${abs}`, {
          fieldPaths: [what],
        });
      }
    }
  }

  /**
   * Every host-owned object a request names is identified by the host's frozen hash. A caller may
   * change neither the object nor its identity: a stale id paired with a fresh hash is refused too.
   */
  private assertHostRef(ref: ArtifactRef, expected: ArtifactRef, fieldPath: string): void {
    const parsed = expAssertArtifactRef(ref, fieldPath);
    if (parsed.id !== expected.id) {
      throw new ExperimentError('SOURCE_MISMATCH', `${fieldPath}.id "${parsed.id}" is not the host-registered "${expected.id}"`, {
        fieldPaths: [`${fieldPath}.id`],
      });
    }
    if (parsed.sha256 !== expected.sha256) {
      throw new ExperimentError(
        'SOURCE_MISMATCH',
        `${fieldPath}.sha256 ${parsed.sha256.slice(0, 12)}... does not match the host's frozen hash ${expected.sha256.slice(0, 12)}...`,
        { fieldPaths: [`${fieldPath}.sha256`] }
      );
    }
  }

  protocolRefFor(mode: LightweightMode): ArtifactRef {
    const entry = this.protocols[mode];
    return { id: entry.id, sha256: entry.body.protocolHash };
  }

  /**
   * Resolves a binding's module id (a `SourceBundle.modules[].id`) to the host-pinned runnable module
   * source the profile registry declares. The two id vocabularies are owned by different host files,
   * so `constraints.moduleIdMap` is the host's bridge between them; an unmapped id maps to itself.
   */
  resolvePinnedModule(moduleId: string): PinnedModule {
    const mapped = this.constraints.moduleIdMap?.[moduleId] ?? moduleId;
    const pinned = this.profile().pinnedModules.find((m) => m.id === mapped);
    if (!pinned) {
      throw new ExperimentError(
        'NOT_FOUND',
        `module id "${moduleId}"${mapped === moduleId ? '' : ` (host-mapped to "${mapped}")`} is not a host-pinned module source for profile "${this.profile().profileRef}"; a request cannot introduce a module by path`,
        { fieldPaths: ['bindings'] }
      );
    }
    return pinned;
  }

  /** The bindings as `compileRecipe`/`prepareRun` need them: profile-registry module ids. */
  toProfileBindings(bindings: readonly PlanBinding[]): PlanBinding[] {
    return bindings.map((binding) => ({
      slotId: binding.slotId,
      orderedModuleIds: binding.orderedModuleIds.map((id) => this.resolvePinnedModule(id).id),
      configRef: binding.configRef,
    }));
  }

  /** The mechanism-check profile for this task: the host rules, keyed to the TASK profile ref. */
  taskCheckProfile(): MechanismCheckProfile {
    const resolved = this.profile();
    const body = { ...mechanismCheckProfileBody(MECHANISM_CHECK_PROFILE_V1), profileRef: resolved.profileRef };
    return {
      ...MECHANISM_CHECK_PROFILE_V1,
      profileRef: resolved.profileRef,
      profileHash: computeMechanismCheckProfileHash(body),
    };
  }

  // -------------------------------------------------------------------------
  // Storage primitives
  // -------------------------------------------------------------------------

  private indexPath(name: string): string {
    return path.join(this.storageRoot, 'index', name);
  }

  private readJsonMap<T>(file: string): Map<string, T> {
    if (!fs.existsSync(file)) return new Map();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, T>;
    return new Map(Object.entries(parsed));
  }

  /**
   * Atomic replace: write a sibling temp file, then rename over the target.
   *
   * The temp name is unique per WRITE, not per process: the same process rewrites the same
   * descriptors and index files many times per operation, and a shared temp name makes two writes
   * collide. The rename is retried a few times because on Windows a rename onto a file an antivirus
   * scanner has just opened fails transiently with EPERM, and a retry is the honest fix for that
   * rather than a different write path.
   */
  private writeJsonAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${PROCESS_IDENTITY}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        lastError = err;
        const until = Date.now() + 5 * (attempt + 1);
        while (Date.now() < until) {
          /* brief backoff */
        }
      }
    }
    fs.rmSync(tmp, { force: true });
    throw lastError;
  }

  descriptorPath(operationId: string): string {
    return path.join(this.storageRoot, 'operations', `${operationId}.json`);
  }

  loadOperation(operationId: string): ExecutionOperation {
    const file = this.descriptorPath(operationId);
    if (!fs.existsSync(file)) {
      throw new ExperimentError('DEPENDENCY_NOT_READY', `Operation "${operationId}" has no published descriptor`, {
        fieldPaths: ['operationId'],
      });
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutionOperation;
  }

  listOperations(): ExecutionOperation[] {
    const dir = path.join(this.storageRoot, 'operations');
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ExecutionOperation);
  }

  private saveDescriptor(op: ExecutionOperation): void {
    validateExecutionOperation(op);
    // Writing a descriptor is proof of life, so the host record is refreshed alongside it.
    this.registerOwner();
    const onDisk = this.readDescriptor(op.id);
    if (onDisk && isTerminalExecutionStatus(onDisk.status) && !isTerminalExecutionStatus(op.status)) {
      // A terminal state on disk is authoritative: a stale in-memory object must never resurrect a
      // cancelled or interrupted operation while writing diagnostics.
      op.status = onDisk.status;
      op.error = onDisk.error;
      op.resultRefs = onDisk.resultRefs;
      op.updatedAt = onDisk.updatedAt;
    }
    // Diagnostics are evidence, not state: attaching one to an ALREADY terminal operation (which is
    // exactly what recording the first error of a failed run does) must add to the record, never be
    // reverted by the terminal-state rule above.
    if (onDisk) {
      const merged = [...onDisk.diagnosticRefs];
      for (const ref of op.diagnosticRefs) {
        if (!merged.some((r) => r.id === ref.id && r.sha256 === ref.sha256)) merged.push(ref);
      }
      op.diagnosticRefs = merged;
    }
    this.writeJsonAtomic(this.descriptorPath(op.id), op);
  }

  private readDescriptor(operationId: string): ExecutionOperation | undefined {
    const file = this.descriptorPath(operationId);
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ExecutionOperation;
  }

  // -------------------------------------------------------------------------
  // Owner records / reconciliation
  // -------------------------------------------------------------------------

  private ownerFile(identity: string): string {
    return path.join(this.storageRoot, 'owners', `${identity}.json`);
  }

  private registerOwner(): void {
    const now = nowIso();
    const previous = this.readOwnerRecord(this.hostId);
    const record: OwnerRecord = {
      identity: this.hostId,
      pid: process.pid,
      startedAt: previous?.startedAt ?? now,
      lastSeenAt: now,
      state: 'active',
    };
    this.writeJsonAtomic(this.ownerFile(this.hostId), record);
  }

  readOwnerRecord(identity: string): OwnerRecord | undefined {
    const file = this.ownerFile(identity);
    if (!fs.existsSync(file)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as OwnerRecord;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    const existing = this.readOwnerRecord(this.hostId);
    if (!existing || existing.state === 'closed') return;
    this.writeJsonAtomic(this.ownerFile(this.hostId), { ...existing, state: 'closed', lastSeenAt: nowIso() });
  }

  /**
   * An operation left non-terminal by a host that is gone becomes interrupted. An operation whose host
   * is still alive is left alone, so a second process sharing this storage root cannot cancel a live
   * peer's in-flight work.
   *
   * The frozen `ExecutionOperation` carries no `ownerIdentity` field, so the owning host is recorded in
   * `index/operation-owners.json` when the operation is created and read back here.
   */
  reconcileAfterRestart(): ExecutionOperation[] {
    const interrupted: ExecutionOperation[] = [];
    const nowMs = Date.now();
    const owners = this.readJsonMap<string>(this.indexPath('operation-owners.json'));
    for (const op of this.listOperations()) {
      const ownerIdentity = owners.get(op.id);
      const ownerAlive = ownerIsAlive(
        ownerIdentity ? this.readOwnerRecord(ownerIdentity) : undefined,
        nowMs,
        { staleMs: this.ownerStaleMs }
      );
      if (
        !shouldInterruptOperation({
          status: op.status,
          ownerIdentity,
          selfIdentity: this.hostId,
          ownerAlive,
        })
      ) {
        continue;
      }
      assertExecutionTransition(op.status, 'interrupted');
      op.status = 'interrupted';
      op.error = {
        code: 'RECONCILIATION_REQUIRED',
        message: 'The host that owned this operation is no longer running; the publish commit point was not reached',
        retryable: false,
        fieldPaths: [],
        diagnosticRef: null,
      };
      op.updatedAt = nowIso();
      this.writeJsonAtomic(this.descriptorPath(op.id), op);
      interrupted.push(op);
    }
    return interrupted;
  }

  // -------------------------------------------------------------------------
  // Task registry: owner binding + revision CAS
  // -------------------------------------------------------------------------

  private taskMap(): Map<string, TaskRecord> {
    return this.readJsonMap<TaskRecord>(this.indexPath('tasks.json'));
  }

  private saveTask(record: TaskRecord): void {
    const map = this.taskMap();
    map.set(record.taskId, record);
    this.writeJsonAtomic(this.indexPath('tasks.json'), Object.fromEntries(map));
  }

  getTaskRecord(taskId: string): TaskRecord {
    const found = this.taskMap().get(taskId);
    if (!found) {
      throw new ExperimentError('NOT_FOUND', `Task "${taskId}" is not bound to any owner`, { fieldPaths: ['taskId'] });
    }
    return found;
  }

  /** The task must already be owned by this actor; a different owner is refused. */
  private assertTaskOwnership(taskId: string, actor: ExperimentCallerActor): TaskRecord {
    const existing = this.taskMap().get(taskId);
    if (!existing) {
      throw new ExperimentError('NOT_FOUND', `Task "${taskId}" is not bound to any owner`, { fieldPaths: ['taskId'] });
    }
    if (existing.ownerSessionId !== actor.sessionId) {
      throw new ExperimentError('OWNER_MISMATCH', `Task "${taskId}" belongs to another owner`, { fieldPaths: ['taskId'] });
    }
    return existing;
  }

  private ensureTask(taskId: string, actor: ExperimentCallerActor, expectedRevision: number): TaskRecord {
    const existing = this.taskMap().get(taskId);
    if (existing) return this.assertTaskOwnership(taskId, actor);
    if (expectedRevision !== 1) {
      throw new ExperimentError(
        'REVISION_CONFLICT',
        `Task "${taskId}" does not exist yet; the first operation must carry expectedRevision 1, got ${expectedRevision}`,
        { fieldPaths: ['expectedRevision'] }
      );
    }
    const now = nowIso();
    const record: TaskRecord = { taskId, ownerSessionId: actor.sessionId, revision: 1, createdAt: now, updatedAt: now };
    this.saveTask(record);
    return record;
  }

  private assertRevision(task: TaskRecord, expectedRevision: number): void {
    if (task.revision !== expectedRevision) {
      throw new ExperimentError(
        'REVISION_CONFLICT',
        `Revision conflict: expected revision ${expectedRevision}, but current is ${task.revision}`,
        { fieldPaths: ['expectedRevision'] }
      );
    }
  }

  /** A successful write step advances the task revision, so the next step's CAS is meaningful. */
  private advanceRevision(taskId: string): void {
    const record = this.getTaskRecord(taskId);
    record.revision += 1;
    record.updatedAt = nowIso();
    this.saveTask(record);
  }

  // -------------------------------------------------------------------------
  // Request intake
  // -------------------------------------------------------------------------

  private assertActor(actor: ExperimentCallerActor): string {
    if (!actor || typeof actor.sessionId !== 'string' || actor.sessionId.trim().length === 0) {
      throw new ExperimentError('OWNER_MISMATCH', 'A non-empty session owner is required');
    }
    return actor.sessionId.trim();
  }

  private validateBase(request: unknown, extras: readonly string[], context: string): ExperimentRequestBase {
    // The executable guard runs FIRST, on the raw payload, before the unknown-field check: a request
    // that tries to supply a runner path, an argv or a shell must be refused as POLICY_DENIED, which
    // is the code the profile module's guard raises and the code a caller can act on. Reporting it as
    // a generic unknown-field schema violation would hide why the field is forbidden.
    assertNoRequestSuppliedExecutable(request, context);
    const o = expNoExtraKeys(
      request,
      ['commandId', 'taskId', 'expectedRevision', 'policyRef', 'budgetRef', ...extras],
      context
    );
    const expectedRevision = expAssertFinite(o.expectedRevision, `${context}.expectedRevision`, 1);
    if (!Number.isInteger(expectedRevision)) {
      throw new ExperimentError('INVALID_INPUT', `${context}.expectedRevision must be an integer`, {
        fieldPaths: [`${context}.expectedRevision`],
      });
    }
    // The single most important guard in the profile module: a request may never choose the code that
    // runs, an argv, a shell or an out-of-repo path. Applied to every payload, nested values included.
    assertNoRequestSuppliedExecutable(o, context);
    return {
      commandId: expAssertId(o.commandId, `${context}.commandId`),
      taskId: expAssertId(o.taskId, `${context}.taskId`),
      expectedRevision,
      policyRef: expAssertArtifactRef(o.policyRef, `${context}.policyRef`),
      budgetRef: expAssertArtifactRef(o.budgetRef, `${context}.budgetRef`),
    };
  }

  private assertHostEnvelope(base: ExperimentRequestBase, context: string): void {
    this.assertHostRef(base.policyRef, this.policyRef, `${context}.policyRef`);
    this.assertHostRef(base.budgetRef, this.budgetRef, `${context}.budgetRef`);
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  private idempotencyKey(ownerSessionId: string, taskId: string, method: string, commandId: string): string {
    return `${ownerSessionId}::${taskId}::${method}::${commandId}`;
  }

  /**
   * SPEC section 3 / architecture section 9.3: the same owner + task + method + commandId with the
   * same request hash returns what was already recorded; a different payload under the same key is
   * refused. This runs BEFORE the revision CAS, so a replay still returns the original receipt after
   * the task revision has advanced.
   */
  private reserveOrReuse(
    ownerSessionId: string,
    taskId: string,
    method: string,
    commandId: string,
    requestHash: string
  ): { operationId: string; reused: boolean; receipt: ExecutionReceipt | null } {
    const index = this.readJsonMap<CommandIndexEntry>(this.indexPath('command-index.json'));
    const key = this.idempotencyKey(ownerSessionId, taskId, method, commandId);
    const existing = index.get(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ExperimentError(
          'IDEMPOTENCY_CONFLICT',
          `commandId "${commandId}" was already used for ${method} under this owner with a different payload`,
          { fieldPaths: ['commandId'] }
        );
      }
      return { operationId: existing.operationId, reused: true, receipt: existing.receipt };
    }
    const operationId = `eop-${method.replace(/[^A-Za-z0-9]+/g, '-')}-${sha256Hex(key).slice(0, 16)}`;
    index.set(key, { operationId, requestHash, ownerSessionId, method, taskId, receipt: null });
    this.writeJsonAtomic(this.indexPath('command-index.json'), Object.fromEntries(index));
    return { operationId, reused: false, receipt: null };
  }

  private recordReceipt(
    ownerSessionId: string,
    taskId: string,
    method: string,
    commandId: string,
    receipt: ExecutionReceipt
  ): void {
    const index = this.readJsonMap<CommandIndexEntry>(this.indexPath('command-index.json'));
    const key = this.idempotencyKey(ownerSessionId, taskId, method, commandId);
    const existing = index.get(key);
    if (!existing) {
      throw new ExperimentError('DEPENDENCY_NOT_READY', `No reserved idempotency key for ${method}/${commandId}`);
    }
    existing.receipt = receipt;
    index.set(key, existing);
    this.writeJsonAtomic(this.indexPath('command-index.json'), Object.fromEntries(index));
  }

  /** Finds the operation a reserved idempotency key owns, without creating anything. */
  operationIdForCommand(ownerSessionId: string, taskId: string, method: string, commandId: string): string | null {
    const index = this.readJsonMap<CommandIndexEntry>(this.indexPath('command-index.json'));
    return index.get(this.idempotencyKey(ownerSessionId, taskId, method, commandId))?.operationId ?? null;
  }

  /**
   * A replay returns exactly what was recorded. A recorded failure is re-raised rather than swallowed
   * into an empty result, so "no artifact" never looks like success.
   */
  private replayOutcome<T>(operationId: string, receipt: ExecutionReceipt, context: string): ExperimentOutcome<T> {
    const prior = this.loadOperation(operationId);
    if (!isTerminalExecutionStatus(prior.status)) {
      throw new ExperimentError(
        'DEPENDENCY_NOT_READY',
        `Operation ${operationId} is still ${prior.status}; a replay reads only a terminal operation`,
        { fieldPaths: ['status'] }
      );
    }
    if (prior.status !== 'succeeded') {
      const code = prior.error?.code ?? 'DEPENDENCY_NOT_READY';
      throw new ExperimentError(code as never, prior.error?.message ?? `operation ${operationId} is ${prior.status}`, {
        retryable: prior.error?.retryable ?? false,
        fieldPaths: prior.error?.fieldPaths ?? [],
        diagnosticRef: prior.error?.diagnosticRef ?? null,
      });
    }
    const published = this.readPublishedArtifact<T>(prior.resultRefs[0], context);
    return { receipt, operation: prior, result: published.value };
  }

  // -------------------------------------------------------------------------
  // Operation lifecycle
  // -------------------------------------------------------------------------

  private createOperation(
    operationId: string,
    actor: ExperimentCallerActor,
    base: ExperimentRequestBase,
    requestHash: string,
    parentOperationId: string | null
  ): ExecutionOperation {
    if (this.listOperations().some((o) => o.id === operationId)) {
      throw new ExperimentError('IDEMPOTENCY_CONFLICT', `Operation ${operationId} already exists for a different payload`, {
        fieldPaths: ['commandId'],
      });
    }
    void requestHash;
    const now = nowIso();
    const fresh: ExecutionOperation = {
      id: operationId,
      ownerSessionId: actor.sessionId,
      taskId: base.taskId,
      stage: EXPERIMENT_OPERATION_STAGE,
      parentOperationId,
      revision: base.expectedRevision,
      status: 'accepted',
      resultRefs: [],
      diagnosticRefs: [],
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    // The frozen `ExecutionOperation` has no ownerIdentity field, so the owning host is recorded
    // beside the descriptor. Reconciliation needs it: without it, "the host that owned this is gone"
    // could not be distinguished from "a live peer is still working on it".
    const owners = this.readJsonMap<string>(this.indexPath('operation-owners.json'));
    owners.set(operationId, this.hostId);
    this.writeJsonAtomic(this.indexPath('operation-owners.json'), Object.fromEntries(owners));
    this.saveDescriptor(fresh);
    return fresh;
  }

  private transition(op: ExecutionOperation, to: ExecutionStatus): void {
    if (op.status === to) return;
    assertExecutionTransition(op.status, to);
    op.status = to;
    op.updatedAt = nowIso();
    this.saveDescriptor(op);
  }

  private failOperation(op: ExecutionOperation, err: unknown): ExecutionOperation {
    const onDisk = this.loadOperation(op.id);
    if (isTerminalExecutionStatus(onDisk.status)) return onDisk;
    const e = err instanceof ExperimentError ? err : null;
    onDisk.error = {
      code: e ? e.code : 'INVALID_RESULT',
      // A non-contract error must stay distinguishable from a refusal: swallowing a host defect as a
      // contract code is how a real bug goes unnoticed.
      message: e ? e.message : `${err instanceof Error ? `${err.constructor.name}: ` : ''}${String(err)}`,
      retryable: e ? e.retryable : false,
      fieldPaths: e ? e.fieldPaths : [],
      diagnosticRef: e?.diagnosticRef ?? null,
    };
    assertExecutionTransition(onDisk.status, 'failed');
    onDisk.status = 'failed';
    onDisk.updatedAt = nowIso();
    this.saveDescriptor(onDisk);
    return onDisk;
  }

  // -------------------------------------------------------------------------
  // Staging and publication
  // -------------------------------------------------------------------------

  stagingDir(operationId: string, taskId: string): string {
    return path.join(this.workRoot, taskId, 'staging', operationId);
  }

  publishedDir(operationId: string): string {
    return path.join(this.storageRoot, 'published', operationId);
  }

  private sidecarPath(operationId: string): string {
    return path.join(this.publishedDir(operationId), 'artifacts.json');
  }

  private relativeArtifactRef(file: string, id: string): ArtifactRef {
    return { id, sha256: sha256File(file) };
  }

  /**
   * The commit point. Staging files become consumable only when the descriptor flips to succeeded,
   * and they are COPIED into the published tree first, so a consumer can never be handed a staging
   * path. A cancellation observed before the commit point blocks publication.
   */
  private publish(op: ExecutionOperation, staged: StagedArtifact[], primaryName: string): ExecutionOperation {
    const onDisk = this.loadOperation(op.id);
    if (onDisk.status === 'succeeded') return onDisk;
    if (onDisk.status === 'cancelled' || onDisk.status === 'interrupted' || onDisk.status === 'failed') {
      throw new ExperimentError(
        'HOST_BUSY',
        `Operation ${op.id} is ${onDisk.status}; the publish commit point was not reached`,
        { fieldPaths: ['status'] }
      );
    }
    for (const artifact of staged) {
      if (!fs.existsSync(artifact.file) || fs.statSync(artifact.file).size === 0) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `Staged artifact "${artifact.file}" is missing or empty`);
      }
      // A byte-addressed ref must actually describe the bytes about to be published. (A typed object's
      // ref carries the object's own hash instead; that is checked by the frozen validator on read.)
      if (artifact.refKind === 'bytes' && sha256File(artifact.file) !== artifact.ref.sha256) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `Staged artifact "${artifact.name}" does not hash to its reference`);
      }
    }
    const primary = staged.find((s) => s.name === primaryName);
    if (!primary) {
      throw new ExperimentError('INVALID_INPUT', `No staged artifact named "${primaryName}" to publish as the result`);
    }

    const dir = this.publishedDir(op.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const entries: PublishedArtifactEntry[] = [];
    for (const artifact of staged) {
      const dest = path.join(dir, artifact.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(artifact.file, dest);
      if (sha256File(dest) !== sha256File(artifact.file)) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `Published copy of "${artifact.name}" differs from what was staged`);
      }
      entries.push({ name: artifact.name, file: dest, ref: artifact.ref, contentSha256: sha256File(dest) });
    }
    const sidecar: PublishedSidecar = { operationId: op.id, taskId: op.taskId, primary: primaryName, entries };
    this.writeJsonAtomic(this.sidecarPath(op.id), sidecar);

    op.resultRefs = [primary.ref];
    op.error = null;
    assertExecutionTransition(op.status, 'succeeded');
    op.status = 'succeeded';
    op.updatedAt = nowIso();
    this.saveDescriptor(op);
    return op;
  }

  /**
   * Attaches a diagnostic to an operation (SPEC: 失败先查询 diagnosticRef). The diagnostic is COPIED
   * into the operation's published tree, so the ref a caller receives points at a durable artifact
   * rather than at a staging file the next attempt may overwrite.
   */
  private attachDiagnostic(op: ExecutionOperation, file: string, id: string): ArtifactRef {
    if (!fs.existsSync(file)) {
      throw new ExperimentError('ARTIFACT_CORRUPT', `diagnostic artifact "${file}" is missing`);
    }
    const dir = path.join(this.publishedDir(op.id), 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${id}.json`);
    fs.copyFileSync(file, dest);
    const ref: ArtifactRef = { id, sha256: sha256File(dest) };
    const onDisk = this.loadOperation(op.id);
    onDisk.diagnosticRefs = [...onDisk.diagnosticRefs, ref];
    this.saveDescriptor(onDisk);
    return ref;
  }

  /** Absolute path of a published diagnostic, for a host-side reader. */
  diagnosticPath(operationId: string, diagnosticId: string): string {
    return path.join(this.publishedDir(operationId), 'diagnostics', `${diagnosticId}.json`);
  }

  private writeStagedJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  /**
   * Resolves an artifact reference. Only a ref that a SUCCEEDED operation published is accepted, the
   * recorded byte hash is re-verified, and a ref naming a staging path is refused outright: a staging
   * path may never cross a step boundary.
   */
  readPublishedArtifact<T>(
    ref: ArtifactRef,
    context: string
  ): { value: T; operation: ExecutionOperation; entry: PublishedArtifactEntry } {
    const parsed = expAssertArtifactRef(ref, context);
    if (parsed.id.split('/').includes('staging') || parsed.id.startsWith('staging/')) {
      throw new ExperimentError(
        'POLICY_DENIED',
        `${context} "${parsed.id}" names a staging path; only published artifacts may be consumed`,
        { fieldPaths: [context] }
      );
    }
    for (const op of this.listOperations()) {
      if (op.status !== 'succeeded') continue;
      if (!op.resultRefs.some((r) => r.id === parsed.id && r.sha256 === parsed.sha256)) continue;
      const sidecarFile = this.sidecarPath(op.id);
      if (!fs.existsSync(sidecarFile)) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `Operation ${op.id} has no published artifact index`);
      }
      const sidecar = JSON.parse(fs.readFileSync(sidecarFile, 'utf8')) as PublishedSidecar;
      const entry = sidecar.entries.find((e) => e.ref.id === parsed.id && e.ref.sha256 === parsed.sha256);
      if (!entry) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `${context} "${parsed.id}" is not in the published artifact index`);
      }
      if (!fs.existsSync(entry.file)) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `${context} "${parsed.id}" is missing from disk`);
      }
      if (sha256File(entry.file) !== entry.contentSha256) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `${context} "${parsed.id}" content hash drifted`, {
          fieldPaths: [context],
        });
      }
      let value: T;
      try {
        value = JSON.parse(fs.readFileSync(entry.file, 'utf8')) as T;
      } catch (err) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `${context} "${parsed.id}" is not valid JSON: ${String(err)}`, {
          fieldPaths: [context],
        });
      }
      return { value, operation: op, entry };
    }
    throw new ExperimentError(
      'DEPENDENCY_NOT_READY',
      `${context} "${parsed.id}" is not the published result of any succeeded operation`,
      { fieldPaths: [context] }
    );
  }

  /** Every step waits for a terminal operation; a non-terminal dependency is refused. */
  awaitTerminalOperation(operationId: string, context: string): ExecutionOperation {
    const op = this.loadOperation(operationId);
    if (!isTerminalExecutionStatus(op.status)) {
      throw new ExperimentError(
        'DEPENDENCY_NOT_READY',
        `${context}: operation ${operationId} is still ${op.status}; every step waits for a terminal operation`,
        { fieldPaths: ['status'] }
      );
    }
    return op;
  }

  // -------------------------------------------------------------------------
  // Step 1: resolveSources
  // -------------------------------------------------------------------------

  /**
   * Fixes the sources into a validated `SourceBundle`. It reads the HOST-REGISTERED source manifest
   * only: a caller cannot point the host at an arbitrary download script, and the request's proposal
   * must equal the pinned one, so a drifted proposal is SOURCE_MISMATCH with zero training
   * (SPEC section 6 row 1).
   */
  async resolveSources(
    request: ResolveSourcesRequest,
    actor: ExperimentCallerActor
  ): Promise<ExperimentOutcome<SourceBundle>> {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(request, ['proposal', 'sourceManifestRef', 'profileRef'], 'ResolveSourcesRequest');
    this.assertHostEnvelope(base, 'ResolveSourcesRequest');
    const resolved = this.profile();
    const proposal = request.proposal;
    const sourceManifestRef = expAssertArtifactRef(request.sourceManifestRef, 'ResolveSourcesRequest.sourceManifestRef');
    const profileRef = expAssertId(request.profileRef, 'ResolveSourcesRequest.profileRef');
    if (profileRef !== resolved.profile.id && profileRef !== resolved.profileRef) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `profileRef "${profileRef}" does not name the host profile "${resolved.profileRef}"`,
        { fieldPaths: ['profileRef'] }
      );
    }
    this.assertHostRef(sourceManifestRef, this.sourceManifestRef, 'ResolveSourcesRequest.sourceManifestRef');
    this.assertHostReadable(this.sourceManifest.absPath, 'sourceManifest');

    const requestHash = computeExperimentRequestHash({
      method: 'resolveSources',
      taskId: base.taskId,
      policyRef: base.policyRef,
      budgetRef: base.budgetRef,
      proposal,
      sourceManifestRef,
      profileRef,
    });
    const reserved = this.reserveOrReuse(ownerSessionId, base.taskId, 'resolveSources', base.commandId, requestHash);
    if (reserved.reused && reserved.receipt) {
      return this.replayOutcome<SourceBundle>(reserved.operationId, reserved.receipt, 'SourceBundle');
    }
    const task = this.ensureTask(base.taskId, actor, base.expectedRevision);
    this.assertRevision(task, base.expectedRevision);

    const operation = this.createOperation(reserved.operationId, actor, base, requestHash, null);
    const staging = this.stagingDir(operation.id, base.taskId);
    const receipt: ExecutionReceipt = {
      operationId: operation.id,
      commandId: base.commandId,
      requestHash,
      taskRevision: task.revision,
    };
    this.recordReceipt(ownerSessionId, base.taskId, 'resolveSources', base.commandId, receipt);
    this.transition(operation, 'running');

    try {
      const manifest = JSON.parse(fs.readFileSync(this.sourceManifest.absPath, 'utf8')) as Record<string, unknown>;
      // The bundle key is host-owned configuration (see sourceBundleKey): a
      // request cannot select a different bundle, and whichever one the host
      // chose is still compared field-for-field against the request's proposal.
      const pinned = manifest[this.sourceBundleKey];
      if (pinned === undefined) {
        throw new ExperimentError(
          'SOURCE_MISMATCH',
          `the registered source manifest carries no "${this.sourceBundleKey}" bundle`,
          { fieldPaths: [`sourceManifest.${this.sourceBundleKey}`] },
        );
      }
      const bundle = validateSourceBundle(pinned);
      if (!jsonEqual(bundle.proposal, proposal)) {
        throw new ExperimentError(
          'SOURCE_MISMATCH',
          'the request proposal is not the proposal pinned by the host source manifest; a drifted proposal is refused before any run',
          { fieldPaths: ['proposal'] }
        );
      }

      const bundleFile = path.join(staging, 'source-bundle.json');
      this.writeStagedJson(bundleFile, bundle);
      const published = this.publish(
        operation,
        [
          {
            name: 'source-bundle.json',
            file: bundleFile,
            ref: { id: `source-bundle-${base.taskId}`, sha256: bundle.sourceBundleHash },
            refKind: 'object',
          },
        ],
        'source-bundle.json'
      );
      this.advanceRevision(base.taskId);
      return { receipt, operation: published, result: bundle };
    } catch (err) {
      this.failOperation(operation, err);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Step 2: planAdaptation
  // -------------------------------------------------------------------------

  /**
   * Builds the `AdaptationPlan` from the pinned bundle + the HOST constraints. An unknown binding
   * comes back as an explicit refusal with its code (SPEC section 6 row 2): the plan is never coerced
   * onto an existing slot, and a P6 `interventionAxis` label is provenance only.
   */
  async planAdaptation(
    request: PlanAdaptationRequest,
    actor: ExperimentCallerActor
  ): Promise<ExperimentOutcome<AdaptationPlan>> {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(
      request,
      ['sourceBundleRef', 'profileRef', 'constraintsRef', 'patchProvider', 'interventionAxis'],
      'PlanAdaptationRequest'
    );
    this.assertHostEnvelope(base, 'PlanAdaptationRequest');
    const resolved = this.profile();
    const sourceBundleRef = expAssertArtifactRef(request.sourceBundleRef, 'PlanAdaptationRequest.sourceBundleRef');
    const constraintsRef = expAssertArtifactRef(request.constraintsRef, 'PlanAdaptationRequest.constraintsRef');
    const profileRef = expAssertId(request.profileRef, 'PlanAdaptationRequest.profileRef');
    const patchProvider = expAssertEnum(
      request.patchProvider,
      ['human', 'agent'] as const,
      'PlanAdaptationRequest.patchProvider'
    );
    this.assertHostRef(constraintsRef, this.constraintsRef, 'PlanAdaptationRequest.constraintsRef');
    if (profileRef !== resolved.profile.id && profileRef !== resolved.profileRef) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `profileRef "${profileRef}" does not name the host profile "${resolved.profileRef}"`,
        { fieldPaths: ['profileRef'] }
      );
    }

    const requestHash = computeExperimentRequestHash({
      method: 'planAdaptation',
      taskId: base.taskId,
      policyRef: base.policyRef,
      budgetRef: base.budgetRef,
      sourceBundleRef,
      profileRef,
      constraintsRef,
      patchProvider,
      interventionAxis: request.interventionAxis ?? null,
    });
    const reserved = this.reserveOrReuse(ownerSessionId, base.taskId, 'planAdaptation', base.commandId, requestHash);
    if (reserved.reused && reserved.receipt) {
      return this.replayOutcome<AdaptationPlan>(reserved.operationId, reserved.receipt, 'AdaptationPlan');
    }
    const task = this.assertTaskOwnership(base.taskId, actor);
    this.assertRevision(task, base.expectedRevision);

    const operation = this.createOperation(reserved.operationId, actor, base, requestHash, null);
    const staging = this.stagingDir(operation.id, base.taskId);
    const receipt: ExecutionReceipt = {
      operationId: operation.id,
      commandId: base.commandId,
      requestHash,
      taskRevision: task.revision,
    };
    this.recordReceipt(ownerSessionId, base.taskId, 'planAdaptation', base.commandId, receipt);
    this.transition(operation, 'running');

    try {
      const bundle = this.readPublishedArtifact<SourceBundle>(sourceBundleRef, 'sourceBundleRef').value;
      validateSourceBundle(bundle);
      const outcome = buildAdaptationPlan(bundle, {
        taskId: base.taskId,
        sourceBundleRef,
        profile: resolved.profile,
        constraints: {
          allowedPaths: this.constraints.allowedPaths,
          ...(this.constraints.forbiddenPaths ? { forbiddenPaths: this.constraints.forbiddenPaths } : {}),
          dependencyPolicyRef: this.constraints.dependencyPolicyRef,
          mechanismChecks: this.constraints.mechanismChecks,
          maxRepairAttempts: this.constraints.maxRepairAttempts ?? 0,
        },
        bindings: this.constraints.bindings,
        patchProvider,
        ...(request.interventionAxis !== undefined ? { interventionAxis: request.interventionAxis } : {}),
      });

      if (outcome.status === 'blocked') {
        // A blocked plan is a RESULT, not a crash: it is published as a diagnostic so the caller can
        // read the refused bindings and the reason, then the refusal is raised.
        const blockedFile = path.join(staging, 'blocked-plan.json');
        this.writeStagedJson(blockedFile, outcome);
        const err = new ExperimentError(outcome.code as never, outcome.message, { fieldPaths: outcome.fieldPaths });
        this.failOperation(operation, err);
        this.attachDiagnostic(operation, blockedFile, `blocked-plan-${base.taskId}`);
        throw err;
      }

      const plan = validateAdaptationPlan(outcome.plan);
      assertPlanMatchesRequest(plan, { sourceBundleRef, profileRef: resolved.profileRef, patchProvider });
      this.assertPlanChecksAreHostRules(plan);

      const planFile = path.join(staging, 'adaptation-plan.json');
      this.writeStagedJson(planFile, plan);
      const provenanceFile = path.join(staging, 'plan-provenance.json');
      this.writeStagedJson(provenanceFile, outcome.provenance);
      const published = this.publish(
        operation,
        [
          {
            name: 'adaptation-plan.json',
            file: planFile,
            ref: { id: `adaptation-plan-${base.taskId}`, sha256: plan.planHash },
            refKind: 'object',
          },
          {
            name: 'plan-provenance.json',
            file: provenanceFile,
            ref: this.relativeArtifactRef(provenanceFile, `plan-provenance-${base.taskId}`),
            refKind: 'bytes',
          },
        ],
        'adaptation-plan.json'
      );
      this.advanceRevision(base.taskId);
      return { receipt, operation: published, result: plan };
    } catch (err) {
      this.failOperation(operation, err);
      throw err;
    }
  }

  /**
   * SPEC section 4 last paragraph + the mechanism-check profile rule: the checks come from the host.
   * A plan may neither drop a required check for a bound module's kind nor invent a rule id.
   */
  private assertPlanChecksAreHostRules(plan: AdaptationPlan): void {
    const known = new Set(allMechanismRuleIds());
    for (const id of plan.mechanismChecks) {
      if (!known.has(id)) {
        throw new ExperimentError('UNSUPPORTED_CAPABILITY', `plan declares unknown mechanism check "${id}"`, {
          fieldPaths: ['mechanismChecks'],
        });
      }
    }
    const resolved = this.profile();
    const slotIds = resolved.profile.slots.map((s) => s.slotId);
    const requiredRules = this.taskCheckProfile().requiredRules;
    for (const binding of plan.bindings) {
      if (!slotIds.includes(binding.slotId)) {
        throw new ExperimentError('INCOMPATIBLE_BINDING', `plan binding names an undeclared slot "${binding.slotId}"`, {
          fieldPaths: ['bindings'],
        });
      }
      for (const moduleId of binding.orderedModuleIds) {
        const pinned = this.resolvePinnedModule(moduleId);
        const kind = pinned.mechanismKind as MechanismKind;
        const required = requiredRules[kind] ?? [];
        if (required.length === 0) {
          throw new ExperimentError(
            'UNSUPPORTED_CAPABILITY',
            `mechanism kind "${kind}" has no required check in the host profile; a mechanism with no required check must be blocked, not passed`,
            { fieldPaths: ['mechanismChecks'] }
          );
        }
        const missing = required.filter((id) => !plan.mechanismChecks.includes(id));
        if (missing.length > 0) {
          throw new ExperimentError(
            'POLICY_DENIED',
            `plan omits required check(s) for "${moduleId}" (${kind}): ${missing.join(', ')}. Check rules come from the host profile; a plan may not drop one.`,
            { fieldPaths: ['mechanismChecks'] }
          );
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: adaptImplementation
  // -------------------------------------------------------------------------

  /**
   * Applies a bounded adaptation to a THROWAWAY copy of the pinned source. `human` requires a
   * submitted patch; `agent` generates one through the host port, and every returned patch goes
   * through the same `PatchWorkspace` path policy, so the agent has no wider surface than the human.
   */
  async adaptImplementation(
    request: AdaptImplementationRequest,
    actor: ExperimentCallerActor
  ): Promise<ExperimentOutcome<ImplementationSnapshot>> {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(request, ['planRef', 'submittedPatchRef'], 'AdaptImplementationRequest');
    this.assertHostEnvelope(base, 'AdaptImplementationRequest');
    const resolved = this.profile();
    const planRef = expAssertArtifactRef(request.planRef, 'AdaptImplementationRequest.planRef');
    const submittedPatchRef =
      request.submittedPatchRef === undefined
        ? undefined
        : expAssertArtifactRef(request.submittedPatchRef, 'AdaptImplementationRequest.submittedPatchRef');

    const requestHash = computeExperimentRequestHash({
      method: 'adaptImplementation',
      taskId: base.taskId,
      policyRef: base.policyRef,
      budgetRef: base.budgetRef,
      planRef,
      submittedPatchRef: submittedPatchRef ?? null,
    });
    const reserved = this.reserveOrReuse(ownerSessionId, base.taskId, 'adaptImplementation', base.commandId, requestHash);
    if (reserved.reused && reserved.receipt) {
      return this.replayOutcome<ImplementationSnapshot>(reserved.operationId, reserved.receipt, 'ImplementationSnapshot');
    }
    const task = this.assertTaskOwnership(base.taskId, actor);
    this.assertRevision(task, base.expectedRevision);

    const operation = this.createOperation(reserved.operationId, actor, base, requestHash, null);
    const staging = this.stagingDir(operation.id, base.taskId);
    const receipt: ExecutionReceipt = {
      operationId: operation.id,
      commandId: base.commandId,
      requestHash,
      taskRevision: task.revision,
    };
    this.recordReceipt(ownerSessionId, base.taskId, 'adaptImplementation', base.commandId, receipt);
    this.transition(operation, 'running');

    let workspace: PatchWorkspace | null = null;
    try {
      const plan = validateAdaptationPlan(this.readPublishedArtifact<AdaptationPlan>(planRef, 'planRef').value);
      const bundle = validateSourceBundle(
        this.readPublishedArtifact<SourceBundle>(plan.sourceBundleRef, 'plan.sourceBundleRef').value
      );
      // The plan must have been built for THIS bundle and THIS profile. (patchProvider is read from
      // the plan itself: the frozen payload has no request-level provider field, and the plan is the
      // artifact that recorded the caller's choice at planAdaptation time.)
      assertPlanMatchesRequest(plan, {
        sourceBundleRef: { id: plan.sourceBundleRef.id, sha256: bundle.sourceBundleHash },
        profileRef: resolved.profileRef,
        patchProvider: plan.patchProvider,
      });
      this.assertPlanChecksAreHostRules(plan);

      workspace = createPatchWorkspace({
        taskId: base.taskId,
        sourceRoot: this.sourceCheckoutAbs,
        workRoot: this.workRoot,
        workspaceName: `patch-workspace-${operation.id}`,
        policy: {
          allowedPaths: plan.allowedPaths,
          ...(plan.forbiddenPaths ? { forbiddenPaths: plan.forbiddenPaths } : {}),
        },
        maxRepairAttempts: plan.maxRepairAttempts,
        sourcePins: hashFileTree(this.sourceCheckoutAbs),
        // A retry of an interrupted or failed operation re-enters with the same operation id, so a
        // leftover workspace from the abandoned attempt is rebuilt from the pinned source. Nothing
        // legitimate is lost: the source checkout is read-only and the workspace is throwaway by
        // construction, so the copy is byte-identical to a fresh one.
        reset: true,
      });

      const applied =
        plan.patchProvider === 'human'
          ? this.applyHumanPatch(workspace, submittedPatchRef, base.taskId, ownerSessionId)
          : await this.applyAgentPatch(workspace, plan, base.taskId);

      // The check rules must not be reachable from the patch: this re-asserts it against the diff.
      assertPatchCannotChangeCheckRules(this.taskCheckProfile(), applied.diff.changedPaths);

      const mechanismDiff = this.buildMechanismDiff(plan, applied.diff, resolved);
      const mechanismDiffFile = path.join(staging, 'mechanism-diff.json');
      this.writeStagedJson(mechanismDiffFile, mechanismDiff);
      const resolvedConfigFile = path.join(staging, 'resolved-config.json');
      const resolvedConfig = this.buildResolvedConfig(plan, resolved, workspace);
      this.writeStagedJson(resolvedConfigFile, resolvedConfig);
      const dependencyLockFile = path.join(staging, 'dependency-lock.json');
      const dependencyLock = {
        dependencyPolicyRef: plan.dependencyPolicyRef,
        profileRef: resolved.profileRef,
        packageLockSha256: resolved.environment.packageLock.sha256,
        packageLockPackageCount: resolved.environment.packageLock.packageCount,
        networkAccess: 'denied',
      };
      this.writeStagedJson(dependencyLockFile, dependencyLock);
      const patchFile = path.join(staging, 'applied.patch');
      fs.writeFileSync(patchFile, applied.patchText, 'utf8');
      const diffFile = path.join(staging, 'full-diff.patch');
      fs.writeFileSync(diffFile, applied.diff.text, 'utf8');
      const attemptsFile = path.join(staging, 'attempts.json');
      this.writeStagedJson(attemptsFile, { attempts: workspace.listAttempts(), firstError: workspace.firstError() });

      const snapshot = workspace.buildImplementationSnapshot({
        sourceBundleRef: plan.sourceBundleRef,
        planRef,
        patchRef: { id: `applied-patch-${base.taskId}`, sha256: sha256Hex(applied.patchText) },
        dependencyLockRef: {
          id: `dependency-lock-${base.taskId}`,
          sha256: typedHash(HOST_REF_DOMAINS.dependencyLock, dependencyLock),
        },
        resolvedConfigRef: {
          id: `resolved-config-${base.taskId}`,
          sha256: typedHash(HOST_REF_DOMAINS.resolvedConfig, resolvedConfig),
        },
        mechanismDiff,
        mechanismDiffRef: {
          id: `mechanism-diff-${base.taskId}`,
          sha256: typedHash(HOST_REF_DOMAINS.mechanismDiff, { entries: mechanismDiff }),
        },
      });
      validateImplementationSnapshot(snapshot);

      const implementationFile = path.join(staging, 'implementation.json');
      this.writeStagedJson(implementationFile, snapshot);
      const published = this.publish(
        operation,
        [
          {
            name: 'implementation.json',
            file: implementationFile,
            ref: { id: `implementation-${snapshot.implementationHash.slice(0, 12)}`, sha256: snapshot.implementationHash },
            refKind: 'object',
          },
          {
            name: 'mechanism-diff.json',
            file: mechanismDiffFile,
            ref: this.relativeArtifactRef(mechanismDiffFile, `mechanism-diff-${base.taskId}`),
            refKind: 'bytes',
          },
          {
            name: 'resolved-config.json',
            file: resolvedConfigFile,
            ref: this.relativeArtifactRef(resolvedConfigFile, `resolved-config-${base.taskId}`),
            refKind: 'bytes',
          },
          {
            name: 'dependency-lock.json',
            file: dependencyLockFile,
            ref: this.relativeArtifactRef(dependencyLockFile, `dependency-lock-${base.taskId}`),
            refKind: 'bytes',
          },
          {
            name: 'applied.patch',
            file: patchFile,
            ref: this.relativeArtifactRef(patchFile, `applied-patch-${base.taskId}`),
            refKind: 'bytes',
          },
          {
            name: 'full-diff.patch',
            file: diffFile,
            ref: this.relativeArtifactRef(diffFile, `full-diff-${base.taskId}`),
            refKind: 'bytes',
          },
          {
            name: 'attempts.json',
            file: attemptsFile,
            ref: this.relativeArtifactRef(attemptsFile, `attempts-${base.taskId}`),
            refKind: 'bytes',
          },
        ],
        'implementation.json'
      );

      // The workspace record lets a LATER step re-derive the run profile. It is keyed by the
      // implementation hash, which IS the implementation's identity, so a re-patched implementation
      // gets a new record and can never resolve the old one.
      const records = this.readJsonMap<WorkspaceRecord>(this.indexPath('workspaces.json'));
      records.set(snapshot.implementationHash, {
        implementationHash: snapshot.implementationHash,
        operationId: published.id,
        taskId: base.taskId,
        sourceRoot: workspace.sourceRoot,
        workspaceRoot: workspace.workspaceRoot,
        allowedPaths: [...plan.allowedPaths],
        forbiddenPaths: [...plan.forbiddenPaths],
        sourceTreeHash: treeHash(workspace.sourcePins),
        workspaceTreeHash: workspace.workspaceTreeHash(),
        fullDiffHash: applied.diff.diffHash,
      });
      this.writeJsonAtomic(this.indexPath('workspaces.json'), Object.fromEntries(records));

      this.advanceRevision(base.taskId);
      return { receipt, operation: published, result: snapshot };
    } catch (err) {
      const failed = this.failOperation(operation, err);
      // The attempt log is the evidence for WHY the adaptation was refused. On a refusal the throw
      // happens inside applyHumanPatch/applyAgentPatch, which is BEFORE the success path below ever
      // stages attempts.json, so the log is written here: a refused patch must still publish the
      // record of what it tried and which FIRST error stopped it, or the host has nothing to read.
      const attemptLog = path.join(staging, 'attempts.json');
      const attempts = workspace ? workspace.listAttempts() : [];
      if (workspace && attempts.length > 0 && !fs.existsSync(attemptLog)) {
        this.writeStagedJson(attemptLog, { attempts, firstError: workspace.firstError() });
      }
      if (fs.existsSync(attemptLog)) this.attachDiagnostic(failed, attemptLog, `attempts-${base.taskId}`);
      throw err;
    }
  }

  /** `human`: the plan requires a submitted patch, and it must be one this owner really submitted. */
  private applyHumanPatch(
    workspace: PatchWorkspace,
    submittedPatchRef: ArtifactRef | undefined,
    taskId: string,
    ownerSessionId: string
  ): { patchText: string; diff: FullDiffReport } {
    if (!submittedPatchRef) {
      throw new ExperimentError(
        'INVALID_INPUT',
        'the plan declares patchProvider "human"; a submittedPatchRef is required and an agent patch may not stand in for it',
        { fieldPaths: ['submittedPatchRef'] }
      );
    }
    const record = this.readJsonMap<SubmittedPatchRecord>(this.indexPath('submitted.json')).get(submittedPatchRef.sha256);
    if (!record) {
      throw new ExperimentError('NOT_FOUND', `submittedPatchRef "${submittedPatchRef.id}" was never submitted to this host`, {
        fieldPaths: ['submittedPatchRef'],
      });
    }
    if (record.ownerSessionId !== ownerSessionId) {
      throw new ExperimentError('OWNER_MISMATCH', 'the submitted patch belongs to another owner', {
        fieldPaths: ['submittedPatchRef'],
      });
    }
    if (record.taskId !== taskId) {
      throw new ExperimentError('SOURCE_MISMATCH', 'the submitted patch was submitted for another task', {
        fieldPaths: ['submittedPatchRef'],
      });
    }
    const file = this.submittedPatchPath(submittedPatchRef.sha256);
    if (!fs.existsSync(file)) {
      throw new ExperimentError('ARTIFACT_CORRUPT', `submitted patch "${submittedPatchRef.id}" is missing from disk`);
    }
    const patchText = fs.readFileSync(file, 'utf8');
    if (sha256Hex(patchText) !== submittedPatchRef.sha256) {
      throw new ExperimentError('ARTIFACT_CORRUPT', 'the submitted patch content hash drifted', {
        fieldPaths: ['submittedPatchRef'],
      });
    }
    const report = workspace.applyPatch(patchText, { label: 'human-initial' });
    workspace.assertApplied(report);
    if (!report.diff) {
      throw new ExperimentError('INVALID_RESULT', 'an applied patch produced no full diff');
    }
    // `report.diff` is the diff TEXT; the full original-vs-adapted report (with the path policy
    // verdict) comes from `fullDiff()`, which reads the real bytes rather than echoing the patch.
    const diff = workspace.fullDiff();
    if (diff.text !== report.diff) {
      throw new ExperimentError('ARTIFACT_CORRUPT', 'the reported diff does not match the workspace content');
    }
    this.assertDiffStaysInsideAllowedPaths(diff);
    return { patchText, diff };
  }

  /**
   * `agent`: the host port writes a patch and every attempt is applied through the SAME
   * `PatchWorkspace` policy. `maxRepairAttempts` is a hard stop and the FIRST error is kept.
   */
  private async applyAgentPatch(
    workspace: PatchWorkspace,
    plan: AdaptationPlan,
    taskId: string
  ): Promise<{ patchText: string; diff: FullDiffReport }> {
    if (!this.agentPatchProvider) {
      throw new ExperimentError(
        'UNSUPPORTED_CAPABILITY',
        'the plan declares patchProvider "agent" but this host has no reviewed agent patch provider',
        { fieldPaths: ['patchProvider'] }
      );
    }
    let previousError: { code: string; message: string } | null = null;
    while (workspace.submissionsUsed < workspace.maxSubmissions) {
      const patchText = await this.agentPatchProvider({
        taskId,
        plan,
        workspaceRoot: workspace.workspaceRoot,
        sourceRoot: workspace.sourceRoot,
        allowedPaths: workspace.policy.allowedPaths,
        forbiddenPaths: workspace.policy.forbiddenPaths ?? [],
        attemptIndex: workspace.submissionsUsed + 1,
        previousError,
        workspaceTreeHash: workspace.workspaceTreeHash(),
      });
      const report = workspace.applyPatch(patchText, { label: `agent-attempt-${workspace.submissionsUsed + 1}` });
      if (report.outcome === 'applied' && report.diff) {
        const diff = workspace.fullDiff();
        if (diff.text !== report.diff) {
          throw new ExperimentError('ARTIFACT_CORRUPT', 'the reported diff does not match the workspace content');
        }
        this.assertDiffStaysInsideAllowedPaths(diff);
        return { patchText, diff };
      }
      previousError = {
        code: report.record.errorCode ?? 'INVALID_INPUT',
        message: report.record.message ?? 'the patch was not applied',
      };
    }
    const first = workspace.firstError();
    throw new ExperimentError(
      'REPAIR_EXHAUSTED',
      `repair attempts are used up (${workspace.submissionsUsed}/${workspace.maxSubmissions}); first error: ${
        first ? `${first.errorCode} ${first.message}` : 'none'
      }`,
      { fieldPaths: ['maxRepairAttempts'] }
    );
  }

  /** A diff that reached a path the plan never allowed is a policy breach, not a warning. */
  private assertDiffStaysInsideAllowedPaths(diff: FullDiffReport): void {
    if (diff.unexpectedPaths.length > 0) {
      throw new ExperimentError(
        'POLICY_DENIED',
        `the adaptation changed path(s) outside allowedPaths: ${diff.unexpectedPaths.join(', ')}`,
        { fieldPaths: ['allowedPaths'] }
      );
    }
  }

  private buildMechanismDiff(
    plan: AdaptationPlan,
    diff: FullDiffReport,
    resolved: ResolvedTaskProfile
  ): ImplementationSnapshot['mechanismDiff'] {
    const changed = new Set(diff.changedPaths);
    const entries: ImplementationSnapshot['mechanismDiff'] = [];
    for (const binding of plan.bindings) {
      for (const sourceModuleId of binding.orderedModuleIds) {
        const pinned = this.resolvePinnedModule(sourceModuleId);
        const rel = toPosix(path.relative(this.sourceCheckoutAbs, pinned.implementationPath));
        const touched = changed.has(rel);
        entries.push({
          mechanism: pinned.id,
          status: touched ? 'changed' : 'preserved',
          detail: touched
            ? `the patch changed ${rel}; the mechanism this module implements is a REVISION of the declared hypothesis and must be re-checked rather than silently accepted`
            : `the patch did not touch ${rel}; the module's declared mechanism is preserved byte-for-byte`,
          evidenceRefs: [diff.diffHash],
        });
      }
      entries.push({
        mechanism: `declared_order:${binding.slotId}`,
        status: 'preserved',
        detail: `the binding order [${binding.orderedModuleIds.join(' > ')}] is host-declared and a patch cannot reorder it; the compiled recipe echoes it as declaredOrder`,
        evidenceRefs: [diff.diffHash],
      });
    }
    entries.push({
      mechanism: 'path_policy',
      status: 'expected',
      detail: `every changed path is covered by the plan's allowedPaths and no always-forbidden path was reachable: [${diff.changedPaths.join(', ')}]`,
      evidenceRefs: [diff.diffHash],
    });
    return entries;
  }

  private buildResolvedConfig(
    plan: AdaptationPlan,
    resolved: ResolvedTaskProfile,
    workspace: PatchWorkspace
  ): Record<string, unknown> {
    return {
      schemaVersion: 1,
      profileRef: resolved.profileRef,
      planHash: plan.planHash,
      bindings: plan.bindings,
      dependencyPolicyRef: plan.dependencyPolicyRef,
      workspaceTreeHash: workspace.workspaceTreeHash(),
      batchSize: resolved.batchSize,
      learningRate: resolved.learningRate,
      timeoutMs: this.runTimeoutMs,
      dataSpec: resolved.dataSpec,
      device: resolved.environment.device,
      interpreterSha256: resolved.environment.interpreter.sha256,
      packageLockSha256: resolved.environment.packageLock.sha256,
    };
  }

  /** The throwaway workspace that produced an implementation. Keyed by the implementation identity. */
  resolveWorkspace(implementationHash: string): WorkspaceRecord {
    const found = this.readJsonMap<WorkspaceRecord>(this.indexPath('workspaces.json')).get(implementationHash);
    if (!found) {
      throw new ExperimentError(
        'DEPENDENCY_NOT_READY',
        `no adaptation workspace is recorded for implementation ${implementationHash.slice(0, 12)}...`,
        { fieldPaths: ['implementationRef'] }
      );
    }
    if (!fs.existsSync(found.workspaceRoot)) {
      throw new ExperimentError(
        'RECONCILIATION_REQUIRED',
        `the adaptation workspace for ${implementationHash.slice(0, 12)}... is gone: ${found.workspaceRoot}`,
        { fieldPaths: ['workspaceRoot'] }
      );
    }
    return found;
  }

  // -------------------------------------------------------------------------
  // Step 4: validateImplementation
  // -------------------------------------------------------------------------

  /**
   * Runs the REAL mechanism probe over the adapted implementation and publishes a `CheckReport`.
   *
   * The report is published even when required checks FAIL: a `failed` report is the evidence that
   * smoke must not run, and hiding it behind a thrown error would lose the reason. The operation
   * therefore succeeds whenever a report was produced; what it can never do is report a friendlier
   * status than its checks (the frozen validator refuses that).
   */
  async validateImplementation(
    request: ValidateImplementationRequest,
    actor: ExperimentCallerActor
  ): Promise<ExperimentOutcome<CheckReport>> {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(request, ['implementationRef', 'profileRef'], 'ValidateImplementationRequest');
    this.assertHostEnvelope(base, 'ValidateImplementationRequest');
    const resolved = this.profile();
    const implementationRef = expAssertArtifactRef(
      request.implementationRef,
      'ValidateImplementationRequest.implementationRef'
    );
    const profileRef = expAssertId(request.profileRef, 'ValidateImplementationRequest.profileRef');
    if (profileRef !== resolved.profile.id && profileRef !== resolved.profileRef) {
      throw new ExperimentError(
        'INCOMPATIBLE_BINDING',
        `profileRef "${profileRef}" does not name the host profile "${resolved.profileRef}"`,
        { fieldPaths: ['profileRef'] }
      );
    }

    const requestHash = computeExperimentRequestHash({
      method: 'validateImplementation',
      taskId: base.taskId,
      policyRef: base.policyRef,
      budgetRef: base.budgetRef,
      implementationRef,
      profileRef,
    });
    const reserved = this.reserveOrReuse(ownerSessionId, base.taskId, 'validateImplementation', base.commandId, requestHash);
    if (reserved.reused && reserved.receipt) {
      return this.replayOutcome<CheckReport>(reserved.operationId, reserved.receipt, 'CheckReport');
    }
    const task = this.assertTaskOwnership(base.taskId, actor);
    this.assertRevision(task, base.expectedRevision);

    const operation = this.createOperation(reserved.operationId, actor, base, requestHash, null);
    const staging = this.stagingDir(operation.id, base.taskId);
    const receipt: ExecutionReceipt = {
      operationId: operation.id,
      commandId: base.commandId,
      requestHash,
      taskRevision: task.revision,
    };
    this.recordReceipt(ownerSessionId, base.taskId, 'validateImplementation', base.commandId, receipt);
    this.transition(operation, 'running');

    try {
      const snapshot = validateImplementationSnapshot(
        this.readPublishedArtifact<ImplementationSnapshot>(implementationRef, 'implementationRef').value
      );
      if (snapshot.implementationHash !== implementationRef.sha256) {
        throw new ExperimentError(
          'SOURCE_MISMATCH',
          'the implementation artifact does not carry the hash its reference declares',
          { fieldPaths: ['implementationRef'] }
        );
      }
      const plan = validateAdaptationPlan(
        this.readPublishedArtifact<AdaptationPlan>(snapshot.planRef, 'implementation.planRef').value
      );
      const workspace = this.resolveWorkspace(snapshot.implementationHash);
      const declared = this.buildDeclaredMechanisms(plan, resolved, workspace);
      const checkProfile = this.taskCheckProfile();
      const combination = this.buildCombinationInput(plan, declared, checkProfile, implementationRef);
      const engine = this.mechanismCheckRunner({
        profile: checkProfile,
        subjectRef: implementationRef,
        declared,
        ...(combination ? { combination } : {}),
        pythonPath: this.pythonPath,
        repoRoot: this.repoRoot,
      });
      const report = validateCheckReport(engine.report);
      if (report.subjectRef.sha256 !== snapshot.implementationHash) {
        throw new ExperimentError('INVALID_RESULT', 'the check report does not describe the implementation that was validated', {
          fieldPaths: ['subjectRef'],
        });
      }

      const probeFile = path.join(staging, 'probe-run.json');
      this.writeStagedJson(probeFile, serializeProbeRun(engine.probe));
      const summaryFile = path.join(staging, 'check-summary.json');
      this.writeStagedJson(summaryFile, {
        summary: summarizeCheckReport(report),
        declared: declared.map((d) => ({ moduleId: d.moduleId, mechanismKind: d.mechanismKind, probeJob: d.probeJob })),
        probeFailure: engine.probe.failure,
        probeExitCode: engine.probe.exitCode,
        probeCommand: engine.probe.command,
      });
      const reportFile = path.join(staging, 'check-report.json');
      this.writeStagedJson(reportFile, report);

      const published = this.publish(
        operation,
        [
          {
            name: 'check-report.json',
            file: reportFile,
            ref: { id: `check-report-${snapshot.implementationHash.slice(0, 12)}`, sha256: report.reportHash },
            refKind: 'object',
          },
          {
            name: 'probe-run.json',
            file: probeFile,
            ref: this.relativeArtifactRef(probeFile, `probe-run-${base.taskId}`),
            refKind: 'bytes',
          },
          {
            name: 'check-summary.json',
            file: summaryFile,
            ref: this.relativeArtifactRef(summaryFile, `check-summary-${base.taskId}`),
            refKind: 'bytes',
          },
        ],
        'check-report.json'
      );
      this.advanceRevision(base.taskId);
      return { receipt, operation: published, result: report };
    } catch (err) {
      this.failOperation(operation, err);
      throw err;
    }
  }

  /**
   * Turns the plan's bindings into the host declaration the mechanism engine measures against. Every
   * field is host-owned: the module path is derived from the workspace, the class from the host pin,
   * and the shape/dtype/device from the profile's slot schema.
   */
  private buildDeclaredMechanisms(
    plan: AdaptationPlan,
    resolved: ResolvedTaskProfile,
    workspace: WorkspaceRecord
  ): DeclaredMechanism[] {
    const slot = resolved.profile.slots[0];
    const schema = resolved.slotSchemas.schemas[slot.outputSchemaRef];
    const expectedShape = [resolved.batchSize, schema.shape[1], schema.shape[2], schema.shape[3]];
    const steps = this.constraints.mechanismSteps ?? 3;
    const declared: DeclaredMechanism[] = [];
    for (const binding of plan.bindings) {
      for (const sourceModuleId of binding.orderedModuleIds) {
        // The mechanism declaration is keyed by the PROFILE-pinned module id, because that is the id
        // the compiled recipe and the runner's `modulesExecuted` record use. The SourceBundle id the
        // binding named is host-mapped onto it (constraints.moduleIdMap) and kept in the summary.
        const pinned = this.resolvePinnedModule(sourceModuleId);
        const moduleId = pinned.id;
        const modulePath = this.adaptedModulePath(workspace, pinned.implementationPath);
        const override = this.constraints.mechanismDeclarations?.[sourceModuleId] ?? this.constraints.mechanismDeclarations?.[moduleId] ?? {};
        declared.push({
          moduleId,
          mechanismKind: pinned.mechanismKind as MechanismKind,
          probeJob: probeJobFor(pinned.mechanismKind as MechanismKind),
          modulePath,
          className: pinned.className,
          expectedShape,
          expectedDtype: schema.dtype,
          expectedDevice: schema.device,
          steps,
          ...override,
        });
      }
    }
    if (declared.length === 0) {
      throw new ExperimentError('CONFIG_INCOMPLETE', 'the plan binds no module, so nothing can be checked', {
        fieldPaths: ['bindings'],
      });
    }
    return declared;
  }

  /**
   * The workspace copy of a pinned module, with its containment re-checked here rather than assumed:
   * inside the workspace root, covered by the plan's allowedPaths, and not always-forbidden.
   */
  private adaptedModulePath(workspace: WorkspaceRecord, pinnedImplementationPath: string): string {
    const rel = toPosix(path.relative(workspace.sourceRoot, pinnedImplementationPath));
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ExperimentError(
        'SOURCE_MISMATCH',
        `pinned module ${pinnedImplementationPath} is not inside the source checkout ${workspace.sourceRoot}`
      );
    }
    if (isAlwaysForbidden(rel)) {
      throw new ExperimentError('POLICY_DENIED', `module path "${rel}" is on the always-forbidden list`, {
        fieldPaths: ['modulePath'],
      });
    }
    if (isPathCovered(rel, workspace.forbiddenPaths, true)) {
      throw new ExperimentError('POLICY_DENIED', `module path "${rel}" is forbidden by the plan`, {
        fieldPaths: ['modulePath'],
      });
    }
    if (!isPathCovered(rel, workspace.allowedPaths)) {
      throw new ExperimentError('POLICY_DENIED', `module path "${rel}" is outside the plan's allowedPaths`, {
        fieldPaths: ['modulePath'],
      });
    }
    const abs = path.join(workspace.workspaceRoot, ...rel.split('/'));
    const prefix = workspace.workspaceRoot + path.sep;
    if (abs !== workspace.workspaceRoot && !abs.startsWith(prefix)) {
      throw new ExperimentError('POLICY_DENIED', `derived module path escapes the patch workspace: "${rel}"`, {
        fieldPaths: ['modulePath'],
      });
    }
    if (!fs.existsSync(abs)) {
      throw new ExperimentError('NOT_FOUND', `adapted module is missing from the workspace: ${abs}`, {
        fieldPaths: ['modulePath'],
      });
    }
    return toPosix(abs);
  }

  /**
   * SPEC section 4 row 5: per-module ready is not proof of a combination. A binding with two or more
   * modules therefore needs a host-declared composition contract, and each member is measured ALONE
   * before the combination is measured with a real run of its own.
   */
  private buildCombinationInput(
    plan: AdaptationPlan,
    declared: DeclaredMechanism[],
    checkProfile: MechanismCheckProfile,
    implementationRef: ArtifactRef
  ): CombinationInput | undefined {
    const ordered = plan.bindings.flatMap((b) => b.orderedModuleIds.map((id) => this.resolvePinnedModule(id).id));
    if (ordered.length < 2) return undefined;
    if (!this.constraints.combination) {
      throw new ExperimentError(
        'CONFIG_INCOMPLETE',
        `the plan binds ${ordered.length} modules but the host declares no combination contract (functions, sharedState, parameterSources); without it the combination cannot be assessed and must not be treated as passed`,
        { fieldPaths: ['combination'] }
      );
    }
    const perModule = ordered.map((moduleId) => {
      const single = declared.filter((d) => d.moduleId === moduleId);
      const engine = this.mechanismCheckRunner({
        profile: checkProfile,
        subjectRef: implementationRef,
        declared: single,
        pythonPath: this.pythonPath,
        repoRoot: this.repoRoot,
      });
      return { moduleId, report: validateCheckReport(engine.report) };
    });
    return {
      id: plan.bindings[0].slotId,
      declaredOrder: ordered,
      perModule,
      // The composition facts are host-declared, but they name modules; mapping them onto the same
      // profile-pinned ids the per-module reports and the combination run use keeps the comparison
      // about the composition rather than about two spellings of the same module.
      declared: {
        functions: this.constraints.combination.functions.map((f) => ({
          function: f.function,
          moduleIds: f.moduleIds.map((id) => this.resolvePinnedModule(id).id),
        })),
        sharedState: this.constraints.combination.sharedState.map((s) => ({
          name: s.name,
          moduleIds: s.moduleIds.map((id) => this.resolvePinnedModule(id).id),
        })),
        parameterSources: this.constraints.combination.parameterSources.map((p) => ({
          owner: this.constraints.moduleIdMap?.[p.owner] ?? p.owner,
          parameterCount: p.parameterCount,
        })),
      },
      observed: { sharedState: [] },
    };
  }

  // -------------------------------------------------------------------------
  // Step 5 + 7: runLightweight
  // -------------------------------------------------------------------------

  /**
   * Runs the smoke or tiny protocol with the profile's three registered functions and publishes a
   * `LightweightResult`.
   *
   * Smoke requires a PASSING validation report for the same implementation and profile, and that
   * check runs BEFORE any operation is created: a required check failure therefore cannot reach a
   * run at all. Tiny requires a registered executable and reads the validation report that executable
   * is bound to.
   */
  async runLightweight(
    request: RunLightweightRequest,
    actor: ExperimentCallerActor
  ): Promise<ExperimentOutcome<LightweightResult>> {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(
      request,
      ['mode', 'subjectRef', 'runProtocolRef', 'validationRef'],
      'RunLightweightRequest'
    );
    this.assertHostEnvelope(base, 'RunLightweightRequest');
    const resolved = this.profile();
    const mode = expAssertEnum(request.mode, ['smoke', 'tiny'] as const, 'RunLightweightRequest.mode');
    const subjectRef = expAssertArtifactRef(request.subjectRef, 'RunLightweightRequest.subjectRef');
    const runProtocolRef = expAssertArtifactRef(request.runProtocolRef, 'RunLightweightRequest.runProtocolRef');
    const validationRef =
      request.validationRef === undefined
        ? undefined
        : expAssertArtifactRef(request.validationRef, 'RunLightweightRequest.validationRef');
    const protocol = this.protocols[mode].body;
    validateLightweightProtocol(protocol);
    assertModeProtocolShape(mode, protocol);
    if (mode === 'smoke') assertSmokeProtocolShape(protocol);
    this.assertHostRef(runProtocolRef, this.protocolRefFor(mode), 'RunLightweightRequest.runProtocolRef');

    // ---- PREFLIGHT (reads only, no operation, no budget) ----
    let checkReportRef: ArtifactRef;
    let runSubjectRef: ArtifactRef = subjectRef;
    let bindings: readonly PlanBinding[];
    let implementationHash: string;
    if (mode === 'smoke') {
      if (!validationRef) {
        throw new ExperimentError(
          'INVALID_INPUT',
          'a smoke run requires validationRef: a run may not start without a passing required-check report',
          { fieldPaths: ['validationRef'] }
        );
      }
      const implementation = validateImplementationSnapshot(
        this.readPublishedArtifact<ImplementationSnapshot>(subjectRef, 'subjectRef').value
      );
      const validation = validateCheckReport(
        this.readPublishedArtifact<CheckReport>(validationRef, 'validationRef').value
      );
      this.assertValidationAppliesTo(implementation, validation, resolved.profileRef, validationRef);
      const plan = validateAdaptationPlan(
        this.readPublishedArtifact<AdaptationPlan>(implementation.planRef, 'implementation.planRef').value
      );
      bindings = plan.bindings;
      checkReportRef = validationRef;
      implementationHash = implementation.implementationHash;
    } else {
      const executable = validateExecutableSnapshot(
        this.readPublishedArtifact<ExecutableSnapshot>(subjectRef, 'subjectRef').value
      );
      assertTinyPreconditions(executable, protocol);
      const validation = validateCheckReport(
        this.readPublishedArtifact<CheckReport>(executable.validationRef, 'executable.validationRef').value
      );
      if (validation.status !== 'passed') {
        throw new ExperimentError('MODULE_NOT_READY', 'the registered executable is bound to a non-passing validation report', {
          fieldPaths: ['validationRef'],
        });
      }
      const smoke = validateLightweightResult(
        this.readPublishedArtifact<LightweightResult>(executable.smokeRef, 'executable.smokeRef').value
      );
      if (smoke.mode !== 'smoke' || smoke.conclusion === 'needs_revision') {
        throw new ExperimentError('MODULE_NOT_READY', 'the registered executable has no runnable smoke result', {
          fieldPaths: ['smokeRef'],
        });
      }
      const implementation = validateImplementationSnapshot(
        this.readPublishedArtifact<ImplementationSnapshot>(executable.implementationRef, 'executable.implementationRef').value
      );
      const plan = validateAdaptationPlan(
        this.readPublishedArtifact<AdaptationPlan>(implementation.planRef, 'implementation.planRef').value
      );
      bindings = plan.bindings;
      checkReportRef = executable.validationRef;
      implementationHash = implementation.implementationHash;
    }

    // ---- BUDGET: the declared sweep must fit the frozen ceilings ----
    const plannedRuns = protocol.variants.length * protocol.seeds.length;
    if (plannedRuns > this.budget.maxTrials) {
      throw new ExperimentError(
        'BUDGET_EXHAUSTED',
        `the ${mode} protocol expands to ${plannedRuns} run(s), above the frozen maxTrials ${this.budget.maxTrials}`,
        { fieldPaths: ['maxTrials'] }
      );
    }
    if (this.budget.maxModelCalls !== 0) {
      throw new ExperimentError(
        'CONFIG_INCOMPLETE',
        'this profile performs no model call; a budget with maxModelCalls > 0 must not be used for a run it cannot bound',
        { fieldPaths: ['maxModelCalls'] }
      );
    }

    const requestHash = computeExperimentRequestHash({
      method: 'runLightweight',
      taskId: base.taskId,
      policyRef: base.policyRef,
      budgetRef: base.budgetRef,
      mode,
      subjectRef,
      runProtocolRef,
      validationRef: validationRef ?? null,
    });
    const methodKey = `runLightweight:${mode}`;
    const reserved = this.reserveOrReuse(ownerSessionId, base.taskId, methodKey, base.commandId, requestHash);
    if (reserved.reused && reserved.receipt) {
      return this.replayOutcome<LightweightResult>(reserved.operationId, reserved.receipt, 'LightweightResult');
    }
    const task = this.assertTaskOwnership(base.taskId, actor);
    this.assertRevision(task, base.expectedRevision);

    const operation = this.createOperation(reserved.operationId, actor, base, requestHash, null);
    const staging = this.stagingDir(operation.id, base.taskId);
    const receipt: ExecutionReceipt = {
      operationId: operation.id,
      commandId: base.commandId,
      requestHash,
      taskRevision: task.revision,
    };
    this.recordReceipt(ownerSessionId, base.taskId, methodKey, base.commandId, receipt);
    this.transition(operation, 'running');

    try {
      if (this.rootBudgetBinding) await assertResourceMonitorAvailable();
      const rootReservation = this.rootBudgetBinding
        ? this.rootBudgetBinding.ledger.reserveSweep({
            reservationId: operation.id,
            attemptId: this.rootBudgetBinding.attemptId,
            plannedTrials: plannedRuns,
            device: this.rootBudgetBinding.device,
          })
        : undefined;
      this.beginRunAborts(operation.id);
      const outcome = await this.executeProtocol(mode, protocol, bindings, implementationHash, staging, operation.id, rootReservation);
      let rootBudgetViolations: string[] = [];
      if (rootReservation) {
        if (outcome.executorInvocations !== outcome.facts.length) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', `runner operation ${operation.id} has an invocation without returned process facts; its root reservation remains open`);
        }
        const missingResourceFacts = outcome.facts.find((fact) =>
          !Number.isSafeInteger(fact.peakWorkingSetBytes) || !Number.isSafeInteger(fact.outputBytes) ||
          !Number.isSafeInteger(fact.resourceSampleCount) || (fact.resourceSampleCount ?? 0) <= 0,
        );
        if (missingResourceFacts) {
          throw new ExperimentError('RECONCILIATION_REQUIRED', `runner facts for ${missingResourceFacts.runId} lack complete root resource samples; its reservation remains open`);
        }
        rootBudgetViolations = this.rootBudgetBinding!.ledger.settleSweep(operation.id, {
          attemptedTrials: outcome.facts.length,
          executionMs: outcome.facts.reduce((sum, fact) => sum + fact.durationMs, 0),
          stagedOutputBytes: outcome.facts.reduce((sum, fact) => sum + (fact.outputBytes ?? 0), 0),
          peakWorkingSetBytes: outcome.facts.map((fact) => fact.peakWorkingSetBytes!),
          executionFactsComplete: true,
        });
        if (rootBudgetViolations.length > 0) {
          outcome.conclusion = 'needs_revision';
          outcome.firstFailure ??= new ExperimentError('BUDGET_EXHAUSTED', `root resource ceiling exceeded: ${rootBudgetViolations.join(', ')}`);
        }
      }
      // The controller is dropped as soon as the sweep ends, so a LATER stop
      // request cannot abort a finished run or the next one.
      this.endRunAborts(operation.id);

      const costFile = path.join(staging, 'cost.json');
      const cost = {
        schemaVersion: 1,
        mode,
        profileRef: resolved.profileRef,
        plannedRuns,
        startedRuns: outcome.facts.length,
        completedRuns: outcome.verified.length,
        totalDurationMs: outcome.facts.reduce((sum, f) => sum + f.durationMs, 0),
        limit: protocol.limit,
        runs: outcome.facts.map((f) => ({
          runId: f.runId,
          exitCode: f.exitCode,
          timedOut: f.timedOut,
          durationMs: f.durationMs,
          ...(rootReservation ? {
            peakWorkingSetBytes: f.peakWorkingSetBytes,
            outputBytes: f.outputBytes,
            resourceSampleCount: f.resourceSampleCount,
            resourceLimitExceeded: f.resourceLimitExceeded ?? null,
          } : {}),
        })),
        ...(rootReservation ? {
          rootBudget: {
            reservationId: rootReservation.reservationId,
            attemptId: rootReservation.attemptId,
            reservedExecutionMs: rootReservation.maxExecutionMs,
            reservedTrials: rootReservation.plannedTrials,
            maxWorkingSetBytesPerTrial: rootReservation.maxMemoryBytes,
            maxOutputBytesPerTrial: rootReservation.maxOutputBytesPerTrial,
            violations: rootBudgetViolations,
          },
        } : {}),
        budget: {
          perAttemptTimeoutMs: this.runTimeoutMs,
          maxExecutionSeconds: this.budget.maxExecutionSeconds,
          maxTrials: this.budget.maxTrials,
        },
      };
      this.writeStagedJson(costFile, cost);
      const costRef: ArtifactRef = {
        id: `cost-${operation.id}`,
        sha256: typedHash(HOST_REF_DOMAINS.cost, cost),
      };

      const metricStaged: StagedArtifact[] = [];
      const metricRefs: ArtifactRef[] = [];
      outcome.observations.forEach((observation, index) => {
        validateMetricObservation(observation, 'MetricObservation');
        // The name carries the arm, not just an index: a reader (or a later comparison) must be
        // able to tell which variant a published number belongs to without joining it back to
        // cost.json and inferring from ordering.
        const arm = observation.variant ? `${observation.variant}-s${observation.seed ?? 0}-` : '';
        const name = `metric-${arm}${index}-${observation.metricId}.json`;
        const file = path.join(staging, name);
        this.writeStagedJson(file, observation);
        const ref = this.relativeArtifactRef(file, `metric-${operation.id}-${arm}${index}`);
        metricRefs.push(ref);
        metricStaged.push({ name, file, ref, refKind: 'bytes' });
      });

      const resultBody = {
        mode,
        subjectRef: runSubjectRef,
        protocolRef: { id: `protocol-${protocol.protocolHash.slice(0, 12)}`, sha256: protocol.protocolHash },
        manifestRefs: outcome.manifestRefs,
        executionFactsRefs: outcome.factsRefs,
        checkReportRef,
        metricRefs,
        costRef,
        conclusion: outcome.conclusion,
      };
      const result: LightweightResult = {
        ...resultBody,
        resultHash: computeLightweightResultHash(resultBody),
      } as LightweightResult;
      validateLightweightResult(result);

      const resultFile = path.join(staging, `${mode}-result.json`);
      this.writeStagedJson(resultFile, result);
      const published = this.publish(
        operation,
        [
          {
            name: `${mode}-result.json`,
            file: resultFile,
            ref: { id: `${mode}-result-${base.taskId}`, sha256: result.resultHash },
            refKind: 'object',
          },
          { name: 'cost.json', file: costFile, ref: costRef, refKind: 'object' },
          // The run evidence the result already references. Publishing the refs without the bytes
          // would leave every manifestRef and executionFactsRef in this result pointing at a file
          // that exists only in staging, which SPEC section 3 forbids and which makes the published
          // result unusable as evidence.
          ...outcome.evidenceFiles,
          ...metricStaged,
        ],
        `${mode}-result.json`
      );

      if (outcome.firstFailure) {
        // SPEC section 3: a failure is diagnosed from diagnosticRef before any repair is decided.
        const firstErrorFile = path.join(staging, 'first-error.json');
        this.writeStagedJson(firstErrorFile, { ...outcome.firstFailure.toExecutionError(), mode, runnable: false });
        this.attachDiagnostic(published, firstErrorFile, `first-error-${operation.id}`);
      }
      this.advanceRevision(base.taskId);
      return { receipt, operation: this.loadOperation(published.id), result };
    } catch (err) {
      this.endRunAborts(operation.id);
      const failed = this.failOperation(operation, err);
      const failureLog = path.join(staging, 'protocol-failure.json');
      if (fs.existsSync(failureLog)) this.attachDiagnostic(failed, failureLog, `protocol-failure-${operation.id}`);
      throw err;
    }
  }

  /**
   * The smoke/registration applicability rule (SPEC section 3): the validation report must describe
   * the CURRENT implementation content, under the same profile, with its required checks passed.
   */
  private assertValidationAppliesTo(
    implementation: ImplementationSnapshot,
    validation: CheckReport,
    profileRef: string,
    validationRef: ArtifactRef
  ): void {
    if (validation.subjectRef.sha256 !== implementation.implementationHash) {
      throw new ExperimentError(
        'MODULE_NOT_READY',
        'the validation report does not describe the current implementation content; a changed patch invalidates the old report',
        { fieldPaths: ['validationRef'] }
      );
    }
    if (validation.reportHash !== validationRef.sha256) {
      throw new ExperimentError('MODULE_NOT_READY', 'the validation ref does not carry the report content hash', {
        fieldPaths: ['validationRef'],
      });
    }
    if (validation.profileRef !== profileRef) {
      throw new ExperimentError('MODULE_NOT_READY', 'the validation report was produced under a different profile', {
        fieldPaths: ['validationRef'],
      });
    }
    if (validation.status !== 'passed') {
      throw new ExperimentError(
        'MODULE_NOT_READY',
        `required checks did not pass (status ${validation.status}); a run must not start on this implementation`,
        { fieldPaths: ['validationRef'] }
      );
    }
  }

  /**
   * Runs one child process per (variant, seed) through the profile's compile/prepare/verify trio.
   * A failure keeps the FIRST error and stops the sweep; the conclusion then says so rather than
   * publishing a friendlier status.
   */
  private async executeProtocol(
    mode: LightweightMode,
    protocol: LightweightProtocol,
    bindings: readonly PlanBinding[],
    implementationHash: string,
    staging: string,
    operationId: string,
    rootReservation?: RootTrialReservation,
  ): Promise<{
    conclusion: LightweightResult['conclusion'];
    facts: RunFacts[];
    executorInvocations: number;
    verified: VerifiedRun[];
    observations: MetricObservation[];
    manifestRefs: ArtifactRef[];
    factsRefs: ArtifactRef[];
    /**
     * The on-disk paths behind `manifestRefs` / `factsRefs`, paired with them.
     *
     * A ref that names a file nobody published is worse than no ref: it looks like evidence and
     * resolves to nothing. SPEC section 3 requires each step to read PUBLISHED artifacts and never
     * a staging path, so the run evidence has to be carried through publish alongside the refs that
     * already pointed at it.
     */
    evidenceFiles: Array<{ name: string; file: string; ref: ArtifactRef; refKind: 'bytes' | 'object' }>;
    firstFailure: ExperimentError | null;
  }> {
    const workspace = this.resolveWorkspace(implementationHash);
    const derived = this.deriveRunProfile(workspace, bindings);
    const facts: RunFacts[] = [];
    const verified: VerifiedRun[] = [];
    const observations: MetricObservation[] = [];
    const manifestRefs: ArtifactRef[] = [];
    const factsRefs: ArtifactRef[] = [];
    const evidenceFiles: Array<{ name: string; file: string; ref: ArtifactRef; refKind: 'bytes' | 'object' }> = [];
    let firstFailure: ExperimentError | null = null;
    let executorInvocations = 0;
    const planned = protocol.variants.length * protocol.seeds.length;
    let attempted = 0;

    for (const variant of protocol.variants) {
      for (const seed of protocol.seeds) {
        if (firstFailure) break;
        // A cancelled sweep STOPS: killing the running child is not enough if the
        // next arm is then spawned anyway. A "cancelled" run that goes on to
        // launch the remaining trials is not a cancellation.
        if (this.runAbortController(operationId)?.signal.aborted) {
          throw new ExperimentError(
            'HOST_BUSY',
            `operation ${operationId} was cancelled before arm ${variant}/s${seed} started; the remaining trials were not launched`,
            { fieldPaths: ['status'] },
          );
        }
        attempted += 1;
        // A new run identity per execution, so a rerun is never mistaken for a cache hit.
        const runNonce = `${operationId}-${variant}-${seed}-${crypto.randomUUID().slice(0, 8)}`;
        const outputDir = path.join(staging, 'runs', `${variant}-s${seed}`);
        try {
          const prepared = prepareRun(derived, protocol, variant, seed, {
            runNonce,
            outputDir,
            bindings: this.toProfileBindings(bindings),
            implementation: { implementationHash },
          });
          const manifestPath = materializeManifest(prepared, derived);
          executorInvocations += 1;
          const runFacts = await this.runExecutor(
            derived,
            prepared,
            manifestPath,
            this.runAbortController(operationId)?.signal,
            rootReservation ? {
              maxWorkingSetBytes: rootReservation.maxMemoryBytes,
              maxOutputBytes: rootReservation.maxOutputBytesPerTrial,
            } : undefined,
          );
          facts.push(runFacts);

          const factsFile = path.join(outputDir, 'execution-facts.json');
          this.writeStagedJson(factsFile, runFacts);
          const factsRef = this.relativeArtifactRef(factsFile, `facts-${runFacts.runId}`);
          factsRefs.push(factsRef);
          const manifestRef = this.relativeArtifactRef(manifestPath, `manifest-${runFacts.runId}`);
          manifestRefs.push(manifestRef);

          // Carry the bytes through publish. Without this the result's manifestRefs and
          // executionFactsRefs point at files that exist only in staging, so the published set
          // cannot reproduce the run.
          evidenceFiles.push({ name: `manifest-${runFacts.runId}.json`, file: manifestPath, ref: manifestRef, refKind: 'bytes' });
          evidenceFiles.push({ name: `execution-facts-${runFacts.runId}.json`, file: factsFile, ref: factsRef, refKind: 'bytes' });
          // The runner's own raw outputs. SPEC section 4.3 requires a recomputable
          // metric to be recomputable from the raw predictions, and that is only
          // true if the raw predictions SURVIVE publication: a published result
          // whose evidence was thrown away in staging cannot be re-derived, and
          // an independent evaluator has nothing to check.
          for (const rawName of ['raw-result.json', 'raw-eval.json'] as const) {
            const rawFile = path.join(outputDir, rawName);
            if (!fs.existsSync(rawFile)) continue;
            const refId = `${rawName.replace(/\.json$/, '')}-${runFacts.runId}`;
            evidenceFiles.push({ name: refId, file: rawFile, ref: this.relativeArtifactRef(rawFile, refId), refKind: 'bytes' });
          }

          const artifacts = collectRunArtifacts(prepared, manifestPath);
          const run = verifyRun(derived, prepared, runFacts, artifacts);
          verified.push(run);

          if (mode === 'tiny') {
            for (const spec of protocol.metricSpecs) {
              const raw = run.metrics[spec.evaluatorOutputKey];
              if (!raw) continue; // A metric the runner never reported is not invented as zero.
              if (spec.validRange && (raw.value < spec.validRange[0] || raw.value > spec.validRange[1])) {
                throw new ExperimentError(
                  'INVALID_RESULT',
                  `metric "${spec.id}" value ${raw.value} is outside its declared range [${spec.validRange[0]}, ${spec.validRange[1]}]`,
                  { fieldPaths: [`metricSpecs.${spec.id}.validRange`] }
                );
              }
              observations.push({
                metricId: spec.id,
                value: raw.value,
                unit: spec.unit,
                split: spec.split,
                sampleCount: raw.sampleCount,
                evaluatorRef: factsRef,
                rawEvidenceRefs: [manifestRef, factsRef],
                // Which arm produced this number. A multi-variant tiny publishes one observation per
                // (variant, seed, metric), and without this the published artifacts only carry a
                // positional index — so a later comparison cannot tell baseline from the treatment,
                // and the paired comparison Phase 3 depends on is not reconstructible from the
                // artifacts alone.
                variant,
                seed,
              });
            }
          }
        } catch (err) {
          firstFailure =
            err instanceof ExperimentError
              ? err
              : new ExperimentError('INVALID_RESULT', `run ${variant}-s${seed} failed: ${String(err)}`);
          this.writeStagedJson(path.join(staging, 'protocol-failure.json'), {
            ...firstFailure.toExecutionError(),
            variant,
            seed,
            attemptedRuns: attempted,
            plannedRuns: planned,
          });
          break;
        }
      }
      if (firstFailure) break;
    }

    const conclusion: LightweightResult['conclusion'] = firstFailure
      ? 'needs_revision'
      : verified.length === planned
        ? 'runnable'
        : 'inconclusive';
    return { conclusion, facts, executorInvocations, verified, observations, manifestRefs, factsRefs, evidenceFiles, firstFailure };
  }

  /**
   * The run profile for an ADAPTED implementation.
   *
   * `compileRecipe` resolves modules from the host's pinned list, so running the adapted code means
   * handing it the workspace copy. That is a host-side derivation and it is contained:
   *   - the derived path must be inside the workspace root,
   *   - it must be covered by the plan's allowedPaths,
   *   - it must not be always-forbidden,
   *   - and the pinned hash is replaced by the REAL hash of the adapted file, which `compileRecipe`
   *     and `verifyRun` both re-read from disk, so the recipe still pins exactly the bytes that ran.
   */
  private deriveRunProfile(workspace: WorkspaceRecord, bindings: readonly PlanBinding[]): ResolvedTaskProfile {
    const resolved = this.profile();
    const boundIds = new Set(bindings.flatMap((b) => b.orderedModuleIds.map((id) => this.resolvePinnedModule(id).id)));
    const pinnedModules = resolved.pinnedModules.map((module) => {
      if (!boundIds.has(module.id)) return module;
      const abs = this.adaptedModulePath(workspace, module.implementationPath);
      return { ...module, implementationPath: abs, sha256: sha256File(abs) };
    });
    // The host-owned per-attempt timeout is applied here, never from a request: `prepareRun` reads it
    // off the profile, and `verifyRun` refuses a run that outlived it.
    return { ...resolved, pinnedModules, verifyModuleHashesOnDisk: true, timeoutMs: this.runTimeoutMs };
  }

  // -------------------------------------------------------------------------
  // Step 6: registerImplementation
  // -------------------------------------------------------------------------

  /**
   * Registers the implementation as an `ExecutableSnapshot` with `readiness: ready`. Readiness is
   * never taken from the request: the frozen `assertRegistrationClosure` re-checks the reference
   * closure, the smoke conclusion and the required-check status from the published artifacts.
   */
  async registerImplementation(
    request: RegisterImplementationRequest,
    actor: ExperimentCallerActor
  ): Promise<ExperimentOutcome<ExecutableSnapshot>> {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(
      request,
      ['implementationRef', 'validationRef', 'smokeRef'],
      'RegisterImplementationRequest'
    );
    this.assertHostEnvelope(base, 'RegisterImplementationRequest');
    const resolved = this.profile();
    const implementationRef = expAssertArtifactRef(
      request.implementationRef,
      'RegisterImplementationRequest.implementationRef'
    );
    const validationRef = expAssertArtifactRef(request.validationRef, 'RegisterImplementationRequest.validationRef');
    const smokeRef = expAssertArtifactRef(request.smokeRef, 'RegisterImplementationRequest.smokeRef');

    // ---- PREFLIGHT (reads only): the closure is checked before an operation exists ----
    const implementation = validateImplementationSnapshot(
      this.readPublishedArtifact<ImplementationSnapshot>(implementationRef, 'implementationRef').value
    );
    const validation = validateCheckReport(this.readPublishedArtifact<CheckReport>(validationRef, 'validationRef').value);
    const smoke = validateLightweightResult(this.readPublishedArtifact<LightweightResult>(smokeRef, 'smokeRef').value);
    const plan = validateAdaptationPlan(
      this.readPublishedArtifact<AdaptationPlan>(implementation.planRef, 'implementation.planRef').value
    );
    this.assertValidationAppliesTo(implementation, validation, resolved.profileRef, validationRef);
    this.assertSmokeAppliesToProtocol(smoke, implementationRef, validationRef);
    assertRegistrationClosure({
      implementation,
      validation,
      smoke,
      implementationRef,
      validationRef,
      smokeRef,
      profileRef: resolved.profileRef,
    });

    const requestHash = computeExperimentRequestHash({
      method: 'registerImplementation',
      taskId: base.taskId,
      policyRef: base.policyRef,
      budgetRef: base.budgetRef,
      implementationRef,
      validationRef,
      smokeRef,
    });
    const reserved = this.reserveOrReuse(ownerSessionId, base.taskId, 'registerImplementation', base.commandId, requestHash);
    if (reserved.reused && reserved.receipt) {
      return this.replayOutcome<ExecutableSnapshot>(reserved.operationId, reserved.receipt, 'ExecutableSnapshot');
    }
    const task = this.assertTaskOwnership(base.taskId, actor);
    this.assertRevision(task, base.expectedRevision);

    const operation = this.createOperation(reserved.operationId, actor, base, requestHash, null);
    const staging = this.stagingDir(operation.id, base.taskId);
    const receipt: ExecutionReceipt = {
      operationId: operation.id,
      commandId: base.commandId,
      requestHash,
      taskRevision: task.revision,
    };
    this.recordReceipt(ownerSessionId, base.taskId, 'registerImplementation', base.commandId, receipt);
    this.transition(operation, 'running');

    try {
      const slotIds = Array.from(new Set(plan.bindings.map((b) => b.slotId))).sort();
      const moduleIds = Array.from(new Set(plan.bindings.flatMap((b) => b.orderedModuleIds))).sort();
      const executableBodyValue = {
        implementationRef,
        profileRef: resolved.profileRef,
        validationRef,
        smokeRef,
        readiness: 'ready' as const,
        validatedScope: {
          taskKind: resolved.profile.taskKind,
          slotIds,
          moduleIds,
          devices: [resolved.environment.device],
          dtypes: [resolved.slotSchemas.schemas[resolved.profile.slots[0].outputSchemaRef].dtype],
          testedInputBounds: this.testedInputBounds(plan, resolved),
        },
      };
      const executable: ExecutableSnapshot = {
        ...executableBodyValue,
        executableHash: computeExecutableHash(executableBodyValue),
      } as ExecutableSnapshot;
      validateExecutableSnapshot(executable);

      const executableFile = path.join(staging, 'executable.json');
      this.writeStagedJson(executableFile, executable);
      const scopeFile = path.join(staging, 'validated-scope.json');
      this.writeStagedJson(scopeFile, {
        readiness: 'ready',
        profileRef: resolved.profileRef,
        validatedScope: executable.validatedScope,
        boundTo: { implementationRef, validationRef, smokeRef },
        notClaimed: [
          'that any candidate improves over the baseline',
          'that any module implementation is scientifically correct',
          'that Phase 1 formal extraction has passed',
        ],
        scopeLimits: [
          `ready is valid only for profile ${resolved.profileRef} and the declared check scope`,
          'the research card stays proposed; readiness is an engineering fact about this implementation',
        ],
      });
      const published = this.publish(
        operation,
        [
          {
            name: 'executable.json',
            file: executableFile,
            ref: { id: `executable-${executable.executableHash.slice(0, 12)}`, sha256: executable.executableHash },
            refKind: 'object',
          },
          {
            name: 'validated-scope.json',
            file: scopeFile,
            ref: this.relativeArtifactRef(scopeFile, `validated-scope-${base.taskId}`),
            refKind: 'bytes',
          },
        ],
        'executable.json'
      );
      this.advanceRevision(base.taskId);
      return { receipt, operation: published, result: executable };
    } catch (err) {
      this.failOperation(operation, err);
      throw err;
    }
  }

  /**
   * SPEC section 3: registration also checks the smoke subject against the RUN PROTOCOL range. The
   * smoke must have been produced by the HOST smoke protocol, its subject must be the implementation
   * being registered, and it must be bound to the same validation report.
   */
  private assertSmokeAppliesToProtocol(
    smoke: LightweightResult,
    implementationRef: ArtifactRef,
    validationRef: ArtifactRef
  ): void {
    const hostProtocol = this.protocols.smoke.body;
    if (smoke.mode !== 'smoke') {
      throw new ExperimentError('MODULE_NOT_READY', 'registration requires a smoke result', { fieldPaths: ['smokeRef'] });
    }
    if (smoke.protocolRef.sha256 !== hostProtocol.protocolHash) {
      throw new ExperimentError(
        'MODULE_NOT_READY',
        'the smoke result was produced under a different run protocol than the host declares for this profile',
        { fieldPaths: ['smokeRef'] }
      );
    }
    if (smoke.subjectRef.sha256 !== implementationRef.sha256) {
      throw new ExperimentError('MODULE_NOT_READY', 'the smoke subject is not the implementation being registered', {
        fieldPaths: ['smokeRef'],
      });
    }
    if (smoke.checkReportRef.sha256 !== validationRef.sha256) {
      throw new ExperimentError('MODULE_NOT_READY', 'the smoke result is not bound to this validation report', {
        fieldPaths: ['smokeRef'],
      });
    }
    if (smoke.conclusion === 'needs_revision') {
      throw new ExperimentError('MODULE_NOT_READY', 'smoke asked for a revision; nothing may be registered', {
        fieldPaths: ['smokeRef'],
      });
    }
  }

  private testedInputBounds(plan: AdaptationPlan, resolved: ResolvedTaskProfile): string {
    const slot = resolved.profile.slots.find((s) => s.slotId === plan.bindings[0].slotId) ?? resolved.profile.slots[0];
    const schema = resolved.slotSchemas.schemas[slot.outputSchemaRef];
    return `batch=${resolved.batchSize}, shape=[${schema.shape.join(',')}], dtype=${schema.dtype}, device=${resolved.environment.device}, sampleCount=${resolved.dataSpec.sampleCount}, smokeLimit=${JSON.stringify(this.protocols.smoke.body.limit)}`;
  }

  // -------------------------------------------------------------------------
  // The seven-step chain
  // -------------------------------------------------------------------------

  /**
   * Runs the SPEC section 3 sequence in order, stopping at the first step that fails. The order comes
   * from `PHASE2_SEQUENCE` itself, so the declared order and the executed order cannot drift.
   *
   * A later failure never rewrites an earlier published artifact: that is what makes "a tiny failure
   * does not revoke the smoke facts" a property of the storage layout rather than a promise.
   */
  async runPhase2Chain(request: Phase2ChainRequest, actor: ExperimentCallerActor): Promise<Phase2ChainOutcome> {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(
      request,
      [
        'proposal',
        'sourceManifestRef',
        'profileRef',
        'constraintsRef',
        'patchProvider',
        'submittedPatchRef',
        'runProtocolRefs',
        'commandIds',
        'interventionAxis',
      ],
      'Phase2ChainRequest'
    );
    this.assertHostEnvelope(base, 'Phase2ChainRequest');
    const commandIds = expNoExtraKeys(
      request.commandIds,
      [
        'resolveSources',
        'planAdaptation',
        'adaptImplementation',
        'validateImplementation',
        'smoke',
        'registerImplementation',
        'tiny',
      ],
      'Phase2ChainRequest.commandIds'
    );
    const commandId = (key: string): string => expAssertId(commandIds[key], `Phase2ChainRequest.commandIds.${key}`);
    const runProtocolRefs = expNoExtraKeys(
      request.runProtocolRefs,
      ['smoke', 'tiny'],
      'Phase2ChainRequest.runProtocolRefs'
    );
    const smokeProtocolRef = expAssertArtifactRef(runProtocolRefs.smoke, 'Phase2ChainRequest.runProtocolRefs.smoke');
    const tinyProtocolRef = expAssertArtifactRef(runProtocolRefs.tiny, 'Phase2ChainRequest.runProtocolRefs.tiny');

    const outcome: Phase2ChainOutcome = {
      taskId: base.taskId,
      steps: [],
      completedSteps: [],
      stoppedAt: null,
      sourceBundleRef: null,
      planRef: null,
      implementationRef: null,
      validationRef: null,
      smokeRef: null,
      executableRef: null,
      tinyRef: null,
      firstError: null,
    };
    let revision = base.expectedRevision;
    const envelope = (cid: string) => ({
      commandId: cid,
      taskId: base.taskId,
      expectedRevision: revision,
      policyRef: base.policyRef,
      budgetRef: base.budgetRef,
    });

    const runStep = async (
      step: string,
      method: string,
      cid: string,
      fn: () => Promise<{ receipt: ExecutionReceipt; operation: ExecutionOperation; result?: unknown }>,
      onSuccess: (ref: ArtifactRef) => void
    ): Promise<boolean> => {
      try {
        const res = await fn();
        const ref = res.operation.resultRefs[0];
        this.awaitTerminalOperation(res.operation.id, step);
        outcome.steps.push({
          step,
          method,
          commandId: cid,
          operationId: res.operation.id,
          status: res.operation.status,
          resultRef: ref,
          error: null,
        });
        outcome.completedSteps.push(step);
        onSuccess(ref);
        revision += 1;
        return true;
      } catch (err) {
        const e = err instanceof ExperimentError ? err : null;
        const error: ExecutionError = e
          ? e.toExecutionError()
          : { code: 'INVALID_RESULT', message: String(err), retryable: false, fieldPaths: [], diagnosticRef: null };
        // If an operation WAS created for this step, record its real terminal state.
        const operationId = this.operationIdForCommand(ownerSessionId, base.taskId, method === 'runLightweight' ? `${method}:${step.includes('smoke') ? 'smoke' : 'tiny'}` : method, cid);
        outcome.steps.push({
          step,
          method,
          commandId: cid,
          operationId,
          status: 'failed',
          resultRef: null,
          error,
        });
        outcome.stoppedAt = step;
        outcome.firstError = error;
        return false;
      }
    };

    let ok = await runStep(
      PHASE2_SEQUENCE[0],
      'resolveSources',
      commandId('resolveSources'),
      () =>
        this.resolveSources(
          {
            ...envelope(commandId('resolveSources')),
            proposal: request.proposal,
            sourceManifestRef: request.sourceManifestRef,
            profileRef: request.profileRef,
          },
          actor
        ),
      (ref) => {
        outcome.sourceBundleRef = ref;
      }
    );
    if (!ok) return outcome;

    ok = await runStep(
      PHASE2_SEQUENCE[1],
      'planAdaptation',
      commandId('planAdaptation'),
      () =>
        this.planAdaptation(
          {
            ...envelope(commandId('planAdaptation')),
            sourceBundleRef: outcome.sourceBundleRef as ArtifactRef,
            profileRef: request.profileRef,
            constraintsRef: request.constraintsRef,
            patchProvider: request.patchProvider,
            ...(request.interventionAxis !== undefined ? { interventionAxis: request.interventionAxis } : {}),
          },
          actor
        ),
      (ref) => {
        outcome.planRef = ref;
      }
    );
    if (!ok) return outcome;

    ok = await runStep(
      PHASE2_SEQUENCE[2],
      'adaptImplementation',
      commandId('adaptImplementation'),
      () =>
        this.adaptImplementation(
          {
            ...envelope(commandId('adaptImplementation')),
            planRef: outcome.planRef as ArtifactRef,
            ...(request.submittedPatchRef ? { submittedPatchRef: request.submittedPatchRef } : {}),
          },
          actor
        ),
      (ref) => {
        outcome.implementationRef = ref;
      }
    );
    if (!ok) return outcome;

    ok = await runStep(
      PHASE2_SEQUENCE[3],
      'validateImplementation',
      commandId('validateImplementation'),
      () =>
        this.validateImplementation(
          {
            ...envelope(commandId('validateImplementation')),
            implementationRef: outcome.implementationRef as ArtifactRef,
            profileRef: request.profileRef,
          },
          actor
        ),
      (ref) => {
        outcome.validationRef = ref;
      }
    );
    if (!ok) return outcome;

    // A required check failure stops the chain HERE: no smoke operation is ever created.
    ok = await runStep(
      PHASE2_SEQUENCE[4],
      'runLightweight',
      commandId('smoke'),
      () =>
        this.runLightweight(
          {
            ...envelope(commandId('smoke')),
            mode: 'smoke',
            subjectRef: outcome.implementationRef as ArtifactRef,
            runProtocolRef: smokeProtocolRef,
            validationRef: outcome.validationRef as ArtifactRef,
          },
          actor
        ),
      (ref) => {
        outcome.smokeRef = ref;
      }
    );
    if (!ok) return outcome;

    ok = await runStep(
      PHASE2_SEQUENCE[5],
      'registerImplementation',
      commandId('registerImplementation'),
      () =>
        this.registerImplementation(
          {
            ...envelope(commandId('registerImplementation')),
            implementationRef: outcome.implementationRef as ArtifactRef,
            validationRef: outcome.validationRef as ArtifactRef,
            smokeRef: outcome.smokeRef as ArtifactRef,
          },
          actor
        ),
      (ref) => {
        outcome.executableRef = ref;
      }
    );
    if (!ok) return outcome;

    // Tiny is the LAST step, and its failure is recorded without touching the smoke facts above.
    await runStep(
      PHASE2_SEQUENCE[6],
      'runLightweight',
      commandId('tiny'),
      () =>
        this.runLightweight(
          {
            ...envelope(commandId('tiny')),
            mode: 'tiny',
            subjectRef: outcome.executableRef as ArtifactRef,
            runProtocolRef: tinyProtocolRef,
          },
          actor
        ),
      (ref) => {
        outcome.tinyRef = ref;
      }
    );
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Host-side helpers (not one of the six contract methods)
  // -------------------------------------------------------------------------

  submittedPatchPath(sha256: string): string {
    return path.join(this.storageRoot, 'submitted', `${sha256}.patch`);
  }

  /**
   * Human patch intake. It is NOT one of the six contract methods and is not one of the seven chain
   * steps: it exists so a host-side caller can hand the service a patch by content. The ref it returns
   * is content-addressed, so the same patch submitted twice is the same ref.
   */
  submitPatch(request: SubmitPatchRequest, actor: ExperimentCallerActor): ArtifactRef {
    const ownerSessionId = this.assertActor(actor);
    const base = this.validateBase(request, ['patchText', 'description'], 'SubmitPatchRequest');
    this.assertTaskOwnership(base.taskId, actor);
    const patchText = typeof request.patchText === 'string' ? request.patchText : '';
    if (patchText.trim().length === 0) {
      throw new ExperimentError('INVALID_INPUT', 'patchText must be a non-empty string', { fieldPaths: ['patchText'] });
    }
    const sha = sha256Hex(patchText);
    const file = this.submittedPatchPath(sha);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${PROCESS_IDENTITY}.tmp`;
      fs.writeFileSync(tmp, patchText, 'utf8');
      fs.renameSync(tmp, file);
    }
    const map = this.readJsonMap<SubmittedPatchRecord>(this.indexPath('submitted.json'));
    const existing = map.get(sha);
    if (existing && existing.ownerSessionId !== ownerSessionId) {
      throw new ExperimentError('OWNER_MISMATCH', 'this patch content was submitted by another owner', {
        fieldPaths: ['patchText'],
      });
    }
    const ref: ArtifactRef = { id: `submitted-patch-${sha.slice(0, 12)}`, sha256: sha };
    map.set(sha, {
      ref,
      ownerSessionId,
      taskId: base.taskId,
      description: request.description ?? null,
      submittedAt: existing?.submittedAt ?? nowIso(),
    });
    this.writeJsonAtomic(this.indexPath('submitted.json'), Object.fromEntries(map));
    return ref;
  }

  /** Reading an operation consumes no budget and is owner-checked. */
  getExecutionOperation(operationId: string, actor: ExperimentCallerActor): ExecutionOperation {
    const ownerSessionId = this.assertActor(actor);
    const op = this.loadOperation(operationId);
    if (op.ownerSessionId !== ownerSessionId) {
      throw new ExperimentError('OWNER_MISMATCH', `Operation ${operationId} belongs to another owner`);
    }
    return op;
  }

  /**
   * Idempotent stop. Cancellation is never gated by the remaining budget.
   *
   * The frozen `EXPERIMENT_ERROR_CODES` has no CANCELLED code, so the recorded error is HOST_BUSY with
   * an explicit message and the `status` field carries the real fact.
   */
  stopExecutionOperation(operationId: string, commandId: string, actor: ExperimentCallerActor): ExecutionOperation {
    const ownerSessionId = this.assertActor(actor);
    expAssertId(commandId, 'commandId');
    const op = this.loadOperation(operationId);
    if (op.ownerSessionId !== ownerSessionId) {
      throw new ExperimentError('OWNER_MISMATCH', `Operation ${operationId} belongs to another owner`);
    }
    // KILL the running child process BEFORE the descriptor is rewritten, so the
    // record cannot say "cancelled" while training continues.
    this.runAborts.get(operationId)?.abort();
    if (isTerminalExecutionStatus(op.status)) return op;
    if (op.status !== 'stopping') {
      assertExecutionTransition(op.status, 'stopping');
      op.status = 'stopping';
      op.updatedAt = nowIso();
      this.saveDescriptor(op);
    }
    assertExecutionTransition('stopping', 'cancelled');
    op.status = 'cancelled';
    op.error = {
      code: 'HOST_BUSY',
      message: `Cancelled by command ${commandId}`,
      retryable: false,
      fieldPaths: [],
      diagnosticRef: null,
    };
    op.updatedAt = nowIso();
    this.saveDescriptor(op);
    return op;
  }

  /** Parent session ending cancels everything it owns that is not terminal. */
  cancelOperationsOfSession(sessionId: string, reason: string): ExecutionOperation[] {
    const cancelled: ExecutionOperation[] = [];
    for (const op of this.listOperations()) {
      if (op.ownerSessionId !== sessionId || isTerminalExecutionStatus(op.status)) continue;
      op.status = 'cancelled';
      op.error = { code: 'HOST_BUSY', message: reason, retryable: false, fieldPaths: [], diagnosticRef: null };
      op.updatedAt = nowIso();
      this.saveDescriptor(op);
      cancelled.push(op);
    }
    return cancelled;
  }

  /** The six contract method names, in the order PHASE2_METHODS declares them. */
  static contractMethods(): string[] {
    return PHASE2_METHODS.map((m) => m.method);
  }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/** Which probe job measures a mechanism kind. The engine owns the rule set; this owns the wiring. */
export function probeJobFor(kind: MechanismKind): DeclaredMechanism['probeJob'] {
  switch (kind) {
    case 'parameterized_feature':
      return 'parameterized';
    case 'parameter_free_operator':
      return 'operator';
    case 'loss':
      return 'loss';
    case 'training_hook':
    case 'data_policy':
      return 'hook';
    case 'combination':
      throw new ExperimentError(
        'INVALID_INPUT',
        'a combination is assessed through the combination contract, not as a per-module declaration'
      );
    default:
      throw new ExperimentError('UNSUPPORTED_CAPABILITY', `unknown mechanism kind "${String(kind)}"`);
  }
}

function serializeProbeRun(probe: ProbeRun): Record<string, unknown> {
  return {
    ok: probe.ok,
    exitCode: probe.exitCode,
    failure: probe.failure,
    command: probe.command,
    durationMs: probe.durationMs,
    spec: probe.spec,
    result: probe.result,
    stderrTail: probe.stderr.length > 2000 ? probe.stderr.slice(-2000) : probe.stderr,
    stdoutTail: probe.stdout.length > 2000 ? probe.stdout.slice(-2000) : probe.stdout,
  };
}

function requireBudgetNumber(value: Record<string, unknown>, key: string): number {
  const raw = value[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ExperimentError(
      'CONFIG_INCOMPLETE',
      `the frozen configuration table's budget row has no numeric "${key}"; an unset budget field blocks the work that needs it`,
      { fieldPaths: [`rows.budget.value.${key}`] }
    );
  }
  return raw;
}

/** Reads the budget row of the frozen Phase 2 configuration table (SPEC section 6, row C). */
export function loadHostBudget(absPath: string): HostBudgetPolicy {
  if (!fs.existsSync(absPath)) {
    throw new ExperimentError('CONFIG_INCOMPLETE', `the frozen configuration table is missing: ${absPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(absPath, 'utf8')) as Record<string, unknown>;
  const rows = (raw.rows ?? {}) as Record<string, unknown>;
  const budgetRow = (rows.budget ?? {}) as Record<string, unknown>;
  const value = (budgetRow.value ?? null) as Record<string, unknown> | null;
  if (!value) {
    throw new ExperimentError(
      'CONFIG_INCOMPLETE',
      'the budget row of the frozen configuration table is null: SPEC section 6 says an unset field blocks the work that needs it',
      { fieldPaths: ['rows.budget.value'] }
    );
  }
  const wallClockRaw = value.wallClockDeadline;
  let wallClockDeadline: string | null = null;
  if (wallClockRaw !== null && wallClockRaw !== undefined) {
    wallClockDeadline = expAssertId(wallClockRaw, 'budget.wallClockDeadline');
    if (Number.isNaN(Date.parse(wallClockDeadline))) {
      throw new ExperimentError('CONFIG_INCOMPLETE', 'budget.wallClockDeadline is not a parseable UTC timestamp', {
        fieldPaths: ['budget.wallClockDeadline'],
      });
    }
  }
  const devices = value.allowedDevices;
  if (!Array.isArray(devices) || devices.length === 0 || !devices.every((d) => typeof d === 'string')) {
    throw new ExperimentError('CONFIG_INCOMPLETE', 'budget.allowedDevices must be a non-empty string array', {
      fieldPaths: ['budget.allowedDevices'],
    });
  }
  return {
    wallClockDeadline,
    maxModelCalls: requireBudgetNumber(value, 'maxModelCalls'),
    maxTotalTokens: requireBudgetNumber(value, 'maxTotalTokens'),
    maxExecutionSeconds: requireBudgetNumber(value, 'maxExecutionSeconds'),
    maxRepairAttempts: requireBudgetNumber(value, 'maxRepairAttempts'),
    maxTrials: requireBudgetNumber(value, 'maxTrials'),
    perAttemptTimeoutMs: requireBudgetNumber(value, 'perAttemptTimeoutMs'),
    allowedDevices: devices as string[],
    maxMemoryBytes: requireBudgetNumber(value, 'maxMemoryBytes'),
    maxDiskBytes: requireBudgetNumber(value, 'maxDiskBytes'),
  };
}

export const PHASE2_CONTRACT_METHODS = PHASE2_METHODS;
export const PHASE2_CHAIN_SEQUENCE = PHASE2_SEQUENCE;
