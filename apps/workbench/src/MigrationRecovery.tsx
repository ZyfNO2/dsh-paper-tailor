import { useState } from 'react';

export function MigrationRecovery({ workspace, refresh }: { workspace: string; refresh: () => Promise<void> }) {
  const [candidate, setCandidate] = useState('.research/compat'), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const [preview, setPreview] = useState<{ workspace: string; candidate: string; recoveryHash: string; migrationId: string; sourceFiles: number; destinationFiles: number; abandonedPid: number | null } | null>(null);
  const run = async (commit: boolean) => {
    if (commit && (!preview || preview.workspace !== workspace || preview.candidate !== candidate)) { setMessage('目录或阶段已变化，请重新核对。'); return; }
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/dsh/migration-recovery?${new URLSearchParams({ workspaceDir: workspace, candidate })}`, commit ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ candidate, expectedHash: preview!.recoveryHash, authorize: true }) } : undefined);
      const result = await response.json(); if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
      if (commit) { setPreview(null); setMessage('已恢复权威目录，原件保留。'); await refresh(); }
      else setPreview({ ...result, workspace });
    } catch (error) { setPreview(null); setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <details><summary>迁移中断恢复</summary><p>仅接续已封存且完整的迁移阶段。原始资料、目标 hash 和失效权限必须全部匹配；不覆盖已有权威目录。</p>
    <label>阶段相对目录<input aria-label="恢复阶段目录" value={candidate} onChange={(e) => { setCandidate(e.target.value); setPreview(null); }} /></label><button disabled={busy} onClick={() => void run(false)}>核对恢复阶段</button>
    {preview && <div><p>{preview.migrationId} · 原件 {preview.sourceFiles} 文件 · 目标 {preview.destinationFiles} 文件{preview.abandonedPid !== null ? ` · 已退出的锁进程 ${preview.abandonedPid}，锁原件将归档` : ''}</p><button disabled={busy} onClick={() => void run(true)}>保留原件并恢复此迁移</button></div>}
    {message && <p role="status">{message}</p>}
  </details>;
}
