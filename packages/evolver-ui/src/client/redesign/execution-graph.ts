/**
 * 「实验执行图」 model — the DEFAULT work-tree projection (round 2026-10-11).
 *
 * Plan: docs/mvp/redesign-2026-10-08 review round — "默认展示实验执行图，突出
 * 实验动作与先后顺序". This module is the pure, Node-testable half: it re-derives a
 * stage-grouped execution flow from the SAME TreeData the relation view renders. The
 * .tsx only renders what is derived here and maps clicks back to real node ids.
 *
 * Honesty rules (they are load-bearing, see the view-model contract):
 * - every value on a card comes from a real source field; a slot with no source is
 *   `null` and the renderer prints 待补充 — nothing is padded to look complete;
 * - `planningStatus` and run `status` stay two independent facts (shared spec §8);
 * - an experiment card is a REAL node (experiment node, or a bootstrap hypothesis
 *   bound to a selected idea). Stages with no real nodes render an explicit empty
 *   note instead of placeholder nodes;
 * - hypotheses/schemes are not dropped: they either become the 来源说明 of the
 *   experiment they feed, or — when nothing was ever run from them — keep their own
 *   card (a pruned scheme must stay visible with its 剪枝依据);
 * - derivation is deterministic: cards sort by stable node id, E-numbers follow that
 *   order, and the 下一步 recommendation is the first executable (or first
 *   blocked) experiment in that order — never "the best one".
 */
import type {
  ExperimentView,
  ResearchEdgeView,
  ResearchIdeaView,
  ResearchNodeView,
  TreeData,
} from './view-model.ts';
import { NODE_STATUS_META, PLANNING_STATUS_META } from './view-utils.ts';

/** Rendered word for a slot whose real source is absent (never a fabricated value). */
export const PENDING_LABEL = '待补充';

/** Stage ids in flow order: 准备 → 单变量验证 → 结果比较 → 组合与验证. */
export type ExecutionStageId = 'prepare' | 'verify' | 'compare' | 'combine';

export type ExperimentBranch = 'retained' | 'pruned' | 'needs_more' | null;

export interface ExecutionSourceRef {
  /** The hypothesis NODE behind the experiment, when the tree has one (demo A/B/C shape). */
  hypothesisNode: ResearchNodeView | null;
  /** The scheme NODE whose change the experiment runs, when the tree has one. */
  schemeNode: ResearchNodeView | null;
  /** The selected brainstorm idea a planning-graph hypothesis is bound to. */
  idea: ResearchIdeaView | null;
}

export interface ExecutionCard {
  /** Real node id — clicking selects exactly this node in the shared inspector. */
  nodeId: string;
  /** Stable E-number of a real/planned run ('E1'…); null for a never-run scheme card. */
  no: string | null;
  /** 动作: how this node is executed (单变量验证 / 实验试制 / …). */
  action: string;
  title: string;
  status: ResearchNodeView['status'];
  statusLabel: string;
  planningLabel: string | null;
  /** True only when the run status is 待进行 and no gate blocks it. */
  executable: boolean;
  /** Concrete blocker of an executable-later experiment, e.g. 等待协议确认. */
  blockedReason: string | null;
  /** 改什么. */
  change: string | null;
  /** 看什么指标. */
  metrics: string | null;
  /** 完成条件 (from the plan); independent of 完成情况 below. */
  doneWhen: string | null;
  /** 完成情况 — the real recorded outcome, when one exists. */
  outcome: string | null;
  /** 详细配置 rows (linked experiment record), for the expandable section. */
  configRows: ExperimentView['config'] | null;
  /** Plan notes worth expanding: idea cost/risk/open questions, run diagnostics. */
  planNotes: Array<{ name: string; value: string }> | null;
  sources: ExecutionSourceRef;
  /** 保留 / 淘汰 / 待补验证 — derived decision vocabulary, null = 未决策. */
  branch: ExperimentBranch;
  /** The recorded 依据 for the branch (rationale / failure note), when there is one. */
  branchBasis: string | null;
  failureNote: string | null;
}

export interface PrepareCard {
  nodeId: string;
  kindLabel: string;
  title: string;
  planningLabel: string | null;
  /** Note/summary explaining this preparation item (real text, may be null). */
  note: string | null;
}

export interface OutcomeCard {
  nodeId: string;
  kindLabel: string;
  title: string;
  statusLabel: string;
  summary: string;
  outcome: string | null;
  rationale: string | null;
}

