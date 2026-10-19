/**
 * DSH tool adapter for the research bootstrap graph tools (BE-02).
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-SHARED-SPEC-2026-10-10.md §6,
 * docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-02-GRAPH-SPEC-2026-10-10.md §6.
 *
 * Registers exactly the shared-contract tool names owned by BE-02:
 * - `evolver_get_research_bootstrap`   (read-only workspace state)
 * - `evolver_initialize_research_graph`
 * - `evolver_map_slot_candidates`
 * - `evolver_set_slot_component`
 *
 * Every call resolves the workspace from the INVOKING AGENT's registration
 * (`workspaceRegistry`), never from a payload field; a payload that names its own owner,
 * workspace root or actor is refused before anything runs. All persistence is delegated to the
 * one BE-02 store per workspace; this adapter holds no state of its own.
 *
 * Mounting is BE-03's job (final wiring); this module only exports the apply function.
 */

import * as path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import {
  BootstrapError,
  type BootstrapSourceResolver,
  type SlotBindingRef,
} from '../../contracts/research-bootstrap.ts';
import { PaperLibrary } from '../../application/paper-library.ts';
import { ResearchBootstrapStore } from '../../application/research-bootstrap-store.ts';
import {
  ResearchBootstrapGraphService,
  type CandidateDraftInput,
  type SlotDraftInput,
} from '../../application/research-bootstrap-graph-service.ts';

export const RESEARCH_BOOTSTRAP_GRAPH_TOOL_NAMES = Object.freeze([
  'evolver_get_research_bootstrap',
  'evolver_initialize_research_graph',
  'evolver_map_slot_candidates',
  'evolver_set_slot_component',
]);

/** Field names a request may never carry: identity/path facts come from trusted context only. */
export const BOOTSTRAP_FORBIDDEN_PAYLOAD_FIELDS: readonly string[] = Object.freeze([
  'actor', 'owner', 'ownerSessionId', 'sessionId', 'agentId', 'userId', 'caller',
  'workspaceRoot', 'workspace', 'root', 'cwd', 'path',
]);

export function assertNoForbiddenFields(payload: unknown, context: string): void {
  if (typeof payload !== 'object' || payload === null) return;
  for (const key of Object.keys(payload as Record<string, unknown>)) {
    if (BOOTSTRAP_FORBIDDEN_PAYLOAD_FIELDS.includes(key)) {
      throw new BootstrapError('OWNER_MISMATCH',
        `${context}.${key} is not accepted: the workspace and owner are bound from the invoking Agent's registration, never from a request`);
    }
  }
}

interface RegistryWorkspace { id: string; path: string; title: string; sessionIds: readonly string[] }
type WorkspaceRegistry = { list(): RegistryWorkspace[] };

/** Resolves workspace from the invoking Agent; missing registration is a hard error, not a guess. */
export function workspaceForSession(registry: WorkspaceRegistry, sessionId: string): RegistryWorkspace {
  const workspace = registry.list().find((entry) => entry.sessionIds.includes(sessionId));
  if (workspace === undefined) {
    throw new BootstrapError('OWNER_MISMATCH', 'the calling session is not registered to a DSH workspace; research bootstrap state cannot be located');
  }
  return workspace;
}

/**
 * Evidence resolver over the workspace paper library (same layout the paper-library host uses,
 * `<workspace>/.dsh/research/papers`). Read-only: this resolver never imports, publishes or
 * rewrites a paper; a missing or unreadable paper simply reports `null`.
 */
export function paperLibraryResolver(workspacePath: string): BootstrapSourceResolver {
  const library = new PaperLibrary(path.join(workspacePath, '.dsh', 'research', 'papers'), workspacePath);
  return {
    getPaper(paperId) {
      try {
        const paper = library.get(workspacePath, paperId);
        return {
          paperId: paper.id,
          sourceSha256: paper.sha256,
          revision: paper.revision,
          title: paper.title,
          sections: paper.sections,
          components: paper.components,
        };
      } catch {
        return null;
      }
    },
  };
}

