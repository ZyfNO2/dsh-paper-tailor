/**
 * WorkbenchResearchStore: the v3 READ-ONLY projection.
 *
 * Spec: docs/mvp/WORKBENCH-RESEARCH-SPEC.md sections 2.3, 3, 7.1.
 *
 * Why a separate class instead of extending `WorkbenchStore`
 * --------------------------------------------------------
 * `WorkbenchStore` is the v2 projection and it is covered by 28 passing
 * assertions. Adding v3 methods to it would put two contracts in one class and
 * make "v2 still works" unverifiable by inspection. This store therefore:
 *
 *   - READS through `WorkbenchStore` for everything v2 already resolves
 *     correctly (graph, comparisons, operations, papers, artifacts), and
 *   - ADDS the v3-only surface: the product task record, candidate designs with
 *     their evidence-preserving rationale, typed method tags, the qualified
 *     task identity, and the change token.
 *
 * v2 behaviour is never modified. The only shared code is the resolver logic
 * that reads the real stores.
 *
 * The three rules this file exists to enforce
 * ------------------------------------------
 * 1. **Qualified identity.** SPEC section 7.1 forbids "first store that matches
 *    wins". v3 therefore reports the store a task actually came from and
 *    refuses to resolve a bare id that is ambiguous across stores.
 * 2. **Separate revisions.** A v3 snapshot names which revision it carries
 *    (`revisionKind`), because designRevision and an experiment taskRevision
 *    are different clocks (SPEC section 2.3).
 * 3. **An honest change token.** The token covers design revision, bound source
 *    revisions and the hashes of rendered artifacts — never `generatedAt`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  WORKBENCH_SCHEMA_VERSION_3,
  WorkbenchContractError,
  type BoundRef,
  type CandidateBinding,
  type CandidateGraphPins,
  type ChangeToken,
  type ChangedRegion,
  type CompositionExplanation,
  type GraphSnapshot,
  type MethodTag,
  type ModelDataFlow,
  type RevisionKind,
  type SourceTaskRef,
  type WorkbenchTaskRecord,
} from '../../contracts/workbench.ts';
import {
  methodTagFromCard,
  paperOnlyRef,
  resolveCandidateView,
  type ResolvedCandidateView,
} from '../../domain/workbench-research.ts';
import {
  SEMANTIC_HASH_ALGORITHM_V2,
  buildModelDataFlow,
  readAdaptationBinding,
  readProtocolVariants,
} from '../../domain/model-dataflow.ts';
import {
  ScopedRoot,
  readBoundedArtifact,
} from './workbench-store-access.ts';
import { WorkbenchStore, type WorkbenchPaperCardV2, type WorkbenchRoots } from './workbench-projection.ts';
import { EXPERIMENT_STORE_RESERVED_DIRS } from '../../application/experiment-service.ts';
import type { WorkbenchResearchService } from '../../application/workbench-research-service.ts';

type Json = Record<string, unknown>;
type ResolvedAdaptationPlan = {
  body: Json;
  ref: BoundRef;
  protocolRef: BoundRef | null;
  profileRef: string | null;
  variants: Array<{ id: string; role: string; moduleRefs: string[] }>;
  selectedVariantKey: string | null;
  selectedModuleIds: string[];
};
type AdaptationPlanResolution =
  | { ok: true; value: ResolvedAdaptationPlan }
  | { ok: false; code: string; message: string };
type ProfilePinResolution =
  | { ok: true; profileRef: BoundRef | null; sourceRefs: BoundRef[] }
  | { ok: false; code: string; message: string };
type P6ReadResult =
  | { ok: true; body: Json }
  | { ok: false; code: string; message: string };
type CandidateGraphPinsResolution =
  | { ok: true; pins: CandidateGraphPins }
  | { ok: false; code: string; message: string };
type PinnedJsonRead =
  | { ok: true; body: Json; file: string; sha256: string }
  | { ok: false; code: string; message: string };

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function readJsonFile(file: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Json;
  } catch {
    return null;
  }
}

// ----------------- v3 DTOs -----------------

/**
 * "This store keeps no revision" — distinct from `null` ("unknown") and from 0.
 *
 * Phase 3 operations carry no `revision` field at all, so a v3 snapshot must be
 * able to say "there is no experiment revision here" instead of inventing one
 * that looks like a task which had never advanced.
 */
export const PHASE3_HAS_NO_REVISION = -1 as const;

export type SourceRevision = number | typeof PHASE3_HAS_NO_REVISION | null;

/**
 * Which store a task id actually came from.
 *
 * `sourceKind` + `sourcePhase` let the UI present a qualified menu entry
 * without guessing (SPEC section 7.1), and let the resolver return the real
 * `{store, taskId}` pair instead of the first directory that matched.
 */
export type TaskStoreName = 'phase2' | 'phase3' | 'workbench' | 'paper_only';

export interface QualifiedTaskRef {
  taskId: string;
  store: TaskStoreName;
  phase: 'phase2' | 'phase3' | 'product';
  /** Product tasks carry a design revision; experiment tasks their own. */
  revisionKind: RevisionKind;
}

export interface CandidateDesignV3 {
  candidateKey: string;
  binding: CandidateBinding;
  /** null when the candidate could not be resolved; `unresolved` then explains why. */
  rationale: CompositionExplanation | null;
  decision: string | null;
  performanceStatus: string | null;
  moduleCardRefs: string[];
  baselineCardRef: string | null;
  moduleTags: MethodTag[];
  unresolved: Array<{ code: string; reasonZh: string }>;
}

export interface WorkbenchSnapshotV3 {
  schemaVersion: 3;
  taskId: string;
  displayName: string;
  /** Kept for compatibility; v3 says WHICH revision this is. */
  revision: number;
  revisionKind: RevisionKind;
  designRevision: number | null;
  sourceTaskRevisions: Array<{ store: 'phase2' | 'phase3'; taskId: string; revision: number }>;
  viewEpoch: string;
  viewSequence: number;
  viewVersion: string;
  /** The store the graph was built from, plus the qualified identity. */
  source: {
    store: TaskStoreName;
    phase: 'phase2' | 'phase3' | 'product';
    storageRoot: string;
    taskRef: string | null;
    experimentTaskId: string | null;
  };
  protocolRef: string | null;
  issues: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;
  /** The v2 graph, unchanged, so the three workspaces keep working. */
  graph: unknown;
  candidateDesigns: CandidateDesignV3[];
  stageSummary: Array<{ stage: string; stageState: string; reasonZh: string | null }>;
  generatedAt: string;
}

export interface PaperCardV3 {
  paperId: string;
  title: string | null;
  titleUnknownReason: string | null;
  documentHash: string | null;
  /** Real method names, not counts (SPEC section 3.2). */
  methodTags: MethodTag[];
  /** v2 fields are carried through unchanged. */
  legacy: WorkbenchPaperCardV2;
}

// ----------------- store -----------------

export interface WorkbenchResearchRoots extends WorkbenchRoots {
  workbenchResearchRoot: string;
}

export class WorkbenchResearchStore {
  private readonly v2: WorkbenchStore;
  private readonly researchService: WorkbenchResearchService;
  private readonly paperRoot: ScopedRoot;
  private readonly repoRoot: string;
  /** Changes on process start; only comparable within one epoch. */
  private readonly viewEpoch: string;
  private sequence = 0;
  /**
   * The source-task revision last REPORTED as changed, per `store:taskId`.
   *
   * Without it the store cannot tell "this experiment moved" from "this
   * experiment has a revision" — comparing a fresh read against another fresh
   * read always agrees, which is why an earlier version's region split could
   * never fire.
   */
  private readonly lastSeenSourceRevisions = new Map<string, number>();

