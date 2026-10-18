import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { exportBundle, isTauri, openPath, pickOutputDir, type ExportResponse } from '../api/backend'
import { polygonAreaM2 } from '../lib/geometry'
import type { GapCollection } from '../types'

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/**
 * 导出交付包。
 *
 * 为什么做成对话框而不是直接导出：
 * 交付包是给现场/主管的最终产物，**输出目录必须让用户确认**（默认写到
 * 程序目录下的 output/ 里，用户根本找不到）。
 *
 * 导出内容由后端 `export_arcgis.py` 权威生成（WGS84 + UTM49N 双坐标系
 * GeoJSON / Shapefile、8 分类 KML、按类别分包、放样点位、一页报告）。
 */
export default function ExportDialog({ onClose }: { onClose: () => void }) {
  const gaps = useAppStore((s) => s.gaps)
  const clearanceM = useAppStore((s) => s.clearanceM)
  const plantingGrid = useAppStore((s) => s.plantingGrid)
  const manualAdded = useAppStore((s) => s.manualAdded)
  const manualEdited = useAppStore((s) => s.manualEdited)
  const manualDeleted = useAppStore((s) => s.manualDeleted)
  const meta = useAppStore((s) => s.meta)
  const roi = useAppStore((s) => s.roi)
  const outputDir = useAppStore((s) => s.outputDir)
  const setOutputDir = useAppStore((s) => s.setOutputDir)
  const pushLog = useAppStore((s) => s.pushLog)

  const [dir, setDir] = useState(outputDir)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ExportResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const chooseDir = async () => {
    try {
      const picked = await pickOutputDir()
      if (picked) {
        setDir(picked)
        setOutputDir(picked)
      } else if (!isTauri()) {
        pushLog('浏览器模式没有文件夹对话框 —— 直接在上面填路径（桌面应用里可以点「选择」）')
      }
    } catch (e) {
      pushLog(`选择目录失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const run = async () => {
    setBusy(true)
    setErr(null)
    setRes(null)
    if (dir) setOutputDir(dir)
    try {
      const collection: GapCollection = { type: 'FeatureCollection', features: gaps }
      const out = await exportBundle({
        gaps: collection,
        outdir: dir || undefined,
        // ⚠️ 退让距离必须与界面档位一致，否则报告里的株数对不上
        clearance_m: clearanceM,
        planting_grid: plantingGrid ?? undefined,
        audit: { added: manualAdded, edited: manualEdited, deleted: manualDeleted },
        image: meta
          ? {
              name: baseName(meta.source),
              width: meta.width,
              height: meta.height,
              res_m: meta.res_m,
              crs: meta.crs,
            }
          : undefined,
        roi: {
          has_roi: !!roi,
          area_sqm: roi ? Math.round(polygonAreaM2(roi)) : 0,
        },
      })
      if (out.ok === false) throw new Error(out.error || '后端返回失败')
      setRes(out)
      pushLog(`导出完成 → ${out.outdir}（${out.files.length} 个文件）`)
      for (const f of out.files) pushLog(`  · ${baseName(f)}`)
      for (const n of out.notes ?? []) pushLog(`  ⚠️ ${n}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
      pushLog(`导出失败：${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wizard-mask">
      <div className="wizard export-dialog" role="dialog" aria-modal="true">
        <div className="wizard-head">
          <h1>导出交付包</h1>
          <p className="dim">
            生成 WGS84 / UTM49N 双坐标系 GeoJSON 与 Shapefile、8 分类 KML、按类别分包、
            放样点位，以及一份可直接打印的汇总报告。
          </p>
        </div>

        <div className="exp-row">
          <span className="exp-label">输出目录</span>
          <div className="exp-path">
            <input
              className="mono"
              value={dir}
              placeholder={isTauri() ? '点「选择」挑一个文件夹' : '留空 = 后端默认 output/desktop-export'}
              onChange={(e) => setDir(e.target.value)}
              spellCheck={false}
            />
            <button className="btn" onClick={chooseDir} disabled={busy}>
              选择…
            </button>
          </div>
          <div className="exp-hint dim">
            记住上次选择。留空则写到项目 <span className="mono">output/desktop-export/</span>。
          </div>
        </div>

        <div className="exp-summary">
          <div>
            <span className="k">要素</span>
            <b>{gaps.length.toLocaleString()} 块</b>
          </div>
          <div>
            <span className="k">退让</span>
            <b>{clearanceM.toFixed(1)} m</b>
          </div>
          <div>
            <span className="k">人工痕迹</span>
            <b>
              +{manualAdded} / ✎{manualEdited} / −{manualDeleted}
            </b>
          </div>
          <div>
            <span className="k">范围</span>
            <b>{roi ? '圈选' : '整幅'}</b>
          </div>
        </div>

        {err && <div className="wizard-err">{err}</div>}

        {res && (
          <div className="exp-result">
            <div className="exp-result-head">
              <b>✓ 导出完成</b>
              <span className="dim">
                {res.counts?.features ?? 0} 个要素 · {res.counts?.planting_points ?? 0} 个放样点 ·{' '}
                {res.files.length} 个文件
              </span>
            </div>
            <ul className="exp-files">
              {res.files.map((f) => (
                <li key={f} className="mono">
                  {f.slice(res.outdir.length).replace(/^[\\/]/, '')}
                </li>
              ))}
            </ul>
            {res.report && (
              <div className="exp-report">
                一页汇总报告：<span className="mono">{baseName(res.report)}</span>
              </div>
            )}
            {(res.notes ?? []).length > 0 && (
              <ul className="exp-notes">
                {(res.notes ?? []).map((n) => (
                  <li key={n}>⚠️ {n}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="wizard-foot">
          <div className="wizard-hint dim">
            交付包目录：<span className="mono">{res?.outdir || dir || 'output/desktop-export'}</span>
          </div>
          <div className="wizard-actions">
            <button className="btn" onClick={onClose} disabled={busy}>
              关闭
            </button>
            {res && (
              <button
                className="btn"
                onClick={() => void openPath(res.outdir)}
                disabled={!isTauri()}
                title={isTauri() ? '在资源管理器里打开' : '浏览器模式不支持'}
              >
                📂 打开文件夹
              </button>
            )}
            <button className="btn primary big" onClick={run} disabled={busy || gaps.length === 0}>
              {busy ? '导出中…' : res ? '重新导出' : '开始导出'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
