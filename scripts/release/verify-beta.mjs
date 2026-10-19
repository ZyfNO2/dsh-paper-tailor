/**
 * Run the Beta verification ladder and write a machine-readable result summary.
 *
 * WHAT THIS DOES AND DOES NOT PROVE
 * ---------------------------------
 * It runs the checks that can be executed from this tree and records, per case:
 * the command, the exit code, pass/fail/skip, and the KIND of evidence
 * (`install` / `build` / `typecheck` / `service_test` / `static`). Cases that need
 * a real DSH host (`real_host`) are recorded as `not_run` here with the exact
 * command to run — a service test passing must never be reported as host
 * verification, and a route answering HTTP 200 must never be reported as a working
 * feature.
 *
 * The host cases are run by `scripts/release/verify-host.mjs`, which needs a
 * booted profile; keeping them separate is what stops "the tests pass" from being
 * silently promoted to "the host works".
 *
 * Usage:
 *   node scripts/release/verify-beta.mjs [--json <path>] [--no-host]
 *
 * Exit code is 0 only when every RUNNABLE case passed. A skipped/failed case is
 * reported, never swallowed.
 */
import { releaseDigest, validateEvidence, HOST_IDS, E2E_IDS } from './evidence-binding.mjs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = { json: path.join(repoRoot, 'verification/results/initial/summary.json') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = path.resolve(argv[index + 1]);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node scripts/release/verify-beta.mjs [--json <path>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

/** Resolve the TypeScript compiler from the pinned tool closure. */
const tsc = path.join(repoRoot, 'tools/ts-toolchain/node_modules/typescript/bin/tsc');

/**
 * Cases that can run here, in order.
 *
 * `argv` is passed to the process directly (no shell), so quoting is exact and a
 * failure is a real non-zero exit rather than a shell artefact.
 */
const CASES = [
  { id: 'build/types', kind: 'build', run: () => runTsc(['-p','packages/evolver-ui/tsconfig.build.json']) },
  { id: 'typecheck/ui-root', kind: 'typecheck', run: () => runTsc(['--noEmit','-p','packages/evolver-ui/tsconfig.json']) },
  { id: 'test/release-evidence', kind: 'service_test', run: () => runNode(['--test','tests/integration/release-evidence.spec.mjs']) },
  { id: 'release/licenses', kind: 'static', run: () => runNode(['scripts/release/verify-licenses.mjs']) },
  {
    id: 'install/host-modules',
    kind: 'install',
    run: () => runNode(['scripts/release/link-host-modules.mjs']),
  },
  {
    id: 'install/tools',
    kind: 'install',
    // `npm ci` is slow and only needs to happen once; treat an existing install as
    // satisfying the case but say so, rather than re-downloading on every run.
    run: () =>
      fs.existsSync(path.join(repoRoot, 'tools/ts-toolchain/node_modules/typescript')) && fs.existsSync(path.join(repoRoot,'tools/mermaid/node_modules/mermaid'))
        ? { status: 0, note: 'tool closures already installed' }
        : runNode(['scripts/release/install-tools.mjs']),
  },
  {
    id: 'build/runtime',
    kind: 'build',
    run: () => runNode(['--experimental-strip-types', 'scripts/build-report-offline-runtime.ts']),
  },
  {
    id: 'build/client',
    kind: 'build',
    run: () => runNode(['--experimental-strip-types', 'scripts/build-client-check.ts']),
  },
  {
    id: 'build/node-half',
    kind: 'build',
    run: () => runNode(['scripts/build-node-half.mjs']),
  },
  {
    id: 'typecheck/backend',
    kind: 'typecheck',
    run: () => runTsc(['--noEmit', '-p', 'packages/evolver/tsconfig.typecheck.json']),
  },
  {
    id: 'typecheck/scripts',
    kind: 'typecheck',
    run: () => runTsc(['--noEmit', '-p', 'scripts/tsconfig.typecheck.json']),
  },
  {
    id: 'typecheck/ui-subconfigs',
    kind: 'typecheck',
    run: () => {
      const configs = [
        'packages/evolver-ui/src/client/redesign/tsconfig.json',
        'packages/evolver-ui/src/client/integration/tsconfig.json',
        'packages/evolver-ui/src/client/general/tsconfig.json',
      ];
      const failures = [];
      for (const config of configs) {
        const result = runTsc(['--noEmit', '-p', config]);
        if (result.status !== 0) failures.push(`${config}: ${result.note ?? `exit ${result.status}`}`);
      }
      return failures.length === 0
        ? { status: 0, note: `${configs.length} UI configs passed` }
        : { status: 1, note: failures.join('; ') };
    },
  },
  {
    id: 'test/domain',
    kind: 'service_test',
    run: () => runNpm(['run', 'test:domain']),
    // Report the real counts from the runner output.
    counts: true,
  },
  {
    id: 'test/wiring',
    kind: 'service_test',
    run: () => runNpm(['run', 'test:wiring']),
    counts: true,
  },
  {
    id: 'release/frozen-manifest-provenance',
    kind: 'static',
    run: () => runNode(['scripts/release/neutralize-fixture-provenance.mjs']),
  },
  {
    id: 'release/no-machine-paths',
    kind: 'static',
    run: () => scanForMachinePaths(),
  },
  {
    id: 'release/file-manifest',
    kind: 'static',
    run: () => runNode(['scripts/release/write-release-manifest.mjs']),
  },
];

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status ?? 1, note: summarise(result) };
}

