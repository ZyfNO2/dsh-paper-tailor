import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { copyResearchRuntimeDeps } from './copy-research-runtime-deps.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
execFileSync(process.execPath, ['scripts/export-research-mcp-contract.mjs', '--check'], { cwd: root, stdio: 'pipe' });
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
const relativeDist = path.relative(fs.realpathSync(root), fs.realpathSync(dist));
if (relativeDist.startsWith('..') || path.isAbsolute(relativeDist)) throw new Error('Distribution directory leaves the repository');
const finalOutput = path.join(root, 'dist/research');
const output = path.join(root, 'dist', `.research-build-${randomUUID()}`);
// Bundle the original React workbench on the build machine. The runtime package
// serves this asset directly and does not need React/esbuild installed.
execFileSync(process.execPath, ['scripts/build-legacy-workbench.mjs'], { cwd: root, stdio: 'inherit' });
const closure = JSON.parse(execFileSync(process.execPath, ['scripts/check-research-boundary.mjs', '--json'], { cwd: root, encoding: 'utf8' }));
function filesUnder(relative) {
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? filesUnder(`${relative}/${entry.name}`) : entry.isFile() ? [`${relative}/${entry.name}`] : []);
}
const workers = filesUnder('workers').filter((file) => /\.(py|R)$/.test(file));
const portableProfile = filesUnder('fixtures/portable-regression-v1').filter((file) => /\.(py|csv|md)$/.test(file));
const files = [...new Set([...closure.files, ...workers, ...portableProfile, 'packages/research-interfaces/src/workbench.html', 'packages/research-interfaces/src/workbench-client.js', 'artifacts/legacy-workbench-build/main.js', 'artifacts/legacy-workbench-build/main.js.map', 'LICENSE', ...filesUnder('research-pack')])];
fs.mkdirSync(output, { recursive: true });
const runtimeDependencies = copyResearchRuntimeDeps(output);
for (const file of files) {
  const destination = path.join(output, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(root, file), destination);
}
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'dsh-research-workbench', version: '0.1.0', private: true, type: 'module', engines: { node: '>=24.0.0' }, dependencies: runtimeDependencies, scripts: { start: 'node packages/research-interfaces/src/legacy-workbench.ts', diagnostic: 'node packages/research-interfaces/src/workbench.ts', research: 'node packages/research-interfaces/src/cli.ts', mcp: 'node packages/research-interfaces/src/mcp.ts', team: 'node research-pack/codex-role.mjs --all' } }, null, 2) + '\n');
fs.writeFileSync(path.join(output, 'README.md'), '# 独立研究工作台\n\n需要 Node.js 24+；无需安装 DSH 或 React。\n\n```powershell\nnpm start -- --roots "F:\\my-research" --port 9411\nnpm run research -- --help\nnpm run mcp -- --workspace "F:\\my-research\\project-a"\nnode research-pack/install.mjs --workspace "F:\\my-research\\project-a"\n```\n\n打开 http://127.0.0.1:9411/ 。roots 必须已存在；旧项目需显式迁移并重新授权来源。工作台是可选用户界面，CLI/MCP使用同一状态。Agent运行说明在research-pack/SKILL.md及skills/OPERATIONS.md。真实模型、PDF解析及外部计算工具需另行配置；未配置时明确不可用。当前外部角色审查为self_review，原生DSH Team调度与独立Reviewer尚未接入。展示用合成数据不代表科研结论。\n');
function bundledFiles(relative) {
  return fs.readdirSync(path.join(output, relative), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? bundledFiles(`${relative}/${entry.name}`) : entry.isFile() ? [`${relative}/${entry.name}`] : []);
}
const manifest = [...files, 'package.json', 'README.md', ...bundledFiles('node_modules')].map((file) => ({ file, sha256: createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex') }));
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), runtime: 'Node.js 24 TypeScript type stripping', note: 'Dependency-closed runtime snapshot; no DSH loader or model provider included.', files: manifest }, null, 2) + '\n');
// Publish a fresh snapshot so removed files from an earlier build cannot leak
// into a distribution. Preserve the previous generated directory for recovery.
let previousOutput = null;
if (fs.existsSync(finalOutput)) {
  const stat = fs.lstatSync(finalOutput);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Existing distribution must be a regular directory');
  previousOutput = path.join(dist, `research-previous-${randomUUID()}`);
  fs.renameSync(finalOutput, previousOutput);
}
fs.renameSync(output, finalOutput);
process.stdout.write(JSON.stringify({ output: finalOutput, previousOutput, files: manifest.length, note: 'Copy this directory to a Node.js 24 machine; no install step is needed. Previous generated builds are retained.' }) + '\n');
