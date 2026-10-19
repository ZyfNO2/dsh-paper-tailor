/**
 * LightweightRunner: executes the smoke/tiny protocol of docs/mvp/phases/PHASE2-SPEC.md section 3.
 *
 * Responsibilities kept deliberately narrow:
 * - expand a LightweightProtocol into one run per (variant, seed), each with its own run identity;
 * - start the profile's fixed runner as a real child process with a real timeout and real kill;
 * - collect execution facts from the process, never from its self-report alone;
 * - refuse to publish a result whose facts contradict the manifest identity.
 *
 * The runner never decides scientific value. It reports `runnable` / `needs_revision` /
 * `inconclusive` and nothing more; a smoke run has no metric budget at all.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { assertResourceMonitorAvailable, queryWorkingSetBytes, directoryBytes } from './task-profile.ts';
import {
  ExperimentError,
  computeLightweightResultHash,
  lightweightResultBody,
  type ArtifactRef,
  type LightweightProtocol,
  type LightweightResult,
  type MetricObservation,
  type LightweightMode,
} from '../contracts/experiments.ts';

export interface VariantRunPlan {
  variant: string;
  seed: number;
  runId: string;
}

export interface ExecutionFacts {
  runId: string;
  manifestHash: string;
  exitCode: number;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  rawResultPath: string | null;
  completedAt: string;
  peakWorkingSetBytes?: number;
  resourceSampleCount?: number;
  resourceLimitExceeded?: string | null;
}

export interface LightweightRunOutcome {
  result: LightweightResult;
  facts: ExecutionFacts[];
  observations: MetricObservation[];
  /** Absolute paths of every artifact this run published, for the caller to register. */
  publishedPaths: string[];
}

export interface RunnerOptions {
  /** Absolute path to the fixed runner script from the trusted profile. */
  runnerPath: string;
  /** Absolute path to the interpreter from the trusted profile. */
  interpreterPath: string;
  /** Where this operation's published artifacts live. */
  outputDir: string;
  /** Where scratch per-run directories live. */
  scratchDir: string;
  /** Hard per-run timeout; the profile declares it, a request may not raise it. */
  timeoutMs: number;
  /** Extra manifest fields the profile contributes (baseline path, environment, data spec). */
  manifestBase: Record<string, unknown>;
  /** Builds the variant's recipe from module ids. Supplied by the profile, not by a request. */
  compileRecipe: (variant: string) => { variant: string; modules: Array<Record<string, unknown>> };
  /** Names of the modules this run exercises, used for scope reporting. */
  moduleIds: string[];
  /** Device the profile promises; a mismatch fails preflight. */
  device: string;
  /**
   * Cooperative cancellation. When the signal fires, the child process is
   * killed 閳?not merely marked cancelled 閳?so a stopped run cannot keep
   * training in the background. Absent on every path that does not support
   * cancellation, which keeps the existing behaviour byte-identical.
   */
  abortSignal?: AbortSignal;
  /** Opt-in root-budget enforcement; existing Phase 2 defaults remain unchanged. */
  resourceLimits?: { maxWorkingSetBytes: number; maxOutputBytes: number; sampleIntervalMs?: number };
}

const STDOUT_TAIL_BYTES = 4000;

function tail(text: string, limit = STDOUT_TAIL_BYTES): string {
  return text.length <= limit ? text : `...${text.slice(text.length - limit)}`;
}

/**
 * One run identity per (variant, seed). The run id must be unique per execution so a rerun is
 * never mistaken for a cache hit, while the input snapshot stays identical.
 */
export function planVariantRuns(protocol: LightweightProtocol, runNonce: string): VariantRunPlan[] {
  const plans: VariantRunPlan[] = [];
  for (const variant of protocol.variants) {
    for (const seed of protocol.seeds) {
      plans.push({
        variant,
        seed,
        runId: `run-${variant}-s${seed}-${runNonce}`,
      });
    }
  }
  return plans;
}

/**
 * A smoke protocol must not declare metrics, and a tiny protocol must declare at least one.
 * Enforced here as well as in the contract so neither path can quietly do the other's job.
 */
export function assertModeProtocolShape(mode: LightweightMode, protocol: LightweightProtocol): void {
  if (mode === 'smoke') {
    if (protocol.metricSpecs.length > 0) {
      throw new ExperimentError('SCHEMA_VIOLATION', 'a smoke protocol may not declare metric specs', {
        fieldPaths: ['metricSpecs'],
      });
    }
    if (!protocol.inputSampleRef || !protocol.mechanismAssertionRefs?.length) {
      throw new ExperimentError(
        'SCHEMA_VIOLATION',
        'a smoke protocol requires an input sample and at least one mechanism assertion',
        { fieldPaths: ['inputSampleRef', 'mechanismAssertionRefs'] }
      );
    }
    return;
  }
  if (protocol.metricSpecs.length === 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', 'a tiny protocol must declare at least one metric spec', {
      fieldPaths: ['metricSpecs'],
    });
  }
}

