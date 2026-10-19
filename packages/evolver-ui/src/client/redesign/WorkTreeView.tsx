/**
 * Work tree page (reference F1): research narrative summary, A/B main chain
 * with converged provenance, planned C branch (dashed), pan/zoom canvas, node
 * inspector and the collapsed activity record.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from './icons.tsx';
import {
  RegionStateView,
  StaleBanner,
  regionReady,
  useWorkbench,
} from './WorkbenchView.tsx';
import { DetailSection, EmptyInspectorPlaceholder, InspectorShell, KV } from './Inspector.tsx';
import { MermaidGraph } from './MermaidGraph.tsx';
import { Chip, LinkList, ObjectLinkButton, ReasonPromptModal } from './controls.tsx';
import { NODE_META, NODE_STATUS_META, PLANNING_STATUS_META } from './view-utils.ts';
import { buildExecutionGraph, type ExecutionExtras } from './execution-graph.ts';
import { ExecutionFlow, NextStepCard } from './ExecutionFlow.tsx';
import type {
  ActivityEntry,
  ObjectLink,
  Region,
  ResearchIdeaView,
  ResearchNodeView,
  TreeData,
} from './view-model.ts';

interface Transform { x: number; y: number; k: number }

export function WorkTreeView(props: { region: Region<TreeData>; hidden: boolean }): JSX.Element {
  const { snapshot, navSignal, emit, setActiveNodeId, goToTab } = useWorkbench();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  // Review round 2026-10-11: the page defaults to the 「实验执行图」 (actions,
  // stages, next step); the original Mermaid relation graph stays available as a
  // switchable view — same filtered node set, same inspector, different projection.
  const [viewMode, setViewMode] = useState<'execution' | 'relation'>('execution');
  const [tr, setTr] = useState<Transform>({ x: 0, y: 0, k: 1 });
  const [branchModal, setBranchModal] = useState<{ node: ResearchNodeView; decision: 'retain' | 'expand' | 'prune' } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number; id: number; panStarted: boolean } | null>(null);
  const [panning, setPanning] = useState(false);
  // BR-FE3: narrow screens switch the flowchart to top-down; theme follows the OS setting
  // (the DSH shell sets the color scheme on the document; matchMedia is the same signal).
  const [narrowView, setNarrowView] = useState(false);
  const [darkTheme, setDarkTheme] = useState(false);
  useEffect(() => {
    const el = viewportRef.current;
    // The pan/zoom viewport only exists in the relation view; re-attach when the
    // view mounts so the narrow-screen direction check still runs.
    if (el === null) return;
    const observer = new ResizeObserver(() => setNarrowView(el.clientWidth < 640));
    observer.observe(el);
    setNarrowView(el.clientWidth < 640);
    return () => observer.disconnect();
  }, [viewMode]);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = (): void => setDarkTheme(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const data = regionReady(props.region) ? props.region.data : null;

  const linkToNode = useCallback(
    (target: ObjectLink): string | null => {
      if (data === null) return null;
      if (target.kind === 'node') return data.nodes.some((n) => n.id === target.key) ? target.key : null;
      const hit = data.nodes.find((n) => n.links.some((l) => l.kind === target.kind && l.key === target.key));
      return hit?.id ?? null;
    },
    [data],
  );

  // Selecting a node also scopes the tailor shop to that node's slots
  // (FE-02 §5). The scope is cleared with the selection, so the tailor shop
  // never shows another node's slots as if they were current.
  const selectNode = useCallback((id: string | null): void => {
    setSelectedId(id);
    setActiveNodeId(id);
  }, [setActiveNodeId]);

  /**
   * Why a cross-page jump could not be honoured.
   *
   * A link whose target node no longer exists is reported, and the view does
   * NOT silently jump to a different node that happens to share a name
   * (FE-02 §5).
   */
  const [navMiss, setNavMiss] = useState<string | null>(null);

  // Cross-page navigation: select the node owning the target object.
  useEffect(() => {
    if (navSignal === null || data === null || props.hidden) return;
    if (!['node', 'experiment'].includes(navSignal.target.kind)) return;
    const id = linkToNode(navSignal.target);
    if (id === null) {
      setNavMiss(`目标对象“${navSignal.target.label}”不在当前研究图中（可能已被更新或属于其他研究），未跳转到同名节点。`);
      return;
    }
    setNavMiss(null);
    selectNode(id);
  }, [navSignal, data, linkToNode, props.hidden, selectNode]);

  const hiddenIds = useMemo(() => {
    if (data === null || showAll) return new Set<string>();
    // The fixture decides what the main-chain view collapses (e.g. pruned
    // branches). The planned C branch stays visible-but-dashed, matching F1.
    return new Set(data.defaultHiddenNodeIds);
  }, [data, showAll]);

  // BR-FE3: STABLE arrays for the renderer. Inline `.filter()`s mint a new array every
  // render, and MermaidGraph's render effect keys on them — a fresh array each poll would
  // cancel the in-flight mermaid render forever (the page stuck on "图生成中…" forever).
  const visibleNodes = useMemo(
    () => (data === null ? [] : data.nodes.filter((n) => !hiddenIds.has(n.id))),
    [data, hiddenIds],
  );
  const visibleEdges = useMemo(
    () => (data === null ? [] : data.edges.filter((e) => !hiddenIds.has(e.sourceId) && !hiddenIds.has(e.targetId))),
    [data, hiddenIds],
  );

  // Execution-view extras: selected brainstorm ideas (bootstrap planning graphs) and
  // linked experiment records (full trees). Both come from the SAME snapshot the page
  // already renders — no extra fetch, and absent regions simply yield empty maps,
  // which the derivation renders as 待补充 instead of guessing.
  const executionExtras = useMemo<ExecutionExtras>(() => {
    const ideaById = new Map<string, ResearchIdeaView>();
    const bootstrap = snapshot.bootstrap?.data;
    if (bootstrap !== undefined && bootstrap !== null) {
      const active = bootstrap.researches.find((r) => r.researchId === bootstrap.activeResearchId) ?? bootstrap.researches[0];
      for (const idea of active?.ideas ?? []) ideaById.set(idea.ideaId, idea);
    }
    const experimentByKey = new Map((snapshot.papers.data?.experiments ?? []).map((e) => [e.experimentKey, e] as const));
    return { ideaById, experimentByKey };
  }, [snapshot.bootstrap?.data, snapshot.papers.data]);

  // The execution model is derived from ALL nodes: pruned schemes stay visible here
  // on purpose (淘汰 + 依据 is a result, not clutter); the 主链/全部分支 toggle
  // applies to the relation view only.
  const executionModel = useMemo(
    () => (data === null ? null : buildExecutionGraph(data, executionExtras)),
    [data, executionExtras],
  );

  const selected = useMemo(
    () => (selectedId !== null && data !== null ? data.nodes.find((n) => n.id === selectedId) ?? null : null),
    [selectedId, data],
  );

  // BR-FE3: Mermaid auto-fits its own layout — the transform starts at identity and the
  // user pans/zooms from there (stored x/y no longer position anything).

  const zoomBy = useCallback((delta: number): void => {
    setTr((t) => {
      const k = Math.min(1.8, Math.max(0.45, t.k + delta));
      const el = viewportRef.current;
      if (el === null) return { ...t, k };
      // zoom around viewport center
      const cx = el.clientWidth / 2;
      const cy = el.clientHeight / 2;
      return { k, x: cx - ((cx - t.x) / t.k) * k, y: cy - ((cy - t.y) / t.k) * k };
    });
  }, []);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>): void {
    if (e.button !== 0) return;
    // IMPORTANT: do NOT capture the pointer here. Immediate capture retargets
    // the click to the viewport and makes node/zoom-button clicks dead. We
    // only begin a pan (and capture) once the pointer moves beyond a
    // threshold, so plain clicks still reach their target.
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: tr.x, oy: tr.y, id: e.pointerId, panStarted: false };
  }
  function onPointerMove(e: React.PointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    if (d === null) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.panStarted && Math.hypot(dx, dy) < 4) return;
    if (!d.panStarted) {
      d.panStarted = true;
      setPanning(true);
      try { e.currentTarget.setPointerCapture(d.id); } catch { /* ignore */ }
    }
    setTr((t) => ({ ...t, x: d.ox + dx, y: d.oy + dy }));
  }
  function onPointerUp(e: React.PointerEvent<HTMLDivElement>): void {
    const d = dragRef.current;
    dragRef.current = null;
    if (d !== null && d.panStarted) {
      try { e.currentTarget.releasePointerCapture(d.id); } catch { /* ignore */ }
    }
    setPanning(false);
  }
  function onWheel(e: React.WheelEvent<HTMLDivElement>): void {
    const el = viewportRef.current;
    if (el === null) return;
    const rect = el.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    setTr((t) => {
      const k = Math.min(1.8, Math.max(0.45, t.k * (e.deltaY < 0 ? 1.12 : 0.89)));
      return { k, x: px - ((px - t.x) / t.k) * k, y: py - ((py - t.y) / t.k) * k };
    });
  }

  // The empty tree offers the same entry point as the brainstorm tab
  // (FE-02 §2): not a hidden error, and not a fabricated tree.
  const emptyEntry = (
    <button className="rd-btn rd-btn-primary" onClick={() => goToTab('brainstorm')}>
      <Icon name="bulb" size={14} />
      {snapshot.bootstrap?.data?.activeResearchId ? '选择方向并初始化研究图' : '开始研究（先确定研究意图）'}
    </button>
  );

  return (
    <RegionStateView state={props.region.state} emptyExtra={emptyEntry} emptyTitle={snapshot.bootstrap?.data?.activeResearchId ? '研究树尚未初始化' : '开始研究'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <StaleBanner state={props.region.state} />
        {/* A cross-page jump that could not be honoured says so, instead of
            silently landing on a same-named node (FE-02 §5). */}
        {navMiss !== null && (
          <div className="rd-staleBanner" role="status">
            <Icon name="warning" size={14} />
            {navMiss}
            <button className="rd-linkBtn" onClick={() => setNavMiss(null)}>知道了</button>
          </div>
        )}
        {data !== null && (
          <>
            <SummaryCard data={data} />
            <div className="rd-treeBody">
              <div className="rd-panel rd-graphCard">
                <div className="rd-graphToolbar">
                  <div className="rd-seg" role="group" aria-label="视图切换">
                    <button aria-pressed={viewMode === 'execution'} onClick={() => setViewMode('execution')}>实验执行图</button>
                    <button aria-pressed={viewMode === 'relation'} onClick={() => setViewMode('relation')}>研究关系图</button>
                  </div>
                  {viewMode === 'relation' && (
                    <div className="rd-seg" role="group" aria-label="分支显示">
                      <button aria-pressed={!showAll} onClick={() => setShowAll(false)}>研究主链</button>
                      <button aria-pressed={showAll} onClick={() => setShowAll(true)}>全部分支</button>
                    </div>
                  )}
                  <span className="rd-dim" style={{ fontSize: 12 }}>
                    {viewMode === 'execution'
                      ? '按实验准备 → 单变量验证 → 结果比较 → 组合与验证分组；点击节点查看详情'
                      : showAll ? '显示主链与全部计划分支' : '主链视图'}
                  </span>
                </div>
                {viewMode === 'execution' && executionModel !== null ? (
                  // 执行图：固定纵向主流程，无需平移缩放；状态、下一步与阻塞原因
                  // 全部由 execution-graph.ts 从真实数据推导。
                  <div className="rd-execViewport" role="region" aria-label="实验执行图">
                    <NextStepCard next={executionModel.next} model={executionModel} onSelectNode={selectNode} />
                    <ExecutionFlow model={executionModel} selectedId={selectedId} onSelectNode={selectNode} />
                  </div>
                ) : (
                  <>
                    <div
                      ref={viewportRef}
                      className={`rd-graphViewport${panning ? ' rd-panning' : ''}`}
                      onPointerDown={onPointerDown}
                      onPointerMove={onPointerMove}
                      onPointerUp={onPointerUp}
                      onWheel={onWheel}
                      tabIndex={0}
                      aria-label="研究图画布：可拖拽平移、滚轮缩放，Tab 可在节点间移动"
                    >
                      {!showAll && hiddenIds.size > 0 && (
                        <div className="rd-hiddenChip">
                          <Icon name="branch" size={13} />
                          已隐藏 {hiddenIds.size} 个计划/分支对象
                          <button className="rd-linkBtn" onClick={() => setShowAll(true)}>展开全部分支</button>
                        </div>
                      )}
                      <div className="rd-zoomBtns">
                        <button className="rd-btn" aria-label="放大" onClick={() => zoomBy(0.15)}>+</button>
                        <button className="rd-btn" aria-label="缩小" onClick={() => zoomBy(-0.15)}>−</button>
                        <button className="rd-btn" onClick={() => setTr({ x: 0, y: 0, k: 1 })} title="复位">复位</button>
                      </div>
                      {/* BR-FE3: Mermaid auto-layout replaces the hand-drawn SVG. The visible
                          node/edge set is the same filtered set (主链 vs 全部分支); details,
                          Slot scoping and cross-page navigation are untouched below. */}
                      <div style={{ transform: `translate(${tr.x}px,${tr.y}px) scale(${tr.k})`, transformOrigin: '0 0' }}>
                        <MermaidGraph
                          nodes={visibleNodes}
                          edges={visibleEdges}
                          direction={narrowView ? 'TB' : 'LR'}
                          dark={darkTheme}
                          selectedId={selectedId}
                          onSelectNode={(id) => selectNode(id)}
                        />
                      </div>
                    </div>
                    {/* BR-FE3 legend mirrors the Mermaid classDefs in worktree-mermaid.ts. */}
                    <div className="rd-legend">
                      <span className="rd-legendItem"><span className="rd-legendLine" />主流程</span>
                      <span className="rd-legendItem"><span className="rd-legendLine dashed" />关联/计划</span>
                      <span className="rd-legendItem"><span className="rd-legendDot" style={{ background: '#3c763d' }} />已完成</span>
                      <span className="rd-legendItem"><span className="rd-legendDot" style={{ background: '#31708f' }} />进行中</span>
                      <span className="rd-legendItem"><span className="rd-legendDot" style={{ background: '#5b3fa0' }} />已确认</span>
                      <span className="rd-legendItem"><span className="rd-legendDot" style={{ background: '#c0392b' }} />失败</span>
                      <span className="rd-legendItem"><span className="rd-legendDot" style={{ background: '#b7791f' }} />实验</span>
                      <span className="rd-legendItem"><span className="rd-legendDot" style={{ background: '#2c5f8a' }} />基线</span>
                    </div>
                  </>
                )}
              </div>

              <div className="rd-treeInsp">
                {selected === null ? (
                  <EmptyInspectorPlaceholder />
                ) : (
                  <NodeInspector
                    node={selected}
                    onClose={() => selectNode(null)}
                    onBranch={(decision) => setBranchModal({ node: selected, decision })}
                  />
                )}
              </div>
            </div>
            <ActivityLog entries={data.activity} />
          </>
        )}
        {branchModal !== null && (
          <BranchActionModal
            node={branchModal.node}
            decision={branchModal.decision}
            onClose={() => setBranchModal(null)}
            onSubmit={(reason) =>
              emit({
                type: 'request_branch_action',
                taskKey: snapshot.task.taskKey,
                nodeKey: branchModal.node.id,
                decision: branchModal.decision,
                reason,
              }).then(() => undefined)
            }
          />
        )}
      </div>
    </RegionStateView>
  );
}

