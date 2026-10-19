import { useEffect, useRef, useState, type PointerEvent as Pointer } from 'react';
import type { WikiBoard as Board } from '../../../../evolver/src/contracts/general-wiki.ts';
import type { GeneralKnowledgeEntry } from '../../../../evolver/src/contracts/general-knowledge.ts';
import { WikiContent, WikiImages } from './WikiContent.tsx';

export function WikiBoard({ boards, entries, selected, select, persist, busy, sourceUrl, allowed, readable, onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void; readable: (e: GeneralKnowledgeEntry) => boolean; boards: Board[]; entries: GeneralKnowledgeEntry[]; selected: string | null; select: (id: string) => void; persist: (b: Board) => Promise<boolean>; busy: boolean; sourceUrl: (id: string) => string; allowed: (id: string) => boolean }) {
  const [active, setActive] = useState(boards[0]?.boardId ?? 'default'), [draft, setDraft] = useState<Board | null>(null), [dirty, setDirty] = useState(false), [title, setTitle] = useState(''), [multi, setMulti] = useState<string[]>([]), [tool, setTool] = useState<'move' | 'select'>('move'), [box, setBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const board = draft ?? boards.find(b => b.boardId === active) ?? { boardId: active, title: '研究知识白板', cards: [], links: [], view: { x: 30, y: 30, scale: 1 } };
  const boardRef = useRef(board); boardRef.current = board;
  const gesture = useRef<{ mode: 'pan' | 'card' | 'resize' | 'box'; sx: number; sy: number; start: Board; id?: string } | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (!dirty) setDraft(null); }, [boards, dirty]);
  const update = (b: Board) => { setDraft(b); setDirty(true); };
  const add = () => { if (!selected) return; update({ ...board, cards: [...board.cards, { instanceId: crypto.randomUUID(), entryId: selected, x: -board.view.x / board.view.scale + 40, y: -board.view.y / board.view.scale + 40, width: 300, height: 330, group: '' }] }); };
  const start = (e: Pointer, mode: 'pan' | 'card' | 'resize' | 'box', id?: string) => { if (e.button !== 0) return; e.stopPropagation(); e.currentTarget.setPointerCapture(e.pointerId); gesture.current = { mode, sx: e.clientX, sy: e.clientY, start: structuredClone(board), id }; if (id && !multi.includes(id)) setMulti(e.shiftKey ? [...multi, id] : [id]); };
  const move = (e: Pointer) => {
    const p = gesture.current; if (!p) return; const dx = (e.clientX - p.sx) / p.start.view.scale, dy = (e.clientY - p.sy) / p.start.view.scale;
    if (p.mode === 'pan') { setDraft({ ...p.start, view: { ...p.start.view, x: p.start.view.x + e.clientX - p.sx, y: p.start.view.y + e.clientY - p.sy } }); setDirty(true); }
    else if (p.mode === 'box') { const r = canvas.current!.getBoundingClientRect(), x = (p.sx - r.left - p.start.view.x) / p.start.view.scale, y = (p.sy - r.top - p.start.view.y) / p.start.view.scale; const b = { x: Math.min(x, x + dx), y: Math.min(y, y + dy), width: Math.abs(dx), height: Math.abs(dy) }; setBox(b); setMulti(board.cards.filter(c => c.x + c.width >= b.x && c.x <= b.x + b.width && c.y + c.height >= b.y && c.y <= b.y + b.height).map(c => c.instanceId)); }
    else update({ ...p.start, cards: p.start.cards.map(c => p.mode === 'resize' && c.instanceId === p.id ? { ...c, width: Math.round(Math.max(220, Math.min(1600, c.width + dx))), height: Math.round(Math.max(180, Math.min(2000, c.height + dy))) } : p.mode === 'card' && (c.instanceId === p.id || multi.includes(c.instanceId)) ? { ...c, x: Math.round(c.x + dx), y: Math.round(c.y + dy) } : c) });
  };
  const end = () => { gesture.current = null; setBox(null); };
  return <div className="wiki-board"><div className="board-toolbar">
    <select aria-label="主题白板" value={active} onChange={e => { if (dirty && !window.confirm('当前白板有未保存修改，是否切换？')) return; setActive(e.target.value); setDraft(null); setDirty(false); setMulti([]); }}><option value="default">研究知识白板</option>{boards.filter(b => b.boardId !== 'default').map(b => <option key={b.boardId} value={b.boardId}>{b.title}</option>)}</select>
    <input aria-label="新白板名称" placeholder="新主题名称" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /><button disabled={!title.trim() || dirty} onClick={() => { const id = crypto.randomUUID(); setActive(id); update({ boardId: id, title: title.trim(), cards: [], links: [], view: { x: 30, y: 30, scale: 1 } }); setTitle(''); }}>新建白板</button>
    <button disabled={!selected} onClick={add}>加入选中知识</button><button aria-pressed={tool === 'select'} onClick={() => setTool(tool === 'move' ? 'select' : 'move')}>{tool === 'move' ? '移动 / 平移' : '框选'}</button>
    <button disabled={!dirty || busy} onClick={async () => { if (await persist(boardRef.current)) { setDirty(false); setDraft(null); } }}>保存白板{dirty ? ' *' : ''}</button>
    <label>缩放<input aria-label="白板缩放" type="range" min="0.25" max="2" step="0.05" value={board.view.scale} onChange={e => update({ ...board, view: { ...board.view, scale: Number(e.target.value) } })} /></label>
    <button onClick={() => update({ ...board, view: { x: 30, y: 30, scale: 1 } })}>复位</button>
  </div>
  {!!multi.length && <div className="board-selection"><span>已选 {multi.length} 张</span><input aria-label="卡片分组" placeholder="分组名，回车应用" maxLength={100} onKeyDown={e => { if (e.key === 'Enter') { update({ ...board, cards: board.cards.map(c => multi.includes(c.instanceId) ? { ...c, group: e.currentTarget.value } : c) }); } }} />
    <button disabled={multi.length !== 2} onClick={() => update({ ...board, links: [...board.links, { from: multi[0], to: multi[1], label: '人工组织关系' }] })}>连接所选</button><button onClick={() => { update({ ...board, cards: board.cards.filter(c => !multi.includes(c.instanceId)), links: board.links.filter(l => !multi.includes(l.from) && !multi.includes(l.to)) }); setMulti([]); }}>移出白板</button><small>移出不删除知识；箭头表示人工组织关系</small></div>}
  <div ref={canvas} className="board-canvas" onPointerDown={e => { if ((e.target as Element).closest('button,a,input,article')) return; start(e, tool === 'select' ? 'box' : 'pan'); }} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
    <div className="board-world" style={{ transform: `translate(${board.view.x}px,${board.view.y}px) scale(${board.view.scale})` }}>
      <svg className="board-links" aria-label="白板人工连线">{board.links.map((l, i) => { const a = board.cards.find(c => c.instanceId === l.from), b = board.cards.find(c => c.instanceId === l.to); if (!a || !b) return null; return <g key={i}><line x1={a.x + a.width / 2} y1={a.y + a.height / 2} x2={b.x + b.width / 2} y2={b.y + b.height / 2} /><text x={(a.x + b.x + a.width) / 2} y={(a.y + b.y + a.height) / 2}>{l.label}</text></g>; })}</svg>
      {board.cards.map(c => { const e = entries.find(e => e.entryId === c.entryId); return <article key={c.instanceId} data-card-id={c.instanceId} className={`knowledge-card${multi.includes(c.instanceId) ? ' chosen' : ''}`} style={{ left: c.x, top: c.y, width: c.width, height: c.height }} onClick={ev => { if (e) select(e.entryId); if (ev.shiftKey) setMulti(multi.includes(c.instanceId) ? multi.filter(id => id !== c.instanceId) : [...multi, c.instanceId]); else setMulti([c.instanceId]); }}>
        <header onClick={ev => ev.stopPropagation()} onPointerDown={ev => { if (e) select(e.entryId); start(ev, 'card', c.instanceId); }}><span>{c.group || e?.category || '知识卡片'}</span><small>v{e?.version ?? '?'}</small><h3>{e?.title ?? '知识已归档或不可用'}</h3></header>
        <div className="knowledge-card-content">{e && readable(e) ? <><WikiImages entry={e} sourceUrl={sourceUrl} allowed={allowed} /><WikiContent text={e.content} select={select} /><p className="card-evidence">{e.nature} · {e.sourceRefs.length} 个来源</p>{e.sourceRefs.map(id => <button key={id} className="link" onClick={ev => { ev.stopPropagation(); select(`source:${id}`); }}>↗ 查看引用来源</button>)}</> : <p>知识不存在或来源已撤权</p>}</div>
        <footer><button onClick={() => e && select(e.entryId)}>阅读全文与依据 ↗</button><button className="resize-card" aria-label={`调整 ${e?.title ?? '卡片'} 大小`} onPointerDown={ev => start(ev, 'resize', c.instanceId)} onKeyDown={ev => { const d = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 20 : -20; if (ev.key.startsWith('Arrow')) { ev.preventDefault(); update({ ...board, cards: board.cards.map(x => x.instanceId === c.instanceId ? { ...x, width: Math.max(220, Math.min(1600, x.width + d)), height: Math.max(180, Math.min(2000, x.height + d)) } : x) }); } }}>↘</button></footer>
      </article>; })}
      {box && <div className="selection-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />}
    </div>{!board.cards.length && <div className="board-empty"><h3>把知识放到白板上</h3><p>从目录选一条知识，再点击“加入选中知识”。正文、图片与引用会直接显示在卡片里。</p></div>}
  </div></div>;
}
