import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { CLASS_STYLES } from '../lib/classes'
import {
  REVIEW_KIND_LABEL,
  filterReviewGaps,
  reviewCounts,
  type ReviewKind,
} from '../lib/selection'

const KINDS: ReviewKind[] = ['all', 'uncertain', 'edited', 'manual']
const AREAS = [
  { v: 0, label: '不限' },
  { v: 100, label: '≥100' },
  { v: 500, label: '≥500' },
  { v: 1000, label: '≥1000' },
]
/** 一次最多渲染多少行 —— 1,726 行全渲染会让面板滚动明显卡顿 */
const MAX_ROWS = 200

/**
 * 复核清单。
 *
 * 核心思路是**二八定律**：按面积降序，先清大的。
 * 前 30 个大斑块通常占 80% 的争议面积 —— 从大到小过一遍，比随机点效率高一个量级。
 *
 * 点击任意一行 → 自动打开该类别 → 选中 → 地图飞过去。
 * 「待复核」类默认是隐藏的，所以**必须先 ensureVisible**，否则飞过去也看不见。
 */
export default function ReviewList() {
  const gaps = useAppStore((s) => s.gaps)
  const visibleClasses = useAppStore((s) => s.visibleClasses)
  const focusGap = useAppStore((s) => s.focusGap)
  const ensureVisible = useAppStore((s) => s.ensureVisible)
  const selectedIds = useAppStore((s) => s.selectedIds)
  const [kind, setKind] = useState<ReviewKind>('all')
  const [minArea, setMinArea] = useState(0)

  const counts = reviewCounts(gaps)
  const list = filterReviewGaps(gaps, { kind, minArea })
  const shown = list.slice(0, MAX_ROWS)
  const picked = new Set(selectedIds)

  if (gaps.length === 0) {
    return (
      <div className="empty">
        <p>还没有检测结果。</p>
        <p className="dim">点「② 开始检测」跑一遍，或「载入检测结果」读已有文件。</p>
      </div>
    )
  }

  return (
    <div className="review">
      <div className="rv-filter">
        {KINDS.map((k) => (
          <button
            key={k}
            className={kind === k ? 'chip active' : 'chip'}
            onClick={() => setKind(k)}
            title={
              k === 'uncertain'
                ? '证据不足、需要人工确认的块 —— 优先清这些'
                : k === 'edited'
                  ? '你手工改过类别或边界的块'
                  : k === 'manual'
                    ? '你手工补画的块'
                    : '全部多边形'
            }
          >
            {REVIEW_KIND_LABEL[k]}
            <span className="chip-n">{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="rv-row-filter">
        <span className="dim">最小面积</span>
        <div className="seg">
          {AREAS.map((a) => (
            <button
              key={a.v}
              className={minArea === a.v ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setMinArea(a.v)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <span className="dim mono">降序</span>
      </div>

      {list.length === 0 ? (
        <div className="empty">
          <p>这个条件下没有块。</p>
          <p className="dim">换个筛选条件，或把最小面积调小。</p>
        </div>
      ) : (
        <>
          <ul className="rv-list">
            {shown.map((f) => {
              const p = f.properties
              const st = CLASS_STYLES[p.class]
              const hidden = !visibleClasses[p.class]
              return (
                <li key={p.gap_id}>
                  <button
                    className={picked.has(p.gap_id) ? 'rv-item active' : 'rv-item'}
                    onClick={() => {
                      ensureVisible(p.class)
                      focusGap(p.gap_id)
                    }}
                    title={hidden ? '该类别当前隐藏，点击会自动打开' : '点击定位到这块'}
                  >
                    <span className="rv-swatch" style={{ background: st.color }} />
                    <span className="rv-area">{(p.area_sqm ?? 0).toLocaleString()} m²</span>
                    <span className="rv-cls">
                      {st.label}
                      {hidden && <span className="rv-hidden">隐藏</span>}
                    </span>
                    {/* 算法 id 形如 r038912_c020480-G0001，全显示会把类别名挤没。
                        只留尾段，完整 id 放进 title */}
                    <span className="rv-id mono" title={p.gap_id}>
                      {p.gap_id.split('-').pop()}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {list.length > MAX_ROWS && (
            <div className="rv-more dim">
              还有 {list.length - MAX_ROWS} 块未显示 —— 用「最小面积」缩小范围，或按类别筛选
            </div>
          )}
        </>
      )}
    </div>
  )
}
