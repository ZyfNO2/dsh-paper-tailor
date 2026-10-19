/**
 * Patch Workspace: applies a bounded unified-diff adaptation to a THROWAWAY COPY of a pinned
 * source tree, records every repair attempt, and emits the full original-vs-adapted diff.
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md sections 1, 2 and 5.
 *   - "source checkout 与 patch 工作区分离" — the source checkout and the patch workspace are
 *     separate directories; this module never writes inside the source checkout.
 *   - "代码生成/修复不能修改 evaluator、来源原件、预算、test 数据与禁写路径" — the path policy is
 *     evaluated for the WHOLE patch before a single byte is written.
 *   - "保存完整 diff，避免仅有最终代码却无法说明适配" — fullDiff() returns the complete
 *     original-vs-adapted diff, not just the final code.
 *   - "不无限自修复" — maxRepairAttempts is a hard stop; the first error is kept.
 *
 * Everything here is local file work: no network, no model calls, Node built-ins only.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { typedHash, sha256Hex, canonicalJsonV1 } from './research-canonical.ts';
import {
  ExperimentError,
  type ArtifactRef,
  type ImplementationSnapshot,
  type MechanismDiffEntry,
  computeImplementationHash,
  implementationBody,
  validateImplementationSnapshot,
} from '../contracts/experiments.ts';

// ----------------- Layout -----------------

/** Disposable work copies live here; published artifacts live under artifacts/research-execution. */
export const WORK_DIR_ROOT_DEFAULT = 'work/research-execution';

/** Hash domains. Timestamps are excluded from every hashed body (architecture section 4). */
export const WORKSPACE_HASH_DOMAINS = {
  sourceTree: 'experiment-source-tree',
  codeTree: 'experiment-code-tree',
  patchAttempt: 'experiment-patch-attempt',
  fullDiff: 'experiment-patch-full-diff',
} as const;

/**
 * Paths a patch may NEVER touch, regardless of what a plan or a caller says. This list is
 * fail-closed and cannot be widened by an AdaptationPlan: the evaluator, the sealed/gold data,
 * the held-out test split, the budget and the isolation policy are not adaptation surface.
 */
export const ALWAYS_FORBIDDEN_PATTERNS: readonly string[] = [
  'evaluator',
  'evaluator/**',
  '**/evaluator',
  '**/evaluator/**',
  '**/evaluator.py',
  '**/evaluate.py',
  '**/evaluation/**',
  'data/sealed',
  'data/sealed/**',
  '**/gold',
  '**/gold/**',
  '**/review',
  '**/review/**',
  '**/test',
  '**/test/**',
  '**/tests',
  '**/tests/**',
  '**/test_split',
  '**/test_split/**',
  '**/test-split/**',
  // Test-split DATA files carry no directory named "test", so the naming conventions below are
  // covered too: `data/split/test_ids.txt` is a held-out split even though its parent is "split".
  '**/test_*',
  '**/test-*',
  '**/test.*',
  '**/split/test*',
  'budget.json',
  'budget',
  'budget/**',
  '**/budget.json',
  '**/budget/**',
  'isolation',
  'isolation/**',
  '.git',
  '.git/**',
  // A nested repository (submodule, vendored checkout) is just as off-limits as the root one.
  '**/.git',
  '**/.git/**',
];

// ----------------- Types -----------------

export type TreeEntryKind = 'file' | 'symlink';

/** One pinned file in a source checkout or in the adapted workspace. */
export interface SourceFilePin {
  /** POSIX-style path relative to the tree root. */
  path: string;
  sha256: string;
  bytes: number;
  kind: TreeEntryKind;
}

export interface PatchPolicy {
  /** Non-empty. A patch may only touch paths covered by these patterns. */
  allowedPaths: string[];
  /** Optional extra denials, on top of ALWAYS_FORBIDDEN_PATTERNS. */
  forbiddenPaths?: string[];
}

export type PatchAttemptOutcome = 'applied' | 'rejected' | 'failed';

/**
 * One repair round. Recorded for BOTH outcomes: a rejected patch is evidence about the
 * adaptation, and the first error is kept instead of being overwritten by later retries.
 */
export interface PatchAttemptRecord {
  /** 1-based submission index. Index 1 is the initial submission, 2+ are repairs. */
  attemptIndex: number;
  isRepair: boolean;
  label: string;
  patchSha256: string;
  outcome: PatchAttemptOutcome;
  errorCode: string | null;
  message: string | null;
  /** Every path the patch named, even when it was rejected. */
  targetPaths: string[];
  /** Paths actually written. Empty for a rejected patch — policy is checked before any write. */
  writtenPaths: string[];
  /** Excluded from attemptHash: a run timestamp is not part of the identity. */
  recordedAt: string;
  attemptHash: string;
}

export interface PatchApplyReport {
  outcome: PatchAttemptOutcome;
  record: PatchAttemptRecord;
  targetPaths: string[];
  writtenPaths: string[];
  /** Full original-vs-adapted diff after a successful apply; null otherwise. */
  diff: string | null;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'deleted' | 'modified';
  addedLines: number;
  removedLines: number;
  diff: string;
}

export interface FullDiffReport {
  text: string;
  entries: DiffEntry[];
  changedPaths: string[];
  /** Paths that differ but are not covered by allowedPaths: a policy breach to investigate. */
  unexpectedPaths: string[];
  diffHash: string;
}

export interface PatchWorkspaceOptions {
  taskId: string;
  /**
   * Absolute (or cwd-relative) path of the PINNED source checkout. It is read once and never
   * written. Pass the pinned subtree, not the repository root: the workspace must not be nested
   * inside it.
   */
  sourceRoot: string;
  /** Defaults to `work/research-execution`. The workspace is `<workRoot>/<taskId>/patch-workspace`. */
  workRoot?: string;
  workspaceName?: string;
  /** When supplied, every pinned file is hash-verified after the copy. */
  sourcePins?: readonly SourceFilePin[];
  policy: PatchPolicy;
  /** Hard stop. 0 means "no repair rounds": exactly one submission is allowed. */
  maxRepairAttempts?: number;
  /** Replace an existing workspace directory instead of refusing to overwrite it. */
  reset?: boolean;
}

export interface ParsedHunkEntry {
  kind: ' ' | '-' | '+';
  /** File-line text: it keeps its trailing "\n" unless the patch declares no final newline. */
  text: string;
  noNewline: boolean;
}

export interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  entries: ParsedHunkEntry[];
}

export interface ParsedFilePatch {
  /** null when the patch creates the file (`--- /dev/null`). */
  oldPath: string | null;
  /** null when the patch deletes the file (`+++ /dev/null`). */
  newPath: string | null;
  hunks: ParsedHunk[];
}

export interface ParsedPatch {
  files: ParsedFilePatch[];
  patchSha256: string;
}

// ----------------- Path policy -----------------

/** Normalizes a policy/relative path to POSIX form without a leading "./". */
function toPosixRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function matchSegment(name: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return name === pattern;
  const escaped = pattern
    .split('')
    .map((ch) => {
      if (ch === '*') return '.*';
      if (ch === '?') return '.';
      return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${escaped}$`).test(name);
}

function matchSegments(pathSegs: readonly string[], patSegs: readonly string[]): boolean {
  if (patSegs.length === 0) return pathSegs.length === 0;
  const [head, ...tail] = patSegs;
  if (head === '**') {
    for (let i = 0; i <= pathSegs.length; i += 1) {
      if (matchSegments(pathSegs.slice(i), tail)) return true;
    }
    return false;
  }
  if (pathSegs.length === 0) return false;
  if (!matchSegment(pathSegs[0], head)) return false;
  return matchSegments(pathSegs.slice(1), tail);
}

/**
 * True when `pattern` matches the path itself or any of its ancestor directories, so
 * `evaluator` also covers `evaluator/score.py` and `src/**` covers `src/a/b.py`.
 *
 * `caseInsensitive` defaults to false. The always-forbidden check passes true, because Windows
 * (this project's platform) resolves `EVALUATOR/score.py` and `evaluator/score.py` to the SAME
 * file: a case-sensitive deny list would be a real bypass, not a theoretical one.
 */
export function matchesPathPattern(relPath: string, pattern: string, caseInsensitive = false): boolean {
  const rel = toPosixRelative(relPath);
  const pat = toPosixRelative(pattern);
  if (pat.length === 0) return false;
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const pathSegs = fold(rel).split('/').filter((s) => s.length > 0);
  const patSegs = fold(pat).split('/').filter((s) => s.length > 0);
  for (let depth = 1; depth <= pathSegs.length; depth += 1) {
    if (matchSegments(pathSegs.slice(0, depth), patSegs)) return true;
  }
  return false;
}

export function isPathCovered(relPath: string, patterns: readonly string[], caseInsensitive = false): boolean {
  return patterns.some((pattern) => matchesPathPattern(relPath, pattern, caseInsensitive));
}

/** Deny-list check. Case-insensitive by design; see `matchesPathPattern`. */
export function isAlwaysForbidden(relPath: string): boolean {
  return isPathCovered(relPath, ALWAYS_FORBIDDEN_PATTERNS, true);
}

/**
 * Turns a patch header target into a safe workspace-relative POSIX path.
 * Rejects absolute paths, drive letters, UNC prefixes, `..` traversal, NTFS alternate data
 * streams (`file.py:stream`) and NUL bytes. Nothing here touches the disk.
 */
export function normalizePatchTarget(rawTarget: string): string {
  if (typeof rawTarget !== 'string') {
    throw new ExperimentError('INVALID_INPUT', 'Patch target must be a string', {
      fieldPaths: ['patch.target'],
    });
  }
  // Strip a trailing tab-separated timestamp, as produced by `diff -u`.
  let value = rawTarget.split('\t')[0].trim();
  if (value.length === 0) {
    throw new ExperimentError('POLICY_DENIED', 'Patch names an empty target path', {
      fieldPaths: ['patch.target'],
    });
  }
  if (value.includes('\0')) {
    throw new ExperimentError('POLICY_DENIED', 'Patch target contains a NUL byte', {
      fieldPaths: ['patch.target'],
    });
  }
  // git's a/ b/ prefixes are stripped FIRST, so `a/F:/abs/path` is still diagnosed as absolute
  // rather than being mistaken for a relative path that happens to contain a colon.
  if (value.startsWith('a/') || value.startsWith('b/')) value = value.slice(2);
  while (value.startsWith('./')) value = value.slice(2);

  if (/^[A-Za-z]:/.test(value)) {
    throw new ExperimentError('POLICY_DENIED', `Patch target must be workspace-relative, got drive path "${value}"`, {
      fieldPaths: ['patch.target'],
    });
  }
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    throw new ExperimentError('POLICY_DENIED', `Patch target must not be a UNC path: "${value}"`, {
      fieldPaths: ['patch.target'],
    });
  }
  if (value.startsWith('/') || value.startsWith('\\')) {
    throw new ExperimentError('POLICY_DENIED', `Patch target must not be absolute: "${rawTarget}"`, {
      fieldPaths: ['patch.target'],
    });
  }
  value = value.replace(/\\/g, '/');

  const rawSegments = value.split('/');
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (segment.length === 0 || segment === '.') continue;
    if (segment === '..') {
      // Resolve instead of blanket-rejecting: `modules/../model.py` stays inside the workspace and
      // is a legitimate patch target. Only a `..` that pops past the root escapes.
      if (segments.length === 0) {
        throw new ExperimentError(
          'POLICY_DENIED',
          `Patch target escapes the workspace root via "..": "${rawTarget}"`,
          { fieldPaths: ['patch.target'] }
        );
      }
      segments.pop();
      continue;
    }
    if (segment.includes(':')) {
      throw new ExperimentError(
        'POLICY_DENIED',
        `Patch target uses an alternate data stream: "${rawTarget}"`,
        { fieldPaths: ['patch.target'] }
      );
    }
    if (segment.includes('\0')) {
      throw new ExperimentError('POLICY_DENIED', 'Patch target contains a NUL byte', {
        fieldPaths: ['patch.target'],
      });
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    throw new ExperimentError('POLICY_DENIED', `Patch target resolves to the workspace root: "${rawTarget}"`, {
      fieldPaths: ['patch.target'],
    });
  }
  return segments.join('/');
}

/**
 * Enforces the full path policy for a parsed patch. Runs to completion BEFORE any write, so a
 * patch that touches one forbidden file never writes its other, allowed files.
 * Returns the sorted list of target paths it approved.
 */
export function assertPatchPolicy(parsed: ParsedPatch, policy: PatchPolicy): string[] {
  if (!Array.isArray(policy.allowedPaths) || policy.allowedPaths.length === 0) {
    throw new ExperimentError('POLICY_DENIED', 'allowedPaths may not be empty: nothing may be adapted', {
      fieldPaths: ['policy.allowedPaths'],
    });
  }
  const forbidden = policy.forbiddenPaths ?? [];
  const targets: string[] = [];
  for (const file of parsed.files) {
    for (const target of [file.oldPath, file.newPath]) {
      if (target === null) continue;
      targets.push(target);
      if (isAlwaysForbidden(target)) {
        throw new ExperimentError(
          'POLICY_DENIED',
          `Patch touches a permanently protected path: "${target}"`,
          { fieldPaths: ['patch.target'] }
        );
      }
      if (isPathCovered(target, forbidden, true)) {
        throw new ExperimentError('POLICY_DENIED', `Patch touches a forbidden path: "${target}"`, {
          fieldPaths: ['patch.target'],
        });
      }
      if (!isPathCovered(target, policy.allowedPaths)) {
        throw new ExperimentError('POLICY_DENIED', `Patch touches a path outside allowedPaths: "${target}"`, {
          fieldPaths: ['patch.target'],
        });
      }
    }
  }
  return Array.from(new Set(targets)).sort();
}

/**
 * The workspace root and the source checkout must be disjoint: neither may contain the other.
 *
 * Comparison is done on REAL paths and folds case on Windows. A plain string compare is not
 * enough: `F:\work\x` and `F:\WORK\X` are the same directory on this platform, so a
 * case-sensitive check would let a caller "separate" two roots that are actually one.
 */
export function assertSeparateRoots(sourceRoot: string, workspaceRoot: string): void {
  const canonical = (value: string): string => {
    let resolved = path.resolve(value);
    try {
      // realpathSync also resolves junctions/symlinks in the ancestors, which is what containment
      // actually means to the filesystem.
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // The path does not exist yet (a workspace about to be created): the lexical resolve stands.
    }
    if (process.platform === 'win32') resolved = resolved.toLowerCase();
    return resolved.replace(/[\\/]+$/, '');
  };
  const source = canonical(sourceRoot);
  const workspace = canonical(workspaceRoot);
  const sourceDisplay = path.resolve(sourceRoot);
  const workspaceDisplay = path.resolve(workspaceRoot);

  if (source === workspace) {
    throw new ExperimentError(
      'POLICY_DENIED',
      `Source checkout and patch workspace are the same directory: ${sourceDisplay}`,
      { fieldPaths: ['workspaceRoot'] }
    );
  }
  const contains = (outer: string, inner: string): boolean => inner.startsWith(outer + path.sep) || inner.startsWith(outer + '/');
  if (contains(source, workspace)) {
    throw new ExperimentError(
      'POLICY_DENIED',
      `Patch workspace must not live inside the source checkout (${workspaceDisplay} is inside ${sourceDisplay})`,
      { fieldPaths: ['workspaceRoot'] }
    );
  }
  if (contains(workspace, source)) {
    throw new ExperimentError(
      'POLICY_DENIED',
      `Source checkout must not live inside the patch workspace (${sourceDisplay} is inside ${workspaceDisplay})`,
      { fieldPaths: ['sourceRoot'] }
    );
  }
}

// ----------------- Tree hashing -----------------

function walkTree(rootDir: string, current = ''): SourceFilePin[] {
  const absDir = current.length === 0 ? rootDir : path.join(rootDir, current);
  const pins: SourceFilePin[] = [];
  const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = current.length === 0 ? entry.name : `${current}/${entry.name}`;
    const abs = path.join(rootDir, rel);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) {
      pins.push({
        path: rel,
        sha256: sha256Hex(fs.readlinkSync(abs)),
        bytes: 0,
        kind: 'symlink',
      });
      continue;
    }
    if (stat.isDirectory()) {
      pins.push(...walkTree(rootDir, rel));
      continue;
    }
    if (stat.isFile()) {
      const bytes = fs.readFileSync(abs);
      pins.push({ path: rel, sha256: sha256Hex(bytes), bytes: bytes.length, kind: 'file' });
      continue;
    }
    throw new ExperimentError('SOURCE_MISMATCH', `Unsupported file type in tree: ${abs}`);
  }
  return pins;
}

