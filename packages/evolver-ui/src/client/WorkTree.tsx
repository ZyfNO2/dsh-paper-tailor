/**
 * 工作树：默认视图是一张节点 + 类型化边的数据流图。
 *
 * Redefect R07 (redesign plan §3.2). The rejected v1 view was `lineage.map`
 * rendering an indented list with a 20px child indent: no edges, no hierarchy,
 * no metric deltas. This renders:
 *
 *   - a RESULT SUMMARY first (what the best arm actually did, in one line);
 *   - a layered node/edge graph, deterministic and dependency-free;
 *   - per-node: real module NAMES, status, the primary metric with its
 *     direction, improvement against Baseline, and paired-seed coverage;
 *   - typed edges whose visual style AND word differ (同协议对照 / 计划 / 已执行);
 *   - per-seed raw values, ids, protocol refs and logs in the drawer, not here.
 *
 * Nothing here infers a relationship: a missing edge is a missing edge.
 */

import type { GraphEdge, GraphNode, WorkbenchSnapshot } from '../wire.ts';
import {
  EDGE_STYLE,
  executionLabel,
  formatImprovement,
  formatValue,
  layoutGraph,
  measurementLabel,
  nodeCharsPerLine,
  wrapLabel,
  type Layout,
  type PlacedNode,
} from './format.ts';
import { s } from './styles.ts';

export interface WorkTreeProps {
  region: {
    data: WorkbenchSnapshot | null;
    loading: boolean;
    error: string | null;
    scopeKey: string | null;
    /**
     * Why this region is legitimately empty, when it is — e.g. a product task has
     * no Phase 2/3 experiment tree. Distinct from `error`, because a red box would
     * report a working page as broken.
     */
    emptyReason?: string;
  };
  selection: string | null;
  onSelect: (id: string) => void;
  onOpenPaper: (paperId: string) => void;
  onOpenModule: (moduleId: string) => void;
  onOpenNode: (nodeId: string) => void;
}

export function WorkTree(props: WorkTreeProps): JSX.Element {
  const { region } = props;
  if (region.loading) return <div className={s.empty}>正在读取工作树…</div>;
  if (region.error !== null) {
    return <div className={s.errorBox} role="alert">工作树读取失败：{region.error}</div>;
  }
  const snap = region.data;
  if (snap === null) {
    // A stated reason beats a generic prompt: the reader learns WHY there is
    // nothing here, which for a product task is a fact about the task rather
    // than something they can fix by waiting.
    return <div className={s.empty}>{region.emptyReason ?? '选择或等待一个任务快照。'}</div>;
  }
  if (snap.nodes.length === 0) {
    return (
      <div className={s.empty}>
        本任务没有可展示的节点。
        {snap.issues.length > 0 ? ' 前置说明见上方。' : ''}
      </div>
    );
  }

  const layout = layoutGraph(snap.nodes, snap.edges);

  return (
    <div className={s.section}>
      <ResultSummary snapshot={snap} />
      <GraphCanvas
        layout={layout}
        selection={props.selection}
        onSelect={props.onSelect}
      />
      <EdgeLegend edges={snap.edges} />
      <OperationLog operations={snap.operations} />
    </div>
  );
}

/**
 * One line stating the strongest observed result, chosen by the host's own
 * `complete` flag and positive-when-better `improvement`. It is a SUMMARY of the
 * graph, never a new conclusion: if no arm is complete, it says so instead of
 * promoting the best-looking number.
 */
