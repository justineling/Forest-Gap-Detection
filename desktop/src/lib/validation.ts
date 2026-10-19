import type { GapFeature, GapClass } from '../types'
import { CLASS_STYLES } from './classes'

/**
 * 验证集抽样：三层不等概率 + 逆概率权重。
 *
 * ## 为什么要分层，不纯随机
 *
 * 1,726 块里小面积碎斑占大多数。纯随机抽 150 块，绝大部分会落在几十平方米的边角块上，
 * 而真正决定"总面积对不对"的大斑块可能一个都没抽到。
 *
 * 所以按**对业务的影响**分层：
 *
 * | 层 | 抽什么 | 块数 | 为什么 |
 * |---|---|---|---|
 * | L1 | 面积最大的 40 块 open_patch | 40 | 这 40 块覆盖全园近一半需补种面积，**必抽（权重 1.0）** |
 * | L2 | uncertain（证据不足） | 60 | 阈值边界最容易错的地方，专门用来标定判据 |
 * | L3 | 其余可补种 / 林间空隙 / 不可种植 | 25 + 15 + 10 | 算误报率与漏报率基线 |
 *
 * ## 为什么必须带权重
 *
 * 150 块的简单平均**不是**全园准确率的无偏估计 —— 因为每块被抽中的概率不同
 * （L1 是 100%，L2 是 60/465 ≈ 13%）。正确做法是 Horvitz-Thompson：
 *
 *     全园准确率 ≈ Σ(wᵢ · 正确ᵢ) / Σ(wᵢ)，其中 wᵢ = N_h / n_h
 *
 * 少了这一步，标完 150 块只能告诉你"这 150 块对了多少"，不能告诉你"全园对了多少"。
 *
 * ## 为什么固定种子
 *
 * 抽样必须**可复现**：换台机器、重跑一次、或者半年后再看，都应该是同样那 150 块。
 * 否则"上次的分数"和"这次的分数"不可比 —— 而验证集唯一的价值就是可比。
 * 所以用 mulberry32（32 位确定性 PRNG）而不是 Math.random()。
 */

/** 真值（地面真相）的 4 个分类 */
export type GtLabel = 1 | 2 | 3 | 4

export const GT_LABEL_META: Record<GtLabel, { label: string; short: string; hint: string }> = {
  1: { label: '真需补种', short: '补种', hint: '确实是该补的空地（算法判对了或漏了）' },
  2: { label: '无需补种', short: '不补', hint: '林间空隙 / 幼树 / 高草 —— 不该补' },
  3: { label: '不可种植', short: '不可种', hint: '道路 / 水体 / 建筑 / 未开发林' },
  4: { label: '存疑', short: '存疑', hint: '影像模糊或拿不准，评估时单列不计入' },
}

/**
 * 这块能不能用「认同算法」来标？
 *
 * ⚠️ `uncertain` 不能 —— 算法自己都说"证据不足"，用户"认同"等于认同一个没有结论的判定。
 * 那种标法在评估时会被算成"存疑"并剔除，等于白标一块。
 *
 * 实测代价（2026-10-19 首次跑通评估时发现）：L2 层 60 块里 51 块因为按了 Space
 * 被算成存疑 —— 那一层就完全没提供信息，而它恰恰是最该被标定的一层。
 */
export function canConfirm(cls: GapClass): boolean {
  return cls !== 'uncertain'
}

/** 算法类别 → (若算法判对) 对应的真值标签 */
export function classToGt(cls: GapClass): GtLabel {
  switch (CLASS_STYLES[cls]?.group) {
    case 'definite_plant':
      return 1
    case 'not_needed':
      return 2
    case 'unplantable':
      return 3
    default:
      // review（uncertain）：算法自己也没定论，不预设
      return 4
  }
}

