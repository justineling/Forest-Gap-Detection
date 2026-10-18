# -*- coding: utf-8 -*-
"""补种点位生成（需求 R-P1-7）。

把「需补种空地多边形」转成**可直接放样的 GPS 点位**：
现场工人 / 农机手拿手持 GPS 或大疆遥控器导入 `planting-points.csv` 就能找点。

与前端 `desktop/src/lib/estimate.ts` 的关系
==========================================
前端那份是**交互预览**（拖动滑块时毫秒级重算，用局部等距近似 + 自算原点）；
本模块是**权威结算**：坐标一律走 `GridModel` 的 UTM 49N 绝对格点
（`origin_x_m / origin_y_m` 是拟合出的真实格点，有物理意义），
并经 `pyproj` 严格换算经纬度。

算法要点（每一处都是踩过坑才定下来的）
=====================================
1. **退让用负向缓冲**：UTM 米制下，"点在内且距边界 ≥ d" 等价于
   "点在 `poly.buffer(-d)` 内"。好处：① 窄条收缩后为空可**直接跳过**（0 次点测试）；
   ② 天然处理带孔多边形（内环会随负缓冲扩大）；③ 比逐点算到所有边的距离快百倍。
2. **行内索引必须逐行反解**：格点沿行方向的投影是 `along_u = ix*pitch + iy*skew`，
   所以 `ix = (du - iy*skew) / pitch`。`iy*skew` 在远离原点的要素上可达 ±50 个格位，
   用全局 `ix_min/ix_max` 一次算死会让远处要素**一个点都取不到**
   （前端实测症状：5,771 m² 的连片空地排坑得 0 株）。
3. **株位空缺按 1 株**：`vacant_slot` 是"一个种植单元里少了 1 棵树"，不走网格。
   点位取质心，但**凹多边形（L 形/月牙形）的质心可能落在多边形外**，
   此时回退 `representative_point()`（保证在内部）。
4. **跨多边形去重**：相邻/重叠的多边形可能覆盖同一个格点，同一坐标只保留一次。
"""

from __future__ import annotations

import math
from typing import Any, Iterable

from pyproj import Transformer
from shapely.geometry import Point, shape
from shapely.ops import transform as shp_transform
from shapely.prepared import prep

TARGET_CRS = "EPSG:32649"      # UTM 49N（与 grid_prior.TARGET_CRS 一致）
WGS84 = "EPSG:4326"

# 参与排坑的类别（与前端 estimate.ts 的 PLANTABLE_CLASSES 保持一致）
PLANTABLE_CLASSES = ("open_patch", "vacant_slot", "manual_add")

# 单个多边形最多枚举多少候选格点（护栏：极端形状下别把主线程拖死）
MAX_CANDIDATES = 200_000


def _to_utm(geom_wgs):
    tr = Transformer.from_crs(WGS84, TARGET_CRS, always_xy=True)
    return shp_transform(tr.transform, geom_wgs)


def _utm_to_wgs(x: float, y: float) -> tuple[float, float]:
    tr = Transformer.from_crs(TARGET_CRS, WGS84, always_xy=True)
    lon, lat = tr.transform(x, y)
    return float(lon), float(lat)


def grid_anchor_wgs84(grid, lon: float, lat: float) -> dict[str, Any]:
    """把 `planting_grid` 补成**前端可直接用**的版本（含 WGS84 锚点）。

    做法：给定一个经纬度（通常是结果范围中心），找**最近的那个格点**，
    把它的经纬度作为 `anchor_lon / anchor_lat` 返回。

    为什么需要：`origin_x_m / origin_y_m` 是 UTM 49N 下的数学锚点，
    可能离园区几百公里（本园区 451 km），前端在经纬度空间没法直接拿它铺格点。
    有了 anchor，前端用 anchor + 同样的 pitch/row/skew/azimuth 就能重建
    **逐格一致**的格点集合 —— 这是前端 3,912 株与 Python 对得上的唯一前提
    （不用 anchor 而用"首个顶点均值"时，相位任意，实测差 +8.8%）。

    ⚠️ 这个函数是**唯一实现**：`tile_server.py` 的 `/gaps` 与
    `planting_points.py` 的 `--emit-grid` 都调它，避免两处漂移。
    """
    fwd = Transformer.from_crs(WGS84, TARGET_CRS, always_xy=True)
    inv = Transformer.from_crs(TARGET_CRS, WGS84, always_xy=True)

    pitch = float(grid["plant_pitch_m"])
    row = float(grid["row_pitch_m"])
    skew = float(grid.get("skew_offset_m") or pitch / 2.0)
    az = float(grid.get("row_azimuth_deg") or grid.get("azimuth_deg") or 0.0)
    ox = float(grid["origin_x_m"])
    oy = float(grid["origin_y_m"])

    a = math.radians(az)
    ux, uy = math.cos(a), math.sin(a)
    vx, vy = -math.sin(a), math.cos(a)

    e, n = fwd.transform(lon, lat)
    du = (e - ox) * ux + (n - oy) * uy
    dv = (e - ox) * vx + (n - oy) * vy
    iy = round(dv / row)
    ix = round((du - iy * skew) / pitch)
    ge = ox + (ix * pitch + iy * skew) * ux + iy * row * vx
    gn = oy + (ix * pitch + iy * skew) * uy + iy * row * vy
    alon, alat = inv.transform(ge, gn)

    out = dict(grid)
    out["anchor_lon"] = round(float(alon), 9)
    out["anchor_lat"] = round(float(alat), 9)
    out["anchor_ix"] = int(ix)
    out["anchor_iy"] = int(iy)
    out["azimuth_deg"] = az            # 前端 GridSpec 字段名
    out["skew_offset_m"] = skew
    out["crs"] = TARGET_CRS
    return out


