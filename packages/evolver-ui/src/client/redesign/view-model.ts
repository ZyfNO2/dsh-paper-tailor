/**
 * Redesign workbench — display contract (ViewModel).
 *
 * SPEC: docs/mvp/redesign-2026-10-08/FRONTEND-SPEC.md §6.
 *
 * These types describe what the redesigned WorkbenchView RENDERS. They are not
 * backend persistence entities and not an HTTP protocol. Unknown values stay
 * `null` / `'unknown'`; the UI must never fabricate zeroes, scores or "best"
 * choices when the data is absent.
 *
 * Identity rule (SPEC §3.2/§6.1): every cross-object reference is an ObjectLink
 * carrying an opaque stable key (and revision when known). Display names are
 * never used as identity.
 */

// ---------------------------------------------------------------------------
// shared
// ---------------------------------------------------------------------------

export type WorkspaceId = 'tree' | 'brainstorm' | 'tailor' | 'papers';

/** Per-region availability. `stale` data belongs to an older revision. */
export type RegionStatus =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'stale'
  | 'blocked';

export interface RegionState {
  status: RegionStatus;
  /** Human-readable reason for empty/error/blocked/stale. */
  reason: string | null;
  /** When status is 'stale', the revision the rendered data belongs to. */
  staleRevision?: string | null;
}

export interface Region<T> {
  state: RegionState;
  data: T | null;
}

export type LinkTargetKind =
  | 'node'
  | 'component'
  | 'paper'
  | 'experiment'
  | 'contribution'
  | 'wiki'
  | 'external';

/**
 * Stable cross-object reference. `missingReason` is set when the link target is
 * known to be absent / inaccessible (broken links get an explanation, not a
 * silent no-op — SPEC §6.2 FE-A05).
 */
export interface ObjectLink {
  kind: LinkTargetKind;
  key: string;
  revision?: string | null;
  /** Optional sub-locator, e.g. contribution id inside a paper. */
  ref?: string | null;
  label: string;
  missingReason?: string | null;
}

// ---------------------------------------------------------------------------
// task / preconditions / summary
// ---------------------------------------------------------------------------

export interface TaskView {
  taskKey: string;
  displayName: string;
  researchGoal: string;
  phase: string;
  preconditions: string[];
  revision: string;
}

export interface PreconditionNote {
  id: string;
  severity: 'info' | 'warning' | 'blocked';
  text: string;
}

export interface StatCard {
  key: 'totalExperiments' | 'validResults' | 'bestScheme' | 'mainChange';
  label: string;
  /** Null = "暂无". Never default unknown values to 0. */
  value: string | null;
  link?: ObjectLink | null;
  tone?: 'default' | 'green' | 'purple' | 'pink';
}

export interface MetricCell {
  name: string;
  value: string | null;
  unit: string | null;
  /** False when this row must not be compared across schemes (SPEC §7: 不可比较结果). */
  comparable: boolean;
  note?: string | null;
}

export interface SummaryView {
  narrative: string;
  statementStatus: string;
  evidenceLinks: ObjectLink[];
  statistics: StatCard[];
  /** Null when metrics cannot be compared across schemes. */
  metricComparison: {
    schemeName: string;
    cells: MetricCell[];
  }[] | null;
  metricComparisonNote: string | null;
  nextActions: string[];
}

// ---------------------------------------------------------------------------
// work tree
// ---------------------------------------------------------------------------

export type NodeKind =
  | 'baseline'
  | 'question'
  | 'hypothesis'
  | 'scheme'
  | 'experiment'
  | 'result'
  | 'conclusion'
  /** Planning-only kinds added by the research-bootstrap round (shared spec §5). */
  | 'goal'
  | 'protocol';

/**
 * Planning status of a node — an INDEPENDENT field from the run status above.
 *
 * `confirmed` here means the user confirmed the plan for that node; it is NOT
 * `done` and never becomes a run status (shared spec §8). Both fields render
 * side by side, because a confirmed plan that has not run and a run that
 * finished without confirmation are different facts.
 */
