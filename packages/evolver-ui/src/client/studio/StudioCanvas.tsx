import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { StudioCard, StudioEdge } from './studio-model.ts';
export function StudioIcon({ name, small = false }: { name: string; small?: boolean }): JSX.Element { return <svg className={`ico${small ? ' sm' : ''}`} aria-hidden="true"><use href={`#i-${name}`} /></svg>; }
export type Positions = Record<string, { x: number; y: number }>;
export function StudioCanvas(props: {
  nodes: StudioCard[]; edges: StudioEdge[]; selected: string | null; onSelect: (id: string) => void;
  kind: 'knowledge' | 'tree'; board?: boolean; initialPositions?: Positions; onPersist?: (positions: Positions) => Promise<boolean>; empty: string;
}) {
  const el = useRef<HTMLDivElement | null>(null);
  const gesture = useRef<{ id: string | null; sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null);
  const [draft, setDraft] = useState<Positions>({});
  const pendingPositions = useRef<Positions>({});
  const [camera, setCamera] = useState({ x: 40, y: 45, k: 1 });
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [layout, setLayout] = useState(false);
  const positions: Positions = Object.fromEntries(props.nodes.map((n, i) => [n.id, draft[n.id] ?? (!layout ? props.initialPositions?.[n.id] : undefined) ?? { x: 70 + (i % 3) * 300, y: 80 + Math.floor(i / 3) * 215 }]));
  const positionsRef = useRef(positions); positionsRef.current = positions;
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const selectedRef = useRef(props.selected); selectedRef.current = props.selected;
  const persist = async (values: Positions) => {
    if (!props.onPersist) { setNotice('布局已调整 · 仅本次视图'); return; }
    setSaving(true); setNotice('正在保存布局…');
    try { const ok = await props.onPersist(values); setNotice(ok ? '布局已保存' : '未保存 · 本地布局仍保留，可重试'); if (!ok) pendingPositions.current = { ...pendingPositions.current, ...values }; }
    catch (e) { pendingPositions.current = { ...pendingPositions.current, ...values }; setNotice(`布局未保存：${e instanceof Error ? e.message : String(e)}`); }
    finally { setSaving(false); }
  };
  function fit() {
    const box = el.current; if (!box || !props.nodes.length) return;
    const ps = Object.values(positionsRef.current), minX = Math.min(...ps.map(p => p.x)), minY = Math.min(...ps.map(p => p.y));
    const w = Math.max(...ps.map(p => p.x)) - minX + 260, h = Math.max(...ps.map(p => p.y)) - minY + 165;
    const k = Math.max(.12, Math.min(1, (box.clientWidth - 80) / w, (box.clientHeight - 110) / h));
    setCamera({ x: (box.clientWidth - w * k) / 2 - minX * k, y: (box.clientHeight - h * k) / 2 - minY * k, k });
  }
  const focusSelected = () => { const box = el.current, p = selectedRef.current ? positionsRef.current[selectedRef.current] : null; if (!box || !p) { fit(); return; } const k = Math.min(1, (box.clientWidth - 40) / 290, (box.clientHeight - 100) / 215); setCamera({ k, x: box.clientWidth / 2 - (p.x + 125) * k, y: box.clientHeight / 2 - (p.y + 80) * k }); };
  const nodeKey = props.nodes.map(n => n.id).join('|');
  useEffect(() => { const frame = requestAnimationFrame(focusSelected); const target = el.current; const observer = new ResizeObserver(focusSelected); if (target) observer.observe(target); return () => { cancelAnimationFrame(frame); observer.disconnect(); }; }, [nodeKey, props.board]);
  useEffect(() => { const frame = requestAnimationFrame(focusSelected); return () => cancelAnimationFrame(frame); }, [props.selected]);
  useEffect(() => {
    const target = el.current; if (!target) return;
    const wheel = (e: WheelEvent) => { e.preventDefault(); const r = target.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; setCamera(c => { const k = Math.min(1.8, Math.max(.12, c.k * (e.deltaY < 0 ? 1.1 : .9))); return { k, x: x - (x - c.x) * k / c.k, y: y - (y - c.y) * k / c.k }; }); };
    target.addEventListener('wheel', wheel, { passive: false }); return () => target.removeEventListener('wheel', wheel);
  }, []);
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || saving) return;
    const id = (event.target as Element).closest('[data-studio-node]')?.getAttribute('data-studio-node') ?? null;
    const p = id ? positionsRef.current[id] : cameraRef.current;
    gesture.current = { id, sx: event.clientX, sy: event.clientY, x: p.x, y: p.y, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current; if (!g) return;
    const dx = event.clientX - g.sx, dy = event.clientY - g.sy;
    if (Math.abs(dx) + Math.abs(dy) < 4 && !g.moved) return;
    g.moved = true;
    if (g.id) { const p = { x: Math.max(0, Math.min(1200, g.x + dx / cameraRef.current.k)), y: Math.max(0, Math.min(900, g.y + dy / cameraRef.current.k)) }; pendingPositions.current[g.id] = p; setDraft(v => ({ ...v, [g.id!]: p })); }
    else setCamera(c => ({ ...c, x: g.x + dx, y: g.y + dy }));
  };
  const up = () => {
    const g = gesture.current; gesture.current = null;
    if (g?.id) { props.onSelect(g.id); if (g.moved) { const values = pendingPositions.current; pendingPositions.current = {}; void persist(values); } }
  };
  return <div className="editor-main" data-studio-canvas={props.kind}>
    <div ref={el} className="canvas" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { gesture.current = null; }}>
      <div className={`world${props.kind === 'tree' ? ' tree-world' : ''}`} style={{ transform: `translate(${camera.x}px,${camera.y}px) scale(${camera.k})` }}>
        <svg className="wire-layer" aria-hidden="true" style={{ width: 2200, height: 1400 }}><defs><marker id={`studio-arrow-${props.kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10" fill="#a8b6d9" /></marker></defs>
          {props.edges.map(edge => { const a = positions[edge.from], b = positions[edge.to]; if (!a || !b) return null; const x1 = a.x + 250, y1 = a.y + 65, x2 = b.x, y2 = b.y + 65; return <g key={edge.id}><path d={`M${x1} ${y1} C${x1 + 65} ${y1},${x2 - 65} ${y2},${x2} ${y2}`} fill="none" stroke="#a8b6d9" strokeWidth="1.7" strokeDasharray={edge.label.includes('修正') ? '5 4' : undefined} markerEnd={`url(#studio-arrow-${props.kind})`} /><text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 8} fontSize="10" fill="#65758d" textAnchor="middle">{edge.label}</text></g>; })}
        </svg>
        {props.nodes.map((node, i) => <button type="button" data-studio-node={node.id} key={node.id} aria-pressed={props.selected === node.id} aria-label={`${node.title} · ${node.status}`} className={`graph-node ${props.kind === 'tree' ? 'tree-node' : ''} ${props.board ? `board-node tone-${['yellow', 'blue', 'green'][i % 3]}` : ''}${props.selected === node.id ? ' selected' : ''}`} style={{ left: positions[node.id].x, top: positions[node.id].y, width: 250 }}
          onClick={() => props.onSelect(node.id)} onKeyDown={e => { if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); const p = positions[node.id], next = { x: Math.max(0, Math.min(1200, p.x + (e.key === 'ArrowRight' ? 20 : e.key === 'ArrowLeft' ? -20 : 0))), y: Math.max(0, Math.min(900, p.y + (e.key === 'ArrowDown' ? 20 : e.key === 'ArrowUp' ? -20 : 0))) }; setDraft(v => ({ ...v, [node.id]: next })); void persist({ [node.id]: next }); } }}>
          {props.kind === 'tree' && <div className="node-topline" style={{ background: node.status.includes('产物') || node.status.includes('审查') ? '#5dad92' : node.status === '运行中' ? '#7686db' : '#dcad5e' }} />}
          <div className="node-head"><span className="node-type-icon" style={{ color: props.kind === 'tree' ? '#bc8b43' : '#6575cf', background: props.kind === 'tree' ? '#fff7e6' : '#edf0ff' }}><StudioIcon name={props.kind === 'tree' ? 'git' : 'file'} small /></span><span className="node-title" title={node.title}>{node.title}</span></div>
          <div className="node-body">{node.body || '暂无记录的说明'}</div><div className="studio-node-tags">{node.tags.map(t => <span key={t} className="chip indigo">{t}</span>)}</div>
          <div className="node-foot"><span>{node.kind}</span><span className="chip gray">{node.status}</span></div>
        </button>)}
      </div>
      {!props.nodes.length && <div className="canvas-empty"><StudioIcon name={props.kind === 'tree' ? 'git' : 'brain'} /><h3>{props.empty}</h3><p>这里展示已保存的真实研究资产。</p></div>}
    </div>
    <div className="canvas-top"><span className="chip gray">{props.kind === 'tree' ? 'Task Board · Research DAG' : props.board ? 'Knowledge Board' : 'Knowledge Graph'}</span></div>
    <div className="canvas-caption"><StudioIcon name="info" small />拖动卡片与画布 · 滚轮缩放 · Alt + 方向键移动卡片</div>
    <div className="canvas-tools"><button aria-label="缩小画布" onClick={() => setCamera(c => ({ ...c, k: Math.max(.12, c.k / 1.15) }))}><StudioIcon name="zoom-out" /></button><span className="zoom-num">{Math.round(camera.k * 100)}%</span><button aria-label="放大画布" onClick={() => setCamera(c => ({ ...c, k: Math.min(1.8, c.k * 1.15) }))}><StudioIcon name="zoom-in" /></button><button aria-label="适应视野" onClick={fit}><StudioIcon name="fit" /></button><button aria-label="自动整理画布" onClick={() => { const values = Object.fromEntries(props.nodes.map((n, i) => [n.id, { x: 70 + i % 3 * 300, y: 80 + Math.floor(i / 3) * 215 }])); setLayout(true); setDraft(values); positionsRef.current = values; fit(); void persist(values); }}><StudioIcon name="grid" /></button></div>
    {notice && <div className="canvas-save" role="status">{notice}{Object.keys(pendingPositions.current).length > 0 && <button disabled={saving} onClick={() => { const values = pendingPositions.current; pendingPositions.current = {}; void persist(values); }}>重试保存</button>}</div>}
  </div>;
}
