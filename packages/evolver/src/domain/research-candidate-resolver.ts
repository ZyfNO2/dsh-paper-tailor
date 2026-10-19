/**
 * Resolves a `ProposalLink` of kind `research` into the P6 candidate it names.
 *
 * Spec: docs/mvp/phases/PHASE2-SPEC.md section 3, and the P5/P6/P7 -> Phase 2 boundary in
 * docs/mvp/RESEARCH-EXECUTION-ARCHITECTURE.md section 6:
 *
 *   "从 succeeded 发布解析 ResearchCandidate/CardRef；或显式 manual proposal 与选择理由。
 *    拒绝候选不能自动变可执行；修订成新 proposal 留下覆盖理由"
 *
 * The point of this module is that Phase 2 must NOT be able to treat a research proposal as an
 * opaque blob it happens to agree with. It resolves the candidate through the frozen P6 contract,
 * refuses anything that is not a `succeeded` publication, and refuses a rejected candidate outright
 * rather than letting a decision be re-litigated here.
 *
 * A research candidate carries a `moduleCardRefs` list. Those are RESEARCH cards, which are always
 * `proposed` and never carry an implementation hash; turning them into runnable modules is the
 * source-resolution step's job, not this one's. What this returns is the pinned identity of the
 * candidate plus the module card ids to resolve, so a drift in any of them is detectable.
 */

import { typedHash } from './research-canonical.ts';
import {
  ExperimentError,
  type ProposalLink,
} from '../contracts/experiments.ts';
import {
  validateSynthesisResult,
  type CardRef,
  type ResearchCandidate,
  type SynthesisResult,
} from '../contracts/research.ts';

export interface ResearchCandidateBinding {
  /** The candidate id as published. */
  candidateId: string;
  /** The candidateHash as published; the caller must not silently accept a different one. */
  candidateHash: string;
  /** The task brief the candidate was designed against. */
  taskBriefHash: string;
  /** The P6 producer operation that published the synthesis this candidate came from. */
  producerOperationId: string;
  /** The baseline research card, exactly as published. */
  baselineCardRef: CardRef;
  /** The module research cards, in the order the candidate declared them. */
  moduleCardRefs: CardRef[];
  /** The candidate's decision, carried through so a refusal can quote it. */
  decision: ResearchCandidate['decision'];
  /** The mechanism hypothesis exactly as published. Never restated here. */
  mechanismHypothesis: string;
  /** The declared ablation design. Planning only; Phase 2 executes its own protocol. */
  ablationMatrix: Array<{ variantId: string; moduleRefs: string[]; status: string }>;
}

/** Where a Phase 2 host reads research publications from. */
export interface ResearchPublicationStore {
  /**
   * Returns the published `SynthesisResult` for an operation, or null when there is none.
   *
   * The caller must only offer a `succeeded` operation: this module re-checks the shape, but it
   * cannot verify a status it is not told, so a lying store would pass. Passing the status in
   * alongside keeps the check on this side of the boundary.
   */
  readSynthesisResult(operationId: string): { status: string; result: unknown } | null;
}

/**
 * A candidate is executable-eligible only if P6 said it is worth trying.
 *
 * `rejected` and `insufficient_evidence` are terminal on the research side: a rejected candidate
 * does not become runnable because Phase 2 is willing to spend budget on it. Revising it means
 * publishing a NEW proposal, which is a new candidate with its own hash — not a re-reading of this
 * one.
 */
const EXECUTABLE_ELIGIBLE_DECISIONS = new Set<ResearchCandidate['decision']>(['proposed', 'conditional']);

/**
 * Verifies the three refs a research ProposalLink carries are mutually consistent BEFORE looking
 * anything up, so an obviously inconsistent link fails without touching the store.
 */
function assertLinkShape(link: ProposalLink): {
  synthesisResultRef: NonNullable<ProposalLink['synthesisResultRef']>;
  candidateId: string;
  candidateHash: string;
} {
  if (link.kind !== 'research') {
    throw new ExperimentError('INVALID_INPUT', 'resolveResearchCandidate requires a proposal of kind "research"', {
      fieldPaths: ['proposal.kind'],
    });
  }
  const { synthesisResultRef, candidateId, candidateHash } = link;
  if (!synthesisResultRef || !candidateId || !candidateHash) {
    throw new ExperimentError(
      'INVALID_INPUT',
      'a research proposal requires synthesisResultRef, candidateId and candidateHash',
      { fieldPaths: ['proposal.candidateId'] }
    );
  }
  return { synthesisResultRef, candidateId, candidateHash };
}

