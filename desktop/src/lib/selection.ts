import type { GapClass, GapFeature, Position } from '../types'
import { centroid, metersPerDeg } from './geometry'
import { CLASS_STYLES } from './classes'

/**
 * 框选与复核筛选的**纯几何逻辑**。
 *
 * 为什么单独抽出来、不直接调 `map.queryRenderedFeatures`：
 *   1. 它只认"当前渲染出来的"，缩放级别不同结果会变（同一块地在 z14 命中、
 *      z12 因为太小没渲染就漏掉）—— 用户无法预期；
 *   2. 它跑在 WebGL 里，`npm test` 测不到；
 *   3. **最重要**：它不区分"用户勾选了哪些类别"，而框选必须只命中可见图层，
 *      否则会把隐藏的道路 / 水体一起删掉（盲删事故）。
 *
 * 所以：地图只负责给一个经纬度矩形，选谁由这里的纯函数决定。
 */

export interface BBox {
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

/** 两个对角点 → 规范化矩形（拖拽方向任意） */
export function normalizeBBox(a: Position, b: Position): BBox {
  return {
    minLon: Math.min(a[0], b[0]),
    minLat: Math.min(a[1], b[1]),
    maxLon: Math.max(a[0], b[0]),
    maxLat: Math.max(a[1], b[1]),
  }
}

/** 矩形是否退化成一条线 / 一个点（拖拽时手抖会产生这种框，不该选中任何东西） */
export function isDegenerateBox(b: BBox, minSpanDeg = 1e-9): boolean {
  return b.maxLon - b.minLon < minSpanDeg || b.maxLat - b.minLat < minSpanDeg
}

function eachPosition(geom: GapFeature['geometry'], cb: (p: Position) => void): void {
  if (geom.type === 'Polygon') {
    for (const ring of geom.coordinates) for (const p of ring) cb(p as Position)
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates)
      for (const ring of poly) for (const p of ring) cb(p as Position)
  }
}

/** 要素的外接框（经纬度） */
export function featureBBox(f: GapFeature): BBox | null {
  let minLon = Infinity
  let minLat = Infinity
  let maxLon = -Infinity
  let maxLat = -Infinity
  let n = 0
  eachPosition(f.geometry, (p) => {
    n++
    if (p[0] < minLon) minLon = p[0]
    if (p[0] > maxLon) maxLon = p[0]
    if (p[1] < minLat) minLat = p[1]
    if (p[1] > maxLat) maxLat = p[1]
  })
  return n === 0 ? null : { minLon, minLat, maxLon, maxLat }
}

/**
 * 框选：返回落在矩形里的 `gap_id` 列表。
 *
 * @param visibleClasses **必须传**：只匹配用户当前勾选可见的类别。
 *   少传这一项就会把隐藏的道路 / 水体一起选中 —— 一次批量删除就能把
 *   不可种植地物从交付包里抹掉，而且地图上看不出来。
 * @param mode
 *   - `intersect`（默认）：外接框有重叠就算。适合"框一片区域"。
 *   - `contain`：要素**全部顶点**都在框内才算。适合"精确框住几块"。
 */
export function selectGapsInBox(
  features: GapFeature[],
  bbox: BBox,
  visibleClasses: Record<GapClass, boolean>,
  mode: 'intersect' | 'contain' = 'intersect',
): string[] {
  if (isDegenerateBox(bbox)) return []
  const out: string[] = []
  for (const f of features) {
    const cls = f.properties.class
    if (!visibleClasses[cls]) continue
    const fb = featureBBox(f)
    if (!fb) continue
    if (mode === 'intersect') {
      const overlap =
        fb.minLon <= bbox.maxLon &&
        fb.maxLon >= bbox.minLon &&
        fb.minLat <= bbox.maxLat &&
        fb.maxLat >= bbox.minLat
      if (overlap) out.push(f.properties.gap_id)
    } else {
      const inside =
        fb.minLon >= bbox.minLon &&
        fb.maxLon <= bbox.maxLon &&
        fb.minLat >= bbox.minLat &&
        fb.maxLat <= bbox.maxLat
      if (inside) out.push(f.properties.gap_id)
    }
  }
  return out
}

// ============================================================================
//  复核筛选
// ============================================================================

export type ReviewKind = 'all' | 'uncertain' | 'edited' | 'manual'
export type ReviewOrder = 'area' | 'nearest'

