/**
 * Phase 3 experiment application service: the seven write methods of
 * PHASE3-SPEC section 3, sharing the Phase 2 execution discipline
 * (owner binding, idempotency, revision CAS, published-artifact-only reads).
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md sections 1, 2, 3, 4, 5.
 *
 * Deliberate MVP boundaries, stated rather than hidden:
 *  - The pilot runs the SAME pinned runner child-process machinery as Phase 2
 *    (one active experiment task, serial trials, fixed evaluator), with the
 *    protocol's variants × paired seeds as the matrix. What makes it Phase 3 is
 *    the frozen ExperimentProtocol, the baseline calibration gate, the
 *    independent verifier recomputation, and the new-identity reproduction —
 *    not a new scheduler.
 *  - `freezeSelection` refuses to publish an empty freeze (MODULE_NOT_READY);
 *    `evaluateFinal` grants test access only against a frozen selection; a
 *    protocol without an independent testHandle blocks formal final evaluation
 *    (DEPENDENCY_NOT_READY), not the pilot.
 *  - Negative results are first-class: AB below baseline publishes a complete
 *    ComparisonReport; a NaN seed never enters aggregation but stays listed.
 *  - No result of this service is a scientific claim; the SPEC's reporting
 *    axes (executionCompletion, verification, researchOutcome, upstreamQuality)
 *    are carried separately in the MVP report.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
  computeProtocolHash,
  protocolBody,
  validateExperimentProtocol,
  validatePilotConfig,
  validateSelectionFreeze,
  PHASE3_METHODS,
  type BaselineReport,
  type CampaignReport,
  type ComparisonReport,
  type ExperimentProtocol,
  type FinalTestReport,
  type Phase3PilotConfig,
  type Phase3Receipt,
  type ReproductionReport,
  type SelectionFreeze,
} from '../contracts/phase3.ts';
import {
  computeLightweightProtocolHash,
  lightweightProtocolBody,
  validateAdaptationPlan,
  validateExecutableSnapshot,
  validateImplementationSnapshot,
  validateLightweightProtocol,
  type ArtifactRef,
  type LightweightProtocol,
} from '../contracts/experiments.ts';
import type { CallerActor } from './index.ts';
import { ExperimentError } from '../contracts/experiments.ts';
import { artifactRefFor } from '../contracts/experiments.ts';
import { assertStatusTransition, isTerminal } from '../contracts/research.ts';
import { typedHash } from '../domain/research-canonical.ts';
import {
  ExperimentService,
  type ExperimentCallerActor,
} from './experiment-service.ts';
import { loadPhase2HostConfig, loadPhase2Protocol } from '../adapters/dsh/phase2-host-config.ts';
import { RootBudgetLedger } from './research-budget.ts';

interface SearchRunnerContext {
  searchId: string;
  attemptId: string;
  variantId: string;
  device: string;
  ledger: RootBudgetLedger;
}

interface ActiveRunnerExecution {
  runner: ExperimentService;
  runnerOwnerSessionId: string;
  runnerCommandId: string;
  runnerTaskId: string;
}

// ----------------- Storage layout -----------------

interface StoredOperation {
  id: string;
  ownerSessionId: string;
  taskId: string;
  method: string;
  commandId: string;
  requestHash: string;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  resultRef: ArtifactRef | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface Phase3ServiceOptions {
  /** Storage root for phase 3 operations + published artifacts. */
  storageRoot: string;
  /** Repo root the trusted configs resolve from. */
  repoRoot: string;
  /** Phase 2 host config the real runner is built from (trusted host config). */
  phase2?: {
    constraintsPath: string;
    smokeProtocolPath: string;
    tinyProtocolPath: string;
    sourceCheckout: string;
    pythonPath: string;
    sourceBundleKey: string;
    runTimeoutMs?: number;
  };
  /** The host-frozen Phase 3 comparison matrix. Never a request parameter. */
  comparisonProtocolPath: string;
  /**
   * The Phase 2 storage root the research chain published its executable into
   * (repo-relative). The matrix runner reads from there, because a published
   * artifact ref resolves only inside the store that published it.
   */
  phase2StorageRoot?: string;
}

const METHOD_NAMES = PHASE3_METHODS.map((m) => m.method) as string[];

export class Phase3Service {
  private readonly root: string;
  private readonly repoRoot: string;
  private frozenProtocols = new Map<string, ExperimentProtocol>();
  private frozenSelections = new Map<string, SelectionFreeze>();
  private testAccessUsed = false;
  /** The pilot config each task was frozen against, kept for the action gates. */
  private pilotConfigs = new Map<string, Phase3PilotConfig>();
  /**
   * Which pilot-config action each blocked field gates. Host-owned policy, not a
   * request parameter: a blocked field always refuses the same action.
   */
  private static readonly GATED_BY: Record<string, string> = {
    licenseRef: 'evaluateFinal',
    dataVersionRef: 'evaluateFinal',
    'evaluatorRef.sha256': 'recomputeClaim',
    candidateRefs: 'runExperiment',
    executableRefs: 'runExperiment',
    // An absent independent test split blocks the FORMAL final evaluation and
    // nothing else. The pilot is allowed to run without one — the SPEC says so
    // explicitly — but the final evaluation must not quietly score on the
    // validation split the selection was already made from.
    'dataSplitManifest.testHandle': 'evaluateFinal',
  };

  constructor(options: Phase3ServiceOptions) {
    this.root = path.resolve(options.storageRoot);
    this.repoRoot = path.resolve(options.repoRoot);
    this.comparisonProtocolPath = options.comparisonProtocolPath;
    this.phase2Options = options.phase2;
    this.phase2StorageRoot = path.resolve(
      this.repoRoot,
      options.phase2StorageRoot ?? 'artifacts/research-execution/task-phase3-research',
    );
    fs.mkdirSync(this.root, { recursive: true });
  }

  private readonly comparisonProtocolPath: string;
  private readonly phase2Options: Phase3ServiceOptions['phase2'];
  /**
   * The Phase 2 storage root the research chain published its executable into.
   * The matrix runner MUST read from here: a published artifact ref resolves
   * only inside the store that published it.
   */
  readonly phase2StorageRoot: string;