def features_center_wgs84(features: Iterable[dict]) -> tuple[float, float]:
    """结果要素外接框的中心（经纬度）。"""
    minx = miny = float("inf")
    maxx = maxy = -float("inf")
    for f in features:
        geom = f.get("geometry") or {}
        gtype = geom.get("type")
        coords = geom.get("coordinates") or []
        if gtype == "Polygon":
            rings = coords[:1]
        elif gtype == "MultiPolygon":
            rings = [poly[0] for poly in coords if poly]
        else:
            continue
        for ring in rings:
            for pt in ring:
                if len(pt) < 2:
                    continue
                x, y = float(pt[0]), float(pt[1])
                minx = min(minx, x)
                maxx = max(maxx, x)
                miny = min(miny, y)
                maxy = max(maxy, y)
    if minx == float("inf"):
        return 0.0, 0.0
    return (minx + maxx) / 2.0, (miny + maxy) / 2.0


def _slot_point(poly_utm) -> Point:
    """株位空缺的点位：优先质心，落在多边形外则回退 representative_point。

    凹多边形（L 形、月牙形）的质心可能跑到外面 —— 现场按那个点去种就种到树上了。
    """
    c = poly_utm.centroid
    if poly_utm.contains(c):
        return c
    return poly_utm.representative_point()


def _grid_points_in(poly_utm, grid, clearance_m: float) -> list[tuple[float, float]]:
    """在一个多边形内枚举落在「退让后区域」里的格点，返回 UTM 坐标列表。"""
    inner = poly_utm.buffer(-clearance_m) if clearance_m > 0 else poly_utm
    if inner.is_empty or inner.area <= 0:
        return []

    # 预取网格基矢（避免每次 node_at 重算三角函数）
    a = math.radians(grid.row_azimuth_deg)
    ux, uy = math.cos(a), math.sin(a)          # 行方向单位向量
    vx, vy = -math.sin(a), math.cos(a)         # 行间方向（垂直于行）
    ox, oy = float(grid.origin_x_m), float(grid.origin_y_m)
    pitch = float(grid.plant_pitch_m)
    row = float(grid.row_pitch_m)
    skew = float(grid.skew_offset_m)

    # inner 的四个角点 → (du, dv) 范围
    minx, miny, maxx, maxy = inner.bounds
    dus, dvs = [], []
    for px, py in ((minx, miny), (maxx, miny), (maxx, maxy), (minx, maxy)):
        dx, dy = px - ox, py - oy
        dus.append(dx * ux + dy * uy)          # along_u
        dvs.append(dx * vx + dy * vy)          # along_v
    du_min, du_max = min(dus), max(dus)
    dv_min, dv_max = min(dvs), max(dvs)

    iy_lo = math.floor(dv_min / row) - 1
    iy_hi = math.ceil(dv_max / row) + 1

    # 护栏：候选数量按「行数 × 行内跨度」估
    span = math.ceil((du_max - du_min) / pitch) + 4
    if (iy_hi - iy_lo + 1) * span > MAX_CANDIDATES:
        return []

    prepared = prep(inner)
    out: list[tuple[float, float]] = []
    for iy in range(iy_lo, iy_hi + 1):
        along_v = iy * row
        shift = iy * skew
        # ⚠️ 逐 iy 反解 ix 范围（见模块 docstring 第 2 条）
        ix_lo = math.floor((du_min - shift) / pitch) - 1
        ix_hi = math.ceil((du_max - shift) / pitch) + 1
        for ix in range(ix_lo, ix_hi + 1):
            along_u = ix * pitch + shift
            x = ox + along_u * ux + along_v * vx
            y = oy + along_u * uy + along_v * vy
            if prepared.contains(Point(x, y)):
                out.append((x, y))
    return out


