import type { GapFeature, GapGeometry, GapProps } from '../types'

/**
 * 复核草稿：把"还没导出的人工修改"落到 localStorage，关掉软件也不丢（2026-11-03）。
 *
 * ## 为什么必须有
 *
 * 复核 1,726 块是这个软件 60% 的人力，而以前所有删除 / 改判 / 补画**只活在内存里**：
 * 复核到一半关窗、断电、WebView 崩溃 —— 全部白干，而且没有任何提示。
 * 缺陷台账 P1-10 从 10-19 起就挂着「复核本身仍未持久化」。
 *
 * ## 存什么（只存差异，不存全量）
 *
 * 全量结果 13.5 MB，超过 WebView 的 localStorage 配额（约 5 MB）。所以只存相对**基线**
 * （载入时那份算法结果）的差异：
 *
 * | 字段 | 内容 | 判据 |
 * |---|---|---|
 * | `deletedIds` | 被删掉的基线块 | 基线有、当前没有 |
 * | `edited` | 改判 / 改边界的基线块 | 对象引用变了（要素不可变，改了必然是新对象） |
 * | `manual` | 人工补画的整块 | `source === 'manual'` |
 *
 * 改判只存 properties（< 1 KB）；**只有边界真被拖过才存几何**。
 *
 * ## 怎么认"同一份基线"
 *
 * `baselineSig` = 块数 + 全部 gap_id 的 FNV-1a 哈希。重跑检测会重编 gap_id → 签名必变，
 * 旧草稿不会被贴到新结果上（那种情况走 `mergeEdits` 的几何重放）。
 */

export const DRAFT_PREFIX = 'fgd.reviewDraft.'
/** 最多保留几份草稿（按保存时间淘汰）—— 多区块各一份，够用且不撑爆配额 */
export const DRAFT_KEEP = 5

export interface EditedEntry {
  id: string
  properties: GapProps
  /** 只有边界被改过才有 */
  geometry?: GapGeometry
}

export interface ReviewDraft {
  v: 1
  sig: string
  savedAt: number
  deletedIds: string[]
  edited: EditedEntry[]
  manual: GapFeature[]
  counters: { manualAdded: number; manualDeleted: number; manualEdited: number }
}

export interface DraftStats {
  deleted: number
  edited: number
  manual: number
  /** 草稿里提到、但基线里已经找不到的块（理论上签名一致时为 0） */
  missing: number
}

