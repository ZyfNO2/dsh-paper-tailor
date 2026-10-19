import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * Minimal command-run sidecar for `/wiki` and `/extract`
 * (`<workspace>/.dsh/research/command-runs/<runId>.json`), per the wiki/extract function spec §6.2–§6.4.
 *
 * It stores targets, execution status, result references and errors only: never paper text, never a second
 * copy of the knowledge base. Records are written by trusted command/tool boundaries, so the run id is always
 * minted here with `randomUUID()` and every read/write is confined to this workspace's folder; a caller (or a
 * model) can never name an arbitrary path.
 */

export type CommandRunStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
export type CommandRunCommand = 'wiki' | 'extract';
export type TargetOutcome = 'pending' | 'running' | 'partial' | 'saved' | 'reused' | 'no_findings' | 'failed' | 'cancelled';

export interface CommandRunTarget {
  /** Identifies the target before it is imported, e.g. the source request/source identity. */
  targetId: string;
  paperId: string | null;
  sourceSha256: string | null;
  scope: 'full' | 'selected';
  requestedPages: number[];
  /** Pages actually read by a real read call, never what the model claims it read. */
  readPages: number[];
  outcome: TargetOutcome;
  publishAttempts: number;
  verifiedRevision: string | null;
  /** Stable hash of this command's own target fields; a checksum, not a new asset revision (§6.2). */
  verifiedOutputHash: string | null;
  wikiSections: number;
  components: number;
  noFindingsReason?: string;
  error?: { code: string; message: string };
}

export interface PaperCommandRun {
  schemaVersion: 1;
  runId: string;
  command: CommandRunCommand;
  agentSessionId: string;
  status: CommandRunStatus;
  startedAt: string;
  finishedAt: string | null;
  targets: CommandRunTarget[];
}

/** Stable codes for the sidecar boundary, mirroring `PaperLibraryError`. */
export class PaperCommandRunStoreError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PaperCommandRunStoreError';
    this.code = code;
  }
}

const RUN_ID_PATTERN = /^[0-9a-f-]{36}$/;
const RUN_FILE_PATTERN = /^([0-9a-f-]{36})\.json$/;
/** A single record stays small: bounded targets, bounded error text, no paper content. */
const MAX_TARGETS = 100;
const MAX_ERROR_MESSAGE_CHARS = 2000;
const MAX_NO_FINDINGS_REASON_CHARS = 2000;
const MAX_TARGET_ID_CHARS = 200;
const MAX_AGENT_SESSION_CHARS = 200;
const COMMANDS: readonly string[] = ['wiki', 'extract'];
const STATUSES: readonly string[] = ['pending', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'];
const OUTCOMES: readonly string[] = ['pending', 'running', 'partial', 'saved', 'reused', 'no_findings', 'failed', 'cancelled'];
/** Outcomes that mean "this target really produced a verified result"; everything else is unfinished or failed. */
const VERIFIED_OUTCOMES: readonly string[] = ['saved', 'reused', 'no_findings'];

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
/** A missing folder or a folder path occupied by a file both mean "no record here"; every other I/O error is real. */
const isAbsent = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Deduplicated, ascending page numbers; unusable entries are dropped rather than stored as fake coverage. */
function normalizePages(pages: unknown): number[] {
  if (!Array.isArray(pages)) return [];
  const seen = new Set<number>();
  for (const page of pages) if (typeof page === 'number' && Number.isInteger(page) && page >= 1) seen.add(page);
  return [...seen].sort((left, right) => left - right);
}

const truncate = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);

function failure(code: string, detail: string): PaperCommandRunStoreError {
  return new PaperCommandRunStoreError(code, detail);
}

/**
 * Stable serialization: object keys sorted, `undefined` members dropped, array order preserved.
 * Two objects that differ only in property order therefore hash identically.
 */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record).sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The verification checksum for this command's own target fields: `wiki` = `{ title, sections }`,
 * `extract` = `{ components }`. It is not a new asset revision, so a later change to the *other* field
 * (which does move the joint revision) must not make this run look like its output was lost.
 */
