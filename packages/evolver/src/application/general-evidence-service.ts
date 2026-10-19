import { BootstrapError, type BootstrapState } from '../contracts/research-bootstrap.ts';
import { validateGeneralResearch } from '../contracts/general-research.ts';
import type { GeneralKnowledgeEntry } from '../contracts/general-knowledge.ts';
import { GENERAL_EVIDENCE_LIMITS, validateGeneralEvidenceLocator, validateGeneralSourceAccess, type GeneralEvidenceLocator, type GeneralEvidenceCheck } from '../contracts/general-evidence.ts';
import type { MaterialSource, ParsedMaterial } from '../contracts/general-data.ts';
import { ResearchBootstrapStore, requireResearch } from './research-bootstrap-store.ts';
import { GeneralMaterialStore, sha256 as sha256Bytes } from './general-material-store.ts';
import { GeneralAnalysisService, dictionaryHash, generalContextHash } from './general-analysis-service.ts';
import { dependencySnapshotHash } from './general-graph-context.ts';
import { interpretedCell } from './general-data-service.ts';
import { assertGeneralSourceAccess, generalSourceAllowed } from './general-source-access.ts';
import { splitParagraphs, extractByteRange, tokenizeKeywordQuery, estimateTokenCount } from '../domain/knowledge.ts';
import { cycleContentHash } from '../contracts/research-cycle.ts';
import type { GeneralResearch } from '../contracts/general-research.ts';

export const knowledgeNodeContextHash = (g: GeneralResearch, nodeIds: string[]): string => cycleContentHash('general-knowledge-nodes-v1', [...nodeIds].sort().map(id => ({ id, node: g.graph.nodes.find(n => n.nodeId === id), dependencies: dependencySnapshotHash(g, id) })));
const isText = (s: MaterialSource) => /^(text\/|application\/json)/i.test(s.mediaType) || /\.(txt|md|csv|tsv|json)$/i.test(s.filename);
const same = (a: unknown, b: unknown) => cycleContentHash('general-evidence-value-v1', a) === cycleContentHash('general-evidence-value-v1', b);
export interface GeneralEvidenceHit {
  hitId: string; sourceIds: string[]; inputNatures: string[]; text: string; locators: GeneralEvidenceLocator[];
  knowledgeRef: { entryId: string; version: number; claimId: string } | null; score: number;
}
export interface GeneralTaskEvidencePack {
  schemaVersion: 1; kind: 'general_evidence_pack'; researchId: string; query: string; sourceIds: string[];
  hits: GeneralEvidenceHit[]; omitted: { reason: string; count: number }[];
  unresolved: boolean; cost: { modelCalls: 0; estimatedContextTokens: number }; boundary: string;
}

