# Forest Gap Detection — 项目长期记忆

> 本文件沉淀长期约定与关键结论。每日过程记录见同目录 `YYYY-MM-DD.md`。
> 首次重建于 2026-10-13（家里电脑，由交接文档 + git log 反推）。

## 1. 项目定位
油棕种植园（**不是普通森林**）空地智能检测桌面应用。输入 KML 范围 + 正射影像，
输出全园需补种空地的矢量坐标图盘。最终形态 Tauri v2（Rust + React），
当前只做到 Python 算法层 + 推理服务契约。

## 2. 工作区与运行环境（本机）
- 工作区：`D:/学习目标_笔记/2. 智/计算机/自学/9. 人工智能/项目类型/图像识别/Forest-Gap-Detection`
  （git 仓库，remote = github.com/justineling/Forest-Gap-Detection，分支 main）
- ⚠️ 交接文档里的 `D:/Project/AI/Forest Gap Detection` 是**公司电脑**路径，本机不适用。
- Python 环境：`.venv/Scripts/python.exe`，由 `scripts/配置环境.ps1`（或双击 `一键配置环境.bat`）生成。
  **禁止用系统 python**（无 numpy）。执行策略需 `-ExecutionPolicy Bypass`。
- 运行态资源（`.venv/`、`output/`、`models/` 权重）被 `.gitignore` 排除，**每次新克隆后需重建**。
  ⚠️ `.workbuddy-ai/` 自 2026-10-14（7f7c1f8）起**已纳入版本管理**（项目记忆 + 分析脚本 +
  验证图），不再随 `.gitignore` 丢失；`output/arcgis/` 仍需重跑导出生成
  （`scripts/export_arcgis.py` 已入库）。
- 大影像 `WGR17.tif`：3.48 GiB，47,130×44,686，EPSG:4326，3.3 cm/px，4 波段（第4波段恒 255=Alpha）。
  本机需用户提供（云端下载 / 外接盘）。园区占外接矩形 57%。

## 3. 核心实测数据（改算法前必读）
- 株距 8.35 m / 行距 7.23 m / 错行角 60°（三角形种植）/ 密度 165.6 株/公顷
- 分割判据 v3（已定稿）：`阈值 = clip(ExG 的 40% 分位, 40, 80)`；`树冠 = (平滑ExG>阈值) 或 (饱和度>0.45)`
- **跨航带曝光差异极大**：ExG 中位 37~116（差 3 倍）→ 所有阈值必须对曝光鲁棒
- 不可种植三类判据：
  - 道路/办公共用「亮 L>170 + 低饱和 S<0.18」掩膜，靠 **fill ratio** 分界：
    **< 0.30 线状 = 道路**；**≥ 0.30 且面积 ≥ 400 m² = 办公区**
  - 水体：`B≥G>R` 或（暗 L<90 & ExG<15 & 纹理 std<6），再过 **30 m² 最小连通域**门槛
- fill ratio 实测完全分离：道路 0.013~0.211；办公 0.317~0.548
- 纹理 std 分档：株位空缺 8~15 / 连片空地 22~26 / 油棕 39~47 / 草地 46.3（草地与油棕有重叠）
- 全局网格勘察（10-14 全量 fit）：株距 8.45 m / 行距 7.32 m / 错行角 60° /
  质量 0.752 / 79 节点 / global_consensus（密度 161.7 株/ha）
- 草地 vs 油棕光谱：草地 ExG 159 / S 0.64 vs 油棕 ExG 64~102 / S 0.37~0.53
  ——「立体的绿」被内部阴影打折，**ExG 过高反而不是树**

---

## ★ 2026-10-16 晚（家里电脑）算法评审结论

完整清单见 `docs/03-算法教学/算法缺陷与改进清单.md`（含实测数字与优先级）。
以下只记**长期有效的关键结论**：

