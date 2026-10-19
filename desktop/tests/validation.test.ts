/**
 * 验证集抽样与评估的单元测试（Node 直跑）。
 *
 * 这份测试的重点不是"能跑通"，而是**三条会静默出错的约束**：
 *
 * 1. **确定性** —— 同输入必须出同一套 150 块。换机器、重跑、半年后再看都一样。
 *    否则"上次 82%、这次 85%"无法判断是算法改进了还是抽样变了 —— 那验证集就没意义了。
 * 2. **权重正确** —— 逆概率权重算错的后果是"看起来有准确率，但那个数不是全园的"。
 *    它不会报错，只会给出一个错的数字，这比没有更糟。
 * 3. **不重叠、不超配额** —— 同一块被抽两次会重复计权，准确率被拉偏。
 */
import {
  buildValidationSample,
  canConfirm,
  classToGt,
  evaluate,
  labeledCount,
  nextUnlabeled,
  type GtRecord,
  type GtSample,
} from '../src/lib/validation'
import type { GapFeature, GapClass } from '../src/types'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 造一块空地（只填抽样/评估关心的字段） */
function gap(id: string, cls: GapClass, area: number): GapFeature {
  return {
    type: 'Feature',
    properties: {
      gap_id: id,
      class: cls,
      class_label: cls,
      area_sqm: area,
      centroid_utm: [0, 0],
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [111.2, 1.18],
          [111.201, 1.18],
          [111.201, 1.181],
          [111.2, 1.181],
          [111.2, 1.18],
        ],
      ],
    },
  } as GapFeature
}

/** 造一批贴近真实比例的样本（1,726 块的缩比版） */
function realisticSet(): GapFeature[] {
  const out: GapFeature[] = []
  // open_patch 449 块（面积从大到小）
  for (let i = 0; i < 449; i++) {
    out.push(gap(`open-${String(i).padStart(4, '0')}`, 'open_patch', 5000 - i * 8))
  }
  // vacant_slot 253
  for (let i = 0; i < 253; i++) {
    out.push(gap(`slot-${String(i).padStart(4, '0')}`, 'vacant_slot', 120 - i * 0.1))
  }
  // uncertain 465
  for (let i = 0; i < 465; i++) {
    out.push(gap(`unc-${String(i).padStart(4, '0')}`, 'uncertain', 200 - i * 0.1))
  }
  // alley_gap 251
  for (let i = 0; i < 251; i++) {
    out.push(gap(`alley-${String(i).padStart(4, '0')}`, 'alley_gap', 45 + i * 0.05))
  }
  // 不可种植 308（road 180 + water 21 + office 82 + undeveloped 25）
  const unplant: Array<[string, number]> = [
    ['road', 180],
    ['water', 21],
    ['office', 82],
    ['undeveloped', 25],
  ]
  for (const [cls, n] of unplant) {
    for (let i = 0; i < n; i++) {
      out.push(gap(`${cls}-${String(i).padStart(3, '0')}`, cls as GapClass, 300 + i))
    }
  }
  return out
}

// ---------- A. 确定性与配额 ----------
console.log('\nA. 确定性与配额')
{
  const feats = realisticSet()
  const s1 = buildValidationSample(feats)
  const s2 = buildValidationSample(feats)
  check(
    JSON.stringify(s1) === JSON.stringify(s2),
    '★ 同输入两次调用结果完全一致（确定性）',
    `${s1.length} 块`,
  )

  const s3 = buildValidationSample(feats, 7)
  check(
    JSON.stringify(s1) !== JSON.stringify(s3),
    '换 seed 得到不同样本（证明 seed 真的起作用）',
  )

  // 顺序无关：打乱输入，结果必须一样
  const shuffled = feats.slice().reverse()
  const s4 = buildValidationSample(shuffled)
  check(
    JSON.stringify(s1) === JSON.stringify(s4),
    '★ 输入顺序无关（后端扫目录顺序变了也不影响）',
  )

  check(s1.length === 150, '共 150 块', String(s1.length))

  const byStratum: Record<string, number> = {}
  for (const x of s1) byStratum[x.stratum] = (byStratum[x.stratum] ?? 0) + 1
  check(byStratum.L1_top_area === 40, 'L1 = 40 块', String(byStratum.L1_top_area))
  check(byStratum.L2_uncertain === 60, 'L2 = 60 块', String(byStratum.L2_uncertain))
  check(
    byStratum.L3_plantable === 25 && byStratum.L3_alley === 15 && byStratum.L3_unplantable === 10,
    'L3 = 25 / 15 / 10',
    `${byStratum.L3_plantable}/${byStratum.L3_alley}/${byStratum.L3_unplantable}`,
  )

  const ids = new Set(s1.map((x) => x.gap_id))
  check(ids.size === 150, '★ 无重复块（重复会重复计权，把准确率拉偏）', String(ids.size))
}

