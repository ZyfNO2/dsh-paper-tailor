import { useState } from 'react';

interface Preview { inventoryHash: string; sourceWorkspace: string; createdAt: string; files: number; bytes: number; researches: number; warnings: string[] }
/** User-clicked standalone asset export; both the original Studio header and recovery panel use this exact route. */
export async function downloadResearchAssetBackup(workspace: string) {
  const response = await fetch(`/api/dsh/assets/backup?${new URLSearchParams({ workspaceDir: workspace })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ authorize: true }) });
  if (!response.ok) { const failure = await response.json(); throw new Error(failure.message ?? `HTTP ${response.status}`); }
  const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
  link.href = url; link.download = 'dsh-research-assets.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function WorkspaceBackup({ workspace, onRestored }: { workspace: string; onRestored: (directory: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null), [backup, setBackup] = useState<unknown>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [directory, setDirectory] = useState('restored-research'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const endpoint = (action: string) => `/api/dsh/assets/${action}?${new URLSearchParams({ workspaceDir: workspace })}`;
  const request = async (action: string, payload: object) => {
    const response = await fetch(endpoint(action), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    if (!response.ok) { const failure = await response.json(); throw new Error(failure.message ?? `HTTP ${response.status}`); }
    return response;
  };
  const run = async (action: () => Promise<void>) => { setBusy(true); setError(''); setMessage(''); try { await action(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } };
  const download = () => run(async () => {
    await downloadResearchAssetBackup(workspace);
    setMessage('研究资产备份已下载。包括论文库、运行产物和迁移历史；外部代码与环境需另行保存。');
  });
  const inspect = () => run(async () => {
    if (!file) throw new Error('请选择备份文件');
    if (file.size > 96 * 1024 * 1024) throw new Error('备份 JSON 超过 96 MiB');
    const data: unknown = JSON.parse(await file.text());
    const result: Preview = await (await request('preview', { backup: data })).json(); setBackup(data); setPreview(result);
  });
  const restore = () => run(async () => {
    if (!preview || !backup) throw new Error('请先核对备份');
    const result = await (await request('restore', { backup, expectedHash: preview.inventoryHash, directory, authorize: true })).json();
    setMessage(`已恢复到 ${result.target}，来源权限需重新确认。`); await onRestored(result.target);
  });
  return <details><summary>研究资产备份与恢复</summary>
    <p>包含当前项目全部受管原文、论文库、运行产物与迁移历史。备份前请结束或取消活动任务。外部代码、运行环境和客户端日志需另行保存。</p>
    <button disabled={busy || !workspace} onClick={() => void download()}>下载研究资产备份</button>
    <label>资产备份文件<input aria-label="资产备份文件" type="file" accept=".json" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setBackup(null); setPreview(null); setError(''); setMessage(''); }} /></label>
    <button disabled={busy || !file} onClick={() => void inspect()}>核对资产备份</button>
    {preview && <div><p>来源：{preview.sourceWorkspace} · {preview.researches} 项研究 · {preview.files} 个文件 · {preview.bytes.toLocaleString()} bytes</p>{preview.warnings.map(warning => <p key={warning}>{warning}</p>)}
      <label>新目录名称<input aria-label="恢复新目录名称" disabled={busy} value={directory} onChange={event => setDirectory(event.target.value)} /></label>
      <p>将恢复到当前工作目录下的 {directory}。已有目录不会被覆盖，来源授权与节点确认需重新核对。</p>
      <button disabled={busy || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(directory)} onClick={() => void restore()}>恢复到新目录并打开</button></div>}
    {busy && <p role="status">正在处理研究资产…</p>}{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </details>;
}
