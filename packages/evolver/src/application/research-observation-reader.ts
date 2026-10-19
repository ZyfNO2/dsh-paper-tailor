/** Published execution evidence reader; an independently recomputed value is required for verified observations. */
import { createHash } from 'node:crypto';
import { ExperimentError, expAssertArtifactRef, type ArtifactRef } from '../contracts/experiments.ts';
import { validateResearchObservation, type ResearchObservation } from '../contracts/research-observation.ts';
import { canonicalJsonV1, parseJsonStrictV1, typedHash } from '../domain/research-canonical.ts';

export class PublishedResearchObservationReader {
  private readonly resolveBytes: (caller: unknown, ref: ArtifactRef) => Buffer;
  private readonly recompute: (rawResults: Buffer[], conditions: Buffer, observation: ResearchObservation) => ResearchObservation['metrics'];
  constructor(options: {
    /** Trusted publication registry must check caller/task/content scope before opening bytes. */
    resolveBytes: (caller: unknown, ref: ArtifactRef) => Buffer;
    /** Independent evaluator from trusted profile; must recompute from original data/output. */
    recompute: (rawResults: Buffer[], conditions: Buffer, observation: ResearchObservation) => ResearchObservation['metrics'];
  }) { this.resolveBytes = options.resolveBytes; this.recompute = options.recompute; }
  readBytes(caller: unknown, ref: ArtifactRef): Buffer {
    const bytes = this.resolveBytes(caller, expAssertArtifactRef(ref, 'publishedRef'));
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new ExperimentError('ARTIFACT_CORRUPT', 'Published execution byte hash differs');
    return bytes;
  }
  readObservation(caller: unknown, ref: ArtifactRef): ResearchObservation {
    const observation = validateResearchObservation(parseJsonStrictV1(this.readBytes(caller, ref).toString('utf8')));
    this.verifyObservation(caller, observation);
    return observation;
  }
  verifyObservation(caller: unknown, observation: ResearchObservation): void {
    validateResearchObservation(observation);
    for (const ref of [observation.configRef, observation.protocolRef, observation.dataRef, observation.executableRef, observation.costRef,
      ...observation.diagnostics, ...observation.attribution.assetRefs]) this.readBytes(caller, ref);
    const raw = observation.rawResultRefs.map((ref) => this.readBytes(caller, ref));
    const conditions = this.readBytes(caller, observation.comparisonConditionsRef);
    if (observation.verification !== 'verified') return;
    const report = parseJsonStrictV1(this.readBytes(caller, observation.verifierRef!).toString('utf8')) as Record<string, unknown>;
    const bindingHash = typedHash('research-verification-observation-v1', { ...observation, verifierRef: null });
    if (report.schemaVersion !== 1 || report.status !== 'pass' || report.bindingHash !== bindingHash || !Array.isArray(report.executionFactsRefs) || !report.executionFactsRefs.length) {
      throw new ExperimentError('INVALID_RESULT', 'Independent verification does not bind this observation');
    }
    const rawIdentities = raw.map((bytes) => parseJsonStrictV1(bytes.toString('utf8')) as Record<string, unknown>);
    if (rawIdentities.length !== report.executionFactsRefs.length) throw new ExperimentError('INVALID_RESULT', 'Verification process denominator differs from raw outputs');
    for (const [index, rawRef] of report.executionFactsRefs.entries()) {
      const facts = parseJsonStrictV1(this.readBytes(caller, expAssertArtifactRef(rawRef, 'executionFactsRef')).toString('utf8')) as Record<string, unknown>;
      if (rawIdentities[index].status !== 'succeeded' || facts.exitCode !== 0 || facts.timedOut !== false || facts.signal !== null || facts.runId !== rawIdentities[index].runId ||
          facts.manifestHash !== rawIdentities[index].manifestHash) throw new ExperimentError('INVALID_RESULT', 'Raw output differs from actual successful process facts');
    }
    const recomputed = this.recompute(raw, conditions, observation);
    if (canonicalJsonV1(recomputed) !== canonicalJsonV1(observation.metrics)) throw new ExperimentError('INVALID_RESULT', 'Independent metric recomputation differs from submitted observation');
  }
}
