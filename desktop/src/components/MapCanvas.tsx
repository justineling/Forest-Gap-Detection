import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { useAppStore, selectVisibleGaps } from '../store/useAppStore'
import { classColorExpr } from '../lib/classes'
import { TILE_URL_TEMPLATE } from '../api/backend'
import type { GapGeometry, PolygonGeometry, Position } from '../types'

export type DrawIntent = 'none' | 'roi' | 'add_gap'

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
  const [mapReady, setMapReady] = useState(false)
  /** Terra Draw 初始化失败时的提示（只影响手绘/编辑，不影响看图） */
  const [drawError, setDrawError] = useState<string | null>(null)

  const meta = useAppStore((s) => s.meta)
  const backendOnline = useAppStore((s) => s.backendOnline)
  const gaps = useAppStore((s) => s.gaps)
  const visibleClasses = useAppStore((s) => s.visibleClasses)
  const selectedId = useAppStore((s) => s.selectedId)
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
        if (typeof id === 'string') select(id)
      })
      map.on('click', (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: ['gaps-fill'] })
        if (hits.length === 0) select(null)
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

  // ---------- 4. 选中高亮 ----------
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (map.getLayer('gaps-selected')) {
      map.setFilter('gaps-selected', ['==', ['get', 'gap_id'], selectedId ?? '__none__'])
    }
  }, [selectedId, mapReady])

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
    if (loadedGapIdRef.current === selectedId) return
    loadedGapIdRef.current = selectedId

    draw.clear()
    if (!selectedId) return
    const feat = gaps.find((f) => f.properties.gap_id === selectedId)
    if (!feat || feat.geometry.type !== 'Polygon') return
    draw.addFeatures([
      {
        id: selectedId,
        type: 'Feature',
        geometry: feat.geometry,
        properties: { mode: 'polygon' },
      } as never,
    ])
    draw.setMode('select')
  }, [selectedId, gaps, mapReady])

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

  // ---------- 11. Delete 键删除选中 ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const el = e.target as HTMLElement | null
      if (el && /INPUT|TEXTAREA|SELECT/.test(el.tagName)) return
      const id = useAppStore.getState().selectedId
      if (!id) return
      e.preventDefault()
      useAppStore.getState().deleteGap(id)
      loadedGapIdRef.current = null
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-container" />
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
            : '正在新增空地：依次点击顶点，双击 / 回车闭合'}
          <span className="dim">Esc 取消</span>
        </div>
      )}
    </div>
  )
}