export type PlanningStatus =
  | 'draft'
  | 'needs_confirmation'
  | 'confirmed'
  | 'needs_validation'
  | /** No planning status applies (legacy node, or not planned yet). */
  'not_planned';

export type NodeStatus =
  | 'cancelled'
  | 'done'
  | 'in_progress'
  | 'planned'
  | 'failed'
  | 'pruned'
  | 'retained'
  | 'expanded'
  | 'blocked'
  | 'unknown';

export interface NodeDetailSection {
  heading: string;
  body: string;
}

export interface ResearchNodeView {
  id: string;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  summary: string;
  /** Branch label used to keep A/B/C provenance after convergence (SPEC §3.2). */
  branch: 'main' | 'A' | 'B' | 'C' | 'X';
  /** "N 个节点" count shown on the card (aggregated children/evidence). */
  childCount: number;
  /** Adapter or fixture supplied canvas position (logical px at scale 1). */
  x: number;
  y: number;
  /** Research rationale (扩展/保留/剪枝 reasons live here, never on the card). */
  rationale: string | null;
  /** Result value(s) or next-step text, depending on kind. */
  outcome: string | null;
  /** Source / experiment / paper references backing this node. */
  links: ObjectLink[];
  /**
   * Planning status of this node. INDEPENDENT of `status` (run status): a node
   * can be `confirmed` as a plan while `status` is still `planned`, and a
   * completed run is never silently converted into a confirmed plan
   * (shared spec §8, FE-02 §5).
   */
  planningStatus?: PlanningStatus;
  /** Stable id of the research idea this node was created from, if any. */
  ideaRef?: string | null;
  /** Stable id + revision of the frozen plan snapshot bound to this node. */
  snapshotRef?: { snapshotId: string; revision: number } | null;
  /** Agent / role info for the activity detail (displayed, never on first screen). */
  actor: { role: string; status: string } | null;
  /** Collapsed-aggregation support (主链 vs 全部分支). */
  hiddenNodeCount?: number;
  /** A failed experiment is distinct from a pruned scheme (SPEC §3.2). */
  failureNote?: string | null;
  extraSections?: NodeDetailSection[];
}

export interface ResearchEdgeView {
  id: string;
  sourceId: string;
  targetId: string;
  /** Human label for the relation, e.g. 主流程 / 验证 / 计划. */
  relation: string;
  /** Dashed when true (计划 / 关联关系). */
  planned: boolean;
  reason: string | null;
}

export interface ActivityEntry {
  id: string;
  time: string;
  action: string;
  actor: string;
  target: ObjectLink | null;
  result: string;
  rejected?: boolean;
  rejectReason?: string | null;
  detail?: string | null;
}

export interface TreeData {
  summary: SummaryView;
  nodes: ResearchNodeView[];
  edges: ResearchEdgeView[];
  activity: ActivityEntry[];
  /** Node ids hidden in the default 主链 view. */
  defaultHiddenNodeIds: string[];
}

// ---------------------------------------------------------------------------
// tailor shop
// ---------------------------------------------------------------------------

export type ComponentKind = 'Baseline' | 'Method' | 'Module' | 'Experiment';

// ---------------------------------------------------------------------------
// Research bootstrap — slots, candidates and plan snapshots (shared spec §5)
//
// A Slot is a POSITION, not a component: it is where something could go, and it
// carries its own status independently of the candidate list. Candidates are
// separate objects with their own assessment, so "有 3 个候选" never reads as
// "有 3 个插槽" and never as "已装入".
// ---------------------------------------------------------------------------

export type SlotScope = 'universal' | 'domain';

export type SlotStatus = 'draft' | 'needs_confirmation' | 'confirmed';

/** How grounded a slot's existence is — a draft universal slot is not a fact. */
export type SlotKind = 'draft' | 'confirmed_domain';

export type CandidateAssessment = 'proposed' | 'needs_review' | 'incompatible';

export interface SlotCandidateView {
  /** Stable ref: a paper component OR a design idea — never both, never neither. */
  ref: ObjectLink;
  kind: 'paper_component' | 'design_idea';
  assessment: CandidateAssessment;
  reason: string | null;
  /** Why this candidate cannot be integrated, when it cannot. */
  incompatibleReason: string | null;
  evidenceRefs: ObjectLink[];
  /** Interface facts still unknown — "语义相似" is never an integrable pass. */
  missingInterfaceInfo: string[];
}

