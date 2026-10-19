/**
 * Research Bootstrap intent service: research contracts, environment observations and Brainstorm.
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-01-INTENT-SPEC-2026-10-10.md,
 * shared SPEC §3–§4. Persistence goes exclusively through the BE-02 store — no second Contract
 * JSON, no sidecar files.
 *
 * Trust rules implemented here (the tools inherit them by construction):
 * - A model may draft and update a contract, propose a baseline, ask questions and publish
 *   candidates. A model can NEVER confirm anything: `confirmResearchContract` and
 *   `confirmBaseline` are trusted service methods that BE-03 wires to real native actions, and
 *   the tool path refuses `status: "confirmed"` / `baseline.status: "confirmed"` outright.
 * - `autonomy` is fixed to `plan_only`; a request for more autonomy is refused with an
 *   explanation, never silently accepted, and never starts a runner.
 * - Ideas are hypotheses to validate, never proven methods: grounded requires resolvable
 *   evidence, exploratory requires its explicit “evidence pending” note; duplicates are recorded
 *   instead of published; a run with zero legal candidates is a real `completed` result with a
 *   reason (never padded), and a model failure is a real `failed`.
 * - Publishing never overwrites user selections or edits: it only appends new ideas and never
 *   touches `status`, `editHistory` or review notes of existing ones.
 */

import {
  BOOTSTRAP_BOUNDS,
  BOOTSTRAP_AUTONOMY,
  BootstrapError,
  type BootstrapErrorCode,
  assessEvidenceRef,
  contractSemanticHash,
  ideaContentHash,
  mintBootstrapId,
  validateEnvironmentObservation,
  validateEvidenceRefs,
  validateResearchContract,
  validateResearchIdea,
  type BootstrapSourceResolver,
  type BrainstormRun,
  type ContractConfirmation,
  type EnvironmentObservation,
  type EvidenceRef,
  type PendingQuestion,
  type ResearchBootstrap,
  type ResearchContract,
  type ResearchIdea,
} from '../contracts/research-bootstrap.ts';
import {
  createResearch,
  requireResearch,
  type MutationContext,
  type MutationResult,
  type ResearchBootstrapStore,
} from './research-bootstrap-store.ts';

const TEXT_MAX = { title: 300, body: 4000, note: 2000, question: 2000, listEntry: 300 } as const;

function fail(code: BootstrapErrorCode, detail: string): never {
  throw new BootstrapError(code, detail);
}

const nonEmpty = (value: unknown, label: string, max: number): string => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    fail('INVALID_INPUT', `${label} must be non-empty text of at most ${max} characters`);
  }
  return value;
};
const optionalText = (value: unknown, label: string, max: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > max) fail('INVALID_INPUT', `${label} must be text of at most ${max} characters or null`);
  return value;
};

// ------------------------------------------------------------------ inputs

export interface ContractPatchInput {
  /** Research-level display title (not a contract field). */
  title?: string;
  researchQuestion?: string | null;
  goal?: string | null;
  baseline?: {
    /** Tool callers may propose ('proposed') or reset ('undecided'); 'confirmed' is trusted-only. */
    status: 'undecided' | 'proposed';
    name?: string | null;
    paperRef?: EvidenceRef | null;
    repoLocator?: string | null;
  };
  dataDescription?: string | null;
  metrics?: string[];
  guardrails?: string[];
  editableScope?: string[];
  lockedScope?: string[];
  computeBudget?: string | null;
  timeBudget?: string | null;
  pendingQuestions?: Array<{
    questionId?: string;
    field: string;
    question: string;
    /** Tool callers may only open questions; answers come through trusted Ask records. */
    status?: 'open' | 'answered' | 'skipped';
    answer?: string | null;
    answeredBy?: string | null;
  }>;
}

export interface SaveContractInput {
  /** Omit or null to create a new research (the store mints the researchId). */
  researchId?: string | null;
  baseRevision: number;
  operationId: string;
  patch: ContractPatchInput;
  /** Who really drove this write; `user_action` comes from BE-03's native action boundary. */
  origin: { kind: 'tool' | 'user_action'; identity: string; actionId?: string | null };
}

export interface ConfirmContractInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  actor: { identity: string; actionId: string };
  note?: string | null;
}

export interface ConfirmBaselineInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  actor: { identity: string; actionId: string };
  /** Values to confirm; omitted fields keep their current draft values. */
  proposal?: { name?: string | null; paperRef?: EvidenceRef | null; repoLocator?: string | null };
  note?: string | null;
}

export interface RecordObservationsInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  observations: EnvironmentObservation[];
}

export interface IdeaSubmission {
  title: string;
  hypothesis: string;
  rationale?: string | null;
  basis: 'grounded' | 'exploratory';
  /** Required when basis is exploratory. */
  exploratoryNote?: string | null;
  evidenceRefs?: EvidenceRef[];
  proposedSlot?: string | null;
  atomicChange: string;
  validationPlan: string;
  targetMetrics?: string[];
  costNote?: string | null;
  riskNote?: string | null;
  pendingQuestions?: string[];
}

export interface PublishIdeasInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  contractRevision: number;
  run: {
    runId?: string | null;
    /** Set by the TOOL from the invoking Agent's context — never read from model payload. */
    agentIdentity: string;
    modelIdentity?: string | null;
    inputRefs?: EvidenceRef[];
    inputEnvironmentIds?: string[];
    inputNotes?: string | null;
  };
  ideas: IdeaSubmission[];
  /** Problems the workflow already found per item; kept and merged with service-found ones. */
  itemErrors?: Array<{ label: string; code: string; message: string }>;
  /** Required when `ideas` is empty and there is no failure: the explicit no-candidate reason. */
  emptyResultReason?: string | null;
  /** Run-level failure (model unavailable etc.); then `ideas` must be empty. */
  failure?: { code: string; message: string } | null;
}

