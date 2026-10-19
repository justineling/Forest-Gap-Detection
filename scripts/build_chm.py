# -*- coding: utf-8 -*-
"""从 DSM 生成与正射影像对齐的 CHM（冠层高度模型）。

这是**一次性预处理**：跑完产出 `output/chm.tif`，之后瓦片管线直接读它。

流程
----
  1. 读 DSM（DJI Terra 输出，6.6 cm/px，float32，nodata=-9999）
  2. **清理**：
     · 去尖峰 —— 偏离中值滤波 >4 m 的像素判为摄影测量伪影
     · mask 水体 —— 水面镜面反射导致立体匹配失效，会产生 ±20 m 假高程
     · mask 影像 NoData 区
  3. **DTM 估算**：滑动窗口最小值滤波（默认 30 m）+ 高斯平滑
     ⚠️ 为什么不用「非树像素插值」：实测在 450 万像素上准确率反而更低
     （83.72% vs 84.40%）。原因见 docs 与 memory。
  4. **CHM = DSM − DTM**，重采样到正射影像网格

⚠️ 已知偏差
-----------
DJI Terra 的 DSM 被**平滑过**（5×5 局部粗糙度仅 0.09 m，真实冠层应有 0.5~2 m），
导致冠层高度被**系统性低估约 40%**（油棕真实 7~15 m，CHM 只读到 4~10 m）。
因此**不要套用文献里的绝对阈值**，本项目实测标定结果：
  · 油棕（树心 2 m 内）CHM 中位 **8.61 m**
  · 真负样本（seg=other 且距树心 >5 m）CHM 中位 **1.73 m**
  · 最优单阈值 **5.60 m → 91.01% 准确率**

用法
----
  python scripts/build_chm.py --dsm "D://WGR//dsm.tif" \\
      --segment "D://WGR//segment.tif" --ortho "D://WGR//WGR17.tif" \\
      --out output/chm.tif
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import os

import numpy as np
import rasterio
from rasterio.warp import reproject, Resampling
from scipy import ndimage as ndi

# 与 detect.py 保持一致的日志出口
def log(msg: str) -> None:
    print(msg, flush=True)


def build_chm(dsm_path: str, segment_path: str | None, ortho_path: str,
              out_path: str, win_m: float = 30.0,
              spike_thr: float = 4.0, mask_water: bool = True) -> dict:
    """生成 CHM 并写出。返回统计信息。"""
    with rasterio.open(ortho_path) as o:
        o_tr, o_w, o_h = o.transform, o.width, o.height
        o_crs = o.crs

    with rasterio.open(dsm_path) as ds:
        full_px_m = abs(ds.transform.a) * 111320.0   # 度 → 米（经度方向）
        d_w, d_h = ds.width, ds.height
        d_tr_full = ds.transform
        # 内部按 ds_factor 降采样处理：中值滤波/最小值滤波都是 O(n·k²)，
        # 全分辨率 2.36 万 × 2.23 万（5.27 亿像素）会跑几十分钟。
        # 26 cm/px 对 CHM 完全够用（DTM 窗口 30 m ≈ 113 px）。
        ds_factor = max(1, int(round(0.26 / full_px_m)))
        d = ds.read(1, out_shape=(d_h // ds_factor, d_w // ds_factor)).astype(np.float32)
        d_tr = d_tr_full * d_tr_full.scale(ds_factor, ds_factor)
        px_m = full_px_m * ds_factor
    log(f"DSM {d_w}x{d_h} ({full_px_m*100:.1f} cm/px) → 处理网格 {d.shape[1]}x{d.shape[0]} ({px_m*100:.0f} cm/px)")

    d[~np.isfinite(d) | (d == -9999)] = np.nan
    valid0 = int(np.isfinite(d).sum())

    # --- 1. 去尖峰 ---
    med = ndi.median_filter(np.nan_to_num(d, nan=float(np.nanmedian(d))), size=7)
    spike = np.isfinite(d) & (np.abs(d - med) > spike_thr)
    d[spike] = np.nan
    log(f"去尖峰 {int(spike.sum()):,} px（{spike.sum()/max(valid0,1)*100:.2f}%）")

    # --- 2. mask 水体 ---
    if mask_water and segment_path and Path(segment_path).exists():
        with rasterio.open(segment_path) as sg:
            seg = sg.read(1); sg_tr = sg.transform
        seg_d = np.zeros(d.shape, np.uint8)
        reproject(seg, seg_d, src_transform=sg_tr, src_crs="EPSG:4326",
                  dst_transform=d_tr, dst_crs="EPSG:4326",
                  resampling=Resampling.nearest)
        nw = int((seg_d == 5).sum())
        d[seg_d == 5] = np.nan
        log(f"mask 水体 {nw:,} px（水面立体匹配失效区）")

    # --- 3. DTM：滑动窗口最小值 + 平滑 ---
    wpx = max(3, int(round(win_m / px_m)))
    filled = np.where(np.isfinite(d), d, np.nanmedian(d))
    dtm = ndi.minimum_filter(filled, size=wpx, mode="nearest")
    dtm = ndi.gaussian_filter(dtm, wpx / 2.5)
    log(f"DTM 窗口 {wpx}px = {wpx*px_m:.0f} m")

    chm = d - dtm
    chm[~np.isfinite(d)] = np.nan
    v = chm[np.isfinite(chm)]
    log(f"CHM P5={np.percentile(v,5):.2f} P50={np.percentile(v,50):.2f} "
        f"P95={np.percentile(v,95):.2f} m")

    # --- 4. 对齐到正射影像的**有效区掩膜**（降采样读取，避免 21 亿像素） ---
    with rasterio.open(ortho_path) as o:
        o_valid_small = o.read(1, out_shape=chm.shape) > 0
    chm[~o_valid_small] = np.nan
    log(f"对齐正射有效区后 有效 {np.isfinite(chm).mean()*100:.1f}%")

    # 输出保持处理网格分辨率（26 cm/px）—— 对 CHM 足够，
    # 瓦片管线按需重采样。不输出到全分辨率正射网格（那是 21 亿像素，太重）。
    chm_o = chm
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    prof = dict(driver="GTiff", height=chm.shape[0], width=chm.shape[1], count=1,
                dtype="float32", crs=o_crs, transform=d_tr,
                nodata=np.nan, compress="deflate", tiled=True,
                blockxsize=512, blockysize=512)
    # ⚠️ **原子写入**：先写 .part，成功后再 replace。
    #
    #    为什么必须这样：CHM 要跑 30~40 秒，中途断电 / 蓝屏 / 强杀进程会留下
    #    一个**半截 GeoTIFF**。而检测读到半截 CHM **不会报错** ——
    #    它只是 NaN 区域变少、数值偏小，于是"树高变矮了"，结果静默变错。
    #    半成品比没有更糟：没有的话预检会提示，半截的话什么都看不出来。
    tmp = Path(out_path).with_suffix(Path(out_path).suffix + ".part")
    with rasterio.open(tmp, "w", **prof) as dst:
        dst.write(chm_o, 1)
    os.replace(tmp, out_path)  # 同盘 rename 是原子的
    log(f"已写出 {out_path}")

    return {
        "dsm_px_m": px_m, "dtm_window_m": win_m,
        "spike_removed_px": int(spike.sum()),
        "chm_p5": float(np.percentile(v, 5)),
        "chm_p50": float(np.percentile(v, 50)),
        "chm_p95": float(np.percentile(v, 95)),
        "valid_ratio": float(np.isfinite(chm_o).mean()),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="从 DSM 生成与正射影像对齐的 CHM")
    ap.add_argument("--dsm", default=r"D:/WGR/dsm.tif")
    ap.add_argument("--segment", default=r"D:/WGR/segment.tif",
                    help="DJI Terra 语义分割，用于 mask 水体；留空则不做")
    ap.add_argument("--ortho", default=r"D:/WGR/WGR17.tif")
    ap.add_argument("--out", default="output/chm.tif")
    ap.add_argument("--window-m", type=float, default=30.0,
                    help="DTM 最小值滤波窗口（米），须大于最大冠幅，默认 30")
    ap.add_argument("--spike-thr", type=float, default=4.0,
                    help="去尖峰阈值（米），偏离中值滤波超过此值判为伪影")
    ap.add_argument("--no-mask-water", action="store_true")
    args = ap.parse_args()

    build_chm(args.dsm, args.segment, args.ortho, args.out,
              win_m=args.window_m, spike_thr=args.spike_thr,
              mask_water=not args.no_mask_water)
    return 0


if __name__ == "__main__":
    sys.exit(main())
