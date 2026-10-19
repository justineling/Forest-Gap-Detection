/**
 * 工作流状态机。
 *
 * 为什么要有这个文件（而不是在 Header 里写一堆 if）：
 *
 * 原来顶部工具栏是 **14 个平铺按钮**，用户看不出"我现在该点哪个"。问题的本质
 * 不是按钮太多，而是**没有状态** —— 界面不知道用户走到哪一步，也就无法只
 * 显示当前该做的事。
 *
 * 所以把"五步流程 + 当前该做什么"抽成纯函数：
 *   · 可被 `npm test` 覆盖（按钮顺序错乱是商用软件里最难发现的 bug 之一）
 *   · UI 只负责渲染，不再判断"有没有影像 / 有没有圈选"
 *
 * 五个步骤按业务顺序：
 *   ① 选择影像 → ② 确定范围（可选）→ ③ 运行检测 → ④ 复核结果（可选）→ ⑤ 导出交付
 *
 * ⚠️ ②④ 都标「可选」，但两者语义不同，必须分开处理：
 *
 *    · ② 确定范围 —— **不阻塞**流程。跑整幅是很常见的做法，如果它参与
 *      "当前步骤"计算，用户不圈选就会被永远卡在第 2 步。
 *    · ④ 复核结果 —— **阻塞**（但可一键跳过）。它是最该被引导的一步
 *      （1,726 块里混着误报，不看不该直接交出去）；跳过的方式是点主按钮
 *      「复核完成，去导出」，而不是让界面悄悄越过它。
 *
 * 所以 "optional"（界面上标可选角标）和 "blocks"（是否参与 active 计算）
 * 是两个独立概念 —— 早期版本把它们合成一个字段，导致有结果时第 4 步
 * 永远不亮，用户会以为不需要复核。
 */

export type StepKey = 'data' | 'range' | 'detect' | 'review' | 'export'
export type StepStatus = 'done' | 'active' | 'todo'

export interface WorkflowInput {
  /** 影像服务就绪（正射影像已能出瓦片） */
  hasImage: boolean
  /** 当前有结果要素（可能被用户删光了） */
  hasGaps: boolean
  /**
   * 载入过检测结果。
   *
   * ⚠️ 与 `hasGaps` 的区别是真实的：用户把误报全删光后 `hasGaps` 变 false，
   * 如果拿它判断"第 3 步完成"，流程会**倒退**回"运行检测"——
   * 明明刚跑完还被要求再跑一次，用户会以为数据丢了。
   */
  hasResult: boolean
  /** 已圈选 / 已导入 Target Block 范围 */
  hasRoi: boolean
  /** sidecar 正在跑 */
  detectRunning: boolean
  /** 本次会话跑过至少一次检测（结果可能和磁盘上的相同） */
  detected: boolean
  /** 本次会话有过人工编辑 */
  edited: boolean
  /** 用户点了「复核完成」 */
  reviewed: boolean
  /** 已导出过交付包 */
  exported: boolean
  /** 结果要素数（写进文案） */
  gapCount: number
}

export interface Step {
  key: StepKey
  /** 1-based，显示成 ①②③ */
  no: number
  label: string
  status: StepStatus
  /** 一句话：这一步在干什么 */
  hint: string
  /** 已完成时的简短摘要，例如「1,726 块」 */
  summary?: string
  /** 可跳过的步骤（不阻塞流程） */
  optional: boolean
}

interface StepSpec {
  key: StepKey
  label: string
  hint: string
  /** 界面标「可选」角标 */
  optional: boolean
  /** 是否参与「当前步骤」计算（false = 永不成为 active） */
  blocks: boolean
}

const SPEC: StepSpec[] = [
  { key: 'data', label: '选择影像', hint: '选一份航拍正射影像（.tif）', optional: false, blocks: true },
  { key: 'range', label: '确定范围', hint: '圈出要检测的区块，或直接跑整幅', optional: true, blocks: false },
  { key: 'detect', label: '运行检测', hint: '自动找出需要补种的空地', optional: false, blocks: true },
  { key: 'review', label: '复核结果', hint: '删掉误报、改错判的类别', optional: true, blocks: true },
  { key: 'export', label: '导出交付', hint: '生成交付包与一页报告', optional: false, blocks: true },
]

