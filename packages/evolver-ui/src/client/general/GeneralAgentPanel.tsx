/**
 * U4 Agent 协作页（参考 agent.html A01–A07 + F04 三类执行种类 + F05 条件投影）。
 *
 * 事实来源：analysisProjection.nextActions、generalNodeStates、来源授权决策、
 * executionCapabilities、已保存方案/草稿回执。四种浏览器内假状态（phase/confirmed 原型态）
 * 全部替换为真实回执驱动的状态；保存不执行，启动只认已保存版本。
 */
import { useEffect, useState, type CSSProperties } from 'react';
import type { GeneralResearch } from '../../../../evolver/src/contracts/general-research.ts';
import type { GeneralNodeState } from '../../../../evolver/src/contracts/general-workflow.ts';
import type { ResearchCycleData } from '../integration/research-cycle-view.ts';
import { GeneralTeamPanel } from './GeneralTeamPanel.tsx';

type Action = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
type Kind = 'descriptive' | 'inference' | 'team';
const KIND_LABEL: Record<Kind, string> = { descriptive: '描述统计（白名单计算）', inference: '推断检验（Welch 等）', team: 'Team 分析（已有证据）' };

export function GeneralAgentPanel(props: {
  general: GeneralResearch; researchId: string; sessionId: string;
  workflow: GeneralNodeState[]; analysis?: { nextActions: Array<{ kind: string; label: string; reason: string; nodeId: string; page: string }> } | null;
  cycle: ResearchCycleData | null; schedules: Array<{ scheduleId: string; status: string; tasks: Array<{ taskId: string; nodeId: string; status: string }> }>;
  action: Action; cycleAction: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  busy: boolean; refresh: () => Promise<void>;
  onLocate: (page: 'tree' | 'agent' | 'wiki', sub: string) => void;
}): JSX.Element {
  const g = props.general;
  const [kind, setKind] = useState<Kind>('descriptive');
  const [sourceSel, setSourceSel] = useState<string[]>(g.sources.slice(0, 3).map(s => s.sourceId));
  const [confirmed, setConfirmed] = useState(false);
  const [planKey, setPlanKey] = useState('');
  const [inferenceKey, setInferenceKey] = useState('');
  const [draft, setDraft] = useState<{ draftId: string; revision: number } | null>(null);
  const [mode, setMode] = useState<'basic' | 'adv'>('basic');
  const [teamNode, setTeamNode] = useState('');
  const analysisPlans = g.plans;
  const inferencePlans = g.inferencePlans;
  const drafts = g.teamTaskDrafts.filter(d => d.status === 'draft');
  const latestDraft = drafts.at(-1) ?? null;
  const analysisNodes = g.graph.nodes.filter(n => n.kind === 'analysis');

  // 来源授权决策（每个来源取最新一条）。
  const accessOf = (sourceId: string): boolean => {
    const decisions = g.sourceAccess.filter(a => a.sourceId === sourceId);
    return decisions.length === 0 ? true : decisions.at(-1)!.allowed;
  };
  // A02：来源变动清除确认；恢复本地权限后该来源自动纳入并清除旧确认。
  const toggleSource = (id: string) => { setConfirmed(false); if (draft) setDraft(null); setSourceSel(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]); };
  const restoreSource = async (id: string) => {
    const saved = await props.action('set_general_source_access', { researchId: props.researchId, sourceId: id, allowed: true, reason: '本地授权恢复（Agent 页）；恢复权限不代表科学结论通过审查，也不会自动运行任务。' });
    if (saved && !sourceSel.includes(id)) toggleSource(id);
  };
  useEffect(() => { setConfirmed(false); }, [kind, g.revision]);

  // F04 三类的“已保存版本”。
  const selectedPlan = analysisPlans.find(p => `${p.planId}:${p.version}` === planKey) ?? analysisPlans.at(-1) ?? null;
  const selectedInference = inferencePlans.find(p => `${p.planId}:${p.version}` === inferenceKey) ?? inferencePlans.at(-1) ?? null;
  const savedForKind: { ok: boolean; label: string; detail: string } =
    kind === 'descriptive' ? (selectedPlan
      ? { ok: true, label: `${selectedPlan.title} · v${selectedPlan.version}`, detail: `冻结：数据字典 v${selectedPlan.dataset.version} · 节点 ${g.graph.nodes.find(n => n.nodeId === selectedPlan.nodeId)?.title ?? selectedPlan.nodeId}` }
      : { ok: false, label: '尚无已保存的描述方案', detail: '在「分析与结果」页保存方案；来源与字典版本在方案内冻结。' })
      : kind === 'inference' ? (selectedInference
        ? { ok: true, label: `${selectedInference.title} · v${selectedInference.version}`, detail: `冻结：数据字典 v${selectedInference.dataset.version} · ${selectedInference.spec.method ?? '推断'} 置信度 ${selectedInference.spec.confidence ?? '—'}` }
        : { ok: false, label: '尚无已保存的推断方案', detail: '在「推断检验」页保存方案后再授权执行。' })
        : (latestDraft
          ? { ok: true, label: `${latestDraft.title} · 草稿 r${latestDraft.revision}`, detail: `冻结：来源 ${latestDraft.sources.map(s => `${g.sources.find(x => x.sourceId === s.sourceId)?.filename ?? s.sourceId} v${s.revision}`).join('、') || '无'} · Idea ${latestDraft.ideaRevision ?? '—'} · 契约 r${latestDraft.profileRevision}` }
          : { ok: false, label: '尚无已保存的 Team 任务草稿', detail: '在下方表单保存任务输入；启动时校验草稿与当前研究一致。' });

  // A04 运行条件：逐项 ck，第一项未满足高亮。
  const conditions = [
    { title: '分析方法与数据范围已确认', ok: confirmed && (kind === 'team' ? sourceSel.length > 0 : savedForKind.ok), note: kind === 'team' ? '勾选「我已检查」并至少纳入 1 个来源' : '方案内已冻结来源与字典版本；此处确认本次授权范围' },
    { title: '方案已保存（不执行）', ok: savedForKind.ok, note: savedForKind.detail },
    { title: '已显式授权执行一次', ok: false, note: '授权后按已保存版本启动；不授权真实实验或下一轮' },
  ];
  const firstOpen = conditions.findIndex(c => !c.ok);
  const statusText = kind === 'team' && props.cycle?.runs.some(r => ['queued', 'running', 'waiting_result', 'cancelling'].includes(r.status)) ? '已提交 Team 分析' : savedForKind.ok ? '方案已保存 · 待授权' : '暂不能执行';
  const statusChip = statusText === '已提交 Team 分析' ? 'chip-done' : statusText === '方案已保存 · 待授权' ? 'chip-warn' : 'chip-block';
  const reason = statusText === '已提交 Team 分析' ? '已提交：Team 分析已获授权，按已保存草稿冻结输入。'
    : !conditions[0].ok ? `还不能运行：${conditions[0].note}`
      : !savedForKind.ok ? `还不能运行：${savedForKind.label}。`
        : '还不能运行：方案已保存，但还没有你的显式授权。';

  const saveTeamDraft = async (form: HTMLFormElement) => {
    const f = new FormData(form);
    const saved = await props.action('save_general_team_task', { researchId: props.researchId, draftId: draft?.draftId ?? null, draft: {
      nodeId: String(f.get('nodeId') ?? ''), title: String(f.get('title') ?? ''), goal: String(f.get('goal') ?? ''),
      method: String(f.get('method') ?? ''), completionCriterion: String(f.get('criterion') ?? ''), sourceIds: sourceSel,
    } });
    if (saved) { setDraft({ draftId: saved.draftId as string, revision: saved.draftRevision as number }); setConfirmed(false); }
  };
  const startKind = async () => {
    if (kind === 'descriptive' && selectedPlan) {
      await props.action('calculate_general_descriptive', { researchId: props.researchId, planId: selectedPlan.planId, planVersion: selectedPlan.version, authorize: true });
    } else if (kind === 'inference' && selectedInference) {
      await props.action('execute_general_inference', { researchId: props.researchId, planId: selectedInference.planId, planVersion: selectedInference.version, authorize: true });
    }
    // Team 启动走 GeneralTeamPanel（携带 taskDraftId）；此处不重复发起。
  };

  // F05 推荐卡数据：真实投影，不固定文案。
  const nextAction = props.analysis?.nextActions[0] ?? null;
  const blockedNode = props.workflow.find(w => w.status === 'blocked');
  const prepared = [
    { label: '已登记来源', value: `${g.sources.length} 项`, note: g.sources.slice(0, 2).map(s => `${s.filename} v${s.revision} · ${s.nature}`).join('；') || '尚无' },
    { label: '已保存方案', value: `描述 ${analysisPlans.length} · 推断 ${inferencePlans.length} · Team 草稿 ${drafts.length}`, note: '保存不执行；启动只认已保存版本' },
    { label: '执行能力', value: '描述 / 推断 可用', note: 'Team 依赖宿主运行时；真实训练 / GPU / 仪器未接入' },
  ];
  const pendingChecks = [
    ...(blockedNode ? [{ label: `前置阻塞：${g.graph.nodes.find(n => n.nodeId === blockedNode.nodeId)?.title ?? blockedNode.nodeId}`, reason: blockedNode.reason }] : []),
    ...g.sources.filter(s => !accessOf(s.sourceId)).map(s => ({ label: `来源权限已撤销：${s.filename}`, reason: '撤权后正文与图谱缓存同步失效；可在来源行恢复本地权限' })),
    ...g.pendingQuestions.slice(0, 2).map(q => ({ label: '待确认问题', reason: q })),
  ];
  const currentStep = !conditions[0].ok ? 1 : !savedForKind.ok ? 2 : statusText !== '已提交 Team 分析' ? 3 : 4;
  const stepDefs = [
    ['检查建议', '显示推荐的方法与数据范围，供你核对。', '保存或运行任何内容。'],
    ['保存方案', '冻结来源版本与研究上下文，保存结构化方案或任务草稿。', '启动任何运行。'],
    ['显式授权执行', '按已保存版本启动：描述计算 / 推断 / Team 分析，各一次。', '授权真实实验，或自动开启下一轮。'],
    ['查看产物与证据缺口', '列出产物、证据缺口与未知项。', '把「已完成」当作假设得到支持。'],
  ];

  return <div className="stack" data-general-agent>
    <div className="card" style={{ borderRadius: 16 }}>
      <div className="card-head" style={{ padding: '16px 22px', borderBottom: '1px solid #e4ece7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <h2 style={{ font: '700 17px Georgia,"Noto Serif SC",serif' }}>下一步推荐</h2>
        <span className={`chip ${statusChip}`} role="status">{statusText}</span>
      </div>
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(260px,100%),1fr))', gap: 14 }}>
        <div>
          <div className="small muted">推荐任务</div>
          <strong style={{ display: 'block', margin: '4px 0' }}>{nextAction?.label ?? (g.sources.length === 0 ? '资料与数据整理' : '确认数据字典、条件与分析协议')}</strong>
          <p className="small muted">{nextAction?.reason ?? '根据当前登记材料推荐；规划不等于已执行。'}</p>
        </div>
        {prepared.map(p => <div key={p.label}><div className="small muted">{p.label}</div><strong style={{ display: 'block', margin: '4px 0' }}>{p.value}</strong><p className="small muted">{p.note}</p></div>)}
      </div>
      <div className="card-body" style={{ borderTop: '1px solid #e4ece7', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="small muted">待确认项</div>
        {pendingChecks.length === 0 && <p className="small muted">暂无阻塞或待确认项；未知保持未知。</p>}
        {pendingChecks.map((c, i) => <p key={i} className="small" style={{ color: '#7A4100' }}>· {c.label}：{c.reason}</p>)}
      </div>
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(250px,100%),1fr))', gap: 14 }}>
      {stepDefs.map(([title, will, wont], i) => {
        const n = i + 1, state = n < currentStep ? 'done' : n === currentStep ? 'current' : 'todo';
        const dotStyle: CSSProperties = state === 'done'
          ? { flex: '0 0 28px', width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 13, border: '2px solid #14575C', background: '#14575C', color: '#fff' }
          : state === 'current'
            ? { flex: '0 0 28px', width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 13, border: '2px solid #14575C', background: '#fff', color: '#14575C', boxShadow: '0 0 0 4px #D2E6E4' }
            : { flex: '0 0 28px', width: 28, height: 28, borderRadius: '50%', display: 'grid', placeItems: 'center', fontWeight: 600, fontSize: 13, border: '2px solid #AAB6B2', background: '#fff', color: '#46534F' };
        const titleStyle: CSSProperties = { fontWeight: 600, ...(state === 'current' ? { color: '#14575C' } : state === 'todo' ? { color: '#566460' } : {}) };
        return <div key={title} className="stp card" data-s={state} style={{ borderRadius: 14, padding: '18px 18px 20px', display: 'flex', flexDirection: 'column', gap: 10, ...(state === 'current' ? { borderColor: '#14575C', boxShadow: '0 0 0 1px #14575C' } : state === 'todo' ? { background: '#F8F9F8' } : {}) }}>
          <div className="flex"><span className="dot" style={dotStyle}>{state === 'done' ? '✓' : n}</span><b style={titleStyle}>{title}</b></div>
          <dl style={{ margin: 0 }}><dt className="small" style={{ color: '#566460', fontWeight: 600 }}>会做</dt><dd className="small" style={{ margin: 0 }}>{will}</dd><dt className="small" style={{ color: '#566460', fontWeight: 600, marginTop: 6 }}>不会做</dt><dd className="small" style={{ margin: 0 }}>{wont}</dd></dl>
        </div>;
      })}
    </div>

    <div className="card" style={{ borderRadius: 16 }}>
      <div className="card-head" style={{ padding: '16px 22px', borderBottom: '1px solid #e4ece7', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div className="flex">
          <h2 style={{ font: '700 17px Georgia,"Noto Serif SC",serif', marginRight: 12 }}>方案与授权</h2>
          <div className="flex">{(Object.keys(KIND_LABEL) as Kind[]).map(k => <button key={k} className="seg" aria-pressed={kind === k} onClick={() => { setKind(k); setConfirmed(false); setDraft(null); }}>{KIND_LABEL[k]}</button>)}</div>
        </div>
        <div className="flex">
          <button className="seg" aria-pressed={mode === 'basic'} onClick={() => setMode('basic')}>基础</button>
          <button className="seg" aria-pressed={mode === 'adv'} onClick={() => setMode('adv')}>高级</button>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,480px) minmax(0,320px)', gap: 0, alignItems: 'stretch' }}>
        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <div className="small muted">执行种类：{KIND_LABEL[kind]}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="small muted">来源（{kind === 'team' ? '保存草稿时冻结版本' : '方案内冻结；此处展示状态'}）</div>
            {g.sources.map(s => {
              const allowed = accessOf(s.sourceId);
              return <div key={s.sourceId} className="flex between" style={{ gap: 8, border: '1px solid #C3CCC9', borderRadius: 12, padding: '10px 12px' }}>
                <label className="flex small" style={{ minWidth: 0 }}>
                  <input type="checkbox" style={{ width: 'auto' }} checked={sourceSel.includes(s.sourceId)} disabled={!allowed || kind !== 'team' || props.busy} onChange={() => toggleSource(s.sourceId)} />
                  <span style={{ overflowWrap: 'anywhere' }}>{s.filename} <span className="small muted">v{s.revision} · {s.nature}</span></span>
                </label>
                <span className="flex" style={{ flexWrap: 'nowrap' }}>
                  {!allowed && <span className="chip chip-danger">权限已撤销</span>}
                  {allowed && s.nature === 'simulation' && <span className="chip chip-warn">明确模拟</span>}
                  {!allowed && <button className="link" onClick={() => void restoreSource(s.sourceId)}>恢复本地权限</button>}
                </span>
              </div>;
            })}
            {g.sources.length === 0 && <p className="small muted">尚无已登记来源；保存草稿前需要至少一项可在 Team 中使用。</p>}
          </div>
          {kind === 'team' && <>
            <form onSubmit={e => { e.preventDefault(); void saveTeamDraft(e.currentTarget); }} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <label style={{ margin: 0 }}>任务节点（分析节点）<select name="nodeId" value={teamNode || (analysisNodes[0]?.nodeId ?? '')} onChange={e => { setTeamNode(e.target.value); setConfirmed(false); setDraft(null); }} disabled={props.busy}>{analysisNodes.map(n => <option key={n.nodeId} value={n.nodeId}>{n.title}</option>)}</select></label>
              <label style={{ margin: 0 }}>任务标题<input name="title" required maxLength={300} defaultValue={latestDraft?.title ?? ''} key={`t-${latestDraft?.revision ?? 0}`} /></label>
              <label style={{ margin: 0 }}>任务目标<input name="goal" maxLength={4000} defaultValue={latestDraft?.goal ?? ''} key={`g-${latestDraft?.revision ?? 0}`} /></label>
              <label style={{ margin: 0 }}>任务说明 / 方法边界<textarea name="method" rows={3} maxLength={4000} defaultValue={latestDraft?.method ?? ''} key={`m-${latestDraft?.revision ?? 0}`} /></label>
              <label style={{ margin: 0 }}>完成标准<input name="criterion" maxLength={4000} defaultValue={latestDraft?.completionCriterion ?? '来源与实际产物可检查'} key={`c-${latestDraft?.revision ?? 0}`} /></label>
              <div><button className="btn btn-primary" disabled={props.busy || !confirmed}>保存任务草稿（不执行）</button></div>
            </form>
            {draft && <p className="small muted" role="status">已保存草稿 {draft.draftId.slice(0, 12)} r{draft.revision}；启动时校验上下文与来源版本，变化即拒绝。</p>}
          </>}
        </div>
        <div style={{ padding: '18px 22px', borderLeft: '1px solid #e4ece7', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="small muted">已保存版本（启动只认这些）</div>
          <div>
            <strong style={{ display: 'block', fontSize: 14 }}>{savedForKind.label}</strong>
            <p className="small muted">{savedForKind.detail}</p>
          </div>
          {kind === 'descriptive' && <>
            {analysisPlans.length > 0 && <label style={{ margin: 0 }}>授权的方案版本<select value={planKey || `${analysisPlans.at(-1)!.planId}:${analysisPlans.at(-1)!.version}`} onChange={e => { setPlanKey(e.target.value); setConfirmed(false); }} disabled={props.busy}>{analysisPlans.map(p => <option key={`${p.planId}:${p.version}`} value={`${p.planId}:${p.version}`}>{p.title} · v{p.version} · 字典 v{p.dataset.version}</option>)}</select></label>}
            <div><button className="link" onClick={() => props.onLocate('agent', 'results')}>设计与保存描述方案 →</button></div>
          </>}
          {kind === 'inference' && <>
            {inferencePlans.length > 0 && <label style={{ margin: 0 }}>授权的推断方案版本<select value={inferenceKey || `${inferencePlans.at(-1)!.planId}:${inferencePlans.at(-1)!.version}`} onChange={e => { setInferenceKey(e.target.value); setConfirmed(false); }} disabled={props.busy}>{inferencePlans.map(p => <option key={`${p.planId}:${p.version}`} value={`${p.planId}:${p.version}`}>{p.title} · v{p.version}</option>)}</select></label>}
            <div><button className="link" onClick={() => props.onLocate('agent', 'inference')}>设计与保存推断方案 →</button></div>
          </>}
          <label className="chk" style={{ display: 'flex', alignItems: 'flex-start', gap: 12, minHeight: 44, padding: '12px 14px', border: '1px solid #C3CCC9', borderRadius: 12, background: '#fff', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 20, height: 20, margin: '2px 0 0', accentColor: '#14575C', flex: '0 0 20px' }} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            <span className="small">我已检查{kind === 'team' ? '来源范围与任务说明' : '方案版本与冻结引用'}；确认随来源/方案变化失效。</span>
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 14px', background: '#F2F4F3', borderRadius: 12 }}>
            {conditions.map((c, i) => <div key={c.title} className="flex" style={{ alignItems: 'flex-start', gap: 10, padding: '6px 0', ...(i === firstOpen ? { fontWeight: 650 } : {}) }}>
              <span className="ck" data-k={c.ok ? 'ok' : i === firstOpen ? 'no' : 'na'} style={{ flex: '0 0 22px', width: 22, height: 22, borderRadius: '50%', display: 'grid', placeItems: 'center', border: '2px solid #AAB6B2', color: '#fff', fontSize: 12, fontWeight: 700, ...(c.ok ? { background: '#14575C', borderColor: '#14575C' } : i === firstOpen ? { background: '#8E2A1E', borderColor: '#8E2A1E' } : { color: '#566460' }) }}>{c.ok ? '✓' : i === firstOpen ? '×' : '—'}</span>
              <span className="small" style={{ minWidth: 0 }}><b style={{ fontWeight: 600 }}>{c.title}</b><br /><span className="small muted">{c.note}</span></span>
            </div>)}
          </div>
          <p className="small" role="status">{reason}</p>
          {kind !== 'team' && <button className="btn btn-primary" disabled={props.busy || !confirmed || !savedForKind.ok} onClick={() => void startKind()}>授权并执行一次（{kind === 'descriptive' ? '白名单计算' : '推断检验'}）</button>}
          {kind === 'team' && <p className="small muted">启动入口在下方 Team 面板：携带已保存草稿，显式授权后一次启动。</p>}
        </div>
      </div>
    </div>

    {kind === 'team' && <GeneralTeamPanel
      general={g} researchId={props.researchId} sessionId={props.sessionId}
      nodeId={teamNode || (analysisNodes[0]?.nodeId ?? g.graph.nodes[0]?.nodeId ?? '')}
      refresh={props.refresh} adoptAction={props.action}
      taskDraftId={draft?.draftId}
      taskDraftSources={draft ? latestDraft?.sources.map(s => s.sourceId) : undefined}
    />}
    {kind !== 'team' && mode === 'adv' && <div className="card" style={{ borderRadius: 16, padding: 18 }}>
      <h3 style={{ font: '700 15px Georgia,"Noto Serif SC",serif', marginBottom: 8 }}>运行历史（高级）</h3>
      {(kind === 'descriptive' ? g.calculations : g.inferenceRuns).length === 0 && <p className="small muted">暂无运行记录。</p>}
      {(kind === 'descriptive' ? g.calculations.map(c => ({ id: c.calculationId, status: c.status, label: g.plans.find(p => p.planId === c.planId)?.title ?? c.planId, extra: c.firstError ? `首错 ${c.firstError.code}` : '' })) : g.inferenceRuns.map(r => ({ id: r.runId, status: r.status, label: g.inferencePlans.find(p => p.planId === r.planId)?.title ?? r.planId, extra: r.firstError ? `首错 ${r.firstError.code}` : '' }))).slice(-6).reverse().map(r => <p key={r.id} className="small">{r.label} · {r.status}{r.extra ? ` · ${r.extra}` : ''} · {r.id.slice(0, 12)}</p>)}
      <p className="small muted">Team 运行历史在 Team 面板（高级队列与运行记录见「研究实验树 → 有限队列」）。</p>
    </div>}
  </div>;
}