function ResultSummary(props: { snapshot: WorkbenchSnapshot }): JSX.Element {
  const { snapshot } = props;
  const candidates = snapshot.nodes
    .flatMap((n) => n.comparisons.map((c) => ({ node: n, comparison: c })))
    .filter((x) => x.comparison.complete && x.comparison.improvement !== null);

  if (candidates.length === 0) {
    const anyMeasured = snapshot.nodes.some((n) => n.detail.metricRows.length > 0);
    return (
      <div className={s.summaryBox}>
        <div className={s.summaryHead}>结果摘要</div>
        <div>
          {anyMeasured
            ? '有逐 seed 数据，但没有一条配对完整且方向明确的结论；未展示总体收益。'
            : '本任务没有已测指标；不展示任何收益。'}
        </div>
      </div>
    );
  }

  // Primary metric first: arms can disagree across metrics, and picking "the
  // best" across all of them would be cherry-picking.
  const primaryId = candidates[0]?.comparison.metricId ?? '';
  const pool = candidates.filter((x) => x.comparison.metricId === primaryId);
  const best = pool.reduce((a, b) => ((b.comparison.improvement ?? 0) > (a.comparison.improvement ?? 0) ? b : a));
  const view = formatImprovement(best.comparison);

  return (
    <div className={s.summaryBox}>
      <div className={s.summaryHead}>结果摘要</div>
      <div>
        <strong>{best.node.displayName}</strong> 在主指标 {best.comparison.metricId} 上
        {' '}{formatValue(best.comparison.measuredValue, best.comparison.unit)}
        （Baseline {formatValue(best.comparison.referenceValue, best.comparison.unit)}），
        {' '}{view.text}（{view.verdict}），配对 {best.comparison.pairedSeedCount}/{best.comparison.expectedSeedCount}。
      </div>
      <div className={s.dim}>
        该结论层级：{best.comparison.evidenceLevel === 'phase3_report' ? 'Phase3 实验报告' : best.comparison.evidenceLevel === 'phase2_local' ? 'Phase2 本地比较' : '无'}
        ；证据：{best.comparison.comparisonRef ?? '—'}
      </div>
    </div>
  );
}

function GraphCanvas(props: {
  layout: Layout;
  selection: string | null;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { layout, selection, onSelect } = props;
  return (
    <div className={s.canvasScroll}>
      <svg
        className={s.canvas}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="工作树数据流图：Baseline 到组合、执行与结果的关系"
      >
        <defs>
          <marker id="evw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {layout.edges.map((pe) => {
          const style = EDGE_STYLE[pe.edge.relation] ?? { label: pe.edge.relation, dashed: false };
          const x1 = pe.from.x + pe.from.width;
          const y1 = pe.from.y + pe.from.height / 2;
          const x2 = pe.to.x;
          const y2 = pe.to.y + pe.to.height / 2;
          const mid = (x1 + x2) / 2;
          const active = selection === pe.from.node.id || selection === pe.to.node.id;
          return (
            <g key={pe.edge.id} className={active ? s.edgeActive : s.edge}>
              <title>{`${style.label}：${pe.edge.source} → ${pe.edge.target}\n证据：${pe.edge.evidenceRefs.join(', ') || '无'}`}</title>
              <path
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={active ? 2.5 : 1.5}
                strokeDasharray={style.dashed ? '6 4' : undefined}
                markerEnd="url(#evw-arrow)"
              />
              <text x={mid} y={(y1 + y2) / 2 - 5} className={s.edgeLabel} textAnchor="middle">
                {pe.edge.label}
              </text>
            </g>
          );
        })}
        {layout.nodes.map((pn) => (
          <NodeBox
            key={pn.node.id}
            placed={pn}
            selected={selection === pn.node.id}
            onSelect={onSelect}
          />
        ))}
      </svg>
    </div>
  );
}

/**
 * One node. The first screen shows name, status, primary metric + direction,
 * improvement vs Baseline and seed coverage — never a raw multi-metric table.
 */
