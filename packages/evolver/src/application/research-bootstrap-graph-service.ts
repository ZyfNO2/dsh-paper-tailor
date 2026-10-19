/**
 * Research Bootstrap graph service: research DAG, Slots, candidate mappings and scheme snapshots.
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-02-GRAPH-SPEC-2026-10-10.md §3–§6,
 * shared SPEC §5. All persistence goes through the one BE-02 store (`mutate`) — this service owns
 * no storage of its own and never writes outside the bootstrap state file.
 *
 * Rules implemented here that the tools/UI rely on:
 * - Skeleton: goal → protocol → baseline → selected hypotheses (depends_on edges point from the
 *   dependent to its prerequisite). No experiment pipeline nodes, no runner configs, no results.
 * - `initSignature` covers the semantic inputs (contract content, selected idea content versions,
 *   baseline identity, slot/candidate drafts). The same signature returns the existing graph
 *   unchanged even under a new operationId; only layout/display text may differ.
 * - Re-initialization with changed inputs MERGES: user-confirmed nodes, locked slots, existing
 *   snapshots and previously-selected-but-now-unselected idea nodes are preserved and flagged;
 *   structural conflicts that cannot be merged safely are reported (MERGE_CONFLICT), never
 *   resolved by wiping.
 * - Idea selection is only trusted when it was recorded by a real native action
 *   (`selectionProof`); the model-supplied `selectedIdeaIds` must be a subset of that proof.
 * - Locks are service-level: every binding entry (initialize, candidate mapping, component
 *   binding) checks `slot.locked`; only the trusted `setSlotLocked` (real user action) can change
 *   a lock. A model boolean can never unlock anything.
 * - Binding a component creates a NEW snapshot on that node only; sibling and frozen child
 *   snapshots never move. When the baseline node's scheme advances, hypothesis nodes whose
 *   snapshot parent is older are flagged `parent_baseline_updated` (shown for review, never
 *   silently rebuilt).
 */

import {
  BOOTSTRAP_BOUNDS,
  BootstrapError,
  type BootstrapErrorCode,
  bootstrapContentHash,
  componentEntryContentHash,
  assessEvidenceRef,
  contractSemanticHash,
  mintBootstrapId,
  validateResearchGraph,
  validateSlotBindingRef,
  type BootstrapSourceResolver,
  type ContractBaseline,
  type EvidenceRef,
  type GraphNode,
  type IdeaRef,
  type ResearchContract,
  type ResearchGraph,
  type ResearchIdea,
  type Slot,
  type SlotBindingRef,
  type SlotCandidate,
  type SlotSnapshot,
} from '../contracts/research-bootstrap.ts';
import {
  findResearch,
  requireResearch,
  type MutationContext,
  type MutationOutcome,
  type MutationResult,
  type ResearchBootstrapStore,
} from './research-bootstrap-store.ts';

const UNIVERSAL_SLOT_ROLES: ReadonlyArray<{ name: string; role: string }> = Object.freeze([
  { name: 'Problem', role: '要解决的研究问题（通用草稿位）' },
  { name: 'Baseline', role: '作为对照的基线方法（通用草稿位）' },
  { name: 'Variable', role: '本研究所改变的核心变量（通用草稿位）' },
  { name: 'Procedure', role: '整体执行流程（通用草稿位）' },
  { name: 'Measurement', role: '度量与记录方式（通用草稿位）' },
  { name: 'Evaluation', role: '评价与比较方式（通用草稿位）' },
  { name: 'Constraints', role: '约束与禁区（通用草稿位）' },
]);

export interface SlotDraftInput {
  name: string;
  role?: string | null;
  /** Required for domain slots: the confirmed baseline / repo / paper basis. */
  basis: string;
  inputs?: string | null;
  outputs?: string | null;
  constraints?: string[];
}

export interface CandidateDraftInput {
  slotName: string;
  ref: SlotBindingRef;
  assessment: 'proposed' | 'needs_review' | 'incompatible';
  reason: string;
  evidenceRefs?: EvidenceRef[];
  missingInterface?: string | null;
  recommendedBy?: string | null;
}

export interface InitializeGraphInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  contractRevision: number;
  /** Must be a subset of the trusted selection proof; omit to use all recorded selections. */
  selectedIdeaIds?: string[];
  slotDrafts?: SlotDraftInput[];
  candidateDrafts?: CandidateDraftInput[];
}

export interface MapSlotCandidatesInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  nodeId: string;
  slotId: string;
  candidates: CandidateDraftInput[];
}

export interface SetSlotComponentInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  nodeId: string;
  slotId: string;
  ref: SlotBindingRef;
}

/** Actor data for trusted service methods; BE-03 passes it from the real native action boundary. */
export interface TrustedActor {
  identity: string;
  actionId: string;
}

export interface SelectIdeasInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  ideaIds: string[];
  actor: TrustedActor;
}

export interface SetActiveResearchInput {
  researchId: string | null;
  baseRevision: number;
  operationId: string;
  actor: TrustedActor;
}

export interface SetSlotLockedInput {
  researchId: string;
  baseRevision: number;
  operationId: string;
  slotId: string;
  locked: boolean;
  actor: TrustedActor;
}

export interface InitializeGraphResult {
  researchId: string;
  graphId: string;
  /** true = same initSignature, existing graph returned unchanged (no revision consumed). */
  reused: boolean;
  selectedIdeaRefs: IdeaRef[];
  nodeIds: { goal: string; protocol: string; baseline: string; hypotheses: string[] };
  slotIds: string[];
  /** Per-item problems with submitted drafts; valid items are still saved (partial allowed). */
  itemErrors: Array<{ label: string; code: string; message: string }>;
}

export interface MapSlotCandidatesResult {
  researchId: string;
  nodeId: string;
  slotId: string;
  savedCandidates: number;
  itemErrors: Array<{ label: string; code: string; message: string }>;
}

export interface SetSlotComponentResult {
  researchId: string;
  nodeId: string;
  slotId: string;
  snapshot: SlotSnapshot;
  flaggedNodes: string[];
}

const CANDIDATE_TEXT_MAX = 4000;

function fail(code: BootstrapErrorCode, detail: string): never {
  throw new BootstrapError(code, detail);
}