export interface ResearchBootstrapGraphToolConfig {
  /** Test/host override; defaults to the real DSH workspaceRegistry service. */
  workspaceRegistry?: WorkspaceRegistry;
  /** Test/host override for the evidence resolver (defaults to the workspace paper library). */
  resolverFactory?: (workspacePath: string) => BootstrapSourceResolver;
  /** Test/host override for the store factory (defaults to <workspace>/.dsh/research/bootstrap). */
  storeFactory?: (workspacePath: string) => ResearchBootstrapStore;
}

/** What BE-03 receives: a per-session service accessor for trusted native-action writes. */
export interface ResearchBootstrapGraphToolHandle {
  serviceForSession(sessionId: string): ResearchBootstrapGraphService;
}

export function applyResearchBootstrapGraphTools(ctx: Context, config: ResearchBootstrapGraphToolConfig = {}): ResearchBootstrapGraphToolHandle {
  const registry = config.workspaceRegistry ?? (ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined);
  if (registry === undefined || typeof registry?.list !== 'function') {
    throw new Error('Research bootstrap tools require the DSH workspaceRegistry service (or an explicit config override)');
  }
  const resolverFactory = config.resolverFactory ?? paperLibraryResolver;
  const storeFactory = config.storeFactory ?? ((workspacePath: string) => new ResearchBootstrapStore(workspacePath));
  const scope = (exec: ToolRunContext): { workspace: RegistryWorkspace; service: ResearchBootstrapGraphService } => {
    const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
    const sessionId = agent?.id ?? agent?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new BootstrapError('OWNER_MISMATCH', 'the invoking Agent carries no session id; refusing to guess the workspace owner');
    }
    const workspace = workspaceForSession(registry, sessionId);
    const store = storeFactory(workspace.path);
    return { workspace, service: new ResearchBootstrapGraphService(store, { resolver: resolverFactory(workspace.path) }) };
  };
  const jsonOutput = { schema: { type: 'object' as const, additionalProperties: true }, render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };

  ctx.tools.register(defineTool({
    name: 'evolver_get_research_bootstrap',
    description:
      'Read this workspace’s research bootstrap state (researches, contracts, environment observations, brainstorm runs, ideas, graphs, slots, snapshots). ' +
      'Read-only and free. Optional researchId scopes the result to one research; omit it for the whole workspace. ' +
      'Always re-read after any write or conflict: the returned revision is what your next baseRevision must be. ' +
      'Does not accept owner/workspaceRoot/paths; the workspace comes from your session registration.',
    parameters: { researchId: { type: 'string', description: 'Optional research id; omit for all researches in this workspace' } },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'get_research_bootstrap');
      const input = args as { researchId?: string };
      const { workspace, service } = scope(exec);
      const projection = service.getBootstrap(input.researchId ?? null);
      return { workspace: { id: workspace.id, title: workspace.title }, ...projection };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_initialize_research_graph',
    description:
      'Initialize or merge the research planning DAG for one research: goal → protocol → baseline → selected hypotheses, plus universal draft slots (Problem/Baseline/Variable/Procedure/Measurement/Evaluation/Constraints) and optional domain slot drafts. ' +
      'selectedIdeaIds must be a subset of the user’s recorded selection (native action); unselected ideas are refused. Domain slot drafts require a named baseline with current source evidence or a user-selected baseline; reproduction may remain unknown. ' +
      'The same semantic inputs reuse the existing graph unchanged (initSignature); changed inputs merge and preserve user-confirmed nodes, locked slots and snapshots. ' +
      'Use a fresh stable operationId per init attempt and retry the SAME id after REVISION_CONFLICT. Creates planning structure only — never experiments, configs or results.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research to initialize' },
      contractRevision: { type: 'number', required: true, description: 'Contract revision this init is based on (from evolver_get_research_bootstrap)' },
      baseRevision: { type: 'number', required: true, description: 'State revision this operation is based on; retry with the same operationId after re-reading on conflict' },
      operationId: { type: 'string', required: true, description: 'Stable operation id; identical operation+payload replays, different payload is refused' },
      selectedIdeaIds: { type: 'array', items: { type: 'string' }, description: 'Optional subset of the user’s recorded selection; omit to use all selected ideas' },
      slotDrafts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Domain slot drafts: { name, basis, role?, inputs?, outputs?, constraints? } — basis must cite the confirmed baseline/repo/paper evidence' },
      candidateDrafts: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Candidate mapping drafts: { slotName, ref, assessment, reason, evidenceRefs?, missingInterface? } — recommendations only, they never change bindings' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'initialize_research_graph');
      const input = args as {
        researchId: string; contractRevision: number; baseRevision: number; operationId: string;
        selectedIdeaIds?: string[]; slotDrafts?: unknown[]; candidateDrafts?: unknown[];
      };
      const { workspace, service } = scope(exec);
      const result = service.initializeGraph({
        researchId: input.researchId,
        baseRevision: input.baseRevision,
        operationId: input.operationId,
        contractRevision: input.contractRevision,
        selectedIdeaIds: input.selectedIdeaIds,
        slotDrafts: (input.slotDrafts ?? []) as SlotDraftInput[],
        candidateDrafts: (input.candidateDrafts ?? []) as CandidateDraftInput[],
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result.result, revision: result.revision, replayed: result.replayed, reused: result.result.reused };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_map_slot_candidates',
    description:
      'Replace the RECOMMENDED candidates for one slot of one node: { ref, assessment: proposed|needs_review|incompatible, reason, evidenceRefs, missingInterface? }. ' +
      'Recommendations never change the current binding and never touch locked slots. Every ref is resolved against the live paper library/ideas right now; stale or missing refs are reported per item while valid ones are saved. ' +
      'Semantic similarity is only a recommendation reason — it never makes a candidate integrable. baseRevision/operationId follow the shared CAS rules.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      nodeId: { type: 'string', required: true, description: 'Node whose slot is being mapped' },
      slotId: { type: 'string', required: true, description: 'Slot to (re)map' },
      baseRevision: { type: 'number', required: true, description: 'State revision this operation is based on' },
      operationId: { type: 'string', required: true, description: 'Stable operation id' },
      candidates: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Candidate list; each { slotName, ref, assessment, reason, evidenceRefs?, missingInterface? } — slotName must match the slot’s name' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'map_slot_candidates');
      const input = args as {
        researchId: string; nodeId: string; slotId: string; baseRevision: number; operationId: string;
        candidates: CandidateDraftInput[];
      };
      const { workspace, service } = scope(exec);
      const result = service.mapSlotCandidates({
        researchId: input.researchId, nodeId: input.nodeId, slotId: input.slotId,
        baseRevision: input.baseRevision, operationId: input.operationId,
        candidates: input.candidates ?? [],
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_set_slot_component',
    description:
      'Bind one concrete component/design idea to one slot of one node. Creates a NEW snapshot on that node only (siblings and frozen child snapshots never move); the delta records from→to. ' +
      'Refuses locked slots (SLOT_LOCKED — unlocking is a user native action, not a tool call), explicitly incompatible candidates (INCOMPATIBLE_BINDING) and refs that do not resolve (SOURCE_MISSING/SOURCE_STALE). ' +
      'Binding a design idea keeps its design source category; nothing is installed, executed or written back to the paper library.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      nodeId: { type: 'string', required: true, description: 'Node whose scheme snapshot gains the binding' },
      slotId: { type: 'string', required: true, description: 'Slot to bind' },
      ref: { type: 'object', additionalProperties: true, required: true, description: 'SlotBindingRef: { kind: "paper_component", paperId, sourceSha256, assetRevision, componentIndex, contentHash, name, componentKind } or { kind: "design_idea", ideaId, contentRevision, contentHash, title }' },
      baseRevision: { type: 'number', required: true, description: 'State revision this operation is based on' },
      operationId: { type: 'string', required: true, description: 'Stable operation id' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'set_slot_component');
      const input = args as {
        researchId: string; nodeId: string; slotId: string; ref: SlotBindingRef; baseRevision: number; operationId: string;
      };
      const { workspace, service } = scope(exec);
      const result = service.setSlotComponent({
        researchId: input.researchId, nodeId: input.nodeId, slotId: input.slotId, ref: input.ref,
        baseRevision: input.baseRevision, operationId: input.operationId,
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  // BE-03 reuses this accessor for trusted native-action writes (selection, locks, active
  // research): the service still resolves the workspace from the real session id.
  return {
    serviceForSession(sessionId: string): ResearchBootstrapGraphService {
      const workspace = workspaceForSession(registry, sessionId);
      return new ResearchBootstrapGraphService(storeFactory(workspace.path), { resolver: resolverFactory(workspace.path) });
    },
  };
}
