/**
 * workbench-research v1 contracts (SPEC: docs/mvp/WORKBENCH-RESEARCH-SPEC.md).
 *
 * Scope discipline
 * ----------------
 * This file defines an INCREMENTAL sidecar contract. It does not redefine any
 * frozen research fact. In particular:
 *
 *  - `ResearchCandidate`, `SynthesisResult`, P5 cards, `EvidenceField`,
 *    `CardRef` and every P0-P7 hash keep their original meaning. The types are
 *    imported, never re-declared.
 *  - `ArtifactRef` here is the frozen `{id, sha256}` pair. It is re-exported
 *    under the SPEC name `StrictArtifactRef` so the SPEC and the code use one
 *    spelling for one shape.
 *  - A new composition claim is ALWAYS `hypothesis` unless a validator proves
 *    otherwise from an author-verified source. `validateChineseClaim` enforces
 *    that mechanically rather than trusting the model.
 *
 * Version discipline (SPEC §1.2)
 * ------------------------------
 * The workbench read DTO is `schemaVersion: 3` and is requested explicitly
 * with `?schemaVersion=3`; an absent parameter still returns v2. Everything in
 * this FILE carries its own `schemaVersion: 1`, which is NOT the P6
 * `contractVersion`, NOT `ResearchCandidate.contractVersion`, and NOT a Phase 3
 * experiment protocol version. `assertWorkbenchSchemaVersion` rejects anything
 * else rather than coercing, so a v3 payload can never be served as v2.
 */

import {
  RESEARCH_ERROR_CODES,
  EVIDENCE_STATUSES,
  assertEnum,
  assertHash64,
  assertId,
  assertIsoUtc,
  assertNoExtraKeys,
  type ArtifactRef,
  type CardRef,
  type EvidenceStatus,
  type ResearchErrorCode,
} from './research.ts';
import type { SEMANTIC_HASH_ALGORITHM_V2 } from '../domain/model-dataflow.ts';

// ----------------- Version + error surface -----------------

/** The read DTO version this increment adds. v2 keeps working untouched. */
export const WORKBENCH_SCHEMA_VERSION_3 = 3 as const;
/** The previous read DTO, preserved verbatim for existing callers. */
export const WORKBENCH_SCHEMA_VERSION_2 = 2 as const;

/** Every new artifact in this increment carries schemaVersion 1. */
export const WORKBENCH_RESEARCH_SCHEMA_VERSION = 1 as const;

/**
 * Error codes ADDED by this increment.
 *
 * These are deliberately NOT appended to `RESEARCH_ERROR_CODES`: that tuple is
 * frozen, and widening it would change the meaning of an existing contract.
 * A workbench error is either an existing research code or one of these, and
 * `isWorkbenchErrorCode` is the only place that decides.
 */
export const WORKBENCH_ERROR_CODES = [
  'REVISION_CONFLICT',
  'SNAPSHOT_BUSY',
  'UNSUPPORTED_CAPABILITY',
  'RECONCILIATION_REQUIRED',
  'SCOPE_DENIED',
  'HOST_BUSY',
  'ARTIFACT_CORRUPT',
  'SOURCE_IO_ERROR',
] as const;

export type WorkbenchErrorCode = (typeof WORKBENCH_ERROR_CODES)[number];

/**
 * The full code surface a workbench contract failure may carry: the frozen
 * research codes plus the codes this increment adds. The strict validators
 * (which reject malformed requests with `INVALID_INPUT`/`SCHEMA_VIOLATION`,
 * both research codes) report this union, not the increment-only subset.
 */
export type AnyWorkbenchErrorCode = ResearchErrorCode | WorkbenchErrorCode;

/** Every code this increment can emit. */
export function isWorkbenchErrorCode(code: string): boolean {
  return (RESEARCH_ERROR_CODES as readonly string[]).includes(code)
    || (WORKBENCH_ERROR_CODES as readonly string[]).includes(code);
}

/**
 * Reject any version that is not exactly the one requested.
 *
 * A silent coercion here would be the exact failure the SPEC forbids: a v3
 * payload served to a v2 client drops `candidateDesigns` silently and the page
 * renders a research task as if it had no candidates.
 */
export function assertWorkbenchSchemaVersion(value: unknown, expected: number, fieldPath = 'schemaVersion'): number {
  if (value !== expected) {
    throw new WorkbenchContractError(
      'SCHEMA_VIOLATION',
      `unsupported schemaVersion ${JSON.stringify(value)}; this endpoint serves ${expected} only (an unknown version is refused, not coerced)`,
      { fieldPaths: [fieldPath] },
    );
  }
  return expected;
}

/** Contract-level failure carrying the SPEC §9.1 error shape. */
export class WorkbenchContractError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly fieldPaths: string[];

  constructor(code: string, message: string, opts: { retryable?: boolean; fieldPaths?: string[] } = {}) {
    super(`[${code}] ${message}`);
    this.name = 'WorkbenchContractError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.fieldPaths = opts.fieldPaths ?? [];
  }
}

/** SPEC name for the frozen artifact identity. One shape, one spelling. */
export type StrictArtifactRef = ArtifactRef;

// ----------------- Source stores and bindings (SPEC §2.2) -----------------

/**
 * Where a referenced artifact actually lives.
 *
 * The name selects a TRUSTED resolver. It is never a path, a root override, or
 * a caller-supplied relative path: `assertSourceStore` only accepts this
 * vocabulary so a request cannot steer a read.
 */
export const SOURCE_STORES = ['paper_only', 'phase2', 'phase3', 'workbench'] as const;
export type SourceStore = (typeof SOURCE_STORES)[number];

/** Stores that hold real experiment state; the workbench only reads these. */
export const SOURCE_TASK_STORES = ['phase2', 'phase3'] as const;
export type SourceTaskStore = (typeof SOURCE_TASK_STORES)[number];

export function assertSourceStore(val: unknown, fieldPath: string): SourceStore {
  return assertEnum(val, SOURCE_STORES, fieldPath);
}

export interface BoundRef {
  store: SourceStore;
  ref: StrictArtifactRef;
}

