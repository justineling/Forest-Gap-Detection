# -*- coding: utf-8 -*-
"""桌面端原型的本地瓦片 / 辅助服务（**零新依赖**：标准库 + rasterio）。

按 `docs/01-需求与架构/桌面端交互需求与实现映射.md` §0.2 的裁定：
- 算法主链路仍走 stdio NDJSON sidecar（`scripts/sidecar.py`），**不走 HTTP**；
- 只有「浏览器必须用 HTTP 取的东西」才开这个端点：影像瓦片、元数据、
  读取最近一次检测结果、导出。

提供：
    GET  /meta                     影像元数据（外接框 / CRS / 分辨率 / 建议缩放级）
    GET  /tiles/{z}/{x}/{y}.png    XYZ 瓦片（Web Mercator）
    GET  /gaps                     最近一次检测结果 GeoJSON（含算法网格锚点）
    GET  /planting-points?clearance=0.5   补种点位（Python/UTM 权威结算）
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
from urllib.parse import parse_qs, urlparse

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

# 建金字塔要多少额外磁盘（相对原图体积的倍数）。
#
# 实测：3.48 GB 的影像就地写入 overviews 后变成 4.66 GB —— **涨 34%**。
# 三条路径按同一个实测比例估算：
#   ovr     = 0.34x（外置文件，压缩比与内部金字塔同一量级）
#   inplace = 0.34x（直接写进原图，就是上面那次实测）
#   copy    = 1.34x（副本 1x + 写进副本的 overviews 0.34x），取 1.5x 留余量
#
# 为什么必须估准而不是"写的时候再说"：
#   - inplace 不可逆，空间不足时写到一半失败会毁掉用户原图；
#   - copy 空间不足会让用户白等几分钟才发现失败。
# 预检（overview_plan）与实际执行（ensure_overviews）**必须用同一个常量** ——
# 两边算法不一致会出现"预检说够、点下去立刻被拦"的错位。
OVR_SPACE_FACTOR = 1.5

# 原始数据可能在不同机器的不同目录（公司机 D:/WGR、家里机仓库内 drone data/）
SOURCE_CANDIDATES = [
    ROOT / "drone data" / "WGR17-002.tif",
    ROOT / "drone data" / "WGR17.tif",
    Path(r"D:/WGR/WGR17.tif"),
    Path(r"D:/WGR/WGR17-002.tif"),
]


# --------------------------------------------------------------------------
# 检测结果发现
# --------------------------------------------------------------------------
# ⚠️ 为什么不能写死文件名（`wgr17-final-gaps.geojson` 这类）：
#   产物名由前端传的 `job` 决定（当前是 `wgr17-desktop-gaps.geojson`），
#   换一个 job 名、换一台机器、或者打包态（ROOT 指向 py-runtime/desktop_entry，
#   那里根本没有 output/）就永远对不上 —— 实测症状是"检测成功了 1,762 个要素
#   在磁盘上，界面却报没有空地"。所以改成按名字特征 + mtime 发现。
def gaps_search_dirs(source: Path | None) -> list[Path]:
    """找结果文件的候选目录，**按优先级**去重（同目录只算一次）。

    ① 影像同目录（用户把一套数据放一起时命中）
    ② 影像目录下的 `output/`（本项目约定）
    ③ 仓库根 `output/`（开发态）
    ④ 进程工作目录下的 `output/`（打包态 cwd 是数据根，这里才有产物）
    """
    cands: list[Path] = []
    if source is not None:
        src = Path(source)
        cands.append(src.parent)
        cands.append(src.parent / "output")
    cands.append(ROOT / "output")
    cands.append(Path.cwd() / "output")

    out: list[Path] = []
    seen: set[str] = set()
    for d in cands:
        try:
            key = str(d.resolve())
        except OSError:
            key = str(d)
        if key in seen:
            continue
        seen.add(key)
        out.append(d)
    return out


def discover_gaps(source: Path | None) -> Path | None:
    """在候选目录里找**最新的** `*gaps*.geojson`（按 mtime）。

    为什么用"名字含 gaps"而不是后缀通配：`output/` 里同时躺着
    `forest-mask-*.geojson`（森林掩膜）、`ab-w1.geojson`（A/B 试验）等
    一堆 geojson，拿错一个会把掩膜当成空地展示 —— 比报错糟糕得多。
    """
    best: tuple[int, Path] | None = None
    for d in gaps_search_dirs(source):
        try:
            if not d.is_dir():
                continue
            entries = list(d.iterdir())
        except OSError:
            continue
        for p in entries:
            name = p.name.lower()
            if "gaps" not in name or not name.endswith(".geojson"):
                continue
            try:
                if not p.is_file():
                    continue
                mtime_ns = p.stat().st_mtime_ns
            except OSError:
                continue
            if best is None or mtime_ns > best[0]:
                best = (mtime_ns, p)
    return best[1] if best else None


def _file_sig(p: Path) -> tuple[str, int, int] | None:
    """缓存签名 `(绝对路径, mtime_ns, size)`；文件不在时返回 None。"""
    try:
        st = p.stat()
    except OSError:
        return None
    return (str(p), st.st_mtime_ns, st.st_size)


def _stale_warnings(obj: dict) -> list[str]:
    """检查「这份结果是不是用旧的高度图 / 分割图算的」。

    ## 为什么需要

    换园区时的正常流程是：生成高度图（40 秒）→ 重跑检测（6 分钟）→ 导出。
    但用户很容易漏掉第二步 —— 生成完直接去导出了。

    这时报告里的株数是**按旧 CHM 算的**，而界面上：
    · 数字自洽（块数、面积、株数都对应同一份旧结果）
    · 报告完整（没有缺字段、没有空值）
    · 没有任何报错

    只有到现场才发现坑挖错了地方。这类"看起来正常"的错是最贵的。

    ## 判据

    结果里存了 `inputs_snapshot`（每个输入文件的 mtime + size）。
    如果磁盘上当前文件的 mtime **比结果里记的新**，说明换过了。

    只报不拦 —— 用户可能是故意的（比如只想看旧结果）。
    """
    snap = obj.get("inputs_snapshot")
    if not isinstance(snap, dict):
        # 老结果没有这份快照。**不能**当成"过期"（会产生假警报），
        # 但也说不了"没问题" —— 所以静默跳过。
        return []

    names = {
        "chm": "高度图（chm.tif）",
        "segment": "语义分割（segment.tif）",
        "forest_mask": "林地边界（forest-mask）",
        "image": "正射影像",
    }
    out: list[str] = []
    for key, label in names.items():
        rec = snap.get(key)
        if not isinstance(rec, dict):
            continue
        p = Path(str(rec.get("path") or ""))
        if not p.exists():
            continue
        old_mtime = int(rec.get("mtime") or 0)
        try:
            now_mtime = int(p.stat().st_mtime)
        except OSError:
            continue
        # 留 2 秒容差：文件系统时间戳粒度 + 复制时的 mtime 抖动
        if now_mtime - old_mtime > 2:
            out.append(
                f"{label} 在本次检测之后更新过 —— 当前结果是按旧版本算的，"
                f"建议重新运行检测"
            )
    return out


def _mtime_ns(p: Path) -> int:
    """文件 mtime（纳秒）；读不到当 0（= 最旧），不抛错。"""
    try:
        return p.stat().st_mtime_ns
    except OSError:
        return 0


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
        # 用户/宿主显式指定的结果文件（`--gaps`）。**不是**最终生效值：
        # 每次 `/gaps` 请求都会再确认一次"它还是不是最新的"，见 _pick_gaps。
        self.gaps_explicit = gaps
        self.gaps_path = gaps
        # 用户"指定这一刻"的时间戳（服务启动 ≈ 用户刚选了文件，因为
        # `set_data_paths` 会重启服务）。
        #
        # ⚠️ 为什么需要它：以前只比"文件 mtime 谁大"。但**用户选文件的时间**
        #    和**文件自身的时间**是两回事 —— 用户主动去回看一个旧批次时，
        #    目录里更新的试验文件会把他选的那份静默顶掉。
        #
        #    危害不只是"块数变了"：`/export` 的 `planting_grid` 取自这里
        #    （要素来自前端 POST，网格来自本文件），所以串批次时**块数完全正确、
        #    但放样点位的网格是另一批的** —— 实测 3,691 → 3,713 点，首点坐标也漂。
        #    交付物看着正常、坑挖错地方，且用户看不出来。这是交付级错误。
        #
        #    规则：只有**比"指定时刻"更新**的文件才允许接管。
        #    · 检测完写的新结果（mtime 更新）→ 接管 ✅（自动刷新不能被弄坏）
        #    · 仓库里历史试验残留（mtime 更旧）→ 不再抢 ✅
        self.gaps_explicit_at_ns: int | None = int(time.time() * 1e9) if gaps is not None else None
        self.cache: OrderedDict[tuple[int, int, int], bytes] = OrderedDict()
        self.cache_size = cache_size
        self.lock = threading.Lock()
        self._ds = None
        self._meta: dict | None = None
        self._gaps_cache: bytes | None = None
        # 缓存签名 (path, mtime_ns, size)：文件被重写但路径没变时也要失效
        self._gaps_sig: tuple[str, int, int] | None = None
        self._gaps_obj: dict | None = None
        self._gaps_obj_sig: tuple[str, int, int] | None = None
        self._pp_cache: dict[float, bytes] = {}
        # 结果文件是**每次请求**都要校验的（懒发现），而 /gaps 与
        # /planting-points 可能并发进来 —— 用一把独立的锁，不占瓦片缓存的锁
        self._gaps_lock = threading.RLock()

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
                # ⚠️ 身份标识：桌面端外壳用它判断"8765 上应答的是不是自己人"。
                #    端口被别的软件占住时，`port_open()` 只能看到"有人在听"，
                #    盲信会直接跳过启动 → 前端永远拿不到 /meta（2026-10-20 事故）。
                #    改这里必须同步 `desktop/src-tauri/src/lib.rs` 的 TILE_APP_ID。
                "app": "fgd-tile-server",
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
    def _pick_gaps(self) -> Path | None:
        """确认"此刻该用哪个结果文件"，必要时重新发现一次。

        为什么要**每次请求**都确认（而不是启动时发现一次就固定）：
        检测跑完**不会重启瓦片服务**（Rust 只在启动 / 换影像时拉服务）。
        如果只在启动时发现一次，用户跑完 6 分钟的检测回来，看到的还是上一轮
        结果，或者永远"未找到" —— 只能重启整个应用，这显然不可接受。

        选择规则：显式指定的 `--gaps`（存在时）与自动发现的最新文件，取 mtime 更新的那个。
        """
        with self._gaps_lock:
            best: Path | None = None
            explicit = self.gaps_explicit
            if explicit is not None and explicit.exists():
                best = explicit
            found = discover_gaps(self.source)
            # 谁有资格接管显式指定？
            #   · 当前还没有任何候选（best is None）→ 用找到的
            #   · 用户指定过 → 只接受"比指定时刻更新"的文件（= 指定之后新产生的）
            #   · 用户没指定（自动发现模式）→ 按 mtime 取最新
            if found is not None:
                if best is None:
                    take = True
                elif self.gaps_explicit_at_ns is not None:
                    take = _mtime_ns(found) > self.gaps_explicit_at_ns
                else:
                    take = _mtime_ns(found) > _mtime_ns(best)
                if take:
                    best = found
            if best != self.gaps_path:
                self.gaps_path = best
                # 换了文件 → 三份缓存全部作废。否则会拿旧文件的字节配新路径，
                # 放样点位也会按上一轮的空地算（数字对不上，且极难发现）
                self._gaps_cache = None
                self._gaps_sig = None
                self._gaps_obj = None
                self._gaps_obj_sig = None
                self._pp_cache.clear()
                where = str(best) if best else "（未找到 *gaps*.geojson）"
                print(f"  检测结果：{where}", file=sys.stderr)
                sys.stderr.flush()
            return best

    def current_gaps(self) -> Path | None:
        """当前生效的结果文件路径（顺带做一次懒发现）。

        给 `/export` 这类"只想拿路径、不想读 14 MB 内容"的端点用 —— 它们也必须
        看到最新的文件，否则导出的报告会按上一轮的空地算株数。
        """
        return self._pick_gaps()

    def gaps_json(self) -> bytes:
        """返回检测结果 GeoJSON，并**动态补上网格锚点**（不改磁盘文件）。

        为什么需要补：`planting_grid` 里的 `origin_x_m / origin_y_m` 是 UTM 49N
        绝对坐标下的数学锚点（离园区约 451 km），前端在经纬度空间没法直接用它
        铺格点。这里补一个「园区中心附近最近格点」的经纬度 `anchor_lon/anchor_lat`
        —— 前端用 anchor + 同样的 pitch/row/skew/azimuth 就能重建**逐格一致**
        的格点集合，从而与 Python 侧点位数逐株对账（否则两边差 +8.8%，
        原因就是前端自己拿「首个顶点均值」当原点，相位是任意的）。

        只在内存里 enrich，不写回文件 —— 重跑算法不必为此付费。
        缓存按 `(路径, mtime_ns, size)` 失效：同一路径被重写也要重读。
        """
        path = self._pick_gaps()
        with self._gaps_lock:
            if path is None:
                looked = "、".join(str(d) for d in gaps_search_dirs(self.source))
                return json.dumps(
                    {
                        "type": "FeatureCollection",
                        "features": [],
                        # 前端会把这句原样显示给用户，所以要说清"找过哪里"——
                        # 只写"未找到"的话，用户根本不知道该把文件放哪
                        "error": f"未找到检测结果文件（已查找：{looked}）",
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
            sig = _file_sig(path)
            if self._gaps_cache is not None and sig is not None and self._gaps_sig == sig:
                return self._gaps_cache
            if self._gaps_sig != sig:
                # 同一路径被重写：解析结果与放样点位都得重算
                self._gaps_obj = None
                self._gaps_obj_sig = None
                self._pp_cache.clear()
            raw = path.read_bytes()
            try:
                obj = json.loads(raw)
                grid = obj.get("planting_grid")
                if isinstance(grid, dict) and "anchor_lon" not in grid:
                    obj["planting_grid"] = _enrich_grid_anchor(obj, grid)
                # 「结果是否已过期」：拿结果里记的 inputs_snapshot 对比磁盘现状。
                # 前端据此在状态栏挂一条警示 —— 详见 _stale_warnings 的注释。
                stale = _stale_warnings(obj)
                if stale:
                    obj["stale_warnings"] = stale
                raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            except Exception as e:  # 结果格式异常时不要拖垮端点，原样返回
                print(f"  ⚠️ planting_grid 锚点补算失败（原样返回）：{e}", file=sys.stderr)
            self._gaps_cache = raw
            self._gaps_sig = sig
            return raw

    # ---- 补种点位（权威结算在 Python，前端只展示/导出）----
    def _gaps_data(self) -> dict:
        """解析后的结果对象（含补算好的 planting_grid）。"""
        self.gaps_json()  # 触发懒发现 + 缓存校验 + 锚点补算
        with self._gaps_lock:
            if self._gaps_obj is None or self._gaps_obj_sig != self._gaps_sig:
                self._gaps_obj = json.loads(self._gaps_cache or b"{}")
                self._gaps_obj_sig = self._gaps_sig
            return self._gaps_obj

    def planting_points_json(self, clearance_m: float = 0.5) -> bytes:
        """按退让距离生成补种点位（GeoJSON FeatureCollection）。

        为什么放在服务端：前端 TS 用局部等距圆柱近似，与 Python 的 UTM 结算
        在 0.5 m 档已实测**完全一致**（3,691 vs 3,691），但 1.0/2.0 m 档仍差
        0.6~0.9%（GEOS buffer 与逐点距离的数值精度）。**对外报数与放样一律以
        本端点为准**，前端自算只用于拖动时的即时反馈。

        结果按退让距离缓存（同一档位重复请求不再重算）。
        """
        key = round(float(clearance_m), 3)
        # ⚠️ 先取数据再查缓存：`_gaps_data()` 会顺带做"结果文件是否已更新"的
        #    校验，文件变了会把 _pp_cache 清空。反过来先查缓存的话，检测刚跑完
        #    时会返回上一轮的点位（数字对不上，且没有任何报错）。
        obj = self._gaps_data()
        if key in self._pp_cache:
            return self._pp_cache[key]

        import planting_points as PP
        from grid_prior import GridModel

        grid = obj.get("planting_grid")
        if not isinstance(grid, dict):
            payload = {"type": "FeatureCollection", "features": [],
                       "error": "结果里没有 planting_grid，无法生成点位"}
            return json.dumps(payload, ensure_ascii=False).encode("utf-8")

        feats = [f for blk in (obj.get("blocks") or []) for f in (blk.get("gaps") or [])]
        if not feats:
            feats = obj.get("features") or []

        gm = GridModel(
            plant_pitch_m=grid["plant_pitch_m"],
            row_pitch_m=grid["row_pitch_m"],
            skew_offset_m=grid.get("skew_offset_m") or grid["plant_pitch_m"] / 2.0,
            origin_x_m=grid["origin_x_m"],
            origin_y_m=grid["origin_y_m"],
            row_azimuth_deg=grid.get("row_azimuth_deg") or grid.get("azimuth_deg") or 0.0,
            quality=grid.get("quality", 0.0),
            method=grid.get("method", ""),
            density_per_ha=grid.get("density_per_ha", 0.0),
        )
        res = PP.generate_planting_points(feats, gm, clearance_m=key)
        out = {
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [p["lon"], p["lat"]]},
                    "properties": {
                        "point_id": p["point_id"],
                        "gap_id": p["gap_id"],
                        "class": p["class"],
                        "source": p["source"],
                        "utm_x": p["utm_x"],
                        "utm_y": p["utm_y"],
                        "clearance_m": p["clearance_m"],
                    },
                }
                for p in res["points"]
            ],
            "meta": {
                "total": res["total"],
                "by_class": res["by_class"],
                "by_source": res["by_source"],
                "clearance_m": key,
                "crs": "EPSG:4326",
                "authority": "python/planting_points.py（UTM 49N 结算）",
            },
        }
        raw = json.dumps(out, ensure_ascii=False).encode("utf-8")
        self._pp_cache[key] = raw
        return raw


def _enrich_grid_anchor(obj: dict, grid: dict) -> dict:
    """为 `planting_grid` 补一个 WGS84 锚点（**实现只有一份**，在 planting_points）。

    锚点 = **结果范围中心最近的那个格点**。前端拿 anchor 当局部原点，
    配合同样的 pitch / row / skew / azimuth 铺格点，就能重建与 Python 侧
    **逐格一致**的格点集合 —— 这是前端报数与 Python 3,912 株对得上的前提。
    """
    import planting_points as PP

    feats = [f for blk in (obj.get("blocks") or []) for f in (blk.get("gaps") or [])]
    if not feats:
        feats = obj.get("features") or []
    lon, lat = PP.features_center_wgs84(feats)
    return PP.grid_anchor_wgs84(grid, lon, lat)



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


def _has_overviews(source: Path) -> bool:
    """影像是否真的带金字塔（读不出来也算"没有"）。

    为什么单独抽一个函数：`gdaladdo` 返回 0、`ds.overviews(1)` 为空、文件被锁住
    三种情况在调用方都要做同一件事（删掉可疑产物 + 报错重试），
    判定散在多处很容易只改了其中一条。

    ⚠️ 打不开时返回 False 而不是抛异常：这条路径的调用方是"刚跑完 gdaladdo 的收尾校验"，
       此刻宁可让用户重试一次，也不要留着一个可能是半截的 .ovr 让下次误判为"已建好"。
    """
    try:
        with rasterio.open(source) as ds:
            return bool(ds.overviews(1))
    except Exception:
        return False


def _free_bytes(path: Path) -> int:
    """`path` 所在卷的可用字节数；目录不存在时向上找最近的存在祖先。

    为什么不能直接 `shutil.disk_usage(path)`：copy 模式的目标是
    `output/.tile-cache`，**首次运行时它还不存在** → 抛 FileNotFoundError →
    只能填 0 → 界面把"要复制 4.7 GB 副本"误判成"磁盘不够"而拦住用户。
    同一分区上可用空间本来就是同一个数，查父目录完全等价。

    真的查不到（连盘符根都读不了）才返回 0 —— 这时调用方会判成空间不足，
    属于保守方向：宁可让用户自己看一眼磁盘，也不要让他等 3 分钟后写满盘。
    """
    import shutil as _sh

    p = path
    for _ in range(8):  # 最多上溯 8 层，防止根目录 parent == self 时死循环
        try:
            return _sh.disk_usage(p).free
        except OSError:
            parent = p.parent
            if parent == p:
                return 0
            p = parent
    return 0


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
                # ⚠️ gdaladdo 返回 0 不等于 .ovr 可用：磁盘写满、进程被强杀都可能
                #    留下一个零字节或半截的 .ovr，而它会让后续每次打开影像都读到
                #    "有 overviews" 的假象（或者干脆读不出来）。这里用 rasterio 复核一次。
                #    校验不过就删掉 —— 留着比没有更糟：下次 auto 模式会以为已经建好了。
                if not _has_overviews(source):
                    try:
                        ovr.unlink()
                    except OSError:
                        pass
                    raise RuntimeError("外置 .ovr 生成后校验失败，已删除，请重试")
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
    #
    # ⚠️ 必须**原子写入**：以前是 copy2 到最终路径再就地建金字塔，
    #    中途强退（用户等不及点关闭 / 断电）会留下一个"存在但没有金字塔"的副本，
    #    而上面的 `if copy_path.exists()` 会认它存在 → 下次直接复用这个坏文件，
    #    用户每次开图都慢 100 倍却看不出原因。
    #    现在先写 `.part`，建完金字塔再 os.replace 转正 —— 最终路径要么不存在，
    #    要么是完整的。os.replace 在同一分区上是原子的。
    cache_dir.mkdir(parents=True, exist_ok=True)
    copy_path = cache_dir / source.name
    part_path = copy_path.with_suffix(copy_path.suffix + ".part")
    if copy_path.exists():
        with rasterio.open(copy_path) as ds:
            if ds.overviews(1):
                # 复用分支也要清 `.part`：否则"副本已建好 + 某次中断留下半截 .part"
                # 这个组合会把一份完整副本大小的垃圾永久留在用户盘上（真机可能 4.7 GB）。
                # 只有走到这里才可能同时存在两者 —— 见 test_overviews.py 用例 C。
                try:
                    part_path.unlink(missing_ok=True)
                except OSError:
                    pass
                return copy_path, "复用已有副本（源文件未改动）"

    # 门槛与预检共用 OVR_SPACE_FACTOR：副本(1x) + 写进副本的 overviews(0.34x)，取 1.5x 留余量
    need = int(source.stat().st_size * OVR_SPACE_FACTOR)
    free = _sh.disk_usage(cache_dir).free
    if free < need:
        raise RuntimeError(
            f"磁盘空间不足：需要约 {need / 1024**3:.1f} GB，可用 {free / 1024**3:.1f} GB。"
            f"可改用 --ovr-mode gdal（需安装 GDAL）或自行腾出空间。"
        )

    # 上一次被打断留下的半截副本：先清掉，否则 copy2 会覆盖但残留大小可能不对
    if part_path.exists():
        try:
            part_path.unlink()
        except OSError:
            pass

    print(f"  复制副本 → {copy_path}（源文件不动，请稍候）…", file=sys.stderr)
    sys.stderr.flush()
    t0 = time.time()
    try:
        _sh.copy2(source, part_path)
        with rasterio.open(part_path, "r+") as ds:
            ds.build_overviews([int(v) for v in levels], Resampling.average)
        os.replace(part_path, copy_path)  # 原子转正
    except BaseException:
        # 包括 KeyboardInterrupt / 进程被 kill 之外的异常：不留垃圾文件。
        # 用 BaseException 而不是 Exception，是为了让 Ctrl+C 也走清理。
        try:
            part_path.unlink()
        except OSError:
            pass
        raise
    return copy_path, (
        f"已复制副本并建金字塔（{time.time() - t0:.0f}s，源文件未改动；"
        f"副本 {copy_path}，可随时删除）"
    )


# --------------------------------------------------------------------------
# 导入期的金字塔体检（桌面端"选了影像之后"调用）
# --------------------------------------------------------------------------
def overview_plan(source: Path, mode: str = "auto") -> dict:
    """只做判断、**不写任何文件**：这张影像要不要建金字塔、会走哪条路。

    为什么单独抽出来：桌面端需要先告诉用户"要花多少磁盘、会不会动你的原图"，
    再让他点确认。如果直接执行，用户是**在不知情的情况下**等了 3 分钟、
    磁盘少了 4.7 GB，而且原图可能已经被改。
    """
    source = Path(source)
    with rasterio.open(source) as ds:
        levels = [int(v) for v in ds.overviews(1)]
        width, height = ds.width, ds.height
    size = source.stat().st_size
    gdaladdo = _find_gdaladdo()

    if levels:
        action, why = "none", "已有金字塔，无需处理"
    elif mode == "inplace":
        action, why = "inplace", "就地写入源文件（不可逆，+约 25%）"
    elif mode == "gdal":
        if gdaladdo:
            action, why = "ovr", "生成外置 .ovr（源文件不动，约占原图 1/3）"
        else:
            action, why = "error", "找不到 gdaladdo，无法生成外置 .ovr"
    elif mode == "copy":
        action, why = "copy", "复制副本后建内部金字塔（源文件不动，约占原图 100%）"
    else:  # auto
        if gdaladdo:
            action, why = "ovr", "生成外置 .ovr（源文件不动，约占原图 1/3）"
        else:
            action, why = "copy", "无 gdaladdo，复制副本（源文件不动，约占原图 100%）"

    # 额外磁盘估算（比例见 OVR_SPACE_FACTOR 的注释，同一个实测来源）。
    # copy 直接用那个常量 —— 与 ensure_overviews 的门槛保持同一个数。
    factor = {
        "none": 0.0,
        "ovr": 0.34,
        "copy": OVR_SPACE_FACTOR,
        "inplace": 0.34,
        "error": 0.0,
    }[action]

    # ---- 磁盘预检 ----
    # 为什么要预检而不是"写到一半再说"：copy 模式要占一倍原图空间（4.7 GB 影像 ≈ 4.7 GB），
    # 磁盘不够时 gdaladdo / rasterio 会写到一半报 IO 错，留下一个**没有金字塔的半截副本**；
    # 更糟的是用户等了 3 分钟才看到失败。所以判断阶段就把"够不够"算出来给界面看。
    # 目标目录按 action 选：ovr / inplace 写在源文件旁边，copy 写在 output/.tile-cache。
    # `_free_bytes` 会处理"缓存目录还不存在"（首次运行必然如此）——
    # 直接 disk_usage 会抛 FileNotFoundError，只能填 0，界面就会把
    # "要复制 4.7 GB 副本"误判成"磁盘不够"而拦住用户。
    target_dir = ROOT / "output" / ".tile-cache" if action == "copy" else source.parent
    free = _free_bytes(target_dir)
    # 比例本身已含余量（copy 的 1.5x 对 1.34x 的实际峰值留了 12%），不再额外乘系数
    need = int(size * factor)

    return {
        "source": str(source),
        "has_overviews": bool(levels),
        "levels": levels,
        "width": width,
        "height": height,
        "size_bytes": size,
        "extra_bytes": int(size * factor),
        "gdaladdo": gdaladdo,
        "mode": mode,
        "action": action,
        "why": why,
        "touches_source": action == "inplace",
        "target_dir": str(target_dir),
        "free_bytes": free,
        "need_bytes": need,
        # action=none 时不需要额外空间 —— 此时 need 是 0，但 free 可能查不到（0），
        # 若直接比较会得出"空间不够"的错误结论，所以显式放行
        "enough_space": free >= need or action == "none",
    }


def build_overviews_only(source: Path, mode: str, dry_run: bool = False) -> int:
    """一次性建金字塔后退出（不启动服务）。stdout 每行一个 JSON 事件。

    stdout 是**数据通道**（与 sidecar 同一约定）：只输出 JSON，
    人类可读的话一律走 stderr —— 否则宿主解析时会多出无法识别的行。
    """
    def emit(obj: dict) -> None:
        print(json.dumps(obj, ensure_ascii=False), flush=True)

    # 耗时从"进函数"开始算，而不是从"开始建"算 —— 用户感知的等待包含读元数据与查磁盘
    t0 = time.time()
    plan = overview_plan(source, mode)
    emit({"event": "plan", "elapsed_s": 0.0, **plan})

    if dry_run or plan["action"] == "none":
        emit({
            "event": "done", "ok": True, "note": plan["why"], "served": str(source),
            "elapsed_s": round(time.time() - t0, 1),
        })
        return 0
    if plan["action"] == "error":
        emit({
            "event": "done", "ok": False, "error": plan["why"],
            "elapsed_s": round(time.time() - t0, 1),
        })
        return 3

    try:
        served, note = ensure_overviews(Path(source), ROOT / "output" / ".tile-cache", mode)
    except RuntimeError as e:
        emit({
            "event": "done", "ok": False, "error": str(e),
            "elapsed_s": round(time.time() - t0, 1),
        })
        return 3
    emit({
        "event": "done", "ok": True, "note": note, "served": str(served),
        "elapsed_s": round(time.time() - t0, 1),
    })
    return 0


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------
# 不可种植类别（与前端 lib/classes.ts 的 unplantable 组一致）
_UNPLANTABLE = {"road", "water", "office", "undeveloped"}
_TIER_META = {
    "definite_plant": ("确定需补种", "连片空地 + 株位空缺，可直接用于苗木量"),
    "review": ("待复核", "证据不足，人工确认后才计入"),
    "not_needed": ("无需补种", "林间空隙＝正常行间缝隙"),
    "unplantable": ("不可种植", "道路 / 水体 / 办公生活区 / 未开发林，已按像素扣除"),
}
_TIER_ORDER = ["definite_plant", "review", "not_needed", "unplantable"]

# CHM 高度阈值的三档林龄预设（与 desktop/src/lib/chm.ts 保持一致）
_CHM_PRESETS = [(5.2, 1.2, "成熟林"), (3.5, 0.8, "中龄林"), (2.2, 0.5, "幼龄林")]


def _chm_label(core: float, veto: float) -> str:
    for c, v, name in _CHM_PRESETS:
        if abs(c - core) < 0.05 and abs(v - veto) < 0.05:
            return name
    return "自定义"


def _tier_of(cls: str) -> str:
    if cls in _UNPLANTABLE:
        return "unplantable"
    if cls in ("open_patch", "vacant_slot", "manual_add"):
        return "definite_plant"
    if cls == "uncertain":
        return "review"
    return "not_needed"


def export_bundle(payload: dict, outdir: Path, base_obj: dict | None = None) -> dict:
    """把**用户人工复核后的要素**导出成完整交付包。

    权威几何/属性全部复用 `scripts/export_arcgis.py`（ArcGIS 导入指南承诺的
    WGS84 + UTM49N 双坐标系 GeoJSON / Shapefile、8 分类 KML、按类别分包），
    补种点位复用 `planting_points.py`。这里只负责三件事：

      ① 把编辑后的要素组装成 export_arcgis 认识的对象；
      ② 决定输出目录；
      ③ 生成一页汇总报告。

    ⚠️ **网格参数必须来自磁盘上的算法结果**（`base_obj["planting_grid"]`），
       不能只用前端传来的 —— 前端只有 `anchor_lon/lat`，缺 `origin_x_m/origin_y_m`，
       拿它构造 GridModel 会让所有放样点整体平移。
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import export_arcgis as EA
    from report_summary import build_report_html

    outdir.mkdir(parents=True, exist_ok=True)
    feats = (payload or {}).get("gaps", {}).get("features", []) or []
    if not feats:
        return {"ok": False, "error": "没有可导出的要素（gaps.features 为空）", "outdir": str(outdir)}

    base = base_obj or {}
    # 网格：磁盘上的算法结果优先（含 UTM 原点），前端只作兜底
    grid = base.get("planting_grid") or (payload or {}).get("planting_grid") or {}
    clearance = float((payload or {}).get("clearance_m") or 0.5)

    # 组装：顶层 features 给 export_arcgis，blocks 给 planting_points
    obj = {
        "type": "FeatureCollection",
        "features": feats,
        "planting_grid": grid,
        "blocks": [{"gaps": feats}],
    }
    features = EA.build_features(obj)
    tr = EA.Transformer.from_crs(EA.WGS84, EA.UTM49N, always_xy=True)

    files: list[str] = []
    notes: list[str] = []

    def add(p: Path) -> None:
        if p.exists():
            files.append(str(p))

    # ---- 1) 双坐标系 GeoJSON ----
    EA.write_geojson_wgs84(features, obj, outdir / "gaps-all-wgs84.geojson")
    add(outdir / "gaps-all-wgs84.geojson")
    EA.write_geojson_utm(features, tr, outdir / "gaps-all-utm49n.geojson")
    add(outdir / "gaps-all-utm49n.geojson")

    # ---- 2) Shapefile（ArcGIS 用）----
    try:
        EA.write_shp_zip(features, outdir / "gaps-all-wgs84-shp.zip",
                         projected=False, prj=EA.PRJ_WGS84)
        add(outdir / "gaps-all-wgs84-shp.zip")
        EA.write_shp_zip(features, outdir / "gaps-all-utm49n-shp.zip",
                         projected=True, tr=tr, prj=EA.PRJ_UTM49N)
        add(outdir / "gaps-all-utm49n-shp.zip")
    except Exception as e:  # noqa: BLE001
        notes.append(f"Shapefile 生成失败（其余交付物不受影响）：{e}")

    # ---- 3) KML（Google Earth / 奥维）----
    try:
        EA.write_kml(features, outdir / "gaps-all.kml")
        add(outdir / "gaps-all.kml")
    except Exception as e:  # noqa: BLE001
        notes.append(f"KML 生成失败：{e}")

    # ---- 4) 按类别分包 ----
    try:
        by_class_dir = outdir / "by-class"
        by_class_dir.mkdir(exist_ok=True)
        buckets: dict[str, list] = {}
        for props, rings in features:
            buckets.setdefault(props["cls"], []).append((props, rings))
        for cls, sub in buckets.items():
            z = by_class_dir / f"gaps-{cls}-utm49n-shp.zip"
            EA.write_shp_zip(sub, z, projected=True, tr=tr, prj=EA.PRJ_UTM49N)
            add(z)
    except Exception as e:  # noqa: BLE001
        notes.append(f"按类别分包失败：{e}")

    # ---- 5) 补种点位（权威结算）----
    points_res = None
    if grid.get("plant_pitch_m"):
        try:
            points_res = EA.export_planting_points(obj, outdir, clearance_m=clearance)
            for name in (
                "planting-points-wgs84.geojson",
                "planting-points-utm49n.geojson",
                "planting-points-wgs84-shp.zip",
                "planting-points-utm49n-shp.zip",
                "planting-points.kml",
                "planting-points.csv",
            ):
                add(outdir / name)
        except Exception as e:  # noqa: BLE001
            notes.append(f"补种点位生成失败（其余交付物不受影响）：{e}")
    else:
        notes.append("结果里缺少 planting_grid，已跳过放样点位（只有几何交付物）")

    # ---- 6) 表格（业务方直接看）----
    csv_path = outdir / "gaps-edited.csv"
    lines = ["gap_id,class,class_label,area_sqm,lon,lat,edited,source"]
    for f in feats:
        pr = f.get("properties", {}) or {}
        g = f.get("geometry", {}) or {}
        lon = lat = ""
        ring = None
        if g.get("type") == "Polygon" and g.get("coordinates"):
            ring = g["coordinates"][0]
        elif g.get("type") == "MultiPolygon" and g.get("coordinates"):
            ring = g["coordinates"][0][0]
        if ring:
            lon = f"{sum(pt[0] for pt in ring[:-1]) / max(1, len(ring) - 1):.7f}"
            lat = f"{sum(pt[1] for pt in ring[:-1]) / max(1, len(ring) - 1):.7f}"
        lines.append(",".join([
            str(pr.get("gap_id", "")),
            str(pr.get("class", "")),
            str(pr.get("class_label", "")),
            f"{float(pr.get('area_sqm') or 0):.1f}",
            lon, lat,
            "1" if pr.get("edited") else "0",
            str(pr.get("source", "algo")),
        ]))
    csv_path.write_text("\n".join(lines), encoding="utf-8-sig")
    add(csv_path)

    # ---- 7) 一页汇总报告 ----
    report_path = outdir / "补种勘察一页报告.html"
    try:
        tier_acc: dict[str, dict] = {
            k: {"key": k, "label": _TIER_META[k][0], "hint": _TIER_META[k][1],
                "count": 0, "area_sqm": 0.0}
            for k in _TIER_ORDER
        }
        for f in feats:
            pr = f.get("properties", {}) or {}
            t = tier_acc[_tier_of(str(pr.get("class", "")))]
            t["count"] += 1
            t["area_sqm"] += float(pr.get("area_sqm") or 0)

        # 每块空地的放样点数（有权威点位就按 gap_id 数，否则按面积折算）
        per_gap_plants: dict[str, int] = {}
        if points_res and points_res.get("points"):
            for p in points_res["points"]:
                per_gap_plants[p["gap_id"]] = per_gap_plants.get(p["gap_id"], 0) + 1

        top = sorted(
            (f for f in feats if _tier_of(str(f.get("properties", {}).get("class", ""))) == "definite_plant"),
            key=lambda f: float(f.get("properties", {}).get("area_sqm") or 0),
            reverse=True,
        )[:20]

        top_rows = []
        for f in top:
            pr = f.get("properties", {}) or {}
            gid = str(pr.get("gap_id", ""))
            ring = None
            g = f.get("geometry", {}) or {}
            if g.get("type") == "Polygon" and g.get("coordinates"):
                ring = g["coordinates"][0]
            elif g.get("type") == "MultiPolygon" and g.get("coordinates"):
                ring = g["coordinates"][0][0]
            lon = lat = 0.0
            if ring:
                lon = sum(pt[0] for pt in ring[:-1]) / max(1, len(ring) - 1)
                lat = sum(pt[1] for pt in ring[:-1]) / max(1, len(ring) - 1)
            plants = per_gap_plants.get(gid)
            if plants is None:
                plants = int(float(pr.get("area_sqm") or 0) / 66.67)
            top_rows.append({
                "gap_id": gid,
                "cls_label": str(pr.get("class_label") or EA.CLASS_LABEL_CN.get(
                    str(pr.get("class", "")), "")),
                "area_sqm": float(pr.get("area_sqm") or 0),
                "plants": plants,
                "lon": lon, "lat": lat,
            })

        audit = (payload or {}).get("audit") or {}
        added = int(audit.get("added") or sum(1 for f in feats
                                              if (f.get("properties") or {}).get("source") == "manual"))
        edited = int(audit.get("edited") or sum(
            1 for f in feats
            if (f.get("properties") or {}).get("edited") and
            (f.get("properties") or {}).get("source") != "manual"))
        deleted = int(audit.get("deleted") or 0)

        # 影像元信息：前端传来的优先；兜底从磁盘结果读（注意 params 里没有宽高，
        # 宽高只有 processing 段才有 —— 所以这里用 crs/source_image 兜住关键字段）
        img = (payload or {}).get("image") or {}
        if not img:
            proc = base.get("processing") or {}
            img = {
                "name": Path(str(base.get("source_image") or "")).name,
                "width": proc.get("width"), "height": proc.get("height"),
                "res_m": proc.get("res_m"), "crs": base.get("crs"),
            }

        # CHM 阈值：**以磁盘上的结果为准**（用户可能在检测后改过滑块）
        base_params = base.get("params") or {}
        chm_core = float(base_params.get("elevation_core_chm") or 5.2)
        chm_veto = float(base_params.get("elevation_veto_chm") or 1.2)

        pts = (points_res or {}).get("points") or []
        by_src = (points_res or {}).get("by_source") or {}
        report_html = build_report_html({
            "project": (payload or {}).get("project") or "Forest Gap Detection · 补种勘察",
            "generated_at": time.strftime("%Y-%m-%d %H:%M"),
            "image": img,
            "roi": (payload or {}).get("roi") or {"has_roi": False},
            "grid": {
                "plant_pitch_m": grid.get("plant_pitch_m"),
                "row_pitch_m": grid.get("row_pitch_m"),
                "azimuth_deg": grid.get("row_azimuth_deg"),
                "density_per_ha": grid.get("density_per_ha"),
            },
            "clearance_m": clearance,
            "tiers": [tier_acc[k] for k in _TIER_ORDER],
            "estimate": {
                "by_grid": (points_res or {}).get("total") or 0,
                "by_area": int(sum(float(t["area_sqm"]) for t in
                                   (tier_acc["definite_plant"],)) / 66.67),
                "divergence_pct": _divergence(
                    (points_res or {}).get("total") or 0,
                    sum(float(t["area_sqm"]) for t in (tier_acc["definite_plant"],)),
                ),
                "points_total": len(pts),
                "points_grid": by_src.get("grid", 0),
                "points_slot": by_src.get("slot", 0),
            },
            "chm": {
                "core": chm_core,
                "veto": chm_veto,
                "label": _chm_label(chm_core, chm_veto),
                "is_default": abs(chm_core - 5.2) < 0.05 and abs(chm_veto - 1.2) < 0.05,
            },
            "audit": {"added": added, "edited": edited, "deleted": deleted},
            "top": top_rows,
        })
        report_path.write_text(report_html, encoding="utf-8")
        add(report_path)
    except Exception as e:  # noqa: BLE001
        notes.append(f"报告生成失败：{e}")

    return {
        "ok": True,
        "outdir": str(outdir),
        "files": files,
        "notes": notes,
        "counts": {
            "features": len(features),
            "planting_points": len((points_res or {}).get("points") or []),
        },
        "report": str(report_path) if report_path.exists() else None,
    }


