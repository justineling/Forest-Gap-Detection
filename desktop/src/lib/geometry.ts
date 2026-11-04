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

/**
 * 面积加权质心（经纬度）。外环加、洞减。
 *
 * ⚠️ 必须先平移到**局部原点**（第一个顶点）再算叉积（2026-11-03 修）：
 *    直接用经纬度绝对值时，`x1*y2 - x2*y1` 是两个 ≈131（111.2° × 1.18°）的大数相减，
 *    而一块 10 m 的株位空缺二倍面积只有 ~1e-8 度² —— 有效数字被抵消殆尽。
 *    实测（1,726 块真实结果）：旧实现的质心误差 **P50 17 m / 最大 112 m**，
 *    253 块株位空缺里 225 块的"株位点"落在多边形外；平移后与 shapely 逐块一致。
 *
 * ⚠️ 外环 / 洞按**第几个环**定，不按绕向定（同日复审补，与 GEOS Centroid 一致）：
 *    把所有环摊平后直接累加有向面积，只在"外环逆时针、洞顺时针"时才对。
 *    本项目算法产出守这个约定，但别的工具导出的 GeoJSON、手画的多边形不保证 ——
 *    两块绕向相反的 MultiPolygon 会让面积几乎抵消，质心飞到 1e17 m 外。
 */
export function centroid(geom: GapGeometry): Position {
  const polys: Position[][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  const [ox, oy] = polys[0]?.[0]?.[0] ?? [0, 0]
  let a2 = 0 // 二倍面积（外环为正、洞为负，与绕向无关）
  let sx = 0
  let sy = 0
  for (const rings of polys) {
    rings.forEach((ring, k) => {
      let ra2 = 0
      let rsx = 0
      let rsy = 0
      for (let i = 0, n = ring.length; i < n; i++) {
        const x1 = ring[i][0] - ox
        const y1 = ring[i][1] - oy
        const x2 = ring[(i + 1) % n][0] - ox
        const y2 = ring[(i + 1) % n][1] - oy
        const cross = x1 * y2 - x2 * y1
        ra2 += cross
        rsx += (x1 + x2) * cross
        rsy += (y1 + y2) * cross
      }
      // 把这个环的贡献翻成"外环正、洞负"：sign(ra2) 抵掉绕向，(k === 0 ? 1 : -1) 给出角色
      const w = (k === 0 ? 1 : -1) * Math.sign(ra2)
      a2 += w * ra2
      sx += w * rsx
      sy += w * rsy
    })
  }
  if (Math.abs(a2) < 1e-24) {
    return polys[0]?.[0]?.[0] ?? [0, 0]
  }
  return [ox + sx / (3 * a2), oy + sy / (3 * a2)]
}

/**
 * 保证落在多边形**内部**的一个点（与 shapely `representative_point()` 同一思路）。
 *
 * 做法（GEOS InteriorPointArea）：取外接框中线附近、**不经过任何顶点**的一条水平扫描线，
 * 求它与所有环（含洞）的交点，排序后两两成对就是"在面内"的区间，取最宽区间的中点。
 *
 * 为什么需要：质心对凹形 / 带洞多边形会落在外面 —— 实测 253 块株位空缺里有 24 块
 * （U 形、环形缺口）。Python 侧 `planting_points.py` 早就用 representative_point 兜底，
 * 前端没有，于是地图上的株位点与交付包对不上。
 */
export function interiorPoint(geom: GapGeometry): Position {
  const polys: Position[][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates
  let best: { w: number; pt: Position } | null = null
  for (const rings of polys) {
    const outer = rings[0]
    if (!outer || outer.length < 3) continue
    let y0 = Infinity
    let y1 = -Infinity
    for (const [, y] of outer) {
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    // 扫描线 y：取中线上下最近两个顶点 y 的中值 —— 恰好压在顶点上时交点会重复计数
    const mid = (y0 + y1) / 2
    let below = y0
    let above = y1
    for (const ring of rings) {
      for (const [, y] of ring) {
        if (y <= mid && y > below) below = y
        if (y > mid && y < above) above = y
      }
    }
    const scanY = (below + above) / 2
    const xs: number[] = []
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const [xa, ya] = ring[i]
        const [xb, yb] = ring[(i + 1) % n]
        if (ya > scanY !== yb > scanY) xs.push(xa + ((scanY - ya) * (xb - xa)) / (yb - ya))
      }
    }
    xs.sort((a, b) => a - b)
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const w = xs[i + 1] - xs[i]
      if (!best || w > best.w) best = { w, pt: [(xs[i] + xs[i + 1]) / 2, scanY] }
    }
  }
  return best ? best.pt : centroid(geom)
}

/** 质心在面内就用质心，否则退回 `interiorPoint` —— 与 Python 侧 `_slot_point` 同一规则 */
export function insidePoint(geom: GapGeometry): Position {
  const c = centroid(geom)
  return pointInGeometry(c, geom) ? c : interiorPoint(geom)
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
