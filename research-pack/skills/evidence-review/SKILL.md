---
name: evidence-review
description: Check an external run file and save a self-review. Use when a manifest and metric file return from another session.
---

# Evidence review

Read `../OPERATIONS.md`.

1. `record_experiment_result` with the manifest path inside the workspace. The metric value, unit, row, column and run id must match the file.
2. A null cell stays null. Do not submit 0 in its place.
3. `submit_research_review` uses `self_review` for this single-agent path. `supported` and `contradicted` are rejected unless every cited run is a current, comparable, external observation.
4. A successful process and a supported hypothesis are different states. Mock output cannot support a hypothesis.

A review does not approve the next experiment.
