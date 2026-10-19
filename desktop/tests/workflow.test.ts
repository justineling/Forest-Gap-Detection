/**
 * 工作流状态机测试。
 *
 * 为什么值得单独测：按钮顺序错乱、可选步骤把流程卡死，都是商用软件里
 * 最难被人工发现的一类 bug —— 编译器不报错，界面也不崩，只是"用起来不对劲"。
 */
import { computeSteps, nextAction, isStepDone, toInput, type WorkflowInput } from '../src/lib/workflow'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`  [${ok ? 'OK  ' : 'FAIL'}] ${label}${detail ? '  ·  ' + detail : ''}`)
  if (!ok) failures++
}

/** 全空：刚装完软件 */
const blank: WorkflowInput = {
  hasImage: false,
  hasGaps: false,
  hasResult: false,
  hasRoi: false,
  detectRunning: false,
  detected: false,
  edited: false,
  reviewed: false,
  exported: false,
  gapCount: 0,
}

const withImage: WorkflowInput = { ...blank, hasImage: true }
const withGaps: WorkflowInput = { ...withImage, hasGaps: true, hasResult: true, gapCount: 1726 }

const statusOf = (s: WorkflowInput) =>
  Object.fromEntries(computeSteps(s).map((x) => [x.key, x.status]))

// ---------- A. 步骤状态 ----------
console.log('\nA. 五步状态（①②③④⑤ 顺序与状态）')
{
  const steps = computeSteps(blank)
  check(steps.length === 5, '五步', String(steps.length))
  check(
    steps.map((s) => s.key).join(',') === 'data,range,detect,review,export',
    '顺序固定：选择影像 → 确定范围 → 运行检测 → 复核 → 导出',
    steps.map((s) => s.label).join(' → '),
  )
  check(steps.map((s) => s.no).join('') === '12345', '编号 1~5 连续')

  const st = statusOf(blank)
  check(st.data === 'active' && st.detect === 'todo', '没有影像时：第 1 步 active，其余 todo', JSON.stringify(st))

  const st2 = statusOf(withImage)
  check(st2.data === 'done', '有影像 → 第 1 步 done')
  check(st2.detect === 'active', '有影像无结果 → 第 3 步 active（跳过可选的第 2 步）')
  check(st2.range === 'todo', '第 2 步保持 todo（可选，不抢 active）')

  const st3 = statusOf(withGaps)
  check(st3.detect === 'done', '已有结果 → 第 3 步 done（不用重跑）')
  check(st3.review === 'active', '有结果 → 第 4 步 active')
}

// ---------- B. 可选步骤不阻塞 ----------
console.log('\nB. 可选步骤（②确定范围 / ④复核）不得把流程卡死')
{
  // 用户决定跑整幅：永远没有 roi，但必须能一路走到导出
  const s: WorkflowInput = {
    ...withImage,
    hasGaps: true,
    hasResult: true,
    gapCount: 100,
    exported: true,
  }
  const st = statusOf(s)
  check(st.range === 'todo', '没圈选时 ② 仍是 todo，但…')
  check(st.export === 'done', '…不影响 ⑤ 已完成')
  check(!computeSteps(s).some((x) => x.status === 'active'), '全部必需步骤完成后没有 active')

  check(isStepDone('range', { ...blank, hasRoi: true }), '圈选后 ② 算 done')

  // 有人工编辑 → 复核自动算完成（不必强制点"复核完成"）
  check(isStepDone('review', { ...blank, edited: true }), '有编辑痕迹 → ④ 自动算 done')
  check(isStepDone('review', { ...blank, reviewed: true }), '点过「复核完成」→ ④ done')
  check(!isStepDone('review', blank), '既没编辑也没确认 → ④ 未完成')
}

// ---------- B2. 删光后流程不能倒退 ----------
console.log('\nB2. 用户把误报全删光后，第 3 步不能变回"未完成"')
{
  // 跑过检测但要素被删光：hasGaps=false，hasResult=true
  const deletedAll: WorkflowInput = { ...withImage, hasGaps: false, hasResult: true, gapCount: 0 }
  const st = statusOf(deletedAll)
  check(st.detect === 'done', '第 3 步仍是 done（不倒退）', JSON.stringify(st))
  check(
    computeSteps(deletedAll).find((x) => x.key === 'detect')?.summary === '已清空',
    '第 3 步摘要显示「已清空」',
  )
  const a = nextAction(deletedAll)
  check(a.kind === 'detect' && a.label === '重新检测', '结果为空时给「重新检测」而不是死路', a.label)
  check(a.body.includes('Ctrl+Z'), '文案提示可以用撤销找回')
}

