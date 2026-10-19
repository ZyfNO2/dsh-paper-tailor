/**
 * CampaignOrchestrator: Manages the 4-variant matrix execution,
 * task state persistence, and self-contained campaign artifact export.
 * Follows CONTRACTS.md §6 & P4-SPEC.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  type Task,
  type Campaign,
  type Run,
  type Artifact,
  type AssemblyPlan,
  EvolverError,
} from '../contracts/index.ts';
import { TaskAdapter, type ExecutionTarget } from '../domain/task-adapter.ts';
import { HostVerifier, type VerifiedResult } from '../domain/host-verifier.ts';
import { RecipeBuilder, type ModelRecipe } from '../domain/recipe-builder.ts';

export class CampaignOrchestrator {
  readonly adapter: TaskAdapter;
  readonly verifier: HostVerifier;
  readonly builder: RecipeBuilder;

  constructor(
    adapter = new TaskAdapter(),
    verifier = new HostVerifier(),
    builder = new RecipeBuilder()
  ) {
    this.adapter = adapter;
    this.verifier = verifier;
    this.builder = builder;
  }

  async runMatrix(
    campaignId: string,
    plan: AssemblyPlan,
    options: { outputBaseDir?: string } = {}
  ): Promise<{ campaign: Campaign; runs: Record<string, VerifiedResult> }> {
    const baseDir = options.outputBaseDir
      ? path.resolve(options.outputBaseDir)
      : path.resolve(`artifacts/campaigns/${campaignId}`);
    fs.mkdirSync(baseDir, { recursive: true });

    const variants: Array<'baseline' | 'a' | 'b' | 'ab'> = ['baseline', 'a', 'b', 'ab'];
    const runIds: string[] = [];
    const verifiedRuns: Record<string, VerifiedResult> = {};

    let campaignFailed = false;
    let campaignError: any = undefined;

    for (const v of variants) {
      const vDir = path.join(baseDir, v);
      fs.mkdirSync(vDir, { recursive: true });

      const recipe = this.builder.build(plan, v);
      const runId = `run-${campaignId}-${v}`;
      runIds.push(runId);

      const target: ExecutionTarget = v === 'baseline'
        ? { kind: 'baseline', baseline: plan.baselineRef }
        : { kind: 'variant', baseline: plan.baselineRef, plan, variant: v };

      try {
        const manifest = await this.adapter.prepare(target, runId, {
          outputDir: vDir,
          recipe,
        });

        const facts = await this.adapter.execute(manifest);
        const verified = this.verifier.verify(manifest, facts);
        verifiedRuns[v] = verified;
      } catch (err: unknown) {
        campaignFailed = true;
        campaignError = {
          code: err instanceof EvolverError ? err.code : 'INVALID_RESULT',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        };
        break; // Stop remaining variants on failure
      }
    }

    const planHash = crypto.createHash('sha256').update(JSON.stringify(plan)).digest('hex');

    const campaign: Campaign = {
      id: campaignId,
      planHash,
      taskSpecSnapshot: { protocolId: 'stitch-cpu-v1' },
      matrix: variants,
      status: campaignFailed ? 'failed' : 'succeeded',
      operationId: `op-${campaignId}`,
      runIds,
      ...(campaignError ? { error: campaignError } : {}),
    };

    const campaignSummaryPath = path.join(baseDir, 'campaign-summary.json');
    fs.writeFileSync(
      campaignSummaryPath,
      JSON.stringify({ campaign, runs: verifiedRuns }, null, 2),
      'utf8'
    );

    return { campaign, runs: verifiedRuns };
  }

  exportCampaign(campaign: Campaign, runs: Record<string, VerifiedResult>, exportDir: string): Artifact[] {
    const targetDir = path.resolve(exportDir);
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });

    const artifacts: Artifact[] = [];

    // Copy verified results and write inventory
    const inventory: Array<{ path: string; sha256: string; bytes: number }> = [];

    for (const [variant, verified] of Object.entries(runs)) {
      const vDestDir = path.join(targetDir, variant);
      fs.mkdirSync(vDestDir, { recursive: true });

      const verifiedPath = path.join(vDestDir, 'verified-result.json');
      const content = JSON.stringify(verified, null, 2);
      fs.writeFileSync(verifiedPath, content, 'utf8');

      const bytes = Buffer.byteLength(content, 'utf8');
      const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

      const relPath = `${variant}/verified-result.json`;
      inventory.push({ path: relPath, sha256, bytes });

      artifacts.push({
        id: `artifact-${variant}-verified`,
        kind: 'verified_result',
        relativePath: relPath,
        sha256,
        bytes,
        producerRunId: verified.runId,
      });
    }

    // Write export manifest
    const exportManifest = {
      schemaVersion: 1,
      campaignId: campaign.id,
      exportedAt: new Date().toISOString(),
      inventory,
    };

    const manifestContent = JSON.stringify(exportManifest, null, 2);
    const manifestPath = path.join(targetDir, 'export-manifest.json');
    fs.writeFileSync(manifestPath, manifestContent, 'utf8');

    artifacts.push({
      id: `artifact-export-manifest`,
      kind: 'export_manifest',
      relativePath: 'export-manifest.json',
      sha256: crypto.createHash('sha256').update(manifestContent).digest('hex'),
      bytes: Buffer.byteLength(manifestContent, 'utf8'),
      operationId: campaign.operationId,
    });

    return artifacts;
  }
}
