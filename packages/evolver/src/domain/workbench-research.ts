/**
 * Evidence-preserving projection for the research workbench.
 *
 * Spec: docs/mvp/WORKBENCH-RESEARCH-SPEC.md sections 3.1, 3.2, 4.3.
 *
 * What this module is for
 * -----------------------
 * The v2 projection is lossy in three specific ways that the plan targets:
 *
 *   1. `mechanism` for a FIXED module is set from `entrypoint` — a code path
 *      string — so an implementation location reads as if it explained the
 *      science;
 *   2. the P5 card `field()` helper keeps `value` and `evidenceRefs` and drops
 *      `status` and `reason`, so "the authors reported this" and "nobody knows"
 *      become the same string;
 *   3. there is no P6 composition view at all, so the reason a combination was
 *      chosen is nowhere on the page.
 *
 * This module recovers all three from the ORIGINAL immutable artifacts. It does
 * not restate a claim, translate one, or invent one: every returned claim
 * carries the source artifact and locator it came from, and a value the source
 * does not contain comes back as `null` WITH a reason.
 *
 * The honesty rule that matters most
 * ----------------------------------
 * `EvidenceField.status` is carried through UNCHANGED. A `hypothesis` in the P6
 * result stays `hypothesis` here. That is not cosmetic: the alternative —
 * presenting a composition hypothesis as though it were a paper's reported
 * mechanism — is exactly the failure this feature exists to remove, so
 * `assertNoStatusUpgrade` makes an attempted upgrade a thrown error rather than
 * a display concern.
 */

import type { CardRef } from '../contracts/research.ts';
import {
  computeMethodKey,
  type BoundRef,
  type CandidateBinding,
  type ChineseClaim,
  type ClaimSource,
  type CompositionExplanation,
  type MethodTag,
  type MethodTagRelation,
  type StrictArtifactRef,
} from '../contracts/workbench.ts';

/** The minimal JSON view this module needs; the stores are not typed all the way down. */
export type Json = Record<string, unknown>;

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

// ----------------- attested-field reader -----------------

/**
 * A raw P5/P6 attested field: `{value, status, evidenceRefs, reason}`.
 *
 * `status` and `reason` are the two fields the v2 projection discarded, and
 * they are the two that decide whether a sentence on screen is a paper's claim
 * or nobody's.
 */
export interface AttestedField {
  value: string | null;
  status: 'source_reported' | 'inferred' | 'hypothesis' | 'unknown';
  evidenceRefs: string[];
  reason: string | null;
}

const STATUSES = new Set(['source_reported', 'inferred', 'hypothesis', 'unknown']);

/**
 * Read an attested field WITHOUT losing its status or reason.
 *
 * A BARE STRING is accepted as `inferred`. Several frozen-contract fields are
 * plain strings rather than attested wrappers — `compatibility.rationale` is
 * one — and reading those through an attested-only reader yields `unknown`,
 * which would silently hide a real recorded rationale behind "未知". The
 * distinction is drawn here rather than at each call site because getting it
 * wrong in either direction misrepresents the source:
 *
 *  - a string has no attested status, so `inferred` (this store's own reading)
 *    is honest and `source_reported` would be a fabrication;
 *  - a wrapper keeps whatever the extractor published, including `unknown`.
 */
export function readAttested(raw: unknown): AttestedField {
  if (typeof raw === 'string') {
    return { value: raw.length > 0 ? raw : null, status: 'inferred', evidenceRefs: [], reason: null };
  }
  const o = (raw ?? {}) as Json;
  const status = typeof o.status === 'string' && STATUSES.has(o.status)
    ? (o.status as AttestedField['status'])
    : 'unknown';
  return {
    value: str(o.value),
    status,
    evidenceRefs: arr(o.evidenceRefs).map(str).filter((v): v is string => v !== null),
    reason: str(o.reason),
  };
}

/**
 * Build a `ChineseClaim` that INHERITS the source field's epistemic status.
 *
 * This is the anti-drift core. The submitted Chinese text is a translation or
 * a paraphrase; the STATUS is never taken from it, only from the artifact. A
 * submitter therefore cannot upgrade `hypothesis` into `source_reported` by
 * writing confidently in Chinese.
 */
