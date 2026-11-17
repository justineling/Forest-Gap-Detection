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
import { isTypingTarget, shouldIgnoreHotkey, isHotkey, HOTKEYS, isPeepKey, shouldIgnorePeepHotkey } from '../src/lib/hotkeys'

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

// ---------- G. U1: 按住 H 看底图 ----------
console.log('\nG. U1: 按住 H 看底图快捷键防误触与按键流')
{
  check(isPeepKey('h'), 'h 属于底图透视键')
  check(isPeepKey('H'), 'H 属于底图透视键')
  check(!isPeepKey(' '), '★ Space 不能作为看底图快捷键（验证集模式下已占用为认同算法）')
  check(!isPeepKey('n'), 'n 不是底图透视键')

  check(!shouldIgnorePeepHotkey({ target: null }), '空闲状态正常响应看底图')
  check(shouldIgnorePeepHotkey({ target: { tagName: 'INPUT' } }), '★ 输入框里按 H 让位（不能误触隐藏图层）')
  check(shouldIgnorePeepHotkey({ target: { tagName: 'TEXTAREA' } }), 'TEXTAREA 里按 H 让位')
  check(shouldIgnorePeepHotkey({ target: { tagName: 'DIV', isContentEditable: true } }), 'contenteditable 里让位')
  check(shouldIgnorePeepHotkey({ target: null, hasDialog: true }), '★ 弹窗打开时按 H 让位')
  check(shouldIgnorePeepHotkey({ target: null, hasModifier: true }), '★ 带修饰键（Ctrl+H / Alt+H）让位给浏览器')

  // 状态迁移测试：按下 / 松开 / 失焦
  const state = { peepBase: false }
  const onKeyDown = (k: string, ctx: Parameters<typeof shouldIgnorePeepHotkey>[0]) => {
    if (isPeepKey(k) && !shouldIgnorePeepHotkey(ctx)) {
      state.peepBase = true
    }
  }
  const onKeyUp = (k: string) => {
    if (isPeepKey(k)) state.peepBase = false
  }
  const onBlur = () => {
    state.peepBase = false
  }

  // 1. 按下测试
  onKeyDown('h', { target: null })
  check(state.peepBase === true, '★ 按下 H 键 → 图层进入隐藏透视状态（peepBase = true）')

  // 2. 松开测试
  onKeyUp('h')
  check(state.peepBase === false, '★ 松开 H 键 → 立即恢复图层显示（peepBase = false）')

  // 3. 失焦测试
  onKeyDown('H', { target: null })
  check(state.peepBase === true, '再次按下 H 键进入透视状态')
  onBlur()
  check(state.peepBase === false, '★ 窗口失焦 (window.blur) → 自动恢复图层显示（防止松键丢失一直隐藏）')
}

// ---------- 汇总 ----------
console.log('')
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
