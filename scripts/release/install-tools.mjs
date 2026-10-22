/**
 * Install the pinned tool closures that are deliberately NOT part of the
 * root npm workspace:
 *
 *   tools/mermaid      — Mermaid 11.17.2 (BR-FE3: vendored, never a runtime CDN)
 *   tools/ts-toolchain — TypeScript 5.9.3 + @types/node 24.10.1
 *   tools/host-test    — provenance-matched DSH SDK test dependencies
 *
 * They each carry their own package-lock.json, so `npm ci` inside the tool
 * directory is the reproducible install. This script only drives that; it
 * declares no versions of its own.
 *
 * Usage:
 *   node scripts/release/install-tools.mjs [--registry <url>]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TOOLS = ['tools/mermaid', 'tools/ts-toolchain', 'tools/host-test'];

function parseArgs(argv) {
  const options = { registry: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--registry') {
      options.registry = argv[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/release/install-tools.mjs [--registry <url>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const tool of TOOLS) {
  const directory = path.join(repoRoot, tool);
  if (!fs.existsSync(path.join(directory, 'package.json'))) throw new Error(`missing ${tool}/package.json`);
  if (!fs.existsSync(path.join(directory, 'package-lock.json'))) throw new Error(`missing ${tool}/package-lock.json`);

  const args = ['ci', '--no-audit', '--no-fund', '--loglevel=error'];
  if (options.registry !== undefined) args.push(`--registry=${options.registry}`);

  console.log(`installing ${tool} (npm ci) ...`);
  // `shell: true` is only needed on Windows because `npm` is a .cmd shim. The
  // args here are a fixed literal list plus an optional registry URL, so no
  // untrusted input reaches the shell.
  const result = spawnSync(npm, args, { cwd: directory, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`npm ci failed in ${tool} (exit ${result.status})`);
}

console.log(`installed ${TOOLS.length} tool closures from their own lockfiles`);