export interface GtSample {
  gap_id: string
  /** 分层标识，评估时按层汇总 */
  stratum: StratumKey
  /** 逆概率权重 N_h / n_h。L1 必抽 → 1.0 */
  weight: number
  /** 算法原始判定（评估时作为"预测值"） */
  algo_class: GapClass
  area_sqm: number
  /** 该层总体块数（写进文件供事后核对） */
  stratum_total: number
  /** 该层实际抽了多少 */
  stratum_sampled: number
}

export type StratumKey =
  | 'L1_top_area'
  | 'L2_uncertain'
  | 'L3_plantable'
  | 'L3_alley'
  | 'L3_unplantable'

export const STRATUM_META: Record<StratumKey, { label: string; why: string }> = {
  L1_top_area: {
    label: 'L1 最大连片空地',
    why: '面积最大的 40 块，必抽 —— 它们覆盖全园近一半需补种面积',
  },
  L2_uncertain: {
    label: 'L2 待复核',
    why: '证据不足的块，阈值边界最容易错在这里',
  },
  L3_plantable: {
    label: 'L3 其余可补种',
    why: '算误报率基线（算法说该补，实际可能不用）',
  },
  L3_alley: {
    label: 'L3 林间空隙',
    why: '算漏报率基线（算法说不补，实际可能是真缺株）',
  },
  L3_unplantable: {
    label: 'L3 不可种植',
    why: '道路 / 水体 / 建筑 / 未开发林，验证分类是否串了',
  },
}

/** 抽样配额（合计 150） */
export const SAMPLE_QUOTA: Record<StratumKey, number> = {
  L1_top_area: 40,
  L2_uncertain: 60,
  L3_plantable: 25,
  L3_alley: 15,
  L3_unplantable: 10,
}

/** 默认种子 —— 换它等于换一套题，会让历史分数不可比，**不要随手改** */
export const DEFAULT_SEED = 42

/**
 * mulberry32：32 位确定性 PRNG。
 *
 * 为什么不用 `Math.random()`：抽样必须可复现。跨机器、跨会话、
 * 甚至跨 Node 版本都要给出同一个序列。
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 确定性洗牌（Fisher-Yates + 给定 rng） */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * 生成 150 块验证集。
 *
 * **纯函数**：同 `features` + 同 `seed` → 同结果。
 * 内部先按 `gap_id` 排序再抽样，所以不依赖输入数组的顺序
 * （后端扫目录、合并 blocks 的顺序变了也不影响）。
 */