/** Resolves one submitted binding ref against the live library/ideas; the gate for every binding. */
function resolveBindingRef(
  ref: SlotBindingRef,
  resolver: BootstrapSourceResolver,
  ideas: ResearchIdea[]
): { ok: true } | { ok: false; code: 'SOURCE_MISSING' | 'SOURCE_STALE'; message: string } {
  if (ref.kind === 'design_idea') {
    const idea = ideas.find((entry) => entry.ideaId === ref.ideaId);
    if (idea === undefined) return { ok: false, code: 'SOURCE_MISSING', message: `design idea ${ref.ideaId} does not exist in this research` };
    if (idea.revision !== ref.contentRevision || idea.contentHash !== ref.contentHash) {
      return { ok: false, code: 'SOURCE_STALE', message: `design idea ${ref.ideaId} is now at content revision ${idea.revision}; the submitted version ${ref.contentRevision} is stale` };
    }
    return { ok: true };
  }
  const paper = resolver.getPaper(ref.paperId);
  if (paper === null) return { ok: false, code: 'SOURCE_MISSING', message: `paper ${ref.paperId} is not in this workspace's library` };
  if (paper.sourceSha256 !== ref.sourceSha256) {
    return { ok: false, code: 'SOURCE_MISSING', message: `paper ${ref.paperId} carries a different source now; the referenced component is not bindable` };
  }
  const component = paper.components !== null ? paper.components[ref.componentIndex] : undefined;
  if (component === undefined) {
    return { ok: false, code: 'SOURCE_STALE', message: `component index ${ref.componentIndex} no longer exists in paper ${ref.paperId} (${paper.components?.length ?? 0} components)` };
  }
  const currentHash = componentEntryContentHash(component);
  if (currentHash !== ref.contentHash) {
    const moved = paper.components!.findIndex((entry) => componentEntryContentHash(entry) === ref.contentHash);
    if (moved >= 0) {
      return { ok: false, code: 'SOURCE_STALE', message: `the referenced component moved to index ${moved} in paper ${ref.paperId}; re-submit with the current index` };
    }
    return { ok: false, code: 'SOURCE_STALE', message: `component content changed in paper ${ref.paperId}; re-read and re-submit the current component` };
  }
  if (component.name !== ref.name || component.kind !== ref.componentKind) {
    return { ok: false, code: 'SOURCE_STALE', message: `component ${ref.componentIndex} in paper ${ref.paperId} changed its name/kind; re-read before binding` };
  }
  return { ok: true };
}

function bindingRefIdentity(ref: SlotBindingRef): string {
  return ref.kind === 'design_idea' ? `design_idea:${ref.ideaId}@${ref.contentRevision}:${ref.contentHash}` : `paper_component:${ref.paperId}:${ref.componentIndex}@${ref.contentHash}`;
}

function validateSlotDraft(draft: SlotDraftInput, index: number): SlotDraftInput {
  if (typeof draft !== 'object' || draft === null) fail('INVALID_INPUT', `slotDrafts[${index}] must be an object`);
  const name = typeof draft.name === 'string' && draft.name.trim().length > 0 && draft.name.length <= 200
    ? draft.name
    : fail('INVALID_INPUT', `slotDrafts[${index}].name must be non-empty text of at most 200 characters`);
  if (typeof draft.basis !== 'string' || draft.basis.trim().length === 0 || draft.basis.length > CANDIDATE_TEXT_MAX) {
    fail('INVALID_INPUT', `slotDrafts[${index}].basis is required for a domain slot: name it to the confirmed baseline, repo or paper evidence`);
  }
  return {
    name,
    role: draft.role ?? null,
    basis: draft.basis,
    inputs: draft.inputs ?? null,
    outputs: draft.outputs ?? null,
    constraints: Array.isArray(draft.constraints) ? draft.constraints.map((entry, i) => {
      if (typeof entry !== 'string' || entry.length > 300) fail('INVALID_INPUT', `slotDrafts[${index}].constraints[${i}] must be text of at most 300 characters`);
      return entry;
    }) : [],
  };
}

function validateCandidateDraft(draft: CandidateDraftInput, index: number): CandidateDraftInput {
  if (typeof draft !== 'object' || draft === null) fail('INVALID_INPUT', `candidateDrafts[${index}] must be an object`);
  if (typeof draft.slotName !== 'string' || draft.slotName.trim().length === 0 || draft.slotName.length > 200) {
    fail('INVALID_INPUT', `candidateDrafts[${index}].slotName must name an existing slot`);
  }
  if (draft.assessment !== 'proposed' && draft.assessment !== 'needs_review' && draft.assessment !== 'incompatible') {
    fail('INVALID_INPUT', `candidateDrafts[${index}].assessment must be proposed | needs_review | incompatible`);
  }
  if (typeof draft.reason !== 'string' || draft.reason.trim().length === 0 || draft.reason.length > CANDIDATE_TEXT_MAX) {
    fail('INVALID_INPUT', `candidateDrafts[${index}].reason is required: why this candidate, from what evidence`);
  }
  if (draft.ref === undefined || typeof draft.ref !== 'object' || draft.ref === null) {
    fail('INVALID_INPUT', `candidateDrafts[${index}].ref must be a paper_component or design_idea reference`);
  }
  return {
    slotName: draft.slotName,
    ref: validateSlotBindingRef(draft.ref, `candidateDrafts[${index}].ref`),
    assessment: draft.assessment,
    reason: draft.reason,
    evidenceRefs: Array.isArray(draft.evidenceRefs) ? draft.evidenceRefs : [],
    missingInterface: draft.missingInterface ?? null,
    recommendedBy: draft.recommendedBy ?? null,
  };
}

export class ResearchBootstrapGraphService {
  private readonly store: ResearchBootstrapStore;
  private readonly deps: { resolver: BootstrapSourceResolver };

  constructor(store: ResearchBootstrapStore, deps: { resolver: BootstrapSourceResolver }) {
    this.store = store;
    this.deps = deps;
  }

  // ------------------------------------------------------------------ read projection

