import { useCallback, useEffect, useState } from 'react';
import type { TakeoverProjection, TakeoverRecord, TakeoverSnapshot } from '../../../../evolver/src/contracts/research-takeover.ts';

type Action = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

const KIND_LABEL: Record<string, string> = {
  paper: '论文', note: '笔记', wiki: 'Wiki', code: '代码', config: '配置',
  metric: '指标', log: '日志', weight: '权重', archive: '归档', other: '其他',
};
const READ_LABEL: Record<string, string> = {
  read: '已读', metadata_only: '仅元数据', skipped: '跳过', failed: '读取失败', not_read: '未读',
};
const EVIDENCE_LABEL: Record<string, string> = {
  file_present: '仅文件存在', content_read: '正文已读', reported_complete: '项目自述', verifiable_result: '有可复核产物',
};
const CONFIDENCE_LABEL: Record<string, string> = { evidenced: '有依据', inferred: '推测', unverified: '未核实' };

const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`;

/** Read-only takeover display: everything shown comes from the persisted scan / snapshot. */
export function TakeoverPanel({ sessionId, action, busy, refresh }: { sessionId: string; action: Action; busy: boolean; refresh(): Promise<void> }): JSX.Element {
  const [list, setList] = useState<Array<{ takeoverId: string; title: string; roots: string[]; status: string; researchId: string | null; revision: number; updatedAt: string; firstError: { code: string; message: string } | null }>>([]);
  const [detail, setDetail] = useState<TakeoverProjection | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [rootsText, setRootsText] = useState('');
  const [scopeNote, setScopeNote] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async (takeoverId: string | null) => {
    setError('');
    try {
      const query = new URLSearchParams({ sessionId });
      if (takeoverId) query.set('takeoverId', takeoverId);
      const response = await fetch(`/evolver/research-bootstrap/takeover?${query}`, { credentials: 'same-origin' });
      const raw = await response.text();
      if (raw.length === 0) throw new Error(`HTTP ${response.status}: 后端返回空响应体（路由未挂载或宿主异常）`);
      const body = JSON.parse(raw) as TakeoverProjection & { takeovers?: typeof list; error?: string; message?: string };
      if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
      if (takeoverId) setDetail(body); else setList(body.takeovers ?? []);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [sessionId]);

  useEffect(() => { void load(null); }, [load]);
  useEffect(() => { if (open) void load(open); }, [open, load]);

  async function start(): Promise<void> {
    const roots = rootsText.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (roots.some(r => r.startsWith('/') || /^[A-Za-z]:/.test(r) || r.includes('..'))) { setError('只接受工作区相对路径，不接受绝对路径或 ".."。'); return; }
    const saved = await action('takeover_start', { roots: roots.length ? roots : ['.'], ...(scopeNote.trim() ? { scopeNote: scopeNote.trim() } : {}) });
    if (saved) { setRootsText(''); setScopeNote(''); setOpen(String(saved.takeoverId)); await refresh(); await load(null); }
  }
  async function refreshScan(): Promise<void> {
    if (!open) return;
    const saved = await action('takeover_refresh', { takeoverId: open });
    if (saved) { await refresh(); await load(open); }
  }

  const record: TakeoverRecord | null = detail?.record ?? null;
  const snapshot: TakeoverSnapshot | null = record?.snapshot ?? null;
  const scan = record?.scans.find(s => s.scanId === record.currentScanId) ?? null;

  return <section className="panel" data-general-takeover><div className="panel-head"><h2>已有研究目录接管（只读盘点）</h2><span className="small muted">盘点不修改、不移动、不执行原目录任何文件</span></div><div className="panel-body stack">
    <p className="small muted">对当前工作区内的目录做真实只读盘点：登记数量、相对路径、类型、大小与「已读 / 仅元数据 / 跳过 / 失败」及原因。权重只登记元数据（不反序列化、不加载）。结果保存在工作区状态文件中，原始目录保持不变。</p>

    <form className="stack" onSubmit={e => { e.preventDefault(); void start(); }}>
      <label htmlFor="gw-tk-roots">盘点目录（工作区相对路径，逗号或换行分隔；留空 = 整个工作区「.」）</label>
      <input id="gw-tk-roots" value={rootsText} placeholder="例如：docs/mvp, work" disabled={busy} onChange={e => setRootsText(e.target.value)} />
      <label htmlFor="gw-tk-scope">范围说明（可选，会随记录保存）</label>
      <input id="gw-tk-scope" value={scopeNote} maxLength={400} disabled={busy} onChange={e => setScopeNote(e.target.value)} />
      <div className="flex"><button className="primary" disabled={busy}>开始只读盘点</button>{open && <button className="outline" disabled={busy} onClick={e => { e.preventDefault(); void refreshScan(); }}>重新盘点</button>}</div>
    </form>

    {list.length > 0 && <div className="stack">
      <h3>已登记的接管（{list.length}）</h3>
      {list.map(item => <div key={item.takeoverId} role="group" aria-label={`接管 ${item.title}`}>
        <div className="flex between">
          <div className="flex"><strong>{item.title}</strong><span className={`badge${item.status === 'saved' ? '' : ' amber'}`} role="status">{item.status === 'saved' ? '已绑定研究' : '草稿（目标待定）'}</span>
            {item.firstError && <span className="badge amber" role="status">首次错误 {item.firstError.code}</span>}</div>
          <button className="link" onClick={() => setOpen(open === item.takeoverId ? null : item.takeoverId)}>{open === item.takeoverId ? '收起' : '查看'}</button>
        </div>
        <p className="small muted mono">范围 {item.roots.join(', ')} · 版本 {item.revision} · {item.updatedAt}</p>
      </div>)}
    </div>}

    {error && <p className="error" role="alert">{error}</p>}

    {detail && !record && <p className="muted">接管记录不存在或已被移除。</p>}
    {detail?.truncated && <p className="badge amber" role="status">盘点被截断（超过条目或字节上限），以下数量不代表完整目录。</p>}
    {record?.firstError && <p className="badge amber" role="status">本次盘点的首个错误：{record.firstError.code} · {record.firstError.message}</p>}
    {detail && detail.freshness.stale && <p className="badge amber" role="status">原始文件已变化（{detail.freshness.changed.length} 项），快照可能已过期；请重新盘点。</p>}

    {scan && <div className="stack">
      <h3>盘点范围与数量</h3>
      <p className="small muted mono">{record!.roots.join(', ')}{record!.scopeNote ? ` · ${record!.scopeNote}` : ''}</p>
      <div className="flex">{([['登记条目', scan.counts.total], ['已读', scan.counts.read], ['仅元数据', scan.counts.metadataOnly], ['跳过', scan.counts.skipped], ['失败', scan.counts.failed], ['总字节', bytes(scan.counts.totalBytes)]] as Array<[string, string | number]>).map(([k, v]) => <div className="stat" key={k}><small>{k}</small><strong>{v}</strong></div>)}</div>
      {scan.errors.length > 0 && <details><summary>盘点错误（{scan.errors.length}）</summary>{scan.errors.map(e => <p className="small" key={`${e.relativePath}-${e.code}`}><span className="mono">{e.relativePath}</span> · {e.code} · {e.message}</p>)}</details>}
      <details><summary>按类型分布</summary><div className="table-wrap"><table><thead><tr><th>类型</th><th>数量</th></tr></thead><tbody>{Object.entries(scan.counts.byKind).filter(([, n]) => n > 0).map(([kind, n]) => <tr key={kind}><td>{KIND_LABEL[kind] ?? kind}</td><td>{n}</td></tr>)}</tbody></table></div></details>
      <details><summary>条目明细（{scan.entries.length}）</summary><div className="table-wrap"><table><thead><tr><th>相对路径</th><th>类型</th><th>大小</th><th>读取状态</th><th>原因</th></tr></thead><tbody>{scan.entries.map(entry => <tr key={entry.entryId}><td className="mono">{entry.relativePath}</td><td>{KIND_LABEL[entry.kind] ?? entry.kind}</td><td>{bytes(entry.bytes)}</td><td>{READ_LABEL[entry.readStatus] ?? entry.readStatus}</td><td className="small muted">{entry.readReason ?? ''}</td></tr>)}</tbody></table></div></details>
    </div>}

    {snapshot && <div className="stack">
      <h3>Research Snapshot（v{snapshot.revision}）</h3>
      {snapshot.model && <p className="small muted">由 {snapshot.model.agentIdentity} / {snapshot.model.modelIdentity} 依据已读内容撰写；引用必须指回真实条目。</p>}
      <p><strong>目前在研究什么：</strong>{snapshot.currentFocus}</p>
      {snapshot.materials.length > 0 && <div><h4>材料与成果</h4>{snapshot.materials.map(m => <p className="small" key={m.materialId}>{m.label} · <span className="badge">{EVIDENCE_LABEL[m.evidenceLevel] ?? m.evidenceLevel}</span><br />{m.detail}</p>)}</div>}
      {snapshot.groups.length > 0 && <div><h4>实验资料分组</h4>{snapshot.groups.map(g => <p className="small" key={g.groupId}>{g.label} <span className="badge">{g.basis}</span>{g.limitedBasis && <span className="badge amber">依据有限</span>}<br />{g.basisNote ?? ''}</p>)}</div>}
      {snapshot.known.length > 0 && <div><h4>已知</h4>{snapshot.known.map(k => <p className="small" key={k}>{k}</p>)}</div>}
      {snapshot.unknown.length > 0 && <div><h4>未知 / 未验证</h4>{snapshot.unknown.map(u => <p className="small" key={u.unknownId}><b>{u.topic}</b><br />{u.detail}</p>)}</div>}
      {snapshot.relations.length > 0 && <div><h4>关系及依据</h4>{snapshot.relations.map(r => <p className="small" key={r.relationId}>{r.fromLabel} → {r.toLabel} · <span className="badge">{r.basis}</span> <span className="badge">{CONFIDENCE_LABEL[r.confidence] ?? r.confidence}</span><br />{r.note}</p>)}</div>}
      {snapshot.nextSteps.length > 0 && <div><h4>下一步建议（未执行）</h4>{snapshot.nextSteps.map((s, i) => <p className="small" key={`${i}-${s}`}>{s}</p>)}</div>}
      {snapshot.citations.length > 0 && <details><summary>引用（{snapshot.citations.length}，均指回已读条目）</summary>{snapshot.citations.map(c => { const entry = scan?.entries.find(e => e.entryId === c.entryId); return <p className="small" key={c.citationId}><span className="mono">{entry?.relativePath ?? c.entryId}</span><br />「{c.quote}」</p>; })}</details>}
    </div>}
    {record && record.adoptions.length > 0 && <div className="stack">
      <h3>已接入研究</h3>
      {record.adoptions.slice(-3).map(adoption => <div key={adoption.adoptionId}>
        <p className="small">研究 <span className="mono">{adoption.researchId ?? '未绑定'}</span> · Snapshot v{adoption.snapshotRevision} · {adoption.status === 'saved' ? '已保存' : adoption.status === 'partial' ? '部分完成' : '已阻止'}</p>
        {adoption.firstError && <p className="badge amber" role="status">{adoption.firstError.code} · {adoption.firstError.message}</p>}
        {adoption.items.filter(item => item.knowledgeId).map(item => <p className="small" key={item.key}>Wiki {item.knowledgeId} v{item.knowledgeVersion} · {item.status}</p>)}
        {adoption.items.filter(item => item.nodeId).map(item => <p className="small" key={`${item.key}-node`}>节点 {item.nodeId} · {item.mode === 'metadata_only' ? '仅元数据' : item.status}</p>)}
      </div>)}
      {detail?.freshness.stale && <p className="badge amber" role="status">原始文件已变化。已接入的 Wiki 仍指向当时的来源副本，需要重审后才能再次发布。</p>}
    </div>}
    {record && !snapshot && <p className="muted">尚未生成 Research Snapshot。快照由 Agent 依据真正读过的内容撰写；在对话中提出接管请求即可生成，或绑定研究后继续。</p>}
  </div></section>;
}
