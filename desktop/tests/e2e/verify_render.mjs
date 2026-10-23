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
   */
  const goto = async (query) => {
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
        await dismissOverlay(query)
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
