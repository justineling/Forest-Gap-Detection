# -*- coding: utf-8 -*-
"""抽查整幅检测结果（P0 第 4 步）。

用法：
    .venv/Scripts/python.exe .workbuddy-ai/tmp/inspect_result.py [geojson 路径]
默认读 output/wgr17-full-gaps.geojson。
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from pyproj import Transformer

PLANTABLE = ("vacant_slot", "alley_gap", "open_patch", "uncertain")
UNPLANTABLE = ("road", "water", "office")
ORDER = PLANTABLE + UNPLANTABLE

src = Path(sys.argv[1] if len(sys.argv) > 1 else "output/wgr17-full-gaps.geojson")
if not src.exists():
    print(f"[错误] 找不到 {src}")
    sys.exit(2)

obj = json.loads(src.read_text(encoding="utf-8"))
feats = obj.get("features", [])
if not feats:
    # 整幅结果把 features 放在 blocks[0].gaps 里
    for b in obj.get("blocks", []):
        feats.extend(b.get("gaps", []))

print("=" * 78)
print(f"文件      : {src}  ({src.stat().st_size/1024/1024:.2f} MB)")
print(f"源影像    : {obj.get('source_image')}")
print(f"生成时间  : {obj.get('generated_at')}")
proc = obj.get("processing", {}) or {}
print(f"瓦片      : {proc.get('tiles_processed')}/{proc.get('tiles_total')}"
      f"   地面分辨率 {proc.get('px_m')} m/px   影像面积 {proc.get('image_area_ha')} ha")
prm = obj.get("params", {}) or {}
print(f"不可种植检测: landcover_unplantable={prm.get('landcover_unplantable')}"
      f"   unplantable_overlap={prm.get('unplantable_overlap')}")
pg = obj.get("planting_grid", {}) or {}
print(f"种植网格  : " + "  ".join(f"{k}={pg.get(k)}" for k in
      ("plant_pitch_m", "row_pitch_m", "stagger_deg", "quality", "method") if k in pg))
print("=" * 78)

by = defaultdict(list)
for f in feats:
    p = f.get("properties", {})
    by[p.get("class", "?")].append(p)

tot_area = sum(p.get("area_sqm", 0.0) for lst in by.values() for p in lst)

hdr = f"{'类别':<14}{'数量':>7}{'总面积 m²':>14}{'占比':>8}{'中位 m²':>11}{'最大 m²':>12}   归类"
print(hdr)
print("-" * len(hdr))
for cls in ORDER:
    lst = by.get(cls, [])
    if not lst:
        print(f"{cls:<14}{'—':>7}{'—':>14}{'—':>8}{'—':>11}{'—':>12}   "
              f"{'补种' if cls in PLANTABLE else '不可种植'}")
        continue
    a = np.array([p.get("area_sqm", 0.0) for p in lst], dtype=float)
    print(f"{cls:<14}{len(lst):>7}{a.sum():>14,.0f}{a.sum()/tot_area*100:>7.1f}%"
          f"{np.median(a):>11,.1f}{a.max():>12,.0f}   "
          f"{'补种' if cls in PLANTABLE else '不可种植'}")
print("-" * len(hdr))
plant = sum(p.get("area_sqm", 0.0) for c in PLANTABLE for p in by.get(c, []))
unp = sum(p.get("area_sqm", 0.0) for c in UNPLANTABLE for p in by.get(c, []))
print(f"{'需补种合计':<14}{'':>7}{plant:>14,.0f}{plant/tot_area*100:>7.1f}%")
print(f"{'不可种植合计':<14}{'':>7}{unp:>14,.0f}{unp/tot_area*100:>7.1f}%")
print(f"{'全部空地':<14}{len(feats):>7}{tot_area:>14,.0f}")
print(f"\n参考：全图白色地物（路网理论量级）约 64,689 m²")

tr = Transformer.from_crs("EPSG:32649", "EPSG:4326", always_xy=True)
print()
print("=== 不可种植类别质心（按面积降序前 12，经纬度便于地图核对）===")
for cls in UNPLANTABLE:
    lst = sorted(by.get(cls, []), key=lambda p: -p.get("area_sqm", 0.0))
    if not lst:
        print(f"\n[{cls}] 无检出")
        continue
    print(f"\n[{cls}] 共 {len(lst)} 块")
    for p in lst[:12]:
        cu = p.get("centroid_utm")
        loc = ""
        if cu and len(cu) == 2:
            lon, lat = tr.transform(cu[0], cu[1])
            loc = f"({lon:.5f}, {lat:.5f})"
        print(f"  {str(p.get('gap_id')):<16}{p.get('area_sqm', 0):>10,.1f} m²  "
              f"{loc:<24} 置信 {p.get('class_confidence')}  方法 {p.get('class_method')}")
print("\n抽查完成。")
