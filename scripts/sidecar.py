#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""推理服务 sidecar —— Python ↔ Tauri 宿主的稳定进程边界。

设计要点（见 docs/01-需求与架构/推理服务契约.md）
================================================
这个文件 **不实现任何算法**。它只做三件事：

  1. 把宿主传来的 JSON 参数翻译成 process_image 内部用的 args 命名空间
  2. 编排主流程（因为它需要在这里插入结构化事件回调）
  3. 把进度/结果/错误包装成 NDJSON 事件写到 stdout

算法本体仍然只有一份，在 detect.py / grid_prior.py / process_image.py 里。
主循环的编排逻辑与 process_image.main() 保持等价 —— 差异仅为：
  - 进度从 print() 日志改为结构化 progress 事件
  - 终态从"写文件 + 返回码"改为"发 result/error 事件 + 返回码"
  - 异常被捕获并映射到错误码

通道约定
========
  stdin  : 参数 JSON（--params-stdin 时）
  stdout : **只输出 NDJSON**，一行一个事件，每行 flush
  stderr : 人类可读的诊断日志（可丢弃）

用法
====
    # 方式 A：命令行内联
    python scripts/sidecar.py --params-json '{"input":"D:/WGR/WGR17.tif"}'

    # 方式 B：stdin
    echo '{"input":"..."}' | python scripts/sidecar.py --params-stdin

    # 方式 C：参数文件
    python scripts/sidecar.py --params-file job.json

    # 自检（不跑算法，只验证事件通道）
    python scripts/sidecar.py --self-test
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

# ---------------------------------------------------------------------------
# 路径与缓存环境（与 process_image.py 保持一致）
# ---------------------------------------------------------------------------
_SCRIPT_DIR = Path(__file__).resolve().parent
_PROJ = _SCRIPT_DIR.parent
sys.path.insert(0, str(_SCRIPT_DIR))
os.environ.setdefault("HF_HOME", str(_PROJ / ".cache" / "huggingface"))
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("TORCH_HOME", str(_PROJ / ".cache" / "torch"))

SIDECAR_VERSION = "1.0.0"

# 事件通道：stdout 只允许 NDJSON。这里刻意不与 process_image 的 log() 共用，
# 因为那个 log() 是 print() 到 stdout 的 —— 用它写事件会污染数据通道。
_STDOUT = sys.stdout


def emit(event: str, **fields) -> None:
    """写一个 NDJSON 事件到 stdout 并立即 flush。

    宿主按行读取解析，所以：
      - 必须单行（json.dumps 默认不产生换行）
      - 必须 flush（否则宿主收不到实时进度）
      - 中文不转义（ensure_ascii=False），便于直接显示
    """
    obj = {"event": event}
    obj.update(fields)
    _STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _STDOUT.flush()


def diag(msg: str) -> None:
    """人类诊断日志 → stderr（不污染 stdout 的数据通道）。"""
    sys.stderr.write(f"[{datetime.now():%H:%M:%S}] {msg}\n")
    sys.stderr.flush()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ===========================================================================
# 参数：JSON → args 命名空间
# ===========================================================================
# 引擎默认值集中在这里。刻意不从 process_image.build_argparser() 里抽，
# 因为那里是"给人用的 CLI"，两者默认值一旦不同就是错误来源 —— 所以这里
# 用一份显式表，并在契约文档里同步（见契约 §2.2）。
PARAM_SPEC: dict[str, tuple[type, object]] = {
    # (类型, 默认值)
    "input":            (str,   None),
    "job":              (str,   "wgr17-full"),
    "work_dir":         (str,   "output/jobs"),
    "out_json":         (str,   None),
    "kml":              (str,   None),   # 已废弃，请用 roi（保留兼容）
    "roi":              (str,   ""),     # ROI 圈选：只检测该多边形内（.geojson/.kml）
    "tile_size":        (int,   2048),
    "overlap":          (int,   128),
    "limit":            (int,   None),
    "force":            (bool,  False),
    "merge_only":       (bool,  False),
    "grid_only":        (bool,  False),
    "min_valid_ratio":  (float, 0.05),
    "method":           (str,   "structural"),
    # 分割判据
    "sigma":            (float, 5.0),
    "pct":              (float, 40.0),
    "exg_lo":           (float, 40.0),
    "exg_hi":           (float, 80.0),
    "exg_threshold":    (float, None),
    "use_saturation":   (bool,  True),
    # 空地分离与矢量化
    "min_canopy_blob":  (int,   2000),
    "min_gap_blob":     (int,   200),
    "min_gap_width_m":  (float, 1.6),
    "separate_gaps":    (bool,  True),
    "min_area":         (float, 30.0),
    "simplify_m":       (float, 0.3),
    # 网格先验
    "prior_pitch_m":    (float, None),   # None → 用 grid_prior 的 DEFAULT_PRIOR_PITCH_M
    "node_tol_ratio":   (float, 0.35),
    "elongate_ratio":   (float, 2.2),
    "min_coverage_for_slot": (float, 0.15),
    "survey_samples":   (int,   7),
    # 不可种植地物（2026-10-13 新增）
    "landcover_unplantable": (bool, True),
    # 水体第三条证据：并入 DJI 语义分割的水体类别（2026-10-17 新增）。
    # 修正「含藻类的灰绿色水塘」漏检 —— RGB 蓝度规则只覆盖 DJI 水体的 7.9%。
    "water_use_segment": (bool, True),
    "target_density_per_ha": (float, 150.0),
    "chm_path": (str, ""),
    "segment_path": (str, ""),
    "elevation_enabled": (bool, True),
    "elevation_core_chm": (float, 5.2),
    "elevation_veto_chm": (float, 1.2),
    "forest_mask_path": (str, ""),
    "unplantable_overlap": (float, 0.5),
    # 草地回检：把「过于鲜绿且连片」的区域从树冠中剔除（修正草地被误判成油棕）
    "grass_recheck":  (bool,  True),
    # 草地回检第二道判据：株行距网格周期性（树心规则排列 → 油棕林 → 剔除）
    "grass_grid":     (bool,  True),
    # 通道控制
    "quiet":            (bool,  False),
    "progress_every":   (int,   20),
}