export function buildValidationSample(
  features: GapFeature[],
  seed: number = DEFAULT_SEED,
): GtSample[] {
  const rng = mulberry32(seed)
  const byId = new Map(features.map((f) => [f.properties.gap_id, f]))

  // 排序键：gap_id 字符串序 —— 与文件顺序无关，保证跨机器一致
  const sorted = features
    .slice()
    .sort((a, b) => (a.properties.gap_id < b.properties.gap_id ? -1 : 1))

  const pick = (pool: GapFeature[], n: number): GapFeature[] => {
    if (pool.length <= n) return pool.slice()
    return shuffle(pool, rng).slice(0, n)
  }

  const mk = (f: GapFeature, stratum: StratumKey, total: number, sampled: number): GtSample => ({
    gap_id: f.properties.gap_id,
    stratum,
    // L1 是"必抽"（n == N），权重恰好 1.0；其余按 N/n
    weight: sampled > 0 ? total / sampled : 1,
    algo_class: f.properties.class,
    area_sqm: f.properties.area_sqm ?? 0,
    stratum_total: total,
    stratum_sampled: sampled,
  })

  const out: GtSample[] = []
  const used = new Set<string>()

  // ---- L1：面积最大的 40 块 open_patch（必抽，权重 1.0）----
  const opens = sorted
    .filter((f) => f.properties.class === 'open_patch')
    .sort((a, b) => (b.properties.area_sqm ?? 0) - (a.properties.area_sqm ?? 0))
  const l1Pool = opens.slice(0, SAMPLE_QUOTA.L1_top_area)
  for (const f of l1Pool) {
    out.push(mk(f, 'L1_top_area', l1Pool.length, l1Pool.length))
    used.add(f.properties.gap_id)
  }

  // ---- L2：uncertain ----
  const l2Pool = sorted.filter((f) => f.properties.class === 'uncertain')
  const l2 = pick(l2Pool, SAMPLE_QUOTA.L2_uncertain)
  for (const f of l2) {
    out.push(mk(f, 'L2_uncertain', l2Pool.length, l2.length))
    used.add(f.properties.gap_id)
  }

  // ---- L3a：其余可补种（排除 L1 已选的）----
  const l3aPool = sorted.filter(
    (f) =>
      (f.properties.class === 'open_patch' || f.properties.class === 'vacant_slot') &&
      !used.has(f.properties.gap_id),
  )
  const l3a = pick(l3aPool, SAMPLE_QUOTA.L3_plantable)
  for (const f of l3a) {
    out.push(mk(f, 'L3_plantable', l3aPool.length, l3a.length))
    used.add(f.properties.gap_id)
  }

  // ---- L3b：林间空隙 ----
  const l3bPool = sorted.filter((f) => f.properties.class === 'alley_gap')
  const l3b = pick(l3bPool, SAMPLE_QUOTA.L3_alley)
  for (const f of l3b) {
    out.push(mk(f, 'L3_alley', l3bPool.length, l3b.length))
    used.add(f.properties.gap_id)
  }

  // ---- L3c：不可种植（4 类合并抽，权重按合并后的池子算）----
  const l3cPool = sorted.filter((f) =>
    ['road', 'water', 'office', 'undeveloped'].includes(f.properties.class),
  )
  const l3c = pick(l3cPool, SAMPLE_QUOTA.L3_unplantable)
  for (const f of l3c) {
    out.push(mk(f, 'L3_unplantable', l3cPool.length, l3c.length))
    used.add(f.properties.gap_id)
  }

  // 兜底：结果里若出现 byId 里没有的 id（理论上不可能），也别抛
  const valid = out.filter((s) => byId.has(s.gap_id))

  // 输出顺序：按面积降序 —— 用户标注时先看大的，收益最高
  return valid.sort((a, b) => b.area_sqm - a.area_sqm)
}

// ---------------------------------------------------------------------------
//  评估
// ---------------------------------------------------------------------------

export interface GtRecord {
  gap_id: string
  /** 真值。null = 未标 */
  gt: GtLabel | null
  /** 用户点了"认同算法"（Space） */
  confirmed: boolean
  updated_at: number
}

export interface ConfusionCell {
  /** 算法判定的真值等价类 */
  pred: GtLabel
  /** 人工真值 */
  actual: GtLabel
  count: number
  /** 加权后（逆概率）*/
  weighted: number
}

export interface EvalResult {
  /** 已标注块数（gt != null 且 != 4）*/
  labeled: number
  /** 总抽样数 */
  total: number
  /** 存疑块数（单列，不计入准确率）*/
  unsure: number
  /** 未标注 */
  pending: number
  /** 样本准确率（未加权） */
  sampleAcc: number
  /** 全园无偏准确率（Horvitz-Thompson 加权） */
  weightedAcc: number
  /** 按面积加权的准确率 */
  areaAcc: number
  /** 混淆矩阵 */
  confusion: ConfusionCell[]
  /** 各层明细 */
  strata: Array<{
    stratum: StratumKey
    sampled: number
    labeled: number
    correct: number
    acc: number
  }>
  /** "确定需补种"口径的精确率 / 召回率（业务最关心） */
  plantable: { precision: number; recall: number; tp: number; fp: number; fn: number }
}

/**
 * 按验证集打分。
 *
 * 三种准确率都要给，因为它们回答不同问题：
 * · **样本准确率** —— "我标的这 150 块里对了多少"（直观，但有偏）
 * · **加权准确率** —— "全园 1,726 块大概对了多少"（Horvitz-Thompson 无偏估计）
 * · **面积准确率** —— "需补种的总面积误差多大"（业务真正付钱的那个数）
 */
