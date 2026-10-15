# -*- coding: utf-8 -*-
"""一条命令生成全部文档。

    python scripts/docgen/build_all.py

默认生成三份：
  1. docs/03-算法教学/算法说明与演进史.html            （专业版）
  2. docs/03-算法教学/算法说明与演进史-小白版.html      （小白版）
  3. docs/05-环境与部署/跨机器协同-GoogleDrive放置清单.html

生成完自动做一次校验：检查所有 docs/ 下的 HTML 有无
**外部相对引用**（项目约定必须内联）与 **f-string 占位符残留**。

选项
----
  --only NAME      只跑指定生成器（可重复），NAME ∈ {algo, lite, gdrive}
  --wgr-dir PATH   航测原产物目录（影响 gdrive 的体积统计）
  --no-check       跳过生成后的校验
  --quiet          精简输出
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent

GENERATORS = {
    "algo":   ("gen_algo_pro.py",   "算法说明与演进史（专业版）"),
    "lite":   ("gen_algo_lite.py",  "算法说明与演进史（小白版）"),
    "gdrive": ("gen_gdrive.py",     "跨机器协同-GoogleDrive放置清单"),
}

# 生成物路径（用于校验时定位与展示）
OUTPUTS = {
    "algo":   ROOT / "docs" / "03-算法教学" / "算法说明与演进史.html",
    "lite":   ROOT / "docs" / "03-算法教学" / "算法说明与演进史-小白版.html",
    "gdrive": ROOT / "docs" / "05-环境与部署" / "跨机器协同-GoogleDrive放置清单.html",
}


def run_generator(name: str, extra_args: list[str], quiet: bool) -> bool:
    script, title = GENERATORS[name]
    if not quiet:
        print(f"\n{'=' * 68}\n▶ {title}\n{'=' * 68}")
    cmd = [sys.executable, str(HERE / script), *extra_args]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    out = (r.stdout or "").strip()
    if out:
        print(out)
    if r.returncode != 0:
        print(f"✗ {script} 失败（退出码 {r.returncode}）", file=sys.stderr)
        if r.stderr:
            print(r.stderr.strip()[:800], file=sys.stderr)
        return False
    return True


def verify(quiet: bool = False) -> bool:
    """校验 docs/ 下所有 HTML：无外部相对引用、无 f-string 占位符残留。"""
    if not quiet:
        print(f"\n{'=' * 68}\n▶ 校验全部 HTML\n{'=' * 68}")
    docs = ROOT / "docs"
    bad = 0
    n = 0
    for f in sorted(docs.rglob("*.html")):
        n += 1
        h = f.read_text(encoding="utf-8")
        ext = [u for u in re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', h)
               if not u.startswith(("#", "data:", "http", "//"))]
        ph = re.findall(r'\{(?:mb|sizes|ext_sizes|BODY|CSS|shell|svg_)[^}]*\}', h)
        if ext or ph:
            bad += 1
            print(f"  ⚠️ {f.relative_to(docs)}")
            if ext:
                print(f"      外部引用: {ext[:3]}")
            if ph:
                print(f"      占位符残留: {ph[:3]}")
    if bad:
        print(f"\n✗ 校验未通过：{bad}/{n} 个文件有问题")
        return False
    print(f"✅ 校验通过：{n} 个 HTML 全部干净（无外部引用、无占位符残留）")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="一条命令生成全部文档")
    ap.add_argument("--only", action="append", choices=list(GENERATORS),
                    help="只跑指定生成器（可重复），默认全部")
    ap.add_argument("--wgr-dir", default=None,
                    help="航测原产物目录（传给 gdrive 生成器）")
    ap.add_argument("--no-check", action="store_true", help="跳过生成后的校验")
    ap.add_argument("--quiet", action="store_true", help="精简输出")
    args = ap.parse_args()

    names = args.only or list(GENERATORS)
    extra: list[str] = []
    if args.wgr_dir:
        extra += ["--wgr-dir", args.wgr_dir]

    ok = True
    for nm in names:
        a = extra if nm == "gdrive" else []
        if not run_generator(nm, a, args.quiet):
            ok = False

    if ok and not args.no_check:
        ok = verify(args.quiet)

    if not args.quiet:
        print(f"\n{'=' * 68}")
        print("生成物：")
        for nm in names:
            p = OUTPUTS[nm]
            mark = "✓" if p.exists() else "✗"
            size = f"{p.stat().st_size / 1024:,.1f} KB" if p.exists() else "—"
            print(f"  {mark} {p.relative_to(ROOT)}  {size}")
        print(f"{'=' * 68}")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
