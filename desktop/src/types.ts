import type { ChmPreset } from './lib/chm'

/**
 * 领域类型定义。
 *
 * 与 Python 侧输出（`output/wgr17-final-gaps.geojson`）以及
 * `docs/01-需求与架构/推理服务契约.md` 的 schema 保持一致。
 */

/** 算法输出的 8 个类别 + 1 个人工新增类别（v0.4 新增，见 PRD 附录 C · R-P1-8） */
export type GapClass =
  | 'vacant_slot' // 株位空缺
  | 'alley_gap' // 林间空隙（正常行间缝隙，无需补种）
  | 'open_patch' // 连片空地
  | 'uncertain' // 不确定（需人工核实）
  | 'road' // 道路
  | 'water' // 水体
  | 'office' // 办公生活区
  | 'undeveloped' // 非种植区（未开发林）
  | 'manual_add' // 人工新增

/** 三档业务口径（`summary.by_priority`） */
export type PriorityGroup = 'definite_plant' | 'review' | 'not_needed' | 'unplantable'

export interface GapProps {
  gap_id: string
  class: GapClass
  class_label?: string
  class_confidence?: number
  class_method?: string
  class_reason?: string
  area_sqm: number
  centroid_utm?: [number, number]
  grid_cell?: string
  node_distance_m?: number | null
  coverage_ratio?: number
  elongation?: number
  /** 人工编辑留痕 */
  edited?: boolean
  edited_by?: string
  original_class?: GapClass
  source?: 'algo' | 'manual'
  /**
   * 重跑后重放改判时写入：这条要素的人工类别是从哪个旧 gap_id 重放过来的。
   * 用于事后核对"这次重放是不是猜错了"（见 `lib/mergeEdits.ts`）。
   */
  replayed_from?: string
}

/** 最小 GeoJSON 类型（不引 @types/geojson，避免多余依赖） */
export type Position = [number, number]
export interface PolygonGeometry {
  type: 'Polygon'
  coordinates: Position[][]
}
export interface MultiPolygonGeometry {
  type: 'MultiPolygon'
  coordinates: Position[][][]
}
export type GapGeometry = PolygonGeometry | MultiPolygonGeometry

export interface GapFeature {
  type: 'Feature'
  id?: string | number
  geometry: GapGeometry
  properties: GapProps
}

export interface GapCollection {
  type: 'FeatureCollection'
  features: GapFeature[]
  /** 算法侧的种植网格模型（`/gaps` 会补上 WGS84 锚点，见 TileServer.gaps_json） */
  planting_grid?: PlantingGrid
}

/**
 * 种植网格模型 —— 权威定义在 Python 侧（`planting_grid.py` 的 `GridModel`），
 * 前端只读不改。字段与 `output/*.geojson` 的 `planting_grid` 一一对应。
 *
 * ⚠️ `origin_x_m / origin_y_m` 是 **UTM 49N 绝对坐标**下的数学锚点（可能离园区
 * 几百公里），前端**不要**直接拿它当局部原点。要用 `/gaps` 端点补算的
 * `anchor_lon / anchor_lat`（结果范围中心最近的那个格点的经纬度）。
 */
export interface PlantingGrid {
  plant_pitch_m: number
  row_pitch_m: number
  skew_offset_m?: number
  /** 行方位角（Python 侧字段名） */
  row_azimuth_deg: number
  /** 同上，前端友好的别名（`/gaps` 会补） */
  azimuth_deg?: number
  origin_x_m: number
  origin_y_m: number
  quality?: number
  method?: string
  density_per_ha?: number
  /** —— 以下由 `/gaps` 端点动态补算（磁盘文件里没有）—— */
  anchor_lon?: number
  anchor_lat?: number
  anchor_ix?: number
  anchor_iy?: number
  crs?: string
}

/** `/meta` 返回的影像元数据 */
export interface RasterMeta {
  ok: boolean
  source: string
  width: number
  height: number
  crs: string
  res_m: number
  bounds_wgs84: [number, number, number, number] // west, south, east, north
  center: [number, number]
  zoom: number
  valid_ratio?: number
  tile_url: string
}

