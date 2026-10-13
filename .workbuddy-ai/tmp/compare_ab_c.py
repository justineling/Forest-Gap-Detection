# -*- coding: utf-8 -*-
"""A/B/C 三种「不可种植改判」策略的效果对比。

思路：复用 output/jobs/wgr17-full/tiles/*.json 里已算好的空地多边形，
只重算 landcover 掩膜（优化后约 1~2 秒/瓦片），然后离线套用不同策略门槛，
一次运行即可横向比较全部方案。

策略定义
--------
A 多边形视角：多边形被掩膜覆盖的比例 ≥ thr  → 改判
  （现网默认 thr=0.5，即 `--unplantable-overlap`）
B 掩膜视角  ：该瓦片内掩膜被这些多边形覆盖的比例 ≥ thr → 改判
  （对同一瓦片同类别的所有多边形聚合后判断）
C 独立图层  ：直接输出掩膜本身的多边形，规模 = 掩膜面积

用法：.venv/Scripts/python.exe .workbuddy-ai/tmp/compare_ab_c.py [限制瓦片数]
"""
import json
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.features import rasterize as rio_rasterize
from rasterio.windows import transform as win_transform
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from process_image import plan_tiles  # noqa: E402
from landcover import (detect_unplantable, _features, _bright_mask,  # noqa: E402
                       LandcoverParams)

_P = LandcoverParams()

IMG = r"C:\Users\Justine\Downloads\WGR17-002.tif"
TILES_DIR = ROOT / "output" / "jobs" / "wgr17-full" / "tiles"
PX_M = 0.03299
TILE_SIZE = 2048
OVERLAP = 128
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 0

# ---- 收集缓存里的多边形 ----
polys_by_tile: dict[str, list] = {}
for p in TILES_DIR.glob("*.json"):
    try:
        o = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        continue
    if o.get("status") != "done":
        continue
    polys_by_tile[o["tile_id"]] = o.get("gaps", [])

