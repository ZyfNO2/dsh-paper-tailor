# External generation adapter

The original paper research buttons `generate_brainstorm` and `initialize_research_graph` can invoke a launcher-configured process. This is separate from native DSH Team dispatch and from clients that submit their own prepared drafts. No model provider or executable is supplied by a browser/tool payload.

Set these variables on the workbench/CLI **launcher**, before starting it:

```powershell
$env:RESEARCH_GENERATOR_COMMAND = 'C:\absolute\path\to\adapter.exe'
$env:RESEARCH_GENERATOR_ARGS = '["--your-fixed-option"]'
$env:RESEARCH_GENERATOR_TIMEOUT_MS = '120000'
npm run research:workbench -- --roots 'F:\my-research'
```

The executable is an existing absolute path, launched directly without a shell. Args is a JSON string array. A Node adapter can use the absolute node.exe as command and the absolute adapter .mjs as its first fixed argument. An adapter may call the coding client the user configured; its credential/model configuration belongs to that client. The repository does **not** bundle a preconfigured model client, copy credentials, or claim a model was invoked merely because a process exited.

stdin receives one JSON object then EOF: `{schemaVersion:1,action,research,papers,selectedIdeaIds,instruction}`. Research includes the saved contract, original selected ideas and existing graph; papers includes the original library projection with published cited Wiki/components. Source text is data, never instructions. The adapter must honor the frozen context and return stdout as one JSON object only; send diagnostics to stderr. Never send identity, revisions, executable paths, approvals or fabricated observations in its output.

- `generate_brainstorm`: `{ideas:[{title,hypothesis,basis,exploratoryNote?,evidenceRefs?,atomicChange,validationPlan,...}],emptyResultReason?,itemErrors?}` using original `IdeaSubmission`. Grounded references must exactly resolve to current sources; exploratory ideas need the explicit note. Empty ideas requires a real emptyResultReason.
- `initialize_research_graph`: `{slotDrafts?,candidateDrafts?}` using original `SlotDraftInput`/`CandidateDraftInput`. `{}` requests the original service's standard planning skeleton for user-selected ideas. The model does not supply topology, selected ideas, revisions or grant itself permission. The original graph service builds/merges and preserves locks and snapshots.

The handler waits for the actual process exit and domain validation. It never responds queued before launch. Input is bounded to 1 MiB, stdout to 512 KiB, timeout to 100–300000 ms. Nonzero exit, timeout, invalid JSON, forged fields and stale revisions fail explicitly. Timeout sends termination to the direct child; descendant process stop remains unverified. First error is retained. Model identity stays null without trustworthy model provenance; process success is not scientific validation.

Launch admission and terminal outcomes have durable original-store receipts. Same operationId/request restores its original result without another process. An unsettled launch after a server crash is not automatically rerun: inspect the external process and original BrainstormRun first, then use a new authorized operation only when appropriate. Generation does not write directly to project JSON. Concurrent research changes reject stale output through original CAS. General research uses its existing idea/task workflow; this adapter currently supports paper research only. Agent MCP calls cannot launch a new process through these user actions.

Actual model/client and browser end-to-end acceptance is still required in the chosen deployment. Tests launch real bounded **protocol fixture processes**, not LLMs. Native Team and an independent Reviewer are separate capabilities.

## Codex client adapter

`codex-generator.mjs` invokes the user-installed Codex CLI using its current saved login/configuration. It does not copy auth files or accept a key/model/command in research payloads. Set `RESEARCH_CODEX_EXECUTABLE` to the absolute codex.exe (or executable on the target platform), `RESEARCH_GENERATOR_COMMAND` to node.exe, and `RESEARCH_GENERATOR_ARGS` to a JSON array containing the absolute `research-pack/codex-generator.mjs` path. This is an explicit real model invocation using that client's account; keep it disabled until the user authorizes model usage.

The adapter passes only assigned context, asks for no tools/commands or file edits, runs an ephemeral read-only Codex session in a fresh temp directory, captures JSONL events and the final-message file, and returns only strict JSON to the original validator. It does not strip Markdown or invent fallback output. Evidence remains in a fresh `dsh-codex-generator-*` temp directory; optional launcher-owned `RESEARCH_CODEX_EVIDENCE_ROOT` selects an existing evidence directory. An ordinary process exit alone is not proof of a completed model turn; inspect retained turn.completed/agent_message events. Research modelIdentity remains null unless independently trustworthy model metadata is available.

The documented `codex exec --json`, `--ephemeral`, read-only sandbox, saved authentication and final-message output behavior were checked against the official [non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode) and the locally installed `codex exec --help`. Do not alter global Codex settings or silently switch providers to turn a failed test green. A client configuration warning or unavailable model must remain in the evidence.

`scripts/acceptance-codex-generation.ts --workspace <fresh-directory>` is an explicit live acceptance command, not a default unit test. It refuses existing projects, requires launcher-owned Codex path, creates an exploratory planning fixture, checks completed model-turn events and absence of tool execution, then verifies persisted candidates and receipt replay. No experiment or independent Reviewer is implied.