# 与 args 命名空间字段名的映射差异（契约用 snake_case，内部用 argparse 风格名）
_ARG_ALIASES = {
    "separate_gaps": "no_separate",   # 语义相反：True → no_separate=False
    "landcover_unplantable": "no_landcover",  # 语义相反：True → no_landcover=False
    "grass_recheck": "no_grass_recheck",      # 语义相反：True → no_grass_recheck=False
    "grass_grid": "no_grass_grid",            # 语义相反：True → no_grass_grid=False
    "water_use_segment": "no_water_segment",  # 语义相反：True → no_water_segment=False
}


class ParamError(Exception):
    """参数校验失败 → E1002。"""

    def __init__(self, message: str):
        super().__init__(message)
        self.message = message


def normalize_params(raw: dict) -> tuple[SimpleNamespace, list[dict]]:
    """把宿主 JSON 归一化成内部 args 命名空间。

    返回 (args, warnings)。不抛异常的部分尽量走 warnings，只有硬约束才抛。
    """
    warnings: list[dict] = []

    # 未知字段：忽略但告警（向前兼容）
    unknown = sorted(set(raw) - set(PARAM_SPEC))
    if unknown:
        warnings.append({
            "code": "W1001",
            "message": f"参数对象含未知字段，已忽略：{', '.join(unknown)}",
        })

    # 类型检查与默认填充
    values: dict[str, object] = {}
    for key, (typ, default) in PARAM_SPEC.items():
        if key not in raw:
            values[key] = default
            continue
        val = raw[key]
        if val is None:
            values[key] = None
            continue
        # bool 是 int 的子类，必须先判 bool，否则 True 会被 int 分支悄悄接受
        if typ is bool:
            if not isinstance(val, bool):
                raise ParamError(f"参数 {key} 应为布尔值，收到 {type(val).__name__}")
            values[key] = val
        elif typ is int:
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                raise ParamError(f"参数 {key} 应为整数，收到 {type(val).__name__}")
            values[key] = int(val)
        elif typ is float:
            if isinstance(val, bool) or not isinstance(val, (int, float)):
                raise ParamError(f"参数 {key} 应为数字，收到 {type(val).__name__}")
            values[key] = float(val)
        else:  # str
            if not isinstance(val, str):
                raise ParamError(f"参数 {key} 应为字符串，收到 {type(val).__name__}")
            values[key] = val

    # --- 业务约束校验（契约 §2.2 校验规则）---
    if not values["input"]:
        raise ParamError("缺少必填参数 input（影像路径）")

    ts = values["tile_size"]
    if ts < 256 or (ts & (ts - 1)) != 0:
        raise ParamError(f"tile_size 必须是不小于 256 的 2 的幂，收到 {ts}")

    ov = values["overlap"]
    if ov < 0 or ov >= ts / 2:
        raise ParamError(f"overlap 必须满足 0 ≤ overlap < tile_size/2，收到 {ov}")

    pct = values["pct"]
    if not (0 < pct <= 100):
        raise ParamError(f"pct 必须在 (0, 100] 区间，收到 {pct}")

    if values["exg_lo"] is not None and values["exg_hi"] is not None:
        if values["exg_lo"] >= values["exg_hi"]:
            raise ParamError(
                f"exg_lo 必须小于 exg_hi，收到 {values['exg_lo']} / {values['exg_hi']}")

    if values["method"] not in ("structural", "deepforest"):
        raise ParamError(
            f"method 只接受 structural / deepforest，收到 {values['method']}")

    if values["progress_every"] is not None and values["progress_every"] < 1:
        raise ParamError(f"progress_every 必须 ≥ 1，收到 {values['progress_every']}")

    # KML 裁剪已由 roi 取代（契约 W1002）
    if values.get("kml") and not values.get("roi"):
        warnings.append({
            "code": "W1002",
            "message": "kml 参数已废弃，请改用 roi（同样支持 .kml 与 .geojson）；"
                       "本次仍按整幅影像处理",
        })

    # --- 组装 args 命名空间 ---
    args = SimpleNamespace()
    args.input = values["input"]
    args.job = values["job"]
    args.work_dir = values["work_dir"]
    args.out_json = values["out_json"]
    # ROI 圈选（2026-10-17）：只检测该多边形内；圈外瓦片跳过不读盘
    args.roi = values["roi"]
    args.tile_size = values["tile_size"]
    args.overlap = values["overlap"]
    args.limit = values["limit"]
    args.force = bool(values["force"])
    args.merge_only = bool(values["merge_only"])
    args.grid_only = bool(values["grid_only"])
    args.min_valid_ratio = values["min_valid_ratio"]
    args.method = values["method"]

    args.sigma = values["sigma"]
    args.pct = values["pct"]
    args.exg_lo = values["exg_lo"]
    args.exg_hi = values["exg_hi"]
    args.exg_threshold = values["exg_threshold"]
    # 负数 = 显式回退到混合判据（与 process_image.main 的归一逻辑一致）
    if args.exg_threshold is not None and args.exg_threshold < 0:
        args.exg_threshold = None
    args.use_saturation = bool(values["use_saturation"])

    args.min_canopy_blob = values["min_canopy_blob"]
    args.min_gap_blob = values["min_gap_blob"]
    args.min_gap_width_m = values["min_gap_width_m"]
    args.no_separate = not bool(values["separate_gaps"])   # 语义取反
    args.min_area = values["min_area"]
    args.simplify_m = values["simplify_m"]

    args.node_tol_ratio = values["node_tol_ratio"]
    args.elongate_ratio = values["elongate_ratio"]
    args.min_coverage_for_slot = values["min_coverage_for_slot"]
    args.survey_samples = values["survey_samples"]
    # 不可种植地物（语义取反：landcover_unplantable=True → no_landcover=False）
    args.no_landcover = not bool(values["landcover_unplantable"])
    args.unplantable_overlap = values["unplantable_overlap"]
    # 水体第三条证据（语义取反：water_use_segment=True → no_water_segment=False）
    args.no_water_segment = not bool(values["water_use_segment"])
    # 用户给定的设计密度（株/公顷），用于交叉校验网格估计
    args.target_density = values["target_density_per_ha"]
    # 海拔证据（CHM + DJI 语义分割）：草地/油棕在纯 RGB 上不可分，
    # 引入高度与语义后分离度 +85.3 个百分点（见 scripts/elevation.py）
    args.chm = values["chm_path"]
    args.segment = values["segment_path"]
    args.no_elevation = not bool(values["elevation_enabled"])
    args.core_chm = values["elevation_core_chm"]
    args.veto_chm = values["elevation_veto_chm"]
    # 非种植区掩膜（未开发林等）：落在其中的需补种空地改判为 undeveloped
    args.forest_mask = values["forest_mask_path"]
    args.no_grass_recheck = not bool(values["grass_recheck"])
    args.no_grass_grid = not bool(values["grass_grid"])
    args.quiet = bool(values["quiet"])
    args.progress_every = values["progress_every"]

    # prior_pitch_m 的内部默认来自 grid_prior，需要 import 后才能填
    from grid_prior import DEFAULT_PRIOR_PITCH_M
    args.prior_pitch_m = (values["prior_pitch_m"]
                          if values["prior_pitch_m"] is not None
                          else DEFAULT_PRIOR_PITCH_M)

    return args, warnings


