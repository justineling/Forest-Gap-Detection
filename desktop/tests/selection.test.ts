/**
 * 框选与复核筛选的单元测试（Node 直跑，不经浏览器）。
 *
 * 重点覆盖**防盲删护栏**：框选必须只命中当前可见的类别。
 * 这条错了会静默把隐藏的道路 / 水体一起删掉，而地图上看不出来。
 */
import {
  normalizeBBox,
  isDegenerateBox,
  featureBBox,
  selectGapsInBox,
  filterReviewGaps,
  reviewCounts,
} from '../src/lib/selection'
import type { GapClass, GapFeature, GapGeometry } from '../src/types'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 以 (lon, lat) 为左下角、边长 sizeDeg 的方块 */
function boxAt(lon: number, lat: number, sizeDeg = 0.001): GapGeometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + sizeDeg, lat],
        [lon + sizeDeg, lat + sizeDeg],
        [lon, lat + sizeDeg],
        [lon, lat],
      ],
    ],
  }
}

function feat(
  id: string,
  cls: GapClass,
  lon: number,
  lat: number,
  extra: Partial<GapFeature['properties']> = {},
  sizeDeg = 0.001,
): GapFeature {
  return {
    type: 'Feature',
    geometry: boxAt(lon, lat, sizeDeg),
    properties: {
      gap_id: id,
      class: cls,
      class_label: cls,
      area_sqm: 100,
      ...extra,
    },
  }
}

const ALL_VISIBLE = {
  vacant_slot: true,
  open_patch: true,
  alley_gap: true,
  uncertain: true,
  road: true,
  water: true,
  office: true,
  undeveloped: true,
  manual_add: true,
} as Record<GapClass, boolean>

// ---------- A. 矩形基础 ----------
console.log('\nA. 矩形规范化')
{
  const b = normalizeBBox([111.3, 1.20], [111.2, 1.19])
  check(b.minLon === 111.2 && b.maxLon === 111.3, '反向拖拽也能规范化（经度）')
  check(b.minLat === 1.19 && b.maxLat === 1.2, '反向拖拽也能规范化（纬度）')

  check(isDegenerateBox(normalizeBBox([111.2, 1.19], [111.2, 1.19])), '单点框判为退化')
  check(
    !isDegenerateBox(normalizeBBox([111.2, 1.19], [111.2001, 1.1901])),
    '正常框不算退化',
  )
}

// ---------- B. 外接框 ----------
console.log('\nB. 要素外接框')
{
  const f = feat('G1', 'open_patch', 111.2, 1.19)
  const b = featureBBox(f)!
  check(Math.abs(b.minLon - 111.2) < 1e-9 && Math.abs(b.maxLon - 111.201) < 1e-9, '经度范围正确')
  check(Math.abs(b.minLat - 1.19) < 1e-9 && Math.abs(b.maxLat - 1.191) < 1e-9, '纬度范围正确')
}

// ---------- C. 框选 intersect ----------
console.log('\nC. 框选（intersect：有重叠就算）')
{
  const inside = feat('IN', 'open_patch', 111.2005, 1.1905)
  const outside = feat('OUT', 'open_patch', 111.30, 1.30)
  const partial = feat('PART', 'open_patch', 111.2015, 1.1915) // 一半在框外
  const bbox = { minLon: 111.2, minLat: 1.19, maxLon: 111.202, maxLat: 1.192 }

  const ids = selectGapsInBox([inside, outside, partial], bbox, ALL_VISIBLE)
  check(ids.includes('IN'), '完全在框内 → 选中')
  check(!ids.includes('OUT'), '完全在框外 → 不选')
  check(ids.includes('PART'), '部分重叠 → 选中（intersect 语义）')
  check(ids.length === 2, '只返回 2 个', String(ids.length))
}

