import { useState, type FormEvent } from 'react';
import type { GeneralResearch, GeneralNode } from '../../../../evolver/src/contracts/general-research.ts';
type Action = (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
export function WorkflowEditor({ general: g, researchId, title, node, action, busy }: { general: GeneralResearch; researchId: string; title: string; node?: GeneralNode; action: Action; busy: boolean }): JSX.Element {
  const [mode, setMode] = useState<'node' | 'new' | 'edge' | 'profile' | null>(null);
  const [dirty, setDirty] = useState(false);
  const [editingNode, setEditingNode] = useState<GeneralNode | undefined>(undefined);
  const change = (next: typeof mode) => { if (dirty && g.requireHumanConfirmation && !window.confirm('表单有未保存编辑，是否切换？')) return; setDirty(false); if (next === 'node') setEditingNode(node); setMode(next); };
  const lines = (v: FormDataEntryValue | null) => String(v ?? '').split('\n').map(x => x.trim()).filter(Boolean);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const f = new FormData(event.currentTarget); let saved;
    if (mode === 'profile') saved = await action('save_general_profile', { researchId, profile: {
      requireHumanConfirmation: g.requireHumanConfirmation, title: String(f.get('title')), domains: String(f.get('domains')).split(/[,，]/).map(v => v.trim()).filter(Boolean), methods: f.getAll('methods'), entryMode: String(f.get('entryMode')),
      reference: { status: String(f.get('referenceStatus')), description: String(f.get('referenceDescription')), reason: String(f.get('referenceReason')) }, constraints: lines(f.get('constraints')), pendingQuestions: lines(f.get('questions')),
      limits: { maxAttempts: Number(f.get('maxAttempts')), maxRounds: Number(f.get('maxRounds')), deadline: String(f.get('deadline')).trim() || null },
    } });
    else if (mode === 'edge') saved = await action('save_general_edge', { researchId, edge: { from: String(f.get('from')), to: String(f.get('to')), kind: String(f.get('kind')), condition: String(f.get('kind')) === 'condition' ? String(f.get('condition')) : null } });
    else saved = await action('save_general_node', { researchId, nodeId: mode === 'node' ? editingNode?.nodeId : null, node: { title: String(f.get('title')), kind: String(f.get('kind')), goal: String(f.get('goal')), inputs: mode === 'node' ? node?.inputs ?? [] : [], method: String(f.get('method')), output: String(f.get('output')), completionCriterion: String(f.get('criterion')), join: String(f.get('join')) } });
    if (saved) { setDirty(false); setMode(null); }
  };
  const remove = async (kind: 'node' | 'edge', id: string) => { if (g.requireHumanConfirmation && !window.confirm('删除该图对象？已有产物归属受后端保护，历史仍保留。')) return; await action('remove_general_graph_item', { researchId, kind, id }); };
  const n = mode === 'new' ? undefined : editingNode;
  return <section className="stack" data-workflow-editor>
    <div className="flex wrap"><button disabled={busy || dirty || !g.editHistory.past.length} onClick={() => void action('undo_general_graph_edit', { researchId })}>撤销图编辑（{g.editHistory.past.length}）</button><button disabled={busy || dirty || !g.editHistory.future.length} onClick={() => void action('redo_general_graph_edit', { researchId })}>重做（{g.editHistory.future.length}）</button><button disabled={busy || dirty || !g.editHistory.past.length && !g.editHistory.future.length} onClick={() => { if (window.confirm('清空撤销/重做记录？图版本、产物、运行和审查历史仍保留。')) void action('clear_general_edit_history', { researchId }); }}>清空编辑记录</button></div>
    <div className="flex wrap"><button disabled={busy} onClick={() => change('new')}>＋ 新增节点</button><button disabled={busy || !node} onClick={() => change('node')}>编辑节点</button><button disabled={busy} onClick={() => change('edge')}>添加连接</button><button disabled={busy} onClick={() => change('profile')}>研究契约</button></div>
    <p className="small muted">条件严格匹配审查：部分支持不等于支持；selected 汇合只等待已选有效分支。返工连接不创建执行依赖循环。</p>
    {mode && <form key={`${mode}-${editingNode?.nodeId}`} onSubmit={submit} onChange={() => setDirty(true)} className="stack">
      {mode === 'profile' ? <>
        <label>研究名称<input name="title" required maxLength={300} defaultValue={title} /></label>
        <label>领域（逗号分隔）<input name="domains" defaultValue={g.domains.join(', ')} /></label>
        <label>方法模板（可组合）<select name="methods" multiple defaultValue={g.methods}>{['engineering', 'observation', 'algorithm', 'survey', 'review'].map(m => <option key={m}>{m}</option>)}</select></label>
        <label>入口顺序<select name="entryMode" defaultValue={g.entryMode}><option value="idea_only">只有 Idea</option><option value="existing_data">已有数据</option><option value="design_first">先设计</option></select></label>
        <label>参照适用性<select name="referenceStatus" defaultValue={g.reference.status}><option value="unknown">未知</option><option value="applicable">适用</option><option value="not_applicable">不适用</option></select></label>
        <label>参照说明<textarea name="referenceDescription" defaultValue={g.reference.description} /></label><label>不适用理由<textarea name="referenceReason" defaultValue={g.reference.reason} /></label>
        <label>约束（每行一条）<textarea name="constraints" defaultValue={g.constraints.join('\n')} /></label><label>待确认问题<textarea name="questions" defaultValue={g.pendingQuestions.join('\n')} /></label>
        <label>最多尝试<input type="number" name="maxAttempts" min={1} max={10} defaultValue={g.limits.maxAttempts} required /></label><label>最多轮数<input type="number" name="maxRounds" min={1} max={10} defaultValue={g.limits.maxRounds} required /></label><label>截止时间（ISO，可留空）<input name="deadline" defaultValue={g.limits.deadline ?? ''} /></label>
      </> : mode === 'edge' ? <>
        <label>后续/依赖节点<select name="from" defaultValue={node?.nodeId}>{g.graph.nodes.map(v => <option key={v.nodeId} value={v.nodeId}>{v.title}</option>)}</select></label>
        <label>前置节点<select name="to">{g.graph.nodes.map(v => <option key={v.nodeId} value={v.nodeId}>{v.title}</option>)}</select></label>
        <label>连接类型<select name="kind"><option value="depends_on">执行依赖</option><option value="condition">审查条件</option><option value="derived_from">来源派生</option><option value="feedback">修正/重试关系</option></select></label>
        <label>审查条件（仅条件连接）<select name="condition">{['supported', 'partial', 'not_supported', 'insufficient', 'paused'].map(v => <option key={v}>{v}</option>)}</select></label>
      </> : <>
        <label>节点名称<input name="title" required maxLength={300} defaultValue={n?.title} /></label>
        <label>类型<select name="kind" defaultValue={n?.kind ?? 'manual'}>{['goal', 'materials', 'protocol', 'analysis', 'review', 'decision', 'manual', 'report'].map(v => <option key={v}>{v}</option>)}</select></label>
        <label>研究目标<textarea name="goal" defaultValue={n?.goal} /></label><label>方法/步骤<textarea name="method" defaultValue={n?.method} /></label><label>输出<textarea name="output" defaultValue={n?.output} /></label><label>完成标准<textarea name="criterion" defaultValue={n?.completionCriterion} /></label>
        <label>汇合规则<select name="join" defaultValue={n?.join ?? 'all'}><option value="all">全部前置</option><option value="selected">已选有效分支</option></select></label>
      </>}
      <div className="flex"><button className="primary" disabled={busy}>保存修改</button><button type="button" onClick={() => change(null)}>关闭</button></div>
    </form>}
    {node && <>
      {g.graph.edges.filter(e => e.from === node.nodeId || e.to === node.nodeId).map(e => <div key={e.edgeId} className="small">{g.graph.nodes.find(n => n.nodeId === e.to)?.title} → {g.graph.nodes.find(n => n.nodeId === e.from)?.title} · {e.kind} {e.condition}<button disabled={busy} onClick={() => void remove('edge', e.edgeId)}>删除连接</button></div>)}
      {!['analysis', 'review', 'decision'].includes(node.kind) && g.requireHumanConfirmation && <form onSubmit={async ev => { ev.preventDefault(); const f = new FormData(ev.currentTarget); await action('confirm_general_manual_node', { researchId, nodeId: node.nodeId, reason: String(f.get('reason')), sourceRefs: f.getAll('sourceRefs') }); }}>
        <label>人工确认理由<textarea name="reason" required /></label><label>已登记资料<select name="sourceRefs" multiple>{g.sources.map(s => <option key={s.sourceId} value={s.sourceId}>{s.filename}</option>)}</select></label><button disabled={busy}>确认当前节点输入与交付</button>
      </form>}
      <button disabled={busy} onClick={() => void remove('node', node.nodeId)}>删除无历史事实的节点</button>
    </>}
  </section>;
}
