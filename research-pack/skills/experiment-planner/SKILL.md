---
name: experiment-planner
description: Save a draft comparison plan and export an assignment after user approval. Use when a candidate is ready to test.
---

# Experiment planner

Read `../OPERATIONS.md`.

These plan/assignment steps also work in a Bootstrap workspace when the user has selected a source-linked native general idea. Obtain its actual ideaId and Bootstrap revision through workspace queries; do not initialize a parallel prototype project. Approval remains a real user CLI/HTTP action. Native candidate/Wiki creation uses workspace actions.

1. `create_experiment_plan` with baseline, the one variable, fixed conditions, split, seed policy, metric and unit, budget, and stop condition.
2. Leave the plan in `draft`. This skill cannot approve it.
3. After the user records an `export_assignment` approval bound to the plan hash, call `export_assignment`.
4. The exported task is `self_review`. Do not describe it as an independent review.
5. Read `get_assignment` and pass its full plan, source pins, constraints, instructions and manifest template to the external agent. Fill template fields with observed values only after actual execution.

The assignment pins the plan hash. Editing the plan later makes a new export necessary.
