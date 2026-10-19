/**
 * Batch 1 「已有研究目录只读接管」 integration acceptance (B1-01..B1-07).
 *
 * Plan: docs/mvp/MVP-TAKEOVER-BATCH-01-WORKER-PLAN-2026-10-16.md §2.1–§2.3, §5.
 * Contract: packages/evolver/src/contracts/research-takeover.ts (frozen).
 *
 * Everything here runs against a REAL temp directory and the REAL read-only scanner/service/store:
 * no scan impl is injected except where a throwing scanner is the thing under test. The fixture is
 * an explicitly marked engineering fixture (B1-01's "独立清单" is the on-disk walk, not a literal).
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ResearchBootstrapStore } from '../../packages/evolver/src/application/research-bootstrap-store.ts';
import { TakeoverService, type TakeoverSnapshotDraft } from '../../packages/evolver/src/application/takeover-service.ts';
import {
  TAKEOVER_DEFAULT_EXCLUSIONS,
  classifyTakeoverEntry,
  scanTakeoverDirectory,
} from '../../packages/evolver/src/application/takeover-scanner.ts';
import {
  TAKEOVER_ENTRY_KINDS,
  TakeoverError,
  assertCitationsResolve,
  validateTakeoverRecord,
  validateTakeoverScan,
  type TakeoverEntryKind,
  type TakeoverReadStatus,
  type TakeoverScan,
} from '../../packages/evolver/src/contracts/research-takeover.ts';
import { needsResearchTakeoverSkill } from '../../packages/evolver/src/adapters/dsh/research-workspace-events.ts';

// ------------------------------------------------------------------ fixture

/** The scanned subtree lives at `<workspace>/project`, so `<workspace>/.dsh` stays outside it. */
const PROJECT_ROOT = 'project';

interface FixtureFile {
  /** posix, workspace-relative. */
  relativePath: string;
  content: string;
  kind: TakeoverEntryKind;
  readStatus: TakeoverReadStatus;
}

const README_TEXT = '# 已有研究项目\n\n基线为 ResNet-18，门控模块插在编码器末端。\n指标见 metrics/results.csv。\n';

/** Present on disk but must never reach the inventory (dependency/cache/credential exclusions). */
const EXCLUDED_RELPATHS: readonly string[] = [
  'project/.env',
  'project/node_modules/dep/index.js',
  'project/.git/HEAD',
];

const FIXTURE_FILES: readonly FixtureFile[] = [
  { relativePath: 'project/README.md', content: README_TEXT, kind: 'note', readStatus: 'read' },
  { relativePath: 'project/notes/idea.md', content: '# 想法\n\n把 attention gate 插入编码器。\n', kind: 'note', readStatus: 'read' },
  { relativePath: 'project/notes/wiki/overview.md', content: '# Wiki 概览\n\n门控提升小样本泛化。\n', kind: 'wiki', readStatus: 'read' },
  // Byte-identical to README.md: the scanner must register it AND name the first entry as duplicateOf.
  { relativePath: 'project/notes/copy.md', content: README_TEXT, kind: 'note', readStatus: 'read' },
  { relativePath: 'project/config/train.yaml', content: 'lr: 0.001\nepochs: 50\n', kind: 'config', readStatus: 'read' },
  { relativePath: 'project/metrics/results.csv', content: 'epoch,miou\n1,0.41\n2,0.46\n', kind: 'metric', readStatus: 'read' },
  { relativePath: 'project/logs/run.log', content: 'start\nepoch 1 miou=0.41\n', kind: 'log', readStatus: 'read' },
  { relativePath: 'project/data/raw.zip', content: 'PK-fake-archive-bytes', kind: 'archive', readStatus: 'metadata_only' },
  { relativePath: 'project/misc.dat', content: 'unknown-format-payload', kind: 'other', readStatus: 'metadata_only' },
  { relativePath: 'project/paper/main.pdf', content: '%PDF-1.4 fake', kind: 'paper', readStatus: 'metadata_only' },
  { relativePath: 'project/weights/model.pt', content: 'PT-WEIGHTS-FAKE', kind: 'weight', readStatus: 'metadata_only' },
];

