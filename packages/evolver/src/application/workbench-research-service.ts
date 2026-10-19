/**
 * WorkbenchResearchService: the MINIMAL sidecar for the research workbench.
 *
 * SPEC: docs/mvp/WORKBENCH-RESEARCH-SPEC.md §2.2, §5, §6.
 *
 * What this service is NOT
 * ------------------------
 * It is not a second experiment state machine. It does not run, evaluate, or
 * freeze anything, and it never advances an original Phase 2/3 `taskRevision`.
 * It owns exactly four things that no original service records:
 *
 *   - a PRODUCT task identity (`wb-…`), distinct from any source task id;
 *   - explicit, verified bindings from that task to real P6 / Phase 2 / Phase 3
 *     artifacts;
 *   - Chinese reading explanations, which are prose ABOUT research, never
 *     research themselves;
 *   - diagram references.
 *
 * Reuse, not duplication
 * ----------------------
 * The storage idioms (atomic temp+rename writes, an idempotency command index
 * keyed by owner+commandId, staging that is invisible until one descriptor
 * flips) follow `application/research-service.ts` deliberately. They are
 * re-implemented here in ~30 lines rather than abstracted across services,
 * because the two services have different owners, different locks and different
 * failure semantics; a shared abstraction would couple a P5/P6 publication to
 * a workbench UI write. What IS shared is the discipline, and each divergence
 * is commented at its site.
 *
 * Ordering that the SPEC makes non-negotiable (SPEC §5.3 rule 4)
 * -------------------------------------------------------------
 *   1. validate shape and size, reject unknown fields;
 *   2. check owner, idempotency and the source chain;
 *   3. take the task lock;
 *   4. RE-CHECK CAS and the source anchors while holding the lock;
 *   5. write staging artifacts + an immutable task snapshot;
 *   6. atomically publish, then flip the index.
 *
 * Step 4 is the one that matters. A source artifact can be republished between
 * step 2 and step 3, so a CAS that passed before the lock is not evidence about
 * the state the write actually commits against.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  WorkbenchContractError,
  WORKBENCH_RESEARCH_SCHEMA_VERSION,
  MAX_MODULE_EXPLANATIONS_PER_SUBMIT,
  assertSubmissionSize,
  computeCandidateKey,
  isProductTaskId,
  validateCandidateBindingInput,
  validateChineseClaim,
  validateCompositionExplanation,
  validateCreateTaskRequest,
  validateModuleExplanation,
  validateUpdateDesignRequest,
  type BoundRef,
  type WorkbenchBoundRef,
  type CandidateBinding,
  type CandidateBindingInput,
  type CandidateGraphPins,
  type CompositionExplanation,
  type CreateTaskRequest,
  type DesignReceipt,
  type DiagramDraftV2,
  type ModuleExplanation,
  type SourceTaskRef,
  type StageContext,
  type WorkbenchErrorCode,
  type WorkbenchStage,
  type WorkbenchTaskRecord,
  type StrictArtifactRef,
  type UpdateDesignRequest,
} from '../contracts/workbench.ts';
import {
  coordinatorFor,
  canonicalCommandKey,
  artifactSetHash,
  type CommittedPublication,
  type PublicationArtifactIdentity,
  type PublicationCommandIntent,
  type PublicationCoordinator,
} from './workbench-publication-coordinator.ts';

// ----------------- dependencies -----------------

/** The calling Agent. `ownerSessionId` comes from HERE, never from a payload. */
export interface WorkbenchActor {
  ownerSessionId: string;
}

/**
 * Resolves a referenced source artifact to its bytes and its real hash.
 *
 * Implemented by the adapter layer, which knows the four stores. The service
 * itself never learns a filesystem path, which is what keeps the SPEC's
 * "source store name selects a trusted resolver" rule enforceable.
 */
export interface SourceResolver {
  /** Return the artifact's ACTUAL content hash, or null when it does not exist. */
  actualHash(ref: BoundRef): string | null;
  /**
   * Verify that `binding` names a real, succeeded P6 candidate.
   * Returns the resolved candidate identity fields, or null when unresolvable.
   */
  resolveCandidate?(binding: CandidateBindingInput): Promise<ResolvedCandidate | null>;
  /** Verify that a source task really carries this candidate (SPEC §2.2 rule 3). */
  taskCarriesCandidate?(taskRef: SourceTaskRef, binding: CandidateBindingInput): Promise<boolean>;
  /** Current experiment revision of a source task, for the version vector. */
  sourceTaskRevision?(taskRef: SourceTaskRef): Promise<number | null>;
  /** Current revision of any artifact the page may be shown. */
  dependencyHash?(refs: BoundRef[]): Promise<string[]>;
}

export interface ResolvedCandidate {
  candidateId: string;
  candidateHash: string;
  taskBriefHash: string;
  /** Present only when the P6 result itself declares it. */
  moduleCardRefs: string[];
}

/**
 * The REAL store resolver used by the DSH host.
 *
 * This is the only place in the sidecar that knows a filesystem root. It
 * resolves a `BoundRef` by STORE NAME against a fixed root map — never against
 * a caller-supplied path — and recomputes the content hash on every read, so a
 * ref that no longer addresses its bytes is reported rather than served.
 *
 * The `repoRoot` containment check matters because some published P6 artifacts
 * are addressed by a repo-relative id (e.g. `work/.../p6-synthesis-result.json`)
 * rather than by a path under the paper store. Those are still resolved inside
 * the repo root and nowhere else.
 */
export function createHostSourceResolver(opts: {
  repoRoot: string;
  researchExecutionRoot: string;
  paperOnlyRoot?: string;
  workbenchResearchRoot?: string;
  /** Optional: the phase3 experiment store, for candidate-carrying checks. */
  phase3ExperimentRoot?: string;
}): SourceResolver {
  const repoRoot = path.resolve(opts.repoRoot);
  const roots: Record<string, string> = {
    workbench: path.join(opts.workbenchResearchRoot === undefined
      ? path.join(repoRoot, 'artifacts', 'phase3', 'workbench-research')
      : path.resolve(opts.workbenchResearchRoot), 'published'),
    paper_only: opts.paperOnlyRoot === undefined
      ? path.join(repoRoot, 'artifacts', 'paper-only')
      : path.resolve(opts.paperOnlyRoot),
    phase2: path.resolve(opts.researchExecutionRoot),
    phase3: opts.phase3ExperimentRoot === undefined
      ? path.join(repoRoot, 'artifacts', 'phase3', 'experiments')
      : path.resolve(opts.phase3ExperimentRoot),
  };

  /** Resolve a ref to an existing file inside its store's root, or null. */
  const locate = (ref: BoundRef): string | null => {
    const root = roots[ref.store];
    if (root === undefined) return null;
    const target = path.resolve(root, ref.ref.id);
    // Segment-boundary containment: a sibling directory sharing the root's
    // string prefix is NOT inside it.
    if (target !== root && !target.startsWith(root + path.sep)) return null;
    try {
      return fs.statSync(target).isFile() ? target : null;
    } catch {
      return null;
    }
  };

  /** The same, but also allowing a repo-relative id for published P6 results. */
  const locateAllowingRepo = (ref: BoundRef): string | null => {
    const inside = locate(ref);
    if (inside !== null) return inside;
    if (ref.store !== 'paper_only') return null;
    const target = path.resolve(repoRoot, ref.ref.id);
    if (!target.startsWith(repoRoot + path.sep)) return null;
    try {
      return fs.statSync(target).isFile() ? target : null;
    } catch {
      return null;
    }
  };

  return {
    actualHash(ref: BoundRef): string | null {
      const file = locateAllowingRepo(ref);
      if (file === null) return null;
      try {
        return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      } catch {
        return null;
      }
    },
    async dependencyHash(refs: BoundRef[]): Promise<string[]> {
      return refs.map((r) => this.actualHash(r) ?? `missing:${r.ref.id}`);
    },
    /**
     * The Host's source version for a research source task.
     *
     * This is NOT optional bookkeeping. The GraphSnapshot embeds the candidate's
     * source vector, so an absent reader does not merely show an empty column:
     * every snapshot of the same graph serialises differently from every other,
     * and the before/after re-read can never disagree, which silently disables
     * the SNAPSHOT_BUSY guard against a source changing mid-resolution.
     *
     * Phase 2 publishes its revision in `index/tasks.json`; Phase 3 has no
     * per-task revision file, so its recorded operation count is the monotonic
     * fact it does publish (the same choice `summarisePhase3Task` makes). It
     * returns null — never a guess — when the task or its index is unreadable,
     * so a caller needing a version vector fails closed rather than comparing
     * empties.
     */
    async sourceTaskRevision(ref: SourceTaskRef): Promise<number | null> {
      if (ref.store === 'phase2') {
        const dir = path.join(roots.phase2, ref.taskId);
        const record = readSourceTaskRecord(dir, ref.taskId);
        return record === null ? null : record.revision;
      }
      if (ref.store === 'phase3') {
        const operations = path.join(roots.phase3, 'operations');
        let names: string[];
        try {
          names = fs.readdirSync(operations);
        } catch {
          return null;
        }
        let count = 0;
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(fs.readFileSync(path.join(operations, name), 'utf8'));
          } catch {
            return null;
          }
          const taskId = (parsed as { taskId?: unknown } | null)?.taskId;
          if (taskId === ref.taskId) count += 1;
        }
        return count === 0 ? null : count;
      }
      return null;
    },
  };
}

