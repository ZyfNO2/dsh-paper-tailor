/**
 * P7 Rank: scoring-policy-v1. Every dimension value is derived deterministically from
 * schema-validated P6 fields; a model never supplies a score.
 * Spec: docs/mvp/phases/P7-SPEC.md sections 2, 3, 6, 7.
 */

import {
  PROTOCOL_ID,
  SCORING_DIMENSIONS,
  SCORING_POLICY_V1,
  ResearchError,
  type DimensionResult,
  type EvidenceField,
  type ReasonCode,
  type RankingGroup,
  type RankingItem,
  type RankingResult,
  type Requirement,
  type ResearchCandidate,
  type ScoringDimension,
  type Uncertainty,
  validateCandidate,
} from '../contracts/research.ts';
import { computeCandidateSetHash } from './research-synthesis.ts';

export const RUBRIC_VERSION = SCORING_POLICY_V1.rubricVersion;
export const POLICY_ID = SCORING_POLICY_V1.policyId;

const LEVELS = { null: null, zero: 0, half: 1, one: 2 } as const;

export interface RankingContext {
  /** Span ids that resolve against the frozen inputs and published cards. */
  resolvableEvidenceIds: Set<string>;
  /** Module cards by id, used for axis lookups. */
  cardsById: Map<string, { interventionAxis?: EvidenceField<unknown>; name?: EvidenceField<unknown>; mechanism?: EvidenceField<unknown> }>;
}

interface DimOutcome {
  level: number | null;
  ruleId: string;
  inputPaths: string[];
  evidenceRefs: string[];
  rationaleTemplateId: string;
}

function dim(outcome: DimOutcome): DimensionResult {
  return {
    value: outcome.level === null ? null : outcome.level * 0.5,
    level: outcome.level,
    ruleId: outcome.ruleId,
    inputPaths: outcome.inputPaths,
    evidenceRefs: outcome.evidenceRefs,
    rationaleTemplateId: outcome.rationaleTemplateId,
  };
}

function valued(field: EvidenceField<unknown> | undefined): boolean {
  return !!field && field.value !== null && field.status !== 'unknown';
}

function allRefsOf(candidate: ResearchCandidate): string[] {
  const refs = new Set<string>(candidate.evidenceRefs);
  const collect = (field: EvidenceField<unknown> | undefined): void => {
    field?.evidenceRefs.forEach((r) => refs.add(r));
  };
  collect(candidate.mechanismHypothesis);
  candidate.expectedEffects.forEach(collect);
  candidate.risks.forEach(collect);
  candidate.requiredValidation.forEach(collect);
  candidate.conceptualBindings.forEach((b) => {
    collect(b.targetConcept);
    b.requiredInputs.forEach(collect);
  });
  candidate.compatibility.requirements.forEach((r) => {
    collect(r.description);
    r.basisRefs.forEach((x) => refs.add(x));
  });
  candidate.compatibility.evidenceRefs.forEach((r) => refs.add(r));
  return Array.from(refs).sort();
}

// ----------------- evidence_strength -----------------

