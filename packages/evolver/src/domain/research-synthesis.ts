/**
 * P6 Synthesize: card-chain verification against succeeded P5 output, mechanism-only
 * compatibility decisions, Host-generated ablation matrices, candidate hashing/dedup,
 * and proposal export.
 * Spec: docs/mvp/phases/P6-SPEC.md sections 2, 3, 7, 9.
 */

import * as path from 'node:path';
import {
  PROTOCOL_ID,
  ResearchError,
  SCHEMA_VERSION,
  MAX_MODULES_PER_CANDIDATE,
  MAX_MODULES_PER_CANDIDATE_V2,
  synthesisVariants,
  type SynthesisContractVersion,
  CONTROLLED_VARIABLE_KEYS,
  PENDING_FREEZE,
  REJECTING_REASON_CODES,
  type CardRef,
  type ResearchTaskBrief,
  type ResearchBaselineCard,
  type ResearchModuleCard,
  type CompatibilityAssessment,
  type ConceptualBinding,
  type ResearchCandidate,
  type AblationRow,
  type SynthesisResult,
  type ArtifactRef,
  type EvidenceField,
  type CandidateDecision,
  type CompatibilityDecision,
  type ReasonCode,
  validateTaskBrief,
  validateCardRef,
  validateCandidate,
  validateCompatibilityAssessment,
  validateSynthesisResult,
  deriveCandidateDecision,
} from '../contracts/research.ts';
import { typedHash, sha256Hex, canonicalJsonV1 } from './research-canonical.ts';

export const MAX_CANDIDATES_DEFAULT = 5;

export function computeTaskBriefHash(taskBrief: ResearchTaskBrief): string {
  return typedHash('task-brief', taskBrief);
}

/** Semantic identity of a card reference: content hash + revision only. */
export function semanticCardRef(ref: CardRef): { sha256: string; revision: number } {
  return { sha256: ref.sha256, revision: ref.revision };
}

export interface ResolvedCard {
  ref: CardRef;
  kind: 'baseline' | 'module';
  card: ResearchBaselineCard | ResearchModuleCard;
  producerStatus: 'succeeded';
  ownerOperationId: string;
}

/**
 * The only way P6 learns about a card. A fixture card must be explicitly marked; an
 * end-to-end run must resolve cards through succeeded P5 publications.
 */
export interface CardResolver {
  resolve(ref: CardRef): ResolvedCard;
}

export interface CardChainFacts {
  resolved: ResolvedCard[];
  byId: Map<string, ResolvedCard>;
}

export function verifyCardChain(refs: CardRef[], resolver: CardResolver): CardChainFacts {
  const resolved: ResolvedCard[] = [];
  const byId = new Map<string, ResolvedCard>();
  for (const ref of refs) {
    validateCardRef(ref);
    const existing = byId.get(ref.id);
    if (existing) {
      if (existing.ref.sha256 !== ref.sha256 || existing.ref.revision !== ref.revision) {
        throw new ResearchError('SOURCE_MISMATCH', `Card "${ref.id}" requested at two revisions in one request`, {
          fieldPaths: [ref.id],
        });
      }
      continue;
    }
    const item = resolver.resolve(ref);
    if (item.ref.sha256 !== ref.sha256) {
      throw new ResearchError('SOURCE_MISMATCH', `Card "${ref.id}" content hash mismatch: ref ${ref.sha256} vs published ${item.ref.sha256}`, {
        fieldPaths: [`${ref.id}.sha256`],
      });
    }
    if (item.ref.producerOperationId !== ref.producerOperationId) {
      throw new ResearchError('DEPENDENCY_NOT_READY', `Card "${ref.id}" was not produced by operation ${ref.producerOperationId}`, {
        fieldPaths: [`${ref.id}.producerOperationId`],
      });
    }
    if (item.producerStatus !== 'succeeded') {
      throw new ResearchError('DEPENDENCY_NOT_READY', `Card "${ref.id}" producer operation is not succeeded`, {
        fieldPaths: [`${ref.id}.producerOperationId`],
      });
    }
    resolved.push(item);
    byId.set(ref.id, item);
  }
  return { resolved, byId };
}

// ----------------- Ablation matrix -----------------

function compareCardRef(a: CardRef, b: CardRef): number {
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.revision - b.revision;
}

