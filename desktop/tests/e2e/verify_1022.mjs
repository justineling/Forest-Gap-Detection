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
 *
 * **隔离性**（2026-10-23 复核后补）：`/gaps` 一律由 PATCH 拦下（默认空集合 /
 * `gaps=3` / `gapsFail=1`），不落到真实后端；除第 5 段（它要验弹窗本身）外
 * 都带 `?noResume=1`，`goto()` 里再关一次 `.help-mask`。
 * 以前脚本隐含依赖"本机没有后端"——用户装了软件在跑时会 4 项假失败，
 * 而且第 2 段的失败文案（"1,726 块 / 演示"）把用户自己的数据当成了演示样例。
 * 详见 `tests/e2e/README.md`「二号大坑」。
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
 * 前置补丁：**只拦 `/gaps`，绝不拦 `/meta`**。
 *
 * ⚠️ 为什么 `/meta` 不能拦（初版的教训，别再试一遍）：初版照 `ui_regress.mjs`
 *    的写法把 `/meta` 也拦了，结果页面整个渲染不出来（步骤条都不存在）——
 *    `?mock=ready` 自己就在 probeAndLoad 之后设一份完整 meta，再拦一层只会打架。
 *    **能用开关就别改网络层**：改动面越小，失败越容易定位。
 *
 * ⚠️ 为什么 `/gaps` 必须拦（2026-10-23 复核后改）：以前完全不拦，于是脚本
 *    隐含依赖"本机没有后端"。用户装了软件、8765 上真跑着 `fgd-tile-server` 时：
 *      · `/gaps` 返回真实 1,726 块 → `shouldAskResume` 命中 → 启动询问弹窗
 *      · `.help-mask`（`z-index: 1050` + 全屏半透明底）盖住整屏
 *      · 「⋯ 更多」点不到 → 第 3、4 段各 2 项假失败
 *      · 第 2 段更糟：弹窗摘要里那句「1,726 块」被当成"演示样例痕迹"报红 ——
 *        **那是用户自己的数据，断言文案本身在误导**
 *    所以 `/gaps` 一律拦下，给确定性数据：
 *      · 默认 → 空集合（界面是"没有结果"的干净态）
 *      · `gaps=3` → 3 块（需要要素时用）
 *      · `gapsFail=1` → HTTP 500（把 loadGaps 逼进 catch 兜底，才能验演示样例的门控）
 */
