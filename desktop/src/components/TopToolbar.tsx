import { useAppStore } from '../store/useAppStore'
import { isTauri, probeBackend } from '../api/backend'
import type { DrawIntent } from './MapCanvas'

interface Props {
  drawIntent: DrawIntent
  setDrawIntent: (v: DrawIntent) => void
  onLoadGaps: () => void
  /** 打开「选择数据」引导（换影像 / 换结果文件） */
  onOpenData: () => void
  onExport: () => void
  loadingGaps: boolean
  exporting: boolean
  /** sidecar 正在跑 */
  detecting: boolean
  /** 正在预检 / 启动（比 detecting 更早） */
  starting: boolean
  onDetect: () => void
  onOpenDetectSettings: () => void
}

/**
 * 顶部工具栏。
 *
 * ⚠️ 检测参数**不在这里拼**：以前把 `chm_path` / `workers` 硬编码在按钮里，
 * 用户换了别的目录的影像就会静默退化（W1004 只进日志）。现在统一由
 * App.tsx 的 `buildDetectParams()` 从 store 里取，并且先过 `preflight_detect`。
 */
export default function TopToolbar({
  drawIntent,
  setDrawIntent,
  onLoadGaps,
  onOpenData,
  onExport,
  loadingGaps,
  exporting,
  detecting,
  starting,
  onDetect,
  onOpenDetectSettings,
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
    pushLog(
      st.online
        ? `影像服务已就绪：${st.meta?.source ?? ''}`
        : '影像服务还没连上。第一次使用请点「数据」选择正射影像；已选过则稍等几秒。',
    )
  }

  return (
    <header className="toolbar">
      <div className="tb-brand">
        <b>Forest Gap Detection</b>
        <span className="dim">油棕园空地智能检测 · 桌面端</span>
      </div>

      <div className="tb-group">
        <button
          className="btn"
          onClick={reconnect}
          title={
            backendOnline
              ? '影像服务已就绪，点此重新检测'
              : '点此重新检测；若仍未连接，请点「数据」选择影像'
          }
        >
          <span className={backendOnline ? 'dot ok' : 'dot bad'} />
          {backendOnline ? '影像已就绪' : '影像未连接'}
        </button>
        <button className="btn" onClick={onLoadGaps} disabled={loadingGaps}>
          {loadingGaps ? '载入中…' : '载入检测结果'}
        </button>
        <button className="btn" onClick={onOpenData} title="更换正射影像或检测结果文件">
          数据
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
        {roi && (
          <button className="btn tiny" onClick={() => setRoi(null)} title="清除圈选">
            清除
          </button>
        )}
      </div>

      <div className="tb-group">
        <button
          className="btn primary"
          onClick={onDetect}
          disabled={detecting || starting}
          title={
            isTauri()
              ? '先检查文件是否齐全，再调 Python 跑检测（圈选过则只跑圈内）'
              : '浏览器模式不能启动检测，请用「启动桌面端.bat」打开桌面应用'
          }
        >
          {starting ? '检查中…' : detecting ? '检测中…' : '② 开始检测'}
        </button>
        <button
          className="btn tiny"
          onClick={onOpenDetectSettings}
          title="检测参数：并行进程数 / 目标密度 / 是否只跑圈内"
        >
          ⚙
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
