/**
 * 2026-10-22 交互改动的浏览器侧回归（CDP 真点击）。
 *
 * 为什么单独一个脚本
 * ------------------
 * 交接文档 §4 列了 8 项"待真机验证"。其中**能在浏览器里验的**不该占用真机时间：
 * 步骤条状态、更多菜单分组、参数窗推荐值、状态栏加速来源、演示样例门控 ——
 * 这五项只依赖前端逻辑，用 headless + 真鼠标事件就能确定性地验。
 * 剩下三项（进度平滑、关窗拦截、金字塔真建）必须真窗口，脚本里明确标出来。
 *
 * 与 `ui_regress.mjs` 的关系：同一个 CDP 骨架，但**不共用**——那个脚本守的是
 * 10-19 那 13 条 UI 改造，这个守 10-22 的五项。混在一起，任何一边失败都要
 * 读两套断言才知道是谁坏了。
 *
 * 依赖
 * ----
 * - dev server：`cd desktop && npm run dev`（默认 5173，可用 E2E_BASE 覆盖）
 * - Chrome：`CHROME_PATH` 环境变量，或默认路径
 *
 * 用法
 * ----
 *   node desktop/tests/e2e/verify_1022.mjs
 *
 * ⚠️ 不进 `npm test`（需要浏览器 + dev server，CI 跑不了）。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = process.env.E2E_BASE || 'http://localhost:5173'
const PORT = 9333
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * ⚠️ 这里**不**拦截 fetch。
 *
 * 初版照 `ui_regress.mjs` 的写法拦截了 `/meta` 与 `/gaps`，结果页面整个渲染不出来
 * （步骤条都不存在）。`?mock=ready` 自己就提供了完整 meta（含 `bounds_wgs84`），
 * 再拦一层只会和它打架。**能用开关就别改网络层** —— 改动面越小，失败越容易定位。
 */

async function pageWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(150)
  }
  throw new Error(`CDP 未就绪（端口 ${PORT}）`)
}

function makeClient(ws) {
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { send }
}

