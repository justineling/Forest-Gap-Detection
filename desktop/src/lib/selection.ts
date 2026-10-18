import type { GapClass, GapFeature, Position } from '../types'

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

export interface ReviewFilter {
  kind: ReviewKind
  /** 最小面积（m²），0 = 不限制 */
  minArea: number
}

export const REVIEW_KIND_LABEL: Record<ReviewKind, string> = {
  all: '全部',
  uncertain: '待复核',
  edited: '已改过',
  manual: '人工新增',
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
): GapFeature[] {
  const out = features.filter((f) => {
    const p = f.properties
    if ((p.area_sqm ?? 0) < filter.minArea) return false
    if (filter.kind === 'uncertain') return p.class === 'uncertain'
    if (filter.kind === 'edited') return p.edited === true
    if (filter.kind === 'manual') return p.source === 'manual'
    return true
  })
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