// ---------- C. 检测中 ----------
console.log('\nC. 检测运行中：active 必须钉在 ③')
{
  const s: WorkflowInput = { ...withImage, detectRunning: true }
  const steps = computeSteps(s)
  check(steps.find((x) => x.key === 'detect')?.status === 'active', '运行中 ③ 是 active')
  check(steps.find((x) => x.key === 'detect')?.summary === '运行中', '③ 摘要显示「运行中」')
}

// ---------- D. 下一步动作 ----------
console.log('\nD. 下一步动作（每个阶段只给一个主行动）')
{
  const a1 = nextAction(blank)
  check(a1.kind === 'openData' && a1.label === '选择正射影像', '无影像 → 选影像', a1.label)
  check(a1.step === 'data' && !a1.finished, '阶段 = data')

  const a2 = nextAction(withImage)
  check(a2.kind === 'detect' && a2.label === '开始检测', '有影像 → 开始检测', a2.label)
  check(
    a2.secondaries?.length === 2 &&
      a2.secondaries[0].kind === 'drawRoi' &&
      a2.secondaries[1].kind === 'pickRoi',
    '未圈选时给两个次按钮：手绘范围 / 导入 KML',
    JSON.stringify(a2.secondaries),
  )
  check(a2.body.includes('整个') || a2.body.includes('整幅'), '文案说明会跑整幅')

  const a3 = nextAction({ ...withImage, hasRoi: true })
  check(a3.secondaries === undefined, '已圈选时不再提示圈选')
  check(a3.body.includes('圈定'), '已圈选时文案改说"只分析圈定范围"', a3.body)

  const a4 = nextAction(withImage, null)
  check(a4.kind === 'detect', '未跑检测前 → 仍是检测')

  // 检测中：主按钮禁用
  const a5 = nextAction({ ...withImage, detectRunning: true })
  check(a5.disabled === true && a5.label === '检测中…', '检测中主按钮禁用', a5.label)

  // 有结果未复核
  const a6 = nextAction(withGaps)
  check(a6.kind === 'goExport', '有结果 → 主按钮"复核完成，去导出"', a6.label)
  check(a6.secondaries?.[0].kind === 'boxSelect', '次按钮是框选多选')
  check(a6.body.includes('1,726'), '文案里带要素数（千分位）', a6.body)

  // 复核过 → 导出
  const a7 = nextAction({ ...withGaps, reviewed: true })
  check(a7.kind === 'export', '复核完成 → 导出交付包', a7.label)

  // 导出过 → 打开文件夹
  const a8 = nextAction({ ...withGaps, reviewed: true, exported: true }, 'D:/out')
  check(a8.kind === 'openOutput' && a8.finished, '导出过 → 打开文件夹')
  check(a8.body.includes('D:/out'), '文案带输出目录', a8.body)
  check(a8.pill === '已完成', '胶囊显示「已完成」')
}

// ---------- E. 文案可读性 ----------
console.log('\nE. 文案不得出现技术术语')
{
  const all = [blank, withImage, withGaps, { ...withGaps, reviewed: true }].map((s) => nextAction(s))
  const jargon = ['sidecar', 'W1004', 'CHM', 'geojson', '参数指纹', 'HTTP']
  for (const a of all) {
    const hit = jargon.find((j) => a.body.includes(j))
    check(!hit, `「${a.label}」正文不含术语${hit ? '：' + hit : ''}`)
  }
}

// ---------- F. toInput 适配 ----------
console.log('\nF. toInput：把 store 状态翻成 WorkflowInput')
{
  const i = toInput({
    backendOnline: true,
    gaps: [1, 2, 3],
    roi: { type: 'Polygon', coordinates: [] },
    detectRunning: false,
    detected: false,
    reviewed: false,
    exported: false,
    manualAdded: 0,
    manualDeleted: 0,
    manualEdited: 0,
  })
  check(i.hasImage && i.hasGaps && i.hasRoi && i.gapCount === 3, '基础字段映射正确')
  check(!i.edited, '三项编辑计数全 0 → edited = false')

  const i2 = toInput({
    backendOnline: true,
    gaps: [],
    roi: null,
    detectRunning: false,
    detected: false,
    reviewed: false,
    exported: false,
    manualAdded: 0,
    manualDeleted: 2,
    manualEdited: 0,
  })
  check(i2.edited, '只有删除也算编辑过（−2）')
}

// ---------- 汇总 ----------
console.log('')
if (failures === 0) {
  console.log('✅ 全部通过')
} else {
  console.log(`❌ ${failures} 项失败`)
  process.exitCode = 1
}
