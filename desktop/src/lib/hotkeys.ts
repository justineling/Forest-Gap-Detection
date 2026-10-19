/**
 * 单键快捷键的「焦点防误触」判断。
 *
 * ## 为什么单独抽成纯函数
 *
 * 这批快捷键（`1/2/3/4` / `Space` / `↑↓`）全是**单键**，只要漏一道护栏就会误标：
 * 用户在面积输入框里按 `1` 想输 100，结果给当前块标了"真需补种" —— 而且
 * 标注是持久化的，误标会被悄悄存进验证集，污染后面所有打分。
 *
 * 这类"防护逻辑"必须能被测试逐条覆盖。写在 DOM 事件回调里就测不到了。
 *
 * ## 四道护栏
 *
 * 1. **焦点在输入控件里** → 让位（INPUT / TEXTAREA / SELECT / contenteditable）
 * 2. **有弹窗打开** → 让位（导出 / 预检 / 帮助三个对话框都带 `role="dialog"`）
 * 3. **带修饰键** → 让位（`Ctrl+1` / `Cmd+1` 是别人的快捷键，比如切换标签页）
 * 4. **按住不放（repeat）** → 让位（长按 `1` 会连续标十几块）
 */

/** 焦点在输入控件里？ */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (!el) return false
  if (el.isContentEditable) return true
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? '')
}

export interface HotkeyContext {
  /** 焦点元素（一般传 `e.target`） */
  target: { tagName?: string; isContentEditable?: boolean } | null
  /** 页面上是否有 `role="dialog"` 的弹窗 */
  hasDialog: boolean
  /** 是否带 Ctrl / Cmd / Alt */
  hasModifier: boolean
  /** 是否是按住不放产生的重复事件 */
  repeat: boolean
}

/**
 * 该不该**忽略**这次按键。
 *
 * 返回 true = 让位（不要处理）；false = 可以处理。
 * 默认偏保守：任何一条命中就让位 —— 误标的代价远大于"按了没反应"。
 */
export function shouldIgnoreHotkey(ctx: HotkeyContext): boolean {
  if (ctx.hasModifier) return true
  if (ctx.repeat) return true
  if (ctx.hasDialog) return true
  if (isTypingTarget(ctx.target)) return true
  return false
}

/** 这个键属于单键快捷键集合吗（用于决定要不要 preventDefault） */
export const HOTKEYS = new Set(['1', '2', '3', '4', ' ', 'Enter', 'ArrowUp', 'ArrowDown'])

export function isHotkey(key: string): boolean {
  return HOTKEYS.has(key)
}
