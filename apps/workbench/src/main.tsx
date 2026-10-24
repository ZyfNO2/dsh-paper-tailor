import { ExternalAssignments } from './ExternalAssignments.tsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GeneralWorkbench } from '../../../packages/evolver-ui/src/client/general/GeneralWorkbench.tsx';
import { type BootstrapReadPayload, emitBootstrapEvent, isBootstrapEvent, withBootstrap } from '../../../packages/evolver-ui/src/client/integration/research-bootstrap-view.ts';
import { StudioWorkbench } from '../../../packages/evolver-ui/src/client/studio/StudioWorkbench.tsx';
import { WorkbenchView } from '../../../packages/evolver-ui/src/client/redesign/WorkbenchView.tsx';
import { librarySnapshot, type PaperLibraryRow } from '../../../packages/evolver-ui/src/client/integration/paper-library-view.ts';
import { blankSnapshot } from '../../../packages/evolver-ui/src/client/integration/projection-adapter.ts';
import { withResearchCycle, type ResearchCycleData } from '../../../packages/evolver-ui/src/client/integration/research-cycle-view.ts';
import { ExternalHandoff } from './ExternalHandoff.tsx';
import { ExternalResults } from './ExternalResults.tsx';
import { MigrationRecovery } from './MigrationRecovery.tsx';
import { WorkspaceBackup, downloadResearchAssetBackup } from './WorkspaceBackup.tsx';

/** The existing product UI is reused; standalone transport will supply its projections. */
let selectedWorkspace = '';
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const requested = typeof input === 'string' || input instanceof URL ? new URL(input, location.href) : new URL(input.url);
  if (requested.origin === location.origin && requested.pathname.startsWith('/evolver/')) {
    const routes: Record<string, string> = { '/evolver/research-bootstrap': '/api/dsh/bootstrap', '/evolver/research-bootstrap/actions': '/api/dsh/actions', '/evolver/paper-library': '/api/dsh/papers' };
    requested.pathname = routes[requested.pathname] ?? (requested.pathname.startsWith('/evolver/research-bootstrap/') ? requested.pathname.replace('/evolver/research-bootstrap/', '/api/dsh/bootstrap/') : requested.pathname.startsWith('/evolver/research-foundations') ? requested.pathname.replace('/evolver/research-foundations', '/api/dsh/foundations') : requested.pathname.startsWith('/evolver/research-cycle') ? requested.pathname.replace('/evolver/research-cycle', '/api/dsh/cycle') : `/api/dsh/unsupported${requested.pathname}`);
    requested.searchParams.delete('sessionId');
    requested.searchParams.set('workspaceDir', selectedWorkspace);
    return nativeFetch(input instanceof Request ? new Request(requested, input) : requested, init);
  }
  return nativeFetch(input, init);
};

