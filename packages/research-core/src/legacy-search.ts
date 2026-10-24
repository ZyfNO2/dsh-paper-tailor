import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { LiteratureConnector, saveSearchSnapshot, type SearchSnapshot } from '../../evolver/src/application/research-literature.ts';
import { checkedDirectory } from '../../evolver/src/application/research-execution-runtime.ts';
import { digest, id, text, record, choice } from '../../evolver/src/contracts/research-foundations.ts';
import type { ResearchFoundationsService } from '../../evolver/src/application/research-foundations-service.ts';
import { validateActorContext, type ActorContext } from '../../research-contracts/src/index.ts';

const providers = ['openalex', 'crossref', 'europepmc', 'semantic_scholar'] as const;
const hash = (value: unknown) => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid search record hash'); return value; };
const date = (value: unknown) => { const result = text(value, 'search date', 50); if (new Date(result).toISOString() !== result) throw new Error('Invalid search date'); return result; };
type SearchStart = { schemaVersion: 1; researchId: string; attemptId: string; provider: SearchSnapshot['provider']; query: string; page: string; startedAt: string; actor: ActorContext };
type SearchResult = { snapshotId: string; sha256: string; responseHash: string; hitCount: number; nextPage: string | null };
type SearchError = { name: string; message: string; stack: string | null; cause: SearchError | null };
type SearchFinish = { schemaVersion: 1; attemptId: string; startedHash: string; finishedAt: string; status: 'completed' | 'search_incomplete'; result: SearchResult | null; error: SearchError | null; closedBy?: ActorContext };
export type SearchAttempt = SearchStart & { status: 'running' | SearchFinish['status']; finishedAt: string | null; result: SearchResult | null; error: SearchError | null; closedBy?: ActorContext };
function searchActor(raw: unknown) { const actor = validateActorContext(raw); if (!(actor.kind === 'agent' && actor.source === 'mcp' || actor.kind === 'user' && ['http', 'cli'].includes(actor.source))) throw new Error('Search actor transport mismatch'); return actor; }