/** 某一步是否已完成 */
export function isStepDone(key: StepKey, s: WorkflowInput): boolean {
  switch (key) {
    case 'data':
      return s.hasImage
    case 'range':
      return s.hasRoi
    case 'detect':
      // 磁盘上已有历史结果时也算完成 —— 打开软件就接着上次的活干，
      // 而不是逼用户重新跑 6 分钟。
      return s.detected || s.hasResult
    case 'review':
      // 已导出也视为复核过了：导出是复核之后的事，反过来不可能。
      // 不加这条的话，用户从「更多」菜单直接导出一份，界面还会继续提示
      // "去复核"——流程倒退比不提示更糟。
      return s.reviewed || s.edited || s.exported
    case 'export':
      return s.exported
  }
}

/**
 * 算出五个步骤的状态。
 *
 * `active` 的规则：**第一个"参与流程且未完成"的步骤**（`blocks: true`）。
 *
 * ② 确定范围不参与（跑整幅时不该卡住），④ 复核参与但可一键跳过 ——
 * 细节见文件头注释。
 */
export function computeSteps(s: WorkflowInput): Step[] {
  const done = (k: StepKey) => isStepDone(k, s)

  let active: StepKey | null = null
  if (s.detectRunning) {
    active = 'detect'
  } else {
    for (const spec of SPEC) {
      if (spec.blocks && !done(spec.key)) {
        active = spec.key
        break
      }
    }
  }

  return SPEC.map((spec, i) => {
    const d = done(spec.key)
    const status: StepStatus = d ? 'done' : spec.key === active ? 'active' : 'todo'
    return {
      key: spec.key,
      no: i + 1,
      label: spec.label,
      status,
      hint: spec.hint,
      optional: spec.optional,
      summary: summaryOf(spec.key, s),
    }
  })
}

function summaryOf(key: StepKey, s: WorkflowInput): string | undefined {
  switch (key) {
    case 'data':
      return s.hasImage ? '已就绪' : undefined
    case 'range':
      return s.hasRoi ? '已圈选' : undefined
    case 'detect':
      if (s.detectRunning) return '运行中'
      // 结果被删光时说"已清空"，而不是留空让人以为没跑过
      if (s.hasResult && s.gapCount === 0) return '已清空'
      return s.hasGaps ? `${s.gapCount.toLocaleString()} 块` : undefined
    case 'review':
      return s.edited ? '已修改' : undefined
    case 'export':
      return s.exported ? '已导出' : undefined
  }
}

/** 「当前该做什么」的形态 */
export type ActionKind =
  | 'openData'
  | 'pickRoi'
  | 'drawRoi'
  | 'detect'
  | 'boxSelect'
  | 'goExport'
  | 'export'
  | 'openOutput'

export interface NextAction {
  /** 主按钮文案 */
  label: string
  kind: ActionKind
  /** 卡片标题下的一句话：为什么要点这个 */
  body: string
  /**
   * 次按钮（0~2 个）。
   *
   * 为什么允许两个而不是一个：「确定范围」有两条路 —— 手绘、导入 KML/GeoJSON。
   * 只留一个的话，另一条路的入口就得藏进菜单（换园区时最常用的恰恰是导入 KML）。
   * 上限卡在 2：主按钮 + 2 个次按钮已经是"一眼看得完"的极限。
   */
  secondaries?: { label: string; kind: ActionKind }[]
  /** 主按钮是否禁用（例如检测中） */
  disabled?: boolean
  /** 当前处在哪一步（给卡片配色 / 标题用） */
  step: StepKey
  /** 是否已经全部走完 */
  finished: boolean
  /** 折叠成胶囊时显示的短文案 */
  pill: string
}