export interface SlotView {
  slotId: string;
  name: string;
  /** Role sentence shown on the card; null when unknown, never invented. */
  role: string | null;
  scope: SlotScope;
  /** Draft universal positions and confirmed domain slots render differently. */
  kind: SlotKind;
  status: SlotStatus;
  /** What the slot's existence is based on; null when it is a generic draft. */
  basis: string | null;
  inputs: string[] | null;
  outputs: string[] | null;
  constraints: string[];
  /** Locked by the USER — the lock source is shown, and locking is not silent. */
  locked: boolean;
  lockedBy: string | null;
  /** The currently bound component/idea in this node's snapshot, if any. */
  boundRef: ObjectLink | null;
  candidates: SlotCandidateView[];
  /** Stable node + snapshot this slot view was projected from. */
  nodeId: string;
  snapshotRef: { snapshotId: string; revision: number } | null;
}

export interface PositionView {
  positionKey: string;
  label: string;
  description: string | null;
  /** Research-bootstrap slots projected onto this position, when any exist. */
  slots?: SlotView[];
}

export interface ComponentTrialInfo {
  count: number;
  /** Null = unknown / not run; other tasks' success never flips this (SPEC §4.1). */
  succeededInTask: boolean | null;
  lastAttemptAt: string | null;
}

export interface ComponentView {
  componentKey: string;
  revision: string;
  kind: ComponentKind;
  name: string;
  description: string;
  tags: string[];
  positionKeys: string[];
  capabilities: string[];
  /** Missing implementation items; non-empty => 缺项. */
  missing: string[];
  /** Eligibility for wiring into THIS task; null = unknown. */
  integrable: boolean | null;
  integrableReason: string | null;
  /** Validated inside THIS task only. */
  validatedInTask: boolean;
  /** Validation that happened in another task — shown separately. */
  validatedElsewhere: { taskLabel: string; detail: string } | null;
  trial: ComponentTrialInfo;
  /** Explicit sort weight when provided; null means unavailable. */
  rankScore: number | null;
  lastUsedAt: string | null;
  source: {
    author: string;
    origin: string;
    version: string | null;
    license: string | null;
    url: string | null;
  };
  problem: string;
  recommendedPositions: string[];
  /** Detail-tab references. */
  experimentLinks: ObjectLink[];
  paperLinks: ObjectLink[];
  /** Whether "创建 Trial" is allowed and why. */
  canCreateTrial: boolean;
  createTrialReason: string | null;
}

export interface TailorData {
  positions: PositionView[];
  components: ComponentView[];
}

// ---------------------------------------------------------------------------
// papers
// ---------------------------------------------------------------------------

export type PaperFlag =
  | 'highly_relevant'
  | 'relevant'
  | 'extracted'
  | 'cited'
  | 'missing_evidence';

export type ContributionCategory =
  | 'mechanism'
  | 'evidence'
  | 'method'
  | 'data'
  | 'slot_mapping';

export interface EvidenceLocator {
  id: string;
  /** 'paper' = 论文报告值; 'local' = 本地实验观察 — rendered distinctly. */
  source: 'paper' | 'local';
  label: string;
  /** Section / page / quote locator. */
  locator: string;
  condition: string | null;
  value: string | null;
  unit: string | null;
}

export interface ContributionView {
  id: string;
  category: ContributionCategory;
  title: string;
  text: string;
  tags: { label: string; tone: 'blue' | 'green' | 'yellow' | 'purple' | 'gray' }[];
  evidences: EvidenceLocator[];
  /** Linked Baseline/Method/Module components. */
  componentLinks: ObjectLink[];
  /** Parameters / applicability summary. */
  parameters: string | null;
  datasetInfo: string | null;
  /** term in source vocabulary -> current project object/position (no DL assumption). */
  slotMapping: { sourceTerm: string; targetLabel: string; target: ObjectLink | null }[];
}