  constructor(opts: { roots: WorkbenchResearchRoots; repoRoot: string; researchService: WorkbenchResearchService }) {
    this.v2 = new WorkbenchStore(opts.roots);
    this.researchService = opts.researchService;
    this.paperRoot = new ScopedRoot('paper-only', path.resolve(opts.roots.paperOnlyRoot));
    this.repoRoot = path.resolve(opts.repoRoot);
    // An epoch per process instance. A restart must invalidate every comparison
    // a page is holding, because viewSequence restarts from 0 here.
    this.viewEpoch = `ve-${Date.now().toString(36)}-${createHash('sha256').update(String(process.pid)).digest('hex').slice(0, 8)}`;
  }

  /** The schema version this store serves. `/status` keeps advertising v2. */
  get schemaVersion(): 3 {
    return WORKBENCH_SCHEMA_VERSION_3;
  }

  get viewEpochId(): string {
    return this.viewEpoch;
  }

  describeRoots(): Record<string, string> {
    return { ...this.v2.describeRoots(), workbenchResearchRoot: this.researchService.describeRoot() };
  }

  // ------------------------- qualified identity -------------------------

  /**
   * Resolve a bare task id to the store it really lives in.
   *
   * A bare id is returned only when it is UNAMBIGUOUS. If the same id exists in
   * two stores the result is null with both candidates listed, because the
   * caller then has to pick from a qualified menu — exactly what SPEC section
   * 7.1 requires instead of "first match wins".
   */
  resolveQualified(taskId: string): { ok: true; value: QualifiedTaskRef } | { ok: false; ambiguous: QualifiedTaskRef[] } {
    const candidates: QualifiedTaskRef[] = [];
    if (this.researchService.hasTask(taskId)) {
      candidates.push({ taskId, store: 'workbench', phase: 'product', revisionKind: 'design' });
    }
    for (const id of this.phase3TaskIds()) {
      if (id === taskId) candidates.push({ taskId, store: 'phase3', phase: 'phase3', revisionKind: 'source_task' });
    }
    if (this.phase2TaskIds().includes(taskId)) {
      candidates.push({ taskId, store: 'phase2', phase: 'phase2', revisionKind: 'source_task' });
    }
    if (candidates.length === 1) return { ok: true, value: candidates[0] };
    // Zero stores is NOT ambiguity. Reporting AMBIGUOUS_TASK with an empty list
    // would tell the page to pick from a menu with nothing in it, instead of
    // saying the task does not exist.
    if (candidates.length === 0) return { ok: false, ambiguous: [] };
    return { ok: false, ambiguous: candidates };
  }

