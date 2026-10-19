/**
 * Batch 1 「已有研究目录只读接管」 contract.
 *
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-01-WORKER-PLAN-2026-10-16.md §2.1–§2.3, §5 B1-01..B1-07.
 *
 * Two kinds of fact are kept apart on purpose:
 * - `TakeoverScan` is produced by the read-only directory scanner. It is deterministic, carries no
 *   model-authored text, and is the ONLY source of truth for what was actually read. Locators
 *   (relative path + line range) come from here, so the model never guesses a page or an offset.
 * - `TakeoverSnapshot` is authored by the research Agent from that scan. Every citation must name a
 *   scan entry that was really read, and its quote must occur in the stored excerpt of that entry.
 *
 * `TakeoverRecord.researchId === null` is the 目标待定 draft: the plan forbids inventing a research
 * question only to satisfy `createGeneralResearch`'s non-empty question.
 *
 * Read-only means the user's original directory is never modified. Records live in the existing
 * bootstrap CAS (`<workspace>/.dsh/research/bootstrap/state.json`) and the scanner excludes that
 * directory from its own inventory.
 */

export const TAKEOVER_SCHEMA_VERSION = 1;

/** Documented scan and document bounds; the validator enforces them and tests pin the important ones. */
export const TAKEOVER_BOUNDS = Object.freeze({
  maxTakeovers: 50,
  maxScansPerTakeover: 20,
  maxEntriesPerScan: 2000,
  maxErrorsPerScan: 200,
  maxCitationsPerSnapshot: 200,
  maxGroupsPerSnapshot: 50,
  maxMaterialsPerSnapshot: 200,
  maxRelationsPerSnapshot: 100,
  maxUnknownPerSnapshot: 100,
  maxItemsPerSection: 100,
  maxNextSteps: 20,
  maxExcerptChars: 2000,
  /** Total excerpt text per scan: the record is stored in the single bootstrap CAS file, so it stays bounded. */
  maxExcerptCharsPerScan: 256 * 1024,
  maxWatchedEntries: 2000,
  maxScanVisited: 20000,
  maxScanDepth: 12,
  maxReadBytesPerFile: 256 * 1024,
  maxReadBytesPerScan: 8 * 1024 * 1024,
  /** PDF text extraction is whole-file, so it gets its own budget instead of the text read budget. */
  maxPdfBytesPerScan: 48 * 1024 * 1024,
  maxPdfFilesPerScan: 20,
  maxPdfBytesPerFile: 25 * 1024 * 1024,
});

/** Classification is preliminary: an extension or a directory name is a hint, never a conclusion. */
export const TAKEOVER_ENTRY_KINDS = ['paper', 'note', 'wiki', 'code', 'config', 'metric', 'log', 'weight', 'archive', 'other'] as const;
export type TakeoverEntryKind = (typeof TAKEOVER_ENTRY_KINDS)[number];

export const TAKEOVER_KIND_BASES = ['extension', 'directory', 'name', 'content'] as const;
export type TakeoverKindBasis = (typeof TAKEOVER_KIND_BASES)[number];

/** `read` is the only status that permits a citation; every other status carries a reason. */
export const TAKEOVER_READ_STATUSES = ['read', 'metadata_only', 'skipped', 'failed', 'not_read'] as const;
export type TakeoverReadStatus = (typeof TAKEOVER_READ_STATUSES)[number];

/** The four levels §2.2 requires be distinguished: present on disk ≠ read ≠ claimed done ≠ checked result. */
export const TAKEOVER_EVIDENCE_LEVELS = ['file_present', 'content_read', 'reported_complete', 'verifiable_result'] as const;
export type TakeoverEvidenceLevel = (typeof TAKEOVER_EVIDENCE_LEVELS)[number];

export const TAKEOVER_RELATION_BASES = ['quoted_text', 'config_reference', 'run_identifier', 'same_directory'] as const;
export type TakeoverRelationBasis = (typeof TAKEOVER_RELATION_BASES)[number];

export const TAKEOVER_RELATION_CONFIDENCES = ['evidenced', 'inferred', 'unverified'] as const;
export type TakeoverRelationConfidence = (typeof TAKEOVER_RELATION_CONFIDENCES)[number];

export const TAKEOVER_GROUP_BASES = ['same_directory', 'shared_config', 'shared_identifier', 'reported'] as const;
export type TakeoverGroupBasis = (typeof TAKEOVER_GROUP_BASES)[number];

export interface TakeoverEntry {
  entryId: string;
  /** Workspace-relative, posix separators, never absolute and never containing `..`. */
  relativePath: string;
  kind: TakeoverEntryKind;
  kindBasis: TakeoverKindBasis;
  bytes: number;
  /** Weights are metadata-only: this batch never deserializes them and never claims a hash it did not compute. */
  hashStatus: 'computed' | 'not_computed';
  sha256: string | null;
  readStatus: TakeoverReadStatus;
  /** Why the entry was not read, or what the failure was. Empty only for `read`. */
  readReason: string;
  modifiedAt: string | null;
  excerpt: string | null;
  excerptLines: { lineStart: number; lineEnd: number } | null;
  /** Content identity of the first entry with the same sha256; both stay registered. */
  duplicateOf: string | null;
  sourceIdentity: { kind: 'path' | 'content'; value: string };
}