  /** Read-only bootstrap projection (receipts stay operational; the tool output omits them). */
  getBootstrap(researchId?: string | null): {
    schemaVersion: 1;
    revision: number;
    activeResearchId: string | null;
    researches: unknown[];
  } {
    const state = this.store.readStateOrEmpty();
    const researches = researchId == null
      ? state.researches
      : (() => {
          const found = findResearch(state, researchId);
          if (found === undefined) throw new BootstrapError('NOT_FOUND', `no research "${researchId}" in this workspace`);
          return [found];
        })();
    return { schemaVersion: 1, revision: state.revision, activeResearchId: state.activeResearchId, researches };
  }

  /** Entry-level evidence assessment for one research (BE-03 adapter / UI detail views). */
  assessResearchEvidence(researchId: string): Array<{ ref: EvidenceRef; where: string; status: string; detail: string | null }> {
    const state = this.store.readStateOrEmpty();
    const research = requireResearch(state, researchId);
    const findings: Array<{ ref: EvidenceRef; where: string; status: string; detail: string | null }> = [];
    const push = (ref: EvidenceRef, where: string) => {
      const assessment = assessEvidenceRef(ref, this.deps.resolver);
      findings.push({ ref, where, status: assessment.status, detail: assessment.detail });
    };
    research.ideas.forEach((idea) => idea.evidenceRefs.forEach((ref) => push(ref, `idea:${idea.ideaId}@${idea.revision}`)));
    if (research.graph !== null) {
      if (research.contract.baseline.paperRef !== null) push(research.contract.baseline.paperRef, 'contract.baseline');
      research.graph.nodes.forEach((node) => node.evidenceRefs.forEach((ref) => push(ref, `node:${node.nodeId}`)));
      research.graph.slots.forEach((slot) => slot.candidates.forEach((candidate, index) => candidate.evidenceRefs.forEach((ref) => push(ref, `slot:${slot.slotId}.candidate:${index}`))));
    }
    return findings;
  }

  // ------------------------------------------------------------------ initialize / merge

  initializeGraph(input: InitializeGraphInput): MutationResult<InitializeGraphResult> {
    const slotDrafts = (input.slotDrafts ?? []).map(validateSlotDraft);
    const candidateDrafts = (input.candidateDrafts ?? []).map(validateCandidateDraft);
    if (slotDrafts.length > BOOTSTRAP_BOUNDS.maxSlots) fail('INVALID_INPUT', `at most ${BOOTSTRAP_BOUNDS.maxSlots} slot drafts`);
    const requestPayload = {
      op: 'initialize_graph',
      researchId: input.researchId,
      contractRevision: input.contractRevision,
      selectedIdeaIds: [...(input.selectedIdeaIds ?? [])].sort(),
      slotDrafts,
      candidateDrafts,
    };
    return this.store.mutate<InitializeGraphResult>({
      operationId: input.operationId,
      kind: 'initialize_graph',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => this.applyInitialize(context, input, slotDrafts, candidateDrafts),
    });
  }

  private applyInitialize(
    context: MutationContext,
    input: InitializeGraphInput,
    slotDrafts: SlotDraftInput[],
    candidateDrafts: CandidateDraftInput[]
  ): MutationOutcome<InitializeGraphResult> {
    const research = requireResearch(context.state, input.researchId);
    const now = context.now();
    if (research.contract.revision !== input.contractRevision) {
      fail('CONTRACT_REVISION_MISMATCH', `research contract is at revision ${research.contract.revision}, the request used ${input.contractRevision}; re-read evolver_get_research_bootstrap and retry`);
    }
    // The model may only name ideas the user really selected through a native action.
    const proof = research.selectionProof;
    const requestedIds = [...new Set(input.selectedIdeaIds ?? proof?.ideaIds ?? [])];
    if (proof === null) {
      if (requestedIds.length > 0) {
        fail('USER_SELECTION_MISMATCH', 'no user selection of ideas was recorded for this research; ask the user to select directions in the UI (native action) first');
      }
    } else {
      const allowed = new Set(proof.ideaIds);
      const extra = requestedIds.filter((ideaId) => !allowed.has(ideaId));
      if (extra.length > 0) {
        fail('USER_SELECTION_MISMATCH', `idea(s) ${extra.join(', ')} are not part of the user's recorded selection (${proof.actionId}); remove them or ask the user to select again`);
      }
    }
    const selectedIdeas = requestedIds
      .map((ideaId) => research.ideas.find((idea) => idea.ideaId === ideaId))
      .filter((idea): idea is ResearchIdea => idea !== undefined);
    const selectedRefs: IdeaRef[] = selectedIdeas.map((idea) => ({ ideaId: idea.ideaId, contentRevision: idea.revision, contentHash: idea.contentHash }));
    const selectionProof = proof === null ? null : { actionId: proof.actionId, actorIdentity: proof.actorIdentity, at: proof.at };
    const baseline = research.contract.baseline;
    this.assertDomainSlotsAllowed(baseline, slotDrafts);

    const signature = bootstrapContentHash('research-bootstrap-init-v1', {
      researchId: research.researchId,
      contractSemanticHash: contractSemanticHash(research.contract),
      selectedIdeaRefs: [...selectedRefs].sort((a, b) => a.ideaId.localeCompare(b.ideaId)),
      baseline: { status: baseline.status, name: baseline.name, paperHash: baseline.paperRef?.contentHash ?? null, repoLocator: baseline.repoLocator },
      slotDrafts,
      candidateDrafts,
    });

    if (research.graph !== null && research.graph.initSignature === signature) {
      // Same semantic inputs: reuse the existing skeleton; no revision, no duplicate objects.
      const graph = research.graph;
      return {
        changed: false,
        result: {
          researchId: research.researchId,
          graphId: graph.graphId,
          reused: true,
          selectedIdeaRefs: graph.selectedIdeaRefs,
          nodeIds: summarizeNodeIds(graph),
          slotIds: graph.slots.map((slot) => slot.slotId),
          itemErrors: [],
        },
      };
    }

    const itemErrors: InitializeGraphResult['itemErrors'] = [];
    if (research.graph === null) {
      const graph = this.buildFreshGraph({ research, now, mint: context.mint, signature, selectedIdeas, selectedRefs, selectionProof, slotDrafts, candidateDrafts, itemErrors });
      research.graph = graph;
      research.updatedAt = now;
      return {
        changed: true,
        result: {
          researchId: research.researchId, graphId: graph.graphId, reused: false,
          selectedIdeaRefs: graph.selectedIdeaRefs, nodeIds: summarizeNodeIds(graph),
          slotIds: graph.slots.map((slot) => slot.slotId), itemErrors,
        },
      };
    }
    const merged = this.mergeGraph({ research, now, signature, selectedIdeas, selectedRefs, selectionProof, slotDrafts, candidateDrafts, itemErrors });
    research.graph = merged;
    research.updatedAt = now;
    return {
      changed: true,
      result: {
        researchId: research.researchId, graphId: merged.graphId, reused: false,
        selectedIdeaRefs: merged.selectedIdeaRefs, nodeIds: summarizeNodeIds(merged),
        slotIds: merged.slots.map((slot) => slot.slotId), itemErrors,
      },
    };
  }

