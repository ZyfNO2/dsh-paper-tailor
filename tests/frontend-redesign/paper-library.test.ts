import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import { PaperLibrary, PaperLibraryError } from '../../packages/evolver/src/application/paper-library.ts';
import { librarySnapshot } from '../../packages/evolver-ui/src/client/integration/paper-library-view.ts';
import { apply, paperLibraryFailure, workspaceForSession, workspacePaperLibrary } from '../../packages/evolver/src/adapters/dsh/paper-library-host.ts';

test('new library starts empty; immutable source, evidence checks, revisions and owner isolation persist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-library-'));
  try {
    const library = new PaperLibrary(root);
    assert.deepEqual(library.list('alice'), []);
    const paper = library.import('alice', 'uploaded.md', Buffer.from('The method applies a boundary loss to segment contours.'), ['The method applies a boundary loss to segment contours.']);
    const input = { baseRevision: null, title: 'Boundary method', sections: [{ heading: 'Method', summary: 'Use boundary loss.', page: 1, quote: 'applies a boundary loss' }],
      components: [{ kind: 'Module' as const, name: 'Boundary loss', description: 'Contour segmentation loss.', page: 1, quote: 'boundary loss to segment contours' }] };
    assert.throws(() => library.publish('alice', paper.id, { ...input, sections: [{ ...input.sections[0], quote: 'A quote that is not in this paper.' }] }), /EVIDENCE_MISMATCH/);
    const published = library.publish('alice', paper.id, input);
    assert.ok(published.revision);
    assert.throws(() => library.publish('alice', paper.id, input), /REVISION_CONFLICT/);
    assert.throws(() => library.get('bob', paper.id), /ENOENT/);
    assert.deepEqual(library.list('bob'), []);
    assert.equal(new PaperLibrary(root).get('alice', paper.id).revision, published.revision);
    assert.ok(fs.readdirSync(path.dirname(library.original('alice', paper.id))).some((f) => f.endsWith('.md')));
    const snapshot = librarySnapshot('alice', [{ ...published, pageCount: 1 }]);
    assert.equal(snapshot.tailor.data?.components[0].kind, 'Module');
    assert.equal(snapshot.tailor.data?.components[0].validatedInTask, false);
    assert.equal(snapshot.papers.data?.papers[0].wikiLinks.length, 1);
    assert.equal(snapshot.papers.data?.papers[0].contributions[0].evidences[0].value, input.components[0].quote);
    fs.writeFileSync(library.original('alice', paper.id), 'corrupted');
    assert.throws(() => library.get('alice', paper.id), /SOURCE_CORRUPT/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
test('blank and scanned sources, traversal identity and missing owner fail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-library-'));
  try {
    const library = new PaperLibrary(root);
    assert.throws(() => library.import('alice', 'scan.pdf', Buffer.from('bytes'), ['']), /TEXT_MISSING/);
    assert.throws(() => library.get('alice', '../x'), /INVALID_PAPER_ID/);
    assert.throws(() => library.list(''), /OWNER_REQUIRED/);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('workspace files survive session switches and host recreation; another workspace stays isolated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-papers-'));
  try {
    const workspaces = [{ id: 'w1', path: path.join(root, 'project-one'), title: 'One', sessionIds: ['s1', 's2'] },
      { id: 'w2', path: path.join(root, 'project-two'), title: 'Two', sessionIds: ['s3'] }];
    const registry = { list: () => workspaces };
    const first = workspaceForSession(registry, 's1'), second = workspaceForSession(registry, 's2');
    const library = workspacePaperLibrary(first);
    const paper = library.import(first.path, 'paper.md', Buffer.from('A shared workspace paper describes a segmentation method.'), ['A shared workspace paper describes a segmentation method.']);
    const published = library.publish(first.path, paper.id, { baseRevision: null, title: 'Shared paper', sections: [{ heading: 'Method', summary: 'Segmentation method.', page: 1, quote: 'describes a segmentation method' }], components: [] });
    assert.equal(workspacePaperLibrary(second).get(second.path, paper.id).revision, published.revision);
    assert.ok(fs.existsSync(path.join(first.path, '.dsh', 'research', 'papers', `${paper.id}.json`)));
    assert.deepEqual(workspacePaperLibrary(workspaces[1]).list(workspaces[1].path), []);
    assert.throws(() => workspaceForSession(registry, 'unregistered'), /WORKSPACE_REQUIRED/);
    assert.throws(() => library.list(workspaces[1].path), /OWNER_MISMATCH/);
    const file = path.join(first.path, '.dsh', 'research', 'papers', `${paper.id}.json`);
    const edited = JSON.parse(fs.readFileSync(file, 'utf8')); edited.title = 'File-backed title';
    fs.writeFileSync(file, JSON.stringify(edited));
    assert.equal(workspacePaperLibrary(second).list(second.path)[0].title, 'File-backed title');
  } finally { fs.rmSync(root, { recursive: true }); }
});

/* ---------------------------------------------------------------------------------------------------
 * WP-B: locatable EVIDENCE_MISMATCH diagnostics and write invariants.
 * Fixtures use self-authored public-domain-style text; no user research asset is read or written.
 * ------------------------------------------------------------------------------------------------- */

