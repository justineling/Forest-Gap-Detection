# -*- coding: utf-8 -*-
"""R1 共用夹具：Python `planting_points` 与前端 `estimate()` 逐点对账。

为什么要有这份"两端读同一个 JSON"的夹具（执行单 R1 验收 2）
------------------------------------------------------------
交付导出走 Python（UTM 绝对格点 + pyproj 严格换算），地图预览走 TS
（局部等距近似）。同一块空地，两边算出来的株位**必须逐点一致**：
否则现场按 CSV 放样、办公室在地图上看的却是另一个位置，几乎没有比这更糟的错。

第四轮之前两边"株位空缺吸附"的写法就不一样（Python 用 xy_to_grid 各自 round，
TS 试 floor/ceil 两行取近者），交付点与地图点能差一整个株距。R1 修好 Python 后，
用这份夹具把一致性钉死；以后任一侧再改算法，CI 会立刻报出来。

夹具内容
--------
`desktop/tests/fixtures/points-shared.json`（**入库**，TS 测试不需要 Python 环境）：
  · grid        —— 给 TS `estimate({planting_grid})` 的网格参数与全局锚点
  · clearance_m —— 退让
  · features    —— 同一组 GeoJSON：凸形株位 / 凹形株位 / 改判来的株位 / 带洞多边形
                    / 无局部相位的连片空地，每块都带 `lattice_origin_utm` 与
                    `lattice_origin_lonlat`（两者由 pyproj 严格互算，不能各写各的）
  · python_points —— Python `generate_planting_points()` 的权威结果

用法
----
    .venv/Scripts/python.exe scripts/test_shared_points.py            # 重新生成夹具
    .venv/Scripts/python.exe scripts/test_shared_points.py --verify   # 校验已提交夹具仍与 Python 一致

`--verify` 进 `check_all.py` 第 12d 层：防止有人改了 Python 算法却忘了重生成夹具，
让 TS 侧的"对账"变成和一份过期答案对账。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from pyproj import Transformer  # noqa: E402
from shapely.geometry import Point, Polygon, box, mapping  # noqa: E402
from shapely.ops import transform as shp_transform  # noqa: E402

import grid_prior as GP  # noqa: E402
from planting_points import generate_planting_points  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "desktop" / "tests" / "fixtures" / "points-shared.json"

TARGET_CRS = "EPSG:32649"       # UTM 49N
WGS84 = "EPSG:4326"
CLEARANCE_M = 0.5

# 用**旋转**格网（30°），别用 0°：0° 会把"投影到 (du,dv)"这一步退化成坐标轴，
# 掩盖错行 / 方位相关的错误。株距行距沿用本园实测规格。
PITCH = 8.45
ROW = 7.32
SKEW = PITCH / 2
AZ = 30.0
ORIGIN_X, ORIGIN_Y = 522700.0, 131500.0

TR_TO_WGS = Transformer.from_crs(TARGET_CRS, WGS84, always_xy=True)


def to_lonlat(x: float, y: float) -> list[float]:
    lon, lat = TR_TO_WGS.transform(x, y)
    return [float(lon), float(lat)]


def grid_model() -> GP.GridModel:
    return GP.GridModel(
        plant_pitch_m=PITCH, row_pitch_m=ROW, skew_offset_m=SKEW,
        origin_x_m=ORIGIN_X, origin_y_m=ORIGIN_Y, row_azimuth_deg=AZ,
        quality=0.9, method="fixture", density_per_ha=1e4 / (PITCH * ROW),
    )


def nearby_node(target: tuple[float, float], base: tuple[float, float] | None = None) -> tuple[float, float]:
    """取 base 格网上离 target 最近的一个**格点**当局部相位原点。

    为什么要绕这一圈：TS 用局部等距近似（metersPerDeg），Python 用 UTM
    （含 k0=0.9996 的投影比例）。离原点 500 m 时两者能差 25 cm —— 这是
    **既有口径差异，不是 R1 的 bug**，但会淹没 < 1 cm 的对账线。
    真实结果里 ``lattice_origin_utm`` 本来就是"这块空地附近的格点"
    （`lattice_phase_origin` 按空地质心求得），所以夹具也要照做：
    把原点平移若干个整格（**格点集合完全不变**），让两端都在要素附近比较。
    """
    bx, by = base if base is not None else (ORIGIN_X, ORIGIN_Y)
    a = math.radians(AZ)
    ux, uy, vx, vy = math.cos(a), math.sin(a), -math.sin(a), math.cos(a)
    dx, dy = target[0] - bx, target[1] - by
    j = round((dx * vx + dy * vy) / ROW)
    i = round((dx * ux + dy * uy - j * SKEW) / PITCH)
    # 平移 (i, j) 个基矢 = 同一个格点集合换一个 (0,0)
    return (bx + i * PITCH * ux + j * SKEW * ux + j * ROW * vx,
            by + i * PITCH * uy + j * SKEW * uy + j * ROW * vy)


def feature(gap_id: str, cls: str, geom, local_origin: tuple[float, float] | None):
    """UTM 几何 → WGS84 GeoJSON，并写入两端各自读的局部相位属性。"""
    geom_wgs = shp_transform(TR_TO_WGS.transform, geom)
    props: dict = {"gap_id": gap_id, "class": cls, "area_sqm": round(float(geom.area), 3)}
    if local_origin is not None:
        props["lattice_origin_utm"] = [round(local_origin[0], 6), round(local_origin[1], 6)]
        props["lattice_origin_lonlat"] = [round(v, 10) for v in to_lonlat(*local_origin)]
        props["lattice_phase"] = "local"
    return {"type": "Feature", "geometry": mapping(geom_wgs), "properties": props}


def build_features() -> list[dict]:
    feats: list[dict] = []

    # ① 凸形株位空缺 —— R1 的反例坐标（审查探针在 30° 格网上实测）：
    #    质心离真最近格点 4.342 m，旧 xy_to_grid+round 会选到隔壁行的格点（偏一个株距）。
    p1 = (522681.0796, 131500.7145)
    feats.append(feature("S1-convex-slot", "vacant_slot",
                         box(p1[0] - 6, p1[1] - 6, p1[0] + 6, p1[1] + 6),
                         nearby_node(p1)))

    # ② 凹形（L 形）株位空缺：质心必须仍在面内，否则两边"面内点"的取法不同，
    #    测的就不是吸附算法而是回退策略了。这里用一个浅缺口的 L 形。
    L = Polygon([
        (522800.0, 131600.0), (522824.0, 131600.0), (522824.0, 131612.0),
        (522812.0, 131612.0), (522812.0, 131624.0), (522800.0, 131624.0),
    ])
    assert L.contains(L.centroid), "凹形用例的质心必须落在面内"
    feats.append(feature("S2-concave-slot", "vacant_slot", L,
                         nearby_node((float(L.centroid.x), float(L.centroid.y)))))

    # ③ 人工改判来的株位空缺（原本是连片空地大小，改判后固定 1 株）——
    #    这是 R1 描述里最容易触发的真实场景：质心本来离格点 3.7~4.9 m。
    c3 = (522910.0, 131710.0)
    feats.append(feature("S3-relabeled-slot", "vacant_slot",
                         box(522900.0, 131700.0, 522920.0, 131720.0),
                         nearby_node(c3)))

    # ④ 带洞多边形（连片空地）：格点必须避开内环，且用**另一个局部相位**，
    #    验证"每块空地各自原点"在两端一致。
    outer = box(523002.0, 131802.0, 523034.0, 131834.0)
    hole = box(523013.0, 131813.0, 523023.0, 131823.0)
    with_hole = Polygon(outer.exterior.coords, [hole.exterior.coords])
    phase_base = (ORIGIN_X + 2.3, ORIGIN_Y - 1.7)     # 与全局相位不同的另一块
    feats.append(feature("S4-open-with-hole", "open_patch", with_hole,
                         nearby_node((523018.0, 131818.0), base=phase_base)))

    # ⑤ 没有局部相位的连片空地（手画 / 编辑过）：两端都必须退回全局锚点。
    #    ⚠️ 必须放在全局锚点附近：TS 的局部等距近似与 UTM 的 k0=0.9996 差异
    #    随离原点距离线性增长（实测 566 m → 25 cm），放远了会淹没 1 cm 对账线。
    feats.append(feature("S5-open-global", "open_patch",
                         box(522707.0, 131507.0, 522717.0, 131517.0), None))

    return feats


def python_points(feats: list[dict]) -> list[dict]:
    g = grid_model()
    out: list[dict] = []
    # 逐块跑：跨要素去重是 R3 的范围，这里要卡的是"同一块空地两端逐点一致"，
    # 逐块比较比整组比较更严格（整组时两块互相去重可能掩盖各自多算/少算）。
    for f in feats:
        r = generate_planting_points([f], g, clearance_m=CLEARANCE_M)
        for p in r["points"]:
            out.append({
                "gap_id": p["gap_id"],
                "lon": float(p["lon"]),
                "lat": float(p["lat"]),
                "utm_x": float(p["utm_x"]),
                "utm_y": float(p["utm_y"]),
            })
    return out


def build_fixture() -> dict:
    feats = build_features()
    pts = python_points(feats)
    anchor = to_lonlat(ORIGIN_X, ORIGIN_Y)
    return {
        "schema": "fgd-points-fixture/1",
        "description": "R1 共用夹具：Python planting_points 与 TS estimate 逐点对账（< 1 cm）",
        "grid": {
            "plant_pitch_m": PITCH,
            "row_pitch_m": ROW,
            "skew_offset_m": SKEW,
            "row_azimuth_deg": AZ,
            "azimuth_deg": AZ,
            "anchor_lon": anchor[0],
            "anchor_lat": anchor[1],
            "quality": 0.9,
        },
        "clearance_m": CLEARANCE_M,
        "features": feats,
        "python_points": pts,
    }


def verify(data: dict) -> int:
    """校验入库夹具仍与 Python 当前实现逐点一致。"""
    expected = python_points(data["features"])
    got = data["python_points"]
    failures = 0

    def chk(ok: bool, label: str, detail: str = "") -> None:
        nonlocal failures
        print(f"  [{'OK  ' if ok else 'FAIL'}] {label}{'  ·  ' + detail if detail else ''}")
        if not ok:
            failures += 1

    chk(len(expected) == len(got), "点数一致", f"Python {len(expected)} / 夹具 {len(got)}")
    if len(expected) == len(got):
        worst = 0.0
        for a, b in zip(expected, got):
            if a["gap_id"] != b["gap_id"]:
                chk(False, "gap_id 顺序一致", f"{a['gap_id']} vs {b['gap_id']}")
                break
            worst = max(worst, math.hypot(a["utm_x"] - b["utm_x"],
                                          a["utm_y"] - b["utm_y"]))
        else:
            chk(worst < 0.01, "逐点 UTM 距离 < 1 cm", f"最大 {worst:.4f} m")
    # 每类用例都必须真的产生点，否则"两边都是 0 点"也能假装通过
    by_gap: dict[str, int] = {}
    for p in got:
        by_gap[p["gap_id"]] = by_gap.get(p["gap_id"], 0) + 1
    for f in data["features"]:
        gid = f["properties"]["gap_id"]
        chk(by_gap.get(gid, 0) >= 1, f"{gid} 有点位", f"{by_gap.get(gid, 0)} 个")
    chk(by_gap.get("S4-open-with-hole", 0) > 5, "带洞多边形排坑数合理",
        f"{by_gap.get('S4-open-with-hole', 0)} 个")

    print(f"\n{'✅ 全部通过' if failures == 0 else f'❌ {failures} 项失败'}")
    return 0 if failures == 0 else 1


def main() -> int:
    if "--verify" in sys.argv:
        if not FIXTURE.exists():
            print(f"[FAIL] 找不到夹具 {FIXTURE}；先不带参数跑一次生成")
            return 1
        print("=== R1 共用夹具校验（Python 侧） ===")
        return verify(json.loads(FIXTURE.read_text(encoding="utf-8")))

    data = build_fixture()
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已生成 {FIXTURE.relative_to(ROOT)}：{len(data['features'])} 个要素 / "
          f"{len(data['python_points'])} 个权威点")
    print("=== 生成后即时校验 ===")
    return verify(data)


if __name__ == "__main__":
    sys.exit(main())
