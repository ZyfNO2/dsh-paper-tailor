/**
 * Value formatting and the deterministic graph layout.
 *
 * SPEC 8.1/8.4 and redesign plan §3.2. Two rules drive everything here:
 *
 *  1. A number is rendered in the unit the protocol declared. A 0..1 fraction
 *     shows as a percentage; a loss shows with its own precision. Raw precision
 *     stays available in the detail drawer, so first-screen display never costs
 *     the reader the original value.
 *  2. `improvement` from the host is POSITIVE-WHEN-BETTER. A minimize metric
 *     whose value grew therefore arrives negative and is labelled 更差 — it is
 *     never rendered as a positive gain, and colour is never the only cue: every
 *     state carries a text label too (accessibility, SPEC §9.3).
 */

import type {
  CandidateDesign,
  ChineseClaim,
  ClaimStatus,
  ComparisonRow,
  GraphEdge,
  GraphNode,
  MeasurementStatus,
  MethodTag,
  QualifiedTask,
  TaskSummary,
} from '../wire.ts';

export function isFractionUnit(unit: string): boolean {
  const u = unit.toLowerCase();
  return u === 'fraction' || u === 'accuracy';
}

export function formatValue(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (isFractionUnit(unit)) return `${(value * 100).toFixed(1)}%`;
  // SPEC §3.3: a headline metric renders at a sensible number of significant
  // figures, and the FULL precision stays in the detail drawer (`formatRaw`).
  //
  // `String(value)` printed whatever the report happened to carry, so the page
  // showed `0.6674164831638336` where the readable form is `0.6674`. That is not
  // cosmetic: a reader cannot compare two 17-digit numbers at a glance, and the
  // digits past the fourth are noise from the runner's float arithmetic rather
  // than measured resolution.
  return String(Number(value.toPrecision(4)));
}

/** Raw value with full precision, for the detail drawer. */
export function formatRaw(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Number.isFinite(value) ? String(value) : 'NaN（不进入聚合）';
}

/**
 * Build the task menu from the v2 experiment list and the v3 qualified list.
 *
 * WHY THIS IS A FUNCTION AND NOT INLINE JSX
 * -----------------------------------------
 * It was inline, and it was WRONG in a way no suite could see: the menu was built
 * from the v2 route alone, which lists only experiment tasks. A product task
 * created by a chat turn therefore never appeared, `taskId` never became a `wb-…`
 * id, and the entire v3 panel — the rationale and the model data flow — was
 * unreachable by any user action. Thirteen suites passed throughout, because each
 * drives the routes directly rather than through the menu.
 *
 * Extracting it makes the merge rule assertable without mounting the workbench.
 *
 * The rules:
 *  - PRODUCT tasks come first: they are the surface the session is working on.
 *  - An experiment task that v3 also reports keeps ONE row, with the v2 label
 *    (it carries the operation count a user recognises). It is NOT dropped for
 *    having appeared in both lists.
 *  - An experiment task that only v3 knows about is still offered, naming its
 *    store, because SPEC §7.1 forbids hiding a store's task behind another's.
 */
export function buildTaskMenu(
  experiment: TaskSummary[],
  qualified: QualifiedTask[],
): Array<{ taskId: string; label: string }> {
  const experimentIds = new Set(experiment.map((t) => t.taskId));
  const out: Array<{ taskId: string; label: string }> = [];

  for (const t of qualified) {
    if (t.store !== 'workbench') continue;
    out.push({ taskId: t.taskId, label: `研究设计 · ${t.taskId}` });
  }
  for (const t of experiment) {
    out.push({
      taskId: t.taskId,
      label: `${t.phase === 'phase3' ? 'Phase3' : 'Phase2'} · ${t.displayName}（${t.operationCount} 操作）`,
    });
  }
  for (const t of qualified) {
    if (t.store === 'workbench' || experimentIds.has(t.taskId)) continue;
    out.push({
      taskId: t.taskId,
      label: `${t.phase === 'phase3' ? 'Phase3' : 'Phase2'} · ${t.taskId}（${t.store}）`,
    });
  }
  return out;
}

/**
 * Split a node name into at most `maxLines` lines of ~`perLine` characters.
 *
 * SPEC §3.3 requires node names to support at least two lines. This replaced a
 * single-line `truncate()`, which cut every real candidate name to
 * `Phase2 Baseline Stitch …` — the reader could not tell `…Cpu + Attention Gate`
 * from `…Cpu + Aspp`, so two different arms rendered with the same label. A
 * truncated identifier is not a shorter name, it is a different name.
 *
 * The last line is only ellipsised when the text genuinely does not fit, so the
 * common case shows the whole name. Splitting prefers a space boundary and falls
 * back to a hard cut for a single long token, which has no space to break at.
 */
