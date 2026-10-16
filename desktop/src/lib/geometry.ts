import type { GapGeometry, MultiPolygonGeometry, PolygonGeometry, Position } from '../types'

/**
 * 极简几何工具（零依赖）。
 *
 * ⚠️ 适用范围说明：这些函数把经纬度按「局部等距近似」换算成米。
 * 本园区外接矩形约 1.55 km × 1.48 km，在该尺度下误差 < 0.1%。
 * **正式版应由 Python 侧在 UTM 49N 投影坐标下计算**（`scripts/grid_prior.py`
 * 已有成熟的 UTM 处理），前端只做即时反馈。
 *
 * ⚠️ 换算系数必须用**大地测量曲率半径**，不能用「1° ≈ 111320 m」这个常数：
 * 在纬度 1.18° 处，子午圈（纬度方向）每度只有 **110,577 m**，
 * 用 111,320 会让面积系统性偏大 **+0.67%**（实测 TS 合计比 Python/UTM 大 0.75%）。
 */
const A_WGS84 = 6378137.0
const E2_WGS84 = 0.00669437999014

export function metersPerDeg(latDeg: number): { x: number; y: number } {
  const phi = (latDeg * Math.PI) / 180
  const sin2 = Math.sin(phi) * Math.sin(phi)
  const denom = 1 - E2_WGS84 * sin2
  // 子午圈曲率半径 M（纬度方向）；卯酉圈曲率半径 N（经度方向）
  const m = (A_WGS84 * (1 - E2_WGS84)) / Math.pow(denom, 1.5)
  const n = A_WGS84 / Math.sqrt(denom)
  const k = Math.PI / 180
  return { y: m * k, x: n * Math.cos(phi) * k }
}

/** 经纬度 → 以 (lon0, lat0) 为原点的局部米制坐标 */
export function toLocalM(p: Position, lon0: number, lat0: number): [number, number] {
  const { x: mx, y: my } = metersPerDeg(lat0)
  return [(p[0] - lon0) * mx, (p[1] - lat0) * my]
}

/** 鞋带公式：单个环的面积（m²，绝对值） */
function ringAreaM2(ring: Position[], lon0: number, lat0: number): number {
  let s = 0
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = toLocalM(ring[i], lon0, lat0)
    const [x2, y2] = toLocalM(ring[(i + 1) % n], lon0, lat0)
    s += x1 * y2 - x2 * y1
  }
  return Math.abs(s) / 2
}

/** 取几何体第一个坐标作为局部原点（避免为每个环单独算原点导致面积不可加） */
export function geometryOrigin(geom: GapGeometry): Position {
  const first = geom.type === 'Polygon' ? geom.coordinates[0][0] : geom.coordinates[0][0][0]
  return first
}

/** 多边形面积（m²）：外环减内环 */
export function polygonAreaM2(geom: GapGeometry): number {
  const [lon0, lat0] = geometryOrigin(geom)
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates
    return (
      ringAreaM2(rings[0], lon0, lat0) -
      rings.slice(1).reduce((acc, r) => acc + ringAreaM2(r, lon0, lat0), 0)
    )
  }
  return geom.coordinates.reduce((acc, poly) => {
    const rings = poly
    return (
      acc +
      ringAreaM2(rings[0], lon0, lat0) -
      rings.slice(1).reduce((a, r) => a + ringAreaM2(r, lon0, lat0), 0)
    )
  }, 0)
}

/** 面积加权质心（经纬度）。环按有向面积加权，洞（反向环绕）自然被减去。 */
export function centroid(geom: GapGeometry): Position {
  const rings: Position[][] = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat()
  let totalA = 0
  let cx = 0
  let cy = 0
  for (const ring of rings) {
    let a2 = 0 // 二倍有向面积
    let sx = 0
    let sy = 0
    for (let i = 0, n = ring.length; i < n; i++) {
      const [x1, y1] = ring[i]
      const [x2, y2] = ring[(i + 1) % n]
      const cross = x1 * y2 - x2 * y1
      a2 += cross
      sx += (x1 + x2) * cross
      sy += (y1 + y2) * cross
    }
    if (Math.abs(a2) < 1e-18) continue
    const a = a2 / 2
    totalA += a
    cx += (sx / (3 * a2)) * a
    cy += (sy / (3 * a2)) * a
  }
  if (Math.abs(totalA) < 1e-18) {
    return rings[0]?.[0] ?? [0, 0]
  }
  return [cx / totalA, cy / totalA]
}

/** 射线法：点是否在单个环内 */
function pointInRing(pt: Position, ring: Position[]): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const intersects = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

function pointInPolygonRings(pt: Position, rings: Position[][]): boolean {
  if (!pointInRing(pt, rings[0])) return false
  return !rings.slice(1).some((hole) => pointInRing(pt, hole))
}

export function pointInGeometry(pt: Position, geom: GapGeometry): boolean {
  if (geom.type === 'Polygon') return pointInPolygonRings(pt, geom.coordinates)
  return geom.coordinates.some((poly) => pointInPolygonRings(pt, poly))
}

/** 点到线段的距离（局部米制） */
function distPointSegM(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1])
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** 点到多边形边界的最短距离（m）—— 用于「安全退让」判定 */
export function distToBoundaryM(pt: Position, geom: GapGeometry): number {
  const rings: Position[][] = geom.type === 'Polygon' ? geom.coordinates : geom.coordinates.flat()
  const [lon0, lat0] = pt
  const p = toLocalM(pt, lon0, lat0)
  let best = Infinity
  for (const ring of rings) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = toLocalM(ring[i], lon0, lat0)
      const b = toLocalM(ring[(i + 1) % n], lon0, lat0)
      const d = distPointSegM(p, a, b)
      if (d < best) best = d
    }
  }
  return best
}

export function geomEquals(a: GapGeometry, b: GapGeometry): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export type { GapGeometry, MultiPolygonGeometry, PolygonGeometry, Position }
