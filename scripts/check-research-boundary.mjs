import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const starts = [
  'packages/research-contracts/src',
  'packages/research-core/src',
  'packages/research-interfaces/src',
].map((dir) => path.join(repoRoot, dir));

const forbiddenText = ['adapters/dsh', '@deepseek-ai/', 'cordis', 'evolver-ui', 'research-redesign-dsh'];
const forbiddenResolved = [
  path.normalize('packages/evolver/src/index.ts'),
  path.normalize('packages/evolver/src/application/index.ts'),
  path.normalize('packages/evolver/src/application/phase3-service.ts'),
  path.normalize('packages/evolver/src/research-redesign-dsh.ts'),
];

const specifierPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function filesUnder(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else if (name.endsWith('.ts') || name.endsWith('.mjs')) found.push(full);
  }
  return found;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, path.join(base, 'index.ts')];
  return candidates.find((candidate) => {
    try { return statSync(candidate).isFile(); } catch { return false; }
  }) ?? null;
}

const queue = starts.flatMap((dir) => filesUnder(dir));
const seen = new Set();
const violations = [];

while (queue.length) {
  const file = queue.pop();
  if (seen.has(file)) continue;
  seen.add(file);
  const text = readFileSync(file, 'utf8');
  const relativeFile = path.normalize(path.relative(repoRoot, file));
  if (relativeFile.includes(`${path.normalize('packages/evolver/src/adapters')}${path.sep}`) || forbiddenResolved.includes(relativeFile)) {
    violations.push(`${relativeFile} is on the research-core import path`);
  }
  for (const match of text.matchAll(specifierPattern)) {
    const specifier = match[1];
    if (forbiddenText.some((token) => specifier.includes(token))) {
      violations.push(`${relativeFile} imports ${specifier}`);
    }
    const next = resolveSpecifier(file, specifier);
    if (next) queue.push(next);
  }
}

if (violations.length) {
  process.stderr.write(`${violations.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(process.argv.includes('--json')
  ? `${JSON.stringify({ files: [...seen].map((file) => path.relative(repoRoot, file).replaceAll('\\', '/')).sort() })}\n`
  : `research boundary ok (${seen.size} files)\n`);
