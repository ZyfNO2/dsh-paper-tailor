/**
 * Rewrite the machine-specific `sourceUri` values in the frozen phase2 manifest.
 *
 * WHY
 * ---
 * `fixtures/phase2-source-pack/manifest.json` is a FROZEN provenance artifact: its
 * digests were derived from real git objects and real bytes, and re-deriving them
 * requires the source history (which a release export does not carry — see the
 * note at the top of build-manifest.ts). So the file ships as-is, and only the one
 * machine-specific field is rewritten.
 *
 * `sourceUri` records WHERE a pinned entry came from. In the original checkout that
 * was an absolute `file:///F:/dsh-paper` path: true there, false anywhere else, and
 * a leak of the author's disk layout. The contract only requires it to be a
 * non-empty string (contracts/experiments.ts, expAssertId) and nothing parses it as
 * a URL, so it is replaced with an explicit marker that says what it means.
 *
 * The `commit`, `contentHash`, `gitBlobSha1` and tree values are NOT touched: those
 * are the pins, and rewriting them would turn a verifiable manifest into a lie.
 *
 * Idempotent: re-running it leaves an already-rewritten manifest unchanged.
 *
 * Usage:
 *   node scripts/release/neutralize-fixture-provenance.mjs [--write]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Frozen provenance artifacts that must not carry a machine-local path. */
const TARGETS = ['fixtures/phase2-source-pack/manifest.json'];

/**
 * The replacement marker.
 *
 * Deliberately not a URL: a `file://` URL would claim a location that does not
 * exist in this tree, and an `https://` URL would claim an upstream that the
 * source checkout never had. This says exactly what is known.
 */
const REPLACEMENT = 'repo-relative:source-checkout';

/**
 * Any absolute `file://` path.
 *
 * Deliberately NOT keyed on one directory name: the release has to strip whatever
 * drive-letter path the source checkout happened to use, not just the one this run
 * saw. A `file:///` URL with a drive letter can only name a machine-local location,
 * so matching the shape is both broader and more honest than matching a literal name.
 */
const MACHINE_LOCAL = /^file:\/\/\/[A-Za-z]:[\\/]/;

function isMachineLocal(value) {
  return MACHINE_LOCAL.test(value);
}

let changed = 0;
for (const relativePath of TARGETS) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) throw new Error(`missing frozen artifact: ${relativePath}`);
  const text = fs.readFileSync(absolutePath, 'utf8');
  const parsed = JSON.parse(text);

  const visit = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'sourceUri' && typeof value === 'string' && isMachineLocal(value)) {
        // Keep the archive-relative suffix so the marker still identifies WHICH
        // archive a module came from; only the machine prefix is dropped.
        const suffix = value.replace(/^file:\/\/\/[A-Za-z]:[\\/][^\\/]*[\\/]/, '').replace(/^file:\/\/\/[A-Za-z]:[\\/]/, '');
        node[key] = suffix === '' ? REPLACEMENT : `${REPLACEMENT}/${suffix}`;
        changed += 1;
      } else {
        visit(value);
      }
    }
  };
  visit(parsed);

  // The `unresolved` notes describe the ORIGINAL checkout's missing remote. Rewrite
  // the sentence that claims sourceUri names a local checkout, since it no longer does.
  const rewritten = JSON.stringify(parsed, null, 2) + '\n';
  const notes = rewritten
    .split('\n')
    .map((line) =>
      line.includes('sourceUri names the local checkout only')
        ? line.replace(
            'sourceUri names the local checkout only',
            'sourceUri records that the entry came from the source checkout (a release export does not carry that path)',
          )
        : line,
    )
    .join('\n');

  if (process.argv.includes('--write')) {
    fs.writeFileSync(absolutePath, notes, 'utf8');
    console.log(`rewrote ${changed} machine-local sourceUri value(s) in ${relativePath}`);
  } else if (notes !== text) {
    throw new Error(`${relativePath} still contains machine-local provenance; re-run with --write`);
  } else {
    console.log(`${relativePath} is already free of machine-local provenance`);
  }
}
