/**
 * Link the DSH host's platform modules into this release tree.
 *
 * WHY THIS EXISTS
 * ---------------
 * This package is a DSH HOST EXTENSION, not a standalone app. At runtime the
 * host resolves these modules from its own installation:
 *
 *   @deepseek-ai/cordis, @deepseek-ai/dsh-tools, @deepseek-ai/dsh-llm,
 *   @deepseek-ai/dsh-skill, @deepseek-ai/dsh-session, @deepseek-ai/dsh-agent,
 *   @deepseek-ai/dsh-scope, @deepseek-ai/dsh-util-values,
 *   @deepseek-ai/schemastery, @deepseek-ai/cosmokit, react, react-dom, fflate, yaml
 *
 * They are PEER/PLATFORM modules, not bundled dependencies: pulling a second
 * copy of cordis or react into the client bundle would break the host's module
 * identity (`instanceof`, service registration) — see the `dsh.client.inject`
 * and peerDependencies declarations in packages/evolver-ui/package.json.
 *
 * The original workspace satisfied them through a `node_modules` JUNCTION into
 * a local DSH Desktop install. A release tree must not ship that junction, so
 * this script re-creates the same resolution deliberately and records where the
 * modules came from. Nothing here is copied into the repository.
 *
 * REACT IS SPECIAL. The host's `$DSH_HOME/profiles/node_modules` base is a set
 * of junctions that do NOT all point into one install: on the machine this was
 * developed against, `react` resolved into the DSH Desktop app while `react-dom`
 * resolved into a separate checkout. Bundling those two together produces two
 * React instances, and every hook then throws "Cannot read properties of null
 * (reading 'useState')" because the dispatcher was set on the other copy.
 *
 * So react/react-dom are NOT linked from the host: they are declared as
 * devDependencies and installed from npm, which guarantees one shared version
 * pair (react 18.3.1 + react-dom 18.3.1). They are build-time inputs to the
 * offline report runtime; at host runtime the client bundle receives React from
 * the host's own module table.
 *
 * Usage:
 *   node scripts/release/link-host-modules.mjs [--host-node-modules <path>]
 *
 * Resolution order for the host install:
 *   1. --host-node-modules <path>
 *   2. $DSH_HOST_NODE_MODULES
 *   3. $DSH_HOME/profiles/node_modules (the host loader's bare-module base)
 *   4. the DSH Desktop install that owns the `dsh` launcher on PATH
 *   5. a sibling `node_modules` that already resolves the platform modules
 *
 * The script fails loud when a required platform module is absent. It never
 * invents a fallback, and it never silently downgrades a missing host module
 * into "build passed anyway".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Platform modules the host must provide, by their package name. */
const PLATFORM_MODULES = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-skill',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-util-values',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
];

