"""不可种植地物检测（土地覆盖分类）。

定位
----
识别三类**不属于种植网格、也不该被算作待补种空地**的地物：

* ``road``   —— 园区道路（用户：颜色偏白）
* ``water``  —— 河流 / 水塘
* ``office`` —— 办公生活区、堆料场等大面积硬化场地（用户描述：
  "工人上班/住宿的地方，特点之一是周围都是白色的土地"）

油棕树本身已经是 canopy 掩膜（见 ``detect.py:canopy_structural``），
因此天然不在空地补集里，本模块不需要再检测它。

实测依据（WGR17.tif，全图 18,743,382 有效像元普查，2026-10-13）
------------------------------------------------------------------
白色道路（规则 ``L>170 & S<0.18``，命中 4.92%）：
    最大两个连通域包围盒 706×1095 m 与 793×449 m，
    **填充率仅 0.013~0.014**（面状地物应 > 0.2）→ 典型线状网络。
    光谱签名 RGB≈(196-209, 175-206, 161-185)、L≈180~210、S<0.18、
    ExG≈-5~+39、**纹理 std 0.7~8.0（极平滑）**。

水体（规则 ``B≥G>R``，命中 0.42%）：
    深水会落进"暗区"（L<90 & ExG<10，占 3.51%），
    需按「暗 + 低 ExG + 极低纹理」补充识别。

办公/硬化场地（亮白 + 高填充率面状）：
    实测候选的填充率 0.12~0.55、尺寸 24×46 m ~ 151×65 m，
    与道路用**填充率**区分：道路细长（fill<0.25），office 成片（fill≥0.25）。

工程约束
--------
跨航带曝光差极大（ExG 中位 37→116，差 3 倍），**任何绝对阈值都必须配相对分位兜底**，
思路同 ``detect.py`` 的混合判据：``阈值 = clip(分位数, 下限, 上限)``。
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage as ndi

__all__ = [
    "LandcoverParams",
    "detect_roads",
    "detect_water",
    "detect_office",
    "detect_unplantable",
    "UNPLANTABLE_CLASSES",
]

UNPLANTABLE_CLASSES: tuple[str, ...] = ("road", "water", "office")

_STRUCT8 = np.ones((3, 3), dtype=bool)


# ----------------------------------------------------------------------------
# 参数
# ----------------------------------------------------------------------------
@dataclass
class LandcoverParams:
    """三类地物的检测参数。

    默认值全部来自 WGR17.tif 实测，换影像时需重标定（思路同 ExG 判据）。
    """

    # --- 亮度/饱和度（道路与 office 共用"浅色低饱和"特征）---
    # 全图实测（L>170 & S<0.18）：命中 4.92%，共 64,689 m²，
    # 最大连通域 16,056 m²、bbox 1078×1111 m、fill 0.013 → 确认是路网结构。
    # 因此用**固定绝对阈值**作锚点（早期试过"瓦片内 88 分位自适应"，
    # 但在本身偏亮的瓦片里阈值被顶到 185，把 L=170~185 的路面全漏掉了 → 弃用）。
    # 只为暗航带保留一条按比例下调的兜底。
    bright_abs: float = 170.0       # 亮度绝对锚点（实测）
    bright_ref_median: float = 107.0  # 全图亮度中位数，作为"正常曝光"参照
    bright_abs_floor: float = 145.0  # 暗航带下调的底线
    sat_max: float = 0.20           # 饱和度上限（实测白路 S<0.18，留 0.02 余量）

    # --- 形态学：道路 vs office 的分界 ---
    # 全图实测的 fill 分布**完全分离**，用 0.30 一刀切开：
    #   道路/路网碎片：0.013 / 0.050 / 0.056 / 0.065 / 0.131 / 0.164 / 0.168 /
    #                 0.171 / 0.184 / 0.191 / 0.211 / 0.028  → 全部 < 0.30
    #   办公/硬化场地：0.317 / 0.328 / 0.445 / 0.478 / 0.491 / 0.546 / 0.454 / 0.548
    #                                                    → 全部 ≥ 0.30
    road_fill_max: float = 0.30     # fill 低于此值 → 线状 → 道路
    road_min_area_sqm: float = 12.0  # 面积过小的亮斑视为噪声
    office_min_area_sqm: float = 400.0  # office 最小面积（20×20 m 级）
    office_fill_min: float = 0.30   # fill 高于此值且面积达标 → 面状 → office

    # --- 水体 ---
    water_blue_margin: float = 0.0  # B 至少比 R 大多少才算水（0 表示只要 B≥G>R）
    # ⚠️ 亮度上限：`B≥G>R` 对**纯白像素**同样成立（实测白路面 RGB=(251,255,255)，
    #    因传感器噪声导致 R 略小于 G/B 就中招），必须把亮白地物排除。
    #    实测分离度极大：真水 L≈88（暗），白路 L≈253（极亮）。取 160 留足余量，
    #    且与道路检测的亮度锚点（L>170）互斥。
    water_lum_max: float = 160.0
    water_dark_lum: float = 90.0    # 深水的亮度上限
    water_dark_exg: float = 15.0    # 深水的 ExG 上限
    water_texture_max: float = 6.0  # 水面纹理上限（实测白路纹理 0.7~8.0，水面更平滑）
    water_min_area_sqm: float = 30.0  # 水体连通域最小面积（水体是成片地物，不是散点）

    # --- 通用 ---
    min_blob_px: int = 200          # 连通域最小像素数，滤除孤立噪点

    # --- 草地 / 低矮鲜绿植被（可种植，不该被当成油棕树冠）---
    # 依据（2026-10-13 实测，1024² 区域中位值）：
    #   草地（亮绿低矮植被）：ExG 159、S 0.64、G-B 125、L 146
    #   油棕树冠（密林/东南/西北）：ExG 64~102、S 0.37~0.53、G-B 44~79、L 106~119
    # 物理原因：油棕是「立体的绿」——冠层内部阴影把绿度打折；草地是「平面的绿」，
    # 无阴影、更黄更亮。所以 **ExG 过高反而说明这里不是树**。
    # 为排除油棕受光面（亮绿小斑块）的误伤，再用形态学开运算只保留**连片**区域。
    grass_exg_min: float = 130.0    # ExG 下限（油棕实测上限约 102，留足余量）
    grass_sat_min: float = 0.60     # 饱和度下限（油棕实测上限约 0.53）
    grass_open_m: float = 2.0       # 开运算半径（米）：只保留成片草地，滤掉零散受光斑

    # --- 草地回检的第二道判据：株行距网格周期性（方案 B，见方案文档 §4）---
    # 原理：油棕按 8.35 m 株距规则网格种植，草皮是自然生长、无空间周期。
    # 实现分两步（2026-10-14 从"局部 nn 统计"改为"格点贴合"）：
    #   ① estimate_grid() 用**全瓦片树心**拟合种植网格。树心少、间距发散时
    #      网格质量自动不及格（quality < grass_grid_min_quality）→ 不判；
    #   ② 对每个候选连通域，算其像素到最近格点距离的中位数：
    #      ≤ grass_grid_node_tol_m（约半个冠幅）→ 斑块压在种植格上
    #      → 是油棕（受光面 / 幼林）→ 剔除；否则 → 草地 → 保留。
    # ⚠️ 为什么放弃"邻域最近邻比例"（第一版做法，两次实测失败）：
    #     失败 A —— frac ≥ 0.50 单闸门把南部稀疏林下草荒区整片误剔 96%
    #               （散树伪峰 nn 中位 5.54 m、frac 恰好压线）；
    #     失败 B —— 受光面连片区把树心位置整体覆盖成均匀亮绿，局部树心检测
    #               在斑块内部失效，环状邻域的 nn 统计被"洞效应"污染
    #               （实测中位从 8.45 掉到 6.43 m），规则林反判不出来。
    #     改全局格点拟合后，邻域外的树心仍能定出网格，"斑块是否坐在格点上"
    #     才是种植几何的直接证据。
    # 实测依据：密林树心 CV 0.118~0.136（规则）、南部草荒区树心稀散
    # （24 株/ha，网格质量否决）、随机泊松点过程 CV≈0.52。
    grass_grid: bool = True          # 是否启用网格周期性回检
    grass_grid_pitch_m: float = 8.45     # 种植间距先验（grid_prior.DEFAULT_PRIOR_PITCH_M）
    grass_grid_min_quality: float = 0.15  # 网格质量门槛（与 grid_prior.is_usable 一致）
    grass_grid_node_tol_m: float = 3.5    # 斑块像素距最近格点的中位上限（约半个冠幅）


# ----------------------------------------------------------------------------
# 基础特征
# ----------------------------------------------------------------------------
def _features(rgb: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """返回 (亮度 L, 饱和度 S, ExG)。输入 RGB，shape (H, W, 3)。"""
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    lum = (r + g + b) / 3.0
    mx = f.max(axis=2)
    mn = f.min(axis=2)
    with np.errstate(divide="ignore", invalid="ignore"):
        sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    exg = 2.0 * g - r - b
    return lum, sat, exg


def _texture_std(lum: np.ndarray, size: int = 5) -> np.ndarray:
    """局部亮度标准差（5×5 邻域），衡量粗糙度。

    实测最有区分力的特征，且**不依赖绝对亮度**，对跨航带曝光差天然鲁棒：
        株位空缺 8~15 / 连片空地 22~26 / 油棕 39~47 / 草地 46.3
    """
    m1 = ndi.uniform_filter(lum, size=size)
    m2 = ndi.uniform_filter(lum * lum, size=size)
    return np.sqrt(np.maximum(m2 - m1 * m1, 0.0))


def _bright_mask(lum: np.ndarray, sat: np.ndarray, valid: np.ndarray,
                 p: LandcoverParams) -> np.ndarray:
    """浅色 + 低饱和掩膜。

    以全图实测的绝对阈值 ``L>170`` 作锚点（命中 4.92%、结构确认为路网）。
    只为**暗航带**留一条兜底：若整幅瓦片亮度中位数低于全图中位（107），
    按同比例下调阈值，避免暗航带里的白路低于 170 而漏检；
    但绝不低于 ``bright_abs_floor``，防止把普通阴影地面误判成白路。

    ⚠️ 不要改成"瓦片内高分位自适应"——实测那样会在本身偏亮的瓦片里
    把阈值顶到 185，反而漏掉 L=170~185 的路面像素（本轮踩过的坑）。
    """
    if not valid.any():
        return np.zeros(lum.shape, dtype=bool)
    med = float(np.median(lum[valid]))
    thr = p.bright_abs
    if med < p.bright_ref_median:
        thr = p.bright_abs * med / p.bright_ref_median
    thr = max(thr, p.bright_abs_floor)
    return (lum > thr) & (sat < p.sat_max) & valid


# ----------------------------------------------------------------------------
# 道路
# ----------------------------------------------------------------------------
def _component_metrics(comp: np.ndarray, sl, px_m: float) -> tuple[float, float, float, float]:
    """返回 (面积m², bbox宽m, bbox高m, fill)。"""
    area_sqm = float(comp.sum()) * px_m * px_m
    w_m = (sl[1].stop - sl[1].start) * px_m
    h_m = (sl[0].stop - sl[0].start) * px_m
    fill = area_sqm / max(w_m * h_m, 1e-9)
    return area_sqm, w_m, h_m, fill


def detect_roads(rgb: np.ndarray, valid: np.ndarray, px_m: float,
                 p: LandcoverParams | None = None,
                 feat: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
                 ) -> np.ndarray:
    """白色道路网（含零散路段）。

    判据链：
      1. 亮 + 低饱和（实测固定锚点 L>170 & S<0.18，暗航带才按比例下调）
      2. 形态学开运算去毛刺
      3. 面积 ≥ road_min_area_sqm，且 ``fill < road_fill_max`` → 线状 → 道路

    实测依据（全图 top10 亮白域 + 瓦片级验证）：
        路网碎片 fill = 0.013 / 0.028 / 0.050 / 0.056 / 0.065 / 0.131 / 0.164 /
                       0.168 / 0.171 / 0.184 / 0.191 / 0.028   → 全部 < 0.30
        办公场地 fill = 0.317 / 0.328 / 0.445 / 0.454 / 0.478 / 0.491 / 0.546 / 0.548
                                                            → 全部 ≥ 0.30
    两组样本在 0.30 处**完全分离**，因此不需要灰带或长宽比补救。

    ⚠️ 已知局限：若办公区与路网直接相连（用户描述 office"周围都是白色的土地"，
    现实中很可能相连），两者会合成一个连通域，fill 被摊薄 → 整体判为道路。
    退一步说仍归入"不可种植"，不影响补种统计，只是 ArcGIS 里少一个独立类别。
    """
    p = p or LandcoverParams()
    # feat 由 detect_unplantable 预计算后传入（避免 roads/office/water 各算一遍）
    lum, sat, _ = feat if feat is not None else _features(rgb)
    cand = _bright_mask(lum, sat, valid, p) & valid
    if not cand.any():
        return np.zeros(rgb.shape[:2], dtype=bool)

    cand = ndi.binary_opening(cand, structure=_STRUCT8)

    lab, n = ndi.label(cand, structure=_STRUCT8)
    if n == 0:
        return np.zeros(rgb.shape[:2], dtype=bool)

    # 性能优化（2026-10-13，等价改写）：
    #   旧写法对**每个**连通域做全图 `lab == i` 与 `comp.sum()`，2304² 瓦片上
    #   要跑上千次全图比较 + 求和（实测 numpy reduce 累计 41 s / 3 瓦片），
    #   是本轮整幅跑不动的头号瓶颈。
    #   改为 bincount 一次性统计各连通域像素数，再只在各自 bbox 内取局部数组。
    #   两者数学上完全等价 —— 连通域必然落在自己的 bbox 内，判据一字未改。
    counts = np.bincount(lab.ravel(), minlength=n + 1)
    min_px = max(1, p.min_blob_px)
    objs = ndi.find_objects(lab)
    out = np.zeros(rgb.shape[:2], dtype=bool)
    for i in range(1, n + 1):
        if int(counts[i]) < min_px:
            continue
        sl = objs[i - 1]
        sub = lab[sl] == i
        area_sqm, w_m, h_m, fill = _component_metrics(sub, sl, px_m)
        if area_sqm < p.road_min_area_sqm:
            continue
        if fill < p.road_fill_max:
            out[sl] |= sub
    return out


# ----------------------------------------------------------------------------
# 办公 / 硬化场地
# ----------------------------------------------------------------------------
def detect_office(rgb: np.ndarray, valid: np.ndarray, px_m: float,
                  p: LandcoverParams | None = None,
                  feat: tuple[np.ndarray, np.ndarray, np.ndarray] | None = None
                  ) -> np.ndarray:
    """办公生活区、堆料场等大面积硬化场地。

    与道路共用"浅色低饱和"掩膜，反过来取**面状**连通域：
    ``fill ≥ office_fill_min`` 且面积 ≥ ``office_min_area_sqm``。

    实测候选（全图 top10 亮白域里的两个）：
        58×26 m，fill 0.454，689 m² → 办公区
        25×44 m，fill 0.548，597 m² → 办公区
    ⚠️ 全图白色地物共 64,689 m²，最大连通域是 16,056 m² 的路网，
    因此命中量天然不大——这与"园区以道路为主、办公区少"的预期一致。
    """
    p = p or LandcoverParams()
    # feat 由 detect_unplantable 预计算后传入（避免 roads/office/water 各算一遍）
    lum, sat, _ = feat if feat is not None else _features(rgb)
    cand = _bright_mask(lum, sat, valid, p) & valid
    if not cand.any():
        return np.zeros(rgb.shape[:2], dtype=bool)

    cand = ndi.binary_closing(cand, structure=_STRUCT8)
    cand = ndi.binary_opening(cand, structure=_STRUCT8)

    lab, n = ndi.label(cand, structure=_STRUCT8)
    if n == 0:
        return np.zeros(rgb.shape[:2], dtype=bool)

    # 性能优化（2026-10-13，等价改写）：同 detect_roads —— bincount 预筛像素数，
    # 循环内只在各自 bbox 内取局部数组，避免逐连通域的全图比较与求和。
    counts = np.bincount(lab.ravel(), minlength=n + 1)
    min_px = max(1, p.min_blob_px)
    objs = ndi.find_objects(lab)
    out = np.zeros(rgb.shape[:2], dtype=bool)
    for i in range(1, n + 1):
        if int(counts[i]) < min_px:
            continue
        sl = objs[i - 1]
        sub = lab[sl] == i
        area_sqm, w_m, h_m, fill = _component_metrics(sub, sl, px_m)
        if area_sqm < p.office_min_area_sqm:
            continue
        if fill >= p.office_fill_min:
            out[sl] |= sub
    return out


# ----------------------------------------------------------------------------
# 水体
# ----------------------------------------------------------------------------
def detect_water(rgb: np.ndarray, valid: np.ndarray, px_m: float,
                 p: LandcoverParams | None = None) -> np.ndarray:
    """河流 / 水塘。

    用户描述："河流颜色各异，不过看得出来是水"。因此不押注单一颜色，
    用两条互补规则：

    1. ``B ≥ G > R`` —— 水比陆地更偏蓝（实测命中 0.42%）
    2. 暗 + 低 ExG + 极低纹理 —— 深水会掉进"暗区"（3.51%），
       单靠亮度会同时抓到阴影，所以必须叠加"极平滑"这个纹理条件
       （水面纹理 std 远低于树冠与裸土）

    两条规则之后统一过**最小连通域面积**门槛。
    实测必要性：裸用规则时命中处亮度仅 31~45、连通域最大 11 m²——
    那是密林阴影里的散点，不是水体；加上 30 m² 门槛后全部滤掉。
    """
    p = p or LandcoverParams()
    f = rgb.astype(np.float32)
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    lum, _, exg = _features(rgb)

    w1 = ((b >= g - p.water_blue_margin) & (g > r) & valid
          & (lum < p.water_lum_max))     # ← 亮度上限：排除纯白路面（见参数注释）

    dark = (lum < p.water_dark_lum) & valid & (exg < p.water_dark_exg)
    w2 = np.zeros_like(dark)
    if dark.any():
        tex = _texture_std(lum, size=5)
        w2 = dark & (tex < p.water_texture_max)

    out = w1 | w2
    if not out.any():
        return out

    out = ndi.binary_opening(out, structure=_STRUCT8)
    # 水体是成片地物：连通域面积不达标的一律视为阴影/噪声，必须**移除**。
    # ⚠️ 这里不能用"像素数 < min_blob_px 就 continue"提前跳过——
    #    那样会绕过下面的面积门槛，把一堆亚像素级散点漏过去（本轮踩过的坑）。
    lab, n = ndi.label(out, structure=_STRUCT8)
    if n == 0:
        return np.zeros_like(out)
    # 性能优化（2026-10-13，等价改写）：bincount 一次算出所有连通域面积，
    # 再用布尔索引一次性剔除，避免逐连通域的全图 `lab == i` 与求和。
    # ⚠️ 判据与门槛完全不变：仍是对**每个**连通域按面积判断，只是换了算法。
    counts = np.bincount(lab.ravel(), minlength=n + 1)
    areas_sqm = counts.astype(np.float64) * (px_m * px_m)
    small = areas_sqm < p.water_min_area_sqm
    small[0] = False          # 0 号是背景标签，不参与剔除
    removed = int(small.sum())
    if removed:
        out &= ~small[lab]
        log = getattr(detect_water, "_log", None)
        if log:
            log(f"water: 滤除 {removed} 个面积 <{p.water_min_area_sqm}m² 的散点连通域")
    return out


# ----------------------------------------------------------------------------
# 草地（可种植的低矮鲜绿植被）
# ----------------------------------------------------------------------------
def detect_grass(rgb: np.ndarray, valid: np.ndarray, px_m: float,
                 p: LandcoverParams | None = None) -> np.ndarray:
    """林下草地 / 低矮鲜绿植被 —— 它们**是可种植土地，不该被当成油棕树冠**。

    这是全项目最大的算法缺陷（见 docs/03-算法教学/草地与油棕区分方案.html）：
    现有判据是「ExG > 阈值 = 树冠」，而实测**草地的 ExG 反而比油棕高 54%**
    （草地 159 vs 油棕 64~102）—— 于是草地被算成树，从空地候选里被扣掉，**漏检**。

    判据（三条串联，全部来自实测）：
      1. ``ExG > grass_exg_min`` —— 油棕是「立体的绿」，内部阴影把绿度打折，
         所以 ExG 过高反而说明不是树；
      2. ``饱和度 > grass_sat_min`` —— 草地鲜嫩饱和度高（0.64），油棕偏低（≤0.53）；
      3. **形态学开运算只保留连片区域** —— 油棕受光面（亮绿叶片）是零散小斑块，
         草地是成片的。这一条专治误伤；
      4. **株行距网格周期性回检**（``_grid_period_filter``，方案 B）——
         用全瓦片树心拟合种植网格后，剔除"坐在种植格点上"的候选连通域
         （油棕受光面 / 幼林）；偏离格点、或网格质量不及格（树心稀散，
         如草荒区）→ 保留为草地。
         前三层管"颜色像不像草"，这一层管"位置像不像树"。

    ⚠️ 已知局限（2026-10-14 实测确认，待真值坐标验证）：
       1. 若"树没了的大片草荒"与密林同瓦片，且网格质量达标，草荒斑块
          可能因"坐在格点上"被误剔——本判据分的不是"树在不在"，
          而是"斑块是否压住种植几何位置"。南部草荒区因树心稀散
          （24 株/ha）触发质量门槛而幸免，但更密的情况需要用户指认
          真值坐标后做最终校验；
       2. 若某片油棕恰好整体处于强光下且无阴影（如极陡的向阳坡），
          仍可能被误判为草地。因此该步骤默认**只从树冠中剔除**，
          不直接断言「可种植」，最终仍由空地分类与人工复核把关。
    """
    p = p or LandcoverParams()

    # 性能优化（2026-10-13）：草地是「米级」成片地物，判据的物理尺度（1~2 m）
    # 远大于 4 个像素，因此可先在 1/4 分辨率上检测（快 ~16 倍），再上采样回原尺寸。
    # 实测保留率几乎不变（草地 94.6%、受光面 8.1%、密林 0%）。
    H, W = rgb.shape[:2]
    ds_factor = 4
    # ⚠️ 必须用**向上取整**：向下取整会让「放大回原尺寸」后少几列，
    #    与 valid/canopy 等原图尺寸的数组广播失败（实测 6 块边缘瓦片
    #    报 (2304,2202) vs (2304,2200) 的 ValueError）。
    h2 = -(-H // ds_factor)          # ceil(H/4)
    w2 = -(-W // ds_factor)          # ceil(W/4)
    if h2 < 32 or w2 < 32:
        ds_factor = 1
        h2, w2 = H, W
    small = rgb[::ds_factor, ::ds_factor][:h2, :w2]
    small_valid = valid[::ds_factor, ::ds_factor][:h2, :w2]
    px_s = px_m * ds_factor

    lum, sat, exg = _features(small)
    sigma = max(1.0, 1.0 / max(px_s, 1e-6))     # 平滑 1 m，抹掉叶片级细节
    exg_s = ndi.gaussian_filter(exg.astype(np.float32), sigma=sigma)
    sat_s = ndi.gaussian_filter(sat.astype(np.float32), sigma=sigma)

    raw = small_valid & (exg_s > p.grass_exg_min) & (sat_s > p.grass_sat_min)
    if not raw.any():
        return np.zeros((H, W), dtype=bool)

    # 按距离变换做圆盘开运算（O(n)，同 separate_gap_units 的做法）
    r = max(1, int(round(p.grass_open_m / max(px_s, 1e-6))))
    dist_in = ndi.distance_transform_edt(raw)
    eroded = dist_in > r
    if not eroded.any():
        return np.zeros((H, W), dtype=bool)
    dist_out = ndi.distance_transform_edt(~eroded)
    opened = (dist_out <= r) & raw

    # 第二道判据（方案 B）：剔除「坐在种植网格上」的候选连通域——
    # 那是油棕林（受光面 / 幼林），不是草地。在**低分辨率**上做
    # （此时 opened/small/small_valid 都是 1/4 尺寸，px_s = px_m·ds_factor）。
    if p.grass_grid:
        opened = _grid_period_filter(opened, raw, small, small_valid, px_s, p)

    if ds_factor == 1:
        return opened
    return np.repeat(np.repeat(opened, ds_factor, axis=0), ds_factor,
                     axis=1)[:H, :W]


def _grid_period_filter(opened: np.ndarray, raw: np.ndarray, rgb: np.ndarray,
                        valid: np.ndarray, px_m: float,
                        p: LandcoverParams) -> np.ndarray:
    """株行距网格周期性回检（草地判据的第二道闸，方案 B）。

    对 ``opened``（颜色+开运算后的草地候选）的每个连通域：

      1. 用**全瓦片**树心（ExG 局部极大）拟合种植网格
         （``grid_prior.estimate_grid``，先验株距 ``grass_grid_pitch_m``）。
         树心太少、间距发散 → 网格质量 < ``grass_grid_min_quality``
         → 结构判据不可用 → 整个函数直接返回，一个都不剔；
      2. 对每个连通域，算其全部像素到**最近种植格点**距离的中位数
         （向量化实现，等价 ``GridModel.xy_to_grid`` 第三返回值）：

         - 中位 ≤ ``grass_grid_node_tol_m``（约半个冠幅）→ 斑块坐在
           种植格上 → 是油棕（受光面 / 幼林）→ 剔除；
         - 否则 → 斑块偏离所有格点 → 无种植周期 → 保留为草地。

    ⚠️ 为什么不是"斑块内树心按 8.45 m 排列"（2026-10-14 两次实测失败后的
       修正，详见 LandcoverParams.grass_grid 注释）：受光面连片区会把树心
       位置整体覆盖成均匀亮绿，局部树心检测在斑块内部失效；稀疏草荒区又
       只有稀疏散树（nn 中位 5.54 m）冒充周期。"是否坐在格点上"绕开了
       这两个陷阱——它问的是斑块与**种植几何**的关系，不是斑块内部纹理。

    参数
    ----
    opened : 候选掩膜（已开运算，低分辨率）
    raw    : 开运算前的颜色候选掩膜，仅用于 estimate_grid 的折叠投影兜底
    rgb    : 低分辨率 RGB（树心检测用）
    valid  : 低分辨率有效掩膜
    px_m   : 低分辨率地面分辨率（米/像素）
    """
    if not opened.any():
        return opened

    from rasterio.transform import Affine
    from grid_prior import estimate_grid

    # 网格估计在低分辨率坐标里自洽进行（树心像素 × px_m = 斑块像素 × px_m），
    # 因此仿射传 identity 原点即可，无需引入瓦片地理坐标。
    aff = Affine(px_m, 0.0, 0.0, 0.0, -px_m, 0.0)
    grid = estimate_grid(raw, aff, px_m, rgb=rgb, valid=valid,
                         prior_pitch_m=p.grass_grid_pitch_m)

    log = getattr(detect_grass, "_log", None)
    if grid.quality < p.grass_grid_min_quality:
        if log:
            log(f"grass-grid: 网格质量 {grid.quality:.2f} < "
                f"{p.grass_grid_min_quality}（method={grid.method}，"
                f"树心 {grid.node_count} 个）→ 结构判据不可用，不剔除")
        return opened

    lab, n = ndi.label(opened)
    if n == 0:
        return opened
    objs = ndi.find_objects(lab)

    # --- 向量化「像素 → 最近格点距离」（等价 GridModel.xy_to_grid）---
    a = np.radians(grid.row_azimuth_deg)
    ux, uy = np.cos(a), np.sin(a)
    vx, vy = -np.sin(a), np.cos(a)
    plant, row, skew = (grid.plant_pitch_m, grid.row_pitch_m,
                        grid.skew_offset_m)

    def _node_dist(xs_px: np.ndarray, ys_px: np.ndarray) -> np.ndarray:
        X, Y = xs_px * px_m, ys_px * px_m
        dx, dy = X - grid.origin_x_m, Y - grid.origin_y_m
        gy = (dx * vx + dy * vy) / max(row, 1e-6)
        gx = (dx * ux + dy * uy - gy * skew) / max(plant, 1e-6)
        ix = np.round(gx)
        iy = np.round(gy)
        along_u = ix * plant + iy * skew
        nx = grid.origin_x_m + along_u * ux + iy * row * vx
        ny = grid.origin_y_m + along_u * uy + iy * row * vy
        return np.hypot(X - nx, Y - ny)

    kept = opened.copy()
    removed = kept_area = 0
    for i in range(1, n + 1):
        sl = objs[i - 1]
        if sl is None:
            continue
        sub = lab[sl] == i
        ys, xs = np.nonzero(sub)
        if ys.size == 0:
            continue
        d = _node_dist(xs + sl[1].start, ys + sl[0].start)
        dmed = float(np.median(d))
        area = float(ys.size) * px_m * px_m
        if dmed <= p.grass_grid_node_tol_m:
            kept[sl][sub] = False
            removed += 1
            kept_area += area

    if log:
        log(f"grass-grid: 网格质量 {grid.quality:.2f}，株距 "
            f"{grid.plant_pitch_m:.2f} m / 行距 {grid.row_pitch_m:.2f} m / "
            f"错行角 {grid.skew_angle_deg:.0f}°，树心 {grid.node_count} 个；"
            f"剔除 {removed} 个压在种植格上的候选连通域"
            f"（{kept_area:.1f} m²），其余 {n - removed} 个保留为草地")
    return kept


# ----------------------------------------------------------------------------
# 汇总
# ----------------------------------------------------------------------------
def detect_unplantable(rgb: np.ndarray, valid: np.ndarray, px_m: float,
                       p: LandcoverParams | None = None
                       ) -> dict[str, np.ndarray]:
    """三类不可种植地物掩膜汇总。

    返回 ``{"road": mask, "water": mask, "office": mask}``，均为 bool 数组。
    三者互不重叠：water 优先，然后 road，最后 office（按此优先级赋值），
    避免同一个亮斑同时被判成道路和办公区。
    """
    p = p or LandcoverParams()
    shape = rgb.shape[:2]
    # 三个检测器共用同一组基础特征（亮度 / 饱和度 / ExG），只算一次
    feat = _features(rgb)
    water = detect_water(rgb, valid, px_m, p)
    road = detect_roads(rgb, valid, px_m, p, feat=feat)
    office = detect_office(rgb, valid, px_m, p, feat=feat)

    # 去重叠：water 最可信，其次 road，最后 office
    road &= ~water
    office &= ~(water | road)
    return {"road": road, "water": water, "office": office}


# ----------------------------------------------------------------------------
# 自测
# ----------------------------------------------------------------------------
def _selftest(verbose: bool = True) -> int:
    """在合成图上验证三类掩膜的基本行为。"""
    # px_m=0.5：1 px = 50 cm，便于用像素数表达真实的米制尺寸
    px_m = 0.5
    H = W = 600
    rng = np.random.default_rng(20261013)

    # 绿色基底（模拟树冠/草地）
    base = np.zeros((H, W, 3), dtype=np.uint8)
    base[..., 0] = 90
    base[..., 1] = 130
    base[..., 2] = 60

    # 1) 道路网：多条 2 m 宽细线交叉，fill 极低（实测路网 fill=0.013）。
    #    不能画成实心亮带——实心高填充亮带属于"结实硬化场地"（= office）。
    ROAD_W = 4                                    # 4 px = 2 m
    for row in (120, 260, 400, 520):
        base[row:row + ROAD_W, 20:580] = (205, 205, 200)
    for col in (80, 200, 330, 560):
        base[60:560, col:col + ROAD_W] = (205, 205, 200)
    base[150:400, 240:244] = (205, 205, 200)      # 斜向主干

    # 2) 一片水体：左下角偏蓝方块
    base[430:520, 30:180] = (60, 100, 130)

    # 3) 一块办公区：右侧实心紧凑团块（20×20 m = 400 m²，fill 高）
    #    与最近的道路保持 30 m 以上间距，避免连通域合并摊薄 fill
    base[60:100, 380:460] = (200, 200, 196)

    valid = np.ones((H, W), dtype=bool)
    masks = detect_unplantable(base, valid, px_m)

    ok = True

    def check(name: str, mask: np.ndarray, expect_any: bool):
        nonlocal ok
        n = int(mask.sum())
        good = (n > 0) == expect_any
        ok &= good
        if verbose:
            print(f"  [{'OK ' if good else 'FAIL'}] {name}: "
                  f"{n} px（{n * px_m * px_m:.0f} m²）")
        return n

    if verbose:
        print("landcover 自测（合成图 600×600，px_m=0.5）")

    check("道路（横向亮带）", masks["road"], True)
    check("水体（左下蓝块）", masks["water"], True)
    check("办公区（右上大片亮白）", masks["office"], True)

    # 交叉验证：办公区内部（远离道路的一个点）不应被 road 命中
    probe = (75, 410)          # 位于办公团 (60:100, 380:460) 内部，周围 30 m 无路
    if masks["road"][probe]:
        ok = False
        if verbose:
            print("  [FAIL] 办公区内部像素被 road 误命中")
    if verbose:
        inter_ro = int((masks["road"] & masks["office"]).sum())
        cover_ok = bool(masks["office"][probe])
        print(f"  [{'OK ' if inter_ro == 0 else 'FAIL'}] road/office 重叠 {inter_ro} px")
        print(f"  [{'OK ' if cover_ok else 'FAIL'}] 办公区内部被 office 正确覆盖")
        ok &= (inter_ro == 0) and cover_ok

    # 全绿图上三类都应为空
    green = np.dstack([np.full((H, W), 90, np.uint8),
                       np.full((H, W), 130, np.uint8),
                       np.full((H, W), 60, np.uint8)])
    m2 = detect_unplantable(green, np.ones((H, W), bool), px_m)
    for k, v in m2.items():
        if int(v.sum()) != 0:
            ok = False
            if verbose:
                print(f"  [FAIL] 纯绿图上 {k} 非空：{int(v.sum())} px")
    if verbose:
        print(f"  [{'OK ' if all(int(v.sum())==0 for v in m2.values()) else 'FAIL'}] "
              f"纯绿图上三类均为空")

    if verbose:
        print(f"自测结果：{'全部通过' if ok else '存在失败项'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(_selftest())