def params_echo(args: SimpleNamespace) -> dict:
    """把归一化后的实际生效参数导出（供 started 事件回显，便于复现）。"""
    return {
        "input": args.input,
        "job": args.job,
        "work_dir": args.work_dir,
        "out_json": args.out_json,
        "roi": args.roi,
        "tile_size": args.tile_size,
        "overlap": args.overlap,
        "limit": args.limit,
        "force": args.force,
        "merge_only": args.merge_only,
        "grid_only": args.grid_only,
        "min_valid_ratio": args.min_valid_ratio,
        "method": args.method,
        "sigma": args.sigma,
        "pct": args.pct,
        "exg_lo": args.exg_lo,
        "exg_hi": args.exg_hi,
        "exg_threshold": args.exg_threshold,
        "use_saturation": args.use_saturation,
        "min_canopy_blob": args.min_canopy_blob,
        "min_gap_blob": args.min_gap_blob,
        "min_gap_width_m": args.min_gap_width_m,
        "separate_gaps": not args.no_separate,
        "min_area": args.min_area,
        "simplify_m": args.simplify_m,
        "prior_pitch_m": args.prior_pitch_m,
        "node_tol_ratio": args.node_tol_ratio,
        "elongate_ratio": args.elongate_ratio,
        "min_coverage_for_slot": args.min_coverage_for_slot,
        "survey_samples": args.survey_samples,
        "landcover_unplantable": not args.no_landcover,
        "unplantable_overlap": args.unplantable_overlap,
        "water_use_segment": not args.no_water_segment,
        "target_density_per_ha": args.target_density,
        "chm_path": args.chm or None,
        "segment_path": args.segment or None,
        "elevation_enabled": not args.no_elevation,
        "elevation_core_chm": args.core_chm,
        "elevation_veto_chm": args.veto_chm,
        "forest_mask_path": args.forest_mask or None,
        "grass_recheck": not args.no_grass_recheck,
        "grass_grid": not args.no_grass_grid,
        "progress_every": args.progress_every,
    }