export interface NextStep {
  kind: 'run' | 'unblock' | 'recover';
  /** The experiment node the recommendation is about (null only for kind 'unblock' with no single node). */
  nodeId: string | null;
  /** One-line recommendation, e.g. 先做 E2「标题」 / 先解除阻塞：等待协议确认. */
  text: string;
  /** The concrete facts behind the recommendation. */
  detail: string | null;
}

export interface ExecutionCounts {
  total: number;
  done: number;
  inProgress: number;
  failed: number;
  blocked: number;
  planned: number;
  pruned: number;
}

export interface ExecutionGraphModel {
  prepare: PrepareCard[];
  experiments: ExecutionCard[];
  /** 结果比较 stage: real result nodes, possibly empty. */
  results: OutcomeCard[];
  /** 组合与验证 stage: real conclusion nodes, possibly empty. */
  conclusions: OutcomeCard[];
  /** Honest empty-stage notes; non-null only when that stage has no real nodes. */
  emptyNotes: Partial<Record<ExecutionStageId, string>> | null;
  /** Preparation items that still gate every experiment, e.g. 基线待确认. */
  prepareBlockers: string[];
  counts: ExecutionCounts;
  next: NextStep | null;
}

export interface ExecutionExtras {
  /** Bootstrap ideas by stable id — planning-graph hypotheses carry ideaRef. */
  ideaById?: ReadonlyMap<string, ResearchIdeaView> | null;
  /** Experiment records by experimentKey — experiment nodes link to them. */
  experimentByKey?: ReadonlyMap<string, ExperimentView> | null;
}

// ---------------------------------------------------------------------------
// small structural helpers
// ---------------------------------------------------------------------------

