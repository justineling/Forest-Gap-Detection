/**
 * 几何工具的数值回归（`lib/geometry.ts` + `estimate` 里依赖它的两条规则）。
 *
 * 全部用合成几何，**放在真实园区的经纬度上**（111.2°E, 1.18°N）——
 * 2026-11-03 的质心 bug 只在"坐标绝对值大、多边形小"时出现，
 * 放在 (0,0) 附近的测试数据永远测不出来。
 *
 * 跑法：npm test（见 package.json）
 */
import { centroid, insidePoint, interiorPoint, metersPerDeg, pointInGeometry } from '../src/lib/geometry'
import { estimate } from '../src/lib/estimate'
import type { GapFeature, GapGeometry, Position } from '../src/types'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

const LON0 = 111.2039
const LAT0 = 1.1838
const { x: MX, y: MY } = metersPerDeg(LAT0)
/** 以园区中心为原点的米制坐标 → 经纬度 */
const ll = (xm: number, ym: number): Position => [LON0 + xm / MX, LAT0 + ym / MY]
const ring = (pts: Array<[number, number]>): Position[] => {
  const r = pts.map(([x, y]) => ll(x, y))
  return [...r, r[0]]
}
const distM = (a: Position, b: Position): number => Math.hypot((a[0] - b[0]) * MX, (a[1] - b[1]) * MY)

function feat(id: string, geometry: GapGeometry, cls: GapFeature['properties']['class']): GapFeature {
  return { type: 'Feature', geometry, properties: { gap_id: id, class: cls, area_sqm: 0 } as never }
}

// ---------- A. 质心精度（大坐标 + 小多边形）----------
console.log('A. 质心在真实经纬度上的精度')
{
  // 8 m × 8 m 的株位空缺，中心在 (100, 50) m
  const sq: GapGeometry = { type: 'Polygon', coordinates: [ring([[96, 46], [104, 46], [104, 54], [96, 54]])] }
  const err = distM(centroid(sq), ll(100, 50))
  check(err < 0.01, '★ 8 m 方块的质心误差 < 1 cm', `${(err * 100).toFixed(3)} cm（旧实现在真实数据上 P50 17 m）`)

  // 带洞：外 20 m 方块，洞偏在右上 —— 质心应向左下偏
  const holed: GapGeometry = {
    type: 'Polygon',
    coordinates: [
      ring([[0, 0], [20, 0], [20, 20], [0, 20]]),
      ring([[12, 12], [18, 12], [18, 18], [12, 18]]).reverse(),
    ],
  }
  const c = centroid(holed)
  // 解析解：(400·10 − 36·15) / 364 = 9.505
  const want = ll(9.5055, 9.5055)
  check(distM(c, want) < 0.01, '带洞多边形：洞被减去（解析解 9.505 m）', `${distM(c, want).toFixed(4)} m`)
}

// ---------- B. 面内点 ----------
console.log('\nB. 面内点（凹形 / 环形）')
{
  // U 形：质心落在开口里（面外）
  const u: GapGeometry = {
    type: 'Polygon',
    coordinates: [ring([[0, 0], [12, 0], [12, 12], [8, 12], [8, 3], [4, 3], [4, 12], [0, 12]])],
  }
  check(!pointInGeometry(centroid(u), u), '前提：U 形的质心在面外', '')
  check(pointInGeometry(interiorPoint(u), u), '★ interiorPoint 落在 U 形内', '')
  check(pointInGeometry(insidePoint(u), u), '★ insidePoint 落在 U 形内', '')

  // 环形：质心正好在洞里
  const donut: GapGeometry = {
    type: 'Polygon',
    coordinates: [ring([[0, 0], [10, 0], [10, 10], [0, 10]]), ring([[3, 3], [7, 3], [7, 7], [3, 7]]).reverse()],
  }
  check(!pointInGeometry(centroid(donut), donut), '前提：环形的质心在洞里', '')
  check(pointInGeometry(insidePoint(donut), donut), '★ insidePoint 不落在洞里', '')

  // 凸形不受影响：质心在内 → 原样返回质心
  const sq: GapGeometry = { type: 'Polygon', coordinates: [ring([[0, 0], [6, 0], [6, 6], [0, 6]])] }
  check(distM(insidePoint(sq), centroid(sq)) < 1e-6, '凸形：insidePoint = 质心（不改变常规行为）', '')
}

// ---------- C. estimate 依赖的两条规则 ----------
console.log('\nC. 估算：株位点落在面内 + MultiPolygon 不漏块')
{
  const u: GapGeometry = {
    type: 'Polygon',
    coordinates: [ring([[0, 0], [12, 0], [12, 12], [8, 12], [8, 3], [4, 3], [4, 12], [0, 12]])],
  }
  const r = estimate([feat('S1', u, 'vacant_slot')], { origin: ll(0, 0) })
  const p = r.points[0]
  check(r.by_grid === 1 && pointInGeometry([p.lon, p.lat], u), '★ U 形株位空缺：1 株，点位在面内', '')

  // 两块相距 200 m 的 40 m 方块。旧实现只用第一块的外接框 → 第二块 0 株
  const a = ring([[0, 0], [40, 0], [40, 40], [0, 40]])
  const b = ring([[200, 0], [240, 0], [240, 40], [200, 40]])
  const opts = { origin: ll(0, 0), clearance_m: 0.5 }
  const nA = estimate([feat('A', { type: 'Polygon', coordinates: [a] }, 'open_patch')], opts).by_grid
  const nB = estimate([feat('B', { type: 'Polygon', coordinates: [b] }, 'open_patch')], opts).by_grid
  const nM = estimate([feat('M', { type: 'MultiPolygon', coordinates: [[a], [b]] }, 'open_patch')], opts).by_grid
  check(nA > 0 && nB > 0, '前提：两块各自都能排出点', `A ${nA} · B ${nB}`)
  check(nM === nA + nB, '★ MultiPolygon 排坑 = 两块之和（不再漏第二块）', `${nM} vs ${nA}+${nB}`)
}

