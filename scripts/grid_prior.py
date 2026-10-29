"""
株行距网格先验（Planting Grid Prior）  v0.2
================================================================================
作用：在「树冠掩膜」之上估计园区实际的种植网格，把每个空地多边形分成两类：

    vacant_slot（株位空缺）—— 压在种植格点上的缺株，通常是一株树没了，
                              形状偏圆、面积接近单株投影面积
    alley_gap  （林间空隙）—— 落在行间通道上的缝隙，通常呈条带 / 细长形，
                              属于正常株间生长间隙
    uncertain  （不确定）  —— 先验不可信或两种特征都不满足，交人工复核

为什么要这么做
--------------------------------------------------------------------------------
v0.1 只输出「是不是空地」一个二值判定，但同样 40 m² 的空地可能是两件完全不同
的事：一株树死了留下圆坑（要补种），或者两行之间的窄缝（不用管）。单靠形状
无法稳定区分。真正稳定的先验是**种植几何**——油棕规整种植，株行距在整园内
高度一致。因此只要估计出这个网格，就能反推「这块空地是不是压在格点上」。

--------------------------------------------------------------------------------
★ 本项目影像的实测结论（2026-10-13，WGR17.tif，跨 8 个 2048² 窗口）
--------------------------------------------------------------------------------
这些数字决定了下面的算法设计，是实测而非推测：

  指标                          实测值                 含义
  ------------------------------------------------------------------------
  树心最近邻距 中位             7.05 ~ 7.63 m          跨 8 区极稳定
  最近邻距 CV                   0.09 ~ 0.20            规则种植
                                                       （随机泊松点过程 = 0.52）
  种植密度                      105 ~ 173 株/ha        中位 129
  位移向量主方向                62° / 122°（差 60°）    三角形种植（错行）
  冠层覆盖率                    68 ~ 84 %              严重粘连
  2D 自相关                     单调衰减、无周期峰      ★ 频域法不可用
  1D 投影 FFT                   主峰漂移 7~20 m         ★ 频域法不可用

**核心结论：本影像必须走「空间域 / 点阵域」，不能用「频域」。**

原因：冠层覆盖率高达 79%，相邻树冠完全粘连成一片。频域方法（FFT、自相关）
会被「冠层连通体的整体形状」主导，而不是被「树与树的间距」主导——所以自相关
在 r≈2 m 处出现一个由粘连造成的光环，之后单调衰减，看不到任何周期峰。

因此本模块采用三条互补证据，加权融合：

  方法 A｜树心点阵（主力，权重最高）
      在 ExG 平滑图上找局部极大 = 树心，去重后得到散点。
      规则种植时，点阵的**最近邻距分布**会高度集中（CV 小），
      而且**位移向量的方位角**会聚集在有限几个方向上。
      从密度反推网格间距，从方位角得到种植行方向。

  方法 B｜垂距分布周期（辅助）
      沿候选行方向做投影，再用「折叠方差」检验周期性。
      只在 A 失败（树心太少）时作为兜底。

  方法 C｜先验回落（兜底）
      A、B 都失败时用实测先验值（8.45 m）并把置信度打到 0，
      所有空地一律标 uncertain —— 宁可交人工，也不给错标签。

--------------------------------------------------------------------------------
★ 关于「三角形种植」的重要设计决策
--------------------------------------------------------------------------------
实测位移主方向相差 60°，且两个方向上的间距接近相等——这是标准的
**等边三角形种植**（equilateral triangular planting，又叫错行种植/
六方最密堆积）。此时：

    行内株距 = a
    相邻行垂距 = a · sin60° = 0.866 a
    密度 = 1e4 / (0.866 · a²)

很多早期资料会说「8.45 m 株行距」——那其实是**等边三角形的边长 a**，
不是"株距 8.45 × 行距 8.45"的正方形网格。两者密度差 15%：

    等边三角形 a=8.45 m → 161 株/ha
    正方形 8.45×8.45 m  → 140 株/ha

本模块统一用 (row_pitch, plant_pitch, skew_angle) 三元组描述网格，
skew_angle=0 表示正方形（对齐）种植，skew_angle≈60° 表示三角形种植。
这样两种模式都能表达，不需要在外部做分支判断。

--------------------------------------------------------------------------------
用法
--------------------------------------------------------------------------------
    from grid_prior import estimate_grid, classify_gaps, gap_geometry

    grid = estimate_grid(canopy, affine, px_m)      # 估计网格
    geoms = [gap_geometry(poly, gid, area) for ...]  # 算几何量
    labels = classify_gaps(geoms, grid)              # 打标签

也可以一步到位：
    grid, labels = build_grid_and_classify(canopy, affine, px_m, polys)

命令行自检：
    python scripts/grid_prior.py            # 跑人造园合成测试
    python scripts/grid_prior.py --selftest # 同上，带更多断言
================================================================================
"""
from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass, field, asdict
from typing import Any, Iterable, Sequence

import numpy as np

# ----------------------------------------------------------------------------
# 对外常量
# ----------------------------------------------------------------------------
CLASS_VACANT_SLOT = "vacant_slot"   # 株位空缺
CLASS_ALLEY_GAP = "alley_gap"       # 林间空隙
CLASS_OPEN_PATCH = "open_patch"     # 连片空地
CLASS_UNCERTAIN = "uncertain"       # 不确定

# --- 不可种植地物（2026-10-13 用户拍板新增）--------------------------------
# 用户明确要求：道路（白色）、河流/水塘、油棕树、办公生活区四类算"不可种植"，
# "其他的都可以算空地"。油棕树本身已是 canopy 掩膜，天然不在空地补集里；
# 其余三类由 scripts/landcover.py 检测，在此登记类别常量。
CLASS_ROAD = "road"                 # 园区道路 / 硬化路面
CLASS_WATER = "water"               # 河流 / 水塘
CLASS_OFFICE = "office"             # 办公生活区 / 堆料场等硬化场地

# --- 非种植区（2026-10-16 用户指认新增）-------------------------------------
# 用户核实：园区南部（原「油棕-南部」参考点所在处）是**尚未开发的天然林/次生林**，
# 不属于油棕种植区。该处野生乔木排列随机、无 8.35 m 种植行距，林间自然林窗会被
# 误判为「需补种空地」，虚增补种面积。
# 由 `--forest-mask` 传入的掩膜多边形内的空地改判为此类，**不计入需补种**，
# 但仍保留在输出里，便于在 ArcGIS 中单独成层复核。
CLASS_UNDEVELOPED = "undeveloped"   # 非种植区（未开发林 / 非种植用途地块）

CLASS_LABEL_CN = {
    CLASS_VACANT_SLOT: "株位空缺",
    CLASS_ALLEY_GAP: "林间空隙",
    CLASS_OPEN_PATCH: "连片空地",
    CLASS_UNCERTAIN: "不确定",
    CLASS_ROAD: "道路",
    CLASS_WATER: "水体",
    CLASS_OFFICE: "办公生活区",
    CLASS_UNDEVELOPED: "非种植区",
}

# 三个给出类别的"语义锚点"（用于 UI 提示与补种建议）
CLASS_SEMANTICS = {
    CLASS_VACANT_SLOT: "单个株位上缺了一株，补种 1 株即可",
    CLASS_ALLEY_GAP: "树冠之间的正常缝隙，无需补种",
    CLASS_OPEN_PATCH: "连续多个株位空缺成片，需按网格整片补种",
    CLASS_UNCERTAIN: "证据不足，需人工核实",
    CLASS_ROAD: "园区道路或硬化路面，不可种植，无需补种",
    CLASS_WATER: "河流、水塘或积水，不可种植，无需补种",
    CLASS_OFFICE: "办公生活区、堆料场等硬化场地，不可种植，无需补种",
    CLASS_UNDEVELOPED: "非油棕种植区（未开发林等），不纳入补种范围",
}

# 不可种植类别：统计"需补种面积"时必须剔除
UNPLANTABLE_CLASSES = (CLASS_ROAD, CLASS_WATER, CLASS_OFFICE, CLASS_UNDEVELOPED)

# ---------------------------------------------------------------------------
# 「需补种」的三档口径（2026-10-17 新增）
# ---------------------------------------------------------------------------
# ⚠️ 为什么需要：原来把 4 类空地直接加总当"需补种面积"，但其中
#   · alley_gap 的语义是「树冠之间的正常缝隙，**无需补种**」
#   · uncertain 的语义是「证据不足，**需人工核实**」
#   实测 1,655 要素版里这两类合计 52,534 m²，占 headline 的 **14.0%**，
#   会让用户误以为"这 37.6 万 m² 都该补种"。故显式拆成三档输出，
#   旧的合计字段保留（下游兼容），但日志与 summary 都给出拆分。
CLASSES_DEFINITE_PLANT = (CLASS_OPEN_PATCH, CLASS_VACANT_SLOT)  # 确定需补种
CLASSES_REVIEW = (CLASS_UNCERTAIN,)                             # 待人工复核
CLASSES_NOT_NEEDED = (CLASS_ALLEY_GAP,)                         # 正常缝隙，不计入
PRIORITY_GROUPS: dict[str, tuple[str, ...]] = {
    "definite_plant": CLASSES_DEFINITE_PLANT,
    "review": CLASSES_REVIEW,
    "not_needed": CLASSES_NOT_NEEDED,
}
PRIORITY_LABEL_CN = {
    "definite_plant": "确定需补种",
    "review": "待复核（需人工核实）",
    "not_needed": "不计入（正常林间缝隙）",
}

# 估计方法标识（写进 JSON，便于回溯是哪条路线得出的网格）
METHOD_POINT_LATTICE = "point_lattice"      # 树心点阵（主力）
METHOD_FOLD_PROFILE = "folded_profile"      # 折叠投影（辅助）
METHOD_PRIOR_FALLBACK = "prior_fallback"    # 先验回落（兜底）

# 实测先验（WGR17.tif，跨 8 区中位值）
DEFAULT_PRIOR_PITCH_M = 8.45        # 种植间距（三角形边长 / 正方形边长）


# 用户给定的**设计密度**（株/公顷）。油棕园常规设计：1 ha 至多 150 株。
# 该值由用户在桌面端（Tauri）配置，用途：
#   ① 交叉校验网格估计结果 —— 估计密度若显著偏离设计值，说明拟合可能出错；
#   ② 为「株位空缺」判定提供单位格面积的独立参照。
DEFAULT_TARGET_DENSITY_PER_HA = 150.0
DEFAULT_PRIOR_DENSITY = 140.0       # 株/公顷
DEFAULT_METHOD_VERSION = "v0.2"

_SIN60 = float(np.sin(np.radians(60.0)))     # ≈0.8660254


def _derive_row_pitch(plant_pitch_m: float, triangular: bool) -> float:
    """由株距与种植模式推行距（相邻两行的垂直距离）。

    ★ 这是本模块最核心的一个几何关系，也是实测中唯一出过大错的公式。

      等边三角形（错行）种植
          株距 a、行距 h、错行偏移 a/2，三者构成直角三角形：
              a² = h² + (a/2)²
          ⟹  h = a · √(1 - 1/4) = a · √3/2 = a · sin(60°)

      正方形（对齐）种植
          h = a

    ⚠️ 反面教材：曾写成 h = a · cos(60°) = 0.5a，或 h = a · tan(60°) 之类。
       a·cos60° = 0.5a 会让行距低估一半，密度虚高一倍；
       而错行偏移写成 h·tan(60°) 会差 3 倍。两个错都会让格点整体错位，
       后果是「株位空缺」与「林间空隙」大面积互相误判。
    """
    return float(plant_pitch_m * (_SIN60 if triangular else 1.0))


