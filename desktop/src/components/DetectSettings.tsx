import { useAppStore } from '../store/useAppStore'
import {
  CHM_CORE_MAX,
  CHM_CORE_MIN,
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
 * 检测参数（齿轮按钮弹出）。
 *
 * 只暴露**会改变结果或耗时**的开关，其余 40 多个算法参数一律不给 ——
 * 用户调不动的旋钮不如不给。
 *
 * 林龄档位对应缺陷台账 P1-3：CHM 阈值原本硬编码 5.2 / 1.2，只在单一成熟园区
 * 用 5 个真值点标定过。换到幼龄林会大面积误判，而自动标定需要标注验证集
 * （当前 0 个）—— 所以先给现场一个可调的旋钮。
 */
export default function DetectSettings({ onClose }: { onClose: () => void }) {
  const p = useAppStore((s) => s.detectParams)
  const setParam = useAppStore((s) => s.setDetectParam)
  const setChmPreset = useAppStore((s) => s.setChmPreset)
  const roi = useAppStore((s) => s.roi)

  const curWorkers = WORKERS.find((w) => w.v === p.workers) ?? WORKERS[2]
  const curDensity = DENSITY.find((d) => d.v === p.targetDensity) ?? DENSITY[1]

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
        <button className="btn tiny" onClick={onClose} title="关闭">
          ✕
        </button>
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
            非 Stage 14 基线。改阈值会改变瓦片缓存的参数指纹 —— <b>需要重跑</b>
            （全量约 6 分钟），旧瓦片缓存不再命中。
          </div>
        )}
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
        <div className="ds-hint">{curWorkers.hint}</div>
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
            ? '开启后只跑圈内瓦片（实测 528 → 121 块，350 秒 → 195 秒）'
            : '还没有圈选，此项无效（先点「① 圈选 Target Block」）'}
        </div>
      </div>

      <div className="ds-foot dim">
        参数会记住，下次打开沿用。改「并行进程数」不会让已算好的瓦片失效。
      </div>
    </div>
  )
}
