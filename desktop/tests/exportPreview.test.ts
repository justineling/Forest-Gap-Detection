/**
 * 「这次导出会得到什么」的单元测试（Node 直跑）。
 *
 * 为什么这条值得测：预览上的数字是**用户用来判断"要不要点导出"的唯一依据**，
 * 报错了不会崩、不会报错，只会让人以为软件漏导了文件。
 * 更糟的是它很容易被写成写死的数字（"共 21 个文件"），换一张影像就骗人。
 *
 * 判据（详见 src/lib/exportPreview.ts）：
 *  · 固定产出 2 GeoJSON + 2 Shapefile + 1 KML + 1 CSV + 1 报告 = 7 个；
 *  · 「按类别分包」= 结果里出现过几个类别（随数据变化，必须标 variable）；
 *  · 「补种放样点位」有种植规格时 6 个，没有就 0 个并进 skipped；
 *  · 总数 = 7 + 类别数 + (6 或 0)。
 *
 * 这些数字对着 `scripts/tile_server.py::export_bundle()` 的实际产出逐项核过：
 *   1) gaps-all-wgs84.geojson      2) gaps-all-utm49n.geojson
 *   3) gaps-all-wgs84-shp.zip      4) gaps-all-utm49n-shp.zip
 *   5) gaps-all.kml                6) by-class/gaps-<cls>-utm49n-shp.zip × 类别数
 *   7) planting-points-{wgs84,utm49n}.geojson + 两个 -shp.zip + .kml + .csv
 *   8) gaps-edited.csv             9) 补种勘察一页报告.html
 */
import { countClasses, describeExportPlan } from '../src/lib/exportPreview'
import type { ExportPlanGroup } from '../src/lib/exportPreview'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 按 key 取一组（找不到就是 undefined，测试要能表达"这组不该存在"） */
function group(groups: ExportPlanGroup[], key: string): ExportPlanGroup | undefined {
  return groups.find((g) => g.key === key)
}

// ---------- A. 完整数据：7 + 类别数 + 6 ----------
console.log('\nA. 完整数据（有种植规格）')
{
  // 实测场景：1,762 块，类别数按 5 类算（open_patch / vacant_slot / road / water / uncertain）
  const p = describeExportPlan({ gapCount: 1762, classCount: 5, hasGrid: true })
  check(p.totalFiles === 18, '★ 1,762 块 / 5 个类别 / 有种植规格 → 18 个文件', `${p.totalFiles}`)
  check(group(p.groups, 'geojson')?.files === 2, '双坐标系地图文件 = 2')
  check(group(p.groups, 'shapefile')?.files === 2, 'Shapefile 压缩包 = 2')
  check(group(p.groups, 'kml')?.files === 1, 'KML = 1')
  check(group(p.groups, 'by-class')?.files === 5, '★ 按类别分包 = 类别数（5）')
  check(group(p.groups, 'points')?.files === 6, '★ 补种放样点位 = 6')
  check(group(p.groups, 'csv')?.files === 1, '表格 = 1')
  check(group(p.groups, 'report')?.files === 1, '一页汇总报告 = 1')
  check(p.skipped.length === 0, '完整数据下没有要跳过的分组', p.skipped.join('；'))
}

// ---------- B. ★ 按类别分包必须随数据变化 ----------
console.log('\nB. ★ 「按类别分包」随数据变化（不是写死的数字）')
{
  const a = describeExportPlan({ gapCount: 1762, classCount: 5, hasGrid: true })
  const b = describeExportPlan({ gapCount: 100, classCount: 2, hasGrid: true })
  check(
    group(a.groups, 'by-class')?.files !== group(b.groups, 'by-class')?.files,
    '★ 5 个类别 → 5 个文件；2 个类别 → 2 个文件（总数跟着变）',
    `${group(a.groups, 'by-class')?.files} vs ${group(b.groups, 'by-class')?.files}`,
  )
  check(a.totalFiles !== b.totalFiles, '★ 两组数据的总文件数不同', `${a.totalFiles} vs ${b.totalFiles}`)
  check(group(a.groups, 'by-class')?.variable === true, '★ 这一组被标记为「随数据变化」（界面要显示提示）')
  // 固定产出那几组不能标成 variable，否则"随数据变化"这个提示就失去意义
  check(group(a.groups, 'geojson')?.variable === false, '固定产出的组不标「随数据变化」')
  check(group(a.groups, 'points')?.variable === false, '放样点位不标（它取决于有没有种植规格，不是数据量）')
  // 规则描述里必须带上实际数字，否则用户不知道"为什么是 5 个"
  check(
    (group(a.groups, 'by-class')?.detail ?? '').includes('5 个类别'),
    '规则说明里写清了"当前有 5 个类别"',
    group(a.groups, 'by-class')?.detail ?? '',
  )
}

