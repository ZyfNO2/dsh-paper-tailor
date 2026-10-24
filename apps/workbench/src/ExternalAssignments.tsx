import {useEffect,useState} from 'react';
type BlockedPlan={planId:string;revision:number;contentHash:string;state:'blocked';reason:string};
type Plan={state:'current';planId:string;revision:number;contentHash:string;baseline:string;variable:string;metric:string;metricUnit:string;split:string;seedPolicy:string;budget:string;stopCondition:string};
type Review={reviewId:string;judgment:string;reason:string;nextStep:string;approvalHash:string};
type View={revision:number;plans:Array<Plan|BlockedPlan>;assignments:Array<{assignmentId:string;planId:string;planRevision:number}>;runs:Array<{runId:string;execution:string;recordKind:string}>;reviews:Review[];boundary:string};
function download(value:unknown,name:string){const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function ExternalAssignments({workspace,researchId,revision,refresh}:{workspace:string;researchId:string;revision:number;refresh:()=>Promise<void>}){
 const key=JSON.stringify([workspace,researchId,revision]),[loaded,setLoaded]=useState<{key:string;view:View}|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const view=loaded?.key===key?loaded.view:null;
 useEffect(()=>{let live=true;setLoaded(null);setError('');void fetch(`/api/dsh/experiments?${new URLSearchParams({workspaceDir:workspace,researchId})}`).then(async r=>{const b=await r.json();if(!r.ok)throw Error(b.message??`HTTP ${r.status}`);if(live)setLoaded({key,view:b});}).catch(e=>{if(live)setError(String(e));});return()=>{live=false;};},[workspace,researchId,revision]);
 const approve=async(action:'approve_export'|'accept_review',subjectId:string,subjectRevision:number,subjectHash:string)=>{
  setBusy(true);setError('');setNotice('');try{const r=await fetch(`/api/dsh/experiments/actions?${new URLSearchParams({workspaceDir:workspace})}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,researchId,baseRevision:revision,operationId:`experiment-ui-${crypto.randomUUID()}`,subjectId,subjectRevision,subjectHash,authorize:true})}),b=await r.json();if(!r.ok)throw Error(b.message??`HTTP ${r.status}`);
   if(action==='approve_export'){download(b.bundle,`${b.exported.result.assignmentId}.json`);setNotice('已批准并导出固定任务；未启动实验。');}else setNotice('已采纳为未执行的后续节点；没有启动下一次实验。');
   try{await refresh();}catch(e){setLoaded(null);setError(`写入已成功，重新核对失败：${String(e)}；请刷新，勿重复提交。`);}
  }catch(e){setError(String(e));}finally{setBusy(false);}
 };
 const exportExisting=async(assignmentId:string)=>{setBusy(true);setError('');try{const r=await fetch(`/api/dsh/experiments/assignment?${new URLSearchParams({workspaceDir:workspace,assignmentId})}`),b=await r.json();if(!r.ok)throw Error(b.message??`HTTP ${r.status}`);download(b,`${assignmentId}.json`);}catch(e){setLoaded(null);setError(String(e));}finally{setBusy(false);}};
 return <details><summary>实验计划与固定任务</summary><p>外部 Agent 提交计划后，在这里核对并批准任务交接。保存、导出和采纳建议均不会自动执行实验。</p>
 {view&&<><p>{view.boundary}</p>{!view.plans.length&&<p>尚无通用实验计划。可由已连接的 Agent 提交草稿。</p>}{view.plans.map(p=>p.state==='blocked'?<p key={p.planId} role="note">历史计划 {p.planId} 无法继续使用：{p.reason}；请核对来源或另存新计划。</p>:<section key={p.planId}><h3>{p.baseline} → {p.variable}</h3><p>{p.metric} / {p.metricUnit} · {p.split} · seed：{p.seedPolicy}</p><p>预算：{p.budget}；停止条件：{p.stopCondition}</p><button disabled={busy} onClick={()=>void approve('approve_export',p.planId,p.revision,p.contentHash)}>批准并导出任务：{p.variable}</button>{view.assignments.filter(a=>a.planId===p.planId).map(a=><button key={a.assignmentId} disabled={busy} onClick={()=>void exportExisting(a.assignmentId)}>下载已固定任务：{p.variable} v{a.planRevision}</button>)}</section>)}
 {view.runs.map(r=><p key={r.runId}>外部记录 {r.runId} · {r.recordKind} / {r.execution}（执行身份未独立验证）</p>)}
 {view.reviews.map(r=><section key={r.reviewId}><h3>自审建议：{r.judgment}</h3><p>{r.reason}</p><p>下一步：{r.nextStep}</p><button disabled={busy} onClick={()=>void approve('accept_review',r.reviewId,1,r.approvalHash)}>采纳为未执行后续：{r.nextStep}</button></section>)}</>}
 {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
 </details>;
}