# ============================================================================
# 数据结构
# ============================================================================
@dataclass
class GridModel:
    """估计出来的种植网格模型。长度单位一律是米，坐标是影像投影系（本项目=UTM 49N）。

    ── 参数化说明（这里踩过一次大坑，写清楚免得后人重犯）──────────────────
    通用点阵由「两个基矢」决定：沿行方向的位移 u、往下一行的位移 v。用三个
    标量就够：

        plant_pitch_m  沿行方向相邻两株的距离            （=|u|）
        row_pitch_m    相邻两行的**垂直距离**            （=v 在垂直行方向上的分量）
        skew_offset_m  每下一行，沿行方向错开的距离      （=v 在行方向上的分量）

    两种常见种植模式对应：
        正方形（对齐）种植：skew_offset_m = 0
        等边三角形（错行）种植：skew_offset_m = plant_pitch_m / 2
                                 row_pitch_m   = plant_pitch_m · sin(60°)

    ⚠️ 绝对不要写成 "skew_offset = row_pitch · tan(θ)"！
       等边三角形时正确系数是 1/(2·sin60°) = 0.5774，而 tan60° = 1.7321，
       差 3 倍。这个 bug 会让网格整体错位，实测后果是：株位空缺被误判成
       林间空隙、行距被低估 40%。
    ─────────────────────────────────────────────────────────────────────
    """

    # --- 网格几何：三元组，两种种植模式统一表达 ---
    plant_pitch_m: float        # 株距：沿行方向相邻两株的距离
    row_pitch_m: float          # 行距：相邻两行的垂直距离
    skew_offset_m: float        # 错行偏移：每下一行沿行方向错开的距离

    # --- 绝对位置（用于跨瓦片对齐，必须落在全局格点上）---
    origin_x_m: float           # 第 (0,0) 个格点的 UTM X
    origin_y_m: float           # 第 (0,0) 个格点的 UTM Y
    row_azimuth_deg: float      # 行方向方位角（相对 +X 轴，逆时针，0~180）

    # --- 质量与溯源 ---
    quality: float              # 置信度 0~1
    method: str                 # 见 METHOD_* 常量
    density_per_ha: float       # 反推的种植密度（株/公顷）
    node_count: int = 0         # 参与拟合的树心数（方法 A）
    nn_cv: float = 0.0          # 最近邻距变异系数（越小越规则）
    regularity: float = 0.0     # 规则度 0~1（由 nn_cv 映射而来）
    angle_conc: float = 0.0     # 位移方位角集中度 0~1
    method_version: str = DEFAULT_METHOD_VERSION
    notes: str = ""

    # --- 便捷属性 ---
    @property
    def unit_cell_area_sqm(self) -> float:
        """单位种植格面积（每株占的地面面积）。"""
        return max(self.row_pitch_m * self.plant_pitch_m, 1e-6)

    @property
    def skew_angle_deg(self) -> float:
        """错行角：基矢 u（沿行）与 v（跨行）之间的夹角，单位度。

        ⚠️ 这个值**不是** atan(skew_offset / row_pitch)。
           实测踩过：等边三角形时 atan(4.225/7.318) = 30°，
           但基矢 u 与 v 的真实夹角是 60°。两者差一倍，看着像"差不多"，
           实际会让所有下游解读全部错位。

        正确算法（由向量点积反算）：
            u = (plant_pitch, 0)                     行方向
            v = (skew_offset,  row_pitch)            跨行方向
            cos(θ) = u·v / (|u|·|v|)
                   = plant_pitch·skew_offset
                     / (plant_pitch · √(skew_offset² + row_pitch²))

        结果：正方形（skew_offset=0）→ 90°；等边三角形 → 60°。
        """
        u = np.array([self.plant_pitch_m, 0.0])
        v = np.array([self.skew_offset_m, self.row_pitch_m])
        nu, nv = float(np.linalg.norm(u)), float(np.linalg.norm(v))
        if nu < 1e-9 or nv < 1e-9:
            return 90.0
        cos_t = float(np.clip(np.dot(u, v) / (nu * nv), -1.0, 1.0))
        return float(np.degrees(np.arccos(cos_t)))

    @property
    def is_triangular(self) -> bool:
        """是否近似等边三角形（错行）种植。"""
        return self.skew_offset_m > 0.35 * self.row_pitch_m

    @property
    def pitch_m(self) -> float:
        """标称种植间距——对外汇报用的单一数字，单位米。

        ⚠️ 不要返回 √(plant × row)（几何平均）！踩过这个坑：
           等边三角形 a=9.2 m 时 plant=9.2、row=7.97，
           几何平均 = 8.56 —— 比真值小 0.64 m，看着"接近"但会误导。
           原因：三角形种植的"间距"就是边长 a（=株距），不是几何平均。

        正确语义：
            等边三角形（错行）→ 返回 plant_pitch_m（边长 a）
            正方形（对齐）    → 返回 plant_pitch_m（= row_pitch_m，两者相等）
        也就是两种情况都返回 plant_pitch_m。
        """
        return float(self.plant_pitch_m)

    @property
    def equivalent_square_pitch_m(self) -> float:
        """等效正方形边长：√(单位格面积)。按面积等效，用于密度换算。"""
        return float(np.sqrt(self.unit_cell_area_sqm))

    @property
    def is_usable(self) -> bool:
        """该网格是否可信到能用来分类。低于此值一律标 uncertain。"""
        return self.quality >= 0.15

    def node_at(self, ix: int, iy: int) -> tuple[float, float]:
        """第 (ix, iy) 个格点的 UTM 坐标。grid → xy 的正变换。"""
        a = np.radians(self.row_azimuth_deg)
        ux, uy = np.cos(a), np.sin(a)                     # 行方向单位向量
        vx, vy = -np.sin(a), np.cos(a)                    # 行间方向（垂直于行）

        # 关键：错行偏移是「沿行方向的绝对米数」，不是 row_pitch × tan(角)
        along_u = ix * self.plant_pitch_m + iy * self.skew_offset_m
        along_v = iy * self.row_pitch_m
        return (float(self.origin_x_m + along_u * ux + along_v * vx),
                float(self.origin_y_m + along_u * uy + along_v * vy))

    def xy_to_grid(self, x: float, y: float) -> tuple[float, float, float]:
        """UTM → 连续格坐标 (gx, gy) 及到最近格点的距离（米）。

        gx / gy 的整数部分 = 格点索引，小数部分 = 在格内的相对位置。
        """
        a = np.radians(self.row_azimuth_deg)
        ux, uy = np.cos(a), np.sin(a)
        vx, vy = -np.sin(a), np.cos(a)
        dx, dy = x - self.origin_x_m, y - self.origin_y_m

        # 先投到行间方向 → 行号（连续）
        gy = (dx * vx + dy * vy) / max(self.row_pitch_m, 1e-6)
        # 再投到行方向，扣掉错行偏移
        along = dx * ux + dy * uy - gy * self.skew_offset_m
        gx = along / max(self.plant_pitch_m, 1e-6)

        nx, ny = self.node_at(int(round(gx)), int(round(gy)))
        return float(gx), float(gy), float(np.hypot(x - nx, y - ny))

    def to_dict(self) -> dict[str, Any]:
        """序列化为 JSON 友好的 dict。

        ⚠️ **精度必须是 8 位小数，不能是 4 位**（2026-10-29 实测的 0.306 m 事故）

        原因：`origin_*_m` 是**第 (0,0) 格**的坐标（本幅影像只有 ~159 m），
        而 AOI 落在**第 54,090 格**附近。任何一个"从文件重建格点"的下游都要算

            x = origin_x_m + ix * plant_pitch_m + iy * skew_offset_m

        `ix ≈ 54,090` 会把 `plant_pitch_m` 的舍入误差放大 5 个数量级：
        4 dp 舍入（5e-5 m/格）× 54,090 格 ≈ **0.3 m 的刚性平移**。
        实测三个结果文件（10-14/10-15/10-16）的 δ 完全一致 `|δ|=0.3064 m`，
        方向几乎纯 +Y —— 这正是 `Δrow·iy + Δpitch·ix` 的合成。

        后果：任何从文件重建格点的下游（前端排点、导出放样、ArcGIS 属性连接、
        以及"用文件里的 grid 重跑分类"这种验证）都会偏 0.3 m（= 株距的 3.7%）。
        实测它会让"重跑分类与文件记录的一致性"从 99.93% 掉到 94.57%。

        8 dp 时同样算式的误差 ≈ 5e-9 × 54,090 ≈ 0.0003 m，足够。

        另外补 `grid_frame` 字段说明坐标框架 —— 这个框架（局部原点 + 全局整数格号）
        是 10-16 当时 `probe_frame.py` 三种假设全退化、`probe_slots.py` 输出 0 株位的
        真正原因，写进文件免得后人再猜。
        """
        d = asdict(self)
        for k, v in list(d.items()):
            if isinstance(v, float):
                d[k] = round(v, 8)
        d["pitch_m"] = round(self.pitch_m, 8)
        d["equivalent_square_pitch_m"] = round(self.equivalent_square_pitch_m, 8)
        d["unit_cell_area_sqm"] = round(self.unit_cell_area_sqm, 8)
        d["skew_angle_deg"] = round(self.skew_angle_deg, 6)
        d["is_triangular"] = bool(self.is_triangular)
        # 坐标框架声明：格点 = origin + (ix, iy) 按基矢展开，ix/iy 是**全局整数格号**
        d["grid_frame"] = "local-origin+absolute-index"
        return d

    def normalized(self, ix0: int = 0, iy0: int = 0) -> "GridModel":
        """返回原点平移到第 (ix0, iy0) 格的**等价**网格（格号相应减小）。

        用途：给下游一个"格号从 0 开始"的视图，这样 `origin + ix*pitch`
        里的 ix 只有 2~3 位数字，任何精度损失都不会被放大。

        为什么不直接改 `to_dict()` 存归一化值：`GridModel` 是全流程共用的，
        归一化会改变 `ix/iy` 的语义（缓存键、`grid_cell` 字段、跨瓦片对齐都依赖
        绝对格号）。所以只**提供一个可选视图**，由需要精度的下游显式调用。

        ⚠️ **当前没有任何调用点**（2026-10-29 加，QA 复查指出）。
        原因是 `to_dict()` 的 8 dp 精度已经把误差压到 0.45 mm（实测），
        而 `normalized()` 会改变格号语义、风险更大。留着它是为了：
          · 将来若换成 3 m 株距作物（ix≈26 万，8 dp 残差升到 1.3 mm）仍有退路；
          · 或者某个下游非要用 float32 存坐标时（float32 只有 7 位有效数字，
            会把 8 dp 的收益吃回去 —— 那时才真的需要归一化）。
        如果你要用它，**调用方必须自己维护 `ix0/iy0` 与格号的换算**。
        """
        import dataclasses

        shift_x = ix0 * self.plant_pitch_m + iy0 * self.skew_offset_m
        shift_y = iy0 * self.row_pitch_m
        return dataclasses.replace(
            self,
            origin_x_m=self.origin_x_m + shift_x,
            origin_y_m=self.origin_y_m + shift_y,
        )


@dataclass
class GapGeometry:
    """单个空地多边形的几何先验量。"""

    gap_id: str
    centroid_x: float               # UTM X
    centroid_y: float               # UTM Y
    area_sqm: float
    bbox_w: float                   # 外接矩形宽（米）
    bbox_h: float
    perimeter_m: float

    # --- 由 classify_gaps 填充 ---
    grid_gx: float = 0.0            # 连续格坐标 X
    grid_gy: float = 0.0            # 连续格坐标 Y
    node_x: float = 0.0             # 最近格点 UTM X
    node_y: float = 0.0
    node_distance_m: float = float("inf")   # 质心到最近格点距离
    in_row_distance_m: float = float("inf")  # 到行中线距离
    elongation: float = 1.0         # 长宽比（>=1，取外接矩形）
    roundness: float = 0.0          # 4πA/P²，正圆=1
    coverage_ratio: float = 0.0     # 面积 / 单位格面积
    extra: dict[str, Any] = field(default_factory=dict)


