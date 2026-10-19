/**
 * W3→F2 · 推断检验面板（工作台）。
 *
 * 事实来源：general.inferencePlans / inferenceRuns（正式 projection）+ readGeneralInference 只读 helper；
 * 保存与执行走 action 桥（operationId + 实时 baseRevision CAS；身份由可信宿主派生）。
 * 硬性约定：保存只冻结方案不执行；执行需显式授权且消耗尝试次数；执行完成 ≠ 假设成立/supported；
 * CI 是均值（差）的置信区间，不是效应量的置信区间；假设理由本身不是假设被验证的证据；
 * 不编造数值，blocked/failed 保留首错；本组件不修改输入对象。
 */
import { useEffect, useState } from 'react';
import type { GeneralResearch } from '../../../../evolver/src/contracts/general-research.ts';
import type { InferencePlan, InferenceRun } from '../../../../evolver/src/contracts/general-inference-records.ts';
import { INFERENCE_METHODS } from '../../../../evolver/src/contracts/general-inference.ts';
import { readGeneralInference, type GeneralInferenceRead } from '../integration/research-bootstrap-view.ts';

type Action = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

const METHOD_LABELS: Record<string, string> = { one_sample_t: '单样本 t（对照参考均值）', paired_t: '配对 t（真实身份配对，A−B）', welch_t: 'Welch t（两组，A−B）' };
const ESTIMAND_LABELS: Record<string, string> = { mean_minus_reference: '均值 − 参考均值', paired_mean_difference_A_minus_B: '配对均值差 (A−B)', independent_mean_difference_A_minus_B: '独立组均值差 (A−B)' };
const EFFECT_LABELS: Record<string, string> = { cohen_d: "Cohen's d（独立组）", cohen_dz: "Cohen's dz（配对）", cohen_d_pooled: "Cohen's d（合并标准差）" };
const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(7))));

interface Draft {
  nodeId: string; title: string; datasetId: string; datasetVersion: number;
  method: 'one_sample_t' | 'paired_t' | 'welch_t'; confidence: 0.9 | 0.95 | 0.99; referenceMean: string;
  valueColumn: string; sampleColumn: string; groupColumn: string; groupA: string; groupB: string;
  rangeStart: string; rangeEnd: string; requiredConditions: string; limitations: string;
  samplingRationale: string; normalityRationale: string; independenceConfirmed: boolean; authorized: boolean;
}
const emptyDraft = (): Draft => ({ nodeId: '', title: '', datasetId: '', datasetVersion: 0, method: 'one_sample_t', confidence: 0.95, referenceMean: '0', valueColumn: '', sampleColumn: '', groupColumn: '', groupA: '', groupB: '', rangeStart: '0', rangeEnd: '', requiredConditions: '', limitations: '不作因果或科学支持判定；效应量 CI 未提供。', samplingRationale: '', normalityRationale: '', independenceConfirmed: false, authorized: false });

