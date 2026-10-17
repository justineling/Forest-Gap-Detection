# Forest Gap Detection · 桌面端原型（前端）

Tauri v2 桌面端的**前端部分**，同时可脱离 Tauri 直接用浏览器调试。
按 5 步工作流实现：导入渲染 → 圈选 Target Block → 分类渲染与过滤 → 增删多边形 → 估算与导出。

决策依据见 `docs/01-需求与架构/桌面端交互需求与实现映射.md`（v0.4）。

---

## 一、怎么跑起来

```bash
# ① 启动本地瓦片 / 辅助服务（零新依赖：标准库 + rasterio）
#    首次建议加 --build-overviews（一次性建金字塔）
.venv/Scripts/python.exe scripts/tile_server.py --build-overviews

# ② 启动前端（另开一个终端）
cd desktop
npm install      # 首次
npm run dev      # → http://localhost:5173
```

浏览器打开 `http://localhost:5173` 即可。

**跑成桌面应用**（Tauri v2 外壳已就绪）

```bash
cd desktop
npm run tauri:dev      # 起窗口，自动拉起 vite（8765 的服务已在跑则复用）
npm run tauri:build    # 出 msi / nsis 安装包（首次编译 5~15 分钟）
```

外壳会：① 起窗口加载前端；② 若 8765 未监听则用仓库 `.venv` 拉起
`scripts/tile_server.py`（可用 `FGD_PYTHON` 覆盖解释器）；③ 退出时 kill 子进程。
**刻意不引入 `tauri-plugin-shell`** —— 标准库 `std::process` 就够，少一层权限配置。
细节见 `src-tauri/src/lib.rs` 顶部注释与交接简报 §16。

### 一键脚本（推荐，双击即用）

| 脚本 | 给谁用 | 做什么 |
|---|---|---|
| `启动桌面端.bat` | **开发** | 检查环境 → 缺什么自动装（调 `scripts/一键配置环境.bat`）→ 挑端口 → `tauri dev` |
| `构建安装包.bat` | **发布** | 检查环境 → `npm run build` → `tauri build` → 报告产物并自动弹安装程序 |
| `_环境准备.bat` | 上面两个的**共享模块** | 阶段提示 / 心跳 / 端口探测 / 旧产物归档 / 搬家自愈 |

三个脚本都遵循同一套约定（与同作者的 KIRA Manager 脚本一致）：

- **自动下载环境**：`.venv` / `node_modules` / `cargo` 缺任一项 → 自动调项目自带的环境向导
- **心跳**：长任务（npm install / Rust 编译 / 链接）每 ~10 秒打一行"已用 X 分 Y 秒"，
  避免用户以为卡死。心跳是**独立进程 + 哨兵文件**，不用 taskkill（不会误杀别的窗口），
  且**自限时**（默认 90 分钟，主脚本异常退出也不会留孤儿）
- **端口兜底**：5173 被占 → 自动换 5174~5199，并生成**临时 tauri 配置**覆盖
  `devUrl` 与 `beforeDevCommand`（因为 `vite.config` 的 `strictPort=true` 会直接失败，
  而 `tauri.conf.json` 的 devUrl 写死 5173 —— 必须两边同时改）；8765 被占 → 提示并给出占用 PID
- **旧产物归档**：构建前把上次的安装包挪到 `bundle/_stale/`，构建后查找**只可能**命中本次产物。
  零命中就如实说"本次未产出"，**绝不弹上一次的旧包**
- **搬家自愈**：编译缓存里记的是绝对路径，项目移动后自动清理（**仅限项目内 `src-tauri/target`**，
  `CARGO_TARGET_DIR` 指向项目外时跳过 —— 那是多项目共用目录，删了会伤到别人）

> ⚠️ 三个 `.bat` 必须存成 **UTF-8 无 BOM + CRLF 行尾**。
> 用 LF 行尾时 cmd 会把中文路径拆断（实测报 `'D://...//2.' is not recognized`）。

> ⚠️ **`--build-overviews` 会就地修改源影像**（对本 BigTIFF 是**写入文件内部**，
> 不是 `.ovr` 边车）：实测 **3.48 GB → 4.66 GB（+1.19 GB）**，耗时 174 s。
> 换来的是瓦片从 **104 s → 0.7 s**（z=13）、**35 s → 0.6 s**（z=15）。
> 这与架构文档 STEP 01「TIF 建金字塔」是同一件事，ArcGIS/QGIS 打开大图时也会做。
> **回退方式**：需要 GDAL CLI 的 `gdaladdo -clean <file>`（本机 venv 内没有 gdaladdo/rio
> 的清理命令），最稳的是重新拷一份原始影像。**执行前请确认你有原图副本。**

