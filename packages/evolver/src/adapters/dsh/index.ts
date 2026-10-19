/**
 * DSH Adapter: Cordis plugin that registers evolver tools and service.
 */

import * as path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import {
  type Command,
  type TaskSpec,
  type TaskSnapshot,
  type Operation,
  type Receipt,
  EvolverError,
} from '../../contracts/index.ts';
import { StorageDomain } from '../../domain/index.ts';
import { EvolverService, type CallerActor } from '../../application/index.ts';
import { applyResearchTools, type ResearchToolConfig } from './research-tools.ts';
import { DshSdkModelPort } from './dsh-sdk-port.ts';
import { apply as applyLiveProbe } from './live-probe.ts';
import { apply as applyLiveExtract } from './live-extract.ts';
import { apply as applyHostDiagnostic } from './host-diagnostic.ts';
import { applyExperimentTools, type ExperimentToolConfig } from './experiment-tools.ts';
import { applyPhase3Tools, type Phase3ToolConfig } from './phase3-tools.ts';
import { applyWorkbenchTools, type WorkbenchToolConfig } from './workbench-tools.ts';
import { applyKnowledgeTools, type KnowledgeToolConfig } from './knowledge-tools.ts';
import { loadPhase2HostConfig } from './phase2-host-config.ts';
import type { ExperimentService } from '../../application/experiment-service.ts';
import type { KnowledgeService } from '../../application/knowledge-service.ts';
import { resolveRepoPath } from './repo-root.ts';

export const name = 'evolver';
// `llm` is deliberately NOT in `inject`.
//
// Cordis throws `cannot get property "llm" without inject` for an undeclared read,
// and every declared form (`['tools','llm']`, `?llm`, `{optional:true}`,
// `{required,optional}`) makes the service REQUIRED - measured against the real
// Loader, all three left the fiber PENDING when `llm` was absent. So the optional
// read has to go through `ctx.get('llm')`, which returns undefined instead of
// throwing, and `llm` must stay out of `inject`.
//
// Consequence worth knowing: adding `llm` here would make the plugin fail to
// apply at all in a host with no model runtime, taking the P0-P4 tools with it.
export const inject = ['tools'];
export const provide = ['evolver'];

export interface EvolverPluginConfig {
  storageDir?: string;
  hostId?: string;
  /** When present, the paper-only P5/P6/P7 tools are registered alongside P0-P4. */
  research?: ResearchToolConfig;
  /**
   * Live route for research extraction, used when the host has an `llm` service.
   *
   * The paper-only tools prefer this over the headless launcher: the host process
   * already has the user's route and credentials, and the headless profile has no
   * connector for it. When unset, the research tools fall back to whatever port
   * the caller injects, which is how the offline and replay runs stay unaffected.
   */
  liveRoute?: { provider: string; model: string; reasoningEffort?: string };
  /**
   * Registers the `evolver_probe_live_route` diagnostic tool.
   *
   * Off by default: the tool exists to prove the host route is reachable, and a
   * plugin that registers it unconditionally would expose a model-calling tool
   * in every session, including offline ones.
   */
  liveProbe?: boolean;
  /**
   * Registers `evolver_phase1_diagnostic`, the in-host full-chain runner.
   *
   * Separate from `liveProbe` on purpose: the probe and `live_extract` are
   * single-call diagnostics, while this one runs the whole frozen 12-case
   * diagnostic and is what a closing run must use. Registering it must stay an
   * explicit opt-in so an ordinary session is never silently charged for a
   * 12-case live run.
   */
  hostDiagnostic?: boolean;
  /**
   * When present, the Phase 2 lightweight-verification tools are registered
   * alongside P0-P4 and the paper-only set.
   *
   * Separate from `research` on purpose: the Phase 2 chain starts real child
   * processes against real pinned sources and data, so it is opt-in and is never
   * registered in a session that did not ask for it. The host planning
   * constraints and both run protocols are loaded from disk (trusted host
   * config) rather than taken from a request.
   */
  phase2?: Omit<ExperimentToolConfig, 'constraints' | 'protocols' | 'service'> & {
    constraintsPath?: string;
    smokeProtocolPath?: string;
    tinyProtocolPath?: string;
  };
  /**
   * When present, the Phase 3 experiment tools (freezeExperiment …
   * reproduceExperiment) are registered alongside the other tool sets.
   *
   * SEPARATE opt-in on purpose: Phase 3 starts real training child processes,
   * so it is only registered where the host configuration asks for it. The
   * frozen pilot config is read from disk (trusted host config), never from a
   * request.
   */
  phase3?: Phase3ToolConfig & {
    /** Host-frozen comparison matrix, repo-relative. Required for a real run. */
    comparisonProtocolPath?: string;
  };
  /**
   * The research-workbench submission tools (W5).
   *
   * A SEPARATE opt-in from `phase3` on purpose: these tools WRITE the workbench
   * sidecar, so registering them wherever experiments are registered would put
   * a write path in every session that only wants to read. Presence of this key
   * is the switch for `evolver_get_stage_context` and `evolver_submit_design`.
   *
   * The stage policy path is TRUSTED host config; a request can never name its
   * own policy, objectives or Skill.
   */
  workbenchResearch?: WorkbenchToolConfig;
  /** Optional K-min text knowledge tools, scoped by trusted host config. */
  knowledge?: KnowledgeToolConfig;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    evolver?: EvolverService;
    /**
     * The Phase 2 experiment service, present only when the host configured `phase2`.
     *
     * Exposed so a host-side driver can share one service (and one storage root) with the tools
     * instead of constructing a second one with a different view of the same operations.
     */
    evolverExperiments?: ExperimentService;
    evolverKnowledge?: KnowledgeService;
    /**
     * The host model service.
     *
     * Declared for typing only: reading it is legal because `llm` is absent from
     * `inject` (see the note above) and the code uses `ctx.get('llm')`, which
     * returns undefined instead of throwing.
     */
    llm?: unknown;
  }
}

