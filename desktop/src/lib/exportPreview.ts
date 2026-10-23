/**
 * 「这次点导出会得到什么」的预览（纯函数，可被 npm test 覆盖）。
 *
 * ## 为什么要单独抽出来
 *
 * 导出对话框以前只在**导出完成之后**才列出文件名。用户在点「开始导出」之前
 * 完全不知道会得到几个文件、放在哪、有没有他要的那份 —— 于是反复点了又点，
 * 每次都要等几十秒（1,762 块要素的 Shapefile 不是瞬间出来的）。
 *
 * ## 数字从哪来（可核对，别凭文档写死）
 *
 * 权威实现在 `scripts/tile_server.py` 的 `export_bundle()`，它逐个产出：
 *
 * | # | 文件 | 数量 | 随数据变化 |
 * |---|---|---|---|
 * | 1 | `gaps-all-wgs84.geojson` | 1 | 否 |
 * | 2 | `gaps-all-utm49n.geojson` | 1 | 否 |
 * | 3 | `gaps-all-wgs84-shp.zip` | 1 | 否 |
 * | 4 | `gaps-all-utm49n-shp.zip` | 1 | 否 |
 * | 5 | `gaps-all.kml` | 1 | 否 |
 * | 6 | `by-class/gaps-<类别>-utm49n-shp.zip` | **每个类别一个** | **是** |
 * | 7 | `planting-points-*`（2 GeoJSON + 2 Shapefile + 1 KML + 1 CSV） | 6 或 0 | 取决于有没有种植网格 |
 * | 8 | `gaps-edited.csv` | 1 | 否 |
 * | 9 | `补种勘察一页报告.html` | 1 | 否 |
 *
 * 第 6 项的数量直接等于"结果里出现过几个类别" —— `export_bundle` 里就是
 * `buckets.setdefault(props["cls"], [])`，而 `props_row()` 把 `cls` 取成
 * `properties["class"]`（1:1，不做归并）。所以前端用
 * `new Set(gaps.map(f => f.properties.class)).size` 算出来的数**就是**文件数，
 * 不是估算。**但它随数据变化，所以界面上要按规则描述、不能写死 1726 / 21 这类数字。**
 *
 * 第 7 项的条件是 `grid.get("plant_pitch_m")` 为真 —— 缺种植网格时
 * `export_bundle` 会跳过整组并往 `notes` 里写一句说明。
 *
 * ## 为什么不报"放样点位数"
 *
 * 点位由 Python 侧 `planting_points.generate_planting_points()` 逐格排坑算出来，
 * 前端没有等价实现（前端只有 `anchor_lon/lat`，缺 `origin_x_m/origin_y_m`，
 * 自己算会整体平移）。**算不准的数字比不写更糟** —— 用户会拿它去报苗木量。
 * 所以这里只描述"会生成"，不给数量。
 */

/** 导出包里的一个分组 = 界面上的一行 */
export interface ExportPlanGroup {
  /** 稳定 key（React 列表用，也方便测试断言） */
  key: string
  /** 这一组是什么（人类可读，禁技术术语） */
  label: string
  /** 这一组会产出几个文件 */
  files: number
  /**
   * 文件数是否**随数据变化**。
   * `true` 时界面必须把"为什么是这个数"一起说出来，否则用户会以为写死了。
   */
  variable: boolean
  /** 一句话补充（文件名 / 条件） */
  detail: string
}

export interface ExportPlanInput {
  /** 当前界面上的结果块数（store 的 `gaps.length`） */
  gapCount: number
  /** 当前结果里出现过的类别数（决定"按类别分包"的文件数） */
  classCount: number
  /** 有没有种植网格（`plantingGrid?.plant_pitch_m` 存在）—— 决定放样点位那 6 个文件 */
  hasGrid: boolean
}

export interface ExportPlan {
  groups: ExportPlanGroup[]
  /** 预计文件总数 */
  totalFiles: number
  /**
   * 会被跳过的分组（目前只有"放样点位"会因为缺种植网格而整组不生成）。
   * 界面据此给一句提醒，而不是让用户导完才发现少了一半。
   */
  skipped: string[]
}