const PAGE_ONE = 'The method applies a boundary loss to segment contours in medical images.';
const PAGE_TWO = 'Our baseline is a convolutional encoder trained from scratch on the target domain.';
const PAGE_THREE = 'The experiment reports Dice improvements on the validation split; our baseline is a convolutional encoder trained from scratch on the target domain.';
const PAGES = [PAGE_ONE, PAGE_TWO, PAGE_THREE];

const SECTION_OK = { heading: 'Method', summary: 'Boundary loss for contours.', page: 1, quote: 'applies a boundary loss to segment contours' };
const SECTION_PAGE_TWO = { heading: 'Baseline', summary: 'Encoder trained from scratch.', page: 2, quote: 'convolutional encoder trained from scratch' };
const COMPONENT_OK = { kind: 'Module' as const, name: 'Boundary loss', description: 'Contour segmentation loss.', page: 1, quote: 'boundary loss to segment contours' };
const COMPONENT_PAGE_TWO = { kind: 'Baseline' as const, name: 'Encoder baseline', description: 'Trained from scratch.', page: 2, quote: 'convolutional encoder trained from scratch' };
const COMPONENT_PAGE_THREE = { kind: 'Experiment' as const, name: 'Validation experiment', description: 'Dice improvement.', page: 3, quote: 'reports Dice improvements on the validation split' };

interface Fixture { root: string; workspace: string; library: PaperLibrary; paperId: string; sha256: string; revision: string }
function fixture(prefix: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const library = workspacePaperLibrary({ id: 'w', path: workspace, title: 'Project', sessionIds: ['s1'] });
  const paper = library.import(workspace, 'paper.md', Buffer.from(PAGES.join('\n')), PAGES);
  const wiki = library.publish(workspace, paper.id, { baseRevision: null, title: 'Evidence paper', sections: [SECTION_OK], components: [], submitted: 'wiki' });
  return { root, workspace, library, paperId: paper.id, sha256: paper.sha256, revision: wiki.revision! };
}
/** Byte-level state of the durable asset: JSON bytes plus every version artifact in the folder. */
function workspaceState(workspace: string, paperId: string): { json: string; files: string[] } {
  const folder = path.join(workspace, '.dsh', 'research', 'papers');
  return { json: fs.readFileSync(path.join(folder, `${paperId}.json`)).toString('base64'), files: fs.readdirSync(folder).sort() };
}
function paperFile(workspace: string, paperId: string): string { return path.join(workspace, '.dsh', 'research', 'papers', `${paperId}.json`); }
/** Rewrite the stored asset only, simulating a preserved field whose evidence no longer matches the source pages. */
function tamperStored(workspace: string, paperId: string, edit: (stored: any) => void): void {
  const stored = JSON.parse(fs.readFileSync(paperFile(workspace, paperId), 'utf8'));
  edit(stored);
  fs.writeFileSync(paperFile(workspace, paperId), JSON.stringify(stored, null, 2));
}
function rejectionOf(run: () => unknown): PaperLibraryError {
  try { run(); } catch (error) {
    assert.ok(error instanceof PaperLibraryError, `expected a PaperLibraryError, received ${String(error)}`);
    return error;
  }
  throw new Error('expected the publish to be rejected, but it succeeded');
}

