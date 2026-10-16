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
  }
}
