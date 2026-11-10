#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""sidecar 契约测试 —— 不依赖真实大影像，用合成影像验证进程边界。

覆盖范围
========
  1. 事件通道格式：stdout 每一行都是合法 JSON，且必带 event 字段
  2. 事件序列完整性：started 必来；result/error 必有其一且仅一个
  3. 退出码：成功=0，参数错=1，内部错=2
  4. 错误码分段：E1xxx IO / E2xxx CRS / E9xxx 内部
  5. 参数校验：非法参数被拒且报 E1002
  6. 结果契约：schema_version=0.4、blocks[].gaps[] 有几何、summary 有 by_class
  7. 告警码：未知字段 W1001、kml 未启用 W1002

为什么要合成影像
================
真实 WGR17.tif 有 3.5 GB，跑一遍 20 分钟，且它只是一种输入。
契约测试要的是"边界行为正确"，用一张小图（几秒跑完）就能覆盖全部
分支，还能构造出真实数据不会出现的边角情形（如全 NoData、无 CRS）。

运行
====
    python scripts/test_sidecar_contract.py
    python scripts/test_sidecar_contract.py -v      # 显示每个事件
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJ = _SCRIPT_DIR.parent
PY = sys.executable
SIDECAR = _SCRIPT_DIR / "sidecar.py"

VERBOSE = "-v" in sys.argv

_passed = 0
_failed = 0
_failures: list[str] = []


def check(cond: bool, label: str, extra: str = "") -> None:
    global _passed, _failed
    if cond:
        _passed += 1
        print(f"  ✓ {label}")
    else:
        _failed += 1
        _failures.append(label)
        print(f"  ✗ {label}" + (f"\n      {extra}" if extra else ""))


