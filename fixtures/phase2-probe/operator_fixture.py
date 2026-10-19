"""
Parameter-free operator fixtures for the Phase 2 mechanism probe.

Spec row: docs/mvp/phases/PHASE2-SPEC.md section 4, "无参数算子/注意力实现替换".

The DECLARED operator is a masked channel mean:

    y[b, 0, h, w] = mean_c( x[b, c, h, w] ) * mask[b, 0, h, w]

    x    : [B, C, H, W] float32
    mask : [B, 1, H, W] float32, values in {0, 1}; 0 means "not valid here"

All three implementations below are parameter-free and shape-preserving. They differ only in how
faithfully the candidate reproduces the declared operator. This module never decides whether a
difference is acceptable: the probe measures the numbers and the host check engine owns the
tolerances.
"""

import torch
import torch.nn as nn


class MaskedChannelMeanReference(nn.Module):
    """The declared operator, written the obvious way. This is the reference implementation."""

    def forward(self, x, mask):
        return x.mean(dim=1, keepdim=True) * mask


class MaskedChannelMeanEquivalent(nn.Module):
    """A different code path that computes the SAME operator.

    Sum-then-divide instead of ``mean()``, and the mask multiplies the reduced tensor instead of
    each channel. Float32 rounding can make this near-identical rather than bit-identical, which is
    exactly what a reference tolerance exists for. A correct equivalence check must ACCEPT this.
    """

    def forward(self, x, mask):
        channels = x.shape[1]
        return (x * mask).sum(dim=1, keepdim=True) / float(channels)


class ChannelMeanMaskDropped(nn.Module):
    """NOT the declared operator: it changes the output but never reads the mask.

    This is the "只检查输出变化不充分" case. A check that only asks "did the output change?"
    passes this implementation, because the output does change wherever mask == 0. A reference
    equivalence check and a mask-boundary check must both reject it.
    """

    def forward(self, x, mask):
        return x.mean(dim=1, keepdim=True)


class MaskedChannelMeanFloat64(nn.Module):
    """The declared operator computed through a float64 intermediate.

    Mathematically identical to the reference; the only difference is float32 rounding. This is the
    case a reference tolerance exists for: it must PASS, and it proves the tolerance is not a
    vacuous "must be bit-identical" rule.
    """

    def forward(self, x, mask):
        return (x.double().mean(dim=1, keepdim=True) * mask.double()).float()


class MaskedChannelMeanApproximate(nn.Module):
    """A deliberate approximation: the declared operator plus a systematic 5e-3 offset.

    Same shape, same mask handling, still "close" by eye. It must FAIL the reference tolerance,
    which is what makes the tolerance a two-sided, non-vacuous number rather than a formality.
    """

    def forward(self, x, mask):
        return x.mean(dim=1, keepdim=True) * mask + 5e-3


OPERATOR_FIXTURES = {
    'reference': MaskedChannelMeanReference,
    'equivalent': MaskedChannelMeanEquivalent,
    'float64_equivalent': MaskedChannelMeanFloat64,
    'approximate': MaskedChannelMeanApproximate,
    'mask_dropped': ChannelMeanMaskDropped,
}