/** Sorted content manifest of a tree. Symlinks are recorded, never followed. */
export function hashFileTree(rootDir: string): SourceFilePin[] {
  const root = path.resolve(rootDir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new ExperimentError('NOT_FOUND', `Tree root is not a directory: ${root}`);
  }
  return walkTree(root);
}

export function treeHash(pins: readonly SourceFilePin[]): string {
  const body = pins
    .map((pin) => ({ path: pin.path, sha256: pin.sha256, bytes: pin.bytes, kind: pin.kind }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return typedHash(WORKSPACE_HASH_DOMAINS.sourceTree, { entries: body });
}

// ----------------- Unified diff: shared line model -----------------

/**
 * File lines KEEP their trailing "\n" (git's own model), so a missing final newline is a real
 * line-content difference and `join('')` is byte-exact.
 */
export function toFileLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/(?<=\n)/);
}

export function fromFileLines(lines: readonly string[]): string {
  return lines.join('');
}

type DiffOp = { type: ' ' | '-' | '+'; text: string; aIndex: number | null; bIndex: number | null };

const MAX_LCS_CELLS = 4_000_000;

function diffOps(a: readonly string[], b: readonly string[]): DiffOp[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > prefix && endB > prefix && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(prefix, endA);
  const midB = b.slice(prefix, endB);
  const ops: DiffOp[] = [];
  for (let i = 0; i < prefix; i += 1) ops.push({ type: ' ', text: a[i], aIndex: i, bIndex: i });

  if (midA.length * midB.length > MAX_LCS_CELLS) {
    // Deterministic fallback for huge blocks: a whole-block replacement is still a valid diff.
    midA.forEach((text, i) => ops.push({ type: '-', text, aIndex: prefix + i, bIndex: null }));
    midB.forEach((text, i) => ops.push({ type: '+', text, aIndex: null, bIndex: prefix + i }));
  } else {
    const n = midA.length;
    const m = midB.length;
    const width = m + 1;
    const dp = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        dp[i * width + j] =
          midA[i] === midB[j]
            ? dp[(i + 1) * width + (j + 1)] + 1
            : Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ type: ' ', text: midA[i], aIndex: prefix + i, bIndex: prefix + j });
        i += 1;
        j += 1;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + (j + 1)]) {
        ops.push({ type: '-', text: midA[i], aIndex: prefix + i, bIndex: null });
        i += 1;
      } else {
        ops.push({ type: '+', text: midB[j], aIndex: null, bIndex: prefix + j });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ type: '-', text: midA[i], aIndex: prefix + i, bIndex: null });
      i += 1;
    }
    while (j < m) {
      ops.push({ type: '+', text: midB[j], aIndex: null, bIndex: prefix + j });
      j += 1;
    }
  }
  for (let k = 0; k < a.length - endA; k += 1) {
    ops.push({ type: ' ', text: a[endA + k], aIndex: endA + k, bIndex: endB + k });
  }
  return ops;
}

