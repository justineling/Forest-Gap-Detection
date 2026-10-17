# -*- coding: utf-8 -*-
"""桌面端原型的本地瓦片 / 辅助服务（**零新依赖**：标准库 + rasterio）。

按 `docs/01-需求与架构/桌面端交互需求与实现映射.md` §0.2 的裁定：
- 算法主链路仍走 stdio NDJSON sidecar（`scripts/sidecar.py`），**不走 HTTP**；
- 只有「浏览器必须用 HTTP 取的东西」才开这个端点：影像瓦片、元数据、
  读取最近一次检测结果、导出。

提供：
    GET  /meta                     影像元数据（外接框 / CRS / 分辨率 / 建议缩放级）
    GET  /tiles/{z}/{x}/{y}.png    XYZ 瓦片（Web Mercator）
    GET  /gaps                     最近一次检测结果 GeoJSON
    POST /export                   把前端编辑后的要素导出为 geojson / csv / kml

用法：
    .venv/Scripts/python.exe scripts/tile_server.py
    # 换影像 / 换端口
    .venv/Scripts/python.exe scripts/tile_server.py --source "drone data/WGR17-002.tif" --port 8765

⚠️ 本影像**没有金字塔（overviews 为空）**，若直接让 GDAL 自己算源窗口，
   低缩放级会尝试整幅读取（47k×44k×3 ≈ 6 GB）而爆内存。
   因此这里自己做「窗口抽取 + 降采样读」，把内存钉死在几百 KB 级。
"""

from __future__ import annotations

import argparse
import io
import json
import math
import os
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.transform import from_bounds as transform_from_bounds
from rasterio.warp import reproject, transform_bounds

ROOT = Path(__file__).resolve().parent.parent

TILE_SIZE = 256
WEB_MERCATOR = "EPSG:3857"
WGS84 = "EPSG:4326"
R_EARTH = 6378137.0

# 原始数据可能在不同机器的不同目录（公司机 D:/WGR、家里机仓库内 drone data/）
SOURCE_CANDIDATES = [
    ROOT / "drone data" / "WGR17-002.tif",
    ROOT / "drone data" / "WGR17.tif",
    Path(r"D:/WGR/WGR17.tif"),
    Path(r"D:/WGR/WGR17-002.tif"),
]
GAPS_CANDIDATES = [
    ROOT / "output" / "wgr17-final-gaps.geojson",
    ROOT / "output" / "wgr17-elev-gaps.geojson",
    ROOT / "output" / "wgr17-full-gaps.geojson",
]


# --------------------------------------------------------------------------
# 瓦片数学
# --------------------------------------------------------------------------
def tile_bounds_wgs84(z: int, x: int, y: int) -> tuple[float, float, float, float]:
    """XYZ 瓦片 → (west, south, east, north)，WGS84 经纬度。"""
    n = 2 ** z
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0

    def lat(yy: int) -> float:
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * yy / n))))

    north = lat(y)
    south = lat(y + 1)
    return west, south, east, north


def lonlat_to_mercator(lon: float, lat: float) -> tuple[float, float]:
    lat = max(min(lat, 85.05112878), -85.05112878)
    mx = lon * math.pi / 180.0 * R_EARTH
    my = math.log(math.tan(math.pi / 4.0 + lat * math.pi / 360.0)) * R_EARTH
    return mx, my


