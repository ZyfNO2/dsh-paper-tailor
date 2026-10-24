import { build } from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await build({
  absWorkingDir: root,
  entryPoints: ['apps/workbench/src/main.tsx'],
  outfile: 'artifacts/legacy-workbench-build/main.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
  sourcemap: true,
  alias: { mermaid: path.join(root, 'tools/mermaid/node_modules/mermaid/dist/mermaid.esm.min.mjs') },
  metafile: true,
}).then((result) => {
  const hostImports = Object.keys(result.metafile.inputs).filter((file) => /node_modules\/@deepseek-ai\//.test(file));
  if (hostImports.length) throw new Error(`standalone UI imported host SDK: ${hostImports.join(', ')}`);
  process.stdout.write(JSON.stringify({ inputs: Object.keys(result.metafile.inputs).length, output: 'artifacts/legacy-workbench-build/main.js', mounted: false }) + '\n');
});
