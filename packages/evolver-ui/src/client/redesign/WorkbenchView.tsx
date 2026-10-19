/**
 * WorkbenchView — shared action/context boundary for the Research Cockpit.
 *
 * SPEC §6.1: this component renders a WorkbenchSnapshot and emits events via
 * onEvent. It performs NO fetch, reads no files, touches no DSH context. The
 * demo container (demo/DemoWorkbench.tsx) owns fixtures, local mutations and
 * the scenario switcher.
 *
 * Contract, flow, inspector and matrix share one snapshot. Knowledge, brainstorm
 * and composition open as focused overlays; no parallel UI-owned research store.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ensureRedesignStyles } from './styles.ts';
import { Icon } from './icons.tsx';
import type {
  EventOutcome,
  ObjectLink,
  Region,
  RegionState,
  WorkbenchEvent,
  WorkbenchSnapshot,
  WorkbenchViewProps,
  WorkspaceId,
} from './view-model.ts';
import { ResearchCockpit } from './ResearchCockpit.tsx';
import { WorkTreeView } from './WorkTreeView.tsx';
import { PaperLibraryView } from './PaperLibraryView.tsx';
import { BrainstormPage } from './BrainstormPage.tsx';
import { TailorShopView } from './TailorShopView.tsx';
import { useBootstrapActions, type BootstrapActions } from './research-actions.ts';

// The tree tab is the experiment-orchestration surface: its default view is the
// 实验执行图 (actions, stages, next step), with the relation graph switchable.

export interface Toast {
  id: number;
  ok: boolean;
  text: string;
}

interface NavSignal {
  target: ObjectLink;
  nonce: number;
}

interface WorkbenchContextValue {
  snapshot: WorkbenchSnapshot;
  emit: (e: WorkbenchEvent) => Promise<{ ok: boolean; message: string; reason?: string } & Partial<EventOutcome>>;
  /** Cross-page navigation with a stable ObjectLink. */
  navigate: (target: ObjectLink) => void;
  navSignal: NavSignal | null;
  /** Bumped when local demo data changes so pages can re-derive lists. */
  snapshotVersion: number;
  unavailableActions: NonNullable<WorkbenchViewProps['unavailableActions']>;
  /** The retry entry point for a failed region, if the host supplied one. */
  retry: (() => void) | null;
  /**
   * Research-bootstrap actions with operationId/receipt semantics (FE-02 §6).
   * Shared by the brainstorm page and the tailor shop's slot navigator so both
   * reuse one operation per user intent.
   */
  research: BootstrapActions;
  /** Node the tailor shop is currently scoped to, set from the work tree. */
  activeNodeId: string | null;
  setActiveNodeId: (nodeId: string | null) => void;
  /** Switch tabs programmatically (e.g. the empty tree's 开始研究 entry). */
  goToTab: (tab: WorkspaceId) => void;
  workspace: WorkspaceId;
}

const WorkbenchContext = createContext<WorkbenchContextValue | null>(null);

export function useWorkbench(): WorkbenchContextValue {
  const ctx = useContext(WorkbenchContext);
  if (ctx === null) throw new Error('useWorkbench must be used inside WorkbenchView');
  return ctx;
}

function tabForKind(kind: ObjectLink['kind']): WorkspaceId {
  if (kind === 'component') return 'tailor';
  if (kind === 'paper' || kind === 'contribution' || kind === 'wiki') return 'papers';
  return 'tree';
}

