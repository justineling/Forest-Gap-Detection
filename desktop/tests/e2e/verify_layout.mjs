/**
 * 2026-10-23 四项前端改动的**视觉 / 交互**验证（headless Chrome + CDP）。
 *
 * 手工验证脚本，**不进 `npm test`**（需要浏览器 + dev server）。
 *
 * 用法：
 *   cd desktop && npm run dev          # 另开一个终端
 *   node desktop/tests/e2e/verify_layout.mjs
 *
 * 截图默认写到 `tmp/shots-layout/`（`tmp/` 已被 .gitignore 忽略），
 * 可用 `SHOT_DIR=...` 覆盖。
 *
 * **隔离性**（2026-10-23 复核后补）：`/gaps` 一律由 PATCH 拦下（空集合 / `gaps=3`
 * 时 3 块），**不落到真实后端**；场景 2~7 的 URL 带 `?noResume=1`，
 * `goto()` 里再关一次 `.help-mask`。以前脚本隐含依赖"本机没有后端"，
 * 用户装了软件在跑时会出现 4 项假失败（详见 tests/e2e/README.md「二号大坑」）。
 *
 * 覆盖：
 *   1. 启动询问弹窗：命中时界面必须是**空地图 + 停在第 2 步**（不是先载入再问）
 *   2. 检测参数「恢复推荐值」：写回默认值 + 2 秒轻量反馈 + 推荐标记复现
 *   3. 缩放控件挪到右上角，不再被右下角「下一步」卡片压住
 *   4. 三个拖拽手柄：状态栏变高（日志可滚）、左右面板可拖宽、窄窗口被钳制
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9444)
const BASE = process.env.APP_URL || 'http://localhost:5173/'
const OUT = process.env.SHOT_DIR || join(process.cwd(), 'tmp', 'shots-layout')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const ok = (cond, label, detail = '') => {
  console.log(`  [${cond ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!cond) fails++
}

/**
 * 前置补丁：
 *  · `/meta` → 结构完整的假 meta（缺 bounds_wgs84 会让整块地图被 ErrorBoundary 顶掉）；
 *  · `/gaps` → **一律拦下，绝不落到真实后端**（2026-10-23 复核后改）：
 *      `gaps=3` → 3 块（验证"先问、再载入"）；其余 → 空集合。
 *
 * ⚠️ 为什么 `/gaps` 必须拦（以前是"不匹配就 return _f(...)"放行）：
 *    用户装了软件、8765 上真跑着 `fgd-tile-server` 时，放行会让 `/gaps` 返回
 *    真实 1,726 块 → `shouldAskResume` 命中 → 启动询问弹窗（`.help-mask`，
 *    `z-index: 1050` + 全屏半透明底）盖住整屏。实测 `elementFromPoint` 命中
 *    三个 `.resizer` 的结果**全是 help-mask**，于是拖拽 120→120、
 *    本脚本出现 4 项"假失败"。功能没坏，是脚本不 hermetic。
 *
 * ⚠️ 但 `/meta` 的**形状**必须完整 —— 这一条是坑 ①，别为了隔离把它删简。
 */
