/**
 * 「这张影像有没有加速结构（金字塔）」相关的纯函数。
 *
 * 为什么单独一个模块：这些判断（横幅要不要出现、按钮能不能点、磁盘怎么写、
 * 要等多久、按钮叫什么）**每一条都有踩错的方式**，而它们全是"给个输入出个字符串"
 * 的无副作用逻辑，抽出来就能被 npm test 钉住。
 *
 * 背景数字（实测，别凭感觉改）：
 * - 没有加速结构时，z=13 的一张瓦片要 **104 秒**；建好后 **0.7 秒**（149×）
 * - 3.5 GB 的影像建一次约 **174 秒**（≈ 2 分 54 秒），所以文案说"2~3 分钟"
 */

/** `tile_server.py::overview_plan()` 的返回（字段名与 python 逐字一致） */
export interface OverviewPlan {
  /** none=本来就有；ovr=生成外置文件；copy=复制副本；inplace=改原图；error=环境不支持 */
  action: 'none' | 'ovr' | 'copy' | 'inplace' | 'error'
  /** 给用户看的一句话（python 侧已经写成中文，可直接展示） */
  why: string
  has_overviews: boolean
  /** 加速结构来自哪里：内部金字塔 / 外置 .ovr / 无 */
  kind?: 'internal' | 'external' | 'none'
  /** kind=external 时是 .ovr 的绝对路径 */
  ovr_path?: string | null
  /** 金字塔层级（如 [2, 4, 8, 16, 32, 64]）；无金字塔时为空数组 */
  levels?: number[]
  size_bytes: number
  need_bytes: number
  free_bytes: number
  enough_space: boolean
  /** 额外文件落在哪个目录 */
  target_dir: string
  /** 有 gdaladdo 就能只占 1/3 磁盘；没有则 null */
  gdaladdo: string | null
  /** 会不会改动原图（只有 inplace 是 true） */
  touches_source: boolean
}

/**
 * 横幅是否该出现。
 *
 * 三个必须同时成立：**确实没有**加速结构、用户没点过「以后再说」、而且已经读到了
 * 影像元数据（`hasOverviews === undefined` 表示 `/meta` 还没回来）。
 *
 * ⚠️ `undefined` 必须当成"不显示"：刚启动时 meta 是空的，若此时按 false 处理，
 * 横幅会**闪一下**再消失 —— 用户会以为自己错过了什么提示。
 */
export function shouldShowOverviewNotice(
  hasOverviews: boolean | undefined | null,
  dismissed: boolean,
): boolean {
  if (dismissed) return false
  return hasOverviews === false
}

/**
 * 能不能点「开始」。
 *
 * 四种情况都不让点：
 * - `plan` 还是 null（体检没回来，此时点下去不知道会发生什么）
 * - `action === 'none'`（本来就有，没什么可建）
 * - `action === 'error'`（环境不支持，比如缺 gdaladdo 又要求必须用它）
 * - 磁盘不够（点下去也会失败，不如当场拦住）
 */
export function canStartBuild(plan: OverviewPlan | null): boolean {
  if (!plan) return false
  if (plan.action === 'none' || plan.action === 'error') return false
  return plan.enough_space
}

/** 把字节数写成人类能读的量级（1 位小数，够用了） */
function gb(bytes: number): string {
  const v = bytes / 1024 ** 3
  // 小于 1 GB 时用 MB，避免出现 "需要 0.0 GB" 这种把 300 MB 说成零的话
  if (v < 1) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
  return `${v.toFixed(1)} GB`
}

/**
 * 磁盘说明，例如「需要 7.0 GB，可用 171 GB」。
 *
 * `need_bytes === 0`（本来就有加速结构）时**不能**输出"需要 0 GB" ——
 * 那是一句废话，还会让人以为哪里算错了。这种情形只说"不需要额外空间"。
 */
export function describeSpace(plan: OverviewPlan): string {
  if (plan.need_bytes <= 0) return '不需要额外磁盘空间'
  const need = gb(plan.need_bytes)
  const free = gb(plan.free_bytes)
  if (plan.enough_space) return `需要 ${need}，可用 ${free}`
  return `需要 ${need}，可用只有 ${free} —— 空间不够`
}

/**
 * 预计耗时（秒）。按体积线性粗估，**不是精确值**。
 *
 * 依据：3.5 GB 的影像实测 174 秒 → 约 50 秒/GB。系数取 50，
 * 下限 20 秒（小图也要打开文件、建索引），上限 600 秒（再久就该让用户
 * 看到"可能比预期慢"，而不是一个离谱的数字）。
 */
export function estimateBuildSeconds(sizeBytes: number): number {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 20
  const perGb = 50
  const raw = (sizeBytes / 1024 ** 3) * perGb
  return Math.min(600, Math.max(20, Math.round(raw)))
}

