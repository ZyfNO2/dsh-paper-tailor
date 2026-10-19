/**
 * The sidecar publication coordinator: ONE durable commit point for every
 * workbench task and diagram write.
 *
 * Round-2 defect (SPEC section 1.1)
 * ---------------------------------
 * Three properties were missing and each had already produced a real failure:
 *
 *  1. **No durable intent.** The registrar froze objects and then wrote its
 *     idempotency index. A failure between the two left immutable bytes on disk
 *     with no record of which command produced them, so a retry could adopt a
 *     MODIFIED scratch file and a reader could treat an uncommitted draft as
 *     committed. The intent now lands BEFORE any object is written and records
 *     the exact input hashes, so a retry compares against what was actually
 *     frozen rather than against whatever the scratch holds now.
 *
 *  2. **No shared write coordination.** `WorkbenchResearchService` serialized
 *     writers with an in-process promise map and the registrar with a separate
 *     lock file. Two Host instances could therefore both hold a write lease on
 *     one root and interleave a register with an attach. There is now one lease
 *     per root, taken by whoever writes, and a second writer is refused.
 *
 *  3. **No single visible commit point.** Task snapshots, diagram drafts and
 *     receipts were each committed by their own index flip, so an object could be
 *     visible through one reader and absent through another. Every v2 task and
 *     publication result is now recorded in ONE root commit index; the per-file
 *     indexes are rebuildable caches derived from it.
 *
 * What it deliberately is NOT: a general transaction framework, a queue, or a
 * service. It is a sidecar-scoped commit point with a lease, and it reuses the
 * storage idioms already in `workbench-research-service.ts` rather than
 * abstracting across them (see that file's "Reuse, not duplication").
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { WorkbenchContractError, type WorkbenchBoundRef } from '../contracts/workbench.ts';

export const PUBLICATION_INDEX_SCHEMA_VERSION = 2 as const;
export const PUBLICATION_INDEX_BASENAME = 'publications-v2.json';

const PROCESS_IDENTITY = `${process.pid}-${randomUUID().slice(0, 8)}`;

export interface PublicationArtifactIdentity {
  /** Relative to the single published root, `/`-separated. */
  id: string;
  sha256: string;
  /** False for a legitimately absent optional dependency (a missing sidecar). */
  present: boolean;
}

export interface PublicationCommandIntent {
  schemaVersion: 2;
  /** Canonical `[ownerSessionId, action, commandId]` serialization. */
  key: string;
  ownerSessionId: string;
  action: string;
  commandId: string;
  taskId: string;
  /** Allocated BEFORE anything is written, so a retry reuses one operation. */
  operationId: string;
  requestBaseHash: string;
  requestHash: string;
  /** The task/candidate/variant/graph pins the caller named, and the CAS value. */
  expectedDesignRevision: number;
  candidateKey: string;
  variantKey: string | null;
  semanticGraphRef: WorkbenchBoundRef;
  semanticHash: string;
  format: string;
  createdAt: string;
  state: 'prepared' | 'frozen' | 'committed';
  /**
   * Recorded AFTER the first freeze and never rewritten by a later attempt.
   *
   * SPEC section R2.4: "已冻结结果不再由新 scratch 替代". A retry compares the
   * bytes the scratch holds now against these, so a modified scratch conflicts
   * instead of being adopted as if it were the frozen result.
   */
  artifactSet?: PublicationArtifactIdentity[];
  artifactSetHash?: string;
  frozenAt?: string;
  committedAt?: string;
}

export interface CommittedPublication {
  operationId: string;
  key: string;
  ownerSessionId: string;
  commandId: string;
  taskId: string;
  requestBaseHash: string;
  requestHash: string;
  receipt: Record<string, unknown>;
  /** The COMPLETE artifact set; a replay must find every one of them intact. */
  artifactSet: PublicationArtifactIdentity[];
  /** Covers the artifact set; recorded so a replay compares one value. */
  artifactSetHash: string;
  diagramDraftRef?: WorkbenchBoundRef;
  /** The task pointer this commit produced, when the commit advanced a task. */
  taskPointer?: { snapshotRef: WorkbenchBoundRef; designRevision: number };
  committedAt: string;
}