const PATCH = `
(() => {
  const _f = window.fetch;
  const json = (body, status) => Promise.resolve(new Response(JSON.stringify(body),
    { status: status || 200, headers: { 'Content-Type': 'application/json' } }));
  const feat = (id, lon, lat) => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[
      [lon, lat], [lon + 0.002, lat], [lon + 0.002, lat + 0.002], [lon, lat + 0.002], [lon, lat]
    ]] },
    properties: {
      gap_id: id, class: 'vacant_slot', class_label: '株位空缺',
      area_sqm: 420.5, source: 'algo', edited: false
    }
  });
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/gaps')) {
      const qs = new URLSearchParams(location.search);
      if (qs.has('gapsFail')) return json({ error: 'e2e: 故意让 /gaps 失败' }, 500);
      if (qs.get('gaps') === '3') {
        return json({ type: 'FeatureCollection',
          features: [feat('G1', 111.18, 1.16), feat('G2', 111.19, 1.17), feat('G3', 111.20, 1.18)] });
      }
      return json({ type: 'FeatureCollection', features: [] });
    }
    return _f(input, init);
  };
})();
`

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
    await send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH })

    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', {
        expression: `(() => { ${expr} })()`,
        returnByValue: true,
        awaitPromise: true,
      })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
    /**
     * 关掉可能出现的启动弹窗（`.help-mask`）。
     *
     * `/gaps` 已在 PATCH 里隔离，正常情况下不该有弹窗；这一道是**保险**：
     * 遮罩（`z-index: 1050` + 全屏半透明底）在的话，「⋯ 更多」根本点不到，
     * 而 `clickByJs` 会抛"点不到"把整个脚本变成 exit 2 —— 比 FAIL 更难读。
     *
     * ⚠️ 找不到可点的按钮必须 **FAIL**，不能静默继续（否则后面全是空过）。
     */
    const dismissOverlay = async (label) => {
      const r = await ev(`
        const mask = document.querySelector('.help-mask');
        if (!mask) return { state: 'none' };
        const btns = [...mask.querySelectorAll('button')];
        const b =
          btns.find((x) => x.textContent.includes('继续复核')) ||
          btns.find((x) => x.textContent.includes('关闭')) ||
          btns.find((x) => (x.getAttribute('aria-label') || '') === '关闭');
        if (!b) {
          return { state: 'fail',
            why: '弹窗在，但没有可点的按钮；按钮文案：' +
              btns.map((x) => (x.textContent || '').trim()).join('/') };
        }
        b.click();
        return { state: 'closed', why: b.textContent.trim() };
      `)
      if (r.state === 'closed') {
        await sleep(900)
        const still = await ev(`return !!document.querySelector('.help-mask');`)
        check(!still, `前置：关掉启动弹窗「${label}」`)
        return still ? 'fail' : 'closed'
      }
      check(r.state === 'none', `前置：没有遮挡的启动弹窗「${label}」`, r.why ?? '')
      return r.state
    }

    /**
     * 导航 + 等界面渲染 + 清场。
     *
     * `keepOverlay=true` 用于第 5 段（它要验的正是弹窗本身）。
     */
    const goto = async (q, keepOverlay = false) => {
      await send('Page.navigate', { url: `${BASE}/${q}` })
      await sleep(2200)
      // 就绪再等一等：`.sr-item` 挂载 ≠ effect 跑完（resume 判定在 effect 里）
      const deadline = Date.now() + 12000
      while (Date.now() < deadline) {
        const ok = await ev(`return !!document.querySelector('.sr-item');`)
        if (ok) break
        await sleep(250)
      }
      await sleep(400)
      if (!keepOverlay) await dismissOverlay(q)
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
    // `noResume=1`：预览开关，强制不弹「继续上次结果」（桌面端 URL 不带它）。
    // 加上它 + PATCH 里 `/gaps` 返回空集合，这一段才与"本机有没有真后端"无关。
    await goto('?mock=ready&noResume=1')
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
    console.log('\n2. 演示样例默认不加载（判据只看「演示」字样，不看块数）')
    // ---------------------------------------------------------------
    //
    // ⚠️ 2026-10-23 复核修正：旧断言是 `/1,?726\s*块|演示/`，本机真跑着后端时
    //    `/gaps` 给回真实 1,726 块 → 启动弹窗摘要里就有「1,726 块」→ 判红。
    //    **那是用户自己的数据，不是演示样例** —— 断言文案本身在误导，
    //    而且换个环境红绿不同，等于没测。
    //
    // 新判据只认「演示」这个**代码里唯一会写的字样**
    //（`App.tsx` 的 `pushLog('演示模式：已载入内置样例数据…')`），
    // 并且配一组**负向 + 正向控制**，证明它不是永远绿：
    //   a) 正常拿到空集合 → 不该出现「演示」
    //   b) `/gaps` 打回 500（走 catch 兜底）但**没带** `?demo=1` → 仍不该出现「演示」
    //   c) `/gaps` 打回 500 **且** 带 `?demo=1` → **必须**出现「演示」
    // 没有 (c)，(a)(b) 在"样例压根加载不出来"时也会绿 = 假通过。
    const demoLog = async () =>
      ev(`
        const logs = document.querySelector('.sb-logs');
        const logText = logs ? logs.textContent : '';
        const bodyText = document.body.innerText;
        return { logText, bodyText, has: /演示/.test(logText) || /演示/.test(bodyText) };
      `)

    await goto('?mock=ready&noResume=1')
    const s2a = await demoLog()
    check(!s2a.has, 'a) 正常态没有演示样例痕迹（只查「演示」字样）', `${s2a.logText.length} 字日志`)

    await goto('?mock=ready&noResume=1&gapsFail=1')
    const s2b = await demoLog()
    check(
      !s2b.has,
      '★ b) /gaps 失败但没带 ?demo=1 → 仍然不加载演示样例（这就是"门控"本身）',
      `${s2b.logText.length} 字日志`,
    )
    // 前置：必须真的走了兜底分支，否则 b) 是空过
    check(
      /后端不可用|未载入任何结果/.test(s2b.logText),
      'b 前置：确实走了 /gaps 失败的兜底分支（否则 b 是空过）',
      s2b.logText.slice(-90).replace(/\s+/g, ' '),
    )

    await goto('?mock=ready&noResume=1&gapsFail=1&demo=1')
    const s2c = await demoLog()
    check(
      s2c.has,
      '★ c) 正向控制：带 ?demo=1 时必须出现「演示」（证明 b 不是永远绿）',
      s2c.logText.slice(-90).replace(/\s+/g, ' '),
    )

    // 回到干净态，后面的段落依赖"没有结果"的界面
    await goto('?mock=ready&noResume=1')

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
    // `keepOverlay=true`：这一段要验的就是弹窗，别让 goto 把它关掉。
    await goto('?mock=ready&resume=1', true)
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

    // ★ 清场保险的自检：再进一次带弹窗的页面，但这次**不**用 keepOverlay，
    //   `goto` 里的 dismissOverlay 应该把弹窗点掉。
    //   为什么要这条：前面几段全是 'none' 分支，'closed' 分支从没被执行过 ——
    //   一个只走过一半分支的保险等于没有保险。将来若弹窗按钮文案改了，
    //   这里会红，而不是等到某个场景莫名其妙"点不到"。
    await goto('?mock=ready&resume=1')
    const maskGone = await ev(`return !document.querySelector('.help-mask');`)
    check(maskGone, '★ 清场保险有效：带弹窗的页面被 goto 自动关掉（closed 分支真的能跑）')

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
