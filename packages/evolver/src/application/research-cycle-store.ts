/**
 * Research Cycle store: the single persisted Phase2 loop fact source per research.
 *
 * Plan: docs/mvp/redesign-2026-10-08/PHASE2-RESEARCH-LOOP-BRIEF-PLAN-2026-10-10.md,
 * architecture §4/§6: `<workspace>/.dsh/research/cycles/<researchId>/` with
 * `state.json` (runs, steps, artifact registry, graph increments, receipts) and
 * `artifacts/` (immutable content-addressed publications).
 *
 * Guarantees mirror the verified bootstrap store, because they solve the same
 * problems and have already survived real-host runs:
 * - Every write takes a real cross-process lock file (O_EXCL, bounded wait,
 *   no age-based takeover), then RE-READS the state and compares the base revision.
 * - One atomic temp-file + rename replacement per change; a failed write leaves
 *   the previous state untouched.
 * - Receipt replay happens BEFORE the CAS: same operationId + same semantic
 *   request replays the original result without writing; a different request is
 *   an IDEMPOTENCY_CONFLICT.
 * - A missing file means "no cycle yet" (empty state, revision 0). A corrupt or
 *   foreign-schema file is STATE_CORRUPT — reported loudly, never overwritten.
 * - Publications are content-addressed and written with 'wx'; existing bytes must
 *   be byte-identical or the write is ARTIFACT_CORRUPT.
 *
 * This store never touches the bootstrap state file, the paper library, or any
 * team journal — those keep their own facts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { ExperimentError } from '../contracts/experiments.ts';
import type { ArtifactRef } from '../contracts/experiments.ts';
import {
  CycleError,
  emptyCycleState,
  validateCycleState,
  cycleRequestHash,
  type CycleState,
  type OperationReceipt,
} from '../contracts/research-cycle.ts';

export interface ResearchCycleStoreOptions {
  lockTimeoutMs?: number;
  /** Deprecated compatibility option. Lock age never authorizes takeover. */
  staleLockMs?: number;
  lockPollIntervalMs?: number;
  now?: () => Date;
}

export interface CycleMutationContext {
  /** Draft clone of the current state; mutate freely — any throw discards it. */
  state: CycleState;
  now: () => string;
  mint: (prefix: string) => string;
  requestHash: string;
}

export interface CycleMutationOutcome<R> {
  /** false = semantic no-op (e.g. replayed signature); no revision, no receipt. */
  changed: boolean;
  result: R;
}

export interface CycleMutationRequest<R> {
  operationId: string;
  /** Receipt kind, e.g. "start_cycle" | "submit_step_result" | "apply_cycle_decision". */
  kind: string;
  researchId: string;
  /** Cycle revision the caller based its decision on; 0 when the state does not exist. */
  baseRevision: number;
  /** Semantic request hash input; must not contain baseRevision or actor identity. */
  requestPayload: Record<string, unknown>;
  apply: (context: CycleMutationContext) => CycleMutationOutcome<R>;
}

export interface CycleMutationResult<R> {
  result: R;
  revision: number;
  replayed: boolean;
}

const OPERATION_ID_MAX = 200;
const RECEIPT_KIND_MAX = 100;

export class ResearchCycleStore {
  readonly workspaceRoot: string;
  readonly researchId: string;
  readonly cycleDir: string;
  readonly stateFile: string;
  readonly artifactsDir: string;
  private readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollIntervalMs: number;
  private readonly clock: () => Date;

