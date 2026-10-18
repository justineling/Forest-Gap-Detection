/**
 * 编辑后重跑合并策略的回归测试（`lib/mergeEdits.ts`）。
 *
 * 覆盖 PRD 附录 C · R-P1-8 的两档模式与「重放删除 / 重放改判」两条规则。
 * 全部用合成几何（经纬度小方块），不依赖 output/ 里的真实结果 ——
 * 换机器、换数据都能跑。
 *
 * 跑法：npm test（见 package.json）
 */
import { mergeManualEdits, matchFeature } from '../src/lib/mergeEdits'
import { polygonAreaM2 } from '../src/lib/geometry'
import type { GapClass, GapFeature, GapProps } from '../src/types'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 造一个边长约 `size` 米的方块（1e-5 度 ≈ 1.11 m） */
function mkFeature(
  gapId: string,
  lon: number,
  lat: number,
  sizeM: number,
  cls: GapClass = 'open_patch',
  extra: Partial<GapProps> = {},
): GapFeature {
  const d = (sizeM / 111_000) as number
  const ring: Array<[number, number]> = [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ]
  const geom = { type: 'Polygon' as const, coordinates: [ring] }
  return {
    type: 'Feature',
    geometry: geom,
    properties: {
      gap_id: gapId,
      class: cls,
      area_sqm: Math.round(polygonAreaM2(geom) * 10) / 10,
      ...extra,
    },
  }
}

console.log('\n编辑合并策略（mergeManualEdits）')

// ---------- A. 完全覆盖 ----------
console.log('\nA. overwrite（完全覆盖）')
{
  const manual = mkFeature('M0001', 111.20, 1.18, 20, 'manual_add', { source: 'manual' })
  const prev = [mkFeature('G1', 111.201, 1.18, 20), manual]
  const newF = [mkFeature('N1', 111.201, 1.18, 20), mkFeature('N2', 111.202, 1.18, 20)]
  const r = mergeManualEdits({
    prevFeatures: prev,
    deletedFeatures: [mkFeature('G2', 111.203, 1.18, 20)],
    newFeatures: newF,
    mode: 'overwrite',
  })
  check(r.features.length === 2, '只返回算法新要素', `${r.features.length} 个`)
  check(r.stats.dropped_manual === 1, '丢弃人工新增 1 个', String(r.stats.dropped_manual))
  check(r.stats.kept_manual === 0, '不保留人工新增', String(r.stats.kept_manual))
  check(r.features.every((f) => f.properties.source !== 'manual'), '结果里没有 manual_add')
  check(r.warnings.length >= 1, '有提示说明丢弃了什么', `${r.warnings.length} 条`)
}

// ---------- B. 保留人工新增 ----------
console.log('\nB. keep_manual（保留人工新增）')
{
  const manual = mkFeature('M0001', 111.20, 1.18, 20, 'manual_add', { source: 'manual' })
  const r = mergeManualEdits({
    prevFeatures: [mkFeature('G1', 111.201, 1.18, 20), manual],
    deletedFeatures: [],
    newFeatures: [mkFeature('N1', 111.201, 1.18, 20)],
    mode: 'keep_manual',
  })
  check(r.stats.kept_manual === 1, '保留人工新增 1 个', String(r.stats.kept_manual))
  check(r.features.some((f) => f.properties.gap_id === 'M0001'), 'M0001 在结果里')
  check(r.features.length === 2, '总数为 人工1 + 算法1', String(r.features.length))
  check(r.stats.total === 2, 'stats.total 与结果数一致', String(r.stats.total))
}

// ---------- C. 重放删除 ----------
console.log('\nC. 重放删除（用户标为误报的那块不该复活）')
{
  const deleted = mkFeature('G9', 111.2010, 1.1800, 30)
  // 新结果里同一位置换了 id、形状略变（模拟重跑）
  const newSame = mkFeature('N1', 111.20105, 1.18005, 28)
  const newOther = mkFeature('N2', 111.2100, 1.1900, 30)
  const r = mergeManualEdits({
    prevFeatures: [],
    deletedFeatures: [deleted],
    newFeatures: [newSame, newOther],
    mode: 'keep_manual',
  })
  check(r.stats.replayed_deletes === 1, '重放删除 1 次', String(r.stats.replayed_deletes))
  check(!r.features.some((f) => f.properties.gap_id === 'N1'), 'N1 被丢弃（未复活）')
  check(r.features.some((f) => f.properties.gap_id === 'N2'), '远处 N2 正常保留')
  check(r.features.length === 1, '结果只剩 1 个', String(r.features.length))
}

// ---------- D. 不误伤：形状差异大不重放 ----------
console.log('\nD. 不误伤（面积差 16 倍 → 不认作同一块）')
{
  // 同起点、但一个是 10 m 小块、一个是 40 m 大块。
  // 大块质心在 (lon+20m, lat+20m)，落在小块范围之外 → 质心判据不命中；
  // 外接框 IoU = 100/1600 = 0.0625 < 0.5 → 兜底也不命中。
  const deleted = mkFeature('G9', 111.2010, 1.1800, 10)
  const newBig = mkFeature('N1', 111.2010, 1.1800, 40)
  const kind = matchFeature(newBig, deleted)
  check(kind === 'none', '面积差过大时两级判据都不命中', kind)

  const r = mergeManualEdits({
    prevFeatures: [],
    deletedFeatures: [deleted],
    newFeatures: [newBig],
    mode: 'keep_manual',
  })
  check(r.stats.replayed_deletes === 0, '不重放删除（不误伤新出现的大块）', String(r.stats.replayed_deletes))
  check(r.features.length === 1, '新要素原样保留', String(r.features.length))
}

