import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { probeBackend } from '../api/backend'
import StepRail from './StepRail'
import MoreMenu from './MoreMenu'
import HelpDialog from './HelpDialog'
import { HEADER_HELP } from '../lib/helpContent'
import type { StepKey, WorkflowInput } from '../lib/workflow'

interface Props {
  workflow: WorkflowInput
  onJumpStep: (key: StepKey) => void
  onChangeData: () => void
  onReloadGaps: () => void
  onOpenSettings: () => void
  onAddGap: () => void
  onBoxSelect: () => void
  onEstimate: () => void
  onOpenLog: () => void
}

/**
 * 顶部工具栏（简化版）。
 *
 * ## 改了什么
 *
 * 原来是 **14 个平铺按钮**：影像状态 / 载入结果 / 数据 / 撤销 / 重做 /
 * 圈选 / 导入范围 / 清除 / 框选 / 开始检测 / 参数 / 新增空地 / 估算 / 导出。
 * 每个单独看都合理，堆在一起就是"我不知道先点哪个"——用户会怀疑软件不成熟。
 *
 * 现在只剩三块：
 *
 *   ① 品牌（一行，缩到最小）
 *   ② **五步流程条** —— 唯一告诉用户"我在哪、还剩几步"的东西
 *   ③ 四个图标：影像状态灯 / 撤销 / 重做 / 更多
 *
 * 高频动作（选影像、检测、复核、导出）全部搬到「下一步」卡片里，
 * 低频动作（换数据、参数、补画、估算、日志）收进「⋯ 更多」。
 *
 * ## 为什么撤销/重做留在这里
 *
 * 它是**随时可能用到**的（改错一块就想撤），不是流程的一步。
 * 藏进菜单会让用户不敢下手改 —— 这是 P1 花大力气做的功能，不能藏。
 */
export default function TopToolbar({
  workflow,
  onJumpStep,
  onChangeData,
  onReloadGaps,
  onOpenSettings,
  onAddGap,
  onBoxSelect,
  onEstimate,
  onOpenLog,
}: Props) {
  const [help, setHelp] = useState(false)
  const backendOnline = useAppStore((s) => s.backendOnline)
  const setBackend = useAppStore((s) => s.setBackend)
  const pushLog = useAppStore((s) => s.pushLog)
  const past = useAppStore((s) => s.past)
  const future = useAppStore((s) => s.future)
  const undo = useAppStore((s) => s.undo)
  const redo = useAppStore((s) => s.redo)

  const reconnect = async () => {
    pushLog('正在探测影像服务…')
    const st = await probeBackend()
    setBackend(st)
    pushLog(
      st.online
        ? `影像服务已就绪：${st.meta?.source ?? ''}`
        : '影像服务还没连上。请点「⋯ 更多 → 更换影像或结果文件」重新选择；已选过则稍等几秒（首次要建索引）。',
    )
  }

  return (
    <header className="toolbar">
      <div className="tb-brand" title="Forest Gap Detection · 油棕园空地智能检测">
        <b>FGD</b>
        <span className="dim">油棕园空地检测</span>
      </div>

      <StepRail input={workflow} onJump={onJumpStep} />

      <div className="tb-right">
        <button
          type="button"
          className="btn icon"
          onClick={reconnect}
          title={
            backendOnline
              ? '影像服务已就绪，点此重新检测连接'
              : '影像未连接 —— 点此重试；仍未连上请用「⋯ 更多 → 更换影像」'
          }
          aria-label={backendOnline ? '影像已就绪' : '影像未连接'}
        >
          <span className={backendOnline ? 'dot ok' : 'dot bad'} />
        </button>

        <button
          type="button"
          className="btn icon"
          onClick={undo}
          disabled={past.length === 0}
          title={`撤销（Ctrl+Z）—— 可撤 ${past.length} 步；批量操作算一步`}
        >
          ↶<span className="icon-n">{past.length || ''}</span>
        </button>
        <button
          type="button"
          className="btn icon"
          onClick={redo}
          disabled={future.length === 0}
          title={`重做（Ctrl+Y / Ctrl+Shift+Z）—— 可重做 ${future.length} 步`}
        >
          ↷<span className="icon-n">{future.length || ''}</span>
        </button>

        <button
          type="button"
          className="btn icon"
          onClick={() => setHelp(true)}
          title="这个软件怎么用？（五步流程 / 图标含义 / 快捷键）"
          aria-label="使用说明"
        >
          ?
        </button>

        <MoreMenu
          gapCount={workflow.gapCount}
          hasImage={workflow.hasImage}
          onChangeData={onChangeData}
          onReloadGaps={onReloadGaps}
          onOpenSettings={onOpenSettings}
          onAddGap={onAddGap}
          onBoxSelect={onBoxSelect}
          onEstimate={onEstimate}
          onOpenLog={onOpenLog}
        />
      </div>

      {help && <HelpDialog doc={HEADER_HELP} onClose={() => setHelp(false)} />}
    </header>
  )
}
