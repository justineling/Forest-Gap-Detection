#!/usr/bin/env python3
"""批处理括号安全静态检查：cmd 的 if 块内 echo 文本禁用 ASCII 括号。

## 为什么需要（两次真实事故，第二次 CI 抓不到）

cmd 解析 `if ... ( ... )` 块时，块内 echo 文本里的 ASCII 括号会**提前闭合
代码块**，有两种症状：
· 语法错乱：`. was unexpected at this time.`（脚本中途静默死亡）；
· 更阴险的：**if/else 两个分支都被执行、`set` 丢失** —— 2026-10-20 公司
  电脑实测：`(echo ... (cargo))` 让 check_runtime 的 [缺失]/[ready] 双双
  打印，`FG_NEED_RUST` 没被置位，脚本跳过自动安装，直到 tauri build 才
  失败。而这类问题 CI（ubuntu 上没有 cmd）根本抓不到，只能静态检查。

中文原版 bat 靠全角括号（）天然规避；英文翻译和新代码必须用本检查兜底。

## 检查规则

1. `if (...)` 块内的裸 echo 行，文本不得含 ASCII `(` 或 `)`；
2. 单行 `if ... (echo ...) else (echo ...)`（**任何嵌套深度**），echo 文本
   （从 `(echo` 到第一个 `)` 为止）不得再含 ASCII `(`。

块外的 echo 含括号是合法的（echo 不解析括号），不报。

## 用法

    python scripts/check_bat_safety.py            # 扫描全部 bat
    python scripts/check_bat_safety.py --selftest # 13 项自检

退出码 0 = 合规；1 = 有违规（CI 靠它判断）。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# selftest 样例：每项 (描述, 行列表, 期望违规数)
SELFTEST_CASES = [
    ("块内 echo 含 ASCII 括号（症状1）",
     ["if exist x (", "    echo   bad (parens) here", ")"], 1),
    ("块内 echo 全角括号合法",
     ["if exist x (", "    echo   中文（cargo）工具", ")"], 0),
    ("块内 echo 无括号合法",
     ["if exist x (", "    echo   plain text here", ")"], 0),
    ("单行 if-echo 文本含括号（症状2，公司电脑实测）",
     ["if errorlevel 1 (",
      "    set \"V=1\"",
      "    if \"%L%\"==\"en\" (echo   [missing] tool (cargo)) else (echo   [缺失] 工具)",
      ") else (",
      "    echo   ok",
      ")"], 1),
    ("单行 if-echo 无括号合法",
     ["if \"%L%\"==\"en\" (echo   ready) else (echo   就绪)"], 0),
    ("单行 if-echo 全角括号合法",
     ["if \"%L%\"==\"en\" (echo   missing) else (echo   缺失（cargo）)"], 0),
    ("块外 echo 含 ASCII 括号合法（echo 不解析括号）",
     ["echo   tip (see docs) for details"], 0),
    ("rem 行含括号不算",
     ["if exist x (", "    rem comment (parens) ok", "    echo   fine", ")"], 0),
    ("块内嵌套 for 的 echo 含括号",
     ["for %%f in (a) do (", "    echo   bad (x) y", ")"], 1),
    ("多行块深度恢复后再开新块",
     ["if a (", "    echo   ok", ") else (", "    echo   ok2", ")"], 0),
    ("规则2：else 后的第二段 echo 含括号",
     ["if \"%L%\"==\"en\" (echo a) else (echo b (c))"], 1),
    ("规则2：echo 文本以 ) 结尾但无内嵌 ( 合法",
     ["if \"%L%\"==\"en\" (echo done.) else (echo 完成。)"], 0),
    (":: 注释行跳过",
     [":: note (parens)", "echo   ok"], 0),
]


def scan_lines(lines: list[str]) -> list[tuple[int, str]]:
    """返回 [(行号, 违规类型), ...]。核心逻辑，selftest 与真实扫描共用。"""
    issues: list[tuple[int, str]] = []
    depth = 0
    for lineno, raw in enumerate(lines, 1):
        s = raw.strip()
        if not s or s.lower().startswith("rem") or s.startswith("::"):
            continue
        is_echo = s.lower().startswith("echo")
        # 规则 1：块内裸 echo 文本含 ASCII 括号
        if depth > 0 and is_echo and ("(" in s or ")" in s):
            issues.append((lineno, "块内 echo 文本含 ASCII 括号"))
        # 规则 2：单行 (echo ...)（任何深度），echo 文本到第一个 ) 为止再含 (
        if not is_echo and re.search(r"\(\s*echo\b", s):
            for m in re.finditer(r"\(\s*echo\b", s):
                seg = s[m.end():]
                close = seg.find(")")
                seg_head = seg[:close] if close >= 0 else seg
                if "(" in seg_head:
                    issues.append((lineno, "单行 if-echo 文本含 ASCII 括号（会提前闭合代码块）"))
                    break
        # 块深度：echo 行的括号属于文本，不计入结构
        if not is_echo:
            depth += s.count("(") - s.count(")")
            depth = max(depth, 0)
    return issues


def scan_file(path: Path) -> list[tuple[int, str]]:
    return scan_lines(path.read_text(encoding="utf-8").splitlines())


def bat_files() -> list[Path]:
    files = sorted(ROOT.glob("*.bat")) + sorted((ROOT / "scripts").glob("*.bat"))
    return [f for f in files if f.exists()]


def selftest() -> int:
    bad = 0
    for i, (desc, lines, expect) in enumerate(SELFTEST_CASES, 1):
        got = len(scan_lines(lines))
        ok = got == expect
        print(f"  [{'OK ' if ok else 'FAIL'}] #{i:02d} {desc}  (期望 {expect} 处违规，实际 {got})")
        if not ok:
            bad += 1
    print()
    if bad:
        print(f"❌ selftest {bad} 项失败")
        return 1
    print(f"✅ selftest {len(SELFTEST_CASES)} 项全部通过")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    files = bat_files()
    if not files:
        print("未找到任何 .bat 文件")
        return 1
    total_bad = 0
    for f in files:
        issues = scan_file(f)
        rel = f.relative_to(ROOT)
        if issues:
            total_bad += len(issues)
            print(f"  [违规] {rel}")
            for lineno, kind in issues:
                print(f"      L{lineno}  {kind}")
        else:
            print(f"  [OK  ] {rel}")
    print()
    if total_bad:
        print(f"❌ {total_bad} 处批处理括号违规")
        print("   修法：把 echo 文本里的 ASCII 括号 ( ) 换成 [ ] 或连字符；")
        print("   中文全角括号（）不受影响。参见本文件头注释里的两次事故。")
        return 1
    print(f"✅ {len(files)} 个 bat 全部合规")
    return 0


if __name__ == "__main__":
    sys.exit(main())
