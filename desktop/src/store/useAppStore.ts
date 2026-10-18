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

/**
 * 撤销/重做步数上限。
 *
 * 为什么快照很便宜：要素对象**从不可变**（所有修改都用 spread 生成新对象），
 * 所以一次快照只是 `gaps.slice()` —— 1,726 个指针约 14 KB，40 步不到 1 MB。
 * 千万不要为了"省内存"改成深拷贝，那会变成几十 MB 并且更慢。
 */
const HISTORY_LIMIT = 40

/** 一次可撤销操作的完整状态快照 */
export interface HistoryEntry {
  label: string
  gaps: GapFeature[]
  deletedFeatures: GapFeature[]
  selectedIds: string[]
  manualAdded: number
  manualDeleted: number
  manualEdited: number
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
  /**
   * 多选（真相）。
   * `selectedId` 只是"恰好选中一个"的便捷字段 —— 多选时它为 null，
   * 因为属性面板和 Terra Draw 的几何编辑都只对**单块**有意义。
   */
  selectedIds: string[]
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

  // —— 撤销 / 重做（P1）——
  past: HistoryEntry[]
  future: HistoryEntry[]

  // —— 地图聚焦（P1 复核清单）——
  /** nonce 递增：同一块连续点两次也要能再飞一次 */
  focus: { id: string; nonce: number } | null

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
  /** Shift/Ctrl + 点击：加选 / 减选 */
  toggleSelect: (id: string) => void
  /** 框选结果整体替换选择 */
  selectMany: (ids: string[]) => void
  clearSelection: () => void
  /** 批量删除 —— **一次操作 = 一步撤销** */
  batchDeleteGaps: (ids: string[]) => void
  /** 批量改判 —— 同上 */
  batchSetClass: (ids: string[], cls: GapClass) => void
  undo: () => void
  redo: () => void
  /** 把某个类别打开显示（复核清单点进隐藏类别时用） */
  ensureVisible: (cls: GapClass) => void
  /** 请地图飞到某块（配合复核清单） */
  focusGap: (id: string) => void
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

/**
 * 上一次几何编辑（用于合并连续拖拽）。
 *
 * ⚠️ 为什么需要：TerraDraw 在拖拽顶点时**每移动几个像素就触发一次 change**，
 *    一次拖拽能产生几十次 `updateGapGeometry`。如果每次都压历史，
 *    拖一次顶点就把 40 步撤销栈吃光 —— 用户随后按 Ctrl+Z 只会看到
 *    "边界一点点回退"，而不是"回到拖之前"。
 *
 * 所以 1.5 秒内的同一要素连续几何更新只压**第一条**快照。
 */
let lastGeomEdit: { id: string; at: number } | null = null

/** 抓一份可撤销快照（浅拷贝数组，要素对象共享） */
function snap(s: AppState, label: string): HistoryEntry {
  return {
    label,
    gaps: s.gaps.slice(),
    deletedFeatures: s.deletedFeatures.slice(),
    selectedIds: s.selectedIds.slice(),
    manualAdded: s.manualAdded,
    manualDeleted: s.manualDeleted,
    manualEdited: s.manualEdited,
  }
}

/**
 * 把一次修改提交进历史。
 *
 * ⚠️ **所有会改 gaps 的 action 都必须走这里**，否则撤销会跳过那一步，
 *    用户按 Ctrl+Z 看到的是"跳过了刚才那次修改"，比不能撤销更困惑。
 * ⚠️ 新操作必须清空 `future` —— 否则会出现"撤销 → 改别的 → 还能重做回旧分支"
 *    这种时间线分叉。
 */
function commit(s: AppState, label: string, patch: Partial<AppState>): Partial<AppState> {
  return {
    ...patch,
    past: [...s.past, snap(s, label)].slice(-HISTORY_LIMIT),
    future: [],
    estimateResult: null,
  }
}

/** 选择集变化时同步便捷字段 `selectedId` */
function sel(ids: string[]): Pick<AppState, 'selectedIds' | 'selectedId'> {
  return { selectedIds: ids, selectedId: ids.length === 1 ? ids[0] : null }
}

export const useAppStore = create<AppState>()((set, get) => ({
  backendOnline: false,
  backendError: null,
  meta: null,

  gaps: [],
  visibleClasses: initialVisibility(),
  selectedIds: [],
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

  past: [],
  future: [],
  focus: null,

  detectParams: loadDetectParams(),
  detect: { ...IDLE_DETECT },

  setBackend: ({ online, meta, error }) =>
    set((s) => ({
      backendOnline: online,
      meta: meta ?? s.meta,
      backendError: error ?? null,
    })),

  setGaps: (features, plantingGrid) => {
    // 换基线时重置拖拽合并窗口，否则紧接着的第一次编辑会被误判成"上一次拖拽的后续"
    lastGeomEdit = null
    set((s) => ({
      gaps: features,
      plantingGrid: plantingGrid ?? null,
      // 载入新一轮结果 = 换基线，上一轮的删除记录与历史都不再适用
      // （撤销到"上一份数据"没有意义，而且会和新基线混在一起）
      deletedFeatures: [],
      past: [],
      future: [],
      ...sel([]),
      estimateResult: null,
      logs: appendLog(
        s.logs,
        `载入 ${features.length} 个多边形` +
          (plantingGrid?.anchor_lon != null
            ? '（已对齐算法种植网格锚点）'
            : '（无算法网格锚点，估算相位不可复现）'),
      ),
    }))
  },

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

  select: (id) => set(sel(id ? [id] : [])),

  toggleSelect: (id) =>
    set((s) => {
      const has = s.selectedIds.includes(id)
      return sel(has ? s.selectedIds.filter((x) => x !== id) : [...s.selectedIds, id])
    }),

  selectMany: (ids) => set(sel(ids)),

  clearSelection: () => set(sel([])),

  ensureVisible: (cls) =>
    set((s) => (s.visibleClasses[cls] ? {} : { visibleClasses: { ...s.visibleClasses, [cls]: true } })),

  focusGap: (id) =>
    set((s) => ({
      ...sel([id]),
      focus: { id, nonce: (s.focus?.nonce ?? 0) + 1 },
    })),

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1]
      if (!prev) return {}
      const cur = snap(s, '当前状态')
      return {
        gaps: prev.gaps,
        deletedFeatures: prev.deletedFeatures,
        ...sel(prev.selectedIds),
        manualAdded: prev.manualAdded,
        manualDeleted: prev.manualDeleted,
        manualEdited: prev.manualEdited,
        past: s.past.slice(0, -1),
        future: [cur, ...s.future].slice(0, HISTORY_LIMIT),
        estimateResult: null,
        logs: appendLog(s.logs, `↶ 撤销：${prev.label}`),
      }
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0]
      if (!next) return {}
      const cur = snap(s, '当前状态')
      return {
        gaps: next.gaps,
        deletedFeatures: next.deletedFeatures,
        ...sel(next.selectedIds),
        manualAdded: next.manualAdded,
        manualDeleted: next.manualDeleted,
        manualEdited: next.manualEdited,
        past: [...s.past, cur].slice(-HISTORY_LIMIT),
        future: s.future.slice(1),
        estimateResult: null,
        logs: appendLog(s.logs, `↷ 重做：${next.label}`),
      }
    }),

  batchDeleteGaps: (ids) =>
    set((s) => {
      const pick = new Set(ids)
      const removed = s.gaps.filter((f) => pick.has(f.properties.gap_id))
      if (removed.length === 0) return {}
      const area = removed.reduce((a, f) => a + (f.properties.area_sqm ?? 0), 0)
      return commit(s, `批量删除 ${removed.length} 块`, {
        gaps: s.gaps.filter((f) => !pick.has(f.properties.gap_id)),
        // 留几何快照：重跑时要靠它把"用户删掉的那些"认回来
        deletedFeatures: [...s.deletedFeatures, ...removed],
        ...sel([]),
        manualDeleted: s.manualDeleted + removed.length,
        logs: appendLog(
          s.logs,
          `批量删除 ${removed.length} 块（合计 ${Math.round(area).toLocaleString()} m²）`,
        ),
      })
    }),

  batchSetClass: (ids, cls) =>
    set((s) => {
      const pick = new Set(ids)
      let n = 0
      const gaps = s.gaps.map((f) => {
        if (!pick.has(f.properties.gap_id)) return f
        if (f.properties.class === cls) return f
        n++
        return {
          ...f,
          properties: {
            ...f.properties,
            original_class: f.properties.original_class ?? f.properties.class,
            class: cls,
            class_label: CLASS_STYLES[cls].label,
            class_reason: '用户批量改判',
            edited: true,
            edited_by: 'user',
          },
        }
      })
      if (n === 0) return {}
      return commit(s, `批量改判 ${n} 块为${CLASS_STYLES[cls].label}`, {
        gaps,
        manualEdited: s.manualEdited + n,
        logs: appendLog(s.logs, `批量改判 ${n} 块为 ${CLASS_STYLES[cls].label}`),
      })
    }),

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
    set((s) =>
      commit(s, `新增 ${id}`, {
        gaps: [feat, ...s.gaps],
        manualAdded: s.manualAdded + 1,
        ...sel([id]),
        logs: appendLog(s.logs, `人工新增 ${id}（${feat.properties.area_sqm} m²）`),
      }),
    )
    return id
  },

  deleteGap: (id) =>
    set((s) => {
      const feat = s.gaps.find((f) => f.properties.gap_id === id)
      if (!feat) return s
      return commit(s, `删除 ${id}`, {
        gaps: s.gaps.filter((f) => f.properties.gap_id !== id),
        // 留快照：重跑时要靠几何把"用户删掉的那块"从新结果里认出来
        deletedFeatures: [...s.deletedFeatures, feat],
        ...sel(s.selectedIds.filter((x) => x !== id)),
        manualDeleted: s.manualDeleted + 1,
        logs: appendLog(
          s.logs,
          `删除 ${id}（原类别 ${feat.properties.class_label ?? feat.properties.class}，` +
            `${feat.properties.area_sqm} m²）`,
        ),
      })
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
      const now = Date.now()
      const coalesce =
        lastGeomEdit !== null && lastGeomEdit.id === id && now - lastGeomEdit.at < 1500
      lastGeomEdit = { id, at: now }

      if (coalesce) {
        // 同一次拖拽的后续帧：只更新几何，不再压历史、不再刷日志
        return { gaps, manualEdited: s.manualEdited + 1, estimateResult: null }
      }
      return commit(s, `修改 ${id} 的边界`, {
        gaps,
        manualEdited: s.manualEdited + 1,
        logs: appendLog(s.logs, `修改 ${id} 的边界`),
      })
    }),

  setGapClass: (id, cls) =>
    set((s) => {
      const cur = s.gaps.find((f) => f.properties.gap_id === id)
      if (!cur || cur.properties.class === cls) return {}
      return commit(s, `改判 ${id} 为${CLASS_STYLES[cls].label}`, {
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
        manualEdited: s.manualEdited + 1,
        logs: appendLog(s.logs, `改判 ${id} 类别为 ${CLASS_STYLES[cls].label}`),
      })
    }),

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
    set((cur) =>
      commit(cur, '重跑合并', {
      gaps: r.features,
      // 合并完就换基线：新结果的 gap_id 已经是新的，旧删除记录不再适用
      deletedFeatures: [],
      ...sel([]),
      logs: appendLog(
        s.logs,
        `重跑合并（${mode === 'keep_manual' ? '保留人工' : '完全覆盖'}）：` +
          `人工新增 ${r.stats.kept_manual}` +
          (mode === 'keep_manual'
            ? ` · 重放删除 ${r.stats.replayed_deletes} · 重放改判 ${r.stats.replayed_edits}`
            : ` · 丢弃 ${r.stats.dropped_manual}`) +
          ` · 算法要素 ${r.stats.passthrough} · 合计 ${r.stats.total}`,
      ),
      }),
    )
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