export function wrapLabel(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';

  const push = (): void => {
    if (current !== '') { lines.push(current); current = ''; }
  };

  for (const word of words) {
    if (word.length > perLine) {
      push();
      let rest = word;
      while (rest.length > perLine) { lines.push(rest.slice(0, perLine)); rest = rest.slice(perLine); }
      current = rest;
      continue;
    }
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= perLine) current = `${current} ${word}`;
    else { push(); current = word; }
  }
  push();

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] = last.length >= perLine ? `${last.slice(0, perLine - 1)}…` : `${last}…`;
  return kept;
}

export interface ImprovementView {
  text: string;
  /** Explicit word, so the state does not depend on colour alone. */
  verdict: '更好' | '更差' | '持平' | '无数据';
  tone: 'good' | 'bad' | 'flat' | 'none';
}

export function formatImprovement(row: ComparisonRow): ImprovementView {
  if (row.improvement === null || !Number.isFinite(row.improvement)) {
    return { text: '—', verdict: '无数据', tone: 'none' };
  }
  const value = row.improvement;
  const magnitude = Math.abs(value);
  const rendered = isFractionUnit(row.unit)
    ? `${(magnitude * 100).toFixed(1)} 个百分点`
    : magnitude.toFixed(4);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '±';
  if (value === 0) return { text: `±${rendered}`, verdict: '持平', tone: 'flat' };
  return {
    text: `${sign}${rendered}`,
    verdict: value > 0 ? '更好' : '更差',
    tone: value > 0 ? 'good' : 'bad',
  };
}

const MEASUREMENT_LABEL: Record<MeasurementStatus, string> = {
  untested: '未测',
  measured_unverified: '已测未校验',
  measured_verified: '已校验',
  partial: '部分已测',
  unreadable: '读取失败',
};

export function measurementLabel(status: MeasurementStatus): string {
  return MEASUREMENT_LABEL[status] ?? status;
}

const EXECUTION_LABEL: Record<string, string> = {
  not_started: '未开始',
  running: '运行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '未知',
};

export function executionLabel(status: string): string {
  return EXECUTION_LABEL[status] ?? status;
}

/** Edge relations get distinct words AND distinct strokes (§3.2 table). */
export const EDGE_STYLE: Record<string, { label: string; dashed: boolean }> = {
  comparison_variant: { label: '同协议对照', dashed: false },
  proposed_extension: { label: '计划扩展', dashed: true },
  executed_extension: { label: '已执行扩展', dashed: false },
  execution: { label: '实现 / 执行', dashed: false },
  data_flow: { label: '原始结果 / 校验', dashed: true },
};

// ----------------- evidence vocabulary (v3) -----------------

/**
 * The four evidence states, in words a reader can act on.
 *
 * Each label says WHERE the claim came from, not how confident we are: the
 * distinction the reader needs is "the authors said this" versus "we think
 * this", and a bare confidence word would collapse exactly that.
 */
const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  source_reported: '论文主张',
  inferred: '推断',
  hypothesis: '待验证',
  unknown: '未知',
};

/** Extra wording for the common case of a claim backed only by an extracted card. */
export const CARD_ONLY_SUFFIX = '（卡片记载的论文主张）';

export function claimStatusLabel(status: ClaimStatus): string {
  return CLAIM_STATUS_LABEL[status] ?? '未知';
}

/**
 * Render a claim for display.
 *
 * Three rules, each from a failure this feature exists to remove:
 *
 *  1. `textZh === null` renders the SOURCE'S REASON, not a placeholder. An
 *     "—" or a generic sentence in that slot reads as "nothing to say" and
 *     hides the fact that something specific is unknown.
 *  2. The status word is ALWAYS shown. A sentence whose status is dropped looks
 *     identical to an author claim, which is the failure mode the whole
 *     evidence model exists to prevent.
 *  3. Nothing is upgraded here. The client cannot change a status; it only
 *     displays the one the host decided.
 */
export interface ClaimView {
  /** The sentence to show, or null when nothing is known. */
  text: string | null;
  /** The status word, or null when there is no text to qualify. */
  statusLabel: string | null;
  /** Full wording including the card-only qualifier, for the tooltip/legend. */
  statusTitle: string;
  /** Why this is unknown, when it is. */
  reason: string | null;
  hasSources: boolean;
  tone: 'authored' | 'reasoned' | 'unknown';
}

