import { useEffect, useState } from 'react'
import { computeSteps, nextAction, type ActionKind, type WorkflowInput } from '../lib/workflow'
import { useAppStore } from '../store/useAppStore'

interface Props {
  input: WorkflowInput
  /** 导出后的目录（完成态文案用） */
  outputDir?: string | null
  onAction: (kind: ActionKind) => void
  /**
   * 载入结果时的错误（`/gaps` 说"没找到检测结果文件"）。
   *
   * 为什么要单独一个 prop 而不是塞进 WorkflowInput：它描述的是**数据链路**
   * 出了问题，不是流程走到哪一步。混进状态机会让"第 3 步完成没"变得含混。
   * 但卡片文案必须换掉 —— 否则用户看到的是"共 0 块空地"或"结果为空"，
   * 而真相是"检测成功了，结果文件在别的目录"。
   */
  loadError?: string | null
  /**
   * 检测参数窗是否打开着。
   *
   * 为什么需要它（2026-10-24 用户反馈）：「开始检测时参数弹窗出现后，应该把右下角
   * 那个可展开/折叠的卡片默认折叠 —— 减少画面上的信息量，降低思考压力」。
   * 参数窗本身就占了大半个屏幕，背后再挂一张写着「开始检测」的卡片，
   * 等于同一个问题问两遍，用户反而不知道该看哪边。
   *
   * 语义是**单向强制**：打开 → 一定折叠（用户之前手动展开也没用）；
   * 关闭 → 回到用户自己的选择（没手动折过就自动展开）。
   */
  settingsOpen?: boolean
}

/**
 * 「下一步」卡片 —— 整个简化方案的核心。
 *
 * 原来的问题：14 个按钮平铺，用户不知道先点哪个。功能并不缺，缺的是
 * **"此刻只告诉我该做什么"**。
 *
 * 现在的规则：
 *   · 任何时刻只给 **1 个主行动**（+ 最多 2 个次行动）
 *   · 文案说人话（不出现 CHM / sidecar / geojson）
 *   · 完成一步自动换成下一步的内容，不需要用户回来找按钮
 *
 * 为什么是右下角浮动卡片而不是模态弹窗：用户还要看图、翻图层、点属性。
 * 每一步都弹一个必须关闭的窗，三次之后所有人都会条件反射地点"关闭"。
 */
