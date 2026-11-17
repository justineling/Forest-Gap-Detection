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
  isUnreviewed,
  findNextNearestUnreviewed,
  distanceM,
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

// ---------- H. U2: 就近下一块与未复核判定 ----------
console.log('\nH. U2: 就近下一块（findNextNearestUnreviewed 纯函数单测）')
{
  check(Math.round(distanceM([111.2, 1.19], [111.201, 1.19])) > 100, 'distanceM 测地距离计算正常')

  // 1. isUnreviewed 判据
  const fNormal = feat('G1', 'uncertain', 111.2, 1.19, { area_sqm: 100 })
  const fEdited = feat('G2', 'uncertain', 111.2, 1.19, { area_sqm: 100, edited: true })
  const fManual = feat('G3', 'manual_add', 111.2, 1.19, { area_sqm: 100, source: 'manual' })
  check(isUnreviewed(fNormal), '未编辑要素判定为未复核')
  check(!isUnreviewed(fEdited), 'edited 判定为已复核')
  check(!isUnreviewed(fManual), 'manual 判定为已复核')

  // 构造地块：
  // Base at (111.200, 1.190)
  // Near1 at (111.201, 1.190) - dx ~110m, area 200, edited=true (已复核，应跳过)
  // Near2 at (111.202, 1.190) - dx ~220m, area 300, unreviewed (最近未复核)
  // Far1  at (111.205, 1.190) - dx ~550m, area 1000, unreviewed (最大)
  const base = feat('BASE', 'uncertain', 111.200, 1.190, { area_sqm: 500 })
  const near1_reviewed = feat('N1_DONE', 'uncertain', 111.201, 1.190, { area_sqm: 200, edited: true })
  const near2_unreviewed = feat('N2_UNREV', 'uncertain', 111.202, 1.190, { area_sqm: 300 })
  const far1_large = feat('FAR_MAX', 'uncertain', 111.205, 1.190, { area_sqm: 1000 })
  const pool = [base, near1_reviewed, near2_unreviewed, far1_large]

  // a. 无当前选中块：从面积最大的未复核块开始
  const first = findNextNearestUnreviewed(pool, null)
  check(first?.properties.gap_id === 'FAR_MAX', '★ 无选中块时从面积最大的未复核块开始', first?.properties.gap_id)

  // b. 从 BASE 出发：跳过已复核的 N1_DONE，命中最近未复核的 N2_UNREV
  const nxt = findNextNearestUnreviewed(pool, 'BASE')
  check(nxt?.properties.gap_id === 'N2_UNREV', '★ 空间就近跳过已复核块，选择最近的未复核地块', nxt?.properties.gap_id)

  // c. 确定性测试：多次重复调用结果完全一致
  const call1 = findNextNearestUnreviewed(pool, 'BASE')?.properties.gap_id
  const call2 = findNextNearestUnreviewed(pool, 'BASE')?.properties.gap_id
  const call3 = findNextNearestUnreviewed(pool, 'BASE')?.properties.gap_id
  check(call1 === call2 && call2 === call3, '★ 纯函数执行确定性（多次调用逐次一致）')

  // d. 并列取大测试（距离相同，取面积大的）
  // 两个地块距离 BASE 都是 0.003 度：一个面积 200，一个面积 800
  const tieSmall = feat('TIE_S', 'uncertain', 111.200, 1.193, { area_sqm: 200 })
  const tieLarge = feat('TIE_L', 'uncertain', 111.200, 1.187, { area_sqm: 800 })
  const tiePool = [base, tieSmall, tieLarge]
  const tieResult = findNextNearestUnreviewed(tiePool, 'BASE')
  check(tieResult?.properties.gap_id === 'TIE_L', '★ 距离并列时优先取面积大的地块（TIE_L）', tieResult?.properties.gap_id)

  // e. 距离与面积全并列测试：按 gap_id 字典序保证绝对确定性
  const tieA = feat('TIE_A', 'uncertain', 111.200, 1.193, { area_sqm: 500 })
  const tieB = feat('TIE_B', 'uncertain', 111.200, 1.187, { area_sqm: 500 })
  const tiePoolAB = [base, tieB, tieA] // 故意乱序传入
  const tieResultAB = findNextNearestUnreviewed(tiePoolAB, 'BASE')
  check(tieResultAB?.properties.gap_id === 'TIE_A', '★ 距离与面积均并列时按 gap_id 字典序决胜保证确定性', tieResultAB?.properties.gap_id)

  // f. 全部已复核时返回 null
  const allReviewed = [near1_reviewed, feat('D2', 'uncertain', 111.2, 1.19, { edited: true })]
  check(findNextNearestUnreviewed(allReviewed, null) === null, '全部已复核时返回 null')

  // g. filterReviewGaps 就近排序
  const ordered = filterReviewGaps([base, near2_unreviewed, far1_large], { kind: 'all', minArea: 0, order: 'nearest' }, 'BASE')
  check(ordered[0].properties.gap_id === 'BASE', '就近排序当前选中块排首位')
  check(ordered[1].properties.gap_id === 'N2_UNREV', '第二位是距离最近的块')
  check(ordered[2].properties.gap_id === 'FAR_MAX', '最后是较远的块')
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