function evidenceStrength(candidate: ResearchCandidate, ctx: RankingContext): DimOutcome {
  const path = 'candidates.' + candidate.id + '.';
  const cardIdentityOk = candidate.moduleCardRefs.every((ref) => {
    const card = ctx.cardsById.get(ref.id);
    return !!card && valued(card.name);
  });
  const cardMechanismOk = candidate.moduleCardRefs.every((ref) => {
    const card = ctx.cardsById.get(ref.id);
    return !!card && (valued(card.mechanism) || valued(card.interventionAxis));
  });
  const hypothesisTraceable =
    candidate.mechanismHypothesis.value !== null && candidate.mechanismHypothesis.evidenceRefs.length > 0;

  if (!cardIdentityOk || !cardMechanismOk || !hypothesisTraceable) {
    return {
      level: null,
      ruleId: 'ES-NULL',
      inputPaths: [`${path}mechanismHypothesis`, `${path}moduleCardRefs`],
      evidenceRefs: candidate.mechanismHypothesis.evidenceRefs,
      rationaleTemplateId: 'ES-NULL',
    };
  }

  const conflicting = candidate.compatibility.requirements.filter((r) => r.resolution === 'conflicting');
  if (conflicting.length > 0) {
    return {
      level: LEVELS.zero,
      ruleId: 'ES-0',
      inputPaths: conflicting.map((r) => `${path}compatibility.requirements.${r.id}.resolution`),
      evidenceRefs: conflicting.flatMap((r) => r.basisRefs),
      rationaleTemplateId: 'ES-0',
    };
  }

  const identityStatuses: string[] = [];
  for (const ref of candidate.moduleCardRefs) {
    const card = ctx.cardsById.get(ref.id);
    if (!card) continue;
    if (card.name) identityStatuses.push(card.name.status);
    if (card.mechanism && card.mechanism.value !== null) identityStatuses.push(card.mechanism.status);
  }
  const bindingInferred = candidate.conceptualBindings.some((b) => b.targetConcept.status !== 'source_reported');
  const everythingSourceReported = identityStatuses.every((s) => s === 'source_reported') && !bindingInferred;
  const compositionSourceReported = candidate.compatibility.reasonCodes.includes('SOURCE_SUPPORTED_COMPOSITION');

  if (everythingSourceReported && compositionSourceReported) {
    return {
      level: LEVELS.one,
      ruleId: 'ES-1',
      inputPaths: [`${path}compatibility.reasonCodes`, `${path}conceptualBindings`],
      evidenceRefs: candidate.compatibility.evidenceRefs,
      rationaleTemplateId: 'ES-1',
    };
  }

  return {
    level: LEVELS.half,
    ruleId: 'ES-HALF',
    inputPaths: [`${path}mechanismHypothesis.status`, `${path}conceptualBindings.targetConcept.status`],
    evidenceRefs: allRefsOf(candidate),
    rationaleTemplateId: 'ES-HALF',
  };
}

// ----------------- mechanism_compatibility -----------------

function mechanismCompatibility(candidate: ResearchCandidate, ctx: RankingContext): DimOutcome {
  const path = `candidates.${candidate.id}.compatibility`;
  const assessment = candidate.compatibility;
  const unknownRequirements = assessment.requirements.filter((r) => r.resolution === 'unknown');

  if (assessment.decision === 'insufficient_evidence' || unknownRequirements.length > 0) {
    return {
      level: null,
      ruleId: 'MC-NULL',
      inputPaths: [`${path}.decision`, ...unknownRequirements.map((r) => `${path}.requirements.${r.id}.resolution`)],
      evidenceRefs: assessment.evidenceRefs,
      rationaleTemplateId: 'MC-NULL',
    };
  }

  if (assessment.decision === 'reject_for_mvp' || assessment.reasonCodes.some(isRejectingCode)) {
    return {
      level: LEVELS.zero,
      ruleId: 'MC-0',
      inputPaths: [`${path}.decision`, `${path}.reasonCodes`],
      evidenceRefs: assessment.evidenceRefs,
      rationaleTemplateId: 'MC-0',
    };
  }

  if (assessment.decision === 'conditionally_compatible' || assessment.unresolvedConditions.length > 0) {
    return {
      level: LEVELS.half,
      ruleId: 'MC-HALF',
      inputPaths: [`${path}.unresolvedConditions`],
      evidenceRefs: assessment.evidenceRefs,
      rationaleTemplateId: 'MC-HALF',
    };
  }

  const unresolved = assessment.requirements.filter((r) => r.resolution !== 'satisfied');
  if (assessment.decision === 'compatible' && assessment.unresolvedConditions.length === 0 && unresolved.length === 0) {
    return {
      level: LEVELS.one,
      ruleId: 'MC-1',
      inputPaths: [`${path}.decision`, `${path}.requirements.resolution`],
      evidenceRefs: assessment.evidenceRefs,
      rationaleTemplateId: 'MC-1',
    };
  }

  return {
    level: null,
    ruleId: 'MC-NULL',
    inputPaths: [`${path}.requirements.resolution`],
    evidenceRefs: assessment.evidenceRefs,
    rationaleTemplateId: 'MC-NULL',
  };
}