/**
 * Deterministic Host generation: 0 modules -> baseline, 1 -> 2 rows, 2 -> 4 rows,
 * 3 -> the fixed 8-row bitmask 000..111. v0.1 may not reduce it.
 */
export function generateAblationMatrix(
  moduleRefs: CardRef[],
  baselineCardRef: CardRef,
  taskBriefHash: string,
  evaluationQuestionFor: (row: CardRef[]) => string[],
  contractVersion: SynthesisContractVersion = 1,
): AblationRow[] {
  const max = contractVersion === 1 ? MAX_MODULES_PER_CANDIDATE : MAX_MODULES_PER_CANDIDATE_V2;
  if (moduleRefs.length > max) throw new ResearchError('INVALID_INPUT', `At most ${max} modules per candidate`, { fieldPaths: ['moduleCardRefs'] });
  const sorted = [...moduleRefs].sort(compareCardRef);
  const variants = synthesisVariants(moduleRefs, contractVersion);
  const rows: AblationRow[] = [];
  for (const variant of variants) {
    const chosen = sorted.filter(ref => variant.moduleRefs.includes(ref.id));
    const variantId = variant.variantId;
    const controlledVariables = Object.fromEntries(CONTROLLED_VARIABLE_KEYS.map((key) => [key, PENDING_FREEZE])) as Record<string, string>;
    rows.push({
      variantId,
      moduleRefs: chosen.map((c) => c.id),
      baselineCardRef,
      taskBriefHash,
      status: 'planned',
      controlledVariables,
      evaluationQuestions: evaluationQuestionFor(chosen),
    });
  }
  return rows;
}

export function expectedMatrixRowCount(moduleCount: number, version: SynthesisContractVersion = 1): number {
  if (!Number.isInteger(moduleCount) || moduleCount < 0) throw new ResearchError('INVALID_INPUT', 'Module count must be a non-negative integer');
  return synthesisVariants(Array.from({ length: moduleCount }, (_, i) => ({ id: String(i), revision: 1 } as CardRef)), version).length;
}

// ----------------- Numeric honesty -----------------

const PERFORMANCE_ASSERTION = /(\d+(?:[.,]\d+)?)\s*(%|percent|bleu|map|dice|iou|f1|acc|accuracy|points|pp|x\b)/i;

/**
 * New combinations may not carry a predicted number. This is a mechanical guard on the
 * asserted-effect text; it does not prove semantic honesty, which stays a rubric concern.
 */
export function assertNoFabricatedPerformance(candidate: ResearchCandidate): void {
  const scanned: Array<[string, string]> = [];
  const push = (label: string, field: EvidenceField<string> | undefined): void => {
    if (field && typeof field.value === 'string') scanned.push([label, field.value]);
  };
  push('mechanismHypothesis', candidate.mechanismHypothesis);
  candidate.expectedEffects.forEach((e, i) => push(`expectedEffects[${i}]`, e));
  for (const [label, text] of scanned) {
    const cleaned = text.replace(/https?:\/\/\S+/g, ' ');
    if (PERFORMANCE_ASSERTION.test(cleaned)) {
      throw new ResearchError(
        'SCHEMA_VIOLATION',
        `${label}: a new combination may not state a predicted metric value ("${cleaned.slice(0, 80)}")`,
        { fieldPaths: [label] }
      );
    }
  }
  if (candidate.performanceStatus !== 'NOT_VERIFIED') {
    throw new ResearchError('SCHEMA_VIOLATION', 'candidate.performanceStatus must be NOT_VERIFIED', {
      fieldPaths: ['performanceStatus'],
    });
  }
  for (const field of Object.keys(candidate)) {
    if (/predicted|expectedScore|expectedDelta|projectedMetric/i.test(field)) {
      throw new ResearchError('SCHEMA_VIOLATION', `Forbidden predicted-performance field "${field}"`, { fieldPaths: [field] });
    }
  }
}

/** Paper A's gain plus paper B's gain is never a result. */
export function assertNoCrossPaperArithmetic(candidates: ResearchCandidate[]): void {
  for (const candidate of candidates) {
    const texts: string[] = [];
    candidate.expectedEffects.forEach((e) => typeof e.value === 'string' && texts.push(e.value));
    candidate.mechanismHypothesis.value !== null && texts.push(candidate.mechanismHypothesis.value as string);
    for (const text of texts) {
      if (/\b(sum|total|combined|additive|adds? up)\b/i.test(text) && /\d/.test(text)) {
        throw new ResearchError('SCHEMA_VIOLATION', `Cross-paper arithmetic suspected in asserted effects: "${text.slice(0, 90)}"`, {
          fieldPaths: ['expectedEffects'],
        });
      }
    }
  }
}

