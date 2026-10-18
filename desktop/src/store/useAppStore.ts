import { create } from 'zustand'
import type {
  EstimateResult,
  GapClass,
  GapFeature,
  PlantingGrid,
  PolygonGeometry,
  PriorityGroup,
  RasterMeta,
  DetectParams,
  DetectProgress,
  DetectRun,
  DetectFinished,
} from '../types'
import { ALL_CLASSES, CLASS_STYLES, GROUP_META } from '../lib/classes'
import { estimate, DEFAULT_GRID } from '../lib/estimate'
import { centroid, polygonAreaM2 } from '../lib/geometry'
import { mergeManualEdits, type MergeMode, type MergeStats } from '../lib/mergeEdits'

const MAX_LOGS = 300

// —— 检测参数持久化 ——
// 用 localStorage 而不是 settings.json：这是**界面偏好**（不是数据路径），
// 换台机器重新选一次也合理，而且不需要跨 Rust 边界。
const DETECT_PARAMS_KEY = 'fgd.detectParams'
export const DEFAULT_DETECT_PARAMS: DetectParams = {
  workers: 4,
  targetDensity: 150,
  useRoi: true,
}

function loadDetectParams(): DetectParams {
  // 测试跑在 node 里，没有 localStorage —— 必须兜住，否则 store 一 import 就炸
  if (typeof localStorage === 'undefined') return { ...DEFAULT_DETECT_PARAMS }
  try {
    const raw = localStorage.getItem(DETECT_PARAMS_KEY)
    if (!raw) return { ...DEFAULT_DETECT_PARAMS }
    const o = JSON.parse(raw) as Partial<DetectParams>
    return { ...DEFAULT_DETECT_PARAMS, ...o }
  } catch {
    return { ...DEFAULT_DETECT_PARAMS }
  }
}

function saveDetectParams(p: DetectParams): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(DETECT_PARAMS_KEY, JSON.stringify(p))
  } catch {
    /* 隐私模式 / 配额满：静默放弃，参数只在本次会话有效 */
  }
}

const IDLE_DETECT: DetectRun = {
  running: false,
  stage: 'idle',
  done: 0,
  total: 0,
  ratio: 0,
  elapsedS: 0,
  etaS: null,
  gapsFound: 0,
  gapAreaSqm: 0,
  startedAt: null,
  finished: null,
}

function initialVisibility(): Record<GapClass, boolean> {
  const out = {} as Record<GapClass, boolean>
  for (const c of ALL_CLASSES) out[c] = CLASS_STYLES[c].defaultVisible
  return out
}

export interface AppState {
  // —— 后端 ——
  backendOnline: boolean
  backendError: string | null
  meta: RasterMeta | null

  // —— 数据 ——
  gaps: GapFeature[]
  visibleClasses: Record<GapClass, boolean>
  selectedId: string | null
  /**
   * 算法侧种植网格（含 `/gaps` 补算的 WGS84 锚点）。
   * 有它 → 前端估算的格点相位与 Python 侧一致（3,912 株口径）；
   * 没有 → 退回几何原点，相位任意（离线演示数据时会这样）。
   */
  plantingGrid: PlantingGrid | null
  /**
   * 被用户删掉的要素**快照**（不是 id 集合）。
   *
   * 为什么留几何：算法重跑后 gap_id 全部重编，只能靠几何判断
   * "新结果里哪一块就是用户当初删掉的那块"，才能重放删除。
   * 见 `lib/mergeEdits.ts`。
   */
  deletedFeatures: GapFeature[]

  // —— ROI（需求 2）——
  roi: PolygonGeometry | null

  // —— 估算（需求 5）——
  estimateResult: EstimateResult | null
  estimating: boolean
  /** 排坑退让距离（m）。默认 0.5 —— 依据见 lib/estimate.ts 的 DEFAULT_GRID 注释 */
  clearanceM: number

  // —— 编辑计数（需求 4 留痕）——
  manualAdded: number
  manualDeleted: number
  manualEdited: number

  logs: string[]

  // —— 检测（P0 检测面板）——
  /** 用户可调的检测参数（持久化） */
  detectParams: DetectParams
  /** 运行态：驱动进度条 / 完成提示 */
  detect: DetectRun

  // —— actions ——
  setBackend: (p: { online: boolean; meta?: RasterMeta; error?: string }) => void
  setGaps: (features: GapFeature[], plantingGrid?: PlantingGrid | null) => void
  toggleClass: (cls: GapClass) => void
  setGroupVisible: (group: PriorityGroup, visible: boolean) => void
  select: (id: string | null) => void
  addGap: (geom: PolygonGeometry) => string
  deleteGap: (id: string) => void
  updateGapGeometry: (id: string, geom: PolygonGeometry) => void
  setGapClass: (id: string, cls: GapClass) => void
  setRoi: (geom: PolygonGeometry | null) => void
  setClearance: (m: number) => void
  runEstimate: () => void
  /**
   * 算法重跑后合并新结果（PRD 附录 C · R-P1-8）。
   *
   * 不直接 setGaps —— 那会把用户上一轮的删除/改判全丢掉。
   * 走 `mergeManualEdits` 把人工操作重放到新结果上，返回统计供 UI 汇报。
   */
  applyRerun: (newFeatures: GapFeature[], mode?: MergeMode) => MergeStats
  /** 改检测参数（自动持久化） */
  setDetectParam: (patch: Partial<DetectParams>) => void
  detectBegin: () => void
  detectProgress: (p: DetectProgress) => void
  detectFinish: (r: DetectFinished) => void
  /** 关掉完成提示 / 清掉失败态 */
  detectReset: () => void
  pushLog: (msg: string) => void
}

