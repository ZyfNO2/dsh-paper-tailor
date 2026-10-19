import type { Context } from '@deepseek-ai/cordis';
import { apply as applyWorkbenchHost, type EvolverWorkbenchHostConfig } from './workbench-host.ts';

/** Production redesign requires an actual browser fence before registering reads. */
export const name = 'evolver-redesign-workbench-host';
export const inject = ['webServer', 'connection'];
export const provide = ['evolverWorkbench'];

/**
 * `config` has no default on purpose, and the guard below is the first thing that
 * runs.
 *
 * A Loader entry that omits its `config:` block hands `apply` an empty object (or
 * undefined, depending on how the entry was inserted). Without this guard the
 * failure surfaces as `Cannot read properties of undefined (reading 'required')`
 * from a line that has nothing to do with the real problem — the operator reads it
 * as a broken plugin, not as a missing config block. Naming the requirement makes
 * the activation error say what to fix.
 */
export function apply(ctx: Context, config: EvolverWorkbenchHostConfig | undefined): void {
  const connection = ctx.get('connection') as { requestRejection?: unknown } | undefined;
  if (typeof connection?.requestRejection !== 'function') throw new Error('Research workbench requires DSH connection.requestRejection');
  if (config === undefined || config === null || typeof config !== 'object') {
    throw new Error(
      'Research workbench host requires a config block (repoRoot plus the artifact roots); ' +
        'the Loader entry that inserts it must declare one',
    );
  }
  if (config.required !== true) throw new Error('Research workbench requires mandatory scoped read grants');
  applyWorkbenchHost(ctx, config);
}
