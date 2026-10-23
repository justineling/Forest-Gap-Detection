"""
整幅影像分块处理器（含断点续跑）  v0.3
================================================================================
把 3.5 GB / 21 亿像素的正射影像切成瓦片逐块处理，全程常量内存，支持中断后
续跑，最后把各瓦片结果去重合并为一份整幅 GeoJSON。

为什么必须分块
--------------------------------------------------------------------------------
WGR17.tif 实测 47,130 × 44,686 像素、4 波段 8 位 = 3.5 GiB。若整幅读进内存：
    47130 × 44686 × 3 ÷ 1024³ ≈ 5.9 GiB（仅 RGB，还没算中间浮点数组）
中间还要算 ExG（float32）、高斯平滑、形态学、连通域标记，峰值内存会到
20 GiB 以上。普通办公机扛不住。

分块后每块只需 2048² × 3 ≈ 12 MiB，峰值常驻内存稳定在 300 MiB 以内。
影像本身是 256×256 分块存储的（Deflate 压缩），按 2048 对齐读取还能顺带
占到连续 I/O 的便宜。

--------------------------------------------------------------------------------
★ 三个必须处理好的工程细节（都是实测踩出来的）
--------------------------------------------------------------------------------

1｜瓦片重叠（overlap）
   不重叠的话，恰好跨越瓦片边界的空地会被切碎成两块，各自面积都不到阈值，
   于是两边都丢掉——最终整幅结果里凭空少一块空地。
   做法：每块向外多读 overlap 像素（默认 128 px ≈ 4.2 m，大于半株距），
   处理完后按"归属区"裁剪，只保留落在本瓦片核心区内的多边形。
   核心区 = 瓦片去掉 overlap 之后的中间部分。

2｜跨瓦片网格对齐（grid alignment）
   株行距网格的**相位必须全局一致**。如果每块各自估计网格、各自定原点，
   相邻瓦片的网格会互相错开半个格，同一块空地在两块里会被判成不同类别。
   做法：先跑一遍"网格勘察"——在若干采样瓦片上估计网格，取中位数得到
   全局网格；然后所有瓦片共用这一个网格。
   （这比"每块各自估计再投票"更稳，因为单块可能树心不足而估计失败。）

3｜断点续跑（resume）
   整幅 229 公顷、约 550 个瓦片，跑一遍要几分钟到几十分钟。中途断电/关窗口
   不该从头再来。
   做法：每个瓦片处理完立即落盘一个 .json（原子写：先写 .tmp 再 rename），
   主流程启动时扫描已完成的瓦片、跳过它们。
   瓦片文件的内容包含"输入影像 mtime + 参数指纹"，只要影像或参数变了，
   旧瓦片自动失效重算——避免"改了参数却拿到旧结果"这种最坑的情况。

--------------------------------------------------------------------------------
用法
--------------------------------------------------------------------------------
    # 完整跑一遍（默认 2048 瓦片、128 重叠、含株行距分类）
    python scripts/process_image.py --input D:/WGR/WGR17.tif

    # 先试跑 8 个瓦片看看效果
    python scripts/process_image.py --input D:/WGR/WGR17.tif --limit 8

    # 只看网格勘察结果，不处理空地
    python scripts/process_image.py --input D:/WGR/WGR17.tif --grid-only

    # 强制重算（忽略已有瓦片缓存）
    python scripts/process_image.py --input D:/WGR/WGR17.tif --force

    # 中断后续跑（直接重跑同一命令即可，会自动跳过已完成的瓦片）
    python scripts/process_image.py --input D:/WGR/WGR17.tif

    # 只合并已有瓦片，不重新处理
    python scripts/process_image.py --input D:/WGR/WGR17.tif --merge-only
================================================================================
"""
from __future__ import annotations

import argparse
import hashlib
import json
import multiprocessing as mp
import os
import shutil
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path

# ---------------------------------------------------------------------------
# 缓存目录与 HF 环境（与 detect.py 保持一致）
# ---------------------------------------------------------------------------
_PROJ = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HOME", str(_PROJ / ".cache" / "huggingface"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("TORCH_HOME", str(_PROJ / ".cache" / "torch"))

import numpy as np
import rasterio
from scipy import ndimage as ndi
from rasterio.features import shapes as rio_shapes
from rasterio.enums import Resampling
from rasterio.windows import Window, transform as win_transform, bounds as win_bounds
from shapely.geometry import shape, mapping, box as shp_box
from shapely import transform as _shp_transform_new
from pyproj import Transformer

# 引入同目录模块
sys.path.insert(0, str(Path(__file__).resolve().parent))
from detect import (  # noqa: E402
    canopy_structural, complement, separate_gap_units, TARGET_CRS, log,
    DEFAULT_EXG_THRESHOLD, DEFAULT_USE_SATURATION, DEFAULT_SAT_LEVEL,
    DEFAULT_EXG_PCT, DEFAULT_EXG_LO, DEFAULT_EXG_HI,
)
from grid_prior import (  # noqa: E402
    estimate_grid, gap_geometry, classify_gaps, GridModel,
    CLASS_VACANT_SLOT, CLASS_ALLEY_GAP, CLASS_OPEN_PATCH, CLASS_UNCERTAIN,
    CLASS_LABEL_CN, METHOD_PRIOR_FALLBACK, summarize_classes,
    check_density_consistency, DEFAULT_TARGET_DENSITY_PER_HA,
    summarize_unplantable, UNPLANTABLE_CLASSES, CLASS_SEMANTICS,
    CLASS_UNDEVELOPED,
    DEFAULT_PRIOR_PITCH_M,
    summarize_priority, PRIORITY_LABEL_CN, PRIORITY_GROUPS,
)
from landcover import (detect_unplantable, detect_grass,  # noqa: E402
                       LandcoverParams)
from elevation import (ElevationEvidence, ElevationParams,  # noqa: E402
                       fuse_canopy)


def shp_transform(func, geom):
    """用 (x, y) 回调变换几何 —— 兼容 shapely 2.2 的新 API。

    shapely 2.2 弃用了 shapely.ops.transform（回调式 x,y,z），改用
    shapely.transform（交错坐标数组式）。二者语义不同，但对我们这种
    "逐点二维投影"的用法完全等价。这里统一包一层，避免在几十处调用点
    上重复适配，也顺带消掉满屏 DeprecationWarning。

    func 仍是传统签名 func(x, y) -> (x', y')，即 pyproj Transformer.transform。
    """
    @wraps(func)
    def _apply(coords):
        # coords: (N, 2) 或 (N, 3) 的 numpy 数组
        x, y = func(coords[:, 0], coords[:, 1])
        return np.column_stack([x, y])

    return _shp_transform_new(geom, _apply, include_z=False)

SCHEMA_VERSION = "0.3"
DEFAULT_JOB_NAME = "wgr17-full"