function resolveActor(_ctx: Context, exec: ToolRunContext): CallerActor {
  // The owning Session id comes from the invoking Agent.
  //
  // There is deliberately no `ctx.currentSessionId` fallback: no DSH service or
  // context property of that name exists (the only occurrences in the host are
  // React component props), and an undeclared context read throws
  // `cannot get property "..." without inject`, which would abort every tool
  // call. If the Agent carries no id the call is rejected rather than attributed
  // to a made-up owner.
  const sessionId =
    (exec.agent as { id?: string; sessionId?: string } | undefined)?.id ??
    (exec.agent as { id?: string; sessionId?: string } | undefined)?.sessionId;

  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new EvolverError('OWNER_MISMATCH', 'Caller context must provide a non-empty session owner');
  }

  return {
    sessionId: sessionId.trim(),
    agentId: (exec.agent as { id?: string } | undefined)?.id,
  };
}

export function apply(ctx: Context, config: EvolverPluginConfig = {}): void {
  ctx.provide('evolver');
  // Resolved against the REPOSITORY, not the process working directory. The host may
  // be launched from anywhere, and a `cwd`-relative default meant two launches from
  // different shells used two different storage roots — so the single-writer lock
  // (StorageDomain, HOST_BUSY) either fired against an unrelated directory or failed
  // to protect the one actually in use. A host that needs a different root sets
  // `storageDir` explicitly (it may be absolute).
  const storageDir = resolveRepoPath(config.storageDir ?? 'data/evolver');
  const hostId = config.hostId ?? `host-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const storage = new StorageDomain(storageDir);
  const service = new EvolverService(storage, hostId);

  ctx.evolver = service;
  ctx.on('dispose', () => {
    service.dispose();
  });

  // Tool 1: evolver_create_task
  ctx.tools.register(
    defineTool({
      name: 'evolver_create_task',
      description: 'Create a new academic evolution task. The owner session is bound from context.',
      parameters: {
        commandId: { type: 'string', required: true, description: 'Command idempotency id' },
        title: { type: 'string', description: 'Optional task title' },
        draftSpec: { type: 'object', additionalProperties: true, description: 'Optional initial TaskSpec' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            ownerSessionId: { type: 'string' },
            revision: { type: 'number' },
            title: { type: 'string' },
            spec: { type: 'object', additionalProperties: true },
            operationIds: { type: 'array', items: { type: 'string' } },
            campaignIds: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `Task created: ${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { commandId: string; title?: string; draftSpec?: TaskSpec };
        return service.createTask(a.commandId, a.title, a.draftSpec, actor);
      },
    })
  );

  // Tool 2: evolver_get_task
  ctx.tools.register(
    defineTool({
      name: 'evolver_get_task',
      description: 'Get an existing task snapshot. Fails with OWNER_MISMATCH if caller is not the owner.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task ID to retrieve' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            ownerSessionId: { type: 'string' },
            revision: { type: 'number' },
            title: { type: 'string' },
            spec: { type: 'object', additionalProperties: true },
            operationIds: { type: 'array', items: { type: 'string' } },
            campaignIds: { type: 'array', items: { type: 'string' } },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `Task snapshot: ${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { taskId: string };
        return service.getTask(a.taskId, actor);
      },
    })
  );

  // Tool 3: evolver_save_spec
  ctx.tools.register(
    defineTool({
      name: 'evolver_save_spec',
      description: 'Save or update task specification with revision check and idempotency protection.',
      parameters: {
        command: { type: 'object', additionalProperties: true, required: true, description: 'Command object containing commandId, taskId, expectedRevision' },
        spec: { type: 'object', additionalProperties: true, required: true, description: 'TaskSpec object to persist' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            revision: { type: 'number' },
            receipt: {
              type: 'object',
              additionalProperties: true,
              properties: {
                commandId: { type: 'string' },
                taskId: { type: 'string' },
                revision: { type: 'number' },
                operationId: { type: 'string' },
              },
            },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `Spec saved at revision: ${(value as { revision: number }).revision}` },
        ],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { command: Command; spec: TaskSpec };
        return service.saveSpec(a.command, a.spec, actor);
      },
    })
  );

  // Tool 4: evolver_get_operation
  ctx.tools.register(
    defineTool({
      name: 'evolver_get_operation',
      description: 'Get details of an operation by taskId and operationId.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task ID' },
        operationId: { type: 'string', required: true, description: 'Operation ID' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            commandId: { type: 'string' },
            kind: { type: 'string' },
            status: { type: 'string' },
            resultRefs: { type: 'array', items: { type: 'string' } },
            error: { type: 'object', additionalProperties: true },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `Operation: ${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { taskId: string; operationId: string };
        return service.getOperation(a.taskId, a.operationId, actor);
      },
    })
  );

  // Tool 5: evolver_run_baseline
  ctx.tools.register(
    defineTool({
      name: 'evolver_run_baseline',
      description: 'Run the fixed stitch-cpu-v1 baseline training experiment for 5 steps.',
      parameters: {
        command: { type: 'object', additionalProperties: true, required: true, description: 'Command object containing commandId, taskId, expectedRevision' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            receipt: { type: 'object', additionalProperties: true },
            operation: { type: 'object', additionalProperties: true },
            verifiedResult: { type: 'object', additionalProperties: true },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `Baseline run complete: ${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { command: Command };
        return service.runBaseline(a.command, actor);
      },
    })
  );

  // Tool 6: evolver_stop_operation
  ctx.tools.register(
    defineTool({
      name: 'evolver_stop_operation',
      description: 'Stop a running operation on a task.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task ID' },
        operationId: { type: 'string', required: true, description: 'Operation ID to cancel' },
        commandId: { type: 'string', required: true, description: 'Command ID' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            commandId: { type: 'string' },
            kind: { type: 'string' },
            status: { type: 'string' },
            resultRefs: { type: 'array', items: { type: 'string' } },
            error: { type: 'object', additionalProperties: true },
            createdAt: { type: 'string' },
            updatedAt: { type: 'string' },
          },
        },
        render: (_args: unknown, value: unknown) => [
          { type: 'text', text: `Operation stopped: ${JSON.stringify(value, null, 2)}` },
        ],
      },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        const a = args as { taskId: string; operationId: string; commandId: string };
        return service.stopOperation(a.taskId, a.operationId, a.commandId, actor);
      },
    })
  );

  if (config.research) {
    // Prefer the in-process host route when one is configured AND the host really
    // exposes the llm service. `ctx.get` is used instead of `ctx.llm` because it
    // returns undefined when the service is absent (offline and replay hosts)
    // instead of throwing, which is what keeps this plugin loadable there.
    const hostLlm = ctx.get('llm');
    const route = config.liveRoute;
    const research: ResearchToolConfig = { ...config.research };
    if (route && hostLlm) {
      const port = new DshSdkModelPort({
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        llm: hostLlm as ConstructorParameters<typeof DshSdkModelPort>[0]['llm'],
        label: 'host llm service',
      });
      research.discoveryPort = research.discoveryPort ?? port;
      research.synthesisPort = research.synthesisPort ?? port;
    }
    applyResearchTools(ctx, research);

    // Diagnostics for the host route. Registered only when a route is configured,
    // because the tool exists solely to exercise it.
    if (route && config.liveProbe) {
      applyLiveProbe(ctx, route);
      applyLiveExtract(ctx, {
        ...route,
        fixturesRoot: config.research!.fixturesRoot,
        storageRoot: config.research!.storageRoot,
        skillRoot: config.research!.skillRoot,
      });
    }

    // The full-chain diagnostic runner. Registered independently of the single-call
    // probe because it is a different order of magnitude of model spend, and it is
    // the entry point a closing run must use: it reuses the frozen cases,
    // assertions and budgets from the trusted CLI driver and only swaps the
    // transport for the host model route.
    if (route && config.hostDiagnostic && hostLlm) {
      applyHostDiagnostic(ctx, {
        ...route,
        repoRoot: path.resolve(config.research!.fixturesRoot, '..', '..'),
        fixtureRoot: config.research!.fixturesRoot,
        storageRoot: config.research!.storageRoot,
        // No `sessionId`: the tool resolves the owner from the invoking Agent at
        // call time, and a plugin-load-time sessionId would be the wrong owner.
      });
    }
  }

  // Phase 2 (lightweight verification) is a SEPARATE opt-in from the paper-only
  // toolchain. It starts real child processes and reads real data, so registering
  // it in an ordinary session would expose a run-capable surface nobody asked
  // for. Presence of `phase2` is the switch, exactly as `research` is for P5-P7.
  if (config.phase2) {
    const repoRoot = resolveRepoPath(config.phase2.repoRoot ?? '.');
    // The host constraints and both run protocols are TRUSTED HOST CONFIG loaded
    // from disk by the host. A caller cannot supply them, and they are validated
    // through the frozen contract here so a bad file fails at load rather than
    // halfway through a run.
    const hostConfig = loadPhase2HostConfig({
      repoRoot,
      constraintsPath: config.phase2.constraintsPath ?? 'configs/phase2/host-constraints.json',
      smokeProtocolPath: config.phase2.smokeProtocolPath ?? 'configs/phase2/protocol-smoke.json',
      tinyProtocolPath: config.phase2.tinyProtocolPath ?? 'configs/phase2/protocol-tiny.json',
    });

    // Cordis requires an explicit provide before a context property assignment
    // (the workbench host half documents the same runtime rule), so the service
    // is registered with ctx.provide AND assigned to the context property: the
    // assignment keeps the property read working on plain-object stubs (the
    // wiring tests), while provide() satisfies the real context's set guard.
    const experimentService = applyExperimentTools(ctx, {
      repoRoot,
      storageRoot: config.phase2.storageRoot ?? path.join(repoRoot, 'artifacts/research-execution'),
      ...(config.phase2.workRoot ? { workRoot: config.phase2.workRoot } : {}),
      ...(config.phase2.sourceCheckout ? { sourceCheckout: config.phase2.sourceCheckout } : {}),
      ...(config.phase2.pythonPath ? { pythonPath: config.phase2.pythonPath } : {}),
      ...(config.phase2.runTimeoutMs !== undefined ? { runTimeoutMs: config.phase2.runTimeoutMs } : {}),
      constraints: hostConfig.constraints,
      protocols: hostConfig.protocols,
    });
    ctx.provide('evolverExperiments', experimentService);
    ctx.evolverExperiments = experimentService;
  }

  // Phase 3 (real experiments + workbench data) is its OWN opt-in, exactly as
  // `research` and `phase2` are. Real training processes; registered only
  // where the host configuration asks for it.
  if (config.phase3) {
    applyPhase3Tools(ctx, {
      repoRoot: config.phase3.repoRoot,
      storageRoot: config.phase3.storageRoot,
      pilotConfigPath: config.phase3.pilotConfigPath,
      comparisonProtocolPath: config.phase3.comparisonProtocolPath,
      ...(config.phase3.phase2 ? { phase2: config.phase3.phase2 } : {}),
    });
  }

  // The research workbench submission tools are a SEPARATE opt-in again. They
  // write the workbench sidecar only: they cannot create a research candidate,
  // run a check, or produce a metric. Registering them unconditionally would put
  // a write path in every session that merely wants to read.
  if (config.workbenchResearch) {
    applyWorkbenchTools(ctx, {
      ...config.workbenchResearch,
      repoRoot: config.workbenchResearch.repoRoot ?? config.phase3?.repoRoot,
    });
  }

  // K-min is a separate opt-in. It has a fixed host-pinned source root/library
  // and does not register a model, network fetch, or training path.
  if (config.knowledge) {
    const knowledge = applyKnowledgeTools(ctx, config.knowledge);
    ctx.provide('evolverKnowledge');
    ctx.evolverKnowledge = knowledge;
  }
}
