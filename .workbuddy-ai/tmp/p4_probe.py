# -*- coding: utf-8 -*-
"""P4 可行性实验：在不同地物区域上测「树心最近邻 CV」与多尺度纹理，
验证「草地不服从株行距网格」这一判据是否真的可分。"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from grid_prior import detect_tree_centers, _nn_stats  # noqa: E402
from detect import canopy_structural  # noqa: E402
from landcover import _features, _texture_std  # noqa: E402

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
PX_M = 0.03299
SIZE = 1024

# (row, col, 说明)
ZONES = [
    (22343, 23565, "影像中心(密林)"),
    (39932, 21499, "最大连片空地(枯枝)"),
    (40160, 19591, "连片空地(枯枝)"),
    (19350, 5900, "株位空缺区"),
    (40000, 30000, "南部(含水体)"),
    (10000, 10000, "西北"),
    (30000, 40000, "东南"),
    (20000, 20000, "中部偏西南"),
]

ds = rasterio.open(IMG)
print(f"{'区域':<24}{'冠层%':>7}{'树心数':>8}{'最近邻中位m':>12}{'CV':>7}"
      f"{'纹理std中位':>12}{'ExG中位':>9}")
for row, col, label in ZONES:
    r0 = max(0, min(ds.height - SIZE, row - SIZE // 2))
    c0 = max(0, min(ds.width - SIZE, col - SIZE // 2))
    data = ds.read(window=Window(c0, r0, SIZE, SIZE), out_dtype="uint8")
    rgb = np.transpose(data[:3], (1, 2, 0))
    valid = ~np.all(data[:3] == 0, axis=0)
    if valid.mean() < 0.3:
        print(f"{label:<24}  有效数据仅 {valid.mean()*100:.0f}%，跳过")
        continue
    canopy = canopy_structural(rgb, 5.0, 40.0, quiet=True) & valid
    lum, sat, exg = _features(rgb)
    tex = _texture_std(lum, size=5)
    pts = detect_tree_centers(rgb, valid, PX_M)
    nn, med, cv = _nn_stats(pts)
    med_m = med * PX_M if np.isfinite(med) else float("nan")
    print(f"{label:<24}{canopy.mean()*100:>6.1f}%{len(pts):>8}"
          f"{med_m:>12.2f}{cv:>7.3f}"
          f"{np.median(tex[valid]):>12.1f}{np.median(exg[valid]):>9.1f}")
ds.close()
print("\n参考：规则种植 CV≈0.00~0.20；随机点过程 CV≈0.52；聚集分布 CV>0.8")
print("     实测株距 8.35~8.45 m")
