import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ResearchCoreError, validateActorContext, type ActorContext } from '../../research-contracts/src/index.ts';
import { activeStore } from './active-store.ts';
import { legacyScope } from './legacy-domain.ts';

export type WriterStore = 'prototype' | 'bootstrap' | 'cycle';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function location(requested: string, kind: WriterStore, researchId?: string) {
  const workspace = fs.realpathSync(requested);
  let directory: string;
  if (kind === 'prototype') {
    if (activeStore(workspace)) throw new ResearchCoreError('INVALID_INPUT', 'Prototype is historical after migration; select the active store');
    directory = path.join(workspace, '.research');
  } else if (kind === 'bootstrap' || kind === 'cycle') {
    const { store, readOnly } = legacyScope(workspace);
    if (readOnly) throw new ResearchCoreError('INVALID_INPUT', 'MIGRATION_REQUIRED: recovery cannot modify the read-only original store');
    if (kind === 'cycle') {
      if (!researchId || !/^[\w-]+$/.test(researchId)) throw new ResearchCoreError('INVALID_INPUT', 'cycle recovery requires a valid researchId');
      if (!store.readStateOrEmpty().researches.some(r => r.researchId === researchId)) throw new ResearchCoreError('NOT_FOUND', 'researchId is outside this workspace');
    }
    directory = path.join(store.workspaceRoot, '.dsh/research', kind === 'bootstrap' ? 'bootstrap' : `cycles/${researchId}`);
  } else throw new ResearchCoreError('INVALID_INPUT', 'store must be prototype, bootstrap or cycle');
  const relative = path.relative(workspace, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new ResearchCoreError('PATH_ESCAPE', 'writer store is outside the workspace');
  let current = workspace;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'writer recovery requires regular store directories');
  }
  return { workspace, directory, lockFile: path.join(directory, '.writer.lock'), stateFile: path.join(directory, kind === 'prototype' ? 'project.json' : 'state.json') };
}

function regularFile(file: string) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ResearchCoreError('PATH_ESCAPE', 'writer lock/state must be regular files');
  return stat;
}

/** Read-only. Unknown owners and permission-denied process checks never count as dead. */
export function previewWriterLock(workspace: string, kind: WriterStore, researchId?: string) {
  const target = location(workspace, kind, researchId);
  let lockHash: string | null = null, pid: number | null = null, ownerState: 'absent' | 'alive' | 'dead' | 'unknown' = 'absent';
  if (fs.existsSync(target.lockFile)) {
    if (regularFile(target.lockFile).size > 65536) throw new ResearchCoreError('STATE_CORRUPT', 'writer lock exceeds 64 KiB');
    const bytes = fs.readFileSync(target.lockFile); lockHash = hash(bytes); ownerState = 'unknown';
    let owner: unknown;
    try { owner = JSON.parse(bytes.toString('utf8')); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (owner && typeof owner === 'object' && 'pid' in owner && Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) {
      pid = owner.pid as number;
      try { process.kill(pid, 0); ownerState = 'alive'; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') ownerState = 'dead'; else if ((error as NodeJS.ErrnoException).code !== 'EPERM' && (error as NodeJS.ErrnoException).code !== 'EACCES') throw error; }
    }
  }
  let stateHash: string | null = null;
  if (fs.existsSync(target.stateFile)) { regularFile(target.stateFile); stateHash = hash(fs.readFileSync(target.stateFile)); }
  const proof = { workspace: target.workspace, kind, researchId: kind === 'cycle' ? researchId ?? null : null, lockHash, stateHash };
  return { ...proof, lockFile: target.lockFile, pid, ownerState, recoverable: ownerState === 'dead', recoveryHash: hash(JSON.stringify(proof)) };
}

/** Explicit user action. Archive the exact abandoned bytes; never edit state or resume work. */
export function recoverWriterLock(workspace: string, kind: WriterStore, expectedHash: string, actor: ActorContext, authorize: boolean, researchId?: string) {
  const caller = validateActorContext(actor);
  if (caller.kind !== 'user' || !['cli', 'http'].includes(caller.source) || authorize !== true) throw new ResearchCoreError('INVALID_INPUT', 'explicit trusted user authorization required for writer recovery');
  const before = previewWriterLock(workspace, kind, researchId);
  if (before.recoveryHash !== expectedHash) throw new ResearchCoreError('REVISION_CONFLICT', 'writer lock/state changed since preview');
  if (!before.recoverable) throw new ResearchCoreError('HOST_BUSY', 'writer owner is alive, absent or unknown; recovery refused');
  // Serialize recoverers. Normal writers cannot remove the abandoned lock and
  // may proceed only after its one-way archive rename has finished.
  const guard = path.join(path.dirname(before.lockFile), '.writer-recovery.lock'), token = randomUUID();
  let fd: number;
  try { fd = fs.openSync(guard, 'wx'); } catch (error) { throw new ResearchCoreError('HOST_BUSY', `another recovery holds the guard: ${String(error)}`); }
  try { fs.writeFileSync(fd, JSON.stringify({ token, pid: process.pid })); } finally { fs.closeSync(fd); }
  try {
    const current = previewWriterLock(workspace, kind, researchId);
    if (current.recoveryHash !== expectedHash || !current.recoverable) throw new ResearchCoreError('REVISION_CONFLICT', 'writer lock/state or owner changed before recovery');
    const archive = path.join(path.dirname(current.lockFile), `.writer.lock.recovered.${randomUUID()}.json`);
    fs.renameSync(current.lockFile, archive);
    if (hash(fs.readFileSync(archive)) !== current.lockHash) throw new ResearchCoreError('STATE_CORRUPT', 'archived lock changed; inspect retained evidence');
    return { recovered: true, archive, lockHash: current.lockHash, stateHashAtRecovery: current.stateHash, abandonedPid: current.pid, actorId: caller.actorId, resumed: false };
  } finally {
    regularFile(guard);
    if (JSON.parse(fs.readFileSync(guard, 'utf8')).token !== token) throw new ResearchCoreError('HOST_BUSY', 'recovery guard changed; retained for inspection');
    fs.unlinkSync(guard);
  }
}