// ---------- B. 权重 ----------
console.log('\nB. 逆概率权重（算错会给出"看起来对但是全园"的错数字）')
{
  const s = buildValidationSample(realisticSet())

  const l1 = s.filter((x) => x.stratum === 'L1_top_area')
  check(
    l1.every((x) => x.weight === 1),
    'L1 必抽 → 权重恰好 1.0',
    `样例 ${l1[0]?.weight}`,
  )

  const l2 = s.filter((x) => x.stratum === 'L2_uncertain')
  // uncertain 总 465，抽 60 → 权重 7.75
  check(
    Math.abs((l2[0]?.weight ?? 0) - 465 / 60) < 1e-9,
    'L2 权重 = N/n = 465/60',
    String(l2[0]?.weight),
  )
  check(
    l2.every((x) => x.stratum_total === 465 && x.stratum_sampled === 60),
    'L2 每块都记了 N 与 n（供事后核对）',
  )

  const l3a = s.filter((x) => x.stratum === 'L3_plantable')
  // L3a 池 = open_patch(449-40=409) + vacant_slot(253) = 662，抽 25
  check(
    l3a[0]?.stratum_total === 662,
    '★ L3a 的池子已排除 L1 选走的 40 块（否则权重偏小）',
    String(l3a[0]?.stratum_total),
  )

  const l3c = s.filter((x) => x.stratum === 'L3_unplantable')
  check(
    l3c[0]?.stratum_total === 308,
    'L3c 池 = 4 个不可种植类合并 308',
    String(l3c[0]?.stratum_total),
  )
}

// ---------- C. L1 真的是面积最大的 ----------
console.log('\nC. L1 选的是面积最大的 40 块')
{
  const feats = realisticSet()
  const s = buildValidationSample(feats)
  const l1 = s.filter((x) => x.stratum === 'L1_top_area')
  const allOpen = feats
    .filter((f) => f.properties.class === 'open_patch')
    .sort((a, b) => b.properties.area_sqm! - a.properties.area_sqm!)
  const top40 = new Set(allOpen.slice(0, 40).map((f) => f.properties.gap_id))
  check(
    l1.every((x) => top40.has(x.gap_id)),
    'L1 全部落在"面积前 40"里',
  )
  check(
    Math.min(...l1.map((x) => x.area_sqm)) >=
      Math.max(...allOpen.slice(40).map((f) => f.properties.area_sqm!)),
    'L1 最小面积 ≥ 其余 open_patch 最大面积（确实是 top40）',
  )
  // 输出按面积降序
  check(
    s.every((x, i) => i === 0 || s[i - 1].area_sqm >= x.area_sqm),
    '输出按面积降序（用户先看大的，收益最高）',
  )
}

// ---------- D. classToGt 映射 ----------
console.log('\nD. 算法类别 → 真值等价类')
{
  check(classToGt('open_patch') === 1, 'open_patch → 1 真需补种')
  check(classToGt('vacant_slot') === 1, 'vacant_slot → 1')
  check(classToGt('manual_add') === 1, 'manual_add → 1')
  check(classToGt('alley_gap') === 2, 'alley_gap → 2 无需补种')
  check(classToGt('road') === 3, 'road → 3 不可种植')
  check(classToGt('water') === 3, 'water → 3')
  check(classToGt('undeveloped') === 3, 'undeveloped → 3')
  check(classToGt('uncertain') === 4, 'uncertain → 4（算法自己也没定论）')
}