function runNpm(args) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  return { status: result.status ?? 1, note: summarise(result), output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function runTsc(args) {
  if (!fs.existsSync(tsc)) return { status: 1, note: 'TypeScript is not installed; run npm run install:tools' };
  const result = spawnSync(process.execPath, [tsc, ...args], { cwd: repoRoot, encoding: 'utf8' });
  return { status: result.status ?? 1, note: summarise(result) };
}

/** First meaningful line of a failing command, so the summary names the real error. */
function summarise(result) {
  const combined = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status === 0) return undefined;
  const firstError = combined
    .split('\n')
    .map((line) => line.trim())
    .find((line) => /error|fail|✖/i.test(line));
  return (firstError ?? combined.split('\n')[0] ?? '').slice(0, 400);
}

/**
 * Scan the shipped tree for machine-local paths.
 *
 * Build output and `node_modules` are excluded: they are generated, and a linked
 * host module legitimately lives outside the tree. A hit is reported with its file
 * and line so a human can tell a real leak from an explanatory comment.
 *
 * `patch-workspace.ts` is exempt on purpose: it is the security test suite that
 * proves absolute-path rejection, so an absolute Windows path there is a TEST INPUT,
 * not a machine dependency. Deleting it would remove the assertion that drive letters
 * are treated as absolute. `verification/cases.json` describes this scan and
 * necessarily spells the patterns out, and this file quotes an example while
 * explaining the exemption.
 */
function scanForMachinePaths() {
  const PATTERNS = [/\bF:[\\/]/, /\bG:\\Anaconda\b/, /C:\\Users\\[^\\\s]+\b/];
  const SKIP = /(^|[\\/])(node_modules|\.git|lib|\.dsh-verify-home|verification[\\/]results)([\\/]|$)/;
  const ALLOWED = [
    // Comments that document the migration necessarily quote the old path.
    /scripts[\\/]release[\\/]neutralize-fixture-provenance\.mjs$/,
    /docs[\\/]/,
    // Security tests use an absolute Windows path as a deliberate test input.
    /packages[\\/]evolver[\\/]src[\\/]domain[\\/]patch-workspace\.ts$/,
    // The verification manifest and this scanner describe the patterns themselves.
    /verification[\\/]cases\.json$/,
    /scripts[\\/]release[\\/]verify-beta\.mjs$/,
  ];

  const hits = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
      if (SKIP.test(relative)) continue;
      if (ALLOWED.some((pattern) => pattern.test(relative))) continue;
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!/\.(ts|tsx|mjs|js|json|ya?ml|ps1|md|py)$/.test(entry.name)) continue;
      const text = fs.readFileSync(absolute, 'utf8');
      text.split('\n').forEach((line, index) => {
        if (PATTERNS.some((pattern) => pattern.test(line))) hits.push(`${relative}:${index + 1}: ${line.trim().slice(0, 160)}`);
      });
    }
  };
  walk(repoRoot);

  if (hits.length === 0) return { status: 0, note: 'no machine-local paths found' };
  return { status: 1, note: `${hits.length} hit(s): ${hits.slice(0, 5).join(' | ')}`, output: hits.join('\n') };
}

/** Parse both node:test spec and TAP summary formats. */
function parseCounts(output) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'skipped']) {
    const match = new RegExp('^(?:ℹ |# )' + key + ' (\\d+)$', 'm').exec(output ?? '');
    if (match) counts[key] = Number(match[1]);
  }
  return counts;
}