// ---------- D. 框选 contain ----------
console.log('\nD. 框选（contain：必须整个在框内）')
{
  const inside = feat('IN', 'open_patch', 111.2005, 1.1905)
  const partial = feat('PART', 'open_patch', 111.2015, 1.1915)
  const bbox = { minLon: 111.2, minLat: 1.19, maxLon: 111.202, maxLat: 1.192 }

  const ids = selectGapsInBox([inside, partial], bbox, ALL_VISIBLE, 'contain')
  check(ids.includes('IN'), '整体在框内 → 选中')
  check(!ids.includes('PART'), '部分出框 → 不选（contain 语义）')
}

// ---------- E. ★ 防盲删护栏 ----------
console.log('\nE. ★ 只命中可见类别（防盲删隐藏层）')
{
  // 一块道路 + 一块空地，位置完全一样，都在框里
  const road = feat('ROAD', 'road', 111.2005, 1.1905)
  const water = feat('WATER', 'water', 111.2005, 1.1905)
  const patch = feat('PATCH', 'open_patch', 111.2005, 1.1905)
  const bbox = { minLon: 111.2, minLat: 1.19, maxLon: 111.202, maxLat: 1.192 }

  // 用户只勾选了「确定需补种」两个类别（默认状态）
  const visible = { ...ALL_VISIBLE, road: false, water: false, alley_gap: false, uncertain: false }
  const ids = selectGapsInBox([road, water, patch], bbox, visible)
  check(ids.length === 1 && ids[0] === 'PATCH', '隐藏的道路/水体不被选中', ids.join(','))
  check(!ids.includes('ROAD'), '道路不可被盲删')
  check(!ids.includes('WATER'), '水体不可被盲删')

  // 反证：全部可见时三个都会命中（说明确实是 visibleClasses 在起作用）
  const idsAll = selectGapsInBox([road, water, patch], bbox, ALL_VISIBLE)
  check(idsAll.length === 3, '全部可见时三个都命中（对照组）', String(idsAll.length))
}

// ---------- F. 边界 ----------
console.log('\nF. 边界情况')
{
  const f = feat('G1', 'open_patch', 111.2005, 1.1905)
  const point = normalizeBBox([111.2, 1.19], [111.2, 1.19])
  check(selectGapsInBox([f], point, ALL_VISIBLE).length === 0, '单点框不选中任何东西')
  check(selectGapsInBox([], { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 }, ALL_VISIBLE).length === 0, '空输入返回空')
}

// ---------- G. 复核筛选 ----------
console.log('\nG. 复核清单（按面积降序 + 条件过滤）')
{
  const small = feat('S', 'uncertain', 111.2, 1.19, { area_sqm: 60 })
  const big = feat('B', 'uncertain', 111.2, 1.19, { area_sqm: 1200 })
  const mid = feat('M', 'open_patch', 111.2, 1.19, { area_sqm: 400, edited: true })
  const man = feat('U', 'manual_add', 111.2, 1.19, { area_sqm: 800, source: 'manual' })
  const list = [small, big, mid, man]

  const all = filterReviewGaps(list, { kind: 'all', minArea: 0 })
  check(all.map((f) => f.properties.gap_id).join(',') === 'B,U,M,S', '按面积降序', all.map((f) => f.properties.area_sqm).join(','))

  const unc = filterReviewGaps(list, { kind: 'uncertain', minArea: 0 })
  check(unc.length === 2 && unc[0].properties.gap_id === 'B', '仅看待复核，且大的在前')

  const ed = filterReviewGaps(list, { kind: 'edited', minArea: 0 })
  check(ed.length === 1 && ed[0].properties.gap_id === 'M', '仅看已改过')

  const mn = filterReviewGaps(list, { kind: 'manual', minArea: 0 })
  check(mn.length === 1 && mn[0].properties.gap_id === 'U', '仅看人工新增')

  const bigOnly = filterReviewGaps(list, { kind: 'all', minArea: 500 })
  check(bigOnly.length === 2, '最小面积 500 m² 过滤', String(bigOnly.length))
  check(!bigOnly.some((f) => f.properties.area_sqm! < 500), '过滤后没有小块')

  const c = reviewCounts(list)
  check(c.all === 4 && c.uncertain === 2 && c.edited === 1 && c.manual === 1, '计数正确', JSON.stringify(c))
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