> **不启后端也能用**：前端会自动退回内置样例数据
> （`public/sample-gaps.geojson`，从真实结果按类别分层抽样 280 个要素），
> 地图上只是没有影像底图，多边形查看 / 编辑 / 估算 / 导出全部可用。

---

## 二、5 步需求 → 实现位置对照

| 需求 | 状态 | 实现位置 |
|---|---|---|
| ① 导入文件并渲染地图 | ✅ 已跑通 | `scripts/tile_server.py`（`/meta` + `/tiles/{z}/{x}/{y}.png`）· `src/components/MapCanvas.tsx` |
| ② 圈选 Target Block，只检测圈内 | ✅ **前后端都已就绪** | 前端：工具栏「① 圈选 Target Block」→ `store.setRoi` · 算法侧：`process_image.py --roi`（两层裁剪；A/B 瓦片 -77%、耗时 -62%、面积差 -0.39%） |
| ③ 按 class 渲染 + 勾选过滤 | ✅ 已跑通（有回归测试） | `src/lib/classes.ts`（8 类 + 人工新增，配色与 `export_arcgis.py` 一致）· `src/components/LeftPanel.tsx` |
| ④ add / delete / edit polygon | ✅ 已跑通（有回归测试） | Terra Draw（`MapCanvas.tsx` 的绘制/选择模式）+ `store` 的 `addGap` / `deleteGap` / `updateGapGeometry` / `setGapClass` |
| ⑤ 估算可种植数量 + 导出 | ✅ 已跑通 | 估算：`src/lib/estimate.ts`（已对齐算法锚点，与 Python 差 0.00%）· 点位：`GET /planting-points`（Python/UTM 权威结算，右面板一键下载 GeoJSON/CSV）· 交付包：`POST /export` |

### 多进程跑批（`--workers`，2026-10-17）

```bash
# 全量重算，4~6 个进程（8 核机器推荐 4；本机实测见下表）
.venv/Scripts/python.exe scripts/process_image.py \
  --input "drone data/WGR17-002.tif" --chm output/chm.tif \
  --segment "drone data/segment.tif" --workers 4 --force

# 桌面端 / sidecar 调用时传 workers 参数（契约参数，不进指纹）
# 只跑圈选范围时 ROI 已经能省 60%+，两者叠加效果最好
```

**实测（本机 8 核）**

| 场景 | workers | 耗时 | 加速比 | 逐位一致 |
|---|---|---|---|---|
| ROI 121 瓦片 | 1（串行） | **462 s** | 1.00× | 基准 |
| ROI 121 瓦片 | 4 | **195 s** | **2.37×** | ✅ 639 要素全等 |
| 全量 528 瓦片 | 1（历史基线） | 1,048 s | 1.00× | 基准 |
| 全量 528 瓦片 | 6 | **350 s** | **3.00×** | 见下注 |

**逐位一致性验证**：ROI 那组 639 个要素的几何 + 属性（排除 `generated_at`）
与 13 个 `summary` 字段**全部完全相等**。

> ⚠️ 全量 6 workers 那组**不能**与 10-16 的历史文件逐位对比 —— 中间影像被建过金字塔
> （3.48 → 4.66 GB），`order_tiles_by_validity` 用 overview 判定有效性，
> 降采样方式一变，边界瓦片的"有效/空白"判定会翻转 → 采样瓦片不同 →
> 网格从 8.45/7.32 变成 8.35/7.23（-1.2%），类别分布抖动 ±15 块。
> **这是影像文件层面的变化，与 workers 无关**；同一影像文件下 workers=1/4 已实测逐位一致。

**四条护栏（缺一条就会"提速了但数字变了"或"反而更慢"）**

1. **按 `tile_idx` 排序后再累加** —— 并发完成顺序是随机的，而串行版是按 tiles
   顺序累加 `all_features` / `class_totals` / `area_total`。不排序 → 浮点加法顺序变化
   → 末位抖动 → 破坏"逐位可复现"红线。做法：worker 返回 `(idx, ...)`，
   主进程 `results.sort(key=idx)` 后再累加。
2. **子进程只开一次大文件句柄** —— Windows 用 spawn，`DatasetReader` 不可 pickle。
   若每瓦片都 `rasterio.open` 一次正射影像 + CHM + segment，528 瓦片就是 1,500+ 次
   4.6 GB 文件的头部解析，提速全被吃掉。做法：`ProcessPoolExecutor(initializer=...)`。