function lastIndexWhere<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) if (predicate(items[i])) return i;
  return -1;
}

function buildHunks(ops: readonly DiffOp[], context = 3): ParsedHunk[] {
  const changeIdx: number[] = [];
  ops.forEach((op, i) => {
    if (op.type !== ' ') changeIdx.push(i);
  });
  if (changeIdx.length === 0) return [];

  const groups: Array<[number, number]> = [];
  let start = changeIdx[0];
  let end = changeIdx[0];
  for (const idx of changeIdx.slice(1)) {
    if (idx - end <= 2 * context) {
      end = idx;
    } else {
      groups.push([start, end]);
      start = idx;
      end = idx;
    }
  }
  groups.push([start, end]);

  const aBefore = new Array<number>(ops.length + 1).fill(0);
  const bBefore = new Array<number>(ops.length + 1).fill(0);
  for (let i = 0; i < ops.length; i += 1) {
    aBefore[i + 1] = aBefore[i] + (ops[i].type !== '+' ? 1 : 0);
    bBefore[i + 1] = bBefore[i] + (ops[i].type !== '-' ? 1 : 0);
  }

  return groups.map(([groupStart, groupEnd]) => {
    const from = Math.max(0, groupStart - context);
    const to = Math.min(ops.length - 1, groupEnd + context);
    const slice = ops.slice(from, to + 1);
    const entries: ParsedHunkEntry[] = slice.map((op) => ({
      kind: op.type,
      text: op.text,
      noNewline: false,
    }));
    const oldCount = slice.filter((op) => op.type !== '+').length;
    const newCount = slice.filter((op) => op.type !== '-').length;
    const oldStart = aBefore[from] + (oldCount > 0 ? 1 : 0);
    const newStart = bBefore[from] + (newCount > 0 ? 1 : 0);
    // A line without a trailing "\n" can only be a file's last line, so the marker follows it.
    const lastOld = lastIndexWhere(entries, (entry) => entry.kind !== '+');
    const lastNew = lastIndexWhere(entries, (entry) => entry.kind !== '-');
    if (lastOld >= 0 && !entries[lastOld].text.endsWith('\n')) entries[lastOld].noNewline = true;
    if (lastNew >= 0 && !entries[lastNew].text.endsWith('\n')) entries[lastNew].noNewline = true;
    return { oldStart, oldCount, newStart, newCount, entries };
  });
}

function renderHunk(hunk: ParsedHunk): string[] {
  const out: string[] = [`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`];
  for (const entry of hunk.entries) {
    const body = entry.text.endsWith('\n') ? entry.text.slice(0, -1) : entry.text;
    out.push(`${entry.kind}${body}`);
    if (entry.noNewline) out.push('\\ No newline at end of file');
  }
  return out;
}

/**
 * Unified diff of one file. `null` means the file is absent on that side (creation/deletion).
 * Returns '' when the two sides are identical.
 */
export function unifiedDiffForFile(relPath: string, before: string | null, after: string | null): string {
  const aLines = before === null ? [] : toFileLines(before);
  const bLines = after === null ? [] : toFileLines(after);
  const hunks = buildHunks(diffOps(aLines, bLines));
  if (hunks.length === 0) return '';
  const oldHeader = before === null ? '/dev/null' : `a/${relPath}`;
  const newHeader = after === null ? '/dev/null' : `b/${relPath}`;
  const body = hunks.flatMap(renderHunk);
  return [`--- ${oldHeader}`, `+++ ${newHeader}`, ...body].join('\n') + '\n';
}

// ----------------- Unified diff: parsing -----------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const IGNORABLE_HEADER = /^(diff --git |index |new file mode |deleted file mode |old mode |new mode |similarity index )/;

/**
 * Parses a unified diff. Strict by design: a malformed or ambiguous patch is refused instead of
 * being applied partially.
 *
 * Patch text is split on LF only. A CR is NOT stripped: it stays part of the line content, so a
 * CRLF file can be patched by a patch whose context lines carry the CR, and an LF-formatted patch
 * aimed at a CRLF file fails loudly on a context mismatch instead of silently rewriting every line
 * ending in the file.
 */
