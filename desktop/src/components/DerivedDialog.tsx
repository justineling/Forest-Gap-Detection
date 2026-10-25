import { useEffect, useRef, useState } from 'react'
import {
  isTauri,
  onDerivedEvent,
  onDerivedLog,
  preflightDerived,
  runBuildDerived,
  type DerivedParams,
} from '../api/backend'
import { useAppStore } from '../store/useAppStore'
import { useEscapeClose } from '../lib/dialogKeys'
import type { PreflightResult } from '../types'

/**
 * 「生成高度图 / 林地边界」对话框。
 *
 * ## 为什么是一个窗走完全程（预检 → 进度 → 完成）
 *
 * 这三步是**一次操作**，不是一个向导。用户点「生成」的意图是"让结果变准"，
 * 中间让他关掉预检、再看进度条、再看完成提示，等于把一次决策拆成三次。
 * 所以：同一个窗，内容随状态替换。
 *
 * ## 为什么不复用检测的进度条（DetectBar）
 *
 * 检测 350 秒、可以后台跑、用户会继续看图；生成只有 1~4 分钟且**会覆盖文件**，
 * 用户应该盯着（至少知道它在覆盖什么）。所以做成模态。
 * 但也留了「后台继续」—— 进度事件不会丢，关掉窗再打开还在。
 */

type Phase = 'checking' | 'ready' | 'running' | 'done' | 'failed'

interface ProgressState {
  stage: 'chm' | 'mask' | string
  step: number
  total: number
  ratio: number
  elapsedS: number
  message: string
}

const STAGE_LABEL: Record<string, string> = {
  chm: '① 生成高度图（CHM）',
  mask: '② 生成林地边界（森林掩膜）',
}