export function outputHashFor(command: CommandRunCommand, value: unknown): string {
  if (command !== 'wiki' && command !== 'extract') throw failure('INVALID_COMMAND', 'command must be "wiki" or "extract"');
  if (!isRecord(value)) throw failure('INVALID_TARGET_FIELDS', 'target fields must be an object');
  const fields = command === 'wiki'
    ? { title: value.title, sections: value.sections }
    : { components: value.components };
  if (command === 'wiki' && (typeof value.title !== 'string' || !Array.isArray(value.sections))) {
    throw failure('INVALID_TARGET_FIELDS', 'wiki target fields require a string title and a sections array');
  }
  if (command === 'extract' && !Array.isArray(value.components)) {
    throw failure('INVALID_TARGET_FIELDS', 'extract target fields require a components array');
  }
  return sha256(stableStringify(fields));
}

/**
 * Verified read coverage for one source, from history that actually saved or reused that source.
 * Returns `undefined` when no such record exists: unread pages are never inferred from a different
 * source, a failed run or an unfinished one. `complete` is true only for a verified `full` scope.
 */
export function readCoverage(runs: PaperCommandRun[], sourceSha256: string): { pages: number[]; complete: boolean } | undefined {
  if (typeof sourceSha256 !== 'string' || !sourceSha256 || !Array.isArray(runs)) return undefined;
  const verified = (run: PaperCommandRun) => (Array.isArray(run?.targets) ? run.targets : [])
    .filter((target) => target?.sourceSha256 === sourceSha256 && VERIFIED_OUTCOMES.includes(target.outcome));
  const matches = runs.flatMap((run) => verified(run));
  if (!matches.length) return undefined;
  return { pages: normalizePages(matches.flatMap((target) => target.readPages)), complete: matches.some((target) => target.scope === 'full') };
}

/** §6.3 aggregation used by `finish` when the caller does not state a status. */
function aggregateStatus(targets: CommandRunTarget[]): CommandRunStatus {
  // An empty target set is "no target selected", never "all targets succeeded" (§6.3).
  if (!targets.length) return 'failed';
  if (targets.every((target) => VERIFIED_OUTCOMES.includes(target.outcome))) return 'completed';
  if (targets.every((target) => target.outcome === 'cancelled')) return 'cancelled';
  // Some verified result (or a verified partial range) survives, so the batch is partial and nothing is rolled back.
  if (targets.some((target) => VERIFIED_OUTCOMES.includes(target.outcome) || target.outcome === 'partial')) return 'partial';
  return 'failed';
}

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isNullableText = (value: unknown): value is string | null => value === null || typeof value === 'string';

/**
 * Structural read of one target. `strict` (file reads) requires every contract field to be present, so a
 * damaged or hand-edited record is reported instead of guessed at; the write path only validates what is
 * there and applies safe defaults for absent nullable members, so it can never invent a success outcome.
 */
