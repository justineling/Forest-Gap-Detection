import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import MapCanvas, { type DrawIntent } from './components/MapCanvas'
import ErrorBoundary from './components/ErrorBoundary'
import TopToolbar from './components/TopToolbar'
import LeftPanel from './components/LeftPanel'
import RightPanel from './components/RightPanel'
import StatusBar from './components/StatusBar'
import DetectBar from './components/DetectBar'
import DetectSettings from './components/DetectSettings'
import NextStepCard from './components/NextStepCard'
import HelpDialog from './components/HelpDialog'
import { HEADER_HELP } from './lib/helpContent'
import PreflightDialog from './components/PreflightDialog'
import DerivedDialog from './components/DerivedDialog'
import ExportDialog from './components/ExportDialog'
import { parseKmlOrGeoJsonRoi } from './lib/roiImport'
import { useAppStore } from './store/useAppStore'
import WelcomeWizard from './components/WelcomeWizard'
import {
  fetchGaps,
  getStatus,
  isTauri,
  onSidecarEvent,
  onSidecarLog,
  openPath,
  pickRoiFile,
  preflightDetect,
  probeBackend,
  readTextFile,
  runDetect,
  type AppStatus,
} from './api/backend'
import { toInput, type ActionKind, type StepKey } from './lib/workflow'
import { decideGapsLoad, shouldClearGapsOnImageChange } from './lib/gapsLoad'
import { shouldShowOverviewNotice } from './lib/overview'
import OverviewNotice from './components/OverviewNotice'
import ResumeDialog from './components/ResumeDialog'
import Resizer from './components/Resizer'
import { pickGeneratedAt, shouldAskResume } from './lib/resume'
import {
  LEFT_LIMIT,
  LAYOUT_DEFAULT,
  RIGHT_LIMIT,
  STATUS_LIMIT,
  clampLayoutWidths,
  clampSize,
  maxLeftW,
  maxRightW,
} from './lib/layout'
import type {
  DetectProgress,
  GapCollection,
  GapFeature,
  PlantingGrid,
  PreflightResult,
} from './types'

/**
 * 三个可拖拽尺寸的形状（左面板宽 / 右面板宽 / 状态栏高）。
 *
 * 单独起一个类型而不是让 `useRef` 从 `LAYOUT_DEFAULT` 推断 ——
 * 后者是 `as const`，推断出来是字面量类型 `288`，之后赋任何别的值都报错。
 */
type LayoutSize = { leftW: number; rightW: number; statusH: number }

