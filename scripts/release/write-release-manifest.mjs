/**
 * Record the release file manifest with hashes.
 *
 * WHAT THIS IS FOR
 * ----------------
 * The Plan requires `verification/release-files.json`: every published relative path,
 * its category, its SHA-256, and the generation command for anything generated. That
 * is what makes "the delivered tree is the verified tree" checkable instead of
 * asserted.
 *
 * WHY IT SCANS INSTEAD OF TRUSTING release-files.txt
 * --------------------------------------------------
 * `release-files.txt` is the INTENT (a whitelist of patterns). The manifest is the
 * RESULT (the files that actually exist). They differ by design: `packages/evolver-ui/lib/**`
 * is produced by the build, `offline-runtime.generated.ts` is produced by a script,
 * and `node_modules` is installed. Deriving the manifest from the tree is the only way
 * to catch a whitelisted path that silently exported nothing.
 *
 * Paths are relative and forward-slashed. No absolute path, drive letter or account
 * name is written, so the manifest can be published.
 *
 * Usage:
 *   node scripts/release/write-release-manifest.mjs [--write]
 *
 * Without `--write` it verifies the recorded manifest still matches and fails on drift.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifestPath = path.join(repoRoot, 'verification/release-files.json');

/**
 * Never part of the release payload.
 *
 * `node_modules` is installed from lockfiles, not shipped. The `.dsh-verify-home`
 * directory is the isolated host home used for verification and contains a boot
 * token. `verification/results` holds run output, which is recorded separately so a
 * stale log cannot look like a fresh pass.
 */
const EXCLUDED = [
  /^packages\/evolver\/\.probe-ts(\/|$)/,
  /^\.design(\/|$)/, /^demo(\/|$)/, /^docs(\/|$)/,
  /^release-files\.txt$/, /(^|\/)\.env(?:\..*)?$/,
  /(^|\/)\.credentials\.ya?ml$/, /(^|\/)[^/]*vault[^/]*(\/|$)/,
  /\.private\./, /\.(?:log|err|pid|pem|p12|pfx)$/,

  /(^|\/)\.dsh-guidance-verify-home(\/|$)/,
  /^demo\/guidance-(?:smoke|fixed)-20261018(\/|$)/,
  /(^|\/)__pycache__(\/|$)/, /\.py[co]$/i,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.dsh-verify-home(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)data(\/|$)/,
  /(^|\/)artifacts(\/|$)/,
  /(^|\/)verification\/results(\/|$)/,

  // The export log is produced by the export step, not authored source.
  /^release-files\.csv$/,
  // `host-modules.json` records a `generatedAt` timestamp and the absolute host path,
  // so its bytes change on every link run and it must not be a hash-pinned payload
  // file. It is an install record, not release content.
  /^host-modules\.json$/,
];

/**
 * Category per path. The Plan's whitelist is organised by these same buckets, so the
 * manifest can be read against it.
 */
