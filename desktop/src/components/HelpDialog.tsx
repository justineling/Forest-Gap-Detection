import { useEffect } from 'react'
import type { HelpDoc } from '../lib/helpContent'

interface Props {
  doc: HelpDoc
  onClose: () => void
}

/**
 * 通用帮助弹窗。
 *
 * 三处（左栏 / 右栏 / header）复用同一个组件，内容由 `lib/helpContent.ts` 提供。
 * 为什么不写三个：弹窗的关闭逻辑（× / Esc / 点遮罩）、滚动、无障碍属性
 * 完全一样，复制三份只会让三处行为慢慢跑偏（其中一处忘了支持 Esc）。
 *
 * 为什么不做成"首次自动弹"：用户第一次打开软件时已经有引导卡片了，
 * 再弹三个说明会直接把人劝退。帮助应该是**想不起来时能查**，不是拦路。
 */
export default function HelpDialog({ doc, onClose }: Props) {
  // Esc 关闭。capture + stopPropagation：别让 App 的全局 Esc 顺手清掉地图选中
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div
      className="help-mask"
      role="dialog"
      aria-modal="true"
      aria-label={doc.title}
      onMouseDown={(e) => {
        // 只有点在遮罩本身才关（点弹窗内部不关）
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="help-dialog">
        <div className="help-head">
          <div>
            <h2>{doc.title}</h2>
            <p className="help-intro">{doc.intro}</p>
          </div>
          <button type="button" className="help-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="help-body">
          {doc.sections.map((sec) => (
            <section key={sec.h} className="help-sec">
              <h3>{sec.h}</h3>
              <dl>
                {sec.items.map((it) => (
                  <div key={it.term} className="help-item">
                    <dt>{it.term}</dt>
                    <dd>{it.desc}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <div className="help-foot">
          <span className="dim">
            按 <kbd>Esc</kbd> 或点空白处关闭
          </span>
          <button type="button" className="btn primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  )
}
