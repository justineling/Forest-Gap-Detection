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
import { readFileSync } from 'node:fs'
import {
  canStartBuild,
  describeAction,
  describeEstimate,
  describeSpace,
  estimateBuildSeconds,
  explainBuildError,
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

  // error 情形：**不能**把后端原文当按钮文案（原文里有 gdaladdo / 外置 .ovr）。
  // 原文仍然保留 —— 但它在组件的 <pre> 里，不在 describeAction 的返回值里。
  const errPlan = plan({ action: 'error', why: '找不到 gdaladdo，无法生成外置 .ovr' })
  const errText = describeAction(errPlan)
  const errHit = banned.filter((w) => errText.toLowerCase().includes(w))
  check(errHit.length === 0, '★ error 分支的文案也不含实现细节', errHit.length ? errHit.join(',') : errText)
  check(
    errText === explainBuildError(errPlan.why).title,
    'error 分支直接复用 explainBuildError 的标题（只有一处文案来源）',
    errText,
  )
}

// ---------- F. 失败原因翻译成人话 ----------
//
// 这一组是补上"上一轮漏掉的路径"：上一轮只断言了 5 个纯函数不含术语，
// 但**后端原文透传**那条路没测，结果 `gdaladdo` 从 UI 里漏了出来。
const BANNED = ['gdaladdo', 'ovr', 'copy', 'inplace', 'gdal']

/** 断言一段文案不含任何技术名词 */
function clean(text: string): string[] {
  const low = text.toLowerCase()
  return BANNED.filter((w) => low.includes(w))
}

console.log('\nF. 失败原因翻译：5 条映射 + 人话里不许有术语')
{
  const cases: Array<[string, string, string]> = [
    [
      '找不到 gdaladdo，无法生成外置 .ovr',
      '这台电脑缺少一个可选的加速组件',
      'gdaladdo',
    ],
    ['磁盘空间不足：需要约 9.4 GB', '磁盘剩余空间不够', '磁盘'],
    ['PermissionError: [WinError 5] 拒绝访问', '没有写入这个位置的权限', 'PermissionError'],
    ['处理被中断了：KeyboardInterrupt', '处理被中断了', 'KeyboardInterrupt'],
    ['something exploded at 0xDEADBEEF', '没能建立加速结构', 'unknown'],
  ]

  for (const [raw, wantTitle, tag] of cases) {
    const a = explainBuildError(raw)
    check(a.title === wantTitle, `${tag} → 命中「${wantTitle}」`, a.title)
    check(a.hint.length > 0, `${tag} → 给出下一步建议`)
  }

  // ★ 反向断言：**每一条**的 title 与 hint 都不许出现技术名词。
  //   这是这次真正的教训 —— 测"函数干净"不够，要测"用户看到的那句话干净"。
  for (const [raw, , tag] of cases) {
    const a = explainBuildError(raw)
    const hitT = clean(a.title)
    const hitH = clean(a.hint)
    check(hitT.length === 0, `★ ${tag} 的 title 不含技术名词`, hitT.join(','))
    check(hitH.length === 0, `★ ${tag} 的 hint 不含技术名词`, hitH.join(','))
  }

  // 顺序有意义：一句话里同时出现两类关键词时，按表里的先后命中（gdaladdo 在前）。
  // 实测后端不会这么报（磁盘报错只说磁盘），这里钉住的是"顺序不要被后人调乱"。
  const mixed = explainBuildError('磁盘空间不足，gdaladdo 需要 9 GB')
  check(mixed.title === '这台电脑缺少一个可选的加速组件', '关键词按顺序命中第一条（gdaladdo 优先）', mixed.title)

  // 空 / 脏输入不能崩
  check(explainBuildError('').title.length > 0, '空字符串也给一个标题')
  check(explainBuildError(null as unknown as string).title.length > 0, 'null 也不崩（后端可能给空）')
}

// ---------- G. 源码级守卫：组件里不许出现技术名词 ----------
//
// 这一条是**上一轮漏检的直接补救**。上一轮只断言了 5 个纯函数干净，
// 结果 `OverviewNotice.tsx` 里手写的 JSX 文案（"装了 GDAL 可以只占约 1/3 磁盘"）
// 和「瓦片」这种 GIS 词照样漏到了用户面前 —— 纯函数测不到它们。
//
// 做法：把这个组件的源码读进来，剥掉注释后扫一遍。注释里出现 gdaladdo 是合法的
// （那是写给维护者看的），所以必须先剥注释再扫。
console.log('\nG. 源码守卫：OverviewNotice.tsx 的可见文案不含技术名词')
{
  const src = readFileSync('src/components/OverviewNotice.tsx', 'utf8')
  const code = src
    // JSX 注释 {/* ... */}
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    // 块注释 /* ... */
    .replace(/\/\*[\s\S]*?\*\//g, '')
    // 行注释 // ...
    .replace(/\/\/[^\n]*/g, '')
    // className：**必须剥**。JSX 里最常见的写法是
    //   <div className="ovr-note">不会修改你的原图。</div>
    // 类名（ovr-*）和中文文案在同一行 —— 不剥就会把类名当成"用户可见文案"，
    // 报出一条纯属虚构的命中。实测就是这么误报的（2026-10-21）。
    .replace(/className=(\{[^}]*\}|"[^"]*"|'[^']*')/g, '')

  // 只扫**含中文的行**：用户看到的文案一定是中文；而代码里的枚举比较
  // （`action === 'inplace'`）、URL 参数（`.get('ovr')`）都是纯 ASCII。
  // 不过滤就会得到一堆假阳性，那样这条断言很快就会被人注释掉 —— 比没有更糟。
  const visible = (code.match(/[^\n]*[\u4e00-\u9fff][^\n]*/g) ?? []).join('\n')

  const hit = BANNED.filter((w) => visible.toLowerCase().includes(w))
  check(
    hit.length === 0,
    '★ 组件里"给用户看的中文文案"不含 gdaladdo / ovr / copy / inplace / GDAL',
    hit.length ? `命中：${hit.join(',')}` : '干净',
  )
  // 反向确认：这条守卫不是"因为文件读不到所以永远通过"
  check(visible.includes('加速结构'), '守卫确实读到了组件里的中文文案（否则上面的通过没有意义）')
  // 横幅里不许有"瓦片"（GIS 术语，用户不懂）
  check(!visible.includes('瓦片'), '★ 用户可见文案里没有"瓦片"二字')

  // ★ 守卫自身的有效性：喂一条**故意违规**的文案，它必须报出来。
  //   没有这一条，上面所有"干净"都可能只是"扫描器坏了"。
  //   （上一轮 `装了 GDAL 可以只占约 1/3 磁盘` 就是这么漏出去的。）
  const probe = '装了 GDAL 可以只占约 1/3 磁盘，但当前环境没有'
  const probeHit = BANNED.filter((w) => probe.toLowerCase().includes(w))
  check(
    probeHit.length > 0,
    '★ 守卫自检：故意违规的样例必须被抓到（证明扫描器没坏）',
    probeHit.join(','),
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
