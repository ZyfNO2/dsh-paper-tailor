import { ImportedPlanAdoption } from './ImportedPlanAdoption.tsx';
import { useRef, useState } from 'react';
import type { GeneralResearch } from '../../../../evolver/src/contracts/general-research.ts';
import { newOperationId } from '../redesign/research-actions.ts';
export function PackagePanel(props: { sessionId: string; researchId: string; general?: GeneralResearch; revision: number; busy: boolean; action(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null>; refresh(): Promise<void>; setBusy(value: boolean): void }): JSX.Element {
  const [file, setFile] = useState<File | null>(null), [title, setTitle] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const pending = useRef(false), retry = useRef<{ file: File; title: string; operationId: string } | null>(null);
  const endpoint = `/evolver/research-bootstrap/package?sessionId=${encodeURIComponent(props.sessionId)}`;
  const download = async (importId?: string) => {
    if (props.busy || pending.current) return; pending.current = true; props.setBusy(true); setError('');
    try {
      const response = await fetch(`${endpoint}&researchId=${encodeURIComponent(props.researchId)}${importId ? `&importId=${encodeURIComponent(importId)}` : ''}`, { credentials: 'same-origin' });
      const text = await response.text(); if (!response.ok) throw new Error(JSON.parse(text).message ?? `HTTP ${response.status}`);
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = `research-${importId ?? props.researchId}.portable.json`; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(importId ? '导入前历史已导出；仍待本地重审。' : '完整研究包已导出。');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pending.current = false; props.setBusy(false); }
  };
  const importPackage = async () => {
    if (!file || !title.trim() || props.busy || pending.current) return;
    if (file.size > 64 * 1024 * 1024) { setError('研究包超过 64 MiB。'); return; }
    pending.current = true; props.setBusy(true); setError(''); setMessage('正在校验并保存，尚未取得回执…');
    if (retry.current?.file !== file || retry.current.title !== title) retry.current = { file, title, operationId: newOperationId('package-import') };
    try {
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()));
      const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ package: value, title, baseRevision: props.revision, operationId: retry.current.operationId }) });
      const receipt = await response.json(); if (!response.ok || receipt.ok !== true) throw new Error(receipt.message ?? receipt.error ?? `HTTP ${response.status}`);
      await props.refresh(); retry.current = null; setFile(null); setTitle(''); setMessage(`已创建新研究 ${receipt.researchId}，历史待重审，资料使用待本地授权。`);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setMessage('未取得成功回执；保留所选文件，可同步后重试。'); }
    finally { pending.current = false; props.setBusy(false); }
  };
  return <section className="panel stack"><h3>研究包与历史恢复</h3>
    <p className="small muted">完整包含原始材料、解析数据和历史产物。导入创建新研究；旧授权、完成状态和运行任务需重新核对。</p>
    {props.general && <button disabled={props.busy} onClick={() => void download()}>导出可恢复研究包</button>}
    <label>选择研究包 JSON<input type="file" accept=".json,application/json" disabled={props.busy} onChange={e => { setFile(e.target.files?.[0] ?? null); retry.current = null; }} /></label>
    <label>新研究名称<input value={title} maxLength={300} disabled={props.busy} onChange={e => setTitle(e.target.value)} /></label>
    <button disabled={props.busy || !file || !title.trim()} onClick={() => void importPackage()}>校验并导入为新研究</button>
    {props.general?.importedHistory.map(r => <details key={r.importId}><summary>{r.title} · 导入历史待重审</summary><p className="small">原研究 {r.originalResearchId} · {r.importedAt}。当前源材料授权后可导出完整历史查看。</p><button disabled={props.busy} onClick={() => void download(r.importId)}>导出导入前历史</button><table><thead><tr><th>类型</th><th>原 ID</th><th>新 ID</th></tr></thead><tbody>{r.idMap.map(m => <tr key={`${m.kind}:${m.original}`}><td>{m.kind}</td><td>{m.original}</td><td>{m.current}</td></tr>)}</tbody></table><ImportedPlanAdoption key={r.importId} sessionId={props.sessionId} researchId={props.researchId} importId={r.importId} busy={props.busy} action={props.action} /></details>)}
    {error && <p role="alert" className="error">{error}</p>}{message && <p role="status" className="small muted">{message}</p>}
  </section>;
}
