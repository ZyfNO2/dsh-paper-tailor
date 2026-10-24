import { useState } from 'react';
import type { BootstrapWire } from '../../../packages/evolver-ui/src/client/integration/research-bootstrap-view.ts';
import type { ResearchCycleData } from '../../../packages/evolver-ui/src/client/integration/research-cycle-view.ts';

/** Explicit standalone transport alongside the original Studio, without imitating native Team dispatch. */
export function ExternalHandoff({ workspace, bootstrap, cycle, refresh }: { workspace: string; bootstrap: BootstrapWire; cycle: ResearchCycleData | null; refresh: () => Promise<void> }) {
  const research = bootstrap.researches.find((r) => r.researchId === bootstrap.activeResearchId);
  const [ideaId, setIdeaId] = useState(''), [nodeId, setNodeId] = useState(''), [sourceIds, setSourceIds] = useState<string[]>([]);
  const [authorized, setAuthorized] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  if (!research || !cycle) return null;
  const ideas = research.general ? research.general.ideas.map((i) => ({ id: i.ideaId, title: i.question })) : research.ideas.filter((i) => bootstrap.selectedIdeaIds.includes(i.ideaId)).map((i) => ({ id: i.ideaId, title: i.title }));
  const nodes = research.general?.graph.nodes ?? [{ nodeId: '', title: '原候选假设' }, ...cycle.effectiveGraph.nodes.filter(n => n.nodeId.startsWith('followup-') && n.kind === 'next_action' && !n.artifactRef)];
  const selectedIdea = ideas.some((i) => i.id === ideaId) ? ideaId : ideas[0]?.id;
  const selectedNode = nodes.some((n) => n.nodeId === nodeId) ? nodeId : nodes[0]?.nodeId;
  const act = async (payload: Record<string, unknown>) => {
    setBusy(true); setMessage('');
    try {
      const response = await fetch(`/api/dsh/external-cycle?${new URLSearchParams({ workspaceDir: workspace, researchId: research.researchId })}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, operationId: crypto.randomUUID(), authorize: true, cycleRevision: cycle.research.cycleRevision }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.error ?? `HTTP ${response.status}`);
      setMessage(payload.action === 'cancel' ? '已关闭本轮提交通道；未验证远端进程已停止。' : result.message ?? '已登记。产物审查仍标记 self_review。');
      setAuthorized(false); await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <details><summary>外部 Agent 交接与恢复</summary>
    <p>由外部 MCP 客户端主动接单。这里不会启动原生 Team 或模型；审查统一标记 self_review。先在运行详情核对产物，再明确采纳。</p>
    <label>候选<select aria-label="交接候选" value={selectedIdea ?? ''} onChange={(e) => setIdeaId(e.target.value)}>{ideas.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}</select></label>
    {!!nodes.length && <label>任务节点<select aria-label="交接任务节点" value={selectedNode ?? ''} onChange={(e) => setNodeId(e.target.value)}>{nodes.map((n) => <option key={n.nodeId} value={n.nodeId}>{n.title}</option>)}</select></label>}
    {!!research.general?.sources.length && <fieldset><legend>本轮允许读取的资料</legend>{research.general.sources.map((s) => <label key={s.sourceId}><input type="checkbox" style={{ width: 'auto' }} checked={sourceIds.includes(s.sourceId)} onChange={(e) => setSourceIds((ids) => e.target.checked ? [...ids, s.sourceId] : ids.filter((id) => id !== s.sourceId))} />{s.filename}</label>)}</fieldset>}
    <p><label><input type="checkbox" style={{ width: 'auto' }} checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />我授权下一次交接、取消、重试或采纳操作</label></p>
    <button disabled={!authorized || busy || !selectedIdea} onClick={() => void act({ action: 'prepare', ideaId: selectedIdea, baseRevision: bootstrap.revision, ...(research.general ? { nodeId: selectedNode, sourceIds } : selectedNode ? { nodeId: selectedNode } : {}) })}>准备外部交接</button>
    {cycle.runs.filter((r) => r.externalHandoff).map((run) => <div key={run.runId}><p>第 {run.round} 轮 · {run.status} · self_review · {run.runId}</p>
      {cycle.steps.filter((s) => s.runId === run.runId).map((s) => <p key={s.stepId}>{s.role} · {s.status} · {s.assignedMemberId ?? '尚未接单'}<small> · attempt {s.attemptId}</small>{['failed', 'cancelled', 'interrupted'].includes(s.status) && <button disabled={!authorized || busy} onClick={() => void act({ action: 'retry', runId: run.runId, stepId: s.stepId, baseRevision: bootstrap.revision })}>重试此步骤</button>}</p>)}
      {['queued', 'running', 'waiting_result', 'cancelling'].includes(run.status) && <button disabled={!authorized || busy} onClick={() => void act({ action: 'cancel', runId: run.runId })}>关闭本轮提交通道</button>}
      {run.status === 'waiting_result' && cycle.steps.filter((s) => s.runId === run.runId && s.role === 'reviewer' && s.status === 'completed').map((s) => <button key={s.stepId} disabled={!authorized || busy} onClick={() => void act({ action: 'apply', runId: run.runId, decisionRef: s.outputRefs[0] })}>采纳已核对的 self_review 决策</button>)}
      {run.status === 'completed' && cycle.decisions.filter((d) => d.runId === run.runId).map((d) => <section key={d.decisionRef?.sha256} aria-label="后续建议采纳"><p>逐条采纳为待执行分支；不会自动运行或升级证据。</p>{d.nextActions?.map((a) => <div key={a.actionId}><strong>{a.title}</strong><p>{a.detail}</p><button disabled={!authorized || busy} onClick={() => void act({ action: 'adopt_action', runId: run.runId, decisionRef: d.decisionRef, actionId: a.actionId })}>采纳为待执行分支：{a.title}</button></div>)}</section>)}
    </div>)}
    {message && <p role="status">上次操作回执：{message}</p>}
  </details>;
}