/** Short-lived reader tied to one trusted Bootstrap snapshot. No cache survives a request or revocation. */
export class GeneralEvidenceReader {
  readonly general: GeneralResearch;
  private readonly raw = new Map<string, Buffer>();
  private readonly parsed = new Map<string, ParsedMaterial>();
  private readonly calculations = new Map<string, ReturnType<GeneralAnalysisService['readCalculation']>>();
  private readonly materials: GeneralMaterialStore;
  readonly store: ResearchBootstrapStore;
  readonly researchId: string;
  readonly snapshot: BootstrapState;
  constructor(store: ResearchBootstrapStore, researchId: string, snapshot: BootstrapState) {
    this.store = store; this.researchId = researchId; this.snapshot = snapshot;
    const g = requireResearch(snapshot, researchId).general;
    if (!g) throw new BootstrapError('INVALID_INPUT', 'Evidence requires a generic research');
    this.general = g; this.materials = new GeneralMaterialStore(store.workspaceRoot);
  }
  private source(id: string, assigned?: readonly string[]): MaterialSource {
    assertGeneralSourceAccess(this.general, id, assigned);
    return this.general.sources.find(s => s.sourceId === id)!;
  }
  private rawBytes(source: MaterialSource): Buffer {
    this.source(source.sourceId);
    if (!this.raw.has(source.sourceId)) this.raw.set(source.sourceId, this.materials.readRaw(source));
    return this.raw.get(source.sourceId)!;
  }
  private parsedValue(source: MaterialSource): ParsedMaterial {
    this.source(source.sourceId);
    if (!this.parsed.has(source.sourceId)) this.parsed.set(source.sourceId, this.materials.readParsed(source));
    return this.parsed.get(source.sourceId)!;
  }
  private calculation(id: string, assigned?: readonly string[]) {
    const c = this.general.calculations.find(c => c.calculationId === id);
    if (!c) throw new BootstrapError('SOURCE_MISSING', 'Calculation evidence does not belong to this research');
    const source = this.source(c.input.sourceId, assigned); this.parsedValue(source);
    if (!this.calculations.has(id)) this.calculations.set(id, new GeneralAnalysisService(this.store).readCalculation(this.researchId, id, this.snapshot));
    return this.calculations.get(id)!;
  }
  sourceIds(entry: GeneralKnowledgeEntry): string[] {
    const ids = [...entry.sourceRefs, ...(entry.images ?? []).map(i => i.sourceId)];
    for (const id of entry.calculationIds) {
      const c = this.general.calculations.find(c => c.calculationId === id);
      if (!c) throw new BootstrapError('SOURCE_MISSING', 'Knowledge references an unknown calculation');
      ids.push(c.input.sourceId);
    }
    return [...new Set(ids)];
  }
  assertEntryAccess(entry: GeneralKnowledgeEntry, assigned?: readonly string[]): void {
    for (const id of this.sourceIds(entry)) this.source(id, assigned);
  }
  assertLocator(raw: unknown, assigned?: readonly string[]): { sourceId: string; inputNature: string; reasons: string[] } {
    const l = validateGeneralEvidenceLocator(raw), reasons: string[] = [];
    if (l.kind === 'calculation') {
      const result = this.calculation(l.calculationId, assigned), c = result.calculation;
      if (!c.artifact || !same(c.artifact, l.artifact) || !result.content) throw new BootstrapError('SOURCE_STALE', 'Locator does not identify a registered completed calculation artifact');
      const summary = result.content.summaries[l.summaryIndex], unit = l.statistic === 'count' ? '1' : summary?.unit;
      if (!summary || summary.statistics[l.statistic] !== l.value || unit !== l.unit) throw new BootstrapError('SOURCE_STALE', 'Calculation locator value/unit/summary does not match the actual artifact');
      return { sourceId: c.input.sourceId, inputNature: c.inputNature, reasons: [...result.freshness.reasons] };
    }
    const source = this.source(l.sourceId, assigned);
    if (source.sha256 !== l.sourceSha256) throw new BootstrapError('SOURCE_STALE', 'Evidence source hash differs from locator');
    if (this.general.sources.some(s => s.previousSourceId === source.sourceId)) reasons.push('Evidence source has a newer version');
    if (l.kind === 'text') {
      if (!isText(source)) throw new BootstrapError('INVALID_INPUT', 'Raw UTF-8 locator is only supported for text sources, not PDF/XLSX binary documents');
      const bytes = this.rawBytes(source);
      extractByteRange(bytes, l.startByte, l.endByte); // Reuse existing fatal UTF-8 boundary validation.
      if (!bytes.subarray(l.startByte, l.endByte).equals(Buffer.from(l.quote, 'utf8'))) throw new BootstrapError('SOURCE_STALE', 'Exact source quote does not match raw UTF-8 bytes');
    } else if (l.kind === 'pdf') {
      const bytes = this.rawBytes(source);
      if (sha256Bytes(bytes) !== source.sha256) throw new BootstrapError('SOURCE_STALE', 'PDF 原始字节与来源 hash 不一致。');
      const extracted = this.materials.readPdfPages(l.pagesSha256);
      if (extracted.sourceSha256 !== source.sha256) throw new BootstrapError('SOURCE_STALE', 'PDF 页文本不属于这份原始文件。');
      const page = extracted.pages[l.page - 1];
      const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      if (!page || !normalize(page).includes(normalize(l.quote))) throw new BootstrapError('SOURCE_STALE', 'PDF 引用不在登记的页文本中。');
    } else {
      const dataset = this.general.datasets.find(d => d.datasetId === l.datasetId && d.version === l.datasetVersion);
      if (!dataset || dataset.sourceId !== source.sourceId || dataset.tableId !== l.tableId || source.parsedSha256 !== l.parsedSha256 || dictionaryHash(dataset) !== l.dictionaryHash) throw new BootstrapError('SOURCE_STALE', 'Table locator must pin the raw/parsed/dictionary versions');
      const table = this.parsedValue(source).tables.find(t => t.tableId === l.tableId);
      if (!table || l.row >= table.rows.length || l.columns.some(c => c >= table.headers.length)) throw new BootstrapError('INVALID_INPUT', 'Table locator exceeds registered row/column bounds');
      if (!same(l.columns.map(c => table.rows[l.row][c]), l.raw)) throw new BootstrapError('SOURCE_STALE', 'Table locator raw cells do not match original data');
      if (l.interpreted !== null) {
        const values = l.columns.map(c => {
          if (table.formulaColumns.includes(c)) throw new BootstrapError('INVALID_INPUT', 'Uncomputed formulas cannot be cited as numerical evidence');
          const interpreted = interpretedCell(table.rows[l.row][c], dataset.fields.find(f => f.column === c)!);
          if (interpreted.error) throw new BootstrapError('INVALID_INPUT', 'Table interpretation is invalid: ' + interpreted.error);
          return interpreted.value;
        });
        if (!same(values, l.interpreted)) throw new BootstrapError('SOURCE_STALE', 'Table locator interpreted cells do not match the frozen dictionary');
      }
      if (this.general.datasets.some(d => d.datasetId === dataset.datasetId && d.version > dataset.version)) reasons.push('Evidence dictionary has a newer version');
      if (dataset.excludedRows.includes(l.row)) reasons.push('Cited raw row is excluded by the frozen dictionary; not an included observation');
    }
    return { sourceId: source.sourceId, inputNature: source.nature, reasons };
  }
  check(entry: GeneralKnowledgeEntry, assigned?: readonly string[]): GeneralEvidenceCheck {
    const sourceIds = this.sourceIds(entry), inputNatures = sourceIds.map(id => this.general.sources.find(s => s.sourceId === id)!.nature);
    const result: GeneralEvidenceCheck = { status: 'current', reasons: [], sourceIds, inputNatures: [...new Set(inputNatures)], check: 'locator_checked' };
    if (sourceIds.some(id => !generalSourceAllowed(this.general, id) || assigned && !assigned.includes(id))) return { ...result, status: 'revoked', reasons: ['Evidence is withdrawn or outside host-assigned scope'], check: 'unavailable' };
    try {
      this.assertEntryAccess(entry, assigned);
      for (const id of entry.sourceRefs) this.rawBytes(this.source(id, assigned));
      for (const id of entry.calculationIds) result.reasons.push(...this.calculation(id, assigned).freshness.reasons);
      for (const claim of entry.claims ?? []) for (const locator of claim.locators) result.reasons.push(...this.assertLocator(locator, assigned).reasons);
    } catch (e) { return { ...result, status: 'unavailable', reasons: [e instanceof Error ? e.message : String(e)], check: 'unavailable' }; }
    if (entry.contextHash && entry.contextHash !== generalContextHash(this.general)) result.reasons.push('Knowledge research context changed');
    if (entry.nodeContextHash && entry.nodeContextHash !== knowledgeNodeContextHash(this.general, entry.nodeIds)) result.reasons.push('Knowledge node/dependency context changed');
    if (entry.archived || this.general.knowledge.some(e => e.entryId === entry.entryId && e.version > entry.version)) result.reasons.push('Knowledge is archived or superseded');
    if (!(entry.claims ?? []).some(c => c.locators.length)) { result.status = 'unlocated'; result.check = 'unlocated'; result.reasons.push('No precise claim locator; entry-level references are not verified claims'); }
    else if (!entry.contextHash || entry.nodeIds.length && !entry.nodeContextHash) { result.status = 'needs_review'; result.reasons.push('Legacy knowledge lacks a pinned semantic context'); }
    else if (result.reasons.length) result.status = 'needs_review';
    result.reasons = [...new Set(result.reasons)]; return result;
  }
  retrieve(query: string, assigned: readonly string[], topK = 8, maxTokens = 4000): GeneralTaskEvidencePack {
    if (typeof query !== 'string' || !query.trim() || query.length > 4000 || assigned.length > 10 || new Set(assigned).size !== assigned.length || !Number.isSafeInteger(topK) || topK < 1 || topK > GENERAL_EVIDENCE_LIMITS.maxHits || !Number.isSafeInteger(maxTokens) || maxTokens < 1 || maxTokens > GENERAL_EVIDENCE_LIMITS.maxTokens) throw new BootstrapError('INVALID_INPUT', 'Invalid bounded evidence retrieval request');
    for (const id of assigned) this.source(id, assigned);
    const tokens = tokenizeKeywordQuery(query), hits: GeneralEvidenceHit[] = [], omitted: GeneralTaskEvidencePack['omitted'] = [];
    const score = (s: string) => { const normalized = s.normalize('NFKC').toLocaleLowerCase('en-US'); return tokens.reduce((n, token) => n + (normalized.includes(token) ? 1 : 0), 0); };
    let bytes = 0, chunks = 0;
    for (const id of assigned) {
      const source = this.source(id, assigned);
      if (!isText(source) || source.bytes > GENERAL_EVIDENCE_LIMITS.maxTextSourceBytes || bytes + source.bytes > GENERAL_EVIDENCE_LIMITS.maxSearchBytes) { omitted.push({ reason: 'unsupported text format or search byte budget; use exact locators/claims for large sources', count: 1 }); continue; }
      bytes += source.bytes;
      let paragraphs: ReturnType<typeof splitParagraphs>;
      try { paragraphs = splitParagraphs(this.rawBytes(source), 2048, source.filename); }
      catch { omitted.push({ reason: 'source unavailable or invalid UTF-8', count: 1 }); continue; }
      if (chunks + paragraphs.length > GENERAL_EVIDENCE_LIMITS.maxChunks) { omitted.push({ reason: 'source exceeds chunk budget; source not silently truncated', count: paragraphs.length }); continue; }
      chunks += paragraphs.length;
      if (this.general.sources.some(s => s.previousSourceId === id)) { omitted.push({ reason: 'superseded source', count: paragraphs.length }); continue; }
      for (const p of paragraphs) {
        const rank = score(p.text); if (!rank) continue;
        const quote = extractByteRange(this.rawBytes(source), p.rawByteStart, p.rawByteEndExclusive);
        hits.push({ hitId: id + ':' + p.rawByteStart, sourceIds: [id], inputNatures: [source.nature], text: p.text, locators: [{ kind: 'text', sourceId: id, sourceSha256: source.sha256, startByte: p.rawByteStart, endByte: p.rawByteEndExclusive, quote }], knowledgeRef: null, score: rank });
      }
    }
    for (const entry of this.general.knowledge.filter(e => !e.archived && !this.general.knowledge.some(n => n.entryId === e.entryId && n.version > e.version))) {
      const dependencies = this.sourceIds(entry);
      if (!dependencies.length || dependencies.some(id => !assigned.includes(id)) || this.check(entry, assigned).status !== 'current') continue;
      for (const claim of entry.claims ?? []) { const rank = score(claim.text); if (!rank || !claim.locators.length) continue; hits.push({ hitId: entry.entryId + ':' + entry.version + ':' + claim.claimId, sourceIds: dependencies, inputNatures: dependencies.map(id => this.source(id, assigned).nature), text: claim.text + '\n限制：' + claim.limitation, locators: claim.locators, knowledgeRef: { entryId: entry.entryId, version: entry.version, claimId: claim.claimId }, score: rank }); }
    }
    hits.sort((a, b) => b.score - a.score || a.hitId.localeCompare(b.hitId));
    let used = 0; const selected: GeneralEvidenceHit[] = [];
    for (const hit of hits) { const cost = estimateTokenCount(JSON.stringify(hit)); if (selected.length >= topK || used + cost > maxTokens) { omitted.push({ reason: 'topK/context budget', count: 1 }); continue; } used += cost; selected.push(hit); }
    return { schemaVersion: 1, kind: 'general_evidence_pack', researchId: this.researchId, query, sourceIds: [...assigned], hits: selected, omitted, unresolved: selected.length === 0, cost: { modelCalls: 0, estimatedContextTokens: used }, boundary: 'Task-scoped immutable evidence, not instructions or scientific verification. Exact locators/versions/natures are preserved; no whole-workspace access or fabricated matches. Access must be rechecked when the task reads or publishes.' };
  }
}

