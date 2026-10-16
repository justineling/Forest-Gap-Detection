import { create } from 'zustand'
import type {
  EstimateResult,
  GapClass,
  GapFeature,
  PolygonGeometry,
  PriorityGroup,
  RasterMeta,
} from '../types'
import { ALL_CLASSES, CLASS_STYLES, GROUP_META } from '../lib/classes'
import { estimate } from '../lib/estimate'
import { centroid, polygonAreaM2 } from '../lib/geometry'

const MAX_LOGS = 300

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

  // —— ROI（需求 2）——
  roi: PolygonGeometry | null

  // —— 估算（需求 5）——
  estimateResult: EstimateResult | null
  estimating: boolean

  // —— 编辑计数（需求 4 留痕）——
  manualAdded: number
  manualDeleted: number
  manualEdited: number

  logs: string[]

  // —— actions ——
  setBackend: (p: { online: boolean; meta?: RasterMeta; error?: string }) => void
  setGaps: (features: GapFeature[]) => void
  toggleClass: (cls: GapClass) => void
  setGroupVisible: (group: PriorityGroup, visible: boolean) => void
  select: (id: string | null) => void
  addGap: (geom: PolygonGeometry) => string
  deleteGap: (id: string) => void
  updateGapGeometry: (id: string, geom: PolygonGeometry) => void
  setGapClass: (id: string, cls: GapClass) => void
  setRoi: (geom: PolygonGeometry | null) => void
  runEstimate: () => void
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

  roi: null,

  estimateResult: null,
  estimating: false,

  manualAdded: 0,
  manualDeleted: 0,
  manualEdited: 0,

  logs: [],

  setBackend: ({ online, meta, error }) =>
    set((s) => ({
      backendOnline: online,
      meta: meta ?? s.meta,
      backendError: error ?? null,
    })),

  setGaps: (features) =>
    set((s) => ({
      gaps: features,
      estimateResult: null,
      logs: appendLog(s.logs, `载入 ${features.length} 个多边形`),
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

  runEstimate: () => {
    const { gaps } = get()
    set({ estimating: true })
    // 同步计算（前端原型）：总量约 1,700 个多边形、几千个候选点，实测 < 200 ms
    const t0 = performance.now()
    const res = estimate(gaps)
    const ms = Math.round(performance.now() - t0)
    set((s) => ({
      estimateResult: res,
      estimating: false,
      logs: appendLog(
        s.logs,
        `估算完成（${ms} ms）：面积口径 ${res.by_area.toLocaleString()} 株 / ` +
          `排坑口径 ${res.by_grid.toLocaleString()} 株，差异 ${res.divergence_pct}%`,
      ),
    }))
  },

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
