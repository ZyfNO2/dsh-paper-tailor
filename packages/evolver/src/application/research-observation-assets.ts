import { ResearchAssetService } from './research-asset-service.ts';
import type { ResearchObservation } from '../contracts/research-observation.ts';
import type { ArtifactRef } from '../contracts/experiments.ts';

/** Concrete idempotent writeback into the asset registry, with no component-effectiveness promotion. */
export function publishObservationAsset(assets: ResearchAssetService, caller: unknown, observation: ResearchObservation,
  bundleRef: ArtifactRef, wikiRef: ArtifactRef, identity: string, policyRef: ArtifactRef, usageScopes: string[]): ArtifactRef[] {
  const assetKey = `experiment:${observation.experimentId}`;
  const committed = assets.getCommandResult(caller, `wb-asset-${identity}`);
  if (committed) {
    if (!committed.resultRefs.every((ref) => assets.getAsset(caller, ref).asset.dependencies.some((dependency) => dependency.id === bundleRef.id && dependency.sha256 === bundleRef.sha256))) throw new Error('Committed writeback asset command differs from its observation bundle');
    return committed.resultRefs;
  }
  const view = assets.listAssets(caller, { kind: 'Experiment' });
  const latest = view.assets.find((entry) => entry.asset.assetKey === assetKey);
  if (latest?.asset.dependencies.some((ref) => ref.id === bundleRef.id && ref.sha256 === bundleRef.sha256)) return [latest.ref];
  const receipt = assets.registerAssetRevision(caller, { schemaVersion: 1, commandId: `wb-asset-${identity}`, taskId: observation.taskId,
    expectedRevision: view.storeRevision, policyRef, budgetRef: null, payload: { previousRef: latest?.ref ?? null,
      asset: { assetKey, kind: 'Experiment', name: `Experiment ${observation.experimentId}`, scope: { taskIds: [observation.taskId], usageScopes },
        sourceRefs: [], wikiRefs: [wikiRef], dependencies: [bundleRef, ...observation.attribution.assetRefs], claims: [], parameterSchema: [],
        applicability: { domain: 'experiment', conditions: [`attempt=${observation.attemptId}`, `verification=${observation.verification}`] }, positionBindings: [],
        capability: { status: 'unknown', runnerId: null, executableRef: null, reason: 'Observation records execution evidence; rerun capability requires a new validated execution plan' } } } });
  return receipt.resultRefs;
}
