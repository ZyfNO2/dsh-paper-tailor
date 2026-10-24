/**
 * Batch 2: fold a Research Snapshot into an existing research.
 *
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-02-WORKER-PLAN-2026-10-16.md
 *
 * The service reuses research create, material import, knowledge versions, graph nodes
 * and team-task drafts. It does not parse metric semantics, start training, or load weights.
 * Same-directory links stay unverified and never become execution prerequisites.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { BootstrapError } from '../contracts/research-bootstrap.ts';
import { DATA_LIMITS, MATERIAL_NATURES, type MaterialNature } from '../contracts/general-data.ts';
import {
  TakeoverError,
  isSafeRelativePath,
  type TakeoverAdoption,
  type TakeoverAdoptionItem,
  type TakeoverEntry,
  type TakeoverRecord,
} from '../contracts/research-takeover.ts';
import { ResearchBootstrapStore } from './research-bootstrap-store.ts';
import { TakeoverService, type TakeoverServiceOptions } from './takeover-service.ts';
import { GeneralResearchService } from './general-research-service.ts';
import { GeneralDataService } from './general-data-service.ts';
import { GeneralKnowledgeService } from './general-knowledge-service.ts';
import { GeneralWorkflowService } from './general-workflow-service.ts';
import { GeneralMaterialStore, sha256 } from './general-material-store.ts';
import type { MutationResult } from './research-bootstrap-store.ts';

const UNKNOWN_QUESTION = '待确定';
const WEIGHT_KINDS = new Set(['weight']);

export interface TakeoverAdoptionRequestItem {
  key: string;
  entryId: string;
  title: string;
  content: string;
  quote: string;
  nature: 'source_reported' | 'hypothesis' | 'unknown';
  /** Input material provenance is independent of the knowledge claim's nature. */
  materialNature?: MaterialNature;
  role: 'wiki' | 'material' | 'plan' | 'metadata';
}

export interface TakeoverAdoptionRequestRelation {
  key: string;
  fromKey: string;
  toKey: string;
  basis: 'quoted_text' | 'config_reference' | 'run_identifier' | 'same_directory';
  confidence: 'evidenced' | 'inferred' | 'unverified';
  note: string;
}

export interface TakeoverAdoptionInput {
  operationId: string;
  baseRevision: number;
  takeoverId: string;
  researchId?: string | null;
  items: TakeoverAdoptionRequestItem[];
  relations?: TakeoverAdoptionRequestRelation[];
}

export interface TakeoverAdoptionResult {
  adoptionId: string;
  researchId: string | null;
  status: TakeoverAdoption['status'];
  reused: boolean;
  createdResearch: boolean;
  items: TakeoverAdoptionItem[];
  relations: TakeoverAdoption['relations'];
  plans: TakeoverAdoption['plans'];
  firstError: TakeoverAdoption['firstError'];
}

const mediaTypeFor = (relativePath: string): string => {
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (extension === '.pdf') return 'application/pdf';
  if (extension === '.json') return 'application/json';
  if (extension === '.csv' || extension === '.tsv') return 'text/csv';
  if (extension === '.md') return 'text/markdown';
  if (extension === '.yaml' || extension === '.yml') return 'text/yaml';
  return 'text/plain';
};

const materialNatureFor = (entry: TakeoverEntry): MaterialNature => {
  if (entry.kind === 'paper') return 'literature';
  if (entry.kind === 'log' || entry.kind === 'metric') return 'user_result';
  if (entry.kind === 'note' || entry.kind === 'wiki') return 'user_observation';
  return 'unknown';
};

const normalizeSpace = (value: string): string => value.replace(/\s+/g, ' ').trim();

function locateQuote(bytes: Buffer, quote: string): { start: number; end: number; quote: string } | null {
  const candidates = [...new Set([quote, quote.replace(/\r\n/g, '\n'), quote.replace(/\n/g, '\r\n')])];
  for (const candidate of candidates) {
    const needle = Buffer.from(candidate, 'utf8');
    if (needle.length === 0 || needle.length > 16000) continue;
    const start = bytes.indexOf(needle);
    if (start >= 0) return { start, end: start + needle.length, quote: bytes.subarray(start, start + needle.length).toString('utf8') };
  }
  return null;
}

