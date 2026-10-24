/**
 * 区块清单的**纯展示逻辑**（无 React、无 Tauri，方便单测）。
 *
 * ## 为什么单独抽出来
 *
 * 「切哪个区块」这个动作本身在 Rust 里（`switch_block`），前端只负责
 * "让用户看懂这一行是什么"。而这恰恰是最容易写歪的地方：
 *
 *   · 区块名是 `wgr17-002-2` 这种，一长就撑破下拉框；
 *   · 时间显示成 `1750000000` 没人看得懂，但"3 分钟前"和"昨天"要区别对待；
 *   · **影像不在了**的那一块必须显眼 —— 点进去只会得到一句报错，
 *     如果它长得和别的项一样，用户会以为软件坏了。
 *
 * 这些规则写进纯函数后可以逐条钉住，不用起浏览器。
 */

import type { BlockInfo } from '../api/backend'

/** 区块名太长时截断（下拉框宽度是固定的 300px 左右）。 */
export function shortJob(job: string, max = 22): string {
  if (job.length <= max) return job
  // 保留尾部：`wgr17-002-2` 的信息量在尾部（冲突消解的后缀），
  // 从中间截会把 `-2` 这种关键差别切掉。
  return `…${job.slice(job.length - (max - 1))}`
}

/**
 * 修改时间 → 人话。
 *
 * 分档（阈值都是"用户能感知的粒度"，不是数学上好看的数字）：
 *   < 1 分钟   → 刚刚
 *   < 1 小时   → N 分钟前
 *   今天       → 今天 HH:MM
 *   昨天       → 昨天 HH:MM
 *   今年       → MM-DD HH:MM
 *   更早       → YYYY-MM-DD
 *
 * `modified = 0`（读不到时间）→ 空串：不显示比显示 1970 年好。
 */
export function formatBlockTime(modified: number, now: number = Date.now()): string {
  if (!modified || modified <= 0) return ''
  const t = modified * 1000
  const diff = now - t
  if (diff < 0) return '刚刚' // 时钟偏差：未来时间按刚刚算，别显示负数
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  const d = new Date(t)
  const n = new Date(now)
  const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  if (sameDay) return `今天 ${hhmm}`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  const isYesterday =
    d.getFullYear() === y.getFullYear() &&
    d.getMonth() === y.getMonth() &&
    d.getDate() === y.getDate()
  if (isYesterday) return `昨天 ${hhmm}`
  if (d.getFullYear() === n.getFullYear()) {
    return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${hhmm}`
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 下拉项右侧的一行小字：大小 · 高度图 · 时间。 */
export function blockSubtitle(b: BlockInfo, now: number = Date.now()): string {
  const parts: string[] = []
  if (b.size_mb > 0) parts.push(`${b.size_mb.toFixed(1)} MB`)
  parts.push(b.chm ? '高度图 ✓' : '无高度图')
  const when = formatBlockTime(b.modified, now)
  if (when) parts.push(when)
  return parts.join(' · ')
}

/**
 * 这一块有什么"点了会失败"的风险（空数组 = 没问题）。
 *
 * 单独列出来是因为**影像不在了**和"没跑过检测"性质不同：
 * 前者点进去必然报错，应该在菜单里就标出来并置灰；
 * 后者根本不会出现在清单里（清单是扫结果文件得到的）。
 */
export function blockWarnings(b: BlockInfo): string[] {
  const out: string[] = []
  if (b.image === null) {
    out.push('结果里没记影像路径 —— 切换后需要重新选影像')
  } else if (!b.image_exists) {
    out.push('影像不在原位置了 —— 切换时会按文件名去找，找不到就报错')
  }
  return out
}

/** 能不能切（影像彻底找不到时不建议点，但允许用户试 —— 会给出明确错误）。 */
export function canSwitchTo(b: BlockInfo): boolean {
  return !b.current
}

/** 下拉里是否值得显示这个按钮：只有一块时没必要（但当前区块名仍有用）。 */
export function shouldShowSwitcher(blocks: BlockInfo[]): boolean {
  return blocks.length > 0
}
