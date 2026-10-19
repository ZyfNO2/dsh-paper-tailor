/**
 * Research Bootstrap environment probes: fixed, bounded, read-only machine facts.
 *
 * Spec: docs/mvp/redesign-2026-10-08/RESEARCH-BOOTSTRAP-BE-01-INTENT-SPEC-2026-10-10.md §3,
 * shared SPEC §3.
 *
 * Hard rules implemented here:
 * - The probe list is FIXED (host identity, python, gpu, cuda, torch, repo summary). Callers can
 *   skip probes but can never add one, pass a shell string, or choose a working directory — the
 *   workspace root comes from the trusted host context and `git` is invoked with explicit `-C`.
 * - Every command is a constant template with no user/model-supplied fragments. Output is
 *   captured through file descriptors (never parsed shell strings), each probe is bounded at
 *   10 s and the whole batch at 30 s; a timeout is recorded as `failed` with its real reason.
 * - Probes observe; they never infer. CUDA version, PyTorch support and available GPUs are
 *   measured independently — none is derived from another probe's result. Missing tooling is
 *   `unavailable`, a real error is `failed`, a skipped probe is `not_run`; nothing is invented.
 * - Budgets, formal datasets and other HUMAN decisions are not machine facts and never enter
 *   here; they live in the ResearchContract.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { mintBootstrapId, PROBE_NAMES, type EnvironmentObservation, type ProbeName } from '../contracts/research-bootstrap.ts';

export type SpawnFunction = typeof spawn;

export interface ProbeRunnerOptions {
  workspaceRoot: string;
  /** Per-probe ceiling; the SPEC suggests ≤10 s. */
  timeoutPerProbeMs?: number;
  /** Whole-batch ceiling; the SPEC suggests ≤30 s. */
  totalBudgetMs?: number;
  /** Run a subset; defaults to the full fixed list (order preserved). */
  include?: ProbeName[];
  /** Injectable for structure tests; production uses node:child_process. */
  spawnImpl?: SpawnFunction;
  now?: () => Date;
}

export interface RawProbeOutcome {
  probe: ProbeName;
  status: EnvironmentObservation['status'];
  value?: unknown;
  error?: { code: string; message: string };
  source: EnvironmentObservation['source'];
  durationMs: number;
}

export interface CommandOutcome {
  missing: boolean;
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface CommandRequest {
  command: string;
  args: string[];
  label: string;
}

const OUTPUT_BYTE_LIMIT = 128 * 1024;

/** Runs one fixed-template command with fd-stdio capture; never interprets shell syntax. */
async function runFixedCommand(request: CommandRequest, spawnImpl: SpawnFunction, timeoutMs: number): Promise<CommandOutcome> {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bootstrap-probe-'));
  const outPath = path.join(scratch, 'out.txt');
  const errPath = path.join(scratch, 'err.txt');
  const out = fs.openSync(outPath, 'w');
  const err = fs.openSync(errPath, 'w');
  try {
    const child = spawnImpl(request.command, request.args, { stdio: ['ignore', out, err], windowsHide: true, timeout: timeoutMs });
    return await new Promise<CommandOutcome>((resolve, reject) => {
      child.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' || error.code === 'EACCES') resolve({ missing: true, timedOut: false, exitCode: null, stdout: '', stderr: '' });
        else reject(error);
      });
      child.on('close', (code, signal) => {
        let stdout = '';
        let stderr = '';
        try {
          stdout = fs.readFileSync(outPath, 'utf8').slice(0, OUTPUT_BYTE_LIMIT);
          stderr = fs.readFileSync(errPath, 'utf8').slice(0, OUTPUT_BYTE_LIMIT);
        } catch { /* unreadable capture stays empty; the exit status still is what it is */ }
        resolve({ missing: false, timedOut: signal !== null, exitCode: code, stdout, stderr });
      });
    });
  } finally {
    try { fs.closeSync(out); } catch { /* already closed */ }
    try { fs.closeSync(err); } catch { /* already closed */ }
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* temp cleanup is best-effort */ }
  }
}

// ------------------------------------------------------------------ fixed command templates

const PYTHON_CANDIDATES = ['python', 'python3', 'py'] as const;