/**
 * `index/tasks.json` is a MAP keyed by taskId (see `readTaskRecord` in the v2
 * projection), so the revision must be read off this task's own entry rather
 * than off the top level.
 */
function readSourceTaskRecord(taskDir: string, taskId: string): { revision: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(taskDir, 'index', 'tasks.json'), 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = (parsed as Record<string, unknown>)[taskId];
  if (typeof record !== 'object' || record === null) return null;
  const revision = (record as { revision?: unknown }).revision;
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0
    ? { revision }
    : null;
}

// ----------------- receipts and publication -----------------

export interface DesignPublication {
  receipt: DesignReceipt;
  operation: DesignOperation;
  task: WorkbenchTaskRecord;
}

export interface DesignOperation {
  schemaVersion: 1;
  operationId: string;
  commandId: string;
  requestHash: string;
  ownerSessionId: string;
  action: string;
  taskId: string;
  /** The design revision this operation PRODUCED. */
  designRevision: number;
  status: 'succeeded';
  resultRefs: BoundRef[];
  snapshotRef: WorkbenchBoundRef;
  createdAt: string;
}

interface CommandIndexEntry {
  operationId: string;
  requestHash: string;
  ownerSessionId: string;
}

const PROCESS_IDENTITY = `${process.pid}-${randomUUID().slice(0, 8)}`;

/** A staged artifact awaiting promotion at commit time. */
export interface StagedArtifact {
  file: string;
  ref: BoundRef;
}

/** Wrap a plain artifact ref in the `paper_only` store a P6 result lives in. */
function bound(ref: StrictArtifactRef, store: 'paper_only' = 'paper_only'): BoundRef {
  return { store, ref };
}

/**
 * Replace staged refs with their published equivalents, preserving order and
 * keeping every already-published ref untouched.
 *
 * Deduplication is by ref id: resubmitting identical content yields the same
 * content-addressed name, so history should show one artifact rather than a
 * growing list of byte-identical copies.
 */
