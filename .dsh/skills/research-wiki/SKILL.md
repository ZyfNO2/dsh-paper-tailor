---
name: research-wiki
description: Search the task-scoped, host-pinned text library and publish provisional evidence-linked Wiki revisions.
---

# Research Wiki (K-min)

Use only the `evolver_*_knowledge` tools that are present in the current DSH session. The Host's library configuration defines the allowed task, sources, scopes, limits and policy. If these tools are absent, explain that the Wiki capability is not enabled in this Host.

## Workflow

1. Call `evolver_import_knowledge_sources` with a new stable `commandId` only when the task explicitly asks to import/refresh the configured source set. The source list is host-pinned; do not fetch URLs or submit filesystem paths.
2. Call `evolver_build_knowledge_snapshot`, then `evolver_retrieve_evidence` against that exact snapshot. Keep the supplied `snapshotRef`, `chunkRef`, source identity, paragraph and byte locator together.
3. If evidence is missing or was omitted by the context limit, report the gap as unknown. Do not fill it from model memory.
4. To publish a page, send structured claims to `evolver_update_wiki` with the EvidencePack ref and each claim's chunk refs. The Host compiles Markdown. Use `source_reported` only for what a cited source says; use `inferred` only with a concise `derivationText` and cited source refs. Do not label a source's reported value as a local result.
5. Use `local_observation` only when the Host accepts a verified trial ref and its conditions ref. If rejected, leave the observation absent and note the missing RG-C evidence.
6. On a CAS conflict, read the latest page and reconcile the claims; never replace a page with a stale base revision. Use `evolver_lint_knowledge` to report missing, stale, unsupported, conflicted or broken dependencies.

## Required wording and scope

- Every page is **provisional** until a human reviews the semantics. Structural citations only prove that the cited chunk belongs to the pack.
- The current `attention-modules-dev-v1` seed uses provisional abstract excerpts for internal development. Do not reproduce excluded abstract text, infer page numbers, claim full-paper review, or distribute the derived pages externally.
- Separate source-reported experiment descriptions from locally measured observations. Local measurements require verified trial and condition refs; failures remain diagnostics.
- The index is keyword-only. A match score is relevance for retrieval, not factual confidence, method compatibility or experimental benefit.
- Query and page access must remain within the task and usage scope named by the Host. Do not probe another task, source root, gold/sealed data or final-test material.