export interface WikiLinkView {
  key: string;
  title: string;
  version: string;
  statement: string;
  /** Declared dependencies — provenance, not page chrome. */
  dependencies: string[];
  updatedAt: string | null;
}

export interface PaperView {
  paperKey: string;
  sourceRevision: string;
  metadata: {
    title: string;
    authors: string[];
    year: number | null;
    venue: string;
    paperType: string;
    doi: string | null;
    /** Only source-provided safe URLs are rendered. */
    url: string | null;
    /** Local sample source, preferred for 打开原文 in demo. */
    localSource: string | null;
  };
  /** Null = 未评分; fabricated 0.9x values are forbidden. */
  relevance: null | { score: number; basis: string };
  flags: PaperFlag[];
  contributions: ContributionView[];
  wikiLinks: WikiLinkView[];
  /** Experiments this paper is cited into. */
  citations: ObjectLink[];
  similar: ObjectLink[];
  note: string | null;
}

// ---------------------------------------------------------------------------
// experiments (shared by tree cross-nav, tailor trials, paper citations)
// ---------------------------------------------------------------------------

export type ExperimentStatus =
  | 'cancelled'
  | 'planned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'unknown';

export type VerificationStatus =
  | 'verified'
  | 'unverified'
  | 'inconclusive'
  | 'unknown';

export interface ConfigField {
  name: string;
  value: string;
  constraint: string | null;
}

export interface ExperimentView {
  experimentKey: string;
  attempt: number | null;
  label: string;
  status: ExperimentStatus;
  verificationStatus: VerificationStatus;
  /** Single component vs combination — drives 单模块/组合差异 display. */
  combination: boolean;
  componentRefs: ObjectLink[];
  schemeKey: string | null;
  positionKey: string | null;
  config: ConfigField[];
  metricRows: MetricCell[];
  diagnostics: string | null;
  evidenceLinks: ObjectLink[];
  paperCitations: ObjectLink[];
  updatedAt: string | null;
}

export interface PapersData {
  papers: PaperView[];
  experiments: ExperimentView[];
}

// ---------------------------------------------------------------------------
// research bootstrap — start panel, environment, brainstorm
// (RESEARCH-BOOTSTRAP-SHARED-SPEC §3/§4/§6/§7, FE-02 §3/§4/§6)
//
// Everything here is a DISPLAY projection of the bootstrap state file. Unknown
// values stay `null` / explicit "undecided" — the UI never turns a missing
// baseline, budget or dataset into a filled-in number, and never treats the
// model's own `confirmed` flag as a user confirmation (shared spec §3).
// ---------------------------------------------------------------------------

export type ContractStatus = 'draft' | 'confirmed';

export type BaselineStatus = 'undecided' | 'proposed' | 'confirmed';

export interface BaselineView {
  status: BaselineStatus;
  name: string | null;
  /** Paper / repo ref, each nullable — a Paper baseline is not a User baseline. */
  paperRef: ObjectLink | null;
  repoRef: ObjectLink | null;
  /** Why the baseline is still undecided, when it is. */
  reason: string | null;
}

export interface ResearchContractView {
  researchId: string;
  revision: number;
  status: ContractStatus;
  /** The one sentence that is always required to save a draft. */
  question: string | null;
  objective: string | null;
  baseline: BaselineView;
  /** Target description only — never an invented dataset path or metric. */
  dataTarget: string | null;
  metricTarget: string | null;
  guardrails: string[];
  editableScope: string[];
  lockedScope: string[];
  /** Budget text the USER supplied; null when not given. */
  computeBudget: string | null;
  timeBudget: string | null;
  /** Fixed for this round: the UI offers no switch to run experiments. */
  autonomy: 'plan_only';
  pendingQuestions: string[];
  /**
   * How the current `confirmed` status was established. A model-supplied
   * `confirmed: true` is NOT a user confirmation, so this names the real source:
   * null means nobody confirmed it (shared spec §3).
   */
  confirmation: {
    confirmedBy: string | null;
    confirmedAt: string | null;
    /** Native action identity that carried the user's confirmation. */
    actionId: string | null;
  } | null;
  updatedAt: string | null;
}

export type EnvironmentProbeStatus = 'observed' | 'unavailable' | 'failed' | 'not_run';