### 确证的代码级缺陷：网格方位角「角度别名」合成
- 各瓦片估出的方位角落在 `3°/61°/1°/90°/179°` 等**别名分支**上（等边三角形格点
  有 60° 旋转对称），`global_consensus` 直接取中位数 → 得到谁都不对的方位
  （10-15 公司机 0.7° 正确；10-16 本机 21.2° 错约 20°）。
- **定标方法（可复用）**：`tree_info` 树心在 300 m 窗口做「方位 0.5° × 相位 8×8」细扫，
  指标 = 树心落在格点 3 m 内比例（随机基准 45.8%）→ 实测 **59.0°、对齐率 79~97%**。
  ⚠️ 全幅细扫不可行（1,500 m 上 0.2° 就漂移 5 m）；脚本 `tmp/analyze/probe_phase_local.py`。
- 后果：**类别归属抖动**（林间空隙 +19 块 / +9.5%），但**总面积与要素数逐位可复现**。
- 修法：合成前按 mod 60° 折叠再取中位数。

### 其它实测要点
- **水体漏检 92%**：DJI 标注 7,625 m² / 只检出 605 m²，**5,691 m² 被算进需补种**。
  机制：`build_chm` 把水面置 NaN → `fuse_canopy` 里 `canopy &= isfinite(chm)`
  → 水面必然非树冠，只能靠 RGB 判据拦（而绿色浑浊水塘不满足 `B≥G>R`）。
- 「非树」判定 **51%（214,827 m²）完全靠语义分割**；CHM 阈值 ±1 m ≈ ±3.0 万 m² 翻转
  （仅 5 个真值点标定）。
- 亮白判据缝隙（fill≥0.30 且 12~400 m²）**2,925 m² / 107 块**（实例：水塘旁泵房）。
- 非树区域 **29% 是绿色植被**（12.3 万 m²）；「低矮植被」类别规划了但**未实现**。
- 独立验证通过：空地距树心 2 m 内仅 **2.0%**（全园基准 14.5%）→ 空地确实避开树；
  `CHM≥12 m` 区粗糙度 **0.604 ≈ 健康油棕** → 高 CHM 是"伪影叠在真树上"。

### 本机（家里电脑）环境
- 原始数据在 `drone data/`：**正射实际文件名 `WGR17-002.tif`**（不是 WGR17.tif）
  + dsm.tif / segment.tif / tree_info.json。
- `output/` 已在本机重建（全量 1,041.6 秒）：`wgr17-elev-gaps.geojson`、
  `forest-mask-50m-exg60.geojson`、`wgr17-final-gaps.geojson`、`arcgis/`（8 类）。
- 分析脚本在 `.workbuddy-ai/tmp/analyze/probe_*.py`（tmp 不入库）。

---

## ★ 2026-10-17 四项修复（家里电脑）

完整记录见 `docs/03-算法教学/算法缺陷与改进清单.md` 的「★ 2026-10-17 修复记录」
（含 A/B 表）。以下只记**长期有效的要点**：

### 1. 网格方位角合成：必须按格点对称阶数折叠
- 等边三角形格点有 **60° 旋转对称** → 方位角要按 **6θ（模 60°）** 做圆统计。
  旧代码按 2θ（模 180°）→ 把 21.2° 当结果（真值 **59.0° ≡ −1.0°**）。
- ⚠️ **禁止**"先 `angle % 60` 再取算术中位数"：真值卡在 0/60 边界时
  （−1°→59°、+1°→1°）会算出 30°。
- 还要剔除**对偶轴离群块**（90° ≡ 30° mod 60°，偏离主方向 30°）后再合成。
- 验证法：`tree_info` 树心在 300 m 窗口做「方位 0.5° × 相位 8×8」细扫，
  指标 = 树心落格点 3 m 内的比例（随机基准 45.8%，实测最优 79~97%）。
  ⚠️ 全幅细扫不可行（1,500 m 跨度上 0.2° 就漂移 5 m）。