# --------------------------------------------------------------------------
# 服务
# --------------------------------------------------------------------------
class TileServer:
    def __init__(self, source: Path, gaps: Path | None, cache_size: int = 512):
        self.source = source
        self.gaps_path = gaps
        self.cache: OrderedDict[tuple[int, int, int], bytes] = OrderedDict()
        self.cache_size = cache_size
        self.lock = threading.Lock()
        self._ds = None
        self._meta: dict | None = None

    # ---- 数据集（每个线程各自持有一个只读句柄，避免 GDAL 句柄跨线程问题）----
    def dataset(self):
        local = getattr(threading.current_thread(), "_fgd_ds", None)
        if local is None:
            local = rasterio.open(self.source)
            setattr(threading.current_thread(), "_fgd_ds", local)
        return local

    def meta(self) -> dict:
        if self._meta is not None:
            return self._meta
        with rasterio.open(self.source) as ds:
            w, s, e, n = transform_bounds(ds.crs, WGS84, *ds.bounds)
            cx, cy = (w + e) / 2.0, (s + n) / 2.0
            # 建议初始缩放级：让影像宽度约铺满 1000 px 视口
            span_lon = max(e - w, 1e-9)
            z = math.log2(360.0 / span_lon * 1000.0 / 256.0)
            zoom = float(max(10.0, min(19.0, round(z, 2))))
            self._meta = {
                "ok": True,
                "source": str(self.source),
                "width": ds.width,
                "height": ds.height,
                "bands": ds.count,
                "crs": str(ds.crs),
                "res_m": abs(ds.res[0]) * 111320.0,
                "bounds_wgs84": [w, s, e, n],
                "center": [cx, cy],
                "zoom": zoom,
                "has_overviews": bool(ds.overviews(1)),
                "tile_url": "/tiles/{z}/{x}/{y}.png",
            }
        return self._meta

    # ---- 瓦片 ----
    def tile(self, z: int, x: int, y: int) -> bytes:
        key = (z, x, y)
        with self.lock:
            hit = self.cache.get(key)
            if hit is not None:
                self.cache.move_to_end(key)
                return hit

        png = self._render_tile(z, x, y)

        with self.lock:
            self.cache[key] = png
            if len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)
        return png

    def _render_tile(self, z: int, x: int, y: int) -> bytes:
        ds = self.dataset()
        west, south, east, north = tile_bounds_wgs84(z, x, y)

        # 1) 瓦片范围 → 影像 CRS
        try:
            sw, ss, se, sn = transform_bounds(WGS84, ds.crs, west, south, east, north)
        except Exception:
            return blank_png()

        # 2) 与影像外接框求交，取像素窗口
        #    ⚠️ rasterio 的 Window.intersection 在**无交集时会抛 WindowError**
        #    （不是返回空窗口）。低缩放级/园区外的瓦片必然走到这里，
        #    必须捕获后返回透明瓦片，否则每个请求都会抛栈。
        full = rasterio.windows.Window(0, 0, ds.width, ds.height)
        try:
            win = rasterio.windows.from_bounds(sw, ss, se, sn, transform=ds.transform)
            win = win.intersection(full)
        except Exception:
            return blank_png()
        if win.width < 1 or win.height < 1:
            return blank_png()
        try:
            win = win.round_offsets().round_lengths()
        except Exception:
            return blank_png()
        if win.width < 1 or win.height < 1:
            return blank_png()

        # 3) 降采样读：把源窗口压到「目标瓦片量级」，内存与耗时都可控。
        #    ⚠️ 只取 RGB 前 3 个波段。本影像第 4 波段恒为 255（Alpha），
        #    若把 4 个波段一起送进 reproject 而目标是 3 波段，GDAL 会直接报错。
        budget = TILE_SIZE * 4
        decim = max(1, int(math.ceil(max(win.width, win.height) / budget)))
        out_w = max(1, int(round(win.width / decim)))
        out_h = max(1, int(round(win.height / decim)))
        if ds.count >= 3:
            indexes = [1, 2, 3]
        else:
            indexes = [1] * 3
        try:
            arr = ds.read(
                indexes,
                window=win,
                out_shape=(3, out_h, out_w),
                resampling=Resampling.average,
                boundless=False,
            )
        except Exception:
            return blank_png()
        if arr.size == 0:
            return blank_png()

        # 4) 小图 → 3857 的 256×256
        bw, bs, be, bn = rasterio.windows.bounds(win, ds.transform)
        src_transform = transform_from_bounds(bw, bs, be, bn, arr.shape[2], arr.shape[1])
        mx0, my0 = lonlat_to_mercator(west, south)
        mx1, my1 = lonlat_to_mercator(east, north)
        dst_transform = transform_from_bounds(mx0, my0, mx1, my1, TILE_SIZE, TILE_SIZE)
        dst = np.zeros((3, TILE_SIZE, TILE_SIZE), dtype=np.uint8)
        try:
            reproject(
                source=arr,
                destination=dst,
                src_transform=src_transform,
                src_crs=ds.crs,
                dst_transform=dst_transform,
                dst_crs=WEB_MERCATOR,
                resampling=Resampling.bilinear,
                dst_nodata=0,
                num_threads=2,
            )
        except Exception:
            return blank_png()

        rgb = np.moveaxis(dst, 0, -1)
        img = Image.fromarray(rgb, mode="RGB")
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=False, compress_level=3)
        return buf.getvalue()

    # ---- 检测结果 ----
    def gaps_json(self) -> bytes:
        if self.gaps_path and self.gaps_path.exists():
            return self.gaps_path.read_bytes()
        return json.dumps(
            {"type": "FeatureCollection", "features": [], "error": "未找到检测结果文件"}
        ).encode("utf-8")