export function evaluate(
  samples: GtSample[],
  records: Record<string, GtRecord>,
): EvalResult {
  const confusion = new Map<string, ConfusionCell>()
  const strata = new Map<
    StratumKey,
    { sampled: number; labeled: number; correct: number }
  >()

  let labeled = 0
  let unsure = 0
  let correct = 0
  let wSum = 0
  let wCorrect = 0
  let aSum = 0
  let aCorrect = 0

  // 需补种口径（只看非存疑样本）
  let tp = 0
  let fp = 0
  let fn = 0

  for (const s of samples) {
    const rec = records[s.gap_id]
    const st = strata.get(s.stratum) ?? { sampled: 0, labeled: 0, correct: 0 }
    st.sampled += 1
    strata.set(s.stratum, st)

    // 用户点过"认同算法"→ 真值就是算法判定的等价类
    const gt: GtLabel | null = rec?.gt ?? (rec?.confirmed ? classToGt(s.algo_class) : null)
    if (gt == null) continue
    if (gt === 4) {
      unsure += 1
      continue
    }

    labeled += 1
    st.labeled += 1

    const pred = classToGt(s.algo_class)
    const isCorrect = pred === gt
    if (isCorrect) {
      correct += 1
      st.correct += 1
    }

    // 加权
    wSum += s.weight
    if (isCorrect) wCorrect += s.weight
    // 面积加权
    aSum += s.area_sqm
    if (isCorrect) aCorrect += s.area_sqm

    const key = `${pred}>${gt}`
    const cell = confusion.get(key) ?? { pred, actual: gt, count: 0, weighted: 0 }
    cell.count += 1
    cell.weighted += s.weight
    confusion.set(key, cell)

    // 需补种口径（gt=1 是正类）
    if (gt === 1 && pred === 1) tp += 1
    else if (gt !== 1 && pred === 1) fp += 1
    else if (gt === 1 && pred !== 1) fn += 1
  }

  return {
    labeled,
    total: samples.length,
    unsure,
    pending: samples.length - labeled - unsure,
    sampleAcc: labeled > 0 ? correct / labeled : 0,
    weightedAcc: wSum > 0 ? wCorrect / wSum : 0,
    areaAcc: aSum > 0 ? aCorrect / aSum : 0,
    confusion: [...confusion.values()].sort(
      (a, b) => a.pred - b.pred || a.actual - b.actual,
    ),
    strata: [...strata.entries()]
      .map(([stratum, v]) => ({
        stratum,
        ...v,
        acc: v.labeled > 0 ? v.correct / v.labeled : 0,
      }))
      .sort((a, b) => a.stratum.localeCompare(b.stratum)),
    plantable: {
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
      recall: tp + fn > 0 ? tp / (tp + fn) : 0,
      tp,
      fp,
      fn,
    },
  }
}

/**
 * 挑"下一个要标的块"。
 *
 * 规则：**当前之后**的第一个未标项（含存疑），到末尾就回到开头 —— 环形。
 * 为什么环形：用户可能从中间开始标，前面的也得能回去补。
 * 全部标完返回 null（调用方据此显示"完成了"）。
 */
export function nextUnlabeled(
  samples: GtSample[],
  records: Record<string, GtRecord>,
  currentId: string | null,
): GtSample | null {
  const isDone = (s: GtSample) => {
    const r = records[s.gap_id]
    return !!r && (r.gt != null || r.confirmed)
  }
  const n = samples.length
  if (n === 0) return null
  const start = currentId ? samples.findIndex((s) => s.gap_id === currentId) : -1
  for (let k = 1; k <= n; k++) {
    const idx = (start + k + n) % n
    if (!isDone(samples[idx])) return samples[idx]
  }
  return null
}

/** 已标数（含存疑与"认同算法"） */
export function labeledCount(
  samples: GtSample[],
  records: Record<string, GtRecord>,
): number {
  let n = 0
  for (const s of samples) {
    const r = records[s.gap_id]
    if (r && (r.gt != null || r.confirmed)) n += 1
  }
  return n
}