  constructor(workspaceRoot: string, researchId: string, options: ResearchCycleStoreOptions = {}) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot.trim().length === 0) {
      throw new CycleError('INVALID_INPUT', 'workspaceRoot is required and comes from trusted host context');
    }
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.researchId = researchId;
    this.cycleDir = path.join(this.workspaceRoot, '.dsh', 'research', 'cycles', researchId);
    this.stateFile = path.join(this.cycleDir, 'state.json');
    this.artifactsDir = path.join(this.cycleDir, 'artifacts');
    this.lockPath = path.join(this.cycleDir, '.writer.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockPollIntervalMs = options.lockPollIntervalMs ?? 25;
    this.clock = options.now ?? (() => new Date());
  }

  // ------------------------------------------------------------------ reads

  /** null = no cycle state for this research yet. Corrupt files throw STATE_CORRUPT. */
  readState(): CycleState | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.stateFile, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      if (code === 'EISDIR') throw new CycleError('STATE_CORRUPT', 'cycle state path is occupied by a directory');
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new CycleError('STATE_CORRUPT', `cycle state.json is not valid JSON: ${String(error)}`);
    }
    const state = validateCycleState(parsed);
    if (state.researchId !== this.researchId) {
      throw new CycleError('STATE_CORRUPT', `cycle state belongs to research ${state.researchId}, not ${this.researchId}`);
    }
    return state;
  }

  readStateOrEmpty(): CycleState {
    return this.readState() ?? emptyCycleState(this.researchId);
  }

  // ------------------------------------------------------------------ publications

  /**
   * Immutable content-addressed publication. The id is a store-relative locator
   * (`artifacts/<sha256>.json`), never an arbitrary filesystem path. Existing bytes
   * must be identical; publication never rewrites content.
   */
  publishArtifact(value: unknown): ArtifactRef {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const id = `artifacts/${sha256}.json`;
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    const file = path.join(this.artifactsDir, `${sha256}.json`);
    if (fs.existsSync(file)) {
      if (!fs.readFileSync(file).equals(bytes)) throw new ExperimentError('ARTIFACT_CORRUPT', 'Existing cycle publication differs');
    } else {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    return { id, sha256 };
  }

  /** Reads publication bytes and verifies their hash. Locator must be store-scoped. */
  readArtifact(ref: ArtifactRef): Buffer {
    if (ref.id !== `artifacts/${ref.sha256}.json`) {
      throw new CycleError('POLICY_DENIED', 'ref is outside this cycle store namespace');
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(this.artifactsDir, `${ref.sha256}.json`));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') throw new CycleError('NOT_FOUND', `publication ${ref.sha256.slice(0, 12)}… is not in this cycle store`);
      throw error;
    }
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      throw new CycleError('SOURCE_STALE', 'cycle publication bytes do not match their ref');
    }
    return bytes;
  }

  /** Reads and parses a publication as strict JSON. */
  readArtifactJson(ref: ArtifactRef): unknown {
    return JSON.parse(this.readArtifact(ref).toString('utf8'));
  }

  // ------------------------------------------------------------------ write engine

  /** One locked, idempotent, CAS-guarded state change (see class doc). */
  mutate<R>(request: CycleMutationRequest<R>): CycleMutationResult<R> {
    if (typeof request.operationId !== 'string' || request.operationId.trim().length === 0 || request.operationId.length > OPERATION_ID_MAX) {
      throw new CycleError('INVALID_INPUT', `operationId must be a stable non-empty id of at most ${OPERATION_ID_MAX} characters`);
    }
    if (typeof request.kind !== 'string' || request.kind.trim().length === 0 || request.kind.length > RECEIPT_KIND_MAX) {
      throw new CycleError('INVALID_INPUT', 'receipt kind is required');
    }
    if (!Number.isSafeInteger(request.baseRevision) || request.baseRevision < 0) {
      throw new CycleError('INVALID_INPUT', 'baseRevision must be a non-negative safe integer (0 when the state does not exist yet)');
    }
    if (typeof request.requestPayload !== 'object' || request.requestPayload === null || Array.isArray(request.requestPayload)) {
      throw new CycleError('INVALID_INPUT', 'requestPayload must be an object');
    }
    if (typeof request.apply !== 'function') throw new CycleError('INVALID_INPUT', 'apply callback is required');
    return this.withLock(() => {
      const current = this.readStateOrEmpty();
      const requestHash = cycleRequestHash(request.requestPayload);
      const existing = current.receipts.find((receipt) => receipt.operationId === request.operationId);
      if (existing !== undefined) {
        if (existing.requestHash === requestHash) {
          return { result: existing.result as R, revision: existing.resultRevision, replayed: true };
        }
        throw new CycleError('IDEMPOTENCY_CONFLICT',
          `operationId "${request.operationId}" was already used with a different request (stored ${existing.requestHash.slice(0, 12)}…, this ${requestHash.slice(0, 12)}…); mint a new operationId for new work`);
      }
      if (current.revision !== request.baseRevision) {
        throw new CycleError('REVISION_CONFLICT',
          `cycle state is at revision ${current.revision} but the request was based on ${request.baseRevision}; re-read the state and retry with the SAME operationId`);
      }
      const draft = structuredClone(current) as CycleState;
      const now = () => this.clock().toISOString();
      const outcome = request.apply({ state: draft, now, mint: (prefix) => `${prefix}-${randomUUID()}`, requestHash });
      if (outcome.result === undefined || typeof outcome.result !== 'object' || outcome.result === null || Array.isArray(outcome.result)) {
        throw new CycleError('INVALID_INPUT', 'mutation result must be a plain JSON object');
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
      // Validate the FULL next state before it touches disk.
      const validated = validateCycleState(draft);
      this.writeState(validated);
      return { result: outcome.result, revision: draft.revision, replayed: false };
    });
  }

  // ------------------------------------------------------------------ internals

  private writeState(state: CycleState): void {
    try {
      fs.mkdirSync(this.cycleDir, { recursive: true });
      const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
      try {
        fs.renameSync(temporary, this.stateFile);
      } catch (error) {
        try { fs.rmSync(temporary, { force: true }); } catch { /* the rename failure is the one to report */ }
        throw new CycleError('STATE_WRITE_FAILED', `atomic cycle state replacement failed: ${String(error)}`);
      }
    } catch (error) {
      if (error instanceof CycleError) throw error;
      throw new CycleError('STATE_WRITE_FAILED', `cycle state write failed: ${String(error)}`);
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
   * Cross-process writer lock with the same semantics as the bootstrap store:
   * O_EXCL create, bounded wait, no age-based takeover, closed handle (Windows EPERM
   * lessons from the bootstrap store's BR-10 run are already baked in).
   */
  private acquireLock(): string {
    fs.mkdirSync(this.cycleDir, { recursive: true });
    const deadline = Date.now() + this.lockTimeoutMs;
    const token = randomUUID();
    for (;;) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
        } finally {
          fs.closeSync(fd);
        }
        return token;
      } catch (error) {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* acquisition failed anyway */ } }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
        if (Date.now() >= deadline) {
          let holder = 'unknown';
          try { holder = String((JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: number }).pid); } catch { /* unreadable lock */ }
          throw new CycleError('HOST_BUSY', `another cycle writer (pid ${holder}) holds the research lock; retry after it finishes`);
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.lockPollIntervalMs);
      }
    }
  }

  private releaseLock(token: string): void {
    try {
      const raw = fs.readFileSync(this.lockPath, 'utf8');
      const lock = JSON.parse(raw) as { token?: string };
      if (lock.token !== token) {
        throw new CycleError('LOCK_STALE', 'cycle writer lock changed hands unexpectedly; inspect the .writer.lock');
      }
      fs.rmSync(this.lockPath, { force: true });
    } catch (error) {
      if (error instanceof CycleError) throw error;
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT') throw error;
    }
  }
}
