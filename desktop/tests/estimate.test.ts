/**
 * 估算模块验证 / 回归测试（Node 直跑，不经浏览器）。
 *
 * 覆盖：
 *  A. 面积计算 vs Python/UTM 的一致性
 *  B. 双口径估算在真实结果上的表现
 *  C. 点位自检（落在多边形内、退让满足、株位标记豁免）
 *  D. 退让距离敏感度（业务拍板依据）
 *  E. 分类别拆分（验证"按类别分口径"规则）
 *
 * 跑法：npm test（见 package.json）
 *
 * 数据：默认读 output/wgr17-final-gaps.geojson（真实结果）。
 * 该文件不入库（output/ 走 Google Drive），缺失时自动跳过并说明。
 */import { existsSync, readFileSync } from 'node:fs'
import { estimate, SINGLE_TREE_AREA_M2, DEFAULT_GRID } from '../src/lib/estimate'
import { polygonAreaM2 } from '../src/lib/geometry'
import type { GapFeature } from '../src/types'

/** 结果文件在仓库根，而 npm script 的 cwd 是 desktop/ —— 两个位置都试 */
const GAPS_CANDIDATES = ['output/wgr17-final-gaps.geojson', '../output/wgr17-final-gaps.geojson']
const GAPS_FILE = GAPS_CANDIDATES.find((p) => existsSync(p))

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

if (!GAPS_FILE) {
  console.log(`⚠️  跳过：找不到检测结果（试过 ${GAPS_CANDIDATES.join(' / ')}）`)
  console.log('   （output/ 不入库，需先跑 scripts/process_image.py 生成结果）')
  process.exit(0)
}

const raw = JSON.parse(readFileSync(GAPS_FILE, 'utf8')) as {
  blocks?: Array<{ gaps: GapFeature[] }>
  summary?: Record<string, number>
}
const features: GapFeature[] = []
for (const b of raw.blocks ?? []) features.push(...b.gaps)
console.log(`\n载入要素 ${features.length} 个（${GAPS_FILE}）\n`)

// ---------- A. 面积一致性 ----------
console.log('A. 面积计算 vs Python/UTM')
let maxRelErr = 0
let sumTs = 0
let sumPy = 0
for (const f of features) {
  const ts = polygonAreaM2(f.geometry)
  const py = f.properties.area_sqm ?? 0
  sumTs += ts
  sumPy += py
  if (py > 50) maxRelErr = Math.max(maxRelErr, Math.abs(ts - py) / py)
}
check(
  maxRelErr < 0.02,
  '单块面积最大相对误差 < 2%',
  `实测 ${(maxRelErr * 100).toFixed(2)}%（TS 合计 ${Math.round(sumTs).toLocaleString()} vs Python ${Math.round(sumPy).toLocaleString()} m²）`,
)

// ---------- B. 双口径估算 ----------
console.log(`\nB. 双口径估算（默认退让 ${DEFAULT_GRID.clearance_m} m）`)
const t0 = Date.now()
const res = estimate(features)
const ms = Date.now() - t0
check(res.by_grid > 0, '排坑口径 > 0', `${res.by_grid} 株`)
check(res.by_area > 0, '面积口径 > 0', `${res.by_area} 株`)
check(
  res.points.length === res.by_grid,
  '点位数量等于排坑计数',
  `${res.points.length} 个`,
)
// 排坑口径必须 <= 面积口径（几何约束比面积约束更严）
check(
  res.by_grid <= res.by_area,
  '排坑口径 <= 面积口径（几何更严）',
  `${res.by_grid} <= ${res.by_area}`,
)
check(ms < 5000, '单次估算 < 5 s', `${ms} ms`)
console.log(
  `        参与面积 ${res.area_sqm.toLocaleString()} m² · ` +
    `面积口径 ${res.by_area} · 排坑口径 ${res.by_grid} · 差异 ${res.divergence_pct}%`,
)

// 参与面积应与 summary 的"确定需补种"一致
const definite = raw.summary?.plantable_area_definite_sqm
if (definite) {
  const rel = Math.abs(res.area_sqm - definite) / definite
  check(
    rel < 0.02,
    '参与面积与 summary.plantable_area_definite_sqm 一致',
    `TS ${res.area_sqm.toLocaleString()} vs summary ${definite.toLocaleString()}（差 ${(rel * 100).toFixed(2)}%）`,
  )
}

// ---------- C. 点位自检 ----------
console.log('\nC. 点位自检')
let outside = 0
let tooClose = 0
let slotPts = 0
for (const p of res.points) {
  const f = features.find((x) => x.properties.gap_id === p.gap_id)
  if (!f) {
    outside++
    continue
  }
  // vacant_slot 的点位是"质心标记"（规则＝每块 1 株），不适用退让检查
  if (f.properties.class === 'vacant_slot') {
    slotPts++
    continue
  }
  if (p.edge_dist_m < res.grid.clearance_m - 1e-6) tooClose++
}
check(outside === 0, '所有点位都能找到所属多边形', `越界 ${outside}`)
check(tooClose === 0, '网格点位满足退让距离', `不足 ${tooClose}`)
console.log(`        （其中株位标记 ${slotPts} 个，不适用退让）`)

// ---------- D. 退让敏感度 ----------
console.log('\nD. 退让距离敏感度（业务拍板依据）')
const sens: Array<[number, number]> = []
for (const clr of [0.5, 1.0, 1.5, 2.0, 2.5, 3.0]) {
  const r = estimate(features, { clearance_m: clr })
  sens.push([clr, r.by_grid])
  console.log(`        退让 ${clr.toFixed(1)} m → ${String(r.by_grid).padStart(5)} 株`)
}
// 单调性：退让越大，能放的株数不应增加
let monotonic = true
for (let i = 1; i < sens.length; i++) {
  if (sens[i][1] > sens[i - 1][1]) monotonic = false
}
check(monotonic, '株数随退让单调不增', '')

// ---------- E. 分类别拆分 ----------
console.log('\nE. 分类别（验证"按类别分口径"规则）')
const byCls = new Map<string, { n: number; area: number; a: number; b: number }>()
for (const r of res.per_gap) {
  const cur = byCls.get(r.class) ?? { n: 0, area: 0, a: 0, b: 0 }
  cur.n += 1
  cur.area += r.area_sqm
  cur.a += r.by_area
  cur.b += r.by_grid
  byCls.set(r.class, cur)
}
for (const [cls, v] of byCls) {
  const d = v.a > 0 ? (((v.b - v.a) / v.a) * 100).toFixed(1) : '—'
  console.log(
    `        ${cls.padEnd(14)} 块数 ${String(v.n).padStart(4)}  ` +
      `面积 ${Math.round(v.area).toLocaleString().padStart(10)} m²  ` +
      `面积口径 ${String(v.a).padStart(5)}  排坑 ${String(v.b).padStart(5)}  ${d}%`,
  )
}
const slot = byCls.get('vacant_slot')
if (slot) {
  // 核心不变量：株位空缺两个口径都必须等于块数（每块 1 株）
  check(
    slot.a === slot.n && slot.b === slot.n,
    'vacant_slot：两个口径都等于块数（每块 1 株）',
    `块数 ${slot.n} · 面积口径 ${slot.a} · 排坑 ${slot.b}`,
  )
}

// ---------- 汇总 ----------
console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}`)
if (failures === 0) {
  console.log(
    `\n参考值（供人工核对）：面积折算 ${res.by_area} 株 ≈ ` +
      `${Math.floor((definite ?? 0) / SINGLE_TREE_AREA_M2)} 株（summary 口径）`,
  )
}
process.exit(failures === 0 ? 0 : 1)