### 2. 水体：CHM 置 NaN 会把水面推向"非树"
- `build_chm` 把水面置 NaN，而 `fuse_canopy` 里 `canopy &= isfinite(chm)`
  → 水面**必然**进空地候选；RGB 蓝度规则只覆盖 DJI 水体的 **7.9%**
  （含藻类的绿水塘不满足 `B≥G>R`）。
- 已并入 `seg==water` 作为第三条证据（参数 `water_use_segment`，
  CLI `--no-water-segment` 可回退）。实测 DJI 水塘覆盖率 **7.9% → 98.0%**。

### 3. 「需补种」必须三档报（否则虚胖 14%）
- `grid_prior.PRIORITY_GROUPS` + `summarize_priority()`；
  输出 `summary.by_priority` / `plantable_area_definite_sqm`。
  确定需补种 = open_patch + vacant_slot；review = uncertain；not_needed = alley_gap。

### 4. 桌面端必须与 CLI 走同一条路
- `sidecar.run_pipeline` 调 `process_tile` 时**必须传 `elevation` / `elev_params`**
  —— 2026-10-17 前没传，**桌面端跑的是纯 RGB 版本**（退化为草地回检）。
- `class_totals` 要用 `{c: 0 for c in CLASS_LABEL_CN}` 全量初始化，
  否则 `if k in class_totals` 会把 road/water/office 计数静默丢弃。

### 5. 修复后的交付数字（2026-10-17，本机）
- 交付包 **1,726 要素 / 8 类**；**确定需补种 702 块 / 309,143 m²**（占 13.49%）；
  待复核（不确定）465 块 / 40,593 m²；不计入（林间空隙）251 块 / 13,277 m²；
  不可种植：道路 180/34,357、水体 21/9,711、办公 82/7,235；非种植区 25/20,412。
- 全量耗时（本机）**1,048.2 秒**；契约测试 95/95。
- 遗留：`office` 门槛下调后"道路变宽处被标为办公区"的语义噪声
  （要更干净需新增 `hard_surface` 类别）。

## ★ 2026-10-17 桌面端（Tauri）—— 需求评审 → 原型 → 对账收口

### 技术栈：以 `架构方案.html` 的冻结决策为准，**否决**外部方案的 3 处
前端 **React 18 + TS**（不用 Vue 3）· 地图 **MapLibre GL 4**（不用 Leaflet）·
绘图 **Terra Draw**（Geoman 只支持 Leaflet）· 后端 **stdio NDJSON sidecar**
（不用 FastAPI；契约已冻结 95/95），**只有瓦片走 HTTP** ·
瓦片服务**保留 Python**（建金字塔后 700 ms 达标；Rust 端再链 gdal 会撞 dll/proj.db 冲突）。

### 分支 `feat/desktop-app` 的 `desktop/` 子目录
React 18 + TS + Vite 5 + MapLibre GL 4 + Terra Draw 1.37 + zustand 4.5（手写 CSS 代 Tailwind）
+ **Tauri v2 外壳**（`src-tauri/`，`cargo check` 通过）。

- **`npm test` 是本模块验收基线**（43 项断言，~5 秒）：`tests/store.test.ts`（需求③④）
  + `tests/estimate.test.ts`（需求⑤）。换机器无 `output/` 会自动跳过 estimate 并说明。
- 新增 `scripts/tile_server.py`（零新依赖）：`/meta` · `/tiles/{z}/{x}/{y}.png` · `/gaps`
  · **`/planting-points?clearance=`** · `POST /export` · `--build-overviews` · `--ovr-mode`
- 双口径估算：面积折算 `floor(area/66.67)` + 网格排坑（8.45/7.3179/0.6656°/退让 0.5 m）
- **退让 0.5 m 是业务拍板**（3,691 株）：`open_patch` 边界是**树冠叶尖外缘**
  （距树干约 4.2 m），449 块等效宽度 2A/P 的 P50 仅 **4.68 m**；2 m 退让会让
  123 块单行缺株带排不出点。⚠️ 依据写在 `lib/estimate.ts` 的 `DEFAULT_GRID` 注释，**不要改回去**。
