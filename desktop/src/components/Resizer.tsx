import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

/**
 * 拖拽手柄（左右面板宽度 / 状态栏高度）。
 *
 * ## 为什么用 Pointer Events + `setPointerCapture`
 *
 * 老写法 `mousedown` + 挂 window 的 `mousemove` 有两个坑：
 *  · 指针拖到窗口外（甚至拖出 Tauri 窗口）时事件会丢，手柄"粘"在按下状态，
 *    用户以为界面卡死；
 *  · 触摸屏 / 触控笔根本不发鼠标事件。
 * `setPointerCapture` 把后续事件强制投递给手柄自己，鼠标 / 触摸 / 触控笔一套代码，
 * 且拖出窗口也不会丢。
 *
 * ## 为什么只回传位移
 *
 * 手柄不知道"左面板现在多宽"—— 那是 App 的事。它只报"相对按下时移动了多少像素"，
 * 由 App 决定加在哪个尺寸上、怎么钳制。这样同一份组件能同时用于三处。
 */
export interface ResizerProps {
  /** `col` = 左右拖动改宽度；`row` = 上下拖动改高度 */
  dir: 'col' | 'row'
  /** 相对按下时的位移（px）。向右 / 向下为正 */
  onDrag: (deltaPx: number) => void
  /** 松手 / 取消时调一次（App 用来把当前尺寸记成下一次拖拽的基准） */
  onEnd?: () => void
  /** 额外类名（定位用，见 styles.css 的 `.rs-left` / `.rs-right` / `.rs-status`） */
  className?: string
  /** 读屏软件用的说明 */
  label?: string
  /**
   * 面板已折叠时隐藏手柄。
   *
   * 为什么不是直接不渲染：调用方写 `<Resizer hidden={...}/>` 比写三元更短，
   * 而且保留了同一个组件实例（折叠/展开不会重挂 pointer 监听）。
   * 折叠态下手柄仍在 DOM 里会变成一个 4px 的可拖区域，拖它没有任何意义 ——
   * 所以用 `display:none` 之外还要 `aria-hidden`，别让读屏软件读到假的分隔条。
   */
  hidden?: boolean
}

export default function Resizer({
  dir,
  onDrag,
  onEnd,
  className = '',
  label,
  hidden = false,
}: ResizerProps) {
  /** 按下时的指针坐标（null = 当前没有在拖） */
  const startRef = useRef<number | null>(null)
  /** 仅用于高亮：不参与任何尺寸计算，所以放 state 不会引起多余的重排 */
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // 只响应主键：右键 / 中键按下不该开始拖拽（右键还要弹菜单）
    if (e.button !== 0) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    startRef.current = dir === 'col' ? e.clientX : e.clientY
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (startRef.current === null) return
    const cur = dir === 'col' ? e.clientX : e.clientY
    onDrag(cur - startRef.current)
  }

  const stop = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (startRef.current === null) return
    startRef.current = null
    setDragging(false)
    const el = e.currentTarget
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
    onEnd?.()
  }

  const cls = ['resizer', dir, dragging ? 'dragging' : '', className].filter(Boolean).join(' ')

  if (hidden) return null

  return (
    <div
      className={cls}
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
      aria-label={label}
      title={label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      // 某些浏览器在捕获丢失时不再发 pointerup（例如触屏被系统手势打断），
      // 这里兜一下，否则手柄会永远停在"拖动中"的高亮状态。
      onLostPointerCapture={() => {
        if (startRef.current === null) return
        startRef.current = null
        setDragging(false)
        onEnd?.()
      }}
    />
  )
}