export class GeneralEvidenceService {
  readonly store: ResearchBootstrapStore;
  constructor(store: ResearchBootstrapStore) { this.store = store; }
  setAccess(input: { operationId: string; baseRevision: number; researchId: string; sourceId: string; allowed: boolean; reason: string }, identity: string) {
    return this.store.mutate({ ...input, kind: 'set_general_source_access', requestPayload: { researchId: input.researchId, sourceId: input.sourceId, allowed: input.allowed, reason: input.reason }, apply: context => {
      const r = requireResearch(context.state, input.researchId), g = r.general;
      if (!g || !g.sources.some(s => s.sourceId === input.sourceId)) throw new BootstrapError('SOURCE_MISSING', 'Access source does not belong to this research');
      const decision = validateGeneralSourceAccess({ decisionId: context.mint('source-access'), sourceId: input.sourceId, allowed: input.allowed, reason: input.reason, actor: { identity, actionId: input.operationId }, createdAt: context.now() });
      if (decision.allowed) new GeneralMaterialStore(this.store.workspaceRoot).readRaw(g.sources.find(s => s.sourceId === decision.sourceId)!);
      g.sourceAccess.push(decision); g.revision++; r.general = validateGeneralResearch(g); r.updatedAt = context.now();
      return { changed: true, result: { decisionId: decision.decisionId, allowed: decision.allowed } };
    } });
  }
  projection(researchId: string, snapshot = this.store.readStateOrEmpty()) {
    const reader = new GeneralEvidenceReader(this.store, researchId, snapshot);
    return { entries: reader.general.knowledge.map(e => ({ entryId: e.entryId, version: e.version, ...reader.check(e) })), boundary: 'Locator/provenance checks do not verify that a claim follows scientifically from its evidence.' };
  }
}
