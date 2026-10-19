/**
 * `/gaps` 规整逻辑的单元测试（Node 直跑，不依赖浏览器 / 后端）。
 *
 * 重点只有一件事：**`error` 必须透传**。
 *
 * 实测的 bug：检测跑完，`output/wgr17-desktop-gaps.geojson` 里躺着 1,762 个要素，
 * 但界面显示"没有空地"。原因是 `/gaps` 读不到文件时返回
 * `{features: [], error: "未找到检测结果文件…"}`，而 `normalizeCollection`
 * 只取 features / blocks，把 error 丢了 —— "文件没找到"于是退化成了
 * "检测结果就是 0 块"，两种完全不同的状况在界面上长得一模一样。
 *
 * 另外守住"扁平化"这个老坑：正式 schema 是 `blocks[].gaps`，没有顶层 features。
 */
import { normalizeCollection } from '../src/api/backend'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 造一个最小可用的要素（只带 id，几何/属性对规整逻辑无意义） */
function feat(id: string): any {
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1], [1, 1], [0, 0]]] },
    properties: { gap_id: id, class: 'open_patch' },
  }
}

// ---------- A. blocks 结构扁平化 ----------
console.log('\nA. 正式 schema（blocks[].gaps）必须被展平')
{
  const fc = normalizeCollection({
    type: 'FeatureCollection',
    blocks: [
      { block_id: 'b1', gaps: [feat('g1'), feat('g2')] },
      { block_id: 'b2', gaps: [feat('g3')] },
    ],
  })
  check(fc.features.length === 3, '两个 block 的 gaps 合并成 3 个要素', String(fc.features.length))
  check(fc.features[0].properties.gap_id === 'g1', '顺序保持（b1 在前）')
  check(fc.error === undefined, '正常结果不带 error')
}

// ---------- B. 顶层 features 优先 ----------
console.log('\nB. 顶层 features 优先于 blocks')
{
  const fc = normalizeCollection({
    features: [feat('a')],
    blocks: [{ gaps: [feat('x'), feat('y')] }],
  })
  check(fc.features.length === 1, '有顶层 features 时不再展开 blocks', String(fc.features.length))
  check(fc.features[0].properties.gap_id === 'a', '取的是顶层 features')
}

// ---------- C. ★ error 必须保留（本次修复的核心）----------
console.log('\nC. error 透传：区分"没找到文件"与"真的 0 块"')
{
  const fc = normalizeCollection({
    type: 'FeatureCollection',
    features: [],
    error: '未找到检测结果文件（已查找：D:/x/output）',
  })
  check(fc.features.length === 0, '空集合仍是空集合')
  check(
    fc.error === '未找到检测结果文件（已查找：D:/x/output）',
    '★ error 原样保留（否则界面会把"没找到文件"说成"没有空地"）',
    String(fc.error),
  )

  // 带 blocks 但全空、同时有 error：也要保留
  const fc2 = normalizeCollection({ blocks: [], error: '未找到检测结果文件' })
  check(fc2.features.length === 0, 'blocks 为空 → 0 个要素')
  check(fc2.error === '未找到检测结果文件', '★ blocks 分支同样保留 error')

  // 有要素时也保留（防御：后端将来若"部分成功 + 警告"，不要丢信息）
  const fc3 = normalizeCollection({ features: [feat('a')], error: '只读到部分结果' })
  check(fc3.error === '只读到部分结果', '有要素时 error 也不丢')
}

// ---------- D. 真的 0 块：不能伪造 error ----------
console.log('\nD. 没有 error 字段时不能凭空造一个')
{
  const fc = normalizeCollection({ type: 'FeatureCollection', features: [], blocks: [] })
  check(fc.features.length === 0, '空结果')
  check(fc.error === undefined, '★ 没有 error 就是 undefined（"真的没有空地"要照实说）')
}

// ---------- E. 脏输入不能抛错 ----------
console.log('\nE. 脏输入（后端未就绪 / 空响应）不能抛错')
{
  const a = normalizeCollection(null)
  check(a.features.length === 0 && a.type === 'FeatureCollection', 'null → 空集合')
  const b = normalizeCollection(undefined)
  check(b.features.length === 0, 'undefined → 空集合')
  const c = normalizeCollection({ blocks: [{}, { gaps: null }] } as any)
  check(c.features.length === 0, 'blocks 里缺 gaps 字段也不炸')
  const d = normalizeCollection({ error: '' })
  check(d.error === undefined, '空字符串 error 视作没有 error')
}

// ---------- F. planting_grid 透传 ----------
console.log('\nF. planting_grid 必须跟着走（否则前端估算相位不可复现）')
{
  const grid = {
    plant_pitch_m: 8.6,
    row_pitch_m: 9.1,
    row_azimuth_deg: 12.5,
    origin_x_m: 500000,
    origin_y_m: 300000,
  }
  const fc = normalizeCollection({ blocks: [{ gaps: [feat('g1')] }], planting_grid: grid } as any)
  check(fc.planting_grid?.plant_pitch_m === 8.6, '网格模型保留')
  const fc2 = normalizeCollection({ features: [feat('g1')], planting_grid: grid })
  check(fc2.planting_grid?.row_pitch_m === 9.1, 'features 分支也保留网格')
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
