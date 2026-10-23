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
  shouldLoadAfterWizard,
  shouldLoadJobResultOnSwitch,
  SUSPECT_EMPTY_DETAIL,
} from '../src/lib/gapsLoad'
import { computeSteps, toInput } from '../src/lib/workflow'
import { useAppStore } from '../src/store/useAppStore'
import type { GapFeature, PolygonGeometry } from '../src/types'

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

// ---------- I. ★ 向导指定了结果文件 → 必须真的载入 ----------
//
// 这一条守的是 2026-10-23 用户实测的 bug：
// 向导第 2 步明确选了 `data/output/wgr17-desktop-gaps.geojson`
//（15,179,448 字节，blocks[0].gaps 共 1,762 个 Polygon，文件完好），
// 提交后地图上**一个多边形都没有** —— 因为 `onWizardDone` 无条件置
// `skipNextLoad = true`，紧接着的 `loadGaps()` 被那道闸门直接 return。
//
// 语义修正：**向导里给了结果文件 ≠ 重新开始**。给了就载入；没给才清空并跳过。
// 保守方向也要守住：参数缺省（旧调用方）必须当作"没给"，不能反过来把
// 用户没指定的文件也载进来。
console.log('\nI. ★ 向导给了结果文件就要载入（不是"重新开始"）')
{
  check(
    shouldLoadAfterWizard({ gapsProvided: true }),
    '★ gapsProvided=true → true（用户指定的文件必须真的载入）',
  )
  check(
    !shouldLoadAfterWizard({ gapsProvided: false }),
    'gapsProvided=false → false（没给结果，沿用"进向导 = 重新开始"）',
  )
  // 旧调用方 / 以后有人忘了传参数：一律按"没给结果"处理（保守）
  check(!shouldLoadAfterWizard(undefined), '参数缺省（undefined）→ false（保守，按重新开始）')
  check(!shouldLoadAfterWizard(), '完全不传参数 → false')
  check(!shouldLoadAfterWizard(null), 'null → false')
  // 脏输入：真值不是布尔 true 的都不该放行
  check(
    !shouldLoadAfterWizard({ gapsProvided: 'true' as unknown as boolean }),
    'gapsProvided 传了字符串 "true" → false（只认严格的 true）',
  )
  // 与"重新开始"分支必须互斥：同一份信息不可能既载入又清空
  const info = { gapsProvided: true }
  check(
    shouldLoadAfterWizard(info) !== shouldLoadAfterWizard({ gapsProvided: false }),
    '★ 两个分支的判定必须相反（否则就是"既清空又载入"或"都不做"）',
  )
}

// ---------- J. ★★ 把「主动选过」与「只是预填」钉死 ----------
//
// 这一组守的是 2026-10-23 的另一半：判据必须传"动作"，不能传"字段非空"。
//
// `WelcomeWizard.tsx` 里结果文件那一栏是
//     const [gaps, setGaps] = useState<string | null>(status.gaps)
// —— **预填上次的路径**。所以用户点「换一张影像」打开向导时，`gaps` 一进来就非空。
// 他只改了 tif、完全没碰结果文件，`!!gaps` 依然是 true。
//
// 如果 `onDone` 传 `{ gapsProvided: !!gaps }`，第一行就会走"载入旧结果" →
// `hasResult` 变 true → 界面又跳第 4 步 —— 正是 `3207e94` 修掉的那个 bug。
// 所以真正的判据是 `gapsPicked`（点了「选择结果文件」并真的选中），
// 下面三条把三种情形逐个钉住（对应 lib/gapsLoad.ts 里 WizardDoneInfo 的表格）。
console.log('\nJ. ★★ 三种情形：主动选过 / 只是预填 / 首次使用')
{
  // 情形 1：只换 tif，结果文件是预填的、没动 → gapsPicked 为 false
  check(
    !shouldLoadAfterWizard({ gapsProvided: false }),
    '★ 预填但未主动选择 → false（那一栏非空，但用户没动过它）',
  )
  // 情形 2：主动点了「选择结果文件」并选中 → gapsPicked 为 true
  check(
    shouldLoadAfterWizard({ gapsProvided: true }),
    '★ 主动点了「选择结果文件」并选中 → true',
  )
  // 情形 3：首次使用，没有预填、也没选 → 与情形 1 同为 false
  check(
    !shouldLoadAfterWizard({ gapsProvided: false }),
    '首次使用、没预填也没选 → false（与"预填未选"同结论）',
  )

  // 情形 1 与情形 2 在"字段非空"这个错误判据下**完全一样**，却要走出相反结论。
  // 这条断言就是把"两者必须能区分"这件事本身钉住 —— 将来若有人把判据简化回
  // `!!gaps`，这两种情形会同时变成 true，这条会红。
  const prefilled = { gapsNonEmpty: true, gapsPicked: false }
  const picked = { gapsNonEmpty: true, gapsPicked: true }
  check(
    prefilled.gapsNonEmpty === picked.gapsNonEmpty &&
      shouldLoadAfterWizard({ gapsProvided: prefilled.gapsPicked }) !==
        shouldLoadAfterWizard({ gapsProvided: picked.gapsPicked }),
    '★ 「预填」与「主动选过」的字段非空状态相同，但判定必须相反（判据只能是动作）',
  )
}

