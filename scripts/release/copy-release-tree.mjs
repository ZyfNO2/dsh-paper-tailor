/**
 * Copy the whitelisted release files from the source workspace into this tree.
 *
 * Read-only on the source: nothing here writes to the source root. The script
 * REFUSES to follow a junction or symlink, because that is exactly how an
 * installed host tree (the original workspace's `node_modules` junction) would
 * silently leak into a "clean" release.
 *
 * Usage:
 *   node scripts/release/copy-release-tree.mjs <sourceRoot> <targetRoot>
 *
 * Writes:
 *   release-files.csv  — every copied file with its SHA-256 and size.
 *   release-files.txt  — the whitelist it read (already in the target).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

const [sourceArg, targetArg] = process.argv.slice(2);
if (!sourceArg || !targetArg) {
  throw new Error('usage: node scripts/release/copy-release-tree.mjs <sourceRoot> <targetRoot>');
}

const source = path.resolve(sourceArg);
const target = path.resolve(targetArg);
const manifestPath = path.join(target, 'release-files.txt');

if (!fs.existsSync(manifestPath)) throw new Error(`manifest missing: ${manifestPath}`);
if (!fs.existsSync(source)) throw new Error(`source missing: ${source}`);
if (path.resolve(source) === path.resolve(target)) throw new Error('source and target are the same tree');

/** Build artifacts are generated in the target; they are never copied. */
const EXCLUDED_PREFIXES = ['packages/evolver-ui/lib/'];
const isExcluded = (relative) =>
  EXCLUDED_PREFIXES.some((prefix) => relative.toLowerCase().startsWith(prefix.toLowerCase()));

/** Refuse anything that is not a plain file or a plain directory. */
function assertPlain(targetPath) {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink()) throw new Error(`refusing to follow link: ${targetPath}`);
  return stat;
}

const entries = fs
  .readFileSync(manifestPath, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== '' && !line.startsWith('#'));

const copied = [];
for (const entry of entries) {
  const normalized = entry.replaceAll('\\', '/');
  const isTree = normalized.endsWith('/**');
  const relativeBase = isTree ? normalized.slice(0, -3) : normalized;
  const sourcePath = path.join(source, relativeBase);
  if (!fs.existsSync(sourcePath)) throw new Error(`whitelisted path missing in source: ${relativeBase}`);

  const files = [];
  if (isTree) {
    assertPlain(sourcePath);
    const walk = (directory) => {
      for (const dirent of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, dirent.name);
        if (dirent.isSymbolicLink()) throw new Error(`refusing to follow link: ${full}`);
        if (dirent.isDirectory()) walk(full);
        else if (dirent.isFile()) files.push(full);
      }
    };
    walk(sourcePath);
  } else {
    assertPlain(sourcePath);
    files.push(sourcePath);
  }

  for (const file of files) {
    const relative = path.relative(source, file).replaceAll('\\', '/');
    if (isExcluded(relative) || /(^|\/)__pycache__(\/|$)|\.py[co]$/i.test(relative)) continue;

    const destination = path.join(target, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(file, destination);

    const bytes = fs.statSync(destination).size;
    const sha256 = createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
    copied.push({ path: relative, sha256, bytes });
  }
}

copied.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const csv = ['path,sha256,bytes', ...copied.map((row) => `${row.path},${row.sha256},${row.bytes}`)].join('\n') + '\n';
fs.writeFileSync(path.join(target, 'release-files.csv'), csv, 'utf8');

const totalBytes = copied.reduce((sum, row) => sum + row.bytes, 0);
console.log(`copied ${copied.length} files (${totalBytes.toLocaleString()} bytes) from ${source}`);
