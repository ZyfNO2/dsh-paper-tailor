import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { PaperLibrary, type PublishInput } from '../../evolver/src/application/paper-library.ts';
import { PaperCommandRunStore } from '../../evolver/src/application/paper-command-runs.ts';
import { ResearchBootstrapGraphService } from '../../evolver/src/application/research-bootstrap-graph-service.ts';
import { type BootstrapSourceResolver } from '../../evolver/src/contracts/research-bootstrap.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';
import { legacyScope } from './legacy-domain.ts';
import { initializeActiveStore } from './active-store.ts';

export function workspacePaperLibrary(workspace: string) {
  workspace = fs.realpathSync(workspace);
  const { store } = legacyScope(workspace);
  const root = path.join(store.workspaceRoot, '.dsh/research/papers');
  if (fs.existsSync(root)) {
    const relative = path.relative(workspace, fs.realpathSync(root));
    if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(root).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'paper library redirects outside its storage scope');
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (/^paper-[0-9a-f]{64}\.(json|source)$/.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'paper assets must be regular files');
      if (fs.statSync(path.join(root, entry.name)).size > 25 * 1024 * 1024) throw new ResearchCoreError('QUOTA', 'paper asset exceeds 25 MiB');
    }
  }
  return new PaperLibrary(root, workspace);
}
export function workspacePaperResolver(workspace: string): BootstrapSourceResolver {
  workspace = fs.realpathSync(workspace);
  const library = workspacePaperLibrary(workspace);
  const papers = library.list(workspace);
  return { getPaper(paperId) {
    const paper = papers.find((p) => p.id === paperId);
    return paper ? { paperId: paper.id, sourceSha256: paper.sha256, revision: paper.revision, title: paper.title, sections: paper.sections, components: paper.components } : null;
  } };
}
export function paperLibraryProjection(workspace: string) {
  workspace = fs.realpathSync(workspace);
  const { store } = legacyScope(workspace), library = workspacePaperLibrary(workspace);
  return { schemaVersion: 2, scope: 'workspace-files', workspace: { id: workspace, title: path.basename(workspace) },
    papers: library.list(workspace).map(({ pages, owner: _owner, ...paper }) => ({ ...paper, pageCount: pages.length })),
    runs: new PaperCommandRunStore(store.workspaceRoot).list().slice(0, 10) };
}
export function readWorkspacePaper(workspace: string, paperId: string, original = false) {
  workspace = fs.realpathSync(workspace);
  const library = workspacePaperLibrary(workspace), paper = library.get(workspace, paperId);
  if (!original) return { json: { ...paper, owner: undefined, status: 'provisional', boundary: '论文抽取不是本地实验；原文引用需人工核对。' } };
  const originalFile = library.original(workspace, paperId), stat = fs.lstatSync(originalFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'paper source must be a regular file');
  const bytes = fs.readFileSync(originalFile);
  // get() validates the JSON; verify the original bytes too before a download.
  if (createHash('sha256').update(bytes).digest('hex') !== paper.sha256) throw new ResearchCoreError('STATE_CORRUPT', 'paper source hash changed');
  return { bytes, filename: paper.name, mediaType: 'application/octet-stream' };
}
async function paperPages(bytes: Buffer, filename: string): Promise<string[]> {
  if (/\.(txt|md)$/i.test(filename)) return [new TextDecoder('utf-8', { fatal: true }).decode(bytes)];
  if (!/\.pdf$/i.test(filename) || bytes.subarray(0, 5).toString() !== '%PDF-') throw new ResearchCoreError('INVALID_INPUT', 'only UTF-8 TXT/Markdown or PDF sources are accepted');
  const modulePath = process.env.RESEARCH_PDFJS_MODULE;
  if (!modulePath || !path.isAbsolute(modulePath)) throw new ResearchCoreError('INVALID_INPUT', 'PDF_PARSER_UNAVAILABLE: configure an absolute RESEARCH_PDFJS_MODULE path');
  const pdfjs = await import(pathToFileURL(modulePath).href);
  const loading = pdfjs.getDocument({ data: Uint8Array.from(bytes), isEvalSupported: false, useSystemFonts: true });
  try {
    const document = await loading.promise;
    if (document.numPages > 300) throw new ResearchCoreError('QUOTA', 'PDF exceeds 300 pages');
    const pages: string[] = []; let characters = 0;
    for (let n = 1; n <= document.numPages; n++) {
      const page = await document.getPage(n), text = await page.getTextContent();
      const content = text.items.map((item: { str?: string; hasEOL?: boolean }) => `${item.str ?? ''}${item.hasEOL ? '\n' : ' '}`).join('').trim();
      characters += content.length;
      if (characters > 2_000_000) throw new ResearchCoreError('QUOTA', 'PDF text exceeds 2 million characters');
      pages.push(content);
    }
    return pages;
  } finally { await loading.destroy(); }
}
/** Same launcher-owned parser for library import and repository takeover. */
export function configuredWorkspacePdfReader() {
  return process.env.RESEARCH_PDFJS_MODULE ? (bytes: Uint8Array, filename: string) => paperPages(Buffer.from(bytes), filename) : undefined;
}
export async function paperLibraryAction(workspace: string, value: Record<string, unknown>) {
  workspace = fs.realpathSync(workspace);
  const { readOnly } = legacyScope(workspace);
  if (readOnly) throw new ResearchCoreError('INVALID_INPUT', 'MIGRATION_REQUIRED: paper writes require an active store');
  const allowed = value.action === 'import' ? ['action', 'filename', 'contentBase64'] : value.action === 'publish' ? ['action', 'paperId', 'input'] : [];
  if (!allowed.length || Object.keys(value).some((key) => !allowed.includes(key))) throw new ResearchCoreError('INVALID_INPUT', 'invalid paper action envelope; workspace and identity are transport-owned');
  if (value.action === 'import') {
    if (typeof value.filename !== 'string' || !value.filename.trim() || value.filename.length > 300 || /[\\/\x00-\x1f]/.test(value.filename)) throw new ResearchCoreError('INVALID_INPUT', 'invalid paper filename');
    if (typeof value.contentBase64 !== 'string' || value.contentBase64.length > 14_000_000) throw new ResearchCoreError('QUOTA', 'paper transport accepts at most 10 MiB');
    const bytes = Buffer.from(value.contentBase64, 'base64');
    if (bytes.toString('base64') !== value.contentBase64 || !bytes.length || bytes.length > 10 * 1024 * 1024) throw new ResearchCoreError('INVALID_INPUT', 'invalid canonical base64 or source size');
    const pages = await paperPages(bytes, value.filename);
    initializeActiveStore(workspace);
    return workspacePaperLibrary(workspace).import(workspace, value.filename, bytes, pages);
  }
  if (typeof value.paperId !== 'string' || !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) throw new ResearchCoreError('INVALID_INPUT', 'paperId/input required');
  const library = workspacePaperLibrary(workspace), input = value.input as unknown as PublishInput;
  return library.publish(workspace, value.paperId, input);
}
export function paperResearchEvidence(workspace: string, researchId: string) {
  return new ResearchBootstrapGraphService(legacyScope(workspace).store, { resolver: workspacePaperResolver(workspace) }).assessResearchEvidence(researchId);
}