// ---------- K. ★ 向导「重新开始」必须把步骤送回第 2 步 ----------
//
// 守的是 2026-10-24 用户实测的 bug：
//   「我在第三步…点击第一步（选择影像）后，如果是同一个的 tif 并点击重新开始后，
//     直接跳到第三步了。」
//
// 根因不在 workflow.ts 的规则，而在**调用方漏清了一样东西**：
// `onWizardDone` 的"重新开始"分支只做了 `setGaps([])`，没清 roi。
// 而 `isStepDone('range')` 里 `hasRoi` 仍为 true → 第 2 步算"已完成"
// → active 直接落到第 3 步「运行检测」。
//
// 所以这条用**真的 store** 走一遍 App 里那两行（顺序与源码一致），
// 而不是再拼一个纯对象 —— 纯对象测不出"调用方漏了哪一行"。
console.log('\nK. ★ 重新开始 = 清结果 + 清圈选（store 层复现）')
{
  const st = () => useAppStore.getState()
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
  /** 一个假的范围（几何形状对"第几步"无意义） */
  const fakeRoi = (): PolygonGeometry => ({
    type: 'Polygon',
    coordinates: [
      [
        [0, 0],
        [0, 0.002],
        [0.002, 0.002],
        [0, 0],
      ],
    ],
  })
  /** 与 App.tsx 里 `workflowInput` 的拼法逐字段对齐 */
  const wf = () =>
    toInput({
      backendOnline: st().backendOnline,
      gaps: st().gaps,
      hasResult: st().workflow.loaded,
      roi: st().roi,
      detectRunning: st().detect.running,
      detected: st().workflow.detected,
      reviewed: st().workflow.reviewed,
      exported: st().workflow.exported,
      manualAdded: st().manualAdded,
      manualDeleted: st().manualDeleted,
      manualEdited: st().manualEdited,
    })
  const activeKey = () =>
    computeSteps(wf()).find((x) => x.status === 'active')?.key ?? '(无)'

  // 造出"用户停在后面几步、屏幕上还有上一轮结果和圈选"的状态
  st().setBackend({ online: true })
  st().setGaps([feat('a'), feat('b')], null)
  st().setRoi(fakeRoi())
  st().markWorkflow({ detected: true })
  check(st().roi !== null && st().gaps.length === 2, '准备：有圈选 + 2 块旧结果 + 跑过检测')

  // ★ App.onWizardDone 的"重新开始"分支（两行，顺序与源码一致）
  st().setGaps([])
  st().setRoi(null)

  check(st().roi === null, '★ 重新开始后圈选已清除（这一行以前是漏的）')
  check(
    activeKey() === 'range',
    '★ 重新开始后 active 回到第 2 步「确定范围」（不是 detect）',
    activeKey(),
  )

  // 反证：只做第一步（旧代码的行为）→ active 直接跳到第 3 步
  st().setRoi(fakeRoi())
  st().setGaps([feat('c')])
  st().markWorkflow({ detected: true })
  st().setGaps([]) // 只清结果，不清 roi —— 就是那个 bug
  check(
    activeKey() === 'detect',
    '反证：只清结果不清 roi → active = detect（用户看到"直接跳到第三步"）',
    activeKey(),
  )

  // 收尾：把 store 恢复成"干净"状态，免得影响后面（或将来新增）的用例
  st().setRoi(null)
  st().setGaps([])
  st().markWorkflow({ detected: false, reviewed: false, exported: false })
}

