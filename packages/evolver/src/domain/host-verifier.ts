/**
 * HostVerifier: Authoritative Host-side validation of execution facts and raw results.
 * Produces verified-result.json only when all deterministic assertions pass.
 * Follows P1-SPEC & EVAL.md §3.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EvolverError } from '../contracts/index.ts';
import type { RunManifest, ExecutionFacts } from './task-adapter.ts';

export interface VerifiedResult {
  schemaVersion: number;
  runId: string;
  manifestHash: string;
  rawResultSha256: string;
  status: 'verified';
  verifiedMetrics: {
    initialLoss: number;
    finalLoss: number;
    finalLogits: number[][];
    sampleCount: number;
    steps: number;
    gradientCheck: {
      finite: boolean;
      anyNonZero: boolean;
    };
    parameterUpdated: boolean;
  };
  verifiedAt: string;
}

export class HostVerifier {
  verify(manifest: RunManifest, facts: ExecutionFacts): VerifiedResult {
    // 1. Process exit code must be strictly 0
    if (facts.timedOut) {
      throw new EvolverError('RUN_TIMEOUT', `Execution timed out after ${facts.durationMs}ms for run ${manifest.runId}`);
    }

    if (facts.exitCode !== 0) {
      throw new EvolverError(
        'INVALID_RESULT',
        `Process exited with non-zero exit code (${facts.exitCode}). Standard output claims cannot override exit failure.`
      );
    }

    // 2. Raw result file must exist
    if (!facts.rawResultPath || !fs.existsSync(facts.rawResultPath)) {
      throw new EvolverError(
        'INVALID_RESULT',
        `Raw result file not found at ${facts.rawResultPath ?? 'undefined'}`
      );
    }

    // 3. Parse raw-result.json
    let raw: any;
    let rawContent: string;
    try {
      rawContent = fs.readFileSync(facts.rawResultPath, 'utf8');
      raw = JSON.parse(rawContent);
    } catch (err) {
      throw new EvolverError('INVALID_RESULT', `Failed to parse raw-result.json: ${String(err)}`);
    }

    // 4. Identity and hash verification
    if (raw.runId !== manifest.runId) {
      throw new EvolverError(
        'INVALID_RESULT',
        `Run ID mismatch: expected "${manifest.runId}", received "${raw.runId}"`
      );
    }

    if (raw.manifestHash !== manifest.manifestHash) {
      throw new EvolverError(
        'INVALID_RESULT',
        `Manifest hash mismatch: expected "${manifest.manifestHash}", received "${raw.manifestHash}"`
      );
    }

    if (raw.status !== 'succeeded') {
      throw new EvolverError(
        'INVALID_RESULT',
        `Raw result reported non-succeeded status: "${raw.status}"`
      );
    }

    // 5. Structure & dataset assertions
    if (raw.sampleCount !== 16) {
      throw new EvolverError(
        'INVALID_RESULT',
        `Sample count mismatch: expected 16, received ${raw.sampleCount}`
      );
    }

    if (raw.batchSize !== 4) {
      throw new EvolverError(
        'INVALID_RESULT',
        `Batch size mismatch: expected 4, received ${raw.batchSize}`
      );
    }

    if (raw.steps !== 5) {
      throw new EvolverError('INVALID_RESULT', `Steps mismatch: expected 5, received ${raw.steps}`);
    }

    // 6. Forward pass assertions
    if (!Array.isArray(raw.finalLogits) || raw.finalLogits.length !== 4) {
      throw new EvolverError('INVALID_RESULT', 'Final logits must be an array of length 4 (batch size)');
    }

    for (let r = 0; r < 4; r++) {
      const row = raw.finalLogits[r];
      if (!Array.isArray(row) || row.length !== 2) {
        throw new EvolverError('INVALID_RESULT', `Logits row ${r} must be an array of length 2`);
      }
      for (let c = 0; c < 2; c++) {
        const val = row[c];
        if (typeof val !== 'number' || !Number.isFinite(val) || Number.isNaN(val)) {
          throw new EvolverError('INVALID_RESULT', `Non-finite/NaN logits value at [${r}, ${c}]: ${val}`);
        }
      }
    }

    // 7. Backward pass & loss assertions
    if (typeof raw.finalLoss !== 'number' || !Number.isFinite(raw.finalLoss) || Number.isNaN(raw.finalLoss)) {
      throw new EvolverError('INVALID_RESULT', `Invalid or non-finite final loss: ${raw.finalLoss}`);
    }

    if (!raw.gradientCheck || raw.gradientCheck.finite !== true) {
      throw new EvolverError('INVALID_RESULT', 'Backward gradient check failed: non-finite gradients detected');
    }

    if (raw.gradientCheck.anyNonZero !== true) {
      throw new EvolverError('INVALID_RESULT', 'Backward gradient check failed: all gradients are zero');
    }

    if (raw.parameterUpdated !== true) {
      throw new EvolverError('INVALID_RESULT', 'No model parameters were updated after 5 training steps');
    }

    // 8. Module execution assertions for variants (P3)
    if (manifest.recipe) {
      const variant = manifest.recipe.variant;
      if (raw.variant !== variant) {
        throw new EvolverError(
          'INVALID_RESULT',
          `Variant mismatch: expected "${variant}", got "${raw.variant}"`
        );
      }

      const modExec = raw.modulesExecuted ?? {};
      if (variant === 'ab') {
        const asppExec = modExec['module-aspp-v1'];
        const seExec = modExec['module-se-v1'];
        if (!asppExec || asppExec.executionCount === 0 || !asppExec.parameterUpdated) {
          throw new EvolverError('INVALID_RESULT', 'Variant "ab" failed verification: module A (ASPP) was not actively executed/updated');
        }
        if (!seExec || seExec.executionCount === 0 || !seExec.parameterUpdated) {
          throw new EvolverError('INVALID_RESULT', 'Variant "ab" failed verification: module B (SE) was not actively executed/updated');
        }
      } else if (variant === 'a') {
        const asppExec = modExec['module-aspp-v1'];
        if (!asppExec || asppExec.executionCount === 0) {
          throw new EvolverError('INVALID_RESULT', 'Variant "a" failed: module A was not executed');
        }
        if (modExec['module-se-v1']) {
          throw new EvolverError('INVALID_RESULT', 'Variant "a" orthogonality violation: module B is present');
        }
      } else if (variant === 'b') {
        const seExec = modExec['module-se-v1'];
        if (!seExec || seExec.executionCount === 0) {
          throw new EvolverError('INVALID_RESULT', 'Variant "b" failed: module B was not executed');
        }
        if (modExec['module-aspp-v1']) {
          throw new EvolverError('INVALID_RESULT', 'Variant "b" orthogonality violation: module A is present');
        }
      } else if (variant === 'baseline') {
        if (Object.keys(modExec).length > 0) {
          throw new EvolverError('INVALID_RESULT', 'Variant "baseline" orthogonality violation: modules are present');
        }
      }
    }

    // 9. Publish verified-result.json
    const rawResultSha256 = crypto.createHash('sha256').update(rawContent).digest('hex');

    const verifiedResult: VerifiedResult = {
      schemaVersion: 1,
      runId: manifest.runId,
      manifestHash: manifest.manifestHash,
      rawResultSha256,
      status: 'verified',
      verifiedMetrics: {
        initialLoss: raw.initialLoss,
        finalLoss: raw.finalLoss,
        finalLogits: raw.finalLogits,
        sampleCount: 16,
        steps: 5,
        gradientCheck: raw.gradientCheck,
        parameterUpdated: raw.parameterUpdated,
        ...(raw.variant ? { variant: raw.variant } : {}),
        ...(raw.modulesExecuted ? { modulesExecuted: raw.modulesExecuted } : {}),
      } as any,
      verifiedAt: new Date().toISOString(),
    };

    const verifiedPath = path.join(manifest.outputDir, 'verified-result.json');
    fs.writeFileSync(verifiedPath, JSON.stringify(verifiedResult, null, 2), 'utf8');

    return verifiedResult;
  }
}