export interface TakeoverScanLimits {
  maxVisited: number;
  maxDepth: number;
  maxEntries: number;
  maxReadBytesPerFile: number;
  maxReadBytes: number;
}

export interface TakeoverScan {
  scanId: string;
  /** Workspace-relative roots, posix separators. */
  roots: string[];
  scopeNote: string;
  startedAt: string;
  finishedAt: string;
  limits: TakeoverScanLimits;
  /** Exclusion rules that were actually applied; a partial scan must be described as partial. */
  exclusions: string[];
  visitedCount: number;
  truncated: boolean;
  entries: TakeoverEntry[];
  counts: {
    total: number;
    byKind: Record<TakeoverEntryKind, number>;
    read: number;
    metadataOnly: number;
    skipped: number;
    failed: number;
    notRead: number;
    totalBytes: number;
    hashed: number;
  };
  git: { insideWorkTree: boolean; headHash: string | null; dirtyEntryCount: number } | null;
  gitNote: string;
  errors: Array<{ relativePath: string; code: string; message: string }>;
}

export interface TakeoverCitation {
  citationId: string;
  entryId: string;
  /** Must occur verbatim in the stored excerpt of that entry. */
  quote: string;
  note: string;
}

export interface TakeoverMaterial {
  materialId: string;
  label: string;
  evidenceLevel: TakeoverEvidenceLevel;
  detail: string;
  citationIds: string[];
}

export interface TakeoverGroup {
  groupId: string;
  label: string;
  basis: TakeoverGroupBasis;
  basisNote: string;
  entryIds: string[];
  /** True when the only basis is co-location; §2.2 requires that limit be stated, not hidden. */
  limitedBasis: boolean;
}

export interface TakeoverRelation {
  relationId: string;
  fromLabel: string;
  toLabel: string;
  basis: TakeoverRelationBasis;
  confidence: TakeoverRelationConfidence;
  note: string;
  citationIds: string[];
}

export interface TakeoverUnknown {
  unknownId: string;
  topic: string;
  detail: string;
  entryIds: string[];
}

/** Freshness inputs re-checked on read: a changed size, mtime or hash marks the snapshot stale. */
export interface TakeoverWatchedEntry {
  entryId: string;
  relativePath: string;
  bytes: number;
  modifiedAt: string | null;
  sha256: string | null;
}