function isRejectingCode(code: ReasonCode): boolean {
  return ['TASK_MISMATCH', 'REQUIRED_OPERATOR_ABSENT', 'REQUIRED_TARGET_ABSENT', 'SCOPE_EXCLUDED', 'MECHANISM_CONFLICT'].includes(code);
}

// ----------------- mechanism_complementarity -----------------

function complementarity(candidate: ResearchCandidate, ctx: RankingContext): DimOutcome {
  const path = `candidates.${candidate.id}`;
  const axes: string[] = [];
  const targets: string[] = [];
  for (const binding of candidate.conceptualBindings) {
    const card = ctx.cardsById.get(binding.moduleRef.id);
    const cardAxis = card?.interventionAxis?.value ?? null;
    if (cardAxis === null || binding.targetConcept.value === null) {
      return {
        level: null,
        ruleId: 'MP-NULL',
        inputPaths: [`${path}.conceptualBindings.axis`, `${path}.conceptualBindings.targetConcept`],
        evidenceRefs: binding.targetConcept.evidenceRefs,
        rationaleTemplateId: 'MP-NULL',
      };
    }
    axes.push(String(cardAxis));
    targets.push(normalizeTarget(String(binding.targetConcept.value)));
  }

  const distinctAxes = new Set(axes);
  const conflicting = candidate.compatibility.reasonCodes.includes('MECHANISM_CONFLICT');
  const duplicatedFunction = candidate.conceptualBindings.length > 1 && distinctAxes.size === 1 && new Set(targets).size === 1;

  if (conflicting || duplicatedFunction) {
    return {
      level: LEVELS.zero,
      ruleId: 'MP-0',
      inputPaths: conflicting ? [`${path}.compatibility.reasonCodes`] : [`${path}.conceptualBindings.targetConcept`],
      evidenceRefs: candidate.compatibility.evidenceRefs,
      rationaleTemplateId: conflicting ? 'MP-0-CONFLICT' : 'MP-0-DUPLICATE',
    };
  }

  const allTargetsSourceReported = candidate.conceptualBindings.every((b) => b.targetConcept.status === 'source_reported');
  if (distinctAxes.size >= 2 && allTargetsSourceReported) {
    return {
      level: LEVELS.one,
      ruleId: 'MP-1',
      inputPaths: [`${path}.conceptualBindings.axis`, `${path}.conceptualBindings.targetConcept.status`],
      evidenceRefs: candidate.conceptualBindings.flatMap((b) => b.targetConcept.evidenceRefs),
      rationaleTemplateId: 'MP-1',
    };
  }

  return {
    level: LEVELS.half,
    ruleId: 'MP-HALF',
    inputPaths: [`${path}.conceptualBindings`, `${path}.compatibility.reasonCodes`],
    evidenceRefs: candidate.compatibility.evidenceRefs,
    rationaleTemplateId: 'MP-HALF',
  };
}

