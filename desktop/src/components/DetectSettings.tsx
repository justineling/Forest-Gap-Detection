import { useEffect, useRef, useState, type ReactNode } from 'react'
import { recommendWorkers, useAppStore } from '../store/useAppStore'
import {
  CHM_CORE_MAX,
  CHM_CORE_MIN,
  CHM_DEFAULT,
  CHM_MIN_VETO,
  CHM_PRESETS,
  CHM_STEP,
  chmError,
  clampChm,
  isDefaultChm,
  matchPreset,
  presetByKey,
} from '../lib/chm'
import type { ChmPreset } from '../lib/chm'

const WORKERS = [
  { v: 1, label: '1', hint: '串行，最稳但最慢' },
  { v: 2, label: '2', hint: '低配机器推荐' },
  { v: 4, label: '4', hint: '默认，8 核机器约 2.4×' },
  { v: 6, label: '6', hint: '最快，内存要 8 GB 以上' },
]

const DENSITY = [
  { v: 120, label: '120', hint: '偏稀，株位空缺判得更严' },
  { v: 150, label: '150', hint: '本项目实测密度 161.7，取整口径' },
  { v: 180, label: '180', hint: '偏密，会把零星缺株也标出来' },
]

/**
 * 每个参数分组下面的一句兜底提示。
 *
 * 为什么单独做一个组件而不是散着写 `<div className="ds-default">`：
 * 这句话要在**每一组**都出现，且必须是同一个语气（"不知道就保持默认"）——
 * 写散了就会变成有的组说"建议保持默认"、有的组说"一般不用改"，
 * 用户反而更拿不准。样式也统一走 `.ds-default`（比 `.ds-hint` 更弱）。
 */
function DefaultHint({ children }: { children: ReactNode }) {
  return <div className="ds-default">{children}</div>
}

/**
 * 检测参数（齿轮按钮弹出）。
 *
 * 只暴露**会改变结果或耗时**的开关，其余 40 多个算法参数一律不给 ——
 * 用户调不动的旋钮不如不给。
 *
 * 林龄档位对应缺陷台账 P1-3：CHM 阈值原本硬编码 5.2 / 1.2，只在单一成熟园区
 * 用 5 个真值点标定过。换到幼龄林会大面积误判，而自动标定需要标注验证集
 * （当前 0 个）—— 所以先给现场一个可调的旋钮。
 */