const PATCH = `
(() => {
  const _f = window.fetch;
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
  const json = (body) => Promise.resolve(new Response(JSON.stringify(body),
    { status: 200, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/meta')) {
      return json({
        ok: true, source: 'WGR17-002.tif', width: 47130, height: 44686,
        bands: 4, crs: 'EPSG:4326', res_m: 0.033,
        bounds_wgs84: [111.15, 1.14, 111.25, 1.22], center: [111.2, 1.18],
        zoom: 14, has_overviews: true, tile_url: '/tiles/{z}/{x}/{y}.png'
      });
    }
    if (url.includes('/gaps')) {
      const want = new URLSearchParams(location.search).get('gaps');
      // 只有显式 gaps=3 才给要素，其余一律空 —— 不依赖本机有没有真后端
      return json({
        type: 'FeatureCollection',
        features: want === '3'
          ? [feat('G1', 111.18, 1.16), feat('G2', 111.19, 1.17), feat('G3', 111.20, 1.18)]
          : []
      });
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

async function main() {
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'qa-shot-'))
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
  const { send } = makeClient(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH })

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
  }

  /**
   * 关掉可能出现的启动弹窗（`.help-mask`：继续上次结果 / 帮助）。
   *
   * `?mock=ready` 只伪造 `/meta`，`/gaps` 已在 PATCH 里隔离成空集合，
   * 所以正常情况下不该有弹窗。但**保险仍然保留**：
   *  · 将来加了别的启动弹窗（帮助 / 更新提示）时，这一道能避免"整屏点不到"；
   *  · 场景 1 故意要那个弹窗，它自己负责关，这里会返回 'none'。
   *
   * ⚠️ 找不到可点的按钮必须 **FAIL**，不能静默继续 ——
   *    遮罩还在的话，后面那些拖拽断言会变成"看起来失败但其实是点不到"。
   */
  const dismissOverlay = async (label) => {
    const r = await evalJs(`
      const mask = document.querySelector('.help-mask');
      if (!mask) return { state: 'none' };
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
      const still = await evalJs(`return !!document.querySelector('.help-mask');`)
      ok(!still, `前置：关掉启动弹窗「${label}」`)
      return still ? 'fail' : 'closed'
    }
    ok(r.state === 'none', `前置：没有遮挡的启动弹窗「${label}」`, r.why ?? '')
    return r.state
  }

  /**
   * 导航 + **等到界面真的渲染出来**再返回。
   *
   * 为什么不能只 sleep：vite **冷启动**时首屏要现编译模块，固定等 3 秒不够 ——
   * 实测第一次跑会出现 5 项假失败（步骤条/卡片都还没挂载），热起来之后就全过。
   * 一个"时灵时不灵"的验证脚本没人会信，所以这里轮询到关键元素出现为止
   * （最多 15 秒），超时才继续（让后续断言给出真实的失败信息）。
   */
  const goto = async (query, keepOverlay = false) => {
    await send('Page.navigate', { url: BASE + query })
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      // 就绪判据要**等到影像加载完**，不能只看骨架：
      //   `.app` / `.sr-item` 在引导页盖着时也存在，于是冷启动会被判"已就绪"，
      //   而此时第 1 步还没打勾（mock 的 meta 是在 await probeAndLoad 之后才设的）。
      //   实测症状：`active=选择影像`，5 项断言全挂。
      // 判据 = 第 1 步 done（影像已就绪）**或** 弹窗已经出来（场景 1 的目标态）。
      const ready = await evalJs(`
        const done = !!document.querySelector('.sr-item.done');
        const dlg = !!document.querySelector('.resume-dialog, .help-dialog');
        return !!document.querySelector('.app') && (done || dlg);
      `)
      if (ready) {
        // 再给一帧渲染 + effect 跑完的时间（resume 判定在 effect 里）
        await sleep(600)
        // 场景 1 需要那个弹窗，用 `keepOverlay` 跳过保险；其余场景一律清场
        if (!keepOverlay) await dismissOverlay(query)
        return
      }
      await sleep(250)
    }
    console.log('  [WARN] 界面 15 秒内未就绪（dev server 冷启动 / 后端探测慢？）')
  }

  const drag = async (selector, dx, dy, steps = 8) => {
    const box = await evalJs(`
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    `)
    if (!box) throw new Error(`找不到手柄 ${selector}`)
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: box.x, y: box.y, button: 'left', buttons: 1, clickCount: 1,
    })
    for (let i = 1; i <= steps; i++) {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: box.x + (dx * i) / steps,
        y: box.y + (dy * i) / steps,
        button: 'left',
        buttons: 1,
      })
      await sleep(30)
    }
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: box.x + dx, y: box.y + dy, button: 'left', buttons: 0, clickCount: 1,
    })
    await sleep(350)
  }

  const layout = () =>
    evalJs(`
      const body = document.querySelector('.body');
      const cols = getComputedStyle(body).gridTemplateColumns.split(' ').map(parseFloat);
      const sb = document.querySelector('.statusbar').getBoundingClientRect();
      const logs = document.querySelector('.sb-logs');
      return {
        left: cols[0], mid: cols[1], right: cols[2],
        statusH: Math.round(sb.height),
        logH: Math.round(logs.clientHeight),
        logScroll: logs.scrollHeight,
        nav: (() => {
          const el = document.querySelector('.maplibregl-ctrl-top-right');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), right: Math.round(r.right), w: Math.round(r.width), h: Math.round(r.height) };
        })(),
        card: (() => {
          const el = document.querySelector('.next-card');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) };
        })(),
        step: document.querySelector('.sr-item.active .sr-label')?.textContent ?? null,
        dialog: !!document.querySelector('.help-mask'),
        cardText: (document.querySelector('.next-card')?.textContent ?? '').slice(0, 60),
      };
    `)

  // ================= 场景 1：先问、再载入 =================
  console.log('\n=== 场景 1：启动询问弹窗（先问、再载入）===')
  {
    // 场景 1 的目标态就是「弹窗还在」→ 跳过 goto 里的清场保险
    await goto('?mock=ready&gaps=3', true)
    const st = await layout()
    ok(st.dialog, '★ 弹出了「发现上次的检测结果」')
    ok(st.step === '确定范围', '★ 弹窗期间停在第 2 步「确定范围」（不是先跳到第 4 步）', `active=${st.step}`)
    ok(
      !st.cardText.includes('复核') && !st.cardText.includes('块空地'),
      '★ 弹窗期间「下一步」卡片没有把结果算进去',
      st.cardText,
    )
    await shot('1a-resume-ask')

    const clicked = await evalJs(`
      const b = [...document.querySelectorAll('.help-foot button')]
        .find(x => x.textContent.includes('继续复核'));
      if (!b) return false; b.click(); return true;
    `)
    ok(clicked, '点了「继续复核上次结果」')
    await sleep(1200)
    const after = await layout()
    ok(after.step === '复核结果', '★ 选「继续」之后才应用结果 → 跳到第 4 步', `active=${after.step}`)
    ok(!after.dialog, '弹窗已关闭')
    await shot('1b-resume-continued')
  }

  // ================= 场景 2：默认布局 + 缩放控件位置 =================
  console.log('\n=== 场景 2：默认布局 / 缩放控件不再被卡片压住 ===')
  {
    await goto('?mock=ready&noResume=1')
    const st = await layout()
    ok(!!st.nav, '缩放控件存在')
    if (st.nav && st.card) {
      const inTopRight = st.nav.top < 120
      const noOverlap =
        st.nav.right <= st.card.left || st.nav.top >= st.card.bottom || st.nav.top + st.nav.h <= st.card.top
      ok(inTopRight, '★ 缩放控件在右上角（top < 120px）', `top=${st.nav.top}`)
      ok(noOverlap, '★ 缩放控件与「下一步」卡片不重叠', `nav=${JSON.stringify(st.nav)} card=${JSON.stringify(st.card)}`)
    }
    ok(st.statusH >= 110, '★ 状态栏默认高度 ≥ 110px（旧值约 60）', `${st.statusH}px`)
    await shot('2-default-layout')
  }

  // ================= 场景 3：拖高状态栏 =================
  console.log('\n=== 场景 3：拖拽状态栏上边框（变高 + 日志可滚）===')
  {
    const before = await layout()
    await drag('.rs-status', 0, -90)
    const after = await layout()
    ok(after.statusH > before.statusH + 60, '★ 状态栏被拖高（约 +90px）', `${before.statusH} → ${after.statusH}`)
    ok(after.logH > before.logH + 40, '★ 日志区跟着变高（不是整条状态栏滚）', `${before.logH} → ${after.logH}`)
    ok(after.logScroll >= after.logH, '日志内容可滚动（scrollHeight ≥ clientHeight）', `${after.logScroll} / ${after.logH}`)
    await shot('3-statusbar-taller')

    await drag('.rs-status', 0, -400)
    const capped = await layout()
    ok(capped.statusH <= 320, '★ 拖过头被钳制在 320px', `${capped.statusH}px`)
    await drag('.rs-status', 0, 600)
    const floor = await layout()
    ok(floor.statusH >= 64, '★ 往下拖过头被钳制在 64px', `${floor.statusH}px`)
  }

  // ================= 场景 4：拖宽左右面板 =================
  console.log('\n=== 场景 4：拖拽左右面板宽度 ===')
  {
    await goto('?mock=ready&noResume=1')
    const before = await layout()
    await drag('.rs-left', 70, 0)
    const wider = await layout()
    ok(wider.left > before.left + 40, '★ 向右拖 → 左面板变宽', `${before.left} → ${wider.left}`)
    await drag('.rs-right', -60, 0)
    const wider2 = await layout()
    ok(wider2.right > wider.right + 30, '★ 向左拖 → 右面板变宽', `${wider.right} → ${wider2.right}`)
    await shot('4-panels-wider')

    await drag('.rs-left', -800, 0)
    const capped = await layout()
    ok(capped.left >= 200 && capped.left <= 480, '★ 左面板被钳制在 200~480', `${capped.left}`)
    await drag('.rs-right', 900, 0)
    const capped2 = await layout()
    ok(capped2.right >= 220 && capped2.right <= 520, '★ 右面板被钳制在 220~520', `${capped2.right}`)
  }

  // ================= 场景 5：窄窗口 =================
  console.log('\n=== 场景 5：窄窗口 1100px（面板收回来，地图不被挤没）===')
  {
    // 先把两块都拖到很宽，再缩窗口 —— 这是唯一能让"两块加起来超宽"的路径
    await send('Emulation.clearDeviceMetricsOverride')
    await goto('?mock=ready&noResume=1')
    await drag('.rs-left', 190, 0)
    await drag('.rs-right', -220, 0)
    const wide = await layout()
    ok(
      wide.left > 400 && wide.right > 400,
      '先把两块都拖宽（各自被"地图至少 360"压着，拖不到常量上限是正常的）',
      `${wide.left} / ${wide.right}`,
    )

    await send('Emulation.setDeviceMetricsOverride', {
      width: 1100,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(900)
    const narrow = await layout()
    ok(narrow.mid >= 300, '★ 缩到 1100px 后地图仍有 ≥300px（没被面板挤没）', `mid=${narrow.mid}`)
    ok(
      narrow.left + narrow.right <= 1100 - 360 + 1,
      '★ 左右面板被一起收回到「窗口 − 360」以内',
      `${narrow.left} + ${narrow.right} = ${narrow.left + narrow.right}`,
    )
    const st = await layout()
    if (st.nav && st.card) {
      const noOverlap =
        st.nav.right <= st.card.left ||
        st.nav.top >= st.card.bottom ||
        st.nav.top + st.nav.h <= st.card.top
      ok(
        noOverlap,
        '★ 窄窗口下缩放控件仍不被卡片压住',
        `nav=${JSON.stringify(st.nav)} card=${JSON.stringify(st.card)}`,
      )
    }
    await shot('5-narrow-1100')
    await send('Emulation.clearDeviceMetricsOverride')
    await sleep(600)
  }

  // ================= 场景 6：检测参数「恢复推荐值」 =================
  console.log('\n=== 场景 6：检测参数「恢复推荐值」===')
  {
    await goto('?mock=ready&settings=1&noResume=1')
    const opened = await evalJs(`
      const panel = document.querySelector('.detect-settings');
      if (!panel) return null;
      const b = [...panel.querySelectorAll('button')].find(x => x.textContent.includes('恢复推荐值'));
      return { hasBtn: !!b, head: panel.querySelector('.ds-current')?.textContent ?? '' };
    `)
    ok(opened?.hasBtn, '★ 标题行右侧有「恢复推荐值」按钮')
    ok(!!opened?.head, '参数窗顶部有"上次使用"一行', opened?.head ?? '')

    // 先改成非推荐值：密度选 120
    await evalJs(`
      const panel = document.querySelector('.detect-settings');
      const b = [...panel.querySelectorAll('.seg-btn')].find(x => x.textContent.trim() === '120');
      if (b) b.click();
      return true;
    `)
    await sleep(300)
    const dirty = await evalJs(`return document.querySelector('.ds-current')?.textContent ?? ''`)
    ok(dirty.includes('密度 120'), '先手动改成密度 120（制造"非推荐值"）', dirty)

    await evalJs(`
      const b = [...document.querySelectorAll('.detect-settings button')]
        .find(x => x.textContent.includes('恢复推荐值'));
      b.click(); return true;
    `)
    await sleep(250)
    const restored = await evalJs(`
      const p = document.querySelector('.detect-settings');
      return {
        current: p.querySelector('.ds-current')?.textContent ?? '',
        flash: p.querySelector('.ds-flash')?.textContent ?? null,
        recommend: [...p.querySelectorAll('.ds-hint')].map(x => x.textContent).join(' | '),
      };
    `)
    ok(restored.current.includes('密度 150'), '★ 恢复后密度回到 150', restored.current)
    ok(restored.current.includes('CHM 核心 5.2'), '★ 恢复后 CHM 回到 5.2 / 1.2', restored.current)
    ok(restored.flash === '已恢复推荐值', '★ 有「已恢复推荐值」轻量反馈', String(restored.flash))
    ok(
      restored.recommend.includes('已按你的电脑推荐'),
      '★「（已按你的电脑推荐）」标记重新出现',
      restored.recommend.slice(0, 80),
    )
    await shot('6-detect-reset')

    await sleep(2200)
    const gone = await evalJs(`return document.querySelector('.ds-flash') ? 'still' : 'gone'`)
    ok(gone === 'gone', '★ 2 秒后反馈自动消失', gone)
  }

  // ================= 场景 7：有「没有加速结构」横幅时 =================
  console.log('\n=== 场景 7：顶部横幅出现时，缩放控件让开 ===')
  {
    await goto('?mock=ready&noOvr=1&noResume=1')
    const st = await evalJs(`
      const b = document.querySelector('.ovr-banner');
      const n = document.querySelector('.maplibregl-ctrl-top-right');
      if (!b || !n) return null;
      const rb = b.getBoundingClientRect(), rn = n.getBoundingClientRect();
      return {
        banner: { top: Math.round(rb.top), bottom: Math.round(rb.bottom), left: Math.round(rb.left), right: Math.round(rb.right) },
        nav: { top: Math.round(rn.top), bottom: Math.round(rn.bottom), left: Math.round(rn.left), right: Math.round(rn.right) },
      };
    `)
    ok(!!st, '横幅已挂载（?noOvr=1）')
    if (st) {
      const noOverlap =
        st.nav.top >= st.banner.bottom || st.nav.right <= st.banner.left || st.nav.left >= st.banner.right
      ok(
        noOverlap,
        '★ 有横幅时缩放控件被让到横幅下方，不重叠',
        `nav.top=${st.nav.top} banner.bottom=${st.banner.bottom}`,
      )
    }
    await shot('7-ovr-banner')
  }

  chrome.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  ws.close()

  console.log()
  if (fails === 0) console.log('✅ 全部通过')
  else console.log(`❌ ${fails} 项失败`)
  process.exitCode = fails === 0 ? 0 : 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