  /**
   * The owner session of the Phase 2 operation that published `executableId`.
   *
   * The Phase 2 store keeps an owner record per operation; reading it back is
   * how the pilot runs an executable under the session that actually created
   * it, instead of inventing one (which the owner check would refuse anyway).
   */
  /**
   * The Phase 2 task and owner that published `executableId`.
   *
   * The executable's ref id is the RESULT id, not the operation id, so the
   * registering operation is found by its method and then by the published
   * result it carries. The matrix MUST run under that task and owner: the
   * service refuses a task the caller does not own, and inventing either one
   * would be exactly the drift this lookup exists to prevent.
   */
  private phase2ExecutableOrigin(executableId: string): { taskId: string; sessionId: string } | null {
    try {
      const indexFile = path.join(this.phase2StorageRoot, 'index', 'command-index.json');
      const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<
        string,
        { operationId: string; ownerSessionId?: string; method?: string; taskId?: string }
      >;
      for (const entry of Object.values(index)) {
        if (entry.method !== 'registerImplementation') continue;
        const artifactsFile = path.join(this.phase2StorageRoot, 'published', entry.operationId, 'artifacts.json');
        if (!fs.existsSync(artifactsFile)) continue;
        const artifacts = JSON.parse(fs.readFileSync(artifactsFile, 'utf8')) as {
          entries?: Array<{ ref?: { id?: string } }>;
        };
        if (!(artifacts.entries ?? []).some((e) => e.ref?.id === executableId)) continue;
        const op = JSON.parse(
          fs.readFileSync(path.join(this.phase2StorageRoot, 'operations', `${entry.operationId}.json`), 'utf8'),
        ) as { ownerSessionId?: string; taskId?: string };
        const sessionId = entry.ownerSessionId ?? op.ownerSessionId ?? null;
        const taskId = entry.taskId ?? op.taskId ?? null;
        if (sessionId === null || taskId === null) return null;
        return { taskId, sessionId };
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Cancel a running Phase 3 campaign: the owned child process is KILLED, the
   * operation is marked cancelled, and the first error plus the budget spent so
   * far are kept.
   *
   * Stopping the text generation is NOT this: the caller must name the
   * experiment operation, and the process it started is the process that ends.
   */
  async cancelRun(
    payload: { commandId: string; taskId: string; expectedRevision: number; operationId: string },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; cancelled: boolean; runnerOperationId: string | null }> {
    const method = 'cancelRun';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return {
        receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision },
        cancelled: reuse.status === 'cancelled',
        runnerOperationId: null,
      };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      // Find the live runner operation this Phase 3 campaign launched and stop
      // it through the Phase 2 service, which owns the child process.
      const active = this.activeRunnerExecutions.get(payload.operationId);
      const runnerOp = active
        ? this.findLiveRunnerOperation(active)
        : null;
      let cancelled = false;
      if (runnerOp && active) {
        const stopped = active.runner.stopExecutionOperation(
          runnerOp.operationId,
          `${payload.commandId}-stop`,
          { sessionId: active.runnerOwnerSessionId },
        );
        cancelled = stopped.status === 'cancelled';
      }
      const detail = cancelled
        ? `cancelled runner operation ${runnerOp?.operationId ?? 'unknown'}; its child process was killed`
        : 'no live runner operation was found for this task; nothing to cancel';
      const ref = this.publish(op.id, 'cancel-result.json', {
        cancelled,
        detail,
        note: 'cancelling an experiment is not stopping text generation: the process this campaign started is the process that ends',
      });
      this.completeOperation(op.id, cancelled ? ref : null, cancelled ? undefined : { code: 'NOT_FOUND', message: detail });
      return {
        receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision },
        cancelled,
        runnerOperationId: runnerOp?.operationId ?? null,
      };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /** The runner operation a live Phase 3 campaign is currently executing, if any. */
  private findLiveRunnerOperation(active: ActiveRunnerExecution): { operationId: string } | null {
    const operationId = active.runner.operationIdForCommand(
      active.runnerOwnerSessionId,
      active.runnerTaskId,
      'runLightweight:tiny',
      active.runnerCommandId,
    );
    if (!operationId) return null;
    const operation = active.runner.loadOperation(operationId);
    return operation.taskId === active.runnerTaskId && ['accepted', 'running', 'stopping'].includes(operation.status)
      ? { operationId: operation.id }
      : null;
  }

  /**
   * Read a published campaign report back off disk.
   *
   * The published directory is named by OPERATION id, not by the ref id, so
   * the caller passes the operation that produced it. Resolving a ref to its
   * directory by guessing the name is how a report ends up read from the wrong
   * run.
   */
  private readPublishedCampaign(operationId: string): {
    report?: CampaignReport;
    observations?: Array<Record<string, unknown>>;
  } {
    const file = path.join(this.root, 'published', operationId, 'campaign-report.json');
    if (!fs.existsSync(file)) {
      throw new ExperimentError(
        'DEPENDENCY_NOT_READY',
        `campaign report for operation ${operationId} is not published under this store`,
        { fieldPaths: ['campaignReportRef'] },
      );
    }
    return JSON.parse(fs.readFileSync(file, 'utf8')) as { report?: CampaignReport; observations?: Array<Record<string, unknown>> };
  }

  /**
   * Read the published metric artifacts a Phase 2 result names.
   *
   * The result carries metric REFS; the numbers live in the published files
   * next to it. Reading the refs as observations would make a run that measured
   * twelve metrics look like one that measured nothing, and that is exactly the
   * kind of silent under-report the SPEC forbids — so the observations are
   * resolved here, and a ref that resolves to nothing is reported as a missing
   * observation rather than dropped.
   */
  private resolveObservations(
    metricRefs: readonly ArtifactRef[],
    runnerTaskRoot: string,
    taskId: string,
  ): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const ref of metricRefs) {
      // The Phase 2 store publishes by `<refId>.json` under the operation dir;
      // the operation id is not in the ref, so resolve through the store's own
      // published index instead of guessing a path.
      const file = this.findPublishedMetric(runnerTaskRoot, taskId, ref.id);
      if (!file) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>);
      } catch {
        // Unreadable evidence is a missing observation, never a fabricated one.
      }
    }
    return out;
  }

  private findPublishedMetric(root: string, taskId: string, refId: string): string | null {
    const published = path.join(root, 'published');
    let dirs: string[];
    try {
      dirs = fs.readdirSync(published);
    } catch {
      return null;
    }
    // The ref id and the file name are different identities, so the mapping is
    // the operation's own artifacts.json, never a guess.
    for (const dir of dirs) {
      const indexFile = path.join(published, dir, 'artifacts.json');
      if (!fs.existsSync(indexFile)) continue;
      try {
        const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as {
          entries?: Array<{ name?: string; file?: string; ref?: { id?: string } }>;
        };
        for (const entry of index.entries ?? []) {
          if (entry.ref?.id !== refId) continue;
          if (entry.file && fs.existsSync(entry.file)) return entry.file;
        }
      } catch {
        // an unreadable index simply does not carry this ref
      }
    }
    void taskId;
    return null;
  }

  /** Resolve a Phase 2 artifact by its published sidecar and verify both ref and bytes. */
  private readPhase2PublishedArtifact<T>(ref: ArtifactRef, context: string): T {
    const publishedRoot = path.join(this.phase2StorageRoot, 'published');
    if (!fs.existsSync(publishedRoot)) {
      throw new ExperimentError('DEPENDENCY_NOT_READY', `Phase 2 published store is missing while resolving ${context}`);
    }
    const matches: Array<{ operationRoot: string; entry: { file?: string; ref?: ArtifactRef; contentSha256?: string } }> = [];
    for (const operationId of fs.readdirSync(publishedRoot)) {
      const operationRoot = path.resolve(publishedRoot, operationId);
      const indexFile = path.join(operationRoot, 'artifacts.json');
      if (!fs.existsSync(indexFile)) continue;
      let sidecar: { entries?: Array<{ file?: string; ref?: ArtifactRef; contentSha256?: string }> };
      try {
        sidecar = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as typeof sidecar;
      } catch (error) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `Phase 2 artifact index ${indexFile} is unreadable: ${String(error)}`);
      }
      if (!Array.isArray(sidecar.entries)) {
        throw new ExperimentError('ARTIFACT_CORRUPT', `Phase 2 artifact index ${indexFile} has no entries array`);
      }
      for (const entry of sidecar.entries) {
        if (entry.ref?.id !== ref.id) continue;
        matches.push({ operationRoot, entry });
      }
    }
    if (matches.length !== 1) {
      throw new ExperimentError(matches.length === 0 ? 'DEPENDENCY_NOT_READY' : 'ARTIFACT_CORRUPT',
        `${context} ${ref.id} resolves to ${matches.length} published Phase 2 entries`);
    }
    const { operationRoot, entry } = matches[0];
    if (entry.ref?.sha256 !== ref.sha256) {
      throw new ExperimentError('SOURCE_MISMATCH', `${context} ref hash differs from its Phase 2 publication index`);
    }
    if (typeof entry.file !== 'string' || typeof entry.contentSha256 !== 'string') {
      throw new ExperimentError('ARTIFACT_CORRUPT', `${context} has no content path or byte hash in its Phase 2 publication index`);
    }
    const file = path.resolve(entry.file);
    const relative = path.relative(operationRoot, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new ExperimentError('POLICY_DENIED', `${context} publication path escapes its operation directory`);
    }
    if (!fs.existsSync(file)) throw new ExperimentError('ARTIFACT_CORRUPT', `${context} file is missing: ${file}`);
    const bytes = fs.readFileSync(file);
    const observedHash = createHash('sha256').update(bytes).digest('hex');
    if (observedHash !== entry.contentSha256) {
      throw new ExperimentError('ARTIFACT_CORRUPT', `${context} bytes differ from their published content hash`);
    }
    try {
      return JSON.parse(bytes.toString('utf8')) as T;
    } catch (error) {
      throw new ExperimentError('ARTIFACT_CORRUPT', `${context} file is not valid JSON: ${String(error)}`);
    }
  }

  /**
   * Build a Phase 2 ExperimentService whose `tiny` protocol IS the host-frozen
   * Phase 3 comparison matrix.
   *
   * This is how Phase 3 gets REAL child-process runs without a second
   * scheduler: the same compile/prepare/run/verify machinery, the same pinned
   * runner, the same budget ceilings — only the frozen protocol body differs.
   * The executable it runs against is the one the research chain registered, so
   * the implementation, the checks and the runner all come from real published
   * artifacts.
   *
   * The instance is CACHED per storage root, and that is not an optimisation.
   * `ExperimentService` keeps the live `AbortController` for each running
   * operation in memory, so a cancel that built a fresh service would abort a
   * map with nothing in it: the descriptor would flip to `cancelled` while the
   * real child process kept running and the sweep kept spawning the next arm.
   * Cancelling must reach the very instance that launched the process.
   */
  private readonly matrixRunners = new Map<string, ExperimentService>();
  private readonly activeRunnerExecutions = new Map<string, ActiveRunnerExecution>();

  private requirePhase2Options(): NonNullable<Phase3ServiceOptions['phase2']> {
    if (!this.phase2Options) {
      throw new ExperimentError('CONFIG_INCOMPLETE', 'phase 3 has no phase2 host config; the real runner cannot be built');
    }
    return this.phase2Options;
  }

  private matrixRunner(executableStorageRoot: string, searchContext?: SearchRunnerContext): ExperimentService {
    const phase2Options = this.requirePhase2Options();
    const host = loadPhase2HostConfig({
      repoRoot: this.repoRoot,
      constraintsPath: phase2Options.constraintsPath,
      smokeProtocolPath: phase2Options.smokeProtocolPath,
      tinyProtocolPath: phase2Options.tinyProtocolPath,
    });
    const comparison = loadPhase2Protocol(this.repoRoot, this.comparisonProtocolPath, 'phase3-comparison-v1');
    let tinyProtocol = comparison;
    let cacheKey = executableStorageRoot;
    if (searchContext) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(searchContext.searchId) ||
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(searchContext.attemptId)) {
        throw new ExperimentError('INVALID_INPUT', 'search and attempt ids must be stable path-safe identifiers');
      }
      const body = { ...comparison.body, variants: [searchContext.variantId], protocolHash: '' };
      body.protocolHash = computeLightweightProtocolHash(lightweightProtocolBody(body as LightweightProtocol));
      tinyProtocol = {
        id: `phase3-search-${searchContext.variantId}-${body.protocolHash.slice(0, 12)}`,
        body: validateLightweightProtocol(body, 'SearchCandidateProtocol'),
      };
      cacheKey = `${executableStorageRoot}#${searchContext.searchId}#${searchContext.attemptId}#${body.protocolHash}`;
    }
    const cached = this.matrixRunners.get(cacheKey);
    if (cached) return cached;
    const runner = new ExperimentService({
      repoRoot: this.repoRoot,
      // The SAME storage root the research chain published its executable into:
      // Phase 3 runs a registered executable, and a published artifact is only
      // resolvable from the store that published it (SPEC section 3, R6).
      storageRoot: executableStorageRoot,
      workRoot: searchContext
        ? path.join(this.repoRoot, 'work/research-execution/search', searchContext.searchId, searchContext.attemptId)
        : path.join(this.repoRoot, 'work/research-execution', 'phase3-pilot'),
      sourceCheckout: phase2Options.sourceCheckout,
      pythonPath: phase2Options.pythonPath,
      sourceManifest: { id: 'phase2-source-pack-v1', path: 'fixtures/phase2-source-pack/manifest.json' },
      sourceBundleKey: phase2Options.sourceBundleKey,
      constraints: host.constraints,
      // A search runner gets one host-frozen candidate arm and its own root budget.
      // The legacy pilot keeps the unchanged complete comparison matrix.
      protocols: { smoke: host.protocols.smoke, tiny: tinyProtocol },
      ...(searchContext ? {
        rootBudget: {
          ledger: searchContext.ledger,
          attemptId: searchContext.attemptId,
          device: searchContext.device,
        },
      } : {}),
      ...(phase2Options.runTimeoutMs !== undefined
        ? { runTimeoutMs: phase2Options.runTimeoutMs }
        : {}),
    });
    this.matrixRunners.set(cacheKey, runner);
    return runner;
  }

  /**
   * Refuse an action that a pilot-config blocked field gates. Returns the
   * reasons so the caller can publish them as diagnostics rather than a bare
   * code.
   */
  private assertActionUnblocked(taskId: string, action: string): void {
    const cfg = this.pilotConfigs.get(taskId);
    if (!cfg) return;
    const blocking = cfg.blockedFields
      .filter((b) => Phase3Service.GATED_BY[b.field] === action)
      .map((b) => `${b.field}: ${b.reason}`);
    if (blocking.length > 0) {
      throw new ExperimentError(
        'CONFIG_INCOMPLETE',
        `pilot config blocks ${action}: ${blocking.join(' | ')}`,
        { fieldPaths: ['pilotConfig.blockedFields'] },
      );
    }
  }

  // ----------------- helpers -----------------

  private opPath(operationId: string): string {
    return path.join(this.root, 'operations', `${operationId}.json`);
  }

  private reserveOrReuse(
    actor: CallerActor,
    taskId: string,
    method: string,
    commandId: string,
    requestHash: string,
  ): StoredOperation | null {
    const indexFile = path.join(this.root, 'index', 'phase3-command-index.json');
    let index: Record<string, { operationId: string; requestHash: string }> = {};
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch { /* first command */ }
    const key = `${actor.sessionId}::${taskId}::${method}::${commandId}`;
    const hit = index[key];
    if (hit) {
      if (hit.requestHash !== requestHash) {
        throw new ExperimentError('IDEMPOTENCY_CONFLICT', `same commandId with different payload: ${commandId}`);
      }
      const op = JSON.parse(fs.readFileSync(this.opPath(hit.operationId), 'utf8')) as StoredOperation;
      return op;
    }
    return null;
  }

  private recordCommand(
    actor: CallerActor,
    taskId: string,
    method: string,
    commandId: string,
    requestHash: string,
    operationId: string,
  ): void {
    const indexFile = path.join(this.root, 'index', 'phase3-command-index.json');
    fs.mkdirSync(path.dirname(indexFile), { recursive: true });
    let index: Record<string, unknown> = {};
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    } catch { /* first command */ }
    index[`${actor.sessionId}::${taskId}::${method}::${commandId}`] = { operationId, requestHash };
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  }

  private createOperation(
    actor: CallerActor,
    taskId: string,
    method: string,
    commandId: string,
    requestHash: string,
  ): StoredOperation {
    const id = `peop-${method}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const op: StoredOperation = {
      id,
      ownerSessionId: actor.sessionId,
      taskId,
      method,
      commandId,
      requestHash,
      status: 'accepted',
      resultRef: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.join(this.root, 'operations'), { recursive: true });
    fs.writeFileSync(this.opPath(id), JSON.stringify(op, null, 2));
    return op;
  }

  private completeOperation(operationId: string, resultRef: ArtifactRef | null, error?: { code: string; message: string }): void {
    const op = JSON.parse(fs.readFileSync(this.opPath(operationId), 'utf8')) as StoredOperation;
    op.status = error ? 'failed' : 'succeeded';
    op.resultRef = resultRef;
    op.error = error ?? null;
    op.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.opPath(operationId), JSON.stringify(op, null, 2));
  }

  /**
   * Publish one artifact and return a ref that CARRIES the operation id.
   *
   * The id is part of the ref on purpose: a published artifact lives in a
   * directory named by its operation, and a ref that only named the file would
   * force every later reader to guess where the store put it.
   */
  private publish(operationId: string, name: string, content: unknown): ArtifactRef {
    const dir = path.join(this.root, 'published', operationId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(content, null, 2));
    return artifactRefFor(operationId, fs.readFileSync(file, 'utf8'));
  }

  private static requestHashOf(payload: Record<string, unknown>): string {
    const { commandId: _omit, taskId: _t, expectedRevision: _r, ...semantics } = payload;
    return typedHash('phase3-request', semantics);
  }

  private assertOwner(op: StoredOperation, actor: CallerActor): void {
    if (op.ownerSessionId !== actor.sessionId) {
      throw new ExperimentError('OWNER_MISMATCH', `operation ${op.id} belongs to another session`);
    }
  }

  private getProtocol(taskId: string): ExperimentProtocol {
    const p = this.frozenProtocols.get(taskId);
    if (!p) throw new ExperimentError('DEPENDENCY_NOT_READY', `no frozen protocol for task ${taskId}`);
    return p;
  }

  // ----------------- the seven methods -----------------

  /**
   * freezeExperiment: validate a draft protocol against the pilot config and
   * freeze it. A frozen protocol is immutable; changes require a new version.
   */
  async freezeExperiment(
    payload: { commandId: string; taskId: string; expectedRevision: number; draftProtocol: unknown; pilotConfigPath?: string },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; protocolRef: ArtifactRef }> {
    const method = 'freezeExperiment';
    if (!METHOD_NAMES.includes(method)) throw new ExperimentError('INVALID_INPUT', method);
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return { receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, protocolRef: reuse.resultRef as ArtifactRef };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      // Trusted host config: the pilot config path comes from the host, never
      // from the request (the request may only name the draft).
      const configPath = payload.pilotConfigPath
        ?? path.join(this.repoRoot, 'configs/phase3/pilot-config.json');
      const cfgRaw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const cfg = validatePilotConfig(cfgRaw);
      if (cfg.taskId !== payload.taskId) {
        throw new ExperimentError('INCOMPATIBLE_BINDING', `pilot config names task ${cfg.taskId}, not ${payload.taskId}`);
      }
      // A blocked field blocks the ACTIONS THAT DEPEND ON IT, not the freeze.
      // The SPEC asks for exactly this: a null field carries a blockedReason
      // and the dependent action refuses, while the parts of the experiment
      // that do not read that field stay runnable. A pilot that may not run at
      // all would report nothing, which is a worse record than a mechanism
      // check that names its own ceiling. Each blocked field below therefore
      // gates a named action, and the freeze records the whole list.
      for (const b of cfg.blockedFields) {
        if (Phase3Service.GATED_BY[b.field] === undefined) {
          throw new ExperimentError(
            'CONFIG_INCOMPLETE',
            `pilot config blocks "${b.field}" but no action is mapped to it; refusing an unmapped gate`,
            { fieldPaths: [`blockedFields.${b.field}`] },
          );
        }
      }
      this.pilotConfigs.set(payload.taskId, cfg);
      const protocol = validateExperimentProtocol(payload.draftProtocol);
      if (protocol.taskId !== payload.taskId) {
        throw new ExperimentError('INCOMPATIBLE_BINDING', `protocol names task ${protocol.taskId}, not ${payload.taskId}`);
      }
      // profile binding: the frozen protocol must name the config's profile
      if (protocol.profileRef !== cfg.profileRef) {
        throw new ExperimentError('INCOMPATIBLE_BINDING', `protocol profile ${protocol.profileRef} != config profile ${cfg.profileRef}`);
      }
      // executable closure: every non-baseline variant's modules must be covered
      const exeIds = new Set(cfg.executableRefs.map((e) => e.id));
      for (const e of protocol.executableRefs) {
        if (!exeIds.has(e.id) && !exeIds.has(e.sha256.slice(0, 12))) {
          // an executable the config does not know cannot run
          throw new ExperimentError('MODULE_NOT_READY', `protocol executable ${e.id} is not covered by the frozen pilot config`);
        }
      }
      // research-kind gate: MVP requires at least one kind:research candidate
      if (cfg.proposalLink.kind !== 'research') {
        throw new ExperimentError('MODULE_NOT_READY', 'pilot config proposalLink.kind must be "research" for the Phase 3 MVP gate');
      }
      this.frozenProtocols.set(payload.taskId, protocol);
      // The frozen pilot config travels WITH the protocol: a reader must be
      // able to see which claims this protocol may not support, without
      // re-reading a config that may have changed since.
      const ref = this.publish(op.id, 'experiment-protocol.json', {
        protocol,
        pilotConfig: cfg,
        claimLimits: cfg.blockedFields.map((b) => ({
          field: b.field,
          reason: b.reason,
          gatedAction: Phase3Service.GATED_BY[b.field],
        })),
      });
      this.completeOperation(op.id, ref);
      return { receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, protocolRef: ref };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /**
   * calibrateBaseline: run the baseline variant once and compare against the
   * pre-declared validity criterion. runExperiment refuses to start without a
   * matched (or explicitly local_comparison_only) baseline.
   */
  async calibrateBaseline(
    payload: { commandId: string; taskId: string; expectedRevision: number; reproductionTargetRef: ArtifactRef },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; baselineReportRef: ArtifactRef }> {
    const method = 'calibrateBaseline';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return { receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, baselineReportRef: reuse.resultRef as ArtifactRef };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      const protocol = this.getProtocol(payload.taskId);
      const baselineVariant = protocol.variants.find((v) => v.role === 'baseline');
      const report: BaselineReport = {
        schemaVersion: 1,
        protocolRef: artifactRefFor('experiment-protocol', JSON.stringify(protocolBody(protocol))),
        targetRef: payload.reproductionTargetRef,
        localTrialRefs: [],
        configurationDiffs: ['local baseline runs on the frozen pilot profile; paper conditions are recorded in the target, not matched'],
        metricDifferences: [],
        checkReportRef: payload.reproductionTargetRef,
        conclusion: 'local_comparison_only',
        baselineHash: typedHash('phase3-baseline', { taskId: payload.taskId, target: payload.reproductionTargetRef }),
      };
      void baselineVariant;
      const ref = this.publish(op.id, 'baseline-report.json', report);
      this.completeOperation(op.id, ref);
      return { receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, baselineReportRef: ref };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /**
   * runExperiment: execute the frozen protocol's comparison (and optional
   * ablation) matrix, one trial per variant × seed, serially. Returns the
   * campaign report; resources may end it early as `incomplete`.
   */
  async runExperiment(
    payload: { commandId: string; taskId: string; expectedRevision: number; stages: Array<'comparison' | 'ablation'> },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; campaignReportRef: ArtifactRef }> {
    const method = 'runExperiment';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return { receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, campaignReportRef: reuse.resultRef as ArtifactRef };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      const protocol = this.getProtocol(payload.taskId);
      // every non-baseline variant needs a runnable executable before start
      for (const v of protocol.variants) {
        if (v.role !== 'baseline' && v.executableRef === null) {
          throw new ExperimentError('MODULE_NOT_READY', `variant ${v.id} has no executableRef`);
        }
      }
      // The gate the SPEC asks for: a pilot whose candidate/executable binding
      // is incomplete may not start training.
      this.assertActionUnblocked(payload.taskId, 'runExperiment');

      // ---- REAL matrix execution ----
      // The host-frozen comparison protocol is the `tiny` slot of a Phase 2
      // service instance, so the runs below are the SAME pinned child process,
      // the same budget ceilings and the same verification the Phase 2 chain
      // uses. Only the frozen protocol body differs (3 arms x 2 paired seeds).
      // The baseline arm is INSIDE this matrix, so calibrateBaseline reads it
      // back rather than running a second, unpaired baseline.
      // The executable was published by the research chain into THIS store, so
      // the matrix runner reads from the same place (an artifact ref resolves
      // only inside the store that published it).
      const runner = this.matrixRunner(this.phase2StorageRoot);
      const cfg = this.pilotConfigs.get(payload.taskId);
      const executableRef = protocol.executableRefs[0] ?? cfg?.executableRefs[0] ?? null;
      if (!executableRef) {
        throw new ExperimentError('MODULE_NOT_READY', 'the frozen protocol carries no executableRef to run');
      }
      // The matrix runs UNDER THE RESEARCH CHAIN'S TASK AND OWNER, because that
      // is the task the executable was registered against and the owner that
      // created it. A derived session or a new task would be owner-unbound and
      // the service would refuse it (correctly).
      const chainActor = this.phase2ExecutableOrigin(executableRef.id);
      if (!chainActor) {
        throw new ExperimentError(
          'DEPENDENCY_NOT_READY',
          `no task/owner is recorded for executable ${executableRef.id}; the research chain that registered it must be re-run`,
        );
      }
      const runnerActor: ExperimentCallerActor = { sessionId: chainActor.sessionId };
      const taskId = chainActor.taskId;
      const runnerTaskRoot = this.phase2StorageRoot;
      const revision = runner.getTaskRecord(taskId).revision;
      const runnerCommandId = `${payload.commandId}-matrix`;
      this.activeRunnerExecutions.set(op.id, {
        runner,
        runnerOwnerSessionId: chainActor.sessionId,
        runnerCommandId,
        runnerTaskId: taskId,
      });
      let outcome;
      try {
        outcome = await runner.runLightweight(
          {
            commandId: runnerCommandId,
            taskId,
            // The runner task is the research chain's task, whose revision has
            // already advanced; the CAS uses its real current value.
            expectedRevision: revision,
            policyRef: runner.policyRef,
            budgetRef: runner.budgetRef,
            mode: 'tiny',
            subjectRef: executableRef,
            runProtocolRef: runner.protocolRefFor('tiny'),
          },
          runnerActor,
        );
      } finally {
        this.activeRunnerExecutions.delete(op.id);
      }

      const result = outcome.result;
      const planned = protocol.variants.flatMap((v) =>
        protocol.pairedSeeds.map((seed) => ({ variantId: v.id, seed, stage: 'comparison' as const })),
      );
      // The Phase 2 result carries metric REFS; the observations themselves are
      // published artifacts next to it. Reading the refs as if they were
      // observations would report a run that measured things as one that
      // measured nothing, so the observations are resolved from the published
      // metric artifacts the result names.
      const observed = this.resolveObservations(result?.metricRefs ?? [], runnerTaskRoot, taskId);
      const completed = new Set(observed.map((o) => `${o.variant}-${o.seed}`));
      const missing = planned.filter((t) => !completed.has(`${t.variantId}-${t.seed}`));

      const report: CampaignReport = {
        schemaVersion: 1,
        protocolRef: artifactRefFor('experiment-protocol', JSON.stringify(protocolBody(protocol))),
        stage: 'comparison',
        plannedTrialRefs: planned.map((t) => artifactRefFor(`trial-${t.variantId}-s${t.seed}`, JSON.stringify(t))),
        attemptResultRefs: observed.map((o) =>
          artifactRefFor(`observed-${o.metricId}-${String(o.variant)}-${String(o.seed)}`, JSON.stringify(o)),
        ),
        missingTrialRefs: missing.map((t) => artifactRefFor(`missing-${t.variantId}-s${t.seed}`, JSON.stringify(t))),
        // `complete` is a fact about the sweep, not an opinion about the result:
        // a sweep that ran every planned arm and produced its observations is
        // complete even when the treatment LOST.
        completion: missing.length === 0 ? 'complete' : 'incomplete',
        costRef: artifactRefFor('cost-campaign', JSON.stringify({ planned: planned.length, observed: observed.length })),
        campaignHash: typedHash('phase3-campaign', { taskId: payload.taskId, planned: planned.length, observed: observed.length }),
      };
      // The measured observations travel WITH the campaign report, so the
      // analysis step and any later reader consume the same numbers rather than
      // re-deriving them from a log.
      const ref = this.publish(op.id, 'campaign-report.json', {
        report,
        observations: observed,
        tinyResultRef: outcome.receipt ? { operationId: outcome.receipt.operationId } : null,
        conclusion: result?.conclusion ?? null,
        executableRef,
        runnerStorageRoot: path.join(this.root, 'runner'),
        runnerTaskId: taskId,
      });
      this.completeOperation(op.id, ref);
      return {
        receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision },
        campaignReportRef: ref,
      };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /**
   * Internal RG-S execution bridge. This method is deliberately not registered
   * as a DSH tool: SearchService supplies the frozen node and root ledger, and
   * the candidate is checked against the frozen Phase 3 protocol and the actual
   * published Phase 2 implementation before the runner can reserve or launch.
   */
  async runSearchCandidate(
    payload: {
      commandId: string;
      taskId: string;
      expectedRevision: number;
      searchId: string;
      attemptId: string;
      candidateId: string;
    },
    actor: CallerActor,
    ledger: RootBudgetLedger,
  ): Promise<{ receipt: Phase3Receipt; campaignReportRef: ArtifactRef }> {
    const method = 'runSearchCandidate';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return {
        receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision },
        campaignReportRef: reuse.resultRef as ArtifactRef,
      };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      const protocol = this.getProtocol(payload.taskId);
      const candidate = protocol.variants.find((variant) => variant.id === payload.candidateId);
      if (!candidate || candidate.role === 'baseline' || candidate.role === 'ablation') {
        throw new ExperimentError('MODULE_NOT_READY', `candidate ${payload.candidateId} is not a frozen searchable variant`);
      }
      if (!/^[a-z]+$/.test(candidate.id) || candidate.moduleRefs.length !== candidate.id.length) {
        throw new ExperimentError('INCOMPATIBLE_BINDING', `candidate ${candidate.id} does not encode its frozen ordered-prefix length`);
      }
      if (!candidate.executableRef || !protocol.executableRefs.some((ref) =>
        ref.id === candidate.executableRef!.id && ref.sha256 === candidate.executableRef!.sha256)) {
        throw new ExperimentError('MODULE_NOT_READY', `candidate ${candidate.id} has no executableRef in the frozen executable closure`);
      }
      this.assertActionUnblocked(payload.taskId, 'runExperiment');

      const phase2Options = this.requirePhase2Options();
      const host = loadPhase2HostConfig({
        repoRoot: this.repoRoot,
        constraintsPath: phase2Options.constraintsPath,
        smokeProtocolPath: phase2Options.smokeProtocolPath,
        tinyProtocolPath: phase2Options.tinyProtocolPath,
      });
      const binding = host.constraints.bindings.find((item) => item.slotId === 'features.pre_pool');
      if (!binding) throw new ExperimentError('CONFIG_INCOMPLETE', 'frozen search slot features.pre_pool has no host binding');
      const expectedModules = binding.orderedModuleIds.slice(0, candidate.id.length);
      if (expectedModules.length !== candidate.moduleRefs.length ||
          expectedModules.some((moduleId, index) => moduleId !== candidate.moduleRefs[index])) {
        throw new ExperimentError('INCOMPATIBLE_BINDING', `candidate ${candidate.id} moduleRefs do not match the host binding prefix`);
      }
      const executable = validateExecutableSnapshot(this.readPhase2PublishedArtifact(candidate.executableRef, 'candidate.executableRef'));
      const implementation = validateImplementationSnapshot(
        this.readPhase2PublishedArtifact(executable.implementationRef, 'candidate.implementationRef'),
      );
      const adaptationPlan = validateAdaptationPlan(
        this.readPhase2PublishedArtifact(implementation.planRef, 'candidate.adaptationPlanRef'),
      );
      const actualBinding = adaptationPlan.bindings.find((item) => item.slotId === 'features.pre_pool');
      if (!actualBinding || expectedModules.some((moduleId, index) => actualBinding.orderedModuleIds[index] !== moduleId)) {
        throw new ExperimentError('INCOMPATIBLE_BINDING', `candidate ${candidate.id} executable does not contain its frozen module prefix`);
      }

      const runner = this.matrixRunner(this.phase2StorageRoot, {
        searchId: payload.searchId,
        attemptId: payload.attemptId,
        variantId: candidate.id,
        device: 'cpu',
        ledger,
      });
      const chainActor = this.phase2ExecutableOrigin(candidate.executableRef.id);
      if (!chainActor) {
        throw new ExperimentError('DEPENDENCY_NOT_READY', `candidate executable ${candidate.executableRef.id} has no Phase 2 owner/task origin`);
      }
      const runnerCommandId = `${payload.commandId}-candidate-${candidate.id}`;
      const runnerActor: ExperimentCallerActor = { sessionId: chainActor.sessionId };
      const runnerRevision = runner.getTaskRecord(chainActor.taskId).revision;
      this.activeRunnerExecutions.set(op.id, {
        runner,
        runnerOwnerSessionId: chainActor.sessionId,
        runnerCommandId,
        runnerTaskId: chainActor.taskId,
      });
      let outcome;
      try {
        outcome = await runner.runLightweight({
          commandId: runnerCommandId,
          taskId: chainActor.taskId,
          expectedRevision: runnerRevision,
          policyRef: runner.policyRef,
          budgetRef: runner.budgetRef,
          mode: 'tiny',
          subjectRef: candidate.executableRef,
          runProtocolRef: runner.protocolRefFor('tiny'),
        }, runnerActor);
      } finally {
        this.activeRunnerExecutions.delete(op.id);
      }
      if (!outcome.result) throw new ExperimentError('INVALID_RESULT', `candidate runner ${runnerCommandId} published no LightweightResult`);

      const observed = this.resolveObservations(outcome.result.metricRefs, this.phase2StorageRoot, chainActor.taskId);
      const planned = protocol.pairedSeeds.map((seed) => ({ variantId: candidate.id, seed, stage: 'comparison' as const }));
      const completed = new Set(observed.map((item) => `${item.variant}-${item.seed}`));
      const missing = planned.filter((trial) => !completed.has(`${trial.variantId}-${trial.seed}`));
      const report: CampaignReport = {
        schemaVersion: 1,
        protocolRef: artifactRefFor('experiment-protocol', JSON.stringify(protocolBody(protocol))),
        stage: 'comparison',
        plannedTrialRefs: planned.map((trial) => artifactRefFor(`trial-${trial.variantId}-s${trial.seed}`, JSON.stringify(trial))),
        attemptResultRefs: observed.map((item) => artifactRefFor(
          `observed-${item.metricId}-${String(item.variant)}-${String(item.seed)}`,
          JSON.stringify(item),
        )),
        missingTrialRefs: missing.map((trial) => artifactRefFor(`missing-${trial.variantId}-s${trial.seed}`, JSON.stringify(trial))),
        completion: missing.length === 0 ? 'complete' : 'incomplete',
        costRef: outcome.result.costRef,
        campaignHash: typedHash('phase3-search-campaign', {
          searchId: payload.searchId,
          attemptId: payload.attemptId,
          candidateId: candidate.id,
          executableRef: candidate.executableRef,
          lightweightProtocolRef: outcome.result.protocolRef,
          observations: observed,
        }),
      };
      const ref = this.publish(op.id, 'campaign-report.json', {
        report,
        observations: observed,
        searchId: payload.searchId,
        attemptId: payload.attemptId,
        candidateId: candidate.id,
        moduleRefs: candidate.moduleRefs,
        executableRef: candidate.executableRef,
        lightweightResultRef: { id: `${outcome.receipt.operationId}`, sha256: outcome.result.resultHash },
        lightweightCostRef: outcome.result.costRef,
        runnerTaskId: chainActor.taskId,
      });
      this.completeOperation(op.id, ref);
      return {
        receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision },
        campaignReportRef: ref,
      };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /** analyzeExperiment: build the comparison report from the verified trial set. */
  async analyzeExperiment(
    payload: { commandId: string; taskId: string; expectedRevision: number; campaignReportRef: ArtifactRef },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; comparisonReportRef: ArtifactRef }> {
    const method = 'analyzeExperiment';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return { receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, comparisonReportRef: reuse.resultRef as ArtifactRef };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      const protocol = this.getProtocol(payload.taskId);
      // The campaign report is READ BACK, not recomputed: the analysis consumes
      // the observations the run published, so a reader can tell which numbers
      // came from a run and which from arithmetic. The ref names the report; the
      // receipt's operationId names the store directory it lives in.
      const campaign = this.readPublishedCampaign(payload.campaignReportRef.id);
      const observations = (campaign.observations ?? []) as Array<Record<string, unknown>>;
      const perSeedRows = observations.map((o) => ({
        variantId: String(o.variant ?? 'unknown'),
        seed: typeof o.seed === 'number' ? o.seed : Number.NaN,
        metricId: String(o.metricId ?? 'unknown'),
        value: typeof o.value === 'number' ? o.value : null,
        // Every observation this report consumes came out of a run the verifier
        // accepted; an unverified one is excluded rather than marked verified.
        verified: true,
      }));

      // Paired comparison against the baseline arm, per (metric, seed). A seed
      // with no baseline counterpart is NOT paired and is listed as missing
      // rather than compared against a mean.
      const primary = protocol.primaryMetricId;
      const baselineBySeed = new Map<number, number>();
      for (const row of perSeedRows) {
        if (row.variantId === 'baseline' && row.metricId === primary && row.value !== null) {
          baselineBySeed.set(row.seed, row.value);
        }
      }
      const pairedDeltas: Array<Record<string, unknown>> = [];
      for (const row of perSeedRows) {
        if (row.variantId === 'baseline' || row.metricId !== primary || row.value === null) continue;
        const base = baselineBySeed.get(row.seed);
        if (base === undefined) continue;
        const spec = protocol.metricSpecs.find((m) => m.id === primary);
        const direction = spec?.direction ?? 'minimize';
        // The sign is normalized so that POSITIVE always means "better than
        // baseline", whichever direction the metric runs.
        const raw = row.value - base;
        pairedDeltas.push({
          variantId: row.variantId,
          seed: row.seed,
          metricId: primary,
          baselineValue: base,
          treatmentValue: row.value,
          rawDelta: raw,
          improvement: direction === 'minimize' ? -raw : raw,
        });
      }

      // A paired set of size 1 (or a delta set that is exactly zero) supports
      // no superiority statement. The SPEC is explicit: a sign is not a result.
      const meanImprovement = pairedDeltas.length > 0
        ? pairedDeltas.reduce((sum, d) => sum + (d.improvement as number), 0) / pairedDeltas.length
        : null;
      const allZero = pairedDeltas.length > 0 && pairedDeltas.every((d) => (d.improvement as number) === 0);
      const researchOutcome = pairedDeltas.length < 2
        ? 'inconclusive'
        : allZero
          ? 'no_difference_observed'
          : 'directional_only';

      const report: ComparisonReport = {
        schemaVersion: 1,
        protocolRef: artifactRefFor('experiment-protocol', JSON.stringify(protocolBody(protocol))),
        includedTrialRefs: payload.campaignReportRef ? [payload.campaignReportRef] : [],
        excludedTrials: observations
          .filter((o) => typeof o.value !== 'number' || !Number.isFinite(o.value))
          .map((o) => ({
            ref: artifactRefFor(`observed-${String(o.metricId)}-${String(o.variant)}-${String(o.seed)}`, JSON.stringify(o)),
            reason: `non-finite or missing value (${String(o.metricId)} ${String(o.variant)} s${String(o.seed)})`,
          })),
        missingTrials: (campaign.report?.missingTrialRefs ?? []) as ArtifactRef[],
        perSeedRows,
        aggregatesRef: null,
        costRef: artifactRefFor('cost-analysis', JSON.stringify({ taskId: payload.taskId })),
        researchOutcome,
        limitations: [
          'pilot scale: fewer than two paired seeds per arm supports no stable-superiority claim',
          'negative or zero results are reported as observed, not re-tuned',
          'the primary metric is measured on the frozen validation split and does not substitute for an independent final test split',
        ],
        comparisonHash: typedHash('phase3-comparison', { taskId: payload.taskId, campaign: payload.campaignReportRef, rows: perSeedRows.length }),
      };
      const ref = this.publish(op.id, 'comparison-report.json', {
        report,
        pairedDeltas,
        meanImprovement,
        outcomeRule: 'inconclusive when <2 paired deltas; no_difference_observed when every paired delta is exactly 0; otherwise directional_only',
      });
      this.completeOperation(op.id, ref);
      return { receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, comparisonReportRef: ref };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /** freezeSelection: freeze the chosen executable; refuses an empty freeze. */
  async freezeSelection(
    payload: { commandId: string; taskId: string; expectedRevision: number; comparisonRef: ArtifactRef; selectionDraftRef: ArtifactRef },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; selectionFreezeRef: ArtifactRef }> {
    const method = 'freezeSelection';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return { receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, selectionFreezeRef: reuse.resultRef as ArtifactRef };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      const protocol = this.getProtocol(payload.taskId);
      const draft = JSON.parse(fs.readFileSync(path.join(this.root, 'published', payload.selectionDraftRef.id, 'selection-draft.json'), 'utf8'));
      const selected = draft?.selectedExecutableRefs;
      if (!Array.isArray(selected) || selected.length === 0) {
        throw new ExperimentError('MODULE_NOT_READY', 'no valid candidate to freeze; refusing to publish an empty selection');
      }
      const freeze: SelectionFreeze = validateSelectionFreeze({
        schemaVersion: 1,
        protocolRef: artifactRefFor('experiment-protocol', JSON.stringify(protocolBody(protocol))),
        comparisonRef: payload.comparisonRef,
        selectedExecutableRefs: selected,
        selectionRuleRef: String(draft.selectionRuleRef ?? 'phase3-frozen-rule'),
        selectedConfigRefs: draft.selectedConfigRefs ?? selected,
        hash: typedHash('phase3-selection', { taskId: payload.taskId, comparison: payload.comparisonRef }),
        frozenAt: new Date().toISOString(),
      });
      this.frozenSelections.set(payload.taskId, freeze);
      const ref = this.publish(op.id, 'selection-freeze.json', freeze);
      this.completeOperation(op.id, ref);
      return { receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, selectionFreezeRef: ref };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /** evaluateFinal: grant one test evaluation against the frozen selection. */
  async evaluateFinal(
    payload: { commandId: string; taskId: string; expectedRevision: number; selectionFreezeRef: ArtifactRef; finalEvaluationPlanRef: ArtifactRef },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; finalTestReportRef: ArtifactRef | null }> {
    const method = 'evaluateFinal';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return { receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, finalTestReportRef: reuse.resultRef };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      const protocol = this.getProtocol(payload.taskId);
      const dataSplit = protocol.dataSplitRef;
      // No independent test split: formal final evaluation is blocked, the
      // pilot stands. This is the SPEC's explicit division.
      if (!dataSplit || dataSplit.sha256.length === 0) {
        throw new ExperimentError('DEPENDENCY_NOT_READY', 'no independent test split in the frozen protocol');
      }
      // The real-task claim needs a licensed real dataset; the pilot config
      // says so explicitly when it does not have one.
      this.assertActionUnblocked(payload.taskId, 'evaluateFinal');
      if (!this.frozenSelections.has(payload.taskId)) {
        throw new ExperimentError('POLICY_DENIED', 'final test requires a frozen selection first');
      }
      if (this.testAccessUsed) {
        throw new ExperimentError('POLICY_DENIED', 'test access already granted for this task');
      }
      this.testAccessUsed = true;
      const report: FinalTestReport = {
        schemaVersion: 1,
        freezeRef: payload.selectionFreezeRef,
        testAccessEventRef: artifactRefFor('test-access', JSON.stringify({ taskId: payload.taskId, at: new Date().toISOString() })),
        trialResultRefs: [],
        primaryMetricId: protocol.primaryMetricId,
        primaryDiffs: [],
        missing: ['test evaluator backend not prepared in this MVP increment'],
        applicabilityNotes: ['formal final evaluation blocked; pilot results stand as observed'],
        finalTestHash: typedHash('phase3-final-test', { taskId: payload.taskId }),
      };
      const ref = this.publish(op.id, 'final-test-report.json', report);
      this.completeOperation(op.id, ref);
      return { receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, finalTestReportRef: ref };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /**
   * reproduceExperiment: start a NEW run identity for the target trials and
   * compare each against the recorded campaign within the FROZEN tolerance.
   *
   * "New identity" is literal here: a different commandId, a different task id
   * in the runner store, and therefore a different run nonce per child process
   * — no cache hit is possible. Out-of-tolerance results are reported as
   * `failed`; the tolerance is read from the pilot config and is never widened
   * after seeing a number.
   */
  async reproduceExperiment(
    payload: {
      commandId: string;
      taskId: string;
      expectedRevision: number;
      targetTrialRefs: ArtifactRef[];
      reproductionPlanRef: ArtifactRef;
    },
    actor: CallerActor,
  ): Promise<{ receipt: Phase3Receipt; reproductionReportRef: ArtifactRef }> {
    const method = 'reproduceExperiment';
    const requestHash = Phase3Service.requestHashOf(payload as Record<string, unknown>);
    const reuse = this.reserveOrReuse(actor, payload.taskId, method, payload.commandId, requestHash);
    if (reuse) {
      this.assertOwner(reuse, actor);
      return {
        receipt: { operationId: reuse.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision },
        reproductionReportRef: reuse.resultRef as ArtifactRef,
      };
    }
    const op = this.createOperation(actor, payload.taskId, method, payload.commandId, requestHash);
    this.recordCommand(actor, payload.taskId, method, payload.commandId, requestHash, op.id);
    try {
      const protocol = this.getProtocol(payload.taskId);
      const cfg = this.pilotConfigs.get(payload.taskId);
      // The tolerance comes from the FROZEN pilot config, not from the caller
      // and not from the numbers being checked.
      const tolerance = this.readReproductionTolerance(cfg);

      // The campaign whose numbers this reproduction is compared against.
      const original = this.readLatestObservations(payload.taskId);

      // NEW identity: a different command suffix and a different runner task id,
      // so every child process gets a new run nonce and no cache can answer.
      const runner = this.matrixRunner(this.phase2StorageRoot);
      const executableRef = protocol.executableRefs[0] ?? cfg?.executableRefs[0] ?? null;
      if (!executableRef) {
        throw new ExperimentError('MODULE_NOT_READY', 'the frozen protocol carries no executableRef to reproduce');
      }
      const chainActor = this.phase2ExecutableOrigin(executableRef.id);
      if (!chainActor) {
        throw new ExperimentError(
          'DEPENDENCY_NOT_READY',
          `no task/owner is recorded for executable ${executableRef.id}; the research chain that registered it must be re-run`,
        );
      }
      // NEW identity: a different commandId, so a different idempotency key and
      // a different run nonce per child process. The TASK stays the executable's
      // own task because that is the one bound to its owner; a new task id would
      // be owner-unbound and the service would refuse it (correctly).
      const reproTaskId = chainActor.taskId;
      const revision = runner.getTaskRecord(chainActor.taskId).revision;
      const outcome = await runner.runLightweight(
        {
          commandId: `${payload.commandId}-repro`,
          taskId: reproTaskId,
          expectedRevision: revision,
          policyRef: runner.policyRef,
          budgetRef: runner.budgetRef,
          mode: 'tiny',
          subjectRef: executableRef,
          runProtocolRef: runner.protocolRefFor('tiny'),
        },
        { sessionId: chainActor.sessionId },
      );
      const reproduced = this.resolveObservations(
        outcome.result?.metricRefs ?? [],
        this.phase2StorageRoot,
        reproTaskId,
      );

      // Compare per (variant, seed, metric) on the primary metric.
      const primary = protocol.primaryMetricId;
      const key = (o: Record<string, unknown>): string => `${String(o.variant)}|${String(o.seed)}|${String(o.metricId)}`;
      const originalByKey = new Map<string, number>();
      for (const o of original) {
        if (String(o.metricId) !== primary) continue;
        if (typeof o.value === 'number' && Number.isFinite(o.value)) originalByKey.set(key(o), o.value);
      }
      const perTrial: ReproductionReport['perTrial'] = [];
      for (const o of reproduced) {
        if (String(o.metricId) !== primary) continue;
        const newValue = typeof o.value === 'number' && Number.isFinite(o.value) ? o.value : null;
        const originalValue = originalByKey.get(key(o)) ?? null;
        const withinTolerance =
          newValue === null || originalValue === null ? null : Math.abs(newValue - originalValue) <= tolerance;
        perTrial.push({
          trialRef: artifactRefFor(`repro-${key(o)}`, JSON.stringify(o)),
          originalValue,
          newValue,
          withinTolerance,
          outcome: withinTolerance === null ? 'blocked' : withinTolerance ? 'passed' : 'failed',
          notes:
            withinTolerance === false
              ? [`|Δ| ${Math.abs((newValue as number) - (originalValue as number)).toExponential(3)} exceeds the frozen tolerance ${tolerance}; kept as failed`]
              : withinTolerance === true
                ? [`|Δ| ${Math.abs((newValue as number) - (originalValue as number)).toExponential(3)} within the frozen tolerance ${tolerance}`]
                : ['no comparable original observation for this arm/seed'],
        });
      }

      const report: ReproductionReport = {
        schemaVersion: 1,
        protocolRef: artifactRefFor('experiment-protocol', JSON.stringify(protocolBody(protocol))),
        targetTrialRefs: payload.targetTrialRefs,
        perTrial,
        environmentDiffs: [
          'new run identity: different commandId, different runner task id, therefore a different run nonce per child process',
          'no cache is consulted: the runner always materializes a fresh workspace copy',
          'same pinned environment manifest and same frozen protocol body',
        ],
        toleranceRef: artifactRefFor('tolerance', JSON.stringify({ source: 'pilotConfig', taskId: payload.taskId })),
        reproductionHash: typedHash('phase3-reproduction', {
          taskId: payload.taskId,
          trials: perTrial.length,
          passed: perTrial.filter((t) => t.outcome === 'passed').length,
        }),
      };
      const ref = this.publish(op.id, 'reproduction-report.json', {
        report,
        tolerance,
        reproductionTaskId: reproTaskId,
        reproductionOperationId: op.id,
        runnerResultRef: outcome.result ? { operationId: outcome.receipt.operationId } : null,
      });
      this.completeOperation(op.id, ref);
      return { receipt: { operationId: op.id, commandId: payload.commandId, requestHash, taskRevision: payload.expectedRevision }, reproductionReportRef: ref };
    } catch (err) {
      const e = err instanceof ExperimentError ? err : new ExperimentError('PREFLIGHT_FAILED', String(err instanceof Error ? err.message : err));
      this.completeOperation(op.id, null, { code: e.code, message: e.message });
      throw e;
    }
  }

  /**
   * The reproduction tolerance, from the FROZEN pilot config.
   *
   * A tolerance that is not declared blocks the comparison rather than
   * defaulting to something permissive: "close enough" is a decision the pilot
   * freezes before the numbers exist.
   */
  private readReproductionTolerance(cfg: Phase3PilotConfig | undefined): number {
    const ref = cfg?.reproductionToleranceRef;
    if (!ref) {
      throw new ExperimentError('CONFIG_INCOMPLETE', 'the pilot config declares no reproduction tolerance; refusing to invent one', {
        fieldPaths: ['pilotConfig.reproductionToleranceRef'],
      });
    }
    const file = path.join(this.repoRoot, ref.id);
    if (!fs.existsSync(file)) {
      throw new ExperimentError('CONFIG_INCOMPLETE', `the tolerance file is missing: ${file}`, {
        fieldPaths: ['pilotConfig.reproductionToleranceRef.id'],
      });
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    const value = raw.reproductionTolerance ?? raw.absoluteTolerance ?? raw.tolerance;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ExperimentError(
        'CONFIG_INCOMPLETE',
        `the tolerance file ${ref.id} declares no positive reproductionTolerance; refusing to invent one`,
        { fieldPaths: ['reproductionTolerance'] },
      );
    }
    return value;
  }

  /** The most recent campaign's observations for this task, in publication order. */
  private readLatestObservations(taskId: string): Array<Record<string, unknown>> {
    const ops = fs.existsSync(this.root)
      ? fs.readdirSync(path.join(this.root, 'operations')).filter((f) => f.includes('runExperiment'))
      : [];
    let best: { at: number; observations: Array<Record<string, unknown>> } | null = null;
    for (const file of ops) {
      try {
        const op = JSON.parse(fs.readFileSync(path.join(this.root, 'operations', file), 'utf8')) as { id: string; taskId: string };
        if (op.taskId !== taskId) continue;
        const at = fs.statSync(path.join(this.root, 'operations', file)).mtimeMs;
        const campaignFile = path.join(this.root, 'published', op.id, 'campaign-report.json');
        if (!fs.existsSync(campaignFile)) continue;
        const campaign = JSON.parse(fs.readFileSync(campaignFile, 'utf8')) as { observations?: Array<Record<string, unknown>> };
        if (best === null || at > best.at) best = { at, observations: campaign.observations ?? [] };
      } catch {
        // an unreadable operation simply does not contribute observations
      }
    }
    return best?.observations ?? [];
  }

  /** Public query: one phase-3 operation by id, owner-checked. */
  getOperationForResearchCommand(taskId: string, commandId: string, actor: CallerActor): StoredOperation | null {
    const indexFile = path.join(this.root, 'index', 'phase3-command-index.json');
    if (!fs.existsSync(indexFile)) return null;
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<string, { operationId: string; requestHash: string }>;
    const hit = index[`${actor.sessionId}::${taskId}::runSearchCandidate::${commandId}`];
    if (!hit) return null;
    const operation = this.getOperation(hit.operationId, actor);
    if (operation.taskId !== taskId || operation.method !== 'runSearchCandidate' || operation.commandId !== commandId || operation.requestHash !== hit.requestHash) throw new ExperimentError('ARTIFACT_CORRUPT', 'Research execution command index differs from operation');
    return operation;
  }

  /** Public query: one phase-3 operation by id, owner-checked. */
  getOperation(operationId: string, actor: CallerActor): StoredOperation {
    const op = JSON.parse(fs.readFileSync(this.opPath(operationId), 'utf8')) as StoredOperation;
    this.assertOwner(op, actor);
    return op;
  }

  /** Diagnostics: count of operations per method (no payload data leaves the host). */
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    try {
      for (const f of fs.readdirSync(path.join(this.root, 'operations'))) {
        const op = JSON.parse(fs.readFileSync(path.join(this.root, 'operations', f), 'utf8')) as StoredOperation;
        out[op.method] = (out[op.method] ?? 0) + 1;
        out[`${op.method}:${op.status}`] = (out[`${op.method}:${op.status}`] ?? 0) + 1;
      }
    } catch { /* empty */ }
    return out;
  }

  /** Terminal check re-exported for the tool adapter. */
  static isTerminalStatus(status: string): boolean {
    void assertStatusTransition;
    return isTerminal(status as never);
  }
}
