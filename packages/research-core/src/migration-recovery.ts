import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { activeStore, migrationInventory } from './active-store.ts';
import { validateBootstrapState } from '../../evolver/src/contracts/research-bootstrap.ts';
import { ResearchCoreError } from '../../research-contracts/src/index.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Entry = { file: string; bytes: number; sha256: string };
const digest = (files: Entry[]) => hash(JSON.stringify(files));

function candidatePath(workspace: string, candidate: string) {
  if (candidate !== '.research/compat' && !/^\.research\/migration-[0-9a-f-]{36}$/.test(candidate) && !/^\.migration-[0-9a-f-]{36}$/.test(candidate)) throw new ResearchCoreError('INVALID_INPUT', 'candidate must be compat or an existing named migration stage');
  const target = path.join(workspace, candidate);
  for (const part of [path.join(workspace, '.research'), target]) if (fs.existsSync(part) && (fs.lstatSync(part).isSymbolicLink() || path.relative(workspace, fs.realpathSync(part)).startsWith('..'))) throw new ResearchCoreError('PATH_ESCAPE', 'migration recovery does not follow links');
  if (!fs.statSync(target).isDirectory()) throw new ResearchCoreError('INVALID_INPUT', 'migration stage must be a directory');
  return target;
}

/** A manifest sealed before promotion is required. Incomplete stages remain untouched. */
export function migrationRecoveryPreview(requested: string, candidate: string) {
  const workspace = fs.realpathSync(requested);
  if (activeStore(workspace)) throw new ResearchCoreError('ALREADY_EXISTS', 'an authority is already active; recovery must not replace it');
  const target = candidatePath(workspace, candidate), inventory = migrationInventory(target);
  if (fs.existsSync(path.join(target, '.dsh/research/bootstrap/.writer.lock'))) throw new ResearchCoreError('HOST_BUSY', 'destination has a writer lock; refuse promotion of a potentially active store');
  const manifestFile = path.join(target, 'migration-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (!/^migration-[0-9a-f-]{36}$/.test(manifest.migrationId) || manifest.permissionsInherited !== false || !Array.isArray(manifest.files) || !Array.isArray(manifest.destinationFiles) || digest(manifest.files) !== manifest.sourceInventoryHash || digest(manifest.destinationFiles) !== manifest.destinationInventoryHash) throw new ResearchCoreError('STATE_CORRUPT', 'migration stage has no valid sealed source/destination inventory; automatic promotion refused');
  const kind = manifest.kind === 'prototype' ? 'prototype' : manifest.source === '.dsh/research' ? 'dsh' : null;
  if (!kind || candidate !== '.research/compat' && candidate !== (kind === 'prototype' ? `.${manifest.migrationId}` : `.research/${manifest.migrationId}`)) throw new ResearchCoreError('STATE_CORRUPT', 'stage kind or migration identity mismatch');
  if (candidate !== '.research/compat' && fs.existsSync(path.join(workspace, '.research/compat'))) throw new ResearchCoreError('ALREADY_EXISTS', 'another compat exists; never overwrite a competing store');
  if (digest(inventory.filter((e) => e.file !== 'migration-manifest.json')) !== manifest.destinationInventoryHash) throw new ResearchCoreError('STATE_CORRUPT', 'migration destination differs from its sealed inventory');
  const sourceRoot = path.join(workspace, kind === 'prototype' ? '.research' : '.dsh/research');
  for (const part of [path.dirname(sourceRoot), sourceRoot]) if (fs.lstatSync(part).isSymbolicLink() || path.relative(workspace, fs.realpathSync(part)).startsWith('..')) throw new ResearchCoreError('PATH_ESCAPE', 'source root must remain a regular directory inside workspace');
  const sourceFiles = kind === 'prototype' ? fs.readdirSync(sourceRoot, { withFileTypes: true }).filter((e) => !['compat', '.writer.lock'].includes(e.name)).flatMap((entry) => {
    const location = path.join(sourceRoot, entry.name);
    if (entry.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'prototype source contains a link');
    if (entry.isDirectory()) return migrationInventory(location).map((e) => ({ ...e, file: `${entry.name}/${e.file}` }));
    if (!entry.isFile()) throw new ResearchCoreError('STATE_CORRUPT', 'prototype source contains a non-file');
    const bytes = fs.readFileSync(location); return [{ file: entry.name, bytes: bytes.length, sha256: hash(bytes) }];
  }).sort((a, b) => a.file.localeCompare(b.file)) : migrationInventory(sourceRoot);
  if (digest(sourceFiles) !== manifest.sourceInventoryHash) throw new ResearchCoreError('REVISION_CONFLICT', 'source changed after the interrupted migration; original and stage are preserved');
  const state = validateBootstrapState(JSON.parse(fs.readFileSync(path.join(target, '.dsh/research/bootstrap/state.json'), 'utf8')));
  if (state.revision !== manifest.destinationRevision) throw new ResearchCoreError('STATE_CORRUPT', 'destination revision mismatch');
  for (const research of state.researches) if (research.general) {
    const g = research.general;
    if (!g.requireHumanConfirmation || g.sources.some((s) => [...g.sourceAccess].reverse().find((a) => a.sourceId === s.sourceId)?.allowed !== false)) throw new ResearchCoreError('STATE_CORRUPT', 'migration must not inherit source or execution permissions');
  }
  const lockFile = path.join(sourceRoot, kind === 'prototype' || !fs.existsSync(path.join(sourceRoot, 'bootstrap')) ? '.writer.lock' : 'bootstrap/.writer.lock');
  if (fs.lstatSync(path.dirname(lockFile)).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'writer lock parent is a link');
  if (fs.existsSync(lockFile) && fs.lstatSync(lockFile).isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'writer lock is a link');
  const lockBytes = fs.existsSync(lockFile) ? fs.readFileSync(lockFile) : null;
  let abandonedPid: number | null = null;
  if (lockBytes) {
    const lock = JSON.parse(lockBytes.toString('utf8'));
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new ResearchCoreError('HOST_BUSY', 'writer lock owner is unknown; cannot prove it abandoned');
    try { process.kill(lock.pid, 0); throw new ResearchCoreError('HOST_BUSY', 'source writer process is still alive'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    abandonedPid = lock.pid;
  }
  const recoveryHash = hash(JSON.stringify({ candidate, manifestHash: hash(fs.readFileSync(manifestFile)), destinationHash: digest(inventory), sourceHash: digest(sourceFiles), lockHash: lockBytes ? hash(lockBytes) : null }));
  return { workspace, candidate, kind, migrationId: manifest.migrationId as string, sourceInventoryHash: manifest.sourceInventoryHash as string, destinationInventoryHash: manifest.destinationInventoryHash as string, manifestHash: hash(fs.readFileSync(manifestFile)), destinationRevision: state.revision, recoveryHash, sourceFiles: sourceFiles.length, destinationFiles: inventory.length, abandonedPid, lockFile, lockHash: lockBytes ? hash(lockBytes) : null };
}

/** Explicit user recovery only; retain original bytes and abandoned lock evidence. */
export function recoverMigration(workspace: string, candidate: string, expectedHash: string) {
  const before = migrationRecoveryPreview(workspace, candidate);
  workspace = before.workspace;
  if (before.recoveryHash !== expectedHash) throw new ResearchCoreError('REVISION_CONFLICT', 'recovery preview changed');
  if (before.abandonedPid !== null) {
    if (hash(fs.readFileSync(before.lockFile)) !== before.lockHash) throw new ResearchCoreError('HOST_BUSY', 'writer lock changed before recovery');
    const lockArchive = path.join(workspace, `.recovered-writer-${randomUUID()}.json`);
    fs.renameSync(before.lockFile, lockArchive);
  }
  let fd: number;
  try { fd = fs.openSync(before.lockFile, 'wx'); } catch (error) { throw new ResearchCoreError('HOST_BUSY', `cannot acquire source lock for recovery: ${String(error)}`); }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID() }));
  try {
    const ownLock = fs.readFileSync(before.lockFile);
    if (activeStore(workspace)) throw new ResearchCoreError('ALREADY_EXISTS', 'an authority was selected while waiting for recovery; it will not be replaced');
    const target = candidatePath(workspace, candidate);
    if (hash(fs.readFileSync(path.join(target, 'migration-manifest.json'))) !== before.manifestHash || digest(migrationInventory(target).filter((e) => e.file !== 'migration-manifest.json')) !== before.destinationInventoryHash) throw new ResearchCoreError('STATE_CORRUPT', 'stage changed while acquiring recovery lock');
    const sourceRoot = path.join(workspace, before.kind === 'prototype' ? '.research' : '.dsh/research');
    const sourceFiles = migrationInventory(sourceRoot).filter((e) => before.kind !== 'prototype' || !e.file.startsWith('compat/'));
    if (digest(sourceFiles) !== before.sourceInventoryHash || fs.readFileSync(before.lockFile).compare(ownLock) !== 0) throw new ResearchCoreError('REVISION_CONFLICT', 'source or lock changed while recovering');
    if (candidate !== '.research/compat') fs.renameSync(target, path.join(workspace, '.research/compat'));
    fs.writeFileSync(path.join(workspace, '.research/active-store.json'), JSON.stringify({ schemaVersion: 1, kind: 'bootstrap', root: '.research/compat', migrationId: before.migrationId, sourceInventoryHash: before.sourceInventoryHash }, null, 2) + '\n', { flag: 'wx' });
    return { migrationId: before.migrationId, destinationRevision: before.destinationRevision, sourcePreserved: true, recovered: true };
  } finally { fs.closeSync(fd); fs.unlinkSync(before.lockFile); }
}
