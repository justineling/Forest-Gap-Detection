# -*- coding: utf-8 -*-
"""回归：结果文件选择逻辑（`TileServer._pick_gaps`）。

手工回归用，**不进 `npm test`**（需要 Python 虚拟环境，且依赖真实仓库路径）。

为什么单独一个脚本
------------------
`_pick_gaps` 同时承担两个互相冲突的需求：

  ① **检测跑完不重启服务也要看到新结果** —— 判据是"每次 /gaps 都重新发现"；
  ② **用户显式选定的文件不能被别的文件顶掉** —— 判据是"显式优先"。

二者都合理，但实现上曾用同一个 mtime 比较，导致 ② 被 ① 吃掉：
用户点了 `wgr17-final-gaps.geojson`，服务却用 `output/` 里更新的测试残留。
后果不只是"块数不对"——`/export` 的 `planting_grid` 也取自同一个发现结果，
于是**块数完全正确、放样点位却按另一批数据的网格结算**（见 export_grid_ab.py）。

本脚本把 4 个场景钉死，改完 `_pick_gaps` 后必须全绿。

用法
----
    cd <仓库根>
    .venv/Scripts/python.exe desktop/tests/e2e/regress_gaps_selection.py

退出码 0 = 全过；1 = 有失败。
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import tile_server as TS  # noqa: E402

fails = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global fails
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}" + (f"  ·  {detail}" if detail else ""))
    if not ok:
        fails += 1


def make_gaps(path: Path, n: int, mtime_ns: int, cls: str = "open_patch") -> None:
    """写一个含 n 个要素的结果文件，并把 mtime 钉到指定纳秒。"""
    feats = []
    for i in range(n):
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [[
                [111.0 + i * 0.001, 1.0], [111.0005 + i * 0.001, 1.0],
                [111.0005 + i * 0.001, 1.0005], [111.0 + i * 0.001, 1.0],
            ]]},
            "properties": {"gap_id": f"G{i:04d}", "class": cls,
                           "class_label": "", "area_sqm": 100.0, "source": "algo"},
        })
    obj = {
        "type": "FeatureCollection",
        "features": [],
        "blocks": [{"block_id": "B1", "gaps": feats}],
        "planting_grid": {"plant_pitch_m": 8.45, "row_pitch_m": 7.32,
                          "azimuth_deg": 0.67, "origin_x_m": 100.0, "origin_y_m": 200.0},
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj), encoding="utf-8")
    set_mtime_ns(path, mtime_ns)


def set_mtime_ns(path: Path, ns: int) -> None:
    import os
    os.utime(path, ns=(ns, ns))


def count_features(obj: dict) -> int:
    n = len(obj.get("features") or [])
    n += sum(len(b.get("gaps") or []) for b in (obj.get("blocks") or []))
    return n


def server(source: Path, explicit: Path | None) -> "TS.TileServer":
    """用**真实 __init__**（不 __new__ 手塞字段）——这样修复新增的字段会被自然带上。"""
    return TS.TileServer(source, explicit)


def read_n(ts: "TS.TileServer") -> int:
    """走真实 gaps_json()（含缓存）——连带验证"同路径被重写"时缓存会失效。"""
    return count_features(json.loads(ts.gaps_json().decode("utf-8")))


def pick_name(ts: "TS.TileServer") -> str:
    p = ts._pick_gaps()
    return p.name if p else "（无）"


def main() -> int:
    base = time.time_ns()
    with tempfile.TemporaryDirectory() as td:
        root = Path(td)
        # source 只用来推导"候选目录"，__init__ 不会真打开它
        src = root / "drone data" / "WGR17-002.tif"
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_bytes(b"stub")

        # ---------- ① 检测完自动刷新（最重要：弄坏就是退回"跑完检测看不到新结果"） ----------
        print("\n① 同一实例连续读到 3 / 7 / 11（检测完不重启也要刷新）")
        auto = src.parent / "output" / "wgr17-desktop-gaps.geojson"
        auto.parent.mkdir(parents=True, exist_ok=True)
        # mtime 放到未来，保证盖过仓库根 output/ 里的历史残留（不污染仓库）
        make_gaps(auto, 3, base + 3_600_000_000_000)
        ts = server(src, None)
        n1 = read_n(ts)
        check(n1 == 3, "第 1 次读到 3 块", f"实际 {n1}")

        make_gaps(auto, 7, base + 3_700_000_000_000)          # 同路径被重写
        n2 = read_n(ts)
        check(n2 == 7, "原地覆盖成 7 块后，同一实例读到 7（缓存按 mtime 失效）", f"实际 {n2}")

        newer = src.parent / "output" / "wgr17-rerun-gaps.geojson"
        make_gaps(newer, 11, base + 3_800_000_000_000)        # 新文件、更新
        n3 = read_n(ts)
        check(n3 == 11, "出现更新的文件后读到 11（自动发现切换）", f"实际 {n3}")

        # ---------- ② 显式优先（本次修复的核心） ----------
        print("\n② 显式选定的文件 vs 目录里更新的文件（都早于服务启动）")
        root2 = root / "case2"
        src2 = root2 / "drone data" / "WGR17-002.tif"
        src2.parent.mkdir(parents=True, exist_ok=True)
        src2.write_bytes(b"stub")
        explicit = src2.parent / "wgr17-final-gaps.geojson"
        stale = src2.parent / "output" / "ab-w4-gaps.geojson"
        # 显式：1 小时前；干扰：30 分钟前（比显式新，但都早于"启动时刻"）
        make_gaps(explicit, 1726, base - 3_600_000_000_000)
        make_gaps(stale, 639, base - 1_800_000_000_000)

        ts2 = server(src2, explicit)
        got = ts2._pick_gaps()
        check(got == explicit, "显式指定的文件胜出（不被更新的残留顶掉）",
              f"实际 {got.name if got else '（无）'}")
        n = read_n(ts2)
        check(n == 1726, "读到的确实是显式那份的 1,726 块", f"实际 {n}")

        # ---------- ③ 显式 + 之后又跑了检测 → 新文件应接管 ----------
        print("\n③ 服务启动后新产生的文件应接管（保住 ① 的能力）")
        time.sleep(0.05)   # 让新文件的 mtime 确定晚于 __init__ 记录的时刻
        ts3 = server(src2, explicit)
        fresh = src2.parent / "output" / "wgr17-desktop-gaps.geojson"
        make_gaps(fresh, 1726, time.time_ns())   # 真实"刚写完"的时间
        got3 = ts3._pick_gaps()
        check(got3 == fresh, "启动后新写的文件接管", f"实际 {got3.name if got3 else '（无）'}")
        check(read_n(ts3) == 1726, "新文件内容被读到", f"实际 {read_n(ts3)}")

        # ---------- ④ 干扰文件仍不被误选 ----------
        print("\n④ 名字不含 'gaps' 的 geojson 不应被当成空地")
        root4 = root / "case4"
        src4 = root4 / "drone data" / "WGR17-002.tif"
        src4.parent.mkdir(parents=True, exist_ok=True)
        src4.write_bytes(b"stub")
        out4 = src4.parent / "output"
        make_gaps(out4 / "real-gaps.geojson", 5, base + 1_000_000_000_000)
        # 这两个名字里没有 "gaps"，即使极新也不能选中
        make_gaps(out4 / "forest-mask-50m.geojson", 9, base + 9_000_000_000_000)
        make_gaps(out4 / "ab-w4.geojson", 7, base + 9_500_000_000_000)
        ts4 = server(src4, None)
        name4 = pick_name(ts4)
        check(name4 == "real-gaps.geojson", "选中的仍是 *gaps*.geojson，掩膜/A-B 文件被忽略", name4)
        check(read_n(ts4) == 5, "内容来自 real-gaps.geojson", f"实际 {read_n(ts4)}")

    print("\n" + ("❌ 存在失败项" if fails else "✅ 全部通过"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
