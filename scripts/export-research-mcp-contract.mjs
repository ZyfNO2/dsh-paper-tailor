import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath, ['packages/research-interfaces/src/mcp.ts', '--describe'], { cwd: root, encoding: 'utf8', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`MCP descriptor failed (${result.status}): ${result.stderr}`);
const descriptor = JSON.parse(result.stdout);
const target = path.join(root, 'research-pack/contracts/mcp-v1.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== result.stdout) throw new Error('Published MCP contract differs from the current tool registry. Review compatibility and regenerate explicitly.');
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, result.stdout);
}
process.stdout.write(JSON.stringify({ contractVersion: descriptor.contractVersion, tools: descriptor.tools.length, checked: process.argv.includes('--check'), target }) + '\n');
