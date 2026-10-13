# -*- coding: utf-8 -*-
"""裁剪若干典型区域缩略图，用于目视判断草地 / 油棕 / 空地。"""
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
OUT = ROOT / ".workbuddy-ai" / "tmp"

obj = json.loads((ROOT / "output" / "wgr17-full-gaps.geojson").read_text(encoding="utf-8"))
feats = obj.get("features") or [f for b in obj.get("blocks", []) for f in b.get("gaps", [])]

# 取第 5~12 大的「连片空地」（文档说第 5 块起出现"草荒型"）
patch = sorted([f for f in feats if f["properties"]["class"] == "open_patch"],
               key=lambda f: -f["properties"]["area_sqm"])[4:12]
vacant = []

ds = rasterio.open(IMG)
tr = Transformer.from_crs("EPSG:32649", "EPSG:4326", always_xy=True)

targets = [(f, "patch") for f in patch] + [(f, "slot") for f in vacant]

for i, (f, tag) in enumerate(targets):
    if f is None:
        row, col = ds.height // 2, ds.width // 2
        gid, area = "center", 0
    else:
        cu = f["properties"]["centroid_utm"]
        lon, lat = tr.transform(cu[0], cu[1])
        row, col = ds.index(lon, lat)
        gid, area = f["properties"]["gap_id"], f["properties"]["area_sqm"]
    size = 512
    r0 = max(0, min(ds.height - size, row - size // 2))
    c0 = max(0, min(ds.width - size, col - size // 2))
    data = ds.read(window=Window(c0, r0, size, size), out_dtype="uint8")
    rgb = np.transpose(data[:3], (1, 2, 0))
    Image.fromarray(rgb).resize((size * 2, size * 2), Image.NEAREST).save(
        OUT / f"zone_{i:02d}_{tag}_{gid}.png")
    print(f"[{i}] {tag:<7} {gid:<26} {area:>8.1f} m²  像素({row},{col})")
ds.close()
print(f"\n缩略图已存到 {OUT}")
