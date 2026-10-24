import { computeSteps, type Step, type WorkflowInput } from '../lib/workflow'

interface Props {
  input: WorkflowInput
  /** 点某一步（回到该步） */
  onJump: (step: Step['key']) => void
}

/**
 * 顶部五步进度条。
 *
 * 设计取舍：**不做成 5 个按钮**，而是"进度指示器 + 可点回跳"。
 *
 * 为什么：如果每一步都是按钮，用户会以为"五个按钮都能随时点"，
 * 点第 5 步发现没结果、点第 3 步发现没影像 —— 又是一堆点了没反应的按钮。
 * 现在的规则是：
 *   · done  → 可点（回看 / 重做这一步）
 *   · active → 高亮，本身就是当前位置
 *   · todo  → 不可点（还没到），从视觉上就弱化
 *
 * 这样用户看一眼就知道"我在第几步、还剩几步"。
 */
export default function StepRail({ input, onJump }: Props) {
  const steps = computeSteps(input)

  return (
    <nav className="step-rail" aria-label="工作流程">
      {steps.map((s, i) => {
        const clickable = s.status === 'done'
        return (
          <div key={s.key} className="sr-item-wrap">
            {i > 0 && <span className={s.status === 'todo' ? 'sr-line' : 'sr-line done'} />}
            <button
              type="button"
              className={`sr-item ${s.status}`}
              disabled={!clickable}
              onClick={() => clickable && onJump(s.key)}
              title={
                s.status === 'todo'
                  ? `还没到这一步：${s.hint}`
                  : s.status === 'active'
                    ? `当前步骤：${s.hint}`
                    : `已完成 · 点击回看：${s.hint}`
              }
              aria-current={s.status === 'active' ? 'step' : undefined}
            >
              {/* 索引而不是对勾：这套体系里"第几号"就是状态，完成/当前/待办
                  靠字色与那条青色下划线区分（见 ark.css 的 .sr-item.*）。 */}
              <span className="sr-no">{String(s.no).padStart(2, '0')}</span>
              <span className="sr-text">
                <span className="sr-label">{s.label}</span>
                {(s.summary || s.optional) && (
                  <span className="sr-sub">{s.summary ?? '可选'}</span>
                )}
              </span>
            </button>
          </div>
        )
      })}
    </nav>
  )
}
