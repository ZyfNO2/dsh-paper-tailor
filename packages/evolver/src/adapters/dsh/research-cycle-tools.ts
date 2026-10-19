/**
 * DSH tool adapter for the Phase2 research cycle (architecture §5: Agent tools).
 *
 * Registers exactly the member-facing capabilities the architecture allows:
 * - `evolver_get_research_cycle`        (read-only run/graph/artifact projection)
 * - `evolver_read_cycle_input`          (read one ASSIGNED step input)
 * - `evolver_publish_cycle_artifact`    (publish this step's deliverable)
 * - `evolver_submit_cycle_step_result`  (submit outputs, complete the step)
 *
 * Deliberately NOT exposed to agents: applying decisions, cancelling runs,
 * retrying steps, writing run state or any raw path access — those stay with
 * the user actions (host bridge) and the coordinator. Every call resolves the
 * workspace from the INVOKING AGENT's registration; payload fields naming an
 * owner/workspace/path are refused (assertNoForbiddenFields from the bootstrap
 * boundary is reused for the same vocabulary).
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ArtifactRef } from '../../contracts/experiments.ts';
import {
  CycleError,
  validateCycleActor,
  type CycleArtifactKind,
  type CycleRole,
  type CycleStepExecution,
  type CycleStepInputSnapshot,
} from '../../contracts/research-cycle.ts';
import type { BootstrapSourceResolver } from '../../contracts/research-bootstrap.ts';
import { ResearchBootstrapStore } from '../../application/research-bootstrap-store.ts';
import { ResearchCycleService } from '../../application/research-cycle-service.ts';
import { assertNoForbiddenFields, workspaceForSession } from './research-bootstrap-graph-tools.ts';
import { paperLibraryResolver } from './research-bootstrap-graph-tools.ts';

interface RegistryWorkspace { id: string; path: string; title: string; sessionIds: readonly string[] }
type WorkspaceRegistry = { list(): RegistryWorkspace[] };

export interface ResearchCycleToolConfig {
  /** Test/host override; defaults to the real DSH workspaceRegistry service. */
  workspaceRegistry?: WorkspaceRegistry;
  storeFactory?: (workspacePath: string) => ResearchBootstrapStore;
  resolverFactory?: (workspacePath: string) => BootstrapSourceResolver;
  now?: () => Date;
}

export const RESEARCH_CYCLE_TOOL_NAMES = Object.freeze([
  'evolver_get_research_cycle',
  'evolver_read_cycle_input',
  'evolver_publish_cycle_artifact',
  'evolver_submit_cycle_step_result',
]);

function isCycleError(error: unknown): error is CycleError {
  return error instanceof CycleError;
}

