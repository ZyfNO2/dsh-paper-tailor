/**
 * The v3 research panel: candidate rationale + model data flow, side by side.
 *
 * W3b. This is the ADAPTER that turns the two already-verified components into
 * part of the workbench, and it is deliberately thin:
 *
 *  - it owns the v3 snapshot / data-flow fetch and their cancellation;
 *  - it owns the poll controller lifecycle (mount, task switch, visibility);
 *  - it renders `DesignRationale` and `ModelDataFlow` and nothing else.
 *
 * All the judgement — which word, which reason, which status — lives in
 * `format.ts` and in the two components, where it is unit-tested. Putting it
 * here would make it testable only by mounting the whole workbench.
 *
 * The panel is ADDITIVE: it renders nothing until the host actually serves v3
 * for this task. A v2 task keeps the existing three workspaces exactly as they
 * were, so this cannot regress the page it is added to.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { evolverApi, WorkbenchApiError } from './api.ts';
import { DesignRationale } from './DesignRationale.tsx';
import { ModelDataFlow } from './ModelDataFlow.tsx';
import { WorkbenchPollController, type PollState } from './poll.ts';
import type { CandidateDesign, ModelDataFlow as Flow, WorkbenchSnapshotV3 } from '../wire.ts';
import { s } from './styles.ts';

export interface ResearchPanelProps {
  taskId: string;
  /** null when the current task is not a product task; the panel stays hidden. */
  isProductTask: boolean;
  onOpenModule?: (cardId: string) => void;
  onSelectCandidate?: (candidateKey: string) => void;
}

interface V3Region<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const EMPTY: V3Region<never> = { data: null, loading: false, error: null };

