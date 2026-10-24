import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ResearchCoreError, validateActorContext, type KnowledgeCard } from '../../research-contracts/src/index.ts';
import { ProjectStore, commitOperation, sha256File, type ProjectStoreOptions } from './project-store.ts';
import { assertInside } from './root.ts';
import { activeStore } from './active-store.ts';
import { readNativeExperimentMaterial } from './bootstrap-loop-store.ts';
import { legacyScope } from './legacy-domain.ts';
import { GeneralEvidenceReader } from '../../evolver/src/application/general-evidence-service.ts';
import type { WriteRequest } from './service.ts';

export interface KnowledgeWrite extends WriteRequest {
  baseRevision: number;
  cardId?: string;
  cardRevision?: number;
  kind: KnowledgeCard['kind'];
  title: string;
  body: string;
  sourceIds: string[];
  unknowns: string[];
  citations: NonNullable<KnowledgeCard['citations']>;
}

export function readMaterial(options: ProjectStoreOptions, workspaceDir: string, sourceId: string) {
  if (activeStore(workspaceDir)) return readNativeExperimentMaterial(workspaceDir, sourceId);
  const project = new ProjectStore(workspaceDir, options).read();
  const source = project?.sources.find((s) => s.sourceId === sourceId);
  if (!source) throw new ResearchCoreError('NOT_FOUND', `source ${sourceId} is not in this project`);
  const root = path.join(path.resolve(workspaceDir), '.research');
  const file = assertInside(root, path.join(root, source.relativePath));
  if (!fs.existsSync(file)) throw new ResearchCoreError('NOT_FOUND', `source file is missing: ${sourceId}`);
  assertInside(fs.realpathSync(root), fs.realpathSync(file));
  if (sha256File(file).sha256 !== source.sha256) throw new ResearchCoreError('STATE_CORRUPT', `source hash changed: ${sourceId}`);
  const bytes = fs.readFileSync(file);
  const textual = source.mediaType.startsWith('text/') || source.mediaType === 'application/json';
  if (!textual) return { source, text: null, coverage: 'needs_parser' as const, message: '原文件已保存；尚未配置该格式的全文解析器，未声明完成解析。' };
  if (bytes.length > 256 * 1024) throw new ResearchCoreError('QUOTA', 'source text exceeds 256 KiB preview limit; no silent truncation');
  return { source, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), coverage: 'full_text' as const, message: 'UTF-8 原文；引用位置按 UTF-8 bytes 计算。' };
}

export function upsertKnowledge(options: ProjectStoreOptions, request: KnowledgeWrite) {
  validateActorContext(request.actor);
  const store = new ProjectStore(request.workspaceDir, options);
  const payload = { cardId: request.cardId ?? null, cardRevision: request.cardRevision ?? null, kind: request.kind, title: request.title, body: request.body, sourceIds: request.sourceIds, unknowns: request.unknowns, citations: request.citations };
  return commitOperation(store, request.operationId, 'upsert_knowledge', payload, (current) => {
    if (!current) throw new ResearchCoreError('NOT_FOUND', 'init a research project first');
    if (request.baseRevision !== current.revision) throw new ResearchCoreError('REVISION_CONFLICT', `current revision is ${current.revision}`);
    if (!Array.isArray(request.sourceIds) || !request.sourceIds.length || !Array.isArray(request.citations) || !request.citations.length) {
      throw new ResearchCoreError('INVALID_INPUT', 'knowledge requires sources and exact text citations; parser gaps stay explicit');
    }
    for (const id of request.sourceIds) readMaterial(options, request.workspaceDir, id);
    for (const c of request.citations) {
      if (!request.sourceIds.includes(c.sourceId)) throw new ResearchCoreError('INVALID_INPUT', 'citation is outside card sources');
      const material = readMaterial(options, request.workspaceDir, c.sourceId);
      if (material.source.sha256 !== c.sha256 || material.text === null) throw new ResearchCoreError('INVALID_INPUT', 'citation needs verified text and the current source hash');
      const bytes = Buffer.from(material.text, 'utf8');
      if (!Number.isSafeInteger(c.startByte) || !Number.isSafeInteger(c.endByte) || c.startByte < 0 || c.endByte <= c.startByte || c.endByte > bytes.length || bytes.subarray(c.startByte, c.endByte).toString('utf8') !== c.quote) {
        throw new ResearchCoreError('INVALID_INPUT', 'citation byte range does not match its quote');
      }
    }
    const versions = current.knowledge.filter((c) => c.cardId === request.cardId);
    const latest = versions.reduce<KnowledgeCard | undefined>((a, b) => !a || b.revision > a.revision ? b : a, undefined);
    if (request.cardId && !latest) throw new ResearchCoreError('NOT_FOUND', 'knowledge card is not in this project');
    if (latest && request.cardRevision !== latest.revision) throw new ResearchCoreError('REVISION_CONFLICT', 'knowledge card revision changed');
    const cardId = latest?.cardId ?? `card-${crypto.randomUUID()}`;
    const revision = (latest?.revision ?? 0) + 1;
    current.knowledge.push({ cardId, revision, kind: request.kind, title: request.title, body: request.body, sourceIds: request.sourceIds, unknowns: request.unknowns, citations: request.citations, updatedAt: store.now() });
    return { state: current, result: { cardId, cardRevision: revision } };
  });
}

export function searchWiki(options: ProjectStoreOptions, workspaceDir: string, query = '', offset = 0, limit = 30) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ResearchCoreError('INVALID_INPUT', 'offset >= 0 and limit 1–100 required');
  if (activeStore(workspaceDir)) {
    const { store } = legacyScope(workspaceDir), state = store.readStateOrEmpty();
    const research = state.researches.find(r => r.researchId === state.activeResearchId), g = research?.general;
    if (!research || !g) throw new ResearchCoreError('NOT_FOUND', 'Select a general research before searching its Wiki');
    const latest = g.knowledge.filter(entry => !entry.archived && !g.knowledge.some(other => other.entryId === entry.entryId && other.version > entry.version));
    const matches = latest.filter(entry => `${entry.title}\n${entry.content}`.toLowerCase().includes(query.toLowerCase()));
    const reader = new GeneralEvidenceReader(store, research.researchId, state);
    // Check before pagination, so a withdrawn matching entry cannot be exposed
    // through its count or recovered by requesting a different result page.
    for (const entry of matches) reader.assertEntryAccess(entry);
    return { revision: state.revision, total: matches.length, offset, items: matches.slice(offset, offset + limit) };
  }
  const state = new ProjectStore(workspaceDir, options).read();
  if (!state) throw new ResearchCoreError('NOT_FOUND', 'research project does not exist');
  const latest = state.knowledge.filter((c) => !state.knowledge.some((other) => other.cardId === c.cardId && other.revision > c.revision));
  const matches = latest.filter((c) => `${c.title}\n${c.body}`.toLowerCase().includes(query.toLowerCase()));
  return { revision: state.revision, total: matches.length, offset, items: matches.slice(offset, offset + limit) };
}
