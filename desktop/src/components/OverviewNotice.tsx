import { useEffect, useRef, useState } from 'react'
import { buildOverviews, overviewPlan } from '../api/backend'
import { useAppStore } from '../store/useAppStore'
import {
  canStartBuild,
  DEMO_PLAN,
  describeAction,
  describeEstimate,
  describeSpace,
  estimateBuildSeconds,
  type OverviewPlan,
} from '../lib/overview'

/**
 * 「这张影像没有加速结构」的提示 + 一键修复。
 *
 * ## 为什么值得做（实测数字）
 *
 * 没有金字塔时，缩到远景看整片园子，**一张瓦片要 104 秒**；建好之后 0.7 秒（149×）。
 * 新用户看到的是"地图一片空白、转圈不动"，正常反应是"这软件坏了" ——
 * 而其实只差一次两分钟的处理。所以提示必须**主动**出现，不能藏在菜单里。
 *
 * ## 三个状态各解决一个顾虑
 *
 * | 状态 | 用户此刻在想什么 | 界面要回答什么 |
 * |---|---|---|
 * | 横幅 | 地图怎么这么慢 | 这不是坏了，是缺个加速结构，点这里修 |
 * | 确认框 | 会不会动我的原图？要多少盘？ | 不动原图 / 需要多少 / 空间够不够 |
 * | 进行中 | 卡死了吗？还要多久？ | 已用 N 秒 + 明确的"2~3 分钟"预期 |
 *
 * ## 为什么**没有**进度条
 *
 * 底层（gdaladdo / rasterio 的 build_overviews）都**不提供进度回调**。
 * 画一根按时间匀速爬的假条，会在真完成之前先爬到 100% 然后停住 ——
 * 那比没有进度条更让人怀疑程序挂了。所以只给"已用时"，那是真实的。
 */

type Phase = 'idle' | 'checking' | 'ready' | 'building' | 'failed'

/**
 * 截图预览参数（`?ovr=dialog` / `?ovr=fail`）。
 *
 * 为什么需要：浏览器里**点不到按钮**，headless 截图只能看首屏 —— 不这样，
 * 确认框和失败态就永远没有截图可看（本项目出过"截图绿了但界面是死的"）。
 * 桌面端的 URL 不带这个参数，所以真实流程不受影响。
 */
function previewParam(): string {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('ovr') ?? ''
}

const PREVIEW = previewParam()
const PREVIEW_FAIL_TEXT = '建立加速结构失败：找不到 gdaladdo，无法生成外置 .ovr'

