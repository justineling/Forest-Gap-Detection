"""周期图格网 + 局部相位（grid_prior.lattice_from_tops / lattice_phase_origin）的回归测试。

纯合成点集、不读影像，秒级，可进 CI。造一个"像真园子"的场景：
两块种植区**相位不同**（起点错开半个株距）、树位有 0.4 m 抖动、20% 缺株，再混入 5% 杂点。
要守住的性质：

1. 周期图能从全图点集恢复株距与方位（不受两块相位不同的影响）；
2. 每块区域内单独求的相位能把该区域的真实格点对准（全局一个相位对不准另一块）；
3. 随机点的周期图对比度远低于真实格网（据此判"不是规整种植园"→ 退回旧勘察）。

跑法：.venv/Scripts/python.exe scripts/test_lattice.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import grid_prior as GP  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}{'  ·  ' + detail if detail else ''}")
    if not ok:
        failures += 1


PITCH, AZ = 8.55, 59.0
ROW, SKEW = PITCH * np.sin(np.radians(60)), PITCH / 2
rng = np.random.default_rng(42)


def block(origin, x_range, y_range):
    """一块种植区：真实格点（裁到范围内）+ 抖动 + 缺株。"""
    a1, a2, _k1, _k2 = GP._lattice_vectors(PITCH, ROW, SKEW, AZ)
    ij = np.array([(i, j) for i in range(-120, 121) for j in range(-120, 121)], dtype=float)
    nodes = origin + ij @ np.vstack([a1, a2])
    keep = ((nodes[:, 0] >= x_range[0]) & (nodes[:, 0] < x_range[1])
            & (nodes[:, 1] >= y_range[0]) & (nodes[:, 1] < y_range[1]))
    nodes = nodes[keep]
    alive = nodes[rng.random(len(nodes)) > 0.2]
    pts = alive + rng.normal(0, 0.4, alive.shape)
    return nodes, pts


oA = np.array([500000.0, 130000.0])
oB = oA + np.array([PITCH / 2, 1.3])                    # 第二块：起点错开半个株距、再偏 1.3 m
nodesA, ptsA = block(oA, (499700, 500000), (129700, 130300))
nodesB, ptsB = block(oB, (500000, 500300), (129700, 130300))
noise = rng.uniform((499700, 129700), (500300, 130300), (int(0.05 * (len(ptsA) + len(ptsB))), 2))
tops = np.vstack([ptsA, ptsB, noise])

print("A. 全图周期图恢复株距与方位（两块相位不同、抖动、缺株、杂点）")
L = GP.lattice_from_tops(tops)
check(L is not None and abs(L["pitch"] - PITCH) / PITCH < 0.005, "★ 株距误差 < 0.5%", f"{L['pitch']:.3f} vs {PITCH}")
daz = abs(((L["azimuth_deg"] - AZ) + 30) % 60 - 30)
check(daz < 0.3, "★ 方位误差 < 0.3°（模 60°）", f"{L['azimuth_deg']:.3f}° vs {AZ}°")

print("\nB. 局部相位（与管线一致：一块空地周围 40 m 内的点）—— 每块单独求才对得准")
# ⚠️ 不能拿整块 300 m 的区域测：周期图参数哪怕只差 0.2%，35 个株距累积下来也有 0.6 m。
#    管线里相位只用空地周围 40 m 的树求，参数误差几乎不累积 —— 测试必须与用法同尺度。
for name, nodes, pts, c in (("A 块", nodesA, ptsA, np.array([499850.0, 130000.0])),
                            ("B 块", nodesB, ptsB, np.array([500150.0, 130000.0]))):
    near = pts[np.hypot(*(pts - c).T) <= 40]
    o, coh = GP.lattice_phase_origin(near, L["pitch"], L["row"], L["skew"], L["azimuth_deg"], ref=c)
    nd = nodes[np.hypot(*(nodes - c).T) <= 40]
    d = GP.lattice_node_distance(nd, o, L["pitch"], L["row"], L["skew"], L["azimuth_deg"])
    check(np.median(d) < 0.3 and coh > 0.5, f"★ {name}：40 m 内真实格点到局部格网 P50 < 0.3 m，相干度 > 0.5",
          f"P50 {np.median(d):.3f} m · 相干度 {coh:.2f} · {len(near)} 个点")
oG, cohG = GP.lattice_phase_origin(tops, L["pitch"], L["row"], L["skew"], L["azimuth_deg"])
dA = GP.lattice_node_distance(nodesA, oG, L["pitch"], L["row"], L["skew"], L["azimuth_deg"])
dB = GP.lattice_node_distance(nodesB, oG, L["pitch"], L["row"], L["skew"], L["azimuth_deg"])
check(max(np.median(dA), np.median(dB)) > 1.5, "对照：全局一个相位时，至少一块对不准（> 1.5 m）",
      f"A {np.median(dA):.2f} m / B {np.median(dB):.2f} m")

print("\nC. 随机点的周期性远弱于真实格网")
Lr = GP.lattice_from_tops(rng.uniform((499700, 129700), (500300, 130300), (len(tops), 2)))
check(Lr["contrast"] < 30 < L["contrast"], "★ 随机点对比度 < 30 < 真实格网对比度",
      f"随机 {Lr['contrast']:.1f} / 格网 {L['contrast']:.0f}")
check(GP.lattice_from_tops(tops[:50]) is None, "点太少（< 200）→ 不估，交给旧勘察")

print("\nD. 格网约定与 GridModel 一致（node_at / xy_to_grid 同一套基矢）")
gm = GP.GridModel(plant_pitch_m=PITCH, row_pitch_m=ROW, skew_offset_m=SKEW,
                  origin_x_m=float(oA[0]), origin_y_m=float(oA[1]), row_azimuth_deg=AZ,
                  quality=0.6, method=GP.PERIODOGRAM_METHOD, density_per_ha=1e4 / (PITCH * ROW))
nx, ny = gm.node_at(7, -3)
check(GP.lattice_node_distance(np.array([[nx, ny]]), oA, PITCH, ROW, SKEW, AZ)[0] < 1e-6
      and gm.xy_to_grid(nx, ny)[2] < 1e-6, "GridModel.node_at 的格点落在 lattice_node_distance 的格网上")

print(f"\n{'✅ 全部通过' if failures == 0 else f'❌ {failures} 项失败'}")
sys.exit(0 if failures == 0 else 1)