export function parseUnifiedDiff(text: string): ParsedPatch {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ExperimentError('INVALID_INPUT', 'Patch text is empty', { fieldPaths: ['patch'] });
  }
  const rawLines = text.split('\n');
  while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const files: ParsedFilePatch[] = [];
  let cursor = 0;
  while (cursor < rawLines.length) {
    const line = rawLines[cursor];
    if (line.trim().length === 0) {
      cursor += 1;
      continue;
    }
    if (IGNORABLE_HEADER.test(line)) {
      cursor += 1;
      continue;
    }
    if (!line.startsWith('--- ')) {
      throw new ExperimentError('INVALID_INPUT', `Expected a "--- " file header, got: "${line.slice(0, 60)}"`, {
        fieldPaths: ['patch'],
      });
    }
    const oldRaw = line.slice(4);
    cursor += 1;
    if (cursor >= rawLines.length || !rawLines[cursor].startsWith('+++ ')) {
      throw new ExperimentError('INVALID_INPUT', 'A "--- " header must be followed by a "+++ " header', {
        fieldPaths: ['patch'],
      });
    }
    const newRaw = rawLines[cursor].slice(4);
    cursor += 1;
    const oldPath = oldRaw.split('\t')[0].trim() === '/dev/null' ? null : normalizePatchTarget(oldRaw);
    const newPath = newRaw.split('\t')[0].trim() === '/dev/null' ? null : normalizePatchTarget(newRaw);

    const hunks: ParsedHunk[] = [];
    while (cursor < rawLines.length && rawLines[cursor].startsWith('@@')) {
      const header = HUNK_HEADER.exec(rawLines[cursor]);
      if (!header) {
        throw new ExperimentError('INVALID_INPUT', `Malformed hunk header: "${rawLines[cursor].slice(0, 60)}"`, {
          fieldPaths: ['patch'],
        });
      }
      const oldStart = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      cursor += 1;

      const entries: ParsedHunkEntry[] = [];
      for (;;) {
        if (cursor >= rawLines.length) break;
        const body = rawLines[cursor];
        if (body.startsWith('@@') || body.startsWith('--- ')) break;
        if (body.startsWith('\\')) {
          if (!body.startsWith('\\ No newline at end of file')) {
            throw new ExperimentError('INVALID_INPUT', `Unsupported patch marker: "${body.slice(0, 60)}"`, {
              fieldPaths: ['patch'],
            });
          }
          const previous = entries[entries.length - 1];
          if (!previous || previous.noNewline) {
            throw new ExperimentError('INVALID_INPUT', 'A no-newline marker must follow a content line', {
              fieldPaths: ['patch'],
            });
          }
          if (previous.text.endsWith('\n')) previous.text = previous.text.slice(0, -1);
          previous.noNewline = true;
          cursor += 1;
          continue;
        }
        if (body.length === 0) {
          if (rawLines.slice(cursor).every((rest) => rest === '')) break;
          throw new ExperimentError('INVALID_INPUT', 'Empty line inside a hunk body', { fieldPaths: ['patch'] });
        }
        const kind = body[0];
        if (kind !== ' ' && kind !== '-' && kind !== '+') {
          throw new ExperimentError('INVALID_INPUT', `Unsupported hunk line prefix: "${body.slice(0, 60)}"`, {
            fieldPaths: ['patch'],
          });
        }
        entries.push({ kind, text: `${body.slice(1)}\n`, noNewline: false });
        cursor += 1;
      }

      for (const entry of entries) {
        if (entry.noNewline) {
          const isLastOld = lastIndexWhere(entries, (e) => e.kind !== '+') === entries.indexOf(entry);
          const isLastNew = lastIndexWhere(entries, (e) => e.kind !== '-') === entries.indexOf(entry);
          if (!isLastOld && !isLastNew) {
            throw new ExperimentError(
              'INVALID_INPUT',
              'A no-newline marker may only follow the last line of the old or new side of a hunk',
              { fieldPaths: ['patch'] }
            );
          }
        }
      }
      const oldLines = entries.filter((entry) => entry.kind !== '+').length;
      const newLines = entries.filter((entry) => entry.kind !== '-').length;
      if (oldLines !== oldCount || newLines !== newCount) {
        throw new ExperimentError(
          'INVALID_INPUT',
          `Hunk header declares -${oldStart},${oldCount} +${newStart},${newCount} but carries ${oldLines}/${newLines} lines`,
          { fieldPaths: ['patch'] }
        );
      }
      hunks.push({ oldStart, oldCount, newStart, newCount, entries });
    }

    if (hunks.length === 0 && oldPath !== null && newPath !== null) {
      throw new ExperimentError('INVALID_INPUT', `File patch for "${newPath}" carries no hunk`, {
        fieldPaths: ['patch'],
      });
    }
    files.push({ oldPath, newPath, hunks });
  }

  if (files.length === 0) {
    throw new ExperimentError('INVALID_INPUT', 'Patch contains no file patch', { fieldPaths: ['patch'] });
  }
  return { files, patchSha256: sha256Hex(text) };
}

/** Applies a parsed patch's hunks to one file image. Read-only: it never touches the disk. */
export function applyHunksToLines(originalLines: readonly string[], hunks: readonly ParsedHunk[], label: string): string[] {
  const edits: Array<{ start: number; end: number; newLines: string[] }> = [];
  let cursor = 0;
  hunks.forEach((hunk, index) => {
    const oldLines = hunk.entries.filter((entry) => entry.kind !== '+').map((entry) => entry.text);
    const newLines = hunk.entries.filter((entry) => entry.kind !== '-').map((entry) => entry.text);
    const start = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (start < 0 || start < cursor) {
      throw new ExperimentError('INVALID_INPUT', `${label}: hunk ${index + 1} overlaps a previous hunk`, {
        fieldPaths: ['patch'],
      });
    }
    if (start + oldLines.length > originalLines.length) {
      throw new ExperimentError('INVALID_INPUT', `${label}: hunk ${index + 1} extends past the end of the file`, {
        fieldPaths: ['patch'],
      });
    }
    for (let k = 0; k < oldLines.length; k += 1) {
      if (originalLines[start + k] !== oldLines[k]) {
        throw new ExperimentError(
          'INVALID_INPUT',
          `${label}: hunk ${index + 1} does not apply at line ${start + k + 1} (patch context does not match the file)`,
          { fieldPaths: ['patch'] }
        );
      }
    }
    cursor = start + oldLines.length;
    edits.push({ start, end: start + oldLines.length, newLines });
  });

  const out: string[] = [];
  let position = 0;
  for (const edit of edits) {
    out.push(...originalLines.slice(position, edit.start));
    out.push(...edit.newLines);
    position = edit.end;
  }
  out.push(...originalLines.slice(position));
  return out;
}

// ----------------- Attempt records -----------------

/** Canonical body of an attempt record: no self hash, no run timestamp. */
export function attemptRecordBody(record: PatchAttemptRecord): Record<string, unknown> {
  const { attemptHash: _omitHash, recordedAt: _omitTime, ...body } = record;
  return body;
}

export function attemptRecordCanonical(record: PatchAttemptRecord): string {
  return canonicalJsonV1(attemptRecordBody(record));
}

export function computeAttemptHash(body: Record<string, unknown>): string {
  return typedHash(WORKSPACE_HASH_DOMAINS.patchAttempt, body);
}

export function attemptRefFor(record: PatchAttemptRecord, taskId: string): ArtifactRef {
  return { id: `patch-attempt-${taskId}-${record.attemptIndex}`, sha256: record.attemptHash };
}