/**
 * A BoundRef that is already bound to the workbench store. Registration (SPEC
 * R3) only accepts workbench refs — the strict validator enforces
 * `store === 'workbench'` at runtime — so the v2 request/draft/intent surfaces
 * carry this narrowed shape instead of the full store union.
 */
export interface WorkbenchBoundRef {
  store: 'workbench';
  ref: StrictArtifactRef;
}

export interface SourceTaskRef {
  store: SourceTaskStore;
  taskId: string;
}

/**
 * Product-task identity.
 *
 * SPEC §2.2 rule 4: a product taskId is NOT a source taskId. The `wb-` prefix
 * makes a mix-up visible at every call site instead of silently resolving
 * against the wrong store, and `assertProductTaskId` refuses anything else.
 */
const PRODUCT_TASK_ID = /^wb-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function isProductTaskId(taskId: string): boolean {
  return PRODUCT_TASK_ID.test(taskId);
}

/**
 * Candidate identity: `(synthesisResultRef.sha256, candidateId, candidateHash)`.
 *
 * Computed by the HOST, never supplied by a model. Two candidates that share a
 * `candidateId` but came from different P6 results are therefore different
 * candidates, which is what keeps a stale binding from resolving to the wrong
 * research.
 */
export interface CandidateIdentity {
  synthesisResultRef: StrictArtifactRef;
  candidateId: string;
  candidateHash: string;
}

/** Opaque, order-sensitive identity string. Not a display name. */
export function computeCandidateKey(identity: CandidateIdentity): string {
  return `ck-${identity.synthesisResultRef.sha256.slice(0, 16)}-${identity.candidateHash.slice(0, 16)}-${identity.candidateId}`;
}

export interface CandidateBindingInput {
  synthesisResultRef: StrictArtifactRef;
  candidateId: string;
  candidateHash: string;
  /** May be empty. When non-empty each entry must be a verified proposal link. */
  sourceTaskRefs: SourceTaskRef[];
}

export interface CandidateGraphPins {
  schemaVersion: 1;
  /** Host-selected immutable plan/protocol identities; never caller paths. */
  recipeRef: BoundRef;
  protocolRef: BoundRef | null;
  profileKey: string | null;
  profileRef: BoundRef | null;
  implementationRefs: BoundRef[];
}

export interface CandidateBinding extends CandidateIdentity {
  /** Host-computed. A request may not provide it (SPEC §5.1). */
  candidateKey: string;
  sourceTaskRefs: SourceTaskRef[];
  /** Immutable graph-source pins, null when no unique verified plan exists. */
  graphPins?: CandidateGraphPins | null;
}

// ----------------- The sidecar task record (SPEC §2.2) -----------------

export interface WorkbenchTaskRecord {
  schemaVersion: 1;
  taskId: string;
  ownerSessionId: string;
  displayNameZh: string;
  researchQuestionZh: string;
  /** CAS target for sidecar writes. Never the experiment task revision. */
  designRevision: number;
  sourceTaskRefs: SourceTaskRef[];
  candidateBindings: CandidateBinding[];
  annotationRefs: BoundRef[];
  diagramRefs: BoundRef[];
  createdAt: string;
  updatedAt: string;
}

/**
 * The three revisions are deliberately different fields with different owners
 * (SPEC §2.3). Collapsing them is what previously let a design write look like
 * an experiment change, so each one is named and typed separately here.
 */
export interface SourceTaskRevisions {
  sourceTaskRevisions: Array<{ store: SourceTaskStore; taskId: string; revision: number }>;
}

export type RevisionKind = 'design' | 'source_task';

export interface VersionVector extends SourceTaskRevisions {
  taskId: string;
  /** product tasks carry designRevision; legacy tasks carry the store revision. */
  revision: number;
  revisionKind: RevisionKind;
  /** Changes on host restart; only comparable within one epoch. */
  viewEpoch: string;
  /** Monotonic within one epoch/task/scope. Guards late responses. */
  viewSequence: number;
  /** Opaque change token. Equal token => nothing a page shows has changed. */
  viewVersion: string;
}

// ----------------- Chinese explanations (SPEC §3.1) -----------------

/**
 * A claim's epistemic status.
 *
 * Identical to the frozen `EvidenceStatus` vocabulary on purpose: an inherited
 * `EvidenceField.status` is passed through unchanged, and a submitted Chinese
 * claim uses the same four words so the UI has one status renderer.
 */
export type ClaimStatus = EvidenceStatus;

export const CLAIM_LOCATOR_KINDS = ['evidence_span', 'card_field', 'candidate_field', 'code_symbol'] as const;
export type ClaimLocatorKind = (typeof CLAIM_LOCATOR_KINDS)[number];

export interface ClaimSource {
  artifact: BoundRef;
  locator: { kind: ClaimLocatorKind; id: string; fieldPath: string | null };
}

export const CLAIM_DERIVATIONS = ['translated', 'summarized', 'reasoned', 'unknown'] as const;
export type ClaimDerivation = (typeof CLAIM_DERIVATIONS)[number];

export interface ChineseClaim {
  /** null means "not known"; a reason is then REQUIRED (SPEC §3.1). */
  textZh: string | null;
  status: ClaimStatus;
  sources: ClaimSource[];
  reasonZh: string | null;
  derivation: ClaimDerivation;
}

export interface ModuleExplanation {
  mechanism: ChineseClaim;
  possibleBenefit: ChineseClaim;
  applicableConditions: ChineseClaim[];
  limitations: ChineseClaim[];
}

export interface CompositionExplanation {
  taskProblem: ChineseClaim;
  mechanismHypothesis: ChineseClaim;
  complementarity: ChineseClaim;
  placementReason: ChineseClaim;
  orderingReason: ChineseClaim;
  expectedEffects: ChineseClaim[];
  risks: ChineseClaim[];
  validationQuestions: ChineseClaim[];
}

/**
 * Fields a claim submission may never carry (SPEC §5.1).
 *
 * The point is that a model cannot smuggle a measurement through the Chinese
 * explanation path: local measurements live in the separate observation /
 * comparison DTOs and are read from published reports by the Host.
 */
