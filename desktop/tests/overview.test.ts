/**
 * 「加速结构」提示的纯函数断言（Node 直跑）。
 *
 * 这一组守的是"给用户看的话"和"按钮能不能点"：
 * - 横幅闪一下 / 该提醒却不提醒，用户都不会报 bug，只会觉得"软件怪怪的"；
 * - 磁盘不够还让点「开始」，用户等 3 分钟才失败；
 * - 按钮文案里冒出 gdaladdo / ovr / copy，等于把实现细节甩给用户。
 *
 * 这三类错误**都不会抛异常**，所以只能靠断言钉住。
 */
import {
  canStartBuild,
  describeAction,
  describeEstimate,
  describeSpace,
  estimateBuildSeconds,
  shouldShowOverviewNotice,
  type OverviewPlan,
} from '../src/lib/overview'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 造一个体检结果（默认是"要复制副本、空间够"这个最常见的形态） */
function plan(patch: Partial<OverviewPlan> = {}): OverviewPlan {
  return {
    action: 'copy',
    why: '无 gdaladdo，复制副本（源文件不动，约占原图 100%）',
    has_overviews: false,
    size_bytes: 3.5 * 1024 ** 3,
    need_bytes: 1.5 * 3.5 * 1024 ** 3,
    free_bytes: 171 * 1024 ** 3,
    enough_space: true,
    target_dir: 'D:/repo/output/.tile-cache',
    gdaladdo: null,
    touches_source: false,
    ...patch,
  }
}

// ---------- A. 横幅该不该出现 ----------
console.log('\nA. 横幅：没加速结构才提醒，且不能闪')
{
  check(shouldShowOverviewNotice(false, false), '没有加速结构 + 没忽略 → 显示')
  check(!shouldShowOverviewNotice(true, false), '已有加速结构 → 不显示')
  check(
    !shouldShowOverviewNotice(undefined, false),
    '★ 还没读到 meta（undefined）→ 不显示（否则横幅会闪一下）',
  )
  check(!shouldShowOverviewNotice(null, false), 'meta 为 null → 不显示')
  check(!shouldShowOverviewNotice(false, true), '用户点了「以后再说」→ 不显示')
  check(
    shouldShowOverviewNotice(false, false) && !shouldShowOverviewNotice(undefined, false),
    '★ 两种"没加速结构"必须区分开（读到 vs 还没读到）',
  )
}

// ---------- B. 按钮能不能点 ----------
console.log('\nB. 「开始」按钮：不确定 / 没必要 / 不支持 / 空间不够都不让点')
{
  check(!canStartBuild(null), 'plan 还没回来（null）→ 禁用')
  check(canStartBuild(plan()), 'copy + 空间够 → 可点')
  check(!canStartBuild(plan({ enough_space: false })), '★ 空间不够 → 禁用')
  check(!canStartBuild(plan({ action: 'none', need_bytes: 0 })), '本来就有 → 禁用（没什么可建）')
  check(
    !canStartBuild(plan({ action: 'error', why: '找不到 gdaladdo' })),
    '环境不支持（error）→ 禁用',
  )
  check(canStartBuild(plan({ action: 'ovr', need_bytes: 1.5 * 1024 ** 3 })), 'ovr + 空间够 → 可点')
  check(
    canStartBuild(plan({ action: 'inplace', touches_source: true })),
    'inplace 可点（要不要警告是对话框的事，不是按钮的事）',
  )
}

// ---------- C. 磁盘说明 ----------
console.log('\nC. 磁盘说明：不能出现"需要 0"这种废话')
{
  const s = describeSpace(plan())
  check(s.includes('需要') && s.includes('可用'), '正常情形给出"需要…可用…"', s)
  check(!s.includes('空间不够'), '空间够时不说"不够"')

  const tight = describeSpace(plan({ enough_space: false, free_bytes: 1024 ** 3 }))
  check(tight.includes('不够'), '空间不够要明说', tight)

  const none = describeSpace(plan({ action: 'none', need_bytes: 0 }))
  check(!/需要\s*0/.test(none), '★ need=0 时不能写"需要 0 GB"', none)
  check(none.includes('不需要'), 'need=0 时说"不需要额外空间"', none)

  // 小图不能显示成 "0.0 GB"
  const small = describeSpace(plan({ need_bytes: 300 * 1024 ** 2, free_bytes: 5 * 1024 ** 3 }))
  check(!small.includes('0.0 GB'), '300 MB 不能显示成 0.0 GB', small)
  check(small.includes('MB'), '小于 1 GB 用 MB 表述', small)
}

// ---------- D. 耗时估算 ----------
console.log('\nD. 耗时估算：单调 + 3.5 GB 落在合理区间')
{
  const a = estimateBuildSeconds(1 * 1024 ** 3)
  const b = estimateBuildSeconds(3.5 * 1024 ** 3)
  const c = estimateBuildSeconds(10 * 1024 ** 3)
  check(a < b && b < c, '越大越久（单调递增）', `${a} < ${b} < ${c}`)
  check(b >= 120 && b <= 300, '★ 3.5 GB（实测 174 秒）落在 120~300 秒', String(b))
  check(estimateBuildSeconds(0) > 0, '体积未知也给一个正数，不返回 0')
  check(estimateBuildSeconds(Number.NaN) > 0, '脏输入（NaN）不崩，仍给正数')
  check(estimateBuildSeconds(999 * 1024 ** 3) <= 600, '再大也不超过 10 分钟（避免离谱数字）')
  check(describeEstimate(174).includes('分钟'), '174 秒用"分钟"表述', describeEstimate(174))
  check(describeEstimate(45).includes('秒'), '45 秒用"秒"表述', describeEstimate(45))
}

// ---------- E. 按钮文案不许出现实现细节 ----------
console.log('\nE. 按钮文案：不能出现 gdaladdo / ovr / copy / inplace')
{
  const banned = ['gdaladdo', 'ovr', 'copy', 'inplace']
  const cases: Array<[string, OverviewPlan]> = [
    ['none', plan({ action: 'none', need_bytes: 0 })],
    ['ovr', plan({ action: 'ovr' })],
    ['copy', plan({ action: 'copy' })],
    ['inplace', plan({ action: 'inplace', touches_source: true })],
  ]
  for (const [name, p] of cases) {
    const text = describeAction(p)
    const hit = banned.filter((w) => text.toLowerCase().includes(w))
    check(hit.length === 0, `★ ${name} 的文案不含实现细节`, hit.length ? `命中 ${hit.join(',')}` : text)
    check(text.length > 0, `${name} 的文案不为空`)
  }

  // 文案要说清"动不动原图"这件用户真正关心的事
  check(describeAction(plan({ action: 'copy' })).includes('不动原图'), 'copy 要明说"不动原图"')
  check(describeAction(plan({ action: 'ovr' })).includes('不动原图'), 'ovr 要明说"不动原图"')
  check(
    describeAction(plan({ action: 'inplace', touches_source: true })).includes('不可撤销'),
    'inplace 必须警告"不可撤销"',
  )
  // 文案里不许出现 Markdown 加粗（渲染出来是字面星号）
  for (const [name, p] of cases) {
    check(!describeAction(p).includes('**'), `${name} 的文案不含 Markdown 星号`)
  }

  // error 情形：后端给的真实原因必须透出来（不能只说"失败了"）
  const errText = describeAction(plan({ action: 'error', why: '找不到 gdaladdo，无法生成外置 .ovr' }))
  check(errText.includes('找不到 gdaladdo'), '★ error 要把后端原文带出来（便于排障）', errText)
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
