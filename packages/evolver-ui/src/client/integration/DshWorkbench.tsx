import { useEffect, useRef, useState } from 'react';
import { WorkbenchView } from '../redesign/WorkbenchView.tsx';
import { GeneralWorkbench } from '../general/GeneralWorkbench.tsx';
import { StudioWorkbench } from '../studio/StudioWorkbench.tsx';
import type { WorkbenchEvent, WorkbenchSnapshot } from '../redesign/view-model.ts';
import { blankSnapshot, unavailableActions } from './projection-adapter.ts';
import { librarySnapshot, type PaperLibraryRow, type PaperRunRow } from './paper-library-view.ts';
import { emitBootstrapEvent, isBootstrapEvent, readBootstrap, withBootstrap, type BootstrapReadPayload } from './research-bootstrap-view.ts';
import { emitResearchCycle, readResearchCycle, withResearchCycle } from './research-cycle-view.ts';
// Partial on purpose: the map only lists actions this view actually refuses, and
// indexing falls back to a generic reason for anything absent.
const libraryActions: Partial<Record<WorkbenchEvent['type'] | 'add_component' | 'paper_similarity', string>> = { ...unavailableActions,
  create_trial: '当前 Phase2 支持已有证据研究循环；真实训练 Trial 需 Phase3 执行入口。',
  attach_citation: '实验引用的网页写入桥尚未挂载，可查看已有引用。', request_branch_action: '分支决策通过研究循环 Reviewer 登记，当前没有独立分支编辑桥。',
  request_implementation: '当前 Phase2 不生成或运行实验代码。',
  save_note: '请在对话中修改 Wiki；当前不提供独立论文备注。', paper_similarity: '暂未启用相似文献检索。' };

