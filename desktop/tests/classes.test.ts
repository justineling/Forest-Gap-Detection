/**
 * 类别顺序（键盘键位）测试。
 *
 * 起因：2026-10-25 审核发现复核清单的 `1–9` 改判用的是 `ALL_CLASSES`
 * （`Object.keys(CLASS_STYLES)` 的**声明顺序**），而左面板是按 `GROUP_ORDER`
 * 分组渲染的 —— 两者不一致，于是：
 *
 *   面板视觉顺序: 株位空缺 / 连片空地 / **人工新增** / 不确定 / **林间空隙** / …
 *   ALL_CLASSES : 株位空缺 / 连片空地 / **林间空隙** / 不确定 / **道路**     / …
 *
 * 按 3 想改"人工新增"，实际改成了"林间空隙" —— 复核 1,726 块时是静默改错数据。
 * 这份测试钉住"键位 = 面板顺序"，以及那两个具体错位点。
 */
import {
  ALL_CLASSES,
  CLASS_KEY_ORDER,
  CLASS_STYLES,
  GROUP_ORDER,
} from '../src/lib/classes'

let pass = 0
let fail = 0
const check = (cond: boolean, msg: string, got = '') => {
  if (cond) {
    pass++
    console.log(`  [OK  ] ${msg}${got ? `  ·  ${got}` : ''}`)
  } else {
    fail++
    console.log(`  [FAIL] ${msg}${got ? `  ·  ${got}` : ''}`)
  }
}

console.log('\n类别键位（CLASS_KEY_ORDER）')
{
  check(
    CLASS_KEY_ORDER.length === ALL_CLASSES.length,
    '键位覆盖全部类别（数量相等）',
    `${CLASS_KEY_ORDER.length} / ${ALL_CLASSES.length}`,
  )
  check(
    new Set(CLASS_KEY_ORDER).size === ALL_CLASSES.length,
    '键位里没有重复类别',
    String(new Set(CLASS_KEY_ORDER).size),
  )

  // 键位顺序 == 左面板的渲染顺序（按 GROUP_ORDER 分组）
  const expected = GROUP_ORDER.flatMap((g) =>
    ALL_CLASSES.filter((c) => CLASS_STYLES[c].group === g),
  )
  check(
    JSON.stringify(CLASS_KEY_ORDER) === JSON.stringify(expected),
    '★ 键位顺序 = 左面板渲染顺序（GROUP_ORDER 分组后）',
    CLASS_KEY_ORDER.map((c) => CLASS_STYLES[c].label).join(' / '),
  )

  // ★ 回归：这两个位置以前是错的（用了 ALL_CLASSES 的声明序）
  check(
    CLASS_STYLES[CLASS_KEY_ORDER[2]].label === '人工新增',
    '★ 按 3 = 面板第 3 行「人工新增」（旧实现错成「林间空隙」）',
    CLASS_STYLES[CLASS_KEY_ORDER[2]].label,
  )
  check(
    CLASS_STYLES[CLASS_KEY_ORDER[4]].label === '林间空隙',
    '★ 按 5 = 面板第 5 行「林间空隙」（旧实现错成「道路」）',
    CLASS_STYLES[CLASS_KEY_ORDER[4]].label,
  )
  check(
    CLASS_STYLES[CLASS_KEY_ORDER[0]].label === '株位空缺' &&
      CLASS_STYLES[CLASS_KEY_ORDER[1]].label === '连片空地',
    '按 1 / 2 = 株位空缺 / 连片空地（与旧实现一致，不能改坏）',
    `${CLASS_STYLES[CLASS_KEY_ORDER[0]].label} / ${CLASS_STYLES[CLASS_KEY_ORDER[1]].label}`,
  )
}

console.log(`\n${pass} OK / ${fail} FAIL`)
if (fail > 0) process.exitCode = 1