function readScopedFile(workspaceRoot: string, relativePath: string): { bytes: Buffer; bytesLength: number; modifiedMs: number } {
  if (!isSafeRelativePath(relativePath)) throw new TakeoverError('POLICY_DENIED', `来源路径越界：${relativePath}`);
  const root = path.resolve(workspaceRoot);
  const absolute = path.resolve(root, relativePath);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new TakeoverError('POLICY_DENIED', `来源路径越界：${relativePath}`);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new TakeoverError('POLICY_DENIED', `来源不是可读取的普通文件：${relativePath}`);
  return { bytes: fs.readFileSync(absolute), bytesLength: stat.size, modifiedMs: Math.trunc(stat.mtimeMs) };
}

function requestHash(scanId: string, snapshotRevision: number, items: TakeoverAdoptionRequestItem[], relations: TakeoverAdoptionRequestRelation[]): string {
  return sha256(JSON.stringify({ scanId, snapshotRevision, items, relations }));
}

function childOperation(operationId: string, suffix: string): string {
  const raw = `${operationId}:${suffix}`;
  return raw.length <= 180 ? raw : sha256(raw);
}

export class TakeoverAdoptionService {
  readonly store: ResearchBootstrapStore;
  private readonly readPdfText: TakeoverServiceOptions['readPdfText'];
  private readonly options: TakeoverServiceOptions;
  private readonly sourceWorkspaceRoot: string;

  constructor(store: ResearchBootstrapStore, options: TakeoverServiceOptions = {}) {
    this.store = store;
    this.options = options;
    this.sourceWorkspaceRoot = path.resolve(options.sourceWorkspaceRoot ?? store.workspaceRoot);
    this.readPdfText = options.readPdfText;
  }

  async adopt(input: TakeoverAdoptionInput, actorIdentity: string): Promise<TakeoverAdoptionResult> {
    if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0) throw new TakeoverError('INVALID_INPUT', 'baseRevision 必须是非负整数。');
    const items = this.normalizeItems(input.items);
    const relations = this.normalizeRelations(input.relations ?? []);
    const takeover = new TakeoverService(this.store, this.options).read(input.takeoverId);
    if (takeover === null) throw new TakeoverError('NOT_FOUND', `没有接管记录 ${input.takeoverId}`);
    const scan = takeover.scans.find((entry) => entry.scanId === takeover.currentScanId);
    if (scan === undefined || takeover.snapshot.scanId !== scan.scanId) throw new TakeoverError('INVALID_INPUT', 'Snapshot 与当前扫描不一致，不能发布。');
    const hash = requestHash(scan.scanId, takeover.snapshot.revision, items, relations);
    const fresh = this.staleness(takeover, items);
    const previous = takeover.adoptions.find((entry) => entry.requestHash === hash);
    if (fresh !== null) return this.finishBlocked(input, actorIdentity, takeover, hash, fresh, previous);
    if (previous?.status === 'saved') {
      return { adoptionId: previous.adoptionId, researchId: previous.researchId, status: previous.status, reused: true, createdResearch: false, items: previous.items, relations: previous.relations, plans: previous.plans, firstError: previous.firstError };
    }

    let revision = input.baseRevision;
    let researchId = takeover.researchId;
    let createdResearch = false;
    if (input.researchId && researchId && input.researchId !== researchId) {
      throw new TakeoverError('INVALID_INPUT', '接管已经绑定到另一个研究；不会改绑。');
    }
    const requestedResearch = input.researchId ?? researchId;
    if (!requestedResearch) {
      const created = new GeneralResearchService(this.store).create({
        operationId: childOperation(input.operationId, 'research'),
        baseRevision: revision,
        title: takeover.snapshot.title.trim() || takeover.title,
        question: UNKNOWN_QUESTION,
        domains: [UNKNOWN_QUESTION],
        methods: ['review'],
        entryMode: 'existing_data',
      });
      revision = created.revision;
      researchId = created.result.researchId;
      createdResearch = true;
    } else {
      researchId = requestedResearch;
      if (!this.store.readStateOrEmpty().researches.some((entry) => entry.researchId === researchId && entry.general)) {
        throw new TakeoverError('NOT_FOUND', '目标研究不存在，或不是通用研究。');
      }
    }
    if (takeover.researchId !== researchId) {
      const bound = new TakeoverService(this.store, this.options).bindResearch({ operationId: childOperation(input.operationId, 'bind'), baseRevision: revision, takeoverId: takeover.takeoverId, researchId }, actorIdentity);
      revision = bound.revision;
    }