export function InferencePanel(props: { general: GeneralResearch; researchId: string; sessionId: string; revision: number; action: Action; busy: boolean }): JSX.Element {
  const g = props.general;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [formError, setFormError] = useState('');
  const [selectedRun, setSelectedRun] = useState('');
  const [inferenceRead, setInferenceRead] = useState<GeneralInferenceRead | null>(null);
  const [readError, setReadError] = useState('');
  const [loading, setLoading] = useState(false);

  const latestDatasets = g.datasets.filter(d => !g.datasets.some(other => other.datasetId === d.datasetId && other.version > d.version));
  const draftDataset = latestDatasets.find(d => d.datasetId === draft.datasetId);
  const numericFields = draftDataset?.fields.filter(f => f.type === 'number') ?? [];
  const outcomeFields = numericFields.filter(f => f.role === 'outcome');
  const sampleFields = draftDataset?.fields.filter(f => f.role === 'sample') ?? [];
  const groupFields = draftDataset?.fields.filter(f => f.role === 'group') ?? [];
  const analysisNodes = g.graph.nodes.filter(n => n.kind === 'analysis');
  const plansLatest = [...g.inferencePlans].sort((a, b) => a.planId === b.planId ? b.version - a.version : 0);
  const runsNewestFirst = [...g.inferenceRuns].reverse();
  const selectedRunRecord = g.inferenceRuns.find(r => r.runId === selectedRun) ?? null;

  // 读取选中运行的登记结果（含整包重算校验与新鲜度）；研究/版本变化即作废，迟到响应不落地。
  useEffect(() => {
    const controller = new AbortController(); setInferenceRead(null); setReadError(''); setLoading(false);
    if (!selectedRun) return () => controller.abort();
    setLoading(true);
    void readGeneralInference(props.sessionId, props.researchId, selectedRun, controller.signal)
      .then(value => { if (!controller.signal.aborted) setInferenceRead(value); })
      .catch(failure => { if (!controller.signal.aborted) setReadError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [props.sessionId, props.researchId, props.revision, selectedRun]);

  const set = (patch: Partial<Draft>): void => setDraft(current => ({ ...current, ...patch }));
  const lines = (value: string): string[] => value.split('\n').map(s => s.trim()).filter(Boolean);

  const save = async (): Promise<void> => {
    setFormError('');
    const dataset = latestDatasets.find(d => d.datasetId === draft.datasetId);
    if (!analysisNodes.some(n => n.nodeId === draft.nodeId)) { setFormError('请选择分析节点。'); return; }
    if (!dataset) { setFormError('请选择数据集版本。'); return; }
    const valueColumn = Number(draft.valueColumn), sampleColumn = Number(draft.sampleColumn);
    if (!Number.isSafeInteger(valueColumn) || !Number.isSafeInteger(sampleColumn)) { setFormError('请选择数值列与样本身份列。'); return; }
    const groups = draft.method === 'one_sample_t' ? null : { column: Number(draft.groupColumn), a: draft.groupA.trim(), b: draft.groupB.trim() };
    if (groups !== null && (!Number.isSafeInteger(groups.column) || groups.a === '' || groups.b === '')) { setFormError('配对 / 两组方法需要分组列与两组的实际取值。'); return; }
    const rowRange = { start: Number(draft.rangeStart), end: Number(draft.rangeEnd) };
    if (!Number.isSafeInteger(rowRange.start) || !Number.isSafeInteger(rowRange.end) || rowRange.end < rowRange.start) { setFormError('行范围无效（0 起始，end ≥ start）。'); return; }
    if (!draft.independenceConfirmed || draft.samplingRationale.trim() === '' || draft.normalityRationale.trim() === '') { setFormError('独立性确认与抽样/正态性理由必须填写后才能冻结方案。'); return; }
    const saved = await props.action('save_general_inference_plan', {
      researchId: props.researchId, nodeId: draft.nodeId, title: draft.title.trim() === '' ? '推断方案' : draft.title.trim(),
      datasetId: dataset.datasetId, datasetVersion: dataset.version, valueColumn, sampleColumn, groups, rowRange,
      spec: { method: draft.method, confidence: draft.confidence, referenceMean: Number(draft.referenceMean) || 0, missingPolicy: 'complete_cases', assumptions: { independenceConfirmed: true, samplingRationale: draft.samplingRationale.trim(), normalityRationale: draft.normalityRationale.trim() } },
      requiredConditions: lines(draft.requiredConditions), limitations: lines(draft.limitations),
    });
    if (saved) setDraft(current => ({ ...emptyDraft(), nodeId: current.nodeId, datasetId: current.datasetId, datasetVersion: current.datasetVersion }));
  };

  const execute = async (plan: InferencePlan): Promise<void> => {
    if (!draft.authorized) return;
    await props.action('execute_general_inference', { researchId: props.researchId, planId: plan.planId, planVersion: plan.version, authorize: true });
    setDraft(current => ({ ...current, authorized: false }));
  };

  const planRuns = (plan: InferencePlan): InferenceRun[] => g.inferenceRuns.filter(r => r.planId === plan.planId && r.planVersion === plan.version);
  const planCard = (plan: InferencePlan): JSX.Element => (
    <div key={`${plan.planId}:${plan.version}`} className="panel" style={{ padding: '14px 16px', display: 'grid', gap: 8, minWidth: 0 }}>
      <div className="flex between">
        <strong>{plan.title} · v{plan.version}</strong>
        <span className="badge">已冻结 · 未执行 ≠ 已验证</span>
      </div>
      <p className="small muted">
        {METHOD_LABELS[plan.spec.method]} · 置信 {plan.spec.confidence} · 单位 {plan.spec.unit} · 参考均值 {fmt(plan.spec.referenceMean)} · 估算 {ESTIMAND_LABELS[{ one_sample_t: 'mean_minus_reference', paired_t: 'paired_mean_difference_A_minus_B', welch_t: 'independent_mean_difference_A_minus_B' }[plan.spec.method]]}
      </p>
      <p className="small muted">
        数据集 {plan.dataset.datasetId} v{plan.dataset.version}（表 {plan.dataset.tableId}）· 值列 {plan.valueColumn} · 身份列 {plan.sampleColumn}{plan.groups ? ` · 分组列 ${plan.groups.column}（A=${JSON.stringify(plan.groups.a)} / B=${JSON.stringify(plan.groups.b)}）` : ''} · 行范围 {plan.rowRange.start}–{plan.rowRange.end}
      </p>
      <p className="small muted">假设：独立性已确认；抽样理由：{plan.spec.assumptions.samplingRationale}；正态性理由：{plan.spec.assumptions.normalityRationale}。填写理由本身不是假设被验证的证据。</p>
      {plan.requiredConditions.length > 0 ? <p className="small muted">前置条件：{plan.requiredConditions.join('；')}</p> : null}
      {plan.limitations.length > 0 ? <p className="small muted">限制：{plan.limitations.join('；')}</p> : null}
      <p className="small muted">冻结身份 {plan.actor.identity} · {plan.createdAt}（unit 与来源/哈希由服务冻结）</p>
      {planRuns(plan).length > 0 ? (
        <div className="stack" style={{ gap: 6 }}>
          {planRuns(plan).map(run => (
            <div key={run.runId} className="flex between small" style={{ borderTop: '1px solid var(--line)', paddingTop: 6 }}>
              <span>
                <span className="badge">{run.status === 'completed' ? '已完成（数学执行）' : run.status === 'blocked' ? '被阻塞' : '失败'}</span>{' '}
                attempt {run.attempt} · {run.tool.name} {run.tool.version}（{run.tool.runtime}）· {run.nature}
              </span>
              <span className="flex">
                <button className="link" onClick={() => setSelectedRun(current => (current === run.runId ? '' : run.runId))}>{selectedRun === run.runId ? '收起结果' : '查看运行结果'}</button>
              </span>
            </div>
          ))}
          {planRuns(plan).some(r => r.firstError !== null) ? (
            <p className="small muted">首错（输入提供）：{planRuns(plan).filter(r => r.firstError !== null).map(r => `${r.firstError!.code}: ${r.firstError!.message}`).join('；')}</p>
          ) : null}
        </div>
      ) : (
        <p className="small muted">该版本尚无执行记录。</p>
      )}
      <div className="flex small">
        <label className="flex">
          <input type="checkbox" style={{ width: 'auto' }} checked={draft.authorized} onChange={e => set({ authorized: e.currentTarget.checked })} disabled={props.busy} />
          我授权真实执行本方案 v{plan.version}（消耗一次尝试次数）
        </label>
        <button disabled={props.busy || !draft.authorized} onClick={() => void execute(plan)}>执行推断</button>
      </div>
    </div>
  );

  return (
    <div className="stack" data-general-inference>
      <div className="page-head"><div><h1>推断检验（F2）</h1><p className="muted">冻结推断方案 → 显式授权执行 → 只读查看登记结果。保存不执行；执行完成不等于假设成立或 supported。</p></div></div>
      <div className="notice"><span>∑</span><div><strong>边界提醒</strong><p className="small">仅 one_sample_t / paired_t / welch_t，双侧比较，置信水平 0.9/0.95/0.99。CI 是均值（差）的置信区间，不是效应量的置信区间；标准化效应量为点估计。配对按真实样本身份匹配，不以行号配对。数值来自已登记完整原表，浏览器与模型不能提供替代数值。</p></div></div>

      <section className="panel"><div className="panel-head"><h2>已冻结方案与运行</h2></div><div className="panel-body stack">
        {g.inferencePlans.length === 0 ? <p className="empty">尚无推断方案；用下方表单冻结第一个版本。保存不执行。</p> : plansLatest.map(planCard)}
        {g.inferencePlans.length === 0 ? null : (() => {
          const runs = runsNewestFirst;
          if (runs.length === 0) return null;
          return (
            <label className="small">选择运行查看登记结果（含权限/新鲜度核对）
              <select value={selectedRun} onChange={e => setSelectedRun(e.target.value)}>
                <option value="">— 选择运行 —</option>
                {runs.map(run => {
                  const plan = g.inferencePlans.find(p => p.planId === run.planId && p.version === run.planVersion);
                  return <option key={run.runId} value={run.runId}>{run.status} · attempt {run.attempt} · {plan?.title ?? run.planId} v{run.planVersion} · {run.runId.slice(0, 18)}…</option>;
                })}
              </select>
            </label>
          );
        })()}
        {selectedRunRecord === null ? null : (
          <div className="panel" style={{ padding: '12px 14px', display: 'grid', gap: 8, minWidth: 0 }}>
            {loading ? <p role="status" className="small muted">正在读取登记结果（含整包重算校验）…</p> : null}
            {readError ? <p className="error" role="alert">读取失败：{readError}</p> : null}
            {!loading && readError === '' && inferenceRead === null ? <p className="small muted">选择上方运行后查看。</p> : null}
            {inferenceRead !== null ? (() => {
              const r = inferenceRead.run, content = inferenceRead.content;
              return (
                <div className="stack" style={{ gap: 8, minWidth: 0 }}>
                  <div className="flex between">
                    <strong>运行 {r.runId.slice(0, 18)}…</strong>
                    <span className="badge">{inferenceRead.freshness.status === 'current' ? '新鲜度：当前' : `新鲜度：待复核（${inferenceRead.freshness.reasons.join('；')}）`}</span>
                  </div>
                  {content === null ? (
                    <p className="error">该运行没有成功产物（{r.status}）。首错：{r.firstError ? `${r.firstError.code}: ${r.firstError.message}` : '未记录'}</p>
                  ) : (
                    <div className="stack" style={{ gap: 6, minWidth: 0 }}>
                      <p className="small"><strong>{ESTIMAND_LABELS[content.result.estimand]}</strong> · {METHOD_LABELS[content.result.method]} · 置信 {content.result.confidence} · 单位 {content.result.unit}</p>
                      <div className="metrics" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
                        {[['估计值', fmt(content.result.estimate)], ['标准误', fmt(content.result.standardError)], ['自由度', fmt(content.result.degreesOfFreedom)], ['t 统计量', fmt(content.result.statistic)], ['双侧 p 值', fmt(content.result.pValueTwoSided)], ['样本 nA / nB', `${fmt(content.result.nA)} / ${content.result.nB === null ? '—' : fmt(content.result.nB)}`]].map(([label, value]) => (
                          <div className="metric" key={label}><div className="small muted">{label}</div><div className="number">{value}</div></div>
                        ))}
                      </div>
                      <p className="small">均值（差）{content.result.confidence * 100}% 置信区间：[{fmt(content.result.confidenceInterval.lower)}, {fmt(content.result.confidenceInterval.upper)}] {content.result.unit}
                        <span className="small muted">（这是均值（差）的置信区间，不是效应量的置信区间。）</span>
                      </p>
                      <p className="small">标准化效应量：{EFFECT_LABELS[content.result.standardizedEffect.name]} = {fmt(content.result.standardizedEffect.value)}
                        <span className="small muted">（点估计；本工具不提供效应量区间估计。）</span>
                      </p>
                      <p className="small muted">排除样本：A 组 {content.result.excludedA.length} 项{content.result.excludedB !== null ? `、B 组 ${content.result.excludedB.length} 项` : ''}{content.result.excludedA.length + content.result.excludedB.length > 0 ? `（${[...content.result.excludedA, ...(content.result.excludedB ?? [])].join('、')}；缺失按 complete_cases 整例排除）` : ''} · 选择范围 {content.selection.rangeRows} 行，排除 {content.selection.excludedRows} 行，未选 {content.selection.unselectedRows} 行</p>
                      <p className="small muted">假设登记：独立性已确认；抽样理由：{content.result.assumptions.samplingRationale}；正态性理由：{content.result.assumptions.normalityRationale}。填写理由本身不是假设被验证的证据。</p>
                      {content.result.warnings.length > 0 ? <div className="rp-warn" style={{ padding: '10px 12px', borderRadius: 8 }}>{content.result.warnings.map((w, i) => <p key={i} className="small">{w}</p>)}</div> : null}
                      <p className="small muted">工具：{content.result.tool.name} {content.result.tool.version}（{content.result.tool.runtime}）· {content.startedAt} → {content.finishedAt} · 运行状态 completed 只代表数学执行完成；科学支持/判断由审查环节给出，不由 p 值自动生成。</p>
                    </div>
                  )}
                </div>
              );
            })() : null}
          </div>
        )}
      </div></section>

      <section className="panel"><div className="panel-head"><h2>新建 / 新版本推断方案（保存只冻结，不执行）</h2></div><div className="panel-body stack">
        {analysisNodes.length === 0 || latestDatasets.length === 0 ? (
          <p className="empty">需要分析节点与已登记数据集；先在「资料与数据」导入并冻结数据字典。</p>
        ) : (
          <>
            {formError ? <p className="error" role="alert">{formError}</p> : null}
            <div className="field-grid">
              <label>分析节点<select value={draft.nodeId} onChange={e => set({ nodeId: e.target.value })}>{<option value="">— 选择 —</option>}{analysisNodes.map(n => <option key={n.nodeId} value={n.nodeId}>{n.title}</option>)}</select></label>
              <label>方案标题<input type="text" value={draft.title} onChange={e => set({ title: e.target.value })} maxLength={300} placeholder="留空用默认标题" /></label>
            </div>
            <div className="field-grid">
              <label>数据集版本<select value={draft.datasetId} onChange={e => set({ datasetId: e.target.value, datasetVersion: latestDatasets.find(d => d.datasetId === e.target.value)?.version ?? 0, valueColumn: '', sampleColumn: '', groupColumn: '' })}>{<option value="">— 选择 —</option>}{latestDatasets.map(d => <option key={`${d.datasetId}:${d.version}`} value={d.datasetId}>{d.datasetId} v{d.version} · 表 {d.tableId}</option>)}</select></label>
              <label>方法<select value={draft.method} onChange={e => set({ method: e.target.value as Draft['method'], groupColumn: '', groupA: '', groupB: '' })}>{INFERENCE_METHODS.map(m => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}</select></label>
              <label>置信水平<select value={draft.confidence} onChange={e => set({ confidence: Number(e.target.value) as Draft['confidence'] })}>{[0.9, 0.95, 0.99].map(c => <option key={c} value={c}>{c * 100}%</option>)}</select></label>
              <label>参考均值{draft.method === 'one_sample_t' ? '' : '（配对/两组差异保持 0）'}<input type="number" step="any" value={draft.referenceMean} onChange={e => set({ referenceMean: e.target.value })} /></label>
            </div>
            {draftDataset ? (
              <>
                <div className="field-grid">
                  <label>数值结果列（number + outcome 角色）<select value={draft.valueColumn} onChange={e => set({ valueColumn: e.target.value })}>{<option value="">— 选择 —</option>}{outcomeFields.map(f => <option key={f.column} value={f.column}>{f.column} · {f.label}（{f.unit ?? '单位未知'}）</option>)}</select>{outcomeFields.length === 0 ? <p className="small muted">该字典暂无 number/outcome 字段；先在「资料与数据」修正角色与单位。</p> : null}</label>
                  <label>样本身份列（sample 角色）<select value={draft.sampleColumn} onChange={e => set({ sampleColumn: e.target.value })}>{<option value="">— 选择 —</option>}{sampleFields.map(f => <option key={f.column} value={f.column}>{f.column} · {f.label}</option>)}</select></label>
                </div>
                {draft.method !== 'one_sample_t' ? (
                  <div className="field-grid">
                    <label>分组列（group 角色）<select value={draft.groupColumn} onChange={e => set({ groupColumn: e.target.value, groupA: '', groupB: '' })}>{<option value="">— 选择 —</option>}{groupFields.map(f => <option key={f.column} value={f.column}>{f.column} · {f.label}</option>)}</select></label>
                    <label>组 A 取值<input value={draft.groupA} onChange={e => set({ groupA: e.target.value })} placeholder="如 X" /></label>
                    <label>组 B 取值<input value={draft.groupB} onChange={e => set({ groupB: e.target.value })} placeholder="如 Y" /></label>
                  </div>
                ) : null}
                <div className="field-grid">
                  <label>行范围 start（0 起）<input type="number" value={draft.rangeStart} onChange={e => set({ rangeStart: e.target.value })} /></label>
                  <label>行范围 end（不含）<input type="number" value={draft.rangeEnd} onChange={e => set({ rangeEnd: e.target.value })} /></label>
                </div>
                <p className="small muted">缺失处理固定 complete_cases（整例排除并记录身份）；{draft.method === 'one_sample_t' ? '单样本' : draft.method === 'paired_t' ? '配对按真实样本身份对齐，缺失整对排除' : '两组分别排除缺测，身份重复直接拒绝'}。范围与列以原始表为准，超界在执行时明确阻塞。</p>
                <div className="field-grid">
                  <label>必须一致的前置条件（每行一项；需与字典条件一致）<textarea value={draft.requiredConditions} onChange={e => set({ requiredConditions: e.target.value })} /></label>
                  <label>限制说明（每行一项）<textarea value={draft.limitations} onChange={e => set({ limitations: e.target.value })} /></label>
                </div>
                <label className="flex"><input type="checkbox" style={{ width: 'auto' }} checked={draft.independenceConfirmed} onChange={e => set({ independenceConfirmed: e.currentTarget.checked })} />我确认样本独立性与抽样方式（冻结方案必需）</label>
                <div className="field-grid">
                  <label>抽样理由（必填）<textarea value={draft.samplingRationale} onChange={e => set({ samplingRationale: e.target.value })} /></label>
                  <label>正态性 / 分布理由（必填，实际研究需核验）<textarea value={draft.normalityRationale} onChange={e => set({ normalityRationale: e.target.value })} /></label>
                </div>
                <div className="flex">
                  <button className="primary" disabled={props.busy} onClick={() => void save()}>冻结方案（保存不执行）</button>
                  <span className="small muted">unit、来源/哈希与身份由服务冻结；浏览器与模型不能提交数值数组。</span>
                </div>
              </>
            ) : null}
          </>
        )}
      </div></section>
    </div>
  );
}
