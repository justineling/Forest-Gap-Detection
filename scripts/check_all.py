#!/usr/bin/env python3
"""一键自检：把所有自动化断言串起来跑一遍。

## 为什么需要它

477 个断言全靠"我记得跑一下" —— 单人项目最大的敌人不是不会写，是**忘了跑**。
这个脚本就是那条防线：跑一次 80 秒，覆盖 5 层。

## 用法

    .venv/Scripts/python.exe scripts/check_all.py          # 全跑
    .venv/Scripts/python.exe scripts/check_all.py --fast   # 跳过 e2e（省 1 分钟）

退出码 0 = 全过；非 0 = 有失败（CI 与 pre-push 钩子都靠它判断）。

## 各层各有各的价值（不是凑数）

| 层 | 抓什么 | 耗时 |
|---|---|---|
| `tsc --noEmit` | 类型错误、未使用的 import | ~3 s |
| `npm test` | 561 项前端断言（纯函数 / store / 一致性） | ~6 s |
| `ruff` | Python 语法错误 + **完全未定义**的名字 | ~0.2 s |
| **`--help` 冒烟** | **CLI 构造期的异常**（argparse 配置错、模块级 NameError） | ~2 s |
| `cargo test` | 42 项 Rust 单测（预检 + 瓦片服务探活） | ~10 s |
| **仓库卫生** | `.gitkeep` 是否仍被 git 跟踪（CI 编译期硬依赖） | ~0.1 s |
| 契约测试 | 95 项 sidecar 契约 | ~60 s |

### ⚠️ 为什么还要查 `.gitkeep`（2026-10-21 一天丢两次）

`desktop/runtime/desktop_entry/.gitkeep` 被 `bundle.resources` 的存在性检查与
CI 的干净 clone 同时依赖。它一天内丢过两次：一次是工程师误删，一次是
**打包脚本清理 `desktop\runtime` 时连带删掉，随后 `git add` 把删除一起提交**。

致命的地方在于**本地完全看不出来**：开发机那个目录里有真的 PyInstaller 产物，
`cargo test` 照样过；只有 CI 在干净 clone 上才炸，且报的是 build.rs 里
一句看不出因果的 resources 错误。所以必须有一条"它还在 git 里吗"的廉价断言。

### ⚠️ 关于 ruff 的能力边界（踩过）

外部评审建议用 `ruff check --select F821,F823,E9` 抓 `mask_skip` 那类 bug。
实测**抓不到** —— 因为 `mask_skip` 是"条件分支里赋值、另一分支使用"，
属于**可能未绑定（possibly-unbound）**，不是"未定义名称（undefined name）"。
pyflakes/ruff 不做流分析；要抓它得上 mypy/pyright。

所以这里补了一层**成本更低但有效**的检查：**每个 CLI 脚本都跑一次 `--help`**。
原因是 argparse 在构造期会执行所有 `add_argument`，能暴露：
· `help="...7.9%"` 这种裸百分号（argparse 的 %-格式化 → ValueError）
· 模块级导入错误
· 参数定义处的 NameError
（这层的现实价值：它当场抓出了 `process_image.py --help` 崩溃的真 bug。）

要真正抓 possibly-unbound，未来可以加 `pyright --level basic`（约 3 s），
但它会带出一批存量告警，需要先清债 —— 不在这一轮范围内。
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PY = ROOT / ".venv" / "Scripts" / "python.exe"
if not PY.exists():
    PY = Path(sys.executable)  # 兜底：不在 venv 里也能跑

# ---- 每个 CLI 脚本都跑一次 --help（见文件头注释：这层抓的是构造期异常）----
CLI_SCRIPTS = [
    "scripts/process_image.py",
    "scripts/sidecar.py",
    "scripts/tile_server.py",
    "scripts/build_chm.py",
    "scripts/build_forest_mask.py",
    "scripts/build_derived.py",
    "scripts/export_arcgis.py",
    "scripts/planting_points.py",
    "scripts/report_summary.py",
    "scripts/eval_validation.py",
    "scripts/check_all.py",
]


def _which(cmd: str) -> str:
    """Windows 上 npm / npx / cargo 都是 .cmd 或 .exe 包装，直接传裸名字会
    FileNotFoundError。用 shutil.which 解析成真实路径。

    ⚠️ 不用 shell=True：shell 会把参数再解释一遍，路径里带空格（本项目的
       "2. 智" 就有）会碎掉，且错误信息会变成 shell 的而不是命令本身的。
    """
    import shutil

    return shutil.which(cmd) or cmd


def run(cmd: list[str], cwd: Path, label: str, tail: int = 6) -> tuple[bool, float]:
    t0 = time.time()
    cmd = [_which(cmd[0]), *cmd[1:]]
    p = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    dt = time.time() - t0
    ok = p.returncode == 0
    mark = "OK  " if ok else "FAIL"
    print(f"  [{mark}] {label}  ({dt:.1f}s)")
    if not ok:
        out = (p.stdout or "") + (p.stderr or "")
        for line in out.strip().splitlines()[-tail:]:
            print(f"         {line}")
    return ok, dt


def main() -> int:
    ap = argparse.ArgumentParser(description="一键自检")
    ap.add_argument("--fast", action="store_true", help="跳过 e2e 与契约测试")
    args = ap.parse_args()

    results: list[tuple[str, bool, float]] = []

    def rec(label: str, ok: bool, dt: float) -> None:
        results.append((label, ok, dt))

    print("=" * 66)
    print("Forest Gap Detection · 一键自检")
    print("=" * 66)

    # ---- 1. TypeScript 类型 ----
    print("\n[1] 前端类型")
    ok, dt = run(["npx", "tsc", "--noEmit"], ROOT / "desktop", "tsc --noEmit")
    rec("tsc", ok, dt)

    # ---- 2. 前端断言 ----
    print("\n[2] 前端断言")
    ok, dt = run(["npm", "test"], ROOT / "desktop", "npm test（561 项）")
    rec("npm test", ok, dt)

    # ---- 3. Python 静态检查 ----
    print("\n[3] Python 静态检查")
    ok_ruff, dt = run(
        [str(PY), "-m", "ruff", "check", "--select", "F821,F823,E9", "--no-cache",
         "scripts/"],
        ROOT, "ruff（语法 + 未定义名）",
    )
    if not ok_ruff:
        # ruff 没装不算失败 —— CI 里会装，本地不强制
        code = subprocess.run([str(PY), "-m", "ruff", "--version"],
                              capture_output=True).returncode
        if code != 0:
            print("         （ruff 未安装，跳过；pip install ruff 可启用）")
            ok_ruff = True
    rec("ruff", ok_ruff, dt)

    # ---- 4. CLI --help 冒烟（见文件头：抓 argparse 构造期异常）----
    print("\n[4] CLI --help 冒烟")
    bad = []
    t0 = time.time()
    for s in CLI_SCRIPTS:
        p = subprocess.run([str(PY), s, "--help"], cwd=str(ROOT),
                           capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        if p.returncode != 0:
            bad.append(s)
            err = (p.stderr or "").strip().splitlines()
            print(f"  [FAIL] {s}")
            for line in err[-3:]:
                print(f"         {line}")
        else:
            print(f"  [OK  ] {s}")
    rec("cli-help", not bad, time.time() - t0)

    # ---- 5. Rust 单测 ----
    print("\n[5] Rust 单测")
    # ⚠️ 必须中和 CARGO_TARGET_DIR：本机可能指向外部目录，
    #    否则会与打包脚本争用同一份 target（踩过：两份 target + 锁文件警告）
    env_cmd = ["env", "-u", "CARGO_TARGET_DIR", "cargo", "test",
               "--message-format=short"]
    ok, dt = run(env_cmd, ROOT / "desktop" / "src-tauri", "cargo test（42 项）")
    rec("cargo test", ok, dt)

    # ---- 6. 过期判定（纯逻辑，秒级）----
    print("\n[6] 结果过期判定")
    ok, dt = run([str(PY), "scripts/test_stale.py"], ROOT, "test_stale（13 项）")
    rec("stale", ok, dt)

    # ---- 7. 验证集评估脚本（用 fixture 跑一遍，确认能算）----
    print("\n[7] 验证集评估脚本")
    ok, dt = run(
        [str(PY), "scripts/eval_validation.py", "--selftest"],
        ROOT, "eval_validation --selftest",
    )
    rec("eval_validation", ok, dt)

    # ---- 8. 文档合规（HTML 三条红线）----
    print("\n[8] 文档合规")
    ok, dt = run([str(PY), "scripts/check_docs.py"], ROOT, "check_docs（6 个 HTML）")
    rec("docs", ok, dt)

    # ---- 9. 批处理括号安全 ----
    # CI 的 frontend job 跑在 ubuntu 上，cmd 的 if 块解析问题它天生抓不到；
    # 这类坑只在真机上炸（2026-10-20 公司电脑：echo 文本里的 (cargo) 让
    # if/else 双双执行、FG_NEED_RUST 没置位，脚本跳过自动安装直到构建才失败）。
    # 所以静态扫描是唯一防线，必须进本清单。
    print("\n[9] 批处理括号安全")
    ok, dt = run(
        [str(PY), "scripts/check_bat_safety.py"],
        ROOT, "check_bat_safety（7 个 bat）",
    )
    rec("bat-safety", ok, dt)

    # ---- 10. 仓库卫生：占位文件必须仍在 git 里 ----
    # 为什么不能用 Test-Path 判：开发机目录里有真产物，文件在不在都能过；
    # 要问的是"**git 跟踪它吗**"，因为 CI 拿到的是干净 clone。
    print("\n[10] 仓库卫生")
    t0 = time.time()
    keep = "desktop/runtime/desktop_entry/.gitkeep"
    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", keep],
        cwd=ROOT, capture_output=True, text=True,
    )
    if tracked.returncode == 0:
        print(f"  [OK  ] {keep} 已被 git 跟踪")
        rec("gitkeep", True, time.time() - t0)
    else:
        print(f"  [FAIL] {keep} 不在 git 里 —— CI 干净 clone 上 tauri-build 会直接失败")
        print("         修法：git checkout <上一个还存在的提交> -- " + keep)
        rec("gitkeep", False, time.time() - t0)

    # ---- 11. 契约测试 ----
    if not args.fast:
        print("\n[11] 契约测试")
        ok, dt = run([str(PY), "scripts/test_sidecar_contract.py"], ROOT,
                     "test_sidecar_contract（95 项）")
        rec("contract", ok, dt)

    # ---- 汇总 ----
    total = sum(dt for _, _, dt in results)
    failed = [label for label, ok, _ in results if not ok]
    print("\n" + "=" * 66)
    if failed:
        print(f"❌ {len(failed)} 项失败：{', '.join(failed)}   （共 {total:.1f}s）")
        return 1
    print(f"✅ 全部通过 · {len(results)} 个检查 · {total:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