# ============================================================================
# 基础工具
# ============================================================================
def _remove_duplicate_points(pts: np.ndarray, min_dist_m: float) -> np.ndarray:
    """把距离小于 min_dist_m 的点合并（保留先出现的）。"""
    if len(pts) < 2:
        return pts
    try:
        from scipy.spatial import cKDTree
    except ImportError:  # 退化实现
        keep = [0]
        for i in range(1, len(pts)):
            d = np.hypot(pts[keep, 0] - pts[i, 0], pts[keep, 1] - pts[i, 1])
            if d.min() >= min_dist_m:
                keep.append(i)
        return pts[keep]

    tree = cKDTree(pts)
    pairs = sorted(tree.query_pairs(min_dist_m))
    drop: set[int] = set()
    for i, j in pairs:
        if i in drop or j in drop:
            continue
        drop.add(int(j))
    return np.array([p for k, p in enumerate(pts) if k not in drop])


def detect_tree_centers(rgb: np.ndarray, valid: np.ndarray, px_m: float,
                        sigma_m: float = 1.2,
                        min_tree_gap_m: float = 3.0,
                        peak_pct: float = 70.0) -> np.ndarray:
    """在影像上找树心（树冠中心）的像素坐标。

    做法（实测有效）：
      1. 算 ExG（超绿指数）= 2G - R - B —— 植被比裸土亮
      2. 高斯平滑（sigma≈1.2 m）—— 抹平羽叶内的小起伏，让每株只剩一个峰
      3. 局部极大（窗口半径 = 最小株距/2）—— 每株树冠中心一个峰
      4. 取 ExG 高于 pct 分位的峰 —— 滤掉裸土上的假峰

    返回 (N, 2) 数组，单位：像素 (x, y)。找不到返回空数组。
    """
    from scipy.ndimage import gaussian_filter, maximum_filter

    if rgb.ndim != 3 or rgb.shape[2] < 3:
        return np.empty((0, 2), dtype=np.float64)

    r = rgb[:, :, 0].astype(np.float32)
    g = rgb[:, :, 1].astype(np.float32)
    b = rgb[:, :, 2].astype(np.float32)
    exg = 2.0 * g - r - b

    sigma_px = max(float(sigma_m / max(px_m, 1e-6)), 1.0)
    sm = gaussian_filter(exg, sigma=sigma_px)

    w_px = max(int(round(min_tree_gap_m / 2.0 / max(px_m, 1e-6))), 1)
    peak = maximum_filter(sm, size=w_px * 2 + 1)

    thr = float(np.percentile(sm, peak_pct))
    mask = (sm >= peak) & (sm > thr)
    if valid is not None:
        mask &= valid

    ys, xs = np.nonzero(mask)
    if ys.size == 0:
        return np.empty((0, 2), dtype=np.float64)

    pts = np.stack([xs.astype(np.float64), ys.astype(np.float64)], axis=1)
    if len(pts) > 1:
        pts = _remove_duplicate_points(pts, min_tree_gap_m / max(px_m, 1e-6))
    return pts


# ============================================================================
# 方法 A：树心点阵分析（主力）
# ============================================================================
def _nn_stats(pts: np.ndarray) -> tuple[np.ndarray, float, float]:
    """最近邻距：返回 (最近邻距数组, 中位, 变异系数)。

    变异系数 CV 是判断「是否规则种植」最有力的单一指标：
      规则网格 / 人工林    CV ≈ 0.00 ~ 0.20
      随机（泊松）点过程   CV ≈ 0.52
      聚集分布             CV > 0.8
    """
    if len(pts) < 5:
        return np.array([]), float("nan"), float("nan")
    try:
        from scipy.spatial import cKDTree
        tree = cKDTree(pts)
        d, _ = tree.query(pts, k=2)
        nn = d[:, 1]
    except ImportError:
        nn = np.array([
            float(np.partition(np.hypot(pts[:, 0] - p[0], pts[:, 1] - p[1]), 1)[1])
            for p in pts
        ])
    nn = nn[np.isfinite(nn)]
    if nn.size == 0:
        return np.array([]), float("nan"), float("nan")
    med = float(np.median(nn))
    cv = float(nn.std() / nn.mean()) if nn.mean() > 0 else float("nan")
    return nn, med, cv


def _shift_direction_stats(pts: np.ndarray, max_r_m: float = 14.0,
                           k: int = 12) -> tuple[list[tuple[float, float, float]], float]:
    """分析点对的位移向量，找出种植方向与间距。

    返回 (候选列表, 方位集中度)。候选列表元素 = (位移长度 m, 方位角 deg, 集中度)。

    原理：规则种植时，每个点的邻居位移会聚集在有限几个方向上（正方形=2 个
    正交方向；等边三角形=3 个方向，两两相差 60°）。随机分布则方位角均匀铺开。

    ⚠️ 陷阱（实测踩过）：等边三角形种植时，一个格点的最近邻有 6 个，其位移
    长度有 **两种**：a（同行的 2 个）和 a（相邻行的 4 个，长度也是 a）。
    但「相邻两行的格点」之间的位移是 a/2 吗？不是——相邻行错开 a/2，
    所以格点 (0,0) 到上一行最近点的位移长度正好 = a。而 a/2 那种「半格」
    位移只出现在「行内相邻株的中点」上，不是格点位移。
    真正要排除的是 **因树冠粘连造成的短位移**（< 0.6×先验间距）。
    """
    if len(pts) < 10:
        return [], 0.0
    try:
        from scipy.spatial import cKDTree
    except ImportError:
        return [], 0.0

    tree = cKDTree(pts)
    kk = min(k, len(pts))
    dist, idx = tree.query(pts, k=kk)

    vecs: list[np.ndarray] = []
    for i in range(len(pts)):
        for j in range(1, kk):
            if idx[i, j] < 0 or dist[i, j] > max_r_m:
                continue
            d = pts[idx[i, j]] - pts[i]
            # 只保留半平面，避免同一对算两次
            if d[1] < 0 or (d[1] == 0 and d[0] < 0):
                continue
            vecs.append(d)
    if len(vecs) < 15:
        return [], 0.0

    V = np.array(vecs)
    L = np.hypot(V[:, 0], V[:, 1])

    # --- 长度分箱，找聚集的长度（= 网格间距）---
    bin_w = 0.25
    edges = np.arange(0.0, max_r_m + bin_w, bin_w)
    hist, _ = np.histogram(L, bins=edges)
    cands: list[tuple[float, float, float]] = []
    for i in range(1, len(hist) - 1):
        if hist[i] < 2 or hist[i] < hist[i - 1] or hist[i] < hist[i + 1]:
            continue
        lp = float(edges[i] + bin_w / 2)
        sel = (L > lp - 0.4) & (L < lp + 0.4)
        sub = V[sel]
        if len(sub) < 2:
            continue
        # 方位角（0~180，因为方向无正负）
        ang = np.degrees(np.arctan2(sub[:, 1], sub[:, 0])) % 180.0
        h, e = np.histogram(ang, bins=36, range=(0.0, 180.0))
        ai = int(np.argmax(h))
        conc = float(h[ai] / max(len(sub), 1))
        cands.append((lp, float(e[ai] + 2.5), conc))

    if not cands:
        return [], 0.0

    # 按「长度 × 集中度」排序（更看重集中度——那是"规则性"的直接证据）
    cands.sort(key=lambda t: -(t[2] * 2.0 + t[0] / max_r_m * 0.5))
    overall_conc = float(np.mean([c for _, _, c in cands[:3]]))
    return cands[:6], overall_conc


def _pick_lattice_basis(pts: np.ndarray, cands: list[tuple[float, float, float]],
                        nn_med: float, prior_pitch_m: float,
                        max_r_m: float) -> tuple[float, float, float] | None:
    """从位移候选中挑出真正的两个晶格基矢。

    ⚠️ 这一步是整套算法的关键，也是最容易出错的地方。踩过的坑（都有实测数据）：

    坑 1｜「直方图伪峰」。位移长度是连续量，但点阵只产生**离散**的位移长度：
          等边三角形点阵的位移谱实测为
              L = a      (6 个最近邻，方位角 0°/60°/120°)
              L = √3·a   (6 个次近邻，方位角 30°/90°/150°)
              L = 2a     (6 个，方位角回到 0°/60°/120°)
          如果按 0.25 m 固定分箱统计长度直方图，一簇本该完整的位移会被拆到
          相邻两三个箱里，每个箱的样本数都不高，于是"某个噪声长度"反而胜出。
          → **不要用直方图峰值当候选**。改成：直接考察「最近邻距 nn_med」附近
            的位移，并把候选限制在 [0.75·nn_med, 1.6·nn_med] 的窄窗口里。

    坑 2｜两基矢长度相等时无法用"长短"区分。等边三角形 a1=a2=a 夹角 60°；
          正方形 a1=a2=a 夹角 90°。**只能靠夹角区分**。

    坑 3｜方位角集中度随样本数波动。样本少时某箱 100% 集中也可能是巧合。
          → 要求候选至少有 3 个样本，且集中度是「三方向之和」而非「单箱占比」。
          对三角形种植，正确的判据是：在 0°/60°/120° 三处**都有**位移，
          而不是某一处特别集中。

    返回 (基矢长度1, 基矢长度2, 夹角) 或 None。
    """
    # --- 找主峰对应的那一圈位移（用先验间距当锚点，比"最短的圈"稳得多）---
    nn_win = _shortest_shift_cluster(pts, max_r_m, expected_pitch_m=prior_pitch_m)
    if nn_win is not None:
        L_short, angles = nn_win
        # 三角形：三个方位角，两两差 ≈60°
        tri = _triangular_fit(angles)
        if tri is not None:
            return (L_short, L_short, 60.0)
        # 正方形：两个正交方位角
        sq = _orthogonal_fit(angles)
        if sq is not None:
            return (L_short, L_short, 90.0)
        # 单方向（可能是行距，另一方向信号弱）：给一个不完美的结果
        if angles.size >= 3:
            return (L_short, L_short, 90.0)

    # --- 兜底：退回直方图候选（可能不准，但至少不会崩）---
    if len(cands) < 2:
        return None
    lo = max(0.75 * nn_med, 0.6 * prior_pitch_m)
    good = [c for c in cands if c[0] >= lo] or cands
    best = None
    for i in range(len(good)):
        for j in range(i + 1, len(good)):
            l1, a1, c1 = good[i]
            l2, a2, c2 = good[j]
            da = abs(((a2 - a1) % 180.0))
            ang = min(da, 180.0 - da)
            s60 = max(0.0, 1.0 - abs(ang - 60.0) / 20.0)
            s90 = max(0.0, 1.0 - abs(ang - 90.0) / 20.0)
            ang_score = max(s60, s90)
            if ang_score <= 0.0:
                continue
            len_score = 1.0 - min(1.0, (abs(l1 - prior_pitch_m) + abs(l2 - prior_pitch_m))
                                  / (2 * prior_pitch_m))
            score = 0.45 * ang_score + 0.35 * len_score + 0.20 * (c1 + c2) / 2.0
            if best is None or score > best[0]:
                best = (score, l1, l2, ang)
    if best is None:
        l, a, c = max(good, key=lambda t: t[0] * (0.5 + t[2]))
        return (l, l, 90.0)
    _, l1, l2, ang = best
    return (l1, l2, ang)


