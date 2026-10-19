/**
 * DSH tool adapter for the research bootstrap intent tools (BE-01).
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-01-INTENT-SPEC-2026-10-10.md §5,
 * shared SPEC §6.
 *
 * Registers exactly the shared-contract tool names owned by BE-01:
 * - `evolver_save_research_contract`
 * - `evolver_probe_research_environment`
 * - `evolver_publish_research_ideas`
 * - `evolver_update_research_idea`
 *
 * Trust boundary kept here:
 * - The workspace and the brainstorm agent identity come from the invoking Agent's registration
 *   — a payload that carries owner/actor/agentIdentity/workspaceRoot is refused.
 * - No tool path can confirm anything: the contract tool refuses `status: confirmed` and
 *   `baseline.status: confirmed` (the service enforces the same rule); confirmation belongs to
 *   the trusted service methods BE-03 wires to real native actions.
 * - `autonomy` is fixed to plan_only; probes are the fixed read-only set with bounded timeouts.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import * as path from 'node:path';
import { BootstrapError, componentEntryContentHash, wikiEntryContentHash, type EvidenceRef } from '../../contracts/research-bootstrap.ts';
import { PaperLibrary } from '../../application/paper-library.ts';
import { ResearchBootstrapStore } from '../../application/research-bootstrap-store.ts';
import {
  ResearchBootstrapIntentService,
  type ContractPatchInput,
  type IdeaSubmission,
} from '../../application/research-bootstrap-intent-service.ts';
import { runEnvironmentProbes } from '../../application/research-bootstrap-environment.ts';
import {
  assertNoForbiddenFields,
  paperLibraryResolver,
  workspaceForSession,
  type ResearchBootstrapGraphToolConfig,
} from './research-bootstrap-graph-tools.ts';

export const RESEARCH_BOOTSTRAP_INTENT_TOOL_NAMES = Object.freeze([
  'evolver_save_research_contract',
  'evolver_probe_research_environment',
  'evolver_list_evidence_candidates',
  'evolver_validate_research_ideas',
  'evolver_publish_research_ideas',
  'evolver_update_research_idea',
]);

interface RegistryWorkspace { id: string; path: string; title: string; sessionIds: readonly string[] }
type WorkspaceRegistry = { list(): RegistryWorkspace[] };

/**
 * The EvidenceRef shape the model must EMIT, declared where the model actually reads it.
 * `ideas[].evidenceRefs` was a bare `{type:'object'}` — nothing told the model the inner value
 * must be a full object, which is exactly how `evidenceRefs[0] must be an object` happened.
 */
function evRefSchema(): Record<string, unknown> {
  return { type: 'object', additionalProperties: false, properties: {
    paperId: { type: 'string', required: true }, sourceSha256: { type: 'string', required: true },
    assetRevision: { type: 'string' }, assetKind: { type: 'string', required: true, enum: ['source', 'wiki', 'component'] },
    entryIndex: { type: 'number' }, contentHash: { type: 'string', required: true },
    page: { type: 'number' }, quote: { type: 'string' }, locator: { type: 'string' },
    snapshot: { type: 'object', required: true, additionalProperties: true, properties: {
      label: { type: 'string', required: true }, kind: { type: 'string' }, description: { type: 'string' },
      page: { type: 'number' }, quote: { type: 'string' },
    } },
  }, description: 'copy verbatim from evolver_list_evidence_candidates; source refs have entryIndex null and contentHash == sourceSha256; wiki/component refs carry the library revision and entry index' };
}

/**
 * Build copy-ready canonical EvidenceRefs from the REAL library.
 *
 * The model cannot compute paperId / sourceSha256 / assetRevision / entryIndex / contentHash,
 * so the only sound path is to hand it objects derived from the actual stored assets — and only
 * ones that WILL resolve when published. This is read-only: it never imports, publishes or
 * rewrites a paper.
 *
 * A whole-source ref hashes its own source. A wiki/component ref is emitted only when the paper
 * really carries a revision (a null revision can never pass validateEvidenceRef), and its
 * contentHash is the hash of the entry's real stable content — never an invented label hash,
 * never a guess.
 */