export const FORBIDDEN_EXPLANATION_FIELDS = [
  'metric',
  'metrics',
  'score',
  'scores',
  'measuredValue',
  'measured_value',
  'accuracy',
  'f1',
  'auc',
  'iou',
  'improvement',
  'ready',
  'verified',
  'passed',
  'operationStatus',
  'status_override',
  'evidenceStatus',
  'path',
  'filePath',
  'file_path',
  'absolutePath',
  'ownerSessionId',
  'owner',
  'agentId',
  'revision',
  'designRevision',
] as const;

// ----------------- Method tags (SPEC §3.2) -----------------

export const METHOD_TAG_RELATIONS = ['contributed_method', 'built_on', 'comparison', 'extracted_card'] as const;
export type MethodTagRelation = (typeof METHOD_TAG_RELATIONS)[number];

export interface MethodTag {
  /** Host-computed from kind/paperId/documentHash/card identity. */
  methodKey: string;
  kind: 'baseline' | 'module';
  relation: MethodTagRelation;
  paperId: string;
  documentHash: string;
  /** null for built_on/comparison, which may have no extracted card. */
  cardRef: CardRef | null;
  nameZh: string | null;
  canonicalName: string;
  aliases: string[];
  sources: ClaimSource[];
}

/**
 * SPEC §3.2: a method key includes the document hash, so the same method name
 * in two papers is two methods, and a baseline is never merged with a module
 * that happens to share its name.
 */
export function computeMethodKey(input: {
  kind: 'baseline' | 'module';
  paperId: string;
  documentHash: string;
  cardIdentity: string | null;
}): string {
  const card = input.cardIdentity === null ? 'nocard' : input.cardIdentity.replace(/[^A-Za-z0-9._-]/g, '');
  return `mk-${input.kind}-${input.paperId}-${input.documentHash.slice(0, 16)}-${card}`;
}

// ----------------- Model data flow (SPEC §4.2) -----------------

export const FLOW_NODE_KINDS = [
  'input',
  'baseline_part',
  'module',
  'merge',
  'prediction',
  'label',
  'loss',
  'training_control',
  'output',
] as const;
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];

export const FLOW_EDGE_KINDS = ['tensor', 'supervision', 'control'] as const;
export type FlowEdgeKind = (typeof FLOW_EDGE_KINDS)[number];

export interface FlowPort {
  id: string;
  direction: 'in' | 'out';
}

export interface TensorContract {
  shape: string;
  dtype: string;
  sources: ClaimSource[];
}

export interface ModelDataFlowNode {
  id: string;
  kind: FlowNodeKind;
  labelZh: string;
  /** The baseline skeleton this node belongs to. Groups, not a new kind. */
  baselineGroup: string | null;
  methodKey: string | null;
  implementationRef: BoundRef | null;
  slotId: string | null;
  ports: FlowPort[];
  /** Non-null ONLY when a code/profile check actually stated it (SPEC §4.3). */
  tensorContract: TensorContract | null;
  sources: ClaimSource[];
}

export interface ModelDataFlowEdge {
  id: string;
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  kind: FlowEdgeKind;
  labelZh: string | null;
  sources: ClaimSource[];
}

export interface ModelDataFlowUnresolved {
  subjectId: string;
  reasonZh: string;
}

export interface ModelDataFlow {
  schemaVersion: 1;
  candidateKey: string;
  variantKey: string | null;
  level: 'conceptual' | 'code_bound';
  subjectRefs: BoundRef[];
  nodes: ModelDataFlowNode[];
  edges: ModelDataFlowEdge[];
  /** A gap is shown as a gap, never filled with an invented arrow. */
  unresolved: ModelDataFlowUnresolved[];
  /** Missing on legacy persisted graphs; new graphs must declare the algorithm. */
  semanticHashAlgorithm?: 'workbench-flow-sha256-v1' | 'workbench-flow-sha256-v2';
  /** Hash over the semantic body, EXCLUDING this field and render layout. */
  semanticHash: string;
}

/** Immutable Host-generated source and flow snapshot for one product revision. */
export interface GraphSnapshot {
  schemaVersion: 1;
  taskId: string;
  candidateKey: string;
  variantKey: string | null;
  designRevision: number;
  sourceTaskRevisions: Array<{ store: SourceTaskStore; taskId: string; revision: number }>;
  /** Immutable product-task snapshot that contained this exact candidate binding. */
  bindingRef: BoundRef;
  recipeRef: BoundRef | null;
  protocolRef: BoundRef | null;
  profileRef: BoundRef | null;
  /** All content pins that contributed to semanticHash, including the P6 result. */
  sourceRefs: BoundRef[];
  semanticHashAlgorithm: 'workbench-flow-sha256-v2';
  flow: ModelDataFlow;
}

/**
 * SPEC §4.3: the pure-`tensor` subgraph must be acyclic, but supervision and
 * control edges legitimately form training feedback. Checking the whole graph
 * for cycles would reject every correct loss/training-control graph, so only
 * the tensor edges are inspected here.
 */