test('a failing components publish locates components[K] as submitted, keeps other items unpublished and writes nothing', () => {
  const f = fixture('paper-diag-components-');
  try {
    const before = workspaceState(f.workspace, f.paperId);
    const submitted = [COMPONENT_OK, { ...COMPONENT_PAGE_TWO, quote: 'This sentence appears on no page of this paper.' }, COMPONENT_PAGE_THREE];
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK], components: submitted, submitted: 'components' }));
    assert.equal(failure.code, 'EVIDENCE_MISMATCH');
    assert.match(failure.message, /EVIDENCE_MISMATCH/);
    assert.match(failure.message, /components\[1\]/);
    assert.match(failure.message, /QUOTE_NOT_ON_PAGE/);
    const diagnostic = failure.diagnostic!;
    assert.equal(diagnostic.code, 'EVIDENCE_MISMATCH');
    assert.equal(diagnostic.paperId, f.paperId);
    assert.equal(diagnostic.sourceSha256, f.sha256);
    assert.equal(diagnostic.currentRevision, f.revision);
    assert.equal(diagnostic.persisted, false);
    assert.equal(diagnostic.pageCount, 3);
    assert.equal(diagnostic.totalIssues, 1);
    assert.equal(diagnostic.issues.length, 1);
    const issue = diagnostic.issues[0];
    assert.equal(issue.group, 'components');
    assert.equal(issue.index, 1);
    assert.equal(issue.origin, 'submitted');
    assert.equal(issue.field, 'quote');
    assert.equal(issue.page, 2);
    assert.equal(issue.reason, 'QUOTE_NOT_ON_PAGE');
    assert.equal(issue.label, 'Encoder baseline');
    assert.deepEqual(issue.candidatePages, []);
    assert.deepEqual(issue.repair, { tool: 'evolver_read_uploaded_paper', args: { paperId: f.paperId, startPage: 2, endPage: 2 } });
    // No diagnostic may echo the submitted quote, leak page text or invent a replacement quote.
    const serialized = JSON.stringify(diagnostic);
    assert.equal(serialized.includes('This sentence appears on no page'), false);
    assert.equal(serialized.includes(PAGE_TWO), false);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);
    const stored = f.library.get(f.workspace, f.paperId);
    assert.equal(stored.revision, f.revision);
    assert.equal(stored.components.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('a broken preserved Wiki is located as sections[K] preserved without blaming the valid new component', () => {
  const f = fixture('paper-diag-preserved-wiki-');
  try {
    tamperStored(f.workspace, f.paperId, (stored) => { stored.sections = [{ ...stored.sections[0], quote: 'A preserved quote that is not on the stored page.' }]; });
    const before = workspaceState(f.workspace, f.paperId);
    // Exactly what the host does for a components publish: the stored Wiki is carried through unchanged.
    const storedSections = f.library.get(f.workspace, f.paperId).sections;
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: storedSections, components: [COMPONENT_OK], submitted: 'components' }));
    const diagnostic = failure.diagnostic!;
    assert.equal(diagnostic.totalIssues, 1);
    const issue = diagnostic.issues[0];
    assert.equal(issue.group, 'sections');
    assert.equal(issue.index, 0);
    assert.equal(issue.origin, 'preserved');
    assert.equal(issue.reason, 'QUOTE_NOT_ON_PAGE');
    assert.equal(issue.label, 'Method');
    assert.deepEqual(issue.repair.args, { paperId: f.paperId, startPage: 1, endPage: 1 });
    // The valid new component must not be blamed and must not be published on its own.
    assert.equal(diagnostic.issues.some((entry) => entry.group === 'components'), false);
    assert.equal(JSON.stringify(diagnostic).includes('Boundary loss'), false);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);
    assert.equal(f.library.get(f.workspace, f.paperId).components.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('a Wiki publish with a broken preserved component locates components[K] preserved and keeps the stored components', () => {
  const f = fixture('paper-diag-preserved-components-');
  try {
    const withComponents = f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK], components: [COMPONENT_OK, COMPONENT_PAGE_TWO], submitted: 'components' });
    tamperStored(f.workspace, f.paperId, (stored) => { stored.components[1] = { ...stored.components[1], quote: 'A preserved component quote that is not on its page.' }; });
    const before = workspaceState(f.workspace, f.paperId);
    // Exactly what the host does for a wiki publish: the stored components are carried through unchanged.
    const storedComponents = f.library.get(f.workspace, f.paperId).components;
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: withComponents.revision, title: 'Updated evidence paper', sections: [SECTION_OK], components: storedComponents, submitted: 'wiki' }));
    const diagnostic = failure.diagnostic!;
    assert.equal(diagnostic.totalIssues, 1);
    const issue = diagnostic.issues[0];
    assert.equal(issue.group, 'components');
    assert.equal(issue.index, 1);
    assert.equal(issue.origin, 'preserved');
    assert.equal(issue.reason, 'QUOTE_NOT_ON_PAGE');
    assert.equal(issue.page, 2);
    assert.equal(issue.label, 'Encoder baseline');
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);
    const stored = f.library.get(f.workspace, f.paperId);
    assert.equal(stored.components.length, 2);
    assert.equal(stored.title, 'Evidence paper');
    assert.equal(stored.revision, withComponents.revision);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('short, over-long, non-string quotes and unusable pages report precise reasons with zero file changes', () => {
  const f = fixture('paper-diag-reasons-');
  try {
    const cases: { label: string; page: unknown; quote: unknown; reason: string; field: string; shownPage: number | null }[] = [
      { label: 'too short', page: 1, quote: 'boundary', reason: 'QUOTE_TOO_SHORT', field: 'quote', shownPage: 1 },
      { label: 'over the raw limit', page: 1, quote: 'x'.repeat(2001), reason: 'QUOTE_TOO_LONG', field: 'quote', shownPage: 1 },
      { label: 'not a string', page: 1, quote: 12345, reason: 'QUOTE_NOT_STRING', field: 'quote', shownPage: 1 },
      { label: 'past the last page', page: 99, quote: 'applies a boundary loss to segment contours', reason: 'PAGE_OUT_OF_RANGE', field: 'page', shownPage: 99 },
      { label: 'page zero', page: 0, quote: 'applies a boundary loss to segment contours', reason: 'PAGE_OUT_OF_RANGE', field: 'page', shownPage: 0 },
      { label: 'fractional page', page: 1.5, quote: 'applies a boundary loss to segment contours', reason: 'PAGE_OUT_OF_RANGE', field: 'page', shownPage: 1.5 },
      { label: 'missing page', page: undefined, quote: 'applies a boundary loss to segment contours', reason: 'PAGE_OUT_OF_RANGE', field: 'page', shownPage: null },
    ];
    for (const entry of cases) {
      const before = workspaceState(f.workspace, f.paperId);
      const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK],
        components: [{ ...COMPONENT_OK, page: entry.page as number, quote: entry.quote as string }], submitted: 'components' }));
      const issue = failure.diagnostic!.issues[0];
      assert.equal(issue.reason, entry.reason, entry.label);
      assert.equal(issue.field, entry.field, entry.label);
      assert.equal(issue.group, 'components', entry.label);
      assert.equal(issue.index, 0, entry.label);
      assert.equal(issue.origin, 'submitted', entry.label);
      assert.equal(issue.page, entry.shownPage, entry.label);
      assert.equal(failure.diagnostic!.pageCount, 3, entry.label);
      // An unusable page never yields an illegal reread range.
      if (entry.reason === 'PAGE_OUT_OF_RANGE') {
        assert.deepEqual(issue.repair.args, { paperId: f.paperId }, entry.label);
        assert.match(issue.repair.note!, /1–3 pages|1–3/, entry.label);
      } else {
        assert.deepEqual(issue.repair.args, { paperId: f.paperId, startPage: 1, endPage: 1 }, entry.label);
      }
      assert.deepEqual(workspaceState(f.workspace, f.paperId), before, entry.label);
    }
    assert.equal(f.library.get(f.workspace, f.paperId).components.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('a quote that exists only on another page is rejected with strict candidate pages and no fabricated replacement', () => {
  const f = fixture('paper-diag-candidates-');
  try {
    const before = workspaceState(f.workspace, f.paperId);
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK],
      components: [{ ...COMPONENT_PAGE_TWO, page: 1 }], submitted: 'components' }));
    const issue = failure.diagnostic!.issues[0];
    assert.equal(issue.reason, 'QUOTE_NOT_ON_PAGE');
    assert.equal(issue.page, 1);
    assert.deepEqual(issue.candidatePages, [2, 3]);
    const serialized = JSON.stringify(failure.diagnostic);
    assert.equal(serialized.includes('convolutional encoder trained from scratch'), false);
    assert.equal(serialized.includes(PAGE_THREE), false);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);
    // The same quote on its actual page is accepted: candidates never widen acceptance.
    const accepted = f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK], components: [COMPONENT_PAGE_TWO], submitted: 'components' });
    assert.equal(accepted.components.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('more than ten failures keep the real total and mark the listed issues as truncated', () => {
  const f = fixture('paper-diag-truncated-');
  try {
    const before = workspaceState(f.workspace, f.paperId);
    const submitted = Array.from({ length: 12 }, (_, index) => ({ kind: 'Module' as const, name: `Candidate ${index}`, description: 'Candidate component.', page: 1, quote: `Absent candidate quote number ${index}.` }));
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK], components: submitted, submitted: 'components' }));
    const diagnostic = failure.diagnostic!;
    assert.equal(diagnostic.totalIssues, 12);
    assert.equal(diagnostic.issues.length, 10);
    assert.equal(diagnostic.truncated, true);
    assert.match(diagnostic.truncatedNote!, /first 10 of 12/);
    diagnostic.issues.forEach((issue, position) => { assert.equal(issue.index, position); assert.equal(issue.group, 'components'); });
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('stale revision, corrupted source, owner mismatch and invalid items keep their own codes and write nothing', () => {
  const f = fixture('paper-diag-codes-');
  try {
    const before = workspaceState(f.workspace, f.paperId);
    const stale = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: 'stale-revision', title: 'Evidence paper', sections: [SECTION_OK], components: [], submitted: 'wiki' }));
    assert.equal(stale.code, 'REVISION_CONFLICT');
    assert.equal(stale.diagnostic, undefined);
    assert.equal(stale.message.includes('EVIDENCE_MISMATCH'), false);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);

    const invalidTitle = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: '   ', sections: [SECTION_OK], components: [], submitted: 'wiki' }));
    assert.equal(invalidTitle.code, 'INVALID_TITLE');
    assert.equal(invalidTitle.diagnostic, undefined);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);

    const invalidKind = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK],
      components: [{ ...COMPONENT_OK, kind: 'Tool' as never }], submitted: 'components' }));
    assert.equal(invalidKind.code, 'EVIDENCE_MISMATCH');
    assert.equal(invalidKind.diagnostic!.issues[0].reason, 'INVALID_COMPONENT_KIND');
    assert.equal(invalidKind.diagnostic!.issues[0].field, 'kind');
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);

    const invalidContent = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK],
      components: [{ ...COMPONENT_OK, description: '  ' }], submitted: 'components' }));
    assert.equal(invalidContent.diagnostic!.issues[0].reason, 'INVALID_CONTENT');
    assert.equal(invalidContent.diagnostic!.issues[0].field, 'content');

    const invalidLabel = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK],
      components: [{ ...COMPONENT_OK, name: 'x'.repeat(301) }], submitted: 'components' }));
    assert.equal(invalidLabel.diagnostic!.issues[0].reason, 'INVALID_LABEL');
    assert.equal(invalidLabel.diagnostic!.issues[0].field, 'label');
    assert.equal(invalidLabel.diagnostic!.issues[0].label.length, 121);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);

    const scoped = new PaperLibrary(f.root, f.workspace);
    const ownerMismatch = rejectionOf(() => scoped.publish(path.join(f.root, 'other'), f.paperId, { baseRevision: null, title: 'Evidence paper', sections: [SECTION_OK], components: [] }));
    assert.equal(ownerMismatch.code, 'OWNER_MISMATCH');

    fs.writeFileSync(path.join(f.workspace, '.dsh', 'research', 'papers', `${f.paperId}.source`), 'corrupted bytes');
    const corruptState = workspaceState(f.workspace, f.paperId);
    const corrupt = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK], components: [], submitted: 'wiki' }));
    assert.equal(corrupt.code, 'SOURCE_CORRUPT');
    assert.equal(corrupt.diagnostic, undefined);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), corruptState);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('a whole-asset publish reports changed items as submitted and carried-over items as preserved', () => {
  const f = fixture('paper-diag-default-');
  try {
    // Both arrays differ from the stored asset, so both are genuine submissions.
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper',
      sections: [{ ...SECTION_OK, quote: 'Absent section quote for the default scope.' }], components: [{ ...COMPONENT_OK, quote: 'Absent component quote for the default scope.' }] }));
    const diagnostic = failure.diagnostic!;
    assert.equal(diagnostic.totalIssues, 2);
    assert.deepEqual(diagnostic.issues.map((issue) => [issue.group, issue.index, issue.origin]),
      [['sections', 0, 'submitted'], ['components', 0, 'submitted']]);

    // A whole-asset caller that carries the stored field through unchanged must not have it blamed as new.
    const stored = f.library.get(f.workspace, f.paperId).sections;
    const carried = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper',
      sections: stored, components: [{ ...COMPONENT_OK, quote: 'Absent component quote under a whole-asset publish.' }] }));
    assert.deepEqual(carried.diagnostic!.issues.map((issue) => [issue.group, issue.origin]), [['components', 'submitted']]);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('paperLibraryFailure preserves unrelated errors and gives PaperLibraryError the HarnessError channel', () => {
  const plain = new Error('SOURCE_REQUIRED: supply exactly one attachmentId or paperId');
  assert.equal(paperLibraryFailure(plain), plain);
  const failure = rejectionOf(() => { throw new PaperLibraryError('REVISION_CONFLICT', 'read current revision before publishing'); });
  const converted = paperLibraryFailure(failure) as HarnessError;
  assert.ok(converted instanceof HarnessError);
  assert.equal(converted.code, 'REVISION_CONFLICT');
  assert.match(converted.message, /REVISION_CONFLICT/);
  assert.equal(converted.message.includes('diagnostic='), false);
});