def generate_planting_points(
    features: Iterable[dict],
    grid,
    clearance_m: float = 0.5,
) -> dict[str, Any]:
    """生成补种点位。

    参数
    ----
    features : 检测结果的 gaps 列表（`blocks[*].gaps`），几何为 EPSG:4326
    grid     : `grid_prior.GridModel`（UTM 49N 米制，含绝对原点）
    clearance_m : 距多边形边界的退让距离（默认 0.5 m，依据见
                  `desktop/src/lib/estimate.ts` 的 DEFAULT_GRID 注释）

    返回
    ----
    {
      "points": [ {point_id, gap_id, class, source, lon, lat, utm_x, utm_y,
                   clearance_m, edge_dist_m}, ... ],
      "by_class": {class: count},
      "by_source": {"grid": n, "slot": n},
      "total": n,
      "skipped_narrow": [gap_id, ...],   # 负缓冲后为空（窄条排不下点）
      "grid": {...},                     # 本次使用的网格参数（便于复现）
    }
    """
    tr_to_utm = Transformer.from_crs(WGS84, TARGET_CRS, always_xy=True)
    tr_to_wgs = Transformer.from_crs(TARGET_CRS, WGS84, always_xy=True)

    points: list[dict] = []
    by_class: dict[str, int] = {}
    by_source = {"grid": 0, "slot": 0}
    skipped_narrow: list[str] = []
    seen: set[tuple[int, int]] = set()      # 去重：UTM 坐标取整到 cm
    seq = 0

    for f in features:
        pr = f.get("properties") or {}
        cls = pr.get("class")
        if cls not in PLANTABLE_CLASSES:
            continue
        gap_id = str(pr.get("gap_id") or "")
        try:
            poly_wgs = shape(f["geometry"])
        except Exception:  # noqa: BLE001
            continue
        if poly_wgs.is_empty:
            continue
        poly_utm = shp_transform(tr_to_utm.transform, poly_wgs)

        if cls == "vacant_slot":
            # 一个种植单元缺 1 棵树 → 固定 1 个点
            pt = _slot_point(poly_utm)
            cand = [(pt.x, pt.y)]
            source = "slot"
        else:
            cand = _grid_points_in(poly_utm, grid, clearance_m)
            source = "grid"
            if not cand:
                # 负缓冲后为空，或枚举后无点 → 记为"窄条排不下"
                if poly_utm.buffer(-clearance_m).is_empty if clearance_m > 0 else False:
                    skipped_narrow.append(gap_id)
                continue

        n_here = 0
        for x, y in cand:
            key = (int(round(x * 100)), int(round(y * 100)))
            if key in seen:
                continue
            seen.add(key)
            lon, lat = tr_to_wgs.transform(x, y)
            seq += 1
            points.append({
                "point_id": f"P{seq:06d}",
                "gap_id": gap_id,
                "class": cls,
                "source": source,
                "lon": round(float(lon), 8),
                "lat": round(float(lat), 8),
                "utm_x": round(float(x), 2),
                "utm_y": round(float(y), 2),
                "clearance_m": float(clearance_m),
            })
            n_here += 1

        if n_here:
            by_class[cls] = by_class.get(cls, 0) + n_here
            by_source[source] += n_here

    return {
        "points": points,
        "total": len(points),
        "by_class": by_class,
        "by_source": by_source,
        "skipped_narrow": skipped_narrow,
        "grid": {
            "plant_pitch_m": round(float(grid.plant_pitch_m), 4),
            "row_pitch_m": round(float(grid.row_pitch_m), 4),
            "skew_offset_m": round(float(grid.skew_offset_m), 4),
            "row_azimuth_deg": round(float(grid.row_azimuth_deg), 4),
            "origin_x_m": round(float(grid.origin_x_m), 3),
            "origin_y_m": round(float(grid.origin_y_m), 3),
            "quality": round(float(getattr(grid, "quality", 0.0)), 4),
            "method": str(getattr(grid, "method", "")),
            "clearance_m": float(clearance_m),
            "crs": TARGET_CRS,
        },
    }