const EXTRA_EXCLUDED_FILES: readonly { relativePath: string; content: string }[] = [
  { relativePath: 'project/.env', content: 'SECRET=1\n' },
  { relativePath: 'project/node_modules/dep/index.js', content: 'module.exports = 1;\n' },
  { relativePath: 'project/.git/HEAD', content: 'ref: refs/heads/main\n' },
];

function writeFixture(workspace: string): void {
  for (const file of [...FIXTURE_FILES, ...EXTRA_EXCLUDED_FILES]) {
    const target = path.join(workspace, ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
}

function expectedCounts(): TakeoverScan['counts'] {
  const byKind = {} as Record<TakeoverEntryKind, number>;
  for (const kind of TAKEOVER_ENTRY_KINDS) byKind[kind] = 0;
  let read = 0;
  let metadataOnly = 0;
  let skipped = 0;
  let failed = 0;
  let notRead = 0;
  let totalBytes = 0;
  let hashed = 0;
  for (const file of FIXTURE_FILES) {
    byKind[file.kind] += 1;
    if (file.readStatus === 'read') { read += 1; hashed += 1; }
    else if (file.readStatus === 'metadata_only') metadataOnly += 1;
    else if (file.readStatus === 'skipped') skipped += 1;
    else if (file.readStatus === 'failed') failed += 1;
    else notRead += 1;
    totalBytes += Buffer.byteLength(file.content, 'utf8');
  }
  return { total: FIXTURE_FILES.length, byKind, read, metadataOnly, skipped, failed, notRead, totalBytes, hashed };
}

// ------------------------------------------------------------------ filesystem helpers

/** Independent on-disk listing: the reference inventory the scan counts are checked against. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (absoluteDir: string, relativeDir: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const relative = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
      const absolute = path.join(absoluteDir, dirent.name);
      if (dirent.isDirectory()) { walk(absolute, relative); continue; }
      out.push(relative.split(path.sep).join('/'));
    }
  };
  walk(root, '');
  return out.sort();
}

interface FileFact {
  bytes: number;
  mtimeMs: number;
  sha256: string;
}

/** Every file's (size, mtime, sha256); `.dsh` is the system-managed product directory and is skipped. */
function snapshotTree(root: string): Map<string, FileFact> {
  const out = new Map<string, FileFact>();
  const walk = (absoluteDir: string, relativeDir: string): void => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const relative = relativeDir === '' ? dirent.name : `${relativeDir}/${dirent.name}`;
      const absolute = path.join(absoluteDir, dirent.name);
      if (dirent.isDirectory()) {
        if (relativeDir === '' && dirent.name === '.dsh') continue;
        walk(absolute, relative);
        continue;
      }
      const stat = fs.statSync(absolute);
      out.set(relative.split(path.sep).join('/'), {
        bytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      });
    }
  };
  walk(root, '');
  return out;
}

function removeOnWindows(root: string): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') return;
    // Windows keeps a handle alive for a moment; retry once before giving up.
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      /* best effort: the temp dir is outside the user's workspace */
    }
  }
}

// ------------------------------------------------------------------ harness

interface Harness {
  workspace: string;
  projectDir: string;
  store: ResearchBootstrapStore;
  service: TakeoverService;
  revision(): number;
}

function harness(t: { after: (fn: () => void) => void }): Harness {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-takeover-'));
  t.after(() => removeOnWindows(workspace));
  writeFixture(workspace);
  const store = new ResearchBootstrapStore(workspace, { lockTimeoutMs: 5_000, lockPollIntervalMs: 10 });
  return {
    workspace,
    projectDir: path.join(workspace, PROJECT_ROOT),
    store,
    service: new TakeoverService(store),
    revision: () => store.readStateOrEmpty().revision,
  };
}

