/**
 * 模型数据流：显示选中候选的计算/训练结构（W4 的展示半边）。
 *
 * 这是与"探索树"**分开**的第二个视图：探索树回答"哪个候选和哪个实验有关系"，
 * 数据流回答"输入怎么经过基线部件与模块"。两者由 candidateKey 联动。
 *
 * 两条绘制约束直接来自 SPEC §4.3：
 *
 *  - `conceptual` 图必须标注"设计示意，接口与顺序未验证"，且**不画**代码槽位
 *    或张量形状——服务端不提供，客户端就更不能补。
 *  - `loss` 与 `training_control` 走独立的训练分支，**不与推理路径混排**。
 *    一个把预测"穿过 loss 再得出结果"的图，在这里画不出来。
 */

import type { ModelDataFlow as Flow, ModelDataFlowEdge, ModelDataFlowNode } from '../wire.ts';
import { s } from './styles.ts';

export interface ModelDataFlowProps {
  flow: Flow | null;
  /** Why the graph is missing or partial; never silently blank. */
  unresolvedZh?: string[];
  onOpenModule?: (methodKey: string) => void;
  onSelectNode?: (nodeId: string) => void;
  selectedNodeId?: string | null;
}

// ----------------- deterministic layered layout -----------------

const NODE_W = 150;
const NODE_H = 54;
const COL_GAP = 60;
const ROW_GAP = 18;
const PAD = 14;

interface Placed { node: ModelDataFlowNode; x: number; y: number }

/**
 * Columns by longest path along TENSOR edges only.
 *
 * Supervision and control edges deliberately do not advance a column: they form
 * the training feedback loop, and including them would both merge the training
 * branch into the inference path and make a correct graph look cyclic.
 */
function layout(flow: Flow): { placed: Placed[]; width: number; height: number } {
  const byId = new Map(flow.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, ModelDataFlowEdge[]>();
  for (const n of flow.nodes) incoming.set(n.id, []);
  for (const e of flow.edges) {
    if (e.kind !== 'tensor') continue;
    if (!byId.has(e.source) || !byId.has(e.target)) continue;
    incoming.get(e.target)?.push(e);
  }

  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const depthOf = (id: string): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let best = 0;
    for (const e of incoming.get(id) ?? []) best = Math.max(best, depthOf(e.source) + 1);
    visiting.delete(id);
    depth.set(id, best);
    return best;
  };
  for (const n of flow.nodes) depthOf(n.id);

  const columns = new Map<number, ModelDataFlowNode[]>();
  for (const n of flow.nodes) {
    const d = depth.get(n.id) ?? 0;
    const list = columns.get(d) ?? [];
    list.push(n);
    columns.set(d, list);
  }

  const placed: Placed[] = [];
  const keys = [...columns.keys()].sort((a, b) => a - b);
  keys.forEach((d, col) => {
    (columns.get(d) ?? []).forEach((node, row) => {
      placed.push({ node, x: PAD + col * (NODE_W + COL_GAP), y: PAD + row * (NODE_H + ROW_GAP) });
    });
  });
  const width = placed.reduce((w, p) => Math.max(w, p.x + NODE_W), NODE_W) + PAD;
  const height = placed.reduce((h, p) => Math.max(h, p.y + NODE_H), NODE_H) + PAD;
  return { placed, width, height };
}

const KIND_LABEL: Record<ModelDataFlowNode['kind'], string> = {
  input: '输入',
  baseline_part: '基线部件',
  module: '模块',
  merge: '汇合',
  prediction: '预测',
  label: '标签',
  loss: '损失',
  training_control: '训练控制',
  output: '输出',
};

const EDGE_STYLE: Record<ModelDataFlowEdge['kind'], { dash: string; color: string; label: string }> = {
  tensor: { dash: '', color: 'var(--evw-fg-dim, #888)', label: '张量' },
  // Dashed AND differently coloured AND labelled: the training branch must be
  // distinguishable without relying on colour alone.
  supervision: { dash: '5 3', color: 'var(--evw-warn, #b8860b)', label: '监督' },
  control: { dash: '2 3', color: 'var(--evw-accent, #3a7)', label: '控制' },
};