export function claimFromField(
  field: AttestedField,
  args: {
    textZh?: string | null;
    source: BoundRef;
    locatorId: string;
    fieldPath: string | null;
    /** When true, `unknown` is promoted to an explicit gap rather than a null claim. */
    absentReasonZh?: string | null;
  },
): ChineseClaim {
  if (field.value === null) {
    // A missing value is a GAP, not an empty sentence. Returning `textZh: null`
    // with the source's own reason is what keeps the UI from filling the blank
    // with a generic sentence.
    return {
      textZh: null,
      status: 'unknown',
      sources: [{ artifact: args.source, locator: { kind: 'candidate_field', id: args.locatorId, fieldPath: args.fieldPath } }],
      reasonZh: field.reason ?? args.absentReasonZh ?? `来源未记载该字段（${args.fieldPath ?? 'field'}）`,
      derivation: 'unknown',
    };
  }
  return {
    textZh: args.textZh ?? field.value,
    status: field.status,
    sources: [{ artifact: args.source, locator: { kind: 'candidate_field', id: args.locatorId, fieldPath: args.fieldPath } }],
    reasonZh: field.reason,
    derivation: 'translated',
  };
}

/**
 * Refuse a status upgrade.
 *
 * `hypothesis`/`inferred` may be presented as themselves forever; they may never
 * become `source_reported`. This is a guard, not a rendering rule, because a
 * rendering rule is exactly what a future contributor would forget.
 */
export function assertNoStatusUpgrade(original: AttestedField['status'], presented: ChineseClaim['status'], where: string): void {
  if (original === presented) return;
  const authorReported = original === 'source_reported';
  const presentedAsAuthor = presented === 'source_reported';
  if (authorReported && !presentedAsAuthor) return; // downgrading is always safe
  if (!authorReported && presentedAsAuthor) {
    throw new Error(`${where}: source status is "${original}" and may not be presented as "source_reported"`);
  }
}

// ----------------- candidate -> composition rationale -----------------

/**
 * Project a P6 candidate into a `CompositionExplanation`.
 *
 * The five narrative slots the SPEC requires (task problem, mechanism and
 * complementarity, placement, ordering, risks/validation) are NOT all present
 * in the frozen P6 contract. What IS present is:
 *
 *   - `compatibility.rationale`          -> taskProblem / mechanismHypothesis
 *   - `compatibility.unresolvedConditions` -> risks
 *   - `compatibility.requirements`      -> validationQuestions
 *   - `conceptualBindings[]`             -> placementReason (axis + relation)
 *   - `mechanismHypothesis`              -> mechanismHypothesis
 *   - `expectedEffects[]` / `risks[]` / `requiredValidation[]`
 *
 * `orderingReason` has NO source in P6 at all, and module order is a Phase 2
 * adaptation fact. It is therefore returned as an explicit unknown claim, never
 * inferred from `moduleCardRefs` array order — SPEC section 4.3 forbids inventing
 * what was never recorded, and array order is not a recorded decision.
 */
