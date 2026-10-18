import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

export default function StatusBar() {
  const logs = useAppStore((s) => s.logs)
  const backendOnline = useAppStore((s) => s.backendOnline)
  const manualAdded = useAppStore((s) => s.manualAdded)
  const manualDeleted = useAppStore((s) => s.manualDeleted)
  const manualEdited = useAppStore((s) => s.manualEdited)
  const roi = useAppStore((s) => s.roi)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <footer className="statusbar">
      <div className="sb-left">
        <span className={backendOnline ? 'dot ok' : 'dot bad'} />
        <span className="dim">
          {backendOnline ? '影像已就绪' : '影像未连接 —— 点右上角「数据」选择正射影像'}
        </span>
        <span className="sep" />
        <span className="dim">ROI：{roi ? '已圈选' : '未圈选（将处理整幅）'}</span>
        <span className="sep" />
        <span className="dim">
          人工编辑：+{manualAdded} / −{manualDeleted} / ✎{manualEdited}
        </span>
      </div>
      <div className="sb-logs" ref={boxRef}>
        {logs.length === 0 && (
          <span className="dim">
            就绪。三步：① 点「数据」选影像 → ② 「圈选 Target Block」框出要检测的地 →
            ③ 「开始检测」。
          </span>
        )}
        {logs.map((l, i) => (
          <div key={i} className="log-line">
            {l}
          </div>
        ))}
      </div>
    </footer>
  )
}