export interface PublicationCommitIndex {
  schemaVersion: typeof PUBLICATION_INDEX_SCHEMA_VERSION;
  /** Every committed publication, keyed by `owner::command`. */
  publications: Record<string, CommittedPublication>;
  /** Committed task snapshot pointers, keyed by taskId. */
  tasks: Record<string, { snapshotRef: WorkbenchBoundRef; designRevision: number }>;
}

const isHex = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isBoundRef = (value: unknown): value is WorkbenchBoundRef =>
  typeof value === 'object' && value !== null
  && (value as { store?: unknown }).store === 'workbench'
  && typeof (value as { ref?: { id?: unknown } }).ref?.id === 'string'
  && isHex((value as { ref?: { sha256?: unknown } }).ref?.sha256);

/**
 * The canonical command key: `[ownerSessionId, action, commandId]`.
 *
 * SPEC section 3.3 requires the canonical SERIALIZATION, not an ambiguous string
 * concatenation. `owner::command` is ambiguous the moment an owner or a command
 * contains the separator, and two different commands could then collide onto one
 * idempotency key and replay each other's receipt.
 */
export function canonicalCommandKey(parts: { ownerSessionId: string; action: string; commandId: string }): string {
  return JSON.stringify([parts.ownerSessionId, parts.action, parts.commandId]);
}

/**
 * The artifact set hash: every frozen object's filename, sha256 and size, in
 * filename order, plus an EXPLICIT marker for each optional file that is absent.
 *
 * SPEC section R2.4. Sorting by filename makes the hash independent of the order
 * the registrar happened to write the files, and the explicit absence marker
 * distinguishes "this diagram had no validation receipt" from "the receipt was
 * lost after commit" -- a distinction a bare list of present files cannot make,
 * and exactly the one a replay has to make.
 */