/** Refuses a variant whose module count disagrees with the variant name's module set size. */
export function assertVariantModuleAgreement(variant: string, moduleIds: readonly string[]): void {
  if (variant === 'baseline') {
    if (moduleIds.length !== 0) {
      throw new ExperimentError('INCOMPATIBLE_BINDING', 'the baseline variant may not carry modules', {
        fieldPaths: ['variants'],
      });
    }
    return;
  }
  if (moduleIds.length === 0) {
    throw new ExperimentError('INCOMPATIBLE_BINDING', `variant "${variant}" carries no modules`, {
      fieldPaths: ['variants'],
    });
  }
  const expected = variant.length;
  if (moduleIds.length !== expected) {
    throw new ExperimentError(
      'INCOMPATIBLE_BINDING',
      `variant "${variant}" names ${expected} module position(s) but the recipe carries ${moduleIds.length}`,
      { fieldPaths: ['variants'] }
    );
  }
}

function hashFile(absPath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function writeJsonAtomic(absPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const staging = `${absPath}.staging-${process.pid}-${Date.now()}`;
  fs.writeFileSync(staging, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(staging, absPath);
}

export class LightweightRunner {
  readonly options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.options = options;
    for (const [label, p] of [
      ['runnerPath', options.runnerPath],
      ['interpreterPath', options.interpreterPath],
    ] as const) {
      if (!path.isAbsolute(p)) {
        throw new ExperimentError('POLICY_DENIED', `${label} must be an absolute trusted path, got "${p}"`, {
          fieldPaths: [label],
        });
      }
      if (!fs.existsSync(p)) {
        throw new ExperimentError('PREFLIGHT_FAILED', `${label} does not exist: ${p}`, { fieldPaths: [label] });
      }
    }
    if (options.timeoutMs <= 0) {
      throw new ExperimentError('INVALID_INPUT', 'timeoutMs must be positive', { fieldPaths: ['timeoutMs'] });
    }
  }

  /** Builds the manifest for one variant run. Every field is bound to the run identity. */
  buildManifest(plan: VariantRunPlan, protocol: LightweightProtocol, runDir: string): Record<string, unknown> {
    const recipe = this.options.compileRecipe(plan.variant);
    assertVariantModuleAgreement(plan.variant, recipe.modules.map((m) => String(m.id)));

    const body: Record<string, unknown> = {
      schemaVersion: 1,
      runId: plan.runId,
      variant: plan.variant,
      seed: plan.seed,
      stage: 'lightweight',
      lr: 0.01,
      batchSize: 4,
      limit: protocol.limit,
      outputDir: runDir,
      dataSpec: (this.options.manifestBase.dataSpec as Record<string, unknown>) ?? { kind: 'synthetic' },
      baselineImplementationPath: this.options.manifestBase.baselineImplementationPath,
      environment: {
        device: this.options.device,
        interpreter: this.options.interpreterPath,
        profileRef: protocol.profileRef,
      },
      protocolHash: protocol.protocolHash,
      recipe,
      createdAt: new Date().toISOString(),
    };

    const manifestHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return { ...body, manifestHash };
  }

  /** Runs one variant to completion, returning the real process facts. */
  async executeOne(
    plan: VariantRunPlan,
    protocol: LightweightProtocol,
    runDir: string
  ): Promise<{ facts: ExecutionFacts; rawResult: Record<string, unknown> | null; manifestPath: string }> {
    if (this.options.abortSignal?.aborted) throw new ExperimentError('POLICY_DENIED', 'Execution was cancelled before dispatch');
    const resources = this.options.resourceLimits;
    if (resources) {
      for (const value of Object.values(resources)) if (!Number.isSafeInteger(value) || value <= 0) throw new ExperimentError('CONFIG_INCOMPLETE', 'Resource limits must be positive safe integers');
      await assertResourceMonitorAvailable();
    }
    fs.mkdirSync(runDir, { recursive: true });
    const manifest = this.buildManifest(plan, protocol, runDir);
    const manifestPath = path.join(runDir, 'manifest.json');
    writeJsonAtomic(manifestPath, manifest);

    const stdoutPath = path.join(runDir, 'stdout.log');
    const stderrPath = path.join(runDir, 'stderr.log');
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');

    const startedAt = Date.now();
    let timedOut = false;
    let cancelled = false;
    let peakWorkingSetBytes = 0, resourceSampleCount = 0, resourceLimitExceeded: string | null = null;
    let pendingSample: Promise<void> | null = null;

    const exitInfo = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      const child = spawn(this.options.interpreterPath, [this.options.runnerPath, '--manifest', manifestPath], {
        cwd: path.resolve('.'),
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
      });

      let settled = false;
      let monitorTimer: NodeJS.Timeout | null = null;
      const killChild = (): void => {
        try {
          if (child.pid) process.kill(child.pid);
        } catch {
          /* already gone */
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        // Kill the whole process; a timed-out run must not keep training in the background.
        killChild();
      }, this.options.timeoutMs);
      const sample = (): void => {
        if (!resources || settled || pendingSample) return;
        pendingSample = (async () => {
          try {
            if (child.pid === undefined) throw new Error('Runner has no pid for resource monitoring');
            const bytes = await queryWorkingSetBytes(child.pid);
            if (bytes !== null) { peakWorkingSetBytes = Math.max(peakWorkingSetBytes, bytes); resourceSampleCount++;
              if (bytes > resources.maxWorkingSetBytes) resourceLimitExceeded = 'working-set budget exceeded'; }
            if (directoryBytes(runDir) > resources.maxOutputBytes) resourceLimitExceeded = 'output disk budget exceeded';
          } catch (error) { resourceLimitExceeded = `Resource monitor failed: ${error instanceof Error ? error.message : String(error)}`; }
          if (resourceLimitExceeded) killChild();
        })().finally(() => { pendingSample = null; });
      };
      if (resources) { sample(); monitorTimer = setInterval(sample, resources.sampleIntervalMs ?? 250); monitorTimer.unref(); }

      // Cooperative cancel: a signalled run must actually END. Marking the
      // operation cancelled while its child keeps training would be exactly the
      // "stopped text generation is not a cancelled experiment" failure the
      // SPEC names, so the process is killed here, not just recorded.
      const onAbort = (): void => {
        cancelled = true;
        killChild();
      };
      if (this.options.abortSignal) {
        if (this.options.abortSignal.aborted) onAbort();
        else this.options.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      const finish = (code: number | null, signal: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (monitorTimer) clearInterval(monitorTimer);
        this.options.abortSignal?.removeEventListener('abort', onAbort);
        resolve({ code, signal });
      };

      child.on('close', (code, signal) => finish(code, signal));
      child.on('error', () => finish(1, null));
    });
    if (pendingSample) await pendingSample;
    if (resources && resourceSampleCount === 0 && resourceLimitExceeded === null) resourceLimitExceeded = 'No working-set sample while runner was live';
    if (resources && directoryBytes(runDir) > resources.maxOutputBytes) resourceLimitExceeded = 'output disk budget exceeded';
    void cancelled;

    try {
      fs.closeSync(stdoutFd);
    } catch {
      /* already closed */
    }
    try {
      fs.closeSync(stderrFd);
    } catch {
      /* already closed */
    }

    const durationMs = Date.now() - startedAt;
    const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
    const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
    const rawResultPath = path.join(runDir, 'raw-result.json');

    const facts: ExecutionFacts = {
      runId: plan.runId,
      manifestHash: String(manifest.manifestHash),
      exitCode: exitInfo.code ?? (timedOut ? 124 : 1),
      signal: exitInfo.signal,
      timedOut,
      durationMs,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
      rawResultPath: fs.existsSync(rawResultPath) ? rawResultPath : null,
      completedAt: new Date().toISOString(),
      ...(resources ? { peakWorkingSetBytes, resourceSampleCount, resourceLimitExceeded } : {}),
    };

    let rawResult: Record<string, unknown> | null = null;
    if (facts.rawResultPath) {
      try {
        rawResult = JSON.parse(fs.readFileSync(facts.rawResultPath, 'utf8')) as Record<string, unknown>;
      } catch {
        rawResult = null;
      }
    }

    writeJsonAtomic(path.join(runDir, 'execution-facts.json'), facts);
    return { facts, rawResult, manifestPath };
  }

  /**
   * Verifies the run's self-report against the facts the host observed. A process that exited
   * non-zero, timed out, or whose raw result names a different run/manifest is refused: the
   * self-report never overrides the exit code.
   */
  verifyFacts(facts: ExecutionFacts, rawResult: Record<string, unknown> | null): void {
    if (facts.resourceLimitExceeded) throw new ExperimentError('BUDGET_EXHAUSTED', facts.resourceLimitExceeded);
    if (facts.timedOut) {
      throw new ExperimentError('RUN_TIMEOUT', `run ${facts.runId} timed out after ${facts.durationMs}ms`, {
        fieldPaths: ['limit'],
      });
    }
    if (facts.exitCode !== 0) {
      throw new ExperimentError(
        'INVALID_RESULT',
        `run ${facts.runId} exited with code ${facts.exitCode}; stdout claims cannot override the exit status. stderr tail: ${facts.stderrTail}`,
        { fieldPaths: ['exitCode'] }
      );
    }
    if (!rawResult) {
      throw new ExperimentError('INVALID_RESULT', `run ${facts.runId} produced no parseable raw-result.json`, {
        fieldPaths: ['rawResultPath'],
      });
    }
    if (rawResult.runId !== facts.runId) {
      throw new ExperimentError(
        'INVALID_RESULT',
        `raw result names run "${String(rawResult.runId)}" but this run is "${facts.runId}"`,
        { fieldPaths: ['runId'] }
      );
    }
    if (rawResult.manifestHash !== facts.manifestHash) {
      throw new ExperimentError('INVALID_RESULT', `raw result manifest hash does not match the executed manifest`, {
        fieldPaths: ['manifestHash'],
      });
    }
    if (rawResult.status !== 'succeeded') {
      throw new ExperimentError(
        'INVALID_RESULT',
        `raw result reported status "${String(rawResult.status)}" despite exit code 0`,
        { fieldPaths: ['status'] }
      );
    }
  }

  /**
   * Extracts the declared metrics from a raw result; a missing metric is never invented.
   *
   * `arm` names the (variant, seed) this raw result came from and is recorded on every
   * observation, so a multi-variant run publishes numbers that can be attributed without
   * inferring the arm from file ordering.
   */
  extractObservations(
    rawResult: Record<string, unknown>,
    protocol: LightweightProtocol,
    evaluatorRef: ArtifactRef,
    arm?: { variant: string; seed: number }
  ): MetricObservation[] {
    const metrics = (rawResult.metrics ?? {}) as Record<string, { value?: unknown; unit?: unknown; split?: unknown; sampleCount?: unknown }>;
    const observations: MetricObservation[] = [];

    for (const spec of protocol.metricSpecs) {
      const raw = metrics[spec.evaluatorOutputKey];
      if (!raw) {
        // Absent metric -> no observation. The caller reports the gap instead of a zero.
        continue;
      }
      const value = raw.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ExperimentError(
          'INVALID_RESULT',
          `metric "${spec.id}" produced a non-finite value (${String(value)})`,
          { fieldPaths: [`metrics.${spec.evaluatorOutputKey}`] }
        );
      }
      if (spec.validRange && (value < spec.validRange[0] || value > spec.validRange[1])) {
        throw new ExperimentError(
          'INVALID_RESULT',
          `metric "${spec.id}" value ${value} is outside its declared range [${spec.validRange[0]}, ${spec.validRange[1]}]`,
          { fieldPaths: [`metrics.${spec.evaluatorOutputKey}`] }
        );
      }
      observations.push({
        metricId: spec.id,
        value,
        unit: spec.unit,
        split: spec.split,
        sampleCount: typeof raw.sampleCount === 'number' ? raw.sampleCount : 0,
        evaluatorRef,
        rawEvidenceRefs: [],
        ...(arm ? { variant: arm.variant, seed: arm.seed } : {}),
      });
    }
    return observations;
  }

  /**
   * Runs the whole protocol and publishes a LightweightResult.
   *
   * A smoke run stops at runnable/needs_revision and publishes no metrics. A tiny run publishes
   * metrics but makes no claim about improvement: the conclusion only says whether the protocol
   * produced usable observations.
   */
  async run(
    mode: LightweightMode,
    protocol: LightweightProtocol,
    subjectRef: ArtifactRef,
    checkReportRef: ArtifactRef
  ): Promise<LightweightRunOutcome> {
    assertModeProtocolShape(mode, protocol);

    const runNonce = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const plans = planVariantRuns(protocol, runNonce);
    const publishedPaths: string[] = [];
    const factsList: ExecutionFacts[] = [];
    const allObservations: MetricObservation[] = [];
    const manifestRefs: ArtifactRef[] = [];
    const factsRefs: ArtifactRef[] = [];
    const metricRefs: ArtifactRef[] = [];

    let firstFailure: ExperimentError | null = null;

    for (const plan of plans) {
      const runDir = path.join(this.options.scratchDir, plan.runId);
      let outcome: { facts: ExecutionFacts; rawResult: Record<string, unknown> | null; manifestPath: string };
      try {
        outcome = await this.executeOne(plan, protocol, runDir);
      } catch (err) {
        // A failure to even start is recorded as the first error and stops the protocol.
        firstFailure =
          err instanceof ExperimentError
            ? err
            : new ExperimentError('PREFLIGHT_FAILED', `failed to start run ${plan.runId}: ${String(err)}`);
        break;
      }

      factsList.push(outcome.facts);
      const factsPath = path.join(runDir, 'execution-facts.json');
      const manifestPath = path.join(runDir, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        manifestRefs.push({ id: `manifest-${plan.runId}`, sha256: hashFile(manifestPath) });
      }
      if (fs.existsSync(factsPath)) {
        factsRefs.push({ id: `facts-${plan.runId}`, sha256: hashFile(factsPath) });
      }

      try {
        this.verifyFacts(outcome.facts, outcome.rawResult);
      } catch (err) {
        // Keep the FIRST error; later runs do not overwrite the reason the protocol stopped.
        firstFailure =
          err instanceof ExperimentError ? err : new ExperimentError('INVALID_RESULT', String(err));
        break;
      }

      if (mode === 'tiny' && outcome.rawResult) {
        const evaluatorRef: ArtifactRef = outcome.facts.rawResultPath
          ? { id: `raw-${plan.runId}`, sha256: hashFile(outcome.facts.rawResultPath) }
          : { id: `raw-${plan.runId}`, sha256: '0'.repeat(64) };
        const observations = this.extractObservations(outcome.rawResult, protocol, evaluatorRef, {
          variant: plan.variant,
          seed: plan.seed,
        });
        for (const observation of observations) {
          const obsPath = path.join(this.options.outputDir, `metric-${plan.variant}-s${plan.seed}.json`);
          writeJsonAtomic(obsPath, observation);
          publishedPaths.push(obsPath);
          metricRefs.push({ id: `metric-${plan.variant}-s${plan.seed}`, sha256: hashFile(obsPath) });
          allObservations.push(observation);
        }
      }
    }

    // Cost is recorded even when the protocol failed part-way: failed attempts count.
    const costPath = path.join(this.options.outputDir, 'cost.json');
    writeJsonAtomic(costPath, {
      schemaVersion: 1,
      mode,
      plannedRuns: plans.length,
      startedRuns: factsList.length,
      completedRuns: factsList.filter((f) => f.exitCode === 0 && !f.timedOut).length,
      totalDurationMs: factsList.reduce((sum, f) => sum + f.durationMs, 0),
      runs: factsList.map((f) => ({
        runId: f.runId,
        exitCode: f.exitCode,
        timedOut: f.timedOut,
        durationMs: f.durationMs,
      })),
    });
    publishedPaths.push(costPath);
    const costRef: ArtifactRef = { id: 'cost', sha256: hashFile(costPath) };

    const conclusion = firstFailure
      ? 'needs_revision'
      : factsList.length === plans.length
        ? 'runnable'
        : 'inconclusive';

    const resultBody = {
      mode,
      subjectRef,
      protocolRef: { id: `protocol-${protocol.protocolHash.slice(0, 12)}`, sha256: protocol.protocolHash },
      manifestRefs,
      executionFactsRefs: factsRefs,
      checkReportRef,
      metricRefs,
      costRef,
      conclusion,
    };

    const result: LightweightResult = {
      ...resultBody,
      resultHash: computeLightweightResultHash(resultBody),
    } as LightweightResult;

    const resultPath = path.join(this.options.outputDir, `${mode}-result.json`);
    writeJsonAtomic(resultPath, result);
    publishedPaths.push(resultPath);

    // The first error is published whenever the protocol stopped early 閳?including a run that
    // started and then failed (timeout, non-zero exit, identity mismatch), which is exactly the
    // case where "keep the first error" matters most. Otherwise a failed run would leave only a
    // conclusion and no reason.
    if (firstFailure) {
      const errorPath = path.join(this.options.outputDir, 'first-error.json');
      writeJsonAtomic(errorPath, {
        ...firstFailure.toExecutionError(),
        startedRuns: factsList.length,
        plannedRuns: plans.length,
        failedRunId: factsList.length > 0 ? factsList[factsList.length - 1].runId : null,
      });
      publishedPaths.push(errorPath);
    }

    void lightweightResultBody(result);

    return { result, facts: factsList, observations: allObservations, publishedPaths };
  }
}