/* ---- the real DSH tool channel: defineTool -> ToolRuntime -> toolErrorResult text ---- */

interface HostHarness { definitions: Map<string, any>; workspace: { id: string; path: string; title: string; sessionIds: string[] }; exec: any }
function hostHarness(root: string): HostHarness {
  const definitions = new Map<string, any>(), commands = new Map<string, any>();
  const workspace = { id: 'project', path: root, title: 'Test project', sessionIds: ['s1'] };
  const services: Record<string, unknown> = {
    tools: { register: (definition: any) => definitions.set(definition.name, definition), get: (name: string) => definitions.get(name) },
    commands: { register: (command: any) => { commands.set(command.name, command); return () => {}; } },
    workspaceRegistry: { list: () => [workspace] },
    attachments: { readFileStream: async function* () {} },
    connection: { requestRejection: () => undefined },
    webServer: { register: () => () => {} },
  };
  const ctx = { get: (name: string) => services[name], tools: services.tools, on: () => {}, logger: { warn: () => {} } } as any;
  apply(ctx, { libraryRoot: root, pdfModulePath: 'not-used-for-md' });
  const agent = { id: 's1', session: { snapshotEvents: () => [] } };
  return { definitions, workspace, exec: { agent } };
}
/** Execute a registered definition through the shipped registry, exactly as the host dispatches it. */
async function runTool(harness: HostHarness, name: string, args: unknown): Promise<any> {
  const ctx = new Context();
  ctx.provide('systemPrompt', { tools: () => {}, section: () => {}, getSectionOrder: () => 0 });
  const runtime = new ToolRuntime(ctx, { mode: 'native' });
  for (const definition of harness.definitions.values()) runtime.register(definition);
  return runtime.execute({ callId: `call-${name}`, rootCallId: `call-${name}`, name, arguments: args, agent: harness.exec.agent, signal: new AbortController().signal });
}