export function artifactSetHash(artifacts: PublicationArtifactIdentity[]): string {
  const canonical = [...artifacts]
    .map((a) => ({ name: a.id.split('/').pop() ?? a.id, id: a.id, sha256: a.present ? a.sha256 : null, present: a.present }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * The canonical request hash. Covers ONLY the request identity.
 *
 * SPEC section R2.3: the request hash must NOT include the output bytes. The old
 * registrar folded the main/mapping/receipt hashes into the replay comparison,
 * which conflated two different questions -- "is this the same command?" and
 * "are these the same bytes?" -- and made a retry after a failed commit compare
 * against whatever the scratch directory held at retry time. A retry could then
 * either conflict spuriously or, worse, adopt bytes that were never frozen.
 * Request identity lives here; frozen bytes live in the artifact set hash.
 */
export function canonicalRequestHash(request: Record<string, unknown>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
      return Object.fromEntries(entries.map(([k, v]) => [k, canonical(v)]));
    }
    return value;
  };
  return createHash('sha256').update(JSON.stringify(canonical(request))).digest('hex');
}

/** The shared coordinator per resolved root, so one Host has ONE writer state. */
const coordinators = new Map<string, PublicationCoordinator>();

/**
 * The coordinator for a store root.
 *
 * SPEC section 3.3: "同一 Host 中 service、publisher 和工具共享同一个 coordinator；
 * 不同实例不能各建独立 task 锁". Two instances in one process are the same Host,
 * so they MUST share one coordinator -- otherwise each builds its own task locks
 * and its own view of the lease, and the interleaving this round exists to
 * prevent comes straight back. A second PROCESS is a second Host and is refused
 * by the lease.
 */
export function coordinatorFor(root: string): PublicationCoordinator {
  const key = path.resolve(root);
  let existing = coordinators.get(key);
  if (existing === undefined) {
    existing = new PublicationCoordinator({ root: key });
    coordinators.set(key, existing);
  }
  return existing;
}

export class PublicationCoordinator {
  private readonly root: string;
  private readonly indexPath: string;
  private readonly intentsDir: string;
  private readonly leasePath: string;
  private readonly publishedRoot: string;
  /** This instance's lease identity, if it holds the write lease. */
  private heldLease: { nonce: string; identity: string } | null = null;
  /** Same-process command/root mutex; different processes contend on the file lease. */
  private readonly heldCommands = new Set<string>();

  constructor(opts: { root: string }) {
    this.root = path.resolve(opts.root);
    this.publishedRoot = path.resolve(this.root, 'published');
    this.indexPath = path.join(this.root, 'index', PUBLICATION_INDEX_BASENAME);
    this.intentsDir = path.join(this.root, 'intents');
    this.leasePath = path.join(this.root, 'leases', 'writer.lease');
    for (const dir of ['index', 'leases', 'intents']) {
      fs.mkdirSync(path.join(this.root, dir), { recursive: true });
    }
  }

  // ----------------- the write lease -----------------

  /**
   * Take the ONE write lease for this root.
   *
   * Refusing a second writer is the point. Two Hosts interleaving a register
   * with an attach on one root is exactly the interleaving the old in-process
   * promise map could not see, because neither Host knew about the other.
   */
  acquireWriteLease(identity: string): void {
    if (this.heldLease !== null) return;
    // Multiple service/publisher objects in the SAME Host process resolve to the
    // same coordinator instance through coordinatorFor(); the first call takes
    // the file lease and every later call is the same Host, not a competing Host.
    const owner = { pid: process.pid, identity, acquiredAt: new Date().toISOString(), nonce: randomUUID(), process: PROCESS_IDENTITY };
    const attempt = (): boolean => {
      try {
        const fd = fs.openSync(this.leasePath, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify(owner));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        this.heldLease = { nonce: owner.nonce, identity };
        return true;
      } catch (err) {
        if ((err as { code?: string }).code === 'EEXIST') return false;
        throw err;
      }
    };
    if (attempt()) return;

    let existing: { pid?: number; nonce?: string };
    try {
      existing = JSON.parse(fs.readFileSync(this.leasePath, 'utf8')) as { pid?: number; nonce?: string };
    } catch {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'workbench write lease is unreadable; refusing to write until it is reviewed', { retryable: false, fieldPaths: ['lease'] });
    }
    if (!Number.isInteger(existing.pid) || (existing.pid ?? 0) < 1 || typeof existing.nonce !== 'string') {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'workbench write lease has invalid owner data', { retryable: false, fieldPaths: ['lease'] });
    }
    let alive = false;
    try { process.kill(existing.pid!, 0); alive = true; }
    catch (err) { if ((err as { code?: string }).code !== 'ESRCH') alive = true; }
    if (alive) {
      throw new WorkbenchContractError(
        'HOST_BUSY',
        `workbench root ${this.root} already has a write Host (PID ${existing.pid}); this Host is read-only for that root`,
        { retryable: true, fieldPaths: ['lease'] },
      );
    }
    // The recorded owner is provably gone. Reclaim only if the bytes are still
    // the same lease we inspected.
    try {
      const current = JSON.parse(fs.readFileSync(this.leasePath, 'utf8')) as { nonce?: string };
      if (current.nonce !== existing.nonce) {
        throw new WorkbenchContractError('HOST_BUSY', 'workbench write lease changed during stale-owner recovery', { retryable: true, fieldPaths: ['lease'] });
      }
      fs.unlinkSync(this.leasePath);
    } catch (err) {
      if (err instanceof WorkbenchContractError) throw err;
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `cannot reclaim a dead write lease: ${err instanceof Error ? err.message : String(err)}`, { retryable: false, fieldPaths: ['lease'] });
    }
    if (!attempt()) {
      throw new WorkbenchContractError('HOST_BUSY', 'another Host acquired the workbench write lease during recovery', { retryable: true, fieldPaths: ['lease'] });
    }
  }

  releaseWriteLease(): void {
    if (this.heldLease === null) return;
    try {
      const current = JSON.parse(fs.readFileSync(this.leasePath, 'utf8')) as { nonce?: string };
      if (current.nonce !== this.heldLease.nonce) {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'workbench write lease ownership changed before release', { fieldPaths: ['lease'] });
      }
      fs.unlinkSync(this.leasePath);
    } catch (err) {
      if (err instanceof WorkbenchContractError) throw err;
      if ((err as { code?: string }).code !== 'ENOENT') {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `cannot release the workbench write lease: ${err instanceof Error ? err.message : String(err)}`, { fieldPaths: ['lease'] });
      }
    } finally {
      this.heldLease = null;
    }
  }

  /** Whether this instance currently holds the write lease for the root. */
  holdsWriteLease(): boolean {
    return this.heldLease !== null;
  }

  /**
   * Serialize one command/task write in this Host and reject recursive races.
   *
   * The root lease excludes other Host processes. This command set is the local
   * portion of SPEC's command -> task -> root-index lock order: service and
   * publisher use the same coordinator instance, so same-key registration and
   * attach cannot both observe an absent intent and race to allocate a different
   * operation.
   */
  runCommand<T>(key: string, operation: () => T): T {
    if (this.heldCommands.has(key)) {
      throw new WorkbenchContractError('HOST_BUSY', `command ${key} is already being written by this Host`, { retryable: true, fieldPaths: ['commandId'] });
    }
    this.heldCommands.add(key);
    let acquiredHere = false;
    try {
      acquiredHere = this.heldLease === null;
      this.acquireWriteLease(`command:${key}`);
      return operation();
    } finally {
      this.heldCommands.delete(key);
      // A long-lived Service already holds the root lease; a standalone publisher
      // takes and releases it around one command. In both cases the second Host
      // sees the file lease until the active owner is actually done.
      if (acquiredHere) this.releaseWriteLease();
    }
  }

  // ----------------- the root commit index -----------------

  /**
   * Read the ONE business-visible commit point.
   *
   * A damaged index is RECONCILIATION_REQUIRED and is never treated as empty:
   * silently starting from `{}` would make every previously committed result
   * invisible and let a re-registration mint a second operation for a command
   * that already succeeded.
   */
  readCommitIndex(): PublicationCommitIndex {
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8')) as unknown;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') {
        // An ABSENT index means "nothing committed yet" and is a legitimate
        // starting state. A path that cannot be a file (a directory occupies the
        // index path) is indistinguishable from absent for the READ path; the
        // WRITE path below is where an occupied index path fails, and that is
        // the honest commit boundary.
        return { schemaVersion: PUBLICATION_INDEX_SCHEMA_VERSION, publications: {}, tasks: {} };
      }
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `publication commit index is unreadable; refusing to replace it: ${err instanceof Error ? err.message : String(err)}`, { retryable: false, fieldPaths: ['commitIndex'] });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'publication commit index root is not an object; refusing to replace it', { retryable: false, fieldPaths: ['commitIndex'] });
    }
    const index = parsed as Record<string, unknown>;
    if (index.schemaVersion !== PUBLICATION_INDEX_SCHEMA_VERSION) {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `publication commit index schemaVersion ${String(index.schemaVersion)} is not ${PUBLICATION_INDEX_SCHEMA_VERSION}`, { retryable: false, fieldPaths: ['commitIndex'] });
    }
    const publications = index.publications;
    const tasks = index.tasks;
    if (typeof publications !== 'object' || publications === null || Array.isArray(publications)
      || typeof tasks !== 'object' || tasks === null || Array.isArray(tasks)) {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', 'publication commit index has a malformed publications/tasks section', { retryable: false, fieldPaths: ['commitIndex'] });
    }
    for (const [key, raw] of Object.entries(publications as Record<string, unknown>)) {
      const entry = raw as Partial<CommittedPublication>;
      if (typeof entry?.operationId !== 'string' || entry.key !== key
        || !isHex(entry.requestBaseHash) || !isHex(entry.requestHash)
        || !isHex(entry.artifactSetHash)
        || typeof entry.receipt !== 'object' || entry.receipt === null
        || !Array.isArray(entry.artifactSet) || entry.artifactSet.length === 0
        || !entry.artifactSet.every((a) => typeof a?.id === 'string' && isHex(a?.sha256) && typeof a?.present === 'boolean')) {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `publication commit index entry ${JSON.stringify(key)} is malformed`, { retryable: false, fieldPaths: ['commitIndex'] });
      }
      // The recorded artifact set hash must actually describe the recorded set;
      // otherwise the index would carry an identity no replay could ever match.
      if (artifactSetHash(entry.artifactSet) !== entry.artifactSetHash) {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `publication commit index entry ${JSON.stringify(key)} has an artifactSetHash that does not describe its artifactSet`, { retryable: false, fieldPaths: ['commitIndex'] });
      }
    }
    return index as unknown as PublicationCommitIndex;
  }

  /** Atomically replace the root commit index; this is the ONLY commit point. */
  writeCommitIndex(index: PublicationCommitIndex): void {
    const directory = path.dirname(this.indexPath);
    fs.mkdirSync(directory, { recursive: true });
    const tmp = `${this.indexPath}.${randomUUID().slice(0, 8)}.tmp`;
    const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8');
    let fd: number | null = null;
    try {
      fd = fs.openSync(tmp, 'wx');
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, this.indexPath);
      fsyncDirectory(directory);
    } catch (err) {
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot atomically commit the publication index: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['commitIndex'] });
    } finally {
      if (fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(tmp); } catch { /* renamed away or never created */ }
    }
  }

  /** The committed publication for an idempotency key, if any. */
  committedFor(key: string): CommittedPublication | null {
    return this.readCommitIndex().publications[key] ?? null;
  }

  // ----------------- durable command intents -----------------

  private intentPath(key: string): string {
    // The key is `owner::command`; hash it so any caller text stays out of a path.
    return path.join(this.intentsDir, `${createHash('sha256').update(key).digest('hex')}.intent.json`);
  }

  /**
   * Read a previously recorded intent, or null when the command never started.
   *
   * This is what a retry compares against: the hashes of the bytes that were
   * actually frozen, not the bytes the scratch directory happens to hold now.
   */
  readIntent(key: string): PublicationCommandIntent | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.intentPath(key), 'utf8')) as PublicationCommandIntent;
      return typeof parsed?.key === 'string' ? parsed : null;
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `command intent for ${key} is unreadable: ${err instanceof Error ? err.message : String(err)}`, { retryable: false, fieldPaths: ['intent'] });
    }
  }

  /**
   * Record the intent BEFORE any object is written (SPEC section R2.2).
   *
   * A `prepared` intent is put-if-absent: a second writer that somehow got this
   * far must not be able to rewrite an existing intent to match its own bytes,
   * so a conflicting write is an IDEMPOTENCY_CONFLICT rather than a silent
   * overwrite. Once the intent is `frozen`, later writes may only ADVANCE it
   * along prepared -> frozen -> committed, and may never change the pins, the
   * request hash, or the frozen artifact set. That is what makes the frozen set
   * authoritative for a retry instead of the scratch directory.
   */
  writeIntent(intent: PublicationCommandIntent): void {
    const file = this.intentPath(intent.key);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    const existing = this.readIntent(intent.key);
    if (existing !== null) {
      const identityChanged = existing.operationId !== intent.operationId
        || existing.requestBaseHash !== intent.requestBaseHash
        || existing.requestHash !== intent.requestHash
        || (existing.taskId !== '' && intent.taskId !== '' && existing.taskId !== intent.taskId)
        || (existing.semanticHash !== '0'.repeat(64) && intent.semanticHash !== '0'.repeat(64) && existing.semanticHash !== intent.semanticHash)
        || (existing.format !== existing.action && intent.format !== intent.action && existing.format !== intent.format)
        || (existing.expectedDesignRevision > 0 && intent.expectedDesignRevision > 0 && existing.expectedDesignRevision !== intent.expectedDesignRevision);
      if (identityChanged) {
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `command ${intent.key} already recorded a different intent; the original is preserved`, { fieldPaths: ['commandId'] });
      }
      const RANK: Record<PublicationCommandIntent['state'], number> = { prepared: 0, frozen: 1, committed: 2 };
      if (RANK[intent.state] < RANK[existing.state]) {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `command ${intent.key} cannot move back from ${existing.state} to ${intent.state}`, { retryable: false, fieldPaths: ['intent'] });
      }
      // A frozen artifact set is IMMUTABLE once recorded: a later attempt cannot
      // replace what the first freeze actually published.
      if (existing.artifactSetHash !== undefined
        && intent.artifactSetHash !== undefined
        && existing.artifactSetHash !== intent.artifactSetHash) {
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `command ${intent.key} is already frozen with a different artifact set; the frozen result is preserved`, { fieldPaths: ['commandId'] });
      }
      // A caller may hold the exact prepared object from before the freeze while
      // commitPublication advances the intent to frozen/committed. Never write
      // that stale prepared copy over the richer frozen record.
      if (RANK[intent.state] < RANK[existing.state]) return;
      if (existing.state === intent.state && existing.artifactSetHash === intent.artifactSetHash) return;
      if (existing.state === intent.state && intent.artifactSetHash === undefined) return;
    }

    const bytes = Buffer.from(`${JSON.stringify(intent, null, 2)}\n`, 'utf8');
    const temporary = `${file}.tmp-${randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      // A rename replaces the file atomically. It is only ever reached after the
      // monotonicity check above, so a reader sees either the old or the new
      // state and never a half-written intent.
      fs.renameSync(temporary, file);
      fsyncDirectory(path.dirname(file));
    } catch (err) {
      if (err instanceof WorkbenchContractError) throw err;
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot record the command intent: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['intent'] });
    } finally {
      if (fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* renamed away or never created */ }
    }
  }

  /**
   * Commit a prepared intent: write the complete artifact set and flip the root
   * index. The flip is the single commit point; everything before it is invisible
   * and everything after it is replayable.
   */
  commitPublication(intent: PublicationCommandIntent, committed: Omit<CommittedPublication, 'key' | 'requestBaseHash' | 'requestHash' | 'ownerSessionId' | 'commandId' | 'taskId' | 'operationId' | 'committedAt'>): CommittedPublication {
    const index = this.readCommitIndex();
    const existing = index.publications[intent.key];
    if (existing !== undefined) {
      if (existing.operationId !== intent.operationId || existing.requestHash !== intent.requestHash) {
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `command ${intent.key} already committed a different operation or request`, { fieldPaths: ['commandId'] });
      }
      return existing;
    }
    const entry: CommittedPublication = {
      operationId: intent.operationId,
      key: intent.key,
      ownerSessionId: intent.ownerSessionId,
      commandId: intent.commandId,
      taskId: intent.taskId,
      requestBaseHash: intent.requestBaseHash,
      requestHash: intent.requestHash,
      receipt: committed.receipt,
      artifactSet: committed.artifactSet,
      artifactSetHash: artifactSetHash(committed.artifactSet),
      ...(committed.diagramDraftRef === undefined ? {} : { diagramDraftRef: committed.diagramDraftRef }),
      ...(committed.taskPointer === undefined ? {} : { taskPointer: committed.taskPointer }),
      committedAt: new Date().toISOString(),
    };
    const next: PublicationCommitIndex = {
      schemaVersion: PUBLICATION_INDEX_SCHEMA_VERSION,
      publications: { ...index.publications, [intent.key]: entry },
      tasks: committed.taskPointer === undefined
        ? index.tasks
        : { ...index.tasks, [intent.taskId]: { snapshotRef: committed.taskPointer.snapshotRef, designRevision: committed.taskPointer.designRevision } },
    };
    this.writeCommitIndex(next);
    // The index flip is the commit point. Marking the intent committed is useful
    // recovery metadata but is NOT allowed to turn a successful commit into a
    // failed response (the caller could otherwise retry a command that actually
    // committed but whose post-commit intent rewrite failed).
    try {
      this.writeIntent({ ...intent, state: 'committed', artifactSet: committed.artifactSet, artifactSetHash: artifactSetHash(committed.artifactSet), committedAt: entry.committedAt });
    } catch { /* root commit index is authoritative; recovery derives committed state from it */ }
    return entry;
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(directory, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'EINVAL' || code === 'EPERM' || code === 'EISDIR' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') return;
    throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}