export interface EnvironmentObservationView {
  observationId: string;
  probe: string;
  status: EnvironmentProbeStatus;
  /** The real observed value; null when the probe did not produce one. */
  value: string | null;
  error: string | null;
  /** Real host identity that ran the probe — never a static UI device value. */
  hostIdentity: string | null;
  observedAt: string | null;
}

export type EvidenceState = 'current' | 'stale' | 'missing';

export interface EvidenceRefView {
  /** Stable paper identity + content hash; entry locators are version-bound. */
  paperId: string | null;
  sourceSha256: string | null;
  assetRevision: string | null;
  contentHash: string | null;
  /** Entry locator (contribution / wiki section id), version-bound, never an index. */
  locator: string | null;
  page: number | null;
  quote: string | null;
  state: EvidenceState;
  /** Why the reference is stale or missing, when it is. */
  stateReason: string | null;
  /** Navigable target when the evidence is still resolvable. */
  link: ObjectLink | null;
}

export type IdeaBasis = 'grounded' | 'exploratory';

export type IdeaStatus = 'candidate' | 'selected' | 'rejected' | 'archived';

export interface ResearchIdeaView {
  ideaId: string;
  /** Content version: editing the text bumps this, ticking a status does not. */
  revision: number;
  contentHash: string | null;
  status: IdeaStatus;
  title: string;
  hypothesis: string | null;
  rationale: string | null;
  evidenceRefs: EvidenceRefView[];
  basis: IdeaBasis;
  proposedSlot: string | null;
  atomicChange: string | null;
  validationPlan: string | null;
  /** First target metric (edit field); the FULL list lives in targetMetrics. */
  targetMetric: string | null;
  /** Every target metric the idea declared — a watch list is a list, not a value. */
  targetMetrics: string[];
  costRisk: string | null;
  pendingQuestions: string[];
  /** The contract revision this idea was generated against. */
  contractRevision: number | null;
  reviewNotes: string | null;
}

