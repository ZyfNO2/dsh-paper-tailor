import { validateApproval, type ApprovalRecord } from '../../../research-contracts/src/index.ts';
import { validatePlanList, validateAssignmentList, validateRunList, validateReviewList, type ExperimentPlanRecord, type AssignmentRecord, type ExperimentRunRecord, type ReviewRecord } from '../../../research-contracts/src/records.ts';

/** Records share Bootstrap's transaction/revision. Sources and ideas remain native. */
export interface BootstrapExperimentLoop {
  plans: ExperimentPlanRecord[];
  assignments: AssignmentRecord[];
  approvals: ApprovalRecord[];
  runs: ExperimentRunRecord[];
  reviews: ReviewRecord[];
  pins: Array<{ planId: string; ideaId: string; ideaRevision: number; ideaHash: string; profileRevision: number; sources: Array<{ sourceId: string; revision: number; sha256: string }> }>;
}
export function emptyBootstrapExperimentLoop(): BootstrapExperimentLoop { return { plans: [], assignments: [], approvals: [], runs: [], reviews: [], pins: [] }; }
export function validateBootstrapExperimentLoop(raw: unknown): BootstrapExperimentLoop {
  const fail = (message: string): never => { throw new Error(`Bootstrap experiment loop: ${message}`); };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('object required');
  const o = raw as Record<string, unknown>, keys = ['plans','assignments','approvals','runs','reviews','pins'];
  if (Object.keys(o).length !== keys.length || keys.some(key => !Array.isArray(o[key]) || (o[key] as unknown[]).length > 500)) fail('exact bounded record lists required');
  const text = (v: unknown): string => typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : fail('invalid identity');
  const hash = (v: unknown): string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v) ? v : fail('invalid sha256');
  const revision = (v: unknown): number => Number.isSafeInteger(v) && Number(v) > 0 ? Number(v) : fail('invalid revision');
  const exact = (v: unknown, fields: string[]) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== fields.length || fields.some(key => !Object.hasOwn(v,key))) fail('unexpected pin fields'); return v as Record<string,unknown>; };
  const plans = validatePlanList(o.plans), assignments = validateAssignmentList(o.assignments), runs = validateRunList(o.runs), reviews = validateReviewList(o.reviews);
  const approvals = (o.approvals as unknown[]).map((value,index) => validateApproval(value,`externalLoop.approvals[${index}]`));
  const pins = (o.pins as unknown[]).map(value => { const p=exact(value,['planId','ideaId','ideaRevision','ideaHash','profileRevision','sources']); if (!Array.isArray(p.sources) || p.sources.length > 500) fail('invalid pinned sources'); return { planId:text(p.planId),ideaId:text(p.ideaId),ideaRevision:revision(p.ideaRevision),ideaHash:hash(p.ideaHash),profileRevision:revision(p.profileRevision),sources:(p.sources as unknown[]).map(value=>{const s=exact(value,['sourceId','revision','sha256']);return {sourceId:text(s.sourceId),revision:revision(s.revision),sha256:hash(s.sha256)};}) }; });
  if (new Set(pins.map(p=>p.planId)).size!==pins.length || pins.length!==plans.length || plans.some(plan=>!pins.some(p=>p.planId===plan.planId&&p.ideaId===plan.ideaId))) fail('plan pins missing or duplicated');
  for(const a of assignments)if(!plans.some(p=>p.planId===a.planId&&p.revision===a.planRevision&&p.contentHash===a.planHash))fail('assignment plan mismatch');
  for(const r of runs)if(!assignments.some(a=>a.assignmentId===r.assignmentId&&a.planId===r.planId&&a.planRevision===r.planRevision&&a.planHash===r.planHash))fail('run assignment mismatch');
  for(const r of reviews)if(r.runIds.some(id=>!runs.some(run=>run.runId===id)))fail('review references missing run');
  if(new Set(approvals.map(a=>a.approvalId)).size!==approvals.length)fail('duplicate approval');
  return {plans,assignments,approvals,runs,reviews,pins};
}