/** Session identity resolves the workspace; structured workspace files own the assets. */
export function DshWorkbench(props: { sessionId?: string }): JSX.Element {
  const owner = props.sessionId ?? '';
  const [snapshot, setSnapshot] = useState<WorkbenchSnapshot>(() => blankSnapshot(owner, 'loading', '正在读取工作区知识库…'));
  const [reload, setReload] = useState(0);
  const [generalRead, setGeneralRead] = useState<BootstrapReadPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'live' | 'retrying'>('connecting');
  const [count, setCount] = useState(0);
  const [workspaceTitle, setWorkspaceTitle] = useState('当前工作区');
  const [availableHeight, setAvailableHeight] = useState<number | null>(null);
  // How much of the tab body the host's composer actually covers. The composer is a
  // `position: sticky` seat pinned to the viewport bottom (measured 128px on the
  // live host), so a page that fills the allocated height loses its last ~150px —
  // exactly what hid the bottom of the 实验编排 stage list behind the input box.
  // Measured, never guessed: no composer found => 0.
  const [bottomInset, setBottomInset] = useState(0);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  // The measured box MUST be the one the HOST allocated, never this component's own
  // root. Writing a measured height back onto the observed element is a feedback
  // loop: measured 924px → .rd-root gets height:924px → its content grows the
  // auto-sized ancestors → the observer reports 28096px → .rd-root grows again…
  // That is exactly how the 实验编排 panel ended up ~28 000px tall (15434px even
  // with an empty tree), which pushed the whole page into one long scroll and made
  // the panel's own scrollbar dead.
  //
  // So: walk UP to the nearest ancestor that actually scrolls (the DSH view area),
  // fall back to the nearest ancestor with a resolved px height, and clamp to the
  // viewport so a runaway measurement can never be applied.
  useEffect(() => {
    const element = hostRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;
    const layoutHost = (): HTMLElement | null => {
      let sized: HTMLElement | null = null;
      let node: HTMLElement | null = element.parentElement;
      while (node !== null) {
        const style = window.getComputedStyle(node);
        const scrolls = style.overflowY === 'auto' || style.overflowY === 'scroll';
        if (scrolls && node.clientHeight > 0) return node;
        if (sized === null && style.display !== 'contents' && node.clientHeight > 0 && /^\d+(\.\d+)?px$/.test(style.height)) {
          sized = node;
        }
        node = node.parentElement;
      }
      return sized;
    };
    const target = layoutHost() ?? element;
    const apply = (): void => {
      const measured = target.clientHeight;
      if (measured <= 0) return;
      setAvailableHeight(Math.min(measured, window.innerHeight));
    };
    const observer = new ResizeObserver(apply);
    observer.observe(target);
    apply();
    window.addEventListener('resize', apply);
    return () => { observer.disconnect(); window.removeEventListener('resize', apply); };
  }, []);
  /**
   * Reserve the space the composer overlays.
   *
   * The DSH composer is a sticky seat at the bottom of the view area, not a
   * sibling that shrinks this tab, so `clientHeight` alone still leaves the last
   * rows underneath it. Find the sticky/overlay box that sits at the viewport
   * bottom and reserve its visible height — bounded, and 0 when nothing overlays.
   */
  useEffect(() => {
    const element = hostRef.current;
    if (element === null) return undefined;
    const measure = (): void => {
      const viewportBottom = window.innerHeight;
      let overlap = 0;
      for (const node of document.querySelectorAll<HTMLElement>('div,form,section,footer')) {
        const rect = node.getBoundingClientRect();
        if (rect.height < 40 || rect.height > 340) continue;
        if (rect.bottom < viewportBottom - 8) continue;
        if (!node.querySelector('textarea, [contenteditable="true"]') && !/发消息|创建任务|调用指令/.test(node.textContent ?? '')) continue;
        // Only a box that actually overlays this host counts.
        const hostRect = element.getBoundingClientRect();
        if (rect.top <= hostRect.top || rect.top >= viewportBottom || rect.right <= hostRect.left || rect.left >= hostRect.right) continue;
        // Anchor to the allocated viewport bottom, not our own shrinking bottom;
        // otherwise a correctly reserved composer flips the next sample to zero.
        overlap = Math.max(overlap, Math.min(340, viewportBottom - rect.top));
      }
      setBottomInset(Math.round(overlap));
    };
    measure();
    window.addEventListener('resize', measure);
    const timer = window.setInterval(measure, 1500);
    return () => { window.removeEventListener('resize', measure); window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>; let failures = 0, previous = '';
    let lastBootstrap: BootstrapReadPayload | null = null;
    let refreshing = false, refreshAgain = false;
    const refreshWaiters: Array<() => void> = [];
    setSnapshot(blankSnapshot(owner, 'loading', '正在读取工作区知识库…')); setGeneralRead(null); setError(null); setCount(0); setWorkspaceTitle('当前工作区');
    async function refresh(): Promise<void> {
      if (refreshing) { refreshAgain = true; return new Promise<void>((resolve) => refreshWaiters.push(resolve)); }
      refreshing = true;
      clearTimeout(timer);
      try {
        if (!owner) throw new Error('工作台没有获得 DSH 会话身份。');
        // 空响应体（路由未挂载/网关错误）会让 json() 抛出难以定位的
        // "Unexpected end of JSON input"；先取文本再解析，失败时给出可行动的错误。
        const parseJson = async (res: Response, label: string): Promise<Record<string, unknown>> => {
          const raw = await res.text();
          if (raw.length === 0) throw new Error(`${label} HTTP ${res.status}: 后端返回空响应体（路由未挂载或宿主异常）`);
          try { return JSON.parse(raw) as Record<string, unknown>; } catch { throw new Error(`${label} HTTP ${res.status}: 响应不是有效 JSON（${raw.slice(0, 80)}）`); }
        };
        const [paperResponse, bootstrapRead] = await Promise.all([
          fetch(`/evolver/paper-library?sessionId=${encodeURIComponent(owner)}`, { credentials: 'same-origin', signal: abort.signal }),
          readBootstrap(owner, abort.signal),
        ]);
        const body = await parseJson(paperResponse, '论文库') as { schemaVersion: number; scope: string; workspace: { id: string; title: string }; papers: PaperLibraryRow[]; runs?: PaperRunRow[]; error?: string; message?: string };
        if (!paperResponse.ok) throw new Error(`论文库接口 ${paperResponse.status}: ${body.message ?? body.error}`);
        // `runs` is optional so an older/absent response still renders the assets.
        if (body.schemaVersion !== 2 || body.scope !== 'workspace-files' || !body.workspace?.id || !Array.isArray(body.papers)) throw new Error('工作区知识库响应格式错误。');
        if (abort.signal.aborted) return;
        // Never let a delayed response replace a newer persisted revision.
        if (bootstrapRead !== null && (lastBootstrap === null || bootstrapRead.bootstrap.revision >= lastBootstrap.bootstrap.revision)) lastBootstrap = bootstrapRead;
        const cycle = lastBootstrap?.bootstrap.activeResearchId && (lastBootstrap.bootstrap.graph || lastBootstrap.bootstrap.researches.find(r => r.researchId === lastBootstrap!.bootstrap.activeResearchId)?.general)
          ? await readResearchCycle(owner, lastBootstrap.bootstrap.activeResearchId, abort.signal) : null;
        if (abort.signal.aborted) return;
        const version = JSON.stringify([body.papers, body.runs, lastBootstrap, cycle]);
        if (version !== previous) {
          let next = librarySnapshot(owner, body.papers, body.runs ?? []);
          if (lastBootstrap !== null) {
            // The bootstrap mount is live: merge the research projection into the snapshot.
            next = withBootstrap(next, lastBootstrap.bootstrap);
          }
          next = withResearchCycle(next, cycle);
          setSnapshot(next); setGeneralRead(lastBootstrap); previous = version;
        }
        setCount(body.papers.length); setWorkspaceTitle(body.workspace.title); setError(null); failures = 0;
      } catch (failure) {
        if (abort.signal.aborted) return;
        const message = failure instanceof Error ? failure.message : String(failure);
        setError(message); failures++;
        // Keep last readable state visible; a transport error is not an empty library.
        if (!previous) setSnapshot(blankSnapshot(owner, 'error', message));
      }
      refreshing = false;
      if (abort.signal.aborted) { refreshWaiters.splice(0).forEach((resolve) => resolve()); return; }
      if (refreshAgain) { refreshAgain = false; await refresh(); return; }
      refreshWaiters.splice(0).forEach((resolve) => resolve());
      timer = setTimeout(() => { void refresh(); }, 15000 * Math.max(1, Math.min(failures, 4)));
    }
    refreshRef.current = refresh;
    // Persisted file changes, including worker writes, invalidate this projection.
    const events = new EventSource(`/evolver/research-bootstrap/events?sessionId=${encodeURIComponent(owner)}`);
    setSyncStatus('connecting');
    events.onopen = () => setSyncStatus('live');
    events.onerror = () => setSyncStatus('retrying');
    events.addEventListener('research-changed', () => { void refresh(); });
    events.addEventListener('sync-error', (event) => setError(`自动同步失败：${(event as MessageEvent).data}`));
    const resume = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', resume);
    void refresh(); return () => { abort.abort(); refreshWaiters.splice(0).forEach((resolve) => resolve()); clearTimeout(timer); events.close(); document.removeEventListener('visibilitychange', resume); };
  }, [owner, reload]);
  // Shrink the root for the composer instead of padding a full-height root:
  // the sticky composer also occupies host flow, which otherwise adds an outer
  // scrollbar and scrolls the Studio header out of view when controls receive focus.
  // The host's chat-width handles sit at z-index 0 across the view area. Like
  // its transcript content, the full-width workbench must paint above them.
  return <div ref={hostRef} data-dsh-workbench="redesign" style={{ position: 'relative', zIndex: 1, containerType: 'inline-size', containerName: 'dsh-workbench', display: 'flex', flexDirection: 'column', height: availableHeight === null ? '100%' : Math.max(0, availableHeight - bottomInset), boxSizing: 'border-box', overflow: 'hidden', minHeight: 0 }}>
    {error !== null && <div role="alert" style={{ padding: '8px 20px', color: 'var(--rd-red)', background: '#fff1f1', borderBottom: '1px solid #efd4d4' }}>{error}</div>}
    <div style={{ flex: 1, minHeight: 0 }}><StudioWorkbench snapshot={snapshot} read={generalRead} sessionId={owner} refresh={() => refreshRef.current()} syncStatus={syncStatus} workspaceTitle={workspaceTitle}>{(toolPage) => <GeneralWorkbench initialPage={toolPage} cycle={snapshot.cycle} key={owner} sessionId={owner} read={generalRead} refresh={() => refreshRef.current()} sync={{ status: syncStatus }} onResync={() => { void refreshRef.current(); }} workspace={{ title: workspaceTitle, papers: count }} legacy={(page) => <WorkbenchView key={owner} surface={page === 'wiki' ? 'papers' : page === 'tree' ? 'tree' : 'cockpit'} initialTab="tree" snapshot={snapshot} availableHeight={availableHeight} bottomInset={bottomInset} onRetry={() => setReload((v) => v + 1)} onEvent={async (event: WorkbenchEvent) => {
      if (event.type === 'select') return { ok: true, message: '已定位到知识资产。' };
      if (event.type === 'start_cycle' || event.type === 'cancel_cycle' || event.type === 'retry_cycle') {
        const outcome = await emitResearchCycle(owner, event);
        if (outcome.ok) await refreshRef.current();
        return outcome;
      }
      // Research events go to the trusted host bridge; the receipt keeps the
      // host's state (queued ≠ saved) and the page re-reads after it.
      if (isBootstrapEvent(event.type)) {
        const outcome = await emitBootstrapEvent(owner, event);
        // Await the persisted re-read before the next click can use its revision.
        if (outcome.ok) await refreshRef.current();
        return outcome;
      }
      const reason = libraryActions[event.type] ?? '该动作在当前视图不可用。';
      return { ok: false, reason, message: reason };
    }} unavailableActions={libraryActions} />} />}</StudioWorkbench></div>
  </div>;
}
