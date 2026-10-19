---
name: research-synthesis
description: Judge mechanism-only compatibility over published research cards and compose paper-only-v1 candidates with planned ablation designs.
---

# Research Synthesis Skill

Given one `ResearchTaskBrief` and the cards it allows, produce compatibility assessments
and candidate designs. Output strict JSON: `{ "candidates": [ ... ] }`.

## Inputs are the only authority

- Every card is already validated against its paper. Treat the card plus the TaskBrief as
  the whole evidence base. Do not assume anything about a paper the card does not state.
- The TaskBrief constraints come from the user or a trusted driver. Never rewrite them,
  and never treat an unstated condition as satisfied.

## Decisions

| Mechanism judgement | Candidate decision |
| --- | --- |
| `compatible` | `proposed` |
| `conditionally_compatible` | `conditional` |
| `reject_for_mvp` | `rejected` |
| `insufficient_evidence` | `insufficient_evidence` |

A decision follows from the judgement; it is never set from a score or from preference.

Reason codes (closed vocabulary): `TASK_MISMATCH`, `REQUIRED_OPERATOR_ABSENT`,
`REQUIRED_TARGET_ABSENT`, `SCOPE_EXCLUDED`, `MECHANISM_CONFLICT`, `CONDITION_UNRESOLVED`,
`EVIDENCE_MISSING`, `DISTINCT_INTERVENTION_AXES`, `SOURCE_SUPPORTED_COMPOSITION`.

Order of reasoning: a well-evidenced scope exclusion or mechanism conflict rejects;
otherwise, if key information is missing and no concrete condition can be stated, return
`insufficient_evidence`; otherwise, if a concrete condition is open, return
`conditionally_compatible`; otherwise `compatible`.

- `REQUIRED_OPERATOR_ABSENT` needs a stated absence in the baseline material or the task
  constraints. "The abstract does not mention it" is not absence.
- An unknown condition may never be upgraded to `compatible`.
- A rejection is scoped to this task and this mechanism. Never claim the method can never
  work anywhere.
- Do not assert both a known conflict and `compatible`.

## Bindings and requirements

- Bind each module conceptually: feature path, supervision target, parameterization, or
  operator implementation. Copy the axis from the card; changing an axis requires a new
  upstream card revision, not a rewrite here.
- A loss is a relationship between predictions and training targets, not an extra layer
  wired into the inference path.
- Never invent channels, dtypes, tensor shapes, or code slots. Interface status stays
  `NOT_VERIFIED`.
- Each requirement is `{id, category, description, resolution, basisRefs}` with a category
  from the published vocabulary. `resolution` describes the design premise; it never means
  code passed.

## Numbers

- `mechanismHypothesis` is always a hypothesis for a new combination. `expectedEffects`
  state direction and mechanism only, never a predicted metric value.
- Quote a source-reported number only with its dataset, split, configuration, and
  comparability. Two papers' gains are never added, and equal metric names do not make
  them comparable.
- Every candidate keeps `performanceStatus: NOT_VERIFIED`.

## Experiments

- The Host generates the matrix from the module set: one module gives baseline and A; two
  give baseline, A, B, AB; three give the fixed eight rows. Never hand-write or shrink it.
- Every row is `planned` with dataset, split, seeds, budget, and metric marked to be
  frozen. Define validation questions only; do not run, download, or train anything.

## Cards and dedup

- A module card whose axis or mechanism is unknown cannot be bound. Report the gap instead
  of filling it in.
- Two candidates with the same task, card versions, module set, and bindings are one
  candidate. Emit it once.