let pass = 0
let fail = 0
function check(ok, label, detail = '') {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? `  ·  ${detail}` : ''}`)
  ok ? pass++ : fail++
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'qa-1022-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1440,900',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    const ws = new WebSocket(await pageWs())
    await new Promise((r) => ws.addEventListener('open', r))
    const { send } = makeClient(ws)
    await send('Page.enable')
    await send('Runtime.enable')

    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: `(() => { ${expr} })()`,
        returnByValue: true,
        awaitPromise: true,
      })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    const goto = async (q) => {
      await send('Page.navigate', { url: `${BASE}/${q}` })
      await sleep(2200)
    }
    /** 用真鼠标事件点一个选择器（CDP Input 比 el.click() 更接近用户） */
    const click = async (sel) => {
      const box = await ev(`
        const el = document.querySelector(${JSON.stringify(sel)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      `)
      if (!box) throw new Error(`点不到 ${sel}`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        })
      }
      await sleep(400)
    }
    /** 按 JS 表达式定位元素再点（页面上 .btn.icon 有 5 个，靠选择器点不准） */
    const clickByJs = async (elemExpr) => {
      const box = await ev(`
        const el = ${elemExpr};
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      `)
      if (!box) throw new Error(`点不到：${elemExpr}`)
      for (const type of ['mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', {
          type, x: box.x, y: box.y, button: 'left', clickCount: 1,
        })
      }
      await sleep(400)
    }

    // ---------------------------------------------------------------
    console.log('\n1. 步骤条：选完影像后应停在「确定范围」，而不是跳到「复核结果」')
    // ---------------------------------------------------------------
    await goto('?mock=ready')
    const activeLabel = await ev(`
      const el = document.querySelector('.sr-item.active .sr-label');
      return el ? el.textContent.trim() : null;
    `)
    check(activeLabel === '确定范围', 'active 步骤是「确定范围」', String(activeLabel))
    const reviewCls = await ev(`
      const items = [...document.querySelectorAll('.sr-item')];
      const i = items.findIndex(e => e.querySelector('.sr-label')?.textContent.includes('复核'));
      return i >= 0 ? items[i].className : null;
    `)
    check(
      reviewCls !== null && !reviewCls.includes('active'),
      '「复核结果」不是 active（没有历史结果时不该跳过去）',
      String(reviewCls),
    )

    // ---------------------------------------------------------------
    console.log('\n2. 默认不加载演示样例（?mock=ready 未带 ?demo=1）')
    // ---------------------------------------------------------------
    const hasDemo = await ev(`
      // 演示样例会在状态栏/卡片里出现块数；空结果时不应出现任何"块"计数
      const t = document.body.innerText;
      return /1,?726\\s*块|演示/.test(t);
    `)
    check(hasDemo === false, '界面没有演示样例痕迹（1,726 块 / 演示）')

    // ---------------------------------------------------------------
    console.log('\n3.「⋯ 更多」分三组，且每项有一行说明')
    // ---------------------------------------------------------------
    await clickByJs("[...document.querySelectorAll('button')].find(b => b.textContent.trim() === '⋯')")
    const groups = await ev(`
      return [...document.querySelectorAll('.more-group-title')].map(e => e.textContent.trim());
    `)
    check(
      Array.isArray(groups) && groups.length === 3 && groups.join('/') === '数据/工具/帮助',
      '三组标题为 数据 / 工具 / 帮助',
      JSON.stringify(groups),
    )
    const descs = await ev(`
      return [...document.querySelectorAll('.more-item-desc')].map(e => e.textContent.trim());
    `)
    check(
      Array.isArray(descs) && descs.length > 0 && descs.every((d) => d.length > 0),
      '每个菜单项都有说明文字',
      `${descs?.length ?? 0} 项`,
    )

    // ---------------------------------------------------------------
    console.log('\n4. 参数窗：进程数带「已按你的电脑推荐」+ 分组兜底提示')
    // ---------------------------------------------------------------
    const hasSettingsItem = await ev(`
      return [...document.querySelectorAll('.more-item-label')].some(e => e.textContent.includes('参数'));
    `)
    if (!hasSettingsItem) {
      check(false, '能在菜单里找到「检测参数」入口')
    } else {
      await clickByJs("[...document.querySelectorAll('.more-item-label')].find(e => e.textContent.includes('参数'))?.closest('button')")
      await sleep(600)
      const dlg = await ev(`
        const d = document.querySelector('.detect-settings') || document.querySelector('.help-dialog');
        return d ? d.innerText : '';
      `)
      // 先确认弹窗真的开了：空字符串会让下面几条断言**空过**
      check(dlg.length > 0, '参数窗已打开（否则后面几条断言都是空过）', `${dlg.length} 字`)
      check(/已按你的电脑推荐/.test(dlg), '进程数标了「已按你的电脑推荐」')
      check(/上次使用/.test(dlg), '参数窗有「上次使用」提示')
      check(/不确定就保持默认/.test(dlg), '有「不确定就保持默认」的兜底提示')
      // 从「更多」进来是"编辑"入口，不该出现「开始检测」
      check(!/开始检测/.test(dlg), '编辑入口不显示「开始检测」（避免误触）')
    }

    // ---------------------------------------------------------------
    console.log('\n5. 启动时询问「继续上次结果 / 重新开始」')
    // ---------------------------------------------------------------
    // 用户原话：「默认就读取并直接跳转到第四步了，应该有 1 个弹窗让用户决定」。
    // 用 ?resume=1 预览这条路径（桌面端不带该参数，走真实判定）。
    await goto('?mock=ready&resume=1')
    const resumeText = await ev(`
      const d = document.querySelector('.help-dialog, .resume-dialog');
      return d ? d.innerText : '';
    `)
    check(resumeText.length > 0, '弹窗已渲染（否则后面几条断言空过）', `${resumeText.length} 字`)
    check(/发现上次的检测结果/.test(resumeText), '标题是「发现上次的检测结果」')
    check(/继续复核/.test(resumeText), '有「继续复核上次结果」按钮')
    check(/重新开始/.test(resumeText), '有「重新开始」按钮')
    check(/1,?726/.test(resumeText), '摘要里有块数（千分位）')
    check(
      !/geojson|gaps|job|mtime|NDJSON|sidecar/i.test(resumeText),
      '文案里没有技术词',
    )

    // ---------------------------------------------------------------
    console.log('\n6. 必须真窗口才能验的四项（本脚本不覆盖）')
    // ---------------------------------------------------------------
    console.log('  [SKIP] 进度平滑 —— 需要真实检测（6 分钟）')
    console.log('  [SKIP] 关窗拦截 —— 需要真实窗口 + 系统对话框')
    console.log('  [SKIP] 金字塔真建 —— 需要无金字塔影像 + 2~3 分钟')
    console.log('  [SKIP] 状态栏「加速：…」 —— StatusBar 调 overviewPlan() 这个 Tauri 命令，浏览器里没有')
  } finally {
    chrome.kill()
    try { rmSync(profile, { recursive: true, force: true }) } catch {}
  }

  console.log(`\n${fail === 0 ? '✅ 全部通过' : `❌ ${fail} 项失败`}  （${pass} 通过 / ${fail} 失败）`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('脚本异常：', e)
  process.exit(2)
})
