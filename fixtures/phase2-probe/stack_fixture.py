"""
Composition fixture for the Phase 2 combination probe.

Spec row: docs/mvp/phases/PHASE2-SPEC.md section 4, "组合".

The stack applies an ordered list of feature modules and then a small head. Both the order and the
head exist in real code, so the probe can MEASURE the execution order and can attribute every
parameter in the composed model to a real owner. Nothing here decides whether an attribution is
acceptable.
"""

import torch
import torch.nn as nn


class FeatureStack(nn.Module):
    """Ordered feature modules followed by a 1x1 head.

    The head is deliberately a real parameter source that no module owns: a combination check must
    be able to see it and ask where it came from.
    """

    def __init__(self, modules=None, channels=8):
        super().__init__()
        self.feature_modules = nn.ModuleList(list(modules or []))
        self.head = nn.Conv2d(channels, channels, kernel_size=1, bias=True)

    def forward(self, x):
        for module in self.feature_modules:
            x = module(x)
        return self.head(x)


def build_stack(classes, channels=8, order=None):
    """Builds a stack from module classes.

    ``order`` lets the host build a deliberate order conflict (declared [A, B] but built [B, A])
    so the combination order check has a real negative case rather than a hypothetical one.
    """
    indices = list(range(len(classes))) if order is None else list(order)
    instances = [classes[i]() for i in indices]
    return FeatureStack(instances, channels=channels), instances