// ----------------- Conceptual bindings -----------------

export function validateBindingsAgainstCards(bindings: ConceptualBinding[], chain: CardChainFacts, candidate: ResearchCandidate): void {
  const moduleIds = new Set(candidate.moduleCardRefs.map((r) => r.id));
  const boundIds = new Set(bindings.map((b) => b.moduleRef.id));
  if (moduleIds.size !== boundIds.size || ![...moduleIds].every((id) => boundIds.has(id))) {
    throw new ResearchError('SCHEMA_VIOLATION', 'conceptualBindings must cover exactly the candidate modules', {
      fieldPaths: ['conceptualBindings'],
    });
  }
  for (const binding of bindings) {
    const resolved = chain.byId.get(binding.moduleRef.id);
    if (!resolved) {
      throw new ResearchError('DEPENDENCY_NOT_READY', `Binding refers to unresolvable card "${binding.moduleRef.id}"`, {
        fieldPaths: [binding.moduleRef.id],
      });
    }
    const axisOnCard = (resolved.card as ResearchModuleCard).interventionAxis?.value ?? null;
    if (axisOnCard === null) {
      throw new ResearchError('EVIDENCE_INVALID', `Card "${binding.moduleRef.id}" has no evidenced axis; P6 may not invent one`, {
        fieldPaths: [`${binding.moduleRef.id}.axis`],
      });
    }
    if (binding.axis !== axisOnCard) {
      throw new ResearchError(
        'SCHEMA_VIOLATION',
        `Binding axis "${binding.axis}" overrides the card's "${axisOnCard}"; a correction needs a new upstream card revision`,
        { fieldPaths: [`${binding.moduleRef.id}.axis`] }
      );
    }
  }
}

// ----------------- Candidate hashing -----------------

export function computeCandidateHash(input: {
  taskBriefHash: string;
  baselineCardRef: CardRef;
  moduleCardRefs: CardRef[];
  conceptualBindings: ConceptualBinding[];
  decision: CandidateDecision;
  schemaVersion: number;
  contractVersion?: 2;
}): string {
  const stripRef = (ref: CardRef) => semanticCardRef(ref);
  return typedHash('candidate', {
    schemaVersion: input.contractVersion ?? input.schemaVersion,
    ...(input.contractVersion === 2 ? { synthesisContract: 'research-synthesis-v2', ablationPolicy: 'leave-one-out-v1' } : {}),
    taskBriefHash: input.taskBriefHash,
    baselineCard: stripRef(input.baselineCardRef),
    modules: input.moduleCardRefs.map(stripRef),
    bindings: [...input.conceptualBindings]
      .map((b) => ({
        module: stripRef(b.moduleRef),
        axis: b.axis,
        relation: b.relation,
        targetConcept: b.targetConcept.value,
        requiredInputs: b.requiredInputs.map((r) => r.value),
      }))
      .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0)),
    decision: input.decision,
  });
}

export function computeCandidateSetHash(candidates: ResearchCandidate[]): string {
  return typedHash('candidate-set', {
    candidateHashes: [...new Set(candidates.map((c) => c.candidateHash))].sort(),
  });
}

// ----------------- Draft assembly -----------------

export interface CandidateDraft {
  id: string;
  baselineCardRef: CardRef;
  moduleCardRefs: CardRef[];
  compatibility: CompatibilityAssessment;
  mechanismHypothesis: EvidenceField<string>;
  conceptualBindings: ConceptualBinding[];
  expectedEffects: EvidenceField<string>[];
  risks: EvidenceField<string>[];
  requiredValidation: EvidenceField<string>[];
  evidenceRefs: string[];
  decision: CandidateDecision;
  performanceStatus: 'NOT_VERIFIED';
}

export interface SynthesisDraft {
  candidates: CandidateDraft[];
}

export interface AssembleSynthesisInput {
  contractVersion?: SynthesisContractVersion;
  taskBrief: ResearchTaskBrief;
  draft: SynthesisDraft;
  chain: CardChainFacts;
  producerOperationId: string;
  corpusHash: string;
  maxCandidates?: number;
}

