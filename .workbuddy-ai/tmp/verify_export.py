# -*- coding: utf-8 -*-
"""读回 ArcGIS 交付包并校验（临时验证脚本）。"""
import sys
import tempfile
import zipfile
from pathlib import Path

import shapefile

d = Path(sys.argv[1])
print(f"交付包目录：{d}")
print("顶层文件：")
for p in sorted(d.iterdir()):
    if p.is_file():
        print(f"  {p.name:<32} {p.stat().st_size:>10,} B")
    else:
        print(f"  {p.name}/")

z = d / "gaps-all-utm49n-shp.zip"
print(f"\n[校验] {z.name}")
with zipfile.ZipFile(z) as zf:
    print("  内含：", zf.namelist())
    prj = zf.read("gaps-all-utm49n-shp.prj").decode("ascii")
    print("  .prj 前 70 字：", prj[:70])
    tmp = Path(tempfile.mkdtemp())
    zf.extractall(tmp)

r = shapefile.Reader(str(tmp / "gaps-all-utm49n-shp.shp"))
print("  要素数：", len(r))
print("  字段：", [f[0] for f in r.fields[1:]])
print("  bbox（米）：", [round(v, 1) for v in r.bbox])
sh = r.shape(0)
print("  ring 首末点闭合：", sh.points[0] == sh.points[-1])
names = [f[0] for f in r.fields[1:]]
print("  首条记录：", dict(zip(names, r.record(0))))
print("  末条记录：", dict(zip(names, r.record(len(r) - 1))))

bc = d / "by-class"
if bc.exists():
    print("\nby-class 拆分：")
    for p in sorted(bc.glob("*.zip")):
        with zipfile.ZipFile(p) as zf:
            t2 = Path(tempfile.mkdtemp())
            zf.extractall(t2)
        rr = shapefile.Reader(str(t2 / (p.stem + ".shp")))
        print(f"  {p.name:<36} {len(rr)} 要素")

print("\n校验完成。")