def blank_png() -> bytes:
    img = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _find_gdaladdo() -> str | None:
    """在 PATH 与常见 GDAL 安装目录里找 gdaladdo（有它才能零额外空间生成外置 .ovr）。"""
    import shutil as _sh

    exe = _sh.which("gdaladdo")
    if exe:
        return exe
    candidates = [
        Path(r"C:/Program Files/GDAL/gdaladdo.exe"),
        Path(r"C:/OSGeo4W64/bin/gdaladdo.exe"),
        Path(r"C:/OSGeo4W/bin/gdaladdo.exe"),
        ROOT / ".venv" / "Scripts" / "gdaladdo.exe",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return None


def ensure_overviews(
    source: Path, cache_dir: Path, mode: str = "auto"
) -> tuple[Path, str]:
    """确保影像有金字塔，且**默认不修改用户的原始文件**。

    为什么需要这一步：本影像没有 overviews，低缩放级瓦片窗口会覆盖大半个影像，
    GDAL 只能按全分辨率读 → 实测 z=13 约 104 秒、z=15 约 35 秒一张瓦片。
    建完金字塔后 z=13 降到 700 ms（149×）。

    ⚠️ 但**建金字塔不能污染用户的原始数据**。本 BigTIFF 在可写模式下
    GDAL 会把概览**写进文件内部**（实测 3.48 GB → 4.66 GB，且无法用 rio 回退）。
    因此这里按策略选路径：

    | mode | 行为 | 是否改源文件 | 额外磁盘 |
    |---|---|---|---|
    | `auto`（默认） | 有金字塔→原图；有 gdaladdo→`-ro` 外置 `.ovr`；否则→**复制副本**建内部金字塔 | **否** | 0 或约等于原图 |
    | `copy` | 总是复制副本 | 否 | 约等于原图 |
    | `gdal` | 必须用 `gdaladdo -ro` 生成外置 `.ovr`，没有则报错 | 否 | 约 1/3 原图 |
    | `inplace` | 就地写入（**旧行为，会改源文件**） | **是** | +1.19 GB |

    返回 `(实际用于服务的影像路径, 说明文字)`。
    """
    import shutil as _sh

    with rasterio.open(source) as ds:
        if ds.overviews(1):
            return source, "源影像已有金字塔"

    levels = ["2", "4", "8", "16", "32", "64"]

    # ---- 策略 1：有 gdaladdo 就用只读模式生成外置 .ovr（零额外空间，不碰原图）----
    if mode in ("auto", "gdal"):
        exe = _find_gdaladdo()
        if exe:
            print(f"  用 {exe} -ro 生成外置 .ovr（源文件不动）…", file=sys.stderr)
            sys.stderr.flush()
            t0 = time.time()
            cmd = [
                exe, "-ro",
                "--config", "COMPRESS_OVERVIEW", "DEFLATE",
                "--config", "GDAL_TIFF_OVR_BLOCKSIZE", "256",
                str(source), *levels,
            ]
            r = __import__("subprocess").run(cmd, capture_output=True, text=True)
            if r.returncode == 0:
                ovr = Path(str(source) + ".ovr")
                return source, f"已生成外置 .ovr（{time.time() - t0:.0f}s，源文件未改动，{ovr.name}）"
            print(f"  ⚠️ gdaladdo 失败：{r.stderr.strip()[:200]}", file=sys.stderr)
        elif mode == "gdal":
            raise RuntimeError("找不到 gdaladdo，无法生成外置 .ovr（请安装 GDAL 或用 --ovr-mode copy）")

    # ---- 策略 2：就地写入（旧行为，会改源文件，需显式指定）----
    if mode == "inplace":
        print("  ⚠️ --ovr-mode inplace：将就地写入源文件（不可逆，请确认有原图副本）", file=sys.stderr)
        with rasterio.open(source, "r+") as ds:
            t0 = time.time()
            ds.build_overviews([int(v) for v in levels], Resampling.average)
        return source, f"已就地写入源文件（{time.time() - t0:.0f}s，⚠️ 源文件已被修改）"

    # ---- 策略 3：复制副本再建内部金字塔（最安全的兜底）----
    cache_dir.mkdir(parents=True, exist_ok=True)
    copy_path = cache_dir / source.name
    if copy_path.exists():
        with rasterio.open(copy_path) as ds:
            if ds.overviews(1):
                return copy_path, "复用已有副本（源文件未改动）"

    need = source.stat().st_size * 2  # 副本 + 金字塔，留余量
    free = _sh.disk_usage(cache_dir).free
    if free < need:
        raise RuntimeError(
            f"磁盘空间不足：需要约 {need / 1024**3:.1f} GB，可用 {free / 1024**3:.1f} GB。"
            f"可改用 --ovr-mode gdal（需安装 GDAL）或自行腾出空间。"
        )

    print(f"  复制副本 → {copy_path}（源文件不动，请稍候）…", file=sys.stderr)
    sys.stderr.flush()
    t0 = time.time()
    _sh.copy2(source, copy_path)
    with rasterio.open(copy_path, "r+") as ds:
        ds.build_overviews([int(v) for v in levels], Resampling.average)
    return copy_path, (
        f"已复制副本并建金字塔（{time.time() - t0:.0f}s，源文件未改动；"
        f"副本 {copy_path}，可随时删除）"
    )


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------
def export_bundle(payload: dict, outdir: Path) -> dict:
    """把前端编辑后的要素写成 geojson / csv / kml。

    ⚠️ Shapefile 导出不在这里做 —— 它由既有的 `scripts/export_arcgis.py` 负责
    （需要 `blocks` 结构与 CRS 元数据）。这里只做「编辑结果」的轻量落盘。
    """
    outdir.mkdir(parents=True, exist_ok=True)
    feats = (payload or {}).get("gaps", {}).get("features", []) or []
    files: list[str] = []

    gj = outdir / "gaps-edited.geojson"
    gj.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": feats},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    files.append(str(gj))

    # CSV 统计表（业务方直接可用）
    csv_path = outdir / "gaps-edited.csv"
    lines = ["gap_id,class,class_label,area_sqm,lon,lat,edited,source"]
    for f in feats:
        p = f.get("properties", {}) or {}
        c = p.get("centroid_utm") or [None, None]
        lines.append(
            ",".join(
                [
                    str(p.get("gap_id", "")),
                    str(p.get("class", "")),
                    str(p.get("class_label", "")),
                    f"{float(p.get('area_sqm') or 0):.1f}",
                    "" if c[0] is None else f"{float(c[0]):.7f}",
                    "" if c[1] is None else f"{float(c[1]):.7f}",
                    "1" if p.get("edited") else "0",
                    str(p.get("source", "algo")),
                ]
            )
        )
    csv_path.write_text("\n".join(lines), encoding="utf-8-sig")
    files.append(str(csv_path))

    # KML（Google Earth 可直接打开）
    kml_path = outdir / "gaps-edited.kml"
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
        "<name>Forest Gap Detection · 编辑结果</name>",
    ]
    for f in feats:
        p = f.get("properties", {}) or {}
        g = f.get("geometry", {}) or {}
        polys = g.get("coordinates", [])
        if g.get("type") == "Polygon":
            polys = [polys]
        for poly in polys:
            if not poly:
                continue
            ring = poly[0]
            coords = " ".join(f"{pt[0]:.7f},{pt[1]:.7f},0" for pt in ring)
            parts.append(
                f'<Placemark><name>{p.get("gap_id", "")} '
                f'{p.get("class_label", "")}</name>'
                f'<description>面积 {p.get("area_sqm", "")} m²</description>'
                f"<Polygon><outerBoundaryIs><LinearRing><coordinates>{coords}"
                f"</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"
            )
    parts.append("</Document></kml>")
    kml_path.write_text("".join(parts), encoding="utf-8")
    files.append(str(kml_path))

    return {"ok": True, "outdir": str(outdir), "files": files}