let manualSeq = 0

export const useAppStore = create<AppState>()((set, get) => ({
  backendOnline: false,
  backendError: null,
  meta: null,

  gaps: [],
  visibleClasses: initialVisibility(),
  selectedId: null,
  plantingGrid: null,
  deletedFeatures: [],

  roi: null,

  estimateResult: null,
  estimating: false,
  clearanceM: DEFAULT_GRID.clearance_m,

  manualAdded: 0,
  manualDeleted: 0,
  manualEdited: 0,

  logs: [],

  detectParams: loadDetectParams(),
  detect: { ...IDLE_DETECT },

  setBackend: ({ online, meta, error }) =>
    set((s) => ({
      backendOnline: online,
      meta: meta ?? s.meta,
      backendError: error ?? null,
    })),

  setGaps: (features, plantingGrid) =>
    set((s) => ({
      gaps: features,
      plantingGrid: plantingGrid ?? null,
      // 载入新一轮结果 = 换基线，上一轮的删除记录不再适用
      deletedFeatures: [],
      estimateResult: null,
      logs: appendLog(
        s.logs,
        `载入 ${features.length} 个多边形` +
          (plantingGrid?.anchor_lon != null
            ? '（已对齐算法种植网格锚点）'
            : '（无算法网格锚点，估算相位不可复现）'),
      ),
    })),

  toggleClass: (cls) =>
    set((s) => ({ visibleClasses: { ...s.visibleClasses, [cls]: !s.visibleClasses[cls] } })),

  setGroupVisible: (group, visible) =>
    set((s) => {
      const next = { ...s.visibleClasses }
      for (const c of ALL_CLASSES) {
        if (CLASS_STYLES[c].group === group) next[c] = visible
      }
      return { visibleClasses: next }
    }),

  select: (id) => set({ selectedId: id }),

  addGap: (geom) => {
    manualSeq += 1
    const id = `M${String(manualSeq).padStart(4, '0')}`
    const area = polygonAreaM2(geom)
    const c = centroid(geom)
    const feat: GapFeature = {
      type: 'Feature',
      geometry: geom,
      properties: {
        gap_id: id,
        class: 'manual_add',
        class_label: CLASS_STYLES.manual_add.label,
        area_sqm: Math.round(area * 10) / 10,
        source: 'manual',
        edited: true,
        edited_by: 'user',
        class_reason: '用户手工新增',
        // 记下与最近格点的距离，供属性面板提示是否与种植网格矛盾
        node_distance_m: null,
        centroid_utm: [c[0], c[1]],
      },
    }
    set((s) => ({
      gaps: [feat, ...s.gaps],
      manualAdded: s.manualAdded + 1,
      selectedId: id,
      estimateResult: null,
      logs: appendLog(s.logs, `人工新增 ${id}（${feat.properties.area_sqm} m²）`),
    }))
    return id
  },

  deleteGap: (id) =>
    set((s) => {
      const feat = s.gaps.find((f) => f.properties.gap_id === id)
      if (!feat) return s
      return {
        gaps: s.gaps.filter((f) => f.properties.gap_id !== id),
        // 留快照：重跑时要靠几何把"用户删掉的那块"从新结果里认出来
        deletedFeatures: [...s.deletedFeatures, feat],
        selectedId: s.selectedId === id ? null : s.selectedId,
        manualDeleted: s.manualDeleted + 1,
        estimateResult: null,
        logs: appendLog(
          s.logs,
          `删除 ${id}（原类别 ${feat.properties.class_label ?? feat.properties.class}，` +
            `${feat.properties.area_sqm} m²）`,
        ),
      }
    }),

  updateGapGeometry: (id, geom) =>
    set((s) => {
      const gaps = s.gaps.map((f) => {
        if (f.properties.gap_id !== id) return f
        const area = polygonAreaM2(geom)
        return {
          ...f,
          geometry: geom,
          properties: {
            ...f.properties,
            area_sqm: Math.round(area * 10) / 10,
            edited: true,
            edited_by: 'user',
            original_class: f.properties.original_class ?? f.properties.class,
          },
        }
      })
      return {
        gaps,
        manualEdited: s.manualEdited + 1,
        estimateResult: null,
        logs: appendLog(s.logs, `修改 ${id} 的边界`),
      }
    }),

  setGapClass: (id, cls) =>
    set((s) => ({
      gaps: s.gaps.map((f) =>
        f.properties.gap_id === id
          ? {
              ...f,
              properties: {
                ...f.properties,
                // ⚠️ original_class 必须在覆盖 class 之前取旧值
                original_class: f.properties.original_class ?? f.properties.class,
                class: cls,
                class_label: CLASS_STYLES[cls].label,
                class_reason: '用户手工改判',
                edited: true,
                edited_by: 'user',
              },
            }
          : f,
      ),
      estimateResult: null,
      logs: appendLog(s.logs, `改判 ${id} 类别为 ${CLASS_STYLES[cls].label}`),
    })),

  setRoi: (geom) =>
    set((s) => ({
      roi: geom,
      logs: appendLog(
        s.logs,
        geom
          ? `已圈选 Target Block（${Math.round(polygonAreaM2(geom)).toLocaleString()} m²）—— 检测将只处理圈内`
          : '已清除 Target Block 圈选',
      ),
    })),

  setClearance: (m) =>
    set((s) => ({
      clearanceM: m,
      // 退让变了，旧估算结果立刻失效（避免界面显示过期株数）
      estimateResult: null,
      logs: appendLog(s.logs, `排坑退让距离改为 ${m} m`),
    })),

  runEstimate: () => {
    const { gaps, clearanceM, plantingGrid } = get()
    set({ estimating: true })
    // 同步计算（前端原型）：1,726 个多边形、几千个候选点，实测 < 400 ms
    const t0 = performance.now()
    const res = estimate(gaps, {
      clearance_m: clearanceM,
      planting_grid: plantingGrid ?? undefined,
    })
    const ms = Math.round(performance.now() - t0)
    set((s) => ({
      estimateResult: res,
      estimating: false,
      logs: appendLog(
        s.logs,
        `估算完成（${ms} ms，原点=${res.origin_source}）：面积口径 ` +
          `${res.by_area.toLocaleString()} 株 / ` +
          `排坑口径 ${res.by_grid.toLocaleString()} 株，差异 ${res.divergence_pct}%`,
      ),
    }))
  },

  applyRerun: (newFeatures, mode = 'keep_manual') => {
    const s = get()
    const r = mergeManualEdits({
      prevFeatures: s.gaps,
      deletedFeatures: s.deletedFeatures,
      newFeatures,
      mode,
    })
    set({
      gaps: r.features,
      // 合并完就换基线：新结果的 gap_id 已经是新的，旧删除记录不再适用
      deletedFeatures: [],
      selectedId: null,
      estimateResult: null,
      logs: appendLog(
        s.logs,
        `重跑合并（${mode === 'keep_manual' ? '保留人工' : '完全覆盖'}）：` +
          `人工新增 ${r.stats.kept_manual}` +
          (mode === 'keep_manual'
            ? ` · 重放删除 ${r.stats.replayed_deletes} · 重放改判 ${r.stats.replayed_edits}`
            : ` · 丢弃 ${r.stats.dropped_manual}`) +
          ` · 算法要素 ${r.stats.passthrough} · 合计 ${r.stats.total}`,
      ),
    })
    for (const w of r.warnings) {
      set((cur) => ({ logs: appendLog(cur.logs, `⚠️ ${w}`) }))
    }
    return r.stats
  },

  setDetectParam: (patch) =>
    set((s) => {
      const next = { ...s.detectParams, ...patch }
      saveDetectParams(next)
      return { detectParams: next }
    }),

  detectBegin: () =>
    set({
      detect: {
        ...IDLE_DETECT,
        running: true,
        stage: 'starting',
        startedAt: Date.now(),
      },
    }),

  detectProgress: (p) =>
    set((s) => ({
      detect: {
        ...s.detect,
        running: true,
        stage: p.stage ?? s.detect.stage,
        // ⚠️ 用 ?? 而不是 ||：done=0 是合法值（第一块还没完成）
        done: p.done ?? s.detect.done,
        total: p.total ?? s.detect.total,
        ratio: p.ratio ?? s.detect.ratio,
        elapsedS: p.elapsed_s ?? s.detect.elapsedS,
        etaS: p.eta_s ?? s.detect.etaS,
        gapsFound: p.gaps_found ?? s.detect.gapsFound,
        gapAreaSqm: p.gap_area_sqm ?? s.detect.gapAreaSqm,
      },
    })),

  detectFinish: (r) =>
    set((s) => ({
      detect: { ...s.detect, running: false, stage: r.ok ? 'done' : 'failed', finished: r },
    })),

  detectReset: () => set({ detect: { ...IDLE_DETECT } }),

  pushLog: (msg) => set((s) => ({ logs: appendLog(s.logs, msg) })),
}))

function appendLog(logs: string[], msg: string): string[] {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const next = [...logs, `[${stamp}] ${msg}`]
  return next.length > MAX_LOGS ? next.slice(next.length - MAX_LOGS) : next
}

/** 当前可见（地图上会渲染）的要素 */
export function selectVisibleGaps(
  s: Pick<AppState, 'gaps' | 'visibleClasses'>,
): GapFeature[] {
  return s.gaps.filter((f) => s.visibleClasses[f.properties.class])
}

export { GROUP_META }
