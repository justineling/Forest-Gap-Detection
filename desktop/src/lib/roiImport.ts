import type { PolygonGeometry, Position } from '../types'

/**
 * KML / GeoJSON 范围导入（Target Block）。
 *
 * 为什么不用 DOMParser：它只存在于浏览器，`npm test` 跑在 Node 里测不到 ——
 * 而"三维坐标没剥干净导致面积算错"这种事，恰恰是最该被测住的一类。
 * KML 的 `<coordinates>` 结构极简单（一串 `lon,lat[,alt]`），
 * 用正则 + 手写解析足够稳，且完全可测。
 *
 * ⚠️ 三维坐标坑：大疆智图 / Google Earth / 奥维 导出的 KML，
 *    `<coordinates>` 通常是 `111.205,1.179,0`（lon,lat,alt）。
 *    第 3 维若混进 geometry，`polygonAreaM2` 与 Terra Draw 都会算错。
 *    这里**显式只取前两维**。
 */

export interface RoiImportResult {
  geometry: PolygonGeometry
  /** 来源格式 */
  source: 'kml' | 'geojson'
  /** KML 的 Placemark name / GeoJSON 的 feature id（用于界面显示） */
  name: string
  /** 原始顶点数（清洗前） */
  rawVertexCount: number
  /** 是否真的剥掉了第三维 —— 用于提示用户"已忽略高程" */
  strippedAltitude: boolean
  /** 文件里有几个多边形，最终取了最大的那个 */
  polygonCount: number
}

export class RoiImportError extends Error {}

/** 球面近似面积（度²），只用于"哪个环更大"的比较，不做真实面积 */
function ringAreaDeg(ring: Position[]): number {
  let s = 0
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
  }
  return Math.abs(s / 2)
}

function closeRing(ring: Position[]): Position[] {
  const first = ring[0]
  const last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) return [...ring, [first[0], first[1]]]
  return ring
}

/** 校验经纬度范围，避免把 UTM 米坐标当经纬度用 */
function assertLonLat(ring: Position[]): void {
  for (const [lon, lat] of ring) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new RoiImportError('坐标里有非数字，文件可能已损坏')
    }
    if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
      throw new RoiImportError(
        `坐标 ${lon}, ${lat} 超出经纬度范围 —— 这看起来是投影坐标（UTM 米），` +
          '请先转成 WGS84 经纬度再导入',
      )
    }
  }
}

/** 从 `<coordinates>` 文本里取环（**只保留前两维**） */
function parseCoordinateBlock(text: string): { ring: Position[]; hadAlt: boolean } {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  const ring: Position[] = []
  let hadAlt = false
  for (const tok of tokens) {
    const parts = tok.split(',')
    if (parts.length < 2) continue
    if (parts.length >= 3) hadAlt = true
    const lon = Number(parts[0])
    const lat = Number(parts[1])
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue
    ring.push([lon, lat]) // ← 第 3 维（alt）在这里被丢弃
  }
  return { ring, hadAlt }
}

function parseKml(text: string): RoiImportResult {
  const blocks = [...text.matchAll(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi)]
  if (blocks.length === 0) {
    throw new RoiImportError(
      'KML 里没找到 <coordinates> —— 可能是 KMZ（压缩包），请先解压出 .kml',
    )
  }

  let best: Position[] | null = null
  let bestArea = -1
  let hadAlt = false
  let rawVertexCount = 0
  for (const m of blocks) {
    const { ring, hadAlt: alt } = parseCoordinateBlock(m[1])
    if (ring.length < 3) continue
    hadAlt = hadAlt || alt
    rawVertexCount += ring.length
    const closed = closeRing(ring)
    const a = ringAreaDeg(closed)
    if (a > bestArea) {
      bestArea = a
      best = closed
    }
  }
  if (!best) throw new RoiImportError('KML 里的坐标点太少（不足 3 个），无法构成多边形')

  assertLonLat(best)
  const nameMatch = text.match(/<name>([\s\S]*?)<\/name>/i)
  return {
    geometry: { type: 'Polygon', coordinates: [best] },
    source: 'kml',
    name: nameMatch ? nameMatch[1].trim().slice(0, 60) : '',
    rawVertexCount,
    strippedAltitude: hadAlt,
    polygonCount: blocks.length,
  }
}

