# -*- coding: utf-8 -*-
"""P4 定量对比：草地 vs 油棕树冠，寻找真正可分的特征。"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from scipy import ndimage as ndi

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from landcover import _features, _texture_std  # noqa: E402

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
PX_M = 0.03299
SIZE = 512

ZONES = [
    (40000, 30000, "草地(亮绿低矮植被)"),
    (22343, 23565, "油棕(密林)"),
    (30000, 40000, "油棕(东南)"),
    (10000, 10000, "油棕(西北)"),
]

ds = rasterio.open(IMG)
hdr = (f"{'区域':<22}{'L中位':>7}{'ExG中位':>9}{'S中位':>7}"
       f"{'tex5':>7}{'tex25':>7}{'比值':>7}{'R/G':>7}{'G-B':>7}")
print(hdr)
print("-" * len(hdr))
for row, col, label in ZONES:
    r0 = max(0, min(ds.height - SIZE, row - SIZE // 2))
    c0 = max(0, min(ds.width - SIZE, col - SIZE // 2))
    d = ds.read(window=Window(c0, r0, SIZE, SIZE), out_dtype="uint8")
    rgb = np.transpose(d[:3], (1, 2, 0))
    valid = ~np.all(d[:3] == 0, axis=0)
    lum, sat, exg = _features(rgb)
    t5 = _texture_std(lum, size=5)
    t25 = _texture_std(lum, size=25)
    r = rgb[..., 0].astype(np.float32)
    g = rgb[..., 1].astype(np.float32)
    b = rgb[..., 2].astype(np.float32)
    v = valid & (exg > np.percentile(exg[valid], 50))   # 只看植被像素
    ratio = t25[v] / (t5[v] + 1e-6)
    print(f"{label:<22}{np.median(lum[v]):>7.0f}{np.median(exg[v]):>9.0f}"
          f"{np.median(sat[v]):>7.2f}{np.median(t5[v]):>7.1f}{np.median(t25[v]):>7.1f}"
          f"{np.median(ratio):>7.2f}"
          f"{np.median(r[v]/np.maximum(g[v],1)):>7.2f}"
          f"{np.median(g[v]-b[v]):>7.0f}")
ds.close()
print("\n说明：tex5/tex25 = 5/25 像素窗口的亮度标准差；比值 = tex25/tex5")
print("      R/G 越小越偏绿；G-B 越大越偏黄绿（草地通常更黄）")
