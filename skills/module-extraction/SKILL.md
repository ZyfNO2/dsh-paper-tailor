---
name: module-extraction
description: Extract proposed academic module cards from verified paper snapshots and source references for stitch-cpu-v1.
---

# Academic Module Extraction Skill

This skill extracts proposed ModuleCard definitions from verified paper evidence snapshots.

## Rules & Constraints
1. Identity: Must reference verified SourceRef containing paperId, sourceUri, documentArtifactId, documentHash, locator, and excerptHash.
2. Authority: The LLM model may ONLY output cards with `status: "proposed"`. The Host is the sole authority for validating and granting `status: "ready"`. Never set `status: "ready"`.
3. Mechanism Diversity: Distinct modules must originate from different mechanism classes (e.g., spatial pyramid pooling vs channel attention).
4. Contracts: Must strictly define tensor shape [4, 8, 16, 16], dtype float32, and allowedSlots ["features.pre_pool"].
5. Output: Output must be strict JSON matching the ModuleCard schema.
