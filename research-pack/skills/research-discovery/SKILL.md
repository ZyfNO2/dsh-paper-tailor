---
name: research-discovery
description: Turn a user goal and local materials into a sourced brief. Use when a research project is starting or a material gap is still open.
---

# Research discovery

Read `../OPERATIONS.md` before calling a tool.

1. `get_research_context` for the current revision.
2. Import only files the user placed in the workspace.
3. Use `read_paper` and `upsert_knowledge` to save a `brief` knowledge card with exact source quotes and byte locations. List unresolved information in `unknowns`; do not invent values.
4. `search_papers` only for a gap. `search_incomplete` means the search did not finish. Do not write that nothing similar exists.

Do not select an idea or approve a plan in this skill.
