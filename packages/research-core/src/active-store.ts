import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateBootstrapState, emptyBootstrapState } from '../../evolver/src/contracts/research-bootstrap.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';

export interface ActiveStore {
  schemaVersion: 1;
  kind: 'bootstrap';
  root: '.research/compat';
  migrationId: string | null;
  sourceInventoryHash: string | null;
}
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export function activeStore(workspaceDir: string): ActiveStore | null {
  const file = path.join(workspaceDir, '.research/active-store.json');
  if (!fs.existsSync(file)) return null;
  const manifestRelative = path.relative(fs.realpathSync(workspaceDir), fs.realpathSync(file));
  if (manifestRelative.startsWith('..') || path.isAbsolute(manifestRelative)) throw new ResearchCoreError('PATH_ESCAPE', 'active-store manifest leaves workspace');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Array.isArray(value) || Object.keys(value).some((key) => !['schemaVersion', 'kind', 'root', 'migrationId', 'sourceInventoryHash'].includes(key)) || value.schemaVersion !== 1 || value.kind !== 'bootstrap' || value.root !== '.research/compat'
    || !(value.migrationId === null || typeof value.migrationId === 'string' && /^migration-[0-9a-f-]{36}$/.test(value.migrationId))
    || !(value.sourceInventoryHash === null || typeof value.sourceInventoryHash === 'string' && /^[0-9a-f]{64}$/.test(value.sourceInventoryHash))
    || (value.migrationId === null) !== (value.sourceInventoryHash === null)) throw new ResearchCoreError('STATE_CORRUPT', 'invalid active-store manifest');
  const root = path.join(workspaceDir, value.root);
  const relative = path.relative(fs.realpathSync(workspaceDir), fs.realpathSync(root));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResearchCoreError('PATH_ESCAPE', 'active store leaves workspace');
  return value;
}

export function migrationInventory(root: string, prefix = ''): Array<{ file: string; bytes: number; sha256: string }> {
  const result: Array<{ file: string; bytes: number; sha256: string }> = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    if (entry.name === '.writer.lock') continue;
    const relative = path.posix.join(prefix, entry.name), file = path.join(root, relative);
    if (entry.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', `migration does not follow links: ${relative}`);
    if (entry.isDirectory()) result.push(...migrationInventory(root, relative));
    else if (entry.isFile()) { const bytes = fs.readFileSync(file); result.push({ file: relative, bytes: bytes.length, sha256: hash(bytes) }); }
    else throw new ResearchCoreError('INVALID_INPUT', `migration cannot copy special file: ${relative}`);
  }
  return result.sort((a, b) => a.file.localeCompare(b.file));
}

export function assetRestoreSummary(workspaceDir: string) {
  const file = path.join(workspaceDir, '.research/restore-provenance.json');
  if (!fs.existsSync(file)) return null;
  if (fs.lstatSync(file).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'restore provenance cannot be a link');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (value.schemaVersion !== 1 || value.kind !== 'research-asset-restore' || !/^restore-[0-9a-f-]{36}$/.test(value.restoreId) || !/^[0-9a-f]{64}$/.test(value.inventoryHash) || typeof value.sourceWorkspace !== 'string' || value.sourceWorkspace.length > 1000 || typeof value.restoredAt !== 'string' || !Number.isFinite(Date.parse(value.restoredAt))) throw new ResearchCoreError('STATE_CORRUPT', 'invalid asset restore history');
  return { restoreId: value.restoreId as string, inventoryHash: value.inventoryHash as string, sourceWorkspace: value.sourceWorkspace as string, restoredAt: value.restoredAt as string };
}

