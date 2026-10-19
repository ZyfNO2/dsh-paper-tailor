import { ExperimentError, expAssertArray, expAssertArtifactRef, expAssertEnum, expAssertId, expNoExtraKeys, type ArtifactRef } from './experiments.ts';
import { researchInteger } from './research-command.ts';

export interface ResearchObservation {
  schemaVersion: 1; taskId: string; experimentId: string; attemptId: string;
  nature: 'local_observation' | 'partial_observation' | 'failure_diagnostic';
  configRef: ArtifactRef; protocolRef: ArtifactRef; dataRef: ArtifactRef; executableRef: ArtifactRef;
  comparisonConditionsRef: ArtifactRef; rawResultRefs: ArtifactRef[]; verifierRef: ArtifactRef | null; costRef: ArtifactRef;
  verification: 'verified' | 'partial' | 'failed'; diagnostics: ArtifactRef[];
  metrics: Array<{ metricId: string; value: number | null; unit: string; direction: 'minimize' | 'maximize'; split: 'train' | 'validation' | 'test'; seed: number }>;
  attribution: { kind: 'baseline' | 'single_module' | 'combination'; assetRefs: ArtifactRef[] };
}
export function validateResearchObservation(raw: unknown): ResearchObservation {
  const o = expNoExtraKeys(raw, ['schemaVersion', 'taskId', 'experimentId', 'attemptId', 'nature', 'configRef', 'protocolRef', 'dataRef', 'executableRef',
    'comparisonConditionsRef', 'rawResultRefs', 'verifierRef', 'costRef', 'verification', 'diagnostics', 'metrics', 'attribution'], 'observation');
  if (o.schemaVersion !== 1) throw new ExperimentError('SCHEMA_VIOLATION', 'Unsupported observation version');
  const ref = (key: string) => expAssertArtifactRef(o[key], key);
  const refs = (value: unknown, field: string) => expAssertArray(value, field).map((entry) => expAssertArtifactRef(entry, field));
  const verification = expAssertEnum(o.verification, ['verified', 'partial', 'failed'] as const, 'verification');
  const nature = expAssertEnum(o.nature, ['local_observation', 'partial_observation', 'failure_diagnostic'] as const, 'nature');
  if (nature !== ({ verified: 'local_observation', partial: 'partial_observation', failed: 'failure_diagnostic' } as const)[verification]) {
    throw new ExperimentError('INVALID_RESULT', 'Observation nature differs from verification state');
  }
  const metrics = expAssertArray(o.metrics, 'metrics').map((rawMetric) => {
    const metric = expNoExtraKeys(rawMetric, ['metricId', 'value', 'unit', 'direction', 'split', 'seed'], 'metric');
    if (metric.value !== null && (typeof metric.value !== 'number' || !Number.isFinite(metric.value))) throw new ExperimentError('INVALID_RESULT', 'Metric must be finite or null');
    return { metricId: expAssertId(metric.metricId, 'metricId'), value: metric.value as number | null, unit: expAssertId(metric.unit, 'unit'),
      direction: expAssertEnum(metric.direction, ['minimize', 'maximize'] as const, 'direction'),
      split: expAssertEnum(metric.split, ['train', 'validation', 'test'] as const, 'split'), seed: researchInteger(metric.seed, 'seed') };
  });
  const keys = metrics.map((metric) => `${metric.metricId}\0${metric.split}\0${metric.seed}`);
  if (new Set(keys).size !== keys.length || verification === 'verified' && (!metrics.length || metrics.some((metric) => metric.value === null))) throw new ExperimentError('INVALID_RESULT', 'Verified metrics require complete distinct observations');
  const verifierRef = o.verifierRef === null ? null : ref('verifierRef'), rawResultRefs = refs(o.rawResultRefs, 'rawResultRefs'), diagnostics = refs(o.diagnostics, 'diagnostics');
  if (verification === 'verified' && (!verifierRef || !rawResultRefs.length) || verification === 'failed' && (metrics.length || !diagnostics.length)) {
    throw new ExperimentError('INVALID_RESULT', 'Success requires verification evidence; failure must only carry diagnostics');
  }
  const attribution = expNoExtraKeys(o.attribution, ['kind', 'assetRefs'], 'attribution');
  const kind = expAssertEnum(attribution.kind, ['baseline', 'single_module', 'combination'] as const, 'attribution.kind');
  const assetRefs = refs(attribution.assetRefs, 'assetRefs');
  if (kind === 'baseline' && assetRefs.length || kind === 'single_module' && assetRefs.length !== 1 || kind === 'combination' && assetRefs.length < 2) throw new ExperimentError('INVALID_RESULT', 'Attribution cardinality differs from component set');
  return { schemaVersion: 1, taskId: expAssertId(o.taskId, 'taskId'), experimentId: expAssertId(o.experimentId, 'experimentId'), attemptId: expAssertId(o.attemptId, 'attemptId'),
    nature, configRef: ref('configRef'), protocolRef: ref('protocolRef'), dataRef: ref('dataRef'), executableRef: ref('executableRef'), comparisonConditionsRef: ref('comparisonConditionsRef'),
    rawResultRefs, verifierRef, costRef: ref('costRef'), verification, diagnostics, metrics, attribution: { kind, assetRefs } };
}