  private phase2TaskIds(): string[] {
    try {
      return fs
        .readdirSync(this.v2Root('research-execution'), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        // NOT `startsWith('task-')`: a product task id is `wb-…`, so a store
        // holding one would make it invisible here and the id would resolve
        // unambiguously when it is in fact duplicated. The store's own
        // directories are the truth; the naming convention is not.
        //
        // But "every directory" is also wrong, and that is what shipped: a real
        // storage root keeps its own bookkeeping directories (`index`,
        // `operations`, `owners`, `published`, `submitted`) beside the tasks, so
        // the live v3 task list offered five of the store's internals as if they
        // were research tasks. `task-phase2-combo` and `operations` looked alike
        // to a bare readdir. The reserved names are excluded explicitly, from
        // the list the service itself creates them from.
        .filter((d) => !(EXPERIMENT_STORE_RESERVED_DIRS as readonly string[]).includes(d.name))
        .map((d) => d.name)
        .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))
        .sort();
    } catch {
      return [];
    }
  }

  private phase3TaskIds(): string[] {
    try {
      const ids = new Set<string>();
      const dir = path.join(this.v2Root('phase3-experiments'), 'operations');
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const op = readJsonFile(path.join(dir, f));
        const taskId = str(op?.taskId);
        if (taskId !== null) ids.add(taskId);
      }
      return [...ids].sort();
    } catch {
      return [];
    }
  }

  private v2Root(name: 'research-execution' | 'paper-only' | 'phase3-experiments'): string {
    const roots = this.v2.describeRoots();
    if (name === 'research-execution') return roots.researchExecutionRoot;
    if (name === 'paper-only') return roots.paperOnlyRoot;
    return roots.phase3ExperimentRoot;
  }

  // ------------------------- tasks -------------------------

  /** Product tasks plus the v2 experiment tasks, each with its store named. */
  listTasksV3(cursor: string | null, limit: number): { tasks: QualifiedTaskRef[]; nextCursor: string | null } {
    const all: QualifiedTaskRef[] = this.researchService
      .listTasks()
      .map((t) => ({ taskId: t.taskId, store: 'workbench' as const, phase: 'product' as const, revisionKind: 'design' as const }));
    for (const id of this.phase2TaskIds()) {
      all.push({ taskId: id, store: 'phase2', phase: 'phase2', revisionKind: 'source_task' });
    }
    for (const id of this.phase3TaskIds()) {
      all.push({ taskId: id, store: 'phase3', phase: 'phase3', revisionKind: 'source_task' });
    }
    const start = cursor === null ? 0 : Math.max(0, all.findIndex((t) => t.taskId === cursor) + 1);
    const page = all.slice(start, start + limit);
    const consumed = start + page.length;
    return { tasks: page, nextCursor: consumed < all.length ? (page[page.length - 1]?.taskId ?? null) : null };
  }

  // ------------------------- snapshot -------------------------

  /**
   * The v3 snapshot for one task.
   *
   * The change token is computed from the SIDE'S FACTS, and the sequence is
   * assigned here rather than taken from a clock, so two identical reads inside
   * one epoch produce the same version and a poll that finds nothing new does
   * not force a re-render (SPEC section 7.2).
   */
  async getSnapshotV3(taskId: string): Promise<{ ok: true; value: WorkbenchSnapshotV3 } | { ok: false; code: string; message: string; candidates?: QualifiedTaskRef[] }> {
    const qualified = this.resolveQualified(taskId);
    if (!qualified.ok) {
      if (qualified.ambiguous.length === 0) {
        return { ok: false, code: 'NOT_FOUND', message: `no store holds a task named ${taskId}` };
      }
      return {
        ok: false,
        code: 'AMBIGUOUS_TASK',
        message: `taskId ${taskId} exists in ${qualified.ambiguous.length} stores; the caller must choose a qualified identity`,
        candidates: qualified.ambiguous,
      };
    }
    const q = qualified.value;

    if (q.store === 'workbench') {
      const product = await this.productSnapshot(taskId);
      if (product !== null) return product;
    }
    // Fall through to the v2 graph, which stays byte-identical.
    const legacy = this.v2.getWorkbench(taskId);
    if ('error' in legacy) {
      return { ok: false, code: 'NOT_FOUND', message: legacy.error };
    }
    this.sequence += 1;
    const revision = typeof legacy.revision === 'number' ? legacy.revision : 0;
    return {
      ok: true,
      value: {
        schemaVersion: WORKBENCH_SCHEMA_VERSION_3,
        taskId,
        displayName: legacy.displayName,
        revision,
        revisionKind: 'source_task',
        designRevision: null,
        sourceTaskRevisions: [{ store: q.phase === 'phase3' ? 'phase3' : 'phase2', taskId, revision }],
        viewEpoch: this.viewEpoch,
        viewSequence: this.sequence,
        // A v2 task's token covers its revision and the epoch: the only two
        // things v2 can change.
        viewVersion: createHash('sha256').update(`${taskId}|${revision}|${this.viewEpoch}`).digest('hex'),
        source: {
          store: q.store,
          phase: q.phase === 'product' ? 'phase2' : q.phase,
          storageRoot: this.v2Root(q.store === 'phase3' ? 'phase3-experiments' : 'research-execution'),
          taskRef: legacy.source.taskRef,
          experimentTaskId: legacy.source.experimentTaskId,
        },
        protocolRef: legacy.protocolRef,
        issues: legacy.issues,
        graph: { nodes: legacy.nodes, edges: legacy.edges, operations: legacy.operations, latestComparisonRef: legacy.latestComparisonRef },
        candidateDesigns: [],
        stageSummary: [],
        generatedAt: new Date().toISOString(),
      },
    };
  }

  private async productSnapshot(taskId: string): Promise<{ ok: true; value: WorkbenchSnapshotV3 } | null> {
    const task = this.researchService.readTask(taskId);
    if (task === null) return null;
    const designs = await this.candidateDesigns(task);
    const viewVersion = await this.researchService.computeViewVersion(task);
    this.sequence += 1;
    return {
      ok: true,
      value: {
        schemaVersion: WORKBENCH_SCHEMA_VERSION_3,
        taskId,
        displayName: task.displayNameZh,
        revision: task.designRevision,
        revisionKind: 'design',
        designRevision: task.designRevision,
        sourceTaskRevisions: await this.researchService.sourceTaskRevisions(task),
        viewEpoch: this.viewEpoch,
        viewSequence: this.sequence,
        viewVersion,
        source: {
          store: 'workbench',
          phase: 'product',
          storageRoot: this.researchService.describeRoot(),
          taskRef: null,
          experimentTaskId: task.sourceTaskRefs[0]?.taskId ?? null,
        },
        protocolRef: null,
        issues: [],
        graph: { nodes: [], edges: [], operations: [], latestComparisonRef: null },
        candidateDesigns: designs,
        stageSummary: [],
        generatedAt: new Date().toISOString(),
      },
    };
  }

  // ------------------------- source task revisions -------------------------

  /**
   * The authoritative revision of an EXPERIMENT task, read from its own store.
   *
   * Two facts make this less trivial than reading a field, and both were
   * observed in the real stores:
   *
   *  - a Phase 2 task keeps `index/tasks.json` as a map keyed by taskId, and its
   *    record DOES carry `revision`;
   *  - a Phase 3 task has NO task directory and NO revision field at all — its
   *    operations carry only `taskId`. There is no experiment revision to read,
   *    so the honest answer is null ("unknown"), never 0.
   *
   * Reporting 0 here would make an unrevisioned Phase 3 task look like a task
   * that had never advanced.
   */
  readSourceTaskRevision(taskRef: { store: 'phase2' | 'phase3'; taskId: string }): SourceRevision {
    if (taskRef.store === 'phase2') {
      const index = readJsonFile(path.join(this.v2Root('research-execution'), taskRef.taskId, 'index', 'tasks.json'));
      const record = index?.[taskRef.taskId];
      if (typeof record === 'object' && record !== null && 'revision' in record && typeof record.revision === 'number') {
        return record.revision;
      }
      return null;
    }
    // Phase 3 stores no revision at all: its operations carry `taskId` but no
    // `revision` field, so there is nothing to read. Reporting 0 would render an
    // unrevisioned task as one that had never advanced, which is a different
    // claim. The task's PRESENCE is still knowable, so return a sentinel the
    // caller can distinguish rather than a fake revision.
    return PHASE3_HAS_NO_REVISION;
  }

  /** Whether an experiment task exists at all, for a stage's precondition check. */
  hasSourceTask(taskRef: { store: 'phase2' | 'phase3'; taskId: string }): boolean {
    if (taskRef.store === 'phase2') return this.phase2TaskIds().includes(taskRef.taskId);
    return this.phase3TaskIds().includes(taskRef.taskId);
  }

  // ------------------------- candidate designs -------------------------

  /**
   * Resolve each bound candidate against its REAL P6 artifact.
   *
   * A binding whose artifact no longer resolves, or whose candidate hash has
   * drifted, produces an `unresolved` entry with the reason — not an empty
   * rationale object, and not a fallback to another candidate.
   */
  async candidateDesigns(task: WorkbenchTaskRecord): Promise<CandidateDesignV3[]> {
    const out: CandidateDesignV3[] = [];
    for (const binding of task.candidateBindings) {
      const resolved = this.readP6Result(binding.synthesisResultRef);
      if (!resolved.ok) {
        out.push({
          candidateKey: binding.candidateKey,
          binding,
          rationale: null,
          decision: null,
          performanceStatus: null,
          moduleCardRefs: [],
          baselineCardRef: null,
          moduleTags: [],
          unresolved: [{ code: resolved.code, reasonZh: resolved.message }],
        });
        continue;
      }
      const view: ResolvedCandidateView | null = resolveCandidateView(resolved.body, binding, paperOnlyRef(binding.synthesisResultRef));
      if (view === null) {
        out.push({
          candidateKey: binding.candidateKey,
          binding,
          rationale: null,
          decision: null,
          performanceStatus: null,
          moduleCardRefs: [],
          baselineCardRef: null,
          moduleTags: [],
          unresolved: [{
            code: 'CANDIDATE_DRIFTED',
            reasonZh: `候选 ${binding.candidateId} 在该 P6 产物中的 candidateHash 与绑定不一致，拒绝展示过期理由。`,
          }],
        });
        continue;
      }
      out.push({
        candidateKey: binding.candidateKey,
        binding,
        rationale: view.composition,
        decision: view.decision,
        performanceStatus: view.performanceStatus,
        moduleCardRefs: view.moduleCardRefs.map((r) => r.id),
        baselineCardRef: view.baselineCardRef?.id ?? null,
        moduleTags: this.tagsForCandidate(view),
        unresolved: [],
      });
    }
    return out;
  }

  /** Resolve immutable graph-source identities for the controlled candidate bind. */
  resolveCandidateGraphPins(sourceTaskRefs: SourceTaskRef[]): CandidateGraphPinsResolution {
    const recipe = this.resolveAdaptationPlan(sourceTaskRefs, null, null, true);
    if (!recipe.ok) return recipe;
    const profile = this.resolveProfilePins(recipe.value.profileRef);
    if (!profile.ok) return profile;
    const implementationRefs = profile.sourceRefs.filter((ref) =>
      profile.profileRef === null
      || ref.ref.id !== profile.profileRef.ref.id
      || ref.ref.sha256 !== profile.profileRef.ref.sha256,
    ).sort((a, b) => `${a.store}:${a.ref.id}:${a.ref.sha256}`.localeCompare(`${b.store}:${b.ref.id}:${b.ref.sha256}`));
    return {
      ok: true,
      pins: {
        schemaVersion: 1,
        recipeRef: recipe.value.ref,
        protocolRef: recipe.value.protocolRef,
        profileKey: recipe.value.profileRef,
        profileRef: profile.profileRef,
        implementationRefs,
      },
    };
  }

  private readP6Result(ref: BoundRef['ref']): P6ReadResult {
    const normalizedId = ref.id.replace(/\\/g, '/');
    if (path.isAbsolute(ref.id) || /^[A-Za-z]:/.test(ref.id)) {
      return { ok: false, code: 'SOURCE_MISMATCH', message: `P6 ref ${ref.id} must be a trusted relative artifact id.` };
    }
    // Historical repo-relative P6 refs are permitted only below known artifact
    // roots; other ids are resolved under the paper-only store. No caller path
    // is ever used as a filesystem root.
    const repoRelative = /^(?:artifacts|work|fixtures)\//.test(normalizedId);
    const root = path.resolve(repoRelative ? this.repoRoot : this.paperRoot.root);
    const target = path.resolve(root, normalizedId);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { ok: false, code: 'SOURCE_MISMATCH', message: `P6 ref ${ref.id} escapes its trusted artifact root.` };
    }
    let realRoot: string;
    let realTarget: string;
    let bytes: Buffer;
    try {
      realRoot = fs.realpathSync(root);
      const stat = fs.statSync(target);
      if (!stat.isFile()) return { ok: false, code: 'ARTIFACT_CORRUPT', message: `P6 ref ${ref.id} is not a regular file.` };
      realTarget = fs.realpathSync(target);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        return { ok: false, code: 'SOURCE_MISMATCH', message: `P6 ref ${ref.id} resolves outside its trusted artifact root.` };
      }
      bytes = fs.readFileSync(realTarget);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        return { ok: false, code: 'SOURCE_MISSING', message: `绑定的 P6 产物 ${ref.id} 不存在。` };
      }
      return { ok: false, code: 'SOURCE_IO_ERROR', message: `读取绑定的 P6 产物 ${ref.id} 失败（${String(code ?? 'unknown')}）。` };
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== ref.sha256) {
      return { ok: false, code: 'SOURCE_MISMATCH', message: `P6 ref ${ref.id} hash 不匹配（${actual.slice(0, 12)} vs ${ref.sha256.slice(0, 12)}）。` };
    }
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('P6 result is not an object');
      return { ok: true, body: parsed as Json };
    } catch {
      return { ok: false, code: 'ARTIFACT_CORRUPT', message: `绑定的 P6 产物 ${ref.id} 不是有效 JSON 对象。` };
    }
  }

  /** Typed tags for the modules and baseline a candidate actually names. */
  private tagsForCandidate(view: ResolvedCandidateView): MethodTag[] {
    const cardIds = new Set<string>([view.baselineCardRef?.id, ...view.moduleCardRefs.map((r) => r.id)].filter((v): v is string => typeof v === 'string'));
    const cards = this.findCardsById(cardIds);
    const out: MethodTag[] = [];
    for (const card of cards) {
      const kind = card.kind;
      const tag = methodTagFromCard(card.card, {
        kind,
        source: paperOnlyRef({ id: `card-index/${card.card.id}`, sha256: hashHex(card.card) }),
        // A card named BY a candidate is that candidate's contributed method.
        relation: kind === 'baseline' ? 'contributed_method' : 'contributed_method',
      });
      if (tag !== null) out.push(tag);
    }
    return out;
  }

  /** Index the published P5 cards by id once, then answer lookups from memory. */
  private findCardsById(wanted: Set<string>): Array<{ kind: 'module' | 'baseline'; card: Json }> {
    if (wanted.size === 0) return [];
    const out: Array<{ kind: 'module' | 'baseline'; card: Json }> = [];
    const found = new Set<string>();
    for (const run of this.publishedDiscoveryRuns()) {
      if (found.size === wanted.size) break;
      const result = readJsonFile(path.join(run.dir, 'result.json'));
      if (result === null) continue;
      for (const [kind, key] of [['module', 'moduleCards'], ['baseline', 'baselineCards']] as const) {
        for (const raw of arr(result[key])) {
          const card = raw as Json;
          const id = str(card.id);
          if (id === null || !wanted.has(id) || found.has(id)) continue;
          found.add(id);
          out.push({ kind, card });
        }
      }
    }
    return out;
  }

  private discoveryRunCache: Array<{ dir: string }> | null = null;

  private publishedDiscoveryRuns(): Array<{ dir: string }> {
    if (this.discoveryRunCache !== null) return this.discoveryRunCache;
    const runs: Array<{ dir: string }> = [];
    try {
      // The directory prefix is NOT `p5-`: real runs are named `basic-*`,
      // `p6-*`, `live-*` and so on, and the only reliable marker is the
      // `p5_discover/<invocation>/rop-p5_discover-*` shape beneath them. Matching
      // on a name prefix found zero runs and silently produced an empty method
      // tag list on every paper.
      for (const entry of fs.readdirSync(this.paperRoot.root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const p5Dir = path.join(this.paperRoot.root, entry.name, 'p5_discover');
        if (!fs.existsSync(p5Dir)) continue;
        for (const invocation of fs.readdirSync(p5Dir, { withFileTypes: true })) {
          if (!invocation.isDirectory()) continue;
          const opDir = path.join(p5Dir, invocation.name);
          for (const op of fs.readdirSync(opDir, { withFileTypes: true })) {
            if (op.isDirectory() && op.name.startsWith('rop-p5_discover-')) {
              runs.push({ dir: path.join(opDir, op.name) });
            }
          }
        }
      }
    } catch {
      return [];
    }
    this.discoveryRunCache = runs;
    return runs;
  }

  // ------------------------- papers with method tags -------------------------

  /**
   * Papers carrying typed method tags (SPEC section 3.2).
   *
   * A paper with zero tags is returned anyway. Dropping it would reintroduce
   * the "papers vanish until a candidate binds them" behaviour v2 had, and the
   * empty tag list is itself an honest answer.
   */
  listPapersV3(query = ''): PaperCardV3[] {
    const legacy = this.v2.listPapers(query);
    return legacy.map((p) => ({
      paperId: p.paperId,
      title: p.title,
      titleUnknownReason: p.titleUnknownReason,
      documentHash: p.documentHash,
      methodTags: this.tagsForPaper(p),
      legacy: p,
    }));
  }

  private tagsForPaper(paper: WorkbenchPaperCardV2): MethodTag[] {
    const out: MethodTag[] = [];
    const wanted = new Set<string>(paper.cardRefs);
    if (wanted.size === 0) return out;
    for (const card of this.findCardsById(wanted)) {
      const tag = methodTagFromCard(card.card, {
        kind: card.kind,
        source: paperOnlyRef({ id: `card-index/${card.card.id}`, sha256: hashHex(card.card) }),
        relation: 'extracted_card',
      });
      if (tag !== null) out.push(tag);
    }
    return out;
  }

  /** The bound candidate designs for a task, or an empty list when unreadable. */
  async candidateDesignsFor(taskId: string): Promise<CandidateDesignV3[]> {
    const qualified = this.resolveQualified(taskId);
    if (!qualified.ok) return [];
    if (qualified.value.store === 'workbench') {
      const task = this.researchService.readTask(taskId);
      if (task === null) return [];
      return this.candidateDesigns(task);
    }
    // A non-product task has no candidate bindings by definition; its methods
    // come from the pinned implementations, which the caller already knows.
    return [];
  }

  // ------------------------- model data flow (W4) -------------------------

  /**
   * The model data flow for ONE candidate.
   *
   * Returns a structural refusal rather than an empty graph when the recipe is
   * missing: a baseline-only picture would read as "this candidate has no
   * modules", which is a claim about the research, not about the store.
   */
  async dataflowV3(
    taskId: string,
    candidateKey: string,
    variantKey: string | null,
  ): Promise<{ flow: ModelDataFlow; snapshot: GraphSnapshot; graphRef: BoundRef } | { error: string; code: string; message: string; unresolved?: unknown[] }> {
    const qualified = this.resolveQualified(taskId);
    if (!qualified.ok) {
      if (qualified.ambiguous.length === 0) return { error: 'NOT_FOUND', code: 'NOT_FOUND', message: `no store holds a task named ${taskId}` };
      return { error: 'AMBIGUOUS_TASK', code: 'AMBIGUOUS_TASK', message: `taskId ${taskId} exists in ${qualified.ambiguous.length} stores` };
    }
    const task = this.researchService.readTask(taskId);
    if (task === null) return { error: 'NOT_FOUND', code: 'NOT_FOUND', message: `no product task ${taskId}` };
    const taskSnapshotRefBefore = this.researchService.currentTaskSnapshotRef(taskId);
    if (taskSnapshotRefBefore === null) return { error: 'DEPENDENCY_NOT_READY', code: 'DEPENDENCY_NOT_READY', message: `task ${taskId} has no committed snapshot` };

    const design = (await this.candidateDesigns(task)).find((d) => d.candidateKey === candidateKey);
    if (design === undefined) {
      return { error: 'DEPENDENCY_NOT_READY', code: 'DEPENDENCY_NOT_READY', message: `candidateKey ${candidateKey} is not bound to ${taskId}` };
    }
    if (design.unresolved.length > 0) {
      const issue = design.unresolved[0] as { code: string; reasonZh: string };
      const sourceFailureCodes = new Set(['SOURCE_MISSING', 'SOURCE_IO_ERROR', 'SOURCE_MISMATCH', 'ARTIFACT_CORRUPT']);
      const code = issue.code === 'CANDIDATE_DRIFTED'
        ? 'SOURCE_MISMATCH'
        : sourceFailureCodes.has(issue.code) ? issue.code : 'DEPENDENCY_NOT_READY';
      return { error: code, code, message: issue.reasonZh, unresolved: design.unresolved };
    }
    const sourceTaskRevisionsBefore = await this.researchService.sourceTaskRevisionsFor(design.binding.sourceTaskRefs);

    // The candidate's committed graphPins—not current source heads—select the
    // recipe, protocol, profile and implementation snapshot. A legacy/unpinned
    // binding remains readable for rationale but cannot claim an authoritative graph.
    const graphPins = design.binding.graphPins;
    if (graphPins === undefined || graphPins === null) {
      return { error: 'DEPENDENCY_NOT_READY', code: 'DEPENDENCY_NOT_READY', message: `candidate ${candidateKey} has no committed immutable graph pins; re-submit bind_candidate to resolve them under task CAS` };
    }
    const recipeResolution = this.resolveAdaptationPlan(design.binding.sourceTaskRefs, variantKey, graphPins);
    if (!recipeResolution.ok) {
      return {
        error: recipeResolution.code,
        code: recipeResolution.code,
        message: recipeResolution.message,
      };
    }
    const recipe = recipeResolution.value;
    const binding = readAdaptationBinding(recipe.body);
    if (binding === null) {
      return { error: 'ARTIFACT_CORRUPT', code: 'ARTIFACT_CORRUPT', message: 'adaptation plan 未声明任何 binding' };
    }
    const ordered = recipe.selectedModuleIds;
    if (graphPins.profileKey !== recipe.profileRef) {
      return { error: 'SOURCE_MISMATCH', code: 'SOURCE_MISMATCH', message: 'committed profile key does not match the pinned recipe/protocol.' };
    }
    const profileSourceRefs = [
      ...(graphPins.profileRef === null ? [] : [graphPins.profileRef]),
      ...graphPins.implementationRefs,
    ];
    for (const ref of profileSourceRefs) {
      const actualHash = this.hashPinnedRef(ref);
      if (actualHash === null) return { error: 'SOURCE_MISSING', code: 'SOURCE_MISSING', message: `pinned profile implementation ${ref.ref.id} is missing.` };
      if (actualHash !== ref.ref.sha256) return { error: 'SOURCE_MISMATCH', code: 'SOURCE_MISMATCH', message: `pinned profile implementation ${ref.ref.id} changed after candidate binding.` };
    }
    const profilePins: ProfilePinResolution = { ok: true, profileRef: graphPins.profileRef, sourceRefs: profileSourceRefs };

    const labels = new Map<string, string>();
    for (const id of ordered) {
      const tag = design.moduleTags.find((t) => t.cardRef?.id === id || t.canonicalName === id);
      labels.set(id, tag === undefined ? id : (tag.nameZh ?? tag.canonicalName));
    }

    const flow = buildModelDataFlow({
      candidateKey,
      variantKey: recipe.selectedVariantKey,
      binding: { slotId: binding.slotId, orderedModuleIds: ordered },
      // A registered adapter is eligible only when its trusted profile config
      // and implementation source have both been content-pinned below.
      profileRef: profilePins.profileRef === null ? null : recipe.profileRef,
      recipeSource: recipe.ref,
      candidateSource: paperOnlyRef(design.binding.synthesisResultRef),
      sourceRefs: [
        ...(recipe.protocolRef === null ? [] : [recipe.protocolRef]),
        ...profilePins.sourceRefs,
      ],
      moduleLabels: labels,
      // The pilot is a foreground-ratio binary task; claiming a mask would
      // misstate what the model computes.
      outputKind: 'binary_foreground_ratio',
      includeTraining: true,
    });

    const taskAfter = this.researchService.readTask(taskId);
    const bindingRefAfter = this.researchService.currentTaskSnapshotRef(taskId);
    if (taskAfter === null || bindingRefAfter === null) {
      return { error: 'SNAPSHOT_BUSY', code: 'SNAPSHOT_BUSY', message: `task ${taskId} changed or disappeared while resolving its graph` };
    }
    const sourceTaskRevisionsAfter = await this.researchService.sourceTaskRevisionsFor(design.binding.sourceTaskRefs);
    const sameTaskSnapshot = bindingRefAfter.ref.id === taskSnapshotRefBefore.ref.id
      && bindingRefAfter.ref.sha256 === taskSnapshotRefBefore.ref.sha256
      && taskAfter.designRevision === task.designRevision;
    const revisionIdentity = (items: Array<{ store: string; taskId: string; revision: number }>) =>
      JSON.stringify([...items].sort((a, b) => `${a.store}:${a.taskId}`.localeCompare(`${b.store}:${b.taskId}`)));
    const sameSourceVector = revisionIdentity(sourceTaskRevisionsBefore) === revisionIdentity(sourceTaskRevisionsAfter);
    if (!sameTaskSnapshot || !sameSourceVector) {
      return { error: 'SNAPSHOT_BUSY', code: 'SNAPSHOT_BUSY', message: 'task/source version vector or trusted profile pin changed during graph resolution; retry the read' };
    }
    for (const ref of flow.subjectRefs) {
      const actualHash = this.hashPinnedRef(ref);
      if (actualHash === null || actualHash !== ref.ref.sha256) {
        return { error: 'SNAPSHOT_BUSY', code: 'SNAPSHOT_BUSY', message: `source ${ref.ref.id} changed or disappeared during graph resolution; retry the read` };
      }
    }
    const bindingRef = bindingRefAfter;
    const sourceTaskRevisions = sourceTaskRevisionsAfter;
    const snapshot: GraphSnapshot = {
      schemaVersion: 1,
      taskId,
      candidateKey,
      variantKey: recipe.selectedVariantKey,
      designRevision: task.designRevision,
      sourceTaskRevisions: [...sourceTaskRevisions].sort((a, b) => `${a.store}:${a.taskId}`.localeCompare(`${b.store}:${b.taskId}`)),
      bindingRef,
      recipeRef: recipe.ref,
      protocolRef: recipe.protocolRef,
      profileRef: profilePins.profileRef,
      sourceRefs: [...flow.subjectRefs].sort((a, b) => `${a.store}:${a.ref.id}:${a.ref.sha256}`.localeCompare(`${b.store}:${b.ref.id}:${b.ref.sha256}`)),
      semanticHashAlgorithm: SEMANTIC_HASH_ALGORITHM_V2,
      flow,
    };
    const graphRef = this.persistImmutableJson('graph-snapshots', snapshot);
    const taskConfirm = this.researchService.readTask(taskId);
    const bindingRefConfirm = this.researchService.currentTaskSnapshotRef(taskId);
    const confirmedBinding = taskConfirm?.candidateBindings.find((item) => item.candidateKey === candidateKey);
    const sourceTaskRevisionsConfirm = confirmedBinding === undefined
      ? []
      : await this.researchService.sourceTaskRevisionsFor(confirmedBinding.sourceTaskRefs);
    if (
      taskConfirm === null
      || confirmedBinding === undefined
      || bindingRefConfirm === null
      || bindingRefConfirm.ref.sha256 !== bindingRef.ref.sha256
      || taskConfirm.designRevision !== task.designRevision
      || revisionIdentity(sourceTaskRevisionsConfirm) !== revisionIdentity(sourceTaskRevisions)
      || flow.subjectRefs.some((ref) => this.hashPinnedRef(ref) !== ref.ref.sha256)
    ) {
      return { error: 'SNAPSHOT_BUSY', code: 'SNAPSHOT_BUSY', message: 'task/source changed while the immutable GraphSnapshot was being persisted; retry the read' };
    }
    return { flow, snapshot, graphRef };
  }

  /**
   * Pin the trusted profile config and the adapter implementation itself. A
   * profile ID without these content refs is descriptive only and cannot raise
   * a graph to code_bound.
   */
  private resolveProfilePins(profileRef: string | null): ProfilePinResolution {
    if (profileRef === null || profileRef !== 'phase2-cpu-seg-v1@1') {
      return { ok: true, profileRef: null, sourceRefs: [] };
    }
    const configFile = path.resolve(this.repoRoot, 'configs', 'phase2', 'profile-cpu-seg-v1.json');
    const adapterFile = path.resolve(this.repoRoot, 'packages', 'evolver', 'src', 'domain', 'model-dataflow.ts');
    let configBytes: Buffer;
    let adapterBytes: Buffer;
    try {
      configBytes = fs.readFileSync(configFile);
      adapterBytes = fs.readFileSync(adapterFile);
    } catch (err) {
      const code = (err as { code?: string }).code;
      return {
        ok: false,
        code: code === 'ENOENT' ? 'DEPENDENCY_NOT_READY' : 'SOURCE_IO_ERROR',
        message: `受信 profile 配置或 adapter source 不可读取（${String(code ?? 'unknown')}）。`,
      };
    }
    let profileDoc: Json;
    try {
      const parsed: unknown = JSON.parse(configBytes.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('profile is not an object');
      profileDoc = parsed as Json;
    } catch {
      return { ok: false, code: 'ARTIFACT_CORRUPT', message: `profile config ${path.relative(this.repoRoot, configFile)} 不是有效 JSON 对象。` };
    }
    if (str(profileDoc.id) !== 'phase2-cpu-seg-v1' || profileDoc.version !== 1) {
      return { ok: false, code: 'SOURCE_MISMATCH', message: '受信 profile config 的 id/version 与 registry key phase2-cpu-seg-v1@1 不匹配。' };
    }
    const configRef = this.persistImmutableBytes('graph-sources', configBytes, '.json');
    const adapterRef = this.persistImmutableBytes('graph-sources', adapterBytes, '.ts');
    return { ok: true, profileRef: configRef, sourceRefs: [configRef, adapterRef] };
  }

  /** Atomically write a content-addressed source or snapshot under published/. */
  private persistImmutableJson(kind: 'graph-snapshots', value: unknown): BoundRef {
    const bytes = Buffer.from(JSON.stringify(value), 'utf8');
    const maxBytes = 256 * 1024;
    if (bytes.byteLength > maxBytes) {
      throw new WorkbenchContractError('GRAPH_CONTEXT_TOO_LARGE', `GraphSnapshot is ${bytes.byteLength} bytes; the limit is ${maxBytes} and it will not be truncated`, { fieldPaths: ['graphSnapshot'] });
    }
    return this.persistImmutableBytes(kind, bytes, '.json');
  }

  private persistImmutableBytes(kind: 'graph-sources' | 'graph-snapshots', bytes: Buffer, extension: '.json' | '.ts'): BoundRef {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const publishedRoot = path.resolve(this.researchService.describeRoot(), 'published');
    const directory = path.join(publishedRoot, kind);
    const file = path.join(directory, `${sha256}${extension}`);
    fs.mkdirSync(directory, { recursive: true });
    const relative = path.relative(publishedRoot, file).split(path.sep).join('/');
    if (fs.existsSync(file)) {
      const current = fs.readFileSync(file);
      if (!current.equals(bytes) || createHash('sha256').update(current).digest('hex') !== sha256) {
        throw new WorkbenchContractError('ARTIFACT_CORRUPT', `content-addressed cache entry ${relative} does not match its digest`, { fieldPaths: ['graphSnapshot'] });
      }
      return { store: 'workbench', ref: { id: relative, sha256 } };
    }

    const temporary = `${file}.tmp-${randomUUID()}`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(temporary, 'wx');
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      try {
        // Hard-link is an atomic create-if-absent on the same volume. It avoids
        // overwriting an immutable entry if a concurrent resolver wins the race.
        fs.linkSync(temporary, file);
        let directoryFd: number | null = null;
        try {
          directoryFd = fs.openSync(directory, 'r');
          fs.fsyncSync(directoryFd);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code !== 'EINVAL' && code !== 'EPERM' && code !== 'EISDIR' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') throw err;
        } finally {
          if (directoryFd !== null) fs.closeSync(directoryFd);
        }
      } catch (err) {
        if ((err as { code?: string }).code !== 'EEXIST') throw err;
        const current = fs.readFileSync(file);
        if (!current.equals(bytes)) {
          throw new WorkbenchContractError('ARTIFACT_CORRUPT', `concurrent content-addressed entry ${relative} has different bytes`, { fieldPaths: ['graphSnapshot'] });
        }
      }
    } catch (err) {
      if (err instanceof WorkbenchContractError) throw err;
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `cannot persist immutable graph content ${relative}: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, fieldPaths: ['graphSnapshot'] });
    } finally {
      if (fd !== null) fs.closeSync(fd);
      try { fs.unlinkSync(temporary); } catch { /* already removed or never created */ }
    }
    return { store: 'workbench', ref: { id: relative, sha256 } };
  }

  /** Re-read a pinned source by its trusted store root and return its current hash. */
  private hashPinnedRef(ref: BoundRef): string | null {
    let root: string;
    if (ref.store === 'workbench') {
      root = path.resolve(this.researchService.describeRoot(), 'published');
    } else if (ref.store === 'phase2') {
      root = path.resolve(this.v2Root('research-execution'));
    } else if (ref.store === 'phase3') {
      root = path.resolve(this.v2Root('phase3-experiments'));
    } else if (ref.store === 'paper_only') {
      const id = ref.ref.id.replace(/\\/g, '/');
      root = /^(?:artifacts|work|fixtures)\//.test(id) ? this.repoRoot : this.paperRoot.root;
    } else {
      root = this.repoRoot;
    }
    if (path.isAbsolute(ref.ref.id) || /^[A-Za-z]:/.test(ref.ref.id)) return null;
    const target = path.resolve(root, ref.ref.id);
    const lexicalRelative = path.relative(root, target);
    if (lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) return null;
    try {
      const realRoot = fs.realpathSync(root);
      const realTarget = fs.realpathSync(target);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
      if (!fs.statSync(realTarget).isFile()) return null;
      return createHash('sha256').update(fs.readFileSync(realTarget)).digest('hex');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw new WorkbenchContractError('SOURCE_IO_ERROR', `无法复核 source pin ${ref.ref.id}（${String(code ?? 'unknown')}）。`, { retryable: true, fieldPaths: ['sourceRefs'] });
    }
  }

  private readPinnedJson(ref: BoundRef, expectedStore: 'phase2' | 'phase3'): PinnedJsonRead {
    if (ref.store !== expectedStore || path.isAbsolute(ref.ref.id) || /^[A-Za-z]:/.test(ref.ref.id)) {
      return { ok: false, code: 'SOURCE_MISMATCH', message: `pinned ${expectedStore} ref has an invalid store or absolute id.` };
    }
    const root = path.resolve(expectedStore === 'phase2' ? this.v2Root('research-execution') : this.v2Root('phase3-experiments'));
    const file = path.resolve(root, ref.ref.id);
    const relative = path.relative(root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { ok: false, code: 'SOURCE_MISMATCH', message: `pinned ${expectedStore} ref escapes its trusted store root.` };
    }
    let bytes: Buffer;
    let realFile: string;
    try {
      const realRoot = fs.realpathSync(root);
      realFile = fs.realpathSync(file);
      const realRelative = path.relative(realRoot, realFile);
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        return { ok: false, code: 'SOURCE_MISMATCH', message: `pinned ${expectedStore} ref resolves outside its trusted store root.` };
      }
      if (!fs.statSync(realFile).isFile()) return { ok: false, code: 'ARTIFACT_CORRUPT', message: `pinned ${expectedStore} ref is not a regular file.` };
      bytes = fs.readFileSync(realFile);
    } catch (err) {
      const code = (err as { code?: string }).code;
      return code === 'ENOENT' || code === 'ENOTDIR'
        ? { ok: false, code: 'SOURCE_MISSING', message: `pinned ${expectedStore} artifact ${ref.ref.id} is missing.` }
        : { ok: false, code: 'SOURCE_IO_ERROR', message: `cannot read pinned ${expectedStore} artifact ${ref.ref.id} (${String(code ?? 'unknown')}).` };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== ref.ref.sha256) return { ok: false, code: 'SOURCE_MISMATCH', message: `pinned ${expectedStore} artifact ${ref.ref.id} hash changed.` };
    try {
      const parsed: unknown = JSON.parse(bytes.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('not a JSON object');
      return { ok: true, body: parsed as Json, file: realFile, sha256 };
    } catch {
      return { ok: false, code: 'ARTIFACT_CORRUPT', message: `pinned ${expectedStore} artifact ${ref.ref.id} is not a JSON object.` };
    }
  }

  /**
   * Resolve recipe and protocol from the candidate's exact source-task links.
   * Any missing/ambiguous/corrupt source is explicit; directory order is never
   * used to choose a plan or protocol.
   */
  private resolveAdaptationPlan(
    sourceTaskRefs: SourceTaskRef[],
    requestedVariantKey: string | null,
    pinnedRefs: CandidateGraphPins | null = null,
    allowUnselectedVariant = false,
  ): AdaptationPlanResolution {
    if (sourceTaskRefs.length === 0) {
      return { ok: false, code: 'DEPENDENCY_NOT_READY', message: '候选绑定没有 sourceTaskRefs，无法按候选解析 recipe。' };
    }

    const researchRoot = path.resolve(this.v2Root('research-execution'));
    const plans: Array<{ body: Json; file: string; sha256: string }> = [];
    if (pinnedRefs !== null) {
      const pinnedPlan = this.readPinnedJson(pinnedRefs.recipeRef, 'phase2');
      if (!pinnedPlan.ok) return pinnedPlan;
      const recipeTaskId = path.relative(researchRoot, pinnedPlan.file).split(path.sep)[0];
      if (!sourceTaskRefs.some((source) => source.store === 'phase2' && source.taskId === recipeTaskId)) {
        return { ok: false, code: 'SOURCE_MISMATCH', message: 'pinned adaptation plan is not owned by one of this candidate binding\'s phase2 sourceTaskRefs.' };
      }
      plans.push({ body: pinnedPlan.body, file: pinnedPlan.file, sha256: pinnedPlan.sha256 });
    } else {
      for (const source of sourceTaskRefs) {
        if (source.store !== 'phase2') continue;
        const published = path.resolve(researchRoot, source.taskId, 'published');
        if (published !== researchRoot && !published.startsWith(researchRoot + path.sep)) {
          return { ok: false, code: 'SOURCE_MISMATCH', message: `source task ${source.taskId} escaped the trusted research-execution root.` };
        }
        let entries: string[];
        try {
          entries = fs.readdirSync(published);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'ENOENT') continue;
          return { ok: false, code: 'SOURCE_IO_ERROR', message: `无法读取 source task ${source.taskId} 的 published 目录（${String(code ?? 'unknown')}）。` };
        }
        for (const entry of entries) {
          if (!entry.startsWith('eop-planAdaptation-')) continue;
          const file = path.join(published, entry, 'adaptation-plan.json');
          let bytes: Buffer;
          try {
            bytes = fs.readFileSync(file);
          } catch (err) {
            const code = (err as { code?: string }).code;
            if (code === 'ENOENT') continue;
            return { ok: false, code: 'SOURCE_IO_ERROR', message: `无法读取 adaptation plan ${path.relative(this.repoRoot, file)}（${String(code ?? 'unknown')}）。` };
          }
          let body: Json;
          try {
            const parsed: unknown = JSON.parse(bytes.toString('utf8'));
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('plan is not an object');
            body = parsed as Json;
          } catch {
            return { ok: false, code: 'ARTIFACT_CORRUPT', message: `已发布 adaptation plan ${path.relative(this.repoRoot, file)} 不是有效 JSON 对象。` };
          }
          plans.push({ body, file, sha256: createHash('sha256').update(bytes).digest('hex') });
        }
      }
    }
    if (plans.length === 0) {
      return { ok: false, code: 'DEPENDENCY_NOT_READY', message: '候选绑定的 sourceTaskRefs 下没有已发布 adaptation plan。' };
    }
    if (plans.length > 1) {
      return { ok: false, code: 'SOURCE_AMBIGUOUS', message: `候选绑定的 sourceTaskRefs 匹配到 ${plans.length} 个 adaptation plan；需显式 pin，拒绝按文件顺序选择。` };
    }
    const selectedPlan = plans[0] as { body: Json; file: string; sha256: string };
    const binding = readAdaptationBinding(selectedPlan.body);
    if (binding === null) {
      return { ok: false, code: 'ARTIFACT_CORRUPT', message: '已发布 adaptation plan 没有可读取的 binding。' };
    }
    const recipeRef: BoundRef = {
      store: 'phase2',
      ref: {
        id: path.relative(researchRoot, selectedPlan.file).split(path.sep).join('/'),
        sha256: selectedPlan.sha256,
      },
    };

    const protocolRoot = path.resolve(this.v2Root('phase3-experiments'), 'published');
    const protocols: Array<{ protocol: Json; file: string; sha256: string }> = [];
    const wantedTaskIds = new Set(sourceTaskRefs.filter((source) => source.store === 'phase3').map((source) => source.taskId));
    if (pinnedRefs !== null) {
      if (pinnedRefs.protocolRef !== null) {
        const pinnedProtocol = this.readPinnedJson(pinnedRefs.protocolRef, 'phase3');
        if (!pinnedProtocol.ok) return pinnedProtocol;
        const rawProtocol = pinnedProtocol.body.protocol;
        if (typeof rawProtocol !== 'object' || rawProtocol === null || Array.isArray(rawProtocol)) {
          return { ok: false, code: 'ARTIFACT_CORRUPT', message: `pinned protocol ${pinnedProtocol.file} has no protocol object` };
        }
        const protocolBody = rawProtocol as Json;
        const protocolTaskId = str(protocolBody.taskRef);
        if (protocolTaskId === null || !wantedTaskIds.has(protocolTaskId)) {
          return { ok: false, code: 'SOURCE_MISMATCH', message: 'pinned protocol is not linked to this candidate binding sourceTaskRefs.' };
        }
        protocols.push({ protocol: protocolBody, file: pinnedProtocol.file, sha256: pinnedProtocol.sha256 });
      }
    } else {
      let protocolEntries: string[];
      try {
        protocolEntries = fs.readdirSync(protocolRoot);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'ENOENT') {
          return { ok: false, code: 'SOURCE_IO_ERROR', message: `无法读取 frozen protocol store（${String(code ?? 'unknown')}）。` };
        }
        protocolEntries = [];
      }
      for (const entry of protocolEntries) {
        if (!entry.startsWith('peop-freezeExperiment-')) continue;
        const file = path.join(protocolRoot, entry, 'experiment-protocol.json');
        let bytes: Buffer;
        try {
          bytes = fs.readFileSync(file);
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'ENOENT') continue;
          return { ok: false, code: 'SOURCE_IO_ERROR', message: `无法读取 frozen protocol ${path.relative(this.repoRoot, file)}（${String(code ?? 'unknown')}）。` };
        }
        let doc: Json;
        try {
          const parsed: unknown = JSON.parse(bytes.toString('utf8'));
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TypeError('protocol doc is not an object');
          doc = parsed as Json;
        } catch {
          return { ok: false, code: 'ARTIFACT_CORRUPT', message: `frozen protocol ${path.relative(this.repoRoot, file)} 不是有效 JSON 对象。` };
        }
        const protocol = doc.protocol;
        if (typeof protocol !== 'object' || protocol === null || Array.isArray(protocol)) continue;
        const protocolBody = protocol as Json;
        const protocolTaskId = str(protocolBody.taskRef);
        // A taskRef-less/global protocol is not candidate-specific evidence.
        if (protocolTaskId === null || !wantedTaskIds.has(protocolTaskId)) continue;
        protocols.push({ protocol: protocolBody, file, sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      if (protocols.length > 1) {
        return { ok: false, code: 'SOURCE_AMBIGUOUS', message: `候选绑定的 phase3 sourceTaskRefs 匹配到 ${protocols.length} 个 frozen protocol；拒绝选择首个。` };
      }
    }

    const protocol = protocols[0];
    const protocolProfileRef = protocol === undefined ? null : str(protocol.protocol.profileRef);
    const recipeProfileRef = str(selectedPlan.body.profileRef);
    if (protocol !== undefined && protocolProfileRef !== recipeProfileRef) {
      return { ok: false, code: 'SOURCE_MISMATCH', message: `recipe profileRef ${recipeProfileRef ?? '(missing)'} 与 frozen protocol profileRef ${protocolProfileRef ?? '(missing)'} 不一致。` };
    }
    // A plan string alone is not a frozen profile pin. Without its linked
    // protocol, preserve only a conceptual graph and do not select a code adapter.
    const profileRef = protocol === undefined ? null : protocolProfileRef;
    const variants = protocol === undefined ? [] : readProtocolVariants(protocol.protocol);
    let selectedVariantKey: string | null = null;
    let selectedModuleIds = binding.orderedModuleIds;
    if (requestedVariantKey !== null) {
      const selected = variants.find((v) => v.id === requestedVariantKey);
      if (selected === undefined) {
        return { ok: false, code: 'VARIANT_NOT_FOUND', message: `variantKey ${requestedVariantKey} 不属于候选绑定的 frozen protocol。` };
      }
      selectedVariantKey = selected.id;
      selectedModuleIds = selected.moduleRefs;
    } else if (variants.length > 1 && !allowUnselectedVariant) {
      return { ok: false, code: 'VARIANT_REQUIRED', message: `frozen protocol 有 ${variants.length} 个 variant，必须显式指定 variantKey。` };
    } else if (variants.length === 1) {
      const selected = variants[0] as { id: string; role: string; moduleRefs: string[] };
      selectedVariantKey = selected.id;
      selectedModuleIds = selected.moduleRefs;
    }

    const protocolRef: BoundRef | null = protocol === undefined ? null : {
      store: 'phase3',
      ref: {
        id: path.relative(path.resolve(this.v2Root('phase3-experiments')), protocol.file).split(path.sep).join('/'),
        sha256: protocol.sha256,
      },
    };
    return {
      ok: true,
      value: {
        body: selectedPlan.body,
        ref: recipeRef,
        protocolRef,
        profileRef,
        variants,
        selectedVariantKey,
        selectedModuleIds,
      },
    };
  }

  // ------------------------- change token (SPEC section 7.1) -------------------------

  /**
   * The lightweight change check.
   *
   * `changedRegions` is a dependency-driven hint, not a guess: the client only
   * re-reads the regions whose inputs actually moved. An unchanged token returns
   * an EMPTY region list and the same token, so a 3-second poll that finds
   * nothing costs one small JSON read and no re-render.
   *
   * Two rules from SPEC section 7.1 are enforced here rather than left to the
   * client:
   *
   *  - **An epoch change forces a FULL refresh.** After a host restart every
   *    sequence number the page holds is meaningless, so reporting only the
   *    regions that "differed" would leave the page rendering pre-restart facts.
   *  - **Cross-store instability yields SNAPSHOT_BUSY.** The version vector is
   *    read before and after the task read; if it moved, the read is retried
   *    ONCE, and a second movement is reported rather than served.
   */
  async changes(taskId: string, sinceViewVersion: string | null, sinceViewEpoch: string | null = null): Promise<ChangeToken | { error: string; message: string }> {
    const qualified = this.resolveQualified(taskId);
    if (!qualified.ok) {
      if (qualified.ambiguous.length === 0) return { error: 'NOT_FOUND', message: `no store holds a task named ${taskId}` };
      return { error: 'AMBIGUOUS_TASK', message: `taskId ${taskId} exists in ${qualified.ambiguous.length} stores` };
    }
    if (qualified.value.store === 'workbench') {
      const task = this.researchService.readTask(taskId);
      if (task === null) return { error: 'NOT_FOUND', message: `no product task ${taskId}` };

      // Read the version vector, then the thing the vector describes.
      const before = await this.researchService.computeViewVersion(task);
      const reRead = this.researchService.readTask(taskId);
      if (reRead === null) return { error: 'NOT_FOUND', message: `no product task ${taskId}` };
      const after = await this.researchService.computeViewVersion(reRead);
      if (before !== after) {
        // SPEC: at most one re-read. A second movement is a busy store, not a
        // result to serve.
        const settled = await this.researchService.computeViewVersion(this.researchService.readTask(taskId) ?? task);
        if (settled !== after) {
          return {
            error: 'SNAPSHOT_BUSY',
            message: `任务 ${taskId} 在读取期间仍在变化（版本向量 ${before.slice(0, 8)} → ${after.slice(0, 8)} → ${settled.slice(0, 8)}）；请保留当前页面并重试`,
          };
        }
      }

      const viewVersion = after;
      const epochChanged = sinceViewEpoch !== null && sinceViewEpoch !== this.viewEpoch;
      const changed = epochChanged || (sinceViewVersion !== null && sinceViewVersion !== viewVersion);

      // After a restart EVERYTHING must be re-read; a partial region list would
      // let the page keep rendering pre-restart data.
      const regions: ChangedRegion[] = !changed
        ? []
        : epochChanged
          ? ['snapshot', 'modules', 'papers', 'dataflow', 'design', 'bindings']
          : await this.regionsFor(reRead);

      return {
        taskId,
        viewEpoch: this.viewEpoch,
        viewSequence: this.sequence,
        viewVersion,
        changedRegions: regions,
        generatedAt: new Date().toISOString(),
      };
    }
    const legacy = this.v2.getWorkbench(taskId);
    if ('error' in legacy) return { error: 'NOT_FOUND', message: legacy.error };
    const revision = typeof legacy.revision === 'number' ? legacy.revision : 0;
    const viewVersion = createHash('sha256').update(`${taskId}|${revision}|${this.viewEpoch}`).digest('hex');
    const epochChanged = sinceViewEpoch !== null && sinceViewEpoch !== this.viewEpoch;
    return {
      taskId,
      viewEpoch: this.viewEpoch,
      viewSequence: this.sequence,
      viewVersion,
      changedRegions: !changedNow(epochChanged, sinceViewVersion, viewVersion) ? [] : ['snapshot'],
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Which regions a NON-epoch change actually moved.
   *
   * The split is by dependency, not by guess: the DESIGN moves when this task's
   * design revision or its bound artifacts change; the DATA FLOW additionally
   * moves when a bound EXPERIMENT's own revision changed, because that is the
   * experiment's graph rather than this task's design.
   */
  private async regionsFor(task: WorkbenchTaskRecord): Promise<ChangedRegion[]> {
    const regions: ChangedRegion[] = ['design', 'bindings'];
    const revisions = await this.researchService.sourceTaskRevisions(task);
    const experimental = revisions.some((r) => r.revision !== this.lastSeenSourceRevisions.get(`${r.store}:${r.taskId}`));
    if (experimental) regions.push('dataflow', 'snapshot');
    // Remember what was reported, so the NEXT poll can tell whether it moved.
    for (const r of revisions) this.lastSeenSourceRevisions.set(`${r.store}:${r.taskId}`, r.revision);
    return regions;
  }

  // ------------------------- artifacts -------------------------

  /** The v2 artifact read, re-exported so the host needs one store reference. */
  readArtifact(request: { taskId: string; ref: { id: string; sha256: string | null } }, view: 'summary' | 'detail') {
    return this.v2.readArtifact(request, view);
  }

  /** Legacy graph access for the v2 route, kept byte-identical. */
  get v2Store(): WorkbenchStore {
    return this.v2;
  }

  get boundedReader(): typeof readBoundedArtifact {
    return readBoundedArtifact;
  }
}

function hashHex(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

/** True when a v2 task's token differs, either by epoch or by content. */
function changedNow(epochChanged: boolean, since: string | null, viewVersion: string): boolean {
  return epochChanged || (since !== null && since !== viewVersion);
}