function snapshotDraft(): TakeoverSnapshotDraft {
  return {
    title: '已有研究现状快照',
    currentFocus: '门控模块对小样本分割泛化的影响',
    materials: [],
    groups: [],
    known: ['已有一次完整训练日志与对应的 miou 指标'],
    unknown: [{ unknownId: 'unknown-1', topic: '配置与指标的对应关系未证实', detail: '未找到明确的运行标识', entryIds: [] }],
    relations: [],
    nextSteps: ['核对 metrics/results.csv 与 config/train.yaml 是否对应同一次运行'],
    citations: [],
    watchedEntries: [],
    model: { agentIdentity: 'session-takeover-test', modelIdentity: 'test-model' },
  };
}

// ------------------------------------------------------------------ tests

test('B1-01: the real scan inventories exactly the files on disk and passes the frozen validator', async (t) => {
  const h = harness(t);
  const scan = await scanTakeoverDirectory({ workspaceRoot: h.workspace, roots: [PROJECT_ROOT], scopeNote: '一句话接管：整理已有材料' });

  // 1. The inventory is exactly the on-disk tree minus the documented exclusions.
  const onDisk = walkFiles(h.projectDir).map((entry) => `${PROJECT_ROOT}/${entry}`);
  const expectedPaths = onDisk.filter((entry) => !EXCLUDED_RELPATHS.includes(entry));
  assert.deepEqual(scan.entries.map((entry) => entry.relativePath).sort(), expectedPaths);
  for (const excluded of EXCLUDED_RELPATHS) {
    assert.equal(scan.entries.some((entry) => entry.relativePath === excluded), false, `${excluded} must be excluded`);
  }

  // 2. Counts match the entries actually on disk.
  assert.deepEqual(scan.counts, expectedCounts());
  assert.equal(scan.counts.total, scan.entries.length);
  assert.equal(scan.counts.totalBytes, scan.entries.reduce((sum, entry) => sum + entry.bytes, 0));
  assert.equal(scan.truncated, false);
  assert.deepEqual(scan.exclusions, [...TAKEOVER_DEFAULT_EXCLUSIONS]);

  // 3. Every entry carries its locator facts, and a read entry's sha256 is the real file hash.
  for (const entry of scan.entries) {
    assert.ok(entry.entryId.length > 0);
    assert.ok(entry.relativePath.startsWith(`${PROJECT_ROOT}/`));
    assert.ok(TAKEOVER_ENTRY_KINDS.includes(entry.kind));
    assert.equal(typeof entry.bytes, 'number');
    const onDiskBytes = fs.statSync(path.join(h.workspace, entry.relativePath)).size;
    assert.equal(entry.bytes, onDiskBytes, `${entry.relativePath} byte count`);
    if (entry.readStatus === 'read') {
      assert.ok(entry.excerpt !== null && entry.excerpt.length > 0, `${entry.relativePath} read but no excerpt`);
      assert.ok(entry.excerptLines !== null, `${entry.relativePath} read without a line locator`);
      assert.equal(entry.hashStatus, 'computed');
      assert.equal(entry.sha256, createHash('sha256').update(fs.readFileSync(path.join(h.workspace, entry.relativePath))).digest('hex'));
    }
  }

  // 4. Duplicate content is registered twice and names the first entry.
  const readme = scan.entries.find((entry) => entry.relativePath === 'project/README.md');
  const copy = scan.entries.find((entry) => entry.relativePath === 'project/notes/copy.md');
  assert.ok(readme && copy);
  assert.equal(copy.sha256, readme.sha256);
  assert.equal(copy.duplicateOf, readme.entryId);
  assert.equal(readme.duplicateOf, null);
  assert.deepEqual(copy.sourceIdentity, { kind: 'content', value: copy.sha256 });

  // 5. Weights and PDFs stay metadata-only: no invented hash, no claimed read.
  const weight = scan.entries.find((entry) => entry.relativePath === 'project/weights/model.pt')!;
  assert.equal(weight.kind, 'weight');
  assert.equal(weight.readStatus, 'metadata_only');
  assert.equal(weight.hashStatus, 'not_computed');
  assert.equal(weight.sha256, null);
  assert.equal(weight.excerpt, null);
  assert.match(weight.readReason, /权重/);
  const pdf = scan.entries.find((entry) => entry.relativePath === 'project/paper/main.pdf')!;
  assert.equal(pdf.kind, 'paper');
  assert.equal(pdf.readStatus, 'metadata_only');
  assert.equal(pdf.hashStatus, 'not_computed');

  // 6. The frozen validator accepts the scan as produced.
  const validated = validateTakeoverScan(scan);
  assert.equal(validated.counts.total, scan.counts.total);
  assert.equal(validated.entries.length, scan.entries.length);
});

