"""
Module B: SE (Squeeze-and-Excitation) Channel Attention Recalibration Block.
Based on SENet (Hu et al., arXiv:1709.01507, §III).
Channels: 8 -> 4 -> 8 (reduction ratio 2).
Maintains tensor shape [B, 8, H, W], dtype float32.
"""

import torch
import torch.nn as nn

class SEBlock(nn.Module):
    def __init__(self, channels=8, reduction=2):
        super().__init__()
        mid = channels // reduction
        self.pool = nn.AdaptiveAvgPool2d((1, 1))
        self.fc = nn.Sequential(
            nn.Linear(channels, mid, bias=False),
            nn.ReLU(inplace=True),
            nn.Linear(mid, channels, bias=False),
            nn.Sigmoid()
        )

    def forward(self, x):
        b, c, _, _ = x.shape
        w = self.pool(x).view(b, c)
        w = self.fc(w).view(b, c, 1, 1)
        return x * w
