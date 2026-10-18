import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { ALL_CLASSES, CLASS_STYLES } from '../lib/classes'
import type { GapClass } from '../types'

/**
 * 批量操作栏（选中 ≥ 1 块时浮在地图底部）。
 *
 * 三个设计点：
 * 1. **显示合计面积**：用户框选一片时最想知道"这一片一共多少 m²"，
 *    因为它直接决定要不要改判成"非种植区"。
 * 2. **改判默认选「非种植区」**：最高频的批量操作是"这一片其实不是空地"，
 *    默认值就放在那儿，少一次点击。
 * 3. **一次操作 = 一步撤销**：走 store 的 `batchSetClass` / `batchDeleteGaps`，
 *    它们各自只压一个快照。否则框选 40 块删除后要按 40 次 Ctrl+Z。
 */
export default function BatchBar() {
  const selectedIds = useAppStore((s) => s.selectedIds)
  const gaps = useAppStore((s) => s.gaps)
  const batchSetClass = useAppStore((s) => s.batchSetClass)
  const batchDeleteGaps = useAppStore((s) => s.batchDeleteGaps)
  const clearSelection = useAppStore((s) => s.clearSelection)
  const [cls, setCls] = useState<GapClass>('undeveloped')

  if (selectedIds.length === 0) return null

  const pick = new Set(selectedIds)
  const picked = gaps.filter((f) => pick.has(f.properties.gap_id))
  const area = picked.reduce((a, f) => a + (f.properties.area_sqm ?? 0), 0)

  // 选中项可能跨多个类别 —— 显示出来，避免用户以为选中的都是同一类
  const byClass = new Map<GapClass, number>()
  for (const f of picked) byClass.set(f.properties.class, (byClass.get(f.properties.class) ?? 0) + 1)

  return (
    <div className="batch-bar" role="toolbar" aria-label="批量操作">
      <div className="bb-info">
        <b>已选 {picked.length} 块</b>
        <span className="dim">合计 {Math.round(area).toLocaleString()} m²</span>
        {byClass.size > 1 && (
          <span className="bb-mix">
            {[...byClass.entries()]
              .map(([c, n]) => `${CLASS_STYLES[c].label} ${n}`)
              .join(' · ')}
          </span>
        )}
      </div>

      <div className="bb-actions">
        <span className="dim">改为</span>
        <select value={cls} onChange={(e) => setCls(e.target.value as GapClass)}>
          {ALL_CLASSES.map((c) => (
            <option key={c} value={c}>
              {CLASS_STYLES[c].label}
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={() => batchSetClass(selectedIds, cls)}>
          应用改判
        </button>
        <button
          className="btn danger"
          onClick={() => batchDeleteGaps(selectedIds)}
          title="一次撤销即可全部恢复（Ctrl+Z）"
        >
          删除
        </button>
        <button className="btn tiny" onClick={clearSelection} title="Esc">
          取消选择
        </button>
      </div>
    </div>
  )
}
