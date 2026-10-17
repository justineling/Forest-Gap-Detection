/**
 * 状态层验证 / 回归测试（Node 直跑，不经浏览器）。
 *
 * 覆盖需求③（按类别过滤）与需求④（增删改 + 人工留痕）——
 * 这两项是纯逻辑，不需要 DOM，因此可以在 Node 里完整验证。
 *
 * 不依赖 output/（用构造的小要素），随时可跑。
 */
import { useAppStore, selectVisibleGaps } from '../src/store/useAppStore'
import { estimate } from '../src/lib/estimate'
import type { GapClass, GapFeature, PolygonGeometry } from '../src/types'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 构造一个边长 ~85 m 的方形（约 7,225 m²），位于马来西亚砂拉越园区范围内 */
function squareAt(lon: number, lat: number, sizeM = 85): PolygonGeometry {
  const mPerDegLat = 110577
  const mPerDegLon = 110577 * Math.cos((lat * Math.PI) / 180)
  const dLat = sizeM / mPerDegLat
  const dLon = sizeM / mPerDegLon
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + dLon, lat],
        [lon + dLon, lat + dLat],
        [lon, lat + dLat],
        [lon, lat],
      ],
    ],
  }
}

function feat(id: string, cls: GapClass, lon: number, lat: number): GapFeature {
  const geometry = squareAt(lon, lat)
  return {
    type: 'Feature',
    geometry,
    properties: {
      gap_id: id,
      class: cls,
      class_label: cls,
      area_sqm: 7225,
      centroid_utm: [lon, lat],
    },
  }
}

const S = useAppStore

console.log('\n初始化状态')
S.getState().setGaps([
  feat('A0001', 'open_patch', 111.2000, 1.1800),
  feat('A0002', 'vacant_slot', 111.2020, 1.1810),
  feat('A0003', 'road', 111.2040, 1.1820),
  feat('A0004', 'alley_gap', 111.2060, 1.1830),
])
check(S.getState().gaps.length === 4, '载入 4 个要素', `实际 ${S.getState().gaps.length}`)

// ---------- 需求③ 默认可见性 ----------
console.log('\n③ 按类别过滤（默认只显示"确定需补种"）')
const vis = S.getState().visibleClasses
check(vis.open_patch && vis.vacant_slot, 'open_patch / vacant_slot 默认可见')
check(!vis.road && !vis.alley_gap, 'road / alley_gap 默认隐藏')
const shown = selectVisibleGaps(S.getState())
check(shown.length === 2, '默认可见要素数 = 2', `实际 ${shown.length}`)

S.getState().toggleClass('road')
check(selectVisibleGaps(S.getState()).length === 3, '勾选 road 后可见数 = 3')

// alley_gap 属于 not_needed 组（不是 unplantable），所以要勾它自己的组
S.getState().setGroupVisible('not_needed', true)
check(
  selectVisibleGaps(S.getState()).length === 4,
  '整组勾选"不计入"后可见数 = 4',
  `实际 ${selectVisibleGaps(S.getState()).length}`,
)

// 整组取消：unplantable 组只有 road，取消后应回到 3
S.getState().setGroupVisible('unplantable', false)
check(
  selectVisibleGaps(S.getState()).length === 3,
  '整组取消"不可种植"后可见数 = 3',
  `实际 ${selectVisibleGaps(S.getState()).length}`,
)
check(!S.getState().visibleClasses.road, '取消整组后 road 也被取消')
check(S.getState().visibleClasses.alley_gap, '取消 unplantable 组不影响 not_needed 组')
S.getState().setGroupVisible('unplantable', true)

// ---------- 需求④ 新增 ----------
console.log('\n④ 人工新增')
const newId = S.getState().addGap(squareAt(111.2080, 1.1840, 60))
const added = S.getState().gaps.find((f) => f.properties.gap_id === newId)
check(!!added, '新增成功并返回 id', newId)
check(added?.properties.class === 'manual_add', '新要素类别 = manual_add')
check(added?.properties.source === 'manual', '新要素 source = manual')
check(added?.properties.edited === true, '新要素标记 edited')
check(
  Math.abs((added?.properties.area_sqm ?? 0) - 3600) < 120,
  '新增面积按几何重算（60×60 = 3,600 m²，容差 120）',
  `实际 ${added?.properties.area_sqm} m²`,
)

// 人工新增必须计入"确定需补种"（否则用户画了却不算数）
const estAfterAdd = estimate(S.getState().gaps)
check(
  estAfterAdd.per_gap.some((r) => r.gap_id === newId),
  '新增的多边形参与估算（被识别为可种植）',
)
check(
  estAfterAdd.points.some((p) => p.gap_id === newId),
  '新增的多边形产出了补种点位',
)

// ---------- 需求④ 改判 ----------
console.log('\n④ 改判类别（original_class 必须保留原值）')
S.getState().setGapClass('A0001', 'uncertain')
const changed = S.getState().gaps.find((f) => f.properties.gap_id === 'A0001')
check(changed?.properties.class === 'uncertain', '类别已改为 uncertain')
check(
  changed?.properties.original_class === 'open_patch',
  'original_class 记录的是原值 open_patch（不是被自己覆盖）',
  `实际 ${changed?.properties.original_class}`,
)
check(changed?.properties.edited === true, '标记 edited')

