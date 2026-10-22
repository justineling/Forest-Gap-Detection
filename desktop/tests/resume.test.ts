/**
 * 「启动时问一句继续 / 重新开始」的单元测试（Node 直跑）。
 *
 * 这一条守的是**用户的选择权**：桌面端启动会把磁盘上最近一次的结果自动读进界面，
 * 而 `isStepDone('detect')` 把"已有结果"也算成第 3 步完成 —— 界面直接跳到第 4 步。
 * 用户原话：「应该有 1 个弹窗来让用户决定吧」。
 *
 * 判断条件最容易写错的地方不在 UI，而在这四条规则：
 *   判宽了 → 检测跑完自动刷新时又弹一次（用户以为出故障）；
 *   判窄了 → 永远不弹（问题没解决，且很难复现）。
 * 所以四个分支各来一例，外加文案的**反向断言**（不能出现技术词）。
 */
import {
  describeResume,
  formatGeneratedAt,
  pickGeneratedAt,
  shouldAskResume,
} from '../src/lib/resume'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

// ---------- A. shouldAskResume 的四个分支 ----------
console.log('\nA. 什么时候该问（四个分支各一例）')
{
  // ① 正常启动：首次加载 + 本次没跑过 + 读到 1,726 块 → 问
  const normal = shouldAskResume({ firstLoad: true, detectedThisSession: false, gapCount: 1726 })
  check(normal, '★ 首次加载 + 没跑过检测 + 1,726 块 → true（就是用户要的那个弹窗）')

  // ② 不是首次加载 → 不问（检测完成后的自动刷新 / 重新载入结果）
  const notFirst = shouldAskResume({ firstLoad: false, detectedThisSession: false, gapCount: 1726 })
  check(
    !notFirst,
    '★ 不是首次加载 → false（检测完成后的自动刷新不该再弹）',
  )

  // ③ 本次会话已经跑过检测 → 不问（刚跑完的结果就是用户自己要的）
  const detected = shouldAskResume({ firstLoad: true, detectedThisSession: true, gapCount: 1726 })
  check(
    !detected,
    '★ 本次会话已跑过检测 → false（"要不要继续上次结果"是假问题）',
  )

  // ④ 没有历史结果 → 不问（没得选，弹窗只是拦路）
  const empty = shouldAskResume({ firstLoad: true, detectedThisSession: false, gapCount: 0 })
  check(!empty, '★ 读到 0 块 → false（没有历史结果就没什么可问）')

  // 脏输入：负数 / NaN 不能弹出"0 块"的空窗
  check(
    !shouldAskResume({ firstLoad: true, detectedThisSession: false, gapCount: -3 }),
    '负块数 → false（脏输入不该弹窗）',
  )
  check(
    !shouldAskResume({ firstLoad: true, detectedThisSession: false, gapCount: Number.NaN }),
    '★ NaN 块数 → false（`NaN <= 0` 是 false，只写比较会让它穿过去）',
  )

  // 三条规则必须都能单独否决 —— 判错一条就是"要么不弹，要么乱弹"
  check(
    normal && !notFirst && !detected && !empty,
    '★ 四条规则互相独立（任何一条不满足都不弹）',
  )
}

// ---------- B. describeResume：摘要文案 ----------
console.log('\nB. 摘要文案（块数千分位 + 可选时间）')
{
  const withTime = describeResume(1726, '2026-10-21T14:23:00')
  check(
    withTime === '1,726 块 · 结果生成于 10-21 14:23',
    '正常时间 → 「1,726 块 · 结果生成于 10-21 14:23」',
    withTime,
  )

  const noTime = describeResume(1726, null)
  check(noTime === '1,726 块', 'generatedAt 为 null → 只显示块数', noTime)

  const badTime = describeResume(1726, '不是时间')
  check(badTime === '1,726 块', '非法时间串 → 退回只显示块数（不抛错）', badTime)

  const emptyTime = describeResume(1726, '')
  check(emptyTime === '1,726 块', '空字符串时间 → 退回只显示块数', emptyTime)

  const zero = describeResume(0, null)
  check(zero === '0 块', '0 块 → 「0 块」（不崩、不显示 undefined）', zero)

  const small = describeResume(12, null)
  check(small === '12 块', '两位数不加分隔符', small)
}

// ---------- C. ★ 反向断言：文案里不许出现技术词 ----------
//
// 弹窗文案会原样显示给用户。`geojson` / `gaps` / `job` / `mtime` 这些词
// 出现在界面上，用户第一反应是"我是不是点错了什么"。
console.log('\nC. ★ 文案不许出现技术词（反向断言）')
{
  const banned = ['geojson', 'gaps', 'job', 'mtime', 'ndjson', 'sidecar', '瓦片']
  const samples = [
    describeResume(1726, '2026-10-21T14:23:00'),
    describeResume(1726, null),
    describeResume(0, null),
    describeResume(1, '2026-01-02T03:04:05'),
  ]
  for (const text of samples) {
    const lower = text.toLowerCase()
    const hit = banned.filter((w) => lower.includes(w))
    check(hit.length === 0, `「${text}」不含技术词`, hit.join('/'))
  }
}

// ---------- D. 时间格式化的边界 ----------
console.log('\nD. 时间格式化（只给 MM-DD HH:mm）')
{
  check(formatGeneratedAt('2026-10-21T14:23:59') === '10-21 14:23', '秒被丢掉（14:23，不是 14:23:59）')
  check(formatGeneratedAt('2026-01-02T03:04:00') === '01-02 03:04', '月/日/时/分都补零')
  check(formatGeneratedAt(null) === null, 'null → null')
  check(formatGeneratedAt('2026-13-45') === null, '非法日期 → null（不抛错）')
}

// ---------- E. 从后端响应里挑时间戳 ----------
//
// 现在 `/gaps` 没有这个字段（真实流程拿到 null，弹窗只显示块数）。
// 挑法留着是为了后端将来加上时前端不用改 —— 但**绝不能认错字段**。
console.log('\nE. 时间戳的挑法（现在拿到 null 是正常的）')
{
  check(pickGeneratedAt({ generated_at: '2026-10-21T14:23:00' }) === '2026-10-21T14:23:00', '认得 generated_at')
  check(pickGeneratedAt({ features: [] }) === null, '★ 现在的响应没有时间字段 → null（不是故障）')
  check(pickGeneratedAt(null) === null, 'null 输入 → null')
  check(pickGeneratedAt({ generated_at: '   ' }) === null, '空白字符串当没有')
  check(pickGeneratedAt({ generated_at: 12345 }) === null, '数字不认（宁可显示不出，也不要猜错）')
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
