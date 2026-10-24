---
name: novelty-review
description: Compare a candidate with retrieved work and record coverage gaps. Use before calling a candidate new.
---

# Novelty review

Read `../OPERATIONS.md`.

1. Call `search_papers` and keep the query.
2. If the result is `search_incomplete`, say the comparison is unfinished.
3. Write overlap or difference only for items that were actually returned.
4. Do not use "proven original" as a status.

A failed earlier branch stays searchable. It fails under its recorded data, budget and implementation, not for every future use of the mechanism.