export function ResearchPanel(props: ResearchPanelProps): JSX.Element | null {
  const [snapshot, setSnapshot] = useState<V3Region<WorkbenchSnapshotV3>>(EMPTY);
  const [flow, setFlow] = useState<V3Region<Flow>>(EMPTY);
  const [poll, setPoll] = useState<PollState | null>(null);
  const [candidateKey, setCandidateKey] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const snapAbort = useRef<AbortController | null>(null);
  const flowAbort = useRef<AbortController | null>(null);
  const controllerRef = useRef<WorkbenchPollController | null>(null);

  const loadSnapshot = useCallback((taskId: string) => {
    snapAbort.current?.abort();
    const ac = new AbortController();
    snapAbort.current = ac;
    setSnapshot({ data: null, loading: true, error: null });
    evolverApi.workbenchV3(taskId, ac.signal)
      .then((snap) => {
        if (ac.signal.aborted) return;
        setSnapshot({ data: snap, loading: false, error: null });
        // Selecting the first candidate automatically would hide the fact that a
        // choice exists; only adopt one when the task has exactly one.
        setCandidateKey((current) => {
          if (current !== null && snap.candidateDesigns.some((d) => d.candidateKey === current)) return current;
          return snap.candidateDesigns.length === 1 ? snap.candidateDesigns[0].candidateKey : null;
        });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        const message = err instanceof WorkbenchApiError ? err.message : String(err);
        setSnapshot({ data: null, loading: false, error: message });
      });
  }, []);

  const loadFlow = useCallback((taskId: string, key: string) => {
    flowAbort.current?.abort();
    const ac = new AbortController();
    flowAbort.current = ac;
    setFlow({ data: null, loading: true, error: null });
    evolverApi
      .dataflowV3(taskId, key, null, ac.signal)
      .then((f) => {
        if (ac.signal.aborted) return;
        setFlow({ data: f, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        const message = err instanceof WorkbenchApiError ? err.message : String(err);
        setFlow({ data: null, loading: false, error: message });
      });
  }, []);

  // Load on mount and on task switch. The selection is NOT cleared here beyond
  // what the snapshot says, so a task that still contains the chosen candidate
  // keeps it — which is the SPEC's "返回保持选择".
  useEffect(() => {
    if (!props.isProductTask) {
      snapAbort.current?.abort();
      flowAbort.current?.abort();
      setSnapshot(EMPTY);
      setFlow(EMPTY);
      setCandidateKey(null);
      return;
    }
    loadSnapshot(props.taskId);
    return () => {
      snapAbort.current?.abort();
      flowAbort.current?.abort();
    };
  }, [props.taskId, props.isProductTask, loadSnapshot]);

  useEffect(() => {
    if (!props.isProductTask || candidateKey === null) return;
    loadFlow(props.taskId, candidateKey);
  }, [props.taskId, candidateKey, props.isProductTask, loadFlow]);

  // The poll controller. It is created once and re-scoped on task switch, which
  // is what aborts any in-flight check and drops its response.
  useEffect(() => {
    if (!props.isProductTask) return;
    const controller = new WorkbenchPollController({
      check: (since, sinceEpoch, signal) => evolverApi.changes(props.taskId, since, sinceEpoch, signal),
      apply: (regions) => {
        if (regions.includes('snapshot')) loadSnapshot(props.taskId);
        if (regions.includes('design') || regions.includes('bindings')) loadSnapshot(props.taskId);
        if (regions.includes('dataflow') && candidateKey !== null) loadFlow(props.taskId, candidateKey);
      },
      isVisible: () => (typeof document === 'undefined' ? true : !document.hidden),
      setTimer: (fn, ms) => {
        const id = setTimeout(fn, ms);
        return () => { clearTimeout(id); };
      },
      newAbortController: () => new AbortController(),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setPoll);
    controller.start({ immediate: true });

    const onVisibility = (): void => {
      if (typeof document === 'undefined') return;
      if (document.hidden) return;
      controller.setVisible();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      unsubscribe();
      controller.dispose();
      controllerRef.current = null;
    };
  }, [props.taskId, props.isProductTask, candidateKey, loadSnapshot, loadFlow]);

  // A task switch re-scopes the poller explicitly, so its in-flight request is
  // aborted rather than merely abandoned.
  const previousTask = useRef<string | null>(null);
  useEffect(() => {
    if (previousTask.current !== null && previousTask.current !== props.taskId) {
      controllerRef.current?.switchTask();
      setSelectedNodeId(null);
    }
    previousTask.current = props.taskId;
  }, [props.taskId]);

  const design: CandidateDesign | null = useMemo(() => {
    const all = snapshot.data?.candidateDesigns ?? [];
    if (candidateKey === null) return null;
    return all.find((d) => d.candidateKey === candidateKey) ?? null;
  }, [snapshot.data, candidateKey]);

  const candidates = snapshot.data?.candidateDesigns ?? [];
  const banner = poll === null ? null : WorkbenchPollController.staleBannerZh(poll);

  if (!props.isProductTask) return null;

  return (
    <section className={s.researchPanel} data-testid="research-panel">
      <div className={s.researchHead}>
        <h3 className={s.researchTitle}>拼接理由与模型数据流</h3>
        {candidates.length > 1 && (
          <label className={s.researchPicker}>
            候选
            <select
              className={s.select}
              value={candidateKey ?? ''}
              onChange={(e) => {
                const next = (e.target as HTMLSelectElement).value;
                setCandidateKey(next === '' ? null : next);
                setSelectedNodeId(null);
                props.onSelectCandidate?.(next);
              }}
            >
              <option value="">（请选择）</option>
              {candidates.map((d) => (
                <option key={d.candidateKey} value={d.candidateKey}>{d.binding.candidateId}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {banner !== null && (
        <p className={s.researchBanner} data-testid="research-poll-banner" role="status">{banner}</p>
      )}

      {snapshot.error !== null && (
        <p className={s.rationaleUnknown} data-testid="research-snapshot-error">
          读取 v3 快照失败：{snapshot.error}。本任务仍按 v2 视图显示。
        </p>
      )}

      <div className={s.researchColumns}>
        <DesignRationale
          design={design}
          candidateKey={candidateKey}
          {...(props.onOpenModule === undefined ? {} : { onOpenModule: props.onOpenModule })}
        />
        <ModelDataFlow
          flow={flow.data}
          {...(flow.error === null ? {} : { unresolvedZh: [`读取模型数据流失败：${flow.error}`] })}
          {...(props.onOpenModule === undefined ? {} : { onOpenModule: props.onOpenModule })}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
        />
      </div>
    </section>
  );
}