// ---------- E. 重放改判 ----------
console.log('\nE. 重放改判（用户手工改的类别不该被算法改回去）')
{
  const prevEdited = mkFeature('G5', 111.2010, 1.1800, 25, 'alley_gap', {
    edited: true,
    edited_by: 'user',
    original_class: 'open_patch',
    class_reason: '用户手工改判',
  })
  const newSame = mkFeature('N1', 111.20105, 1.18002, 24, 'open_patch')
  const r = mergeManualEdits({
    prevFeatures: [prevEdited],
    deletedFeatures: [],
    newFeatures: [newSame],
    mode: 'keep_manual',
  })
  check(r.stats.replayed_edits === 1, '重放改判 1 次', String(r.stats.replayed_edits))
  const got = r.features.find((f) => f.properties.gap_id === 'N1')
  check(!!got, 'N1 在结果里')
  check(got?.properties.class === 'alley_gap', '类别沿用人工改判值', String(got?.properties.class))
  check(got?.properties.edited === true, '保留 edited 留痕')
  check(
    got?.properties.original_class === 'open_patch',
    'original_class 保留算法原判',
    String(got?.properties.original_class),
  )
  check(
    got?.properties.replayed_from === 'G5',
    'replayed_from 指向旧要素（可追溯）',
    String(got?.properties.replayed_from),
  )
  check(
    typeof got?.properties.area_sqm === 'number' && (got?.properties.area_sqm ?? 0) > 0,
    '面积用新几何重算（不是沿用旧的）',
    String(got?.properties.area_sqm),
  )
}

// ---------- F. 未编辑的旧要素不参与重放 ----------
console.log('\nF. 只重放「被编辑过」的（edited 不为 true 的旧要素不生效）')
{
  const prevPlain = mkFeature('G7', 111.2010, 1.1800, 25, 'open_patch')
  const newSame = mkFeature('N1', 111.20105, 1.18002, 24, 'open_patch')
  const r = mergeManualEdits({
    prevFeatures: [prevPlain],
    deletedFeatures: [],
    newFeatures: [newSame],
    mode: 'keep_manual',
  })
  check(r.stats.replayed_edits === 0, '没有改判可重放', String(r.stats.replayed_edits))
  check(r.stats.passthrough === 1, '新要素原样透传', String(r.stats.passthrough))
  check(
    r.features[0].properties.class === 'open_patch' &&
      r.features[0].properties.edited === undefined,
    '结果没有多出 edited 痕迹',
  )
}

// ---------- G. 空输入 ----------
console.log('\nG. 空输入与边界')
{
  const r1 = mergeManualEdits({
    prevFeatures: [],
    deletedFeatures: [],
    newFeatures: [],
    mode: 'keep_manual',
  })
  check(r1.features.length === 0 && r1.stats.total === 0, '全空 → 空结果')

  const onlyManual = mkFeature('M1', 111.2, 1.18, 20, 'manual_add', { source: 'manual' })
  const r2 = mergeManualEdits({
    prevFeatures: [onlyManual],
    deletedFeatures: [],
    newFeatures: [],
    mode: 'keep_manual',
  })
  check(r2.features.length === 1, '只有人工新增、算法无结果 → 仍保留人工', String(r2.features.length))
}

// ---------- H. 删除与改判冲突时删除优先 ----------
console.log('\nH. 冲突处理：同一块既被删过又被改判过 → 删除优先')
{
  const deleted = mkFeature('G9', 111.2010, 1.1800, 25)
  const edited = mkFeature('G5', 111.2010, 1.1800, 25, 'alley_gap', {
    edited: true,
    edited_by: 'user',
    original_class: 'open_patch',
  })
  const newSame = mkFeature('N1', 111.20102, 1.18002, 25, 'open_patch')
  const r = mergeManualEdits({
    prevFeatures: [edited],
    deletedFeatures: [deleted],
    newFeatures: [newSame],
    mode: 'keep_manual',
  })
  check(r.stats.replayed_deletes === 1 && r.stats.replayed_edits === 0, '删除优先于改判')
  check(r.features.length === 0, '该块被丢弃', String(r.features.length))
}

// ---------- I. 一条删除命中多块 → 给出复核提示 ----------
console.log('\nI. 一条删除命中多块（重跑后裂开）→ 提示复核')
{
  const deleted = mkFeature('G9', 111.2010, 1.1800, 60)
  const a = mkFeature('N1', 111.20100, 1.18000, 25)
  const b = mkFeature('N2', 111.20130, 1.18030, 25)
  const r = mergeManualEdits({
    prevFeatures: [],
    deletedFeatures: [deleted],
    newFeatures: [a, b],
    mode: 'keep_manual',
  })
  check(r.stats.replayed_deletes === 2, '两块都被重放删除', String(r.stats.replayed_deletes))
  check(
    r.warnings.some((w) => w.includes('多于删除记录数')),
    '给出「多于删除记录数」的复核提示',
    r.warnings.join(' | '),
  )
}

console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
