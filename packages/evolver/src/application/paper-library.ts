import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type { LibraryPaper, PaperSection, PaperComponent } from '../contracts/paper-library.ts';
export type { LibraryPaper, PaperSection, PaperComponent } from '../contracts/paper-library.ts';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Evidence bounds; the strict acceptance check and the diagnostic path read the same constants. */
const QUOTE_MIN_CHARS = 12;
const QUOTE_MAX_CHARS = 2000;
const LABEL_MAX_CHARS = 300;
const CONTENT_MAX_CHARS = 6000;
/** Diagnostics are bounded: at most 10 listed issues and 3 strictly matching candidate pages. */
const MAX_LISTED_ISSUES = 10;
const MAX_CANDIDATE_PAGES = 3;
const MAX_DIAGNOSTIC_LABEL_CHARS = 120;
const COMPONENT_KINDS: readonly string[] = ['Baseline', 'Method', 'Module', 'Experiment'];
/** Structural bounds per submission type; the whole-asset tool keeps its original contract unchanged. */
const SECTION_MAX_ITEMS = 40;
const COMPONENT_MAX_ITEMS = 80;
/** A `no_findings` reason is command-result metadata: it never enters the revision formula or the paper. */
const NO_FINDINGS_REASON_MAX_CHARS = 2000;

export type EvidenceGroup = 'sections' | 'components';
/** `submitted` = field changed by this publish call; `preserved` = the other field carried over untouched. */
export type EvidenceOrigin = 'submitted' | 'preserved';
export type EvidenceField = 'quote' | 'page' | 'label' | 'content' | 'kind';
export type EvidenceReason =
  | 'PAGE_OUT_OF_RANGE'
  | 'QUOTE_NOT_STRING'
  | 'QUOTE_TOO_SHORT'
  | 'QUOTE_TOO_LONG'
  | 'QUOTE_NOT_ON_PAGE'
  | 'INVALID_LABEL'
  | 'INVALID_CONTENT'
  | 'INVALID_COMPONENT_KIND';

/** Where a rejected item can be re-read. Carries no path, no replacement quote and no paper text. */
export interface EvidenceRepair {
  tool: 'evolver_read_uploaded_paper';
  args: { paperId: string; startPage?: number; endPage?: number };
  note?: string;
}
export interface EvidenceIssue {
  group: EvidenceGroup;
  /** Zero-based index into the complete `sections` or `components` array, never a merged index. */
  index: number;
  origin: EvidenceOrigin;
  /** Bounded heading/name for orientation; never the summary, the quote or the page text. */
  label: string;
  field: EvidenceField;
  page: number | null;
  reason: EvidenceReason;
  /** Diagnostic only: pages whose authoritative text strictly contains the normalized quote (≤3). */
  candidatePages?: number[];
  repair: EvidenceRepair;
}
/** Serializable diagnostic that survives the DSH tool-error channel as text plus a stable code. */
export interface EvidenceDiagnostic {
  code: 'EVIDENCE_MISMATCH';
  paperId: string;
  sourceSha256: string;
  currentRevision: string | null;
  persisted: false;
  pageCount: number;
  totalIssues: number;
  truncated?: true;
  truncatedNote?: string;
  issues: EvidenceIssue[];
}

/** Application-layer failure with a stable code and, for reference failures, a locatable diagnostic. */
export class PaperLibraryError extends Error {
  readonly code: string;
  readonly diagnostic?: EvidenceDiagnostic;
  constructor(code: string, detail?: string, diagnostic?: EvidenceDiagnostic) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'PaperLibraryError';
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

/** Which publish input this call owns; the other field is carried over and reported as `preserved`. */
export type PublishSubmission = 'wiki' | 'components' | 'all';
export interface PublishInput {
  baseRevision: string | null;
  title: string;
  sections: PaperSection[];
  components: PaperComponent[];
  /**
   * Declares which field this call owns. `wiki`/`components` mark that field submitted and the other
   * preserved. `all` (the default, for whole-asset callers) reports each item as it really is: an item
   * identical to the stored one at the same index was carried over, so it is reported `preserved`
   * rather than blamed as a new submission.
   */
  submitted?: PublishSubmission;
  /**
   * Required only when `submitted: 'components'` publishes an empty component collection: it records
   * the evidence-backed reason the declared reading scope yielded nothing extractable. Non-empty,
   * at most 2000 characters, and never persisted into the paper or the revision formula — the command
   * result channel owns it.
   */
  noFindingsReason?: string;
}

interface SubmissionEntry {
  group: EvidenceGroup;
  index: number;
  origin: EvidenceOrigin;
  page: unknown;
  quote: unknown;
  content: unknown;
  label: unknown;
  kind: unknown;
  hasKind: boolean;
}
interface EvidenceCheck { reason: EvidenceReason; field: EvidenceField; page: number | null; candidatePages?: number[] }

/** The offending page as reported, or null when the value is not a finite number. */
const shownPage = (page: unknown): number | null => typeof page === 'number' && Number.isFinite(page) ? page : null;

/** Structural equality of two submitted items, independent of property order. */
function sameItem(left: unknown, right: unknown): boolean {
  if (left === undefined || right === undefined) return false;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return JSON.stringify(left) === JSON.stringify(right);
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) return false;
  return true;
}