const results = [];
let failed = 0;

for (const testCase of CASES) {
  process.stdout.write(`[${testCase.kind}] ${testCase.id} ... `);
  let outcome;
  try {
    outcome = testCase.run();
  } catch (error) {
    outcome = { status: 1, note: error instanceof Error ? error.message : String(error) };
  }
  const passed = outcome.status === 0;
  if (!passed) failed += 1;
  const record = {
    id: testCase.id,
    kind: testCase.kind,
    status: passed ? 'pass' : 'fail',
    exitCode: outcome.status,
    ...(outcome.note === undefined ? {} : { note: outcome.note }),
    ...(testCase.counts === true ? { counts: parseCounts(outcome.output) } : {}),
  };
  results.push(record);
  console.log(passed ? 'PASS' : 'FAIL');
  if (!passed && outcome.note !== undefined) console.log(`    ${outcome.note}`);
  if (!passed && outcome.output !== undefined) {
    const firstLines = outcome.output.split('\n').filter((line) => line.trim() !== '').slice(-12);
    for (const line of firstLines) console.log(`    ${line}`);
  }
}

/**
 * Fold in real-host evidence if it exists.
 *
 * The host run is a SEPARATE command (`npm run verify:host`) because it needs a booted
 * profile. If its evidence file is present, its checks are recorded here as
 * `real_host` results; if it is absent, the host cases stay `not_run` with the exact
 * command. Either way a service test is never reported as host verification.
 */
const hostEvidencePath = path.join(repoRoot, 'verification/results/initial/host.json');
const hostEvidence = fs.existsSync(hostEvidencePath)
  ? JSON.parse(fs.readFileSync(hostEvidencePath, 'utf8'))
  : undefined;

function collectEvidence(value, ids, kind, evidence) {
  if (value === undefined) { for (const id of ids) results.push({id,kind,status:'not_run',reason:'Run the corresponding verifier against the current release',evidence}); return; }
  try { for (const check of validateEvidence(value,releaseDigest(repoRoot),ids)) results.push({...check,kind,evidence}); }
  catch (error) { results.push({id:kind+'/evidence-binding',kind,status:'fail',reason:error.message}); }
}
collectEvidence(hostEvidence,HOST_IDS,'real_host','verification/results/initial/host.json');
const e2ePath = path.join(repoRoot,'verification/results/initial/e2e.json');
const e2eEvidence = fs.existsSync(e2ePath) ? JSON.parse(fs.readFileSync(e2ePath,'utf8')) : undefined;
collectEvidence(e2eEvidence,E2E_IDS,'real_host_e2e','verification/results/initial/e2e.json');

const summary = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  host: { platform: process.platform, node: process.version, cwd: path.basename(repoRoot) },
  ladder: {
    filesOrganized: 'see verification/release-files.json',
    cleanBuild: failed === 0 ? 'pass' : 'fail',
    realHost:
      hostEvidence === undefined
        ? 'not_run (run `npm run verify:host -- --dsh-home <dir>`)'
        : hostEvidence.result === 'pass' && !results.some(r=>r.kind==='real_host' && r.status!=='pass')
          ? 'pass (evidence: verification/results/initial/host.json)'
          : `fail (first error: ${hostEvidence.firstError ?? "see evidence file"})`,
    endToEnd: E2E_IDS.every(id=>results.some(r=>r.id===id && r.status==='pass')) ? 'pass' : 'incomplete',
    publicCandidate: 'MIT selected; requires complete matching host/E2E evidence and explicit publication',
  },
  totals: {
    pass: results.filter((result) => result.status === 'pass').length,
    fail: results.filter((result) => result.status === 'fail').length,
    notRun: results.filter((result) => result.status === 'not_run').length,
  },
  results,
};

fs.mkdirSync(path.dirname(options.json), { recursive: true });
fs.writeFileSync(options.json, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

console.log('');
console.log(`pass ${summary.totals.pass} / fail ${summary.totals.fail} / not_run ${summary.totals.notRun}`);
console.log(`summary: ${path.relative(repoRoot, options.json)}`);
console.log(hostEvidence === undefined
  ? 'real_host cases are NOT run here; a passing service test is not host verification.'
  : 'real_host cases come from verification/results/initial/host.json, recorded by verify:host.');
process.exit(summary.totals.fail === 0 && summary.totals.notRun === 0 ? 0 : 1);