  private assertDomainSlotsAllowed(baseline: ContractBaseline, slotDrafts: SlotDraftInput[]): void {
    if (slotDrafts.length > 0 && !this.baselineSupportsPlanning(baseline)) {
      fail('DOMAIN_SLOT_REQUIRES_BASELINE', `domain slot drafts need a named baseline with current source evidence or a user-selected baseline (current: ${baseline.status}); unknown baselines still allow the universal planning skeleton`);
    }
  }

  private baselineSupportsPlanning(baseline: ContractBaseline): boolean {
    if (baseline.status === 'confirmed') return true;
    return baseline.status === 'proposed' && baseline.name !== null && baseline.paperRef !== null
      && assessEvidenceRef(baseline.paperRef, this.deps.resolver).status === 'current';
  }

  private buildFreshGraph(args: {
    research: ResearchBootstrapContractView;
    now: string;
    mint: (prefix: string) => string;
    signature: string;
    selectedIdeas: ResearchIdea[];
    selectedRefs: IdeaRef[];
    selectionProof: ResearchGraph['selectionProof'];
    slotDrafts: SlotDraftInput[];
    candidateDrafts: CandidateDraftInput[];
    itemErrors: InitializeGraphResult['itemErrors'];
  }): ResearchGraph {
    const { research, now, mint } = args;
    const contract = research.contract;
    const nodes: GraphNode[] = [];
    const edges: ResearchGraph['edges'] = [];
    const goal: GraphNode = {
      nodeId: mint('node'), kind: 'goal',
      title: contract.goal ?? '研究目标（未填写）',
      planningStatus: contract.goal === null ? 'needs_confirmation' : 'draft',
      ideaRef: null, evidenceRefs: [], note: contract.goal === null ? 'Contract 尚无一句研究目标；请先补齐。' : null,
      snapshotRef: null, reviewFlags: [],
    };
    const protocol: GraphNode = {
      nodeId: mint('node'), kind: 'protocol', title: '实验协议（草稿）', planningStatus: 'draft',
      ideaRef: null, evidenceRefs: [],
      note: contract.dataDescription === null ? '数据与指标未知，保留待确认。' : null,
      snapshotRef: null, reviewFlags: [],
    };
    const baselineTitle = contract.baseline.name ?? (contract.baseline.status === 'confirmed' ? 'Baseline' : 'Baseline（未定）');
    const baselineNode: GraphNode = {
      nodeId: mint('node'), kind: 'baseline', title: baselineTitle,
      planningStatus: contract.baseline.status === 'confirmed' ? 'draft' : this.baselineSupportsPlanning(contract.baseline) ? 'needs_validation' : 'needs_confirmation',
      ideaRef: null,
      evidenceRefs: contract.baseline.paperRef ? [contract.baseline.paperRef] : [],
      note: contract.baseline.status !== 'confirmed' ? this.baselineSupportsPlanning(contract.baseline) ? '基线有当前来源依据，可继续规划；本地复现与实验效果尚未验证。' : '基线来源尚未确定，保留通用规划骨架。' : null,
      snapshotRef: null, reviewFlags: [],
    };
    nodes.push(goal, protocol, baselineNode);
    edges.push(
      { edgeId: mint('edge'), from: protocol.nodeId, to: goal.nodeId, relation: 'depends_on' },
      { edgeId: mint('edge'), from: baselineNode.nodeId, to: protocol.nodeId, relation: 'depends_on' },
    );
    // Universal draft slots always exist so the UI has stable positions to discuss.
    const slots: Slot[] = UNIVERSAL_SLOT_ROLES.map((entry) => ({
      slotId: mint('slot'), name: entry.name, role: entry.role, scope: 'universal', basis: null,
      inputs: null, outputs: null, constraints: [], locked: false, lockedBy: null,
      status: 'draft', currentRef: null, candidates: [],
    }));
    for (const draft of args.slotDrafts) {
      if (slots.length >= BOOTSTRAP_BOUNDS.maxSlots) fail('SCHEMA_VIOLATION', 'slot bound reached');
      slots.push({
        slotId: mint('slot'), name: draft.name, role: draft.role ?? null, scope: 'domain', basis: draft.basis,
        inputs: draft.inputs ?? null, outputs: draft.outputs ?? null, constraints: draft.constraints ?? [],
        locked: false, lockedBy: null, status: 'needs_confirmation', currentRef: null, candidates: [],
      });
    }
    // Baseline scheme snapshot: the frozen parent every hypothesis snapshot inherits from.
    const baselineSnapshot: SlotSnapshot = {
      snapshotId: mint('snapshot'), nodeId: baselineNode.nodeId, revision: 1, parentSnapshotRef: null,
      bindings: {}, delta: { fromSnapshotRef: null, changes: [] }, note: '初始方案快照（空绑定）', createdAt: now,
    };
    baselineNode.snapshotRef = baselineSnapshot.snapshotId;
    const snapshots: SlotSnapshot[] = [baselineSnapshot];
    for (const idea of args.selectedIdeas) {
      const node: GraphNode = {
        nodeId: mint('node'), kind: 'hypothesis', title: idea.title, planningStatus: 'draft',
        ideaRef: { ideaId: idea.ideaId, contentRevision: idea.revision, contentHash: idea.contentHash },
        evidenceRefs: [], note: null, snapshotRef: null, reviewFlags: [],
      };
      nodes.push(node);
      edges.push({ edgeId: mint('edge'), from: node.nodeId, to: baselineNode.nodeId, relation: 'depends_on' });
      const snapshot: SlotSnapshot = {
        snapshotId: mint('snapshot'), nodeId: node.nodeId, revision: 1, parentSnapshotRef: baselineSnapshot.snapshotId,
        bindings: { ...baselineSnapshot.bindings }, delta: { fromSnapshotRef: baselineSnapshot.snapshotId, changes: [] },
        note: null, createdAt: now,
      };
      node.snapshotRef = snapshot.snapshotId;
      snapshots.push(snapshot);
    }
    const graph: ResearchGraph = {
      graphId: mint('graph'), nodes, edges, slots, snapshots,
      initSignature: args.signature,
      contractRevision: contract.revision,
      selectedIdeaRefs: args.selectedRefs, selectionProof: args.selectionProof,
      evidenceRefs: contract.baseline.paperRef ? [contract.baseline.paperRef] : [],
      baselineConfirmed: contract.baseline.status === 'confirmed',
      reviewNotes: args.selectedIdeas.length === 0 ? ['未选择任何研究分支；仅保存 goal/protocol/baseline 骨架。'] : [],
      createdAt: now, updatedAt: now,
    };
    this.applyCandidateDrafts({ graph, ideas: research.ideas, candidateDrafts: args.candidateDrafts, itemErrors: args.itemErrors });
    validateResearchGraph(graph);
    return graph;
  }

