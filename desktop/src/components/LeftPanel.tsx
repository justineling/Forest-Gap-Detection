import { useAppStore } from '../store/useAppStore'
import { ALL_CLASSES, CLASS_STYLES, GROUP_META, GROUP_ORDER } from '../lib/classes'
import { CLEARANCE_PRESETS } from '../lib/estimate'
import type { GapClass, PriorityGroup } from '../types'

export default function LeftPanel() {
  const gaps = useAppStore((s) => s.gaps)
  const visibleClasses = useAppStore((s) => s.visibleClasses)
  const toggleClass = useAppStore((s) => s.toggleClass)
  const setGroupVisible = useAppStore((s) => s.setGroupVisible)
  const select = useAppStore((s) => s.select)
  const clearanceM = useAppStore((s) => s.clearanceM)
  const setClearance = useAppStore((s) => s.setClearance)

  const stats = new Map<GapClass, { n: number; area: number }>()
  for (const c of ALL_CLASSES) stats.set(c, { n: 0, area: 0 })
  for (const f of gaps) {
    const s = stats.get(f.properties.class)
    if (!s) continue
    s.n += 1
    s.area += f.properties.area_sqm ?? 0
  }

  const byGroup = (g: PriorityGroup) =>
    ALL_CLASSES.filter((c) => CLASS_STYLES[c].group === g).reduce(
      (acc, c) => {
        const s = stats.get(c)!
        return { n: acc.n + s.n, area: acc.area + s.area }
      },
      { n: 0, area: 0 },
    )

  const definite = byGroup('definite_plant')

  return (
    <aside className="panel left">
      <div className="panel-head">
        <h3>图层与类别</h3>
        <span className="dim">{gaps.length} 个多边形</span>
      </div>

      <div className="card kpi-card">
        <div className="kpi-row">
          <span>确定需补种</span>
          <b>{definite.n} 块</b>
        </div>
        <div className="kpi-row">
          <span>面积</span>
          <b>{Math.round(definite.area).toLocaleString()} m²</b>
        </div>
        <div className="kpi-hint">
          默认只勾选「连片空地 + 株位空缺」—— 这是可直接用于苗木量的口径
        </div>
      </div>

      <div className="groups">
        {GROUP_ORDER.map((g) => {
          const classes = ALL_CLASSES.filter((c) => CLASS_STYLES[c].group === g)
          if (classes.length === 0) return null
          const sum = byGroup(g)
          const allOn = classes.every((c) => visibleClasses[c])
          return (
            <section key={g} className="group">
              <div className="group-head">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={(e) => setGroupVisible(g, e.target.checked)}
                  />
                  <b>{GROUP_META[g].label}</b>
                </label>
                <span className="dim mono">
                  {sum.n} / {Math.round(sum.area).toLocaleString()} m²
                </span>
              </div>
              <div className="group-hint">{GROUP_META[g].hint}</div>
              <ul className="cls-list">
                {classes.map((c) => {
                  const s = stats.get(c)!
                  const on = visibleClasses[c]
                  return (
                    <li key={c}>
                      <label className="chk">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleClass(c)}
                        />
                        <span
                          className="swatch"
                          style={{ background: CLASS_STYLES[c].color }}
                        />
                        <span className="cls-label">{CLASS_STYLES[c].label}</span>
                      </label>
                      <span className="dim mono">
                        {s.n} · {Math.round(s.area).toLocaleString()}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}
      </div>

      <div className="card est-params">
        <div className="est-params-head">
          <b>排坑退让距离</b>
          <span className="mono accent">{clearanceM.toFixed(1)} m</span>
        </div>
        <div className="seg">
          {CLEARANCE_PRESETS.map((p) => (
            <button
              key={p.value}
              className={clearanceM === p.value ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setClearance(p.value)}
              title={p.hint}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="kpi-hint">
          {CLEARANCE_PRESETS.find((p) => p.value === clearanceM)?.hint}
        </div>
      </div>

      <div className="panel-foot">
        <button className="btn tiny" onClick={() => select(null)}>
          取消选中
        </button>
      </div>
    </aside>
  )
}
