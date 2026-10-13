# -*- coding: utf-8 -*-
"""从整幅结果里取出水体多边形，裁剪对应位置的原图缩略图，供目视验证。"""
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window
from PIL import Image
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"

obj = json.loads((ROOT / "output" / "wgr17-full-gaps.geojson").read_text(encoding="utf-8"))
feats = obj.get("features")
if not feats:                       # 整幅结果把要素放在 blocks[*].gaps 下
    feats = []
    for b in obj.get("blocks", []):
        feats.extend(b.get("gaps", []))
water = [f for f in feats if f["properties"]["class"] == "water"]
print(f"水体共 {len(water)} 块，总 {sum(f['properties']['area_sqm'] for f in water):,.0f} m²")
water.sort(key=lambda f: -f["properties"]["area_sqm"])

ds = rasterio.open(IMG)
tr = Transformer.from_crs("EPSG:32649", "EPSG:4326", always_xy=True)
outdir = ROOT / ".workbuddy-ai" / "tmp"

for i, f in enumerate(water[:8]):
    cu = f["properties"]["centroid_utm"]
    lon, lat = tr.transform(cu[0], cu[1])
    row, col = ds.index(lon, lat)
    size = 480
    r0 = max(0, min(ds.height - size, row - size // 2))
    c0 = max(0, min(ds.width - size, col - size // 2))
    data = ds.read(window=Window(c0, r0, size, size), out_dtype="uint8")
    rgb = np.transpose(data[:3], (1, 2, 0))
    img = Image.fromarray(rgb).resize((size * 2, size * 2), Image.NEAREST)
    gid = f["properties"]["gap_id"]
    out = outdir / f"water_{i:02d}_{gid}.png"
    img.save(out)
    print(f"  [{i}] {gid:<24} {f['properties']['area_sqm']:>7.1f} m²  "
          f"像素({row},{col})  经纬({lon:.5f},{lat:.5f})")
ds.close()
print(f"\n缩略图已存到 {outdir}")