test('the real tool channel carries the diagnostic JSON and the stable code in the error text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-diag-host-'));
  try {
    const harness = hostHarness(root);
    const library = workspacePaperLibrary(harness.workspace);
    const paper = library.import(root, 'paper.md', Buffer.from(PAGES.join('\n')), PAGES);
    const wiki = await runTool(harness, 'evolver_publish_paper_wiki', { paperId: paper.id, title: 'Host paper', sections: [SECTION_OK] });
    assert.equal(wiki.isError, false);
    assert.equal(wiki.content[0].text.includes('Error:'), false);
    const seeded = JSON.parse(wiki.content[0].text);
    assert.equal(seeded.persisted, true);
    assert.equal(seeded.wikiSections, 1);

    const before = workspaceState(root, paper.id);
    const failed = await runTool(harness, 'evolver_publish_paper_components', { paperId: paper.id, baseRevision: seeded.revision,
      components: [COMPONENT_OK, { ...COMPONENT_PAGE_TWO, quote: 'Absent host quote for this paper.' }] });
    assert.equal(failed.isError, true);
    assert.equal(failed.error.info.name, 'HarnessError');
    assert.equal(failed.error.info.code, 'EVIDENCE_MISMATCH');
    const text: string = failed.content[0].text;
    assert.match(text, /^Error: EVIDENCE_MISMATCH/);
    assert.match(text, /components\[1\]/);
    assert.match(text, /QUOTE_NOT_ON_PAGE/);
    const marker = ' diagnostic=';
    assert.ok(text.includes(marker), 'error text must embed the diagnostic');
    const diagnostic = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
    assert.equal(diagnostic.code, 'EVIDENCE_MISMATCH');
    assert.equal(diagnostic.persisted, false);
    assert.equal(diagnostic.paperId, paper.id);
    assert.equal(diagnostic.sourceSha256, paper.sha256);
    assert.equal(diagnostic.currentRevision, seeded.revision);
    assert.equal(diagnostic.totalIssues, 1);
    assert.deepEqual([diagnostic.issues[0].group, diagnostic.issues[0].index, diagnostic.issues[0].origin, diagnostic.issues[0].reason],
      ['components', 1, 'submitted', 'QUOTE_NOT_ON_PAGE']);
    assert.deepEqual(diagnostic.issues[0].repair, { tool: 'evolver_read_uploaded_paper', args: { paperId: paper.id, startPage: 2, endPage: 2 } });
    assert.equal(text.includes('Absent host quote for this paper.'), false);
    assert.deepEqual(workspaceState(root, paper.id), before);
    assert.equal(library.get(root, paper.id).components.length, 0);

    // Unrelated failures keep their own code through the same channel. A components publish on
    // a paper with NO Wiki is legal this round (WF-03), so the only remaining refusal here is an
    // empty collection with no reason — the code must reach the model verbatim, and the stale
    // `WIKI_REQUIRED` prerequisite must never come back.
    const fresh = library.import(root, 'fresh.md', Buffer.from('A second paper without any saved Wiki section yet.'), ['A second paper without any saved Wiki section yet.']);
    const unexplained = await runTool(harness, 'evolver_publish_paper_components', { paperId: fresh.id, baseRevision: 'null', components: [] });
    assert.equal(unexplained.isError, true);
    assert.equal(unexplained.error.info.code, 'NO_FINDINGS_REASON_REQUIRED');
    assert.match(unexplained.content[0].text, /NO_FINDINGS_REASON_REQUIRED/);
    assert.equal(unexplained.content[0].text.includes('WIKI_REQUIRED'), false, 'the Wiki prerequisite is lifted: /extract never requires one');
    assert.equal(unexplained.content[0].text.includes('EVIDENCE_MISMATCH'), false);
    assert.equal(library.get(root, fresh.id).components.length, 0, 'a refused empty publish leaves nothing stored');
    // The same paper publishes components fine once the empty-array case is out of the way.
    const direct = await runTool(harness, 'evolver_publish_paper_components',
      { paperId: fresh.id, baseRevision: 'null', components: [{ kind: 'Module', name: 'Second', description: 'd', page: 1, quote: 'A second paper without any saved Wiki section yet.' }] });
    assert.equal(direct.isError, false, 'WF-03: components publish without any Wiki');
    assert.equal(JSON.parse(direct.content[0].text).wikiSections, 0);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('publish tool descriptions document the locatable diagnostic and reread suggestion', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-diag-descriptions-'));
  try {
    const harness = hostHarness(root);
    for (const name of ['evolver_publish_paper_wiki', 'evolver_publish_paper_components', 'evolver_publish_paper_assets']) {
      const description: string = harness.definitions.get(name).description;
      assert.match(description, /EVIDENCE_MISMATCH/);
      assert.match(description, /index/);
      assert.match(description, /origin/);
      assert.match(description, /reread|re-read/);
    }
  } finally { fs.rmSync(root, { recursive: true }); }
});

