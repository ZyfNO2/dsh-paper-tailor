import { BootstrapError } from '../../evolver/src/contracts/research-bootstrap.ts';
import { searchFailure } from '../../research-core/src/legacy-search.ts';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ResearchCoreError, type ActorContext } from '../../research-contracts/src/index.ts';
import { ResearchCore } from '../../research-core/src/index.ts';
import { activeStore, migrationPreview, migrateDshWorkspace } from '../../research-core/src/active-store.ts';
import { readLegacyWorkbench, legacyResearchAction } from './legacy-domain.ts';
import { legacyAsyncResearchAction } from '../../research-core/src/legacy-async-actions.ts';
import { foundationSnapshot, foundationAction } from '../../research-core/src/legacy-foundations.ts';
import { externalCycleAction } from '../../research-core/src/external-cycle.ts';
import { readWorkspaceCycle } from '../../research-core/src/legacy-cycle.ts';
import { migrationRecoveryPreview, recoverMigration } from '../../research-core/src/migration-recovery.ts';
import { previewWriterLock, recoverWriterLock, type WriterStore } from '../../research-core/src/writer-lock-recovery.ts';
import { prototypeMigrationPreview, migratePrototypeWorkspace } from '../../research-core/src/prototype-migration.ts';

import { createResearchAssetBackup, previewResearchAssetBackup, restoreResearchAssetBackup, BACKUP_LIMITS } from '../../research-core/src/workspace-backup.ts';

function backupInput(file: string) { if (fs.statSync(file).size > BACKUP_LIMITS.jsonBytes) throw new ResearchCoreError('QUOTA', 'asset backup JSON exceeds 96 MiB'); return JSON.parse(fs.readFileSync(file, 'utf8')); }

const core = new ResearchCore();