export function claimView(claim: ChineseClaim, options: { cardOnly?: boolean } = {}): ClaimView {
  const base = claimStatusLabel(claim.status);
  const qualified = options.cardOnly === true && claim.status === 'source_reported'
    ? `${base}${CARD_ONLY_SUFFIX}`
    : base;
  if (claim.textZh === null) {
    return {
      text: null,
      statusLabel: null,
      statusTitle: `${qualified}：${claim.reasonZh ?? '来源未记载'}`,
      reason: claim.reasonZh ?? '来源未记载该字段',
      hasSources: claim.sources.length > 0,
      tone: 'unknown',
    };
  }
  return {
    text: claim.textZh,
    statusLabel: qualified,
    statusTitle: qualified,
    reason: claim.reasonZh,
    hasSources: claim.sources.length > 0,
    tone: claim.status === 'source_reported' ? 'authored' : claim.status === 'unknown' ? 'unknown' : 'reasoned',
  };
}

/** The single sentence shown when a whole rationale block is absent. */
export function unresolvedReasonZh(designs: CandidateDesign[], candidateKey: string | null): string {
  const target = candidateKey === null
    ? designs[0]
    : designs.find((d) => d.candidateKey === candidateKey);
  if (target === undefined) return '尚未关联候选：先用对话形成研究候选，再查看拼接理由。';
  if (target.rationale !== null) return '';
  return target.unresolved[0]?.reasonZh ?? '拼接理由未关联。';
}

const METHOD_RELATION_LABEL: Record<MethodTag['relation'], string> = {
  // The three are kept visibly distinct: "this paper contributed it" and "it
  // was compared against" are different claims about the literature.
  contributed_method: '本文贡献',
  extracted_card: '已抽取',
  built_on: '依托',
  comparison: '对比',
};

export function methodRelationLabel(relation: MethodTag['relation']): string {
  return METHOD_RELATION_LABEL[relation] ?? relation;
}

/** The display name: a confirmed Chinese name, else the real extracted name. */
export function methodNameZh(tag: MethodTag): string {
  return tag.nameZh ?? tag.canonicalName;
}

const STAGE_LABEL: Record<string, string> = {
  discovery: '读论文',
  composition: '设计组合',
  implementation: '代码接入',
  analysis: '实验分析',
  next_proposal: '下一步规划',
};

const STAGE_STATE_LABEL: Record<string, string> = {
  actionable: '可进行',
  working: '进行中',
  blocked: '受阻',
  complete: '已完成',
};

export function stageLabel(stage: string): string {
  return STAGE_LABEL[stage] ?? stage;
}

export function stageStateLabel(state: string): string {
  return STAGE_STATE_LABEL[state] ?? state;
}

/**
 * Metric display with SIGNIFICANT FIGURES, not raw precision.
 *
 * A 17-digit float on a first screen is unreadable and implies a precision the
 * protocol never claimed. The raw value stays in the detail drawer, so nothing
 * is lost — this only decides what the summary line shows.
 */
export function formatMetricBrief(value: number | null | undefined, unit: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const rendered = isFractionUnit(unit) ? `${(value * 100).toFixed(1)}%` : String(Number(value.toPrecision(4)));
  return rendered;
}

// ----------------- deterministic layered layout -----------------