/* ---------------------------------------------------------------------------------------------------
 * WP-G1: per-submission structural validation, components-only first publish and legal no_findings.
 * Fixtures reuse the self-authored page text above; no user research asset is read or written.
 * ------------------------------------------------------------------------------------------------- */

interface FreshAsset { root: string; workspace: string; library: PaperLibrary; paperId: string; sha256: string }
/** A paper that is imported but never published: stored sections=[] and components=[]. */
function freshAsset(prefix: string): FreshAsset {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const library = workspacePaperLibrary({ id: 'w', path: workspace, title: 'Project', sessionIds: ['s1'] });
  const paper = library.import(workspace, 'paper.md', Buffer.from(PAGES.join('\n')), PAGES);
  return { root, workspace, library, paperId: paper.id, sha256: paper.sha256 };
}

test('a components-only first publish accepts sections=[] and never writes a title-only Wiki Markdown', () => {
  const f = freshAsset('paper-g1-first-components-');
  try {
    assert.deepEqual(f.library.get(f.workspace, f.paperId).sections, []);
    const before = workspaceState(f.workspace, f.paperId);
    assert.equal(before.files.some((name) => name.endsWith('.md')), false);

    // An empty preserved field has no entries to check, so the diagnostic blames only the component.
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: null, title: 'Components only', sections: [],
      components: [{ ...COMPONENT_OK, quote: 'Absent component quote for a components-only publish.' }], submitted: 'components' }));
    assert.equal(failure.code, 'EVIDENCE_MISMATCH');
    assert.deepEqual(failure.diagnostic!.issues.map((issue) => [issue.group, issue.index, issue.origin]), [['components', 0, 'submitted']]);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);

    const published = f.library.publish(f.workspace, f.paperId, { baseRevision: null, title: 'Components only', sections: [], components: [COMPONENT_OK, COMPONENT_PAGE_TWO], submitted: 'components' });
    assert.ok(published.revision);
    assert.deepEqual(published.sections, []);
    assert.equal(published.components.length, 2);
    const stored = JSON.parse(fs.readFileSync(paperFile(f.workspace, f.paperId), 'utf8'));
    assert.deepEqual(stored.sections, []);
    assert.equal(stored.components.length, 2);
    assert.equal(stored.components[0].kind, 'Module');
    assert.equal(stored.revision, published.revision);
    // The version folder keeps exactly the same file list: sections=[] produced no Wiki Markdown.
    const after = workspaceState(f.workspace, f.paperId);
    assert.deepEqual(after.files, before.files);
    assert.equal(after.files.some((name) => name.endsWith('.md')), false);
    assert.equal(JSON.stringify(stored).includes('noFindingsReason'), false);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('an empty component collection with a reason is a legal no_findings result that advances the revision', () => {
  const fresh = freshAsset('paper-g1-no-findings-first-');
  const seeded = fixture('paper-g1-no-findings-seeded-');
  try {
    // First publication on a paper that never had a Wiki: sections stay [] and no Markdown appears.
    const before = workspaceState(fresh.workspace, fresh.paperId);
    const published = fresh.library.publish(fresh.workspace, fresh.paperId, { baseRevision: null, title: 'Nothing extractable', sections: [],
      components: [], submitted: 'components', noFindingsReason: 'Read all 3 pages of the declared scope; nothing is independently describable.' });
    assert.ok(published.revision);
    assert.deepEqual(published.sections, []);
    assert.deepEqual(published.components, []);
    const after = workspaceState(fresh.workspace, fresh.paperId);
    assert.deepEqual(after.files, before.files);
    assert.equal(after.files.some((name) => name.endsWith('.md')), false);
    const stored = JSON.parse(fs.readFileSync(paperFile(fresh.workspace, fresh.paperId), 'utf8'));
    assert.deepEqual(stored.sections, []);
    assert.deepEqual(stored.components, []);
    assert.equal('noFindingsReason' in stored, false);

    // A paper that already has a Wiki: the preserved sections survive verbatim.
    const storedSections = seeded.library.get(seeded.workspace, seeded.paperId).sections;
    const noFindings = seeded.library.publish(seeded.workspace, seeded.paperId, { baseRevision: seeded.revision, title: 'Evidence paper',
      sections: storedSections, components: [], submitted: 'components', noFindingsReason: 'No extractable component in the declared scope.' });
    assert.ok(noFindings.revision);
    assert.deepEqual(noFindings.sections, storedSections);
    assert.deepEqual(noFindings.components, []);
    assert.equal(noFindings.title, 'Evidence paper');
    // The revision is a pure function of {source, title, sections, components}: an unchanged triple
    // keeps the same revision, and the reason is never an input.
    assert.equal(noFindings.revision, seeded.revision);
    const repeat = seeded.library.publish(seeded.workspace, seeded.paperId, { baseRevision: noFindings.revision, title: 'Evidence paper',
      sections: storedSections, components: [], submitted: 'components', noFindingsReason: 'An entirely different reason text.' });
    assert.equal(repeat.revision, noFindings.revision);
    const unchangedState = workspaceState(seeded.workspace, seeded.paperId);
    assert.equal(unchangedState.files.some((name) => name.endsWith(`.wiki-${noFindings.revision}.md`)), true);
    assert.equal(JSON.parse(fs.readFileSync(paperFile(seeded.workspace, seeded.paperId), 'utf8')).sections.length, 1);
    assert.equal('noFindingsReason' in JSON.parse(fs.readFileSync(paperFile(seeded.workspace, seeded.paperId), 'utf8')), false);

    // Positive control: a real change to the triple moves the revision, and with sections present the
    // existing version-Markdown rule still runs (a title-only document is never produced).
    const retitled = seeded.library.publish(seeded.workspace, seeded.paperId, { baseRevision: noFindings.revision, title: 'Renamed paper',
      sections: storedSections, components: [], submitted: 'components', noFindingsReason: 'Same reason as before.' });
    assert.notEqual(retitled.revision, noFindings.revision);
    const retitledState = workspaceState(seeded.workspace, seeded.paperId);
    assert.equal(retitledState.files.some((name) => name.endsWith(`.wiki-${retitled.revision}.md`)), true);
    assert.match(fs.readFileSync(path.join(seeded.workspace, '.dsh', 'research', 'papers', `${seeded.paperId}.wiki-${retitled.revision}.md`), 'utf8'), /^# Renamed paper\n/);

    // The 2000-character bound is inclusive.
    const boundary = fresh.library.publish(fresh.workspace, fresh.paperId, { baseRevision: published.revision, title: 'Nothing extractable', sections: [],
      components: [], submitted: 'components', noFindingsReason: 'x'.repeat(2000) });
    assert.equal(boundary.revision, published.revision);
  } finally { fs.rmSync(fresh.root, { recursive: true }); fs.rmSync(seeded.root, { recursive: true }); }
});

test('an empty component collection without a usable reason is refused with zero byte changes', () => {
  const f = fixture('paper-g1-reason-required-');
  try {
    const storedSections = f.library.get(f.workspace, f.paperId).sections;
    const cases: { label: string; reason: unknown }[] = [
      { label: 'missing', reason: undefined },
      { label: 'not a string', reason: 42 },
      { label: 'empty', reason: '' },
      { label: 'whitespace only', reason: '   \n\t ' },
      { label: 'over the limit', reason: 'x'.repeat(2001) },
    ];
    for (const entry of cases) {
      const before = workspaceState(f.workspace, f.paperId);
      const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper',
        sections: storedSections, components: [], submitted: 'components', noFindingsReason: entry.reason as string | undefined }));
      assert.equal(failure.code, 'NO_FINDINGS_REASON_REQUIRED', entry.label);
      assert.equal(failure.diagnostic, undefined, entry.label);
      assert.deepEqual(workspaceState(f.workspace, f.paperId), before, entry.label);
    }
    assert.equal(f.library.get(f.workspace, f.paperId).revision, f.revision);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('an empty component collection cannot clear stored components (WF-11) and writes nothing', () => {
  const f = fixture('paper-g1-clear-refused-');
  try {
    const seeded = f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK], components: [COMPONENT_OK], submitted: 'components' });
    assert.equal(seeded.components.length, 1);
    // A real component update is still accepted; only the empty collection is refused.
    const updated = f.library.publish(f.workspace, f.paperId, { baseRevision: seeded.revision, title: 'Evidence paper', sections: [SECTION_OK], components: [COMPONENT_OK, COMPONENT_PAGE_TWO], submitted: 'components' });
    assert.equal(updated.components.length, 2);

    const before = workspaceState(f.workspace, f.paperId);
    const failure = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: updated.revision, title: 'Evidence paper', sections: [SECTION_OK],
      components: [], submitted: 'components', noFindingsReason: 'Nothing extractable in this scope.' }));
    assert.equal(failure.code, 'COMPONENT_CLEAR_REFUSED');
    assert.equal(failure.diagnostic, undefined);
    assert.match(failure.message, /2 stored component/);
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);
    const stored = f.library.get(f.workspace, f.paperId);
    assert.equal(stored.components.length, 2);
    assert.equal(stored.revision, updated.revision);
    assert.deepEqual(stored.components.map((component) => component.name), ['Boundary loss', 'Encoder baseline']);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});

