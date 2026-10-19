import { validateResearchObservation, type ResearchObservation } from '../contracts/research-observation.ts';
import { canonicalJsonV1 } from './research-canonical.ts';

/** Exact comparison group and paired denominator are required; no component attribution is invented. */
export function compareResearchObservations(baselineRaw: ResearchObservation, treatmentRaw: ResearchObservation, metricId: string) {
  const baseline = validateResearchObservation(baselineRaw), treatment = validateResearchObservation(treatmentRaw);
  const unavailable = (reason: string) => ({ comparable: false, reason, absoluteImprovement: null, percentageImprovement: null, attribution: treatment.attribution.kind });
  if (baseline.taskId !== treatment.taskId || baseline.verification !== 'verified' || treatment.verification !== 'verified') return unavailable('unverified_or_cross_task');
  if (canonicalJsonV1(baseline.comparisonConditionsRef) !== canonicalJsonV1(treatment.comparisonConditionsRef)) return unavailable('comparison_conditions_differ');
  const b = baseline.metrics.filter((metric) => metric.metricId === metricId), t = treatment.metrics.filter((metric) => metric.metricId === metricId);
  if (!b.length || b.length !== t.length || b.some((metric) => metric.split === 'test')) return unavailable('missing_or_forbidden_denominator');
  if (b.some((metric) => metric.unit !== b[0].unit || metric.direction !== b[0].direction || metric.split !== b[0].split)) return unavailable('inconsistent_metric_group');
  const pairs = b.map((metric) => ({ baseline: metric, treatment: t.find((other) => other.seed === metric.seed && other.split === metric.split) }));
  if (pairs.some(({ baseline: a, treatment: c }) => !c || c.unit !== a.unit || c.direction !== a.direction || a.value === null || c.value === null)) return unavailable('incomparable_metric_or_pair');
  const bm = b.reduce((sum, metric) => sum + metric.value!, 0) / b.length;
  const tm = pairs.reduce((sum, pair) => sum + pair.treatment!.value!, 0) / pairs.length;
  const improvement = b[0].direction === 'maximize' ? tm - bm : bm - tm;
  if (!Number.isFinite(bm) || !Number.isFinite(tm) || !Number.isFinite(improvement)) return unavailable('nonfinite_aggregate');
  const percentage = bm === 0 ? null : improvement / Math.abs(bm) * 100;
  return { comparable: true, reason: 'paired_verified_conditions', absoluteImprovement: improvement,
    percentageImprovement: percentage !== null && Number.isFinite(percentage) ? percentage : null, attribution: treatment.attribution.kind };
}
