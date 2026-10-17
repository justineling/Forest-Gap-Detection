# -*- coding: utf-8 -*-
"""ArcGIS 交付包生成器（重建版）。

背景：本脚本原为 `.workbuddy-ai/tmp/make_arcgis_export3.py`，因 `.workbuddy-ai/`
被 .gitignore 排除，在新机器克隆后丢失。此处重建并移入 `scripts/`，使其随 git 同步，
以后不再丢。

读取 `process_image.py` 产出的整幅 GeoJSON（**几何为 WGS84**），生成一套可直接
拖进 ArcGIS / Google Earth 的文件：

    output/arcgis/
      gaps-all-wgs84.geojson        原样（EPSG:4326）
      gaps-all-utm49n.geojson       投影到 EPSG:32649（面积以米为单位）
      gaps-all-wgs84-shp.zip        Shapefile（EPSG:4326）+ .prj + .cpg
      gaps-all-utm49n-shp.zip       Shapefile（EPSG:32649）  ← ArcGIS 首选（.prj 必被识别）
      gaps-all.kml                  Google Earth（WGS84 强制经纬度）
      by-class/<class>-utm49n.zip   按类别拆分，含新增 road / water / office

用法：
    .venv/Scripts/python.exe scripts/export_arcgis.py
    .venv/Scripts/python.exe scripts/export_arcgis.py \
        --input output/wgr17-full-gaps.geojson --outdir output/arcgis
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

import shapefile  # pyshp
from pyproj import Transformer

WGS84 = "EPSG:4326"
UTM49N = "EPSG:32649"   # 马来西亚砂拉越在 UTM 49N（中央经线 111°E）

# 类别顺序：需补种的在前，不可种植的在后
CLASS_ORDER = [
    "vacant_slot", "alley_gap", "open_patch", "uncertain",
    "road", "water", "office", "undeveloped",
]
CLASS_LABEL_CN = {
    "vacant_slot": "株位空缺",
    "alley_gap": "林间空隙",
    "open_patch": "连片空地",
    "uncertain": "不确定",
    "road": "道路",
    "water": "水体",
    "office": "办公生活区",
    "undeveloped": "非种植区",
}

# .prj 内容（ArcGIS 靠它识别坐标系，必须与几何真实 CRS 一致）
PRJ_UTM49N = (
    'PROJCS["WGS_1984_UTM_Zone_49N",GEOGCS["GCS_WGS_1984",'
    'DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],'
    'PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],'
    'PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",111.0],'
    'PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],'
    'UNIT["Meter",1.0]]'
)
PRJ_WGS84 = (
    'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",'
    'SPHEROID["WGS_1984",6378137.0,298.257223563]],'
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'
)

# shapefile 字段名上限 10 字符
SHP_FIELDS = [
    ("gap_id", "C", 40),
    ("cls", "C", 16),
    ("cls_label", "C", 24),
    ("area_sqm", "N", 18, 2),
    ("cls_conf", "N", 8, 3),
    ("cls_meth", "C", 24),
]


def log(msg: str) -> None:
    print(msg, flush=True)


def iter_rings(geom: dict):
    """把 Polygon / MultiPolygon 拆成一组「外环」，每环为 [(lon, lat), ...]。"""
    if not geom:
        return
    gtype = geom.get("type")
    coords = geom.get("coordinates") or []
    if gtype == "Polygon":
        polygons = [coords]
    elif gtype == "MultiPolygon":
        polygons = coords
    else:
        return
    for poly in polygons:
        if not poly:
            continue
        ring = poly[0]  # 外环；本数据无洞，忽略内环
        if len(ring) >= 3:
            yield [(float(x), float(y)) for x, y in ring]


def props_row(p: dict) -> dict:
    return {
        "gap_id": str(p.get("gap_id", "")),
        "cls": str(p.get("class", "uncertain")),
        "cls_label": str(p.get("class_label", CLASS_LABEL_CN.get(
            p.get("class", "uncertain"), ""))),
        "area_sqm": float(p.get("area_sqm") or 0.0),
        "cls_conf": float(p.get("class_confidence") or 0.0),
        "cls_meth": str(p.get("class_method", "")),
    }


def load_features(path: Path):
    obj = json.loads(path.read_text(encoding="utf-8"))
    feats = obj.get("features")
    if not feats:
        # ⚠️ process_image.py 的整幅结果把要素放在 blocks[*].gaps 下，顶层没有 features。
        #    只读顶层会得到 0 个要素（本轮踩过）。
        feats = []
        for b in obj.get("blocks", []):
            feats.extend(b.get("gaps", []))
    out = []
    for f in feats:
        rings = list(iter_rings(f.get("geometry") or {}))
        if not rings:
            continue
        out.append((props_row(f.get("properties") or {}), rings))
    return obj, out


def write_geojson_wgs84(features, src_obj: dict, out: Path) -> None:
    """WGS84 GeoJSON：输出标准 FeatureCollection（几何已是 WGS84）。

    ⚠️ 不能直接把源文件原样落盘 —— 整幅结果的要素藏在 blocks[*].gaps 下，
    ArcGIS 只认顶层 features，原样落盘会得到"0 个要素"。
    """
    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": WGS84}},
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_image": src_obj.get("source_image"),
        "summary": src_obj.get("summary"),
        "features": [],
    }
    for props, rings in features:
        if len(rings) == 1:
            geom = {"type": "Polygon", "coordinates": [rings[0]]}
        else:
            geom = {"type": "MultiPolygon", "coordinates": [[r] for r in rings]}
        fc["features"].append({"type": "Feature", "properties": props, "geometry": geom})
    out.write_text(json.dumps(fc, ensure_ascii=False, indent=1), encoding="utf-8")


def write_geojson_utm(features, tr, out: Path) -> None:
    fc = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": UTM49N}},
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "note": "几何已投影到 UTM 49N（米）。ArcGIS 导入后若显示为直线，"
                "请手动指定坐标系为 WGS 1984 UTM Zone 49N。",
        "features": [],
    }
    for props, rings in features:
        new_rings = []
        for ring in rings:
            xs, ys = tr.transform([p[0] for p in ring], [p[1] for p in ring])
            nr = [[round(x, 2), round(y, 2)] for x, y in zip(xs, ys)]
            if nr[0] != nr[-1]:
                nr.append(nr[0])
            new_rings.append(nr)
        fc["features"].append({
            "type": "Feature",
            "properties": props,
            "geometry": {"type": "Polygon", "coordinates": [new_rings[0]]}
            if len(new_rings) == 1 else
            {"type": "MultiPolygon", "coordinates": [[r] for r in new_rings]},
        })
    out.write_text(json.dumps(fc, ensure_ascii=False, indent=1),
                   encoding="utf-8")


def write_shp_zip(features, out_zip: Path, projected: bool, tr=None,
                  prj: str = PRJ_UTM49N) -> int:
    """写 Shapefile 并打包成 .zip（含 .prj / .cpg）。返回要素数。"""
    stem = out_zip.with_suffix("").name  # 去掉 .zip
    tmpdir = out_zip.parent / ("__shp_" + stem)
    tmpdir.mkdir(parents=True, exist_ok=True)

    shp = tmpdir / f"{stem}.shp"
    w = shapefile.Writer(str(shp), encoding="utf-8")
    for fname, ftype, *rest in SHP_FIELDS:
        w.field(fname, ftype, *rest)

    n = 0
    for props, rings in features:
        parts = []
        for ring in rings:
            if projected and tr is not None:
                xs, ys = tr.transform([p[0] for p in ring], [p[1] for p in ring])
                parts.append([(round(x, 2), round(y, 2)) for x, y in zip(xs, ys)])
            else:
                parts.append([(round(x, 7), round(y, 7)) for x, y in ring])
        if not parts:
            continue
        w.poly(parts)
        w.record(props["gap_id"], props["cls"], props["cls_label"],
                 props["area_sqm"], props["cls_conf"], props["cls_meth"])
        n += 1
    w.close()

    (tmpdir / f"{stem}.prj").write_text(prj, encoding="ascii")
    (tmpdir / f"{stem}.cpg").write_text("UTF-8", encoding="ascii")

    if out_zip.exists():
        out_zip.unlink()
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
            f = tmpdir / f"{stem}{ext}"
            if f.exists():
                z.write(f, arcname=f"{stem}{ext}")
    for f in tmpdir.glob("*"):
        f.unlink()
    tmpdir.rmdir()
    return n


# ---------------------------------------------------------------------------
# 补种点位导出（需求 R-P1-7，2026-10-17）
# ---------------------------------------------------------------------------
# Shapefile 字段名上限 10 字符
POINT_SHP_FIELDS = [
    ("point_id", "C", 12),
    ("gap_id", "C", 40),
    ("cls", "C", 20),
    ("lon", "N", 12, 7),
    ("lat", "N", 12, 7),
    ("utm_x", "N", 14, 2),
    ("utm_y", "N", 14, 2),
    ("clearance", "N", 6, 2),
]


def write_points_shp_zip(points, out_zip: Path, projected: bool,
                         prj: str = PRJ_UTM49N) -> int:
    """写点位 Shapefile 并打包成 .zip。projected=True 用 UTM，否则经纬度。"""
    stem = out_zip.with_suffix("").name
    tmpdir = out_zip.parent / ("__shp_" + stem)
    tmpdir.mkdir(parents=True, exist_ok=True)

    shp = tmpdir / f"{stem}.shp"
    w = shapefile.Writer(str(shp), encoding="utf-8")
    for fname, ftype, *rest in POINT_SHP_FIELDS:
        w.field(fname, ftype, *rest)

    n = 0
    for p in points:
        if projected:
            w.point(round(p["utm_x"], 2), round(p["utm_y"], 2))
        else:
            w.point(round(p["lon"], 7), round(p["lat"], 7))
        w.record(p["point_id"], p["gap_id"], p["class"], p["lon"], p["lat"],
                 p["utm_x"], p["utm_y"], p["clearance_m"])
        n += 1
    w.close()

    (tmpdir / f"{stem}.prj").write_text(prj, encoding="ascii")
    (tmpdir / f"{stem}.cpg").write_text("UTF-8", encoding="ascii")

    if out_zip.exists():
        out_zip.unlink()
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        for ext in (".shp", ".shx", ".dbf", ".prj", ".cpg"):
            f = tmpdir / f"{stem}{ext}"
            if f.exists():
                z.write(f, arcname=f"{stem}{ext}")
    for f in tmpdir.glob("*"):
        f.unlink()
    tmpdir.rmdir()
    return n


def export_planting_points(src_obj: dict, outdir: Path,
                           clearance_m: float = 0.5) -> dict:
    """生成补种点位交付物：GeoJSON(×2) / Shapefile(×2) / KML / CSV。

    返回 `planting_points.generate_planting_points` 的结果字典。
    """
    import sys as _sys
    _sys.path.insert(0, str(Path(__file__).resolve().parent))
    import planting_points as PP
    from grid_prior import GridModel

    g = src_obj.get("planting_grid") or {}
    if not g.get("plant_pitch_m"):
        raise ValueError("结果里缺少 planting_grid（请先跑 process_image.py）")

    grid = GridModel(
        plant_pitch_m=g["plant_pitch_m"],
        row_pitch_m=g["row_pitch_m"],
        skew_offset_m=g.get("skew_offset_m", g["plant_pitch_m"] / 2.0),
        origin_x_m=g["origin_x_m"],
        origin_y_m=g["origin_y_m"],
        row_azimuth_deg=g["row_azimuth_deg"],
        quality=float(g.get("quality", 0.0)),
        method=str(g.get("method", "")),
        density_per_ha=float(g.get("density_per_ha", 0.0)),
    )

    feats = [f for b in src_obj.get("blocks", []) for f in b.get("gaps", [])]
    res = PP.generate_planting_points(feats, grid, clearance_m=clearance_m)
    pts = res["points"]
    if not pts:
        log("  ⚠️ 没有生成任何补种点位（检查 planting_grid 与需补种类别）")
        return res

    # 1) WGS84 GeoJSON
    gj_wgs = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "planting_points_meta": res["grid"],
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
            "properties": {k: v for k, v in p.items() if k not in ("lon", "lat")},
        } for p in pts],
    }
    (outdir / "planting-points-wgs84.geojson").write_text(
        json.dumps(gj_wgs, ensure_ascii=False), encoding="utf-8")

    # 2) UTM 49N GeoJSON（现场放样优先用这个，单位是米）
    gj_utm = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {
            "name": "urn:ogc:def:crs:EPSG::32649"}},
        "planting_points_meta": res["grid"],
        "features": [{
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [p["utm_x"], p["utm_y"]]},
            "properties": {k: v for k, v in p.items() if k not in ("utm_x", "utm_y")},
        } for p in pts],
    }
    (outdir / "planting-points-utm49n.geojson").write_text(
        json.dumps(gj_utm, ensure_ascii=False), encoding="utf-8")

    # 3) Shapefile ×2
    write_points_shp_zip(pts, outdir / "planting-points-wgs84-shp.zip",
                         projected=False, prj=PRJ_WGS84)
    write_points_shp_zip(pts, outdir / "planting-points-utm49n-shp.zip",
                         projected=True, prj=PRJ_UTM49N)

    # 4) KML（独立 Folder，Google Earth 里可单独开关）
    kml = ['<?xml version="1.0" encoding="UTF-8"?>',
           '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
           '<name>Forest Gap Detection · 补种放样点位</name>',
           '<Folder><name>补种放样点位</name>',
           '<open>1</open>']
    for p in pts:
        kml.append(
            f'<Placemark><name>{p["point_id"]}</name>'
            f'<description>缺口 {p["gap_id"]} · {p["class"]} · '
            f'退让 {p["clearance_m"]:g} m</description>'
            f'<Point><coordinates>{p["lon"]:.8f},{p["lat"]:.8f},0'
            f'</coordinates></Point></Placemark>')
    kml += ['</Folder>', '</Document></kml>']
    (outdir / "planting-points.kml").write_text("".join(kml), encoding="utf-8")

    # 5) CSV 放样坐标表（手持 GPS / 表格直接导入）
    rows = PP.points_to_csv_rows(pts)
    (outdir / "planting-points.csv").write_text(
        "\n".join(",".join(r) for r in rows), encoding="utf-8-sig")

    return res


def _kml_coords(ring) -> str:
    pts = [f"{x:.8f},{y:.8f},0" for x, y in ring]
    if pts[0].split(",")[:2] != pts[-1].split(",")[:2]:
        pts.append(pts[0])
    return " ".join(pts)


def write_kml(features, out: Path) -> tuple[int, int]:
    """写 KML：按类别分 Folder。返回 (placemark 数, folder 数)。"""
    by_class: dict[str, list] = {}
    for props, rings in features:
        by_class.setdefault(props["cls"], []).append((props, rings))

    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2">',
        "<Document>",
        "<name>油棕园需补种空地分布</name>",
    ]
    styles = {
        "vacant_slot": "ff0000ff", "alley_gap": "ff00a5ff",
        "open_patch": "ff00ffff", "uncertain": "ff808080",
        "road": "ff646464", "water": "ffff0000", "office": "ff00ffff",
    }
    for cls, color in styles.items():
        lines += [
            f'<Style id="s_{cls}">',
            "<LineStyle><color>ff000000</color><width>1</width></LineStyle>",
            f"<PolyStyle><color>{color}</color></PolyStyle>",
            "</Style>",
        ]

    pm = 0
    folder = 0
    for cls in CLASS_ORDER:
        if cls not in by_class:
            continue
        folder += 1
        label = CLASS_LABEL_CN.get(cls, cls)
        lines += [f"<Folder><name>{label}（{len(by_class[cls])}）</name>"]
        for props, rings in by_class[cls]:
            pm += 1
            for ring in rings:
                lines += [
                    "<Placemark>",
                    f"<name>{label} {props['gap_id']}</name>",
                    f"<description>面积 {props['area_sqm']:.1f} m²；"
                    f"判据 {props['cls_meth']}；置信度 {props['cls_conf']:.2f}</description>",
                    f'<styleUrl>#s_{cls}</styleUrl>',
                    "<Polygon><outerBoundaryIs><LinearRing><coordinates>",
                    _kml_coords(ring),
                    "</coordinates></LinearRing></outerBoundaryIs></Polygon>",
                    "</Placemark>",
                ]
        lines.append("</Folder>")
    lines += ["</Document>", "</kml>"]
    out.write_text("\n".join(lines), encoding="utf-8")
    return pm, folder


def main() -> int:
    ap = argparse.ArgumentParser(description="生成 ArcGIS / Google Earth 交付包")
    ap.add_argument("--input", default="output/wgr17-full-gaps.geojson",
                    help="整幅 GeoJSON（process_image.py 产出）")
    ap.add_argument("--outdir", default="output/arcgis", help="输出目录")
    ap.add_argument("--clearance-m", type=float, default=0.5,
                    help="补种点位的排坑退让距离（米）。默认 0.5 —— 依据见 "
                         "desktop/src/lib/estimate.ts 的 DEFAULT_GRID 注释"
                         "（open_patch 边界是树冠叶尖外缘，已距树干约 4.2 m）")
    ap.add_argument("--no-points", action="store_true", help="不生成补种点位图层")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        log(f"[错误] 找不到输入文件：{src}")
        log("       请先跑 scripts/process_image.py 生成整幅结果。")
        return 2

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    src_obj, features = load_features(src)
    total_area = sum(p["area_sqm"] for p, _ in features)
    log(f"读取 {src}：{len(features)} 个要素，总面积 {total_area:,.1f} m²")

    tr = Transformer.from_crs(WGS84, UTM49N, always_xy=True)

    # 1) WGS84 GeoJSON
    write_geojson_wgs84(features, src_obj, outdir / "gaps-all-wgs84.geojson")
    log("  ✓ gaps-all-wgs84.geojson")

    # 2) UTM GeoJSON
    write_geojson_utm(features, tr, outdir / "gaps-all-utm49n.geojson")
    log("  ✓ gaps-all-utm49n.geojson")

    # 3) Shapefile ×2
    n1 = write_shp_zip(features, outdir / "gaps-all-wgs84-shp.zip",
                       projected=False, prj=PRJ_WGS84)
    log(f"  ✓ gaps-all-wgs84-shp.zip（{n1} 要素）")
    n2 = write_shp_zip(features, outdir / "gaps-all-utm49n-shp.zip",
                       projected=True, tr=tr, prj=PRJ_UTM49N)
    log(f"  ✓ gaps-all-utm49n-shp.zip（{n2} 要素）")

    # 4) KML
    pm, folder = write_kml(features, outdir / "gaps-all.kml")
    log(f"  ✓ gaps-all.kml（{pm} Placemark / {folder} Folder）")

    # 5) 按类别拆分
    by_class_dir = outdir / "by-class"
    by_class_dir.mkdir(exist_ok=True)
    by_class: dict[str, list] = {}
    for props, rings in features:
        by_class.setdefault(props["cls"], []).append((props, rings))
    log("  按类别拆分：")
    for cls in CLASS_ORDER:
        if cls not in by_class:
            continue
        sub = by_class[cls]
        # 命名与 docs/07-检测成果/ArcGIS导入指南-专业版.html 承诺的清单一致
        z = by_class_dir / f"gaps-{cls}-utm49n-shp.zip"
        m = write_shp_zip(sub, z, projected=True, tr=tr, prj=PRJ_UTM49N)
        area = sum(p["area_sqm"] for p, _ in sub)
        log(f"    - {cls:<12} {m:>4} 要素  {area:>12,.1f} m²  → {z.name}")

    # 6) 补种点位（R-P1-7，2026-10-17）
    if not args.no_points:
        log("  补种点位：")
        try:
            pr = export_planting_points(src_obj, outdir,
                                        clearance_m=args.clearance_m)
            if pr["points"]:
                log(f"    - 共 {pr['total']} 个点位"
                    f"（网格排坑 {pr['by_source']['grid']} + 株位 {pr['by_source']['slot']}）"
                    f"，退让 {args.clearance_m:g} m")
                log("    - planting-points-wgs84.geojson / planting-points-utm49n.geojson")
                log("    - planting-points-wgs84-shp.zip / planting-points-utm49n-shp.zip")
                log("    - planting-points.kml / planting-points.csv")
                if pr["skipped_narrow"]:
                    log(f"    - 窄条提示：{len(pr['skipped_narrow'])} 块空地退让后放不下格点")
        except Exception as e:  # noqa: BLE001
            log(f"    ⚠️ 补种点位生成失败（其余交付物不受影响）：{e}")

    log(f"\n完成。交付包目录：{outdir}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