/**
 * Diagnostic-only search for pages that strictly contain the normalized quote.
 * Never participates in acceptance: a quote is accepted only by `evidenceCheck`.
 */
function strictCandidatePages(pages: string[], needle: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < pages.length && found.length < MAX_CANDIDATE_PAGES; index++) {
    if (normalize(pages[index]).includes(needle)) found.push(index + 1);
  }
  return found;
}

/** The single strict evidence rule, unchanged: whitespace-only normalization, bounds, exact page text. */
function evidenceCheck(page: unknown, quote: unknown, pages: string[]): EvidenceCheck | undefined {
  const shown = shownPage(page);
  if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > pages.length) return { reason: 'PAGE_OUT_OF_RANGE', field: 'page', page: shown };
  if (typeof quote !== 'string') return { reason: 'QUOTE_NOT_STRING', field: 'quote', page: shown };
  const needle = normalize(quote);
  if (needle.length < QUOTE_MIN_CHARS) return { reason: 'QUOTE_TOO_SHORT', field: 'quote', page: shown };
  if (quote.length > QUOTE_MAX_CHARS) return { reason: 'QUOTE_TOO_LONG', field: 'quote', page: shown };
  if (!normalize(pages[(page as number) - 1]).includes(needle)) {
    return { reason: 'QUOTE_NOT_ON_PAGE', field: 'quote', page: shown, candidatePages: strictCandidatePages(pages, needle) };
  }
  return undefined;
}

/**
 * Which origin to report. A field this call does not own is `preserved`; a whole-asset call reports
 * each item by whether it actually changed, so a carried-over item is never blamed as a submission.
 */
function originFor(group: EvidenceGroup, submission: PublishSubmission, item: unknown, stored: unknown): EvidenceOrigin {
  if (submission === 'wiki') return group === 'sections' ? 'submitted' : 'preserved';
  if (submission === 'components') return group === 'components' ? 'submitted' : 'preserved';
  return sameItem(item, stored) ? 'preserved' : 'submitted';
}

function submissionEntry(group: EvidenceGroup, index: number, submission: PublishSubmission, item: unknown, stored: unknown): SubmissionEntry {
  const record = typeof item === 'object' && item !== null ? item as Record<string, unknown> : undefined;
  return {
    group, index, origin: originFor(group, submission, item, stored),
    page: record?.page, quote: record?.quote, kind: record?.kind,
    label: record !== undefined && 'heading' in record ? record.heading : record?.name,
    content: record !== undefined && 'summary' in record ? record.summary : record?.description,
    hasKind: record !== undefined && 'kind' in record,
  };
}

function diagnosticLabel(label: unknown): string {
  if (typeof label !== 'string') return label === undefined ? '' : `(non-string ${typeof label} label)`;
  return label.length > MAX_DIAGNOSTIC_LABEL_CHARS ? `${label.slice(0, MAX_DIAGNOSTIC_LABEL_CHARS)}…` : label;
}

/** A legal re-read suggestion; an unusable page never yields an illegal range. */
function repairFor(paperId: string, page: number | null, pageCount: number): EvidenceRepair {
  if (page === null || !Number.isInteger(page) || page < 1 || page > pageCount) {
    const described = page === null ? 'the supplied page is not a usable page number' : `page ${page} is outside the readable range`;
    return { tool: 'evolver_read_uploaded_paper', args: { paperId },
      note: `${described}; this paper has ${pageCount} extracted page(s), so re-read pages 1–${pageCount} (at most 10 per read) to copy the exact source text` };
  }
  return { tool: 'evolver_read_uploaded_paper', args: { paperId, startPage: page, endPage: page } };
}

function evidenceMessage(issues: EvidenceIssue[], itemCount: number): string {
  const listed = issues.slice(0, 3).map((issue) => {
    const label = issue.label ? ` "${normalize(issue.label)}"` : '';
    return `${issue.group}[${issue.index}]${label} ${issue.reason}${issue.page === null ? '' : ` page ${issue.page}`} (${issue.origin})`;
  }).join('; ');
  const more = issues.length > 3 ? `; +${issues.length - 3} more` : '';
  // The `PaperLibraryError` constructor already prefixes the code, so the detail starts with the count.
  return `${issues.length} of ${itemCount} candidate items failed strict evidence validation; nothing was persisted (persisted=false); ${listed}${more}. Re-read the cited pages and resubmit the complete collection.`;
}