export default function App() {
  const [drawIntent, setDrawIntent] = useState<DrawIntent>('none')
  /**
   * 绘制结束的回调。
   *
   * ⚠️ 必须 `useCallback` 稳定引用：它被传给 MapCanvas 的绘制 effect 当依赖，
   *    内联箭头函数会让 App 每次重渲染都重挂 contextmenu / finish 监听。
   *    QA 实测 add=2 / rem=1 —— 净 1 没泄漏，但属于噪音，且以后很容易演变成泄漏。
   */
  const onDrawDone = useCallback(() => setDrawIntent('none'), [])
  // 只用到 setter —— 载入中的提示改由「下一步」卡片承担，按钮上不再显示"载入中…"
  const [, setLoadingGaps] = useState(false)
  /** 当前应用状态（后端形态 / 影像路径 / 是否要引导） */
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null)
  /** 非 null 时显示首次使用引导 */
  const [wizard, setWizard] = useState<AppStatus | null>(null)
  /**
   * 载入结果时后端明确说"读不到文件"（`/gaps` 返回空集合 + error）。
   *
   * ⚠️ 必须与"检测结果确实是 0 块"区分开：前者是数据链路问题（文件在别的目录 /
   * 服务指向旧路径），后者是真的没有空地。混在一起就是实测那个 bug ——
   * 1,762 个要素躺在磁盘上，界面却说"没有空地"。
   */
  const [gapsError, setGapsError] = useState<string | null>(null)
  /** 「结果按旧输入算的」提示（后端比对 inputs_snapshot 得出，状态栏常驻） */
  const [staleWarnings, setStaleWarnings] = useState<string[]>([])
  /** 非 null 时显示预检结果对话框 */
  const [preflight, setPreflight] = useState<PreflightResult | null>(null)
  /** 正在预检 / 启动（按钮显示"检查中…"） */
  const [starting, setStarting] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  /**
   * 检测参数窗是"从哪进来的"：
   *  - edit   = 「⋯ 更多 → 检测参数」（只编辑，底部无「开始检测」）
   *  - detect = 点「开始检测」进来的（底部有「开始检测」，确认后才真跑）
   *
   * 为什么强制确认：参数（株距/行距/密度）直接改变判定结果，换园区必须改；
   * 直接开跑会让用户完全不知道用的是什么参数（2026-10-22 用户反馈）。
   */
  const [settingsIntent, setSettingsIntent] = useState<'edit' | 'detect'>('edit')
  const [showExport, setShowExport] = useState(false)
  /** 生成高度图 / 林地边界 */
  const [showDerived, setShowDerived] = useState(false)
  /** 递增即让右面板切到「复核」标签（步进器点第 4 步时用） */
  const [reviewPeek, setReviewPeek] = useState(0)
  /**
   * 用户点了「以后再说」。
   *
   * 刻意**只存在内存里**，不写 localStorage：这张影像下次启动仍然没有加速结构，
   * 该提醒还是得提醒 —— 写死了就变成"提示过一次就再也不提，用户永远不知道为什么慢"。
   */
  const [overviewDismissed, setOverviewDismissed] = useState(false)
  /**
   * 浏览器模式下的预览开关（`?mock=ready&noOvr=1`）。
   *
   * 为什么需要它：横幅的渲染条件是 `isTauri()`，而截图回归跑在浏览器里 ——
   * 不加这个开关就**永远截不到**这张横幅（这类"截图里没有、上线才发现"的漏检
   * 本项目已经踩过）。它只影响截图，不进打包逻辑。
   */
  const [overviewPreview, setOverviewPreview] = useState(false)
  /**
   * 非 null 时显示「发现上次的检测结果」：继续复核，还是重新开始。
   *
   * 为什么需要这一问：启动会自动把磁盘上的旧结果读进界面，`workflow` 于是
   * 直接跳到第 4 步 —— 用户"想重跑"和"只想看新影像"的选择权被拿走了。
   */
  const [resumeAsk, setResumeAsk] = useState<{
    count: number
    generatedAt: string | null
  } | null>(null)
  /**
   * 命中「继续复核 / 重新开始」时**暂存**的结果（还没应用到 store）。
   *
   * ⚠️ 为什么必须暂存：以前的顺序是"先 `setGaps(feats)` 再弹窗"，
   *    于是启动瞬间地图上会闪一下 1,762 个多边形、步骤条先跳到第 4 步，
   *    然后才被清空 —— 用户看到的就是"我明明点了重新开始，它还是先载入了"
   *    （2026-10-22 反馈，原话是「依然载入并跳到第二步」）。
   *    现在：命中弹窗时数据只放这里，用户选完「继续」才真正应用。
   */
  const [pendingResume, setPendingResume] = useState<{
    feats: GapFeature[]
    grid: PlantingGrid | null
  } | null>(null)
  /**
   * 本次启动是否已经问过（只问一次）。
   *
   * 不用 state 而用 ref：这个标记只影响"要不要再弹"，不参与渲染，
   * 放进 state 会让每次 `loadGaps` 都触发一次额外渲染。
   */
  const resumeAsked = useRef(false)
  /**
   * `loadGaps` 是否已经调用过（用来判断"这一次是不是启动时的首次加载"）。
   *
   * ⚠️ 必须在**调用开始时**就置 true，不能等成功后再置：首次加载若失败
   * （后端还没起来），用户点「重新载入结果」重试时会再走一遍 loadGaps，
   * 那时若仍算"首次"，就会在他刚重试成功后弹一句"发现上次的检测结果"——
   * 而他刚刚才亲手点了重载，这话完全不成立。
   */
  const firstLoadDone = useRef(false)
  /**
   * 是否有一份"暂存待确认"的结果（弹窗还开着）。
   *
   * ⚠️ 为什么必须是 ref：`loadGaps` 是 `useCallback`，闭包里读到的是旧 state，
   *    而这里要在**下一次 loadGaps 进来的瞬间**就知道"已经有一份在等用户确认"。
   * ⚠️ 为什么真的会遇到"弹窗还开着又来一次 loadGaps"：dev 下 React StrictMode
   *    会把启动 effect 跑两遍，第二次的 `firstLoad` 已经是 false ——
   *    不加这道闸，第二次就把结果直接应用上去了，弹窗白弹
   *    （实测：弹窗在，但地图上已经是 3 块、步骤条已经在第 4 步）。
   */
  const resumePending = useRef(false)
  /** 浏览器模式下 `?help=1` 直接预览帮助弹窗（截图 / 回归用，不进打包逻辑） */
  const [demoHelp, setDemoHelp] = useState(false)

  // —— 布局尺寸（左右面板宽度 / 状态栏高度，可拖拽）——
  //
  // ⚠️ **刻意只放 React state，绝不写 localStorage / settings.json**。
  //    用户明确要求：「这个高度 / width 是不记忆的，每次重新登入都会回到默认配置」。
  //    下一个人请**不要**"顺手"补上持久化 —— 那会直接违背这条需求。
  //    （项目里别的偏好确实会持久化：检测参数、导出目录、验证集进度。
  //      唯独这三项不，因为它们是"这一次想怎么看"，不是"以后都这样"。）
  const [leftW, setLeftW] = useState<number>(LAYOUT_DEFAULT.leftW)
  const [rightW, setRightW] = useState<number>(LAYOUT_DEFAULT.rightW)
  const [statusH, setStatusH] = useState<number>(LAYOUT_DEFAULT.statusH)
  /**
   * 拖拽起点对应的"已提交尺寸"。
   *
   * `Resizer.onDrag` 给的是**相对按下时的位移**（不是增量），所以每次 move 都要
   * 用"按下那一刻的尺寸 + 位移"重算 —— 用当前尺寸累加会随鼠标抖动漂移。
   * 松手（或窗口缩放被重新钳制）时把当前尺寸记进来，作为下一次拖拽的基准。
   */
  const sizeBase = useRef<LayoutSize>({
    leftW: LAYOUT_DEFAULT.leftW,
    rightW: LAYOUT_DEFAULT.rightW,
    statusH: LAYOUT_DEFAULT.statusH,
  })
  /** 当前尺寸的即时镜像（拖拽回调里要读"另一个面板现在多宽"，不能靠闭包快照） */
  const sizeNow = useRef<LayoutSize>({
    leftW: LAYOUT_DEFAULT.leftW,
    rightW: LAYOUT_DEFAULT.rightW,
    statusH: LAYOUT_DEFAULT.statusH,
  })
  useEffect(() => {
    sizeNow.current = { leftW, rightW, statusH }
  })

  /** 拖动左面板右边框：向右拖 = 左面板变宽 */
  const onDragLeft = useCallback((delta: number) => {
    const limit = maxLeftW(sizeNow.current.rightW, window.innerWidth)
    setLeftW(clampSize(sizeBase.current.leftW + delta, LEFT_LIMIT.min, limit))
  }, [])
  /** 拖动右面板左边框：向左拖（delta 为负）= 右面板变宽 */
  const onDragRight = useCallback((delta: number) => {
    const limit = maxRightW(sizeNow.current.leftW, window.innerWidth)
    setRightW(clampSize(sizeBase.current.rightW - delta, RIGHT_LIMIT.min, limit))
  }, [])
  /** 拖动状态栏上边框：向上拖（delta 为负）= 状态栏变高 */
  const onDragStatus = useCallback((delta: number) => {
    setStatusH(clampSize(sizeBase.current.statusH - delta, STATUS_LIMIT.min, STATUS_LIMIT.max))
  }, [])

  const onEndLeft = useCallback(() => {
    sizeBase.current.leftW = sizeNow.current.leftW
  }, [])
  const onEndRight = useCallback(() => {
    sizeBase.current.rightW = sizeNow.current.rightW
  }, [])
  const onEndStatus = useCallback(() => {
    sizeBase.current.statusH = sizeNow.current.statusH
  }, [])

  /**
   * 窗口变窄时把左右面板一起收回来。
   *
   * 拖拽时每次只钳制被拖的那一个（另一个不动），所以"两块加起来超过窗口"
   * 只可能由改窗口大小引起 —— 不处理的话地图会被挤成一条竖缝，
   * 用户会以为"地图加载失败了"。
   */
  useEffect(() => {
    const onResize = (): void => {
      const r = clampLayoutWidths(sizeNow.current.leftW, sizeNow.current.rightW, window.innerWidth)
      setLeftW(r.left)
      setRightW(r.right)
      // 基准同步：否则下一次拖拽会从"被收之前"的尺寸开始，一按就跳
      sizeBase.current.leftW = r.left
      sizeBase.current.rightW = r.right
    }
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /**
   * 三个尺寸以 CSS 变量的形式挂在根节点上（`--left-w` / `--right-w` / `--status-h`），
   * 由 styles.css 的 `.body` / `.statusbar` 消费 —— 这样拖拽只改一个 style，
   * 不用给每个面板单独传宽度 prop。
   */
  const layoutVars: CSSProperties &
    Record<'--left-w' | '--right-w' | '--status-h', string> = {
    '--left-w': `${leftW}px`,
    '--right-w': `${rightW}px`,
    '--status-h': `${statusH}px`,
  }

  const setBackend = useAppStore((s) => s.setBackend)
  const setGaps = useAppStore((s) => s.setGaps)
  const pushLog = useAppStore((s) => s.pushLog)
  const applyRerun = useAppStore((s) => s.applyRerun)
  const meta = useAppStore((s) => s.meta)
  const roi = useAppStore((s) => s.roi)
  const setRoi = useAppStore((s) => s.setRoi)
  const detectParams = useAppStore((s) => s.detectParams)
  const detect = useAppStore((s) => s.detect)
  // 工作流（五步向导）需要的东西
  const backendOnline = useAppStore((s) => s.backendOnline)
  const gaps = useAppStore((s) => s.gaps)
  const wfFlags = useAppStore((s) => s.workflow)
  const markWorkflow = useAppStore((s) => s.markWorkflow)
  const outputDir = useAppStore((s) => s.outputDir)
  const runEstimate = useAppStore((s) => s.runEstimate)
  const manualAdded = useAppStore((s) => s.manualAdded)
  const manualDeleted = useAppStore((s) => s.manualDeleted)
  const manualEdited = useAppStore((s) => s.manualEdited)
  const detectBegin = useAppStore((s) => s.detectBegin)
  const detectProgress = useAppStore((s) => s.detectProgress)
  const detectFinish = useAppStore((s) => s.detectFinish)

  /**
   * 载入检测结果。
   *
   * `rerun=true` 时走「合并人工编辑」而不是直接替换 —— 重跑后 gap_id 全部重编，
   * 直接替换会让用户上一轮删掉的误报复活、改判的类别被算法覆盖回去。
   *
   * ⚠️ **空响应绝不覆盖已有结果**。`applyRerun([])` 会把当前结果全丢掉
   *    （合并以新结果为主体，只重放人工操作），实测会造成"检测跑完，结果没了"。
   *    判定逻辑单独抽在 `lib/gapsLoad.ts`（可被 npm test 覆盖），这里只负责
   *    按判定结果打日志 / 报错。
   */
  const loadGaps = useCallback(
    async (opts?: { rerun?: boolean }) => {
      // 这一次是不是"启动时的首次加载"—— 必须在函数**开头**取，且立刻置 false：
      // 检测完成后的 `loadGaps({rerun:true})`、点「重新载入结果」都不该算首次
      // （否则每跑完一次检测就弹一次"发现上次的检测结果"）。
      const isFirstLoad = !firstLoadDone.current
      firstLoadDone.current = true
      setLoadingGaps(true)
      try {
        const fc = await fetchGaps()
        const feats = fc.features ?? []
        const st = useAppStore.getState()
        const existing = st.gaps.length
        // sidecar 的 result 事件自报的空地块数；没有这个事件就是 null
        //（不能当 0 —— "算法说没找到"和"没收到报告"是两回事）
        const reported = st.detect.finished?.gaps ?? null

        const decision = decideGapsLoad({
          incoming: feats.length,
          existing,
          reported,
          error: fc.error,
        })
        if (decision.action === 'keep') {
          setGapsError(decision.detail)
          const parts = [
            decision.reason === 'missing_file'
              ? `⚠️ ${decision.detail}`
              : `⚠️ 读到的结果文件是空的（可能还在写盘，或文件已损坏）：${decision.detail}`,
          ]
          if (existing > 0) parts.push(`现有 ${existing.toLocaleString()} 块结果已保留`)
          parts.push(
            decision.reason === 'missing_file'
              ? '结果可能写在别的目录 —— 请点右上角「⋯ 更多 → 更换影像或结果文件」指一下，或重新检测'
              : '请稍后点「重新载入结果」重试，或重新检测',
          )
          pushLog(parts.join('。'))
          // 刚跑完检测的话，顶部横幅还写着"结果已载入"—— 与"没读到"同时出现
          // 会让人以为界面在乱报。改掉它（保留 ok：检测确实成功了，
          // 失败的是"读取结果"这一步）。
          if (opts?.rerun && st.detect.finished) {
            detectFinish({
              ...st.detect.finished,
              message:
                `检测已完成，但没读到结果：${decision.detail}` +
                (existing > 0 ? '（现有结果已保留）' : ''),
            })
          }
          return
        }
        setGapsError(null)
        // 过期提示：结果是用旧的高度图/分割图算的。
        // 只 pushLog 不够 —— 用户不会盯着日志。所以同时存进 store，由状态栏常驻显示。
        if (fc.stale_warnings?.length) {
          setStaleWarnings(fc.stale_warnings)
          pushLog(`⚠️ ${fc.stale_warnings.join('；')}`)
        } else {
          setStaleWarnings([])
        }
        if (opts?.rerun) {
          applyRerun(feats, 'keep_manual')
          setLoadingGaps(false)
          return
        }
        // 把算法网格一起带上 —— 前端估算的格点相位才能与 Python 侧逐株一致。
        //
        // ⚠️ 顺序很关键：**先判"要不要问"，再决定要不要应用**。
        //    以前是先 `setGaps(...)` 再弹窗，启动瞬间地图上会闪一下 1,762 个
        //    多边形、步骤条先跳到第 4 步，然后才被清空 —— 用户看到的就是
        //    "点了重新开始，界面依然载入并跳到了第二步"（2026-10-22 反馈）。
        //    判定条件全在 lib/resume.ts 里（有 4 条规则的逐条断言）：
        //    只有"启动首次加载 + 本次没跑过检测 + 确实读到块数"才问。
        const askResume =
          !resumeAsked.current &&
          shouldAskResume({
            firstLoad: isFirstLoad,
            detectedThisSession: useAppStore.getState().detect.finished != null,
            gapCount: feats.length,
          })
        if (askResume) {
          // 只暂存，**不应用**：用户选「继续」时才 setGaps（见 onContinueResume）
          resumeAsked.current = true
          resumePending.current = true
          setPendingResume({ feats, grid: fc.planting_grid ?? null })
          setResumeAsk({ count: feats.length, generatedAt: pickGeneratedAt(fc) })
        } else if (resumePending.current) {
          // 已经有一份在等用户确认 —— 这一轮**不应用**，否则等于绕过弹窗
          // （StrictMode 下启动 effect 跑两遍就会走到这里，见 resumePending 的注释）
          pushLog('已有一次结果等待你确认是否继续，本次未应用新读到的结果')
        } else {
          setGaps(feats, fc.planting_grid ?? null)
        }
      } catch (e) {
        // 后端不在线时退回内置样例，保证界面可独立演示。
        // ⚠️ 但**已经有真实结果时不能拿样例覆盖它** —— 那是另一种数据丢失
        //    （而且是拿演示数据换掉用户跑出来的结果，更糟）。
        setGapsError(null)
        const existing = useAppStore.getState().gaps.length
        if (existing > 0) {
          pushLog(
            `⚠️ 后端不可用（${e instanceof Error ? e.message : e}）；` +
              `现有 ${existing.toLocaleString()} 块结果已保留（未载入内置样例）。` +
              '请检查影像服务是否在运行，或点「重新载入结果」重试。',
          )
          return
        }
        // ⚠️ 后端不可用时**不要**自动塞内置样例：
        //    用户会以为那些多边形是自己上次的检测结果
        //    （2026-10-22 实测：重启后影像服务未连接，界面却出现一片空地多边形，
        //     用户第一反应是"检测区域怎么还在"）。
        //    样例只在显式演示模式（URL 带 ?demo=1）下加载。
        const demo = new URLSearchParams(window.location.search).has('demo')
        if (!demo) {
          pushLog(
            `后端不可用（${e instanceof Error ? e.message : e}）；` +
              '未载入任何结果。先选影像，服务起来后结果会自动载入。',
          )
          return
        }
        try {
          const res = await fetch('/sample-gaps.geojson')
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const fc = (await res.json()) as GapCollection
          setGaps(fc.features ?? [], fc.planting_grid ?? null)
          pushLog(`演示模式：已载入内置样例数据（后端不可用：${e instanceof Error ? e.message : e}）`)
        } catch (e2) {
          pushLog(`载入失败：${e2 instanceof Error ? e2.message : String(e2)}`)
        }
      } finally {
        setLoadingGaps(false)
      }
    },
    [setGaps, pushLog, applyRerun, detectFinish],
  )

  /** 探测瓦片服务并载入结果（向导完成后也会调它） */
  const probeAndLoad = useCallback(async () => {
    const st = await probeBackend()
    setBackend(st)
    if (st.online) {
      pushLog(
        `影像已就绪：${st.meta?.source ?? ''}（${st.meta?.width}×${st.meta?.height}，` +
          `${st.meta?.res_m.toFixed(2)} m/px）`,
      )
    } else {
      pushLog(
        '影像服务未连接。若是第一次使用，请点右上角「⋯ 更多 → 更换影像或结果文件」；' +
          '已选过则稍等几秒（首次要建索引），仍不行请查看日志文件。',
      )
    }
    await loadGaps()
  }, [setBackend, pushLog, loadGaps])

  // 启动：先问"有没有影像"，没有就显示引导（而不是丢给用户一句开发者命令）
  useEffect(() => {
    ;(async () => {
      pushLog('启动：检查数据与影像服务…')
      const st = await getStatus()
      setAppStatus(st)
      // 浏览器模式下 `?wizard=1` 可强制预览引导页（方便截图 / 演示）
      const qs = new URLSearchParams(window.location.search)
      const force = !isTauri() && qs.has('wizard')
      // 浏览器模式下 `?detect=1` 可预览进度条（截图 / 演示用，不进打包逻辑）
      if (!isTauri() && qs.has('detect')) {
        detectBegin()
        detectProgress({
          stage: 'tile_processing',
          done: 128,
          total: 528,
          ratio: 0.2424,
          elapsed_s: 84.5,
          eta_s: 264,
          gaps_found: 312,
        })
      }
      // 浏览器模式下 `?pf=1` 可预览预检对话框（截图 / 回归用）
      if (!isTauri() && qs.has('pf')) {
        setPreflight({
          ok: false,
          items: [
            { key: 'image', label: '正射影像', path: '', status: 'error', detail: '还没有选择影像' },
            {
              key: 'chm_path',
              label: '冠层高度模型（CHM）',
              path: 'D:/project/output/chm.tif',
              status: 'warn',
              detail: '文件不存在 —— 缺了会退化成纯 RGB 判据，水体与低矮植被会大量误判',
            },
            {
              key: 'segment_path',
              label: '语义分割结果',
              path: 'D:/project/drone data/segment.tif',
              status: 'ok',
              detail: '412 MB',
            },
            {
              key: 'forest_mask',
              label: '森林掩膜',
              path: 'D:/project/output/forest-mask-50m-exg60.geojson',
              status: 'ok',
              detail: '已自动启用（剔除未开发林）',
            },
            {
              key: 'work_dir',
              label: '输出目录',
              path: 'D:/project/output/jobs',
              status: 'ok',
              detail: '可写',
            },
          ],
          resolved: {},
        })
        return
      }
      if (st.needs_setup || force) {
        setWizard(st)
        pushLog('还没有选择正射影像 —— 已显示引导，选好文件即可开始')
        return
      }
      await probeAndLoad()
      // 浏览器模式下 `?mock=ready` 伪造"影像已就绪"，用来预览复核 / 导出阶段的界面
      // （Headless 里连不上真正的瓦片服务；只影响截图与回归，不进打包逻辑）
      if (!isTauri() && qs.get('mock') === 'ready') {
        // ⚠️ 字段必须**完整**：这是给截图 / 回归用的假 meta，少一个字段就会真崩。
        //    `bounds_wgs84` 少了 → MapCanvas 的 `const [w,s,e,n] = meta.bounds_wgs84`
        //    解构 undefined → 抛 "undefined is not iterable" → 整个地图被 ErrorBoundary 顶掉。
        //    而这个崩溃**不会让截图失败**（页面其余部分照常），于是"截图看起来正常"
        //    变成了一种假象 —— 实测就是这样漏了一轮。
        //    教训：mock 的字段要与 `RasterMeta` 类型逐项对齐，不能只填"看起来够用"的。
        // `?noOvr=1` 把 has_overviews 翻成 false，用来预览「没有加速结构」的横幅
        const noOvr = qs.has('noOvr')
        // `?ovr=dialog|fail` 是同一套预览（看确认框 / 失败态），也要让横幅挂载
        if (noOvr || qs.has('ovr')) setOverviewPreview(true)
        setBackend({
          online: true,
          meta: {
            ok: true,
            source: 'WGR17-002.tif',
            width: 47130,
            height: 44686,
            crs: 'EPSG:4326',
            res_m: 0.033,
            // WGR17-002 的实测 WGS84 外包框（rasterio transform_bounds 算的，不是估的）
            bounds_wgs84: [111.1969, 1.1771, 111.2109, 1.1904],
            center: [111.2039, 1.1838],
            zoom: 15,
            valid_ratio: 0.57,
            tile_url: '',
            has_overviews: !noOvr,
          } as never,
        })
      }
      // 浏览器模式下 `?derived=1` 预览「生成高度图」对话框（截图 / 回归用）
      if (!isTauri() && qs.has('derived')) setShowDerived(true)
      // 浏览器模式下 `?help=1` 预览帮助弹窗（截图 / 回归用）
      if (!isTauri() && qs.has('help')) setDemoHelp(true)
      // 浏览器模式下 `?resume=1` 预览「发现上次的检测结果」弹窗（截图 / 回归用）
      if (!isTauri() && qs.has('resume')) {
        setResumeAsk({ count: 1726, generatedAt: '2026-10-21T14:23:00' })
      }
      // 浏览器模式下 `?gapsError=1` 预览"结果文件没找到"的卡片态（截图 / 回归用）
      if (!isTauri() && qs.has('gapsError')) {
        setGapsError('未找到检测结果文件（已查找：D:/fgd/data/output）')
      }
      // 浏览器模式下 `?settings=1` 打开检测参数面板（截图 / 回归用）
      if (!isTauri() && qs.has('settings')) setShowSettings(true)
      // 浏览器模式下 `?p2=export` 直接打开导出对话框（截图 / 回归用）
      if (!isTauri() && qs.get('p2') === 'export') setShowExport(true)
      // 浏览器模式下 `?p1=1` 预选 3 块 / `?p1=box` 进框选模式（截图 / 回归用）
      if (!isTauri() && qs.has('p1')) {
        if (qs.get('p1') === 'box') {
          setDrawIntent('box_select')
        } else {
          const st = useAppStore.getState()
          st.selectMany(st.gaps.slice(0, 3).map((f) => f.properties.gap_id))
        }
      }
    })()
    // 仅启动执行一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 「继续复核上次结果」：把启动时**暂存**的结果真正应用上去。
   *
   * ESC / 点遮罩 / 点 × 也都走这一支（沿用 ResumeDialog 里"关闭 = 继续"的取舍：
   * 两个动作后果不对称 —— 继续什么都不变，重新开始会清空界面，
   * 而 ESC / 点遮罩都是"手滑"的高发动作，不该丢数据）。
   */
  const onContinueResume = useCallback(() => {
    const pending = pendingResume
    resumePending.current = false
    if (pending) setGaps(pending.feats, pending.grid)
    setPendingResume(null)
    setResumeAsk(null)
  }, [pendingResume, setGaps])

  /**
   * 「重新开始」：只清界面上的结果，**不删磁盘文件** —— 用户可能只是这次不想看。
   *
   * 暂存的那份数据必须一起丢掉：留着它的话，下次再命中弹窗会把它应用上去，
   * 表现就是"点了重新开始，结果又回来了"。
   */
  const onRestartResume = useCallback(() => {
    resumePending.current = false
    setPendingResume(null)
    setResumeAsk(null)
    setGaps([])
    setGapsError(null)
  }, [setGaps])

  const onWizardDone = useCallback(async () => {
    setWizard(null)
    const st = await getStatus()
    // ⚠️ 换影像后必须清空 store 里的旧结果：`setGaps([])` 会把
    //    `workflow.loaded` 置 false，步骤判定才会回到「运行检测」。
    //    不清的话：旧结果属于上一张影像（网格原点/坐标系都可能不同），
    //    界面会直接跳到「复核结果」并弹"结果没读到"（2026-10-21 实测）。
    //    判定条件抽在 shouldClearGapsOnImageChange 里（有单测）。
    if (shouldClearGapsOnImageChange(st.image, appStatus?.image)) {
      setGaps([])
      setGapsError(null)
    }
    setAppStatus(st)
    await probeAndLoad()
  }, [probeAndLoad, appStatus, setGaps])

  // 检测事件：Tauri 宿主里 sidecar 的 NDJSON 事件流 → 进度条 / 日志 / 自动重载结果
  // ⚠️ 浏览器模式（Headless Chrome）下 onSidecarEvent 直接返回空订阅，
  //    不会碰 Tauri API —— 否则会抛错并卸载整棵 React 树（白屏）。
  useEffect(() => {
    let alive = true
    let unEvent: (() => void) | undefined
    let unLog: (() => void) | undefined

    void onSidecarEvent((ev) => {
      const t = String(ev.event ?? '')
      if (t === 'started') {
        detectBegin()
      } else if (t === 'progress') {
        detectProgress(ev as DetectProgress)
        const m = String(ev.message ?? '')
        if (m) pushLog(m)
      } else if (t === 'result') {
        const summary = (ev.summary ?? {}) as Record<string, unknown>
        const n = Number(summary.total_gap_count ?? 0)
        const area = Number(
          summary.plantable_area_definite_sqm ?? summary.plantable_area_sqm ?? 0,
        )
        const el = Number(ev.elapsed_s ?? 0)
        const fmt = (v: number) => v.toLocaleString()
        detectFinish({
          ok: true,
          elapsedS: el,
          gaps: n,
          areaSqm: area,
          message:
            `${fmt(n)} 块空地 · ${fmt(Math.round(area))} m² · 用时 ` +
            `${Math.floor(el / 60)} 分 ${Math.round(el % 60)} 秒 · 结果已载入`,
        })
        markWorkflow({ detected: true })
        pushLog('检测完成，正在重新载入结果（合并人工编辑）…')
        void loadGaps({ rerun: true })
      } else if (t === 'error') {
        const code = String(ev.code ?? '-')
        const msg = String(ev.message ?? '')
        detectFinish({
          ok: false,
          elapsedS: 0,
          gaps: 0,
          areaSqm: 0,
          message: `[${code}] ${msg}`,
        })
        pushLog(`检测失败 [${code}] ${msg}`)
      } else if (t === 'warn') {
        // ⚠️ 以前**没有处理 warn** —— W1001（未知字段）/ W1004（CHM 缺失）
        //    这些"会算偏但不会报错"的告警全部被丢掉，用户完全看不到。
        pushLog(`⚠️ [${String(ev.code ?? '-')}] ${String(ev.message ?? '')}`)
      } else if (t === 'log') {
        const m = String(ev.message ?? '')
        if (m) pushLog(m)
      } else if (t === 'raw') {
        pushLog(`[sidecar] ${String(ev.line ?? '')}`)
      }
    }).then((u) => {
      if (alive) unEvent = u
      else u()
    })

    void onSidecarLog((line) => pushLog(`[py] ${line}`)).then((u) => {
      if (alive) unLog = u
      else u()
    })

    return () => {
      alive = false
      unEvent?.()
      unLog?.()
    }
  }, [loadGaps, pushLog, detectBegin, detectProgress, detectFinish, markWorkflow])

  /**
   * 拼检测参数。
   *
   * 只有 `input` 是绝对的（来自 /meta），其余是**相对数据根**的路径 ——
   * Rust 侧会按 dev/bundled 两种基准补成绝对路径。
   * 森林掩膜**刻意不写死文件名**：换影像后文件名会变，交给预检自动发现。
   */
  const buildDetectParams = useCallback(
    (): Record<string, unknown> => ({
      input: meta?.source ?? 'drone data/WGR17-002.tif',
      job: 'wgr17-desktop',
      chm_path: 'output/chm.tif',
      segment_path: 'drone data/segment.tif',
      workers: detectParams.workers,
      target_density_per_ha: detectParams.targetDensity,
      // CHM 高度阈值（缺陷台账 P1-3）：三档林龄预设 + 手动微调。
      // 这两个值会进参数指纹，所以改档位 = 瓦片缓存失效 = 需要重跑。
      elevation_core_chm: detectParams.chmCore,
      elevation_veto_chm: detectParams.chmVeto,
    }),
    [meta, detectParams],
  )

  /** 真正启动 sidecar */
  const startDetect = useCallback(
    async (params: Record<string, unknown>, withRoi: boolean) => {
      setStarting(true)
      try {
        const r = await runDetect({ params, roi: withRoi && roi ? roi : undefined })
        if (!r.ok) {
          pushLog(r.message)
          detectFinish({ ok: false, elapsedS: 0, gaps: 0, areaSqm: 0, message: r.message })
          return
        }
        detectBegin()
        const presetLabel =
          detectParams.chmPreset === 'custom'
            ? '自定义'
            : ({ mature: '成熟林', mid: '中龄林', young: '幼龄林' } as const)[
                detectParams.chmPreset as 'mature' | 'mid' | 'young'
              ]
        pushLog(
          `检测已启动（${detectParams.workers} 进程 · 目标密度 ${detectParams.targetDensity}` +
            ` · CHM ${presetLabel} ${detectParams.chmCore.toFixed(1)}/${detectParams.chmVeto.toFixed(1)} m` +
            ` · ${withRoi && roi ? '只跑圈选范围' : '整幅影像'}）`,
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        pushLog(`启动检测失败：${msg}`)
        detectFinish({ ok: false, elapsedS: 0, gaps: 0, areaSqm: 0, message: msg })
      } finally {
        setStarting(false)
        setPreflight(null)
      }
    },
    [roi, pushLog, detectBegin, detectFinish, detectParams],
  )

  /**
   * 点「开始检测」：**先预检，再启动**。
   *
   * 全绿 → 直接跑；有 warn / error → 弹对话框让用户确认。
   * 这一步的价值：chm / segment 缺失时 sidecar 只回一条 W1004 就照常跑完，
   * 结果是"纯 RGB"版本 —— 350 秒后拿到一份看着正常、语义全错的数据。
   */
  const doDetect = useCallback(async () => {
    if (starting || detect.running) return
    const withRoi = detectParams.useRoi && !!roi
    const params = buildDetectParams()
    setStarting(true)
    try {
      const pf = await preflightDetect({
        ...params,
        ...(withRoi && roi ? { roi_geojson: roi } : {}),
      })
      const hasWarn = pf.items.some((i) => i.status === 'warn')
      if (!pf.ok || hasWarn) {
        setPreflight(pf)
        setStarting(false)
        return
      }
      await startDetect(pf.resolved, withRoi)
    } catch (e) {
      setStarting(false)
      const msg = e instanceof Error ? e.message : String(e)
      pushLog(`预检失败：${msg}`)
      // 预检本身出错（例如老版本 Rust 没有这个命令）→ 不拦，直接跑
      await startDetect(params, withRoi)
    }
  }, [starting, detect.running, detectParams, roi, buildDetectParams, startDetect, pushLog])

  /**
   * 点「开始检测」：**先让用户看一眼参数**，确认后才预检 + 开跑。
   *
   * 参数会记住，所以老用户只需要点一下「开始检测」（配置窗里那一个按钮），
   * 多一次点击换来"我确实知道现在用的是什么参数"——对换园区场景值得。
   */
  const onDetect = useCallback(() => {
    if (starting || detect.running) return
    setSettingsIntent('detect')
    setShowSettings(true)
  }, [starting, detect.running])

  // 全局快捷键：Ctrl+Z 撤销 / Ctrl+Y(或 Ctrl+Shift+Z) 重做 / Delete 删除选中 / Esc 退出
  //
  // ⚠️ 必须先判断焦点是否在输入控件里 —— 否则用户在搜索框里按 Ctrl+Z
  //    会撤销多边形（数据没了），而输入框里的文字还留着，非常困惑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      const typing =
        !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      const st = useAppStore.getState()

      if (mod && k === 'z' && !e.shiftKey) {
        if (typing) return
        e.preventDefault()
        st.undo()
        return
      }
      if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) {
        if (typing) return
        e.preventDefault()
        st.redo()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (typing) return
        if (st.selectedIds.length === 0) return
        e.preventDefault()
        st.batchDeleteGaps(st.selectedIds)
        return
      }
      if (e.key === 'Escape') {
        setDrawIntent('none')
        st.clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 导入 KML / GeoJSON 作为 Target Block。
   *
   * 解析在前端纯函数里做（`lib/roiImport.ts`）—— 这样"三维坐标有没有剥干净"
   * 能被 npm test 测住。导入后 `setRoi` 会触发地图 fitBounds，
   * 用户能亲眼确认边界框住了哪片地。
   */
  const onImportRoi = useCallback(async () => {
    const path = await pickRoiFile()
    if (!path) {
      if (!isTauri()) {
        pushLog('浏览器模式不能读取本地文件 —— 请用「启动桌面端.bat」打开桌面应用后再导入')
      }
      return
    }
    try {
      const text = await readTextFile(path)
      const r = parseKmlOrGeoJsonRoi(text, path)
      setRoi(r.geometry)
      const name = r.name || path.split(/[\\/]/).pop()
      pushLog(
        `已导入范围「${name}」：${r.polygonCount} 个多边形取最大，` +
          `${r.rawVertexCount} 个顶点` +
          (r.strippedAltitude ? '（已忽略高程，只保留经纬度）' : ''),
      )
    } catch (e) {
      pushLog(`导入范围失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }, [setRoi, pushLog])

  /** 五步流程的输入（纯函数算状态，UI 只负责渲染） */
  const workflowInput = useMemo(
    () =>
      toInput({
        backendOnline,
        gaps,
        // 「载入过结果」比「当前有要素」更稳定：用户把误报删光后流程不该倒退
        hasResult: wfFlags.loaded,
        roi,
        detectRunning: detect.running,
        detected: wfFlags.detected,
        reviewed: wfFlags.reviewed,
        exported: wfFlags.exported,
        manualAdded,
        manualDeleted,
        manualEdited,
      }),
    [backendOnline, gaps, roi, detect.running, wfFlags, manualAdded, manualDeleted, manualEdited],
  )

  /**
   * 「下一步」卡片的动作分发。
   *
   * 刻意做成一个 switch 而不是十来个回调 prop：卡片永远只可能给这 8 种动作，
   * 集中在一处才好保证"每个动作都有对应的实现"（漏一个就是死按钮）。
   */
  const onWorkflowAction = useCallback(
    (kind: ActionKind) => {
      switch (kind) {
        case 'openData':
          setWizard(appStatus ?? ({} as AppStatus))
          break
        case 'drawRoi':
          setDrawIntent('roi')
          break
        case 'pickRoi':
          void onImportRoi()
          break
        case 'detect':
          void onDetect()
          break
        case 'boxSelect':
          setDrawIntent('box_select')
          break
        case 'goExport':
          // 「复核完成」= 记一笔 + 直接打开导出对话框，不要求再点一次
          markWorkflow({ reviewed: true })
          setShowExport(true)
          break
        case 'export':
          setShowExport(true)
          break
        case 'openOutput':
          if (outputDir) {
            openPath(outputDir).catch((e) =>
              pushLog(`打开目录失败：${e instanceof Error ? e.message : String(e)}`),
            )
          } else {
            setShowExport(true)
          }
          break
      }
    },
    [appStatus, onDetect, onImportRoi, markWorkflow, outputDir, pushLog],
  )

  /**
   * 点步进器上已完成的步骤 = 回看 / 重做这一步。
   *
   * 注意这里是"回到该步骤对应的界面"，不是"把数据回滚"——
   * 回滚数据是撤销（Ctrl+Z）的职责，两者混在一起会很危险。
   */
  const onJumpStep = useCallback(
    (key: StepKey) => {
      switch (key) {
        case 'data':
          setWizard(appStatus ?? ({} as AppStatus))
          break
        case 'range':
          setDrawIntent('roi')
          break
        case 'detect':
          setShowSettings(true)
          break
        case 'review':
          setReviewPeek((n) => n + 1)
          break
        case 'export':
          setShowExport(true)
          break
      }
    },
    [appStatus],
  )



  /**
   * 「这张影像没有加速结构」横幅要不要挂载。
   *
   * 抽成变量而不是在 JSX 里写两遍 —— 这个判定被两个地方用（渲染 + 下面那段注释
   * 说明的避让关系），写散了很容易改一处漏一处。
   */
  const showOvrNotice =
    shouldShowOverviewNotice(meta?.has_overviews, overviewDismissed) &&
    (isTauri() || overviewPreview)

  return (
    <div className="app" style={layoutVars}>
      {/* 每个区域各自兜底：地图挂了，工具栏 / 图层面板 / 状态栏仍可用 */}
      {/* 工具栏 + 参数弹层包在一起：弹层用 top:100% 挂在工具栏下沿，
          工具栏因窄窗口换行时也不会错位 */}
      <div className="tb-wrap">
        <ErrorBoundary area="工具栏">
          <TopToolbar
            workflow={workflowInput}
            onJumpStep={onJumpStep}
            onChangeData={() => setWizard(appStatus ?? ({} as AppStatus))}
            onReloadGaps={() => void loadGaps()}
            onOpenSettings={() => setShowSettings(true)}
            onBuildDerived={() => setShowDerived(true)}
            onAddGap={() => setDrawIntent('add_gap')}
            onBoxSelect={() => setDrawIntent('box_select')}
            onEstimate={runEstimate}
            onOpenLog={() => {
              // 日志目录：开发态在仓库根，打包态在 %LOCALAPPDATA%\fgd\logs
              // 这里只打开"最可能存在的那个"—— 让 Rust 侧判存在性
              void openPath(outputDir || '.').catch(() =>
                pushLog('打开日志目录失败，可在「更多 → 更换影像」里查看当前数据目录'),
              )
            }}
          />
        </ErrorBoundary>

        {showSettings && (
          <ErrorBoundary area="检测参数">
            <DetectSettings
              onClose={() => setShowSettings(false)}
              onStart={
                settingsIntent === 'detect'
                  ? () => {
                      setShowSettings(false)
                      void doDetect()
                    }
                  : undefined
              }
            />
          </ErrorBoundary>
        )}
      </div>

      <ErrorBoundary area="检测进度">
        <DetectBar />
      </ErrorBoundary>

      <main className="body">
        <ErrorBoundary area="图层面板">
          <LeftPanel />
        </ErrorBoundary>
        {/* 左面板右边框的拖拽手柄：向右拖 = 左面板变宽。
            手柄 `position:absolute`（见 styles.css），所以它不占 grid 的列 —— 
            否则 grid 会多出一条 4px 的轨道，布局整体偏移。 */}
        <Resizer
          dir="col"
          className="rs-left"
          label="拖动调整左侧面板宽度"
          onDrag={onDragLeft}
          onEnd={onEndLeft}
        />
        <div className="map-cell">
          <ErrorBoundary area="地图">
            <MapCanvas drawIntent={drawIntent} onDrawDone={onDrawDone} />
          </ErrorBoundary>
          {/* 「这张影像没有加速结构」：挂在地图区顶部，右侧给右上角的缩放控件留了安全区
              （见 styles.css 的 .ovr-banner），不会挡住 +/-。
              桌面端才真正显示；浏览器里只有带 `?noOvr=1` / `?ovr=...` 的截图预览才挂载。 */}
          {showOvrNotice && (
            <ErrorBoundary area="加速结构提示">
              <OverviewNotice
                onDone={probeAndLoad}
                onDismiss={() => setOverviewDismissed(true)}
              />
            </ErrorBoundary>
          )}
          {/* 「下一步」卡片浮在地图右下角：只给一个主动作，走完自动换内容。
              缩放控件已挪到右上角 —— 以前两者都占右下角，+/- 被卡片压住点不到。 */}
          <ErrorBoundary area="下一步提示">
            <NextStepCard
              input={workflowInput}
              outputDir={outputDir || null}
              onAction={onWorkflowAction}
              loadError={gapsError}
            />
          </ErrorBoundary>
        </div>
        {/* 右面板左边框的拖拽手柄：向左拖 = 右面板变宽 */}
        <Resizer
          dir="col"
          className="rs-right"
          label="拖动调整右侧面板宽度"
          onDrag={onDragRight}
          onEnd={onEndRight}
        />
        <ErrorBoundary area="属性面板">
          <RightPanel peekReview={reviewPeek} />
        </ErrorBoundary>
      </main>
      {/* 包一层：手柄要 `position:absolute` 贴在这条状态栏的上边框，
          而 `<footer>` 自己是 grid 容器（不能既当定位锚又当网格） */}
      <div className="status-wrap">
        <Resizer
          dir="row"
          className="rs-status"
          label="拖动调整状态栏高度"
          onDrag={onDragStatus}
          onEnd={onEndStatus}
        />
        <ErrorBoundary area="状态栏">
          <StatusBar staleWarnings={staleWarnings} />
        </ErrorBoundary>
      </div>

      {demoHelp && <HelpDialog doc={HEADER_HELP} onClose={() => setDemoHelp(false)} />}

      {/* 首次使用引导：盖在最上层，选好影像后自动消失 */}
      {wizard && (
        <WelcomeWizard status={wizard} onDone={onWizardDone} onCancel={() => setWizard(null)} />
      )}

      {/* 启动时读到了上次的结果：让用户选「继续复核」还是「重新开始」。
          放在向导旁边（两者不会同时出现：向导是"还没有影像"，这里是"已有结果"）。 */}
      {resumeAsk && (
        <ErrorBoundary area="继续上次结果">
          <ResumeDialog
            count={resumeAsk.count}
            generatedAt={resumeAsk.generatedAt}
            onContinue={onContinueResume}
            onRestart={onRestartResume}
          />
        </ErrorBoundary>
      )}

      {/* 导出交付包 */}
      {showExport && (
        <ErrorBoundary area="导出">
          <ExportDialog onClose={() => setShowExport(false)} />
        </ErrorBoundary>
      )}

      {/* 生成高度图 / 林地边界 */}
      {showDerived && (
        <ErrorBoundary area="生成派生数据">
          <DerivedDialog
            imagePath={meta?.source ?? ''}
            onClose={() => setShowDerived(false)}
          />
        </ErrorBoundary>
      )}

      {/* 检测前预检：只在有问题时出现 */}
      {preflight && (
        <PreflightDialog
          result={preflight}
          busy={starting}
          onCancel={() => setPreflight(null)}
          onOpenData={() => {
            setPreflight(null)
            setWizard(appStatus ?? ({} as AppStatus))
          }}
          onBuildDerived={() => {
            setPreflight(null)
            setShowDerived(true)
          }}
          onProceed={() => {
            const withRoi = detectParams.useRoi && !!roi
            void startDetect(preflight.resolved, withRoi)
          }}
        />
      )}
    </div>
  )
}
