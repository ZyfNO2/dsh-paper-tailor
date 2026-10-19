"""
Loss-term fixtures for the Phase 2 mechanism probe.

Spec row: docs/mvp/phases/PHASE2-SPEC.md section 4, "loss".

The DECLARED training objective is

    total = cross_entropy(logits, labels, ignore_index=-100) + coefficient * boundary_smoothness(logits)

The auxiliary term is defined here. Whether it is actually added to the total loss, with the
declared coefficient, reduction and ignore-mask semantics, is measured by the probe against a
real backward pass -- never asserted from the presence of this file.
"""

import torch
import torch.nn as nn


class BoundarySmoothnessTerm(nn.Module):
    """The declared auxiliary term: mean squared gap between adjacent class logits.

    ``call_count`` counts real invocations, so "the function is defined but the training path
    never calls it" is an observed number rather than a claim about the source text.
    """

    def __init__(self):
        super().__init__()
        self.call_count = 0

    def forward(self, logits):
        self.call_count += 1
        if logits.shape[1] < 2:
            return torch.zeros((), dtype=logits.dtype, device=logits.device)
        gap = logits[:, 1:] - logits[:, :-1]
        return (gap * gap).mean()


def make_labels(batch_size, ignore_index, ignored_positions):
    """Deterministic label vector that really contains ignored and active positions."""
    labels = torch.tensor([i % 2 for i in range(batch_size)], dtype=torch.long)
    for pos in ignored_positions:
        if 0 <= pos < batch_size:
            labels[pos] = ignore_index
    return labels