def _divergence(points_total: int, definite_area_sqm: float) -> float:
    """排坑法 vs 面积法的差异百分比（面积法按 66.67 m²/株）。"""
    by_area = definite_area_sqm / 66.67 if definite_area_sqm else 0.0
    if by_area <= 0:
        return 0.0
    return abs(points_total - by_area) / by_area * 100.0


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
        if path == "/planting-points":
            qs = parse_qs(urlparse(self.path).query)
            try:
                clr = float((qs.get("clearance") or ["0.5"])[0])
            except ValueError:
                self._json({"ok": False, "error": "clearance 必须是数字"}, 400)
                return
            if not (0.0 <= clr <= 10.0):
                self._json({"ok": False, "error": "clearance 应在 0~10 m"}, 400)
                return
            try:
                body = self.tile_server.planting_points_json(clr)
            except Exception as e:  # noqa: BLE001
                self._json({"ok": False, "error": f"点位生成失败：{e}"}, 500)
                return
            self._send(200, body, "application/geo+json")
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
            base_obj = None
            # 用 current_gaps() 而不是 gaps_path：导出必须按**最新**的结果算，
            # 否则用户刚重跑完就导出，报告里的株数还是上一轮的
            gp = self.tile_server.current_gaps()
            if gp and Path(gp).exists():
                try:
                    base_obj = json.loads(Path(gp).read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    base_obj = None
            try:
                self._json(export_bundle(payload, outdir, base_obj))
            except Exception as e:
                import traceback
                traceback.print_exc(file=sys.stderr)
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
    ap.add_argument(
        "--overviews-only",
        action="store_true",
        help="只建金字塔后退出，不启动服务（桌面端导入影像时用；stdout 输出 JSON 事件）",
    )
    ap.add_argument(
        "--dry-run",
        action="store_true",
        help="配合 --overviews-only：只报告会怎么做，不实际写任何文件",
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
    if args.overviews_only:
        return build_overviews_only(source, args.ovr_mode, args.dry_run)

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

    # 结果文件：`--gaps` 显式给了就用它（但仍然会被"更新出现的文件"顶掉，
    # 见 TileServer._pick_gaps）；否则启动时先发现一次，之后每次 /gaps 再校验。
    gaps = Path(args.gaps) if args.gaps else discover_gaps(source)

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
    print("              每次 /gaps 都会重新确认是否出现了更新的结果文件"
          "（检测完不必重启服务）", file=sys.stderr)
    print(f"  监听      : http://{args.host}:{args.port}", file=sys.stderr)
    print(f"  端点      : /meta  /tiles/{{z}}/{{x}}/{{y}}.png  /gaps  "
          f"/planting-points?clearance=0.5  /export", file=sys.stderr)
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
