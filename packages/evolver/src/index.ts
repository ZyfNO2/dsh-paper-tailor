/**
 * @dsh/evolver root exports.
 */

export * from './contracts/index.ts';
export * from './domain/index.ts';
export * from './application/index.ts';
export * from './adapters/dsh/index.ts';

import * as plugin from './adapters/dsh/index.ts';
export default plugin;
