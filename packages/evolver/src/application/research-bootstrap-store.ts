/**
 * Research Bootstrap store: the single persisted fact source per workspace.
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-SHARED-SPEC-2026-10-10.md §2,
 * docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-02-GRAPH-SPEC-2026-10-10.md §2.
 *
 * File: `<workspace>/.dsh/research/bootstrap/state.json` (schemaVersion 1).
 *
 * Guarantees (all enforced here, none delegated to callers):
 * - Every write takes a real cross-process lock file (`O_EXCL`), then RE-READS the state and
 *   compares `baseRevision`. A single-process memory Map is never trusted for concurrency.
 * - One atomic temp-file + rename replacement per change; a failed or thrown write leaves the
 *   previous state file untouched, so a crashed writer cannot half-commit or fake a receipt.
 * - `operationId` receipts are checked BEFORE the CAS: same operationId + same semantic request
 *   replays the original result without writing; same operationId + different request is an
 *   `IDEMPOTENCY_CONFLICT`. Receipts are append-only (bounded operation volume this round; no
 *   compaction), so retries and replays can never re-execute an old write.
 * - A missing file means "not started yet" (empty state, revision 0). A corrupt, unreadable or
 *   foreign-schema file is `STATE_CORRUPT` — reported loudly, never silently treated as empty
 *   and overwritten.
 *
 * BE-01 consumes this store through `mutate`; it must not build a second persistence layer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BootstrapError,
  emptyBootstrapState,
  validateBootstrapState,
  bootstrapContentHash,
  type BootstrapState,
  type OperationReceipt,
  type ResearchBootstrap,
} from '../contracts/research-bootstrap.ts';

export interface ResearchBootstrapStoreOptions {
  /** How long a writer waits for a competing lock before reporting HOST_BUSY. */
  lockTimeoutMs?: number;
  /** Age at which an orphaned lock file (crashed writer) may be taken over. */
  staleLockMs?: number;
  /** Lock poll interval; tests lower it together with the timeouts. */
  lockPollIntervalMs?: number;
  now?: () => Date;
}

export interface MutationContext {
  /** Draft clone of the current state; mutate freely — it is discarded on any throw. */
  state: BootstrapState;
  now: () => string;
  mint: (prefix: string) => string;
  /** Hash of the semantic request; also stored on the receipt. */
  requestHash: string;
}

export interface MutationOutcome<R> {
  /** false = the request was a no-op (e.g. signature reuse); no revision, no receipt. */
  changed: boolean;
  result: R;
}

export interface MutationRequest<R> {
  operationId: string;
  /** Receipt kind, e.g. "save_contract" | "initialize_graph" | "set_slot_component". */
  kind: string;
  researchId: string | null;
  /** Revision the caller based its decision on; 0 for "state does not exist yet". */
  baseRevision: number;
  /**
   * Semantic request used for the idempotency hash. Must NOT contain baseRevision (a stale-base
   * retry with the same semantics must stay the same operation) and must never contain owner,
   * actor or path fields — those come from trusted context, never from a request.
   */
  requestPayload: Record<string, unknown>;
  apply: (context: MutationContext) => MutationOutcome<R>;
}

export interface MutationResult<R> {
  result: R;
  revision: number;
  replayed: boolean;
}

const OPERATION_ID_MAX = 200;
const RECEIPT_KIND_MAX = 100;

/** Hash over the semantic request; key order irrelevant, baseRevision excluded by the caller. */
export function bootstrapRequestHash(payload: Record<string, unknown>): string {
  return bootstrapContentHash('research-bootstrap-request-v1', payload);
}

export function findResearch(state: BootstrapState, researchId: string): ResearchBootstrap | undefined {
  return state.researches.find((research) => research.researchId === researchId);
}

export function requireResearch(state: BootstrapState, researchId: string): ResearchBootstrap {
  const research = findResearch(state, researchId);
  if (research === undefined) {
    throw new BootstrapError('NOT_FOUND', `no research "${researchId}" exists in this workspace's bootstrap state`);
  }
  return research;
}

/**
 * Creates a research inside the locked draft state. The FIRST research becomes activeResearchId
 * automatically; later switches are explicit user actions, never "most recently updated".
 */