export interface ReviewFilter {
  kind: ReviewKind
  /** 最小面积（m²），0 = 不限制 */
  minArea: number
  /** 自定义输入框的原始文本（空串 = 用上面的预设档位） */
  customArea?: string
  /** 排序模式：'area' 按面积降序（默认）| 'nearest' 就近 */
  order?: ReviewOrder
}

export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  all: '全部',
  uncertain: '待复核',
  edited: '已改过',
  manual: '人工新增',
}

export const REVIEW_ORDER_LABEL: Record<ReviewOrder, string> = {
  area: '按面积',
  nearest: '就近',
}

/** 两个经纬度坐标之间的局部测地距离（m） */
export function distanceM(p1: Position, p2: Position): number {
  const midLat = (p1[1] + p2[1]) / 2
  const { x: mx, y: my } = metersPerDeg(midLat)
  const dx = (p1[0] - p2[0]) * mx
  const dy = (p1[1] - p2[1]) * my
  return Math.hypot(dx, dy)
}

/** 要素是否未复核（U4）：未改过类别或边界、未被复核确认、且不是手工补画 */
export function isUnreviewed(f: GapFeature): boolean {
  return !f.properties.edited && !f.properties.reviewed && f.properties.source !== 'manual'
}

export type SimplifiedAction = 1 | 2 | 3

export interface SimplifiedReviewResult {
  nextClass: GapClass
  edited: boolean
  reviewed: boolean
  classReason?: string
}

/**
 * U4 复核简化模式：三键判定逻辑（纯函数，规则 1~4）。
 *
 * 键 1 (可种)   -> 确需补种 (vacant_slot, open_patch, manual_add)
 * 键 2 (不可种) -> 不计入 (alley_gap, manual_exclude) + 不可种植 (road, water, office, undeveloped)
 * 键 3 (不确定) -> 待复核 (uncertain)
 *
 * 规则 1：当前类别已经在所选组里 -> 类别不动，只记 reviewed: true，不改动 edited
 * 规则 2：选"可种"、但当前不在可种组 -> slot_score >= patch_score 设为 vacant_slot，否则 open_patch；缺失默认 open_patch。edited: true, reviewed: true
 * 规则 3：选"不可种"、但当前在可种组或待复核组 -> 设为 manual_exclude（人工排除）。edited: true, reviewed: true
 * 规则 4：选"不确定" -> 设为 uncertain，reviewed: true。若原本就是 uncertain 则保持 edited 不变；若不是则 edited: true
 */
export function applySimplifiedReview(
  feature: GapFeature,
  action: SimplifiedAction,
): SimplifiedReviewResult {
  const p = feature.properties
  const currentClass = p.class
  const currentGroup = CLASS_STYLES[currentClass]?.group

  // 1: 可种
  if (action === 1) {
    if (currentGroup === 'definite_plant') {
      return {
        nextClass: currentClass,
        edited: p.edited ?? false,
        reviewed: true,
      }
    }
    const slotScore = p.slot_score
    const patchScore = p.patch_score
    let nextClass: GapClass = 'open_patch'
    if (slotScore != null && patchScore != null && slotScore >= patchScore) {
      nextClass = 'vacant_slot'
    }
    return {
      nextClass,
      edited: true,
      reviewed: true,
      classReason: '用户简化复核：可种',
    }
  }

  // 2: 不可种
  if (action === 2) {
    if (currentGroup === 'not_needed' || currentGroup === 'unplantable') {
      return {
        nextClass: currentClass,
        edited: p.edited ?? false,
        reviewed: true,
      }
    }
    return {
      nextClass: 'manual_exclude',
      edited: true,
      reviewed: true,
      classReason: '用户简化复核：不可种（人工排除）',
    }
  }

  // 3: 不确定
  if (currentClass === 'uncertain') {
    return {
      nextClass: 'uncertain',
      edited: p.edited ?? false,
      reviewed: true,
    }
  }
  return {
    nextClass: 'uncertain',
    edited: true,
    reviewed: true,
    classReason: '用户简化复核：存疑待核',
  }
}

/**
 * 寻找下一个最近的未复核地块（U2）：
 * - 如果没有当前选中块（或当前块不在候选集）：从面积最大的未复核块开始；
 * - 如果有当前选中块：找离当前块质心最近的未复核块（排除当前块本身）；
 * - 并列规则（距离相差 < 1e-4 m）：面积大的优先；若面积仍相同，按 gap_id 字典序保证确定性；
 * - 如果没有未复核地块：返回 null。
 */
