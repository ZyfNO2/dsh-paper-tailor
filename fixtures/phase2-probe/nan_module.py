"""
A parameterized, shape-preserving feature module whose output is not finite.

Spec row: docs/mvp/phases/PHASE2-SPEC.md section 4, "有参数 feature 模块" -- failure verdict "NaN".

The module is attached and really runs, so execution count and gradient presence look healthy.
Only a numerical check can reject it, which is why the probe records finite flags rather than
trusting that a forward pass returned without raising.
"""

import torch
import torch.nn as nn


class NaNScaledBlock(nn.Module):
    """Residual block whose gate multiplies a division by exactly zero."""

    def __init__(self, channels=8):
        super().__init__()
        self.scale = nn.Parameter(torch.ones(1, channels, 1, 1))
        self.gate = nn.Parameter(torch.zeros(1))

    def forward(self, x):
        denom = x.abs().mean() - x.abs().mean()  # exactly 0.0, and differentiable
        return x * self.scale + self.gate * (x / denom)
