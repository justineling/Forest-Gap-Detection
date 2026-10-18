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
// 2026-10-18 语义调整：改判类别也算一次编辑（以前只统计改边界，状态栏的 ✎ 会漏数）
// 本段共 2 次改判（uncertain / vacant_slot）+ 1 次改边界
check(st.manualEdited === 3, '编辑计数 = 3（2 次改判 + 1 次改边界）', `实际 ${st.manualEdited}`)
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

// ---------- 检测状态（P0 检测面板） ----------
console.log('\n⑦ 检测进度与参数 —— 进度条的数据源必须可靠')
{
  const S3 = useAppStore
  S3.getState().detectReset()

  // 1) 未开始时不该显示进度条
  check(S3.getState().detect.running === false, '初始未运行')
  check(S3.getState().detect.finished === null, '初始没有结束态')

  // 2) started → running
  S3.getState().detectBegin()
  check(S3.getState().detect.running === true, 'detectBegin 置为运行中')
  check(S3.getState().detect.startedAt !== null, '记录了开始时间')

  // 3) progress 必须逐字段合并（sidecar 的字段名是 snake_case）
  S3.getState().detectProgress({
    stage: 'tile_processing',
    done: 128,
    total: 528,
    ratio: 0.2424,
    elapsed_s: 84.5,
    eta_s: 264,
    gaps_found: 312,
    gap_area_sqm: 88_500,
  })
  const d = S3.getState().detect
  check(d.done === 128 && d.total === 528, '进度数已更新', `${d.done}/${d.total}`)
  check(Math.abs(d.ratio - 0.2424) < 1e-9, 'ratio 已更新')
  check(d.etaS === 264, 'ETA 已更新（用于"预计剩余"）', String(d.etaS))
  check(d.gapsFound === 312, '已发现空地数已更新', String(d.gapsFound))
  check(d.elapsedS === 84.5, 'elapsed_s → elapsedS 映射正确')

  // 4) done=0 是合法值，不能被 `||` 吞掉（踩过这种坑：进度条永远不动）
  S3.getState().detectProgress({ done: 0, total: 528, ratio: 0 })
  check(S3.getState().detect.done === 0, 'done=0 不被当成"没传"', String(S3.getState().detect.done))

  // 5) 部分字段缺失时保留旧值，不能把 total 清成 0
  S3.getState().detectProgress({ done: 300 })
  check(
    S3.getState().detect.total === 528,
    '只传 done 时 total 保持旧值',
    String(S3.getState().detect.total),
  )

  // 6) 结束
  S3.getState().detectFinish({
    ok: true,
    elapsedS: 350.2,
    gaps: 1443,
    areaSqm: 383_426,
    message: '1,443 块空地',
  })
  const f = S3.getState().detect
  check(f.running === false, '结束后 running=false')
  check(f.finished?.ok === true && f.finished.gaps === 1443, '结束态记录块数', String(f.finished?.gaps))
  check(f.stage === 'done', 'stage 变为 done', f.stage)

  // 7) 失败态
  S3.getState().detectFinish({ ok: false, elapsedS: 0, gaps: 0, areaSqm: 0, message: '[E3001] 没有可处理的瓦片' })
  check(S3.getState().detect.finished?.ok === false, '失败态可记录')
  check(S3.getState().detect.stage === 'failed', 'stage 变为 failed')

  // 8) 关闭 → 完全清空（进度条不占位置）
  S3.getState().detectReset()
  check(S3.getState().detect.finished === null, 'detectReset 清掉结束态')

  // 9) 参数：默认值 + 修改
  const p0 = S3.getState().detectParams
  check(p0.workers === 4 && p0.targetDensity === 150, '默认参数 4 进程 / 150 株', JSON.stringify(p0))
  S3.getState().setDetectParam({ workers: 6 })
  check(S3.getState().detectParams.workers === 6, '参数可改')
  check(S3.getState().detectParams.targetDensity === 150, '改一个不影响另一个')
  S3.getState().setDetectParam({ workers: 4, targetDensity: 150, useRoi: true })
}

