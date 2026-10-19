import { object, str, num, list, one, hash, type RawCell } from './general-data.ts';
import { METRIC_STATISTICS, type MetricStatistic } from './general-metrics.ts';

export interface GeneralSourceAccess {
  decisionId: string; sourceId: string; allowed: boolean; reason: string;
  actor: { identity: string; actionId: string }; createdAt: string;
}
export type GeneralEvidenceLocator =
  | { kind: 'text'; sourceId: string; sourceSha256: string; startByte: number; endByte: number; quote: string }
  | { kind: 'pdf'; sourceId: string; sourceSha256: string; page: number; quote: string; pagesSha256: string }
  | { kind: 'table'; sourceId: string; sourceSha256: string; parsedSha256: string; datasetId: string; datasetVersion: number; dictionaryHash: string; tableId: string; row: number; columns: number[]; raw: RawCell[]; interpreted: RawCell[] | null }
  | { kind: 'calculation'; calculationId: string; artifact: { id: string; sha256: string }; summaryIndex: number; statistic: MetricStatistic; value: number | null; unit: string };
export interface GeneralKnowledgeClaim {
  claimId: string; text: string; nature: 'hypothesis' | 'inference' | 'source_reported' | 'system_calculation' | 'unknown';
  locators: GeneralEvidenceLocator[]; limitation: string;
}
export interface GeneralEvidenceCheck {
  status: 'current' | 'needs_review' | 'unavailable' | 'revoked' | 'unlocated';
  reasons: string[]; sourceIds: string[]; inputNatures: string[];
  check: 'locator_checked' | 'unavailable' | 'unlocated';
}
export interface GeneralKnowledgeEvidenceProjection { entries: (GeneralEvidenceCheck & { entryId: string; version: number })[]; boundary: string }
export const GENERAL_EVIDENCE_LIMITS = Object.freeze({ maxClaims: 50, maxLocators: 20, maxTextSourceBytes: 256 * 1024, maxSearchBytes: 1024 * 1024, maxChunks: 1000, maxHits: 20, maxTokens: 6000 });
export function validateGeneralSourceAccess(v: unknown): GeneralSourceAccess {
  const p = object(v, ['decisionId', 'sourceId', 'allowed', 'reason', 'actor', 'createdAt'], 'source access');
  const a = object(p.actor, ['identity', 'actionId'], 'access actor');
  if (typeof p.allowed !== 'boolean') throw new Error('Access allowed must be boolean');
  return { decisionId: str(p.decisionId, 'decisionId', 200, true), sourceId: str(p.sourceId, 'sourceId', 200, true), allowed: p.allowed, reason: str(p.reason, 'access reason', 4000, true), actor: { identity: str(a.identity, 'actor identity', 200, true), actionId: str(a.actionId, 'actor actionId', 200, true) }, createdAt: timestamp(p.createdAt) };
}
export function timestamp(v: unknown): string {
  const s = str(v, 'timestamp', 100, true); if (!Number.isFinite(Date.parse(s))) throw new Error('Invalid evidence timestamp'); return s;
}
export function evidenceArtifactRef(v: unknown): { id: string; sha256: string } {
  const a = object(v, ['id', 'sha256'], 'registered artifact'); const sha256 = hash(a.sha256);
  if (a.id !== `artifacts/${sha256}.json`) throw new Error('Artifact must be content-addressed in the research namespace');
  return { id: a.id as string, sha256 };
}
const finite = (v: unknown): number | null => { if (v === null) return null; if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('Evidence value must be finite or null'); return v; };
const rawCell = (v: unknown): RawCell => { if (v === null || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) return v; return str(v, 'raw cell', 10000); };
export function validateGeneralEvidenceLocator(v: unknown): GeneralEvidenceLocator {
  const kind = one((v as { kind?: unknown } | null)?.kind, ['text', 'pdf', 'table', 'calculation'] as const, 'locator kind');
  if (kind === 'text') {
    const l = object(v, ['kind', 'sourceId', 'sourceSha256', 'startByte', 'endByte', 'quote'], 'text locator');
    const startByte = num(l.startByte, 'startByte', 0, 10 * 1024 * 1024), endByte = num(l.endByte, 'endByte', 0, 10 * 1024 * 1024);
    if (endByte <= startByte || endByte - startByte > 16000) throw new Error('Text locator requires a nonempty bounded UTF-8 byte range');
    return { kind, sourceId: str(l.sourceId, 'sourceId', 200, true), sourceSha256: hash(l.sourceSha256), startByte, endByte, quote: str(l.quote, 'quote', 4000, true) };
  }
  if (kind === 'pdf') {
    const l = object(v, ['kind', 'sourceId', 'sourceSha256', 'page', 'quote', 'pagesSha256'], 'pdf locator');
    const page = num(l.page, 'pdf page', 1, 300);
    const quote = str(l.quote, 'pdf quote', 4000, true);
    if (quote.trim().length < 8) throw new Error('PDF locator quote must be at least 8 characters of extracted page text');
    return { kind, sourceId: str(l.sourceId, 'sourceId', 200, true), sourceSha256: hash(l.sourceSha256), page, quote, pagesSha256: hash(l.pagesSha256) };
  }
  if (kind === 'table') {
    const l = object(v, ['kind', 'sourceId', 'sourceSha256', 'parsedSha256', 'datasetId', 'datasetVersion', 'dictionaryHash', 'tableId', 'row', 'columns', 'raw', 'interpreted'], 'table locator');
    const columns = list(l.columns, 'columns', 50).map(v => num(v, 'column', 0, 199)), raw = list(l.raw, 'raw cells', 50).map(rawCell), interpreted = l.interpreted === null ? null : list(l.interpreted, 'interpreted cells', 50).map(rawCell);
    if (!columns.length || new Set(columns).size !== columns.length || raw.length !== columns.length || interpreted !== null && interpreted.length !== columns.length) throw new Error('Table locator columns/cells must match');
    return { kind, sourceId: str(l.sourceId, 'sourceId', 200, true), sourceSha256: hash(l.sourceSha256), parsedSha256: hash(l.parsedSha256), datasetId: str(l.datasetId, 'datasetId', 200, true), datasetVersion: num(l.datasetVersion, 'datasetVersion', 1, 1000), dictionaryHash: hash(l.dictionaryHash), tableId: str(l.tableId, 'tableId', 200, true), row: num(l.row, 'row', 0, 49999), columns, raw, interpreted };
  }
  const l = object(v, ['kind', 'calculationId', 'artifact', 'summaryIndex', 'statistic', 'value', 'unit'], 'calculation locator');
  return { kind, calculationId: str(l.calculationId, 'calculationId', 200, true), artifact: evidenceArtifactRef(l.artifact), summaryIndex: num(l.summaryIndex, 'summaryIndex', 0, 9999), statistic: one(l.statistic, METRIC_STATISTICS, 'statistic'), value: finite(l.value), unit: str(l.unit, 'unit', 4000, true) };
}
export function validateGeneralKnowledgeClaim(v: unknown): GeneralKnowledgeClaim {
  const c = object(v, ['claimId', 'text', 'nature', 'locators', 'limitation'], 'knowledge claim');
  const nature = one(c.nature, ['hypothesis', 'inference', 'source_reported', 'system_calculation', 'unknown'] as const, 'claim nature');
  const locators = list(c.locators, 'claim locators', GENERAL_EVIDENCE_LIMITS.maxLocators).map(validateGeneralEvidenceLocator);
  if (['source_reported', 'system_calculation'].includes(nature) && !locators.length) throw new Error('Reported/calculated claims require exact locators');
  if (nature === 'system_calculation' && locators.some(l => l.kind !== 'calculation')) throw new Error('System calculation claim may cite registered calculations only');
  return { claimId: str(c.claimId, 'claimId', 200, true), text: str(c.text, 'claim text', 4000, true), nature, locators, limitation: str(c.limitation, 'claim limitation', 4000, true) };
}