export function resolveResearchCandidate(
  link: ProposalLink,
  store: ResearchPublicationStore
): ResearchCandidateBinding {
  const { synthesisResultRef, candidateId, candidateHash } = assertLinkShape(link);

  // 1. The ref must name a publication this host actually holds.
  const published = store.readSynthesisResult(synthesisResultRef.id);
  if (!published) {
    throw new ExperimentError(
      'NOT_FOUND',
      `no published synthesis result for "${synthesisResultRef.id}"; a research proposal may only resolve through a publication this host holds`,
      { fieldPaths: ['proposal.synthesisResultRef.id'] }
    );
  }

  // 2. Only a succeeded publication is resolvable. An accepted/running/failed operation has not
  //    published a candidate, so reading one from it would be reading a non-result.
  if (published.status !== 'succeeded') {
    throw new ExperimentError(
      'DEPENDENCY_NOT_READY',
      `synthesis operation "${synthesisResultRef.id}" is ${published.status}, not succeeded; a research proposal may only resolve from a succeeded publication`,
      { fieldPaths: ['proposal.synthesisResultRef.id'], retryable: published.status === 'accepted' || published.status === 'running' }
    );
  }

  // 3. The content must be a real SynthesisResult under the frozen P6 contract. `parseJsonStrictV1`
  //    is used so a truncated or hand-edited file is refused rather than half-read.
  let result: SynthesisResult;
  try {
    const asText = typeof published.result === 'string' ? published.result : JSON.stringify(published.result);
    result = validateSynthesisResult(JSON.parse(asText), 'SynthesisResult');
  } catch (err) {
    throw new ExperimentError(
      'INVALID_RESULT',
      `the published synthesis result is not a valid SynthesisResult: ${err instanceof Error ? err.message : String(err)}`,
      { fieldPaths: ['proposal.synthesisResultRef'] }
    );
  }

  // 4. The ref must be a CONTENT address of what was published, not a label.
  if (synthesisResultRef.sha256 !== result.proposalRef.sha256 && synthesisResultRef.sha256 !== hashOf(result)) {
    // The ref may legitimately address either the proposal markdown or the result body; what it
    // must NOT do is address something unrelated. A mismatch here means the caller named a
    // publication by a hash that is not this one.
    throw new ExperimentError(
      'SOURCE_MISMATCH',
      'the synthesisResultRef hash does not address the published synthesis result',
      { fieldPaths: ['proposal.synthesisResultRef.sha256'] }
    );
  }

  // 5. The named candidate must exist in that result.
  const candidate = (result.candidates as ResearchCandidate[]).find((c) => c.id === candidateId);
  if (!candidate) {
    throw new ExperimentError(
      'NOT_FOUND',
      `synthesis result "${synthesisResultRef.id}" publishes no candidate "${candidateId}"`,
      { fieldPaths: ['proposal.candidateId'] }
    );
  }

  // 6. The candidate hash must match what the result published. This is the anti-drift check: a
  //    candidate edited after publication is a different candidate, and re-labelling it here would
  //    make an edited proposal look like a published one.
  if (candidate.candidateHash !== candidateHash) {
    throw new ExperimentError(
      'SOURCE_MISMATCH',
      `candidate "${candidateId}" publishes candidateHash ${candidate.candidateHash.slice(0, 12)}... but the proposal names ${candidateHash.slice(0, 12)}...; a candidate edited after publication is a different candidate`,
      { fieldPaths: ['proposal.candidateHash'] }
    );
  }

  // 7. A rejected or insufficient candidate does not become runnable here.
  if (!EXECUTABLE_ELIGIBLE_DECISIONS.has(candidate.decision)) {
    throw new ExperimentError(
      'MODULE_NOT_READY',
      `candidate "${candidateId}" is ${candidate.decision}; Phase 2 does not re-open a P6 decision. Revising it means publishing a new proposal, not re-reading this one`,
      { fieldPaths: ['proposal.candidateId'] }
    );
  }

  // 8. Re-validate the candidate through the frozen contract. The synthesis result validator
  //    covers its own candidates, but doing it here means a candidate that reached this point
  //    through any other route is held to the same standard.
  const moduleCardRefs = candidate.moduleCardRefs as CardRef[];

  return {
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    taskBriefHash: candidate.taskBriefHash,
    producerOperationId: result.producerOperationId,
    baselineCardRef: candidate.baselineCardRef as CardRef,
    moduleCardRefs,
    decision: candidate.decision,
    mechanismHypothesis: candidate.mechanismHypothesis.value ?? '',
    ablationMatrix: (candidate.ablationMatrix as Array<{ variantId: string; moduleRefs: string[]; status: string }>).map(
      (row) => ({ variantId: row.variantId, moduleRefs: row.moduleRefs, status: row.status })
    ),
  };
}

/** Hash of the result body, used only for the ref-address check above. */
function hashOf(result: SynthesisResult): string {
  return typedHash('phase2-research-proposal', result as unknown as Record<string, unknown>);
}

/**
 * A store backed by the research service's own storage root.
 *
 * `readPublishedResult` is the same accessor the P6/P7 services use to read a `succeeded` result,
 * so this does not re-implement publication lookup or a second opinion on what counts as published.
 */
export function researchStoreFromReader(
  readPublishedResult: (operationId: string) => { status: string; value: unknown } | null
): ResearchPublicationStore {
  return {
    readSynthesisResult(operationId: string) {
      const found = readPublishedResult(operationId);
      return found ? { status: found.status, result: found.value } : null;
    },
  };
}
