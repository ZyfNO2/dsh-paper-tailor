/**
 * Verify the release against a REAL DSH host.
 *
 * WHY THIS IS SEPARATE FROM verify-beta.mjs
 * -----------------------------------------
 * A service test proves the code behaves when called directly. It does NOT prove the
 * host mounts the plugin: the Loader can fail an entry silently, the client scanner
 * can fail to find the package, and a route can answer 404 while every test passes.
 * The only way to know the extension loads is to boot a host and look.
 *
 * WHAT IT CHECKS
 * --------------
 *   1. the profile overlay installs (generated from the tree, config included);
 *   2. `dsh --dump-config` resolves all six entries to real files;
 *   3. the host boots with NO "entries did not activate" warning;
 *   4. `/evolver/api/status` answers 200 with the resolved artifact roots;
 *   5. the auth fence is real: a read route without a grant answers 403 SCOPE_DENIED;
 *   6. the session-scoped routes are mounted but refuse an ownerless request (400
 *      SESSION_REQUIRED) instead of 404.
 *
 * It starts its own host on a caller-supplied port, against a caller-supplied
 * DSH_HOME, and never touches the user's real profile.
 *
 * Usage:
 *   node scripts/release/verify-host.mjs --dsh-home <dir> [--port 4599] [--json <path>]
 *
 * Requires the `dsh` launcher on PATH (or DSH_BIN). Exits non-zero on the first
 * failed check, after writing whatever evidence was collected.
 */
import { releaseDigest } from './evidence-binding.mjs';
import { prepareModelProfile } from './model-profile.mjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = { port: 4599, json: path.join(repoRoot, 'verification/results/initial/host.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--e2e') { options.e2e = true;
    } else if (['--model-profile','--forward-settings','--model','--team-plugin'].includes(arg)) { options[arg.slice(2).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())] = argv[++index];
    } else if (arg === '--dsh-home') {
      options.dshHome = argv[index + 1];
      index += 1;
    } else if (arg === '--port') {
      options.port = Number(argv[index + 1]);
      index += 1;
    } else if (arg === '--profile') {
      options.profile = argv[index + 1];
      index += 1;
    } else if (arg === '--json') {
      options.json = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/release/verify-host.mjs --dsh-home <dir> [--port 4599] [--profile beta] [--json <path>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.dshHome === undefined) throw new Error('--dsh-home is required (an isolated DSH home for this run)');
  options.dshHome = path.resolve(options.dshHome);
  options.profile = options.profile ?? 'beta';
  return options;
}

const options = parseArgs(process.argv.slice(2));
let dshBin = process.env.DSH_BIN?.trim() || (process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
if (process.platform === 'win32' && !path.isAbsolute(dshBin)) {
  const located = spawnSync('where.exe', [dshBin], {encoding:'utf8'});
  if (located.status !== 0) throw new Error('DSH launcher is not on PATH; set DSH_BIN');
  dshBin = located.stdout.trim().split(/\r?\n/)[0];
}
const dshIsNodeScript = /\.[cm]?[jt]s$/i.test(dshBin);
const profileDirectory = path.join(options.dshHome, 'profiles', options.profile);
const patchPath = path.join(profileDirectory, 'cordis.patch.yml');
const logPath = path.join(options.dshHome, 'verify-host.log');

const checks = [];
function record(id, status, note) {
  checks.push({ id, status, ...(note === undefined ? {} : { note }) });
  console.log(`${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'SKIP'}  ${id}${note === undefined ? '' : ` — ${note}`}`);
}

/**
 * Invoke the `dsh` launcher.
 *
 * On Windows `dsh` is a `.cmd` shim, so it needs a shell — but the launcher path
 * frequently contains spaces ("DeepSeek Harness"), and `shell: true` splits it.
 * Quoting the executable and using `windowsVerbatimArguments: false` keeps the path
 * as one argument. `process.env.ComSpec` is used rather than a bare `cmd` so the
 * same command works under a non-default system shell.
 */
function dsh(args, extraEnv = {}) {
  const isWindows = process.platform === 'win32';
  const command = dshIsNodeScript ? process.execPath : isWindows ? `"${dshBin}"` : dshBin;
  return spawnSync(command, dshIsNodeScript ? [dshBin,...args] : args, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: isWindows && !dshIsNodeScript,
    env: { ...process.env, DSH_HOME: options.dshHome, ...extraEnv },
  });
}

