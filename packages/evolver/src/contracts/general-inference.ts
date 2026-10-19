import { object, str, list, one } from './general-data.ts';
export const INFERENCE_METHODS = ['one_sample_t', 'paired_t', 'welch_t'] as const;
export interface InferenceInput {
  method: typeof INFERENCE_METHODS[number]; confidence: 0.9 | 0.95 | 0.99; unit: string; referenceMean: number;
  sampleA: { sampleId: string; value: number | null }[]; sampleB: InferenceInput['sampleA'] | null;
  missingPolicy: 'complete_cases';
  assumptions: { independenceConfirmed: true; samplingRationale: string; normalityRationale: string };
}
export interface InferenceResult {
  estimand: 'mean_minus_reference' | 'paired_mean_difference_A_minus_B' | 'independent_mean_difference_A_minus_B';
  method: InferenceInput['method']; confidence: InferenceInput['confidence']; unit: string;
  nA: number; nB: number | null; excludedA: string[]; excludedB: string[];
  estimate: number; standardError: number; degreesOfFreedom: number; statistic: number; pValueTwoSided: number;
  confidenceInterval: { lower: number; upper: number };
  standardizedEffect: { name: 'cohen_d' | 'cohen_dz' | 'cohen_d_pooled'; value: number };
  assumptions: InferenceInput['assumptions']; warnings: string[];
  tool: { name: 'dsh-student-t'; version: '1.0.0'; runtime: string };
}
const finite = (v: unknown, name: string): number => { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Invalid finite ${name}`); return v; };
export function validateInferenceInput(v: unknown): InferenceInput {
  const p = object(v, ['method', 'confidence', 'unit', 'referenceMean', 'sampleA', 'sampleB', 'missingPolicy', 'assumptions'], 'inference input');
  const samples = (v: unknown) => { const rows = list(v, 'inference sample', 50000).map(v => { const r = object(v, ['sampleId', 'value'], 'inference record'); return { sampleId: str(r.sampleId, 'sample identity', 200, true), value: r.value === null ? null : finite(r.value, 'measurement') }; }); if (new Set(rows.map(r => r.sampleId)).size !== rows.length) throw new Error('Duplicate sample identity; repeated measurements require explicit aggregation first'); return rows; };
  const method = one(p.method, INFERENCE_METHODS, 'inference method'), sampleA = samples(p.sampleA), sampleB = p.sampleB === null ? null : samples(p.sampleB);
  if (method === 'one_sample_t' ? sampleB !== null : sampleB === null) throw new Error('Inference sample structure does not match method');
  const referenceMean = finite(p.referenceMean, 'referenceMean'); if (method !== 'one_sample_t' && referenceMean !== 0) throw new Error('Two-sample/paired methods currently test zero difference only');
  if (![0.9, 0.95, 0.99].includes(p.confidence as number)) throw new Error('Unsupported confidence level');
  const a = object(p.assumptions, ['independenceConfirmed', 'samplingRationale', 'normalityRationale'], 'inference assumptions');
  if (a.independenceConfirmed !== true) throw new Error('Independent observations/pairs must be explicitly confirmed');
  return { method, confidence: p.confidence as InferenceInput['confidence'], unit: str(p.unit, 'inference unit', 100, true), referenceMean, sampleA, sampleB, missingPolicy: one(p.missingPolicy, ['complete_cases'] as const, 'missing policy'), assumptions: { independenceConfirmed: true, samplingRationale: str(a.samplingRationale, 'sampling rationale', 4000, true), normalityRationale: str(a.normalityRationale, 'normality rationale', 4000, true) } };
}
