import { useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { fetchPlantingPoints } from '../api/backend'
import ReviewList from './ReviewList'
import HelpDialog from './HelpDialog'
import { RIGHT_HELP } from '../lib/helpContent'
import { ALL_CLASSES, CLASS_STYLES } from '../lib/classes'
import { labeledCount } from '../lib/validation'
import type { GapClass } from '../types'

interface Props {
  /**
   * 递增即切到「复核」标签。
   *
   * 为什么用 nonce 而不是 boolean：用户可能连续点两次第 4 步，
   * boolean 第二次不会触发 effect（值没变）。
   */
  peekReview?: number
  /** 折叠成 28px 竖轨（窄窗自动折叠 / 用户手点） */
  collapsed?: boolean
  onToggle?: () => void
}

/** 右面板的三档视图（平级，不是"外层 tab + 内层模式"） */
type Tab = 'review' | 'validation' | 'props'

export default function RightPanel({ peekReview = 0, collapsed = false, onToggle }: Props) {
  const gaps = useAppStore((s) => s.gaps)
  const selectedId = useAppStore((s) => s.selectedId)
  const deleteGap = useAppStore((s) => s.deleteGap)
  const setGapClass = useAppStore((s) => s.setGapClass)
  const estimateResult = useAppStore((s) => s.estimateResult)
  const selectedIds = useAppStore((s) => s.selectedIds)
  const validation = useAppStore((s) => s.validation)
  const [help, setHelp] = useState(false)
  /**
   * 选中是不是**从清单里来的**（2026-10-25）。
   *
   * `focusGap` 是清单/键盘的定位入口，它会推一个 `focus.nonce`；
   * 地图点击走 `select`，不推 nonce。用这一个信号区分"我想看属性"和
   * "我正在清单里连着过块"。
   */
  const focusNonce = useAppStore((s) => s.focus?.nonce ?? 0)
  const lastFocusNonce = useRef(focusNonce)
  /**
   * 右面板的三档视图（2026-10-25 从"两层选择器"收敛成一层）。
   *
   * 改之前是：外层 tab「复核 | 属性」，里层再来一组「复核 | 验证集」——
   * 「复核」这个词在同一列里出现两次，而它们不是同一个层级的东西。
   * 现在三者是平级视图：**清单（改结果）/ 验证集（标真相）/ 属性（看单块）**。
   * 差别只在数据归属：复核改 `gaps`，验证集只写 `validation.records`。
   */
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === 'undefined') return 'review'
    if ('__TAURI_INTERNALS__' in window) return 'review'
    // 浏览器模式下 `?val=1` 直接进验证集（截图 / 回归用，不进打包逻辑）
    return new URLSearchParams(window.location.search).has('val') ? 'validation' : 'review'
  })
  /** 有选中项才显示「属性」标签 —— 没选中时它是一块空面板，不如不出现 */
  const hasSelection = selectedIds.length > 0

  // 一旦选中要素，自动切到属性 —— 这是用户**在地图上点它**的意图。
  //
  // ⚠️ 但从清单/键盘选中的不切（2026-10-25 实测出来的 bug）：
  //    键盘 `↓` 选下一块 → `focusGap` → 选中 → 自动切到「属性」→ **清单被卸载** →
  //    再按 `↓` 时 `shownRef` 已空，键盘流一步都走不了。
  //    鼠标点行也一样：点一行，列表消失，得再点回「清单」才能点下一行 ——
  //    而复核恰恰是"在清单里连着过"。所以清单来源的选中不切页签。
  useEffect(() => {
    if (!hasSelection) return
    if (focusNonce !== lastFocusNonce.current) {
      lastFocusNonce.current = focusNonce
      return
    }
    setTab('props')
  }, [hasSelection, focusNonce])

  // 选中被清空（点空白 / 删除 / Esc）→ 属性标签已经不存在了，必须切走，
  // 否则会停在一个渲染不出来的空标签上（白面板）。
  // ⚠️ 只在**当前就在属性页**时才切 —— 否则用户在验证集里点一下地图空白，
  //    就被踢回清单，打标节奏直接断掉。
  useEffect(() => {
    if (!hasSelection) setTab((t) => (t === 'props' ? 'review' : t))
  }, [hasSelection])

  // 步进器点「复核」→ 切到复核清单（跳过 hasSelection 的自动切属性）
  useEffect(() => {
    if (peekReview > 0) setTab('review')
  }, [peekReview])

  /**
   * 多选聚合（2026-10-25）。
   *
   * 改之前：框选 3 块，右栏只写一句"已选中 3 块，去下方批量操作栏改判"——
   * 而用户要决定"整批改成什么"，依据是这批的**面积区间与类别分布**。
   * 把决策数据换成操作说明，是把最难的一步留给用户心算。
   */
  const multi = useMemo(() => {
    if (selectedIds.length < 2) return null
    const set = new Set(selectedIds)
    const picked = gaps.filter((f) => set.has(f.properties.gap_id))
    if (picked.length === 0) return null
    const areas = picked.map((f) => f.properties.area_sqm ?? 0)
    const total = areas.reduce((a, b) => a + b, 0)
    const byClass = new Map<GapClass, { n: number; area: number }>()
    for (const f of picked) {
      const c = f.properties.class
      const cur = byClass.get(c) ?? { n: 0, area: 0 }
      cur.n += 1
      cur.area += f.properties.area_sqm ?? 0
      byClass.set(c, cur)
    }
    return {
      n: picked.length,
      total,
      mean: total / picked.length,
      min: Math.min(...areas),
      max: Math.max(...areas),
      classes: [...byClass.entries()]
        .map(([c, v]) => ({ cls: c, ...v }))
        .sort((a, b) => b.area - a.area),
    }
  }, [gaps, selectedIds])

  const feat = gaps.find((f) => f.properties.gap_id === selectedId)
  const est = estimateResult?.per_gap.find((r) => r.gap_id === selectedId)

  // 折叠态：与左面板同一套 28px 竖轨语法（所有 hook 之后才能提前 return）
  if (collapsed) {
    return (
      <aside className="panel right rail">
        <button
          type="button"
          className="pr-toggle"
          onClick={onToggle}
          title="展开「复核 / 属性」"
          aria-label="展开复核面板"
          aria-expanded={false}
        >
          «
        </button>
        <span className="pr-label">复核与属性</span>
        {/* 空态不显示 0（与左栏竖轨、面板头同一个判据）——
            窄窗下 28px 的轨里挂一个 0，读起来像状态栏多出来的读数。 */}
        {gaps.length > 0 && <span className="pr-n mono">{gaps.length}</span>}
      </aside>
    )
  }

  return (
    <aside className="panel right">
      <div className="panel-head tabs">
        {/* 三档平级视图：清单（改结果）/ 验证集（标真相）/ 属性（看单块）。
            计数只在"有意义"时显示：清单给总数，验证集给进度，属性没有计数。 */}
        <button className={tab === 'review' ? 'tab active' : 'tab'} onClick={() => setTab('review')}>
          清单
          <span className="tab-n">{gaps.length}</span>
        </button>
        <button
          className={tab === 'validation' ? 'tab active' : 'tab'}
          onClick={() => setTab('validation')}
          title="给 150 块打地面真值，用来考核算法 —— 不会改动检测结果"
        >
          验证集
          {/* 没抽样就写「未抽样」，不写「0/—」：没有分母的进度条是假读数 ——
              用户会以为"抽样坏了"，而真相是"还没进这个模式"（抽样在首次进入时才生成）。 */}
          <span className="tab-n">
            {validation.samples.length
              ? `${labeledCount(validation.samples, validation.records)}/${validation.samples.length}`
              : '未抽样'}
          </span>
        </button>
        {hasSelection && (
          <button
            className={tab === 'props' ? 'tab active' : 'tab'}
            onClick={() => setTab('props')}
          >
            属性
          </button>
        )}
        {tab === 'props' && feat && (
          <span className="mono dim tab-id">{feat.properties.gap_id}</span>
        )}
        <button
          type="button"
          className="ph-help"
          onClick={() => setHelp(true)}
          title="复核与属性怎么用？"
          aria-label="复核与属性说明"
        >
          ?
        </button>
        <button
          type="button"
          className="ph-collapse"
          onClick={onToggle}
          title="收起面板（把宽度让给地图）"
          aria-label="收起复核面板"
          aria-expanded
        >
          »
        </button>
      </div>

      {/* 清单与验证集共用同一个列表组件：两者只差"改的是结果还是真值"，
          列表/筛选/键盘操作完全一样 —— 拆成两个组件只会让两边慢慢长歪。 */}
      {(tab === 'review' || tab === 'validation') && <ReviewList mode={tab} />}

      {tab === 'props' && multi && (
        <div className="multi">
          {/* 一行读数：块数 + 合计面积（决定"要不要整批改判"的第一判据） */}
          <div className="multi-head">
            <b>{multi.n} 块</b>
            <span className="mono">
              {Math.round(multi.total).toLocaleString()} <i>m²</i>
            </span>
          </div>
          <div className="multi-stats">
            <div>
              <span>均值</span>
              <b>{Math.round(multi.mean).toLocaleString()}</b>
            </div>
            <div>
              <span>最小</span>
              <b>{Math.round(multi.min).toLocaleString()}</b>
            </div>
            <div>
              <span>最大</span>
              <b>{Math.round(multi.max).toLocaleString()}</b>
            </div>
          </div>
          {/* 类别分布：竖条 + 名称 + 块数/面积。
              这是"整批改成什么"的直接依据 —— 比如一半是"待复核"，就该改成非种植区。 */}
          <ul className="multi-cls">
            {multi.classes.map((c) => (
              <li key={c.cls}>
                <span
                  className="cls-bar"
                  style={{ background: CLASS_STYLES[c.cls].color }}
                  aria-hidden
                />
                <span className="mc-name">{CLASS_STYLES[c.cls].label}</span>
                <span className="mc-n mono">
                  {c.n} 块 · {Math.round(c.area).toLocaleString()} m²
                </span>
              </li>
            ))}
          </ul>
          <p className="multi-foot dim">
            用地图下方的批量操作栏改判或删除；一次操作算一步，按 <kbd>Ctrl+Z</kbd> 可整批撤销。
          </p>
        </div>
      )}

      {tab === 'props' && !feat && selectedIds.length <= 1 && (
        <div className="empty">
          <p>在地图上点选一个多边形查看属性。</p>
          <p className="dim">
            支持拖拽顶点改边界、按 <kbd>Delete</kbd> 删除、用工具栏「➕ 新增空地」补画。
          </p>
        </div>
      )}

      {tab === 'props' && feat && (
        <div className="props">
          <div className="kv">
            <span>类别</span>
            <select
              value={feat.properties.class}
              onChange={(e) => setGapClass(feat.properties.gap_id, e.target.value as GapClass)}
            >
              {ALL_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {CLASS_STYLES[c].label}
                </option>
              ))}
            </select>
          </div>
          <div className="kv">
            <span>面积</span>
            <b>{(feat.properties.area_sqm ?? 0).toLocaleString()} m²</b>
          </div>
          <div className="kv">
            <span>质心</span>
            <span className="mono">
              {(feat.properties.centroid_utm ?? []).map((v) => v.toFixed(5)).join(', ')}
            </span>
          </div>
          <div className="kv">
            <span>距最近格点</span>
            <span className="mono">
              {feat.properties.node_distance_m == null
                ? '—'
                : `${feat.properties.node_distance_m.toFixed(2)} m`}
            </span>
          </div>
          <div className="kv">
            <span>置信度</span>
            <span className="mono">
              {feat.properties.class_confidence == null
                ? '—'
                : feat.properties.class_confidence.toFixed(3)}
            </span>
          </div>
          <div className="kv">
            <span>判据来源</span>
            <span className="mono">{feat.properties.class_method ?? '—'}</span>
          </div>
          {feat.properties.class_reason && (
            <div className="reason">{feat.properties.class_reason}</div>
          )}

          {(feat.properties.edited || feat.properties.source === 'manual') && (
            <div className="edited-tag">
              人工编辑
              {feat.properties.original_class && (
                <span className="dim">
                  （原判：{CLASS_STYLES[feat.properties.original_class].label}）
                </span>
              )}
            </div>
          )}

          {est && (
            <div className="est-block">
              <h4>补种估算（双口径）</h4>
              <div className="kv">
                <span>面积折算</span>
                <b>{est.by_area} 株</b>
              </div>
              <div className="kv">
                <span>网格排坑</span>
                <b>{est.by_grid} 株</b>
              </div>
              <div className={est.divergence_pct > 30 ? 'warn-line' : 'dim'}>
                差异 {est.divergence_pct}%
                {est.divergence_pct > 30 && ' —— 形状破碎或退让吃掉面积，建议复核'}
              </div>
            </div>
          )}

          <div className="prop-actions">
            <button className="btn danger" onClick={() => deleteGap(feat.properties.gap_id)}>
              删除此多边形
            </button>
          </div>
        </div>
      )}

      {tab === 'props' && estimateResult && (
        <div className="panel-est-summary">
          <h4>全园估算</h4>
          <div className="kv">
            <span>面积口径</span>
            <b>{estimateResult.by_area.toLocaleString()} 株</b>
          </div>
          <div className="kv">
            <span>排坑口径</span>
            <b>{estimateResult.by_grid.toLocaleString()} 株</b>
          </div>
          <div className="kv">
            <span>参与面积</span>
            <b>{estimateResult.area_sqm.toLocaleString()} m²</b>
          </div>
          <div className="kv">
            <span>差异</span>
            <b>{estimateResult.divergence_pct}%</b>
          </div>
          <div className="dim">
            规格：株距 {estimateResult.grid.plant_pitch_m} m / 行距{' '}
            {estimateResult.grid.row_pitch_m} m / 错行 {estimateResult.grid.azimuth_deg}° /
            退让 {estimateResult.grid.clearance_m} m
          </div>
          <div className="dim">
            已在地图上标出 {estimateResult.points.length} 个补种点位
            {estimateResult.origin_source === 'planting_grid'
              ? '（已对齐算法网格锚点）'
              : '（⚠️ 未对齐算法锚点，相位不可复现）'}
          </div>
          <PointExport clearance={estimateResult.grid.clearance_m} />
        </div>
      )}

      {help && <HelpDialog doc={RIGHT_HELP} onClose={() => setHelp(false)} />}
    </aside>
  )
}