function geomToRings(geom: unknown): Position[][] {
  const g = geom as { type?: string; coordinates?: unknown }
  if (!g || typeof g !== 'object') return []
  if (g.type === 'Polygon') {
    const rings = g.coordinates as Position[][]
    return rings && rings[0] ? [rings[0] as Position[]] : []
  }
  if (g.type === 'MultiPolygon') {
    const polys = g.coordinates as Position[][][]
    return (polys ?? []).map((p) => p[0] as Position[]).filter(Boolean)
  }
  return []
}

function parseGeoJson(text: string): RoiImportResult {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (e) {
    throw new RoiImportError(
      `不是合法的 JSON / KML：${e instanceof Error ? e.message.slice(0, 80) : e}`,
    )
  }

  const anyObj = obj as { type?: string; features?: unknown[]; geometry?: unknown; properties?: Record<string, unknown> }
  let candidates: Array<{ rings: Position[][]; name: string }> = []

  if (anyObj.type === 'FeatureCollection' && Array.isArray(anyObj.features)) {
    for (const f of anyObj.features as Array<{ geometry?: unknown; properties?: Record<string, unknown> }>) {
      const rings = geomToRings(f?.geometry)
      if (rings.length > 0) {
        candidates.push({ rings, name: String(f?.properties?.name ?? '') })
      }
    }
  } else if (anyObj.type === 'Feature') {
    const rings = geomToRings(anyObj.geometry)
    if (rings.length > 0) candidates.push({ rings, name: String(anyObj.properties?.name ?? '') })
  } else {
    const rings = geomToRings(obj)
    if (rings.length > 0) candidates.push({ rings, name: '' })
  }

  if (candidates.length === 0) {
    throw new RoiImportError('GeoJSON 里没有 Polygon / MultiPolygon 要素')
  }

  let best: Position[] | null = null
  let bestArea = -1
  let name = ''
  let rawVertexCount = 0
  let polygonCount = 0
  let hadAlt = false
  for (const c of candidates) {
    for (const ring of c.rings) {
      if (!ring || ring.length < 3) continue
      polygonCount++
      rawVertexCount += ring.length
      // GeoJSON 理论上只有 2 维，但实际文件里常见 [lon, lat, alt]
      const cleaned: Position[] = ring.map((p) => {
        if (p.length > 2) hadAlt = true
        return [Number(p[0]), Number(p[1])] as Position
      })
      const closed = closeRing(cleaned)
      const a = ringAreaDeg(closed)
      if (a > bestArea) {
        bestArea = a
        best = closed
        name = c.name
      }
    }
  }
  if (!best) throw new RoiImportError('多边形顶点不足 3 个')

  assertLonLat(best)
  return {
    geometry: { type: 'Polygon', coordinates: [best] },
    source: 'geojson',
    name: name.slice(0, 60),
    rawVertexCount,
    strippedAltitude: hadAlt,
    polygonCount,
  }
}

/**
 * 解析 KML 或 GeoJSON 文本，返回**最大的那个多边形**作为 ROI。
 *
 * 取最大而不是合并：一个 KML 里常同时有"目标区块"和"周边标注/图例"，
 * 合并会把图例框也算进检测范围（面积虚增，瓦片数暴涨）。
 */
export function parseKmlOrGeoJsonRoi(text: string, filename = ''): RoiImportResult {
  const trimmed = text.trim()
  if (!trimmed) throw new RoiImportError('文件是空的')
  const looksXml = trimmed.startsWith('<') || /<kml[\s>]/i.test(trimmed.slice(0, 500))
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  if (looksXml || ext === 'kml') return parseKml(trimmed)
  return parseGeoJson(trimmed)
}