export function findTensorCycle(flow: Pick<ModelDataFlow, 'nodes' | 'edges'>): string[] | null {
  const nodeIds = new Set(flow.nodes.map((n) => n.id));
  const adjacency = new Map<string, string[]>();
  for (const edge of flow.edges) {
    if (edge.kind !== 'tensor') continue;
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  let cycle: string[] | null = null;

  const visit = (id: string): void => {
    if (cycle !== null) return;
    const current = state.get(id) ?? 0;
    if (current === 1) {
      cycle = [...stack.slice(stack.indexOf(id)), id];
      return;
    }
    if (current === 2) return;
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    stack.pop();
    state.set(id, 2);
  };

  for (const node of flow.nodes) visit(node.id);
  return cycle;
}

// ----------------- JSON submission (SPEC §5.1) -----------------

export const DESIGN_ACTIONS = ['create_task', 'bind_candidate', 'annotate_module', 'annotate_design', 'attach_diagram'] as const;
export type DesignAction = (typeof DESIGN_ACTIONS)[number];

/** Actions that require an existing task and therefore a CAS check. */
export const UPDATE_ACTIONS = ['bind_candidate', 'annotate_module', 'annotate_design', 'attach_diagram'] as const;
export type UpdateDesignAction = (typeof UPDATE_ACTIONS)[number];

/** SPEC §5.1 caps. They bound the WRITE, never the science: 32 submitted
 *  explanations is not permission to run 32 modules. */
export const MAX_SUBMISSION_BYTES = 256 * 1024;
export const MAX_CLAIM_TEXT_CHARS = 4_000;
export const MAX_MODULE_EXPLANATIONS_PER_SUBMIT = 32;

export interface CreateTaskRequest {
  schemaVersion: 1;
  commandId: string;
  action: 'create_task';
  payload: {
    displayNameZh: string;
    researchQuestionZh: string;
  };
}

export interface UpdateDesignRequest {
  schemaVersion: 1;
  commandId: string;
  action: UpdateDesignAction;
  taskId: string;
  expectedDesignRevision: number;
  payload: unknown;
}

export interface DesignReceipt {
  schemaVersion: 1;
  operationId: string;
  commandId: string;
  requestHash: string;
  taskId: string;
  designRevision: number;
  resultRefs: BoundRef[];
  /** true when an identical commandId already produced this receipt. */
  reused: boolean;
}

// ----------------- Stage context (SPEC §6.1) -----------------

export const WORKBENCH_STAGES = ['discovery', 'composition', 'implementation', 'analysis', 'next_proposal'] as const;
export type WorkbenchStage = (typeof WORKBENCH_STAGES)[number];

export const STAGE_STATES = ['actionable', 'working', 'blocked', 'complete'] as const;
/** A READ MODEL. Never written into the frozen ResearchPhase enum. */
export type StageState = (typeof STAGE_STATES)[number];

export interface StageContext {
  schemaVersion: 1;
  taskId: string;
  candidateKey: string | null;
  designRevision: number;
  stage: WorkbenchStage;
  stageState: StageState;
  sourceTaskRevisions: Array<{ store: SourceTaskStore; taskId: string; revision: number }>;
  /**
   * The semantic graph the diagram/analysis stages work against, or null when the
   * stage has none.
   *
   * Added because the workflow needs it and the diagram SKILL names it as step
   * one: `workbench-diagram` says "取当前结构的 semanticHash", and
   * `evolver_register_diagram_output` will not accept a self-supplied hash —
   * it computes the workspace from it. With no hash here, the agent has to either
   * guess the workspace convention or reach for the read-only HTTP route, which
   * is exactly what the Skill forbids. Observed live: a real turn spent most of
   * its budget reading the contract and the registrar to work out where the
   * number was supposed to come from, and never drew.
   *
   * `unresolved` is the honest alternative when the graph cannot be produced (no
   * bound candidate, no published recipe), and the field is null there rather
   * than an empty string or a stale value.
   */
  semanticGraph: {
    /** Additive v2 context; legacy summary fields remain for compatibility. */
    contractVersion?: 2;
    graphRef?: BoundRef;
    semanticHashAlgorithm?: 'workbench-flow-sha256-v2';
    variantKey?: string | null;
    flow?: ModelDataFlow;
    /** sha256 over the graph body, excluding render layout — see ModelDataFlow. */
    semanticHash: string;
    level: 'conceptual' | 'code_bound';
    /** The Host-computed workspace and narrow sidecar allowlist per format. */
    diagramWorkspaces: Array<{ format: DiagramFormat; dir: string; expectedFile: string; allowedSidecars?: string[] }>;
  } | null;
  /** Diagram-specific readiness does not gate unrelated discovery or explanation work. */
  diagramCapability?: {
    state: 'ready' | 'blocked';
    reasons: Array<{ code: string; reasonZh: string }>;
  };
  objectiveZh: string;
  inputRefs: BoundRef[];
  allowedActions: Array<{ tool: string; purposeZh: string }>;
  expectedOutputs: string[];
  exitCriteriaZh: string[];
  unresolved: Array<{ code: string; reasonZh: string }>;
  skillRef: { name: string; version: string; sha256: string };
  policyRef: BoundRef;
  budgetRef: BoundRef | null;
}

// ----------------- Diagram drafts (SPEC §8.2) -----------------

export const DIAGRAM_FORMATS = ['archify_html', 'excalidraw'] as const;
export type DiagramFormat = (typeof DIAGRAM_FORMATS)[number];

/** SPEC §8.2: availability is derived, and `stale` is a real state. */
export const DIAGRAM_STATUSES = ['available', 'unverified', 'blocked', 'stale'] as const;
export type DiagramStatus = (typeof DIAGRAM_STATUSES)[number];

export interface DiagramDraft {
  schemaVersion: 1;
  candidateKey: string;
  variantKey?: string | null;
  semanticGraphRef: BoundRef;
  semanticHash: string;
  format: DiagramFormat;
  /** Null until a Host-observed execution witness identifies the actual Skill. */
  skill: { name: string; version: string; sha256: string } | null;
  artifactRefs: BoundRef[];
  /** Element -> semantic node/edge id map; the real content check. */
  semanticMappingRef: BoundRef;
  /** Agent-authored receipt summary; never a trusted pass by itself. */
  validationReceiptRef: BoundRef;
  /** Host-observed validator/renderer witness; null until independently verified. */
  validationWitnessRef: BoundRef | null;
}

/**
 * The complete frozen draft, version 2 (SPEC section R3.5).
 *
 * Version 1 carried only the candidate and the graph, so a draft could not say
 * WHICH task and owner it belonged to, which operation produced it, or which
 * semantic-hash algorithm it was computed under. A reader therefore had to take
 * the surrounding index's word for all of it -- and `readDraft` accepted any
 * well-hashed JSON at the ref, because the ref carried no identity to check
 * against. Version 2 puts the identity INSIDE the frozen object, so a reader can
 * verify the draft against its own contents and its origin commit.
 *
 * Absent optional evidence is `null`, never a synthetic `missing:` ref: a
 * placeholder ref makes "the Skill produced no receipt" indistinguishable from
 * "a receipt exists at a path we invented", which is precisely the confusion the
 * diagram status is supposed to expose.
 */
export interface DiagramDraftV2 {
  schemaVersion: 2;
  taskId: string;
  ownerSessionId: string;
  candidateKey: string;
  variantKey: string | null;
  /** The operation that committed this draft; the reader checks it against the index. */
  originOperationId: string;
  graphRef: BoundRef;
  semanticHashAlgorithm: typeof SEMANTIC_HASH_ALGORITHM_V2;
  semanticHash: string;
  format: DiagramFormat;
  /** Null until a Host-observed execution witness identifies the actual Skill. */
  skill: { name: string; version: string; sha256: string } | null;
  artifactRefs: WorkbenchBoundRef[];
  semanticMappingRef: BoundRef | null;
  validationReceiptRef: BoundRef | null;
  /** Always null this round: no trusted witness producer exists in this build. */
  validationWitnessRef: BoundRef | null;
  previewRefs: BoundRef[];
}

/** Any draft version a reader may encounter. */
export type AnyDiagramDraft = DiagramDraft | DiagramDraftV2;

// ----------------- RegisterDiagramV2 (SPEC section R3) -----------------

export const REGISTER_DIAGRAM_SCHEMA_VERSION = 2 as const;

/**
 * The strict registration request (upper SPEC RegisterDiagramV2).
 *
 * Every field is required and the version is explicit. The previous request had
 * no version at all and the tool filled `expectedDesignRevision` from the task it
 * had just read, so a caller's CAS value was silently replaced by the current
 * one -- which is not a compare-and-swap, it is an unconditional write wearing a
 * CAS field. A request that does not state its version and its expected revision
 * is now refused instead of being coerced into a legal-looking one.
 */
export interface RegisterDiagramV2 {
  schemaVersion: 2;
  commandId: string;
  taskId: string;
  candidateKey: string;
  variantKey: string | null;
  expectedDesignRevision: number;
  /** The strict validator only accepts `store: 'workbench'` refs. */
  semanticGraphRef: WorkbenchBoundRef;
  format: DiagramFormat;
  outputKey: 'main';
}

/** The exact key set a v2 registration request may carry; anything else is unknown. */
export const REGISTER_DIAGRAM_V2_KEYS = [
  'schemaVersion', 'commandId', 'taskId', 'candidateKey', 'variantKey',
  'expectedDesignRevision', 'semanticGraphRef', 'format', 'outputKey',
] as const;

/**
 * The additional fields ONLY the Host may supply to the registrar.
 *
 * Kept separate from the caller request on purpose. `semanticHash` and the
 * expected node/edge sets must come from the graph the Host is actually serving;
 * if they were accepted from a caller they would be a model's claim about the
 * structure rather than the Host's observation. The registrar accepts this union,
 * the tool accepts only `REGISTER_DIAGRAM_V2_KEYS`.
 */
export const REGISTER_DIAGRAM_HOST_KEYS = [
  'ownerSessionId', 'semanticHash',
  'expectedNodeIds', 'expectedEdgeIds', 'expectedNodeLabels', 'expectedEdgeEndpoints',
] as const;

export const DIAGRAM_OUTPUT_KEYS = ['main'] as const;

/**
 * Validate a raw registration request as RegisterDiagramV2.
 *
 * Deliberately strict, and deliberately NOT coercing (SPEC R3.1): `"2"` is not
 * `2`, `1` is not `2`, a float revision is not an integer revision, and an
 * unknown key is a refusal rather than a field that is quietly dropped. A
 * permissive validator here would let a v1 caller's request be promoted into a v2
 * registration, which is the silent-promotion the SPEC forbids.
 *
 * `allowHostFields` is set only by the registrar, whose input legitimately carries
 * the Host-computed values. It widens WHICH keys are known; it never relaxes a
 * shape rule.
 */
export function validateRegisterDiagramV2(raw: unknown, options: { allowHostFields?: boolean } = {}): { ok: true; value: RegisterDiagramV2 } | { ok: false; code: AnyWorkbenchErrorCode; message: string; fieldPaths: string[] } {
  const fail = (code: AnyWorkbenchErrorCode, message: string, fieldPaths: string[]) => ({ ok: false as const, code, message, fieldPaths });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return fail('INVALID_INPUT', 'registration request must be an object', ['request']);
  }
  const request = raw as Record<string, unknown>;

  const known: readonly string[] = options.allowHostFields === true
    ? [...REGISTER_DIAGRAM_V2_KEYS, ...REGISTER_DIAGRAM_HOST_KEYS]
    : REGISTER_DIAGRAM_V2_KEYS;
  const unknown = Object.keys(request).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    return fail('SCHEMA_VIOLATION', `registration request has unknown field(s): ${unknown.join(', ')}`, unknown);
  }
  if (request.schemaVersion !== REGISTER_DIAGRAM_SCHEMA_VERSION) {
    return fail(
      'SCHEMA_VIOLATION',
      `registration request schemaVersion must be the number ${REGISTER_DIAGRAM_SCHEMA_VERSION}; received ${JSON.stringify(request.schemaVersion)}`,
      ['schemaVersion'],
    );
  }
  const requiredStrings: Array<[string, string]> = [['commandId', 'commandId'], ['taskId', 'taskId'], ['candidateKey', 'candidateKey']];
  for (const [key, label] of requiredStrings) {
    const value = request[key];
    if (typeof value !== 'string' || value.length === 0) {
      return fail('SCHEMA_VIOLATION', `${label} must be a non-empty string`, [key]);
    }
  }
  if (!(request.variantKey === null || (typeof request.variantKey === 'string' && request.variantKey.length > 0))) {
    return fail('SCHEMA_VIOLATION', 'variantKey must be a non-empty string or null', ['variantKey']);
  }
  if (!Number.isInteger(request.expectedDesignRevision) || (request.expectedDesignRevision as number) < 1) {
    return fail('SCHEMA_VIOLATION', `expectedDesignRevision must be an integer >= 1; received ${JSON.stringify(request.expectedDesignRevision)}`, ['expectedDesignRevision']);
  }
  if (!(DIAGRAM_FORMATS as readonly string[]).includes(request.format as string)) {
    return fail('SCHEMA_VIOLATION', `format must be one of ${DIAGRAM_FORMATS.join(', ')}`, ['format']);
  }
  if (!(DIAGRAM_OUTPUT_KEYS as readonly string[]).includes(request.outputKey as string)) {
    return fail('SCHEMA_VIOLATION', `outputKey must be ${DIAGRAM_OUTPUT_KEYS.join(', ')}; this round registers the main output only`, ['outputKey']);
  }
  const graphRef = request.semanticGraphRef;
  if (typeof graphRef !== 'object' || graphRef === null || Array.isArray(graphRef)
    || (graphRef as { store?: unknown }).store !== 'workbench'
    || typeof (graphRef as { ref?: { id?: unknown } }).ref?.id !== 'string'
    || !/^[0-9a-f]{64}$/.test(String((graphRef as { ref?: { sha256?: unknown } }).ref?.sha256 ?? ''))) {
    return fail('SCHEMA_VIOLATION', 'semanticGraphRef must be a workbench BoundRef with a sha256 ref hash', ['semanticGraphRef']);
  }
  return { ok: true, value: request as unknown as RegisterDiagramV2 };
}