def _candidate_azimuths(pts: np.ndarray, pitch: float, max_r_m: float,
                        expected_pitch_m: float | None = None,
                        top_k: int = 6) -> list[float]:
    """列出「可能的行方向」候选方位角。

    对等边三角形点阵，主峰圈位移的方位角会聚成 {0°, 60°, 120°} 三个峰——
    它们**在几何上完全等价**（任选一个当"行方向"、另一个当"跨行方向"，
    都能张成同一个点阵，只是基矢的标号不同）。所以不能靠"哪个峰高"
    来选，只能靠下游的拟合误差来选（见 _select_azimuth_by_fit）。

    ⚠️ 真实影像上方位角分布是「主峰 + 次峰」结构：主峰在 0°/60°/120°、
       次峰在 30°/90°/150°（那是 √3a 圈的位移方向）。因为次近邻圈也有
       不少样本，次峰有时会被选成"候选"，所以候选要放宽到 top 6，
       并且必须包含 0° 和 90°（人工种植通常按罗盘拉线）。

    返回按峰值强度排序的候选方位角列表（最多 top_k 个）。
    """
    cl = _shortest_shift_cluster(pts, max_r_m, expected_pitch_m=expected_pitch_m)
    if cl is None:
        return [0.0, 90.0]
    _, angles = cl
    if angles.size < 4:
        return [0.0, 90.0]

    nb = 90                                   # 2° 一箱
    h, edges = np.histogram(angles, bins=nb, range=(0.0, 180.0))
    ctr = edges[:-1] + 90.0 / nb

    # ±20° 邻域平滑，抗抖动
    smooth = np.zeros(nb)
    for i in range(nb):
        d = np.abs(ctr - ctr[i])
        d = np.minimum(d, 180.0 - d)
        smooth[i] = h[d <= 20.0].sum()

    # 找局部极大，按强度排序
    peaks: list[tuple[float, float]] = []
    for i in range(nb):
        prev = smooth[(i - 1) % nb]
        nxt = smooth[(i + 1) % nb]
        if smooth[i] >= prev and smooth[i] >= nxt and smooth[i] > 0:
            peaks.append((float(smooth[i]), float(ctr[i])))
    if not peaks:
        return [0.0, 90.0]

    peaks.sort(key=lambda t: -t[0])
    # 合并挨得太近的峰（<15°）
    out: list[float] = []
    for _, ang in peaks:
        if all(min(abs(ang - o), 180.0 - abs(ang - o)) >= 15.0 for o in out):
            out.append(float(ang))
        if len(out) >= top_k:
            break
    # 保证 0° 与 90° 一定在候选里（人工种植按罗盘拉线是强先验，
    # 且这两条路能保证跨瓦片结果一致）
    for axis in (0.0, 90.0):
        if all(min(abs(axis - o), 180.0 - abs(axis - o)) >= 8.0 for o in out):
            out.append(axis)
    return out if out else [0.0, 90.0]


def _residual_after_phase_align(P: np.ndarray, plant: float, row: float,
                                skew_off: float, ang_deg: float
                                ) -> tuple[float, tuple[float, float]]:
    """给定方位角，先对齐相位再算「到最近格点」的残差中位数。

    ★ 为什么必须先对齐相位
      早期版本直接用点的均值当原点，然后算 `gx - round(gx)` 的残差。
      实测发现：即使网格参数完全正确，残差也会高达 3 m。原因是
      **有限点集的均值不是格点**——实测该偏移恒为 (+0.333, +0.167) 个格，
      也就是 2.8 m 和 1.2 m 的系统偏差。它看起来像"拟合很差"，
      其实只是原点没对齐。

      修法：先把所有点的格坐标小数部分用圆均值求出相位，用相位平移之后再
      算残差。这样残差只反映"网格结构是否真的匹配"，与原点无关。

    返回 (残差中位数 m, (相位x, 相位y))。
    """
    a = np.radians(ang_deg)
    ux, uy = np.cos(a), np.sin(a)
    vx, vy = -np.sin(a), np.cos(a)

    cx0, cy0 = float(P[:, 0].mean()), float(P[:, 1].mean())
    dx, dy = P[:, 0] - cx0, P[:, 1] - cy0

    gy = (dx * vx + dy * vy) / max(row, 1e-6)
    gx = (dx * ux + dy * uy - gy * skew_off) / max(plant, 1e-6)

    def _circ(frac: np.ndarray) -> float:
        th = 2.0 * np.pi * frac
        c, s = float(np.cos(th).mean()), float(np.sin(th).mean())
        if abs(c) < 1e-12 and abs(s) < 1e-12:
            return 0.0
        p = float(np.arctan2(s, c) / (2.0 * np.pi))
        return float(p - np.round(p))

    ph_x = _circ(gx - np.round(gx))
    ph_y = _circ(gy - np.round(gy))

    # 相位平移后再算残差
    ex = (gx - ph_x - np.round(gx - ph_x)) * plant
    ey = (gy - ph_y - np.round(gy - ph_y)) * row
    err = float(np.median(np.hypot(ex, ey)))
    return err, (ph_x, ph_y)


def _select_azimuth_by_fit(pts: np.ndarray, cand_azimuths: list[float],
                           plant: float, row: float, skew_off: float
                           ) -> tuple[float, float]:
    """在候选方位角里，选让「点阵还原误差」最小的那个。

    ★ 判据的来历
      三角形点阵的三个方向（0°/60°/120°）在数学上**张成同一个点阵**，
      所以理论上拟合残差一样小，无法区分。但实测中它们仍有差别，因为：
        1. 树心检测有像素级抖动，方向不同时抖动被投影到网格的敏感度不同
        2. 有限窗口的截断效应

      于是判据是（残差已做相位对齐，见 _residual_after_phase_align）：
        对每个候选方位角 θ：算残差中位数，取最小的。

      若多个候选的残差都极小（< 0.5 m，说明确实等价），则**优先取最接近
      坐标轴的那个**——这样跨瓦片、跨影像的结果更稳定一致，也更符合
      "人工种植通常按罗盘方向拉线"的常识。

    返回 (最佳方位角, 该方位角下的中位拟合误差)。
    """
    if not cand_azimuths:
        return 0.0, float("inf")

    scored: list[tuple[float, float]] = []       # (err, ang)
    for ang in cand_azimuths:
        err, _ = _residual_after_phase_align(pts, plant, row, skew_off, ang)
        scored.append((err, float(ang)))
    scored.sort(key=lambda t: t[0])

    best_err, best_ang = scored[0]
    ties = [ang for err, ang in scored if err <= max(best_err * 1.5, best_err + 0.25)]
    if len(ties) > 1:
        # 多个候选等价 → 取最接近坐标轴（0° 或 90°）的
        best_ang = min(ties, key=lambda a: min(abs(a), abs(a - 90.0),
                                               abs(a - 180.0)))
    return float(best_ang), float(best_err)


def _shortest_shift_cluster(pts: np.ndarray, max_r_m: float,
                            k: int = 14,
                            expected_pitch_m: float | None = None
                            ) -> tuple[float, np.ndarray] | None:
    """找出「最近邻那一圈」的位移长度与方位角集合。

    ⚠️ 判据的演进（这里是踩坑最多的地方，务必看清）

      【错法 1】取 `[0.95·Lmin, 1.25·Lmin]`（最初的"最短一圈"）
         人造规整点阵上完美，但**真实影像上会失败**。实测 WGR17 的
         位移长度直方图是这样（0.5 m 一箱）：
             4.0-4.5m : 4        ← Lmin，纯噪声
             6.5-7.5m : 150      ← 冠层粘连造成的短位移
             8.0-9.0m : 632      ← ★ 真正的种植间距（主峰）
            13.0-16.0m: 1100     ← 次近邻圈（√3·a 与 2a）
         用 Lmin×1.25 会锁死在 4~5 m 那一小撮噪声上，间距被低估一半。

      【错法 2】取直方图最大值
         次近邻圈（13~16 m）的样本数往往比主峰还多（因为 k 近邻里外层点多），
         会误锁到 2a 或 √3a 上。

      【正解】锁定「主峰」的标准：
         - 先把位移长度做成细直方图（0.1 m 一箱，比 0.25/0.5 都细，
           这样主峰不会被摊薄）
         - 用 ±2 箱邻域平滑找出所有局部极大
         - **在 [0.6·prior, 1.5·prior] 区间内**选计数最大的局部极大。
           这一步是关键：先验间距 8.45 m 是我们唯一可靠的锚点，
           用它圈出「哪个峰才是真间距」，而不是靠"最短"或"最高"。
         - 若先验不可用（None），退而取「第一个显著峰」（计数 >
           全局最大值的 30% 且长度最短的那个）

    返回 (间距估计 m, 该圈位移的方位角数组)。
    """
    if len(pts) < 10:
        return None
    try:
        from scipy.spatial import cKDTree
    except ImportError:
        return None

    tree = cKDTree(pts)
    kk = min(k, len(pts))
    dist, idx = tree.query(pts, k=kk)

    lens: list[float] = []
    angs: list[float] = []
    for i in range(len(pts)):
        for j in range(1, kk):
            if idx[i, j] < 0 or dist[i, j] > max_r_m or dist[i, j] <= 0:
                continue
            d = pts[idx[i, j]] - pts[i]
            lens.append(float(dist[i, j]))
            angs.append(float(np.degrees(np.arctan2(d[1], d[0])) % 180.0))

    if len(lens) < 12:
        return None
    L = np.array(lens)
    A = np.array(angs)

    # --- 细直方图找局部极大 ---
    bin_w = 0.1
    edges = np.arange(0.0, max_r_m + bin_w, bin_w)
    h, _ = np.histogram(L, bins=edges)
    ctr = edges[:-1] + bin_w / 2.0
    if h.max() <= 0:
        return None

    # ±2 箱平滑（=±0.2 m），让主峰连续
    sm = np.convolve(h.astype(float), np.ones(5) / 5.0, mode="same")

    peaks: list[tuple[float, float]] = []      # (count, length)
    for i in range(1, len(sm) - 1):
        if sm[i] >= sm[i - 1] and sm[i] >= sm[i + 1] and sm[i] > 0:
            peaks.append((float(sm[i]), float(ctr[i])))
    if not peaks:
        return None

    if expected_pitch_m and expected_pitch_m > 0:
        # 在先验附近找主峰（这是首选路线）
        lo, hi = 0.60 * expected_pitch_m, 1.50 * expected_pitch_m
        near = [p for p in peaks if lo <= p[1] <= hi]
        if near:
            _, pitch = max(near, key=lambda t: t[0])
        else:
            # 先验附近没有峰：说明实际间距与先验差很多，退化到"第一个显著峰"
            smax = max(p[0] for p in peaks)
            sig = [p for p in peaks if p[0] > 0.30 * smax]
            _, pitch = min(sig, key=lambda t: t[1]) if sig else \
                max(peaks, key=lambda t: t[0])
    else:
        smax = max(p[0] for p in peaks)
        sig = [p for p in peaks if p[0] > 0.30 * smax]
        _, pitch = min(sig, key=lambda t: t[1]) if sig else \
            max(peaks, key=lambda t: t[0])

    # --- 取该间距附近的位移，作为"最近邻圈" ---
    sel = (L >= pitch * 0.82) & (L <= pitch * 1.18)
    if sel.sum() < 6:
        # 放宽一次
        sel = (L >= pitch * 0.70) & (L <= pitch * 1.35)
    if sel.sum() < 4:
        return None
    return float(pitch), A[sel]


def _triangular_fit(angles: np.ndarray) -> float | None:
    """检验方位角是否聚成 3 个方向、两两相差 ≈60°（等边三角形种植）。

    返回拟合的基准方位角（度）；不满足返回 None。
    """
    return _multi_direction_fit(angles, n_dir=3, expect_gap=60.0, tol=22.0)


