/**
 * 窄窗截图（手动验证脚本，**不进 npm test**）。
 *
 * 为什么单独一个脚本：`verify_render.mjs` 固定 1280×800 —— 那是主屏尺寸，
 * 但「窄窗重排」是 Ark UI 的硬要求（不能只靠把桌面版缩小）。改窗口大小没法用
 * 命令行参数可靠控制，所以用 CDP 的 `Emulation.setDeviceMetricsOverride`
 * 精确设视口，再截一张图人工看。
 *
 * 用法：
 *   cd desktop && npm run dev            # 另开一个终端
 *   node desktop/tests/e2e/shot-narrow.mjs          # 默认 900×760
 *   W=760 H=900 node desktop/tests/e2e/shot-narrow.mjs
 *
 * 环境变量：APP_URL / CHROME_PATH / CDP_PORT / OUT
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9477)
const W = Number(process.env.W || 900)
const H = Number(process.env.H || 760)
const APP_URL = process.env.APP_URL || 'http://localhost:5173/?mock=ready&noResume=1'
const OUT = process.env.OUT || 'tmp/shots-render'
const NAME = process.env.NAME || `narrow-${W}x${H}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function pageWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {
      /* 还没起来 */
    }
    await sleep(150)
  }
  throw new Error('Chrome CDP 没有就绪')
}

function makeClient(ws) {
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  return { send }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const profile = mkdtempSync(join(tmpdir(), 'qa-narrow-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
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
  // 精确设视口：比 --window-size 可靠（后者含浏览器边框）
  await send('Emulation.setDeviceMetricsOverride', {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await send('Page.navigate', { url: APP_URL })
  await sleep(4000)

  // 横向溢出 = 窄窗没重排好（最常见的就是表格/工具条撑破）
  const overflow = await send('Runtime.evaluate', {
    expression: `(() => {
      const d = document.documentElement;
      return { scrollW: d.scrollWidth, clientW: d.clientWidth, over: d.scrollWidth > d.clientWidth + 1 };
    })()`,
    returnByValue: true,
  })
  const v = overflow.result.value
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const p = join(OUT, `${NAME}.png`)
  writeFileSync(p, Buffer.from(r.data, 'base64'))
  console.log(`视口 ${W}×${H} · scrollWidth=${v.scrollW} / clientWidth=${v.clientW}`)
  console.log(v.over ? '❌ 横向溢出（需要重排）' : '✅ 无横向溢出')
  console.log(`截图 ${p}`)

  chrome.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {}
  ws.close()
  process.exitCode = v.over ? 1 : 0
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