/** Host-observed evidence required before a diagram can be marked available. */
export interface DiagramValidationWitness {
  schemaVersion: 1;
  taskId: string;
  candidateKey: string;
  variantKey: string | null;
  semanticGraphRef: WorkbenchBoundRef;
  semanticHash: string;
  artifactSha256: string;
  inputRefs: BoundRef[];
  executionRef: BoundRef;
  validator: { name: string; version: string; implementationSha256: string };
  validatorResult: 'passed' | 'failed';
  diagnosticsRef: BoundRef | null;
  render: { result: 'passed' | 'failed' | 'not_run'; previewRefs: BoundRef[] };
  visual: { state: 'pending' | 'inspected' | 'failed'; observerToolCallRef: BoundRef | null; inspectedPreviewRefs: BoundRef[] };
  skill: { name: string; version: string; sha256: string } | null;
}

// ----------------- Change token (SPEC §7.1) -----------------

export type ChangedRegion = 'snapshot' | 'modules' | 'papers' | 'dataflow' | 'design' | 'bindings';

export interface ChangeToken {
  taskId: string;
  viewEpoch: string;
  viewSequence: number;
  viewVersion: string;
  changedRegions: ChangedRegion[];
  /** Diagnostic only. NEVER participates in equality (SPEC §7.2). */
  generatedAt: string;
}

