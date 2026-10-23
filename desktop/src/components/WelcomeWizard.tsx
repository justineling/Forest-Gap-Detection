import { useEffect, useState } from 'react'
import {
  isTauri,
  pickFile,
  setDataPaths,
  tileDiagnose,
  waitBackendDetailed,
  type AppStatus,
  type TileDiag,
} from '../api/backend'
import { explain } from '../lib/tileDiag'

/**
 * 「我该准备什么」说明卡的条目。
 *
 * 为什么要把这些写在界面上：打包版没有仓库根、没有 README、没有命令行 ——
 * 用户手里只有一堆无人机文件，他不知道哪个必须给、哪个给了更好、哪个根本不用管。
 * 以前这些知识只存在于文档里，而目标用户不会去翻文档。
 *
 * 文案纪律（改的时候请守住）：
 *  · **不出现技术术语**：不写 CHM / gdaladdo / ovr / NDJSON / sidecar / 瓦片。
 *    「高度图」可以说，「CHM」不行 —— 前者他一看就懂，后者他要先查。
 *  · 每一条都要说清 **没有它会怎样**，只写「可选」等于没说。
 *    "可选"是给开发者的分类，用户要的是"我不给会损失什么"。
 */
const PREPARE_REQUIRED: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: '正射影像（.tif）',
    why: '无人机拍的那一整张园区大图。没有它软件做不了任何事 —— 检测、看图、导出都从它开始。',
  },
]