export interface AssembledSynthesis {
  result: SynthesisResult;
  deduplication: Array<{ fromId: string; toId: string; candidateHash: string }>;
  proposalMarkdown: string;
  proposalRef: ArtifactRef;
}

const DECISION_LABEL: Record<CompatibilityDecision, string> = {
  compatible: 'proposed',
  conditionally_compatible: 'conditional',
  reject_for_mvp: 'rejected',
  insufficient_evidence: 'insufficient_evidence',
};

function defaultEvaluationQuestions(chosen: CardRef[]): string[] {
  if (chosen.length === 0) {
    return ['What does the frozen baseline achieve under the task dataset, split, seeds, budget, and metric once they are frozen?'];
  }
  const names = chosen.map((ref) => ref.id);
  const questions = chosen.map(
    (ref) => `Does the single-module variant ${names.join('+')} move the frozen metric versus baseline in the direction its mechanism predicts?`
  );
  if (chosen.length > 1) {
    questions.push(
      `Does the combined variant differ from its best single-module variant, i.e. are the mechanisms additive, redundant, or conflicting?`
    );
    questions.push('Does each module still participate (non-zero effect) when all of them are active at once?');
  }
  return questions;
}

export function assembleSynthesis(input: AssembleSynthesisInput): AssembledSynthesis {
  const contractVersion = input.contractVersion ?? 1;
  const taskBrief = validateTaskBrief(input.taskBrief, 'ResearchTaskBrief');
  if (taskBrief.corpusHash !== input.corpusHash) {
    throw new ResearchError('SOURCE_MISMATCH', `taskBrief.corpusHash ${taskBrief.corpusHash} != frozen corpus ${input.corpusHash}`, {
      fieldPaths: ['taskBrief.corpusHash'],
    });
  }
  const taskBriefHash = computeTaskBriefHash(taskBrief);
  const maxCandidates = input.maxCandidates ?? MAX_CANDIDATES_DEFAULT;
  if (input.draft.candidates.length > maxCandidates) {
    throw new ResearchError('INVALID_INPUT', `Candidate budget is ${maxCandidates}, got ${input.draft.candidates.length}`, {
      fieldPaths: ['candidates'],
    });
  }

  const allowedModuleIds = new Set(taskBrief.allowedModuleRefs.map((r) => r.id));
  const baselineId = taskBrief.baselineCardRef.id;

  const knownSpanIds = new Set<string>();
  for (const item of input.chain.resolved) {
    (item.card.evidenceRefs ?? []).forEach((ref) => knownSpanIds.add(ref));
  }
  const spanOpts = { knownSpanIds };

  const byHash = new Map<string, ResearchCandidate>();
  const deduplication: AssembledSynthesis['deduplication'] = [];
  const candidates: ResearchCandidate[] = [];

  for (const draft of input.draft.candidates) {
    if (draft.baselineCardRef.id !== baselineId) {
      throw new ResearchError('POLICY_DENIED', `Candidate "${draft.id}" changes the frozen baseline from ${baselineId} to ${draft.baselineCardRef.id}`, {
        fieldPaths: [`${draft.id}.baselineCardRef`],
      });
    }
    if (draft.moduleCardRefs.length === 0) {
      throw new ResearchError('INVALID_INPUT', `Candidate "${draft.id}" must bind at least one module`, { fieldPaths: [`${draft.id}.moduleCardRefs`] });
    }
    for (const ref of draft.moduleCardRefs) {
      if (!allowedModuleIds.has(ref.id)) {
        throw new ResearchError('POLICY_DENIED', `Candidate "${draft.id}" uses module "${ref.id}" that the TaskBrief does not allow`, {
          fieldPaths: [`${draft.id}.moduleCardRefs`],
        });
      }
      if (ref.id === baselineId) {
        throw new ResearchError('INVALID_INPUT', 'Baseline may not appear as a module', { fieldPaths: [`${draft.id}.moduleCardRefs`] });
      }
    }
    const derived = deriveCandidateDecision(draft.compatibility.decision);
    if (derived !== draft.decision) {
      throw new ResearchError(
        'SCHEMA_VIOLATION',
        `Candidate "${draft.id}": decision "${draft.decision}" cannot override compatibility "${draft.compatibility.decision}" -> "${derived}"`,
        { fieldPaths: [`${draft.id}.decision`] }
      );
    }

    const decision = draft.decision;
    const matrix =
      decision === 'rejected' || decision === 'insufficient_evidence'
        ? []
        : generateAblationMatrix(draft.moduleCardRefs, draft.baselineCardRef, taskBriefHash, defaultEvaluationQuestions, contractVersion);
    synthesisVariants(draft.moduleCardRefs, contractVersion);
    const candidateHash = computeCandidateHash({
      taskBriefHash,
      baselineCardRef: draft.baselineCardRef,
      moduleCardRefs: draft.moduleCardRefs,
      conceptualBindings: draft.conceptualBindings,
      decision: draft.decision,
      schemaVersion: SCHEMA_VERSION,
      ...(contractVersion === 2 ? { contractVersion: 2 as const } : {}),
    });

    const assembled: ResearchCandidate = {
      ...(contractVersion === 2 ? { contractVersion: 2 as const } : {}),
      id: draft.id,
      candidateHash,
      taskBriefHash,
      baselineCardRef: draft.baselineCardRef,
      moduleCardRefs: draft.moduleCardRefs,
      compatibility: { ...draft.compatibility, baselineCardRef: draft.baselineCardRef },
      mechanismHypothesis: draft.mechanismHypothesis,
      conceptualBindings: draft.conceptualBindings,
      expectedEffects: draft.expectedEffects,
      risks: draft.risks,
      requiredValidation: draft.requiredValidation,
      ablationMatrix: matrix,
      evidenceRefs: draft.evidenceRefs,
      decision: draft.decision,
      performanceStatus: 'NOT_VERIFIED',
    };

    validateCompatibilityAssessment(assembled.compatibility, `${draft.id}.compatibility`, spanOpts);
    validateBindingsAgainstCards(assembled.conceptualBindings, input.chain, assembled);
    if (assembled.decision === 'proposed' || assembled.decision === 'conditional') {
      if (assembled.ablationMatrix.length !== expectedMatrixRowCount(assembled.moduleCardRefs.length, contractVersion)) {
        throw new ResearchError('SCHEMA_VIOLATION', `Ablation matrix must have ${expectedMatrixRowCount(assembled.moduleCardRefs.length)} rows`, {
          fieldPaths: [`${draft.id}.ablationMatrix`],
        });
      }
    }
    validateCandidate(assembled, `candidates.${draft.id}`, spanOpts);
    assertNoFabricatedPerformance(assembled);
    assertNoCrossPaperArithmetic([assembled]);

    const prior = byHash.get(candidateHash);
    if (prior) {
      deduplication.push({ fromId: draft.id, toId: prior.id, candidateHash });
      continue;
    }
    byHash.set(candidateHash, assembled);
    candidates.push(assembled);
  }

  const assessments: CompatibilityAssessment[] = [];
  for (const candidate of candidates) {
    assessments.push(candidate.compatibility);
  }

  const proposalMarkdown = renderProposal({
    taskBrief,
    taskBriefHash,
    candidates,
    deduplication,
  });
  const proposalRef: ArtifactRef = {
    id: `${PROTOCOL_ID}/p6/${input.producerOperationId}/proposal.md`,
    sha256: sha256Hex(proposalMarkdown),
  };

  const result: SynthesisResult = {
    schemaVersion: contractVersion,
    taskBriefHash,
    assessments,
    candidates,
    proposalRef,
    producerOperationId: input.producerOperationId,
  };
  validateSynthesisResult(result, 'SynthesisResult', spanOpts);

  return { result, deduplication, proposalMarkdown, proposalRef };
}