def points_to_csv_rows(points: list[dict]) -> list[list[str]]:
    """转成 CSV 行（含表头）。字段顺序为现场 GPS 导入常用顺序。"""
    rows = [["point_id", "gap_id", "class", "lon", "lat",
             "utm_x", "utm_y", "clearance_m"]]
    for p in points:
        rows.append([
            p["point_id"], p["gap_id"], p["class"],
            f"{p['lon']:.8f}", f"{p['lat']:.8f}",
            f"{p['utm_x']:.2f}", f"{p['utm_y']:.2f}",
            f"{p['clearance_m']:g}",
        ])
    return rows


# ---------------------------------------------------------------------------
# 自测（不依赖真实数据）
# ---------------------------------------------------------------------------
def _selftest() -> None:
    from grid_prior import GridModel

    print("=== planting_points 自测 ===")
    ok = 0
    fail = 0

    def chk(cond, msg):
        nonlocal ok, fail
        if cond:
            print(f"  [OK ] {msg}")
            ok += 1
        else:
            print(f"  [FAIL] {msg}")
            fail += 1

    # 构造一个 8.45×7.32、错行半株距、原点在 UTM (500000, 100000) 的网格
    g = GridModel(
        plant_pitch_m=8.45, row_pitch_m=7.32, skew_offset_m=8.45 / 2,
        origin_x_m=500000.0, origin_y_m=100000.0, row_azimuth_deg=0.0,
        quality=0.9, method="selftest", density_per_ha=161.7,
    )

    # 一个 60×60 m 的正方形空地（UTM），转回经纬度喂进函数
    from shapely.geometry import box as _box
    tr_back = Transformer.from_crs(TARGET_CRS, WGS84, always_xy=True)
    sq = _box(500000, 100000, 500060, 100060)
    sq_wgs = shp_transform(tr_back.transform, sq)
    feat = {"type": "Feature",
            "geometry": sq_wgs.__geo_interface__,
            "properties": {"gap_id": "T1", "class": "open_patch"}}

    r = generate_planting_points([feat], g, clearance_m=0.5)
    # 60×60 = 3600 m²，退让 0.5 后 59×59，格点密度 1/61.85 m² → 期望 ~56 个
    chk(40 <= r["total"] <= 70, f"60×60 空地排坑数合理（{r['total']} 个）")

    # 所有点必须在退让后的区域内
    from shapely.geometry import Point as _P
    inner = sq.buffer(-0.5)
    all_in = all(inner.contains(_P(p["utm_x"], p["utm_y"])) for p in r["points"])
    chk(all_in, "所有点位落在退让后的区域内")

    # 退让越大，点数越少
    r2 = generate_planting_points([feat], g, clearance_m=3.0)
    chk(r2["total"] < r["total"], f"退让 3 m 少于 0.5 m（{r2['total']} < {r['total']}）")

    # 窄条：2 m 宽、20 m 长 → 退让 0.5 后有 1 m 宽，可能有点；退让 2 m 后为空
    strip = _box(500200, 100000, 500220, 100002)
    strip_wgs = shp_transform(tr_back.transform, strip)
    fs = {"type": "Feature", "geometry": strip_wgs.__geo_interface__,
          "properties": {"gap_id": "T2", "class": "open_patch"}}
    r3 = generate_planting_points([fs], g, clearance_m=2.0)
    chk(r3["total"] == 0, "2 m 宽窄条 + 2 m 退让 → 0 株")
    chk("T2" in r3["skipped_narrow"], "窄条被记录进 skipped_narrow")

    # 株位空缺：无论大小都记 1 株
    slot = _box(500400, 100000, 500408, 100008)
    slot_wgs = shp_transform(tr_back.transform, slot)
    fslot = {"type": "Feature", "geometry": slot_wgs.__geo_interface__,
             "properties": {"gap_id": "T3", "class": "vacant_slot"}}
    r4 = generate_planting_points([fslot], g, clearance_m=2.0)
    chk(r4["total"] == 1, f"株位空缺固定 1 株（{r4['total']}）")
    chk(r4["by_source"]["slot"] == 1, "source 标记为 slot")

    # 凹多边形（L 形）的株位：点必须落在多边形内部
    from shapely.geometry import Polygon as _Poly
    L = _Poly([(500600, 100000), (500640, 100000), (500640, 100010),
               (500610, 100010), (500610, 100040), (500600, 100040)])
    L_wgs = shp_transform(tr_back.transform, L)
    fL = {"type": "Feature", "geometry": L_wgs.__geo_interface__,
          "properties": {"gap_id": "T4", "class": "vacant_slot"}}
    r5 = generate_planting_points([fL], g, clearance_m=0.5)
    chk(r5["total"] == 1, "L 形株位 1 个点")
    if r5["total"] == 1:
        p = r5["points"][0]
        chk(L.contains(_P(p["utm_x"], p["utm_y"])), "L 形点位落在多边形内部（质心越界保护）")

    # 跨多边形去重：两个重叠的多边形不应重复计点
    f1 = {"type": "Feature", "geometry": sq_wgs.__geo_interface__,
          "properties": {"gap_id": "D1", "class": "open_patch"}}
    f2 = {"type": "Feature", "geometry": sq_wgs.__geo_interface__,
          "properties": {"gap_id": "D2", "class": "open_patch"}}
    rd = generate_planting_points([f1, f2], g, clearance_m=0.5)
    chk(rd["total"] == r["total"], f"重叠多边形去重（{rd['total']} == {r['total']}）")

    # CSV 行
    rows = points_to_csv_rows(r["points"][:2])
    chk(len(rows) == 3 and rows[0][0] == "point_id", "CSV 表头正确")

    print(f"\n自测结果：{ok} 通过 / {fail} 失败")
    if fail:
        raise SystemExit(1)


