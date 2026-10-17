import type { GapFeature } from '../types'
import { centroid, pointInGeometry, polygonAreaM2 } from './geometry'

/**
 * 编辑后重跑的合并策略（PRD 附录 C · R-P1-8；交接简报 §12 裁定第 3 条）。
 *
 * 背景：算法重跑会产出一批**全新**的多边形（gap_id 全部重编）。如果直接替换，
 * 用户上一轮手工删掉的误报会「复活」、手工改判的类别会「变回算法判断」——
 * 等于白干。所以重跑时必须能把人工操作**重放**到新结果上。
 *
 * 两档模式（已裁定，不做三选一）：
 *
 * | 模式 | 行为 |
 * |---|---|
 * | `keep_manual`（默认） | 保留全部人工新增；重放删除与改判 |
 * | `overwrite` | 完全回到算法结果，丢弃全部人工痕迹 |
 *
 * ⚠️ 为什么这里**不**算真正的多边形 IoU：前端零依赖（不引 turf/polygon-clipping），
 * 做多边形布尔运算要上百行且容易在自相交几何上崩。这里用两级判据替代：
 *   1. **质心落入**（强判据）：新要素的质心落在旧多边形内 → 同一个对象
 *   2. **外接框 IoU > 0.5 且面积比 ∈ [0.5, 2]**（弱判据）：形状变化较大时兜底
 * 两级都命中不了就当作「新出现的空地」，原样保留。
 * 判据选择会写进 `warnings`，让人能复核"这条重放是不是猜的"。
 */

export type MergeMode = 'keep_manual' | 'overwrite'

export interface MergeContext {
  /** 重跑前前端的全量要素（含人工新增与改判） */
  prevFeatures: GapFeature[]
  /** 被用户删掉的要素快照（需要几何来匹配，所以不是 id 集合） */
  deletedFeatures: GapFeature[]
  /** 算法新跑出来的要素 */
  newFeatures: GapFeature[]
  mode: MergeMode
}

export interface MergeStats {
  /** 保留的人工新增多边形 */
  kept_manual: number
  /** overwrite 模式下丢弃的人工新增 */
  dropped_manual: number
  /** 重放的删除操作（新结果里对应多边形被丢掉） */
  replayed_deletes: number
  /** 重放的类别改判 */
  replayed_edits: number
  /** 原样保留的算法要素 */
  passthrough: number
  total: number
}

export interface MergeResult {
  features: GapFeature[]
  stats: MergeStats
  warnings: string[]
}

/** 匹配判据：centroid=质心落入；bbox=外接框 IoU 兜底；none=不匹配 */
export type MatchKind = 'centroid' | 'bbox' | 'none'

function bboxOf(f: GapFeature): [number, number, number, number] {
  const rings =
    f.geometry.type === 'Polygon' ? f.geometry.coordinates : f.geometry.coordinates.flat()
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return [x0, y0, x1, y1]
}

/** 外接框 IoU（经纬度空间，比值与单位无关，可直接算） */
function bboxIoU(a: GapFeature, b: GapFeature): number {
  const [ax0, ay0, ax1, ay1] = bboxOf(a)
  const [bx0, by0, bx1, by1] = bboxOf(b)
  const ix = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0))
  const iy = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0))
  const inter = ix * iy
  if (inter <= 0) return 0
  const areaA = (ax1 - ax0) * (ay1 - ay0)
  const areaB = (bx1 - bx0) * (by1 - by0)
  const union = areaA + areaB - inter
  return union > 0 ? inter / union : 0
}

/**
 * 判断 `nf`（新要素）是否对应 `old`（旧要素）。
 *
 * 质心落入优先；否则外接框 IoU > 0.5 且面积比在 [0.5, 2] 才认 ——
 * 面积比约束是为了避免"一个大空地框住一堆小空地"时被误判成同一个。
 */
export function matchFeature(nf: GapFeature, old: GapFeature): MatchKind {
  const c = centroid(nf.geometry)
  if (pointInGeometry(c, old.geometry)) return 'centroid'

  const iou = bboxIoU(nf, old)
  if (iou > 0.5) {
    const aNew = nf.properties.area_sqm ?? polygonAreaM2(nf.geometry)
    const aOld = old.properties.area_sqm ?? polygonAreaM2(old.geometry)
    if (aOld > 0) {
      const ratio = aNew / aOld
      if (ratio >= 0.5 && ratio <= 2) return 'bbox'
    }
  }
  return 'none'
}

