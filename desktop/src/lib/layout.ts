/**
 * 布局尺寸（左右面板宽度 / 状态栏高度）的**纯计算**。
 *
 * ## 为什么单独一个文件
 *
 * 拖拽手柄本身（`components/Resizer.tsx`）只是把指针位移算成 `deltaPx`，
 * 真正容易写错的是"这个值能不能用"：拖过界会把面板拖没、拖到负数、
 * 窗口窄时左右面板一起把地图挤成一条缝。这些判断全是数字游戏，
 * 抽成纯函数才能被 `npm test` 逐条钉住 —— 而 UI 里那些判断一旦写错，
 * 用户看到的是"拖一下界面就崩了"，很难复现。
 *
 * ## 为什么不做持久化
 *
 * 用户明确要求「这个高度 / width 是不记忆的，每次重新登入都会回到默认配置」。
 * 所以这里只提供默认值，调用方（`App.tsx`）把它们放进 React state，
 * **不写** localStorage / settings.json。别顺手加持久化。
 */

/** 一个可拖拽尺寸的上下限（px） */
export interface SizeLimit {
  min: number
  max: number
}

/** 默认尺寸：左 288 / 右 300 / 状态栏 120（与 styles.css 的兜底值保持一致） */
export const LAYOUT_DEFAULT = { leftW: 288, rightW: 300, statusH: 120 } as const

/** 左面板宽度范围：再窄装不下图层名，再宽地图就没地方了 */
export const LEFT_LIMIT: SizeLimit = { min: 200, max: 480 }

/** 右面板宽度范围：右栏内容更宽（属性表 / 复核清单），所以上限更高 */
export const RIGHT_LIMIT: SizeLimit = { min: 220, max: 520 }

/** 状态栏高度范围：64 大约是三行日志，320 是"我想认真看日志"的极限 */
export const STATUS_LIMIT: SizeLimit = { min: 64, max: 320 }

/**
 * 地图区的最小可用宽度。
 *
 * 左右面板再怎么拖，也要给地图留这么多 —— 否则两个面板加起来把地图挤成
 * 一条竖缝，用户会以为"地图加载失败了"（实际是被挤没了）。
 */
export const MAP_MIN_W = 360

/**
 * 把尺寸夹进 `[min, max]`。
 *
 * 兜住的脏输入：
 *  · `NaN` / `Infinity`（拖拽过程中指针坐标偶尔会给出 NaN）→ 退回 `min`，
 *    绝不把 `NaN` 写进 CSS 变量 —— 那会让整个 grid 的列宽失效，
 *    界面直接错版，比"尺寸没变"糟得多；
 *  · `max < min`（窗口太窄时动态上限会低于下限）→ 退回 `min`，
 *    即"按最小值显示"，而不是返回一个越界的值。
 *
 * 刻意**不取整**：调用方可能想要小数（如 DPI 缩放），取整交给它自己决定。
 */
export function clampSize(v: number, min: number, max: number): number {
  const lo = Number.isFinite(min) ? min : 0
  const hi = Number.isFinite(max) ? max : lo
  // 只特判 NaN：±Infinity 交给下面的大小比较处理（+∞ → max，−∞ → min）
  if (Number.isNaN(v)) return lo
  if (hi < lo) return lo
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

/**
 * 拖动左面板时允许的最大宽度。
 *
 * 上限不是常量 480，而是"窗口宽度 − 右面板 − 地图最小宽度"三者取小：
 * 这样拖到边界时地图一定还留得下 {@link MAP_MIN_W}。
 */
export function maxLeftW(rightW: number, viewportW: number): number {
  const room = (Number.isFinite(viewportW) ? viewportW : 0) - rightW - MAP_MIN_W
  return Math.max(LEFT_LIMIT.min, Math.min(LEFT_LIMIT.max, room))
}

/** 拖动右面板时允许的最大宽度（对称于 {@link maxLeftW}） */
export function maxRightW(leftW: number, viewportW: number): number {
  const room = (Number.isFinite(viewportW) ? viewportW : 0) - leftW - MAP_MIN_W
  return Math.max(RIGHT_LIMIT.min, Math.min(RIGHT_LIMIT.max, room))
}

/**
 * 窗口尺寸变化后，把左右面板宽度**一起**收回到合法区间。
 *
 * 拖拽时每次只钳制被拖的那一个（另一个不动），所以"两块加起来超过窗口"
 * 只可能由**改窗口大小**引起 —— 这里统一收一次。
 *
 * 收的顺序：先收右面板（默认更宽、内容更能忍），还不够再收左面板；
 * 两块都到下限仍放不下就停手（窗口真的太窄了，此时按最小值显示，
 * 而不是把面板拖没）。
 */
export function clampLayoutWidths(
  leftW: number,
  rightW: number,
  viewportW: number,
): { left: number; right: number } {
  let left = clampSize(leftW, LEFT_LIMIT.min, LEFT_LIMIT.max)
  let right = clampSize(rightW, RIGHT_LIMIT.min, RIGHT_LIMIT.max)

  const budget = (Number.isFinite(viewportW) ? viewportW : 0) - MAP_MIN_W
  const excess = (): number => left + right - budget

  if (excess() > 0) {
    const cut = Math.min(excess(), right - RIGHT_LIMIT.min)
    right -= cut
  }
  if (excess() > 0) {
    const cut = Math.min(excess(), left - LEFT_LIMIT.min)
    left -= cut
  }
  return { left, right }
}
