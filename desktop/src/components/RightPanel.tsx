import { useAppStore } from '../store/useAppStore'
import { ALL_CLASSES, CLASS_STYLES } from '../lib/classes'
import type { GapClass } from '../types'

export default function RightPanel() {
  const gaps = useAppStore((s) => s.gaps)
  const selectedId = useAppStore((s) => s.selectedId)
  const deleteGap = useAppStore((s) => s.deleteGap)
  const setGapClass = useAppStore((s) => s.setGapClass)
  const estimateResult = useAppStore((s) => s.estimateResult)

  const feat = gaps.find((f) => f.properties.gap_id === selectedId)
  const est = estimateResult?.per_gap.find((r) => r.gap_id === selectedId)

  return (
    <aside className="panel right">
      <div className="panel-head">
        <h3>属性</h3>
        {feat && <span className="mono dim">{feat.properties.gap_id}</span>}
      </div>

      {!feat && (
        <div className="empty">
          <p>在地图上点选一个多边形查看属性。</p>
          <p className="dim">
            支持拖拽顶点改边界、按 <kbd>Delete</kbd> 删除、用工具栏「➕ 新增空地」补画。
          </p>
        </div>
      )}

      {feat && (
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

      {estimateResult && (
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
          <div className="dim">已在地图上标出 {estimateResult.points.length} 个补种点位</div>
        </div>
      )}
    </aside>
  )
}
