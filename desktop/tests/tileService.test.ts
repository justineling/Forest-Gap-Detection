/**
 * 影像服务「起不来」这条链路的测试。
 *
 * 守两件事，都来自 2026-10-20 公司电脑事故：
 *
 *  1. **`probeBackend` 不能把别人的服务当成自己人。** 8765 是固定端口，
 *     只要对方的 JSON 里恰好有 `ok: true`，老代码就会返回 `online: true`，
 *     界面显示"就绪"，实际一拿瓦片就全错。判据必须是身份（`app` 字段）。
 *
 *  2. **失败文案要给真因，不能给猜测。** 原来是三条并列的"请确认①文件占用
 *     ②标准GeoTIFF③磁盘空间"，而它唯一知道的事实是"超时"。现场三条全不对，
 *     用户照着做一圈什么也没解决。
 */
import { probeBackend, TILE_APP_ID } from '../src/api/backend'
import { explain, exitCodeHex } from '../src/lib/tileDiag'
import type { TileDiag } from '../src/api/backend'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

// ---------------- 假的 fetch：按 body 返回，或抛错 ----------------
const realFetch = globalThis.fetch
function stubFetch(body: string | null, status = 200): void {
  globalThis.fetch = (async () => {
    if (body === null) throw new Error('connect ECONNREFUSED 127.0.0.1:8765')
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body),
    } as unknown as Response
  }) as unknown as typeof fetch
}
function restoreFetch(): void {
  globalThis.fetch = realFetch
}

const META_OURS = JSON.stringify({
  app: TILE_APP_ID,
  ok: true,
  source: 'D:/a.tif',
  width: 100,
  height: 100,
  crs: 'EPSG:4326',
  res_m: 0.03,
  bounds_wgs84: [0, 0, 1, 1],
  center: [0.5, 0.5],
  zoom: 15,
  tile_url: '/tiles/{z}/{x}/{y}.png',
})

async function main(): Promise<void> {
  // ---------- A. 身份校验 ----------
  console.log('\nA. /meta 身份校验（端口被别人占时必须识别出来）')
  {
    stubFetch(META_OURS)
    const st = await probeBackend()
    check(st.online, '带 app=fgd-tile-server 的应答算就绪')
    check(st.meta?.app === TILE_APP_ID, 'meta.app 正确带回')
  }
  {
    // 别的程序也可能返回 ok:true —— 这是最危险的一种
    stubFetch(JSON.stringify({ app: 'other-service', ok: true, source: 'x' }))
    const st = await probeBackend()
    check(!st.online, 'app 不认识 → 不能算就绪')
    check(st.foreign === true, 'foreign 标记为 true（界面据此提示端口被占）')
  }
  {
    // 本次改动之前构建的后端没有 app 字段，必须仍认亲，
    // 否则用户升级外壳后会被自己上一版的残留进程挡住
    stubFetch(
      JSON.stringify({ ok: true, source: 'D:/a.tif', tile_url: '/tiles/{z}/{x}/{y}.png' }),
    )
    const st = await probeBackend()
    check(st.online, '旧版后端（无 app 字段但字段齐全）仍算就绪')
    check(!st.foreign, '不能把旧版自己标成外人')
  }
  {
    stubFetch(JSON.stringify({ ok: true }))
    const st = await probeBackend()
    check(!st.online, '缺 source/tile_url → 不算就绪')
  }
  {
    stubFetch(null)
    const st = await probeBackend()
    check(!st.online && !st.foreign, '连不上 → offline 且不是 foreign')
  }
  restoreFetch()

  // ---------- B. 真因翻译 ----------
  console.log('\nB. explain()：按证据给真因，而不是三条猜测')

  /** 造一份最小的 TileDiag */
  function diag(p: Partial<TileDiag>): TileDiag {
    return {
      port: 8765,
      port_open: false,
      ours: false,
      meta_head: '',
      probe_error: '',
      child_alive: false,
      exit_code: null,
      start_error: '',
      log_tail: [],
      backend: null,
      ...p,
    }
  }

  {
    const e = explain(diag({ port_open: true, ours: false }), true)
    check(e.title.includes('8765'), '端口被占：标题点明是端口问题', e.title)
    check(
      e.title.includes('占用'),
      '端口被占：标题说"占用"（用户能立刻理解为"不是影像的问题"）',
    )
    check(
      e.steps.some((s) => s.includes('Get-NetTCPConnection')),
      '端口被占：给出查占用的具体命令',
    )
    // 关键：这条路径**不能**再说"请确认影像是标准 GeoTIFF"
    check(
      !e.steps.join(' ').includes('GeoTIFF'),
      '端口被占：不再把锅甩给影像文件',
    )
  }
  {
    const e = explain(diag({ exit_code: -1073741515 }), false)
    check(e.title.includes('退出码'), '进程秒退：标题带退出码', e.title)
    check(e.title.includes('0xC0000135'), '进程秒退：标题同时给十六进制指纹')
    check(
      e.steps.some((s) => s.includes('运行库')),
      '0xC0000135 → 提示运行库缺失，而不是让用户去查磁盘空间',
    )
  }
  {
    const e = explain(diag({ exit_code: -1073741502 }), false)
    check(
      e.steps.some((s) => s.includes('杀毒')),
      '0xC0000142 → 指向杀毒软件拦截',
    )
  }
  {
    const e = explain(diag({ exit_code: 2 }), false)
    check(e.title.includes('退出码 2'), '未知退出码也要如实显示', e.title)
    check(
      e.steps.some((s) => s.includes('白名单')),
      '未知非 0 退出码 → 建议加白名单',
    )
  }
  {
    const e = explain(diag({ child_alive: true, port_open: false }), false)
    check(e.title.includes('还没打开'), '进程活着但端口没开 → 说明可能正在加载', e.title)
    check(
      e.steps.some((s) => s.includes('诊断影像服务.bat')),
      '这条分支指向诊断脚本',
    )
  }
  {
    const e = explain(diag({ start_error: '端口 8765 被其它程序占用' }), false)
    check(
      e.steps[0].includes('端口 8765'),
      '没有子进程时：start_error 原文透传（不吞掉外壳给的真因）',
    )
  }
  {
    // 真正的超时兜底：此时 ①②③ 才是恰当的
    const e = explain(null, false, 120)
    check(e.title.includes('120'), '超时兜底：标题带秒数', e.title)
    check(
      e.steps.some((s) => s.includes('GeoTIFF')),
      '超时兜底：三条通用建议仍保留（这时它是有意义的）',
    )
  }
  {
    // foreign 标志优先于一切：即使 diag 缺失也要报端口问题
    const e = explain(null, true)
    check(e.title.includes('端口'), 'foreign 优先，不依赖 diag')
  }

  // ---------- C. 退出码格式化 ----------
  console.log('\nC. exitCodeHex()')
  check(exitCodeHex(-1073741515) === '0xC0000135', '负 int32 → NTSTATUS 十六进制')
  check(exitCodeHex(0) === '0x00000000', '0 也要补齐 8 位')
  check(exitCodeHex(2) === '0x00000002', '正常正数')

  console.log()
  if (failures === 0) {
    console.log('✅ 全部通过')
  } else {
    console.log(`❌ ${failures} 项失败`)
    process.exitCode = 1
  }
}

void main()