/**
 * Minimal shared validation for one publish attempt. Returns undefined only when every item in
 * both groups passes the unchanged strict rules; otherwise it describes each failing item once.
 */
function evidenceDiagnostic(paper: LibraryPaper, input: PublishInput, submission: PublishSubmission): EvidenceDiagnostic | undefined {
  const pages = paper.pages;
  const entries: SubmissionEntry[] = [
    ...(Array.isArray(input.sections) ? input.sections : []).map((item, index) => submissionEntry('sections', index, submission, item, paper.sections[index])),
    ...(Array.isArray(input.components) ? input.components : []).map((item, index) => submissionEntry('components', index, submission, item, paper.components[index])),
  ];
  const issues: EvidenceIssue[] = [];
  for (const entry of entries) {
    let check = evidenceCheck(entry.page, entry.quote, pages);
    // Content checks run only after the citation itself is valid, exactly as the single strict rule did.
    if (check === undefined) {
      if (typeof entry.content !== 'string' || !entry.content.trim() || entry.content.length > CONTENT_MAX_CHARS) check = { reason: 'INVALID_CONTENT', field: 'content', page: shownPage(entry.page) };
      else if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > LABEL_MAX_CHARS) check = { reason: 'INVALID_LABEL', field: 'label', page: shownPage(entry.page) };
      else if (entry.hasKind && !COMPONENT_KINDS.includes(entry.kind as string)) check = { reason: 'INVALID_COMPONENT_KIND', field: 'kind', page: shownPage(entry.page) };
    }
    if (check === undefined) continue;
    const issue: EvidenceIssue = { group: entry.group, index: entry.index, origin: entry.origin, label: diagnosticLabel(entry.label),
      field: check.field, page: check.page, reason: check.reason, repair: repairFor(paper.id, check.page, pages.length) };
    if (check.candidatePages !== undefined) issue.candidatePages = check.candidatePages;
    issues.push(issue);
  }
  if (!issues.length) return undefined;
  const diagnostic: EvidenceDiagnostic = { code: 'EVIDENCE_MISMATCH', paperId: paper.id, sourceSha256: paper.sha256,
    currentRevision: paper.revision, persisted: false, pageCount: pages.length, totalIssues: issues.length, issues: issues.slice(0, MAX_LISTED_ISSUES) };
  if (issues.length > MAX_LISTED_ISSUES) {
    diagnostic.truncated = true;
    diagnostic.truncatedNote = `listing the first ${MAX_LISTED_ISSUES} of ${issues.length} issues; repair the listed items and re-read the cited pages before resubmitting the complete collection`;
  }
  return diagnostic;
}