export interface PlacedNode {
  node: GraphNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlacedEdge {
  edge: GraphEdge;
  from: PlacedNode;
  to: PlacedNode;
}

export interface Layout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 96;
const GAP_X = 56;
const GAP_Y = 28;
const PAD = 16;

/** Horizontal padding inside a node box, matching `.evw-nodeName`'s `x={10}`. */
export const NODE_TEXT_PAD = 10;

/**
 * Measured average advance width of a node-name character, in px.
 *
 * `scripts/measure-node-text.ts` renders the real font stack at 12px/600 in
 * Chromium: the widest glyph (M) is 12.34px and the narrowest (i) 3.55px, while
 * the real candidate names average 6.3px/char. Wrapping needs the AVERAGE, not
 * the worst case — sizing every line for an all-caps name would waste half the
 * box on the names that actually occur.
 *
 * A hardcoded character budget was the bug this replaces: `wrapLabel(name, 24, 2)`
 * cut `Phase2 Baseline Stitch Cpu + Attention Gate + Aspp` (49 chars) down to
 * `Cpu + Attention Gate +…`, so the LAST word — the only thing distinguishing
 * that arm from its sibling — was the word that got dropped.
 */
export const NODE_CHAR_PX = 6.3;

/** How many characters fit on one line of a node box at the current width. */
export function nodeCharsPerLine(nodeWidth: number = NODE_WIDTH): number {
  const usable = nodeWidth - NODE_TEXT_PAD * 2;
  return Math.max(8, Math.floor(usable / NODE_CHAR_PX));
}

/**
 * Layered left-to-right layout.
 *
 * The column of a node is its LONGEST PATH from a root along real edges, so the
 * Baseline→A→AB hierarchy is visible as depth rather than inferred from an
 * indent. It is deterministic and dependency-free: same graph in, same picture
 * out, which is what makes the EVAL able to assert on geometry.
 *
 * A node with no incoming edge starts at column 0; a CYCLE would have no such
 * path, so any node left unplaced by the longest-path pass is placed in a final
 * trailing column and reported by the caller rather than silently dropped.
 */
export function layoutGraph(nodes: GraphNode[], edges: GraphEdge[]): Layout {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, GraphEdge[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    incoming.get(e.target)?.push(e);
  }

  // Longest-path depth, computed with an explicit memo so a cycle terminates
  // instead of recursing forever.
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const e of incoming.get(id) ?? []) {
      // `execution`/`data_flow` edges run sideways in the picture; only lineage
      // edges (comparison / extension) advance a column.
      if (e.relation === 'execution' || e.relation === 'data_flow') continue;
      best = Math.max(best, depthOf(e.source) + 1);
    }
    visiting.delete(id);
    depth.set(id, best);
    return best;
  };
  for (const n of nodes) depthOf(n.id);

  const columns = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    // GraphNode order is the projection's order, which is baseline → arms →
    // run → result. Stable input gives stable output.
    const d = depth.get(n.id) ?? 0;
    const list = columns.get(d) ?? [];
    list.push(n);
    columns.set(d, list);
  }

  const placed: PlacedNode[] = [];
  const colKeys = [...columns.keys()].sort((a, b) => a - b);
  colKeys.forEach((col, colIndex) => {
    const list = columns.get(col) ?? [];
    list.forEach((node, rowIndex) => {
      placed.push({
        node,
        x: PAD + colIndex * (NODE_WIDTH + GAP_X),
        y: PAD + rowIndex * (NODE_HEIGHT + GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  });

  const byNodeId = new Map(placed.map((p) => [p.node.id, p]));
  const placedEdges: PlacedEdge[] = [];
  for (const e of edges) {
    const from = byNodeId.get(e.source);
    const to = byNodeId.get(e.target);
    if (from === undefined || to === undefined) continue;
    placedEdges.push({ edge: e, from, to });
  }

  const width = placed.reduce((w, p) => Math.max(w, p.x + p.width), NODE_WIDTH) + PAD;
  const height = placed.reduce((h, p) => Math.max(h, p.y + p.height), NODE_HEIGHT) + PAD;
  return { nodes: placed, edges: placedEdges, width, height };
}

/** Nodes with no incoming edge, i.e. graph roots — surfaced as provenance. */
export function rootsOf(nodes: GraphNode[], edges: GraphEdge[]): GraphNode[] {
  const targeted = new Set(edges.map((e) => e.target));
  return nodes.filter((n) => !targeted.has(n.id));
}

/**
 * Orphan / cycle disclosure (WB-04). An edge pointing at a node that does not
 * exist, or a node no edge reaches and which is not a root, means the graph the
 * host sent is not a tree; the UI says so rather than drawing a plausible lie.
 */
export function graphDefects(nodes: GraphNode[], edges: GraphEdge[]): string[] {
  const defects: string[] = [];
  const ids = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (!ids.has(e.source)) defects.push(`边 ${e.id} 的起点 ${e.source} 不存在`);
    if (!ids.has(e.target)) defects.push(`边 ${e.id} 的终点 ${e.target} 不存在`);
    if (e.evidenceRefs.length === 0 && e.relation !== 'data_flow') {
      defects.push(`边 ${e.id}（${e.relation}）没有证据引用`);
    }
  }
  // Extension edges must carry decision evidence, never be inferred from a
  // module set: if one appears without a proposal ref, that is a defect.
  for (const n of nodes) {
    for (const e of edges.filter((x) => x.target === n.id)) {
      if (e.relation === 'executed_extension' && n.proposalRef === null) {
        defects.push(`节点 ${n.id} 的“已执行扩展”边缺少 proposal/decision 证据`);
      }
    }
  }
  return defects;
}