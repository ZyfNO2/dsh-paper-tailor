/** Strict generic deliverables share the existing CycleStore/runtime, not the legacy algorithm schema. */
import { object, str, list, one } from './general-data.ts';
import { validateCycleInputRefs, validateGraphPatchShape, type CycleArtifactKind, type CycleDecisionPayload } from './research-cycle.ts';
import { expAssertArtifactRef } from './experiments.ts';
const strings = (v: unknown, name: string) => list(v, name, 10).map(x => str(x, name, 2000, true));
export const GENERAL_CYCLE_FIELDS = {
  hypothesis: 'researchMode:"general", ideaRef:{ideaId,contentRevision,contentHash}, hypothesis,motivation,variable,expectedResult:string, sourceRefs:assigned CycleInputRef[], notes:string|null',
  planner: 'researchMode:"general", proposalRef:exact predecessor ArtifactRef, method,procedure,completionCriteria:string, fixedConditions,measurements,openQuestions:string[]',
  evidence: 'researchMode:"general", proposalRef,planRef:exact predecessor ArtifactRefs, findings:{claim,support,sourceNature:literature|user_observation|user_result|system_calculation|simulation|hypothesis|inference|unknown,sourceRefs:assigned CycleInputRef[]}[], gaps:string[], summary:string',
  reviewer: 'researchMode:"general", proposalRef,planRef,evidenceRef:exact predecessor ArtifactRefs, decision:keep|pause|reject|needs_validation, reason:string, nextActions:{actionId,kind:validation|combination|analysis|literature,title,detail}[], graphPatch:{addNodes:[],addEdges:[],branchDecisions:[]}. Future graph patch nodes/edges use the existing CycleGraphPatch schema; empty arrays are valid. Never invent observations, verified science or automatically run future work.',
} as const;
export function validateGeneralCyclePayload(kind: CycleArtifactKind, raw: unknown): Record<string, unknown> {
  if (JSON.stringify(raw).length > 44000) throw new Error('Generic deliverable exceeds the 44000-character assigned-input budget');
  const fields = kind === 'proposal' ? ['ideaRef', 'hypothesis', 'motivation', 'variable', 'expectedResult', 'sourceRefs', 'notes'] : kind === 'experiment_plan' ? ['proposalRef', 'method', 'procedure', 'fixedConditions', 'measurements', 'completionCriteria', 'openQuestions'] : kind === 'evidence_report' ? ['proposalRef', 'planRef', 'findings', 'gaps', 'summary'] : ['proposalRef', 'planRef', 'evidenceRef', 'decision', 'reason', 'nextActions', 'graphPatch'];
  const p = object(raw, ['schemaVersion', 'researchMode', 'kind', ...fields], 'generic cycle payload');
  if (p.schemaVersion !== 1 || p.researchMode !== 'general' || p.kind !== kind) throw new Error('Generic cycle payload discriminator mismatch');
  const result: Record<string, unknown> = { schemaVersion: 1, researchMode: 'general', kind };
  for (const name of fields) {
    if (name.endsWith('Ref') && name !== 'ideaRef') result[name] = expAssertArtifactRef(p[name], name);
    else if (name === 'ideaRef') { const i = object(p[name], ['ideaId', 'contentRevision', 'contentHash'], name); if (!Number.isSafeInteger(i.contentRevision) || Number(i.contentRevision) < 1 || typeof i.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(i.contentHash)) throw new Error('Invalid generic Idea ref'); result[name] = { ideaId: str(i.ideaId, 'ideaId', 200, true), contentRevision: i.contentRevision, contentHash: i.contentHash }; }
    else if (name === 'sourceRefs') result[name] = validateCycleInputRefs(p[name], name);
    else if (name === 'notes') result[name] = p[name] === null ? null : str(p[name], name, 2000);
    else if (['fixedConditions', 'measurements', 'openQuestions', 'gaps'].includes(name)) result[name] = strings(p[name], name);
    else if (name === 'findings') result[name] = list(p[name], name, 20).map(v => { const f = object(v, ['claim', 'support', 'sourceNature', 'sourceRefs'], 'finding'); const refs = validateCycleInputRefs(f.sourceRefs, 'finding sourceRefs'); const nature = one(f.sourceNature, ['literature', 'user_observation', 'user_result', 'system_calculation', 'simulation', 'hypothesis', 'inference', 'unknown'] as const, 'sourceNature'); if (!['hypothesis', 'inference', 'unknown'].includes(nature) && !refs.length) throw new Error('Observed finding requires assigned evidence'); return { claim: str(f.claim, 'claim', 2000, true), support: str(f.support, 'support', 4000, true), sourceNature: nature, sourceRefs: refs }; });
    else if (name === 'decision') result[name] = one(p[name], ['keep', 'pause', 'reject', 'needs_validation'] as const, 'decision');
    else if (name === 'graphPatch') result[name] = validateGraphPatchShape(p[name], 'general graphPatch');
    else if (name === 'nextActions') result[name] = list(p[name], name, 10).map(v => { const a = object(v, ['actionId', 'kind', 'title', 'detail'], 'nextAction'); return { actionId: str(a.actionId, 'actionId', 200, true), kind: one(a.kind, ['validation', 'combination', 'analysis', 'literature'] as const, 'nextAction kind'), title: str(a.title, 'title', 300, true), detail: str(a.detail, 'detail', 2000, true) }; });
    else result[name] = str(p[name], name, name === 'variable' || name === 'hypothesis' ? 300 : 4000, true);
  }
  return result;
}
export const genericDecision = (raw: unknown) => validateGeneralCyclePayload('decision', raw) as unknown as CycleDecisionPayload;