# ============================================================================
# 参数指纹：影像或参数一变，旧瓦片缓存自动失效
# ============================================================================
def fingerprint(input_path: str, params: dict) -> str:
    """算出「影像 + 参数」的指纹，用于判断已有瓦片缓存是否还能用。

    ⚠️ 这个机制不能省。踩过的坑：改了 --pct 之后重跑，因为瓦片缓存还在，
       结果输出还是旧参数算出来的，还以为是新参数无效。
       指纹包含影像的（路径、大小、mtime）与全部影响结果的参数。
    """
    p = Path(input_path)
    st = p.stat() if p.exists() else None
    payload = {
        "image": {
            "name": p.name,
            "size": st.st_size if st else 0,
            "mtime": int(st.st_mtime) if st else 0,
        },
        "params": {k: v for k, v in sorted(params.items())},
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def _inputs_snapshot(args) -> dict:
    """记录本次结果依赖的输入文件指纹（mtime + size）。

    用于事后判断「结果是否已经过期」—— 见结果 JSON 里 `inputs_snapshot` 的注释。
    文件不存在时记 null，不抛错（某些判据本来就是可选的）。
    """
    out: dict = {}
    for key, path in (
        ("image", args.input),
        ("chm", getattr(args, "chm", None)),
        ("segment", getattr(args, "segment", None)),
        ("forest_mask", getattr(args, "forest_mask", None)),
    ):
        if not path:
            out[key] = None
            continue
        p = Path(path)
        try:
            st = p.stat()
            out[key] = {"path": str(p), "mtime": int(st.st_mtime),
                        "size": int(st.st_size)}
        except OSError:
            out[key] = None
    return out


# ============================================================================
# 瓦片规划
# ============================================================================
@dataclass
class Tile:
    """一个处理瓦片。

    术语
    ----
    core   ：瓦片的核心区（本瓦片负责输出的范围）
    buffer ：向外扩张 overlap 之后的读取区（用于避免边界切断空地）
    """
    tile_id: str
    row_core: int
    col_core: int
    h_core: int
    w_core: int
    overlap: int

    @property
    def row_buf(self) -> int:
        return max(0, self.row_core - self.overlap)

    @property
    def col_buf(self) -> int:
        return max(0, self.col_core - self.overlap)

    def core_window(self) -> Window:
        return Window(self.col_core, self.row_core, self.w_core, self.h_core)

    def buf_window(self, ds) -> Window:
        """带外扩的读取窗口（自动夹到影像范围内）。"""
        r0 = max(0, self.row_core - self.overlap)
        c0 = max(0, self.col_core - self.overlap)
        r1 = min(ds.height, self.row_core + self.h_core + self.overlap)
        c1 = min(ds.width, self.col_core + self.w_core + self.overlap)
        return Window(c0, r0, c1 - c0, r1 - r0)


def plan_tiles(width: int, height: int, tile_size: int, overlap: int,
               max_tiles: int | None = None) -> list[Tile]:
    """把整幅影像规划成若干瓦片。行优先顺序，便于进度显示与断点续跑。"""
    tiles: list[Tile] = []
    rows = list(range(0, height, tile_size))
    cols = list(range(0, width, tile_size))
    for r in rows:
        for c in cols:
            h = min(tile_size, height - r)
            w = min(tile_size, width - c)
            tid = f"r{r:06d}_c{c:06d}"
            tiles.append(Tile(tid, r, c, h, w, overlap))
    return tiles


def order_tiles_by_validity(ds, tiles: list[Tile], thresh: float = 0.02,
                            cache_path: Path | None = None
                            ) -> tuple[list[Tile], list[Tile]]:
    """把瓦片分成 (有数据的, 空白的) 两组，各自保持原有行优先顺序。

    为什么需要这一步
    ----------------
    园区是不规则多边形（本幅影像仅占外接矩形的 57%），行优先遍历时开头会连续
    撞上大片 NoData。这带来两个问题：
      1. --limit N 试跑时前 N 块全是空区，什么也测不到；
      2. 每块都要真读一次 2048² 才能发现它是空的，浪费 IO。

    解决：先用金字塔（overview）做一次极廉价的整体可读性判断，把明显的空白瓦片
    排到后面。有效性用低分辨率概览判定即可 —— 这是排序启发式，不是精确过滤，
    真正的阈值判断仍在 process_tile 里做（故不会有"误判丢失数据"的风险）。
    """
    if not tiles:
        return [], []

    # 缓存（2026-10-13 新增）：有效性排序只取决于「影像 + 瓦片网格」，与算法参数
    # 无关，可安全复用。命中缓存能省掉一次全图降采样读取 —— 实测这一步要
    # 55~117 秒，是整幅流程里最大的单点固定开销。
    key = None
    if cache_path is not None:
        key = (f"{Path(ds.name).name}|{ds.width}x{ds.height}|{ds.count}"
               f"|{len(tiles)}|{thresh}")
        try:
            obj = json.loads(Path(cache_path).read_text(encoding="utf-8"))
            if obj.get("key") == key:
                ids = set(obj.get("good", []))
                good = [t for t in tiles if t.tile_id in ids]
                blank = [t for t in tiles if t.tile_id not in ids]
                if len(good) + len(blank) == len(tiles):
                    log(f"瓦片有效性排序命中缓存（{len(good)} 有效 / "
                        f"{len(blank)} 空白），跳过全图概览读取")
                    return good, blank
        except (OSError, json.JSONDecodeError, AttributeError, TypeError):
            pass

    H, W = 128, 136          # 概览分辨率（与瓦片网格对齐，约 8×9 格/瓦片）
    try:
        ov = ds.read([1, 2, 3], out_shape=(3, H, W),
                     resampling=Resampling.nearest)
        valid_ov = ~np.all(ov == 0, axis=0)
    except Exception:  # noqa: BLE001
        return list(tiles), []

    scored: list[tuple[float, int, Tile]] = []
    for i, t in enumerate(tiles):
        # 该瓦片 core 区在概览图上的行列范围
        r0 = int(t.row_core / ds.height * H)
        r1 = max(r0 + 1, int((t.row_core + t.h_core) / ds.height * H))
        c0 = int(t.col_core / ds.width * W)
        c1 = max(c0 + 1, int((t.col_core + t.w_core) / ds.width * W))
        frac = float(valid_ov[r0:r1, c0:c1].mean()) if r1 > r0 and c1 > c0 else 0.0
        scored.append((frac, i, t))

    good = [t for frac, _, t in scored if frac >= thresh]
    blank = [t for frac, _, t in scored if frac < thresh]
    # 组内按原始行优先序号排序，保证可复现
    good.sort(key=lambda t: (t.row_core, t.col_core))
    blank.sort(key=lambda t: (t.row_core, t.col_core))

    # 写缓存，供下次启动直接复用（失效条件见上方 key 的构成）
    if cache_path is not None and key is not None:
        try:
            cp = Path(cache_path)
            cp.parent.mkdir(parents=True, exist_ok=True)
            cp.write_text(json.dumps(
                {"key": key, "good": [t.tile_id for t in good],
                 "blank": [t.tile_id for t in blank]},
                ensure_ascii=False), encoding="utf-8")
        except OSError:
            pass
    return good, blank


# ============================================================================
# 网格勘察：用采样瓦片定一个全局网格
# ============================================================================
def survey_grid(ds, tiles: list[Tile], px_m: float, sample_n: int = 7,
                prior_pitch_m: float = DEFAULT_PRIOR_PITCH_M,
                pct: float = DEFAULT_EXG_PCT, sigma: float = 5.0,
                exg_threshold: float | None = DEFAULT_EXG_THRESHOLD,
                use_saturation: bool = DEFAULT_USE_SATURATION,
                exg_lo: float = DEFAULT_EXG_LO,
                exg_hi: float = DEFAULT_EXG_HI,
                n_valid_hint: int | None = None,
                target_density_per_ha: float | None = None,
                verbose: bool = True) -> tuple[GridModel, dict]:
    """在若干均匀分布的采样瓦片上估计网格，取中位数得全局网格。

    ⚠️ 为什么不用"每块各自估计"
       单块可能树心不足（空地多）、或估计失败。而且三角形点阵的三个方向
       在几何上等价，不同块可能各选一个，导致相位不兼容。
       全局网格保证所有瓦片共用一套格点，这是跨瓦片结果一致的前提。

    返回 (全局网格, 勘察报告)
    """
    if not tiles:
        raise ValueError("没有瓦片可勘察")

    # --- 采样候选顺序 ---
    # 坑：园区是不规则多边形，影像外接矩形里有大片 NoData。若只按"均匀取 7 个"
    # 恰好全落在 NoData 上（例如 --limit 8 时前 8 块全在左上角空区），勘察就废了。
    # 所以：先按均匀取样给出首选位置，再在其邻域内交替补位，直到采够 sample_n 个。
    n_tiles = len(tiles)
    n_want = min(sample_n, n_tiles)
    # 只在「已知有数据」的那一段里铺采样点。tiles 已经按有效性排序过，
    # 前 n_valid_hint 个是有效瓦片；不限制的话采样点会均匀落进空白尾部。
    n_span = min(n_tiles, n_valid_hint) if n_valid_hint else n_tiles

    base = [int(round(i * (n_span - 1) / max(1, n_want - 1))) for i in range(n_want)] \
        if n_want > 1 else [0]
    # 邻域补位：在每个首选位置附近 ±1、±2… 瓦片处生成备选（去重，保序）
    cand: list[int] = []
    seen: set[int] = set()

    def push(idx: int) -> None:
        idx = max(0, min(n_tiles - 1, idx))
        if idx not in seen:
            seen.add(idx)
            cand.append(idx)

    for radius in range(0, max(2, n_tiles)):
        for b in base:
            for d in (0,) if radius == 0 else (-radius, radius):
                push(b + d)
        if len(cand) >= min(n_tiles, n_want * 8):
            break
    for i in range(n_tiles):      # 兜底：实在不够就顺序扫
        push(i)

    if verbose:
        log(f"网格勘察：在瓦片上估计株行距（目标 {n_want} 个有效样本）…")

    results: list[tuple[GridModel, float, float]] = []   # (网格, 拟合误差代理, px_m)
    reports: list[dict] = []
    n_tried = 0
    max_tried = min(n_tiles, max(n_want * 12, 40))   # 最多试探这么多块，避免全图扫描

    for i in cand:
        if len(results) >= n_want or n_tried >= max_tried:
            break
        n_tried += 1
        k = n_tried
        t = tiles[i]
        try:
            with rasterio.open(ds.name) as d2:
                win = t.buf_window(d2)
                data = d2.read(window=win, out_dtype="uint8")
        except Exception as e:  # noqa: BLE001
            if verbose:
                log(f"  [{k}] {t.tile_id} 读取失败：{type(e).__name__}")
            continue

        rgb = np.transpose(data[:3], (1, 2, 0))
        valid = ~np.all(data[:3] == 0, axis=0)
        if valid.mean() < 0.25:
            if verbose:
                log(f"  [{k}] {t.tile_id} 有效数据仅 {valid.mean()*100:.0f}%，跳过")
            continue

        canopy = canopy_structural(rgb, sigma=sigma, pct=pct, quiet=True,
                                   exg_threshold=exg_threshold,
                                   use_saturation=use_saturation,
                                   exg_lo=exg_lo, exg_hi=exg_hi) & valid
        if canopy.mean() < 0.15:
            if verbose:
                log(f"  [{k}] {t.tile_id} 冠层仅 {canopy.mean()*100:.0f}%，跳过")
            continue

        aff = win_transform(win, ds.transform)
        g = estimate_grid(canopy, aff, px_m, rgb=rgb, valid=valid,
                          prior_pitch_m=prior_pitch_m)

        # 该采样块的局部拟合误差（诊断字典里有）
        err = float(getattr(g, "diagnostics", {}).get("basis", {})
                    .get("fit_error_m", float("nan")))

        if verbose:
            log(f"  [{k}] {t.tile_id}  冠层 {canopy.mean()*100:4.0f}%  "
                f"株距 {g.plant_pitch_m:6.2f} m  行距 {g.row_pitch_m:6.2f} m  "
                f"错行角 {g.skew_angle_deg:5.1f}°  方位 {g.row_azimuth_deg:5.1f}°  "
                f"质量 {g.quality:.3f}")

        if g.quality >= 0.15:
            results.append((g, err, px_m))
        reports.append({
            "tile_id": t.tile_id,
            "plant_pitch_m": round(g.plant_pitch_m, 3),
            "row_pitch_m": round(g.row_pitch_m, 3),
            "skew_angle_deg": round(g.skew_angle_deg, 2),
            "row_azimuth_deg": round(g.row_azimuth_deg, 2),
            "quality": round(g.quality, 3),
            "density_per_ha": round(g.density_per_ha, 1),
            "method": g.method,
            "node_count": g.node_count,
            "nn_cv": round(g.nn_cv, 4) if np.isfinite(g.nn_cv) else None,
            "canopy_cover_pct": round(float(canopy.mean() * 100), 2),
        })

    if not results:
        # 全部采样失败 → 回落先验，全局网格不可信
        if verbose:
            log("网格勘察：所有采样瓦片均估计失败，回落实测先验值（全部空地标 uncertain）")
        t0 = tiles[0]
        with rasterio.open(ds.name) as d2:
            win = t0.core_window()
            aff = win_transform(win, d2.transform)
        # 借 estimate_grid 的回落路径构造一个 quality=0 的网格
        dummy = np.zeros((64, 64), dtype=bool)
        g = estimate_grid(dummy, aff, px_m, rgb=None, valid=None,
                          prior_pitch_m=prior_pitch_m, allow_fallback=True)
        return g, {"samples": reports, "used": 0, "fallback": True}

    # --- 取中位数（中位数比均值抗离群：某一块估到 10.45 m 不该拉动全局）---
    def med(vals: list[float]) -> float:
        return float(np.median([v for v in vals if np.isfinite(v)]))

    plants = med([g.plant_pitch_m for g, _, _ in results])
    rows = med([g.row_pitch_m for g, _, _ in results])
    azimuths = [g.row_azimuth_deg for g, _, _ in results]

    # 错行偏移：三角形 → plant/2；正方形 → 0。用采样块的多数决定
    tri_votes = sum(1 for g, _, _ in results if g.is_triangular)
    is_tri = tri_votes * 2 >= len(results)
    skew_off = plants / 2.0 if is_tri else 0.0

    # --- 方位角合成（2026-10-17 修正：60° 角度别名 bug）---------------------
    # 等边三角形种植（8.45 m 株距 / 60° 错行）的格点具有 **60° 旋转对称**，
    # 因此 0.7° / 59° / 61° / 179° 描述的是**同一个格子**，而 90° 是它的对偶轴。
    # 旧代码按"模 180°（2θ）"折叠求圆均值 —— 实测 7 个采样块
    # [3, 61, 1, 61, 90, 179, 179] 被合成成 **21.2°**，而用 tree_info 树心
    # 在 300 m 窗口局部细扫定出的真值是 **59.0°（≡ −1.0°）**，**偏了 20°**，
    # 直接导致 vacant_slot / alley_gap / uncertain 的归属在两次全量之间抖动
    # （实测林间空隙 +19 块 / +9.5%，而要素数与总面积逐位一致）。
    # 修法：三角形按 **6θ（模 60°）** 折叠求圆均值；非三角形只有 180° 对称，仍用 2θ。
    # ⚠️ 禁止"先 angle % 60 再取算术中位数"：真值恰好卡在 0/60 边界时
    #    （−1° → 59°，+1° → 1°）中位数会算出 30° 这种离谱值 —— 必须用圆统计量。
    def _circ_mean(degs: list[float], fold_n: float) -> float:
        th = np.radians(np.asarray(degs, dtype=float) * fold_n)
        c, s = float(np.cos(th).mean()), float(np.sin(th).mean())
        if abs(c) < 1e-12 and abs(s) < 1e-12:
            return 0.0
        return float(np.degrees(np.arctan2(s, c)) / fold_n)

    fold = 6.0 if is_tri else 2.0
    azimuth = _circ_mean(azimuths, fold) % (60.0 if is_tri else 180.0)

    # 剔除对偶轴离群块（90° ≡ 30° mod 60°，偏离主方向 30°）后重新合成。
    # 实测本机 7 个采样块里有 1 块是 90°：剔除后 0.67°、不剔除 0.80°——
    # 两者都远好于旧值 21.2°，剔除更稳。
    az_kept = list(azimuths)
    if is_tri and len(azimuths) >= 4:
        dev = np.abs(((np.asarray(azimuths, dtype=float) - azimuth + 30.0)
                      % 60.0) - 30.0)
        keep = dev <= 15.0
        if int(keep.sum()) >= max(3, int(round(len(azimuths) * 0.5))) \
                and not bool(keep.all()):
            az_kept = [float(v) for v in np.asarray(azimuths, dtype=float)[keep]]
            azimuth = _circ_mean(az_kept, 6.0) % 60.0
            log(f"  方位角合成：按 6θ（模 60°）圆统计；剔除 "
                f"{len(azimuths) - len(az_kept)} 个对偶轴离群块"
                f"（偏离主方向 >15°）→ 用 {len(az_kept)}/{len(azimuths)} 块"
                f"合成 {azimuth:.2f}°")

    # --- 全局原点：把各采样块的绝对原点投到全局网格上，取相位中位数 ---
    # 做法：把每块的 origin 当"一个格点候选"，取其相对全局网格的相位，
    # 再对所有候选求圆均值 —— 这与单块内的相位对齐是同一套逻辑。
    a = np.radians(azimuth)
    ux, uy = np.cos(a), np.sin(a)
    vx, vy = -np.sin(a), np.cos(a)

    ph_xs, ph_ys = [], []
    for g, _, _ in results:
        dx = g.origin_x_m - results[0][0].origin_x_m
        dy = g.origin_y_m - results[0][0].origin_y_m
        gy = (dx * vx + dy * vy) / max(rows, 1e-6)
        gx = (dx * ux + dy * uy - gy * skew_off) / max(plants, 1e-6)
        ph_xs.append(gx - np.round(gx))
        ph_ys.append(gy - np.round(gy))

    def circ(fracs: list[float]) -> float:
        th = 2.0 * np.pi * np.array(fracs)
        c, s = float(np.cos(th).mean()), float(np.sin(th).mean())
        if abs(c) < 1e-12 and abs(s) < 1e-12:
            return 0.0
        v = float(np.arctan2(s, c) / (2.0 * np.pi))
        return float(v - np.round(v))

    ph_x, ph_y = circ(ph_xs), circ(ph_ys)

    ref = results[0][0]
    origin_x = (ref.origin_x_m + ph_x * plants * ux + ph_y * rows * vx)
    origin_y = (ref.origin_y_m + ph_x * plants * uy + ph_y * rows * vy)

    quality = med([g.quality for g, _, _ in results])
    global_grid = GridModel(
        plant_pitch_m=plants,
        row_pitch_m=rows,
        skew_offset_m=skew_off,
        origin_x_m=float(origin_x),
        origin_y_m=float(origin_y),
        row_azimuth_deg=azimuth,
        quality=quality,
        method="global_consensus",
        density_per_ha=float(1e4 / max(plants * rows, 1e-6)),
        node_count=int(med([float(g.node_count) for g, _, _ in results])),
        nn_cv=med([g.nn_cv for g, _, _ in results]),
        regularity=med([g.regularity for g, _, _ in results]),
        angle_conc=med([g.angle_conc for g, _, _ in results]),
        notes=f"由 {len(results)}/{n_want} 个采样瓦片合成"
              + ("（三角形/错行种植，方位角按 6θ 模 60° 圆统计"
                 + (f"，剔除 {len(azimuths) - len(az_kept)} 个对偶轴离群块"
                    if len(az_kept) < len(azimuths) else "")
                 + "）"
                 if is_tri else "（正方形/对齐种植，方位角按 2θ 模 180° 圆统计）"),
    )

    # 与用户给定的设计密度交叉校验（独立于影像的强先验）
    dens_ok, dens_ratio, dens_msg = check_density_consistency(
        global_grid, target_density_per_ha)

    if verbose:
        log(f"全局网格：株距 {plants:.2f} m  行距 {rows:.2f} m  "
            f"错行角 {global_grid.skew_angle_deg:.1f}°  方位 {azimuth:.1f}°  "
            f"密度 {global_grid.density_per_ha:.0f} 株/ha  质量 {quality:.3f}")
        log(f"  （探测 {n_tried} 块，成功采样 {len(results)}/{n_want}"
            f"{'，已回落先验' if quality < 0.15 else ''}）")
        log(f"  密度校验：{dens_msg}")

    return global_grid, {
        "density_check": {
            "target_density_per_ha": target_density_per_ha,
            "estimated_density_per_ha": round(global_grid.density_per_ha, 1),
            "ratio": round(dens_ratio, 4),
            "ok": bool(dens_ok),
            "message": dens_msg,
        },
        "samples": reports,
        "used": len(results),
        "requested": n_want,
        "probed": n_tried,
        "consensus": global_grid.to_dict(),
        "fallback": False,
    }


# ============================================================================
# 单瓦片处理
# ============================================================================
def process_tile(ds, tile: Tile, px_m: float, grid: GridModel,
                 args, out_dir: Path, elevation=None,
                 elev_params=None, roi_geom=None) -> dict:
    """处理一个瓦片，返回该瓦片的结果字典（也写盘）。

    流程与 detect.py 一致，差别在于：
      - 读取时向外扩 overlap，输出时按 core 区裁剪（避免边界切断空地）
      - 分类用全局网格（保证跨瓦片一致）
      - 结果立即落盘（支持断点续跑）
    """
    win_buf = tile.buf_window(ds)
    data = ds.read(window=win_buf, out_dtype="uint8")
    rgb = np.transpose(data[:3], (1, 2, 0))
    valid = ~np.all(data[:3] == 0, axis=0) if data.shape[0] >= 3 else np.ones(
        data.shape[1:], dtype=bool)
    # ROI 圈选裁剪：圈外像素直接置为无效（与 --forest-mask 同构，方向相反）。
    # 用 all_touched=True 栅格化，让压在边界上的瓦片多保留一点像素，
    # 避免 ROI 边界把空地切出锯齿（1.6 m 开运算 + 0.3 m 简化会再平滑一次）。
    if roi_geom is not None:
        valid &= _roi_mask_for(roi_geom, win_buf, ds, valid.shape)

    # 有效数据太少直接跳过（影像外接矩形里有大片 NoData）
    if valid.mean() < args.min_valid_ratio:
        return {
            "tile_id": tile.tile_id,
            "status": "skipped",
            "reason": f"有效数据仅 {valid.mean()*100:.1f}% < {args.min_valid_ratio*100:.0f}%",
            "core": {"row": tile.row_core, "col": tile.col_core,
                     "height": tile.h_core, "width": tile.w_core},
            "gaps": [],
            "stats": {},
        }

    # --- 树冠掩膜 ---
    canopy = canopy_structural(rgb, sigma=args.sigma, pct=args.pct,
                               min_blob_px=args.min_canopy_blob, quiet=True,
                               exg_threshold=args.exg_threshold,
                               use_saturation=args.use_saturation,
                               exg_lo=args.exg_lo, exg_hi=args.exg_hi) & valid

    # --- 海拔证据融合（2026-10-15）-----------------------------------------
    # 为什么需要：草地与油棕在**纯 RGB** 上被实测证明不可分 —— ExG 区间完全重叠
    # （草地 83~95 vs 油棕 1~112，跨航带曝光差 3 倍）、纹理/梯度/动态范围/排列
    # 周期性全部重叠、连 DINOv2 深度特征留一验证也只对 1/5。
    #
    # 引入两类**非 RGB** 证据后，5 个真值点的分离度从「不可分」提升到 +85.3 个百分点：
    #   · CHM 冠层高度 —— 物理量，不受航带曝光影响
    #   · DJI Terra 语义分割 —— 端到端学习，能看整株树冠形状
    # 两者严格互补（实测）：
    #   seg 判 other 但 CHM>=5.2 的占 other 的 19.2%  → CHM 救回 seg 漏检的树
    #   seg 判 tree  但 CHM<1.2  的占 tree  的  2.7%  → CHM 否决 seg 的误判
    #
    # 详见 scripts/elevation.py 与 docs/03-算法教学/DSM高程辅助检测方案.html
    use_elev = (elevation is not None and elevation.available
                and elev_params is not None and elev_params.enabled)
    elev_stats: dict = {}
    seg_w = None                     # ← 供不可种植检测复用（水体第三条证据，见下）
    if use_elev:
        chm_w, seg_w = elevation.read(win_buf, canopy.shape)
        canopy, elev_stats = fuse_canopy(canopy, chm_w, seg_w, elev_params)
        canopy = canopy & valid
        elev_stats["chm_used"] = chm_w is not None
        elev_stats["seg_used"] = seg_w is not None

    # --- 草地回检（2026-10-13）---------------------------------------------
    # ⚠️ 这是**没有高度信息时**的兜底判据（颜色 + 开运算 + 株行距格点回检）。
    #    启用海拔证据后默认跳过 —— 实测那套判据远不如高度可靠：
    #    · 方案 B 的「尺寸闸门」bug 曾把真值点1 的 305 m² 草地 100% 剔除；
    #    · 它无法处理紧邻油棕的草地（被 DSM 平滑"渗高"之处）。
    #    仅当没有 CHM/语义分割时才回退到它。
    if not use_elev and not args.no_grass_recheck:
        # LandcoverParams 统一承载草地判据开关：grid=False 时只跑
        # 颜色 + 开运算（2026-10-14 前的行为），便于 A/B 对比与回退。
        grass_params = LandcoverParams(grass_grid=not args.no_grass_grid)
        grass = detect_grass(rgb, valid, px_m, grass_params)
        canopy = canopy & ~grass

    gap = complement(canopy, valid)

    # --- 空地分离 ---
    if args.no_separate:
        gap_units = gap
    else:
        gap_units = separate_gap_units(gap, args.min_gap_width_m, px_m,
                                       min_blob_px=args.min_gap_blob, quiet=True)

    # --- 矢量化（在投影系下算面积 + 简化）---
    aff_buf = win_transform(win_buf, ds.transform)
    to_utm = Transformer.from_crs(ds.crs, TARGET_CRS, always_xy=True)
    from_utm = Transformer.from_crs(TARGET_CRS, ds.crs, always_xy=True)

    def fwd(x, y, z=None):
        return to_utm.transform(x, y)

    def bwd(x, y, z=None):
        return from_utm.transform(x, y)

    core_box = shp_box(tile.col_core * ds.transform.a + ds.transform.c
                       - abs(ds.transform.a) * 0.5,
                       tile.row_core * ds.transform.e + ds.transform.f
                       - abs(ds.transform.e) * 0.5,
                       (tile.col_core + tile.w_core) * ds.transform.a + ds.transform.c
                       - abs(ds.transform.a) * 0.5,
                       (tile.row_core + tile.h_core) * ds.transform.e + ds.transform.f
                       - abs(ds.transform.e) * 0.5)
    # core_box 用的是影像原坐标系；下面统一在 UTM 下比较，所以转换一次
    core_box_utm = shp_transform(fwd, core_box)

    # --- 不可种植地物：按像素从空地中扣除，并单独成层 ---------------------
    # 设计变更（2026-10-13）：
    #   旧做法是「整块改判」—— 把与掩膜重叠 ≥ unplantable_overlap 的空地多边形
    #   整块换成 road/water/office。实测有两个硬伤：
    #     ① 道路天然与周边裸土连成一片：1048 块空地里**没有一块是"纯道路"**
    #        （road 覆盖率最大仅 58.2%、中位 0%），0.5 门槛下只扣掉实际路网的 2%；
    #     ② 放宽阈值后改判面积会**超过掩膜本身**（thr=0.3 → 43,606 m² >
    #        掩膜 34,725 m²），把大量本该补种的裸土误标成道路。
    #   改为**几何差集**：先把不可种植掩膜按像素从空地栅格中扣除，再矢量化。
    #   补种面积因此是精确的（不依赖任何阈值），掩膜另存为独立图层供 ArcGIS 查看。
    unplantable_polys: list[tuple[str, object, float, str]] = []
    unplantable_stats: dict[str, float] = {}
    if not args.no_landcover:
        # seg_w 传入水体检测作为第三条证据（2026-10-17 修正 92% 漏检）：
        # 油棕园的蓄水塘含藻类时呈灰绿/亮绿，`B≥G>R` 天然不成立，
        # 而 build_chm 又把水面置成 NaN → fuse_canopy 里"无高度处不判树冠"
        # 让水面必然落进空地候选。实测 5,691 m² 真水塘因此被算成需补种。
        lc_params = LandcoverParams(
            water_use_segment=not bool(getattr(args, "no_water_segment", False)))
        masks = detect_unplantable(rgb, valid, px_m, lc_params, seg=seg_w)
        union = masks["road"] | masks["water"] | masks["office"]
        gap_units = gap_units & ~union        # ← 关键：按像素扣除，不整块改判
        for cls in ("water", "road", "office"):
            mk = masks[cls]
            if not mk.any():
                continue
            # ⚠️ 试过「先在栅格层面按 min_area 粗筛连通域再矢量化」，实测是**负优化**：
            #    掩膜连通域绝大多数本来就 > min_area（30 m²），粗筛几乎筛不掉东西，
            #    反而多付了 ndi.label + bincount + 全图布尔索引的开销
            #    （整幅从 1336 s 涨到 2400+ s）。故不采用。
            for geom, val in rio_shapes(mk.astype(np.uint8), mask=mk,
                                        transform=aff_buf):
                if int(val) != 1:
                    continue
                g = shape(geom)
                if g.is_empty:
                    continue
                g_utm = shp_transform(fwd, g)
                if args.simplify_m > 0:
                    g_utm = g_utm.simplify(args.simplify_m, preserve_topology=True)
                a = float(g_utm.area)
                if a < args.min_area:
                    continue
                if not core_box_utm.contains(g_utm.centroid):
                    continue
                gid = f"{tile.tile_id}-U{len(unplantable_polys)+1:04d}"
                unplantable_polys.append((gid, g_utm, a, cls))
                unplantable_stats[cls] = unplantable_stats.get(cls, 0.0) + a

    polys_utm: list[tuple[str, object, float]] = []
    n_dim = int(min(gap_units.sum(), 1e12))
    for gi, (geom, val) in enumerate(rio_shapes(gap_units.astype(np.uint8),
                                                mask=gap_units, transform=aff_buf)):
        if int(val) != 1:
            continue
        g = shape(geom)
        if g.is_empty:
            continue
        g_utm = shp_transform(fwd, g)
        if args.simplify_m > 0:
            g_utm = g_utm.simplify(args.simplify_m, preserve_topology=True)
        area = float(g_utm.area)
        if area < args.min_area:
            continue
        # --- 归属判定：质心落在本瓦片 core 区才算本瓦片的产物 ---
        # 这样跨边界的空地只会被"它质心所在的那块"输出一次，不会重复也不会丢
        if not core_box_utm.contains(g_utm.centroid):
            continue
        polys_utm.append((f"{tile.tile_id}-G{len(polys_utm)+1:04d}", g_utm, area))

    # --- 株行距分类 ---
    geoms = [gap_geometry(p, gid, a) for gid, p, a in polys_utm]
    labels = classify_gaps(geoms, grid,
                           node_tol_ratio=args.node_tol_ratio,
                           elongate_ratio=args.elongate_ratio,
                           min_coverage_for_slot=args.min_coverage_for_slot)
    lab_by_id = {l["gap_id"]: l for l in labels}

    # （原「整块改判」逻辑已废弃 —— 改为上方「按像素几何差集」，理由见那里的说明。）

    features = []
    total_area = 0.0
    for gid, p, area in sorted(polys_utm, key=lambda t: -t[2]):
        lab = lab_by_id.get(gid, {})
        c_utm = p.centroid
        total_area += area
        features.append({
            "type": "Feature",
            "properties": {
                "gap_id": gid,
                "class": lab.get("class", CLASS_UNCERTAIN),
                "class_label": lab.get("class_label", CLASS_LABEL_CN[CLASS_UNCERTAIN]),
                "class_confidence": lab.get("class_confidence", 0.0),
                "class_method": lab.get("class_method", "planting_grid_prior"),
                "class_reason": lab.get("class_reason", ""),
                "class_semantics": lab.get("class_semantics", ""),
                "area_sqm": round(area, 2),
                "centroid_utm": [round(c_utm.x, 2), round(c_utm.y, 2)],
                "grid_cell": lab.get("grid", {}).get("cell"),
                "node_distance_m": lab.get("grid", {}).get("node_distance_m"),
                "coverage_ratio": lab.get("grid", {}).get("coverage_ratio"),
                "elongation": lab.get("shape", {}).get("elongation"),
                "slot_score": lab.get("evidence", {}).get("slot_score"),
                "patch_score": lab.get("evidence", {}).get("patch_score"),
                "alley_score": lab.get("evidence", {}).get("alley_score"),
                "confidence": None,
            },
            "geometry": mapping(shp_transform(bwd, p)),
        })

    # 不可种植地物单独成层（class = road/water/office），供 ArcGIS 分层查看。
    # 它们不在 polys_utm 里（已被按像素扣除），因此不计入需补种面积。
    for gid, p, area, cls in unplantable_polys:
        c_utm = p.centroid
        features.append({
            "type": "Feature",
            "properties": {
                "gap_id": gid,
                "class": cls,
                "class_label": CLASS_LABEL_CN[cls],
                "class_confidence": None,
                "class_method": "landcover_mask",
                "class_reason": (f"该区域命中{CLASS_LABEL_CN[cls]}掩膜 → "
                                 f"不可种植，已从需补种面积中按像素扣除"),
                "class_semantics": CLASS_SEMANTICS[cls],
                "area_sqm": round(area, 2),
                "centroid_utm": [round(c_utm.x, 2), round(c_utm.y, 2)],
                "grid_cell": None,
                "node_distance_m": None,
                "coverage_ratio": None,
                "elongation": None,
                "slot_score": None,
                "patch_score": None,
                "alley_score": None,
                "confidence": None,
            },
            "geometry": mapping(shp_transform(bwd, p)),
        })

    counts = summarize_classes(labels)
    if len(labels) != len(features):
        # features 里额外含「不可种植地物」多边形，与 labels 数量对不上，
        # 直接按最终 feature 统计。
        counts = summarize_classes(features and
                                   [{"class": f["properties"]["class"]}
                                    for f in features])

    unplantable = summarize_unplantable(
        [{"class": f["properties"]["class"],
          "area_sqm": f["properties"]["area_sqm"]} for f in features])

    # ⚠️ polys_utm 已在前面按像素扣除不可种植区域，因此 total_area 本身就是
    #    「需补种面积」，**不能**再减一次 unplantable（否则重复扣减）。
    plantable_area = round(total_area, 2)

    return {
        "tile_id": tile.tile_id,
        "status": "done",
        "core": {"row": tile.row_core, "col": tile.col_core,
                 "height": tile.h_core, "width": tile.w_core},
        "gaps": features,
        "stats": {
            "n_gaps": len(features),
            "area_sqm": round(total_area, 2),
            "plantable_area_sqm": plantable_area,
            "unplantable_area_sqm": unplantable["area_sqm"],
            "canopy_cover_pct": round(float(canopy.mean() * 100), 2),
            "valid_ratio": round(float(valid.mean()), 4),
            "by_class": counts,
            "unplantable": unplantable,
            "elevation": elev_stats,
        },
    }


# ============================================================================
# 原子写盘
# ============================================================================
def atomic_write_json(path: Path, obj: dict) -> None:
    """先写 .tmp 再 rename —— 保证中途断电不会留下半个损坏的 JSON。

    断点续跑依赖"文件完整才有效"这个前提，所以原子写是必需的。
    如果直接 open(path,'w') 然后 dump，进程在 dump 中途被杀就会留下
    截断的 JSON，下次续跑读到它会 JSONDecodeError。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def load_tile_result(path: Path, expect_fp: str) -> dict | None:
    """读取瓦片结果；文件损坏或指纹不匹配则返回 None（视为未完成）。"""
    if not path.exists():
        return None
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if obj.get("fingerprint") != expect_fp:
        return None
    return obj


# ============================================================================
# 多进程跑批（2026-10-17，--workers）
# ============================================================================
#
# 为什么能加速：单瓦片 ~2 秒，绝大部分时间在 numpy / scipy / GDAL 的 C 层，
# 不持有 GIL，天然适合多进程。
#
# ★ 四条护栏（缺一条就会"提速了但数字变了"或"反而更慢"）
#
# 1｜**按 tile_idx 排序后再累加**。并发完成顺序是随机的，而串行版是按
#    tiles 顺序累加 all_features / class_totals / area_total。若不排序，
#    浮点加法顺序变化 → 末位抖动 → 破坏"逐位可复现"红线。
#    做法：worker 返回 (idx, ...)，主进程 results.sort(key=idx) 后再累加。
#
# 2｜**子进程只开一次大文件句柄**。Windows 用 spawn，DatasetReader 不可
#    pickle。若每个瓦片都 rasterio.open 一次正射影像 + CHM + segment，
#    528 个瓦片就是 1,500+ 次 4.6 GB 文件的头部解析，提速全被吃掉。
#    做法：ProcessPoolExecutor(initializer=_worker_init) 在子进程启动时开一次。
#
# 3｜**锁死底层线程数**。numpy/scipy/GDAL 默认各自多线程；6 个 worker ×
#    每个 8~16 线程 = 上百线程抢 CPU 与磁盘锁，实测会比单进程还慢。
#    做法：_worker_init 里设 OMP/MKL/OPENBLAS/NUMEXPR/GDAL_NUM_THREADS=1。
#
# 4｜**子进程绝不写 stdout**。sidecar 的 stdout 是 NDJSON 数据通道。
#    进度事件全部由主进程在 as_completed 循环里按原有节奏输出。
#
# ⚠️ `workers` **不进参数指纹**：进程数不影响单瓦片结果，改它不该让
#    528 个瓦片的缓存全部失效（重跑一次 1,048 秒）。
_WORKER: dict = {}


def resolve_workers(n: int) -> int:
    """把 --workers 归一成实际进程数。0 = 自动（min(6, cpu//2)）。"""
    if n and n > 0:
        return max(1, min(int(n), 32))
    cpu = os.cpu_count() or 4
    return max(1, min(6, cpu // 2))


def _worker_init(in_path: str, chm_path, seg_path, px_m: float, grid,
                 args, out_dir: str, elev_params, roi_geom, fp: str) -> None:
    """子进程启动钩子：锁线程 + 开一次句柄。**不要在这里写 stdout。**"""
    # 护栏 3：进程内单线程，把并行度完全交给外层进程池
    for k in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
              "NUMEXPR_NUM_THREADS", "GDAL_NUM_THREADS"):
        os.environ[k] = "1"

    import rasterio as _rio
    ds = _rio.open(in_path)
    _WORKER.update({
        "ds": ds, "px_m": px_m, "grid": grid, "args": args,
        "out_dir": Path(out_dir), "elev_params": elev_params,
        "roi_geom": roi_geom, "fp": fp, "elevation": None,
    })
    # 护栏 2：海拔证据（CHM / segment）也只开一次
    if elev_params is not None and getattr(elev_params, "enabled", False) and (chm_path or seg_path):
        try:
            ev = ElevationEvidence(chm_path, seg_path, ortho_transform=ds.transform)
            _WORKER["elevation"] = ev if ev.available else None
        except Exception:  # noqa: BLE001
            _WORKER["elevation"] = None


def _worker_run(task: tuple[int, Tile]) -> tuple:
    """处理一个瓦片。返回 (idx, tile_id, status, gaps, stats, error)。

    异常在这里就地吞掉并写成 failed 瓦片文件（与串行版行为一致）——
    让主进程能继续跑完其余瓦片，而不是整个池子崩掉。
    """
    idx, tile = task
    tf = _WORKER["out_dir"] / f"{tile.tile_id}.json"
    try:
        res = process_tile(_WORKER["ds"], tile, _WORKER["px_m"], _WORKER["grid"],
                           _WORKER["args"], _WORKER["out_dir"],
                           elevation=_WORKER["elevation"],
                           elev_params=_WORKER["elev_params"],
                           roi_geom=_WORKER["roi_geom"])
        res["fingerprint"] = _WORKER["fp"]
        res["generated_at"] = datetime.now(timezone.utc).isoformat()
        atomic_write_json(tf, res)
        return (idx, tile.tile_id, res.get("status", "done"),
                res.get("gaps", []), res.get("stats", {}), None)
    except Exception as e:  # noqa: BLE001
        err = f"{type(e).__name__}: {str(e)[:300]}"
        atomic_write_json(tf, {
            "tile_id": tile.tile_id, "status": "failed", "error": err,
            "fingerprint": _WORKER["fp"],
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "core": {"row": tile.row_core, "col": tile.col_core,
                     "height": tile.h_core, "width": tile.w_core},
            "gaps": [], "stats": {},
        })
        return (idx, tile.tile_id, "failed", [], {}, err)


# ============================================================================
# 主流程
# ============================================================================
def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="整幅影像分块处理器（含断点续跑） v0.3",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input", required=True, help="正射影像 tif 路径")
    ap.add_argument("--job", default=DEFAULT_JOB_NAME,
                    help=f"任务名，决定中间态目录名（默认 {DEFAULT_JOB_NAME}）")
    ap.add_argument("--work-dir", default="output/caches",
                    help="中间态根目录（默认 output/caches；每张影像一个子目录）")
    ap.add_argument("--out-json", default=None,
                    help="合并后的整幅 GeoJSON 路径（默认 output/<job>-gaps.geojson）")

    # --- 分块参数 ---
    ap.add_argument("--tile-size", type=int, default=2048, help="瓦片边长（像素），默认 2048")
    ap.add_argument("--overlap", type=int, default=128,
                    help="瓦片外扩（像素），避免边界切断空地。默认 128 px ≈ 4.2 m")
    ap.add_argument("--limit", type=int, default=None, help="只处理前 N 个瓦片（试跑用）")
    ap.add_argument("--force", action="store_true", help="忽略已有瓦片缓存，全部重算")
    ap.add_argument("--merge-only", action="store_true", help="只合并已有瓦片，不处理")
    ap.add_argument("--grid-only", action="store_true", help="只做网格勘察，不处理空地")
    ap.add_argument("--workers", type=int, default=1,
                    help="并行进程数。1=串行（默认，与历史行为完全一致）；"
                         "0=自动 min(6, cpu//2)；建议 4~6。"
                         "⚠️ 进程数不进参数指纹，改它不会让瓦片缓存失效")
    ap.add_argument("--min-valid-ratio", type=float, default=0.05,
                    help="瓦片有效数据低于该比例则跳过。默认 0.05")

    # --- 分割参数（与 detect.py 对齐）---
    ap.add_argument("--method", choices=["structural", "deepforest"], default="structural")
    ap.add_argument("--sigma", type=float, default=5.0)
    ap.add_argument("--pct", type=float, default=DEFAULT_EXG_PCT,
                    help=f"分位基准（默认 {DEFAULT_EXG_PCT:.0f}%%），与 --exg-lo/--exg-hi "
                         "组成混合判据 clip(分位, lo, hi)")
    ap.add_argument("--exg-lo", type=float, default=DEFAULT_EXG_LO,
                    help=f"分位结果的下限（默认 {DEFAULT_EXG_LO:.0f}）。"
                         "曝光偏暗的航带上兜底，防止把整片林地判成空地")
    ap.add_argument("--exg-hi", type=float, default=DEFAULT_EXG_HI,
                    help=f"分位结果的上限（默认 {DEFAULT_EXG_HI:.0f}）。"
                         "曝光偏亮的区域收敛，防止漏掉空地")
    ap.add_argument("--exg-threshold", type=float, default=None,
                    help="改用固定绝对阈值（覆盖混合判据）。"
                         "默认 None = 用混合判据。⚠️ 对跨航带曝光差异极敏感")
    ap.add_argument("--no-saturation", action="store_true",
                    help="关闭饱和度辅助（默认开启）")
    ap.add_argument("--min-canopy-blob", type=int, default=2000,
                    help="树冠掩膜最小连通块（像素）")
    ap.add_argument("--min-gap-blob", type=int, default=200,
                    help="空地分离后最小连通块（像素）")
    ap.add_argument("--min-gap-width-m", type=float, default=1.6)
    ap.add_argument("--no-separate", action="store_true", help="关闭空地分离")

    # --- 矢量化参数 ---
    ap.add_argument("--min-area", type=float, default=30.0, help="最小空地面积 m²")
    ap.add_argument("--simplify-m", type=float, default=0.3, help="多边形简化容差 m")

    # --- 分类参数 ---
    ap.add_argument("--prior-pitch-m", type=float, default=DEFAULT_PRIOR_PITCH_M,
                    help=f"种植间距先验（米），默认 {DEFAULT_PRIOR_PITCH_M}")
    ap.add_argument("--node-tol-ratio", type=float, default=0.35)
    ap.add_argument("--elongate-ratio", type=float, default=2.2)
    ap.add_argument("--min-coverage-for-slot", type=float, default=0.15)
    ap.add_argument("--survey-samples", type=int, default=7,
                    help="网格勘察的采样瓦片数，默认 7")
    ap.add_argument("--target-density", type=float,
                    default=DEFAULT_TARGET_DENSITY_PER_HA,
                    help="园区**设计**密度（株/公顷），用于交叉校验网格估计。\n油棕园常规设计至多 150 株/ha。传 0 表示不校验。默认 "
                         f"{DEFAULT_TARGET_DENSITY_PER_HA:g}")

    # --- 不可种植地物参数（2026-10-13 用户要求）---
    ap.add_argument("--no-landcover", action="store_true",
                    help="关闭道路/水体/办公区检测（退化为旧行为）")
    ap.add_argument("--no-water-segment", action="store_true",
                    help="水体检测不使用 DJI 语义分割证据（退化为纯 RGB 蓝度/暗水规则）。"
                         # ⚠️ argparse 会对 help 做 %-格式化，裸 %% 会崩：
                         #    `ValueError: unsupported format character`。
                         #    所有百分号必须写成 %%。
                         "默认使用：RGB 蓝度规则只能覆盖语义分割水体的 7.9%%"
                         "（含藻类的灰绿色水塘不满足 B≥G>R，实测漏检 5,691 m²）")
    ap.add_argument("--unplantable-overlap", type=float, default=0.5,
                    help="[已失效，仅为向后兼容] 旧的「整块改判」阈值。"
                         "现改为按像素几何差集扣除不可种植区域，不再使用该阈值")
    ap.add_argument("--no-grass-recheck", action="store_true",
                    help="关闭草地回检。默认开启：把「过于鲜绿且连片」的区域从树冠中"
                         "剔除，修正草地被误判成油棕导致的漏检")
    ap.add_argument("--no-grass-grid", action="store_true",
                    help="关闭草地回检的第二道判据（株行距网格周期性回检）。"
                         "默认开启：树心按 8.45 m 规则排列的候选区判为油棕林并剔除，"
                         "只保留无空间周期的真草地（见 docs/03-算法教学/草地与油棕区分方案.html 方案 B）")

    # --- 海拔证据参数（2026-10-15）---
    ap.add_argument("--chm", default="output/chm.tif",
                    help="冠层高度模型（scripts/build_chm.py 产出）。文件不存在则自动退化为纯 RGB 判据。默认 output/chm.tif")
    ap.add_argument("--segment", default="",
                    help="DJI Terra 语义分割栅格（segment.tif）。留空则不使用语义证据")
    ap.add_argument("--no-elevation", action="store_true",
                    help="关闭海拔证据融合，退化为纯 RGB + 草地回检")
    ap.add_argument("--core-chm", type=float, default=5.2,
                    help="高度救援阈值（米）：CHM ≥ 此值无条件判为树冠。本项目实测标定值 5.2，默认 %(default)s")
    ap.add_argument("--veto-chm", type=float, default=1.2,
                    help="高度否决阈值（米）：CHM < 此值无条件非树冠。本项目实测标定值 1.2，默认 %(default)s")
    ap.add_argument("--forest-mask", default="",
                    help="非种植区掩膜（GeoJSON 多边形，EPSG:4326）。落在其中的"
                    "需补种空地会改判为 undeveloped 且不计入需补种。"
                    "可用 scripts/build_forest_mask.py 自动生成后在 ArcGIS 里复核。"
                    "留空则不启用")
    ap.add_argument("--roi", default="",
                    help="只检测该多边形内的区域（.geojson / .kml，EPSG:4326）。"
                    "圈外瓦片**直接跳过不读盘**（提速主来源），圈外不产出任何要素。"
                    "与 --forest-mask 方向相反：ROI 是「只算这里」，掩膜是「这里不算」，"
                    "两者可同时使用。留空则不启用")
    ap.add_argument("--quiet", action="store_true", help="精简日志")
    return ap


def main() -> int:
    # Windows / PyInstaller 打包后必须调用，否则多进程会无限递归启动自己
    mp.freeze_support()
    ap = build_argparser()
    args = ap.parse_args()

    # --- 参数归一 ---
    # --no-saturation / --no-separate 这类否定式开关统一成布尔属性，
    # 让下游代码只认 args.use_saturation / args.no_separate 两个名字。
    args.use_saturation = not args.no_saturation
    args.no_separate = bool(args.no_separate)
    # --exg-threshold 传负数 = 显式回退到混合判据（保留给对比实验用）
    if args.exg_threshold is not None and args.exg_threshold < 0:
        args.exg_threshold = None

    t_start = time.time()

    log("=" * 78)
    log("整幅影像分块处理 v0.3")
    log("=" * 78)

    in_path = Path(args.input)
    if not in_path.exists():
        log(f"错误：找不到影像 {in_path}")
        return 1

    out_json = Path(args.out_json) if args.out_json else \
        Path("output") / f"{args.job}-gaps.geojson"
    job_dir = Path(args.work_dir) / args.job
    tiles_dir = job_dir / "tiles"
    job_dir.mkdir(parents=True, exist_ok=True)

    # --- 指纹 ---
    fp_params = {
        "tile_size": args.tile_size, "overlap": args.overlap,
        "sigma": args.sigma, "pct": args.pct,
        "exg_threshold": args.exg_threshold,
        "exg_lo": args.exg_lo, "exg_hi": args.exg_hi,
        "use_saturation": args.use_saturation,
        "min_canopy_blob": args.min_canopy_blob, "min_gap_blob": args.min_gap_blob,
        "min_gap_width_m": args.min_gap_width_m, "no_separate": args.no_separate,
        "min_area": args.min_area, "simplify_m": args.simplify_m,
        "prior_pitch_m": args.prior_pitch_m,
        "node_tol_ratio": args.node_tol_ratio,
        "elongate_ratio": args.elongate_ratio,
        "min_coverage_for_slot": args.min_coverage_for_slot,
        "min_valid_ratio": args.min_valid_ratio,
        "no_landcover": args.no_landcover,
        "no_water_segment": args.no_water_segment,
        "unplantable_overlap": args.unplantable_overlap,
        "target_density_per_ha": args.target_density,
        "chm": args.chm or "",
        "segment": args.segment or "",
        "elevation_enabled": not args.no_elevation,
        "elevation_core_chm": args.core_chm,
        "elevation_veto_chm": args.veto_chm,
        "forest_mask": args.forest_mask or "",
        "no_grass_recheck": args.no_grass_recheck,
        "no_grass_grid": args.no_grass_grid,
        "method": args.method,
    }
    # ⚠️ ROI 只在**启用时**加入指纹：
    #    不加 → 会错误复用"无 ROI"的瓦片缓存（圈外结果被带进来）；
    #    无条件加 → 无 ROI 的既有缓存全部失效（重跑一次全量 1,048 秒）。
    if getattr(args, "roi", ""):
        fp_params["roi_path"] = args.roi
    fp = fingerprint(str(in_path), fp_params)
    log(f"任务 {args.job}  参数指纹 {fp}")
    log(f"中间态目录 {job_dir}")

    ds = rasterio.open(in_path)
    log(f"影像 {in_path.name}：{ds.width} × {ds.height} 像素，"
        f"{ds.count} 波段，CRS={ds.crs}")

    # --- 地面分辨率 ---
    b = ds.bounds
    t = Transformer.from_crs(ds.crs, TARGET_CRS, always_xy=True)
    xs, ys = t.transform([b.left, b.right], [b.bottom, b.top])
    px_m = (abs(xs[1] - xs[0]) / ds.width + abs(ys[1] - ys[0]) / ds.height) / 2.0
    area_ha = (abs(xs[1] - xs[0]) * abs(ys[1] - ys[0])) / 1e4
    log(f"地面分辨率 {px_m*100:.2f} cm/像素   覆盖 {area_ha:.1f} 公顷")

    # --- 瓦片规划 ---
    all_tiles = plan_tiles(ds.width, ds.height, args.tile_size, args.overlap)
    total_all = len(all_tiles)

    # 有数据的瓦片排前面（园区是不规则多边形，先剔除大片 NoData）
    good, blank = order_tiles_by_validity(
        ds, all_tiles, cache_path=job_dir / "tile-order.json")
    tiles = good + blank
    # 提示：本幅影像有效瓦片远少于外接矩形瓦片数
    log(f"瓦片规划：全图外接矩形 {total_all} 块，其中含有效数据 {len(good)} 块、"
        f"纯 NoData {len(blank)} 块")

    if args.limit:
        tiles = tiles[:args.limit]
        log(f"（--limit {args.limit}）本次处理 {len(tiles)} 块")
    log(f"瓦片 {args.tile_size}px、外扩 {args.overlap}px"
        f"（外扩 ≈ {args.overlap * px_m:.1f} m）")

    # --- ROI 圈选（2026-10-17 新增，R-P0-11）---
    # 两层裁剪：① 瓦片级：与 ROI 不相交的瓦片**不读盘**（提速主来源）；
    #           ② 像素级：在 process_tile 里把圈外像素置为无效（保证输出只含圈内）。
    roi_geom = None
    roi_source = None
    if getattr(args, "roi", ""):
        try:
            roi_geom, roi_info = load_roi(args.roi, ds.crs)
            if roi_geom is None:
                log(f"⚠️ ROI 无有效多边形，按全图处理：{roi_info.get('reason')}")
            else:
                roi_source = str(args.roi)
                log(f"ROI 圈选：{roi_info['n_parts']} 个多边形，"
                    f"面积 {roi_info['area_m2'] / 1e4:.2f} 公顷"
                    f"（{roi_info['src_crs']} → {ds.crs}）")
                before = len(tiles)
                tiles = tiles_in_roi(ds, tiles, roi_geom)
                log(f"ROI 裁剪瓦片：{before} → {len(tiles)} 块"
                    f"（跳过圈外 {before - len(tiles)} 块，"
                    f"省下 {(before - len(tiles)) / max(before, 1) * 100:.0f}% 的读盘与计算）")
                if not tiles:
                    log("❌ ROI 与影像无交集，请检查圈选范围是否落在影像内")
                    ds.close()
                    return 2
        except Exception as e:  # noqa: BLE001
            log(f"⚠️ ROI 加载失败，已按全图处理：{e}")
            roi_geom = None
            roi_source = None

    # --- 网格勘察 ---
    # ⚠️ ROI 保护（外部顾问提醒的暗坑）：若用户只圈了一小块、里面几乎没树，
    # 严格按 ROI 采样会让 7 块网格勘察样本不足 → 株距/方位角拟合失败。
    # 因此：采样优先 ROI 内，瓦片太少时**回退全图**；但空地检测仍严格限制在 ROI 内。
    survey_tiles = tiles
    if (roi_geom is not None and len(tiles) < max(4, args.survey_samples * 2)
            and len(good) > len(tiles)):
        survey_tiles = good
        log(f"ROI 内仅 {len(tiles)} 块瓦片，网格勘察回退到全图 {len(good)} 块采样"
            f"（保证网格拟合稳定；空地检测仍限制在 ROI 内）")

    grid, report = survey_grid(ds, survey_tiles, px_m, sample_n=args.survey_samples,
                               prior_pitch_m=args.prior_pitch_m,
                               pct=args.pct, sigma=args.sigma,
                               exg_threshold=args.exg_threshold,
                               use_saturation=args.use_saturation,
                               exg_lo=args.exg_lo, exg_hi=args.exg_hi,
                               n_valid_hint=len(good),
                               target_density_per_ha=args.target_density,
                               verbose=not args.quiet)
    atomic_write_json(job_dir / "grid-survey.json", {
        "fingerprint": fp, "generated_at": datetime.now(timezone.utc).isoformat(),
        **report,
    })

    if args.grid_only:
        log("（--grid-only）网格勘察完成，跳过空地处理")
        ds.close()
        return 0

    if grid.quality < 0.15:
        log(f"⚠ 全局网格质量 {grid.quality:.3f} < 0.15，本次所有空地都会被标为"
            f"「不确定」并交人工复核。建议检查影像是否确为规整种植园。")

    # --- 海拔证据（CHM + 语义分割，2026-10-15）---
    elev_params = ElevationParams(
        enabled=not args.no_elevation,
        core_chm=args.core_chm,
        veto_chm=args.veto_chm,
    )
    elevation = None
    if elev_params.enabled:
        chm_p = args.chm if args.chm else None
        seg_p = args.segment if args.segment else None
        if chm_p or seg_p:
            elevation = ElevationEvidence(chm_p, seg_p,
                                          ortho_transform=ds.transform)
            if not elevation.available:
                elevation = None
            else:
                log(f"海拔证据：CHM={'有' if elevation.has_chm() else '无'}  "
                    f"语义分割={'有' if elevation.has_segment() else '无'}  "
                    f"救援阈值 {elev_params.core_chm:g} m / "
                    f"否决阈值 {elev_params.veto_chm:g} m")
                if elevation.available and not args.no_grass_recheck:
                    log("  （已启用海拔证据 → 自动跳过草地回检）")

    # --- 逐瓦片处理 ---
    done = skipped = failed = 0
    all_features: list[dict] = []
    # 覆盖全部类别（含本轮新增的 road/water/office）。
    # ⚠️ 若只初始化旧 4 类，下面 `if k in class_totals` 会把新增三类静默过滤掉，
    #    导致日志与 summary.by_class 漏报 road/water/office（本轮踩过）。
    class_totals = {c: 0 for c in CLASS_LABEL_CN}
    area_total = 0.0
    t_proc = time.time()

    # ---- 第 1 步：按**原始顺序**吃掉命中缓存的瓦片（与串行版完全一致）----
    # 缓存判定必须留在主进程：它要按 tiles 顺序累加，顺序变了浮点末位就会抖。
    pending: list[tuple[int, Tile]] = []
    for i, tile in enumerate(tiles, 1):
        tf = tiles_dir / f"{tile.tile_id}.json"

        if not args.force and not args.merge_only:
            cached = load_tile_result(tf, fp)
            # ⚠️ 必须同时校验 status == "done"：上一轮失败的瓦片也带着有效指纹躺在
            # 磁盘上，只按指纹命中会把它当缓存跳过，导致那几块永远补不回来
            # （本轮 6 块边缘瓦片因此丢失，实测踩过）。
            if cached is not None and cached.get("status") == "done":
                skipped += 1
                all_features.extend(cached.get("gaps", []))
                area_total += cached.get("stats", {}).get("area_sqm", 0.0)
                for k, v in cached.get("stats", {}).get("by_class", {}).items():
                    if k in class_totals:
                        class_totals[k] += v
                continue

        if args.merge_only:
            continue
        pending.append((i, tile))

    workers = resolve_workers(getattr(args, "workers", 1) or 1)
    # 瓦片太少时 spawn 开销不划算（Windows 每个子进程约 1 秒），直接串行
    use_pool = workers > 1 and len(pending) >= max(4, workers * 2)

    if use_pool:
        log(f"多进程跑批：{workers} 个 worker · 待处理 {len(pending)} 个瓦片"
            f"（已命中缓存 {skipped} 个）")
        results: list[tuple] = []
        with ProcessPoolExecutor(
            max_workers=workers,
            initializer=_worker_init,
            initargs=(str(in_path), args.chm or None, args.segment or None,
                      px_m, grid, args, str(tiles_dir), elev_params, roi_geom, fp),
        ) as ex:
            futures = [ex.submit(_worker_run, t) for t in pending]
            for n, fut in enumerate(as_completed(futures), 1):
                results.append(fut.result())
                step = max(1, len(pending) // 20)
                if n % step == 0 or n == len(pending):
                    el = time.time() - t_proc
                    rate = n / el if el > 0 else 0
                    eta = (len(pending) - n) / rate if rate > 0 else 0
                    log(f"  进度 {n}/{len(pending)}（{(n/len(pending))*100:5.1f}%）"
                        f"  用时 {el:5.0f}s  预计剩余 {eta:5.0f}s")

        # 护栏 1：**严格按 tile_idx 升序**累加，保证与串行版逐位一致
        results.sort(key=lambda r: r[0])
        for _idx, tid, status, gaps, stats, err in results:
            done += 1
            if err:
                failed += 1
                log(f"  ✗ {tid} 处理失败：{err[:150]}")
                continue
            if status == "done":
                all_features.extend(gaps)
                area_total += stats.get("area_sqm", 0.0)
                for k, v in stats.get("by_class", {}).items():
                    if k in class_totals:
                        class_totals[k] += v
    else:
        # ---- 串行分支（workers=1，或瓦片太少不值得起进程池）----
        for n, (i, tile) in enumerate(pending, 1):
            tf = tiles_dir / f"{tile.tile_id}.json"
            try:
                res = process_tile(ds, tile, px_m, grid, args, tiles_dir,
                                   elevation=elevation,
                                   elev_params=elev_params,
                                   roi_geom=roi_geom)
                res["fingerprint"] = fp
                res["generated_at"] = datetime.now(timezone.utc).isoformat()
                atomic_write_json(tf, res)
                done += 1
                if res["status"] == "done":
                    all_features.extend(res["gaps"])
                    area_total += res["stats"]["area_sqm"]
                    for k, v in res["stats"]["by_class"].items():
                        if k in class_totals:
                            class_totals[k] += v
            except Exception as e:  # noqa: BLE001
                failed += 1
                log(f"  ✗ {tile.tile_id} 处理失败：{type(e).__name__}: {str(e)[:150]}")
                atomic_write_json(tf, {
                    "tile_id": tile.tile_id, "status": "failed",
                    "error": f"{type(e).__name__}: {str(e)[:300]}",
                    "fingerprint": fp,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "core": {"row": tile.row_core, "col": tile.col_core,
                             "height": tile.h_core, "width": tile.w_core},
                    "gaps": [], "stats": {},
                })
                continue

            # --- 进度输出（主进程，按原始顺序）---
            step = max(1, len(pending) // 20)
            if n % step == 0 or n == len(pending):
                el = time.time() - t_proc
                rate = n / el if el > 0 else 0
                eta = (len(pending) - n) / rate if rate > 0 else 0
                log(f"  进度 {n}/{len(pending)}（{(n/len(pending))*100:5.1f}%）"
                    f"  用时 {el:5.0f}s  预计剩余 {eta:5.0f}s"
                    f"  空地累计 {len(all_features)} 块 / {area_total:,.0f} m²")

    log(f"瓦片处理完成：新算 {done} · 命中缓存 {skipped} · 失败 {failed}"
        f"（{time.time() - t_proc:.1f} s，workers={workers if use_pool else 1}）")

    # --- 若 --merge-only 或本轮全部命中缓存，则从磁盘把结果读全 ---
    if args.merge_only or (done == 0 and skipped == len(tiles)):
        all_features, class_totals, area_total = _reload_from_disk(tiles_dir, tiles, fp)
        log(f"已从磁盘载入 {len(tiles)} 个瓦片结果，共 {len(all_features)} 块空地")

    ds.close()

    # --- 非种植区掩膜（2026-10-16）-------------------------------------------
    # 用户核实园区南部为未开发天然林/次生林，不属油棕种植区。该处林间自然林窗
    # 会被误判为「需补种空地」。用掩膜改判为 undeveloped（不计入需补种）。
    if getattr(args, "forest_mask", None):
        all_features, area_total, n_msk, a_msk = _apply_forest_mask(
            all_features, args.forest_mask, area_total)
        # 改判后重算类别计数（比逐个迁移更不易出错）
        class_totals = {c: 0 for c in CLASS_LABEL_CN}
        for f in all_features:
            k = f["properties"]["class"]
            if k in class_totals:
                class_totals[k] += 1
        if n_msk:
            log(f"  掩膜改判后，需补种面积 {area_total:,.0f} m²")

    # --- 合并输出 ---
    log("-" * 78)
    log("合并整幅结果…")
    result = build_full_geojson(args, in_path, px_m, area_ha, grid, report,
                                all_features, class_totals, area_total,
                                len(tiles), total_all)
    atomic_write_json(out_json, result)
    log(f"整幅 GeoJSON 已导出：{out_json}")

    # --- 汇总 ---
    log("=" * 78)
    log(f"总耗时 {time.time()-t_start:.1f} 秒")
    log(f"瓦片：新处理 {done}，命中缓存 {skipped}，失败 {failed}（共 {len(tiles)}）")
    # 需补种 / 不可种植分开报 —— 二者语义完全不同，混在一起会误导
    # （area_total 已经是「按像素扣除不可种植后」的需补种面积）
    n_plant = sum(class_totals[k] for k in
                  (CLASS_VACANT_SLOT, CLASS_ALLEY_GAP,
                   CLASS_OPEN_PATCH, CLASS_UNCERTAIN))
    n_unp = sum(class_totals[k] for k in UNPLANTABLE_CLASSES)
    unp_area = sum(f["properties"]["area_sqm"] for f in all_features
                   if f["properties"]["class"] in UNPLANTABLE_CLASSES)
    # --- 需补种口径拆分（2026-10-17）---------------------------------------
    # 原来把所有 4 类空地加总当"需补种面积"，但 alley_gap 的语义是
    # 「正常行间缝隙、无需补种」、uncertain 是「证据不足、需人工核实」——
    # 实测这两类合计 52,534 m²，占 headline 的 14.0%。现显式拆三档。
    prio = summarize_priority([{"class": f["properties"]["class"],
                                "area_sqm": f["properties"]["area_sqm"]}
                               for f in all_features])
    def_area = prio["definite_plant"]["area_sqm"]
    def_n = prio["definite_plant"]["count"]
    log(f"需补种（确定）{def_n} 块 / {def_area:,.0f} m² "
        f"（占影像覆盖的 {def_area/(area_ha*1e4)*100:.2f}%）"
        f" ← 连片空地 + 株位空缺")
    log(f"  待复核（不确定，需人工核实）{prio['review']['count']} 块 / "
        f"{prio['review']['area_sqm']:,.0f} m²")
    log(f"  不计入（林间空隙＝正常行间缝隙）{prio['not_needed']['count']} 块 / "
        f"{prio['not_needed']['area_sqm']:,.0f} m²")
    log(f"  合计空地 {n_plant} 块 / {area_total:,.0f} m²"
        f"（旧口径：上三档之和，其中 "
        f"{(prio['review']['area_sqm'] + prio['not_needed']['area_sqm'])/max(area_total,1e-9)*100:.1f}%"
        f" 算法自述无需补种/待核实）")
    log(f"不可种植地物 {n_unp} 块 / {unp_area:,.0f} m²（已从补种面积中按像素扣除）")
    # 动态列出所有非零类别（含新增 road/water/office），不再硬编码旧 4 类
    log("按类别：" + "，".join(
        f"{CLASS_LABEL_CN[k]} {v} 块" for k, v in class_totals.items() if v))
    plant_areas = np.array([f["properties"]["area_sqm"] for f in all_features
                            if f["properties"]["class"] not in UNPLANTABLE_CLASSES])
    if plant_areas.size:
        log(f"需补种空地面积：最大 {plant_areas.max():.1f} m²，"
            f"中位 {np.median(plant_areas):.1f} m²，最小 {plant_areas.min():.1f} m²，"
            f"合计 {plant_areas.sum():.1f} m²")
    log(f"网格：株距 {grid.plant_pitch_m:.2f} m  行距 {grid.row_pitch_m:.2f} m  "
        f"错行角 {grid.skew_angle_deg:.1f}°  质量 {grid.quality:.3f}  方法 {grid.method}")
    log("=" * 78)
    return 0


def _reload_from_disk(tiles_dir: Path, tiles: list[Tile], fp: str
                      ) -> tuple[list[dict], dict, float]:
    """把磁盘上所有有效瓦片结果载入内存（用于 --merge-only 与全命中缓存的场景）。"""
    feats: list[dict] = []
    counts = {c: 0 for c in CLASS_LABEL_CN}   # 含新增三类，避免被 `if k in counts` 过滤
    area = 0.0
    for t in tiles:
        obj = load_tile_result(tiles_dir / f"{t.tile_id}.json", fp)
        if obj is None or obj.get("status") != "done":
            continue
        feats.extend(obj.get("gaps", []))
        area += obj.get("stats", {}).get("area_sqm", 0.0)
        for k, v in obj.get("stats", {}).get("by_class", {}).items():
            if k in counts:
                counts[k] += v
    return feats, counts, area


# ---------------------------------------------------------------------------
# ROI 圈选裁剪（2026-10-17 新增，需求 R-P0-11）
#
# 与 `--forest-mask` 的区别（很容易混淆，务必分清）：
#   · `--forest-mask` ：「这里**不算**」—— 把已判出的空地改判为非种植区；
#   · `--roi`          ：「**只算**这里」—— 圈外瓦片直接跳过，圈外不产出要素。
# 两者可同时使用：先按 ROI 限制范围，再在范围内扣掉非种植区。
# ---------------------------------------------------------------------------
def _read_kml_polygons(p: Path) -> list:
    """从 KML 里抠出所有多边形环。

    ⚠️ 简化处理：`<innerBoundaryIs>`（洞）也会被当成独立多边形。
    对 ROI 用途（取并集当"只算这里"的范围）影响可忽略，不做严格拓扑。
    """
    import xml.etree.ElementTree as ET
    from shapely.geometry import Polygon

    polys = []
    try:
        root = ET.parse(p).getroot()
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"KML 解析失败：{e}") from e

    for node in root.iter():
        if not node.tag.endswith("coordinates"):
            continue
        txt = (node.text or "").strip()
        if not txt:
            continue
        ring = []
        for tok in txt.split():
            parts = tok.split(",")
            if len(parts) >= 2:
                try:
                    ring.append((float(parts[0]), float(parts[1])))
                except ValueError:
                    continue
        if len(ring) >= 4:
            polys.append(Polygon(ring))
    return polys


def load_roi(path: str, dst_crs) -> tuple[object | None, dict]:
    """读取 ROI 多边形（`.geojson` / `.kml`），并转换到影像 CRS。

    返回 `(shapely 几何 或 None, 元信息字典)`。
    """
    from shapely.geometry import shape as _shape
    from shapely.ops import transform as _shp_transform, unary_union
    from pyproj import Transformer as _Tr

    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(f"ROI 文件不存在：{p}")

    suffix = p.suffix.lower()
    src_crs = "EPSG:4326"
    if suffix == ".kml":
        polys = _read_kml_polygons(p)
    else:
        gj = json.loads(p.read_text(encoding="utf-8"))
        if gj.get("type") == "FeatureCollection":
            feats = gj.get("features", [])
        elif gj.get("type") == "Feature":
            feats = [gj]
        else:
            feats = [{"geometry": gj}]
        polys = []
        for f in feats:
            geom = f.get("geometry") or f
            try:
                g = _shape(geom)
            except Exception:  # noqa: BLE001
                continue
            if not g.is_empty:
                polys.append(g)
        # GeoJSON 可能带投影 crs 成员；不认就按 4326
        name = ((gj.get("crs") or {}).get("properties") or {}).get("name", "")
        for code in ("3857", "32649", "32650", "4326"):
            if code in str(name):
                src_crs = f"EPSG:{code}"
                break

    if not polys:
        return None, {"ok": False, "reason": "文件中没有有效多边形"}

    geom = unary_union(polys)
    if str(dst_crs) != src_crs:
        geom = _shp_transform(
            _Tr.from_crs(src_crs, dst_crs, always_xy=True).transform, geom)
    if not geom.is_valid:
        geom = geom.buffer(0)

    return geom, {
        "ok": True,
        "source": str(p),
        "src_crs": src_crs,
        "n_parts": len(polys),
        "area_m2": float(geom.area),
    }


def _tile_hits_roi(ds, tile: Tile, roi_geom) -> bool:
    """瓦片 core 区是否与 ROI 相交。

    **必须在读取栅格之前调用** —— 不相交就不读磁盘，这是 ROI 提速的主要来源。
    """
    from shapely.geometry import box as _box

    win = rasterio.windows.Window(
        tile.col_core, tile.row_core, tile.w_core, tile.h_core)
    left, bottom, right, top = rasterio.windows.bounds(win, ds.transform)
    return _box(left, bottom, right, top).intersects(roi_geom)


def tiles_in_roi(ds, tiles: list[Tile], roi_geom) -> list[Tile]:
    """过滤出与 ROI 相交的瓦片。

    **必须在读取栅格之前调用** —— 不相交的瓦片连磁盘 IO 都不发生，
    这是 ROI 提速的主要来源（全量 528 块 → 圈选后通常只剩几十块）。
    """
    return [t for t in tiles if _tile_hits_roi(ds, t, roi_geom)]


def _roi_mask_for(roi_geom, win_buf, ds, shape) -> np.ndarray:
    """把 ROI 栅格化到当前瓦片窗口（含外扩），返回 bool 掩膜。"""
    from rasterio.features import rasterize as _rasterize
    from rasterio.windows import transform as _win_transform

    tr = _win_transform(win_buf, ds.transform)
    m = _rasterize([(roi_geom, 1)], out_shape=shape, transform=tr,
                   fill=0, all_touched=True, dtype="uint8")
    return m.astype(bool)


def _apply_forest_mask(features: list[dict], mask_path: str,
                       area_total: float) -> tuple[list[dict], float, int, float]:
    """把落在「非种植区掩膜」内的需补种空地改判为 `undeveloped`。

    背景（2026-10-16 用户核实）
    --------------------------
    园区南部（原「油棕-南部」参考点所在处）是**尚未开发的天然林 / 次生林**，
    不属于油棕种植区。该处野生乔木排列随机、没有 8.35 m 的种植行距，
    林间自然林窗（低矮灌木、林隙）会被算法当作「油棕园里的空地」框出来，
    虚增全园需补种面积。

    做法
    ----
    掩膜是一组多边形（GeoJSON，EPSG:4326）。**只改判需补种的 4 类**，
    道路 / 水体 / 办公区不受影响（它们本来就不计入需补种）。
    改判后的要素**仍保留在输出里**，单独成层（`undeveloped`），
    便于在 ArcGIS 中复核，但**不计入需补种面积**。

    掩膜来源
    --------
      · 自动：`scripts/build_forest_mask.py`（基于 DJI 树心密度的区块判定）
      · 手动：用户在 ArcGIS / QGIS 里沿未开发林边界手绘后导出 GeoJSON
    ⚠️ 自动掩膜对阈值敏感（实测 4%~26% 区间），**建议人工复核后再定稿**。
    """
    import json as _json
    from shapely.geometry import shape as _shape, Point
    from shapely.strtree import STRtree

    p = Path(mask_path)
    if not p.exists():
        log(f"⚠️ 非种植区掩膜不存在，已跳过：{p}")
        return features, area_total, 0, 0.0

    gj = _json.loads(p.read_text(encoding="utf-8"))
    geoms = []
    for f in gj.get("features", []):
        try:
            g = _shape(f["geometry"])
            if not g.is_empty:
                geoms.append(g)
        except Exception:  # noqa: BLE001
            continue
    if not geoms:
        log(f"⚠️ 非种植区掩膜无有效多边形，已跳过：{p}")
        return features, area_total, 0, 0.0

    tree = STRtree(geoms)
    plant_cls = (CLASS_VACANT_SLOT, CLASS_ALLEY_GAP,
                 CLASS_OPEN_PATCH, CLASS_UNCERTAIN)
    n_masked = 0
    a_masked = 0.0
    for f in features:
        pr = f["properties"]
        if pr["class"] not in plant_cls:
            continue
        ring = f["geometry"]["coordinates"][0]
        pt = Point(sum(c[0] for c in ring) / len(ring),
                   sum(c[1] for c in ring) / len(ring))
        hit = False
        for g in tree.query(pt):
            # shapely 2.x 返回索引，1.8 返回几何对象 —— 两种都兼容
            geom = geoms[g] if isinstance(g, (int, np.integer)) else g
            if geom.contains(pt):
                hit = True
                break
        if hit:
            pr["class"] = CLASS_UNDEVELOPED
            pr["class_label"] = CLASS_LABEL_CN[CLASS_UNDEVELOPED]
            pr["class_semantics"] = CLASS_SEMANTICS[CLASS_UNDEVELOPED]
            # 后缀保持短（dbf 的 class_method 字段宽 24 字节，
            # "planting_grid_prior+forest_mask" 会被静默截断）
            pr["class_method"] = (
                (pr.get("class_method", "") + "+mask").lstrip("+"))
            pr["class_reason"] = ("落在非种植区掩膜内（未开发林等），"
                                  "不计入补种范围")
            n_masked += 1
            a_masked += float(pr.get("area_sqm", 0.0))

    log(f"非种植区掩膜：{len(geoms)} 个多边形 ← {p.name}；"
        f"改判 {n_masked} 块 / {a_masked:,.0f} m² 为「{CLASS_LABEL_CN[CLASS_UNDEVELOPED]}」"
        f"（不计入需补种）")
    return features, area_total - a_masked, n_masked, a_masked


def _density_check_payload(grid, args) -> dict:
    """把「网格估计密度 vs 用户设计密度」的校验结果整理成可导出的结构。

    单独抽成函数是因为 summary 与 survey_grid 在两个不同的调用栈里，
    而这是一个无副作用的纯计算，直接重算比透传参数更清晰。
    """
    target = getattr(args, "target_density", None)
    ok, ratio, msg = check_density_consistency(grid, target)
    return {
        "target_density_per_ha": target,
        "estimated_density_per_ha": round(float(grid.density_per_ha), 1),
        "ratio_est_over_target": round(float(ratio), 4),
        "ok": bool(ok),
        "message": msg,
    }


def build_full_geojson(args, in_path: Path, px_m: float, area_ha: float,
                       grid: GridModel, report: dict,
                       features: list[dict], counts: dict, area_total: float,
                       n_tiles_done: int, n_tiles_total: int) -> dict:
    """组装整幅 GeoJSON（schema v0.3，KML 可选，本版本无 KML 时为单 block）。"""
    areas = np.array([f["properties"]["area_sqm"] for f in features]) \
        if features else np.array([0.0])
    return {
        "type": "FeatureCollection",
        "schema_version": SCHEMA_VERSION,
        "crs": "EPSG:4326",
        "area_crs": TARGET_CRS,
        "source_image": in_path.name,
        "kml_source": None,          # 旧字段保留兼容（KML 裁剪已由 --roi 取代）
        "used_kml": False,
        "roi_source": (getattr(args, "roi", "") or None),
        "used_roi": bool(getattr(args, "roi", "")),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "processing": {
            "mode": "tiled_resumable",
            "tile_size_px": args.tile_size,
            "overlap_px": args.overlap,
            "tiles_processed": n_tiles_done,
            "tiles_total": n_tiles_total,
            "px_m": round(px_m, 5),
            "image_area_ha": round(area_ha, 3),
            "mem_note": "分块处理，常驻内存常量（单块 ~12 MiB RGB）",
        },
        "planting_grid": grid.to_dict(),
        "grid_survey": {
            "method": "median_of_samples",
            "samples_used": report.get("used", 0),
            "samples_requested": report.get("requested", 0),
            "density_check": report.get("density_check"),
            "fallback": report.get("fallback", False),
            "per_tile": report.get("samples", []),
        },
        "params": {
            "method": args.method,
            "sigma": args.sigma,
            "pct": args.pct,
            "exg_threshold": args.exg_threshold,
            "exg_lo": args.exg_lo,
            "exg_hi": args.exg_hi,
            "use_saturation": args.use_saturation,
            "segmentation_judgement": ("mixed_clip_percentile"
                                       if args.exg_threshold is None
                                       else "fixed_absolute"),
            "min_area_sqm": args.min_area,
            "min_gap_width_m": args.min_gap_width_m,
            "simplify_m": args.simplify_m,
            "separate_gaps": not args.no_separate,
            "landcover_unplantable": not args.no_landcover,
            "water_use_segment": not args.no_water_segment,
            "unplantable_overlap": args.unplantable_overlap,
            "target_density_per_ha": args.target_density,
            "chm_path": args.chm or None,
            "segment_path": args.segment or None,
            "elevation_core_chm": args.core_chm,
            "elevation_veto_chm": args.veto_chm,
            "forest_mask_path": args.forest_mask or None,
            "node_tol_ratio": args.node_tol_ratio,
            "elongate_ratio": args.elongate_ratio,
        },
        # 「本次结果是用哪些输入文件算的」—— 每个文件的 mtime 与大小。
        #
        # ⚠️ 为什么必须记：用户换园区时先「生成高度图」（40 秒），
        #    然后**忘了重跑检测**就直接导出。这时报告里的株数是按旧 CHM 算的，
        #    而界面上完全看不出异常 —— 数字自洽、报告完整，只有到现场才发现不对。
        #    有了这份快照，`/gaps` 就能比对"当前 chm.tif 是否比结果新"并给出提示。
        #
        # 只记 mtime + size 而不是哈希：CHM 有 60 MB，每次检测都算 sha256
        # 要多花 1~2 秒，而 mtime 已经足够判断"有没有被换过"。
        "inputs_snapshot": _inputs_snapshot(args),
        "model": {
            "name": "canopy_structural",
            "type": "rule_based_segmentation",
            "note": "冠层结构法（ExG + 形态学）；DeepForest 预训练权重实测不适配"
                    "北美温带林训练的模型在油棕影像上漏检严重",
        },
        "blocks": [{
            "block_id": "FULL-0001",
            "block_name": "整幅影像（未提供 KML）",
            "gaps": features,
        }],
        "summary": {
            "total_gap_count": len(features),
            "total_area_sqm": round(area_total, 2),
            "total_area_ha": round(area_total / 1e4, 4),
            "gap_area_share_pct": round(area_total / (area_ha * 1e4) * 100, 3),
            "by_class": dict(counts),
            "by_class_label": {CLASS_LABEL_CN[k]: v for k, v in counts.items()},
            # --- 需补种口径三档拆分（2026-10-17 新增）-------------------------
            # 旧字段（total_area_sqm / plantable_area_sqm）是"4 类空地之和"，
            # 其中含「林间空隙＝正常缝隙、无需补种」与「不确定＝需人工核实」，
            # 实测占 14.0%。新字段把口径显式拆开，桌面端/报表应以 definite 为准。
            "by_priority": summarize_priority(
                [{"class": f["properties"]["class"],
                  "area_sqm": f["properties"]["area_sqm"]} for f in features]),
            "by_priority_label": PRIORITY_LABEL_CN,
            "plantable_area_definite_sqm": summarize_priority(
                [{"class": f["properties"]["class"],
                  "area_sqm": f["properties"]["area_sqm"]} for f in features]
            )["definite_plant"]["area_sqm"],
            "plantable_area_legacy_sqm": round(area_total, 2),
            "gap_area_stats_sqm": {
                "max": round(float(areas.max()), 2),
                "median": round(float(np.median(areas)), 2),
                "min": round(float(areas.min()), 2),
            },
            "planting_density_per_ha": round(grid.density_per_ha, 1),
            # 设计密度交叉校验（独立于影像的强先验，由桌面端配置）
            "density_check": _density_check_payload(grid, args),
        },
    }


if __name__ == "__main__":
    sys.exit(main())
