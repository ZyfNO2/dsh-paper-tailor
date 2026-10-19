/**
 * Phase 3 tool adapter: registers the seven `evolver_*` Phase 3 tools plus the
 * read/stop helpers on the DSH tools registry, sharing the Phase 2 adapter's
 * owner resolution (the invoking Agent's session id is the owner; the request
 * payload never carries it).
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md sections 3 and 7.2. Long-running work
 * returns its receipt immediately; the Agent polls getOperation like any other
 * evolver operation.
 */

import * as path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { EvolverError } from '../../contracts/index.ts';
import { ExperimentError } from '../../contracts/experiments.ts';
import { Phase3Service } from '../../application/phase3-service.ts';
import { resolveRepoPath } from './repo-root.ts';

export const name = 'evolver-phase3-tools';

export interface Phase3ToolConfig {
  repoRoot?: string;
  /** Storage root for phase 3 operations (repo-relative). */
  storageRoot?: string;
  /** Trusted host config path for the frozen pilot config (repo-relative). */
  pilotConfigPath?: string;
  /**
   * The Phase 2 host config the REAL matrix runner is built from. These are
   * trusted host paths (never request parameters): the Phase 3 pilot reuses the
   * Phase 2 pinned child process, budget and verification, and only swaps the
   * frozen protocol body for the comparison matrix.
   */
  phase2?: {
    constraintsPath: string;
    smokeProtocolPath: string;
    tinyProtocolPath: string;
    sourceCheckout: string;
    pythonPath: string;
    sourceBundleKey?: string;
    runTimeoutMs?: number;
  };
  /** The host-frozen Phase 3 comparison matrix (repo-relative). */
  comparisonProtocolPath: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    evolverPhase3?: Phase3Service;
  }
}

function resolveActor(_ctx: Context, exec: ToolRunContext): { sessionId: string; agentId?: string } {
  const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
  const sessionId = agent?.id ?? agent?.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new EvolverError('OWNER_MISMATCH', 'Caller context must provide a non-empty session owner');
  }
  return { sessionId: sessionId.trim(), agentId: agent?.id };
}

function toErrorResult(err: unknown): { error: { code: string; message: string; retryable: boolean } } {
  if (err instanceof ExperimentError) {
    return { error: { code: err.code, message: err.message, retryable: err.retryable } };
  }
  if (err instanceof EvolverError) {
    return { error: { code: err.code, message: err.message, retryable: false } };
  }
  return { error: { code: 'PREFLIGHT_FAILED', message: String(err instanceof Error ? err.message : err), retryable: false } };
}