// 二次改判：original_class 应保持最初的值
S.getState().setGapClass('A0001', 'vacant_slot')
const changed2 = S.getState().gaps.find((f) => f.properties.gap_id === 'A0001')
check(
  changed2?.properties.original_class === 'open_patch',
  '二次改判后 original_class 仍是最初的 open_patch',
  `实际 ${changed2?.properties.original_class}`,
)

// ---------- 需求④ 改边界 ----------
console.log('\n④ 修改边界')
const before = S.getState().gaps.find((f) => f.properties.gap_id === 'A0002')!
S.getState().updateGapGeometry('A0002', squareAt(111.2020, 1.1810, 60))
const after = S.getState().gaps.find((f) => f.properties.gap_id === 'A0002')!
check(
  (after.properties.area_sqm ?? 0) < (before.properties.area_sqm ?? 0),
  '改小边界后面积下降',
  `${before.properties.area_sqm} → ${after.properties.area_sqm} m²`,
)
check(after.properties.edited === true, '标记 edited')
check(
  after.properties.original_class === 'vacant_slot',
  'original_class 记录原类别 vacant_slot',
)

// ---------- 需求④ 删除 ----------
console.log('\n④ 删除')
S.getState().select('A0003')
S.getState().deleteGap('A0003')
check(
  !S.getState().gaps.some((f) => f.properties.gap_id === 'A0003'),
  '要素已从列表移除',
)
check(S.getState().selectedId === null, '删除后清空选中')
check(S.getState().manualDeleted === 1, '删除计数 +1', `实际 ${S.getState().manualDeleted}`)

// ---------- 编辑留痕汇总 ----------
console.log('\n④ 编辑留痕计数（状态栏展示）')
const st = S.getState()
check(st.manualAdded === 1, '新增计数 = 1', `实际 ${st.manualAdded}`)
check(st.manualEdited === 1, '改边界计数 = 1', `实际 ${st.manualEdited}`)
check(st.manualDeleted === 1, '删除计数 = 1', `实际 ${st.manualDeleted}`)
check(S.getState().logs.length > 0, '日志已记录操作', `${S.getState().logs.length} 条`)

// ---------- 估算联动：编辑后应清空旧结果 ----------
console.log('\n⑤ 编辑后估算结果失效（避免展示过期数字）')
S.getState().runEstimate()
check(!!S.getState().estimateResult, 'runEstimate 产出结果')
S.getState().addGap(squareAt(111.2100, 1.1850, 50))
check(
  S.getState().estimateResult === null,
  '新增要素后旧的估算结果被清空',
)

// ---------- 重跑合并（序 5）：store 层集成 ----------
console.log('\n⑥ 重跑合并（applyRerun）—— 删除与改判要能被重放')
{
  const S2 = useAppStore
  // 造两个算法要素：A 会被用户删掉，B 会被改判
  const a = feat('A1', 'open_patch', 111.2200, 1.1900)
  const b = feat('B1', 'open_patch', 111.2300, 1.1900)
  S2.getState().setGaps([a, b], null)

  // 用户操作：删 A、把 B 改判成「林间空隙」
  S2.getState().deleteGap('A1')
  S2.getState().setGapClass('B1', 'alley_gap')
  check(S2.getState().deletedFeatures.length === 1, '删除后留下快照（用于重放）', String(S2.getState().deletedFeatures.length))

  // 算法重跑：同一位置出了新 id（A2/B2），形状略变
  const a2 = feat('A2', 'open_patch', 111.22003, 1.19003)
  const b2 = feat('B2', 'open_patch', 111.23003, 1.19003)
  const stats = S2.getState().applyRerun([a2, b2], 'keep_manual')

  check(stats.replayed_deletes === 1, '重放删除 1 次', String(stats.replayed_deletes))
  check(stats.replayed_edits === 1, '重放改判 1 次', String(stats.replayed_edits))
  const ids = S2.getState().gaps.map((f) => f.properties.gap_id)
  check(!ids.includes('A2'), 'A2 被丢弃（用户标为误报的那块没复活）', ids.join(','))
  check(ids.includes('B2'), 'B2 保留')
  const b2feat = S2.getState().gaps.find((f) => f.properties.gap_id === 'B2')
  check(
    b2feat?.properties.class === 'alley_gap',
    'B2 的类别沿用用户改判值（没被算法改回去）',
    String(b2feat?.properties.class),
  )
  check(
    b2feat?.properties.replayed_from === 'B1',
    '留痕 replayed_from 指向旧 id',
    String(b2feat?.properties.replayed_from),
  )
  check(S2.getState().deletedFeatures.length === 0, '合并后换基线：删除记录清空')

  // 完全覆盖：人工痕迹全丢
  S2.getState().deleteGap('B2')
  const st2 = S2.getState().applyRerun([feat('C1', 'open_patch', 111.2400, 1.1900)], 'overwrite')
  check(st2.replayed_deletes === 0 && st2.replayed_edits === 0, 'overwrite 不重放任何人工操作')
  check(S2.getState().gaps.length === 1, 'overwrite 只留算法结果', String(S2.getState().gaps.length))
}

// ---------- 汇总 ----------
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