  private mergeGraph(args: {
    research: ResearchBootstrapContractView;
    now: string;
    signature: string;
    selectedIdeas: ResearchIdea[];
    selectedRefs: IdeaRef[];
    selectionProof: ResearchGraph['selectionProof'];
    slotDrafts: SlotDraftInput[];
    candidateDrafts: CandidateDraftInput[];
    itemErrors: InitializeGraphResult['itemErrors'];
  }): ResearchGraph {
    const { research, now } = args;
    const existing = research.graph!;
    const contract = research.contract;
    // Structural conflict: a changed baseline together with user-confirmed structure or locks
    // cannot be merged silently — the user must choose the update scope.
    const baselineName = contract.baseline.name;
    const baselineChanged = baselineName !== null && existing.nodes.some((node) => node.kind === 'baseline' && node.title !== baselineName);
    const protectedByUser = existing.slots.some((slot) => slot.locked) || existing.nodes.some((node) => node.planningStatus === 'confirmed');
    if (baselineChanged && protectedByUser) {
      const locked = existing.slots.filter((slot) => slot.locked).map((slot) => slot.slotId);
      const confirmed = existing.nodes.filter((node) => node.planningStatus === 'confirmed').map((node) => node.nodeId);
      fail('MERGE_CONFLICT', `the baseline changed to "${baselineName}" but the graph holds user-confirmed structure; unlock/confirm scope first (locked slots: ${locked.join(', ') || 'none'}; confirmed nodes: ${confirmed.join(', ') || 'none'})`);
    }
    const graph: ResearchGraph = structuredClone(existing);
    graph.reviewNotes = [...graph.reviewNotes, `re-initialized and merged at ${now}`].slice(-50);
    graph.contractRevision = contract.revision;
    graph.baselineConfirmed = contract.baseline.status === 'confirmed';
    graph.selectionProof = args.selectionProof;
    graph.selectedIdeaRefs = args.selectedRefs;
    graph.evidenceRefs = contract.baseline.paperRef ? [contract.baseline.paperRef] : graph.evidenceRefs;

    const byKind = (kind: GraphNode['kind']) => graph.nodes.find((node) => node.kind === kind);
    for (const kind of ['goal', 'protocol', 'baseline'] as const) {
      const node = byKind(kind);
      if (node === undefined) continue;
      if (node.planningStatus === 'confirmed') continue; // user-confirmed nodes are never rewritten
      if (kind === 'goal') {
        if (contract.goal !== null) node.title = contract.goal;
        else node.planningStatus = 'needs_confirmation';
      }
      if (kind === 'baseline') {
        if (contract.baseline.name !== null) node.title = contract.baseline.name;
        node.evidenceRefs = contract.baseline.paperRef ? [contract.baseline.paperRef] : node.evidenceRefs;
        if (contract.baseline.status !== 'confirmed') node.planningStatus = this.baselineSupportsPlanning(contract.baseline) ? 'needs_validation' : 'needs_confirmation';
      }
    }
    // Hypothesis nodes: append new selections, keep and flag everything not re-selected.
    const selectedIds = new Set(args.selectedRefs.map((ref) => ref.ideaId));
    const baselineNode = byKind('baseline')!;
    for (const idea of args.selectedIdeas) {
      const existingNode = graph.nodes.find((entry) => entry.kind === 'hypothesis' && entry.ideaRef?.ideaId === idea.ideaId);
      if (existingNode !== undefined) {
        if (existingNode.planningStatus !== 'confirmed' && (existingNode.ideaRef!.contentRevision !== idea.revision || existingNode.ideaRef!.contentHash !== idea.contentHash)) {
          existingNode.ideaRef = { ideaId: idea.ideaId, contentRevision: idea.revision, contentHash: idea.contentHash };
          existingNode.title = idea.title;
          if (!existingNode.reviewFlags.includes('idea_updated')) existingNode.reviewFlags.push('idea_updated');
        }
        continue;
      }
      if (graph.nodes.length >= BOOTSTRAP_BOUNDS.maxNodes) fail('SCHEMA_VIOLATION', `node bound (${BOOTSTRAP_BOUNDS.maxNodes}) reached; unselect ideas or start a new research`);
      const node: GraphNode = {
        nodeId: mintIdInGraph(graph, 'node'), kind: 'hypothesis', title: idea.title, planningStatus: 'draft',
        ideaRef: { ideaId: idea.ideaId, contentRevision: idea.revision, contentHash: idea.contentHash },
        evidenceRefs: [], note: null, snapshotRef: null, reviewFlags: [],
      };
      graph.nodes.push(node);
      if (graph.edges.length >= BOOTSTRAP_BOUNDS.maxEdges) fail('SCHEMA_VIOLATION', 'edge bound reached');
      graph.edges.push({ edgeId: mintIdInGraph(graph, 'edge'), from: node.nodeId, to: baselineNode.nodeId, relation: 'depends_on' });
      const parent = baselineNode.snapshotRef !== null ? graph.snapshots.find((snapshot) => snapshot.snapshotId === baselineNode.snapshotRef) : undefined;
      const snapshot: SlotSnapshot = {
        snapshotId: mintIdInGraph(graph, 'snapshot'), nodeId: node.nodeId, revision: 1,
        parentSnapshotRef: parent?.snapshotId ?? null,
        bindings: parent ? { ...parent.bindings } : {},
        delta: { fromSnapshotRef: parent?.snapshotId ?? null, changes: [] }, note: null, createdAt: now,
      };
      node.snapshotRef = snapshot.snapshotId;
      graph.snapshots.push(snapshot);
    }
    for (const node of graph.nodes) {
      if (node.kind === 'hypothesis' && node.ideaRef !== null && !selectedIds.has(node.ideaRef.ideaId)) {
        if (!node.reviewFlags.includes('idea_not_reselected')) {
          node.reviewFlags.push('idea_not_reselected');
          node.note = node.note ?? '该分支未被本轮再次选中，保留为历史节点；如需删除请由用户明确操作。';
        }
      }
    }
    // Slots: preserve existing (locked/confirmed/bound/candidates), append genuinely new drafts.
    for (const draft of args.slotDrafts) {
      if (graph.slots.some((slot) => slot.scope === 'domain' && slot.name === draft.name)) continue;
      if (graph.slots.length >= BOOTSTRAP_BOUNDS.maxSlots) fail('SCHEMA_VIOLATION', 'slot bound reached');
      graph.slots.push({
        slotId: mintIdInGraph(graph, 'slot'),
        name: draft.name, role: draft.role ?? null, scope: 'domain', basis: draft.basis,
        inputs: draft.inputs ?? null, outputs: draft.outputs ?? null, constraints: draft.constraints ?? [],
        locked: false, lockedBy: null, status: 'needs_confirmation', currentRef: null, candidates: [],
      });
    }
    for (const role of UNIVERSAL_SLOT_ROLES) {
      if (!graph.slots.some((slot) => slot.scope === 'universal' && slot.name === role.name)) {
        graph.slots.push({
          slotId: mintIdInGraph(graph, 'slot'), name: role.name, role: role.role, scope: 'universal', basis: null,
          inputs: null, outputs: null, constraints: [], locked: false, lockedBy: null,
          status: 'draft', currentRef: null, candidates: [],
        });
      }
    }
    graph.updatedAt = now;
    graph.initSignature = args.signature;
    this.applyCandidateDrafts({ graph, ideas: research.ideas, candidateDrafts: args.candidateDrafts, itemErrors: args.itemErrors });
    validateResearchGraph(graph);
    return graph;
  }

