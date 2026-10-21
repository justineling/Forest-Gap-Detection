#!/usr/bin/env python3
"""`--overviews-only` 参数转发链路的端到端冒烟测试。

## 为什么值得单独测

Rust 打包态会给用户点了"建金字塔"之后拼出这条命令：

```
desktop_entry.exe --run-tile-server --overviews-only --source <tif> --ovr-mode copy
```

`desktop_entry.py` 靠下面这四行把它转发给 `tile_server.main()`：

```python
if args[0] in ("--run-tile-server", "--tile-server"):
    import tile_server
    sys.argv = ["tile_server", *args[1:]]
    return tile_server.main()
```

**这条链路在本测试之前从来没被端到端跑过。** 而它上面挂了三种只有真跑才会暴露的错：
· 参数名拼错（`--overviews-only` 写成 `--overviews_only`）→ argparse 直接 exit 2，
  界面只看到"建金字塔失败"，日志里没有任何线索；
· 分发分支写错（比如把 `--run-tile-server` 判断放到 sidecar 后面）→ 进程去跑算法了；
· `sys.argv` 摆错（漏了 `args[1:]` 的切片）→ tile_server 收到 `--run-tile-server`
  这个它不认识的参数，同样 exit 2。

单元测试抓不到这三类 —— 它们全都活在"进程边界 + 字符串参数"上。所以这里
**真的 fork 一个进程**，喂真参数，读它的 stdout JSON 事件流。

## 为什么 256×256 就够

要验的是**转发与分支**，不是金字塔质量。256×256×3 波段 ≈ 200 KB，
建 6 级 overviews 与复制副本都在 0.5 秒内完成。
（真实 4.7 GB 影像走的是同一段代码，只是 IO 慢三个数量级。）

## 覆盖的 4 条路径

| 用例 | 验的是 |
|---|---|
| 1 正常路径 | 参数转发通、plan/done 事件格式、副本真带上 overviews、无 `.part` 残留 |
| 2 残留 `.part` 自愈 | 上次被强退（用户等不及点关闭）留下的半截副本不会让下次直接失败 |
| 3 已有金字塔 | 不重复劳动：源文件已有 → `action=none`；副本已有 → 复用 |
| 4 `--ovr-mode gdal` 无 gdaladdo | 走 `action=error` 分支，退出码 3 且错误里点名 gdaladdo |

## 不碰的东西

· 只读源 tif，不就地写金字塔（`copy` 模式的全部意义就在这）；
· 产生的副本 / `.part` 全部落在 `output/.tile-cache/`（已在 `.gitignore` 里），
  `finally` 里逐个删掉 —— **本测试跑完不许在 output/ 留任何垃圾**。
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import rasterio
from rasterio.transform import from_origin

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
# 与 tile_server 用**同一个** gdaladdo 探测函数：用例 4 的 SKIP 判定必须和实现
# 里的分支条件完全一致，否则会出现"测试以为会报错、实现却真去跑 gdaladdo"。
from tile_server import _find_gdaladdo  # noqa: E402

ROOT = _HERE.parent
ENTRY = _HERE / "desktop_entry.py"
CACHE = ROOT / "output" / ".tile-cache"
# 用当前解释器，而不是硬编码 .venv/Scripts/python.exe：
# 这样在 venv / CI / 别人的机器上跑的都是同一套依赖（rasterio 版本必须一致）。
PY = sys.executable

failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    """打印一条断言结果，失败累加计数（与 test_stale.py 同一套输出风格）。"""
    global failures
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}" + (f"  ·  {detail}" if detail else ""))
    if not ok:
        failures += 1


def make_mini(path: Path, size: int = 256) -> None:
    """造一张 256×256、3 波段、EPSG:4326、**不带金字塔**的迷你 tif。

    写法照抄 `test_sidecar_contract.make_synthetic()` 的思路（rasterio + from_origin
    + uint8 三波段），只是尺寸缩到最小 —— 但 `transform` 与 `crs` 必须是**真的**：
    `overview_plan()` 要读 `ds.width/height`、`ensure_overviews()` 要按 CRS 打开副本，
    crs=None 或单位矩阵会让"能跑通"变成"跑通了一个假场景"。

    ⚠️ rasterio 写 GTiff 默认**不建** overviews，这正是我们要的前置状态；
       不要在这里加 `build_overviews()`。
    """
    rng = np.random.default_rng(7)
    img = np.zeros((3, size, size), dtype=np.uint8)
    # 近似油棕园配色（G 高、R 中、B 低），数值本身不影响本测试，只求是张正常影像
    img[0] = 120 + rng.integers(-6, 7, (size, size))
    img[1] = 150 + rng.integers(-6, 7, (size, size))
    img[2] = 90 + rng.integers(-6, 7, (size, size))

    # 3.3e-7 度/px ≈ 3.6 cm，与真实正射影像同一量级；原点取园区附近
    transform = from_origin(111.19693, 1.19044, 3.3e-7, 3.3e-7)
    with rasterio.open(
        path, "w", driver="GTiff", width=size, height=size,
        count=3, dtype="uint8", crs="EPSG:4326", transform=transform,
    ) as ds:
        ds.write(img)


def run_overviews(source: Path, mode: str = "copy") -> tuple[int, str, str]:
    """跑一次真实的 `--overviews-only`，返回 (退出码, stdout, stderr)。

    参数顺序**故意与 Rust 侧拼出来的完全一致**（`--run-tile-server --overviews-only
    --source ... --ovr-mode ...`）—— 这条测试的全部价值就在这个字符串上，
    顺序变了就不算验过同一条链路。
    """
    cmd = [
        PY, str(ENTRY),
        "--run-tile-server", "--overviews-only",
        "--source", str(source),
        "--ovr-mode", mode,
    ]
    t0 = time.time()
    try:
        p = subprocess.run(
            cmd, cwd=str(ROOT), capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=180,
        )
    except subprocess.TimeoutExpired:
        # 迷你图正常 0.5 秒，180 秒还没完说明卡死（多半是等交互输入）
        print(f"  [FAIL] 子进程超时 180s（{' '.join(cmd)}）")
        return -1, "", "timeout"
    print(f"  （子进程 {time.time() - t0:.1f}s · exit={p.returncode}）")
    return p.returncode, p.stdout or "", p.stderr or ""


def parse_events(stdout: str) -> list[dict]:
    """把 stdout 解析成事件列表；非 JSON 行直接忽略。

    stdout 是**数据通道**（与 sidecar 同一约定），人类可读的话都在 stderr。
    忽略而非报错：万一将来往 stdout 混进一行日志，不应该让整条测试挂掉 ——
    真正要断言的是"有没有 plan / done 事件、字段对不对"。
    """
    events: list[dict] = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            events.append(obj)
    return events


def pick(events: list[dict], name: str) -> dict | None:
    """取第一个 `event == name` 的事件；没有则 None。"""
    return next((e for e in events if e.get("event") == name), None)


def ovr_levels(path: Path) -> list[int]:
    """读影像的 overviews 级别；打不开返回空列表（不抛异常，便于直接拼进断言消息）。"""
    try:
        with rasterio.open(path) as ds:
            return [int(v) for v in ds.overviews(1)]
    except Exception:  # noqa: BLE001
        return []


def has_overviews(path: Path) -> bool:
    """影像是否带金字塔（打不开也算没有）。"""
    return bool(ovr_levels(path))


def main() -> int:
    t_all = time.time()
    tmp = Path(tempfile.mkdtemp(prefix="fg_ovr_"))  # 小写目录名，Windows 上也能跑
    mini = tmp / "mini_ovr_smoke.tif"
    # 副本落在仓库的 output/.tile-cache（tile_server 的 ROOT 是写死的，改不了），
    # 所以这两个路径必须在 finally 里清干净。
    copy_path = CACHE / mini.name
    part_path = CACHE / (mini.name + ".part")

    try:
        print(f"\n临时目录：{tmp}")
        make_mini(mini)
        print(f"迷你影像：{mini}（{mini.stat().st_size / 1024:.0f} KB）")

        # ---------------------------------------------------------------
        print("\nA. 前置条件（源影像本身）")
        # ---------------------------------------------------------------
        with rasterio.open(mini) as ds:
            check(not ds.overviews(1), "源影像无金字塔（否则测的就不是建金字塔这一步）",
                  str(ds.overviews(1)))
            check(ds.crs is not None and ds.crs.to_epsg() == 4326,
                  "源影像 CRS 为 EPSG:4326", str(ds.crs))
            # 单位矩阵 (1,0,0,0,1,0) 意味着没有地理参考 —— 那种影像能跑通也没意义
            check(tuple(ds.transform)[:6] != (1.0, 0.0, 0.0, 0.0, 1.0, 0.0),
                  "源影像有真实 transform", str(tuple(ds.transform)[:6]))
            check((ds.width, ds.height) == (256, 256), "源影像 256×256",
                  f"{ds.width}×{ds.height}")
            check(ds.count == 3, "源影像 3 波段", str(ds.count))

        # ---------------------------------------------------------------
        print("\nB. 正常路径（--run-tile-server --overviews-only --ovr-mode copy）")
        # ---------------------------------------------------------------
        rc, out, err = run_overviews(mini, "copy")
        check(rc == 0, "退出码 0", f"实际 {rc}" + (f" · {err.strip()[-200:]}" if rc else ""))
        events = parse_events(out)
        plan = pick(events, "plan")
        done = pick(events, "done")
        check(plan is not None, "stdout 有 plan 事件（参数确实转发到了 tile_server）")
        check(done is not None, "stdout 有 done 事件")
        if plan is not None:
            check(plan.get("action") == "copy", "plan.action == copy",
                  str(plan.get("action")))
            check(plan.get("enough_space") is True, "plan.enough_space == true",
                  str(plan.get("enough_space")))
            check(plan.get("mode") == "copy", "--ovr-mode 被正确转发", str(plan.get("mode")))
            check(plan.get("has_overviews") is False, "plan 认定源影像无金字塔",
                  str(plan.get("has_overviews")))
        served = Path("")
        if done is not None:
            check(done.get("ok") is True, "done.ok == true", str(done.get("error", "")))
            served = Path(str(done.get("served", "")))
            check(served.exists(), "done.served 指向的文件存在", str(served))
            check(served == copy_path, "served 是 .tile-cache 下的副本（没动源文件）",
                  served.name)
            check(served != mini, "served 不是源文件本身")
            check(has_overviews(served), "副本里真有 overviews（overviews(1) 非空）",
                  str(ovr_levels(served)))
        check(not mini.exists() or not has_overviews(mini),
              "源文件仍未带金字塔（copy 模式不碰原图）")
        parts = sorted(p.name for p in CACHE.glob("*.part"))
        check(parts == [], "output/.tile-cache 下没有 *.part 残留", ", ".join(parts))

        # ---------------------------------------------------------------
        print("\nC. 残留 .part 自愈（守「上次被强退」场景）")
        # ---------------------------------------------------------------
        # 真实故障现场：用户等不及点了关闭 → copy2 写到一半的 .part 留在磁盘上，
        # 而最终路径**不存在**（原子转正还没发生）。下次再导入必须是干净的重新开始。
        CACHE.mkdir(parents=True, exist_ok=True)
        if copy_path.exists():
            copy_path.unlink()  # 只删本测试自己造的那份，清空"已完成"状态
        part_path.write_bytes(b"\x00" * 5120)  # 5 KB 垃圾，模拟半截副本
        check(part_path.exists() and part_path.stat().st_size == 5120,
              "已就位 5 KB 垃圾 .part", f"{part_path.stat().st_size} B")
        rc, out, err = run_overviews(mini, "copy")
        events = parse_events(out)
        done = pick(events, "done")
        check(rc == 0, "退出码 0（垃圾 .part 不该让整次失败）", f"实际 {rc}")
        check(done is not None and done.get("ok") is True, "done.ok == true",
              str((done or {}).get("error", "")))
        check(not part_path.exists(), "垃圾 .part 已被清掉")
        check(copy_path.exists(), "副本被重新建出来", str(copy_path.name))
        check(has_overviews(copy_path), "重建的副本带 overviews")

        # ---------------------------------------------------------------
        print("\nD. 已有金字塔就跳过")
        # ---------------------------------------------------------------
        # D1：源文件**仍然**没有金字塔 —— 所以第三次跑 copy 模式，plan 依旧说 copy
        #     （这是正确行为：copy 模式永远不会去改源文件）。这里验的是**不重复劳动**：
        #     已有的副本会被复用，而不是再复制一遍。
        #
        #     另外验一件容易被忽略的事：**复用分支也必须清残留 `.part`**。
        #     "副本已建好 + 某次中断留下半截 .part" 这个组合会走复用分支提前 return，
        #     如果那里不清，半截副本（真机可能 4.7 GB）就永久躺在用户盘上了。
        part_path.write_bytes(b"\x00" * 5120)
        check(part_path.exists(), "复用前先放一个 5 KB 垃圾 .part（模拟中断残留）")
        rc, out, err = run_overviews(mini, "copy")
        events = parse_events(out)
        plan = pick(events, "plan")
        done = pick(events, "done")
        check(rc == 0, "第三次跑同一源文件：退出码 0", f"实际 {rc}")
        check(done is not None and done.get("ok") is True, "done.ok == true")
        check(plan is not None and plan.get("action") == "copy",
              "plan.action 仍是 copy（copy 模式不改源文件，源影像确实还没有金字塔）",
              str((plan or {}).get("action")))
        if done is not None:
            note = str(done.get("note", ""))
            check("复用" in note, "命中「复用已有副本」分支（没有重复复制）", note[:60])
        check(not part_path.exists(), "★ 复用分支也清掉了残留 .part（否则白占一份副本的磁盘）")

        # D2：源影像**本身带金字塔** → plan.action 必须是 none，且什么都不写。
        #     用上一步产出的副本当 source 来构造这个状态 —— 它就是一张真有
        #     overviews 的 GTiff，正是"用户拿了一张已经处理过的影像"的样子。
        rc, out, err = run_overviews(copy_path, "copy")
        events = parse_events(out)
        plan = pick(events, "plan")
        done = pick(events, "done")
        check(rc == 0, "源影像已有金字塔：退出码 0", f"实际 {rc}")
        check(plan is not None and plan.get("action") == "none",
              "plan.action == none", str((plan or {}).get("action")))
        check(plan is not None and plan.get("has_overviews") is True,
              "plan.has_overviews == true")
        check(done is not None and done.get("ok") is True, "done.ok == true")
        if done is not None:
            check(Path(str(done.get("served", ""))) == copy_path,
                  "action=none 时 served 就是源文件本身")

        # ---------------------------------------------------------------
        print("\nE. --ovr-mode gdal 且本机无 gdaladdo")
        # ---------------------------------------------------------------
        gdaladdo = _find_gdaladdo()
        if gdaladdo:
            print(f"  [SKIP] 本机有 gdaladdo（{gdaladdo}），这条路径会真的去建 .ovr，跳过")
        else:
            rc, out, err = run_overviews(mini, "gdal")
            events = parse_events(out)
            plan = pick(events, "plan")
            done = pick(events, "done")
            check(plan is not None and plan.get("action") == "error",
                  "plan.action == error（预检就知道走不通）",
                  str((plan or {}).get("action")))
            check(rc == 3, "退出码 3（与 build_overviews_only 的约定一致）", f"实际 {rc}")
            check(done is not None and done.get("ok") is False, "done.ok == false")
            err_text = str((done or {}).get("error", ""))
            check("gdaladdo" in err_text, "done.error 里点名 gdaladdo（用户知道该装什么）",
                  err_text[:80])

    finally:
        # ---- 清理：output/ 里一个字节都不许留 ----
        # .part 先删：万一它是半截副本，可能是几百 MB 到几 GB 的垃圾
        for p in (part_path, copy_path):
            try:
                if p.exists():
                    p.unlink()
            except OSError as e:  # noqa: BLE001
                print(f"  [FAIL] 删不掉 {p}：{e}")
        leftover = [p.name for p in (part_path, copy_path) if p.exists()]
        check(not leftover, "清理：output/.tile-cache 里的副本 / .part 已删除",
              ", ".join(leftover))
        shutil.rmtree(tmp, ignore_errors=True)
        check(not tmp.exists(), "清理：临时目录已删除", str(tmp))

    print()
    if failures == 0:
        print(f"✅ 全部通过（{time.time() - t_all:.1f}s）")
        return 0
    print(f"❌ {failures} 项失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