// ---------- E. 评估指标 ----------
console.log('\nE. 评估：三种准确率 + 混淆矩阵 + 需补种口径')
{
  // 手造 4 块，权重已知，便于手算
  const samples: GtSample[] = [
    { gap_id: 'a', stratum: 'L1_top_area', weight: 1, algo_class: 'open_patch', area_sqm: 100, stratum_total: 40, stratum_sampled: 40 },
    { gap_id: 'b', stratum: 'L2_uncertain', weight: 7, algo_class: 'uncertain', area_sqm: 50, stratum_total: 465, stratum_sampled: 60 },
    { gap_id: 'c', stratum: 'L3_alley', weight: 16, algo_class: 'alley_gap', area_sqm: 20, stratum_total: 251, stratum_sampled: 15 },
    { gap_id: 'd', stratum: 'L3_unplantable', weight: 30, algo_class: 'road', area_sqm: 300, stratum_total: 308, stratum_sampled: 10 },
  ]

  // a: 算法说补种，真值也是补种 → 对
  // b: 算法不确定，真值补种（gt=1）→ 错（pred=4 ≠ 1），且算漏报
  // c: 算法说不用补，真值也不用补 → 对
  // d: 算法说不可种植，真值也是不可种植 → 对
  const recs: Record<string, GtRecord> = {
    a: { gap_id: 'a', gt: 1, confirmed: false, updated_at: 1 },
    b: { gap_id: 'b', gt: 1, confirmed: false, updated_at: 1 },
    c: { gap_id: 'c', gt: 2, confirmed: false, updated_at: 1 },
    d: { gap_id: 'd', gt: 3, confirmed: false, updated_at: 1 },
  }
  const r = evaluate(samples, recs)

  check(r.labeled === 4 && r.unsure === 0 && r.pending === 0, '计数正确', `${r.labeled}/${r.unsure}/${r.pending}`)
  check(Math.abs(r.sampleAcc - 3 / 4) < 1e-9, '样本准确率 = 3/4', String(r.sampleAcc))
  // 加权：总权 1+7+16+30=54，对的权 1+16+30=47 → 47/54
  check(
    Math.abs(r.weightedAcc - 47 / 54) < 1e-9,
    '★ 加权准确率 = 47/54（不等于 3/4 —— 这正是分层抽样的意义）',
    String(r.weightedAcc),
  )
  // 面积加权：总 470，对的 100+20+300=420
  check(
    Math.abs(r.areaAcc - 420 / 470) < 1e-9,
    '面积加权准确率 = 420/470',
    String(r.areaAcc),
  )
  check(
    r.weightedAcc !== r.sampleAcc,
    '★ 加权与样本准确率必须不同（若相同说明权重没生效）',
    `${r.weightedAcc.toFixed(3)} vs ${r.sampleAcc.toFixed(3)}`,
  )

  // 4 种组合：a=1>1 / b=4>1 / c=2>2 / d=3>3
  check(r.confusion.length === 4, '混淆矩阵 4 种组合', String(r.confusion.length))
  check(
    r.confusion.filter((c) => c.pred === c.actual).length === 3,
    '其中 3 个是对角线（判对），1 个是 4→1（漏判）',
  )
  const cellB = r.confusion.find((c) => c.pred === 4 && c.actual === 1)
  check(cellB?.count === 1 && cellB?.weighted === 7, 'uncertain→补种 的加权值 = 7', String(cellB?.weighted))

  check(r.plantable.tp === 1, 'tp = 1（a）', String(r.plantable.tp))
  check(r.plantable.fp === 0, 'fp = 0（没有"算法说补、实际不补"）', String(r.plantable.fp))
  check(r.plantable.fn === 1, 'fn = 1（b：实际该补但算法没判）', String(r.plantable.fn))
  check(Math.abs(r.plantable.recall - 0.5) < 1e-9, '召回率 = 1/(1+1) = 0.5', String(r.plantable.recall))
  check(Math.abs(r.plantable.precision - 1) < 1e-9, '精确率 = 1/(1+0) = 1', String(r.plantable.precision))
}

