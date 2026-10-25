import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store/useAppStore'
import { CLASS_STYLES } from '../lib/classes'
import {
  REVIEW_KIND_LABEL,
  filterReviewGaps,
  reviewCounts,
  type ReviewKind,
} from '../lib/selection'
import { shouldIgnoreHotkey } from '../lib/hotkeys'
import {
  DEFAULT_SEED,
  GT_LABEL_META,
  buildValidationSample,
  canConfirm,
  nextUnlabeled,
  type GtLabel,
  type GtSample,
} from '../lib/validation'

const KINDS: ReviewKind[] = ['all', 'uncertain', 'edited', 'manual']
const AREAS = [
  { v: 0, label: '不限' },
  { v: 100, label: '≥100' },
  { v: 500, label: '≥500' },
  { v: 1000, label: '≥1000' },
]
/** 一次最多渲染多少行 —— 1,726 行全渲染会让面板滚动明显卡顿 */
const MAX_ROWS = 200

/** 复核清单的两种模式 */
type Mode = 'review' | 'validation'

/**
 * 复核清单。
 *
 * 核心思路是**二八定律**：按面积降序，先清大的。
 * 前 30 个大斑块通常占 80% 的争议面积 —— 从大到小过一遍，比随机点效率高一个量级。
 *
 * 点击任意一行 → 自动打开该类别 → 选中 → 地图飞过去。
 * 「待复核」类默认是隐藏的，所以**必须先 ensureVisible**，否则飞过去也看不见。
 *
 * ## 两种模式
 *
 * | 模式 | 干什么 | 数据 |
 * |---|---|---|
 * | **复核** | 改进这一批结果（删误报、改错判） | 改 `gaps` |
 * | **验证集** | 给 150 块打**地面真值**，用来考核算法 | 只写 `validation.records`，**不动 `gaps`** |
 *
 * 两者必须分开：验证集记的是"真相"，复核改的是"结果"。
 * 如果打标时顺手把 `class` 改了，就变成"用改过的结果考核算法"——自己给自己打分。
 */
interface Props {
  /** 当前视图：清单（改结果）还是验证集（标真值）。由右面板的 tab 决定 */
  mode: Mode
}