test('B1-02: start + refresh are read-only — no byte, size, mtime or file-set change in the scanned tree', async (t) => {
  const h = harness(t);
  const before = snapshotTree(h.workspace);
  const beforeCount = walkFiles(h.projectDir).length;

  const started = await h.service.start(
    { operationId: 'op-takeover-start', baseRevision: 0, roots: [PROJECT_ROOT], scopeNote: '只读接管' },
    'session-takeover-test',
  );
  const refreshed = await h.service.refresh(
    { operationId: 'op-takeover-refresh', baseRevision: h.revision(), takeoverId: started.result.takeoverId },
    'session-takeover-test',
  );
  assert.notEqual(refreshed.result.scanId, started.result.scanId);

  const after = snapshotTree(h.workspace);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file may be created, copied or removed');
  for (const [relativePath, fact] of before) {
    assert.deepEqual(after.get(relativePath), fact, `${relativePath} changed on disk`);
  }
  assert.equal(walkFiles(h.projectDir).length, beforeCount);

  // The scan really read those bytes (it cannot be a no-op that merely claims read-only).
  const record = h.service.read(started.result.takeoverId)!;
  const scan = record.scans.find((entry) => entry.scanId === record.currentScanId)!;
  assert.ok(scan.counts.read > 0);
  const readme = scan.entries.find((entry) => entry.relativePath === 'project/README.md')!;
  assert.equal(readme.readStatus, 'read');
  assert.equal(readme.sha256, createHash('sha256').update(fs.readFileSync(path.join(h.workspace, 'project/README.md'))).digest('hex'));

  // Nothing was copied into the tree: the state lives in the system-managed .dsh directory only.
  const stateFile = path.join(h.workspace, '.dsh', 'research', 'bootstrap', 'state.json');
  assert.equal(fs.existsSync(stateFile), true);
  const readmes = walkFiles(h.projectDir).filter((entry) => entry.endsWith('README.md'));
  assert.deepEqual(readmes, ['README.md']);
});

test('B1-03: start is idempotent for the same roots and registers a new record for a different root set', async (t) => {
  const h = harness(t);
  const first = await h.service.start(
    { operationId: 'op-idem-1', baseRevision: 0, roots: [PROJECT_ROOT] },
    'session-takeover-test',
  );
  assert.equal(first.result.reused, false);

  const second = await h.service.start(
    { operationId: 'op-idem-2', baseRevision: h.revision(), roots: [PROJECT_ROOT] },
    'session-takeover-test',
  );
  assert.equal(second.result.reused, true);
  assert.equal(second.result.takeoverId, first.result.takeoverId);
  assert.equal(second.result.scanId, first.result.scanId);
  assert.equal(second.revision, first.revision, 'a reuse must not mint a revision');
  assert.equal(h.service.list().length, 1, 'no second record');
  assert.equal(h.service.read(first.result.takeoverId)!.scans.length, 1, 'no second scan');

  const other = await h.service.start(
    { operationId: 'op-idem-3', baseRevision: h.revision(), roots: ['project/notes'] },
    'session-takeover-test',
  );
  assert.equal(other.result.reused, false);
  assert.notEqual(other.result.takeoverId, first.result.takeoverId);
  assert.equal(h.service.list().length, 2);
  const notesScan = h.service.read(other.result.takeoverId)!.scans[0];
  assert.deepEqual(notesScan.entries.map((entry) => entry.relativePath).sort(), [
    'project/notes/copy.md',
    'project/notes/idea.md',
    'project/notes/wiki/overview.md',
  ]);
});