3. **锁死底层线程数** —— numpy/scipy/GDAL 默认各自多线程；6 worker × 每进程 8~16 线程
   = 上百线程抢 CPU 与磁盘锁，实测会比单进程还慢。做法：initializer 里设
   `OMP/MKL/OPENBLAS/NUMEXPR/GDAL_NUM_THREADS=1`。
4. **子进程绝不写 stdout** —— sidecar 的 stdout 是 NDJSON 数据通道。进度事件全部
   由主进程在 `as_completed` 循环里输出，并调 `multiprocessing.freeze_support()`
   为打包做准备。

> ⚠️ `workers` **不进参数指纹**：进程数不影响单瓦片结果，改它不该让 528 个瓦片的
> 缓存全部失效（重跑一次 1,048 秒）。
> ⚠️ 瓦片数少于 `max(4, workers*2)` 时自动退回串行 —— Windows 每个子进程启动约 1 秒，
> 小批量起进程池反而更慢（也让契约测试的合成小影像保持确定性）。

### 跑测试

```bash
cd desktop
npm test        # 打包 store.test.ts / estimate.test.ts 后用 Node 直跑（约 5 秒）
```

- `tests/store.test.ts` —— 需求③④的纯逻辑回归（30 项断言）：
  默认可见性、整组勾选/取消、新增（含面积重算与留痕）、
  改判（`original_class` 保留原值、二次改判不覆盖）、改边界、删除、
  编辑留痕计数、**编辑后旧估算结果必须失效**
- `tests/estimate.test.ts` —— 需求⑤的数值回归（15 项断言）：
  面积 vs Python/UTM 一致性、双口径、点位自检（越界/退让）、
  退让单调性、`vacant_slot` 两个口径都等于块数（每块 1 株）

> 测试不依赖浏览器与 `output/`（`store` 用构造要素；`estimate` 找不到结果文件时
> 自动跳过并说明），因此换机器也能跑。

---

## 三、目录结构

```
desktop/
├─ index.html · vite.config.ts · tsconfig.json · package.json
├─ public/sample-gaps.geojson     # 离线演示数据（真实结果抽样）
├─ tests/
│  ├─ store.test.ts               # 需求③④ 纯逻辑回归（npm test）
│  └─ estimate.test.ts            # 需求⑤ 数值回归（npm test）
└─ src/
   ├─ main.tsx · App.tsx · styles.css
   ├─ types.ts                    # 与 Python 侧 schema 对齐的领域类型
   ├─ lib/
   │  ├─ classes.ts               # 8 类 + 人工新增的标签/配色/业务分组
   │  ├─ geometry.ts              # 零依赖几何工具（面积/质心/点在内/到边界距离）
   │  └─ estimate.ts              # 双口径估算 + 网格排坑模拟
   ├─ store/useAppStore.ts        # zustand：数据 / 可见性 / ROI / 编辑留痕 / 日志
   ├─ api/backend.ts              # 只封装必须走 HTTP 的端点（瓦片/元数据/结果/导出）
   └─ components/
      ├─ TopToolbar.tsx · LeftPanel.tsx · MapCanvas.tsx
      ├─ RightPanel.tsx · StatusBar.tsx
```

---

## 四、与 `架构方案.html` 的差异（都已在决策文档里说明）

| 项 | 架构文档 | 本原型 | 原因 |
|---|---|---|---|
| 前端框架 | React 18 + TS | ✅ 一致 | — |
| 地图引擎 | MapLibre GL 4 | ✅ 一致 | — |
| 绘图库 | （未指定） | **Terra Draw** | Leaflet-Geoman 只支持 Leaflet；Terra Draw 是 MapLibre 生态的对应物 |
| 样式方案 | `tailwindcss@3.4` | **手写 CSS** | 原型阶段降低构建面（少 3 个配置文件）；组件已按块组织，迁移 Tailwind 成本低 |
| 瓦片服务 | Rust GDAL `TileService`（axum） | **Python 标准库 + rasterio** | 本机没有 fastapi/uvicorn/rio-tiler，且算法已全在 Python；**是否改架构待用户拍板**（决策文档 §4.1） |
| 地理内核 | Rust `geo/*` | **保留在 Python** | `process_image.py` 里已实现并过 528 瓦片实测，重写等于把"已验证"换成"未验证"（决策文档 §4.2） |
| 项目位置 | 仓库根目录 `src/` `src-tauri/` | **`desktop/` 子目录** | 仓库根目录已有 `scripts/ docs/ output/ .venv/ drone data/`；Node 工程放子目录避免与 Python 混在一起 |
| 检测触发 | `Tauri Command` + sidecar | 浏览器里**故意留空**并说明原因 | 浏览器无法 spawn 子进程；Tauri 版才接 `scripts/sidecar.py` 的 NDJSON 契约 |

