import { useEffect } from 'react'
import { describeResume } from '../lib/resume'

/**
 * 「发现上次的检测结果」——启动时让用户选：继续上次的进度，还是重新开始。
 *
 * ## 为什么需要它
 *
 * 桌面端启动会自动把磁盘上最近一次的结果读进界面，而 `workflow.isStepDone('detect')`
 * 把"已有结果"也算成第 3 步已完成 —— 界面于是**直接跳到第 4 步「复核结果」**。
 * 初衷是"打开就接着干"，但它替用户做了决定：想重跑的人不知道从哪重来，
 * 只想看新影像的人则被一堆旧多边形吓了一跳。用户的原话是「应该有 1 个弹窗吧」。
 *
 * ## 为什么「关掉」= 继续（而不是「重新开始」）
 *
 * 两个动作的后果不对称：
 *   · 继续 —— 什么都不变，最多是"这次先不重跑"，随时可以再点「重新检测」；
 *   · 重新开始 —— 清空界面上的结果，想找回来只能重跑 6 分钟。
 * ESC / 点遮罩 / 点 × 都是"手滑"的高发动作，所以它们一律走**不丢数据**的那一支。
 *
 * ## 为什么不删磁盘上的结果文件
 *
 * 「重新开始」只清界面（`setGaps([])`），不动 `output/` 下的文件 ——
 * 用户可能只是这次不想看，下次还想接着复核。
 *
 * ## 「换一张影像」→ 取消 必须是"撤销我刚才的选择"（2026-10-24 用户反馈）
 *
 * 用户原话：「我选择了「换一张影像」，然后在向导弹窗里点了右上角的 ×，
 * 却发现自己已经在第 2 步了。」
 *
 * 他点了 ×，等于"我刚才说换影像，现在反悔了" —— 那么界面应当**回到这个弹窗**，
 * 让他重新选一次。这件事由 App 的渲染条件 `resumeAsk && !wizard` 保证：
 * 弹窗的状态从来没被清掉，只是被向导挡住；向导一关它就回来。
 * 所以本组件不需要知道"向导"的存在，也不需要任何"恢复"逻辑 ——
 * 取消不产生任何状态变化，界面自然就是原样。
 */
export default function ResumeDialog({
  count,
  generatedAt,
  onContinue,
  onRestart,
  onPickNew,
}: {
  /** 读到的结果块数 */
  count: number
  /** 结果生成时间（后端暂时没有这个字段，通常是 null） */
  generatedAt: string | null
  /** 继续复核上次的结果（什么都不变，只关窗） */
  onContinue: () => void
  /**
   * 重新开始：清空界面上已加载的结果**和圈选范围**，回到第 2 步重走。
   *
   * ⚠️ 为什么连圈选一起清（2026-10-24 统一）：界面上有两个都叫"重新开始"的入口
   *    （这里的按钮、向导提交后的 B2 分支）。B2 从 2026-10-24 起就会 `setRoi(null)`
   *    —— 不清的话 `isStepDone('range')` 里 `hasRoi` 仍为 true，第 2 步算"已完成"，
   *    active 直接落到第 3 步，用户看到的是"我点了重新开始，怎么直接跳第 3 步了"。
   *    两个同名动作行为不一致，本身就是最坏的一种"看起来像 bug"。
   *
   *    所以这里的步骤角标可以固定写「第 2 步」：清完 gaps + roi 之后，
   *    第 2 步一定是 active（`lib/workflow.ts` 的 `isStepDone('range')` 全部为假）。
   */
  onRestart: () => void
  /** 换一张影像（回到第 1 步，重选 .tif） */
  onPickNew: () => void
}) {
  // ESC = 继续（不丢数据那一支）。挂在 window 上而不是 div 上：
  // 弹窗刚出现时焦点还不一定在里面，挂在 div 上会漏掉第一次 ESC。
  //
  // ⚠️ 必须用 **capture 阶段 + stopPropagation**（与 WelcomeWizard 一致）：
  //    App 里有个全局 Esc（退出绘制 / 清空地图选中），也挂在 `window` 上。
  //    只 preventDefault 拦不住它 —— 于是"按 Esc 关弹窗"会顺手把用户在地图上
  //    选中的那一批多边形清掉，而用户根本没打算取消选中。
  //    同一个 target 上的两个监听器，只有 capture 阶段先跑、且 stopPropagation
  //    才会让后面的冒泡监听器不再被调用（同一 target 的 bubble 监听器在
  //    capture 阶段之后才被 invoke，此时 stop propagation 标记已置位）。
  //
  // ⚠️ 写测试时的坑（QA 2026-10-24 实测踩到，别再来一遍）：
  //    **不能**用 `window.dispatchEvent(new KeyboardEvent('keydown', …))` 验这件事 ——
  //    那样事件的 target 就是 window 本身，同一 target 上的 capture 与 bubble
  //    监听器会按**注册顺序**依次执行，`stopPropagation()` 拦不住（只有
  //    `stopImmediatePropagation` 能），于是会得到一个"看起来漏了全局 Esc"的假失败。
  //    真实键盘事件（CDP `Input.dispatchKeyEvent` / 手动按键）的 target 是聚焦元素，
  //    路径才是 window(capture) → … → window(bubble)，capture 的 stopPropagation 才生效。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onContinue()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onContinue])

  return (
    <div
      className="help-mask"
      role="dialog"
      aria-modal="true"
      aria-label="发现上次的检测结果"
      onMouseDown={(e) => {
        // 点遮罩 = 继续（见文件头：保守方向，不丢数据）
        if (e.target === e.currentTarget) onContinue()
      }}
    >
      <div className="help-dialog resume-dialog">
        <div className="help-head">
          <div>
            <h2>发现上次的检测结果</h2>
            <p className="help-intro">这张影像之前已经跑过一次检测 —— {describeResume(count, generatedAt)}</p>
          </div>
          <button
            type="button"
            className="help-close"
            onClick={onContinue}
            title="关闭（继续使用上次的结果）"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="help-body">
          <p className="resume-note">
            继续复核可以接着上次的进度；重新开始会清空界面上的结果与圈选范围，
            从第 2 步重走一遍；要换成另一张航拍图就选第 1 步。
          </p>
          <p className="resume-note dim">
            {/* ⚠️ 这里不能用 Markdown 的 `**加粗**`：JSX 不渲染 Markdown，
                界面上会把星号原样显示出来（"都**不会删除**磁盘上的…"）。 */}
            三个选项都<b>不会删除</b>磁盘上的结果文件 —— 想找回来随时可以再载入。
          </p>
          <p className="resume-note dim">
            {/* × 的语义必须写在正文里：以前只写在 × 的 title 里，
                用户是"点了 × 之后才发现"它是继续而不是取消。 */}
            点右上角 × 或按 Esc = 继续使用上次的结果（什么都不变）。
          </p>
        </div>

        <div className="help-foot resume-foot">
          <button className="btn" onClick={onPickNew} title="回到第 1 步，重新选择航拍影像（.tif）">
            换一张影像 <span className="step-tag">第 1 步</span>
          </button>
          <button
            className="btn"
            onClick={onRestart}
            title="清空界面上的结果与圈选范围，回到第 2 步「确定范围」"
          >
            重新开始 <span className="step-tag">第 2 步</span>
          </button>
          <button
            className="btn primary"
            onClick={onContinue}
            autoFocus
            title="保留上次的结果，直接进入第 4 步「复核结果」"
          >
            继续复核 <span className="step-tag">第 4 步</span>
          </button>
        </div>
      </div>
    </div>
  )
}
