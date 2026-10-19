import { object, str, list, num, one, hash } from './general-data.ts';
import { validateGeneralKnowledgeClaim, GENERAL_EVIDENCE_LIMITS, type GeneralKnowledgeClaim } from './general-evidence.ts';
export const KNOWLEDGE_ENTITY_TYPES = ['entity', 'concept', 'overview', 'metric', 'experiment'] as const;
export type KnowledgeEntityType = typeof KNOWLEDGE_ENTITY_TYPES[number];
export interface GeneralKnowledgeEntry {
  /** Optional only for backward-compatible, unlocated legacy entries. New saves pin context and claims. */
  claims?: GeneralKnowledgeClaim[]; contextHash?: string; nodeContextHash?: string;
  /** F08: wiki 图谱的实体语义类型（source 由 kind=source 节点表达；method 条目不设此字段）。 */
  entityType?: KnowledgeEntityType | null;
  okfMetadata?: Record<string, unknown>;
  images?: { sourceId: string; caption: string }[];
  counterEvidence?: string[];
  limitations?: string[];
  sourcePins?: { sourceId: string; sha256: string }[];
  entryId: string; version: number; kind: 'wiki' | 'method'; title: string; category: string; content: string;
  nature: 'hypothesis' | 'inference' | 'source_reported' | 'unknown'; sourceRefs: string[]; calculationIds: string[]; nodeIds: string[];
  input: string; output: string; conditions: string[];
  parameters: { key: string; type: 'number' | 'string' | 'boolean'; unit: string | null; description: string }[];
  operation: 'manual' | 'existing_calculation' | 'external_not_connected'; archived: boolean; createdAt: string;
}
export function validateGeneralKnowledge(raw: unknown): GeneralKnowledgeEntry {
  const e = object(raw, ['entryId', 'version', 'kind', 'title', 'category', 'content', 'nature', 'sourceRefs', 'calculationIds', 'nodeIds', 'input', 'output', 'conditions', 'parameters', 'operation', 'archived', 'createdAt', 'claims', 'contextHash', 'nodeContextHash', 'entityType', 'images', 'counterEvidence', 'limitations', 'sourcePins', 'okfMetadata'], 'general knowledge', ['claims', 'contextHash', 'nodeContextHash', 'entityType', 'images', 'counterEvidence', 'limitations', 'sourcePins', 'okfMetadata']);
  const ids = (v: unknown, label: string) => { const result = list(v, label, 100).map(x => str(x, label, 200, true)); if (new Set(result).size !== result.length) throw new Error('Duplicate knowledge reference'); return result; };
  if (typeof e.archived !== 'boolean') throw new Error('Knowledge archived must be boolean');
  const createdAt = str(e.createdAt, 'createdAt', 100, true); if (!Number.isFinite(Date.parse(createdAt))) throw new Error('Invalid knowledge timestamp');
  const parameters = list(e.parameters, 'parameters', 50).map(v => { const p = object(v, ['key', 'type', 'unit', 'description'], 'parameter'); return { key: str(p.key, 'key', 100, true), type: one(p.type, ['number', 'string', 'boolean'] as const, 'parameter type'), unit: p.unit === null ? null : str(p.unit, 'unit', 100, true), description: str(p.description, 'parameter description', 1000) }; });
  if (new Set(parameters.map(p => p.key)).size !== parameters.length) throw new Error('Duplicate parameter identity');
  const claims = e.claims === undefined ? [] : list(e.claims, 'claims', GENERAL_EVIDENCE_LIMITS.maxClaims).map(validateGeneralKnowledgeClaim);
  if (new Set(claims.map(c => c.claimId)).size !== claims.length) throw new Error('Duplicate claim identity');
  const entityType = e.entityType === undefined || e.entityType === null ? null : one(e.entityType, KNOWLEDGE_ENTITY_TYPES, 'knowledge entity type');
  const images = list(e.images ?? [], 'knowledge images', 20).map(v => { const i = object(v, ['sourceId', 'caption'], 'knowledge image'); return { sourceId: str(i.sourceId, 'image source', 200, true), caption: str(i.caption, 'image caption', 1000) }; });
  const sourcePins = list(e.sourcePins ?? [], 'source pins', 100).map(v => { const s = object(v, ['sourceId', 'sha256'], 'source pin'); return { sourceId: str(s.sourceId, 'pin source', 200, true), sha256: hash(s.sha256) }; });
  const counterEvidence = list(e.counterEvidence ?? [], 'counter evidence', 50).map(v => str(v, 'counter evidence', 4000, true));
  const limitations = list(e.limitations ?? [], 'limitations', 50).map(v => str(v, 'limitation', 4000, true));
  const okfMetadata = e.okfMetadata === undefined ? {} : JSON.parse(str(JSON.stringify(e.okfMetadata), 'OKF metadata', 16000));
  if (!okfMetadata || Array.isArray(okfMetadata) || typeof okfMetadata !== 'object') throw new Error('Invalid OKF metadata');
  return { okfMetadata, images, sourcePins, counterEvidence, limitations, ...(e.nodeContextHash === undefined ? {} : { nodeContextHash: hash(e.nodeContextHash) }), ...(e.contextHash === undefined ? {} : { contextHash: hash(e.contextHash) }), ...(e.claims === undefined ? {} : { claims }), ...(entityType === null ? {} : { entityType }), entryId: str(e.entryId, 'entryId', 200, true), version: num(e.version, 'version', 1, 201), kind: one(e.kind, ['wiki', 'method'] as const, 'knowledge kind'), title: str(e.title, 'title', 300, true), category: str(e.category, 'category', 100, true), content: str(e.content, 'content', 12000, true), nature: one(e.nature, ['hypothesis', 'inference', 'source_reported', 'unknown'] as const, 'knowledge nature'), sourceRefs: ids(e.sourceRefs, 'sources'), calculationIds: ids(e.calculationIds, 'calculations'), nodeIds: ids(e.nodeIds, 'nodes'), input: str(e.input, 'input'), output: str(e.output, 'output'), conditions: list(e.conditions, 'conditions', 100).map(v => str(v, 'condition', 4000, true)), parameters, operation: one(e.operation, ['manual', 'existing_calculation', 'external_not_connected'] as const, 'operation'), archived: e.archived, createdAt };
}

