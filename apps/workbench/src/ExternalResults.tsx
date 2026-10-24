import { useEffect, useState } from 'react';

interface ValueDraft { name: string; value: string; unit: string; row: number; column: number }
interface ConditionDraft { name: string; value: string }
interface ResultAction { title: string; reason: string; prerequisite: string; condition: string; verification: string; resource: string }
interface Projection { reports: Array<{reportId:string;label:string;externalRunId?:string|null;match?:string;matchReason?:string;comparability?:string;comparabilityReason?:string}>; reviews: Array<{reviewId:string;judgment:string;boundary:string;support:string;counterEvidence:string;gaps:string;nextActions:ResultAction[];freshness:{status:string;reason:string}}>; decisions: Array<{decisionId:string;choice:string;nodeId:string|null;provenance?:string}>; boundary:string }
const blankValue = (): ValueDraft => ({ name:'',value:'',unit:'未知',row:0,column:0 });
export function ExternalResults({ workspace, researchId, revision, refresh }: { workspace:string; researchId:string; revision:number; refresh:()=>Promise<void> }) {
  const [view,setView]=useState<Projection|null>(null),[error,setError]=useState(''),[readError,setReadError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [file,setFile]=useState(''),[label,setLabel]=useState(''),[nature,setNature]=useState('simulation'),[runId,setRunId]=useState(''),[clarification,setClarification]=useState(''),[failureQuote,setFailureQuote]=useState('');
  const [values,setValues]=useState<ValueDraft[]>([blankValue()]),[conditions,setConditions]=useState<ConditionDraft[]>([]),[titles,setTitles]=useState<Record<string,string>>({});
  const query=new URLSearchParams({workspaceDir:workspace,researchId});
  const load=async()=>{const response=await fetch(`/api/dsh/bootstrap/external-results?${query}`);const result=await response.json();if(!response.ok)throw new Error(result.message??`HTTP ${response.status}`);return result as Projection;};
  useEffect(()=>{let live=true;void load().then(result=>{if(live){setView(result);setReadError('');}}).catch(failure=>{if(live){setView(null);setReadError(String(failure));}});return()=>{live=false;};},[workspace,researchId,revision]);
  const post=async(type:string,data:object)=>{
    setBusy(true);setError('');setNotice('');
    try{
      const response=await fetch(`/api/dsh/actions?${new URLSearchParams({workspaceDir:workspace})}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,researchId,baseRevision:revision,operationId:`external-ui-${crypto.randomUUID()}`,...data})});
      const result=await response.json();if(!response.ok||result.ok===false)throw new Error(result.message??result.error??`HTTP ${response.status}`);
      setNotice(type==='register_external_result'?`已登记：${result.match}。${result.matchReason} 保存不代表本系统执行或科研结论成立。`:`已记录用户决定：${result.choice}。新增节点仍未执行。`);
      try{await refresh();setView(await load());}catch(failure){setReadError(`写入已成功，但重新核对失败：${String(failure)}。请刷新，不要重复提交。`);}
    }catch(failure){setError(String(failure));}finally{setBusy(false);}
  };
  const register=()=>{
    const selected=values.filter(value=>value.name.trim());
    if(!file.trim()||!label.trim()||!selected.length&&!failureQuote.trim()){setError('请填写结果相对路径、名称，以及至少一项指标或原文失败引用。');return;}
    const measured=selected.map(value=>({name:value.name.trim(),value:value.value.trim()===''?null:Number(value.value),unit:value.unit.trim()||'未知',row:value.row,column:value.column}));
    if(measured.some(value=>value.value!==null&&!Number.isFinite(value.value))){setError('数值必须是有限数字或留空；不能将缺失值填为0。');return;}
    void post('register_external_result',{relativePath:file.trim(),nature,label:label.trim(),externalRunId:runId.trim()||null,clarification:clarification.trim()||null,values:measured,failureQuote:failureQuote.trim()||null,conditions:conditions.filter(condition=>condition.name.trim()).map(condition=>({name:condition.name.trim(),value:condition.value.trim()||null,unit:null}))});
  };
  const decide=(review:Projection['reviews'][number],index:number,choice:'accept'|'modify'|'reject'|'defer')=>{
    const title=review.nextActions[index].title,replacement=titles[`${review.reviewId}:${index}`]?.trim();
    if(choice==='modify'&&!replacement){setError('请填写修改后的建议标题。');return;}
    const utterance=choice==='accept'?`接受建议「${title}」`:choice==='reject'?`拒绝建议「${title}」`:choice==='defer'?`暂缓建议「${title}」`:`将建议「${title}」修改为「${replacement}」`;
    void post('decide_external_result',{reviewId:review.reviewId,actionIndex:index,choice,utterance,modifiedTitle:choice==='modify'?replacement:null,authorize:true});
  };
  return <details><summary>外部结果回填与用户决定</summary>
    <p>登记已有文件，逐项核对原值、run id、单位和条件。外部文件不是本系统运行；建议均为 self_review，模型身份未验证。完整矩阵见“研究工具 → 指标与比较”。</p>
    <div><label>结果文件（工作目录内相对路径）<input aria-label="外部结果相对路径" value={file} disabled={busy} onChange={event=>setFile(event.target.value)} placeholder="runs/experiment-a/metrics.csv" /></label>
      <label>结果名称<input aria-label="外部结果名称" value={label} disabled={busy} onChange={event=>setLabel(event.target.value)} /></label>
      <label>资料性质<select aria-label="外部结果性质" value={nature} disabled={busy} onChange={event=>setNature(event.target.value)}><option value="simulation">明确模拟 / 合成测试</option><option value="user_result">用户已有结果（非本系统执行）</option></select></label>
      <label>文件中的 run id（可留空）<input aria-label="外部结果run id" value={runId} disabled={busy} onChange={event=>setRunId(event.target.value)} /></label>
      <p>行列均从0开始，行号不含表头。表头未写单位时填“未知”；缺失留空并提供失败原文，不填0。</p>
      {values.map((value,index)=><div key={index}><label>指标名称<input aria-label={`外部指标名称 ${index+1}`} disabled={busy} value={value.name} onChange={event=>setValues(previous=>previous.map((entry,i)=>i===index?{...entry,name:event.target.value}:entry))} /></label><label>数值<input aria-label={`外部指标数值 ${index+1}`} disabled={busy} value={value.value} onChange={event=>setValues(previous=>previous.map((entry,i)=>i===index?{...entry,value:event.target.value}:entry))} /></label><label>单位<input aria-label={`外部指标单位 ${index+1}`} disabled={busy} value={value.unit} onChange={event=>setValues(previous=>previous.map((entry,i)=>i===index?{...entry,unit:event.target.value}:entry))} /></label>{(['row','column'] as const).map(axis=><label key={axis}>{axis==='row'?'行':'列'}<input aria-label={`外部指标${axis==='row'?'行':'列'} ${index+1}`} type="number" min={0} disabled={busy} value={value[axis]} onChange={event=>setValues(previous=>previous.map((entry,i)=>i===index?{...entry,[axis]:Number(event.target.value)}:entry))} /></label>)}<button disabled={busy} onClick={()=>setValues(previous=>previous.filter((_,i)=>i!==index))}>移除指标 {index+1}</button></div>)}
      <button disabled={busy||values.length>=50} onClick={()=>setValues(previous=>[...previous,blankValue()])}>添加结果指标</button>
      {conditions.map((condition,index)=><div key={index}><label>条件名称<input aria-label={`外部条件名称 ${index+1}`} value={condition.name} disabled={busy} onChange={event=>setConditions(previous=>previous.map((entry,i)=>i===index?{...entry,name:event.target.value}:entry))} /></label><label>条件值（未知留空）<input aria-label={`外部条件值 ${index+1}`} value={condition.value} disabled={busy} onChange={event=>setConditions(previous=>previous.map((entry,i)=>i===index?{...entry,value:event.target.value}:entry))} /></label><button disabled={busy} onClick={()=>setConditions(previous=>previous.filter((_,i)=>i!==index))}>移除条件 {index+1}</button></div>)}
      <button disabled={busy||conditions.length>=40} onClick={()=>setConditions(previous=>[...previous,{name:'',value:''}])}>添加结果条件</button>
      <label>失败原文引用（有缺失值时必填）<input aria-label="外部结果失败引用" value={failureQuote} disabled={busy} onChange={event=>setFailureQuote(event.target.value)} /></label>
      <label>归属澄清（仅用户，点名已有节点）<input aria-label="外部结果归属澄清" value={clarification} disabled={busy} onChange={event=>setClarification(event.target.value)} /></label>
      <button disabled={busy} onClick={register}>核对文件并登记外部结果</button>
    </div>
    {view&&<div><p>{view.boundary}</p>{view.reports.map(report=><p key={report.reportId}>{report.label} · {report.externalRunId??'run未知'} · {report.match} · {report.comparability}<br />{report.matchReason} {report.comparabilityReason}</p>)}
      <p>以下为最近一次核对；采纳时仍会检查当前来源与协议。MCP外部客户端提交建议，不由页面编造模型审查。</p>
      {view.reviews.map(review=><section key={review.reviewId}><strong>{review.judgment} · self_review · {review.freshness.status}</strong><p>{review.boundary}</p><p>{review.support}</p><p>{review.counterEvidence}</p><p>缺口：{review.gaps}</p><p>{review.freshness.reason}</p>{review.nextActions.map((action,index)=><div key={index}><strong>{action.title}</strong><p>{action.reason}</p><p>前提：{action.prerequisite} · 条件：{action.condition} · 验证：{action.verification} · 资源：{action.resource}</p><button disabled={busy||review.freshness.status!=='current'} onClick={()=>decide(review,index,'accept')}>采纳为待执行节点：{action.title}</button><button disabled={busy} onClick={()=>decide(review,index,'reject')}>拒绝：{action.title}</button><button disabled={busy} onClick={()=>decide(review,index,'defer')}>暂缓：{action.title}</button><label>修改后的标题<input aria-label={`修改建议标题 ${index+1}`} value={titles[`${review.reviewId}:${index}`]??''} disabled={busy} onChange={event=>setTitles(previous=>({...previous,[`${review.reviewId}:${index}`]:event.target.value}))} /></label><button disabled={busy||review.freshness.status!=='current'} onClick={()=>decide(review,index,'modify')}>修改后采纳：{action.title}</button></div>)}</section>)}
      {view.decisions.map(decision=><p key={decision.decisionId}>已记录决定 {decision.choice} · {decision.provenance==='user_action'?'本地用户操作，非宿主消息':decision.provenance??'未核实'} · {decision.nodeId?'已建立未执行节点':'未创建节点'}</p>)}</div>}
    {notice&&<p role="status">{notice}</p>}{readError&&<p role="alert">{readError}</p>}{error&&<p role="alert">{error}</p>}
  </details>;
}