// ----------------- Workspace -----------------

interface PlannedWrite {
  relPath: string;
  absPath: string;
  action: 'write' | 'delete';
  content: string | null;
}

function readUtf8File(absPath: string, relPath: string): string {
  const bytes = fs.readFileSync(absPath);
  if (bytes.includes(0)) {
    throw new ExperimentError('INVALID_INPUT', `Patch target "${relPath}" is not a text file`, {
      fieldPaths: ['patch.target'],
    });
  }
  return bytes.toString('utf8');
}

export class PatchWorkspace {
  readonly taskId: string;
  readonly sourceRoot: string;
  readonly workspaceRoot: string;
  readonly policy: PatchPolicy;
  readonly maxRepairAttempts: number;
  readonly sourcePins: SourceFilePin[];
  readonly symlinkedPaths: string[];
  private readonly _records: PatchAttemptRecord[];
  private readonly _writeLog: string[];

  constructor(options: {
    taskId: string;
    sourceRoot: string;
    workspaceRoot: string;
    policy: PatchPolicy;
    maxRepairAttempts: number;
    sourcePins: SourceFilePin[];
    symlinkedPaths: string[];
  }) {
    this.taskId = options.taskId;
    this.sourceRoot = path.resolve(options.sourceRoot);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.policy = options.policy;
    this.maxRepairAttempts = options.maxRepairAttempts;
    this.sourcePins = options.sourcePins;
    this.symlinkedPaths = options.symlinkedPaths;
    this._records = [];
    this._writeLog = [];
  }

  /** Total submissions allowed: the initial one plus the declared repair rounds. */
  get maxSubmissions(): number {
    return 1 + this.maxRepairAttempts;
  }

  get submissionsUsed(): number {
    return this._records.length;
  }

  get writeLog(): readonly string[] {
    return this._writeLog;
  }

  listAttempts(): PatchAttemptRecord[] {
    return this._records.map((record) => ({ ...record }));
  }

  /** The FIRST failure is kept: later retries must not erase what went wrong first. */
  firstError(): PatchAttemptRecord | null {
    return this._records.find((record) => record.outcome !== 'applied') ?? null;
  }

  attemptRefs(): ArtifactRef[] {
    return this._records.map((record) => attemptRefFor(record, this.taskId));
  }

  // ---- path safety ----

