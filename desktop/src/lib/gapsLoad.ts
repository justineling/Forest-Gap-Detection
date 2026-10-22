/**
 * 「这次 `/gaps` 的响应能不能写进界面」的判定（纯函数，可被 npm test 覆盖）。
 *
 * 为什么要把这件事单独抽出来：`loadGaps({ rerun: true })` 在检测完成后被调用，
 * 走的是 `applyRerun(feats, 'keep_manual')`。而 `mergeManualEdits` 的实现是
 * **以新结果为主体**、只把人工新增/改判/删除重放上去 —— 所以 `applyRerun([])`
 * 会把当前 1,762 块算法要素全部丢掉，只留下人工新增的那几个，还会在日志里写
 * 一句"算法要素 0 · 合计 N"，看起来像一次正常的合并。
 *
 * 实测的失败链就是这样：检测成功 → `/gaps` 因为路径/写盘时序返回空 →
 * 界面从"1,762 块"变成"0 块"，用户以为检测把结果搞没了。
 * **数据丢失比"读不到"糟糕得多**，所以空响应默认一律保留现有结果。
 *
 * 空响应有三种成因，只有第三种该真的清空界面：
 *
 * | 成因 | 特征 | 处置 |
 * |---|---|---|
 * | 文件没找到 / 服务指向旧路径 | 响应带 `error` | 保留 + 报错 |
 * | 正在写盘 / 文件损坏 | 空且无 `error` | 保留 + 报错（提示稍后重试） |
 * | 算法真的没找到空地 | sidecar 的 `result` 事件自报 `total_gap_count = 0` | 照实清空 |
 *
 * 判不出来就按"保留"处理 —— 误报一次"读不到"可以重试，误清一次数据找不回来。
 */

/** 判定所需的输入（全部来自已发生的事实，不做任何 IO） */
export interface GapsLoadInput {
  /** 这次 `/gaps` 给回多少个要素 */
  incoming: number
  /** 界面当前有多少要素（= 会被覆盖的现有结果） */
  existing: number
  /**
   * sidecar 的 `result` 事件自报的空地块数（`summary.total_gap_count`）。
   * 没有这个事件时传 `null` —— 不要传 0，那等于"算法说没找到"，语义完全不同。
   */
  reported: number | null
  /** 后端给的错误说明（读不到结果文件时才有） */
  error?: string
}

export type GapsLoadDecision =
  | {
      action: 'apply'
      /** normal=有数据就换；empty_state=首次打开且本来就空，setGaps([]) 无害 */
      reason: 'normal' | 'empty_state' | 'confirmed_empty'
    }
  | {
      action: 'keep'
      /** missing_file=后端明说读不到；suspect_empty=空得不明不白 */
      reason: 'missing_file' | 'suspect_empty'
      /** 给用户看的具体原因（error 原文，或一句兜底说明） */
      detail: string
    }

/** 兜底说明：空响应既没 error、又拿不到算法自报的块数时的措辞 */
export const SUSPECT_EMPTY_DETAIL = '结果文件是空的（可能还在写盘，或文件已损坏）'

/**
 * 决定这次响应是否写进界面。
 *
 * 规则（顺序即优先级）：
 * 1. 有要素 → 照常应用（哪怕同时带了 error，有数据就用数据）。
 * 2. 空响应 + 现有结果非空：
 *    - 算法自报 0 块 → 应用（真的没有空地，界面就该是 0）
 *    - 否则 → **保留**现有结果（missing_file / suspect_empty）
 * 3. 空响应 + 现有结果也为空：
 *    - **一律应用**（首次打开 / 换影像后本来就空）。
 *      带 error 也不弹窗 —— 那通常是“没找到结果文件”，属正常状态；
 *      后端日志里仍有完整记录（2026-10-22 修：曾误报“结果没读到”）。
 */
export function decideGapsLoad(input: GapsLoadInput): GapsLoadDecision {
  const { incoming, existing, reported, error } = input
  const detail = error && error.length > 0 ? error : SUSPECT_EMPTY_DETAIL

  if (incoming > 0) return { action: 'apply', reason: 'normal' }

  if (existing > 0) {
    // 算法自己说"一块都没找到" → 空结果是真的，允许清空
    if (reported === 0) return { action: 'apply', reason: 'confirmed_empty' }
    return {
      action: 'keep',
      reason: error ? 'missing_file' : 'suspect_empty',
      detail,
    }
  }

  // existing === 0：界面本来就没有结果可保护。此时 error 几乎总是
  // “未找到检测结果文件（已查找：…）”，而那对一张**还没跑过检测的影像**
  // 是完全正常的状态，不是故障。
  // 旧逻辑在这里走 keep + detail → 界面弹“结果没读到”，用户以为数据丢了
  //（2026-10-22 公司电脑实测：新包 + settings.gaps=null 仍弹窗）。
  // 此时 setGaps([]) 无副作用，直接走空状态；后端日志里仍有完整记录。
  return { action: 'apply', reason: 'empty_state' }
}

/**
 * 换影像后是否必须清空 store 里的旧结果。
 *
 * `setGaps([])` 会把 `workflow.loaded` 置 false，步骤判定才会回到「运行检测」；
 * 不清的话界面会直接跳到「复核结果」并弹"结果没读到"（2026-10-21 实测）。
 *
 * 两个参数的语义都是"已经发生的事实"，所以能纯函数化：
 * - `next` 为空 → 不是换影像（清空会让"重选同一张"也丢结果），返回 false；
 * - `prev` 为 undefined → 首次选择影像，旧结果可能是上一次会话残留的，要清。
 */
export function shouldClearGapsOnImageChange(
  next: string | null | undefined,
  prev: string | null | undefined,
): boolean {
  return !!next && next !== prev
}