/** A user-restored backup preserves paper owner metadata without treating that historical owner as a current grant. */
export function restoredPaperOwner(workspaceDir: string, paperId: string): string | null {
  if (!/^paper-[a-f0-9]{64}$/.test(paperId)) throw new ResearchCoreError('INVALID_INPUT', 'invalid restored paper ID');
  const provenanceFile = path.join(workspaceDir, '.research/restore-provenance.json');
  if (!fs.existsSync(provenanceFile)) return null;
  if (fs.lstatSync(provenanceFile).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'restore provenance cannot be a link');
  const provenance = JSON.parse(fs.readFileSync(provenanceFile, 'utf8'));
  if (provenance.schemaVersion !== 1 || provenance.kind !== 'research-asset-restore' || !/^restore-[0-9a-f-]{36}$/.test(provenance.restoreId) || !/^[0-9a-f]{64}$/.test(provenance.inventoryHash) || !Array.isArray(provenance.papers)) throw new ResearchCoreError('STATE_CORRUPT', 'invalid paper restore provenance');
  const entry = provenance.papers.find((value: { paperId: string }) => value.paperId === paperId);
  if (!entry) return null;
  const expected = `.research/restore-history/${provenance.restoreId}/.research/compat/.dsh/research/papers/${paperId}.json`;
  if (entry.original !== expected || typeof entry.owner !== 'string' || !entry.owner.trim() || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new ResearchCoreError('STATE_CORRUPT', 'invalid restored paper identity pin');
  const original = path.join(workspaceDir, expected), relative = path.relative(fs.realpathSync(workspaceDir), fs.realpathSync(original));
  if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(original).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'restored paper identity leaves its workspace');
  const bytes = fs.readFileSync(original);
  if (hash(bytes) !== entry.sha256) throw new ResearchCoreError('STATE_CORRUPT', 'restored original paper JSON differs from backup');
  const paper = JSON.parse(bytes.toString('utf8'));
  if (paper.id !== paperId || paper.owner !== entry.owner) throw new ResearchCoreError('STATE_CORRUPT', 'restored original paper identity differs');
  return entry.owner;
}

