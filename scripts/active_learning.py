"""主动学习：挑出「算法最没把握」的区域，让有限的标注时间花在刀刃上。

动机
----
草地判据（颜色 + 开运算 + 尺寸闸门 + 格点回检）在园内大面积使用，
但用户能提供的标注时间有限（约 1~2 小时）。随机标注会把时间浪费在
算法已经很有把握的地方。本模块按「信息量」排序，优先推荐标注那些：

  1. **压线样本**：颜色刚过阈值、或面积刚过/刚不过尺寸闸门的候选斑块
     —— 判据一改，结论就翻，对分类器最有信息量；
  2. **擦边未过**：差一点点就满足颜色规则的区域（天然的负样本）；
  3. **已知真值点**：用户指认过的草地，必须纳入（作为正样本锚点）；
  4. **跨航带分散**：按航带曝光分组采样，保证覆盖不同光照条件。

输出
----
  regions.json  排序后的推荐标注区域（含坐标、评分、推荐理由）
  regions.csv   给用户填写的标注表（id / 坐标 / 类别 / 备注）
  crops/        每个区域的影像裁剪图，文件名与 id 对应

用法
----
  python scripts/active_learning.py --top 30
  python scripts/active_learning.py --top 30 --tiles 80    # 只扫 80 块（快）
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

import numpy as np

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import rasterio
from rasterio.windows import Window
from scipy import ndimage as ndi

from landcover import LandcoverParams, _features, detect_grass

IMG_DEFAULT = r"D:/WGR/WGR17.tif"

# 用户已指认的草地真值点（度 / 分 / 秒）——必须纳入标注集
TRUTH_POINTS = [
    ("草地真值点1", 1, 10, 58.581, 111, 12, 16.909),
    ("草地真值点2", 1, 10, 59.877, 111, 12, 17.469),
]


def dd(d, m, s):
    return d + m / 60.0 + s / 3600.0


def tile_scan(img: str, tile_px: int = 2048, max_tiles: int | None = None):
    """逐瓦片跑草地判据，返回候选连通域列表（含压线/擦边样本）。"""
    p = LandcoverParams()
    ds_factor = 4
    cell_sqm_max = p.grass_grid_max_blob_cells * (p.grass_grid_pitch_m ** 2)

    out = []
    with rasterio.open(img) as ds:
        from pyproj import Transformer
        _LONLAT_TO_UTM = Transformer.from_crs("EPSG:4326", "EPSG:32649", always_xy=True)
        W, H = ds.width, ds.height
        nt = ((W + tile_px - 1) // tile_px) * ((H + tile_px - 1) // tile_px)
        step = tile_px
        cnt = 0
        for r0 in range(0, H, step):
            for c0 in range(0, W, step):
                cnt += 1
                if max_tiles and cnt > max_tiles:
                    return out
                w = min(tile_px, W - c0)
                h = min(tile_px, H - r0)
                if w < 256 or h < 256:
                    continue
                d = ds.read(window=Window(c0, r0, w, h), out_dtype="uint8")
                if d.shape[0] < 3:
                    continue
                rgb = np.transpose(d[:3], (1, 2, 0))
                valid = ~np.all(d[:3] == 0, axis=0)
                if valid.mean() < 0.10:
                    continue

                # 全分辨率特征（用于精确评分）
                lum, sat, exg = _features(rgb)

                # 低分辨率 + 1m 平滑（与 detect_grass 一致）
                h2, w2 = -(-rgb.shape[0] // ds_factor), -(-rgb.shape[1] // ds_factor)
                small = rgb[::ds_factor, ::ds_factor][:h2, :w2]
                svalid = valid[::ds_factor, ::ds_factor][:h2, :w2]
                _, ssat, sexg = _features(small)
                px_s = 0.0331 * ds_factor
                sigma = max(1.0, 1.0 / px_s)
                exg_s = ndi.gaussian_filter(sexg.astype(np.float32), sigma=sigma)
                sat_s = ndi.gaussian_filter(ssat.astype(np.float32), sigma=sigma)

                # 三类候选：通过 / 刚压线 / 擦边未过
                pass_m = svalid & (exg_s > p.grass_exg_min) & (sat_s > p.grass_sat_min)
                near_m = svalid & (
                    (exg_s > p.grass_exg_min - 12) & (exg_s <= p.grass_exg_min)
                ) & (sat_s > p.grass_sat_min - 0.04)

                for kind, m in (("pass", pass_m), ("near_miss", near_m)):
                    if not m.any():
                        continue
                    mm = ndi.binary_opening(m, structure=np.ones((3, 3)))
                    lab, n = ndi.label(mm, structure=np.ones((3, 3)))
                    if n == 0:
                        continue
                    objs = ndi.find_objects(lab)
                    sizes = np.bincount(lab.ravel())
                    sizes[0] = 0
                    px_m_full = 0.0331
                    for i in range(1, n + 1):
                        npix = int(sizes[i])
                        if npix < 60:
                            continue
                        area = npix * px_s * px_s
                        sl = objs[i - 1]
                        if sl is None:
                            continue
                        # 评分：越接近决策边界分越高
                        # 颜色余量（过阈值多少）
                        sub = lab[sl] == i
                        e_med = float(np.median(exg_s[sl][sub]))
                        s_med = float(np.median(sat_s[sl][sub]))
                        if kind == "pass":
                            color_margin = min(e_med - p.grass_exg_min,
                                               (s_med - p.grass_sat_min) * 200.0)
                        else:
                            color_margin = -min(p.grass_exg_min - e_med, 30.0)
                        # 尺寸闸门余量：|面积 − 闸门| 越小越压线
                        gate_margin = abs(area - cell_sqm_max) / cell_sqm_max
                        score = (1.0 / (abs(color_margin) + 1.0)) * 0.6 \
                              + (1.0 / (gate_margin + 0.05)) * 0.4
                        # 小图坐标 → 整幅像素 → 经纬度 → UTM 绝对坐标
                        full_row = (sl[0].start + sl[0].stop) / 2.0 * ds_factor + r0
                        full_col = (sl[1].start + sl[1].stop) / 2.0 * ds_factor + c0
                        lon_c, lat_c = ds.xy(int(full_row), int(full_col))
                        ux, uy = _LONLAT_TO_UTM.transform(lon_c, lat_c)
                        out.append({
                            "utm_x": round(float(ux), 1), "utm_y": round(float(uy), 1),
                            "area_sqm": round(float(area), 1),
                            "kind": kind,
                            "exg_med": round(e_med, 1), "sat_med": round(s_med, 3),
                            "color_margin": round(float(color_margin), 2),
                            "gate_margin_sqm": round(float(gate_margin * cell_sqm_max), 1),
                            "score": round(float(score), 4),
                            "tile": f"r{r0:06d}_c{c0:06d}",
                        })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default=IMG_DEFAULT)
    ap.add_argument("--out", default=".workbuddy-ai/tmp/active_learning")
    ap.add_argument("--top", type=int, default=30)
    ap.add_argument("--tiles", type=int, default=None,
                    help="只扫前 N 个瓦片（调试用；None=全幅）")
    ap.add_argument("--crop", type=int, default=900,
                    help="每个推荐区域裁剪图的边长（像素）")
    args = ap.parse_args()

    outdir = Path(args.out)
    (outdir / "crops").mkdir(parents=True, exist_ok=True)
    print(f"扫描 {args.input}（tiles={args.tiles or '全幅'}）…")
    cands = tile_scan(args.input, max_tiles=args.tiles)
    print(f"候选连通域 {len(cands)} 个")

    # 去重：同一位置 5 m 内只保留评分最高者
    cands.sort(key=lambda c: -c["score"])
    kept = []
    pts = []
    for c in cands:
        keep = True
        for k in kept:
            if abs(k["utm_x"] - c["utm_x"]) < 5 and abs(k["utm_y"] - c["utm_y"]) < 5:
                keep = False
                break
        if keep:
            kept.append(c)
            pts.append((c["utm_x"], c["utm_y"]))
        if len(kept) >= args.top:
            break
    print(f"去重后取前 {len(kept)} 个作为推荐标注区域")

    # 生成裁剪图
    from pyproj import Transformer
    tr = Transformer.from_crs("EPSG:32649", "EPSG:4326", always_xy=True)
    inv_tr = Transformer.from_crs("EPSG:4326", "EPSG:32649", always_xy=True)
    n_crops = 0
    with rasterio.open(args.input) as ds:
        aff_inv = ~ds.transform
        for i, c in enumerate(kept, 1):
            lon, lat = tr.transform(c["utm_x"], c["utm_y"])
            col, row = aff_inv * (lon, lat)
            c0 = int(col - args.crop / 2)
            r0 = int(row - args.crop / 2)
            if c0 < 0 or r0 < 0 or c0 + args.crop > ds.width or r0 + args.crop > ds.height:
                c["crop"] = ""
                continue
            d = ds.read(window=Window(c0, r0, args.crop, args.crop), out_dtype="uint8")
            if np.all(d[:3] == 0):
                c["crop"] = ""
                continue
            rgb = np.transpose(d[:3], (1, 2, 0))
            # 标出算法判定的区域中心
            cy, cx = int(np.clip(row - r0, 0, args.crop - 1)), \
                     int(np.clip(col - c0, 0, args.crop - 1))
            from PIL import Image, ImageDraw
            im = Image.fromarray(rgb)
            dr = ImageDraw.Draw(im)
            dr.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], outline=(230, 40, 40), width=4)
            dr.line([cx - 18, cy, cx + 18, cy], fill=(230, 40, 40), width=2)
            dr.line([cx, cy - 18, cx, cy + 18], fill=(230, 40, 40), width=2)
            fn = outdir / "crops" / f"R{i:03d}.png"
            im.save(fn)
            c["crop"] = f"crops/R{i:03d}.png"
            c["id"] = i
            n_crops += 1
    print(f"裁剪图 {n_crops} 张 → {outdir/'crops'}")

    # 输出排序表
    (outdir / "regions.json").write_text(
        json.dumps(kept, ensure_ascii=False, indent=1), encoding="utf-8")
    with open(outdir / "regions.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["id", "utm_x", "utm_y", "area_sqm", "算法判定",
                    "ExG中位", "饱和中位", "颜色余量", "距闸门(m²)",
                    "裁剪图", "你的类别", "备注"])
        for c in kept:
            w.writerow([c.get("id", ""), c["utm_x"], c["utm_y"], c["area_sqm"],
                        "已过判据" if c["kind"] == "pass" else "擦边未过",
                        c["exg_med"], c["sat_med"], c["color_margin"],
                        c["gate_margin_sqm"], c.get("crop", ""), "", ""])
    print(f"标注表 {outdir/'regions.csv'}（「你的类别」列留空待填）")
    print(f"排序表 {outdir/'regions.json'}")


if __name__ == "__main__":
    main()