/** 把旧要素的人工改判「贴」到新要素上（几何/面积用新的，类别用旧的） */
function replayClass(nf: GapFeature, old: GapFeature): GapFeature {
  return {
    ...nf,
    properties: {
      ...nf.properties,
      class: old.properties.class,
      class_label: old.properties.class_label,
      class_reason: old.properties.class_reason ?? '用户手工改判（重跑后重放）',
      original_class: old.properties.original_class ?? nf.properties.class,
      edited: true,
      edited_by: old.properties.edited_by ?? 'user',
      // 留痕：说明这次改判是从哪条旧要素重放过来的
      replayed_from: old.properties.gap_id,
    },
  }
}

export function mergeManualEdits(ctx: MergeContext): MergeResult {
  const warnings: string[] = []
  const stats: MergeStats = {
    kept_manual: 0,
    dropped_manual: 0,
    replayed_deletes: 0,
    replayed_edits: 0,
    passthrough: 0,
    total: 0,
  }

  const manuals = ctx.prevFeatures.filter((f) => f.properties.source === 'manual')

  // ---------- 完全覆盖：丢掉全部人工痕迹 ----------
  if (ctx.mode === 'overwrite') {
    stats.dropped_manual = manuals.length
    stats.passthrough = ctx.newFeatures.length
    stats.total = ctx.newFeatures.length
    if (manuals.length) {
      warnings.push(`完全覆盖：丢弃了 ${manuals.length} 个人工新增多边形`)
    }
    if (ctx.deletedFeatures.length) {
      warnings.push(`完全覆盖：${ctx.deletedFeatures.length} 条删除记录未重放（被删的误报会重新出现）`)
    }
    return { features: [...ctx.newFeatures], stats, warnings }
  }

  // ---------- 保留人工编辑（默认）----------
  const out: GapFeature[] = [...manuals]
  stats.kept_manual = manuals.length

  // 只有「被改判过」的旧要素才需要重放类别（删除的单独处理）
  const editedPrev = ctx.prevFeatures.filter(
    (f) => f.properties.edited === true && f.properties.source !== 'manual',
  )

  for (const nf of ctx.newFeatures) {
    // 1) 先看删除：命中就丢掉（重放"这条是误报"的判断）
    let delHit: { old: GapFeature; how: MatchKind } | null = null
    for (const d of ctx.deletedFeatures) {
      const how = matchFeature(nf, d)
      if (how !== 'none') {
        delHit = { old: d, how }
        break
      }
    }
    if (delHit) {
      stats.replayed_deletes += 1
      if (delHit.how === 'bbox') {
        warnings.push(
          `删除重放用了外接框兜底：${delHit.old.properties.gap_id} → 新 ${nf.properties.gap_id}`,
        )
      }
      continue
    }

    // 2) 再看改判：命中就把旧类别贴回来
    let editHit: { old: GapFeature; how: MatchKind } | null = null
    for (const e of editedPrev) {
      const how = matchFeature(nf, e)
      if (how !== 'none') {
        editHit = { old: e, how }
        break
      }
    }
    if (editHit) {
      out.push(replayClass(nf, editHit.old))
      stats.replayed_edits += 1
      if (editHit.how === 'bbox') {
        warnings.push(
          `改判重放用了外接框兜底：${editHit.old.properties.gap_id} → 新 ${nf.properties.gap_id}`,
        )
      }
      continue
    }

    out.push(nf)
    stats.passthrough += 1
  }

  stats.total = out.length

  // 同一条旧要素被多条新要素命中时，重放会重复生效 —— 提示复核
  if (stats.replayed_deletes > ctx.deletedFeatures.length) {
    warnings.push(
      `删除重放命中 ${stats.replayed_deletes} 条，多于删除记录数 ${ctx.deletedFeatures.length}：` +
        '可能是重跑后一块空地裂成了多块，请复核',
    )
  }
  if (stats.replayed_edits > editedPrev.length) {
    warnings.push(
      `改判重放命中 ${stats.replayed_edits} 条，多于改判记录数 ${editedPrev.length}，请复核`,
    )
  }

  return { features: out, stats, warnings }
}
