"""
Module A: ASPP (Atrous Spatial Pyramid Pooling) Residual Feature Block.
Based on DeepLabv3 (Chen et al., arXiv:1706.05587, §3.3).
Maintains tensor shape [B, 8, H, W], dtype float32.
"""

import torch
import torch.nn as nn

class ASPPBlock(nn.Module):
    def __init__(self, channels=8):
        super().__init__()
        self.branch1 = nn.Sequential(
            nn.Conv2d(channels, channels, kernel_size=1, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True)
        )
        self.branch2 = nn.Sequential(
            nn.Conv2d(channels, channels, kernel_size=3, padding=2, dilation=2, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True)
        )
        self.fuse = nn.Sequential(
            nn.Conv2d(channels * 2, channels, kernel_size=1, bias=False),
            nn.BatchNorm2d(channels),
            nn.ReLU(inplace=True)
        )

    def forward(self, x):
        res = x
        b1 = self.branch1(x)
        b2 = self.branch2(x)
        cat = torch.cat([b1, b2], dim=1)
        out = self.fuse(cat)
        return res + out
