import { useState } from 'react'

interface Props {
  /** 要显示的消息（后端 `get_status().notices` + 前端自己的失败提示） */
  items: string[]
  /** 关掉（一次性；对应的事已经写进 app.log） */
  onDismiss: () => void
}

/**
 * 顶部提示条 —— 专门用来"说清楚数据发生了什么"。
 *
 * ## 为什么需要一个常驻的条，而不是只写日志 / 只弹一次对话框
 *
 * 这里挂的是**数据可能不对**的事：配置损坏被重置、老结果没迁过去、
 * 缓存目录被合并、指定的结果文件其实属于别的区块……
 * 它们共同的特点是：
 *
 *   · 不会让程序崩，所以不会有人来问；
 *   · 但会让结果悄悄变成另一个样子（最贵的一类）；
 *   · 只在启动时发生一次，用户点两下就错过了。
 *
 * 弹模态框太重（用户会条件反射点掉），写日志等于没说（release 没有控制台，
 * 日志文件用户不会去找）。一条可以自己关掉的横幅是唯一合适的形式。
 */
export default function NoticeBar({ items, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false)
  if (items.length === 0) return null
  const first = items[0]
  const rest = items.length - 1

  return (
    <div className="notice-bar" role="status">
      <span className="notice-icon" aria-hidden>
        ⚠
      </span>
      <div className="notice-body">
        <div className="notice-line">{first}</div>
        {rest > 0 && expanded && (
          <ul className="notice-more">
            {items.slice(1).map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        )}
      </div>
      {rest > 0 && (
        <button
          type="button"
          className="btn ghost notice-toggle"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? '收起其余提示' : '还有几条提示'}
        >
          {expanded ? '收起' : `还有 ${rest} 条`}
        </button>
      )}
      <button type="button" className="btn ghost notice-close" onClick={onDismiss} title="知道了">
        知道了
      </button>
    </div>
  )
}
