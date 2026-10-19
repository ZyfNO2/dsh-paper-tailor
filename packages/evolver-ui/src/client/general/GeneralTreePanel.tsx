/**
 * U3 研究实验树（参考 tree.html 视觉 + F06 谱系/Top-K 只读投影 + F07 候选/队列/日志）。
 *
 * 事实来源：指标投影 rows（可比性/差值/目标状态由服务计算）、workflow 节点状态、
 * cycle runs/schedules、plan.metricContext（节点↔变体绑定）。前端不发明排名、
 * 不把 delta 当成功、不在无证据处填 0.821/3 次/0.010 之类的演示值。
 */
import { useRef, useState, type FormEvent } from 'react';
import type { GeneralResearch, GeneralNode } from '../../../../evolver/src/contracts/general-research.ts';
import type { GeneralMetricProjection, MetricMatrixRow } from '../../../../evolver/src/contracts/general-metrics.ts';
import type { GeneralNodeState } from '../../../../evolver/src/contracts/general-workflow.ts';
import type { ResearchCycleData } from '../integration/research-cycle-view.ts';
import { WorkflowEditor } from './WorkflowEditor.tsx';
import { computeTopK } from './tree-projection.ts';

type Action = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
type TreeState = 'base' | 'below' | 'worse' | 'repro' | 'running' | 'pending' | 'queued';
const STATE_TEXT: Record<TreeState, string> = { base: '固定基线', below: '未达门槛', worse: '低于基线', repro: '待复现', running: '运行中', pending: '待实验', queued: '已排队' };
const STATE_CHIP: Record<TreeState, string> = { base: 'chip-ink', below: 'chip-block', worse: 'chip-danger', repro: 'chip-warn', running: 'chip-ready', pending: 'chip-block', queued: 'chip-warn' };
const STATE_REASON: Record<TreeState, string> = {
  base: '基线：所有候选都与它比较，它本身不参与门槛判定。',
  below: '未达门槛：保留历史，可作为后续组合的输入，不会被标记为成功。',
  worse: '低于基线：该分支停止，不再消耗预算；记录保留以便审计。',
  repro: '已达到冻结目标值，但独立复现未证明，只能标记为「待复现」，不能称为成功。',
  running: '运行中：完成前不显示最终指标，也不做判定。',
  pending: '候选尚未实验。推荐顺序只影响先做谁，不代表成功。',
  queued: '已加入运行队列；尚未开始，也没有任何判定。',
};
const KIND_LABEL: Record<string, string> = { goal: '目标', materials: '资料', protocol: '方案', analysis: '分析', review: '审查', report: '报告', manual: '人工', decision: '决策' };

interface Binding { nodeId: string; protocolId: string; version: number; variantKey: string; label: string; role: string; parentKey: string | null }

