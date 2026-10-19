import type { ResearchCycleData } from '../integration/research-cycle-view.ts';
import { useEffect, useRef, useState, Fragment, type ReactNode, type FormEvent } from 'react';
import type { BootstrapReadPayload } from '../integration/research-bootstrap-view.ts';
import type { GeneralMethod, GeneralNode } from '../../../../evolver/src/contracts/general-research.ts';
import type { DataField, DatasetVersion, MaterialNature, GeneralDataPreview } from '../../../../evolver/src/contracts/general-data.ts';
import { GENERAL_SHELL_CSS, GENERAL_LEGACY_CSS } from './styles.ts';
import { newOperationId } from '../redesign/research-actions.ts';
import { KnowledgePanel } from './WikiWorkspace.tsx';
import { GeneralTreePanel } from './GeneralTreePanel.tsx';
import { GeneralAgentPanel } from './GeneralAgentPanel.tsx';
import { SchedulePanel } from './SchedulePanel.tsx';
import { AnalysisResults } from './AnalysisResults.tsx';
import { MetricsPanel } from './MetricsPanel.tsx';
import { InferencePanel } from './InferencePanel.tsx';
import { FactPackPanel } from './report-core/FactPackPanel.tsx';
import { PackagePanel } from './PackagePanel.tsx';
import { SourceAccessPanel } from './SourceAccessPanel.tsx';
import { TakeoverPanel } from './TakeoverPanel.tsx';

type Preview = GeneralDataPreview;
type Page = 'home' | 'start' | 'tree' | 'agent' | 'wiki';
const PAGE_TITLES: Record<Page, string> = { home: '工作台概览', start: '新研究初始化', tree: '研究实验树', agent: 'Agent 协作', wiki: 'LLM Wiki' };
const NAV_GROUPS: Array<{ title: string; items: Array<{ key: Page; icon: string; micro?: string }> }> = [
  { title: 'WORKSPACE', items: [{ key: 'home', icon: '◫' }, { key: 'start', icon: '⊕' }] },
  { title: 'RESEARCH PIPELINE', items: [{ key: 'tree', icon: '⑂', micro: 'GRAPH' }, { key: 'agent', icon: '▦' }] },
  { title: 'KNOWLEDGE', items: [{ key: 'wiki', icon: '⌘', micro: 'NEW' }] },
];
const METHODS: Record<GeneralMethod, string> = { engineering: '工程试验', observation: '理科观测 / 已有计算', algorithm: '算法与系统', survey: '实证与问卷', review: '文献综述' };
const NATURES: Record<MaterialNature, string> = { literature: '文献报告', user_observation: '用户实测记录', user_result: '用户已有结果', simulation: '明确模拟', hypothesis: '假设', inference: '推断', unknown: '未知' };
const ROLES: Record<DataField['role'], string> = { variable: '变量', outcome: '结果', sample: '试件 / 样本', group: '分组', time: '时间', repeat: '重复', condition: '条件', uncertainty: '不确定性', other: '待确认 / 其他' };
const TYPES: Record<DataField['type'], string> = { number: '数值', category: '分类', text: '文本', time: '时间' };
const display = (v: unknown) => v === null ? '∅' : String(v);
const op = () => newOperationId('general-ui');
const EXAMPLE_QUESTION = '在同一测量流程下，处理组与对照组的读数均值是否存在差异？（示例问题；种子数据为明确模拟）';

