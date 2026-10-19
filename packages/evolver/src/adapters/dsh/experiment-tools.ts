/**
 * DSH tool registration for the Phase 2 experiment chain.
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md section 3 ("应用接口与 DSH 入口").
 *
 * The six tools registered here are EXACTLY the six names in the frozen `PHASE2_METHODS` table
 * (`contracts/experiments.ts`), and the list is derived from that table rather than typed out again,
 * so a rename in the contract cannot leave a stale tool behind.
 *
 * The owner is taken from the DSH context, exactly as `adapters/dsh/index.ts` does it:
 * `exec.agent.id ?? exec.agent.sessionId`. There is deliberately no payload fallback and no
 * `ctx.currentSessionId` fallback — the latter does not exist on this host and an undeclared context
 * read throws, which would abort every tool call. A payload that carries its own owner field is
 * refused outright (`assertNoOwnerInPayload`) rather than ignored, so a caller cannot even try.
 *
 * Nothing here re-implements a rule the service already owns: each tool is a thin, owner-resolving
 * adapter over one service method, and every refusal comes from the service as an `ExperimentError`
 * with its frozen code.
 */

import { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import {
  ExperimentError,
  PHASE2_METHODS,
  type ArtifactRef,
  type PatchProvider,
  type ProposalLink,
} from '../../contracts/experiments.ts';
import {
  ExperimentService,
  type ExperimentCallerActor,
  type ExperimentServiceOptions,
} from '../../application/experiment-service.ts';
import { resolveRepoPath } from './repo-root.ts';

export interface ExperimentToolConfig extends Omit<ExperimentServiceOptions, 'repoRoot'> {
  repoRoot?: string;
  /**
   * A pre-built service. Supplying one lets a caller share the service (and its storage root) with a
   * host-side driver instead of letting this module construct a second one.
   */
  service?: ExperimentService;
}

/** Field names a payload may never carry: the owner comes from the DSH context, never from a request. */
export const PAYLOAD_OWNER_FIELDS: readonly string[] = Object.freeze([
  'actor',
  'owner',
  'ownerSessionId',
  'sessionId',
  'agentId',
  'userId',
  'caller',
]);

/**
 * Refuses a payload that tries to name its own owner. The service would reject the unknown field
 * anyway; failing here makes the rule explicit and gives it the right error code.
 */
export function assertNoOwnerInPayload(payload: unknown, context = 'payload'): void {
  if (typeof payload !== 'object' || payload === null) return;
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (PAYLOAD_OWNER_FIELDS.includes(key)) {
      throw new ExperimentError(
        'OWNER_MISMATCH',
        `${context}.${key} is not accepted: the owner is bound from the invoking Agent's context, never from a request`,
        { fieldPaths: [`${context}.${key}`] }
      );
    }
  }
}

function resolveActor(_ctx: Context, exec: ToolRunContext): ExperimentCallerActor {
  // The owning Session id comes from the invoking Agent. See adapters/dsh/index.ts for why there is
  // no context-property fallback: no DSH service of that name exists, and reading an undeclared
  // context property throws.
  const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
  const sessionId = agent?.id ?? agent?.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new ExperimentError('OWNER_MISMATCH', 'Caller context must provide a non-empty session owner');
  }
  return { sessionId: sessionId.trim(), ...(agent?.id ? { agentId: agent.id } : {}) };
}

const objectSchema = { type: 'object', additionalProperties: true } as const;

const RECEIPT_PROPERTIES = {
  receipt: objectSchema,
  operation: objectSchema,
  result: objectSchema,
} as const;

const SUMMARY_TAIL = (label: string) => (_args: unknown, value: unknown) => [
  { type: 'text' as const, text: `${label}: ${JSON.stringify(value, null, 2)}` },
];

/**
 * Registers the six Phase 2 tools. Returns the service so a caller can read operations, submit a
 * human patch, or stop an operation through the same storage root.
 */