    const published = new Map<string, TakeoverAdoptionItem>();
    let firstError: TakeoverAdoption['firstError'] = null;
    const noteError = (code: string, message: string) => { if (firstError === null) firstError = { code, message }; };
    for (const item of items) {
      try {
        const saved = await this.publishItem(input.operationId, () => revision, (next) => { revision = next; }, researchId, takeover, item);
        published.set(item.key, saved);
        if (saved.status === 'skipped' || saved.status === 'conflict') noteError('PARTIAL', saved.reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof BootstrapError && error.code === 'REVISION_CONFLICT') throw error;
        published.set(item.key, { key: item.key, entryId: item.entryId, status: 'skipped', reason: message, sourceId: null, sha256: null, mode: 'none', knowledgeId: null, knowledgeVersion: null, nodeId: null });
        noteError(error instanceof BootstrapError ? error.code : 'PARTIAL', message);
      }
    }
    const relationResults: TakeoverAdoption['relations'] = [];
    for (const relation of relations) {
      try {
        relationResults.push(this.publishRelation(input.operationId, () => revision, (next) => { revision = next; }, researchId, relation, published));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof BootstrapError && error.code === 'REVISION_CONFLICT') throw error;
        relationResults.push({ key: relation.key, status: 'skipped', reason: message });
        noteError('PARTIAL', message);
      }
    }
    const plans = this.publishPlans(input.operationId, () => revision, (next) => { revision = next; }, researchId, takeover);
    const itemResults = items.map((item) => published.get(item.key)!);
    const blocked = itemResults.some((item) => item.status === 'skipped' || item.status === 'conflict') || relationResults.some((relation) => relation.status === 'skipped');
    const status: TakeoverAdoption['status'] = blocked ? 'partial' : 'saved';
    const written = this.writeAdoption(input, revision, hash, researchId, takeover, status, firstError, itemResults, relationResults, plans);
    return { adoptionId: written.result.adoptionId, researchId, status, reused: written.replayed, createdResearch, items: itemResults, relations: relationResults, plans, firstError };
  }

  private normalizeItems(raw: TakeoverAdoptionRequestItem[]): TakeoverAdoptionRequestItem[] {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 40) throw new TakeoverError('INVALID_INPUT', 'items 必须是 1–40 条接入项。');
    const natures = new Set(['source_reported', 'hypothesis', 'unknown']);
    const roles = new Set(['wiki', 'material', 'plan', 'metadata']);
    return raw.map((item, index) => {
      if (item === null || typeof item !== 'object') throw new TakeoverError('INVALID_INPUT', `items[${index}] 必须是对象。`);
      const key = String(item.key ?? '');
      const entryId = String(item.entryId ?? '');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(key) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(entryId)) throw new TakeoverError('INVALID_INPUT', `items[${index}] 的 key / entryId 不合法。`);
      if (!natures.has(item.nature) || !roles.has(item.role)) throw new TakeoverError('INVALID_INPUT', `items[${index}] 的 nature 或 role 不在允许值内。`);
      if (item.materialNature !== undefined && !MATERIAL_NATURES.includes(item.materialNature)) throw new TakeoverError('INVALID_INPUT', `items[${index}].materialNature 不在允许的来源性质内。`);
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300) throw new TakeoverError('INVALID_INPUT', `items[${index}].title 不能为空。`);
      if (typeof item.content !== 'string' || item.content.length > 8000) throw new TakeoverError('INVALID_INPUT', `items[${index}].content 过长或不是字符串。`);
      const quote = item.quote === undefined || item.quote === null ? '' : item.quote;
      if (typeof quote !== 'string' || quote.length > 4000) throw new TakeoverError('INVALID_INPUT', `items[${index}].quote 过长或不是字符串。`);
      if (item.role !== 'metadata' && item.nature === 'source_reported' && !quote.trim()) throw new TakeoverError('INVALID_INPUT', `items[${index}].quote 不能为空。`);
      return { key, entryId, title: item.title.trim(), content: item.content, quote, nature: item.nature, role: item.role, ...(item.materialNature === undefined ? {} : { materialNature: item.materialNature }) };
    });
  }

  private normalizeRelations(raw: TakeoverAdoptionRequestRelation[]): TakeoverAdoptionRequestRelation[] {
    if (!Array.isArray(raw) || raw.length > 40) throw new TakeoverError('INVALID_INPUT', 'relations 必须是数组。');
    const bases = new Set(['quoted_text', 'config_reference', 'run_identifier', 'same_directory']);
    const confidences = new Set(['evidenced', 'inferred', 'unverified']);
    return raw.map((relation, index) => {
      if (!bases.has(relation?.basis) || !confidences.has(relation?.confidence)) throw new TakeoverError('INVALID_INPUT', `relations[${index}] 的 basis 或 confidence 不合法。`);
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/.test(String(relation.key ?? ''))) throw new TakeoverError('INVALID_INPUT', `relations[${index}].key 不合法。`);
      return { key: relation.key, fromKey: String(relation.fromKey), toKey: String(relation.toKey), basis: relation.basis, confidence: relation.confidence, note: typeof relation.note === 'string' ? relation.note.slice(0, 1000) : '' };
    });
  }

  private staleness(takeover: TakeoverRecord, items: TakeoverAdoptionRequestItem[]): string | null {
    const freshness = new TakeoverService(this.store, this.options).checkFreshness(takeover.takeoverId);
    if (freshness.stale) return `扫描监视项已变化：${freshness.changed.map((entry) => `${entry.relativePath}（${entry.reason}）`).join('、')}`;
    const scan = takeover.scans.find((entry) => entry.scanId === takeover.currentScanId)!;
    for (const item of items) {
      const entry = scan.entries.find((candidate) => candidate.entryId === item.entryId);
      if (entry === undefined) return `条目 ${item.entryId} 不在当前扫描中。`;
      let file: ReturnType<typeof readScopedFile>;
      try { file = readScopedFile(this.sourceWorkspaceRoot, entry.relativePath); }
      catch (error) { return error instanceof Error ? error.message : String(error); }
      if (file.bytesLength !== entry.bytes) return `${entry.relativePath} 的大小与扫描时不一致。`;
      if (entry.modifiedAt !== null && Math.abs(file.modifiedMs - Date.parse(entry.modifiedAt)) > 1) return `${entry.relativePath} 的修改时间与扫描时不一致。`;
      if (entry.sha256 !== null && sha256(file.bytes) !== entry.sha256) return `${entry.relativePath} 的内容 hash 与扫描时不一致。`;
    }
    return null;
  }

  private finishBlocked(input: TakeoverAdoptionInput, actorIdentity: string, takeover: TakeoverRecord, hash: string, reason: string, previous: TakeoverAdoption | undefined): TakeoverAdoptionResult {
    if (previous?.status === 'blocked') {
      return { adoptionId: previous.adoptionId, researchId: previous.researchId, status: 'blocked', reused: true, createdResearch: false, items: previous.items, relations: previous.relations, plans: previous.plans, firstError: previous.firstError };
    }
    const written = this.writeAdoption(input, input.baseRevision, hash, takeover.researchId, takeover, 'blocked', { code: 'STALE', message: reason }, [], [], [], `${input.operationId}:blocked`);
    void actorIdentity;
    return { adoptionId: written.result.adoptionId, researchId: takeover.researchId, status: 'blocked', reused: written.replayed, createdResearch: false, items: [], relations: [], plans: [], firstError: { code: 'STALE', message: reason } };
  }

  private async publishItem(
    operationId: string,
    revision: () => number,
    setRevision: (value: number) => void,
    researchId: string,
    takeover: TakeoverRecord,
    item: TakeoverAdoptionRequestItem,
  ): Promise<TakeoverAdoptionItem> {
    const scan = takeover.scans.find((entry) => entry.scanId === takeover.currentScanId)!;
    const entry = scan.entries.find((candidate) => candidate.entryId === item.entryId)!;
    const blank = (status: TakeoverAdoptionItem['status'], reason: string, extra: Partial<TakeoverAdoptionItem> = {}): TakeoverAdoptionItem => ({
      key: item.key, entryId: item.entryId, status, reason, sourceId: null, sha256: null, mode: 'none', knowledgeId: null, knowledgeVersion: null, nodeId: null, ...extra,
    });
    const file = readScopedFile(this.sourceWorkspaceRoot, entry.relativePath);
    const contentHash = sha256(file.bytes);
    const metadataOnly = item.role === 'metadata' || WEIGHT_KINDS.has(entry.kind) || file.bytes.length > DATA_LIMITS.maxFileBytes || entry.readStatus === 'metadata_only';
    if (metadataOnly) {
      const reason = WEIGHT_KINDS.has(entry.kind)
        ? '权重只登记元数据，未加载、未反序列化。'
        : file.bytes.length > DATA_LIMITS.maxFileBytes
          ? '文件超过来源大小上限，只保留路径与 hash。'
          : '只登记元数据，未作为正文来源发布。';
      const nodeId = item.role === 'plan' ? null : this.ensureNode(operationId, revision, setRevision, researchId, item, entry.relativePath, null);
      return blank('metadata', reason, { sha256: contentHash, mode: 'metadata_only', nodeId });
    }
    if (entry.readStatus !== 'read') return blank('skipped', '未读或读取失败的条目不能正式引用。');
    if (item.nature === 'source_reported' && !item.quote.trim()) return blank('skipped', '来源报告缺少原文引用，未发布。');
    const titled = this.general(researchId).knowledge.filter((entryItem) => !entryItem.archived && entryItem.title.trim() === item.title && entryItem.okfMetadata?.takeoverKey !== item.key);
    const owned = this.general(researchId).knowledge.filter((entryItem) => entryItem.okfMetadata?.takeoverKey === item.key);
    if (owned.length === 0 && titled.length > 0) return blank('conflict', '已有同名知识，接管内容另作待审，没有覆盖。');

    const sourceId = this.ensureSource(operationId, revision, setRevision, researchId, entry, file.bytes, contentHash, item.materialNature);
    const general = this.general(researchId);
    const source = general.sources.find((candidate) => candidate.sourceId === sourceId)!;
    let locator: { kind: 'text'; sourceId: string; sourceSha256: string; startByte: number; endByte: number; quote: string } | { kind: 'pdf'; sourceId: string; sourceSha256: string; page: number; quote: string; pagesSha256: string } | null = null;
    if (mediaTypeFor(entry.relativePath) === 'application/pdf') {
      if (this.readPdfText === undefined) return blank('skipped', 'PDF 还没有页文本读取器，不能按页引用。', { sourceId, sha256: contentHash, mode: 'content' });
      const pages = await this.readPdfText(file.bytes, path.posix.basename(entry.relativePath));
      const normalized = normalizeSpace(item.quote);
      const page = pages.findIndex((text) => normalizeSpace(text).includes(normalized));
      if (page < 0 || normalized.length < 8) return blank('skipped', '引用不在 PDF 提取出的页文本中，未发布。', { sourceId, sha256: contentHash, mode: 'content' });
      const pagesSha256 = new GeneralMaterialStore(this.store.workspaceRoot).writePdfPages(contentHash, pages);
      locator = { kind: 'pdf', sourceId, sourceSha256: contentHash, page: page + 1, quote: item.quote, pagesSha256 };
    } else if (item.quote.trim()) {
      const located = locateQuote(file.bytes, item.quote);
      if (located === null) return blank('skipped', '引用不在原始字节中，未发布。', { sourceId, sha256: contentHash, mode: 'content' });
      locator = { kind: 'text', sourceId, sourceSha256: contentHash, startByte: located.start, endByte: located.end, quote: located.quote };
    }
    if (item.nature === 'source_reported' && locator === null) return blank('skipped', '来源报告没有定位到原文，未发布。', { sourceId, sha256: contentHash, mode: 'content' });

    const nodeId = item.role === 'plan' ? null : this.ensureNode(operationId, revision, setRevision, researchId, item, entry.relativePath, sourceId);
    const marker = `takeover-key:${item.key}`;
    const content = `${item.content}\n\n来源路径：${entry.relativePath}\n扫描：${scan.scanId}；Snapshot：${takeover.snapshot.revision}\n${marker}`;
    const existing = owned.sort((a, b) => a.version - b.version).at(-1);
    if (existing && !String(existing.content).includes(marker)) return blank('conflict', '该条目的当前版本已不是接管稿，保留现有内容。', { sourceId, sha256: contentHash, mode: 'content', knowledgeId: existing.entryId, knowledgeVersion: existing.version, nodeId });
    if (existing && existing.content === content && existing.sourceRefs.length === 1 && existing.sourceRefs[0] === sourceId && existing.nature === item.nature) return blank('published', '内容与来源未变，沿用已有知识版本。', { sourceId, sha256: contentHash, mode: 'content', knowledgeId: existing.entryId, knowledgeVersion: existing.version, nodeId: existing.nodeIds[0] ?? nodeId });

    const saved = new GeneralKnowledgeService(this.store).save({
      operationId: childOperation(operationId, `knowledge-${item.key}`),
      baseRevision: revision(),
      researchId,
      entryId: existing?.entryId ?? null,
      entry: {
        kind: 'wiki',
        title: item.title,
        category: 'takeover',
        content,
        nature: item.nature,
        sourceRefs: [sourceId],
        calculationIds: [],
        nodeIds: nodeId ? [nodeId] : [],
        input: entry.relativePath,
        output: '外部资料报告，不是本系统执行结果。',
        conditions: ['精确引用只证明原文存在，不证明科学结论。'],
        parameters: [],
        operation: 'external_not_connected',
        archived: false,
        claims: [{
          claimId: `claim-${item.key}`,
          text: item.content.slice(0, 4000) || item.title,
          nature: item.nature,
          locators: locator ? [locator] : [],
          limitation: '精确引用只证明原文存在，不证明科学结论。',
        }],
        entityType: item.role === 'material' ? 'experiment' : 'overview',
        okfMetadata: { takeoverKey: item.key, takeoverId: takeover.takeoverId, scanId: scan.scanId, snapshotRevision: takeover.snapshot.revision, relativePath: entry.relativePath },
        counterEvidence: [],
        limitations: [entry.kind === 'log' ? '日志中的成功或失败是外部记录，不是本系统的执行状态。' : '待核实关系不能当作已验证结论。'],
        sourcePins: [{ sourceId, sha256: source.sha256 }],
      },
    });
    setRevision(saved.revision);
    return blank('published', existing ? '已追加新版本，旧内容仍在历史中。' : '已登记来源并写入 Wiki。', { sourceId, sha256: contentHash, mode: 'content', knowledgeId: saved.result.entryId, knowledgeVersion: saved.result.version, nodeId });
  }

  private ensureSource(operationId: string, revision: () => number, setRevision: (value: number) => void, researchId: string, entry: TakeoverEntry, bytes: Buffer, contentHash: string, materialNature?: MaterialNature): string {
    const description = `takeover-path:${entry.relativePath}`.slice(0, 4000);
    const general = this.general(researchId);
    const same = [...general.sources].reverse().find((source) => source.description === description && source.sha256 === contentHash && (materialNature === undefined || source.nature === materialNature));
    if (same) return same.sourceId;
    const previous = [...general.sources].reverse().find((source) => source.description === description);
    const imported = new GeneralDataService(this.store).importMaterial({
      operationId: childOperation(operationId, `source-${createHash('sha256').update(entry.entryId).digest('hex').slice(0, 16)}-${contentHash.slice(0, 8)}`),
      baseRevision: revision(),
      researchId,
      filename: path.posix.basename(entry.relativePath).slice(0, 300),
      mediaType: mediaTypeFor(entry.relativePath),
      contentBase64: bytes.toString('base64'),
      nature: materialNature ?? materialNatureFor(entry),
      description,
      purpose: `接管来源 ${entry.relativePath}；外部资料，不是本系统运行结果。`,
      previousSourceId: previous?.sourceId ?? null,
    });
    setRevision(imported.revision);
    return imported.result.sourceId;
  }

  private ensureNode(operationId: string, revision: () => number, setRevision: (value: number) => void, researchId: string, item: TakeoverAdoptionRequestItem, relativePath: string, sourceId: string | null): string {
    const marker = `takeover-node:${item.key}`;
    const existing = this.general(researchId).graph.nodes.find((node) => node.method.includes(marker));
    if (existing) return existing.nodeId;
    const saved = new GeneralWorkflowService(this.store).saveNode({
      operationId: childOperation(operationId, `node-${item.key}`),
      baseRevision: revision(),
      researchId,
      node: {
        title: item.title,
        kind: item.role === 'material' ? 'materials' : 'manual',
        goal: item.title,
        inputs: [],
        method: `${marker}\n外部资料整理。路径：${relativePath}${sourceId ? `；来源 ${sourceId}` : ''}`,
        output: '外部资料报告，不是本系统已执行任务。',
        completionCriterion: '待人工核实；本批不执行实验。',
        join: 'all',
      },
    });
    setRevision(saved.revision);
    const node = this.general(researchId).graph.nodes.find((candidate) => candidate.nodeId === saved.result.nodeId);
    if (node && node.execution !== 'not_started') throw new TakeoverError('INVALID_INPUT', '接管节点不能带有执行完成状态。');
    return saved.result.nodeId;
  }

  private publishRelation(
    operationId: string,
    revision: () => number,
    setRevision: (value: number) => void,
    researchId: string,
    relation: TakeoverAdoptionRequestRelation,
    published: Map<string, TakeoverAdoptionItem>,
  ): TakeoverAdoption['relations'][number] {
    const from = published.get(relation.fromKey);
    const to = published.get(relation.toKey);
    if (!from?.knowledgeId || !to?.knowledgeId) return { key: relation.key, status: 'skipped', reason: '关系两端还没有可引用的知识，未连成执行前置。' };
    const unverified = relation.basis === 'same_directory' || relation.confidence !== 'evidenced';
    if (unverified) {
      this.ensureKnowledgeRelation(operationId, revision, setRevision, researchId, from.knowledgeId, to.knowledgeId, `待核实：${relation.basis}。${relation.note} 同目录、同名或修改时间不能作为执行前置。`);
      return { key: relation.key, status: 'knowledge_only', reason: '已标为待核实，没有生成执行依赖。' };
    }
    if ((relation.basis === 'config_reference' || relation.basis === 'run_identifier') && from.nodeId && to.nodeId) {
      const general = this.general(researchId);
      const existing = general.graph.edges.find((edge) => edge.kind === 'derived_from' && ((edge.from === from.nodeId && edge.to === to.nodeId) || (edge.from === to.nodeId && edge.to === from.nodeId)));
      if (!existing) {
        const saved = new GeneralWorkflowService(this.store).saveEdge({
          operationId: childOperation(operationId, `edge-${relation.key}`),
          baseRevision: revision(),
          researchId,
          edge: { from: from.nodeId, to: to.nodeId, kind: 'derived_from', condition: null },
        });
        setRevision(saved.revision);
      }
      return { key: relation.key, status: 'derived', reason: '仅作为资料派生关系，不是 depends_on，不能放行任务。' };
    }
    this.ensureKnowledgeRelation(operationId, revision, setRevision, researchId, from.knowledgeId, to.knowledgeId, `${relation.basis}：${relation.note} 引用成立不等于科学结论成立。`);
    return { key: relation.key, status: 'knowledge_only', reason: '已保留为知识关系，没有生成执行依赖。' };
  }

  private ensureKnowledgeRelation(operationId: string, revision: () => number, setRevision: (value: number) => void, researchId: string, fromEntryId: string, toEntryId: string, note: string): void {
    const existing = this.general(researchId).knowledgeRelations.find((relation) => relation.fromEntryId === fromEntryId && relation.toEntryId === toEntryId && relation.note === note);
    if (existing) return;
    const saved = new GeneralKnowledgeService(this.store).saveRelation({
      operationId: childOperation(operationId, `relation-${createHash('sha256').update(`${fromEntryId}:${toEntryId}:${note}`).digest('hex').slice(0, 20)}`),
      baseRevision: revision(),
      researchId,
      relation: { fromEntryId, toEntryId, kind: 'related', note },
    });
    setRevision(saved.revision);
  }

  private publishPlans(operationId: string, revision: () => number, setRevision: (value: number) => void, researchId: string, takeover: TakeoverRecord): TakeoverAdoption['plans'] {
    const steps = takeover.snapshot.nextSteps.filter((step) => step.trim());
    if (steps.length === 0) return [];
    const marker = 'takeover-node:next-steps';
    let nodeId = this.general(researchId).graph.nodes.find((node) => node.method.includes(marker))?.nodeId;
    if (nodeId === undefined) {
      const saved = new GeneralWorkflowService(this.store).saveNode({
        operationId: childOperation(operationId, 'node-next-steps'),
        baseRevision: revision(),
        researchId,
        node: { title: '下一步建议（未执行）', kind: 'manual', goal: '保留接管时的下一步建议', inputs: [], method: `${marker}\n规划草稿，不启动实验。`, output: '未执行。', completionCriterion: '需人工决定后才可能进入后续批次。', join: 'all' },
      });
      setRevision(saved.revision);
      nodeId = saved.result.nodeId;
    }
    return steps.map((step, index) => {
      const existing = this.general(researchId).teamTaskDrafts.find((draft) => draft.nodeId === nodeId && draft.title === step.slice(0, 300));
      if (existing) return { title: existing.title, draftId: existing.draftId };
      const saved = new GeneralWorkflowService(this.store).saveTeamTaskDraft({
        operationId: childOperation(operationId, `plan-${index}`),
        baseRevision: revision(),
        researchId,
        draft: { nodeId, title: step.slice(0, 300), goal: step.slice(0, 4000), method: '规划草稿。不是已执行任务，也不能作为放行前置。', completionCriterion: '仍为草稿。', sourceIds: [] },
      });
      setRevision(saved.revision);
      return { title: step.slice(0, 300), draftId: saved.result.draftId };
    });
  }

  private general(researchId: string) {
    const research = this.store.readStateOrEmpty().researches.find((entry) => entry.researchId === researchId);
    if (!research?.general) throw new TakeoverError('NOT_FOUND', '目标研究没有通用工作区。');
    return research.general;
  }

  private writeAdoption(
    input: TakeoverAdoptionInput,
    revision: number,
    hash: string,
    researchId: string | null,
    takeover: TakeoverRecord,
    status: TakeoverAdoption['status'],
    firstError: TakeoverAdoption['firstError'],
    items: TakeoverAdoptionItem[],
    relations: TakeoverAdoption['relations'],
    plans: TakeoverAdoption['plans'],
    operationId = childOperation(input.operationId, 'adoption'),
  ): MutationResult<{ adoptionId: string }> {
    return this.store.mutate<{ adoptionId: string }>({
      operationId,
      kind: 'takeover_adopt',
      researchId,
      baseRevision: revision,
      requestPayload: { takeoverId: input.takeoverId, requestHash: hash, status, items, relations, plans },
      apply: (context) => {
        const target = (context.state.takeovers ?? []).find((entry) => entry.takeoverId === input.takeoverId);
        if (target === undefined) throw new TakeoverError('NOT_FOUND', '接管记录在写入时消失。');
        const now = context.now();
        const adoption: TakeoverAdoption = {
          adoptionId: context.mint('adoption'),
          requestHash: hash,
          researchId,
          scanId: takeover.currentScanId,
          snapshotRevision: takeover.snapshot.revision,
          status,
          firstError,
          items,
          relations,
          plans,
          createdAt: now,
          updatedAt: now,
        };
        target.adoptions = [...(target.adoptions ?? []), adoption];
        target.updatedAt = now;
        return { changed: true, result: { adoptionId: adoption.adoptionId } };
      },
    });
  }
}