/** Relocation keeps original paper bytes/owner metadata; only sealed migration provenance admits that historical identity. */
export function migratedPaperOwner(workspaceDir: string, paperId: string): string | null {
  if (!/^paper-[a-f0-9]{64}$/.test(paperId)) throw new ResearchCoreError('INVALID_INPUT', 'invalid migrated paper ID');
  const selected = activeStore(workspaceDir);
  if (!selected?.migrationId) return null;
  const manifestFile = path.join(workspaceDir, selected.root, 'migration-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.migrationId !== selected.migrationId || !Array.isArray(manifest.files) || hash(JSON.stringify(manifest.files)) !== selected.sourceInventoryHash) throw new ResearchCoreError('STATE_CORRUPT', 'migration source inventory no longer matches the selected authority');
  const entry = manifest.files.find((file: { file: string }) => file.file === `papers/${paperId}.json`);
  if (!entry) return null;
  const original = path.join(workspaceDir, '.dsh/research', entry.file);
  const relative = path.relative(fs.realpathSync(workspaceDir), fs.realpathSync(original));
  if (relative.startsWith('..') || path.isAbsolute(relative) || fs.lstatSync(original).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'original paper identity leaves migration scope');
  const bytes = fs.readFileSync(original);
  if (hash(bytes) !== entry.sha256) throw new ResearchCoreError('STATE_CORRUPT', 'original paper identity differs from sealed migration bytes');
  const paper = JSON.parse(bytes.toString('utf8'));
  if (paper.id !== paperId || typeof paper.owner !== 'string' || !paper.owner.trim()) throw new ResearchCoreError('STATE_CORRUPT', 'original paper identity is invalid');
  return paper.owner;
}

/** Read-only dry-run includes all source bytes, not only the bootstrap object count. */
export function migrationPreview(workspaceDir: string) {
  const root = path.join(workspaceDir, '.dsh/research');
  for (const candidate of [root, path.join(workspaceDir, '.research')]) {
    if (!fs.existsSync(candidate)) continue;
    const relative = path.relative(fs.realpathSync(workspaceDir), fs.realpathSync(candidate));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResearchCoreError('PATH_ESCAPE', 'migration root leaves workspace');
  }
  const stateFile = path.join(root, 'bootstrap/state.json');
  const stateBytes = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  const state = stateBytes ? validateBootstrapState(JSON.parse(stateBytes.toString('utf8'))) : emptyBootstrapState();
  const files = migrationInventory(root);
  if (stateBytes && files.find((f) => f.file === 'bootstrap/state.json')?.sha256 !== hash(stateBytes)) throw new ResearchCoreError('REVISION_CONFLICT', 'source changed while computing migration preview');
  const issues: string[] = [];
  for (const entry of files.filter((f) => /^papers\/paper-[0-9a-f]{64}\.json$/.test(f.file))) {
    try {
      const paper = JSON.parse(fs.readFileSync(path.join(root, entry.file), 'utf8'));
      const source = files.find((f) => f.file === entry.file.replace(/\.json$/, '.source'));
      if (paper.id !== path.basename(entry.file, '.json') || source?.sha256 !== paper.sha256 || !Array.isArray(paper.pages) || !paper.pages.every((p: unknown) => typeof p === 'string') || !Array.isArray(paper.sections) || !Array.isArray(paper.components)) issues.push(`${entry.file}: paper identity/source/text structure is corrupt`);
    } catch (error) { issues.push(`${entry.file}: ${String(error)}`); }
  }
  if (fs.existsSync(path.join(workspaceDir, '.research/project.json'))) issues.push('both prototype and DSH assets exist; explicit asset merge is required before choosing an authority');
  for (const research of state.researches) for (const source of research.general?.sources ?? []) {
    for (const [kind, sha256] of [['raw', source.sha256], ['parsed', source.parsedSha256]]) {
      const actual = files.find((f) => f.file === `materials/${kind}/${sha256}`);
      if (actual?.sha256 !== sha256) issues.push(`${research.researchId}/${source.sourceId}: missing or corrupt ${kind} bytes`);
    }
  }
  return { schemaVersion: 1, source: '.dsh/research', destination: '.research/compat/.dsh/research', sourceRevision: state.revision,
    sourceInventoryHash: hash(JSON.stringify(files)), files, issues, referencesValid: issues.length === 0, bootstrapWasPresent: stateBytes !== null,
    objects: { researches: state.researches.length, ideas: state.researches.reduce((n, r) => n + r.ideas.length + (r.general?.ideas.length ?? 0), 0), knowledgeVersions: state.researches.reduce((n, r) => n + (r.general?.knowledge.length ?? 0), 0), graphNodes: state.researches.reduce((n, r) => n + (r.graph?.nodes.length ?? 0) + (r.general?.graph.nodes.length ?? 0), 0) },
    warnings: ['旧来源权限不继承，迁移后逐来源重新授权。', '历史确认与原始产物保留；profile revision 递增使旧节点确认失效。', '原会话、grant、Team 记录仅为历史，不构成当前执行权限。'] };
}

function writeManifest(workspaceDir: string, value: ActiveStore) {
  const file = path.join(workspaceDir, '.research/active-store.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

export function initializeActiveStore(workspaceDir: string) {
  if (activeStore(workspaceDir)) return;
  if (fs.existsSync(path.join(workspaceDir, '.research/project.json'))) throw new ResearchCoreError('INVALID_INPUT', 'PROTOTYPE_MIGRATION_REQUIRED: migrate the prototype assets before selecting a Bootstrap store');
  if (fs.existsSync(path.join(workspaceDir, '.dsh/research/bootstrap/state.json')) || fs.existsSync(path.join(workspaceDir, '.dsh/research/papers'))) throw new ResearchCoreError('INVALID_INPUT', 'legacy research requires an explicit migration');
  fs.mkdirSync(path.join(workspaceDir, '.research/compat'), { recursive: true });
  try { writeManifest(workspaceDir, { schemaVersion: 1, kind: 'bootstrap', root: '.research/compat', migrationId: null, sourceInventoryHash: null }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; activeStore(workspaceDir); }
}

export function migrateDshWorkspace(workspaceDir: string, expectedHash: string) {
  migrationPreview(workspaceDir); // Validate paths and links before creating a source lock.
  if (activeStore(workspaceDir)) throw new ResearchCoreError('ALREADY_EXISTS', 'an active store has already been selected');
  if (fs.existsSync(path.join(workspaceDir, '.research/compat'))) throw new ResearchCoreError('ALREADY_EXISTS', 'compat directory exists; resolve this partial/independent store before migration');
  const source = path.join(workspaceDir, '.dsh/research');
  const lock = path.join(source, fs.existsSync(path.join(source, 'bootstrap')) ? 'bootstrap/.writer.lock' : '.writer.lock');
  let fd: number;
  try { fd = fs.openSync(lock, 'wx'); } catch (error) { throw new ResearchCoreError('HOST_BUSY', `migration cannot acquire the source writer lock: ${String(error)}`); }
  fs.writeFileSync(fd, JSON.stringify({ token: randomUUID(), pid: process.pid, acquiredAt: new Date().toISOString() }));
  const migrationId = `migration-${randomUUID()}`;
  const stage = path.join(workspaceDir, '.research', migrationId);
  try {
    const before = migrationPreview(workspaceDir);
    if (!before.referencesValid) throw new ResearchCoreError('STATE_CORRUPT', before.issues.join('; '));
    if (before.sourceInventoryHash !== expectedHash) throw new ResearchCoreError('REVISION_CONFLICT', 'source changed since migration preview');
    const target = path.join(stage, '.dsh/research'); fs.mkdirSync(target, { recursive: true });
    for (const entry of before.files) {
      const destination = path.join(target, entry.file); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(path.join(source, entry.file), destination, fs.constants.COPYFILE_EXCL);
      if (hash(fs.readFileSync(destination)) !== entry.sha256) throw new ResearchCoreError('STATE_CORRUPT', `migration copy changed: ${entry.file}`);
    }
    const stateFile = path.join(target, 'bootstrap/state.json');
    const original = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
    const state = original ? validateBootstrapState(JSON.parse(original.toString('utf8'))) : emptyBootstrapState();
    for (const research of state.researches) {
      if (!research.general) continue;
      const general = research.general;
      general.profileHistory.push({ requireHumanConfirmation: general.requireHumanConfirmation, revision: general.profileRevision, title: research.title, domains: general.domains, methods: general.methods, entryMode: general.entryMode, reference: general.reference, constraints: general.constraints, pendingQuestions: general.pendingQuestions, limits: general.limits });
      general.requireHumanConfirmation = true;
      general.profileRevision += 1;
      general.revision += 1;
      for (const source of general.sources) general.sourceAccess.push({ decisionId: `access-${randomUUID()}`, sourceId: source.sourceId, allowed: false, reason: '跨宿主迁移，需本地重新授权', actor: { identity: 'migration', actionId: migrationId }, createdAt: new Date().toISOString() });
    }
    state.revision += 1;
    const checked = validateBootstrapState(state);
    if (original) fs.writeFileSync(path.join(stage, 'bootstrap-before-migration.json'), original, { flag: 'wx' });
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(checked, null, 2) + '\n');
    const destinationFiles = migrationInventory(stage);
    fs.writeFileSync(path.join(stage, 'migration-manifest.json'), JSON.stringify({ migrationId, ...before, destinationRevision: checked.revision, permissionsInherited: false, destinationFiles, destinationInventoryHash: hash(JSON.stringify(destinationFiles)) }, null, 2) + '\n');
    if (migrationPreview(workspaceDir).sourceInventoryHash !== expectedHash) throw new ResearchCoreError('REVISION_CONFLICT', 'source changed during migration; staged evidence is retained');
    fs.renameSync(stage, path.join(workspaceDir, '.research/compat'));
    writeManifest(workspaceDir, { schemaVersion: 1, kind: 'bootstrap', root: '.research/compat', migrationId, sourceInventoryHash: expectedHash });
    return { migrationId, sourceInventoryHash: expectedHash, destinationRevision: checked.revision, sourcePreserved: true };
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