// ----------------- Proposal export -----------------

export interface ProposalInput {
  taskBrief: ResearchTaskBrief;
  taskBriefHash: string;
  candidates: ResearchCandidate[];
  deduplication: Array<{ fromId: string; toId: string; candidateHash: string }>;
}

function labelOf(value: EvidenceField<unknown> | undefined): string {
  if (!value) return 'absent';
  if (value.value === null) return `unknown (${value.reason ?? 'no reason given'})`;
  return `${String(value.value)} [${value.status}]`;
}

/** Fixed render order from P6-SPEC section 9; Markdown is derived, never a second source. */
export function renderProposal(input: ProposalInput): string {
  const lines: string[] = [];
  lines.push(`# Research Proposal (${PROTOCOL_ID})`);
  if (input.candidates.some(c => c.contractVersion === 2)) lines.push('Synthesis sub-contract: research-synthesis-v2; leave-one-out plan only, not a full interaction proof.');
  lines.push('');
  lines.push('## Research question');
  lines.push(`- ${input.taskBrief.researchQuestion}`);
  lines.push(`- domain: ${input.taskBrief.domain}`);
  lines.push(`- baseline card: ${input.taskBrief.baselineCardRef.id} (r${input.taskBrief.baselineCardRef.revision})`);
  lines.push(`- taskBriefHash: ${input.taskBriefHash}`);
  lines.push('');
  lines.push('## Input evidence and coverage');
  lines.push(`- allowed modules: ${input.taskBrief.allowedModuleRefs.map((r) => r.id).join(', ') || 'none'}`);
  if (input.taskBrief.constraints.length === 0) {
    lines.push('- constraints: none supplied; unspecified conditions are not assumed satisfied');
  } else {
    input.taskBrief.constraints.forEach((c) => lines.push(`- constraint [${c.kind}] ${c.id}: ${c.value}`));
  }
  lines.push('');
  lines.push('## Candidates');
  if (input.candidates.length === 0) lines.push('- none');
  for (const c of input.candidates) {
    lines.push(
      `| ${c.id} | ${c.decision} (${DECISION_LABEL[c.compatibility.decision]}) | ${c.moduleCardRefs.length} module(s) | ${c.candidateHash.slice(0, 12)} |`
    );
  }
  lines.push('');
  lines.push('## Mechanism hypothesis and conceptual bindings');
  for (const c of input.candidates) {
    lines.push(`### ${c.id}`);
    lines.push(`- hypothesis: ${labelOf(c.mechanismHypothesis)}`);
    for (const b of c.conceptualBindings) {
      lines.push(`- ${b.moduleRef.id}: axis=${b.axis} relation=${b.relation} target=${labelOf(b.targetConcept)}`);
    }
  }
  lines.push('');
  lines.push('## Risks and conditions');
  for (const c of input.candidates) {
    lines.push(`### ${c.id}`);
    lines.push(`- unresolved conditions: ${c.compatibility.unresolvedConditions.join('; ') || 'none'}`);
    lines.push(`- reason codes: ${c.compatibility.reasonCodes.join(', ') || 'none'}`);
    c.risks.forEach((r, i) => lines.push(`- risk[${i}]: ${labelOf(r)}`));
    c.requiredValidation.forEach((r, i) => lines.push(`- validation[${i}]: ${labelOf(r)}`));
  }
  lines.push('');
  lines.push('## Ablation design (all rows planned, nothing measured)');
  for (const c of input.candidates) {
    if (c.decision === 'rejected' || c.decision === 'insufficient_evidence') {
      lines.push(`- ${c.id}: no experiment design is exported for a ${c.decision} candidate`);
      continue;
    }
    lines.push(`- ${c.id}: ${c.ablationMatrix.length} rows -> ${c.ablationMatrix.map((r) => r.variantId).join(', ')}`);
    lines.push(`  - controlled variables: ${Object.entries(r0(c.ablationMatrix)).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  lines.push('');
  lines.push('## Publicly reported results and comparability');
  lines.push('- Source-reported numbers live on the P5 cards, keyed by paper and condition.');
  lines.push('- Comparability across studies is unknown or context-matched; context_matched still does not authorize adding gains.');
  lines.push('- Every new combination here has performanceStatus=NOT_VERIFIED and carries no predicted number.');
  lines.push('');
  lines.push('## Rejected and insufficient candidates');
  const notRecommended = input.candidates.filter((c) => c.decision === 'rejected' || c.decision === 'insufficient_evidence');
  if (notRecommended.length === 0) lines.push('- none');
  for (const c of notRecommended) {
    lines.push(`- ${c.id} [${c.decision}] reason=${c.compatibility.reasonCodes.join(',')} :: ${c.compatibility.rationale}`);
  }
  lines.push('');
  lines.push('## Deduplicated candidates');
  if (input.deduplication.length === 0) lines.push('- none');
  for (const d of input.deduplication) {
    lines.push(`- ${d.fromId} -> ${d.toId} (candidateHash ${d.candidateHash.slice(0, 12)})`);
  }
  lines.push('');
  lines.push('## Traceability');
  for (const c of input.candidates) {
    lines.push(`- ${c.id}: evidenceRefs=${c.evidenceRefs.join(', ') || 'none'}; taskBriefHash=${c.taskBriefHash.slice(0, 12)}; baseline=${c.baselineCardRef.id}@${c.baselineCardRef.revision}`);
  }
  lines.push('');
  lines.push('_No executable training or code-adaptation entry point exists in this phase; every row above is planned._');
  return lines.join('\n') + '\n';
}

function r0(rows: AblationRow[]): Record<string, string> {
  return rows.length > 0 ? rows[0].controlledVariables : {};
}

/** Decision-consistency helper used by the verifier to flag unsupported upgrades. */
export function decisionFollowsFromAssessment(assessment: CompatibilityAssessment): CandidateDecision {
  return deriveCandidateDecision(assessment.decision);
}

export function assertingRejectIsTaskScoped(candidate: ResearchCandidate): string[] {
  const problems: string[] = [];
  if (candidate.decision !== 'rejected') return problems;
  const universal = /never|impossible in all|cannot work in any|universally unfit/i;
  const texts = [candidate.compatibility.rationale, ...candidate.risks.map((r) => r.value ?? '')];
  texts.forEach((text, i) => {
    if (typeof text === 'string' && universal.test(text)) {
      problems.push(`risks[${i}]: reject_for_mvp must stay task-scoped, not claim universal impossibility`);
    }
  });
  const hasRejectingReason = candidate.compatibility.reasonCodes.some((c: ReasonCode) => REJECTING_REASON_CODES.includes(c));
  if (!hasRejectingReason) {
    problems.push('rejected candidate has no rejecting reason code');
  }
  return problems;
}

// ----------------- Prompt building -----------------

export interface SynthesisPromptBundle {
  systemPrompt: string;
  userPrompt: string;
  framing: string;
  promptHash: string;
  skillHash: string;
}

/**
 * The request carries the task brief and the published cards only. No gold, no expected
 * decision, and no score may appear in it.
 */
export function buildSynthesisPrompt(
  taskBrief: ResearchTaskBrief,
  cards: Array<ResearchBaselineCard | ResearchModuleCard>,
  publicProtocol: Record<string, unknown>,
  skillText: string
): SynthesisPromptBundle {
  const vocabularies = publicProtocol.vocabularies;
  if (typeof vocabularies !== 'object' || vocabularies === null || Array.isArray(vocabularies)) {
    throw new ResearchError('SCHEMA_VIOLATION', 'publicProtocol.vocabularies must be an object');
  }
  const vocabulary = vocabularies as Record<string, unknown>;
  const framing = [
    'Judge mechanism-only compatibility for the task brief below, using only the published cards.',
    'Never invent a channel count, dtype, tensor shape, or code slot; interface status stays NOT_VERIFIED.',
    'A new combination is a hypothesis: state direction and mechanism, never a predicted metric value.',
    'If the brief and the cards cannot settle the question, return insufficient_evidence rather than guessing.',
    `SYNTHESIS LIMITS (Host policy, not model-selected): ${JSON.stringify(publicProtocol.synthesisLimits)}`,
    '',
    `DECISION VOCABULARY: ${JSON.stringify(vocabulary.compatibilityDecision)}`,
    `CANDIDATE DECISIONS: ${JSON.stringify(vocabulary.candidateDecision)}`,
    `REASON CODES: ${JSON.stringify(vocabulary.reasonCodes)}`,
    `REQUIREMENT CATEGORIES: ${JSON.stringify(vocabulary.requirementCategory)}`,
    `BINDING RELATIONS: ${JSON.stringify(vocabulary.bindingRelation)}`,
    `INTERVENTION AXES: ${JSON.stringify(vocabulary.interventionAxis)}`,
    `RESPONSE SCHEMA (the only accepted shape): ${JSON.stringify(publicProtocol.synthesisResponseSchema)}`,
  ].join('\n');

  const userPrompt = [
    framing,
    '',
    `TASK BRIEF:\n${canonicalJsonV1(taskBrief)}`,
    `PUBLISHED CARDS:\n${canonicalJsonV1(cards)}`,
  ].join('\n');

  return {
    systemPrompt: skillText,
    userPrompt,
    framing: `${skillText}\n${framing}`,
    promptHash: typedHash('request', { systemPrompt: skillText, userPrompt }),
    skillHash: sha256Hex(skillText),
  };
}

export function proposalPath(producerOperationId: string): string {
  return path.posix.join(PROTOCOL_ID, 'p6', producerOperationId, 'proposal.md');
}