def _orthogonal_fit(angles: np.ndarray) -> float | None:
    """检验方位角是否聚成 2 个正交方向（正方形/矩形种植）。"""
    return _multi_direction_fit(angles, n_dir=2, expect_gap=90.0, tol=25.0)


def _multi_direction_fit(angles: np.ndarray, n_dir: int, expect_gap: float,
                         tol: float) -> float | None:
    """通用：在 [0,180) 上找 n_dir 个间隔为 expect_gap 的方向，看是否覆盖了大部分样本。

    判据（缺一不可）：
      1. 拟合出的每个方向附近都要有足够样本（≥ 总样本的 12%）
      2. 落在这些方向 ±tol° 内的样本合计要 ≥ 总样本的 55%
    """
    if angles.size < 8:
        return None
    n = angles.size
    best: tuple[float, float] | None = None      # (coverage, base_angle)

    for base in np.arange(0.0, 180.0, 1.0):
        dirs = [(base + k * expect_gap) % 180.0 for k in range(n_dir)]
        # 每个方向的样本数
        counts = []
        covered = np.zeros(n, dtype=bool)
        for d in dirs:
            diff = np.abs(angles - d)
            diff = np.minimum(diff, 180.0 - diff)
            m = diff <= tol
            counts.append(int(m.sum()))
            covered |= m
        if min(counts) < max(3, int(0.12 * n)):
            continue
        cov = float(covered.mean())
        if best is None or cov > best[0]:
            best = (cov, float(base))

    if best is None:
        return None
    cov, base = best
    return base if cov >= 0.55 else None


def _match_basis_angles(cands: list[tuple[float, float, float]],
                        l1: float, l2: float, ang: float
                        ) -> tuple[float, float] | None:
    """把 _pick_lattice_basis 返回的两个长度还原成它们的方位角。

    只在候选里找长度匹配的项（容差 0.3 m），要求找到两项且方位角差 ≈ ang。
    注意：当 l1 == l2（三角形/正方形两基矢等长）时，这个方法无法用长度区分，
    此时返回 None，由调用方按 ang 自行决定 skew。
    """
    if abs(l1 - l2) < 0.3:
        return None
    m1 = [c for c in cands if abs(c[0] - l1) < 0.35]
    m2 = [c for c in cands if abs(c[0] - l2) < 0.35]
    if not m1 or not m2:
        return None
    for c1 in m1:
        for c2 in m2:
            da = abs(((c2[1] - c1[1]) % 180.0))
            a = min(da, 180.0 - da)
            if abs(a - ang) < 8.0:
                pair = sorted([c1[1], c2[1]])
                return float(pair[0]), float(pair[1])
    return None


def _grid_from_point_lattice(pts_px: np.ndarray, px_m: float, affine,
                             prior_pitch_m: float) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """方法 A 主体：从树心点阵反推网格参数。

    返回 (网格参数字典 | None, 诊断字典)。
    """
    diag: dict[str, Any] = {"method": METHOD_POINT_LATTICE}
    if len(pts_px) < 12:
        diag["reason"] = f"树心太少（{len(pts_px)} < 12）"
        return None, diag

    # 换算到投影系米制坐标（这样所有距离都有物理意义）
    pts = pts_px * px_m
    nn, nn_med, nn_cv = _nn_stats(pts)
    diag.update({"node_count": int(len(pts)), "nn_median_m": float(nn_med), "nn_cv": float(nn_cv)})

    if not np.isfinite(nn_med) or nn_med < 1.0:
        diag["reason"] = "最近邻距异常"
        return None, diag

    # 规则度映射：CV=0 → 1.0，CV=0.52（泊松）→ 0.0
    regularity = float(np.clip(1.0 - nn_cv / 0.52, 0.0, 1.0))
    diag["regularity"] = regularity

    # --- 种植方向 ---
    max_r = float(np.clip(nn_med * 2.2, 6.0, 15.0))
    cands, ang_conc = _shift_direction_stats(pts, max_r_m=max_r)
    diag["angle_conc"] = ang_conc
    diag["shift_candidates"] = [(round(l, 2), round(a, 1), round(c, 3)) for l, a, c in cands]

    basis = _pick_lattice_basis(pts, cands, nn_med, prior_pitch_m, max_r) if cands else None

    if basis is not None:
        l1, l2, ang = basis
        # 基矢长度取平均（三角形/正方形时两者相等）
        plant = float((l1 + l2) / 2.0)
        # 三角形 or 正方形：由夹角拟合结果决定
        triangular = abs(ang - 60.0) <= 22.0
        # 由 plant + 模式反推行距与错行偏移（这是本模块最核心的两个公式）
        row = _derive_row_pitch(plant, triangular)
        skew_off = plant / 2.0 if triangular else 0.0

        # 行方向：列出候选方位角，再用「拟合误差最小」原则挑一个
        # （三角形点阵的三个方向几何等价，只能靠拟合误差区分，见函数注释）
        cand_az = _candidate_azimuths(pts, plant, max_r,
                                      expected_pitch_m=prior_pitch_m)
        row_az, fit_err = _select_azimuth_by_fit(pts, cand_az, plant, row, skew_off)
        diag["basis"] = {"len1": round(l1, 3), "len2": round(l2, 3),
                         "angle_deg": round(ang, 2), "triangular": triangular,
                         "row_azimuth_deg": round(row_az, 2),
                         "candidate_azimuths": [round(a, 1) for a in cand_az],
                         "fit_error_m": round(fit_err, 3)}
    else:
        # 位移方向不可用，退回按最近邻距直接推网格（假设三角形）
        plant = nn_med / _SIN60 if nn_med < prior_pitch_m else nn_med
        row = _derive_row_pitch(plant, True)
        skew_off = plant / 2.0
        row_az = 0.0
        fit_err = float("nan")
        diag["reason"] = "位移方向不可用，按最近邻距 + 三角形假设推网格"

    # --- 密度交叉校验：树心密度应当能独立解释这个网格 ---
    if len(pts) >= 20:
        # 用最近邻距估点密度：等边三角形密度 = 1/(sin60·a²)，正方形 = 1/a²
        dens_from_nn = 1e4 / (_SIN60 * nn_med ** 2)
    else:
        dens_from_nn = float("nan")

    unit_area = max(plant * row, 1e-6)
    dens_from_grid = 1e4 / unit_area

    diag["density_from_nn"] = float(dens_from_nn)
    diag["density_from_grid"] = float(dens_from_grid)

    # 质量：规则度为主，方向集中度、点数为辅
    count_factor = float(np.clip(len(pts) / 60.0, 0.0, 1.0))
    quality = float(np.clip(0.62 * regularity + 0.26 * ang_conc * 3.0
                            + 0.12 * count_factor, 0.0, 1.0))

    # --- 绝对原点：用「全体树心格坐标小数部分的圆均值」定相位 ---
    # ⚠️ 不要用"某一个树心"或"点均值"来当原点（两种错法都踩过）：
    #    单点受噪声/粘连影响；而**有限点集的均值本身不是格点**——实测
    #    该偏移恒为 (+0.333, +0.167) 个格（≈2.8 m / 1.2 m），
    #    用它当基准会让所有空地看起来都"离格点很远"，全部退化成 uncertain。
    #    正确做法：求全体格坐标相位（小数部分）的圆均值。
    #    这里直接复用 _residual_after_phase_align，保证与方位角选择
    #    用的是同一套相位定义——两处若各写一套，会互相抵消成错误结果。
    _, (ph_x, ph_y) = _residual_after_phase_align(pts, plant, row, skew_off, row_az)
    diag["phase"] = [round(float(ph_x), 4), round(float(ph_y), 4)]

    a = np.radians(row_az)
    ux, uy = np.cos(a), np.sin(a)
    vx, vy = -np.sin(a), np.cos(a)
    cx0, cy0 = float(pts[:, 0].mean()), float(pts[:, 1].mean())

    # 把临时原点平移到「相位归零」的位置 + 加上窗口左上角的投影系坐标
    origin_x = cx0 + ph_x * plant * ux + ph_y * row * vx + float(affine.c)
    origin_y = cy0 + ph_x * plant * uy + ph_y * row * vy + float(affine.f)

    params = {
        "plant_pitch_m": float(plant),
        "row_pitch_m": float(row),
        "skew_offset_m": float(skew_off),
        "origin_x_m": float(origin_x),
        "origin_y_m": float(origin_y),
        "row_azimuth_deg": float(row_az % 180.0),
        "quality": quality,
        "method": METHOD_POINT_LATTICE,
        "density_per_ha": float(dens_from_grid),
        "node_count": int(len(pts)),
        "nn_cv": float(nn_cv),
        "regularity": regularity,
        "angle_conc": float(ang_conc),
    }
    return params, diag


# ============================================================================
# 方法 B：折叠投影（辅助）
# ============================================================================
def _fold_score(profile: np.ndarray, period_px: float) -> float:
    """把一维曲线按 period 折叠后，看波形有多"尖"（越尖说明周期越真）。"""
    n = profile.size
    bins = int(round(period_px))
    if bins < 2 or n < bins * 3:
        return 0.0
    x = profile.astype(np.float64)
    x = x - x.mean()
    sd = x.std()
    if sd < 1e-9:
        return 0.0
    idx = np.mod(np.arange(n), bins)
    cnt = np.bincount(idx, minlength=bins).astype(np.float64)
    cnt[cnt == 0] = 1.0
    folded = np.bincount(idx, weights=x, minlength=bins) / cnt
    return float(folded.std() / sd)


def _fold_score_baseline(profile: np.ndarray, px_m: float,
                         lo_m: float, hi_m: float,
                         n_trials: int = 24, seed: int = 0) -> float:
    """给折叠峰度算一个「随机基线」——用于判断真峰的显著性。

    ⚠️ 这一步不能省。早期版本直接用一个固定的 0.35 当门槛，结果：
      - 人造规整园（CV≈0）真峰 ≈ 0.5~0.7，能通过
      - 真实粘连影像假峰 ≈ 0.2~0.32，也能勉强通过 → 误报
    正确做法：随机挑 n_trials 个长度，取它们的折叠峰度最大值当基线。
    真峰必须显著超过「随机长度的最好成绩」才算真周期。
    """
    n = profile.size
    if n < 64:
        return 0.0
    rng = np.random.default_rng(seed)
    trials = []
    for _ in range(n_trials):
        p_m = float(rng.uniform(lo_m, hi_m))
        s = _fold_score(profile, p_m / px_m)
        if s > 0:
            trials.append(s)
    if not trials:
        return 0.0
    return float(np.percentile(trials, 90))