# --------------------------------------------------------------------------
# HTTP 处理
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "FGD-TileServer/0.1"
    tile_server: TileServer

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        # 人类日志走 stderr（与 sidecar 的约定一致：stdout 不污染）
        sys.stderr.write("  %s\n" % (fmt % args))

    # ---- CORS ----
    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code: int = 200) -> None:
        self._send(
            code,
            json.dumps(obj, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
        )

    # ---- 路由 ----
    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path in ("/meta", "/"):
            self._json(self.tile_server.meta())
            return
        if path == "/gaps":
            self._send(200, self.tile_server.gaps_json(), "application/geo+json")
            return
        if path.startswith("/tiles/"):
            parts = path.strip("/").split("/")
            if len(parts) != 4:
                self._json({"ok": False, "error": "瓦片路径应为 /tiles/{z}/{x}/{y}.png"}, 400)
                return
            try:
                z, x, y = int(parts[1]), int(parts[2]), int(parts[3].split(".")[0])
            except ValueError:
                self._json({"ok": False, "error": "z/x/y 必须是整数"}, 400)
                return
            if not (0 <= z <= 22) or x < 0 or y < 0 or x >= 2 ** z or y >= 2 ** z:
                self._json({"ok": False, "error": "瓦片索引越界"}, 400)
                return
            self._send(200, self.tile_server.tile(z, x, y), "image/png")
            return
        self._json({"ok": False, "error": f"未知路径 {path}"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception as e:
            self._json({"ok": False, "error": f"JSON 解析失败：{e}"}, 400)
            return

        if path == "/export":
            outdir = Path(payload.get("outdir") or (ROOT / "output" / "desktop-export"))
            if not outdir.is_absolute():
                outdir = ROOT / outdir
            try:
                self._json(export_bundle(payload, outdir))
            except Exception as e:
                self._json({"ok": False, "error": f"导出失败：{e}"}, 500)
            return

        if path == "/detect":
            self._json(
                {
                    "ok": False,
                    "error": "detect 不由本服务提供",
                    "hint": (
                        "检测走 stdio NDJSON sidecar（scripts/sidecar.py），"
                        "由 Tauri 宿主 spawn 子进程调用；浏览器原型无法启动子进程。"
                        "命令行等价命令见 scripts/tile_server.py 顶部注释。"
                    ),
                },
                501,
            )
            return

        self._json({"ok": False, "error": f"未知路径 {path}"}, 404)


def main() -> int:
    ap = argparse.ArgumentParser(description="桌面端原型：本地瓦片 / 辅助服务")
    ap.add_argument("--source", default="", help="正射影像路径（默认自动探测）")
    ap.add_argument("--gaps", default="", help="检测结果 GeoJSON（默认自动探测 output/）")
    ap.add_argument("--host", default="127.0.0.1", help="仅监听本机（默认 127.0.0.1）")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--cache", type=int, default=512, help="瓦片内存缓存条数")
    ap.add_argument(
        "--build-overviews",
        action="store_true",
        help="启动前确保影像有金字塔（默认**不修改源文件**，策略见 --ovr-mode）",
    )
    ap.add_argument(
        "--ovr-mode",
        choices=["auto", "copy", "gdal", "inplace"],
        default="auto",
        help="金字塔策略：auto=有 gdaladdo 则生成外置 .ovr，否则复制副本（都不碰源文件）；"
        "copy=总是复制副本；gdal=强制外置 .ovr（需 gdaladdo）；"
        "inplace=就地写入源文件（不可逆，需显式指定）",
    )
    args = ap.parse_args()

    source = Path(args.source) if args.source else next(
        (p for p in SOURCE_CANDIDATES if p.exists()), None
    )
    if source is None or not Path(source).exists():
        print("❌ 找不到正射影像，请用 --source 指定：", file=sys.stderr)
        for p in SOURCE_CANDIDATES:
            print(f"   尝试过 {p}", file=sys.stderr)
        return 2

    source = Path(source)
    if args.build_overviews:
        try:
            source, ovr_note = ensure_overviews(
                source, ROOT / "output" / ".tile-cache", args.ovr_mode
            )
        except RuntimeError as e:
            print(f"❌ {e}", file=sys.stderr)
            return 3
        print(f"  金字塔：{ovr_note}", file=sys.stderr)
        if source != Path(args.source or source):
            print(f"  实际服务影像：{source}", file=sys.stderr)
    else:
        with rasterio.open(source) as _ds:
            if not _ds.overviews(1):
                print("  ⚠️ 影像无金字塔：低缩放级瓦片会非常慢"
                      "（z=13 约 104 s、z=15 约 35 s）。", file=sys.stderr)
                print("     加 --build-overviews 即可（默认不会修改源文件）", file=sys.stderr)

    gaps = Path(args.gaps) if args.gaps else next(
        (p for p in GAPS_CANDIDATES if p.exists()), None
    )

    ts = TileServer(Path(source), gaps, cache_size=args.cache)
    m = ts.meta()
    print("=" * 66, file=sys.stderr)
    print("Forest Gap Detection · 本地瓦片服务", file=sys.stderr)
    print(f"  影像      : {m['source']}", file=sys.stderr)
    print(
        f"  尺寸/CRS  : {m['width']}×{m['height']} px · {m['crs']} · {m['res_m']:.3f} m/px",
        file=sys.stderr,
    )
    print(f"  金字塔    : {'有' if m['has_overviews'] else '无（已启用窗口降采样读，内存安全）'}",
          file=sys.stderr)
    if not m["has_overviews"]:
        print("              ⚠️ 无金字塔时低缩放级瓦片很慢（z=15 约 35 s、z=13 约 104 s）。", file=sys.stderr)
        print("                 建议先跑一次：--build-overviews（一次性，约 1 GB 边车文件）", file=sys.stderr)
    print(f"  检测结果  : {gaps if gaps else '（未找到，/gaps 将返回空集合）'}", file=sys.stderr)
    print(f"  监听      : http://{args.host}:{args.port}", file=sys.stderr)
    print(f"  端点      : /meta  /tiles/{{z}}/{{x}}/{{y}}.png  /gaps  /export", file=sys.stderr)
    print("=" * 66, file=sys.stderr)
    sys.stderr.flush()

    Handler.tile_server = ts
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止", file=sys.stderr)
    return 0


if __name__ == "__main__":
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    raise SystemExit(main())
