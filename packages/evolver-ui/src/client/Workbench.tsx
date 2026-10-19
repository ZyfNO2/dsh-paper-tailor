/**
 * 工作台主组件：页签内三个工作区（工作树 / 裁缝铺 / 论文管理）。
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md sections 8.1/8.4. Data comes only from
 * the host's read-only v2 projection; this component formats and navigates and
 * computes NO research conclusion.
 *
 * Redefects closed here (redesign plan R07/R10):
 *  R07  the default view is a NODE+EDGE graph with typed edges and layered
 *       layout — not an indented list. Per-seed tables, ids and logs live in the
 *       drawer, not on the first screen.
 *  R10  each region has its OWN loading/error state (a modules failure never
 *       blanks the tree); switching task/scope clears the previous region's data
 *       instead of showing it under the new task; in-flight requests are aborted
 *       and late responses are ignored via a monotonically increasing token;
 *       “实测/已测” comes from the host's association + check state, never from
 *       guessing a module's origin.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  GraphNode,
  ModuleCard,
  PaperCard,
  QualifiedTask,
  Selection,
  TaskSummary,
  WorkbenchSnapshot,
  WorkbenchStatus,
} from '../wire.ts';
import { WorkbenchApiError, evolverApi, setCapability } from './api.ts';
import { ensureStyles, s } from './styles.ts';
import {
  EDGE_STYLE,
  buildTaskMenu,
  executionLabel,
  formatImprovement,
  formatValue,
  graphDefects,
  layoutGraph,
  measurementLabel,
  rootsOf,
} from './format.ts';
import { WorkTree } from './WorkTree.tsx';
import { TailorShop } from './TailorShop.tsx';
import { PaperLibrary } from './PaperLibrary.tsx';
import { DetailDrawer } from './DetailDrawer.tsx';
import { ResearchPanel } from './ResearchPanel.tsx';

type Workspace = 'tree' | 'tailor' | 'papers';

/**
 * How often the task MENU is refreshed, so a task created in the chat becomes
 * reachable without a manual reload (SPEC §7.2).
 *
 * The research panel polls `changes` every 3s because it tracks a live task; the
 * menu only needs to notice a task that did not exist before, so it can move more
 * slowly. But "more slowly" has a floor, and it is set by the SPEC's own number:
 * §7.2 requires a publish to be VISIBLE within 5 seconds, and a refresh interval
 * of 5s cannot meet that — a publish landing just after a tick waits almost a full
 * interval. Measured on the wall clock, the check failed for exactly that reason.
 *
 * 3s matches the research panel and leaves the budget room for one skipped tick.
 */
const MENU_REFRESH_MS = 3_000;
/** After this many consecutive failures the menu stops refreshing. */
const MAX_MENU_FAILURES = 5;

const WORKSPACES: Array<{ id: Workspace; label: string }> = [
  { id: 'tree', label: '工作树' },
  { id: 'tailor', label: '裁缝铺' },
  { id: 'papers', label: '论文管理' },
];

/** One region's load state. `stale` means data belongs to a previous scope. */
interface Region<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Task the data belongs to; null until loaded. Used to blank on switch. */
  scopeKey: string | null;
  /**
   * Why this region is legitimately empty, when it is.
   *
   * Distinct from `error`: a product task having no experiment tree is a FACT
   * about that kind of task, not a failure. Reporting it through `error` would
   * put a red box on a page that is working exactly as intended.
   */
  emptyReason?: string;
}

function emptyRegion<T>(scopeKey: string | null): Region<T> {
  return { data: null, loading: false, error: null, scopeKey };
}

/**
 * Increments on every scope change; a response carrying an older token is
 * dropped. This is the client half of SPEC 8.4's "旧快照不能覆盖新值".
 */
/**
 * A monotonically increasing scope token, exposed through a STABLE ref.
 *
 * The stability is load-bearing, not cosmetic. An earlier version returned a
 * fresh `{current, next}` object literal on every render; every `useCallback`
 * that listed it as a dependency was therefore invalidated on every render, and
 * the effect that loads the task re-ran forever. Returning the ref itself keeps
 * the identity constant while `current` still tracks the latest value.
 */
