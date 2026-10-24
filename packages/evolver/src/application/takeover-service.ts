/**
 * Batch 1 takeover service: CAS/identity/version/atomic-write persistence over research-takeover.
 *
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-01-WORKER-PLAN-2026-10-16.md §2.3, §5 B1-05..B1-07.
 * Contract: ../contracts/research-takeover.ts (frozen). Store: ./research-bootstrap-store.ts
 *
 * What this owns:
 * - Idempotent registration: the same roots set never produces a second record (B1-05).
 * - Scan history: refresh appends a scan and keeps the old one; nothing is overwritten.
 * - Snapshot writes: every citation must resolve against the CURRENT scan, so a snapshot can never
 *   cite something the scanner did not actually read (B1-04).
 * - Freshness: recomputed on read from the real filesystem; never stored as a claim (B1-06).
 * - 目标待定: researchId stays null until a real research exists. No research question is invented
 *   just to make a non-null field.
 *
 * Ordering: the read-only scan is awaited BEFORE `store.mutate`, because mutate's apply callback is
 * synchronous and must stay short inside the lock. A scan failure is still registered — with
 * firstError set — so the failure stays visible instead of the whole action disappearing.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TAKEOVER_BOUNDS,
  TAKEOVER_ENTRY_KINDS,
  TakeoverError,
  assertCitationsResolve,
  emptyTakeoverFreshness,
  isSafeRelativePath,
  takeoverRootsKey,
  type TakeoverFreshness,
  type TakeoverProjection,
  type TakeoverRecord,
  type TakeoverScan,
  type TakeoverSnapshot,
} from '../contracts/research-takeover.ts';
import { sha256Hex } from '../domain/research-canonical.ts';
import { ResearchBootstrapStore, type MutationResult } from './research-bootstrap-store.ts';
import { scanTakeoverDirectory, type TakeoverScanOptions } from './takeover-scanner.ts';

export interface TakeoverServiceOptions {
  /** Trusted original workspace when persistence lives in a compatibility directory. */
  sourceWorkspaceRoot?: string;
  /** Injected in tests; defaults to the real read-only scanner. */
  scan?: (options: TakeoverScanOptions) => Promise<TakeoverScan>;
  now?: () => Date;
  mint?: (prefix: string) => string;
  /** Absent ⇒ PDF entries are registered metadata-only, never silently "read". */
  readPdfText?: (bytes: Uint8Array, name: string) => Promise<string[]>;
  gitProbe?: (workspaceRoot: string) => TakeoverScan['git'] | Promise<TakeoverScan['git']>;
}

export interface TakeoverStartInput {
  operationId: string;
  baseRevision: number;
  roots: string[];
  scopeNote?: string;
  title?: string;
  /** null/absent = 目标待定草稿. */
  researchId?: string | null;
}

export type TakeoverSnapshotDraft = Omit<TakeoverSnapshot, 'snapshotId' | 'revision' | 'scanId' | 'researchId' | 'createdAt' | 'updatedAt'>;

export interface TakeoverSnapshotInput {
  operationId: string;
  baseRevision: number;
  takeoverId: string;
  snapshot: TakeoverSnapshotDraft;
  modelIdentity?: { agentIdentity: string; modelIdentity: string } | null;
}

export interface TakeoverStartResult {
  takeoverId: string;
  scanId: string;
  reused: boolean;
  counts: TakeoverScan['counts'];
  truncated: boolean;
  firstError: TakeoverRecord['firstError'];
}

export interface TakeoverRefreshResult {
  takeoverId: string;
  scanId: string;
  counts: TakeoverScan['counts'];
  truncated: boolean;
}

export interface TakeoverSnapshotResult {
  takeoverId: string;
  snapshotId: string;
  revision: number;
}

export type { TakeoverProjection } from '../contracts/research-takeover.ts';

interface ScanSettled {
  scan: TakeoverScan;
  error: TakeoverRecord['firstError'];
}

const DEFAULT_TITLE = '已有研究目录接管';

function emptyCounts(): TakeoverScan['counts'] {
  const byKind = {} as TakeoverScan['counts']['byKind'];
  for (const kind of TAKEOVER_ENTRY_KINDS) byKind[kind] = 0;
  return { total: 0, byKind, read: 0, metadataOnly: 0, skipped: 0, failed: 0, notRead: 0, totalBytes: 0, hashed: 0 };
}

