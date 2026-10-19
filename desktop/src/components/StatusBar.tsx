import { useEffect, useRef } from 'react'
import { useAppStore } from '../store/useAppStore'

export default function StatusBar({ staleWarnings = [] }: { staleWarnings?: string[] }) {
  const logs = useAppStore((s) => s.logs)
  const backendOnline = useAppStore((s) => s.backendOnline)
  const manualAdded = useAppStore((s) => s.manualAdded)
  const manualDeleted = useAppStore((s) => s.manualDeleted)
  const manualEdited = useAppStore((s) => s.manualEdited)
  const roi = useAppStore((s) => s.roi)
  const meta = useAppStore((s) => s.meta)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

  return (
    <footer className="statusbar">
      {/* 过期提示放最前面：它比"影像已就绪"重要得多 —— 后者只是状态，
          前者意味着"你现在看到的数字可能不对"。用整条橙带而不是一个小图标，
          是因为这条信息会被忽略就等于没有。 */}
      {staleWarnings.length > 0 && (
        <div className="sb-stale" title={staleWarnings.join('\n')}>
          <b>⚠️ 结果可能已过期</b>
          <span>{staleWarnings[0]}</span>
          {staleWarnings.length > 1 && <span className="dim">（另有 {staleWarnings.length - 1} 项）</span>}
        </div>
      )}
      <div className="sb-left">
        <span className={backendOnline ? 'dot ok' : 'dot bad'} />
        <span className="dim">
          {backendOnline ? '影像已就绪' : '影像未连接 —— 点右上角「⋯ 更多 → 更换影像」'}
        </span>
        <span className="sep" />
        <span className="dim">ROI：{roi ? '已圈选' : '未圈选（将处理整幅）'}</span>
        {meta && (
          <>
            <span className="sep" />
            <span className="mono dim">
              {meta.res_m.toFixed(2)} m/px · {meta.width.toLocaleString()}×
              {meta.height.toLocaleString()} px
            </span>
          </>
        )}
        <span className="sep" />
        <span className="dim">
          人工编辑：+{manualAdded} / −{manualDeleted} / ✎{manualEdited}
        </span>
      </div>
      <div className="sb-logs" ref={boxRef}>
        {logs.length === 0 && (
          <span className="dim">就绪。跟着地图右下角的「下一步」走就行。</span>
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