function BranchActionModal(props: {
  node: ResearchNodeView;
  decision: 'retain' | 'expand' | 'prune';
  onClose: () => void;
  onSubmit: (reason: string) => Promise<void>;
}): JSX.Element {
  const labels = { retain: '保留', expand: '扩展', prune: '剪枝' } as const;
  return (
    <ReasonPromptModal
      title={`${labels[props.decision]}：${props.node.title}`}
      submitLabel={`提交${labels[props.decision]}请求（演示）`}
      onClose={props.onClose}
      onSubmit={props.onSubmit}
    >
      <div className="rd-muted" style={{ fontSize: 13 }}>
        该请求只发送动作事件并记录原因；最佳路径由后端/研究流程决定，前端不会据此自行改判节点状态。
      </div>
    </ReasonPromptModal>
  );
}

// ---------------------------------------------------------------------------
// pieces (BR-FE3: the hand-drawn Edge/GraphNode layer is retired — MermaidGraph renders
// the diagram from the same filtered nodes/edges. The inspector, Slot scoping and
// cross-page navigation below are untouched.)
// ---------------------------------------------------------------------------

function SummaryCard({ data }: { data: TreeData }): JSX.Element {
  const s = data.summary;
  return (
    <section className="rd-panel rd-pad rd-summary" aria-label="结果摘要">
      <div className="rd-summaryNarr">
        <h3>结果摘要</h3>
        <div>{s.narrative}</div>
        <div className="rd-row" style={{ marginTop: 10, gap: 6, flexWrap: 'wrap' }}>
          <Chip tone="gray">结论状态：{s.statementStatus}</Chip>
          {s.nextActions.map((a) => <Chip key={a} tone="blue">下一步：{a}</Chip>)}
        </div>
      </div>
      <div className="rd-stats">
        {s.statistics.map((st) => (
          <div className="rd-stat" key={st.key}>
            <span className="rd-statLabel">{st.label}</span>
            {st.value === null ? (
              <span className="rd-statVal rd-dim" style={{ fontSize: 19 }}>暂无</span>
            ) : st.link !== null && st.link !== undefined ? (
              <ObjectLinkButton link={st.link}>
                <span className="rd-statVal" style={{ color: st.tone === 'green' ? 'var(--rd-green)' : st.tone === 'purple' ? 'var(--rd-purple)' : st.tone === 'pink' ? 'var(--rd-pink)' : 'var(--rd-blue)', fontSize: 22 }}>
                  {st.value}
                </span>
              </ObjectLinkButton>
            ) : (
              <span className="rd-statVal" style={{ color: st.tone === 'green' ? 'var(--rd-green)' : st.tone === 'purple' ? 'var(--rd-purple)' : st.tone === 'pink' ? 'var(--rd-pink)' : 'var(--rd-blue)' }}>
                {st.value}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function NodeInspector(props: {
  node: ResearchNodeView;
  onClose: () => void;
  onBranch: (decision: 'retain' | 'expand' | 'prune') => void;
}): JSX.Element {
  const { unavailableActions } = useWorkbench();
  const meta = NODE_META[props.node.kind];
  const st = NODE_STATUS_META[props.node.status];
  const toneChip = props.node.status === 'failed' || props.node.status === 'pruned'
    ? 'red'
    : props.node.status === 'planned' || props.node.status === 'blocked'
      ? 'yellow'
      : props.node.status === 'expanded' || props.node.status === 'in_progress'
        ? 'blue'
        : 'green';
  const planning = props.node.planningStatus ?? null;
  const planningMeta = planning === null || planning === 'not_planned' ? null : PLANNING_STATUS_META[planning];

  return (
    <InspectorShell
      icon={<Icon name={meta.icon as IconName} size={22} />}
      iconTone={meta.color}
      title={props.node.title}
      sub={<span className="rd-row" style={{ gap: 8 }}>
        <span style={{ color: meta.color }}>{meta.label}</span>
        <span className="rd-dim">·</span>
        <span>分支 {props.node.branch === 'main' ? '主链' : props.node.branch === 'X' ? '已剪枝' : props.node.branch}</span>
      </span>}
      badges={<>
        {/* Run status and planning status are two badges, because they are two
            facts: a plan can be confirmed with nothing run, and a run can
            finish with nothing confirmed (FE-R05). */}
        <Chip tone={toneChip as 'red' | 'yellow' | 'blue' | 'green'}>运行状态：{st.label}</Chip>
        {planningMeta !== null && <Chip cls={planningMeta.cls}>规划：{planningMeta.label}</Chip>}
      </>}
      onClose={props.onClose}
    >
      <DetailSection title="研究理由">
        <div>{props.node.rationale ?? '暂无记录的研究理由。'}</div>
      </DetailSection>
      <DetailSection title="摘要">
        <div>{props.node.summary}</div>
      </DetailSection>
      {props.node.outcome !== null && (
        <DetailSection title={props.node.kind === 'experiment' && props.node.status !== 'planned' ? '结果' : '下一步 / 结论'}>
          <div>{props.node.outcome}</div>
        </DetailSection>
      )}
      {props.node.failureNote !== null && props.node.failureNote !== undefined && (
        <DetailSection title="失败说明（失败实验 ≠ 被剪枝方案）">
          <div style={{ color: '#f1a3a3' }}>{props.node.failureNote}</div>
        </DetailSection>
      )}
      {props.node.extraSections?.map((sec) => (
        <DetailSection key={sec.heading} title={sec.heading}><div>{sec.body}</div></DetailSection>
      ))}
      <DetailSection title="来源 / 实验引用">
        <LinkList links={props.node.links} emptyText="暂无来源引用。" />
      </DetailSection>
      {props.node.actor !== null && (
        <DetailSection title="角色与协作（折叠信息）">
          <KV rows={[['角色', props.node.actor.role], ['状态', props.node.actor.status]]} />
        </DetailSection>
      )}
      {(props.node.kind === 'scheme' || props.node.kind === 'hypothesis' || props.node.kind === 'conclusion') && (
        <DetailSection title="研究决策（需填写原因）">
          <div className="rd-row" style={{ flexWrap: 'wrap' }}>
            <button className="rd-btn" disabled={unavailableActions.request_branch_action !== undefined} title={unavailableActions.request_branch_action} onClick={() => props.onBranch('retain')}>保留</button>
            <button className="rd-btn" disabled={unavailableActions.request_branch_action !== undefined} title={unavailableActions.request_branch_action} onClick={() => props.onBranch('expand')}>扩展</button>
            <button className="rd-btn" disabled={unavailableActions.request_branch_action !== undefined} title={unavailableActions.request_branch_action} onClick={() => props.onBranch('prune')} style={{ color: '#f1a3a3' }}>剪枝</button>
          </div>
        </DetailSection>
      )}
    </InspectorShell>
  );
}

function ActivityLog({ entries }: { entries: ActivityEntry[] }): JSX.Element {
  return (
    <details className="rd-panel rd-activity">
      <summary>
        <Icon name="chevron" size={13} />
        操作记录（{entries.length}）
      </summary>
      <div className="rd-activityBody">
        {entries.map((a) => (
          <div className="rd-actItem" key={a.id}>
            <span className="rd-actTime">{a.time}<br /><span className="rd-dim">{a.actor}</span></span>
            <span>
              <b>{a.action}</b>
              {a.target !== null && <> · <ObjectLinkButton link={a.target} /></>}
              <span className={a.rejected ? 'rd-actReject' : ''}> → {a.result}</span>
              {a.rejected === true && a.rejectReason !== null && a.rejectReason !== undefined && (
                <div className="rd-reject" style={{ marginTop: 5 }}>拒绝原因：{a.rejectReason}</div>
              )}
              {a.detail !== null && a.detail !== undefined && <div className="rd-dim" style={{ fontSize: 12 }}>{a.detail}</div>}
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}