function normalizeTarget(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ----------------- implementation_simplicity -----------------

const COMPLEX_CATEGORIES = ['new_data_annotation', 'architecture_change'];
const MEDIUM_CATEGORIES = ['loss_target_transform', 'operator_replacement', 'environment_constraint'];
const SIMPLE_CATEGORIES = ['existing_feature_hook', 'parameter_selection'];

function simplicity(candidate: ResearchCandidate): DimOutcome {
  const path = `candidates.${candidate.id}.compatibility.requirements`;
  const requirements: Requirement[] = candidate.compatibility.requirements;

  if (requirements.length === 0 || requirements.some((r) => r.category === 'other' || r.resolution === 'unknown' || r.description.value === null)) {
    return {
      level: null,
      ruleId: 'IS-NULL',
      inputPaths: [`${path}.category`, `${path}.resolution`, `${path}.description`],
      evidenceRefs: requirements.flatMap((r) => r.basisRefs),
      rationaleTemplateId: 'IS-NULL',
    };
  }

  if (requirements.some((r) => COMPLEX_CATEGORIES.includes(r.category))) {
    return {
      level: LEVELS.zero,
      ruleId: 'IS-0',
      inputPaths: requirements.filter((r) => COMPLEX_CATEGORIES.includes(r.category)).map((r) => `${path}.${r.id}.category`),
      evidenceRefs: requirements.flatMap((r) => r.basisRefs),
      rationaleTemplateId: 'IS-0',
    };
  }

  if (requirements.some((r) => MEDIUM_CATEGORIES.includes(r.category))) {
    return {
      level: LEVELS.half,
      ruleId: 'IS-HALF',
      inputPaths: requirements.filter((r) => MEDIUM_CATEGORIES.includes(r.category)).map((r) => `${path}.${r.id}.category`),
      evidenceRefs: requirements.flatMap((r) => r.basisRefs),
      rationaleTemplateId: 'IS-HALF',
    };
  }

  const onlySimple = requirements.every((r) => SIMPLE_CATEGORIES.includes(r.category));
  const premisesExplainable = requirements.every((r) => r.resolution !== 'conflicting' && r.description.value !== null);
  if (onlySimple && premisesExplainable) {
    return {
      level: LEVELS.one,
      ruleId: 'IS-1',
      inputPaths: [`${path}.category`, `${path}.resolution`],
      evidenceRefs: requirements.flatMap((r) => r.basisRefs),
      rationaleTemplateId: 'IS-1',
    };
  }

  return {
    level: null,
    ruleId: 'IS-NULL',
    inputPaths: [`${path}.resolution`],
    evidenceRefs: requirements.flatMap((r) => r.basisRefs),
    rationaleTemplateId: 'IS-NULL',
  };
}

// ----------------- Integrity (qualification before scoring) -----------------

export interface IntegrityFinding {
  code: string;
  detail: string;
}

export function integrityFindings(candidate: ResearchCandidate, ctx: RankingContext): IntegrityFinding[] {
  const findings: IntegrityFinding[] = [];
  const refs = allRefsOf(candidate);
  if (refs.length === 0) {
    findings.push({ code: 'NO_SOURCE', detail: 'candidate carries no traceable evidence reference' });
  } else {
    const broken = refs.filter((r) => !ctx.resolvableEvidenceIds.has(r));
    if (broken.length > 0) {
      findings.push({ code: 'CITATION_BROKEN', detail: `unresolvable evidence refs: ${broken.slice(0, 5).join(', ')}` });
    }
  }
  if (candidate.compatibility.reasonCodes.includes('MECHANISM_CONFLICT') && candidate.decision !== 'rejected') {
    findings.push({ code: 'UNRESOLVED_CONFLICT', detail: 'a known mechanism conflict is not carried through to a rejection' });
  }
  if ((candidate.decision === 'proposed' || candidate.decision === 'conditional') && candidate.ablationMatrix.length !== 1 << candidate.moduleCardRefs.length) {
    findings.push({
      code: 'MISSING_ABLATION_ROWS',
      detail: `expected ${1 << candidate.moduleCardRefs.length} matrix rows, got ${candidate.ablationMatrix.length}`,
    });
  }
  if (candidate.ablationMatrix.some((row) => row.status !== 'planned')) {
    findings.push({ code: 'MEASURED_STATUS', detail: 'a planned-only matrix row claims a non-planned status' });
  }
  if (candidate.ablationMatrix.some((row) => row.baselineCardRef.id !== candidate.baselineCardRef.id)) {
    findings.push({ code: 'MATRIX_BASELINE_MISMATCH', detail: 'a matrix row references a different baseline card' });
  }
  if (candidate.performanceStatus !== 'NOT_VERIFIED') {
    findings.push({ code: 'PERFORMANCE_CLAIM', detail: 'candidate asserts a verified performance status' });
  }
  for (const field of [candidate.mechanismHypothesis, ...candidate.expectedEffects]) {
    if (typeof field.value === 'string' && /\d+(\.\d+)?\s*(%|bleu|map|dice|f1|points)\b/i.test(field.value)) {
      findings.push({ code: 'FABRICATED_PERFORMANCE', detail: `predicted number in asserted text: "${field.value.slice(0, 60)}"` });
      break;
    }
  }
  for (const ref of candidate.moduleCardRefs) {
    if (!ctx.cardsById.has(ref.id)) {
      findings.push({ code: 'CARD_UNRESOLVED', detail: `module card ${ref.id} is not part of the published card set` });
    }
  }
  return findings;
}

// ----------------- Ranking -----------------

export interface RankInput {
  candidates: ResearchCandidate[];
  ctx: RankingContext;
  producerOperationId: string;
  scoringPolicyHash: string;
}

export interface RankOutput {
  result: RankingResult;
  itemMap: Map<string, RankingItem>;
}

const GROUP_ORDER: RankingGroup[] = ['eligible', 'conditional', 'not_rankable', 'excluded'];

export function scoreCandidate(candidate: ResearchCandidate, ctx: RankingContext): Record<ScoringDimension, DimensionResult> {
  return {
    evidence_strength: dim(evidenceStrength(candidate, ctx)),
    mechanism_compatibility: dim(mechanismCompatibility(candidate, ctx)),
    mechanism_complementarity: dim(complementarity(candidate, ctx)),
    implementation_simplicity: dim(simplicity(candidate)),
  };
}

export function numeratorOf(dims: Record<ScoringDimension, DimensionResult>): number | null {
  let total = 0;
  for (const name of SCORING_DIMENSIONS) {
    const level = dims[name].level;
    if (level === null) return null;
    total += SCORING_POLICY_V1.weights[name] * level;
  }
  return total;
}

export function designScoreFromNumerator(numerator: number): number {
  return numerator / SCORING_POLICY_V1.denominator;
}

export function uncertaintyOf(dims: Record<ScoringDimension, DimensionResult>): Uncertainty {
  const nulls = SCORING_DIMENSIONS.filter((d) => dims[d].level === null);
  const weak = SCORING_DIMENSIONS.filter((d) => dims[d].ruleId.endsWith('-HALF'));
  return {
    nullDimensionCount: nulls.length,
    unsupportedRubricDimensions: weak as ScoringDimension[],
  };
}

export function rankCandidates(input: RankInput): RankOutput {
  const items: RankingItem[] = [];

  for (const candidate of input.candidates) {
    const dims = scoreCandidate(candidate, input.ctx);
    const uncertainty = uncertaintyOf(dims);
    const findings = integrityFindings(candidate, input.ctx);

    let group: RankingGroup;
    const exclusionReasons = findings.map((f) => `${f.code}: ${f.detail}`);

    if (findings.length > 0 || candidate.decision === 'rejected' || candidate.decision === 'insufficient_evidence') {
      group = 'excluded';
      if (candidate.decision === 'rejected') exclusionReasons.push(`P6_DECISION: ${candidate.decision}`);
      if (candidate.decision === 'insufficient_evidence') exclusionReasons.push(`P6_DECISION: ${candidate.decision}`);
    } else if (uncertainty.nullDimensionCount > 0) {
      group = 'not_rankable';
    } else if (candidate.decision === 'conditional') {
      group = 'conditional';
    } else {
      group = 'eligible';
    }

    const numerator = group === 'eligible' || group === 'conditional' ? numeratorOf(dims) : null;
    items.push({
      candidateId: candidate.id,
      candidateHash: candidate.candidateHash,
      originalDecision: candidate.decision,
      group,
      dimensionResults: dims,
      scoreNumerator: numerator,
      design_score: numerator === null ? null : designScoreFromNumerator(numerator),
      rank: null,
      reasonCodes: candidate.compatibility.reasonCodes,
      unresolvedConditions: candidate.compatibility.unresolvedConditions,
      uncertainty,
      exclusionReasons,
    });
  }

  for (const group of GROUP_ORDER) {
    const inGroup = items.filter((i) => i.group === group);
    if (group === 'eligible' || group === 'conditional') {
      const ordered = [...inGroup].sort((a, b) => {
        if (a.scoreNumerator !== b.scoreNumerator) return (b.scoreNumerator ?? 0) - (a.scoreNumerator ?? 0);
        return a.candidateHash < b.candidateHash ? -1 : a.candidateHash > b.candidateHash ? 1 : 0;
      });
      ordered.forEach((item, i) => {
        item.rank = i + 1;
      });
    }
  }

  const byGroup = (group: RankingGroup) =>
    items
      .filter((i) => i.group === group)
      .sort((a, b) => {
        if (a.rank !== null && b.rank !== null) return a.rank - b.rank;
        return a.candidateHash < b.candidateHash ? -1 : 1;
      })
      .map((i) => i.candidateId);

  const result: RankingResult = {
    schemaVersion: 1,
    candidateSetHash: computeCandidateSetHash(input.candidates),
    scoringPolicyHash: input.scoringPolicyHash,
    rubricVersion: RUBRIC_VERSION,
    eligibleIds: byGroup('eligible'),
    conditionalIds: byGroup('conditional'),
    notRankableIds: byGroup('not_rankable'),
    excludedIds: byGroup('excluded'),
    items: items.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (a.rank ?? 999) - (b.rank ?? 999) || (a.candidateId < b.candidateId ? -1 : 1)),
    calibrationStatus: 'uncalibrated',
    performanceStatus: 'NOT_VERIFIED',
    producerOperationId: input.producerOperationId,
  };

  assertGroupsDisjoint(result);
  return { result, itemMap: new Map(items.map((i) => [i.candidateId, i])) };
}