function readTarget(value: unknown, strict: boolean): CommandRunTarget | undefined {
  if (!isRecord(value)) return undefined;
  if (!isText(value.targetId, MAX_TARGET_ID_CHARS)) return undefined;
  if (value.scope !== 'full' && value.scope !== 'selected') return undefined;
  if (typeof value.outcome !== 'string' || !OUTCOMES.includes(value.outcome)) return undefined;
  if (value.paperId !== undefined && !isNullableText(value.paperId)) return undefined;
  if (value.sourceSha256 !== undefined && !isNullableText(value.sourceSha256)) return undefined;
  if (value.requestedPages !== undefined && !Array.isArray(value.requestedPages)) return undefined;
  if (value.readPages !== undefined && !Array.isArray(value.readPages)) return undefined;
  if (value.publishAttempts !== undefined && !isCount(value.publishAttempts)) return undefined;
  if (value.verifiedRevision !== undefined && !isNullableText(value.verifiedRevision)) return undefined;
  if (value.verifiedOutputHash !== undefined && !isNullableText(value.verifiedOutputHash)) return undefined;
  if (value.wikiSections !== undefined && !isCount(value.wikiSections)) return undefined;
  if (value.components !== undefined && !isCount(value.components)) return undefined;
  if (value.noFindingsReason !== undefined && typeof value.noFindingsReason !== 'string') return undefined;
  if (value.error !== undefined && (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string')) return undefined;
  const present = (key: string) => !strict || value[key] !== undefined;
  if (!present('paperId') || !present('sourceSha256') || !present('requestedPages') || !present('readPages')
    || !present('publishAttempts') || !present('verifiedRevision') || !present('verifiedOutputHash')
    || !present('wikiSections') || !present('components')) return undefined;
  const target: CommandRunTarget = {
    targetId: value.targetId,
    paperId: (value.paperId as string | null | undefined) ?? null,
    sourceSha256: (value.sourceSha256 as string | null | undefined) ?? null,
    scope: value.scope,
    requestedPages: normalizePages(value.requestedPages),
    readPages: normalizePages(value.readPages),
    outcome: value.outcome as TargetOutcome,
    publishAttempts: (value.publishAttempts as number | undefined) ?? 0,
    verifiedRevision: (value.verifiedRevision as string | null | undefined) ?? null,
    verifiedOutputHash: (value.verifiedOutputHash as string | null | undefined) ?? null,
    wikiSections: (value.wikiSections as number | undefined) ?? 0,
    components: (value.components as number | undefined) ?? 0,
  };
  if (value.noFindingsReason !== undefined) target.noFindingsReason = truncate(value.noFindingsReason as string, MAX_NO_FINDINGS_REASON_CHARS);
  if (value.error !== undefined) {
    const error = value.error as Record<string, unknown>;
    target.error = { code: error.code as string, message: truncate(error.message as string, MAX_ERROR_MESSAGE_CHARS) };
  }
  return target;
}

/** Strict structural read of one stored record; `undefined` means corrupt or written by another identity. */
function readRun(raw: string, expectedRunId: string): PaperCommandRun | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!isRecord(parsed)) return undefined;
  if (parsed.schemaVersion !== 1) return undefined;
  if (parsed.runId !== expectedRunId) return undefined;
  if (typeof parsed.command !== 'string' || !COMMANDS.includes(parsed.command)) return undefined;
  if (!isText(parsed.agentSessionId, MAX_AGENT_SESSION_CHARS)) return undefined;
  if (typeof parsed.status !== 'string' || !STATUSES.includes(parsed.status)) return undefined;
  if (typeof parsed.startedAt !== 'string' || !parsed.startedAt) return undefined;
  if (parsed.finishedAt !== null && typeof parsed.finishedAt !== 'string') return undefined;
  if (!Array.isArray(parsed.targets)) return undefined;
  const targets = parsed.targets.map((target) => readTarget(target, true));
  if (targets.some((target) => target === undefined)) return undefined;
  return { schemaVersion: 1, runId: expectedRunId, command: parsed.command as CommandRunCommand,
    agentSessionId: parsed.agentSessionId, status: parsed.status as CommandRunStatus, startedAt: parsed.startedAt,
    finishedAt: parsed.finishedAt as string | null, targets: targets as CommandRunTarget[] };
}

/**
 * Bounds and re-validates whatever a caller or a `mutate` callback produced before it reaches disk, so a
 * record that was committed can always be read back. Rejects (never silently repairs) a broken identity.
 */
function sanitizeRun(run: PaperCommandRun, runId: string): PaperCommandRun {
  if (!isRecord(run)) throw failure('INVALID_RUN_RECORD', 'run must be an object');
  const record = run as unknown as Record<string, unknown>;
  if (record.runId !== runId) throw failure('INVALID_RUN_RECORD', 'run id cannot be reassigned');
  if (typeof record.command !== 'string' || !COMMANDS.includes(record.command)) throw failure('INVALID_RUN_RECORD', 'unknown command');
  if (typeof record.status !== 'string' || !STATUSES.includes(record.status)) throw failure('INVALID_RUN_RECORD', 'unknown status');
  if (!isText(record.agentSessionId, MAX_AGENT_SESSION_CHARS)) throw failure('INVALID_RUN_RECORD', 'missing agent session identity');
  if (typeof record.startedAt !== 'string' || !record.startedAt) throw failure('INVALID_RUN_RECORD', 'missing startedAt');
  if (record.finishedAt !== null && typeof record.finishedAt !== 'string') throw failure('INVALID_RUN_RECORD', 'finishedAt must be a timestamp or null');
  if (!Array.isArray(record.targets)) throw failure('INVALID_RUN_RECORD', 'targets must be an array');
  if (record.targets.length > MAX_TARGETS) throw failure('TOO_MANY_TARGETS', `at most ${MAX_TARGETS} targets per run`);
  const targets = record.targets.map((target) => readTarget(target, false));
  if (targets.some((target) => target === undefined)) throw failure('INVALID_RUN_RECORD', 'a target is structurally invalid');
  return { schemaVersion: 1, runId, command: record.command as CommandRunCommand, agentSessionId: record.agentSessionId,
    status: record.status as CommandRunStatus, startedAt: record.startedAt, finishedAt: record.finishedAt as string | null,
    targets: targets as CommandRunTarget[] };
}

