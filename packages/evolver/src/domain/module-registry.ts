/**
 * ModuleRegistry: Manages academic paper source import, module catalog,
 * source integrity verification, contract validation, and functional readiness.
 * Follows docs/mvp/CONTRACTS.md & P2-SPEC.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  type SourceRef,
  type ModuleCard,
  EvolverError,
} from '../contracts/index.ts';

export interface ReadyReport {
  id: string;
  status: 'ready' | 'rejected';
  timestamp: string;
  modules: Array<{
    id: string;
    implementationId: string;
    implementationHash: string;
    mechanism: string;
    sourceVerified: boolean;
    contractVerified: boolean;
    functionalSmokeVerified: boolean;
    maxFeatureDiff: number;
  }>;
}

export class ModuleRegistry {
  readonly papersManifestPath: string;
  readonly modulesManifestPath: string;
  readonly pythonPath: string;

  constructor(
    papersManifestPath = 'fixtures/papers/manifest.json',
    modulesManifestPath = 'fixtures/modules/manifest.json',
    pythonPath = 'G:\\Anaconda\\python.exe'
  ) {
    this.papersManifestPath = path.resolve(papersManifestPath);
    this.modulesManifestPath = path.resolve(modulesManifestPath);
    this.pythonPath = path.resolve(pythonPath);
  }

  importSources(customManifestPath?: string): SourceRef[] {
    const targetPath = customManifestPath ? path.resolve(customManifestPath) : this.papersManifestPath;
    if (!fs.existsSync(targetPath)) {
      throw new EvolverError('SOURCE_MISMATCH', `Paper manifest file not found: ${targetPath}`);
    }

    const raw = fs.readFileSync(targetPath, 'utf8');
    const data = JSON.parse(raw);
    const sourceRefs: SourceRef[] = [];

    for (const doc of data.documents) {
      // Verify snapshot on disk exists
      const snapshotAbs = path.resolve(doc.snapshotPath);
      if (!fs.existsSync(snapshotAbs)) {
        throw new EvolverError('SOURCE_MISMATCH', `Source snapshot missing: ${doc.snapshotPath}`);
      }

      // Verify document hash
      const snapshotContent = fs.readFileSync(snapshotAbs);
      const computedDocHash = crypto.createHash('sha256').update(snapshotContent).digest('hex');
      if (computedDocHash !== doc.documentHash) {
        throw new EvolverError(
          'SOURCE_MISMATCH',
          `Document hash mismatch for ${doc.paperId}: expected ${doc.documentHash}, computed ${computedDocHash}`
        );
      }

      // Verify excerpt hash: normalize whitespace runs to single space, strip, sha256
      const normalizedExcerpt = doc.excerpt.replace(/\s+/g, ' ').trim();
      const computedExcerptHash = crypto.createHash('sha256').update(normalizedExcerpt, 'utf8').digest('hex');
      if (computedExcerptHash !== doc.excerptHash) {
        throw new EvolverError(
          'SOURCE_MISMATCH',
          `Excerpt hash mismatch for ${doc.paperId}: expected ${doc.excerptHash}, computed ${computedExcerptHash}`
        );
      }

      sourceRefs.push({
        paperId: doc.paperId,
        sourceUri: doc.sourceUri,
        documentArtifactId: doc.documentArtifactId,
        documentHash: doc.documentHash,
        locator: doc.locator,
        excerptHash: doc.excerptHash,
      });
    }

    return sourceRefs;
  }

  listModules(_taskId?: string, query?: string): ModuleCard[] {
    if (!fs.existsSync(this.modulesManifestPath)) {
      throw new EvolverError('NOT_FOUND', `Modules manifest not found: ${this.modulesManifestPath}`);
    }
    const raw = fs.readFileSync(this.modulesManifestPath, 'utf8');
    const data = JSON.parse(raw);
    let cards: ModuleCard[] = data.modules;

    if (query && query.trim().length > 0) {
      const q = query.trim().toLowerCase();
      cards = cards.filter(
        (c) =>
          c.id.toLowerCase().includes(q) ||
          ((c as any).name && (c as any).name.toLowerCase().includes(q)) ||
          ((c as any).mechanism && (c as any).mechanism.toLowerCase().includes(q))
      );
    }

    return cards;
  }

  async runModuleSmoke(modulePath: string, className: string): Promise<{
    ok: boolean;
    featureDiff: number;
    gradientCheck: { finite: boolean; anyNonZero: boolean };
    parameterUpdated: boolean;
  }> {
    const probeScript = path.resolve('experiments/stitch-cpu-v1/module_smoke.py');
    const outTmp = path.resolve(`artifacts/test-scratch/smoke-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`);
    fs.mkdirSync(path.dirname(outTmp), { recursive: true });
    const outFd = fs.openSync(outTmp, 'w');

    return new Promise((resolve, reject) => {
      try {
        const child = spawn(
          this.pythonPath,
          [probeScript, modulePath, className],
          {
            cwd: path.resolve('.'),
            stdio: ['ignore', outFd, outFd],
            windowsHide: true,
          }
        );

        child.on('close', (code) => {
          fs.closeSync(outFd);
          let out = '';
          if (fs.existsSync(outTmp)) {
            out = fs.readFileSync(outTmp, 'utf8');
            try { fs.unlinkSync(outTmp); } catch {}
          }

          if (code !== 0) {
            reject(new EvolverError('MODULE_NOT_READY', `Module smoke exited with code ${code}: ${out}`));
            return;
          }

          try {
            const parsed = JSON.parse(out);
            if (!parsed.ok) {
              reject(new EvolverError('MODULE_NOT_READY', `Module smoke reported error: ${parsed.error}`));
              return;
            }
            resolve(parsed);
          } catch (err) {
            reject(new EvolverError('MODULE_NOT_READY', `Failed to parse smoke output: ${out}`));
          }
        });

        child.on('error', (err) => {
          try { fs.closeSync(outFd); } catch {}
          reject(new EvolverError('MODULE_NOT_READY', `Failed to spawn module smoke: ${String(err)}`));
        });
      } catch (err) {
        try { fs.closeSync(outFd); } catch {}
        reject(new EvolverError('MODULE_NOT_READY', `Error starting module smoke: ${String(err)}`));
      }
    });
  }

  async validateModules(moduleIds: string[]): Promise<ReadyReport> {
    const catalog = this.listModules();
    const sources = this.importSources();

    const selectedCards: ModuleCard[] = [];
    for (const mid of moduleIds) {
      const card = catalog.find((c) => c.id === mid);
      if (!card) {
        throw new EvolverError('NOT_FOUND', `Module ID "${mid}" not found in registered catalog`);
      }
      selectedCards.push(card);
    }

    // 1. Check distinct mechanism classes (R8)
    const mechanisms = new Set<string>();
    for (const card of selectedCards) {
      const mech = (card as any).mechanism;
      if (!mech) {
        throw new EvolverError('INCOMPATIBLE_BINDING', `Module ${card.id} lacks mechanism classification`);
      }
      if (mechanisms.has(mech)) {
        throw new EvolverError(
          'INCOMPATIBLE_BINDING',
          `Mechanism conflict: duplicate mechanism "${mech}" detected. Modules must originate from distinct mechanism classes.`
        );
      }
      mechanisms.add(mech);
    }

    // 2. Validate each module
    const verifiedDetails: ReadyReport['modules'] = [];

    for (const card of selectedCards) {
      // (a) Source verification
      let sourceVerified = false;
      for (const sref of card.sourceRefs) {
        const doc = sources.find((s) => s.paperId === sref.paperId);
        if (doc && doc.documentHash === sref.documentHash && doc.excerptHash === sref.excerptHash) {
          sourceVerified = true;
          break;
        }
      }
      if (!sourceVerified) {
        throw new EvolverError('SOURCE_MISMATCH', `Module ${card.id} failed source integrity check`);
      }

      // (b) Implementation hash verification
      const implPath = (card as any).implementationPath
        ? path.resolve((card as any).implementationPath)
        : path.resolve(`fixtures/modules/${card.id}.py`);
      if (!fs.existsSync(implPath)) {
        throw new EvolverError('MODULE_NOT_READY', `Module implementation file not found: ${implPath}`);
      }
      const fileBytes = fs.readFileSync(implPath);
      const computedImplHash = crypto.createHash('sha256').update(fileBytes).digest('hex');
      if (computedImplHash !== card.implementationHash) {
        throw new EvolverError(
          'MODULE_NOT_READY',
          `Implementation hash mismatch for ${card.id}: expected ${card.implementationHash}, computed ${computedImplHash}`
        );
      }

      // (c) Contract verification
      if (
        card.inputContract.channels !== 8 ||
        card.outputContract.channels !== 8 ||
        card.inputContract.dtype !== 'float32' ||
        card.outputContract.dtype !== 'float32' ||
        !card.allowedSlots.includes('features.pre_pool')
      ) {
        throw new EvolverError(
          'INCOMPATIBLE_BINDING',
          `Contract check failed for module ${card.id}: must accept [4, 8, 16, 16] float32 at slot features.pre_pool`
        );
      }

      // (d) Functional smoke test
      const className = (card as any).name;
      const smokeResult = await this.runModuleSmoke(implPath, className);

      verifiedDetails.push({
        id: card.id,
        implementationId: card.implementationId,
        implementationHash: card.implementationHash,
        mechanism: (card as any).mechanism,
        sourceVerified: true,
        contractVerified: true,
        functionalSmokeVerified: smokeResult.ok,
        maxFeatureDiff: smokeResult.featureDiff,
      });
    }

    const report: ReadyReport = {
      id: `ready-${Date.now()}-${crypto.randomUUID().slice(0, 6)}`,
      status: 'ready',
      timestamp: new Date().toISOString(),
      modules: verifiedDetails,
    };

    return report;
  }
}