/** F08：人工知识关系（有身份、有版本）；evidence_for 是证据关系，必须有定位依据。 */
export interface GeneralKnowledgeRelation {
  relationId: string; version: number;
  fromEntryId: string; toEntryId: string;
  kind: 'related' | 'evidence_for';
  note: string;
  locator: { kind: 'text'; quote: string; sourceId: string } | { kind: 'calculation'; calculationId: string } | null;
  createdAt: string; updatedAt: string;
}
export function validateGeneralKnowledgeRelation(raw: unknown): GeneralKnowledgeRelation {
  const r = object(raw, ['relationId', 'version', 'fromEntryId', 'toEntryId', 'kind', 'note', 'locator', 'createdAt', 'updatedAt'], 'knowledge relation');
  const kind = one(r.kind, ['related', 'evidence_for'] as const, 'relation kind');
  const locator = r.locator === null || r.locator === undefined ? null : (() => {
    const l = object(r.locator, ['kind', 'quote', 'sourceId', 'calculationId'], 'relation locator', ['quote', 'sourceId', 'calculationId']);
    if (l.kind === 'text') return { kind: 'text' as const, quote: str(l.quote, 'relation locator quote', 4000, true), sourceId: str(l.sourceId, 'relation locator source', 200, true) };
    if (l.kind === 'calculation') return { kind: 'calculation' as const, calculationId: str(l.calculationId, 'relation locator calculation', 200, true), quote: '', sourceId: '' };
    throw new Error('relation locator: unsupported kind');
  })();
  if (kind === 'evidence_for' && locator === null) throw new Error('evidence_for relation requires a locator');
  return {
    relationId: str(r.relationId, 'relationId', 200, true), version: num(r.version, 'relation version', 1, 201),
    fromEntryId: str(r.fromEntryId, 'relation from', 200, true), toEntryId: str(r.toEntryId, 'relation to', 200, true),
    kind, note: str(r.note, 'relation note', 4000, true), locator,
    createdAt: str(r.createdAt, 'relation createdAt', 100, true), updatedAt: str(r.updatedAt, 'relation updatedAt', 100, true),
  };
}