ds = rasterio.open(IMG)
tiles = plan_tiles(ds.width, ds.height, TILE_SIZE, OVERLAP)
todo = [t for t in tiles if polys_by_tile.get(t.tile_id)]
if LIMIT:
    step = max(1, len(todo) // LIMIT)
    todo = todo[::step][:LIMIT]
print(f"参与对比的瓦片：{len(todo)} 块（共 {len(tiles)} 块，含多边形的 "
      f"{sum(1 for t in tiles if polys_by_tile.get(t.tile_id))} 块）")

rows = []            # 每块多边形的重叠记录
tile_mask_area = {}  # 瓦片 → 掩膜面积
n_done = 0
for t in todo:
    win_buf = t.buf_window(ds)
    data = ds.read(window=win_buf, out_dtype="uint8")
    rgb = np.transpose(data[:3], (1, 2, 0))
    valid = ~np.all(data[:3] == 0, axis=0)
    masks = detect_unplantable(rgb, valid, PX_M)
    aff = win_transform(win_buf, ds.transform)
    shp = masks["road"].shape
    ma = {k: float(v.sum()) * PX_M * PX_M for k, v in masks.items()}
    # 顺带统计「亮+低饱和」掩膜，用于与交接文档实测的 64,689 m² 对照
    lum, sat, _ = _features(rgb)
    bright = _bright_mask(lum, sat, valid, _P) & valid
    ma["bright"] = float(bright.sum()) * PX_M * PX_M
    tile_mask_area[t.tile_id] = ma
    for g in polys_by_tile[t.tile_id]:
        geom = shape(g["geometry"])
        poly_r = rio_rasterize([(geom, 1)], out_shape=shp, transform=aff,
                               dtype=np.uint8, all_touched=False)
        n_poly = int(poly_r.sum())
        if n_poly == 0:
            continue
        poly_area = n_poly * PX_M * PX_M
        rec = {"tile": t.tile_id, "area": poly_area,
               "cls": g["properties"].get("class")}
        for k in ("water", "road", "office"):
            inter = float((poly_r.astype(bool) & masks[k]).sum()) * PX_M * PX_M
            rec[k] = inter
        rows.append(rec)
    n_done += 1
    if n_done % 25 == 0:
        print(f"  ...{n_done}/{len(todo)}")
ds.close()

print(f"\n完成 {n_done} 块瓦片，收集 {len(rows)} 块空地多边形\n")

# ---- 掩膜总量（策略 C 的规模）----
mask_tot = {k: sum(v[k] for v in tile_mask_area.values())
            for k in ("road", "water", "office", "bright")}
print("=" * 74)
print("【掩膜总量】—— road/water/office 即策略 C「独立图层」的规模")
for k, v in mask_tot.items():
    note = "   ← 交接文档实测 64,689 m²" if k == "bright" else ""
    print(f"  {k:<8}{v:>12,.0f} m²{note}")
print("=" * 74)

# ---- 策略 A：多边形被掩膜覆盖比例 ----
print("\n【策略 A】多边形被掩膜覆盖 ≥ thr → 改判")
print(f"{'thr':>6}{'road 块':>10}{'road m²':>12}{'water 块':>10}"
      f"{'office 块':>11}{'office m²':>12}{'合计 m²':>12}")
for thr in (0.5, 0.4, 0.3, 0.2, 0.1):
    cnt = {"road": 0, "water": 0, "office": 0}
    ar = {"road": 0.0, "water": 0.0, "office": 0.0}
    for r in rows:
        # 与 process_tile 一致：按 water > road > office 优先级取最大重叠者
        best, bf = None, 0.0
        for k in ("water", "road", "office"):
            f = r[k] / max(r["area"], 1e-9)
            if f > bf:
                best, bf = k, f
        if best and bf >= thr:
            cnt[best] += 1
            ar[best] += r["area"]
    print(f"{thr:>6.1f}{cnt['road']:>10}{ar['road']:>12,.0f}{cnt['water']:>10}"
          f"{cnt['office']:>11}{ar['office']:>12,.0f}"
          f"{ar['road']+ar['water']+ar['office']:>12,.0f}")

# ---- 策略 B：掩膜被多边形覆盖比例（按瓦片聚合）----
print("\n【策略 B】该瓦片掩膜被多边形覆盖 ≥ thr → 改判（按瓦片聚合）")
print(f"{'thr':>6}{'瓦片数':>9}{'覆盖掩膜 m²':>14}{'占掩膜总量':>12}")
for thr in (0.5, 0.4, 0.3, 0.2):
    n_tiles = 0
    covered = 0.0
    for tid, ma in tile_mask_area.items():
        tot_mask = ma["road"] + ma["water"] + ma["office"]
        if tot_mask <= 0:
            continue
        inter = sum(r["road"] + r["water"] + r["office"]
                    for r in rows if r["tile"] == tid)
        frac = inter / tot_mask
        if frac >= thr:
            n_tiles += 1
            covered += inter
    tot_all = sum(mask_tot.values())
    print(f"{thr:>6.1f}{n_tiles:>9}{covered:>14,.0f}"
          f"{covered/max(tot_all,1e-9)*100:>11.1f}%")

# ---- 多边形与掩膜的总体重叠情况 ----
print("\n【总体重叠】所有多边形里，与 road 掩膜有交集的：")
n_any = sum(1 for r in rows if r["road"] > 0)
print(f"  有交集的多边形 {n_any} / {len(rows)} 块")
if rows:
    fr = np.array([r["road"] / max(r["area"], 1e-9) for r in rows])
    print(f"  road 覆盖比例：最大 {fr.max()*100:.1f}%  中位 {np.median(fr)*100:.2f}%  "
          f">30% 的 {int((fr > 0.3).sum())} 块  >50% 的 {int((fr > 0.5).sum())} 块")
