import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  KnowledgeError,
  sha256Hex,
  validateArtifactRef,
  validateKnowledgeConfig,
  type ArtifactRef,
  type KnowledgeConfig,
  type KnowledgePageType,
  type KnowledgeSourceConfig,
} from '../contracts/knowledge.ts';
import { canonicalHash, estimateTokenCount, makeArtifactRef, splitParagraphs, tokenizeKeywordQuery } from '../domain/knowledge.ts';

export interface KnowledgeActor {
  sessionId: string;
  taskId: string;
  usageScopes: string[];
}

export interface KnowledgeServiceOptions {
  repoRoot: string;
  libraryRoot: string;
  config: KnowledgeConfig | unknown;
  verifyLocalObservation?: (verifiedResultRef: ArtifactRef, conditionsRef: ArtifactRef) => boolean;
  verifyExecutionDiagnostic?: (diagnosticRef: ArtifactRef, conditionsRef: ArtifactRef) => boolean;
}

interface SourceRecord {
  sourceKey: string;
  paperId: string;
  title: string;
  identifier: string;
  declaredVersion: string;
  sourceGroupId: string;
  sourceUri: string;
  section: string;
  contentClass: KnowledgeSourceConfig['contentClass'];
  accessPolicyRef: string;
  qualityStatus: 'provisional' | 'verified';
  scope: KnowledgeSourceConfig['scope'];
  sourceRef: ArtifactRef;
  rawRef: ArtifactRef;
  chunkRefs: ArtifactRef[];
  contentHash: string;
  importedAt: string;
  latest: boolean;
  revokedAt: string | null;
  supersedesRef: ArtifactRef | null;
}

interface StoredChunk {
  ref: ArtifactRef;
  sourceRef: ArtifactRef;
  paperId: string;
  title: string;
  sourceUri: string;
  section: string;
  paragraphIndex: number;
  rawByteStart: number;
  rawByteEndExclusive: number;
  normalizedStart: number;
  normalizedEnd: number;
  textHash: string;
  text: string;
}

interface SnapshotRecord {
  ref: ArtifactRef;
  taskId: string;
  usageScope: string;
  policyHash: string;
  indexHash: string;
  sourceRefs: ArtifactRef[];
  chunkRefs: ArtifactRef[];
  createdAt: string;
}

interface EvidenceHit {
  chunkRef: ArtifactRef;
  sourceRef: ArtifactRef;
  sourceId: string;
  paperId: string;
  title: string;
  sourceUri: string;
  section: string;
  paragraphIndex: number;
  rawByteStart: number;
  rawByteEndExclusive: number;
  score: number;
  rank: number;
  text: string;
}

interface EvidencePackRecord {
  ref: ArtifactRef;
  snapshotRef: ArtifactRef;
  taskId: string;
  usageScope: string;
  query: string;
  filters: { paperIds?: string[]; sourceGroups?: string[] };
  topK: number;
  maxContextTokens: number;
  hits: EvidenceHit[];
  omitted: Array<{ chunkRef: ArtifactRef; rank: number; reason: 'context_budget' }>;
  unresolved: boolean;
  cost: { modelCalls: 0; inputTokens: number; outputTokens: 0; includedBytes: number; estimatedContextTokens: number };
  createdAt: string;
}

export interface WikiClaim {
  id: string;
  text: string;
  kind: 'source_reported' | 'inferred' | 'local_observation' | 'execution_diagnostic';
  state: 'current' | 'stale' | 'conflicted' | 'unsupported';
  evidenceRefs: ArtifactRef[];
  derivationText?: string;
  conditionsRef?: ArtifactRef;
  verifiedResultRef?: ArtifactRef;
  diagnosticRef?: ArtifactRef;
  conditionKey?: string;
  conflictsWith?: string[];
}

interface WikiRevisionRecord {
  ref: ArtifactRef;
  pageId: string;
  pageType: KnowledgePageType;
  title: string;
  previousRevisionRef: ArtifactRef | null;
  evidencePackRef: ArtifactRef;
  claims: WikiClaim[];
  markdownRef: ArtifactRef;
  dependencyRefs: ArtifactRef[];
  createdAt: string;
  provisional: boolean;
}

interface KnowledgeEvent {
  eventId: string;
  kind: string;
  commandId: string;
  at: string;
  subjectRefs: ArtifactRef[];
}

interface StoredCommand {
  inputHash: string;
  result: unknown;
}

interface KnowledgeState {
  schemaVersion: 1;
  libraryId: string;
  ownerSessionId: string | null;
  sources: SourceRecord[];
  snapshots: SnapshotRecord[];
  packs: EvidencePackRecord[];
  revisions: WikiRevisionRecord[];
  latestPages: Record<string, ArtifactRef>;
  commands: Record<string, StoredCommand>;
  events: KnowledgeEvent[];
}

function emptyState(libraryId: string): KnowledgeState {
  return { schemaVersion: 1, libraryId, ownerSessionId: null, sources: [], snapshots: [], packs: [], revisions: [], latestPages: {}, commands: {}, events: [] };
}

function sortRefs(refs: ArtifactRef[]): ArtifactRef[] {
  return [...refs].sort((a, b) => a.id.localeCompare(b.id, 'en'));
}

function refsEqual(a: ArtifactRef | null | undefined, b: ArtifactRef | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return a.id === b.id && a.sha256 === b.sha256;
}

function assertCommandId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new KnowledgeError('INVALID_INPUT', 'commandId must be a stable non-empty identifier', ['commandId']);
  return value;
}

function assertPageId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(value)) throw new KnowledgeError('INVALID_INPUT', 'pageId must use lowercase letters, digits, and hyphens', ['pageId']);
  return value;
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new KnowledgeError('INVALID_INPUT', `${field} must be an object`, [field]);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) throw new KnowledgeError('INVALID_INPUT', `${field} must be a trimmed non-empty string`, [field]);
  return value;
}

function sourceVersionKey(source: KnowledgeSourceConfig): string {
  return `${source.paperId}/${source.section}`;
}

export class KnowledgeService {
  readonly config: KnowledgeConfig;
  readonly repoRoot: string;
  readonly libraryRoot: string;
  private readonly statePath: string;
  private readonly lockPath: string;
  private readonly lockNonce: string;
  private closed = false;
  private readonly verifyLocalObservation: (verifiedResultRef: ArtifactRef, conditionsRef: ArtifactRef) => boolean;
  private readonly verifyExecutionDiagnostic: (diagnosticRef: ArtifactRef, conditionsRef: ArtifactRef) => boolean;

