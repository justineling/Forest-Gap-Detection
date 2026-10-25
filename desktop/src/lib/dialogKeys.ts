import { useEffect } from 'react'

/**
 * 弹窗的统一键盘语义：**Esc = 关闭**。
 *
 * ## 为什么必须 capture + `stopPropagation`
 *
 * `App` 在 `window` 上挂了一个全局 Esc（退出绘制 / 清空地图选中）。
 * 弹窗自己的 Esc 监听也是 `window` 级 —— 同一个 target 上的两个监听器，
 * **只有 capture 阶段先跑并且 `stopPropagation`**，才能让后面那个冒泡监听器
 * 不再被调用。
 *
 * 反例（本项目踩过）：`ResumeDialog` 早先只 `preventDefault` 不 `stopPropagation`，
 * 于是"按 Esc 关弹窗"会顺手把用户刚框选的一批多边形清掉。
 *
 * ## 为什么不是每个弹窗自己写
 *
 * 2026-10-25 之前只有 3 个弹窗有 Esc，另外 4 个只能点按钮关。
 * 「有的窗能按 Esc、有的不能」是最难被记住的不一致 —— 用户不会记住哪 4 个不行，
 * 他只会记住"这个软件有时候按 Esc 没反应"。统一到这里，新弹窗默认就有。
 *
 * @param onClose 关闭动作
 * @param enabled `false` 时不响应（例如"生成中禁止关闭"）
 */
export function useEscapeClose(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // capture 阶段 + 阻止继续传播：不然全局 Esc 会接着执行（清选中 / 退出绘制）
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, enabled])
}
