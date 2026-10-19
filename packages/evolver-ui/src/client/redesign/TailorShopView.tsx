/**
 * Tailor shop page (reference F2): position / category switcher on the left,
 * search + multi-filter + sort with intersection semantics in the middle, and
 * the component inspector (overview / experiment records / related papers)
 * with the local Trial draft on the right.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import {
  RegionStateView,
  StaleBanner,
  regionReady,
  useWorkbench,
} from './WorkbenchView.tsx';
import { DetailSection, InspectorShell, RevisionValue } from './Inspector.tsx';
import { Chip, Drawer, LinkList, Modal, ObjectLinkButton, layoutBandOf, useAsyncAction, useContainerWidth } from './controls.tsx';
import { SlotNavigator } from './SlotNavigator.tsx';
import {
  COMPONENT_KIND_ICON,
  COMPONENT_KIND_LABEL,
  EXPERIMENT_STATUS_META,
  componentPage,
  pagesText,
  tailorExtractedSummary,
  tailorProvenance,
} from './view-utils.ts';
import type {
  ComponentKind,
  ComponentView,
  ConfigField,
  ExperimentView,
  PaperView,
  Region,
  ResearchNodeView,
  TailorData,
} from './view-model.ts';

type StatusFilter = 'all' | 'integrable' | 'validated' | 'missing' | 'trial';
type SortMode = 'rank' | 'name' | 'recent';
type LeftMode = 'position' | 'category';

export function TailorShopView(props: { region: Region<TailorData>; hidden: boolean }): JSX.Element {
  const { snapshot, navSignal, emit, unavailableActions, research, activeNodeId } = useWorkbench();
  const [mode, setMode] = useState<LeftMode>('position');
  const [activePosition, setActivePosition] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<ComponentKind | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('rank');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showSources, setShowSources] = useState(false);
  // Narrow band only: whether the drawer is currently open (never auto-opened).
  const [detailOpen, setDetailOpen] = useState(false);
  const [kindFilter, setKindFilter] = useState<Set<ComponentKind>>(new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [trialComponent, setTrialComponent] = useState<ComponentView | null>(null);
  const [adding, setAdding] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  // Session-only components added via the demo “添加组件” flow (never an import).
  const [localComponents, setLocalComponents] = useState<ComponentView[]>([]);
  // Breakpoints follow the container the host actually gave us, not the window.
  const [bodyRef, bodyWidth] = useContainerWidth();
  const band = layoutBandOf(bodyWidth);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());

  const data = regionReady(props.region) ? props.region.data : null;
  const components = useMemo(
    () => (data === null ? [] : [...localComponents, ...data.components]),
    [data, localComponents],
  );

  // Default-select the first component so first paint matches F2; keep the
  // user's choice only while it still exists (scenario switches reset it).
  useEffect(() => {
    if (data === null) { setSelectedKey(null); return; }
    const all = [...localComponents, ...data.components];
    if (selectedKey === null || !all.some((c) => c.componentKey === selectedKey)) {
      setSelectedKey(all[0]?.componentKey ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const experiments: ExperimentView[] = snapshot.papers.data?.experiments ?? [];
  const papers: PaperView[] = snapshot.papers.data?.papers ?? [];
  const schemes: ResearchNodeView[] = (snapshot.tree.data?.nodes ?? []).filter((n) => n.kind === 'scheme');
  // Slots belong to the node selected in the work tree. With no selection the
  // pane is simply absent — it never shows another node's slots as if they were
  // the current scope (FE-02 §5).
  const slots = useMemo(() => {
    const all = snapshot.bootstrap?.data?.slots ?? [];
    if (activeNodeId === null) return [];
    return all.filter((s) => s.nodeId === activeNodeId);
  }, [snapshot.bootstrap, activeNodeId]);

  // Cross-page navigation arriving at a component.
  useEffect(() => {
    if (navSignal === null || props.hidden) return;
    if (navSignal.target.kind === 'component' && components.some((c) => c.componentKey === navSignal.target.key)) {
      setSelectedKey(navSignal.target.key);
      const c = components.find((x) => x.componentKey === navSignal.target.key);
      if (c !== undefined && c.positionKeys[0] !== undefined) setActivePosition(c.positionKeys[0]);
      setActiveCategory(null);
      setMode('position');
    }
  }, [navSignal, props.hidden, components]);

  const q = query.trim().toLowerCase();

  const passSearch = (c: ComponentView): boolean => {
    if (q === '') return true;
    return [c.name, c.description, ...c.tags].some((t) => t.toLowerCase().includes(q));
  };
  const passScope = (c: ComponentView): boolean => {
    if (mode === 'position') return activePosition === null || c.positionKeys.includes(activePosition);
    return activeCategory === null || c.kind === activeCategory;
  };
  const passKind = (c: ComponentView): boolean => kindFilter.size === 0 || kindFilter.has(c.kind);

  // Counts are computed over the search+scope set, independent of the status
  // chip selection (SPEC §4.1: 数量来自筛选前对应集合).
  const baseSet = useMemo(
    () => components.filter((c) => passSearch(c) && passScope(c) && passKind(c)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [components, q, activePosition, activeCategory, mode, kindFilter],
  );

  const counts: Record<StatusFilter, number> = useMemo(() => ({
    all: baseSet.length,
    integrable: baseSet.filter((c) => c.integrable === true).length,
    validated: baseSet.filter((c) => c.validatedInTask).length,
    missing: baseSet.filter((c) => c.missing.length > 0).length,
    trial: baseSet.filter((c) => c.trial.count > 0).length,
  }), [baseSet]);

  const passStatus = (c: ComponentView): boolean => {
    switch (statusFilter) {
      case 'integrable': return c.integrable === true;
      case 'validated': return c.validatedInTask;
      case 'missing': return c.missing.length > 0;
      case 'trial': return c.trial.count > 0;
      default: return true;
    }
  };

  const visible = useMemo(() => {
    const list = baseSet.filter(passStatus);
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN');
      if (sort === 'recent') return (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '');
      if (a.rankScore === null || b.rankScore === null) {
        if (a.rankScore === null && b.rankScore === null) return 0;
        return a.rankScore === null ? 1 : -1;
      }
      return b.rankScore - a.rankScore;
    });
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseSet, statusFilter, sort]);

  const selected = selectedKey !== null ? components.find((c) => c.componentKey === selectedKey) ?? null : null;

  // Real provenance of the stored components, so "M 个组件" is never a bare
  // number: counts are aggregated per PAPER (stable paperLink key), never per
  // page/per origin string, and the full source list stays reachable in the
  // collapsible panel below (FE-01 §3). Session-only demo drafts are excluded —
  // they are not extracted assets. Nothing here implies 已接入 / 已验证 /
  // 已有 trial: those stay per-component fields with their own (false / 0) values.
  const extractedSummary = tailorExtractedSummary(data?.components ?? [], localComponents.length);
  const provenance = useMemo(() => tailorProvenance(data?.components ?? []), [data]);

  function clearFilters(): void {
    setQuery('');
    setStatusFilter('all');
    setKindFilter(new Set());
    setActivePosition(null);
    setActiveCategory(null);
  }

  return (
    <RegionStateView state={props.region.state}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <StaleBanner state={props.region.state} />
        {data !== null && (
          <div className="rd-tailorBody" ref={bodyRef} data-band={band}>
            {/* ---------------- left ---------------- */}
            <aside className="rd-tl-left" aria-label="适配位置 / 分类">
              <div className="rd-row">
                <h2 style={{ margin: 0, fontSize: 17 }}>通用插槽 <span className="rd-dim" style={{ fontSize: 14, fontWeight: 400 }}>/ 分类视图</span></h2>
                <span className="rd-dim" title="适配位置由数据提供，可为输入/处理，也可为工况/样件/测量/仿真">
                  <Icon name="help" size={15} />
                </span>
              </div>
              <div className="rd-modeSwitch">
                <div className="rd-seg">
                  <button aria-pressed={mode === 'position'} onClick={() => { setMode('position'); setActiveCategory(null); }}>适配位置视图</button>
                  <button aria-pressed={mode === 'category'} onClick={() => { setMode('category'); setActivePosition(null); }}>分类视图</button>
                </div>
              </div>

              {/* Research-bootstrap slots of the node selected in the work tree.
                  The category view still shows the whole project's components
                  (FE-02 §5), so slots never replace it. */}
              {slots.length > 0 && (
                <div className="rd-slotPane">
                  <div className="rd-sectionTitle">研究插槽</div>
                  <div className="rd-dim" style={{ fontSize: 12 }}>
                    当前节点 {activeNodeId ?? '未选中'} · {slots.length} 个位置
                  </div>
                  <SlotNavigator
                    slots={slots}
                    nodeId={activeNodeId}
                    onLoad={async (slot, candidate) => {
                      const out = await research.setSlotComponent(
                        slot.nodeId, slot.slotId, candidate.ref, slot.snapshotRef?.revision ?? null);
                      return { ok: out.ok, message: out.message };
                    }}
                    onToggleLock={async (slot, locked) => {
                      const out = await research.setSlotLocked(slot.nodeId, slot.slotId, locked);
                      return { ok: out.ok, message: out.message };
                    }}
                  />
                </div>
              )}

              {mode === 'position' ? (
                <>
                  {data.positions.length === 0 && <div className="rd-emptyHint">尚无来源声明的接入位置，可切换分类视图查看组件。</div>}
                  {data.positions.map((p, i) => {
                    const candidates = components.filter((c) => c.positionKeys.includes(p.positionKey));
                    const active = activePosition === p.positionKey;
                    return (
                      <div key={p.positionKey}>
                        <div className="rd-posGroup" style={active ? { borderColor: 'var(--rd-blue)', boxShadow: '0 0 0 1px var(--rd-blue) inset' } : undefined}>
                          <div className="rd-posHead" role="button" tabIndex={0} aria-pressed={active}
                            style={{ cursor: 'pointer' }}
                            onClick={() => setActivePosition(active ? null : p.positionKey)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActivePosition(active ? null : p.positionKey); } }}>
                            <span className="rd-posDot" />
                            {p.label}
                            <span className="rd-dim" style={{ fontWeight: 400, fontSize: 12.5 }}>
                              （候选项 {candidates.length}）
                            </span>
                            {p.description !== null && (
                              <span className="rd-dim" title={p.description}><Icon name="help" size={13} /></span>
                            )}
                          </div>
                          <div className="rd-posChips">
                            {candidates.slice(0, 4).map((pc) => (
                              <button key={pc.componentKey} className="rd-posChip" title={pc.description}
                                onClick={() => { setActivePosition(p.positionKey); setSelectedKey(pc.componentKey); }}>
                                {pc.name}
                              </button>
                            ))}
                            {candidates.length === 0 && <span className="rd-dim" style={{ fontSize: 12 }}>暂无候选</span>}
                            <button className="rd-addChip" disabled={unavailableActions.add_component !== undefined} title={unavailableActions.add_component} onClick={() => { setActivePosition(p.positionKey); setAdding(true); }}>
                              <Icon name="plus" size={12} /> 添加组件
                            </button>
                          </div>
                        </div>
                        {i < data.positions.length - 1 && <div className="rd-posArrow">↓</div>}
                      </div>
                    );
                  })}
                </>
              ) : (
                <div className="rd-catGroup">
                  {(['Baseline', 'Method', 'Module', 'Experiment'] as ComponentKind[]).map((k) => {
                    const n = components.filter((c) => c.kind === k).length;
                    return (
                      <button key={k} className="rd-posGroup" style={{ textAlign: 'left', cursor: 'pointer', borderLeftColor: activeCategory === k ? 'var(--rd-blue)' : undefined }}
                        onClick={() => setActiveCategory(activeCategory === k ? null : k)}>
                        <span className="rd-catHead">
                          <span className="rd-row"><Icon name={COMPONENT_KIND_ICON[k]} size={15} /> {COMPONENT_KIND_LABEL[k]}</span>
                          <span className="rd-dim">{n}</span>
                        </span>
                        <span className="rd-dim" style={{ fontSize: 12 }}>Baseline / Method / Module / Experiment 四类（保留英文类型）</span>
                      </button>
                    );
                  })}
                    <button className="rd-addChip" disabled={unavailableActions.add_component !== undefined} title={unavailableActions.add_component} style={{ alignSelf: 'flex-start', padding: '8px 16px' }} onClick={() => setAdding(true)}>
                    <Icon name="plus" size={13} /> 添加组件
                  </button>
                </div>
              )}
            </aside>

            {/* ---------------- middle ---------------- */}
            <section className="rd-tl-mid" aria-label="组件列表">
              <div className="rd-row">
                <div className="rd-searchWrap" style={{ flex: 1 }}>
                  <span className="rd-searchIcon"><Icon name="search" size={15} /></span>
                  <input className="rd-input" placeholder="搜索模块名称、描述或关键词…"
                    value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索组件" />
                </div>
                <select className="rd-select" style={{ width: 150 }} value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="排序">
                  <option value="rank">综合排序</option>
                  <option value="name">名称排序</option>
                  <option value="recent">最近使用</option>
                </select>
              </div>

              <div className="rd-filterRow">
                {([
                  ['all', '全部'], ['integrable', '可接入'], ['validated', '已验证'],
                  ['missing', '缺项'], ['trial', '本任务有 trial'],
                ] as Array<[StatusFilter, string]>).map(([id, label]) => (
                  <button key={id} className="rd-fchip" aria-pressed={statusFilter === id} onClick={() => setStatusFilter(id)}>
                    {label}（{counts[id]}）
                  </button>
                ))}
                <button className="rd-fchip" aria-pressed={showAdvanced}
                  onClick={() => setShowAdvanced(!showAdvanced)}>
                  <Icon name="filter" size={13} /> 更多筛选
                </button>
              </div>

              {showAdvanced && (
                <div className="rd-advPanel">
                  <span className="rd-dim">类型（多条件取交集）：</span>
                  {(['Baseline', 'Method', 'Module', 'Experiment'] as ComponentKind[]).map((k) => (
                    <label key={k} className="rd-check">
                      <input type="checkbox" checked={kindFilter.has(k)}
                        onChange={() => {
                          const next = new Set(kindFilter);
                          if (next.has(k)) next.delete(k); else next.add(k);
                          setKindFilter(next);
                        }} />
                      {COMPONENT_KIND_LABEL[k]}
                    </label>
                  ))}
                  {(activePosition !== null || activeCategory !== null || q !== '' || kindFilter.size > 0) && (
                    <button className="rd-linkBtn" onClick={clearFilters}>清除全部条件</button>
                  )}
                </div>
              )}

              {(data?.components.length ?? 0) > 0 && (
                // Short by construction: two real counts, then the full
                // provenance behind a collapsible panel — never tens of screens
                // of origin text above the list (FE-01 §3).
                <div className="rd-summaryLine">
                  <span className="rd-dim">{extractedSummary}</span>
                  <button type="button" className="rd-linkBtn" aria-expanded={showSources}
                    onClick={() => setShowSources(!showSources)}>
                    <Icon name="chevron" size={12} style={showSources ? { transform: 'rotate(90deg)' } : undefined} />
                    来源（{provenance.paperCount === null ? '未知' : provenance.paperCount}）
                  </button>
                </div>
              )}

              {showSources && (
                // Grouped by paper with page sets: complete provenance, scrolled
                // inside its own panel instead of pushing the list away.
                <div className="rd-sourcePanel">
                  {provenance.unknownPaperComponents > 0 && (
                    <div className="rd-broken">
                      <Icon name="warning" size={12} />
                      有 {provenance.unknownPaperComponents} 个组件缺少论文标识，无法计入论文数；不按标题或文件名猜测唯一身份。
                    </div>
                  )}
                  {provenance.groups.length === 0 ? (
                    <div className="rd-dim">当前组件没有可展示的论文来源。</div>
                  ) : provenance.groups.map((g) => {
                    const pages = pagesText(g.pages);
                    return (
                      <div key={g.paperKey ?? g.label} className="rd-sourceRow rd-sourceGroupRow">
                        <span className="rd-sourceName" title={g.label}>{g.label}</span>
                        <span className="rd-dim">{pages ?? '页码未知'}</span>
                        <span className="rd-spacer" />
                        <span className="rd-dim">{g.componentCount} 个组件</span>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="rd-cardList">
                {visible.length === 0 ? (
                  <div className="rd-emptyHint">
                    没有匹配的组件。<br />
                    <button className="rd-linkBtn" onClick={clearFilters}>清除筛选条件</button>
                  </div>
                ) : visible.map((c) => (
                  <ComponentCard
                    key={c.componentKey}
                    c={c}
                    cardRef={(el) => {
                      if (el === null) cardRefs.current.delete(c.componentKey);
                      else cardRefs.current.set(c.componentKey, el);
                    }}
                    selected={c.componentKey === selectedKey}
                    onSelect={() => setSelectedKey(c.componentKey)}
                    onTrial={() => setTrialComponent(c)}
                    menuOpen={menuKey === c.componentKey}
                    onToggleMenu={() => setMenuKey(menuKey === c.componentKey ? null : c.componentKey)}
                    onCloseMenu={() => setMenuKey(null)}
                    onRequestImpl={async () => {
                      setMenuKey(null);
                      await emit({
                        type: 'request_implementation',
                        taskKey: snapshot.task.taskKey,
                        componentKey: c.componentKey,
                        missing: c.missing,
                      });
                    }}
                  />
                ))}
              </div>
            </section>

            {/* ---------------- right ---------------- */}
            {band !== 'narrow' ? (
              <aside className="rd-tl-right" aria-label="组件详情">
                {selected === null ? (
                  <div className="rd-panel rd-placeholder">
                    <Icon name="cube" size={38} color="#6f7681" />
                    <div className="rd-big">选择左侧组件查看详情</div>
                  </div>
                ) : (
                  <ComponentInspector
                    c={selected}
                    experiments={experiments}
                    papers={papers}
                    onClose={() => setSelectedKey(null)}
                    onTrial={() => setTrialComponent(selected)}
                  />
                )}
              </aside>
            ) : (
              // Narrow container: the detail becomes a closable drawer so the
              // list keeps the full width; selection survives the band switch.
              // The drawer only opens on an explicit user action — opening it
              // for the default-selected component would cover the list the
              // reader is supposed to see first (FE-01 §4).
              <>
                <button type="button" className="rd-btn" style={{ flex: '0 0 auto' }}
                  onClick={() => {
                    if (selected === null) setSelectedKey(visible[0]?.componentKey ?? null);
                    setDetailOpen(true);
                  }}
                  disabled={visible.length === 0}>
                  {selected === null ? '查看组件详情' : `详情：${selected.name}`}
                </button>
                {selected !== null && detailOpen && (
                  <Drawer title={selected.name} onClose={() => setDetailOpen(false)}
                    returnFocusTo={cardRefs.current.get(selected.componentKey) ?? null}>
                    <ComponentInspector
                      c={selected}
                      experiments={experiments}
                      papers={papers}
                      onClose={() => setDetailOpen(false)}
                      onTrial={() => setTrialComponent(selected)}
                    />
                  </Drawer>
                )}
              </>
            )}
          </div>
        )}

        {trialComponent !== null && (
          <TrialDraftModal
            c={trialComponent}
            taskKey={snapshot.task.taskKey}
            positions={data?.positions ?? []}
            schemes={schemes}
            onClose={() => setTrialComponent(null)}
          />
        )}
        {adding && (
          <AddComponentModal
            defaultPosition={activePosition}
            positions={data?.positions ?? []}
            onClose={() => setAdding(false)}
            onAdd={(c) => { setLocalComponents((prev) => [...prev, c]); setAdding(false); setSelectedKey(c.componentKey); }}
          />
        )}
      </div>
    </RegionStateView>
  );
}

// ---------------------------------------------------------------------------

/**
 * The quote that belongs to THIS component in its own linked paper.
 *
 * Matched on the component key inside the linked paper's contribution list —
 * never on the title, and never across a same-named paper — so one detail panel
 * shows the real page/quote of one component instead of the whole library's
 * citations (FE-01 §3).
 */
export function ownQuoteFor(papers: PaperView[], c: ComponentView): string | null {
  for (const link of c.paperLinks) {
    if (link.kind !== 'paper') continue;
    const paper = papers.find((p) => p.paperKey === link.key);
    if (paper === undefined) continue;
    if (link.ref !== null && link.ref !== undefined) {
      const byRef = paper.contributions.find((x) => x.id === link.ref);
      if (byRef !== undefined) return byRef.evidences[0]?.value ?? null;
    }
    const byComponent = paper.contributions.find((x) =>
      x.componentLinks.some((l) => l.kind === 'component' && l.key === c.componentKey));
    if (byComponent !== undefined) return byComponent.evidences[0]?.value ?? null;
  }
  return null;
}

function statusChips(c: ComponentView): JSX.Element {
  return (
    <>
      {c.integrable === true && <Chip tone="green">可接入</Chip>}
      {c.integrable === false && <Chip tone="red" title={c.integrableReason ?? undefined}>不可接入</Chip>}
      {c.integrable === null && <Chip tone="gray" title={c.integrableReason ?? undefined}>可接入性未知</Chip>}
      {c.validatedInTask && <Chip tone="blue" title="在本任务中已验证">已验证</Chip>}
      {c.validatedElsewhere !== null && (
        <Chip tone="purple" title={`仅在其他任务验证：${c.validatedElsewhere.taskLabel} — ${c.validatedElsewhere.detail}`}>
          他任务已验证
        </Chip>
      )}
      {c.trial.count > 0 && <Chip tone="gray">本任务有 trial</Chip>}
      {c.missing.length > 0 && <Chip tone="yellow">缺项（{c.missing.length}）</Chip>}
    </>
  );
}

/**
 * One component row.
 *
 * The row is a div wrapping an inner select button: nesting the action buttons
 * inside a <button> produced invalid DOM (React's validateDOMNesting warning)
 * and made the nested controls unreachable by keyboard. The select target keeps
 * its own focusable button, and the actions sit beside it.
 */
function ComponentCard(props: {
  c: ComponentView;
  selected: boolean;
  onSelect: () => void;
  onTrial: () => void;
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onRequestImpl: () => void;
  cardRef?: (el: HTMLButtonElement | null) => void;
}): JSX.Element {
  const { c } = props;
  const { navigate, unavailableActions } = useWorkbench();
  const firstExperimentLink = c.experimentLinks[0];
  return (
    <div className="rd-compCard-wrap" style={{ position: 'relative' }}>
      <div className={`rd-compCard${props.selected ? ' rd-selected' : ''}`}>
        <button type="button" className="rd-compSelect" ref={props.cardRef} onClick={props.onSelect} aria-pressed={props.selected}
          aria-label={`选择组件 ${c.name}`}>
          <span className="rd-compIcon" style={{ background: 'rgba(91,147,255,.1)', color: '#8fb4ff' }}>
            <Icon name={COMPONENT_KIND_ICON[c.kind]} size={19} />
          </span>
          <span className="rd-compMain">
            <span className="rd-compName">{c.name} <span className="rd-dim" style={{ fontWeight: 400, fontSize: 12 }}>· {COMPONENT_KIND_LABEL[c.kind]}</span></span>
            <span className="rd-compDesc">{c.description}</span>
            <span className="rd-row" style={{ gap: 6, flexWrap: 'wrap' }}>{statusChips(c)}</span>
          </span>
        </button>
        <span className="rd-compActions">
          {firstExperimentLink !== undefined && (
            <button type="button" className="rd-linkBtn"
              onClick={(e) => { e.stopPropagation(); navigate(firstExperimentLink); }}>
              看实验
            </button>
          )}
          <button className="rd-btn" disabled={!c.canCreateTrial} title={c.createTrialReason ?? undefined}
            onClick={(e) => { e.stopPropagation(); props.onTrial(); }}>
            创建 Trial
          </button>
          <button className="rd-moreBtn" aria-label="更多操作" aria-expanded={props.menuOpen}
            onClick={(e) => { e.stopPropagation(); props.onToggleMenu(); }}>
            <Icon name="more" size={17} />
          </button>
        </span>
      </div>
      {props.menuOpen && (
        <div className="rd-menu" style={{ right: 8, top: 44 }}>
          <button onClick={() => { navigator.clipboard?.writeText(c.componentKey).catch(() => undefined); props.onCloseMenu(); }}>
            复制组件 Key
          </button>
          {firstExperimentLink !== undefined && (
            <button onClick={() => { navigate(firstExperimentLink); props.onCloseMenu(); }}>查看实验（跳转到实验编排）</button>
          )}
          {c.missing.length > 0 && (
            <button disabled={unavailableActions.request_implementation !== undefined} title={unavailableActions.request_implementation} style={{ color: '#f3cc84' }} onClick={props.onRequestImpl}>补齐实现</button>
          )}
        </div>
      )}
    </div>
  );
}

function ComponentInspector(props: {
  c: ComponentView;
  experiments: ExperimentView[];
  papers: PaperView[];
  onClose: () => void;
  onTrial: () => void;
}): JSX.Element {
  const [tab, setTab] = useState<'overview' | 'experiments' | 'papers'>('overview');
  const { c } = props;
  const linkedExperiments = props.experiments.filter((e) =>
    c.experimentLinks.some((l) => l.kind === 'experiment' && l.key === e.experimentKey));
  const linkedPapers = props.papers.filter((p) =>
    c.paperLinks.some((l) => l.kind === 'paper' && l.key === p.paperKey));

  // The quote attached to THIS component in its own paper's contribution list,
  // matched on the contribution id when `paperLinks[].ref` carries one, else on
  // the linked component key. Nothing is substituted from a same-named paper.
  const ownQuote = ownQuoteFor(props.papers, c);
  const ownQuoteMissing = c.paperLinks.length > 0 && ownQuote === null;

  return (
    <InspectorShell
      icon={<Icon name={COMPONENT_KIND_ICON[c.kind]} size={22} />}
      title={c.name}
      sub={<span>{COMPONENT_KIND_LABEL[c.kind]} · revision <RevisionValue value={c.revision} /> · {c.rankScore === null ? '未评分' : `排序权重 ${c.rankScore}`}</span>}
      badges={statusChips(c)}
      tabs={[
        { id: 'overview', label: '概览' },
        { id: 'experiments', label: `实验记录（${c.experimentLinks.length}）` },
        { id: 'papers', label: `相关论文（${c.paperLinks.length}）` },
      ]}
      activeTab={tab}
      onTab={(id) => setTab(id as typeof tab)}
      onClose={props.onClose}
    >
      {tab === 'overview' && (
        <>
          {c.integrable === false && c.integrableReason !== null && (
            <div className="rd-reject">不可接入原因：{c.integrableReason}</div>
          )}
          {c.integrable === null && c.integrableReason !== null && (
            <div className="rd-staleBanner">{c.integrableReason}</div>
          )}
          {c.validatedElsewhere !== null && (
            <div className="rd-staleBanner">
              <Icon name="warning" size={13} />
              该组件只在“{c.validatedElsewhere.taskLabel}”验证过：{c.validatedElsewhere.detail} 不标为本任务已验证。
            </div>
          )}
          <DetailSection title="解决的问题">
            <div>{c.problem}</div>
            {c.description !== c.problem && <div className="rd-muted" style={{ marginTop: 6 }}>{c.description}</div>}
            {c.capabilities.length > 0 && (
              <div className="rd-row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                {c.capabilities.map((x) => <Chip key={x} tone="gray">{x}</Chip>)}
              </div>
            )}
          </DetailSection>
          <DetailSection title="推荐位置">
            <div className="rd-row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {c.recommendedPositions.length === 0 && <span className="rd-dim">无推荐位置</span>}
              {c.recommendedPositions.map((p) => <Chip key={p} tone="blue">{p}</Chip>)}
            </div>
          </DetailSection>
          <DetailSection title="来源">
            <dl className="rd-kv">
              <dt>作者</dt><dd>{c.source.author}</dd>
              <dt>出处</dt><dd>{c.source.origin}</dd>
              <dt>版本</dt><dd>{c.source.version === null ? '未知' : <RevisionValue value={c.source.version} label="版本" />}</dd>
              <dt>许可证</dt><dd>{c.source.license ?? '未知'}</dd>
              <dt>链接</dt>
              <dd>
                {c.source.url === null ? (
                  <span className="rd-dim">无外部链接（不使用伪造 URL）</span>
                ) : (
                  <a href={c.source.url} target="_blank" rel="noreferrer" style={{ color: '#8fb4ff' }}>{c.source.url} ↗</a>
                )}
              </dd>
            </dl>
            {/* This component's OWN paper and page — the whole library's
                citations are never dumped into one detail panel (FE-01 §3). */}
            <div className="rd-sourceOwn">
              <div className="rd-dim">本组件来源</div>
              {c.paperLinks.length === 0 ? (
                <div className="rd-dim">该组件没有关联论文，来源未标引。</div>
              ) : c.paperLinks.map((l) => (
                <div key={`${l.kind}:${l.key}:${l.ref ?? ''}`} className="rd-sourceRow">
                  <ObjectLinkButton link={l} />
                  <span className="rd-dim">{componentPage(c) === null ? '页码未知' : `第 ${componentPage(c)} 页`}</span>
                  <span className="rd-spacer" />
                  {l.revision !== null && l.revision !== undefined && <RevisionValue value={l.revision} label="论文版本" />}
                </div>
              ))}
              {ownQuote === null && ownQuoteMissing && (
                <div className="rd-broken"><Icon name="warning" size={12} /> 找到同一来源条目但原文引用缺失。</div>
              )}
              {ownQuote !== null && (
                <details className="rd-quote">
                  <summary>原文引用</summary>
                  <blockquote>{ownQuote}</blockquote>
                </details>
              )}
            </div>
          </DetailSection>
          {c.missing.length > 0 && (
            <DetailSection title="缺项">
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {c.missing.map((m) => <li key={m} style={{ color: '#f3cc84' }}>{m}</li>)}
              </ul>
            </DetailSection>
          )}
          <DetailSection title="本任务记录">
            <div className="rd-relList">
              <div className="rd-relRow"><b>已创建的 Trial</b><span className="rd-spacer" />{c.trial.count} 个</div>
              <div className="rd-relRow"><b>本任务成功</b><span className="rd-spacer" />
                {c.trial.succeededInTask === null ? <span className="rd-dim">未知 / 未运行</span> : c.trial.succeededInTask ? '是' : '否'}
              </div>
              <div className="rd-relRow"><b>最近使用</b><span className="rd-spacer" />{c.trial.lastAttemptAt ?? '—'}</div>
            </div>
            <button className="rd-btn rd-btn-primary" style={{ marginTop: 8 }} disabled={!c.canCreateTrial}
              title={c.createTrialReason ?? undefined} onClick={props.onTrial}>
              创建 Trial
            </button>
            {!c.canCreateTrial && c.createTrialReason !== null && (
              <div className="rd-dim" style={{ fontSize: 12 }}>{c.createTrialReason}</div>
            )}
          </DetailSection>
        </>
      )}

      {tab === 'experiments' && (
        <DetailSection title="实验记录">
          {c.experimentLinks.length === 0 ? (
            <div className="rd-emptyHint">本任务还没有该组件的实验记录。有 trial 不代表 trial 成功。</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {c.experimentLinks.map((l) => {
                const exp = linkedExperiments.find((e) => e.experimentKey === l.key);
                return (
                  <div key={`${l.key}`} className="rd-section">
                    <div className="rd-row">
                      <ObjectLinkButton link={l} />
                      <span className="rd-spacer" />
                      {exp !== undefined && (
                        <Chip tone={exp.status === 'failed' ? 'red' : exp.status === 'completed' ? 'green' : 'gray'}>
                          {EXPERIMENT_STATUS_META[exp.status].label}
                        </Chip>
                      )}
                    </div>
                    {exp !== undefined && (
                      <div className="rd-muted" style={{ fontSize: 12.5 }}>
                        {exp.combination ? '组合实验' : '单模块实验'} · attempt {exp.attempt ?? '—'}
                        {exp.diagnostics !== null && <div style={{ color: '#f1a3a3' }}>{exp.diagnostics}</div>}
                      </div>
                    )}
                    {exp === undefined && <div className="rd-broken"><Icon name="warning" size={12} /> 实验详情不在当前数据集中（可能在其他任务或尚未同步）。</div>}
                  </div>
                );
              })}
            </div>
          )}
        </DetailSection>
      )}

      {tab === 'papers' && (
        <DetailSection title="相关论文">
          {c.paperLinks.length === 0 ? (
            <div className="rd-emptyHint">暂无关联论文。</div>
          ) : (
            <LinkList links={c.paperLinks} />
          )}
          {linkedPapers.length > 0 && (
            <div className="rd-muted" style={{ fontSize: 12, marginTop: 4 }}>
              已在当前文献库中解析 {linkedPapers.length} 篇；点击上方标题可跳转到论文管理。
            </div>
          )}
        </DetailSection>
      )}
    </InspectorShell>
  );
}

// ---------------------------------------------------------------------------
// trial draft
// ---------------------------------------------------------------------------

function TrialDraftModal(props: {
  c: ComponentView;
  taskKey: string;
  positions: TailorData['positions'];
  schemes: ResearchNodeView[];
  onClose: () => void;
}): JSX.Element {
  const { emit } = useWorkbench();
  const action = useAsyncAction();
  const positionOptions = props.positions.filter((p) => props.c.recommendedPositions.includes(p.label) || props.c.positionKeys.includes(p.positionKey));
  const [positionKey, setPositionKey] = useState(props.c.positionKeys[0] ?? positionOptions[0]?.positionKey ?? '');
  const [schemeKey, setSchemeKey] = useState<string>(props.schemes.find((s) => s.branch !== 'C')?.id ?? '');
  const [params, setParams] = useState<ConfigField[]>([
    { name: '运行备注', value: '', constraint: '必填：说明本次 Trial 的目的' },
    { name: '尝试次数', value: '1', constraint: '正整数' },
  ]);

  const positionMissing = positionKey === '';
  const paramMissing = params.some((p) => p.value.trim() === '');

  async function submit(): Promise<void> {
    const ok = await action.run(async () => {
      const out = await emit({
        type: 'create_trial',
        taskKey: props.taskKey,
        draft: {
          componentRefs: [{ key: props.c.componentKey, revision: props.c.revision }],
          positionKey,
          schemeKey: schemeKey === '' ? null : schemeKey,
          parameters: params,
        },
      });
      return out;
    });
    if (ok) props.onClose();
  }

  return (
    <Modal
      title={`创建 Trial 草稿：${props.c.name}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="rd-btn" onClick={props.onClose} disabled={action.pending}>取消</button>
          <button className="rd-btn rd-btn-primary" disabled={action.pending || positionMissing || paramMissing} onClick={submit}>
            {action.pending ? '提交中…' : '模拟提交（不运行真实实验）'}
          </button>
        </>
      }
    >
      <div className="rd-staleBanner">
        <Icon name="experiment" size={14} />
        提交只发送 create_trial 动作回调；演示环境显示“已模拟提交，未运行真实实验”，不会创建/运行/取消任何真实实验。
      </div>
      <div className="rd-field">
        <label>组件</label>
        <div className="rd-row"><Chip tone="blue">{props.c.name}</Chip><span className="rd-dim">{props.c.revision}</span></div>
      </div>
      <div className="rd-field">
        <label>适配位置（必选）</label>
        <select className="rd-select" value={positionKey} onChange={(e) => setPositionKey(e.target.value)}>
          <option value="" disabled>选择位置…</option>
          {positionOptions.map((p) => <option key={p.positionKey} value={p.positionKey}>{p.label}</option>)}
        </select>
      </div>
      <div className="rd-field">
        <label>关联方案（可选）</label>
        <select className="rd-select" value={schemeKey} onChange={(e) => setSchemeKey(e.target.value)}>
          <option value="">不关联方案</option>
          {props.schemes.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
      </div>
      <div className="rd-field">
        <label>参数与约束摘要</label>
        {params.map((p, i) => (
          <div key={p.name} className="rd-row" style={{ alignItems: 'flex-start' }}>
            <div style={{ flex: '0 0 96px', paddingTop: 8 }}>{p.name}</div>
            <input className="rd-input" value={p.value}
              onChange={(e) => setParams((prev) => prev.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
            <div className="rd-dim" style={{ flex: '0 0 150px', fontSize: 12, paddingTop: 8 }}>{p.constraint}</div>
          </div>
        ))}
      </div>
      {(positionMissing || paramMissing) && <div className="rd-reject">请补全位置与必填参数后再提交。</div>}
      {action.error !== null && <div className="rd-reject">{action.error}</div>}
    </Modal>
  );
}

function AddComponentModal(props: {
  defaultPosition: string | null;
  positions: TailorData['positions'];
  onClose: () => void;
  onAdd: (c: ComponentView) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ComponentKind>('Module');
  const [positionKey, setPositionKey] = useState(props.defaultPosition ?? props.positions[0]?.positionKey ?? '');
  const [err, setErr] = useState<string | null>(null);

  function submit(): void {
    if (name.trim() === '') { setErr('请填写组件名称。'); return; }
    if (positionKey === '') { setErr('请选择适配位置。'); return; }
    const key = `local-${Date.now()}`;
    props.onAdd({
      componentKey: key,
      revision: 'local-draft',
      kind,
      name: name.trim(),
      description: '本地演示添加的组件草稿：未导入任何仓库、未执行代码，刷新后消失。',
      tags: ['本地演示'],
      positionKeys: [positionKey],
      capabilities: [],
      missing: ['演示草稿：无真实实现'],
      integrable: null,
      integrableReason: '本地草稿，尚未评估。',
      validatedInTask: false,
      validatedElsewhere: null,
      trial: { count: 0, succeededInTask: null, lastAttemptAt: null },
      rankScore: 0,
      lastUsedAt: null,
      source: { author: '本地演示', origin: '会话内草稿', version: null, license: null, url: null },
      problem: '',
      recommendedPositions: props.positions.filter((p) => p.positionKey === positionKey).map((p) => p.label),
      experimentLinks: [],
      paperLinks: [],
      canCreateTrial: false,
      createTrialReason: '本地草稿不能创建 Trial。',
    });
  }

  return (
    <Modal
      title="添加组件（本地演示）"
      onClose={props.onClose}
      footer={
        <>
          <button className="rd-btn" onClick={props.onClose}>取消</button>
          <button className="rd-btn rd-btn-primary" onClick={submit}>加入本地选项</button>
        </>
      }
    >
      <div className="rd-staleBanner">
        <Icon name="warning" size={13} />
        仅在本会话的本地列表中新增一个草稿选项，不会导入仓库、不会执行代码，也不会产生真实组件。
      </div>
      <div className="rd-field">
        <label>组件名称</label>
        <input className="rd-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：振动信号降噪组件" />
      </div>
      <div className="rd-field">
        <label>类型</label>
        <select className="rd-select" value={kind} onChange={(e) => setKind(e.target.value as ComponentKind)}>
          {(['Baseline', 'Method', 'Module', 'Experiment'] as ComponentKind[]).map((k) => (
            <option key={k} value={k}>{COMPONENT_KIND_LABEL[k]}（{k}）</option>
          ))}
        </select>
      </div>
      <div className="rd-field">
        <label>适配位置</label>
        <select className="rd-select" value={positionKey} onChange={(e) => setPositionKey(e.target.value)}>
          {props.positions.map((p) => <option key={p.positionKey} value={p.positionKey}>{p.label}</option>)}
        </select>
      </div>
      {err !== null && <div className="rd-reject">{err}</div>}
    </Modal>
  );
}
