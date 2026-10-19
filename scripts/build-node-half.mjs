/**
 * Emit the Node half of `dsh-evolver-ui` (lib/index.js).
 *
 * The package's `main` points at `lib/index.js`; the host Loader imports that
 * file as a plugin and calls its `apply`. It is deliberately plain JavaScript
 * (no TS syntax) because the type-stripping loader refuses TypeScript under
 * node_modules — the same constraint the client bundle lives with.
 *
 * `src/index.ts` is a no-op plugin with no imports, so this is a straight
 * strip of the two declarations plus the file's leading comment. Generating it
 * (instead of shipping a hand-edited copy) keeps `lib/` a build artifact.
 *
 * Usage: node scripts/build-node-half.mjs
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(repoRoot, 'packages/evolver-ui/src/index.ts');
const target = path.join(repoRoot, 'packages/evolver-ui/lib/index.js');

const text = fs.readFileSync(source, 'utf8');

// Strip TypeScript-only syntax this file actually uses: type annotations on the
// exported `apply` and its return type. Anything else would be a source change
// this script is not allowed to silently swallow.
const stripped = text
  .replace(/export function apply\(\): void \{/g, 'export function apply() {')
  .replace(/\n\s*export function apply\(\): void;?\s*$/m, '');

if (/\b(interface|type)\s+\w+\s*[=:{]/.test(stripped.replace(/\/\*[\s\S]*?\*\//g, ''))) {
  throw new Error(`${source} gained a type declaration this build step does not strip; extend the stripper`);
}
if (/:\s*(void|string|number|boolean)\b/.test(stripped.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'/g, ''))) {
  throw new Error(`${source} still contains a type annotation after stripping; extend the stripper`);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, stripped, 'utf8');
console.log(`wrote ${path.relative(repoRoot, target)} (${Buffer.byteLength(stripped)} bytes)`);
