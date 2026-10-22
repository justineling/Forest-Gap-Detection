/**
 * 「空响应不得覆盖已有结果」的单元测试（Node 直跑）。
 *
 * 这一条是**数据安全底线**，不是体验优化：
 *
 * 检测完成后 `loadGaps({rerun:true})` 会调 `applyRerun(feats, 'keep_manual')`，
 * 而 `mergeManualEdits` 以新结果为主体、只把人工新增/改判/删除重放上去。
 * 所以 `applyRerun([])` 会把当前 1,762 块算法要素**全部丢掉**，只留人工新增的
 * 那几块，还会在日志里写"算法要素 0 · 合计 N"，看起来像一次正常合并 ——
 * 用户看到的是"检测跑完了，结果没了"。
 *
 * 判据（详见 src/lib/gapsLoad.ts）：
 *   有数据 → 用；空 + 现有非空 → 只有"算法自报 0 块"才允许清空；
 *   其余一律保留现有结果并报错。误报一次"读不到"可以重试，误清一次数据找不回来。
 */
import {
  decideGapsLoad,
  shouldClearGapsOnImageChange,
  SUSPECT_EMPTY_DETAIL,
} from '../src/lib/gapsLoad'
import { useAppStore } from '../src/store/useAppStore'
import type { GapFeature } from '../src/types'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

// ---------- A. 有数据：照常应用 ----------
console.log('\nA. 有数据就应用（不被 error 干扰）')
{
  const d = decideGapsLoad({ incoming: 1762, existing: 0, reported: 1762 })
  check(d.action === 'apply' && d.reason === 'normal', '首次载入 1,762 块 → apply')

  const d2 = decideGapsLoad({ incoming: 1762, existing: 1762, reported: 1762 })
  check(d2.action === 'apply', '重跑拿到同样多的结果 → apply（正常刷新）')

  // 有数据时哪怕带了警告类 error，也应该用数据
  const d3 = decideGapsLoad({ incoming: 5, existing: 1762, reported: 5, error: '只读到部分结果' })
  check(d3.action === 'apply', '有要素 + 带 error → 仍然 apply（有数据就用数据）')
}

// ---------- B. ★ 空响应不得清空现有结果 ----------
console.log('\nB. ★ 空响应 + 现有结果非空 → 一律保留（核心断言）')
{
  // 最危险的形态：/gaps 返回空集合、没有任何 error（正在写盘 / 损坏）
  const d = decideGapsLoad({ incoming: 0, existing: 1762, reported: null })
  check(
    d.action === 'keep',
    '★ 空响应（无 error）+ 现有 1,762 块 → keep（绝不 applyRerun([])）',
    `${d.action}/${d.reason}`,
  )
  check(d.action === 'keep' && d.reason === 'suspect_empty', '原因是 suspect_empty')
  check(
    d.action === 'keep' && d.detail === SUSPECT_EMPTY_DETAIL,
    '兜底说明写清楚"可能是还在写盘或文件损坏"',
    d.action === 'keep' ? d.detail : '',
  )

  // 实测 bug 的形态：算法自报 1,762 块，但 /gaps 给回 0 块
  const d2 = decideGapsLoad({ incoming: 0, existing: 1762, reported: 1762 })
  check(
    d2.action === 'keep',
    '★ 算法自报 1,762 块但读到 0 块 → keep（这就是实测那个 bug 的形态）',
    `${d2.action}/${d2.reason}`,
  )

  // 文件没找到：后端明说原因，直接透传
  const d3 = decideGapsLoad({
    incoming: 0,
    existing: 1762,
    reported: null,
    error: '未找到检测结果文件（已查找：D:/fgd/data/output）',
  })
  check(d3.action === 'keep' && d3.reason === 'missing_file', '空 + error + 现有结果 → keep/missing_file')
  check(
    d3.action === 'keep' && d3.detail.includes('已查找'),
    'error 原文透传（用户要知道去哪个目录找）',
    d3.action === 'keep' ? d3.detail : '',
  )
}

// ---------- C. 算法真的没找到空地：允许清空 ----------
console.log('\nC. 只有"算法自报 0 块"才允许清空')
{
  const d = decideGapsLoad({ incoming: 0, existing: 1762, reported: 0 })
  check(
    d.action === 'apply' && d.reason === 'confirmed_empty',
    '算法自报 0 块 + 读到 0 块 → apply（真的没有空地，界面就该是 0）',
    `${d.action}/${d.reason}`,
  )

  // reported 是 0，但 /gaps 给了数据 → 有数据就用数据（不要自作聪明丢掉）
  const d2 = decideGapsLoad({ incoming: 12, existing: 0, reported: 0 })
  check(d2.action === 'apply', 'reported=0 但有 12 块 → 仍然 apply')
}

