"""方案 B 网格周期性回检 —— 三分域 A/B 验证。

区域（2026-10-13 目视定位）：
  南部 (40000, 30000)：大片嫩绿低矮植被 = 真草地（应保留）
  受光面 (37900, 25600)：油棕树冠受光面（开运算后残留应被网格回检剔除）
  密林 (22343, 23565)：典型油棕林（草地候选应恒为 0）
"""
import sys
import time

import numpy as np
import rasterio
from rasterio.windows import Window

sys.path.insert(0, "scripts")
from landcover import detect_grass, LandcoverParams

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
PX = 0.03299
ZONES = [
    (40000, 30000, "南部草地"),
    (37900, 25600, "受光面区"),
    (22343, 23565, "密林"),
]

ds = rasterio.open(IMG)
p_on = LandcoverParams()                       # grass_grid=True（默认）
p_off = LandcoverParams(grass_grid=False)      # 只跑颜色+开运算

for row, col, tag in ZONES:
    size = 1024
    r0 = max(0, row - size // 2)
    c0 = max(0, col - size // 2)
    d = ds.read(window=Window(c0, r0, size, size), out_dtype="uint8")
    rgb = np.transpose(d[:3], (1, 2, 0))
    valid = ~np.all(d[:3] == 0, axis=0)
    px_area = PX * PX

    t = time.time()
    g_off = detect_grass(rgb, valid, PX, p_off)
    dt_off = time.time() - t
    t = time.time()
    g_on = detect_grass(rgb, valid, PX, p_on)
    dt_on = time.time() - t

    removed = g_off.sum() - (g_off & g_on).sum()
    print(f"[{tag}] 位置({row},{col})")
    print(f"  网格回检关（颜色+开运算）: {g_off.sum() * px_area:8.1f} m²  ({dt_off:.2f}s)")
    print(f"  网格回检开（方案 B）    : {g_on.sum() * px_area:8.1f} m²  ({dt_on:.2f}s)"
          f"   多耗 {dt_on - dt_off:+.2f}s")
    print(f"  网格判据剔除            : {removed * px_area:8.1f} m²"
          f"（占候选 {removed / max(g_off.sum(), 1) * 100:.1f}%）")
ds.close()
