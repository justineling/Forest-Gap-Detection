import type {
  EstimateResult,
  GapFeature,
  GapClass,
  PlantingGrid,
  PlantingPoint,
} from '../types'
import { CLASS_STYLES } from './classes'
import {
  centroid,
  distToBoundaryM,
  geometryOrigin,
  metersPerDeg,
  pointInGeometry,
  polygonAreaM2,
} from './geometry'

/**
 * 可种植数量估算 —— 双口径（对应 PRD 附录 C · R-P1-7）。
 *
 * 口径 A（面积折算）：`floor(area / 66.67)`。150 株/ha → 单株占地 66.67 m²。
 *   极快，用于拖动/勾选时的即时反馈。
 *
 * 口径 B（网格排坑模拟）：以实测种植规格（株距 8.45 m / 行距 7.32 m / 错行 60°）
 *   在多边形内铺虚拟格点，剔除「距边界 < 安全退让」的点后计数。
 *   这是**能直接放样的点位**，也是最终交付口径。
 *
 * ⚠️ 两个口径的差值本身就是质量指标：若某多边形 `by_grid ≪ by_area`，
 * 说明它形状破碎、或退让把面积吃掉了，UI 应标黄提示人工复核。
 *
 * ⚠️ 本文件的实现是**前端原型版**，在局部等距圆柱近似下计算。
 * 正式版应由 Python 侧用 `GridModel` 的 UTM 绝对坐标实现
 * （见 `docs/01-需求与架构/桌面端交互需求与实现映射.md` §2.2）。
 */

/** 单株净占地（m²）= 10000 / 150 */
export const SINGLE_TREE_AREA_M2 = 66.67

export interface GridSpec {
  plant_pitch_m: number
  row_pitch_m: number
  azimuth_deg: number
  clearance_m: number
  /**
   * 三角形错行沿行方向的偏移（m）。不传则用 `plant_pitch_m / 2`
   * ——实测 `planting_grid.skew_offset_m = 4.225 = 8.45 / 2`，两者一致。
   */
  skew_m?: number
}

/**
 * 实测默认规格（来自 `output/*.geojson` 的 planting_grid / grid_survey）。
 *
 * ⚠️ `clearance_m = 0.5` 是**业务拍板值**（2026-10-17），不是拍脑袋定的：
 *
 * `open_patch` 多边形的边界是周边存活油棕的**树冠叶尖外缘**（本身距老树干
 * 已有约 4.0~4.2 m），而不是树干中心。所以"从多边形边界退让 R"= 新苗距老树干
 * `4.2 + R` 米。
 *
 * 实测 449 块 open_patch 的等效宽度（2A/P，UTM 49N 精算）：
 *   P10 = 2.93 m · P25 = 3.79 m · **P50 = 4.68 m** · P75 = 5.73 m · P90 = 7.27 m
 * 即**过半连片空地是窄条**（单行缺株带的典型净宽约 5~6 m）。
 *
 * 不同退让下的"理论可排点块数"（宽 - 2R > 1 m）：
 *   0.5 m → 437/449 ｜ 1.0 m → 398 ｜ 1.5 m → 308 ｜ **2.0 m → 189** ｜ 3.0 m → 51
 * 排坑实测：0.5 m → 3,594 株 ｜ 1.0 m → 3,009 ｜ **2.0 m → 2,152**
 *
 * → 用 2.0 m 会把最典型的"单行缺株带"整片判为不可种（实测 123 块排坑为 0），
 *   而 0.5 m 时新苗距老树干实际已有 4.5~8.3 m，符合农学要求。
 */
export const DEFAULT_GRID: GridSpec = {
  plant_pitch_m: 8.45,
  row_pitch_m: 7.32,
  azimuth_deg: 0.67,
  clearance_m: 0.5,
}

/** UI 上提供的退让档位（默认 0.5，其余供用户按地块实际情况调整） */
export const CLEARANCE_PRESETS: Array<{ value: number; label: string; hint: string }> = [
  { value: 0.5, label: '0.5 m', hint: '默认：边界已是树冠外缘，实际距老树干 4.5~8.3 m' },
  { value: 1.0, label: '1.0 m', hint: '更保守：适合边界贴得较紧的地块' },
  { value: 2.0, label: '2.0 m', hint: '很保守：会排除大部分窄条单行缺株带' },
]

/** 参与补种估算的类别（＝ by_priority.definite_plant） */
export const PLANTABLE_CLASSES: GapClass[] = ['open_patch', 'vacant_slot', 'manual_add']

export function isPlantable(cls: GapClass): boolean {
  return CLASS_STYLES[cls]?.group === 'definite_plant'
}