function collectEvidenceCandidates(workspacePath: string, resolver: { getPaper(paperId: string): unknown }): Array<{ ref: EvidenceRef; summary: string }> {
  const library = new PaperLibrary(path.join(workspacePath, '.dsh', 'research', 'papers'), workspacePath);
  const out: Array<{ ref: EvidenceRef; summary: string }> = [];
  let papers: Array<{ id: string; sha256: string; revision: string | null; name: string; title: string;
    sections: Array<{ heading: string; summary: string; page: number; quote: string }>;
    components: Array<{ kind: string; name: string; description: string; page: number; quote: string }> }> = [];
  try { papers = library.list(workspacePath) as typeof papers; } catch { return out; }
  void resolver;
  for (const paper of papers) {
    // Whole-source ref: the paper's own bytes. Always resolvable.
    out.push({
      ref: {
        paperId: paper.id, sourceSha256: paper.sha256, assetRevision: null, assetKind: 'source', entryIndex: null,
        contentHash: paper.sha256, page: null, quote: null, locator: null,
        snapshot: { label: paper.title, kind: null, description: 'whole source', page: null, quote: null },
      },
      summary: `${paper.title} — whole source`,
    });
    if (paper.revision === null) continue;
    (paper.sections ?? []).forEach((section, index) => {
      out.push({
        ref: {
          paperId: paper.id, sourceSha256: paper.sha256, assetRevision: paper.revision, assetKind: 'wiki', entryIndex: index,
          // Same domain function the resolver assesses against — a hand-rolled hash would read as stale.
          contentHash: wikiEntryContentHash(section),
          page: section.page, quote: section.quote, locator: `${paper.name} · 第 ${section.page} 页`,
          snapshot: { label: section.heading, kind: 'wiki', description: section.summary, page: section.page, quote: section.quote },
        },
        summary: `${paper.title} — wiki section ${index + 1}: ${section.heading}`,
      });
    });
    (paper.components ?? []).forEach((component, index) => {
      out.push({
        ref: {
          paperId: paper.id, sourceSha256: paper.sha256, assetRevision: paper.revision, assetKind: 'component', entryIndex: index,
          contentHash: componentEntryContentHash(component),
          page: component.page, quote: component.quote, locator: `${paper.name} · 第 ${component.page} 页`,
          snapshot: { label: component.name, kind: 'component', description: component.description, page: component.page, quote: component.quote },
        },
        summary: `${paper.title} — component ${index + 1}: ${component.name}`,
      });
    });
  }
  return out;
}

