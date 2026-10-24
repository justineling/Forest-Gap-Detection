/**
 * 组件渲染冒烟测试：抓「白屏 / Minified React error #310」。
 *
 * 手工验证脚本，**不进 `npm test`**（需要浏览器 + dev server）。
 *
 * 用法：
 *   cd desktop && npm run dev              # 另开一个终端，等它打印 Local: http://localhost:5173/
 *   node desktop/tests/e2e/verify_render.mjs
 *
 * 环境变量：
 *   APP_URL      默认 http://localhost:5173/
 *   CHROME_PATH  默认 C:\Program Files\Google\Chrome\Application\chrome.exe
 *   CDP_PORT     默认 9455（与 verify_layout.mjs 的 9444 分开，两个脚本可并行）
 *   SHOT_DIR     默认 tmp/shots-render/（`tmp/` 已被 .gitignore 忽略）
 *
 * 退出码：0 = 全部通过，1 = 有失败项（与 verify_layout.mjs 风格一致）。
 *
 * ## 为什么需要这个脚本
 *
 * 2026-10-23 真机白屏：`NextStepCard` 里 `if (input.detectRunning) return null`
 * 被插在了 `useEffect` **之前** —— 检测一开始，hook 数从 3 变 2，React 抛
 * `Minified React error #310`，整块界面白掉。
 *
 * **`npm test` 抓不到**（16 个 `.ts` 文件都是纯 node 单元测试，不渲染组件），
 * **`tsc` 也抓不到**（类型完全合法，只是 hook 顺序违反运行时不变量）。
 * 所以只能真渲染一次、并且**真的经历一次状态切换**才能发现。
 *
 * ## 从 verify_layout.mjs 继承的三个坑（踩过，别重犯）
 *
 * ① **别拦 `/meta`**：`?mock=ready` 自己会伪造一份完整 meta，再拦一层的话
 *    页面根本渲染不出来（实测：全部断言假失败）。本脚本因此**一个 fetch 都不拦**。
 * ② **页面上有多个 `.btn.icon`**：必须按文字定位按钮，不能按下标。
 * ③ **查错容器会让断言"空字符串通过"**：所以每条断言前先确认目标元素真的存在
 *    （见 `mustExist()`），否则"没找到"会被读成"没问题"。
 *
 * ## 隔离性（2026-10-23 复核后补）
 *
 * 所有 URL 都带 `?noResume=1`（预览开关，桌面端不带），并在 `goto()` 里再关一次
 * `.help-mask`。原因：`?mock=ready` 只伪造 `/meta`，**没隔离 `/gaps`** ——
 * 机器上真跑着 `fgd-tile-server` 时 `/gaps` 会返回真实 1,726 块 →
 * 启动询问弹窗盖住全屏 → 脚本结果随"有没有装软件"而变。
 * 这类"环境不同就红/绿"的脚本等于没有。
 *
 * ## 检测态是怎么模拟出来的 *
 * `App.tsx` 的启动 effect 里有：
 *   `if (!isTauri() && qs.has('detect')) { detectBegin(); detectProgress({...}) }`
 * 而 `detectBegin()` 直接把 store 的 `detect.running` 置 true —— 所以
 * **`?mock=ready&detect=1` 就够了**，不需要新增任何预览开关。
 *
 * 注意这仍然是**真的状态切换**，不是"一开始就是检测态"：
 * 首帧 `running=false`（卡片已挂载）→ effect 触发 → `running=true`（卡片卸载）。
 * 也就是说 #310 那个"hook 数变化"的路径在这里会被真实走一遍。
 * 离开检测态走 `DetectBar` 的「中止检测」按钮：浏览器模式下
 * `cancelDetect()` 直接返回一句提示、`finally` 里 `detectReset()` 把 running 置回 false。
 *
 * ## 场景 4 / 5（2026-10-24 步骤流转 UX 修复的回归）
 *
 *  · 场景 4：`?settings=1` 打开检测参数窗 → 「下一步」卡片必须**默认折叠**
 *    （`.next-pill` 在、`.next-card` 不在），关掉参数窗后自动展开回来。
 *  · 场景 5：`?roi=1`（本次新增的预览开关，只作用于浏览器）伪造一个"已圈选"状态
 *    → 卡片停在第 3 步且带「清除圈选，改跑整幅」→ 点它之后卡片必须回到第 2 步。
 *    没有这个开关就**测不到**那条分支（浏览器里没有真实绘制结果），
 *    而"截图里没有、上线才发现"这个项目已经踩过一次。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9455)
const BASE = process.env.APP_URL || 'http://localhost:5173/'
const OUT = process.env.SHOT_DIR || join(process.cwd(), 'tmp', 'shots-render')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let fails = 0
let total = 0
const ok = (cond, label, detail = '') => {
  total++
  console.log(`  [${cond ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!cond) fails++
}

async function pageWs() {
  for (let i = 0; i < 120; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const p = list.find((t) => t.type === 'page')
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl
    } catch {}
    await sleep(150)
  }
  throw new Error(`CDP 未就绪（端口 ${PORT}）—— Chrome 起不来？检查 CHROME_PATH`)
}

/**
 * 极简 CDP 客户端。
 *
 * 与 verify_layout.mjs 的区别：多一个 `onEvent` 回调。
 * **必须**能收到事件，否则拿不到 `Runtime.consoleAPICalled` —— 而 React 的
 * #310 报错在 headless 下往往只出现在 console 里（`window.onerror` 有时收不到
 * 生产构建里的 "Minified React error"）。两个来源都要挂，只查 DOM 文本不够。
 */
function makeClient(ws, onEvent) {
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      return
    }
    if (msg.method && onEvent) onEvent(msg.method, msg.params)
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { send }
}

/**
 * 页面内的错误收集器。
 *
 * 三个来源都要挂，因为它们覆盖的场景不同：
 *  · `window.onerror` —— 未捕获异常（React 在开发构建里会从这里冒出来）
 *  · `unhandledrejection` —— async 渲染链里的失败
 *  · `console.error` —— React 会把 "Minified React error #310" 打到这里，
 *    而在 **headless + 生产构建**下这条往往不会抛成异常，只留一行日志。
 */
const ERROR_HOOK = `
(() => {
  window.__renderErrors = [];
  const push = (src, text) => {
    try { window.__renderErrors.push(src + ': ' + String(text)); } catch (e) {}
  };
  window.addEventListener('error', (e) => {
    push('window.error', (e && (e.message || (e.error && e.error.message))) || 'unknown');
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    push('unhandledrejection', (r && (r.message || r)) || 'unknown');
  });
  const orig = console.error;
  console.error = function (...args) {
    push('console.error', args.map((a) => (a && a.message) || String(a)).join(' '));
    return orig.apply(this, args);
  };
})();
`

