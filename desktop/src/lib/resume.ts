/**
 * 「启动时要不要问一句『继续上次结果，还是重新开始』」的判定（纯函数）。
 *
 * ## 为什么需要这个文件
 *
 * 桌面端启动时会自动把磁盘上最近一次的结果读进界面（`probeAndLoad` → `loadGaps`），
 * 而 `workflow.isStepDone('detect')` 把「磁盘上已有结果」也算成第 3 步已完成 ——
 * 于是界面**直接跳到第 4 步「复核结果」**。
 *
 * 这个设计的初衷没错（打开软件就接着上次的活干，不必重跑 6 分钟），但它把
 * **选择权**从用户手里拿走了：用户可能只想重新跑一遍，也可能只是想看看新影像。
 * 用户的原话是「应该有 1 个弹窗来让用户决定吧」。
 *
 * ## 为什么不直接写在 App.tsx 里
 *
 * 「什么时候该问」是**四条布尔规则**，最容易写错的地方不是 UI 而是判断条件：
 * 判宽了 → 检测跑完自动刷新时又弹一次（用户以为出了故障）；
 * 判窄了 → 永远不弹（用户的问题没解决，而且很难复现）。
 * 抽成纯函数才能被 `npm test` 逐条覆盖。
 *
 * ## 文案原则
 *
 * `describeResume` 的输出会**原样显示给用户**，所以：
 *   · 块数用千分位（`1,726 块`），跟界面其它地方一致；
 *   · 时间只给 `MM-DD HH:mm`，不给秒、不给时区、不给 ISO 串；
 *   · **不许出现技术词**（`geojson` / `gaps` / `job` / `mtime` 之类）——
 *     用户不知道也不该知道结果存在什么格式的文件里。
 */

/**
 * 判定所需的输入。
 *
 * 三项都是"已经发生的事实"，函数内部不做任何 IO、不读 store、不看时间，
 * 所以可以在 Node 里直接测。
 */
export interface ResumeContext {
  /** 这是本次启动的第一次加载结果（不是检测完成后的自动刷新） */
  firstLoad: boolean
  /** 本次会话是否已经跑过检测（跑过就不再问） */
  detectedThisSession: boolean
  /** 读到的结果块数 */
  gapCount: number
}

/**
 * 启动时是否该问「继续上次结果还是重新开始」。
 *
 * 规则（顺序即优先级）：
 * 1. 不是首次加载 → 不问。
 *    检测完成后的自动刷新（`loadGaps({ rerun: true })`）、换影像后重载、
 *    点「重新载入结果」都不该弹窗 —— 那不是"启动"，用户刚刚才做完一件事。
 * 2. 本次会话已经跑过检测 → 不问。
 *    刚跑完的结果就是用户自己要的，"要不要继续上次的结果"是个假问题。
 * 3. 一块结果都没读到 → 不问。
 *    没有历史结果就没什么可选的；弹一个只有「重新开始」的窗等于拦路。
 * 4. 其余 → 问。
 */
export function shouldAskResume(c: ResumeContext): boolean {
  if (!c.firstLoad) return false
  if (c.detectedThisSession) return false
  // `Number.isFinite` 兜住 NaN / undefined 这类脏输入：`NaN <= 0` 是 false，
  // 只写 `gapCount <= 0` 会让 NaN 一路穿过去弹出空窗（"0 块"的弹窗毫无意义）。
  if (!Number.isFinite(c.gapCount) || c.gapCount <= 0) return false
  return true
}

/**
 * 给弹窗用的一句话摘要，例如「1,726 块 · 结果生成于 10-21 14:23」。
 *
 * @param gapCount 读到的结果块数
 * @param generatedAt 结果生成时间（ISO 串或任何 `Date` 能解析的字符串）。
 *   后端目前没有这个字段，所以真实流程里传 `null` —— 此时只显示块数，
 *   **不要**为了一个时间戳去改 Python。
 */
export function describeResume(gapCount: number, generatedAt: string | null): string {
  // 显式指定 'en-US'：千分位分隔符不随系统区域设置变化，
  // 否则某些区域会输出 `1 726` / `1.726`，与界面其它地方对不上。
  const n = Number.isFinite(gapCount) && gapCount > 0 ? Math.round(gapCount) : 0
  const head = `${n.toLocaleString('en-US')} 块`
  const when = formatGeneratedAt(generatedAt)
  return when ? `${head} · 结果生成于 ${when}` : head
}

/**
 * 把时间串格式化成 `MM-DD HH:mm`；解析不出来返回 `null`。
 *
 * 刻意**不抛错**：时间只用于"让摘要更可信"，拿不到就不显示，
 * 不能因为一个可选字段让整个弹窗渲染失败。
 */
export function formatGeneratedAt(generatedAt: string | null): string | null {
  if (typeof generatedAt !== 'string' || generatedAt.trim() === '') return null
  const d = new Date(generatedAt)
  const t = d.getTime()
  if (!Number.isFinite(t)) return null
  const pad = (v: number): string => String(v).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 从后端响应里挑出"结果生成时间"。
 *
 * 现在 `/gaps` 没有这个字段，所以**真实流程会返回 `null`**（弹窗只显示块数）。
 * 之所以还是留一个通用挑法而不是写死 `null`：将来后端加上时间戳时，
 * 前端不用改一行代码就能显示出来 —— 而这件事**绝不能靠改 Python 来达成**
 *（改后端意味着新包与旧服务不再兼容，为一个可选字段不值）。
 *
 * 只接受字符串，且只认几个明确的名字：宁可显示不出时间，也不要猜错字段。
 */
export function pickGeneratedAt(src: unknown): string | null {
  if (!src || typeof src !== 'object') return null
  const o = src as Record<string, unknown>
  for (const key of ['generated_at', 'generatedAt', 'created_at', 'createdAt']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}
