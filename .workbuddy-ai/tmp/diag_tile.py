# -*- coding: utf-8 -*-
"""单瓦片全流程诊断：道路掩膜是否落在空地候选里？为什么没被改判？"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from detect import canopy_structural, complement, separate_gap_units  # noqa: E402
from landcover import detect_unplantable  # noqa: E402

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
ROW, COL, SIZE = 2048, 20480, 2048
PX_M = 0.03299

ds = rasterio.open(IMG)
data = ds.read(window=Window(COL, ROW, SIZE, SIZE), out_dtype="uint8")
ds.close()
rgb = np.transpose(data[:3], (1, 2, 0))
valid = ~np.all(data[:3] == 0, axis=0)
print(f"瓦片 r{ROW}_c{COL}  有效 {valid.mean()*100:.1f}%")

canopy = canopy_structural(rgb, 5.0, 40.0, quiet=True) & valid
gap = complement(canopy, valid)
gap_units = separate_gap_units(gap, 1.6, PX_M, quiet=True)
masks = detect_unplantable(rgb, valid, PX_M)

print(f"canopy {canopy.mean()*100:.1f}%   gap {gap.sum()*PX_M*PX_M:.0f} m²   "
      f"gap_units(分离后) {gap_units.sum()*PX_M*PX_M:.0f} m²")
for k, v in masks.items():
    print(f"  {k:<7} 掩膜 {v.sum()*PX_M*PX_M:>9.1f} m²")

road = masks["road"]
if road.any():
    print()
    print(f"road ∩ gap        = {(road & gap).sum()*PX_M*PX_M:>9.1f} m²  "
          f"（占 road 的 {(road & gap).sum()/road.sum()*100:.1f}%）")
    print(f"road ∩ gap_units  = {(road & gap_units).sum()*PX_M*PX_M:>9.1f} m²  "
          f"（占 road 的 {(road & gap_units).sum()/road.sum()*100:.1f}%）")
    print(f"road 中被判为 canopy 的 = {(road & canopy).sum()*PX_M*PX_M:>9.1f} m²  "
          f"（占 road 的 {(road & canopy).sum()/road.sum()*100:.1f}%）")

    # 道路像素的形态学命运：有多少被 1.6 m 开运算抹掉
    lost = road & gap & ~gap_units
    print(f"road 落在 gap 但被开运算抹掉 = {lost.sum()*PX_M*PX_M:>9.1f} m²  "
          f"（占 road 的 {lost.sum()/road.sum()*100:.1f}%）")
