---
name: paper-decomposer
description: Turn an imported source into method and evaluation cards with locations. Use after a paper or note is in the project.
---

# Paper decomposer

Read `../OPERATIONS.md`.

1. `import_material` the source, then keep its `sourceId` and sha256.
2. Separate a quote that is in the file from an inference. Inferences go in `unknowns` or the card body, not in the quote.
3. Call `read_paper` and check its coverage. For verified text, call `upsert_knowledge` to save `method` and `evaluation` cards with `citations: [{sourceId, sha256, startByte, endByte, quote}]`. Offsets are UTF-8 bytes, not character indices. Save `unknowns` explicitly; an unconfigured PDF parser stays a gap.
4. If a table cell cannot be read, leave the value unknown. Do not fill it in.

A card is not an experiment plan.
