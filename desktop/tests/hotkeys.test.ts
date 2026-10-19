/**
 * 单键快捷键防误触的单元测试。
 *
 * 这些断言的价值全在"**不该响应的时候真的没响应**"：
 * 误标的代价不是"按了没反应"，而是**污染验证集** —— 而且标注是持久化的，
 * 一次误标会被悄悄存进去，后面所有打分都被它拉偏。
 *
 * 所以这一组测试**刻意只测 false 分支**（该让位的情形），
 * 因为 true 分支（该响应）出错只是"按了没反应"，容易发现。
 */
import { isTypingTarget, shouldIgnoreHotkey, isHotkey, HOTKEYS } from '../src/lib/hotkeys'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

const idle = {
  target: null,
  hasDialog: false,
  hasModifier: false,
  repeat: false,
}

// ---------- A. 输入控件 ----------
console.log('\nA. 焦点在输入控件里 → 必须让位')
{
  check(isTypingTarget({ tagName: 'INPUT' }), 'INPUT')
  check(isTypingTarget({ tagName: 'TEXTAREA' }), 'TEXTAREA')
  check(isTypingTarget({ tagName: 'SELECT' }), 'SELECT')
  check(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), 'contenteditable')
  check(!isTypingTarget({ tagName: 'DIV' }), '普通 DIV 不算输入')
  check(!isTypingTarget({ tagName: 'BUTTON' }), 'BUTTON 不算输入（点完按钮还能用快捷键）')
  check(!isTypingTarget(null), 'null 不算输入')

  check(
    shouldIgnoreHotkey({ ...idle, target: { tagName: 'INPUT' } }),
    '★ 输入框里按 1 → 让位（否则输 "100" 会标 3 次真值）',
  )
  check(
    shouldIgnoreHotkey({ ...idle, target: { tagName: 'DIV', isContentEditable: true } }),
    '★ contenteditable 里也让位',
  )
}

// ---------- B. 弹窗 ----------
console.log('\nB. 有弹窗打开 → 必须让位')
{
  check(
    shouldIgnoreHotkey({ ...idle, hasDialog: true }),
    '★ 帮助/导出/预检弹窗打开时按 Space → 让位（否则会顺手标一块）',
  )
  check(!shouldIgnoreHotkey(idle), '没弹窗时正常响应')
}

// ---------- C. 修饰键 ----------
console.log('\nC. 带 Ctrl / Cmd / Alt → 让位给别人的快捷键')
{
  check(shouldIgnoreHotkey({ ...idle, hasModifier: true }), '★ Ctrl+1 不该标真值（浏览器切标签页）')
  check(!shouldIgnoreHotkey({ ...idle, hasModifier: false }), '不带修饰键才处理')
}

// ---------- D. 长按 ----------
console.log('\nD. 按住不放（repeat）→ 让位')
{
  check(
    shouldIgnoreHotkey({ ...idle, repeat: true }),
    '★ 长按 1 会连续标十几块 —— repeat 必须拦',
  )
  check(!shouldIgnoreHotkey({ ...idle, repeat: false }), '单击正常处理')
}

// ---------- E. 组合 ----------
console.log('\nE. 多条同时命中仍然让位')
{
  check(
    shouldIgnoreHotkey({
      target: { tagName: 'INPUT' },
      hasDialog: true,
      hasModifier: true,
      repeat: true,
    }),
    '四条全命中 → 让位',
  )
}

// ---------- F. 键位集合 ----------
console.log('\nF. 单键集合')
{
  for (const k of ['1', '2', '3', '4', ' ', 'Enter', 'ArrowUp', 'ArrowDown']) {
    check(isHotkey(k), `「${k === ' ' ? 'Space' : k}」属于单键集合`)
  }
  check(!isHotkey('5'), '5 不属于（只标 1~4）')
  check(!isHotkey('a'), 'a 不属于')
  check(!isHotkey('Delete'), 'Delete 不属于（那是全局删除选中，语义不同）')
  check(HOTKEYS.size === 8, '集合大小 = 8', String(HOTKEYS.size))
}

// ---------- 汇总 ----------
console.log('')
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