function prepareKind(kind: ResearchNodeView['kind']): boolean {
  return kind === 'goal' || kind === 'question' || kind === 'baseline' || kind === 'protocol';
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/** Stable card order: by real node id, so input order never changes the output. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 准备 stage reading order: 研究目标 → 问题 → 基线 → 协议 (the reader meets the
 * goal before the things it is measured against), then by node id within a kind.
 */
const PREPARE_ORDER: Record<string, number> = { 研究目标: 0, 问题: 1, 基线: 2, 协议: 3 };

function byPrepareOrder(a: PrepareCard, b: PrepareCard): number {
  const rankOf = (card: PrepareCard): number => PREPARE_ORDER[card.kindLabel] ?? 4;
  const byRank = rankOf(a) - rankOf(b);
  if (byRank !== 0) return byRank;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

/** Neighbours of one end of the node (either edge direction), by kind predicate. */
function neighbours(
  nodeId: string,
  edges: ResearchEdgeView[],
  byNodeId: Map<string, ResearchNodeView>,
  accept: (node: ResearchNodeView) => boolean,
): ResearchNodeView[] {
  const found: ResearchNodeView[] = [];
  for (const edge of edges) {
    const other = edge.sourceId === nodeId ? byNodeId.get(edge.targetId)
      : edge.targetId === nodeId ? byNodeId.get(edge.sourceId)
        : undefined;
    if (other !== undefined && accept(other) && !found.some((n) => n.id === other.id)) found.push(other);
  }
  return found;
}

/** The experiment record a node links to (links kind 'experiment'), if any. */
function linkedExperiment(node: ResearchNodeView, extras: ExecutionExtras): ExperimentView | null {
  const key = node.links.find((l) => l.kind === 'experiment')?.key;
  if (key === undefined) return null;
  return extras.experimentByKey?.get(key) ?? null;
}

// ---------------------------------------------------------------------------
// per-experiment derivation
// ---------------------------------------------------------------------------

function planningLabelOf(node: ResearchNodeView): string | null {
  if (node.planningStatus === undefined || node.planningStatus === null || node.planningStatus === 'not_planned') return null;
  return PLANNING_STATUS_META[node.planningStatus].label;
}

/** The concrete blocker sentence. Priority: run-status block > own plan > gated prerequisite. */
function blockedReasonOf(
  node: ResearchNodeView,
  gates: ResearchNodeView[],
): string | null {
  if (node.status === 'blocked') {
    return text(node.summary) ?? text(node.outcome) ?? '被前置条件阻塞（未记录具体原因）';
  }
  if (node.planningStatus === 'draft') return '等待协议确认（规划草稿）';
  if (node.planningStatus === 'needs_confirmation') return '等待协议确认';
  if (node.planningStatus === 'needs_validation') return '等待补验证';
  for (const gate of gates) {
    if (gate.planningStatus === 'needs_confirmation' || gate.planningStatus === 'draft') {
      const label = planningLabelOf(gate) ?? '待确认';
      return `等待「${gate.title}」确认（${label}）`;
    }
  }
  return null;
}

/** 保留 / 淘汰 / 待补验证 — only where a recorded fact carries the decision. */
function branchOf(
  node: ResearchNodeView,
  scheme: ResearchNodeView | null,
  result: ResearchNodeView | null,
): { branch: ExperimentBranch; basis: string | null } {
  // A failed RUN needs a rerun — that is the current fact about this experiment.
  if (node.status === 'failed') {
    return { branch: 'needs_more', basis: text(node.failureNote) ?? text(node.outcome) ?? text(node.summary) };
  }
  // A pruned scheme/experiment is 淘汰, with the recorded 剪枝依据.
  if (node.status === 'pruned') return { branch: 'pruned', basis: text(node.rationale) };
  if (scheme !== null && scheme.status === 'pruned') return { branch: 'pruned', basis: text(scheme.rationale) };
  // 保留 needs EVIDENCE OF A RUN: a finished/ongoing run whose scheme was kept.
  if (node.status === 'done' || node.status === 'in_progress' || node.status === 'retained' || node.status === 'expanded') {
    if (scheme !== null && (scheme.status === 'retained' || scheme.status === 'expanded')) {
      return { branch: 'retained', basis: text(scheme.rationale) };
    }
    if (result !== null && (result.status === 'done' || result.status === 'retained')) {
      return { branch: 'retained', basis: text(result.rationale) ?? text(result.outcome) };
    }
  }
  return { branch: null, basis: null };
}

function planNotesOf(
  idea: ResearchIdeaView | null,
  experiment: ExperimentView | null,
): Array<{ name: string; value: string }> | null {
  const rows: Array<{ name: string; value: string }> = [];
  if (idea !== null) {
    const costRisk = text(idea.costRisk);
    if (costRisk !== null) rows.push({ name: '成本 / 风险', value: costRisk });
    if (idea.pendingQuestions.length > 0) rows.push({ name: '待解问题', value: idea.pendingQuestions.join('；') });
  }
  const diagnostics = experiment === null ? null : text(experiment.diagnostics);
  if (diagnostics !== null) {
    rows.push({ name: '运行诊断', value: diagnostics });
  }
  return rows.length === 0 ? null : rows;
}

function experimentCard(
  node: ResearchNodeView,
  no: string | null,
  action: string,
  ctx: {
    edges: ResearchEdgeView[];
    byNodeId: Map<string, ResearchNodeView>;
    extras: ExecutionExtras;
  },
): ExecutionCard {
  const { edges, byNodeId, extras } = ctx;
  const idea = node.ideaRef === null || node.ideaRef === undefined ? null : extras.ideaById?.get(node.ideaRef) ?? null;
  const experiment = linkedExperiment(node, extras);
  // Sources: bootstrap hypotheses ARE the planned validation of a selected idea;
  // legacy trees feed an experiment from a scheme (which follows a hypothesis).
  const scheme = idea === null
    ? neighbours(node.id, edges, byNodeId, (n) => n.kind === 'scheme')[0] ?? null
    : null;
  const hypothesisNode = idea === null
    ? (scheme === null
        ? neighbours(node.id, edges, byNodeId, (n) => n.kind === 'hypothesis')[0] ?? null
        : neighbours(scheme.id, edges, byNodeId, (n) => n.kind === 'hypothesis')[0] ?? null)
    : null;
  const result = neighbours(node.id, edges, byNodeId, (n) => n.kind === 'result')[0] ?? null;
  const gates = neighbours(node.id, edges, byNodeId, (n) => prepareKind(n.kind));

  const change = idea !== null
    ? text(idea.atomicChange) ?? text(node.summary)
    : scheme !== null
      ? text(scheme.summary) ?? text(scheme.title)
      : experiment !== null && experiment.componentRefs.length > 0
        ? experiment.componentRefs.map((c) => c.label).join(' ＋ ')
        : null;
  const metrics = idea !== null
    ? (idea.targetMetrics.length > 0 ? idea.targetMetrics.join('、') : null)
    : experiment !== null && experiment.metricRows.length > 0
      ? [...new Set(experiment.metricRows.map((m) => m.name))].join('、')
      : null;
  const doneWhen = idea !== null ? text(idea.validationPlan) : null;

  const { branch, basis } = branchOf(node, scheme, result);
  const blockedReason = blockedReasonOf(node, gates);

  return {
    nodeId: node.id,
    no,
    action,
    title: node.title,
    status: node.status,
    statusLabel: NODE_STATUS_META[node.status]?.label ?? node.status,
    planningLabel: planningLabelOf(node),
    executable: node.status === 'planned' && blockedReason === null,
    blockedReason,
    change,
    metrics,
    doneWhen,
    outcome: text(node.outcome),
    configRows: experiment !== null && experiment.config.length > 0 ? experiment.config : null,
    planNotes: planNotesOf(idea, experiment),
    sources: { hypothesisNode, schemeNode: scheme, idea },
    branch,
    branchBasis: basis,
    failureNote: text(node.failureNote),
  };
}

// ---------------------------------------------------------------------------
// stage assembly
// ---------------------------------------------------------------------------

const EMPTY_NOTE_COMPARE = '尚无结果节点。单变量验证完成后，比较结果与保留 / 淘汰 / 补验证的依据会出现在这里；未运行前不生成占位结果。';
const EMPTY_NOTE_COMBINE = '尚无组合与结论节点。有效组件确定后再规划组合、消融与稳健性实验；本页不预填未规划的实验。';

export function buildExecutionGraph(data: TreeData, extras: ExecutionExtras = {}): ExecutionGraphModel {
  const byNodeId = new Map(data.nodes.map((n) => [n.id, n] as const));
  const edges = data.edges;
  const nodes = [...data.nodes].sort(byId);

  const prepare: PrepareCard[] = [];
  const experiments: ExecutionCard[] = [];
  const results: OutcomeCard[] = [];
  const conclusions: OutcomeCard[] = [];
  // hypothesis/scheme nodes already shown as the 来源 of an experiment card.
  const absorbed = new Set<string>();
  // hypothesis/scheme nodes with NO experiment anywhere downstream — they keep a
  // card so a pruned scheme can never silently disappear (淘汰 + 依据 stay visible).
  const unabsorbedSources: ResearchNodeView[] = [];

  const ctx = { edges, byNodeId, extras };
  const experimentNodes: ResearchNodeView[] = [];
  const sourceNodes: ResearchNodeView[] = [];

  for (const node of nodes) {
    if (prepareKind(node.kind)) {
      prepare.push({
        nodeId: node.id,
        kindLabel: node.kind === 'goal' ? '研究目标' : node.kind === 'question' ? '问题' : node.kind === 'baseline' ? '基线' : '协议',
        title: node.title,
        planningLabel: planningLabelOf(node),
        note: text(node.summary),
      });
      continue;
    }
    if (node.kind === 'experiment') {
      experimentNodes.push(node);
      continue;
    }
    if (node.kind === 'hypothesis' && node.ideaRef !== null && node.ideaRef !== undefined) {
      // Bootstrap planning shape: the selected idea's planned single-variable
      // validation IS the experiment to run next.
      experimentNodes.push(node);
      continue;
    }
    if (node.kind === 'hypothesis' || node.kind === 'scheme') {
      sourceNodes.push(node);
      continue;
    }
    if (node.kind === 'result') {
      results.push({
        nodeId: node.id, kindLabel: '结果', title: node.title,
        statusLabel: NODE_STATUS_META[node.status]?.label ?? node.status,
        summary: text(node.summary) ?? '', outcome: text(node.outcome), rationale: text(node.rationale),
      });
      continue;
    }
    if (node.kind === 'conclusion') {
      conclusions.push({
        nodeId: node.id, kindLabel: '结论', title: node.title,
        statusLabel: NODE_STATUS_META[node.status]?.label ?? node.status,
        summary: text(node.summary) ?? '', outcome: text(node.outcome), rationale: text(node.rationale),
      });
    }
  }

  // Which hypothesis/scheme nodes feed an experiment card (either 1 or 2 hops)?
  for (const source of sourceNodes) {
    const direct = neighbours(source.id, edges, byNodeId, (n) =>
      n.kind === 'experiment' || (n.kind === 'hypothesis' && n.ideaRef !== null && n.ideaRef !== undefined));
    const viaScheme = source.kind === 'hypothesis'
      ? neighbours(source.id, edges, byNodeId, (n) => n.kind === 'scheme').some((scheme) =>
        neighbours(scheme.id, edges, byNodeId, (n) => n.kind === 'experiment').length > 0)
      : false;
    if (direct.length > 0 || viaScheme) absorbed.add(source.id);
    else unabsorbedSources.push(source);
  }

  let counter = 0;
  for (const node of experimentNodes) {
    counter += 1;
    experiments.push(experimentCard(node, `E${counter}`, node.kind === 'experiment' ? '实验' : '单变量验证', ctx));
  }
  // A hypothesis/scheme that never produced an experiment keeps a card of its own.
  for (const node of unabsorbedSources) {
    counter += 1;
    const asCard = experimentCard(node, null, node.kind === 'scheme' ? '方案' : '假设', ctx);
    experiments.push(asCard);
  }

  const counts: ExecutionCounts = {
    total: experiments.length,
    done: experiments.filter((c) => c.status === 'done').length,
    inProgress: experiments.filter((c) => c.status === 'in_progress').length,
    failed: experiments.filter((c) => c.status === 'failed').length,
    blocked: experiments.filter((c) => c.status === 'blocked').length,
    planned: experiments.filter((c) => c.status === 'planned' || (c.no === null && c.status !== 'pruned')).length,
    pruned: experiments.filter((c) => c.status === 'pruned').length,
  };

  const prepareBlockers = prepare
    .filter((p) => {
      const node = byNodeId.get(p.nodeId);
      return node !== undefined && (node.planningStatus === 'needs_confirmation' || node.planningStatus === 'draft');
    })
    .map((p) => `「${p.kindLabel}」${p.title}：${p.planningLabel ?? '待确认'}`);

  // 准备 stage reads goal → question → baseline → protocol (deterministic: kind
  // rank first, node id inside a kind).
  prepare.sort(byPrepareOrder);

  const emptyNotes: Partial<Record<ExecutionStageId, string>> = {};
  if (results.length === 0) emptyNotes.compare = EMPTY_NOTE_COMPARE;
  if (conclusions.length === 0) emptyNotes.combine = EMPTY_NOTE_COMBINE;

  return {
    prepare,
    experiments,
    results,
    conclusions,
    emptyNotes: Object.keys(emptyNotes).length === 0 ? null : emptyNotes,
    prepareBlockers,
    counts,
    next: nextStepOf(experiments, prepareBlockers),
  };
}

/** The 下一步 recommendation — first executable, else first blocked, else first failed. */
export function nextStepOf(experiments: ExecutionCard[], prepareBlockers: string[]): NextStep | null {
  const executable = experiments.find((c) => c.executable);
  if (executable !== undefined) {
    const facts = [
      executable.change !== null ? `改什么：${clip(executable.change, 60)}` : null,
      executable.metrics !== null ? `看什么：${executable.metrics}` : null,
      `完成条件：${executable.doneWhen ?? PENDING_LABEL}`,
    ].filter((f): f is string => f !== null);
    return {
      kind: 'run',
      nodeId: executable.nodeId,
      text: `先做 ${executable.no}「${executable.title}」`,
      detail: facts.join('；'),
    };
  }
  const blocked = experiments.find((c) => c.blockedReason !== null);
  if (blocked !== undefined) {
    const extra = prepareBlockers.length > 0 ? `。同时需先处理：${prepareBlockers[0]}` : '';
    return {
      kind: 'unblock',
      nodeId: blocked.nodeId,
      text: `先解除阻塞：${blocked.no ?? ''} ${blocked.blockedReason ?? ''}`.trim(),
      detail: `${blocked.no ?? ''}「${blocked.title}」${blocked.blockedReason ?? ''}${extra}`.trim(),
    };
  }
  const recover = experiments.find((c) => c.branch === 'needs_more');
  if (recover !== undefined) {
    return {
      kind: 'recover',
      nodeId: recover.nodeId,
      text: `补跑并复核 ${recover.no}「${recover.title}」`,
      detail: recover.branchBasis,
    };
  }
  return null;
}

function clip(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max ? value : `${chars.slice(0, max).join('')}…`;
}

/** Progress sentence for the next-step card, from real counts only. */
export function progressText(counts: ExecutionCounts): string {
  if (counts.total === 0) return '尚无实验计划。';
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`已完成 ${counts.done}`);
  if (counts.inProgress > 0) parts.push(`进行中 ${counts.inProgress}`);
  if (counts.failed > 0) parts.push(`待补验证 ${counts.failed}`);
  if (counts.blocked > 0) parts.push(`阻塞 ${counts.blocked}`);
  if (counts.pruned > 0) parts.push(`已剪枝 ${counts.pruned}`);
  const plannedTotal = counts.total - counts.done - counts.inProgress - counts.failed - counts.blocked - counts.pruned;
  if (plannedTotal > 0) parts.push(`计划中 ${plannedTotal}`);
  return `共 ${counts.total} 个实验：${parts.join(' · ')}`;
}

export const BRANCH_META: Record<Exclude<ExperimentBranch, null>, { label: string; cls: string }> = {
  retained: { label: '保留', cls: 'rd-chip-green' },
  pruned: { label: '淘汰', cls: 'rd-chip-red' },
  needs_more: { label: '待补验证', cls: 'rd-chip-yellow' },
};