export default function DerivedDialog({
  imagePath,
  onClose,
}: {
  /** 当前选中的正射影像（绝对路径或相对数据根的路径） */
  imagePath: string
  onClose: () => void
}) {
  const [phase, setPhase] = useState<Phase>('checking')
  const [pf, setPf] = useState<PreflightResult | null>(null)
  const [prog, setProg] = useState<ProgressState | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  // Esc = 关闭。生成中（running）不响应 —— 中途打断会留下半个高度图，
  // 而检测读到它不会报错（只是算偏）。与点遮罩的判据保持一致。
  useEscapeClose(onClose, phase !== 'running')
  const pushLog = useAppStore((s) => s.pushLog)
  /** 最近几行日志 —— 进度比例是粗估的，真正让人安心的是"它在干什么" */
  const [tail, setTail] = useState<string[]>([])
  const startedAt = useRef<number>(0)

  // ---- 1. 打开即预检 ----
  useEffect(() => {
    let alive = true
    ;(async () => {
      setPhase('checking')
      try {
        const r = await preflightDerived({ input: imagePath })
        if (!alive) return
        setPf(r)
        setPhase('ready')
      } catch (e) {
        if (!alive) return
        setErr(e instanceof Error ? e.message : String(e))
        setPhase('failed')
      }
    })()
    return () => {
      alive = false
    }
  }, [imagePath])

  // ---- 2. 订阅事件（只要窗开着就订，running 之后的完成事件不能漏） ----
  useEffect(() => {
    let alive = true
    let unEv: (() => void) | undefined
    let unLog: (() => void) | undefined

    void onDerivedEvent((ev) => {
      const t = String(ev.event ?? '')
      if (t === 'derived_progress') {
        setProg({
          stage: String(ev.stage ?? ''),
          step: Number(ev.step ?? 0),
          total: Number(ev.total_steps ?? 2),
          ratio: Number(ev.ratio ?? 0),
          elapsedS: Number(ev.elapsed_s ?? 0),
          message: String(ev.message ?? ''),
        })
      } else if (t === 'derived_result') {
        const el = Number(ev.elapsed_s ?? prog?.elapsedS ?? 0)
        setResult(ev)
        setProg((p) => (p ? { ...p, ratio: 1, elapsedS: el } : p))
        setPhase('done')
        const mask = ev.mask_path ? '高度图 + 林地边界' : '高度图（林地边界已跳过）'
        pushLog(
          `生成完成：${mask} · 用时 ${Math.floor(el / 60)} 分 ${Math.round(el % 60)} 秒` +
            (ev.note ? ` · ${String(ev.note)}` : ''),
        )
      } else if (t === 'derived_error') {
        setErr(`[${String(ev.code ?? '-')}] ${String(ev.message ?? '')}`)
        setPhase('failed')
        pushLog(`生成失败 [${String(ev.code ?? '-')}] ${String(ev.message ?? '')}`)
      } else if (t === 'raw') {
        pushLog(`[derived] ${String(ev.line ?? '')}`)
      }
    }).then((u) => {
      if (alive) unEv = u
      else u()
    })

    void onDerivedLog((line) => {
      pushLog(`[gen] ${line}`)
      // 只留最后 4 行：这是"它在干什么"的即时反馈，不是日志面板
      setTail((prev) => [...prev.slice(-3), line])
    }).then((u) => {
      if (alive) unLog = u
      else u()
    })

    return () => {
      alive = false
      unEv?.()
      unLog?.()
    }
    // pushLog 稳定（zustand action），不放进依赖避免反复重订
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    const resolved = (pf?.resolved ?? {}) as unknown as DerivedParams
    setPhase('running')
    setErr(null)
    setResult(null)
    setTail([])
    startedAt.current = Date.now()
    const r = await runBuildDerived({ ...resolved, input: imagePath })
    if (!r.ok) {
      setErr(r.message)
      setPhase('failed')
    }
  }

  const hasError = (pf?.items ?? []).some((i) => i.status === 'error')
  const pct = Math.round((prog?.ratio ?? 0) * 100)
  const elapsed = prog?.elapsedS ?? (phase === 'running' ? 0 : 0)

  return (
    <div
      className="help-mask"
      role="dialog"
      aria-modal="true"
      aria-label="生成高度图与林地边界"
      onMouseDown={(e) => {
        // 只在"看结果 / 预检"时允许点遮罩关；正在生成时不允许（避免误触）
        if (e.target === e.currentTarget && phase !== 'running') onClose()
      }}
    >
      <div className="help-dialog derived-dialog">
        <div className="help-head">
          <div>
            <h2>生成高度图与林地边界</h2>
            <p className="help-intro">
              这两个文件决定「多高才算树」和「哪片是未开发的林子」。
              换园区、换航拍批次时必须重新生成 —— 否则检测会退化成只看颜色。
            </p>
          </div>
          <button
            type="button"
            className="help-close"
            onClick={onClose}
            disabled={phase === 'running'}
            title={phase === 'running' ? '生成中，不能关闭' : '关闭'}
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="help-body">
          {/* ---------- 预检清单 ---------- */}
          {(phase === 'checking' || phase === 'ready') && (
            <>
              {phase === 'checking' && <p className="dim">正在检查输入文件…</p>}
              <ul className="pf-list">
                {(pf?.items ?? []).map((it) => (
                  <li key={it.key} className={`pf-item ${it.status}`}>
                    <span className="pf-icon">
                      {it.status === 'ok' ? '✓' : it.status === 'error' ? '!' : it.status === 'warn' ? '!' : 'i'}
                    </span>
                    <div className="pf-body">
                      <div className="pf-line">
                        <b>{it.label}</b>
                        {it.detail && <span className="pf-detail">{it.detail}</span>}
                      </div>
                      {it.path && <div className="pf-path">{it.path}</div>}
                    </div>
                  </li>
                ))}
              </ul>
              {hasError && (
                <div className="ds-err" style={{ marginTop: 12 }}>
                  有必需文件缺失，无法生成。请把 <b>dsm.tif</b> 放到影像同一个目录，
                  或放进数据目录的 <code>output/</code> 下。
                </div>
              )}
            </>
          )}

          {/* ---------- 进度 ---------- */}
          {(phase === 'running' || phase === 'done') && (
            <div className="dv-progress">
              <div className="dv-head">
                <b>
                  {STAGE_LABEL[prog?.stage ?? 'chm'] ?? '处理中'} · {pct}%
                </b>
                <span className="dim">
                  已用 {Math.floor(elapsed / 60)} 分 {Math.round(elapsed % 60)} 秒
                </span>
              </div>
              <div className="db-track">
                <div className="db-fill" style={{ width: `${pct}%` }} />
              </div>
              {prog?.message && <div className="dv-msg">{prog.message}</div>}
              {tail.length > 0 && (
                <div className="dv-tail">
                  {tail.map((l, i) => (
                    <div key={i}>{l}</div>
                  ))}
                </div>
              )}
              {phase === 'running' && (
                <p className="dim dv-note">
                  生成期间不能关闭这个窗口 —— 中途打断会留下半个高度图，
                  而检测读到它不会报错。约 1~4 分钟。
                </p>
              )}
            </div>
          )}

          {/* ---------- 完成 / 失败 ---------- */}
          {phase === 'done' && (
            <div className="dv-done">
              <b>✓ 生成完成</b>
              <div className="kv">
                <span>高度图</span>
                <span className="mono">{String(result?.chm_path ?? '—')}</span>
              </div>
              <div className="kv">
                <span>林地边界</span>
                <span className="mono">
                  {result?.mask_path ? String(result.mask_path) : '已跳过（缺树心表）'}
                </span>
              </div>
              {typeof result?.note === 'string' && result.note && (
                <div className="ds-note">{result.note}</div>
              )}
              <div className="ds-note" style={{ marginTop: 8 }}>
                <b>下一步：</b>重跑一次检测。旧结果是用旧的高度图算的，
                直接导出会得到和现在不一致的数字。
              </div>
            </div>
          )}

          {phase === 'failed' && (
            <div className="ds-err">
              <b>生成失败</b>
              <div style={{ marginTop: 6 }}>{err}</div>
              {tail.length > 0 && <div className="dv-tail" style={{ marginTop: 8 }}>{tail.slice(-3).map((l, i) => <div key={i}>{l}</div>)}</div>}
            </div>
          )}
        </div>

        <div className="help-foot">
          <span className="dim">
            {phase === 'done'
              ? '生成的文件已在数据目录 output/ 下'
              : phase === 'running'
                ? '生成中，请稍候'
                : '生成会覆盖这张影像上次生成的高度图与林地边界'}
          </span>
          {phase === 'ready' && (
            <button className="btn primary" disabled={hasError} onClick={start}>
              开始生成
            </button>
          )}
          {phase === 'done' && (
            <button className="btn primary" onClick={onClose}>
              知道了
            </button>
          )}
          {(phase === 'ready' || phase === 'failed' || phase === 'checking') && (
            <button className="btn" onClick={onClose}>
              取消
            </button>
          )}
          {phase === 'failed' && (
            <button className="btn primary" onClick={start}>
              重试
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** 给外部判断"这个功能能不能用"（浏览器模式禁用按钮） */
export const derivedAvailable = isTauri
