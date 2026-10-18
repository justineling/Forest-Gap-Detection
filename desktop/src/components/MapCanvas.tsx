import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { useAppStore, selectVisibleGaps } from '../store/useAppStore'
import { classColorExpr } from '../lib/classes'
import { TILE_URL_TEMPLATE } from '../api/backend'
import {
  featureBBox,
  isDegenerateBox,
  normalizeBBox,
  selectGapsInBox,
} from '../lib/selection'
import BatchBar from './BatchBar'
import ErrorBoundary from './ErrorBoundary'
import type { GapGeometry, PolygonGeometry, Position } from '../types'

export type DrawIntent = 'none' | 'roi' | 'add_gap' | 'box_select'

interface Props {
  drawIntent: DrawIntent
  onDrawDone: () => void
}

/** 默认视野：园区大致范围（实测影像位于马来西亚砂拉越，经度 111.2 / 纬度 1.19） */
const FALLBACK_CENTER: Position = [111.2039, 1.1838]
const FALLBACK_ZOOM = 13.5

export default function MapCanvas({ drawIntent, onDrawDone }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const drawRef = useRef<TerraDraw | null>(null)
  const loadedGapIdRef = useRef<string | null>(null)
  /** 框选时画的那个虚线矩形（纯 DOM，不进地图样式） */
  const boxRef = useRef<HTMLDivElement>(null)
  const [mapReady, setMapReady] = useState(false)
  /** Terra Draw 初始化失败时的提示（只影响手绘/编辑，不影响看图） */
  const [drawError, setDrawError] = useState<string | null>(null)

  const meta = useAppStore((s) => s.meta)
  const backendOnline = useAppStore((s) => s.backendOnline)
  const gaps = useAppStore((s) => s.gaps)
  const visibleClasses = useAppStore((s) => s.visibleClasses)
  const selectedIds = useAppStore((s) => s.selectedIds)
  const focus = useAppStore((s) => s.focus)
  /**
   * 只有**恰好选中一块**时才允许 Terra Draw 载入几何做拖拽编辑。
   * 多选时如果还载入第一块，用户拖一下就会改掉"看起来只是高亮"的那块。
   */
  const singleId = selectedIds.length === 1 ? selectedIds[0] : null
  const roi = useAppStore((s) => s.roi)
  const estimateResult = useAppStore((s) => s.estimateResult)
  const select = useAppStore((s) => s.select)
  const addGap = useAppStore((s) => s.addGap)
  const setRoi = useAppStore((s) => s.setRoi)
  const updateGapGeometry = useAppStore((s) => s.updateGapGeometry)

  // ---------- 1. 初始化地图（只做一次） ----------
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return

    // Terra Draw 实例：**必须在 style 加载完成之后**才能创建并 start（见下方注释）
    let draw: TerraDraw | null = null

    const map = new maplibregl.Map({
      container: containerRef.current,
      // 空白底图：不引任何外部瓦片，纯离线可用
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#0f1417' } }],
      },
      center: FALLBACK_CENTER,
      zoom: FALLBACK_ZOOM,
      attributionControl: false,
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
    mapRef.current = map

    map.on('load', () => {
      // 空地多边形：按 class 上色
      map.addSource('gaps', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'gap_id',
      })
      map.addLayer({
        id: 'gaps-fill',
        type: 'fill',
        source: 'gaps',
        paint: {
          'fill-color': classColorExpr() as never,
          'fill-opacity': ['case', ['boolean', ['get', 'edited'], false], 0.55, 0.42],
        },
      })
      map.addLayer({
        id: 'gaps-line',
        type: 'line',
        source: 'gaps',
        paint: {
          'line-color': classColorExpr() as never,
          'line-width': ['case', ['boolean', ['get', 'edited'], false], 1.6, 0.8],
        },
      })

      // 选中高亮
      map.addLayer({
        id: 'gaps-selected',
        type: 'line',
        source: 'gaps',
        filter: ['==', ['get', 'gap_id'], '__none__'],
        paint: { 'line-color': '#ffffff', 'line-width': 3 },
      })

      // ROI（Target Block）
      map.addSource('roi', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'roi-fill',
        type: 'fill',
        source: 'roi',
        paint: { 'fill-color': '#3ddc97', 'fill-opacity': 0.08 },
      })
      map.addLayer({
        id: 'roi-line',
        type: 'line',
        source: 'roi',
        paint: { 'line-color': '#3ddc97', 'line-width': 2, 'line-dasharray': [3, 2] },
      })

      // 补种点位（需求 5）
      map.addSource('planting', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: 'planting-points',
        type: 'circle',
        source: 'planting',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 1.6, 18, 4],
          'circle-color': '#00e0a4',
          'circle-stroke-color': '#00322a',
          'circle-stroke-width': 0.6,
          'circle-opacity': 0.9,
        },
      })

      // —— 交互 ——
      map.on('click', 'gaps-fill', (e) => {
        const id = e.features?.[0]?.properties?.gap_id
        if (typeof id !== 'string') return
        // Shift / Ctrl / Cmd + 点击 = 加选 / 减选（框选之外的精细多选方式）
        const oe = e.originalEvent as MouseEvent | undefined
        const st = useAppStore.getState()
        if (oe && (oe.shiftKey || oe.ctrlKey || oe.metaKey)) st.toggleSelect(id)
        else st.select(id)
      })
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['gaps-fill'] })
        // 点空白处才清空选择；多选状态下点空白也清空（符合直觉）
        if (hits.length === 0) useAppStore.getState().clearSelection()
      })
      map.on('mouseenter', 'gaps-fill', () => {
        map.getCanvas().style.cursor = 'pointer'
      })
      map.on('mouseleave', 'gaps-fill', () => {
        map.getCanvas().style.cursor = ''
      })

      // —— Terra Draw：只负责"画/改"，渲染仍由上面自己的图层承担 ——
      //
      // ⚠️ 必须在 style 加载完成后才 `start()`。
      // MapLibre adapter 在 start 时会向地图注册自己的 source / layer，
      // 此时若 style 尚未就绪，会抛 `Style is not done loading.` ——
      // 而这发生在 React 的 effect 里，**未捕获会让 React 18 卸载整棵组件树**，
      // 用户看到的是整页空白（实测：headless 截图只剩一个纯背景色）。
      // 用户网络稍慢时同样会踩到，所以这里既延后到 load 之后，也加了兜底。
      try {
        draw = new TerraDraw({
          adapter: new TerraDrawMapLibreGLAdapter<maplibregl.Map>({ map }),
          modes: [
            new TerraDrawPolygonMode(),
            new TerraDrawSelectMode({
              flags: {
                polygon: {
                  feature: {
                    draggable: true,
                    coordinates: {
                      midpoints: true,
                      draggable: true,
                      deletable: true,
                    },
                  },
                },
              },
            }),
          ],
        })
        draw.start()
        drawRef.current = draw
      } catch (err) {
        // 降级而不是崩溃：只失去"手绘/编辑"能力，地图与其他面板照常可用
        console.error('[MapCanvas] Terra Draw 初始化失败，绘制与编辑功能不可用', err)
        setDrawError(err instanceof Error ? err.message : String(err))
      }

      setMapReady(true)
    })

    return () => {
      if (draw) draw.stop()
      map.remove()
      mapRef.current = null
      drawRef.current = null
      setMapReady(false)
    }
  }, [select])

  // ---------- 2. 后端在线后再挂影像图层（插在空地图层下方） ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !backendOnline) return
    if (map.getSource('ortho')) return
    map.addSource('ortho', {
      type: 'raster',
      tiles: [TILE_URL_TEMPLATE],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 22,
    })
    map.addLayer(
      { id: 'ortho', type: 'raster', source: 'ortho', paint: { 'raster-opacity': 1 } },
      map.getLayer('gaps-fill') ? 'gaps-fill' : undefined,
    )
  }, [backendOnline, mapReady])

  // ---------- 2b. 后端元数据到达后校正视野 ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !meta) return
    const [w, s, e, n] = meta.bounds_wgs84
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 40, animate: false },
    )
  }, [meta, mapReady])

  // ---------- 3. 可见要素同步 ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('gaps') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      features: selectVisibleGaps({ gaps, visibleClasses }),
    } as never)
  }, [gaps, visibleClasses, mapReady])

  // ---------- 4. 选中高亮（支持多选） ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!map.getLayer('gaps-selected')) return
    map.setFilter(
      'gaps-selected',
      selectedIds.length === 0
        ? ['==', ['get', 'gap_id'], '__none__']
        : (['in', ['get', 'gap_id'], ['literal', selectedIds]] as never),
    )
  }, [selectedIds, mapReady])

  // ---------- 5. ROI 同步 ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('roi') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      features: roi
        ? [{ type: 'Feature', geometry: roi, properties: {} }]
        : [],
    } as never)
  }, [roi, mapReady])

  // ---------- 5b. ROI 变化 → 视野跟过去 ----------
  //
  // 导入 KML / 圈选完成后必须让用户**亲眼看到边界框住了哪片地**，
  // 否则"导进去了但界面上没反应"和"没导进去"长得一模一样。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !roi) return
    let minLon = Infinity
    let minLat = Infinity
    let maxLon = -Infinity
    let maxLat = -Infinity
    const walk = (coords: unknown) => {
      if (!Array.isArray(coords)) return
      if (typeof coords[0] === 'number') {
        const [lon, lat] = coords as [number, number]
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
        return
      }
      for (const c of coords) walk(c)
    }
    walk((roi as { coordinates?: unknown }).coordinates)
    if (!Number.isFinite(minLon)) return
    if (maxLon - minLon < 1e-9 || maxLat - minLat < 1e-9) return
    map.fitBounds(
      [
        [minLon, minLat],
        [maxLon, maxLat],
      ],
      { padding: 80, maxZoom: 18, duration: 500 },
    )
  }, [roi, mapReady])

  // ---------- 6. 补种点位同步 ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const src = map.getSource('planting') as maplibregl.GeoJSONSource | undefined
    if (!src) return
    src.setData({
      type: 'FeatureCollection',
      features: (estimateResult?.points ?? []).map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
        properties: { gap_id: p.gap_id },
      })),
    } as never)
  }, [estimateResult, mapReady])

  // ---------- 7. 绘制意图切换 ----------
  useEffect(() => {
    const draw = drawRef.current
    if (!draw || !mapReady) return
    if (drawIntent === 'none') {
      draw.setMode('static')
      return
    }
    // 清空上一次的临时图形，避免残留
    draw.clear()
    draw.setMode('polygon')
  }, [drawIntent, mapReady])

  // ---------- 8. 绘制完成 → 交给 store，并清空 Terra Draw 的临时图形 ----------
  useEffect(() => {
    const draw = drawRef.current
    if (!draw || !mapReady) return

    const handleFinish = (id: string | number) => {
      const feat = draw.getSnapshotFeature(id)
      const geom = feat?.geometry as GapGeometry | undefined
      if (geom && geom.type === 'Polygon') {
        if (drawIntent === 'roi') setRoi(geom)
        else if (drawIntent === 'add_gap') addGap(geom)
      }
      draw.clear()
      onDrawDone()
    }

    draw.on('finish', handleFinish)
    return () => {
      draw.off('finish', handleFinish)
    }
  }, [drawIntent, mapReady, setRoi, addGap, onDrawDone])

  // ---------- 9. 选中要素 → 载入 Terra Draw 供拖拽/改点 ----------
  useEffect(() => {
    const draw = drawRef.current
    if (!draw || !mapReady) return
    if (loadedGapIdRef.current === singleId) return
    loadedGapIdRef.current = singleId

    draw.clear()
    if (!singleId) return
    const feat = gaps.find((f) => f.properties.gap_id === singleId)
    if (!feat || feat.geometry.type !== 'Polygon') return
    draw.addFeatures([
      {
        id: singleId,
        type: 'Feature',
        geometry: feat.geometry,
        properties: { mode: 'polygon' },
      } as never,
    ])
    draw.setMode('select')
  }, [singleId, gaps, mapReady])

  // ---------- 10. Terra Draw 改完 → 回写 store ----------
  useEffect(() => {
    const draw = drawRef.current
    if (!draw || !mapReady) return
    const handleChange = (ids: Array<string | number>) => {
      for (const id of ids) {
        const snap = draw.getSnapshotFeature(id)
        if (!snap) continue
        const geom = snap.geometry as GapGeometry
        if (geom.type === 'Polygon' && typeof id === 'string' && id === loadedGapIdRef.current) {
          updateGapGeometry(id, geom as PolygonGeometry)
        }
      }
    }
    draw.on('change', handleChange)
    return () => {
      draw.off('change', handleChange)
    }
  }, [mapReady, updateGapGeometry])

  // ---------- 11. 框选多选（拖矩形） ----------
  //
  // ⚠️ MapLibre 默认把「Shift + 左键拖拽」绑成了 boxZoom（拉框放大）。
  //    进入框选模式时必须显式 disable dragPan / boxZoom，否则用户一拖地图就缩放。
  // ⚠️ 选中判定走 `selectGapsInBox` 纯函数（带 visibleClasses），
  //    不用 `queryRenderedFeatures` —— 后者只认"当前渲染出来的"，
  //    缩放级别不同结果会变，而且不区分类别可见性（会盲删隐藏层）。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (drawIntent !== 'box_select') return

    map.dragPan.disable()
    map.boxZoom.disable()
    map.getCanvas().style.cursor = 'crosshair'
    const boxEl = boxRef.current

    let start: maplibregl.Point | null = null

    const paint = (a: maplibregl.Point, b: maplibregl.Point) => {
      if (!boxEl) return
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      boxEl.style.display = 'block'
      boxEl.style.left = `${x}px`
      boxEl.style.top = `${y}px`
      boxEl.style.width = `${Math.abs(b.x - a.x)}px`
      boxEl.style.height = `${Math.abs(b.y - a.y)}px`
    }

    const finish = (a: maplibregl.Point, b: maplibregl.Point) => {
      if (boxEl) boxEl.style.display = 'none'
      const pa = map.unproject(a)
      const pb = map.unproject(b)
      const bbox = normalizeBBox([pa.lng, pa.lat], [pb.lng, pb.lat])
      if (isDegenerateBox(bbox)) return
      const st = useAppStore.getState()
      const ids = selectGapsInBox(st.gaps, bbox, st.visibleClasses)
      st.selectMany(ids)
      st.pushLog(
        ids.length > 0
          ? `框选 ${ids.length} 块（只含当前可见类别）`
          : '框选范围内没有可见的空地 —— 检查左侧类别是否勾选',
      )
    }

    const onDown = (e: maplibregl.MapMouseEvent) => {
      if (e.originalEvent.button !== 0) return
      start = e.point
      paint(start, start)
    }
    const onMove = (e: maplibregl.MapMouseEvent) => {
      if (start) paint(start, e.point)
    }
    // mouseup 挂在 window 上：用户拖到画布外松手也能正常收尾
    const onUp = (ev: MouseEvent) => {
      if (!start) return
      const rect = map.getCanvas().getBoundingClientRect()
      const end = new maplibregl.Point(ev.clientX - rect.left, ev.clientY - rect.top)
      const a = start
      start = null
      finish(a, end)
    }

    map.on('mousedown', onDown)
    map.on('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    return () => {
      map.off('mousedown', onDown)
      map.off('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      map.dragPan.enable()
      map.boxZoom.enable()
      map.getCanvas().style.cursor = ''
      if (boxEl) boxEl.style.display = 'none'
    }
  }, [drawIntent, mapReady])

  // ---------- 12. 复核清单点击 → 飞过去 ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !focus) return
    const f = useAppStore.getState().gaps.find((x) => x.properties.gap_id === focus.id)
    if (!f) return
    const b = featureBBox(f)
    if (!b) return
    map.fitBounds(
      [
        [b.minLon, b.minLat],
        [b.maxLon, b.maxLat],
      ],
      // maxZoom 兜住小块：否则 fitBounds 会一路放大到看不出周边
      { padding: 140, maxZoom: 19, duration: 500 },
    )
  }, [focus, mapReady])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
      <div ref={boxRef} className="box-select-rect" />
      {!backendOnline && (
        <div className="map-hint">
          <b>影像瓦片服务未连接</b>
          <span>
            启动后即可看到真实正射影像：
            <code>.venv/Scripts/python.exe scripts/tile_server.py</code>
          </span>
          <span className="dim">（当前仍可查看 / 编辑多边形，数据来自本地结果文件）</span>
        </div>
      )}
      {drawError && (
        <div className="map-hint map-hint-warn">
          <b>绘制 / 编辑功能不可用</b>
          <span className="dim">{drawError}</span>
          <span className="dim">看图、筛选、估算、导出仍可正常使用。</span>
        </div>
      )}
      {drawIntent !== 'none' && (
        <div className="map-drawing">
          {drawIntent === 'roi'
            ? '正在圈选 Target Block：依次点击顶点，双击 / 回车闭合'
            : drawIntent === 'add_gap'
              ? '正在新增空地：依次点击顶点，双击 / 回车闭合'
              : '框选模式：拖一个矩形选中空地（只命中当前勾选可见的类别）'}
          <span className="dim">Esc 退出</span>
        </div>
      )}

      <ErrorBoundary area="批量操作">
        <BatchBar />
      </ErrorBoundary>
    </div>
  )
}