// ---------- C. 缺种植规格：跳过点位那 6 个 ----------
console.log('\nC. 缺种植规格 → 少 6 个文件并明确告知')
{
  const p = describeExportPlan({ gapCount: 1762, classCount: 5, hasGrid: false })
  check(p.totalFiles === 12, '★ 没有种植规格 → 12 个文件（18 − 6）', `${p.totalFiles}`)
  check(group(p.groups, 'points')?.files === 0, '放样点位 = 0')
  check(
    p.skipped.some((s) => s.includes('放样点位')),
    '★ skipped 里明确写了"补种放样点位"会被跳过',
    p.skipped.join('；'),
  )
  check(
    (group(p.groups, 'points')?.detail ?? '').includes('跳过'),
    '该组自己的说明里也写了会跳过（不只靠底部提示）',
    group(p.groups, 'points')?.detail ?? '',
  )
}

// ---------- D. 脏输入：NaN / 负数 / 小数 / undefined ----------
console.log('\nD. 脏输入不产生 NaN 或负数')
{
  const p = describeExportPlan({ gapCount: NaN, classCount: -3, hasGrid: true })
  check(Number.isFinite(p.totalFiles), '总数是有限数（不是 NaN）', `${p.totalFiles}`)
  check(p.totalFiles === 13, 'NaN 块数 + 负数类别 → 当 0 处理（7 + 0 + 6 = 13）', `${p.totalFiles}`)
  check(
    p.skipped.some((s) => s.includes('没有结果可导出')),
    '块数为 0 时明确提示"全部跳过"',
    p.skipped.join('；'),
  )
  const q = describeExportPlan({ gapCount: 1762.9, classCount: 3.7, hasGrid: true })
  check(group(q.groups, 'by-class')?.files === 3, '小数类别数被取整（3.7 → 3）')
  check(Number.isInteger(q.totalFiles), '总数是整数', `${q.totalFiles}`)
}

// ---------- E. 分组清单与 export_bundle 的产出一一对应 ----------
console.log('\nE. 分组清单与后端实际产出一一对应')
{
  const p = describeExportPlan({ gapCount: 10, classCount: 1, hasGrid: true })
  const keys = p.groups.map((g) => g.key)
  check(
    JSON.stringify(keys) ===
      JSON.stringify(['geojson', 'shapefile', 'kml', 'by-class', 'points', 'csv', 'report']),
    '★ 分组顺序固定（顺序变了界面会跳动）',
    keys.join(' → '),
  )
  // 每组都必须有一句人话说明 —— 只有标签没有说明等于没说
  check(
    p.groups.every((g) => g.detail.trim().length >= 6),
    '★ 每一组都有说明文字（不是只有一个标签）',
  )
  // 总数必须等于各组之和，否则界面上的"共 N 个"与下面列的对不上
  check(
    p.totalFiles === p.groups.reduce((s, g) => s + g.files, 0),
    '★ 总数 = 各组之和（对不上会被用户当场发现）',
    `${p.totalFiles}`,
  )
}

// ---------- F. countClasses ----------
console.log('\nF. countClasses：从要素列表数类别')
{
  const mk = (cls: unknown) => ({ properties: { class: cls } }) as never
  check(countClasses([mk('open_patch'), mk('road'), mk('open_patch')]) === 2, '去重后 2 个类别')
  check(countClasses([]) === 0, '空列表 → 0')
  check(countClasses(null) === 0, 'null → 0（不抛错）')
  check(countClasses(undefined) === 0, 'undefined → 0')
  check(countClasses([mk(''), mk('  '), mk(null), mk(undefined)]) === 0, '空串 / 空白 / null → 不计入')
  check(countClasses([{ properties: {} }] as never) === 0, '缺 class 字段 → 不计入')
  check(countClasses([{}] as never) === 0, '缺 properties → 不计入（不抛错）')
  check(countClasses([mk('water'), mk(7)]) === 1, '非字符串类别 → 不计入')
  // 与 describeExportPlan 串起来：类别的个数直接决定分包文件数
  const feats = [mk('open_patch'), mk('vacant_slot'), mk('road')]
  const n = countClasses(feats)
  const plan = describeExportPlan({ gapCount: feats.length, classCount: n, hasGrid: true })
  check(
    group(plan.groups, 'by-class')?.files === 3,
    '★ 3 个类别 → 分包 3 个文件（与 countClasses 串起来）',
    `${n}`,
  )
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