export function createResearch(state: BootstrapState, input: { title: string; now: string; mint: (prefix: string) => string }): ResearchBootstrap {
  if (state.researches.length >= 50) {
    throw new BootstrapError('SCHEMA_VIOLATION', 'workspace bootstrap state has reached its research limit');
  }
  const research: ResearchBootstrap = {
    researchId: input.mint('research'),
    title: input.title,
    contract: {
      revision: 1,
      status: 'draft',
      researchQuestion: null,
      goal: null,
      baseline: { status: 'undecided', name: null, paperRef: null, repoLocator: null },
      dataDescription: null,
      metrics: [],
      guardrails: [],
      editableScope: [],
      lockedScope: [],
      computeBudget: null,
      timeBudget: null,
      autonomy: 'plan_only',
      pendingQuestions: [],
      confirmations: [],
      updatedAt: input.now,
    },
    environment: [],
    brainstormRuns: [],
    ideas: [],
    graph: null,
    selectionProof: null,
    updatedAt: input.now,
  };
  state.researches.push(research);
  if (state.activeResearchId === null) state.activeResearchId = research.researchId;
  return research;
}

export class ResearchBootstrapStore {
  readonly workspaceRoot: string;
  readonly bootstrapDir: string;
  readonly stateFile: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockPollIntervalMs: number;
  private readonly clock: () => Date;