export function ModelDataFlow(props: ModelDataFlowProps): JSX.Element {
  if (props.flow === null) {
    return (
      <div className={s.flow} data-testid="model-dataflow" data-state="empty">
        <h3 className={s.flowTitle}>模型数据流</h3>
        <p className={s.flowEmpty}>
          {props.unresolvedZh?.[0] ?? '选择一个候选以查看它的模型数据流。'}
        </p>
      </div>
    );
  }

  const flow = props.flow;
  const { placed, width, height } = layout(flow);
  const at = new Map(placed.map((p) => [p.node.id, p]));
  const isConceptual = flow.level === 'conceptual';

  return (
    <div className={s.flow} data-testid="model-dataflow" data-state="shown" data-level={flow.level}>
      <h3 className={s.flowTitle}>模型数据流</h3>

      {isConceptual && (
        <p className={s.flowConceptual} data-testid="flow-conceptual-note">
          设计示意，接口与顺序未验证
        </p>
      )}

      <div className={s.flowScroll}>
        <svg
          className={s.flowSvg}
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label="模型数据流图"
          data-testid="flow-svg"
        >
          <defs>
            <marker id="evw-flow-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
            </marker>
          </defs>

          {/* Edges first so nodes sit on top of them. */}
          <g className={s.flowEdges}>
            {flow.edges.map((e) => {
              const from = at.get(e.source);
              const to = at.get(e.target);
              if (from === undefined || to === undefined) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const mid = (x1 + x2) / 2;
              const style = EDGE_STYLE[e.kind] ?? EDGE_STYLE.tensor;
              return (
                <g key={e.id} data-edge-kind={e.kind} data-testid={`flow-edge-${e.kind}`}>
                  <path
                    d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke={style.color}
                    strokeWidth={e.kind === 'tensor' ? 1.4 : 1.2}
                    strokeDasharray={style.dash === '' ? undefined : style.dash}
                    markerEnd="url(#evw-flow-arrow)"
                  />
                  {e.labelZh !== null && (
                    <text x={mid} y={(y1 + y2) / 2 - 4} className={s.flowEdgeLabel} textAnchor="middle">
                      {e.labelZh}
                    </text>
                  )}
                </g>
              );
            })}
          </g>

          <g className={s.flowNodes}>
            {placed.map((p) => {
              const node = p.node;
              const selected = props.selectedNodeId === node.id;
              const clickable = node.methodKey !== null && props.onOpenModule !== undefined;
              return (
                <g
                  key={node.id}
                  transform={`translate(${p.x}, ${p.y})`}
                  className={s.flowNode}
                  data-kind={node.kind}
                  data-selected={selected ? 'true' : 'false'}
                  data-testid={`flow-node-${node.kind}`}
                  onClick={() => props.onSelectNode?.(node.id)}
                  style={clickable ? { cursor: 'pointer' } : undefined}
                >
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={6}
                    className={s.flowNodeBox}
                    data-kind={node.kind}
                    data-selected={selected ? 'true' : 'false'}
                  />
                  <text x={NODE_W / 2} y={20} className={s.flowNodeLabel} textAnchor="middle">
                    {node.labelZh.length > 14 ? `${node.labelZh.slice(0, 13)}…` : node.labelZh}
                  </text>
                  <text x={NODE_W / 2} y={38} className={s.flowNodeKind} textAnchor="middle">
                    {KIND_LABEL[node.kind] ?? node.kind}
                  </text>
                  {/* A conceptual graph must not claim a code slot or a shape. */}
                  {isConceptual ? null : node.slotId !== null && (
                    <text x={NODE_W / 2} y={NODE_H - 4} className={s.flowNodeSlot} textAnchor="middle">
                      {node.slotId}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>

      <ul className={s.flowLegend} data-testid="flow-legend">
        {(Object.keys(EDGE_STYLE) as Array<ModelDataFlowEdge['kind']>).map((k) => (
          <li key={k} className={s.flowLegendItem} data-edge-kind={k}>
            <svg width="26" height="8" aria-hidden="true">
              <line x1="1" y1="4" x2="25" y2="4" stroke={EDGE_STYLE[k].color} strokeWidth="1.4" strokeDasharray={EDGE_STYLE[k].dash === '' ? undefined : EDGE_STYLE[k].dash} />
            </svg>
            {EDGE_STYLE[k].label}
          </li>
        ))}
      </ul>

      {flow.unresolved.length > 0 && (
        <ul className={s.flowUnresolved} data-testid="flow-unresolved">
          {flow.unresolved.map((u, i) => (
            <li key={i} data-subject={u.subjectId}>{u.reasonZh}</li>
          ))}
        </ul>
      )}
    </div>
  );
}