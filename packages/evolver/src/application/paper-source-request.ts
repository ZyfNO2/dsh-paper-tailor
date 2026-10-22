import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface PaperSourceRequest {
  requestId: string; workspace: string; source: string;
  files: { sourceId: string; name: string; path: string; relativePath: string; bytes: number; modified: number }[];
}
export interface SourceScanError { path: string; sourceId?: string; code: string; message: string }
export interface DiscoveredSource {
  requestId: string; workspace: string; source: string; relativeSource: string; filter: SourceFilter;
  files: { sourceId: string; name: string; relativePath: string; bytes: number }[];
  errors: SourceScanError[]; truncated: boolean;
}
/** PDF-only is the default workspace sweep, so README/AGENTS/Skill files are not treated as papers. */
export type SourceFilter = 'pdf' | 'all';
const directory = (workspace: string) => path.join(workspace, '.dsh', 'research', 'source-requests');
const supported = (file: string) => /\.(pdf|txt|md)$/i.test(file);
const isPdf = (file: string) => /\.pdf$/i.test(file);
const MAX_VISITED = 2000, MAX_DEPTH = 8, MAX_FILES = 100, EXCLUDED = ['.git', '.dsh', 'node_modules'];

/** One bounded walk. `strict` reproduces the human-command behaviour of failing fast. */
function walk(source: string, filter: SourceFilter, signal: AbortSignal | undefined, strict: boolean,
  onFile: (absolute: string, stat: fs.Stats) => void, onError: (absolute: string, code: string, message: string) => void): { truncated: boolean } {
  let visited = 0, admitted = 0, truncated = false;
  function visit(file: string, depth: number): void {
    signal?.throwIfAborted();
    const fail = (code: string, message: string) => { if (strict) throw new Error(`${code}: ${message}`); onError(file, code, message); };
    if (++visited > MAX_VISITED || depth > MAX_DEPTH) { truncated = true; return fail('SOURCE_LIMIT', 'directory is too large/deep; select a smaller paper directory'); }
    const ioFailure = (error: unknown) => fail((error as NodeJS.ErrnoException).code ?? 'SOURCE_IO', error instanceof Error ? error.message : String(error));
    let stat: fs.Stats;
    try { stat = fs.lstatSync(file); }
    catch (error) { return ioFailure(error); }
    if (stat.isSymbolicLink()) return fail('SOURCE_SYMLINK', `select the actual source instead: ${file}`);
    if (stat.isDirectory()) {
      let names: string[];
      try { names = fs.readdirSync(file).sort(); }
      catch (error) { return ioFailure(error); }
      for (const name of names) { if (EXCLUDED.includes(name)) continue; visit(path.join(file, name), depth + 1); if (truncated) return; }
      return;
    }
    if (!stat.isFile() || !supported(file)) return;
    if (filter === 'pdf' && !isPdf(file)) return;
    if (!stat.size || stat.size > 25 * 1024 * 1024) return fail('SOURCE_SIZE', `${file} must be nonempty and at most 25 MiB`);
    if (admitted >= MAX_FILES) { truncated = true; return fail('SOURCE_LIMIT', `select at most ${MAX_FILES} papers`); }
    admitted++;
    onFile(file, stat);
  }
  visit(source, 0);
  return { truncated };
}

function persist(request: PaperSourceRequest): void {
  fs.mkdirSync(directory(request.workspace), { recursive: true });
  const target = path.join(directory(request.workspace), `${request.requestId}.json`), temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(request, null, 2), { flag: 'wx' }); fs.renameSync(temporary, target);
}