export interface UpdateIdeaInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  ideaId: string;
  patch: Partial<Omit<IdeaSubmission, 'basis'>> & { basis?: 'grounded' | 'exploratory' };
  origin: { kind: 'tool' | 'user_action'; identity: string };
}

export interface SetRunStatusInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  runId: string;
  status: 'pending' | 'running' | 'cancelled' | 'interrupted' | 'failed';
  error?: { code: string; message: string } | null;
}

export interface PublishIdeasResult {
  researchId: string;
  runId: string;
  runStatus: BrainstormRun['status'];
  ideaIds: string[];
  duplicates: Array<{ submittedLabel: string; existingIdeaId: string }>;
  itemErrors: Array<{ label: string; code: string; message: string }>;
}

export interface SaveContractResult {
  researchId: string;
  created: boolean;
  contractRevision: number;
  contractStatus: ResearchContract['status'];
  semanticChanged: boolean;
  flaggedNodes: string[];
}

// ------------------------------------------------------------------ service

export class ResearchBootstrapIntentService {
  private readonly store: ResearchBootstrapStore;
  private readonly deps: { resolver: BootstrapSourceResolver };

  constructor(store: ResearchBootstrapStore, deps: { resolver: BootstrapSourceResolver }) {
    this.store = store;
    this.deps = deps;
  }

  // ------------------------------------------------------------------ contract

