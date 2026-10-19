/**
 * Compile-check for the workbench client bundle.
 *
 * `build-client.mjs` uses the esbuild JS API, which starts a long-lived child
 * process. Where child processes are unavailable this drives the esbuild BINARY
 * through execFile instead — same options, same banner/footer, so a successful
 * run here proves the source compiles and links into the module-table contract
 * the DSH client expects.
 *
 * The outfile defaults to a temp path so this never writes `lib/` (which is a
 * build artifact, not a source edit). Set DSH_CLIENT_OUT to build in place.
 *
 * Build this ONE way on purpose. The banner must reach esbuild with its quotes
 * intact, and every shell-mediated path has failed at that at least once:
 * PowerShell stripped them from a quoted argument, producing a bundle that
 * registers under the key "undefined" and mounts no tab. Driving the binary from
 * Node with the banner as a single argv element cannot lose a quote, so that is
 * what this does, and the check below fails loudly if the id is unquoted.
 *
 * Run: node --experimental-strip-types scripts/build-client-check.ts
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiRoot = path.join(repoRoot, 'packages/evolver-ui');

/**
 * Find an esbuild binary: ESBUILD_BIN, then the esbuild package installed in
 * this tree, then PATH.
 *
 * There is deliberately no hard-coded store path here: a release tree must
 * either have its own installed esbuild or be told where one is. A machine-local
 * pnpm store silently satisfying the build is the failure mode this guards.
 */
function findEsbuild(): string {
  if (process.env.ESBUILD_BIN !== undefined && fs.existsSync(process.env.ESBUILD_BIN)) return process.env.ESBUILD_BIN;
  // The `esbuild` package's own binary path, resolved from this repo's install.
  const platformPackages = ['@esbuild/win32-x64', '@esbuild/linux-x64', '@esbuild/darwin-arm64', '@esbuild/darwin-x64'];
  for (const platformPackage of platformPackages) {
    const binName = platformPackage.includes('win32') ? 'esbuild.exe' : 'bin/esbuild';
    const candidate = path.join(repoRoot, 'node_modules', platformPackage, binName);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of ['esbuild', 'esbuild.exe']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch { /* keep looking */ }
  }
  throw new Error('no esbuild binary found; run `npm install` at the repository root or set ESBUILD_BIN');
}

const esbuild = findEsbuild();
const outfile = process.env.DSH_CLIENT_OUT ?? path.join(os.tmpdir(), 'dsh-evolver-ui-client.check.js');

// BR-FE3: Mermaid is vendored locally (tools/mermaid, pinned + lockfile) and aliased
// by build-client.mjs; the same alias is needed here or `import 'mermaid'` cannot
// resolve (there is no node_modules copy on purpose).
const mermaidEntry = path.join(repoRoot, 'tools', 'mermaid', 'node_modules', 'mermaid', 'dist', 'mermaid.esm.min.mjs');

/**
 * The module-table banner and footer.
 *
 * The id MUST be quoted. `id: dsh-evolver-ui` is not a string at all — it is a
 * reference to an undefined identifier — so the loader looks the entry up under
 * the key "undefined" and the plugin never registers. The failure is silent: the
 * page boots, the HTTP route answers, and the 工作台 tab simply is not there.
 * That exact build shipped once during this work (PowerShell stripped the quotes
 * out of a shell-quoted argument), so the check below asserts on a QUOTED id
 * rather than merely on the presence of a banner.
 *
 * The text is passed to esbuild as ONE argv element read from this file, so no
 * shell can mangle the quotes in transit. (esbuild also accepts
 * `--banner:js=@file`, but only in newer versions; the argv form works on every
 * version this repo has been built with.)
 */
const BANNER =
  'window.__ModuleLoader__.load({ id: "dsh-evolver-ui", factory: (require) => {\n' +
  'var module = { exports: {} };\n' +
  'var exports = module.exports;';
const FOOTER = 'return module.exports; } });';

const externals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-session',
  '@deepseek-ai/dsh-client-ui-slots',
];

/**
 * Verify the module-table CONTRACT of an already-built bundle.
 *
 * Split from the compile step on purpose: compiling needs esbuild's binary as a
 * child process, which some hosts refuse, while the three properties the DSH
 * client depends on only need the finished file. `DSH_CLIENT_BUNDLE` points at
 * a bundle built elsewhere (e.g. `pnpm --filter dsh-evolver-ui bundle`) so the
 * contract is still checked rather than silently skipped.
 */