/** A fresh target from a `begin` input; identity and scope are required, everything else has a safe default. */
function beginTarget(value: unknown, index: number): CommandRunTarget {
  if (!isRecord(value)) throw failure('INVALID_TARGET', `targets[${index}] must be an object`);
  if (!isText(value.targetId, MAX_TARGET_ID_CHARS)) throw failure('INVALID_TARGET', `targets[${index}].targetId must be a non-empty string`);
  if (value.scope !== 'full' && value.scope !== 'selected') throw failure('INVALID_TARGET', `targets[${index}].scope must be "full" or "selected"`);
  if (value.paperId !== undefined && value.paperId !== null && typeof value.paperId !== 'string') throw failure('INVALID_TARGET', `targets[${index}].paperId must be a string or null`);
  if (value.sourceSha256 !== undefined && value.sourceSha256 !== null && typeof value.sourceSha256 !== 'string') throw failure('INVALID_TARGET', `targets[${index}].sourceSha256 must be a string or null`);
  if (value.requestedPages !== undefined && !Array.isArray(value.requestedPages)) throw failure('INVALID_TARGET', `targets[${index}].requestedPages must be an array`);
  return {
    targetId: value.targetId, paperId: (value.paperId as string | null | undefined) ?? null,
    sourceSha256: (value.sourceSha256 as string | null | undefined) ?? null, scope: value.scope,
    requestedPages: normalizePages(value.requestedPages), readPages: [], outcome: 'pending', publishAttempts: 0,
    verifiedRevision: null, verifiedOutputHash: null, wikiSections: 0, components: 0,
  };
}

/**
 * Durable command-run records for one workspace. Reads and writes are synchronous and every write is a
 * temp-file + rename replacement, so a `mutate` can never interleave with another one and a failed write
 * leaves the previous record intact and surfaces its error.
 */