const GPU_TEMPLATE: CommandRequest = {
  command: 'nvidia-smi',
  args: ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
  label: 'nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits',
};
const CUDA_TEMPLATE: CommandRequest = { command: 'nvidia-smi', args: [], label: 'nvidia-smi' };
/** Fixed, read-only torch inspection; never imports project code, never installs anything. */
const TORCH_SNIPPET = "import json,torch;print(json.dumps({'torch':getattr(torch,'__version__',None),'cuda_available':bool(getattr(torch,'cuda',None) and torch.cuda.is_available()),'cuda_version':getattr(getattr(torch,'version',None),'cuda',None)}))";
const GIT_TEMPLATES = {
  inside: (root: string): CommandRequest => ({ command: 'git', args: ['-C', root, 'rev-parse', '--is-inside-work-tree'], label: 'git -C <workspace> rev-parse --is-inside-work-tree' }),
  head: (root: string): CommandRequest => ({ command: 'git', args: ['-C', root, 'log', '-1', '--format=%H%n%cI'], label: 'git -C <workspace> log -1 --format=%H%n%cI' }),
  status: (root: string): CommandRequest => ({ command: 'git', args: ['-C', root, 'status', '--porcelain'], label: 'git -C <workspace> status --porcelain (count only)' }),
};
const REPO_MANIFESTS = ['requirements.txt', 'pyproject.toml', 'environment.yml', 'setup.py', 'package.json'] as const;

// ------------------------------------------------------------------ probe implementations

function probeHostIdentity(): RawProbeOutcome {
  const start = Date.now();
  return {
    probe: 'host_identity',
    status: 'observed',
    value: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      runtime: `node ${process.version}`,
    },
    source: { kind: 'structured_host' },
    durationMs: Date.now() - start,
  };
}

async function probePython(spawnImpl: SpawnFunction, timeoutMs: number): Promise<RawProbeOutcome> {
  const start = Date.now();
  const attempts: string[] = [];
  for (const candidate of PYTHON_CANDIDATES) {
    const outcome = await runFixedCommand({ command: candidate, args: ['--version'], label: `${candidate} --version` }, spawnImpl, timeoutMs);
    if (outcome.missing) { attempts.push(`${candidate}: not found`); continue; }
    if (outcome.timedOut) {
      return { probe: 'python_version', status: 'failed', error: { code: 'RUN_TIMEOUT', message: `${candidate} --version exceeded ${timeoutMs} ms` }, source: { kind: 'command', template: `${candidate} --version` }, durationMs: Date.now() - start };
    }
    const match = /Python\s+(\d+\.\d+(?:\.\d+)?)/.exec(`${outcome.stdout}\n${outcome.stderr}`);
    if (outcome.exitCode === 0 && match !== null) {
      return { probe: 'python_version', status: 'observed', value: { version: match[1], executable: candidate }, source: { kind: 'command', template: `${candidate} --version` }, durationMs: Date.now() - start };
    }
    attempts.push(`${candidate}: exit ${outcome.exitCode}`);
  }
  return { probe: 'python_version', status: 'unavailable', error: { code: 'PYTHON_NOT_FOUND', message: `no usable python launcher (${attempts.join('; ')})` }, source: { kind: 'command', template: PYTHON_CANDIDATES.map((entry) => `${entry} --version`).join(' | ') }, durationMs: Date.now() - start };
}

async function probeGpu(spawnImpl: SpawnFunction, timeoutMs: number): Promise<RawProbeOutcome> {
  const start = Date.now();
  const outcome = await runFixedCommand(GPU_TEMPLATE, spawnImpl, timeoutMs);
  if (outcome.missing) {
    return { probe: 'gpu', status: 'unavailable', error: { code: 'NVIDIA_SMI_NOT_FOUND', message: 'nvidia-smi is not on PATH; no NVIDIA GPU probe available' }, source: { kind: 'command', template: GPU_TEMPLATE.label }, durationMs: Date.now() - start };
  }
  if (outcome.timedOut) {
    return { probe: 'gpu', status: 'failed', error: { code: 'RUN_TIMEOUT', message: `nvidia-smi exceeded ${timeoutMs} ms` }, source: { kind: 'command', template: GPU_TEMPLATE.label }, durationMs: Date.now() - start };
  }
  if (outcome.exitCode !== 0) {
    return { probe: 'gpu', status: 'failed', error: { code: 'PROBE_COMMAND_FAILED', message: `nvidia-smi exited ${outcome.exitCode}: ${outcome.stderr.slice(0, 300) || 'no stderr'}` }, source: { kind: 'command', template: GPU_TEMPLATE.label }, durationMs: Date.now() - start };
  }
  const gpus = outcome.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).map((line) => {
    const [name, memoryTotalMb, driverVersion] = line.split(',').map((part) => part.trim());
    return { name, memoryTotalMb: Number.isFinite(Number(memoryTotalMb)) ? Number(memoryTotalMb) : null, driverVersion: driverVersion ?? null };
  });
  return { probe: 'gpu', status: 'observed', value: { gpus }, source: { kind: 'command', template: GPU_TEMPLATE.label }, durationMs: Date.now() - start };
}

