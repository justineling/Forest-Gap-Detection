# -*- coding: utf-8 -*-
"""诊断：测量 landcover 掩膜在各瓦片上的面积，评估 road 检出量级。

用法：.venv/Scripts/python.exe .workbuddy-ai/tmp/diag_landcover.py [瓦片数]
"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))
from landcover import detect_unplantable, LandcoverParams  # noqa: E402

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
TILE = 2048
N = int(sys.argv[1]) if len(sys.argv) > 1 else 8
PX_M = 0.03299

ds = rasterio.open(IMG)
p = LandcoverParams()
print(f"参数：bright_abs={p.bright_abs} sat_max={p.sat_max} "
      f"road_fill_max={p.road_fill_max} road_min_area_sqm={p.road_min_area_sqm} "
      f"min_blob_px={p.min_blob_px}")

tot = {"road": 0.0, "water": 0.0, "office": 0.0}
bright_tot = 0.0
n_done = 0
rows = []
for row in range(0, ds.height, TILE):
    for col in range(0, ds.width, TILE):
        h = min(TILE, ds.height - row)
        w = min(TILE, ds.width - col)
        if h < 512 or w < 512:
            continue
        data = ds.read(window=Window(col, row, w, h), out_dtype="uint8")
        rgb = np.transpose(data[:3], (1, 2, 0))
        valid = ~np.all(data[:3] == 0, axis=0)
        if valid.mean() < 0.05:
            continue
        lum = rgb.astype(np.float32).mean(axis=2)
        mx = rgb.astype(np.float32).max(axis=2)
        mn = rgb.astype(np.float32).min(axis=2)
        sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
        bright = float(((lum > p.bright_abs) & (sat < p.sat_max) & valid).sum()) * PX_M * PX_M
        m = detect_unplantable(rgb, valid, PX_M)
        a = {k: float(v.sum()) * PX_M * PX_M for k, v in m.items()}
        for k in tot:
            tot[k] += a[k]
        bright_tot += bright
        n_done += 1
        rows.append((f"r{row:06d}_c{col:06d}", valid.mean(), bright, a))
        if n_done >= N:
            break
    if n_done >= N:
        break
ds.close()

print()
print(f"{'瓦片':<22}{'有效%':>7}{'亮+低饱和 m²':>14}{'road':>10}{'water':>10}{'office':>10}")
for tid, v, b, a in rows:
    print(f"{tid:<22}{v*100:>6.1f}%{b:>14,.0f}{a['road']:>10,.0f}"
          f"{a['water']:>10,.0f}{a['office']:>10,.0f}")

print()
print(f"前 {n_done} 块累计：亮+低饱和 {bright_tot:,.0f} m²，"
      f"road {tot['road']:,.0f}，water {tot['water']:,.0f}，office {tot['office']:,.0f}")
print()
print("按 321 块有效瓦片外推（仅供量级参考）：")
print(f"  亮+低饱和 {bright_tot/n_done*321:>12,.0f} m²  ← 交接文档实测 64,689 m²")
print(f"  road      {tot['road']/n_done*321:>12,.0f} m²")
print(f"  water     {tot['water']/n_done*321:>12,.0f} m²")
print(f"  office    {tot['office']/n_done*321:>12,.0f} m²")