/** Durable structured assets; workspace layout is the production source of truth. */
export class PaperLibrary {
  readonly root: string;
  private readonly workspaceOwner?: string;
  constructor(root: string, workspaceOwner?: string) { this.root = path.resolve(root); this.workspaceOwner = workspaceOwner; }
  private folder(owner: string): string {
    if (typeof owner !== 'string' || !owner.trim()) throw new PaperLibraryError('OWNER_REQUIRED', 'missing session identity');
    if (this.workspaceOwner !== undefined) {
      if (owner !== this.workspaceOwner) throw new PaperLibraryError('OWNER_MISMATCH', 'workspace identity differs');
      return this.root;
    }
    return path.join(this.root, hash(owner));
  }
  private file(owner: string, id: string): string {
    if (!/^paper-[a-f0-9]{64}$/.test(id)) throw new PaperLibraryError('INVALID_PAPER_ID');
    return path.join(this.folder(owner), `${id}.json`);
  }
  private commit(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, file);
  }
  list(owner: string): LibraryPaper[] {
    const folder = this.folder(owner);
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter((f) => /^paper-[a-f0-9]{64}\.json$/.test(f)).map((f) => this.get(owner, f.slice(0, -5)));
  }
  get(owner: string, id: string): LibraryPaper {
    const value = JSON.parse(fs.readFileSync(this.file(owner, id), 'utf8')) as LibraryPaper;
    if (value.owner !== owner || value.id !== id) throw new PaperLibraryError('OWNER_MISMATCH', 'stored paper identity differs');
    const bytes = fs.readFileSync(this.original(owner, id));
    if (hash(bytes) !== value.sha256) throw new PaperLibraryError('SOURCE_CORRUPT', 'uploaded bytes changed');
    return value;
  }
  original(owner: string, id: string): string { return this.file(owner, id).replace(/\.json$/, '.source'); }
  import(owner: string, name: string, bytes: Uint8Array, pages: string[]): LibraryPaper {
    if (bytes.byteLength > 25 * 1024 * 1024 || !bytes.byteLength) throw new PaperLibraryError('SOURCE_SIZE', 'accepts nonempty files up to 25 MiB');
    if (!pages.length || pages.length > 300 || !pages.some((p) => p.trim())) throw new PaperLibraryError('TEXT_MISSING', 'no readable text (scanned PDF requires OCR); accepts up to 300 pages');
    if (pages.join('').length > 2_000_000) throw new PaperLibraryError('SOURCE_SIZE', 'extracted text exceeds 2 million characters');
    const sha256 = hash(bytes), id = `paper-${sha256}`;
    const file = this.file(owner, id);
    if (fs.existsSync(file)) return this.get(owner, id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(this.original(owner, id), bytes);
    const value: LibraryPaper = { id, owner, name: path.basename(name), sha256, pages, importedAt: new Date().toISOString(), revision: null,
      title: path.basename(name), sections: [], components: [], updatedAt: null };
    this.commit(file, value); return value;
  }
  publish(owner: string, id: string, input: PublishInput): LibraryPaper {
    const paper = this.get(owner, id);
    if (input.baseRevision !== paper.revision) throw new PaperLibraryError('REVISION_CONFLICT', 'read current revision before publishing');
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 500) throw new PaperLibraryError('INVALID_TITLE');
    const submission: PublishSubmission = input.submitted === 'wiki' || input.submitted === 'components' ? input.submitted : 'all';
    // Structural bounds follow the declared submission type: a components publish owns `components`
    // and merely carries the stored sections, so an empty preserved sections array is legal there
    // while the whole-asset contract keeps requiring 1–40 sections.
    const sections = input.sections;
    const components = input.components;
    const sectionsValid = Array.isArray(sections) && sections.length <= SECTION_MAX_ITEMS && (submission === 'components' || sections.length >= 1);
    const componentsValid = Array.isArray(components) && components.length <= COMPONENT_MAX_ITEMS;
    if (!sectionsValid || !componentsValid) throw new PaperLibraryError('INVALID_EXTRACTION', submission === 'components' ? 'requires 0–40 preserved Wiki sections and 0–80 components' : 'requires 1–40 Wiki sections and 0–80 components');
    // A zero-component `components` publish is only a legal `no_findings` result with an explicit
    // reason; without it the empty array is an unexplained wipe, not a result.
    const noFindings = submission === 'components' && components.length === 0;
    const noFindingsReason = input.noFindingsReason;
    if (noFindings) {
      // WF-11 comes first: refusing to clear stored components is the more specific and more
      // actionable reason, and it is true whether or not a reason was supplied. Reporting
      // NO_FINDINGS_REASON_REQUIRED instead would send the Agent off to add a reason and
      // retry a submission that must never succeed this round.
      if (paper.components.length > 0) {
        throw new PaperLibraryError('COMPONENT_CLEAR_REFUSED', `${paper.components.length} stored component(s) would be cleared; an explicit user deletion request is required`);
      }
      if (typeof noFindingsReason !== 'string' || !noFindingsReason.trim() || noFindingsReason.length > NO_FINDINGS_REASON_MAX_CHARS) {
        throw new PaperLibraryError('NO_FINDINGS_REASON_REQUIRED', `an empty component collection requires a non-empty reason of at most ${NO_FINDINGS_REASON_MAX_CHARS} characters`);
      }
    }
    // Every strict check completes before any write: a rejected publish leaves the workspace bytes untouched.
    const diagnostic = evidenceDiagnostic(paper, input, submission);
    if (diagnostic !== undefined) throw new PaperLibraryError('EVIDENCE_MISMATCH', evidenceMessage(diagnostic.issues, diagnostic.totalIssues), diagnostic);
    // `noFindingsReason` is deliberately absent here: the joint revision covers exactly these three parts.
    const revision = hash(JSON.stringify({ source: paper.sha256, title: input.title, sections, components }));
    const next = { ...paper, title: input.title, sections, components, revision, updatedAt: new Date().toISOString() };
    // A components-only publish keeps the stored title, and with no sections there is no Wiki: writing a
    // title-only Markdown would present an empty document as an evidence-backed Wiki. Historical version
    // files are never rewritten or deleted.
    if (sections.length > 0) {
      const wiki = `# ${input.title}\n\n状态：论文抽取草稿，未经实验验证。\n来源 SHA256：${paper.sha256}\n版本：${revision}\n\n` + sections.map((s) => `## ${s.heading}\n\n${s.summary}\n\n来源：第 ${s.page} 页\n> ${s.quote.replace(/\n/g, '\n> ')}\n`).join('\n');
      // Publish immutable Markdown before committing the authoritative revision pointer.
      const wikiFile = path.join(this.folder(owner), `${id}.wiki-${revision}.md`);
      if (!fs.existsSync(wikiFile)) fs.writeFileSync(wikiFile, wiki, { flag: 'wx' });
    }
    this.commit(this.file(owner, id), next); return next;
  }
}