/** Resolve `source` inside this workspace by REAL path, not by string prefix. */
export function resolveInWorkspace(workspace: string, source: string): { root: string; resolved: string } {
  const root = fs.realpathSync(workspace);
  let resolved: string;
  try { resolved = fs.realpathSync(path.resolve(root, source)); }
  catch (error) { throw new Error(`SOURCE_NOT_FOUND: ${source} (${(error as NodeJS.ErrnoException).code ?? 'ENOENT'})`); }
  const relative = path.relative(root, resolved);
  // `''` means "exactly the workspace root", which is the DEFAULT scope and must be allowed;
  // only `..` escapes (or another drive) are refused.
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`SOURCE_OUT_OF_WORKSPACE: ${source} is outside this workspace`);
  return { root, resolved };
}

/**
 * Discover and admit papers already inside this workspace — the tool entry for autonomous
 * import. Everything here is rooted in the calling Agent's real workspace (never a path from
 * model text), and it reuses the same durable receipt the human command writes, so the existing
 * import tool consumes it unchanged.
 *
 * The default sweep (no path, or the workspace root itself) matches PDFs only, so documentation
 * and internal files are not mistaken for papers; an explicit file or directory keeps admitting
 * PDF/TXT/MD. A damaged file is recorded per-file and never turns the batch into an empty list.
 */
export function discoverPaperSources(workspace: string, source = '.', signal?: AbortSignal): DiscoveredSource {
  const { root, resolved } = resolveInWorkspace(workspace, source);
  const filter: SourceFilter = source === '.' || source === '' || resolved === root ? 'pdf' : 'all';
  const errors: SourceScanError[] = [];
  const files: PaperSourceRequest['files'] = [];
  const { truncated } = walk(resolved, filter, signal, false, (absolute, stat) => {
    files.push({ sourceId: `file-${files.length + 1}`, name: path.basename(absolute), path: absolute, relativePath: path.relative(root, absolute).split(path.sep).join('/'),
      bytes: stat.size, modified: stat.mtimeMs });
  }, (absolute, code, message) => errors.push({ path: path.relative(root, absolute).split(path.sep).join('/'), code, message }));
  const request: PaperSourceRequest = { requestId: randomUUID(), workspace, source: resolved, files };
  persist(request);
  return { requestId: request.requestId, workspace, source: resolved, relativeSource: path.relative(root, resolved).split(path.sep).join('/') || '.', filter,
    files: files.map(({ sourceId, name, relativePath, bytes }) => ({ sourceId, name, relativePath, bytes })), errors, truncated };
}

/** A human slash-command admits a source. Tools can consume only these durable receipts. */
export function admitPaperSource(workspace: string, source: string, signal?: AbortSignal): PaperSourceRequest {
  const root = path.resolve(workspace, source), resolved = fs.realpathSync(root);
  const files: PaperSourceRequest['files'] = [];
  walk(resolved, 'all', signal, true, (absolute, stat) => {
    files.push({ sourceId: `file-${files.length + 1}`, name: path.basename(absolute), path: fs.realpathSync(absolute), relativePath: path.relative(fs.realpathSync(workspace), absolute).split(path.sep).join('/'),
      bytes: stat.size, modified: stat.mtimeMs });
  }, () => undefined);
  if (!files.length) throw new Error('SOURCE_MISSING: no PDF / TXT / Markdown in the selected source');
  const request: PaperSourceRequest = { requestId: randomUUID(), workspace, source: resolved, files };
  persist(request);
  return request;
}

/** Stable across repeated discovery receipts, without exposing source paths in run records. */
export function paperSourceTargetId(sourcePath: string): string {
  const absolute = path.resolve(sourcePath);
  return `source-${createHash('sha256').update(process.platform === 'win32' ? absolute.toLowerCase() : absolute).digest('hex')}`;
}