export function GeneralTreePanel(props: {
  general: GeneralResearch; researchId: string; sessionId: string;
  workflow: GeneralNodeState[]; metrics?: GeneralMetricProjection;
  cycle: ResearchCycleData | null; schedules: Array<{ scheduleId: string; status: string; tasks: Array<{ taskId: string; nodeId: string; status: string; runId: string | null; sourceIds: string[] }> }>;
  action: Action; cycleAction: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  busy: boolean; refresh: () => Promise<void>;
}): JSX.Element {
  const g = props.general;
  const nodes = g.graph.nodes;
  const rows = props.metrics?.rows ?? [];
  const protocols = props.metrics?.protocols ?? [];
  const plans = g.plans;
  const [selected, setSelected] = useState<string>(nodes[0]?.nodeId ?? '');
  const [tab, setTab] = useState<'v' | 'd' | 'edit'>('v');
  const [k, setK] = useState(2);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [canvasMode, setCanvasMode] = useState<'graph' | 'list'>('graph');
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const drag = useRef<{ id: string; x: number; y: number; start: { x: number; y: number }; changed: boolean } | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);
  const cycleRuns = props.cycle?.runs ?? [];
  const derivedNodes: GeneralNode[] = (props.cycle?.effectiveGraph.nodes ?? []).filter(n => n.origin === 'cycle' && !nodes.some(b => b.nodeId === n.nodeId)).map(n => ({ nodeId: n.nodeId, title: n.title, kind: 'manual' as const, goal: n.title, inputs: [], method: n.summary ?? '来自已保存的研究循环增量', output: n.artifactRef ? '真实已登记产物' : '未来工作（未执行）', completionCriterion: '来源与实际产物可检查', join: 'all' as const, execution: 'not_started' as const }));
  const allNodes = [...nodes, ...derivedNodes];
  const layoutPos = (id: string) => positions[id] ?? g.layout[id] ?? { x: 60 + allNodes.findIndex(n => n.nodeId === id) * 40, y: 70 + allNodes.findIndex(n => n.nodeId === id) * 96 };
  const position = (id: string) => layoutPos(id);
  const savePosition = async (id: string, p: { x: number; y: number }) => {
    const saved = await props.action('save_general_layout', { researchId: props.researchId, positions: { [id]: p } });
    if (saved) setPositions(current => { const next = { ...current }; delete next[id]; return next; });
  };
  const finishDrag = () => {
    const d = drag.current; drag.current = null;
    if (d?.changed) void savePosition(d.id, layoutPos(d.id));
  };

  // F06：节点 ↔ 变体绑定来自分析方案的 metricContext（最新版本优先）。
  const bindings = new Map<string, Binding>();
  for (const p of plans) if (p.metricContext) bindings.set(p.nodeId, { nodeId: p.nodeId, protocolId: p.metricContext.protocolId, version: p.metricContext.version, variantKey: p.metricContext.variantKey, label: p.metricContext.label, role: p.metricContext.role, parentKey: p.metricContext.parentKey });
  const rowFor = (b: Binding | undefined): MetricMatrixRow | null => {
    if (!b) return null;
    const candidates = rows.filter(r => r.protocolId === b.protocolId && r.version === b.version && r.variantKey === b.variantKey);
    return candidates.at(-1) ?? null;
  };

  // F06 Top-K：见文件头 computeTopK 说明（只读、冻结协议、可比集、并列保留）。
  const topKeys = computeTopK(rows, protocols, k);

  interface NodeView { node: GeneralNode; st: TreeState; chipText: string; binding: Binding | null; row: MetricMatrixRow | null; delta: number | null; value: { v: string; sign: 'pos' | 'neg' | 'zero' | 'na' } | null; topk: boolean; runs: Array<{ runId: string; status: string; round: number; error: string | null }>; queued: { scheduleId: string; status: string } | null; reasons: string[] }
  const views: NodeView[] = allNodes.map(node => {
    const binding = bindings.get(node.nodeId) ?? null;
    const row = rowFor(binding ?? undefined);
    const runs = cycleRuns.filter(r => r.nodeId === node.nodeId).map(r => ({ runId: r.runId, status: r.status, round: r.round, error: r.error?.message ?? null }));
    const queuedTask = props.schedules.flatMap(s => s.tasks.filter(t => t.nodeId === node.nodeId && ['pending', 'running'].includes(t.status)).map(t => ({ scheduleId: s.scheduleId, status: t.status }))).at(-1) ?? null;
    const workflowState = props.workflow.find(w => w.nodeId === node.nodeId);
    let st: TreeState = 'pending';
    if (binding?.role === 'baseline') st = 'base';
    else if (runs.some(r => r.status === 'running') || queuedTask?.status === 'running') st = 'running';
    else if (queuedTask) st = 'queued';
    else if (row) {
      const protocol = binding ? protocols.find(p => p.protocolId === binding.protocolId && p.version === binding.version) : null;
      const primary = protocol ? protocol.metrics.find(m => m.role === 'primary') : null;
      const cell = primary ? row.cells.find(c => c.metricId === primary.metricId) : null;
      if (cell && cell.delta !== null) {
        if (cell.targetStatus === 'met') st = 'repro';
        else if (cell.delta < 0) st = 'worse';
        else st = 'below';
      }
    } else if (workflowState?.status === 'skipped') st = 'below';
    const protocol = binding ? protocols.find(p => p.protocolId === binding.protocolId && p.version === binding.version) : null;
    const primary = protocol ? protocol.metrics.find(m => m.role === 'primary') : null;
    const cell = primary && row ? row.cells.find(c => c.metricId === primary.metricId) ?? null : null;
    const delta = cell?.delta ?? null;
    // 未绑定变体的通用节点不是实验变体：chip 显示工作流状态（可开始/产物就绪/已有审查等），
    // 卡片底色仍按画布状态映射；绑定节点才使用实验状态文案。
    const WORKFLOW_LABEL: Record<string, string> = { policy_ready: '自动流程放行', ready: '可开始', blocked: '前置阻塞', skipped: '未选分支', manual_confirmed: '人工已确认', output_ready: '产物就绪', reviewed: '已有审查' };
    const chipText = binding ? STATE_TEXT[st] : (workflowState ? (WORKFLOW_LABEL[workflowState.status] ?? '状态未提供') : (st === 'running' ? STATE_TEXT.running : st === 'queued' ? STATE_TEXT.queued : '状态未提供'));
    return {
      node, st, chipText, binding, row, delta, topk: binding !== null && topKeys.has(binding.variantKey) && st !== 'base',
      value: cell ? { v: cell.value === null ? '∅' : String(cell.value), sign: delta === null ? 'na' : delta > 0 ? 'pos' : delta < 0 ? 'neg' : 'zero' } : null,
      runs, queued: queuedTask,
      reasons: row ? [...row.blockers, ...row.comparisonReasons] : workflowState && workflowState.status !== 'ready' ? [workflowState.reason] : [],
    };
  });
  const sgn = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(3);
  const selectedView = views.find(v => v.node.nodeId === selected) ?? views[0];
  const parentNodeOf = (v: NodeView): { node?: GeneralNode; rowLabel?: string } => {
    if (!v.binding) return {};
    const edge = g.graph.edges.find(e => e.from === v.node.nodeId && e.kind === 'derived_from') ?? g.graph.edges.find(e => e.from === v.node.nodeId && e.kind === 'depends_on');
    const node = edge ? allNodes.find(n => n.nodeId === edge.to) : undefined;
    const parentRow = v.binding.parentKey ? rows.find(r => r.protocolId === v.binding!.protocolId && r.version === v.binding!.version && r.variantKey === v.binding!.parentKey) : null;
    return { node, rowLabel: parentRow?.label ?? v.binding.parentKey ?? undefined };
  };
  const width = Math.max(860, ...views.map(v => position(v.node.nodeId).x + 260));
  const height = Math.max(560, ...views.map(v => position(v.node.nodeId).y + 180));
  const [zoom, setZoom] = useState(.72);
  const frozenProtocols = protocols.filter(p => p.status === 'frozen');
  const runningSchedules = props.schedules.filter(s => s.status === 'running');
  const pendingTasks = props.schedules.flatMap(s => s.tasks.filter(t => ['pending', 'running'].includes(t.status))).length;
  const budgetFull = runningSchedules.length > 0 || pendingTasks >= g.limits.maxRounds;
  const saveCandidate = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedView) return;
    const f = new FormData(event.currentTarget as HTMLFormElement);
    const saved = await props.action('save_general_node', { researchId: props.researchId, node: {
      kind: 'protocol', title: String(f.get('title') ?? '').trim() || `${selectedView.node.title} · 候选`, goal: String(f.get('goal') ?? ''), inputs: [],
      method: String(f.get('method') ?? ''), output: '未执行候选（明确标注；不含任何运行结果）', completionCriterion: String(f.get('criterion') ?? '来源与实际产物可检查'), join: 'all',
    }, position: { x: Math.min(1200, position(selectedView.node.nodeId).x + 280), y: Math.max(60, position(selectedView.node.nodeId).y - 40) } });
    if (!saved) return;
    await props.action('save_general_edge', { researchId: props.researchId, edge: { from: saved.nodeId as string, to: selectedView.node.nodeId, kind: 'derived_from', condition: null } });
    setCandidateOpen(false);
  };
  return <div className="flow-layout" data-general-tree>
    <section className="flow-main">
      <div className="flow-toolbar">
        <div className="segmented">{(['graph', 'list'] as const).map(v => <button key={v} className={canvasMode === v ? 'active' : ''} onClick={() => setCanvasMode(v)}>{v === 'graph' ? '流程图' : '列表'}</button>)}</div>
        <span className="small">Top-K</span>
        {[1, 2, 3].map(n => <button key={n} className="seg" aria-pressed={k === n} onClick={() => setK(n)}>{n}</button>)}
        <span className="small muted">仅在冻结协议的可比集合内高亮；并列保留，不剪枝</span>
        <span style={{ flex: 1 }} />
        <button onClick={() => setZoom(z => Math.max(.45, z / 1.2))}>−</button>
        <span className="small">{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom(z => Math.min(2.8, z * 1.2))}>＋</button>
        <button onClick={() => setZoom(Math.max(.45, Math.min(2.8, ((canvas.current?.clientWidth ?? 860) - 40) / width, 560 / height)))}>适应</button>
      </div>
      <div className="tr-badges" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 16px 0' }}>
        <span className="chip chip-block">登记运行 {g.calculations.length}</span>
        <span className="chip chip-block">队列中 {pendingTasks} / 上限 {g.limits.maxRounds} 项</span>
        <span className="chip chip-block">每方案尝试上限 {g.limits.maxAttempts}</span>
        {frozenProtocols.map(p => <span key={p.protocolId} className="chip chip-done">冻结协议 v{p.version} · {p.metrics.filter(m => m.role === 'primary').map(m => m.name).join('、') || '未设主指标'}</span>)}
        {protocols.length > frozenProtocols.length && <span className="chip chip-warn">草稿协议 {protocols.length - frozenProtocols.length} 项（不参与 Top-K）</span>}
        {!protocols.length && <span className="chip chip-block">尚未冻结指标协议；门槛与排名未知</span>}
      </div>
      {canvasMode === 'list' ? <div className="table-wrap" style={{ margin: 16 }}>
        <table><thead><tr><th>节点</th><th>前置 / 派生</th><th>状态</th><th>主指标</th></tr></thead><tbody>{views.map(v => <tr key={v.node.nodeId}>
          <td><button className="link" onClick={() => { setSelected(v.node.nodeId); }}>{v.node.title}</button></td>
          <td>{(g.graph.edges.filter(e => e.from === v.node.nodeId).map(e => allNodes.find(n => n.nodeId === e.to)?.title).filter(Boolean).join('、')) || '无'}</td>
          <td><span className={`chip ${STATE_CHIP[v.st]}`}>{STATE_TEXT[v.st]}</span>{v.queued && <span className="small muted"> · 队列 {v.queued.scheduleId.slice(0, 8)}</span>}</td>
          <td>{v.value ? <span className={`dl`} data-d={v.value.sign}>{v.delta === null ? v.value.v : `${v.value.v} (${sgn(v.delta)})`}</span> : <span className="small muted">尚无指标</span>}</td>
        </tr>)}</tbody></table>
      </div> : <div className="canvas" ref={canvas}>
        <div style={{ width: width * zoom, height: height * zoom }}>
          <div className="world" style={{ width, height, transform: `scale(${zoom})` }}>
            <svg className="edges" width={width} height={height}>
              <defs>
                <marker id="gt-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#7F8E89" /></marker>
                <marker id="gt-arrow-best" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0 L10 5 L0 10z" fill="#14575C" /></marker>
              </defs>
              {g.graph.edges.map(e => {
                const a = views.find(v => v.node.nodeId === e.to), b = views.find(v => v.node.nodeId === e.from);
                if (!a || !b) return null;
                const pa = position(a.node.nodeId), pb = position(b.node.nodeId);
                const x1 = pa.x + 216, x2 = pb.x - 3, y1 = pa.y + 52, y2 = pb.y + 52;
                const best = (a.topk && b.topk) || (a.st === 'base' && b.topk) || (b.st === 'base' && a.topk);
                const faint = b.st === 'pending' || b.st === 'queued' || b.st === 'worse';
                return <path key={e.edgeId} d={`M${x1} ${y1} C${x1 + 40} ${y1},${x2 - 40} ${y2},${x2} ${y2}`} fill="none"
                  stroke={best ? '#14575C' : '#7F8E89'} strokeWidth={best ? 3.5 : 2}
                  strokeDasharray={e.kind === 'derived_from' || faint ? '6 6' : undefined}
                  markerEnd={best ? 'url(#gt-arrow-best)' : 'url(#gt-arrow)'} />;
              })}
            </svg>
            {views.map(v => {
              const p = position(v.node.nodeId);
              return <button type="button" key={v.node.nodeId} className="tnode" data-st={v.st} data-sel={selected === v.node.nodeId ? 'true' : 'false'} data-best={v.topk ? 'true' : 'false'}
                style={{ left: p.x, top: p.y }} aria-label={`${v.node.title}，${v.chipText}${v.topk ? '，Top-K 候选' : ''}`}
                onClick={() => setSelected(v.node.nodeId)}
                onPointerDown={e => { if (props.busy || e.button !== 0) return; setSelected(v.node.nodeId); drag.current = { id: v.node.nodeId, x: e.clientX, y: e.clientY, start: layoutPos(v.node.nodeId), changed: false }; e.currentTarget.setPointerCapture(e.pointerId); }}
                onPointerMove={e => { const d = drag.current; if (!d || d.id !== v.node.nodeId) return; const dx = (e.clientX - d.x) / zoom, dy = (e.clientY - d.y) / zoom; if (Math.abs(dx) + Math.abs(dy) > 4) { d.changed = true; setPositions(cur => ({ ...cur, [v.node.nodeId]: { x: Math.max(0, Math.round(d.start.x + dx)), y: Math.max(0, Math.round(d.start.y + dy)) } })); } }}
                onPointerUp={finishDrag} onPointerCancel={finishDrag}
                onKeyDown={e => { if (props.busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return; e.preventDefault(); const p0 = layoutPos(v.node.nodeId), step = e.shiftKey ? 40 : 10; const next = { x: Math.max(0, p0.x + (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0)), y: Math.max(0, p0.y + (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0)) }; setPositions(cur => ({ ...cur, [v.node.nodeId]: next })); void savePosition(v.node.nodeId, next); }}>
                <span className="tp"><span>{v.binding?.label ?? KIND_LABEL[v.node.kind] ?? v.node.kind}</span>{v.topk && <span className="tk">TOP-K</span>}</span>
                <b>{v.node.title}</b>
                <span className="m">{v.value ? <span className="dl" data-d={v.value.sign}>{v.value.v}{v.delta !== null ? ` ${sgn(v.delta)}` : ''}</span> : <span className="m2">尚无指标</span>}</span>
                <span className="m2">{v.chipText}{v.queued ? ' · 队列中' : ''}</span>
              </button>;
            })}
          </div>
        </div>
      </div>}
    </section>
    <aside className="inspector" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {selectedView && <>
        <div style={{ display: 'flex', gap: 18, borderBottom: '1px solid #E4E9E7' }}>
          <button className="tab" aria-selected={tab === 'v'} onClick={() => setTab('v')}>判定依据</button>
          <button className="tab" aria-selected={tab === 'd'} onClick={() => setTab('d')}>与父方案差异</button>
          <button className="tab" aria-selected={tab === 'edit'} onClick={() => setTab('edit')}>节点编辑</button>
        </div>
        <div>
          <div className="flex between"><h2 style={{ fontSize: 17 }}>{selectedView.node.title}</h2><span className={`chip ${STATE_CHIP[selectedView.st]}`}>{selectedView.chipText}</span></div>
          <p className="small muted">{selectedView.binding ? STATE_REASON[selectedView.st] : '通用流程节点：不是实验变体；卡片不硬造实验状态。'}</p>
          {selectedView.reasons.map(r => <p key={r} className="small" style={{ color: '#8E2A1E' }}>· {r}</p>)}
        </div>
        {tab === 'v' && <div className="stack" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="stat"><small>主指标{selectedView.binding ? `（${selectedView.binding.label}）` : ''}</small><strong>{selectedView.value ? selectedView.value.v : '—'}</strong><small>{selectedView.delta === null ? '差值：未知（不可比或无基线）' : `相对父方案差值 ${sgn(selectedView.delta)}`}{selectedView.row?.attempt != null ? ` · attempt ${selectedView.row.attempt}` : ''}</small></div>
          {(() => {
            const protocol = selectedView.binding ? protocols.find(p => p.protocolId === selectedView.binding!.protocolId && p.version === selectedView.binding!.version) : null;
            const primary = protocol ? protocol.metrics.find(m => m.role === 'primary') : null;
            const cell = primary && selectedView.row ? selectedView.row.cells.find(c => c.metricId === primary.metricId) ?? null : null;
            const check = (label: string, k: 'ok' | 'no' | 'na', word: string, detail: string) => <li style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '7px 0', borderTop: '1px solid #E4E9E7', fontSize: 14 }}><span className="ck" data-k={k}>{k === 'ok' ? '✓' : k === 'no' ? '×' : '—'}</span><span><b style={{ fontWeight: 600 }}>{label}</b><br /><small style={{ color: '#566460' }}>{detail}</small></span><span className="small" style={{ marginLeft: 'auto', color: k === 'ok' ? '#0F4A4F' : k === 'no' ? '#8E2A1E' : '#566460' }}>{word}</span></li>;
            return <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {check('主指标达到冻结目标', cell?.targetStatus === 'met' ? 'ok' : cell?.targetStatus === 'not_met' ? 'no' : 'na', cell?.targetStatus === 'met' ? '满足' : cell?.targetStatus === 'not_met' ? '未满足' : '未知', primary ? `目标区间 ${primary.target.min ?? '—'} ~ ${primary.target.max ?? '—'} ${primary.unit ?? ''}；未配置目标时不能判定` : '未绑定冻结协议')}
              {check('可比性（同条件基线）', selectedView.row && selectedView.row.comparisonReasons.length === 0 && selectedView.row.blockers.length === 0 ? 'ok' : 'no', selectedView.row ? (selectedView.row.comparisonReasons.length || selectedView.row.blockers.length ? '未满足' : '满足') : '未知', selectedView.row ? [...selectedView.row.blockers, ...selectedView.row.comparisonReasons].join('；') || `对照 ${selectedView.row.comparedTo ?? '未知'}` : '无指标记录')}
              {check('独立复现', 'na', '未知', '当前契约没有重复运行门槛与独立复现证明；不因达标数值自动判定')}
              {check('硬约束', (selectedView.row?.constraintsStatus === 'passed' ? 'ok' : selectedView.row?.constraintsStatus === 'failed' ? 'no' : 'na'), selectedView.row?.constraintsStatus === 'passed' ? '满足' : selectedView.row?.constraintsStatus === 'failed' ? '未满足' : '未知', '约束状态由冻结协议与登记数据计算')}
              {check('输入性质', 'na', selectedView.row?.inputNature ?? '未知', '来源性质区分展示；模拟与真实测量不混算')}
            </ul>;
          })()}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {selectedView.st === 'pending' && <button className="btn btn-ghost" disabled={props.busy || budgetFull} onClick={() => void props.cycleAction('create_schedule', { selectedIdeaId: g.ideas[0]?.ideaId ?? null, tasks: [{ nodeId: selectedView.node.nodeId, sourceIds: plans.find(p => p.nodeId === selectedView.node.nodeId)?.dataset.sourceId ? [plans.find(p => p.nodeId === selectedView.node.nodeId)!.dataset.sourceId] : [] }] })}>加入运行队列（不执行）</button>}
            {selectedView.st === 'pending' && budgetFull && <span className="small" style={{ color: '#7A4100' }}>{runningSchedules.length > 0 ? '已有运行中的队列' : '队列已满'}；先停止或等待</span>}
            {selectedView.queued && <button className="btn btn-ghost" disabled={props.busy} onClick={() => void props.cycleAction('stop_schedule', { scheduleId: selectedView.queued!.scheduleId })}>取消排队（停止队列 {selectedView.queued.scheduleId.slice(0, 8)}）</button>}
            {selectedView.st === 'running' && <span className="chip chip-ready">运行中 · 最近运行 {selectedView.runs.at(-1)?.runId.slice(0, 8)}</span>}
            {(selectedView.row || g.calculations.some(c => c.nodeId === selectedView.node.nodeId)) && <button className="btn btn-ghost" onClick={() => setCandidateOpen(v => !v)}>从该节点生成候选</button>}
          </div>
          {(selectedView.runs.length > 0 || selectedView.queued) && <details><summary>运行与队列记录（run / attempt）</summary>
            <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 }}>
              {selectedView.runs.map(r => <li key={r.runId} className="small">{r.runId.slice(0, 12)} · {r.status} · round {r.round}{r.error ? ` · ${r.error}` : ''}</li>)}
              {!selectedView.runs.length && selectedView.queued && <li className="small muted">队列 {selectedView.queued.scheduleId.slice(0, 12)} · {selectedView.queued.status} · 尚未创建运行</li>}
              {!selectedView.runs.length && !selectedView.queued && <li className="small muted">未运行：{STATE_REASON.pending}</li>}
            </ul>
          </details>}
          {candidateOpen && <form onSubmit={saveCandidate} style={{ border: '1px solid #C3CCC9', borderRadius: 12, padding: 14, display: 'grid', gap: 8 }}>
            <strong style={{ fontWeight: 600, fontSize: 14 }}>候选草案（保存为未执行节点，记录父节点）</strong>
            <label style={{ margin: 0 }}>候选标题<input name="title" defaultValue={`${selectedView.node.title} · 候选`} maxLength={300} /></label>
            <label style={{ margin: 0 }}>目标<input name="goal" defaultValue={selectedView.node.goal} maxLength={4000} /></label>
            <label style={{ margin: 0 }}>方法 / 与父方案差异<textarea name="method" rows={3} placeholder="说明相对父方案改了什么；留空表示仅继承" /></label>
            <label style={{ margin: 0 }}>完成标准<input name="criterion" defaultValue="来源与实际产物可检查" maxLength={4000} /></label>
            <div><button className="btn btn-primary" disabled={props.busy}>保存候选（不执行）</button></div>
          </form>}
        </div>}
        {tab === 'd' && (() => {
          const parent = parentNodeOf(selectedView);
          return <div className="stack" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {!selectedView.binding && <p className="small muted">该节点未绑定指标协议变体；父方案差异未知（人工节点不硬造谱系）。</p>}
            {selectedView.binding && <div className="diffrow"><span className="sg">=</span><span>变体 {selectedView.binding.label}（{selectedView.binding.role}） · 协议 v{selectedView.binding.version}</span></div>}
            {selectedView.binding && (parent.rowLabel || parent.node) && <div className="diffrow"><span className="sg">←</span><span>父方案：{parent.rowLabel ?? parent.node?.title}{parent.node ? `（${parent.node.kind}）` : ''}</span></div>}
            {selectedView.binding && selectedView.node.method && <div className="diffrow"><span className="sg">~</span><span>{selectedView.node.method}</span></div>}
            {selectedView.binding && !parent.rowLabel && !parent.node && <div className="diffrow"><span className="sg">?</span><span>父变体 {selectedView.binding.parentKey ?? '未设置'} 未找到对应记录；差异未知</span></div>}
            <p className="small muted">差异只展示实际登记内容（方法说明 / 派生关系 / 指标绑定）；不继承原型固定文案。</p>
          </div>;
        })()}
        {tab === 'edit' && (nodes.some(n => n.nodeId === selectedView.node.nodeId) ? <WorkflowEditor general={g} title={g.profileHistory.at(-1)?.title ?? g.ideas[0]?.question ?? '研究'} researchId={props.researchId} node={selectedView.node} action={props.action} busy={props.busy} /> : <p className="small muted">此节点来自不可变 Cycle 产物；请在 Agent 页查看产物与建议，不能用布局编辑授予执行状态。</p>)}
      </>}
    </aside>
  </div>;
}