/** 归一化一个计数：非数字 / 负数 / NaN 一律当 0 */
function count(v: number): number {
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 算出"这次导出会得到什么"。
 *
 * 规则（顺序即界面上的显示顺序：先给通用交付物，再给按数据变化的分包）：
 * 1. 双坐标系 GeoJSON —— 固定 2 个（WGS84 + UTM49N）
 * 2. Shapefile 组 —— 固定 2 个（同上两套坐标）
 * 3. KML —— 固定 1 个
 * 4. 按类别分包 —— 每个类别 1 个（**随数据变化**）
 * 5. 补种放样点位 —— 有种植网格时 6 个，否则 0 个并记进 `skipped`
 * 6. 表格 —— 固定 1 个（`gaps-edited.csv`）
 * 7. 一页汇总报告 —— 固定 1 个
 *
 * ⚠️ 这些数字全部来自 `scripts/tile_server.py::export_bundle()` 的实际产出，
 *    改那边的产出清单时**必须同步改这里**（否则预览会骗人）。
 */
export function describeExportPlan(input: ExportPlanInput): ExportPlan {
  const gapCount = count(input.gapCount)
  const classCount = count(input.classCount)
  const hasGrid = !!input.hasGrid

  const groups: ExportPlanGroup[] = [
    {
      key: 'geojson',
      label: '双坐标系地图文件',
      files: 2,
      variable: false,
      detail: '一份给 WGS84、一份给 UTM49N（现场放样用后者，单位是米）',
    },
    {
      key: 'shapefile',
      label: 'Shapefile 压缩包',
      files: 2,
      variable: false,
      detail: 'ArcGIS 直接拖进去就能开，同样两套坐标各一个',
    },
    {
      key: 'kml',
      label: 'KML',
      files: 1,
      variable: false,
      detail: 'Google Earth / 奥维地图里能直接看',
    },
    {
      key: 'by-class',
      label: '按类别分包',
      files: classCount,
      // ★ 这一组随数据变化 —— 界面必须说明"为什么是这么多"
      variable: true,
      detail:
        classCount > 0
          ? `每个类别单独一个压缩包（当前结果里有 ${classCount} 个类别）`
          : '当前结果里没有类别，这一组不会生成',
    },
    {
      key: 'points',
      label: '补种放样点位',
      files: hasGrid ? 6 : 0,
      variable: false,
      detail: hasGrid
        ? '点位表 + 地图文件，现场照着栽（数量取决于空地面积与种植规格）'
        : '结果里没有种植规格，这一组会跳过',
    },
    {
      key: 'csv',
      label: '表格',
      files: 1,
      variable: false,
      detail: '每块空地一行（编号 / 类别 / 面积 / 经纬度 / 是否人工改过），Excel 可开',
    },
    {
      key: 'report',
      label: '一页汇总报告',
      files: 1,
      variable: false,
      detail: '双击用浏览器打开，可直接打印给主管',
    },
  ]

  const skipped: string[] = []
  if (!hasGrid) skipped.push('补种放样点位（结果里没有种植规格）')
  if (gapCount === 0) skipped.push('全部（当前没有结果可导出）')

  const totalFiles = groups.reduce((sum, g) => sum + g.files, 0)
  return { groups, totalFiles, skipped }
}

/**
 * 从要素列表里数出"出现过几个类别"。
 *
 * 为什么要单独一个函数而不是在组件里 `new Set(...)`：
 * ① 组件里 `gaps` 可能是脏数据（`properties` 缺失 / `class` 是空串），
 *    直接在渲染里做 `.map(f => f.properties.class)` 会抛错并整块白屏；
 * ② 这个数字直接决定导出文件数，值得有自己的断言。
 *
 * 规则：只数**非空字符串**类别；缺 `properties` / 缺 `class` 的要素不计入
 * （后端 `props_row()` 会把它们兜成 `uncertain`，但那种数据本身已经不对了，
 * 这里宁可按"没这个类别"处理，也不凭空多报一个文件）。
 */
export function countClasses(
  features: ReadonlyArray<{ properties?: { class?: unknown } }> | null | undefined,
): number {
  if (!features || features.length === 0) return 0
  const seen = new Set<string>()
  for (const f of features) {
    const cls = f?.properties?.class
    if (typeof cls === 'string' && cls.trim().length > 0) seen.add(cls)
  }
  return seen.size
}
