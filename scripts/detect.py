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
from rasterio.windows import Window, transform as win_transform
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


def canopy_structural(rgb: np.ndarray, sigma: float = 5.0, pct: float = 40.0,
                      min_blob_px: int = 2000):
    """基于冠层结构的分割（无需训练数据）：
       平滑 ExG（把同一株的羽叶连成一片）→ 分位阈值 → 形态学闭/开 → 填洞 → 去小碎块。
       适配油棕「冠层连片、株距规则、裸土与冠层色差明显」的特点。"""
    from scipy import ndimage as ndi

    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    exg = 2 * g - r - b
    sm = ndi.gaussian_filter(exg, sigma=sigma)
    thr = float(np.percentile(sm, pct))
    m = sm > thr
    m = ndi.binary_closing(m, iterations=3)
    m = ndi.binary_opening(m, iterations=2)
    m = ndi.binary_fill_holes(m)
    lab, n = ndi.label(m)
    if n:
        sizes = ndi.sum(m, lab, range(1, n + 1))
        m = np.isin(lab, np.where(sizes >= min_blob_px)[0] + 1)
    log(f"结构法分割：sigma={sigma} 分位={pct}% 阈值={thr:.1f} "
        f"→ 冠层覆盖率 {m.mean()*100:.1f}%（成熟油棕园参考值 60~80%）")
    return m


def complement(canopy: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """空地 = 树冠掩膜的补集（且落在有效数据范围内）"""
    return (~canopy) & valid


# ----------------------------------------------------------------------------
# 4. 矢量化 + 面积计算
# ----------------------------------------------------------------------------
def to_polygons(mask: np.ndarray, affine, raster_crs, min_area_sqm: float):
    """栅格掩膜 → 多边形；面积在 UTM 投影系下计算"""
    to_utm = Transformer.from_crs(raster_crs, TARGET_CRS, always_xy=True)

    def reproj(x, y, z=None):
        lon, lat = to_utm.transform(x, y)
        return lon, lat

    geoms = []
    for geom, val in rio_shapes(mask.astype(np.uint8), mask=mask, transform=affine):
        if int(val) != 1:
            continue
        g = shape(geom)
        if g.is_empty:
            continue
        # 在投影系下算面积
        g_utm = shp_transform(reproj, g)
        a = g_utm.area
        if a < min_area_sqm:
            continue
        geoms.append((g, g_utm, a))
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
    log(f"可视化已导出：{out}  （品红=空地，绿线=树冠边界）")


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

    # --- 矢量化（面积在 UTM 49N 下算）---
    affine = win_transform(win, ds.transform)
    log(f"按最小面积 {args.min_area} m² 过滤（面积在 {TARGET_CRS} 下计算）…")
    geoms = to_polygons(gap, affine, ds.crs, args.min_area)
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

    save_png(rgb, canopy, gap, boxes, Path(args.out_png))

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