// ---------- 撤销 / 重做 + 批量操作（P1） ----------
console.log('\n⑧ 撤销/重做与批量操作 —— 批量必须算一步')
{
  const S = useAppStore
  const f1 = feat('U1', 'open_patch', 111.20, 1.19)
  const f2 = feat('U2', 'open_patch', 111.21, 1.19)
  const f3 = feat('U3', 'open_patch', 111.22, 1.19)
  S.getState().setGaps([f1, f2, f3], null)
  check(S.getState().past.length === 0, '载入新结果清空历史')

  // ---- 单块删除 + 撤销 ----
  S.getState().deleteGap('U1')
  check(S.getState().gaps.length === 2, '删除后剩 2 块')
  check(S.getState().past.length === 1, '压入 1 步历史')
  S.getState().undo()
  check(S.getState().gaps.length === 3, '撤销后恢复 3 块')
  check(
    S.getState().gaps.some((f) => f.properties.gap_id === 'U1'),
    'U1 回来了',
  )
  check(S.getState().future.length === 1, '重做栈有 1 步')
  S.getState().redo()
  check(S.getState().gaps.length === 2, '重做后又是 2 块')

  // ---- ★ 批量删除：一次操作 = 一步撤销 ----
  S.getState().setGaps([f1, f2, f3], null)
  const before = S.getState().past.length
  S.getState().batchDeleteGaps(['U1', 'U2', 'U3'])
  check(S.getState().gaps.length === 0, '批量删完是 0 块')
  check(
    S.getState().past.length === before + 1,
    '批量删 3 块只压 1 步（不是 3 步）',
    `${before} → ${S.getState().past.length}`,
  )
  S.getState().undo()
  check(
    S.getState().gaps.length === 3,
    '★ 按一次 Ctrl+Z 三块全部恢复',
    String(S.getState().gaps.length),
  )

  // ---- 批量改判 ----
  S.getState().setGaps([f1, f2, f3], null)
  const me0 = S.getState().manualEdited
  S.getState().batchSetClass(['U1', 'U2'], 'undeveloped')
  const changed = S.getState().gaps.filter((f) => f.properties.class === 'undeveloped')
  check(changed.length === 2, '两块被改判', String(changed.length))
  check(
    changed.every((f) => f.properties.edited === true && f.properties.original_class === 'open_patch'),
    '改判留痕：edited + original_class',
  )
  check(
    S.getState().manualEdited === me0 + 2,
    '人工改判计数 +2（相对增量，不受前面用例累计影响）',
    `${me0} → ${S.getState().manualEdited}`,
  )
  S.getState().undo()
  const back = S.getState().gaps.filter((f) => f.properties.class === 'open_patch')
  check(back.length === 3, '撤销后全部回到连片空地', String(back.length))

  // ---- 改判成同一类别：不该产生历史 ----
  const pastN = S.getState().past.length
  S.getState().batchSetClass(['U1'], 'open_patch')
  check(S.getState().past.length === pastN, '无实际变化时不压历史')

  // ---- 新操作清空重做栈 ----
  S.getState().setGaps([f1, f2, f3], null)
  S.getState().deleteGap('U1')
  S.getState().undo()
  check(S.getState().future.length === 1, '撤销后有可重做项')
  S.getState().deleteGap('U2')
  check(S.getState().future.length === 0, '新操作清空重做栈（避免时间线分叉）')

  // ---- 历史上限 ----
  S.getState().setGaps([f1, f2, f3], null)
  for (let i = 0; i < 45; i++) {
    S.getState().setGapClass('U1', i % 2 === 0 ? 'alley_gap' : 'open_patch')
  }
  check(S.getState().past.length === 40, '历史栈封顶 40 步', String(S.getState().past.length))

  // ---- 多选 ----
  S.getState().setGaps([f1, f2, f3], null)
  S.getState().select('U1')
  check(S.getState().selectedIds.length === 1 && S.getState().selectedId === 'U1', '单选')
  S.getState().toggleSelect('U2')
  check(S.getState().selectedIds.length === 2, 'Shift 点击加选', S.getState().selectedIds.join(','))
  check(S.getState().selectedId === null, '多选时 selectedId 为 null（属性面板不误显示单块）')
  S.getState().toggleSelect('U1')
  check(S.getState().selectedIds.length === 1, '再点一次减选')
  check(S.getState().selectedId === 'U2', '剩一个时 selectedId 自动回填')
  S.getState().selectMany(['U1', 'U2', 'U3'])
  check(S.getState().selectedIds.length === 3, '框选整体替换选择')
  S.getState().clearSelection()
  check(S.getState().selectedIds.length === 0 && S.getState().selectedId === null, '清空选择')

  // ---- 删除时同步收缩选择集 ----
  S.getState().selectMany(['U1', 'U2'])
  S.getState().deleteGap('U1')
  check(
    S.getState().selectedIds.length === 1 && S.getState().selectedIds[0] === 'U2',
    '删掉的那块从选择集里移除',
    S.getState().selectedIds.join(','),
  )

  // ---- ★ 拖拽顶点：连续几十次 change 只能算一步 ----
  S.getState().setGaps([f1, f2, f3], null)
  const pastDrag = S.getState().past.length
  for (let i = 0; i < 12; i++) {
    S.getState().updateGapGeometry('U1', squareAt(111.2 + i * 0.00001, 1.19, 40))
  }
  check(
    S.getState().past.length === pastDrag + 1,
    '★ 连续 12 次几何更新只压 1 步（拖一次 = 撤销一次）',
    `${pastDrag} → ${S.getState().past.length}`,
  )
  S.getState().undo()
  check(
    S.getState().gaps.find((f) => f.properties.gap_id === 'U1')?.properties.edited !== true,
    '撤销一次即回到拖拽前（而不是回退一小段）',
  )

  // ---- 聚焦（复核清单） ----
  S.getState().focusGap('U3')
  const n1 = S.getState().focus?.nonce ?? 0
  S.getState().focusGap('U3')
  const n2 = S.getState().focus?.nonce ?? 0
  check(n2 > n1, '连续点同一块也会触发飞行（nonce 递增）', `${n1} → ${n2}`)
  check(S.getState().selectedId === 'U3', '聚焦同时选中')

  S.getState().setGaps([], null)
}

// ---------- 汇总 ----------
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
