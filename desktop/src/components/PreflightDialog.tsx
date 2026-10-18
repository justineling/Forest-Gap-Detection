import type { PreflightResult } from '../types'

interface Props {
  result: PreflightResult
  busy: boolean
  onCancel: () => void
  onProceed: () => void
  onOpenData: () => void
}

const ICON: Record<string, string> = { ok: '✓', warn: '!', error: '✕', info: 'i' }

/**
 * 检测前预检结果。
 *
 * 设计取向：**不用术语**。每一项说清"是什么 / 在哪 / 有什么后果"，
 * 并且把"能不能开始"直接写进标题 —— 用户不需要判断 severity。
 *
 * error  → 阻塞，只能去改数据
 * warn   → 不阻塞，但必须让用户确认（这些项会让结果"看起来正常但算错"）
 */
export default function PreflightDialog({
  result,
  busy,
  onCancel,
  onProceed,
  onOpenData,
}: Props) {
  const errors = result.items.filter((i) => i.status === 'error')
  const warns = result.items.filter((i) => i.status === 'warn')
  const blocked = errors.length > 0

  return (
    <div className="wizard-mask">
      <div className="wizard preflight" role="dialog" aria-modal="true">
        <div className="wizard-head">
          <h1>{blocked ? '还差一点，检测没法开始' : '这几项会让结果不准，确认一下'}</h1>
          <p className="dim">
            {blocked
              ? '下面标红的必须先解决。其余项目是检测要用的辅助文件。'
              : '不解决也能跑，但结果会偏 —— 建议先看一眼。'}
          </p>
        </div>

        <ul className="pf-list">
          {result.items.map((it) => (
            <li key={it.key} className={`pf-item ${it.status}`}>
              <span className="pf-icon">{ICON[it.status] ?? '·'}</span>
              <div className="pf-body">
                <div className="pf-line">
                  <b>{it.label}</b>
                  <span className="pf-detail">{it.detail}</span>
                </div>
                {it.path && <div className="pf-path mono">{it.path}</div>}
              </div>
            </li>
          ))}
        </ul>

        <div className="wizard-foot">
          <div className="wizard-hint dim">
            {blocked
              ? `${errors.length} 项必须解决`
              : warns.length > 0
                ? `${warns.length} 项会影响结果（不会报错，只会算偏）`
                : '全部就绪'}
          </div>
          <div className="wizard-actions">
            <button className="btn" onClick={onCancel} disabled={busy}>
              取消
            </button>
            {blocked ? (
              <button className="btn primary big" onClick={onOpenData} disabled={busy}>
                去选择数据
              </button>
            ) : (
              <button className="btn primary big" onClick={onProceed} disabled={busy}>
                {busy ? '启动中…' : '仍然开始'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
