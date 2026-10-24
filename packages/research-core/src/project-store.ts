import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ResearchCoreError, validateResearchProjectState, type ResearchProjectState } from '../../research-contracts/src/index.ts';

export interface MutationBody<T> {
  result: T;
  revision: number;
  replayed: boolean;
  projectId: string;
}

export interface AppliedMutation<T> {
  state: ResearchProjectState;
  result: T;
  unchanged?: boolean;
}
import { resolveResearchRoot } from './root.ts';
import { activeStore } from './active-store.ts';

export interface ProjectStoreOptions {
  lockTimeoutMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
}

export class ProjectStore {
  readonly workspaceDir: string;
  private readonly researchDir: string;
  private readonly projectFile: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollIntervalMs: number;
  private readonly clock: () => Date;

  constructor(workspaceDir: string, options: ProjectStoreOptions = {}) {
    const root = resolveResearchRoot(workspaceDir);
    this.workspaceDir = root.workspaceDir;
    this.researchDir = root.researchDir;
    this.projectFile = root.projectFile;
    this.lockPath = path.join(this.researchDir, '.writer.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 500;
    this.lockPollIntervalMs = options.lockPollIntervalMs ?? 15;
    this.clock = options.now ?? (() => new Date());
  }

  now(): string {
    return this.clock().toISOString();
  }

  exists(): boolean {
    return fs.existsSync(this.projectFile);
  }

  /** Missing project is null. Truncated or foreign JSON is STATE_CORRUPT and is not replaced. */
  read(): ResearchProjectState | null {
    if (activeStore(this.workspaceDir)) throw new ResearchCoreError('INVALID_INPUT', 'ACTIVE_STORE_BOOTSTRAP: use workspace queries; prototype records are historical after migration');
    if (!fs.existsSync(this.projectFile)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.projectFile, 'utf8'));
    } catch (error) {
      throw new ResearchCoreError('STATE_CORRUPT', `project.json is not valid JSON: ${String(error)}`);
    }
    // The first standalone prototype wrote schemaVersion=1 before stateHash existed.
    // Read that exact format without writing; upgrading requires an explicit migration.
    const unhashed = typeof parsed === 'object' && parsed !== null && !Object.hasOwn(parsed, 'stateHash');
    const validated = validateResearchProjectState(unhashed ? { ...(parsed as Record<string, unknown>), stateHash: '0'.repeat(64) } : parsed);
    const actual = requestHash(withoutStateHash(validated));
    if (unhashed) return { ...validated, stateHash: actual };
    if (validated.stateHash !== actual) {
      throw new ResearchCoreError('STATE_CORRUPT', 'project stateHash does not match the stored project');
    }
    return validated;
  }

  needsMigration(): boolean {
    if (!this.exists()) return false;
    this.read();
    return !Object.hasOwn(JSON.parse(fs.readFileSync(this.projectFile, 'utf8')), 'stateHash');
  }

  migrate(): { migrated: boolean; backupPath: string | null } {
    const token = this.acquireLock();
    try {
      this.assertWritableAuthority();
      const current = this.read();
      if (!current) throw new ResearchCoreError('NOT_FOUND', 'research project does not exist');
      if (!this.needsMigration()) return { migrated: false, backupPath: null };
      const backupPath = `${this.projectFile}.pre-state-hash.${crypto.randomUUID()}.bak`;
      fs.copyFileSync(this.projectFile, backupPath, fs.constants.COPYFILE_EXCL);
      this.write(current);
      return { migrated: true, backupPath };
    } finally {
      this.releaseLock(token);
    }
  }

  mutate(work: (current: ResearchProjectState | null) => ResearchProjectState | null): ResearchProjectState {
    this.assertWritableAuthority();
    const token = this.acquireLock();
    try {
      this.assertWritableAuthority();
      const current = this.read();
      if (this.needsMigration()) throw new ResearchCoreError('INVALID_INPUT', 'project requires explicit migrate before writes; the old project will be backed up');
      const next = work(current);
      if (next === null) {
        if (current === null) throw new ResearchCoreError('NOT_FOUND', 'research project does not exist');
        return current;
      }
      const validated = validateResearchProjectState({ ...next, stateHash: '0'.repeat(64) });
      validated.stateHash = requestHash(withoutStateHash(validated));
      this.write(validated);
      return validated;
    } finally {
      this.releaseLock(token);
    }
  }

  private assertWritableAuthority(): void {
    if (activeStore(this.workspaceDir)) throw new ResearchCoreError('INVALID_INPUT', 'ACTIVE_STORE_BOOTSTRAP: use workspace actions; prototype writes are disabled to prevent two authorities');
  }

  private write(state: ResearchProjectState): void {
    fs.mkdirSync(this.researchDir, { recursive: true });
    const temporary = `${this.projectFile}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      fs.renameSync(temporary, this.projectFile);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* rename or write is the reported failure */ }
      if (error instanceof ResearchCoreError) throw error;
      throw new ResearchCoreError('STATE_WRITE_FAILED', `project state write failed: ${String(error)}`);
    }
  }

  /**
   * Lock file is exclusive for this process. Age does not make it free: a slow writer keeps it
   * until that process releases the token. Callers see HOST_BUSY instead of a silent takeover.
   */
  private acquireLock(): string {
    fs.mkdirSync(this.researchDir, { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = crypto.randomUUID();
    for (;;) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }));
        } finally {
          fs.closeSync(fd);
        }
        return token;
      } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* acquisition already failed */ } }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
        if (Date.now() >= deadline) {
          throw new ResearchCoreError('HOST_BUSY', 'another research writer holds .research/.writer.lock');
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.lockPollIntervalMs);
      }
    }
  }

  private releaseLock(token: string): void {
    try {
      const lock = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { token?: string };
      if (lock.token !== token) throw new ResearchCoreError('HOST_BUSY', 'research writer lock changed before release');
      fs.rmSync(this.lockPath, { force: true });
    } catch (error) {
      if (error instanceof ResearchCoreError) throw error;
    }
  }
}

export function commitOperation<T extends Record<string, unknown>>(
  store: ProjectStore,
  operationId: string,
  kind: string,
  payload: unknown,
  apply: (current: ResearchProjectState | null) => AppliedMutation<T>,
): MutationBody<T> {
  if (typeof operationId !== 'string' || operationId.trim().length === 0 || operationId.length > 200) {
    throw new ResearchCoreError('INVALID_INPUT', 'operationId must be non-empty text of at most 200 characters');
  }
  const hash = requestHash(payload);
  let body: MutationBody<T> | undefined;
  store.mutate((current) => {
    const prior = current?.receipts.find((receipt) => receipt.operationId === operationId);
    if (prior) {
      if (prior.requestHash !== hash || prior.kind !== kind) {
        throw new ResearchCoreError('IDEMPOTENCY_CONFLICT', `operation ${operationId} was already recorded with a different request`);
      }
      if (!current) throw new ResearchCoreError('STATE_CORRUPT', 'receipt exists without a project');
      body = { result: prior.result as T, revision: current.revision, replayed: true, projectId: current.projectId };
      return null;
    }
    const applied = apply(current);
    if (applied.unchanged) {
      body = { result: applied.result, revision: applied.state.revision, replayed: false, projectId: applied.state.projectId };
      return null;
    }
    applied.state.revision += 1;
    applied.state.receipts.push({
      operationId,
      kind,
      requestHash: hash,
      resultRevision: applied.state.revision,
      result: applied.result,
      createdAt: store.now(),
    });
    body = { result: applied.result, revision: applied.state.revision, replayed: false, projectId: applied.state.projectId };
    return applied.state;
  });
  if (!body) throw new ResearchCoreError('STATE_WRITE_FAILED', 'mutation produced no result');
  return body;
}

function withoutStateHash(state: ResearchProjectState): Omit<ResearchProjectState, 'stateHash'> {
  const { stateHash: _stateHash, ...rest } = state;
  return rest;
}

export function requestHash(payload: unknown): string {
  return crypto.createHash('sha256').update(canonical(payload)).digest('hex');
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function sha256File(filePath: string): { sha256: string; bytes: number } {
  const data = fs.readFileSync(filePath);
  return { sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.byteLength };
}
