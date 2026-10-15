# -*- coding: utf-8 -*-
"""海拔证据：CHM（冠层高度）+ DJI Terra 语义分割。

为什么需要这个模块
------------------
草地与油棕在**纯 RGB** 上被实测证明不可分：
  · ExG 区间完全重叠（草地 83~95 vs 油棕 1~112，跨航带曝光差 3 倍）
  · 纹理 / 梯度 / 局部动态范围 / 排列周期性 全部重叠
  · DINOv2 深度特征留一验证 5 个区域只对 1 个

引入 **高度**（物理量，不受曝光影响）与 **DJI 语义分割**（端到端学习，
能看整株树冠形状）后，分离度从「不可分」提升到 **+85.3 个百分点**。

融合规则（实测标定，非照搬文献）
--------------------------------
    canopy = (seg == tree) 或 (CHM >= CORE_CHM)
    canopy = canopy 且 非 (CHM < VETO_CHM)

标定依据（5 个真值点，10 m 窗口）：
    真值点        CHM中位   seg=tree   融合后判树%
    草地-点1        3.05       6.9%        17.2%
    草地-点2        1.03       0.0%         0.0%
    油棕-内部       8.34      84.4%        87.5%
    油棕-西北       7.59      77.5%        98.0%
    空地(gap)       2.32       0.0%         5.2%     ← 原误标为"油棕-南部"
  → 树冠点均值 92.8% vs 非树冠点 7.5%，**分离度 +85.3 个百分点**

大样本一致性（1060 万 + 710 万像素）：
  · tree 保留 97.3%
  · other 否决 80.8%
两者互补的证据（实测）：
  · seg 判 other 但 CHM >= 5.2 → 占 other 的 **19.2%**（CHM 救回 seg 漏检的树）
  · seg 判 tree 但 CHM <  1.2 → 占 tree 的 **2.7%**（CHM 否决 seg 的误判）

⚠️ 已知偏差与不提
------------------
1. **DJI 的 DSM 被平滑过**（5×5 粗糙度仅 0.09 m），冠层高度被系统性低估
   约 40%（油棕真实 7~15 m，CHM 只读到 4~10 m）→ **不可套用文献绝对阈值**。
2. **DJI 果树模型支持列表里没有油棕**（只有 orange/litchi/banana/plum/
   persimmon/wogan），属域外推断。实测在 5 个真值点上判定全部正确，
   但仍会漏检约 20% 的树（树心计数 114.8 株/ha vs 期望约 145）。
   因此**必须叠加 CHM 作为互补证据**，不能只用 seg。
3. **紧邻油棕的草地会被"渗高"**（平滑导致周围树冠高度扩散过来），
   如草地-点1 的 CHM 达 3.05 m。融合规则下该点仍有 17.2% 被判为树冠，
   属已知残留，需人工复核。
4. 实测比较过：加入「局部凹陷度 ΔH = CHM − 30m窗口P80」作为第三证据
   **无益反损**（分离度降到 72~83，树冠保留从 97.3% 掉到 68~88%），
   故**不采用**。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.windows import Window, from_bounds, bounds as win_bounds

# DJI Terra segmentAPI.json 的类别定义
SEG_OTHER = 0
SEG_TREE = 1
SEG_BUILDING = 2
SEG_POLE = 3
SEG_GROUND = 4
SEG_WATER = 5
SEG_NODATA = 255

# 融合阈值（本项目实测标定，见模块 docstring）
CORE_CHM = 5.2      # CHM >= 此值 → 无条件判为树冠
VETO_CHM = 1.2      # CHM <  此值 → 无条件否决


@dataclass
class ElevationParams:
    """融合参数。桌面端（Tauri）可全部暴露给用户。"""

    enabled: bool = True
    core_chm: float = CORE_CHM      # 高度救援阈值（米）
    veto_chm: float = VETO_CHM      # 高度否决阈值（米）
    use_segment: bool = True        # 是否使用 DJI 语义分割
    tree_class: int = SEG_TREE      # 语义分割中"树"的类别值


class ElevationEvidence:
    """按需读取 CHM 与语义分割，返回与正射瓦片同形状的证据数组。

    坐标系约定：正射影像 / CHM / segment 三者同为 EPSG:4326 且范围一致，
    只是分辨率不同（3.3 cm / 26 cm / 24.9 cm）。因此用「正射窗口 → 经纬度
    bounds → 各自窗口」的方式对齐，再按目标形状重采样。
    """

    def __init__(self, chm_path: str | Path | None = None,
                 segment_path: str | Path | None = None,
                 ortho_transform=None,
                 segment_crs: str = "EPSG:4326"):
        self.chm = None
        self.seg = None
        self.ortho_transform = ortho_transform
        self.segment_crs = segment_crs

        if chm_path and Path(chm_path).exists():
            self.chm = rasterio.open(chm_path)
        if segment_path and Path(segment_path).exists():
            self.seg = rasterio.open(segment_path)

    # ------------------------------------------------------------------
    @property
    def available(self) -> bool:
        return self.chm is not None or self.seg is not None

    def has_chm(self) -> bool:
        return self.chm is not None

    def has_segment(self) -> bool:
        return self.seg is not None

    # ------------------------------------------------------------------
    def _to_geo_bounds(self, win: Window):
        """把正射影像的像素窗口转成经纬度 bounds。"""
        if self.ortho_transform is None:
            raise ValueError("需要 ortho_transform 才能对齐窗口")
        return win_bounds(win, self.ortho_transform)

    def _read_aligned(self, ds, win: Window, shape: tuple[int, int],
                      resampling: Resampling) -> np.ndarray | None:
        """在指定数据集上读取与正射窗口对应的区域，重采样到 shape。"""
        if ds is None:
            return None
        b = self._to_geo_bounds(win)
        try:
            w = from_bounds(*b, transform=ds.transform)
        except Exception:
            return None
        # 裁到数据集范围内
        c0 = max(0, int(np.floor(w.col_off)))
        r0 = max(0, int(np.floor(w.row_off)))
        c1 = min(ds.width, int(np.ceil(w.col_off + w.width)))
        r1 = min(ds.height, int(np.ceil(w.row_off + w.height)))
        if c1 <= c0 or r1 <= r0:
            return None
        src = Window(c0, r0, c1 - c0, r1 - r0)
        try:
            arr = ds.read(1, window=src, out_shape=shape, resampling=resampling)
        except Exception:
            return None
        return arr

    # ------------------------------------------------------------------
    def read(self, win: Window, shape: tuple[int, int]):
        """返回 (chm, seg) —— 与正射瓦片同形状。

        chm : float32，无效处为 NaN
        seg : uint8 或 None
        """
        chm_out = None
        seg_out = None

        a = self._read_aligned(self.chm, win, shape, Resampling.bilinear)
        if a is not None:
            chm_out = a.astype(np.float32)
            # DSM 的 nodata 是 -9999；同时把非有限值置 NaN
            chm_out[chm_out <= -9000] = np.nan
            chm_out[~np.isfinite(chm_out)] = np.nan

        b = self._read_aligned(self.seg, win, shape, Resampling.nearest)
        if b is not None:
            seg_out = b.astype(np.uint8)

        return chm_out, seg_out

    # ------------------------------------------------------------------
    def close(self) -> None:
        for ds in (self.chm, self.seg):
            if ds is not None:
                try:
                    ds.close()
                except Exception:
                    pass


def fuse_canopy(base_canopy: np.ndarray,
                chm: np.ndarray | None,
                seg: np.ndarray | None,
                p: ElevationParams | None = None) -> tuple[np.ndarray, dict]:
    """把基础树冠掩膜与海拔证据融合。

    参数
    ----
    base_canopy : 基础判据产出的树冠掩膜（无 seg 时的回退）
    chm         : 冠层高度（米），可为 None
    seg         : DJI 语义分割类别，可为 None
    p           : 融合参数

    返回
    ----
    (canopy, stats) —— stats 记录各证据的贡献，便于诊断
    """
    p = p or ElevationParams()
    canopy = base_canopy.copy()
    n = canopy.size
    stats = {"total_px": int(n),
             "rescue_core": 0, "rescue_seg": 0,
             "veto_chm": 0, "seg_replaces_base": 0}

    if not p.enabled or (chm is None and seg is None):
        stats["enabled"] = False
        return canopy, stats

    has_chm = chm is not None
    has_seg = seg is not None and p.use_segment

    # --- 光学证据：有 seg 就用 seg（实测严格优于 ExG），否则用基础掩膜 ---
    if has_seg:
        optical = (seg == p.tree_class)
        stats["seg_replaces_base"] = int((optical != base_canopy).sum())
    else:
        optical = base_canopy

    # --- 高度救援：CHM 足够高 → 无条件判树冠 ---
    if has_chm:
        hi = np.nan_to_num(chm, nan=-1e9) >= p.core_chm
        stats["rescue_core"] = int((hi & ~optical).sum())
        stats["rescue_seg"] = int((hi & ~base_canopy).sum())
        canopy = optical | hi
        # --- 高度否决：CHM 过低 → 无条件非树冠 ---
        lo = np.isfinite(chm) & (chm < p.veto_chm)
        stats["veto_chm"] = int((lo & canopy).sum())
        canopy = canopy & ~lo
    else:
        canopy = optical

    # 无有效高度处不可判为树冠（避免边缘假阳性）
    if has_chm:
        canopy = canopy & np.isfinite(chm)

    stats["enabled"] = True
    stats["canopy_before"] = int(base_canopy.sum())
    stats["canopy_after"] = int(canopy.sum())
    return canopy, stats


__all__ = [
    "ElevationEvidence", "ElevationParams", "fuse_canopy",
    "CORE_CHM", "VETO_CHM",
    "SEG_OTHER", "SEG_TREE", "SEG_BUILDING", "SEG_POLE",
    "SEG_GROUND", "SEG_WATER", "SEG_NODATA",
]