async function main() {
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'qa-render-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1280,800',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  const ws = new WebSocket(await pageWs())
  await new Promise((r) => ws.addEventListener('open', r))

  /** CDP 事件里收到的 console 报错（与页面内 hook 互为补充） */
  const consoleErrors = []
  const { send } = makeClient(ws, (method, params) => {
    if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
      const text = (params.args ?? [])
        .map((a) => a?.value ?? a?.description ?? a?.unserializableValue ?? '')
        .join(' ')
      consoleErrors.push(text)
    }
    if (method === 'Runtime.exceptionThrown') {
      const d = params?.exceptionDetails ?? {}
      consoleErrors.push(d.exception?.description ?? d.text ?? 'exceptionThrown')
    }
  })
  await send('Page.enable')
  await send('Runtime.enable')
  // 每个新文档都先装错误收集器（addScriptToEvaluateOnNewDocument 会在页面脚本之前跑）
  await send('Page.addScriptToEvaluateOnNewDocument', { source: ERROR_HOOK })

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    const p = join(OUT, `${name}.png`)
    writeFileSync(p, Buffer.from(r.data, 'base64'))
    console.log(`      ↳ 截图 ${p}`)
    return p
  }

  /**
   * 关掉可能出现的启动弹窗（`.help-mask`：继续上次结果 / 帮助）。
   *
   * 为什么每个脚本都要这一道（2026-10-23 复核发现）：`?mock=ready` 只伪造了
   * `/meta`，**没有隔离 `/gaps`** —— 用户装了软件、机器上真跑着 `fgd-tile-server`
   * 时，`/gaps` 会给回真实 1,726 块 → 启动询问弹窗出现 →
   * `.help-mask`（`z-index: 1050` + 全屏半透明底）把整屏盖住。
   * 实测 `elementFromPoint` 命中三个 `.resizer` 的结果**全是 help-mask**，
   * 于是拖拽类脚本出现 8 项"假失败"（功能没坏，是环境不同）。
   *
   * ⚠️ 找不到可点的按钮时必须 **FAIL**，不能静默继续 ——
   *    弹窗还在的话后面那些"元素不存在/文本为空"的断言会**空过**，比红更糟。
   *
   * @returns {'none'|'closed'|'fail'} none=本来就没有弹窗
   */
  const dismissOverlay = async (label) => {
    const r = await evalJs(`
      const mask = document.querySelector('.help-mask');
      if (!mask) return { state: 'none' };
      // 优先「继续复核」：它只是把结果应用上，不清数据；「重新开始」会清空，
      // 用在布局/渲染脚本里会顺手改掉被测状态。
      const btns = [...mask.querySelectorAll('button')];
      const b =
        btns.find((x) => x.textContent.includes('继续复核')) ||
        btns.find((x) => x.textContent.includes('关闭')) ||
        btns.find((x) => (x.getAttribute('aria-label') || '') === '关闭');
      if (!b) {
        return {
          state: 'fail',
          why: '弹窗在，但没有可点的按钮；按钮文案：' +
            btns.map((x) => (x.textContent || '').trim()).join('/'),
        };
      }
      b.click();
      return { state: 'closed', why: b.textContent.trim() };
    `)
    if (r.state === 'closed') {
      await sleep(900)
      // 复核一次：点了没关掉也算失败（否则后面的断言还是在遮罩下跑）
      const still = await evalJs(`return !!document.querySelector('.help-mask');`)
      ok(!still, `前置：关掉启动弹窗「${label}」（点「${r.why}」后遮罩已消失）`)
      return still ? 'fail' : 'closed'
    }
    ok(r.state === 'none', `前置：没有遮挡的启动弹窗「${label}」`, r.why ?? '')
    return r.state
  }

  /**
   * 导航 + 等到界面真的渲染出来。
   *
   * 为什么不能只 sleep：vite 冷启动要现编译模块，固定等 3 秒会出现
   * "时灵时不灵"的假失败（verify_layout.mjs 的注释里记了这笔）。
   * 就绪判据 = `.app` 存在 **且** 第 1 步已打勾（影像就绪）。
   *
   * @param {string} query 例如 `?mock=ready&noResume=1`
   * @param {{dismiss?: boolean}} [opts] `dismiss: false` = **不要**自动关启动弹窗。
   *   场景 7 测的就是"`.resume-dialog` 还在不在"，被 dismissOverlay 顺手点掉之后
   *   断言会全部空过 —— 所以那里必须显式关掉这一道。默认 true，其余场景行为不变。
   */
  const goto = async (query, opts = {}) => {
    const dismiss = opts.dismiss !== false
    // 每次导航清空上一页留下的错误（同一页面内后续状态切换的错误由下一次快照读）
    consoleErrors.length = 0
    await send('Page.navigate', { url: BASE + query })
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const ready = await evalJs(`
        return !!document.querySelector('.app') && !!document.querySelector('.sr-item.done');
      `)
      if (ready) {
        await sleep(700)
        // 弹窗可能还在挂载（resume 判定在 effect 里）→ 保险再关一次
        if (dismiss) await dismissOverlay(query)
        return true
      }
      await sleep(250)
    }
    console.log('  [WARN] 界面 20 秒内未就绪（dev server 冷启动 / 后端探测慢？）')
    return false
  }

  /**
   * 前置条件守卫。
   *
   * 这就是坑 ③：如果目标元素根本不存在，`textContent ?? ''` 会让
   * "检查有没有报错"这类断言**空字符串通过** —— 一次假通过比一次失败更糟。
   */
  const mustExist = async (selector, label) => {
    const n = await evalJs(
      `return document.querySelectorAll(${JSON.stringify(selector)}).length;`,
    )
    ok(n > 0, `前置：${label}（${selector} 存在）`, `找到 ${n} 个`)
    return n > 0
  }

  /** 汇总所有错误来源，返回与 React 崩溃相关的那些 */
  const collectErrors = async () => {
    const page = await evalJs(`return (window.__renderErrors || []).slice();`)
    return [...page, ...consoleErrors].filter((s) => typeof s === 'string' && s.length > 0)
  }

  const isCrash = (s) =>
    /Minified React error/i.test(s) || /#310/.test(s) || /Rendered more hooks|Rendered fewer hooks/i.test(s)

  // ================= 场景 1：基线 =================
  console.log('\n=== 场景 1：基线（?mock=ready 能正常渲染）===')
  let shotPath = null
  {
    const ready = await goto('?mock=ready&noResume=1')
    ok(ready, '★ 界面在 20 秒内渲染完成（.app + 第 1 步已打勾）')
    await mustExist('.app', '应用根容器')
    await mustExist('.sr-item', '步骤条条目')
    const st = await evalJs(`
      return {
        textLen: document.body.innerText.length,
        hasNextCard: !!document.querySelector('.next-card'),
        hasDetectBar: !!document.querySelector('.detect-bar'),
        step: document.querySelector('.sr-item.active .sr-label')?.textContent ?? null,
      };
    `)
    ok(st.textLen > 200, '★ 页面有实际内容（body.innerText.length > 200）', `${st.textLen} 字符`)
    ok(st.hasNextCard, '非检测态：「下一步」引导卡片存在（.next-card）', `第 ${st.step} 步`)
    ok(!st.hasDetectBar, '非检测态：没有进度条（.detect-bar 不存在）')
    const errs = await collectErrors()
    const crash = errs.filter(isCrash)
    ok(crash.length === 0, '★ 基线没有 React 崩溃日志', crash.slice(0, 2).join(' | '))
    shotPath = await shot('1-baseline')
  }

  // ================= 场景 2：#310 现场（核心） =================
  //
  // 关键：这里不是"再加载一个已经是检测态的页面"，而是让界面从
  // **非检测态切换到检测态** —— 首帧 running=false（卡片挂载），
  // effect 里 detectBegin() 把它变成 true（卡片卸载）。hook 数变化的
  // 那条路径就是在这个切换里被走到的。
  console.log('\n=== 场景 2：★ #310 现场（进入检测态）===')
  {
    const ready = await goto('?mock=ready&detect=1&noResume=1')
    ok(ready, '界面渲染完成')

    // 前置：必须真的进了检测态，否则后面"卡片消失"是假通过
    const inDetect = await evalJs(`
      return {
        bar: !!document.querySelector('.detect-bar'),
        running: !!document.querySelector('.detect-bar.running'),
        track: !!document.querySelector('.db-track'),
        fill: !!document.querySelector('.db-fill'),
      };
    `)
    ok(inDetect.bar, '★ 前置：进度条已出现（.detect-bar 存在）', '检测态模拟成功')
    ok(inDetect.running, '★ 前置：进度条处于"检测中"（.detect-bar.running）')
    ok(inDetect.track && inDetect.fill, '前置：进度条有轨道与填充（.db-track / .db-fill）')

    const st = await evalJs(`
      return {
        app: !!document.querySelector('.app'),
        textLen: document.body.innerText.length,
        hasNextCard: !!document.querySelector('.next-card'),
        hasPill: !!document.querySelector('.next-pill'),
        detectText: (document.querySelector('.detect-bar')?.textContent ?? '').slice(0, 120),
      };
    `)
    ok(st.app, '★ 没有白屏：.app 仍在')
    ok(st.textLen > 200, '★ 没有白屏：页面仍有实际内容', `${st.textLen} 字符`)
    ok(!st.hasNextCard && !st.hasPill, '★ 检测态下引导卡片消失（.next-card / .next-pill 都不在）')
    ok(
      st.detectText.length > 0,
      '进度条有可读文字（不是空壳）',
      st.detectText.replace(/\s+/g, ' '),
    )

    // 三个来源一起查：DOM 文本 / 页面内 hook / CDP 事件
    const errs = await collectErrors()
    const crash = errs.filter(isCrash)
    ok(
      crash.length === 0,
      '★ 没有任何 Minified React error / #310（DOM + window.onerror + console 三处都查）',
      crash.slice(0, 2).join(' | '),
    )
    const domText = await evalJs(`return document.body.innerText;`)
    ok(
      !/Minified React error|#310/.test(domText),
      '★ DOM 里也没有错误文案',
      domText.length > 0 ? '' : '（DOM 为空 —— 这本身就是白屏）',
    )
    shotPath = await shot('2-detect-running')
  }

  // ================= 场景 3：离开检测态（反向切换） =================
  //
  // 为什么要验反方向：hook 数"变少"会崩、"变多"同样会崩。
  // 只验一个方向等于只验了一半 —— 而这次的 bug 恰好就是"少了一个 hook"。
  console.log('\n=== 场景 3：★ 离开检测态（反向切换，卡片要回来）===')
  {
    const clicked = await evalJs(`
      const bar = document.querySelector('.detect-bar');
      if (!bar) return { ok: false, why: '没有 .detect-bar' };
      // 坑 ②：按**文字**定位，不按下标。这里的按钮文案是「取消」，
      // 而"中止检测"只在 title 里 —— 两个都认，避免文案改一个字就静默跳过。
      const b = [...bar.querySelectorAll('button')].find(
        (x) =>
          (x.getAttribute('title') || '').includes('中止检测') ||
          x.textContent.trim() === '取消',
      );
      if (!b) {
        return {
          ok: false,
          why: '按钮文案：' + [...bar.querySelectorAll('button')].map((x) => x.textContent.trim()).join('/'),
        };
      }
      b.click();
      return { ok: true, why: b.textContent.trim() };
    `)
    ok(clicked.ok, '★ 前置：找到并点击了「中止检测」（按文字定位，不按下标）', clicked.why)
    await sleep(900)

    const st = await evalJs(`
      return {
        app: !!document.querySelector('.app'),
        bar: !!document.querySelector('.detect-bar'),
        card: !!document.querySelector('.next-card'),
        pill: !!document.querySelector('.next-pill'),
        textLen: document.body.innerText.length,
        step: document.querySelector('.sr-item.active .sr-label')?.textContent ?? null,
      };
    `)
    ok(st.app && st.textLen > 200, '★ 退出检测态后页面仍然完好', `${st.textLen} 字符`)
    ok(!st.bar, '进度条已消失（detectReset 生效）')
    ok(
      st.card || st.pill,
      '★ 引导卡片重新出现（证明 hook 数在两个方向上一致）',
      `第 ${st.step} 步`,
    )
    const errs = await collectErrors()
    const crash = errs.filter(isCrash)
    ok(crash.length === 0, '★ 反向切换也没有 React 崩溃', crash.slice(0, 2).join(' | '))
    shotPath = await shot('3-detect-exited')
  }

  // ================= 场景 4：参数窗打开 → 卡片默认折叠 =================
  //
  // 用户原话：「在开始检测时，（检测参数弹窗）出现后，应该把中间右下角那个
  // 可展开/折叠的弹窗给默认折叠，这是 ux 交互很重要的一点，减少画面的信息量。」
  //
  // `?settings=1` 是已有的预览开关（App 启动 effect 里 `setShowSettings(true)`），
  // 所以这个场景**不需要新增任何开关**，走的就是真实路径。
  console.log('\n=== 场景 4：★ 参数窗打开时「下一步」卡片默认折叠 ===')
  {
    const ready = await goto('?mock=ready&settings=1&noResume=1')
    ok(ready, '界面渲染完成')
    const hasDialog = await mustExist('.detect-settings', '检测参数窗')
    if (hasDialog) {
      const st = await evalJs(`
        return {
          card: !!document.querySelector('.next-card'),
          pill: !!document.querySelector('.next-pill'),
          pillText: (document.querySelector('.next-pill')?.textContent ?? '').trim(),
          pillLocked: !!document.querySelector('.next-pill.np-locked'),
          step: document.querySelector('.sr-item.active .sr-label')?.textContent ?? null,
        };
      `)
      ok(!st.card, '★ 参数窗打开时没有展开的卡片（.next-card 不存在）')
      ok(st.pill, '★ 卡片折叠成胶囊（.next-pill 存在）', `当前第 ${st.step} 步`)
      // 折叠不能把信息全吞掉：胶囊上仍要写清"现在停在哪一步"
      ok(st.pillText.length > 0, '★ 胶囊没有丢文案（仍能看出停在第几步）', st.pillText)
      ok(st.pillLocked, '胶囊处于"参数窗打开"的锁定态（不是可点的死按钮）')
    }

    // 关掉参数窗 → 卡片要自己展开回来
    const closed = await evalJs(`
      const dlg = document.querySelector('.detect-settings');
      if (!dlg) return { ok: false, why: '没有参数窗' };
      const btns = [...dlg.querySelectorAll('button')];
      const b =
        btns.find((x) => (x.getAttribute('title') || '') === '关闭') ||
        btns.find((x) => x.textContent.trim() === '✕');
      if (!b) {
        return { ok: false, why: '按钮文案：' + btns.map((x) => x.textContent.trim()).join('/') };
      }
      b.click();
      return { ok: true, why: b.getAttribute('title') || b.textContent.trim() };
    `)
    ok(closed.ok, '★ 前置：找到并点击参数窗的关闭按钮（按 title / 文字定位）', closed.why ?? '')
    await sleep(600)
    const back = await evalJs(`
      return {
        dialog: !!document.querySelector('.detect-settings'),
        card: !!document.querySelector('.next-card'),
        pill: !!document.querySelector('.next-pill'),
      };
    `)
    ok(!back.dialog, '参数窗已关闭')
    ok(back.card && !back.pill, '★ 关掉参数窗后卡片自动展开回来（.next-card 回来）')
    const errs4 = await collectErrors()
    const crash4 = errs4.filter(isCrash)
    ok(crash4.length === 0, '参数窗开关没有引发 React 崩溃', crash4.slice(0, 2).join(' | '))
    shotPath = await shot('4-settings-collapsed')
  }

  // ================= 场景 5：圈选之后还能改回跑整幅 =================
  //
  // 用户原话：「我选择了「固定范围」后选择了 polygon，然后我又反悔了，打算画整幅，
  // 却无法跳回第二步」「现在用户在第二步手动创建 polygon 就会无法跑整幅了」。
  //
  // `?roi=1` 是本次新增的预览开关（App 启动 effect 里 `setRoi(一个假多边形)`），
  // 理由同 `?p1=` / `?detect=1`：浏览器里没有真实绘制结果，不开这个口子，
  // "已圈选"这条分支**永远测不到**。
  console.log('\n=== 场景 5：★ 圈选之后仍能改回跑整幅（回到第 2 步）===')
  {
    const ready = await goto('?mock=ready&roi=1&noResume=1')
    ok(ready, '界面渲染完成')
    const st = await evalJs(`
      const card = document.querySelector('.next-card');
      return {
        card: !!card,
        step: (card?.querySelector('.nc-step')?.textContent ?? '').trim(),
        btns: [...(card?.querySelectorAll('.nc-actions button') ?? [])].map((x) =>
          x.textContent.trim(),
        ),
      };
    `)
    ok(st.card, '★ 有圈选时卡片是展开态', st.step)
    ok(st.step.includes('第 3 步'), '★ 卡片停在第 3 步「运行检测」', st.step)
    ok(
      st.btns.some((t) => t.includes('清除圈选')),
      '★ 第 3 步有「清除圈选，改跑整幅」按钮',
      st.btns.join(' / '),
    )

    const clicked = await evalJs(`
      const card = document.querySelector('.next-card');
      if (!card) return { ok: false, why: '没有卡片' };
      const btns = [...card.querySelectorAll('.nc-actions button')];
      const b = btns.find((x) => x.textContent.includes('清除圈选'));
      if (!b) {
        return { ok: false, why: '按钮：' + btns.map((x) => x.textContent.trim()).join('/') };
      }
      b.click();
      return { ok: true };
    `)
    ok(clicked.ok, '前置：找到并点击「清除圈选，改跑整幅」', clicked.why ?? '')
    await sleep(700)

    const after = await evalJs(`
      const card = document.querySelector('.next-card');
      return {
        card: !!card,
        step: (card?.querySelector('.nc-step')?.textContent ?? '').trim(),
        btns: [...(card?.querySelectorAll('.nc-actions button') ?? [])].map((x) =>
          x.textContent.trim(),
        ),
        active: document.querySelector('.sr-item.active .sr-label')?.textContent ?? null,
      };
    `)
    ok(after.card, '点完之后卡片仍在（没有变白屏 / 没有崩）')
    ok(after.step.includes('第 2 步'), '★ 清除圈选后卡片回到第 2 步「确定范围」', after.step)
    ok(
      after.btns.some((t) => t.includes('跳过，跑整幅')),
      '★ 「跳过，跑整幅」入口重新出现（用户能改跑整幅了）',
      after.btns.join(' / '),
    )
    ok(
      after.btns.some((t) => t.includes('圈定范围')),
      '主按钮回到「圈定范围」',
      after.btns.join(' / '),
    )
    ok(after.active === '确定范围', '步骤条上的 active 也回到「确定范围」', after.active ?? '(无)')
    const errs5 = await collectErrors()
    const crash5 = errs5.filter(isCrash)
    ok(crash5.length === 0, '清除圈选没有引发 React 崩溃', crash5.slice(0, 2).join(' | '))
    shotPath = await shot('5-roi-cleared')
  }

  // ================= 场景 6：区块切换下拉 =================
  //
  // 审计 C 条的回归：以前 16 个命令里**没有 list**，切区块只能重选影像。
  // `?blocks=1` 是本次新增的预览开关（BlockSwitcher 里读，只作用于浏览器），
  // 理由同 `?more=1` / `?roi=1`：`list_blocks` 是 Tauri 命令，
  // 浏览器里直接返回空数组，"有区块 / 影像丢失"这两种形态永远测不到。
  console.log('\n=== 场景 6：★ 区块切换下拉（清单 / 当前 / 影像丢失 / 失败要说出来）===')
  {
    const ready = await goto('?mock=ready&blocks=1&noResume=1')
    ok(ready, '界面渲染完成')
    const st = await evalJs(`
      const btn = document.querySelector('.block-btn');
      const menu = document.querySelector('.block-menu');
      const items = [...(menu?.querySelectorAll('button[role="menuitem"]') ?? [])];
      return {
        btn: !!btn,
        label: (btn?.querySelector('.block-btn-label')?.textContent ?? '').trim(),
        items: items.map((b) => ({
          text: b.textContent.replace(/\\s+/g, ' ').trim(),
          disabled: b.disabled,
        })),
      };
    `)
    ok(st.btn, '★ 工具栏有「区块」按钮（以前根本没有入口）')
    ok(st.label === 'wgr17-002', '★ 按钮上显示当前区块名', st.label)
    ok(st.items.length === 3, '★ 下拉里列出了 3 块', String(st.items.length))
    ok(
      st.items.some((it) => it.disabled && it.text.includes('当前')),
      '★ 当前这一块被标出来且不可点',
      st.items.map((i) => i.text).join(' | '),
    )
    ok(
      st.items.some((it) => it.text.includes('不在原位置')),
      '★ 影像被挪走的那一块有显式警告（点了会失败，不能和别的项长一样）',
    )

    // 先留一张"菜单展开"的截图（排障时看的就是这个形态）
    await shot('6a-block-menu')

    // 点一个非当前块：浏览器里没有后端 → 必须**当场报错**，
    // 而不是界面毫无反应（那正是审计里说的"静默给个错答案"）。
    const clicked = await evalJs(`
      const menu = document.querySelector('.block-menu');
      const items = [...(menu?.querySelectorAll('button[role="menuitem"]') ?? [])];
      const b = items.find((x) => !x.disabled);
      if (!b) return { ok: false, why: '没有可点的项' };
      b.click();
      return { ok: true };
    `)
    ok(clicked.ok, '前置：点了一个非当前区块', clicked.why ?? '')
    await sleep(900)
    const after = await evalJs(`
      const bar = document.querySelector('.notice-bar');
      return {
        bar: !!bar,
        text: (bar?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
        app: !!document.querySelector('.app'),
      };
    `)
    ok(after.app, '★ 切换失败没有白屏')
    ok(
      after.bar && after.text.includes('切换区块失败'),
      '★ 切换失败在界面上说出来了（不是静默无反应）',
      after.text.slice(0, 80),
    )
    const errs6 = await collectErrors()
    const crash6 = errs6.filter(isCrash)
    ok(crash6.length === 0, '区块切换没有引发 React 崩溃', crash6.slice(0, 2).join(' | '))
    shotPath = await shot('6-block-switcher')
  }

  // ================= 场景 7：启动弹窗「换一张影像」→ 向导 × = 撤销 =================
  //
  // 用户原话（2026-10-25）：「我选择了「换一张影像」，然后在向导弹窗里点了
  // 右上角的 ×，却发现自己已经在第 2 步了。这不符合逻辑。」
  //
  // 修复前的实现：`onPickNewResume` 里顺手 `setGaps([])` + `setGapsError(null)` +
  // 清掉 `resumeAsk` / `pendingResume` / `resumePending`。于是"点 × 取消"这个
  // **本该什么都不做**的动作产生了三个副作用：结果被清空、步骤倒退、
  // 续跑弹窗永久消失（`resumeAsk` 被置空且再无地方重新设置）。
  //
  // 所以本场景真正有鉴别力的断言是第 5 条（弹窗必须回来）：旧代码里
  // `resumeAsk` 一旦被置空，`.resume-dialog` **不可能**再出现 —— 这一条在旧代码上必红。
  // 第 6 条（active 步骤不变）是"没有变化"的证据：即使基线本来就是第 2 步也要写，
  // 它证明的是"取消没有造成跳转"，而不是"必须停在第 4 步"。
  //
  // ⚠️ 必须 `{ dismiss: false }`：`goto()` 默认会点「继续复核」把弹窗关掉，
  //    而被测对象正是"弹窗还在不在"。
  console.log('\n=== 场景 7：★ 「换一张影像」→ 向导 × 必须什么都不变（取消 = 撤销）===')
  {
    const ready = await goto('?mock=ready&resume=1', { dismiss: false })
    ok(ready, '界面渲染完成（20 秒内）')

    // ① 前置：续跑弹窗真的出来了（没有它，后面全是空过）
    await mustExist('.resume-dialog', '「发现上次的检测结果」弹窗')

    // ② 取消前的基线：active 步骤 + 状态栏里能看到的块数文案
    //    块数文案拿不到就记 null（第 6 条兜底），不能因为"没找到"就跳过断言。
    const base = await evalJs(`
      const active =
        document.querySelector('.sr-item.active .sr-label')?.textContent?.trim() ?? null;
      const status = (document.querySelector('.statusbar')?.innerText ?? '')
        .replace(/\\s+/g, ' ')
        .trim();
      const m = status.match(/([\\d,]+)\\s*块/);
      const logs = (document.querySelector('.sb-logs')?.innerText ?? '').replace(/\\s+/g, ' ');
      return { active, blocks: m ? m[0] : null, status: status.slice(0, 120), logs };
    `)
    ok(base.active != null, '前置：拿得到取消前的 active 步骤（基线）', String(base.active))
    console.log(
      `      基线：active=${base.active} · 块数文案=${base.blocks ?? '(拿不到，用 active 兜底)'}`,
    )

    // ③ 点「换一张影像」→ 向导出现，且续跑弹窗让位（不叠两层）
    const picked = await evalJs(`
      const dlg = document.querySelector('.resume-dialog');
      if (!dlg) return { ok: false, why: '弹窗不在' };
      const btns = [...dlg.querySelectorAll('button')];
      const b = btns.find((x) => x.textContent.includes('换一张影像'));
      if (!b) {
        return { ok: false, why: '按钮：' + btns.map((x) => x.textContent.trim()).join('/') };
      }
      b.click();
      return { ok: true };
    `)
    ok(picked.ok, '前置：点到了「换一张影像」', picked.why ?? '')
    await sleep(700)
    const opened = await evalJs(`
      const wiz = document.querySelector('.wizard-mask');
      return {
        wizard: !!wiz,
        title: (wiz?.querySelector('h1')?.textContent ?? '').trim(),
        dialog: !!document.querySelector('.resume-dialog'),
      };
    `)
    ok(opened.wizard, '★ 向导打开了（.wizard-mask 存在）', opened.title)
    ok(
      opened.title.includes('开始使用'),
      '★ 打开的是「开始使用」向导（不是预检等别的 .wizard-mask）',
      opened.title,
    )
    ok(!opened.dialog, '★ 向导期间续跑弹窗让位（两层弹窗不叠在一起）')

    // ④ 点向导右上角 ×
    const closed = await evalJs(`
      const wiz = document.querySelector('.wizard-mask');
      if (!wiz) return { ok: false, why: '向导不在' };
      const b = wiz.querySelector('.wizard-close');
      if (!b) return { ok: false, why: '没有 .wizard-close' };
      if (b.disabled) return { ok: false, why: '× 是禁用的（busy？）' };
      b.click();
      return { ok: true };
    `)
    ok(closed.ok, '前置：点到了向导右上角的 ×', closed.why ?? '')
    await sleep(800)

    const after = await evalJs(`
      const status = (document.querySelector('.statusbar')?.innerText ?? '')
        .replace(/\\s+/g, ' ')
        .trim();
      const m = status.match(/([\\d,]+)\\s*块/);
      return {
        wizard: !!document.querySelector('.wizard-mask'),
        dialog: !!document.querySelector('.resume-dialog'),
        active:
          document.querySelector('.sr-item.active .sr-label')?.textContent?.trim() ?? null,
        blocks: m ? m[0] : null,
        logs: (document.querySelector('.sb-logs')?.innerText ?? '').replace(/\\s+/g, ' '),
        app: !!document.querySelector('.app'),
      };
    `)

    // ⑤ 向导关掉了
    ok(!after.wizard, '★ 向导已关闭（× 生效）')
    // ⑥ ★★ 核心：弹窗必须回来 —— 旧代码（`onPickNewResume` 里清 resumeAsk）这一条必红
    ok(
      after.dialog,
      '★★ 取消后续跑弹窗回来了（取消 = 撤销我刚才的选择，而不是"关掉"）',
    )
    // ⑦ ★★ 步骤没有跳转（"没有变化"，不是"必须是第 4 步"）
    ok(
      after.active === base.active,
      '★★ active 步骤与取消前一致（取消没有造成状态跳转）',
      `${base.active} → ${after.active}`,
    )
    // ⑧ 块数文案也没有变化（旧代码这里会从 "1,726 块" 变成 "0 块"；
    //    浏览器预览拿不到真实结果时为 null，退化成"两边都 null"的一致性检查）
    ok(
      after.blocks === base.blocks,
      '★ 块数文案与取消前一致（结果没有被清空）',
      `${base.blocks ?? '(无)'} → ${after.blocks ?? '(无)'}`,
    )
    // ⑨ 取消要有反馈：日志里出现"什么都没变"那句（否则用户不知道自己改了什么）
    ok(
      after.logs.includes('已取消更换影像'),
      '★ 取消写了一条日志（用户能看见"什么都没变"）',
      after.logs.slice(-60),
    )
    ok(after.app, '★ 没有白屏（.app 还在）')
    const errs7 = await collectErrors()
    const crash7 = errs7.filter(isCrash)
    ok(crash7.length === 0, '★ 取消向导没有引发 React 崩溃', crash7.slice(0, 2).join(' | '))
    shotPath = await shot('7-cancel-wizard')

    // ============ 场景 7b：破坏性分支的语义必须与"取消"不同 ============
    //
    // 「重新开始」会真的清数据 —— 所以它必须**关闭**弹窗且不让它回来。
    // 更关键的是下一步：清完之后再从菜单打开向导、取消，弹窗**不能**冒出来
    //（否则 `resumeAsk && !wizard` 这个条件就成了"任何一次向导取消都把
    //  启动弹窗顶回来"的坑，用户会觉得软件卡在弹窗里）。
    const ready2 = await goto('?mock=ready&resume=1', { dismiss: false })
    ok(ready2, '界面渲染完成（重置，7b）')
    await mustExist('.resume-dialog', '「发现上次的检测结果」弹窗（重置后）')

    const restarted = await evalJs(`
      const dlg = document.querySelector('.resume-dialog');
      if (!dlg) return { ok: false, why: '弹窗不在' };
      const btns = [...dlg.querySelectorAll('button')];
      const b = btns.find((x) => x.textContent.includes('重新开始'));
      if (!b) {
        return { ok: false, why: '按钮：' + btns.map((x) => x.textContent.trim()).join('/') };
      }
      b.click();
      return { ok: true };
    `)
    ok(restarted.ok, '前置：点到了「重新开始」', restarted.why ?? '')
    await sleep(900)
    const afterRestart = await evalJs(`
      return {
        dialog: !!document.querySelector('.resume-dialog'),
        wizard: !!document.querySelector('.wizard-mask'),
        app: !!document.querySelector('.app'),
      };
    `)
    ok(!afterRestart.dialog, '★ 「重新开始」后弹窗关闭（破坏性分支，语义与取消不同）')
    ok(afterRestart.app, '★ 「重新开始」没有白屏')

    // 再从工具栏「⋯ 更多 → 更换影像或结果文件」打开向导并取消
    const opened2 = await evalJs(`
      const more = [...document.querySelectorAll('button')].find(
        (b) => (b.getAttribute('title') || '') === '更多操作',
      );
      if (!more) return { ok: false, why: '没有「更多操作」按钮' };
      more.click();
      return { ok: true };
    `)
    ok(opened2.ok, '前置：打开「⋯ 更多」菜单', opened2.why ?? '')
    await sleep(400)
    const picked2 = await evalJs(`
      const items = [...document.querySelectorAll('.more-menu button')];
      const b = items.find((x) => x.textContent.includes('更换影像'));
      if (!b) {
        return { ok: false, why: '菜单项：' + items.map((x) => x.textContent.trim()).join(' | ') };
      }
      b.click();
      return { ok: true };
    `)
    ok(picked2.ok, '前置：菜单里点「更换影像或结果文件」', picked2.why ?? '')
    await sleep(700)
    const wiz2 = await evalJs(`
      const wiz = document.querySelector('.wizard-mask');
      if (!wiz) return { ok: false };
      const b = wiz.querySelector('.wizard-close');
      if (!b) return { ok: false, why: '没有 .wizard-close' };
      b.click();
      return { ok: true };
    `)
    ok(wiz2.ok, '前置：从菜单打开的向导里点 ×', wiz2.why ?? '')
    await sleep(800)
    const afterMenuCancel = await evalJs(`
      return {
        dialog: !!document.querySelector('.resume-dialog'),
        wizard: !!document.querySelector('.wizard-mask'),
        app: !!document.querySelector('.app'),
      };
    `)
    ok(!afterMenuCancel.wizard, '★ 从菜单打开的向导也能取消')
    ok(
      !afterMenuCancel.dialog,
      '★★ 取消**菜单里**打开的向导不会把续跑弹窗顶回来（弹窗不会卡住）',
    )
    const errs7b = await collectErrors()
    const crash7b = errs7b.filter(isCrash)
    ok(crash7b.length === 0, '7b 没有引发 React 崩溃', crash7b.slice(0, 2).join(' | '))

    // ============ 场景 7c：正文里不能出现字面 `**`（Markdown 显示 bug）============
    const ready3 = await goto('?mock=ready&resume=1', { dismiss: false })
    ok(ready3, '界面渲染完成（重置，7c）')
    await mustExist('.resume-dialog', '「发现上次的检测结果」弹窗（重置后，7c）')
    const text7c = await evalJs(`
      const dlg = document.querySelector('.resume-dialog');
      return {
        text: (dlg?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
        hasBold: !!dlg?.querySelector('b'),
      };
    `)
    ok(text7c.text.length > 0, '前置：拿到了弹窗正文', `${text7c.text.length} 字符`)
    ok(
      !text7c.text.includes('**'),
      '★ 弹窗正文里没有字面 `**`（JSX 不渲染 Markdown）',
      text7c.text.includes('**') ? '出现了两个连续星号' : '',
    )
    ok(text7c.hasBold, '★ 「不会删除」用的是真 <b> 加粗', String(text7c.hasBold))
    ok(
      text7c.text.includes('不会删除'),
      '★ 正文仍然说清了"不删磁盘文件"（改成 <b> 之后没丢字）',
    )
    const errs7c = await collectErrors()
    const crash7c = errs7c.filter(isCrash)
    ok(crash7c.length === 0, '7c 没有引发 React 崩溃', crash7c.slice(0, 2).join(' | '))
    shotPath = await shot('7c-resume-dialog-text')

    // ============ 场景 7d：取消不能清掉「结果载入失败」这类已有状态 ============
    //
    // 为什么还要这一条：旧代码在 `onPickNewResume` 里除了 `setGaps([])` 还调了
    // `setGapsError(null)`。上面第 8 条在浏览器预览里两边都是 null（没有真实结果），
    // 属于"一致性检查"而不是"有鉴别力的检查"。这里用 `?gapsError=1` 造一个
    // **真实存在、且可被清掉**的状态：卡片正文会变成"未找到检测结果文件（已查找：…）"。
    // 取消向导之后它必须原样还在 —— 旧代码会把这句话抹掉（变成正常的下一步文案）。
    const ready4 = await goto('?mock=ready&resume=1&gapsError=1', { dismiss: false })
    ok(ready4, '界面渲染完成（重置，7d）')
    await mustExist('.resume-dialog', '「发现上次的检测结果」弹窗（重置后，7d）')
    const errBase = await evalJs(`
      const card = document.querySelector('.next-card');
      return { text: (card?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
    `)
    ok(
      /未找到检测结果文件|已查找/.test(errBase.text),
      '前置：「结果载入失败」的状态真的挂上了（卡片正文带错误说明）',
      errBase.text,
    )
    await evalJs(`
      const dlg = document.querySelector('.resume-dialog');
      const b = dlg && [...dlg.querySelectorAll('button')].find((x) =>
        x.textContent.includes('换一张影像'),
      );
      if (b) b.click();
    `)
    await sleep(700)
    await evalJs(`
      const wiz = document.querySelector('.wizard-mask');
      const b = wiz && wiz.querySelector('.wizard-close');
      if (b) b.click();
    `)
    await sleep(800)
    const errAfter = await evalJs(`
      const card = document.querySelector('.next-card');
      return {
        text: (card?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 80),
        dialog: !!document.querySelector('.resume-dialog'),
      };
    `)
    ok(errAfter.dialog, '7d：取消后弹窗仍然回来')
    ok(
      errAfter.text === errBase.text,
      '★★ 取消没有清掉「结果载入失败」状态（旧代码会 setGapsError(null) 抹掉它）',
      `${errBase.text} → ${errAfter.text}`,
    )

    // ============ 场景 7e：`resumeAsk && !wizard` 会不会把弹窗"卡住" ============
    //
    // 这是本次改动**引入的新风险**（改动前 `resumeAsk` 在打开向导时就被清掉了，
    // 根本不存在"回来"这件事）。要证明它只在"用户反悔"时回来一次，
    // 而不是任何一次向导取消都把它顶回来 —— 那样用户会觉得软件卡在弹窗里。
    // 路径：弹窗 → 换一张影像 → × → 弹窗回来 → 「继续复核」→ 关掉
    //      → 从菜单打开向导 → × → **不能**再冒出来。
    const ready5 = await goto('?mock=ready&resume=1', { dismiss: false })
    ok(ready5, '界面渲染完成（重置，7e）')
    await mustExist('.resume-dialog', '「发现上次的检测结果」弹窗（重置后，7e）')
    // 换一张影像 → ×（弹窗应当回来）
    await evalJs(`
      const dlg = document.querySelector('.resume-dialog');
      const b = dlg && [...dlg.querySelectorAll('button')].find((x) =>
        x.textContent.includes('换一张影像'),
      );
      if (b) b.click();
    `)
    await sleep(600)
    await evalJs(`
      const wiz = document.querySelector('.wizard-mask');
      const b = wiz && wiz.querySelector('.wizard-close');
      if (b) b.click();
    `)
    await sleep(700)
    const backAgain = await evalJs(`return !!document.querySelector('.resume-dialog');`)
    ok(backAgain, '前置：取消后弹窗回来了（7e）')

    // 「继续复核」= 这次选择做完了 → 弹窗必须关掉，并且之后不再出现
    const continued = await evalJs(`
      const dlg = document.querySelector('.resume-dialog');
      const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
      const b = btns.find((x) => x.textContent.includes('继续复核'));
      if (!b) {
        return { ok: false, why: '按钮：' + btns.map((x) => x.textContent.trim()).join('/') };
      }
      b.click();
      return { ok: true };
    `)
    ok(continued.ok, '前置：点了「继续复核」', continued.why ?? '')
    await sleep(800)
    ok(
      !(await evalJs(`return !!document.querySelector('.resume-dialog');`)),
      '★ 「继续复核」后弹窗关闭',
    )

    // 再从菜单开向导、取消 → 弹窗不能回来（`resumeAsk` 已被 onContinueResume 清掉）
    await evalJs(`
      const more = [...document.querySelectorAll('button')].find(
        (b) => (b.getAttribute('title') || '') === '更多操作',
      );
      if (more) more.click();
    `)
    await sleep(400)
    await evalJs(`
      const items = [...document.querySelectorAll('.more-menu button')];
      const b = items.find((x) => x.textContent.includes('更换影像'));
      if (b) b.click();
    `)
    await sleep(700)
    await evalJs(`
      const wiz = document.querySelector('.wizard-mask');
      const b = wiz && wiz.querySelector('.wizard-close');
      if (b) b.click();
    `)
    await sleep(800)
    const stuck = await evalJs(`
      return {
        dialog: !!document.querySelector('.resume-dialog'),
        wizard: !!document.querySelector('.wizard-mask'),
        app: !!document.querySelector('.app'),
      };
    `)
    ok(!stuck.wizard, '★ 7e：向导已取消')
    ok(
      !stuck.dialog,
      '★★ 已选过「继续复核」之后再取消向导，弹窗**不会**再冒出来（没有卡在弹窗里）',
    )
    ok(stuck.app, '★ 7e 没有白屏')
    const errs7e = await collectErrors()
    const crash7e = errs7e.filter(isCrash)
    ok(crash7e.length === 0, '7e 没有引发 React 崩溃', crash7e.slice(0, 2).join(' | '))
  }

  // ================= 场景 8：参数窗「关闭」不是「取消」+ 步进器第③步带主按钮 =================
  //
  // 2026-10-25 第 2 轮改动（engineer 5 条里的 #1 / #2）：
  //  · 底部按钮「取消」→「关闭」：每个控件都直接 `setDetectParam` 并即时持久化，
  //    它**不回滚**，叫「取消」就是骗人；回滚入口明确指向「恢复推荐值」。
  //  · 步进器点第 ③ 步现在带「开始检测」主按钮（以前只有 ✕，进来只能改参数不能开跑）。
  //  · 关窗时 `settingsIntent` 复位成 'edit' —— 「更多 → 检测参数」进来的窗**不能**带主按钮，
  //    否则"这次带不带开始检测"会漏到下一次（这正是本轮最容易漏的回归）。
  console.log('\n=== 场景 8：★ 参数窗「关闭」语义 + intent 复位（第③步带主按钮 / 更多里不带）===')
  {
    const ready = await goto('?mock=ready&roi=1&noResume=1')
    ok(ready, '界面渲染完成')
    // 有圈选 → 卡片停在第 3 步，主按钮是「开始检测」→ openSettings('detect')
    const clicked = await evalJs(`
      const card = document.querySelector('.next-card');
      const btns = card ? [...card.querySelectorAll('.nc-actions button')] : [];
      const b = btns.find((x) => x.textContent.includes('开始检测'));
      if (!b) return { ok: false, why: btns.map((x) => x.textContent.trim()).join(' / ') };
      b.click();
      return { ok: true };
    `)
    ok(clicked.ok, '前置：点卡片主按钮「开始检测」', clicked.why ?? '')
    await sleep(700)

    const ds = await evalJs(`
      const dlg = document.querySelector('.detect-settings');
      const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
      const texts = btns.map((x) => x.textContent.trim());
      return {
        open: !!dlg,
        texts,
        hasStart: texts.some((t) => t.includes('开始检测')),
        hasCancel: texts.some((t) => t === '取消'),
        hasClose: texts.some((t) => t === '关闭'),
        hint: (dlg?.innerText ?? '').includes('改动会立即生效并记住'),
      };
    `)
    ok(ds.open, '★ 参数窗打开了（.detect-settings）')
    ok(
      ds.hasStart,
      '★ 第③步进来的参数窗带「开始检测」主按钮（以前只有 ✕，进来就跑不了）',
      ds.texts.join(' / '),
    )
    ok(
      !ds.hasCancel,
      '★ 底部按钮不再叫「取消」（它不回滚，叫取消是骗人）',
      ds.texts.join(' / '),
    )
    ok(ds.hasClose, '★ 底部按钮叫「关闭」', ds.texts.join(' / '))
    ok(
      ds.hint,
      '★ 说明文案在：改动会立即生效并记住；想回到默认值点「恢复推荐值」',
    )

    // 用底部「关闭」关窗 → settingsIntent 必须复位成 'edit'
    const closed = await evalJs(`
      const dlg = document.querySelector('.detect-settings');
      if (!dlg) return { ok: false, why: '参数窗不在' };
      const btns = [...dlg.querySelectorAll('button')];
      const b = btns.find((x) => x.textContent.trim() === '关闭');
      if (!b) return { ok: false, why: '按钮：' + btns.map((x) => x.textContent.trim()).join(' / ') };
      b.click();
      return { ok: true };
    `)
    ok(closed.ok, '前置：点底部「关闭」', closed.why ?? '')
    await sleep(700)
    ok(
      !(await evalJs(`return !!document.querySelector('.detect-settings');`)),
      '★ 「关闭」真的关掉了参数窗',
    )

    // 再从「⋯ 更多 → 检测参数」进来：**不能**带「开始检测」
    await evalJs(`
      const more = [...document.querySelectorAll('button')].find(
        (b) => (b.getAttribute('title') || '') === '更多操作',
      );
      if (more) more.click();
    `)
    await sleep(400)
    const picked = await evalJs(`
      const items = [...document.querySelectorAll('.more-menu button')];
      const b = items.find((x) => x.textContent.includes('检测参数'));
      if (!b) return { ok: false, why: items.map((x) => x.textContent.trim()).join(' | ') };
      b.click();
      return { ok: true };
    `)
    ok(picked.ok, '前置：菜单里点「检测参数…」', picked.why ?? '')
    await sleep(700)
    const ds2 = await evalJs(`
      const dlg = document.querySelector('.detect-settings');
      const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
      const texts = btns.map((x) => x.textContent.trim());
      return {
        open: !!dlg,
        texts,
        hasStart: texts.some((t) => t.includes('开始检测')),
        hasClose: texts.some((t) => t === '关闭'),
        hasCancel: texts.some((t) => t === '取消'),
        hasCloseX: btns.some(
          (x) =>
            x.textContent.trim() === '✕' ||
            (x.getAttribute('aria-label') || '') === '关闭' ||
            (x.getAttribute('title') || '') === '关闭',
        ),
      };
    `)
    ok(ds2.open, '★ 「更多 → 检测参数」也打开了参数窗')
    ok(
      !ds2.hasStart,
      '★★ 从「更多」进来的是纯编辑模式：**没有**「开始检测」（intent 已复位，没漏到下一次）',
      ds2.texts.join(' / '),
    )
    ok(!ds2.hasCancel, '★ 纯编辑模式也没有「取消」字样', ds2.texts.join(' / '))
    // ⚠️ 纯编辑模式**没有**底部按钮组（「关闭」/「开始检测」都在 `{onStart && …}` 里），
    //    唯一的关闭方式是标题栏的 ✕。所以这里断言的是 ✕，不是文字「关闭」——
    //    第一版我写成了"必须有文字关闭"，那是**测试写错**（不是源码 bug）。
    ok(
      ds2.hasCloseX,
      '★ 纯编辑模式用标题栏 ✕ 关闭（底部按钮组只在"要开始检测"时出现）',
      ds2.texts.join(' / '),
    )
    const errs8 = await collectErrors()
    const crash8 = errs8.filter(isCrash)
    ok(crash8.length === 0, '参数窗改动没有引发 React 崩溃', crash8.slice(0, 2).join(' | '))
    shotPath = await shot('8-settings-close-not-cancel')
  }

  // ================= 场景 9：续跑弹窗「重新开始」连圈选一起清 =================
  //
  // 2026-10-25 第 2 轮改动（#5）。旧行为只 `setGaps([])`、保留 roi →
  // `isStepDone('range')` 里 `hasRoi` 仍为 true → 第 2 步算"已完成" →
  // active 落到第 3 步。用户看到的是"我点了重新开始，怎么直接跳第 3 步了"。
  // 两个同名动作（这里 / 向导 B2）行为不一致本身就是最坏的一种"像 bug"。
  //
  // `?roi=1` 给一个真实圈选（状态栏会写「ROI：已圈选」）—— 这条断言在旧代码上必红。
  console.log('\n=== 场景 9：★ 「重新开始」连圈选一起清（清完一定回到第 2 步）===')
  {
    const ready = await goto('?mock=ready&roi=1&resume=1', { dismiss: false })
    ok(ready, '界面渲染完成')
    await mustExist('.resume-dialog', '「发现上次的检测结果」弹窗')
    // ⚠️ 不能直接 `bar.includes('已圈选')`：`.statusbar` 里**含日志区** `.sb-logs`，
    //    而 `setRoi` 会 pushLog 一句「已圈选 Target Block（… m²）」——
    //    那条日志在清空 roi 之后仍然留在屏幕上，于是 includes 会一直为 true。
    //    （第一版就是这么写的，出现了一次**测试假失败**，不是源码 bug。）
    //    精确做法：只读 `ROI：` 后面那一位状态词。
    const base = await evalJs(`
      const bar = (document.querySelector('.statusbar')?.innerText ?? '').replace(/\\s+/g, ' ');
      return {
        active:
          document.querySelector('.sr-item.active .sr-label')?.textContent?.trim() ?? null,
        roiState: (bar.match(/ROI：(已圈选|未圈选)/) ?? [])[1] ?? null,
      };
    `)
    ok(base.roiState === '已圈选', '前置：状态栏显示「ROI：已圈选」（这次真的有圈选）', String(base.roiState))
    ok(
      base.active === '运行检测',
      '前置：有圈选 + 无结果 → active 是第 3 步「运行检测」',
      String(base.active),
    )

    const restarted = await evalJs(`
      const dlg = document.querySelector('.resume-dialog');
      const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
      const b = btns.find((x) => x.textContent.includes('重新开始'));
      if (!b) return { ok: false, why: btns.map((x) => x.textContent.trim()).join(' / ') };
      b.click();
      return { ok: true };
    `)
    ok(restarted.ok, '前置：点「重新开始」', restarted.why ?? '')
    await sleep(900)
    const after = await evalJs(`
      const bar = (document.querySelector('.statusbar')?.innerText ?? '').replace(/\\s+/g, ' ');
      return {
        dialog: !!document.querySelector('.resume-dialog'),
        active:
          document.querySelector('.sr-item.active .sr-label')?.textContent?.trim() ?? null,
        roiState: (bar.match(/ROI：(已圈选|未圈选)/) ?? [])[1] ?? null,
        app: !!document.querySelector('.app'),
      };
    `)
    ok(!after.dialog, '「重新开始」后弹窗关闭')
    ok(
      after.roiState === '未圈选',
      '★★ 「重新开始」把圈选也清了（状态栏变「未圈选（将处理整幅）」）',
      `ROI：${after.roiState ?? '(读不到)'}`,
    )
    ok(
      after.active === '确定范围',
      '★★ 清完 gaps + roi 之后 active 一定是第 2 步「确定范围」（旧代码会停在第 3 步）',
      String(after.active),
    )
    ok(after.app, '★ 没有白屏')
    const errs9 = await collectErrors()
    const crash9 = errs9.filter(isCrash)
    ok(crash9.length === 0, '重新开始没有引发 React 崩溃', crash9.slice(0, 2).join(' | '))
    shotPath = await shot('9-restart-clears-roi')
  }

  // ================= 场景 10：ResumeDialog 的 Esc 不能漏到全局 =================
  //
  // 2026-10-25 第 2 轮改动（#4）。App 里有个全局 Esc（`setDrawIntent('none')` +
  // `clearSelection()`），也挂在 `window` 上。ResumeDialog 以前只 `preventDefault()`，
  // 拦不住它 —— 于是"按 Esc 关弹窗"会顺手把地图选中清掉 / 退出绘制模式。
  //
  // ⚠️ 必须用**真实键盘事件**（`Input.dispatchKeyEvent`），不能用
  //    `window.dispatchEvent(new KeyboardEvent(...))`：后者把 target 设成 window，
  //    同一 target 上的 capture 与 bubble 监听器都会按注册顺序跑，
  //    `stopPropagation()` 拦不住（只有 `stopImmediatePropagation` 能），
  //    于是会得到"看起来漏了"的**假失败**。真实按键的 target 是聚焦元素，
  //    capture 从 window 往下走，stopPropagation 才真正生效。
  //
  // 观测量：`.map-drawing`（框选模式的提示条）。`?p1=box` 把 drawIntent 设成
  // `box_select` 让它出现；全局 Esc 会把它置回 'none' 让提示条消失。
  console.log('\n=== 场景 10：★ 弹窗 Esc 只关弹窗，不漏到全局（capture + stopPropagation）===')
  {
    const ready = await goto('?mock=ready&resume=1&p1=box', { dismiss: false })
    ok(ready, '界面渲染完成')
    await mustExist('.resume-dialog', '「发现上次的检测结果」弹窗')
    ok(
      (await evalJs(`return !!document.querySelector('.map-drawing');`)),
      '前置：框选提示条在（.map-drawing，drawIntent = box_select）',
    )

    // 真实按键：Escape
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
      nativeVirtualKeyCode: 27,
    })
    await sleep(800)

    const after = await evalJs(`
      return {
        dialog: !!document.querySelector('.resume-dialog'),
        drawing: !!document.querySelector('.map-drawing'),
        app: !!document.querySelector('.app'),
      };
    `)
    ok(!after.dialog, '★ Esc 关掉了弹窗（Esc = 继续，沿用不丢数据那一支）')
    ok(
      after.drawing,
      '★★ Esc **没有**漏到全局（框选提示条还在 → App 的 setDrawIntent("none") 没被触发）',
    )
    ok(after.app, '★ 没有白屏')
    const errs10 = await collectErrors()
    const crash10 = errs10.filter(isCrash)
    ok(crash10.length === 0, 'Esc 没有引发 React 崩溃', crash10.slice(0, 2).join(' | '))
    shotPath = await shot('10-esc-no-leak')
  }

  // ================= 场景 11：步进器点第 ③ 步也要带「开始检测」 =================
  //
  // 2026-10-25 第 2 轮改动（#2）。改之前 `onJumpStep('detect')` 直接
  // `setShowSettings(true)`，而 `settingsIntent` 默认是 'edit' ——
  // 于是"点步进器第 3 步"打开的窗**没有「开始检测」**，用户只能关掉再去找卡片按钮。
  // 同一个"我想跑检测"的意图，两个入口两种界面。
  //
  // 要能点第 ③ 步，它必须是 `done`（步进器只有 done 可点）→ 需要"有结果"。
  // 后端在浏览器里不可用，所以用 `?demo=1`（显式演示模式）载入内置
  // `/sample-gaps.geojson` → hasResult → 第 ③ 步 done。
  console.log('\n=== 场景 11：★ 步进器第③步带「开始检测」（?demo=1 造出 done 的第③步）===')
  {
    const ready = await goto('?mock=ready&demo=1')
    ok(ready, '界面渲染完成')
    const st = await evalJs(`
      const items = [...document.querySelectorAll('.sr-item')].map((b) => ({
        label: (b.querySelector('.sr-label')?.textContent ?? '').trim(),
        cls: b.className,
        disabled: b.disabled,
      }));
      const card = document.querySelector('.next-card');
      return {
        items,
        active: document.querySelector('.sr-item.active .sr-label')?.textContent?.trim() ?? null,
        gaps: (document.querySelector('.sb-logs')?.innerText ?? '').includes('演示模式'),
        cardBtn: [...(card?.querySelectorAll('.nc-actions button') ?? [])].map((x) =>
          x.textContent.trim(),
        ),
      };
    `)
    ok(st.gaps, '前置：演示样例真的载入了（日志里有「演示模式」）')
    const step3 = st.items.find((i) => i.label === '运行检测')
    ok(!!step3, '前置：找到第③步「运行检测」', st.items.map((i) => i.label).join('/'))
    ok(
      !!step3 && step3.cls.includes('done') && !step3.disabled,
      '前置：第③步是 done 且可点（否则点不动，后面的断言会空过）',
      step3 ? step3.cls : '(无)',
    )

    const jumped = await evalJs(`
      const b = [...document.querySelectorAll('.sr-item')].find(
        (x) => (x.querySelector('.sr-label')?.textContent ?? '').trim() === '运行检测',
      );
      if (!b) return { ok: false, why: '没有第③步' };
      if (b.disabled) return { ok: false, why: '第③步不可点' };
      b.click();
      return { ok: true };
    `)
    ok(jumped.ok, '前置：点了步进器第③步', jumped.why ?? '')
    await sleep(700)
    const ds = await evalJs(`
      const dlg = document.querySelector('.detect-settings');
      const texts = dlg ? [...dlg.querySelectorAll('button')].map((x) => x.textContent.trim()) : [];
      return {
        open: !!dlg,
        texts,
        hasStart: texts.some((t) => t.includes('开始检测')),
        hasCancel: texts.some((t) => t === '取消'),
      };
    `)
    ok(ds.open, '★ 点第③步打开了参数窗')
    ok(
      ds.hasStart,
      '★★ 从步进器第③步进来**也有**「开始检测」（改动前这里只有 ✕）',
      ds.texts.join(' / '),
    )
    ok(!ds.hasCancel, '★ 底部按钮不是「取消」', ds.texts.join(' / '))
    const errs11 = await collectErrors()
    const crash11 = errs11.filter(isCrash)
    ok(crash11.length === 0, '步进器第③步没有引发 React 崩溃', crash11.slice(0, 2).join(' | '))
    shotPath = await shot('11-stepper-step3-settings')
  }

  // ================= 场景 11b：#4 参数窗文案（?settings=1 = 纯编辑模式）=================
  //
  // 这里要说清一个**规格与实现的偏差**（不是 bug，但 team-lead 的验证口径要修正）：
  // `?settings=1` 走的是 `setShowSettings(true)`，`settingsIntent` 保持默认 'edit' →
  // 底部按钮组（`{onStart && …}`）**根本不渲染**，所以"底部按钮是「关闭」"
  // 在纯编辑模式里**无从验证**（那里只有标题栏 ✕）。
  // 「关闭」按钮只存在于 detect 模式（场景 8 / 11 已覆盖）。
  // 纯编辑模式能验证的是：新增说明文案在、且**没有**「取消」字样。
  console.log('\n=== 场景 11b：#4 参数窗文案（编辑模式：有说明、无「取消」；关闭按钮只在 detect 模式）===')
  {
    const ready = await goto('?mock=ready&settings=1')
    ok(ready, '界面渲染完成')
    const ds = await evalJs(`
      const dlg = document.querySelector('.detect-settings');
      const btns = dlg ? [...dlg.querySelectorAll('button')] : [];
      const texts = btns.map((x) => x.textContent.trim());
      return {
        open: !!dlg,
        texts,
        hasCancel: texts.some((t) => t === '取消'),
        hasCloseText: texts.some((t) => t === '关闭'),
        hasCloseX: btns.some(
          (x) =>
            x.textContent.trim() === '✕' ||
            (x.getAttribute('aria-label') || '') === '关闭' ||
            (x.getAttribute('title') || '') === '关闭',
        ),
        hint: (dlg?.innerText ?? '').includes('改动会立即生效并记住'),
        hintDefault: (dlg?.innerText ?? '').includes('恢复推荐值'),
      };
    `)
    ok(ds.open, '★ ?settings=1 打开了参数窗')
    ok(!ds.hasCancel, '★ 窗里没有任何「取消」字样（改名前叫取消，是骗人的）', ds.texts.join(' / '))
    ok(ds.hint, '★ 新增说明文案在：改动会立即生效并记住')
    ok(ds.hintDefault, '★ 且指向回滚入口「恢复推荐值」（不是空话）')
    ok(ds.hasCloseX, '★ 纯编辑模式用标题栏 ✕ 关闭')
    ok(
      !ds.hasCloseText,
      '（记录现状）纯编辑模式没有底部「关闭」按钮 —— 按钮组只在 detect 模式渲染',
      ds.texts.join(' / '),
    )
    const errs11b = await collectErrors()
    const crash11b = errs11b.filter(isCrash)
    ok(crash11b.length === 0, '没有引发 React 崩溃', crash11b.slice(0, 2).join(' | '))
  }

  // ================= 场景 12：#1 导出成功 → 第⑤步真的置位（补「接线」缺口）=================
  //
  // 为什么必须补这一条：engineer 新加的 9 条单测（workflow.test.ts I 组）只喂
  // `exported: true` 给纯函数 `computeSteps` / `nextAction` —— 它们证明的是
  // **"判定逻辑对"**，**没有**证明"`ExportDialog.run()` 真的会调 `markWorkflow`"。
  // 把那句 `markWorkflow({ exported: true })` 删掉，810 条单测**依然全绿**。
  // 这就是典型的"测试绿但接线可能断"。
  //
  // 浏览器里没有 Tauri / 后端，真导出走不通。做法：**只 stub `/export` 这一个请求**
  // （其它 fetch 原样透传，`?mock=ready` 的 /meta 不受影响），让前端走到成功分支。
  // 这样断言的是**前端接线**：同一次会话里"导出前 ⑤ 不是 done → 导出成功后 ⑤ done"。
  // 删掉那句 markWorkflow，本场景必红。
  console.log('\n=== 场景 12：★ 导出成功 → 第⑤步 done（stub /export，补单测覆盖不到的接线）===')
  {
    const ready = await goto('?mock=ready&demo=1&p2=export')
    ok(ready, '界面渲染完成（导出窗已由 ?p2=export 打开）')
    const before = await evalJs(`
      const items = [...document.querySelectorAll('.sr-item')].map((b) => ({
        label: (b.querySelector('.sr-label')?.textContent ?? '').trim(),
        cls: b.className,
      }));
      const exp = items.find((i) => i.label === '导出交付');
      return {
        dlg: !!document.querySelector('.export-dialog'),
        expDone: !!exp && exp.cls.includes('done'),
        expCls: exp ? exp.cls : '(没找到导出交付)',
      };
    `)
    ok(before.dlg, '前置：导出窗在（.export-dialog）')
    ok(
      !before.expDone,
      '★ 前置（对照）：导出**之前**第⑤步不是 done（漏了置位的话这里和后面会同时为假）',
      before.expCls,
    )

    // 只拦 /export：其它请求（/meta 等）原样透传
    const stubbed = await evalJs(`
      if (!window.__origFetch) window.__origFetch = window.fetch;
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/export')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({ ok: true, outdir: 'D:/tmp/fake-out', files: ['report.md'] }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
          );
        }
        return window.__origFetch(input, init);
      };
      return true;
    `)
    ok(stubbed, '前置：只对 /export 装了 stub（其它 fetch 透传）')

    // 导出窗已由 ?p2=export 打开 → 直接点「开始导出」
    const runClicked = await evalJs(`
      const dlg = document.querySelector('.export-dialog');
      if (!dlg) return { ok: false, why: '导出窗不在' };
      const b = [...dlg.querySelectorAll('button')].find((x) =>
        x.textContent.includes('开始导出'),
      );
      if (!b) {
        return {
          ok: false,
          why: '按钮：' + [...dlg.querySelectorAll('button')].map((x) => x.textContent.trim()).join(' / '),
        };
      }
      if (b.disabled) return { ok: false, why: '「开始导出」是禁用的（没结果？）' };
      b.click();
      return { ok: true };
    `)
    ok(runClicked.ok, '前置：点了「开始导出」', runClicked.why ?? '')
    await sleep(1200)

    const after = await evalJs(`
      const items = [...document.querySelectorAll('.sr-item')].map((b) => ({
        label: (b.querySelector('.sr-label')?.textContent ?? '').trim(),
        cls: b.className,
      }));
      const exp = items.find((i) => i.label === '导出交付');
      const card = document.querySelector('.next-card');
      return {
        expDone: !!exp && exp.cls.includes('done'),
        expCls: exp ? exp.cls : '(没找到)',
        cardBtn: [...(card?.querySelectorAll('.nc-actions button') ?? [])].map((x) =>
          x.textContent.trim(),
        ),
        logs: (document.querySelector('.sb-logs')?.innerText ?? '').includes('导出完成'),
      };
    `)
    ok(after.logs, '前置：导出真的走完了成功分支（日志有「导出完成」）')
    ok(
      after.expDone,
      '★★ 导出成功后第⑤步变成 done（`markWorkflow({ exported: true })` 真的接上了）',
      after.expCls,
    )
    ok(
      after.cardBtn.some((t) => t.includes('打开输出文件夹')),
      '★★ 卡片主按钮从「导出交付包」变成「打开输出文件夹」（finished = true）',
      after.cardBtn.join(' / '),
    )

    // 失败分支**不能**置位（这是"只在成功回调里置位"的另一半）
    const failed = await evalJs(`
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.includes('/export')) {
          return Promise.resolve(
            new Response(JSON.stringify({ ok: false, error: '磁盘满了' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }),
          );
        }
        return window.__origFetch(input, init);
      };
      return true;
    `)
    ok(failed, '前置：把 /export 换成失败响应')
    await sleep(200)
    // 失败后导出窗还开着（显示错误），按钮文案回到「开始导出」/「重新导出」→ 直接再点一次
    const rerun = await evalJs(`
      const dlg = document.querySelector('.export-dialog');
      const b = dlg && [...dlg.querySelectorAll('button')].find((x) =>
        /开始导出|重新导出/.test(x.textContent),
      );
      if (!b) return { ok: false };
      b.click();
      return { ok: true };
    `)
    ok(rerun.ok, '前置：失败场景里再点一次导出')
    await sleep(1200)
    const afterFail = await evalJs(`
      const dlg = document.querySelector('.export-dialog');
      return {
        err: (dlg?.innerText ?? '').includes('磁盘满了'),
        expDone: [...document.querySelectorAll('.sr-item')].some(
          (b) =>
            (b.querySelector('.sr-label')?.textContent ?? '').trim() === '导出交付' &&
            b.className.includes('done'),
        ),
      };
    `)
    ok(afterFail.err, '★ 失败分支把错误说出来了（「磁盘满了」）')
    ok(
      afterFail.expDone,
      '（说明）失败不会把已置的 exported 撤销 —— 置位是"曾经成功过"，只增不减',
    )
    const errs12 = await collectErrors()
    const crash12 = errs12.filter(isCrash)
    ok(crash12.length === 0, '导出接线没有引发 React 崩溃', crash12.slice(0, 2).join(' | '))
    shotPath = await shot('12-export-wiring')
  }

  // ================= 收尾 =================
  chrome.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  ws.close()

  console.log(`\n共 ${total} 项断言`)
  if (fails === 0) console.log('✅ 全部通过')
  else console.log(`❌ ${fails} 项失败`)
  if (shotPath) console.log(`截图目录：${OUT}`)
  process.exitCode = fails === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
