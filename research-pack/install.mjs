import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const source = path.dirname(fileURLToPath(import.meta.url)), runtime = path.dirname(source);
const index = process.argv.indexOf('--workspace'), requested = index < 0 ? undefined : process.argv[index + 1];
if (!requested) throw new Error('--workspace must name an existing workspace; default is a read-only preview');
const workspace = fs.realpathSync(requested), destination = path.join(workspace, '.agents/skills/dsh-research'), configFile = path.join(workspace, '.agents/dsh-research.mcp.json');
for (const relative of ['.agents', '.agents/skills', '.agents/skills/dsh-research']) {
  const candidate = path.join(workspace, relative);
  if (fs.existsSync(candidate) && (fs.lstatSync(candidate).isSymbolicLink() || !fs.lstatSync(candidate).isDirectory())) throw new Error(`PATH_ESCAPE: install ancestor is a link or non-directory: ${relative}`);
}
if (fs.existsSync(destination) || fs.existsSync(configFile)) throw new Error('ALREADY_EXISTS: installer never overwrites existing skills or MCP configuration');
const mcp = path.join(runtime, 'packages/research-interfaces/src/mcp.ts');
if (!fs.existsSync(mcp)) throw new Error('Run the installer from the distribution or repository research-pack directory');
const list = (root, prefix = '') => fs.readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
  if (entry.isSymbolicLink()) throw new Error('Research Pack must not contain symlinks');
  const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? list(root, relative) : entry.isFile() && (entry.name.endsWith('.md') || relative.startsWith('contracts/') && entry.name.endsWith('.json')) ? [relative] : [];
});
const files = list(source), configuration = { mcpServers: { dshResearch: { command: process.execPath, args: [mcp, '--workspace', workspace], env: { RESEARCH_AGENT_ID: `client-${randomUUID()}` } } } };
if (process.argv.includes('--write')) {
  for (const file of files) { const target = path.join(destination, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(path.join(source, file), target, fs.constants.COPYFILE_EXCL); }
  fs.writeFileSync(configFile, JSON.stringify(configuration, null, 2) + '\n', { flag: 'wx' });
}
process.stdout.write(JSON.stringify({ mode: process.argv.includes('--write') ? 'installed' : 'preview', workspace, destination, configFile, files, note: 'Merge the generated MCP entry into your chosen client. No global config, credentials, or background Agent was changed.' }, null, 2) + '\n');
