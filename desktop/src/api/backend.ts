/**
 * 后端客户端。
 *
 * 按 `docs/01-需求与架构/桌面端交互需求与实现映射.md` §0.2 的裁定：
 * **算法主链路走 stdio NDJSON sidecar，只有瓦片走 HTTP**。
 * 因此本文件只封装「瓦片 + 元数据 + 结果读取 + 估算/导出」这几个
 * 必须走 HTTP 的端点；真正的检测（`detect`）在 Tauri 里由 Rust 通过
 * `scripts/sidecar.py` 的 NDJSON 契约调用，不走 HTTP。
 */
import type { GapCollection, RasterMeta } from '../types'

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
 */
export function normalizeCollection(raw: RawResult | null | undefined): GapCollection {
  const grid = raw?.planting_grid
  if (raw?.features?.length) {
    return { type: 'FeatureCollection', features: raw.features, planting_grid: grid }
  }
  const features: GapCollection['features'] = []
  for (const b of raw?.blocks ?? []) {
    for (const g of b.gaps ?? []) features.push(g)
  }
  return { type: 'FeatureCollection', features, planting_grid: grid }
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

export interface ExportRequest {
  /** 编辑后的要素集合 */
  gaps: GapCollection
  /** 导出目录（Tauri 里由文件对话框给出；原型里是后端默认 output/desktop-export） */
  outdir?: string
  /** 是否同时导出 Shapefile / KML */
  formats?: Array<'geojson' | 'shp' | 'kml' | 'csv'>
}

export interface ExportResponse {
  ok: boolean
  outdir: string
  files: string[]
  error?: string
}

export async function exportBundle(req: ExportRequest): Promise<ExportResponse> {
  return postJson<ExportResponse>('/export', req)
}

/**
 * 触发检测 —— **原型阶段故意留空**。
 *
 * 原因：ROI 裁剪（PRD R-P0-11）在算法侧尚未实现（`process_image.py` 的
 * `used_kml` 至今硬编码 `False`）。在 Tauri 版里这里会变成：
 *   1. 把 ROI + 参数写进 JSON；
 *   2. Rust 侧 `spawn` `scripts/sidecar.py --params-stdin`；
 *   3. 逐行解析 NDJSON 事件 → 通过 Tauri event 推给前端。
 * 浏览器原型里无法 spawn 进程，所以只提示，不假装成功。
 */
export function detectNotAvailableInBrowser(): string {
  return (
    '检测需由 Python sidecar 执行（stdio NDJSON 契约）。' +
    '浏览器原型无法启动子进程 —— 请用 Tauri 版，或先在命令行跑：\n' +
    '  .venv/Scripts/python.exe scripts/process_image.py --input "drone data/WGR17-002.tif" \\\n' +
    '    --job wgr17-elev --out-json output/wgr17-elev-gaps.geojson \\\n' +
    '    --chm output/chm.tif --segment "drone data/segment.tif" --target-density 150'
  )
}
