/**
 * Research bootstrap CLIENT half (BE-03): wire → ViewModel mapping and the
 * action bridge to the host routes.
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-03-INTEGRATION-SPEC-2026-10-10.md §3–§4.
 *
 * Everything here is a pure mapping from the host's `/evolver/research-bootstrap`
 * projection into the FE-02 display contract (`redesign/view-model.ts`), plus one
 * fetch-based `emit` for the research events. There is no localStorage fallback
 * and no optimistic "saved": receipts keep the host's `state` and the page
 * re-reads the persisted snapshot (FE-02 §6). Unknown values stay null; the
 * mapping never invents numbers, scores or confirmations.
 */

import type {
  BootstrapData,
  BrainstormRunView,
  EventOutcome,
  ObjectLink,
  Region,
  ResearchIdeaView,
  ResearchNodeView,
  ResearchContractView,
  SlotCandidateView,
  SlotView,
  TreeData,
  WorkbenchEvent,
  WorkbenchSnapshot,
} from '../redesign/view-model.ts';
import { region } from './projection-adapter.ts';
import type { GeneralResearch } from '../../../../evolver/src/contracts/general-research.ts';
import type { GeneralAnalysisProjection } from '../../../../evolver/src/contracts/general-analysis.ts';
import type { GeneralMetricProjection } from '../../../../evolver/src/contracts/general-metrics.ts';
import type { GeneralReportProjection, GeneralFactPackRead } from '../../../../evolver/src/contracts/general-report.ts';
import { GENERAL_REPORT_LIMITS, validateGeneralFactPackRead } from '../../../../evolver/src/contracts/general-report.ts';
import type { GeneralKnowledgeEvidenceProjection } from '../../../../evolver/src/contracts/general-evidence.ts';
import type { GeneralNodeState } from '../../../../evolver/src/contracts/general-workflow.ts';
import { validateInferenceRun, type InferencePlan, type InferenceRun } from '../../../../evolver/src/contracts/general-inference-records.ts';
import type { InferenceInput, InferenceResult } from '../../../../evolver/src/contracts/general-inference.ts';

// ---------------------------------------------------------------------------
// wire types (mirror of the host projection — no server imports on the client)
// ---------------------------------------------------------------------------

export interface BootstrapWireRef {
  paperId: string | null;
  sourceSha256: string | null;
  assetRevision: string | null;
  assetKind: string;
  entryIndex: number | null;
  contentHash: string | null;
  page: number | null;
  quote: string | null;
  snapshot: { label: string; kind: string | null; description: string | null; page: number | null; quote: string | null } | null;
}