// ---------- D. 质心不依赖环的绕向（2026-11-03 复审） ----------
// 本项目算法产出的绕向是规范的（外环逆时针、洞顺时针），但别的工具导出的 GeoJSON、
// Terra Draw 随手画的多边形不保证。GEOS / shapely 按"第几个环"定角色、不看绕向 —— 前端也必须如此。
console.log('\nD. 质心不依赖绕向')
{
  // 两块相同的 10 m 方块，第二块顺时针：旧实现有向面积几乎抵消 → 质心飞到 6e11 m 外
  const a = ring([[0, 0], [10, 0], [10, 10], [0, 10]])
  const b = ring([[20, 0], [30, 0], [30, 10], [20, 10]]).reverse()
  const multi: GapGeometry = { type: 'MultiPolygon', coordinates: [[a], [b]] }
  const e1 = distM(centroid(multi), ll(15, 5))
  check(e1 < 0.01, '★ 多块绕向不一致的 MultiPolygon：质心 = 两块中点', `${e1.toFixed(4)} m`)

  // 20 m 方块里挖 6 m 洞，洞与外环**同向**：旧实现把洞加上去 → 偏到 (10.41, 10.41)
  const sameWind: GapGeometry = {
    type: 'Polygon',
    coordinates: [ring([[0, 0], [20, 0], [20, 20], [0, 20]]), ring([[12, 12], [18, 12], [18, 18], [12, 18]])],
  }
  const e2 = distM(centroid(sameWind), ll(9.5055, 9.5055))
  check(e2 < 0.01, '★ 洞与外环同向：仍按"洞"减去（解析解 9.505 m）', `${e2.toFixed(4)} m`)

  // 整体顺时针的单块（外环反着画）：结果不该变
  const cw: GapGeometry = { type: 'Polygon', coordinates: [ring([[96, 46], [104, 46], [104, 54], [96, 54]]).reverse()] }
  check(distM(centroid(cw), ll(100, 50)) < 0.01, '外环顺时针画的单块：质心不变')
}

// ---------- E. 每块空地自己的格网相位（2026-11-04） ----------
console.log('\nE. 有 lattice_origin_lonlat 时按空地自己的格网排坑 / 定株位')
{
  const pitch = 8.553
  const row = pitch * Math.sin(Math.PI / 3)
  const az = 58.975
  const th = (az * Math.PI) / 180
  // 局部格网原点：故意与全局原点错开半个株距 —— 全局原点下的格点会落在两行之间
  const localO = ll(3.1, 1.7)
  const node = (i: number, j: number): Position => {
    const along = i * pitch + j * (pitch / 2)
    const x = 3.1 + along * Math.cos(th) - j * row * Math.sin(th)
    const y = 1.7 + along * Math.sin(th) + j * row * Math.cos(th)
    return ll(x, y)
  }
  const onLattice = (p: Position): number => {
    let best = Infinity
    for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) best = Math.min(best, distM(p, node(i, j)))
    return best
  }
  const big: GapGeometry = { type: 'Polygon', coordinates: [ring([[-30, -30], [40, -30], [40, 40], [-30, 40]])] }
  const f = feat('P1', big, 'open_patch')
  f.properties.lattice_origin_lonlat = [localO[0], localO[1]]
  const opts = { origin: ll(0, 0), clearance_m: 0.5, plant_pitch_m: pitch, row_pitch_m: row, azimuth_deg: az, skew_m: pitch / 2 }
  const r = estimate([f], opts)
  const worst = Math.max(...r.points.map((p) => onLattice([p.lon, p.lat])))
  check(r.points.length > 20 && worst < 0.01, '★ 排坑点全部落在这块空地自己的格网上', `${r.points.length} 点，最大偏差 ${(worst * 100).toFixed(2)} cm`)

  // 株位空缺：面内点不在格点上 → 吸附到落在空地里的最近格点（缺的那棵树原来的位置）
  const n0 = node(2, 1)
  const toM = (p: Position): [number, number] => [(p[0] - LON0) * MX, (p[1] - LAT0) * MY]
  const [cx, cy] = toM(n0)
  const slot: GapGeometry = { type: 'Polygon', coordinates: [ring([[cx - 2.5, cy - 1.8], [cx + 3.3, cy - 1.8], [cx + 3.3, cy + 2.9], [cx - 2.5, cy + 2.9]])] }
  const s = feat('S1', slot, 'vacant_slot')
  s.properties.lattice_origin_lonlat = [localO[0], localO[1]]
  const rs = estimate([s], opts)
  const p = rs.points[0]
  check(rs.by_grid === 1 && distM([p.lon, p.lat], n0) < 0.01, '★ 株位点 = 落在空地里的最近格点', `${distM([p.lon, p.lat], n0).toFixed(3)} m`)
  const s2 = feat('S2', slot, 'vacant_slot')
  const r2 = estimate([s2], opts)
  check(distM([r2.points[0].lon, r2.points[0].lat], n0) > 0.3, '对照：没有局部相位时仍取面内点（不吸附到不可信的全局格网）')
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
