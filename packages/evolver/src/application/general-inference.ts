import { validateInferenceInput, type InferenceResult } from '../contracts/general-inference.ts';
import { describe, CalculationBlocked } from './general-descriptive.ts';
// Lanczos log-gamma, followed by the incomplete-beta continued fraction (DLMF §8.17).
const coefficients = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
  z--; let sum = coefficients[0]; for (let i = 1; i < coefficients.length; i++) sum += coefficients[i] / (z + i);
  const t = z + 7.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}
function betaFraction(a: number, b: number, x: number): number {
  const tiny = 1e-300, nonzero = (v: number) => Math.abs(v) < tiny ? (v < 0 ? -tiny : tiny) : v;
  let c = 1, d = 1 / nonzero(1 - (a + b) * x / (a + 1)), h = d;
  for (let m = 1; m <= 10000; m++) {
    const even = 2 * m;
    let term = m * (b - m) * x / ((a - 1 + even) * (a + even));
    d = 1 / nonzero(1 + term * d); c = nonzero(1 + term / c); h *= d * c;
    term = -(a + m) * (a + b + m) * x / ((a + even) * (a + 1 + even));
    d = 1 / nonzero(1 + term * d); c = nonzero(1 + term / c); const delta = d * c; h *= delta;
    if (Math.abs(delta - 1) < 3e-14) return h;
  }
  throw new Error('Incomplete beta did not converge; no approximate fallback');
}
function beta(a: number, b: number, x: number): number {
  if (x === 0 || x === 1) return x;
  const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log1p(-x));
  const result = x < (a + 1) / (a + b + 2) ? factor * betaFraction(a, b, x) / a : 1 - factor * betaFraction(b, a, 1 - x) / b;
  if (!Number.isFinite(result) || result < -1e-12 || result > 1 + 1e-12) throw new Error('Incomplete beta numerical range failure');
  return Math.max(0, Math.min(1, result));
}
export function studentTwoSidedP(t: number, df: number): number {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df < 1 || df > 100000) throw new Error('Unsupported t statistic/degrees of freedom');
  const x = df / (df + t * t);
  return beta(df / 2, 0.5, x);
}
export function studentCriticalValue(confidence: number, df: number): number {
  if (![0.9, 0.95, 0.99].includes(confidence)) throw new Error('Unsupported confidence');
  const target = 1 - confidence; let lower = 0, upper = 1;
  while (studentTwoSidedP(upper, df) > target) { upper *= 2; if (upper > 1e8) throw new Error('Student quantile bracket failed'); }
  for (let i = 0; i < 80; i++) { const middle = (lower + upper) / 2; if (studentTwoSidedP(middle, df) > target) lower = middle; else upper = middle; }
  return (lower + upper) / 2;
}
/** Pure numeric core. Services must still bind actual source versions, scope, CAS and authorization. */
export function inferStudentT(value: unknown, runtime = 'javascript'): InferenceResult {
  const p = validateInferenceInput(value), excludedA: string[] = [], excludedB: string[] = [];
  let a: number[] = [], b: number[] = [];
  if (p.method === 'paired_t') {
    const right = new Map(p.sampleB!.map(r => [r.sampleId, r.value]));
    if (right.size !== p.sampleA.length || p.sampleA.some(r => !right.has(r.sampleId))) throw new CalculationBlocked('配对身份必须完全对齐；缺测请明确记录 null，不按行位置或静默交集配对。');
    for (const r of p.sampleA) { const v = right.get(r.sampleId)!; if (r.value === null || v === null) { excludedA.push(r.sampleId); excludedB.push(r.sampleId); } else a.push(r.value - v); }
  } else {
    if (p.sampleB) { const ids = new Set(p.sampleA.map(r => r.sampleId)); if (p.sampleB.some(r => ids.has(r.sampleId))) throw new CalculationBlocked('独立两组中存在相同样本身份；请明确使用配对方法或重审采样。'); }
    for (const r of p.sampleA) if (r.value === null) excludedA.push(r.sampleId); else a.push(r.value);
    for (const r of p.sampleB ?? []) if (r.value === null) excludedB.push(r.sampleId); else b.push(r.value);
  }
  if (a.length < 2 || p.method === 'welch_t' && b.length < 2) throw new CalculationBlocked('每个独立样本集合或完整配对至少需要两个有效样本。');
  const sa = describe(a), sb = p.method === 'welch_t' ? describe(b) : null;
  let estimate = sa.mean! - (p.method === 'one_sample_t' ? p.referenceMean : sb?.mean ?? 0), df = a.length - 1, se = sa.sampleSD! / Math.sqrt(a.length);
  let effect = sa.sampleSD! ? estimate / sa.sampleSD! : NaN;
  if (sb) {
    const va = sa.sampleSD! ** 2 / a.length, vb = sb.sampleSD! ** 2 / b.length;
    se = Math.sqrt(va + vb); df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
    const pooled = Math.sqrt(((a.length - 1) * sa.sampleSD! ** 2 + (b.length - 1) * sb.sampleSD! ** 2) / (a.length + b.length - 2)); effect = estimate / pooled;
  }
  if (!(se > 0) || ![estimate, se, df, effect].every(Number.isFinite)) throw new CalculationBlocked('零标准误或数值溢出：不生成虚构 p 值、置信区间或效应量。');
  const statistic = estimate / se, critical = studentCriticalValue(p.confidence, df), lower = estimate - critical * se, upper = estimate + critical * se;
  if (![statistic, lower, upper].every(Number.isFinite)) throw new CalculationBlocked('推断数值不可表示；缩小数值尺度并明确单位变换后重算。');
  return { estimand: p.method === 'one_sample_t' ? 'mean_minus_reference' : p.method === 'paired_t' ? 'paired_mean_difference_A_minus_B' : 'independent_mean_difference_A_minus_B', method: p.method, confidence: p.confidence, unit: p.unit, nA: a.length, nB: p.method === 'paired_t' ? a.length : sb ? b.length : null, excludedA, excludedB, estimate, standardError: se, degreesOfFreedom: df, statistic, pValueTwoSided: studentTwoSidedP(statistic, df), confidenceInterval: { lower, upper }, standardizedEffect: { name: p.method === 'paired_t' ? 'cohen_dz' : sb ? 'cohen_d_pooled' : 'cohen_d', value: effect }, assumptions: p.assumptions, warnings: ['仅双侧均值/均值差推断；CI与p值依赖明确的独立性、采样和分布假设，填写理由不等于假设已被验证。', '不作因果判断，不将低p值解释为假设成立；当前只含单次预先指定比较，未作多重检验校正。', '完整配对按身份匹配，null按complete_cases明确排除；缺测机制及代表性仍需科研审查。', '标准化效应量按列明定义报告，不自动标记大小或科学重要性。'], tool: { name: 'dsh-student-t', version: '1.0.0', runtime } };
}