export function verifyBundle(file: string): { ok: boolean; bytes: number; requires: string[]; lines: string[] } {
  const bundle = fs.readFileSync(file, 'utf8');
  const declared = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis', '@deepseek-ai/dsh-api-session-controller',
    '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-renderer',
    '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-slots',
  ]);
  // BARE require calls only. The mermaid bundle embeds lodash, whose Node
  // detection writes `x.require("util").types` behind an `x.require` guard — a
  // member call that never executes in the browser factory (the banner module
  // has no `require`). A lookbehind keeps those textual matches out of the
  // module-table audit while real `= require("react")` calls still count.
  const requires = [...new Set([...bundle.matchAll(/(?<![.\w$])require\("([^"]+)"\)/g)].map((m) => m[1]))];
  const undeclared = requires.filter((r) => !declared.has(r));

  // A quoted id is REQUIRED, not cosmetic: an unquoted `id: dsh-evolver-ui` is a
  // reference to an undefined identifier, so the loader registers the bundle
  // under the key "undefined", the entry never matches, and the 工作台 tab is
  // silently absent while everything else looks healthy. That shipped once.
  const quotedId = /window\.__ModuleLoader__\.load\(\{\s*id:\s*"dsh-evolver-ui"\s*,/.test(bundle);
  const unquotedId = /window\.__ModuleLoader__\.load\(\{\s*id:\s+dsh-evolver-ui\s*,/.test(bundle);

  // The footer must be the last CODE the bundle runs; a trailing
  // `//# sourceMappingURL=` comment (sourcemap builds) may follow it.
  const codeOnly = bundle.replace(/\/\/# sourceMappingURL=[^\n]*\s*$/, '').trimEnd();
  const checks = [
    {
      name: 'module-table banner with a QUOTED id',
      ok: quotedId,
      detail: quotedId
        ? ''
        : unquotedId
          ? 'the id is NOT quoted: `id: dsh-evolver-ui` is a reference to an undefined identifier, so the loader keys the entry under "undefined" and the tab never mounts. Rebuild with the quoted id.'
          : 'the bundle does not register itself as "dsh-evolver-ui" before any code runs',
    },
    {
      name: 'factory footer',
      ok: codeOnly.endsWith('return module.exports; } });'),
      detail: 'the factory must return its exports to the loader',
    },
    {
      name: 'no undeclared requires',
      ok: undeclared.length === 0,
      detail: undeclared.length === 0 ? '' : `undeclared module-table rows: ${undeclared.join(', ')}`,
    },
  ];
  const lines = checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail === '' ? '' : ` — ${c.detail}`}`);
  return { ok: checks.every((c) => c.ok), bytes: bundle.length, requires, lines };
}

/**
 * Compile the client bundle with the esbuild binary and return its verdict.
 *
 * Exported so scripts/eval-phase3-workbench.ts can call it IN-PROCESS: a nested
 * `node` spawn is refused in restricted environments, and importing this module
 * must not itself run the check twice.
 *
 * STDIO — why a file descriptor and not a pipe
 * --------------------------------------------
 * This used to run with `stdio: ['ignore','pipe','pipe']` and failed with
 * `spawnSync ... EPERM` on this host, so `WB-11.client-bundle-compiles` was
 * reported `blocked` for several rounds. That read like a missing toolchain and
 * invited a pointless install. `scripts/probe-esbuild-stdio.ts` shows what is
 * actually true: the sandbox refuses a child whose output it must capture
 * through a PIPE, and allows one whose stderr is a FILE DESCRIPTOR. The binary
 * was never the problem.
 *
 * The fix is deliberately not `stdio: 'ignore'`. esbuild writes its diagnostics
 * to stderr, and those diagnostics are the only useful part of a compile
 * failure; discarding them would trade a visible `blocked` for an invisible
 * `FAIL` with no message. A file descriptor is not a pipe, so the child starts
 * AND the message survives.
 */
export function runBundleCheck(): { ok: boolean; outfile: string; bytes: number; requires: string[]; lines: string[] } {
  const errFile = path.join(os.tmpdir(), `dsh-esbuild-stderr-${process.pid}.log`);
  const errFd = fs.openSync(errFile, 'w');
  try {
    execFileSync(
      esbuild,
      [
        'src/client/index.tsx',
        '--bundle',
        '--format=cjs',
        '--platform=browser',
        '--target=es2022',
        '--jsx=automatic',
        `--outfile=${outfile}`,
        ...externals.map((e) => `--external:${e}`),
        `--alias:mermaid=${mermaidEntry}`,
        '--define:process.env.NODE_ENV="production"',
        `--banner:js=${BANNER}`,
        `--footer:js=${FOOTER}`,
      ],
      { cwd: uiRoot, stdio: ['ignore', 'ignore', errFd] },
    );
  } catch (err) {
    const diagnostics = fs.readFileSync(errFile, 'utf8').trim();
    const message = err instanceof Error ? err.message : String(err);
    // A refused spawn is an unavailable toolchain, NOT a broken bundle. The flag
    // lets the caller tell those apart without pattern-matching a message that
    // now also carries esbuild's own text (which can legitimately contain ENOENT
    // for an unresolvable import — that IS a bundle failure).
    if (/spawnSync/i.test(message) && /EPERM|ENOENT/i.test(message)) {
      const refused = new Error(message) as Error & { esbuildSpawnRefused?: boolean };
      refused.esbuildSpawnRefused = true;
      throw refused;
    }
    throw new Error(diagnostics === '' ? message : `${message}\n${diagnostics}`);
  } finally {
    fs.closeSync(errFd);
  }

  const verdict = verifyBundle(outfile);
  return { ...verdict, outfile };
}

// Only run as a CLI when executed directly, so importing it is side-effect free.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = 0;
  try {
    // DSH_CLIENT_BUNDLE verifies an existing bundle instead of compiling one.
    const existing = process.env.DSH_CLIENT_BUNDLE;
    if (existing === undefined) execFileSync(process.execPath, ['--experimental-strip-types', path.join(repoRoot, 'scripts/build-report-offline-runtime.ts')], { cwd: repoRoot, stdio: 'inherit' });
    const verdict = existing !== undefined
      ? { ...verifyBundle(existing), outfile: existing }
      : runBundleCheck();
    for (const line of verdict.lines) {
      if (line.startsWith('FAIL')) failed += 1;
      console.log(line);
    }
    const mode = existing === undefined ? 'compiled' : 'verified existing';
    console.log(`bundle (${mode}): ${verdict.outfile} (${verdict.bytes} bytes, ${verdict.requires.length} module-table requires)`);
  } catch (err) {
    console.log(`FAIL  compile — ${err instanceof Error ? err.message : String(err)}`);
    failed += 1;
  }
  process.exitCode = failed === 0 ? 0 : 1;
}