/** Start the host as a long-running child, keeping the same quoting rules. */
function spawnHost(extraArgs) {
  const isWindows = process.platform === 'win32';
  const command = dshIsNodeScript ? process.execPath : isWindows ? `"${dshBin}"` : dshBin;
  return spawn(command, dshIsNodeScript ? [dshBin,...extraArgs] : extraArgs, {
    cwd: repoRoot,
    shell: isWindows && !dshIsNodeScript,
    env: { ...process.env, DSH_HOME: options.dshHome },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

let hostProcess;
let failure;
let modelAcceptanceIncomplete = false;

try {
  // 1. Install the overlay into an isolated profile.
  if (!fs.existsSync(path.join(profileDirectory, 'package.json'))) {
    const scaffold = dsh(['--profile', options.profile, '--from-default-profile', 'web', '--dump-config']);
    if (scaffold.status !== 0) throw new Error(`could not scaffold profile ${options.profile}: ${scaffold.stderr?.slice(0, 300)}`);
  }
  const install = spawnSync(process.execPath, ['scripts/release/install-profile.mjs', '--profile', patchPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (install.status !== 0) throw new Error(`install-profile failed: ${install.stderr?.slice(0, 400)}`);
  record('host/profile-install', 'pass', path.relative(repoRoot, patchPath));

  if (options.e2e) {
    if (!options.modelProfile) throw new Error('--model-profile is required for real E2E');
    prepareModelProfile({source:options.modelProfile,forwardSettings:options.forwardSettings,patchPath,model:options.model});
  }

  if (options.teamPlugin) {
    const teamSource=path.resolve(options.teamPlugin);
    if (!fs.existsSync(teamSource)) throw new Error('Native team plugin file is absent');
    const { pathToFileURL } = await import('node:url');
    fs.appendFileSync(patchPath,'\n- insert:\n    - id: beta-native-team\n      name: '+JSON.stringify(pathToFileURL(teamSource).href)+'\n      config:\n        maxMembers: 4\n        maxTasks: 64\n');
  }

  // 2. Every entry must resolve to a file that exists.
  const dumped = dsh(['--profile', options.profile, '--dump-config']);
  if (dumped.status !== 0) throw new Error(`dump-config failed: ${dumped.stderr?.slice(0, 400)}`);
  // The dump folds long values as YAML block scalars (`name: >-` then the URL on the
  // next, more-indented line), so a `name:`-anchored regex misses most entries. Every
  // `file://` URL in the dump is a plugin module, so match those directly.
  const resolved = [...new Set([...dumped.stdout.matchAll(/file:\/\/\/[^\s]+/g)].map((match) => match[0]))];
  const missing = resolved.filter((url) => {
    const file = fileURLToPathSafe(url);
    return file !== undefined && !fs.existsSync(file);
  });
  if (missing.length > 0) throw new Error(`entries resolve to missing files: ${missing.join(', ')}`);
  record('host/entry-resolution', 'pass', `${resolved.length} file entries resolved`);

  // 3. Boot the host and watch for activation warnings.
  fs.rmSync(logPath, { force: true });
  hostProcess = spawnHost(['--profile', options.profile, '--port', String(options.port), '--no-open']);
  let stdout = '';
  let stderr = '';
  hostProcess.stdout.on('data', (chunk) => { stdout += String(chunk); });
  hostProcess.stderr.on('data', (chunk) => { stderr += String(chunk); });

  const url = await waitForUrl(() => stdout, 60_000);
  if (url === undefined) throw new Error(`host did not print a URL within 60s. stderr: ${stderr.slice(0, 600)}`);
  fs.writeFileSync(logPath, `${stdout}\n${stderr}`, 'utf8');

  const activationWarning = /(\d+) entr(y|ies) did not activate/.exec(stderr);
  if (activationWarning !== null) {
    throw new Error(`${activationWarning[0]}: ${stderr.split('\n').filter((line) => line.includes('did not activate') || line.includes('failed to import') || line.includes('Error')).slice(0, 4).join(' | ')}`);
  }
  record('host/boot', 'pass', `no activation warning; ${new URL(url).port}`);

  // 4-6. Authenticate once, then probe the routes.
  const token = new URL(url).searchParams.get('token');
  const cookie = await authenticate(url, token);
  if (cookie === undefined) throw new Error('could not obtain an auth cookie from the host');
  record('host/authentication', 'pass', 'token exchange issued a session cookie');

  const status = await httpGet(`http://127.0.0.1:${options.port}/evolver/api/status`, cookie);
  if (status.status !== 200) throw new Error(`/evolver/api/status answered ${status.status}: ${status.body.slice(0, 300)}`);
  const statusBody = JSON.parse(status.body);
  if (statusBody.service !== 'evolver-workbench') throw new Error(`unexpected service name: ${statusBody.service}`);
  // The roots must have resolved against the REPOSITORY, not the process cwd.
  const roots = Object.values(statusBody.roots ?? {});
  const outsideTree = roots.filter((root) => typeof root === 'string' && !root.startsWith(repoRoot));
  if (outsideTree.length > 0) throw new Error(`artifact roots resolved outside the tree: ${outsideTree.join(', ')}`);
  record('host/route-status', 'pass', `service=${statusBody.service} roots=${roots.length}`);

  const denied = await httpGet(`http://127.0.0.1:${options.port}/evolver/api/modules`, cookie);
  if (denied.status !== 403) throw new Error(`a read route without a grant answered ${denied.status}, expected 403`);
  if (!denied.body.includes('SCOPE_DENIED')) throw new Error(`403 without SCOPE_DENIED: ${denied.body.slice(0, 200)}`);
  record('host/auth-fence', 'pass', 'read route without a grant is SCOPE_DENIED');

  for (const route of ['/evolver/paper-library', '/evolver/research-bootstrap']) {
    const response = await httpGet(`http://127.0.0.1:${options.port}${route}`, cookie);
    if (response.status === 404) throw new Error(`${route} is not mounted (404)`);
    if (response.status !== 400 || !response.body.includes('SESSION_REQUIRED')) {
      throw new Error(`${route} answered ${response.status}, expected 400 SESSION_REQUIRED: ${response.body.slice(0, 200)}`);
    }
  }
  record('host/session-required', 'pass', 'both session-scoped routes mounted and ownerless requests refused');
  const foundations = await httpGet(`http://127.0.0.1:${options.port}/evolver/research-foundations`, cookie);
  if (foundations.status !== 400 || JSON.parse(foundations.body).error !== 'Invalid id') {
    throw new Error(`foundations route answered ${foundations.status}, expected scoped input rejection: ${foundations.body.slice(0, 200)}`);
  }
  const foundationsUnauthenticated = await httpGet(`http://127.0.0.1:${options.port}/evolver/research-foundations`);
  if (![401, 403].includes(foundationsUnauthenticated.status)) {
    throw new Error(`unauthenticated foundations route answered ${foundationsUnauthenticated.status}`);
  }
  record('host/foundations-scope', 'pass', 'foundations route mounted; ownerless and unauthenticated requests refused');
  if (options.e2e) { const { runModelPreflight } = await import('./probe-model.mjs'); const passed=await runModelPreflight({repoRoot,port:options.port,cookie,privateRoot:options.dshHome}); if(!passed) modelAcceptanceIncomplete = true; }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  record('host/verify', 'fail', failure);
} finally {
  // Kill the whole process TREE, not just the shell wrapper: on Windows the `dsh.cmd`
  // shim spawns node as a child, and killing only the shim leaves the host listening.
  // `taskkill /T` is used instead of `child.kill()` because the latter trips a libuv
  // assertion ("!(handle->flags & UV_HANDLE_CLOSING)") when the child is a shell
  // wrapper, which crashed the verifier after it had already recorded its result.
  if (hostProcess !== undefined && hostProcess.pid !== undefined) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(hostProcess.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      hostProcess.kill('SIGTERM');
    }
    hostProcess = undefined;
  }
}

/** Minimal `file://` -> path conversion (avoids importing node:url for one call site). */
function fileURLToPathSafe(url) {
  try {
    return fileURLToPath(url);
  } catch {
    return undefined;
  }
}

function waitForUrl(readStdout, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/.exec(readStdout());
      if (match !== null) {
        clearInterval(timer);
        resolve(match[0]);
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 250);
  });
}

/** Exchange the boot token for a session cookie, following the host's redirect. */
async function authenticate(bootUrl, token) {
  const response = await fetch(bootUrl, { redirect: 'manual' });
  const setCookie = response.headers.getSetCookie?.() ?? [];
  if (setCookie.length === 0) return undefined;
  return setCookie.map((value) => value.split(';')[0]).join('; ');
}

async function httpGet(url, cookie) {
  const response = await fetch(url, { headers: { cookie } });
  return { status: response.status, body: await response.text() };
}

const summary = {
  schemaVersion: 1,
  releaseDigest: releaseDigest(repoRoot),
  generatedAt: new Date().toISOString(),
  kind: 'real_host',
  host: { node: process.version, platform: process.platform, port: options.port },
  profile: path.relative(repoRoot, patchPath).split(path.sep).join('/'),
  checks,
  result: failure === undefined && checks.every((check) => check.status === 'pass') ? 'pass' : 'fail',
  ...(failure === undefined ? {} : { firstError: failure }),
};

fs.mkdirSync(path.dirname(options.json), { recursive: true });
fs.writeFileSync(options.json, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log('');
console.log(`host verification: ${summary.result}`);
console.log(`evidence: ${path.relative(repoRoot, options.json)}`);
process.exit(summary.result === 'pass' && !modelAcceptanceIncomplete ? 0 : 1);
