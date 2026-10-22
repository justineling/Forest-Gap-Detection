/**
 * 布局尺寸钳制的单元测试（Node 直跑）。
 *
 * 守的是**"拖不坏"**这条底线：用户把面板拖到屏幕外、把窗口缩到很窄、
 * 或者指针坐标偶尔给出 NaN，界面都必须还活着。
 *
 * 这些判断写错的后果不是"数字难看"，而是：CSS 变量被写成 `NaNpx` →
 * 整条 grid 的列宽失效 → 界面错版；或者面板宽度被拖成 0 →
 * 用户以为地图加载失败了（实际是被挤没了）。
 */
import {
  LEFT_LIMIT,
  LAYOUT_DEFAULT,
  MAP_MIN_W,
  RIGHT_LIMIT,
  STATUS_LIMIT,
  clampLayoutWidths,
  clampSize,
  maxLeftW,
  maxRightW,
} from '../src/lib/layout'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

// ---------- A. clampSize 的边界 ----------
console.log('\nA. clampSize（边界值 / 越界 / NaN / 小数）')
{
  const { min, max } = LEFT_LIMIT // 200 / 480

  check(clampSize(300, min, max) === 300, '区间内原样返回')
  check(clampSize(min, min, max) === min, '★ 正好等于 min → min（不算越界）')
  check(clampSize(max, min, max) === max, '★ 正好等于 max → max（不算越界）')
  check(clampSize(min - 1, min, max) === min, '★ 小于 min → 夹到 min')
  check(clampSize(max + 1, min, max) === max, '★ 大于 max → 夹到 max')
  check(clampSize(-500, min, max) === min, '负数 → 夹到 min（面板不能被拖成负宽度）')
  check(clampSize(0, min, max) === min, '0 → 夹到 min（面板不能被拖没）')

  // NaN：拖拽中指针坐标偶尔会给出 NaN，绝不能写进 CSS 变量
  check(clampSize(Number.NaN, min, max) === min, '★ NaN → min（不能把 NaN 写进 CSS 变量）')
  check(clampSize(Number.POSITIVE_INFINITY, min, max) === max, 'Infinity → max')
  check(clampSize(Number.NEGATIVE_INFINITY, min, max) === min, '-Infinity → min')

  // 小数：只钳制，不取整（取整是调用方的事）
  check(clampSize(288.6, min, max) === 288.6, '★ 小数在区间内 → 原样保留（不取整）')
  check(clampSize(480.4, min, max) === max, '小数越上界 → 夹到 max')

  // max < min：窗口极窄时动态上限会低于下限
  check(clampSize(300, 480, 200) === 480, '★ max < min → 退回 min（按最小值显示，不返回越界值）')
  check(clampSize(Number.NaN, Number.NaN, 200) === 0, 'min 也是 NaN → 退回 0（兜底，不抛错）')
}

// ---------- B. 三组默认值与范围自洽 ----------
console.log('\nB. 默认值必须落在各自的范围内')
{
  check(
    LAYOUT_DEFAULT.leftW >= LEFT_LIMIT.min && LAYOUT_DEFAULT.leftW <= LEFT_LIMIT.max,
    '★ 左面板默认宽度在自己的范围内',
  )
  check(
    LAYOUT_DEFAULT.rightW >= RIGHT_LIMIT.min && LAYOUT_DEFAULT.rightW <= RIGHT_LIMIT.max,
    '★ 右面板默认宽度在自己的范围内',
  )
  check(
    LAYOUT_DEFAULT.statusH >= STATUS_LIMIT.min && LAYOUT_DEFAULT.statusH <= STATUS_LIMIT.max,
    '★ 状态栏默认高度在自己的范围内',
  )
  check(
    LAYOUT_DEFAULT.statusH > 60,
    '★ 状态栏默认高度比旧的 60px 日志上限更高（用户抱怨"太小，很难看日志"）',
  )
}

// ---------- C. 拖动单个面板时的动态上限 ----------
console.log('\nC. 拖拽上限（别把地图挤没）')
{
  // 1920 宽、右面板 300：左面板可以拖到常量上限 480
  check(maxLeftW(300, 1920) === LEFT_LIMIT.max, '宽窗口：左面板上限 = 常量上限 480')
  // 900 宽、右面板 300：只剩 900-300-360 = 240 可用
  check(maxLeftW(300, 900) === 240, '★ 窄窗口：上限被压到 240（900 − 300 − 360）')
  // 700 宽、右面板 300：可用 40 < 下限 200 → 按 200 显示（不能再小）
  check(maxLeftW(300, 700) === LEFT_LIMIT.min, '★ 极窄窗口：上限不低于 min（不会算出 40）')

  check(maxRightW(288, 1920) === RIGHT_LIMIT.max, '宽窗口：右面板上限 = 常量上限 520')
  check(maxRightW(288, 1000) === 352, '★ 窄窗口：上限被压到 352（1000 − 288 − 360）')
  check(maxRightW(288, 800) === RIGHT_LIMIT.min, '极窄窗口：上限不低于 min')
  check(maxLeftW(300, Number.NaN) === LEFT_LIMIT.min, 'viewport 是 NaN → 退回 min（不返回 NaN）')
}

// ---------- D. 窗口缩放后的一起收 ----------
console.log('\nD. clampLayoutWidths（改窗口大小是唯一能让两块一起超宽的路径）')
{
  const wide = clampLayoutWidths(288, 300, 1920)
  check(wide.left === 288 && wide.right === 300, '★ 宽窗口：两块都原样不动')

  const narrow = clampLayoutWidths(288, 300, 1000)
  // 预算 = 1000 − 360 = 640，现有 588 → 不超，原样
  check(narrow.left === 288 && narrow.right === 300, '★ 1000 宽仍然放得下（588 ≤ 640）→ 不动')

  const tight = clampLayoutWidths(400, 520, 1000)
  // 预算 640，现有 920 → 超 280；先收右面板 520→240（到下限 220 前收得动）
  check(tight.right === 240 && tight.left === 400, '★ 超宽先收右面板（520 → 240），左面板不动')
  check(tight.left + tight.right <= 1000 - MAP_MIN_W, '收完以后确实满足"地图至少 360"')

  const tighter = clampLayoutWidths(480, 520, 900)
  // 预算 540，现有 1000 → 超 460；右 520→220（收 300），还超 160 → 左 480→320
  check(tighter.right === RIGHT_LIMIT.min, '★ 只收右面板不够 → 右面板先到下限 220')
  check(tighter.left === 320, '★ 剩下的从左边收（480 → 320）')
  check(tighter.left + tighter.right === 900 - MAP_MIN_W, '正好让地图拿到 360')

  const tiny = clampLayoutWidths(480, 520, 500)
  check(
    tiny.left === LEFT_LIMIT.min && tiny.right === RIGHT_LIMIT.min,
    '★ 窗口小到极限 → 两块都到下限，不再继续收（面板不能被拖没）',
  )

  const dirty = clampLayoutWidths(Number.NaN, 520, 1200)
  check(dirty.left === LEFT_LIMIT.min, 'NaN 宽度 → 退回 min')
  check(Number.isFinite(dirty.right), '★ 结果里不许出现 NaN（会写进 CSS 变量）')
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
