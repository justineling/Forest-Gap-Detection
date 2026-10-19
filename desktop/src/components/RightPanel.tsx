import { useEffect, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { fetchPlantingPoints } from '../api/backend'
import ReviewList from './ReviewList'
import HelpDialog from './HelpDialog'
import { RIGHT_HELP } from '../lib/helpContent'
import { ALL_CLASSES, CLASS_STYLES } from '../lib/classes'
import type { GapClass } from '../types'

interface Props {
  /**
   * 递增即切到「复核」标签。
   *
   * 为什么用 nonce 而不是 boolean：用户可能连续点两次第 4 步，
   * boolean 第二次不会触发 effect（值没变）。
   */
  peekReview?: number
}

export default function RightPanel({ peekReview = 0 }: Props) {
  const gaps = useAppStore((s) => s.gaps)
  const selectedId = useAppStore((s) => s.selectedId)
  const deleteGap = useAppStore((s) => s.deleteGap)
  const setGapClass = useAppStore((s) => s.setGapClass)
  const estimateResult = useAppStore((s) => s.estimateResult)
  const selectedIds = useAppStore((s) => s.selectedIds)
  const [help, setHelp] = useState(false)
  // 默认停在「复核」：打开应用时右面板若显示"请点选多边形"就是一块死面板，
  // 而复核清单是进来就有用的东西。
  const [tab, setTab] = useState<'props' | 'review'>('review')
  /** 有选中项才显示「属性」标签 —— 没选中时它是一块空面板，不如不出现 */
  const hasSelection = selectedIds.length > 0

  // 一旦选中要素，自动切到属性 —— 这是用户点它的意图
  useEffect(() => {
    if (hasSelection) setTab('props')
  }, [hasSelection])

  // 选中被清空（点空白 / 删除 / Esc）→ 属性标签已经不存在了，必须切回复核，
  // 否则会停在一个渲染不出来的空标签上（白面板）
  useEffect(() => {
    if (!hasSelection) setTab('review')
  }, [hasSelection])

  // 步进器点「复核」→ 切到复核清单（跳过 hasSelection 的自动切属性）
  useEffect(() => {
    if (peekReview > 0) setTab('review')
  }, [peekReview])

  const feat = gaps.find((f) => f.properties.gap_id === selectedId)
  const est = estimateResult?.per_gap.find((r) => r.gap_id === selectedId)

  return (
    <aside className="panel right">
      <div className="panel-head tabs">
        {/* 顺序：复核在左（进来就用）、属性在右（选中才出现） */}
        <button className={tab === 'review' ? 'tab active' : 'tab'} onClick={() => setTab('review')}>
          复核
          <span className="tab-n">{gaps.length}</span>
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
      </div>

      {tab === 'review' && <ReviewList />}

      {tab === 'props' && selectedIds.length > 1 && (
        <div className="multi-hint">
          <b>已选中 {selectedIds.length} 块</b>
          <p className="dim">
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