// ----------------- Validators -----------------

function failCode(code: string, message: string, fieldPaths: string[]): never {
  throw new WorkbenchContractError(code, message, { fieldPaths });
}

/**
 * Validate one Chinese claim.
 *
 * The two hard rules from SPEC §3.1 are mechanical, not advisory:
 *  1. unknown text (`null`) must carry a reason — an empty string is not one;
 *  2. `source_reported` must cite at least one source AND may not be used for a
 *     NEW composition claim. The caller passes `allowSourceReported=false` for
 *     composition fields, which is how "复述作者主张不能变成本任务已验证结论"
 *     is enforced rather than merely documented.
 */
export function validateChineseClaim(
  raw: unknown,
  fieldPath: string,
  opts: { allowSourceReported?: boolean; forbidMeasuredFields?: boolean } = {},
): ChineseClaim {
  const allowSourceReported = opts.allowSourceReported ?? true;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  }
  const obj = raw as Record<string, unknown>;
  // Forbidden fields are checked BEFORE the generic extra-key check, so the
  // diagnostic names the policy ("a Chinese explanation may not carry a metric")
  // instead of the indistinguishable "unknown key". A submitter hitting this
  // needs to know which rule they broke, not that some key was unexpected.
  for (const forbidden of FORBIDDEN_EXPLANATION_FIELDS) {
    if (forbidden in obj) {
      failCode(
        'SCHEMA_VIOLATION',
        `${fieldPath} carries forbidden field ${forbidden}: a Chinese explanation may not carry owner, status, revision, metric or path fields`,
        [`${fieldPath}.${forbidden}`],
      );
    }
  }
  assertNoExtraKeys(obj, ['textZh', 'status', 'sources', 'reasonZh', 'derivation'], fieldPath);

  const textZh = obj.textZh === null ? null : assertText(obj.textZh, `${fieldPath}.textZh`, MAX_CLAIM_TEXT_CHARS);
  const status = assertEnum(obj.status, EVIDENCE_STATUSES, `${fieldPath}.status`);
  const reasonZh = obj.reasonZh === null ? null : assertText(obj.reasonZh, `${fieldPath}.reasonZh`, 512);
  const derivation = assertEnum(obj.derivation, CLAIM_DERIVATIONS, `${fieldPath}.derivation`);
  const sources = validateClaimSources(obj.sources, `${fieldPath}.sources`);

  if (textZh === null) {
    if (reasonZh === null) {
      failCode(
        'SCHEMA_VIOLATION',
        `${fieldPath}.textZh is null, so ${fieldPath}.reasonZh must say why it is unknown; a null claim with no reason renders as an empty promise`,
        [`${fieldPath}.reasonZh`],
      );
    }
    if (status !== 'unknown') {
      failCode(
        'SCHEMA_VIOLATION',
        `${fieldPath}.status is ${status} but the claim has no text; only 'unknown' may be textless`,
        [`${fieldPath}.status`],
      );
    }
  }

  if (status === 'source_reported') {
    if (!allowSourceReported) {
      failCode(
        'SCHEMA_VIOLATION',
        `${fieldPath}.status must not be 'source_reported': a new combination claim is always hypothesis/inferred, never an author-reported fact`,
        [`${fieldPath}.status`],
      );
    }
    if (sources.length === 0) {
      failCode(
        'SCHEMA_VIOLATION',
        `${fieldPath}.status is 'source_reported' but no source is cited; an author claim must be locatable`,
        [`${fieldPath}.sources`],
      );
    }
  }

  if ((status === 'inferred' || status === 'hypothesis') && sources.length === 0 && reasonZh === null) {
    failCode(
      'SCHEMA_VIOLATION',
      `${fieldPath}.status is ${status} and needs either a cited basis or an explicit reason`,
      [`${fieldPath}.sources`, `${fieldPath}.reasonZh`],
    );
  }

  return { textZh, status, sources, reasonZh, derivation };
}

