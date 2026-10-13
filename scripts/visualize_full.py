"""
整幅结果可视化  v1
================================================================================
把 process_image.py 输出的整幅 GeoJSON 画成一张概览图，用于人工快速核对：
    - 底图：原影像降采样（能看到园区轮廓与树冠纹理）
    - 叠加：三类空地按类别着色（连片空地 / 株位空缺 / 林间空隙）
    - 不确定用空心轮廓标出，避免和已定类的混在一起
    - 右下角附图例与统计

为什么单独写一个脚本而不是塞进 process_image.py
--------------------------------------------------------------------------------
可视化只依赖 GeoJSON 与影像金字塔，不参与推理；分开写可以让用户在不重跑
推理的前提下反复调样式（改配色、改抽稀、换底图分辨率），这在核对结果时很常用。

用法
--------------------------------------------------------------------------------
    python scripts/visualize_full.py \
        --geojson output/wgr17-full-gaps.geojson \
        --input D:/WGR/WGR17.tif \
        --out docs/wgr17-full-overview.png \
        --max-px 2000
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import numpy as np

try:
    import rasterio
    from rasterio.enums import Resampling
except ImportError:  # pragma: no cover
    print("需要 rasterio：.venv/Scripts/python.exe -m pip install rasterio")
    raise

from PIL import Image, ImageDraw, ImageFont

# 类别配色（与 UI 保持一致；中国习惯：红=需要处理，绿=正常）
CLASS_STYLE = {
    "open_patch":   ((214, 39, 40),   "连片空地"),
    "vacant_slot":  ((255, 127, 14),  "株位空缺"),
    "alley_gap":    ((44, 160, 44),   "林间空隙"),
    "uncertain":    ((130, 130, 130), "不确定"),
}
CLASS_ORDER = ["open_patch", "vacant_slot", "alley_gap", "uncertain"]

CN_FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/System/Library/Fonts/PingFang.ttc",
]


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for p in CN_FONT_CANDIDATES:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except Exception:  # noqa: BLE001
                continue
    return ImageFont.load_default()


def render_basemap(path: Path, out_w: int, out_h: int) -> Image.Image:
    """用影像金字塔抽出一张 RGB 底图。整幅读会爆内存，必须靠 overview 降采样。"""
    with rasterio.open(path) as ds:
        n = ds.count if ds.count < 4 else 3
        arr = ds.read(list(range(1, n + 1)), out_shape=(n, out_h, out_w),
                      resampling=Resampling.average)
    if n == 1:
        arr = np.repeat(arr, 3, axis=0)
    rgb = np.transpose(arr[:3], (1, 2, 0)).astype(np.uint8)
    # NoData（全 0）画成浅灰，和"影像内容"区分开
    nodata = np.all(rgb == 0, axis=2)
    rgb[nodata] = (238, 238, 238)
    return Image.fromarray(rgb, mode="RGB")


def main() -> int:
    ap = argparse.ArgumentParser(description="整幅空地检测结果可视化")
    ap.add_argument("--geojson", required=True, help="process_image.py 输出的整幅 GeoJSON")
    ap.add_argument("--input", required=True, help="原始 tif（用作底图）")
    ap.add_argument("--out", required=True, help="输出 PNG")
    ap.add_argument("--max-px", type=int, default=2000, help="输出图最长边像素，默认 2000")
    ap.add_argument("--no-basemap", action="store_true", help="不画底图，只在白底上画多边形")
    ap.add_argument("--only-class", default=None,
                    help="只画某一类（open_patch/vacant_slot/alley_gap/uncertain），"
                         "便于分类核查")
    ap.add_argument("--min-area", type=float, default=0.0,
                    help="只画面积 >= 该值的要素（m²），用于挑出大片空地")
    args = ap.parse_args()

    gj_path, tif_path, out_path = Path(args.geojson), Path(args.input), Path(args.out)

    data = json.loads(gj_path.read_text(encoding="utf-8"))
    feats: list[dict] = []
    for blk in data.get("blocks", []):
        feats.extend(blk.get("gaps", []))
    print(f"载入 {len(feats)} 块空地")

    # --- 输出画布尺寸（按影像长宽比）---
    with rasterio.open(tif_path) as ds:
        src_w, src_h = ds.width, ds.height
        bounds = ds.bounds
        src_crs = ds.crs

    if src_w >= src_h:
        W = args.max_px
        H = max(1, int(round(args.max_px * src_h / src_w)))
    else:
        H = args.max_px
        W = max(1, int(round(args.max_px * src_w / src_h)))
    print(f"输出画布 {W} × {H}")

    # --- 底图 ---
    if args.no_basemap:
        img = Image.new("RGB", (W, H), (255, 255, 255))
    else:
        img = render_basemap(tif_path, W, H)
        # 轻微提亮，让叠加的多边形更醒目
        img = Image.blend(img, Image.new("RGB", (W, H), (255, 255, 255)), 0.25)

    # --- 投影：GeoJSON 是 EPSG:4326，底图可能是任意 CRS → 统一转到底图 CRS 再归一化 ---
    from pyproj import Transformer
    to_src = Transformer.from_crs("EPSG:4326", src_crs, always_xy=True)

    def to_px(x: float, y: float) -> tuple[float, float]:
        gx, gy = to_src.transform(x, y)
        px = (gx - bounds.left) / (bounds.right - bounds.left) * W
        py = (bounds.top - gy) / (bounds.top - bounds.bottom) * H
        return px, py

    # --- 分层绘制：先描边（所有），再填充（由小到大，避免大块盖住小块）---
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)

    # 按类别分组，便于控制绘制顺序：小面积先画，保证不被大块遮住
    by_class: dict[str, list[dict]] = {c: [] for c in CLASS_ORDER}
    n_filtered = 0
    for f in feats:
        props = f["properties"]
        if args.only_class and props.get("class") != args.only_class:
            n_filtered += 1
            continue
        if props.get("area_sqm", 0.0) < args.min_area:
            n_filtered += 1
            continue
        c = props.get("class", "uncertain")
        by_class.setdefault(c, []).append(f)
    if n_filtered:
        print(f"按 --only-class/--min-area 过滤掉 {n_filtered} 个要素")

    counts = Counter()
    area_by_class: dict[str, float] = {}
    px_per_m = W / ((bounds.right - bounds.left) * 111320 * np.cos(np.radians(1.19)))

    total = len(feats)
    # 元素过多时按面积抽稀（画布上连 1px 都不到的碎块画了也看不清）
    min_pts_for_shape = 3
    drawn = 0

    for c in CLASS_ORDER:
        items = by_class.get(c, [])
        if not items:
            continue
        items = sorted(items, key=lambda f: f["properties"].get("area_sqm", 0.0))
        color = CLASS_STYLE[c][0]
        fill_rgba = (*color, 150)
        line_rgba = (*color, 255)
        for f in items:
            props = f["properties"]
            a = props.get("area_sqm", 0.0)
            counts[c] += 1
            area_by_class[c] = area_by_class.get(c, 0.0) + a

            geom = f.get("geometry") or {}
            polys = []
            if geom.get("type") == "Polygon":
                polys = [geom["coordinates"]]
            elif geom.get("type") == "MultiPolygon":
                polys = geom["coordinates"]
            for rings in polys:
                if not rings:
                    continue
                outer = rings[0]
                if len(outer) < min_pts_for_shape:
                    continue
                pts = [to_px(x, y) for x, y in outer]
                # 面积太小（画布上 < 1.2 px²）就只点一个像素，避免视觉噪声
                if a * px_per_m * px_per_m < 1.2:
                    cx, cy = pts[0]
                    draw.point((cx, cy), fill=line_rgba)
                    drawn += 1
                    continue
                draw.polygon(pts, fill=fill_rgba)
                # 多边形的边界用细线强调（小要素边框太粗会糊成一片）
                lw = 2 if a >= 150 else 1
                draw.line(pts + [pts[0]], fill=line_rgba, width=lw)
                drawn += 1
    print(f"已绘制 {drawn}/{total} 个多边形")

    img = Image.alpha_composite(img.convert("RGBA"), overlay).convert("RGB")

    # --- 图例 + 统计面板 ---
    d2 = ImageDraw.Draw(img, "RGBA")
    f_title = load_font(max(16, W // 62))
    f_body = load_font(max(12, W // 88))

    pad = max(10, W // 160)
    box_w = int(max(300, W * 0.235))
    n_lines = 3 + len(CLASS_ORDER)
    box_h = int(f_title.size * 2.4 + f_body.size * 1.75 * n_lines)
    bx0, by0 = pad, pad
    d2.rounded_rectangle([bx0, by0, bx0 + box_w, by0 + box_h], radius=8,
                         fill=(255, 255, 255, 232), outline=(60, 60, 60, 200), width=2)

    summary = data.get("summary", {})
    grid = data.get("planting_grid", {})
    y = by0 + int(f_title.size * 0.6)
    d2.text((bx0 + 14, y), "空地检测 · 整幅概览", font=f_title, fill=(20, 20, 20))
    y += int(f_title.size * 1.5)
    d2.line([bx0 + 12, y, bx0 + box_w - 12, y], fill=(180, 180, 180), width=1)
    y += int(f_body.size * 0.7)

    share = summary.get("gap_area_share_pct", 0.0)
    d2.text((bx0 + 14, y),
            f"影像 {data.get('source_image', '?')}  共 {total} 块 / "
            f"{summary.get('total_area_sqm', 0):,.0f} m²（占 {share:.2f}%）",
            font=f_body, fill=(40, 40, 40))
    y += int(f_body.size * 1.75)
    d2.text((bx0 + 14, y),
            f"株距 {grid.get('plant_pitch_m', 0):.2f} m  行距 {grid.get('row_pitch_m', 0):.2f} m  "
            f"错行角 {grid.get('skew_angle_deg', 0):.0f}°  质量 {grid.get('quality', 0):.2f}",
            font=f_body, fill=(40, 40, 40))
    y += int(f_body.size * 1.75)

    for c in CLASS_ORDER:
        col, cn = CLASS_STYLE[c]
        n = counts.get(c, 0)
        ar = area_by_class.get(c, 0.0)
        sw = f_body.size
        d2.rectangle([bx0 + 14, y + 2, bx0 + 14 + sw, y + 2 + sw],
                     fill=(*col, 255), outline=(80, 80, 80, 160))
        d2.text((bx0 + 14 + sw + 10, y),
                f"{cn}  {n} 块 / {ar:,.0f} m²", font=f_body, fill=(30, 30, 30))
        y += int(f_body.size * 1.75)

    # --- 比例尺（1 km 或 500 m，取合适者）---
    if px_per_m > 0:
        for target in (1000, 500, 200, 100):
            bar_px = target * px_per_m
            if 80 <= bar_px <= W * 0.32:
                x1 = W - pad - 20
                x0 = x1 - bar_px
                yb = H - pad - 26
                d2.rectangle([x0, yb, x1, yb + 8], fill=(255, 255, 255, 220),
                             outline=(0, 0, 0, 230), width=2)
                d2.text((x0, yb - f_body.size - 4),
                        f"{target} m" if target < 1000 else f"{target/1000:.0f} km",
                        font=f_body, fill=(0, 0, 0, 240))
                break

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, quality=94)
    print(f"已保存 {out_path}（{img.width}×{img.height}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
