/**
 * dsh-evolver-ui shared wire types (WorkbenchSnapshot v2).
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md section 8.4. These mirror the projection
 * in packages/evolver/src/adapters/dsh/workbench-projection.ts.
 *
 * The client is NOT allowed to derive a research conclusion: it formats values,
 * marks selection, and renders states the host already decided. That is why
 * every comparison arrives pre-computed (`improvement`, `complete`,
 * `limitation`) instead of being recomputed here from raw rows.
 */
export type NodeKind = 'baseline' | 'combination' | 'run' | 'result';
export type EdgeRelation = 'comparison_variant' | 'proposed_extension' | 'executed_extension' | 'execution' | 'data_flow';
export type ExecutionStatus = 'not_started' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
export type MeasurementStatus = 'untested' | 'measured_unverified' | 'measured_verified' | 'partial' | 'unreadable';
export interface ArtifactRef {
    id: string;
    sha256: string | null;
}
export interface ComparisonRow {
    metricId: string;
    direction: 'minimize' | 'maximize';
    unit: string;
    split: string;
    referenceRef: string;
    pairedSeedCount: number;
    expectedSeedCount: number;
    measuredValue: number | null;
    referenceValue: number | null;
    /** POSITIVE WHEN BETTER, whatever the metric direction. Host-computed. */
    improvement: number | null;
    complete: boolean;
    limitation: string | null;
    comparisonRef: string | null;
    evidenceLevel: 'phase2_local' | 'phase3_report' | 'none';
}
export interface MetricRow {
    variantId: string;
    seed: number;
    metricId: string;
    value: number | null;
    unit: string;
    split: string;
    sampleCount: number;
    verified: boolean;
    artifactRefId: string | null;
}
export interface NodeDetail {
    variantId: string | null;
    seeds: number[];
    metricRows: MetricRow[];
    pairedDeltas: Array<{
        seed: number;
        metricId: string;
        referenceValue: number;
        candidateValue: number;
        rawDelta: number;
        improvement: number;
        percentagePoints: number | null;
    }>;
    executableRef: string | null;
    executableReadiness: string | null;
    slotId: string | null;
    firstError: string | null;
    costRef: string | null;
    protocolRef: string | null;
    reportRefs: string[];
}
export interface GraphNode {
    id: string;
    kind: NodeKind;
    displayName: string;
    baselineRef: string | null;
    moduleRefs: string[];
    proposalRef: string | null;
    executionStatus: ExecutionStatus;
    measurementStatus: MeasurementStatus;
    operationRefs: string[];
    resultRefs: string[];
    verificationRefs: string[];
    comparisons: ComparisonRow[];
    summary: string;
    detail: NodeDetail;
}
export interface GraphEdge {
    id: string;
    source: string;
    target: string;
    relation: EdgeRelation;
    evidenceRefs: string[];
    label: string;
}
export interface WorkbenchIssue {
    severity: 'error' | 'warning';
    code: string;
    message: string;
}
export interface OperationSummary {
    operationId: string;
    method: string;
    status: string;
    createdAt: string;
    updatedAt: string;
    error: string | null;
    attempt: 'original' | 'retry' | 'rerun' | 'unknown';
}
export interface WorkbenchSnapshot {
    schemaVersion: 2;
    taskId: string;
    displayName: string;
    revision: number;
    generatedAt: string;
    source: {
        phase: 'phase2' | 'phase3';
        storageRoot: string;
        taskRef: string | null;
        experimentTaskId: string | null;
    };
    protocolRef: string | null;
    taskType: string | null;
    dataSummary: string | null;
    budgetSummary: string | null;
    upstreamQuality: string[];
    issues: WorkbenchIssue[];
    nodes: GraphNode[];
    edges: GraphEdge[];
    latestComparisonRef: string | null;
    operations: OperationSummary[];
}
export interface TaskSummary {
    taskId: string;
    displayName: string;
    ownerSessionId: string | null;
    revision: number | null;
    createdAt: string | null;
    updatedAt: string | null;
    operationCount: number;
    phase: 'phase2' | 'phase3';
    readError: string | null;
}
export interface ModuleCard {
    id: string;
    displayName: string;
    mechanism: string | null;
    mechanismEvidenceRefs: string[];
    interventionAxis: string | null;
    modifies: string | null;
    expectedOutput: string | null;
    origin: 'p5_card' | 'phase2_pinned' | 'phase3_protocol';
    status: string | null;
    slotId: string | null;
    implementationRef: string | null;
    implementationReadiness: string | null;
    paperId: string | null;
    paperTitle: string | null;
    builtOnBaselines: string[];
    conditionalResultRefs: Array<{
        taskId: string;
        nodeId: string;
        variantId: string;
    }>;
    missing: string[];
    sourceOperationId: string | null;
    documentHash: string | null;
}
export interface PaperCard {
    paperId: string;
    /** The REAL PaperInput title. Never a module/method name. */
    title: string | null;
    titleUnknownReason: string | null;
    version: string | null;
    sourceUri: string | null;
    sourceGroup: string | null;
    materialScope: string | null;
    documentHash: string | null;
    availableSections: string[];
    moduleCardCount: number;
    baselineCardCount: number;
    cardRefs: string[];
    referencedByCurrentCandidate: boolean;
    runRef: string | null;
    inputManifestRef: string | null;
}
export interface ArtifactView {
    type: string;
    ref: ArtifactRef;
    content: string;
    truncated: boolean;
    byteLength: number;
}
export interface AccessInfo {
    authentication: 'dsh-connection-fence' | 'unavailable';
    authorization: 'grant-required' | 'grant-optional';
    callerIdentityDerivedFromRequest: false;
    note: string;
}
export interface WorkbenchStatus {
    schemaVersion: number;
    service: string;
    route: string;
    buildHash: string;
    roots: {
        researchExecutionRoot: string;
        paperOnlyRoot: string;
        phase3ExperimentRoot: string;
    };
    access: AccessInfo;
}
/** What the drawer shows, resolved from a click in any workspace. */
export type Selection = {
    kind: 'node';
    id: string;
} | {
    kind: 'module';
    id: string;
} | {
    kind: 'paper';
    paperId: string;
} | null;
/** A source artifact, identified by the STORE it lives in plus its content hash. */
export type SourceStore = 'paper_only' | 'phase2' | 'phase3' | 'workbench';
export interface BoundRef {
    store: SourceStore;
    ref: ArtifactRef;
}
export type ClaimStatus = 'source_reported' | 'inferred' | 'hypothesis' | 'unknown';
export interface ClaimSource {
    artifact: BoundRef;
    locator: {
        kind: 'evidence_span' | 'card_field' | 'candidate_field' | 'code_symbol';
        id: string;
        fieldPath: string | null;
    };
}
/**
 * One Chinese claim, with its epistemic status carried by the HOST.
 *
 * `textZh: null` means "not known" and REQUIRES `reasonZh`. The UI must render
 * the reason instead of substituting a generic sentence — an empty string and a
 * plausible-sounding sentence are the two failures this shape exists to prevent.
 */
