import { useCallback, useEffect, useState } from 'react'
import MapCanvas, { type DrawIntent } from './components/MapCanvas'
import ErrorBoundary from './components/ErrorBoundary'
import TopToolbar from './components/TopToolbar'
import LeftPanel from './components/LeftPanel'
import RightPanel from './components/RightPanel'
import StatusBar from './components/StatusBar'
import DetectBar from './components/DetectBar'
import DetectSettings from './components/DetectSettings'
import PreflightDialog from './components/PreflightDialog'
import { useAppStore } from './store/useAppStore'
import WelcomeWizard from './components/WelcomeWizard'
import {
  exportBundle,
  fetchGaps,
  getStatus,
  isTauri,
  onSidecarEvent,
  onSidecarLog,
  preflightDetect,
  probeBackend,
  runDetect,
  type AppStatus,
} from './api/backend'
import type { DetectProgress, GapCollection, PreflightResult } from './types'

export default function App() {
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('none')
  const [loadingGaps, setLoadingGaps] = useState(false)
  const [exporting, setExporting] = useState(false)
  /** 当前应用状态（后端形态 / 影像路径 / 是否要引导） */
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null)
  /** 非 null 时显示首次使用引导 */
  const [wizard, setWizard] = useState<AppStatus | null>(null)
  /** 非 null 时显示预检结果对话框 */
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  /** 正在预检 / 启动（按钮显示"检查中…"） */
  const [starting, setStarting] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  const setBackend = useAppStore((s) => s.setBackend)
  const setGaps = useAppStore((s) => s.setGaps)
  const gaps = useAppStore((s) => s.gaps)
  const pushLog = useAppStore((s) => s.pushLog)
  const applyRerun = useAppStore((s) => s.applyRerun)
  const meta = useAppStore((s) => s.meta)
  const roi = useAppStore((s) => s.roi)
  const detectParams = useAppStore((s) => s.detectParams)
  const detect = useAppStore((s) => s.detect)
  const detectBegin = useAppStore((s) => s.detectBegin)
  const detectProgress = useAppStore((s) => s.detectProgress)
  const detectFinish = useAppStore((s) => s.detectFinish)

  /**
   * 载入检测结果。
   *
   * `rerun=true` 时走「合并人工编辑」而不是直接替换 —— 重跑后 gap_id 全部重编，
   * 直接替换会让用户上一轮删掉的误报复活、改判的类别被算法覆盖回去。
   */
  const loadGaps = useCallback(
    async (opts?: { rerun?: boolean }) => {
      setLoadingGaps(true)
      try {
        const fc = await fetchGaps()
        const feats = fc.features ?? []
        if (opts?.rerun) {
          applyRerun(feats, 'keep_manual')
          setLoadingGaps(false)
          return
        }
        // 把算法网格一起带上 —— 前端估算的格点相位才能与 Python 侧逐株一致
        setGaps(feats, fc.planting_grid ?? null)
      } catch (e) {
        // 后端不在线时退回内置样例，保证界面可独立演示
        try {
          const res = await fetch('/sample-gaps.geojson')
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const fc = (await res.json()) as GapCollection
          setGaps(fc.features ?? [], fc.planting_grid ?? null)
          pushLog(`后端不可用（${e instanceof Error ? e.message : e}），已载入内置样例数据`)
        } catch (e2) {
          pushLog(`载入失败：${e2 instanceof Error ? e2.message : String(e2)}`)
        }
      } finally {
        setLoadingGaps(false)
      }
    },
    [setGaps, pushLog, applyRerun],
  )

  /** 探测瓦片服务并载入结果（向导完成后也会调它） */
  const probeAndLoad = useCallback(async () => {
    const st = await probeBackend()
    setBackend(st)
    if (st.online) {
      pushLog(
        `影像已就绪：${st.meta?.source ?? ''}（${st.meta?.width}×${st.meta?.height}，` +
          `${st.meta?.res_m.toFixed(2)} m/px）`,
      )
    } else {
      pushLog(
        '影像服务未连接。若是第一次使用，请点右上角「数据」选择正射影像；' +
          '已选过则稍等几秒（首次要建索引），仍不行请查看日志文件。',
      )
    }
    await loadGaps()
  }, [setBackend, pushLog, loadGaps])

  // 启动：先问"有没有影像"，没有就显示引导（而不是丢给用户一句开发者命令）
  useEffect(() => {
    ;(async () => {
      pushLog('启动：检查数据与影像服务…')
      const st = await getStatus()
      setAppStatus(st)
      // 浏览器模式下 `?wizard=1` 可强制预览引导页（方便截图 / 演示）
      const qs = new URLSearchParams(window.location.search)
      const force = !isTauri() && qs.has('wizard')
      // 浏览器模式下 `?detect=1` 可预览进度条（截图 / 演示用，不进打包逻辑）
      if (!isTauri() && qs.has('detect')) {
        detectBegin()
        detectProgress({
          stage: 'tile_processing',
          done: 128,
          total: 528,
          ratio: 0.2424,
          elapsed_s: 84.5,
          eta_s: 264,
          gaps_found: 312,
        })
      }
      // 浏览器模式下 `?pf=1` 可预览预检对话框（截图 / 回归用）
      if (!isTauri() && qs.has('pf')) {
        setPreflight({
          ok: false,
          items: [
            { key: 'image', label: '正射影像', path: '', status: 'error', detail: '还没有选择影像' },
            {
              key: 'chm_path',
              label: '冠层高度模型（CHM）',
              path: 'D:/project/output/chm.tif',
              status: 'warn',
              detail: '文件不存在 —— 缺了会退化成纯 RGB 判据，水体与低矮植被会大量误判',
            },
            {
              key: 'segment_path',
              label: '语义分割结果',
              path: 'D:/project/drone data/segment.tif',
              status: 'ok',
              detail: '412 MB',
            },
            {
              key: 'forest_mask',
              label: '森林掩膜',
              path: 'D:/project/output/forest-mask-50m-exg60.geojson',
              status: 'ok',
              detail: '已自动启用（剔除未开发林）',
            },
            {
              key: 'work_dir',
              label: '输出目录',
              path: 'D:/project/output/jobs',
              status: 'ok',
              detail: '可写',
            },
          ],
          resolved: {},
        })
        return
      }
      if (st.needs_setup || force) {
        setWizard(st)
        pushLog('还没有选择正射影像 —— 已显示引导，选好文件即可开始')
        return
      }
      await probeAndLoad()
    })()
    // 仅启动执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onWizardDone = useCallback(async () => {
    setWizard(null)
    const st = await getStatus()
    setAppStatus(st)
    await probeAndLoad()
  }, [probeAndLoad])

  // 检测事件：Tauri 宿主里 sidecar 的 NDJSON 事件流 → 进度条 / 日志 / 自动重载结果
  // ⚠️ 浏览器模式（Headless Chrome）下 onSidecarEvent 直接返回空订阅，
  //    不会碰 Tauri API —— 否则会抛错并卸载整棵 React 树（白屏）。
  useEffect(() => {
    let alive = true
    let unEvent: (() => void) | undefined
    let unLog: (() => void) | undefined

    void onSidecarEvent((ev) => {
      const t = String(ev.event ?? '')
      if (t === 'started') {
        detectBegin()
      } else if (t === 'progress') {
        detectProgress(ev as DetectProgress)
        const m = String(ev.message ?? '')
        if (m) pushLog(m)
      } else if (t === 'result') {
        const summary = (ev.summary ?? {}) as Record<string, unknown>
        const n = Number(summary.total_gap_count ?? 0)
        const area = Number(
          summary.plantable_area_definite_sqm ?? summary.plantable_area_sqm ?? 0,
        )
        const el = Number(ev.elapsed_s ?? 0)
        const fmt = (v: number) => v.toLocaleString()
        detectFinish({
          ok: true,
          elapsedS: el,
          gaps: n,
          areaSqm: area,
          message:
            `${fmt(n)} 块空地 · ${fmt(Math.round(area))} m² · 用时 ` +
            `${Math.floor(el / 60)} 分 ${Math.round(el % 60)} 秒 · 结果已载入`,
        })
        pushLog('检测完成，正在重新载入结果（合并人工编辑）…')
        void loadGaps({ rerun: true })
      } else if (t === 'error') {
        const code = String(ev.code ?? '-')
        const msg = String(ev.message ?? '')
        detectFinish({
          ok: false,
          elapsedS: 0,
          gaps: 0,
          areaSqm: 0,
          message: `[${code}] ${msg}`,
        })
        pushLog(`检测失败 [${code}] ${msg}`)
      } else if (t === 'warn') {
        // ⚠️ 以前**没有处理 warn** —— W1001（未知字段）/ W1004（CHM 缺失）
        //    这些"会算偏但不会报错"的告警全部被丢掉，用户完全看不到。
        pushLog(`⚠️ [${String(ev.code ?? '-')}] ${String(ev.message ?? '')}`)
      } else if (t === 'log') {
        const m = String(ev.message ?? '')
        if (m) pushLog(m)
      } else if (t === 'raw') {
        pushLog(`[sidecar] ${String(ev.line ?? '')}`)
      }
    }).then((u) => {
      if (alive) unEvent = u
      else u()
    })

    void onSidecarLog((line) => pushLog(`[py] ${line}`)).then((u) => {
      if (alive) unLog = u
      else u()
    })

    return () => {
      alive = false
      unEvent?.()
      unLog?.()
    }
  }, [loadGaps, pushLog, detectBegin, detectProgress, detectFinish])

  /**
   * 拼检测参数。
   *
   * 只有 `input` 是绝对的（来自 /meta），其余是**相对数据根**的路径 ——
   * Rust 侧会按 dev/bundled 两种基准补成绝对路径。
   * 森林掩膜**刻意不写死文件名**：换影像后文件名会变，交给预检自动发现。
   */
  const buildDetectParams = useCallback(
    (): Record<string, unknown> => ({
      input: meta?.source ?? 'drone data/WGR17-002.tif',
      job: 'wgr17-desktop',
      chm_path: 'output/chm.tif',
      segment_path: 'drone data/segment.tif',
      workers: detectParams.workers,
      target_density_per_ha: detectParams.targetDensity,
    }),
    [meta, detectParams],
  )

  /** 真正启动 sidecar */
  const startDetect = useCallback(
    async (params: Record<string, unknown>, withRoi: boolean) => {
      setStarting(true)
      try {
        const r = await runDetect({ params, roi: withRoi && roi ? roi : undefined })
        if (!r.ok) {
          pushLog(r.message)
          detectFinish({ ok: false, elapsedS: 0, gaps: 0, areaSqm: 0, message: r.message })
          return
        }
        detectBegin()
        pushLog(
          `检测已启动（${detectParams.workers} 进程 · 目标密度 ${detectParams.targetDensity}` +
            ` · ${withRoi && roi ? '只跑圈选范围' : '整幅影像'}）`,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        pushLog(`启动检测失败：${msg}`)
        detectFinish({ ok: false, elapsedS: 0, gaps: 0, areaSqm: 0, message: msg })
      } finally {
        setStarting(false)
        setPreflight(null)
      }
    },
    [roi, pushLog, detectBegin, detectFinish, detectParams],
  )

  /**
   * 点「开始检测」：**先预检，再启动**。
   *
   * 全绿 → 直接跑；有 warn / error → 弹对话框让用户确认。
   * 这一步的价值：chm / segment 缺失时 sidecar 只回一条 W1004 就照常跑完，
   * 结果是"纯 RGB"版本 —— 350 秒后拿到一份看着正常、语义全错的数据。
   */
  const onDetect = useCallback(async () => {
    if (starting || detect.running) return
    const withRoi = detectParams.useRoi && !!roi
    const params = buildDetectParams()
    setStarting(true)
    try {
      const pf = await preflightDetect({
        ...params,
        ...(withRoi && roi ? { roi_geojson: roi } : {}),
      })
      const hasWarn = pf.items.some((i) => i.status === 'warn')
      if (!pf.ok || hasWarn) {
        setPreflight(pf)
        setStarting(false)
        return
      }
      await startDetect(pf.resolved, withRoi)
    } catch (e) {
      setStarting(false)
      const msg = e instanceof Error ? e.message : String(e)
      pushLog(`预检失败：${msg}`)
      // 预检本身出错（例如老版本 Rust 没有这个命令）→ 不拦，直接跑
      await startDetect(params, withRoi)
    }
  }, [starting, detect.running, detectParams, roi, buildDetectParams, startDetect, pushLog])

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
      {/* 工具栏 + 参数弹层包在一起：弹层用 top:100% 挂在工具栏下沿，
          工具栏因窄窗口换行时也不会错位 */}
      <div className="tb-wrap">
        <ErrorBoundary area="工具栏">
          <TopToolbar
            drawIntent={drawIntent}
            setDrawIntent={setDrawIntent}
            onLoadGaps={loadGaps}
            onOpenData={() => setWizard(appStatus ?? ({} as AppStatus))}
            onExport={onExport}
            loadingGaps={loadingGaps}
            exporting={exporting}
            detecting={detect.running}
            starting={starting}
            onDetect={onDetect}
            onOpenDetectSettings={() => setShowSettings((v) => !v)}
          />
        </ErrorBoundary>

        {showSettings && (
          <ErrorBoundary area="检测参数">
            <DetectSettings onClose={() => setShowSettings(false)} />
          </ErrorBoundary>
        )}
      </div>

      <ErrorBoundary area="检测进度">
        <DetectBar />
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

      {/* 首次使用引导：盖在最上层，选好影像后自动消失 */}
      {wizard && <WelcomeWizard status={wizard} onDone={onWizardDone} />}

      {/* 检测前预检：只在有问题时出现 */}
      {preflight && (
        <PreflightDialog
          result={preflight}
          busy={starting}
          onCancel={() => setPreflight(null)}
          onOpenData={() => {
            setPreflight(null)
            setWizard(appStatus ?? ({} as AppStatus))
          }}
          onProceed={() => {
            const withRoi = detectParams.useRoi && !!roi
            void startDetect(preflight.resolved, withRoi)
          }}
        />
      )}
    </div>
  )
}
