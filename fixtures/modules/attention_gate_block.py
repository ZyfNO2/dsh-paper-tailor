"""
Module C: Attention Gate (AG) feature recalibration block.

Mechanism source: the P5 research card `paper-only-v1-module-P002-83368396d7b6`
("attention gate (AG)") published by the real P5 operation
`rop-p5_discover-3b3dc696e35e1390` (archived at
`work/phase2-candidate-2026-10-06/p6-synthesis-result.json` +
`artifacts/paper-only/basic-muvlxwiz/`), and the P6 candidate
`candidate-P002` that binds it.

PROVENANCE, stated exactly as PHASE2-DATA-REQUEST section 1.2 requires:
  this file is THIS REPOSITORY's own implementation of the attention-gate
  mechanism the P5 card describes. It is NOT the upstream authors' code. The
  card records the mechanism claim; this file is a mechanism implementation
  for the frozen CPU segmentation slice, in the same honest shape as
  fixtures/modules/aspp_block.py and se_block.py (see the SourceBundle
  NO-UPSTREAM-CODE item). Nothing here claims to reproduce the paper's
  reported numbers.

Interface: maintains tensor shape [B, 8, H, W], dtype float32 — the profile's
`features.pre_pool` slot output width (slotChannels = 8, pinned in
configs/phase2/profile-registry.json).

Mechanism class: `parameterized_feature`. The gate is learned parameters
applied to a forward feature tensor, which is exactly what the slot's
`allowedModuleKinds` accepts. The P6 card's `interventionAxis` label
(`attention_implementation`) is NOT a Phase 2 mechanism class and is not used
for the check-set choice (PHASE2-SPEC section 4).
"""

import torch
import torch.nn as nn


class AttentionGate(nn.Module):
    """Additive attention gate: conv-1x1 score map, sigmoid, multiplicative gate."""

    def __init__(self, channels=8, gate_channels=4):
        super().__init__()
        # The gate compresses to a small summary width, scores it per pixel, and
        # scales the incoming features. Compression keeps the parameter count in
        # the same order as the other two pinned modules for an honest
        # like-for-like comparison.
        self.score = nn.Sequential(
            nn.Conv2d(channels, gate_channels, kernel_size=1, bias=False),
            nn.BatchNorm2d(gate_channels),
            nn.ReLU(inplace=True),
            nn.Conv2d(gate_channels, 1, kernel_size=1, bias=True),
            nn.Sigmoid(),
        )
        self.norm = nn.BatchNorm2d(channels)

    def forward(self, x):
        if x.shape[1] != self.score[0].in_channels:
            # The slot pins 8 channels; a mismatch is a wiring defect, not a
            # silent reshape. Raising here is what makes a mis-bound module
            # fail loudly instead of pretending to run.
            raise ValueError(
                f"AttentionGate expects {self.score[0].in_channels} input channels, got {x.shape[1]}"
            )
        gate = self.score(x)
        return self.norm(x * gate)
