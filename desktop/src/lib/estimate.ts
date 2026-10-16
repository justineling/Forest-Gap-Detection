import type { EstimateResult, GapFeature, GapClass, PlantingPoint } from '../types'
import { CLASS_STYLES } from './classes'
import { distToBoundaryM, geometryOrigin, metersPerDeg, pointInGeometry, polygonAreaM2 } from './geometry'

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
}

/** 实测默认规格（来自 `output/*.geojson` 的 planting_grid / grid_survey） */
export const DEFAULT_GRID: GridSpec = {
  plant_pitch_m: 8.45,
  row_pitch_m: 7.32,
  azimuth_deg: 0.67,
  clearance_m: 2.0,
}

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
  const skew = pitch / 2 // 三角形错行：偶数行偏移半个株距
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
  const iMin = Math.floor(uMin / pitch) - 2
  const iMax = Math.ceil(uMax / pitch) + 2

  // 护栏：极端形状下别把主线程拖死
  const MAX_CANDIDATES = 60_000
  if ((jMax - jMin + 1) * (iMax - iMin + 1) > MAX_CANDIDATES) {
    return []
  }

  const out: PlantingPoint[] = []
  for (let j = jMin; j <= jMax; j++) {
    for (let i = iMin; i <= iMax; i++) {
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
}

export function estimate(
  features: GapFeature[],
  opts: Partial<EstimateOptions> = {},
): EstimateResult {
  const grid: GridSpec = {
    plant_pitch_m: opts.plant_pitch_m ?? DEFAULT_GRID.plant_pitch_m,
    row_pitch_m: opts.row_pitch_m ?? DEFAULT_GRID.row_pitch_m,
    azimuth_deg: opts.azimuth_deg ?? DEFAULT_GRID.azimuth_deg,
    clearance_m: opts.clearance_m ?? DEFAULT_GRID.clearance_m,
  }

  const target = features.filter(
    (f) => isPlantable(f.properties.class) && (!opts.onlyIds || opts.onlyIds.has(f.properties.gap_id)),
  )

  // 全局局部原点：取所有目标要素第一个顶点的均值，保证网格相位一致
  let lon0 = 0
  let lat0 = 0
  for (const f of target) {
    const o = geometryOrigin(f.geometry)
    lon0 += o[0]
    lat0 += o[1]
  }
  const origin: [number, number] = target.length
    ? [lon0 / target.length, lat0 / target.length]
    : [0, 0]

  // 网格相位：以原点为基准对齐到最近的格点（避免原点偏移半个格子）
  const points: PlantingPoint[] = []
  const seen = new Set<string>()
  const per_gap: EstimateResult['per_gap'] = []

  for (const f of target) {
    const area = f.properties.area_sqm ?? polygonAreaM2(f.geometry)
    const pts = gridPointsInFeature(f, grid, origin)
    // 跨多边形去重（重叠区域不应重复计数）
    let n = 0
    for (const p of pts) {
      const key = `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`
      if (seen.has(key)) continue
      seen.add(key)
      points.push(p)
      n++
    }
    const byArea = estimateByArea(area)
    per_gap.push({
      gap_id: f.properties.gap_id,
      class: f.properties.class,
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
  }
}

function divergencePct(byGrid: number, byArea: number): number {
  if (byArea <= 0) return 0
  return Math.round((Math.abs(byGrid - byArea) / byArea) * 1000) / 10
}
