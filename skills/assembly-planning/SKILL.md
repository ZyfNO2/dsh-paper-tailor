---
name: assembly-planning
description: Plan module assembly recipe for stitch-cpu-v1 baseline and verified modules.
---

# Academic Assembly Planning Skill

Given a baseline model and a set of verified academic modules, plan a valid assembly recipe for the stitch-cpu-v1 protocol.

## Constraints
1. Target Slot: The only available slot in stitch-cpu-v1 is `features.pre_pool`.
2. Module Ordering: When both spatial feature module (ASPP) and channel recalibration module (SE) are bound to `features.pre_pool`, ASPP must precede SE (orderedModuleRefs: ["module-aspp-v1", "module-se-v1"]).
3. Authority: Only select from ready modules with verified source and implementation hashes. Do not invent modules or code.
4. Output format: Return a valid JSON object matching the AssemblyPlan schema:
```json
{
  "id": "plan-stitch-v1",
  "taskRevision": 1,
  "protocolHash": "stitch-cpu-v1-sha256",
  "baselineRef": {
    "id": "baseline-small-conv",
    "revision": 1,
    "sourceHash": "source-conv2d-relu-pool-fc",
    "configHash": "config-8ch-2class-batch4",
    "adapterId": "adapter-cpu-torch"
  },
  "modules": [ ... ],
  "bindings": [
    {
      "slotId": "features.pre_pool",
      "orderedModuleRefs": ["module-aspp-v1", "module-se-v1"]
    }
  ]
}
```
Do not output markdown code blocks or surrounding commentary; return only valid JSON.
