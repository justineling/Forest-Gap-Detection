"""P2 导出链路端到端测试（无需浏览器 / 无需起服务）。

验证「用户人工复核后的要素」真的能落进 Shapefile / KML / 放样点位 / 一页报告：

  1. 双坐标系 GeoJSON（WGS84 / UTM49N）
  2. Shapefile ×2 + 按类别分包
  3. KML
  4. 补种点位（GeoJSON×2 / shp×2 / kml / csv）
  5. 一页汇总报告（单文件自包含 + 关键章节齐全）
  6. **人工改判的类别必须出现在交付物里** —— 这是整条链路的意义所在

用法：
    python scripts/test_p2_export.py
"""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import tile_server as TS  # noqa: E402

FAILED = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global FAILED
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}{'  ·  ' + detail if detail else ''}")
    if not ok:
        FAILED += 1


def main() -> int:
    base_path = ROOT / "output" / "wgr17-final-gaps.geojson"
    if not base_path.exists():
        print(f"[跳过] 找不到 {base_path}")
        print("       本测试需要一份真实检测结果（含 planting_grid）才能验证放样点位。")
        return 0

    base_obj = json.loads(base_path.read_text(encoding="utf-8"))
    raw = []
    for b in base_obj.get("blocks", []):
        raw.extend(b.get("gaps", []))
    if len(raw) < 5:
        print("[跳过] 结果里要素太少")
        return 0

    # 取样要有讲究：**必须含够数量的可补种块**，否则放样点位为 0
    # （结果文件按瓦片顺序排，前几块常常是道路/林间空隙）。
    plantable = [f for f in raw if (f.get("properties") or {}).get("class")
                 in ("open_patch", "vacant_slot")]
    others = [f for f in raw if f not in plantable]
    if len(plantable) < 4:
        print("[跳过] 可补种块不足 4 个")
        return 0
    picked = plantable[:4] + others[:2]

    # 人为制造「人工复核」痕迹：
    #   · 第 1 块改判为非种植区（模拟用户把误报标成不可种植）
    #   · 第 2 块标 edited（模拟改边界）
    #   · 第 3 块改成 source=manual（模拟人工补画）
    # 注意别动第 4 块 —— 留一块干净的可补种块，保证放样点位一定非空。
    feats = [dict(f) for f in picked]
    for i, f in enumerate(feats):
        f["properties"] = dict(f.get("properties") or {})

    feats[0]["properties"].update({
        "class": "undeveloped",
        "class_label": "非种植区",
        "edited": True,
        "original_class": feats[0]["properties"].get("class"),
    })
    feats[1]["properties"]["edited"] = True
    feats[2]["properties"].update({"class": "manual_add", "class_label": "人工新增",
                                   "source": "manual", "edited": True})

    payload = {
        "gaps": {"type": "FeatureCollection", "features": feats},
        "clearance_m": 0.5,
        "audit": {"added": 1, "edited": 2, "deleted": 3},
        "image": {"name": "WGR17-002.tif", "width": 47130, "height": 44686,
                  "res_m": 0.033, "crs": "EPSG:4326"},
        "roi": {"has_roi": False},
    }

    outdir = Path(tempfile.mkdtemp(prefix="fgd-export-"))
    print(f"\n输出目录：{outdir}")
    try:
        res = TS.export_bundle(payload, outdir, base_obj)
        print(f"返回：ok={res.get('ok')} files={len(res.get('files') or [])} "
              f"counts={res.get('counts')}")
        if res.get("notes"):
            for n in res["notes"]:
                print(f"  note: {n}")

        print("\nA. 基础交付物")
        check(res.get("ok") is True, "导出返回 ok")
        for name in (
            "gaps-all-wgs84.geojson",
            "gaps-all-utm49n.geojson",
            "gaps-all-wgs84-shp.zip",
            "gaps-all-utm49n-shp.zip",
            "gaps-all.kml",
            "gaps-edited.csv",
        ):
            check((outdir / name).exists(), f"{name} 已生成")

        print("\nB. 按类别分包")
        by_class = sorted((outdir / "by-class").glob("*.zip")) if (outdir / "by-class").exists() else []
        check(len(by_class) > 0, "by-class/ 下有分包", f"{len(by_class)} 个")
        check(
            any("undeveloped" in p.name for p in by_class),
            "★ 人工改判出的 undeveloped 类有自己的分包",
            ",".join(p.name for p in by_class)[:90],
        )

        print("\nC. 补种点位")
        for name in (
            "planting-points-wgs84.geojson",
            "planting-points-utm49n.geojson",
            "planting-points-wgs84-shp.zip",
            "planting-points-utm49n-shp.zip",
            "planting-points.kml",
            "planting-points.csv",
        ):
            check((outdir / name).exists(), f"{name} 已生成")
        check((res.get("counts") or {}).get("planting_points", 0) > 0,
              "放样点位数 > 0", str((res.get("counts") or {}).get("planting_points")))

        print("\nD. ★ 人工编辑真的进了交付物")
        gj = json.loads((outdir / "gaps-all-wgs84.geojson").read_text(encoding="utf-8"))
        ids = {f["properties"]["gap_id"] for f in gj["features"]}
        edited_id = feats[0]["properties"]["gap_id"]
        check(edited_id in ids, "改判的那块在 WGS84 交付物里")
        got = next(f for f in gj["features"] if f["properties"]["gap_id"] == edited_id)
        check(got["properties"]["cls"] == "undeveloped",
              "★ 交付物里的类别 = 用户改判值（不是算法原判）",
              f"cls={got['properties']['cls']} 原判={feats[0]['properties'].get('original_class')}")
        check(got["properties"]["cls_label"] == "非种植区", "中文标签同步")

        print("\nE. 一页报告")
        rp = outdir / "补种勘察一页报告.html"
        check(rp.exists(), "报告已生成")
        if rp.exists():
            h = rp.read_text(encoding="utf-8")
            check(h.startswith("<!DOCTYPE html>"), "是完整 HTML")
            check("@media print" in h and "A4" in h, "有 A4 打印样式")
            check("<svg" in h, "含内联 SVG 图表")
            check("<img" not in h, "无外部图片")
            check(not any(k in h for k in ("<link ", "src=\"http", "@import")), "无外部资源引用")
            for kw in ("确定需补种", "待复核", "不可种植", "网格排坑法",
                       "人工复核留痕", "重点连片空地"):
                check(kw in h, f"含章节「{kw}」")
            check("非种植区" in h or "不可种植" in h, "改判结果体现在口径表里")

        print("\nF. 空输入不崩")
        r2 = TS.export_bundle({"gaps": {"features": []}}, outdir / "empty", base_obj)
        check(r2.get("ok") is False and "没有可导出" in (r2.get("error") or ""),
              "空要素返回可读错误而不是抛异常")
    finally:
        shutil.rmtree(outdir, ignore_errors=True)

    print()
    if FAILED == 0:
        print("✅ 全部通过")
    else:
        print(f"❌ {FAILED} 项失败")
    return 0 if FAILED == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
