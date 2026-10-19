
import { useEffect, useRef, useState } from 'react';
import type { GeneralResearch } from '../../../../evolver/src/contracts/general-research.ts';
import type { GeneralSchedule } from '../../../../evolver/src/contracts/general-schedule.ts';
import { newOperationId } from '../redesign/research-actions.ts';
export function SchedulePanel(props: { general: GeneralResearch; researchId: string; sessionId: string; schedules: GeneralSchedule[]; runtimeAvailable: boolean; refresh(): Promise<void> }): JSX.Element {
  const [nodes, setNodes] = useState<string[]>([]), [sources, setSources] = useState<string[]>([]), [authorized, setAuthorized] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(false), retry = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => { setAuthorized(null); }, [props.general.revision, nodes, sources]);
  const submit = async (type: 'create_schedule' | 'run_schedule' | 'stop_schedule', scheduleId?: string) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError('');
    const key = JSON.stringify({ type, scheduleId, nodes, sources, revision: props.general.revision });
    if (retry.current?.key !== key) retry.current = { key, id: newOperationId('schedule-ui') };
    try {
      const query = `sessionId=${encodeURIComponent(props.sessionId)}&researchId=${encodeURIComponent(props.researchId)}`;
      const cycleResponse = await fetch(`/evolver/research-cycle?${query}`, { credentials: 'same-origin' });
      const cycle = await cycleResponse.json(); if (!cycleResponse.ok) throw new Error(cycle.message ?? cycle.error);
      const bootstrapResponse = await fetch(`/evolver/research-bootstrap?sessionId=${encodeURIComponent(props.sessionId)}`, { credentials: 'same-origin' });
      const bootstrap = await bootstrapResponse.json(); if (!bootstrapResponse.ok) throw new Error(bootstrap.message ?? bootstrap.error);
      const g = bootstrap.bootstrap.researches.find((r: { researchId: string }) => r.researchId === props.researchId)?.general;
      if (type !== 'stop_schedule' && g?.revision !== props.general.revision) throw new Error('研究版本已变，请同步并重审队列范围后提交。');
      const response = await fetch(`/evolver/research-cycle/actions?sessionId=${encodeURIComponent(props.sessionId)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, operationId: retry.current.id, researchId: props.researchId, baseRevision: bootstrap.bootstrap.revision, cycleRevision: cycle.research.cycleRevision, ...(type === 'create_schedule' ? { selectedIdeaId: props.general.ideas[0]?.ideaId, tasks: nodes.map(nodeId => ({ nodeId, sourceIds: sources })) } : { scheduleId, ...(type === 'run_schedule' ? { authorize: authorized === scheduleId } : {}) }) }) });
      const result = await response.json(); if (!response.ok || result.ok !== true) throw new Error(result.reason ?? result.message ?? result.error);
      setMessage(result.message); await props.refresh(); retry.current = null; setAuthorized(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; setBusy(false); }
  };
  return <section className="panel stack" aria-label="有限任务队列"><h3>有限任务队列</h3><p className="small muted">按选入顺序执行现有节点，最多 {props.general.limits.maxRounds} 项；入队不执行。失败、前置未满足或范围改变会停止，后续任务保持未执行。</p>
    <fieldset disabled={busy}><legend>待排队节点（选择顺序就是执行顺序）</legend>{props.general.graph.nodes.map(n => <label key={n.nodeId} className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={nodes.includes(n.nodeId)} onChange={e => { const checked = e.currentTarget.checked; setNodes(ids => checked ? [...ids, n.nodeId] : ids.filter(id => id !== n.nodeId)); }} />{n.title}{nodes.includes(n.nodeId) ? ` · 第 ${nodes.indexOf(n.nodeId) + 1} 项` : ''}</label>)}</fieldset>
    <label>本队列分配的来源<select multiple value={sources} disabled={busy} onChange={e => setSources([...e.currentTarget.selectedOptions].map(o => o.value))}>{props.general.sources.map(s => <option key={s.sourceId} value={s.sourceId}>{s.filename} · {s.nature}</option>)}</select></label>
    <button disabled={busy || !nodes.length || nodes.length > props.general.limits.maxRounds || sources.length > 10} onClick={() => void submit('create_schedule')}>保存队列（不执行）</button>
    {props.schedules.map(s => <details key={s.scheduleId}><summary>{s.scheduleId} · {s.status}</summary><p className="small">额度 {s.maxTasks} 项 · 截止 {s.deadline ?? '未设置'} · 授权 {s.authorizedBy}</p><ol>{s.tasks.map(t => <li key={t.taskId}>{props.general.graph.nodes.find(n => n.nodeId === t.nodeId)?.title ?? t.nodeId} · {t.status} · {t.runId ?? '尚未创建运行'} · 来源：{t.sourceIds.map(id => props.general.sources.find(s => s.sourceId === id)?.filename ?? id).join('、') || '无'}</li>)}</ol>{s.error && <p role="alert">{s.error.code}：{s.error.message}</p>}
      <label className="flex"><input type="checkbox" style={{ width: 'auto' }} checked={authorized === s.scheduleId} disabled={busy || s.status === 'running' || s.status === 'completed'} onChange={e => setAuthorized(e.currentTarget.checked ? s.scheduleId : null)} />明确授权此队列的节点、来源与额度；不授权真实实验</label>
      {['pending', 'stopped'].includes(s.status) && <button disabled={busy || authorized !== s.scheduleId || !props.runtimeAvailable} onClick={() => void submit('run_schedule', s.scheduleId)}>明确启动/继续此队列</button>}
      {s.status !== 'completed' && <button disabled={busy} onClick={() => void submit('stop_schedule', s.scheduleId)}>停止此队列</button>}
      {!!s.stopHistory.length && <details><summary>停止历史</summary><pre>{JSON.stringify(s.stopHistory, null, 2)}</pre></details>}
    </details>)}{message && <p role="status">{message}</p>}{error && <p role="alert" className="error">{error}</p>}
  </section>;
}
