import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import HelpDialog from './HelpDialog'
import { LEFT_HELP } from '../lib/helpContent'
import { ALL_CLASSES, CLASS_STYLES, GROUP_META, GROUP_ORDER } from '../lib/classes'
import { CLEARANCE_PRESETS } from '../lib/estimate'
import type { GapClass, PriorityGroup } from '../types'

interface Props {
  /** 折叠成 28px 竖轨（窄窗自动折叠 / 用户手点） */
  collapsed?: boolean
  onToggle?: () => void
}

export default function LeftPanel({ collapsed = false, onToggle }: Props) {
  const [help, setHelp] = useState(false)
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
  /**
   * 还没有结果（检测前 / 刚换影像）。
   *
   * 此时 288px 的主位原来在报「0 块 / 0 m²」，外加 4 个分组各写一遍「0 块 · 0 m²」——
   * 而这一刻用户唯一要做的是点命令条的「开始检测」。零读数不是决策数据，
   * 是"决策区被占满"。所以：读数块换成一句说明，分组计数与面积全部收起，
   * **复选框保留**（跑之前就要设可见性）。
   */
  const empty = gaps.length === 0

  /**
   * 折叠态：**面板不消失，收成 28px 竖轨**。
   *
   * 为什么必须留轨而不是 `display:none`：≤1180px 时它会自动折叠，没有可见入口
   * 用户会以为"图例功能没了"。竖轨宽度与命令条折叠态一致（28px），
   * 属于同一套"收起"语法 —— 界面上只有一种"被收起来"的样子。
   *
   * 中文竖排用 `writing-mode: vertical-rl` 是正常排版（不是旋转的拉丁文字），
   * 但**计数**与展开按钮仍保持水平可读，避免"读一个数字要歪头"。
   */
  if (collapsed) {
    return (
      <aside className="panel left rail">
        <button
          type="button"
          className="pr-toggle"
          onClick={onToggle}
          title="展开「图层与类别」"
          aria-label="展开图层面板"
          aria-expanded={false}
        >
          »
        </button>
        <span className="pr-label">图层与类别</span>
        <span className="pr-n mono">{definite.n}</span>
      </aside>
    )
  }

  return (
    <aside className="panel left">
      <div className="panel-head">
        <span className="ph-idx">01</span>
        <h3 className="ph-title">图层与类别</h3>
        {/* 空态不显示 0：与下面收起的计数同一个判据，避免"标题旁边一个孤零零的 0" */}
        {!empty && <span className="ph-n mono">{gaps.length}</span>}
        <button
          type="button"
          className="ph-help"
          onClick={() => setHelp(true)}
          title="这一栏是干什么的？每个类别是什么意思？"
          aria-label="图层与类别说明"
        >
          ?
        </button>
        <button
          type="button"
          className="ph-collapse"
          onClick={onToggle}
          title="收起面板（把宽度让给地图）"
          aria-label="收起图层面板"
          aria-expanded
        >
          «
        </button>
      </div>

      {/* 读数块：一条青色顶线 + 21px 压缩体大数字 + 11px 微标签。
          不做卡片、不做四边框 —— 它和下面 4 个分组是同一张读数表的不同行。 */}
      {empty ? (
        <div className="kpi-empty">
          <b>还没有检测结果</b>
          <span>跑完检测后，这里显示需补种的块数与面积；下面的勾选决定跑完之后哪些类别显示在地图上。</span>
        </div>
      ) : (
      <div className="card kpi-card">
        <div className="kpi-row">
          <span>确定需补种</span>
          <b>
            {definite.n} <i>块</i>
          </b>
        </div>
        <div className="kpi-row">
          <span>面积</span>
          <b>
            {Math.round(definite.area).toLocaleString()} <i>m²</i>
          </b>
        </div>
        <div className="kpi-hint">
          默认只勾选「连片空地 + 株位空缺」—— 这是可直接用于苗木量的口径
        </div>
      </div>
      )}

      <div className="groups">
        {GROUP_ORDER.map((g, gi) => {
          const classes = ALL_CLASSES.filter((c) => CLASS_STYLES[c].group === g)
          if (classes.length === 0) return null
          const sum = byGroup(g)
          const allOn = classes.every((c) => visibleClasses[c])
          const isKpiGroup = g === 'definite_plant'
          return (
            <section key={g} className="group">
              {/* 分组头用"通栏填充"做容器语法，类别行用"3px 竖条"做类别语法 ——
                  两套不重叠的视觉语法，用户不用读标签就知道哪个能勾。 */}
              <div className="group-head">
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={allOn}
                    onChange={(e) => setGroupVisible(g, e.target.checked)}
                  />
                  <span className="gh-idx">{String.fromCharCode(65 + gi)}</span>
                  <b>{GROUP_META[g].label}</b>
                </label>
                {/* 「确定需补种」这一组**就是**上面读数块统计的那一组（同一个
                    口径、同一批数字）。这里再写一遍 80 块 / 88,014 m²，等于
                    同一个数据在 100px 内出现两次 —— 用户会怀疑哪个才是准的。
                    所以：KPI 组不重复计数，也不重复那句口径说明。 */}
                {!isKpiGroup && !empty && (
                  <span className="gh-sum mono">
                    {sum.n} <i>块</i> · {Math.round(sum.area).toLocaleString()} <i>m²</i>
                  </span>
                )}
              </div>
              {!isKpiGroup && <div className="group-hint">{GROUP_META[g].hint}</div>}
              <ul className="cls-list">
                {classes.map((c) => {
                  const s = stats.get(c)!
                  const on = visibleClasses[c]
                  return (
                    <li key={c}>
                      {/* 类别色只以**行左沿 3px 竖条**出现。
                          原来是「复选框 + 独立 8×8 色块」两个同形方块挨着，
                          12px 字号下会被读成两个勾选框（用户实测反馈）。 */}
                      <span
                        className="cls-bar"
                        style={{ background: CLASS_STYLES[c].color }}
                        aria-hidden
                      />
                      <label className="chk">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleClass(c)}
                          aria-label={CLASS_STYLES[c].label}
                        />
                        <span className="cls-label">{CLASS_STYLES[c].label}</span>
                      </label>
                      {/* 检测前不显示一串 0：那一列全是 0 的时候，它在视觉上就是噪声 */}
                      {!empty && (
                        <span className="cls-n mono">
                          {s.n}
                          {s.area > 0 && (
                            <>
                              {' '}
                              · {Math.round(s.area).toLocaleString()}
                            </>
                          )}
                        </span>
                      )}
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
        <div className="kpi-hint">{CLEARANCE_PRESETS.find((p) => p.value === clearanceM)?.hint}</div>
      </div>

      <div className="panel-foot">
        <button className="btn tiny" onClick={() => select(null)}>
          取消选中
        </button>
      </div>

      {help && <HelpDialog doc={LEFT_HELP} onClose={() => setHelp(false)} />}
    </aside>
  )
}
