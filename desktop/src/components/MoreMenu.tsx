import { useEffect, useRef, useState } from 'react'

interface Props {
  gapCount: number
  hasImage: boolean
  onChangeData: () => void
  onReloadGaps: () => void
  onOpenSettings: () => void
  onAddGap: () => void
  onBoxSelect: () => void
  onEstimate: () => void
  onOpenLog: () => void
}

/**
 * 「⋯ 更多」菜单 —— 低频操作的收容所。
 *
 * 判定标准：**一件事多久做一次？**
 *   · 每次交付都做 → 留在主流程（选影像 / 检测 / 复核 / 导出）
 *   · 换园区、调参数、补画一块 → 一周几次 → 收进这里
 *   · 看快捷键、看日志 → 几乎不做 → 收进这里
 *
 * 这样 header 上不会再有"⚙"这种只有老用户才知道是干嘛的图标。
 * 注意：菜单里**不重复**主流程已有的动作（开始检测、导出），
 * 否则又变成"两个地方都能点、行为还可能不一样"。
 */
export default function MoreMenu({
  gapCount,
  hasImage,
  onChangeData,
  onReloadGaps,
  onOpenSettings,
  onAddGap,
  onBoxSelect,
  onEstimate,
  onOpenLog,
}: Props) {
  // 浏览器模式下 `?more=1` 直接展开（截图 / 回归用，不进打包逻辑）
  const [open, setOpen] = useState(
    () => !('__TAURI_INTERNALS__' in window) && new URLSearchParams(location.search).has('more'),
  )
  const boxRef = useRef<HTMLDivElement>(null)

  // 点外面 / 按 Esc 关闭。⚠️ 必须用 capture 之外的普通监听，
  // 且要在菜单内部的点击里 stopPropagation，否则点菜单项会立刻被关掉。
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  /** 点完就关 —— 菜单是"一次性"的，停留只会让界面变乱 */
  const run = (fn: () => void) => () => {
    setOpen(false)
    fn()
  }

  return (
    <div className="more-wrap" ref={boxRef}>
      <button
        type="button"
        className={open ? 'btn icon active' : 'btn icon'}
        onClick={() => setOpen((v) => !v)}
        title="更多操作"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        ⋯
      </button>

      {open && (
        <div className="more-menu" role="menu">
          <div className="mm-group">数据</div>
          <button role="menuitem" onClick={run(onChangeData)}>
            更换影像或结果文件…
          </button>
          <button role="menuitem" disabled={!hasImage} onClick={run(onReloadGaps)}>
            重新载入检测结果
          </button>

          <div className="mm-group">检测</div>
          <button role="menuitem" onClick={run(onOpenSettings)}>
            检测参数（进程数 / 密度 / 树龄档位）…
          </button>

          <div className="mm-group">复核</div>
          <button role="menuitem" disabled={gapCount === 0} onClick={run(onAddGap)}>
            手工补画一块空地
          </button>
          <button role="menuitem" disabled={gapCount === 0} onClick={run(onBoxSelect)}>
            框选多选
          </button>
          <button role="menuitem" disabled={gapCount === 0} onClick={run(onEstimate)}>
            估算可种植数量
          </button>

          <div className="mm-sep" />

          <details className="mm-help">
            <summary>快捷键</summary>
            <dl>
              <dt>
                <kbd>Ctrl</kbd>+<kbd>Z</kbd>
              </dt>
              <dd>撤销（批量操作算一步）</dd>
              <dt>
                <kbd>Ctrl</kbd>+<kbd>Y</kbd>
              </dt>
              <dd>重做</dd>
              <dt>
                <kbd>Delete</kbd>
              </dt>
              <dd>删除选中</dd>
              <dt>
                <kbd>Shift</kbd>+点
              </dt>
              <dd>加选 / 减选</dd>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>退出当前工具</dd>
            </dl>
          </details>

          <button role="menuitem" onClick={run(onOpenLog)}>
            打开输出目录
          </button>
          <div className="mm-note">
            排障用日志：<code>%LOCALAPPDATA%\fgd\logs\app.log</code>
          </div>
        </div>
      )}
    </div>
  )
}
