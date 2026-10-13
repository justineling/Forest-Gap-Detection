# -*- coding: utf-8 -*-
"""验证「ExG 过高 + 高饱和 = 草地」判据在全图的适用性。

统计：满足 (ExG > hi) & (S > sat) 的像素有多少、其中多少当前被判为 canopy（=漏检）。
"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from detect import canopy_structural  # noqa: E402
from landcover import _features  # noqa: E402

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
PX_M = 0.03299
TILE = 2048
STEP = 6          # 抽样步长（每 6 块取 1 块）

ds = rasterio.open(IMG)
tot_valid = tot_grass = tot_grass_canopy = tot_canopy = 0.0
n = 0
print(f"{'瓦片':<22}{'有效m²':>12}{'草地候选m²':>13}{'其中被判树冠m²':>16}{'占比':>8}")
for row in range(0, ds.height, TILE * STEP):
    for col in range(0, ds.width, TILE * STEP):
        h = min(TILE, ds.height - row)
        w = min(TILE, ds.width - col)
        if h < 512 or w < 512:
            continue
        d = ds.read(window=Window(col, row, w, h), out_dtype="uint8")
        rgb = np.transpose(d[:3], (1, 2, 0))
        valid = ~np.all(d[:3] == 0, axis=0)
        if valid.mean() < 0.05:
            continue
        lum, sat, exg = _features(rgb)
        canopy = canopy_structural(rgb, 5.0, 40.0, quiet=True) & valid
        grass = valid & (exg > 130.0) & (sat > 0.60)
        px = PX_M * PX_M
        tot_valid += float(valid.sum()) * px
        tot_grass += float(grass.sum()) * px
        tot_grass_canopy += float((grass & canopy).sum()) * px
        tot_canopy += float(canopy.sum()) * px
        n += 1
        if grass.any():
            print(f"r{row:<6}c{col:<6}{float(valid.sum())*px:>12,.0f}"
                  f"{float(grass.sum())*px:>13,.0f}"
                  f"{float((grass & canopy).sum())*px:>16,.0f}"
                  f"{float((grass & canopy).sum())/max(grass.sum(),1)*100:>7.0f}%")
ds.close()

print(f"\n抽样 {n} 块瓦片")
print(f"有效面积        {tot_valid:>12,.0f} m²")
print(f"草地候选(ExG>130 & S>0.60) {tot_grass:>12,.0f} m²  "
      f"（占有效 {tot_grass/max(tot_valid,1)*100:.2f}%）")
print(f"  其中当前被判为树冠       {tot_grass_canopy:>12,.0f} m²  "
      f"（占草地候选 {tot_grass_canopy/max(tot_grass,1)*100:.1f}% ← 这就是漏检量）")
print(f"树冠总面积      {tot_canopy:>12,.0f} m²")