if __name__ == "__main__":
    import argparse
    import json
    from pathlib import Path

    ap = argparse.ArgumentParser(
        description="补种点位生成 / 种植网格锚点导出（无参数时跑自测）"
    )
    ap.add_argument("--input", default="output/wgr17-final-gaps.geojson",
                    help="检测结果 GeoJSON（默认用交付版 final；elev 是未应用森林掩膜的中间版，"
                         "两者 open_patch/vacant_slot 差 18 块，点位会多 221 个）")
    ap.add_argument("--emit-grid", default="output/planting-grid.json",
                    help="把含 WGS84 锚点的 planting_grid 写到这个文件（供前端对齐相位）")
    ap.add_argument("--no-emit-grid", action="store_true", help="不写网格锚点文件")
    ap.add_argument("--selftest", action="store_true", help="只跑自测")
    a = ap.parse_args()

    if a.selftest or (not Path(a.input).exists()):
        if not a.selftest:
            print(f"⚠️ 找不到 {a.input}，改跑自测")
        _selftest()
        raise SystemExit(0)

    data = json.loads(Path(a.input).read_text(encoding="utf-8"))
    grid = data.get("planting_grid")
    if not isinstance(grid, dict):
        print(f"❌ {a.input} 里没有 planting_grid，无法导出锚点")
        raise SystemExit(2)

    feats = [f for blk in (data.get("blocks") or []) for f in (blk.get("gaps") or [])]
    if not feats:
        feats = data.get("features") or []
    lon, lat = features_center_wgs84(feats)
    enriched = grid_anchor_wgs84(grid, lon, lat)
    print(f"结果中心: ({lon:.7f}, {lat:.7f})")
    print(f"最近格点: ix={enriched['anchor_ix']} iy={enriched['anchor_iy']} "
          f"→ ({enriched['anchor_lon']:.7f}, {enriched['anchor_lat']:.7f})")

    # 三档参考株数：给前端测试做对账基准（否则前端只能硬编码数字，换数据就废）
    from grid_prior import GridModel

    gm = GridModel(
        plant_pitch_m=grid["plant_pitch_m"], row_pitch_m=grid["row_pitch_m"],
        skew_offset_m=grid["skew_offset_m"],
        origin_x_m=grid["origin_x_m"], origin_y_m=grid["origin_y_m"],
        row_azimuth_deg=grid["row_azimuth_deg"],
        quality=grid.get("quality", 0.0), method=grid.get("method", ""),
        density_per_ha=grid.get("density_per_ha", 0.0),
    )
    refs = {}
    for clr in (0.5, 1.0, 2.0):
        refs[f"{clr:.1f}"] = generate_planting_points(feats, gm, clearance_m=clr)["total"]
    enriched["reference_totals"] = refs
    print("参考株数（Python 权威）：" + "  ".join(f"{k} m → {v}" for k, v in refs.items()))

    if not a.no_emit_grid:
        out = Path(a.emit_grid)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(enriched, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"已写入 {out}（{out.stat().st_size} B）")
    print(f"要素数: {len(feats)}")
