/**
 * Batch 1 read-only takeover scanner.
 *
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-01-WORKER-PLAN-2026-10-16.md §2.1, §5 B1-01..B1-07.
 * Contract: ../contracts/research-takeover.ts (frozen).
 *
 * Hard rules implemented here:
 * - Read-only: only `readdirSync`, `lstatSync`, `statSync` and `readFileSync` ever touch the user's
 *   directory. Nothing is written, moved, renamed, chmod'd, spawned from the scanned tree, imported
 *   or evaluated.
 * - Symlinks are never followed (lstat only); they are registered as `skipped` with the real reason.
 * - Weights are metadata-only: no deserialization, no load, no execution, no invented hash.
 * - Budgets are real: exceeding one truncates the inventory and is reported through `truncated`
 *   plus an `errors` line, never silently presented as a complete scan.
 * - `.git` is never walked; git facts come from one bounded probe of the workspace root.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TAKEOVER_BOUNDS,
  TAKEOVER_ENTRY_KINDS,
  TakeoverError,
  isSafeRelativePath,
  validateTakeoverScan,
  type TakeoverEntry,
  type TakeoverEntryKind,
  type TakeoverKindBasis,
  type TakeoverScan,
} from '../contracts/research-takeover.ts';
import { sha256Hex } from '../domain/research-canonical.ts';
import { runEnvironmentProbes } from './research-bootstrap-environment.ts';

/** Kinds whose body this batch is allowed to read (Plan §2.1: markdown/txt, config, log, metrics). */
const READ_KINDS: ReadonlySet<TakeoverEntryKind> = new Set<TakeoverEntryKind>(['note', 'wiki', 'code', 'config', 'metric', 'log']);

const WEIGHT_EXTENSIONS: ReadonlySet<string> = new Set(['.pt', '.pth', '.ckpt', '.safetensors', '.bin', '.onnx', '.npy', '.npz', '.h5', '.pkl']);
const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar']);
const NOTE_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.markdown', '.rst', '.txt']);
const CODE_EXTENSIONS: ReadonlySet<string> = new Set(['.py', '.js', '.ts', '.tsx', '.jsx', '.ipynb', '.cpp', '.c', '.java', '.go', '.rs', '.sh']);
const CONFIG_EXTENSIONS: ReadonlySet<string> = new Set(['.yaml', '.yml', '.json', '.toml', '.ini', '.cfg']);
const METRIC_EXTENSIONS: ReadonlySet<string> = new Set(['.csv', '.tsv', '.jsonl', '.parquet']);
const LOG_EXTENSIONS: ReadonlySet<string> = new Set(['.log', '.out', '.err']);

const METRIC_NAME_HINTS = ['metrics', 'results', 'scores', 'log'] as const;

/** Dependency / cache / build directories excluded at any depth (Plan §2.1). */
const EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git',
  '.dsh',
  '.research',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.cache',
  '.idea',
  '.vscode',
  'dist',
  'build',
  '.next',
  'target',
];

/** Credential / secret exclusions, matched on the lowercase basename and on the relative path. */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [/^\.env/, /credential/, /secret/, /^\.npmrc$/, /^\.netrc$/, /^\.ssh$/];

/**
 * Exclusion rules that were actually applied, stored verbatim on every scan: a partial inventory
 * must be described as partial, so the rules are reported rather than kept private.
 */
export const TAKEOVER_DEFAULT_EXCLUSIONS: readonly string[] = [
  '.git/**',
  '.dsh/**',
  '.research/**',
  '**/node_modules/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/.pytest_cache/**',
  '**/.mypy_cache/**',
  '**/.cache/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/target/**',
  '**/.env*',
  '**/*credential*',
  '**/*secret*',
  '**/.npmrc',
  '**/.netrc',
  '**/.ssh/**',
  'symlinks are never followed',
];

export interface TakeoverScanOptions {
  /** Absolute workspace root. Comes from trusted host context, never from a request. */
  workspaceRoot: string;
  /** Workspace-relative posix roots, '.' allowed; must satisfy isSafeRelativePath. */
  roots: string[];
  scopeNote?: string;
  now?: () => Date;
  mint?: (prefix: string) => string;
  /** Optional injected PDF text extractor. Absent => pdf entries are metadata_only. */
  readPdfText?: (bytes: Uint8Array, name: string) => Promise<string[]>;
  /** Optional injected git probe; absent/absent-git => git:null with a gitNote. */
  gitProbe?: (workspaceRoot: string) => TakeoverScan['git'] | Promise<TakeoverScan['git']>;
}

