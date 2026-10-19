import { object, str, num, list, hash, one, type RawCell, MATERIAL_NATURES, type MaterialNature } from './general-data.ts';
import { validateDatasetInputRef, type DatasetInputRef } from './general-analysis.ts';
import { validateInferenceInput, type InferenceInput, type InferenceResult } from './general-inference.ts';
import { timestamp, evidenceArtifactRef } from './general-evidence.ts';
export interface InferencePlan {
  planId: string; version: number; nodeId: string; title: string; dataset: DatasetInputRef; parsedSha256: string;
  nodeSnapshotHash: string; dependencySnapshotHash: string; contextHash: string; sourceRefs: string[];
  spec: Omit<InferenceInput, 'sampleA' | 'sampleB'>;
  valueColumn: number; sampleColumn: number; groups: { column: number; a: Exclude<RawCell, null>; b: Exclude<RawCell, null> } | null;
  rowRange: { start: number; end: number }; requiredConditions: string[]; limitations: string[];
  actor: { identity: string; actionId: string }; createdAt: string;
}
export interface InferenceRun {
  runId: string; planId: string; planVersion: number; nodeId: string; attempt: number; nature: MaterialNature;
  tool: InferenceResult['tool'];
  status: 'completed' | 'blocked' | 'failed'; artifact: { id: string; sha256: string } | null;
  firstError: { code: string; message: string } | null; startedAt: string; finishedAt: string;
}
export function validateInferencePlan(v: unknown): InferencePlan {
  const p = object(v, ['planId', 'version', 'nodeId', 'title', 'dataset', 'parsedSha256', 'nodeSnapshotHash', 'dependencySnapshotHash', 'contextHash', 'sourceRefs', 'spec', 'valueColumn', 'sampleColumn', 'groups', 'rowRange', 'requiredConditions', 'limitations', 'actor', 'createdAt'], 'inference plan');
  const rawSpec = object(p.spec, ['method', 'confidence', 'unit', 'referenceMean', 'missingPolicy', 'assumptions'], 'inference specification');
  const parsed = validateInferenceInput({ ...rawSpec, sampleA: [], sampleB: rawSpec.method === 'one_sample_t' ? null : [] });
  const { sampleA: _, sampleB: __, ...spec } = parsed;
  const groupValue = (v: unknown): Exclude<RawCell, null> => { if (typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v; return str(v, 'group value', 10000, true); };
  const g = p.groups === null ? null : object(p.groups, ['column', 'a', 'b'], 'inference groups');
  const groups = g ? { column: num(g.column, 'group column', 0, 199), a: groupValue(g.a), b: groupValue(g.b) } : null;
  if (spec.method === 'one_sample_t' ? groups !== null : groups === null || JSON.stringify(groups.a) === JSON.stringify(groups.b)) throw new Error('Group specification differs from inference method');
  const valueColumn = num(p.valueColumn, 'value column', 0, 199), sampleColumn = num(p.sampleColumn, 'sample column', 0, 199);
  if (valueColumn === sampleColumn || groups && [valueColumn, sampleColumn].includes(groups.column)) throw new Error('Inference columns must have separate roles');
  const range = object(p.rowRange, ['start', 'end'], 'inference row range'), rowRange = { start: num(range.start, 'start', 0, 50000), end: num(range.end, 'end', 0, 50000) };
  if (rowRange.end < rowRange.start) throw new Error('Invalid inference range');
  const strings = (v: unknown, name: string) => list(v, name, 100).map(v => str(v, name, 4000, true));
  const actor = object(p.actor, ['identity', 'actionId'], 'inference actor');
  return { planId: str(p.planId, 'planId', 200, true), version: num(p.version, 'plan version', 1, 1000), nodeId: str(p.nodeId, 'nodeId', 200, true), title: str(p.title, 'plan title', 300, true), dataset: validateDatasetInputRef(p.dataset), parsedSha256: hash(p.parsedSha256), nodeSnapshotHash: hash(p.nodeSnapshotHash), dependencySnapshotHash: hash(p.dependencySnapshotHash), contextHash: hash(p.contextHash), sourceRefs: list(p.sourceRefs, 'inference sourceRefs', 100).map(v => str(v, 'sourceRef', 200, true)), spec, valueColumn, sampleColumn, groups, rowRange, requiredConditions: strings(p.requiredConditions, 'required conditions'), limitations: strings(p.limitations, 'limitations'), actor: { identity: str(actor.identity, 'inference identity', 200, true), actionId: str(actor.actionId, 'inference actionId', 200, true) }, createdAt: timestamp(p.createdAt) };
}
export function validateInferenceRun(v: unknown): InferenceRun {
  const r = object(v, ['runId', 'planId', 'planVersion', 'nodeId', 'attempt', 'nature', 'tool', 'status', 'artifact', 'firstError', 'startedAt', 'finishedAt'], 'inference run');
  const t = object(r.tool, ['name', 'version', 'runtime'], 'inference tool');
  const tool: InferenceResult['tool'] = { name: one(t.name, ['dsh-student-t'] as const, 'tool name'), version: one(t.version, ['1.0.0'] as const, 'tool version'), runtime: str(t.runtime, 'tool runtime', 100, true) };
  const artifact = r.artifact === null ? null : evidenceArtifactRef(r.artifact), e = r.firstError === null ? null : object(r.firstError, ['code', 'message'], 'inference error');
  const status = one(r.status, ['completed', 'blocked', 'failed'] as const, 'inference status');
  if (status === 'completed' ? !artifact || e !== null : artifact !== null || !e) throw new Error('Inference status/artifact/error mismatch');
  const startedAt = timestamp(r.startedAt), finishedAt = timestamp(r.finishedAt); if (Date.parse(finishedAt) < Date.parse(startedAt)) throw new Error('Inference finish precedes start');
  return { runId: str(r.runId, 'runId', 200, true), planId: str(r.planId, 'planId', 200, true), planVersion: num(r.planVersion, 'planVersion', 1, 1000), nodeId: str(r.nodeId, 'nodeId', 200, true), attempt: num(r.attempt, 'attempt', 1, 10), nature: one(r.nature, MATERIAL_NATURES, 'inference nature'), tool, status, artifact, firstError: e ? { code: str(e.code, 'error code', 100, true), message: str(e.message, 'error message', 4000, true) } : null, startedAt, finishedAt };
}
