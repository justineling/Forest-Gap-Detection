#!/usr/bin/env python3
"""文档合规检查：HTML 报告的三条项目红线。

## 为什么需要自动化

同一个错误我犯了三次：在 HTML 里写 Markdown 的 `**加粗**`，
渲染出来是字面星号。肉眼很难在 30 KB 的文档里发现，但脚本一眼就能。

三条红线（见 MEMORY.md 的「文档」约定）：
1. **单文件自包含** —— 内联 CSS/SVG，零外部资源、零 `<img>`
2. **无 Markdown 语法残留** —— `**加粗**` / `---` 分隔线在 HTML 里是字面量
3. **标签闭合平衡** —— 手写 HTML 容易漏 `</div>`

## 只管新文档

`docs/08-` / `09-` / `10-` 是这套规范确立后写的。更早的文档（03/01）
是历史产物，可能真的有例外 —— 对它们报错只会制造噪音，掩盖真问题。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 只查这套规范之后写的文档（见文件头）
DIRS = ["docs/08-桌面端", "docs/09-数据与产物", "docs/10-项目评审"]

# 需要配平的块级标签
TAGS = ["div", "table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li",
        "pre", "h2", "h3", "h4", "p", "b", "code", "span"]

# 真正会拉外部资源的写法
# ⚠️ 不能搜 "http://" —— 内联 SVG 的 xmlns 就是 http://www.w3.org/2000/svg，
#    那是命名空间标识符，不会发起请求（这个坑踩过，见 MEMORY.md）
EXTERNAL = re.compile(
    r'(?:<link\b[^>]*href|<script\b[^>]*src|<img\b[^>]*src|@import|url\()'
    r'\s*["\']?((?:https?:)?//[^"\')]*)',
    re.I,
)


def check_file(p: Path) -> list[str]:
    errs: list[str] = []
    try:
        h = p.read_text(encoding="utf-8")
    except UnicodeDecodeError as e:
        return [f"不是 UTF-8：{e}"]

    # 1. 外部资源
    ext = EXTERNAL.findall(h)
    if ext:
        errs.append(f"有 {len(ext)} 处外部资源引用：{ext[:2]}")

    # 2. <img>（红线要求用内联 SVG 或 base64）
    n_img = len(re.findall(r"<img\b", h, re.I))
    if n_img:
        errs.append(f"有 {n_img} 个 <img>（应改为内联 SVG 或 base64）")

    # 3. Markdown 残留
    #
    # ⚠️ 必须先剥离代码块再查 —— `<span class="code">**/*</span>` 是 **glob 通配符**，
    #    完全合法。第一版没剥，直接误报了 `tauri.conf.json` 的 resources 说明。
    #    （这个教训和 "单文件自包含不能搜 http://" 是同一类：
    #      要查"真的违规"，而不是"长得像违规"。）
    # 逐个标签分别剥离：用一个带反向引用的组合正则会让非贪婪匹配跨过
    # 相邻的 `</span>`（实测把 `<span class="code">**/*</span>` 漏过去了）。
    code_free = h
    for tag in ("code", "pre"):
        code_free = re.sub(rf"<{tag}[^>]*>[\s\S]*?</{tag}>", "", code_free,
                           flags=re.I)
    code_free = re.sub(r'<span\s+class="code"[^>]*>[\s\S]*?</span>', "",
                       code_free, flags=re.I)
    n_bold = len(re.findall(r"\*\*[^*<>\n]{1,90}?\*\*", code_free))
    if n_bold:
        errs.append(f"有 {n_bold} 处 Markdown 加粗 `**...**`（应改成 <b>）")
    n_dangling = code_free.count("**") - n_bold * 2
    if n_dangling > 0:
        errs.append(f"有 {n_dangling} 个落单的 `**`")

    # 4. 标签平衡
    unbalanced = []
    for t in TAGS:
        o = len(re.findall(rf"<{t}[\s>]", h, re.I))
        c = len(re.findall(rf"</{t}>", h, re.I))
        if o != c:
            unbalanced.append(f"<{t}> {o} 开 / {c} 闭")
    if unbalanced:
        errs.append("标签不平衡：" + "、".join(unbalanced))

    # 5. 结构完整
    if not h.lstrip().lower().startswith("<!doctype html"):
        errs.append("缺 <!DOCTYPE html>")
    if not h.rstrip().endswith("</html>"):
        errs.append("未以 </html> 结尾（可能被截断）")

    return errs


def main() -> int:
    files: list[Path] = []
    for d in DIRS:
        p = ROOT / d
        if p.exists():
            files.extend(sorted(p.glob("*.html")))

    if not files:
        print("  没有找到 HTML 文档")
        return 0

    bad = 0
    print(f"检查 {len(files)} 个 HTML（{', '.join(DIRS)}）")
    for f in files:
        errs = check_file(f)
        rel = f.relative_to(ROOT)
        if errs:
            bad += 1
            print(f"  [FAIL] {rel}")
            for e in errs:
                print(f"         · {e}")
        else:
            kb = f.stat().st_size / 1024
            print(f"  [OK  ] {rel}  ({kb:.1f} KB)")

    print()
    if bad:
        print(f"❌ {bad}/{len(files)} 个文档不合规")
        return 1
    print(f"✅ {len(files)} 个文档全部合规")
    return 0


if __name__ == "__main__":
    sys.exit(main())