export function applyResearchCycleTools(ctx: Context, config: ResearchCycleConfig = {}): void {
  const registry = config.workspaceRegistry ?? (ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined);
  if (registry === undefined || typeof registry?.list !== 'function') {
    throw new Error('Research cycle tools require the DSH workspaceRegistry service (or an explicit config override)');
  }
  const storeFactory = config.storeFactory ?? ((workspacePath: string) => new ResearchBootstrapStore(workspacePath));
  const resolverFactory = config.resolverFactory ?? paperLibraryResolver;

  const serviceFor = (exec: ToolRunContext): { service: ResearchCycleService; workspace: RegistryWorkspace } => {
    const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
    const sessionId = agent?.id ?? agent?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new CycleError('OWNER_MISMATCH', 'the invoking Agent carries no session id; refusing to guess the workspace owner');
    }
    const workspace = workspaceForSession(registry, sessionId);
    const service = new ResearchCycleService({
      workspaceRoot: workspace.path,
      bootstrapStore: storeFactory(workspace.path),
      resolver: resolverFactory(workspace.path),
      ...(config.now !== undefined ? { now: config.now } : {}),
    });
    return { service, workspace };
  };

  const actorFor = (exec: ToolRunContext) => {
    const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
    const sessionId = agent?.id ?? agent?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new CycleError('OWNER_MISMATCH', 'the invoking Agent carries no session id');
    }
    return { identity: sessionId, kind: 'agent' as const, actionId: null };
  };

  const jsonOutput = { schema: { type: 'object' as const, additionalProperties: true }, render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };

  ctx.tools.register(defineTool({
    name: 'evolver_get_research_cycle',
    description:
      'Read the Phase2 research cycle state of one research: runs, steps (with blocking reasons), registered artifacts, the effective DAG (Phase1 base graph + accepted cycle increments) and the latest applied decision\'s nextActions. ' +
      'Read-only. Optional runId scopes to one run. The workspace comes from your session registration.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      runId: { type: 'string', description: 'Optional run id; omit for the active/latest run' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'get_research_cycle');
      const input = args as { researchId: string; runId?: string };
      const { service, workspace } = serviceFor(exec);
      try {
        const view = service.getResearchCycleView(validateCycleActor(actorFor(exec)), { researchId: input.researchId, ...(input.runId !== undefined ? { runId: input.runId } : {}) });
        return { workspace: { id: workspace.id, title: workspace.title }, ...view };
      } catch (error) {
        if (isCycleError(error)) return { error: error.code, message: error.message };
        throw error;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_read_cycle_input',
    description:
      'Read ONE input assigned to your step: the step input snapshot (research summary, selected idea, role instruction), a published artifact from a previous step, or a paper-evidence ref with its live assessment. ' +
      'You may only read inputs listed in your step assignment; everything else is POLICY_DENIED.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      runId: { type: 'string', required: true, description: 'Run id' },
      stepId: { type: 'string', required: true, description: 'Your assigned step id' },
      inputRef: { type: 'object', additionalProperties: true, required: true, description: 'CycleInputRef: { kind: "artifact", ref: { id, sha256 } } or { kind: "paper_evidence", ref: EvidenceRef }' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'read_cycle_input');
      const input = args as { researchId: string; runId: string; stepId: string; inputRef: unknown };
      const { service } = serviceFor(exec);
      try {
        return service.readCycleInput(actorFor(exec), input);
      } catch (error) {
        if (isCycleError(error)) return { error: error.code, message: error.message };
        throw error;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_publish_cycle_artifact',
    description:
      'Publish THIS step\'s deliverable. The kind is bound to your role (hypothesis→proposal, planner→experiment_plan, evidence→evidence_report, reviewer→decision) and the payload is validated against the shared cycle contracts before anything is stored. ' +
      'Published content is immutable; revising means publishing again (new content hash) before you submit. attemptId must be your step\'s current attempt.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      runId: { type: 'string', required: true, description: 'Run id' },
      stepId: { type: 'string', required: true, description: 'Your assigned step id' },
      attemptId: { type: 'string', required: true, description: 'Current attempt id of your step' },
      kind: { type: 'string', required: true, description: 'Deliverable kind bound to your role' },
      payload: { type: 'object', additionalProperties: true, required: true, description: 'The deliverable payload (contract-validated)' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'publish_cycle_artifact');
      const input = args as { researchId: string; runId: string; stepId: string; attemptId: string; kind: CycleArtifactKind; payload: Record<string, unknown> };
      const { service } = serviceFor(exec);
      try {
        const ref = service.publishCycleArtifact(actorFor(exec), input.researchId, {
          runId: input.runId, stepId: input.stepId, attemptId: input.attemptId, kind: input.kind, payload: input.payload,
        });
        return { published: true, ref };
      } catch (error) {
        if (isCycleError(error)) return { error: error.code, message: error.message };
        throw error;
      }
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_submit_cycle_step_result',
    description:
      'Submit your step\'s output refs and complete the step. Exactly one registered deliverable of your role\'s kind must exist for this attempt; completing unlocks dependent steps. ' +
      'Use a fresh stable commandId per submission and retry the SAME id with the same content after a revision conflict (re-read first).',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      commandId: { type: 'string', required: true, description: 'Stable command id for this submission' },
      runId: { type: 'string', required: true, description: 'Run id' },
      stepId: { type: 'string', required: true, description: 'Your assigned step id' },
      attemptId: { type: 'string', required: true, description: 'Current attempt id of your step' },
      outputRefs: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Your published ArtifactRef list (normally exactly one)' },
      expectedCycleRevision: { type: 'number', required: true, description: 'Cycle state revision you based this submission on (from evolver_get_research_cycle)' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'submit_cycle_step_result');
      const input = args as { researchId: string; commandId: string; runId: string; stepId: string; attemptId: string; outputRefs: ArtifactRef[]; expectedCycleRevision: number };
      const { service } = serviceFor(exec);
      try {
        return service.submitStepResult(actorFor(exec), input.researchId, {
          commandId: input.commandId, runId: input.runId, stepId: input.stepId, attemptId: input.attemptId,
          outputRefs: input.outputRefs, expectedCycleRevision: input.expectedCycleRevision,
        });
      } catch (error) {
        if (isCycleError(error)) return { error: error.code, message: error.message };
        throw error;
      }
    },
  }));
}

/** Re-exported seam types so a live Team adapter can implement executors against this boundary. */
export type { CycleRole, CycleStepExecution, CycleStepInputSnapshot };

/** Host plugin config type shared with the HTTP host half. */
export interface ResearchCycleConfig extends ResearchCycleToolConfig {
  /** Executor factory for in-process coordination; omitted ⇒ the host never auto-runs cycles. */
  executorsFactory?: (workspacePath: string) => ReadonlyMap<CycleRole, import('../../application/research-cycle-roles.ts').CycleRoleExecutor>;
}