export default function DetectSettings({
  onClose,
  onStart,
}: {
  onClose: () => void
  /**
   * 从「开始检测」/ 步进器第 ③ 步进入时传入：底部出现「开始检测」按钮。
   * 不传就是纯编辑模式（从「⋯ 更多 → 检测参数」进来），点 ✕ / 「关闭」即可关掉。
   *
   * 由谁决定传不传：App 的 `settingsIntent`（见 `openSettings` / `closeSettings`）。
   * 关窗时 App 会把它复位成 `'edit'`，所以"这次带不带主按钮"不会漏到下一次。
   */
  onStart?: () => void
}) {
  const p = useAppStore((s) => s.detectParams)
  const setParam = useAppStore((s) => s.setDetectParam)
  const setChmPreset = useAppStore((s) => s.setChmPreset)
  const resetDetectParams = useAppStore((s) => s.resetDetectParams)
  const pushLog = useAppStore((s) => s.pushLog)
  const roi = useAppStore((s) => s.roi)

  /**
   * 「已恢复推荐值」的轻量反馈。
   *
   * 刻意**不弹确认框**：参数随时能再改回去，多一次确认只是烦。
   * 也刻意**不新造 toast 组件**：这里只需要一句 2 秒后自己消失的小字，
   * 顺便往状态栏日志里记一条（那条日志是持久的，事后能查）。
   */
  const [flash, setFlash] = useState(false)
  const flashTimer = useRef<number | null>(null)

  /** 清掉待触发的定时器（重复点击 / 卸载时必须清，否则会对已卸载组件 setState） */
  const clearFlashTimer = (): void => {
    if (flashTimer.current !== null) {
      window.clearTimeout(flashTimer.current)
      flashTimer.current = null
    }
  }

  useEffect(() => clearFlashTimer, [])

  const onReset = (): void => {
    resetDetectParams()
    // 日志里留一条：参数直接改变判定结果，事后要能查"什么时候恢复过"
    pushLog('检测参数已恢复推荐值')
    setFlash(true)
    clearFlashTimer()
    flashTimer.current = window.setTimeout(() => {
      setFlash(false)
      flashTimer.current = null
    }, 2000)
  }

  const curWorkers = WORKERS.find((w) => w.v === p.workers) ?? WORKERS[2]
  const curDensity = DENSITY.find((d) => d.v === p.targetDensity) ?? DENSITY[1]
  /** 当前档位就是这台电脑的推荐档 → hint 里点明"已经帮你选好了" */
  const workersRecommended = p.workers === recommendWorkers()

  const activePreset = matchPreset(p.chmCore, p.chmVeto)
  const activeSpec = presetByKey(activePreset)
  const err = chmError(p.chmCore, p.chmVeto)
  const nonDefault = !isDefaultChm(p.chmCore, p.chmVeto)

  /** 拖救援线：以它为准，否决线让步（否则滑块会被"粘住"，手感很差） */
  const onCore = (v: number) => {
    const r = clampChm(v, p.chmVeto, 'core')
    setParam({ chmCore: r.core, chmVeto: r.veto, chmPreset: matchPreset(r.core, r.veto) })
  }
  /** 拖否决线：以它为准，救援线让步 */
  const onVeto = (v: number) => {
    const r = clampChm(p.chmCore, v, 'veto')
    setParam({ chmCore: r.core, chmVeto: r.veto, chmPreset: matchPreset(r.core, r.veto) })
  }

  return (
    <div className="detect-settings" role="dialog" aria-label="检测参数">
      <div className="ds-head">
        <b>检测参数</b>
        <div className="ds-head-actions">
          {/* 「恢复推荐值」是次要动作：调乱了才用得上，所以放标题行右侧、用 tiny 按钮，
              不占正文的视觉重量。点击后不弹确认（随时能再改回去）。 */}
          <button
            className="btn tiny"
            onClick={onReset}
            title="把下面所有参数恢复成软件为这台电脑推荐的值"
          >
            恢复推荐值
          </button>
          <button className="btn tiny" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
      </div>

      {/* 恢复后的轻量反馈：2 秒后自动消失，不打断操作（aria-live 让读屏也能听到） */}
      {flash && (
        <div className="ds-flash" role="status" aria-live="polite">
          已恢复推荐值
        </div>
      )}

      {/*
        顶部一行"当前这套值"。
        参数是持久化的（localStorage），所以"上次使用"其实就是"这次会用"——
        写在这里是为了让用户一眼确认"我现在用的是这套"，而不是翻五个控件
        自己拼一遍。标题写「上次使用」而不是「当前设置」，是因为从「更多 →
        检测参数」进来时用户的心理是"上次那套还在不在"。
      */}
      <div className="ds-current" title="参数会记住，所以这就是这次检测会用的值">
        上次使用：{p.workers} 进程 · 密度 {p.targetDensity} · CHM 核心{' '}
        {p.chmCore.toFixed(1)} / 否决 {p.chmVeto.toFixed(1)}
      </div>

      {/* ---------- 林龄档位 ---------- */}
      <div className="ds-row">
        <span className="ds-label">
          林龄档位
          <span className="ds-sub">决定「多高才算树」</span>
        </span>
        <div className="seg">
          {CHM_PRESETS.map((spec) => (
            <button
              key={spec.key}
              className={activePreset === spec.key ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setChmPreset(spec.key as ChmPreset)}
              title={`${spec.realHeight}｜救援 ${spec.core} m / 否决 ${spec.veto} m`}
            >
              {spec.label}
            </button>
          ))}
        </div>
        <div className="ds-hint">
          {activeSpec
            ? `${activeSpec.realHeight}｜${activeSpec.hint}`
            : `自定义：救援 ${p.chmCore.toFixed(1)} m / 否决 ${p.chmVeto.toFixed(1)} m`}
        </div>
        <DefaultHint>不确定就保持「成熟林」—— 只有换到中龄 / 幼龄园区才需要改。</DefaultHint>
      </div>

      {/* ---------- 两条阈值滑块 ---------- */}
      <div className="ds-row">
        <div className="ds-slider-head">
          <span className="ds-slider-label">
            CHM 救援线
            <span className="ds-sub">≥ 这个高度 → 判为树</span>
          </span>
          <span className="ds-slider-val mono">{p.chmCore.toFixed(1)} m</span>
        </div>
        <input
          type="range"
          className="ds-range"
          min={CHM_CORE_MIN}
          max={CHM_CORE_MAX}
          step={CHM_STEP}
          value={p.chmCore}
          onChange={(e) => onCore(Number(e.target.value))}
          aria-label="CHM 救援线（米）"
        />

        <div className="ds-slider-head" style={{ marginTop: 10 }}>
          <span className="ds-slider-label">
            CHM 否决线
            <span className="ds-sub">&lt; 这个高度 → 判为非树</span>
          </span>
          <span className="ds-slider-val mono">{p.chmVeto.toFixed(1)} m</span>
        </div>
        <input
          type="range"
          className="ds-range"
          min={CHM_MIN_VETO}
          max={Math.max(CHM_MIN_VETO, p.chmCore - 0.5)}
          step={CHM_STEP}
          value={p.chmVeto}
          onChange={(e) => onVeto(Number(e.target.value))}
          aria-label="CHM 否决线（米）"
        />

        {err && <div className="ds-err">{err}</div>}

        {nonDefault && !err && (
          <div className="ds-note">
            非当前基线。改阈值会让已算好的分块结果失效 —— <b>需要重跑</b>
            （全量约 6 分钟），旧的分块结果不再复用。
          </div>
        )}

        <DefaultHint>
          不确定就别动这两条线：救援 {CHM_DEFAULT.core.toFixed(1)} m / 否决{' '}
          {CHM_DEFAULT.veto.toFixed(1)} m 是标定过的基线。
        </DefaultHint>
      </div>

      {/* ---------- 并行与密度 ---------- */}
      <div className="ds-row">
        <span className="ds-label">并行进程数</span>
        <div className="seg">
          {WORKERS.map((w) => (
            <button
              key={w.v}
              className={p.workers === w.v ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setParam({ workers: w.v })}
              title={w.hint}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="ds-hint">
          {curWorkers.hint}
          {workersRecommended ? '（已按你的电脑推荐）' : ''}
        </div>
        <DefaultHint>不确定就保持默认：软件按你这台电脑的核数挑过了。</DefaultHint>
      </div>

      <div className="ds-row">
        <span className="ds-label">目标密度（株/公顷）</span>
        <div className="seg">
          {DENSITY.map((d) => (
            <button
              key={d.v}
              className={p.targetDensity === d.v ? 'seg-btn active' : 'seg-btn'}
              onClick={() => setParam({ targetDensity: d.v })}
              title={d.hint}
            >
              {d.label}
            </button>
          ))}
        </div>
        <div className="ds-hint">{curDensity.hint}</div>
        <DefaultHint>不确定就保持 150：这是本项目实测密度取整后的口径。</DefaultHint>
      </div>

      <div className="ds-row">
        <label className="chk">
          <input
            type="checkbox"
            checked={p.useRoi}
            disabled={!roi}
            onChange={(e) => setParam({ useRoi: e.target.checked })}
          />
          <span>只检测圈选范围</span>
        </label>
        <div className="ds-hint">
          {roi
            ? '开启后只跑圈内区域（实测 528 → 121 块，350 秒 → 195 秒）'
            : '还没有圈选，此项无效（先点「① 圈选 Target Block」）'}
        </div>
        <DefaultHint>不确定就勾上：圈过范围时只分析圈内，快得多。</DefaultHint>
      </div>

      <div className="ds-foot dim">
        参数会记住，下次打开沿用。改「并行进程数」不会让已算好的部分失效。
      </div>
      {/* ⚠️ 这段说明不是废话，是"取消语义"的一部分（2026-10-24）：
          每个控件都直接 `setDetectParam(...)` 并即时持久化，所以底部那个按钮
          **不能叫「取消」** —— 它不会回滚任何改动，叫取消就是骗人。
          现在按钮叫「关闭」，回滚的入口明确指向「恢复推荐值」。
          为什么不真做回滚：参数可能正被一次运行中的检测读着，回滚会造出
          "界面显示的参数 ≠ 这次检测实际用的参数"，比多点一次糟得多。 */}
      <div className="ds-foot dim">
        改动会立即生效并记住；想回到默认值点「恢复推荐值」。
      </div>
      {onStart && (
        <div className="ds-actions">
          <button className="btn" onClick={onClose} title="关闭（改动已生效，不需要确认）">
            关闭
          </button>
          <button className="btn primary" onClick={onStart}>
            开始检测
          </button>
        </div>
      )}
    </div>
  )
}