test('B1-04: a snapshot citation must resolve against really-read content', async (t) => {
  const h = harness(t);
  const started = await h.service.start(
    { operationId: 'op-cite-start', baseRevision: 0, roots: [PROJECT_ROOT] },
    'session-takeover-test',
  );
  const takeoverId = started.result.takeoverId;
  const scan = h.service.read(takeoverId)!.scans[0];
  const readEntry = scan.entries.find((entry) => entry.relativePath === 'project/README.md')!;
  const quote = readEntry.excerpt!.split('\n')[0]!;
  const weightEntry = scan.entries.find((entry) => entry.relativePath === 'project/weights/model.pt')!;

  // (a) A quote that is not verbatim in the read excerpt is rejected, revision untouched.
  const beforeBadQuote = h.revision();
  assert.throws(
    () => h.service.saveSnapshot(
      { operationId: 'op-cite-bad-quote', baseRevision: beforeBadQuote, takeoverId, snapshot: { ...snapshotDraft(), citations: [{ citationId: 'cit-bad', entryId: readEntry.entryId, quote: '模型在 ImageNet 上达到 95% 准确率', note: '' }] } },
      'session-takeover-test',
    ),
    (error: unknown) => error instanceof TakeoverError && error.code === 'INVALID_INPUT' && /not present in the read excerpt/.test(error.message),
    'a non-verbatim quote must be refused',
  );
  assert.equal(h.revision(), beforeBadQuote, 'a refused snapshot must not move the revision');
  assert.equal(h.service.read(takeoverId)!.snapshot.citations.length, 0);

  // (b) A citation naming an entry whose readStatus !== 'read' is rejected.
  const beforeUnread = h.revision();
  assert.throws(
    () => h.service.saveSnapshot(
      { operationId: 'op-cite-unread', baseRevision: beforeUnread, takeoverId, snapshot: { ...snapshotDraft(), citations: [{ citationId: 'cit-unread', entryId: weightEntry.entryId, quote: 'anything', note: '' }] } },
      'session-takeover-test',
    ),
    (error: unknown) => error instanceof TakeoverError && error.code === 'INVALID_INPUT' && /was not read/.test(error.message),
    'a citation on a metadata-only weight must be refused',
  );
  assert.equal(h.revision(), beforeUnread);

  // (c) A citation naming an entry outside the scan is rejected.
  assert.throws(
    () => h.service.saveSnapshot(
      { operationId: 'op-cite-unknown', baseRevision: h.revision(), takeoverId, snapshot: { ...snapshotDraft(), citations: [{ citationId: 'cit-unknown', entryId: 'takeover-entry-99999', quote: quote, note: '' }] } },
      'session-takeover-test',
    ),
    (error: unknown) => error instanceof TakeoverError && error.code === 'INVALID_INPUT' && /not in scan/.test(error.message),
  );

  // (d) A verbatim quote against a really-read entry saves.
  const beforeGood = h.revision();
  const saved = h.service.saveSnapshot(
    {
      operationId: 'op-cite-good',
      baseRevision: beforeGood,
      takeoverId,
      snapshot: {
        ...snapshotDraft(),
        materials: [{ materialId: 'mat-1', label: 'README 基线与门控说明', evidenceLevel: 'content_read', detail: 'README 描述了基线与门控位置', citationIds: ['cit-good'] }],
        groups: [{ groupId: 'group-1', label: '训练资料', basis: 'reported', basisNote: '仅凭同目录与文件命名推断，依据有限', entryIds: [readEntry.entryId], limitedBasis: true }],
        citations: [{ citationId: 'cit-good', entryId: readEntry.entryId, quote, note: 'README 首行' }],
      },
    },
    'session-takeover-test',
  );
  assert.equal(saved.revision, beforeGood + 1);
  assert.equal(saved.result.revision, h.service.read(takeoverId)!.snapshot.revision);
  const stored = h.service.read(takeoverId)!.snapshot;
  assert.deepEqual(stored.citations, [{ citationId: 'cit-good', entryId: readEntry.entryId, quote, note: 'README 首行' }]);
  assert.equal(stored.scanId, h.service.read(takeoverId)!.currentScanId);
  assert.deepEqual(stored.model, { agentIdentity: 'session-takeover-test', modelIdentity: 'test-model' });
  // The saved citation still resolves against the current scan when the record is re-validated.
  assert.doesNotThrow(() => validateTakeoverRecord(h.service.read(takeoverId)!));
});