const CATEGORIES = [
  { match: /^packages\/evolver\//, category: 'package:evolver' },
  { match: /^packages\/evolver-ui\/src\//, category: 'package:evolver-ui' },
  { match: /^packages\/evolver-ui\/lib\//, category: 'package:evolver-ui (generated build output)' },
  { match: /^packages\/evolver-ui\//, category: 'package:evolver-ui' },
  { match: /^packages\/evolver-bundle\//, category: 'package:evolver-bundle' },
  { match: /^\.dsh\/skills\//, category: 'skill:project-native' },
  { match: /^skills\//, category: 'skill:plugin-read' },
  { match: /^configs\//, category: 'config' },
  { match: /^protocols\//, category: 'protocol' },
  { match: /^fixtures\//, category: 'fixture' },
  { match: /^tests\//, category: 'test' },
  { match: /^tools\/vendor\//, category: 'vendor:type-pin' },
  { match: /^tools\//, category: 'toolchain' },
  { match: /^scripts\//, category: 'script' },
  { match: /^verification\//, category: 'verification' },
  { match: /^docs\//, category: 'handoff' },
  { match: /^\.gitignore$/, category: 'root-manifest' },
  { match: /^(package\.json|package-lock\.json|pnpm-workspace\.yaml|release-files\.txt|host-modules\.json)$/, category: 'root-manifest' },
];

/** Generated files and the command that produces them. */
const GENERATED = [
  {
    match: /^packages\/evolver-ui\/lib\/client\.js$/,
    generatedBy: 'node packages/evolver-ui/build-client.mjs',
  },
  {
    match: /^packages\/evolver-ui\/lib\/types\/.*\.d\.ts$/,
    generatedBy: 'tsc -p packages/evolver-ui/tsconfig.build.json',
  },
  {
    match: /^packages\/evolver-ui\/lib\/index\.js$/,
    generatedBy: 'node scripts/build-node-half.mjs',
  },
  {
    match: /^packages\/evolver-ui\/src\/client\/general\/report-core\/offline-runtime\.generated\.ts$/,
    generatedBy: 'node --experimental-strip-types scripts/build-report-offline-runtime.ts --write',
  },
  {
    match: /^package-lock\.json$/,
    generatedBy: 'npm install',
  },
  {
    match: /^host-modules\.json$/,
    generatedBy: 'node scripts/release/link-host-modules.mjs',
  },
];

function categoryOf(relativePath) {
  for (const rule of CATEGORIES) if (rule.match.test(relativePath)) return rule.category;
  return 'other';
}

function generatedByOf(relativePath) {
  for (const rule of GENERATED) if (rule.match.test(relativePath)) return rule.generatedBy;
  return undefined;
}

/** Walk the tree, skipping excluded directories. */
function collect(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    if (EXCLUDED.some((pattern) => pattern.test(relative))) continue;
    if (entry.isSymbolicLink()) throw new Error(`refusing to include a link in the release manifest: ${relative}`);
    if (entry.isDirectory()) collect(absolute, files);
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

// The manifest cannot hash itself: including it would make every write change the file
// it just recorded, so the recorded hash could never match on the next run. It IS part
// of the payload, so it is listed with an explicit null hash instead of being omitted —
// omitting it meant a clean export silently lost the file the verifier reads.
const SELF_PATH = 'verification/release-files.json';
const files = collect(repoRoot)
  .filter((relative) => relative !== SELF_PATH)
  .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
const records = files.map((relative) => {
  const bytes = fs.readFileSync(path.join(repoRoot, relative));
  return {
    path: relative,
    category: categoryOf(relative),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    ...(generatedByOf(relative) === undefined ? {} : { generatedBy: generatedByOf(relative) }),
  };
});

records.push({
  path: SELF_PATH,
  category: 'verification',
  sha256: null,
  bytes: null,
  note: 'this manifest; a file cannot hash itself, so its digest is null by design',
});

const byCategory = {};
for (const record of records) byCategory[record.category] = (byCategory[record.category] ?? 0) + 1;

const manifest = {
  schemaVersion: 1,
  note: 'Paths are repo-relative and forward-slashed. node_modules, the isolated verification DSH home, and runtime state are not part of the release payload. `generatedBy` names the command that produces a build artifact; those files are verified by rebuilding, not by trusting the copy.',
  totals: {
    files: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    byCategory,
  },
  files: records,
};

const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, serialized, 'utf8');
  console.log(`wrote ${path.relative(repoRoot, manifestPath)}: ${records.length} files, ${manifest.totals.bytes.toLocaleString()} bytes`);
  for (const [category, count] of Object.entries(byCategory).sort()) console.log(`  ${String(count).padStart(4)}  ${category}`);
} else if (!fs.existsSync(manifestPath)) {
  console.error(`missing ${path.relative(repoRoot, manifestPath)}; run with --write`);
  process.exit(1);
} else {
  const recorded = fs.readFileSync(manifestPath, 'utf8');
  if (recorded === serialized) {
    console.log(`release manifest matches the tree (${records.length} files)`);
  } else {
    const recordedParsed = JSON.parse(recorded);
    const recordedPaths = new Set(recordedParsed.files.map((file) => file.path));
    const currentPaths = new Set(records.map((file) => file.path));
    const added = [...currentPaths].filter((file) => !recordedPaths.has(file));
    const removed = [...recordedPaths].filter((file) => !currentPaths.has(file));
    const changed = records
      .filter((file) => recordedPaths.has(file.path))
      .filter((file) => recordedParsed.files.find((entry) => entry.path === file.path)?.sha256 !== file.sha256)
      .map((file) => file.path);
    console.error('release manifest is stale:');
    for (const file of added.slice(0, 20)) console.error(`  added:   ${file}`);
    for (const file of removed.slice(0, 20)) console.error(`  removed: ${file}`);
    for (const file of changed.slice(0, 20)) console.error(`  changed: ${file}`);
    console.error('re-run with --write after confirming the change is intended');
    process.exit(1);
  }
}