---

## 五、已验证 / 未验证

**已验证**

- `tsc --noEmit` 零错误；`vite build` 成功（JS 1.1 MB / gzip 310 KB，主要是 maplibre-gl）
- 瓦片服务：`/meta` 返回实测元数据（47,130×44,686 · EPSG:4326 · 0.033 m/px）；
  `/tiles/...png` 返回真实影像像素（抽样核对 min 19 / max 255 / mean 110）；
  `/gaps` 返回 13.6 MB 真实结果；园区外瓦片返回透明瓦片而不是抛错
- **估算模块用真实结果跑通**（`.workbuddy-ai/tmp/ui/verify_estimate.ts`，
  用 esbuild 打包后 Node 直跑，1,726 个要素）：

| 项 | 实测 |
|---|---|
| 面积核对（TS vs Python/UTM） | 435,071 vs 434,729 m²，**单块最大相对误差 0.09%** |
| 参与面积 | 309,145 m²（与 `summary.plantable_area_definite_sqm` 差 0.00%） |
| 口径A 面积折算 | **4,420 株** |
| 口径B 网格排坑 | **2,152 株** |
| 点位自检 | 越界 0 · 退让不足 0 · 株位标记 253 |
| 单次耗时 | 306 ms（1,726 个多边形） |

> **两个"面积口径"数字为什么不一样（4,420 vs 4,636）**：
> - `summary` 的 4,636 = 确定需补种总面积 309,143 ÷ 66.67（**不考虑形状**）；
> - 本模块的 4,420 = 逐块 `floor(area/66.67)`（449 块连片空地）+ 每块 1 株（253 块株位空缺）。
> 后者更保守：逐块取整会损失一点，而株位空缺按"一个单元缺 1 棵"计比按面积算更合理。
> 两个都远大于排坑口径 2,152 —— 因为排坑要满足 2 m 退让与 8.45 m 间距的几何约束。

**退让距离敏感度**（这是需要业务拍板的关键参数）：

| 退让 | 排坑口径 | 与面积口径差异 |
|---|---|---|
| 0.5 m | 3,594 株 | 18.7% |
| 1.0 m | 3,009 株 | 31.9% |
| **2.0 m（默认）** | **2,152 株** | **51.3%** |
| 3.0 m | 1,569 株 | 64.5% |

**结论（重要）**：面积口径 `area/66.67` 是**上界**（它假设整块面积都可种），
几何口径才是真实可放样的数量。两者差异主要来自 **449 块 `open_patch` 中的 123 块
（31,155 m²）是窄条** —— 2 m 退让后一个格点都放不下。
这既说明面积口径偏乐观，也提示 `open_patch` / `alley_gap` 的分类边界值得复核。
UI 对差异 > 30% 的多边形标黄，正是为了让用户逐个判断。

**未验证 / 未做**

- 后端 `/export` 只出 geojson / csv / kml；**Shapefile 仍由 `scripts/export_arcgis.py` 出**
  （它需要 `blocks` 结构与 CRS 元数据，本机无 `osgeo`/`fiona`）
- `detect`（真正的检测）未接 —— 需先实现算法侧 ROI 裁剪
- 未做 Tauri 外壳（窗口、文件对话框、sidecar 进程监督）
- 未做 1,700+ 多边形在低配机器上的渲染压测
- 未做交互动作的端到端验证：**页面渲染**已截图确认，但"点击圈选 / 拖拽顶点 /
  按 Delete 删除"这些**鼠标交互**仍未经我实测（需要真实浏览器操作）。
  逻辑层已由 `npm test` 覆盖（43 项），交互层请自行在 `http://localhost:5173` 操作确认。

### 视觉验证（2026-10-17 已打通）

headless Chrome 此前静默退出、不产出文件；环境放开权限后已可截图，并且**立刻暴露了一个真 bug**：

| 状态 | 截图体积 | 唯一颜色数 | 结论 |
|---|---|---|---|
| 修复前 | 6,886 B | **1**（纯背景色） | ⚠️ 整页白屏（见下方坑 4） |
| 修复后 | **607,510 B** | **112,028** | ✅ 正常渲染 |

