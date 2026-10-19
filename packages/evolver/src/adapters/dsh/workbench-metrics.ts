/**
 * Metric comparison arithmetic for the workbench.
 *
 * Spec: docs/mvp/phases/PHASE3-SPEC.md section 8; redesign plan §3.2 and WB-05.
 * Every rule here exists because getting it wrong silently inverts a result:
 *
 *  - `improvement` is always POSITIVE-WHEN-BETTER. For a `minimize` metric it is
 *    `reference - candidate`; for `maximize` it is `candidate - reference`. A
 *    growing loss therefore yields a negative improvement and must never render
 *    as a green gain. (R12/§3.2 of the plan.)
 *  - pairing is by (variant, seed) under ONE protocol. A delta is only computed
 *    when both sides exist for the same seed; an unpaired seed is counted as
 *    missing coverage, never averaged in.
 *  - a metric is only "measured" when the value is finite AND its published row
 *    was verified. `NaN`, a missing verifier, and an incomplete seed set are
 *    three distinct states the UI must not collapse.
 *  - percentage-point differences are kept distinct from relative percentages,
 *    because "accuracy 50% → 56%" is +6 points and +12% relative, and quoting
 *    the wrong one changes the claim.
 *
 * This module computes NO research conclusion. It returns numbers plus the
 * coverage that qualifies them; the assessment wording comes from the frozen
 * policy in the caller.
 */

export type MetricDirection = 'minimize' | 'maximize';

export interface MetricSpecLike {
  id: string;
  direction: MetricDirection;
  unit: string;
  split: string;
  aggregation: string;
}

export interface MeasurementRow {
  variantId: string;
  seed: number;
  metricId: string;
  value: number | null;
  unit: string;
  split: string;
  sampleCount: number;
  /** Whether the published artifact says this row was verified. */
  verified: boolean;
  /** Ref id of the artifact this row was read from, for the detail drawer. */
  artifactRefId: string | null;
}

export interface PairedDelta {
  seed: number;
  metricId: string;
  referenceValue: number;
  candidateValue: number;
  /** candidate - reference, in raw metric units (sign follows the raw metric). */
  rawDelta: number;
  /** Positive when BETTER. See module header. */
  improvement: number;
  /** For a 0..1 fraction metric: the difference in percentage points. */
  percentagePoints: number | null;
}

export interface MetricSummary {
  metricId: string;
  direction: MetricDirection;
  unit: string;
  split: string;
  /** Mean over the PAIRED seeds only. */
  measuredValue: number | null;
  referenceValue: number | null;
  /** Mean improvement over the paired seeds, positive-when-better. */
  improvement: number | null;
  pairedSeedCount: number;
  expectedSeedCount: number;
  /** Seeds present on one side only, or with an unusable value. */
  unpairedSeeds: number[];
  /** True only when every expected seed paired and every row was verified. */
  complete: boolean;
  /** Why the summary is not a verified overall gain, when it is not one. */
  limitation: string | null;
}

export function improvementFor(
  direction: MetricDirection,
  candidate: number,
  reference: number,
): number {
  return direction === 'minimize' ? reference - candidate : candidate - reference;
}

/**
 * Pair a candidate arm against a reference arm under one metric spec.
 *
 * `expectedSeeds` comes from the frozen protocol, not from the data: deriving it
 * from what happened to be measured would let a dropped trial silently become
 * "1/1, complete".
 */