export interface BootstrapWire {
  observedResults?: Array<{ runId: string; researchId: string; nodeId: string; method: string; dataset: string; origin: 'real_run'; evidenceStatus: 'provenance_checked'; metrics: Record<string, number>; artifacts: Array<{ path: string; sha256: string; role: string }> }>;
  resultErrors?: Array<{ file: string; message: string }>;
  revision: number;
  activeResearchId: string | null;
  researches: Array<{
    researchId: string;
    title: string;
    general?: GeneralResearch;
    analysis?: GeneralAnalysisProjection;
    metrics?: GeneralMetricProjection;
    reports?: GeneralReportProjection;
    knowledgeEvidence?: GeneralKnowledgeEvidenceProjection;
    workflow?: GeneralNodeState[];
    contract: {
      revision: number;
      status: string;
      researchQuestion: string | null;
      goal: string | null;
      baseline: { status: string; name: string | null; paperRef: BootstrapWireRef | null; repoLocator: string | null };
      dataDescription: string | null;
      metrics: string[];
      guardrails: string[];
      editableScope: string[];
      lockedScope: string[];
      computeBudget: string | null;
      timeBudget: string | null;
      autonomy: string;
      pendingQuestions: Array<{ questionId: string; field: string; question: string; status: string; answer: string | null; answeredAt: string | null; answeredBy: string | null }>;
      confirmations: Array<{ field: string; kind: string; actionId: string | null; actorIdentity: string; at: string; note: string | null }>;
      updatedAt: string | null;
    };
    environment: Array<{ observationId: string; probe: string; status: string; at: string; value: unknown; error: { code: string; message: string } | null; source: { kind: string; template?: string; locator?: string }; durationMs: number }>;
    brainstormRuns: Array<{
      runId: string; status: string; contractRevision: number; modelIdentity: string | null;
      ideaIds: string[]; itemErrors: Array<{ label: string; code: string; message: string }>;
      duplicates: Array<{ submittedLabel: string; existingIdeaId: string }>;
      emptyResultReason: string | null; error: { code: string; message: string } | null;
      startedAt: string | null; finishedAt: string | null;
    }>;
    ideas: Array<{
      ideaId: string; revision: number; contentHash: string | null; status: string; title: string;
      hypothesis: string | null; rationale: string | null; basis: string; exploratoryNote: string | null;
      evidenceRefs: BootstrapWireRef[]; proposedSlot: string | null; atomicChange: string | null;
      validationPlan: string | null; targetMetrics: string[]; costNote: string | null; riskNote: string | null;
      pendingQuestions: string[]; contractRevision: number | null; reviewNotes: string[];
    }>;
    evidence: Array<{ where: string; status: string; detail: string | null }>;
    updatedAt: string | null;
  }>;
  graph: {
    graphId: string;
    nodes: Array<{ nodeId: string; kind: string; title: string; planningStatus: string; ideaRef: { ideaId: string; contentRevision: number; contentHash: string } | null; evidenceRefs: BootstrapWireRef[]; note: string | null; snapshotRef: string | null; reviewFlags: string[] }>;
    edges: Array<{ edgeId: string; from: string; to: string; relation: string }>;
    slots: Array<{ slotId: string; name: string; role: string | null; scope: string; basis: string | null; inputs: string | null; outputs: string | null; constraints: string[]; locked: boolean; lockedBy: string | null; status: string; currentRef: { token: string; kind: string; label: string } | null; candidates: Array<{ token: string; kind: string; label: string; assessment: string; reason: string | null; missingInterface: string | null; incompatibleReason: string | null }> }>;
    snapshots: Array<{ snapshotId: string; nodeId: string; revision: number }>;
  } | null;
  slots: Array<{
    nodeId: string | null;
    slotId: string; name: string; role: string | null; scope: string; status: string; basis: string | null;
    inputs: string | null; outputs: string | null; constraints: string[];
    locked: boolean; lockedBy: string | null;
    boundRef: { token: string; kind: string; label: string } | null;
    candidates: Array<{ token: string; kind: string; label: string; assessment: string; reason: string | null; missingInterface: string | null; incompatibleReason: string | null }>;
    snapshot: { snapshotId: string; revision: number } | null;
  }>;
  selectedIdeaIds: string[];
}

export interface BootstrapReadPayload {
  schemaVersion: number;
  scope: string;
  workspace: { id: string; title: string };
  papersRevision: string;
  bootstrap: BootstrapWire;
  generatedAt: string;
}

const BOOTSTRAP_EVENT_TYPES: readonly WorkbenchEvent['type'][] = [
  'start_research', 'save_research_contract', 'probe_research_environment', 'generate_brainstorm',
  'edit_research_idea', 'select_research_ideas', 'initialize_research_graph', 'select_research',
  'set_slot_component', 'set_slot_locked',
];