export function validateClaimSources(raw: unknown, fieldPath: string): ClaimSource[] {
  if (!Array.isArray(raw)) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an array`, [fieldPath]);
  if (raw.length > 16) failCode('SCHEMA_VIOLATION', `${fieldPath} has ${raw.length} entries; at most 16 are allowed`, [fieldPath]);
  return raw.map((entry, i) => {
    const at = `${fieldPath}[${i}]`;
    if (typeof entry !== 'object' || entry === null) failCode('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
    const obj = entry as Record<string, unknown>;
    assertNoExtraKeys(obj, ['artifact', 'locator'], at);
    if (typeof obj.artifact !== 'object' || obj.artifact === null) {
      failCode('SCHEMA_VIOLATION', `${at}.artifact must be a BoundRef`, [`${at}.artifact`]);
    }
    const artifact = obj.artifact as Record<string, unknown>;
    assertNoExtraKeys(artifact, ['store', 'ref'], `${at}.artifact`);
    const store = assertSourceStore(artifact.store, `${at}.artifact.store`);
    if (typeof obj.locator !== 'object' || obj.locator === null) {
      failCode('SCHEMA_VIOLATION', `${at}.locator must be an object`, [`${at}.locator`]);
    }
    const locator = obj.locator as Record<string, unknown>;
    assertNoExtraKeys(locator, ['kind', 'id', 'fieldPath'], `${at}.locator`);
    return {
      artifact: { store, ref: validateStrictArtifactRef(artifact.ref, `${at}.artifact.ref`) },
      locator: {
        kind: assertEnum(locator.kind, CLAIM_LOCATOR_KINDS, `${at}.locator.kind`),
        id: assertId(locator.id, `${at}.locator.id`),
        fieldPath: locator.fieldPath === null ? null : assertText(locator.fieldPath, `${at}.locator.fieldPath`, 256),
      },
    };
  });
}

export function validateStrictArtifactRef(raw: unknown, fieldPath: string): StrictArtifactRef {
  if (typeof raw !== 'object' || raw === null) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ['id', 'sha256'], fieldPath);
  return { id: assertId(obj.id, `${fieldPath}.id`), sha256: assertHash64(obj.sha256, `${fieldPath}.sha256`) };
}

export function validateBoundRef(raw: unknown, fieldPath: string): BoundRef {
  if (typeof raw !== 'object' || raw === null) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ['store', 'ref'], fieldPath);
  return {
    store: assertSourceStore(obj.store, `${fieldPath}.store`),
    ref: validateStrictArtifactRef(obj.ref, `${fieldPath}.ref`),
  };
}

export function validateSourceTaskRefs(raw: unknown, fieldPath: string): SourceTaskRef[] {
  if (!Array.isArray(raw)) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an array`, [fieldPath]);
  if (raw.length > 32) failCode('SCHEMA_VIOLATION', `${fieldPath} has ${raw.length} entries; at most 32 are allowed`, [fieldPath]);
  return raw.map((entry, i) => {
    const at = `${fieldPath}[${i}]`;
    if (typeof entry !== 'object' || entry === null) failCode('SCHEMA_VIOLATION', `${at} must be an object`, [at]);
    const obj = entry as Record<string, unknown>;
    assertNoExtraKeys(obj, ['store', 'taskId'], at);
    return {
      store: assertEnum(obj.store, SOURCE_TASK_STORES, `${at}.store`),
      taskId: assertId(obj.taskId, `${at}.taskId`),
    };
  });
}

/** The candidate identity a submitter provides. candidateKey is Host-only. */
export function validateCandidateBindingInput(raw: unknown, fieldPath: string): CandidateBindingInput {
  if (typeof raw !== 'object' || raw === null) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  // candidateKey is REJECTED here rather than ignored: a submitter that thinks it
  // can choose the key would otherwise create a second name for one candidate.
  if ('candidateKey' in obj) {
    failCode(
      'SCHEMA_VIOLATION',
      `${fieldPath}.candidateKey is computed by the Host from the candidate identity and must not be submitted`,
      [`${fieldPath}.candidateKey`],
    );
  }
  assertNoExtraKeys(obj, ['synthesisResultRef', 'candidateId', 'candidateHash', 'sourceTaskRefs'], fieldPath);
  return {
    synthesisResultRef: validateStrictArtifactRef(obj.synthesisResultRef, `${fieldPath}.synthesisResultRef`),
    candidateId: assertId(obj.candidateId, `${fieldPath}.candidateId`),
    candidateHash: assertHash64(obj.candidateHash, `${fieldPath}.candidateHash`),
    sourceTaskRefs: validateSourceTaskRefs(obj.sourceTaskRefs ?? [], `${fieldPath}.sourceTaskRefs`),
  };
}

export function validateModuleExplanation(raw: unknown, fieldPath: string): ModuleExplanation {
  if (typeof raw !== 'object' || raw === null) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ['mechanism', 'possibleBenefit', 'applicableConditions', 'limitations'], fieldPath);
  return {
    // A mechanism restating an author's own claim MAY be source_reported.
    mechanism: validateChineseClaim(obj.mechanism, `${fieldPath}.mechanism`),
    // "why it might help HERE" is always our reasoning about this task.
    possibleBenefit: validateChineseClaim(obj.possibleBenefit, `${fieldPath}.possibleBenefit`, { allowSourceReported: false }),
    applicableConditions: (obj.applicableConditions as unknown[] ?? []).map((v, i) =>
      validateChineseClaim(v, `${fieldPath}.applicableConditions[${i}]`, { allowSourceReported: false })),
    limitations: (obj.limitations as unknown[] ?? []).map((v, i) =>
      validateChineseClaim(v, `${fieldPath}.limitations[${i}]`)),
  };
}