  constructor(options: KnowledgeServiceOptions) {
    this.config = validateKnowledgeConfig(options.config);
    this.repoRoot = path.resolve(options.repoRoot);
    this.libraryRoot = path.resolve(options.libraryRoot);
    this.statePath = path.join(this.libraryRoot, 'catalog', 'current.json');
    this.lockPath = path.join(this.libraryRoot, '.writer-lock');
    this.verifyLocalObservation = options.verifyLocalObservation ?? (() => false);
    this.verifyExecutionDiagnostic = options.verifyExecutionDiagnostic ?? (() => false);
    fs.mkdirSync(path.join(this.libraryRoot, 'catalog'), { recursive: true });
    fs.mkdirSync(path.join(this.libraryRoot, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(this.libraryRoot, 'derived', 'chunks'), { recursive: true });
    fs.mkdirSync(path.join(this.libraryRoot, 'derived', 'snapshots'), { recursive: true });
    fs.mkdirSync(path.join(this.libraryRoot, 'derived', 'packs'), { recursive: true });
    fs.mkdirSync(path.join(this.libraryRoot, 'derived', 'wiki'), { recursive: true });
    fs.mkdirSync(path.join(this.libraryRoot, 'events'), { recursive: true });
    this.lockNonce = randomUUID();
    try {
      fs.mkdirSync(this.lockPath);
    } catch (error) {
      throw new KnowledgeError('HOST_BUSY', `Knowledge library already has a writer lock at ${this.lockPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      fs.writeFileSync(path.join(this.lockPath, 'owner.json'), JSON.stringify({ pid: process.pid, nonce: this.lockNonce, startedAt: new Date().toISOString() }), { flag: 'wx' });
    } catch (error) {
      fs.rmdirSync(this.lockPath);
      throw error;
    }
    if (fs.existsSync(this.statePath)) {
      const state = this.readState();
      if (state.libraryId !== this.config.libraryId) {
        this.dispose();
        throw new KnowledgeError('SOURCE_MISMATCH', `Library state id ${state.libraryId} does not match config ${this.config.libraryId}`);
      }
    } else {
      this.writeState(emptyState(this.config.libraryId));
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const ownerPath = path.join(this.lockPath, 'owner.json');
    try {
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as { nonce?: string };
      if (owner.nonce === this.lockNonce) {
        fs.unlinkSync(ownerPath);
        fs.rmdirSync(this.lockPath);
      }
    } catch (error) {
      if (fs.existsSync(this.lockPath)) throw new KnowledgeError('LOCK_RELEASE_FAILED', `Could not release knowledge writer lock: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  importConfiguredSources(commandIdRaw: unknown, actor: KnowledgeActor): { sourceRefs: ArtifactRef[]; imported: number; idempotent: number } {
    const commandId = assertCommandId(commandIdRaw);
    this.assertActor(actor);
    return this.mutate(actor, commandId, 'import_sources', { libraryId: this.config.libraryId, sources: this.config.sources.map((source) => [source.paperId, source.section, source.sha256]) }, (state) => {
      const sourceRefs: ArtifactRef[] = [];
      let imported = 0;
      let idempotent = 0;
      for (const configured of this.config.sources) {
        this.assertSourceScope(configured, actor);
        const raw = this.readConfiguredSource(configured);
        const contentHash = sha256Hex(raw);
        if (contentHash !== configured.sha256) throw new KnowledgeError('SOURCE_MISMATCH', `${configured.hostRegisteredFileRef} hash mismatch: configured ${configured.sha256}, actual ${contentHash}`, [configured.hostRegisteredFileRef]);
        const sourceKey = sourceVersionKey(configured);
        const sameBytes = state.sources.find((source) => source.sourceKey === sourceKey && source.contentHash === contentHash);
        if (sameBytes) {
          sourceRefs.push(sameBytes.sourceRef);
          idempotent += 1;
          continue;
        }
        const priorVersions = state.sources.filter((source) => source.sourceKey === sourceKey);
        const priorSameVersion = priorVersions.find((source) => source.declaredVersion === configured.declaredVersion);
        if (priorSameVersion) throw new KnowledgeError('SOURCE_MISMATCH', `${sourceKey} content changed without a new declaredVersion`, [configured.hostRegisteredFileRef]);
        const supersedes = priorVersions.at(-1) ?? null;
        const versionNo = priorVersions.length + 1;
        const rawRef = makeArtifactRef(`raw/${contentHash}.txt`, raw);
        this.writeImmutable(rawRef, raw);
        const chunks = splitParagraphs(raw, this.config.policy.maxChunkBytes, configured.hostRegisteredFileRef);
        if (chunks.length === 0) throw new KnowledgeError('INVALID_INPUT', `${configured.hostRegisteredFileRef} contains no non-empty paragraphs`);
        const sourceRecordBase = {
          paperId: configured.paperId,
          title: configured.title,
          identifier: configured.identifier,
          declaredVersion: configured.declaredVersion,
          sourceGroupId: configured.sourceGroupId,
          sourceUri: configured.sourceUri,
          section: configured.section,
          contentClass: configured.contentClass,
          qualityStatus: configured.qualityStatus,
          accessPolicyRef: configured.accessPolicyRef,
          contentHash,
          scope: configured.scope,
          rawRef,
          importedAt: new Date().toISOString(),
          supersedesRef: supersedes?.sourceRef ?? null,
        };
        const sourceId = `catalog/sources/${encodeURIComponent(configured.paperId)}/${encodeURIComponent(configured.section)}/v${versionNo}.json`;
        const sourceBytes = Buffer.from(JSON.stringify(sourceRecordBase), 'utf8');
        const sourceRef = makeArtifactRef(sourceId, sourceBytes);
        this.writeImmutable(sourceRef, sourceBytes);
        const chunkRefs: ArtifactRef[] = [];
        for (const chunk of chunks) {
          const body = {
            sourceRef,
            paperId: configured.paperId,
            title: configured.title,
            sourceUri: configured.sourceUri,
            section: configured.section,
            paragraphIndex: chunk.paragraphIndex,
            rawByteStart: chunk.rawByteStart,
            rawByteEndExclusive: chunk.rawByteEndExclusive,
            normalizedStart: chunk.normalizedStart,
            normalizedEnd: chunk.normalizedEnd,
            textHash: chunk.textHash,
            text: chunk.text,
          };
          const chunkId = `derived/chunks/${canonicalHash([sourceRef.id, chunk.rawByteStart, chunk.rawByteEndExclusive, chunk.textHash])}.json`;
          const bytes = Buffer.from(JSON.stringify(body), 'utf8');
          const chunkRef = makeArtifactRef(chunkId, bytes);
          this.writeImmutable(chunkRef, bytes);
          chunkRefs.push(chunkRef);
        }
        const sourceRecord: SourceRecord = {
          ...sourceRecordBase,
          sourceKey,
          sourceRef,
          chunkRefs,
          latest: true,
          revokedAt: null,
          supersedesRef: supersedes?.sourceRef ?? null,
        };
        if (supersedes) supersedes.latest = false;
        state.sources.push(sourceRecord);
        sourceRefs.push(sourceRef);
        imported += 1;
      }
      return { result: { sourceRefs, imported, idempotent }, subjectRefs: sourceRefs };
    });
  }

  buildSnapshot(commandIdRaw: unknown, actor: KnowledgeActor, usageScopeRaw: unknown): SnapshotRecord {
    const commandId = assertCommandId(commandIdRaw);
    this.assertActor(actor);
    const usageScope = requiredString(usageScopeRaw, 'usageScope');
    if (!this.config.policy.usageScopes.includes(usageScope) || !actor.usageScopes.includes(usageScope)) throw new KnowledgeError('POLICY_DENIED', `Usage scope ${usageScope} is not granted`);
    return this.mutate(actor, commandId, 'build_snapshot', { taskId: actor.taskId, usageScope, indexVersion: this.config.policy.indexVersion }, (state) => {
      const sources = state.sources.filter((source) => source.latest && !source.revokedAt && source.scope.allowedTaskIds.includes(actor.taskId) && source.scope.usageScopes.includes(usageScope));
      if (sources.length === 0) throw new KnowledgeError('DEPENDENCY_NOT_READY', 'No imported sources are visible to this task and usage scope');
      const sourceRefs = sortRefs(sources.map((source) => source.sourceRef));
      const chunkRefs = sortRefs(sources.flatMap((source) => source.chunkRefs));
      const policyHash = canonicalHash(this.config.policy);
      const indexRows = chunkRefs.map((ref) => {
        const chunk = this.readJsonArtifact<StoredChunk>(ref);
        return { chunkRef: ref, tokenSetHash: canonicalHash(tokenizeKeywordQuery(chunk.text)) };
      });
      const indexHash = canonicalHash({ version: this.config.policy.indexVersion, tokenizer: this.config.policy.tokenizer, rows: indexRows });
      const snapshotBody = { schemaVersion: 1, taskId: actor.taskId, usageScope, sourceRefs, chunkRefs, policyHash, indexHash };
      const snapshotBytes = Buffer.from(JSON.stringify(snapshotBody), 'utf8');
      const ref = makeArtifactRef(`derived/snapshots/${canonicalHash(snapshotBody)}.json`, snapshotBytes);
      this.writeImmutable(ref, snapshotBytes);
      const prior = state.snapshots.find((record) => refsEqual(record.ref, ref));
      const snapshot: SnapshotRecord = prior ?? { ref, taskId: actor.taskId, usageScope, policyHash, indexHash, sourceRefs, chunkRefs, createdAt: new Date().toISOString() };
      if (!prior) state.snapshots.push(snapshot);
      return { result: snapshot, subjectRefs: [ref, ...sourceRefs] };
    });
  }

  retrieveEvidence(commandIdRaw: unknown, actor: KnowledgeActor, inputRaw: unknown): EvidencePackRecord {
    const commandId = assertCommandId(commandIdRaw);
    this.assertActor(actor);
    const input = asObject(inputRaw, 'query');
    for (const key of Object.keys(input)) if (!['query', 'snapshotRef', 'usageScope', 'topK', 'maxContextTokens', 'filters'].includes(key)) throw new KnowledgeError('INVALID_INPUT', `query contains unknown field ${key}`, [`query.${key}`]);
    const query = requiredString(input.query, 'query.query');
    const snapshotRef = validateArtifactRef(input.snapshotRef, 'query.snapshotRef');
    const usageScope = requiredString(input.usageScope, 'query.usageScope');
    const filters = input.filters === undefined ? {} : asObject(input.filters, 'query.filters');
    for (const key of Object.keys(filters)) if (!['paperIds', 'sourceGroups'].includes(key)) throw new KnowledgeError('INVALID_INPUT', `query.filters contains unknown field ${key}`, [`query.filters.${key}`]);
    const paperIds = filters.paperIds === undefined ? undefined : this.validateFilterStrings(filters.paperIds, 'query.filters.paperIds');
    const sourceGroups = filters.sourceGroups === undefined ? undefined : this.validateFilterStrings(filters.sourceGroups, 'query.filters.sourceGroups');
    if (!Number.isSafeInteger(input.topK) || (input.topK as number) < 1 || (input.topK as number) > this.config.policy.topK) throw new KnowledgeError('INVALID_INPUT', `query.topK must be between 1 and ${this.config.policy.topK}`);
    if (!Number.isSafeInteger(input.maxContextTokens) || (input.maxContextTokens as number) < 1 || (input.maxContextTokens as number) > this.config.policy.maxContextTokens) throw new KnowledgeError('INVALID_INPUT', `query.maxContextTokens must be between 1 and ${this.config.policy.maxContextTokens}`);
    if (!this.config.policy.usageScopes.includes(usageScope) || !actor.usageScopes.includes(usageScope)) throw new KnowledgeError('POLICY_DENIED', `Usage scope ${usageScope} is not granted`);
    return this.mutate(actor, commandId, 'retrieve_evidence', { query, snapshotRef, usageScope, topK: input.topK, maxContextTokens: input.maxContextTokens, filters: { paperIds, sourceGroups }, taskId: actor.taskId }, (state) => {
      const snapshot = state.snapshots.find((entry) => refsEqual(entry.ref, snapshotRef));
      if (!snapshot || snapshot.taskId !== actor.taskId || snapshot.usageScope !== usageScope) throw new KnowledgeError('POLICY_DENIED', 'Snapshot is not available to this task and usage scope');
      const sourcesById = new Map(state.sources.map((source) => [source.sourceRef.id, source]));
      const candidateSources = snapshot.sourceRefs.map((ref) => sourcesById.get(ref.id));
      if (candidateSources.some((source) => source === undefined || source.revokedAt !== null || !source.scope.allowedTaskIds.includes(actor.taskId) || !source.scope.usageScopes.includes(usageScope))) {
        throw new KnowledgeError('POLICY_DENIED', 'Snapshot contains a source that is no longer visible');
      }
      const allowedSnapshotSources = candidateSources.filter((source) => source !== undefined);
      if (paperIds?.some((paperId) => !allowedSnapshotSources.some((source) => source.paperId === paperId)) || sourceGroups?.some((sourceGroup) => !allowedSnapshotSources.some((source) => source.sourceGroupId === sourceGroup))) {
        throw new KnowledgeError('POLICY_DENIED', 'A retrieval filter names a source outside the selected snapshot');
      }
      const filteredSourceRefs = new Set(allowedSnapshotSources
        .filter((source) => (!paperIds || paperIds.includes(source.paperId)) && (!sourceGroups || sourceGroups.includes(source.sourceGroupId)))
        .map((source) => source.sourceRef.id));
      const queryTokens = tokenizeKeywordQuery(query);
      const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
      const rows: Array<{ chunk: StoredChunk; score: number }> = [];
      for (const ref of snapshot.chunkRefs) {
        const chunk = { ...this.readJsonArtifact<Omit<StoredChunk, 'ref'>>(ref), ref } as StoredChunk;
        if (!filteredSourceRefs.has(chunk.sourceRef.id)) continue;
        const source = sourcesById.get(chunk.sourceRef.id);
        if (!source || source.revokedAt !== null || !source.scope.visibleSections.includes(chunk.section)) throw new KnowledgeError('POLICY_DENIED', `Chunk ${ref.id} is not currently visible`);
        const chunkTokens = new Set(tokenizeKeywordQuery(chunk.text));
        const matched = queryTokens.reduce((count, token) => count + (chunkTokens.has(token) ? 1 : 0), 0);
        const normalizedText = chunk.text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
        const phraseBonus = normalizedQuery.length > 0 && normalizedText.includes(normalizedQuery) ? 3 : 0;
        const score = matched + phraseBonus;
        if (score > 0) rows.push({ chunk, score });
      }
      rows.sort((a, b) => b.score - a.score || a.chunk.sourceRef.id.localeCompare(b.chunk.sourceRef.id, 'en') || a.chunk.paragraphIndex - b.chunk.paragraphIndex || a.chunk.ref.id.localeCompare(b.chunk.ref.id, 'en'));
      const top = rows.slice(0, input.topK as number);
      const hits: EvidenceHit[] = [];
      const omitted: EvidencePackRecord['omitted'] = [];
      let usedTokens = 0;
      let includedBytes = 0;
      for (let position = 0; position < top.length; position += 1) {
        const row = top[position];
        const rank = position + 1;
        const tokens = estimateTokenCount(row.chunk.text);
        if (usedTokens + tokens > (input.maxContextTokens as number)) {
          omitted.push({ chunkRef: row.chunk.ref, rank, reason: 'context_budget' });
          continue;
        }
        const source = sourcesById.get(row.chunk.sourceRef.id);
        if (!source) throw new KnowledgeError('SOURCE_MISMATCH', `Missing source descriptor ${row.chunk.sourceRef.id}`);
        hits.push({
          chunkRef: row.chunk.ref,
          sourceRef: row.chunk.sourceRef,
          sourceId: `${source.paperId}/${source.section}`,
          paperId: source.paperId,
          title: source.title,
          sourceUri: source.sourceUri,
          section: source.section,
          paragraphIndex: row.chunk.paragraphIndex,
          rawByteStart: row.chunk.rawByteStart,
          rawByteEndExclusive: row.chunk.rawByteEndExclusive,
          score: row.score,
          rank,
          text: row.chunk.text,
        });
        usedTokens += tokens;
        includedBytes += Buffer.byteLength(row.chunk.text, 'utf8');
      }
      const packFilters = { ...(paperIds ? { paperIds } : {}), ...(sourceGroups ? { sourceGroups } : {}) };
      const recordBody = { schemaVersion: 1, snapshotRef, taskId: actor.taskId, usageScope, query, filters: packFilters, topK: input.topK as number, maxContextTokens: input.maxContextTokens as number, hits, omitted, unresolved: rows.length === 0, cost: { modelCalls: 0 as const, inputTokens: estimateTokenCount(query), outputTokens: 0 as const, includedBytes, estimatedContextTokens: usedTokens } };
      const bytes = Buffer.from(JSON.stringify(recordBody), 'utf8');
      const packRef = makeArtifactRef(`derived/packs/${canonicalHash(recordBody)}.json`, bytes);
      this.writeImmutable(packRef, bytes);
      const record: EvidencePackRecord = { ref: packRef, snapshotRef, taskId: actor.taskId, usageScope, query, filters: packFilters, topK: input.topK as number, maxContextTokens: input.maxContextTokens as number, hits, omitted, unresolved: rows.length === 0, cost: recordBody.cost, createdAt: new Date().toISOString() };
      const prior = state.packs.find((pack) => refsEqual(pack.ref, packRef));
      if (!prior) state.packs.push(record);
      return { result: prior ?? record, subjectRefs: [packRef, snapshotRef, ...hits.map((hit) => hit.chunkRef)] };
    });
  }

  updateWiki(commandIdRaw: unknown, actor: KnowledgeActor, inputRaw: unknown): WikiRevisionRecord {
    const commandId = assertCommandId(commandIdRaw);
    this.assertActor(actor);
    const input = asObject(inputRaw, 'update');
    for (const key of Object.keys(input)) if (!['pageId', 'pageType', 'title', 'baseRevisionRef', 'evidencePackRef', 'claims'].includes(key)) throw new KnowledgeError('INVALID_INPUT', `update contains unknown field ${key}`, [`update.${key}`]);
    const pageId = assertPageId(input.pageId);
    if (!['method', 'mechanism', 'compatibility', 'experiment'].includes(String(input.pageType))) throw new KnowledgeError('INVALID_INPUT', 'pageType is unsupported', ['pageType']);
    const pageType = input.pageType as KnowledgePageType;
    const title = requiredString(input.title, 'update.title');
    const baseRevisionRef = input.baseRevisionRef === null ? null : validateArtifactRef(input.baseRevisionRef, 'update.baseRevisionRef');
    const evidencePackRef = validateArtifactRef(input.evidencePackRef, 'update.evidencePackRef');
    if (!Array.isArray(input.claims) || input.claims.length < 1 || input.claims.length > 30) throw new KnowledgeError('INVALID_INPUT', 'update.claims must contain 1–30 claims', ['update.claims']);
    const claimInputs = input.claims.map((claim, i) => {
      const obj = asObject(claim, `update.claims[${i}]`);
      const allowed = ['id', 'text', 'kind', 'evidenceRefs', 'derivationText', 'conditionsRef', 'verifiedResultRef', 'diagnosticRef', 'conditionKey', 'conflictsWith'];
      for (const key of Object.keys(obj)) if (!allowed.includes(key)) throw new KnowledgeError('INVALID_INPUT', `claim contains unknown field ${key}`, [`update.claims[${i}].${key}`]);
      if (!['source_reported', 'inferred', 'local_observation', 'execution_diagnostic'].includes(String(obj.kind))) throw new KnowledgeError('INVALID_INPUT', 'claim kind is unsupported', [`update.claims[${i}].kind`]);
      if (!Array.isArray(obj.evidenceRefs)) throw new KnowledgeError('INVALID_INPUT', 'claim.evidenceRefs must be an array', [`update.claims[${i}].evidenceRefs`]);
      return {
        id: requiredString(obj.id, `update.claims[${i}].id`),
        text: requiredString(obj.text, `update.claims[${i}].text`),
        kind: obj.kind as WikiClaim['kind'],
        evidenceRefs: obj.evidenceRefs.map((ref, j) => validateArtifactRef(ref, `update.claims[${i}].evidenceRefs[${j}]`)),
        ...(obj.derivationText !== undefined ? { derivationText: requiredString(obj.derivationText, `update.claims[${i}].derivationText`) } : {}),
        ...(obj.conditionsRef !== undefined ? { conditionsRef: validateArtifactRef(obj.conditionsRef, `update.claims[${i}].conditionsRef`) } : {}),
        ...(obj.verifiedResultRef !== undefined ? { verifiedResultRef: validateArtifactRef(obj.verifiedResultRef, `update.claims[${i}].verifiedResultRef`) } : {}),
        ...(obj.diagnosticRef !== undefined ? { diagnosticRef: validateArtifactRef(obj.diagnosticRef, `update.claims[${i}].diagnosticRef`) } : {}),
        ...(obj.conditionKey !== undefined ? { conditionKey: requiredString(obj.conditionKey, `update.claims[${i}].conditionKey`) } : {}),
        ...(obj.conflictsWith !== undefined
          ? { conflictsWith: Array.isArray(obj.conflictsWith) ? obj.conflictsWith.map((id, j) => requiredString(id, `update.claims[${i}].conflictsWith[${j}]`)) : (() => { throw new KnowledgeError('INVALID_INPUT', 'conflictsWith must be an array'); })() }
          : {}),
      };
    });
    return this.mutate(actor, commandId, 'update_wiki', { pageId, pageType, title, baseRevisionRef, evidencePackRef, claims: claimInputs }, (state) => {
      const pack = state.packs.find((record) => refsEqual(record.ref, evidencePackRef));
      if (!pack || pack.taskId !== actor.taskId) throw new KnowledgeError('POLICY_DENIED', 'EvidencePack is not available to this task');
      const latestRef = state.latestPages[pageId] ?? null;
      if (!refsEqual(latestRef, baseRevisionRef)) throw new KnowledgeError('CAS_CONFLICT', `Wiki page ${pageId} changed since the supplied base revision`, ['baseRevisionRef']);
      const packChunkRefs = new Map(pack.hits.map((hit) => [hit.chunkRef.id, hit.chunkRef]));
      const claims: WikiClaim[] = claimInputs.map((claim) => {
        if (claim.kind === 'local_observation') {
          if (!claim.conditionsRef || !claim.verifiedResultRef || !this.verifyLocalObservation(claim.verifiedResultRef, claim.conditionsRef)) {
            throw new KnowledgeError('POLICY_DENIED', 'local_observation requires a Host-verified trial and conditions ref', [`claims.${claim.id}`]);
          }
          if (claim.evidenceRefs.length > 0) throw new KnowledgeError('INVALID_INPUT', 'local_observation cannot mix paper chunks into its result evidence', [`claims.${claim.id}.evidenceRefs`]);
        } else if (claim.kind === 'execution_diagnostic') {
          if (!claim.conditionsRef || !claim.diagnosticRef || claim.verifiedResultRef || claim.evidenceRefs.length ||
              !this.verifyExecutionDiagnostic(claim.diagnosticRef, claim.conditionsRef)) throw new KnowledgeError('POLICY_DENIED', 'Execution diagnosis requires trusted diagnostic evidence and cannot mix paper or verified result claims');
        } else {
          if (claim.evidenceRefs.length === 0) throw new KnowledgeError('INVALID_INPUT', `${claim.kind} claim requires evidence refs`, [`claims.${claim.id}.evidenceRefs`]);
          for (const ref of claim.evidenceRefs) if (!refsEqual(packChunkRefs.get(ref.id), ref)) throw new KnowledgeError('POLICY_DENIED', `Claim ${claim.id} cites a chunk outside its EvidencePack`);
        }
        if (claim.kind === 'inferred' && !claim.derivationText) throw new KnowledgeError('INVALID_INPUT', `Inferred claim ${claim.id} requires derivationText`);
        return { ...claim, state: claim.evidenceRefs.length === 0 && !['local_observation', 'execution_diagnostic'].includes(claim.kind) ? 'unsupported' : 'current' };
      });
      this.markContradictions(claims);
      const previous = latestRef;
      const markdown = this.renderWiki(pageId, title, claims, pack);
      const markdownBytes = Buffer.from(markdown, 'utf8');
      const markdownRef = makeArtifactRef(`derived/wiki/${pageId}/markdown-${canonicalHash(markdown)}.md`, markdownBytes);
      this.writeImmutable(markdownRef, markdownBytes);
      const extraDependencies = claims.flatMap((claim) => [claim.conditionsRef, claim.verifiedResultRef, claim.diagnosticRef]).filter((ref): ref is ArtifactRef => ref !== undefined);
      const body = { schemaVersion: 1, pageId, pageType, title, previousRevisionRef: previous, evidencePackRef, claims, dependencyRefs: sortRefs([...new Map([...claims.flatMap((claim) => claim.evidenceRefs), ...extraDependencies].map((ref) => [ref.id, ref])).values()]), markdownRef };
      const revisionBytes = Buffer.from(JSON.stringify(body), 'utf8');
      const revisionRef = makeArtifactRef(`derived/wiki/${pageId}/revision-${canonicalHash(body)}.json`, revisionBytes);
      this.writeImmutable(revisionRef, revisionBytes);
      const revision: WikiRevisionRecord = { ...body, ref: revisionRef, claims, createdAt: new Date().toISOString(), provisional: true };
      state.revisions.push(revision);
      state.latestPages[pageId] = revisionRef;
      return { result: revision, subjectRefs: [revisionRef, markdownRef, evidencePackRef, ...revision.dependencyRefs] };
    });
  }

  invalidateKnowledge(commandIdRaw: unknown, actor: KnowledgeActor, inputRaw: unknown): { affectedPages: string[]; sourceRefs: ArtifactRef[]; revoked: boolean } {
    const commandId = assertCommandId(commandIdRaw);
    this.assertActor(actor);
    const input = asObject(inputRaw, 'invalidation');
    for (const key of Object.keys(input)) if (!['changedSourceRefs', 'reason', 'revoke'].includes(key)) throw new KnowledgeError('INVALID_INPUT', `invalidation contains unknown field ${key}`);
    if (!Array.isArray(input.changedSourceRefs) || input.changedSourceRefs.length < 1) throw new KnowledgeError('INVALID_INPUT', 'changedSourceRefs must be a non-empty array');
    const refs = input.changedSourceRefs.map((ref, i) => validateArtifactRef(ref, `changedSourceRefs[${i}]`));
    const reason = requiredString(input.reason, 'reason');
    const revoke = input.revoke === true;
    if (input.revoke !== undefined && typeof input.revoke !== 'boolean') throw new KnowledgeError('INVALID_INPUT', 'revoke must be boolean');
    return this.mutate(actor, commandId, 'invalidate_knowledge', { refs, reason, revoke, taskId: actor.taskId }, (state) => {
      const sources = refs.map((ref) => {
        const source = state.sources.find((item) => refsEqual(item.sourceRef, ref));
        if (!source || !source.scope.allowedTaskIds.includes(actor.taskId)) throw new KnowledgeError('POLICY_DENIED', `Source ${ref.id} is unavailable`);
        return source;
      });
      const affectedPages = state.revisions.filter((revision) => revision.claims.some((claim) => claim.evidenceRefs.some((ref) => sources.some((source) => source.chunkRefs.some((chunk) => refsEqual(chunk, ref)))))).map((revision) => revision.pageId).filter((id, i, all) => all.indexOf(id) === i).sort();
      if (revoke) {
        for (const source of sources) source.revokedAt = new Date().toISOString();
      } else {
        const keys = new Set(sources.map((source) => source.sourceKey));
        for (const source of state.sources) if (keys.has(source.sourceKey)) source.latest = false;
      }
      return { result: { affectedPages, sourceRefs: refs, revoked: revoke }, subjectRefs: refs };
    });
  }

  getPaper(paperIdRaw: unknown, snapshotRefRaw: unknown, actor: KnowledgeActor): { paperId: string; snapshotRef: ArtifactRef; sources: SourceRecord[] } {
    this.assertActor(actor);
    const paperId = requiredString(paperIdRaw, 'paperId');
    const snapshotRef = validateArtifactRef(snapshotRefRaw, 'snapshotRef');
    const state = this.readState();
    this.assertOwner(state, actor, false);
    const snapshot = state.snapshots.find((entry) => refsEqual(entry.ref, snapshotRef) && entry.taskId === actor.taskId && actor.usageScopes.includes(entry.usageScope));
    if (!snapshot) throw new KnowledgeError('POLICY_DENIED', 'Snapshot is not available to this task');
    const visible = new Set(snapshot.sourceRefs.map((ref) => ref.id));
    const sources = state.sources.filter((source) => source.paperId === paperId && visible.has(source.sourceRef.id) && !source.revokedAt && source.scope.allowedTaskIds.includes(actor.taskId) && source.scope.usageScopes.some((scope) => actor.usageScopes.includes(scope))).map((source) => ({ ...source }));
    if (sources.length === 0) throw new KnowledgeError('POLICY_DENIED', `Paper ${paperId} is not available`);
    return { paperId, snapshotRef, sources };
  }

  /** Asset bridge: policy metadata is checked before reading any referenced bytes. */
  describeResearchDependency(refRaw: unknown, actor: KnowledgeActor): {
    kind: 'source' | 'chunk' | 'wiki' | 'knowledge_snapshot'; scope: { taskIds: string[]; usageScopes: string[] }; status: 'current' | 'stale';
  } | null {
    this.assertActor(actor);
    const ref = validateArtifactRef(refRaw, 'dependencyRef'), state = this.readState();
    this.assertOwner(state, actor, false);
    const visible = (source: SourceRecord) => !source.revokedAt && source.scope.allowedTaskIds.includes(actor.taskId) &&
      source.scope.usageScopes.some((scope) => actor.usageScopes.includes(scope)) && !this.config.policy.forbiddenContentClasses.includes(source.contentClass);
    const snapshot = state.snapshots.find((entry) => refsEqual(entry.ref, ref));
    if (snapshot) {
      if (snapshot.taskId !== actor.taskId || !actor.usageScopes.includes(snapshot.usageScope)) return null;
      const parents = snapshot.sourceRefs.map((sourceRef) => state.sources.find((source) => refsEqual(source.sourceRef, sourceRef)));
      if (parents.some((source) => !source || !visible(source) || !source.scope.usageScopes.includes(snapshot.usageScope))) return null;
      return { kind: 'knowledge_snapshot', scope: { taskIds: [snapshot.taskId], usageScopes: [snapshot.usageScope] }, status: parents.some((source) => !source!.latest) ? 'stale' : 'current' };
    }
    const source = state.sources.find((entry) => refsEqual(entry.sourceRef, ref) || refsEqual(entry.rawRef, ref) || entry.chunkRefs.some((chunk) => refsEqual(chunk, ref)));
    if (source) {
      if (!visible(source)) return null;
      return { kind: source.chunkRefs.some((chunk) => refsEqual(chunk, ref)) ? 'chunk' : 'source',
        scope: { taskIds: [...source.scope.allowedTaskIds], usageScopes: [...source.scope.usageScopes] }, status: source.latest ? 'current' : 'stale' };
    }
    const revision = state.revisions.find((entry) => refsEqual(entry.ref, ref) || refsEqual(entry.markdownRef, ref));
    if (!revision) return null;
    const pack = state.packs.find((entry) => refsEqual(entry.ref, revision.evidencePackRef));
    if (!pack || pack.taskId !== actor.taskId || !actor.usageScopes.includes(pack.usageScope)) return null;
    let taskIds = [pack.taskId], usageScopes = [pack.usageScope], stale = false;
    const dependencies = state.sources.filter((entry) => revision.dependencyRefs.some((dependency) =>
      refsEqual(entry.sourceRef, dependency) || refsEqual(entry.rawRef, dependency) || entry.chunkRefs.some((chunk) => refsEqual(chunk, dependency))));
    for (const dependency of dependencies) {
      if (!visible(dependency)) return null;
      taskIds = taskIds.filter((task) => dependency.scope.allowedTaskIds.includes(task));
      usageScopes = usageScopes.filter((scope) => dependency.scope.usageScopes.includes(scope));
      if (!dependency.latest) stale = true;
    }
    for (const claim of revision.claims) {
      if (claim.kind === 'local_observation' && (!claim.conditionsRef || !claim.verifiedResultRef ||
          !this.verifyLocalObservation?.(claim.verifiedResultRef, claim.conditionsRef))) return null;
      if (claim.kind === 'execution_diagnostic' && (!claim.conditionsRef || !claim.diagnosticRef ||
          !this.verifyExecutionDiagnostic(claim.diagnosticRef, claim.conditionsRef))) return null;
      if (claim.state !== 'current') stale = true;
    }
    if (!taskIds.length || !usageScopes.length) return null;
    return { kind: 'wiki', scope: { taskIds, usageScopes }, status: stale ? 'stale' : 'current' };
  }

  readResearchDependency(refRaw: unknown, actor: KnowledgeActor): Buffer {
    const ref = validateArtifactRef(refRaw, 'dependencyRef');
    if (!this.describeResearchDependency(ref, actor)) throw new KnowledgeError('POLICY_DENIED', 'Research dependency is outside current source policy');
    return this.readArtifactBytes(ref);
  }

  getWikiUpdateResult(commandIdRaw: unknown, actor: KnowledgeActor): WikiRevisionRecord | null {
    this.assertActor(actor);
    const commandId = assertCommandId(commandIdRaw), state = this.readState();
    this.assertOwner(state, actor, false);
    if (!state.events.some((event) => event.commandId === commandId && event.kind === 'update_wiki')) return null;
    const result = state.commands[commandId]?.result as WikiRevisionRecord | undefined;
    const pack = result && state.packs.find((entry) => refsEqual(entry.ref, result.evidencePackRef));
    if (!result || !pack || pack.taskId !== actor.taskId || !actor.usageScopes.includes(pack.usageScope)) throw new KnowledgeError('POLICY_DENIED', 'Wiki command result is outside caller scope');
    this.assertWikiDependenciesReadable(state, result);
    return result;
  }

  getWiki(pageIdRaw: unknown, snapshotRefRaw: unknown, actor: KnowledgeActor): { revision: WikiRevisionRecord; markdown: string; staleClaimIds: string[] } {
    this.assertActor(actor);
    const pageId = assertPageId(pageIdRaw);
    const snapshotRef = validateArtifactRef(snapshotRefRaw, 'snapshotRef');
    const state = this.readState();
    this.assertOwner(state, actor, false);
    const latestRef = state.latestPages[pageId];
    const revision = state.revisions.find((entry) => refsEqual(entry.ref, latestRef));
    if (!revision) throw new KnowledgeError('DEPENDENCY_NOT_READY', `Wiki page ${pageId} does not exist`);
    const pack = state.packs.find((entry) => refsEqual(entry.ref, revision.evidencePackRef));
    if (!pack || pack.taskId !== actor.taskId || !actor.usageScopes.includes(pack.usageScope) || !refsEqual(pack.snapshotRef, snapshotRef)) throw new KnowledgeError('POLICY_DENIED', 'Wiki page is not available to this task, snapshot and scope');
    this.assertWikiDependenciesReadable(state, revision);
    const markdown = this.readArtifactText(revision.markdownRef);
    const staleSourceIds = new Set(state.sources.filter((source) => !source.latest || source.revokedAt).map((source) => source.sourceRef.id));
    const staleClaimIds = revision.claims.filter((claim) => claim.evidenceRefs.some((ref) => {
      const chunk = this.readJsonArtifact<StoredChunk>(this.findChunkRef(state, ref));
      return staleSourceIds.has(chunk.sourceRef.id);
    })).map((claim) => claim.id);
    return { revision, markdown, staleClaimIds };
  }

  getLintReport(snapshotRefRaw: unknown, actor: KnowledgeActor): { pages: Array<{ pageId: string; revisionRef: ArtifactRef; staleClaims: string[]; unsupportedClaims: string[]; conflictedClaims: string[] }>; brokenRefs: string[] } {
    this.assertActor(actor);
    const snapshotRef = validateArtifactRef(snapshotRefRaw, 'snapshotRef');
    const state = this.readState();
    this.assertOwner(state, actor, false);
    const snapshot = state.snapshots.find((entry) => refsEqual(entry.ref, snapshotRef) && entry.taskId === actor.taskId && actor.usageScopes.includes(entry.usageScope));
    if (!snapshot) throw new KnowledgeError('POLICY_DENIED', 'Snapshot is not available to this task');
    const pages: Array<{ pageId: string; revisionRef: ArtifactRef; staleClaims: string[]; unsupportedClaims: string[]; conflictedClaims: string[] }> = [];
    const brokenRefs: string[] = [];
    for (const [pageId, ref] of Object.entries(state.latestPages).sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const revision = state.revisions.find((entry) => refsEqual(entry.ref, ref) && state.packs.some((pack) => refsEqual(pack.ref, entry.evidencePackRef) && refsEqual(pack.snapshotRef, snapshot.ref)));
      if (!revision) { brokenRefs.push(ref.id); continue; }
      try {
        this.assertWikiDependenciesReadable(state, revision);
      } catch {
        brokenRefs.push(revision.ref.id);
      }
      const staleClaimIds = revision.claims.filter((claim) => claim.evidenceRefs.some((evidenceRef) => {
        const chunkRef = this.findChunkRef(state, evidenceRef);
        const chunk = this.readJsonArtifact<StoredChunk>(chunkRef);
        return state.sources.some((source) => source.sourceRef.id === chunk.sourceRef.id && (!source.latest || source.revokedAt !== null));
      })).map((claim) => claim.id);
      pages.push({ pageId, revisionRef: ref, staleClaims: staleClaimIds, unsupportedClaims: revision.claims.filter((claim) => claim.state === 'unsupported').map((claim) => claim.id), conflictedClaims: revision.claims.filter((claim) => claim.state === 'conflicted').map((claim) => claim.id) });
    }
    return { pages, brokenRefs };
  }

  private assertActor(actor: KnowledgeActor): void {
    if (!actor || typeof actor.sessionId !== 'string' || actor.sessionId.trim() === '') throw new KnowledgeError('OWNER_MISMATCH', 'A non-empty caller session is required');
    if (!this.config.policy.allowedTaskIds.includes(actor.taskId)) throw new KnowledgeError('POLICY_DENIED', `Task ${actor.taskId} is outside this knowledge library`);
  }

  private validateFilterStrings(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length < 1) throw new KnowledgeError('INVALID_INPUT', `${field} must be a non-empty array of strings`, [field]);
    const values = value.map((item, index) => requiredString(item, `${field}[${index}]`));
    if (new Set(values).size !== values.length) throw new KnowledgeError('INVALID_INPUT', `${field} contains duplicates`, [field]);
    return values;
  }

  private assertSourceScope(source: KnowledgeSourceConfig, actor: KnowledgeActor): void {
    if (!source.scope.allowedTaskIds.includes(actor.taskId)) throw new KnowledgeError('POLICY_DENIED', `Source ${source.paperId} is outside this task`);
    if (!source.scope.usageScopes.some((scope) => actor.usageScopes.includes(scope))) throw new KnowledgeError('POLICY_DENIED', `Source ${source.paperId} is outside the caller's usage scopes`);
    if (source.scope.forbiddenContentClasses.some((tag) => ['sealed', 'gold', 'final_test'].includes(tag))) {
      // These tags are constraints on content classes, not a signal that the source itself is forbidden.
      return;
    }
  }

  private readConfiguredSource(source: KnowledgeSourceConfig): Buffer {
    const repoReal = fs.realpathSync(this.repoRoot);
    const configuredRoot = path.resolve(this.repoRoot, this.config.sourceRoot);
    const sourceRoot = fs.realpathSync(configuredRoot);
    const rootFromRepo = path.relative(repoReal, sourceRoot);
    if (rootFromRepo === '..' || rootFromRepo.startsWith(`..${path.sep}`) || path.isAbsolute(rootFromRepo)) throw new KnowledgeError('POLICY_DENIED', 'Configured source root resolves outside the repository workspace');
    const target = path.resolve(configuredRoot, source.hostRegisteredFileRef);
    if (target !== configuredRoot && !target.startsWith(configuredRoot + path.sep)) throw new KnowledgeError('POLICY_DENIED', 'Configured source escapes its registered source root');
    const actualPath = fs.realpathSync(target);
    const relative = path.relative(sourceRoot, actualPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new KnowledgeError('POLICY_DENIED', 'Configured source resolves through a junction or symlink outside its registered source root');
    const stat = fs.statSync(actualPath);
    if (!stat.isFile()) throw new KnowledgeError('INVALID_INPUT', 'Configured source must be a regular file');
    if (!/\.(txt|md)$/i.test(actualPath)) throw new KnowledgeError('INVALID_INPUT', 'Only explicit .txt and .md sources are supported');
    if (stat.size > this.config.policy.maxSourceBytes) throw new KnowledgeError('BUDGET_EXHAUSTED', `Source ${source.hostRegisteredFileRef} exceeds maxSourceBytes`);
    const accessPolicyPath = path.resolve(this.repoRoot, source.accessPolicyRef);
    const policyReal = fs.realpathSync(accessPolicyPath);
    const policyFromRepo = path.relative(repoReal, policyReal);
    if (policyFromRepo === '..' || policyFromRepo.startsWith(`..${path.sep}`) || path.isAbsolute(policyFromRepo) || !fs.statSync(policyReal).isFile()) {
      throw new KnowledgeError('POLICY_DENIED', 'Source access policy must be a regular file inside the repository workspace');
    }
    const policyHash = sha256Hex(fs.readFileSync(policyReal));
    if (policyHash !== source.accessPolicySha256) throw new KnowledgeError('SOURCE_MISMATCH', `Access policy ${source.accessPolicyRef} hash mismatch`);
    return fs.readFileSync(actualPath);
  }

  private mutate<T>(actor: KnowledgeActor, commandId: string, kind: string, input: unknown, action: (state: KnowledgeState) => { result: T; subjectRefs: ArtifactRef[] }): T {
    if (this.closed) throw new KnowledgeError('HOST_BUSY', 'Knowledge service has been disposed');
    const state = this.readState();
    this.assertOwner(state, actor, true);
    const inputHash = canonicalHash({ kind, input, taskId: actor.taskId, usageScopes: [...actor.usageScopes].sort() });
    const prior = state.commands[commandId];
    if (prior) {
      if (prior.inputHash !== inputHash) throw new KnowledgeError('IDEMPOTENCY_CONFLICT', `commandId ${commandId} was already used for different input`);
      return prior.result as T;
    }
    const outcome = action(state);
    const at = new Date().toISOString();
    const event: KnowledgeEvent = { eventId: randomUUID(), kind, commandId, at, subjectRefs: outcome.subjectRefs };
    const eventBytes = Buffer.from(JSON.stringify(event), 'utf8');
    this.writeImmutable(makeArtifactRef(`events/${event.eventId}.json`, eventBytes), eventBytes);
    state.commands[commandId] = { inputHash, result: outcome.result };
    state.events.push(event);
    this.writeState(state);
    return outcome.result;
  }

  private assertOwner(state: KnowledgeState, actor: KnowledgeActor, bindIfEmpty: boolean): void {
    if (!state.ownerSessionId && bindIfEmpty) state.ownerSessionId = actor.sessionId.trim();
    if (state.ownerSessionId && state.ownerSessionId !== actor.sessionId.trim()) throw new KnowledgeError('OWNER_MISMATCH', 'Knowledge library belongs to a different session owner');
  }

  private readState(): KnowledgeState {
    const raw = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as KnowledgeState;
    if (raw.schemaVersion !== 1 || raw.libraryId !== this.config.libraryId || !Array.isArray(raw.sources) || !Array.isArray(raw.events)) throw new KnowledgeError('SOURCE_MISMATCH', 'Knowledge catalog descriptor is malformed or belongs to a different library');
    return raw;
  }

  private writeState(state: KnowledgeState): void {
    const bytes = Buffer.from(JSON.stringify(state, null, 2), 'utf8');
    const temp = `${this.statePath}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, this.statePath);
  }

  private writeImmutable(ref: ArtifactRef, bytes: Uint8Array): void {
    const target = this.resolveLibraryPath(ref.id);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target);
      if (sha256Hex(existing) !== ref.sha256) throw new KnowledgeError('SOURCE_MISMATCH', `Immutable artifact collision at ${ref.id}`);
      return;
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, bytes, { flag: 'wx' });
    fs.renameSync(temp, target);
  }

  private resolveLibraryPath(id: string): string {
    if (id.includes('\\') || id.startsWith('/') || /^[A-Za-z]:/.test(id) || id.split('/').some((part) => part === '..' || part === '.')) throw new KnowledgeError('POLICY_DENIED', `Invalid internal artifact id ${id}`);
    const target = path.resolve(this.libraryRoot, id);
    if (target !== this.libraryRoot && !target.startsWith(this.libraryRoot + path.sep)) throw new KnowledgeError('POLICY_DENIED', `Artifact escapes knowledge library: ${id}`);
    return target;
  }

  private readArtifactBytes(refRaw: unknown): Buffer {
    const ref = validateArtifactRef(refRaw, 'artifactRef');
    const target = this.resolveLibraryPath(ref.id);
    const bytes = fs.readFileSync(target);
    const actual = sha256Hex(bytes);
    if (actual !== ref.sha256) throw new KnowledgeError('SOURCE_MISMATCH', `Artifact hash mismatch for ${ref.id}: expected ${ref.sha256}, got ${actual}`);
    return bytes;
  }

  private readArtifactText(ref: ArtifactRef): string {
    return new TextDecoder('utf-8', { fatal: true }).decode(this.readArtifactBytes(ref));
  }

  private readJsonArtifact<T>(ref: ArtifactRef): T {
    return JSON.parse(this.readArtifactText(ref)) as T;
  }

  private findChunkRef(state: KnowledgeState, ref: ArtifactRef): ArtifactRef {
    for (const source of state.sources) for (const chunkRef of source.chunkRefs) if (refsEqual(chunkRef, ref)) return chunkRef;
    throw new KnowledgeError('SOURCE_MISMATCH', `Unknown chunk ref ${ref.id}`);
  }

  private assertWikiDependenciesReadable(state: KnowledgeState, revision: WikiRevisionRecord): void {
    const external = new Set<string>();
    for (const claim of revision.claims) {
      if (claim.kind === 'local_observation') {
        if (!claim.verifiedResultRef || !claim.conditionsRef || !this.verifyLocalObservation(claim.verifiedResultRef, claim.conditionsRef)) {
          throw new KnowledgeError('POLICY_DENIED', `Local observation ${claim.id} no longer has trusted execution evidence`);
        }
        external.add(`${claim.verifiedResultRef.id}:${claim.verifiedResultRef.sha256}`); external.add(`${claim.conditionsRef.id}:${claim.conditionsRef.sha256}`);
      } else if (claim.kind === 'execution_diagnostic') {
        if (!claim.diagnosticRef || !claim.conditionsRef || !this.verifyExecutionDiagnostic(claim.diagnosticRef, claim.conditionsRef)) {
          throw new KnowledgeError('POLICY_DENIED', `Execution diagnosis ${claim.id} no longer has trusted execution evidence`);
        }
        external.add(`${claim.diagnosticRef.id}:${claim.diagnosticRef.sha256}`); external.add(`${claim.conditionsRef.id}:${claim.conditionsRef.sha256}`);
      }
    }
    for (const ref of revision.dependencyRefs) if (!external.has(`${ref.id}:${ref.sha256}`)) this.assertRefReadable(state, ref);
  }

  private assertRefReadable(state: KnowledgeState, ref: ArtifactRef): void {
    this.readArtifactBytes(ref);
    const source = state.sources.find((item) => refsEqual(item.sourceRef, ref));
    if (source?.revokedAt) throw new KnowledgeError('POLICY_DENIED', `Source ${ref.id} has been revoked`);
    const chunkRef = this.findChunkRefOrNull(state, ref);
    if (chunkRef) {
      const chunk = this.readJsonArtifact<StoredChunk>(chunkRef);
      const chunkSource = state.sources.find((item) => refsEqual(item.sourceRef, chunk.sourceRef));
      if (!chunkSource || chunkSource.revokedAt) throw new KnowledgeError('POLICY_DENIED', `Chunk ${ref.id} depends on a revoked source`);
    }
  }

  private findChunkRefOrNull(state: KnowledgeState, ref: ArtifactRef): ArtifactRef | null {
    for (const source of state.sources) for (const chunkRef of source.chunkRefs) if (refsEqual(chunkRef, ref)) return chunkRef;
    return null;
  }

  private markContradictions(claims: WikiClaim[]): void {
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    for (const claim of claims) {
      for (const otherId of claim.conflictsWith ?? []) {
        const other = byId.get(otherId);
        if (other && claim.conditionKey && claim.conditionKey === other.conditionKey) {
          claim.state = 'conflicted';
          other.state = 'conflicted';
        }
      }
    }
  }

  private renderWiki(pageId: string, title: string, claims: WikiClaim[], pack: EvidencePackRecord): string {
    const lines = [`# ${title}`, '', `Page ID: \`${pageId}\``, '', '> Status: provisional. Structural citation checks do not constitute semantic peer review.', '', `Evidence pack: \`${pack.ref.id}\` (sha256: \`${pack.ref.sha256}\`)`, ''];
    for (const claim of claims) {
      const label = claim.kind === 'source_reported' ? 'Source reported' : claim.kind === 'inferred' ? 'Inference' : claim.kind === 'execution_diagnostic' ? 'Execution diagnostic' : 'Local observation';
      lines.push(`## ${claim.id} — ${label} (${claim.state})`, '', claim.text, '');
      if (claim.derivationText) lines.push(`Derivation: ${claim.derivationText}`, '');
      if (claim.conditionsRef) lines.push(`Conditions ref: \`${claim.conditionsRef.id}\` (${claim.conditionsRef.sha256})`, '');
      if (claim.verifiedResultRef) lines.push(`Verified result ref: \`${claim.verifiedResultRef.id}\` (${claim.verifiedResultRef.sha256})`, '');
      if (claim.diagnosticRef) lines.push(`Diagnostic ref: \`${claim.diagnosticRef.id}\` (${claim.diagnosticRef.sha256})`, '');
      for (const ref of claim.evidenceRefs) {
        const hit = pack.hits.find((item) => refsEqual(item.chunkRef, ref));
        if (!hit) continue;
        lines.push(`Evidence: [${hit.title}](${hit.sourceUri}) · ${hit.section} paragraph ${hit.paragraphIndex + 1}, UTF-8 bytes ${hit.rawByteStart}–${hit.rawByteEndExclusive} · chunk \`${ref.id}\` (${ref.sha256})`, '', `> ${hit.text}`, '');
      }
    }
    return `${lines.join('\n').trimEnd()}\n`;
  }
}