/**
 * 根据状态给出「下一步」。
 *
 * 文案原则：**说人话，不说术语**。
 * 「CHM 缺失」是给技术看的；用户需要知道的是"少了这个文件，水塘会被当成空地"。
 */
export function nextAction(s: WorkflowInput, exportedDir?: string | null): NextAction {
  if (!s.hasImage) {
    return {
      step: 'data',
      finished: false,
      label: '选择正射影像',
      kind: 'openData',
      pill: '先选影像',
      body: '还没有载入影像。选一份航拍正射影像（.tif）就能开始。',
    }
  }

  if (s.detectRunning) {
    return {
      step: 'detect',
      finished: false,
      label: '检测中…',
      kind: 'detect',
      disabled: true,
      pill: '检测中',
      body: '正在分析影像。上面有进度条 —— 全量约 6 分钟，可以先干别的。',
    }
  }

  if (!s.hasResult && !s.detected) {
    return {
      step: 'detect',
      finished: false,
      label: '开始检测',
      kind: 'detect',
      pill: '开始检测',
      body: s.hasRoi
        ? '只分析圈定的范围，会快很多。开始前会自动检查数据是否齐全。'
        : '会分析整幅影像（约 6 分钟）。有明确的作业区块时，先圈出来能快一倍以上。',
      secondaries: s.hasRoi
        ? undefined
        : [
            { label: '手绘范围', kind: 'drawRoi' },
            { label: '导入 KML', kind: 'pickRoi' },
          ],
    }
  }

  if (!s.reviewed && !s.edited && !s.exported) {
    if (s.gapCount === 0) {
      // 全删光了：不能说"共 0 块，快速扫一遍"，那是死路
      return {
        step: 'review',
        finished: false,
        label: '重新检测',
        kind: 'detect',
        pill: '结果为空',
        body: '当前结果里已经没有空地块了。如果是误删，按 Ctrl+Z 可以撤回；也可以重新检测一次。',
      }
    }
    return {
      step: 'review',
      finished: false,
      label: '复核完成，去导出',
      kind: 'goExport',
      pill: '复核结果',
      body: `共 ${s.gapCount.toLocaleString()} 块空地。快速扫一遍删掉明显误报 —— 「框选多选」一次能处理一片。不改也可以直接导出。`,
      secondaries: [{ label: '框选多选', kind: 'boxSelect' }],
    }
  }

  if (!s.exported) {
    return {
      step: 'export',
      finished: false,
      label: '导出交付包',
      kind: 'export',
      pill: '导出交付',
      body: '生成 Shapefile / KML / 放样点位 / 一页报告，共 21 个文件。',
    }
  }

  return {
    step: 'export',
    finished: true,
    label: '打开输出文件夹',
    kind: 'openOutput',
    pill: '已完成',
    body: exportedDir
      ? `已导出到 ${exportedDir}。可直接拷走，或点按钮打开文件夹。`
      : '已导出。可以直接拷走交付包。',
  }
}

/** 从 store 状态里取 WorkflowInput 的便捷包装（UI 层用，避免各处重复拼） */
export function toInput(p: {
  backendOnline: boolean
  gaps: unknown[]
  hasResult?: boolean
  roi: unknown | null
  detectRunning: boolean
  detected: boolean
  reviewed: boolean
  exported: boolean
  manualAdded: number
  manualDeleted: number
  manualEdited: number
}): WorkflowInput {
  return {
    hasImage: p.backendOnline,
    hasGaps: p.gaps.length > 0,
    // 没显式给就用"当前有要素"兜底（旧调用方 / 测试不必改）
    hasResult: p.hasResult ?? p.gaps.length > 0,
    hasRoi: !!p.roi,
    detectRunning: p.detectRunning,
    detected: p.detected,
    edited: p.manualAdded + p.manualDeleted + p.manualEdited > 0,
    reviewed: p.reviewed,
    exported: p.exported,
    gapCount: p.gaps.length,
  }
}