  /** Saves recommendation drafts onto their slots; never touches bindings or locked anything. */
  private applyCandidateDrafts(args: {
    graph: ResearchGraph;
    ideas: ResearchIdea[];
    candidateDrafts: CandidateDraftInput[];
    itemErrors: Array<{ label: string; code: string; message: string }>;
  }): void {
    const { graph, itemErrors } = args;
    for (const [index, draft] of args.candidateDrafts.entries()) {
      const label = `candidateDrafts[${index}](${draft.slotName})`;
      const slot = graph.slots.find((entry) => entry.name === draft.slotName);
      if (slot === undefined) {
        itemErrors.push({ label, code: 'NOT_FOUND', message: `no slot named "${draft.slotName}" in this graph` });
        continue;
      }
      const resolution = resolveBindingRef(draft.ref, this.deps.resolver, args.ideas);
      if (!resolution.ok) {
        itemErrors.push({ label, code: resolution.code, message: resolution.message });
        continue;
      }
      if (slot.candidates.length >= BOOTSTRAP_BOUNDS.maxCandidatesPerSlot) {
        itemErrors.push({ label, code: 'SCHEMA_VIOLATION', message: `slot "${slot.name}" reached its candidate bound` });
        continue;
      }
      slot.candidates.push({
        candidateId: mintIdInGraph(graph, 'cand'),
        ref: draft.ref,
        assessment: draft.assessment,
        reason: draft.reason,
        evidenceRefs: draft.evidenceRefs ?? [],
        missingInterface: draft.missingInterface ?? null,
        recommendedBy: draft.recommendedBy ?? null,
      });
    }
  }

  // ------------------------------------------------------------------ candidate mapping tool

