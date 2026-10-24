/**
 * 区块清单展示逻辑的单元测试（Node 直跑）。
 *
 * 守的是**"下拉里那一行必须能看懂、且不会误导"**这条底线：
 *   · 区块名一长就撑破下拉框（`wgr17-002-2` 这种，信息量在尾部）；
 *   · 时间显示成 unix 秒没人看得懂，"3 分钟前"和"昨天"要区别对待；
 *   · **影像不在了**的那一块必须显眼 —— 点进去只会得到一句报错，
 *     如果它长得和别的项一样，用户会以为软件坏了。
 *
 * 这些判断写错的后果不是"不好看"，而是用户切错区块 ——
 * 于是他在 A 的影像上复核 B 的空地，数字自洽、不报错。
 */
import {
  blockSubtitle,
  blockWarnings,
  canSwitchTo,
  formatBlockTime,
  shortJob,
  shouldShowSwitcher,
} from '../src/lib/blocks'
import type { BlockInfo } from '../src/api/backend'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

function blk(patch: Partial<BlockInfo> = {}): BlockInfo {
  return {
    job: 'wgr17-002',
    image: 'D:/data/WGR17-002.tif',
    image_exists: true,
    gaps: 'D:/data/output/wgr17-002-gaps.geojson',
    chm: 'D:/data/output/wgr17-002-chm.tif',
    modified: 1_700_000_000,
    size_mb: 15.2,
    current: false,
    ...patch,
  }
}

// ---------- A. 区块名截断 ----------
console.log('\nA. shortJob（长名字截断，信息量在尾部）')
{
  check(shortJob('wgr17-002') === 'wgr17-002', '短名字原样返回')
  check(shortJob('a'.repeat(10), 10) === 'a'.repeat(10), '★ 正好等于上限 → 不截')
  const long = shortJob('wgr17-002-very-long-name-2', 12)
  check(long.length <= 12, '★ 截断后不超过上限', `${long.length}`)
  check(long.startsWith('…'), '截断用省略号开头（看得出被截了）')
  check(long.endsWith('-2'), '★ 保留尾部：冲突消解后缀不能丢', long)
}

// ---------- B. 时间分档 ----------
console.log('\nB. formatBlockTime（刚刚 / N 分钟前 / 今天 / 昨天 / 更早）')
{
  const now = new Date('2026-10-24T09:30:00').getTime()
  const sec = (t: number) => Math.floor(t / 1000)

  check(formatBlockTime(0, now) === '', '★ 0（读不到时间）→ 空串，不显示 1970')
  check(formatBlockTime(sec(now - 10_000), now) === '刚刚', '10 秒前 → 刚刚')
  check(formatBlockTime(sec(now - 59_000), now) === '刚刚', '59 秒前仍是刚刚')
  check(formatBlockTime(sec(now - 60_000), now) === '1 分钟前', '★ 整 60 秒 → 1 分钟前')
  check(formatBlockTime(sec(now - 3 * 60_000), now) === '3 分钟前', '3 分钟前')
  check(formatBlockTime(sec(now - 59 * 60_000), now) === '59 分钟前', '59 分钟前（还没进小时档）')
  check(
    formatBlockTime(sec(now - 3 * 3_600_000), now) === '今天 06:30',
    '★ 3 小时前且同一天 → 今天 HH:MM',
    formatBlockTime(sec(now - 3 * 3_600_000), now),
  )
  const yesterday = new Date('2026-10-23T18:05:00').getTime()
  check(
    formatBlockTime(sec(yesterday), now) === '昨天 18:05',
    '★ 昨天 → 昨天 HH:MM',
    formatBlockTime(sec(yesterday), now),
  )
  const older = new Date('2026-10-02T08:07:00').getTime()
  check(
    formatBlockTime(sec(older), now) === '10-02 08:07',
    '今年更早 → MM-DD HH:MM',
    formatBlockTime(sec(older), now),
  )
  const lastYear = new Date('2025-12-31T23:00:00').getTime()
  check(
    formatBlockTime(sec(lastYear), now) === '2025-12-31',
    '跨年 → YYYY-MM-DD',
    formatBlockTime(sec(lastYear), now),
  )
  // 时钟偏差：文件时间在未来（共享盘/NTP）不能显示成"−5 分钟前"
  check(formatBlockTime(sec(now + 60_000), now) === '刚刚', '★ 未来时间按刚刚算，不显示负数')
}

// ---------- C. 副标题 ----------
console.log('\nC. blockSubtitle（大小 · 高度图 · 时间）')
{
  const now = 1_700_000_000_000 + 5 * 60_000
  const s = blockSubtitle(blk({ modified: 1_700_000_000 }), now)
  check(s.includes('15.2 MB'), '有大小', s)
  check(s.includes('高度图 ✓'), '有高度图要标出来', s)
  check(s.includes('5 分钟前'), '带时间', s)

  const noChm = blockSubtitle(blk({ chm: null, modified: 0 }), now)
  check(noChm.includes('无高度图'), '★ 没高度图要明确写"无"（不是留空）', noChm)
  check(!noChm.includes('·  ·'), '时间缺失时不留空档')
}

// ---------- D. 风险提示 ----------
console.log('\nD. blockWarnings / canSwitchTo（哪一块点了会失败）')
{
  check(blockWarnings(blk()).length === 0, '正常的一块没有警告')
  const gone = blockWarnings(blk({ image_exists: false }))
  check(gone.length === 1 && gone[0].includes('不在原位置'), '★ 影像被挪走 → 警告', gone.join())
  const none = blockWarnings(blk({ image: null, image_exists: false }))
  check(none.length === 1 && none[0].includes('没记影像路径'), '★ 连路径都没记 → 另一句警告', none.join())

  check(canSwitchTo(blk()) === true, '不是当前块 → 可以切')
  check(canSwitchTo(blk({ current: true })) === false, '★ 当前块 → 不用切（菜单里置灰）')
}

// ---------- E. 要不要显示按钮 ----------
console.log('\nE. shouldShowSwitcher')
{
  check(shouldShowSwitcher([]) === false, '一块都没有 → 不显示（顶部不该多一个空按钮）')
  check(shouldShowSwitcher([blk()]) === true, '有一块 → 显示（用户至少要知道自己在哪块）')
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