export function WorkbenchView(props: WorkbenchViewProps): JSX.Element {
  ensureRedesignStyles();
  const [tab, setTab] = useState<WorkspaceId>(props.surface === 'papers' ? 'papers' : props.initialTab ?? 'tree');
  useEffect(() => { if (props.surface !== undefined) setTab(props.surface === 'papers' ? 'papers' : 'tree'); }, [props.surface]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [navSignal, setNavSignal] = useState<NavSignal | null>(null);
  const [snapshotVersion, setSnapshotVersion] = useState(0);
  const toastSeq = useRef(0);

  const pushToast = useCallback((ok: boolean, text: string): void => {
    toastSeq.current += 1;
    const id = toastSeq.current;
    setToasts((t) => [...t, { id, ok, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const emit = useCallback(
    async (e: WorkbenchEvent): Promise<{ ok: boolean; message: string; reason?: string } & Partial<EventOutcome>> => {
      if (props.onEvent === undefined) {
        const msg = '未安装操作处理器，未发送真实命令。';
        pushToast(false, msg);
        return { ok: false, message: msg, reason: msg, state: 'rejected' };
      }
      try {
        const out = await props.onEvent(e);
        // A queued/running receipt is not a success, so it is never toasted as
        // one: the page waits for the re-read before saying 已保存 (FE-R04).
        if (out.state === 'queued' || out.state === 'running') {
          pushToast(true, out.message);
        } else {
          pushToast(out.ok, out.message);
        }
        // Demo handlers mutate the snapshot in place; re-derive pages.
        setSnapshotVersion((v) => v + 1);
        return out;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        pushToast(false, `操作失败：${msg}`);
        return { ok: false, message: msg, reason: msg, state: 'rejected' };
      }
    },
    [props.onEvent, pushToast],
  );

  const navigate = useCallback(
    (target: ObjectLink): void => {
      setNavSignal({ target, nonce: Date.now() });
      setTab(tabForKind(target.kind));
      props.onEvent?.({ type: 'select', taskKey: props.snapshot.task.taskKey, target });
    },
    [props.onEvent, props.snapshot.task.taskKey],
  );

  // Bootstrap region identity drives the action bridge: the revision the page
  // rendered is the `baseRevision` every mutation carries (FE-02 §6).
  const bootstrapRevision = props.snapshot.bootstrap?.data?.revision ?? 0;
  const activeResearchId = props.snapshot.bootstrap?.data?.activeResearchId ?? null;
  const research = useBootstrapActions({ researchId: activeResearchId, baseRevision: bootstrapRevision, emit });
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const goToTab = useCallback((next: WorkspaceId): void => { setTab(next); }, []);
  const ctx = useMemo<WorkbenchContextValue>(
    () => ({ snapshot: props.snapshot, emit, navigate, navSignal, snapshotVersion,
      unavailableActions: props.unavailableActions ?? {}, retry: props.onRetry ?? null,
      research, activeNodeId, setActiveNodeId, goToTab, workspace: tab }),
    [props.snapshot, emit, navigate, navSignal, snapshotVersion, props.unavailableActions, props.onRetry,
      research, activeNodeId, goToTab, tab],
  );

  // The page fills the height the host ALLOCATED and reserves only the inset the
  // host DECLARED — no stacked magic paddings hoping to clear the composer
  // (FE-01 §4).
  const rootStyle: CSSProperties = { ['--rd-bottom-inset' as string]: `${props.bottomInset ?? 0}px` };
  if (props.availableHeight !== undefined && props.availableHeight !== null) {
    rootStyle.height = '100%';
    rootStyle.maxHeight = `${props.availableHeight}px`;
  }

  return (
    <WorkbenchContext.Provider value={ctx}>
      <div className="rd-root" role="application" aria-label="研究工作台（新版）" style={rootStyle}>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
          {tab === 'papers' ? <PaperLibraryView region={props.snapshot.papers} hidden={false} initialDetailTab={props.surface === 'papers' ? 'citations' : 'contrib'} />
            : tab === 'brainstorm' ? <BrainstormPage hidden={false} />
              : tab === 'tailor' ? <TailorShopView region={props.snapshot.tailor} hidden={false} />
                : props.surface === 'tree' ? <WorkTreeView region={props.snapshot.tree} hidden={false} /> : <ResearchCockpit />}
        </div>

        {props.demoBadge !== undefined && props.demoBadge !== null && (
          <div className="rd-demoBadge">
            <Icon name="experiment" size={13} />
            {props.demoBadge}
          </div>
        )}

        <div aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`rd-toast ${t.ok ? 'rd-toastOk' : 'rd-toastErr'}`}>{t.text}</div>
          ))}
        </div>
      </div>
    </WorkbenchContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// region state
// ---------------------------------------------------------------------------

export function RegionStateView(props: {
  state: RegionState;
  children: ReactNode;
  /** Extra entry point rendered inside the empty state (e.g. 开始研究). */
  emptyExtra?: ReactNode;
  /** Empty-state heading; defaults to 暂无内容. */
  emptyTitle?: string;
}): JSX.Element {
  const { status, reason } = props.state;
  const { retry } = useWorkbench();
  if (status === 'loading') {
    return (
      <div className="rd-state">
        <div className="rd-spinner" aria-label="加载中" />
        <div className="rd-stateTitle">加载中</div>
        <div>{reason ?? '正在读取数据…'}</div>
      </div>
    );
  }
  if (status === 'empty') {
    return (
      <div className="rd-state">
        <Icon name="doc" size={38} color="#6f7681" />
        <div className="rd-stateTitle">{props.emptyTitle ?? '暂无内容'}</div>
        <div style={{ maxWidth: 520 }}>{reason ?? '该区域当前没有数据。'}</div>
        {props.emptyExtra}
      </div>
    );
  }
  if (status === 'error') {
    return (
      <div className="rd-state">
        <Icon name="warning" size={38} color="#f06c6c" />
        <div className="rd-stateTitle">读取失败</div>
        <div className="rd-stateError">{reason ?? '未知读取错误。'}</div>
        {/* An empty list must never be used to hide a failure (FE-L07): any
            still-readable data stays on screen above the error. */}
        {props.children}
        {retry !== null && (
          <button className="rd-btn" onClick={retry}><Icon name="refresh" size={14} /> 重试</button>
        )}
      </div>
    );
  }
  if (status === 'blocked') {
    return (
      <div className="rd-state">
        <Icon name="blocked" size={38} color="#f0b94e" />
        <div className="rd-stateTitle">暂不可用</div>
        <div className="rd-stateError rd-stateBlocked">{reason ?? '该区域被前置条件阻塞。'}</div>
      </div>
    );
  }
  // ready / stale render children; stale gets a banner supplied by the caller.
  return <>{props.children}</>;
}

export function StaleBanner({ state }: { state: RegionState }): JSX.Element | null {
  if (state.status !== 'stale') return null;
  return (
    <div className="rd-staleBanner" role="status">
      <Icon name="warning" size={14} />
      {state.reason ?? '数据为历史版本。'}
    </div>
  );
}

export function regionReady<T>(region: Region<T>): region is Region<T> & { data: T } {
  return (region.state.status === 'ready' || region.state.status === 'stale') && region.data !== null;
}
