"""跨瓦片缝合（process_image._own_core / stitch_seams / finalize_features）的回归测试。

纯合成几何、不读影像，秒级，可进 CI。要守住的性质只有一句话：

    **缝合后的结果 = 假如这块空地从没被瓦片缝切开时的结果**

—— 面积不多不少、一块就是一块、类别按完整几何判，且与瓦片怎么切无关。
旧算法（质心判归属、几何原样保留）在这几条上全部失守，详见
docs/03-算法教学/评审文档_20261029001.md 缺陷 A / A′。

跑法：.venv/Scripts/python.exe scripts/test_stitch.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pyproj import Transformer  # noqa: E402
from shapely.geometry import box, shape  # noqa: E402
from shapely.ops import unary_union  # noqa: E402

import process_image as PI  # noqa: E402
from grid_prior import GridModel, classify_gaps, gap_geometry  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}{'  ·  ' + detail if detail else ''}")
    if not ok:
        failures += 1


SRC = "EPSG:4326"
TO_UTM = Transformer.from_crs(SRC, PI.TARGET_CRS, always_xy=True)
TO_SRC = Transformer.from_crs(PI.TARGET_CRS, SRC, always_xy=True)


def fwd(x, y, z=None):
    return TO_UTM.transform(x, y)


def bwd(x, y, z=None):
    return TO_SRC.transform(x, y)


# 真实园区附近；1e-5° ≈ 1.1 m。两块相邻 core：A 在左、B 在右，共享 x = XM 这条缝
X0, XM, X1, Y0, Y1 = 111.2000, 111.2006, 111.2012, 1.1800, 1.1806
CORE_A = box(X0, Y0, XM, Y1)
CORE_B = box(XM, Y0, X1, Y1)
GRID = GridModel(plant_pitch_m=8.45, row_pitch_m=7.3179, skew_offset_m=4.225,
                 origin_x_m=0.0, origin_y_m=0.0, row_azimuth_deg=0.6656,
                 quality=0.75, method="global_consensus", density_per_ha=161.7,
                 regularity=0.64)
ARGS = SimpleNamespace(min_area=30.0, node_tol_ratio=0.35, elongate_ratio=2.2,
                       min_coverage_for_slot=0.15, forest_mask=None)


def utm(g_src):
    return PI.shp_transform(fwd, g_src)


def tile_features(tile_id: str, core, gaps_src: list, cls_of=None) -> list[dict]:
    """模拟一块瓦片：它在外扩窗口里"看到"完整的空地，按新规则只输出 core 内那部分。"""
    out = []
    for n, g in enumerate(gaps_src, 1):
        for g_core, piece, seam in PI._own_core(utm(g), core, fwd, bwd):
            area = float(piece.area)
            if not seam and area < ARGS.min_area:
                continue
            gid = f"{tile_id}-G{n:04d}"
            if cls_of:
                out.append(PI._unplantable_feature(gid, piece, area, cls_of, g_core, seam))
            else:
                lab = classify_gaps([gap_geometry(piece, gid, area)], GRID)[0]
                out.append(PI._gap_feature(gid, piece, area, lab, g_core, seam))
    return out


def run(features: list[dict]) -> list[dict]:
    feats, _ct, _a = PI.finalize_features(json.loads(json.dumps(features)), GRID, ARGS, SRC,
                                         say=lambda m: None)
    return feats


def area_of(f: dict) -> float:
    return utm(shape(f["geometry"])).area


# ---------------------------------------------------------------- A. 跨缝大空地
print("A. 跨缝的连片空地：一块就是一块，面积不多不少")
big = box(XM - 0.00018, Y0 + 0.0001, XM + 0.00018, Y0 + 0.00028)   # ≈40 m × 20 m，压在缝上
feats = tile_features("A", CORE_A, [big]) + tile_features("B", CORE_B, [big])
check(len(feats) == 2 and all(f["properties"].get("_seam") for f in feats),
      "瓦片阶段：两边各输出 core 内的一半，并标记为跨缝碎块", str(len(feats)))
out = run(feats)
check(len(out) == 1, "★ 缝合后只剩 1 块（旧算法会两块各输出一次）", str(len(out)))
truth = utm(big).area
check(abs(area_of(out[0]) - truth) / truth < 1e-6, "★ 面积 = 完整空地面积（没有重叠带重复计数）",
      f"{area_of(out[0]):.2f} vs {truth:.2f} m²")
check(abs(out[0]["properties"]["area_sqm"] - truth) < 0.01, "area_sqm 属性与几何一致")
lab_truth = classify_gaps([gap_geometry(utm(big), "T", truth)], GRID)[0]["class"]
check(out[0]["properties"]["class"] == lab_truth,
      "★ 类别 = 按完整几何判出的类别（不是两半各判各的）",
      f"{out[0]['properties']['class']} vs {lab_truth}")
check("_seam" not in out[0]["properties"] and out[0]["properties"].get("seam_pieces") == 2,
      "内部标记已清除，记录了来自 2 块碎块")

# ---------------------------------------------------------------- B. 中等空地：两半各判会错类
print("\nB. 中等空地：两半各自不到一格，合起来是连片 —— 必须按完整几何判")
mid = box(XM - 0.00009, Y0 + 0.0003, XM + 0.00009, Y0 + 0.00039)   # ≈20 m × 10 m ≈ 200 m²
halves = tile_features("A", CORE_A, [mid]) + tile_features("B", CORE_B, [mid])
half_cls = {f["properties"]["class"] for f in halves}
merged = run(halves)
mid_truth = classify_gaps([gap_geometry(utm(mid), "T", utm(mid).area)], GRID)[0]["class"]
check(len(merged) == 1 and merged[0]["properties"]["class"] == mid_truth,
      "★ 缝合后类别 = 完整几何的类别", f"半块各判 {sorted(half_cls)} → 缝合后 {merged[0]['properties']['class']}")

# ---------------------------------------------------------------- C. min_area 只在缝合之后判
print("\nC. 面积门槛只在缝合后判")
s40 = box(XM - 0.000045, Y1 - 0.00008, XM + 0.000045, Y1 - 0.00004)  # ≈10 m × 4.4 m ≈ 44 m²
s24 = box(XM - 0.00003, Y0 + 0.00002, XM + 0.00003, Y0 + 0.000055)   # ≈6.7 m × 3.9 m ≈ 26 m²
pieces = tile_features("A", CORE_A, [s40, s24]) + tile_features("B", CORE_B, [s40, s24])
check(all(f["properties"]["area_sqm"] < 30 for f in pieces),
      "前提：每块碎块都 < 30 m²（瓦片阶段若照旧过门槛，两块空地都会丢）")
kept = run(pieces)
areas = sorted(round(f["properties"]["area_sqm"]) for f in kept)
check(len(kept) == 1 and areas[0] >= 30, "★ 44 m² 的空地被切成两半仍保留；26 m² 的缝合后照常丢弃",
      str(areas))

# ---------------------------------------------------------------- D. 不跨缝的块与贴影像边的块
print("\nD. 不跨缝的块原样保留（ID / 类别不变）")
inner = box(X0 + 0.0001, Y0 + 0.0001, X0 + 0.00018, Y0 + 0.00016)
fa = tile_features("A", CORE_A, [inner])
check(len(fa) == 1 and "_seam" not in fa[0]["properties"], "完整落在 core 内 → 不当碎块")
out = run(fa)
check(out[0]["properties"]["gap_id"] == fa[0]["properties"]["gap_id"]
      and out[0]["properties"]["class"] == fa[0]["properties"]["class"], "缝合后 ID 与类别不变")
edge = box(X0, Y0 + 0.0003, X0 + 0.0001, Y0 + 0.00038)               # 贴着影像左边缘
fe = tile_features("A", CORE_A, [edge])
out = run(fe)
check(len(out) == 1 and out[0]["properties"]["gap_id"] == fe[0]["properties"]["gap_id"],
      "贴影像边缘（没有邻居）→ 单块原样保留，ID 不变")

# ---------------------------------------------------------------- E. 类别分组与确定性
print("\nE. 分组与确定性")
road = box(XM - 0.0002, Y1 - 0.00003, XM + 0.0002, Y1 - 0.00001)
mix = (tile_features("A", CORE_A, [big]) + tile_features("B", CORE_B, [big])
       + tile_features("A", CORE_A, [road], cls_of="road")
       + tile_features("B", CORE_B, [road], cls_of="road"))
o1, o2 = run(mix), run(list(reversed(mix)))
check(sorted(f["properties"]["class"] for f in o1).count("road") == 1,
      "道路碎块按道路合并，不与空地混在一起")
sig = lambda fs: sorted((f["properties"]["gap_id"], f["properties"]["class"],  # noqa: E731
                         f["properties"]["area_sqm"]) for f in fs)
check(sig(o1) == sig(o2), "★ 输入顺序打乱，输出逐项一致（确定性）")

# ---------------------------------------------------------------- F. 不变性：换缝的位置，结果不变
print("\nF. 不变性：瓦片怎么切，结果都一样")
for xm2 in (XM - 0.0001, XM + 0.00007):
    a2, b2 = box(X0, Y0, xm2, Y1), box(xm2, Y0, X1, Y1)
    o = run(tile_features("A", a2, [big, mid]) + tile_features("B", b2, [big, mid]))
    tot = sum(area_of(f) for f in o)
    exp = utm(big).area + utm(mid).area
    check(len(o) == 2 and abs(tot - exp) / exp < 1e-6,
          f"缝挪到 x={xm2:.5f}：仍是 2 块、总面积不变", f"{len(o)} 块 / {tot:.1f} vs {exp:.1f} m²")

# ---------------------------------------------------------------- G. 林地掩膜：沿掩膜切开
print("\nG. 林地掩膜沿掩膜切开（不再由一个代表点决定整块）")
poly = box(X0 + 0.0003, Y0 + 0.0003, X0 + 0.0005, Y0 + 0.0005)        # ≈22 m 见方 ≈ 490 m²
base = tile_features("A", CORE_A, [poly])
a_total = area_of(base[0])


def masked(edge_x: float) -> list[dict]:
    """掩膜 = 影像左缘到 edge_x 的竖条；返回掩膜作用后的要素。"""
    with tempfile.TemporaryDirectory() as td:
        mk = Path(td) / "mask.geojson"
        g = box(X0, Y0, edge_x, Y1)
        mk.write_text(json.dumps({"type": "FeatureCollection", "features": [
            {"type": "Feature", "properties": {}, "geometry": g.__geo_interface__}]}),
            encoding="utf-8")
        ARGS.forest_mask = str(mk)
        try:
            return run(base)
        finally:
            ARGS.forest_mask = None


def split_of(fs: list[dict]) -> tuple[float, float]:
    und = sum(area_of(f) for f in fs if f["properties"]["class"] == "undeveloped")
    rest = sum(area_of(f) for f in fs if f["properties"]["class"] != "undeveloped")
    return und, rest


r = masked(X0 + 0.0003 + 0.000005)                                    # 只擦到 ~1 m 宽的边
check(len(r) == 1 and r[0]["properties"]["class"] != "undeveloped", "只擦到掩膜边（< 30 m²）→ 原样保留")
for pct, edge in ((30, X0 + 0.00036), (70, X0 + 0.00044)):
    r = masked(edge)
    und, rest = split_of(r)
    check(abs(und / a_total - pct / 100) < 0.01 and abs(und + rest - a_total) / a_total < 1e-6,
          f"★ {pct}% 在掩膜里 → 切开：掩膜内 {pct}% 划为未开发林、其余仍是空地，总面积守恒",
          f"未开发林 {und:.0f} m² + 空地 {rest:.0f} m² = {und + rest:.0f} / {a_total:.0f}")
    keep = [f for f in r if f["properties"]["class"] != "undeveloped"]
    lab = classify_gaps([gap_geometry(utm(shape(keep[0]["geometry"])), "T", area_of(keep[0]))], GRID)[0]
    check(keep[0]["properties"]["class"] == lab["class"] and keep[0]["properties"].get("mask_split"),
          f"掩膜外部分按切开后的几何重新分类（{pct}%）", keep[0]["properties"]["class"])
r = masked(X0 + 0.0005 - 0.000005)                                    # 只剩 ~1 m 宽在掩膜外
check(len(r) == 1 and r[0]["properties"]["class"] == "undeveloped", "几乎全在掩膜里（掩膜外 < 30 m²）→ 整块改判")

# ---------------------------------------------------------------- 汇总：无重叠
print("\nH. 缝合后的要素之间互不重叠")
allf = run(mix)
gs = [utm(shape(f["geometry"])) for f in allf if f["properties"]["class"] != "road"]
ov = sum(gs[i].intersection(gs[j]).area for i in range(len(gs)) for j in range(i + 1, len(gs)))
check(ov < 1e-6, "★ 空地之间重叠面积 = 0", f"{ov:.6f} m²")
check(abs(sum(g.area for g in gs) - unary_union(gs).area) < 1e-6, "逐块相加 = 并集（没有重复计数）")

print(f"\n{'✅ 全部通过' if failures == 0 else f'❌ {failures} 项失败'}")
sys.exit(0 if failures == 0 else 1)
