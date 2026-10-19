import { useState } from 'react';
import { useWorkbench } from './WorkbenchView.tsx';
import { newOperationId } from './research-actions.ts';

/** Native roster/task projections alongside the authoritative research steps. */
export function ResearchTeamPanel({ nodeId }: { nodeId?: string }): JSX.Element | null {
  const { snapshot, emit } = useWorkbench();
  const cycle = snapshot.cycle;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  if (!cycle) return null;
  const run = cycle.runs.find((r) => r.runId === cycle.research.activeRunId);
  const running = run && ['queued', 'running', 'waiting_result', 'cancelling'].includes(run.status);
  const node = snapshot.tree.data?.nodes.find((entry) => entry.id === nodeId);
  const steps = cycle.steps.filter((step) => !nodeId || step.nodeId === nodeId || step.outputRefs.some((ref) => node?.links.some((link) => link.key === ref.id)));
  const action = async (stepId?: string) => {
    if (!run) return;
    setPending(true); setError(null);
    try {
      const common = { researchId: cycle.research.researchId, baseRevision: snapshot.bootstrap?.data?.revision ?? 0, cycleRevision: cycle.research.cycleRevision, operationId: newOperationId('team-action'), runId: run.runId };
      const outcome = await emit(stepId ? { ...common, type: 'retry_cycle', stepId } : { ...common, type: 'cancel_cycle' });
      if (!outcome.ok) setError(outcome.reason ?? outcome.message);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  const read = async (ref: { id: string; sha256: string }) => {
    try {
      const response = await fetch(`/evolver/research-cycle/artifacts?sessionId=${encodeURIComponent(snapshot.task.taskKey)}&researchId=${encodeURIComponent(cycle.research.researchId)}&id=${encodeURIComponent(ref.id)}&sha256=${encodeURIComponent(ref.sha256)}`, { credentials: 'same-origin' });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.message ?? body.error);
      setDetail(JSON.stringify(body.content, null, 2));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  const trace = async (memberId: string) => {
    try {
      const response = await fetch(`/evolver/research-cycle/trace?sessionId=${encodeURIComponent(snapshot.task.taskKey)}&researchId=${encodeURIComponent(cycle.research.researchId)}&memberId=${encodeURIComponent(memberId)}`, { credentials: 'same-origin' });
      const body = await response.json();
      if (!response.ok || body.ok === false) throw new Error(body.message ?? body.error);
      setDetail(JSON.stringify(body, null, 2));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  return <div data-research-team-panel>
    <h4>{nodeId ? '节点 Worker' : 'Team Monitor'} <span className="rc-tag">{cycle.runtime?.mode ?? '执行器状态未提供'}</span></h4>
    {cycle.runtime?.reason && <p className="rc-warning" role="status">{cycle.runtime.reason}</p>}
    {run?.error && <p className="rc-warning" role="alert">整轮 {run.status}：{run.error.message}</p>}
    {cycle.runtime?.limits && <p className="rc-muted">串行 · 1 轮 / 4 角色 · 每成员最多 16 模型步、24 工具调用 · 10 分钟截止 · 费用不可用</p>}
    {steps.map((step) => {
      const member = cycle.runtime?.members?.find((m) => m.id === step.assignedMemberId);
      const task = cycle.runtime?.tasks?.find((t) => t.id === step.nativeTask?.taskId);
      return <details key={`${step.stepId}-${step.attemptId}`} open={step.status === 'running' || step.status === 'failed'} style={{ border: '1px solid var(--rd-border)', borderRadius: 6, padding: 8, marginBottom: 6 }}>
        <summary style={{ cursor: 'pointer' }}><strong>{step.role}</strong><span className="rc-tag">{step.status}</span><span className="rc-muted">{member?.name ?? (step.assignedMemberId ? '成员暂不可用' : '等待分配')}</span></summary>
        <p className="rc-muted">成员运行：{member?.status ?? '未启动'} · {member?.model ?? '模型未提供'}<br />原生任务：{task ? `${task.id} · ${task.status} · rev ${task.revision}` : '未映射'}<br />Attempt：{step.attemptId}</p>
        {step.blocking.length > 0 && <p>等待上游：{step.blocking.join(', ')}</p>}
        {step.error && <p className="rc-warning" role="alert">{step.error.message}</p>}
        {member?.diagnostics.map((d) => <p key={d} className="rc-warning">{d}</p>)}
        <div>输入 {step.inputRefs.length} / 产物 {step.outputRefs.length}</div>
        {step.inputRefs.map((input, i) => <div key={i}>{input.kind === 'artifact' && input.ref.id && input.ref.sha256 ? <button className="rc-link" onClick={() => void read(input.ref as { id: string; sha256: string })}>输入 {i + 1} · 查看</button> : <button className="rc-link" onClick={() => setDetail(JSON.stringify(input.ref, null, 2))}>输入 {i + 1} · 文献证据</button>}</div>)}
        {step.outputRefs.map((ref) => <div key={ref.id}><button className="rc-link" onClick={() => void read(ref)}>产物 · {ref.id}</button></div>)}
        {step.assignedMemberId && <button className="rc-btn" onClick={() => void trace(step.assignedMemberId!)}>原生运行记录</button>}
        {!running && ['failed', 'interrupted', 'cancelled'].includes(step.status) && <button className="rc-btn" disabled={pending || cycle.runtime?.available === false} onClick={() => void action(step.stepId)}>重试此步骤</button>}
        <p className="rc-muted">任务状态来自原生 Team；步骤完成须通过产物验收。写入范围是协作提示，非文件隔离。</p>
      </details>;
    })}
    {!steps.length && <p className="rc-muted">尚无分配到{nodeId ? '此节点' : '当前研究'}的 Worker。</p>}
    {running && <button className="rc-btn" disabled={pending} onClick={() => void action()}>停止 Team 循环</button>}
    {error && <p className="rc-warning" role="alert">{error}</p>}
    {detail && <div><button className="rc-btn" onClick={() => setDetail(null)}>关闭产物</button><pre style={{ whiteSpace: 'pre-wrap', maxHeight: 280, overflow: 'auto', fontSize: 10 }}>{detail}</pre></div>}
  </div>;
}