修复后分区像素统计（说明各区域都有内容）：

| 区域 | 颜色数 | 平均色 |
|---|---|---|
| 顶栏 | 1,621 | RGB(30, 37, 41) |
| 左面板 | 575 | RGB(32, 39, 43) |
| **地图** | **109,675** | **RGB(35, 40, 26) —— G 通道最高，即真实植被影像** |
| 右面板 | 260 | RGB(23, 29, 33) |
| 底栏 | 202 | RGB(29, 36, 40) |

界面截图已存档：`docs/07-检测成果/桌面端原型界面.png`

---

## 六、已知坑（都已修，留作记录）

**瓦片服务侧**

1. **`Window.intersection` 在无交集时抛 `WindowError`**，不是返回空窗口 ——
   园区外的瓦片必须捕获异常后返回透明瓦片，否则每个请求都抛栈。
2. **波段索引别把 Alpha 算进去**：本影像 4 波段（第 4 波段恒 255），
   把 4 个波段送进目标是 3 波段的 `reproject` 会直接报错 → 瓦片全黑。
3. **影像没有金字塔**：低缩放级瓦片窗口覆盖大半个影像，GDAL 只能全分辨率读
   → 实测 z=15 约 35 s、z=13 约 104 s。必须 `--build-overviews`（一次性）。

**估算模块侧**（这两个只有跑真实数据才会暴露，类型检查完全看不出来）

4. **网格索引 i 的范围必须逐 j 计算**：格点沿行方向的投影是
   `alongU = i*pitch + j*skew`，反解 `i = (du - j*skew)/pitch`。
   `j*skew` 在离原点较远的要素上可达 ±50 个格位；若用「全局 iMin/iMax」
   一次算死，**远处的要素一个格点都取不到** ——
   实测症状：5,771 m² 的连片空地得 0 株，全园排坑只有 286 株（应为 2,152）。
5. **按类别分口径**：`vacant_slot` 是"一个种植单元里少了 1 棵树"
   （实测 253 块 / 16,043 m² ≈ 63 m²/块），
   ① 网格法用 2 m 退让铺 8.45 m 间距的格点会大量落空；
   ② 面积法 `floor(63/66.67) = 0`。
   两个口径都必须记 **1 株**，点位取质心。
6. **经纬度→米的换算不能用「1° ≈ 111320 m」这个常数**：
   在纬度 1.18° 处子午圈每度只有 **110,577 m**，用常数会让面积系统性偏大
   **+0.67%**（实测 TS 合计比 Python/UTM 大 0.75%）。必须用大地测量曲率半径
   （`M` 子午圈 / `N` 卯酉圈），修正后误差降到 0.09%。

**类型侧**

7. **`match` 表达式的 TS 类型**：MapLibre 的表达式是变长元组，TS 无法从 `flatMap`
   推断，已收敛到 `lib/classes.ts` 的 `classColorExpr()` 一处做断言。

8. **组件抛错会卸载整棵 React 树 → 整页白屏**（最隐蔽的一个）

   ```text
   Uncaught Error: Style is not done loading.
   The above error occurred in the <MapCanvas> component:
   Consider adding an error boundary to your tree …
   ```

   Terra Draw 的 MapLibre adapter 在 `start()` 时会向地图注册自己的 source / layer；
   若此时 map style 未加载完，就抛 `Style is not done loading.`。
   因为它在 React 的 effect 里，**React 18 未捕获时会卸载整棵树** ——
   用户看到的是"整个界面消失"，而不是"地图坏掉"。

   **两处修法（缺一不可）**：
   - Terra Draw 的创建 + `start()` **必须放进 `map.on('load')` 回调内**；
   - 给每个区域包 `ErrorBoundary`（地图挂了，工具栏 / 图层面板 / 状态栏仍可用）。

   > 这个坑极易被误判成"环境问题"而查错方向：本地浏览器打开时 style 加载快、
   > 时序刚好躲过去；headless / 网络慢 / 低配机器上就复现。

**数据契约侧**（这三个都不会报错，只会让数字悄悄不对）

9. **算法输出的正式结构是 `blocks[].gaps`，不是扁平 `features`**

   `output/*.geojson` 的顶层是
   `{ type, crs, planting_grid, blocks: [{ block_id, block_name, gaps: [...] }], summary }`
   —— **没有顶层 `features`**。前端若按 `fc.features ?? []` 读，会拿到**空数组**：
   界面显示「后端在线」、地图有影像，但**一个多边形都不出现，也不报错**。
   更坑的是：内置样例 `public/sample-gaps.geojson` 是扁平结构，
   所以**离线演示时反而正常**，更容易掩盖这个 bug。
   修法：`api/backend.ts` 的 `normalizeCollection()` 统一摊平。

