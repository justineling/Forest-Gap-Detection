# -*- coding: utf-8 -*-
"""诊断水体误报：打印被判定为水的像素的实际 RGB / 亮度 / ExG。"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from landcover import detect_water, _features, LandcoverParams  # noqa: E402

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
PX_M = 0.03299
p = LandcoverParams()

for name, row, col in [("water_02(误报)", 39979, 14487),
                       ("water_03(误报)", 20198, 3593),
                       ("water_00(真水)", 40118, 31168)]:
    ds = rasterio.open(IMG)
    size = 480
    r0, c0 = row - size // 2, col - size // 2
    data = ds.read(window=Window(c0, r0, size, size), out_dtype="uint8")
    ds.close()
    rgb = np.transpose(data[:3], (1, 2, 0))
    valid = ~np.all(data[:3] == 0, axis=0)
    lum, sat, exg = _features(rgb)
    r, g, b = (rgb[..., i].astype(np.float32) for i in range(3))

    m = detect_water(rgb, valid, PX_M, p)
    print(f"\n{name} 像素({row},{col})  detect_water 命中 {int(m.sum())} px")
    if not m.any():
        continue
    print(f"  命中像素均值：RGB=({r[m].mean():.0f}, {g[m].mean():.0f}, {b[m].mean():.0f})  "
          f"L={lum[m].mean():.0f}  S={sat[m].mean():.2f}  ExG={exg[m].mean():.1f}")
    # 拆分两条规则各自贡献
    w1 = (b >= g - p.water_blue_margin) & (g > r) & valid
    dark = (lum < p.water_dark_lum) & valid & (exg < p.water_dark_exg)
    print(f"  规则1(B>=G>R) 命中 {int(w1.sum())} px"
          + (f"  均值RGB=({r[w1].mean():.0f},{g[w1].mean():.0f},{b[w1].mean():.0f})" if w1.any() else ""))
    print(f"  规则2(暗+低ExG) 命中 {int(dark.sum())} px")
    if w1.any():
        print(f"  规则1 命中像素的亮度 L 均值 = {lum[w1].mean():.0f}"
              f"（白路 L>170；水应偏暗）")
