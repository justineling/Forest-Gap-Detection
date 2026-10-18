import { useAppStore } from '../store/useAppStore'

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
 * 只暴露**三个真会改变结果**的开关，其余 30 多个算法参数一律不给 ——
 * 用户调不动的旋钮不如不给。
 */
export default function DetectSettings({ onClose }: { onClose: () => void }) {
  const p = useAppStore((s) => s.detectParams)
  const setParam = useAppStore((s) => s.setDetectParam)
  const roi = useAppStore((s) => s.roi)

  const curWorkers = WORKERS.find((w) => w.v === p.workers) ?? WORKERS[2]
  const curDensity = DENSITY.find((d) => d.v === p.targetDensity) ?? DENSITY[1]

  return (
    <div className="detect-settings" role="dialog" aria-label="检测参数">
      <div className="ds-head">
        <b>检测参数</b>
        <button className="btn tiny" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

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