export default function ReviewList({ mode }: Props) {
  const gaps = useAppStore((s) => s.gaps)
  const meta = useAppStore((s) => s.meta)
  const visibleClasses = useAppStore((s) => s.visibleClasses)
  const focusGap = useAppStore((s) => s.focusGap)
  const ensureVisible = useAppStore((s) => s.ensureVisible)
  const selectedIds = useAppStore((s) => s.selectedIds)
  // 筛选条件放 store：切到「属性」标签时本组件会被卸载，组件内 state 会丢
  const { kind, minArea, customArea } = useAppStore((s) => s.reviewFilter)
  const setReviewFilter = useAppStore((s) => s.setReviewFilter)
  const validation = useAppStore((s) => s.validation)
  const initValidation = useAppStore((s) => s.initValidation)
  const resetValidation = useAppStore((s) => s.resetValidation)
  const pushLog = useAppStore((s) => s.pushLog)

  /** 自定义框有内容时，预设档位不高亮（否则会同时亮两个，用户不知道哪个生效） */
  const usingCustom = customArea.trim() !== ''
  /** 键盘操作的提示条（标完一块闪一下） */
  const [flash, setFlash] = useState<string>('')
  const flashTimer = useRef<number | null>(null)

  /**
   * 自定义最小面积。
   *
   * 防呆策略：**非法输入只留在框里，不改生效值**。
   * 如果非法就重置成 0，用户输 "5" 想输 "500" 时中间那一瞬间会把列表刷成全量，
   * 视觉上像"筛选失效了"。保留旧值让他继续输完更自然。
   */
  const onCustomArea = (raw: string) => {
    const t = raw.trim()
    if (t === '') {
      setReviewFilter({ customArea: '', minArea: 0 })
      return
    }
    const n = Number(t)
    if (!Number.isFinite(n) || n < 0) {
      setReviewFilter({ customArea: raw })
      return
    }
    setReviewFilter({ customArea: raw, minArea: n })
  }

  /** 验证集的隔离键：影像文件名。换园区 = 另一套题 */
  const scope = useMemo(() => {
    const src = meta?.source ?? ''
    return src.split(/[\\/]/).pop() || 'default'
  }, [meta?.source])

  // 进入验证集模式时才抽样 —— 不进入就不占内存、也不改 localStorage
  //
  // ⚠️ 依赖里必须含 `validation.scope` 与 `samples.length`：
  //    React 18 StrictMode 会把 effect 跑两次，而第一次的 `set` 要等到下一帧才反映到
  //    闭包里的 `validation`。少了这两个依赖，第二次运行时读到的还是旧值，
  //    于是重复抽样并覆盖进度（把刚标的记录清掉）。
  useEffect(() => {
    if (mode !== 'validation' || gaps.length === 0) return
    if (validation.scope === scope && validation.samples.length > 0) return
    const samples = buildValidationSample(gaps, DEFAULT_SEED)
    if (samples.length === 0) return
    initValidation(scope, samples, DEFAULT_SEED)
    pushLog(
      `已生成验证集：${samples.length} 块（三层分层 · seed ${DEFAULT_SEED}），` +
        `用于算全园无偏准确率`,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, scope, gaps.length, validation.scope, validation.samples.length])

  const counts = reviewCounts(gaps)
  const list = filterReviewGaps(gaps, { kind, minArea })

  /**
   * 验证集模式下的可见列表。
   *
   * 只显示被抽中的 150 块，且**按样本顺序**（面积降序）——
   * 用户标的时候是按"从大到小"的节奏走的，列表顺序必须和 `nextUnlabeled` 一致。
   */
  const sampleById = useMemo(() => {
    const m = new Map<string, GtSample>()
    for (const s of validation.samples) m.set(s.gap_id, s)
    return m
  }, [validation.samples])

  const valList = useMemo(() => {
    if (mode !== 'validation') return []
    const byId = new Map(gaps.map((f) => [f.properties.gap_id, f]))
    return validation.samples
      .map((s) => byId.get(s.gap_id))
      .filter((f): f is NonNullable<typeof f> => !!f)
  }, [mode, validation.samples, gaps])

  const shown = (mode === 'validation' ? valList : list).slice(0, MAX_ROWS)
  const picked = new Set(selectedIds)

  const showFlash = useCallback((text: string) => {
    setFlash(text)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(''), 1600)
  }, [])

  /**
   * 选中并飞过去。
   *
   * 抽成函数是因为键盘 `↑`/`↓` 与点击都要用：
   * · `ensureVisible` —— 待复核类默认隐藏，不先打开飞过去就是一片空白
   * · `focusGap` —— MapCanvas 的 fitBounds
   */
  const goTo = useCallback(
    (gapId: string) => {
      const f = gaps.find((x) => x.properties.gap_id === gapId)
      if (!f) return
      ensureVisible(f.properties.class)
      focusGap(gapId)
    },
    [gaps, ensureVisible, focusGap],
  )

  /**
   * 前进到下一个未标项。
   *
   * ⚠️ 必须读 `getState()` 而不是闭包里的 `validation` ——
   * 它被 `setTimeout(…, 0)` 调用，那一刻 store 已经更新过，
   * 而闭包里的还是上一帧的 records（会用旧数据算出"这块还没标"并原地打转）。
   */
  const advance = useCallback(
    (fromId: string | null) => {
      const st = useAppStore.getState()
      const nx = nextUnlabeled(st.validation.samples, st.validation.records, fromId)
      if (nx) goTo(nx.gap_id)
      else showFlash(`✓ 全部标完（${st.validation.samples.length} 块）`)
    },
    [goTo, showFlash],
  )

  /**
   * 键盘流。
   *
   * ## 四道防误触护栏（缺一条就会出事）
   *
   * 1. **焦点在输入控件里 → 全部让位**。用户在搜索框/面积框里按 `1` 是想输数字，
   *    不是标"真需补种"。
   * 2. **有弹窗打开 → 全部让位**。导出/预检/帮助弹窗里按 `1`/`Space` 会误标。
   *    判据是 DOM 里存在 `role="dialog"`（三个弹窗组件都带这个属性）。
   * 3. **只在验证集模式且右栏可见时才响应 `1/2/3/4/Space`**。
   *    复核模式下按 `1` 没有语义，响应它只会让用户困惑。
   * 4. **`↑`/`↓` 也要求窗口聚焦在本面板** —— 否则用户在左栏操作时按方向键
   *    会莫名其妙地跳块。
   *
   * 另外 `Space` 必须 `preventDefault()`：否则会滚动页面。
   */
  useEffect(() => {
    if (mode !== 'validation') return

    const onKey = (e: KeyboardEvent) => {
      // 四道护栏统一由 `lib/hotkeys.ts` 判断（纯函数，可单测）：
      //   输入控件 / 弹窗 / 修饰键 / 长按重复
      // 写在事件回调里就测不到了 —— 而这类防护漏一条就会**静默污染验证集**。
      if (
        shouldIgnoreHotkey({
          target: e.target as HTMLElement | null,
          hasDialog: !!document.querySelector('[role="dialog"]'),
          hasModifier: e.ctrlKey || e.metaKey || e.altKey,
          repeat: e.repeat,
        })
      ) {
        return
      }

      const st = useAppStore.getState()
      if (st.validation.samples.length === 0) return

      const cur = st.selectedId
      const order = st.validation.samples.map((s) => s.gap_id)

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          e.preventDefault()
          if (order.length === 0) return
          const i = cur ? order.indexOf(cur) : -1
          const n = order.length
          const nextIdx =
            e.key === 'ArrowDown'
              ? i < 0
                ? 0
                : (i + 1) % n
              : i < 0
                ? n - 1
                : (i - 1 + n) % n
          goTo(order[nextIdx])
          return
        }

        case ' ':
        case 'Enter': {
          if (!cur) return
          e.preventDefault()
          const sample = st.validation.samples.find((s) => s.gap_id === cur)
          if (!sample) return
          // 「待复核」的块不能"认同算法" —— 算法自己都没定论，
          // 认同它等于标了个存疑，那块就白标了（评估时会被剔除）
          if (!canConfirm(sample.algo_class)) {
            showFlash('这块算法自己不确定，请按 1 / 2 / 3 选一个真值')
            return
          }
          st.confirmGt(cur)
          showFlash(`✓ 认同算法（${CLASS_STYLES[sample.algo_class].label}）`)
          window.setTimeout(() => advance(cur), 0)
          return
        }

        case '1':
        case '2':
        case '3':
        case '4': {
          if (!cur) return
          e.preventDefault()
          const gt = Number(e.key) as GtLabel
          st.setGt(cur, gt)
          showFlash(`已标：${GT_LABEL_META[gt].short}`)
          window.setTimeout(() => advance(cur), 0)
          return
        }

        default:
          return
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, goTo, showFlash, advance])

  /** 导出验证集为可下载的 JSON（评测算分要用） */
  const exportValidation = useCallback(() => {
    const blob = {
      version: 1,
      scope,
      seed: validation.seed,
      generated_at: new Date().toISOString(),
      // 样本里带权重与分层，评估脚本据此算无偏准确率
      samples: validation.samples,
      records: validation.records,
    }
    const text = JSON.stringify(blob, null, 2)
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `validation-gt-${validation.samples.length}.json`
    a.click()
    URL.revokeObjectURL(url)
    pushLog(`已导出验证集标注（${Object.keys(validation.records).length} 条记录）`)
  }, [scope, validation, pushLog])

  if (gaps.length === 0) {
    return (
      <div className="empty">
        <p>还没有检测结果。</p>
        <p className="dim">
          点地图下方命令条的「开始检测」跑一遍，或「⋯ 更多 → 重新载入检测结果」读已有文件。
        </p>
      </div>
    )
  }

  return (
    <div className="review">
      {/* 视图切换已上移到右面板的 tab 条（清单 / 验证集 / 属性）。
          这里不再放第二组「复核 | 验证集」—— 同一个词在同一列里出现两次，
          用户无法判断它们是同一层级还是父子关系。 */}

      {mode === 'validation' ? (
        <>
          <div className="rv-kbd">
            <div className="rv-kbd-row">
              <kbd>↑</kbd>
              <kbd>↓</kbd>
              <span className="dim">切换并定位</span>
              <kbd>Space</kbd>
              <span className="dim">认同算法（「待复核」块除外）</span>
            </div>
            <div className="rv-kbd-row">
              {([1, 2, 3, 4] as GtLabel[]).map((g) => (
                <span key={g} className="rv-kbd-pair">
                  <kbd>{g}</kbd>
                  <span className="dim">{GT_LABEL_META[g].short}</span>
                </span>
              ))}
            </div>
          </div>

          <div className="rv-actions">
            <button className="btn tiny" onClick={exportValidation}>
              导出标注 JSON
            </button>
            <button
              className="btn tiny"
              onClick={() => {
                if (window.confirm('清空本园区的标注进度？这一步不可撤销。')) {
                  resetValidation()
                  pushLog('已清空验证集标注进度')
                }
              }}
            >
              重来
            </button>
            {flash && <span className="rv-flash">{flash}</span>}
          </div>
        </>
      ) : (
        <>
          {/* 四片「仪表片」而不是胶囊：计数是这批筛选片唯一的决策数据
              （40 块待复核 → 今天做不做得完），双行排布让 4 个数字落在同一条基线上，
              可以直接比大小；胶囊横排会把它读成 4 个按钮。 */}
          <div className="rv-filter">
            {KINDS.map((k) => (
              <button
                key={k}
                className={kind === k ? 'chip active' : 'chip'}
                onClick={() => setReviewFilter({ kind: k })}
                title={
                  k === 'uncertain'
                    ? '证据不足、需要人工确认的块 —— 优先清这些'
                    : k === 'edited'
                      ? '你手工改过类别或边界的块'
                      : k === 'manual'
                        ? '你手工补画的块'
                        : '全部多边形'
                }
              >
                <span className="chip-label">{REVIEW_KIND_LABEL[k]}</span>
                <span className="chip-n">{counts[k]}</span>
              </button>
            ))}
          </div>

          {/* 面积档 + 自定义值同一行：档位是"常见值"，地块差异大，必须允许任意值。
              单位 m² 用伪元素贴在输入框右侧，不再单独占一列 —— 300px 宽里
              "最小面积" 四个字 + 5 个档位 + 输入框 + 单位，单独占列就会挤成竖排。 */}
          <div className="rv-row-filter">
            <div className="seg" role="group" aria-label="最小面积档位">
              {AREAS.map((a) => (
                <button
                  key={a.v}
                  className={!usingCustom && minArea === a.v ? 'seg-btn active' : 'seg-btn'}
                  onClick={() => setReviewFilter({ minArea: a.v, customArea: '' })}
                  title={a.v === 0 ? '不按面积过滤' : `只显示 ≥ ${a.v} m² 的块`}
                >
                  {a.label}
                </button>
              ))}
            </div>
            {/* 自定义面积：档位是"常见值"，但地块差异大，必须允许任意值 */}
            <input
              type="number"
              min={0}
              step={50}
              inputMode="numeric"
              className={usingCustom ? 'rv-area-input active' : 'rv-area-input'}
              placeholder="自定义"
              value={customArea}
              onChange={(e) => onCustomArea(e.target.value)}
              title="输入任意最小面积（m²），输入即生效"
              aria-label="自定义最小面积"
            />
          </div>
        </>
      )}

      {shown.length === 0 ? (
        <div className="empty">
          <p>这个条件下没有块。</p>
          <p className="dim">换个筛选条件，或把最小面积调小。</p>
        </div>
      ) : (
        <>
          <ul className="rv-list">
            {shown.map((f) => {
              const p = f.properties
              const st = CLASS_STYLES[p.class]
              const hidden = !visibleClasses[p.class]
              const sample = mode === 'validation' ? sampleById.get(p.gap_id) : undefined
              const rec = mode === 'validation' ? validation.records[p.gap_id] : undefined
              // 已标的显示真值（不是算法类别）—— 用户要看的是"我标成了什么"
              const gtText = rec?.confirmed
                ? '✓ 认同'
                : rec?.gt != null
                  ? GT_LABEL_META[rec.gt].short
                  : ''
              return (
                <li key={p.gap_id}>
                  <button
                    className={
                      (picked.has(p.gap_id) ? 'rv-item active' : 'rv-item') +
                      (rec ? ' done' : '')
                    }
                    onClick={() => {
                      ensureVisible(p.class)
                      focusGap(p.gap_id)
                    }}
                    title={hidden ? '该类别当前隐藏，点击会自动打开' : '点击定位到这块'}
                  >
                    {/* 类别色只以**行左沿 3px 竖条**出现，不再放 8×8 方块：
                        方块和复选框是两个同形符号，12px 字号下会被读成"两个勾选框"。
                        竖条的长宽比天然不像控件，且沿整行高度标注类别 ——
                        扫视时眼睛沿左沿就能分块。 */}
                    <span className="rv-bar" style={{ background: st.color }} aria-hidden />
                    <span className="rv-area">
                      {(p.area_sqm ?? 0).toLocaleString()}
                      <i>m²</i>
                    </span>
                    <span className="rv-cls">
                      <span className="rv-cls-name">{st.label}</span>
                      {hidden && <span className="rv-hidden">隐藏</span>}
                    </span>
                    {/* 空态也渲染：grid 的列数必须恒定，否则最后两列的宽度会在
                        切换视图时跳动（用户看到的是"点一下面积数字就移位了"）。 */}
                    <span className={gtText ? 'rv-gt set' : 'rv-gt'}>
                      {mode === 'validation'
                        ? gtText || (sample ? `w${Math.round(sample.weight)}` : '')
                        : ''}
                    </span>
                    {/* 算法 id 形如 r038912_c020480-G0001，全显示会把类别名挤没。
                        只留尾段，完整 id 放进 title */}
                    <span className="rv-id mono" title={p.gap_id}>
                      {p.gap_id.split('-').pop()}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
          {mode === 'review' && list.length > MAX_ROWS && (
            <div className="rv-more dim">
              还有 {list.length - MAX_ROWS} 块未显示 —— 用「最小面积」缩小范围，或按类别筛选
            </div>
          )}
        </>
      )}
    </div>
  )
}
