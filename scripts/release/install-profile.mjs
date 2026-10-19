/**
 * Install (or update) this release tree as a DSH profile overlay.
 *
 * WHY A GENERATED OVERLAY
 * -----------------------
 * A profile has to name the tree's own files. A checked-in overlay would either
 * hard-code the author's drive letter or break the moment the tree is renamed, so
 * this script writes one from the tree's real location into a profile the caller
 * names.
 *
 * WHY IT CARRIES THE FULL CONFIG
 * ------------------------------
 * The obvious alternative is to declare `packages/evolver-bundle` as a profile
 * bundle (`dsh.profile.bundles`) and let its `cordis.patch.yml` supply the config.
 * That does NOT work for this package, for two independent reasons:
 *
 *   1. `dsh plugin add file:<bundle>` COPIES the bundle into the profile's
 *      `node_modules`. Its patch names plugins relative to itself
 *      (`./../evolver/src/index.ts`), so the anchored URLs then point at
 *      `<profile>/node_modules/evolver/...`, which does not exist.
 *   2. Even with correct paths, `packages/evolver` exports `.ts` and is loaded
 *      through Node's type stripping. Node refuses to strip types for a file under
 *      `node_modules` ("Stripping types is currently unsupported for files under
 *      node_modules"), so a profile-installed copy cannot start.
 *
 * So the overlay is generated to point at the SOURCE files in this tree (outside any
 * `node_modules`) and repeats the config that `packages/evolver-bundle/cordis.patch.yml`
 * declares. `readBundleConfig()` below reads that file, so the two cannot drift: the
 * bundle patch remains the single definition of what the plugin is configured with,
 * and this script only rewrites the module specifiers.
 *
 * SAFETY
 * ------
 * - It never touches a profile it was not pointed at.
 * - It backs up the existing patch before writing.
 * - It refuses to overwrite a DIFFERENT `evolver-*` entry set unless `--force`.
 * - It does not start or restart any host, and it does not create the profile.
 *
 * Usage:
 *   node scripts/release/install-profile.mjs --profile <dir-or-patch.yml> [--force]
 *   node scripts/release/install-profile.mjs --profile web     # $DSH_HOME/profiles/web
 *   node scripts/release/install-profile.mjs --print           # stdout only
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundlePatchPath = path.join(repoRoot, 'packages/evolver-bundle/cordis.patch.yml');

/**
 * Read the bundle patch and return its insert entries as plain data.
 *
 * A hand-rolled reader is used instead of a YAML dependency because this script
 * must run before `npm install` on a fresh clone. It understands exactly the shape
 * the bundle patch uses (block arrays, `id`/`name`/`config`, nested maps, scalars)
 * and throws on anything else rather than guessing.
 */
function readBundlePatch(text) {
  const lines = text.split('\n');
  const entries = [];
  let current = null;
  let inInsert = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    if (line.startsWith('- insert:')) {
      inInsert = true;
      continue;
    }
    if (!inInsert) continue;

    const entryMatch = /^ {4}- id: (.+)$/.exec(line);
    if (entryMatch) {
      current = { id: entryMatch[1].trim(), lines: [] };
      entries.push(current);
      continue;
    }
    if (current === null) continue;
    if (/^ {6}/.test(line) || line.trim() === '') {
      current.lines.push(line);
    } else {
      current = null;
    }
  }

  return entries.map((entry) => {
    const body = entry.lines.join('\n');
    const nameMatch = /^ {6}name: '(.+)'$/m.exec(body);
    if (!nameMatch) throw new Error(`bundle patch entry ${entry.id} has no quoted name`);
    // Everything after the `name:` line is the config block, verbatim.
    const nameLineIndex = body.split('\n').findIndex((line) => /^ {6}name: /.test(line));
    const configLines = body.split('\n').slice(nameLineIndex + 1);
    return { id: entry.id, name: nameMatch[1], configLines };
  });
}

/**
 * Rewrite one plugin specifier so it points at the real file in this tree.
 *
 * A bare package name (`dsh-evolver-ui`) is left alone: it is resolved by the host
 * Loader through the profile's `node_modules`, which is where a published client
 * half is supposed to live. Only file-like specifiers (relative or absolute paths)
 * are rewritten.
 */
function rewriteSpecifier(entry, patchDirectory) {
  const looksLikePath =
    entry.name.startsWith('./') || entry.name.startsWith('../') || path.isAbsolute(entry.name);
  if (!looksLikePath) return { specifier: entry.name, absolute: false, bare: true };

  // The bundle patch names plugins relative to the bundle directory.
  const bundleDirectory = path.dirname(bundlePatchPath);
  const absolute = path.resolve(bundleDirectory, entry.name);
  if (!fs.existsSync(absolute)) throw new Error(`bundle patch names a file that does not exist: ${absolute}`);

  const relative = path.relative(patchDirectory, absolute).split(path.sep).join('/');
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    return { specifier: pathToFileURL(absolute).href, absolute: true };
  }
  return { specifier: relative.startsWith('.') ? relative : `./${relative}`, absolute: false };
}