function parseArgs(argv) {
  const options = { ifAvailable: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host-node-modules') {
      options.hostNodeModules = argv[index + 1];
      index += 1;
    } else if (arg === '--if-available') {
      // Used by the npm `postinstall` hook: `npm install` drops junctions it did
      // not create, so the host links must be re-established afterwards. On a
      // machine without a DSH install this warns instead of failing the install;
      // `npm run verify:beta` is the step that fails loudly.
      options.ifAvailable = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/release/link-host-modules.mjs [--host-node-modules <path>] [--if-available]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/**
 * Locate the host platform modules.
 *
 * A DSH install is TWO things on disk:
 *
 *   <install>/DeepSeek Harness.exe          — the launcher
 *   <install>/resources/app.asar            — the app (packed)
 *   <install>/resources/app.asar.unpacked/  — only a few native packages
 *   $DSH_HOME/profiles/node_modules/        — the bare-module base the loader
 *                                             resolves plugin specifiers from
 *
 * `$DSH_HOME/profiles/node_modules` is the authoritative base: `dsh-app-boot`
 * passes it to the Loader as `bareModuleBaseUrl`, so a bare specifier in a
 * profile entry resolves THERE, not beside the app. Its entries are junctions
 * into the installed app's own `node_modules`, which is why the profile base is
 * what this script must mirror.
 */
function hostNodeModulesFromDshHome() {
  const home = process.env.DSH_HOME?.trim() || path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh');
  const candidate = path.join(home, 'profiles', 'node_modules');
  return fs.existsSync(candidate) ? candidate : undefined;
}

/** Locate an installed app's node_modules from the launcher on PATH. */
function hostNodeModulesFromLauncher() {
  const candidates = process.platform === 'win32' ? ['dsh.cmd', 'dsh'] : ['dsh'];
  for (const candidate of candidates) {
    let launcher;
    try {
      launcher = execFileSync(process.platform === 'win32' ? 'where' : 'which', [candidate], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).split(/\r?\n/)[0].trim();
    } catch {
      continue;
    }
    if (launcher === '') continue;
    // <install>/resources/runtime/cli/bin/dsh.cmd -> <install>/resources/app/node_modules
    const installRoot = path.resolve(path.dirname(launcher), '..', '..', '..');
    const appModules = path.join(installRoot, 'app', 'node_modules');
    if (fs.existsSync(appModules)) return appModules;
    const resourcesModules = path.join(installRoot, 'node_modules');
    if (fs.existsSync(resourcesModules)) return resourcesModules;
  }
  return undefined;
}

/** A node_modules that already resolves the platform modules. */
function existingResolution() {
  const require = createRequire(path.join(repoRoot, 'package.json'));
  try {
    const cordis = require.resolve('@deepseek-ai/cordis/package.json');
    return path.resolve(path.dirname(cordis), '..', '..');
  } catch {
    return undefined;
  }
}

function resolveHostNodeModules(options) {
  const explicit = options.hostNodeModules ?? process.env.DSH_HOST_NODE_MODULES;
  if (explicit !== undefined && explicit.trim() !== '') {
    const resolved = path.resolve(explicit);
    if (!fs.existsSync(resolved)) throw new Error(`--host-node-modules does not exist: ${resolved}`);
    return { dir: resolved, source: 'explicit' };
  }
  const fromHome = hostNodeModulesFromDshHome();
  if (fromHome !== undefined) return { dir: fromHome, source: '$DSH_HOME/profiles/node_modules' };
  const fromLauncher = hostNodeModulesFromLauncher();
  if (fromLauncher !== undefined) return { dir: fromLauncher, source: 'dsh launcher on PATH' };
  const existing = existingResolution();
  if (existing !== undefined) return { dir: existing, source: 'existing node_modules resolution' };
  throw new Error(
    'no DSH host install found. Pass --host-node-modules <path>, set $DSH_HOST_NODE_MODULES, ' +
      'or put the `dsh` launcher on PATH. This release is a host extension and cannot build ' +
      'without the host platform modules.',
  );
}

function readVersion(packageDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

const options = parseArgs(process.argv.slice(2));

let hostNodeModules;
let source;
try {
  ({ dir: hostNodeModules, source } = resolveHostNodeModules(options));
} catch (error) {
  if (!options.ifAvailable) throw error;
  console.warn(`warning: ${error.message}`);
  console.warn('warning: host platform modules were NOT linked; `npm run verify:beta` will fail until they are.');
  process.exit(0);
}

const missing = PLATFORM_MODULES.filter((name) => !fs.existsSync(path.join(hostNodeModules, name, 'package.json')));
if (missing.length > 0) {
  const message = `host install at ${hostNodeModules} is missing platform modules: ${missing.join(', ')}`;
  if (!options.ifAvailable) throw new Error(message);
  console.warn(`warning: ${message}`);
  process.exit(0);
}

const nodeModules = path.join(repoRoot, 'node_modules');
fs.mkdirSync(nodeModules, { recursive: true });

const linked = [];
for (const name of PLATFORM_MODULES) {
  const sourceDir = path.join(hostNodeModules, name);
  const destination = path.join(nodeModules, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const stat = fs.existsSync(destination) ? fs.lstatSync(destination) : undefined;
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) throw new Error(`refusing to replace a real directory: ${destination}`);
    fs.rmSync(destination, { force: true });
  }
  // A junction on Windows (no admin needed) / a relative symlink elsewhere.
  fs.symlinkSync(sourceDir, destination, 'junction');
  linked.push({ name, version: readVersion(sourceDir), from: sourceDir });
}

// `npm install` may have removed junctions it did not create; the two runtime
// dependencies are declared in package.json and are only linked when the host
// ships a copy AND npm did not already install one.
const RUNTIME_DEPS = ['fflate', 'yaml'];
for (const name of RUNTIME_DEPS) {
  const hostCopy = path.join(hostNodeModules, name);
  const destination = path.join(nodeModules, name);
  if (!fs.existsSync(hostCopy) || fs.existsSync(destination)) continue;
  fs.symlinkSync(hostCopy, destination, 'junction');
  linked.push({ name, version: readVersion(hostCopy), from: hostCopy });
}

// react/react-dom are deliberately NOT linked: see the header comment. Record
// the version pair npm installed so the verification report can prove the
// offline runtime bundled one consistent React.
const npmReact = {};
for (const name of ['react', 'react-dom']) {
  const destination = path.join(nodeModules, name);
  if (!fs.existsSync(destination)) {
    const message = `${name} is missing from node_modules; run \`npm install\` first`;
    if (!options.ifAvailable) throw new Error(message);
    console.warn(`warning: ${message}`);
    continue;
  }
  if (fs.lstatSync(destination).isSymbolicLink()) {
    throw new Error(`${destination} is a link; react must be a real npm install so react/react-dom share one tree`);
  }
  npmReact[name] = readVersion(destination);
}
if (npmReact.react !== npmReact['react-dom']) {
  throw new Error(`react ${npmReact.react} and react-dom ${npmReact['react-dom']} differ; they must be the same version pair`);
}

const record = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  hostNodeModules,
  hostNodeModulesSource: source,
  linked,
  npmInstalled: npmReact,
};
fs.writeFileSync(path.join(repoRoot, 'host-modules.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');

console.log(`linked ${linked.length} platform modules from ${hostNodeModules} (${source})`);
for (const entry of linked) console.log(`  ${entry.name}@${entry.version}`);
console.log(`react pair from npm (build-time inputs, not linked): react@${npmReact.react} react-dom@${npmReact['react-dom']}`);