def _grid_from_profiles(canopy: np.ndarray, affine, px_m: float,
                        prior_pitch_m: float) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    """方法 B：沿 X / Y 做投影，用折叠方差扫描周期。

    ⚠️ 这个方法在「冠层高度粘连」的影像上基本不可靠（本项目实测冠层 79%，
       自相关完全看不到周期峰）。它的定位是**兜底**：只在方法 A（树心点阵）
       拿不到足够树心时作为备选，且必须通过随机基线显著性检验。
    """
    diag: dict[str, Any] = {"method": METHOD_FOLD_PROFILE}
    col_prof = canopy.sum(axis=0).astype(np.float64)
    row_prof = canopy.sum(axis=1).astype(np.float64)

    lo, hi = max(3.0, prior_pitch_m * 0.55), prior_pitch_m * 1.9
    scan = np.arange(lo, hi, 0.05)

    best: list[tuple[float, float, str, float]] = []   # period, score, axis, baseline
    for name, prof in (("x", col_prof), ("y", row_prof)):
        scored = [(float(p), _fold_score(prof, p / px_m)) for p in scan]
        scored.sort(key=lambda t: -t[1])
        if not scored:
            continue
        base = _fold_score_baseline(prof, px_m, lo, hi)
        best.append((scored[0][0], scored[0][1], name, base))

    if not best:
        diag["reason"] = "投影曲线无有效周期"
        return None, diag

    best.sort(key=lambda t: -t[1])
    p1, s1, n1, b1 = best[0]
    diag["profiles"] = [{"axis": n, "period_m": round(p, 3), "score": round(s, 4),
                         "baseline": round(b, 4), "ratio": round(s / max(b, 1e-6), 3)}
                        for p, s, n, b in best]

    # 显著性判据：真峰必须是随机基线的 1.6 倍以上，且绝对分数过 0.40
    ratio = s1 / max(b1, 1e-6)
    if s1 < 0.40 or ratio < 1.6:
        diag["reason"] = (f"折叠峰度 {s1:.3f}（随机基线 {b1:.3f}，比值 {ratio:.2f}）"
                          f"未达显著判据（需 ≥0.40 且比值 ≥1.6）。"
                          f"这是冠层粘连影像的典型表现——投影法不可靠，"
                          f"应依赖树心点阵（方法 A）")
        return None, diag

    # 用第二个方向定另一个基矢（这里只取周期值，模式由下面统一判定）
    if len(best) >= 2 and best[1][2] != n1:
        p2 = best[1][0]
    else:
        p2 = p1

    # 两个方向的周期都拿到后，按「较大的是株距、较小的是行距」组装。
    # 注意：投影法拿到的周期是「沿 X / 沿 Y 的重复距离」，与种植几何的对应
    # 关系取决于行方向，这里只能做保守假设（行方向 = X 轴），所以该方法
    # 的置信度上限被压到 0.60，低于点阵法。
    if n1 == "x":
        plant, row = p1, p2
    else:
        plant, row = p2, p1
    if plant < row:
        plant, row = row, plant
    # 若两方向周期差异不大，按等边三角形解释（错行）；否则按正方形
    triangular = abs(plant - row * (_SIN60 ** -1)) < 0.15 * plant
    if triangular:
        row = _derive_row_pitch(plant, True)
        skew_off = plant / 2.0
    else:
        row = plant
        skew_off = 0.0

    quality = float(np.clip(0.30 * min(ratio / 2.0, 1.0) + 0.25, 0.0, 0.60))
    unit = max(plant * row, 1e-6)

    params = {
        "plant_pitch_m": float(plant),
        "row_pitch_m": float(row),
        "skew_offset_m": float(skew_off),
        "origin_x_m": float(affine.c),
        "origin_y_m": float(affine.f),
        "row_azimuth_deg": 0.0,
        "quality": quality,
        "method": METHOD_FOLD_PROFILE,
        "density_per_ha": float(1e4 / unit),
        "node_count": 0,
        "nn_cv": float("nan"),
        "regularity": 0.0,
        "angle_conc": 0.0,
        "reason": f"折叠投影法（显著性 {s1:.3f} vs 基线 {b1:.3f}），"
                  f"该方法在粘连冠层上精度有限，建议对照点阵法结果",
    }
    return params, diag


# ============================================================================
# 主入口：估计网格（三方法融合）
# ============================================================================
def estimate_grid(canopy: np.ndarray, affine, px_m: float,
                  rgb: np.ndarray | None = None,
                  valid: np.ndarray | None = None,
                  prior_pitch_m: float = DEFAULT_PRIOR_PITCH_M,
                  prior_density_per_ha: float = DEFAULT_PRIOR_DENSITY,
                  min_pitch_m: float = 4.0,
                  max_pitch_m: float = 16.0,
                  min_tree_gap_m: float = 3.0,
                  center_sigma_m: float = 1.2,
                  allow_fallback: bool = True) -> GridModel:
    """估计种植网格。三条路线依次尝试，取第一条成功的。

    参数
    ----
    canopy : (H, W) bool
        树冠掩膜（True = 树冠）
    affine : rasterio Affine
        掩膜左上角对应的仿射变换（投影系）
    px_m : float
        地面分辨率（米/像素）
    rgb : (H, W, 3) uint8, 可选
        原始 RGB。**强烈建议传入**——方法 A（树心点阵）是主力，
        它需要 ExG 影像。不传则只能用方法 B/C，在粘连影像上大概率失败。
    valid : (H, W) bool, 可选
        有效数据掩膜（排除 NoData）
    prior_pitch_m : float
        种植间距先验（米）。实测 8.45 m。
    allow_fallback : bool
        全部方法失败时是否回落先验值。True = 回落到先验但 quality=0
        （所有空地会标 uncertain）；False = 抛出异常

    返回
    ----
    GridModel
    """
    if canopy.ndim != 2:
        raise ValueError("canopy 必须是二维数组")

    diagnostics: dict[str, Any] = {
        "canopy_cover_pct": round(float(canopy.mean() * 100), 2),
        "px_m": round(float(px_m), 5),
        "prior_pitch_m": prior_pitch_m,
    }
    notes: list[str] = []

    candidates: list[dict[str, Any]] = []

    # ---- 方法 A：树心点阵 ----
    if rgb is not None:
        pts_px = detect_tree_centers(rgb, valid, px_m,
                                     sigma_m=center_sigma_m,
                                     min_tree_gap_m=min_tree_gap_m)
        diagnostics["tree_centers"] = int(len(pts_px))
        if len(pts_px) >= 12:
            p, d = _grid_from_point_lattice(pts_px, px_m, affine, prior_pitch_m)
            diagnostics["point_lattice"] = d
            if p is not None:
                candidates.append(p)
        else:
            diagnostics["point_lattice"] = {
                "method": METHOD_POINT_LATTICE,
                "reason": f"检出的树心太少（{len(pts_px)} 个），无法拟合点阵。"
                          f"可能原因：冠层掩膜断裂、ExG 阈值不当、或该区域本就是空地",
            }
    else:
        diagnostics["point_lattice"] = {
            "method": METHOD_POINT_LATTICE,
            "reason": "未传入 rgb，跳过树心点阵法",
        }
        notes.append("未提供 rgb，跳过了最可靠的点阵法")

    # ---- 方法 B：折叠投影（兜底；在粘连冠层上通常通不过显著性检验）----
    p, d = _grid_from_profiles(canopy, affine, px_m, prior_pitch_m)
    diagnostics["folded_profile"] = d
    if p is not None:
        candidates.append(p)

    # ---- 选优：质量优先，同质量下点数多的优先 ----
    if candidates:
        candidates.sort(key=lambda c: (-c["quality"], -c.get("node_count", 0)))
        best = dict(candidates[0])

        # 区间合理性校正：估出来的间距必须落在物理合理区间
        pitch_est = float(best["plant_pitch_m"])
        if not (min_pitch_m <= pitch_est <= max_pitch_m):
            notes.append(f"估计间距 {pitch_est:.2f} m 超出合理区间 "
                         f"[{min_pitch_m}, {max_pitch_m}] m，已标记为不可信")
            best["quality"] = min(best["quality"], 0.10)

        if abs(pitch_est - prior_pitch_m) > 3.0:
            notes.append(f"估计间距 {pitch_est:.2f} m 与先验 {prior_pitch_m:.2f} m "
                         f"偏差 >3 m，建议人工核验")

        best["notes"] = "；".join(notes + [c.get("reason", "") for c in candidates[1:]
                                           if c.get("reason")])
        best["method_version"] = DEFAULT_METHOD_VERSION
        model = GridModel(**{k: v for k, v in best.items()
                             if k in GridModel.__dataclass_fields__})
        _attach_diagnostics(model, diagnostics)
        return model

    # ---- 方法 C：先验回落 ----
    if not allow_fallback:
        raise RuntimeError(f"网格估计失败且不允许回落：{diagnostics}")

    notes.append("树心点阵与折叠投影均失败，回落到实测先验值；"
                 "所有空地一律标记为 uncertain，需人工复核")
    unit = 1e4 / max(prior_density_per_ha, 1.0)
    # 按等边三角形反推边长：unit = sin60 · a²  ⟹  a = √(unit / sin60)
    plant = float(np.sqrt(unit / _SIN60))
    row = _derive_row_pitch(plant, True)
    model = GridModel(
        plant_pitch_m=plant,
        row_pitch_m=row,
        skew_offset_m=plant / 2.0,
        origin_x_m=float(affine.c),
        origin_y_m=float(affine.f),
        row_azimuth_deg=0.0,
        quality=0.0,
        method=METHOD_PRIOR_FALLBACK,
        density_per_ha=float(prior_density_per_ha),
        node_count=0,
        nn_cv=float("nan"),
        regularity=0.0,
        angle_conc=0.0,
        notes="；".join(notes),
    )
    _attach_diagnostics(model, diagnostics)
    return model


def _attach_diagnostics(model: GridModel, diagnostics: dict[str, Any]) -> None:
    """把诊断信息挂到模型的 notes 里（不进 dataclass 字段，避免污染 schema）。"""
    setattr(model, "diagnostics", diagnostics)


# ============================================================================
# 几何量计算
# ============================================================================
def gap_geometry(poly_utm, gap_id: str, area_sqm: float | None = None) -> GapGeometry:
    """从一个 UTM 系下的 shapely 多边形算出分类所需的几何量。"""
    minx, miny, maxx, maxy = poly_utm.bounds
    bw, bh = maxx - minx, maxy - miny
    area = float(area_sqm if area_sqm is not None else poly_utm.area)
    perim = float(poly_utm.length)
    c = poly_utm.centroid

    long_side = max(bw, bh)
    short_side = max(min(bw, bh), 1e-6)

    return GapGeometry(
        gap_id=gap_id,
        centroid_x=float(c.x),
        centroid_y=float(c.y),
        area_sqm=area,
        bbox_w=float(bw),
        bbox_h=float(bh),
        perimeter_m=perim,
        elongation=float(long_side / short_side),
        roundness=float(np.clip(4.0 * np.pi * area / (perim * perim), 0.0, 1.0))
        if perim > 0 else 0.0,
    )


def _distance_to_lines(v: float, origin: float, period: float) -> float:
    """v 到最近一条等距平行线（origin + k·period）的垂直距离。"""
    if period <= 0:
        return float("inf")
    t = (v - origin) / period
    return float(abs(t - round(t)) * period)