function envelope(bytes: Buffer) { if (bytes.length > 65536) throw new Error('Search record exceeds 64 KiB'); const value = JSON.parse(bytes.toString('utf8')); record(value, ['sha256', 'value']); if (hash(value.sha256) !== digest(value.value)) throw new Error('Search record hash mismatch'); return value; }
function errorRecord(raw: unknown, depth = 0): SearchError {
  const value = record(raw, ['name', 'message', 'stack', 'cause']);
  if (depth > 3) throw new Error('Search error cause depth exceeded');
  return { name: text(value.name, 'error name', 200), message: text(value.message, 'error message', 6000), stack: value.stack === null ? null : text(value.stack, 'error stack', 12000), cause: value.cause === null ? null : errorRecord(value.cause, depth + 1) };
}
/** Used for both filesystem reads and backup validation; a missing finish stays running. */
export function decodeSearchAttempts(files: Array<{ name: string; bytes: Buffer }>, researchId: string): SearchAttempt[] {
  if (files.length > 4096) throw new Error('Search history read limit exceeded');
  const starts = new Map<string, { value: SearchStart; sha256: string }>(), finishes = new Map<string, SearchFinish>();
  for (const file of files) {
    if (!/^search-[a-f0-9-]{36}\.(started|finished)\.json$/.test(file.name)) throw new Error('Unexpected search history file');
    const decoded = envelope(file.bytes), value = decoded.value;
    if (value.schemaVersion !== 1 || file.name !== `${value.attemptId}.${file.name.includes('.started.') ? 'started' : 'finished'}.json`) throw new Error('Search record identity mismatch');
    id(value.attemptId);
    if (file.name.includes('.started.')) {
      record(value, ['schemaVersion', 'researchId', 'attemptId', 'provider', 'query', 'page', 'startedAt', 'actor']);
      if (value.researchId !== researchId || starts.has(value.attemptId)) throw new Error('Search record research/identity mismatch');
      choice(value.provider, providers); text(value.query, 'query', 2000); text(value.page, 'page', 2000); date(value.startedAt);
      searchActor(value.actor);
      starts.set(value.attemptId, decoded);
    } else {
      record(value, ['schemaVersion', 'attemptId', 'startedHash', 'finishedAt', 'status', 'result', 'error', 'closedBy']); hash(value.startedHash); date(value.finishedAt); choice(value.status, ['completed', 'search_incomplete']);
      if (value.closedBy !== undefined && (searchActor(value.closedBy).kind !== 'user' || value.status !== 'search_incomplete' || value.error?.name !== 'UserCancelled')) throw new Error('Invalid user search closure provenance');
      if (finishes.has(value.attemptId)) throw new Error('Duplicate search finish');
      if (value.status === 'completed') {
        if (value.error !== null) throw new Error('Completed search cannot contain a failure');
        record(value.result, ['snapshotId', 'sha256', 'responseHash', 'hitCount', 'nextPage']); hash(value.result.snapshotId); hash(value.result.sha256); hash(value.result.responseHash);
        if (!Number.isSafeInteger(value.result.hitCount) || value.result.hitCount < 0 || value.result.hitCount > 100) throw new Error('Invalid search hit count');
        if (value.result.nextPage !== null) text(value.result.nextPage, 'cursor', 2000);
      } else { if (value.result !== null) throw new Error('Failed search cannot have a successful result'); errorRecord(value.error); }
      finishes.set(value.attemptId, value);
    }
  }
  for (const finish of finishes.values()) if (!starts.has(finish.attemptId)) throw new Error('Search finish missing original request');
  return [...starts.values()].map<SearchAttempt>(({ value, sha256 }) => {
    const finish = finishes.get(value.attemptId);
    if (finish && (finish.startedHash !== sha256 || finish.finishedAt < value.startedAt)) throw new Error('Search finish does not match original request');
    return { ...value, status: finish?.status ?? 'running', finishedAt: finish?.finishedAt ?? null, result: finish?.result ?? null, error: finish?.error ?? null, ...(finish?.closedBy ? { closedBy: finish.closedBy } : {}) };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.attemptId.localeCompare(a.attemptId));
}
function rootFor(service: ResearchFoundationsService, researchId: string, create = false, leaf: 'search-attempts' | 'searches' = 'search-attempts') {
  service.snapshot(id(researchId));
  const relative = path.join('.dsh', 'research', 'foundation-assets', researchId, leaf);
  if (create) return checkedDirectory(service.store.workspaceRoot, relative);
  let current = fs.realpathSync(service.store.workspaceRoot);
  for (const part of relative.split(path.sep)) { current = path.join(current, part); if (!fs.existsSync(current)) return null; if (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory()) throw new Error('Search history directory cannot be a link/file'); }
  return current;
}
export function readSearchAttempts(service: ResearchFoundationsService, researchId: string) {
  const root = rootFor(service, researchId);
  if (!root) return [];
  const names = fs.readdirSync(root); if (names.length > 4096) throw new Error('Search history read limit exceeded');
  return decodeSearchAttempts(names.map(name => { const file = path.join(root, name), stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid search history file'); return { name, bytes: fs.readFileSync(file) }; }), researchId);
}
export function searchSummary(service: ResearchFoundationsService, researchId: string) {
  const attempts = readSearchAttempts(service, researchId), latest = attempts[0] ?? null;
  const referenced = new Set(attempts.flatMap(attempt => attempt.result ? [attempt.result.snapshotId] : []));
  return { total: attempts.length, legacySnapshots: snapshotIds(service, researchId).filter(snapshotId => !referenced.has(snapshotId)).length, latest, noveltyStatus: latest && latest.status !== 'completed' ? 'search_incomplete' : 'not_verified', boundary: 'Provider retrieval is metadata only. Unlinked historical snapshots have no verified attempt provenance. Failure/running is incomplete; even completed or empty retrieval does not verify novelty.' };
}
function snapshotIds(service: ResearchFoundationsService, researchId: string) {
  const root = rootFor(service, researchId, false, 'searches'); if (!root) return [];
  const names = fs.readdirSync(root); if (names.length > 2048) throw new Error('Search snapshot read limit exceeded');
  return names.map(name => { const stat = fs.lstatSync(path.join(root, name)); if (!/^[a-f0-9]{64}\.json$/.test(name) || !stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Invalid search snapshot file'); return name.slice(0, -5); });
}
function readSnapshotFile(service: ResearchFoundationsService, researchId: string, snapshotId: string) {
  hash(snapshotId); const root = rootFor(service, researchId, false, 'searches'); if (!root) throw new Error('Search snapshot directory missing');
  const file = path.join(root, `${snapshotId}.json`), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('Search snapshot is missing or invalid');
  const bytes = fs.readFileSync(file), snapshot = JSON.parse(bytes.toString('utf8'));
  if (digest(snapshot) !== snapshotId || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.hits) || snapshot.hits.length > 100) throw new Error('Search snapshot identity/schema mismatch');
  choice(snapshot.provider, providers); text(snapshot.query, 'query', 2000); text(snapshot.page, 'page', 2000); date(snapshot.retrievedAt); hash(snapshot.responseHash);
  return { bytes, snapshot };
}
export function searchHistory(service: ResearchFoundationsService, researchId: string, query: URLSearchParams) {
  const attempts = readSearchAttempts(service, researchId), attemptId = query.get('attemptId');
  const snapshotId = query.get('snapshotId');
  if (attemptId && snapshotId) throw new Error('Choose one attempt or historical snapshot');
  if (snapshotId) {
    const { snapshot } = readSnapshotFile(service, researchId, snapshotId), attempt = attempts.find(item => item.result?.snapshotId === snapshotId) ?? null;
    return { attempt, snapshot, historicalWithoutAttempt: attempt === null, noveltyStatus: 'not_verified' };
  }
  if (attemptId) {
    const attempt = attempts.find(item => item.attemptId === id(attemptId)); if (!attempt) throw new Error('Search attempt outside selected research');
    if (!attempt.result) return { attempt, snapshot: null, noveltyStatus: 'search_incomplete' };
    const snapshot = validateSearchSnapshot(attempt, readSnapshotFile(service, researchId, attempt.result.snapshotId).bytes);
    return { attempt, snapshot, noveltyStatus: 'not_verified' };
  }
  const offset = Number(query.get('offset') ?? 0), limit = Number(query.get('limit') ?? 20);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Search history offset >= 0 and limit 1-100 required');
  const referenced = new Set(attempts.flatMap(attempt => attempt.result ? [attempt.result.snapshotId] : [])), legacy = snapshotIds(service, researchId).filter(snapshotId => !referenced.has(snapshotId));
  return { researchId, total: attempts.length, offset, limit, attempts: attempts.slice(offset, offset + limit), legacySnapshotCount: legacy.length, legacySnapshots: legacy.slice(offset, offset + limit), boundary: 'History retains failures and partial pages; historical snapshots without attempts retain unknown provenance. This is not novelty verification.' };
}
export function validateSearchSnapshot(attempt: SearchAttempt, bytes: Buffer) {
  if (!attempt.result || bytes.length > 16 * 1024 * 1024) throw new Error('No bounded successful search snapshot expected');
  const snapshot = JSON.parse(bytes.toString('utf8'));
  if (createHash('sha256').update(bytes).digest('hex') !== attempt.result.sha256 || digest(snapshot) !== attempt.result.snapshotId || snapshot.provider !== attempt.provider || snapshot.query !== attempt.query || snapshot.page !== attempt.page || snapshot.responseHash !== attempt.result.responseHash || !Array.isArray(snapshot.hits) || snapshot.hits.length !== attempt.result.hitCount || snapshot.nextPage !== attempt.result.nextPage) throw new Error('Search snapshot does not match the recorded attempt');
  return snapshot;
}
function save(root: string, name: string, value: unknown) { const sha256 = digest(value), serialized = JSON.stringify({ sha256, value }, null, 2); if (Buffer.byteLength(serialized) > 65536) throw new Error('Search record exceeds 64 KiB; original request retained'); fs.writeFileSync(path.join(root, name), serialized, { flag: 'wx' }); return sha256; }
export function cancelSearch(service: ResearchFoundationsService, researchId: string, attemptId: string, actor: ActorContext) {
  const closedBy = searchActor(actor); if (closedBy.kind !== 'user') throw new Error('Only a user may close a search');
  const attempt = readSearchAttempts(service, researchId).find(item => item.attemptId === id(attemptId));
  if (!attempt) throw new Error('Search attempt outside selected research');
  if (attempt.status !== 'running') return { attempt, replayed: true, remoteProcessStopVerified: false };
  const root = rootFor(service, researchId, true)!, original = envelope(fs.readFileSync(path.join(root, `${attemptId}.started.json`)));
  const finish: SearchFinish = { schemaVersion: 1, attemptId, startedHash: original.sha256, finishedAt: new Date().toISOString(), status: 'search_incomplete', result: null, error: { name: 'UserCancelled', message: '用户关闭此检索记录；未验证远端请求或进程已停止，迟到结果不能覆盖。', stack: null, cause: null }, closedBy };
  save(root, `${attemptId}.finished.json`, finish);
  return { attempt: readSearchAttempts(service, researchId).find(item => item.attemptId === attemptId)!, replayed: false, remoteProcessStopVerified: false };
}
export class LiteratureSearchError extends Error {
  readonly code = 'SEARCH_INCOMPLETE';
  readonly searchAttempt: SearchAttempt;
  constructor(searchAttempt: SearchAttempt) { super(`search_incomplete ${searchAttempt.attemptId}: ${searchAttempt.error?.message}`, { cause: searchAttempt.error }); this.searchAttempt = searchAttempt; }
}
export function searchFailure(error: unknown) { return error instanceof LiteratureSearchError ? { code: error.code, status: 'search_incomplete' as const, noveltyStatus: 'search_incomplete' as const, searchAttempt: error.searchAttempt } : {}; }
export async function runLiteratureSearch(service: ResearchFoundationsService, researchId: string, input: { provider: unknown; query: unknown; page?: unknown }, actor: ActorContext, options: ConstructorParameters<typeof LiteratureConnector>[0]) {
  actor = searchActor(actor);
  if (typeof input.page === 'string' && /[\r\n]/.test(input.page)) throw new Error('Invalid search cursor');
  const provider = choice(input.provider, providers), query = text(input.query, 'query', 2000), page = input.page === undefined ? '*' : text(input.page, 'page', 2000);
  if (/[\r\n]/.test(page) || provider === 'semantic_scholar' && page !== '*' && !/^\d{1,6}$/.test(page)) throw new Error('Invalid search cursor');
  if (readSearchAttempts(service, researchId).length >= 1000) throw new Error('Search history exceeds 1000 attempts');
  if (snapshotIds(service, researchId).length >= 1000) throw new Error('Search snapshot limit exceeded');
  const root = rootFor(service, researchId, true)!, attemptId = `search-${randomUUID()}`;
  const start: SearchStart = { schemaVersion: 1, researchId, attemptId, provider, query, page, startedAt: new Date().toISOString(), actor };
  const startedHash = save(root, `${attemptId}.started.json`, start);
  const secrets = [options?.openalexKey, options?.semanticScholarKey].filter((secret): secret is string => !!secret);
  const clean = (value: string) => secrets.reduce((result, secret) => result.split(secret).join('[REDACTED]').split(encodeURIComponent(secret)).join('[REDACTED]'), value);
  const diagnostic = (error: unknown, depth = 0): SearchError => ({ name: clean(error instanceof Error ? error.name : 'Error').slice(0, 200), message: clean(error instanceof Error ? error.message : String(error)).slice(0, 6000) || 'Unknown provider failure', stack: error instanceof Error && error.stack ? clean(error.stack).slice(0, 12000) : null, cause: error instanceof Error && error.cause !== undefined && depth < 3 ? diagnostic(error.cause, depth + 1) : null });
  let result: ReturnType<typeof saveSearchSnapshot>;
  try { result = saveSearchSnapshot(service, researchId, await new LiteratureConnector(options).search(provider, query, page)); }
  catch (error) {
    const finish: SearchFinish = { schemaVersion: 1, attemptId, startedHash, finishedAt: new Date().toISOString(), status: 'search_incomplete', result: null, error: diagnostic(error) };
    try { save(root, `${attemptId}.finished.json`, finish); } catch (recordError) { const recording = diagnostic(recordError); throw new AggregateError([finish.error, recording], `Search ${attemptId} failed: ${finish.error!.message}; failure recording also failed: ${recording.message}; original request retained`); }
    throw new LiteratureSearchError({ ...start, status: finish.status, finishedAt: finish.finishedAt, result: null, error: finish.error });
  }
  const finish: SearchFinish = { schemaVersion: 1, attemptId, startedHash, finishedAt: new Date().toISOString(), status: 'completed', result: { snapshotId: result.snapshotId, sha256: result.sha256, responseHash: result.responseHash, hitCount: result.hits.length, nextPage: result.nextPage }, error: null };
  save(root, `${attemptId}.finished.json`, finish);
  return { ...result, attemptId, status: 'completed', noveltyStatus: 'not_verified', boundary: 'Metadata retrieval only, including when no hits are returned; novelty has not been verified.' };
}
