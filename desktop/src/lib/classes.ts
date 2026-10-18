import type { GapClass, PriorityGroup } from '../types'

export interface ClassStyle {
  /** 中文标签（与 Python 侧 CLASS_LABEL_CN 一致） */
  label: string
  /** 地图填充色 */
  color: string
  /** 所属业务分组 */
  group: PriorityGroup
  /** 是否默认在地图上显示 */
  defaultVisible: boolean
}

/**
 * 8 类 + 人工新增。颜色与 `scripts/export_arcgis.py` 的分层配色保持一致，
 * 这样前端预览和 ArcGIS 交付包里的颜色对得上，复核时不会错乱。
 */
export const CLASS_STYLES: Record<GapClass, ClassStyle> = {
  vacant_slot: { label: '株位空缺', color: '#e74c3c', group: 'definite_plant', defaultVisible: true },
  open_patch: { label: '连片空地', color: '#e67e22', group: 'definite_plant', defaultVisible: true },
  alley_gap: { label: '林间空隙', color: '#f1c40f', group: 'not_needed', defaultVisible: false },
  uncertain: { label: '不确定', color: '#95a5a6', group: 'review', defaultVisible: false },
  road: { label: '道路', color: '#8a8a8a', group: 'unplantable', defaultVisible: false },
  water: { label: '水体', color: '#4a90d9', group: 'unplantable', defaultVisible: false },
  office: { label: '办公生活区', color: '#c9a06a', group: 'unplantable', defaultVisible: false },
  undeveloped: { label: '非种植区', color: '#9b59b6', group: 'unplantable', defaultVisible: false },
  manual_add: { label: '人工新增', color: '#00b894', group: 'definite_plant', defaultVisible: true },
}

export const ALL_CLASSES = Object.keys(CLASS_STYLES) as GapClass[]

/** 业务分组的中文名与说明（对应 Python 侧 PRIORITY_LABEL_CN） */
export const GROUP_META: Record<PriorityGroup, { label: string; hint: string }> = {
  definite_plant: {
    label: '确定需补种',
    hint: '连片空地 + 株位空缺 —— 这是可以直接拿去算苗木量的口径',
  },
  review: { label: '待复核', hint: '证据不足，需人工核实' },
  not_needed: { label: '不计入', hint: '林间空隙＝正常行间缝隙，业务上无需补种' },
  unplantable: { label: '不可种植', hint: '道路 / 水体 / 办公 / 未开发林，均已按像素扣除' },
}

/** 分组展示顺序 */
export const GROUP_ORDER: PriorityGroup[] = ['definite_plant', 'review', 'not_needed', 'unplantable']

export function labelOf(cls: GapClass): string {
  return CLASS_STYLES[cls]?.label ?? cls
}

export function colorOf(cls: GapClass): string {
  return CLASS_STYLES[cls]?.color ?? '#888888'
}

/**
 * 生成 MapLibre 的 `match` 表达式：按 `class` 字段上色。
 *
 * ⚠️ 返回 `unknown[]` 是有意的：MapLibre 的表达式类型是「变长元组」，
 * TS 无法从 `flatMap` 展开推断出形状。调用处做一次 `as never` 断言
 * （`never` 可赋给任意类型），把类型噪音收敛在这一处，而不是散落在组件里。
 */
export function classColorExpr(): unknown[] {
  const expr: unknown[] = ['match', ['get', 'class']]
  for (const c of ALL_CLASSES) expr.push(c, CLASS_STYLES[c].color)
  expr.push('#888888')
  return expr
}