// ---------- D. 首次打开（现有结果本来就是空）----------
console.log('\nD. 现有结果为空的边界（没有东西可保护）')
{
  const d = decideGapsLoad({ incoming: 0, existing: 0, reported: null })
  check(
    d.action === 'apply' && d.reason === 'empty_state',
    '首次打开 + 空 + 无 error → apply（setGaps([]) 无副作用，保持原行为）',
  )

  const d2 = decideGapsLoad({ incoming: 0, existing: 0, reported: null, error: '未找到检测结果文件' })
  check(
    d2.action === 'apply' && d2.reason === 'empty_state',
    '首次打开 + 空 + error → apply（“没找到结果文件”是正常状态，不该弹窗）',
  )
}

// ---------- E. reported 的语义：null ≠ 0 ----------
console.log('\nE. 「没收到 sidecar 报告」不能当成「算法说 0 块」')
{
  const noReport = decideGapsLoad({ incoming: 0, existing: 500, reported: null })
  const reportZero = decideGapsLoad({ incoming: 0, existing: 500, reported: 0 })
  check(noReport.action === 'keep', 'reported=null → 保留（保守）')
  check(reportZero.action === 'apply', 'reported=0 → 清空（有据）')
  check(
    noReport.action !== reportZero.action,
    '★ 两种语义必须区分开（否则"没收到报告"会静默清空数据）',
  )
}

// ---------- F. 空字符串 error 视作没有 ----------
console.log('\nF. 脏输入：空字符串 error')
{
  const d = decideGapsLoad({ incoming: 0, existing: 10, reported: null, error: '' })
  check(d.action === 'keep' && d.reason === 'suspect_empty', 'error="" → 当没有 error（suspect_empty）')
  check(d.action === 'keep' && d.detail === SUSPECT_EMPTY_DETAIL, 'detail 用兜底说明')
}

// ---------- G. 后果验证：applyRerun([]) 确实会清空 ----------
console.log('\nG. 后果验证：applyRerun([]) 真的会清空（所以 B 段的 keep 是必须的）')
{
  /** 造一个最小要素（几何/属性对"清空"这件事无意义） */
  const feat = (id: string): GapFeature => ({
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [0, 0],
          [0, 0.001],
          [0.001, 0.001],
          [0, 0],
        ],
      ],
    },
    properties: { gap_id: id, class: 'open_patch' } as never,
  })

  // 模拟"界面上已经有 3 块真实结果"
  useAppStore.getState().setGaps([feat('a'), feat('b'), feat('c')], null)
  check(useAppStore.getState().gaps.length === 3, '准备：现有 3 块结果')

  const d = decideGapsLoad({ incoming: 0, existing: 3, reported: 3 })
  check(d.action === 'keep', '★ 这种响应被判为 keep → App 不会调用 applyRerun')

  // 反证：如果（错误地）照旧调用 applyRerun([])，现有结果会被清空 ——
  // 这正是本用例要拦住的那条路径
  useAppStore.getState().applyRerun([], 'keep_manual')
  check(
    useAppStore.getState().gaps.length === 0,
    '反证：applyRerun([]) 把 3 块清成 0（必须拦住，否则就是"检测跑完结果没了"）',
  )
}

// ---------- H. 换影像后是否清空旧结果 ----------
//
// 这一条守的是 2026-10-21 的另一个事故：换影像后旧结果还挂在 store 里，
// `workflow.loaded` 仍为 true，界面直接跳到「复核结果」并弹"结果没读到"。
// 四个分支都要判 —— 判错方向的后果是"重选同一张影像把现有结果抹了"。
console.log('\nH. 换影像才清空旧结果（重选同一张不能抹）')
{
  const a = 'D:/data/A.tif'
  const b = 'D:/data/B.tif'

  check(shouldClearGapsOnImageChange(b, a), '换新影像 → true（必须清空旧结果）')
  check(!shouldClearGapsOnImageChange(a, a), '★ 同一张影像 → false（重选不该抹掉现有结果）')
  check(!shouldClearGapsOnImageChange('', a), '空字符串 → false（没选到文件就不动）')
  check(
    shouldClearGapsOnImageChange(a, undefined),
    '首次选择（prev 为 undefined）→ true（可能残留上一次会话的结果）',
  )
  // 引导页取消 / 只换结果文件时 st.image 仍是旧值 → 不能清空
  check(
    !shouldClearGapsOnImageChange(a, a),
    '★ 只换结果文件、影像没变 → false（否则刚选的结果立刻被清掉）',
  )
}

// ---------- 汇总 ----------
console.log()
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
