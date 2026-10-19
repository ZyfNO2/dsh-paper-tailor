/**
 * TaskAdapter: Manages process execution, environment preflight,
 * manifest preparation, and execution facts for stitch-cpu-v1.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  type TaskSpec,
  type BaselineRef,
  type AssemblyPlan,
  EvolverError,
} from '../contracts/index.ts';

export type ExecutionTarget =
  | { kind: 'baseline'; baseline: BaselineRef }
  | { kind: 'variant'; baseline: BaselineRef; plan: AssemblyPlan; variant: 'a' | 'b' | 'ab' };

import type { ModelRecipe } from './recipe-builder.ts';

export interface RunManifest {
  schemaVersion: number;
  runId: string;
  manifestHash: string;
  target: ExecutionTarget;
  recipe?: ModelRecipe;
  seed: number;
  steps: number;
  lr: number;
  protocolId: string;
  protocolHash: string;
  baseWeightPath: string;
  outputDir: string;
  environmentHash: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
  createdAt: string;
}

export interface ExecutionFacts {
  runId: string;
  manifestHash: string;
  exitCode: number;
  signal?: string;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  rawResultPath?: string;
  completedAt: string;
}

export interface ProcessIdentity {
  pid: number;
  runId: string;
  startTime: number;
}

export interface PreflightReport {
  ok: boolean;
  pythonPath: string;
  torchVersion?: string;
  device: string;
  details: Record<string, unknown>;
}

export class TaskAdapter {
  readonly pythonPath: string;
  readonly experimentsDir: string;
  readonly weightsDir: string;
  private readonly _activeProcesses = new Map<string, { pid: number; kill: () => void }>();

  constructor(
    pythonPath = 'G:\\Anaconda\\python.exe',
    experimentsDir = 'experiments/stitch-cpu-v1',
    weightsDir = 'artifacts/weights'
  ) {
    this.pythonPath = path.resolve(pythonPath);
    this.experimentsDir = path.resolve(experimentsDir);
    this.weightsDir = path.resolve(weightsDir);
    fs.mkdirSync(this.weightsDir, { recursive: true });
  }

  async preflight(_spec?: TaskSpec): Promise<PreflightReport> {
    if (!fs.existsSync(this.pythonPath)) {
      throw new EvolverError('PREFLIGHT_FAILED', `Python executable not found at ${this.pythonPath}`);
    }

    return new Promise((resolve) => {
      const probeScript = 'import torch; print(f"TORCH_OK:{torch.__version__}")';
      const outTmp = path.resolve(`artifacts/test-scratch/preflight-${Date.now()}.tmp`);
      fs.mkdirSync(path.dirname(outTmp), { recursive: true });
      const outFd = fs.openSync(outTmp, 'w');

      try {
        const child = spawn(this.pythonPath, ['-c', probeScript], {
          stdio: ['ignore', outFd, outFd],
        });

        child.on('close', (code) => {
          fs.closeSync(outFd);
          let out = '';
          if (fs.existsSync(outTmp)) {
            out = fs.readFileSync(outTmp, 'utf8');
            try { fs.unlinkSync(outTmp); } catch {}
          }

          if (code === 0 && out.includes('TORCH_OK:')) {
            const version = out.split('TORCH_OK:')[1].trim();
            resolve({
              ok: true,
              pythonPath: this.pythonPath,
              torchVersion: version,
              device: 'cpu',
              details: { version, output: out },
            });
          } else {
            resolve({
              ok: false,
              pythonPath: this.pythonPath,
              device: 'cpu',
              details: { exitCode: code, output: out },
            });
          }
        });

        child.on('error', (err) => {
          try { fs.closeSync(outFd); } catch {}
          resolve({
            ok: false,
            pythonPath: this.pythonPath,
            device: 'cpu',
            details: { error: String(err) },
          });
        });
      } catch (err) {
        try { fs.closeSync(outFd); } catch {}
        resolve({
          ok: false,
          pythonPath: this.pythonPath,
          device: 'cpu',
          details: { error: String(err) },
        });
      }
    });
  }

  async prepare(
    target: ExecutionTarget,
    runId: string,
    options: {
      seed?: number;
      steps?: number;
      lr?: number;
      timeoutMs?: number;
      outputDir?: string;
      recipe?: ModelRecipe;
    } = {}
  ): Promise<RunManifest> {
    const seed = options.seed ?? 20260929;
    const steps = options.steps ?? 5;
    const lr = options.lr ?? 0.01;
    const timeoutMs = options.timeoutMs ?? 120000;
    const runOutputDir = options.outputDir ?? path.resolve(`artifacts/runs/${runId}`);
    fs.mkdirSync(runOutputDir, { recursive: true });

    const baseWeightPath = path.join(this.weightsDir, 'baseline_seed20260929.pt');
    const runnerScript = path.join(this.experimentsDir, 'runner.py');

    const manifestWithoutHash = {
      schemaVersion: 1,
      runId,
      target,
      ...(options.recipe ? { recipe: options.recipe } : {}),
      seed,
      steps,
      lr,
      protocolId: 'stitch-cpu-v1',
      protocolHash: 'stitch-cpu-v1-sha256',
      baseWeightPath,
      outputDir: runOutputDir,
      environmentHash: crypto.createHash('sha256').update(this.pythonPath).digest('hex'),
      argv: [this.pythonPath, runnerScript],
      cwd: path.resolve('.'),
      timeoutMs,
      createdAt: new Date().toISOString(),
    };

    const manifestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(manifestWithoutHash))
      .digest('hex');

    const manifest: RunManifest = {
      ...manifestWithoutHash,
      manifestHash,
    };

    const manifestPath = path.join(runOutputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return manifest;
  }

  async execute(manifest: RunManifest, signal?: AbortSignal): Promise<ExecutionFacts> {
    const runOutputDir = manifest.outputDir;
    fs.mkdirSync(runOutputDir, { recursive: true });

    const manifestPath = path.join(runOutputDir, 'manifest.json');
    const stdoutPath = path.join(runOutputDir, 'stdout.log');
    const stderrPath = path.join(runOutputDir, 'stderr.log');

    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');

    const runnerScript = path.join(this.experimentsDir, 'runner.py');
    const args = [runnerScript, '--manifest', manifestPath];

    const startTime = Date.now();
    let timedOut = false;
    let aborted = false;

    return new Promise((resolve) => {
      let child: any = null;
      let timer: NodeJS.Timeout | null = null;

      const cleanup = (code: number | null, sig: string | null) => {
        if (timer) clearTimeout(timer);
        this._activeProcesses.delete(manifest.runId);

        try { fs.closeSync(stdoutFd); } catch {}
        try { fs.closeSync(stderrFd); } catch {}

        const durationMs = Date.now() - startTime;
        const stdout = fs.existsSync(stdoutPath) ? fs.readFileSync(stdoutPath, 'utf8') : '';
        const stderr = fs.existsSync(stderrPath) ? fs.readFileSync(stderrPath, 'utf8') : '';
        const rawResultPath = path.join(runOutputDir, 'raw-result.json');

        const facts: ExecutionFacts = {
          runId: manifest.runId,
          manifestHash: manifest.manifestHash,
          exitCode: code ?? (timedOut ? 124 : aborted ? 130 : 1),
          signal: sig ?? (timedOut ? 'SIGKILL' : aborted ? 'SIGINT' : undefined),
          timedOut,
          durationMs,
          stdout,
          stderr,
          rawResultPath: fs.existsSync(rawResultPath) ? rawResultPath : undefined,
          completedAt: new Date().toISOString(),
        };

        resolve(facts);
      };

      try {
        child = spawn(this.pythonPath, args, {
          cwd: manifest.cwd,
          stdio: ['ignore', stdoutFd, stderrFd],
          windowsHide: true,
        });

        if (child.pid) {
          this._activeProcesses.set(manifest.runId, {
            pid: child.pid,
            kill: () => {
              try { process.kill(child.pid); } catch {}
            },
          });
        }

        // Set timeout killer
        if (manifest.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            try { process.kill(child.pid); } catch {}
          }, manifest.timeoutMs);
        }

        // Set abort signal handler
        if (signal) {
          if (signal.aborted) {
            aborted = true;
            try { process.kill(child.pid); } catch {}
          } else {
            signal.addEventListener('abort', () => {
              aborted = true;
              try { process.kill(child.pid); } catch {}
            }, { once: true });
          }
        }

        child.on('close', (code: number | null, sig: string | null) => {
          cleanup(code, sig);
        });

        child.on('error', (_err: unknown) => {
          cleanup(1, null);
        });
      } catch (err) {
        cleanup(1, null);
      }
    });
  }

  stopRun(runId: string): boolean {
    const proc = this._activeProcesses.get(runId);
    if (proc) {
      proc.kill();
      this._activeProcesses.delete(runId);
      return true;
    }
    return false;
  }

  async reconcile(identity: ProcessIdentity): Promise<'absent' | 'running' | 'unknown'> {
    if (!identity || !identity.pid) return 'absent';
    try {
      process.kill(identity.pid, 0);
      return 'running';
    } catch {
      return 'absent';
    }
  }
}