async function probeCuda(spawnImpl: SpawnFunction, timeoutMs: number): Promise<RawProbeOutcome> {
  const start = Date.now();
  const outcome = await runFixedCommand(CUDA_TEMPLATE, spawnImpl, timeoutMs);
  if (outcome.missing) {
    return { probe: 'cuda', status: 'unavailable', error: { code: 'NVIDIA_SMI_NOT_FOUND', message: 'nvidia-smi is not on PATH; CUDA reachability unknown' }, source: { kind: 'command', template: CUDA_TEMPLATE.label }, durationMs: Date.now() - start };
  }
  if (outcome.timedOut) {
    return { probe: 'cuda', status: 'failed', error: { code: 'RUN_TIMEOUT', message: `nvidia-smi exceeded ${timeoutMs} ms` }, source: { kind: 'command', template: CUDA_TEMPLATE.label }, durationMs: Date.now() - start };
  }
  const header = `${outcome.stdout}\n${outcome.stderr}`;
  const match = /CUDA Version\s*:\s*([\d.]+)/.exec(header);
  if (outcome.exitCode !== 0 && match === null) {
    return { probe: 'cuda', status: 'failed', error: { code: 'PROBE_COMMAND_FAILED', message: `nvidia-smi exited ${outcome.exitCode} without a CUDA version` }, source: { kind: 'command', template: CUDA_TEMPLATE.label }, durationMs: Date.now() - start };
  }
  if (match === null) {
    return { probe: 'cuda', status: 'unavailable', error: { code: 'CUDA_VERSION_NOT_REPORTED', message: 'nvidia-smi ran but reported no CUDA version (no NVIDIA driver?)' }, source: { kind: 'command', template: CUDA_TEMPLATE.label }, durationMs: Date.now() - start };
  }
  return { probe: 'cuda', status: 'observed', value: { cudaVersion: match[1] }, source: { kind: 'command', template: CUDA_TEMPLATE.label }, durationMs: Date.now() - start };
}

async function probeTorch(spawnImpl: SpawnFunction, timeoutMs: number, pythonExecutable: string | null): Promise<RawProbeOutcome> {
  const start = Date.now();
  const candidates = pythonExecutable !== null ? [pythonExecutable] : [...PYTHON_CANDIDATES];
  const attempts: string[] = [];
  for (const executable of candidates) {
    const outcome = await runFixedCommand({ command: executable, args: ['-c', TORCH_SNIPPET], label: `${executable} -c "<fixed torch inspection>"` }, spawnImpl, timeoutMs);
    if (outcome.missing) { attempts.push(`${executable}: not found`); continue; }
    if (outcome.timedOut) {
      return { probe: 'torch', status: 'failed', error: { code: 'RUN_TIMEOUT', message: `torch inspection via ${executable} exceeded ${timeoutMs} ms` }, source: { kind: 'command', template: `${executable} -c "<fixed torch inspection>"` }, durationMs: Date.now() - start };
    }
    const parsed = parseJsonLine(outcome.stdout);
    if (outcome.exitCode === 0 && parsed !== null && typeof parsed === 'object') {
      return { probe: 'torch', status: 'observed', value: parsed, source: { kind: 'command', template: `${executable} -c "<fixed torch inspection>"` }, durationMs: Date.now() - start };
    }
    if (/ModuleNotFoundError.*torch/i.test(`${outcome.stderr}\n${outcome.stdout}`)) {
      return { probe: 'torch', status: 'unavailable', error: { code: 'TORCH_NOT_INSTALLED', message: `torch is not installed for ${executable}` }, source: { kind: 'command', template: `${executable} -c "<fixed torch inspection>"` }, durationMs: Date.now() - start };
    }
    attempts.push(`${executable}: exit ${outcome.exitCode} ${outcome.stderr.slice(0, 160)}`.trim());
  }
  return { probe: 'torch', status: 'unavailable', error: { code: 'TORCH_NOT_PROBABLE', message: attempts.length ? attempts.join('; ') : 'no python launcher available for the torch probe' }, source: { kind: 'command', template: '<python> -c "<fixed torch inspection>"' }, durationMs: Date.now() - start };
}