const WEIGHT_REASON = '权重/张量文件只登记元数据：本批不反序列化、不加载、不执行';
const BUDGET_REASON = '读取字节预算已达上限，未读取正文';
const BINARY_REASON = '二进制内容，未摘录正文';
const EXCERPT_BUDGET_REASON = '摘录字符预算已达上限，该条目未摘录正文';
const SYMLINK_REASON = '符号链接未跟随（只读盘点不跨越链接）';

// ------------------------------------------------------------------ classification

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function extensionOf(posixPath: string): string {
  const base = posixPath.slice(posixPath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function nameHint(lowerPath: string, hints: readonly string[]): boolean {
  return hints.some((hint) => lowerPath.includes(hint));
}

/**
 * Preliminary classification: an extension or a directory name is a hint, never a conclusion.
 * Exported so other workers and tests pin the same table the scanner itself uses.
 */
export function classifyTakeoverEntry(relativePath: string, bytes: number): { kind: TakeoverEntryKind; kindBasis: TakeoverKindBasis } {
  void bytes;
  const posix = toPosix(relativePath);
  const extension = extensionOf(posix);
  const lower = posix.toLowerCase();
  const directory = posix.slice(0, Math.max(posix.lastIndexOf('/'), 0));

  if (extension === '.pdf') return { kind: 'paper', kindBasis: 'extension' };
  if (WEIGHT_EXTENSIONS.has(extension)) return { kind: 'weight', kindBasis: 'extension' };
  if (ARCHIVE_EXTENSIONS.has(extension)) return { kind: 'archive', kindBasis: 'extension' };
  if (NOTE_EXTENSIONS.has(extension)) {
    return lower.includes('wiki') ? { kind: 'wiki', kindBasis: 'directory' } : { kind: 'note', kindBasis: 'extension' };
  }
  if (METRIC_EXTENSIONS.has(extension)) {
    return { kind: 'metric', kindBasis: nameHint(lower, METRIC_NAME_HINTS) ? 'name' : 'extension' };
  }
  if (LOG_EXTENSIONS.has(extension)) return { kind: 'log', kindBasis: 'extension' };
  if (CODE_EXTENSIONS.has(extension)) return { kind: 'code', kindBasis: 'extension' };
  if (CONFIG_EXTENSIONS.has(extension)) return { kind: 'config', kindBasis: 'extension' };
  if (extension === '' && /(^|\/)(stdout|stderr)$/.test(lower)) return { kind: 'log', kindBasis: 'name' };
  if (extension === '' && nameHint(lower, METRIC_NAME_HINTS)) return { kind: 'metric', kindBasis: 'name' };
  if (directory.includes('wiki')) return { kind: 'wiki', kindBasis: 'directory' };
  return { kind: 'other', kindBasis: 'extension' };
}

// ------------------------------------------------------------------ traversal bookkeeping

interface ScanBudget {
  visited: number;
  registered: number;
  readBytes: number;
  excerptChars: number;
  pdfFiles: number;
  pdfBytes: number;
  truncated: boolean;
  errors: Array<{ relativePath: string; code: string; message: string }>;
}

function error(budget: ScanBudget, relativePath: string, code: string, message: string): void {
  if (budget.errors.length >= TAKEOVER_BOUNDS.maxErrorsPerScan) return;
  budget.errors.push({ relativePath, code, message });
}

/** A regular file whose body may still be read; `entryId` is minted during traversal. */
interface WorkItem {
  entryId: string;
  relativePath: string;
  absolutePath: string;
  stat: fs.Stats;
  kind: TakeoverEntryKind;
  kindBasis: TakeoverKindBasis;
}

/** An entry whose status is final at traversal time (symlink, weight, non-regular file). */
interface PlannedEntry {
  /** Number of `WorkItem`s that were queued before it, so the original order is reproduced. */
  position: number;
  entry: TakeoverEntry;
}

function isExcludedDirectory(name: string): boolean {
  return EXCLUDED_DIRECTORIES.includes(name);
}

function isCredential(relativePath: string, name: string): boolean {
  const lower = name.toLowerCase();
  const lowerPath = toPosix(relativePath).toLowerCase();
  return CREDENTIAL_PATTERNS.some((pattern) => pattern.test(lower) || pattern.test(lowerPath));
}

function safeMtime(stat: fs.Stats): string | null {
  if (!Number.isFinite(stat.mtimeMs)) return null;
  const date = new Date(stat.mtimeMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function failureReason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}

/** Truncates on a whole-line boundary and reports the surviving line range; null when no line fits. */
function buildExcerpt(text: string, maxChars: number): { excerpt: string; lineStart: number; lineEnd: number } | null {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const addition = kept.length === 0 ? line.length : line.length + 1;
    if (used + addition > maxChars) break;
    kept.push(line);
    used += addition;
  }
  if (kept.length === 0) return null;
  const excerpt = kept.join('\n');
  if (excerpt.trim().length === 0) return null;
  return { excerpt, lineStart: 1, lineEnd: kept.length };
}

interface ReadOutcome {
  readStatus: TakeoverEntry['readStatus'];
  readReason: string;
  hashStatus: TakeoverEntry['hashStatus'];
  sha256: string | null;
  excerpt: string | null;
  excerptLines: { lineStart: number; lineEnd: number } | null;
}

function metadataOnly(reason: string): ReadOutcome {
  return { readStatus: 'metadata_only', readReason: reason, hashStatus: 'not_computed', sha256: null, excerpt: null, excerptLines: null };
}

function failed(reason: string): ReadOutcome {
  return { readStatus: 'failed', readReason: reason, hashStatus: 'not_computed', sha256: null, excerpt: null, excerptLines: null };
}

// ------------------------------------------------------------------ bounded readers

async function readTextFile(item: WorkItem, budget: ScanBudget, limits: TakeoverScan['limits']): Promise<ReadOutcome> {
  const statSize = item.stat.size;
  if (statSize > limits.maxReadBytesPerFile) {
    return metadataOnly(`文件 ${statSize} 字节超过单文件读取上限 ${limits.maxReadBytesPerFile} 字节，只登记元数据`);
  }
  if (budget.readBytes + statSize > limits.maxReadBytes) return metadataOnly(BUDGET_REASON);
  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(item.absolutePath);
  } catch (readError) {
    const reason = failureReason(readError);
    error(budget, item.relativePath, 'READ_FAILED', `读取失败：${reason}`);
    return failed(reason);
  }
  if (buffer.length > statSize) {
    error(budget, item.relativePath, 'READ_FAILED', `文件大小在读取期间变化（stat ${statSize} 字节，read ${buffer.length} 字节）`);
    return metadataOnly('文件大小在读取期间变化，未摘录正文');
  }
  budget.readBytes += buffer.length;
  if (buffer.subarray(0, Math.min(buffer.length, 8 * 1024)).includes(0)) return metadataOnly(BINARY_REASON);
  if (budget.excerptChars >= TAKEOVER_BOUNDS.maxExcerptCharsPerScan) return metadataOnly(EXCERPT_BUDGET_REASON);
  const built = buildExcerpt(buffer.toString('utf8'), TAKEOVER_BOUNDS.maxExcerptChars);
  if (built === null) return metadataOnly('首行已超过摘录上限或正文为空，未摘录正文');
  if (budget.excerptChars + built.excerpt.length > TAKEOVER_BOUNDS.maxExcerptCharsPerScan) return metadataOnly(EXCERPT_BUDGET_REASON);
  budget.excerptChars += built.excerpt.length;
  return {
    readStatus: 'read',
    readReason: '',
    hashStatus: 'computed',
    sha256: sha256Hex(buffer),
    excerpt: built.excerpt,
    excerptLines: { lineStart: built.lineStart, lineEnd: built.lineEnd },
  };
}

async function readPdfFile(
  item: WorkItem,
  budget: ScanBudget,
  readPdfText: ((bytes: Uint8Array, name: string) => Promise<string[]>) | undefined,
): Promise<ReadOutcome> {
  if (readPdfText === undefined) return metadataOnly('未注入 PDF 文本提取器，本批不读取 PDF 正文');
  const statSize = item.stat.size;
  if (budget.pdfFiles >= TAKEOVER_BOUNDS.maxPdfFilesPerScan) {
    return metadataOnly(`PDF 提取文件数已达上限 ${TAKEOVER_BOUNDS.maxPdfFilesPerScan}，未提取正文`);
  }
  if (statSize > TAKEOVER_BOUNDS.maxPdfBytesPerFile) {
    return metadataOnly(`PDF ${statSize} 字节超过单文件上限 ${TAKEOVER_BOUNDS.maxPdfBytesPerFile} 字节，未提取正文`);
  }
  if (budget.pdfBytes + statSize > TAKEOVER_BOUNDS.maxPdfBytesPerScan) {
    return metadataOnly(`PDF 字节预算已达上限 ${TAKEOVER_BOUNDS.maxPdfBytesPerScan} 字节，未提取正文`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(item.absolutePath));
  } catch (readError) {
    const reason = failureReason(readError);
    error(budget, item.relativePath, 'READ_FAILED', `PDF 读取失败：${reason}`);
    return failed(reason);
  }
  budget.pdfFiles += 1;
  budget.pdfBytes += bytes.byteLength;
  let pages: string[];
  try {
    pages = await readPdfText(bytes, item.relativePath.slice(item.relativePath.lastIndexOf('/') + 1));
  } catch (extractError) {
    const reason = failureReason(extractError);
    error(budget, item.relativePath, 'READ_FAILED', `PDF 文本提取失败：${reason}`);
    return failed(reason);
  }
  const built = buildExcerpt((pages ?? []).join('\n'), TAKEOVER_BOUNDS.maxExcerptChars);
  if (built === null) return metadataOnly('PDF 未提取到可摘录文本');
  if (budget.excerptChars + built.excerpt.length > TAKEOVER_BOUNDS.maxExcerptCharsPerScan) return metadataOnly(EXCERPT_BUDGET_REASON);
  budget.excerptChars += built.excerpt.length;
  return {
    readStatus: 'read',
    readReason: '',
    hashStatus: 'not_computed',
    sha256: null,
    excerpt: built.excerpt,
    excerptLines: { lineStart: built.lineStart, lineEnd: built.lineEnd },
  };
}

// ------------------------------------------------------------------ git

async function probeGit(
  options: TakeoverScanOptions,
  resolvedRoot: string,
): Promise<{ git: TakeoverScan['git']; note: string }> {
  if (options.gitProbe) {
    try {
      const git = await options.gitProbe(resolvedRoot);
      return { git: git ?? null, note: git ? 'git 信息由注入的 gitProbe 提供' : '注入的 gitProbe 未返回 git 信息' };
    } catch (probeError) {
      return { git: null, note: `注入的 gitProbe 失败：${failureReason(probeError)}` };
    }
  }
  try {
    // Reuses the existing bounded repo probe (`git -C <workspaceRoot> …`); the scanner itself never
    // walks `.git`.
    const observations = await runEnvironmentProbes({ workspaceRoot: resolvedRoot, include: ['repo_summary'] });
    const summary = observations.find((observation) => observation.probe === 'repo_summary');
    if (!summary || summary.status !== 'observed' || summary.value === null) {
      return { git: null, note: `git 探测未完成：${summary?.error?.message ?? summary?.status ?? 'no repo_summary observation'}` };
    }
    const value = summary.value as { git?: { insideWorkTree: boolean; headHash: string | null; dirtyEntryCount: number } | null; gitNote?: string };
    if (!value.git) return { git: null, note: value.gitNote ?? '未获得 git 信息' };
    return {
      git: {
        insideWorkTree: value.git.insideWorkTree === true,
        headHash: value.git.headHash ?? null,
        dirtyEntryCount: Number(value.git.dirtyEntryCount ?? 0),
      },
      note: value.gitNote ?? 'git 信息来自既有 repo_summary 环境探针（git rev-parse / HEAD / status）',
    };
  } catch (probeError) {
    return { git: null, note: `git 探测失败：${failureReason(probeError)}` };
  }
}

// ------------------------------------------------------------------ entry point

function resolveRoot(workspaceRoot: string, root: string): string {
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolved = root === '.' ? resolvedWorkspace : path.resolve(resolvedWorkspace, root);
  const relative = path.relative(resolvedWorkspace, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new TakeoverError('INVALID_INPUT', `roots 必须位于工作区之内：${root}`);
  }
  return resolved;
}

function buildCounts(entries: readonly TakeoverEntry[]): TakeoverScan['counts'] {
  const byKind = {} as Record<TakeoverEntryKind, number>;
  for (const kind of TAKEOVER_ENTRY_KINDS) byKind[kind] = 0;
  let read = 0;
  let metadata = 0;
  let skipped = 0;
  let failedCount = 0;
  let notRead = 0;
  let totalBytes = 0;
  let hashed = 0;
  for (const entry of entries) {
    byKind[entry.kind] += 1;
    if (entry.readStatus === 'read') read += 1;
    else if (entry.readStatus === 'metadata_only') metadata += 1;
    else if (entry.readStatus === 'skipped') skipped += 1;
    else if (entry.readStatus === 'failed') failedCount += 1;
    else notRead += 1;
    totalBytes += entry.bytes;
    if (entry.hashStatus === 'computed') hashed += 1;
  }
  return { total: entries.length, byKind, read, metadataOnly: metadata, skipped, failed: failedCount, notRead, totalBytes, hashed };
}

export async function scanTakeoverDirectory(options: TakeoverScanOptions): Promise<TakeoverScan> {
  if (typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim().length === 0) {
    throw new TakeoverError('INVALID_INPUT', 'workspaceRoot is required');
  }
  if (!Array.isArray(options.roots) || options.roots.length === 0) {
    throw new TakeoverError('INVALID_INPUT', 'roots: at least one root is required');
  }
  if (options.roots.length > 20) {
    throw new TakeoverError('INVALID_INPUT', `roots: at most 20 roots are supported (received ${options.roots.length})`);
  }
  for (const root of options.roots) {
    if (typeof root !== 'string' || (root !== '.' && !isSafeRelativePath(root))) {
      throw new TakeoverError('INVALID_INPUT', `roots: "${String(root)}" must be workspace-relative without traversal`);
    }
  }

  const now = options.now ?? (() => new Date());
  const mint = options.mint ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
  const startedAt = now().toISOString();
  const resolvedRoots = options.roots.map((root) => resolveRoot(options.workspaceRoot, root));

  const limits: TakeoverScan['limits'] = {
    maxVisited: TAKEOVER_BOUNDS.maxScanVisited,
    maxDepth: TAKEOVER_BOUNDS.maxScanDepth,
    maxEntries: TAKEOVER_BOUNDS.maxEntriesPerScan,
    maxReadBytesPerFile: TAKEOVER_BOUNDS.maxReadBytesPerFile,
    maxReadBytes: TAKEOVER_BOUNDS.maxReadBytesPerScan,
  };

  const budget: ScanBudget = { visited: 0, registered: 0, readBytes: 0, excerptChars: 0, pdfFiles: 0, pdfBytes: 0, truncated: false, errors: [] };
  const items: WorkItem[] = [];
  const planned: PlannedEntry[] = [];
  let entrySeq = 0;
  const nextEntryId = (): string => `takeover-entry-${String(++entrySeq).padStart(5, '0')}`;

  const register = (relativePath: string): string | null => {
    if (budget.registered >= limits.maxEntries) {
      budget.truncated = true;
      error(budget, relativePath, 'LIMIT_ENTRIES', `登记条目数达到 maxEntriesPerScan=${limits.maxEntries}，该条目及其余条目未登记（扫描结果不完整）`);
      return null;
    }
    budget.registered += 1;
    return nextEntryId();
  };

  const visitDirectory = (absoluteDir: string, relativeDir: string, depth: number): void => {
    if (budget.truncated) return;
    if (depth > limits.maxDepth) {
      budget.truncated = true;
      error(budget, relativeDir === '' ? '.' : relativeDir, 'LIMIT_DEPTH', `目录深度超过 maxScanDepth=${limits.maxDepth}，该子树未继续扫描（扫描结果不完整）`);
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch (readError) {
      error(budget, relativeDir === '' ? '.' : relativeDir, 'READ_FAILED', `目录读取失败：${failureReason(readError)}`);
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      if (budget.truncated) return;
      const relativePath = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
      const absolutePath = path.join(absoluteDir, dirent.name);

      if (dirent.isDirectory()) {
        if (isExcludedDirectory(dirent.name) || isCredential(relativePath, dirent.name)) continue;
        budget.visited += 1;
        if (budget.visited > limits.maxVisited) {
          budget.truncated = true;
          error(budget, relativePath, 'LIMIT_VISITED', `访问条目数达到 maxScanVisited=${limits.maxVisited}，扫描中止（扫描结果不完整）`);
          return;
        }
        visitDirectory(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (isCredential(relativePath, dirent.name)) continue;
      budget.visited += 1;
      if (budget.visited > limits.maxVisited) {
        budget.truncated = true;
        error(budget, relativePath, 'LIMIT_VISITED', `访问条目数达到 maxScanVisited=${limits.maxVisited}，扫描中止（扫描结果不完整）`);
        return;
      }

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch (statError) {
        error(budget, relativePath, 'READ_FAILED', `stat 失败：${failureReason(statError)}`);
        continue;
      }
      const { kind, kindBasis } = classifyTakeoverEntry(relativePath, stat.size);
      const entryId = register(relativePath);
      if (entryId === null) return;
      const position = items.length;

      if (stat.isSymbolicLink()) {
        error(budget, relativePath, 'SOURCE_SYMLINK', SYMLINK_REASON);
        planned.push({
          position,
          entry: {
            entryId,
            relativePath,
            kind,
            kindBasis,
            bytes: stat.size,
            hashStatus: 'not_computed',
            sha256: null,
            readStatus: 'skipped',
            readReason: SYMLINK_REASON,
            modifiedAt: null,
            excerpt: null,
            excerptLines: null,
            duplicateOf: null,
            sourceIdentity: { kind: 'path', value: relativePath },
          },
        });
        continue;
      }
      if (!stat.isFile()) {
        planned.push({
          position,
          entry: {
            entryId,
            relativePath,
            kind,
            kindBasis,
            bytes: stat.size,
            hashStatus: 'not_computed',
            sha256: null,
            readStatus: 'metadata_only',
            readReason: '非普通文件（设备/管道/套接字等），只登记元数据',
            modifiedAt: safeMtime(stat),
            excerpt: null,
            excerptLines: null,
            duplicateOf: null,
            sourceIdentity: { kind: 'path', value: relativePath },
          },
        });
        continue;
      }
      if (kind === 'weight') {
        planned.push({
          position,
          entry: {
            entryId,
            relativePath,
            kind,
            kindBasis,
            bytes: stat.size,
            hashStatus: 'not_computed',
            sha256: null,
            readStatus: 'metadata_only',
            readReason: WEIGHT_REASON,
            modifiedAt: safeMtime(stat),
            excerpt: null,
            excerptLines: null,
            duplicateOf: null,
            sourceIdentity: { kind: 'path', value: relativePath },
          },
        });
        continue;
      }
      items.push({ entryId, relativePath, absolutePath, stat, kind, kindBasis });
    }
  };

  for (const [index, absoluteRoot] of resolvedRoots.entries()) {
    const root = toPosix(options.roots[index] ?? '.');
    visitDirectory(absoluteRoot, root === '.' ? '' : root, 1);
  }

  // Second pass: bodies are read in traversal order, so `duplicateOf` always names the first entry.
  const entries: TakeoverEntry[] = [];
  const byContentHash = new Map<string, string>();
  let cursor = 0;
  for (const [position, item] of items.entries()) {
    while (cursor < planned.length && planned[cursor]!.position === position) {
      entries.push(planned[cursor]!.entry);
      cursor += 1;
    }
    let outcome: ReadOutcome;
    if (item.kind === 'paper') outcome = await readPdfFile(item, budget, options.readPdfText);
    else if (READ_KINDS.has(item.kind)) outcome = await readTextFile(item, budget, limits);
    else outcome = metadataOnly(item.kind === 'archive' ? '压缩包未在本批展开，只登记元数据' : '该类型不在本批读取范围内，只登记元数据');

    let duplicateOf: string | null = null;
    if (outcome.hashStatus === 'computed' && outcome.sha256 !== null) {
      const first = byContentHash.get(outcome.sha256);
      if (first === undefined) byContentHash.set(outcome.sha256, item.entryId);
      else duplicateOf = first;
    }
    entries.push({
      entryId: item.entryId,
      relativePath: item.relativePath,
      kind: item.kind,
      kindBasis: item.kindBasis,
      bytes: item.stat.size,
      hashStatus: outcome.hashStatus,
      sha256: outcome.sha256,
      readStatus: outcome.readStatus,
      readReason: outcome.readReason,
      modifiedAt: safeMtime(item.stat),
      excerpt: outcome.excerpt,
      excerptLines: outcome.excerptLines,
      duplicateOf,
      sourceIdentity:
        outcome.hashStatus === 'computed' && outcome.sha256 !== null
          ? { kind: 'content', value: outcome.sha256 }
          : { kind: 'path', value: item.relativePath },
    });
  }
  for (; cursor < planned.length; cursor += 1) entries.push(planned[cursor]!.entry);

  const { git, note } = await probeGit(options, path.resolve(options.workspaceRoot));
  const finishedAt = now().toISOString();

  const result: TakeoverScan = {
    scanId: mint('takeover-scan'),
    roots: [...options.roots],
    scopeNote: options.scopeNote ?? '',
    startedAt,
    finishedAt,
    limits,
    exclusions: [...TAKEOVER_DEFAULT_EXCLUSIONS],
    visitedCount: budget.visited,
    truncated: budget.truncated,
    entries,
    counts: buildCounts(entries),
    git,
    gitNote: note,
    errors: budget.errors,
  };
  return validateTakeoverScan(result);
}