test('submission types keep their own bounds: wiki preserves components, whole-asset still requires sections', () => {
  const f = fixture('paper-g1-bounds-');
  try {
    const withComponents = f.library.publish(f.workspace, f.paperId, { baseRevision: f.revision, title: 'Evidence paper', sections: [SECTION_OK], components: [COMPONENT_OK, COMPONENT_PAGE_TWO], submitted: 'components' });
    const updatedWiki = f.library.publish(f.workspace, f.paperId, { baseRevision: withComponents.revision, title: 'Updated evidence paper', sections: [SECTION_OK, SECTION_PAGE_TWO], components: withComponents.components, submitted: 'wiki' });
    assert.equal(updatedWiki.sections.length, 2);
    assert.deepEqual(updatedWiki.components, withComponents.components);
    assert.equal(updatedWiki.title, 'Updated evidence paper');

    const before = workspaceState(f.workspace, f.paperId);
    const revision = updatedWiki.revision!;
    // The whole-asset contract is unchanged, whether `submitted` says 'all' or is omitted entirely.
    const wholeAsset = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: revision, title: 'Whole asset', sections: [], components: [COMPONENT_OK], submitted: 'all' }));
    assert.equal(wholeAsset.code, 'INVALID_EXTRACTION');
    const defaulted = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: revision, title: 'Whole asset', sections: [], components: [COMPONENT_OK] }));
    assert.equal(defaulted.code, 'INVALID_EXTRACTION');
    const wikiWithoutSections = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: revision, title: 'Wiki', sections: [], components: [], submitted: 'wiki' }));
    assert.equal(wikiWithoutSections.code, 'INVALID_EXTRACTION');
    const tooManySections = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: revision, title: 'Components', sections: Array.from({ length: 41 }, () => SECTION_OK), components: [COMPONENT_OK], submitted: 'components' }));
    assert.equal(tooManySections.code, 'INVALID_EXTRACTION');
    const tooManyComponents = rejectionOf(() => f.library.publish(f.workspace, f.paperId, { baseRevision: revision, title: 'Components', sections: [], components: Array.from({ length: 81 }, () => COMPONENT_OK), submitted: 'components' }));
    assert.equal(tooManyComponents.code, 'INVALID_EXTRACTION');
    assert.deepEqual(workspaceState(f.workspace, f.paperId), before);

    // A non-empty collection ignores `noFindingsReason` instead of failing on it.
    const ignored = f.library.publish(f.workspace, f.paperId, { baseRevision: revision, title: 'Components', sections: [SECTION_OK], components: [COMPONENT_OK], submitted: 'components', noFindingsReason: 42 as never });
    assert.equal(ignored.components.length, 1);
    assert.equal('noFindingsReason' in ignored, false);
  } finally { fs.rmSync(f.root, { recursive: true }); }
});
