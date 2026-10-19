import { object, str, list, num } from './general-data.ts';
import { evidenceArtifactRef, timestamp } from './general-evidence.ts';
export interface GeneralImportedHistory {
  importId: string; originalResearchId: string; title: string; importedAt: string;
  status: 'needs_review'; packageRef: { id: string; sha256: string };
  actor: { identity: string; actionId: string };
  idMap: { kind: 'node' | 'edge' | 'idea' | 'source' | 'dataset' | 'knowledge' | 'relation'; original: string; current: string }[];
}
export interface GeneralImportedPlanOrigin {
  importId: string; packageRef: { id: string; sha256: string }; originalPlanId: string; originalVersion: number;
  reason: string; actor: { identity: string; actionId: string }; adoptedAt: string;
}
export function validateGeneralImportedPlanOrigin(v: unknown): GeneralImportedPlanOrigin {
  const o = object(v, ['importId', 'packageRef', 'originalPlanId', 'originalVersion', 'reason', 'actor', 'adoptedAt'], 'imported plan origin');
  const a = object(o.actor, ['identity', 'actionId'], 'adoption actor');
  return { importId: str(o.importId, 'importId', 200, true), packageRef: evidenceArtifactRef(o.packageRef), originalPlanId: str(o.originalPlanId, 'originalPlanId', 200, true), originalVersion: num(o.originalVersion, 'originalVersion', 1, 1000), reason: str(o.reason, 'adoption reason', 4000, true), actor: { identity: str(a.identity, 'adoption identity', 200, true), actionId: str(a.actionId, 'adoption actionId', 200, true) }, adoptedAt: timestamp(o.adoptedAt) };
}
export function validateGeneralImportedHistory(v: unknown): GeneralImportedHistory {
  const r = object(v, ['importId', 'originalResearchId', 'title', 'importedAt', 'status', 'packageRef', 'actor', 'idMap'], 'imported history');
  if (r.status !== 'needs_review') throw new Error('Imported history must await local review');
  const a = object(r.actor, ['identity', 'actionId'], 'import actor');
  const idMap = list(r.idMap, 'import ID map', 3000).map(v => {
    const m = object(v, ['kind', 'original', 'current'], 'mapped identity');
    if (!['node', 'edge', 'idea', 'source', 'dataset', 'knowledge', 'relation'].includes(m.kind as string)) throw new Error('Invalid mapped identity kind');
    return { kind: m.kind as GeneralImportedHistory['idMap'][number]['kind'], original: str(m.original, 'original ID', 200, true), current: str(m.current, 'current ID', 200, true) };
  });
  if (new Set(idMap.map(m => `${m.kind}:${m.original}`)).size !== idMap.length || new Set(idMap.map(m => m.current)).size !== idMap.length) throw new Error('Duplicate import identity mapping');
  return { importId: str(r.importId, 'importId', 200, true), originalResearchId: str(r.originalResearchId, 'originalResearchId', 200, true), title: str(r.title, 'import title', 300, true), importedAt: timestamp(r.importedAt), status: 'needs_review', packageRef: evidenceArtifactRef(r.packageRef), actor: { identity: str(a.identity, 'import identity', 200, true), actionId: str(a.actionId, 'import actionId', 200, true) }, idMap };
}