function renderOverlay(patchDirectory) {
  const bundleEntries = readBundlePatch(fs.readFileSync(bundlePatchPath, 'utf8'));
  if (bundleEntries.length === 0) throw new Error(`no insert entries found in ${bundlePatchPath}`);

  const header = [
    '# Generated by scripts/release/install-profile.mjs — do not hand-edit.',
    '#',
    '# The plugin specifiers are relative to THIS file and are rewritten to file://',
    '# URLs by the host (`anchorInsertedPluginNames` in dsh-app-boot), so this overlay',
    '# contains no absolute path when the profile and the tree share a drive.',
    '#',
    '# The config blocks are copied from packages/evolver-bundle/cordis.patch.yml:',
    '# the bundle cannot be installed into a profile (its patch would then name',
    '# plugins under node_modules, where Node refuses to strip TypeScript types).',
    '',
  ];

  const body = [];
  let sawAbsolute = false;
  for (const entry of bundleEntries) {
    const { specifier, absolute } = rewriteSpecifier(entry, patchDirectory);
    if (absolute) sawAbsolute = true;
    body.push(`- insert:`);
    body.push(`    - id: ${entry.id}`);
    body.push(`      name: '${specifier}'`);
    for (const line of entry.configLines) body.push(line);
    body.push('');
  }

  if (sawAbsolute) {
    header.push(
      '# NOTE: the profile directory and this tree are on different drives, so the',
      '# plugin names below are absolute file:// URLs instead of relative ones.',
      '# Moving either one requires re-running this script.',
      '',
    );
  }
  return [...header, ...body].join('\n');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') {
      options.profile = argv[index + 1];
      index += 1;
    } else if (arg === '--force') {
      options.force = true;
    } else if (arg === '--print') {
      options.print = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/release/install-profile.mjs --profile <dir|patch.yml> [--force] [--print]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Resolve `--profile` to the patch file path, accepting a profile name or directory. */
function resolveProfilePatch(value) {
  if (value === undefined) throw new Error('--profile is required (a profile name, directory, or patch.yml path)');
  if (value.endsWith('.yml') || value.endsWith('.yaml')) return path.resolve(value);
  const dshHome = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  const directory = path.isAbsolute(value) ? value : path.join(dshHome, 'profiles', value);
  return path.join(directory, 'cordis.patch.yml');
}

/**
 * Merge the generated entries into an existing patch file.
 *
 * A profile patch is ONE YAML document whose root is an array. Appending a second
 * array after the first is not valid YAML, so the scaffolded `[]` placeholder is
 * replaced and a real block array receives the entries as new items of the SAME
 * document (no `---`, which would start a second document).
 */
function mergeIntoPatchList(existing, overlay) {
  if (existing.trim() === '') return overlay;

  const lines = existing.split('\n');
  let bodyStart = 0;
  while (bodyStart < lines.length) {
    const line = lines[bodyStart];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      bodyStart += 1;
      continue;
    }
    break;
  }
  const header = lines.slice(0, bodyStart).join('\n');
  const body = lines.slice(bodyStart).join('\n').trim();

  if (body === '[]') return `${header.trimEnd()}\n\n${overlay}`;
  if (body.startsWith('[') && !body.includes('\n')) {
    throw new Error('the profile patch is a flow-style YAML array; rewrite it as a block array before installing');
  }
  if (body !== '' && !body.startsWith('-')) {
    throw new Error(`the profile patch does not start with a block array item: ${JSON.stringify(body.slice(0, 80))}`);
  }
  return `${existing.trimEnd()}\n\n${overlay}`;
}

const options = parseArgs(process.argv.slice(2));

if (options.print) {
  process.stdout.write(renderOverlay(process.cwd()));
  process.exit(0);
}

const patchPath = resolveProfilePatch(options.profile);
const patchDirectory = path.dirname(patchPath);
const overlay = renderOverlay(patchDirectory);
const existing = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
const MARKER = '# Generated by scripts/release/install-profile.mjs';

if (existing.includes(MARKER)) {
  if (existing.includes(overlay.trim())) {
    console.log(`profile overlay already up to date: ${patchPath}`);
    process.exit(0);
  }
  const updated = existing.slice(0, existing.indexOf(MARKER)) + overlay;
  fs.writeFileSync(`${patchPath}.bak`, existing, 'utf8');
  fs.writeFileSync(patchPath, updated, 'utf8');
  console.log(`updated generated overlay in ${patchPath} (backup: ${patchPath}.bak)`);
  process.exit(0);
}

const bundleEntries = readBundlePatch(fs.readFileSync(bundlePatchPath, 'utf8'));
const foreignEntries = bundleEntries.filter((entry) =>
  new RegExp(`^\\s*- id: ${entry.id}\\s*$`, 'm').test(existing),
);
if (foreignEntries.length > 0 && !options.force) {
  throw new Error(
    `${patchPath} already declares ${foreignEntries.map((entry) => entry.id).join(', ')} with a different ` +
      'configuration. Inspect it and re-run with --force to replace it (a backup is written).',
  );
}

fs.mkdirSync(patchDirectory, { recursive: true });
if (existing.length > 0) fs.writeFileSync(`${patchPath}.bak`, existing, 'utf8');
fs.writeFileSync(patchPath, mergeIntoPatchList(existing, overlay), 'utf8');
console.log(`installed ${bundleEntries.length} entries into ${patchPath}`);
if (existing.length > 0) console.log(`previous profile saved: ${patchPath}.bak`);
console.log('The host reads the overlay at activation: restart the profile to load the plugin.');