function mergePublishedRefs(existing: BoundRef[], promoted: Map<string, BoundRef>): BoundRef[] {
  const out: BoundRef[] = [];
  const seen = new Set<string>();
  for (const ref of existing) {
    const replacement = promoted.get(ref.ref.id) ?? ref;
    const key = `${replacement.store}:${replacement.ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(replacement);
  }
  return out;
}

/** Re-exported so callers get one error type, not two. */
export { WorkbenchContractError };
export type { WorkbenchErrorCode };

/**
 * The ONE root every workbench ref resolves under: `R/published`.
 *
 * Round-2 defect (SPEC section 1.1): the registrar, the service resolver and the
 * projection each derived this root separately, and they disagreed by one
 * directory. A ref the registrar had just committed was therefore invisible to
 * every reader, and a diagram could be registered but never attached.
 *
 * This function is the single derivation. Everything that publishes or resolves
 * a workbench ref takes its root from here, so "the registrar publishes one
 * level above the resolver" cannot be re-introduced by a fourth copy of the
 * constant.
 */
export function publishedRootOf(workbenchResearchRoot: string): string {
  return path.resolve(workbenchResearchRoot, 'published');
}

export class WorkbenchResearchService {
  private readonly root: string;
  private readonly resolver: SourceResolver;
  private readonly publishedRoot: string;
  /** The ONE durable commit point shared with the registrar and the tools. */
  private readonly coordinator: PublicationCoordinator;
  /** In-process serialization per task; a foreign lease is REFUSED, not ignored. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(opts: { root: string; resolver: SourceResolver }) {
    this.root = path.resolve(opts.root);
    this.publishedRoot = publishedRootOf(this.root);
    this.coordinator = coordinatorFor(this.root);
    // This is the sole writer Host instance for this store root. A second service
    // process cannot take the same root lease and therefore cannot commit a task
    // update while the first Host is active.
    this.coordinator.acquireWriteLease(`service:${PROCESS_IDENTITY}`);
    this.resolver = opts.resolver;
    for (const dir of ['index', 'operations', 'staging', 'published', 'leases']) {
      fs.mkdirSync(path.join(this.root, dir), { recursive: true });
    }
    this.reconcileAfterRestart();
  }

  /** The coordinator whose root commit index is the single business commit point. */
  publicationCoordinator(): PublicationCoordinator {
    return this.coordinator;
  }

  // ----------------- storage primitives -----------------

  private indexPath(name: string): string {
    return path.join(this.root, 'index', name);
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${PROCESS_IDENTITY}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private readJsonMap<T>(file: string): Map<string, T> {
    // SPEC section 3.2: for the workbench's own task/command caches, ENOENT may
    // mean "there has never been a cache" and is rebuildable from the v2 root
    // index. A parse error or any other IO failure is NOT an empty map. The old
    // implementation used `readJson()` (which swallowed every failure) and then
    // silently replaced a damaged index with `{}`, destroying the only copy of
    // committed pointers.
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `index ${file} is not an object; refusing to treat it as empty`, { retryable: false, fieldPaths: ['index'] });
      }
      return new Map(Object.entries(parsed as Record<string, T>));
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return new Map();
      if (err instanceof WorkbenchContractError) throw err;
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `index ${file} is unreadable; refusing to treat it as empty: ${err instanceof Error ? err.message : String(err)}`, { retryable: false, fieldPaths: ['index'] });
    }
  }

  /**
   * Write a staged artifact and return a STAGED ref.
   *
   * A staged ref's id is relative to `staging/` and carries a marker, because a
   * staged artifact is NOT readable through `resolveRefFile` — promoting it into
   * a published ref is `promoteStaged` at commit time. Handing back a
   * `published`-shaped ref here would produce a ref that resolves to a file
   * that does not exist, which is precisely how a workbench ends up advertising
   * an explanation it cannot show.
   */
  private writeStaged(dirName: string, value: unknown): { file: string; ref: BoundRef } {
    return this.writeImmutable(path.join(this.root, 'staging', dirName), 'annotation.json', value);
  }

  /**
   * Write a content-addressed immutable artifact and return its PUBLISHED ref.
   *
   * `id` is the path relative to `published/`, which is the single root every
   * reader resolves against. Deriving the id from the absolute path is what
   * previously produced refs that resolved one directory too shallow.
   */
  private writeImmutable(dir: string, name: string, value: unknown): { file: string; ref: WorkbenchBoundRef } {
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const sha256 = createHash('sha256').update(body).digest('hex');
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      // An immutable artifact is never rewritten. A differing body here would
      // mean a hash/id collision, which must surface rather than silently
      // replace evidence someone may already have read.
      const existing = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (existing !== sha256) {
        throw new WorkbenchContractError(
          'SOURCE_MISMATCH',
          `immutable artifact ${name} already exists with different content (${existing.slice(0, 12)} vs ${sha256.slice(0, 12)})`,
          { fieldPaths: ['published'] },
        );
      }
    } else {
      fs.writeFileSync(file, body, 'utf8');
    }
    // Refs are relative to `published/`, derived from the ABSOLUTE file path so
    // the two cannot drift.
    const relative = path.relative(path.join(this.root, 'published'), file).split(path.sep).join('/');
    return { file, ref: { store: 'workbench', ref: { id: relative, sha256 } } };
  }

  /** Copy a staged annotation into `published/` and return its published ref. */
  private promoteStaged(file: string, stagedRef: BoundRef, operationId: string): BoundRef {
    const dest = path.join(this.root, 'published', 'artifacts', operationId, path.basename(file));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
    const sha256 = createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    if (sha256 !== stagedRef.ref.sha256) {
      throw new WorkbenchContractError('SOURCE_MISMATCH', `promoted artifact hash ${sha256.slice(0, 12)} does not match the staged ${stagedRef.ref.sha256.slice(0, 12)}`, { fieldPaths: ['published'] });
    }
    return { store: 'workbench', ref: { id: path.relative(path.join(this.root, 'published'), dest).split(path.sep).join('/'), sha256 } };
  }

  // ----------------- reads -----------------

  /**
   * The sidecar's own storage root, for `/status` and snapshot provenance.
   *
   * Exposed rather than inferred from a task, because the v3 snapshot must name
   * the store a task came from; deriving it from a path would put the trust
   * boundary back where it started.
   */
  describeRoot(): string {
    return this.root;
  }

  /**
   * Whether a PRODUCT task id exists here.
   *
   * Separate from `readTask` because the store-identity resolver needs a
   * membership test that cannot throw: an id that is absent here may still
   * live in an experiment store, and a reconciliation error in one store must
   * not make another store's task unresolvable.
   */
  hasTask(taskId: string): boolean {
    if (!isProductTaskId(taskId)) return false;
    return this.readJsonMap<{ snapshotRef: WorkbenchBoundRef }>(this.indexPath('tasks.json')).has(taskId);
  }

  /** The index points only at COMMITTED snapshots; staging is invisible here. */
  readTask(taskId: string): WorkbenchTaskRecord | null {
    if (!isProductTaskId(taskId)) return null;
    const index = this.readJsonMap<{ snapshotRef: WorkbenchBoundRef }>(this.indexPath('tasks.json'));
    const entry = index.get(taskId);
    if (entry === undefined) return null;
    const file = this.resolveRefFile(entry.snapshotRef);
    // An index entry whose snapshot is gone is a broken store, not an absent
    // task. Returning null would hide a committed revision from every reader.
    if (file === null) {
      throw new WorkbenchContractError(
        'RECONCILIATION_REQUIRED',
        `task ${taskId} is indexed but its snapshot ${entry.snapshotRef.ref.id} is missing or outside published/`,
        { retryable: true, fieldPaths: ['taskId'] },
      );
    }
    const task = this.readJson<WorkbenchTaskRecord>(file);
    if (task === null) {
      throw new WorkbenchContractError('SOURCE_MISMATCH', `task ${taskId} snapshot is present but not readable JSON`, { fieldPaths: ['taskId'] });
    }
    return task;
  }

  /** The immutable published snapshot ref currently indexed for a product task. */
  currentTaskSnapshotRef(taskId: string): WorkbenchBoundRef | null {
    if (!isProductTaskId(taskId)) return null;
    const entry = this.readJsonMap<{ snapshotRef: WorkbenchBoundRef }>(this.indexPath('tasks.json')).get(taskId);
    if (entry === undefined) return null;
    const file = this.resolveRefFile(entry.snapshotRef);
    if (file === null) {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `task ${taskId} snapshot ref is missing or outside published/`, { retryable: true, fieldPaths: ['taskId'] });
    }
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== entry.snapshotRef.ref.sha256) {
      throw new WorkbenchContractError('SOURCE_MISMATCH', `task ${taskId} snapshot hash changed (${actual.slice(0, 12)} vs ${entry.snapshotRef.ref.sha256.slice(0, 12)})`, { fieldPaths: ['taskId'] });
    }
    return entry.snapshotRef;
  }

  /** Every committed operation descriptor on disk. */
  listOperations(): DesignOperation[] {
    const dir = path.join(this.root, 'operations');
    if (!fs.existsSync(dir)) return [];
    const out: DesignOperation[] = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const op = this.readJson<DesignOperation>(path.join(dir, file));
      if (op !== null) out.push(op);
    }
    return out;
  }

  /** The committed operations for one task, oldest first. */
  operationsForTask(taskId: string): DesignOperation[] {
    return this.listOperations()
      .filter((op) => op.taskId === taskId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.operationId.localeCompare(b.operationId)));
  }

  listTasks(): WorkbenchTaskRecord[] {
    const index = this.readJsonMap<{ snapshotRef: WorkbenchBoundRef }>(this.indexPath('tasks.json'));
    const out: WorkbenchTaskRecord[] = [];
    for (const taskId of [...index.keys()].sort()) {
      const task = this.readTask(taskId);
      if (task !== null) out.push(task);
    }
    return out;
  }

  /**
   * Resolve a published sidecar ref to a file.
   *
   * Refs are relative to `published/`. A ref that escapes that root, or that
   * does not exist, resolves to null rather than to a partially matching path,
   * so a malformed ref degrades to "unreadable" instead of to someone else's
   * file.
   */
  private resolveRefFile(ref: BoundRef): string | null {
    if (ref.store !== 'workbench') return null;
    const publishedRoot = this.publishedRoot;
    const target = path.resolve(publishedRoot, ref.ref.id);
    if (target !== publishedRoot && !target.startsWith(publishedRoot + path.sep)) return null;
    return fs.existsSync(target) ? target : null;
  }

  /** Read a published sidecar artifact, re-checking the hash it was published with. */
  readSidecarArtifact(ref: BoundRef): unknown | null {
    const file = this.resolveRefFile(ref);
    if (file === null) return null;
    const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (actual !== ref.ref.sha256) {
      throw new WorkbenchContractError('SOURCE_MISMATCH', `published artifact ${ref.ref.id} has been modified on disk (${actual.slice(0, 12)} vs ${ref.ref.sha256.slice(0, 12)})`, { fieldPaths: ['ref'] });
    }
    return this.readJson(file);
  }

  /**
   * Current source-task revisions, read fresh.
   *
   * A design write must NOT move these, and the projection needs them to build a
   * version vector that notices an experiment that changed on its own.
   */
  async sourceTaskRevisions(task: WorkbenchTaskRecord): Promise<Array<{ store: SourceTaskRef['store']; taskId: string; revision: number }>> {
    return this.sourceTaskRevisionsFor(task.sourceTaskRefs);
  }

  /** Read a candidate-specific source version vector without task-level union refs. */
  async sourceTaskRevisionsFor(refs: SourceTaskRef[]): Promise<Array<{ store: SourceTaskRef['store']; taskId: string; revision: number }>> {
    const out: Array<{ store: SourceTaskRef['store']; taskId: string; revision: number }> = [];
    const unique = new Map(refs.map((ref) => [`${ref.store}:${ref.taskId}`, ref]));
    for (const ref of unique.values()) {
      const revision = (await this.resolver.sourceTaskRevision?.(ref)) ?? null;
      if (revision !== null) out.push({ store: ref.store, taskId: ref.taskId, revision });
    }
    return out.sort((a, b) => `${a.store}:${a.taskId}`.localeCompare(`${b.store}:${b.taskId}`));
  }

  /**
   * The change token's SEMANTIC input.
   *
   * SPEC §2.3: it must cover designRevision, bound source revisions and the
   * hashes of the artifacts the page renders — and must NOT be a timestamp, or
   * every poll would report a change. `generatedAt` is added by the caller and
   * never enters this value.
   */
  async computeViewVersion(task: WorkbenchTaskRecord): Promise<string> {
    const sourceRevisions = await this.sourceTaskRevisions(task);
    const deps: BoundRef[] = [];
    // Only refs that still have both halves are usable. A malformed entry is a
    // store defect; feeding it to the resolver would throw a TypeError from
    // inside a change-token read, which is the wrong layer to report it from.
    const collect = (refs: BoundRef[]): void => {
      for (const ref of refs) {
        if (typeof ref?.store === 'string' && typeof ref?.ref?.id === 'string' && typeof ref?.ref?.sha256 === 'string') {
          deps.push(ref);
        }
      }
    };
    collect(task.annotationRefs);
    collect(task.diagramRefs);
    for (const binding of task.candidateBindings) {
      collect([{ store: 'paper_only', ref: binding.synthesisResultRef }]);
    }
    const depHashes = (await this.resolver.dependencyHash?.(deps)) ?? [];
    const body = {
      taskId: task.taskId,
      designRevision: task.designRevision,
      candidateKeys: task.candidateBindings.map((b) => b.candidateKey).sort(),
      sourceRevisions: sourceRevisions.map((r) => `${r.store}:${r.taskId}@${r.revision}`).sort(),
      depHashes: [...depHashes].sort(),
      updatedAt: task.updatedAt,
    };
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
  }

  // ----------------- locking -----------------

  /**
   * Run `fn` with an exclusive per-task lock.
   *
   * A live lease file from ANOTHER process is refused outright (WR-24 / SPEC
   * §2.2): two writers silently overwriting each other would corrupt the
   * snapshot index, and a stale lease must be resolved by a human or by
   * `reconcileAfterRestart`, not by a best-effort write.
   */
  private async withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const leaseFile = path.join(this.root, 'leases', `${taskId}.json`);
    const previous = this.locks.get(taskId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const existing = this.readJson<{ identity: string; pid: number; acquiredAt: string }>(leaseFile);
      if (existing !== null && existing.identity !== PROCESS_IDENTITY) {
        throw new WorkbenchContractError(
          'RECONCILIATION_REQUIRED',
          `task ${taskId} holds a lease from another process (${existing.identity}); refusing an unlocked overwrite`,
          { retryable: true, fieldPaths: ['taskId'] },
        );
      }
      this.writeJsonAtomic(leaseFile, { identity: PROCESS_IDENTITY, pid: process.pid, acquiredAt: new Date().toISOString() });
      try {
        return await fn();
      } finally {
        try {
          fs.unlinkSync(leaseFile);
        } catch {
          // A leftover lease is recoverable by reconcileAfterRestart; failing
          // the committed write because cleanup failed would be worse.
        }
      }
    });
    this.locks.set(taskId, run.catch(() => undefined));
    return run;
  }

  // ----------------- restart reconciliation -----------------

  /**
   * SPEC §5.3 rule 5 / WR-24: a crash before the index flip must leave NO
   * visible state, and a replay after restart must not bump a revision again.
   *
   * This does two real checks and one cleanup:
   *  - staging directories that were never promoted are removed, because an
   *    orphaned staged artifact is not part of any committed revision;
   *  - an operation descriptor whose snapshot is missing is REFUSED loudly.
   *    Silently dropping it would let a later writer reuse the same commandId
   *    against a revision that already moved, which is the exact double-apply
   *    the rule forbids;
   *  - a committed operation whose task index entry is missing is left alone
   *    and reported by the caller, not auto-repaired, because re-applying it
   *    would risk a second designRevision bump.
   */
  reconcileAfterRestart(): { orphanedStaging: string[]; orphanedOperations: DesignOperation[] } {
    const orphanedStaging: string[] = [];
    const stagingDir = path.join(this.root, 'staging');
    if (fs.existsSync(stagingDir)) {
      for (const entry of fs.readdirSync(stagingDir)) {
        const full = path.join(stagingDir, entry);
        try {
          fs.rmSync(full, { recursive: true, force: true });
          orphanedStaging.push(entry);
        } catch {
          // A staging directory we cannot remove is harmless: nothing reads it.
        }
      }
    }

    const orphanedOperations: DesignOperation[] = [];
    const opsDir = path.join(this.root, 'operations');
    if (fs.existsSync(opsDir)) {
      for (const file of fs.readdirSync(opsDir).filter((f) => f.endsWith('.json'))) {
        const op = this.readJson<DesignOperation>(path.join(opsDir, file));
        if (op === null) continue;
        if (!fs.existsSync(this.operationSnapshotFile(op.operationId))) {
          throw new WorkbenchContractError(
            'RECONCILIATION_REQUIRED',
            `operation ${op.operationId} committed but its snapshot is missing; the index cannot be trusted until this is resolved`,
            { retryable: true, fieldPaths: ['operations'] },
          );
        }
      }
    }
    for (const taskId of this.listTaskIds()) {
      try {
        this.readTask(taskId);
      } catch {
        orphanedOperations.push(...(this.readJson<DesignOperation[]>(path.join(this.root, 'operations', `${taskId}.json`)) ?? []));
      }
    }
    return { orphanedStaging, orphanedOperations };
  }

  private listTaskIds(): string[] {
    return [...this.readJsonMap<{ snapshotRef: WorkbenchBoundRef }>(this.indexPath('tasks.json')).keys()];
  }

  private operationSnapshotFile(operationId: string): string {
    return path.join(this.publishedRoot, 'operations', operationId, 'task.json');
  }

  // ----------------- create_task -----------------

  /**
   * Create a product task at designRevision 1.
   *
   * A separate request shape, NOT an update with expectedDesignRevision=0
   * (SPEC §5.1): a task that does not exist cannot have its current revision
   * compared, and smuggling that through an update path would make "task does
   * not exist" indistinguishable from "revision is stale".
   */
  async createTask(request: CreateTaskRequest, actor: WorkbenchActor): Promise<DesignPublication> {
    assertSubmissionSize(JSON.stringify(request));
    const parsed = validateCreateTaskRequest(request);
    this.assertActor(actor);

    this.coordinator.acquireWriteLease(`service:${PROCESS_IDENTITY}`);

    const requestHash = hashCanonical({
      action: parsed.action,
      commandId: parsed.commandId,
      payload: parsed.payload,
    });

    const reuse = this.reserveOrReuse(actor.ownerSessionId, parsed.action, parsed.commandId, requestHash);
    if (reuse.reused) return this.readPublication(reuse.operationId);

    const now = new Date().toISOString();
    const taskId = `wb-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const task: WorkbenchTaskRecord = {
      schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
      taskId,
      ownerSessionId: actor.ownerSessionId,
      displayNameZh: parsed.payload.displayNameZh,
      researchQuestionZh: parsed.payload.researchQuestionZh,
      // SPEC §2.2 rule 1: a task may exist with no candidate at all.
      designRevision: 1,
      sourceTaskRefs: [],
      candidateBindings: [],
      annotationRefs: [],
      diagramRefs: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.commit(reuse.operationId, parsed.commandId, requestHash, actor, 'create_task', task, 1, []);
  }

  // ----------------- update: bind_candidate -----------------

  async bindCandidate(
    request: UpdateDesignRequest,
    actor: WorkbenchActor,
    raw: CandidateBindingInput,
    graphPins?: CandidateGraphPins | null,
  ): Promise<DesignPublication> {
    return this.update(request, actor, 'bind_candidate', (task) => {
      const input = validateCandidateBindingInput(raw, 'payload.candidate');
      const pinRefs = graphPins === undefined || graphPins === null
        ? []
        : [graphPins.recipeRef, ...(graphPins.protocolRef === null ? [] : [graphPins.protocolRef]), ...(graphPins.profileRef === null ? [] : [graphPins.profileRef]), ...graphPins.implementationRefs];
      return { next: applyBinding(task, input, graphPins), sources: [bound(input.synthesisResultRef), ...pinRefs], staged: [] };
    });
  }

  // ----------------- update: annotate_module -----------------

  /**
   * Annotate ONE module before any P6 exists.
   *
   * This is the read-paper stage: there is no candidate, no combination and no
   * measured result yet, and forcing a candidate first would make it impossible
   * to explain a paper you are still reading.
   */
  async annotateModule(
    request: UpdateDesignRequest,
    actor: WorkbenchActor,
    raw: { methodKey: string; explanation: ModuleExplanation },
    // The keys this task may explain, or undefined to skip the check.
    //
    // SPEC section 5.3: "methodKey 必须由当前任务合法目录提供". Without this the
    // action becomes a way to publish prose about a method that does not exist
    // in this task — an annotation no page would ever show, and one that looks
    // exactly like a real one in the artifact list.
    //
    // Accepts a Set or an array: a caller assembling the catalog inline has an
    // array, and normalising once here beats rebuilding a Set per request.
    allowedMethodKeys?: ReadonlySet<string> | readonly string[],
  ): Promise<DesignPublication> {
    const catalog = allowedMethodKeys === undefined
      ? null
      : allowedMethodKeys instanceof Set ? allowedMethodKeys : new Set(allowedMethodKeys);
    return this.update(request, actor, 'annotate_module', (task) => {
      if (typeof raw.methodKey !== 'string' || raw.methodKey.length === 0) {
        throw new WorkbenchContractError('INVALID_INPUT', 'payload.methodKey is required', { fieldPaths: ['payload.methodKey'] });
      }
      if (catalog !== null && !catalog.has(raw.methodKey)) {
        throw new WorkbenchContractError(
          'DEPENDENCY_NOT_READY',
          `payload.methodKey ${JSON.stringify(raw.methodKey)} 不在本任务的合法目录中；`
          + `可选：${[...catalog].join(', ') || '(空)'}。方法标识必须由本任务可见的卡片或固定实现提供，不能自行命名。`,
          { fieldPaths: ['payload.methodKey'] },
        );
      }
      const explanation = validateModuleExplanation(raw.explanation, 'payload.explanation');
      const annotation = {
        schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
        kind: 'module_explanation' as const,
        methodKey: raw.methodKey,
        explanation,
        createdAt: new Date().toISOString(),
      };
      // SPEC §5.3 rule 6: a new explanation is a NEW revision; the old artifact
      // is retained and stays referenced by the history.
      const written = this.writeStaged(annotationSha(raw.methodKey, explanation), annotation);
      return { next: { ...task, annotationRefs: [...task.annotationRefs, written.ref] }, sources: [], staged: [written] };
    });
  }

  // ----------------- update: annotate_design -----------------

  /**
   * Annotate a bound candidate.
   *
   * SPEC §5.3 rule 7: this adds Chinese READING content only. It cannot create
   * a ResearchCandidate, change the module set, or alter the candidate identity
   * — a new hypothesis of fact still requires a real P6 result.
   */
  async annotateDesign(
    request: UpdateDesignRequest,
    actor: WorkbenchActor,
    raw: { candidateKey: string; moduleExplanations: Array<{ methodKey: string; explanation: ModuleExplanation }>; compositionExplanation: CompositionExplanation },
  ): Promise<DesignPublication> {
    return this.update(request, actor, 'annotate_design', (task) => {
      const candidateKey = String(raw.candidateKey ?? '');
      const binding = task.candidateBindings.find((b) => b.candidateKey === candidateKey);
      if (binding === undefined) {
        throw new WorkbenchContractError(
          'DEPENDENCY_NOT_READY',
          `candidateKey ${JSON.stringify(candidateKey)} is not bound to task ${task.taskId}; bind_candidate must succeed first`,
          { fieldPaths: ['payload.candidateKey'] },
        );
      }
      const moduleExplanations = raw.moduleExplanations ?? [];
      if (!Array.isArray(moduleExplanations)) {
        throw new WorkbenchContractError('SCHEMA_VIOLATION', 'payload.moduleExplanations must be an array', { fieldPaths: ['payload.moduleExplanations'] });
      }
      if (moduleExplanations.length > MAX_MODULE_EXPLANATIONS_PER_SUBMIT) {
        throw new WorkbenchContractError(
          'SCHEMA_VIOLATION',
          `payload.moduleExplanations has ${moduleExplanations.length} entries; the cap is ${MAX_MODULE_EXPLANATIONS_PER_SUBMIT} per submission`,
          { fieldPaths: ['payload.moduleExplanations'] },
        );
      }
      const explanations = moduleExplanations.map((m, i) => ({
        methodKey: String(m.methodKey),
        explanation: validateModuleExplanation(m.explanation, `payload.moduleExplanations[${i}].explanation`),
      }));
      const composition = validateCompositionExplanation(raw.compositionExplanation, 'payload.compositionExplanation');
      const annotation = {
        schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
        kind: 'design_annotation' as const,
        candidateKey,
        moduleExplanations: explanations,
        compositionExplanation: composition,
        createdAt: new Date().toISOString(),
      };
      const written = this.writeStaged(
        annotationSha(candidateKey, { moduleExplanations: explanations, compositionExplanation: composition }),
        annotation,
      );
      return { next: { ...task, annotationRefs: [...task.annotationRefs, written.ref] }, sources: [], staged: [written] };
    });
  }

  // ----------------- update: attach_diagram -----------------

  /**
   * Attach an ALREADY-REGISTERED diagram to the task.
   *
   * This is the step that advances `designRevision`; registration deliberately
   * does not. A diagram can therefore be regenerated against an unchanged design
   * without the task looking like it changed, and attaching is one auditable act.
   */
  async attachDiagram(
    request: UpdateDesignRequest,
    actor: WorkbenchActor,
    raw: { candidateKey: string; diagramDraftRef: BoundRef },
    validateCurrentGraph?: (task: WorkbenchTaskRecord) => Promise<BoundRef[] | void>,
  ): Promise<DesignPublication> {
    return this.update(request, actor, 'attach_diagram', async (task) => {
      const candidateKey = String(raw.candidateKey ?? '');
      const binding = task.candidateBindings.find((b) => b.candidateKey === candidateKey);
      if (binding === undefined) {
        throw new WorkbenchContractError(
          'DEPENDENCY_NOT_READY',
          `candidateKey ${JSON.stringify(candidateKey)} is not bound to task ${task.taskId}`,
          { fieldPaths: ['payload.candidateKey'] },
        );
      }
      const ref = raw.diagramDraftRef;
      if (typeof ref?.store !== 'string' || typeof ref?.ref?.id !== 'string' || typeof ref?.ref?.sha256 !== 'string') {
        throw new WorkbenchContractError('INVALID_INPUT', 'payload.diagramDraftRef 必须是已登记的 BoundRef', { fieldPaths: ['payload.diagramDraftRef'] });
      }
      // A diagram ref must be a SIDECAR ref. Accepting any store here would make
      // "attach a diagram" a way to attach an arbitrary experiment artifact.
      if (ref.store !== 'workbench') {
        throw new WorkbenchContractError(
          'INVALID_INPUT',
          `payload.diagramDraftRef.store 必须是 workbench（来自 evolver_register_diagram_output），收到 ${ref.store}`,
          { fieldPaths: ['payload.diagramDraftRef.store'] },
        );
      }
      // SPEC section R4: attaching is the audited write, so the service verifies
      // the draft against the COMMIT INDEX, not merely against its own hash. A
      // hash-correct JSON at a plausible path proves the bytes are unchanged; it
      // does NOT prove the operation was ever committed, that the draft belongs to
      // THIS task/owner/candidate/variant, or that the frozen dependency set is
      // intact. The old check accepted all four of those on the caller's word.
      const committed = this.findCommittedDiagram(ref);
      if (committed === null) {
        throw new WorkbenchContractError(
          'DEPENDENCY_NOT_READY',
          `payload.diagramDraftRef ${ref.ref.id} 不属于任何已提交的图稿登记；未提交的草稿不能关联`,
          { fieldPaths: ['payload.diagramDraftRef'] },
        );
      }
      const actual = this.resolver.actualHash(ref);
      if (actual === null) {
        throw new WorkbenchContractError(
          'DEPENDENCY_NOT_READY',
          `payload.diagramDraftRef ${ref.ref.id} 不再解析为已登记的图稿草稿；请重新登记后再关联`,
          { fieldPaths: ['payload.diagramDraftRef'] },
        );
      }
      if (actual !== ref.ref.sha256) {
        throw new WorkbenchContractError(
          'SOURCE_MISMATCH',
          `payload.diagramDraftRef ${ref.ref.id} 的内容已与登记时的 hash 不一致`,
          { fieldPaths: ['payload.diagramDraftRef'] },
        );
      }
      // Every frozen dependency of the origin commit must still be intact, and a
      // dependency that was legitimately ABSENT must still be absent. Checking only
      // the draft would let a substituted or vanished mapping/receipt ride along
      // behind an unchanged draft.
      this.assertCommittedArtifactsIntact(committed);
      // The draft's OWN identity must agree with this task and this candidate.
      const draft = this.readCommittedDraft(committed, ref);
      if (draft === null) {
        throw new WorkbenchContractError(
          'ARTIFACT_CORRUPT',
          `payload.diagramDraftRef ${ref.ref.id} 已提交但不是可解码的完整 draft v2`,
          { fieldPaths: ['payload.diagramDraftRef'] },
        );
      }
      if (draft.taskId !== task.taskId) {
        throw new WorkbenchContractError(
          'SOURCE_MISMATCH',
          `图稿草稿属于任务 ${draft.taskId}，不能关联到任务 ${task.taskId}`,
          { fieldPaths: ['payload.diagramDraftRef'] },
        );
      }
      if (draft.ownerSessionId !== task.ownerSessionId) {
        throw new WorkbenchContractError('OWNER_MISMATCH', '图稿草稿的 owner 与任务不一致', { fieldPaths: ['payload.diagramDraftRef'] });
      }
      if (draft.candidateKey !== candidateKey) {
        throw new WorkbenchContractError(
          'SOURCE_MISMATCH',
          `图稿草稿的 candidateKey ${JSON.stringify(draft.candidateKey)} 与 payload ${JSON.stringify(candidateKey)} 不一致`,
          { fieldPaths: ['payload.candidateKey'] },
        );
      }
      // The variant is NOT checked against the binding: a binding records which
      // candidate was bound, and carries no variant. The variant is checked where
      // it is actually known -- against the current graph the caller re-resolves
      // below -- so inventing a binding-side variant here would compare the draft
      // to a field that does not exist.
      const graphSources = await validateCurrentGraph?.(task) ?? [];
      return { next: { ...task, diagramRefs: [...task.diagramRefs, ref] }, sources: graphSources, staged: [] };
    });
  }

  /**
   * The committed diagram registration whose draft is this ref, or null.
   *
   * A ref is a pointer, not an identity: two operations could in principle write
   * the same relative id, and a caller can name any id it likes. Resolving the ref
   * back through the commit index is what turns "a file exists there" into "this
   * exact operation committed this exact object".
   */
  private findCommittedDiagram(ref: BoundRef): CommittedPublication | null {
    const index = this.coordinator.readCommitIndex();
    for (const entry of Object.values(index.publications)) {
      const draft = entry.diagramDraftRef;
      if (draft !== undefined && draft.ref.id === ref.ref.id && draft.ref.sha256 === ref.ref.sha256) return entry;
    }
    return null;
  }

  /** Refuse when any frozen dependency is missing, damaged, or newly appeared. */
  private assertCommittedArtifactsIntact(entry: CommittedPublication): void {
    for (const artifact of entry.artifactSet) {
      const resolved = this.resolveRefFile({ store: 'workbench', ref: { id: artifact.id, sha256: artifact.sha256 } });
      if (artifact.present && resolved === null) {
        throw new WorkbenchContractError(
          'ARTIFACT_CORRUPT',
          `operation ${entry.operationId} 已提交但依赖 ${artifact.id} 丢失或与其 hash 不一致`,
          { retryable: false, fieldPaths: ['payload.diagramDraftRef'] },
        );
      }
      if (!artifact.present && resolved !== null) {
        throw new WorkbenchContractError(
          'ARTIFACT_CORRUPT',
          `operation ${entry.operationId} 记录 ${artifact.id} 为缺失，但该位置现在存在对象；拒绝把后来出现的对象当作原提交结果`,
          { retryable: false, fieldPaths: ['payload.diagramDraftRef'] },
        );
      }
    }
  }

  /** Decode the committed draft and require it to name its own origin operation. */
  private readCommittedDraft(entry: CommittedPublication, ref: BoundRef): DiagramDraftV2 | null {
    const file = this.resolveRefFile(ref);
    if (file === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const draft = parsed as Partial<DiagramDraftV2>;
    // A correct content hash never substitutes for the committed identity: the
    // object must be a v2 draft AND name the operation the index says committed it.
    if (draft.schemaVersion !== 2) return null;
    if (draft.originOperationId !== entry.operationId) return null;
    if (typeof draft.taskId !== 'string' || typeof draft.ownerSessionId !== 'string') return null;
    if (typeof draft.candidateKey !== 'string') return null;
    return draft as DiagramDraftV2;
  }

  // ----------------- shared update path -----------------

  private async update(
    request: UpdateDesignRequest,
    actor: WorkbenchActor,
    expectedAction: UpdateDesignRequest['action'],
    build: (task: WorkbenchTaskRecord) => { next: WorkbenchTaskRecord; sources: BoundRef[]; staged: StagedArtifact[] } | Promise<{ next: WorkbenchTaskRecord; sources: BoundRef[]; staged: StagedArtifact[] }>,
  ): Promise<DesignPublication> {
    assertSubmissionSize(JSON.stringify(request));
    const parsed = validateUpdateDesignRequest(request);
    if (parsed.action !== expectedAction) {
      throw new WorkbenchContractError(
        'SCHEMA_VIOLATION',
        `this submission was routed as ${expectedAction} but carries action ${parsed.action}`,
        { fieldPaths: ['action'] },
      );
    }
    this.assertActor(actor);

    this.coordinator.acquireWriteLease(`service:${PROCESS_IDENTITY}`);

    const requestHash = hashCanonical({
      action: parsed.action,
      taskId: parsed.taskId,
      expectedDesignRevision: parsed.expectedDesignRevision,
      payload: parsed.payload,
    });

    // The reservation is durable and root-shared: a retry after a restart reuses
    // the same operation id, and two processes cannot independently allocate two
    // operation ids for one command key.
    const reuse = this.reserveOrReuse(actor.ownerSessionId, parsed.action, parsed.commandId, requestHash);
    if (reuse.reused) return this.readPublication(reuse.operationId);

    return this.withTaskLock(parsed.taskId, async () => {
      const task = this.readTask(parsed.taskId);
      if (task === null) {
        throw new WorkbenchContractError('DEPENDENCY_NOT_READY', `no product task ${parsed.taskId}`, { fieldPaths: ['taskId'] });
      }
      if (task.ownerSessionId !== actor.ownerSessionId) {
        throw new WorkbenchContractError(
          'OWNER_MISMATCH',
          `task ${task.taskId} belongs to another session; a workspace READ grant is not a write permission`,
          { fieldPaths: ['taskId'] },
        );
      }
      // CAS, re-checked under the lock (SPEC §5.3 rule 4).
      if (task.designRevision !== parsed.expectedDesignRevision) {
        throw new WorkbenchContractError(
          'REVISION_CONFLICT',
          `design revision is ${task.designRevision}, not ${parsed.expectedDesignRevision}; re-read the stage context and submit a new command`,
          { retryable: true, fieldPaths: ['expectedDesignRevision'] },
        );
      }

      const built = await build(task);
      // Source-anchor re-check while the lock is held.
      await this.assertSourcesFresh(built.sources);

      // SPEC section R4.3: an attach of a ref the task ALREADY carries is a
      // no-change command. Re-appending the same diagram ref would both duplicate
      // the entry in `diagramRefs` and mint a second revision for a design that
      // did not change, so the committed task is returned as-is with an explicit
      // no_change receipt and zero increment.
      if (parsed.action === 'attach_diagram') {
        const nextDiagramRefs = (built.next as { diagramRefs?: BoundRef[] }).diagramRefs ?? [];
        // The append happens before this check, so the no-change signal is
        // "the appended set contains nothing the task did not already carry",
        // not a length comparison: re-appending an existing ref grows the array
        // by one while adding zero new designs.
        const known = new Set(task.diagramRefs.map((r) => `${r.ref.id}:${r.ref.sha256}`));
        const genuinelyNew = nextDiagramRefs.some((r) => !known.has(`${r.ref.id}:${r.ref.sha256}`));
        if (!genuinelyNew) {
          const noChangeOperation: DesignOperation = {
            schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
            operationId: reuse.operationId,
            commandId: parsed.commandId,
            requestHash,
            ownerSessionId: actor.ownerSessionId,
            action: parsed.action,
            taskId: task.taskId,
            designRevision: task.designRevision,
            status: 'succeeded',
            resultRefs: [],
            snapshotRef: this.currentTaskSnapshotRef(task.taskId) as WorkbenchBoundRef,
            createdAt: new Date().toISOString(),
          };
          const artifactSet: PublicationArtifactIdentity[] = [
            { id: noChangeOperation.snapshotRef.ref.id, sha256: noChangeOperation.snapshotRef.ref.sha256, present: true },
          ];
          this.coordinator.commitPublication({
            schemaVersion: 2,
            key: canonicalCommandKey({ ownerSessionId: actor.ownerSessionId, action: parsed.action, commandId: parsed.commandId }),
            ownerSessionId: actor.ownerSessionId,
            action: parsed.action,
            commandId: parsed.commandId,
            taskId: task.taskId,
            operationId: reuse.operationId,
            requestBaseHash: requestHash,
            requestHash,
            expectedDesignRevision: task.designRevision,
            candidateKey: '',
            variantKey: null,
            semanticGraphRef: noChangeOperation.snapshotRef,
            semanticHash: noChangeOperation.snapshotRef.ref.sha256,
            format: parsed.action,
            createdAt: noChangeOperation.createdAt,
            state: 'prepared',
          }, {
            receipt: { ...(toReceipt(noChangeOperation) as unknown as Record<string, unknown>), action: 'no_change' },
            artifactSet,
            artifactSetHash: artifactSetHash(artifactSet),
          });
          return { receipt: { ...toReceipt(noChangeOperation), reused: true, action: 'no_change' }, operation: noChangeOperation, task };
        }
      }

      const next: WorkbenchTaskRecord = {
        ...built.next,
        designRevision: task.designRevision + 1,
        updatedAt: new Date().toISOString(),
      };
      return this.commit(reuse.operationId, parsed.commandId, requestHash, actor, parsed.action, next, next.designRevision, built.staged);
    });
  }

  /**
   * Verify every referenced source still hashes to what the binding claims.
   *
   * Run under the lock, AFTER the payload validated, because a P6 result may
   * have been republished in between. A mismatch is SOURCE_MISMATCH, never a
   * best-effort continue.
   */
  private async assertSourcesFresh(sources: BoundRef[]): Promise<void> {
    for (const ref of sources) {
      const actual = this.resolver.actualHash(ref);
      if (actual === null) {
        throw new WorkbenchContractError('DEPENDENCY_NOT_READY', `source artifact ${ref.ref.id} no longer resolves in store ${ref.store}`, { fieldPaths: ['payload'] });
      }
      if (actual !== ref.ref.sha256) {
        throw new WorkbenchContractError(
          'SOURCE_MISMATCH',
          `source artifact ${ref.ref.id} now hashes to ${actual.slice(0, 12)}, not ${ref.ref.sha256.slice(0, 12)}`,
          { fieldPaths: ['payload'] },
        );
      }
    }
  }

  // ----------------- commit + publication -----------------

  /**
   * Publish atomically: promote staged artifacts, write the immutable snapshot,
   * then the operation descriptor, then the index flip. Only the index flip
   * makes the new revision visible, so a crash at any earlier point leaves the
   * previous revision intact and readable (SPEC §5.3 rule 5, WR-24).
   *
   * `staged` carries the staged files whose refs still need promoting. The
   * snapshot is written with the PROMOTED refs, so a reader never sees a task
   * record pointing at something that only exists in staging.
   */
  private commit(
    operationId: string,
    commandId: string,
    requestHash: string,
    actor: WorkbenchActor,
    action: string,
    task: WorkbenchTaskRecord,
    designRevision: number,
    staged: Array<{ file: string; ref: BoundRef }>,
  ): DesignPublication {
    const promoted = new Map<string, BoundRef>();
    for (const item of staged) {
      promoted.set(item.ref.ref.id, this.promoteStaged(item.file, item.ref, operationId));
    }
    // Rewrite refs that were appended by this operation. Earlier revisions keep
    // their own already-published refs, which must NOT be rewritten.
    const freshest: BoundRef[] = [];
    for (const ref of task.annotationRefs) {
      const replacement = promoted.get(ref.ref.id);
      if (replacement !== undefined) freshest.push(replacement);
    }

    const publishedTask: WorkbenchTaskRecord = {
      ...task,
      annotationRefs: mergePublishedRefs(task.annotationRefs, promoted),
    };
    const publishedDir = path.join(this.publishedRoot, 'operations', operationId);
    const snapshot = this.writeImmutable(publishedDir, 'task.json', publishedTask);

    const operation: DesignOperation = {
      schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
      operationId,
      commandId,
      requestHash,
      ownerSessionId: actor.ownerSessionId,
      action,
      taskId: publishedTask.taskId,
      designRevision,
      status: 'succeeded',
      resultRefs: freshest,
      snapshotRef: snapshot.ref,
      createdAt: new Date().toISOString(),
    };
    const key = canonicalCommandKey({ ownerSessionId: actor.ownerSessionId, action, commandId });
    const existingIntent = this.coordinator.readIntent(key);
    const intent: PublicationCommandIntent = existingIntent ?? {
      schemaVersion: 2,
      key,
      ownerSessionId: actor.ownerSessionId,
      action,
      commandId,
      taskId: publishedTask.taskId,
      operationId,
      requestBaseHash: requestHash,
      requestHash,
      expectedDesignRevision: Math.max(1, designRevision - 1),
      candidateKey: '',
      variantKey: null,
      semanticGraphRef: { store: 'workbench', ref: { id: 'task-snapshot', sha256: snapshot.ref.ref.sha256 } },
      semanticHash: snapshot.ref.ref.sha256,
      format: action,
      createdAt: operation.createdAt,
      state: 'prepared',
    };
    if (existingIntent === null) this.coordinator.writeIntent(intent);
    const artifactSet: PublicationArtifactIdentity[] = [
      { id: snapshot.ref.ref.id, sha256: snapshot.ref.ref.sha256, present: true },
    ];
    this.coordinator.writeIntent({
      ...intent,
      taskId: publishedTask.taskId,
      semanticHash: snapshot.ref.ref.sha256,
      state: 'frozen',
      artifactSet,
      artifactSetHash: artifactSetHash(artifactSet),
      frozenAt: operation.createdAt,
    });
    this.coordinator.commitPublication(intent, {
      receipt: toReceipt(operation) as unknown as Record<string, unknown>,
      artifactSet,
      artifactSetHash: artifactSetHash(artifactSet),
      taskPointer: { snapshotRef: snapshot.ref, designRevision },
    });
    // The old per-file operation and task indexes are rebuildable caches only.
    // The root commit index above is the business-visible commit point.
    try {
      this.writeJsonAtomic(path.join(this.root, 'operations', `${operationId}.json`), operation);
      const cache = this.readJsonMap<{ snapshotRef: WorkbenchBoundRef }>(this.indexPath('tasks.json'));
      cache.set(publishedTask.taskId, { snapshotRef: snapshot.ref });
      this.writeJsonAtomic(this.indexPath('tasks.json'), Object.fromEntries(cache));
      const commands = this.readJsonMap<CommandIndexEntry>(this.indexPath('commands.json'));
      const commandKey = `${actor.ownerSessionId}::${action}::${commandId}`;
      commands.set(commandKey, { operationId, requestHash, ownerSessionId: actor.ownerSessionId });
      this.writeJsonAtomic(this.indexPath('commands.json'), Object.fromEntries(commands));
    } catch { /* cache maintenance cannot revoke a commit */ }

    return { receipt: toReceipt(operation), operation, task: publishedTask };
  }

  /**
   * Reserve/reuse the durable intent BEFORE creating any publication objects.
   *
   * SPEC section 3.3: command keys are canonical tuples, not ambiguous
   * `owner::action::command` strings. The root commit index holds the reservation
   * and the per-file command index is only a cache derived from it. The old code
   * could allocate a new operation after restart if that cache vanished, and two
   * writers could each reserve the same key independently.
   */
  private reserveOrReuse(ownerSessionId: string, action: string, commandId: string, requestHash: string): { operationId: string; reused: boolean } {
    const key = canonicalCommandKey({ ownerSessionId, action, commandId });
    const committed = this.coordinator.readCommitIndex().publications[key];
    if (committed !== undefined) {
      if (committed.requestHash !== requestHash) {
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `commandId ${JSON.stringify(commandId)} was already used by this owner with different content; the original receipt is preserved`, { fieldPaths: ['commandId'] });
      }
      return { operationId: committed.operationId, reused: true };
    }
    const intent = this.coordinator.readIntent(key);
    if (intent !== null) {
      if (intent.requestHash !== requestHash) {
        throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `commandId ${JSON.stringify(commandId)} already has a durable intent with different request inputs`, { fieldPaths: ['commandId'] });
      }
      // An intent without a root-index commit is never granted success. R5 may
      // recover it from its original frozen set; until then fail closed instead
      // of allocating another operation or adopting new scratch.
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `commandId ${JSON.stringify(commandId)} has a durable ${intent.state} intent for operation ${intent.operationId} but no commit; recovery is required`, { retryable: true, fieldPaths: ['commandId'] });
    }

    const operationId = `wop-${action}-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
    const cache = this.readJsonMap<CommandIndexEntry>(this.indexPath('commands.json'));
    const old = cache.get(`${ownerSessionId}::${action}::${commandId}`);
    if (old !== undefined && old.requestHash !== requestHash) {
      throw new WorkbenchContractError('IDEMPOTENCY_CONFLICT', `commandId ${JSON.stringify(commandId)} was already used with different content; its original receipt is preserved`, { fieldPaths: ['commandId'] });
    }
    // The cache reservation is diagnostic only. Durable intent with the actual
    // task pins is written at the start of commit(), before any output object.
    return { operationId: old?.operationId ?? operationId, reused: old !== undefined };
  }

  private readPublication(operationId: string): DesignPublication {
    const operation = this.readJson<DesignOperation>(path.join(this.root, 'operations', `${operationId}.json`));
    if (operation === null) {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `operation ${operationId} is indexed but its descriptor is missing`, { fieldPaths: ['commandId'] });
    }
    const task = this.readJson<WorkbenchTaskRecord>(this.operationSnapshotFile(operationId));
    if (task === null) {
      throw new WorkbenchContractError('RECONCILIATION_REQUIRED', `operation ${operationId} is indexed but its snapshot is missing`, { fieldPaths: ['commandId'] });
    }
    return { receipt: { ...toReceipt(operation), reused: true }, operation, task };
  }

  // ----------------- stage context (SPEC §6) -----------------

  /**
   * Derive the stage context WITHOUT a model call.
   *
   * The derivation is deliberately mechanical and evidence-based:
   *  - `working` requires a live operation, never a guess;
   *  - `complete` requires the publication that actually completes the stage;
   *  - `blocked` names the missing prerequisite instead of implying progress.
   * The resolver supplies the facts; this method decides only how to say them.
   */
  async getStageContext(
    task: WorkbenchTaskRecord,
    opts: {
      stage?: WorkbenchStage;
      candidateKey?: string;
      facts: StageFacts;
      policyRef: BoundRef;
      skillRef: StageContext['skillRef'];
      budgetRef: BoundRef | null;
      /**
       * The semantic graph for the selected candidate, and where a diagram of it
       * must be written. Supplied by the HOST because only it knows the scratch
       * root and the registered profile adapter.
       */
      semanticGraph?: StageContext['semanticGraph'];
    },
  ): Promise<StageContext> {
    const candidates = task.candidateBindings.map((b) => b.candidateKey);
    if (opts.candidateKey !== undefined && !candidates.includes(opts.candidateKey)) {
      throw new WorkbenchContractError('DEPENDENCY_NOT_READY', `candidateKey ${opts.candidateKey} is not bound to ${task.taskId}`, { fieldPaths: ['candidateKey'] });
    }
    // SPEC §6.1: with several candidates and none named, do NOT silently pick the
    // first branch — return a context that says a choice is required.
    const needsChoice = opts.candidateKey === undefined && candidates.length > 1;
    const stage = opts.stage ?? 'discovery';

    const unresolved: Array<{ code: string; reasonZh: string }> = [];
    if (needsChoice && (stage === 'implementation' || stage === 'analysis' || stage === 'next_proposal')) {
      unresolved.push({ code: 'CANDIDATE_REQUIRED', reasonZh: `该任务有 ${candidates.length} 个候选，请先选定 candidateKey 再进入${stageZh(stage)}阶段。` });
    }

    const state = deriveStageState(stage, opts.facts, unresolved);
    const inputRefs = [...opts.facts.inputRefs];
    const graphRef = opts.semanticGraph?.graphRef;
    if (graphRef !== undefined && !inputRefs.some((ref) => ref.store === graphRef.store && ref.ref.id === graphRef.ref.id && ref.ref.sha256 === graphRef.ref.sha256)) {
      inputRefs.push(graphRef);
    }
    const selectedCandidateKey = opts.candidateKey ?? (candidates.length === 1 ? candidates[0] : undefined);
    const selectedBinding = selectedCandidateKey === undefined
      ? undefined
      : task.candidateBindings.find((binding) => binding.candidateKey === selectedCandidateKey);
    const sourceTaskRevisions = await this.sourceTaskRevisionsFor(selectedBinding?.sourceTaskRefs ?? task.sourceTaskRefs);
    return {
      schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
      taskId: task.taskId,
      candidateKey: opts.candidateKey ?? (candidates.length === 1 ? candidates[0] : null),
      designRevision: task.designRevision,
      stage,
      stageState: state,
      sourceTaskRevisions,
      // Null rather than an empty string or a stale value: "no graph yet" and "a
      // graph with no hash" are different facts, and the diagram Skill needs to be
      // able to tell them apart.
      semanticGraph: opts.semanticGraph ?? null,
      objectiveZh: opts.facts.objectiveZh,
      inputRefs,
      allowedActions: opts.facts.allowedActions,
      expectedOutputs: opts.facts.expectedOutputs,
      exitCriteriaZh: opts.facts.exitCriteriaZh,
      unresolved: [...unresolved, ...opts.facts.unresolved],
      skillRef: opts.skillRef,
      policyRef: opts.policyRef,
      budgetRef: opts.budgetRef,
    };
  }

  private assertActor(actor: WorkbenchActor): void {
    if (typeof actor?.ownerSessionId !== 'string' || actor.ownerSessionId.trim().length === 0) {
      throw new WorkbenchContractError('OWNER_MISMATCH', 'the caller must supply its own ownerSessionId; a write with no owner is refused', { fieldPaths: ['ownerSessionId'] });
    }
  }
}

/** Facts the stage derivation needs, gathered by the adapter — never guessed. */
export interface StageFacts {
  objectiveZh: string;
  inputRefs: BoundRef[];
  allowedActions: Array<{ tool: string; purposeZh: string }>;
  expectedOutputs: string[];
  exitCriteriaZh: string[];
  unresolved: Array<{ code: string; reasonZh: string }>;
  /** A non-terminal operation in flight for this stage, if any. */
  workingOperationId: string | null;
  /** The publication that would complete this stage, if it already exists. */
  completedBy: { operationId: string; resultRefs: BoundRef[] } | null;
}

function deriveStageState(
  stage: WorkbenchStage,
  facts: StageFacts,
  unresolved: Array<{ code: string; reasonZh: string }>,
): StageContext['stageState'] {
  if (facts.completedBy !== null) return 'complete';
  if (facts.workingOperationId !== null) return 'working';
  if (unresolved.length > 0) return 'blocked';
  return 'actionable';
}

function stageZh(stage: WorkbenchStage): string {
  const map: Record<WorkbenchStage, string> = {
    discovery: '读论文',
    composition: '设计组合',
    implementation: '代码接入',
    analysis: '实验分析',
    next_proposal: '下一步规划',
  };
  return map[stage];
}

// ----------------- pure helpers -----------------

/**
 * Apply a verified binding.
 *
 * Re-binding the SAME candidate is idempotent and does NOT duplicate the entry:
 * the binding is a fact about identity, so a second identical submission adds
 * nothing and would only make the task menu noisier.
 */
function applyBinding(
  task: WorkbenchTaskRecord,
  input: CandidateBindingInput,
  graphPins?: CandidateGraphPins | null,
): WorkbenchTaskRecord {
  const candidateKey = computeCandidateKey(input);
  const existingIndex = task.candidateBindings.findIndex((binding) => binding.candidateKey === candidateKey);
  if (existingIndex >= 0) {
    const existing = task.candidateBindings[existingIndex] as CandidateBinding;
    if (graphPins === undefined || graphPins === null || JSON.stringify(existing.graphPins ?? null) === JSON.stringify(graphPins)) return task;
    const candidateBindings = [...task.candidateBindings];
    candidateBindings[existingIndex] = { ...existing, graphPins };
    return { ...task, candidateBindings };
  }
  const binding: CandidateBinding = { ...input, candidateKey, graphPins: graphPins ?? null };
  const sourceTaskRefs = dedupeSourceTaskRefs([...task.sourceTaskRefs, ...input.sourceTaskRefs]);
  return { ...task, candidateBindings: [...task.candidateBindings, binding], sourceTaskRefs };
}

function dedupeSourceTaskRefs(refs: SourceTaskRef[]): SourceTaskRef[] {
  const seen = new Set<string>();
  const out: SourceTaskRef[] = [];
  for (const ref of refs) {
    const key = `${ref.store}:${ref.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function toReceipt(operation: DesignOperation): DesignReceipt {
  return {
    schemaVersion: WORKBENCH_RESEARCH_SCHEMA_VERSION,
    operationId: operation.operationId,
    commandId: operation.commandId,
    requestHash: operation.requestHash,
    taskId: operation.taskId,
    designRevision: operation.designRevision,
    resultRefs: operation.resultRefs,
    reused: false,
  };
}

/**
 * Deterministic hash of a submitted payload.
 *
 * Key order must not change the hash, or the same logical command could look
 * like two different commands on replay and raise IDEMPOTENCY_CONFLICT.
 */
function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

/** Content-addressed annotation name: same content reuses the same artifact. */
function annotationSha(seed: string, body: unknown): string {
  return `ann-${createHash('sha256').update(`${seed}\n${canonicalize(body)}`).digest('hex').slice(0, 24)}`;
}