/** 补种点位 */
export interface PlantingPoint {
  lon: number
  lat: number
  gap_id: string
  /** 该点距所属多边形边界的距离（m），用于复核 */
  edge_dist_m: number
}

/** 估算结果（双口径） */
export interface EstimateResult {
  /** 面积折算口径：floor(area / 66.67) */
  by_area: number
  /** 网格排坑口径：按株距/行距/错行铺格点后计数 */
  by_grid: number
  /** 两者差值占比 —— 差值大说明形状破碎或退让吃掉大量面积，UI 应标黄 */
  divergence_pct: number
  area_sqm: number
  per_gap: Array<{
    gap_id: string
    class: GapClass
    area_sqm: number
    by_area: number
    by_grid: number
    divergence_pct: number
  }>
  points: PlantingPoint[]
  /** 本次估算用的种植规格（来自 planting_grid） */
  grid: {
    plant_pitch_m: number
    row_pitch_m: number
    azimuth_deg: number
    clearance_m: number
    skew_m?: number
  }
  /** 本次实际使用的网格原点（经纬度） */
  origin?: [number, number]
  /**
   * 原点来源：
   * - `planting_grid`：算法锚点 —— 与 Python 侧逐格一致，**唯一可对外报数的口径**
   * - `explicit`：调用方显式指定
   * - `geometry`：几何原点（任意相位，与 Python 差 +8.8%，仅作离线降级）
   */
  origin_source?: 'planting_grid' | 'explicit' | 'geometry'
}

// ============================================================================
//  检测（P0 检测面板）
//  ---------------------------------------------------------------------------
//  字段名严格对齐 `scripts/sidecar.py` 的 emit()：
//    progress → stage / done / total / ratio / elapsed_s / eta_s /
//               tiles_new / tiles_cached / tiles_failed / gaps_found / gap_area_sqm
//  ⚠️ 改后端 emit 字段时必须同步这里，否则进度条会永远停在 0%
//     （`ev.done` 取不到就是 undefined，UI 静默不更新）。
// ============================================================================

/** 用户可以调的三个检测参数（持久化到 localStorage） */
export interface DetectParams {
  /** 并行进程数：1=串行，0=自动 min(6, cpu//2) */
  workers: number
  /** 目标种植密度（株/ha），影响株位空缺的判定 */
  targetDensity: number
  /** 只检测圈选范围（没圈选时忽略） */
  useRoi: boolean
  /**
   * CHM 救援线（m）：冠层高度 ≥ 它 → 一定判为树（从"空地"里救回来）。
   * 三档预设与互锁约束见 `lib/chm.ts`。
   */
  chmCore: number
  /** CHM 否决线（m）：冠层高度 < 它 → 一定判为非树 */
  chmVeto: number
  /** 当前林龄档位；手动微调后变 'custom' */
  chmPreset: ChmPreset
}

/** sidecar 的 progress 事件（原样收下，缺失字段一律当 undefined） */
export interface DetectProgress {
  stage?: string
  done?: number
  total?: number
  ratio?: number
  elapsed_s?: number
  eta_s?: number | null
  tiles_new?: number
  tiles_cached?: number
  tiles_failed?: number
  gaps_found?: number
  gap_area_sqm?: number
  message?: string
}

/** 一次检测结束时的结果 */
export interface DetectFinished {
  ok: boolean
  elapsedS: number
  gaps: number
  areaSqm: number
  message: string
}

/** 检测运行态（驱动进度条） */
export interface DetectRun {
  running: boolean
  stage: string
  done: number
  total: number
  ratio: number
  elapsedS: number
  etaS: number | null
  gapsFound: number
  gapAreaSqm: number
  startedAt: number | null
  /** 最近一次结束；null = 本次会话还没跑过 */
  finished: DetectFinished | null
}

export type PreflightStatus = 'ok' | 'warn' | 'error' | 'info'

/** 预检的单项结果 */
export interface PreflightItem {
  key: string
  label: string
  /** 解析后的绝对路径（info 类可能为空） */
  path: string
  status: PreflightStatus
  detail: string
}

/** 预检汇总。`resolved` 是补全后的参数，原样交给 run_detect */
export interface PreflightResult {
  ok: boolean
  items: PreflightItem[]
  resolved: Record<string, unknown>
}
