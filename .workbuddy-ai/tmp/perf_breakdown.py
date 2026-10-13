# -*- coding: utf-8 -*-
"""测量方案 D 中「掩膜矢量化」各步骤的实际耗时，定位真正的开销点。"""
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window, transform as win_transform
from rasterio.features import shapes as rio_shapes
from shapely.geometry import shape
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from process_image import shp_transform, TARGET_CRS  # noqa: E402
from landcover import detect_unplantable  # noqa: E402

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
PX_M = 0.03299
ds = rasterio.open(IMG)
_to_utm = Transformer.from_crs(ds.crs, TARGET_CRS, always_xy=True)


def fwd(x, y, z=None):
    return _to_utm.transform(x, y)


print(f"{'瓦片':<22}{'detect':>9}{'shapes':>9}{'投影':>9}{'简化':>9}{'总':>9}{'块数':>7}")
for row, col in [(2048, 20480), (0, 24576), (2048, 22528), (4096, 18432)]:
    win = Window(col, row, 2048, 2048)
    data = ds.read(window=win, out_dtype="uint8")
    rgb = np.transpose(data[:3], (1, 2, 0))
    valid = ~np.all(data[:3] == 0, axis=0)
    aff = win_transform(win, ds.transform)

    t0 = time.time()
    masks = detect_unplantable(rgb, valid, PX_M)
    t1 = time.time()

    t2 = time.time()
    n_geom = 0
    for cls in ("water", "road", "office"):
        mk = masks[cls]
        if not mk.any():
            continue
        n_geom += sum(1 for _ in rio_shapes(mk.astype(np.uint8), mask=mk,
                                            transform=aff))
    t3 = time.time()

    t4 = time.time()
    for cls in ("water", "road", "office"):
        mk = masks[cls]
        if not mk.any():
            continue
        for geom, val in rio_shapes(mk.astype(np.uint8), mask=mk, transform=aff):
            shp_transform(fwd, shape(geom))
    t5 = time.time()

    t6 = time.time()
    n_kept = 0
    for cls in ("water", "road", "office"):
        mk = masks[cls]
        if not mk.any():
            continue
        for geom, val in rio_shapes(mk.astype(np.uint8), mask=mk, transform=aff):
            gu = shp_transform(fwd, shape(geom)).simplify(0.3, preserve_topology=True)
            if float(gu.area) >= 30.0:
                n_kept += 1
    t7 = time.time()

    print(f"r{row:<6}c{col:<6}{t1-t0:>8.2f}s{t3-t2:>8.2f}s"
          f"{t5-t4:>8.2f}s{t7-t6-(t5-t4):>8.2f}s"
          f"{(t1-t0)+(t3-t2)+(t7-t6):>8.2f}s{n_geom:>4}/{n_kept:<3}")
ds.close()