async function probeRepoSummary(workspaceRoot: string, spawnImpl: SpawnFunction, timeoutMs: number): Promise<RawProbeOutcome> {
  const start = Date.now();
  const manifests = REPO_MANIFESTS.filter((name) => fs.existsSync(path.join(workspaceRoot, name)));
  const inside = await runFixedCommand(GIT_TEMPLATES.inside(workspaceRoot), spawnImpl, timeoutMs);
  if (inside.missing) {
    return {
      probe: 'repo_summary', status: 'observed',
      value: { git: null, gitNote: 'git not found on PATH; repo probe limited to manifests', manifests },
      source: { kind: 'file_read', locator: '<workspace>/requirements.txt|pyproject.toml|environment.yml|setup.py|package.json' },
      durationMs: Date.now() - start,
    };
  }
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return {
      probe: 'repo_summary', status: 'observed',
      value: { git: null, gitNote: 'workspace root is not inside a git work tree', manifests },
      source: { kind: 'file_read', locator: '<workspace>/requirements.txt|pyproject.toml|environment.yml|setup.py|package.json' },
      durationMs: Date.now() - start,
    };
  }
  const head = await runFixedCommand(GIT_TEMPLATES.head(workspaceRoot), spawnImpl, timeoutMs);
  const status = await runFixedCommand(GIT_TEMPLATES.status(workspaceRoot), spawnImpl, timeoutMs);
  const [headHash, committedAt] = head.stdout.trim().split('\n');
  return {
    probe: 'repo_summary', status: 'observed',
    value: {
      git: { insideWorkTree: true, headHash: headHash ?? null, committedAt: committedAt ?? null, dirtyEntryCount: status.stdout.split('\n').filter((line) => line.trim().length > 0).length },
      manifests,
    },
    source: { kind: 'command', template: `${GIT_TEMPLATES.inside(workspaceRoot).label}; ${GIT_TEMPLATES.head(workspaceRoot).label}; ${GIT_TEMPLATES.status(workspaceRoot).label}` },
    durationMs: Date.now() - start,
  };
}

function parseJsonLine(text: string): unknown {
  for (const line of text.split('\n').reverse()) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try { return JSON.parse(trimmed); } catch { return null; }
  }
  return null;
}

// ------------------------------------------------------------------ batch runner

/**
 * Runs the fixed probe batch and returns store-ready observations. Probes run sequentially with
 * a shared wall-clock budget; probes that do not fit the budget are `not_run` with the real
 * reason, never silent holes.
 */
export async function runEnvironmentProbes(options: ProbeRunnerOptions): Promise<EnvironmentObservation[]> {
  if (typeof options.workspaceRoot !== 'string' || options.workspaceRoot.trim().length === 0) {
    throw new Error('WORKSPACE_REQUIRED: the probe runner needs the trusted workspace root');
  }
  const root = path.resolve(options.workspaceRoot);
  const timeoutPerProbeMs = options.timeoutPerProbeMs ?? 10_000;
  const totalBudgetMs = options.totalBudgetMs ?? 30_000;
  const spawnImpl = options.spawnImpl ?? spawn;
  const now = options.now ?? (() => new Date());
  const selected = (options.include ?? [...PROBE_NAMES]).filter((probe): probe is ProbeName => (PROBE_NAMES as readonly string[]).includes(probe));
  const batchStart = Date.now();
  const outcomes: RawProbeOutcome[] = [];
  for (const probe of selected) {
    const remaining = totalBudgetMs - (Date.now() - batchStart);
    if (remaining <= 0) {
      outcomes.push({ probe, status: 'not_run', error: { code: 'BUDGET_EXHAUSTED', message: `the ${totalBudgetMs} ms probe budget was spent before this probe` }, source: { kind: 'structured_host' }, durationMs: 0 });
      continue;
    }
    const budget = Math.min(timeoutPerProbeMs, remaining);
    switch (probe) {
      case 'host_identity': outcomes.push(probeHostIdentity()); break;
      case 'python_version': outcomes.push(await probePython(spawnImpl, budget)); break;
      case 'gpu': outcomes.push(await probeGpu(spawnImpl, budget)); break;
      case 'cuda': outcomes.push(await probeCuda(spawnImpl, budget)); break;
      case 'torch': {
        const python = outcomes.find((entry) => entry.probe === 'python_version' && entry.status === 'observed');
        const executable = python !== undefined ? (python.value as { executable?: string }).executable ?? null : null;
        outcomes.push(await probeTorch(spawnImpl, budget, executable));
        break;
      }
      case 'repo_summary': outcomes.push(await probeRepoSummary(root, spawnImpl, budget)); break;
    }
  }
  return outcomes.map((outcome) => ({
    observationId: mintBootstrapId('obs'),
    probe: outcome.probe,
    status: outcome.status,
    at: now().toISOString(),
    value: outcome.status === 'observed' ? outcome.value ?? null : null,
    error: outcome.error ?? null,
    source: outcome.source,
    durationMs: outcome.durationMs,
  }));
}