/** Production UI follows the 2026-10-15 HTML reference; backend receipts, not browser state, own facts. */
export function GeneralWorkbench(props: { initialPage?: Page; cycle?: ResearchCycleData | null; sessionId: string; read: BootstrapReadPayload | null; refresh: () => Promise<void>; legacy: ReactNode | ((page: Page) => ReactNode); sync?: { status: 'connecting' | 'live' | 'retrying' }; onResync?: () => void; workspace?: { title: string; papers: number } }): JSX.Element {
  const [page, setPage] = useState<Page>(props.initialPage??'home');
  const [sub, setSub] = useState<Record<Page, string>>({ home: '', start: 'entry', tree: 'flow', agent: 'team', wiki: 'knowledge' });
  const [visited, setVisited] = useState<Set<Page>>(() => new Set(['home',props.initialPage??'home']));
  const [menu, setMenu] = useState(false);
  const [modal, setModal] = useState<'create' | 'idea' | null>(null);
  const [busy, setBusy] = useState(false);
  const writePending = useRef(false);
  const failedOperation = useRef<{ key: string; operationId: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const dialog = useRef<HTMLDialogElement | null>(null);
  const createRef = useRef<HTMLButtonElement | null>(null);
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [includeRaw, setIncludeRaw] = useState(false);
  const [confirmationDraft, setConfirmationDraft] = useState<boolean | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [fields, setFields] = useState<DataField[]>([]);
  const [conditions, setConditions] = useState('');
  const [excludedRows, setExcludedRows] = useState('');
  const [reason, setReason] = useState('');
  const [dirty, setDirty] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [nature, setNature] = useState<MaterialNature>('unknown');
  const [wizardStepOverride, setWizardStepOverride] = useState<number | null>(null);
  const [ideaText, setIdeaText] = useState('');
  const [titleText, setTitleText] = useState('');
  const [planEditing, setPlanEditing] = useState(false);
  const [c1, setC1] = useState(false);
  const [c2, setC2] = useState(false);
  const [wFile, setWFile] = useState<File | null>(null);
  const [wNature, setWNature] = useState<MaterialNature>('unknown');
  const bootstrap = props.read?.bootstrap;
  const research = bootstrap?.researches.find(r => r.researchId === bootstrap.activeResearchId);
  const general = research?.general;
  const revision = bootstrap?.revision ?? 0;
  const nodeState = (id: string) => research?.workflow?.find(v => v.nodeId === id);
  const stateLabel = (id: string) => props.cycle?.effectiveGraph.nodes.find(n => n.nodeId === id && n.origin === 'cycle') ? (props.cycle.effectiveGraph.nodes.find(n => n.nodeId === id)?.artifactRef ? '已登记产物' : '未来任务（未执行）') : nodeState(id) ? ({ ready: '可开始', blocked: '前置阻塞', skipped: '未选分支', policy_ready: '自动流程放行', manual_confirmed: '人工已确认', output_ready: '产物就绪', reviewed: '已有审查' }[nodeState(id)!.status]) : '状态未提供';
  const confirmationSwitch = general && <label className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={confirmationDraft ?? general.requireHumanConfirmation} disabled={busy} onChange={e => { const next = e.currentTarget.checked; setConfirmationDraft(next); void action('save_general_profile', { researchId: research!.researchId, profile: { requireHumanConfirmation: next, title: research!.title, domains: general.domains, methods: general.methods, entryMode: general.entryMode, reference: general.reference, constraints: general.constraints, pendingQuestions: general.pendingQuestions, limits: general.limits } }).finally(() => setConfirmationDraft(null)); }} />需要人工确认</label>;
  const identity = research?.researchId ?? '';
  const revisionRef = useRef(0);
  // revision 单调递增：渲染值与回执值取 max，避免 setMessage 触发的旧 props 渲染
  // 把回执带来的更新版本打回去（否则同一事件里的连续动作会用旧 baseRevision 冲突）。
  revisionRef.current = Math.max(revisionRef.current, revision);
  const previewRequest = useRef(0);

  useEffect(() => { setPreview(null); setDirty(false); setConfirmationDraft(null); setSelected(''); setLegacyOpen(false); setVisited(new Set(['home', page])); previewRequest.current++; }, [identity]);
  // 向导本地状态只在「用户显式切换研究 / 打开示例 / 新建」时重置；向导自身 create 引起的
  // identity 变化不得清空 override（否则第 2 步会被竞态吞掉）。
  const resetWizard = () => { setWizardStepOverride(null); setPlanEditing(false); setC1(false); setC2(false); setWFile(null); setIdeaText(''); setTitleText(''); };
  useEffect(() => { if (modal) dialog.current?.showModal(); else if (dialog.current?.open) dialog.current.close(); }, [modal]);

  async function action(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (writePending.current) return null;
    writePending.current = true;
    const key = JSON.stringify({ type, payload });
    if (failedOperation.current?.key !== key) failedOperation.current = { key, operationId: op() };
    const operationId = failedOperation.current.operationId;
    setBusy(true); setError(''); setMessage('正在保存，尚未取得后端回执…');
    try {
      const response = await fetch(`/evolver/research-bootstrap/actions?sessionId=${encodeURIComponent(props.sessionId)}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, baseRevision: revisionRef.current, operationId, ...payload }) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.reason ?? body.message ?? body.error ?? `HTTP ${response.status}`);
      revisionRef.current = typeof body.revision === 'number' ? Math.max(revisionRef.current, body.revision) : revisionRef.current;
      setMessage(body.message ?? '已保存');
      await props.refresh();
      failedOperation.current = null;
      return body;
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setMessage('未保存 · 草稿仍保留；请重新同步后核对版本再提交。'); return null; }
    finally { writePending.current = false; setBusy(false); }
  }
  async function exportResearch(format: 'json' | 'markdown') {
    if (!identity || busy) return; setError('');
    try { const response = await fetch(`/evolver/research-bootstrap/export?sessionId=${encodeURIComponent(props.sessionId)}&researchId=${encodeURIComponent(identity)}&includeRaw=${includeRaw}`, { credentials: 'same-origin' }); const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); const blob = new Blob([format === 'markdown' ? body.markdown : JSON.stringify(body, null, 2)], { type: format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `research-${identity}.${format === 'markdown' ? 'md' : 'json'}`; a.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage('研究包已导出，来源性质和未知项保留。'); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }
  const go = (next: Page) => { setVisited(current => new Set([...current, next])); setPage(next); setMenu(false); };
  const setSubview = (target: Page, view: string) => { setSub(current => ({ ...current, [target]: view })); };
  const inspect = (nodeId: string) => { setSelected(nodeId); setSubview('tree', 'flow'); go('tree'); };
  const loadPreview = async (datasetId?: string, sourceId?: string, offset = 0, version?: number, resetDraft = false) => {
    const request = ++previewRequest.current;
    setPreviewLoading(true); setError('');
    try {
      const query = new URLSearchParams({ sessionId: props.sessionId, researchId: identity, offset: String(offset) });
      if (datasetId) query.set('datasetId', datasetId);
      if (sourceId) query.set('sourceId', sourceId);
      if (version !== undefined) query.set('version', String(version));
      const response = await fetch(`/evolver/research-bootstrap/data?${query}`, { credentials: 'same-origin' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error);
      if (request !== previewRequest.current) return;
      const p = body.preview as Preview;
      setPreview(p);
      if (resetDraft || !dirty || preview?.dataset?.datasetId !== p.dataset?.datasetId || preview?.dataset?.version !== p.dataset?.version) {
        setFields(p.dataset?.fields ?? []); setConditions(JSON.stringify(p.dataset?.conditions ?? [], null, 2));
        setExcludedRows((p.dataset?.excludedRows ?? []).join(', ')); setReason(p.dataset?.processingReason ?? ''); setDirty(false);
      }
    } catch (failure) { if (request === previewRequest.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (request === previewRequest.current) setPreviewLoading(false); }
  };
  const choosePreview = (datasetId?: string, sourceId?: string, version?: number) => {
    if (dirty && general?.requireHumanConfirmation && !window.confirm('当前数据字典有未保存编辑。切换后将丢弃这些编辑，是否继续？')) return;
    setDirty(false); void loadPreview(datasetId, sourceId, 0, version, true);
  };
  async function upload(event: FormEvent) {
    event.preventDefault(); if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setError('单文件最大 10 MiB，请分批；不会截断。'); return; }
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const saved = await action('import_general_material', { researchId: identity, filename: file.name, mediaType: file.type || 'application/octet-stream', contentBase64: btoa(binary), nature, description: String(values.get('description') ?? ''), purpose: String(values.get('purpose') ?? '') });
      if (saved) { setFile(null); form.reset(); const ids = saved.datasetIds as string[]; choosePreview(ids?.[0], saved.sourceId as string); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function saveDictionary(event: FormEvent) {
    event.preventDefault(); if (!preview?.dataset) return;
    try {
      const conditionsValue = JSON.parse(conditions) as DatasetVersion['conditions'];
      const rows = excludedRows.trim() ? excludedRows.split(',').map(r => Number(r.trim())) : [];
      const saved = await action('save_general_dictionary', { researchId: identity, datasetId: preview.dataset.datasetId, fields, conditions: conditionsValue, excludedRows: rows, processingReason: reason });
      if (saved) { setDirty(false); await loadPreview(preview.dataset.datasetId, undefined, 0, saved.version as number); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  const updateField = (column: number, patch: Partial<DataField>) => { setFields(current => current.map(f => f.column === column ? { ...f, ...patch } : f)); setDirty(true); };
  const derived = props.cycle?.effectiveGraph.nodes.filter(n => n.origin === 'cycle' && !general?.graph.nodes.some(b => b.nodeId === n.nodeId)) ?? [];
  const derivedNodes: GeneralNode[] = derived.map(n => ({ nodeId: n.nodeId, title: n.title, kind: n.kind === 'experiment_plan' ? 'protocol' : n.kind === 'evidence_report' ? 'analysis' : n.kind === 'decision' ? 'decision' : 'manual', goal: n.title, inputs: [], method: n.summary ?? '来自已保存的研究循环增量', output: n.artifactRef ? '真实已登记产物' : '未来工作（未执行）', completionCriterion: '来源与实际产物可检查', join: 'all', execution: 'not_started' }));
  const nodes = [...(general?.graph.nodes ?? []), ...derivedNodes];
  const selectedNode = nodes.find(n => n.nodeId === selected) ?? nodes[0];
  /** 队列动作走 research-cycle 桥：提交前重读双 revision（bootstrap CAS + cycle revision）。仅创建/停止；运行需 SchedulePanel 显式授权。 */
  async function cycleAction(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (writePending.current) return null;
    writePending.current = true;
    setBusy(true); setError(''); setMessage('正在提交队列动作，尚未取得回执…');
    try {
      const query = `sessionId=${encodeURIComponent(props.sessionId)}&researchId=${encodeURIComponent(identity)}`;
      const [cycleResponse, bootstrapResponse] = await Promise.all([
        fetch(`/evolver/research-cycle?${query}`, { credentials: 'same-origin' }),
        fetch(`/evolver/research-bootstrap?sessionId=${encodeURIComponent(props.sessionId)}`, { credentials: 'same-origin' }),
      ]);
      const cycle = await cycleResponse.json(); if (!cycleResponse.ok) throw new Error(cycle.message ?? cycle.error);
      const bootstrap = await bootstrapResponse.json(); if (!bootstrapResponse.ok) throw new Error(bootstrap.message ?? bootstrap.error);
      const response = await fetch(`/evolver/research-cycle/actions?sessionId=${encodeURIComponent(props.sessionId)}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type, operationId: op(), researchId: identity, baseRevision: bootstrap.bootstrap.revision, cycleRevision: cycle.research.cycleRevision, ...payload }) });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.reason ?? body.message ?? body.error ?? `HTTP ${response.status}`);
      setMessage(body.message ?? '队列动作已登记'); await props.refresh();
      return body;
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); setMessage('未执行 · 请核对版本后重试。'); return null; }
    finally { writePending.current = false; setBusy(false); }
  }
  const latestDatasets = general?.datasets.filter(d => !general.datasets.some(other => other.datasetId === d.datasetId && other.version > d.version)) ?? [];
  const sources = general?.sources ?? [];
  const head = (title: string, description: string, actions?: ReactNode) => <div className="page-head"><div><h1>{title}</h1><p>{description}</p></div><div className="flex">{actions}</div></div>;
  const syncChip = <span className={`demo${props.sync?.status === 'retrying' ? ' warn' : ''}`} role="status">{props.sync?.status === 'live' ? '已同步 · 文件变化自动刷新' : props.sync?.status === 'retrying' ? '同步重试中 · 定期重读已启用' : '正在连接状态同步…'}</span>;

  // ===== 概览（参考 index.html home；无研究时显示三入口开始页） =====
  function overview() {
    if (!research) {
      return <div className="home active">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 26 }}>
          <div className="hint">YOUR RESEARCH ENVIRONMENT</div>
          <h1>把研究的每一步，变成可追溯的证据。</h1>
          <p>当前还没有活动研究。选择一种方式开始：可以从研究问题出发，导入已有研究包，或用明确标识的模拟示例了解流程。</p>
        </div>
        {entries()}
        <TakeoverPanel sessionId={props.sessionId} action={action} busy={busy} refresh={props.refresh} />
        <div className="bottom-note"><b>关于当前状态：</b>后端持久工作区已就绪；查看和上传不会启动运行，任何执行都需要显式授权。运行与审查分别记录，任务完成不等于科研结论成立。</div>
      </div>;
    }
    const nextActions = [...(research?.analysis?.nextActions ?? []), ...(props.cycle?.decisions.at(-1)?.nextActions ?? []).map(a => ({ kind: 'followup' as const, label: a.title, reason: `Reviewer 已保存的建议：${a.detail}；未自动执行，不代表科研验证。`, nodeId: props.cycle?.steps[0]?.nodeId ?? general!.graph.nodes[0]?.nodeId ?? '', page: 'flow' as const }))];
    const next = nextActions[0]?.label ?? (sources.length === 0 ? '资料与数据整理' : '确认数据字典、条件与分析协议');
    return <div className="home active">
      <div className="hint">YOUR RESEARCH ENVIRONMENT</div>
      <h1>把研究的每一步，变成可追溯的证据。</h1>
      <p>当前研究「{research!.title}」。从研究问题出发，执行可审计的实验分支、协作审查与知识整合。</p>
      <div className="hero"><div><div className="tinyprint" style={{ color: '#a6cac0' }}>CURRENT / NEXT STEP</div><h2>当前推进点：{next}</h2><p>{nextActions[0]?.reason ?? '根据当前登记材料推荐；规划不等于已执行，数据 hash 检查不等于假设成立。'}</p></div><button className="primary" onClick={() => { const target = nextActions[0]; if (target?.page === 'data') { setSubview('wiki', 'data'); go('wiki'); } else if (target?.page === 'results') { setSubview('agent', 'results'); go('agent'); } else inspect(target?.nodeId || general!.graph.nodes[0]?.nodeId || ''); }}>定位下一步 →</button></div>
      <div className="tiles">{([['start', '⊕', '新研究初始化', '从研究想法到方法草案、人工确认、资料补充和明确的运行授权。', '进入研究初始化 →'], ['tree', '⑂', '研究实验树', '查看候选谱系、Top-K 策略、成功门槛、父方案差异和实验预算。', '探索实验分支 →'], ['agent', '▦', 'Agent 协作', '确认方法和资料边界；配置建议任务队列、审批与执行流程。', '打开 Agent 工作流 →'], ['wiki', '⌘', 'LLM Wiki', '知识图谱、实体关系、资料管理与引用定位。', '打开知识图谱 →']] as Array<[Page, string, string, string, string]>).map(([key, icon, title, desc, cta]) => <button className="tile" key={key} onClick={() => go(key)}><span className="tile-icon" aria-hidden="true">{icon}</span><strong>{title}</strong><p>{desc}</p><small>{cta}</small></button>)}</div>
      <div className="home-grid">
        <section className="card"><div className="card-head"><h2>研究执行路径</h2><button className="link" onClick={() => go('tree')}>详细流程 →</button></div><div className="card-body">{nodes.map((n, i) => <div className="path-row" key={n.nodeId}><span className="step-dot">{i + 1}</span><div><button className="link" onClick={() => inspect(n.nodeId)}>{n.title}</button> <span className="badge">{stateLabel(n.nodeId)}</span><p className="small muted">{n.method}</p></div></div>)}</div></section>
        <div className="stack">
          <section className="card"><div className="card-head"><h2>接下来做什么</h2></div><div className="card-body stack">{nextActions.length ? nextActions.map((a, i) => <div key={`${a.nodeId}-${a.kind}-${i}`}><button className="link" onClick={() => { setSelected(a.nodeId); if (a.page === 'data') { setSubview('wiki', 'data'); go('wiki'); } else if (a.page === 'results') { setSubview('agent', 'results'); go('agent'); } else { setSubview('tree', 'flow'); go('tree'); } }}>{a.label}</button><p className="small muted">{a.reason}</p></div>) : <button className="link" onClick={() => { setSubview('wiki', 'data'); go('wiki'); }}>{sources.length ? '确认字段 / 单位 / 条件' : '导入已有资料和实验数据'}</button>}<p className="small muted">未知保持未知，缺条件的比较或计算不隐式执行。</p>{general!.pendingQuestions.map(q => <p key={q} className="small muted">{q}</p>)}</div></section>
          <section className="card"><div className="card-head"><h2>研究契约</h2>{confirmationSwitch}</div><div className="card-body stack"><p>{general!.ideas[0]?.question}</p><p className="small muted">领域：{general!.domains.join('、') || '未确定'}<br />方法：{general!.methods.map(m => METHODS[m]).join('、') || '未确定'}<br />参照：{general!.reference.status === 'unknown' ? '未知，可后续明确不适用及理由' : general!.reference.description}<br />运行边界：最多 {general!.limits.maxAttempts} 次尝试 / {general!.limits.maxRounds} 轮；查看和上传不启动运行。</p></div></section>
          <section className="card"><div className="card-head"><h2>研究成果与导出</h2></div><div className="card-body stack"><div className="flex"><label className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={includeRaw} onChange={e => setIncludeRaw(e.target.checked)} />导出含原始文件</label><button disabled={busy} onClick={() => void exportResearch('json')}>导出 JSON</button><button disabled={busy} onClick={() => void exportResearch('markdown')}>导出报告</button></div><div className="flex"><button className="link" onClick={() => { setSubview('tree', 'metrics'); go('tree'); }}>指标与比较 →</button><button className="link" onClick={() => { setSubview('wiki', 'reports'); go('wiki'); }}>报告事实包 →</button><button className="link" onClick={() => { setSub(current => ({ ...current, start: 'import' })); go('start'); }}>研究包 / 导入恢复 →</button></div><button className="link" onClick={() => setLegacyOpen(v => !v)}>{legacyOpen ? '收起历史功能' : '打开历史论文 / 算法功能'}</button></div></section>
        </div>
      </div>
      {legacyOpen && <div style={{ height: 700, marginTop: 20 }}>{typeof props.legacy === 'function' ? props.legacy(page) : props.legacy}</div>}
      <TakeoverPanel sessionId={props.sessionId} action={action} busy={busy} refresh={props.refresh} />
      <div className="bottom-note"><b>关于当前状态：</b>后端持久工作区；真实模型运行、已有文献证据、模拟数据和真实实验观察分别标记。规划与审查分别记录，执行成功不代表假设成立。</div>
    </div>;
  }

  // ===== 新研究初始化（六步向导，参考 start.html；所有动作为真实回执驱动） =====
  const goalNode = general?.graph.nodes.find(n => n.kind === 'goal') ?? null;
  const goalConfirmation = goalNode ? [...(general?.nodeConfirmations ?? [])].reverse().find(c => c.nodeId === goalNode.nodeId) ?? null : null;
  const goalConfirmedCurrent = !!(goalConfirmation && general && goalConfirmation.profileRevision === general.profileRevision && (!goalConfirmation.idea || !general.ideas[0] || goalConfirmation.idea.revision === general.ideas[0].revision));
  const derivedWizardStep = !research ? 1 : goalConfirmedCurrent ? (general && general.sources.length > 0 ? 5 : 4) : 3;
  const wizardStep = wizardStepOverride ?? derivedWizardStep;
  function entries() {
    return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(300px,100%),1fr))', gap: 20 }}>
      <section className="card" style={{ background: '#10393C', color: '#F2F4F3', borderRadius: 20, padding: 32, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <svg width="36" height="36" viewBox="0 0 32 32" fill="none" stroke="#A9E0DA" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 4h11l6 6v18H8z" /><path d="M19 4v6h6M16.5 15v8M12.5 19h8" /></svg>
        <h2 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 26 }}>开始新研究</h2>
        <p style={{ color: '#D3E4E2' }}>从一个研究问题或想法开始，生成可编辑的研究计划。</p>
        <button className="btn btn-light" style={{ alignSelf: 'flex-start', marginTop: 'auto' }} onClick={() => { setSub(current => ({ ...current, start: 'new' })); setWizardStepOverride(research ? null : 1); if (page !== 'start') go('start'); }}>开始新研究</button>
      </section>
      <section className="card" style={{ borderRadius: 20, padding: 32, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <svg width="36" height="36" viewBox="0 0 32 32" fill="none" stroke="#14575C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M16 5v14M10 13l6 6 6-6M5 22v5h22v-5" /></svg>
        <h2 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 26, color: '#14211F' }}>导入已有研究</h2>
        <p style={{ color: '#2E3B38' }}>导入研究包，并重新核对历史任务和授权。</p>
        <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', marginTop: 'auto' }} onClick={() => { setSub(current => ({ ...current, start: 'import' })); if (page !== 'start') go('start'); }}>导入研究包</button>
      </section>
      <section className="card" style={{ borderRadius: 20, padding: 32, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <svg width="36" height="36" viewBox="0 0 32 32" fill="none" stroke="#14575C" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4h8M14 4v8l-7 13a2 2 0 002 3h14a2 2 0 002-3L18 12V4M10 20h12" /></svg>
        <h2 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 26, color: '#14211F' }}>体验示例研究</h2>
        <p style={{ color: '#2E3B38' }}>使用明确标识的模拟资料了解研究流程，不会产生真实科研结论，也不会写入当前研究。</p>
        <button className="btn btn-ghost" style={{ alignSelf: 'flex-start', marginTop: 'auto' }} disabled={busy || !bootstrap} onClick={() => void action('create_general_example_research', {}).then(saved => { if (saved) { resetWizard(); go('home'); } })}>打开示例</button>
      </section>
    </div>;
  }
  const WIZARD_LABELS: Array<[string, string]> = [['输入 Idea', '一句话即可'], ['生成计划草稿', 'AI 草稿，可编辑'], ['人工确认目标', '需要你确认'], ['补充资料', '可跳过'], ['确认方案及运行授权', '显式授权'], ['查看分析结果', '']];
  async function wizardCreate() {
    const question = ideaText.trim(); if (!question) return;
    const title = titleText.trim() || `通用研究草稿 · ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`;
    const saved = await action('create_general_research', { title, question, domains: [], methods: ['observation'], entryMode: 'idea_only' });
    if (saved) { setWizardStepOverride(2); }
  }
  async function wizardConfirmGoal() {
    if (!goalNode) return;
    const saved = await action('confirm_general_manual_node', { researchId: identity, nodeId: goalNode.nodeId, sourceRefs: [], reason: '六步向导：人工确认研究问题范围与运行边界' });
    if (saved) { setC1(false); setC2(false); setWizardStepOverride(4); }
  }
  async function wizardSavePlan() {
    const idea = general?.ideas[0]; if (!idea) return;
    const saved = await action('save_general_idea', { researchId: identity, ideaId: idea.ideaId, question: idea.question, rationale: idea.rationale, verificationPlan: idea.verificationPlan, sourceRefs: idea.sourceRefs });
    if (saved) setWizardStepOverride(6);
  }
  async function wizardUpload(event: FormEvent) {
    event.preventDefault(); if (!wFile || !identity) return;
    if (wFile.size > 10 * 1024 * 1024) { setError('单文件最大 10 MiB，请分批；不会截断。'); return; }
    const form = event.currentTarget as HTMLFormElement;
    const values = new FormData(form);
    try {
      const bytes = new Uint8Array(await wFile.arrayBuffer());
      let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const saved = await action('import_general_material', { researchId: identity, filename: wFile.name, mediaType: wFile.type || 'application/octet-stream', contentBase64: btoa(binary), nature: wNature, description: String(values.get('description') ?? ''), purpose: String(values.get('purpose') ?? '') });
      if (saved) { setWFile(null); form.reset(); }
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
  }
  async function wizardRunLatestPlan() {
    const plan = general?.plans.at(-1); if (!plan) return;
    const saved = await action('calculate_general_descriptive', { researchId: identity, planId: plan.planId, planVersion: plan.version, authorize: true });
    if (saved) setWizardStepOverride(6);
  }
  function startPage() {
    const isEntry = sub.start === 'entry', isImport = sub.start === 'import', isNew = sub.start === 'new';
    const latestRun = research?.brainstormRuns.at(-1) ?? null;
    const runIdeas = latestRun ? (bootstrap?.researches.find(r => r.researchId === identity)?.ideas ?? []).filter(i => latestRun.ideaIds.includes(i.ideaId)) : [];
    const idea = general?.ideas[0] ?? null;
    const stepDefs = WIZARD_LABELS.map(([label, note], i) => {
      const n = i + 1, state = n < wizardStep ? 'done' : n === wizardStep ? 'current' : 'todo';
      return { n, label, note, state, done: state === 'done', notDone: state !== 'done', ariaCurrent: (state === 'current' ? 'step' : 'false') as 'step' | 'false' };
    });
    const draftRows = [
      { k: '研究问题', v: idea?.question?.trim() || '待输入', dim: 'false' },
      { k: '比较对象', v: '待确认（在确认方案时明确）', dim: 'true' },
      { k: '结果指标', v: '待确认（在确认方案时明确）', dim: 'true' },
      { k: '分析方法', v: idea?.verificationPlan?.trim() || '未确定（将在确认方案时给出建议）', dim: idea?.verificationPlan?.trim() ? 'false' : 'true' },
      { k: '运行边界', v: general ? `最多 ${general.limits.maxAttempts} 次尝试 / ${general.limits.maxRounds} 轮；查看和上传不启动运行` : '待研究创建后显示', dim: 'false' },
    ];
    const latestPlan = general?.plans.at(-1) ?? null;
    const latestCalculation = general?.calculations.at(-1) ?? null;
    const confirmStale = goalConfirmation && general && (goalConfirmation.profileRevision !== general.profileRevision || (goalConfirmation.idea && general.ideas[0] && goalConfirmation.idea.revision !== general.ideas[0].revision));
    return <div className="page">
      {isEntry && <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <h1 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 44, lineHeight: 1.2 }}>开始使用 DSH Research</h1>
          <p style={{ fontSize: 18, color: '#2E3B38', maxWidth: '52ch' }}>选择一种方式开始。你可以之后再添加数据、调整研究方法。</p>
        </div>
        {entries()}
        <p style={{ fontSize: 13, color: '#566460' }}>无论选哪一种，查看和上传都不会启动运行；任何执行都需要你在之后显式授权。</p>
      </div>}
      {isImport && <div className="fade" style={{ maxWidth: 680 }}>
        <button className="btn-text" onClick={() => setSub(current => ({ ...current, start: 'entry' }))}>← 返回</button>
        <div style={{ marginTop: 10 }}>{head('导入已有研究', '完整包含原始材料、解析数据和历史产物。导入会创建一个新研究；旧授权、完成状态和运行任务需要重新核对。')}</div>
        <PackagePanel key={identity} action={action} sessionId={props.sessionId} researchId={identity} general={general} revision={revision} busy={busy} setBusy={setBusy} refresh={props.refresh} />
      </div>}
      {isNew && <div className="fade" style={{ display: 'flex', flexWrap: 'wrap', gap: 40, alignItems: 'flex-start' }}>
        <nav aria-label="新研究步骤" style={{ flex: '1 1 240px', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: 20 }}>
          <button className="btn-text" style={{ alignSelf: 'flex-start' }} onClick={() => { setSub(current => ({ ...current, start: 'entry' })); setWizardStepOverride(null); }}>← 返回</button>
          <ol>{stepDefs.map(s => <li className="vs" data-s={s.state} aria-current={s.ariaCurrent} key={s.n}><span className="dot">{s.done ? <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" /></svg> : s.n}</span><span><b>{s.label}</b><small>{s.note}</small></span></li>)}</ol>
        </nav>
        <section className="card" style={{ flex: '999 1 460px', minWidth: 0, padding: '36px 40px', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {wizardStep === 1 && <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h1 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 30, lineHeight: 1.25 }}>从一个研究问题或想法开始</h1>
            <p style={{ color: '#2E3B38' }}>一句话就可以。之后会生成一份可编辑的计划草稿，你确认之前不会有任何东西被执行。</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label htmlFor="gw-wizard-idea" style={{ fontWeight: 600 }}>你的研究想法</label>
              <textarea id="gw-wizard-idea" className="field" rows={4} value={ideaText} onChange={e => setIdeaText(e.target.value)} placeholder="例如：LLM 辅助阅读是否会改变理解测验成绩？" />
              <label htmlFor="gw-wizard-title" style={{ fontWeight: 600 }}>研究名称（可留空，自动生成）</label>
              <input id="gw-wizard-title" className="field" style={{ fontSize: 15 }} value={titleText} onChange={e => setTitleText(e.target.value)} maxLength={300} placeholder="留空自动生成" />
              <div><button className="btn-text" onClick={() => setIdeaText(EXAMPLE_QUESTION)}>填入示例想法</button></div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <button className="btn btn-primary" disabled={!ideaText.trim() || busy || !bootstrap} onClick={() => void wizardCreate()}>生成计划草稿</button>
            </div>
          </div>}
          {wizardStep === 2 && <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 30, lineHeight: 1.25 }}>研究计划草稿</h1>
              <span className="chip chip-warn">{planEditing ? '人工编辑中 · 尚未保存' : 'AI 草稿 · 尚未确认'}</span>
            </div>
            {planEditing && idea ? <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label htmlFor="gw-draft-question" style={{ fontWeight: 600 }}>研究问题</label>
              <textarea id="gw-draft-question" className="field" style={{ fontSize: 15 }} rows={3} defaultValue={idea.question} key={`${identity}-q`} />
              <label htmlFor="gw-draft-rationale" style={{ fontWeight: 600 }}>理由 / 依据（可空）</label>
              <textarea id="gw-draft-rationale" className="field" style={{ fontSize: 15 }} rows={2} defaultValue={idea.rationale} />
              <label htmlFor="gw-draft-plan" style={{ fontWeight: 600 }}>分析方法 / 可验证方式（可空）</label>
              <textarea id="gw-draft-plan" className="field" style={{ fontSize: 15 }} rows={3} defaultValue={idea.verificationPlan} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => {
                  const q = (document.getElementById('gw-draft-question') as HTMLTextAreaElement | null)?.value ?? idea.question;
                  const rationale = (document.getElementById('gw-draft-rationale') as HTMLTextAreaElement | null)?.value ?? '';
                  const plan = (document.getElementById('gw-draft-plan') as HTMLTextAreaElement | null)?.value ?? '';
                  void action('save_general_idea', { researchId: identity, ideaId: idea.ideaId, question: q, rationale, verificationPlan: plan, sourceRefs: idea.sourceRefs }).then(saved => { if (saved) setPlanEditing(false); });
                }}>保存人工草稿</button>
                <button className="btn btn-ghost" onClick={() => setPlanEditing(false)}>放弃编辑</button>
              </div>
            </div> : <dl style={{ display: 'grid', gridTemplateColumns: '96px minmax(0,1fr)', gap: 0, columnGap: 20, fontSize: 15 }}>
              {draftRows.map(d => <Fragment key={d.k}><dt style={{ color: '#566460', padding: '14px 0', borderTop: '1px solid #E4E9E7' }}>{d.k}</dt><dd data-dim={d.dim} style={{ padding: '14px 0', borderTop: '1px solid #E4E9E7' }}>{d.v}</dd></Fragment>)}
            </dl>}
            <p style={{ fontSize: 14, color: '#566460' }}>草稿只是建议。想改研究问题，可返回上一步修改想法后重新生成；人工计划始终可编辑保存。</p>
            {latestRun && <div style={{ border: '1px solid #E4E9E7', borderRadius: 12, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="flex between"><strong style={{ fontWeight: 600 }}>AI 生成状态</strong><span className={`chip ${latestRun.error ? 'chip-danger' : latestRun.status === 'completed' ? 'chip-done' : 'chip-warn'}`}>{latestRun.status === 'completed' ? '已完成' : latestRun.status === 'failed' || latestRun.error ? '失败' : latestRun.status === 'interrupted' ? '已中断' : '排队 / 运行中'}</span></div>
              <span className="small" style={{ color: '#566460' }}>{latestRun.error ? `首错 ${latestRun.error.code}：${latestRun.error.message}` : latestRun.emptyResultReason ?? (latestRun.status === 'completed' ? `已发布 ${latestRun.ideaIds.length} 个候选（重复 ${latestRun.duplicates.length} 项）。` : '已请求生成；完成后候选将出现在下方，此处不会伪造成功。')}</span>
              {latestRun.itemErrors.map(ie => <span key={ie.label} className="small" style={{ color: '#8E2A1E' }}>候选 {ie.label}：{ie.code} {ie.message}</span>)}
            </div>}
            {runIdeas.length > 0 && <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <strong style={{ fontWeight: 600 }}>AI 候选（采纳前不会改变研究）</strong>
              {runIdeas.map(ci => <div key={ci.ideaId} style={{ border: '1px solid #E4E9E7', borderRadius: 12, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                <span className="small" style={{ color: '#2E3B38' }}>{ci.hypothesis}</span>
                <span className="small" style={{ color: '#566460' }}>{ci.rationale ?? '理由未提供'}{ci.exploratoryNote ? ` · ${ci.exploratoryNote}` : ''}</span>
                <div><button className="btn btn-ghost" disabled={busy} onClick={() => idea && void action('save_general_idea', { researchId: identity, ideaId: idea.ideaId, question: ci.hypothesis, rationale: ci.rationale ?? '', verificationPlan: ci.exploratoryNote ? `候选：${ci.title}；${ci.exploratoryNote}` : `候选：${ci.title}`, sourceRefs: [] }).then(saved => { if (saved) setWizardStepOverride(3); })}>采纳为研究计划</button></div>
              </div>)}
            </div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <button className="btn btn-ghost" onClick={() => { setWizardStepOverride(1); }}>上一步</button>
              {idea && <button className="btn btn-ghost" disabled={busy} onClick={() => setPlanEditing(true)}>人工编辑草稿</button>}
              {idea && <button className="btn btn-ghost" disabled={busy || !bootstrap} onClick={() => void action('generate_brainstorm', { researchId: identity })}>请求 AI 生成候选</button>}
              <button className="btn btn-primary" disabled={!idea || busy} onClick={() => setWizardStepOverride(3)}>继续：确认目标</button>
            </div>
          </div>}
          {wizardStep === 3 && <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h1 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 30, lineHeight: 1.25 }}>人工确认研究目标</h1>
            <p style={{ color: '#2E3B38' }}>这一步由你来确认。确认会被记录为人工确认（含研究快照与版本），Idea 或契约变更后自动失效，不能靠回退步骤恢复。</p>
            {goalConfirmation && <div className="flex"><span className={`chip ${confirmStale ? 'chip-warn' : 'chip-done'}`}>{confirmStale ? '旧确认已失效' : '已有当前有效确认'}</span><span className="small" style={{ color: '#566460' }}>{confirmStale ? 'Idea 或研究契约在确认后发生了变化；请重新确认。' : goalConfirmation.reason}</span></div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label className="chk"><input type="checkbox" checked={c1} onChange={e => setC1(e.target.checked)} /><span>我确认草稿中的<b style={{ fontWeight: 600 }}>研究问题与范围</b>。</span></label>
              <label className="chk"><input type="checkbox" checked={c2} onChange={e => setC2(e.target.checked)} /><span>我了解<b style={{ fontWeight: 600 }}>运行边界</b>：{general ? `最多 ${general.limits.maxAttempts} 次尝试 / ${general.limits.maxRounds} 轮` : '见研究契约'}；查看和上传不会启动运行。</span></label>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <button className="btn btn-ghost" onClick={() => setWizardStepOverride(2)}>上一步</button>
              <button className="btn btn-primary" disabled={!(c1 && c2) || busy || !goalNode} onClick={() => void wizardConfirmGoal()}>确认目标并继续</button>
            </div>
          </div>}
          {wizardStep === 4 && <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
              <h1 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 30, lineHeight: 1.25 }}>补充资料</h1>
              <span className="chip chip-block">可跳过</span>
            </div>
            <p style={{ color: '#2E3B38' }}>支持 CSV / XLSX / JSON 表格，其他格式仅作附件。单文件 ≤ 10 MiB，每表 ≤ 50000 行 / 200 列。上传不会执行宏、公式或附件指令。</p>
            {sources.length === 0 ? <div style={{ border: '2px dashed #AAB6B2', borderRadius: 16, padding: 32, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 12 }}>
              <span style={{ fontWeight: 600 }}>还没有登记资料</span>
              <span style={{ fontSize: 14.5, color: '#566460' }}>没有资料也可以先保存研究方案，之后再补充。</span>
              <form onSubmit={wizardUpload} style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <input type="file" aria-label="材料文件" disabled={busy} onChange={e => setWFile(e.target.files?.[0] ?? null)} style={{ maxWidth: 280 }} />
                  <select aria-label="来源性质" className="field" style={{ width: 180, fontSize: 14, padding: '8px 10px' }} value={wNature} onChange={e => setWNature(e.target.value as MaterialNature)}>{Object.entries(NATURES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </div>
                <div><button className="btn btn-ghost" disabled={busy || !wFile}>登记材料与预览</button></div>
              </form>
            </div> : <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {sources.map(s => <div key={s.sourceId} style={{ border: '1px solid #C3CCC9', borderRadius: 16, padding: '14px 18px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span className="mono" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{s.filename}</span>
                <span className={`chip ${s.nature === 'simulation' ? 'chip-warn' : 'chip-block'}`}>{NATURES[s.nature]}</span>
              </div>)}
              <form onSubmit={wizardUpload} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <input type="file" aria-label="追加材料文件" disabled={busy} onChange={e => setWFile(e.target.files?.[0] ?? null)} style={{ maxWidth: 280 }} />
                <select aria-label="追加来源性质" className="field" style={{ width: 180, fontSize: 14, padding: '8px 10px' }} value={wNature} onChange={e => setWNature(e.target.value as MaterialNature)}>{Object.entries(NATURES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                <button className="btn btn-ghost" disabled={busy || !wFile}>登记材料与预览</button>
              </form>
            </div>}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <button className="btn btn-ghost" onClick={() => setWizardStepOverride(3)}>上一步</button>
              <button className="btn btn-primary" onClick={() => setWizardStepOverride(5)}>{sources.length > 0 ? '继续' : '跳过，稍后添加'}</button>
            </div>
          </div>}
          {wizardStep === 5 && <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h1 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 30, lineHeight: 1.25 }}>确认方案及运行授权</h1>
            <div style={{ background: '#F2F4F3', borderRadius: 14, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
                <strong style={{ fontWeight: 600 }}>当前方案</strong>
                <span className="chip chip-warn">保存后才可授权执行</span>
              </div>
              <span style={{ fontSize: 14.5, color: '#2E3B38' }}>{idea?.verificationPlan?.trim() || '可验证方式未确定；可在上一步人工编辑补充。'}</span>
              <span style={{ fontSize: 14, color: '#566460' }}>执行范围：仅白名单描述统计 / 推断；最多 {general?.limits.maxAttempts ?? '—'} 次尝试。查看、上传与保存步骤不会触发运行。</span>
            </div>
            {sources.length === 0 && <div role="note" style={{ border: '1px solid #EBCB97', background: '#FBEFD9', color: '#5C3100', borderRadius: 12, padding: '14px 16px', fontSize: 14.5 }}>还没有登记资料，因此现在只能保存方案，暂时不能运行。</div>}
            {latestPlan && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <strong style={{ fontWeight: 600 }}>已保存的分析方案</strong>
              <span className="small" style={{ color: '#566460' }}>{latestPlan.title} · v{latestPlan.version} · 数据字典 v{latestPlan.dataset.version}{latestCalculation ? ` · 最近运行：${latestCalculation.status}` : ' · 尚未执行'}</span>
              <div className="flex"><span className="chip chip-ready">显式授权一次执行</span><button className="btn btn-primary" disabled={busy} onClick={() => void wizardRunLatestPlan()}>授权并执行本方案一次</button></div>
            </div>}
            <p style={{ fontSize: 14, color: '#566460' }}>Team 分析等 Agent 执行在「Agent 协作」页完成：先保存并冻结方案，再显式授权运行。</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <button className="btn btn-ghost" onClick={() => setWizardStepOverride(4)}>上一步</button>
              <button className="btn btn-primary" disabled={!idea || busy} onClick={() => void wizardSavePlan()}>保存方案（不执行）</button>
              <button className="btn btn-ghost" onClick={() => { setSub(current => ({ ...current, agent: 'team' })); go('agent'); }}>前往 Agent 协作 →</button>
            </div>
          </div>}
          {wizardStep === 6 && <div className="fade" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <h1 style={{ fontFamily: "'Noto Serif SC','Songti SC',serif", fontWeight: 700, fontSize: 30, lineHeight: 1.25 }}>{latestCalculation ? (latestCalculation.status === 'completed' ? '分析已提交并完成' : `分析已提交 · ${latestCalculation.status === 'blocked' ? '条件未满足' : '执行失败'}`) : '方案已保存，尚未执行'}</h1>
            <p style={{ color: '#2E3B38' }}>{latestCalculation?.firstError ? `首错 ${latestCalculation.firstError.code}：${latestCalculation.firstError.message}` : latestCalculation ? '运行完成后，可在「分析与结果」查看产物与证据缺口。' : '你可以稍后补充资料，再在「Agent 协作」页显式授权执行。保存方案不会启动任何运行。'}</p>
            <p style={{ fontSize: 14, color: '#566460' }}>「已完成」只表示计算跑完，不代表假设得到支持；结论需要在「分析与结果」中审查。</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <button className="btn btn-primary" onClick={() => go('home')}>进入研究概览</button>
              <button className="btn btn-ghost" onClick={() => { setSub(current => ({ ...current, agent: 'results' })); go('agent'); }}>查看分析与结果 →</button>
              <button className="btn btn-ghost" onClick={() => { setC1(false); setC2(false); setWizardStepOverride(1); }}>重新体验流程</button>
            </div>
          </div>}
        </section>
      </div>}
    </div>;
  }

  function treeContent() {
    return <>
      <div className="subnav" role="tablist" aria-label="实验树视图">
        <button role="tab" className={sub.tree === 'flow' ? 'active' : ''} aria-selected={sub.tree === 'flow'} onClick={() => setSubview('tree', 'flow')}>实验谱系</button>
        <button role="tab" className={sub.tree === 'metrics' ? 'active' : ''} aria-selected={sub.tree === 'metrics'} onClick={() => setSubview('tree', 'metrics')}>指标与比较</button>
        <button role="tab" className={sub.tree === 'queue' ? 'active' : ''} aria-selected={sub.tree === 'queue'} onClick={() => setSubview('tree', 'queue')}>有限队列（完整）</button>
      </div>
      <div hidden={sub.tree !== 'flow'}>{<GeneralTreePanel general={general!} researchId={identity} sessionId={props.sessionId} workflow={research?.workflow ?? []} metrics={research?.metrics} cycle={props.cycle ?? null} schedules={props.cycle?.schedules ?? []} action={action} cycleAction={cycleAction} busy={busy} refresh={props.refresh} />}</div>
      <div hidden={sub.tree !== 'metrics'}>{<MetricsPanel key={identity} general={general!} projection={research?.metrics} researchId={identity} action={action} busy={busy} />}</div>
      <div hidden={sub.tree !== 'queue'}>{<SchedulePanel general={general!} researchId={identity} sessionId={props.sessionId} schedules={props.cycle?.schedules ?? []} runtimeAvailable={props.cycle?.runtime?.available ?? false} refresh={props.refresh} />}</div>
    </>;
  }

  // ===== Agent 协作（过渡期：Team + 分析结果 + 推断；四步重排在 U4 批次） =====
  function agentContent() {
    return <>
      <div className="subnav" role="tablist" aria-label="Agent 协作视图">
        <button role="tab" className={sub.agent === 'cockpit' ? 'active' : ''} aria-selected={sub.agent === 'cockpit'} onClick={() => setSubview('agent', 'cockpit')}>协作驾驶台</button>
        <button role="tab" className={sub.agent === 'results' ? 'active' : ''} aria-selected={sub.agent === 'results'} onClick={() => setSubview('agent', 'results')}>分析与结果</button>
        <button role="tab" className={sub.agent === 'inference' ? 'active' : ''} aria-selected={sub.agent === 'inference'} onClick={() => setSubview('agent', 'inference')}>推断检验</button>
      </div>
      <div hidden={sub.agent !== 'cockpit'}>{<GeneralAgentPanel general={general!} researchId={identity} sessionId={props.sessionId} workflow={research?.workflow ?? []} analysis={research?.analysis ?? null} cycle={props.cycle ?? null} schedules={props.cycle?.schedules ?? []} action={action} cycleAction={cycleAction} busy={busy} refresh={props.refresh} onLocate={(p, s) => { setSubview(p, s); if (p !== 'agent') go(p); }} />}</div>
      <div hidden={sub.agent !== 'results'}>{<AnalysisResults key={identity} general={general!} projection={research?.analysis} researchId={identity} sessionId={props.sessionId} action={action} busy={busy} initialNodeId={selectedNode?.nodeId} />}</div>
      <div hidden={sub.agent !== 'inference'}>{<InferencePanel key={identity} general={general!} researchId={identity} sessionId={props.sessionId} revision={revision} action={action} busy={busy} />}</div>
    </>;
  }

  // ===== LLM Wiki（过渡期：知识 + 资料 + 方法库 + 报告；图谱在 U5 批次） =====
  function dataPage() {
    if (!general) return <div className="empty">请先新建通用研究；现有论文导入在历史功能中保留。</div>;
    return <>{head('资料与数据', '原始文件、字典与处理版本分开保存；上传不执行宏、公式或附件指令。')}<div className="stack"><section className="panel"><div className="panel-head"><h2>导入原始材料</h2><span className="small muted">CSV / XLSX / JSON 表格；其他格式仅附件</span></div><form className="panel-body" onSubmit={upload}><p className="small muted">单文件 ≤ 10 MiB · 每表 ≤ 50000 行 / 200 列 · 最多 20 工作表 / 500000 单元格 · 预览 100 行/页。超限明确拒绝或登记解析失败，原始值不截断。</p><div className="field-grid"><div><label htmlFor="gw-file">材料文件</label><input id="gw-file" type="file" disabled={busy} onChange={e => setFile(e.target.files?.[0] ?? null)} /></div><div><label htmlFor="gw-nature">来源性质（不代表可信性判定）</label><select id="gw-nature" value={nature} onChange={e => setNature(e.target.value as MaterialNature)}>{Object.entries(NATURES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div><div><label htmlFor="gw-description">来源说明 / 条件</label><input id="gw-description" name="description" maxLength={4000} /></div><div><label htmlFor="gw-purpose">研究用途</label><input id="gw-purpose" name="purpose" maxLength={4000} /></div></div><button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy || !file}>登记材料与预览</button></form></section>
      <section className="panel"><div className="panel-head"><h2>已登记材料与工作表</h2></div><div className="panel-body stack">{sources.map(s => <div key={s.sourceId}><div className="flex"><button className="link" onClick={() => choosePreview(undefined, s.sourceId)}>{s.filename} · 来源 v{s.revision}</button><span className="badge">{NATURES[s.nature]}</span><span className={`badge ${s.firstError ? 'amber' : ''}`}>{s.parseStatus === 'parsed' ? '格式已解析；判断未审查' : '仅原始附件 / 解析未完成'}</span><a href={`/evolver/research-bootstrap/source?${new URLSearchParams({ sessionId: props.sessionId, researchId: identity, sourceId: s.sourceId })}`}>下载原始文件</a></div><p className="small muted">{s.bytes} bytes · SHA256 {s.sha256} · {s.parser}</p>{s.firstError && <p className="small error">首错 {s.firstError.code}：{s.firstError.message}</p>}<div className="flex">{latestDatasets.filter(d => d.sourceId === s.sourceId).map(d => <button key={d.datasetId} className="link" onClick={() => choosePreview(d.datasetId)}>{s.tables.find(t => t.tableId === d.tableId)?.name} · 字典 v{d.version}</button>)}</div></div>)}{!sources.length && <p className="muted">尚无资料。只有 Idea 也能保存和规划，不会虚构数据。</p>}</div></section>
      <SourceAccessPanel general={general} researchId={identity} action={action} busy={busy} onChanged={sourceAccessChanged} />
      <TakeoverPanel sessionId={props.sessionId} action={action} busy={busy} refresh={props.refresh} />
      {previewLoading && <p role="status">正在读取并检查原始文件 hash…</p>}
      {preview && <section className="panel"><div className="panel-head"><h2>{preview.source.filename} · {preview.table?.name ?? '原始附件'}</h2>{preview.dataset && <select aria-label="查看字典历史版本" style={{ width: 180 }} value={preview.dataset.version} onChange={e => choosePreview(preview.dataset!.datasetId, undefined, Number(e.target.value))}>{general.datasets.filter(d => d.datasetId === preview.dataset!.datasetId).map(d => <option key={d.version} value={d.version}>字典 v{d.version}</option>)}</select>}</div><div className="panel-body stack">{preview.error ? <p className="error">{preview.error.message}</p> : <><p className="small muted">总数据 {preview.table?.totalRows} 行；当前仅显示 {(preview.offset ?? 0) + 1}–{Math.min((preview.offset ?? 0) + (preview.rows?.length ?? 0), preview.table?.totalRows ?? 0)} 行。内部行 ID 不是真实样本。∅ 为缺失；原始记录保留空字符串 / null。</p><div className="table-wrap"><table><thead><tr><th>内部定位</th>{preview.table?.headers.map((h, i) => <th key={i}>{h || `空列名 ${i + 1}`}</th>)}</tr></thead><tbody>{preview.rows.map(r => <tr key={r.rowId}><td>{r.rowIndex} {r.excluded ? '已明确排除' : ''}</td>{r.raw.map((v, i) => <td key={i}>{display(v)}{preview.dataset && r.values[i] !== v && <div className="small muted">解释值：{display(r.values[i])}</div>}</td>)}</tr>)}</tbody></table></div><div className="flex"><button disabled={(preview.offset ?? 0) === 0 || previewLoading} onClick={() => void loadPreview(preview.dataset?.datasetId, preview.source.sourceId, Math.max(0, (preview.offset ?? 0) - 100), preview.dataset?.version)}>上一页</button><button disabled={(preview.offset ?? 0) + 100 >= (preview.table?.totalRows ?? 0) || previewLoading} onClick={() => void loadPreview(preview.dataset?.datasetId, preview.source.sourceId, (preview.offset ?? 0) + 100, preview.dataset?.version)}>下一页</button></div>
      {preview.diagnostics && <div className="stack"><p className="small muted">全表检查：{preview.diagnostics.includedRows} 行纳入 · {preview.diagnostics.duplicateRecordRows.length} 条完全重复记录 · {preview.diagnostics.repeatedSampleRows.length} 条重复样本 · {preview.diagnostics.invalidCellCount} 个非法解释值。</p>{preview.diagnostics.comparisonBlockers.map(b => <p className="badge amber" key={b}>{b}</p>)}<details><summary>检查依据与缺失数</summary><pre>{JSON.stringify(preview.diagnostics, null, 2)}</pre></details></div>}
      {preview.dataset && <form onSubmit={saveDictionary}><h3>字段映射与处理草稿</h3><p className="small muted">全部原始列按索引保留；更名、缺失标记、单位与排除会创建新字典版本，不覆盖原值。尚不提供隐式插补。</p><div className="table-wrap"><table><thead><tr><th>原列 / 索引</th><th>解释名称</th><th>类型</th><th>角色</th><th>单位</th><th>缺失表示（逗号分隔）</th></tr></thead><tbody>{fields.map(f => <tr key={f.column}><td>{preview.table!.headers[f.column]} / {f.column}</td><td><input aria-label={`列 ${f.column} 名称`} value={f.label} onChange={e => updateField(f.column, { label: e.target.value })} /></td><td><select aria-label={`列 ${f.column} 类型`} value={f.type} onChange={e => updateField(f.column, { type: e.target.value as DataField['type'] })}>{Object.entries(TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td><td><select aria-label={`列 ${f.column} 角色`} value={f.role} onChange={e => updateField(f.column, { role: e.target.value as DataField['role'] })}>{Object.entries(ROLES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td><td><input aria-label={`列 ${f.column} 单位`} placeholder="未知 / 无量纲填 1" value={f.unit ?? ''} onChange={e => updateField(f.column, { unit: e.target.value || null })} /></td><td><input aria-label={`列 ${f.column} 缺失标记`} value={f.missingValues.filter(v => v !== '').join(',')} onChange={e => updateField(f.column, { missingValues: ['', ...e.target.value.split(',').map(v => v.trim()).filter(Boolean)] })} /></td></tr>)}</tbody></table></div><label htmlFor="gw-conditions">条件记录（JSON：name/value/unit，未知 value 用 null）</label><textarea id="gw-conditions" value={conditions} onChange={e => { setConditions(e.target.value); setDirty(true); }} /><label htmlFor="gw-excluded">明确排除行索引（从 0 起，逗号分隔；不会自动删除异常值）</label><input id="gw-excluded" value={excludedRows} onChange={e => { setExcludedRows(e.target.value); setDirty(true); }} /><label htmlFor="gw-reason">处理理由 / 留痕</label><textarea id="gw-reason" value={reason} onChange={e => { setReason(e.target.value); setDirty(true); }} /><button className="btn btn-primary" disabled={busy}>保存新字典版本</button></form>}</>}</div></section>}
    </div></>;
  }
  const sourceAccessChanged = (sourceId: string) => {
    if (preview?.source.sourceId === sourceId) { previewRequest.current++; setPreview(null); setPreviewLoading(false); setDirty(false); }
  };
  function wikiContent() {
    return <div className="wiki-host">
      <div className="wiki-mount" hidden={sub.wiki !== 'knowledge'}>{<KnowledgePanel key={`${identity}-wiki`} general={general!} researchId={identity} sessionId={props.sessionId} kind="wiki" action={action} busy={busy} inspect={inspect} />}</div>
      <div className="wiki-aux-panel" hidden={sub.wiki !== 'data'}>{dataPage()}</div>
      <div className="wiki-aux-panel" hidden={sub.wiki !== 'components'}>{<KnowledgePanel key={`${identity}-method`} general={general!} researchId={identity} sessionId={props.sessionId} kind="method" action={action} busy={busy} inspect={inspect} />}</div>
      <div className="wiki-aux-panel" hidden={sub.wiki !== 'reports'}>{<FactPackPanel key={identity} general={general!} projection={research?.reports} researchId={identity} sessionId={props.sessionId} revision={revision} action={action} busy={busy} />}</div>
    </div>;
  }

  function modalForm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const f = new FormData(event.currentTarget);
    if (modal === 'create') void action('create_general_research', { title: String(f.get('title')), question: String(f.get('question')), domains: String(f.get('domains') ?? '').split(/[,，、]/).map(s => s.trim()).filter(Boolean), methods: f.getAll('methods'), entryMode: String(f.get('entryMode')) }).then(saved => { if (saved) { setModal(null); go('home'); } });
    if (modal === 'idea' && general?.ideas[0]) void action('save_general_idea', { researchId: identity, ideaId: general.ideas[0].ideaId, question: String(f.get('question')), rationale: String(f.get('rationale')), verificationPlan: String(f.get('verificationPlan')), sourceRefs: f.getAll('sourceRefs') }).then(saved => { if (saved) setModal(null); });
  }
  return <div className={`gw ${menu ? 'menu-open' : ''}`} data-general-workbench><style>{GENERAL_LEGACY_CSS}</style><style>{GENERAL_SHELL_CSS}</style>
    <div className="shade" onClick={() => setMenu(false)} />
    <aside className="sidebar" aria-label="主导航">
      <div className="brand"><span className="brandmark" aria-hidden="true">D↗</span><div><b>DSH Research</b><span>RESEARCH STUDIO / 01</span></div></div>
      <div className="project"><div className="hint">当前工作区</div>
        <div className="project-title"><select aria-label="选择真实研究项目" value={identity} disabled={busy || !bootstrap} onChange={e => { if (dirty && general?.requireHumanConfirmation && !window.confirm('当前字典草稿未保存，确认切换？')) return; resetWizard(); void action('select_research', { researchId: e.target.value }); }}><option value="" disabled>尚无项目</option>{bootstrap?.researches.map(r => <option key={r.researchId} value={r.researchId}>{r.title}</option>)}</select><i className={`dot${identity ? '' : ' dim'}`} aria-label={identity ? '已有活动研究' : '尚无活动研究'} /></div>
        <div className="project-sub">{props.workspace ? `${props.workspace.title} · ${props.workspace.papers} 篇论文` : research ? research.title : '后端持久工作区'}</div>
        <button className="textbtn" onClick={() => setModal('create')} disabled={busy || !bootstrap}>＋ 新建研究</button>
      </div>
      <nav className="menus" aria-label="工作台导航">{NAV_GROUPS.map(group => <div key={group.title}><div className="group-title">{group.title}</div>{group.items.map(item => <button className={`nav${page === item.key ? ' active' : ''}`} key={item.key} data-route={item.key} aria-current={page === item.key ? 'page' : 'false'} onClick={() => go(item.key)}><span className="ico" aria-hidden="true">{item.icon}</span>{PAGE_TITLES[item.key]}{item.micro && <span className="micro" aria-hidden="true">{item.micro}</span>}</button>)}</div>)}</nav>
      <div className="sbfoot"><strong>后端持久工作区</strong>上传与查看不会启动运行。<br />任务完成 ≠ 科研结论成立。<div className="sync">{syncChip}<button onClick={() => (props.onResync ?? props.refresh)()}>重新同步</button></div></div>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div className="crumbs"><button className="mobile-trigger" aria-label="打开导航菜单" aria-expanded={menu} onClick={() => setMenu(v => !v)}>☰</button><span>DSH Studio</span><span aria-hidden="true">/</span><strong>{PAGE_TITLES[page]}</strong></div>
        <div className="top-actions">{page === 'wiki' && general && <select aria-label="知识区视图" value={sub.wiki} onChange={e => setSubview('wiki', e.target.value)}><option value="knowledge">知识条目</option><option value="data">资料与数据</option><option value="components">方法与组件库</option><option value="reports">报告事实包</option></select>}{page !== 'home' && <button className="outline" onClick={() => go('home')}>返回概览 ↗</button>}</div>
      </header>
      <div className="view">
        {(message || error) && <div className="statusline"><button className="textbtn" aria-label="关闭工作台提示" onClick={() => { setMessage(''); setError(''); }} style={{float:'right'}}>×</button>{message && <p role="status" className="small muted">{message}</p>}{error && <p className="error" role="alert">{error}</p>}</div>}
        <div className="viewbody">
        {!props.read ? <div className="page shell-toned"><p role="status">正在读取后端研究工作区；不可用时不会退回浏览器示例。</p></div>
          : research && !general && page !== 'start' ? <section className="page" data-legacy-research={identity}><div className="page-head"><div><h1>{research.title}</h1><p>论文研究工作区：已保存的论文、候选与计划在此查看。保留原资产与版本；创建通用研究请使用「新研究初始化」。</p></div></div><div style={{ height: 700 }}>{typeof props.legacy === 'function' ? props.legacy(page) : props.legacy}</div></section>
          : page === 'home' ? overview()
            : page === 'start' ? startPage()
              : null}
        {/* tree/agent/wiki 持久挂载：切页不卸载（保留面板状态与草稿；hidden 只隐藏显示） */}
        {props.read && general && <div hidden={page !== 'tree'} className="page">{visited.has('tree') && treeContent()}</div>}
        {props.read && general && <div hidden={page !== 'agent'} className="page">{visited.has('agent') && agentContent()}</div>}
        {props.read && general && <div hidden={page !== 'wiki'} className="page wiki-page">{visited.has('wiki') && wikiContent()}</div>}
        {props.read && !research && (page === 'tree' || page === 'agent' || page === 'wiki') && <div className="page"><div className="empty">请先新建或选择通用研究；现有论文 / 算法路径在历史功能中保留。</div></div>}
        </div>
      </div>
    </main>
    <dialog ref={dialog} className="modal" aria-labelledby="gw-modal-title" onCancel={() => setModal(null)} onClose={() => { setModal(null); createRef.current?.focus(); }}><form key={`${modal}-${identity}`} onSubmit={modalForm}><div className="flex between"><h2 id="gw-modal-title">{modal === 'create' ? '新建真实研究' : '编辑 Idea'}</h2><button type="button" aria-label="关闭弹窗" onClick={() => setModal(null)}>×</button></div>{modal === 'create' ? <><label htmlFor="gw-title">研究名称</label><input id="gw-title" name="title" required maxLength={300} autoFocus /><label htmlFor="gw-question">Idea / 研究问题</label><textarea id="gw-question" name="question" required maxLength={4000} /><label htmlFor="gw-domains">领域标签（可未知，逗号分隔）</label><input id="gw-domains" name="domains" /><label htmlFor="gw-methods">方法模板（可组合；不生成固定十节点）</label><select id="gw-methods" name="methods" multiple size={5}>{Object.entries(METHODS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select><label htmlFor="gw-entry">入口顺序</label><select id="gw-entry" name="entryMode"><option value="idea_only">只有 Idea：仅规划验证</option><option value="existing_data">已有数据 / 结果：先整理再分析</option><option value="design_first">先设计再采集 / 分析</option></select><p className="small muted">保存不启动 Agent，不要求论文、Baseline、代码或 GPU。</p></> : general?.ideas[0] && <><label htmlFor="gw-idea-question">Idea / 探索问题（非已证实结论）</label><textarea key={`${identity}-question`} id="gw-idea-question" name="question" required maxLength={4000} defaultValue={general.ideas[0].question} /><label htmlFor="gw-rationale">理由</label><textarea id="gw-rationale" name="rationale" maxLength={4000} defaultValue={general.ideas[0].rationale} /><label htmlFor="gw-plan">可验证方式</label><textarea id="gw-plan" name="verificationPlan" maxLength={4000} defaultValue={general.ideas[0].verificationPlan} /><label htmlFor="gw-source-refs">依据（可不选，不编造证据）</label><select id="gw-source-refs" name="sourceRefs" multiple defaultValue={general.ideas[0].sourceRefs}>{sources.map(s => <option key={s.sourceId} value={s.sourceId}>{s.filename} v{s.revision}</option>)}</select></>}<footer><button type="button" onClick={() => setModal(null)}>取消</button><button className="btn btn-primary" disabled={busy}>{modal === 'create' ? '保存研究草稿' : '保存新版本'}</button></footer></form></dialog>
  </div>;
}