export class PaperCommandRunStore {
  /** Resolved workspace root; the record folder is `<root>/.dsh/research/command-runs`. */
  readonly root: string;
  private readonly folder: string;
  constructor(workspaceRoot: string) {
    if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) throw failure('WORKSPACE_ROOT_REQUIRED', 'missing workspace root');
    this.root = path.resolve(workspaceRoot);
    this.folder = path.join(this.root, '.dsh', 'research', 'command-runs');
  }

  /** Only a run id minted by this module can name a file; anything path-like is rejected before touching disk. */
  private fileFor(runId: string): string {
    if (typeof runId !== 'string' || !RUN_ID_PATTERN.test(runId)) throw failure('INVALID_RUN_ID', 'run ids are generated by this store');
    return path.join(this.folder, `${runId}.json`);
  }

  /** Atomic replacement in the `paper-library.ts` `commit` style; a failed write is never swallowed. */
  private commit(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* the rename failure is the one to report */ }
      throw error;
    }
  }

  private write(runId: string, run: PaperCommandRun): PaperCommandRun {
    const record = sanitizeRun(run, runId);
    this.commit(this.fileFor(runId), record);
    return record;
  }

  /** Starts a run. The run id is minted here, so a caller cannot claim another run's identity or path. */
  begin(input: { command: CommandRunCommand; agentSessionId: string; targets: Array<{ targetId: string; paperId?: string | null; sourceSha256?: string | null; scope: 'full' | 'selected'; requestedPages?: number[] }> }): PaperCommandRun {
    if (!isRecord(input)) throw failure('INVALID_BEGIN_INPUT', 'begin requires a command, an agent session and its targets');
    if (typeof input.command !== 'string' || !COMMANDS.includes(input.command)) throw failure('INVALID_COMMAND', 'command must be "wiki" or "extract"');
    if (!isText(input.agentSessionId, MAX_AGENT_SESSION_CHARS)) throw failure('INVALID_AGENT_SESSION', 'a real agent session identity is required');
    if (!Array.isArray(input.targets)) throw failure('INVALID_TARGET', 'targets must be an array');
    // No matching source must be reported as "no target selected", never recorded as an empty all-success run.
    if (!input.targets.length) throw failure('NO_TARGETS', 'no target was selected for this command');
    if (input.targets.length > MAX_TARGETS) throw failure('TOO_MANY_TARGETS', `at most ${MAX_TARGETS} targets per run`);
    const targets = input.targets.map(beginTarget);
    const run: PaperCommandRun = { schemaVersion: 1, runId: randomUUID(), command: input.command as CommandRunCommand,
      agentSessionId: input.agentSessionId, status: 'pending', startedAt: new Date().toISOString(), finishedAt: null, targets };
    return this.write(run.runId, run);
  }

  /** A corrupt or half-written record is never trusted; `RUN_RECORD_CORRUPT` is loud on purpose. */
  read(runId: string): PaperCommandRun | undefined {
    const file = this.fileFor(runId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (isAbsent(error)) return undefined;
      if ((error as NodeJS.ErrnoException).code === 'EISDIR') throw failure('RUN_RECORD_CORRUPT', `${runId}.json is not a readable command run record`);
      throw error;
    }
    const run = readRun(raw, runId);
    if (run === undefined) throw failure('RUN_RECORD_CORRUPT', `${runId}.json is not a readable command run record`);
    return run;
  }

  /** Newest first. Unparseable or foreign files are skipped one by one so the rest of the history still lists. */
  list(): PaperCommandRun[] {
    let names: string[];
    try {
      names = fs.readdirSync(this.folder);
    } catch (error) {
      if (isAbsent(error)) return [];
      throw error;
    }
    const runs: PaperCommandRun[] = [];
    for (const name of names) {
      const match = RUN_FILE_PATTERN.exec(name);
      if (match === null) continue;
      try {
        const run = readRun(fs.readFileSync(path.join(this.folder, name), 'utf8'), match[1]);
        if (run !== undefined) runs.push(run);
      } catch { /* a damaged record is skipped; the remaining history is still reported */ }
    }
    return runs.sort((left, right) => right.startedAt.localeCompare(left.startedAt) || right.runId.localeCompare(left.runId));
  }

  /** The newest unfinished run of this agent session; concurrent runs are told apart by their own session id. */
  current(agentSessionId: string): PaperCommandRun | undefined {
    if (!isText(agentSessionId, MAX_AGENT_SESSION_CHARS)) throw failure('INVALID_AGENT_SESSION', 'a real agent session identity is required');
    return this.list().find((run) => run.agentSessionId === agentSessionId && (run.status === 'pending' || run.status === 'running'));
  }

  /** Read-modify-write under one synchronous critical section, so concurrent updates never lose each other. */
  mutate(runId: string, change: (run: PaperCommandRun) => void): PaperCommandRun {
    if (typeof change !== 'function') throw failure('INVALID_CHANGE', 'mutate requires a change callback');
    const run = this.read(runId);
    if (run === undefined) throw failure('RUN_NOT_FOUND', `no command run recorded as ${runId}`);
    change(run);
    return this.write(runId, run);
  }

  /** Ends a run. Without an explicit status the batch status is aggregated per §6.3. */
  finish(runId: string, status?: CommandRunStatus): PaperCommandRun {
    const run = this.read(runId);
    if (run === undefined) throw failure('RUN_NOT_FOUND', `no command run recorded as ${runId}`);
    if (status !== undefined && !STATUSES.includes(status)) throw failure('INVALID_STATUS', `unknown status ${String(status)}`);
    run.status = status ?? aggregateStatus(run.targets);
    run.finishedAt = new Date().toISOString();
    return this.write(runId, run);
  }

  /**
   * Startup cleanup: leftover `pending`/`running` runs become `interrupted`, keeping their saved targets.
   * This only marks records — it never replays work or calls a model. Returns how many runs were marked.
   */
  markInterrupted(): number {
    const now = new Date().toISOString();
    let marked = 0;
    for (const run of this.list()) {
      if (run.status !== 'pending' && run.status !== 'running') continue;
      run.status = 'interrupted';
      run.finishedAt = now;
      this.write(run.runId, run);
      marked += 1;
    }
    return marked;
  }
}