export type BrainstormRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface BrainstormRunView {
  runId: string;
  status: BrainstormRunStatus;
  contractRevision: number | null;
  /** Real model identity, filled when it actually ran. */
  modelIdentity: string | null;
  /** Stable ids of the ideas this run produced. */
  ideaIds: string[];
  /** Per-item errors; one failed item never voids the other candidates. */
  itemErrors: Array<{ ideaId: string | null; code: string; message: string }>;
  /** Why a run produced no candidates at all (never shown as "success, 0 条"). */
  emptyResultReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BootstrapData {
  /** Null when no research has been started yet — the "开始研究" empty state. */
  activeResearchId: string | null;
  researches: Array<{
    researchId: string;
    title: string;
    contract: ResearchContractView;
    environment: EnvironmentObservationView[];
    brainstormRuns: BrainstormRunView[];
    ideas: ResearchIdeaView[];
    updatedAt: string | null;
  }>;
  /** Slots of the active research's current node, projected for the tailor shop. */
  slots: SlotView[];
  /** Stable ids of ideas the user has selected, from persisted state. */
  selectedIdeaIds: string[];
  revision: number;
}

// ---------------------------------------------------------------------------
// command runs — persisted /wiki and /extract execution facts
// (WIKI-EXTRACT-FUNCTION-SPEC-2026-10-09 §6 / §7)
//
// A run record is a SEPARATE fact from asset availability: it says what the
// last command actually did, never what the paper library currently holds.
// The page reads it from the route (the workspace sidecar), so it survives a
// refresh; it is never derived from React state alone.
// ---------------------------------------------------------------------------

export type CommandRunCommandView = 'wiki' | 'extract';

export type CommandRunStatusView =
  | 'pending'
  | 'running'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  /** Present in the record but not a known status — shown as unknown, never as success. */
  | 'unknown';

export type CommandRunOutcomeView =
  | 'pending'
  | 'running'
  | 'partial'
  | 'saved'
  | 'reused'
  | 'no_findings'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface CommandRunErrorView {
  code: string;
  message: string;
}

export interface CommandRunTargetView {
  targetId: string;
  /** The paper this target produced assets for; null when the paper is unknown. */
  paperKey: string | null;
  outcome: CommandRunOutcomeView;
  wikiSections: number;
  components: number;
  /** Why a finished scope produced nothing; only meaningful for `no_findings`. */
  noFindingsReason: string | null;
  error: CommandRunErrorView | null;
}

export interface CommandRunView {
  runId: string;
  command: CommandRunCommandView;
  status: CommandRunStatusView;
  startedAt: string;
  finishedAt: string | null;
  /** Targets that really produced a verified result (saved / reused / no_findings). */
  succeededTargets: number;
  failedTargets: number;
  targets: CommandRunTargetView[];
}

// ---------------------------------------------------------------------------
// workbench root props
// ---------------------------------------------------------------------------

export interface WorkbenchSnapshot {
  cycle?: import('../integration/research-cycle-view.ts').ResearchCycleData | null;
  task: TaskView;
  preconditions: PreconditionNote[];
  tree: Region<TreeData>;
  tailor: Region<TailorData>;
  papers: Region<PapersData>;
  /**
   * Research-bootstrap region. OPTIONAL on purpose: a legacy paper-only
   * snapshot has no bootstrap data and must still render its three pages
   * without a compat error (FE-02 §2, FE-R01).
   */
  bootstrap?: Region<BootstrapData>;
  /**
   * Newest-first `/wiki` / `/extract` runs read from the workspace sidecar.
   * Absent when the route carried none (older response), so pages must treat
   * it as optional. Never used to decide whether assets exist.
   */
  commandRuns?: CommandRunView[];
}

// --- events (SPEC §6.2) ----------------------------------------------------

export interface TrialDraft {
  componentRefs: { key: string; revision: string }[];
  positionKey: string;
  schemeKey: string | null;
  parameters: ConfigField[];
}

// ---------------------------------------------------------------------------
// research-bootstrap events (shared spec §7, FE-02 §6)
//
// Every mutating event carries:
//   - stable ids (`researchId`, `ideaId`, `nodeId`, `slotId`) — never a display
//     name and never a card index, which would break across updates;
//   - the version the user was looking at (`baseRevision` / `contractRevision`);
//   - an `operationId` created by the caller and preserved across retries, so a
//     network retry replays the same operation instead of creating a new one.
//
// The UI never claims a user confirmation the user did not make: it emits the
// user's choice and lets the host record the real action identity.
// ---------------------------------------------------------------------------

export interface ResearchEventBase {
  researchId: string | null;
  /** Bootstrap state revision the rendered UI was based on (0 for the first). */
  baseRevision: number;
  /**
   * Operation id created by the calling surface and KEPT on retry. The host
   * deduplicates on it; the UI must not mint a new one per attempt.
   */
  operationId: string;
}

/** The editable fields of the start panel — every one optional but `question`. */
export interface ResearchContractDraft {
  question: string | null;
  objective?: string | null;
  baselineName?: string | null;
  baselinePaperKey?: string | null;
  dataTarget?: string | null;
  metricTarget?: string | null;
  computeBudget?: string | null;
  timeBudget?: string | null;
  guardrails?: string[];
}

export type WorkbenchEvent =
  | (ResearchEventBase & { type: 'start_cycle'; selectedIdeaId: string; cycleRevision: number })
  | (ResearchEventBase & { type: 'cancel_cycle'; runId: string; cycleRevision: number })
  | (ResearchEventBase & { type: 'retry_cycle'; runId: string; stepId: string; cycleRevision: number })
  | { type: 'select'; taskKey: string; target: ObjectLink }
  | (ResearchEventBase & { type: 'start_research'; draft: ResearchContractDraft })
  | (ResearchEventBase & {
      type: 'save_research_contract';
      /** Null creates a new research; otherwise the stable id being edited. */
      patch: ResearchContractDraft;
      /** The user explicitly confirming the current draft + its pending items. */
      confirm: boolean;
      contractRevision: number | null;
    })
  | (ResearchEventBase & { type: 'probe_research_environment' })
  | (ResearchEventBase & {
      type: 'generate_brainstorm';
      contractRevision: number | null;
      /** Re-run retains the user's earlier selections (shared spec §4). */
      retainPreviousSelection: boolean;
    })
  | (ResearchEventBase & {
      type: 'edit_research_idea';
      ideaId: string;
      ideaRevision: number;
      patch: {
        hypothesis?: string | null;
        rationale?: string | null;
        validationPlan?: string | null;
        reviewNotes?: string | null;
        targetMetric?: string | null;
      };
    })
  | (ResearchEventBase & {
      type: 'select_research_ideas';
      /** The complete desired selection, by stable id. */
      ideaIds: string[];
    })
  | (ResearchEventBase & {
      type: 'initialize_research_graph';
      selectedIdeaIds: string[];
      contractRevision: number | null;
    })
  | (ResearchEventBase & { type: 'select_research'; researchId: string })
  | (ResearchEventBase & {
      type: 'set_slot_component';
      nodeId: string;
      slotId: string;
      /** The candidate being loaded into the node's plan snapshot. */
      ref: ObjectLink;
      snapshotRevision: number | null;
    })
  | (ResearchEventBase & {
      type: 'set_slot_locked';
      nodeId: string;
      slotId: string;
      locked: boolean;
    })
  | {
      type: 'create_trial';
      taskKey: string;
      draft: TrialDraft;
    }
  | {
      type: 'attach_citation';
      taskKey: string;
      paperKey: string;
      contributionId: string | null;
      experimentKey: string;
    }
  | {
      type: 'request_implementation';
      taskKey: string;
      componentKey: string;
      missing: string[];
    }
  | { type: 'save_note'; paperKey: string; text: string; baseRevision: string }
  | {
      type: 'request_branch_action';
      taskKey: string;
      nodeKey: string;
      decision: 'retain' | 'expand' | 'prune';
      reason: string;
    };

/**
 * The receipt the host returns for an event.
 *
 * `state` distinguishes "accepted and queued" from "actually persisted": the UI
 * must not show 已保存 on a `queued` receipt, and shows it only after the
 * persisted snapshot has been re-read (FE-02 §6, FE-R04). `operationId` echoes
 * the id the caller supplied so a retry can be matched to its original request.
 */
export interface EventOutcome {
  ok: boolean;
  message: string;
  /** Required when ok is false — rejections always show a reason. */
  reason?: string;
  /** Client-side receipt time (ms epoch), set when the outcome lands. Lets the page pick the
   * newest receipt by actual time instead of a fixed action-type priority (Plan §5). */
  receivedAt?: number;
  /** Echoes the caller's operationId; present for bootstrap events. */
  operationId?: string;
  /** 'queued' | 'running' are not success; only 'final' means persisted. */
  state?: 'queued' | 'running' | 'final' | 'rejected';
  /** Revision of the state the result was written at, when persisted. */
  revision?: number | null;
  /** Stable refs produced by the operation (idea ids, node id, snapshot ref). */
  resultRefs?: ObjectLink[];
}

export type WorkbenchEventHandler = (
  event: WorkbenchEvent,
) => EventOutcome | Promise<EventOutcome>;

export interface WorkbenchViewProps {
  snapshot: WorkbenchSnapshot;
  onEvent?: WorkbenchEventHandler;
  initialTab?: WorkspaceId;
  /** Surface requested by the outer navigation for paper research. */
  surface?: 'cockpit' | 'tree' | 'papers';
  /** Marks the root as a fixture demo (shows 演示数据 / 后端未接线). */
  demoBadge?: string | null;
  /** Omitted in demo. Production explicitly supplies unavailable actions. */
  unavailableActions?: Partial<Record<WorkbenchEvent['type'] | 'add_component' | 'paper_similarity', string>>;
  /**
   * Vertical space the host actually gives the workbench, and the bottom inset
   * it needs (the DSH composer overlays the page). The real host supplies both
   * (BE-03); the page consumes them instead of stacking guessed paddings
   * (FE-01 §4).
   */
  availableHeight?: number | null;
  bottomInset?: number | null;
  /** Invoked by a failed region's 重试 entry; absent => no retry is offered (FE-L07). */
  onRetry?: () => void;
}