- **前后端株数已对齐 0.00%**（3,691 = 3,691）：`/gaps` 响应**动态补**
  `planting_grid.anchor_lon/lat`（结果中心最近格点，只在内存 enrich，不改磁盘），
  前端 `estimate()` 用它当原点。残余 1.0/2.0 m 档 +0.6~0.9%（GEOS buffer vs 逐点距离）。
- **点位必须基于 `wgr17-final-gaps.geojson`**（交付版）；`-elev-gaps` 是未应用森林掩膜的
  中间版，会多算 221 个点（把未开发林算成可补种）。
- **`output/*.geojson` 是 `blocks[].gaps` 结构，没有顶层 `features`** ——
  前端按 `features` 读会静默拿到空数组（界面上一个多边形都不显示且不报错）。
  修法：`api/backend.ts` 的 `normalizeCollection()`。

### 多进程与一键脚本（2026-10-17）

- `--workers`（默认 1，0=自动 min(6, cpu//2)）：全量 **1,048 → 350 s**、ROI 462 → 195 s。
  四条护栏：**按 tile_idx 排序后累加** / initializer 只开一次句柄 / 锁死 BLAS+GDAL 线程 /
  子进程不写 stdout。**`workers` 不进指纹**。瓦片 < max(4, workers*2) 自动退回串行。
- ✅ **建金字塔后网格 8.45/7.32 → 8.35/7.23 是变准了**（不是漂移）：8.35×7.23 正是
  早期用频域自相关 + 树心 NND 互证的**真实物理株行距**；没建金字塔时全分辨率跨步
  近邻抽样有混叠噪声才撑大到 8.45/7.32。跨影像版本对比仍须重立基线。
- **Tauri ↔ sidecar IPC 已通**（`run_detect`/`cancel_detect`/`detect_status`）：
  **两个线程分别读 stdout 与 stderr**（否则 64 KB 管道填满 → 永久死锁且无报错）；
  注入 PYTHONUNBUFFERED/IOENCODING/UTF8；`CREATE_NO_WINDOW`；
  `isTauri()` + 动态 import 保浏览器模式。**参数名必须逐字对齐**
  （`chm_path`/`segment_path`/`target_density_per_ha`，写错只回 W1001 然后照常跑完）。
- **重跑合并策略** `lib/mergeEdits.ts`：`keep_manual`/`overwrite`；匹配用质心落入 +
  外接框 IoU 兜底；删除优先；`replayed_from` 留痕；store 的 `deletedFeatures` **存几何**。
- **打包分发已通**：`scripts/desktop_entry.py` **单入口**（`--run-tile-server` /
  默认 sidecar / `--self-test`），PyInstaller `--onedir` 出 **179 MB**，两服务共享一份依赖。
  ⚠️ **两份 proj.db 版本不同**：rasterio 自带 MINOR=5、pyproj 自带 MINOR=4 →
  `PROJ_DATA` **必须优先指向 rasterio 的 proj_data**（否则冻结态 `CRS.from_epsg` 全崩，
  开发态复现不出来）。`freeze_support()` 必须是 `__main__` 第一行。
  Rust 双模：`resources/py-runtime/desktop_entry.exe` → 仓库 `.venv`；
  数据根 `%LOCALAPPDATA%\fgd\data`（自动创建，Program Files 不可写）。
  ⚠️ `[profile.release]` **不要** `codegen-units=1` + full LTO（内存紧张时 rustc
  会以 0xc0000005 崩，报错完全看不出原因），用 `codegen-units=4` + `lto="thin"`。
- 三个 bat：`启动桌面端.bat`（开发）/ `构建安装包.bat`（发布）/ `_环境准备.bat`（共享）。
  必须 **UTF-8 无 BOM + CRLF**；`call 文件.bat 标签` 靠 shift+goto 分发且**顶层不能 setlocal**；
  搬家自愈**只对项目内 target** 生效（否则会删掉共享的 `CARGO_TARGET_DIR`）。

### 坑（完整版见 `desktop/README.md` 16 条，这里只留最容易返工的）
1. `Window.intersection` 无交集时**抛 `WindowError`**，不是返回空窗口
2. 影像 **4 波段**（第 4 恒 255 = Alpha）—— 4 波段源送进 3 波段目标 `reproject` 直接报错
3. **影像没有金字塔** → 低缩放级瓦片 z=13 要 104 s；`--build-overviews` 后 **0.7 s（149×）**。
   代价：BigTIFF **写进文件内部**，3.48 → 4.66 GB（`--ovr-mode auto` 默认改副本，不碰源文件）
4. 估算模块：网格索引 `i` **必须逐 `j` 算**（`j*skew` 可达 ±50 格位）；
   经纬度→米**不能用 111320 常数**（用曲率半径，面积误差 0.76%→0.09%）；
   `vacant_slot` 两个口径都记 1 株
5. **组件抛错会卸载整棵 React 树 → 整页白屏**：Terra Draw 的 `start()` 必须在
   `map.on('load')` 内 + 每个区域包 `ErrorBoundary`。
   **教训：「逻辑被测试覆盖」≠「界面能渲染」—— 43 项断言全绿时页面是白的。**
6. Tauri：Windows 缺 `icons/icon.ico` 会让 `cargo check` 直接失败（只有 png 不够）；
   退出不 kill 子进程 → 孤儿 python 占住 8765，下次启动复用**旧版本**服务


### docgen 教训（新）
自动重生成文档时**路径必须可移植**：`gen_gdrive.py` 曾硬编码 `D:/WGR`，
在家里机上探不到就把体积全写成 `0 KB`，**静默把一份正确文档改成了错的**。


## 4. 红线与硬约定（违反会返工）
- **Git**：绝不自动 commit，必须用户明确同意。提交前先 `git reset` 清空暂存区再按路径 `git add`
  （防 `git stash pop` 恢复的 staged 文件被误卷进提交）。核实远端真实状态用 `git ls-remote`。
  提交信息中文 + Conventional Commits 前缀。
- **文档**：HTML 报告必须同时出「专业版 `<主题>.html` + 小白版 `<主题>-小白版.html`」；
  中文目录/文件名；**含图 HTML 一律把图片内联为 base64 或手写内联 SVG，禁用相对路径**。
- **代码**：标识符纯 ASCII，中文只在注释/显示字符串；`sidecar.py` 的 **stdout 是 NDJSON 数据通道**，
  禁止 print 污染，人类日志走 stderr。
- **测试**：`scripts/test_sidecar_contract.py` 期望 **95/95**，是改动前后的验收基线（约 1 分钟，合成影像）。
- PowerShell 5.1 读 `.ps1` 必须有 UTF-8 BOM。

## 5. 待办（截至 2026-10-17）

- ✅ 全部 P0~P6 旧待办已完成（重跑整幅 / 水体验证 / 文档登记 / 草地回检 /
  road 几何差集 / 性能优化）。当前全量 **1,048 秒 / 528 瓦片**。
- ✅ **多进程跑批已完成**（2026-10-17，`--workers`）：全量 1,048 s → **350 s**（6 workers，3.0×），
  ROI 121 瓦片 462 s → 195 s（4 workers，2.37×），逐位可复现。四条护栏见 desktop/README
- ⏳ **打包分发**：Python 目录进 Tauri `resources/`（裁定 `--onedir`，
  严禁 `--onefile`）；文件对话框、安装包签名
- ⏳ **合并策略实现**：重跑时「保留人工编辑 / 完全覆盖」两档（IoU>0.5 重放删除与改判）
- ⏳ `active_learning.py` 仍未跑过

## 6. 性能基线（2026-10-17）

- 单瓦片 **~2 秒**（2304² 含 128px 外扩）；全量 528 瓦片 **1,048 秒**（串行）
  → **350 秒**（`--workers 6`）；ROI 121 瓦片 462 → 195 秒（`--workers 4`）
- **关键教训**：连通域统计**不要**逐域做全图 `lab == i` / `comp.sum()`，
  改用 `np.bincount(lab.ravel())` 一次算完 + 只在各自 bbox 内取局部数组
  （43 秒/瓦片 → 3 秒/瓦片，等价性已逐像素验证）
- **另一教训**：栅格层 `min_area` 粗筛是负优化（1336s→2400s）——连通域绝大多数
  本就 > 30 m² 门槛，预筛不掉东西却多付 label + 布尔索引开销

---
## ★ 重要更正：「油棕-南部」其实是「未开发森林-南部」（2026-10-16 用户核实）

### 事实
用户核实：原参考点「油棕-南部」（正射像素 col=30000, row=40000）
所在的**南部区域是尚未开发的天然林 / 次生林**，不属于油棕种植区。

### 这解释了此前所有"反常"数据（此前判断需修正）
| 现象 | 旧解释（错） | 新解释（对） |
|---|---|---|
| DINOv2 把该点 99.2% 判为非油棕 | "DINOv2 被跨航带曝光带偏了" | **DINOv2 判对了** —— 野生阔叶林确实不是海星状油棕 |
| 该点 CHM 仅 2.32 m | "DSM 渗高/方法错误" | **正确** —— 该点落在未开发林的低矮灌木丛上 |
| 60 m 窗口 58.6% 是树、中心 0% | "参考点采样错误" | 两者都对：野生乔木(高)与林间灌木(矮)交错 |

⚠️ **但不要过度平反 DINOv2**：同一次留一验证中，**真油棕（西北）也被 DINOv2
判成草地 79.7%**。所以 DINOv2 不是一个可靠的油棕/草地判别器，只是在
"野生林 vs 油棕"这个更粗的粒度上恰好判对。结论不变：**不采用 DINOv2**。

### 判别依据（实测，稳定且物理可解释）
`tree_info.json` 的树心表本质是在找**按种植方式栽下的果树**，因此：

| 区域 | 100 m 区块树心密度 |
|---|---|
| 油棕种植区 | **110~160 株/ha**（P25=99 / P50=129 / P75=144） |
| 未开发林（南部） | **20~60 株/ha**（中位 42） |

→ 这个差异比 RGB 上的任何特征都稳定（RGB 上草地与油棕完全不可分）。
→ 判别用**区块密度**，不用树冠连通性（实测最大连通域 37.6 ha 竟在
   高密度种植区，因为 DSM 平滑把相邻树冠粘连了，连通性不可用）。

### 对交付结果的影响（实测）
- 需补种 **399,344 m²** 中，**57 块 / 69,535 m²（17.4%）** 落在未开发林区
- 剔除后需补种 **329,809 m²**
- ⚠️ 自动掩膜**对阈值敏感**：原始<70 → 15.4 ha / 影响 16.8%；
  平滑σ1.5<70 → 6.2 ha / 4.0%；平滑σ1.5<90 → 17.0 ha / 20.3%
  → **必须人工复核边界**，不能盲信自动结果

### 已实现的机制
1. `scripts/build_forest_mask.py` —— 按树心密度自动生成**候选**掩膜
2. `scripts/apply_forest_mask.py` —— 对**已产出的**结果秒级重分类（免重跑）
3. `process_image.py --forest-mask <geojson>` —— 跑管线时直接应用
4. 新类别 **`undeveloped`（非种植区）**：计入 `UNPLANTABLE_CLASSES`，
   不计入需补种，但**保留在输出中单独成层**便于复核
5. `export_arcgis.py` 已支持（by-class 从 7 层扩到 8 层）

### 教训
**验证算法的"标准答案"本身也可能是错的。** 一个错标的参考点
（把未开发林当成油棕）导致连续多轮误判"算法有 bug"，
包括让我错误地否定了 DINOv2 的那次判定。
→ 油棕参考点必须取在树冠中心（tree_info 树心 2 m 内）；
  参考点的类别也要用多个独立证据交叉确认后再采信。
