import { useEffect, useRef, useState } from 'react';
import { ReportModes } from '../report-presentation/modes/ReportModes.tsx';
import { RP_ALL_CSS } from '../report-presentation/styles/index.ts';
import type { GeneralResearch } from '../../../../../evolver/src/contracts/general-research.ts';
import type { GeneralFactPackRead, GeneralReportProjection, GeneralReportSelection } from '../../../../../evolver/src/contracts/general-report.ts';
import { readGeneralFactPack } from '../../integration/research-bootstrap-view.ts';
import { renderInteractiveReportHTML } from './offline-html.ts';

const emptySelection = (): GeneralReportSelection => ({ sourceIds: [], calculationIds: [], knowledgeRefs: [], reviewIds: [], inferenceRunIds: [] });
export function FactPackPanel(props: { sessionId: string; researchId: string; general: GeneralResearch; projection?: GeneralReportProjection | null; revision: number; busy: boolean; action(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> }): JSX.Element {
  const [selection, setSelection] = useState(emptySelection);
  const [title, setTitle] = useState('研究事实报告');
  const [selected, setSelected] = useState('');
  const [loaded, setLoaded] = useState<{ read: GeneralFactPackRead; key: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const packs = props.projection?.packs ?? [];
  const record = packs.find(p => `${p.packId}:${p.version}` === selected);
  const contextKey = JSON.stringify([props.sessionId, props.researchId, props.revision, selected, record?.access]);
  const currentContext = useRef(contextKey); currentContext.current = contextKey;
  const result = loaded?.key === contextKey && record?.access === 'allowed' ? loaded.read : null;
  // Every Bootstrap change triggers live access/freshness checks; an old response never stays usable during refresh.
  useEffect(() => {
    const controller = new AbortController(); setLoaded(null); setError(''); setLoading(false);
    if (!record) return () => controller.abort();
    if (record.access === 'revoked') { setError('来源证据使用权限已撤销，无法读取或导出。'); return () => controller.abort(); }
    setLoading(true);
    void readGeneralFactPack(props.sessionId, props.researchId, record.packId, record.version, controller.signal)
      .then(value => { if (!controller.signal.aborted && currentContext.current === contextKey) setLoaded({ read: value, key: contextKey }); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [props.sessionId, props.researchId, props.revision, selected, record?.access]);
  const toggle = (key: 'sourceIds' | 'calculationIds' | 'reviewIds' | 'inferenceRunIds', id: string) => setSelection(s => ({ ...s, [key]: s[key].includes(id) ? s[key].filter(x => x !== id) : [...s[key], id] }));
  const freeze = async (packId?: string) => {
    setError('');
    const saved = await props.action('create_general_report_fact_pack', { researchId: props.researchId, title, selection, ...(packId ? { packId } : {}) });
    if (saved) setSelected(`${saved.packId}:${saved.version}`);
  };
  const exportReport = async (format: 'json' | 'html') => {
    if (!record || record.access !== 'allowed') return;
    setError('');
    const exportContext = contextKey;
    try {
      // Revalidate at export time instead of silently exporting a cached authorized response.
      const fresh = await readGeneralFactPack(props.sessionId, props.researchId, record.packId, record.version, new AbortController().signal);
      if (currentContext.current !== exportContext) throw new Error('报告版本或权限已变化，请重新核对后导出。');
      setLoaded({ read: fresh, key: exportContext });
      const url = URL.createObjectURL(new Blob([format === 'html' ? renderInteractiveReportHTML(fresh) : JSON.stringify(fresh, null, 2)], { type: format === 'html' ? 'text/html;charset=utf-8' : 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `${record.packId}-v${record.version}.${format}`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) { if (currentContext.current === exportContext) { setLoaded(null); setError(failure instanceof Error ? failure.message : String(failure)); } }
  };
  return <section className="panel panel-body stack" aria-label="报告事实包">
    <h2>报告事实包</h2><p className="muted">明确选择本报告的证据范围，保存冻结版本。定位相符和数学计算完成均不代表科学假设成立。</p>
    <label>报告标题<input value={title} maxLength={300} onChange={e => setTitle(e.currentTarget.value)} /></label>
    <fieldset disabled={props.busy}><legend>选入报告的依据（间接依赖由宿主补全）</legend>
      <details><summary>来源（{selection.sourceIds.length}）</summary>{props.general.sources.map(s => <label key={s.sourceId} className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={selection.sourceIds.includes(s.sourceId)} onChange={() => toggle('sourceIds', s.sourceId)} />{s.filename} · {s.nature} · v{s.revision}</label>)}</details>
      <details><summary>计算（{selection.calculationIds.length}）</summary>{props.general.calculations.map(c => <label key={c.calculationId} className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={selection.calculationIds.includes(c.calculationId)} onChange={() => toggle('calculationIds', c.calculationId)} />{c.calculationId} · {c.status} · {c.inputNature} · attempt {c.attempt}</label>)}</details>
      <details><summary>Wiki 版本（{selection.knowledgeRefs.length}）</summary>{props.general.knowledge.map(k => <label key={`${k.entryId}:${k.version}`} className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={selection.knowledgeRefs.some(r => r.entryId === k.entryId && r.version === k.version)} onChange={() => setSelection(s => ({ ...s, knowledgeRefs: s.knowledgeRefs.some(r => r.entryId === k.entryId && r.version === k.version) ? s.knowledgeRefs.filter(r => r.entryId !== k.entryId || r.version !== k.version) : [...s.knowledgeRefs, { entryId: k.entryId, version: k.version }] }))} />{k.title} · v{k.version} · {k.nature}</label>)}</details>
      <details><summary>人工审查（{selection.reviewIds.length}）</summary>{props.general.reviews.map(r => <label key={r.reviewId} className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={selection.reviewIds.includes(r.reviewId)} onChange={() => toggle('reviewIds', r.reviewId)} />{r.judgment} · {r.reviewer.identity} · {r.createdAt}</label>)}</details>
      <details><summary>推断运行（{selection.inferenceRunIds.length}）</summary>{props.general.inferenceRuns.length === 0 ? <p className="small muted">尚无推断运行；在「推断检验」页冻结并授权执行。</p> : props.general.inferenceRuns.map(r => { const plan = props.general.inferencePlans.find(p => p.planId === r.planId && p.version === r.planVersion); return <label key={r.runId} className="flex small"><input type="checkbox" style={{ width: 'auto' }} checked={selection.inferenceRunIds.includes(r.runId)} onChange={() => toggle('inferenceRunIds', r.runId)} />{plan?.title ?? r.planId} · v{r.planVersion} · {r.status} · attempt {r.attempt} · {r.tool.name}</label>; })}</details>
    </fieldset>
    <div className="flex"><button disabled={props.busy || !title.trim()} onClick={() => void freeze()}>保存新事实包</button><button disabled={props.busy || !record || !title.trim()} onClick={() => void freeze(record?.packId)}>追加所选报告版本</button></div>
    <label>已保存版本<select value={selected} onChange={e => setSelected(e.currentTarget.value)}><option value="">选择报告</option>{packs.map(p => <option key={`${p.packId}:${p.version}`} value={`${p.packId}:${p.version}`}>{p.title} · v{p.version} · {p.access} · {p.freshness}</option>)}</select></label>
    {record && <p>访问权：{record.access} · 登记状态：{record.freshness}</p>}
    {loading && <p role="status">正在重新核对报告和来源…</p>}{error && <p role="alert">{error}</p>}
    {result && <article>
      <style>{RP_ALL_CSS}</style>
      <ReportModes key={`${props.researchId}:${selected}:${props.revision}`} read={result} dataOrigin="workspace" />
      <h3>{result.pack.title} · v{result.pack.version}</h3>
      <p role="status">当前核对：{result.freshness.status === 'current' ? 'current（来源与定位检查，不是科学验证）' : 'needs_review（待重审）'}</p>
      <ul>{result.freshness.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
      <h4>未知项与限制</h4><ul>{result.pack.unknowns.map((r, i) => <li key={i}>{r}</li>)}</ul>
      <p>冻结时间：{result.pack.createdAt} · Artifact：{result.record.artifact.sha256}</p>
      <div className="flex"><button onClick={() => void exportReport('json')}>导出事实包 JSON</button><button onClick={() => void exportReport('html')}>导出独立 HTML</button></div>
      <details><summary>研究问题与约束</summary><ul>{result.pack.questions.map(q => <li key={q.ideaId}>{q.question} · hypothesis</li>)}</ul><ul>{result.pack.constraints.map((c, i) => <li key={i}>{c}</li>)}</ul></details>
      <details><summary>计算与指标（{result.pack.calculations.length} / {result.pack.metrics.rows.length}）</summary><pre>{JSON.stringify({ calculations: result.pack.calculations, metrics: result.pack.metrics }, null, 2)}</pre></details>
      <details><summary>来源、Wiki 定位与审查</summary><pre>{JSON.stringify({ sources: result.pack.sources, knowledge: result.pack.knowledge, reviews: result.pack.reviews }, null, 2)}</pre></details>
      <p className="muted">{result.pack.boundary}</p>
    </article>}
  </section>;
}

