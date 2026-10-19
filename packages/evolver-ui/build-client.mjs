/**
 * Build the dsh-evolver-ui client bundle.
 *
 * The artifact contract is the DSH client module table: lib/client.js calls
 * window.__ModuleLoader__.load({ id, factory }) and resolves the declared
 * `dsh.client.inject` packages through the injected require. This script is a
 * minimal esbuild-based equivalent of the tsdown clientBundle preset (tsdown
 * is not installed in this repository); it only accepts this package's
 * external list as externals (react/react-dom are DSH platform modules shared
 * through the loader module table) and inlines everything else.
 *
 * Run: node build-client.mjs   (from packages/evolver-ui)
 * Env: ESBUILD_PATH may point at an esbuild package dir (its lib/main.js).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, ['--experimental-strip-types', path.join(here, '../../scripts/build-report-offline-runtime.ts')], { cwd: path.join(here, '../..'), stdio: 'inherit' });
const outfile = path.join(here, 'lib', 'client.js');

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

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  // No machine-specific fallback: a missing build dependency must fail loudly
  // instead of reaching into a developer's local install path.
  throw new Error(
    'esbuild is not installed in this tree. Run `npm install` at the repository root, ' +
      'or set ESBUILD_PATH to an esbuild package directory (its lib/main.js).',
  );
}

fs.mkdirSync(path.dirname(outfile), { recursive: true });

// BR-FE3: Mermaid is vendored locally (tools/mermaid, pinned 11.17.2 + lockfile) — never a
// runtime CDN. The alias resolves the bare specifier to the pinned ESM entry; esbuild
// bundles it (including its relative chunk imports) into client.js.
const mermaidEntry = path.join(here, '..', '..', 'tools', 'mermaid', 'node_modules', 'mermaid', 'dist', 'mermaid.esm.min.mjs');

await esbuild.build({
  entryPoints: [path.join(here, 'src', 'client', 'index.tsx')],
  bundle: true,
  // CJS *inside* the factory, not ESM: the DSH module table invokes
  // `factory(require)` as a plain (non-module) function scope in the browser,
  // where a bare `import` statement is a SyntaxError ("Cannot use import
  // statement outside a module") and a bare `module` identifier does not
  // exist ("module is not defined" — which aborted the whole web boot).
  // esbuild's cjs format converts every `import ... from "react"` into a
  // `require("react")` call through the injected require, and the banner
  // declares the factory-local `module`/`exports` pair (the same shape every
  // working client bundle uses), returned by the footer.
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile,
  sourcemap: true,
  external: externals,
  alias: { mermaid: mermaidEntry },
  jsx: 'automatic',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  banner: {
    js: 'window.__ModuleLoader__.load({ id: "dsh-evolver-ui", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
});

console.log(`evolver-ui: wrote ${outfile}`);
