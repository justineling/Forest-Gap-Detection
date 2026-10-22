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
 */
export default function ResumeDialog({
  count,
  generatedAt,
  onContinue,
  onRestart,
}: {
  /** 读到的结果块数 */
  count: number
  /** 结果生成时间（后端暂时没有这个字段，通常是 null） */
  generatedAt: string | null
  /** 继续复核上次的结果（什么都不变，只关窗） */
  onContinue: () => void
  /** 重新开始（清空界面上已加载的结果，从「确定范围」重走） */
  onRestart: () => void
}) {
  // ESC = 继续（不丢数据那一支）。挂在 window 上而不是 div 上：
  // 弹窗刚出现时焦点还不一定在里面，挂在 div 上会漏掉第一次 ESC。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onContinue()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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
            继续复核可以接着上次的进度；重新开始会清空当前结果，从「确定范围」重新走一遍。
          </p>
        </div>

        <div className="help-foot">
          <span className="dim">不确定选哪个就先继续，随时可以再重跑一次检测</span>
          <button className="btn primary" onClick={onContinue} autoFocus>
            继续复核上次结果
          </button>
          <button className="btn" onClick={onRestart}>
            重新开始
          </button>
        </div>
      </div>
    </div>
  )
}
