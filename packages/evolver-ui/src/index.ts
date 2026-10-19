/**
 * dsh-evolver-ui — Node half.
 *
 * Deliberate no-op plugin. The Loader requires every in-tree entry to be a
 * valid plugin (function or { apply }); this module satisfies that with an
 * empty apply so the client scanner can see the package's `dsh.client`
 * declaration without mounting any host-side behavior. The workbench host
 * half lives in @dsh/evolver (adapters/dsh/workbench-host.ts).
 */
export const name = 'dsh-evolver-ui';

export function apply(): void { /* client-only plugin: no host behavior */ }
