/**
 * 界面回归：用真实鼠标/键盘事件驱动 headless Chrome（CDP），验证 13 条 UI 改造。
 *
 * 手工回归用，**不进 `npm test`**（需要浏览器 + dev server，CI 跑不了）。
 *
 * 为什么不用 `?mock=ready`
 * ------------------------
 * 该开关伪造的 `/meta` **缺 `bounds_wgs84`**，`MapCanvas.tsx:246` 解构时抛
 * `undefined is not iterable`，整块地图被 ErrorBoundary 顶掉（DOM 里只剩
 * 「地图渲染出错」）。于是"在 mock 下点一遍"其实是在**没有地图**的界面上点，
 * 所有涉图交互（右键取消、框选、绘制）都测不到真东西。
 *
 * 本脚本改为用 `Page.addScriptToEvaluateOnNewDocument` 拦截 `fetch('/meta')`，
 * 返回**结构完整**的 meta —— 地图能正常初始化，交互才是真的。
 *
 * 依赖
 * ----
 * - dev server 已在 http://localhost:5173 运行（`cd desktop && npm run dev`）
 * - Chrome 可执行文件路径见 CHROME 常量（可用环境变量 CHROME_PATH 覆盖）
 *
 * 用法
 * ----
 *   node desktop/tests/e2e/ui_regress.mjs            # 跑全部场景
 *   node desktop/tests/e2e/ui_regress.mjs A1         # 只跑某一条
 *   node desktop/tests/e2e/ui_regress.mjs A1 A3 B C1 D1
 *
 * 场景与 13 条改造的对应
 * ----------------------
 *   A1  引导可取消（× / 取消 / Esc / 遮罩），且 Esc 不清地图选中
 *   A3  最小面积任意值（abc / -5 / 0 / 1e999 / 空格 / 超大值），筛选跨标签不丢
 *   B   三处帮助弹窗（左栏 / 右栏 / header）+ Esc 不误清选中
 *   C1  右栏「清单|验证集|属性」标签的出现与自动切换
 *       （2026-10-25：原来的「复核」页签改名为「清单」，并把内层的
 *        「复核|验证集」二选一提升为同级页签 —— 同一个词不再出现两次）
 *   D1  右键取消绘制（preventDefault / 不改选中 / 画完仍可用）
 *   M   反例：?mock=ready 下地图会崩（保留为已知问题看门狗）
 *   X   导出链路：顶层 features 空、要素在 blocks[].gaps 时仍能导出
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CHROME =
  process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = Number(process.env.CDP_PORT || 9333)
const BASE = process.env.APP_URL || 'http://localhost:5173/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let fails = 0
const ok = (cond, label, detail = '') => {
  console.log(`  [${cond ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!cond) fails++
}

// 让地图真正可用的假 meta（关键：必须含 bounds_wgs84）
const META_PATCH = `
  (() => {
    const _f = window.fetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (url.includes('/meta')) {
        return Promise.resolve(new Response(JSON.stringify({
          ok: true, source: 'WGR17-002.tif', width: 47130, height: 44686,
          bands: 4, crs: 'EPSG:4326', res_m: 0.033,
          bounds_wgs84: [111.15, 1.14, 111.25, 1.22], center: [111.2, 1.18],
          zoom: 14, has_overviews: true, tile_url: '/tiles/{z}/{x}/{y}.png'
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
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
  const events = []
  let seq = 0
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    } else if (msg.method) events.push(msg)
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pending.set(id, { res, rej })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { send, events }
}

async function main() {
  const want = process.argv.slice(2)
  const scenarios = want.length ? want : ['A1', 'A3', 'B', 'C1', 'D1', 'M', 'X']

  const profile = mkdtempSync(join(tmpdir(), 'qa-cdp-'))
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
  const { send, events } = makeClient(ws)
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', { source: META_PATCH })

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
    return r.result.value
  }

  const goto = async (query) => {
    await send('Page.navigate', { url: BASE + query })
    await sleep(2800)
  }

  const key = async (k, code, vk) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
    await sleep(260)
  }
  const esc = () => key('Escape', 'Escape', 27)
  const del = () => key('Delete', 'Delete', 46)

  const mouse = async (type, x, y, button = 'left', clickCount = 1) =>
    send('Input.dispatchMouseEvent', {
      type, x, y, button, clickCount,
      buttons: button === 'left' ? 1 : 2,
    })
  const clickAt = async (x, y, button = 'left') => {
    await mouse('mousePressed', x, y, button)
    await mouse('mouseReleased', x, y, button)
    await sleep(300)
  }

  const snap = () =>
    evalJs(`
      const tabs = [...document.querySelectorAll('.panel.right .panel-head .tab')]
        .map(b => ({ t: b.textContent.trim(), active: b.classList.contains('active') }));
      return {
        tabs,
        rows: document.querySelectorAll('.rv-item').length,
        wizard: !!document.querySelector('.wizard-mask'),
        help: !!document.querySelector('.help-mask'),
        helpTitle: document.querySelector('.help-dialog h2')?.textContent ?? null,
        hint: document.querySelector('.map-drawing')?.textContent ?? null,
        propsId: document.querySelector('.tab-id')?.textContent ?? null,
      };
    `)

  const openWizard = async () => {
    await evalJs(`
      const more = document.querySelector('.more-wrap > button');
      if (more && !document.querySelector('.more-menu')) more.click();
      return true;
    `)
    await sleep(400)
    const clicked = await evalJs(`
      const t = [...document.querySelectorAll('.more-menu button[role=menuitem]')]
        .find(b => b.textContent.includes('更换影像'));
      if (!t) return false; t.click(); return true;
    `)
    await sleep(700)
    return clicked
  }

  const pickMenuItem = async (text) => {
    await evalJs(`document.querySelector('.more-wrap > button')?.click(); return true;`)
    await sleep(350)
    return evalJs(`
      const t = [...document.querySelectorAll('.more-menu button[role=menuitem]')]
        .find(b => b.textContent.includes(${JSON.stringify(text)}));
      if (!t) return false; t.click(); return true;
    `)
  }

  for (const s of scenarios) {
    console.log(`\n=== 场景 ${s} ===`)

    if (s === 'A1') {
      await goto('?p1=1')
      let st = await snap()
      ok(st.tabs.some((x) => x.t === '属性'), '前置：p1=1 已预选，出现「属性」标签')

      ok(await openWizard(), '从「⋯ 更多 → 更换影像」打开引导')
      ok((await snap()).wizard, '引导已显示')

      await esc()
      st = await snap()
      ok(!st.wizard, 'Esc 关闭引导')
      ok(
        st.tabs.some((x) => x.t === '属性' && x.active),
        'Esc 关闭后地图选中仍在（capture 拦住了全局 Esc）',
        JSON.stringify(st.tabs),
      )

      await openWizard()
      await evalJs(`document.querySelector('.wizard-close')?.click(); return true;`)
      await sleep(300)
      ok(!(await snap()).wizard, '「×」可关闭')

      await openWizard()
      await evalJs(`[...document.querySelectorAll('.wizard-actions button')]
        .find(b=>b.textContent.includes('取消'))?.click(); return true;`)
      await sleep(300)
      ok(!(await snap()).wizard, '「取消」可关闭')

      await openWizard()
      const pt = await evalJs(`
        const card = document.querySelector('.wizard').getBoundingClientRect();
        const map = document.querySelector('.map-container').getBoundingClientRect();
        const mask = document.querySelector('.wizard-mask').getBoundingClientRect();
        const out = [];
        for (let y = map.top + 20; y < map.bottom - 20; y += 20)
          for (let x = map.left + 20; x < map.right - 20; x += 20) {
            if (x > card.left - 6 && x < card.right + 6 && y > card.top - 6 && y < card.bottom + 6) continue;
            if (x < mask.left + 4 || x > mask.right - 4 || y < mask.top + 4 || y > mask.bottom - 4) continue;
            out.push([Math.round(x), Math.round(y)]);
          }
        return out[0] ?? null;
      `)
      ok(!!pt, '找到「遮罩上且在地图区域内」的坐标', JSON.stringify(pt))
      if (pt) await clickAt(pt[0], pt[1])
      st = await snap()
      ok(!st.wizard, '点遮罩可关闭')
      ok(st.tabs.some((x) => x.t === '属性'), '遮罩关闭后选中未被穿透点击清掉')
      await evalJs(`document.querySelector('.wizard-close')?.click(); return true;`)
    }

    if (s === 'A3') {
      await goto('')
      const setArea = async (val) =>
        evalJs(`
          const el = document.querySelector('.rv-area-input');
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          set.call(el, ${JSON.stringify(val)});
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return el.value;
        `)
      const st8 = () =>
        evalJs(`
          const segs = [...document.querySelectorAll('.rv-row-filter .seg-btn')]
            .map(b => ({ t: b.textContent, active: b.classList.contains('active') }));
          const inp = document.querySelector('.rv-area-input');
          return {
            segs, customActive: inp.classList.contains('active'),
            rows: document.querySelectorAll('.rv-item').length,
            empty: document.querySelector('.review .empty p')?.textContent ?? null,
          };
        `)

      for (const [v, label] of [
        ['abc', 'abc'], ['-5', '-5'], ['0', '0'],
        ['1e999', '1e999'], ['   ', '空格'], ['999999999', '超大值'],
      ]) {
        await setArea(v)
        await sleep(250)
        const st = await st8()
        ok(
          st.segs.filter((x) => x.active).length <= 1,
          `输入「${label}」不会两档同时高亮`,
          `rows=${st.rows}`,
        )
        ok(
          await evalJs(`return !!document.querySelector('.review')||!!document.querySelector('.empty')`),
          `输入「${label}」后面板未崩`,
        )
      }
      let st = await st8()
      ok(st.rows === 0 && !!st.empty, '超大值 → 空态提示而非白面板', String(st.empty))

      await evalJs(`[...document.querySelectorAll('.rv-row-filter .seg-btn')]
        .find(b=>b.textContent.includes('500')&&!b.textContent.includes('1000')&&!b.textContent.includes('100'))?.click(); return true;`)
      await sleep(250)
      await setArea('200')
      await sleep(250)
      st = await st8()
      ok(st.customActive && st.segs.filter((x) => x.active).length === 0,
        '先预设再自定义 → 只有自定义高亮', JSON.stringify(st.segs))

      await setArea('')
      await sleep(250)
      st = await st8()
      ok(!st.customActive && st.segs.filter((x) => x.active).length === 1,
        '清空自定义 → 恢复单一档位高亮')

      // 筛选跨标签不丢
      await evalJs(`[...document.querySelectorAll('.rv-row-filter .seg-btn')]
        .find(b=>b.textContent.includes('≥100')&&!b.textContent.includes('≥1000'))?.click(); return true;`)
      await sleep(200)
      await evalJs(`[...document.querySelectorAll('.rv-filter .chip')]
        .find(b=>b.textContent.includes('待复核'))?.click(); return true;`)
      await sleep(300)
      const kindBefore = await evalJs(`return [...document.querySelectorAll('.rv-filter .chip')]
        .find(b=>b.classList.contains('active'))?.textContent ?? null`)
      await evalJs(`document.querySelector('.rv-item')?.click(); return true;`)
      await sleep(500)
      const onProps = await evalJs(`return document.querySelector('.panel.right .tab.active')?.textContent ?? null`)
      await evalJs(`[...document.querySelectorAll('.panel.right .panel-head .tab')]
        .find(b=>b.textContent.includes('复核'))?.click(); return true;`)
      await sleep(400)
      const kindAfter = await evalJs(`return [...document.querySelectorAll('.rv-filter .chip')]
        .find(b=>b.classList.contains('active'))?.textContent ?? null`)
      ok(onProps === '属性', '点行后确实切到属性（ReviewList 已卸载）', String(onProps))
      ok(kindBefore === kindAfter, '切回来筛选 chip 不丢', `${kindBefore} → ${kindAfter}`)
    }

    if (s === 'B') {
      await goto('?p1=1')
      await evalJs(`document.querySelector('.panel.left .ph-help')?.click(); return true;`)
      await sleep(400)
      let st = await snap()
      ok(st.help && st.helpTitle?.includes('图层与类别'), '左栏 ? 打开帮助', String(st.helpTitle))
      const n = await evalJs(`return document.querySelectorAll('.help-dialog .help-item dt').length`)
      ok(n > 10, '帮助条目已渲染', String(n))
      await esc()
      st = await snap()
      ok(!st.help, 'Esc 关闭帮助')
      ok(st.tabs.some((x) => x.t === '属性' && x.active), '关帮助后选中仍在')

      await evalJs(`document.querySelector('.panel.right .ph-help')?.click(); return true;`)
      await sleep(400)
      st = await snap()
      ok(st.help && st.helpTitle?.includes('复核与属性'), '右栏 ? 打开帮助', String(st.helpTitle))
      await esc()

      await evalJs(`[...document.querySelectorAll('.tb-wrap header button.icon')]
        .find(b=>b.getAttribute('aria-label')==='使用说明')?.click(); return true;`)
      await sleep(400)
      st = await snap()
      ok(st.help && st.helpTitle?.includes('这个软件怎么用'), 'header ? 打开帮助', String(st.helpTitle))
      await evalJs(`document.querySelector('.help-dialog')
        .dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); return true;`)
      await sleep(250)
      ok((await snap()).help, '点弹窗内部不关闭')
      await evalJs(`document.querySelector('.help-mask')
        .dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:2,clientY:2})); return true;`)
      await sleep(250)
      ok(!(await snap()).help, '点遮罩关闭')
    }

    if (s === 'C1') {
      await goto('')
      let st = await snap()
      ok(
        st.tabs.length === 2 &&
          st.tabs[0].t.startsWith('清单') &&
          st.tabs[1].t.startsWith('验证集') &&
          st.tabs[0].active,
        '未选中时是「清单 | 验证集」两页签、清单激活',
        JSON.stringify(st.tabs),
      )
      await evalJs(`document.querySelector('.rv-item')?.click(); return true;`)
      await sleep(500)
      st = await snap()
      ok(st.tabs.length === 2 && st.tabs[1].t === '属性' && st.tabs[1].active,
        '选中 1 块 → 出现「属性」并自动切过去', JSON.stringify(st.tabs))
      await del()
      st = await snap()
      ok(!st.tabs.some((x) => x.t === '属性') && st.tabs[0].active,
        'Delete 删除后「属性」消失并回「清单」')
      await evalJs(`document.querySelector('.rv-item')?.click(); return true;`)
      await sleep(400)
      await esc()
      st = await snap()
      ok(!st.tabs.some((x) => x.t === '属性') && st.tabs[0].active, 'Esc 清空选中 → 回「清单」')
    }

    if (s === 'D1') {
      await goto('?p1=box')
      let st = await snap()
      ok(!!st.hint && st.hint.includes('右键 / Esc 取消'), '框选提示含「右键 / Esc 取消」')
      const prevented = await evalJs(`
        const c = document.querySelector('.map-container canvas');
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        return !c.dispatchEvent(ev);
      `)
      ok(prevented, 'contextmenu 被 preventDefault')
      await sleep(400)
      ok(!(await snap()).hint, '右键后退出绘制模式')

      ok(await pickMenuItem('手工补画'), '进入「手工补画」')
      await sleep(700)
      st = await snap()
      ok(!!st.hint && st.hint.includes('新增空地'), '绘制提示已显示', String(st.hint))
      const before = await evalJs(`return document.querySelectorAll('.panel.right .tab')[0].textContent`)
      await clickAt(600, 420)
      await clickAt(660, 450)
      const prevented2 = await evalJs(`
        const c = document.querySelector('.map-container canvas');
        const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 });
        return !c.dispatchEvent(ev);
      `)
      ok(prevented2, '手绘中 contextmenu 也被拦截')
      await sleep(500)
      ok(!(await snap()).hint, '手绘中右键可取消')
      const after = await evalJs(`return document.querySelectorAll('.panel.right .tab')[0].textContent`)
      ok(before === after, '未把画到一半的图形写进结果', `${before} → ${after}`)

      // 取消后再画一个完整多边形 → 块数 +1（证明状态机没坏）
      ok(await pickMenuItem('手工补画'), '再次进入绘制')
      await sleep(700)
      for (const [x, y] of [[500, 380], [580, 380], [580, 450]]) await clickAt(x, y)
      await mouse('mousePressed', 500, 450)
      await mouse('mouseReleased', 500, 450)
      await mouse('mousePressed', 500, 450, 'left', 2)
      await mouse('mouseReleased', 500, 450, 'left', 2)
      await sleep(900)
      const after2 = await evalJs(`return document.querySelectorAll('.panel.right .tab')[0].textContent`)
      ok(before !== after2, '右键取消之后仍能画完多边形（块数 +1）', `${before} → ${after2}`)
      ok(!(await snap()).hint, '画完自动退出绘制模式')
    }

    if (s === 'M') {
      // 已知问题看门狗：?mock=ready 的 meta 缺 bounds_wgs84 → 地图崩
      await send('Page.navigate', { url: BASE + '?mock=ready' })
      await sleep(2800)
      const dom = await evalJs(`
        return {
          crash: document.querySelector('.crash h3')?.textContent ?? null,
          msg: document.querySelector('.crash pre')?.textContent ?? null,
        };
      `)
      ok(
        dom.crash === null,
        '?mock=ready 下地图不应崩（当前已知会崩，修好 App.tsx 的 mock 后此条转绿）',
        JSON.stringify(dom),
      )
    }

    if (s === 'X') {
      // 载入：顶层 features 空，要素在 blocks[].gaps（算法原始形态）
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: `
          (() => {
            const raw = {
              type: 'FeatureCollection', features: [],
              blocks: [{ block_id: 'B1', gaps: [
                { type:'Feature', geometry:{type:'Polygon',coordinates:[[[111.20,1.18],[111.201,1.18],[111.201,1.181],[111.20,1.18]]]},
                  properties:{gap_id:'r1_c1-G0001', class:'open_patch', area_sqm:1000, source:'algo'} },
                { type:'Feature', geometry:{type:'Polygon',coordinates:[[[111.21,1.19],[111.211,1.19],[111.211,1.191],[111.21,1.19]]]},
                  properties:{gap_id:'r2_c2-G0002', class:'vacant_slot', area_sqm:500, source:'algo'} }
              ]}],
              planting_grid: { plant_pitch_m: 8.45, row_pitch_m: 7.32, azimuth_deg: 0.67 },
              summary: {}
            };
            const f = window.fetch;
            window.fetch = async (input, init) => {
              const url = typeof input === 'string' ? input : (input && input.url) || '';
              if (url.includes('/gaps') && !url.includes('planting'))
                return new Response(JSON.stringify(raw), { status: 200, headers: { 'Content-Type': 'application/json' } });
              if (url.includes('/export')) {
                try { window.__exp = JSON.parse(init.body); } catch (e) { window.__exp = { err: String(e) }; }
                return new Response(JSON.stringify({ ok: true, outdir: 'D:/out',
                  files: ['D:/out/a', 'D:/out/b'], counts: { features: 2, planting_points: 10 },
                  report: 'D:/out/r.html', notes: [] }),
                  { status: 200, headers: { 'Content-Type': 'application/json' } });
              }
              return f(input, init);
            };
          })();
        `,
      })
      await goto('?p2=export')
      const loaded = await evalJs(`return document.querySelectorAll('.panel.right .tab')[0].textContent`)
      ok(/2/.test(loaded), 'blocks[].gaps 被拍平后载入 2 块', loaded)
      await evalJs(`[...document.querySelectorAll('.export-dialog .wizard-actions button')]
        .find(b=>b.textContent.includes('开始导出'))?.click(); return true;`)
      await sleep(900)
      const body = await evalJs(`return window.__exp ?? null`)
      ok(!!body, '发出 POST /export')
      if (body) {
        ok(Array.isArray(body.gaps?.features), 'gaps.features 是扁平数组')
        ok(body.gaps.features.length === 2, '扁平长度 = 2', String(body.gaps.features.length))
        ok(!('blocks' in (body.gaps ?? {})), '请求体无 blocks（前端已拍平）')
      }
      const out = await evalJs(`return {
        err: document.querySelector('.export-dialog .wizard-err')?.textContent ?? null,
        done: document.querySelector('.export-result-head, .exp-result-head')?.textContent ?? null,
      }`)
      ok(!out.err, '导出无报错（不会出现「没有可导出的要素」）', String(out.err))
    }
  }

  const ex = events
    .filter((e) => e.method === 'Runtime.exceptionThrown')
    .map((e) => e.params.exceptionDetails.text)
  ok(ex.length === 0, '无未捕获异常', ex.slice(0, 2).join(' | ') || '—')

  console.log(fails === 0 ? '\n✅ 全部通过' : `\n❌ ${fails} 项不通过`)
  ws.close()
  chrome.kill()
  await sleep(300)
  try { rmSync(profile, { recursive: true, force: true }) } catch {}
  process.exit(fails === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('HARNESS ERROR', e)
  process.exit(2)
})
