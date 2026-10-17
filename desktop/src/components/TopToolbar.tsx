import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { cancelDetect, isTauri, probeBackend, runDetect } from '../api/backend'
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
  const [detecting, setDetecting] = useState(false)

  const onDetect = async () => {
    setDetecting(true)
    try {
      const r = await runDetect({
        params: {
          // ⚠️ 参数名必须严格对齐 sidecar 的参数表（见交接简报 §3），
          //    写 chm / segment / target_density 会被当成未知字段静默忽略（W1001），
          //    结果退化成"纯 RGB + 默认密度"却照样跑完 —— 实测踩过。
          input: meta?.source ?? 'drone data/WGR17-002.tif',
          job: 'wgr17-desktop',
          chm_path: 'output/chm.tif',
          segment_path: 'drone data/segment.tif',
          workers: 4,
          target_density_per_ha: 150,
        },
        roi: roi ?? undefined,
      })
      pushLog(r.ok ? `已启动检测：${r.message}${roi ? '（仅检测圈选范围）' : '（整幅）'}` : r.message)
      if (!r.ok) setDetecting(false)
    } catch (e) {
      pushLog(`启动检测失败：${e instanceof Error ? e.message : String(e)}`)
      setDetecting(false)
    }
  }

  const onCancelDetect = async () => {
    try {
      pushLog(await cancelDetect())
    } catch (e) {
      pushLog(`取消失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setDetecting(false)
    }
  }

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
          className={detecting ? 'btn' : 'btn'}
          onClick={onDetect}
          disabled={detecting}
          title={
            isTauri()
              ? '调 Python sidecar 跑检测（stdio NDJSON）；圈选过则只跑圈内'
              : '浏览器模式不能启动检测，请用「启动桌面端.bat」打开桌面应用'
          }
        >
          {detecting ? '检测中…' : '② 开始检测'}
        </button>
        {detecting && (
          <button className="btn danger" onClick={onCancelDetect} title="中止当前检测（子进程会被 kill）">
            取消检测
          </button>
        )}
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
