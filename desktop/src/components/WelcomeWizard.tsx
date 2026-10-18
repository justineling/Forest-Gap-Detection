import { useState } from 'react'
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
}: {
  status: AppStatus
  onDone: () => void
}) {
  const [image, setImage] = useState<string | null>(status.image)
  const [gaps, setGaps] = useState<string | null>(status.gaps)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const tauri = isTauri()

  const choose = async (kind: 'image' | 'gaps') => {
    setErr(null)
    if (!tauri) {
      setErr('浏览器模式无法打开文件选择框，请用「启动桌面端.bat」或安装版打开。')
      return
    }
    try {
      const p = await pickFile(kind)
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
    <div className="wizard-mask">
      <div className="wizard">
        <div className="wizard-head">
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
            以后想换数据，点右上角「数据」随时改。
          </div>
          <div className="wizard-actions">
            {busy && <span className="dim">{stage}</span>}
            <button className="btn primary big" onClick={start} disabled={!image || busy}>
              {busy ? '正在启动…' : '开始使用 →'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
