import { useAppStore } from '../store/useAppStore'
import { cancelDetect } from '../api/backend'

/**
 * 检测进度条 / 完成提示。
 *
 * 为什么单独占一条带子而不是塞进状态栏：
 * 全量检测 350 秒、ROI 195 秒 —— 用户需要**一眼看到还要等多久**，
 * 而不是去滚动日志里数「进度 128/528」。
 *
 * 字段名严格对齐 sidecar 的 progress 事件（见 types.ts 的注释）。
 */
function fmtDur(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s) || s < 0) return '—'
  const t = Math.round(s)
  if (t < 60) return `${t} 秒`
  const m = Math.floor(t / 60)
  const r = t % 60
  return r === 0 ? `${m} 分` : `${m} 分 ${r} 秒`
}

export default function DetectBar() {
  const detect = useAppStore((s) => s.detect)
  const detectReset = useAppStore((s) => s.detectReset)
  const pushLog = useAppStore((s) => s.pushLog)

  // 空闲且没有结束态 → 不占位置
  if (!detect.running && !detect.finished) return null

  const onCancel = async () => {
    try {
      pushLog(await cancelDetect())
    } catch (e) {
      pushLog(`取消失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      detectReset()
    }
  }

  if (detect.running) {
    const pct = Math.min(100, Math.max(0, Math.round((detect.ratio || 0) * 100)))
    const planning = detect.total <= 0
    const parts: string[] = []
    if (!planning) parts.push(`${detect.done} / ${detect.total} 块`)
    parts.push(`已用 ${fmtDur(detect.elapsedS)}`)
    if (detect.etaS != null && !planning) parts.push(`预计剩余 ${fmtDur(detect.etaS)}`)
    if (detect.gapsFound > 0) parts.push(`已发现 ${detect.gapsFound} 块空地`)

    return (
      <div className="detect-bar running" role="status" aria-live="polite">
        <div className="db-body">
          <div className="db-head">
            <b>{planning ? '正在准备…' : `检测中 ${pct}%`}</b>
            <span className="dim mono">{parts.join(' · ')}</span>
          </div>
          <div className="db-track">
            <div
              className={planning ? 'db-fill planning' : 'db-fill'}
              style={{ width: planning ? '100%' : `${pct}%` }}
            />
          </div>
        </div>
        <button className="btn tiny danger" onClick={onCancel} title="中止检测（子进程会被 kill）">
          取消
        </button>
      </div>
    )
  }

  const f = detect.finished!
  return (
    <div className={f.ok ? 'detect-bar done' : 'detect-bar failed'} role="status">
      <span className="db-icon">{f.ok ? '✓' : '✕'}</span>
      <div className="db-body">
        <div className="db-head">
          <b>{f.ok ? '检测完成' : '检测未完成'}</b>
          <span className="dim">{f.message}</span>
        </div>
      </div>
      <button className="btn tiny" onClick={detectReset}>
        关闭
      </button>
    </div>
  )
}
