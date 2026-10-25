import { useAppStore } from '../store/useAppStore'
import { cancelDetect } from '../api/backend'

/**
 * 检测进度 / 完成提示。
 *
 * ## 2026-10-25：从"顶栏下方的一条横带"搬进**命令条槽位**
 *
 * 改之前，点「开始检测」的瞬间会发生两件事：顶部 `DetectBar` 出现（+44px）、
 * 底部「下一步」命令条消失（−64px）。两个方向同时变，实测 `.map-wrap` 的
 * `top` 从 82 跳到 126 —— 用户正盯着的那片影像被整体推下去 44px，
 * 而此刻 `ResizeObserver` 正在做 `map.resize()`。
 *
 * 现在它与命令条**共用同一个 64px 槽位**：谁在跑谁占，高度恒定，零跳动。
 * 顺带解决了"同一屏两条都在说'现在在干什么'"（顶部进度条 + 底部命令条）。
 *
 * ⚠️ 为什么保留 `.detect-bar` / `.db-track` / `.db-fill` / `.running` 这套类名：
 *    `tests/e2e/verify_render.mjs` 有 8 条断言挂在这些选择器上（进度出现、
 *    running 态、有轨道与填充、文字可读、取消后消失、非检测态不存在）。
 *    位置变了、语义没变 —— 换名字等于把那层回归网一起删掉。
 *
 * ## 为什么单独占一个槽位而不是塞进状态栏
 *
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
        {/* 编号块与命令条同一套语法：左沿 3px 信号条 + 21px 步号。
            检测永远是第 3 步，所以这里写死 03 —— 不随 workflow 状态漂移。 */}
        <div className="nc-idx" aria-hidden>
          <b>03</b>
          <span>/05</span>
        </div>
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
      <div className="nc-idx" aria-hidden>
        <b>{f.ok ? '✓' : '✕'}</b>
        <span>/05</span>
      </div>
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