export default function OverviewNotice({
  onDone,
  onDismiss,
}: {
  /** 建立成功：调用方去重新拉 `/meta`（横幅随 `has_overviews` 变 true 而消失） */
  onDone: () => void | Promise<void>
  /** 点「以后再说」：本次会话不再提醒（不写 localStorage，下次启动还该提醒） */
  onDismiss: () => void
}) {
  // 初始状态：正常是横幅；带预览参数时直接进对话框（只为截图）
  const [phase, setPhase] = useState<Phase>(() =>
    PREVIEW === 'dialog' ? 'ready' : PREVIEW === 'fail' ? 'failed' : 'idle',
  )
  const [plan, setPlan] = useState<OverviewPlan | null>(() =>
    PREVIEW === 'dialog' ? DEMO_PLAN : null,
  )
  const [err, setErr] = useState<string | null>(() =>
    PREVIEW === 'fail' ? PREVIEW_FAIL_TEXT : null,
  )
  /** 已用秒数：只在 building 时由定时器递增 */
  const [elapsed, setElapsed] = useState(0)
  const pushLog = useAppStore((s) => s.pushLog)
  const startedAt = useRef(0)

  // ---- 进行中：每秒 +1 ----
  useEffect(() => {
    if (phase !== 'building') return
    const t = window.setInterval(() => {
      setElapsed(Math.round((Date.now() - startedAt.current) / 1000))
    }, 1000)
    return () => window.clearInterval(t)
  }, [phase])

  /** 点「建立加速结构」：先干跑体检，拿到"要花多少盘、动不动原图"再问用户 */
  const openCheck = async () => {
    setPhase('checking')
    setErr(null)
    setPlan(null)
    try {
      const p = await overviewPlan()
      setPlan(p)
      setPhase('ready')
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      setPhase('failed')
    }
  }

  const start = async () => {
    setPhase('building')
    setErr(null)
    startedAt.current = Date.now()
    setElapsed(0)
    try {
      const r = await buildOverviews('auto')
      const secs = r.elapsed_s > 0 ? r.elapsed_s : Math.round((Date.now() - startedAt.current) / 1000)
      pushLog(`加速结构已建立（用时 ${Math.round(secs)} 秒）`)
      // 先把 meta 刷新完再回横幅态：否则 has_overviews 还是 false，
      // 横幅会**闪一下**才消失（用户会以为没成功）
      await onDone()
      setPhase('idle')
    } catch (e) {
      // 后端已经把真因透出来了（如"找不到 gdaladdo"），**不要**吞掉换成"失败了"
      setErr(e instanceof Error ? e.message : String(e))
      setPhase('failed')
    }
  }

  // ---- 横幅 ----
  if (phase === 'idle') {
    return (
      <div className="ovr-banner" role="status">
        <span className="ovr-banner-icon" aria-hidden="true">
          ⚠️
        </span>
        <div className="ovr-banner-text">
          <b>这张影像没有加速结构</b>
          <span className="dim">缩放到远处会很慢（实测单张瓦片约 100 秒）</span>
        </div>
        <div className="ovr-banner-actions">
          <button className="btn tiny primary" onClick={() => void openCheck()}>
            建立加速结构
          </button>
          <button className="btn tiny" onClick={onDismiss}>
            以后再说
          </button>
        </div>
      </div>
    )
  }

  const busy = phase === 'building'
  const canStart = canStartBuild(plan)

  return (
    <div
      className="help-mask"
      role="dialog"
      aria-modal="true"
      aria-label="建立加速结构"
      onMouseDown={(e) => {
        // 只在"看确认框"时允许点遮罩关；进行中不允许（防止以为没反应而重复点）
        if (e.target === e.currentTarget && !busy) setPhase('idle')
      }}
    >
      <div className="help-dialog ovr-dialog">
        <div className="help-head">
          <div>
            <h2>建立加速结构</h2>
            <p className="help-intro">
              建好之后，缩放到远景看图会快约 100 倍。只需要做一次，以后打开直接可用。
            </p>
          </div>
          <button
            type="button"
            className="help-close"
            onClick={() => setPhase('idle')}
            disabled={busy}
            title={busy ? '处理中，不能关闭' : '关闭'}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="help-body">
          {phase === 'checking' && <p className="dim">正在检查这张影像…</p>}

          {phase === 'ready' && plan && (
            <>
              <div className="ovr-line">{describeAction(plan)}</div>
              <div className={plan.enough_space ? 'ovr-line dim' : 'ovr-line warn'}>
                {describeSpace(plan)}
              </div>
              <div className="ovr-line dim">
                预计 {describeEstimate(estimateBuildSeconds(plan.size_bytes))}
                （按影像体积粗估，实际可能更久）
              </div>
              {!plan.touches_source && (
                <div className="ovr-note">不会修改你的原图。</div>
              )}
              {plan.action === 'copy' && plan.gdaladdo === null && (
                <div className="ovr-note dim">
                  装了 GDAL 可以只占约 1/3 磁盘，但当前环境没有 ——
                  所以这次会复制一份副本，建完可以随时删掉。
                </div>
              )}
              {plan.action === 'inplace' && (
                <div className="ovr-note warn">
                  这一项会直接写入原图，中途中断可能损坏文件。建议先备份原图。
                </div>
              )}
              {plan.action === 'none' && (
                <div className="ovr-note">这张影像已经处理过了，不需要再做一次。</div>
              )}
              {!plan.enough_space && (
                <div className="ovr-note warn">
                  请先腾出空间（或把影像放到另一块盘上）再试。
                </div>
              )}
            </>
          )}

          {busy && (
            <div className="ovr-building">
              <div className="ovr-spinner" aria-hidden="true" />
              <div className="ovr-building-text">
                <b>正在建立加速结构…</b>
                <span className="dim">
                  大影像首次约需 2~3 分钟，完成后看图快约 100 倍。已用 {elapsed} 秒。
                </span>
                <span className="dim">
                  处理期间请不要关闭软件 —— 中途中断会留下半成品（下次会重新开始，
                  不会损坏原图）。
                </span>
              </div>
            </div>
          )}

          {phase === 'failed' && (
            <div className="ds-err">
              <b>没能建立加速结构</b>
              {/* 用 pre 是为了让报错原文可选中复制 —— 用户要拿这句话去问人 */}
              <pre className="ovr-err-pre">{err ?? '未知原因'}</pre>
              <div className="dim" style={{ marginTop: 8 }}>
                可以把上面这段原文发给技术支持；不影响你继续看图，只是远景会慢。
              </div>
            </div>
          )}
        </div>

        <div className="help-foot">
          <span className="dim">
            {busy ? '处理中，请稍候' : phase === 'failed' ? '可以重试，也可以先关掉' : ''}
          </span>
          {phase === 'ready' && (
            <>
              <button className="btn primary" disabled={!canStart} onClick={() => void start()}>
                开始
              </button>
              <button className="btn" onClick={() => setPhase('idle')}>
                取消
              </button>
            </>
          )}
          {busy && (
            <button className="btn primary" disabled>
              处理中…
            </button>
          )}
          {phase === 'failed' && (
            <>
              <button
                className="btn primary"
                onClick={() => void (plan ? start() : openCheck())}
              >
                重试
              </button>
              <button className="btn" onClick={() => setPhase('idle')}>
                关闭
              </button>
            </>
          )}
          {phase === 'checking' && (
            <button className="btn" onClick={() => setPhase('idle')}>
              取消
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