# ===========================================================================
# 错误码映射
# ===========================================================================
class SidecarError(Exception):
    """带错误码的异常。"""

    def __init__(self, code: str, message: str, stage: str,
                 recoverable: bool = True, detail: str = ""):
        super().__init__(message)
        self.code = code
        self.message = message
        self.stage = stage
        self.recoverable = recoverable
        self.detail = detail


def classify_exception(exc: BaseException, stage: str) -> SidecarError:
    """把底层异常映射到契约 §5.1 的错误码。

    ⚠️ 这里的映射是**保守**的：只在能明确归类时才给具体码，否则一律 E9001。
    宁可让宿主看到"内部错误"，也不要把 IO 错误误报成推理错误 —— 后者会让
    用户去查算法，方向完全错。
    """
    name = type(exc).__name__
    text = str(exc)
    detail = f"{name}: {text[:300]}"

    # IO 段
    if isinstance(exc, FileNotFoundError):
        return SidecarError("E1001", f"找不到影像文件 {text}", stage, True, detail)
    if isinstance(exc, PermissionError):
        return SidecarError("E1003", f"文件权限不足：{text}", stage, True, detail)
    if isinstance(exc, OSError):
        # 磁盘满 / 路径不可写等
        msg = "输出路径不可写或磁盘空间不足" if "space" in text.lower() \
            else f"文件系统错误：{text}"
        return SidecarError("E1003", msg, stage, True, detail)

    # 推理段
    if isinstance(exc, MemoryError):
        return SidecarError(
            "E9001", "内存不足，请减小 tile_size 或关闭其他程序",
            stage, True, detail)

    # rasterio / shapely 的领域异常按类名匹配（避免硬依赖它们的异常类型）
    if "Rasterio" in name or "rasterio" in name:
        return SidecarError("E2001", f"影像读取或坐标系统错误：{text}",
                            stage, True, detail)
    if "CRS" in text or "crs" in text or "transform" in text.lower():
        return SidecarError("E2002", f"坐标转换失败：{text}", stage, True, detail)

    # 参数段（normalize 已处理大部分，这里兜底）
    if isinstance(exc, ValueError) and stage == "validate":
        return SidecarError("E1002", text, stage, True, detail)

    # 未知 → 内部错误
    return SidecarError("E9001", f"内部错误：{name}: {text[:200]}",
                        stage, False, detail)


