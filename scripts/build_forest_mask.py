# -*- coding: utf-8 -*-
"""自动生成「非种植区（未开发林）」候选掩膜。

动机
----
园区南部（原「油棕-南部」参考点所在处）经用户核实是**尚未开发的天然林 /
次生林**，不属于油棕种植区。该处野生乔木排列随机、没有 8.35 m 的种植行距，
林间自然林窗会被管线当作「油棕园里的空地」框出来，**虚增全园需补种面积**。

判别依据
--------
DJI Terra 果树模式输出的 `tree_info.json`（树心表）本质是在找**按种植方式
栽下的果树**。因此：

  · 油棕种植区 —— 每 100 m 区块树心密度约 110~160 株/ha
  · 未开发林   —— 野生乔木无种植规律，检出密度骤降到 20~60 株/ha

这个差异比 RGB 上的任何特征都稳定（RGB 上草地与油棕完全不可分，
见 docs/03-算法教学/算法说明与演进史.html）。

⚠️ 重要：结果**必须人工复核**
------------------------------
自动掩膜对阈值敏感。实测同一幅影像：
  · 原始密度 <70 株/ha，连通域 ≥3 ha  → 15.4 ha，影响需补种 16.8%
  · 平滑 σ=1.5 后 <70                 →  6.2 ha，影响 4.0%
  · 平滑 σ=1.5 后 <90                 → 17.0 ha，影响 20.3%
**建议**：本脚本产出候选掩膜 → 用户在 ArcGIS 里沿真实边界修正 →
导出 GeoJSON 回灌 `process_image.py --forest-mask`。

⚠️ 关于「用株距规律性区分稀疏油棕林」——实测**判别力有限**
----------------------------------------------------------
一个合理的担心：**缺株严重的油棕林**（密度也降到 70 以下）会被纯密度规则
误判为未开发林，从而漏报最该补种的地。理论上可用「存留树仍保持 8.3 m 株距」
来区分。但实测**不支持**这个判据：

  · 全园 NND 分布极宽：P10=5.63 / P50=7.20 / P90=8.19 m（峰值 7.8 m 而非 8.35 m）
  · 原因是 DJI 树心定位抖动 σ≈1.8 m，把规则网格的间距抹平了
  · 高密度种植区（≥110 株/ha）的「NND 落在 7.5~9.2 m 比例」：
    **P10=24.2% / P50=36.2% / P90=51.9%**
  · 未开发林部分区块该比例可达 32~35% —— **与种植区严重重叠**

→ 因此 `--nnd-max-frac` 只作为**可选的保守闸门**（默认关闭），
  不能依赖它自动区分。实测误伤风险的另一面：**所有规则对
  高密度种植区块（≥110 株/ha）的命中数均为 0**，即不会误吞正常油棕林；
  真正无法自动判别的只是**「稀疏油棕林 vs 未开发林」这个中间带**。

⚠️ 只查「有没有油棕树」会漏掉「推平待种裸地」——必须加绿度闸门（2026-10-16 修正）
----------------------------------------------------------------------------
用户目视发现：园区西南角（50m 块 (26,13)~(28,11) 一带）大片**已推平清芭、
修好林道与排灌沟的待种空地**被本脚本误判成「未开发林」，在 ArcGIS 里
显示为「不可种植」。

根因：原判据只有「密度<70 且 规律性<25%」，而**推平的裸地同样是 0 棵树**
（密度 8~23、规律性 0%），完美触发掩膜 —— 但它根本不是森林。

实测指纹（50 m 块级中位数）：
| 类型 | 密度 | CHM_P50 | seg树% | **ExG 中位** |
|---|---|---|---|---|
| 健康油棕 | 141~167 | 6.2~8.3 | 67~80 | **65~70** |
| 未开发林（用户确认点 (26,19)） | 44 | 3.4 | 6 | **116** |
| 推平待种裸地（被误判的块） | 8~23 | 0.4~1.5 | 0~15 | **−5 ~ 12** |

→ **ExG（=2G−R−B）是唯一可靠的分界**：裸地为负值，植被 ≥65。
→ ⚠️ **`seg==tree` 不能用作判据**：实测 (27,12) 块 seg 判树 **76%**，
   但 ExG=−5（是裸地）—— DJI 语义分割在该区域完全失效。
→ ⚠️ **CHM 也不能单独用**：(26,21) 块 CHM_P50=5.27 m 却 ExG=12。

修正：新增 `--exg-min`（默认 60）绿度闸门 —— 区块 ExG 中位数低于阈值者
判为推平裸地，从掩膜剔除、释放回可种植。实测释放 26,858 m²
（占 ② 掩膜影响 53.1%、占需补种 6.73%）。

用法
----
  python scripts/build_forest_mask.py                     # 默认：密度<70，≥3 ha
  python scripts/build_forest_mask.py --threshold 90 --smooth 1.5
  python scripts/build_forest_mask.py --out output/forest-mask.geojson
  python scripts/build_forest_mask.py --block-m 50 --nnd-max-frac 25 --exg-min 60
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pyproj
import rasterio
from rasterio.features import shapes as rio_shapes
from scipy import ndimage as ndi
from scipy.spatial import cKDTree
from shapely.geometry import shape as shp_shape
from shapely.ops import transform as shp_transform

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))


def log(msg: str) -> None:
    print(msg, flush=True)


def build_mask(chm_path: str, tree_info_path: str, ortho_path: str,
               out_path: str, threshold: float = 70.0, block_m: float = 100.0,
               smooth_sigma: float = 0.0, min_ha: float = 3.0,
               dedupe_m: float = 4.5, nnd_window: tuple[float, float] = (7.5, 9.2),
               nnd_max_frac: float = -1.0, exg_min: float = 60.0) -> dict:
    """按「区块树心密度」生成非种植区掩膜，返回统计信息。

    参数
    ----
    threshold     : 树心密度阈值（株/ha），低于此判为非种植
    block_m       : 统计区块边长（米）
    nnd_max_frac  : ≥0 时启用「株距规律性」第二道闸门 —— 只有区块内
                    **最近邻间距落在 nnd_window 的比例低于此值**（%）才算非种植。
                    目的：防止把「缺株严重的稀疏油棕林」误判为未开发林。
                    ⚠️ 实测该判据**判别力有限**（见下方 docstring 说明），
                    默认关闭（-1）。
    exg_min       : >0 时启用「绿度闸门」—— 区块 ExG（=2G−R−B）中位数低于
                    此值者判为**推平待种裸地**，从掩膜剔除（0 = 关闭）。
                    裸地 ExG 为负值，健康油棕 65~70，未开发林 95~127。"""
    with rasterio.open(chm_path) as c:
        chm = c.read(1)
        T, H, W = c.transform, c.height, c.width
    px = abs(T.a) * 111320.0
    log(f"参考网格 {W}x{H} @ {px*100:.0f} cm/px")

    with rasterio.open(ortho_path) as o:
        b_r = o.read(1, out_shape=(H, W)).astype(np.float32)
        b_g = o.read(2, out_shape=(H, W)).astype(np.float32)
        b_b = o.read(3, out_shape=(H, W)).astype(np.float32)
        vo = b_r > 0
    valid = vo & np.isfinite(chm)
    # 绿度指数 ExG = 2G - R - B：区分「推平裸地」与「野生植被」的唯一可靠维度
    exg = 2.0 * b_g - b_r - b_b
    if exg_min > 0:
        ev = exg[valid]
        log(f"绿度 ExG：P10={np.percentile(ev,10):.1f} "
            f"P50={np.percentile(ev,50):.1f} P90={np.percentile(ev,90):.1f}")

    a = np.array(json.loads(Path(tree_info_path).read_text(encoding="utf-8"))
                 ["center_list"], float)
    pts = np.column_stack([(a[:, 0] - T.c) / T.a, (a[:, 1] - T.f) / T.e])
    kd = cKDTree(pts)
    nn, _ = kd.query(pts, k=2)
    keep = np.ones(len(pts), bool)
    for i in np.argsort(nn[:, 1]):
        if not keep[i]:
            continue
        for j in kd.query_ball_point(pts[i], dedupe_m / px):
            if j != i and keep[j]:
                keep[j] = False
    pts = pts[keep]
    log(f"树心表：原始 {len(a):,} → 去重后 {len(pts):,}（<{dedupe_m:g} m 合并）")

    # 最近邻间距（米）—— 用于可选的「株距规律性」闸门
    met = pts * px
    _d, _ = cKDTree(met).query(met, k=2)
    nnd = _d[:, 1]
    grid_ok = (nnd >= nnd_window[0]) & (nnd <= nnd_window[1])
    log(f"NND 分布：P10={np.percentile(nnd,10):.2f} "
        f"P50={np.median(nnd):.2f} P90={np.percentile(nnd,90):.2f} m；"
        f"落在 {nnd_window[0]:g}~{nnd_window[1]:g} m 的比例 "
        f"{grid_ok.mean()*100:.1f}%（种植区与未开发林**重叠**，见 docstring）")

    blk = max(8, int(round(block_m / px)))
    ny, nx = int(np.ceil(H / blk)), int(np.ceil(W / blk))
    tb = np.zeros((ny, nx), int)
    np.add.at(tb, (np.clip((pts[:, 1] // blk).astype(int), 0, ny - 1),
                   np.clip((pts[:, 0] // blk).astype(int), 0, nx - 1)), 1)
    area = np.zeros((ny, nx))
    reg = np.full((ny, nx), np.nan)
    exg_blk = np.full((ny, nx), np.nan)
    blk_ok = np.zeros((ny, nx), bool)
    for r in range(ny):
        for c in range(nx):
            r1, c1 = min((r + 1) * blk, H), min((c + 1) * blk, W)
            vv = valid[r * blk:r1, c * blk:c1]
            nv = int(vv.sum())
            blk_ok[r, c] = nv > blk * blk * 0.30
            area[r, c] = nv * px * px / 1e4
            if nv:
                exg_blk[r, c] = float(np.median(exg[r * blk:r1, c * blk:c1][vv]))
            sel = ((met[:, 0] >= c * blk * px) & (met[:, 0] < c1 * px) &
                   (met[:, 1] >= r * blk * px) & (met[:, 1] < r1 * px))
            reg[r, c] = float(grid_ok[sel].mean() * 100) if sel.any() else 0.0
    dens = np.where(blk_ok, tb / np.maximum(area, 1e-9), np.nan)
    log(f"区块 {blk}px = {blk*px:.0f} m，共 {ny}x{nx}；"
        f"密度 P25={np.nanpercentile(dens,25):.0f} "
        f"P50={np.nanpercentile(dens,50):.0f} "
        f"P75={np.nanpercentile(dens,75):.0f} 株/ha")

    # 无效块用最近有效块填充，保证掩膜空间连续
    idx = ndi.distance_transform_edt(~np.isfinite(dens),
                                     return_distances=False, return_indices=True)
    dens_f = dens[tuple(idx)]
    src = ndi.gaussian_filter(dens_f, smooth_sigma) if smooth_sigma > 0 else dens_f

    low = (src < threshold) & blk_ok
    if nnd_max_frac >= 0:
        low &= (reg < nnd_max_frac)
        log(f"已启用株距规律性闸门：仅保留 规律性<{nnd_max_frac:g}% 的区块")
    lab, n = ndi.label(low, structure=np.ones((3, 3)))
    ids = []
    for i in range(1, n + 1):
        ar = (lab == i).sum() * block_m * block_m / 1e4
        if ar >= min_ha:
            ids.append(i)
            ys, xs = np.nonzero(lab == i)
            d = dens[lab == i]
            log(f"  域 {i}: {ar:6.1f} ha  行 {ys.min()}~{ys.max()}  "
                f"列 {xs.min()}~{xs.max()}  密度中位 "
                f"{np.nanmedian(d):.0f} 株/ha")
    if not ids:
        log("⚠️ 未找到任何符合条件的低密度连通域")
    mb = np.isin(lab, ids)
    # ⚠️ 绿度闸门必须放在**连通域判定之后**：
    # 先在整片低密度区里圈出「非种植区」范围，再在其中剔除「推平待种裸地」。
    # 若放在之前，裸地被剔除会把相邻的高绿度小块切断成孤立碎片（< min_ha）
    # 而整体丢弃 —— 实测会误释放 (24,16)(ExG=127) / (25,16)(71) / (26,17)(87)
    # 三个**真有植被**的块。
    if exg_min > 0:
        veg = np.nan_to_num(exg_blk, nan=-999.0) >= exg_min
        removed = int((mb & ~veg).sum())
        mb = mb & veg
        log(f"已启用绿度闸门：在非种植区范围内剔除 {removed} 个低绿度区块"
            f"（ExG<{exg_min:g}，判为推平待种裸地，释放回可种植）")

    mask = np.zeros((H, W), bool)
    for r in range(ny):
        for c in range(nx):
            if mb[r, c]:
                mask[r * blk:min((r + 1) * blk, H),
                     c * blk:min((c + 1) * blk, W)] = True
    mask &= valid
    mask = ndi.binary_fill_holes(mask) & valid
    log(f"掩膜合计 {mask.sum()*px*px/1e4:.1f} ha")

    # 导出多边形（WGS84）
    # ⚠️ 面积门槛必须 < 一个区块的面积（50m 块 = 0.25 ha），否则孤立区块会丢：
    # `rio_shapes` 按 **4-连通** 提取多边形，而上面的 `ndi.label` 用 **8-连通**。
    # 只与邻块**对角**相邻的区块（如 (24,16) 仅与 (25,17) 对角）在像素级不算连通，
    # 会成为一个 0.25 ha 的独立碎片；门槛若设 0.5 ha 就被静默丢弃
    # —— 实测导致 (24,16)(ExG=127) 被误释放。故取 0.2 ha。
    min_poly_ha = max(0.05, block_m * block_m / 1e4 * 0.4)
    to_utm = pyproj.Transformer.from_crs(
        "EPSG:4326", "EPSG:32649", always_xy=True).transform
    feats = []
    for geom, _val in rio_shapes(mask.astype(np.uint8), mask=mask, transform=T):
        g = shp_shape(geom)
        ar = shp_transform(to_utm, g).area / 1e4
        if ar >= min_poly_ha:
            feats.append({"type": "Feature",
                          "properties": {"area_ha": round(ar, 2)},
                          "geometry": geom})
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps({
        "type": "FeatureCollection",
        "crs": {"type": "name",
                "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
        "features": feats}, ensure_ascii=False), encoding="utf-8")
    tot = sum(f["properties"]["area_ha"] for f in feats)
    log(f"已写出 {out_path}  （{len(feats)} 个多边形，{tot:.1f} ha）")

    return {"threshold": threshold, "smooth_sigma": smooth_sigma,
            "block_m": block_m, "n_polygons": len(feats),
            "nnd_max_frac": nnd_max_frac, "exg_min": exg_min,
            "area_ha": round(tot, 2)}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="按 DJI 树心密度生成「非种植区（未开发林）」候选掩膜")
    ap.add_argument("--chm", default="output/chm.tif",
                    help="参考网格（scripts/build_chm.py 产出），用于对齐")
    ap.add_argument("--tree-info", default=r"D:\WGR\tree_info.json",
                    help="DJI Terra 树心表")
    ap.add_argument("--ortho", default=r"D:\WGR\WGR17.tif")
    ap.add_argument("--out", default="output/forest-mask.geojson")
    ap.add_argument("--threshold", type=float, default=70.0,
                    help="树心密度阈值（株/ha），低于此判为非种植。"
                    "油棕种植区实测 110~160，默认 %(default)s")
    ap.add_argument("--block-m", type=float, default=100.0,
                    help="统计区块边长（米），默认 %(default)s")
    ap.add_argument("--smooth", type=float, default=0.0,
                    help="区块密度高斯平滑 σ（单位=区块）。0=不平滑（推荐），"
                    "默认 %(default)s")
    ap.add_argument("--min-ha", type=float, default=3.0,
                    help="保留的连通域最小面积（公顷），默认 %(default)s")
    ap.add_argument("--nnd-window", default="7.5,9.2",
                    help="「标准株距」窗口（米），用于规律性判据。默认 %(default)s")
    ap.add_argument("--nnd-max-frac", type=float, default=-1.0,
                    help="≥0 时启用第二道闸门：只把「最近邻间距落在标准株距窗口的"
                    "比例低于此值(%%)」的区块判为非种植，用于防止误吞"
                    "「缺株严重的稀疏油棕林」。⚠️ 实测判别力有限"
                    "（DJI 树心抖动 σ≈1.8 m 使分布重叠），默认关闭(-1)")
    ap.add_argument("--exg-min", type=float, default=60.0,
                    help="绿度闸门：区块 ExG(=2G-R-B) 中位数低于此值者判为"
                    "「推平待种裸地」并从掩膜剔除（0 = 关闭）。"
                    "实测裸地为负值、健康油棕 65~70、未开发林 95~127，"
                    "默认 %(default)s。⚠️ 不可用 seg==tree 替代："
                    "(27,12) 块 seg 判树 76%% 但 ExG=-5（实为裸地）")
    args = ap.parse_args()

    w = tuple(float(x) for x in args.nnd_window.split(","))
    build_mask(args.chm, args.tree_info, args.ortho, args.out,
               threshold=args.threshold, block_m=args.block_m,
               smooth_sigma=args.smooth, min_ha=args.min_ha,
               nnd_window=(w[0], w[1]), nnd_max_frac=args.nnd_max_frac,
               exg_min=args.exg_min)
    log("")
    log("⚠️ 本掩膜为**候选**，对阈值敏感（实测影响区间 4%~26%）。")
    log("   请在 ArcGIS 里沿真实边界复核/修正后，再用于：")
    log("     python scripts/process_image.py ... --forest-mask <掩膜.geojson>")
    return 0


if __name__ == "__main__":
    sys.exit(main())
