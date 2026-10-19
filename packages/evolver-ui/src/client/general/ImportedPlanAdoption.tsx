import { useState } from 'react';
import type { GeneralAnalysisPlan } from '../../../../evolver/src/contracts/general-analysis.ts';
type Action = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export function ImportedPlanAdoption(props: { sessionId: string; researchId: string; importId: string; busy: boolean; action: Action }): JSX.Element {
  const [plans, setPlans] = useState<GeneralAnalysisPlan[] | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const load = async () => {
    if (props.busy || loading) return; setLoading(true); setError('');
    try {
      const response = await fetch(`/evolver/research-bootstrap/package?sessionId=${encodeURIComponent(props.sessionId)}&researchId=${encodeURIComponent(props.researchId)}&importId=${encodeURIComponent(props.importId)}`, { credentials: 'same-origin' });
      const body = await response.json(); if (!response.ok) throw new Error(body.message ?? body.error); setPlans(body.general.plans);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  return <div className="stack"><button disabled={props.busy || loading} onClick={() => void load()}>读取历史分析方案</button>
    {plans?.length === 0 && <p className="small muted">历史中没有分析方案。</p>}
    {plans?.map(p => <details key={`${p.planId}:${p.version}`}><summary>{p.title} v{p.version} · {p.method}</summary><p>{p.goal}</p><p className="small">范围 {p.rowRange.start}–{p.rowRange.end}；比较边界：{p.comparisonScope}</p><p className="small">限制：{p.limitations.join('；')}。采纳将绑定当前节点说明和研究契约，材料授权后可保存；历史计算不移入本地结果。</p>
      {p.metricContext ? <p className="small muted">此方案绑定历史指标协议；需先重新冻结当前指标协议，再从分析页面重建方案。</p> : <form onSubmit={async e => { e.preventDefault(); const data = new FormData(e.currentTarget); await props.action('adopt_general_imported_plan', { researchId: props.researchId, importId: props.importId, originalPlanId: p.planId, originalVersion: p.version, reason: String(data.get('reason')) }); }}><label>本地重审与采纳理由<textarea name="reason" required maxLength={4000} /></label><button disabled={props.busy}>采纳为新方案（不执行）</button></form>}
    </details>)}
    {error && <p role="alert" className="error">{error}</p>}
  </div>;
}