/**
 * 补种点位导出 —— **走 Python/UTM 权威结算**（`GET /planting-points`），
 * 不用前端自算的结果放样：
 * 前端是局部等距圆柱近似，0.5 m 档实测与 Python 完全一致（3,691 = 3,691），
 * 但 1.0/2.0 m 档差 0.6~0.9%（GEOS `buffer(-d)` 与逐点距离的数值精度）。
 * 现场按点位挖坑，差几个点是小事；**报数口径分裂**才是大事。
 */
function PointExport({ clearance }: { clearance: number }) {
  const pushLog = useAppStore((s) => s.pushLog)
  const [busy, setBusy] = useState(false)
  const [total, setTotal] = useState<number | null>(null)

  const download = (name: string, text: string, mime: string) => {
    const url = URL.createObjectURL(new Blob([text], { type: mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  const run = async (fmt: 'geojson' | 'csv') => {
    setBusy(true)
    try {
      const res = await fetchPlantingPoints(clearance)
      if (res.error) throw new Error(res.error)
      setTotal(res.meta?.total ?? res.features.length)
      if (fmt === 'geojson') {
        download(
          `planting-points-${clearance}m.geojson`,
          JSON.stringify(res, null, 2),
          'application/geo+json',
        )
      } else {
        const head = 'point_id,gap_id,class,source,lon,lat,utm_x,utm_y,clearance_m'
        const rows = res.features.map((f) => {
          const p = f.properties
          const [lon, lat] = f.geometry.coordinates
          return [p.point_id, p.gap_id, p.class, p.source, lon, lat, p.utm_x, p.utm_y, p.clearance_m].join(',')
        })
        download(`planting-points-${clearance}m.csv`, [head, ...rows].join('\n'), 'text/csv')
      }
      pushLog(`已导出补种点位（${res.meta?.total ?? res.features.length} 个，退让 ${clearance} m，Python 权威结算）`)
    } catch (e) {
      pushLog(`点位导出失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="point-export">
      <div className="row">
        <button className="btn tiny" disabled={busy} onClick={() => run('geojson')}>
          点位 GeoJSON
        </button>
        <button className="btn tiny" disabled={busy} onClick={() => run('csv')}>
          放样 CSV
        </button>
      </div>
      <div className="dim">
        {busy ? '正在用 Python/UTM 结算…' : total != null ? `权威点位数 ${total} 个` : '点位由后端结算，可导入 GPS 放样'}
      </div>
    </div>
  )
}
