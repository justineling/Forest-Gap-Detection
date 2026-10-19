/**
 * 后端客户端。
 *
 * 按 `docs/01-需求与架构/桌面端交互需求与实现映射.md` §0.2 的裁定：
 * **算法主链路走 stdio NDJSON sidecar，只有瓦片走 HTTP**。
 * 因此本文件只封装「瓦片 + 元数据 + 结果读取 + 估算/导出」这几个
 * 必须走 HTTP 的端点；真正的检测（`detect`）在 Tauri 里由 Rust 通过
 * `scripts/sidecar.py` 的 NDJSON 契约调用，不走 HTTP。
 */
import type { GapCollection, PreflightResult, RasterMeta } from '../types'

/** 本地瓦片/辅助服务地址（原型用 Python 标准库实现，见 scripts/tile_server.py） */
export const BACKEND_BASE = 'http://127.0.0.1:8765'

export const TILE_URL_TEMPLATE = `${BACKEND_BASE}/tiles/{z}/{x}/{y}.png`

async function getJson<T>(path: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BACKEND_BASE}${path}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function postJson<T>(path: string, body: unknown, timeoutMs = 120000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${BACKEND_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

export interface BackendStatus {
  online: boolean
  meta?: RasterMeta
  error?: string
}

/** 探测后端是否在线（并顺手取回影像元数据） */
export async function probeBackend(): Promise<BackendStatus> {
  try {
    const meta = await getJson<RasterMeta>('/meta')
    if (!meta?.ok) return { online: false, error: '后端返回 ok=false' }
    return { online: true, meta }
  } catch (e) {
    return { online: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** `/gaps` 的原始结构（算法输出的正式 schema 是 `blocks[].gaps`，不是扁平 features） */
interface RawResult {
  type?: string
  features?: GapCollection['features']
  blocks?: Array<{ block_id?: string; block_name?: string; gaps?: GapCollection['features'] }>
  planting_grid?: GapCollection['planting_grid']
  summary?: Record<string, unknown>
  /** 后端读不到结果文件时给的人类说明（`features` 为空时才有意义） */
  error?: string
}

/**
 * 把算法输出规整成前端的扁平 `FeatureCollection`。
 *
 * ⚠️ **这是踩过的坑**：`output/*.geojson` 的正式结构是
 * `{ blocks: [{ block_id, gaps: [...] }], planting_grid, summary }`，
 * **没有顶层 `features`**。若直接 `fc.features ?? []` 会拿到空数组 ——
 * 界面看起来"后端连上了、地图也有影像"，但一个多边形都不显示，
 * 也不会报错。内置样例 `public/sample-gaps.geojson` 是扁平结构，
 * 所以离线演示时反而正常，更容易掩盖这个 bug。
 *
 * ⚠️ **第二个坑（本函数存在的第二个理由）**：`/gaps` 读不到文件时返回的是
 * `{features: [], error: "未找到检测结果文件…"}`。如果这里只取 features，
 * "没找到文件"就退化成了"检测结果是 0 块" —— 用户看到"没有空地"，
 * 完全不知道检测其实成功了、只是文件在别处。所以 `error` 必须原样透传。
 */
export function normalizeCollection(raw: RawResult | null | undefined): GapCollection {
  const grid = raw?.planting_grid
  const error = typeof raw?.error === 'string' && raw.error ? raw.error : undefined
  if (raw?.features?.length) {
    return { type: 'FeatureCollection', features: raw.features, planting_grid: grid, error }
  }
  const features: GapCollection['features'] = []
  for (const b of raw?.blocks ?? []) {
    for (const g of b.gaps ?? []) features.push(g)
  }
  return { type: 'FeatureCollection', features, planting_grid: grid, error }
}

/** 读取最近一次检测结果（真实数据，来自 output/*.geojson） */
export async function fetchGaps(): Promise<GapCollection> {
  return normalizeCollection(await getJson<RawResult>('/gaps', 30000))
}

/**
 * 补种点位（**Python/UTM 权威结算**，不是前端自算）。
 *
 * 为什么不用前端 `lib/estimate.ts` 的结果直接放样：前端用局部等距圆柱近似，
 * 0.5 m 档实测与 Python 完全一致（3,691 vs 3,691），但 1.0/2.0 m 档差
 * 0.6~0.9%（GEOS `buffer(-d)` 与逐点距离的数值精度）。**对外交付用这个**，
 * 前端自算只用于拖动时的即时反馈。
 */
export interface PlantingPointsResult {
  type: 'FeatureCollection'
  features: Array<{
    type: 'Feature'
    geometry: { type: 'Point'; coordinates: [number, number] }
    properties: {
      point_id: string
      gap_id: string
      class: string
      source: string
      utm_x: number
      utm_y: number
      clearance_m: number
    }
  }>
  meta?: {
    total: number
    by_class: Record<string, number>
    by_source: Record<string, number>
    clearance_m: number
    crs: string
    authority: string
  }
  error?: string
}

export async function fetchPlantingPoints(clearanceM: number): Promise<PlantingPointsResult> {
  return getJson<PlantingPointsResult>(`/planting-points?clearance=${clearanceM}`, 180000)
}

// ============================================================================
//  Tauri 宿主桥接（检测走 stdio NDJSON sidecar）
//  ---------------------------------------------------------------------------
//  ⚠️ 护栏 4：**必须保留纯浏览器模式可用**。
//    Headless Chrome（localhost:5173）里没有 `window.__TAURI_INTERNALS__`，
//    直接 `invoke()` 会抛错 → React 卸载整棵树 → 白屏。
//    所以这里一律先判断环境，浏览器下走"优雅降级"而不是硬调 Tauri API。
//    另外用**动态 import**：只在真的要在 Tauri 里跑时才加载 @tauri-apps/api，
//    浏览器打包产物不会因为这条路径多出运行时依赖。
// ============================================================================

/**
 * 选择 KML / GeoJSON 范围文件。
 *
 * 只返回**路径**，内容由 `readTextFile` 读 —— 解析放在前端纯函数里
 * （`lib/roiImport.ts`），这样"三维坐标有没有剥干净"能被 npm test 测住。
 */
export async function pickRoiFile(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: '范围文件 (KML / GeoJSON)', extensions: ['kml', 'geojson', 'json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  })
  if (typeof picked === 'string') return picked
  if (Array.isArray(picked) && typeof picked[0] === 'string') return picked[0]
  return null
}

/** 读取文本文件（KML / GeoJSON）。大小上限由 Rust 侧把关。 */
export async function readTextFile(path: string): Promise<string> {
  if (!isTauri()) throw new Error('浏览器模式不能读取本地文件')
  return tauriInvoke<string>('read_text_file', { path })
}

/**
 * 选择导出目录。
 *
 * 浏览器模式返回 null —— 调用方应该退化成"手动填路径"的输入框，
 * 而不是直接失败（Headless Chrome 里没有原生对话框）。
 */
export async function pickOutputDir(): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ multiple: false, directory: true })
  if (typeof picked === 'string') return picked
  if (Array.isArray(picked) && typeof picked[0] === 'string') return picked[0]
  return null
}

/** 在资源管理器里打开目录（导出完成后的一步操作） */
export async function openPath(path: string): Promise<void> {
  if (!isTauri()) return
  await tauriInvoke<string>('open_path', { path })
}

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(cmd, args)
}

export type DetectStartResult =
  | { ok: true; mode: 'tauri'; message: string }
  | { ok: false; mode: 'browser'; message: string }

/**
 * 启动一次检测。
 *
 * `params` 直接对应 sidecar 的参数表（见交接简报 §3），例如：
 * `{ input, job, chm, segment, workers: 4, target_density: 150 }`
 *
 * 若传了 `roi`（前端画的 Target Block，经纬度 GeoJSON），会一起带过去 ——
 * Rust 侧把它写成临时 `.geojson` 再作为 `roi` 路径传给 sidecar
 * （sidecar 的 `roi` 参数是**文件路径**，不接受内联几何）。
 */
/**
 * 检测前预检：文件在不在、输出目录写不写得进、森林掩膜有没有。
 *
 * 为什么要有它：`run_detect` 里 chm / segment 缺了**不会报错** ——
 * sidecar 只回一条 W1004 就照常跑完，结果退化成"纯 RGB"。
 * 用户在 350 秒后拿到一份看着正常、语义完全不同的结果，是最坏的一种失败。
 *
 * 浏览器模式返回一个"无法预检"的 info（不抛错），保证界面仍可用。
 */
export async function preflightDetect(
  params: Record<string, unknown>,
): Promise<PreflightResult> {
  if (!isTauri()) {
    return {
      ok: true,
      items: [
        {
          key: 'browser',
          label: '浏览器模式',
          path: '',
          status: 'info',
          detail: '浏览器里不能预检本地文件；桌面应用会逐项检查',
        },
      ],
      resolved: params,
    }
  }
  return tauriInvoke<PreflightResult>('preflight_detect', { params })
}

export async function runDetect(opts: {
  params: Record<string, unknown>
  roi?: unknown
}): Promise<DetectStartResult> {
  if (!isTauri()) {
    return {
      ok: false,
      mode: 'browser',
      message:
        '浏览器模式无法启动检测（需要拉起 Python 子进程）。' +
        '请用「启动桌面端.bat」打开桌面应用；当前界面仍可查看/编辑/估算/导出。',
    }
  }
  const payload: Record<string, unknown> = { ...opts.params }
  if (opts.roi) payload.roi_geojson = opts.roi
  const msg = await tauriInvoke<string>('run_detect', { params: payload })
  return { ok: true, mode: 'tauri', message: msg }
}

/** 中途取消（全量 350 秒、ROI 195 秒，用户很可能画错框想中止） */
export async function cancelDetect(): Promise<string> {
  if (!isTauri()) return '浏览器模式没有可取消的检测'
  return tauriInvoke<string>('cancel_detect')
}

/** 问一句"现在有没有检测在跑"（HMR 重载后恢复 UI 状态用） */
export async function detectRunning(): Promise<boolean> {
  if (!isTauri()) return false
  try {
    return await tauriInvoke<boolean>('detect_status')
  } catch {
    return false
  }
}

/** 订阅 sidecar 的 NDJSON 事件（started / progress / log / result / error） */
export async function onSidecarEvent(
  cb: (ev: Record<string, unknown>) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen<Record<string, unknown>>('sidecar-event', (e) => cb(e.payload))
  return un
}

/** 订阅 sidecar 的 stderr 人类日志 */
export async function onSidecarLog(cb: (line: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen<string>('sidecar-log', (e) => cb(e.payload))
  return un
}

// ============================================================================
//  「生成高度图 / 林地边界」（等价于命令行跑 build_chm.py + build_forest_mask.py）
// ---------------------------------------------------------------------------
//  为什么放进界面：换园区时这两个文件必须重算。命令行对现场用户不可用
//  （不知道 .venv、不知道 --dsm 该指哪），结果就是"换个园区只能出降级结果，
//  而且界面不报错" —— 这是最坏的一种失败。
// ============================================================================

/** 生成派生数据需要的输入（路径可相对，Rust 侧会补成绝对） */
export interface DerivedParams {
  input: string
  dsm?: string
  segment?: string
  tree_info?: string
  out_chm?: string
  out_mask?: string
}

/** 与 preflightDetect 同构：items 里有 error 就不能开始 */
export async function preflightDerived(
  params: DerivedParams,
): Promise<PreflightResult> {
  if (!isTauri()) {
    return {
      ok: true,
      items: [
        {
          key: 'browser',
          label: '浏览器模式',
          path: '',
          status: 'info',
          detail: '浏览器里不能检查本地文件；桌面应用会逐项检查',
        },
      ],
      resolved: params as unknown as Record<string, unknown>,
    }
  }
  return tauriInvoke<PreflightResult>('preflight_derived', { params })
}

/** 启动生成。返回 "started"，进度靠 onDerivedEvent 收 */
export async function runBuildDerived(
  params: DerivedParams,
): Promise<{ ok: boolean; message: string }> {
  if (!isTauri()) {
    return { ok: false, message: '浏览器模式不能生成 —— 请用「启动桌面端.bat」打开桌面应用' }
  }
  try {
    const r = await tauriInvoke<string>('run_build_derived', { params })
    return { ok: r === 'started', message: r }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 订阅生成事件。
 *
 * ⚠️ 与检测**分开两个通道**（`derived-event` vs `sidecar-event`）：
 *    两个进度条语义不同，混在一个通道里会出现"检测进度条在跳，但你在做别的事"。
 */
export async function onDerivedEvent(
  cb: (ev: Record<string, unknown>) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen<Record<string, unknown>>('derived-event', (e) => cb(e.payload))
  return un
}

export async function onDerivedLog(cb: (line: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  const un = await listen<string>('derived-log', (e) => cb(e.payload))
  return un
}

// ============================================================================
//  首次使用引导：选影像 / 选结果
//  ---------------------------------------------------------------------------
//  为什么需要这一层：打包版没有"仓库根"，用户不可能知道要把 3.5 GB 的影像
//  放到 `%LOCALAPPDATA%\fgd\data` 这种地方。让他在界面里选一次，路径记住，
//  下次直接可用 —— 这是"小白能用"的最低门槛。
// ============================================================================

export interface AppStatus {
  /** 后端执行方式（打包运行时 / 开发态解释器），排障用 */
  backend: string | null
  tile_running: boolean
  image: string | null
  gaps: string | null
  /** 数据根目录（提示"文件该放哪"时显示） */
  data_root: string
  /** true = 还没有可用影像，应显示「选择影像」引导 */
  needs_setup: boolean
}

const BROWSER_STATUS: AppStatus = {
  backend: null,
  tile_running: false,
  image: null,
  gaps: null,
  data_root: '（浏览器模式）',
  needs_setup: false,
}

export async function getStatus(): Promise<AppStatus> {
  if (!isTauri()) return BROWSER_STATUS
  try {
    return await tauriInvoke<AppStatus>('get_status')
  } catch {
    return BROWSER_STATUS
  }
}

/** 保存用户选择并重启瓦片服务（返回新状态） */
export async function setDataPaths(opts: {
  image?: string | null
  gaps?: string | null
}): Promise<AppStatus> {
  return tauriInvoke<AppStatus>('set_data_paths', {
    image: opts.image ?? null,
    gaps: opts.gaps ?? null,
  })
}

export type PickKind = 'image' | 'gaps'

/**
 * 打开系统文件选择框。
 * 浏览器模式返回 null（前端会提示"请在桌面应用里操作"）。
 */
export async function pickFile(
  kind: PickKind,
  opts?: {
    /**
     * 对话框的起始目录。
     *
     * 为什么需要：用户选「检测结果」时，结果文件**一定**在数据根的 `output/` 下
     * （检测程序就写在那儿）。默认从"上次用过的目录"打开的话，用户经常落在
     * 影像所在的 `drone data/`，还得手动往上翻两级再进 output —— 纯属添堵。
     */
    defaultPath?: string
  },
): Promise<string | null> {
  if (!isTauri()) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const filters =
    kind === 'image'
      ? [{ name: '正射影像 (GeoTIFF)', extensions: ['tif', 'tiff'] }]
      : [{ name: '检测结果 (GeoJSON)', extensions: ['geojson', 'json'] }]
  const picked = await open({
    multiple: false,
    directory: false,
    filters,
    ...(opts?.defaultPath ? { defaultPath: opts.defaultPath } : {}),
  })
  if (typeof picked === 'string') return picked
  // 某些平台返回数组
  if (Array.isArray(picked) && typeof picked[0] === 'string') return picked[0]
  return null
}

/**
 * 轮询等后端就绪（服务重启 + 建金字塔可能要几秒到几十秒）。
 * 返回 true 表示 `/meta` 已经能应答。
 */
export async function waitBackend(timeoutMs = 90_000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const st = await probeBackend()
    if (st.online) return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return false
}

export interface ExportRequest {
  /** 编辑后的要素集合 */
  gaps: GapCollection
  /** 导出目录（Tauri 里由文件夹对话框给出；浏览器里可手填） */
  outdir?: string
  /**
   * 排坑退让距离（m）。放样点位按它结算，**必须与界面上的档位一致** ——
   * 否则报告里的株数和用户看到的估算对不上。
   */
  clearance_m?: number
  /**
   * 算法种植网格。后端会优先用磁盘上结果文件里的完整网格
   * （含 UTM 原点 origin_x_m/origin_y_m）；这里只是兜底。
   */
  planting_grid?: unknown
  /** 人工复核留痕（新增 / 改判 / 剔除），进报告第四章 */
  audit?: { added: number; edited: number; deleted: number }
  /** 影像元信息，进报告第一章的参数卡片 */
  image?: { name: string; width: number; height: number; res_m: number; crs: string }
  /** 圈选范围（报告里区分"整幅"与"圈内"） */
  roi?: { has_roi: boolean; area_sqm: number }
}

export interface ExportResponse {
  ok: boolean
  outdir: string
  files: string[]
  error?: string
  /** 后端附带的提醒（某类交付物生成失败时不影响其余） */
  notes?: string[]
  counts?: { features: number; planting_points: number }
  /** 一页汇总报告路径 */
  report?: string | null
}

export async function exportBundle(req: ExportRequest): Promise<ExportResponse> {
  return postJson<ExportResponse>('/export', req)
}