  mapSlotCandidates(input: MapSlotCandidatesInput): MutationResult<MapSlotCandidatesResult> {
    const candidates = (input.candidates ?? []).map(validateCandidateDraft);
    const requestPayload = {
      op: 'map_slot_candidates',
      researchId: input.researchId,
      nodeId: input.nodeId,
      slotId: input.slotId,
      candidates,
    };
    return this.store.mutate<MapSlotCandidatesResult>({
      operationId: input.operationId,
      kind: 'map_slot_candidates',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const graph = requireGraph(research);
        const node = requireNode(graph, input.nodeId);
        const slot = requireSlot(graph, input.slotId);
        if (slot.locked) fail('SLOT_LOCKED', `slot "${slot.name}" (${slot.slotId}) is locked by ${slot.lockedBy?.actorIdentity ?? 'the user'}; unlock via the native action before re-mapping`);
        const itemErrors: MapSlotCandidatesResult['itemErrors'] = [];
        const saved: SlotCandidate[] = [];
        const seen = new Set<string>();
        for (const [index, draft] of candidates.entries()) {
          const label = `candidates[${index}]`;
          const resolution = resolveBindingRef(draft.ref, this.deps.resolver, research.ideas);
          if (!resolution.ok) {
            itemErrors.push({ label, code: resolution.code, message: resolution.message });
            continue;
          }
          const identity = bindingRefIdentity(draft.ref);
          if (seen.has(identity)) continue;
          seen.add(identity);
          saved.push({
            candidateId: context.mint('cand'),
            ref: draft.ref,
            assessment: draft.assessment,
            reason: draft.reason,
            evidenceRefs: draft.evidenceRefs ?? [],
            missingInterface: draft.missingInterface ?? null,
            recommendedBy: draft.recommendedBy ?? null,
          });
        }
        // Recommendations only: current bindings, snapshots and locks stay untouched.
        slot.candidates = saved;
        research.updatedAt = context.now();
        graph.updatedAt = context.now();
        return {
          changed: true,
          result: { researchId: research.researchId, nodeId: node.nodeId, slotId: slot.slotId, savedCandidates: saved.length, itemErrors },
        };
      },
    });
  }

  // ------------------------------------------------------------------ binding / snapshots

  setSlotComponent(input: SetSlotComponentInput): MutationResult<SetSlotComponentResult> {
    const bindingRef = validateSlotBindingRef(input.ref, 'ref');
    const requestPayload = {
      op: 'set_slot_component',
      researchId: input.researchId,
      nodeId: input.nodeId,
      slotId: input.slotId,
      ref: bindingRef,
    };
    return this.store.mutate<SetSlotComponentResult>({
      operationId: input.operationId,
      kind: 'set_slot_component',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const graph = requireGraph(research);
        const node = requireNode(graph, input.nodeId);
        const slot = requireSlot(graph, input.slotId);
        if (slot.locked) {
          fail('SLOT_LOCKED', `slot "${slot.name}" (${slot.slotId}) is locked by ${slot.lockedBy?.actorIdentity ?? 'the user'} at ${slot.lockedBy?.at ?? 'an unknown time'}; ask the user to unlock it through the native action`);
        }
        const resolution = resolveBindingRef(bindingRef, this.deps.resolver, research.ideas);
        if (!resolution.ok) fail(resolution.code, resolution.message);
        const incompatible = slot.candidates.find((candidate) => candidate.assessment === 'incompatible' && bindingRefIdentity(candidate.ref) === bindingRefIdentity(bindingRef));
        if (incompatible !== undefined) {
          fail('INCOMPATIBLE_BINDING', `this candidate was explicitly assessed incompatible and cannot be bound: ${incompatible.reason}`);
        }
        const nodeSnapshots = graph.snapshots.filter((snapshot) => snapshot.nodeId === node.nodeId).sort((a, b) => a.revision - b.revision);
        const current = nodeSnapshots.at(-1);
        if (nodeSnapshots.length >= BOOTSTRAP_BOUNDS.maxSnapshotsPerNode) {
          fail('SCHEMA_VIOLATION', `node ${node.nodeId} reached its snapshot bound (${BOOTSTRAP_BOUNDS.maxSnapshotsPerNode})`);
        }
        const now = context.now();
        // A node without any snapshot yet starts its chain from the baseline scheme (inherit, then change).
        const inherited = current !== undefined
          ? { bindings: { ...current.bindings }, parentSnapshotRef: current.parentSnapshotRef, revision: current.revision + 1, from: current.snapshotId }
          : (() => {
              const parent = baselineSnapshotIdOf(graph) !== null ? graph.snapshots.find((snapshot) => snapshot.snapshotId === baselineSnapshotIdOf(graph)) : undefined;
              return { bindings: parent ? { ...parent.bindings } : {}, parentSnapshotRef: parent?.snapshotId ?? null, revision: 1, from: null as string | null };
            })();
        const snapshot: SlotSnapshot = {
          snapshotId: context.mint('snapshot'), nodeId: node.nodeId, revision: inherited.revision,
          parentSnapshotRef: inherited.parentSnapshotRef,
          bindings: inherited.bindings,
          delta: { fromSnapshotRef: inherited.from, changes: [] },
          note: null, createdAt: now,
        };
        const from = snapshot.bindings[slot.slotId] ?? null;
        snapshot.bindings[slot.slotId] = bindingRef;
        snapshot.delta.changes = [{ slotId: slot.slotId, from, to: bindingRef }];
        graph.snapshots.push(snapshot);
        node.snapshotRef = snapshot.snapshotId;
        // The baseline scheme advanced: flag hypothesis nodes still frozen on the old parent.
        const flaggedNodes: string[] = [];
        if (node.kind === 'baseline') {
          slot.currentRef = bindingRef;
          for (const other of graph.nodes) {
            if (other.kind !== 'hypothesis' || other.snapshotRef === null) continue;
            const otherSnapshot = graph.snapshots.find((entry) => entry.snapshotId === other.snapshotRef);
            if (otherSnapshot !== undefined && otherSnapshot.parentSnapshotRef !== snapshot.snapshotId) {
              if (!other.reviewFlags.includes('parent_baseline_updated')) other.reviewFlags.push('parent_baseline_updated');
              flaggedNodes.push(other.nodeId);
            }
          }
        }
        research.updatedAt = now;
        graph.updatedAt = now;
        return {
          changed: true,
          result: { researchId: research.researchId, nodeId: node.nodeId, slotId: slot.slotId, snapshot, flaggedNodes },
        };
      },
    });
  }

  // ------------------------------------------------------------------ trusted native-action methods

  /** Records the trusted user selection; the model tool checks its list against this proof. */
  selectResearchIdeas(input: SelectIdeasInput): MutationResult<{ researchId: string; selectedIdeaIds: string[]; actionId: string }> {
    if (typeof input.actor?.actionId !== 'string' || input.actor.actionId.trim().length === 0) {
      fail('POLICY_DENIED', 'idea selection requires a real native action id from the trusted host boundary');
    }
    if (typeof input.actor?.identity !== 'string' || input.actor.identity.trim().length === 0) {
      fail('POLICY_DENIED', 'idea selection requires the real actor identity from the trusted host boundary');
    }
    const requestPayload = {
      op: 'select_research_ideas',
      researchId: input.researchId,
      ideaIds: [...input.ideaIds].sort(),
      actionId: input.actor.actionId,
    };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'select_ideas',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const unique = [...new Set(input.ideaIds)];
        for (const ideaId of unique) {
          if (research.ideas.find((idea) => idea.ideaId === ideaId) === undefined) {
            fail('NOT_FOUND', `idea ${ideaId} does not exist in research ${research.researchId}`);
          }
        }
        const previouslySelected = new Set(research.ideas.filter((idea) => idea.status === 'selected').map((idea) => idea.ideaId));
        for (const idea of research.ideas) {
          if (unique.includes(idea.ideaId)) idea.status = 'selected';
          else if (previouslySelected.has(idea.ideaId)) idea.status = 'candidate';
        }
        research.selectionProof = { actionId: input.actor.actionId, actorIdentity: input.actor.identity, at: context.now(), ideaIds: unique };
        research.updatedAt = context.now();
        return {
          changed: true,
          result: { researchId: research.researchId, selectedIdeaIds: unique, actionId: input.actor.actionId },
        };
      },
    });
  }

  /** Explicit active-research switch; never inferred from “last updated”. */
  setActiveResearch(input: SetActiveResearchInput): MutationResult<{ activeResearchId: string | null }> {
    if (typeof input.actor?.actionId !== 'string' || input.actor.actionId.trim().length === 0) {
      fail('POLICY_DENIED', 'switching the active research requires a real native action id from the trusted host boundary');
    }
    const requestPayload = {
      op: 'set_active_research',
      researchId: input.researchId,
      actionId: input.actor.actionId,
    };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'set_active_research',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        if (input.researchId !== null) requireResearch(context.state, input.researchId);
        context.state.activeResearchId = input.researchId;
        return { changed: true, result: { activeResearchId: input.researchId } };
      },
    });
  }

  /** Explicit slot lock/unlock; the only path that may change `slot.locked`. */
  setSlotLocked(input: SetSlotLockedInput): MutationResult<{ researchId: string; slotId: string; locked: boolean }> {
    if (typeof input.actor?.actionId !== 'string' || input.actor.actionId.trim().length === 0) {
      fail('POLICY_DENIED', 'locking or unlocking a slot requires a real native action id from the trusted host boundary');
    }
    const requestPayload = {
      op: 'set_slot_locked',
      researchId: input.researchId,
      slotId: input.slotId,
      locked: input.locked,
      actionId: input.actor.actionId,
    };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'set_slot_locked',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const graph = requireGraph(research);
        const slot = requireSlot(graph, input.slotId);
        if (input.locked) {
          slot.locked = true;
          slot.lockedBy = { actorIdentity: input.actor.identity, at: context.now(), source: 'user_action' };
        } else {
          slot.locked = false;
          slot.lockedBy = null;
        }
        research.updatedAt = context.now();
        graph.updatedAt = context.now();
        return { changed: true, result: { researchId: research.researchId, slotId: slot.slotId, locked: slot.locked } };
      },
    });
  }

  /**
   * Trusted node planning-status change (the UI's “user confirms this node” action). Tool paths
   * never set planning statuses, so a model cannot upgrade its own plan to confirmed.
   */
  setNodePlanningStatus(input: {
    researchId: string;
    baseRevision: number;
    operationId: string;
    nodeId: string;
    planningStatus: 'draft' | 'needs_confirmation' | 'confirmed' | 'needs_validation';
    actor: TrustedActor;
  }): MutationResult<{ researchId: string; nodeId: string; planningStatus: string }> {
    if (typeof input.actor?.actionId !== 'string' || input.actor.actionId.trim().length === 0) {
      fail('POLICY_DENIED', 'changing a node planning status requires a real native action id from the trusted host boundary');
    }
    const requestPayload = {
      op: 'set_node_planning_status',
      researchId: input.researchId,
      nodeId: input.nodeId,
      planningStatus: input.planningStatus,
      actionId: input.actor.actionId,
    };
    return this.store.mutate({
      operationId: input.operationId,
      kind: 'set_node_status',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload,
      apply: (context) => {
        const research = requireResearch(context.state, input.researchId);
        const graph = requireGraph(research);
        const node = requireNode(graph, input.nodeId);
        node.planningStatus = input.planningStatus;
        research.updatedAt = context.now();
        graph.updatedAt = context.now();
        return { changed: true, result: { researchId: research.researchId, nodeId: node.nodeId, planningStatus: node.planningStatus } };
      },
    });
  }
}