function admittedSource(workspace: string, requestId: string, sourceId: string): PaperSourceRequest['files'][number] {
  if (!/^[a-f0-9-]{36}$/.test(requestId)) throw new Error('INVALID_SOURCE_REQUEST');
  const request = JSON.parse(fs.readFileSync(path.join(directory(workspace), `${requestId}.json`), 'utf8')) as PaperSourceRequest;
  if (request.workspace !== workspace || request.requestId !== requestId) throw new Error('SOURCE_SCOPE_MISMATCH');
  if (!Array.isArray(request.files)) throw new Error('INVALID_SOURCE_RECEIPT');
  const source = request.files.find((entry) => entry.sourceId === sourceId);
  if (!source) throw new Error('SOURCE_NOT_ADMITTED');
  if (!Number.isSafeInteger(source.bytes) || source.bytes <= 0 || source.bytes > 25 * 1024 * 1024 ||
      typeof source.path !== 'string' || typeof source.name !== 'string' || !Number.isFinite(source.modified)) throw new Error('INVALID_SOURCE_RECEIPT');
  return source;
}

/** Metadata identity remains available when a file changes and its import must be refused. */
export function admittedPaperSourceTargetId(workspace: string, requestId: string, sourceId: string): string {
  return paperSourceTargetId(admittedSource(workspace, requestId, sourceId).path);
}

export function readAdmittedPaperSource(workspace: string, requestId: string, sourceId: string): { name: string; bytes: Buffer } {
  const source = admittedSource(workspace, requestId, sourceId);
  if (fs.realpathSync(source.path) !== source.path) throw new Error('SOURCE_CHANGED: rerun the slash command');
  const stat = fs.statSync(source.path);
  if (!stat.isFile() || stat.size !== source.bytes || stat.mtimeMs !== source.modified) throw new Error('SOURCE_CHANGED: rerun the slash command');
  const fd = fs.openSync(source.path, 'r');
  try {
    const bytes = Buffer.alloc(source.bytes + 1); const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (length !== source.bytes || after.size !== source.bytes || after.mtimeMs !== source.modified) throw new Error('SOURCE_CHANGED: rerun the slash command');
    return { name: source.name, bytes: bytes.subarray(0, length) };
  } finally { fs.closeSync(fd); }
}

/**
 * Recognise a quoted path plus request, or a whole existing unquoted path.
 *
 * Common unquoted inputs (spaces, Chinese names, a path followed by words such as
 * `Phase1 这几篇`) are now resolved by trying progressively shorter leading segments, so
 * users are never forced to know the quoting rule. A segment is only treated as the source
 * when it really exists inside this workspace; anything else stays an instruction for the
 * model. Paths are never handed to a shell.
 */
export function sourceArgument(workspace: string, rawInput: string): { source?: string; instruction: string } {
  const input = rawInput.trim(), quoted = /^"([^"]+)"(?:\s+([\s\S]*))?$/.exec(input);
  if (quoted) return { source: quoted[1], instruction: quoted[2] ?? '' };
  if (input && fs.existsSync(path.resolve(workspace, input))) return { source: input, instruction: '' };
  // Only attempt cheaper prefixes for inputs that really look path-like; never for free text.
  // A source segment is only accepted when it really exists in this workspace, so plain
  // prose ("全部论文", "根目录") still falls through to an instruction.
  const split = tryLeadingPath(workspace, input);
  if (split !== undefined) return split;
  if (/^(?:[a-z]:[\\/]|[./\\])|\.(?:pdf|txt|md)$/i.test(input)) throw new Error(`SOURCE_NOT_FOUND: ${input}`);
  return { instruction: input };
}

/**
 * Split a path-like leading segment off a mixed line by walking separators from the right.
 * `Phase1 这几篇` -> source `Phase1`; `/a/b/c.pdf 只抽取方法` -> source `/a/b/c.pdf`.
 */
function tryLeadingPath(workspace: string, input: string): { source: string; instruction: string } | undefined {
  const parts = input.split(/[\s]+/);
  for (let end = parts.length; end > 0; end -= 1) {
    const candidate = parts.slice(0, end).join(' ');
    if (!candidate) continue;
    let exists = false;
    try { exists = fs.existsSync(path.resolve(workspace, candidate)); } catch { continue; }
    if (exists) return { source: candidate, instruction: parts.slice(end).join(' ').trim() };
  }
  return undefined;
}