export function summariseMetric(
  spec: MetricSpecLike,
  candidateRows: MeasurementRow[],
  referenceRows: MeasurementRow[],
  expectedSeeds: number[],
): { summary: MetricSummary; deltas: PairedDelta[] } {
  const metricId = spec.id;
  const expectedSeedCount = expectedSeeds.length;
  const deltas: PairedDelta[] = [];
  const unpairedSeeds: number[] = [];

  const usable = (r: MeasurementRow): boolean =>
    typeof r.value === 'number' && Number.isFinite(r.value);

  for (const seed of expectedSeeds) {
    const c = candidateRows.find((r) => r.seed === seed && r.metricId === metricId);
    const b = referenceRows.find((r) => r.seed === seed && r.metricId === metricId);
    if (!c || !b || !usable(c) || !usable(b)) {
      unpairedSeeds.push(seed);
      continue;
    }
    const improvement = improvementFor(spec.direction, c.value as number, b.value as number);
    deltas.push({
      seed,
      metricId,
      referenceValue: b.value as number,
      candidateValue: c.value as number,
      rawDelta: (c.value as number) - (b.value as number),
      improvement,
      percentagePoints: isFractionUnit(spec.unit)
        ? ((c.value as number) - (b.value as number)) * 100
        : null,
    });
  }

  const meanCandidate = deltas.length > 0
    ? deltas.reduce((s, d) => s + d.candidateValue, 0) / deltas.length
    : null;
  const meanReference = deltas.length > 0
    ? deltas.reduce((s, d) => s + d.referenceValue, 0) / deltas.length
    : null;
  const meanImprovement = deltas.length > 0
    ? deltas.reduce((s, d) => s + d.improvement, 0) / deltas.length
    : null;

  const allVerified = [...candidateRows, ...referenceRows]
    .filter((r) => r.metricId === metricId)
    .every((r) => r.verified);

  const complete = deltas.length === expectedSeedCount && expectedSeedCount > 0 && allVerified;

  let limitation: string | null = null;
  if (expectedSeedCount === 0) {
    limitation = 'protocol declares no paired seed for this metric';
  } else if (deltas.length === 0) {
    limitation = `no seed paired against the reference: ${unpairedSeeds.join(', ')}`;
  } else if (deltas.length < expectedSeedCount) {
    limitation = `${deltas.length}/${expectedSeedCount} paired seeds; unpaired: ${unpairedSeeds.join(', ')}`;
  } else if (!allVerified) {
    limitation = 'measured but not verified by the published evaluator';
  }

  return {
    summary: {
      metricId,
      direction: spec.direction,
      unit: spec.unit,
      split: spec.split,
      measuredValue: meanCandidate,
      referenceValue: meanReference,
      improvement: meanImprovement,
      pairedSeedCount: deltas.length,
      expectedSeedCount,
      unpairedSeeds,
      complete,
      limitation,
    },
    deltas,
  };
}

/**
 * A unit is shown as a percentage when it is a 0..1 fraction. `fraction` is what
 * the frozen protocols declare; `accuracy` in a report body is the same thing
 * spelled differently. Anything else stays a plain number, because guessing a
 * scale from a unit string is how "0.5" becomes "0.5%".
 */
export function isFractionUnit(unit: string): boolean {
  const u = unit.toLowerCase();
  return u === 'fraction' || u === 'accuracy';
}

/** Human-readable rendering. Raw precision is preserved in the detail drawer. */
export function formatMetricValue(value: number | null, unit: string): string {
  if (value === null || !Number.isFinite(value)) return '—';
  if (isFractionUnit(unit)) return `${(value * 100).toFixed(1)}%`;
  return String(value);
}

/**
 * Difference formatting that keeps direction explicit. A minimize metric that
 * grew is shown as `+0.0605（更差）`, never as an unsigned "improvement".
 */
export function formatImprovement(
  improvement: number | null,
  spec: { direction: MetricDirection; unit: string },
): string {
  if (improvement === null || !Number.isFinite(improvement)) return '—';
  const sign = improvement > 0 ? '+' : improvement < 0 ? '−' : '±';
  const magnitude = Math.abs(improvement);
  const value = isFractionUnit(spec.unit)
    ? `${(magnitude * 100).toFixed(1)} 个百分点`
    : magnitude.toFixed(4);
  const verdict = improvement > 0 ? '更好' : improvement < 0 ? '更差' : '持平';
  return `${sign}${value}（${verdict}）`;
}