export function isBootstrapEvent(type: WorkbenchEvent['type']): boolean {
  return (BOOTSTRAP_EVENT_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// small mappers
// ---------------------------------------------------------------------------

function text(value: string | null | undefined): string | null {
  return value === null || value === undefined || value.length === 0 ? null : value;
}

function summarizeObservation(observation: BootstrapWire['researches'][number]['environment'][number]): string {
  const value = observation.value;
  if (observation.status !== 'observed' || value === null || value === undefined) return null as unknown as string;
  if (typeof value === 'string') return value;
  try {
    const record = value as Record<string, unknown>;
    if (observation.probe === 'host_identity') return `${record.platform ?? '?'}/${record.arch ?? '?'} · ${record.cpuCount ?? '?'} CPU · ${record.runtime ?? ''}`.trim();
    if (observation.probe === 'python_version') return `Python ${(record as { version?: string }).version ?? '?'}`;
    if (observation.probe === 'gpu') {
      const gpus = (record as { gpus?: Array<{ name: string; memoryTotalMb: number | null }> }).gpus ?? [];
      return gpus.map((gpu) => `${gpu.name}${gpu.memoryTotalMb === null ? '' : ` · ${gpu.memoryTotalMb} MB`}`).join('；') || '无 GPU 信息';
    }
    if (observation.probe === 'cuda') return `CUDA ${(record as { cudaVersion?: string }).cudaVersion ?? '?'}`;
    if (observation.probe === 'torch') {
      const torch = record as { torch?: string | null; cuda_available?: boolean; cuda_version?: string | null };
      return `PyTorch ${torch.torch ?? '?'} · CUDA 可用 ${torch.cuda_available === true ? '是' : '否'}`;
    }
    if (observation.probe === 'repo_summary') {
      const repo = record as { git?: { insideWorkTree: boolean; dirtyEntryCount: number } | null; manifests?: string[] };
      const manifests = repo.manifests?.length ? `清单：${repo.manifests.join('、')}` : '无依赖清单';
      const git = repo.git ? `git 脏条目 ${repo.git.dirtyEntryCount}` : '非 git 工作树';
      return `${git} · ${manifests}`;
    }
    return JSON.stringify(value).slice(0, 200);
  } catch { return JSON.stringify(value).slice(0, 200); }
}

function evidenceStateOf(status: string): 'current' | 'stale' | 'missing' {
  return status === 'stale' ? 'stale' : status === 'missing' ? 'missing' : 'current';
}

function evidenceView(ref: BootstrapWireRef, assessment: { status: string; detail: string | null } | undefined): import('../redesign/view-model.ts').EvidenceRefView {
  return {
    paperId: ref.paperId,
    sourceSha256: ref.sourceSha256,
    assetRevision: ref.assetRevision,
    contentHash: ref.contentHash,
    locator: ref.assetKind === 'source' ? 'source' : `${ref.assetKind}:${ref.entryIndex ?? '?'}`,
    page: ref.page,
    quote: ref.quote,
    state: evidenceStateOf(assessment?.status ?? 'current'),
    stateReason: assessment?.detail ?? null,
    link: ref.paperId === null ? null : { kind: 'paper', key: ref.paperId, label: ref.snapshot?.label ?? ref.paperId, ref: ref.page === null ? null : String(ref.page) },
  };
}

function contractView(wire: BootstrapWire['researches'][number]): ResearchContractView {
  const contract = wire.contract;
  const contractConfirmation = [...contract.confirmations].reverse()
    .find((entry) => entry.field === 'contract' && entry.kind === 'user_action') ?? null;
  const pendingQuestions = contract.pendingQuestions.map((question) => {
    if (question.status === 'answered') return `${question.question}（已回答：${question.answer ?? '空'}）`;
    if (question.status === 'skipped') return `${question.question}（已跳过）`;
    return question.question;
  });
  return {
    researchId: wire.researchId,
    revision: contract.revision,
    status: contract.status === 'confirmed' ? 'confirmed' : 'draft',
    question: text(contract.researchQuestion),
    objective: text(contract.goal),
    baseline: {
      status: contract.baseline.status === 'confirmed' ? 'confirmed' : contract.baseline.status === 'proposed' ? 'proposed' : 'undecided',
      name: text(contract.baseline.name),
      paperRef: contract.baseline.paperRef?.paperId == null ? null : { kind: 'paper', key: contract.baseline.paperRef.paperId, label: contract.baseline.paperRef.snapshot?.label ?? contract.baseline.paperRef.paperId },
      repoRef: contract.baseline.repoLocator === null ? null : { kind: 'external', key: contract.baseline.repoLocator, label: contract.baseline.repoLocator },
      reason: contract.baseline.status === 'undecided'
        ? 'Baseline 尚未确定：论文候选不等于用户选择。'
        : contract.baseline.status === 'proposed'
          ? '仅为候选提案，等待用户确认。'
          : null,
    },
    dataTarget: text(contract.dataDescription),
    metricTarget: contract.metrics.length > 0 ? contract.metrics.join('、') : null,
    guardrails: contract.guardrails,
    editableScope: contract.editableScope,
    lockedScope: contract.lockedScope,
    computeBudget: text(contract.computeBudget),
    timeBudget: text(contract.timeBudget),
    autonomy: 'plan_only',
    pendingQuestions,
    // A `confirmed` contract WITHOUT a recorded user action is displayed as
    // unconfirmed: the model's own boolean is not a confirmation (shared spec §3).
    confirmation: contract.status === 'confirmed'
      ? {
          confirmedBy: contractConfirmation?.actorIdentity ?? null,
          confirmedAt: contractConfirmation?.at ?? null,
          actionId: contractConfirmation?.actionId ?? null,
        }
      : null,
    updatedAt: contract.updatedAt,
  };
}

function runView(wire: BootstrapWire['researches'][number]['brainstormRuns'][number]): BrainstormRunView {
  return {
    runId: wire.runId,
    status: (wire.status as BrainstormRunView['status']) ?? 'unknown',
    contractRevision: wire.contractRevision,
    modelIdentity: text(wire.modelIdentity),
    ideaIds: wire.ideaIds,
    itemErrors: wire.itemErrors.map((entry) => ({ ideaId: null, code: entry.code, message: entry.message })),
    emptyResultReason: text(wire.emptyResultReason),
    startedAt: wire.startedAt,
    finishedAt: wire.finishedAt,
  };
}

function ideaView(wire: BootstrapWire['researches'][number]['ideas'][number], evidence: BootstrapWire['researches'][number]['evidence']): ResearchIdeaView {
  const ownEvidence = evidence.filter((entry) => entry.where.startsWith(`idea:${wire.ideaId}@`));
  const costRisk = [wire.costNote, wire.riskNote].filter((entry) => entry !== null && entry !== undefined && entry.length > 0).join('；');
  return {
    ideaId: wire.ideaId,
    revision: wire.revision,
    contentHash: text(wire.contentHash),
    status: (wire.status as ResearchIdeaView['status']) ?? 'candidate',
    title: wire.title,
    hypothesis: text(wire.hypothesis),
    rationale: text(wire.rationale),
    evidenceRefs: wire.evidenceRefs.map((ref, index) => evidenceView(ref, ownEvidence[index])),
    basis: wire.basis === 'grounded' ? 'grounded' : 'exploratory',
    proposedSlot: text(wire.proposedSlot),
    atomicChange: text(wire.atomicChange),
    validationPlan: text(wire.validationPlan),
    targetMetric: wire.targetMetrics.length > 0 ? wire.targetMetrics[0] : null,
    targetMetrics: wire.targetMetrics,
    costRisk: costRisk.length > 0 ? costRisk : null,
    pendingQuestions: wire.pendingQuestions,
    contractRevision: wire.contractRevision,
    reviewNotes: wire.reviewNotes.length > 0 ? wire.reviewNotes.join('；') : null,
  };
}

function candidateView(wire: NonNullable<BootstrapWire['slots']>[number]['candidates'][number]): SlotCandidateView {
  return {
    ref: { kind: 'component', key: wire.token, label: wire.label },
    kind: wire.kind === 'design_idea' ? 'design_idea' : 'paper_component',
    assessment: (wire.assessment as SlotCandidateView['assessment']) ?? 'proposed',
    reason: text(wire.reason),
    incompatibleReason: text(wire.incompatibleReason),
    evidenceRefs: [],
    missingInterfaceInfo: wire.missingInterface === null ? [] : [wire.missingInterface],
  };
}

export function slotViews(wire: BootstrapWire): SlotView[] {
  return wire.slots.map((slot) => ({
    slotId: slot.slotId,
    name: slot.name,
    role: text(slot.role),
    scope: slot.scope === 'domain' ? 'domain' : 'universal',
    kind: slot.scope === 'domain' ? 'confirmed_domain' : 'draft',
    status: (slot.status as SlotView['status']) ?? 'draft',
    basis: text(slot.basis),
    inputs: slot.inputs === null ? null : [slot.inputs],
    outputs: slot.outputs === null ? null : [slot.outputs],
    constraints: slot.constraints,
    locked: slot.locked,
    lockedBy: text(slot.lockedBy),
    boundRef: slot.boundRef === null ? null : { kind: 'component', key: slot.boundRef.token, label: slot.boundRef.label },
    candidates: slot.candidates.map(candidateView),
    nodeId: slot.nodeId ?? '',
    snapshotRef: slot.snapshot === null ? null : { snapshotId: slot.snapshot.snapshotId, revision: slot.snapshot.revision },
  }));
}

// ---------------------------------------------------------------------------
// tree projection (planning graph → TreeData; run status stays `planned`)
// ---------------------------------------------------------------------------

const NODE_KIND_MAP: Record<string, ResearchNodeView['kind']> = {
  goal: 'goal', protocol: 'protocol', baseline: 'baseline', hypothesis: 'hypothesis',
};

/** Chinese kind word for qualifying depends_on edges by what they point at. */
const NODE_KIND_LABEL: Record<string, string> = {
  goal: '研究目标', protocol: '协议', baseline: '基线', hypothesis: '假设',
};

export function researchTree(wire: BootstrapWire, activeResearch: BootstrapWire['researches'][number] | undefined): TreeData | null {
  if (wire.graph === null || wire.graph.nodes.length === 0) return null;
  const graph = wire.graph;
  // Simple layered layout over depends_on edges (dependents below their prerequisites).
  const depths = new Map<string, number>();
  const depth = (nodeId: string, trail: Set<string>): number => {
    if (depths.has(nodeId)) return depths.get(nodeId)!;
    if (trail.has(nodeId)) return 0;
    trail.add(nodeId);
    const parents = graph.edges.filter((edge) => edge.from === nodeId).map((edge) => depth(edge.to, trail));
    const result = parents.length ? Math.max(...parents) + 1 : 0;
    trail.delete(nodeId);
    depths.set(nodeId, result);
    return result;
  };
  graph.nodes.forEach((node) => depth(node.nodeId, new Set()));
  const rows = new Map<number, number>();
  const nodes: ResearchNodeView[] = graph.nodes.map((node) => {
    const layer = depths.get(node.nodeId) ?? 0;
    const row = rows.get(layer) ?? 0;
    rows.set(layer, row + 1);
    const snapshot = node.snapshotRef === null ? undefined : graph.snapshots.find((entry) => entry.snapshotId === node.snapshotRef);
    return {
      id: node.nodeId,
      kind: NODE_KIND_MAP[node.kind] ?? 'hypothesis',
      title: node.title,
      status: 'planned' as const,
      summary: node.note ?? (node.kind === 'hypothesis' ? '来自所选研究方向的待验证分支。' : '规划节点。'),
      branch: 'main' as const,
      childCount: graph.edges.filter((edge) => edge.to === node.nodeId).length,
      x: 30 + layer * 230,
      y: 50 + row * 120,
      rationale: node.reviewFlags.length > 0 ? `需复核：${node.reviewFlags.join('、')}` : null,
      outcome: null,
      links: node.ideaRef === null ? [] : [{ kind: 'external', key: node.ideaRef.ideaId, label: `idea ${node.ideaRef.ideaId}` }],
      planningStatus: (node.planningStatus as ResearchNodeView['planningStatus']) ?? 'not_planned',
      ideaRef: node.ideaRef?.ideaId ?? null,
      snapshotRef: snapshot === undefined ? null : { snapshotId: snapshot.snapshotId, revision: snapshot.revision },
      actor: null,
    };
  });
  const hypotheses = graph.nodes.filter((node) => node.kind === 'hypothesis').length;
  const runs = activeResearch?.brainstormRuns ?? [];
  return {
    summary: {
      narrative: `研究规划：${graph.nodes.length} 个节点（含 ${hypotheses} 条待验证假设分支）、${graph.slots.length} 个插槽。本图为规划结果，不包含任何实验或运行结论。`,
      statementStatus: '来源为持久化研究启动数据（plan_only）；不推断科研结论',
      evidenceLinks: [],
      statistics: [
        { key: 'totalExperiments' as const, label: '规划节点', value: String(graph.nodes.length) },
        { key: 'validResults' as const, label: '待验证分支', value: String(hypotheses), tone: 'purple' as const },
        { key: 'bestScheme' as const, label: '最佳方案', value: null, tone: 'purple' as const },
        { key: 'mainChange' as const, label: '主要提升', value: null, tone: 'purple' as const },
      ],
      metricComparison: null,
      metricComparisonNote: '尚未产生任何本地实验；方案对比等待用户显式发起。',
      nextActions: [],
    },
    nodes,
    // The wire carries only depends_on / derived_from. A page where EVERY edge says
    // the same word "依赖" answers nothing, so the relation is qualified by the
    // REAL kind of the node it points at (依赖：基线 / 依赖：协议 / …). That is a
    // structural fact, not an invented reason; edge.reason stays null.
    edges: graph.edges.map((edge) => {
      const target = graph.nodes.find((node) => node.nodeId === edge.to);
      const targetKind = target === undefined ? null
        : NODE_KIND_LABEL[target.kind] ?? null;
      return {
        id: edge.edgeId, sourceId: edge.from, targetId: edge.to,
        relation: edge.relation === 'derived_from'
          ? '派生'
          : `依赖：${targetKind ?? '前置'}`,
        planned: true, reason: null,
      };
    }),
    activity: runs.map((run) => ({
      id: run.runId, time: run.startedAt ?? '', action: 'Brainstorm', actor: run.modelIdentity ?? 'Agent',
      target: null, result: run.status, rejected: run.status === 'failed' || run.status === 'cancelled' || run.status === 'interrupted',
      rejectReason: run.error?.message ?? null, detail: run.emptyResultReason ?? null,
    })),
    defaultHiddenNodeIds: [],
  };
}

// ---------------------------------------------------------------------------
// region assembly
// ---------------------------------------------------------------------------

export function bootstrapRegion(wire: BootstrapWire): Region<BootstrapData> {
  if (wire.researches.length === 0) {
    return region<BootstrapData>('empty', {
      activeResearchId: null, researches: [], slots: [], selectedIdeaIds: [], revision: wire.revision,
    }, '本工程还没有启动研究：写一句话说明研究问题即可保存草稿，基线、数据、预算都可以保持未确定。');
  }
  const active = wire.researches.find((entry) => entry.researchId === wire.activeResearchId) ?? wire.researches[0];
  const data: BootstrapData = {
    activeResearchId: wire.activeResearchId ?? active.researchId,
    researches: wire.researches.map((entry) => ({
      researchId: entry.researchId,
      title: entry.title,
      contract: contractView(entry),
      environment: entry.environment.map((observation) => ({
        observationId: observation.observationId,
        probe: observation.probe,
        status: (observation.status as 'observed' | 'unavailable' | 'failed' | 'not_run') ?? 'not_run',
        value: observation.status === 'observed' ? summarizeObservation(observation) : null,
        error: observation.error?.message ?? null,
        hostIdentity: null,
        observedAt: observation.at,
      })),
      brainstormRuns: entry.brainstormRuns.map(runView),
      ideas: entry.ideas.map((idea) => ideaView(idea, entry.evidence)),
      updatedAt: entry.updatedAt,
    })),
    slots: slotViews(wire),
    selectedIdeaIds: wire.selectedIdeaIds,
    revision: wire.revision,
  };
  return region<BootstrapData>('ready', data, null);
}

/** Merges the bootstrap projection into a paper-library snapshot (paper data always wins on failure). */
export function withBootstrap(snapshot: WorkbenchSnapshot, wire: BootstrapWire): WorkbenchSnapshot {
  const next: WorkbenchSnapshot = { ...snapshot, bootstrap: bootstrapRegion(wire) };
  const activeResearch = wire.researches.find((entry) => entry.researchId === wire.activeResearchId) ?? wire.researches[0];
  const tree = researchTree(wire, activeResearch);
  const results = (wire.observedResults ?? []).filter((r) => r.researchId === activeResearch?.researchId);
  if (tree !== null) {
    tree.nodes = tree.nodes.map((node) => {
      const runs = results.filter((r) => r.nodeId === node.id);
      if (!runs.length) return node;
      return { ...node, status: 'done' as const, outcome: `${runs.length} 个真实来源结果（文件与身份已核对；科研结论仍需评审）`,
        extraSections: [...(node.extraSections ?? []), ...runs.map((r) => ({ heading: r.runId, body: `${r.method} · ${r.dataset} · ${JSON.stringify(r.metrics)}` }))] };
    });
  }
  if (tree !== null) next.tree = region('ready', tree, null);
  else if (activeResearch) next.tree = region<TreeData>('empty', null, `研究树尚未初始化：已有 ${activeResearch.ideas.length} 个候选方向，已选择 ${wire.selectedIdeaIds.length} 个。请先选择研究方向，再初始化研究图；此操作不会启动训练。`);
  if (results.length) next.papers = region('ready', {
    papers: snapshot.papers.data?.papers ?? [],
    experiments: [...(snapshot.papers.data?.experiments ?? []), ...results.map((r) => ({
      experimentKey: r.runId, attempt: null, label: `${r.method} · ${r.runId}`, status: 'completed' as const,
      verificationStatus: 'unknown' as const, combination: false, componentRefs: [], schemeKey: r.nodeId, positionKey: null,
      config: [{ name: '数据集', value: r.dataset, constraint: null }],
      metricRows: Object.entries(r.metrics).map(([name, value]) => ({ name, value: String(value), unit: null, comparable: false, note: '真实来源文件已核对；比较条件尚未评审' })),
      diagnostics: 'provenance_checked：来源文件和运行身份一致，不自动判定科研假设成立。',
      evidenceLinks: r.artifacts.map((a) => ({ kind: 'external' as const, key: a.path, label: `${a.role}: ${a.path}`, ref: a.sha256 })),
      paperCitations: [], updatedAt: null,
    }))],
  }, null);
  next.preconditions = [...snapshot.preconditions, ...(wire.resultErrors ?? []).map((error) => ({ id: `result:${error.file}`, severity: 'warning' as const, text: `结果未绑定：${error.file} · ${error.message}` }))];
  return next;
}

// ---------------------------------------------------------------------------
// action bridge
// ---------------------------------------------------------------------------

/** POSTs one research event to the trusted host bridge and returns its receipt verbatim. */
export async function emitBootstrapEvent(sessionId: string, event: WorkbenchEvent): Promise<EventOutcome> {
  const operationId = (event as { operationId?: string }).operationId;
  try {
    const response = await fetch(`/evolver/research-bootstrap/actions?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event),
    });
    const body = await response.json() as { ok?: boolean; message?: string; reason?: string; state?: EventOutcome['state']; revision?: number | null; resultRefs?: ObjectLink[]; error?: string };
    if (!response.ok) {
      return { ok: false, message: body.message ?? body.error ?? `HTTP ${response.status}`, reason: body.reason ?? body.error, operationId, state: 'rejected' };
    }
    return {
      ok: body.ok === true,
      message: body.message ?? (body.ok === true ? '已提交。' : '动作被拒绝'),
      reason: body.reason,
      operationId,
      state: body.state ?? (body.ok === true ? 'final' : 'rejected'),
      revision: body.revision ?? null,
      resultRefs: body.resultRefs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message, reason: message, operationId, state: 'rejected' };
  }
}

/** Fetches the read-only projection; null = the host has no bootstrap mount (legacy host). */
export async function readBootstrap(sessionId: string, signal: AbortSignal): Promise<BootstrapReadPayload | null> {
  const response = await fetch(`/evolver/research-bootstrap?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'same-origin', signal });
  if (response.status === 404) return null;
  const body = await response.json() as BootstrapReadPayload & { error?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  if (body.schemaVersion !== 1 || body.scope !== 'workspace-files' || typeof body.bootstrap?.revision !== 'number') {
    throw new Error('研究启动数据响应格式错误。');
  }
  return body;
}

/** Reading a registered report never starts an Agent or a calculation. */
export async function readGeneralFactPack(sessionId: string, researchId: string, packId: string, version: number, signal: AbortSignal): Promise<GeneralFactPackRead> {
  if (![sessionId, researchId, packId].every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 200) || !Number.isSafeInteger(version) || version < 1 || version > 201) throw new Error('报告读取身份或版本无效。');
  const query = new URLSearchParams({ sessionId, researchId, packId, version: String(version) });
  const response = await fetch(`/evolver/research-bootstrap/report?${query}`, { credentials: 'same-origin', signal });
  // The envelope also carries registration and live freshness; bound bytes before parsing it.
  const maxBytes = GENERAL_REPORT_LIMITS.maxBytes + 256 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('报告响应为空。');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('报告响应超过大小上限。'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  if (body.schemaVersion !== 1 || body.scope !== 'workspace-files') throw new Error('报告响应格式错误。');
  const result = validateGeneralFactPackRead(body.result);
  if (result.pack.researchId !== researchId || result.record.packId !== packId || result.record.version !== version) throw new Error('报告响应与请求身份不一致。');
  return result;
}

/** 读取端结构类型：服务端 read() 返回 { run, freshness, content }；content 由服务端完整重算校验后才返回。 */
export interface GeneralInferenceArtifactView {
  readonly schemaVersion: 1;
  readonly kind: 'student_t_inference';
  readonly researchId: string;
  readonly plan: InferencePlan;
  readonly input: InferenceInput;
  readonly result: InferenceResult;
  readonly selection: { rangeRows: number; excludedRows: number; unselectedRows: number };
  readonly startedAt: string;
  readonly finishedAt: string;
}
export interface GeneralInferenceRead {
  readonly run: InferenceRun;
  readonly freshness: { readonly status: 'current' | 'needs_review'; readonly reasons: readonly string[] };
  readonly content: GeneralInferenceArtifactView | null;
}

/** 读取已登记推断运行（含整包重算校验与新鲜度）；不启动 Agent、不执行推断。 */
export async function readGeneralInference(sessionId: string, researchId: string, runId: string, signal: AbortSignal): Promise<GeneralInferenceRead> {
  if (![sessionId, researchId, runId].every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 200)) throw new Error('推断读取身份无效。');
  const query = new URLSearchParams({ sessionId, researchId, runId });
  const response = await fetch(`/evolver/research-bootstrap/inference?${query}`, { credentials: 'same-origin', signal });
  // 推断产物携带完整冻结输入样本数组；同样限制响应大小后再解析。
  const maxBytes = 24 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('推断响应为空。');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('推断响应超过大小上限。'); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)) as { schemaVersion?: number; scope?: string; result?: { run?: unknown; freshness?: { status: 'current' | 'needs_review'; reasons: string[] }; content?: { researchId?: string } | null }; error?: string; message?: string };
  if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
  if (body.schemaVersion !== 1 || body.scope !== 'workspace-files' || !body.result) throw new Error('推断响应格式错误。');
  const run = validateInferenceRun(body.result.run);
  if (run.runId !== runId) throw new Error('推断响应与请求身份不一致。');
  const content = body.result.content === null || body.result.content === undefined ? null : body.result.content as GeneralInferenceArtifactView;
  if (content !== null && (content.kind !== 'student_t_inference' || content.researchId !== researchId || content.plan.planId !== run.planId || content.plan.version !== run.planVersion)) {
    throw new Error('推断产物与登记运行不一致。');
  }
  return { run, freshness: body.result.freshness as GeneralInferenceRead['freshness'], content };
}