export function StandaloneWorkbench() {
  const [workspace, setWorkspace] = useState('');
  const [read, setRead] = useState<(BootstrapReadPayload & { cycle?: ResearchCycleData | null; cycleError?: string; restoredAssetBackup?: { restoredAt: string; sourceWorkspace: string; inventoryHash: string } | null; papers?: PaperLibraryRow[]; readOnly?: boolean; historicalPrototype?: boolean; migrationKind?: 'dsh' | 'prototype' | null }) | null>(null);
  const [paperOpen, setPaperOpen] = useState(false), [paperFile, setPaperFile] = useState<File | null>(null), [paperBusy, setPaperBusy] = useState(false);
  const [migration, setMigration] = useState<{ kind: 'prototype' | 'dsh'; workspaceDir: string; sourceInventoryHash: string; referencesValid: boolean; issues: string[]; objects: object; warnings: string[] } | null>(null);
  const [history, setHistory] = useState<unknown>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [error, setError] = useState('');
  const [sync, setSync] = useState<'connecting' | 'live' | 'retrying'>('connecting');
  const reads = useRef(0);
  const owner = read ? `workspace:${read.workspace.id}` : '';
  const snapshot = useMemo(() => read ? withResearchCycle(withBootstrap(librarySnapshot(owner, read.papers ?? []), read.bootstrap), read.cycle ?? null) : blankSnapshot('', 'loading', '正在读取研究资产'), [read, owner]);
  const refresh = async () => {
    const requestId = ++reads.current, workspaceDir = selectedWorkspace;
    const response = await nativeFetch(`/api/dsh/bootstrap?${new URLSearchParams({ workspaceDir })}`, { credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? `HTTP ${response.status}`);
    const researchId = result.bootstrap.activeResearchId;
    const active = result.bootstrap.researches.find((r: { researchId: string }) => r.researchId === researchId);
    if (researchId && (active?.general || result.bootstrap.graph)) {
      const cycleResponse = await nativeFetch(`/api/dsh/cycle?${new URLSearchParams({ workspaceDir, researchId })}`);
      const cycle = await cycleResponse.json();
      if (!cycleResponse.ok) { result.cycle = null; result.cycleError = cycle.message ?? cycle.error ?? `HTTP ${cycleResponse.status}`; }
      else result.cycle = cycle;
    }
    if (requestId !== reads.current || workspaceDir !== selectedWorkspace) return;
    window.localStorage.setItem('dsh:last-workspace', workspaceDir);
    const bookmark = new URL(window.location.href);
    if (bookmark.searchParams.get('workspaceDir') !== workspaceDir) { bookmark.searchParams.set('workspaceDir', workspaceDir); window.history.replaceState(null, '', bookmark); }
    setRead(result); setSync('live');
  };
  useEffect(() => { void nativeFetch('/api/workspaces').then((r) => r.json()).then((data) => { selectedWorkspace = new URLSearchParams(window.location.search).get('workspaceDir') || window.localStorage.getItem('dsh:last-workspace') || data.workspaces[0] || ''; setWorkspace(selectedWorkspace); return refresh(); }).catch((e) => setError(String(e))); }, []);
  useEffect(() => {
    let pending = false;
    const timer = setInterval(() => {
      if (pending || !selectedWorkspace || document.hidden) return;
      pending = true;
      void refresh().catch((e) => { setSync('retrying'); setError(String(e)); }).finally(() => { pending = false; });
    }, 3000);
    return () => clearInterval(timer);
  }, []);
  const previewMigration = async () => {
    const workspaceDir = selectedWorkspace;
    const response = await nativeFetch(`/api/dsh/migration?${new URLSearchParams({ workspaceDir })}`);
    const result = await response.json(); if (!response.ok) throw new Error(result.message);
    setMigration({ ...result, workspaceDir });
  };
  const migrate = async () => {
    if (!migration || migration.workspaceDir !== selectedWorkspace) throw new Error('工作目录已变化，请重新预览迁移');
    setMigrationBusy(true);
    try {
      const response = await nativeFetch(`/api/dsh/migrate?${new URLSearchParams({ workspaceDir: migration.workspaceDir })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedHash: migration.sourceInventoryHash, kind: migration.kind }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      setMigration(null); await refresh();
    } finally { setMigrationBusy(false); }
  };
  const loadHistory = async () => {
    const workspaceDir = selectedWorkspace;
    const response = await nativeFetch(`/api/dsh/bootstrap/prototype-history?${new URLSearchParams({ workspaceDir })}`);
    const result = await response.json(); if (!response.ok) throw new Error(result.message);
    if (workspaceDir === selectedWorkspace) setHistory(result);
  };
  const importPaper = async () => {
    if (!paperFile || paperBusy) return;
    const workspaceDir = selectedWorkspace;
    setPaperBusy(true); setError('');
    try {
      if (paperFile.size > 10 * 1024 * 1024) throw new Error('原文单文件最大 10 MiB');
      const bytes = new Uint8Array(await paperFile.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const response = await nativeFetch(`/api/dsh/papers?${new URLSearchParams({ workspaceDir })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'import', filename: paperFile.name, contentBase64: btoa(binary) }) });
      const result = await response.json(); if (!response.ok) throw new Error(result.message);
      if (workspaceDir === selectedWorkspace) { setPaperFile(null); await refresh(); }
    } finally { setPaperBusy(false); }
  };
  const paperView = (page: string = 'wiki') => <WorkbenchView key={owner} surface={page === 'wiki' ? 'papers' : page === 'tree' ? 'tree' : 'cockpit'} snapshot={snapshot} availableHeight={null} bottomInset={0} onRetry={() => void refresh().catch((e) => setError(String(e)))} onEvent={async (event) => {
    if (event.type === 'select') return { ok: true, message: '已定位知识资产' };
    if (isBootstrapEvent(event.type)) { const outcome = await emitBootstrapEvent(owner, event); if (outcome.ok) await refresh(); return outcome; }
    return { ok: false, message: '该动作尚未接入独立工作台，未保存或派发。', reason: '该动作尚未接入独立工作台，未保存或派发。' };
  }} />;
  const activeResearch = read?.bootstrap.researches.find(research => research.researchId === read.bootstrap.activeResearchId);
  return <div className="standalone-host"><style>{`html,body,#root{height:100%;margin:0}.standalone-host{height:100dvh;display:flex;flex-direction:column;overflow:hidden}.standalone-host>.gw{height:auto;flex:1;min-height:0}.standalone-host>aside{flex:0 0 auto;max-height:40vh;overflow:auto;padding:10px 18px;border-bottom:1px solid #dfe6e1;background:#fff;color:#172522;font:14px/1.6 system-ui}.standalone-host>aside label{margin-left:14px}.standalone-host>aside input{width:min(50vw,650px);margin:0 10px;padding:5px}.standalone-host>aside button{padding:5px 10px}.standalone-host>aside pre{white-space:pre-wrap;overflow-wrap:anywhere}`}</style><aside>独立研究工作台。<label>工作目录<input value={workspace} onChange={(e) => setWorkspace(e.target.value)} /></label><button onClick={() => { selectedWorkspace = workspace; setRead(null); setMigration(null); setHistory(null); setError(''); void refresh().catch((e) => setError(String(e))); }}>读取项目</button>{error && <p role="alert">{error}</p>}
    {read?.restoredAssetBackup && <p>此目录从研究资产备份恢复。原运行与审查仅作为历史记录，尚未重新验证模型来源或独立评审；来源权限需重新确认。</p>}
    {read?.readOnly && <p>{read.migrationKind === 'prototype' ? '早期轻量项目目前只读。' : '旧 DSH 项目目前只读。'}<button onClick={() => void previewMigration().catch((e) => setError(String(e)))}>预览旧研究迁移</button></p>}
    {migration && <div><pre>{JSON.stringify(migration.objects, null, 2)}</pre>{migration.warnings.map((warning) => <p key={warning}>{warning}</p>)}{migration.issues.map((issue) => <p key={issue}>{issue}</p>)}<button disabled={!migration.referencesValid || migrationBusy} onClick={() => void migrate().catch((e) => setError(String(e)))}>保留原件并迁移到独立工作区</button></div>}
    {read?.historicalPrototype && <details><summary>轻量项目迁移历史</summary><p>须在资料权限中重新授权原来源后读取。</p><button onClick={() => void loadHistory().catch((e) => setError(String(e)))}>核对并读取原始历史</button>{history !== null && <pre style={{ maxHeight: 400, overflow: 'auto' }}>{JSON.stringify(history, null, 2)}</pre>}</details>}
    {read?.cycleError && <p role="alert">研究运行记录读取失败：{read.cycleError}</p>}
    {(error || read?.readOnly) && <MigrationRecovery key={selectedWorkspace} workspace={selectedWorkspace} refresh={async () => { await refresh(); setError(''); }} />}
    {read && !read.readOnly && <ExternalHandoff key={`${owner}:${read.bootstrap.activeResearchId}`} workspace={selectedWorkspace} bootstrap={read.bootstrap} cycle={read.cycle ?? null} refresh={refresh} />}
    {read && !read.readOnly && activeResearch?.general && <ExternalResults key={`results:${selectedWorkspace}:${activeResearch.researchId}`} workspace={selectedWorkspace} researchId={activeResearch.researchId} revision={read.bootstrap.revision} refresh={refresh} />}
    {read && !read.readOnly && activeResearch?.general && <ExternalAssignments key={`assignments:${selectedWorkspace}:${activeResearch.researchId}`} workspace={selectedWorkspace} researchId={activeResearch.researchId} revision={read.bootstrap.revision} refresh={refresh} />}
    <WorkspaceBackup key={`backup:${selectedWorkspace}`} workspace={selectedWorkspace} onRestored={async directory => { selectedWorkspace = directory; setWorkspace(directory); setRead(null); setMigration(null); setHistory(null); setError(''); await refresh(); }} />
    </aside>
    <aside><button onClick={() => setPaperOpen((open) => !open)}>{paperOpen ? '返回 Research Studio' : '论文与研究组件'}</button>{paperOpen && <><label>论文原文<input aria-label="论文原文" type="file" accept=".txt,.md,.pdf" disabled={paperBusy || read?.readOnly} onChange={(e) => setPaperFile(e.target.files?.[0] ?? null)} /></label><button disabled={!paperFile || paperBusy || read?.readOnly} onClick={() => void importPaper().catch((e) => setError(String(e)))}>上传原文</button><span> 上传不自动生成 Wiki 或组件，整理结果需保留原文引用。</span></>}</aside>
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>{paperOpen ? paperView() : <StudioWorkbench key={read?.workspace.id ?? 'loading'} onExportAssets={() => downloadResearchAssetBackup(selectedWorkspace)} snapshot={snapshot} sessionId={owner} read={read} refresh={refresh} syncStatus={sync} workspaceTitle={read?.workspace.title ?? '本地研究项目'}>{(page) => <GeneralWorkbench initialPage={page} cycle={snapshot.cycle} sessionId={owner} read={read} refresh={refresh} sync={{ status: sync }} onResync={() => void refresh().catch((e) => setError(String(e)))} legacy={(legacyPage) => paperView(legacyPage)} workspace={{ title: read?.workspace.title ?? '本地研究项目', papers: read?.papers?.length ?? 0 }} />}</StudioWorkbench>}</div>
  </div>;
}

const mount = document.getElementById('root');
if (!mount) throw new Error('standalone workbench root is missing');
createRoot(mount).render(<StandaloneWorkbench />);