export interface ChineseClaim {
    textZh: string | null;
    status: ClaimStatus;
    sources: ClaimSource[];
    reasonZh: string | null;
    derivation: 'translated' | 'summarized' | 'reasoned' | 'unknown';
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
export interface MethodTag {
    methodKey: string;
    kind: 'baseline' | 'module';
    relation: 'contributed_method' | 'built_on' | 'comparison' | 'extracted_card';
    paperId: string;
    documentHash: string;
    cardRef: {
        id: string;
        revision: number;
        sha256: string;
        producerOperationId: string;
    } | null;
    nameZh: string | null;
    canonicalName: string;
    aliases: string[];
    sources: ClaimSource[];
}
export interface CandidateBinding {
    candidateKey: string;
    synthesisResultRef: ArtifactRef;
    candidateId: string;
    candidateHash: string;
    sourceTaskRefs: Array<{
        store: 'phase2' | 'phase3';
        taskId: string;
    }>;
}
export interface CandidateDesign {
    candidateKey: string;
    binding: CandidateBinding;
    /** null when unresolved; `unresolved` then says why. Never an empty object. */
    rationale: CompositionExplanation | null;
    decision: string | null;
    performanceStatus: string | null;
    moduleCardRefs: string[];
    baselineCardRef: string | null;
    moduleTags: MethodTag[];
    unresolved: Array<{
        code: string;
        reasonZh: string;
    }>;
}
/**
 * Which store a task came from.
 *
 * `revisionKind` matters because a product task's design revision and an
 * experiment task's revision are DIFFERENT CLOCKS (SPEC section 2.3); a single
 * `revision` number would let a design write look like an experiment change.
 */
export type RevisionKind = 'design' | 'source_task';
export type TaskStoreName = 'phase2' | 'phase3' | 'workbench' | 'paper_only';
export interface QualifiedTask {
    taskId: string;
    store: TaskStoreName;
    phase: 'phase2' | 'phase3' | 'product';
    revisionKind: RevisionKind;
}
export interface WorkbenchSnapshotV3 {
    schemaVersion: 3;
    taskId: string;
    displayName: string;
    revision: number;
    revisionKind: RevisionKind;
    designRevision: number | null;
    sourceTaskRevisions: Array<{
        store: 'phase2' | 'phase3';
        taskId: string;
        revision: number;
    }>;
    viewEpoch: string;
    viewSequence: number;
    viewVersion: string;
    source: {
        store: TaskStoreName;
        phase: 'phase2' | 'phase3' | 'product';
        storageRoot: string;
        taskRef: string | null;
        experimentTaskId: string | null;
    };
    protocolRef: string | null;
    issues: WorkbenchIssue[];
    /** The unchanged v2 graph, so the three workspaces keep working. */
    graph: {
        nodes: GraphNode[];
        edges: GraphEdge[];
        operations: OperationSummary[];
        latestComparisonRef: string | null;
    };
    candidateDesigns: CandidateDesign[];
    stageSummary: Array<{
        stage: string;
        stageState: string;
        reasonZh: string | null;
    }>;
    generatedAt: string;
}
export interface PaperCardV3 {
    paperId: string;
    title: string | null;
    titleUnknownReason: string | null;
    documentHash: string | null;
    methodTags: MethodTag[];
    legacy: PaperCard;
}
export type ChangedRegion = 'snapshot' | 'modules' | 'papers' | 'dataflow' | 'design' | 'bindings';
/**
 * The lightweight change token.
 *
 * `generatedAt` is DIAGNOSTIC ONLY and must never participate in an equality
 * test (SPEC section 7.2): including it would make every 3-second poll report a
 * change and re-render the page forever.
 */
export interface ChangeToken {
    taskId: string;
    viewEpoch: string;
    viewSequence: number;
    viewVersion: string;
    changedRegions: ChangedRegion[];
    generatedAt: string;
}
export interface WorkbenchStatusV3 {
    schemaVersion: number;
    service: string;
    route: string;
    buildHash: string;
    schemaVersions: {
        default: number;
        supported: number[];
        optIn: string;
    };
    roots: {
        researchExecutionRoot: string;
        paperOnlyRoot: string;
        phase3ExperimentRoot: string;
        workbenchResearchRoot: string;
    };
    researchWorkbench: {
        available: boolean;
        unavailableReasonZh: string | null;
        viewEpoch: string | null;
    };
    access: AccessInfo;
}
export declare const FLOW_NODE_KINDS: readonly ["input", "baseline_part", "module", "merge", "prediction", "label", "loss", "training_control", "output"];
export type FlowNodeKind = (typeof FLOW_NODE_KINDS)[number];
export declare const FLOW_EDGE_KINDS: readonly ["tensor", "supervision", "control"];
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
