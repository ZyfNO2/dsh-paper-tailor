/**
 * Paper management page (reference F3): full-width search/filter toolbar,
 * paper list on the left (29%), detail on the right with the contribution
 * column (65%) and meta column (35%). Contributions stay traceable: paper-
 * reported values vs local observations are labelled separately.
 */
import { useEffect, useMemo, useState } from 'react';
import { Icon } from './icons.tsx';
import {
  RegionStateView,
  StaleBanner,
  regionReady,
  useWorkbench,
} from './WorkbenchView.tsx';
import { Chip, LinkList, Modal, ObjectLinkButton, useAsyncAction } from './controls.tsx';
import {
  CONTRIBUTION_META,
  EXPERIMENT_STATUS_META,
  PAPER_FLAG_META,
  paperAssetFacts,
  paperAssetStatusText,
  paperComponentEmptyHint,
} from './view-utils.ts';
import type {
  ContributionView,
  ExperimentView,
  PaperFlag,
  PaperView,
  PapersData,
  Region,
} from './view-model.ts';

type FilterId = 'all' | 'high' | 'extracted' | 'cited' | 'missing';
type SortMode = 'relevance' | 'year' | 'title';

export function PaperLibraryView(props: { region: Region<PapersData>; hidden: boolean; initialDetailTab?: 'contrib' | 'citations' }): JSX.Element {
  const { navSignal } = useWorkbench();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterId>('all');
  const [sort, setSort] = useState<SortMode>('relevance');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const data = regionReady(props.region) ? props.region.data : null;

  // Default-select the top paper so first paint matches F3; scenario changes
  // reset a selection that no longer exists.
  useEffect(() => {
    if (data === null) { setSelectedKey(null); return; }
    if (selectedKey === null || !data.papers.some((p) => p.paperKey === selectedKey)) {
      setSelectedKey(data.papers[0]?.paperKey ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Notes mutated locally for the session (save_note is also emitted).
  const [notes, setNotes] = useState<Record<string, string>>({});

  // Cross-page navigation (component→paper, experiment→citation, wiki).
  useEffect(() => {
    if (navSignal === null || data === null || props.hidden) return;
    const t = navSignal.target;
    let key: string | null = null;
    if (t.kind === 'paper') key = t.key;
    if (t.kind === 'contribution') key = data.papers.some((p) => p.contributions.some((c) => c.id === t.ref)) ? t.key : null;
    if (t.kind === 'wiki') {
      const owner = data.papers.find((p) => p.wikiLinks.some((w) => w.key === t.key));
      key = owner?.paperKey ?? null;
    }
    if (key !== null && data.papers.some((p) => p.paperKey === key)) setSelectedKey(key);
  }, [navSignal, data, props.hidden]);

  const q = query.trim().toLowerCase();

  const searchable = (p: PaperView): boolean => {
    if (q === '') return true;
    const hay = [
      p.metadata.title,
      p.metadata.venue,
      p.metadata.paperType,
      ...p.metadata.authors,
      ...p.contributions.flatMap((c) => [c.title, c.text, ...c.tags.map((t) => t.label)]),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  };

  const passFilter = (p: PaperView): boolean => {
    switch (filter) {
      case 'high': return p.flags.includes('highly_relevant');
      case 'extracted': return p.flags.includes('extracted');
      case 'cited': return p.flags.includes('cited');
      case 'missing': return p.flags.includes('missing_evidence');
      default: return true;
    }
  };

  const counts = useMemo<Record<FilterId, number>>(() => {
    if (data === null) return { all: 0, high: 0, extracted: 0, cited: 0, missing: 0 };
    const searched = data.papers.filter(searchable);
    return {
      all: searched.length,
      high: searched.filter((p) => p.flags.includes('highly_relevant')).length,
      extracted: searched.filter((p) => p.flags.includes('extracted')).length,
      cited: searched.filter((p) => p.flags.includes('cited')).length,
      missing: searched.filter((p) => p.flags.includes('missing_evidence')).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q]);

  const visible = useMemo(() => {
    if (data === null) return [];
    const list = data.papers.filter(searchable).filter(passFilter);
    const sorted = [...list];
    sorted.sort((a, b) => {
      if (sort === 'title') return a.metadata.title.localeCompare(b.metadata.title, 'zh-Hans-CN');
      if (sort === 'year') return (b.metadata.year ?? -1) - (a.metadata.year ?? -1);
      return (b.relevance?.score ?? -1) - (a.relevance?.score ?? -1);
    });
    return sorted;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, q, filter, sort]);

  const selected = selectedKey !== null ? data?.papers.find((p) => p.paperKey === selectedKey) ?? null : null;

  return (
    <RegionStateView state={props.region.state}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, flex: 1, minHeight: 0 }}>
        <StaleBanner state={props.region.state} />
        {data !== null && (
          <>
            <div className="rd-paperToolbar">
              <div className="rd-searchWrap">
                <span className="rd-searchIcon"><Icon name="search" size={15} /></span>
                <input className="rd-input" placeholder="搜索文献、证据、claim、方法、结论等…"
                  value={query} onChange={(e) => setQuery(e.target.value)} aria-label="搜索文献" />
              </div>
              {([
                ['all', '全部'], ['high', '高相关'], ['extracted', '已抽取'],
                ['cited', '已引用'], ['missing', '缺证据'],
              ] as Array<[FilterId, string]>).map(([id, label]) => (
                <button key={id} className="rd-fchip" aria-pressed={filter === id} onClick={() => setFilter(id)}>
                  {label}（{counts[id]}）
                </button>
              ))}
              <select className="rd-select" style={{ width: 140 }} value={sort} onChange={(e) => setSort(e.target.value as SortMode)} aria-label="排序">
                <option value="relevance">相关性优先</option>
                <option value="year">年份优先</option>
                <option value="title">标题排序</option>
              </select>
            </div>

            <div className="rd-paperBody">
              <aside className="rd-panel rd-pl-left" aria-label="文献列表">
                <div className="rd-pl-listHead">
                  <span>共 {visible.length} 条{visible.length !== data.papers.length ? `（库内 ${data.papers.length}）` : ''}</span>
                  <Icon name="filter" size={14} />
                </div>
                <div className="rd-pl-list">
                  {visible.length === 0 && <div className="rd-emptyHint">没有匹配的文献。</div>}
                  {visible.map((p) => (
                    <PaperListItem key={p.paperKey} p={p} selected={p.paperKey === selectedKey} onSelect={() => setSelectedKey(p.paperKey)} />
                  ))}
                </div>
              </aside>

              <section className="rd-pr-right" aria-label="文献详情">
                {selected === null ? (
                  <div className="rd-panel rd-placeholder">
                    <Icon name="paper" size={40} color="#6f7681" />
                    <div className="rd-big">选择左侧文献查看贡献抽取与证据</div>
                  </div>
                ) : (
                  <PaperDetail
                    key={selected.paperKey}
                    paper={selected}
                    initialTab={props.initialDetailTab}
                    experiments={data.experiments}
                    allPapers={data.papers}
                    noteDraft={notes[selected.paperKey] ?? selected.note ?? ''}
                    onNoteChange={(t) => setNotes((prev) => ({ ...prev, [selected.paperKey]: t }))}
                  />
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </RegionStateView>
  );
}

function PaperListItem(props: { p: PaperView; selected: boolean; onSelect: () => void }): JSX.Element {
  const { p } = props;
  return (
    <button className={`rd-pl-item${props.selected ? ' rd-selected' : ''}`} onClick={props.onSelect} aria-pressed={props.selected}>
      <span className="rd-pl-doc"><Icon name="paper" size={18} /></span>
      <span className="rd-pl-main">
        <span className="rd-pl-title">{p.metadata.title}</span>
        <span className="rd-pl-sub">
          {p.metadata.authors.join('、') || '作者未知'} · {p.metadata.year ?? '年份未知'} · {p.metadata.venue}
        </span>
        <span className="rd-pl-flags">
          {p.flags.slice(0, 3).map((f: PaperFlag) => {
            const m = PAPER_FLAG_META[f];
            return <Chip key={f} tone={m.cls.replace('rd-chip-', '') as 'blue' | 'green' | 'purple' | 'yellow' | 'gray'}>{m.label}</Chip>;
          })}
          {/* Real asset facts per row: the Wiki/component split is not derivable
              from the flag chips alone (SPEC §4). */}
          <span className="rd-dim" style={{ fontSize: 11.5 }}>{paperAssetStatusText(paperAssetFacts(p))}</span>
        </span>
      </span>
      <span className={`rd-pl-score${p.relevance === null ? ' none' : ''}`}>
        {p.relevance === null ? '未评分' : p.relevance.score.toFixed(2)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------

function PaperDetail(props: {
  paper: PaperView;
  initialTab?: 'contrib' | 'citations';
  experiments: ExperimentView[];
  allPapers: PaperView[];
  noteDraft: string;
  onNoteChange: (text: string) => void;
}): JSX.Element {
  const { emit, unavailableActions } = useWorkbench();
  const [tab, setTab] = useState<'contrib' | 'citations' | 'experiments' | 'similar'>(props.initialTab ?? 'contrib');
  const [showExtraction, setShowExtraction] = useState(false);
  const [showCite, setShowCite] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const noteAction = useAsyncAction();
  const p = props.paper;

  const relatedExperiments = props.experiments.filter((e) =>
    p.citations.some((c) => c.kind === 'experiment' && c.key === e.experimentKey));

  // Wiki sections and research components are independent fields of the same
  // paper JSON sharing one revision, so the page states BOTH facts instead of
  // inferring "已抽取" from a non-null revision (SPEC §4, ST-01).
  const facts = paperAssetFacts(p);
  const statusText = paperAssetStatusText(facts);

  async function saveNote(): Promise<void> {
    await noteAction.run(async () => {
      const out = await emit({ type: 'save_note', paperKey: p.paperKey, text: props.noteDraft, baseRevision: p.sourceRevision });
      return out;
    });
  }

  return (
    <div className="rd-panel rd-pr-detail">
      <div className="rd-pr-top">
        <span className="rd-pr-doc"><Icon name="paper" size={22} /></span>
        <div style={{ minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 21 }}>{p.metadata.title}</h2>
          <div className="rd-muted" style={{ marginTop: 3 }}>
            {p.metadata.authors.join('、') || '作者未知'} · {p.metadata.year ?? '年份未知'} · {p.metadata.venue}
          </div>
          <div className="rd-row" style={{ gap: 6, marginTop: 7, flexWrap: 'wrap' }}>
            <Chip tone={facts.componentCount > 0 ? 'green' : facts.sectionCount > 0 ? 'blue' : 'gray'}>{statusText}</Chip>
            {p.flags.map((f) => {
              const m = PAPER_FLAG_META[f];
              return <Chip key={f} tone={m.cls.replace('rd-chip-', '') as 'blue' | 'green' | 'purple' | 'yellow' | 'gray'}>{m.label}</Chip>;
            })}
            {p.relevance === null ? (
              <Chip tone="gray">相关性：未评分</Chip>
            ) : (
              <Chip tone="blue" title={p.relevance.basis}>相关性 {p.relevance.score.toFixed(2)}</Chip>
            )}
          </div>
        </div>
        <div className="rd-pr-actions">
          <button className="rd-btn rd-btn-primary" onClick={() => setShowSource(true)}>
            <Icon name="external" size={14} /> 打开原文
          </button>
          <button className="rd-btn" onClick={() => setShowExtraction(true)}>
            <Icon name="doc" size={14} /> 查看抽取结果
          </button>
          <button className="rd-btn" disabled={unavailableActions.attach_citation !== undefined} title={unavailableActions.attach_citation} onClick={() => setShowCite(true)}>
            <Icon name="link" size={14} /> 引用到实验
          </button>
        </div>
      </div>

      <div className="rd-inspTabs" style={{ paddingLeft: 18 }} role="tablist">
        {([
          ['contrib', '贡献抽取'], ['citations', 'Wiki / 引用'], ['experiments', `相关实验（${relatedExperiments.length}）`], ['similar', `相似项（${p.similar.length}）`],
        ] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className="rd-inspTab" onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>

      <div className="rd-pr-split">
        <div className="rd-pr-contribs">
          {tab === 'contrib' && (
            p.contributions.length === 0 ? (
              <div className="rd-emptyHint">{paperComponentEmptyHint(facts)}</div>
            ) : p.contributions.map((c) => <ContributionCard key={c.id} c={c} paper={p} />)
          )}
          {tab === 'citations' && <CitationsTab paper={p} />}
          {tab === 'experiments' && (
            relatedExperiments.length === 0 ? (
              <div className="rd-emptyHint">该文献尚未被引用到任何实验。</div>
            ) : relatedExperiments.map((e) => <ExperimentRefCard key={e.experimentKey} e={e} />)
          )}
          {tab === 'similar' && (
            p.similar.length === 0 ? (
                <div className="rd-emptyHint">{unavailableActions.paper_similarity ?? '未发现相似项（真实空状态，不编造文献）。'}</div>
            ) : <LinkList links={p.similar} />
          )}
        </div>

        <aside className="rd-pr-meta">
          <div className="rd-section">
            <div className="rd-sectionTitle">基本信息</div>
            <dl className="rd-kv">
              <dt>标题</dt><dd>{p.metadata.title}</dd>
              <dt>作者</dt><dd>{p.metadata.authors.join('、') || '未知'}</dd>
              <dt>年份</dt><dd>{p.metadata.year ?? '未知'}</dd>
              <dt>来源</dt><dd>{p.metadata.venue}</dd>
              <dt>类型</dt><dd>{p.metadata.paperType}</dd>
              <dt>DOI</dt><dd>{p.metadata.doi ?? '未知'}</dd>
              <dt>链接</dt>
              <dd>
                {p.metadata.url === null
                  ? <span className="rd-dim">无（不使用伪造链接）</span>
                  : <a href={p.metadata.url} target="_blank" rel="noreferrer" style={{ color: 'var(--rd-blue)' }}>{p.metadata.url.startsWith('/evolver/paper-library') ? '下载已上传的原文' : p.metadata.url} ↗</a>}
              </dd>
            </dl>
          </div>

          <div className="rd-section">
            <div className="rd-sectionTitle">相关性与状态</div>
            <dl className="rd-kv">
              <dt>评分</dt>
              <dd>{p.relevance === null ? <span className="rd-dim">未评分</span> : `${p.relevance.score.toFixed(2)}（${p.relevance.basis}）`}</dd>
              <dt>知识资产</dt>
              <dd>{statusText}</dd>
              <dt>状态</dt>
              <dd><span className="rd-row" style={{ gap: 5, flexWrap: 'wrap' }}>{p.flags.length === 0 ? <span className="rd-dim">无标记</span> : p.flags.map((f) => <Chip key={f} tone="gray">{PAPER_FLAG_META[f].label}</Chip>)}</span></dd>
            </dl>
          </div>

          <div className="rd-section">
            <div className="rd-sectionTitle">关联内容</div>
            <div className="rd-relList">
              <div className="rd-relRow"><b>相关实验</b><span className="rd-spacer" />{p.citations.length} 个 <Icon name="chevron" size={12} /></div>
              <div className="rd-relRow"><b>相关 claim</b><span className="rd-spacer" />{p.contributions.filter((c) => c.category === 'mechanism').length} 个</div>
              <div className="rd-relRow"><b>相关对象</b><span className="rd-spacer" />{new Set(p.contributions.flatMap((c) => c.componentLinks.map((l) => l.key))).size} 个</div>
              <div className="rd-relRow"><b>被引用次数</b><span className="rd-spacer" />{p.citations.length}</div>
              <div className="rd-relRow"><b>相似文献</b><span className="rd-spacer" />{unavailableActions.paper_similarity !== undefined ? '未启用' : `${p.similar.length} 个`}</div>
            </div>
          </div>

          <div className="rd-section rd-note">
            <div className="rd-sectionTitle">备注{unavailableActions.save_note !== undefined ? '（未启用）' : '（仅本会话保存，刷新丢失）'}</div>
            <textarea
              maxLength={500}
              disabled={unavailableActions.save_note !== undefined}
              value={props.noteDraft}
              onChange={(e) => props.onNoteChange(e.target.value.slice(0, 500))}
              placeholder="在此添加备注…"
              aria-label="论文备注"
            />
            <div className="rd-noteFoot">
              <span>
                {noteAction.error !== null
                  ? <span style={{ color: '#f1a3a3' }}>保存失败：{noteAction.error}</span>
                  : noteAction.pending ? '保存中…' : unavailableActions.save_note ?? '演示：不会写入后端'}
              </span>
              <span className="rd-row" style={{ gap: 8 }}>
                {props.noteDraft.length} / 500
                <button className="rd-btn" disabled={unavailableActions.save_note !== undefined || noteAction.pending || props.noteDraft === (p.note ?? '')} title={unavailableActions.save_note} onClick={saveNote}>保存备注</button>
              </span>
            </div>
          </div>

          <details className="rd-section">
            <summary className="rd-sectionTitle" style={{ cursor: 'pointer' }}>Provenance（折叠）</summary>
            <dl className="rd-kv" style={{ marginTop: 8 }}>
              <dt>paperKey</dt><dd style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.paperKey}</dd>
              <dt>sourceRevision</dt><dd style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.sourceRevision}</dd>
              <dt>本地来源</dt><dd>{p.metadata.localSource ?? <span className="rd-dim">无</span>}</dd>
            </dl>
          </details>
        </aside>
      </div>

      {showExtraction && <ExtractionModal paper={p} onClose={() => setShowExtraction(false)} />}
      {showCite && <CiteExperimentModal paper={p} experiments={props.experiments} onClose={() => setShowCite(false)} />}
      {showSource && <SourceModal paper={p} onClose={() => setShowSource(false)} />}
    </div>
  );
}

function ContributionCard(props: { c: ContributionView; paper: PaperView }): JSX.Element {
  const { c } = props;
  const meta = CONTRIBUTION_META[c.category];
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rd-contrib">
      <div className="rd-contribHead">
        <span className="rd-contribIcon" style={{ background: `${meta.color}22`, color: meta.color }}>
          <Icon name={meta.icon} size={16} />
        </span>
        <span className="rd-contribTitle">{meta.label} · {c.title.replace(/^.*?：/, '')}</span>
        <span className="rd-chip rd-chip-gray">{c.evidences.length} 条</span>
        <span className="rd-spacer" />
        <button className="rd-btn rd-btn-ghost" title="复制 claim 文本"
          onClick={() => navigator.clipboard?.writeText(c.text).catch(() => undefined)}>
          <Icon name="copy" size={14} />
        </button>
        <button className="rd-btn rd-btn-ghost" aria-expanded={expanded} aria-label="展开"
          onClick={() => setExpanded(!expanded)}>
          <Icon name="more" size={15} />
        </button>
      </div>
      <div className="rd-muted" style={{ fontSize: 13 }}>{expanded ? c.text : `${c.text.slice(0, 56)}…`}</div>
      <div className="rd-row" style={{ gap: 6, flexWrap: 'wrap' }}>
        {c.tags.map((t, i) => (
          <Chip key={`${t.label}-${i}`} tone={t.tone}>{t.label}</Chip>
        ))}
      </div>
      {c.evidences.length > 0 && (
        <div className="rd-evidList">
          {c.evidences.map((ev) => (
            <div key={ev.id} className={`rd-evid rd-${ev.source}`}>
              <div>
                <span className={`rd-evidTag rd-${ev.source}`}>{ev.source === 'paper' ? '论文报告值' : '本地观察'}</span>
                <b>{ev.label}</b>
              </div>
              <div className="rd-dim" style={{ fontSize: 12 }}>
                定位：{ev.locator}
                {ev.condition !== null && ` · 条件：${ev.condition}`}
                {ev.value !== null && <> · 值：<b style={{ color: 'var(--rd-text)' }}>{ev.value}{ev.unit !== null ? ` ${ev.unit}` : ''}</b></>}
                {ev.value === null && ' · 值：未知（unknown）'}
              </div>
            </div>
          ))}
        </div>
      )}
      {(c.parameters !== null || c.datasetInfo !== null) && (
        <div className="rd-dim" style={{ fontSize: 12.5 }}>
          {c.parameters !== null && <div>参数摘要：{c.parameters}</div>}
          {c.datasetInfo !== null && <div>数据资源：{c.datasetInfo}</div>}
        </div>
      )}
      {c.componentLinks.length > 0 && (
        <div className="rd-row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <span className="rd-dim" style={{ fontSize: 12 }}>关联组件：</span>
          {c.componentLinks.map((l) => <ObjectLinkButton key={`${l.key}:${l.revision ?? ''}`} link={l} />)}
        </div>
      )}
      {c.slotMapping.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {c.slotMapping.map((m, i) => (
            <div key={i} className="rd-row" style={{ fontSize: 12.5 }}>
              <Chip tone="purple">slot/映射</Chip>
              <span className="rd-dim">来源术语</span>
              <b>{m.sourceTerm}</b>
              <span className="rd-dim">→</span>
              {m.target === null ? <span className="rd-broken">映射目标缺失</span> : <ObjectLinkButton link={m.target}>{m.targetLabel}</ObjectLinkButton>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CitationsTab(props: { paper: PaperView }): JSX.Element {
  const wiki = props.paper.wikiLinks;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <div className="rd-contrib">
        <div className="rd-contribTitle" style={{ fontSize: 14 }}>引用到的实验</div>
        {props.paper.citations.length === 0
          ? <div className="rd-emptyHint">暂无实验引用。</div>
          : <LinkList links={props.paper.citations} />}
      </div>
      <div className="rd-contrib">
        <div className="rd-contribTitle" style={{ fontSize: 14 }}>Wiki 声明（从贡献来源进入）</div>
        {wiki.length === 0
          ? <div className="rd-emptyHint">该文献没有关联 Wiki 版本。</div>
          : wiki.map((w) => (
              <div key={w.key} className="rd-section" style={{ marginBottom: 8 }}>
                <div className="rd-row">
                  <ObjectLinkButton link={{ kind: 'wiki', key: w.key, label: w.title }} />
                  <Chip tone="gray" title={w.version}>版本 {w.version.slice(0, 12)}</Chip>
                  <span className="rd-spacer" />
                  <span className="rd-dim" style={{ fontSize: 12 }}>{w.updatedAt ?? '日期未知'}</span>
                </div>
                <div className="rd-muted" style={{ fontSize: 13, margin: '6px 0', whiteSpace: 'pre-wrap' }}>{w.statement}</div>
                <div className="rd-dim" style={{ fontSize: 12 }}>依赖：{w.dependencies.join('、')}</div>
              </div>
            ))}
      </div>
    </div>
  );
}

function ExperimentRefCard(props: { e: ExperimentView }): JSX.Element {
  const { e } = props;
  return (
    <div className="rd-contrib">
      <div className="rd-row">
        <Icon name="flask" size={16} color="#43d39a" />
        <ObjectLinkButton link={{ kind: 'experiment', key: e.experimentKey, label: e.label }} />
        <span className="rd-spacer" />
        <Chip tone={e.status === 'failed' ? 'red' : e.status === 'completed' ? 'green' : 'gray'}>
          {EXPERIMENT_STATUS_META[e.status].label}
        </Chip>
        <Chip tone={e.combination ? 'purple' : 'blue'}>{e.combination ? '组合实验' : '单模块'}</Chip>
      </div>
      <div className="rd-dim" style={{ fontSize: 12.5 }}>
        {e.metricRows.map((r) => (
          <span key={r.name} style={{ marginRight: 14 }}>
            {r.name}：{r.value === null ? <span className="rd-dim">暂无</span> : <b>{r.value} {r.unit}</b>}
            {!r.comparable && <span style={{ color: '#f3cc84' }}>（不可直接比较{r.note !== null ? `：${r.note}` : ''}）</span>}
          </span>
        ))}
      </div>
      {e.diagnostics !== null && <div style={{ color: '#f1a3a3', fontSize: 12.5 }}>{e.diagnostics}</div>}
    </div>
  );
}

function ExtractionModal(props: { paper: PaperView; onClose: () => void }): JSX.Element {
  const p = props.paper;
  return (
    <Modal title={`抽取结果：${p.metadata.title}`} onClose={props.onClose}
      footer={<button className="rd-btn rd-btn-primary" onClick={props.onClose}>关闭</button>}>
      <div className="rd-muted" style={{ fontSize: 13 }}>完整已知内容与 unknown 状态，而不仅是数量。</div>
      {p.contributions.length === 0 && (
        // The stored fact, not a guess about what the reader did: an empty
        // components array also results from a run that found nothing.
        <div className="rd-emptyHint">{paperComponentEmptyHint(paperAssetFacts(p))}</div>
      )}
      {p.contributions.map((c) => (
        <div key={c.id} className="rd-section">
          <div className="rd-row"><b>{CONTRIBUTION_META[c.category].label}：{c.title}</b><span className="rd-spacer" />{c.evidences.length} 条证据</div>
          <div>{c.text}</div>
          {c.evidences.map((ev) => (
            <div key={ev.id} className={`rd-evid rd-${ev.source}`} style={{ marginTop: 6 }}>
              <span className={`rd-evidTag rd-${ev.source}`}>{ev.source === 'paper' ? '论文报告值' : '本地观察'}</span>
              {ev.label} · {ev.locator}
              {ev.value === null ? ' · 值：unknown' : ` · 值：${ev.value}${ev.unit !== null ? ` ${ev.unit}` : ''}`}
            </div>
          ))}
        </div>
      ))}
    </Modal>
  );
}

function CiteExperimentModal(props: { paper: PaperView; experiments: ExperimentView[]; onClose: () => void }): JSX.Element {
  const { emit, snapshot } = useWorkbench();
  const action = useAsyncAction();
  const [target, setTarget] = useState<string>('');
  const available = props.experiments.filter((e) => e.status !== 'planned');

  async function submit(): Promise<void> {
    if (target === '') return;
    const ok = await action.run(async () => {
      const out = await emit({
        type: 'attach_citation',
        taskKey: snapshot.task.taskKey,
        paperKey: props.paper.paperKey,
        contributionId: null,
        experimentKey: target,
      });
      return out;
    });
    if (ok) props.onClose();
  }

  return (
    <Modal title={`引用到实验：${props.paper.metadata.title}`} onClose={props.onClose}
      footer={
        <>
          <button className="rd-btn" onClick={props.onClose} disabled={action.pending}>取消</button>
          <button className="rd-btn rd-btn-primary" disabled={action.pending || target === ''} onClick={submit}>
            {action.pending ? '提交中…' : '提交引用（演示）'}
          </button>
        </>
      }>
      <div className="rd-staleBanner">
        <Icon name="link" size={13} />
        提交只发送 attach_citation 事件并在本地新增引用关系，不创建或运行实验。
      </div>
      {available.length === 0 ? (
        <div className="rd-emptyHint">当前没有可选的实验（计划中的实验不可被引用）。</div>
      ) : (
        <div className="rd-field">
          <label>选择目标实验</label>
          <select className="rd-select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="" disabled>选择实验…</option>
            {available.map((e) => (
              <option key={e.experimentKey} value={e.experimentKey}>
                {e.label}（{EXPERIMENT_STATUS_META[e.status].label}{e.combination ? '·组合' : '·单模块'}）
              </option>
            ))}
          </select>
        </div>
      )}
      {action.error !== null && <div className="rd-reject">{action.error}</div>}
    </Modal>
  );
}

function SourceModal(props: { paper: PaperView; onClose: () => void }): JSX.Element {
  const p = props.paper;
  return (
    <Modal title="打开原文" onClose={props.onClose}
      footer={<button className="rd-btn rd-btn-primary" onClick={props.onClose}>关闭</button>}>
      {p.metadata.localSource !== null ? (
        <>
          <div className="rd-staleBanner">
            <Icon name="doc" size={14} />
            演示优先使用本地样例来源（阅读器由接线阶段提供）：
          </div>
          <div className="rd-section">{p.metadata.localSource}</div>
        </>
      ) : p.metadata.url !== null ? (
        <div className="rd-section">
          <a href={p.metadata.url} target="_blank" rel="noreferrer" style={{ color: 'var(--rd-blue)' }}>{p.metadata.url.startsWith('/evolver/paper-library') ? '下载已上传的原文' : p.metadata.url} ↗</a>
        </div>
      ) : (
        <div className="rd-reject">来源未提供可打开的原文链接。</div>
      )}
    </Modal>
  );
}