export function estimateByArea(areaSqm: number): number {
  return Math.floor(areaSqm / SINGLE_TREE_AREA_M2)
}

/** 单个多边形的网格排坑（返回经纬度点位） */
function gridPointsInFeature(f: GapFeature, grid: GridSpec, origin: [number, number]): PlantingPoint[] {
  const { plant_pitch_m: pitch, row_pitch_m: row, clearance_m: clr } = grid
  // 三角形错行：偶数行偏移半个株距（实测 planting_grid.skew_offset_m = pitch/2）
  const skew = grid.skew_m ?? pitch / 2
  const th = (grid.azimuth_deg * Math.PI) / 180
  const ux = Math.cos(th)
  const uy = Math.sin(th)
  const vx = -Math.sin(th)
  const vy = Math.cos(th)

  const [lon0, lat0] = origin
  const { x: mx, y: my } = metersPerDeg(lat0)
  const toLocal = (p: [number, number]): [number, number] => [(p[0] - lon0) * mx, (p[1] - lat0) * my]
  const toLonLat = (x: number, y: number): [number, number] => [lon0 + x / mx, lat0 + y / my]

  const rings = f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat()
  const outer = rings[0]
  const locals = outer.map(toLocal)
  const xs = locals.map((p) => p[0])
  const ys = locals.map((p) => p[1])
  const bx0 = Math.min(...xs)
  const bx1 = Math.max(...xs)
  const by0 = Math.min(...ys)
  const by1 = Math.max(...ys)

  // 局部坐标 → 网格索引范围（对 bbox 四角投影到 u / v 轴上取极值）
  const corners: Array<[number, number]> = [
    [bx0, by0],
    [bx1, by0],
    [bx0, by1],
    [bx1, by1],
  ]
  let jMin = Infinity
  let jMax = -Infinity
  let uMin = Infinity
  let uMax = -Infinity
  for (const [x, y] of corners) {
    const dj = (x * vx + y * vy) / row
    const du = x * ux + y * uy
    jMin = Math.min(jMin, dj)
    jMax = Math.max(jMax, dj)
    uMin = Math.min(uMin, du)
    uMax = Math.max(uMax, du)
  }
  jMin = Math.floor(jMin) - 1
  jMax = Math.ceil(jMax) + 1

  // ⚠️ i 的范围必须**逐 j 计算**：格点沿 u 轴的投影是
  //     alongU = i*pitch + j*skew，反解 i = (du - j*skew)/pitch。
  //     `j*skew` 这一项在离原点较远的要素上可达 ±50 个格位；
  //     若用「全局 iMin/iMax」一次算死，远处的要素会一个格点都取不到
  //     —— 实测症状：5,771 m² 的连片空地排坑得 0 株，全园只有 286 株
  //     （面积折算口径是 4,267 株，差异 93%）。
  const iSpan = Math.ceil((uMax - uMin) / pitch) + 4
  const MAX_CANDIDATES = 60_000
  if ((jMax - jMin + 1) * iSpan > MAX_CANDIDATES) {
    return []
  }

  const out: PlantingPoint[] = []
  for (let j = jMin; j <= jMax; j++) {
    const shift = j * skew
    const iLo = Math.floor((uMin - shift) / pitch) - 1
    const iHi = Math.ceil((uMax - shift) / pitch) + 1
    for (let i = iLo; i <= iHi; i++) {
      const alongU = i * pitch + j * skew
      const x = alongU * ux + j * row * vx
      const y = alongU * uy + j * row * vy
      if (x < bx0 - pitch || x > bx1 + pitch || y < by0 - pitch || y > by1 + pitch) continue
      const ll = toLonLat(x, y)
      if (!pointInGeometry(ll, f.geometry)) continue
      const d = distToBoundaryM(ll, f.geometry)
      if (d < clr) continue
      out.push({
        lon: ll[0],
        lat: ll[1],
        gap_id: f.properties.gap_id,
        edge_dist_m: Math.round(d * 100) / 100,
      })
    }
  }
  return out
}

export interface EstimateOptions extends GridSpec {
  /** 只估算这些 gap_id；不传则用全部可种植要素 */
  onlyIds?: Set<string>
  /**
   * 算法侧的种植网格模型（来自 `/gaps` 响应的 `planting_grid`）。
   *
   * ⚠️ **传它才能与 Python 侧逐株对账**。不传时前端会退回"所有要素第一个顶点
   * 的均值"当原点 —— 那是一个**任意相位**，实测与 Python 差 +8.8%
   * （3,594 vs 3,912 株）。差异 100% 来自原点相位，不是退让算法
   * （两种退让写法在同一原点下 464 块逐块一致）。
   */
  planting_grid?: PlantingGrid
  /** 显式指定原点（经纬度）；优先级最高 */
  origin?: [number, number]
}

