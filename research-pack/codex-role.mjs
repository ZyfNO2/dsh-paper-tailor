import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

if (process.argv.includes('--help')) {
  process.stdout.write('Usage: node research-pack/codex-role.mjs --workspace <existing> --research <id> --run <user-prepared-external-run> [--all]\nRequires explicit RESEARCH_CODEX_EXECUTABLE. --all advances all ready roles until user review; otherwise handles one role. Runs directly through MCP without a workbench or HTTP server. Never prepares, approves, retries or applies a decision. Reviews remain self_review.\n');
  process.exit(0);
}

const flag = (name) => { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${name} required`); return process.argv[i + 1]; };
const workspace = fs.realpathSync(flag('--workspace')), researchId = flag('--research'), runId = flag('--run');
if (!/^[\w-]+$/.test(researchId) || !/^[\w-]+$/.test(runId)) throw new Error('Stable research/run IDs required');
if (!process.env.RESEARCH_CODEX_EXECUTABLE || !path.isAbsolute(process.env.RESEARCH_CODEX_EXECUTABLE) || !fs.statSync(process.env.RESEARCH_CODEX_EXECUTABLE).isFile()) throw new Error('Explicit existing absolute RESEARCH_CODEX_EXECUTABLE required; this command invokes a real model');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientId = process.env.RESEARCH_AGENT_ID ?? `codex-role-${runId}`;
const allRoles = process.argv.includes('--all');
const proc = spawn(process.execPath, [path.join(root, 'packages/research-interfaces/src/mcp.ts'), '--workspace', workspace], { env: { ...process.env, RESEARCH_AGENT_ID: clientId }, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map(); let sequence = 0, ended = false;
proc.stderr.on('data', (chunk) => process.stderr.write(chunk));
createInterface({ input: proc.stdout }).on('line', (line) => {
  try { const message = JSON.parse(line), entry = pending.get(message.id); if (entry) { pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result); } }
  catch (error) { for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); }
});
const abortPending = (error) => { ended = true; for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); } pending.clear(); };
proc.on('error', abortPending); proc.on('exit', (code) => abortPending(new Error(`MCP exited ${code}`)));
proc.stdin.on('error', abortPending);
const request = (method, params = {}) => new Promise((resolve, reject) => {
  if (ended) { reject(new Error('MCP process already exited')); return; }
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${method} timed out; re-read persisted state`)); }, 15000);
  pending.set(id, { resolve, reject, timer }); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const tool = async (name, args) => { const result = await request('tools/call', { name, arguments: args }); if (result.isError) throw new Error(result.content[0].text); return result.structuredContent; };
const action = (payload) => tool('external_cycle_action', { researchId, payload });
let claimed;
try {
  await request('initialize');
  for (let completed = 0; completed <= 4; completed++) {
  claimed = undefined;
  const view = await tool('cycle_query', { researchId, runId });
  const run = view.runs.find((r) => r.runId === runId);
  if (allRoles && run?.externalHandoff && ['waiting_result', 'completed'].includes(run.status)) {
    process.stdout.write(JSON.stringify({ researchId, runId, status: run.status, decisionRefs: run.decisionRefs, cycleRevision: view.research.cycleRevision, reviewMode: 'self_review', workbenchRequired: false }) + '\n');
    break;
  }
  if (completed === 4) throw new Error('Four roles submitted but run did not reach user-review boundary; inspect persisted state');
  if (!run?.externalHandoff || !['queued', 'running'].includes(run.status)) throw new Error('User-authorized active external handoff required; this command cannot prepare/approve/retry');
  const steps = view.steps.filter((s) => s.runId === runId);
  const step = steps.find((s) => ['pending', 'running'].includes(s.status) && (s.status !== 'running' || s.assignedMemberId === `mcp:${clientId}`) && s.dependsOn.every((id) => view.steps.some((dependency) => dependency.stepId === id && dependency.status === 'completed')));
  if (!step) throw new Error('No pending or own running role; inspect current assignments');
  claimed = await action({ action: 'claim', runId, stepId: step.stepId, attemptId: step.attemptId, cycleRevision: view.research.cycleRevision });
  const assignedInputs = [];
  for (const inputRef of claimed.step.inputRefs) assignedInputs.push({ inputRef, ...await action({ action: 'input', runId, stepId: step.stepId, inputRef }) });
  const context = { schemaVersion: 1, action: 'external_cycle_role', role: step.role, runPins: { runId, nodeId: claimed.run.nodeId, selectedIdeaRef: claimed.run.selectedIdeaRef }, snapshot: claimed.snapshot, outputContract: claimed.outputContract, assignedInputs };
  const serialized = JSON.stringify(context); if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('Role context exceeds 1 MiB');
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'research-pack/codex-generator.mjs')], { cwd: workspace, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '', diagnostic = '', first;
    const timer = setTimeout(() => { first ??= new Error('Codex role timeout; descendant process stop unverified'); child.kill(); reject(first); }, 300000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (data) => { if (first) return; text += data; if (Buffer.byteLength(text) > 512 * 1024) { first = new Error('Role output exceeds 512 KiB'); clearTimeout(timer); child.kill(); reject(first); } });
    child.stderr.on('data', (data) => { diagnostic = (diagnostic + data.toString()).slice(-1600); process.stderr.write(data); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); }); child.stdin.on('error', (error) => { first ??= error; });
    child.on('close', (code) => { clearTimeout(timer); if (first || code !== 0) { reject(first ?? new Error(`Codex adapter exited ${code}; stderr tail: ${diagnostic}`)); return; } try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    child.stdin.end(serialized);
  });
  const published = await action({ action: 'publish', runId, stepId: step.stepId, attemptId: step.attemptId, kind: claimed.outputContract.kind, payload: output });
  const submitted = await action({ action: 'submit', operationId: `codex-submit-${step.attemptId}`, runId, stepId: step.stepId, attemptId: step.attemptId, outputRefs: [published.ref], cycleRevision: published.cycleRevision });
  process.stdout.write(JSON.stringify({ researchId, runId, role: step.role, attemptId: step.attemptId, assignedMemberId: claimed.step.assignedMemberId, ref: published.ref, submitted, reviewMode: 'self_review' }) + '\n');
  if (!allRoles) break;
  }
} catch (error) {
  if (claimed) {
    try { await action({ action: 'fail', runId, stepId: claimed.step.stepId, attemptId: claimed.step.attemptId, code: 'CODEX_ROLE_FAILED', message: String(error).slice(0, 1900) }); }
    catch (recordError) { throw new AggregateError([error, recordError], 'Original role failure and failure-recording error; neither is a success'); }
  }
  throw error;
} finally { proc.stdin.end(); proc.kill(); }
