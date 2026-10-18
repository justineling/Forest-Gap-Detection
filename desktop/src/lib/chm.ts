/**
 * CHM（冠层高度模型）高度阈值：三档林龄预设 + 防呆互锁。
 *
 * 背景（缺陷台账 P1-3）：
 *   算法用两个高度阈值判"这是不是树"——
 *     · `core`（救援线）：高度 ≥ 它 → 一定是树，从"空地"里救回来
 *     · `veto`（否决线）：高度 < 它 → 一定不是树
 *   但大疆的 DSM 经过强平滑，树高被系统性低估约 **40%**（真树 8~15 m，
 *   CHM 只读到 5~9 m）。所以 5.2 / 1.2 这两个数**只在成熟园区、5 个真值点上标定过**，
 *   换到幼龄林就会大面积误判。
 *
 * 为什么现在用"预设 + 滑块"而不是自动标定：
 *   自动标定（GMM 双峰直方图）需要标注验证集来判断"改完是变好还是变坏"，
 *   而当前标注样本为 **0**。在没有真值的情况下引入自动阈值，等于把
 *   "可预期的固定参数"换成"不可控的黑盒漂移"，会破坏交付数字的可复现性。
 *   所以：**先给现场一个可调的旋钮，等有真值集再做自适应。**
 */

export type ChmPreset = 'mature' | 'mid' | 'young' | 'custom'

export interface ChmPresetSpec {
  key: Exclude<ChmPreset, 'custom'>
  label: string
  /** 救援线（m）：高度 ≥ 它 → 判为树 */
  core: number
  /** 否决线（m）：高度 < 它 → 判为非树 */
  veto: number
  /** 对应的真实树高区间（已折算 DSM 约 40% 的平滑低估） */
  realHeight: string
  hint: string
}

/** 三档预设。数值已按"大疆 DSM 低估约 40%"折算成 CHM 读数。 */
export const CHM_PRESETS: ChmPresetSpec[] = [
  {
    key: 'mature',
    label: '成熟林',
    core: 5.2,
    veto: 1.2,
    realHeight: '真树高 8~15 m',
    hint: 'Stage 14 基线，对应 702 块 / 309,143 m² 的交付口径',
  },
  {
    key: 'mid',
    label: '中龄林',
    core: 3.5,
    veto: 0.8,
    realHeight: '真树高 5~8 m',
    hint: '约 4~7 年生。救援线降到 3.5 m，避免把中龄树当成空地',
  },
  {
    key: 'young',
    label: '幼龄林',
    core: 2.2,
    veto: 0.5,
    realHeight: '真树高 2.5~4.5 m',
    hint: '约 2~4 年生。⚠️ 幼树与高草高度接近，检测后建议配合复核清单抽查',
  },
]

export const CHM_DEFAULT = { core: 5.2, veto: 1.2 }

/** 互锁约束：0.2 ≤ veto ≤ core − 0.5 */
export const CHM_MIN_VETO = 0.2
export const CHM_MIN_GAP = 0.5
export const CHM_CORE_MIN = 0.5
export const CHM_CORE_MAX = 15
export const CHM_STEP = 0.1

export function presetByKey(key: ChmPreset): ChmPresetSpec | null {
  return CHM_PRESETS.find((p) => p.key === key) ?? null
}

/** 反查：给定 core/veto，落在哪一档（容差 0.05 容忍滑块步长的浮点误差） */
export function matchPreset(core: number, veto: number): ChmPreset {
  for (const p of CHM_PRESETS) {
    if (Math.abs(p.core - core) < 0.05 && Math.abs(p.veto - veto) < 0.05) return p.key
  }
  return 'custom'
}

/** 当前值是否等于 Stage 14 基线（报告里据此决定要不要高亮"非默认"） */
export function isDefaultChm(core: number, veto: number): boolean {
  return Math.abs(core - CHM_DEFAULT.core) < 0.05 && Math.abs(veto - CHM_DEFAULT.veto) < 0.05
}

/**
 * 校验互锁。返回 null 表示合法，否则返回给用户看的中文原因。
 *
 * ⚠️ 为什么必须拦：如果把"否决线"拉得比"救援线"还高（例如 core=3.0 / veto=4.0），
 *    区间逻辑就反了 —— 树高 3.5 m 会同时满足"≥core"和"<veto"，
 *    结果取决于代码里两个 if 的先后顺序，属于**静默不可预期**。
 */
export function chmError(core: number, veto: number): string | null {
  if (!Number.isFinite(core) || !Number.isFinite(veto)) return '阈值必须是数字'
  if (veto < CHM_MIN_VETO) return `否决线不能低于 ${CHM_MIN_VETO} m`
  if (core > CHM_CORE_MAX) return `救援线不能高于 ${CHM_CORE_MAX} m`
  if (core < CHM_CORE_MIN) return `救援线不能低于 ${CHM_CORE_MIN} m`
  if (veto > core - CHM_MIN_GAP) {
    return `否决线必须比救援线低至少 ${CHM_MIN_GAP} m（当前 ${veto.toFixed(1)} vs ${core.toFixed(1)}）`
  }
  return null
}

/**
 * 把一对值夹到合法区间（拖动滑块时用）。
 *
 * 策略：**改动的那一条为准，另一条让步**。
 * 例如把 core 从 5.2 拖到 1.0，veto 1.2 就必须跟着降到 0.5 ——
 * 而不是把 core 弹回 1.7（那样滑块会"粘住"用户，手感很差）。
 */
export function clampChm(
  core: number,
  veto: number,
  changed: 'core' | 'veto',
): { core: number; veto: number } {
  const round1 = (v: number) => Math.round(v * 10) / 10
  let c = round1(Math.min(CHM_CORE_MAX, Math.max(CHM_CORE_MIN, core)))
  let v = round1(Math.max(CHM_MIN_VETO, veto))

  if (changed === 'core') {
    // 以 core 为准：veto 顶多到 core - 0.5
    v = Math.min(v, round1(c - CHM_MIN_GAP))
    v = Math.max(CHM_MIN_VETO, v)
  } else {
    // 以 veto 为准：core 至少要比 veto 高 0.5
    c = Math.max(c, round1(v + CHM_MIN_GAP))
    c = Math.min(CHM_CORE_MAX, c)
  }
  return { core: round1(c), veto: round1(v) }
}
