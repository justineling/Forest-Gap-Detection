import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawSelectMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { useAppStore, selectVisibleGaps } from '../store/useAppStore'
import { classColorExpr } from '../lib/classes'
import { tileUrlTemplate } from '../api/backend'
import {
  featureBBox,
  isDegenerateBox,
  normalizeBBox,
  selectGapsInBox,
} from '../lib/selection'
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
  /**
   * 瓦片真值（'unknown' | 'ok' | 'failed'）。
   *
   * 为什么需要它：`backendOnline` 只证明 `/meta` 应答了。影像被移动/锁住时
   * `/meta` 照样 200，但每张瓦片都失败 —— 舞台一片纯黑，而顶栏绿点、kicker、
   * 状态栏三处还在说"已就绪"。用户对着黑屏判断"这块是不是空地"，只能瞎判。
   */
  const tilesState = useAppStore((s) => s.tilesState)
  /**
   * 连续失败计数（跨事件回调共享）。
   *
   * ⚠️ 必须在组件作用域，并且**换影像时归零**：这个计数器原来写在 init effect 里，
   *    而那个 effect 只在挂载时跑一次 —— 换影像后旧图攒下的失败次数会被新图继承，
   *    于是新图只要再失败 1 次（而不是 3 次）就判"瓦片读不出来"。
   */
  const tileFailsRef = useRef(0)
  useEffect(() => {
    tileFailsRef.current = 0
  }, [meta?.source])
  const tilesFailed = tilesState === 'failed'
  /** 舞台要不要挂"没有影像"的说明：服务没连上，**或者**连上了但瓦片读不出来 */
  const showStageHint = !backendOnline || tilesFailed
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
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#080a0b' } }],
      },
      center: FALLBACK_CENTER,
      zoom: FALLBACK_ZOOM,
      attributionControl: false,
    })
    // 缩放控件放**右上角**。
    //
    // ⚠️ 别挪回右下角：2026-10-25 之前右下角是「下一步」卡片（宽 330px 的常驻浮层），
    //    两者重叠，实测缩放的 +/− 被卡片压住点不到（2026-10-22 反馈）。
    //    现在卡片已改成地图列下沿的命令条（不再压影像），但控件留在右上角 ——
    //    那里空着，而右下角现在是批量操作栏与命令条的入口区。
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left')
    mapRef.current = map

    /**
     * 容器尺寸变化 → `map.resize()`。
     *
     * ⚠️ 2026-10-25 加。MapLibre 只自己监听 **window** resize，不监听容器。
     *    而这一版布局里容器高度会**在不改窗口大小的情况下**变化：
     *      · 底部命令条展开/折叠（64 ↔ 28px）
     *      · 批量操作栏出现/消失（40px）
     *      · 左右侧栏折叠（宽度变化）
     *    不补这一条，canvas 会保持旧尺寸被 CSS 拉伸 —— 影像纵向被压扁，
     *    而多边形是矢量图层（跟着投影走），于是**图形与影像错位**。
     *    这类 bug 在截图里看起来"只是有点糊"，但量面积的人会直接算错。
     */
    const ro = new ResizeObserver(() => map.resize())
    ro.observe(containerRef.current)

    /**
     * 瓦片真值判定。
     *
     * 判据（刻意宽松，宁可漏报也不误报）：
     *  · `data` 事件里带 `tile` = 真有一张瓦片解码成功 → `ok`（一旦 ok 不再回退，
     *    缩放级别变化时偶发失败是正常的）；
     *  · `error` 事件只认 `sourceId === 'ortho'`，且**排除 404**
     *    （404 = 这一级/这一块没有瓦片，属正常，比如超出影像范围）；
     *  · 连续 3 次非 404 失败、且从未成功过 → `failed`。
     *
     * 为什么不用 `sourcedata` 的 `isSourceLoaded`：瓦片全失败时它也会触发，
     * 拿它当"成功"会把最该报警的情况判成正常。
     */
    map.on('data', (e) => {
      const ev = e as unknown as { sourceId?: string; tile?: unknown }
      if (ev.sourceId !== 'ortho' || !ev.tile) return
      tileFailsRef.current = 0
      if (useAppStore.getState().tilesState !== 'ok') useAppStore.getState().setTilesState('ok')
    })
    map.on('error', (e) => {
      const ev = e as unknown as {
        sourceId?: string
        error?: { status?: number; message?: string }
      }
      if (ev.sourceId !== 'ortho') return
      // 404 = 这一级/这一块没有瓦片，属正常（超出影像范围），不算失败。
      if (ev.error?.status === 404) return
      // **被中止的请求不算失败**（2026-10-25 审核补的护栏）：
      // 平移/缩放时 MapLibre 会主动中止在途瓦片，中止产生的错误没有 status。
      // 不排掉它，用户只是拖一下地图就可能被判成"影像读不出来"。
      if (/abort/i.test(String(ev.error?.message ?? ''))) return
      tileFailsRef.current += 1
      const st = useAppStore.getState()
      if (tileFailsRef.current >= 3 && st.tilesState !== 'ok') st.setTilesState('failed')
    })

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
        paint: { 'fill-color': '#18d1ff', 'fill-opacity': 0.1 },
      })
      map.addLayer({
        id: 'roi-line',
        type: 'line',
        source: 'roi',
        paint: { 'line-color': '#18d1ff', 'line-width': 2, 'line-dasharray': [6, 3] },
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
          'circle-color': '#c8eb21',
          'circle-stroke-color': '#080a0b',
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
      ro.disconnect()
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
      tiles: [tileUrlTemplate()],
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

  // ---------- 11b. 右键取消当前绘制 ----------
  //
  // 用户原话：「手动补画空地时，使用右键可以取消当前正在执行的新的划线操作」。
  // 纯鼠标用户画到一半发现点错了，以前只能去按 Esc 或回车 —— 手要离开鼠标。
  //
  // ⚠️ 不能用 `draw.clear()`：那会连**已完成的图形**一起清掉。
  //    切到 `static` 模式会触发当前 mode 的 cleanUp()，只丢弃"还没闭合的那一笔"。
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || drawIntent === 'none') return

    const onCtx = (e: MouseEvent) => {
      // 绘制模式下右键的唯一语义就是取消；不拦的话会弹出浏览器右键菜单
      e.preventDefault()
      drawRef.current?.setMode('static')
      // 框选是自定义 DOM 矩形（不走 Terra Draw），要单独收掉
      if (boxRef.current) boxRef.current.style.display = 'none'
      onDrawDone()
    }
    const canvas = map.getCanvas()
    canvas.addEventListener('contextmenu', onCtx)
    return () => canvas.removeEventListener('contextmenu', onCtx)
  }, [drawIntent, mapReady, onDrawDone])

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
    <div className={`map-wrap${showStageHint ? ' is-empty' : ''}`}>
      <div ref={containerRef} className="map-container" />
      <div ref={boxRef} className="box-select-rect" />
      {showStageHint && (
        <div className={tilesFailed ? 'map-hint is-degraded' : 'map-hint'}>
          <b>{tilesFailed ? '影像已连接，但瓦片读不出来' : '影像瓦片服务未连接'}</b>
          {tilesFailed ? (
            <>
              <span>
                服务应答正常，但影像瓦片加载失败 —— 影像文件可能被移动 / 改名 / 被别的程序占用，
                也可能是服务端读盘出错。
              </span>
              <span className="dim">
                点右上角「⋯ 更多 → 更换影像或结果文件」重新指一下；多边形与清单仍可用。
              </span>
            </>
          ) : (
            <>
              <span>
                启动后即可看到真实正射影像：
                <code>.venv/Scripts/python.exe scripts/tile_server.py</code>
              </span>
              <span className="dim">（当前仍可查看 / 编辑多边形，数据来自本地结果文件）</span>
            </>
          )}
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
          <span className="dim">右键 / Esc 取消</span>
        </div>
      )}

      {/* 批量操作栏不在这里 —— 2026-10-25 起它和「下一步」命令条一起，
          由 App 挂在地图列的底部栈里（`.map-cell` 是 flex 列）。
          放在 `.map-wrap` 里就得靠绝对定位硬躲命令条，两者永远在互相压。 */}
    </div>
  )
}
