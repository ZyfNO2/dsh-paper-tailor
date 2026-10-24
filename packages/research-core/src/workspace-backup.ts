import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { activeStore } from './active-store.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';
import { validateBootstrapState, emptyBootstrapState } from '../../evolver/src/contracts/research-bootstrap.ts';
import { validateCycleState } from '../../evolver/src/contracts/research-cycle.ts';
import { ResearchBootstrapStore } from '../../evolver/src/application/research-bootstrap-store.ts';
import { readLegacyWorkbench } from './legacy-domain.ts';
import { decodeSearchAttempts, validateSearchSnapshot } from './legacy-search.ts';

export const BACKUP_LIMITS = { files: 4096, bytes: 64 * 1024 * 1024, jsonBytes: 96 * 1024 * 1024 } as const;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fail(message: string): never { throw new ResearchCoreError('INVALID_INPUT', message); }
interface BackupFile { file: string; bytes: number; sha256: string; contentBase64: string }
export interface ResearchAssetBackup { schemaVersion: 1; kind: 'dsh-research-assets'; createdAt: string; sourceWorkspace: string; inventoryHash: string; files: BackupFile[] }
const metadata = (files: BackupFile[]) => files.map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }));
function assetPath(file: string) {
  if (!(file.startsWith('.research/') || file.startsWith('.dsh/research/')) || file.length > 700 || file.includes('\\')) fail('backup file is outside managed research assets');
  const parts = file.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\x00-\x1f<>:"|?*]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('unsafe or nonportable backup path');
  if (parts.some(part => part === '.writer.lock' || /\.tmp$/.test(part))) throw new ResearchCoreError('HOST_BUSY', 'Research writer lock or unfinished temporary file exists; finish/recover the operation before backup');
  return file;
}
function snapshot(workspace: string): BackupFile[] {
  const files: BackupFile[] = []; let bytes = 0;
  const visit = (relative: string) => {
    const file = path.join(workspace, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'Research backups do not follow links');
    if (stat.isDirectory()) { for (const entry of fs.readdirSync(file).sort()) visit(`${relative}/${entry}`); return; }
    if (!stat.isFile()) fail('backup cannot include special files');
    assetPath(relative); bytes += stat.size;
    if (files.length >= BACKUP_LIMITS.files || bytes > BACKUP_LIMITS.bytes) throw new ResearchCoreError('QUOTA', 'Research backup exceeds 4096 files or 64 MiB');
    const content = fs.readFileSync(file); if (content.length !== stat.size) throw new ResearchCoreError('REVISION_CONFLICT', 'research file changed during backup');
    files.push({ file: relative, bytes: content.length, sha256: hash(content), contentBase64: content.toString('base64') });
  };
  try { if (fs.lstatSync(path.join(workspace, '.dsh')).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'legacy asset ancestor is a link'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const root of ['.research', '.dsh/research']) if (fs.existsSync(path.join(workspace, root))) {
    // Also reject links in the .dsh ancestor rather than following them into an unrelated project.
    if (root.startsWith('.dsh/') && fs.lstatSync(path.join(workspace, '.dsh')).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'legacy assets ancestor is a link');
    visit(root);
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}
function authoritativeState(files: BackupFile[]) {
  const entry = files.find(file => file.file === '.research/active-store.json');
  if (!entry) fail('An active standalone project is required; migrate old/prototype assets before backup');
  const selector = JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8'));
  if (Object.keys(selector).some(key => !['schemaVersion', 'kind', 'root', 'migrationId', 'sourceInventoryHash'].includes(key)) || selector.schemaVersion !== 1 || selector.kind !== 'bootstrap' || selector.root !== '.research/compat' || !(selector.migrationId === null || typeof selector.migrationId === 'string' && /^migration-[0-9a-f-]{36}$/.test(selector.migrationId)) || !(selector.sourceInventoryHash === null || typeof selector.sourceInventoryHash === 'string' && /^[0-9a-f]{64}$/.test(selector.sourceInventoryHash)) || (selector.migrationId === null) !== (selector.sourceInventoryHash === null)) fail('invalid active store in research backup');
  const prefix = '.research/compat/.dsh/research/';
  const stateFile = files.find(file => file.file === `${prefix}bootstrap/state.json`);
  const state = stateFile ? validateBootstrapState(JSON.parse(Buffer.from(stateFile.contentBase64, 'base64').toString('utf8'))) : emptyBootstrapState();
  const byPath = new Map(files.map(file => [file.file, file]));
  const requireHash = (relative: string, sha256: string) => { if (byPath.get(relative)?.sha256 !== sha256) throw new ResearchCoreError('STATE_CORRUPT', `Missing or corrupt referenced backup asset: ${relative}`); };
  for (const paperEntry of files.filter(file => new RegExp(`^${prefix.replaceAll('.', '\\.')}papers/paper-[a-f0-9]{64}\\.json$`).test(file.file))) {
    const paper = JSON.parse(Buffer.from(paperEntry.contentBase64, 'base64').toString('utf8'));
    if (paper.id !== path.posix.basename(paperEntry.file, '.json') || paper.id !== `paper-${paper.sha256}` || typeof paper.owner !== 'string' || !paper.owner.trim() || !Array.isArray(paper.pages) || paper.pages.some((page: unknown) => typeof page !== 'string') || !Array.isArray(paper.sections) || !Array.isArray(paper.components)) throw new ResearchCoreError('STATE_CORRUPT', 'Invalid backup paper identity/text structure');
    requireHash(paperEntry.file.replace(/\.json$/, '.source'), paper.sha256);
  }
  // This is a quiescent backup, not process checkpointing. Never turn an active assignment into a completed/restored process.
  for (const research of state.researches) {
    for (const run of research.general?.externalLoop?.runs ?? []) for (const sha256 of [run.manifestSha256, run.metricsSha256]) requireHash(`.research/artifacts/${sha256}`, sha256);
    for (const source of research.general?.sources ?? []) { requireHash(`${prefix}materials/raw/${source.sha256}`, source.sha256); requireHash(`${prefix}materials/parsed/${source.parsedSha256}`, source.parsedSha256); }
    for (const entry of research.general?.knowledge ?? []) for (const claim of entry.claims ?? []) for (const locator of claim.locators) if (locator.kind === 'pdf') {
      const relative = `${prefix}materials/pdf-pages/${locator.pagesSha256}`; requireHash(relative, locator.pagesSha256);
      const extracted = JSON.parse(Buffer.from(byPath.get(relative)!.contentBase64, 'base64').toString('utf8')), source = research.general!.sources.find(source => source.sourceId === locator.sourceId);
      const page = extracted.pages?.[locator.page - 1], normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
      if (!source || source.sha256 !== locator.sourceSha256 || extracted.sourceSha256 !== source.sha256 || typeof page !== 'string' || !normalize(page).includes(normalize(locator.quote))) throw new ResearchCoreError('STATE_CORRUPT', `PDF knowledge locator does not match its pinned page asset: ${entry.entryId}`);
    }
    const searchRoot = `${prefix}foundation-assets/${research.researchId}/`, attemptsRoot = `${searchRoot}search-attempts/`;
    const attempts = decodeSearchAttempts(files.filter(file => file.file.startsWith(attemptsRoot)).map(file => ({ name: file.file.slice(attemptsRoot.length), bytes: Buffer.from(file.contentBase64, 'base64') })), research.researchId);
    for (const attempt of attempts) {
      if (attempt.status === 'running') throw new ResearchCoreError('HOST_BUSY', 'Finish or explicitly cancel an unfinished search before asset backup/restore');
      if (attempt.result) {
        const snapshot = byPath.get(`${searchRoot}searches/${attempt.result.snapshotId}.json`);
        if (!snapshot) throw new ResearchCoreError('STATE_CORRUPT', 'Missing referenced literature search snapshot');
        validateSearchSnapshot(attempt, Buffer.from(snapshot.contentBase64, 'base64'));
      }
    }
    if (research.foundations) {
      const root = `${prefix}foundation-assets/${research.researchId}`;
      for (const job of research.foundations.jobs) for (const artifact of job.artifacts) requireHash(`${root}/${job.jobId}/${artifact.name}`, artifact.sha256);
      for (const figure of research.foundations.figures) for (const artifact of figure.files) requireHash(`${root}/figures/${figure.figureId}/${artifact.name}`, artifact.sha256);
      for (const analysis of research.foundations.analyses) for (const artifact of analysis.files) requireHash(`${root}/analyses/${analysis.analysisId}/${artifact.name}`, artifact.sha256);
      for (const publication of research.foundations.publications) for (const artifact of publication.files) requireHash(`${root}/${publication.kind}/${publication.artifactId}/${artifact.name}`, artifact.sha256);
    }
    if (research.brainstormRuns.some(run => ['pending', 'running'].includes(run.status)) || research.foundations?.jobs.some(job => ['queued', 'running'].includes(job.status))) throw new ResearchCoreError('HOST_BUSY', 'Finish or cancel active generation/foundation jobs before taking a restorable asset backup');
  }
  for (const entry of files.filter(file => file.file.startsWith(prefix))) {
    const relative = entry.file.slice(prefix.length);
    if (/^cycles\/[^/]+\/state\.json$/.test(relative)) {
      const cycle = validateCycleState(JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8')));
      const refs = [...cycle.artifacts.map(artifact => artifact.ref), ...cycle.runs.map(run => run.baseGraphRef), ...cycle.steps.flatMap(step => [...step.inputRefs.filter(input => input.kind === 'artifact').map(input => input.ref), ...step.outputRefs])];
      for (const ref of refs) requireHash(`${path.posix.dirname(entry.file)}/${ref.id}`, ref.sha256);
      if (cycle.runs.some(run => ['queued', 'running', 'waiting_result', 'cancelling'].includes(run.status))) throw new ResearchCoreError('HOST_BUSY', 'Review/apply, finish or cancel active research handoffs before asset backup');
    }
    if (/^command-runs\/[^/]+\.json$/.test(relative)) {
      const run = JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8'));
      if (['pending', 'running'].includes(run.status)) throw new ResearchCoreError('HOST_BUSY', 'Finish or cancel active paper commands before asset backup');
    }
  }
  return { state, prefix };
}
export function validateResearchAssetBackup(raw: unknown): ResearchAssetBackup {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('asset backup object required');
  const value = raw as ResearchAssetBackup;
  if (Object.keys(value).some(key => !['schemaVersion', 'kind', 'createdAt', 'sourceWorkspace', 'inventoryHash', 'files'].includes(key)) || value.schemaVersion !== 1 || value.kind !== 'dsh-research-assets' || typeof value.sourceWorkspace !== 'string' || value.sourceWorkspace.length > 1000 || typeof value.createdAt !== 'string' || value.createdAt.length > 50 || !Number.isFinite(Date.parse(value.createdAt)) || !Array.isArray(value.files) || value.files.length > BACKUP_LIMITS.files || !value.files.length) fail('invalid asset backup header');
  const seen = new Set<string>(); let bytes = 0;
  for (const entry of value.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['file', 'bytes', 'sha256', 'contentBase64'].includes(key)) || typeof entry.file !== 'string' || typeof entry.contentBase64 !== 'string' || !Number.isInteger(entry.bytes) || entry.bytes < 0 || typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) fail('invalid asset backup entry');
    assetPath(entry.file); const key = entry.file.toLowerCase();
    if (seen.has(key)) fail('duplicate/case-colliding backup path'); seen.add(key);
    bytes += entry.bytes;
    if (bytes > BACKUP_LIMITS.bytes || entry.contentBase64.length > Math.ceil(entry.bytes / 3) * 4) throw new ResearchCoreError('QUOTA', 'backup byte limit or base64 size exceeded');
    const content = Buffer.from(entry.contentBase64, 'base64');
    if (content.length !== entry.bytes || content.toString('base64') !== entry.contentBase64 || hash(content) !== entry.sha256) throw new ResearchCoreError('STATE_CORRUPT', `backup bytes/hash mismatch: ${entry.file}`);
  }
  for (const entry of value.files) { const parts = entry.file.toLowerCase().split('/'); for (let index = 1; index < parts.length; index++) if (seen.has(parts.slice(0, index).join('/'))) fail('backup file/directory path collision'); }
  if (hash(JSON.stringify(metadata(value.files))) !== value.inventoryHash) throw new ResearchCoreError('STATE_CORRUPT', 'backup inventory hash differs');
  authoritativeState(value.files);
  return value;
}
export function createResearchAssetBackup(workspace: string): ResearchAssetBackup {
  workspace = fs.realpathSync(workspace);
  if (!activeStore(workspace)) fail('Select an active standalone store before backup');
  // Projection validation catches missing paper sources and mismatched identities before exporting a supposedly restorable package.
  readLegacyWorkbench(workspace);
  const files = snapshot(workspace);
  const result: ResearchAssetBackup = { schemaVersion: 1, kind: 'dsh-research-assets', createdAt: new Date().toISOString(), sourceWorkspace: workspace, files, inventoryHash: hash(JSON.stringify(metadata(files))) };
  validateResearchAssetBackup(result);
  if (JSON.stringify(metadata(snapshot(workspace))) !== JSON.stringify(metadata(files))) throw new ResearchCoreError('REVISION_CONFLICT', 'Research assets changed during backup; retry from a quiet state');
  return result;
}
export function previewResearchAssetBackup(raw: unknown) {
  const backup = validateResearchAssetBackup(raw), { state } = authoritativeState(backup.files);
  return { inventoryHash: backup.inventoryHash, sourceWorkspace: backup.sourceWorkspace, createdAt: backup.createdAt, files: backup.files.length, bytes: backup.files.reduce((sum, file) => sum + file.bytes, 0), researches: state.researches.length,
    warnings: ['包含全部受管原文、论文、运行和迁移历史；仅限用户备份。', '只恢复到全新目录，重置来源授权与节点确认；旧审查和已完成运行保留历史，不创建进程。', '不包含工作目录中的代码仓库、外部运行环境或外部客户端日志；这些需另行备份。'] };
}
export function restoreResearchAssetBackup(target: string, raw: unknown, expectedHash: string) {
  const backup = validateResearchAssetBackup(raw);
  if (backup.inventoryHash !== expectedHash) throw new ResearchCoreError('REVISION_CONFLICT', 'backup changed since preview');
  target = path.resolve(target); const parent = fs.realpathSync(path.dirname(target));
  if (fs.existsSync(target) || fs.lstatSync(path.dirname(target)).isSymbolicLink()) throw new ResearchCoreError('ALREADY_EXISTS', 'Restore requires a brand-new directory with an existing real parent');
  // Reserve the target exclusively. Failure retains the stage and first error for inspection; no pre-existing files are replaced.
  fs.mkdirSync(target);
  const stage = path.join(target, '.restore-stage'), restoreId = `restore-${randomUUID()}`, history = `.research/restore-history/${restoreId}`;
  fs.mkdirSync(stage);
  const write = (relative: string, bytes: Buffer | string) => { const file = path.join(stage, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' }); };
  try {
    for (const entry of backup.files) write(entry.file, Buffer.from(entry.contentBase64, 'base64'));
    const { prefix } = authoritativeState(backup.files);
    const preserve = (relative: string) => { const stored = `${history}/${relative}`; write(stored, fs.readFileSync(path.join(stage, relative))); return stored; };
    if (fs.existsSync(path.join(stage, prefix, 'bootstrap/state.json'))) preserve(`${prefix}bootstrap/state.json`);
    fs.mkdirSync(path.join(stage, '.research/compat'), { recursive: true });
    const papers = backup.files.filter(file => new RegExp(`^${prefix.replaceAll('.', '\\.')}papers/paper-[a-f0-9]{64}\\.json$`).test(file.file)).map(entry => {
      const paper = JSON.parse(Buffer.from(entry.contentBase64, 'base64').toString('utf8'));
      return { paperId: paper.id, owner: paper.owner, sha256: entry.sha256, original: preserve(entry.file) };
    });
    const provenanceFile = '.research/restore-provenance.json';
    if (fs.existsSync(path.join(stage, provenanceFile))) preserve(provenanceFile);
    const provenance = { schemaVersion: 1, kind: 'research-asset-restore', restoreId, inventoryHash: backup.inventoryHash, sourceWorkspace: backup.sourceWorkspace, papers, restoredAt: new Date().toISOString() };
    fs.mkdirSync(path.join(stage, '.research'), { recursive: true });
    fs.writeFileSync(path.join(stage, provenanceFile), JSON.stringify(provenance, null, 2));
    const store = new ResearchBootstrapStore(stage), before = store.readStateOrEmpty();
    const saved = store.mutate({ operationId: restoreId, kind: 'restore_research_assets', researchId: null, baseRevision: before.revision, requestPayload: { inventoryHash: backup.inventoryHash }, apply: context => {
      for (const research of context.state.researches) if (research.general) {
        const general = research.general;
        if (general.externalLoop) general.externalLoop.approvals = [];
        general.profileHistory.push({ requireHumanConfirmation: general.requireHumanConfirmation, revision: general.profileRevision, title: research.title, domains: general.domains, methods: general.methods, entryMode: general.entryMode, reference: general.reference, constraints: general.constraints, pendingQuestions: general.pendingQuestions, limits: general.limits });
        general.requireHumanConfirmation = true; general.profileRevision += 1; general.revision += 1;
        for (const source of general.sources) general.sourceAccess.push({ decisionId: `access-${randomUUID()}`, sourceId: source.sourceId, allowed: false, reason: '备份恢复到新工作区，需重新授权', actor: { identity: 'restore', actionId: restoreId }, createdAt: context.now() });
      }
      return { changed: true, result: { restoreId, inventoryHash: backup.inventoryHash, permissionsInherited: false } };
    } });
    readLegacyWorkbench(stage); // Includes original paper source/identity and semantic state validation.
    for (const directory of ['.dsh', '.research']) if (fs.existsSync(path.join(stage, directory))) fs.renameSync(path.join(stage, directory), path.join(target, directory));
    // The empty stage is deliberately retained; no recursive deletion is involved.
    readLegacyWorkbench(target);
    return { ...saved.result, target, revision: saved.revision, filesRestored: backup.files.length, sourceUntouched: true };
  } catch (error) {
    fs.writeFileSync(path.join(target, '.research-restore-incomplete.json'), JSON.stringify({ restoreId, inventoryHash: backup.inventoryHash, firstError: String(error), stage }));
    throw error;
  }
}
