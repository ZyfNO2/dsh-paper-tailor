import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { activeStore } from './active-store.ts';
import { legacyScope } from './legacy-domain.ts';
import { ProjectStore, commitOperation, requestHash, type ProjectStoreOptions, type AppliedMutation, type MutationBody } from './project-store.ts';
import { ResearchCoreError, validateActorContext, type ResearchProjectState, type ActorContext } from '../../research-contracts/src/index.ts';
import { emptyBootstrapExperimentLoop, type BootstrapExperimentLoop } from '../../evolver/src/contracts/bootstrap-experiment-loop.ts';
import { type BootstrapState, type ResearchBootstrap } from '../../evolver/src/contracts/research-bootstrap.ts';
import { assertGeneralSourceAccess } from '../../evolver/src/application/general-source-access.ts';
import { GeneralMaterialStore } from '../../evolver/src/application/general-material-store.ts';
import { GeneralWikiService } from '../../evolver/src/application/general-wiki-service.ts';

type Request = { workspaceDir:string; operationId:string; baseRevision:number; actor:ActorContext };
function selected(state:BootstrapState): ResearchBootstrap {
  const research=state.researches.find(r=>r.researchId===state.activeResearchId);
  if(!research?.general)throw new ResearchCoreError('NOT_FOUND','Select an existing general research before using experiment tools');
  return research;
}
function project(state:BootstrapState, workspace:string):ResearchProjectState {
  const r=selected(state),g=r.general!,loop=g.externalLoop??emptyBootstrapExperimentLoop(),scope=legacyScope(workspace);
  const projected:ResearchProjectState = {schemaVersion:1,projectId:r.researchId.replace(/^research-/,'proj-'),goal:r.contract.goal??r.title,constraints:g.constraints,revision:state.revision,
    sources:g.sources.map(s=>({sourceId:s.sourceId,filename:s.filename,relativePath:path.relative(path.join(workspace,'.research'),path.join(scope.store.workspaceRoot,'.dsh/research/materials/raw',s.sha256)).split(path.sep).join('/'),sha256:s.sha256,bytes:s.bytes,mediaType:s.mediaType,importedAt:s.acquiredAt})),
    // Native candidates do not claim fields they never recorded. Keep the raw
    // candidate in assignment bundles as well as this conservative shared view.
    ideas:g.ideas.map(i=>({ideaId:i.ideaId,revision:i.revision,title:i.question,hypothesis:i.question,change:'Unknown: not a field in the native candidate',mechanism:i.rationale||'Unknown: no native rationale',falsifier:i.verificationPlan||'Unknown: no native verification plan',sourceIds:i.sourceRefs,status:'candidate' as const,updatedAt:i.updatedAt})),
    plans:loop.plans,assignments:loop.assignments,approvals:loop.approvals,runs:loop.runs,reviews:loop.reviews,receipts:[],knowledge:[],searches:[],legacyRoot:'.dsh/research',stateHash:'0'.repeat(64)};
  const {stateHash:_ignored,...content}=projected;projected.stateHash=requestHash(content);return projected;
}
export function readNativeExperimentProject(workspace:string):ResearchProjectState { return project(legacyScope(workspace).store.readStateOrEmpty(),workspace); }
export function assertNativeExperimentPlan(workspace:string,planId:string,state=legacyScope(workspace).store.readStateOrEmpty()) {
  const r=selected(state),g=r.general!,loop=g.externalLoop,plan=loop?.plans.find(p=>p.planId===planId),pin=loop?.pins.find(p=>p.planId===planId);
  if(!plan||!pin)throw new ResearchCoreError('NOT_FOUND','Experiment plan/pins are missing from the selected research');
  const {planId:_id,revision:_rev,status:_status,contentHash:_hash,updatedAt:_at,...body}=plan;
  if(requestHash(body)!==plan.contentHash)throw new ResearchCoreError('STATE_CORRUPT','Experiment plan hash mismatch');
  const idea=g.ideas.find(i=>i.ideaId===pin.ideaId);
  if(!idea||idea.revision!==pin.ideaRevision||requestHash(idea)!==pin.ideaHash||g.profileRevision!==pin.profileRevision)throw new ResearchCoreError('REVISION_CONFLICT','Experiment candidate/profile changed; save and authorize a new plan');
  if(JSON.stringify(pin.sources.map(s=>s.sourceId).sort())!==JSON.stringify([...idea.sourceRefs].sort()))throw new ResearchCoreError('STATE_CORRUPT','Experiment source pins do not match candidate scope');
  const materials=new GeneralMaterialStore(legacyScope(workspace).store.workspaceRoot);
  for(const saved of pin.sources){assertGeneralSourceAccess(g,saved.sourceId);const source=g.sources.find(s=>s.sourceId===saved.sourceId);if(!source||source.revision!==saved.revision||source.sha256!==saved.sha256)throw new ResearchCoreError('REVISION_CONFLICT','Experiment source pins changed');materials.readRaw(source);}
  return {research:r,plan,pin};
}
export function readNativeExperimentMaterial(workspace:string,sourceId:string) {
  const {store}=legacyScope(workspace),r=selected(store.readStateOrEmpty());
  return new GeneralWikiService(store).source(r.researchId,sourceId);
}
export class BootstrapLoopStore {
  readonly workspaceDir:string;
  constructor(workspace:string){this.workspaceDir=workspace;}
  now(){return new Date().toISOString();}
  read(){return readNativeExperimentProject(this.workspaceDir);}
  commit<T extends Record<string,unknown>>(request:Request,kind:string,payload:unknown,apply:(current:ResearchProjectState|null)=>AppliedMutation<T>):MutationBody<T>{
    const {store,readOnly}=legacyScope(this.workspaceDir);if(readOnly)throw new ResearchCoreError('INVALID_INPUT','MIGRATION_REQUIRED before experiment writes');
    validateActorContext(request.actor);
    const state=store.readStateOrEmpty(),r=selected(state),semantic={researchId:r.researchId,payload};
    const saved=store.mutate({operationId:request.operationId,kind:`experiment_${kind}`,researchId:r.researchId,baseRevision:request.baseRevision,requestPayload:semantic,apply:context=>{
      const research=selected(context.state);if(research.researchId!==r.researchId)throw new ResearchCoreError('REVISION_CONFLICT','Selected research changed');
      const g=research.general!,loop=g.externalLoop??emptyBootstrapExperimentLoop(),previous=structuredClone(loop),current=project(context.state,this.workspaceDir);
      const p=payload as Record<string,unknown>,ids=new Set<string>();
      if(kind==='export_assignment')ids.add(String(p.planId));
      if(kind==='record_run'){const assignment=loop.assignments.find(a=>a.assignmentId===p.assignmentId);if(assignment){ids.add(assignment.planId);assertNativeAssignmentApproval(this.workspaceDir,assignment.planId,context.state);}}
      if(kind==='submit_review')for(const id of p.runIds as string[]){const run=loop.runs.find(run=>run.runId===id);if(run)ids.add(run.planId);}
      for(const id of ids)assertNativeExperimentPlan(this.workspaceDir,id,context.state);
      const applied=apply(current);if(applied.unchanged)return {changed:false,result:applied.result};
      const next=applied.state;
      for(const plan of next.plans.filter(p=>!loop.pins.some(pin=>pin.planId===p.planId))){
        const idea=g.ideas.find(i=>i.ideaId===plan.ideaId);if(!idea)throw new ResearchCoreError('NOT_FOUND','Candidate is outside selected research');
        if(!idea.sourceRefs.length)throw new ResearchCoreError('INVALID_INPUT','A source-pinned experiment requires candidate sources');
        const sources=idea.sourceRefs.map(sourceId=>{assertGeneralSourceAccess(g,sourceId);const source=g.sources.find(s=>s.sourceId===sourceId)!;new GeneralMaterialStore(store.workspaceRoot).readRaw(source);return {sourceId,revision:source.revision,sha256:source.sha256};});
        loop.pins.push({planId:plan.planId,ideaId:idea.ideaId,ideaRevision:idea.revision,ideaHash:requestHash(idea),profileRevision:g.profileRevision,sources});
      }
      g.externalLoop={plans:next.plans,assignments:next.assignments,approvals:next.approvals,runs:next.runs,reviews:next.reviews,pins:loop.pins};
      syncGraph(research,g.externalLoop,previous);
      g.revision++;return {changed:true,result:applied.result};
    }});
    return {...saved,projectId:r.researchId.replace(/^research-/, 'proj-')};
  }
}
export function experimentStore(workspace:string,options:ProjectStoreOptions){return activeStore(workspace)?new BootstrapLoopStore(workspace):new ProjectStore(workspace,options);}
export function commitExperiment<T extends Record<string,unknown>>(store:ReturnType<typeof experimentStore>,request:Request,kind:string,payload:unknown,apply:(current:ResearchProjectState|null)=>AppliedMutation<T>){
  return store instanceof BootstrapLoopStore?store.commit(request,kind,payload,apply):commitOperation(store,request.operationId,kind,payload,apply);
}
export function approveNativeExperiment(request:Request&{subjectId:string;subjectRevision:number;subjectHash:string;capability:string}){
  const actor=validateActorContext(request.actor);if(actor.kind!=='user'||!['cli','http'].includes(actor.source))throw new ResearchCoreError('INVALID_INPUT','Experiment approval requires a trusted user channel');
  if(!['export_assignment','accept_decision'].includes(request.capability))throw new ResearchCoreError('INVALID_INPUT','Use native workspace actions for candidate selection');
  const store=new BootstrapLoopStore(request.workspaceDir),payload={subjectId:request.subjectId,subjectRevision:request.subjectRevision,subjectHash:request.subjectHash,capability:request.capability};
  return store.commit(request,'record_approval',payload,current=>{if(!current)throw new ResearchCoreError('NOT_FOUND','No selected research');
    const subject=request.capability==='export_assignment'?current.plans.find(p=>p.planId===request.subjectId):current.reviews.find(r=>r.reviewId===request.subjectId);
    if(!subject)throw new ResearchCoreError('NOT_FOUND','Approval subject is outside selected research');
    const hash='contentHash' in subject?subject.contentHash:requestHash(subject),revision='revision' in subject?subject.revision:1;
    if(hash!==request.subjectHash||revision!==request.subjectRevision)throw new ResearchCoreError('REVISION_CONFLICT','Approval must bind the current subject revision/hash');
    const planIds='planId' in subject?[subject.planId]:subject.runIds.map(id=>current.runs.find(r=>r.runId===id)!.planId);
    for(const id of planIds)assertNativeExperimentPlan(request.workspaceDir,id);
    const approvalId=`apr-${randomUUID()}`;current.approvals.push({approvalId,projectId:current.projectId,...payload,capability:request.capability as 'export_assignment'|'accept_decision',actorId:actor.actorId,actorKind:'user',actorSource:actor.source,createdAt:store.now()});return {state:current,result:{approvalId}};});
}

