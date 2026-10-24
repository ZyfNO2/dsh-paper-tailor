---
name: idea-generator
description: Save a sourced, falsifiable candidate. Use when a brief and at least one source already exist.
---

# Idea generator

Read `../OPERATIONS.md`.

Call `create_research_idea` with a hypothesis, the concrete change, why it might work, and the experiment that could refute it. `sourceIds` must already exist. Status stays `candidate`. Saving an idea does not select it.

Default to at most three candidates when the user did not ask for a number.