export default function NextStepCard({
  input,
  outputDir,
  onAction,
  loadError,
  settingsOpen = false,
}: Props) {
  /**
   * 用户**自己**折的（点卡片右上角「⌄」）。与 `settingsOpen` 分开存：
   * 参数窗强制折叠不该覆盖用户的手动选择 —— 关掉参数窗后要回到他的选择。
   */
  const [userCollapsed, setUserCollapsed] = useState(false)
  // 底部批量操作栏（BatchBar）在有选中项时出现，居中于地图区。
  // 卡片在右下角，窄地图下两者会压到一起 —— 有选中项就上移让位。
  const hasSelection = useAppStore((s) => s.selectedIds.length > 0)
  const action = nextAction(input, outputDir)

  // 「结果文件没找到」是**数据链路**异常，不是"这一步没做"。
  const abnormal = !!loadError

  // 用户手动折叠后，一旦进入新的步骤就自动展开 —— 否则他永远看不到引导。
  //
  // ⚠️ 所有 hook 必须在下面的 `return null` **之前**调用：
  //    React 要求每次渲染的 hook 数量一致。检测开始时若先 `return null`
  //    再跳过这个 effect，hook 数量从 3 变 2 → `Minified React error #310`
  //    （2026-10-23 真机踩到：点「开始检测」直接白屏报错）。
  useEffect(() => {
    setUserCollapsed(false)
  }, [action.step, action.kind, abnormal])

  // ⚠️ 检测运行中**不显示卡片**：此时顶部已有进度条（DetectBar）说明"在干什么"，
  //    再挂一张写着「检测中…」的禁用卡片，等于同一件事说两遍，还挡地图。
  //    **不要把这个 return 挪到任何 hook 上面**。
  if (input.detectRunning) return null

  const step = computeSteps(input).find((s) => s.key === action.step)

  // 「结果文件没找到」是**数据链路**异常，不是"这一步没做"。
  // 这时不能沿用 action.body（那会写成"共 0 块空地"），要说清怎么补救。
  // 现有结果被保留时也要讲明白 —— 否则用户会以为屏幕上的是新结果。
  // （`abnormal` 已在函数顶部定义 —— 它被上面的 effect 依赖，必须提前。）
  // ⚠️ loadError 本身已经是完整句子（"未找到检测结果文件（已查找：…）"），
  //    这里**不要再套一层"没找到…（$loadError）"** —— 会变成
  //    "没找到检测结果文件（未找到检测结果文件（已查找：…））"。
  const body = abnormal
    ? `${loadError}。检测本身可能已经跑完了，只是结果写在了别的目录 —— ` +
      '点右上角「⋯ 更多 → 更换影像或结果文件」指一下，或直接重新检测。' +
      (input.gapCount > 0
        ? `（界面上的 ${input.gapCount.toLocaleString()} 块是上一次的结果，已保留）`
        : '')
    : action.body

  /**
   * 最终是否折叠：**参数窗优先**（打开就一定折叠），否则看用户自己的选择。
   *
   * 用派生值而不是 `useEffect(() => setCollapsed(...))` 去同步：
   * 上面那个"换步骤就展开"的 effect 与"参数窗一开就折叠"的 effect 会互相覆盖 ——
   * 谁后跑谁生效，取决于 React 的调度顺序，这种"看起来能工作"的写法迟早出错。
   */
  const collapsed = settingsOpen || userCollapsed
  const cls = `${action.finished ? ' done' : ''}${hasSelection ? ' raised' : ''}${
    abnormal ? ' warn' : ''
  }`

  if (collapsed) {
    // ⚠️ 折叠时**不能丢 pill 文案**：用户仍然要知道"现在停在第几步"，
    //    否则折叠就成了"信息全没了"，比不折叠更糟。
    const pillText = abnormal ? '结果文件未找到' : action.pill
    if (settingsOpen) {
      // 参数窗打开时不能再提供「展开」—— 点了也展不开（那是个死按钮），
      // 所以渲染成不可点的胶囊，并把尾部文案换成当前的实际状态。
      return (
        <div
          className={`next-pill np-locked${cls}`}
          title="检测参数窗已打开 —— 关掉它就会展开「下一步」提示"
        >
          <span className="np-dot" />
          {pillText}
          <span className="np-more">参数窗已打开</span>
        </div>
      )
    }
    return (
      <button
        type="button"
        className={`next-pill${cls}`}
        onClick={() => setUserCollapsed(false)}
        title="展开「下一步」提示"
      >
        <span className="np-dot" />
        {pillText}
        <span className="np-more">展开</span>
      </button>
    )
  }

  return (
    <div className={`next-card${cls}`}>
      <div className="nc-head">
        <span className="nc-step">
          {abnormal ? (
            <>
              <b className="nc-warn">!</b> 结果没读到
            </>
          ) : action.finished ? (
            <>
              <b className="nc-check">✓</b> 全部完成
            </>
          ) : (
            <>
              第 {step?.no ?? '?'} 步 · {step?.label ?? ''}
              {step?.optional && <em className="nc-opt">可选</em>}
            </>
          )}
        </span>
        <button
          type="button"
          className="nc-min"
          onClick={() => setUserCollapsed(true)}
          title="收起（不影响流程，随时可展开）"
          aria-label="收起"
        >
          ⌄
        </button>
      </div>

      <p className="nc-body">{body}</p>

      <div className="nc-actions">
        <button
          type="button"
          className="btn primary"
          disabled={action.disabled}
          onClick={() => onAction(action.kind)}
        >
          {action.label}
        </button>
        {action.secondaries?.map((b) => (
          <button key={b.kind} type="button" className="btn" onClick={() => onAction(b.kind)}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  )
}
