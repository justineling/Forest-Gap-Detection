import { useEffect, useState } from 'react'
import { computeSteps, nextAction, type ActionKind, type WorkflowInput } from '../lib/workflow'
import { useAppStore } from '../store/useAppStore'

interface Props {
  input: WorkflowInput
  /** 导出后的目录（完成态文案用） */
  outputDir?: string | null
  onAction: (kind: ActionKind) => void
}

/**
 * 「下一步」卡片 —— 整个简化方案的核心。
 *
 * 原来的问题：14 个按钮平铺，用户不知道先点哪个。功能并不缺，缺的是
 * **"此刻只告诉我该做什么"**。
 *
 * 现在的规则：
 *   · 任何时刻只给 **1 个主行动**（+ 最多 1 个次行动）
 *   · 文案说人话（不出现 CHM / sidecar / geojson）
 *   · 完成一步自动换成下一步的内容，不需要用户回来找按钮
 *
 * 为什么是右下角浮动卡片而不是模态弹窗：用户还要看图、翻图层、点属性。
 * 每一步都弹一个必须关闭的窗，三次之后所有人都会条件反射地点"关闭"。
 */
export default function NextStepCard({ input, outputDir, onAction }: Props) {
  const [collapsed, setCollapsed] = useState(false)
  // 底部批量操作栏（BatchBar）在有选中项时出现，居中于地图区。
  // 卡片在右下角，窄地图下两者会压到一起 —— 有选中项就上移让位。
  const hasSelection = useAppStore((s) => s.selectedIds.length > 0)
  // 用户手动折叠后，一旦进入新的步骤就自动展开 —— 否则他永远看不到引导
  const action = nextAction(input, outputDir)
  const step = computeSteps(input).find((s) => s.key === action.step)

  useEffect(() => {
    setCollapsed(false)
  }, [action.step, action.kind])

  if (collapsed) {
    return (
      <button
        type="button"
        className={`next-pill${action.finished ? ' done' : ''}${hasSelection ? ' raised' : ''}`}
        onClick={() => setCollapsed(false)}
        title="展开「下一步」提示"
      >
        <span className="np-dot" />
        {action.pill}
        <span className="np-more">展开</span>
      </button>
    )
  }

  return (
    <div className={`next-card${action.finished ? ' done' : ''}${hasSelection ? ' raised' : ''}`}>
      <div className="nc-head">
        <span className="nc-step">
          {action.finished ? (
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
          onClick={() => setCollapsed(true)}
          title="收起（不影响流程，随时可展开）"
          aria-label="收起"
        >
          ⌄
        </button>
      </div>

      <p className="nc-body">{action.body}</p>

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
