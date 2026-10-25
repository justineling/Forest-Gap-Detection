import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { overviewPlan } from '../api/backend'
import type { OverviewPlan } from '../lib/overview'

interface Props {
  staleWarnings?: string[]
  /**
   * 日志区是否展开（2026-10-25）。
   *
   * 折叠态只显示**最后一条**日志（`.sb-logs.is-1line` 用 CSS 隐藏前面所有行）。
   * 为什么按"最后一条"而不是"最新三条"：日志是流水，用户真正关心的是
   * "刚才那步到底成了没有"，那永远是最新一条；要看上下文就展开。
   */
  logOpen?: boolean
  onToggleLog?: () => void
}

export default function StatusBar({ staleWarnings = [], logOpen = false, onToggleLog }: Props) {
  const logs = useAppStore((s) => s.logs)
  const backendOnline = useAppStore((s) => s.backendOnline)
  const tilesState = useAppStore((s) => s.tilesState)
  const manualAdded = useAppStore((s) => s.manualAdded)
  const manualDeleted = useAppStore((s) => s.manualDeleted)
  const manualEdited = useAppStore((s) => s.manualEdited)
  const roi = useAppStore((s) => s.roi)
  const meta = useAppStore((s) => s.meta)
  const boxRef = useRef<HTMLDivElement>(null)
  // 当前影像的加速结构（内部金字塔 / 外置 .ovr / 无）。
  // 为什么放状态栏：用户最常问的就是"为什么缩到远处这么慢"，
  // 而答案就在这一格 —— 没金字塔时它会直接写着"无"。
  const [ovr, setOvr] = useState<OverviewPlan | null>(null)
  useEffect(() => {
    if (!backendOnline) {
      setOvr(null)
      return
    }
    let alive = true
    overviewPlan()
      .then((p) => {
        if (alive) setOvr(p)
      })
      .catch(() => {
        /* 拿不到就不显示，不打扰 */
      })
    return () => {
      alive = false
    }
  }, [backendOnline, meta?.source])

  useEffect(() => {
    const el = boxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs, logOpen])

  return (
    <footer
      className={`statusbar${logOpen ? ' is-open' : ' is-compact'}${
        staleWarnings.length > 0 ? ' has-stale' : ''
      }`}
    >
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
        {/* 点与文案读同一个真值：`backendOnline && tilesState !== 'failed'`。
            原来只看 backendOnline —— 影像读不出来时也照样绿点 + "已就绪"。 */}
        <span className={backendOnline && tilesState !== 'failed' ? 'dot ok' : 'dot bad'} />
        <span className="dim sb-opt">
          {!backendOnline
            ? '影像未连接 —— 点右上角「⋯ 更多 → 更换影像」'
            : tilesState === 'failed'
              ? '影像读不出来（瓦片失败）—— 点右上角「⋯ 更多 → 更换影像」'
              : tilesState === 'ok'
                ? '影像已载入'
                : '影像已连接 · 正在载入'}
        </span>
        <span className="sep sb-opt" />
        <span className="dim sb-opt">ROI：{roi ? '已圈选' : '未圈选（将处理整幅）'}</span>
        {meta && (
          <>
            <span className="sep sb-opt" />
            <span className="mono dim">
              {meta.res_m.toFixed(2)} m/px
              <span className="sb-opt">
                {' '}
                · {meta.width.toLocaleString()}×{meta.height.toLocaleString()} px
              </span>
            </span>
          </>
        )}
        {ovr && (
          <>
            <span className="sep sb-opt" />
            <span
              className="dim sb-opt"
              title={
                ovr.kind === 'none'
                  ? '这张影像没有金字塔：缩放到远处会明显变慢，可点顶部横幅建立'
                  : ovr.kind === 'external'
                    ? `外置 .ovr 加速：${ovr.ovr_path ?? ''}`
                    : '金字塔写在 tif 内部'
              }
            >
              {ovr.kind === 'none'
                ? '⚠️ 无加速结构（远处会慢）'
                : `加速：${ovr.kind === 'external' ? '外置 .ovr' : '内部金字塔'} ×${ovr.levels?.length ?? 0}`}
            </span>
          </>
        )}
        <span className="sep sb-opt" />
        <span className="dim sb-opt">
          人工编辑：+{manualAdded} / −{manualDeleted} / ✎{manualEdited}
        </span>
      </div>
      <div className={`sb-logs${logOpen ? '' : ' is-1line'}`} ref={boxRef}>
        {logs.length === 0 && (
          <span className="dim">就绪。跟着地图下方命令条走就行。</span>
        )}
        {logs.map((l, i) => (
          <div key={i} className="log-line">
            {l}
          </div>
        ))}
      </div>
      {/* 日志展开/收起：与顶部拖拽手柄并存 —— 拖 = 任意高度，点 = 两档。
          为什么两个都要：拖拽是"我要认真看"，点击是"我就瞄一眼刚才那步"。 */}
      {onToggleLog && (
        <button
          type="button"
          className="sb-more"
          onClick={onToggleLog}
          title={logOpen ? '收起日志（只留最新一条）' : `展开日志（共 ${logs.length} 条）`}
          aria-label={logOpen ? '收起日志' : '展开日志'}
          aria-expanded={logOpen}
        >
          {logOpen ? '⌄' : '⌃'}
        </button>
      )}
    </footer>
  )
}