test('B1-05: a second store and service instance reads the record, snapshot and revision back intact', async (t) => {
  const h = harness(t);
  const started = await h.service.start(
    { operationId: 'op-persist-start', baseRevision: 0, roots: [PROJECT_ROOT], scopeNote: '持久化验收' },
    'session-takeover-test',
  );
  const takeoverId = started.result.takeoverId;
  const readEntry = h.service.read(takeoverId)!.scans[0].entries.find((entry) => entry.relativePath === 'project/README.md')!;
  const saved = h.service.saveSnapshot(
    {
      operationId: 'op-persist-snapshot',
      baseRevision: h.revision(),
      takeoverId,
      snapshot: { ...snapshotDraft(), citations: [{ citationId: 'cit-p1', entryId: readEntry.entryId, quote: readEntry.excerpt!.split('\n')[0]!, note: '' }] },
    },
    'session-takeover-test',
  );
  const expectedRevision = h.revision();

  // A brand-new store (fresh memory, no shared cache) over the same workspace root.
  const reopenedStore = new ResearchBootstrapStore(h.workspace);
  const reopenedService = new TakeoverService(reopenedStore);
  const record = reopenedService.read(takeoverId);
  assert.ok(record, 'the takeover must survive a new store instance');
  assert.equal(record.takeoverId, takeoverId);
  assert.equal(record.roots.length, 1);
  assert.equal(record.roots[0], PROJECT_ROOT);
  assert.equal(record.scopeNote, '持久化验收');
  assert.equal(record.currentScanId, started.result.scanId);
  assert.equal(record.scans.length, 1);
  assert.equal(record.scans[0].counts.total, expectedCounts().total);
  assert.equal(record.snapshot.snapshotId, saved.result.snapshotId);
  assert.equal(record.snapshot.revision, saved.result.revision);
  assert.deepEqual(record.snapshot.citations, [{ citationId: 'cit-p1', entryId: readEntry.entryId, quote: readEntry.excerpt!.split('\n')[0]!, note: '' }]);
  assert.equal(record.snapshot.currentFocus, snapshotDraft().currentFocus);
  assert.equal(record.actorIdentity, 'session-takeover-test');
  assert.equal(reopenedStore.readStateOrEmpty().revision, expectedRevision);
  assert.equal(reopenedService.list().length, 1);
  assert.doesNotThrow(() => validateTakeoverRecord(record));
});

