# -*- coding: utf-8 -*-
"""A/B：要素固定不变，只换 base 的 `planting_grid`，看交付点位是否变化。

手工回归用，**不进 `npm test`**。

它回答一个具体问题
------------------
`/export` 里"要素"和"网格"来自**两个不同来源**：

    feats  ← 前端 POST 的 payload     （用户当前看到的、复核过的结果）
    grid   ← base_obj["planting_grid"]（磁盘上"被发现的"那个结果文件）

一旦"被发现的文件"和"前端载入的文件"不是同一批（②号缺陷的后果），
就会出现：**块数完全正确，放样点位却按另一批数据的网格平移**。
报告看着正常，坑挖错地方，用户看不出来。

本脚本用真数据（1,726 块）把要素钉死，分别喂两份不同的网格，
比对点位数量与首点坐标。数字不一致即证明该机制存在。

用法
----
    cd <仓库根>
    .venv/Scripts/python.exe desktop/tests/e2e/export_grid_ab.py

补充
----
- 只在 `output/wgr17-final-gaps.geojson` 与一份"替身"结果文件都在时才跑；
  替身缺失时会就地造一份（改 pitch / origin），不需要仓库里有垃圾文件。
- 期望：两行数字**不同**（证明耦合）。若某天 `/export` 改成"网格也走 POST"，
  这里会变成"相同" —— 那时应当把断言反过来并更新文档。
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import tile_server as TS  # noqa: E402

REAL = REPO_ROOT / "output" / "wgr17-final-gaps.geojson"


def flatten(obj: dict) -> list:
    feats = list(obj.get("features") or [])
    for b in obj.get("blocks") or []:
        feats.extend(b.get("gaps") or [])
    return feats


def main() -> int:
    if not REAL.exists():
        print(f"❌ 缺少真数据 {REAL}", file=sys.stderr)
        return 2

    base_real = json.loads(REAL.read_text(encoding="utf-8"))
    feats = flatten(base_real)
    grid_real = dict(base_real.get("planting_grid") or {})
    if not grid_real.get("plant_pitch_m"):
        print("❌ 真数据里没有 planting_grid，无法做 A/B", file=sys.stderr)
        return 2

    # 替身网格：模拟"另一批数据"（pitch / 原点都不同）
    grid_other = dict(grid_real)
    grid_other["plant_pitch_m"] = 8.35
    grid_other["origin_x_m"] = float(grid_real.get("origin_x_m") or 0) + 0.37
    grid_other["origin_y_m"] = float(grid_real.get("origin_y_m") or 0) - 1.62

    print(f"要素数（固定）= {len(feats)}")
    print("网格 A（真）:", {k: grid_real.get(k) for k in ("plant_pitch_m", "origin_x_m", "origin_y_m")})
    print("网格 B（替身）:", {k: grid_other.get(k) for k in ("plant_pitch_m", "origin_x_m", "origin_y_m")})

    payload = {
        "gaps": {"type": "FeatureCollection", "features": feats},
        "clearance_m": 0.5,
        "planting_grid": grid_real,     # 与前端一致：POST 里也带着，但优先级低于 base
    }

    res = {}
    with tempfile.TemporaryDirectory() as td:
        for tag, grid in (("A", grid_real), ("B", grid_other)):
            d = Path(td) / tag
            r = TS.export_bundle(payload, d, {"planting_grid": grid})
            p = d / "planting-points-wgs84.geojson"
            coords = []
            if p.exists():
                obj = json.loads(p.read_text(encoding="utf-8"))
                coords = [(f["geometry"]["coordinates"][0],
                           f["geometry"]["coordinates"][1]) for f in obj["features"]]
            res[tag] = {"ok": r.get("ok"), "counts": r.get("counts"), "coords": coords}

    for tag in ("A", "B"):
        c = res[tag]["coords"]
        print(f"\n[{tag}] ok={res[tag]['ok']} counts={res[tag]['counts']} 实际点={len(c)}")
        if c:
            print(f"     首点 = {c[0]}")

    a, b = res["A"]["coords"], res["B"]["coords"]
    same_n = len(a) == len(b)
    same_first = bool(a and b and a[0] == b[0])

    print("\n—— 结论 ——")
    print(f"点位数量相同 = {same_n}（A={len(a)} B={len(b)}）")
    print(f"首点坐标相同 = {same_first}")
    if same_n and same_first:
        print("→ 网格未参与点位计算，或两批网格恰好一致：**串批次风险不存在**")
        return 0
    print("→ 网格**确实**参与点位计算：换一批 base 就会让放样点整体偏移。")
    print("  即「块数对得上 ≠ 点位对得上」，修复必须是"
          "「被发现的文件要与前端载入的文件同批」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