# ============================================================================
# 分类
# ============================================================================
def classify_gaps(gaps: Sequence[GapGeometry], grid: GridModel,
                  node_tol_ratio: float = 0.35,
                  inrow_tol_ratio: float = 0.30,
                  elongate_ratio: float = 2.2,
                  min_coverage_for_slot: float = 0.15) -> list[dict[str, Any]]:
    """给每个空地多边形打类别标签。

    判定规则（按优先级）
    --------------------
    0. 网格不可信（quality < 0.15）        → uncertain，置信度 0
    1. 质心贴近格点 + 形状不细长 + 面积不是过小 → vacant_slot
    2. 质心明显偏离所有格点，或形状细长     → alley_gap
    3. 其余                                  → uncertain

    参数
    ----
    node_tol_ratio : float
        距格点多少「倍最小间距」内算压在格点上。默认 0.35。
        实测：单株缺株的空地质心通常落在格点 ±0.3 间距内。
    inrow_tol_ratio : float
        距行中线多少倍行距内算「在行上」。默认 0.30。
    elongate_ratio : float
        长宽比超过该值判为细长条带。默认 2.2。
    min_coverage_for_slot : float
        面积 / 单位格面积 的下限。太小（<0.15 个格）的碎斑不足以支撑
        「一株树没了」的判断，降级为 uncertain。
    """
    period_min = min(grid.plant_pitch_m, grid.row_pitch_m)
    if not np.isfinite(period_min) or period_min <= 0:
        period_min = DEFAULT_PRIOR_PITCH_M

    # ⚠️ 容差自适应：点阵规则度低（树心少 / CV 大）时，估计出来的格点位置本身
    #    有误差。此时若仍用 0.35 的紧容差，真缺株会被误判成 alley_gap（实测踩过）。
    #    做法：按规则度放宽，但上限 0.45，避免把行间空隙也吃成格点。
    reg = float(grid.regularity) if np.isfinite(grid.regularity) else 0.5
    pad = 1.0 + 0.30 * (1.0 - min(max(reg, 0.0), 1.0))
    node_tol = min(node_tol_ratio * pad, 0.45) * period_min
    inrow_tol = inrow_tol_ratio * period_min
    unit_area = grid.unit_cell_area_sqm

    results: list[dict[str, Any]] = []
    for g in gaps:
        # --- 连续格坐标 + 到最近格点距离 ---
        gx, gy, d_node = grid.xy_to_grid(g.centroid_x, g.centroid_y)
        ix, iy = int(round(gx)), int(round(gy))
        nx, ny = grid.node_at(ix, iy)

        g.grid_gx, g.grid_gy = gx, gy
        g.node_x, g.node_y = nx, ny
        g.node_distance_m = d_node
        g.coverage_ratio = float(g.area_sqm / unit_area) if unit_area > 0 else 0.0

        # --- 到行中线的距离：格坐标 gy 的小数部分离 0.5 越近 = 越在两行之间 ---
        frac_gy = abs(gy - round(gy))
        g.in_row_distance_m = float(frac_gy * grid.row_pitch_m)

        # --- 分类：先算三个互相独立的证据强度，再按优先级裁决 ---
        #   c_slot  = 「贴近格点 + 形状偏圆 + 面积刚好一格」的综合强度
        #   c_patch = 「面积明显跨多个格」的强度（连片空地）
        #   c_alley = 「形状细长 / 面积远小于一格 / 明显夹在两行之间」的最大值
        # 用"证据打分"而不是硬 if-else 链，是为了避免容差边界上的抖动
        # （同一块空地在不同瓦片里因相位误差被判成不同类）。
        pos = float(np.clip(1.0 - d_node / max(node_tol, 1e-6), 0.0, 1.0))
        shape_round = float(np.clip(1.0 - (g.elongation - 1.0) / elongate_ratio, 0.0, 1.0))

        # size_ok：面积刚好一个格左右最佳（>1.5 格反而说明不止缺一株）
        cov = float(g.coverage_ratio)
        size_ok = float(np.clip(cov / max(min_coverage_for_slot, 1e-6), 0.0, 1.0))
        if cov > 1.5:
            size_ok *= float(np.clip(2.2 - cov, 0.0, 1.0))   # 2.2 格以上完全否决
        c_slot = 0.45 * pos + 0.30 * shape_round + 0.25 * size_ok

        # 连片空地：面积跨过多个株位格 → 不是"缺一株"，而是一整片没种/死光了
        # 起点取 2.0 格（略高于"单株空缺"的上限 1.5 格），到 4 格饱和
        c_patch = float(np.clip((cov - 2.0) / 2.0, 0.0, 1.0))

        elo_clear = float(np.clip((g.elongation - elongate_ratio) / elongate_ratio,
                                  0.0, 1.0))
        # 面积远小于一格 → 不可能是"一株树的位置"，只能是缝隙（实测有效判据）
        tiny = float(np.clip(1.0 - g.coverage_ratio / max(min_coverage_for_slot, 1e-6),
                             0.0, 1.0))
        # ⚠️ dev 的归一化必须用「容差外还要走多远」而不是整个 period。
        #    旧写法 (d_node - node_tol)/period 在 period=7.4 m 时，即使质心已经
        #    跑到两格正中（d_node≈3.7 m、容差 2.6 m），也只得到 0.15 分，
        #    永远够不到 0.55 的判定线 —— 实测所有"行间小空隙"因此全掉进 uncertain。
        #    正确写法：把「从容差走到两格中点」定义为满分。
        far_ref = max(node_tol * 0.5, period_min * 0.5 - node_tol)
        dev = float(np.clip((d_node - node_tol) / max(far_ref, 1e-6), 0.0, 1.0)) \
            if d_node > node_tol else 0.0

        # ⚠️ 关键：dev 是「弱证据」，不能单独把一块大空地判成"林间空隙"。
        #    实测踩过：470 m² 的连片空地（7.4 个单位格）因质心恰好远离格点而
        #    拿到 dev=1.0，被误判成"空隙"——语义完全反了。
        #    形态证据（细长 / 远小于一格）才是空隙的"强证据"。
        #    所以：dev 只在「面积不超过一格半」时才参与空隙判定。
        dev_gated = dev if cov <= 1.5 else 0.0
        c_alley = max(elo_clear, tiny, dev_gated)

        if not grid.is_usable:
            cls = CLASS_UNCERTAIN
            conf = 0.0
            reason = (f"网格先验不可信（quality={grid.quality:.2f} < 0.15，"
                      f"method={grid.method}），本块空地无法分类，交人工确认")
        elif c_patch > 0.0 and c_patch >= max(c_slot, c_alley):
            # 连片空地优先于空隙：形状证据不足以把一块跨多格的大空地叫"缝隙"
            cls = CLASS_OPEN_PATCH
            est = max(1, int(round(cov)))     # 粗估涉及几个株位
            conf = float(np.clip(0.45 + 0.5 * c_patch, 0.0, 1.0)) * max(grid.quality, 0.30)
            reason = (f"面积 {g.area_sqm:.0f} m² ≈ {cov:.1f} 个单位格，跨多个株位，"
                      f"长宽比 {g.elongation:.2f} → 判定为连片空地"
                      f"（约需补种 {est} 株）")
        elif c_alley >= 0.55 and c_slot < 0.60:
            cls = CLASS_ALLEY_GAP
            conf = float(np.clip(c_alley, 0.0, 1.0)) * max(grid.quality, 0.30)
            why: list[str] = []
            if tiny > 0.5:
                why.append(f"面积仅占单位格 {g.coverage_ratio*100:.0f}%"
                           f"（不足一株树冠的投影面积）")
            if elo_clear > 0.0:
                why.append(f"长宽比 {g.elongation:.2f} ≥ {elongate_ratio}")
            if dev_gated > 0.5:
                why.append(f"质心距格点 {d_node:.2f} m，已远离所有株位")
            reason = "、".join(why) + " → 判定为林间空隙"
        elif c_slot >= 0.55 and d_node <= node_tol and g.elongation < elongate_ratio:
            cls = CLASS_VACANT_SLOT
            conf = float(np.clip(c_slot, 0.0, 1.0)) * max(grid.quality, 0.30)
            reason = (f"质心距最近格点 {d_node:.2f} m（容差 {node_tol:.2f} m）、"
                      f"长宽比 {g.elongation:.2f}、占单位格 {g.coverage_ratio*100:.0f}% "
                      f"→ 判定为格点上缺株")
        else:
            cls = CLASS_UNCERTAIN
            conf = float(np.clip(max(c_slot, c_patch, c_alley) * grid.quality * 0.6,
                                 0.0, 0.45))
            reason = (f"距格点 {d_node:.2f} m、长宽比 {g.elongation:.2f}、"
                      f"占单位格 {g.coverage_ratio*100:.0f}%"
                      f"（株位证据 {c_slot:.2f} / 连片证据 {c_patch:.2f} / "
                      f"空隙证据 {c_alley:.2f}，均不充分），交人工确认")

        results.append({
            "gap_id": g.gap_id,
            "class": cls,
            "class_label": CLASS_LABEL_CN[cls],
            "class_confidence": round(float(conf), 3),
            "class_method": "planting_grid_prior",
            "class_reason": reason,
            "class_semantics": CLASS_SEMANTICS[cls],
            "evidence": {
                "slot_score": round(float(c_slot), 3),
                "patch_score": round(float(c_patch), 3),
                "alley_score": round(float(c_alley), 3),
                "node_tol_m": round(float(node_tol), 2),
            },
            "grid": {
                "cell": [int(ix), int(iy)],
                "center_xy": [round(float(nx), 2), round(float(ny), 2)],
                "node_distance_m": round(float(d_node), 2),
                "in_row_distance_m": round(float(g.in_row_distance_m), 2),
                "coverage_ratio": round(float(g.coverage_ratio), 3),
            },
            "shape": {
                "elongation": round(float(g.elongation), 2),
                "roundness": round(float(g.roundness), 3),
            },
            "is_grid_suspect": bool(not grid.is_usable),
        })
    return results


# ============================================================================
# 便捷封装
# ============================================================================
def build_grid_and_classify(canopy: np.ndarray, affine, px_m: float,
                            polygons_utm: Iterable[tuple[str, Any, float]],
                            rgb: np.ndarray | None = None,
                            valid: np.ndarray | None = None,
                            **kwargs) -> tuple[GridModel, list[dict[str, Any]]]:
    """一步完成「估计网格 + 分类」。

    polygons_utm : 可迭代的 (gap_id, shapely 多边形(投影系), 面积 m²) 三元组
    kwargs : 透传给 estimate_grid 与 classify_gaps（按参数名自动分流）
    """
    grid_keys = {"prior_pitch_m", "prior_density_per_ha", "min_pitch_m", "max_pitch_m",
                 "min_tree_gap_m", "center_sigma_m", "allow_fallback"}
    cls_keys = {"node_tol_ratio", "inrow_tol_ratio", "elongate_ratio",
                "min_coverage_for_slot"}

    grid = estimate_grid(canopy, affine, px_m, rgb=rgb, valid=valid,
                         **{k: v for k, v in kwargs.items() if k in grid_keys})
    geoms = [gap_geometry(p, gid, area) for gid, p, area in polygons_utm]
    labels = classify_gaps(geoms, grid,
                           **{k: v for k, v in kwargs.items() if k in cls_keys})
    return grid, labels


def check_density_consistency(grid, target_density_per_ha, tol: float = 0.10):
    """把网格**估计**出的密度与用户给定的**设计**密度做交叉校验。

    返回 (ok: bool, ratio: float, message: str)。

    为什么需要这一步：网格是从树心反推拟合出来的，可能因为
      · 树心检测漏检/误检
      · 影像分辨率或曝光导致的间距偏差
      · 该园区实际种植密度本就与设计值不同
    而出现系统性偏差。设计密度是一个**独立于影像**的强先验，
    拿它做交叉校验能及时暴露拟合错误，避免把「株位空缺」判错。

    ⚠️ 注意本函数只**报警**，不自动改参数 —— 因为设计密度也可能与
    实际不符（补种过的园区、非标准种植区）。最终以用户确认为准。
    """
    est = float(grid.density_per_ha)
    if not target_density_per_ha or target_density_per_ha <= 0:
        return True, 1.0, f"未提供设计密度；网格估计密度 {est:.1f} 株/ha"
    ratio = est / float(target_density_per_ha)
    ok = abs(ratio - 1.0) <= tol
    implied_cell = 1e4 / float(target_density_per_ha)
    msg = (f"网格估计密度 {est:.1f} 株/ha  vs  设计密度 "
           f"{float(target_density_per_ha):.0f} 株/ha  （比值 {ratio:.2f}）")
    if not ok:
        msg += (f"\n    ⚠️ 偏差超过 ±{tol * 100:.0f}%。按设计密度反推，"
                f"单位格面积应为 {implied_cell:.1f} m²，"
                f"而网格给出 {grid.unit_cell_area_sqm:.1f} m²"
                f"（株距 {grid.plant_pitch_m:.2f} m × 行距 {grid.row_pitch_m:.2f} m）。"
                f"\n    可能原因：网格拟合偏差 / 树心漏检 / 该园区实际密度与设计值不同。"
                f"\n    建议：用已知的株距或行距实测值校正，或确认该园区是否补种过。")
    return ok, ratio, msg