/** The four groups must be pairwise disjoint and cover every candidate exactly once. */
export function assertGroupsDisjoint(result: RankingResult): void {
  const lists: Array<[RankingGroup, string[]]> = [
    ['eligible', result.eligibleIds],
    ['conditional', result.conditionalIds],
    ['not_rankable', result.notRankableIds],
    ['excluded', result.excludedIds],
  ];
  const seen = new Map<string, RankingGroup>();
  for (const [group, ids] of lists) {
    for (const id of ids) {
      const prior = seen.get(id);
      if (prior) {
        throw new ResearchError('SCHEMA_VIOLATION', `Candidate "${id}" appears in both ${prior} and ${group}`, {
          fieldPaths: [group],
        });
      }
      seen.set(id, group);
    }
  }
  for (const item of result.items) {
    if (seen.get(item.candidateId) !== item.group) {
      throw new ResearchError('SCHEMA_VIOLATION', `Candidate "${item.candidateId}" is listed under ${seen.get(item.candidateId)} but reports ${item.group}`, {
        fieldPaths: [item.candidateId],
      });
    }
  }
  if (seen.size !== result.items.length) {
    throw new ResearchError('SCHEMA_VIOLATION', `Groups cover ${seen.size} ids but ${result.items.length} candidates were ranked`, {
      fieldPaths: ['eligibleIds', 'conditionalIds', 'notRankableIds', 'excludedIds'],
    });
  }
}

