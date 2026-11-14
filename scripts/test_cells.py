# -*- coding: utf-8 -*-
"""R13 合成回归：两块**相位不同**的种植区 + 一块横跨两者的大空地。

执行单 R13 验收 4：分单元相位落地后，空地每半边的放样点必须各自对准
本侧的格点，而不是两边都用同一个（全局 / 某一块的）相位。

纯合成点集、不读影像，秒级，进 check_all 第 12e 层。
跑法：.venv/Scripts/python.exe scripts/test_cells.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import box, mapping
from shapely.ops import transform as shp_transform

sys.path.insert(0, str(Path(__file__).resolve().parent))
import grid_prior as GP  # noqa: E402
import planting_points as PP  # noqa: E402
import process_image as PI  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}{'  ·  ' + detail if detail else ''}")
    if not ok:
        failures += 1


PITCH, ROW, SKEW, AZ = 8.45, 7.32, 4.225, 30.0
TO_LL = Transformer.from_crs("EPSG:32649", "EPSG:4326", always_xy=True)
A = np.array([500000.0, 100000.0])
B = A + np.array([PITCH / 2, 1.3])          # 第二块：起点错开半个株距 + 1.3 m
a1, a2, _k1, _k2 = GP._lattice_vectors(PITCH, ROW, SKEW, AZ)
rng = np.random.default_rng(20261110)


def block(origin: np.ndarray, x0: float, x1: float, y0: float, y1: float) -> np.ndarray:
    """一块种植区的树冠顶点：真实格点 + 0.15 m 抖动 + 10% 缺株。"""
    ij = np.array([(i, j) for i in range(-40, 130) for j in range(-40, 60)], dtype=float)
    nodes = origin + ij @ np.vstack([a1, a2])
    keep = ((nodes[:, 0] >= x0) & (nodes[:, 0] < x1)
            & (nodes[:, 1] >= y0) & (nodes[:, 1] < y1))
    pts = nodes[keep]
    pts = pts[rng.random(len(pts)) > 0.10]
    return pts + rng.normal(0, 0.15, pts.shape)


print("A. 构造两块相位不同的种植区 + 中间 400 m 宽的大空地")
topsA = block(A, 499800, 500300, 99900, 100300)
topsB = block(B, 500700, 500900, 99900, 100300)
tops = np.vstack([topsA, topsB])
kd = cKDTree(tops)
# 空地横跨 x=500300..500700；两端单元各自只"看得见"本侧的树
gap_utm = box(500300, 100000, 500700, 100200)
gap_ll = shp_transform(TO_LL.transform, gap_utm)
print(f"  · A 区 {len(topsA):,} 个顶点 / B 区 {len(topsB):,} 个 / 空地 {gap_utm.area:,.0f} m²")

cells = PI._lattice_cells_for_gap(gap_utm, kd, tops, PITCH, ROW, SKEW, AZ, TO_LL)
own = [c for c in cells if c["origin_utm"] is not None]
pool = [(c["ctr"], c["origin_utm"]) for c in own]
usable = PI.fill_cell_nearests(cells, pool, TO_LL)
n_own = sum(c["source"] == "own" for c in usable)
n_near = sum(c["source"] == "nearest" for c in usable)
check(len(cells) >= 6, "空地按 80 m 切成多个单元", f"{len(cells)} 个")
check(len(own) >= 2, "两端单元各自拿到本侧相位", f"{len(own)} 个 own")
check(len(usable) == len(cells), "腹地单元都沿用最近可信单元，没有丢单元",
      f"own {n_own} / nearest {n_near}")

print("\nB. 放样点：左半边对准 A 区格网，右半边对准 B 区格网")
cell_props = [{
    "cell": c["cell"],
    "origin_utm": [float(c["origin_utm"][0]), float(c["origin_utm"][1])],
    "origin_lonlat": [float(c["origin_lonlat"][0]), float(c["origin_lonlat"][1])],
    "rect_lonlat": [float(v) for v in c["rect_lonlat"]],
    "coherence": float(c["coherence"]), "support": int(c["support"]),
    "source": c["source"],
} for c in usable]
feat = {
    "type": "Feature", "geometry": mapping(gap_ll),
    "properties": {"gap_id": "SYN-cells", "class": "open_patch",
                   "area_sqm": float(gap_utm.area),
                   "lattice_phase": "cells", "lattice_cells": cell_props},
}
grid = GP.GridModel(plant_pitch_m=PITCH, row_pitch_m=ROW, skew_offset_m=SKEW,
                    origin_x_m=float(A[0]), origin_y_m=float(A[1]),
                    row_azimuth_deg=AZ, quality=0.9,
                    method=GP.PERIODOGRAM_METHOD, density_per_ha=160.0)
res = PP.generate_planting_points([feat], grid, clearance_m=0.5)
pts = np.array([[p["utm_x"], p["utm_y"]] for p in res["points"]]).reshape(-1, 2)
check(len(pts) > 100, "大空地排出了足量放样点", f"{len(pts)} 个")

# 到两块格网的距离（lattice_node_distance = 点到最近格点）
mid = 500500.0
left = pts[pts[:, 0] < mid]
right = pts[pts[:, 0] >= mid]
check(len(left) > 20 and len(right) > 20, "两半边都有点",
      f"左 {len(left)} / 右 {len(right)}")


def p50_to(pts_: np.ndarray, origin: np.ndarray) -> float:
    if len(pts_) == 0:
        return float("nan")
    return float(np.median(GP.lattice_node_distance(pts_, origin, PITCH, ROW, SKEW, AZ)))


dLA, dLB = p50_to(left, A), p50_to(left, B)
dRA, dRB = p50_to(right, A), p50_to(right, B)
print(f"  · 左半边 → A 格网 P50 {dLA:.3f} m / B 格网 {dLB:.3f} m")
print(f"  · 右半边 → A 格网 P50 {dRA:.3f} m / B 格网 {dRB:.3f} m")
check(dLA < 0.5, "★ 左半边对准 A 区格点（P50 < 0.5 m）", f"{dLA:.3f} m")
check(dRB < 0.5, "★ 右半边对准 B 区格点（P50 < 0.5 m）", f"{dRB:.3f} m")
check(dLB > 1.0 and dRA > 1.0,
      "★ 对照：用错相位时明显偏离（> 1 m，不是碰巧重合）",
      f"左→B {dLB:.3f} m / 右→A {dRA:.3f} m")

# 反例守卫：整块只用一个全局原点时，至少有一半点会明显偏掉
plain = dict(feat["properties"])
plain.pop("lattice_cells")
plain["lattice_phase"] = "global"
feat_plain = {"type": "Feature", "geometry": feat["geometry"], "properties": plain}
res_plain = PP.generate_planting_points([feat_plain], grid, clearance_m=0.5)
pts_plain = np.array([[p["utm_x"], p["utm_y"]] for p in res_plain["points"]]).reshape(-1, 2)
r_plain = pts_plain[pts_plain[:, 0] >= mid]
d_plain = p50_to(r_plain, B)
check(d_plain > 1.0, "对照：全局单相位时右半边对不准 B 区",
      f"P50 {d_plain:.3f} m")

print(f"\n{'✅ 全部通过' if failures == 0 else f'❌ {failures} 项失败'}")
sys.exit(0 if failures == 0 else 1)