export function applyResearchBootstrapIntentTools(ctx: Context, config: ResearchBootstrapGraphToolConfig = {}): ResearchBootstrapIntentServiceAccessor {
  const registry = config.workspaceRegistry ?? (ctx.get('workspaceRegistry') as WorkspaceRegistry | undefined);
  if (registry === undefined || typeof registry?.list !== 'function') {
    throw new Error('Research bootstrap intent tools require the DSH workspaceRegistry service (or an explicit config override)');
  }
  const resolverFactory = config.resolverFactory ?? paperLibraryResolver;
  const storeFactory = config.storeFactory ?? ((workspacePath: string) => new ResearchBootstrapStore(workspacePath));
  const scope = (exec: ToolRunContext): { workspace: RegistryWorkspace; service: ResearchBootstrapIntentService; sessionId: string } => {
    const agent = exec.agent as { id?: string; sessionId?: string } | undefined;
    const sessionId = agent?.id ?? agent?.sessionId;
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      throw new BootstrapError('OWNER_MISMATCH', 'the invoking Agent carries no session id; refusing to guess the workspace owner');
    }
    const workspace = workspaceForSession(registry, sessionId);
    const store = storeFactory(workspace.path);
    const service = new ResearchBootstrapIntentService(store, { resolver: resolverFactory(workspace.path) });
    return { workspace, service, sessionId };
  };
  const jsonOutput = { schema: { type: 'object' as const, additionalProperties: true }, render: (_: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };

  ctx.tools.register(defineTool({
    name: 'evolver_save_research_contract',
    description:
      'Create or update one research’s Research Contract draft: research question, goal sentence, proposed baseline, data/metric description, guardrails, editable/locked scope, compute/time budgets, pending questions. ' +
      'Missing information stays null/undecided — a draft with only a goal sentence is valid and brainstorming can proceed. ' +
      'You may PROPOSE a baseline (status "proposed" with name/refs) but you can never CONFIRM one, and you can never set contract status "confirmed": both require the user’s native action. ' +
      'Autonomy is fixed to plan_only; requests for more autonomy are refused. Reuse already-confirmed user information instead of re-asking. ' +
      'baseRevision/operationId follow the shared CAS rules; retry the SAME operationId after REVISION_CONFLICT.',
    parameters: {
      researchId: { type: 'string', description: 'Existing research id; omit to create a new research' },
      baseRevision: { type: 'number', required: true, description: 'State revision this write is based on (0 for a brand-new bootstrap state)' },
      operationId: { type: 'string', required: true, description: 'Stable operation id; identical operation+payload replays, different payload is refused' },
      patch: { type: 'object', additionalProperties: true, required: true, description: 'Contract patch: { title?, researchQuestion?, goal?, baseline?: {status: undecided|proposed, name?, paperRef?, repoLocator?}, dataDescription?, metrics?, guardrails?, editableScope?, lockedScope?, computeBudget?, timeBudget?, pendingQuestions?: [{field, question}] }' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'save_research_contract');
      const input = args as {
        researchId?: string; baseRevision: number; operationId: string; patch: ContractPatchInput;
      };
      const { workspace, service, sessionId } = scope(exec);
      const result = service.saveResearchContract({
        researchId: input.researchId ?? null,
        baseRevision: input.baseRevision,
        operationId: input.operationId,
        patch: input.patch ?? {},
        origin: { kind: 'tool', identity: `agent:${sessionId}` },
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_probe_research_environment',
    description:
      'Run the fixed read-only environment probe set for the CURRENT workspace and store the real observations: host identity, Python version, NVIDIA GPUs, CUDA reachability, PyTorch support, repo/git summary. ' +
      'No shell strings, no project scripts, no dependency installation, no training; each probe is time-bounded and reports observed/unavailable/failed/not_run with its true error. ' +
      'Missing GPU/Python does NOT block brainstorming — it only marks resource-fit as pending. Machine facts never set budgets or formal datasets.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research the observations belong to' },
      baseRevision: { type: 'number', required: true, description: 'State revision this write is based on' },
      operationId: { type: 'string', required: true, description: 'Stable operation id' },
    },
    output: jsonOutput,
    execute: async (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'probe_research_environment');
      const input = args as { researchId: string; baseRevision: number; operationId: string };
      const { workspace, service } = scope(exec);
      const observations = await runEnvironmentProbes({ workspaceRoot: workspace.path });
      const result = service.recordEnvironmentObservations({
        researchId: input.researchId,
        baseRevision: input.baseRevision,
        operationId: input.operationId,
        observations,
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result.result, observations, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_list_evidence_candidates',
    description:
      'List the REAL, copy-ready evidence references (canonical EvidenceRef objects) available in THIS workspace’s paper library. Call this BEFORE brainstorming and cite only what it returns. ' +
      'Each entry is a complete object with paperId, sourceSha256, assetRevision, assetKind, entryIndex, contentHash, page, quote, locator and snapshot — you cannot compute or guess these, so copy the object verbatim into ideas[].evidenceRefs or run.inputRefs. ' +
      'A whole-source ref (assetKind "source") has entryIndex null and contentHash equal to sourceSha256; a wiki/component ref carries the library revision and the entry index it was taken from. ' +
      'Optionally filter by paperId or assetKind. Read-only: never imports, publishes or rewrites papers. Exploratory ideas still need exploratoryNote instead of refs — never downgrade a missing source into "exploratory" to pass validation.',
    parameters: {
      paperId: { type: 'string', description: 'Restrict to one paper' },
      assetKind: { type: 'string', description: 'Restrict to source | wiki | component' },
      limit: { type: 'number', description: 'Max entries to return (default 40, max 200)' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'list_evidence_candidates');
      const input = args as { paperId?: string; assetKind?: string; limit?: number };
      const { workspace } = scope(exec);
      const entries = collectEvidenceCandidates(workspace.path, resolverFactory(workspace.path));
      const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 40)), 200);
      const filtered = entries
        .filter((entry) => (input.paperId === undefined || input.paperId === '' ? true : entry.ref.paperId === input.paperId))
        .filter((entry) => (input.assetKind === undefined || input.assetKind === '' ? true : entry.ref.assetKind === input.assetKind))
        .slice(0, limit);
      return {
        workspace: { id: workspace.id, title: workspace.title },
        total: filtered.length,
        note: 'Copy each ref object verbatim into ideas[].evidenceRefs or run.inputRefs. Do not edit, recompute or hand-build these fields.',
        refs: filtered,
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_validate_research_ideas',
    description:
      'Dry-run check of a brainstorm payload BEFORE publishing it: applies the REAL build/validation logic and reports per-item errors, without writing anything, creating a run, or consuming an operationId. ' +
      'Use it to fix formatting and reference problems (for example a ref given as a string instead of an object) while the run is still open. It never saves, never finalises a run and never counts as a publish attempt. ' +
      'Returns { ok, issues: [{ path, code, message }], legalIdeas, illegalIdeas }. When ok is true, submit the same payload to evolver_publish_research_ideas. ' +
      'Errors point at an exact field path so you can correct that item only; a bounded number of corrections is allowed — do not loop retrying one item forever, and do not pass validation by deleting evidence.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      contractRevision: { type: 'number', required: true, description: 'Contract revision the brainstorm ran against' },
      ideas: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true, description: 'Same ideas payload you intend to publish (0–12)' },
      run: { type: 'object', additionalProperties: true, description: 'Same run payload you intend to publish (inputRefs, inputEnvironmentIds, inputNotes, modelIdentity)' },
      emptyResultReason: { type: 'string', description: 'Required when ideas is empty and there is no failure' },
      failure: { type: 'object', additionalProperties: true, description: 'Run-level failure {code, message}; then ideas must be empty' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'validate_research_ideas');
      const input = args as {
        researchId: string; contractRevision: number;
        ideas: IdeaSubmission[]; run?: Record<string, unknown>;
        emptyResultReason?: string | null; failure?: { code: string; message: string } | null;
      };
      // The check is the SERVICE's own build + validation, read-only: a payload that validates
      // clean publishes clean, and nothing here invents a success publish would reject.
      const { workspace, service } = scope(exec);
      const result = service.validateResearchIdeas({
        researchId: input.researchId,
        contractRevision: input.contractRevision,
        run: input.run,
        ideas: input.ideas ?? [],
        emptyResultReason: input.emptyResultReason ?? null,
        failure: input.failure ?? null,
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result,
        note: result.ok ? 'payload is valid; publish it now' : 'fix the listed field paths, then validate again before publishing' };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_publish_research_ideas',
    description:
      'Publish one brainstorm run’s candidate directions (hypotheses, not proven methods) with their per-item results. Each idea: { title, hypothesis, basis: grounded|exploratory, evidenceRefs (grounded requires real, resolvable refs), exploratoryNote (exploratory requires it), atomicChange, validationPlan, targetMetrics?, costNote?, riskNote?, pendingQuestions? }. ' +
      'Upper bound 12 per run; 5–8 is the target when the material supports it — never pad to reach it. ' +
      'Zero legal candidates is a legitimate completed result: submit empty ideas with emptyResultReason. A model failure is failure: {code, message} with NO ideas. ' +
      'Duplicate or invalid items are reported per item while the legal rest is saved (partial). Existing user selections/edits are never overwritten. ' +
      'Generation is read-then-write: cite only sources from THIS workspace’s library; design modules stay ideas and are never written back as paper components.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      contractRevision: { type: 'number', required: true, description: 'Contract revision the brainstorm ran against' },
      baseRevision: { type: 'number', required: true, description: 'State revision this write is based on' },
      operationId: { type: 'string', required: true, description: 'Stable operation id; the brainstorm run records it' },
      run: { type: 'object', additionalProperties: true, required: true, description: '{ runId? (reuse the run id your workflow was given), modelIdentity?, inputRefs?, inputEnvironmentIds?, inputNotes? } — inputRefs are FULL ref objects copied from evolver_list_evidence_candidates, exactly like ideas[].evidenceRefs below; agentIdentity is bound from your session automatically' },
      ideas: { type: 'array', required: true, description: 'Candidate list (0–12)',
        items: { type: 'object', additionalProperties: false, properties: {
          title: { type: 'string', required: true }, hypothesis: { type: 'string', required: true }, rationale: { type: 'string' },
          basis: { type: 'string', required: true, enum: ['grounded', 'exploratory'] },
          evidenceRefs: { type: 'array', items: evRefSchema(), description: 'grounded ideas REQUIRE ≥1 FULL ref object copied from evolver_list_evidence_candidates — never a paperId string, never a filename, never a hand-built object' },
          exploratoryNote: { type: 'string', description: 'exploratory ideas REQUIRE this: why evidence is pending' },
          atomicChange: { type: 'string', required: true }, validationPlan: { type: 'string', required: true },
          targetMetrics: { type: 'array', items: { type: 'string' } },
          costNote: { type: 'string' }, riskNote: { type: 'string' }, pendingQuestions: { type: 'array', items: { type: 'string' } }, proposedSlot: { type: 'string' },
        } } },
      itemErrors: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Per-item problems already known: { label, code, message }' },
      emptyResultReason: { type: 'string', description: 'Required when ideas is empty and there is no failure: why no candidate is publishable' },
      failure: { type: 'object', additionalProperties: true, description: 'Run-level failure {code, message}; then ideas must be empty' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'publish_research_ideas');
      const input = args as {
        researchId: string; contractRevision: number; baseRevision: number; operationId: string;
        run: { runId?: string; modelIdentity?: string | null; inputRefs?: EvidenceRef[]; inputEnvironmentIds?: string[]; inputNotes?: string | null };
        ideas: IdeaSubmission[];
        itemErrors?: Array<{ label: string; code: string; message: string }>;
        emptyResultReason?: string | null;
        failure?: { code: string; message: string } | null;
      };
      const { workspace, service, sessionId } = scope(exec);
      // The brainstorm identity is the real invoking agent — any payload attempt to name a
      // different agent would already have been refused by assertNoForbiddenFields.
      const run = { ...input.run, agentIdentity: sessionId };
      const result = service.publishResearchIdeas({
        researchId: input.researchId,
        contractRevision: input.contractRevision,
        baseRevision: input.baseRevision,
        operationId: input.operationId,
        run,
        ideas: input.ideas ?? [],
        itemErrors: input.itemErrors,
        emptyResultReason: input.emptyResultReason,
        failure: input.failure ?? null,
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'evolver_update_research_idea',
    description:
      'Edit one idea’s hypothesis/design description (title, hypothesis, rationale, basis, evidenceRefs, proposedSlot, atomicChange, validationPlan, targetMetrics, costNote, riskNote, pendingQuestions). ' +
      'The stable ideaId stays; content changes bump its revision and hash and are recorded with the real editor identity. ' +
      'Grounded edits must keep resolvable evidence; exploratory edits must keep the explicit “evidence pending” note. Graph nodes referencing the old content version are flagged for review — history is never silently rewritten. ' +
      'This edits YOUR hypothesis/design text, never a paper quote or the paper library.',
    parameters: {
      researchId: { type: 'string', required: true, description: 'Research id' },
      ideaId: { type: 'string', required: true, description: 'Stable idea id to edit' },
      baseRevision: { type: 'number', required: true, description: 'State revision this write is based on' },
      operationId: { type: 'string', required: true, description: 'Stable operation id' },
      patch: { type: 'object', additionalProperties: true, required: true, description: 'Fields to change; only provided fields are applied' },
    },
    output: jsonOutput,
    execute: (args: unknown, exec: ToolRunContext) => {
      assertNoForbiddenFields(args, 'update_research_idea');
      const input = args as {
        researchId: string; ideaId: string; baseRevision: number; operationId: string; patch: Record<string, unknown>;
      };
      const { workspace, service, sessionId } = scope(exec);
      const result = service.updateResearchIdea({
        researchId: input.researchId,
        ideaId: input.ideaId,
        baseRevision: input.baseRevision,
        operationId: input.operationId,
        patch: input.patch ?? {},
        origin: { kind: 'tool', identity: `agent:${sessionId}` },
      });
      return { workspace: { id: workspace.id, title: workspace.title }, ...result.result, revision: result.revision, replayed: result.replayed };
    },
  }));

  return {
    serviceForSession(sessionId: string): { intent: ResearchBootstrapIntentService; workspace: RegistryWorkspace } {
      const workspace = workspaceForSession(registry, sessionId);
      return {
        workspace,
        intent: new ResearchBootstrapIntentService(storeFactory(workspace.path), { resolver: resolverFactory(workspace.path) }),
      };
    },
  };
}

export interface ResearchBootstrapIntentServiceAccessor {
  serviceForSession(sessionId: string): { intent: ResearchBootstrapIntentService; workspace: RegistryWorkspace };
}
