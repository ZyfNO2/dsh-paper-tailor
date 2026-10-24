import * as os from 'node:os';
import {ResearchCore} from './service.ts';
import {ResearchCoreError} from '../../research-contracts/src/index.ts';
import {legacyScope} from './legacy-domain.ts';
import {assertNativeExperimentPlan} from './bootstrap-loop-store.ts';
import {emptyBootstrapExperimentLoop} from '../../evolver/src/contracts/bootstrap-experiment-loop.ts';
import {BootstrapError} from '../../evolver/src/contracts/research-bootstrap.ts';
import {requestHash} from './project-store.ts';

export function bootstrapExperimentView(workspace:string,researchId:string){
 const state=legacyScope(workspace).store.readStateOrEmpty(),r=state.researches.find(r=>r.researchId===researchId);
 if(!r?.general||state.activeResearchId!==researchId)throw new ResearchCoreError('NOT_FOUND','Select this general research before reading experiment assignments');
 const loop=r.general.externalLoop??emptyBootstrapExperimentLoop();
 const current=new Set<string>();
 const plans=loop.plans.map(plan=>{try{assertNativeExperimentPlan(workspace,plan.planId,state);current.add(plan.planId);return {...plan,state:'current' as const};}catch(error){if(!(error instanceof ResearchCoreError||error instanceof BootstrapError)||!['REVISION_CONFLICT','POLICY_DENIED','SOURCE_STALE','SOURCE_MISSING'].includes(error.code))throw error;return {planId:plan.planId,revision:plan.revision,contentHash:plan.contentHash,state:'blocked' as const,reason:error.message};}});
 const runs=loop.runs.filter(run=>current.has(run.planId)),runIds=new Set(runs.map(run=>run.runId));
 return {schemaVersion:1,authority:'bootstrap',researchId,revision:state.revision,reviewMode:'self_review',plans,assignments:loop.assignments.filter(a=>current.has(a.planId)),runs,reviews:loop.reviews.filter(review=>review.runIds.every(id=>runIds.has(id))).map(review=>({...review,approvalHash:requestHash(review)})),boundary:'外部报告与自审，不是本系统执行或独立审查。批准任务仅允许交接，后续执行仍受执行环境授权约束。'};
}
export function bootstrapExperimentUserAction(workspace:string,raw:unknown){
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ResearchCoreError('INVALID_INPUT','Experiment action object required');
 const p=raw as Record<string,unknown>,fields=['action','researchId','operationId','baseRevision','subjectId','subjectRevision','subjectHash','authorize'];
 if(Object.keys(p).some(k=>!fields.includes(k))||fields.some(k=>!Object.hasOwn(p,k))||!['approve_export','accept_review'].includes(String(p.action))||p.authorize!==true||typeof p.operationId!=='string'||p.operationId.length>180||typeof p.subjectId!=='string'||typeof p.subjectHash!=='string'||!Number.isSafeInteger(p.baseRevision)||!Number.isSafeInteger(p.subjectRevision))throw new ResearchCoreError('INVALID_INPUT','Exact authorized experiment action fields required; caller identity is transport-owned');
 const scope=legacyScope(workspace);if(scope.readOnly)throw new ResearchCoreError('INVALID_INPUT','MIGRATION_REQUIRED before native experiment approval');
 const state=scope.store.readStateOrEmpty();if(p.researchId!==state.activeResearchId)throw new ResearchCoreError('REVISION_CONFLICT','Selected research changed');
 const core=new ResearchCore(),actor={kind:'user' as const,source:'http' as const,actorId:`local-user:${os.userInfo().username}`};
 const approval=core.approve({workspaceDir:workspace,actor,operationId:p.operationId,baseRevision:p.baseRevision as number,subjectId:p.subjectId,subjectRevision:p.subjectRevision as number,subjectHash:p.subjectHash,capability:p.action==='approve_export'?'export_assignment':'accept_decision'});
 if(p.action==='accept_review')return {approval};
 const exported=core.exportAssignment({workspaceDir:workspace,actor,operationId:`${p.operationId}-assignment`,baseRevision:approval.revision,planId:p.subjectId});
 return {approval,exported,bundle:core.assignmentBundle(workspace,exported.result.assignmentId)};
}