// ---------- F. 存疑 / 未标 / 认同算法 ----------
console.log('\nF. 存疑、未标、"认同算法"')
{
  const samples: GtSample[] = [
    { gap_id: 'a', stratum: 'L1_top_area', weight: 1, algo_class: 'open_patch', area_sqm: 100, stratum_total: 40, stratum_sampled: 40 },
    { gap_id: 'b', stratum: 'L1_top_area', weight: 1, algo_class: 'open_patch', area_sqm: 90, stratum_total: 40, stratum_sampled: 40 },
    { gap_id: 'c', stratum: 'L1_top_area', weight: 1, algo_class: 'open_patch', area_sqm: 80, stratum_total: 40, stratum_sampled: 40 },
  ]
  const recs: Record<string, GtRecord> = {
    a: { gap_id: 'a', gt: 4, confirmed: false, updated_at: 1 }, // 存疑 → 单列
    b: { gap_id: 'b', gt: null, confirmed: true, updated_at: 1 }, // 认同算法 → 真值=1
    // c 未标
  }
  const r = evaluate(samples, recs)
  check(r.unsure === 1, '★ 存疑单列（不计入准确率分母）', String(r.unsure))
  check(r.labeled === 1, '认同算法算已标', String(r.labeled))
  check(r.pending === 1, '未标单独计', String(r.pending))
  check(r.sampleAcc === 1, '认同算法 → 该块判对', String(r.sampleAcc))

  check(labeledCount(samples, recs) === 2, 'labeledCount 把存疑与认同都算"已处理"', String(labeledCount(samples, recs)))
}

// ---------- G. 下一个待标 ----------
console.log('\nG. 下一个待标（环形，不能卡死）')
{
  const samples: GtSample[] = ['a', 'b', 'c'].map((id, i) => ({
    gap_id: id,
    stratum: 'L1_top_area' as const,
    weight: 1,
    algo_class: 'open_patch' as GapClass,
    area_sqm: 100 - i,
    stratum_total: 3,
    stratum_sampled: 3,
  }))
  const recs: Record<string, GtRecord> = {}

  check(nextUnlabeled(samples, recs, null)?.gap_id === 'a', '无当前 → 从头开始')
  recs.a = { gap_id: 'a', gt: 1, confirmed: false, updated_at: 1 }
  check(nextUnlabeled(samples, recs, 'a')?.gap_id === 'b', '标完 a → 跳到 b')
  recs.b = { gap_id: 'b', gt: 2, confirmed: false, updated_at: 1 }
  recs.c = { gap_id: 'c', gt: 3, confirmed: false, updated_at: 1 }
  check(nextUnlabeled(samples, recs, 'c') === null, '★ 全标完 → null（界面据此显示完成）')

  // 中间有空位时，从末尾要能绕回前面
  delete recs.b
  check(
    nextUnlabeled(samples, recs, 'c')?.gap_id === 'b',
    '★ 环形：从末尾绕回开头补漏（不能卡死）',
    String(nextUnlabeled(samples, recs, 'c')?.gap_id),
  )
  check(
    nextUnlabeled([], {}, null) === null,
    '空样本 → null 不崩',
  )
}

// ---------- H2. cannot confirm uncertain ----------
console.log('\nH2. 「待复核」块不能用「认同算法」标（实测踩到：L2 60 块里 51 块白标）')
{
  check(!canConfirm('uncertain'), '★ uncertain → 不能认同算法')
  check(canConfirm('open_patch'), 'open_patch → 可以认同')
  check(canConfirm('road'), 'road → 可以认同')
  check(canConfirm('alley_gap'), 'alley_gap → 可以认同')

  // 为什么：若允许，classToGt('uncertain') = 4（存疑）→ 评估时被剔除 → 那块白标
  check(
    classToGt('uncertain') === 4,
    '★ 认同 uncertain 会得到"存疑"标签 —— 这正是必须拦住的原因',
  )
  // 而 L2 是**最该被标定**的一层（阈值边界），白标代价最大
  const samples = buildValidationSample(realisticSet())
  const l2 = samples.filter((s) => s.stratum === 'L2_uncertain')
  check(
    l2.every((s) => !canConfirm(s.algo_class)),
    'L2 全部是 uncertain → 全部必须用 1/2/3 标，不能用 Space',
  )
}

// ---------- H. 小数据集不崩 ----------
console.log('\nH. 边界：块数少于配额')
{
  const tiny = [gap('x1', 'open_patch', 100), gap('x2', 'uncertain', 50)]
  const s = buildValidationSample(tiny)
  check(s.length === 2, '只有 2 块时全抽（不补空）', String(s.length))
  check(
    s.every((x) => x.weight === 1),
    '全抽时权重都是 1.0',
    JSON.stringify(s.map((x) => x.weight)),
  )
  const r = evaluate(s, {})
  check(r.labeled === 0 && r.sampleAcc === 0, '一块没标时不除零', String(r.sampleAcc))
}

// ---------- 汇总 ----------
console.log('')
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