test('B1-06: freshness is recomputed from the real filesystem and goes stale when a watched file changes', async (t) => {
  const h = harness(t);
  const started = await h.service.start(
    { operationId: 'op-fresh-start', baseRevision: 0, roots: [PROJECT_ROOT] },
    'session-takeover-test',
  );
  const takeoverId = started.result.takeoverId;
  const watchedCount = h.service.read(takeoverId)!.snapshot.watchedEntries.length;
  assert.ok(watchedCount > 0, 'the placeholder snapshot must watch the really-read entries');

  const fresh = h.service.checkFreshness(takeoverId);
  assert.equal(fresh.stale, false, 'nothing changed yet');
  assert.deepEqual(fresh.changed, []);
  assert.equal(fresh.checked, watchedCount);
  assert.equal(fresh.notChecked, 0);
  assert.equal(h.service.projection(takeoverId).freshness.stale, false);

  // The user edits an original file: the snapshot must no longer claim to be current.
  const target = path.join(h.workspace, 'project/README.md');
  fs.writeFileSync(target, `${README_TEXT}\n附加一行：模拟原始材料被修改。\n`, 'utf8');
  const stale = h.service.checkFreshness(takeoverId);
  assert.equal(stale.stale, true);
  const changed = stale.changed.find((entry) => entry.relativePath === 'project/README.md');
  assert.ok(changed, `changed must name the touched file, got ${JSON.stringify(stale.changed)}`);
  assert.equal(changed.reason, 'size');
  assert.equal(h.service.projection(takeoverId).freshness.stale, true);

  // A deleted watched file is reported as missing, not silently ignored.
  fs.rmSync(path.join(h.workspace, 'project/metrics/results.csv'));
  const afterDelete = h.service.checkFreshness(takeoverId);
  assert.equal(afterDelete.stale, true);
  const missing = afterDelete.changed.find((entry) => entry.relativePath === 'project/metrics/results.csv');
  assert.ok(missing);
  assert.equal(missing.reason, 'missing');
});

test('B1-06: a missing root is recorded as a scan error, and a failing scan is recorded on the record', async (t) => {
  const h = harness(t);
  const started = await h.service.start(
    { operationId: 'op-error-start', baseRevision: 0, roots: [PROJECT_ROOT, 'no-such-directory'] },
    'session-takeover-test',
  );
  const record = h.service.read(started.result.takeoverId)!;
  const scan = record.scans[0];
  // The failure is visible as an error entry on the stored scan instead of disappearing.
  const missing = scan.errors.find((entry) => entry.relativePath === 'no-such-directory');
  assert.ok(missing, `the missing root must be reported, got ${JSON.stringify(scan.errors)}`);
  assert.equal(missing.code, 'READ_FAILED');
  assert.match(missing.message, /ENOENT/);
  // The real files under the existing root are still inventoried.
  assert.equal(scan.counts.total, expectedCounts().total);
  assert.equal(record.firstError, null, 'a partially-failing scan is not an empty error scan; it is recorded at scan level');

  // A scan that throws outright: the record is still stored, with the first error on the record.
  const failingStore = new ResearchBootstrapStore(h.workspace);
  const failing = new TakeoverService(failingStore, { scan: async () => { throw new Error('scanner exploded'); } });
  const failed = await failing.start(
    { operationId: 'op-error-throw', baseRevision: h.revision(), roots: ['project/metrics'] },
    'session-takeover-test',
  );
  const failedRecord = failing.read(failed.result.takeoverId)!;
  assert.ok(failedRecord.firstError, 'a thrown scan must be recorded on the record');
  assert.equal(failedRecord.firstError.code, 'SCAN_FAILED');
  assert.match(failedRecord.firstError.message, /scanner exploded/);
  assert.equal(failedRecord.scans.length, 1);
  assert.equal(failedRecord.scans[0].counts.total, 0);
  assert.equal(failedRecord.scans[0].entries.length, 0);
  assert.match(failedRecord.scans[0].gitNote, /SCAN_FAILED/);
  // The placeholder stays an explicit unknown rather than a fabricated summary.
  assert.equal(failedRecord.snapshot.currentFocus, '待确定');
  assert.ok(failedRecord.snapshot.unknown.length > 0);
  assert.ok(failedRecord.scans[0].entries.length === 0);
  assert.doesNotThrow(() => validateTakeoverRecord(failedRecord));
});