/**
 * 把「技术动作」翻译成人话（按钮 / 确认框第一行）。
 *
 * ⚠️ 这里**禁止**出现 gdaladdo / ovr / copy / inplace 这些词：
 * 用户不需要知道用的是哪种实现，他只需要知道"动不动我的原图、要多久、要多少盘"。
 * （`desktop/tests/overview.test.ts` 里有断言盯着这一点。）
 *
 * `error` 分支同样不能直接透 `plan.why` —— 那是后端原文，里面就带着
 * `gdaladdo` / `外置 .ovr`。交给 `explainBuildError` 翻译。
 */
export function describeAction(plan: OverviewPlan): string {
  switch (plan.action) {
    case 'none':
      return '这张影像已经有加速结构，不需要处理'
    case 'ovr':
      return '生成加速文件（不动原图，约 2~3 分钟）'
    case 'copy':
      return `复制一份并加速（不动原图，需要约 ${gb(plan.need_bytes)} 磁盘）`
    case 'inplace':
      // 这里刻意不写 Markdown 的 `**加粗**`：这是纯文本返回值，渲染出来会是字面星号。
      // 强调交给组件（整行用警告色 + 单独的红色提示）
      return '直接改原图（更快，但不可撤销）'
    case 'error':
      return explainBuildError(plan.why).title
  }
}

/** 给界面用的一句话耗时预告（`estimateBuildSeconds` 的展示形态） */
export function describeEstimate(seconds: number): string {
  if (seconds < 60) return `约 ${seconds} 秒`
  const m = Math.round(seconds / 60)
  return `约 ${m} 分钟`
}

export interface ErrorAdvice {
  /** 给用户看的一句话原因（不含任何技术名词） */
  title: string
  /** 下一步能做什么 */
  hint: string
}

/**
 * 失败态预览用的「后端原文」样例（`?ovr=fail`）。
 *
 * 它**故意**保留技术词：真实的失败界面里，这段原文就长这样，且要原样显示在
 * `<pre>` 里供用户复制反馈。把它放在这里（而不是组件里）是为了让
 * `OverviewNotice.tsx` 的代码里一个技术词都不出现 —— 测试会扫那个文件。
 */
export const DEMO_FAIL_RAW = '建立加速结构失败：找不到 gdaladdo，无法生成外置 .ovr'

/**
 * 把后端的原始报错翻译成用户能懂的一句话。
 *
 * 为什么要翻译而不是直接显示原文：原文里是 `gdaladdo` / `外置 .ovr` 这类
 * 只有开发者看得懂的词，而用户（种植园管理者）既看不懂、也没有能力"去装 GDAL"——
 * 那种提示除了让产品显得很技术，没有任何作用。
 *
 * 但**原文不能丢**：用户要拿它去反馈问题。所以组件里仍然用 `<pre>` 保留原文，
 * 只是不再让它当主文案。
 *
 * 规则按关键词从上到下**第一个命中**（顺序有意义：磁盘报错里也可能提到 gdaladdo）。
 */
export function explainBuildError(raw: string): ErrorAdvice {
  const t = (raw ?? '').toLowerCase()

  if (t.includes('gdaladdo') || t.includes('外置 .ovr') || t.includes('.ovr')) {
    return {
      title: '这台电脑缺少一个可选的加速组件',
      hint: '可以先关掉这个提示。检测和导出都不受影响，只是地图缩放到很远处会慢一些。',
    }
  }
  if (t.includes('磁盘') || t.includes('space') || t.includes('no space')) {
    return {
      title: '磁盘剩余空间不够',
      hint: '腾出空间，或者把影像放到另一块盘上，然后再试一次。',
    }
  }
  if (t.includes('权限') || t.includes('denied') || t.includes('permission')) {
    return {
      title: '没有写入这个位置的权限',
      hint: '换一个你有权限的目录，或者用管理员身份运行。',
    }
  }
  if (t.includes('中断') || t.includes('interrupt')) {
    return {
      title: '处理被中断了',
      hint: '重新点一次「开始」即可。原图没有被改动。',
    }
  }
  return {
    title: '没能建立加速结构',
    hint: '可以先关掉这个提示，不影响检测和导出。',
  }
}

/**
 * 预览用的假体检结果（`?ovr=dialog`）。
 *
 * 为什么需要：确认框里的每一行（磁盘够不够、动不动原图、有没有 GDAL）都取决于
 * 后端返回值，而**浏览器里点不到按钮**（headless 截图没法交互）。
 * 没有它就只能靠人工开桌面端点一遍 —— 那正是本项目出过"截图绿了但界面是死的"的原因。
 *
 * ⚠️ 只在浏览器预览时用；桌面端一律走后端 `overview_plan`。
 */
export const DEMO_PLAN: OverviewPlan = {
  action: 'copy',
  why: '无 gdaladdo，复制副本（源文件不动，约占原图 100%）',
  has_overviews: false,
  size_bytes: 3.5 * 1024 ** 3,
  need_bytes: 1.5 * 3.5 * 1024 ** 3,
  free_bytes: 171 * 1024 ** 3,
  enough_space: true,
  target_dir: 'D:/fgd/data/output/.tile-cache',
  gdaladdo: null,
  touches_source: false,
}