/** 基线签名：块数 + gap_id 序列的 FNV-1a。空基线返回 ''（不存草稿） */
export function baselineSig(features: GapFeature[]): string {
  if (features.length === 0) return ''
  let h = 0x811c9dc5
  for (const f of features) {
    const id = f.properties.gap_id
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h ^= 0x2c // 分隔符：避免 "ab"+"c" 与 "a"+"bc" 撞
    h = Math.imul(h, 0x01000193)
  }
  return `${features.length}-${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** 相对基线算出草稿；没有任何修改时返回 null（调用方据此删掉旧草稿） */
export function buildDraft(
  sig: string,
  base: GapFeature[],
  current: GapFeature[],
  counters: ReviewDraft['counters'],
  now = Date.now(),
): ReviewDraft | null {
  if (!sig) return null
  const baseById = new Map(base.map((f) => [f.properties.gap_id, f]))
  const curIds = new Set<string>()
  const edited: EditedEntry[] = []
  const manual: GapFeature[] = []
  for (const f of current) {
    const id = f.properties.gap_id
    curIds.add(id)
    // ⚠️ 只有**基线里没有的**人工块才算"补画"（2026-11-03 复审）：
    //    基线本身就可能带人工块（重新打开导出的交付包当结果文件），那些是基线的一部分，
    //    要走下面的引用比较。否则没改任何东西也会存出草稿，每次启动再贴一份：3 → 4 → 5 块。
    if (f.properties.source === 'manual' && !baseById.has(id)) {
      manual.push(f)
      continue
    }
    const b = baseById.get(id)
    if (!b || b === f) continue
    edited.push(f.geometry === b.geometry ? { id, properties: f.properties } : { id, properties: f.properties, geometry: f.geometry })
  }
  const deletedIds: string[] = []
  for (const id of baseById.keys()) if (!curIds.has(id)) deletedIds.push(id)
  if (deletedIds.length + edited.length + manual.length === 0) return null
  return { v: 1, sig, savedAt: now, deletedIds, edited, manual, counters: { ...counters } }
}

/**
 * 把草稿贴回基线。
 *
 * 返回的 `deleted` 是**基线里的原要素**（带几何）—— 之后重跑检测时 `mergeEdits`
 * 要靠几何把"用户删掉的那块"从新结果里认出来，只给 id 不够。
 */
export function applyDraft(
  base: GapFeature[],
  draft: ReviewDraft,
): { features: GapFeature[]; deleted: GapFeature[]; stats: DraftStats } {
  const del = new Set(draft.deletedIds)
  const patch = new Map(draft.edited.map((e) => [e.id, e]))
  const baseIds = new Set(base.map((f) => f.properties.gap_id))
  let missing = 0
  for (const id of del) if (!baseIds.has(id)) missing++
  for (const id of patch.keys()) if (!baseIds.has(id)) missing++

  // 旧版本存下的草稿可能把基线里的人工块也放进了 manual —— 贴回时以 manual 为准、基线那份跳过，
  // 否则同一个 gap_id 出现两次（选择 / 删除按 id 走，会一次动两块）
  const manualIds = new Set(draft.manual.map((f) => f.properties.gap_id))
  const kept: GapFeature[] = []
  const deleted: GapFeature[] = []
  for (const f of base) {
    const id = f.properties.gap_id
    if (manualIds.has(id)) continue
    if (del.has(id)) {
      deleted.push(f)
      continue
    }
    const e = patch.get(id)
    kept.push(e ? { ...f, properties: e.properties, geometry: e.geometry ?? f.geometry } : f)
  }
  return {
    // 人工补画放最前：与 addGap 的"新增插到最前"一致，清单里一眼能看到
    features: [...draft.manual, ...kept],
    deleted,
    stats: { deleted: deleted.length, edited: draft.edited.length, manual: draft.manual.length, missing },
  }
}

/**
 * 人工新增用到的最大序号（M0007 → 7），恢复 / 载入后续号不能撞。
 * 传草稿或任意要素列表都行 —— 基线自己也可能带 M 编号（重新打开的交付包）。
 */
export function maxManualSeq(src: ReviewDraft | GapFeature[]): number {
  let n = 0
  for (const f of Array.isArray(src) ? src : src.manual) {
    const m = /^M(\d+)$/.exec(f.properties.gap_id)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return n
}

/** 落盘一份状态所需的字段（store 的子集，单测里可以直接手写） */
export interface DraftSource {
  baseSig: string
  baseGaps: GapFeature[]
  gaps: GapFeature[]
  manualAdded: number
  manualDeleted: number
  manualEdited: number
}

/**
 * 把某一时刻的状态落盘：有修改就写、没修改就删、没有基线就跳过。
 * 返回 'failed' 表示写不进去（配额满 / 无存储），调用方提示一次即可。
 */
export function persistDraft(
  s: DraftSource,
  ls: Storage | null = store(),
): 'saved' | 'removed' | 'skipped' | 'failed' {
  if (!s.baseSig) return 'skipped'
  const d = buildDraft(s.baseSig, s.baseGaps, s.gaps, {
    manualAdded: s.manualAdded,
    manualDeleted: s.manualDeleted,
    manualEdited: s.manualEdited,
  })
  if (!d) {
    removeDraft(s.baseSig, ls)
    return 'removed'
  }
  return saveDraft(d, ls) ? 'saved' : 'failed'
}

/**
 * 基线换了，被离开的那份基线的草稿怎么办（纯函数，App 的自动保存照着执行）。
 *
 * - `flush-prev`：换区块 / 重新载入 / 重跑合并 —— 旧基线的文件还在磁盘上、草稿仍然有效，
 *   防抖窗口里最后那几下修改要**按旧基线**立刻落盘；
 * - `remove-prev`：撤销 / 重做跨过了「重跑合并」—— 旧基线要么已被磁盘上的新结果覆盖，
 *   要么就是用户刚撤掉的状态；留着它的草稿，下次启动会把用户亲手撤销的东西恢复回来；
 * - `none`：基线没变，或者之前根本没有基线。
 */
export function baselineSwitchAction(
  s: { baseSig: string; baseSwitchedByHistory: boolean },
  prev: { baseSig: string },
): 'none' | 'flush-prev' | 'remove-prev' {
  if (s.baseSig === prev.baseSig || !prev.baseSig) return 'none'
  return s.baseSwitchedByHistory ? 'remove-prev' : 'flush-prev'
}

// —— 存取（localStorage 可能不存在 / 满了 / 被禁用：一律吞掉，返回结果给调用方决定怎么提示）——

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadDraft(sig: string, ls: Storage | null = store()): ReviewDraft | null {
  if (!sig || !ls) return null
  try {
    const raw = ls.getItem(DRAFT_PREFIX + sig)
    if (!raw) return null
    const d = JSON.parse(raw) as ReviewDraft
    if (d?.v !== 1 || d.sig !== sig || !Array.isArray(d.deletedIds) || !Array.isArray(d.edited) || !Array.isArray(d.manual)) {
      return null
    }
    return d
  } catch {
    return null
  }
}

/** 写入并淘汰旧草稿。返回 false = 没写进去（配额满 / 无存储），调用方应提示一次 */
export function saveDraft(draft: ReviewDraft, ls: Storage | null = store()): boolean {
  if (!ls) return false
  try {
    ls.setItem(DRAFT_PREFIX + draft.sig, JSON.stringify(draft))
  } catch {
    return false
  }
  pruneDrafts(ls)
  return true
}

export function removeDraft(sig: string, ls: Storage | null = store()): void {
  if (!sig || !ls) return
  try {
    ls.removeItem(DRAFT_PREFIX + sig)
  } catch {
    /* 删不掉也无妨：签名对不上就不会被误用 */
  }
}

function pruneDrafts(ls: Storage): void {
  try {
    const all: Array<{ key: string; at: number }> = []
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i)
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue
      let at = 0
      try {
        at = Number((JSON.parse(ls.getItem(key) ?? '{}') as { savedAt?: number }).savedAt) || 0
      } catch {
        /* 坏条目当最旧处理 */
      }
      all.push({ key, at })
    }
    all.sort((a, b) => b.at - a.at)
    for (const x of all.slice(DRAFT_KEEP)) ls.removeItem(x.key)
  } catch {
    /* 淘汰失败不影响本次保存 */
  }
}