10. **点位必须基于 `wgr17-final-gaps.geojson`（交付版），不是 `-elev-gaps`（中间版）**

    两版都是 1,726 要素，但类别不同：elev 版 `open_patch` 464 / `vacant_slot` 256，
    final 版 449 / 253（那 18 块归入 `undeveloped`）。
    在 elev 版上跑点位得 **3,912**，在 final 版上得 **3,691** ——
    多出来的 221 个点等于**把未开发林当成可补种**。CLI `--input` 默认已改为 final。

11. **前端网格原点必须用算法锚点，不能用「要素顶点均值」**

    前端自取原点时相位是**任意**的，与 Python 侧实测差 **+8.8%**（3,594 vs 3,912 那次）。
    `/gaps` 响应会动态补 `planting_grid.anchor_lon/anchor_lat`
    （结果中心最近的格点，**不改磁盘文件**），前端拿它当原点后 0.5 m 档
    **3,691 = 3,691（0.00%）**。`estimate()` 的 `origin_source` 字段会告诉你实际用了哪个。

    > 顺带纠正一个曾被误读的结论：树心到最近格点 P50 = 3.15 m **不是"比随机还差"**。
    > 二维晶格随机基准是 `r₅₀ = √(A/2π) = 3.137 m`、`P(≤1m) = π/A = 5.08%`
    > （A = 8.45×7.3179 = 61.836 m²），实测 3.15 / 5.1% 就是**完美随机**。
    > 一维基准 `8.45/4 = 2.11 m` 是用错了模型。

**Tauri 外壳侧**

12. **Windows 下 `cargo check` 会因缺 `icons/icon.ico` 直接失败**

    ```text
    `…/icons/icon.ico` not found; required for generating a Windows Resource file during tauri-build
    ```

    只有 `icon.png` 不够 —— Windows 资源编译必须 `.ico`（含 16/32/64/128/256 多尺寸）。
    已用 PIL 从 `icon.png` 生成。

13. **退出时不清子进程 → 下次启动"端口被占"**

    `RunEvent::Exit` 里必须 kill 掉 tile_server，否则孤儿 python 进程一直占着 8765，
    下次启动会误判"服务已在运行"而复用**旧版本**的服务进程（改了代码却不生效）。

**一键脚本侧**（`.bat` 的两个坑，都实测踩过）

14. **`.bat` 必须是 UTF-8 无 BOM + CRLF 行尾**

    用 LF 行尾时 cmd 会把含中文的路径行**拆断**，报出这种毫无线索的错误：

    ```text
    'D://学习目标_笔记//2.' is not recognized as an internal or external command
    'e' is not recognized as an internal or external command
    ```

    看起来像路径被空格切了，实际是**行尾 + 编码**共同作用。修法：
    `python -c "b=open(p,'rb').read(); open(p,'wb').write(b.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n'))"`

15. **`call 文件.bat 标签 参数` 不是"跳到文件内标签"**

    cmd 里 `call other.bat stage_begin 1 5 "..."` 会把 `stage_begin` 当成 `%1`
    **传给文件、文件从头执行**。共享模块必须自己分发：

    ```bat
    set "FG_LIB_ENTRY=%~1"
    if not defined FG_LIB_ENTRY exit /b 0
    shift
    goto %FG_LIB_ENTRY%
    ```

    并且**顶层不能 `setlocal`** —— 否则 `FG_NEED_*` / `FG_DEV_PORT` 这些结果变量
    在 `call` 返回后全部丢失，调用方永远拿到空值（实测症状：`check_runtime`
    三项都打印"已就绪"，但 `FG_NEED_PY` 是空的）。

16. **搬家自愈会误删共享的 `CARGO_TARGET_DIR`**（最危险的一个）

    本机把 `CARGO_TARGET_DIR` 指到了 `D://forest-gap-tools//rust//target`。
    那个目录里没有本项目的路径标记，`.d` 文件记录的也是**别的项目**的路径 →
    "搬家检测"判定为项目移动过 → `rmdir /s /q` 清空 → **把别的项目的编译缓存删了**。

    修法：**只对项目内的 `src-tauri\target` 做搬家检测**，
    `CARGO_TARGET_DIR` 指向项目外时直接跳过（并打印一行提示）。
