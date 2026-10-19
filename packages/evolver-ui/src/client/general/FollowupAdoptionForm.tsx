import { useState, type FormEvent } from 'react';
import type { GeneralFollowupOrigin } from '../../../../evolver/src/contracts/general-workflow.ts';

export function FollowupAdoptionForm(props: { researchId: string; origin: GeneralFollowupOrigin; suggestion: string; disabled?: boolean; action(type: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | null> }): JSX.Element {
  const [authorized, setAuthorized] = useState(false), [savedNode, setSavedNode] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!authorized || props.disabled || savedNode) return;
    const data = new FormData(event.currentTarget);
    const saved = await props.action('adopt_general_review_action', { researchId: props.researchId, origin: props.origin, authorize: true, task: { title: String(data.get('title')), goal: String(data.get('goal')), method: String(data.get('method')), completionCriterion: String(data.get('completionCriterion')) } });
    if (saved) { setSavedNode(String(saved.nodeId)); setAuthorized(false); }
  };
  return <details><summary>明确采纳为未来任务</summary><p>{props.suggestion}</p>
    {savedNode ? <p role="status">已创建未来基础节点 {savedNode}；尚未执行。请在研究流程中选择该节点，再明确授权其 Team 分析或计算。</p> : <form onSubmit={submit}>
      <label>未来节点标题<input name="title" defaultValue={props.suggestion.slice(0, 300)} required maxLength={300} /></label>
      <label>本节点要回答的具体目标<textarea name="goal" defaultValue={props.suggestion} required maxLength={4000} /></label>
      <label>方法与范围<textarea name="method" required maxLength={4000} /></label>
      <label>可检查的完成标准<textarea name="completionCriterion" required maxLength={4000} /></label>
      <label className="flex"><input type="checkbox" style={{ width: 'auto' }} checked={authorized} onChange={e => setAuthorized(e.currentTarget.checked)} />确认采纳此建议并创建未来节点（本操作不启动执行）</label>
      <button disabled={props.disabled || !authorized}>采纳并保存未来节点</button>
    </form>}
  </details>;
}