function NodeBox(props: { placed: PlacedNode; selected: boolean; onSelect: (id: string) => void }): JSX.Element {
  const { node } = props.placed;
  const primary = node.comparisons[0];
  const imp = primary === undefined ? null : formatImprovement(primary);
  const statusClass = statusTone(node.measurementStatus);
  const className = [
    s.node,
    node.kind === 'baseline' ? s.nodeBaseline : '',
    node.kind === 'run' || node.kind === 'result' ? s.nodeFlow : '',
    props.selected ? s.nodeSelected : '',
  ].join(' ');

  return (
    <g
      className={className}
      transform={`translate(${props.placed.x}, ${props.placed.y})`}
      tabIndex={0}
      role="button"
      aria-label={`${node.displayName}，${measurementLabel(node.measurementStatus)}`}
      onClick={() => props.onSelect(node.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(node.id); }
      }}
    >
      <title>{`${node.displayName}\n执行：${executionLabel(node.executionStatus)}\n测量：${measurementLabel(node.measurementStatus)}\n${node.summary}`}</title>
      <rect width={props.placed.width} height={props.placed.height} rx={8} className={s.nodeBox} />
      {wrapLabel(node.displayName, nodeCharsPerLine(props.placed.width), 2).map((line, i) => (
        <text key={line + String(i)} x={10} y={18 + i * 13} className={s.nodeName}>{line}</text>
      ))}
      <text x={10} y={44} className={s.nodeKind}>{KIND_LABEL[node.kind]}</text>

      {primary === undefined
        ? (
          <text x={10} y={58} className={s.nodeMetric}>
            {node.detail.metricRows.length === 0 ? '未测' : '无数值'}
          </text>
        )
        : (
          <>
            <text x={10} y={58} className={s.nodeMetric}>
              {primary.metricId} {formatValue(primary.measuredValue, primary.unit)}
              <tspan className={s.nodeUnit}> （{primary.direction === 'minimize' ? '越低越好' : '越高越好'}）</tspan>
            </text>
            {imp !== null && (
              <text x={10} y={72} className={`${s.nodeDelta} ${({ good: s.toneGood, bad: s.toneBad, flat: s.toneFlat, none: s.toneNone })[imp.tone] ?? ''}`}>
                {imp.text} {imp.verdict}
              </text>
            )}
            <text x={10} y={86} className={s.nodeCoverage}>
              配对 {primary.pairedSeedCount}/{primary.expectedSeedCount} · {measurementLabel(node.measurementStatus)}
            </text>
          </>
        )}
      <rect x={0} y={0} width={4} height={props.placed.height} rx={2} className={statusClass} />
    </g>
  );
}

const KIND_LABEL: Record<string, string> = {
  baseline: 'Baseline',
  combination: '组合',
  run: '执行',
  result: '结果',
};

/** A left rail colour AND the word in the node body: never colour alone. */
function statusTone(status: string): string {
  switch (status) {
    case 'measured_verified': return s.toneGood;
    case 'measured_unverified':
    case 'partial': return s.toneWarn;
    case 'unreadable': return s.toneBad;
    default: return s.toneNone;
  }
}

function EdgeLegend(props: { edges: GraphEdge[] }): JSX.Element {
  const present = new Set(props.edges.map((e) => e.relation));
  return (
    <div className={s.legend}>
      {[...present].map((relation) => {
        const style = EDGE_STYLE[relation] ?? { label: relation, dashed: false };
        return (
          <span key={relation} className={s.legendItem}>
            <svg width="34" height="10" aria-hidden="true" className={s.legendSvg}>
              <line
                x1="2" y1="5" x2="30" y2="5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeDasharray={style.dashed ? '6 4' : undefined}
              />
            </svg>
            {style.label}
          </span>
        );
      })}
      <span className={s.dim}>共 {props.edges.length} 条边；虚线＝计划或数据流，实线＝已发生的关系</span>
    </div>
  );
}

/**
 * Operations and their logs, collapsed by default (plan §3.2: logs do not own
 * the first screen). Retries and re-runs are labelled so a failed attempt is not
 * mistaken for the run's outcome (R06).
 */
function OperationLog(props: { operations: WorkbenchSnapshot['operations'] }): JSX.Element {
  if (props.operations.length === 0) return <></>;
  return (
    <details className={s.section}>
      <summary className={s.meta}>操作记录（{props.operations.length}，来自已发布产物）</summary>
      <div className={s.section}>
        {props.operations.map((op) => (
          <div key={op.operationId} className={s.opRow}>
            <span className={s.opStatus}>{op.status}</span>
            <span>{op.method}</span>
            {op.attempt !== 'original' && <span className={s.badge}>{op.attempt === 'retry' ? '重试' : '复跑'}</span>}
            <span className={s.dim}>{op.operationId}</span>
            {op.error !== null && <span className={s.opError}>{op.error}</span>}
          </div>
        ))}
      </div>
    </details>
  );
}

export type { GraphNode };