export function validateCompositionExplanation(raw: unknown, fieldPath: string): CompositionExplanation {
  if (typeof raw !== 'object' || raw === null) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(
    obj,
    ['taskProblem', 'mechanismHypothesis', 'complementarity', 'placementReason', 'orderingReason', 'expectedEffects', 'risks', 'validationQuestions'],
    fieldPath,
  );
  const list = (key: string, max: number): ChineseClaim[] => {
    const value = obj[key];
    if (!Array.isArray(value)) failCode('SCHEMA_VIOLATION', `${fieldPath}.${key} must be an array`, [`${fieldPath}.${key}`]);
    if (value.length > max) failCode('SCHEMA_VIOLATION', `${fieldPath}.${key} has ${value.length} entries; at most ${max} are allowed`, [`${fieldPath}.${key}`]);
    return value.map((v, i) => validateChineseClaim(v, `${fieldPath}.${key}[${i}]`, { allowSourceReported: false }));
  };
  return {
    // taskProblem describes THIS task, which is user/agent text, not an author claim.
    taskProblem: validateChineseClaim(obj.taskProblem, `${fieldPath}.taskProblem`, { allowSourceReported: false }),
    mechanismHypothesis: validateChineseClaim(obj.mechanismHypothesis, `${fieldPath}.mechanismHypothesis`, { allowSourceReported: false }),
    complementarity: validateChineseClaim(obj.complementarity, `${fieldPath}.complementarity`, { allowSourceReported: false }),
    placementReason: validateChineseClaim(obj.placementReason, `${fieldPath}.placementReason`, { allowSourceReported: false }),
    orderingReason: validateChineseClaim(obj.orderingReason, `${fieldPath}.orderingReason`, { allowSourceReported: false }),
    expectedEffects: list('expectedEffects', 12),
    risks: list('risks', 12),
    validationQuestions: list('validationQuestions', 12),
  };
}

export function validateCreateTaskRequest(raw: unknown, fieldPath = 'request'): CreateTaskRequest {
  if (typeof raw !== 'object' || raw === null) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ['schemaVersion', 'commandId', 'action', 'payload'], fieldPath);
  assertWorkbenchSchemaVersion(obj.schemaVersion, WORKBENCH_RESEARCH_SCHEMA_VERSION, `${fieldPath}.schemaVersion`);
  assertEnum(obj.action, ['create_task'], `${fieldPath}.action`);
  if (typeof obj.payload !== 'object' || obj.payload === null) {
    failCode('SCHEMA_VIOLATION', `${fieldPath}.payload must be an object`, [`${fieldPath}.payload`]);
  }
  const payload = obj.payload as Record<string, unknown>;
  assertNoExtraKeys(payload, ['displayNameZh', 'researchQuestionZh'], `${fieldPath}.payload`);
  return {
    schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
    commandId: assertId(obj.commandId, `${fieldPath}.commandId`),
    action: 'create_task',
    payload: {
      displayNameZh: assertText(payload.displayNameZh, `${fieldPath}.payload.displayNameZh`, 200),
      researchQuestionZh: assertText(payload.researchQuestionZh, `${fieldPath}.payload.researchQuestionZh`, 2_000),
    },
  };
}

/**
 * Validate an update request SHAPE only.
 *
 * Cross-field checks that need the store — owner, source chain, CAS — belong to
 * the service, which is the only layer that can read them. This function's job
 * is to refuse a malformed or over-reaching payload BEFORE any of that runs, so
 * an illegal write never reaches a lock.
 */
export function validateUpdateDesignRequest(raw: unknown, fieldPath = 'request'): UpdateDesignRequest {
  if (typeof raw !== 'object' || raw === null) failCode('SCHEMA_VIOLATION', `${fieldPath} must be an object`, [fieldPath]);
  const obj = raw as Record<string, unknown>;
  assertNoExtraKeys(obj, ['schemaVersion', 'commandId', 'action', 'taskId', 'expectedDesignRevision', 'payload'], fieldPath);
  assertWorkbenchSchemaVersion(obj.schemaVersion, WORKBENCH_RESEARCH_SCHEMA_VERSION, `${fieldPath}.schemaVersion`);
  const action = assertEnum(obj.action, UPDATE_ACTIONS, `${fieldPath}.action`);
  if (!isProductTaskId(String(obj.taskId))) {
    failCode(
      'INVALID_INPUT',
      `${fieldPath}.taskId ${JSON.stringify(obj.taskId)} is not a product task id (expected a wb-… id); a source task id must not be written through this path`,
      [`${fieldPath}.taskId`],
    );
  }
  const expected = obj.expectedDesignRevision;
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 1) {
    failCode(
      'INVALID_INPUT',
      `${fieldPath}.expectedDesignRevision must be an integer >= 1 (create_task is a separate request; expectedDesignRevision=0 is not a substitute for creating a task)`,
      [`${fieldPath}.expectedDesignRevision`],
    );
  }
  return {
    schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
    commandId: assertId(obj.commandId, `${fieldPath}.commandId`),
    action,
    taskId: obj.taskId as string,
    expectedDesignRevision: expected,
    payload: obj.payload,
  };
}

/** Enforce the serialized-size cap before anything is parsed or written. */
export function assertSubmissionSize(serialized: string, fieldPath = 'request'): void {
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_SUBMISSION_BYTES) {
    failCode(
      'INVALID_INPUT',
      `submission is ${bytes} bytes; the cap is ${MAX_SUBMISSION_BYTES} bytes (256 KiB UTF-8)`,
      [fieldPath],
    );
  }
}

function assertText(value: unknown, fieldPath: string, max: number): string {
  if (typeof value !== 'string') failCode('SCHEMA_VIOLATION', `${fieldPath} must be a string`, [fieldPath]);
  if (value.length === 0) failCode('SCHEMA_VIOLATION', `${fieldPath} must not be empty; use null with a reason instead`, [fieldPath]);
  if (value.length > max) failCode('SCHEMA_VIOLATION', `${fieldPath} is ${value.length} characters; the cap is ${max}`, [fieldPath]);
  return value;
}

export { assertId, assertHash64, assertIsoUtc, assertNoExtraKeys, assertEnum };

// ----------------- Re-exports the increment depends on -----------------

export type { CardRef, ArtifactRef, EvidenceStatus };
export { EVIDENCE_STATUSES };