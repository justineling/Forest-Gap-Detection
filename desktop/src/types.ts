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