function useScopeToken(): { readonly current: number; next: () => number } {
  const ref = useRef(0);
  const stable = useMemo(() => ({
    get current(): number { return ref.current; },
    next: (): number => { ref.current += 1; return ref.current; },
  }), []);
  return stable;
}

/**
 * Props the host hands a `conversation.view` occupant.
 *
 * `sessionId` is supplied by the `session` slot scope
 * (`dsh-client-ui-session` binds `props: { sessionId }`), which is what lets the
 * page ask for a read capability on its own session instead of guessing one.
 * It is optional in the type only because a plugin mounted outside a session
 * scope must not crash the host — the page treats its absence as "no grant
 * possible" and says so.
 */
export interface WorkbenchSlotProps {
  sessionId?: string;
  viewRequest?: unknown;
  openView?: (view: unknown, focus?: boolean) => void;
  completeViewRequest?: (id?: string) => void;
}

export function Workbench(props: WorkbenchSlotProps): JSX.Element {
  ensureStyles();
  const sessionId = props.sessionId ?? null;
  const [status, setStatus] = useState<WorkbenchStatus | null>(null);
  const [grant, setGrant] = useState<{ sessionId: string; tasks: string[]; tier: 'owned' | 'workspace' | 'none' } | null>(null);
  const [grantError, setGrantError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  /**
   * The v3 qualified list: experiment tasks AND product tasks, each naming its
   * store. Kept separately from `tasks` because the two routes carry different
   * shapes, and merging them into one array would force a lossy common type —
   * `TaskSummary` has counts and a revision, `QualifiedTask` has a store and a
   * revision kind, and neither is a superset of the other.
   */
  const [qualifiedTasks, setQualifiedTasks] = useState<QualifiedTask[]>([]);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Region<WorkbenchSnapshot>>(emptyRegion(null));
  const [modules, setModules] = useState<Region<ModuleCard[]>>(emptyRegion(null));
  const [papers, setPapers] = useState<Region<PaperCard[]>>(emptyRegion(null));
  const [workspace, setWorkspace] = useState<Workspace>('tree');
  const [selection, setSelection] = useState<Selection>(null);
  const [moduleQuery, setModuleQuery] = useState('');
  const [paperQuery, setPaperQuery] = useState('');

  const taskToken = useScopeToken();
  const moduleToken = useScopeToken();
  const paperToken = useScopeToken();
  const taskAbort = useRef<AbortController | null>(null);
  const paperAbort = useRef<AbortController | null>(null);
  /**
   * The latest qualified list, readable from `loadTask` without making it a
   * dependency. `loadTask` must NOT be re-created when the task list refreshes:
   * it is called from an effect keyed on the selected task, and a new identity
   * would re-run that effect and re-fetch the tree on every poll.
   */
  const qualifiedTasksRef = useRef<QualifiedTask[]>([]);

  const loadStatus = useCallback((signal: AbortSignal) => {
    evolverApi.status(signal)
      .then(setStatus)
      .catch(() => { /* status is advisory; its absence must not blank the page */ });
  }, []);

  /**
   * Acquire the read capability for THIS session before anything is fetched.
   *
   * Order matters: the grant is requested first so the very first task list
   * already carries it, and a refused grant is shown as a state rather than
   * being retried silently into a blank page. The capability lives in memory
   * only, so unmounting or switching session drops it.
   */
  useEffect(() => {
    if (sessionId === null) {
      setGrant(null);
      setGrantError('当前不在会话范围内：宿主未提供 sessionId，无法申请读取授权。');
      return;
    }
    const ac = new AbortController();
    setGrantError(null);
    evolverApi.requestGrant(sessionId, ac.signal)
      .then((r) => {
        if (ac.signal.aborted) return;
        setCapability(r.capability);
        setGrant({ sessionId: r.sessionId, tasks: r.tasks, tier: r.tier });
        // A workspace-tier grant is legitimate here (one researcher, one repo)
        // but it is NOT per-user isolation, so it is stated rather than implied.
        setGrantError(r.tier === 'none' ? (r.note ?? '本工作区没有已发布任务。') : null);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setCapability(null);
        setGrant(null);
        const message = err instanceof WorkbenchApiError ? err.message : String(err);
        setGrantError(`读取授权未通过：${message}`);
      });
    return () => { ac.abort(); setCapability(null); };
  }, [sessionId]);

  /**
   * Load the task menu: v2 experiment tasks plus v3 product tasks.
   *
   * SPEC §7.1 says `/tasks?schemaVersion=3` returns "原合法历史任务 + product
   * tasks", and §7.2 requires the menu to locate the task this session just
   * created. The v2 route lists only experiment tasks, so a product task created
   * by a chat turn was unreachable from the UI: it never appeared in the menu,
   * `taskId` never became a `wb-…` id, `isProductTask` stayed false, and the whole
   * v3 panel — the rationale and the model data flow — could not be opened by any
   * user action. Every offline suite passed throughout, because each of them
   * drives the routes directly rather than through the menu.
   *
   * v3 is fetched alongside v2 rather than replacing it: a host that does not serve
   * v3 (or a session without the new config) must keep the three original
   * workspaces working, which is what the additive design promises.
   *
   * `adoptFirst` is true only for the initial load. On a refresh the user's choice
   * must not be overwritten — SPEC §7.2's "不清空已有选择" applies to the menu too,
   * and re-picking the first task on every poll would fight the user.
   */
  const loadMenu = useCallback((signal: AbortSignal, adoptFirst: boolean): Promise<{ ok: boolean }> => {
    let ok = false;
    const v2 = evolverApi.tasks(50, null, signal)
      .then((r) => {
        if (signal.aborted) return;
        ok = true;
        setTasks(r.tasks);
        // The host already sorts the Phase 3 surface first; the default is the
        // first task it offers, NOT a historical Phase 2 diagnostic (R02).
        if (adoptFirst) setTaskId((current) => current ?? r.tasks[0]?.taskId ?? null);
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        // A REFRESH failure keeps the menu it already has: blanking a working
        // menu because one poll failed is worse than showing a slightly old list.
        if (!adoptFirst) return;
        const message = err instanceof WorkbenchApiError ? err.message : String(err);
        setTasks([]);
        setSnapshot({ data: null, loading: false, error: `任务列表读取失败：${message}`, scopeKey: null });
      });

    const v3 = evolverApi.tasksV3(200, null, signal)
      .then((r) => {
        if (signal.aborted) return;
        qualifiedTasksRef.current = r.tasks;
        setQualifiedTasks(r.tasks);
      })
      .catch(() => {
        // v3 is OPTIONAL from the menu's point of view: its absence means this
        // host has no product-task surface, and the v2 menu is then the whole
        // menu. Reporting it as an error would blame the user for a build choice.
        // A refresh that fails also keeps the last good list, for the same reason
        // as above.
        if (signal.aborted || !adoptFirst) return;
        qualifiedTasksRef.current = [];
        setQualifiedTasks([]);
      });

    // Resolves when BOTH have settled, and reports whether the menu could be read
    // at all. The flag exists because the two catches above deliberately swallow
    // their errors (a menu that cannot refresh must not blank itself), so the
    // caller would otherwise have no way to count failures and the refresh loop
    // would retry a dead host forever.
    return Promise.all([v2, v3]).then(() => ({ ok }));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    loadStatus(ac.signal);
    loadMenu(ac.signal, true);
    return () => ac.abort();
  }, [loadStatus, loadMenu]);

  /**
   * Refresh the menu periodically so a task created in the CHAT becomes reachable
   * without a manual page reload (SPEC §7.2).
   *
   * Same discipline as the research panel's poller, and for the same reasons:
   *   - NO OVERLAP: the next tick is scheduled only after the current fetch
   *     settles, so a slow response cannot be overtaken by a fast one;
   *   - PAUSE WHEN HIDDEN, and check immediately on becoming visible;
   *   - STOP after the failure budget, so a host that is gone does not produce
   *     requests forever;
   *   - it never touches the SELECTED task or any loaded region. It only refreshes
   *     the list of what can be chosen.
   */
  useEffect(() => {
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ac = new AbortController();

    const schedule = (ms: number): void => {
      if (stopped) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(run, ms);
    };

    const run = (): void => {
      if (stopped) return;
      if (typeof document !== 'undefined' && document.hidden) {
        // Hidden: do not spend a request, and do not charge the failure budget.
        schedule(MENU_REFRESH_MS);
        return;
      }
      // ONE fetch per tick: `loadMenu` resolves when both routes have settled, so
      // scheduling from its completion is what prevents overlap. Calling the API
      // separately here would double every request.
      loadMenu(ac.signal, false)
        .then((r) => { failures = r.ok ? 0 : failures + 1; })
        .catch(() => { failures += 1; })
        .finally(() => {
          if (stopped) return;
          // Back off once failures accumulate, then stop entirely: a host that is
          // gone should not be polled forever.
          if (failures === 0) schedule(MENU_REFRESH_MS);
          else if (failures < MAX_MENU_FAILURES) schedule(MENU_REFRESH_MS * (failures + 1));
          else console.warn(`[workbench] 任务菜单刷新已停止：连续 ${failures} 次失败`);
        });
    };

    schedule(MENU_REFRESH_MS);
    const onVisibility = (): void => {
      if (typeof document === 'undefined' || document.hidden) return;
      failures = 0;
      schedule(0);
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      ac.abort();
      if (timer !== null) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  /**
   * Load the tree for a task, cancelling anything in flight.
   *
   * Deliberately NOT a dependency of the "load when taskId changes" effect:
   * depending on the module query here would re-fetch the whole tree every time
   * the user typed in 裁缝铺's search box. The tree and the module catalog are
   * different regions with different triggers; `reloadModules` handles the
   * catalog on its own.
   */
  const loadTask = useCallback((nextTaskId: string) => {
    taskAbort.current?.abort();
    const ac = new AbortController();
    taskAbort.current = ac;
    const token = taskToken.next();

    // R10: switching scope clears the old region's content immediately, so a
    // stale tree is never displayed under the newly selected task.
    setSnapshot(emptyRegion(nextTaskId));
    setModules(emptyRegion(nextTaskId));
    setSnapshot({ data: null, loading: true, error: null, scopeKey: nextTaskId });
    setModules({ data: null, loading: true, error: null, scopeKey: nextTaskId });
    setSelection(null);

    // A PRODUCT task has no v2 experiment tree, and asking for one 404s with
    // "research-execution: no task directory for wb-…". Showing that raw store
    // error under a task the menu itself offered reads as a broken page, when the
    // truth is that this task's surface is the v3 panel, not the v2 tree.
    //
    // The host already told us the store, so the client does not have to guess:
    // it skips the request and says what the task's surface actually is.
    const qualified = qualifiedTasksRef.current.find((t) => t.taskId === nextTaskId);
    if (qualified !== undefined && qualified.store === 'workbench') {
      setSnapshot({
        data: null,
        loading: false,
        error: null,
        scopeKey: nextTaskId,
        emptyReason: '这是研究设计任务：它没有 Phase 2/3 实验树。它的内容在下方「拼接理由与模型数据流」中。',
      });
      setModules({ data: null, loading: false, error: null, scopeKey: nextTaskId });
      return;
    }

    evolverApi.workbench(nextTaskId, ac.signal)
      .then((snap) => {
        if (ac.signal.aborted || token !== taskToken.current) return;
        setSnapshot({ data: snap, loading: false, error: null, scopeKey: nextTaskId });
        // Revalidate the task label/revision from the authoritative snapshot.
        setTasks((prev) => prev.map((t) => (t.taskId === nextTaskId
          ? {
            ...t,
            displayName: snap.displayName,
            revision: snap.revision >= 0 ? snap.revision : t.revision,
            ownerSessionId: t.ownerSessionId,
            readError: null,
          }
          : t)));
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted || token !== taskToken.current) return;
        const message = err instanceof WorkbenchApiError ? err.message : String(err);
        const code = err instanceof WorkbenchApiError ? err.code : 'UNKNOWN';
        setSnapshot({ data: null, loading: false, error: `${code}：${message}`, scopeKey: nextTaskId });
      });
  }, [taskToken]);

  /**
   * Load ONLY the module catalog. Its own controller, so the 裁缝铺 search box
   * re-queries the catalog without touching the tree — and a catalog failure
   * stays in the catalog's own error slot.
   */
  const loadModules = useCallback((nextTaskId: string, query: string) => {
    const ac = new AbortController();
    const token = moduleToken.next();
    setModules({ data: null, loading: true, error: null, scopeKey: nextTaskId });
    evolverApi.modules(nextTaskId, query, ac.signal)
      .then((r) => {
        if (ac.signal.aborted || token !== moduleToken.current) return;
        setModules({ data: r.modules, loading: false, error: null, scopeKey: nextTaskId });
      })
      .catch((err: unknown) => {
        // R10: a module failure is its own state and never blanks the tree.
        if (ac.signal.aborted || token !== moduleToken.current) return;
        const message = err instanceof WorkbenchApiError ? err.message : String(err);
        setModules({ data: null, loading: false, error: `模块目录读取失败：${message}`, scopeKey: nextTaskId });
      });
    return () => ac.abort();
  }, [moduleToken]);

  useEffect(() => {
    if (taskId === null) return;
    loadTask(taskId);
    return loadModules(taskId, moduleQuery);
  }, [taskId, moduleQuery, loadTask, loadModules]);

  /** Papers are loaded on demand and re-scoped whenever the task changes. */
  useEffect(() => {
    paperAbort.current?.abort();
    const ac = new AbortController();
    paperAbort.current = ac;
    const token = paperToken.next();
    setPapers(emptyRegion(taskId));
    return () => ac.abort();
  }, [taskId, paperToken]);

  const loadPapers = useCallback(() => {
    paperAbort.current?.abort();
    const ac = new AbortController();
    paperAbort.current = ac;
    const token = paperToken.next();
    setPapers({ data: null, loading: true, error: null, scopeKey: taskId });
    evolverApi.papers(paperQuery, ac.signal)
      .then((r) => {
        if (ac.signal.aborted || token !== paperToken.current) return;
        setPapers({ data: r.papers, loading: false, error: null, scopeKey: taskId });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted || token !== paperToken.current) return;
        const message = err instanceof WorkbenchApiError ? err.message : String(err);
        setPapers({ data: null, loading: false, error: `论文列表读取失败：${message}`, scopeKey: taskId });
      });
  }, [paperQuery, paperToken, taskId]);

  // Re-query when the search text changes, but only once a load has happened.
  const [papersRequested, setPapersRequested] = useState(false);
  useEffect(() => {
    if (workspace === 'papers' && !papersRequested && taskId !== null) {
      setPapersRequested(true);
      loadPapers();
    }
  }, [workspace, papersRequested, taskId, loadPapers]);

  const handlePaperQuery = (value: string): void => {
    setPaperQuery(value);
    loadPapers();
  };

  const onSelect = useCallback((next: Selection): void => {
    setSelection((current) => (
      current !== null && next !== null && current.kind === next.kind && (current.kind === 'paper' && next.kind === 'paper' ? current.paperId === next.paperId : current.kind !== 'paper' && next.kind !== 'paper' && current.id === next.id)
        ? null
        : next
    ));
  }, []);

  // Cross-workspace navigation: the same scope and selection survive a switch
  // (SPEC 8.1), and picking a node from 裁缝铺 lands on 工作树.
  const goToNode = useCallback((nodeId: string): void => {
    setWorkspace('tree');
    setSelection({ kind: 'node', id: nodeId });
  }, []);

  const goToPaper = useCallback((paperId: string): void => {
    setWorkspace('papers');
    setSelection({ kind: 'paper', paperId });
    if (papers.data === null) loadPapers();
  }, [loadPapers, papers.data]);

  const goToModule = useCallback((moduleId: string): void => {
    setWorkspace('tailor');
    setSelection({ kind: 'module', id: moduleId });
  }, []);

  const selectedNode: GraphNode | null = useMemo(() => {
    if (selection?.kind !== 'node') return null;
    return snapshot.data?.nodes.find((n) => n.id === selection.id) ?? null;
  }, [selection, snapshot.data]);

  const selectedModule: ModuleCard | null = useMemo(() => {
    if (selection?.kind !== 'module') return null;
    return modules.data?.find((m) => m.id === selection.id) ?? null;
  }, [selection, modules.data]);

  const selectedPaper: PaperCard | null = useMemo(() => {
    if (selection?.kind !== 'paper') return null;
    return papers.data?.find((p) => p.paperId === selection.paperId) ?? null;
  }, [selection, papers.data]);

  const defects = useMemo(
    () => (snapshot.data === null ? [] : graphDefects(snapshot.data.nodes, snapshot.data.edges)),
    [snapshot.data],
  );

  const scope = `${taskId ?? 'none'}`;

  /**
   * The task menu: v2 experiment tasks plus the v3 product tasks, labelled by
   * their QUALIFIED identity. The merge rule lives in `format.ts` so it can be
   * asserted without mounting this component — see `buildTaskMenu`.
   */
  const menuOptions = useMemo(
    () => buildTaskMenu(tasks, qualifiedTasks),
    [tasks, qualifiedTasks],
  );

  return (
    <div className={s.page}>
      {/* Human-readable header only: protocol ids, owners and hashes belong in
          the drawer (plan §3.1), not across the top of the first screen. */}
      <div className={s.topRow}>
        <label className={s.meta} htmlFor="evolver-task-select">任务</label>
        <select
          id="evolver-task-select"
          className={s.select}
          value={taskId ?? ''}
          onChange={(e) => { setTaskId(e.target.value === '' ? null : e.target.value); }}
        >
          {menuOptions.length === 0 && <option value="">（无可用任务）</option>}
          {menuOptions.map((o) => (
            <option key={o.taskId} value={o.taskId}>{o.label}</option>
          ))}
        </select>
        {snapshot.data !== null && (
          <span className={s.meta}>
            {snapshot.data.source.phase === 'phase3' ? '真实实验矩阵' : 'Phase2 轻量验证'}
            {snapshot.data.dataSummary === null ? '' : ` · 数据 ${snapshot.data.dataSummary}`}
            {snapshot.data.budgetSummary === null ? '' : ` · 预算 ${snapshot.data.budgetSummary}`}
          </span>
        )}
        {grant !== null && grant.tier !== 'none' && (
          <span className={s.dim} title={grant.tier === 'owned'
            ? '本会话创建了这些任务，授权范围即其自有任务'
            : '本会话未创建任何任务；宿主按工作区范围授权（单研究者本地工具，不是按用户隔离）'}>
            授权：{grant.tasks.length} 个任务
            {grant.tier === 'owned' ? '（本会话自有）' : '（工作区范围）'}
          </span>
        )}
        {status !== null && (
          <span className={s.dim} title={status.access.note}>
            策略：{status.access.authorization === 'grant-required' ? '需授权' : '未强制'}
            {status.access.callerIdentityDerivedFromRequest ? '' : '（宿主不提供可派生身份，由页面按会话申请）'}
          </span>
        )}
      </div>

      {grantError !== null && (
        <div className={s.errorBox} role="alert">
          {grantError}
          <div className={s.dim}>
            页面不会在没有授权的情况下显示任何任务数据；这不等于“没有数据”。
          </div>
        </div>
      )}

      {tasks.some((t) => t.readError !== null) && (
        <div className={s.issues} role="status">
          <div>⚠ 部分任务元数据读取失败（不按 0/unknown 填充）：</div>
          {tasks.filter((t) => t.readError !== null).map((t) => (
            <div key={t.taskId} className={s.dim}>{t.taskId}：{t.readError}</div>
          ))}
        </div>
      )}

      <div className={s.navRow} role="tablist">
        {WORKSPACES.map((w) => (
          <button
            key={w.id}
            type="button"
            role="tab"
            aria-selected={workspace === w.id}
            className={workspace === w.id ? `${s.navTab} ${s.navTabActive}` : s.navTab}
            onClick={() => setWorkspace(w.id)}
          >
            {w.label}
            {w.id === 'tailor' && modules.error !== null ? ' ⚠' : ''}
            {w.id === 'papers' && papers.error !== null ? ' ⚠' : ''}
          </button>
        ))}
      </div>

      {snapshot.error !== null && (
        <div className={s.errorBox} role="alert">
          工作树读取失败：{snapshot.error}
        </div>
      )}

      {snapshot.data !== null && snapshot.data.issues.length > 0 && (
        <details className={s.issues}>
          <summary>数据前置说明（{snapshot.data.issues.length}）</summary>
          {snapshot.data.issues.map((issue, i) => (
            <div key={i} className={issue.severity === 'error' ? s.opError : s.dim}>
              {issue.severity === 'error' ? '⛔' : '⚠'} {issue.message}
            </div>
          ))}
        </details>
      )}

      {defects.length > 0 && (
        <div className={s.errorBox} role="alert">
          图结构问题（不按猜测绘制）：{defects.join('；')}
        </div>
      )}

      {/* The v3 panel is ADDITIVE and conditional: it renders nothing for a task
          the host does not serve v3 for, so the three existing workspaces keep
          behaving exactly as before. */}
      <ResearchPanel
        taskId={scope}
        // The HOST's declared store decides this, not the id's shape. Guessing
        // from a `wb-` prefix would make the panel appear for any id that merely
        // looked like a product task, and disappear for a product task whose id
        // happened to differ — the kind of naming convention SPEC §7.1 exists to
        // replace with a declared identity. When v3 is unavailable the list is
        // empty and this is false, which is the correct conservative answer.
        isProductTask={qualifiedTasks.some((t) => t.taskId === scope && t.store === 'workbench')}
        onOpenModule={goToModule}
      />

      <div className={s.body}>
        <div className={s.main}>
          {workspace === 'tree' && (
            <WorkTree
              region={snapshot}
              selection={selection?.kind === 'node' ? selection.id : null}
              onSelect={(id) => onSelect({ kind: 'node', id })}
              onOpenPaper={goToPaper}
              onOpenModule={goToModule}
              onOpenNode={goToNode}
            />
          )}

          {workspace === 'tailor' && (
            <TailorShop
              region={modules}
              query={moduleQuery}
              onQuery={(value) => { setModuleQuery(value); }}
              selection={selection?.kind === 'module' ? selection.id : null}
              onSelect={(id) => onSelect({ kind: 'module', id })}
              onOpenNode={goToNode}
              onOpenPaper={goToPaper}
            />
          )}

          {workspace === 'papers' && (
            <PaperLibrary
              region={papers}
              query={paperQuery}
              onQuery={handlePaperQuery}
              selection={selection?.kind === 'paper' ? selection.paperId : null}
              onSelect={(paperId) => onSelect({ kind: 'paper', paperId })}
              onOpenModule={goToModule}
              onOpenNode={goToNode}
            />
          )}
        </div>

        <DetailDrawer
          regionKey={scope}
          node={selectedNode}
          module={selectedModule}
          paper={selectedPaper}
          snapshot={snapshot.data}
          modules={modules.data ?? []}
          onClose={() => setSelection(null)}
          onOpenNode={goToNode}
          onOpenPaper={goToPaper}
          onOpenModule={goToModule}
        />
      </div>
    </div>
  );
}

/** Re-exported so the sub-workspaces share one formatting surface. */
export { executionLabel, measurementLabel, formatValue, formatImprovement, layoutGraph, rootsOf, EDGE_STYLE };