// ----------------- Template explanations (no extra LLM call) -----------------

const RATIONALE_TEMPLATES: Record<string, string> = {
  'ES-NULL': 'Identity, mechanism, or the composition assumption has no traceable support, so evidence strength cannot be scored.',
  'ES-0': 'Cited support contradicts the composition requirement.',
  'ES-HALF': 'Every required identity and mechanism is quoted, but at least one is inferred and the new combination remains a hypothesis.',
  'ES-1': 'Identity and mechanism are source-reported and the visible text states this composition; this is still not a verified interface.',
  'MC-NULL': 'The mechanism judgement stays insufficient or a key premise is unknown.',
  'MC-0': 'A task-scoped rejection or an explicit mechanism conflict is on record.',
  'MC-HALF': 'Mechanism fit holds only under conditions that remain unverified.',
  'MC-1': 'Mechanism premises hold with no unresolved condition; interface status remains NOT_VERIFIED.',
  'MP-NULL': 'An intervention axis or a target relation is not described, so complementarity cannot be judged.',
  'MP-0-CONFLICT': 'A mechanism conflict is recorded on the assessment.',
  'MP-0-DUPLICATE': 'All modules act on the same axis and the same target, so the combination repeats one function.',
  'MP-HALF': 'Single module, same axis without conflict, or complementary targets supported only by inference.',
  'MP-1': 'Two or more distinct axes, each target source-reported, with no recorded conflict.',
  'IS-NULL': 'Adaptation requirements are not fully enumerated, or carry unknown/other entries.',
  'IS-0': 'A new annotation or an architecture change is required.',
  'IS-HALF': 'A loss/target transform, operator replacement, or environment constraint is required.',
  'IS-1': 'Only an existing feature hook or a parameter selection is required, and each design premise is explainable.',
};