export function applyExperimentTools(ctx: Context, config: ExperimentToolConfig): ExperimentService {
  const service =
    config.service ??
    new ExperimentService({
      ...config,
      repoRoot: resolveRepoPath(config.repoRoot ?? '.'),
    });

  const tools = new Map<string, () => void>();
  const register = (tool: string, build: () => void): void => {
    tools.set(tool, build);
  };

  // The six registrations are keyed by the FROZEN tool names, so a contract change that renames a
  // tool fails loudly here instead of leaving a silently missing registration.
  const [resolveSourcesTool, planAdaptationTool, adaptImplementationTool, validateTool, runTool, registerTool] =
    PHASE2_METHODS.map((m) => m.tool);
  if (PHASE2_METHODS.length !== 6) {
    throw new ExperimentError('SCHEMA_VIOLATION', `PHASE2_METHODS must declare exactly six write methods, got ${PHASE2_METHODS.length}`);
  }

  register(resolveSourcesTool, () => {
    ctx.tools.register(
      defineTool({
        name: resolveSourcesTool,
        description:
          'Phase 2 step 1 resolveSources: fix a proposal and the host-registered source manifest into a validated SourceBundle. The owner comes from the invoking Agent, never from the payload. No runner is started.',
        parameters: {
          commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
          taskId: { type: 'string', required: true, description: 'Task id the operation is bound to' },
          expectedRevision: { type: 'number', required: true, description: 'Revision CAS precondition' },
          policyRef: objectSchema,
          budgetRef: objectSchema,
          proposal: { type: 'object', required: true, additionalProperties: true, description: 'ProposalLink (research or manual)' },
          sourceManifestRef: { type: 'object', required: true, additionalProperties: true, description: 'Host-registered source manifest reference' },
          profileRef: { type: 'string', required: true, description: 'Task profile id' },
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: RECEIPT_PROPERTIES }, render: SUMMARY_TAIL('SourceBundle') },
        execute: async (args: unknown, exec: ToolRunContext) => {
          const actor = resolveActor(ctx, exec);
          assertNoOwnerInPayload(args, 'resolveSources');
          return service.resolveSources(args as Parameters<ExperimentService['resolveSources']>[0], actor);
        },
      })
    );
  });

  register(planAdaptationTool, () => {
    ctx.tools.register(
      defineTool({
        name: planAdaptationTool,
        description:
          'Phase 2 step 2 planAdaptation: build an AdaptationPlan from the pinned SourceBundle and the HOST constraints named by constraintsRef. An unknown binding is refused with its code; a P6 interventionAxis label is provenance only.',
        parameters: {
          commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
          taskId: { type: 'string', required: true, description: 'Task id' },
          expectedRevision: { type: 'number', required: true, description: 'Revision CAS precondition' },
          policyRef: objectSchema,
          budgetRef: objectSchema,
          sourceBundleRef: { type: 'object', required: true, additionalProperties: true, description: 'Published SourceBundle reference' },
          profileRef: { type: 'string', required: true, description: 'Task profile id' },
          constraintsRef: { type: 'object', required: true, additionalProperties: true, description: 'Host-owned planning constraints reference' },
          patchProvider: { type: 'string', required: true, description: "'human' or 'agent'" },
          interventionAxis: { type: 'string', description: 'Provenance only; never selects a slot or a position' },
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: RECEIPT_PROPERTIES }, render: SUMMARY_TAIL('AdaptationPlan') },
        execute: async (args: unknown, exec: ToolRunContext) => {
          const actor = resolveActor(ctx, exec);
          assertNoOwnerInPayload(args, 'planAdaptation');
          const a = args as Parameters<ExperimentService['planAdaptation']>[0];
          return service.planAdaptation({ ...a, patchProvider: a.patchProvider as PatchProvider }, actor);
        },
      })
    );
  });

  register(adaptImplementationTool, () => {
    ctx.tools.register(
      defineTool({
        name: adaptImplementationTool,
        description:
          'Phase 2 step 3 adaptImplementation: apply a bounded patch to a throwaway copy of the pinned source and publish an ImplementationSnapshot. A human plan requires a submitted patch; an agent patch is generated inside the plan workspace only.',
        parameters: {
          commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
          taskId: { type: 'string', required: true, description: 'Task id' },
          expectedRevision: { type: 'number', required: true, description: 'Revision CAS precondition' },
          policyRef: objectSchema,
          budgetRef: objectSchema,
          planRef: { type: 'object', required: true, additionalProperties: true, description: 'Published AdaptationPlan reference' },
          submittedPatchRef: { type: 'object', additionalProperties: true, description: 'Required when the plan declares patchProvider human' },
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: RECEIPT_PROPERTIES }, render: SUMMARY_TAIL('ImplementationSnapshot') },
        execute: async (args: unknown, exec: ToolRunContext) => {
          const actor = resolveActor(ctx, exec);
          assertNoOwnerInPayload(args, 'adaptImplementation');
          return service.adaptImplementation(args as Parameters<ExperimentService['adaptImplementation']>[0], actor);
        },
      })
    );
  });

  register(validateTool, () => {
    ctx.tools.register(
      defineTool({
        name: validateTool,
        description:
          'Phase 2 step 4 validateImplementation: run the real mechanism probe over the adapted implementation and publish a CheckReport. A required failure is published as a failed report; it never reaches smoke.',
        parameters: {
          commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
          taskId: { type: 'string', required: true, description: 'Task id' },
          expectedRevision: { type: 'number', required: true, description: 'Revision CAS precondition' },
          policyRef: objectSchema,
          budgetRef: objectSchema,
          implementationRef: { type: 'object', required: true, additionalProperties: true, description: 'Published ImplementationSnapshot reference' },
          profileRef: { type: 'string', required: true, description: 'Task profile id' },
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: RECEIPT_PROPERTIES }, render: SUMMARY_TAIL('CheckReport') },
        execute: async (args: unknown, exec: ToolRunContext) => {
          const actor = resolveActor(ctx, exec);
          assertNoOwnerInPayload(args, 'validateImplementation');
          return service.validateImplementation(args as Parameters<ExperimentService['validateImplementation']>[0], actor);
        },
      })
    );
  });

  register(runTool, () => {
    ctx.tools.register(
      defineTool({
        name: runTool,
        description:
          "Phase 2 steps 5 and 7 runLightweight: run the smoke or tiny protocol with the profile's registered compile/prepare/verify functions and publish a LightweightResult. Smoke requires a passing validation report for the same implementation; tiny requires a registered executable.",
        parameters: {
          commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
          taskId: { type: 'string', required: true, description: 'Task id' },
          expectedRevision: { type: 'number', required: true, description: 'Revision CAS precondition' },
          policyRef: objectSchema,
          budgetRef: objectSchema,
          mode: { type: 'string', required: true, description: "'smoke' or 'tiny'" },
          subjectRef: { type: 'object', required: true, additionalProperties: true, description: 'smoke: the implementation; tiny: the registered executable' },
          runProtocolRef: { type: 'object', required: true, additionalProperties: true, description: 'Host-registered run protocol reference' },
          validationRef: { type: 'object', additionalProperties: true, description: 'Required for smoke' },
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: RECEIPT_PROPERTIES }, render: SUMMARY_TAIL('LightweightResult') },
        execute: async (args: unknown, exec: ToolRunContext) => {
          const actor = resolveActor(ctx, exec);
          assertNoOwnerInPayload(args, 'runLightweight');
          return service.runLightweight(args as Parameters<ExperimentService['runLightweight']>[0], actor);
        },
      })
    );
  });

  register(registerTool, () => {
    ctx.tools.register(
      defineTool({
        name: registerTool,
        description:
          'Phase 2 step 6 registerImplementation: register an ExecutableSnapshot with readiness ready. Readiness is never taken from the request: the reference closure, the smoke conclusion and the required-check status are re-checked from the published artifacts.',
        parameters: {
          commandId: { type: 'string', required: true, description: 'Idempotency key within the owning session' },
          taskId: { type: 'string', required: true, description: 'Task id' },
          expectedRevision: { type: 'number', required: true, description: 'Revision CAS precondition' },
          policyRef: objectSchema,
          budgetRef: objectSchema,
          implementationRef: { type: 'object', required: true, additionalProperties: true, description: 'Published ImplementationSnapshot reference' },
          validationRef: { type: 'object', required: true, additionalProperties: true, description: 'Published CheckReport reference' },
          smokeRef: { type: 'object', required: true, additionalProperties: true, description: 'Published smoke LightweightResult reference' },
        },
        output: { schema: { type: 'object', additionalProperties: true, properties: RECEIPT_PROPERTIES }, render: SUMMARY_TAIL('ExecutableSnapshot') },
        execute: async (args: unknown, exec: ToolRunContext) => {
          const actor = resolveActor(ctx, exec);
          assertNoOwnerInPayload(args, 'registerImplementation');
          return service.registerImplementation(args as Parameters<ExperimentService['registerImplementation']>[0], actor);
        },
      })
    );
  });

  // Every frozen method must have produced a registration. A missing one would mean the DSH surface
  // and the contract had drifted, which is exactly what the gate's parity assertion exists to catch.
  const missing = PHASE2_METHODS.filter((m) => !tools.has(m.tool)).map((m) => m.tool);
  if (missing.length > 0) {
    throw new ExperimentError('SCHEMA_VIOLATION', `no registration was produced for: ${missing.join(', ')}`);
  }
  for (const build of tools.values()) build();

  // Reading and stopping are host-side helpers, NOT part of the six write methods. They are
  // registered separately and are named so they cannot be mistaken for the contract's tools.
  ctx.tools.register(
    defineTool({
      name: 'evolver_get_execution_operation',
      description:
        'Read a Phase 2 execution operation descriptor. Reading consumes no budget and is owner-checked. This is a host helper, not one of the six PHASE2_METHODS.',
      parameters: { operationId: { type: 'string', required: true, description: 'Execution operation id' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: SUMMARY_TAIL('ExecutionOperation') },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        assertNoOwnerInPayload(args, 'getExecutionOperation');
        return service.getExecutionOperation((args as { operationId: string }).operationId, actor);
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'evolver_stop_execution_operation',
      description:
        'Idempotently stop a Phase 2 execution operation. Stopping is never gated by the remaining budget. This is a host helper, not one of the six PHASE2_METHODS.',
      parameters: {
        operationId: { type: 'string', required: true, description: 'Execution operation id' },
        commandId: { type: 'string', required: true, description: 'Stop command id, in its own namespace' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: SUMMARY_TAIL('ExecutionOperation') },
      execute: async (args: unknown, exec: ToolRunContext) => {
        const actor = resolveActor(ctx, exec);
        assertNoOwnerInPayload(args, 'stopExecutionOperation');
        const a = args as { operationId: string; commandId: string };
        return service.stopExecutionOperation(a.operationId, a.commandId, actor);
      },
    })
  );

  return service;
}

/** The six frozen tool names, in `PHASE2_METHODS` order. Exported for parity checks. */
export const EXPERIMENT_TOOL_NAMES: readonly string[] = PHASE2_METHODS.map((m) => m.tool);

export type { ArtifactRef, ProposalLink };