/** React to a scanned set: watched entries are the read (or hashed) ones, bounded. */
function watchedFromScan(scan: TakeoverScan): TakeoverSnapshot['watchedEntries'] {
  const candidates = scan.entries.filter((entry) => entry.readStatus === 'read' || entry.hashStatus === 'computed');
  return candidates.slice(0, TAKEOVER_BOUNDS.maxWatchedEntries).map((entry) => ({
    entryId: entry.entryId,
    relativePath: entry.relativePath,
    bytes: entry.bytes,
    modifiedAt: entry.modifiedAt,
    sha256: entry.sha256,
  }));
}

/**
 * A record is always storable: before an Agent has written anything, the snapshot is an explicit
 * placeholder, not a fabricated summary. currentFocus stays 「待确定」 and the real gap is recorded
 * as an unknown so no surface can render it as "complete".
 */
function placeholderSnapshot(input: {
  scan: TakeoverScan;
  researchId: string | null;
  title: string;
  now: string;
  mint: (prefix: string) => string;
}): TakeoverSnapshot {
  return {
    snapshotId: input.mint('takeover-snapshot'),
    revision: 1,
    researchId: input.researchId,
    scanId: input.scan.scanId,
    title: input.title,
    currentFocus: '待确定',
    materials: [],
    groups: [],
    known: [],
    unknown: [
      {
        unknownId: input.mint('takeover-unknown'),
        topic: '尚未生成 Research Snapshot',
        detail: `已登记 ${input.scan.counts.total} 个条目（已读 ${input.scan.counts.read}），但 Agent 尚未依据已读内容撰写研究现状快照。`,
        entryIds: [],
      },
    ],
    relations: [],
    nextSteps: ['由 Agent 依据已读条目撰写 Research Snapshot'],
    citations: [],
    watchedEntries: watchedFromScan(input.scan),
    model: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export class TakeoverService {
  readonly store: ResearchBootstrapStore;
  readonly sourceWorkspaceRoot: string;
  private readonly scanImpl: (options: TakeoverScanOptions) => Promise<TakeoverScan>;
  private readonly clock: () => Date;
  private readonly mintImpl: (prefix: string) => string;
  private readonly readPdfText?: (bytes: Uint8Array, name: string) => Promise<string[]>;
  private readonly gitProbe?: (workspaceRoot: string) => TakeoverScan['git'] | Promise<TakeoverScan['git']>;

  constructor(store: ResearchBootstrapStore, options: TakeoverServiceOptions = {}) {
    this.store = store;
    this.sourceWorkspaceRoot = path.resolve(options.sourceWorkspaceRoot ?? store.workspaceRoot);
    this.scanImpl = options.scan ?? ((request) => scanTakeoverDirectory(request));
    this.clock = options.now ?? (() => new Date());
    this.mintImpl = options.mint ?? ((prefix: string) => `${prefix}-${randomUUID()}`);
    this.readPdfText = options.readPdfText;
    this.gitProbe = options.gitProbe;
  }

  // ------------------------------------------------------------------ writes

  /**
   * Idempotent by roots set: a repeat request for the same roots returns `reused: true` and adds no
   * record and no scan (B1-05).
   */
  async start(input: TakeoverStartInput, actorIdentity: string): Promise<MutationResult<TakeoverStartResult>> {
    const roots = this.normalizeRoots(input.roots);
    const key = takeoverRootsKey(roots);
    const settled = await this.settle({ roots, scopeNote: input.scopeNote ?? '' });
    return this.store.mutate<TakeoverStartResult>({
      operationId: input.operationId,
      kind: 'takeover_start',
      researchId: input.researchId ?? null,
      baseRevision: input.baseRevision,
      // Semantic payload only: no baseRevision, no owner/actor, no host paths.
      requestPayload: { roots, scopeNote: input.scopeNote ?? '', researchId: input.researchId ?? null },
      apply: (context) => {
        const takeovers = context.state.takeovers ?? [];
        const existing = takeovers.find((record) => takeoverRootsKey(record.roots) === key);
        if (existing !== undefined) {
          const scan = this.currentScan(existing);
          return { changed: false, result: { takeoverId: existing.takeoverId, scanId: existing.currentScanId, reused: true, counts: scan.counts, truncated: scan.truncated, firstError: existing.firstError } };
        }
        if (takeovers.length >= TAKEOVER_BOUNDS.maxTakeovers) {
          throw new TakeoverError('LIMIT_TAKEOVERS', `workspace has reached its takeover limit (${TAKEOVER_BOUNDS.maxTakeovers}); refresh an existing takeover instead`);
        }
        const now = context.now();
        const title = (input.title ?? DEFAULT_TITLE).trim() || DEFAULT_TITLE;
        const record: TakeoverRecord = {
          takeoverId: context.mint('takeover'),
          revision: 1,
          researchId: input.researchId ?? null,
          title,
          roots,
          scopeNote: input.scopeNote ?? '',
          status: input.researchId ? 'saved' : 'draft',
          currentScanId: settled.scan.scanId,
          scans: [settled.scan],
          adoptions: [],
          snapshot: placeholderSnapshot({ scan: settled.scan, researchId: input.researchId ?? null, title, now, mint: context.mint }),
          actorIdentity,
          firstError: settled.error,
          createdAt: now,
          updatedAt: now,
        };
        context.state.takeovers = [...takeovers, record];
        return { changed: true, result: { takeoverId: record.takeoverId, scanId: settled.scan.scanId, reused: false, counts: settled.scan.counts, truncated: settled.scan.truncated, firstError: settled.error } };
      },
    });
  }

  /** Re-scans the same roots, appending a scan and keeping history. */
  async refresh(input: { operationId: string; baseRevision: number; takeoverId: string }, actorIdentity: string): Promise<MutationResult<TakeoverRefreshResult>> {
    const record = this.require(input.takeoverId);
    const settled = await this.settle({ roots: record.roots, scopeNote: record.scopeNote });
    return this.store.mutate<TakeoverRefreshResult>({
      operationId: input.operationId,
      kind: 'takeover_refresh',
      researchId: record.researchId,
      baseRevision: input.baseRevision,
      requestPayload: { takeoverId: input.takeoverId, roots: record.roots, scopeNote: record.scopeNote },
      apply: (context) => {
        const takeovers = context.state.takeovers ?? [];
        const target = takeovers.find((entry) => entry.takeoverId === input.takeoverId);
        if (target === undefined) throw new TakeoverError('NOT_FOUND', `no takeover "${input.takeoverId}" exists in this workspace's bootstrap state`);
        if (target.scans.length >= TAKEOVER_BOUNDS.maxScansPerTakeover) {
          throw new TakeoverError('LIMIT_SCANS', `takeover "${input.takeoverId}" already holds ${target.scans.length} scans (limit ${TAKEOVER_BOUNDS.maxScansPerTakeover})`);
        }
        target.scans = [...target.scans, settled.scan];
        target.currentScanId = settled.scan.scanId;
        target.snapshot = { ...target.snapshot, scanId: settled.scan.scanId, watchedEntries: watchedFromScan(settled.scan), updatedAt: context.now() };
        target.firstError = settled.error;
        target.updatedAt = context.now();
        if (typeof actorIdentity === 'string' && actorIdentity.length > 0) target.actorIdentity = actorIdentity;
        return { changed: true, result: { takeoverId: target.takeoverId, scanId: settled.scan.scanId, counts: settled.scan.counts, truncated: settled.scan.truncated } };
      },
    });
  }

  /**
   * Agent-authored snapshot. Citations are validated against the CURRENT scan before the write, so a
   * quote that is not verbatim in a read entry's excerpt cannot be saved (B1-04). A failed save
   * leaves the revision untouched.
   */
  saveSnapshot(input: TakeoverSnapshotInput, actorIdentity: string): MutationResult<TakeoverSnapshotResult> {
    return this.store.mutate<TakeoverSnapshotResult>({
      operationId: input.operationId,
      kind: 'takeover_snapshot',
      researchId: this.require(input.takeoverId).researchId,
      baseRevision: input.baseRevision,
      requestPayload: { takeoverId: input.takeoverId, snapshot: input.snapshot as unknown as Record<string, unknown> },
      apply: (context) => {
        const takeovers = context.state.takeovers ?? [];
        const target = takeovers.find((entry) => entry.takeoverId === input.takeoverId);
        if (target === undefined) throw new TakeoverError('NOT_FOUND', `no takeover "${input.takeoverId}" exists in this workspace's bootstrap state`);
        const current = this.currentScan(target);
        const now = context.now();
        const previous = target.snapshot;
        const snapshot: TakeoverSnapshot = {
          ...input.snapshot,
          snapshotId: previous.snapshotId,
          revision: previous.revision + 1,
          researchId: target.researchId,
          scanId: current.scanId,
          watchedEntries: watchedFromScan(current),
          model: input.modelIdentity !== undefined ? input.modelIdentity : (input.snapshot.model ?? previous.model),
          createdAt: previous.createdAt,
          updatedAt: now,
        };
        // Fail loudly before any write: an unresolvable citation is a real error, not a warning.
        assertCitationsResolve(snapshot.citations, current, `takeover "${input.takeoverId}" snapshot`);
        target.snapshot = snapshot;
        target.revision = snapshot.revision;
        target.updatedAt = now;
        if (typeof actorIdentity === 'string' && actorIdentity.length > 0) target.actorIdentity = actorIdentity;
        return { changed: true, result: { takeoverId: target.takeoverId, snapshotId: snapshot.snapshotId, revision: snapshot.revision } };
      },
    });
  }

  /** 目标待定 → 绑定真实研究，draft 转 saved. */
  bindResearch(input: { operationId: string; baseRevision: number; takeoverId: string; researchId: string }, actorIdentity: string): MutationResult<{ takeoverId: string; researchId: string }> {
    return this.store.mutate<{ takeoverId: string; researchId: string }>({
      operationId: input.operationId,
      kind: 'takeover_bind_research',
      researchId: input.researchId,
      baseRevision: input.baseRevision,
      requestPayload: { takeoverId: input.takeoverId, researchId: input.researchId },
      apply: (context) => {
        const takeovers = context.state.takeovers ?? [];
        const target = takeovers.find((entry) => entry.takeoverId === input.takeoverId);
        if (target === undefined) throw new TakeoverError('NOT_FOUND', `no takeover "${input.takeoverId}" exists in this workspace's bootstrap state`);
        const research = context.state.researches.find((entry) => entry.researchId === input.researchId);
        if (research === undefined) throw new TakeoverError('NOT_FOUND', `no research "${input.researchId}" exists in this workspace's bootstrap state`);
        target.researchId = input.researchId;
        target.status = 'saved';
        target.snapshot = { ...target.snapshot, researchId: input.researchId, updatedAt: context.now() };
        target.updatedAt = context.now();
        if (typeof actorIdentity === 'string' && actorIdentity.length > 0) target.actorIdentity = actorIdentity;
        return { changed: true, result: { takeoverId: target.takeoverId, researchId: input.researchId } };
      },
    });
  }

  // ------------------------------------------------------------------ reads

  read(takeoverId: string): TakeoverRecord | null {
    if (typeof takeoverId !== 'string' || takeoverId.trim().length === 0) {
      throw new TakeoverError('INVALID_INPUT', 'takeoverId is required');
    }
    return this.records().find((record) => record.takeoverId === takeoverId) ?? null;
  }

  list(): TakeoverRecord[] {
    return this.records();
  }

  /** Recomputed against the real filesystem on every call; nothing is cached as a claim (B1-06). */
  checkFreshness(takeoverId: string): TakeoverFreshness {
    const record = this.read(takeoverId);
    if (record === null) return emptyTakeoverFreshness();
    const freshness = emptyTakeoverFreshness();
    watchedLoop: for (const watched of record.snapshot.watchedEntries) {
      const absolute = path.resolve(this.sourceWorkspaceRoot, watched.relativePath);
      let stats: fs.Stats;
      try {
        let candidate = this.sourceWorkspaceRoot;
        for (const part of path.relative(this.sourceWorkspaceRoot, absolute).split(path.sep)) {
          candidate = path.join(candidate, part);
          if (fs.lstatSync(candidate).isSymbolicLink()) {
            freshness.checked += 1;
            freshness.changed.push({ entryId: watched.entryId, relativePath: watched.relativePath, reason: 'missing' });
            continue watchedLoop;
          }
        }
        stats = fs.statSync(absolute);
        if (!stats.isFile()) { freshness.checked += 1; freshness.changed.push({ entryId: watched.entryId, relativePath: watched.relativePath, reason: 'missing' }); continue; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          freshness.checked += 1;
          freshness.changed.push({ entryId: watched.entryId, relativePath: watched.relativePath, reason: 'missing' });
        } else {
          freshness.notChecked += 1;
        }
        continue;
      }
      freshness.checked += 1;
      if (stats.size !== watched.bytes) { freshness.changed.push({ entryId: watched.entryId, relativePath: watched.relativePath, reason: 'size' }); continue; }
      const modifiedAt = new Date(stats.mtimeMs).toISOString();
      if (watched.modifiedAt !== null && modifiedAt !== watched.modifiedAt) { freshness.changed.push({ entryId: watched.entryId, relativePath: watched.relativePath, reason: 'modified' }); continue; }
      if (watched.sha256 !== null) {
        try {
          const digest = sha256Hex(fs.readFileSync(absolute));
          if (digest !== watched.sha256) freshness.changed.push({ entryId: watched.entryId, relativePath: watched.relativePath, reason: 'hash' });
        } catch {
          freshness.notChecked += 1;
        }
      }
    }
    freshness.stale = freshness.changed.length > 0;
    return freshness;
  }

  projection(takeoverId: string): TakeoverProjection {
    const record = this.read(takeoverId);
    if (record === null) return { record: null, freshness: emptyTakeoverFreshness(), counts: null, scopeNote: '', roots: [], truncated: false };
    const scan = this.currentScan(record);
    return { record, freshness: this.checkFreshness(takeoverId), counts: scan.counts, scopeNote: record.scopeNote, roots: record.roots, truncated: scan.truncated };
  }

  // ------------------------------------------------------------------ internals

  private records(): TakeoverRecord[] {
    return this.store.readState()?.takeovers ?? [];
  }

  private require(takeoverId: string): TakeoverRecord {
    if (typeof takeoverId !== 'string' || takeoverId.trim().length === 0) {
      throw new TakeoverError('INVALID_INPUT', 'takeoverId is required');
    }
    const record = this.read(takeoverId);
    if (record === null) throw new TakeoverError('NOT_FOUND', `no takeover "${takeoverId}" exists in this workspace's bootstrap state`);
    return record;
  }

  private currentScan(record: TakeoverRecord): TakeoverScan {
    const scan = record.scans.find((entry) => entry.scanId === record.currentScanId);
    if (scan === undefined) throw new TakeoverError('STATE_CORRUPT', `takeover "${record.takeoverId}" has no scan matching currentScanId`);
    return scan;
  }

  private normalizeRoots(roots: string[]): string[] {
    if (!Array.isArray(roots) || roots.length === 0) {
      throw new TakeoverError('INVALID_INPUT', 'at least one root is required');
    }
    const normalized = roots.map((root) => String(root).replace(/\\/g, '/').replace(/\/+$/, '') || '.');
    for (const root of normalized) {
      // '.' means "the whole workspace" and is explicitly allowed by the frozen contract;
      // everything else must be a traversal-free relative path.
      if (root !== '.' && !isSafeRelativePath(root)) {
        throw new TakeoverError('INVALID_INPUT', `root "${root}" is not a safe workspace-relative path`);
      }
    }
    return [...new Set(normalized)].sort();
  }

  /**
   * Awaits the read-only scan and never lets a rejection disappear: a failed scan still produces a
   * registrable (empty, error-bearing) scan so the failure is recorded as a fact.
   */
  private async settle(scoped: { roots: string[]; scopeNote: string }): Promise<ScanSettled> {
    try {
      const scan = await this.scanImpl({
        workspaceRoot: this.sourceWorkspaceRoot,
        roots: scoped.roots,
        scopeNote: scoped.scopeNote,
        now: this.clock,
        mint: this.mintImpl,
        ...(this.readPdfText === undefined ? {} : { readPdfText: this.readPdfText }),
        ...(this.gitProbe === undefined ? {} : { gitProbe: this.gitProbe }),
      });
      return { scan, error: null };
    } catch (error) {
      const code = error instanceof TakeoverError ? error.code : 'SCAN_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      return { scan: this.emptyScan(scoped, code), error: { code, message } };
    }
  }

  private emptyScan(scoped: { roots: string[]; scopeNote: string }, reasonCode: string): TakeoverScan {
    const now = this.clock().toISOString();
    return {
      scanId: this.mintImpl('takeover-scan'),
      roots: scoped.roots,
      scopeNote: scoped.scopeNote,
      startedAt: now,
      finishedAt: now,
      limits: {
        maxVisited: TAKEOVER_BOUNDS.maxScanVisited,
        maxDepth: TAKEOVER_BOUNDS.maxScanDepth,
        maxEntries: TAKEOVER_BOUNDS.maxEntriesPerScan,
        maxReadBytesPerFile: TAKEOVER_BOUNDS.maxReadBytesPerFile,
        maxReadBytes: TAKEOVER_BOUNDS.maxReadBytesPerScan,
      },
      exclusions: [],
      visitedCount: 0,
      truncated: false,
      entries: [],
      counts: emptyCounts(),
      git: null,
      gitNote: `扫描未执行（${reasonCode}）`,
      errors: [],
    };
  }
}