def run_sidecar(params: dict | str, expect_exit: int | None = None
                ) -> tuple[list[dict], int, str]:
    """跑一次 sidecar，返回 (事件列表, 退出码, stderr)。"""
    if isinstance(params, dict):
        arg = json.dumps(params, ensure_ascii=False)
    else:
        arg = params

    proc = subprocess.run(
        [PY, str(SIDECAR), "--params-json", arg],
        capture_output=True, text=True, encoding="utf-8", timeout=300)

    events: list[dict] = []
    for lineno, line in enumerate(proc.stdout.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            raise AssertionError(
                f"stdout 第 {lineno} 行不是合法 JSON：{e}\n  内容：{line[:200]}") from e
        assert isinstance(obj, dict), f"第 {lineno} 行不是 JSON 对象"
        assert "event" in obj, f"第 {lineno} 行缺少 event 字段：{line[:200]}"
        events.append(obj)
        if VERBOSE:
            print(f"      ← {line[:160]}")

    if expect_exit is not None:
        assert proc.returncode == expect_exit, (
            f"退出码应为 {expect_exit}，实际 {proc.returncode}\n"
            f"  stderr: {(proc.stderr or '')[-500:]}\n"
            f"  events: {[e['event'] for e in events]}")
    return events, proc.returncode, proc.stderr or ""


def assert_sequence(events: list[dict], expect: str) -> None:
    """校验事件序列的基本不变量。

    expect: "success" | "error"
    """
    kinds = [e["event"] for e in events]
    check(kinds and kinds[0] == "started", f"首个事件是 started（实际 {kinds[:1]}）")

    terminal = [k for k in kinds if k in ("result", "error")]
    if expect == "success":
        check(terminal == ["result"],
              f"终态恰为一次 result（实际 {terminal}）")
    else:
        check(terminal == ["error"],
              f"终态恰为一次 error（实际 {terminal}）")

    # progress 的 ratio 单调不减，且末次必为 1.0
    prog = [e for e in events if e["event"] == "progress"]
    if prog:
        ratios = [p["ratio"] for p in prog]
        check(all(b >= a - 1e-9 for a, b in zip(ratios, ratios[1:])),
              f"progress.ratio 单调不减（{ratios}）")
        check(abs(prog[-1]["ratio"] - 1.0) < 1e-9,
              f"末次 progress.ratio == 1.0（实际 {prog[-1]['ratio']}）")
        check(prog[0]["done"] == 1, f"首次 progress.done == 1（实际 {prog[0]['done']}）")


# ===========================================================================
# 合成影像工厂
# ===========================================================================
def make_synthetic(path: Path, w: int = 3072, h: int = 3072,
                   crs: str | None = "EPSG:4326",
                   with_grid: bool = True) -> None:
    """造一张带规整绿色点阵的合成影像（模拟油棕园）。

    with_grid=True  : 规则点阵，网格勘察应能识别出株行距
    with_grid=False : 纯色，网格勘察应失败或降级
    """
    import rasterio
    from rasterio.transform import from_origin

    rng = np.random.default_rng(42)
    # 底色：偏暗的土壤色（红>绿>蓝，ExG 为负）→ 判为"非树冠"= 空地
    img = np.zeros((3, h, w), dtype=np.uint8)
    img[0] = 130 + rng.integers(-8, 9, (h, w))
    img[1] = 105 + rng.integers(-8, 9, (h, w))
    img[2] = 85 + rng.integers(-8, 9, (h, w))

    if with_grid:
        # 在土壤底色上点亮"树冠"：更亮的绿色斑点，间距约 8.5 m。
        # 只有斑点处 ExG 为正 → 斑点之间的缝隙就是"空地"。
        #
        # ⚠️ 性能：不能对每个斑点都算整图距离场 —— 2048² × 64 个斑点要 26 秒。
        # 改为只在该斑点的 (3σ) 局部窗口内叠加，整体降到亚秒级。
        step = 257
        sigma = 55.0
        rad = int(3 * sigma)                       # 局部窗口半径
        yy, xx = np.mgrid[-rad:rad + 1, -rad:rad + 1]
        kernel = np.exp(-(yy ** 2 + xx ** 2) / (2.0 * sigma ** 2))

        for r, cy in enumerate(range(80, h, step)):
            offset = step // 2 if r % 2 else 0
            for cx in range(80 + offset, w, step):
                y0, y1 = max(0, cy - rad), min(h, cy + rad + 1)
                x0, x1 = max(0, cx - rad), min(w, cx + rad + 1)
                if y0 >= y1 or x0 >= x1:
                    continue
                # 从核里裁出与影像范围对应的那块，避免边界越界
                ky0, ky1 = y0 - (cy - rad), y1 - (cy - rad)
                kx0, kx1 = x0 - (cx - rad), x1 - (cx - rad)
                blob = kernel[ky0:ky1, kx0:kx1]
                # 树冠：G 拉高、R/B 压低 → ExG 显著为正
                img[1][y0:y1, x0:x1] = np.clip(
                    img[1][y0:y1, x0:x1].astype(float) + blob * 120, 0, 255
                ).astype(np.uint8)
                img[0][y0:y1, x0:x1] = np.clip(
                    img[0][y0:y1, x0:x1].astype(float) - blob * 45, 0, 255
                ).astype(np.uint8)
                img[2][y0:y1, x0:x1] = np.clip(
                    img[2][y0:y1, x0:x1].astype(float) - blob * 35, 0, 255
                ).astype(np.uint8)

    # 右上角挖一块 NoData（0,0,0）检验有效区掩膜
    img[:, :h // 5, w - w // 5:] = 0

    transform = from_origin(111.19693, 1.19044, 3.3e-7, 3.3e-7)
    with rasterio.open(path, "w", driver="GTiff", width=w, height=h,
                       count=3, dtype="uint8", crs=crs, transform=transform) as ds:
        ds.write(img)


# ===========================================================================
# 测试用例
# ===========================================================================
def test_self_test() -> None:
    print("\n[1] --self-test（不依赖影像，验证通道与参数管线）")
    proc = subprocess.run([PY, str(SIDECAR), "--self-test"],
                          capture_output=True, text=True, encoding="utf-8", timeout=120)
    check(proc.returncode == 0, f"退出码 0（实际 {proc.returncode}）", proc.stderr[-300:])
    lines = [l for l in proc.stdout.splitlines() if l.strip()]
    ok = True
    for l in lines:
        try:
            json.loads(l)
        except json.JSONDecodeError:
            ok = False
    check(ok, f"全部 {len(lines)} 行都是合法 JSON")
    events = [json.loads(l) for l in lines]
    kinds = [e["event"] for e in events]
    check(kinds[0] == "started" and kinds[-1] == "result",
          f"首尾为 started/result（实际 {kinds[0]}/{kinds[-1]}）")


def test_param_errors() -> None:
    print("\n[2] 参数错误 → E1002 + 退出码 1")
    cases = [
        ("缺少 input", {"job": "t"}),
        ("tile_size 非 2 的幂", {"input": "x.tif", "tile_size": 1000}),
        ("overlap 过大", {"input": "x.tif", "overlap": 2000}),
        ("pct 越界", {"input": "x.tif", "pct": 150}),
        ("exg_lo ≥ exg_hi", {"input": "x.tif", "exg_lo": 90, "exg_hi": 40}),
        ("method 非法", {"input": "x.tif", "method": "bogus"}),
        ("progress_every < 1", {"input": "x.tif", "progress_every": 0}),
        ("类型错误（tile_size 传字符串）", {"input": "x.tif", "tile_size": "big"}),
    ]
    for label, params in cases:
        events, rc, _ = run_sidecar(params)
        errs = [e for e in events if e["event"] == "error"]
        check(rc == 1 and len(errs) == 1 and errs[0]["code"] == "E1002",
              f"{label} → E1002/退出码1（实际 rc={rc}, "
              f"code={errs[0]['code'] if errs else 'NONE'}）")

    # 非 JSON 输入
    events, rc, _ = run_sidecar("{ this is not json")
    errs = [e for e in events if e["event"] == "error"]
    check(rc == 1 and errs and errs[0]["code"] == "E1002",
          f"非法 JSON → E1002/退出码1（实际 rc={rc}）")

    # 空参数
    events, rc, _ = run_sidecar("{}")
    errs = [e for e in events if e["event"] == "error"]
    check(rc == 1 and errs and errs[0]["code"] == "E1002",
          f"空对象 → E1002（实际 rc={rc}）")


def test_missing_file() -> None:
    print("\n[3] 影像不存在 → E1001 + 退出码 1")
    events, rc, _ = run_sidecar({"input": "D:/__definitely_not_here__.tif"})
    errs = [e for e in events if e["event"] == "error"]
    check(rc == 1 and len(errs) == 1 and errs[0]["code"] == "E1001",
          f"E1001/退出码1（实际 rc={rc}, code={errs[0]['code'] if errs else 'NONE'}）")
    if errs:
        check(errs[0]["recoverable"] is True,
              f"recoverable == true（实际 {errs[0].get('recoverable')}）")
        check(bool(errs[0].get("message")), "error.message 非空（可显示给用户）")
    assert_sequence(events, "error")


def test_warnings(tmpdir: Path) -> None:
    print("\n[4] 告警码 W1001 / W1002")
    tif = tmpdir / "warn.tif"
    make_synthetic(tif, w=1536, h=1536)
    events, rc, _ = run_sidecar({
        "input": str(tif), "job": "contract-warn",
        "work_dir": str(tmpdir / "jobs"),
        "out_json": str(tmpdir / "warn-gaps.geojson"),
        "unknown_field_abc": 1,
        "kml": "some.kml",
        "grid_only": True,
    })
    codes = [e.get("code") for e in events if e["event"] == "warn"]
    check("W1001" in codes, f"未知字段告警 W1001（实际 {codes}）")
    check("W1002" in codes, f"kml 未启用告警 W1002（实际 {codes}）")


def test_success_path(tmpdir: Path) -> None:
    print("\n[5] 成功路径 → 完整事件流 + 结果契约")
    tif = tmpdir / "ok.tif"
    make_synthetic(tif, w=3072, h=3072)
    out = tmpdir / "ok-gaps.geojson"

    events, rc, _ = run_sidecar({
        "input": str(tif), "job": "contract-ok",
        "work_dir": str(tmpdir / "jobs"),
        "out_json": str(out),
        "progress_every": 3,
        "min_area": 10.0,          # 合成图空隙较小，放宽以便检出
        "min_canopy_blob": 200,
    }, expect_exit=0)

    assert_sequence(events, "success")

    kinds = [e["event"] for e in events]
    check("started" in kinds, "含 started")
    check("log" in kinds, "含 log 里程碑")
    check("progress" in kinds, "含 progress")
    check("result" in kinds, "含 result")

    # --- started 契约 ---
    st = events[0]
    for field in ("job", "pid", "sidecar_version", "schema_version",
                  "params_echo", "started_at"):
        check(field in st, f"started 含 {field}")
    check(st.get("schema_version") == "0.4",
          f"started.schema_version == 0.4（实际 {st.get('schema_version')}）")
    check(st["params_echo"].get("progress_every") == 3,
          "params_echo 回显了实际生效参数")
    check(st["params_echo"].get("input") == str(tif), "params_echo.input 正确")

    # --- log 的 stage 枚举 ---
    valid_stages = {"open_image", "plan_tiles", "grid_survey", "tile_processing",
                    "merge", "export", "validate"}
    stages = {e["stage"] for e in events if e["event"] == "log"}
    check(stages <= valid_stages,
          f"log.stage 均在枚举内（实际多出 {stages - valid_stages}）")
    check("grid_survey" in stages, f"含 grid_survey 里程碑（实际 {stages}）")

    # --- progress 字段完整 ---
    pr = [e for e in events if e["event"] == "progress"]
    check(len(pr) >= 2, f"progress 事件数 ≥ 2（实际 {len(pr)}）")
    for f in ("stage", "done", "total", "ratio", "elapsed_s", "eta_s",
              "tiles_new", "tiles_cached", "tiles_failed",
              "gaps_found", "gap_area_sqm", "message"):
        check(f in pr[-1], f"progress 含 {f}")

    # --- result 契约 ---
    res = [e for e in events if e["event"] == "result"][0]
    for f in ("job", "out_json", "elapsed_s", "summary", "planting_grid",
              "tiles", "image_area_ha", "px_m", "finished_at"):
        check(f in res, f"result 含 {f}")
    check(res["out_json"] == str(out).replace("\\", "/"),
          f"out_json 用正斜杠（实际 {res['out_json']}）")
    check(res["summary"] is not None, "result.summary 非空")
    check("by_class" in res["summary"], "summary.by_class 存在")
    # 2026-10-17：sidecar 的 class_totals 改为按 CLASS_LABEL_CN 全量初始化
    # （原来只初始化旧 4 类，会把 road/water/office/undeveloped 静默过滤掉 ——
    #  与 CLI 的 by_class 不一致，属于修掉的 bug）。故 by_class 现在含 8 个键，
    # 未出现的类别计数为 0。
    check(set(res["summary"]["by_class"]) ==
          {"vacant_slot", "alley_gap", "open_patch", "uncertain",
           "road", "water", "office", "undeveloped"},
          "by_class 含全部 8 个类别键")
    check(isinstance(res["tiles"]["valid"], int), "tiles.valid 是整数")

    # --- 落盘文件契约 ---
    check(out.exists(), f"结果文件已落盘 {out.name}")
    if out.exists():
        gj = json.loads(out.read_text(encoding="utf-8"))
        check(gj.get("schema_version") == "0.4",
              f"文件 schema_version == 0.3（实际 {gj.get('schema_version')}）")
        check(gj.get("type") == "FeatureCollection", "type == FeatureCollection")
        check(gj.get("crs") == "EPSG:4326", f"crs == EPSG:4326（实际 {gj.get('crs')}）")
        check(gj.get("area_crs") == "EPSG:32649", "area_crs == EPSG:32649")
        check(isinstance(gj.get("blocks"), list) and len(gj["blocks"]) >= 1,
              "blocks 非空")
        if gj.get("blocks"):
            check("gaps" in gj["blocks"][0], "blocks[0].gaps 存在")
            n = len(gj["blocks"][0]["gaps"])
            check(n > 0, f"检出空地数 > 0（实际 {n}）")
            if n:
                g = gj["blocks"][0]["gaps"][0]
                check(g.get("type") == "Feature", "gap 是 GeoJSON Feature")
                check("geometry" in g, "gap 含 geometry")
                check(g["geometry"]["type"] in ("Polygon", "MultiPolygon"),
                      f"geometry 是 Polygon/MultiPolygon（实际 {g['geometry']['type']}）")
                props = g.get("properties", {})
                for f in ("gap_id", "class", "area_sqm", "centroid_utm"):
                    check(f in props, f"gap.properties 含 {f}")
                check(props.get("class") in
                      ("vacant_slot", "alley_gap", "open_patch", "uncertain"),
                      f"class 取值合法（实际 {props.get('class')}）")


def test_resume(tmpdir: Path) -> None:
    print("\n[6] 断点续跑：第二次运行应全部命中缓存")
    tif = tmpdir / "resume.tif"
    make_synthetic(tif, w=2048, h=2048)
    job = {"input": str(tif), "job": "contract-resume",
           "work_dir": str(tmpdir / "jobs"),
           "out_json": str(tmpdir / "resume-gaps.geojson"),
           "min_area": 10.0, "min_canopy_blob": 200}

    e1, rc1, _ = run_sidecar(job, expect_exit=0)
    r1 = [e for e in e1 if e["event"] == "result"][0]

    e2, rc2, _ = run_sidecar(job, expect_exit=0)
    r2 = [e for e in e2 if e["event"] == "result"][0]

    check(rc1 == 0 and rc2 == 0, f"两次都成功（实际 {rc1}/{rc2}）")
    check(r2["tiles"]["cached"] == r2["tiles"]["total"],
          f"第二次全部命中缓存（实际 cached={r2['tiles']['cached']}, "
          f"total={r2['tiles']['total']}）")
    check(r2["tiles"]["processed"] == 0,
          f"第二次无新处理瓦片（实际 {r2['tiles']['processed']}）")
    check(r1["summary"]["total_gap_count"] == r2["summary"]["total_gap_count"],
          "两次结果块数一致（缓存未改变结果）")

    # 参数指纹变化 → 缓存失效
    job2 = dict(job, exg_lo=55.0)
    e3, rc3, _ = run_sidecar(job2, expect_exit=0)
    r3 = [e for e in e3 if e["event"] == "result"][0]
    check(r3["tiles"]["cached"] == 0,
          f"改参数后缓存全部失效（实际 cached={r3['tiles']['cached']}）")
    check(r3["tiles"]["processed"] == r3["tiles"]["total"],
          f"改参数后全部重算（实际 processed={r3['tiles']['processed']}）")


def test_failed_cache(tmpdir: Path) -> None:
    """R11：状态为 failed 的瓦片不能被当缓存命中。

    审查探针 `p_failed_cache.py` 的做法：把一块已完成的瓦片结果改写成
    ``status: "failed"``（指纹保持不变），再重跑。旧 sidecar 会把它算进
    ``skipped`` 并 continue —— rc=0、tiles.cached=1、total_gap_count=0、
    没有任何警告；桌面端任务名固定、从不传 force，于是这一块永远缺失。
    """
    print("\n[6b] 失败瓦片缓存：必须重算 / 只合并时告警（R11）")
    tif = tmpdir / "failed-cache.tif"
    make_synthetic(tif, w=2048, h=2048)
    job = {
        "input": str(tif), "job": "contract-failed-cache",
        "work_dir": str(tmpdir / "jobs"),
        "out_json": str(tmpdir / "failed-cache-gaps.geojson"),
        "min_area": 10.0, "min_canopy_blob": 200,
        "tile_size": 1024, "overlap": 128,       # 2048² → 4 块瓦片
    }
    e1, rc1, _ = run_sidecar(job, expect_exit=0)
    r1 = [e for e in e1 if e["event"] == "result"][0]
    tiles_dir = tmpdir / "jobs" / "contract-failed-cache" / "tiles"
    files = sorted(tiles_dir.glob("*.json"))
    check(len(files) == r1["tiles"]["total"] and len(files) >= 2,
          "首轮产出多块瓦片缓存",
          f"{len(files)} 个文件 / total={r1['tiles']['total']}")

    target = files[0]

    def _mark_failed() -> None:
        obj = json.loads(target.read_text(encoding="utf-8"))
        obj["status"] = "failed"
        obj["gaps"] = []
        obj["stats"] = {}
        obj["error"] = "probe: simulated failure"
        # 故意**保留 fingerprint**：这正是旧代码误判命中的前提
        target.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")

    # ---- ① 常规重跑：failed 必须落到重算 ----
    _mark_failed()
    e2, rc2, _ = run_sidecar(job, expect_exit=0)
    r2 = [e for e in e2 if e["event"] == "result"][0]
    check(rc2 == 0, "重跑成功（rc=0）", str(rc2))
    check(r2["tiles"]["cached"] == r2["tiles"]["total"] - 1,
          "failed 瓦片没被算作命中",
          f"cached={r2['tiles']['cached']} / total={r2['tiles']['total']}")
    check(r2["tiles"]["processed"] == 1, "只有那一块被重算",
          f"processed={r2['tiles']['processed']}")
    check(r2["tiles"]["failed"] == 0, "重算成功，不应记失败")
    check(r2["summary"]["total_gap_count"] == r1["summary"]["total_gap_count"],
          "结果与首轮一致（那一块没丢）",
          f"{r2['summary']['total_gap_count']} vs {r1['summary']['total_gap_count']}")
    check(json.loads(target.read_text(encoding="utf-8"))["status"] == "done",
          "磁盘上的 failed 已被重算结果覆盖")
    check(not any(e.get("code") == "W3002" for e in e2),
          "重算成功后不应发 W3002")

    # ---- ② merge_only：不能重算，但必须如实计入 failed 并发 W3002 ----
    _mark_failed()
    e3, rc3, _ = run_sidecar(dict(job, merge_only=True), expect_exit=0)
    warns = [e for e in e3 if e.get("event") == "warn" and e.get("code") == "W3002"]
    check(rc3 == 0, "merge_only 成功（rc=0）", str(rc3))
    check(len(warns) == 1, "merge_only 下发出 W3002",
          f"实际 {len(warns)} 条")
    r3 = [e for e in e3 if e["event"] == "result"][0]
    check(r3["tiles"]["failed"] >= 1, "结果里如实记 failed",
          f"failed={r3['tiles']['failed']}")
    check(r3["tiles"]["processed"] == 0, "merge_only 不重算瓦片",
          f"processed={r3['tiles']['processed']}")


def test_cache_hit_helper(tmpdir: Path) -> None:
    """R11：CLI 与 sidecar 共用的 `load_cache_hit` 六个分支逐条断言。"""
    print("\n[6c] 共用判定 load_cache_hit：只有 done / skipped 算命中")
    sys.path.insert(0, str(_SCRIPT_DIR))
    import process_image as PI  # noqa: E402

    p = tmpdir / "cache-hit.json"
    fp = "fp-A"

    def write(status: str, fingerprint: str = fp) -> None:
        p.write_text(json.dumps({"status": status, "fingerprint": fingerprint,
                                 "gaps": [], "stats": {}}), encoding="utf-8")

    write("done")
    hit, obj = PI.load_cache_hit(p, fp)
    check(hit and obj is not None, "done + 指纹匹配 → 命中")
    write("skipped")
    hit, obj = PI.load_cache_hit(p, fp)
    check(hit and obj is not None, "skipped + 指纹匹配 → 命中（执行单明确要求）")
    write("failed")
    hit, obj = PI.load_cache_hit(p, fp)
    check(not hit and obj is not None and obj["status"] == "failed",
          "failed → 不命中，但缓存对象仍返回（merge_only 要据此告警）")
    write("done", fingerprint="fp-B")
    hit, obj = PI.load_cache_hit(p, fp)
    check(not hit and obj is None, "指纹不符 → 不命中")
    p.write_text("{not json", encoding="utf-8")
    hit, obj = PI.load_cache_hit(p, fp)
    check(not hit and obj is None, "文件损坏 → 不命中")
    write("done")
    hit, obj = PI.load_cache_hit(p, fp, force=True)
    check(not hit and obj is None, "--force → 强制不命中")


def test_evidence_contract(tmpdir: Path) -> None:
    """R14：别的地块的 CHM 不能拿来定本次影像的全园网格。

    构造一张与影像同 CRS、但整体往东平移约 5 km 的 CHM。旧代码只检查
    "文件存在"就读整张 CHM 求周期图 —— 逐瓦片融合读不到它（无害），
    全园网格却用别人家的株距 / 方位 / 原点，质量还很高，没有任何警告。
    """
    print("\n[6d] R14 证据图约定：不重叠 CHM → 警告 + 退回旧勘察")
    import rasterio
    from rasterio.transform import from_origin

    tif = tmpdir / "far-chm-ortho.tif"
    make_synthetic(tif, w=2048, h=2048)
    with rasterio.open(tif) as src:
        crs, px, ob = src.crs, src.transform.a, src.bounds

    chm = tmpdir / "far-away-chm.tif"
    # 常数 10 m 的高度场 → chm_tree_tops 会得到大量"树冠顶点"，
    # 但它们全部落在影像之外；过滤后应为 0，从而触发退回。
    data = np.full((1, 512, 512), 10.0, dtype=np.float32)
    tr = from_origin(float(ob.left) + 0.045, float(ob.top),
                     abs(px) * 8, abs(px) * 8)
    with rasterio.open(chm, "w", driver="GTiff", width=512, height=512,
                       count=1, dtype="float32", crs=crs, transform=tr) as dst:
        dst.write(data)

    events, rc, _ = run_sidecar({
        "input": str(tif), "job": "contract-evidence",
        "work_dir": str(tmpdir / "jobs"),
        "out_json": str(tmpdir / "evidence-gaps.geojson"),
        "chm_path": str(chm),
        "min_area": 10.0, "min_canopy_blob": 200,
    }, expect_exit=0)
    check(rc == 0, "约定外输入只警告、不中断（rc=0）", str(rc))
    codes = [e.get("code") for e in events if e["event"] == "warn"]
    check("W1005" in codes, "发出 W1005（CHM 没覆盖影像）", f"warn={codes}")
    logs = [e.get("message", "") for e in events if e["event"] == "log"]
    check(any("CHM 与影像不重叠" in m for m in logs),
          "日志写明「CHM 与影像不重叠」并退回勘察")
    r = [e for e in events if e["event"] == "result"][0]
    method = r["planting_grid"]["method"]
    check(method != "chm_periodogram", "全园网格退回 RGB 勘察，不再用别家 CHM",
          f"method={method}")


def test_no_crs(tmpdir: Path) -> None:
    print("\n[7] 缺失坐标信息 → E1005")
    from rasterio.transform import Affine
    import rasterio
    tif = tmpdir / "nocrs.tif"
    data = np.full((3, 512, 512), 120, dtype=np.uint8)
    with rasterio.open(tif, "w", driver="GTiff", width=512, height=512,
                       count=3, dtype="uint8", crs=None, transform=None) as ds:
        ds.write(data)
    events, rc, _ = run_sidecar({
        "input": str(tif), "job": "contract-nocrs",
        "work_dir": str(tmpdir / "jobs")})
    errs = [e for e in events if e["event"] == "error"]
    check(bool(errs), "报错（实际无 error 事件）")
    if errs:
        check(errs[0]["code"] in ("E1005", "E2001"),
              f"错误码属坐标类（实际 {errs[0]['code']}）")


def test_undefined_behavior(tmpdir: Path) -> None:
    print("\n[8] 边角：grid_only 与 limit")
    tif = tmpdir / "edge.tif"
    make_synthetic(tif, w=2048, h=2048)

    # grid_only：不应产出结果文件
    events, rc, _ = run_sidecar({
        "input": str(tif), "job": "contract-gridonly",
        "work_dir": str(tmpdir / "jobs"),
        "grid_only": True}, expect_exit=0)
    res = [e for e in events if e["event"] == "result"][0]
    check(res.get("grid_only") is True, "result.grid_only == true")
    check(res.get("out_json") is None, "grid_only 时 out_json 为 null")
    check(res.get("planting_grid") is not None, "grid_only 仍给 planting_grid")

    # limit：应只处理 N 个瓦片。
    # ⚠️ 影像必须大于 tile_size 才能切出多个瓦片 —— 2048² 在 tile_size=2048 下
    # 只有 1 块，limit=2 也只能得到 1，这是测试用例的坑而非代码问题。
    big = tmpdir / "big.tif"
    make_synthetic(big, w=4608, h=4608)      # 4608/2048 → 3×3 = 9 块
    out2 = tmpdir / "limit-gaps.geojson"
    events, rc, _ = run_sidecar({
        "input": str(big), "job": "contract-limit",
        "work_dir": str(tmpdir / "jobs"),
        "out_json": str(out2),
        "limit": 2,
        "min_area": 10.0, "min_canopy_blob": 200}, expect_exit=0)
    res = [e for e in events if e["event"] == "result"][0]
    check(res["tiles"]["total"] == 2,
          f"limit=2 时 total==2（实际 {res['tiles']['total']}）")


def main() -> int:
    # Windows 上 stdout 编码跟随 locale：英文系统 / GitHub Actions 的
    # windows-latest runner 是 cp1252，打印中文（本文件的测试项名称全是中文）
    # 会直接 UnicodeEncodeError: 'charmap' codec can't encode ...
    # 强制 UTF-8，保证本地（GBK 控制台）与 CI（cp1252）行为一致。
    # 注：读子进程输出已显式 encoding="utf-8"，这里只管本进程的 stdout/stderr。
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except (AttributeError, OSError):
            pass

    print("=" * 70)
    print("sidecar 契约测试")
    print("=" * 70)

    test_self_test()
    test_param_errors()
    test_missing_file()

    with tempfile.TemporaryDirectory(prefix="sidecar-contract-") as td:
        tmpdir = Path(td)
        test_warnings(tmpdir)
        test_success_path(tmpdir)
        test_resume(tmpdir)
        test_failed_cache(tmpdir)
        test_cache_hit_helper(tmpdir)
        test_evidence_contract(tmpdir)
        test_no_crs(tmpdir)
        test_undefined_behavior(tmpdir)

    print("\n" + "=" * 70)
    total = _passed + _failed
    if _failed == 0:
        print(f"全部通过：{_passed}/{total}")
    else:
        print(f"通过 {_passed}/{total}，失败 {_failed}：")
        for f in _failures:
            print(f"  ✗ {f}")
    print("=" * 70)
    return 1 if _failed else 0


if __name__ == "__main__":
    sys.exit(main())
