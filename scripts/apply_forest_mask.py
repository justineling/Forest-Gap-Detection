# -*- coding: utf-8 -*-
"""把「非种植区掩膜」作用到**已产出的**整幅 GeoJSON 上（无需重跑 33 分钟）。

用途
----
`process_image.py --forest-mask` 会在跑管线时直接应用掩膜。但当你想**反复调整
掩膜边界**时，每次重跑全幅代价太高。本脚本让你：

    1. scripts/build_forest_mask.py            → 生成候选掩膜
    2. 在 ArcGIS / QGIS 里沿真实边界修正后导出 GeoJSON
    3. scripts/apply_forest_mask.py --mask <修正后.geojson>
       → 秒级得到重新分类后的结果
    4. scripts/export_arcgis.py --input <新结果>

改判规则与管线内完全一致（直接复用 `process_image._apply_forest_mask`），
只改判需补种的 4 类，道路/水体/办公区不受影响。

用法
----
  python scripts/apply_forest_mask.py --mask output/forest-mask.geojson
  python scripts/apply_forest_mask.py --input output/wgr17-elev-gaps.geojson \
      --mask my-forest.geojson --out output/wgr17-elev-gaps-masked.geojson
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

from process_image import _apply_forest_mask  # noqa: E402
from grid_prior import (  # noqa: E402
    CLASS_LABEL_CN, CLASS_VACANT_SLOT, CLASS_ALLEY_GAP, CLASS_OPEN_PATCH,
    CLASS_UNCERTAIN, UNPLANTABLE_CLASSES,
)


def main() -> int:
    ap = argparse.ArgumentParser(description="把非种植区掩膜作用到已产出的结果上")
    ap.add_argument("--input", default="output/wgr17-elev-gaps.geojson")
    ap.add_argument("--mask", required=True, help="非种植区掩膜 GeoJSON")
    ap.add_argument("--out", default="",
                    help="输出路径；默认在输入名后加 -masked")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        print(f"✗ 输入不存在：{src}")
        return 1
    dst = Path(args.out) if args.out else src.with_name(src.stem + "-masked.geojson")

    d = json.loads(src.read_text(encoding="utf-8"))
    gaps = d["blocks"][0]["gaps"]
    plant_cls = (CLASS_VACANT_SLOT, CLASS_ALLEY_GAP,
                 CLASS_OPEN_PATCH, CLASS_UNCERTAIN)

    # 原「需补种」面积 = 用于 area_total 的基准
    area_total = sum(f["properties"]["area_sqm"] for f in gaps
                     if f["properties"]["class"] in plant_cls)
    cover = area_total / max(d["summary"].get("gap_area_share_pct", 1.0), 1e-9) * 100

    before = Counter(f["properties"]["class"] for f in gaps)
    before_area = Counter()
    for f in gaps:
        before_area[f["properties"]["class"]] += f["properties"]["area_sqm"]

    gaps, area_new, n_msk, a_msk = _apply_forest_mask(gaps, args.mask, area_total)
    d["blocks"][0]["gaps"] = gaps

    # --- 重算 summary ---
    after = Counter(f["properties"]["class"] for f in gaps)
    after_area = Counter()
    for f in gaps:
        after_area[f["properties"]["class"]] += f["properties"]["area_sqm"]
    plant_areas = np.array([f["properties"]["area_sqm"] for f in gaps
                            if f["properties"]["class"] in plant_cls])
    if plant_areas.size == 0:
        plant_areas = np.array([0.0])
    s = d["summary"]
    s["total_gap_count"] = len(gaps)
    s["total_area_sqm"] = round(area_new, 2)
    s["total_area_ha"] = round(area_new / 1e4, 4)
    s["gap_area_share_pct"] = round(area_new / cover * 100, 3) if cover else None
    s["by_class"] = {k: after.get(k, 0) for k in CLASS_LABEL_CN}
    s["by_class_label"] = {CLASS_LABEL_CN[k]: after.get(k, 0) for k in CLASS_LABEL_CN}
    s["gap_area_stats_sqm"] = {
        "max": round(float(plant_areas.max()), 2),
        "median": round(float(np.median(plant_areas)), 2),
        "min": round(float(plant_areas.min()), 2),
    }
    s["forest_mask"] = {
        "mask_file": Path(args.mask).name,
        "reclassified_count": n_msk,
        "reclassified_area_sqm": round(a_msk, 2),
    }
    d["params"]["forest_mask_path"] = str(args.mask)

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")

    print()
    print("=" * 76)
    print(f"输入 {src.name}")
    print(f"掩膜 {args.mask}")
    print(f"输出 {dst}")
    print("=" * 76)
    print(f"{'类别':<14}{'改判前块数':>11}{'改判后块数':>11}{'改判前m²':>13}{'改判后m²':>13}")
    print("-" * 76)
    for k in CLASS_LABEL_CN:
        print(f"{CLASS_LABEL_CN[k]:<14}{before.get(k,0):>11}{after.get(k,0):>11}"
              f"{before_area.get(k,0):>13,.0f}{after_area.get(k,0):>13,.0f}")
    print("-" * 76)
    b_need = sum(before_area[k] for k in plant_cls)
    a_need = sum(after_area[k] for k in plant_cls)
    print(f"{'需补种合计':<14}{sum(before[k] for k in plant_cls):>11}"
          f"{sum(after[k] for k in plant_cls):>11}{b_need:>13,.0f}{a_need:>13,.0f}")
    print(f"\n剔除 {n_msk} 块 / {a_msk:,.0f} m²（占原需补种 {a_msk/max(b_need,1e-9)*100:.1f}%）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
