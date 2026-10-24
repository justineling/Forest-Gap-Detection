import { useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { exportBundle, isTauri, openPath, pickOutputDir, type ExportResponse } from '../api/backend'
import { polygonAreaM2 } from '../lib/geometry'
import { countClasses, describeExportPlan } from '../lib/exportPreview'
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
  const markWorkflow = useAppStore((s) => s.markWorkflow)
  const pushLog = useAppStore((s) => s.pushLog)

  const [dir, setDir] = useState(outputDir)
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<ExportResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)

  /**
   * 「点导出之前」的预览。
   *
   * 数字全部来自 `lib/exportPreview.ts`（纯函数、有单测），它对着
   * `scripts/tile_server.py::export_bundle()` 的实际产出清单逐项对齐 ——
   * 不写死任何"21 个文件"这类数字，因为**按类别分包的文件数随数据变化**。
   *
   * 计算放在渲染里而不是 `useMemo`：`gaps` 变化本来就整块重渲染，
   * 而且这里没有昂贵运算（一次 Set 去重）。**注意：不能加在任何 early return 之后。**
   */
  const plan = describeExportPlan({
    gapCount: gaps.length,
    classCount: countClasses(gaps),
    hasGrid: !!plantingGrid?.plant_pitch_m,
  })

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
      // ★ 第 ⑤ 步的完成位就在这里置上 —— 而且**只能**在这里。
      //
      // 为什么不能放在"点了导出按钮"那一刻：导出会失败（目录没权限、磁盘满、
      // 后端没起来），失败的导出不能算"已交付"。所以它必须待在
      // `out.ok !== false` 之后 —— 也就是后端确认文件已经落盘之后。
      //
      // 为什么必须有这一句：`workflow.exported` 以前**从来没有上游**，
      // 于是第 ⑤ 步永远不算完成、卡片永远停在「导出交付包」，
      // 而 `lib/workflow.ts` 里 `isStepDone('review')` 的 `|| exported`
      // 也是一条永远走不到的死分支。判定逻辑本身是对的，缺的是喂值。
      markWorkflow({ exported: true })
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

        {/* 「这次会生成什么」——必须在点导出**之前**就能看到。
            以前只有导出完成之后才列文件名，用户不知道会得到几个、放在哪，
            于是反复点了又点，每次都要等几十秒。 */}
        <div className="exp-plan">
          <div className="exp-plan-head">
            <b>这次会生成什么</b>
            <span className="dim">
              共 <b className="exp-plan-total">{plan.totalFiles}</b> 个文件
              {gaps.length > 0 ? ` · 基于当前 ${gaps.length.toLocaleString()} 块结果` : ''}
            </span>
          </div>
          <ul className="exp-plan-list">
            {plan.groups.map((g) => (
              <li key={g.key} className={g.files === 0 ? 'exp-plan-item off' : 'exp-plan-item'}>
                <span className="exp-plan-num">{g.files}</span>
                <span className="exp-plan-body">
                  <span className="exp-plan-label">
                    {g.label}
                    {/* 「随数据变化」这个标记很重要：不标的话用户会以为
                        "按类别分包 5 个"是写死的，下次换张影像又变成 3 个就要来问。 */}
                    {g.variable && <span className="exp-plan-var">随数据变化</span>}
                  </span>
                  <span className="exp-plan-detail dim">{g.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          {plan.skipped.length > 0 && (
            <div className="exp-plan-skip">⚠️ 会跳过：{plan.skipped.join('；')}</div>
          )}
          <div className="exp-plan-where dim">
            全部写进：<span className="mono">{dir || 'output/desktop-export'}</span>
            （按类别分包的在 <span className="mono">by-class</span> 子文件夹里）
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