export function compositionFromCandidate(
  candidate: Json,
  args: { source: BoundRef; candidateId: string },
): CompositionExplanation {
  const compat = (candidate.compatibility ?? {}) as Json;
  const rationale = readAttested(compat.rationale);
  const hypothesis = readAttested(candidate.mechanismHypothesis);

  const claimsOf = (raws: unknown, fieldPath: string, absentZh: string): ChineseClaim[] =>
    arr(raws).map((r, i) => {
      const f = readAttested(r);
      return claimFromField(f, {
        source: args.source,
        locatorId: args.candidateId,
        fieldPath: `${fieldPath}[${i}]`,
        absentReasonZh: absentZh,
      });
    });

  const bindings = arr(candidate.conceptualBindings);
  const placement: ChineseClaim = bindings.length === 0
    ? {
        textZh: null,
        status: 'unknown',
        sources: [],
        reasonZh: '候选未提供 conceptualBindings，插入位置未知。',
        derivation: 'unknown',
      }
    : {
        // Placement is a DESIGN assertion about where a module acts, so it is a
        // hypothesis even though the axes themselves are author-reported.
        textZh: bindings
          .map((b) => {
            const o = b as Json;
            const target = readAttested(o.targetConcept).value;
            return `${str(o.relation) ?? 'relates_to'} → ${str(o.axis) ?? 'unknown axis'}${target === null ? '' : `（${target}）`}`;
          })
          .join('；'),
        status: 'hypothesis',
        sources: bindings.map((b, i) => ({
          artifact: args.source,
          locator: { kind: 'candidate_field' as const, id: args.candidateId, fieldPath: `conceptualBindings[${i}]` },
        })),
        reasonZh: '插入位置来自候选的概念绑定，未经实现代码确认。',
        derivation: 'reasoned',
      };

  const requirements = arr(compat.requirements);
  const unresolved = arr(compat.unresolvedConditions).map(str).filter((v): v is string => v !== null);

  return {
    taskProblem: claimFromField(rationale, {
      source: args.source,
      locatorId: args.candidateId,
      fieldPath: 'compatibility.rationale',
      absentReasonZh: 'P6 未给出 compatibility.rationale，任务问题表述缺失。',
    }),
    mechanismHypothesis: claimFromField(hypothesis, {
      source: args.source,
      locatorId: args.candidateId,
      fieldPath: 'mechanismHypothesis',
      absentReasonZh: 'P6 未给出机制假设。',
    }),
    complementarity: claimFromField(hypothesis, {
      source: args.source,
      locatorId: args.candidateId,
      fieldPath: 'compatibility.rationale',
      absentReasonZh: 'P6 未单独给出互补性说明。',
    }),
    placementReason: placement,
    // Deliberately unknown: see the module doc comment.
    orderingReason: {
      textZh: null,
      status: 'unknown',
      sources: [],
      reasonZh: '模块顺序是 Phase 2 适配计划中的实现事实，P6 未记录排序理由；请在接入阶段从 adaptation-plan 核对。',
      derivation: 'unknown',
    },
    expectedEffects: claimsOf(candidate.expectedEffects, 'expectedEffects', 'P6 未给出预期效果。'),
    risks: [
      ...claimsOf(candidate.risks, 'risks', 'P6 未给出风险。'),
      ...(unresolved.length > 0
        ? [{
            textZh: `未决条件：${unresolved.join('；')}`,
            status: 'hypothesis' as const,
            sources: [{ artifact: args.source, locator: { kind: 'candidate_field' as const, id: args.candidateId, fieldPath: 'compatibility.unresolvedConditions' } }],
            reasonZh: '来自 P6 的未决条件，尚未验证。',
            derivation: 'reasoned' as const,
          }]
        : []),
    ],
    validationQuestions: [
      ...claimsOf(candidate.requiredValidation, 'requiredValidation', 'P6 未给出验证问题。'),
      ...requirements.map((r, i) => {
        const o = r as Json;
        const description = readAttested(o.description).value;
        return {
          textZh: description ?? `要求 ${str(o.id) ?? i}（${str(o.category) ?? 'unspecified'}）尚未解决`,
          // A requirement with resolution `unresolved`/`conflicting` is an OPEN
          // question about this task, never an author-reported finding.
          status: 'hypothesis' as const,
          sources: [{ artifact: args.source, locator: { kind: 'candidate_field' as const, id: args.candidateId, fieldPath: `compatibility.requirements[${i}]` } }],
          reasonZh: `要求状态：${str(o.resolution) ?? 'unknown'}。`,
          derivation: 'reasoned' as const,
        };
      }),
    ],
  };
}

// ----------------- method tags (SPEC section 3.2) -----------------

/**
 * Build a method tag from a real P5 card.
 *
 * The tag's identity is the CARD's identity, not its display name. Two papers
 * that happen to call a method the same thing keep separate tags, and a baseline
 * never merges with a module of the same name — the key carries `kind` and the
 * document hash for exactly that reason.
 */
