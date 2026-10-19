import type { FormEvent } from 'react';
import type { GeneralResearch } from '../../../../evolver/src/contracts/general-research.ts';

type Action = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

export function SourceAccessPanel({ general, researchId, action, busy, onChanged }: { general: GeneralResearch; researchId: string; action: Action; busy: boolean; onChanged(sourceId: string): void }): JSX.Element {
  async function submit(event: FormEvent<HTMLFormElement>, sourceId: string, allowed: boolean) {
    event.preventDefault();
    const form = event.currentTarget, reason = String(new FormData(form).get('reason') ?? '').trim();
    if (busy || !reason) return;
    const saved = await action('set_general_source_access', { researchId, sourceId, allowed, reason });
    if (saved) { form.reset(); onChanged(sourceId); }
  }
  return <section className="panel" data-general-source-access><div className="panel-head"><h2>来源证据使用权限</h2></div><div className="panel-body stack">
    <p className="small muted">逐个来源明确授权或撤销并记录理由。导入研究的材料须在本地重新授权；恢复权限不代表科学结论通过审查，也不会自动运行任务。历史资料保留，后续任务与报告仍由后端检查权限。</p>
    {general.sources.map(source => {
      const history = general.sourceAccess.filter(d => d.sourceId === source.sourceId);
      const latest = history.at(-1), allowed = latest?.allowed ?? true;
      return <div key={source.sourceId} role="group" aria-label={'来源权限：' + source.filename}>
        <div className="flex"><strong>{source.filename} · 来源 v{source.revision}</strong><span className={`badge ${allowed ? '' : 'amber'}`} role="status">{allowed ? '允许使用' : '权限已撤销 / 待本地授权'}</span></div>
        <p className="small muted">来源 ID：{source.sourceId}</p>
        <form key={latest?.decisionId ?? 'initial'} className="stack" onSubmit={event => void submit(event, source.sourceId, !allowed)}>
          <label>权限变更理由<textarea name="reason" required maxLength={4000} disabled={busy} /></label>
          <button disabled={busy}>{allowed ? '撤销使用权限' : '恢复使用权限（本地授权）'}</button>
        </form>
        <details><summary>权限历史（{history.length} 条）</summary>{history.length ? history.map(d => <p className="small" key={d.decisionId}>{d.allowed ? '允许使用' : '撤销使用'} · {d.createdAt} · {d.actor.identity}<br />{d.reason}</p>) : <p className="small muted">本地登记来源默认允许使用；尚无权限变更记录。</p>}</details>
      </div>;
    })}
    {!general.sources.length && <p className="muted">尚无来源，登记材料后可管理权限。</p>}
  </div></section>;
}
