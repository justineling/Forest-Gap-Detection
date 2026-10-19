#!/usr/bin/env python3
"""「结果是否过期」的判定逻辑测试。

## 为什么值得单独测

这条逻辑的价值全在**不误报**：
· 误报（本来就过期却说没问题）→ 用户拿旧数字交付，坑挖错地方
· 假警报（没过期却说过期）→ 用户学会无视这条警告，等于没做

而它的判据是文件 mtime —— 跨文件系统、跨复制操作都不完全可靠，
所以边界（容差、文件不存在、老结果没有快照）必须逐条钉死。

## 判据回顾

结果 JSON 里 `inputs_snapshot` 记了每个输入文件当时的 mtime + size。
当前磁盘上的 mtime 比它新超过 2 秒 → 判为过期。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tile_server import _stale_warnings  # noqa: E402

failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}" + (f"  ·  {detail}" if detail else ""))
    if not ok:
        failures += 1


def make_snapshot(dir_: Path, chm_mtime: int) -> dict:
    """造一份结果对象（只保留 _stale_warnings 关心的字段）。"""
    chm = dir_ / "chm.tif"
    if not chm.exists():
        chm.write_bytes(b"x" * 100)
    return {
        "type": "FeatureCollection",
        "features": [],
        "inputs_snapshot": {
            "chm": {"path": str(chm), "mtime": chm_mtime, "size": 100},
        },
    }


def main() -> int:
    print("\nA. 基本判定")
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        now = int(time.time())

        # chm 与快照一致 → 无警告
        obj = make_snapshot(d, now)
        os.utime(d / "chm.tif", (now, now))
        check(_stale_warnings(obj) == [], "chm 未变 → 无警告")

        # chm 更新了 1 小时 → 报警
        obj = make_snapshot(d, now - 3600)
        os.utime(d / "chm.tif", (now, now))
        w = _stale_warnings(obj)
        check(len(w) == 1, "chm 更新 1 小时 → 报警", str(w[:1]))
        check("chm.tif" in w[0] and "重新运行检测" in w[0], "文案要说清是哪个文件 + 该怎么办")

        # 2 秒容差：差 1 秒不报（文件系统粒度 / 复制抖动）
        obj = make_snapshot(d, now - 1)
        os.utime(d / "chm.tif", (now, now))
        check(_stale_warnings(obj) == [], "差 1 秒 → 容差内，不报")

        # 差 3 秒要报（超过容差）
        obj = make_snapshot(d, now - 3)
        os.utime(d / "chm.tif", (now, now))
        check(len(_stale_warnings(obj)) == 1, "差 3 秒 → 超过容差，报")

    print("\nB. 不该误报的边界")
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)

        # 老结果没有 inputs_snapshot —— 不能因为"说不清"就报警
        check(_stale_warnings({"features": []}) == [],
              "老结果无 inputs_snapshot → 静默（不假警报）")
        check(_stale_warnings({"inputs_snapshot": None}) == [], "快照为 null → 静默")
        check(_stale_warnings({"inputs_snapshot": "bad"}) == [], "快照类型错 → 静默不崩")

        # 文件已被删除 —— 不能报"过期"（那是"缺失"，预检管）
        obj = make_snapshot(d, int(time.time()))
        obj["inputs_snapshot"]["chm"]["path"] = str(d / "gone.tif")
        check(_stale_warnings(obj) == [], "文件不存在 → 不报过期（缺文件归预检管）")

        # 快照里该项为 null
        check(_stale_warnings({"inputs_snapshot": {"chm": None}}) == [],
              "单项为 null → 跳过")

    print("\nC. 多文件")
    with tempfile.TemporaryDirectory() as td:
        d = Path(td)
        now = int(time.time())
        chm = d / "chm.tif"
        seg = d / "segment.tif"
        chm.write_bytes(b"x")
        seg.write_bytes(b"y")
        obj = {
            "inputs_snapshot": {
                "chm": {"path": str(chm), "mtime": now - 3600},
                "segment": {"path": str(seg), "mtime": now - 3600},
            }
        }
        os.utime(chm, (now, now))
        os.utime(seg, (now, now))
        w = _stale_warnings(obj)
        check(len(w) == 2, "两个文件都更新 → 报 2 条", str(len(w)))
        check(any("chm" in x for x in w) and any("segment" in x for x in w),
              "两条分别指明文件")

        # 只更新一个
        obj["inputs_snapshot"]["segment"]["mtime"] = now
        w = _stale_warnings(obj)
        check(len(w) == 1 and "chm" in w[0], "只更新 chm → 只报 chm")

    print()
    if failures == 0:
        print("✅ 全部通过")
        return 0
    print(f"❌ {failures} 项失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
