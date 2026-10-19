import { useEffect, useState } from 'react'
import { isTauri, pickFile, setDataPaths, waitBackend, type AppStatus } from '../api/backend'

/**
 * 首次使用引导。
 *
 * 为什么需要它：打包版没有"仓库根"，用户不可能知道要把 3.5 GB 的影像放到
 * `%LOCALAPPDATA%\fgd\data` 这种地方，更看不懂"请运行 scripts/tile_server.py"。
 * 这里只做一件事：**用系统文件框让用户点两下选好文件**，路径记住，下次直接可用。
 *
 * 交互刻意做成"两步 + 一个大按钮"：
 *   ① 选正射影像（必填）
 *   ② 选检测结果（可跳过 —— 没有结果也能看影像、能跑检测）
 * 选完点「开始使用」→ 后端重启瓦片服务 → 前端等 /meta 就绪 → 进主界面。
 */
export default function WelcomeWizard({
  status,
  onDone,
  onCancel,
}: {
  status: AppStatus
  onDone: () => void
  /**
   * 关掉引导（不保存任何改动）。
   *
   * 为什么必须有：用户可能只是**误点**了 header 的「选择影像」——
   * 他本来就有影像、也没打算换。以前这个弹窗没有出口，只能硬着头皮重选一遍，
   * 或者关掉整个软件。这是最典型的"把人关在屋里"的交互。
   *
   * ⚠️ 取消**不能动已有配置**：本组件只在 `start()` 里调 `setDataPaths`，
   * 所以直接关掉天然安全 —— 千万别在 onCancel 里顺手写配置。
   */
  onCancel?: () => void
}) {
  const [image, setImage] = useState<string | null>(status.image)
  const [gaps, setGaps] = useState<string | null>(status.gaps)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const tauri = isTauri()

  // Esc 关闭。
  // ⚠️ 用 capture 阶段并 stopPropagation：App 里有个全局 Esc（退出绘制 / 清选中），
  //    不拦住的话按 Esc 会既关弹窗又把地图上的选中清掉。
  //    正在"启动中"时不允许关 —— 后台正在重启瓦片服务，中途关掉会留下半启动状态。
  useEffect(() => {
    if (!onCancel) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy) return
      e.stopPropagation()
      e.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel, busy])

  const choose = async (kind: 'image' | 'gaps') => {
    setErr(null)
    if (!tauri) {
      setErr('浏览器模式无法打开文件选择框，请用「启动桌面端.bat」或安装版打开。')
      return
    }
    try {
      // 选「检测结果」时直接从数据根的 output/ 打开 —— 结果文件就在那儿。
      // 选影像不指定：用户自己的照片可能在任何盘，沿用系统记忆的目录更顺手。
      //
      // ⚠️ `data_root` 在 `appStatus` 还是 null 时会是 undefined
      //    （App 用 `appStatus ?? {}` 兜底），直接 `.replace` 会抛 TypeError，
      //    被 catch 成"打开文件选择框失败：Cannot read properties of undefined"。
      //    拿不到就不指定目录，退化成系统记忆 —— 比报错好。
      const root = typeof status.data_root === 'string' ? status.data_root.trim() : ''
      const defaultPath = kind === 'gaps' && root ? `${root.replace(/[\\/]+$/, '')}/output` : undefined
      const p = await pickFile(kind, { defaultPath })
      if (!p) return
      if (kind === 'image') setImage(p)
      else setGaps(p)
    } catch (e) {
      setErr(`打开文件选择框失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const start = async () => {
    if (!image) return
    setBusy(true)
    setErr(null)
    try {
      setStage('正在保存选择并重启影像服务…')
      await setDataPaths({ image, gaps })
      setStage('正在加载影像（首次可能需要几秒建索引）…')
      const ok = await waitBackend(120_000)
      if (!ok) {
        setErr(
          '影像服务没能启动。请确认：① 文件没被其它程序占用；' +
            '② 文件是标准的 GeoTIFF；③ 磁盘剩余空间足够。',
        )
        setBusy(false)
        setStage('')
        return
      }
      setStage('就绪')
      onDone()
    } catch (e) {
      setErr(`启动失败：${e instanceof Error ? e.message : String(e)}`)
      setBusy(false)
      setStage('')
    }
  }

  const shortName = (p: string | null) => {
    if (!p) return null
    const parts = p.split(/[\\/]/)
    return parts[parts.length - 1]
  }

  return (
    <div
      className="wizard-mask"
      onMouseDown={(e) => {
        // 只认"点在遮罩上"：点卡片内部时 target 不是遮罩本身
        if (e.target === e.currentTarget && onCancel && !busy) onCancel()
      }}
    >
      <div className="wizard">
        <div className="wizard-head">
          {onCancel && (
            <button
              type="button"
              className="wizard-close"
              onClick={onCancel}
              disabled={busy}
              title={busy ? '正在启动，稍候…' : '关闭（Esc）—— 不会改动任何设置'}
              aria-label="关闭"
            >
              ×
            </button>
          )}
          <h1>开始使用</h1>
          <p className="dim">油棕园空地智能检测 · 先告诉软件你的数据在哪</p>
        </div>

        <div className="wizard-step">
          <div className="wizard-step-no">1</div>
          <div className="wizard-step-body">
            <div className="wizard-step-title">
              选择正射影像 <span className="req">必填</span>
            </div>
            <div className="dim">
              无人机拍的正射图（.tif），整个园区一张。文件较大（3~5 GB），只需选一次。
            </div>
            <div className="wizard-row">
              <button className="btn primary" onClick={() => choose('image')} disabled={busy}>
                {image ? '重新选择影像' : '选择影像文件…'}
              </button>
              {image ? (
                <span className="picked" title={image}>
                  ✓ {shortName(image)}
                </span>
              ) : (
                <span className="dim">还没有选择</span>
              )}
            </div>
          </div>
        </div>

        <div className="wizard-step">
          <div className="wizard-step-no">2</div>
          <div className="wizard-step-body">
            <div className="wizard-step-title">
              选择检测结果 <span className="opt">可选</span>
            </div>
            <div className="dim">
              之前跑出来的空地结果（.geojson）。没有就跳过 —— 选好影像后可以直接点「开始检测」。
            </div>
            <div className="wizard-row">
              <button className="btn" onClick={() => choose('gaps')} disabled={busy}>
                {gaps ? '重新选择结果' : '选择结果文件…'}
              </button>
              {gaps ? (
                <span className="picked" title={gaps}>
                  ✓ {shortName(gaps)}
                </span>
              ) : (
                <span className="dim">跳过（稍后可载入或直接检测）</span>
              )}
            </div>
          </div>
        </div>

        {err && <div className="wizard-err">{err}</div>}

        <div className="wizard-foot">
          <div className="dim wizard-hint">
            数据目录：<span className="mono">{status.data_root}</span>
            <br />
            以后想换数据，点右上角「⋯ 更多 → 更换影像或结果文件」随时改。
          </div>
          <div className="wizard-actions">
            {busy && <span className="dim">{stage}</span>}
            {onCancel && (
              <button className="btn" onClick={onCancel} disabled={busy}>
                取消
              </button>
            )}
            <button className="btn primary big" onClick={start} disabled={!image || busy}>
              {busy ? '正在启动…' : '开始使用 →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
