# -*- coding: utf-8 -*-
"""诊断 landcover 各检测函数的耗时与连通域数量（定位 50 秒/瓦片的真凶）。"""
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy import ndimage as ndi

import landcover as lc

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
ROW, COL, SIZE = 6144, 20480, 2048   # 对应日志里的 r006144_c020480

ds = rasterio.open(IMG)
win = Window(col_off=COL, row_off=ROW, width=SIZE, height=SIZE)
data = ds.read(window=win, out_dtype="uint8")
rgb = np.transpose(data[:3], (1, 2, 0))
valid = ~np.all(data[:3] == 0, axis=0)
px_m = 0.033
p = lc.LandcoverParams()

print(f"瓦片 r{ROW:06d}_c{COL:06d}  shape={rgb.shape}  有效 {valid.mean()*100:.1f}%")
print("-" * 62)

for name in ("detect_roads", "detect_office", "detect_water"):
    fn = getattr(lc, name)
    t = time.time()
    m = fn(rgb, valid, px_m, p)
    dt = time.time() - t
    print(f"{name:<18}{dt:>8.2f} 秒   命中 {int(m.sum()):>9,} px")

t = time.time()
masks = lc.detect_unplantable(rgb, valid, px_m, p)
print(f"{'detect_unplantable':<18}{time.time()-t:>8.2f} 秒   "
      f"合计 {int(sum(m.sum() for m in masks.values())):,} px")

print("-" * 62)
lum, sat, exg = lc._features(rgb)
cand = lc._bright_mask(lum, sat, valid, p) & valid
_, n_bright = ndi.label(cand, structure=lc._STRUCT8)
print(f"亮+低饱和候选连通域数 n = {n_bright:,}")

f = rgb.astype(np.float32)
r, g, b = f[..., 0], f[..., 1], f[..., 2]
w1 = (b >= g - p.water_blue_margin) & (g > r) & valid
dark = (lum < p.water_dark_lum) & valid & (exg < p.water_dark_exg)
w2 = dark & (lc._texture_std(lum, 5) < p.water_texture_max)
_, n_water = ndi.label(w1 | w2, structure=lc._STRUCT8)
print(f"水体候选连通域数     n = {n_water:,}")
print(f"\n→ 循环 {n_bright:,} 次 × 每次全图比较(2048²=4.19M) ≈ "
      f"{n_bright*4.19e6/1e9:.1f} G 次元素操作")
print(f"→ 循环 {n_water:,} 次 ≈ {n_water*4.19e6/1e9:.1f} G 次元素操作")
