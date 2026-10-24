---
name: dsh-research
description: Maintain a local DSH research workspace through its standalone MCP server, with exact source references, explicit human approvals and honest execution/review labels.
---

# DSH research workspace

Read `skills/OPERATIONS.md` first. Call `get_research_context` to determine the authority before choosing tools; do not edit research JSON directly.

For an active Bootstrap workspace, use `paper_query` / `paper_action` for original paper text and cited Wiki/components; `workspace_query` / `workspace_action` for general research and DAG drafts; `foundation_query` / `foundation_action` for protocols, located observations and configured literature search. Human confirmation, eligibility decisions, source access and execution cannot be delegated by changing payload fields. A save is not a run.

For an unmigrated prototype, the older tools and the focused guides under `skills/` remain available. Never mix prototype writes with the active Bootstrap store. Imported histories, simulations and `self_review` must retain their labels. If an action needs a native Agent lifecycle that is not connected, report the unavailable capability; never fabricate queued tasks, role members or independent reviews.

For a user-authorized external round, read `skills/EXTERNAL-HANDOFF.md`. `cycle_query` and `external_cycle_action` expose pinned role assignments and real artifact submission. No model starts automatically, and all such reviews remain self_review.

When the human explicitly chooses the installed Codex client for real model execution, `<runtime>/research-pack/codex-role.mjs` can carry one authorized ready role through these MCP tools. It does not prepare or approve a run. Use its stable launcher client ID for reconnects and retain actual model trace evidence.