// ------------------------------------------------------------------ local helpers

/** Structural view used internally; `ResearchBootstrap` satisfies it. */
type ResearchBootstrapContractView = {
  researchId: string;
  contract: ResearchContract;
  ideas: ResearchIdea[];
  graph: ResearchGraph | null;
  selectionProof: { actionId: string; actorIdentity: string; at: string; ideaIds: string[] } | null;
  updatedAt: string;
};

function requireGraph(research: ResearchBootstrapContractView): ResearchGraph {
  if (research.graph === null) fail('NOT_FOUND', 'this research has no graph yet; run evolver_initialize_research_graph first');
  return research.graph;
}

function requireNode(graph: ResearchGraph, nodeId: string): GraphNode {
  const node = graph.nodes.find((entry) => entry.nodeId === nodeId);
  if (node === undefined) fail('NOT_FOUND', `node ${nodeId} does not exist in graph ${graph.graphId}`);
  return node;
}

function requireSlot(graph: ResearchGraph, slotId: string): Slot {
  const slot = graph.slots.find((entry) => entry.slotId === slotId);
  if (slot === undefined) fail('NOT_FOUND', `slot ${slotId} does not exist in graph ${graph.graphId}`);
  return slot;
}

function baselineSnapshotIdOf(graph: ResearchGraph): string | null {
  const baseline = graph.nodes.find((node) => node.kind === 'baseline');
  return baseline?.snapshotRef ?? null;
}

function summarizeNodeIds(graph: ResearchGraph): InitializeGraphResult['nodeIds'] {
  const goal = graph.nodes.find((node) => node.kind === 'goal');
  const protocol = graph.nodes.find((node) => node.kind === 'protocol');
  const baseline = graph.nodes.find((node) => node.kind === 'baseline');
  return {
    goal: goal?.nodeId ?? '',
    protocol: protocol?.nodeId ?? '',
    baseline: baseline?.nodeId ?? '',
    hypotheses: graph.nodes.filter((node) => node.kind === 'hypothesis').map((node) => node.nodeId),
  };
}

function mintIdInGraph(graph: ResearchGraph, prefix: string): string {
  let candidate = '';
  do {
    candidate = mintBootstrapId(prefix);
  } while (
    graph.slots.some((slot) => slot.slotId === candidate) ||
    graph.snapshots.some((snapshot) => snapshot.snapshotId === candidate) ||
    graph.slots.some((slot) => slot.candidates.some((entry) => entry.candidateId === candidate)) ||
    graph.nodes.some((node) => node.nodeId === candidate) ||
    graph.edges.some((edge) => edge.edgeId === candidate)
  );
  return candidate;
}