const PREPARE_OPTIONAL: ReadonlyArray<{ name: string; why: string }> = [
  {
    name: '地表高程（dsm.tif）',
    why:
      '和影像放在同一个文件夹里就行。没有它就画不出高度图，' +
      '水塘和还没长起来的幼林容易被当成空地，需要人工多复核一些。',
  },
  {
    name: '地物分类图（segment.tif）',
    why: '同样放同一文件夹。没有它水塘基本认不出来 —— 能认出的比例会从 98% 掉到 7.9%。',
  },
  {
    name: '树木清单（tree_info.json）',
    why: '只有在需要重新圈定"哪片算林地"的时候才用得上。没有它不影响检测，也不影响导出。',
  },
]

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
  /**
   * 提交成功后的回调。
   *
   * 为什么要带参数（2026-10-23 修复）：`onWizardDone` 曾经无条件按"重新开始"
   * 处理（清空界面 + 跳过紧接着的自动载入）。于是用户在**第 2 步明确选了
   * 结果文件**，提交后地图上却一个多边形都没有 —— 他指定的文件被那道闸门跳过。
   *
   * `gapsProvided` 的语义是「**用户本次在向导里主动选过结果文件**」，
   * 不是"结果文件那一栏非空"（那一栏会预填上次的路径）。
   * 三种情形见 `gapsPicked` 的注释与 `lib/gapsLoad.ts` 的 `shouldLoadAfterWizard`。
   */
  onDone: (info: { gapsProvided: boolean }) => void
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
  // ⚠️ 这两个状态**预填自上次配置**（`status.gaps` 非空时 `gaps` 一进来就有值）。
  //    所以"`gaps` 非空"**不能**当成"用户这次指定了结果文件" —— 见 gapsPicked。
  const [gaps, setGaps] = useState<string | null>(status.gaps)
  /**
   * 用户**本次**是否在向导里主动点过「选择结果文件」并选中了一个文件。
   *
   * 为什么不能直接用 `!!gaps`（2026-10-23 踩过，属于"过度纠正"的反面）：
   * `gaps` 预填自 `status.gaps`。用户点「换一张影像」打开向导时，结果文件那一栏
   * **本来就是上次那个路径**。他只改了 tif、完全没碰结果文件，`!!gaps` 依然是
   * `true` —— 于是被判定成"用户要载入这份结果"，旧结果被载回来、
   * `hasResult` 变 true、界面又跳到第 4 步。这正是 10-23 修掉的
   * 「换影像后仍跳第 4 步」（`3207e94`）。
   *
   * 判据必须是"**动作**"（点过并选中），不是"**字段非空**"（可能只是预填）。
   */
  const [gapsPicked, setGapsPicked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [err, setErr] = useState<string | null>(null)
  /** 失败时的可执行下一步（由 `explain()` 生成） */
  const [hint, setHint] = useState<string[]>([])
  /** 失败时的现场证据（外壳采集；浏览器模式为 null） */
  const [diag, setDiag] = useState<TileDiag | null>(null)

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
      // 用户按了取消 / 什么都没选 → 不算"指定过"，`gapsPicked` 保持原值
      if (!p) return
      if (kind === 'image') {
        setImage(p)
      } else {
        setGaps(p)
        // ★ 只有"真的选中了一个文件"才算用户指定过（预填不算，取消不算）
        setGapsPicked(true)
      }
    } catch (e) {
      setErr(`打开文件选择框失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const start = async () => {
    if (!image) return
    setBusy(true)
    setErr(null)
    setDiag(null)
    setHint([])
    try {
      setStage('正在保存选择并重启影像服务…')
      // ⚠️ `setDataPaths` 现在会把**硬失败**（端口被别人占、进程序拉不起来）
      //    直接抛回来，而不是吞进日志让我们空等 120 秒。所以下面 catch 里的
      //    文案是"真因"，不是猜测。
      await setDataPaths({ image, gaps })
      setStage('正在加载影像（首次可能需要几秒建索引）…')
      const r = await waitBackendDetailed(120_000)
      if (!r.ok) {
        const { title, steps } = explain(r.diag, r.foreign, 120)
        setErr(title)
        setHint(steps)
        setDiag(r.diag ?? (await tileDiagnose()))
        setBusy(false)
        setStage('')
        return
      }
      setStage('就绪')
      // ★ 带出去的是 `gapsPicked`（用户本次的动作），**不是** `!!gaps`（字段非空）。
      //   两者在"只换 tif、结果文件是预填的"这一情形下正好相反，而那正是
      //   10-23 修过的 bug（换影像后又跳第 4 步）。详见 gapsPicked 的注释。
      onDone({ gapsProvided: gapsPicked })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 外壳抛回来的就是真因；同时抓一份快照，把日志尾一起摆出来
      setErr(msg)
      setHint([
        '这是外壳在启动影像服务时当场返回的错误（不是超时后的猜测）。',
        '展开下方「技术细节」可看到服务自己的输出，连这段错误一起发给开发者即可定位。',
      ])
      setDiag(await tileDiagnose())
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

            {/* 「我该准备什么」——把"必需 / 可选、缺了会怎样"直接摆在选择框下面。
                只放在第 1 步：用户此刻正在找文件，说明卡离开这个位置就没人看了。 */}
            <div className="wiz-prep">
              <div className="wiz-prep-head">我该准备什么？</div>

              <div className="wiz-prep-group">
                <span className="wiz-prep-tag req">必需</span>
                <ul className="wiz-prep-list">
                  {PREPARE_REQUIRED.map((it) => (
                    <li key={it.name} className="wiz-prep-item">
                      <span className="wiz-prep-name">{it.name}</span>
                      <span className="wiz-prep-why">{it.why}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="wiz-prep-group">
                <span className="wiz-prep-tag opt">可选</span>
                <ul className="wiz-prep-list">
                  {PREPARE_OPTIONAL.map((it) => (
                    <li key={it.name} className="wiz-prep-item">
                      <span className="wiz-prep-name">{it.name}</span>
                      <span className="wiz-prep-why">{it.why}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="wiz-prep-foot dim">
                可选的那几个不选也能用，只是结果会差一些 —— 先点下面「开始使用」照样能跑。
              </div>
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

        {err && (
          <div className="wizard-err">
            <div className="wizard-err-title">✕ {err}</div>
            {hint.length > 0 && (
              <ul className="wizard-err-steps">
                {hint.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            )}
            {diag && (
              <details className="wizard-err-diag">
                <summary>
                  技术细节（端口 {diag.port} ·{' '}
                  {diag.port_open ? '端口有人应答' : '端口无人应答'} ·{' '}
                  {diag.ours ? '身份已确认' : '身份未确认'}
                  {diag.exit_code !== null ? ` · 退出码 ${diag.exit_code}` : ''}）
                </summary>
                <div className="mono">
                  {diag.start_error ? <div>启动错误：{diag.start_error}</div> : null}
                  <div>探活结果：{diag.probe_error || '（无）'}</div>
                  <div>子进程：{diag.child_alive ? '存活' : '已退出/未启动'}</div>
                  {diag.backend ? <div>后端：{diag.backend}</div> : null}
                  {diag.meta_head ? <div>对方应答：{diag.meta_head}</div> : null}
                  {diag.log_tail.length > 0 ? (
                    <>
                      <div>服务日志（最后 {diag.log_tail.length} 行）：</div>
                      <pre className="wizard-err-log">{diag.log_tail.join('\n')}</pre>
                    </>
                  ) : (
                    <div>服务日志：一个字都没有（进程在打印之前就退出了）</div>
                  )}
                </div>
              </details>
            )}
          </div>
        )}

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