test('classification is preliminary: the scanner and the pinned table agree, and no kind is inferred from content', () => {
  for (const file of FIXTURE_FILES) {
    const classified = classifyTakeoverEntry(file.relativePath, Buffer.byteLength(file.content, 'utf8'));
    assert.equal(classified.kind, file.kind, `${file.relativePath} kind`);
  }
  assert.deepEqual(classifyTakeoverEntry('project/weights/model.pt', 10), { kind: 'weight', kindBasis: 'extension' });
  assert.deepEqual(classifyTakeoverEntry('project/notes/wiki/overview.md', 10), { kind: 'wiki', kindBasis: 'directory' });
  // A weight's extension never becomes "read": classification is a hint, evidence comes from the read.
  assert.equal(classifyTakeoverEntry('anything.py', 0).kind, 'code');
});

test('PDF text is read only through the injected extractor, and a failed extract stays a per-file error', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-takeover-pdf-'));
  const pdfPath = path.join(workspace, 'paper', 'note.pdf');
  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
  fs.writeFileSync(pdfPath, '%PDF-1.4 not a real document');
  const read = await scanTakeoverDirectory({
    workspaceRoot: workspace,
    roots: ['.'],
    scanId: 'pdf-read',
    readPdfText: async () => ['基线为 ResNet-18，门控模块插在编码器末端。'],
  });
  const entry = read.entries.find((item) => item.relativePath === 'paper/note.pdf');
  assert.ok(entry);
  assert.equal(entry.kind, 'paper');
  assert.equal(entry.readStatus, 'read');
  assert.equal(entry.hashStatus, 'not_computed');
  assert.equal(entry.sha256, null);
  assert.match(entry.excerpt ?? '', /ResNet-18/);
  assert.ok(entry.excerptLines);

  const failed = await scanTakeoverDirectory({
    workspaceRoot: workspace,
    roots: ['.'],
    scanId: 'pdf-fail',
    readPdfText: async () => { throw new Error('scanned PDF has no text layer'); },
  });
  const broken = failed.entries.find((item) => item.relativePath === 'paper/note.pdf');
  assert.ok(broken);
  assert.equal(broken.readStatus, 'failed');
  assert.equal(broken.excerpt, null);
  assert.match(broken.readReason, /no text layer/);
  assert.equal(failed.errors[0]?.code, 'READ_FAILED');
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('a citation quote matches a Windows excerpt that still contains CR', () => {
  const scan = {
    scanId: 'scan-cr',
    entries: [{ entryId: 'e1', relativePath: 'README.md', readStatus: 'read', excerpt: '基线为 ResNet-18\r\n下一行' }],
  } as TakeoverScan;
  assert.doesNotThrow(() => assertCitationsResolve(
    [{ citationId: 'c1', entryId: 'e1', quote: '基线为 ResNet-18\n下一行', note: '' }],
    scan,
    'cr',
  ));
  assert.throws(
    () => assertCitationsResolve(undefined as unknown as TakeoverScan['entries'], scan, 'cr'),
    (error: unknown) => error instanceof TakeoverError && /citations must be an array/.test(error.message),
  );
});

test('a one-line takeover request selects the takeover skill and ignores tool text', () => {
  const user = (text: string) => [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }];
  assert.equal(needsResearchTakeoverSkill(user('帮我接着这个项目做研究，先整理目前已有的东西，不要修改原始文件。')), true);
  assert.equal(needsResearchTakeoverSkill(user('把刚才整理的资料接进这个研究的 Wiki 和研究树，保留已有内容。先把不明确的关系标出来，不执行实验。')), true);
  assert.equal(needsResearchTakeoverSkill(user('盘点一下这个仓库里已有的笔记和配置')), true);
  assert.equal(needsResearchTakeoverSkill(user('今天先讨论实验指标怎么定义')), false);
  assert.equal(needsResearchTakeoverSkill([{ source: { kind: 'tool' }, content: [{ type: 'text', text: '帮我接着这个项目做研究，先整理目前已有的东西' }] }]), false);
});
