# -*- coding: utf-8 -*-
"""端到端：干净数据根上的 /gaps 与 /export（含"网格是否跟着换批次"）。

手工回归用，**不进 `npm test`**（起子进程 + 真实导出，约 20~40 秒）。

为什么必须用"干净数据根"
------------------------
`gaps_search_dirs()` 的候选目录里**永远**包含 `ROOT/output`（仓库根）。
仓库根 `output/` 现在躺着 7 个匹配 `*gaps*.geojson` 的历史/测试残留
（`frozen-smoke2-gaps`、`frozen-smoke-gaps`、`ipc-sim2-gaps`、
`sc-workers-test-gaps`、`roi-ab-gaps`、`wgr17-final-gaps` …），
其中最新的几个只有 8~14 块。

**所以任何"拿仓库根当 cwd"的验收都会看到 12 块而不是 1,726 块。**
这曾让同事得出"导出只会得到 19 文件 / 919 点"的错误结论。

本脚本的做法：在临时目录里造一个完整的"数据根"
    <tmp>/WGR17-002.tif           512×512 桩影像（只为让 /meta 与导出元数据可用）
    <tmp>/wgr17-final-gaps.geojson  从仓库 output/ 复制（真数据，1,726 块 / 8 类）
    <tmp>/output/                  空
并以 `--source <tmp>/WGR17-002.tif --gaps <tmp>/wgr17-final-gaps.geojson` 启动服务。
仓库根 `output/` 仍会被搜索，但里面最"新"的残留也早于服务启动时刻，
因此显式指定的 1,726 块应当胜出 —— 这正是 ② 号缺陷的验收点。

用法
----
    cd <仓库根>
    .venv/Scripts/python.exe desktop/tests/e2e/e2e_export_bundle.py

参数
----
    --keep   保留临时目录（排障时看产物）
    --port   服务端口，默认 8799

退出码 0 = 全过。
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
PY = REPO_ROOT / ".venv" / "Scripts" / "python.exe"
REAL_GAPS = REPO_ROOT / "output" / "wgr17-final-gaps.geojson"

# 期望值（写死 = 验收基线；改了算法就要同步改这里）
EXPECT_FEATURES = 1726
EXPECT_CLASSES = 8
EXPECT_FILES = 21
EXPECT_POINTS = 3691

fails = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global fails
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}" + (f"  ·  {detail}" if detail else ""))
    if not ok:
        fails += 1


def make_stub_image(path: Path) -> None:
    import numpy as np
    import rasterio
    from rasterio.transform import from_bounds

    tr = from_bounds(111.15, 1.14, 111.25, 1.22, 512, 512)
    with rasterio.open(
        path, "w", driver="GTiff", height=512, width=512, count=4,
        dtype="uint8", crs="EPSG:4326", transform=tr,
    ) as d:
        d.write(np.zeros((4, 512, 512), dtype="uint8"))


def get_json(url: str, timeout: float = 180.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def post_json(url: str, body: dict, timeout: float = 300.0) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def flatten(obj: dict) -> list:
    """算法原始产物：顶层 features 空，要素在 blocks[].gaps。前端也是这么拍的。"""
    feats = list(obj.get("features") or [])
    for b in obj.get("blocks") or []:
        feats.extend(b.get("gaps") or [])
    return feats


def wait_ready(port: int, proc: subprocess.Popen, timeout: float = 120.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            get_json(f"http://127.0.0.1:{port}/meta", timeout=5)
            return True
        except Exception:
            time.sleep(0.5)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", action="store_true")
    ap.add_argument("--port", type=int, default=8799)
    args = ap.parse_args()

    if not REAL_GAPS.exists():
        print(f"❌ 缺少真数据 {REAL_GAPS}，无法做端到端验收", file=sys.stderr)
        return 2
    if not PY.exists():
        print(f"❌ 缺少虚拟环境解释器 {PY}", file=sys.stderr)
        return 2

    td = Path(tempfile.mkdtemp(prefix="fgd-e2e-"))
    proc: subprocess.Popen | None = None
    try:
        root = td
        img = root / "WGR17-002.tif"
        explicit = root / "wgr17-final-gaps.geojson"
        (root / "output").mkdir(parents=True, exist_ok=True)
        make_stub_image(img)
        shutil.copy2(REAL_GAPS, explicit)

        # ⚠️ 显式文件的 mtime 必须**比仓库根 output/ 里所有残留都旧**，否则
        #    这个验收用例根本测不到 ② 号缺陷：曾经把显式设成"1 小时前"，
        #    而残留都是 40 小时前的，于是"修复前也通过"—— 假绿。
        #    这里取"最旧的那份残留"再往前 1 小时，保证修复前必然输给残留。
        import os
        junk = [
            p for p in (REPO_ROOT / "output").glob("*.geojson")
            if "gaps" in p.name.lower()
        ]
        if junk:
            newest_junk = max(p.stat().st_mtime for p in junk)
            old = newest_junk - 3600.0
            print(f"仓库根有 {len(junk)} 个 *gaps*.geojson 残留，最新一份在 "
                  f"{(time.time() - newest_junk) / 3600:.1f} 小时前")
            print(f"→ 把显式文件的 mtime 设成更旧（修复前必然被残留顶掉，用例才有效）")
        else:
            old = time.time() - 3600.0
        os.utime(explicit, (old, old))

        base = f"http://127.0.0.1:{args.port}"
        print(f"\n临时数据根：{root}")
        print("启动服务（--source 桩影像 --gaps 显式指定 1,726 块）…")
        proc = subprocess.Popen(
            [str(PY), str(REPO_ROOT / "scripts" / "tile_server.py"),
             "--source", str(img), "--gaps", str(explicit), "--port", str(args.port)],
            cwd=str(REPO_ROOT), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if not wait_ready(args.port, proc):
            out = proc.stderr.read().decode("utf-8", "replace") if proc.stderr else ""
            print("❌ 服务未就绪\n" + out[-2000:], file=sys.stderr)
            return 2

        # ---------- ⑤-a /gaps 应为 1,726 块 8 类 ----------
        print("\n⑤-a GET /gaps")
        g = get_json(f"{base}/gaps", timeout=120)
        feats = flatten(g)
        classes = {f.get("properties", {}).get("class") for f in feats}
        classes.discard(None)
        check(len(feats) == EXPECT_FEATURES, f"/gaps 要素数 = {EXPECT_FEATURES}",
              f"实际 {len(feats)}")
        check(len(classes) == EXPECT_CLASSES, f"类别数 = {EXPECT_CLASSES}",
              f"实际 {len(classes)}: {sorted(classes)}")
        grid_before = (g.get("planting_grid") or {})

        # ---------- ⑤-b /export 21 文件 / 3,691 点 ----------
        print("\n⑤-b POST /export")
        outdir = root / "export1"
        r1 = post_json(f"{base}/export", {
            "gaps": {"type": "FeatureCollection", "features": feats},
            "outdir": str(outdir),
            "clearance_m": 0.5,
        })
        check(r1.get("ok") is True, "导出 ok=true", str(r1.get("error")))
        check(len(r1.get("files") or []) == EXPECT_FILES,
              f"文件数 = {EXPECT_FILES}", f"实际 {len(r1.get('files') or [])}")
        pts = (r1.get("counts") or {}).get("planting_points")
        check(pts == EXPECT_POINTS, f"放样点位 = {EXPECT_POINTS}", f"实际 {pts}")

        report = Path(r1.get("report") or "")
        if report.exists():
            txt = report.read_text(encoding="utf-8", errors="replace")
            check("3,691" in txt or "3691" in txt, "一页报告里出现 3,691",
                  f"报告 {report.name} {report.stat().st_size} B")
        else:
            check(False, "一页报告已生成", f"找不到 {report}")

        # ---------- ⑤-c 启动后放一个更新的小样本 → 应接管，且网格随之换 ----------
        print("\n⑤-c 启动后新放入一个更新（更小）的结果文件")
        small_grid = dict(grid_before)
        small_grid.update({"plant_pitch_m": 8.35, "origin_x_m": 159.3191, "origin_y_m": 58.298})
        small_feats = [
            {"type": "Feature",
             "geometry": {"type": "Polygon", "coordinates": [[
                 [111.2000, 1.1800], [111.2020, 1.1800],
                 [111.2020, 1.1820], [111.2000, 1.1800]]]},
             "properties": {"gap_id": "S1", "class": "open_patch",
                            "class_label": "连片空地", "area_sqm": 40000, "source": "algo"}}
        ]
        small = root / "output" / "wgr17-desktop-gaps.geojson"
        small.write_text(json.dumps({
            "type": "FeatureCollection", "features": [],
            "blocks": [{"block_id": "B1", "gaps": small_feats}],
            "planting_grid": small_grid,
        }), encoding="utf-8")

        g2 = get_json(f"{base}/gaps", timeout=120)
        feats2 = flatten(g2)
        check(len(feats2) == 1, "新样本接管：/gaps 变成 1 块",
              f"实际 {len(feats2)}")
        grid_after = (g2.get("planting_grid") or {})
        # 直接对齐新样本的绝对值（而不是与前一次比较）：
        # 比较式断言在"修复前首读就是错的"情况下会假绿
        check(
            float(grid_after.get("origin_x_m") or 0) == 159.3191,
            "planting_grid 等于新样本的（用户看到哪份，就按哪份放样）",
            f"origin_x_m 实际 {grid_after.get('origin_x_m')}（期望 159.3191）",
        )

        r2 = post_json(f"{base}/export", {
            "gaps": {"type": "FeatureCollection", "features": feats2},
            "outdir": str(root / "export2"),
            "clearance_m": 0.5,
        })
        check(r2.get("ok") is True, "换样本后导出仍成功", str(r2.get("error")))
        check(len(r2.get("files") or []) < EXPECT_FILES,
              "文件数随类别变少而减少（属预期）", f"实际 {len(r2.get('files') or [])}")

        print("\n判据小结：显式优先生效 + 自动刷新未坏 + 导出数字与基线一致")
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
        if args.keep:
            print(f"\n（已保留临时目录 {td}）")
        else:
            shutil.rmtree(td, ignore_errors=True)

    print("\n" + ("❌ 存在失败项" if fails else "✅ 全部通过"))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