export interface TakeoverSnapshot {
  snapshotId: string;
  revision: number;
  researchId: string | null;
  scanId: string;
  title: string;
  /** 目前在研究什么; insufficient evidence stays 「待确定」 rather than being invented. */
  currentFocus: string;
  materials: TakeoverMaterial[];
  groups: TakeoverGroup[];
  known: string[];
  unknown: TakeoverUnknown[];
  relations: TakeoverRelation[];
  nextSteps: string[];
  citations: TakeoverCitation[];
  watchedEntries: TakeoverWatchedEntry[];
  model: { agentIdentity: string; modelIdentity: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface TakeoverAdoptionItem {
  key: string;
  entryId: string;
  status: 'published' | 'skipped' | 'conflict' | 'metadata';
  reason: string;
  sourceId: string | null;
  sha256: string | null;
  mode: 'content' | 'metadata_only' | 'none';
  knowledgeId: string | null;
  knowledgeVersion: number | null;
  nodeId: string | null;
}

export interface TakeoverAdoption {
  adoptionId: string;
  requestHash: string;
  researchId: string | null;
  scanId: string;
  snapshotRevision: number;
  status: 'saved' | 'partial' | 'blocked';
  firstError: { code: string; message: string } | null;
  items: TakeoverAdoptionItem[];
  relations: Array<{ key: string; status: 'knowledge_only' | 'derived' | 'skipped'; reason: string }>;
  plans: Array<{ title: string; draftId: string | null }>;
  createdAt: string;
  updatedAt: string;
}

export interface TakeoverRecord {
  takeoverId: string;
  revision: number;
  /** null = 目标待定草稿 (no research was invented to hold it). */
  researchId: string | null;
  title: string;
  roots: string[];
  scopeNote: string;
  status: 'draft' | 'saved';
  currentScanId: string;
  scans: TakeoverScan[];
  snapshot: TakeoverSnapshot;
  actorIdentity: string;
  firstError: { code: string; message: string } | null;
  /** Absent on records saved before Wiki adoption. Never implied by a missing key. */
  adoptions: TakeoverAdoption[];
  createdAt: string;
  updatedAt: string;
}

export class TakeoverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TakeoverError';
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new TakeoverError('SCHEMA_VIOLATION', `Research takeover schema: ${message}`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, fields: string[], label: string): Record<string, unknown> {
  const o = record(value, label);
  for (const key of Object.keys(o)) if (!fields.includes(key)) invalid(`${label}: unexpected ${key}`);
  for (const key of fields) if (!(key in o)) invalid(`${label}: missing ${key}`);
  return o;
}

function text(value: unknown, label: string, max = 4000, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) invalid(`${label}: invalid text`);
  return value as string;
}

function optionalText(value: unknown, label: string, max = 4000): string {
  if (value === null || value === undefined) return '';
  return text(value, label, max);
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) invalid(`${label}: invalid integer`);
  return value as number;
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${label}: invalid array`);
  return value as unknown[];
}

function strings(value: unknown, label: string, max: number, maxChars = 4000): string[] {
  return array(value, label, max).map((entry, index) => text(entry, `${label}[${index}]`, maxChars, true));
}

function choice<T extends string>(value: unknown, choices: readonly T[], label: string): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) invalid(`${label}: unsupported value`);
  return value as T;
}

function date(value: unknown, label: string): string {
  const result = text(value, label, 100, true);
  if (!Number.isFinite(Date.parse(result))) invalid(`${label}: invalid date`);
  return result;
}

function id(value: unknown, label: string): string {
  const result = text(value, label, 200, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(result)) invalid(`${label}: invalid id`);
  return result;
}

function hex64(value: unknown, label: string): string {
  const result = text(value, label, 64, true);
  if (!/^[0-9a-f]{64}$/.test(result)) invalid(`${label}: invalid hash`);
  return result;
}

/** A scan path is always workspace-relative; absolute paths and traversal are refused outright. */
export function isSafeRelativePath(value: string): boolean {
  if (!value.trim() || value.length > 400) return false;
  if (value.startsWith('/') || value.startsWith('\\')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.includes('\\')) return false;
  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function relativePath(value: unknown, label: string): string {
  const result = text(value, label, 400, true);
  if (!isSafeRelativePath(result)) invalid(`${label}: path must be workspace-relative without traversal`);
  return result;
}

/** Dedupe key: the same normalized root set is the same takeover, so a repeat never double-registers. */
export function takeoverRootsKey(roots: readonly string[]): string {
  return [...new Set(roots.map((root) => root.replace(/\/+$/, '')))].sort().join('\n');
}

function validateEntry(raw: unknown, label: string): TakeoverEntry {
  const o = exact(raw, ['entryId', 'relativePath', 'kind', 'kindBasis', 'bytes', 'hashStatus', 'sha256', 'readStatus', 'readReason', 'modifiedAt', 'excerpt', 'excerptLines', 'duplicateOf', 'sourceIdentity'], label);
  const readStatus = choice(o.readStatus, TAKEOVER_READ_STATUSES, `${label}.readStatus`);
  const readReason = text(o.readReason, `${label}.readReason`, 2000);
  const excerpt = o.excerpt === null || o.excerpt === undefined ? null : text(o.excerpt, `${label}.excerpt`, TAKEOVER_BOUNDS.maxExcerptChars);
  if (readStatus === 'read' && (excerpt === null || !excerpt.trim())) invalid(`${label}: a read entry must carry an excerpt`);
  if (readStatus !== 'read' && !readReason.trim()) invalid(`${label}: a non-read entry must state why`);
  if (readStatus === 'read' && readReason.trim()) invalid(`${label}: a read entry must not carry a skip reason`);
  let excerptLines: TakeoverEntry['excerptLines'] = null;
  if (o.excerptLines !== null && o.excerptLines !== undefined) {
    const l = exact(o.excerptLines, ['lineStart', 'lineEnd'], `${label}.excerptLines`);
    const lineStart = integer(l.lineStart, `${label}.excerptLines.lineStart`, 1, 100_000_000);
    const lineEnd = integer(l.lineEnd, `${label}.excerptLines.lineEnd`, lineStart, 100_000_000);
    excerptLines = { lineStart, lineEnd };
  }
  if (excerpt !== null && excerptLines === null) invalid(`${label}: an excerpt must carry its line locator`);
  if (excerpt === null && excerptLines !== null) invalid(`${label}: a line locator requires an excerpt`);
  const hashStatus = choice(o.hashStatus, ['computed', 'not_computed'] as const, `${label}.hashStatus`);
  const sha256 = o.sha256 === null || o.sha256 === undefined ? null : hex64(o.sha256, `${label}.sha256`);
  if (hashStatus === 'computed' && sha256 === null) invalid(`${label}: a computed hash must be present`);
  if (hashStatus === 'not_computed' && sha256 !== null) invalid(`${label}: a hash that was not computed must be null`);
  const identity = exact(o.sourceIdentity, ['kind', 'value'], `${label}.sourceIdentity`);
  const identityKind = choice(identity.kind, ['path', 'content'] as const, `${label}.sourceIdentity.kind`);
  const identityValue = text(identity.value, `${label}.sourceIdentity.value`, 400, true);
  if (identityKind === 'content' && !/^[0-9a-f]{64}$/.test(identityValue)) invalid(`${label}: content identity must be a sha256`);
  const duplicateOf = o.duplicateOf === null || o.duplicateOf === undefined ? null : id(o.duplicateOf, `${label}.duplicateOf`);
  return {
    entryId: id(o.entryId, `${label}.entryId`),
    relativePath: relativePath(o.relativePath, `${label}.relativePath`),
    kind: choice(o.kind, TAKEOVER_ENTRY_KINDS, `${label}.kind`),
    kindBasis: choice(o.kindBasis, TAKEOVER_KIND_BASES, `${label}.kindBasis`),
    bytes: integer(o.bytes, `${label}.bytes`, 0, Number.MAX_SAFE_INTEGER),
    hashStatus,
    sha256,
    readStatus,
    readReason,
    modifiedAt: o.modifiedAt === null || o.modifiedAt === undefined ? null : date(o.modifiedAt, `${label}.modifiedAt`),
    excerpt,
    excerptLines,
    duplicateOf,
    sourceIdentity: { kind: identityKind, value: identityValue },
  };
}

function validateScanLimits(raw: unknown, label: string): TakeoverScanLimits {
  const o = exact(raw, ['maxVisited', 'maxDepth', 'maxEntries', 'maxReadBytesPerFile', 'maxReadBytes'], label);
  return {
    maxVisited: integer(o.maxVisited, `${label}.maxVisited`, 1, TAKEOVER_BOUNDS.maxScanVisited),
    maxDepth: integer(o.maxDepth, `${label}.maxDepth`, 1, TAKEOVER_BOUNDS.maxScanDepth),
    maxEntries: integer(o.maxEntries, `${label}.maxEntries`, 1, TAKEOVER_BOUNDS.maxEntriesPerScan),
    maxReadBytesPerFile: integer(o.maxReadBytesPerFile, `${label}.maxReadBytesPerFile`, 1, TAKEOVER_BOUNDS.maxReadBytesPerFile),
    maxReadBytes: integer(o.maxReadBytes, `${label}.maxReadBytes`, 1, TAKEOVER_BOUNDS.maxReadBytesPerScan),
  };
}

function validateCounts(raw: unknown, label: string): TakeoverScan['counts'] {
  const o = exact(raw, ['total', 'byKind', 'read', 'metadataOnly', 'skipped', 'failed', 'notRead', 'totalBytes', 'hashed'], label);
  const byKindRaw = exact(o.byKind, [...TAKEOVER_ENTRY_KINDS], `${label}.byKind`);
  const byKind = {} as Record<TakeoverEntryKind, number>;
  for (const kind of TAKEOVER_ENTRY_KINDS) byKind[kind] = integer(byKindRaw[kind], `${label}.byKind.${kind}`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan);
  return {
    total: integer(o.total, `${label}.total`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan),
    byKind,
    read: integer(o.read, `${label}.read`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan),
    metadataOnly: integer(o.metadataOnly, `${label}.metadataOnly`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan),
    skipped: integer(o.skipped, `${label}.skipped`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan),
    failed: integer(o.failed, `${label}.failed`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan),
    notRead: integer(o.notRead, `${label}.notRead`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan),
    totalBytes: integer(o.totalBytes, `${label}.totalBytes`, 0, Number.MAX_SAFE_INTEGER),
    hashed: integer(o.hashed, `${label}.hashed`, 0, TAKEOVER_BOUNDS.maxEntriesPerScan),
  };
}

export function validateTakeoverScan(raw: unknown, label = 'scan'): TakeoverScan {
  const o = exact(raw, ['scanId', 'roots', 'scopeNote', 'startedAt', 'finishedAt', 'limits', 'exclusions', 'visitedCount', 'truncated', 'entries', 'counts', 'git', 'gitNote', 'errors'], label);
  const roots = strings(o.roots, `${label}.roots`, 20, 400);
  if (roots.length === 0) invalid(`${label}.roots: at least one root is required`);
  for (const [index, root] of roots.entries()) if (!isSafeRelativePath(root) && root !== '.') invalid(`${label}.roots[${index}]: path must be workspace-relative`);
  const entries = array(o.entries, `${label}.entries`, TAKEOVER_BOUNDS.maxEntriesPerScan).map((entry, index) => validateEntry(entry, `${label}.entries[${index}]`));
  if (new Set(entries.map((entry) => entry.entryId)).size !== entries.length) invalid(`${label}.entries: duplicate entry identity`);
  if (new Set(entries.map((entry) => entry.relativePath)).size !== entries.length) invalid(`${label}.entries: duplicate relative path`);
  const byId = new Map(entries.map((entry) => [entry.entryId, entry]));
  for (const entry of entries) {
    if (entry.duplicateOf !== null) {
      const original = byId.get(entry.duplicateOf);
      if (!original || original.entryId === entry.entryId || original.sha256 === null || original.sha256 !== entry.sha256) invalid(`${label}.entries: duplicateOf must name another entry with the same content hash`);
    }
  }
  const counts = validateCounts(o.counts, `${label}.counts`);
  if (counts.total !== entries.length) invalid(`${label}.counts.total: must equal the number of entries`);
  const expectedRead = entries.filter((entry) => entry.readStatus === 'read').length;
  const expectedMetadata = entries.filter((entry) => entry.readStatus === 'metadata_only').length;
  const expectedSkipped = entries.filter((entry) => entry.readStatus === 'skipped').length;
  const expectedFailed = entries.filter((entry) => entry.readStatus === 'failed').length;
  const expectedNotRead = entries.filter((entry) => entry.readStatus === 'not_read').length;
  if (counts.read !== expectedRead || counts.metadataOnly !== expectedMetadata || counts.skipped !== expectedSkipped || counts.failed !== expectedFailed || counts.notRead !== expectedNotRead) invalid(`${label}.counts: read-status totals must match the entries`);
  const expectedBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (counts.totalBytes !== expectedBytes) invalid(`${label}.counts.totalBytes: must equal the sum of entry sizes`);
  if (counts.hashed !== entries.filter((entry) => entry.hashStatus === 'computed').length) invalid(`${label}.counts.hashed: must equal the number of computed hashes`);
  for (const kind of TAKEOVER_ENTRY_KINDS) {
    if (counts.byKind[kind] !== entries.filter((entry) => entry.kind === kind).length) invalid(`${label}.counts.byKind.${kind}: must match the entries`);
  }
  const excerptChars = entries.reduce((sum, entry) => sum + (entry.excerpt?.length ?? 0), 0);
  if (excerptChars > TAKEOVER_BOUNDS.maxExcerptCharsPerScan) invalid(`${label}.entries: stored excerpts exceed ${TAKEOVER_BOUNDS.maxExcerptCharsPerScan} characters; store fewer or shorter excerpts`);
  let git: TakeoverScan['git'] = null;
  if (o.git !== null && o.git !== undefined) {
    const g = exact(o.git, ['insideWorkTree', 'headHash', 'dirtyEntryCount'], `${label}.git`);
    if (typeof g.insideWorkTree !== 'boolean') invalid(`${label}.git.insideWorkTree: must be a boolean`);
    const headHash = g.headHash === null || g.headHash === undefined ? null : text(g.headHash, `${label}.git.headHash`, 100, true);
    git = { insideWorkTree: g.insideWorkTree, headHash, dirtyEntryCount: integer(g.dirtyEntryCount, `${label}.git.dirtyEntryCount`, 0, 1_000_000) };
  }
  const errors = array(o.errors, `${label}.errors`, TAKEOVER_BOUNDS.maxErrorsPerScan).map((entry, index) => {
    const e = exact(entry, ['relativePath', 'code', 'message'], `${label}.errors[${index}]`);
    const p = text(e.relativePath, `${label}.errors[${index}].relativePath`, 400);
    if (p && !isSafeRelativePath(p)) invalid(`${label}.errors[${index}].relativePath: path must be workspace-relative`);
    return { relativePath: p, code: text(e.code, `${label}.errors[${index}].code`, 100, true), message: text(e.message, `${label}.errors[${index}].message`, 2000, true) };
  });
  if (typeof o.truncated !== 'boolean') invalid(`${label}.truncated: must be a boolean`);
  return {
    scanId: id(o.scanId, `${label}.scanId`),
    roots,
    scopeNote: optionalText(o.scopeNote, `${label}.scopeNote`, 2000),
    startedAt: date(o.startedAt, `${label}.startedAt`),
    finishedAt: date(o.finishedAt, `${label}.finishedAt`),
    limits: validateScanLimits(o.limits, `${label}.limits`),
    exclusions: strings(o.exclusions, `${label}.exclusions`, 50, 200),
    visitedCount: integer(o.visitedCount, `${label}.visitedCount`, 0, TAKEOVER_BOUNDS.maxScanVisited),
    truncated: o.truncated,
    entries,
    counts,
    git,
    gitNote: optionalText(o.gitNote, `${label}.gitNote`, 2000),
    errors,
  };
}

function validateCitation(raw: unknown, label: string): TakeoverCitation {
  const o = exact(raw, ['citationId', 'entryId', 'quote', 'note'], label);
  return {
    citationId: id(o.citationId, `${label}.citationId`),
    entryId: id(o.entryId, `${label}.entryId`),
    quote: text(o.quote, `${label}.quote`, TAKEOVER_BOUNDS.maxExcerptChars, true),
    note: optionalText(o.note, `${label}.note`, 2000),
  };
}

/** Every citation must resolve to a really-read entry, and the quote must be found in its excerpt. */
function citationText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function assertCitationsResolve(citations: readonly TakeoverCitation[], scan: TakeoverScan, context: string): void {
  if (!Array.isArray(citations)) {
    throw new TakeoverError('INVALID_INPUT', `${context}: snapshot.citations must be an array of {citationId, entryId, quote, note}; do not nest citations inside other fields`);
  }
  const byId = new Map(scan.entries.map((entry) => [entry.entryId, entry]));
  for (const citation of citations) {
    const entry = byId.get(citation.entryId);
    if (!entry) throw new TakeoverError('INVALID_INPUT', `${context}: citation ${citation.citationId} names an entry that is not in scan ${scan.scanId}`);
    if (entry.readStatus !== 'read' || entry.excerpt === null) throw new TakeoverError('INVALID_INPUT', `${context}: citation ${citation.citationId} names ${entry.relativePath}, which was not read (${entry.readStatus}); 引用必须回到真实已读内容`);
    if (!citationText(entry.excerpt).includes(citationText(citation.quote))) throw new TakeoverError('INVALID_INPUT', `${context}: citation ${citation.citationId} quotes text that is not present in the read excerpt of ${entry.relativePath}; 不得凭记忆引用`);
  }
}

function citationIds(value: unknown, label: string, known: ReadonlySet<string>): string[] {
  const result = strings(value, label, TAKEOVER_BOUNDS.maxCitationsPerSnapshot, 200);
  if (new Set(result).size !== result.length) invalid(`${label}: duplicate citation reference`);
  for (const entry of result) if (!known.has(entry)) invalid(`${label}: unknown citation ${entry}`);
  return result;
}

function validateSnapshot(raw: unknown, label: string): TakeoverSnapshot {
  const o = exact(raw, ['snapshotId', 'revision', 'researchId', 'scanId', 'title', 'currentFocus', 'materials', 'groups', 'known', 'unknown', 'relations', 'nextSteps', 'citations', 'watchedEntries', 'model', 'createdAt', 'updatedAt'], label);
  const citations = array(o.citations, `${label}.citations`, TAKEOVER_BOUNDS.maxCitationsPerSnapshot).map((entry, index) => validateCitation(entry, `${label}.citations[${index}]`));
  if (new Set(citations.map((citation) => citation.citationId)).size !== citations.length) invalid(`${label}.citations: duplicate citation identity`);
  const knownCitations = new Set(citations.map((citation) => citation.citationId));
  const materials = array(o.materials, `${label}.materials`, TAKEOVER_BOUNDS.maxMaterialsPerSnapshot).map((entry, index) => {
    const m = exact(entry, ['materialId', 'label', 'evidenceLevel', 'detail', 'citationIds'], `${label}.materials[${index}]`);
    return {
      materialId: id(m.materialId, `${label}.materials[${index}].materialId`),
      label: text(m.label, `${label}.materials[${index}].label`, 400, true),
      evidenceLevel: choice(m.evidenceLevel, TAKEOVER_EVIDENCE_LEVELS, `${label}.materials[${index}].evidenceLevel`),
      detail: optionalText(m.detail, `${label}.materials[${index}].detail`, 4000),
      citationIds: citationIds(m.citationIds, `${label}.materials[${index}].citationIds`, knownCitations),
    };
  });
  const groups = array(o.groups, `${label}.groups`, TAKEOVER_BOUNDS.maxGroupsPerSnapshot).map((entry, index) => {
    const g = exact(entry, ['groupId', 'label', 'basis', 'basisNote', 'entryIds', 'limitedBasis'], `${label}.groups[${index}]`);
    const basis = choice(g.basis, TAKEOVER_GROUP_BASES, `${label}.groups[${index}].basis`);
    const basisNote = optionalText(g.basisNote, `${label}.groups[${index}].basisNote`, 2000);
    const limitedBasis = g.limitedBasis === true;
    if (typeof g.limitedBasis !== 'boolean') invalid(`${label}.groups[${index}].limitedBasis: must be a boolean`);
    if ((basis === 'same_directory' || basis === 'reported') && !limitedBasis) invalid(`${label}.groups[${index}]: a ${basis} grouping must be marked limitedBasis`);
    if (limitedBasis && !basisNote.trim()) invalid(`${label}.groups[${index}]: a limited grouping must state its limited basis`);
    return {
      groupId: id(g.groupId, `${label}.groups[${index}].groupId`),
      label: text(g.label, `${label}.groups[${index}].label`, 400, true),
      basis,
      basisNote,
      entryIds: strings(g.entryIds, `${label}.groups[${index}].entryIds`, TAKEOVER_BOUNDS.maxEntriesPerScan, 200),
      limitedBasis,
    };
  });
  const unknown = array(o.unknown, `${label}.unknown`, TAKEOVER_BOUNDS.maxUnknownPerSnapshot).map((entry, index) => {
    const u = exact(entry, ['unknownId', 'topic', 'detail', 'entryIds'], `${label}.unknown[${index}]`);
    return {
      unknownId: id(u.unknownId, `${label}.unknown[${index}].unknownId`),
      topic: text(u.topic, `${label}.unknown[${index}].topic`, 400, true),
      detail: optionalText(u.detail, `${label}.unknown[${index}].detail`, 4000),
      entryIds: strings(u.entryIds, `${label}.unknown[${index}].entryIds`, 200, 200),
    };
  });
  const relations = array(o.relations, `${label}.relations`, TAKEOVER_BOUNDS.maxRelationsPerSnapshot).map((entry, index) => {
    const r = exact(entry, ['relationId', 'fromLabel', 'toLabel', 'basis', 'confidence', 'note', 'citationIds'], `${label}.relations[${index}]`);
    return {
      relationId: id(r.relationId, `${label}.relations[${index}].relationId`),
      fromLabel: text(r.fromLabel, `${label}.relations[${index}].fromLabel`, 400, true),
      toLabel: text(r.toLabel, `${label}.relations[${index}].toLabel`, 400, true),
      basis: choice(r.basis, TAKEOVER_RELATION_BASES, `${label}.relations[${index}].basis`),
      confidence: choice(r.confidence, TAKEOVER_RELATION_CONFIDENCES, `${label}.relations[${index}].confidence`),
      note: optionalText(r.note, `${label}.relations[${index}].note`, 2000),
      citationIds: citationIds(r.citationIds, `${label}.relations[${index}].citationIds`, knownCitations),
    };
  });
  const watchedEntries = array(o.watchedEntries, `${label}.watchedEntries`, TAKEOVER_BOUNDS.maxWatchedEntries).map((entry, index) => {
    const w = exact(entry, ['entryId', 'relativePath', 'bytes', 'modifiedAt', 'sha256'], `${label}.watchedEntries[${index}]`);
    return {
      entryId: id(w.entryId, `${label}.watchedEntries[${index}].entryId`),
      relativePath: relativePath(w.relativePath, `${label}.watchedEntries[${index}].relativePath`),
      bytes: integer(w.bytes, `${label}.watchedEntries[${index}].bytes`, 0, Number.MAX_SAFE_INTEGER),
      modifiedAt: w.modifiedAt === null || w.modifiedAt === undefined ? null : date(w.modifiedAt, `${label}.watchedEntries[${index}].modifiedAt`),
      sha256: w.sha256 === null || w.sha256 === undefined ? null : hex64(w.sha256, `${label}.watchedEntries[${index}].sha256`),
    };
  });
  let model: TakeoverSnapshot['model'] = null;
  if (o.model !== null && o.model !== undefined) {
    const m = exact(o.model, ['agentIdentity', 'modelIdentity'], `${label}.model`);
    model = { agentIdentity: text(m.agentIdentity, `${label}.model.agentIdentity`, 200, true), modelIdentity: text(m.modelIdentity, `${label}.model.modelIdentity`, 200, true) };
  }
  return {
    snapshotId: id(o.snapshotId, `${label}.snapshotId`),
    revision: integer(o.revision, `${label}.revision`, 1, Number.MAX_SAFE_INTEGER),
    researchId: o.researchId === null || o.researchId === undefined ? null : id(o.researchId, `${label}.researchId`),
    scanId: id(o.scanId, `${label}.scanId`),
    title: text(o.title, `${label}.title`, 300, true),
    currentFocus: text(o.currentFocus, `${label}.currentFocus`, 4000, true),
    materials,
    groups,
    known: strings(o.known, `${label}.known`, TAKEOVER_BOUNDS.maxItemsPerSection),
    unknown,
    relations,
    nextSteps: strings(o.nextSteps, `${label}.nextSteps`, TAKEOVER_BOUNDS.maxNextSteps),
    citations,
    watchedEntries,
    model,
    createdAt: date(o.createdAt, `${label}.createdAt`),
    updatedAt: date(o.updatedAt, `${label}.updatedAt`),
  };
}

function validateAdoption(raw: unknown, label: string): TakeoverAdoption {
  const o = exact(raw, ['adoptionId', 'requestHash', 'researchId', 'scanId', 'snapshotRevision', 'status', 'firstError', 'items', 'relations', 'plans', 'createdAt', 'updatedAt'], label);
  const items = array(o.items, `${label}.items`, 80).map((entry, index) => {
    const item = exact(entry, ['key', 'entryId', 'status', 'reason', 'sourceId', 'sha256', 'mode', 'knowledgeId', 'knowledgeVersion', 'nodeId'], `${label}.items[${index}]`);
    return {
      key: id(item.key, `${label}.items[${index}].key`),
      entryId: id(item.entryId, `${label}.items[${index}].entryId`),
      status: choice(item.status, ['published', 'skipped', 'conflict', 'metadata'] as const, `${label}.items[${index}].status`),
      reason: text(item.reason, `${label}.items[${index}].reason`, 2000),
      sourceId: item.sourceId === null ? null : id(item.sourceId, `${label}.items[${index}].sourceId`),
      sha256: item.sha256 === null ? null : hex64(item.sha256, `${label}.items[${index}].sha256`),
      mode: choice(item.mode, ['content', 'metadata_only', 'none'] as const, `${label}.items[${index}].mode`),
      knowledgeId: item.knowledgeId === null ? null : id(item.knowledgeId, `${label}.items[${index}].knowledgeId`),
      knowledgeVersion: item.knowledgeVersion === null ? null : integer(item.knowledgeVersion, `${label}.items[${index}].knowledgeVersion`, 1, 201),
      nodeId: item.nodeId === null ? null : id(item.nodeId, `${label}.items[${index}].nodeId`),
    };
  });
  const relations = array(o.relations, `${label}.relations`, 80).map((entry, index) => {
    const relation = exact(entry, ['key', 'status', 'reason'], `${label}.relations[${index}]`);
    return {
      key: id(relation.key, `${label}.relations[${index}].key`),
      status: choice(relation.status, ['knowledge_only', 'derived', 'skipped'] as const, `${label}.relations[${index}].status`),
      reason: text(relation.reason, `${label}.relations[${index}].reason`, 2000),
    };
  });
  const plans = array(o.plans, `${label}.plans`, 40).map((entry, index) => {
    const plan = exact(entry, ['title', 'draftId'], `${label}.plans[${index}]`);
    return { title: text(plan.title, `${label}.plans[${index}].title`, 300, true), draftId: plan.draftId === null ? null : id(plan.draftId, `${label}.plans[${index}].draftId`) };
  });
  let firstError: TakeoverAdoption['firstError'] = null;
  if (o.firstError !== null && o.firstError !== undefined) {
    const error = exact(o.firstError, ['code', 'message'], `${label}.firstError`);
    firstError = { code: text(error.code, `${label}.firstError.code`, 100, true), message: text(error.message, `${label}.firstError.message`, 2000, true) };
  }
  return {
    adoptionId: id(o.adoptionId, `${label}.adoptionId`),
    requestHash: hex64(o.requestHash, `${label}.requestHash`),
    researchId: o.researchId === null ? null : id(o.researchId, `${label}.researchId`),
    scanId: id(o.scanId, `${label}.scanId`),
    snapshotRevision: integer(o.snapshotRevision, `${label}.snapshotRevision`, 1, Number.MAX_SAFE_INTEGER),
    status: choice(o.status, ['saved', 'partial', 'blocked'] as const, `${label}.status`),
    firstError,
    items,
    relations,
    plans,
    createdAt: date(o.createdAt, `${label}.createdAt`),
    updatedAt: date(o.updatedAt, `${label}.updatedAt`),
  };
}

export function validateTakeoverRecord(raw: unknown, label = 'takeover'): TakeoverRecord {
  const peeked = record(raw, label);
  const fields = ['takeoverId', 'revision', 'researchId', 'title', 'roots', 'scopeNote', 'status', 'currentScanId', 'scans', 'snapshot', 'actorIdentity', 'firstError', 'createdAt', 'updatedAt'];
  if ('adoptions' in peeked) fields.push('adoptions');
  const o = exact(raw, fields, label);
  const scans = array(o.scans, `${label}.scans`, TAKEOVER_BOUNDS.maxScansPerTakeover).map((entry, index) => validateTakeoverScan(entry, `${label}.scans[${index}]`));
  if (scans.length === 0) invalid(`${label}.scans: at least one scan is required`);
  if (new Set(scans.map((scan) => scan.scanId)).size !== scans.length) invalid(`${label}.scans: duplicate scan identity`);
  const currentScanId = id(o.currentScanId, `${label}.currentScanId`);
  const current = scans.find((scan) => scan.scanId === currentScanId);
  if (!current) invalid(`${label}.currentScanId: must name one of the stored scans`);
  const snapshot = validateSnapshot(o.snapshot, `${label}.snapshot`);
  if (snapshot.scanId !== currentScanId) invalid(`${label}.snapshot.scanId: must be the current scan`);
  assertCitationsResolve(snapshot.citations, current, `${label}.snapshot`);
  const entryIds = new Set(current.entries.map((entry) => entry.entryId));
  for (const [index, group] of snapshot.groups.entries()) for (const entryId of group.entryIds) if (!entryIds.has(entryId)) invalid(`${label}.snapshot.groups[${index}]: unknown entry ${entryId}`);
  for (const [index, item] of snapshot.unknown.entries()) for (const entryId of item.entryIds) if (!entryIds.has(entryId)) invalid(`${label}.snapshot.unknown[${index}]: unknown entry ${entryId}`);
  for (const watched of snapshot.watchedEntries) if (!entryIds.has(watched.entryId)) invalid(`${label}.snapshot.watchedEntries: unknown entry ${watched.entryId}`);
  let firstError: TakeoverRecord['firstError'] = null;
  if (o.firstError !== null && o.firstError !== undefined) {
    const e = exact(o.firstError, ['code', 'message'], `${label}.firstError`);
    firstError = { code: text(e.code, `${label}.firstError.code`, 100, true), message: text(e.message, `${label}.firstError.message`, 2000, true) };
  }
  const roots = strings(o.roots, `${label}.roots`, 20, 400);
  if (roots.length === 0) invalid(`${label}.roots: at least one root is required`);
  return {
    takeoverId: id(o.takeoverId, `${label}.takeoverId`),
    revision: integer(o.revision, `${label}.revision`, 1, Number.MAX_SAFE_INTEGER),
    researchId: o.researchId === null || o.researchId === undefined ? null : id(o.researchId, `${label}.researchId`),
    title: text(o.title, `${label}.title`, 300, true),
    roots,
    scopeNote: optionalText(o.scopeNote, `${label}.scopeNote`, 2000),
    status: choice(o.status, ['draft', 'saved'] as const, `${label}.status`),
    currentScanId,
    scans,
    snapshot,
    actorIdentity: text(o.actorIdentity, `${label}.actorIdentity`, 200, true),
    firstError,
    adoptions: 'adoptions' in o ? array(o.adoptions, `${label}.adoptions`, 40).map((entry, index) => validateAdoption(entry, `${label}.adoptions[${index}]`)) : [],
    createdAt: date(o.createdAt, `${label}.createdAt`),
    updatedAt: date(o.updatedAt, `${label}.updatedAt`),
  };
}

export function validateTakeoverList(raw: unknown, label = 'takeovers'): TakeoverRecord[] {
  const list = array(raw, label, TAKEOVER_BOUNDS.maxTakeovers).map((entry, index) => validateTakeoverRecord(entry, `${label}[${index}]`));
  if (new Set(list.map((entry) => entry.takeoverId)).size !== list.length) invalid(`${label}: duplicate takeover identity`);
  return list;
}

/** Freshness verdict for one watched entry; computed on read, never stored as a claim. */
export interface TakeoverFreshness {
  stale: boolean;
  checked: number;
  changed: Array<{ entryId: string; relativePath: string; reason: 'missing' | 'size' | 'modified' | 'hash' }>;
  notChecked: number;
}

export const emptyTakeoverFreshness = (): TakeoverFreshness => ({ stale: false, checked: 0, changed: [], notChecked: 0 });

export interface TakeoverProjection {
  record: TakeoverRecord | null;
  freshness: TakeoverFreshness;
  counts: TakeoverScan['counts'] | null;
  scopeNote: string;
  roots: string[];
  truncated: boolean;
}