export function assertNativeAssignmentApproval(workspace:string,planId:string,state=legacyScope(workspace).store.readStateOrEmpty()){
 const {research,plan}=assertNativeExperimentPlan(workspace,planId,state);if(!research.general!.externalLoop!.approvals.some(a=>a.capability==='export_assignment'&&a.subjectId===planId&&a.subjectRevision===plan.revision&&a.subjectHash===plan.contentHash&&a.actorKind==='user'))throw new ResearchCoreError('INVALID_INPUT','Assignment requires a current local user plan approval');
}

/** Graph nodes record artifacts/planning, never invent an executed native task. */
function syncGraph(research:ResearchBootstrap,loop:BootstrapExperimentLoop,previous:BootstrapExperimentLoop){
 const g=research.general!,graph=structuredClone(g.graph),before=JSON.stringify(graph);
 const add=(id:string,title:string,kind:'protocol'|'manual'|'review',goal:string,inputs:string[],output:string)=>{if(!graph.nodes.some(n=>n.nodeId===id))graph.nodes.push({nodeId:id,title:title.slice(0,300),kind,goal,inputs,method:'通用外部任务交接；记录不证明本系统执行或科研收益',output,completionCriterion:'核对原始记录、来源和限制；进一步执行须另行授权',join:'all',execution:'not_started'});};
 const edge=(from:string,to:string)=>{if(graph.nodes.some(n=>n.nodeId===from)&&graph.nodes.some(n=>n.nodeId===to)&&!graph.edges.some(e=>e.from===from&&e.to===to&&e.kind==='derived_from'))graph.edges.push({edgeId:`edge-${randomUUID()}`,from,to,kind:'derived_from',condition:null});};
 // Project each artifact once. Later writes must preserve user graph edits,
 // including deleted nodes/edges; the original records remain in externalLoop.
 for(const p of loop.plans.filter(p=>!previous.plans.some(old=>old.planId===p.planId)))add(`exp-${p.planId}`,`外部实验计划：${p.variable}`,'protocol',`${p.baseline} → ${p.variable}`,loop.pins.find(pin=>pin.planId===p.planId)!.sources.map(s=>s.sourceId),`${p.metric} / ${p.metricUnit} / ${p.split}; ${p.stopCondition}`);
 for(const r of loop.runs.filter(r=>!previous.runs.some(old=>old.runId===r.runId))){add(`exp-${r.runId}`,`外部登记：${r.runId}（${r.recordKind}/${r.execution}）`,'manual','外部文件报告；执行身份未独立验证',[r.assignmentId],`${r.manifestSha256}; ${r.metricsSha256}`);edge(`exp-${r.runId}`,`exp-${r.planId}`);}
 for(const r of loop.reviews){if(!previous.reviews.some(old=>old.reviewId===r.reviewId)){add(`exp-${r.reviewId}`,`自审建议：${r.judgment}`,'review',r.reason,r.runIds,r.nextStep);for(const id of r.runIds)edge(`exp-${r.reviewId}`,`exp-${id}`);}
  const accepted=(a:BootstrapExperimentLoop['approvals'][number])=>a.capability==='accept_decision'&&a.subjectId===r.reviewId&&a.subjectHash===requestHash(r)&&a.actorKind==='user';
  if(loop.approvals.some(accepted)&&!previous.approvals.some(accepted)){add(`next-${r.reviewId}`,`未执行：${r.nextStep}`.slice(0,300),'manual',r.nextStep,r.runIds,'未知；仅用户采纳的未来工作');edge(`next-${r.reviewId}`,`exp-${r.reviewId}`);}}
 if(JSON.stringify(graph)!==before){g.graphHistory.push(structuredClone(g.graph));graph.revision++;g.graph=graph;}
}
