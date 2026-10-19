import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { BootstrapState } from '../contracts/research-bootstrap.ts';

export interface ObservedResearchResult {
  runId: string;
  researchId: string;
  nodeId: string;
  method: string;
  dataset: string;
  origin: 'real_run';
  evidenceStatus: 'provenance_checked';
  metrics: Record<string, number>;
  artifacts: Array<{ path: string; sha256: string; role: string }>;
}

/** Consume explicit manifests, never infer metrics or real execution from prose. */
export function readResearchResults(workspaceRoot: string, state: BootstrapState): { results: ObservedResearchResult[]; errors: Array<{ file: string; message: string }> } {
  const folder = path.join(workspaceRoot, '.dsh', 'research', 'results');
  if (!fs.existsSync(folder)) return { results: [], errors: [] };
  const root = fs.realpathSync(workspaceRoot);
  const folderRelative = path.relative(root, fs.realpathSync(folder));
  if (folderRelative.startsWith('..') || path.isAbsolute(folderRelative)) throw new Error('Result manifest directory escapes workspace');
  const results: ObservedResearchResult[] = [], errors: Array<{ file: string; message: string }> = [];
  const names = fs.readdirSync(folder).filter((name) => name.endsWith('.json')).sort();
  if (names.length > 200) throw new Error('Result manifest bound exceeded (200)');
  const text = (value: unknown, label: string): string => {
    if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw new Error(`${label} must be nonempty text (max 1000)`);
    return value;
  };
  for (const name of names) {
    try {
      const manifestPath = path.join(folder, name);
      if (!fs.lstatSync(manifestPath).isFile() || fs.statSync(manifestPath).size > 128 * 1024) throw new Error('Manifest must be a regular file <= 128 KiB');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.schemaVersion !== 1 || manifest.origin !== 'real_run' || manifest.status !== 'completed') throw new Error('Only completed real_run manifests with schemaVersion 1 can update observed results');
      const runId = text(manifest.runId, 'runId');
      if (!/^[\w-]+$/.test(runId) || name !== `${runId}.json`) throw new Error('Filename must match the bounded runId');
      const researchId = text(manifest.researchId, 'researchId'), nodeId = text(manifest.nodeId, 'nodeId');
      const research = state.researches.find((r) => r.researchId === researchId);
      const node = research?.graph?.nodes.find((n) => n.nodeId === nodeId);
      if (!node || !['baseline', 'hypothesis', 'experiment', 'run'].includes(node.kind)) throw new Error('Result must match an existing baseline or research branch node');
      const method = text(manifest.method, 'method'), dataset = text(manifest.dataset, 'dataset');
      if (node.kind === 'baseline' && research?.contract.baseline.name !== method) throw new Error('Baseline result method must match the recorded baseline identity');
      const artifacts: ObservedResearchResult['artifacts'] = [];
      const readArtifact = (role: string, maxBytes: number): string => {
        const artifact = manifest[`${role}Artifact`];
        if (!artifact || typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`${role}Artifact requires path and SHA-256`);
        if (path.isAbsolute(artifact.path) || /^[a-z]:|^\\\\/i.test(artifact.path)) throw new Error('Artifact paths must be workspace-relative');
        const lexical = path.resolve(root, artifact.path);
        const relative = path.relative(root, lexical);
        if (relative.startsWith('..') || path.isAbsolute(relative) || relative.split(path.sep).some((p) => ['.git', '.aws', '.codex'].includes(p))) throw new Error(`${role}Artifact path escapes allowed workspace`);
        const target = fs.realpathSync(lexical), resolved = path.relative(root, target);
        if (resolved.startsWith('..') || path.isAbsolute(resolved)) throw new Error(`${role}Artifact resolves outside workspace`);
        const info = fs.statSync(target);
        if (!info.isFile() || info.size < 1 || info.size > maxBytes) throw new Error(`${role}Artifact must be a nonempty bounded file`);
        const buffer = fs.readFileSync(target);
        if (createHash('sha256').update(buffer).digest('hex') !== artifact.sha256) throw new Error(`${role}Artifact SHA-256 mismatch`);
        artifacts.push({ path: artifact.path, sha256: artifact.sha256, role });
        return buffer.toString('utf8');
      };
      const data = JSON.parse(readArtifact('metrics', 1024 * 1024));
      readArtifact('log', 16 * 1024 * 1024);
      readArtifact('config', 1024 * 1024);
      // Identity must be inside the measured artifact too, not only in a wrapper.
      if (data.runId !== runId || data.researchId !== researchId || data.nodeId !== nodeId || data.method !== method || data.dataset !== dataset || data.origin !== 'real_run') throw new Error('Measured artifact identity differs from result manifest');
      if (!data.metrics || typeof data.metrics !== 'object' || Array.isArray(data.metrics)) throw new Error('Measured artifact requires metrics object');
      const entries = Object.entries(data.metrics);
      if (!entries.length || entries.length > 50 || entries.some(([key, value]) => !key.trim() || key.length > 100 || typeof value !== 'number' || !Number.isFinite(value))) throw new Error('Metrics must contain 1–50 finite measured values');
      results.push({ runId, researchId, nodeId, method, dataset, origin: 'real_run', evidenceStatus: 'provenance_checked', metrics: data.metrics, artifacts });
    } catch (error) {
      errors.push({ file: name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { results, errors };
}