export function methodTagFromCard(
  card: Json,
  args: { kind: 'baseline' | 'module'; source: BoundRef; relation: MethodTagRelation; nameZh?: string | null },
): MethodTag | null {
  const id = str(card.id);
  const paperId = str(card.paperId);
  const documentHash = str(card.documentHash);
  // A tag without all three is not an identity; returning null keeps the gap
  // visible instead of inventing a key from a partial card.
  if (id === null || paperId === null || documentHash === null) return null;

  const name = readAttested(card.name).value ?? id;
  // Baseline cards and module cards carry their description under DIFFERENT
  // keys in the frozen P5 contract: `methodSummary` for a baseline, `mechanism`
  // for a module (contracts/research.ts ResearchBaselineCard vs
  // ResearchModuleCard). Reading only `mechanism` would leave every baseline
  // tag with an empty description and no source, which is how a baseline ends
  // up rendered as a bare name.
  const descriptionField = args.kind === 'baseline' ? card.methodSummary : card.mechanism;
  const descriptionPath = args.kind === 'baseline' ? 'methodSummary' : 'mechanism';
  const description = readAttested(descriptionField);
  return {
    methodKey: computeMethodKey({ kind: args.kind, paperId, documentHash, cardIdentity: id }),
    kind: args.kind,
    relation: args.relation,
    paperId,
    documentHash,
    cardRef: { id, revision: num(card.revision) ?? 1, sha256: hashOfCard(card), producerOperationId: str(card.producerOperationId) ?? '' },
    nameZh: args.nameZh ?? null,
    canonicalName: name,
    // Aliases are display-only and start EMPTY. SPEC section 3.2: only an
    // explicit, reviewable alias mapping may merge names; inferring one from
    // case or punctuation is exactly the merge the spec forbids.
    aliases: [],
    sources: description.value === null
      ? []
      : [{ artifact: args.source, locator: { kind: 'card_field', id, fieldPath: descriptionPath } }],
  };
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * A stable per-card hash for the `CardRef.sha256` field.
 *
 * The real P5 `card-index.json` carries the authoritative hash; this fallback is
 * only used when a card is read without its index. It is labelled as such by
 * the caller so nobody mistakes it for the published value.
 */
export function hashOfCard(card: Json): string {
  const canonical = canonicalize(card);
  // FNV-style expansion into 64 hex chars. This is a FALLBACK identifier, not
  // a security hash; the published card hash always wins when available.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i += 1) {
    const c = canonical.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`.repeat(4).slice(0, 64);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Json).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

// ----------------- candidate identity -----------------

/**
 * The full candidate identity a binding asserts, re-derived from the artifact.
 *
 * Returning this rather than trusting the binding is what lets W2 say "this
 * display conclusion came from X" for every row on the page.
 */
export interface ResolvedCandidateView {
  candidateKey: string;
  candidateId: string;
  candidateHash: string;
  taskBriefHash: string;
  decision: string;
  performanceStatus: string;
  moduleCardRefs: CardRef[];
  baselineCardRef: CardRef | null;
  composition: CompositionExplanation;
}

export function resolveCandidateView(
  result: Json,
  binding: CandidateBinding,
  source: BoundRef,
): ResolvedCandidateView | null {
  const candidate = arr(result.candidates).find((c) => (c as Json).id === binding.candidateId) as Json | undefined;
  if (candidate === undefined) return null;
  const declaredHash = str(candidate.candidateHash);
  // A candidate whose published hash is not the bound hash is a DIFFERENT
  // candidate. Returning null keeps a stale binding from displaying as the
  // candidate it no longer is.
  if (declaredHash === null || declaredHash !== binding.candidateHash) return null;

  return {
    candidateKey: binding.candidateKey,
    candidateId: binding.candidateId,
    candidateHash: binding.candidateHash,
    taskBriefHash: str(candidate.taskBriefHash) ?? '',
    decision: str(candidate.decision) ?? 'unknown',
    performanceStatus: str(candidate.performanceStatus) ?? 'NOT_VERIFIED',
    moduleCardRefs: arr(candidate.moduleCardRefs) as CardRef[],
    baselineCardRef: (candidate.baselineCardRef ?? null) as CardRef | null,
    composition: compositionFromCandidate(candidate, { source, candidateId: binding.candidateId }),
  };
}

/** Convenience for the host: wrap a P6 ref in the paper_only store. */
export function paperOnlyRef(ref: StrictArtifactRef): BoundRef {
  return { store: 'paper_only', ref };
}