def summarize_classes(labels: Sequence[dict[str, Any]]) -> dict[str, int]:
    """统计各类别数量（含不可种植三类）。"""
    out = {c: 0 for c in CLASS_LABEL_CN}
    for it in labels:
        c = it.get("class")
        if c in out:
            out[c] += 1
    return out


def summarize_unplantable(labels: Sequence[dict[str, Any]]) -> dict[str, float]:
    """按类别汇总**不可种植**地物的数量与面积。

    这些类别不计入"需补种空地"，用户明确要求剔除
    （原话："道路 / 排水预留带不算『要补种的地』"，
     并把道路、河流、油棕树、办公区一并列为不可种植）。
    """
    cnt: dict[str, int] = {c: 0 for c in UNPLANTABLE_CLASSES}
    area: dict[str, float] = {c: 0.0 for c in UNPLANTABLE_CLASSES}
    for it in labels:
        c = it.get("class")
        if c not in cnt:
            continue
        cnt[c] += 1
        area[c] += float(it.get("area_sqm") or 0.0)
    return {
        "count": sum(cnt.values()),
        "area_sqm": round(sum(area.values()), 2),
        "by_class": {c: {"count": cnt[c], "area_sqm": round(area[c], 2)}
                     for c in UNPLANTABLE_CLASSES if cnt[c] > 0 or area[c] > 0},
    }


def summarize_priority(labels: Sequence[dict[str, Any]]
                       ) -> dict[str, dict[str, float]]:
    """按「是否真的需要补种」把空地分成三档（块数 + 面积 m²）。

    见 ``PRIORITY_GROUPS`` 的说明：``alley_gap`` 是正常行间缝隙、
    ``uncertain`` 需人工核实，两者都不该混进"确定需补种"的面积里。
    """
    out: dict[str, dict[str, float]] = {}
    for name, classes in PRIORITY_GROUPS.items():
        cnt = 0
        area = 0.0
        for it in labels:
            if it.get("class") in classes:
                cnt += 1
                area += float(it.get("area_sqm") or 0.0)
        out[name] = {"count": cnt, "area_sqm": round(area, 2)}
    return out


# ============================================================================
# 自检：合成测试
# ============================================================================
def _synthetic_canopy(mode: str = "triangular", px_m: float = 0.033,
                      size: int = 2048, pitch: float = 8.45,
                      missing: int = 6, noise: float = 0.03,
                      seed: int = 0) -> tuple[np.ndarray, np.ndarray, Any, np.ndarray]:
    """造一个人造油棕园：规整网格 + 随机挖掉几株。

    返回 (rgb, canopy, affine, missing_positions_m)
    """
    from rasterio.transform import Affine

    rng = np.random.default_rng(seed)
    side_m = size * px_m
    pts: list[tuple[float, float]] = []

    if mode == "triangular":
        # 等边三角形：行距 = pitch·sin60°，每行错开半个株距（pitch/2）。
        # 用共享的 _derive_row_pitch 保证与 GridModel 的定义永远一致——
        # 这很重要，否则「生成器用一套公式、模型用另一套」，自检会一直失败。
        row_pitch = _derive_row_pitch(pitch, True)
        skew_off = pitch / 2.0
        n_row = int(side_m / row_pitch) + 2
        n_col = int(side_m / pitch) + 2
        for iy in range(n_row):
            for ix in range(n_col):
                x = ix * pitch + iy * skew_off
                y = iy * row_pitch
                if 0 <= x < side_m and 0 <= y < side_m:
                    pts.append((x, y))
    else:  # square
        row_pitch = _derive_row_pitch(pitch, False)
        n = int(side_m / row_pitch) + 2
        for iy in range(n):
            for ix in range(n):
                x, y = ix * pitch, iy * row_pitch
                if 0 <= x < side_m and 0 <= y < side_m:
                    pts.append((x, y))

    pts = np.array(pts)
    missing_idx = rng.choice(len(pts), size=min(missing, len(pts)), replace=False)
    missing_pos = pts[missing_idx]
    keep = np.setdiff1d(np.arange(len(pts)), missing_idx)

    # 画冠层：每株一个高斯斑，半径 = pitch*0.42（保证相邻轻微粘连，模拟真实粘连）
    yy, xx = np.mgrid[0:size, 0:size]
    canopy_f = np.zeros((size, size), dtype=np.float32)
    radius_px = pitch * 0.42 / px_m
    for k in keep:
        px, py = pts[k] / px_m
        m = ((xx - px) ** 2 + (yy - py) ** 2) <= radius_px ** 2
        canopy_f[m] = 1.0

    canopy = canopy_f > 0.5
    # 造 RGB：树冠处绿，裸土处棕
    rgb = np.zeros((size, size, 3), dtype=np.float32)
    soil = np.array([150.0, 125.0, 95.0])
    green = np.array([70.0, 130.0, 55.0])
    w = canopy.astype(np.float32)[:, :, None]
    rgb = soil * (1 - w) + green * w
    rgb += rng.normal(0, 255 * noise, rgb.shape)
    rgb = np.clip(rgb, 0, 255).astype(np.uint8)

    affine = Affine(px_m, 0.0, 520000.0, 0.0, -px_m, 130000.0)
    return rgb, canopy, affine, missing_pos


def _selftest(verbose: bool = True) -> int:
    """人造园自检：验证网格估计精度与分类正确性。"""
    from rasterio.transform import Affine
    from shapely.geometry import box

    fails = 0
    print("=" * 78)
    print("株行距网格先验 —— 自检")
    print("=" * 78)

    for mode, pitch in (("triangular", 8.45), ("triangular", 9.2), ("square", 8.45)):
        px_m = 0.033
        rgb, canopy, affine, missing = _synthetic_canopy(
            mode=mode, px_m=px_m, pitch=pitch, missing=8, seed=7)

        grid = estimate_grid(canopy, affine, px_m, rgb=rgb, valid=np.ones_like(canopy),
                             prior_pitch_m=pitch)

        cover = canopy.mean() * 100
        print(f"\n--- 人造园：{mode}，真值间距 {pitch:.2f} m，冠层 {cover:.0f}% ---")
        print(f"  估计：行距 {grid.row_pitch_m:.2f} m，株距 {grid.plant_pitch_m:.2f} m，"
              f"错行角 {grid.skew_angle_deg:.1f}°，方位 {grid.row_azimuth_deg:.1f}°")
        print(f"        标称间距 {grid.pitch_m:.2f} m（真值 {pitch:.2f} m，"
              f"误差 {abs(grid.pitch_m-pitch):.3f} m）")
        print(f"        质量 {grid.quality:.3f}  方法 {grid.method}  "
              f"树心 {grid.node_count} 个  CV={grid.nn_cv:.3f}  方向集中度={grid.angle_conc:.3f}")

        expect_skew = 60.0 if mode == "triangular" else 90.0
        if mode == "triangular" and not (40 <= grid.skew_angle_deg <= 90):
            print(f"  ✗ 错行角异常：{grid.skew_angle_deg:.1f}°（三角形应 ≈60°）")
            fails += 1
        if abs(grid.pitch_m - pitch) > 0.6:
            print(f"  ✗ 间距误差过大：{abs(grid.pitch_m-pitch):.3f} m > 0.6 m")
            fails += 1
        if grid.quality < 0.15:
            print(f"  ✗ 网格质量过低：{grid.quality:.3f}")
            fails += 1

        # --- 分类测试：在真值缺株位置放一个空地多边形，在行间放另一个 ---
        # 真值缺株位置 → 期望 vacant_slot
        a = np.radians(grid.row_azimuth_deg)
        u = np.array([np.cos(a), np.sin(a)])
        v = np.array([-np.sin(a), np.cos(a)])

        polys = []
        for k, (mx_, my_) in enumerate(missing[:4]):
            cx = affine.c + mx_
            cy = affine.f - my_
            half = np.sqrt(pitch ** 2 * 0.20) / 2.0
            polys.append((f"SLOT{k:02d}", box(cx - half, cy - half, cx + half, cy + half),
                          half * half * 4))

        # 行间空隙：在两株中间、两行之间的位置
        for k in range(3):
            base = missing[k] if k < len(missing) else np.array([pitch, pitch])
            # 沿行方向偏半格 → 株间；沿行间方向偏半格 → 行间
            px_ = affine.c + base[0] + u[0] * pitch * 0.5 + v[0] * grid.row_pitch_m * 0.5
            py_ = affine.f - (base[1] + u[1] * pitch * 0.5 + v[1] * grid.row_pitch_m * 0.5)
            w_, h_ = pitch * 0.30, pitch * 0.16      # 细长条带
            polys.append((f"ALLEY{k:02d}",
                          box(px_ - w_ / 2, py_ - h_ / 2, px_ + w_ / 2, py_ + h_ / 2),
                          w_ * h_))

        labels = classify_gaps([gap_geometry(p, gid, ar) for gid, p, ar in polys], grid)
        got_slot = sum(1 for l in labels if l["gap_id"].startswith("SLOT")
                       and l["class"] == CLASS_VACANT_SLOT)
        got_alley = sum(1 for l in labels if l["gap_id"].startswith("ALLEY")
                        and l["class"] == CLASS_ALLEY_GAP)
        n_slot = sum(1 for l in labels if l["gap_id"].startswith("SLOT"))
        n_alley = sum(1 for l in labels if l["gap_id"].startswith("ALLEY"))
        print(f"  分类：株位空缺 {got_slot}/{n_slot} 正确，"
              f"林间空隙 {got_alley}/{n_alley} 正确")
        if got_slot < n_slot or got_alley < n_alley:
            fails += 1
            for l in labels:
                if (l["gap_id"].startswith("SLOT") and l["class"] != CLASS_VACANT_SLOT) or \
                   (l["gap_id"].startswith("ALLEY") and l["class"] != CLASS_ALLEY_GAP):
                    print(f"    ✗ {l['gap_id']} → {l['class']}（{l['class_reason']}）")

    # --- 失败路径：完全不传 rgb 且冠层高度粘连 → 应回落并标 uncertain ---
    print("\n--- 兜底路径：不提供 rgb（模拟方法 A 不可用）---")
    rgb, canopy, affine, _ = _synthetic_canopy("triangular", pitch=8.45, seed=3)
    grid = estimate_grid(canopy, affine, 0.033, rgb=None,
                         valid=np.ones_like(canopy), prior_pitch_m=8.45)
    print(f"  方法 {grid.method}  质量 {grid.quality:.3f}  "
          f"标称间距 {grid.pitch_m:.2f} m")
    lab = classify_gaps([gap_geometry(box(522000, 129000, 522010, 129010), "X", 100)], grid)
    print(f"  分类结果：{lab[0]['class']}（置信度 {lab[0]['class_confidence']}）")
    if grid.method == METHOD_PRIOR_FALLBACK and lab[0]["class"] != CLASS_UNCERTAIN:
        print("  ✗ 兜底路径必须标 uncertain")
        fails += 1

    print("\n" + "=" * 78)
    if fails == 0:
        print("✓ 全部自检通过")
    else:
        print(f"✗ 自检失败 {fails} 项")
    print("=" * 78)
    return fails


def main() -> int:
    ap = argparse.ArgumentParser(description="株行距网格先验 v0.2")
    ap.add_argument("--selftest", action="store_true", help="跑人造园自检（默认也是跑这个）")
    ap.add_argument("--quiet", action="store_true", help="只输出失败项")
    args = ap.parse_args()
    return 1 if _selftest(verbose=not args.quiet) else 0


if __name__ == "__main__":
    sys.exit(main())