export function applyPhase3Tools(ctx: Context, config: Phase3ToolConfig): Phase3Service {
  const repoRoot = resolveRepoPath(config.repoRoot ?? '.');
  const service = new Phase3Service({
    storageRoot: path.resolve(repoRoot, config.storageRoot ?? 'artifacts/phase3/experiments'),
    repoRoot,
    comparisonProtocolPath: path.resolve(repoRoot, config.comparisonProtocolPath),
    ...(config.phase2
      ? {
          phase2: {
            ...config.phase2,
            // The research bundle is the one the pilot is bound to; the manual
            // bundle stays on the Phase 2 path untouched.
            sourceBundleKey: config.phase2.sourceBundleKey ?? 'researchBundle',
          },
        }
      : {}),
  });

  const pilotConfigPath = config.pilotConfigPath
    ? path.resolve(repoRoot, config.pilotConfigPath)
    : undefined;

  const commandParams = {
    commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
    taskId: { type: 'string', required: true, description: 'Task id owning this experiment' },
    expectedRevision: { type: 'number', required: true, description: 'Current task revision (CAS)' },
  } as const;

  const receiptSchema = {
    type: 'object',
    additionalProperties: true,
    properties: {
      receipt: { type: 'object', additionalProperties: true },
      protocolRef: { type: 'object', additionalProperties: true },
      baselineReportRef: { type: 'object', additionalProperties: true },
      campaignReportRef: { type: 'object', additionalProperties: true },
      comparisonReportRef: { type: 'object', additionalProperties: true },
      selectionFreezeRef: { type: 'object', additionalProperties: true },
      finalTestReportRef: { type: 'object', additionalProperties: true },
      reproductionReportRef: { type: 'object', additionalProperties: true },
      error: { type: 'object', additionalProperties: true },
    },
  } as const;

  const render = (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: JSON.stringify(value, null, 2) },
  ];

  ctx.tools.register(defineTool({
    name: 'evolver_freeze_experiment',
    description: 'Phase 3: freeze an immutable ExperimentProtocol from a draft after validating it against the host-frozen pilot config. Requires kind:research candidate binding; blocked config fields refuse the freeze.',
    parameters: {
      ...commandParams,
      draftProtocol: { type: 'object', additionalProperties: true, required: true, description: 'Draft ExperimentProtocol (section 2 of the spec)' },
    },
    output: { schema: receiptSchema, render },
    execute: async (args: unknown, exec: ToolRunContext) => {
      const actor = resolveActor(ctx, exec);
      try {
        const a = args as { commandId: string; taskId: string; expectedRevision: number; draftProtocol: unknown };
        const r = await service.freezeExperiment({ ...a, ...(pilotConfigPath ? { pilotConfigPath } : {}) }, actor);
        return r;
      } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_calibrate_baseline',
    description: 'Phase 3: calibrate the baseline against the pre-declared reproduction target and publish the BaselineReport. Required before runExperiment.',
    parameters: {
      ...commandParams,
      reproductionTargetRef: { type: 'object', additionalProperties: true, required: true, description: 'Official target reference (paper conditions + acceptance criterion)' },
    },
    output: { schema: receiptSchema, render },
    execute: async (args: unknown, exec: ToolRunContext) => {
      const actor = resolveActor(ctx, exec);
      try { return await service.calibrateBaseline(args as never, actor); } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_run_experiment',
    description: 'Phase 3: execute the frozen protocol comparison (and optional ablation) matrix over the paired seeds. Serial trials; one active campaign; returns the CampaignReport (completion may be incomplete).',
    parameters: {
      ...commandParams,
      stages: { type: 'array', items: { type: 'string', enum: ['comparison', 'ablation'] }, required: true, description: 'Stages to run' },
    },
    output: { schema: receiptSchema, render },
    execute: async (args: unknown, exec: ToolRunContext) => {
      const actor = resolveActor(ctx, exec);
      try { return await service.runExperiment(args as never, actor); } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_analyze_experiment',
    description: 'Phase 3: analyze the campaign into the ComparisonReport (per-seed rows, exclusions, limitations). Negative results are published as-is.',
    parameters: {
      ...commandParams,
      campaignReportRef: { type: 'object', additionalProperties: true, required: true, description: 'Published campaign report reference' },
    },
    output: { schema: receiptSchema, render },
    execute: async (args: unknown, exec: ToolRunContext) => {
      const actor = resolveActor(ctx, exec);
      try { return await service.analyzeExperiment(args as never, actor); } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_freeze_selection',
    description: 'Phase 3: freeze the selected executable(s) from the comparison. Refuses to publish an empty selection (MODULE_NOT_READY).',
    parameters: {
      ...commandParams,
      comparisonRef: { type: 'object', additionalProperties: true, required: true, description: 'Published comparison report' },
      selectionDraftRef: { type: 'object', additionalProperties: true, required: true, description: 'Draft selection to validate and freeze' },
    },
    output: { schema: receiptSchema, render },
    execute: async (args: unknown, exec: ToolRunContext) => {
      const actor = resolveActor(ctx, exec);
      try { return await service.freezeSelection(args as never, actor); } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_evaluate_final',
    description: 'Phase 3: run the frozen selection against the independent test split. Without an independent test split this reports DEPENDENCY_NOT_READY (formal blocked, pilot stands).',
    parameters: {
      ...commandParams,
      selectionFreezeRef: { type: 'object', additionalProperties: true, required: true, description: 'Published selection freeze' },
      finalEvaluationPlanRef: { type: 'object', additionalProperties: true, required: true, description: 'Final evaluation plan (protocol-compatible)' },
    },
    output: { schema: receiptSchema, render },
    execute: async (args: unknown, exec: ToolRunContext) => {
      const actor = resolveActor(ctx, exec);
      try { return await service.evaluateFinal(args as never, actor); } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_reproduce_experiment',
    description: 'Phase 3: start a NEW run identity (fresh work dir, cache bypass) for the target trials and compare within the frozen tolerance. Out-of-tolerance stays failed.',
    parameters: {
      ...commandParams,
      targetTrialRefs: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Trials to reproduce' },
      reproductionPlanRef: { type: 'object', additionalProperties: true, required: true, description: 'Reproduction plan (environment + tolerance)' },
    },
    output: { schema: receiptSchema, render },
    execute: async (args: unknown, exec: ToolRunContext) => {
      const actor = resolveActor(ctx, exec);
      try { return await service.reproduceExperiment(args as never, actor); } catch (err) { return toErrorResult(err); }
    },
  }));

  ctx.provide('evolverPhase3', service);
  return service;
}
