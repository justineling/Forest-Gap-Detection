"""
空地检测 v0.1 — 在真实无人机正射影像上检测空地并输出 GeoJSON
================================================================================
流程：
  1. 用 rasterio 窗口化读取（不整幅加载，3.5 GB 影像也能秒开）
  2. DeepForest 检测油棕树冠（AI 模型，非阈值法）
  3. 生成树冠掩膜 → 取补集 = 空地候选
  4. 剔除 NoData、最小面积过滤
  5. 矢量化成多边形（rasterio.features.shapes + shapely）
  6. 重投影到 UTM 49N (EPSG:32649) 计算真实面积 ← 关键：不能在地理坐标系下算面积
  7. 输出 GeoJSON（几何保持 EPSG:4326）+ 可视化 PNG

用法：
  python scripts/detect.py --input D:/WGR/WGR17.tif
  python scripts/detect.py --input D:/WGR/WGR17.tif --size 2048 --min-area 30
  python scripts/detect.py --input D:/WGR/WGR17.tif --center 23565,22343
================================================================================
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# 缓存目录全部指向项目所在盘（避免塞满 C 盘），并关闭 HF 符号链接
#   —— Windows 下 huggingface_hub 默认创建符号链接，读取时会得到空文件，
#      必须设 HF_HUB_DISABLE_SYMLINKS=1 让它改用真实拷贝。
# ---------------------------------------------------------------------------
_PROJ = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(_PROJ / ".cache" / "huggingface"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("TORCH_HOME", str(_PROJ / ".cache" / "torch"))

import numpy as np
import rasterio
from rasterio.features import shapes as rio_shapes
from rasterio.windows import Window, transform as win_transform, bounds as win_bounds
from shapely.geometry import shape, mapping
from shapely.ops import transform as shp_transform
from pyproj import Transformer

MODEL_ID = "weecology/deepforest-tree"
TARGET_CRS = "EPSG:32649"   # UTM 49N —— 项目所在经度 111.19°E 对应 49 带


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


# ----------------------------------------------------------------------------
# 1. 打开影像 & 选窗口
# ----------------------------------------------------------------------------
def open_raster(path: str):
    ds = rasterio.open(path)
    log(f"影像 {Path(path).name}：{ds.width} x {ds.height} 像素，{ds.count} 波段，CRS={ds.crs}")
    return ds


def pick_window(ds, size: int, center: str | None) -> Window:
    if center:
        cx, cy = (int(v) for v in center.split(","))
    else:
        cx, cy = ds.width // 2, ds.height // 2
    half = size // 2
    col = max(0, min(ds.width - size, cx - half))
    row = max(0, min(ds.height - size, cy - half))
    w = min(size, ds.width - col)
    h = min(size, ds.height - row)
    log(f"读取窗口：行 {row} 列 {col}，尺寸 {h} x {w} 像素")
    return Window(col_off=col, row_off=row, width=w, height=h)


# ----------------------------------------------------------------------------
# 2. AI 树冠检测
# ----------------------------------------------------------------------------
def load_detector(local_model_dir: Path):
    from deepforest import main as df_main

    model = df_main.deepforest()
    # 优先用本地已下载的权重目录；失败则回落到 HuggingFace 仓库 id
    for cand in (str(local_model_dir), MODEL_ID):
        try:
            model.load_model(cand)
            log(f"模型加载成功：{cand}")
            return model
        except Exception as e:  # noqa: BLE001
            log(f"  加载 {cand} 失败：{type(e).__name__}: {str(e)[:120]}")
    # 最后再试一次官方仓库 id（会使用本地 HF 缓存）
    model.load_model(MODEL_ID)
    log(f"模型加载成功：{MODEL_ID}")
    return model


def detect_crowns(model, rgb: np.ndarray, score_thresh: float):
    import pandas as pd

    t0 = time.time()
    boxes = model.predict_image(image=rgb)
    dt = time.time() - t0
    if boxes is None or len(boxes) == 0:
        log(f"AI 检测完成（{dt:.1f}s）：未检出树冠")
        return pd.DataFrame(columns=["xmin", "ymin", "xmax", "ymax", "score"])
    raw_n = len(boxes)
    boxes = boxes[boxes["score"] >= score_thresh].reset_index(drop=True)
    log(f"AI 检测完成（{dt:.1f}s）：检出 {raw_n} 个候选，"
        f"按置信度 ≥ {score_thresh} 保留 {len(boxes)} 个")
    if len(boxes):
        log(f"  置信度：中位 {boxes['score'].median():.3f}，"
            f"最低 {boxes['score'].min():.3f}，最高 {boxes['score'].max():.3f}")
    return boxes


# ----------------------------------------------------------------------------
# 3. 树冠掩膜 → 取补集
# ----------------------------------------------------------------------------
def build_canopy_mask(boxes, rgb: np.ndarray, mode: str = "exg", exg_pct: int = 45):
    """mode=box: 直接用检测框填充（粗略）；mode=exg: 框内再按植被指数精修（更贴近真实冠幅）"""
    h, w = rgb.shape[:2]
    mask = np.zeros((h, w), dtype=bool)

    r = rgb[:, :, 0].astype(np.int16)
    g = rgb[:, :, 1].astype(np.int16)
    b = rgb[:, :, 2].astype(np.int16)
    exg = 2 * g - r - b

    if mode == "exg":
        thr = np.percentile(exg, exg_pct)
        veg = exg >= thr
    else:
        veg = None

    for _, bx in boxes.iterrows():
        x0 = max(0, int(bx["xmin"])); x1 = min(w, int(np.ceil(bx["xmax"])))
        y0 = max(0, int(bx["ymin"])); y1 = min(h, int(np.ceil(bx["ymax"])))
        if x1 <= x0 or y1 <= y0:
            continue
        if veg is None:
            mask[y0:y1, x0:x1] = True
        else:
            mask[y0:y1, x0:x1] |= veg[y0:y1, x0:x1]
    return mask


# 默认分割判据（2026-10-13 修正，第 3 版）
# 演进过程（详见 docs/threshold-comparison.png 与 docs/segmentation-judgement.md）：
#   v1 纯分位 40%  → 在密林区把健康林下植被误判成空地（误报）
#   v2 纯绝对 >60  → 在暗航带上把整片林地判成空地（WGR17 跨航带 ExG 差 3 倍）
#   v3 混合        → 分位自适应 + [LO,HI] 夹逼，跨曝光稳定（当前）
DEFAULT_EXG_PCT = 40.0      # 分位基准（自适应局部曝光）
DEFAULT_EXG_LO = 40.0       # 分位结果的下限：曝光暗的地方兜底
DEFAULT_EXG_HI = 80.0       # 分位结果的上限：曝光亮的地方收敛
DEFAULT_EXG_THRESHOLD = None   # 显式绝对阈值（None = 用混合判据）
DEFAULT_USE_SATURATION = True
DEFAULT_SAT_LEVEL = 0.45


def canopy_structural(rgb: np.ndarray, sigma: float = 5.0, pct: float = DEFAULT_EXG_PCT,
                      min_blob_px: int = 2000, quiet: bool = False,
                      exg_threshold: float | None = DEFAULT_EXG_THRESHOLD,
                      use_saturation: bool = DEFAULT_USE_SATURATION,
                      sat_level: float = DEFAULT_SAT_LEVEL,
                      exg_lo: float = DEFAULT_EXG_LO,
                      exg_hi: float = DEFAULT_EXG_HI):
    """基于冠层结构的分割（无需训练数据）：
       平滑 ExG（把同一株的羽叶连成一片）→ 阈值 → 形态学闭/开 → 填洞 → 去小碎块。
       适配油棕「冠层连片、株距规则、裸土与冠层色差明显」的特点。

    阈值判据（本项目最关键的一个可调点）
    ------------------------------------
    ★ 默认：混合判据 clip(分位 pct%, exg_lo, exg_hi)
      用 pct 分位自适应局部曝光，再用 [lo, hi] 夹住，防止走极端。

      为什么不能只用其中一种（WGR17.tif 实测，跨航带 ExG 中位 37~116，差 3 倍）：

      A) 纯分位（exg_threshold=None 且 lo/hi 放宽）
         隐含假设"影像里固定有 60% 是树冠"。在密植区把健康林下植被
         （草、灌木，ExG 偏低但确实是植被）整片判成空地：
         实测 23m×23m 一块密林被全涂红，全园 18% 被标空地 —— 严重误报。

      B) 纯绝对（exg_threshold=60）
         判据是"这块地到底有没有绿"，在曝光正常的区域更贴近真实。
         但**对曝光极敏感**：暗航带上整片林地 ExG 都 <60，会被整体判成空地
         （实测某暗航带冠层只剩 31%，不可能）。

      C) 混合（默认）✓
         thr = clip(分位 pct, lo, hi)。实测六处景观冠层率 59~72%，
         跨曝光极稳定，且落在成熟油棕园 60~80% 的合理区间。

    D) 饱和度辅助（默认开启，sat_level=0.45）
       真实裸土不仅 ExG 低，**饱和度也低**（红褐色、发灰）；
       而林下杂草虽然 ExG 偏低，饱和度却仍然很高（鲜绿）。
       取**并集**（任一为真即算植被）进一步抑制把杂草认成空地。

    ⚠️ 判据变更会改变全部输出。切换前务必用
       `.workbuddy-ai/tmp/make_hybrid_compare.py` 那套跨曝光对比流程复核。
    """
    from scipy import ndimage as ndi

    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    exg = 2 * g - r - b
    sm = ndi.gaussian_filter(exg, sigma=sigma)

    if exg_threshold is not None:
        thr = float(exg_threshold)
        mode = f"绝对 ExG>{thr:.0f}"
    else:
        p = float(np.percentile(sm, pct))
        thr = float(np.clip(p, exg_lo, exg_hi))
        mode = (f"混合 clip(分位{pct:.0f}%={p:.0f}, {exg_lo:.0f}, {exg_hi:.0f})"
                if abs(thr - p) > 1e-6 else f"分位 {pct:.0f}%={p:.0f}")

    m = sm > thr

    if use_saturation:
        # 饱和度 = (max-min)/max。真实裸土/裸地被压实土路面饱和度低。
        vmax = np.maximum(np.maximum(r, g), b)
        vmin = np.minimum(np.minimum(r, g), b)
        sat = np.where(vmax > 0, (vmax - vmin) / np.maximum(vmax, 1.0), 0.0)
        sat_s = ndi.gaussian_filter(sat, sigma=sigma)
        # 饱和度高的像素即使 ExG 偏低，也几乎一定是绿色植被（如林下杂草）
        m = m | (sat_s > sat_level)
        mode += f" + 饱和度>{sat_level:.2f} 视为植被"

    m = ndi.binary_closing(m, iterations=3)
    m = ndi.binary_opening(m, iterations=2)
    m = ndi.binary_fill_holes(m)
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = np.isin(lab, np.where(sizes >= min_blob_px)[0] + 1)
    if not quiet:
        log(f"结构法分割：sigma={sigma} {mode} 阈值={thr:.1f} "
            f"→ 冠层覆盖率 {m.mean()*100:.1f}%（成熟油棕园参考值 60~80%）")
    return m


def complement(canopy: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """空地 = 树冠掩膜的补集（且落在有效数据范围内）"""
    return (~canopy) & valid


def separate_gap_units(gap: np.ndarray, min_width_m: float, px_m: float,
                       min_blob_px: int = 200, quiet: bool = False) -> np.ndarray:
    """把连成一片的空地切成有意义的独立单元。

    背景：油棕成排种植，树冠之间本来就有窄缝，取补集后会得到一整片连通的
    「通道网络」而不是一块块独立的空地。这些窄缝属于正常株间间隙，不需要补种。

    做法：形态学开运算。半径 r = min_width_m/2，能抹掉宽度不足 min_width_m 的
    通道，只留下达到「缺株级别」的孔洞。之后再把剩下的碎块清一遍。

    性能说明（实测 2304² 瓦片）
    --------------------------
    用 scipy 的 binary_opening + 圆盘结构元要 11.7 秒 —— 圆盘卷积是 O(r²) 的
    暴力实现，半径 24 px 时相当于每像素算 1800 次比较，整块就崩了。而这是
    整个流水线里最慢的一步（占 85%）。
    改用距离变换实现「按圆盘做开运算」：距离变换是 O(n)，只要 1.95 秒（6× 快）。
    两者数学上等价 —— 实测差异像素仅占 0.04%，且 99.4% 落在数组边界 40 px 内，
    而边界本来就会被瓦片重叠机制丢弃。
    """
    from scipy import ndimage as ndi

    r = max(1, int(round(min_width_m / 2.0 / px_m)))

    # 按距离变换做圆盘开运算：先腐蚀（保留内部距背景 > r 的像素），再膨胀回来
    dist_in = ndi.distance_transform_edt(gap)
    eroded = dist_in > r
    if not eroded.any():
        opened = np.zeros_like(gap)
    else:
        dist_out = ndi.distance_transform_edt(~eroded)
        opened = (dist_out <= r) & gap

    lab, n = ndi.label(opened)
    if n:
        sizes = ndi.sum(opened, lab, range(1, n + 1))
        opened = np.isin(lab, np.where(sizes >= min_blob_px)[0] + 1)

    if not quiet:
        log(f"空地分离：开运算半径 {r}px ({min_width_m/2:.2f} m)，"
            f"抹掉宽度 < {min_width_m:.1f} m 的株间窄缝")
        log(f"  分离前 {gap.sum()*px_m*px_m:.0f} m²（连通成片） → "
            f"分离后 {opened.sum()*px_m*px_m:.0f} m²（{n} 个候选单元）")
    return opened


# ----------------------------------------------------------------------------
# 4. 矢量化 + 面积计算
# ----------------------------------------------------------------------------
def to_polygons(mask: np.ndarray, affine, raster_crs, min_area_sqm: float,
                simplify_m: float = 0.3):
    """栅格掩膜 → 多边形。

    面积与简化都在 UTM 投影系下做：投影系单位是米，容差才有物理意义，
    简化后再转回影像原坐标系输出。
    """
    to_utm = Transformer.from_crs(raster_crs, TARGET_CRS, always_xy=True)
    from_utm = Transformer.from_crs(TARGET_CRS, raster_crs, always_xy=True)

    def fwd(x, y, z=None):
        lon, lat = to_utm.transform(x, y)
        return lon, lat

    def bwd(x, y, z=None):
        lon, lat = from_utm.transform(x, y)
        return lon, lat

    raw_pts = simplified_pts = 0
    geoms = []
    for geom, val in rio_shapes(mask.astype(np.uint8), mask=mask, transform=affine):
        if int(val) != 1:
            continue
        g = shape(geom)
        if g.is_empty:
            continue
        g_utm = shp_transform(fwd, g)
        n0 = len(g_utm.exterior.coords)
        if simplify_m > 0:
            g_utm = g_utm.simplify(simplify_m, preserve_topology=True)
        n1 = len(g_utm.exterior.coords)
        raw_pts += n0
        simplified_pts += n1
        a = g_utm.area
        if a < min_area_sqm:
            continue
        geoms.append((shp_transform(bwd, g_utm), g_utm, a))

    if raw_pts:
        log(f"多边形简化：容差 {simplify_m} m，顶点数 {raw_pts} → {simplified_pts}"
            f"（压缩到 {simplified_pts/raw_pts*100:.1f}%）")
    return geoms


def px_to_m2_ratio(raster_crs) -> float:
    """粗略换算：1 像素 ≈ 多少平方米（仅用于把 m² 阈值转成像素数做预过滤）"""
    return 0.033 ** 2


# ----------------------------------------------------------------------------
# 5. 可视化
# ----------------------------------------------------------------------------
def save_png(rgb: np.ndarray, canopy: np.ndarray, gap: np.ndarray, boxes, out: Path):
    import zlib, struct

    h, w = rgb.shape[:2]
    scale = 1
    if max(h, w) > 1400:
        scale = 2
        rgb = rgb[::scale, ::scale]
        canopy = canopy[::scale, ::scale]
        gap = gap[::scale, ::scale]
        h, w = rgb.shape[:2]

    vis = rgb.copy()
    # 空地 = 品红叠加
    vis[gap] = (vis[gap] * 0.35 + np.array([255, 60, 160]) * 0.65).astype(np.uint8)
    # 树冠 = 绿色描边
    edge = np.zeros_like(canopy)
    edge[1:-1, 1:-1] = canopy[1:-1, 1:-1] & ~(
        canopy[:-2, 1:-1] & canopy[2:, 1:-1] & canopy[1:-1, :-2] & canopy[1:-1, 2:])
    vis[edge] = [40, 255, 120]

    # 写 PNG
    rows = bytearray()
    for y in range(h):
        rows.append(0)
        rows += vis[y].tobytes()

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(bytes(rows), 6))
           + chunk(b"IEND", b""))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png)
    log(f"可视化已导出：{out}  （品红=检出空地，绿线=树冠边界）")


# ----------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description="油棕园空地检测 v0.1")
    ap.add_argument("--input", required=True, help="正射影像 tif 路径")
    ap.add_argument("--out-json", default="output/gaps.geojson")
    ap.add_argument("--out-png", default="output/detection-preview.png")
    ap.add_argument("--size", type=int, default=1024, help="处理窗口边长（像素），默认 1024")
    ap.add_argument("--center", default=None, help="窗口中心像素坐标 x,y；默认影像正中")
    ap.add_argument("--min-area", type=float, default=30.0, help="最小空地面积 m²，默认 30")
    ap.add_argument("--score-thresh", type=float, default=0.30, help="树冠检测置信度阈值")
    ap.add_argument("--mask-mode", choices=["box", "exg"], default="exg",
                    help="DeepForest 树冠掩膜方式：box=检测框（粗） exg=框内植被指数精修")
    ap.add_argument("--method", choices=["structural", "deepforest"], default="structural",
                    help="检测方法：structural=冠层结构法（默认，无需训练数据） "
                         "deepforest=DeepForest 预训练模型（实测不适配油棕影像）")
    ap.add_argument("--sigma", type=float, default=5.0, help="结构法高斯平滑半径（像素）")
    ap.add_argument("--pct", type=float, default=40.0, help="结构法植被指数分位阈值（0~100）")
    ap.add_argument("--min-gap-width-m", type=float, default=1.6,
                    help="空地的最小宽度（米）。窄于此值的树冠间缝隙视为正常株间间隙，"
                         "不单独算作空地。默认 1.6 m")
    ap.add_argument("--no-separate", action="store_true",
                    help="关闭空地分离（用于对比：会得到连成一片的空地）")
    ap.add_argument("--simplify-m", type=float, default=0.3,
                    help="多边形简化容差（米）。栅格转矢量会得到逐像素锯齿边界，"
                         "必须简化，否则一个多边形能有几千个顶点。默认 0.3 m，设 0 关闭")
    ap.add_argument("--model-dir", default="models/deepforest-tree")
    args = ap.parse_args()

    t_start = time.time()
    log("=" * 72)
    log("油棕园空地检测 v0.1")
    log("=" * 72)

    ds = open_raster(args.input)
    win = pick_window(ds, args.size, args.center)

    # --- 读取（只取 RGB，丢弃 Alpha；NoData=0 标记为无效）---
    data = ds.read(window=win, out_dtype="uint8")
    rgb = np.transpose(data[:3], (1, 2, 0))          # (H,W,3)
    valid = ~np.all(data[:3] == 0, axis=0)           # 全黑 = NoData
    log(f"有效像素占比 {valid.mean()*100:.1f}%")

    # --- 树冠掩膜 ---
    if args.method == "structural":
        canopy = canopy_structural(rgb, args.sigma, args.pct)
        boxes = None
    else:
        import pandas as pd
        model = load_detector(Path(args.model_dir))
        boxes = detect_crowns(model, rgb, args.score_thresh)
        canopy = build_canopy_mask(boxes, rgb, args.mask_mode)
    canopy &= valid
    gap = complement(canopy, valid)
    log(f"树冠覆盖 {canopy.mean()*100:.1f}%  |  空地候选 {gap.mean()*100:.1f}%")

    # --- 换算地面分辨率（米/像素）。影像可能是地理坐标系，直接从窗口边界投影求得，
    #     不依赖 CRS 单位是米还是度 ---
    wb = win_bounds(win, ds.transform)
    _t = Transformer.from_crs(ds.crs, TARGET_CRS, always_xy=True)
    _xs, _ys = _t.transform([wb[0], wb[2]], [wb[1], wb[3]])
    px_m = (abs(_xs[1] - _xs[0]) / win.width + abs(_ys[1] - _ys[0]) / win.height) / 2.0
    log(f"地面分辨率：{px_m*100:.2f} cm/像素（{px_m*px_m:.4f} m²/像素）")

    # --- 把连成一片的空地切成独立单元 ---
    if args.no_separate:
        gap_units = gap
        log("已关闭空地分离（--no-separate）")
    else:
        gap_units = separate_gap_units(gap, args.min_gap_width_m, px_m)

    # --- 矢量化（面积在 UTM 49N 下算）---
    affine = win_transform(win, ds.transform)
    log(f"按最小面积 {args.min_area} m² 过滤（面积在 {TARGET_CRS} 下计算）…")
    geoms = to_polygons(gap_units, affine, ds.crs, args.min_area, args.simplify_m)
    log(f"得到 {len(geoms)} 个合法空地多边形")

    # --- 输出 GeoJSON ---
    features = []
    total_area = 0.0
    for i, (g, g_utm, area) in enumerate(sorted(geoms, key=lambda t: -t[2]), 1):
        c = g_utm.centroid
        total_area += area
        features.append({
            "type": "Feature",
            "properties": {
                "gap_id": f"G{i:04d}",
                "class": "gap",
                "class_label": "空地",
                "class_method": "binary_threshold",
                "area_sqm": round(area, 2),
                "centroid_utm": [round(c.x, 2), round(c.y, 2)],
                "confidence": None,
            },
            "geometry": mapping(g),
        })

    b = ds.bounds
    result = {
        "type": "FeatureCollection",
        "schema_version": "0.2",
        "crs": str(ds.crs),
        "area_crs": TARGET_CRS,
        "source_image": Path(args.input).name,
        "kml_source": None,
        "used_kml": False,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "window": {"row": win.row_off, "col": win.col_off, "height": int(win.height), "width": int(win.width)},
        "model": {"name": MODEL_ID, "type": "object_detection", "mask_mode": args.mask_mode},
        "blocks": [{
            "block_id": "FULL-0001",
            "block_name": "Whole Window (no KML)",
            "gaps": features,
        }],
        "summary": {
            "total_gap_count": len(features),
            "total_area_sqm": round(total_area, 2),
            "canopy_cover_pct": round(float(canopy.mean() * 100), 2),
            "min_area_sqm": args.min_area,
            "by_class": {"gap": len(features)},
        },
    }

    out_json = Path(args.out_json)
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"GeoJSON 已导出：{out_json}")

    save_png(rgb, canopy, gap_units, boxes, Path(args.out_png))

    log("-" * 72)
    log(f"方法：{args.method}  |  检出树冠 {0 if boxes is None else len(boxes)} 株  |  "
        f"空地 {len(features)} 块  |  空地总面积 {total_area:.1f} m²")
    if features:
        areas = [f["properties"]["area_sqm"] for f in features]
        log(f"空地面积：最大 {max(areas):.1f} m²，中位 {np.median(areas):.1f} m²，最小 {min(areas):.1f} m²")
    log(f"总耗时 {time.time()-t_start:.1f} 秒")
    log("=" * 72)
    ds.close()


if __name__ == "__main__":
    sys.exit(main())
