/**
 * R1 共用夹具对账：前端 `estimate()` vs Python `planting_points`（执行单 R1 验收 2）。
 *
 * 夹具 `tests/fixtures/points-shared.json` 由
 * `scripts/test_shared_points.py` 生成并入库，里面同时有：
 *   · 同一组 GeoJSON（凸形株位 / 凹形株位 / 改判来的株位 / 带洞多边形 / 无局部相位）
 *   · Python 权威点位（UTM + 经纬度）
 *
 * 这里逐块调用 estimate()，要求**点数相等、逐点距离 < 1 cm**。
 * 注意别用"整组一起跑"来比较：跨要素去重是 R3 的范围，整组比较时
 * 两块互相去重会掩盖各自多算 / 少算，逐块才是严格对账。
 *
 * 跑法：npm test（见 package.json）
 */
import { existsSync, readFileSync } from 'node:fs'
import { estimate } from '../src/lib/estimate'
import { metersPerDeg } from '../src/lib/geometry'
import type { GapFeature } from '../src/types'

/** npm script 的 cwd 是 desktop/；CI 里若从别的目录跑，再退一步 */
const FIXTURE_CANDIDATES = [
  'tests/fixtures/points-shared.json',
  '../desktop/tests/fixtures/points-shared.json',
]
const FIXTURE_FILE = FIXTURE_CANDIDATES.find((p) => existsSync(p))

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

interface FixturePoint {
  gap_id: string
  lon: number
  lat: number
  utm_x: number
  utm_y: number
}

interface SharedFixture {
  schema: string
  grid: Record<string, number>
  clearance_m: number
  features: GapFeature[]
  python_points: FixturePoint[]
  /** R3：两套相位的重叠空地（整组一起跑才会走跨要素去重） */
  overlap: {
    features: GapFeature[]
    python_points: FixturePoint[]
  }
}

console.log('\nA. R1 共用夹具：Python / TS 逐点对账')
if (!FIXTURE_FILE) {
  check(false, '夹具文件存在', FIXTURE_CANDIDATES.join(' | '))
} else {
  const fx = JSON.parse(readFileSync(FIXTURE_FILE, 'utf8')) as SharedFixture
  check(fx.schema === 'fgd-points-fixture/1', '夹具 schema 正确', fx.schema)
  check(fx.features.length >= 4, '夹具含至少 4 类空地', `${fx.features.length} 个要素`)

  // 用夹具锚点纬度把经纬度差换成米（两端都在这个尺度上比较）
  const { x: mx, y: my } = metersPerDeg(fx.grid.anchor_lat)
  let grandWorst = 0

  for (const f of fx.features) {
    const gid = f.properties.gap_id as string
    const want = fx.python_points.filter((p) => p.gap_id === gid)
    const res = estimate([f], {
      planting_grid: fx.grid as never,
      clearance_m: fx.clearance_m,
    })
    const got = res.points
    if (got.length !== want.length) {
      check(false, `${gid}：点数相等`, `TS ${got.length} / Python ${want.length}`)
      continue
    }
    // 两端都按 (j, i) 升序枚举格点，顺序本身也应该一致；
    // 仍用逐位配对（比"最近的邻居"更严：多一个点、少一个点都会露馅）
    let worst = 0
    for (let k = 0; k < want.length; k++) {
      const d = Math.hypot(
        (got[k].lon - want[k].lon) * mx,
        (got[k].lat - want[k].lat) * my,
      )
      worst = Math.max(worst, d)
    }
    grandWorst = Math.max(grandWorst, worst)
    check(worst < 0.01, `${gid}：逐点距离 < 1 cm`,
      `${want.length} 点 · 最大 ${(worst * 100).toFixed(3)} cm`)
  }
  console.log(`  · 全夹具最大偏差 ${(grandWorst * 100).toFixed(3)} cm`)

  // ---- B. R3：两套相位的重叠空地，两端必须给同一批点 ----
  console.log('\nB. R3 重叠用例：空间邻近去重 / 优先级 / 点数对账')
  const opts = { planting_grid: fx.grid as never, clearance_m: fx.clearance_m }
  const ovFeatures = fx.overlap?.features ?? []
  const group = estimate(ovFeatures, opts)
  const wantGroup = fx.overlap?.python_points ?? []
  check(group.points.length === wantGroup.length, 'R3 整组点数与 Python 相等',
    `TS ${group.points.length} / Python ${wantGroup.length}`)

  // 未去重的两套点相加必须更多 —— 否则"点数相等"只是两边都没去重
  const separate = ovFeatures.reduce((n, f) => n + estimate([f], opts).points.length, 0)
  check(group.points.length < separate, 'R3 重叠区确实发生了去重',
    `整组 ${group.points.length} < 各自相加 ${separate}`)

  const thr = 0.5 * fx.grid.plant_pitch_m
  let minD = Infinity
  for (let i = 0; i < group.points.length; i++) {
    for (let j = i + 1; j < group.points.length; j++) {
      const a = group.points[i], b = group.points[j]
      minD = Math.min(minD, Math.hypot((a.lon - b.lon) * mx, (a.lat - b.lat) * my))
    }
  }
  check(minD >= thr - 0.01, 'R3 任意两点间距 >= 0.5 × 株距',
    `最小 ${minD.toFixed(3)} m / 门槛 ${thr.toFixed(3)} m`)
  check(group.points.every((p) => ovFeatures.some((f) => f.properties.gap_id === p.gap_id)),
    'R3 保留下来的点仍归属夹具里的要素')

  // 优先级：局部相位（OV-local）必须排在手画（OV-manual）之前被处理，
  // 因此重叠区保留下来的点里应该有 OV-local 的点。
  check(group.points.some((p) => p.gap_id === 'OV-local'),
    'R3 优先级：局部相位的检测空地点被保留')
}

console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