export function rationaleFor(dimension: ScoringDimension, result: DimensionResult): string {
  const text = RATIONALE_TEMPLATES[result.rationaleTemplateId];
  if (!text) {
    throw new ResearchError('SCHEMA_VIOLATION', `No template for rationale "${result.rationaleTemplateId}" on ${dimension}`);
  }
  return text;
}

export function renderRankingMarkdown(result: RankingResult): string {
  const lines: string[] = [];
  lines.push(`# Design Ranking (${PROTOCOL_ID})`);
  lines.push('');
  lines.push(`- candidateSetHash: ${result.candidateSetHash}`);
  lines.push(`- scoringPolicyHash: ${result.scoringPolicyHash} (${POLICY_ID}, ${result.rubricVersion})`);
  lines.push('- calibrationStatus: uncalibrated. design_score orders design readiness only; it is not a performance prediction.');
  lines.push('');
  for (const group of GROUP_ORDER) {
    const ids = { eligible: result.eligibleIds, conditional: result.conditionalIds, not_rankable: result.notRankableIds, excluded: result.excludedIds }[group];
    lines.push(`## ${group} (${ids.length})`);
    if (ids.length === 0) {
      lines.push('- none');
      continue;
    }
    for (const id of ids) {
      const item = result.items.find((i) => i.candidateId === id)!;
      const score = item.design_score === null ? 'null' : item.design_score.toFixed(3);
      lines.push(`- ${item.rank ?? '-'} ${id} [${item.originalDecision}] design_score=${score} numerator=${item.scoreNumerator ?? 'null'}`);
      for (const d of SCORING_DIMENSIONS) {
        const dr = item.dimensionResults[d];
        lines.push(`    - ${d}: ${dr.value === null ? 'null' : dr.value.toFixed(2)} via ${dr.ruleId} :: ${rationaleFor(d, dr)}`);
      }
      if (item.exclusionReasons.length > 0) lines.push(`    - excluded because: ${item.exclusionReasons.join(' | ')}`);
      if (item.unresolvedConditions.length > 0) lines.push(`    - open conditions: ${item.unresolvedConditions.join('; ')}`);
      lines.push(
        `    - uncertainty: nullDimensions=${item.uncertainty.nullDimensionCount}, weaklyAnchored=${item.uncertainty.unsupportedRubricDimensions.join(',') || 'none'}`
      );
    }
  }
  lines.push('');
  lines.push('_Ranking is produced by deterministic rules over P6 fields. Ties keep candidateHash order; that order is stability, not merit._');
  return lines.join('\n') + '\n';
}

export function assertCandidateSetWellFormed(candidates: ResearchCandidate[], knownSpanIds: Set<string>): void {
  const seenHashes = new Map<string, string>();
  for (const candidate of candidates) {
    validateCandidate(candidate, `candidates.${candidate.id}`, { knownSpanIds });
    const prior = seenHashes.get(candidate.candidateHash);
    if (prior && prior !== candidate.id) {
      throw new ResearchError('SOURCE_MISMATCH', `Two candidate ids share one semantic hash: ${prior} and ${candidate.id}`, {
        fieldPaths: ['candidateHash'],
      });
    }
    seenHashes.set(candidate.candidateHash, candidate.id);
  }
}
