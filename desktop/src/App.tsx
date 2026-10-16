import { useCallback, useEffect, useState } from 'react'
import MapCanvas, { type DrawIntent } from './components/MapCanvas'
import ErrorBoundary from './components/ErrorBoundary'
import TopToolbar from './components/TopToolbar'
import LeftPanel from './components/LeftPanel'
import RightPanel from './components/RightPanel'
import StatusBar from './components/StatusBar'
import { useAppStore } from './store/useAppStore'
import { exportBundle, fetchGaps, probeBackend } from './api/backend'
import type { GapCollection } from './types'

export default function App() {
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('none')
  const [loadingGaps, setLoadingGaps] = useState(false)
  const [exporting, setExporting] = useState(false)

  const setBackend = useAppStore((s) => s.setBackend)
  const setGaps = useAppStore((s) => s.setGaps)
  const gaps = useAppStore((s) => s.gaps)
  const pushLog = useAppStore((s) => s.pushLog)

  const loadGaps = useCallback(async () => {
    setLoadingGaps(true)
    try {
      const fc = await fetchGaps()
      setGaps(fc.features ?? [])
    } catch (e) {
      // 后端不在线时退回内置样例，保证界面可独立演示
      try {
        const res = await fetch('/sample-gaps.geojson')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const fc = (await res.json()) as GapCollection
        setGaps(fc.features ?? [])
        pushLog(`后端不可用（${e instanceof Error ? e.message : e}），已载入内置样例数据`)
      } catch (e2) {
        pushLog(`载入失败：${e2 instanceof Error ? e2.message : String(e2)}`)
      }
    } finally {
      setLoadingGaps(false)
    }
  }, [setGaps, pushLog])

  // 启动：探测后端 → 自动载入结果
  useEffect(() => {
    ;(async () => {
      pushLog('启动：探测本地瓦片服务…')
      const st = await probeBackend()
      setBackend(st)
      if (st.online) {
        pushLog(
          `后端在线：${st.meta?.source ?? ''}（${st.meta?.width}×${st.meta?.height}，${st.meta?.res_m.toFixed(2)} m/px）`,
        )
      } else {
        pushLog(`后端离线：${st.error ?? ''}（可先启动 scripts/tile_server.py）`)
      }
      await loadGaps()
    })()
    // 仅启动执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onExport = useCallback(async () => {
    setExporting(true)
    const collection: GapCollection = { type: 'FeatureCollection', features: gaps }
    try {
      const res = await exportBundle({ gaps: collection })
      pushLog(`导出完成 → ${res.outdir}（${res.files.length} 个文件）`)
      for (const f of res.files) pushLog(`  · ${f}`)
    } catch (e) {
      // 后端不可用：浏览器端至少给一份编辑后的 GeoJSON
      const blob = new Blob([JSON.stringify(collection, null, 1)], {
        type: 'application/geo+json',
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'gaps-edited.geojson'
      a.click()
      URL.revokeObjectURL(url)
      pushLog(
        `后端导出不可用（${e instanceof Error ? e.message : e}），已改为浏览器下载 gaps-edited.geojson`,
      )
    } finally {
      setExporting(false)
    }
  }, [gaps, pushLog])

  return (
    <div className="app">
      {/* 每个区域各自兜底：地图挂了，工具栏 / 图层面板 / 状态栏仍可用 */}
      <ErrorBoundary area="工具栏">
        <TopToolbar
          drawIntent={drawIntent}
          setDrawIntent={setDrawIntent}
          onLoadGaps={loadGaps}
          onExport={onExport}
          loadingGaps={loadingGaps}
          exporting={exporting}
        />
      </ErrorBoundary>
      <main className="body">
        <ErrorBoundary area="图层面板">
          <LeftPanel />
        </ErrorBoundary>
        <ErrorBoundary area="地图">
          <MapCanvas drawIntent={drawIntent} onDrawDone={() => setDrawIntent('none')} />
        </ErrorBoundary>
        <ErrorBoundary area="属性面板">
          <RightPanel />
        </ErrorBoundary>
      </main>
      <ErrorBoundary area="状态栏">
        <StatusBar />
      </ErrorBoundary>
    </div>
  )
}
