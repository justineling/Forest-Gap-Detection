# -*- coding: utf-8 -*-
"""验证 landcover 性能优化前后输出逐像素完全一致（等价性验证）。

对比：scripts/landcover.py（优化后） vs .workbuddy-ai/tmp/landcover_orig.py（git HEAD 原版）
"""
import importlib.util
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


new = load("lc_new", ROOT / "scripts" / "landcover.py")
old = load("lc_orig", ROOT / ".workbuddy-ai" / "tmp" / "landcover_orig.py")

rng = np.random.default_rng(12345)


def make_case(kind: str) -> np.ndarray:
    H = W = 512
    rgb = np.full((H, W, 3), 60, dtype=np.uint8)
    rgb[..., 1] = 90
    if kind in ("bright", "mixed"):
        rgb[100:140, 80:300] = (200, 190, 180)      # 亮白面状（office 候选）
        rgb[300:460, 40:56] = (205, 195, 185)       # 亮白竖条（road 候选）
        rgb[380:392, 20:500] = (198, 188, 178)      # 亮白横线（road 候选）
    if kind in ("water", "mixed"):
        rgb[400:470, 350:470] = (40, 60, 95)        # 蓝块（water 候选）
    if kind in ("noise", "mixed"):
        ys = rng.integers(0, H, 500)
        xs = rng.integers(0, W, 500)
        rgb[ys, xs] = (212, 202, 192)               # 大量小连通域
    return rgb


ok_all = True
for kind in ("bright", "water", "noise", "mixed", "green"):
    rgb = make_case(kind)
    valid = np.ones(rgb.shape[:2], dtype=bool)
    px_m = 0.5
    a = new.detect_unplantable(rgb, valid, px_m)
    b = old.detect_unplantable(rgb, valid, px_m)
    parts = []
    for k in ("road", "water", "office"):
        same = np.array_equal(a[k], b[k])
        ok_all &= same
        parts.append(f"{k}={'一致' if same else '**不一致**'}({int(a[k].sum())}px)")
    print(f"[{kind:<7}] " + "  ".join(parts))

print()
print("等价性验证：" + ("全部逐像素一致 ✓" if ok_all else "存在差异 ✗"))
sys.exit(0 if ok_all else 1)
