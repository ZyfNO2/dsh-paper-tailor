/**
 * BR-FE3 — deterministic DAG → Mermaid flowchart generation (Plan §7).
 *
 * Pure and Node-testable; the .tsx only renders the produced text and maps clicks back.
 * Rules enforced here:
 * - every REAL node and edge is emitted — branches are never collapsed into a fake chain;
 * - labels carry only type + short title + planning status; full titles, sources and Slot
 *   snapshots stay in the existing detail panel;
 * - node ids are safe generated ids (`n0…`) mapped 1:1 to real nodeIds; lookup is by the
 *   map, never by title or layout order;
 * - user titles and paper content are ESCAPED — only program-generated syntax is emitted,
 *   so a title containing quotes, newlines, HTML or graph syntax cannot inject nodes,
 *   edges, clicks or scripts;
 * - direction defaults to LR, TB on narrow screens.
 */
import type { ResearchEdgeView, ResearchNodeView } from './view-model.ts';

export interface MermaidGraph {
  /** The complete `flowchart …` source to hand to mermaid.render. */
  text: string;
  /** Safe id → real nodeId, for click/keyboard/cross-page navigation. */
  idMap: Map<string, string>;
  nodeCount: number;
  edgeCount: number;
}

const KIND_LABEL: Record<string, string> = {
  goal: '目标', question: '问题', baseline: '基线', hypothesis: '假设', scheme: '方案',
  protocol: '协议', experiment: '实验', result: '结果', conclusion: '结论',
};

const PLANNING_LABEL: Record<string, string> = {
  draft: '草稿', needs_confirmation: '待确认', confirmed: '已确认',
  needs_validation: '待验证', not_planned: '',
};

/**
 * Mermaid flowchart is line-oriented: strip newlines, quotes, brackets and colons from
 * labels, and collapse dash runs. Inside quotes `--` and `:::` would parse as text, but
 * collapsing them removes any parser-quirk risk — labels are truncated display-only text
 * and the full title always stays in the detail panel.
 */
export function escapeLabel(value: string, maxChars = 32): string {
  const flat = value.replace(/[\r\n]+/g, ' ').replace(/["#:;<>`{}[\]()|]/g, '').replace(/-{2,}/g, '-');
  const chars = [...flat.trim().replace(/\s+/g, ' ')];
  return chars.length <= maxChars ? chars.join('') : `${chars.slice(0, maxChars).join('')}…`;
}

/** Stable safe id: position in the (already deterministic) node order. */
export function safeNodeId(index: number): string {
  return `n${index}`;
}

/** Node shape by kind: decisions/diamonds for branch points, stadium for results. */
function nodeShape(kind: string, safeId: string, label: string): string {
  if (kind === 'question' || kind === 'hypothesis') return `${safeId}{{"${label}"}}`;
  if (kind === 'result' || kind === 'conclusion') return `${safeId}(["${label}"])`;
  return `${safeId}["${label}"]`;
}

/** Class name for status/type colouring; the stylesheet maps these (with legend). */
function nodeClass(node: ResearchNodeView): string {
  if (node.status === 'failed') return 'stFailed';
  if (node.status === 'pruned') return 'stPruned';
  if (node.status === 'done') return 'stDone';
  if (node.status === 'in_progress') return 'stActive';
  if (node.planningStatus === 'confirmed') return 'stConfirmed';
  if (node.kind === 'experiment') return 'stExperiment';
  if (node.kind === 'baseline') return 'stBaseline';
  return 'stDefault';
}

export function toMermaidFlowchart(
  nodes: ResearchNodeView[],
  edges: ResearchEdgeView[],
  direction: 'LR' | 'TB' = 'LR',
): MermaidGraph {
  const idMap = new Map<string, string>();
  const lines: string[] = [`flowchart ${direction}`];
  const order = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const indexOf = new Map(order.map((node, index) => [node.id, index] as const));

  for (const [index, node] of order.entries()) {
    const safeId = safeNodeId(index);
    idMap.set(safeId, node.id);
    const kindLabel = KIND_LABEL[node.kind] ?? node.kind;
    const planning = node.planningStatus !== undefined ? (PLANNING_LABEL[node.planningStatus] ?? '') : '';
    const statusBits = planning !== '' ? ` · ${planning}` : '';
    const label = escapeLabel(`${kindLabel}｜${node.title}${statusBits}`);
    lines.push(`  ${nodeShape(node.kind, safeId, label)}:::${nodeClass(node)}`);
  }

  let edgeCount = 0;
  for (const edge of [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const from = indexOf.get(edge.sourceId);
    const to = indexOf.get(edge.targetId);
    // Dangling edges reference nodes outside this view: listed, never drawn as ghosts.
    if (from === undefined || to === undefined) continue;
    const link = edge.planned ? '-.->' : '-->';
    const label = edge.relation.trim() === '' ? '' : `|"${escapeLabel(edge.relation, 12)}"|`;
    lines.push(`  ${safeNodeId(from)} ${link}${label} ${safeNodeId(to)}`);
    edgeCount += 1;
  }

  lines.push('  classDef stFailed fill:#fde2e2,stroke:#c0392b');
  lines.push('  classDef stPruned fill:#f0f0f0,stroke:#999,stroke-dasharray:4 4');
  lines.push('  classDef stDone fill:#dff0d8,stroke:#3c763d');
  lines.push('  classDef stActive fill:#d9edf7,stroke:#31708f');
  lines.push('  classDef stConfirmed fill:#e8e0f5,stroke:#5b3fa0,stroke-width:2px');
  lines.push('  classDef stExperiment fill:#fef3d9,stroke:#b7791f');
  lines.push('  classDef stBaseline fill:#e6eef7,stroke:#2c5f8a');
  lines.push('  classDef stDefault fill:#ffffff,stroke:#666');
  return { text: `${lines.join('\n')}\n`, idMap, nodeCount: order.length, edgeCount };
}

/** Real node/edge lists for the empty/invalid-graph fallback — never a faked success. */
export function graphFallbackText(nodes: ResearchNodeView[], edges: ResearchEdgeView[]): string {
  const lines = [`节点 ${nodes.length} 个，关系 ${edges.length} 条（图渲染不可用，显示真实列表）：`];
  for (const node of nodes) lines.push(`- ${node.kind}｜${node.title}［${node.status}］`);
  for (const edge of edges) lines.push(`- ${edge.sourceId} → ${edge.targetId}（${edge.relation || '关联'}）`);
  return lines.join('\n');
}