export function findNextNearestUnreviewed(
  candidates: GapFeature[],
  currentId?: string | null,
): GapFeature | null {
  const unreviewed = candidates.filter(isUnreviewed)
  if (unreviewed.length === 0) return null

  const cur = currentId ? candidates.find((f) => f.properties.gap_id === currentId) : null
  const pool = cur
    ? unreviewed.filter((f) => f.properties.gap_id !== cur.properties.gap_id)
    : unreviewed

  if (pool.length === 0) return null

  if (!cur) {
    // 没有选中块：从面积最大的未复核块开始
    return [...pool].sort((a, b) => {
      const da = (b.properties.area_sqm ?? 0) - (a.properties.area_sqm ?? 0)
      if (Math.abs(da) > 1e-6) return da
      return a.properties.gap_id.localeCompare(b.properties.gap_id)
    })[0]
  }

  const c0 = centroid(cur.geometry)
  let best: GapFeature | null = null
  let bestDist = Infinity
  let bestArea = -Infinity
  let bestId = ''

  for (const f of pool) {
    const c = centroid(f.geometry)
    const dist = distanceM(c0, c)
    const area = f.properties.area_sqm ?? 0
    const id = f.properties.gap_id

    if (best === null) {
      best = f
      bestDist = dist
      bestArea = area
      bestId = id
      continue
    }

    const dDiff = dist - bestDist
    if (dDiff < -1e-4) {
      // 距离更近
      best = f
      bestDist = dist
      bestArea = area
      bestId = id
    } else if (Math.abs(dDiff) <= 1e-4) {
      // 距离并列（< 0.1 mm）：取面积大的
      const aDiff = area - bestArea
      if (aDiff > 1e-6) {
        best = f
        bestDist = dist
        bestArea = area
        bestId = id
      } else if (Math.abs(aDiff) <= 1e-6) {
        // 面积仍并列：取 gap_id 字典序小的保证确定性
        if (id.localeCompare(bestId) < 0) {
          best = f
          bestDist = dist
          bestArea = area
          bestId = id
        }
      }
    }
  }

  return best
}

/**
 * 复核清单。
 *
 * 按面积**降序**：前 30 个大斑块通常占 80% 的争议面积，先清大的收益最高。
 * 这里**不按可见性过滤** —— 用户就是想看被隐藏的「不确定」类，
 * 点进列表时再由 UI 自动把该类别打开。
 */
export function filterReviewGaps(
  features: GapFeature[],
  filter: ReviewFilter,
  currentId?: string | null,
): GapFeature[] {
  const out = features.filter((f) => {
    const p = f.properties
    if ((p.area_sqm ?? 0) < filter.minArea) return false
    if (filter.kind === 'uncertain') return p.class === 'uncertain'
    if (filter.kind === 'edited') return p.edited === true
    if (filter.kind === 'manual') return p.source === 'manual'
    return true
  })

  if (filter.order === 'nearest' && currentId) {
    const cur = features.find((f) => f.properties.gap_id === currentId)
    if (cur) {
      const c0 = centroid(cur.geometry)
      return out.sort((a, b) => {
        if (a.properties.gap_id === currentId) return -1
        if (b.properties.gap_id === currentId) return 1
        const da = distanceM(c0, centroid(a.geometry))
        const db = distanceM(c0, centroid(b.geometry))
        if (Math.abs(da - db) > 1e-4) return da - db
        return (b.properties.area_sqm ?? 0) - (a.properties.area_sqm ?? 0)
      })
    }
  }

  return out.sort((a, b) => (b.properties.area_sqm ?? 0) - (a.properties.area_sqm ?? 0))
}

/** 复核清单上方的计数（不受当前筛选影响，用于显示"有多少待办"） */
export function reviewCounts(features: GapFeature[]): Record<ReviewKind, number> {
  let uncertain = 0
  let edited = 0
  let manual = 0
  for (const f of features) {
    if (f.properties.class === 'uncertain') uncertain++
    if (f.properties.edited === true) edited++
    if (f.properties.source === 'manual') manual++
  }
  return { all: features.length, uncertain, edited, manual }
}