// ---------- L. ★ 切换区块后该不该载入新影像自己的结果 ----------
//
// 守的是用户的核心诉求："检测完 block A 再检测 block B，不能清空 A 的数据，
// 切回 A 还能看到 A 的结果"。
//
// 每张影像的结果 / 缓存 / 高度图现在按区块分开存（`output/<区块名>-gaps.geojson`），
// 所以"换影像"有两种完全不同的意图，必须分开：
//   · 从 B 切回 A（A 跑过）→ **载入 A 的结果**（不然用户以为数据丢了）
//   · 又选了同一张影像想重新开始 → 清空、回到第 2 步
//     （2026-10-24 修过的坑：这条如果判成"载入"，界面会立刻跳回第 4 步）
//
// ⚠️ 真正的"哪个文件属于哪张影像"由 Rust 判定（`job_id_for_output` +
//    `resolve_gaps` 的按区块收窄），前端只拿到 `AppStatus.gaps` 这个结果。
//    也就是说本文件测的是"拿到结果之后怎么用"，不是"去哪找文件" ——
//    后者在 Rust 侧有单测（`resolve_gaps_narrows_to_current_job_not_newest`）。
console.log('\nL. ★ 切换区块：换到有结果的影像就载入，其余一律重新开始')
{
  check(
    shouldLoadJobResultOnSwitch({ imageChanged: true, hasResult: true }),
    '★ 从 B 切回 A（A 有结果）→ true（必须载入 A 的结果）',
  )
  check(
    !shouldLoadJobResultOnSwitch({ imageChanged: true, hasResult: false }),
    '换到一张没跑过的影像 → false（重新开始，别把空结果当"载入成功"）',
  )
  check(
    !shouldLoadJobResultOnSwitch({ imageChanged: false, hasResult: true }),
    '★ 又选了同一张影像（想重新开始）→ false（否则直接跳回第 4 步）',
  )
  check(
    !shouldLoadJobResultOnSwitch({ imageChanged: false, hasResult: false }),
    '同一张影像且没有结果 → false',
  )
  // 两个条件的"必要性"：单独任一个为真都不够
  check(
    shouldLoadJobResultOnSwitch({ imageChanged: true, hasResult: true }) &&
      !shouldLoadJobResultOnSwitch({ imageChanged: true, hasResult: false }) &&
      !shouldLoadJobResultOnSwitch({ imageChanged: false, hasResult: true }),
    '★ 只有「影像真的换了」+「新影像自己有结果」同时成立才载入',
  )
  // 脏输入：缺参数 / undefined / 非严格布尔 → 一律不载入（保守）
  check(!shouldLoadJobResultOnSwitch(undefined), '参数缺省 → false')
  check(!shouldLoadJobResultOnSwitch(null), 'null → false')
  check(
    !shouldLoadJobResultOnSwitch({
      imageChanged: 'true' as unknown as boolean,
      hasResult: true,
    }),
    'imageChanged 传字符串 "true" → false（只认严格的 true）',
  )
  // 与"重新开始"分支必须互斥：同一份信息不可能既载入又清空
  const info = { imageChanged: true, hasResult: true }
  check(
    shouldLoadJobResultOnSwitch(info) !== shouldLoadJobResultOnSwitch({ imageChanged: false, hasResult: true }),
    '★ 两个分支的判定必须相反（否则就是"既清空又载入"）',
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