export function estimate(
  features: GapFeature[],
  opts: Partial<EstimateOptions> = {},
): EstimateResult {
  const pg = opts.planting_grid
  const grid: GridSpec = {
    plant_pitch_m: opts.plant_pitch_m ?? pg?.plant_pitch_m ?? DEFAULT_GRID.plant_pitch_m,
    row_pitch_m: opts.row_pitch_m ?? pg?.row_pitch_m ?? DEFAULT_GRID.row_pitch_m,
    azimuth_deg:
      opts.azimuth_deg ?? pg?.azimuth_deg ?? pg?.row_azimuth_deg ?? DEFAULT_GRID.azimuth_deg,
    clearance_m: opts.clearance_m ?? DEFAULT_GRID.clearance_m,
    skew_m: opts.skew_m ?? pg?.skew_offset_m,
  }

  const target = features.filter(
    (f) => isPlantable(f.properties.class) && (!opts.onlyIds || opts.onlyIds.has(f.properties.gap_id)),
  )

  // 网格原点：优先用算法锚点，其次显式指定，最后退回几何原点（相位任意）
  let origin: [number, number]
  let originSource: EstimateResult['origin_source']
  if (opts.origin) {
    origin = opts.origin
    originSource = 'explicit'
  } else if (pg && typeof pg.anchor_lon === 'number' && typeof pg.anchor_lat === 'number') {
    origin = [pg.anchor_lon, pg.anchor_lat]
    originSource = 'planting_grid'
  } else {
    let lon0 = 0
    let lat0 = 0
    for (const f of target) {
      const o = geometryOrigin(f.geometry)
      lon0 += o[0]
      lat0 += o[1]
    }
    origin = target.length ? [lon0 / target.length, lat0 / target.length] : [0, 0]
    originSource = 'geometry'
  }

  // 网格相位：以原点为基准对齐到最近的格点（避免原点偏移半个格子）
  const points: PlantingPoint[] = []
  const seen = new Set<string>()
  const per_gap: EstimateResult['per_gap'] = []

  for (const f of target) {
    const area = f.properties.area_sqm ?? polygonAreaM2(f.geometry)
    const cls = f.properties.class
    const isSlot = cls === 'vacant_slot'

    // ⚠️ 按类别分口径（实测驱动的修正）：
    // `vacant_slot`（株位空缺）本身就是**一个种植单元**里少了 1 棵树
    // （实测 253 块 / 16,043 m² ≈ 63 m²/块，接近一个单元 60.37 m²），
    // 它的形状是"树冠大小的洞"，宽约 6~8 m。两个问题：
    //   ① 用 2 m 退让去铺 8.45 m 间距的格点会大量落空（实测 196 个窄块得 0）；
    //   ② 面积口径 floor(63/66.67) = 0，但语义上它就是 **1 株**。
    // 因此株位空缺两个口径都记 1（点位取质心）；连片空地/人工新增走网格排坑。
    const byArea = isSlot ? 1 : estimateByArea(area)

    let pts: PlantingPoint[]
    if (isSlot) {
      const c = centroid(f.geometry)
      pts = [
        {
          lon: c[0],
          lat: c[1],
          gap_id: f.properties.gap_id,
          edge_dist_m: Math.round(distToBoundaryM(c, f.geometry) * 100) / 100,
        },
      ]
    } else {
      pts = gridPointsInFeature(f, grid, origin)
    }

    // 跨多边形去重（重叠区域不应重复计数）
    let n = 0
    for (const p of pts) {
      const key = `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`
      if (seen.has(key)) continue
      seen.add(key)
      points.push(p)
      n++
    }
    per_gap.push({
      gap_id: f.properties.gap_id,
      class: cls,
      area_sqm: Math.round(area * 10) / 10,
      by_area: byArea,
      by_grid: n,
      divergence_pct: divergencePct(n, byArea),
    })
  }

  const totalArea = per_gap.reduce((a, r) => a + r.area_sqm, 0)
  const byAreaTotal = per_gap.reduce((a, r) => a + r.by_area, 0)
  const byGridTotal = points.length

  return {
    by_area: byAreaTotal,
    by_grid: byGridTotal,
    divergence_pct: divergencePct(byGridTotal, byAreaTotal),
    area_sqm: Math.round(totalArea * 10) / 10,
    per_gap: per_gap.sort((a, b) => b.area_sqm - a.area_sqm),
    points,
    grid,
    origin,
    origin_source: originSource,
  }
}

function divergencePct(byGrid: number, byArea: number): number {
  if (byArea <= 0) return 0
  return Math.round((Math.abs(byGrid - byArea) / byArea) * 1000) / 10
}
