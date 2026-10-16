import { useAppStore } from '../store/useAppStore'
import { detectNotAvailableInBrowser, probeBackend } from '../api/backend'
import type { DrawIntent } from './MapCanvas'

interface Props {
  drawIntent: DrawIntent
  setDrawIntent: (v: DrawIntent) => void
  onLoadGaps: () => void
  onExport: () => void
  loadingGaps: boolean
  exporting: boolean
}

export default function TopToolbar({
  drawIntent,
  setDrawIntent,
  onLoadGaps,
  onExport,
  loadingGaps,
  exporting,
}: Props) {
  const backendOnline = useAppStore((s) => s.backendOnline)
  const meta = useAppStore((s) => s.meta)
  const roi = useAppStore((s) => s.roi)
  const gaps = useAppStore((s) => s.gaps)
  const setRoi = useAppStore((s) => s.setRoi)
  const setBackend = useAppStore((s) => s.setBackend)
  const pushLog = useAppStore((s) => s.pushLog)
  const runEstimate = useAppStore((s) => s.runEstimate)

  const reconnect = async () => {
    pushLog('正在探测后端瓦片服务…')
    const st = await probeBackend()
    setBackend(st)
    pushLog(st.online ? `后端在线：${st.meta?.source ?? ''}` : `后端离线：${st.error ?? ''}`)
  }

  return (
    <header className="toolbar">
      <div className="tb-brand">
        <b>Forest Gap Detection</b>
        <span className="dim">油棕园空地智能检测 · 桌面端原型</span>
      </div>

      <div className="tb-group">
        <button className="btn" onClick={reconnect} title="重新探测本地瓦片服务">
          <span className={backendOnline ? 'dot ok' : 'dot bad'} />
          {backendOnline ? '后端在线' : '后端离线'}
        </button>
        <button className="btn" onClick={onLoadGaps} disabled={loadingGaps}>
          {loadingGaps ? '载入中…' : '载入检测结果'}
        </button>
      </div>

      <div className="tb-group">
        <button
          className={drawIntent === 'roi' ? 'btn primary' : 'btn'}
          onClick={() => setDrawIntent(drawIntent === 'roi' ? 'none' : 'roi')}
          title="圈出只检测的目标区块；圈外的天然林/邻园会被直接排除"
        >
          {drawIntent === 'roi' ? '圈选中…（Esc 取消）' : '① 圈选 Target Block'}
        </button>
        <button className="btn" onClick={() => setRoi(null)} disabled={!roi}>
          清除圈选
        </button>
      </div>

      <div className="tb-group">
        <button
          className="btn"
          onClick={() => {
            pushLog(detectNotAvailableInBrowser())
          }}
          title="检测由 Python sidecar 执行（stdio NDJSON），浏览器原型无法启动子进程"
        >
          ② 开始检测
        </button>
        <button
          className={drawIntent === 'add_gap' ? 'btn primary' : 'btn'}
          onClick={() => setDrawIntent(drawIntent === 'add_gap' ? 'none' : 'add_gap')}
          title="在漏检处手工补画一块空地"
        >
          ➕ 新增空地
        </button>
      </div>

      <div className="tb-group">
        <button className="btn" onClick={runEstimate} disabled={gaps.length === 0}>
          ⚡ 估算可种植数量
        </button>
        <button className="btn" onClick={onExport} disabled={gaps.length === 0 || exporting}>
          {exporting ? '导出中…' : '导出交付包'}
        </button>
      </div>

      <div className="tb-meta">
        {meta ? (
          <>
            <span className="mono">{meta.crs}</span>
            <span className="mono">
              {meta.width.toLocaleString()}×{meta.height.toLocaleString()} px
            </span>
            <span className="mono">{meta.res_m.toFixed(2)} m/px</span>
          </>
        ) : (
          <span className="dim">未连接影像</span>
        )}
      </div>
    </header>
  )
}