  constructor(workspaceRoot: string, options: ResearchBootstrapStoreOptions = {}) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw new BootstrapError('INVALID_INPUT', 'workspaceRoot is required and comes from trusted host context');
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.bootstrapDir = path.join(this.workspaceRoot, '.dsh', 'research', 'bootstrap');
    this.stateFile = path.join(this.bootstrapDir, 'state.json');
    this.lockPath = path.join(this.bootstrapDir, '.writer.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.staleLockMs = options.staleLockMs ?? 60_000;
    this.lockPollIntervalMs = options.lockPollIntervalMs ?? 25;
    this.clock = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ reads

  /**
   * null means "bootstrap not started in this workspace". Anything present but not a valid
   * schemaVersion-1 state is STATE_CORRUPT with the reason — the caller must surface it, never
   * fall back to an empty state.
   */
  readState(): BootstrapState | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.stateFile, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      if (code === 'EISDIR') throw new BootstrapError('STATE_CORRUPT', 'bootstrap state path is occupied by a directory');
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new BootstrapError('STATE_CORRUPT', `bootstrap state.json is not valid JSON: ${String(error)}`);
    }
    return validateBootstrapState(parsed);
  }

  /** Missing file ⇒ empty state (revision 0); corrupt file still throws. */
  readStateOrEmpty(): BootstrapState {
    return this.readState() ?? emptyBootstrapState();
  }

  listReceipts(researchId?: string): OperationReceipt[] {
    const state = this.readStateOrEmpty();
    return researchId === undefined ? state.receipts : state.receipts.filter((receipt) => receipt.researchId === researchId);
  }

  // ------------------------------------------------------------------ write engine

  /**
   * One locked, idempotent, CAS-guarded state change. Order inside the lock:
   * 1. receipt replay/conflict check (same operationId + same request ⇒ original result, no write),
   * 2. optimistic revision check (`REVISION_CONFLICT` with the current revision so the caller can
   *    re-read and merge instead of overwriting),
   * 3. the apply callback mutates a DRAFT clone — any throw discards it, zero facts are written,
   * 4. full state validation, receipt append, atomic replace.
   */
  mutate<R>(request: MutationRequest<R>): MutationResult<R> {
    if (typeof request.operationId !== 'string' || request.operationId.trim().length === 0 || request.operationId.length > OPERATION_ID_MAX) {
      throw new BootstrapError('INVALID_INPUT', `operationId must be a stable non-empty id of at most ${OPERATION_ID_MAX} characters`);
    }
    if (typeof request.kind !== 'string' || request.kind.trim().length === 0 || request.kind.length > RECEIPT_KIND_MAX) {
      throw new BootstrapError('INVALID_INPUT', 'receipt kind is required');
    }
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
      throw new BootstrapError('INVALID_INPUT', 'baseRevision must be a non-negative safe integer (0 when the state does not exist yet)');
    }
    if (typeof request.requestPayload !== 'object' || request.requestPayload === null || Array.isArray(request.requestPayload)) {
      throw new BootstrapError('INVALID_INPUT', 'requestPayload must be an object');
    }
    if (typeof request.apply !== 'function') throw new BootstrapError('INVALID_INPUT', 'apply callback is required');
    return this.withLock(() => {
      const current = this.readStateOrEmpty();
      const requestHash = bootstrapRequestHash(request.requestPayload);
      const existing = current.receipts.find((receipt) => receipt.operationId === request.operationId);
      if (existing !== undefined) {
        if (existing.requestHash === requestHash) {
          return { result: existing.result as R, revision: existing.resultRevision, replayed: true };
        }
        throw new BootstrapError('IDEMPOTENCY_CONFLICT',
          `operationId "${request.operationId}" was already used with a different request (stored hash ${existing.requestHash.slice(0, 12)}…, this hash ${requestHash.slice(0, 12)}…); mint a new operationId for new work`);
      }
      if (current.revision !== request.baseRevision) {
        throw new BootstrapError('REVISION_CONFLICT',
          `bootstrap state is at revision ${current.revision} but the request was based on ${request.baseRevision}; re-read the state, merge your change and retry with the SAME operationId`);
      }
      const draft = structuredClone(current) as BootstrapState;
      const now = () => this.clock().toISOString();
      const outcome = request.apply({ state: draft, now, mint: (prefix) => `${prefix}-${randomUUID()}`, requestHash });
      if (outcome.result === undefined || typeof outcome.result !== 'object' || outcome.result === null || Array.isArray(outcome.result)) {
        throw new BootstrapError('INVALID_INPUT', 'mutation result must be a plain JSON object');
      }
      if (!outcome.changed) {
        return { result: outcome.result, revision: current.revision, replayed: false };
      }
      draft.revision = current.revision + 1;
      const receipt: OperationReceipt = {
        operationId: request.operationId,
        kind: request.kind,
        researchId: request.researchId,
        requestHash,
        resultRevision: draft.revision,
        result: outcome.result as Record<string, unknown>,
        createdAt: now(),
      };
      draft.receipts.push(receipt);
      // Validate the FULL next state before it touches disk: a committed file can always be read back.
      const validated = validateBootstrapState(draft);
      this.writeState(validated);
      return { result: outcome.result, revision: draft.revision, replayed: false };
    });
  }

  // ------------------------------------------------------------------ internals

  private writeState(state: BootstrapState): void {
    try {
      fs.mkdirSync(this.bootstrapDir, { recursive: true });
      const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      try {
        fs.renameSync(temporary, this.stateFile);
      } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* the rename failure is the one to report */ }
        throw new BootstrapError('STATE_WRITE_FAILED', `atomic bootstrap state replacement failed: ${String(error)}`);
      }
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      throw new BootstrapError('STATE_WRITE_FAILED', `bootstrap state write failed: ${String(error)}`);
    }
  }

  private withLock<T>(work: () => T): T {
    const token = this.acquireLock();
    try {
      return work();
    } finally {
      this.releaseLock(token);
    }
  }

  /**
   * Cross-process writer lock: an `O_EXCL` lock file with bounded wait, stale takeover and owner
   * verification on release. A crashed writer's lock is taken over after `staleLockMs`; a live
   * competitor produces HOST_BUSY with its recorded pid so operators can see who holds it.
   */
  private acquireLock(): string {
    // The lock file lives beside the state file; make sure the folder exists before O_EXCL.
    fs.mkdirSync(this.bootstrapDir, { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    for (;;) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
        } finally {
          // CRITICAL: the handle must close. The lock is PATH-based (O_EXCL create + rmSync on
          // release); leaving the fd open keeps an exclusive file handle alive for the whole
          // process lifetime, so every OTHER store instance's openSync/read on this file fails
          // with EPERM — the exact multi-action deadlock the BR-10 real-host run hit
          // (start_research ok, then probe/generate EPERM).
          fs.closeSync(fd);
        }
        return token;
      } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* acquisition failed anyway */ } }
        const code = (error as NodeJS.ErrnoException).code;
        // EEXIST = a live competitor. EPERM/EACCES = Windows holding a fighting handle (or an
        // antivirus scan) — treated the same: bounded wait, then stale takeover / HOST_BUSY.
        // Any other error is a real failure and is thrown.
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
        if (this.lockIsStale()) {
          try { fs.rmSync(this.lockPath, { force: true }); continue; } catch { /* fall through to wait */ }
        }
        if (Date.now() >= deadline) {
          let holder = 'unknown';
          try { holder = String((JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: number }).pid); } catch { /* unreadable lock */ }
          throw new BootstrapError('HOST_BUSY', `another bootstrap writer (pid ${holder}) holds the workspace lock; retry after it finishes`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.lockPollIntervalMs);
      }
    }
  }

  private lockIsStale(): boolean {
    try {
      const stats = fs.statSync(this.lockPath);
      return Date.now() - stats.mtimeMs > this.staleLockMs;
    } catch {
      return false; // gone already — the next loop attempt will simply take it
    }
  }

  private releaseLock(token: string): void {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      const lock = JSON.parse(raw) as { token?: string };
      if (lock.token !== token) {
        throw new BootstrapError('LOCK_STALE', 'bootstrap writer lock changed hands unexpectedly; inspect .dsh/research/bootstrap/.writer.lock');
      }
      fs.rmSync(this.lockPath, { force: true });
    } catch (error) {
      if (error instanceof BootstrapError) throw error;
      // A missing lock at release time means someone took it over; the state itself is CAS-guarded.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') throw error;
    }
  }
}