  private resolveInsideWorkspace(relPath: string): string {
    const abs = path.resolve(this.workspaceRoot, ...relPath.split('/'));
    const prefix = this.workspaceRoot + path.sep;
    if (abs !== this.workspaceRoot && !abs.startsWith(prefix)) {
      throw new ExperimentError('POLICY_DENIED', `Resolved path escapes the patch workspace: "${relPath}"`, {
        fieldPaths: ['patch.target'],
      });
    }
    if (abs === this.sourceRoot || abs.startsWith(this.sourceRoot + path.sep)) {
      throw new ExperimentError('POLICY_DENIED', `Refusing to write inside the source checkout: "${relPath}"`, {
        fieldPaths: ['patch.target'],
      });
    }
    // Fail closed on symlinks anywhere in the path, leaf included.
    //
    // `lstatSync` (not `existsSync`) is used deliberately: `existsSync` FOLLOWS a link, so a
    // DANGLING symlink reports "does not exist", would break this loop early, and the subsequent
    // write would then be resolved by the OS through the link to its target outside the
    // workspace. lstat sees the link itself and refuses.
    const segments = relPath.split('/');
    let walked = this.workspaceRoot;
    for (let i = 0; i < segments.length; i += 1) {
      walked = path.join(walked, segments[i]);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.lstatSync(walked);
      } catch {
        stat = null; // genuinely absent: nothing to follow, and the rest of the path cannot exist
      }
      if (stat === null) break;
      if (stat.isSymbolicLink()) {
        throw new ExperimentError(
          'POLICY_DENIED',
          `Refusing to write through a symlink: "${segments.slice(0, i + 1).join('/')}"`,
          { fieldPaths: ['patch.target'] }
        );
      }
    }
    return abs;
  }

  private assertTargetsWritable(targets: readonly string[]): void {
    if (!fs.existsSync(this.workspaceRoot) || !fs.statSync(this.workspaceRoot).isDirectory()) {
      throw new ExperimentError('NOT_FOUND', `Patch workspace does not exist: ${this.workspaceRoot}`);
    }
    for (const target of targets) {
      if (isAlwaysForbidden(target)) {
        throw new ExperimentError('POLICY_DENIED', `Refusing a protected path at write time: "${target}"`, {
          fieldPaths: ['patch.target'],
        });
      }
      this.resolveInsideWorkspace(target);
    }
  }

  // ---- planning and commit ----

  private planWrites(parsed: ParsedPatch): PlannedWrite[] {
    const planned: PlannedWrite[] = [];
    for (const file of parsed.files) {
      const label = file.newPath ?? file.oldPath ?? '<unknown>';
      const relPath = file.newPath ?? file.oldPath;
      if (relPath === null) {
        throw new ExperimentError('INVALID_INPUT', 'A file patch must name at least one side', {
          fieldPaths: ['patch'],
        });
      }
      const absPath = this.resolveInsideWorkspace(relPath);
      const exists = fs.existsSync(absPath) && fs.statSync(absPath).isFile();
      const beforeText = exists ? readUtf8File(absPath, relPath) : null;
      const afterLines = applyHunksToLines(beforeText === null ? [] : toFileLines(beforeText), file.hunks, label);

      if (file.newPath === null) {
        if (!exists) {
          throw new ExperimentError('INVALID_INPUT', `${label}: cannot delete a file that is not in the workspace`, {
            fieldPaths: ['patch'],
          });
        }
        if (afterLines.length !== 0) {
          throw new ExperimentError('INVALID_INPUT', `${label}: a deletion patch must remove every line`, {
            fieldPaths: ['patch'],
          });
        }
        planned.push({ relPath, absPath, action: 'delete', content: null });
        continue;
      }
      if (file.oldPath === null && exists) {
        throw new ExperimentError('INVALID_INPUT', `${label}: patch creates a file that already exists`, {
          fieldPaths: ['patch'],
        });
      }
      if (file.oldPath !== null && !exists) {
        throw new ExperimentError('INVALID_INPUT', `${label}: patch modifies a file that is not in the workspace`, {
          fieldPaths: ['patch'],
        });
      }
      planned.push({ relPath, absPath, action: 'write', content: fromFileLines(afterLines) });
    }
    return planned;
  }

  private commit(planned: readonly PlannedWrite[]): string[] {
    const written: string[] = [];
    for (const item of planned) {
      // Defence in depth: re-check containment and policy immediately before the write.
      this.assertTargetsWritable([item.relPath]);
      if (item.action === 'delete') {
        fs.unlinkSync(item.absPath);
      } else {
        fs.mkdirSync(path.dirname(item.absPath), { recursive: true });
        fs.writeFileSync(item.absPath, item.content ?? '', 'utf8');
      }
      written.push(item.relPath);
      this._writeLog.push(item.relPath);
    }
    return written;
  }

  private record(input: {
    label: string;
    patchSha256: string;
    outcome: PatchAttemptOutcome;
    errorCode: string | null;
    message: string | null;
    targetPaths: string[];
    writtenPaths: string[];
  }): PatchAttemptRecord {
    const attemptIndex = this._records.length + 1;
    const body = {
      attemptIndex,
      isRepair: attemptIndex > 1,
      label: input.label,
      patchSha256: input.patchSha256,
      outcome: input.outcome,
      errorCode: input.errorCode,
      message: input.message,
      targetPaths: [...input.targetPaths].sort(),
      writtenPaths: [...input.writtenPaths].sort(),
    };
    const record: PatchAttemptRecord = {
      ...body,
      recordedAt: new Date().toISOString(),
      attemptHash: computeAttemptHash(body),
    };
    this._records.push(record);
    return { ...record };
  }

  /**
   * Applies one patch submission.
   *
   * The full path policy is enforced for every file in the patch BEFORE the first write, and the
   * whole patch is planned in memory first. A rejected patch therefore leaves the workspace byte
   * identical. Rejection is a recorded outcome, not a crash; use `assertApplied` to convert it
   * into an error. Exceeding maxRepairAttempts throws REPAIR_EXHAUSTED and keeps the first error.
   */
  applyPatch(patchText: string, opts: { label?: string } = {}): PatchApplyReport {
    const label = opts.label ?? `submission-${this._records.length + 1}`;
    if (this._records.length >= this.maxSubmissions) {
      const first = this.firstError();
      throw new ExperimentError(
        'REPAIR_EXHAUSTED',
        `Repair attempts are used up (${this._records.length}/${this.maxSubmissions}); first error: ${
          first ? `${first.errorCode} ${first.message}` : 'none'
        }`,
        { fieldPaths: ['maxRepairAttempts'] }
      );
    }
    const patchSha256 = sha256Hex(patchText);
    let parsed: ParsedPatch | null = null;
    let targets: string[] = [];
    try {
      parsed = parseUnifiedDiff(patchText);
      targets = assertPatchPolicy(parsed, this.policy);
      this.assertTargetsWritable(targets);
      const planned = this.planWrites(parsed);
      const written = this.commit(planned);
      const record = this.record({
        label,
        patchSha256,
        outcome: 'applied',
        errorCode: null,
        message: null,
        targetPaths: targets,
        writtenPaths: written,
      });
      return {
        outcome: 'applied',
        record,
        targetPaths: targets,
        writtenPaths: written,
        diff: this.fullDiff().text,
      };
    } catch (error) {
      if (error instanceof ExperimentError && error.code === 'REPAIR_EXHAUSTED') throw error;
      const code = error instanceof ExperimentError ? error.code : 'INVALID_INPUT';
      const message = error instanceof Error ? error.message : String(error);
      // When the policy check itself throws, `targets` is still empty: fall back to the paths the
      // patch named so the record still says what was refused. Deduplicated and sorted, so a
      // modification patch does not list its target twice.
      const namedTargets = Array.from(
        new Set(
          (parsed?.files ?? [])
            .flatMap((file) => [file.oldPath, file.newPath])
            .filter((value): value is string => value !== null)
        )
      ).sort();
      const record = this.record({
        label,
        patchSha256,
        outcome: 'rejected',
        errorCode: code,
        message,
        targetPaths: targets.length > 0 ? targets : namedTargets,
        writtenPaths: [],
      });
      return { outcome: 'rejected', record, targetPaths: record.targetPaths, writtenPaths: [], diff: null };
    }
  }

  /** Throws the recorded error when the last submission did not apply. */
  assertApplied(report: PatchApplyReport): void {
    if (report.outcome === 'applied') return;
    throw new ExperimentError(
      (report.record.errorCode as never) ?? 'INVALID_INPUT',
      `Patch was not applied: ${report.record.message ?? 'unknown reason'}`,
      { fieldPaths: ['patch'] }
    );
  }

  // ---- evidence ----

  sourceManifest(): SourceFilePin[] {
    return hashFileTree(this.sourceRoot);
  }

  workspaceManifest(): SourceFilePin[] {
    return hashFileTree(this.workspaceRoot);
  }

  workspaceTreeHash(): string {
    return treeHash(this.workspaceManifest());
  }

  codeTreeRef(): ArtifactRef {
    const manifest = this.workspaceManifest();
    return {
      id: `code-tree-${this.taskId}`,
      sha256: typedHash(WORKSPACE_HASH_DOMAINS.codeTree, { entries: manifest }),
    };
  }

  /** The complete original-vs-adapted diff. Never just the final code. */
  fullDiff(): FullDiffReport {
    const sourcePins = this.sourceManifest().filter((pin) => pin.kind === 'file');
    const workspacePins = this.workspaceManifest().filter((pin) => pin.kind === 'file');
    const before = new Map(sourcePins.map((pin) => [pin.path, pin]));
    const after = new Map(workspacePins.map((pin) => [pin.path, pin]));
    const allPaths = Array.from(new Set([...before.keys(), ...after.keys()])).sort();

    const entries: DiffEntry[] = [];
    for (const relPath of allPaths) {
      const inBefore = before.get(relPath);
      const inAfter = after.get(relPath);
      if (inBefore && inAfter && inBefore.sha256 === inAfter.sha256) continue;
      const beforeText = inBefore ? fs.readFileSync(path.join(this.sourceRoot, ...relPath.split('/')), 'utf8') : null;
      const afterText = inAfter ? fs.readFileSync(path.join(this.workspaceRoot, ...relPath.split('/')), 'utf8') : null;
      const diff = unifiedDiffForFile(relPath, beforeText, afterText);
      const addedLines = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
      const removedLines = diff.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
      const status: DiffEntry['status'] = !inBefore ? 'added' : !inAfter ? 'deleted' : 'modified';
      entries.push({ path: relPath, status, addedLines, removedLines, diff });
    }

    const changedPaths = entries.map((entry) => entry.path);
    const unexpectedPaths = changedPaths.filter((relPath) => !isPathCovered(relPath, this.policy.allowedPaths));
    const text = entries.map((entry) => entry.diff).join('');
    return {
      text,
      entries,
      changedPaths,
      unexpectedPaths,
      diffHash: typedHash(WORKSPACE_HASH_DOMAINS.fullDiff, {
        entries: entries.map((entry) => ({
          path: entry.path,
          status: entry.status,
          addedLines: entry.addedLines,
          removedLines: entry.removedLines,
          diffSha256: sha256Hex(entry.diff),
        })),
      }),
    };
  }

  /** Ties attempts + adapted tree + full diff into the frozen ImplementationSnapshot contract. */
  buildImplementationSnapshot(input: {
    sourceBundleRef: ArtifactRef;
    planRef: ArtifactRef;
    patchRef: ArtifactRef;
    dependencyLockRef: ArtifactRef;
    resolvedConfigRef: ArtifactRef;
    mechanismDiff: MechanismDiffEntry[];
    mechanismDiffRef: ArtifactRef;
  }): ImplementationSnapshot {
    const snapshot: ImplementationSnapshot = {
      sourceBundleRef: input.sourceBundleRef,
      planRef: input.planRef,
      patchRef: input.patchRef,
      codeTreeRef: this.codeTreeRef(),
      dependencyLockRef: input.dependencyLockRef,
      resolvedConfigRef: input.resolvedConfigRef,
      mechanismDiff: input.mechanismDiff,
      mechanismDiffRef: input.mechanismDiffRef,
      attemptRefs: this.attemptRefs(),
      implementationHash: '',
    };
    snapshot.implementationHash = computeImplementationHash(implementationBody(snapshot));
    return validateImplementationSnapshot(snapshot);
  }

  destroy(): void {
    assertSeparateRoots(this.sourceRoot, this.workspaceRoot);
    if (fs.existsSync(this.workspaceRoot)) fs.rmSync(this.workspaceRoot, { recursive: true, force: true });
  }
}