  saveResearchContract(input: SaveContractInput): MutationResult<SaveContractResult> {
    if (typeof input.origin?.identity !== 'string' || input.origin.identity.trim().length === 0) {
      fail('INVALID_INPUT', 'origin.identity (the real tool/user identity) is required for contract writes');
    }
    const patch = input.patch ?? {};
    // Refuse the two fields a model would use to upgrade itself, instead of silently ignoring them.
    const patchRecord = patch as Record<string, unknown>;
    if ('status' in patchRecord) {
      fail('POLICY_DENIED', 'contract status cannot be set by a request; confirming a contract is a user action (trusted confirmResearchContract)');
    }
    if ('autonomy' in patchRecord && patchRecord.autonomy !== BOOTSTRAP_AUTONOMY) {
      fail('POLICY_DENIED', `autonomy is fixed to "${BOOTSTRAP_AUTONOMY}" in this phase; higher autonomy is not available and is never silently accepted`);
    }
    if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.trim().length === 0 || patch.title.length > TEXT_MAX.title)) {
      fail('INVALID_INPUT', 'patch.title must be non-empty text of at most 300 characters');
    }
    const requestPayload = { op: 'save_research_contract', researchId: input.researchId ?? null, patch, originKind: input.origin.kind };
    return this.store.mutate<SaveContractResult>({
      operationId: input.operationId,
      kind: 'save_contract',
      researchId: input.researchId ?? null,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const now = context.now();
        let created = false;
        let research: ResearchBootstrap;
        if (input.researchId == null) {
          research = createResearch(context.state, { title: patch.title ?? '未命名研究', now, mint: context.mint });
          created = true;
        } else {
          research = requireResearch(context.state, input.researchId);
          if (patch.title !== undefined) research.title = patch.title;
        }
        const semanticBefore = contractSemanticHash(research.contract);
        const titleChanged = !created && patch.title !== undefined && research.title !== patch.title;
        const contract = structuredClone(research.contract);
        this.applyContractPatch(contract, patch, input.origin, now);
        contract.updatedAt = now;
        const semanticChanged = contractSemanticHash(contract) !== semanticBefore;
        // A request that changes nothing (same semantics, same title) is a no-op: no revision,
        // no receipt — the state file stays byte-identical.
        if (!created && !semanticChanged && !titleChanged) {
          return {
            changed: false,
            result: {
              researchId: research.researchId, created: false,
              contractRevision: research.contract.revision,
              contractStatus: research.contract.status,
              semanticChanged: false, flaggedNodes: [],
            },
          };
        }
        if (semanticChanged && !created) {
          contract.revision = research.contract.revision + 1;
          if (contract.status === 'confirmed') contract.status = 'draft'; // any semantic edit reopens confirmation
        }
        research.contract = validateResearchContract(contract, 'contract');
        research.updatedAt = now;
        const flaggedNodes: string[] = [];
        if (semanticChanged && research.graph !== null) {
          for (const node of research.graph.nodes) {
            if (!node.reviewFlags.includes('contract_updated')) {
              node.reviewFlags.push('contract_updated');
              flaggedNodes.push(node.nodeId);
            }
          }
          research.graph.updatedAt = now;
        }
        return {
          changed: true,
          result: {
            researchId: research.researchId, created,
            contractRevision: research.contract.revision,
            contractStatus: research.contract.status,
            semanticChanged, flaggedNodes,
          },
        };
      },
    });
  }

  /** Trusted: the real user confirms the current draft INCLUDING its pending items. */
  confirmResearchContract(input: ConfirmContractInput): MutationResult<{ researchId: string; contractRevision: number; status: 'confirmed' }> {
    if (typeof input.actor?.actionId !== 'string' || input.actor.actionId.trim().length === 0) {
      fail('POLICY_DENIED', 'contract confirmation requires a real native action id from the trusted host boundary');
    }
    const requestPayload = { op: 'confirm_research_contract', researchId: input.researchId, actionId: input.actor.actionId };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'confirm_contract',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const now = context.now();
        research.contract.status = 'confirmed';
        const confirmation: ContractConfirmation = {
          field: 'contract', kind: 'user_action', actionId: input.actor.actionId,
          actorIdentity: input.actor.identity, at: now, note: input.note ?? null,
        };
        research.contract.confirmations = [...research.contract.confirmations, confirmation].slice(-50);
        research.contract.updatedAt = now;
        research.updatedAt = now;
        return { changed: true, result: { researchId: research.researchId, contractRevision: research.contract.revision, status: research.contract.status } };
      },
    });
  }

  /** Trusted: the real user confirms the baseline (Paper Baseline ≠ User Baseline until now). */
  confirmBaseline(input: ConfirmBaselineInput): MutationResult<{ researchId: string; baseline: { status: 'confirmed'; name: string | null }; contractRevision: number; flaggedNodes: string[] }> {
    if (typeof input.actor?.actionId !== 'string' || input.actor.actionId.trim().length === 0) {
      fail('POLICY_DENIED', 'baseline confirmation requires a real native action id from the trusted host boundary');
    }
    const requestPayload = { op: 'confirm_research_baseline', researchId: input.researchId, actionId: input.actor.actionId, proposal: input.proposal ?? null };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'confirm_baseline',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const now = context.now();
        const contract = structuredClone(research.contract);
        const proposal = input.proposal ?? {};
        if (proposal.name !== undefined) contract.baseline.name = optionalText(proposal.name, 'baseline.name', TEXT_MAX.listEntry);
        if (proposal.repoLocator !== undefined) {
          contract.baseline.repoLocator = proposal.repoLocator === null ? null : requireLocator(proposal.repoLocator, 'baseline.repoLocator');
        }
        if (proposal.paperRef !== undefined) {
          contract.baseline.paperRef = proposal.paperRef === null ? null : this.requireCurrentEvidence(proposal.paperRef, 'baseline.paperRef');
        }
        contract.baseline.status = 'confirmed';
        contract.revision = research.contract.revision + 1;
        const confirmation: ContractConfirmation = {
          field: 'baseline', kind: 'user_action', actionId: input.actor.actionId,
          actorIdentity: input.actor.identity, at: now, note: input.note ?? null,
        };
        contract.confirmations = [...contract.confirmations, confirmation].slice(-50);
        contract.updatedAt = now;
        research.contract = validateResearchContract(contract, 'contract');
        research.updatedAt = now;
        const flaggedNodes: string[] = [];
        if (research.graph !== null) {
          for (const node of research.graph.nodes) {
            if (!node.reviewFlags.includes('contract_updated')) {
              node.reviewFlags.push('contract_updated');
              flaggedNodes.push(node.nodeId);
            }
          }
          research.graph.updatedAt = now;
        }
        return {
          changed: true,
          result: {
            researchId: research.researchId,
            baseline: { status: 'confirmed', name: research.contract.baseline.name },
            contractRevision: research.contract.revision,
            flaggedNodes,
          },
        };
      },
    });
  }

  // ------------------------------------------------------------------ environment observations

  recordEnvironmentObservations(input: RecordObservationsInput): MutationResult<{ researchId: string; observationIds: string[]; dropped: number }> {
    const seen = new Set<string>();
    const observations = input.observations.map((entry, index) => {
      const observation = validateEnvironmentObservation(entry, `observations[${index}]`);
      if (seen.has(observation.observationId)) fail('INVALID_INPUT', `observations[${index}].observationId repeats within this submission`);
      seen.add(observation.observationId);
      return observation;
    });
    const requestPayload = { op: 'record_environment_observations', researchId: input.researchId, observationIds: observations.map((entry) => entry.observationId) };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'record_observations',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const existingIds = new Set(research.environment.map((entry) => entry.observationId));
        const fresh = observations.filter((entry) => {
          if (existingIds.has(entry.observationId)) return false; // replayed probe id: keep the original fact
          existingIds.add(entry.observationId);
          return true;
        });
        research.environment = [...research.environment, ...fresh].slice(-BOOTSTRAP_BOUNDS.maxObservationsPerResearch);
        const dropped = observations.length - fresh.length;
        research.updatedAt = context.now();
        return {
          changed: fresh.length > 0,
          result: { researchId: research.researchId, observationIds: fresh.map((entry) => entry.observationId), dropped },
        };
      },
    });
  }

  // ------------------------------------------------------------------ brainstorm

  /**
   * Dry-run check of a brainstorm payload: the REAL build + validation + resolution logic, but
   * without writing anything, without creating or finishing a run, and without consuming an
   * operationId. The same per-item throw that rejects an item at publish time is what labels
   * it here, so a fixed payload that validates clean publishes clean — and nothing here can
   * invent a success that publish would reject.
   */
  validateResearchIdeas(input: {
    researchId: string; contractRevision: number;
    run?: { runId?: string | null; inputRefs?: unknown[]; inputEnvironmentIds?: unknown[]; inputNotes?: unknown };
    ideas: IdeaSubmission[];
    emptyResultReason?: string | null; failure?: { code: string; message: string } | null;
  }): { ok: boolean; issues: Array<{ path: string; code: string; message: string }>; legalIdeas: string[]; illegalIdeas: string[]; duplicates: Array<{ submittedLabel: string; existingIdeaId: string }>; expectedStatus: 'completed' | 'partial' | 'failed' } {
    const issues: Array<{ path: string; code: string; message: string }> = [];
    const legal: string[] = [];
    const illegal: string[] = [];
    const duplicates: Array<{ submittedLabel: string; existingIdeaId: string }> = [];
    const submissions = Array.isArray(input.ideas) ? input.ideas : fail('INVALID_INPUT', 'ideas must be an array');
    if (submissions.length > BOOTSTRAP_BOUNDS.maxIdeasPerRun) {
      issues.push({ path: 'ideas', code: 'INVALID_INPUT', message: `at most ${BOOTSTRAP_BOUNDS.maxIdeasPerRun} ideas per run` });
    }
    if (input.failure != null && submissions.length > 0) {
      issues.push({ path: 'failure', code: 'INVALID_INPUT', message: 'a failed run publishes no ideas; report the failure alone' });
    }
    if (submissions.length === 0 && input.failure == null && !input.emptyResultReason) {
      issues.push({ path: 'emptyResultReason', code: 'INVALID_INPUT', message: 'an empty candidate set requires emptyResultReason (a real completed-with-no-candidates result)' });
    }
    // Run-level refs use the same declaration as idea refs, so the same mistake is caught here.
    const state = this.store.readStateOrEmpty();
    const research = state.researches.find((entry: (typeof state.researches)[number]) => entry.researchId === input.researchId);
    if (research === undefined) {
      issues.push({ path: 'researchId', code: 'NOT_FOUND', message: `research ${input.researchId} does not exist` });
    } else {
      if (research.contract.revision !== input.contractRevision) {
        issues.push({ path: 'contractRevision', code: 'CONTRACT_REVISION_MISMATCH', message: `research contract is at revision ${research.contract.revision}, the brainstorm used ${input.contractRevision}; re-read and re-run` });
      }
      try {
        validateEvidenceRefs(input.run?.inputRefs ?? [], 'run.inputRefs');
      } catch (error) {
        issues.push({ path: 'run.inputRefs', code: error instanceof BootstrapError ? error.code : 'INVALID_INPUT', message: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
      }
      const existingHashes = new Map(research.ideas.map((idea: (typeof research.ideas)[number]) => [idea.contentHash, idea.ideaId]));
      const now = new Date().toISOString();
      let counter = 0;
      const mint = (prefix: string) => `${prefix}-dryrun-${(counter += 1)}`;
      for (const [index, submission] of submissions.entries()) {
        const label = `ideas[${index}](${typeof submission?.title === 'string' ? submission.title.slice(0, 60) : 'untitled'})`;
        try {
          const idea = this.buildIdea(submission, index, { contractRevision: input.contractRevision, runId: typeof input.run?.runId === 'string' ? input.run.runId : 'dry-run', now, mint });
          const duplicateOf = existingHashes.get(idea.contentHash);
          if (duplicateOf !== undefined) {
            duplicates.push({ submittedLabel: idea.title, existingIdeaId: duplicateOf });
            continue;
          }
          legal.push(idea.title);
        } catch (error) {
          illegal.push(label);
          issues.push({ path: label, code: error instanceof BootstrapError ? error.code : 'INVALID_IDEA', message: error instanceof Error ? error.message.slice(0, 2000) : String(error).slice(0, 2000) });
        }
      }
    }
    const expectedStatus = submissions.length === 0 || illegal.length === 0 && duplicates.length === 0 && issues.length === 0 ? (submissions.length === 0 && input.failure != null ? 'failed' : 'completed')
      : legal.length > 0 || duplicates.length > 0 ? 'partial' : 'failed';
    return { ok: issues.length === 0, issues, legalIdeas: legal, illegalIdeas: illegal, duplicates, expectedStatus };
  }

  publishResearchIdeas(input: PublishIdeasInput): MutationResult<PublishIdeasResult> {
    const submissions = input.ideas ?? [];
    if (!Array.isArray(submissions)) fail('INVALID_INPUT', 'ideas must be an array');
    if (submissions.length > BOOTSTRAP_BOUNDS.maxIdeasPerRun) {
      fail('INVALID_INPUT', `at most ${BOOTSTRAP_BOUNDS.maxIdeasPerRun} ideas per run`);
    }
    if (input.failure != null && submissions.length > 0) {
      fail('INVALID_INPUT', 'a failed run publishes no ideas; report the failure alone');
    }
    if (submissions.length === 0 && input.failure == null && !input.emptyResultReason) {
      fail('INVALID_INPUT', 'an empty candidate set requires emptyResultReason (a real completed-with-no-candidates result)');
    }
    const itemErrors = (input.itemErrors ?? []).map((entry, index) => {
      if (typeof entry !== 'object' || entry === null) fail('INVALID_INPUT', `itemErrors[${index}] must be an object`);
      return {
        label: nonEmpty((entry as { label?: unknown }).label, `itemErrors[${index}].label`, 200),
        code: nonEmpty((entry as { code?: unknown }).code, `itemErrors[${index}].code`, 100),
        message: nonEmpty((entry as { message?: unknown }).message, `itemErrors[${index}].message`, 2000),
      };
    });
    // The request hash must cover EVERY field that changes the durable result. Omitting
    // itemErrors / run.inputRefs / run.inputEnvironmentIds would let a same-ID request with
    // different semantic input replay the old outcome — a silent conflation, not idempotency.
    // Concurrency-control fields (baseRevision, operationId) stay OUT of the payload by design:
    // they guard ordering, they do not describe the work.
    const requestPayload = {
      op: 'publish_research_ideas',
      researchId: input.researchId,
      contractRevision: input.contractRevision,
      run: { runId: input.run?.runId ?? null, modelIdentity: input.run?.modelIdentity ?? null, inputNotes: input.run?.inputNotes ?? null,
        inputRefs: input.run?.inputRefs ?? [], inputEnvironmentIds: input.run?.inputEnvironmentIds ?? [] },
      ideas: submissions,
      itemErrors: input.itemErrors ?? [],
      emptyResultReason: input.emptyResultReason ?? null,
      failure: input.failure ?? null,
    };
    return this.store.mutate<PublishIdeasResult>({
      operationId: input.operationId,
      kind: 'publish_ideas',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        if (research.contract.revision !== input.contractRevision) {
          fail('CONTRACT_REVISION_MISMATCH', `research contract is at revision ${research.contract.revision}, the brainstorm used ${input.contractRevision}; re-read and re-run`);
        }
        const now = context.now();
        const agentIdentity = nonEmpty(input.run.agentIdentity, 'run.agentIdentity (bound from the invoking Agent by the tool)', 200);
        let run = input.run?.runId ? research.brainstormRuns.find((entry) => entry.runId === input.run!.runId) : undefined;
        if (run !== undefined) {
          if (run.agentIdentity !== agentIdentity) fail('POLICY_DENIED', `run ${run.runId} belongs to agent ${run.agentIdentity}; runs are not transferable between agents`);
          if (run.status !== 'pending' && run.status !== 'running') {
            fail('REVISION_CONFLICT', `run ${run.runId} is already ${run.status}; start a new run instead of re-finishing it`);
          }
        } else {
          run = {
            runId: input.run?.runId || context.mint('run'),
            operationId: input.operationId,
            agentIdentity,
            modelIdentity: input.run?.modelIdentity ?? null,
            contractRevision: input.contractRevision,
            inputRefs: validateEvidenceRefs(input.run?.inputRefs ?? [], 'run.inputRefs'),
            inputEnvironmentIds: (input.run?.inputEnvironmentIds ?? []).map((entry, index) => {
              if (typeof entry !== 'string' || entry.trim().length === 0) fail('INVALID_INPUT', `run.inputEnvironmentIds[${index}] must be an observation id`);
              return entry;
            }),
            inputNotes: optionalText(input.run?.inputNotes, 'run.inputNotes', 2000),
            status: 'running',
            ideaIds: [], itemErrors: [], duplicates: [], emptyResultReason: null, error: null,
            startedAt: now, finishedAt: null,
          };
          research.brainstormRuns.push(run);
        }
        run.itemErrors = [...run.itemErrors, ...itemErrors];
        if (input.failure != null) {
          run.status = 'failed';
          run.error = { code: nonEmpty(input.failure.code, 'failure.code', 100), message: nonEmpty(input.failure.message, 'failure.message', 2000) };
          run.finishedAt = now;
          research.updatedAt = now;
          return {
            changed: true,
            result: { researchId: research.researchId, runId: run.runId, runStatus: run.status, ideaIds: run.ideaIds, duplicates: run.duplicates, itemErrors: run.itemErrors },
          };
        }
        // Publish candidates one by one; bad ones never block the legal rest (partial allowed).
        const duplicates: Array<{ submittedLabel: string; existingIdeaId: string }> = [];
        const savedIds: string[] = [];
        const existingHashes = new Map(research.ideas.map((idea) => [idea.contentHash, idea.ideaId]));
        for (const [index, submission] of submissions.entries()) {
          const label = `ideas[${index}](${typeof submission?.title === 'string' ? submission.title.slice(0, 60) : 'untitled'})`;
          try {
            const idea = this.buildIdea(submission, index, { contractRevision: input.contractRevision, runId: run.runId, now, mint: context.mint });
            const duplicateOf = existingHashes.get(idea.contentHash);
            if (duplicateOf !== undefined) {
              duplicates.push({ submittedLabel: idea.title, existingIdeaId: duplicateOf });
              run.duplicates.push({ submittedLabel: idea.title, existingIdeaId: duplicateOf });
              continue;
            }
            if (research.ideas.length >= BOOTSTRAP_BOUNDS.maxIdeasPerResearch) {
              run.itemErrors.push({ label, code: 'SCHEMA_VIOLATION', message: 'research reached its idea bound; further candidates were not saved' });
              continue;
            }
            research.ideas.push(idea);
            existingHashes.set(idea.contentHash, idea.ideaId);
            savedIds.push(idea.ideaId);
          } catch (error) {
            const code = error instanceof BootstrapError ? error.code : 'INVALID_IDEA';
            const message = error instanceof Error ? error.message : String(error);
            run.itemErrors.push({ label, code, message: message.slice(0, 2000) });
          }
        }
        run.ideaIds = [...run.ideaIds, ...savedIds];
        if (submissions.length === 0) {
          run.status = 'completed';
          run.emptyResultReason = nonEmpty(input.emptyResultReason, 'emptyResultReason', 2000);
        } else if (savedIds.length === 0) {
          run.status = 'failed';
          run.error = { code: 'NO_VALID_CANDIDATES', message: 'every submitted candidate was rejected; see itemErrors for the per-item reasons' };
        } else if (run.itemErrors.length > 0) {
          run.status = 'partial';
        } else {
          run.status = 'completed';
        }
        run.finishedAt = now;
        research.updatedAt = now;
        return {
          changed: true,
          result: { researchId: research.researchId, runId: run.runId, runStatus: run.status, ideaIds: run.ideaIds, duplicates, itemErrors: run.itemErrors },
        };
      },
    });
  }

  /** Builds + validates one candidate; throws per-item so the rest of the batch survives. */
  private buildIdea(submission: IdeaSubmission, index: number, scope: { contractRevision: number; runId: string; now: string; mint: (prefix: string) => string }): ResearchIdea {
    if (typeof submission !== 'object' || submission === null) fail('INVALID_INPUT', `ideas[${index}] must be an object`);
    const basis = submission.basis === 'grounded' || submission.basis === 'exploratory' ? submission.basis : fail('INVALID_INPUT', `ideas[${index}].basis must be grounded | exploratory`);
    const evidenceRefs = validateEvidenceRefs(submission.evidenceRefs ?? [], `ideas[${index}].evidenceRefs`);
    if (basis === 'grounded' && evidenceRefs.length === 0) {
      fail('INVALID_INPUT', `ideas[${index}]: a grounded candidate requires at least one evidence ref; otherwise submit it as exploratory with an explicit note`);
    }
    if (basis === 'exploratory') {
      const note = optionalText(submission.exploratoryNote, `ideas[${index}].exploratoryNote`, TEXT_MAX.note);
      if (note === null) fail('INVALID_INPUT', `ideas[${index}]: an exploratory candidate requires its explicit “exploratory, evidence pending” note`);
    }
    // Every claimed source must really resolve right now; one bad quote rejects that item only.
    for (const [refIndex, ref] of evidenceRefs.entries()) {
      const assessment = assessEvidenceRef(ref, this.deps.resolver);
      if (assessment.status !== 'current') {
        fail(assessment.status === 'missing' ? 'SOURCE_MISSING' : 'SOURCE_STALE',
          `ideas[${index}].evidenceRefs[${refIndex}] does not resolve: ${assessment.detail}`);
      }
    }
    const idea: ResearchIdea = {
      ideaId: scope.mint('idea'),
      revision: 1,
      contentHash: '',
      status: 'candidate',
      title: nonEmpty(submission.title, `ideas[${index}].title`, TEXT_MAX.title),
      hypothesis: nonEmpty(submission.hypothesis, `ideas[${index}].hypothesis`, TEXT_MAX.body),
      rationale: optionalText(submission.rationale, `ideas[${index}].rationale`, TEXT_MAX.body),
      basis,
      exploratoryNote: optionalText(submission.exploratoryNote, `ideas[${index}].exploratoryNote`, TEXT_MAX.note),
      evidenceRefs,
      proposedSlot: optionalText(submission.proposedSlot, `ideas[${index}].proposedSlot`, 200),
      atomicChange: nonEmpty(submission.atomicChange, `ideas[${index}].atomicChange`, TEXT_MAX.body),
      validationPlan: nonEmpty(submission.validationPlan, `ideas[${index}].validationPlan`, TEXT_MAX.body),
      targetMetrics: (submission.targetMetrics ?? []).map((entry, i) => nonEmpty(entry, `ideas[${index}].targetMetrics[${i}]`, TEXT_MAX.listEntry)),
      costNote: optionalText(submission.costNote, `ideas[${index}].costNote`, TEXT_MAX.note),
      riskNote: optionalText(submission.riskNote, `ideas[${index}].riskNote`, TEXT_MAX.note),
      pendingQuestions: (submission.pendingQuestions ?? []).map((entry, i) => nonEmpty(entry, `ideas[${index}].pendingQuestions[${i}]`, TEXT_MAX.listEntry)),
      contractRevision: scope.contractRevision,
      reviewNotes: [],
      runId: scope.runId,
      editHistory: [],
      createdAt: scope.now,
      updatedAt: scope.now,
    };
    idea.contentHash = ideaContentHash(idea);
    return validateResearchIdea(idea);
  }

  /** User/model edit of one idea's hypothesis or design description; content versioned, ids stable. */
  updateResearchIdea(input: UpdateIdeaInput): MutationResult<{ researchId: string; ideaId: string; revision: number; contentHash: string; changedFields: string[]; flaggedNodes: string[] }> {
    if (typeof input.origin?.identity !== 'string' || input.origin.identity.trim().length === 0) {
      fail('INVALID_INPUT', 'origin.identity (the real editor identity) is required for idea edits');
    }
    const requestPayload = { op: 'update_research_idea', researchId: input.researchId, ideaId: input.ideaId, patch: input.patch, originKind: input.origin.kind };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'update_idea',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const idea = research.ideas.find((entry) => entry.ideaId === input.ideaId);
        if (idea === undefined) fail('NOT_FOUND', `idea ${input.ideaId} does not exist in research ${research.researchId}`);
        const now = context.now();
        const next = structuredClone(idea);
        const changedFields: string[] = [];
        const patch = input.patch ?? {};
        const withField = (field: keyof IdeaSubmission, apply: () => void) => {
          if (patch[field] === undefined) return;
          apply();
          changedFields.push(String(field));
        };
        withField('title', () => { next.title = nonEmpty(patch.title, 'patch.title', TEXT_MAX.title); });
        withField('hypothesis', () => { next.hypothesis = nonEmpty(patch.hypothesis, 'patch.hypothesis', TEXT_MAX.body); });
        withField('rationale', () => { next.rationale = optionalText(patch.rationale, 'patch.rationale', TEXT_MAX.body); });
        withField('exploratoryNote', () => { next.exploratoryNote = optionalText(patch.exploratoryNote, 'patch.exploratoryNote', TEXT_MAX.note); });
        withField('proposedSlot', () => { next.proposedSlot = optionalText(patch.proposedSlot, 'patch.proposedSlot', 200); });
        withField('atomicChange', () => { next.atomicChange = nonEmpty(patch.atomicChange, 'patch.atomicChange', TEXT_MAX.body); });
        withField('validationPlan', () => { next.validationPlan = nonEmpty(patch.validationPlan, 'patch.validationPlan', TEXT_MAX.body); });
        withField('costNote', () => { next.costNote = optionalText(patch.costNote, 'patch.costNote', TEXT_MAX.note); });
        withField('riskNote', () => { next.riskNote = optionalText(patch.riskNote, 'patch.riskNote', TEXT_MAX.note); });
        withField('targetMetrics', () => { next.targetMetrics = (patch.targetMetrics ?? []).map((entry, i) => nonEmpty(entry, `patch.targetMetrics[${i}]`, TEXT_MAX.listEntry)); });
        withField('pendingQuestions', () => { next.pendingQuestions = (patch.pendingQuestions ?? []).map((entry, i) => nonEmpty(entry, `patch.pendingQuestions[${i}]`, TEXT_MAX.listEntry)); });
        withField('basis', () => { next.basis = patch.basis === 'grounded' || patch.basis === 'exploratory' ? patch.basis : fail('INVALID_INPUT', 'patch.basis must be grounded | exploratory'); });
        if (patch.evidenceRefs !== undefined) {
          next.evidenceRefs = validateEvidenceRefs(patch.evidenceRefs, 'patch.evidenceRefs');
          changedFields.push('evidenceRefs');
        }
        // Basis invariants after the patch.
        if (next.basis === 'grounded' && next.evidenceRefs.length === 0) {
          fail('INVALID_INPUT', 'a grounded idea requires at least one evidence ref; switch it to exploratory with an explicit note instead');
        }
        if (next.basis === 'exploratory' && next.exploratoryNote === null) {
          fail('INVALID_INPUT', 'an exploratory idea requires its explicit “exploratory, evidence pending” note');
        }
        for (const [refIndex, ref] of next.evidenceRefs.entries()) {
          const assessment = assessEvidenceRef(ref, this.deps.resolver);
          if (assessment.status !== 'current') {
            fail(assessment.status === 'missing' ? 'SOURCE_MISSING' : 'SOURCE_STALE', `patch.evidenceRefs[${refIndex}] does not resolve: ${assessment.detail}`);
          }
        }
        const nextHash = ideaContentHash(next);
        const semanticChanged = nextHash !== idea.contentHash;
        if (semanticChanged) {
          next.revision = idea.revision + 1;
          next.contentHash = nextHash;
          next.editHistory = [...idea.editHistory, { at: now, actorIdentity: input.origin.identity, fields: changedFields }].slice(-50);
        }
        const validated = validateResearchIdea(next);
        research.ideas.splice(research.ideas.indexOf(idea), 1, validated);
        research.updatedAt = now;
        const flaggedNodes: string[] = [];
        if (semanticChanged && research.graph !== null) {
          for (const node of research.graph.nodes) {
            if (node.ideaRef?.ideaId === validated.ideaId && node.ideaRef.contentHash !== validated.contentHash) {
              if (!node.reviewFlags.includes('idea_updated')) node.reviewFlags.push('idea_updated');
              flaggedNodes.push(node.nodeId);
            }
          }
        }
        return {
          changed: semanticChanged,
          result: { researchId: research.researchId, ideaId: validated.ideaId, revision: validated.revision, contentHash: validated.contentHash, changedFields, flaggedNodes },
        };
      },
    });
  }

  /**
   * Opens a brainstorm run in `running` state so a workflow's lifecycle is durable from the
   * start: cancellation and interruption marking (BE-03) then have something real to mark, and
   * a crash cannot leave an invisible run. `publishResearchIdeas` finalizes it later.
   */
  beginBrainstormRun(input: {
    researchId: string;
    baseRevision: number;
    operationId: string;
    contractRevision: number;
    agentIdentity: string;
    runId?: string | null;
    modelIdentity?: string | null;
    inputRefs?: EvidenceRef[];
    inputEnvironmentIds?: string[];
    inputNotes?: string | null;
  }): MutationResult<{ researchId: string; runId: string; status: 'running' }> {
    const requestPayload = {
      op: 'begin_brainstorm_run',
      researchId: input.researchId,
      contractRevision: input.contractRevision,
      runId: input.runId ?? null,
      inputNotes: input.inputNotes ?? null,
    };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'begin_brainstorm_run',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        if (research.contract.revision !== input.contractRevision) {
          fail('CONTRACT_REVISION_MISMATCH', `research contract is at revision ${research.contract.revision}, the run used ${input.contractRevision}`);
        }
        const agentIdentity = nonEmpty(input.agentIdentity, 'agentIdentity (bound from the invoking Agent by the caller)', 200);
        const now = context.now();
        const existing = input.runId ? research.brainstormRuns.find((entry) => entry.runId === input.runId) : undefined;
        if (existing !== undefined) {
          if (existing.agentIdentity !== agentIdentity) fail('POLICY_DENIED', `run ${existing.runId} belongs to agent ${existing.agentIdentity}; runs are not transferable`);
          if (existing.status !== 'pending' && existing.status !== 'running') {
            fail('REVISION_CONFLICT', `run ${existing.runId} already finished as ${existing.status}; begin a new run instead`);
          }
          return { changed: false, result: { researchId: research.researchId, runId: existing.runId, status: existing.status as 'running' } };
        }
        const run: BrainstormRun = {
          runId: input.runId || context.mint('run'),
          operationId: input.operationId,
          agentIdentity,
          modelIdentity: input.modelIdentity ?? null,
          contractRevision: input.contractRevision,
          inputRefs: validateEvidenceRefs(input.inputRefs ?? [], 'inputRefs'),
          inputEnvironmentIds: (input.inputEnvironmentIds ?? []).map((entry, index) => {
            if (typeof entry !== 'string' || entry.trim().length === 0) fail('INVALID_INPUT', `inputEnvironmentIds[${index}] must be an observation id`);
            return entry;
          }),
          inputNotes: optionalText(input.inputNotes, 'inputNotes', 2000),
          status: 'running',
          ideaIds: [], itemErrors: [], duplicates: [], emptyResultReason: null, error: null,
          startedAt: now, finishedAt: null,
        };
        research.brainstormRuns.push(run);
        research.updatedAt = now;
        return { changed: true, result: { researchId: research.researchId, runId: run.runId, status: 'running' as const } };
      },
    });
  }

  /** Trusted run-lifecycle marking (cancel / interrupt / model failure bookkeeping by BE-03). */
  setBrainstormRunStatus(input: SetRunStatusInput): MutationResult<{ researchId: string; runId: string; status: BrainstormRun['status'] }> {    const requestPayload = { op: 'set_brainstorm_run_status', researchId: input.researchId, runId: input.runId, status: input.status };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'set_run_status',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const run = research.brainstormRuns.find((entry) => entry.runId === input.runId);
        if (run === undefined) fail('NOT_FOUND', `brainstorm run ${input.runId} does not exist in research ${research.researchId}`);
        if (run.status === 'completed' || run.status === 'partial' || run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted') {
          fail('REVISION_CONFLICT', `run ${run.runId} already finished as ${run.status}; finished runs are never re-marked`);
        }
        run.status = input.status;
        if (input.error != null) run.error = { code: nonEmpty(input.error.code, 'error.code', 100), message: nonEmpty(input.error.message, 'error.message', 2000) };
        run.finishedAt = context.now();
        research.updatedAt = run.finishedAt;
        return { changed: true, result: { researchId: research.researchId, runId: run.runId, status: run.status } };
      },
    });
  }

  // ------------------------------------------------------------------ internals

  private applyContractPatch(contract: ResearchContract, patch: ContractPatchInput, origin: SaveContractInput['origin'], now: string): void {
    if (patch.researchQuestion !== undefined) contract.researchQuestion = optionalText(patch.researchQuestion, 'patch.researchQuestion', TEXT_MAX.question);
    if (patch.goal !== undefined) contract.goal = optionalText(patch.goal, 'patch.goal', TEXT_MAX.question);
    if (patch.dataDescription !== undefined) contract.dataDescription = optionalText(patch.dataDescription, 'patch.dataDescription', TEXT_MAX.body);
    if (patch.computeBudget !== undefined) contract.computeBudget = optionalText(patch.computeBudget, 'patch.computeBudget', 1000);
    if (patch.timeBudget !== undefined) contract.timeBudget = optionalText(patch.timeBudget, 'patch.timeBudget', 1000);
    for (const field of ['metrics', 'guardrails', 'editableScope', 'lockedScope'] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      if (!Array.isArray(value)) fail('INVALID_INPUT', `patch.${field} must be an array`);
      contract[field] = value.map((entry, index) => nonEmpty(entry, `patch.${field}[${index}]`, TEXT_MAX.listEntry));
    }
    if (patch.baseline !== undefined) {
      const baseline = patch.baseline;
      if (contract.baseline.status === 'confirmed' && origin.kind !== 'user_action') {
        fail('POLICY_DENIED', 'the baseline was confirmed by the user; a tool/model request cannot change it — proposed changes go through the user’s native action');
      }
      if (baseline.status !== 'proposed' && baseline.status !== 'undecided') {
        fail('POLICY_DENIED', "a tool/model request may only propose or reset a baseline; confirming it is a user action (trusted confirmBaseline)");
      }
      contract.baseline.status = baseline.status;
      if (baseline.name !== undefined) contract.baseline.name = optionalText(baseline.name, 'patch.baseline.name', TEXT_MAX.listEntry);
      if (baseline.repoLocator !== undefined) {
        contract.baseline.repoLocator = baseline.repoLocator === null ? null : requireLocator(baseline.repoLocator, 'patch.baseline.repoLocator');
      }
      if (baseline.paperRef !== undefined) {
        contract.baseline.paperRef = baseline.paperRef === null ? null : this.requireCurrentEvidence(baseline.paperRef, 'patch.baseline.paperRef');
      }
    }
    if (patch.pendingQuestions !== undefined) {
      if (!Array.isArray(patch.pendingQuestions)) fail('INVALID_INPUT', 'patch.pendingQuestions must be an array');
      contract.pendingQuestions = patch.pendingQuestions.map((entry, index) => {
        const questionId = entry.questionId === undefined ? mintBootstrapId('q') : entry.questionId;
        const status = entry.status ?? 'open';
        if (origin.kind !== 'user_action' && status !== 'open') {
          fail('POLICY_DENIED', 'a tool/model request may only OPEN pending questions; answers arrive through the trusted Ask/action boundary');
        }
        if (origin.kind !== 'user_action' && (entry.answer !== undefined || entry.answeredBy !== undefined)) {
          fail('POLICY_DENIED', 'a tool/model request cannot record answers or answerers; answers come from real user input');
        }
        const question: PendingQuestion = {
          questionId,
          field: nonEmpty(entry.field, `patch.pendingQuestions[${index}].field`, 100),
          question: nonEmpty(entry.question, `patch.pendingQuestions[${index}].question`, TEXT_MAX.question),
          status,
          answer: optionalText(entry.answer, `patch.pendingQuestions[${index}].answer`, TEXT_MAX.question),
          answeredAt: status === 'open' ? null : now,
          answeredBy: optionalText(entry.answeredBy, `patch.pendingQuestions[${index}].answeredBy`, 200),
        };
        return question;
      });
    }
  }

  private requireCurrentEvidence(ref: EvidenceRef, label: string): EvidenceRef {
    const assessment = assessEvidenceRef(ref, this.deps.resolver);
    if (assessment.status !== 'current') {
      fail(assessment.status === 'missing' ? 'SOURCE_MISSING' : 'SOURCE_STALE', `${label} does not resolve: ${assessment.detail}`);
    }
    return ref;
  }
}

function requireLocator(value: unknown, label: string): string {
  const text = nonEmpty(value, label, 500);
  if (/^([A-Za-z]:|\\\\|\/)/.test(text) || text.includes('..') || text.includes('\0')) {
    fail('INVALID_INPUT', `${label} must be a workspace-relative locator without traversal or absolute path`);
  }
  return text;
}
