import { useEffect, useRef, useState } from 'react';
import type { ResearchCycleData } from '../integration/research-cycle-view.ts';

const isReference=(key:string)=>/Refs?$/.test(key)||key==='graphPatch';
const LABELS: Record<string,string> = {proposal:'研究提案',experiment_plan:'分析计划',evidence_report:'证据报告',decision:'审查决策',ideaRef:'候选版本',proposalRef:'提案引用',planRef:'计划引用',evidenceRef:'证据引用',graphPatch:'任务树变更',hypothesis:'假设',planner:'规划',evidence:'证据分析',reviewer:'审查',motivation:'研究依据',variable:'研究变量',expectedResult:'预期与判据',notes:'备注',method:'方法',procedure:'步骤',fixedConditions:'固定条件',measurements:'测量项目',completionCriteria:'完成条件',openQuestions:'待确认问题',findings:'证据发现',claim:'主张',support:'依据',sourceNature:'来源性质',sourceRefs:'来源引用',gaps:'证据缺口',summary:'总结',reason:'决策理由',nextActions:'后续建议',title:'标题',detail:'说明',simulation:'模拟资料',keep:'保留',pause:'暂停',reject:'拒绝',needs_validation:'待验证'};
function Value({value}:{value:unknown}) {
 if(value===null)return <span className="run-muted">未记录</span>;
 if(typeof value==='string')return <p className="run-text">{LABELS[value]??value}</p>;
 if(typeof value!=='object')return <span>{String(value)}</span>;
 if(Array.isArray(value))return value.length?<ol className="run-values">{value.map((v,i)=><li key={i}><Value value={v}/></li>)}</ol>:<span className="run-muted">无已登记内容</span>;
 return <dl className="run-fields">{Object.entries(value as Record<string,unknown>).map(([k,v])=><div key={k}><dt>{LABELS[k]??k}</dt><dd>{isReference(k)?<details><summary>展开引用与登记信息</summary><Value value={v}/></details>:<Value value={v}/>}</dd></div>)}</dl>;
}
export function StudioRunDetails(props:{sessionId:string;researchId:string;cycle:ResearchCycleData|null;onBack:()=>void}) {
 const [runId,setRunId]=useState(''),[artifactId,setArtifactId]=useState(''),[attempt,setAttempt]=useState(0);
 const [loaded,setLoaded]=useState<{key:string;content:Record<string,unknown>}|null>(null),[error,setError]=useState('');
 const heading=useRef<HTMLHeadingElement>(null);
 useEffect(()=>{heading.current?.focus();},[]);
 const runs=props.cycle?.runs??[],run=runs.find(r=>r.runId===runId)??runs.at(-1);
 const steps=(props.cycle?.steps??[]).filter(s=>s.runId===run?.runId);
 const artifacts=(props.cycle?.artifacts??[]).filter(a=>a.runId===run?.runId);
 const selected=artifacts.find(a=>a.artifactId===artifactId)??artifacts[0];
 const key=JSON.stringify([props.sessionId,props.researchId,run?.runId,selected?.ref.id,selected?.ref.sha256,attempt]);
 useEffect(()=>{
  const controller=new AbortController();setLoaded(null);setError('');
  if(!selected)return ()=>controller.abort();
  const ref=selected.ref;
  void (async()=>{try{
   const response=await fetch(`/evolver/research-cycle/artifacts?${new URLSearchParams({sessionId:props.sessionId,researchId:props.researchId,id:ref.id,sha256:ref.sha256})}`,{credentials:'same-origin',signal:controller.signal});
   const body=await response.json();if(!response.ok)throw new Error(body.message??body.error??`HTTP ${response.status}`);
   if(body.schemaVersion!==1||!body.content||typeof body.content!=='object'||Array.isArray(body.content))throw new Error('产物响应格式不匹配');
   if(body.content.kind!==selected.kind)throw new Error('返回产物类型与登记记录不匹配');
   if(!controller.signal.aborted)setLoaded({key,content:body.content});
  }catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:String(e));}})();
  return ()=>controller.abort();
 },[key]);
 const content=loaded?.key===key?loaded.content:null;
 const when=(s:string|null)=>s?new Date(s).toLocaleString('zh-CN'):'未记录';
 return <section className="studio-run-details" aria-label="运行与产物详情">
  <header className="run-heading"><div><span className="tiny-label">RUNS & DELIVERABLES</span><h1 ref={heading} tabIndex={-1}>运行与产物详情</h1><p>读取当前研究的持久运行和原始产物。模拟资料、执行完成与科研判断分别展示。</p></div><button className="btn" onClick={props.onBack}>返回 Team 协作</button></header>
  {!run?<div className="panel run-empty"><h2>尚无已登记运行</h2><p>当前研究没有可查看的运行记录；不会显示其他工作区或示例产物。</p></div>:<>
  <div className="panel run-summary"><label>选择运行<select value={run.runId} onChange={e=>{setRunId(e.currentTarget.value);setArtifactId('');}}>{runs.map(r=><option key={r.runId} value={r.runId}>第 {r.round} 轮 · {r.status} · {r.runId}</option>)}</select></label><span className="chip indigo">{run.status}</span><span>{steps.length} 个步骤 · {artifacts.length} 份产物</span><dl><div><dt>开始</dt><dd>{when(run.startedAt)}</dd></div><div><dt>结束</dt><dd>{when(run.finishedAt)}</dd></div></dl>{run.error&&<p role="alert">运行错误：{run.error.message}</p>}</div>
  <div className="run-columns"><aside className="panel run-deliverables" aria-label="运行步骤与产物"><h2>成员交付</h2>{steps.map(s=>{const member=props.cycle?.runtime?.members?.find(m=>m.id===s.assignedMemberId);const refs=artifacts.filter(a=>s.outputRefs.some(r=>r.id===a.ref.id&&r.sha256===a.ref.sha256));return <div className="run-step" key={s.stepId}><h3>{LABELS[s.role]??s.role}<span>{s.status}</span></h3><details><summary>任务 {s.nativeTask?.taskId??'未登记'} · 成员与尝试记录</summary><p>{member?.name??s.assignedMemberId??'尚未分配成员'}</p><small>attempt {s.attemptId}</small></details>{s.error&&<p role="alert">{s.error.message}</p>}{s.blocking.map((b,i)=><p key={i}>{b}</p>)}{refs.map(a=><button className={`run-artifact${selected?.artifactId===a.artifactId?' selected':''}`} aria-pressed={selected?.artifactId===a.artifactId} key={a.artifactId} onClick={()=>setArtifactId(a.artifactId)}>{LABELS[a.kind]??a.kind}<small>{a.ref.sha256.slice(0,16)}…</small></button>)}{!refs.length&&<p className="run-muted">尚无已登记产物</p>}</div>;})}{artifacts.filter(a=>!steps.some(s=>s.outputRefs.some(r=>r.id===a.ref.id))).map(a=><button className="run-artifact" key={a.artifactId} onClick={()=>setArtifactId(a.artifactId)}>{LABELS[a.kind]??a.kind}</button>)}</aside>
  <article className="panel run-document" aria-label="产物正文"><header><span className="tiny-label">PERSISTED ARTIFACT</span><h2>{selected?LABELS[selected.kind]??selected.kind:'尚无产物'}</h2>{selected&&<><p>登记时间 {when(selected.createdAt)}</p><details><summary>来源与完整校验值</summary><dl><dt>运行 ID</dt><dd>{run.runId}</dd><dt>产物路径</dt><dd>{selected.ref.id}</dd><dt>SHA-256</dt><dd>{selected.ref.sha256}</dd></dl></details></>}</header>{error?<div role="alert"><p>读取产物失败：{error}</p><button className="btn" onClick={()=>setAttempt(n=>n+1)}>重试读取产物</button></div>:selected&&!content?<p role="status">正在读取并核对产物…</p>:content?<><div className="run-document-body"><Value value={Object.fromEntries(Object.entries(content).filter(([k])=>!['schemaVersion','kind','researchMode'].includes(k)).sort(([a],[b])=>Number(isReference(a))-Number(isReference(b))))}/></div><details><summary>查看原始 JSON</summary><pre>{JSON.stringify(content,null,2)}</pre></details></>:<p>本轮尚未生成产物。</p>}</article></div></>}
 </section>;
}