function actor(): ActorContext {
  const name = os.userInfo().username.trim() || 'cli-user';
  return { actorId: `cli:${name}`, kind: 'user', source: 'cli' };
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function requireFlag(argv: string[], name: string): string {
  const value = flag(argv, name);
  if (!value || value.startsWith('--')) throw new ResearchCoreError('INVALID_INPUT', `${name} is required`);
  return value;
}

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    emit({
      ok: true,
      commands: ['writer-lock-preview', 'recover-writer-lock', 'asset-backup', 'asset-backup-preview', 'asset-restore', 'init', 'context', 'migrate', 'migration-preview', 'prototype-migration-preview', 'migrate-prototype', 'migrate-dsh', 'migration-recovery-preview', 'recover-migration', 'workspace-action', 'foundations', 'foundation-action', 'external-cycle', 'cycle-status', 'import', 'read', 'wiki', 'knowledge', 'validate', 'export', 'approve', 'idea', 'plan', 'assignment', 'record', 'review', 'search', 'tree'],
      note: 'The CLI user is the actor. A flag or payload cannot rename that actor.',
    });
    return command ? 0 : 2;
  }
  if (command === 'asset-backup-preview') { emit({ ok: true, command, ...previewResearchAssetBackup(backupInput(requireFlag(rest, '--input'))) }); return 0; }
  const workspaceDir = requireFlag(rest, '--workspace');
  if (command === 'writer-lock-preview' || command === 'recover-writer-lock') {
    const kind = requireFlag(rest, '--store') as WriterStore, researchId = flag(rest, '--research');
    const result = command === 'writer-lock-preview' ? previewWriterLock(workspaceDir, kind, researchId)
      : recoverWriterLock(workspaceDir, kind, requireFlag(rest, '--expected-hash'), actor(), rest.includes('--authorize'), researchId);
    emit({ ok: true, command, ...result }); return 0;
  }
  if (command === 'asset-backup') {
    const backup = createResearchAssetBackup(workspaceDir), out = path.resolve(requireFlag(rest, '--out'));
    const relative = path.relative(fs.realpathSync(workspaceDir), out).replaceAll(path.sep, '/');
    if (relative.startsWith('.research/') || relative.startsWith('.dsh/research/')) throw new ResearchCoreError('INVALID_INPUT', 'save backup outside managed asset directories');
    fs.writeFileSync(out, JSON.stringify(backup), { flag: 'wx' }); emit({ ok: true, command, out, ...previewResearchAssetBackup(backup) }); return 0;
  }
  if (command === 'asset-restore') { emit({ ok: true, command, ...restoreResearchAssetBackup(workspaceDir, backupInput(requireFlag(rest, '--input')), requireFlag(rest, '--expected-hash')) }); return 0; }
  const operationId = flag(rest, '--operation-id') ?? `op-${cryptoId()}`;
  if (command === 'cycle-status') {
    const query = new URLSearchParams(), runId = flag(rest, '--run');
    if (runId) query.set('runId', runId);
    emit({ ok: true, command, ...readWorkspaceCycle(workspaceDir, requireFlag(rest, '--research'), query, actor()) }); return 0;
  }
  if (command === 'migration-recovery-preview') { emit({ ok: true, command, ...migrationRecoveryPreview(workspaceDir, requireFlag(rest, '--candidate')) }); return 0; }
  if (command === 'recover-migration') { emit({ ok: true, command, ...recoverMigration(workspaceDir, requireFlag(rest, '--candidate'), requireFlag(rest, '--expected-hash')) }); return 0; }
  if (command === 'external-cycle') {
    const input = JSON.parse(fs.readFileSync(requireFlag(rest, '--input'), 'utf8'));
    emit({ command, ...await externalCycleAction(workspaceDir, requireFlag(rest, '--research'), input, actor()) }); return 0;
  }
  if (command === 'foundations') { emit({ ok: true, command, ...foundationSnapshot(workspaceDir, requireFlag(rest, '--research'), undefined, false) }); return 0; }
  if (command === 'foundation-action') {
    const input = JSON.parse(fs.readFileSync(requireFlag(rest, '--input'), 'utf8'));
    emit({ command, ...await foundationAction(workspaceDir, requireFlag(rest, '--research'), input, actor()) }); return 0;
  }
  if (command === 'migration-preview') { emit({ ok: true, command, ...migrationPreview(workspaceDir) }); return 0; }
  if (command === 'prototype-migration-preview') { emit({ ok: true, command, ...prototypeMigrationPreview(workspaceDir) }); return 0; }
  if (command === 'migrate-prototype') { emit({ ok: true, command, ...migratePrototypeWorkspace(workspaceDir, requireFlag(rest, '--expected-hash')) }); return 0; }
  if (command === 'migrate-dsh') { emit({ ok: true, command, ...migrateDshWorkspace(workspaceDir, requireFlag(rest, '--expected-hash')) }); return 0; }
  if (command === 'workspace-action') {
    const input = JSON.parse(fs.readFileSync(requireFlag(rest, '--input'), 'utf8'));
    const result = await legacyAsyncResearchAction(workspaceDir, { ...input, operationId, baseRevision: integerFlag(rest, '--base-revision') }, actor());
    const ok = !('status' in result.result && result.result.status === 'blocked');
    emit({ ok, command, ...result }); return ok ? 0 : 1;
  }
  if (command === 'context' && activeStore(workspaceDir)) { emit({ ok: true, command, authority: 'bootstrap', ...readLegacyWorkbench(workspaceDir) }); return 0; }
  if (command === 'migrate') { emit({ ok: true, command, ...core.migrate(workspaceDir, actor()) }); return 0; }
  if (command === 'read') { emit({ ok: true, command, ...core.readMaterial(workspaceDir, requireFlag(rest, '--source')) }); return 0; }
  if (command === 'wiki') { emit({ ok: true, command, ...core.searchWiki(workspaceDir, flag(rest, '--query') ?? '') }); return 0; }
  if (command === 'knowledge') {
    const payload = JSON.parse(fs.readFileSync(requireFlag(rest, '--input'), 'utf8'));
    emit({ ok: true, command, ...core.upsertKnowledge({ ...payload, workspaceDir, operationId, actor: actor(), baseRevision: integerFlag(rest, '--base-revision') }) }); return 0;
  }
  if (command === 'context') {
    emit({ ok: true, command, ...core.context(workspaceDir) });
    return 0;
  }
  if (command === 'validate') {
    const validation = core.validate(workspaceDir);
    const ok = validation.projectValid && validation.legacyValid && validation.sourcesValid && validation.runEvidenceValid && validation.plansValid;
    emit({ ok, command, ...validation, ...core.context(workspaceDir) });
    return ok ? 0 : 1;
  }
  if (command === 'export') {
    emit({ ok: true, command, ...core.exportView(workspaceDir, requireFlag(rest, '--out')) });
    return 0;
  }
  if (command === 'init') {
    const constraints = flag(rest, '--constraints');
    emit({
      ok: true,
      command,
      ...core.init({
        workspaceDir,
        operationId,
        actor: actor(),
        goal: requireFlag(rest, '--goal'),
        constraints: constraints ? constraints.split(',').map((entry) => entry.trim()).filter(Boolean) : [],
      }),
    });
    return 0;
  }
  if (command === 'import') {
    emit({
      ok: true,
      command,
      ...core.importMaterial({
        workspaceDir,
        operationId,
        actor: actor(),
        filePath: requireFlag(rest, '--file'),
        baseRevision: integerFlag(rest, '--base-revision'),
        allowAbsolute: true,
      }),
    });
    return 0;
  }
  if (command === 'approve') {
    emit({
      ok: true,
      command,
      ...core.approve({
        workspaceDir,
        operationId,
        actor: actor(),
        baseRevision: integerFlag(rest, '--base-revision'),
        subjectId: requireFlag(rest, '--subject'),
        subjectRevision: integerFlag(rest, '--revision'),
        subjectHash: requireFlag(rest, '--hash'),
        capability: requireFlag(rest, '--capability'),
        claimedActor: flag(rest, '--actor-kind') === undefined ? undefined : { kind: flag(rest, '--actor-kind'), actorId: flag(rest, '--actor-id') ?? 'forged' },
      }),
    });
    return 0;
  }
  const baseRevision = () => integerFlag(rest, '--base-revision');
  const claimedActor = flag(rest, '--actor-kind') === undefined ? undefined : { kind: flag(rest, '--actor-kind') };
  if (command === 'idea') {
    emit({ ok: true, command, ...core.createIdea({ workspaceDir, operationId, actor: actor(), claimedActor, baseRevision: baseRevision(), title: requireFlag(rest, '--title'), hypothesis: requireFlag(rest, '--hypothesis'), change: requireFlag(rest, '--change'), mechanism: requireFlag(rest, '--mechanism'), falsifier: requireFlag(rest, '--falsifier'), sourceIds: requireFlag(rest, '--sources').split(',').filter(Boolean) }) });
    return 0;
  }
  if (command === 'plan') {
    emit({ ok: true, command, ...core.createPlan({ workspaceDir, operationId, actor: actor(), claimedActor, baseRevision: baseRevision(), ideaId: requireFlag(rest, '--idea'), baseline: requireFlag(rest, '--baseline'), variable: requireFlag(rest, '--variable'), fixedConditions: (flag(rest, '--fixed') ?? '').split(',').filter(Boolean), split: requireFlag(rest, '--split'), seedPolicy: requireFlag(rest, '--seed'), metric: requireFlag(rest, '--metric'), metricUnit: requireFlag(rest, '--unit'), budget: requireFlag(rest, '--budget'), stopCondition: requireFlag(rest, '--stop') }) });
    return 0;
  }
  if (command === 'assignment') {
    emit({ ok: true, command, ...core.exportAssignment({ workspaceDir, operationId, actor: actor(), claimedActor, baseRevision: baseRevision(), planId: requireFlag(rest, '--plan'), outPath: flag(rest, '--out') }) });
    return 0;
  }
  if (command === 'record') {
    emit({ ok: true, command, ...core.recordRun({ workspaceDir, operationId, actor: actor(), claimedActor, baseRevision: baseRevision(), manifestPath: requireFlag(rest, '--manifest') }) });
    return 0;
  }
  if (command === 'review') {
    const judgment = requireFlag(rest, '--judgment');
    if (judgment !== 'supported' && judgment !== 'contradicted' && judgment !== 'inconclusive') throw new ResearchCoreError('INVALID_INPUT', '--judgment must be supported, contradicted, or inconclusive');
    emit({ ok: true, command, ...core.submitReview({ workspaceDir, operationId, actor: actor(), claimedActor, baseRevision: baseRevision(), runIds: requireFlag(rest, '--runs').split(',').filter(Boolean), judgment, reason: requireFlag(rest, '--reason'), nextStep: requireFlag(rest, '--next') }) });
    return 0;
  }
  if (command === 'search') {
    emit({ ok: true, command, ...core.searchPapers({ workspaceDir, operationId, actor: actor(), claimedActor, baseRevision: baseRevision(), query: requireFlag(rest, '--query') }) });
    return 0;
  }
  if (command === 'tree') {
    emit({ ok: true, command, ...core.tree(workspaceDir) });
    return 0;
  }
  throw new ResearchCoreError('INVALID_INPUT', `unknown command ${command}`);
}

function integerFlag(argv: string[], name: string): number {
  const value = Number(requireFlag(argv, name));
  if (!Number.isSafeInteger(value) || value < 0) throw new ResearchCoreError('INVALID_INPUT', `${name} must be a non-negative integer`);
  return value;
}

function cryptoId(): string {
  return globalThis.crypto.randomUUID();
}

const entry = process.argv[1]?.replaceAll('\\', '/');
if (entry?.endsWith('/packages/research-interfaces/src/cli.ts')) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof ResearchCoreError || error instanceof BootstrapError ? error.code : 'INVALID_INPUT';
    const message = error instanceof Error ? error.message : String(error);
    emit({ ok: false, code, message, ...searchFailure(error) });
    process.exitCode = 1;
  }
}

export { main };