# ===========================================================================
# 主流程编排
# ===========================================================================
def run_pipeline(args: SimpleNamespace, t_start: float) -> dict:
    """编排主流程，沿途发事件。返回 result 事件的字段字典。

    与 process_image.main() 保持逻辑等价；差异只在事件注入与异常处理。
    """
    import numpy as np
    import rasterio
    from pyproj import Transformer

    # 延迟 import：这样 --self-test 不需要 rasterio 也能跑
    import process_image as PI
    from detect import TARGET_CRS
    from grid_prior import (CLASS_VACANT_SLOT, CLASS_ALLEY_GAP,
                            CLASS_OPEN_PATCH, CLASS_UNCERTAIN, CLASS_LABEL_CN)

    stage = "open_image"

    in_path = Path(args.input)
    if not in_path.exists():
        raise SidecarError("E1001", f"找不到影像文件 {in_path}",
                           "open_image", True)

    out_json = Path(args.out_json) if args.out_json else \
        Path("output") / f"{args.job}-gaps.geojson"
    job_dir = Path(args.work_dir) / args.job
    tiles_dir = job_dir / "tiles"
    job_dir.mkdir(parents=True, exist_ok=True)

    # --- 参数指纹（与 process_image 逐字段一致，否则缓存互不命中）---
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
        "unplantable_overlap": args.unplantable_overlap,
        "no_water_segment": args.no_water_segment,
        "target_density_per_ha": args.target_density,
        "chm_path": args.chm or None,
        "segment_path": args.segment or None,
        "elevation_enabled": not args.no_elevation,
        "elevation_core_chm": args.core_chm,
        "elevation_veto_chm": args.veto_chm,
        "forest_mask_path": args.forest_mask or None,
        "no_grass_recheck": args.no_grass_recheck,
        "no_grass_grid": args.no_grass_grid,
        "method": args.method,
    }
    # ⚠️ ROI 只在**启用时**加入指纹：否则无 ROI 的既有瓦片缓存会全部失效
    #    （重跑一次全量要 1,048 秒）。未启用时指纹与旧版逐位一致。
    if args.roi:
        fp_params["roi_path"] = args.roi
    fp = PI.fingerprint(str(in_path), fp_params)
    diag(f"任务 {args.job}  参数指纹 {fp}")

    # --- 打开影像 ---
    try:
        ds = rasterio.open(in_path)
    except Exception as e:  # noqa: BLE001
        raise classify_exception(e, "open_image") from e

    try:
        if ds.crs is None or ds.transform is None or ds.transform.is_identity:
            raise SidecarError(
                "E1005", "影像缺少地理坐标信息（无 CRS 或 transform），"
                         "无法计算实际面积", "open_image", False)

        b = ds.bounds
        t = Transformer.from_crs(ds.crs, TARGET_CRS, always_xy=True)
        xs, ys = t.transform([b.left, b.right], [b.bottom, b.top])
        px_m = (abs(xs[1] - xs[0]) / ds.width + abs(ys[1] - ys[0]) / ds.height) / 2.0
        area_ha = (abs(xs[1] - xs[0]) * abs(ys[1] - ys[0])) / 1e4

        emit("log", level="info", stage="open_image",
             message=f"影像 {in_path.name}：{ds.width} × {ds.height} 像素，"
                     f"{ds.count} 波段，CRS={ds.crs}")
        emit("log", level="info", stage="open_image",
             message=f"地面分辨率 {px_m*100:.2f} cm/像素，覆盖 {area_ha:.1f} 公顷")

        # --- 瓦片规划 ---
        stage = "plan_tiles"
        all_tiles = PI.plan_tiles(ds.width, ds.height, args.tile_size, args.overlap)
        good, blank = PI.order_tiles_by_validity(ds, all_tiles)
        tiles = good + blank
        if args.limit:
            tiles = tiles[:args.limit]
        emit("log", level="info", stage="plan_tiles",
             message=f"瓦片规划：全图外接矩形 {len(all_tiles)} 块，"
                     f"其中含有效数据 {len(good)} 块、纯 NoData {len(blank)} 块；"
                     f"本次处理 {len(tiles)} 块")

        # --- ROI 圈选（2026-10-17，R-P0-11）---
        # 与 process_image.main() 保持等价：瓦片级跳过 + 像素级掩膜（在 process_tile 内）
        roi_geom = None
        if args.roi:
            try:
                roi_geom, roi_info = PI.load_roi(args.roi, ds.crs)
            except Exception as e:  # noqa: BLE001
                emit("warn", code="W1003",
                     message=f"ROI 加载失败，已按全图处理：{e}")
                roi_geom = None
            else:
                if roi_geom is None:
                    emit("warn", code="W1003",
                         message=f"ROI 无有效多边形，已按全图处理："
                                 f"{roi_info.get('reason')}")
                else:
                    before = len(tiles)
                    tiles = PI.tiles_in_roi(ds, tiles, roi_geom)
                    emit("log", level="info", stage="roi",
                         message=f"ROI 圈选 {roi_info['area_m2'] / 1e4:.2f} 公顷："
                                 f"瓦片 {before} → {len(tiles)} 块"
                                 f"（跳过圈外 {before - len(tiles)} 块，不读盘）")

        if not tiles:
            raise SidecarError("E3001", "没有可处理的瓦片", "plan_tiles", False)

        # --- 网格勘察 ---
        # ⚠️ ROI 保护：圈选范围太小（里面几乎没树）时，严格按 ROI 采样会让
        # 7 块网格样本不足 → 株距/方位角拟合失败。采样回退全图，检测仍限 ROI。
        stage = "grid_survey"
        survey_tiles = tiles
        if (roi_geom is not None and len(tiles) < max(4, args.survey_samples * 2)
                and len(good) > len(tiles)):
            survey_tiles = good
            emit("warn", code="W1004",
                 message=f"ROI 内仅 {len(tiles)} 块瓦片，网格勘察回退到全图 "
                         f"{len(good)} 块采样（保证网格拟合稳定；空地检测仍限 ROI 内）")

        grid, report = PI.survey_grid(
            ds, survey_tiles, px_m, sample_n=args.survey_samples,
            prior_pitch_m=args.prior_pitch_m, pct=args.pct, sigma=args.sigma,
            exg_threshold=args.exg_threshold, use_saturation=args.use_saturation,
            exg_lo=args.exg_lo, exg_hi=args.exg_hi,
            n_valid_hint=len(good), verbose=False)

        PI.atomic_write_json(job_dir / "grid-survey.json", {
            "fingerprint": fp, "generated_at": _now(), **report,
        })

        emit("log", level="info", stage="grid_survey",
             message=f"网格勘察完成：株距 {grid.plant_pitch_m:.2f} m，"
                     f"行距 {grid.row_pitch_m:.2f} m，"
                     f"错行角 {grid.skew_angle_deg:.1f}°，"
                     f"质量 {grid.quality:.3f}，密度 {grid.density_per_ha:.1f} 株/公顷")

        # 网格质量告警（契约 W2001 / W3001）
        if grid.quality < 0.15:
            emit("warn", code="W2001",
                 message=f"全局网格质量 {grid.quality:.3f} < 0.15，本次所有空地"
                         f"都会被标为「不确定」并交人工复核；"
                         f"建议确认影像是否为规整种植园")
        elif grid.quality < 0.4:
            emit("warn", code="W3001",
                 message=f"全局网格质量 {grid.quality:.3f} < 0.4，"
                         f"分类结果建议人工抽查")

        # --- grid_only 提前返回 ---
        if args.grid_only:
            emit("log", level="info", stage="export",
                 message="（grid_only）网格勘察完成，跳过空地处理")
            ds.close()
            return {
                "job": args.job,
                "out_json": None,
                "grid_only": True,
                "summary": None,
                "planting_grid": grid.to_dict(),
                "image_area_ha": round(area_ha, 3),
                "px_m": round(px_m, 5),
                "tiles": {"total": len(tiles), "processed": 0, "cached": 0,
                          "failed": 0, "valid": len(good)},
            }

        # --- 海拔证据（CHM + DJI 语义分割，2026-10-17 接线）---------------------
        # ⚠️ 原来这里**没有接海拔证据**：调用 PI.process_tile(...) 时没传
        #    elevation / elev_params，于是**桌面端跑的是纯 RGB 版本**
        #    （退化为草地回检兜底），与 CLI 结果不一致 —— 同一份影像两条路
        #    会给出不同的补种面积。现按 process_image.main() 的同一逻辑接线。
        #    未提供 chm/segment 时 elevation 仍为 None，行为与旧版一致（向后兼容）。
        elev_params = PI.ElevationParams(
            enabled=not args.no_elevation,
            core_chm=args.core_chm,
            veto_chm=args.veto_chm,
        )
        elevation = None
        if elev_params.enabled:
            chm_p = args.chm or None
            seg_p = args.segment or None
            if chm_p or seg_p:
                elevation = PI.ElevationEvidence(chm_p, seg_p,
                                                ortho_transform=ds.transform)
                if not elevation.available:
                    elevation = None
                else:
                    emit("log", level="info", stage="elevation",
                         message=f"海拔证据：CHM={'有' if elevation.has_chm() else '无'}  "
                                 f"语义分割={'有' if elevation.has_segment() else '无'}  "
                                 f"救援阈值 {elev_params.core_chm:g} m / "
                                 f"否决阈值 {elev_params.veto_chm:g} m")

        # --- 逐瓦片处理 ---
        stage = "tile_processing"
        done = skipped = failed = 0
        all_features: list[dict] = []
        class_totals = {c: 0 for c in CLASS_LABEL_CN}
        area_total = 0.0
        t_proc = time.time()

        total = len(tiles)
        # 首尾必发；中间按 progress_every 间隔发
        every = max(1, total // args.progress_every) if total > args.progress_every \
            else 1

        for i, tile in enumerate(tiles, 1):
            tf = tiles_dir / f"{tile.tile_id}.json"

            # 缓存命中：直接累计（**merge_only 也走这里**）。
            # 与 process_image.main() 的差别：原版在 merge_only 下直接 continue、
            # 靠最后的 _reload_from_disk 一次性补齐。那样进度事件里 gaps_found
            # 会一直是 0，宿主无法在进度条旁实时显示"已发现 X 块空地"。
            # 这里改成逐块累计，_reload_from_disk 退化为兜底（正常情况下不再触发）。
            if not args.force:
                cached = PI.load_tile_result(tf, fp)
                if cached is not None:
                    skipped += 1
                    if cached.get("status") == "done":
                        all_features.extend(cached.get("gaps", []))
                        area_total += cached.get("stats", {}).get("area_sqm", 0.0)
                        for k, v in cached.get("stats", {}).get("by_class", {}).items():
                            if k in class_totals:
                                class_totals[k] += v
                    # 进度事件（首尾必发）
                    if i == 1 or i == total or (i % every == 0):
                        el = time.time() - t_proc
                        emit("progress", stage="tile_processing",
                             done=i, total=total, ratio=round(i / total, 4),
                             elapsed_s=round(el, 1), eta_s=0.0,
                             tiles_new=done, tiles_cached=skipped,
                             tiles_failed=failed,
                             gaps_found=len(all_features),
                             gap_area_sqm=round(area_total, 1),
                             message=f"进度 {i}/{total}（{i/total*100:.1f}%）· 命中缓存")
                    continue

            if not args.merge_only:
                try:
                    res = PI.process_tile(ds, tile, px_m, grid, args, tiles_dir,
                                          elevation=elevation,
                                          elev_params=elev_params,
                                          roi_geom=roi_geom)
                    res["fingerprint"] = fp
                    res["generated_at"] = _now()
                    PI.atomic_write_json(tf, res)
                    done += 1
                    if res["status"] == "done":
                        all_features.extend(res["gaps"])
                        area_total += res["stats"]["area_sqm"]
                        for k, v in res["stats"]["by_class"].items():
                            if k in class_totals:
                                class_totals[k] += v
                except Exception as e:  # noqa: BLE001
                    failed += 1
                    diag(f"  ✗ {tile.tile_id} 处理失败：{type(e).__name__}: {str(e)[:150]}")
                    PI.atomic_write_json(tf, {
                        "tile_id": tile.tile_id, "status": "failed",
                        "error": f"{type(e).__name__}: {str(e)[:300]}",
                        "fingerprint": fp, "generated_at": _now(),
                        "core": {"row": tile.row_core, "col": tile.col_core,
                                 "height": tile.h_core, "width": tile.w_core},
                        "gaps": [], "stats": {},
                    })
                    # 注意：这里**不能** continue —— 否则若最后一块恰好失败，
                    # done==total 的收尾进度事件就发不出去，违反"首尾必发"约定。

            # --- 进度事件（首尾必发）---
            if i == 1 or i == total or (i % every == 0):
                el = time.time() - t_proc
                rate = i / el if el > 0 else 0
                eta = (total - i) / rate if rate > 0 else None
                emit("progress", stage="tile_processing",
                     done=i, total=total, ratio=round(i / total, 4),
                     elapsed_s=round(el, 1),
                     eta_s=(round(eta, 1) if eta is not None else None),
                     tiles_new=done, tiles_cached=skipped, tiles_failed=failed,
                     gaps_found=len(all_features),
                     gap_area_sqm=round(area_total, 1),
                     message=f"进度 {i}/{total}（{i/total*100:.1f}%）")

        # --- 兜底：正常路径已在循环里累计完毕，此处仅当"一块都没累计到"时
        #     才从磁盘重载（例如 --force 但全部写入失败这种极端情形）。---
        if args.merge_only and skipped == 0 and done == 0 and not all_features:
            all_features, class_totals, area_total = PI._reload_from_disk(
                tiles_dir, tiles, fp)
            emit("log", level="info", stage="merge",
                 message=f"（兜底）从磁盘载入 {total} 个瓦片结果，"
                         f"共 {len(all_features)} 块空地")

        # 部分瓦片失败告警（契约 W3002）
        if failed > 0:
            emit("warn", code="W3002",
                 message=f"{failed}/{total} 个瓦片处理失败（已跳过），"
                         f"结果仍产出但可能不完整")

        ds.close()

        # --- 合并导出 ---
        stage = "merge"
        emit("log", level="info", stage="merge", message="合并整幅结果…")
        result = PI.build_full_geojson(
            args, in_path, px_m, area_ha, grid, report,
            all_features, class_totals, area_total, total, len(all_tiles))

        stage = "export"
        PI.atomic_write_json(out_json, result)
        emit("log", level="info", stage="export",
             message=f"整幅 GeoJSON 已导出：{out_json}")

        # 空地占比异常告警（契约 W4001）—— 判据过松的典型信号
        share = area_total / (area_ha * 1e4) * 100 if area_ha > 0 else 0
        if share > 25:
            emit("warn", code="W4001",
                 message=f"空地总面积占比 {share:.1f}% > 25%，"
                         f"可能是分割判据过松（建议复核 exg_lo/exg_hi 标定）")

        areas = np.array([f["properties"]["area_sqm"] for f in all_features]) \
            if all_features else np.array([0.0])

        return {
            "job": args.job,
            # 统一为正斜杠：Windows 的 str(Path) 会给反斜杠，宿主侧（Rust/JS）
            # 若按 "/" 拼接或做正则匹配会踩坑。JSON 路径用正斜杠是通行做法。
            "out_json": out_json.as_posix(),
            "elapsed_s": round(time.time() - t_start, 1),
            "summary": result["summary"],
            "planting_grid": {
                "plant_pitch_m": round(grid.plant_pitch_m, 2),
                "row_pitch_m": round(grid.row_pitch_m, 4),
                "skew_angle_deg": round(grid.skew_angle_deg, 1),
                "row_azimuth_deg": round(grid.row_azimuth_deg, 4),
                "quality": round(grid.quality, 4),
                "density_per_ha": round(grid.density_per_ha, 1),
                "method": grid.method,
                "is_triangular": getattr(grid, "is_triangular", None),
            },
            "tiles": {
                "total": total,
                "processed": done,
                "cached": skipped,
                "failed": failed,
                "valid": len(good),
            },
            "image_area_ha": round(area_ha, 3),
            "px_m": round(px_m, 5),
            "gap_area_stats_sqm": {
                "max": round(float(areas.max()), 2),
                "median": round(float(np.median(areas)), 2),
                "min": round(float(areas.min()), 2),
            },
        }
    finally:
        try:
            ds.close()
        except Exception:  # noqa: BLE001
            pass


# ===========================================================================
# 自检
# ===========================================================================
def self_test() -> int:
    """不跑算法，只验证事件通道与参数管线。"""
    emit("started", job="_self_test", pid=os.getpid(),
         sidecar_version=SIDECAR_VERSION, schema_version="0.3",
         params_echo={"input": "/fake/path.tif"}, started_at=_now())

    # 1) 参数归一
    args, warns = normalize_params({
        "input": "/fake/path.tif",
        "progress_every": 5,
        "unknown_field_xyz": 1,
    })
    assert args.tile_size == 2048, "默认值未生效"
    assert args.no_separate is False, "separate_gaps 语义取反映射错误"
    assert len(warns) == 1 and warns[0]["code"] == "W1001", "未知字段告警缺失"
    emit("log", level="info", stage="validate", message="参数归一化通过")

    # 2) 非法参数必须被拒
    for bad, why in [
        ({"input": "x.tif", "tile_size": 1000}, "非 2 的幂"),
        ({"input": "x.tif", "overlap": 2000}, "overlap 过大"),
        ({"input": "x.tif", "pct": 0}, "pct 越界"),
        ({"input": "x.tif", "exg_lo": 90, "exg_hi": 40}, "lo ≥ hi"),
        ({"input": "x.tif", "method": "bogus"}, "method 非法"),
        ({}, "缺 input"),
    ]:
        try:
            normalize_params(bad)
        except ParamError:
            emit("log", level="info", stage="validate",
                 message=f"非法参数被正确拒绝：{why}")
        else:
            emit("error", code="E1002",
                 message=f"自检失败：非法参数未被拒绝（{why}）",
                 stage="validate", recoverable=False)
            return 1

    # 3) 事件通道格式（每行必须是合法 JSON）
    for i in range(3):
        emit("progress", stage="tile_processing", done=i + 1, total=3,
             ratio=round((i + 1) / 3, 4), message=f"自检进度 {i+1}/3")

    emit("warn", code="W1002", message="自检告警示例")
    emit("result", job="_self_test", out_json=None, elapsed_s=0.01,
         summary={"total_gap_count": 0}, finished_at=_now())
    return 0


# ===========================================================================
# 入口
# ===========================================================================
def read_params(argv: list[str]) -> dict:
    """按 --params-json / --params-stdin / --params-file 三者之一读参数。"""
    ap = argparse.ArgumentParser(
        prog="sidecar.py",
        description="推理服务 sidecar（JSON 进，NDJSON 事件出）",
        add_help=True)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--params-json", default=None,
                   help="直接内联参数 JSON 字符串")
    g.add_argument("--params-stdin", action="store_true",
                   help="从 stdin 读参数 JSON")
    g.add_argument("--params-file", default=None,
                   help="从文件读参数 JSON")
    ap.add_argument("--self-test", action="store_true",
                    help="只验证事件通道与参数管线，不跑算法")
    ap.add_argument("--version", action="store_true", help="打印版本号")

    ns = ap.parse_args(argv)

    if ns.version:
        print(SIDECAR_VERSION)
        sys.exit(0)

    if ns.self_test:
        sys.exit(self_test())

    if ns.params_json is not None:
        text = ns.params_json
    elif ns.params_stdin:
        text = sys.stdin.read()
    elif ns.params_file is not None:
        p = Path(ns.params_file)
        if not p.exists():
            emit("error", code="E1001", message=f"参数文件不存在：{p}",
                 stage="validate", recoverable=True, finished_at=_now())
            sys.exit(1)
        text = p.read_text(encoding="utf-8")
    else:
        emit("error", code="E1002",
             message="必须指定 --params-json / --params-stdin / --params-file 之一",
             stage="validate", recoverable=True, finished_at=_now())
        sys.exit(1)

    if not text.strip():
        emit("error", code="E1002", message="参数为空",
             stage="validate", recoverable=True, finished_at=_now())
        sys.exit(1)

    try:
        obj = json.loads(text)
    except json.JSONDecodeError as e:
        emit("error", code="E1002",
             message=f"参数不是合法 JSON：{e}", stage="validate",
             recoverable=True, detail=str(e)[:300], finished_at=_now())
        sys.exit(1)

    if not isinstance(obj, dict):
        emit("error", code="E1002", message="参数必须是 JSON 对象",
             stage="validate", recoverable=True, finished_at=_now())
        sys.exit(1)

    return obj


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    raw = read_params(argv)

    t_start = time.time()

    # --- 参数归一 ---
    try:
        args, warns = normalize_params(raw)
    except ParamError as e:
        emit("error", code="E1002", message=e.message, stage="validate",
             recoverable=True, finished_at=_now())
        return 1
    except Exception as e:  # noqa: BLE001
        se = classify_exception(e, "validate")
        emit("error", code=se.code, message=se.message, stage=se.stage,
             recoverable=se.recoverable, detail=se.detail, finished_at=_now())
        return 1

    emit("started", job=args.job, pid=os.getpid(),
         sidecar_version=SIDECAR_VERSION, schema_version="0.3",
         params_echo=params_echo(args), started_at=_now())

    for w in warns:
        emit("warn", code=w["code"], message=w["message"])

    # --- 跑主流程 ---
    try:
        result_fields = run_pipeline(args, t_start)
    except SidecarError as e:
        emit("error", code=e.code, message=e.message, stage=e.stage,
             recoverable=e.recoverable, detail=e.detail, finished_at=_now())
        return 1 if e.recoverable else 2
    except KeyboardInterrupt:
        diag("被用户中断")
        return 130
    except Exception as e:  # noqa: BLE001
        se = classify_exception(e, "unknown")
        diag(traceback.format_exc())
        emit("error", code=se.code, message=se.message, stage=se.stage,
             recoverable=se.recoverable, detail=se.detail, finished_at=_now())
        return 2

    emit("result", finished_at=_now(), **result_fields)
    return 0


if __name__ == "__main__":
    sys.exit(main())