function copyTree(sourceRoot: string, destRoot: string, symlinks: string[]): void {
  const entries = fs.readdirSync(sourceRoot, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const src = path.join(sourceRoot, entry.name);
    const dest = path.join(destRoot, entry.name);
    const stat = fs.lstatSync(src);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(src);
      const resolvedTarget = path.resolve(path.dirname(src), target);
      const sourceAbs = path.resolve(sourceRoot);
      if (!resolvedTarget.startsWith(sourceAbs + path.sep) && resolvedTarget !== sourceAbs) {
        throw new ExperimentError(
          'POLICY_DENIED',
          `Pinned source contains a symlink that escapes the source root: ${src} -> ${target}`,
          { fieldPaths: ['sourceRoot'] }
        );
      }
      symlinks.push(path.relative(path.resolve(sourceRoot), src).replace(/\\/g, '/'));
      fs.symlinkSync(target, dest);
      continue;
    }
    if (stat.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyTree(src, dest, symlinks);
      continue;
    }
    fs.copyFileSync(src, dest);
  }
}

/**
 * Creates the throwaway workspace: `<workRoot>/<taskId>/patch-workspace`, a byte copy of the
 * pinned source checkout. The source checkout is only read.
 */
export function createPatchWorkspace(options: PatchWorkspaceOptions): PatchWorkspace {
  const taskId = options.taskId;
  if (typeof taskId !== 'string' || taskId.trim().length === 0 || /[\\/]/.test(taskId) || taskId.includes('..')) {
    throw new ExperimentError('INVALID_INPUT', `taskId must be a single safe path segment, got "${taskId}"`, {
      fieldPaths: ['taskId'],
    });
  }
  const sourceRoot = path.resolve(options.sourceRoot);
  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw new ExperimentError('NOT_FOUND', `Source checkout is not a directory: ${sourceRoot}`);
  }
  const workRoot = path.resolve(options.workRoot ?? WORK_DIR_ROOT_DEFAULT);
  const workspaceRoot = path.join(workRoot, taskId, options.workspaceName ?? 'patch-workspace');
  assertSeparateRoots(sourceRoot, workspaceRoot);

  if (fs.existsSync(workspaceRoot)) {
    if (!options.reset) {
      throw new ExperimentError('INVALID_INPUT', `Patch workspace already exists: ${workspaceRoot}`, {
        fieldPaths: ['workspaceRoot'],
      });
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const symlinks: string[] = [];
  copyTree(sourceRoot, workspaceRoot, symlinks);

  const pins = hashFileTree(workspaceRoot);
  if (options.sourcePins) {
    const expected = new Map(options.sourcePins.map((pin) => [pin.path, pin]));
    for (const pin of pins) {
      const declared = expected.get(pin.path);
      if (!declared) {
        throw new ExperimentError('SOURCE_MISMATCH', `Copied tree has an undeclared file: ${pin.path}`, {
          fieldPaths: ['sourcePins'],
        });
      }
      if (declared.sha256 !== pin.sha256) {
        throw new ExperimentError(
          'SOURCE_MISMATCH',
          `Copy mismatch for ${pin.path}: declared ${declared.sha256.slice(0, 12)}..., copied ${pin.sha256.slice(0, 12)}...`,
          { fieldPaths: ['sourcePins'] }
        );
      }
    }
    for (const declared of options.sourcePins) {
      if (!pins.some((pin) => pin.path === declared.path)) {
        throw new ExperimentError('SOURCE_MISMATCH', `Pinned file is missing from the copy: ${declared.path}`, {
          fieldPaths: ['sourcePins'],
        });
      }
    }
  }

  return new PatchWorkspace({
    taskId,
    sourceRoot,
    workspaceRoot,
    policy: options.policy,
    maxRepairAttempts: options.maxRepairAttempts ?? 0,
    sourcePins: pins,
    symlinkedPaths: symlinks,
  });
}
