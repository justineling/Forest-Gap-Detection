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

## ★ 2026-10-16 算法评审：可复用的定标方法

> 方位角合成缺陷、水体漏检机制、三档报数的**修复**见下一节（10-17 四项修复）；
> 这里只留方法与被反复引用的实测数字。

### 定标方法（可复用，评估任何"网格对齐"改动时用）
`tree_info` 树心在 **300 m 窗口**做「方位 0.5° × 相位 8×8」细扫，指标 = 树心落在
格点 **3 m 内**的比例（随机基准 **45.8%**）→ 实测最优 **59.0°、对齐率 79~97%**。
⚠️ 全幅细扫不可行（1,500 m 跨度上 0.2° 就漂移 5 m）。脚本 `tmp/analyze/probe_phase_local.py`。

### 被反复引用的量级
- 「非树」判定 **51%（214,827 m²）完全靠语义分割**；CHM 阈值 ±1 m ≈ ±3.0 万 m²（仅 5 点标定）。
- 独立验证：空地距树心 2 m 内仅 **2.0%**（基准 14.5%）；`CHM≥12 m` 区粗糙度 0.604 ≈ 健康油棕
  → 高 CHM 是"伪影叠在真树上"。
- 非树区 **29% 是绿色植被**（「低矮植被」未实现）；亮白判据缝隙 2,925 m² / 107 块（水塘旁泵房）。
- 跨航带曝光差异极大：ExG 中位 37~116（差 3 倍）→ 所有阈值必须对曝光鲁棒。
- 纹理 std 分档：株位空缺 8~15 / 连片空地 22~26 / 油棕 39~47 / 草地 46.3（草地与油棕重叠）。
- 草地 vs 油棕光谱：草地 ExG 159 / S 0.64 vs 油棕 ExG 64~102 / S 0.37~0.53
  ——「立体的绿」被内部阴影打折，**ExG 过高反而不是树**。

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

## ★ 2026-10-17 算法封版（Stage 14）与缺陷台账

**决策**：算法转入维护冻结（Stage 14 基线），开发重心移交 Tauri 桌面端；
剩余缺陷归档，解冻后再修。**台账**：
`docs/03-算法教学/算法缺陷与桌面端协同看板.html`（+ 小白版，双版本）。

**剩余 7 项缺陷**（每项在台账里都有实测量级 + 探针出处 + 桌面端能否化解 + 解冻后方向）：

| # | 缺陷 | 量级 | 桌面端能否化解 |
|---|---|---|---|
| P0-1 | 高草 vs 幼龄油棕不可分 | 122,784 m² 绿色（其中中高 99,486） | 部分（人工删） |
| P0-2 | 51% 非树判定靠大疆域外分割 | 214,827 m²（有效区 16.7%） | **不能** |
| P1-3 | CHM 阈值泛化脆弱 | ±1 m ≈ ±30,400 m²（仅 5 点标定） | 可开滑块 |
| P1-4 | 全图单一网格原点对齐率 46% + 558 个残树心 | 局部细扫可达 79~97% | 大幅缓解 |
| P1-5 | 未开发林掩膜阈值敏感 | 影响区间 4%~26% | **彻底消失** |
| P2-6 | 加宽硬化路口被标 office | 对需补种 0 影响 | 无感 |
| P2-7 | 单进程 1,048 s / DSM 尖峰 / 硬编码 / 死参数 | — | 部分（ROI 提速） |

**解冻后的修复顺序**：① ROI 圈选裁剪 → ② 补种点位生成 → ③ 多进程跑批 →
④ 清理工程债 → ⑤ 残树挖孔 + 局域网格相位 →（须等标注验证集）⑥ CHM 自适应阈值 →
⑦ 本地轻量分割头 → ⑧「低矮植被/幼树」类别（单期影像做不到，需多时相）。

**三条对外表述红线（易被外部方案带偏）**：
1. 前端是 **React 18 + TS**，不是 Vue 3；绘图用 **Terra Draw**（不是 Leaflet-Geoman）。
2. 算法主链路是 **stdio NDJSON sidecar**，不是 FastAPI HTTP 微服务；**只有瓦片走 HTTP**。
3. 掩膜影响区间上界 **26%**（非 26.5%）；CHM 异常区块 **14.08~29.99 m**（非 17~30 m）。
## ★ 桌面端（Tauri v2，2026-10-17 完成于 `feat/desktop-app`）

技术栈已冻结：React 18 + TS + Vite 5 + MapLibre GL 4 + Terra Draw + zustand（手写 CSS），
Rust 外壳 + **stdio NDJSON sidecar**（只有瓦片走 HTTP）。细节与 24 条坑见 `desktop/README.md`。

**验收基线**：`npm test`（445 项断言）· `cargo test`（32）·
契约测试 95/95 · `cargo check`。
**打包**：`desktop_entry.py` 单入口 → PyInstaller 179 MB → NSIS **67.7 MiB**，装到
`%LOCALAPPDATA%\Forest Gap Detection`；release 无控制台，排障看 `%LOCALAPPDATA%\fgd\logs\app.log`。
产物固定在项目内 `desktop/src-tauri/target`（脚本会中和 `CARGO_TARGET_DIR`）。

**必须记住的 8 条**

1. `output/*.geojson` 是 `blocks[].gaps` 结构、**没有顶层 features** → 前端按 features 读会静默空数组。
2. **点位必须基于 `wgr17-final-gaps.geojson`**；`-elev-gaps` 多算 221 个点（把未开发林当可补种）。
3. 前后端株数已对齐 0.00%（3,691）：`/gaps` 响应动态补 `planting_grid.anchor_lon/lat`。
4. 退让 **0.5 m 是业务拍板**（2 m 会让 123 块单行缺株带排不出点），依据在 `lib/estimate.ts`。
5. **Tauri ↔ sidecar 必须两个线程分别读 stdout/stderr**（64 KB 管道填满 → 永久死锁且无报错）；
   参数名逐字对齐 `chm_path`/`segment_path`/`target_density_per_ha`（写错只回 W1001 照常跑完）。
6. `--workers` 四条护栏（tile_idx 排序 / initializer 句柄 / 锁 BLAS+GDAL 线程 / 子进程不写 stdout）；
   **workers 不进指纹**；瓦片 < max(4, workers*2) 自动退回串行。
7. 打包三红线：`freeze_support()` 是 `__main__` 第一行；**`PROJ_DATA` 优先 rasterio 的 proj_data**
   （rasterio MINOR=5 / pyproj MINOR=4，反了则冻结态 `CRS.from_epsg` 全崩）；
   `[profile.release]` 用 `codegen-units=4` + `lto="thin"`（极限配置会让 rustc 0xc0000005 崩）。
8. **dev 与 bundled 的数据基准必须分开**（`data_base()`），否则开发态明明有影像却弹"请选择影像"。
9. **检测前必须预检**（`preflight_detect` / `preflight_core`）：chm / segment / 森林掩膜
   缺了 sidecar **不报错只回 W1004 就照常跑完** → 结果退化成纯 RGB 或含未开发林。
   ⚠️ `forest_mask_path` 曾经**从来没传过**（多 221 个放样点）；掩膜按
   `output/forest-mask*.geojson` 前缀自动发现，**别写死文件名**。
10. **`warn` 事件必须有处理分支**：W1001 / W1004 / W3001 都是"会算偏但不会报错"，
    漏处理 = 用户完全看不到。进度合并用 `??` 不用 `||`（`done=0` 是合法值）。
11. **可选出现的条带别用固定行数 grid**：`.app` 改 `flex column` + `body{flex:1}`，
    否则孩子数变化时 `1fr` 会给错元素（地图区被压成内容高度）。
12. **撤销栈**：快照 = `gaps.slice()`（要素不可变 → 结构共享，14 KB/步），上限 40；
    **批量操作只压 1 步**；新操作清空 redo；`setGaps` 清空历史。
    ⚠️ **TerraDraw 拖拽每几像素发一次 change** → 必须 1.5 s 时间窗合并，
    否则拖一次就把栈吃光（按 Ctrl+Z 只看到边界一点点回退）。
13. **框选必须传 `visibleClasses`**（`selectGapsInBox`）：默认只勾选「确定需补种」，
    隐藏的 road/water 若被框选中，一次批量删除会静默抹掉 180 条道路。
    不用 `queryRenderedFeatures`（随缩放变 / 测不到 / 不分类别）；
    进框选模式要 disable `dragPan` + `boxZoom`（Shift+拖拽默认是拉框放大）。
14. **快捷键要先判断焦点**：INPUT/TEXTAREA/SELECT/contenteditable 里一律让位。
15. **UI 是五步工作流**（`lib/workflow.ts` 状态机 + `StepRail` + `NextStepCard` +
    `MoreMenu`）：header 只留 品牌 / 进度条 / 影像灯 / ↶ ↷ / ⋯，高频动作全在右下角卡片。
    ⚠️ 三处语义必须分开：**「可选」≠「不阻塞」**（② 范围不阻塞、④ 复核阻塞但可一键跳过）、
    **「当前有要素」≠「载入过结果」**（`hasGaps` vs `hasResult`，删光后流程会倒退）、
    **`reviewed` 要纳入 `exported`**（从菜单直接导出后不该再提示去复核）。
16. **KML 的 `<coordinates>` 是三维的**（`lon,lat,alt`）→ 必须只取前两维，
    否则面积与 Terra Draw 静默算错；多多边形**取最大**（KML 常含图例框）。
17. **导出的网格参数必须来自磁盘上的算法结果**：前端 `planting_grid` 缺
    `origin_x_m/origin_y_m`，拿去构造 GridModel 会让放样点**整体平移**。
18. **结果文件路径不能写死文件名**：产物名由 `job` 决定（`{job}-gaps.geojson`），
    而 job 是契约 → 只能"扫目录 + 名字含 gaps + 按 mtime 取最新"。
    ⚠️ 打包态 `ROOT` 指向 `py-runtime/desktop_entry/`（没有 output/）→
    候选目录**必须含 `cwd/output`**（打包时 cwd=数据根）；
    缓存必须按 `(path, mtime_ns, size)` 失效，否则"检测完看不到新结果"。
    ⚠️ `/gaps` 返回空时**绝不能 applyRerun([])**（会把现有结果清空）；
    要区分"算法自报 0 块"（可清空）与"没收到报告"（必须保留）。
19. **选结果文件要区分「用户指定时刻」与「文件 mtime」**：`/export` 的要素来自前端 POST，
    但 `planting_grid` 来自"当前生效文件" → 串批次时**块数完全正确、点位全偏**
    （3,691→3,656，首点也漂），用户看不出来。修法是启动时记 `time_ns()`，
    只有比它新产生的文件才允许接管显式路径（既保住"检测完自动刷新"，又不让历史残留抢占）。
    ⚠️ `gaps_search_dirs()` 永远含 `ROOT/output`：仓库有 20 个 `*gaps*.geojson` 残留，
    **拿仓库根当 cwd 验收会看到 12 块而不是 1,726 块** → 验收必须用干净数据根。
20. **界面可直接生成 CHM/掩膜**（`build_derived.py` + `--build-derived` +
    `derive_core`/`run_build_derived` + `DerivedDialog`）：换园区必做，约 42 秒。
    ① **薄包装不改算法**：替换模块级 `log()` 把 print 变 NDJSON 事件
    ② `_StdoutGuard` 把非 JSON 输出转 stderr（GDAL 会往 stdout 打警告）
    ③ `tree_info.json` 是 build_forest_mask 的**必需**输入（无回退）→ 缺了只出 CHM
    ④ 生成**不可取消**（半个 CHM 比没有更糟，检测读到不报错）；
    与检测**双向互锁**（都写 output/）
    ⑤ 生成完必须重跑检测，否则新 CHM + 旧结果口径不一致
21. **分组编号的清单追加内容时先看真实最大号**：`desktop/README.md` 的坑
    分 7 组、**每组从 1 重新编号**。我误以为上一条是 40（实际 37），
    从 41 开始写 → 38~40 断层。正确做法：
    `grep -oE "^[0-9]+\." desktop/README.md | tail -1`。
    引用时应该说"58 条 / 7 组"，不要说"第 43 条"（组内才有意义）。
22. **「可复现」的准确表述**：同影像 + 同参数（**含 workers 1 vs 6**）→ by_class 逐位一致
    （2026-10-19 全量 528 瓦片 × 2 次实测）；但**网格参数变了 → 类别归属会变**
    （8.45/7.3179 → 8.35/7.2313 会让 open_patch +15 / vacant_slot +10 / uncertain −26，
    总数仍 1,726）。所以"1,726 / 1,762 / 1,751"那些差异来自**输入不同**，不是随机性。
    ⚠️ 当前代码重跑会把「确定需补种」从 702 块变成 727 块（新旧数字不能混用）。
23. **ruff 抓不到 possibly-unbound**：`F821/F823/E9` 只能抓"完全未定义的名字"和语法错误；
    "条件分支赋值、另一分支使用"（如 `mask_skip`）需要 mypy/pyright。
    补一层**每个 CLI 跑 `--help`**（2 秒 / 9 个脚本）—— 它抓到了
    `process_image.py --help` 崩溃的真 bug（help 里裸 `7.9%` → argparse %-格式化）。
24. **HTML 里写 Markdown `**加粗**` 会显示成字面星号** —— 这个错犯了三次。
    已加 `scripts/check_docs.py`（单文件自包含 / 无 Markdown 残留 / 标签平衡）。
    ⚠️ 检查前必须**剥离 `<code>`/`<pre>`/`span.code`** —— `**/*` 是 glob 通配符合法；
    组合正则带 `\1` 反向引用时非贪婪会跨过相邻 `</span>`，要**逐个标签剥离**。
25. **"单文件自包含"自检不能搜 `"http://"`**：内联 SVG 的 `xmlns` 是命名空间
    标识符；要查 `<link href>` / `<script src>` / `<img src>` / `@import` / `url(`。

**其它要点**

- 建金字塔后网格 8.45/7.32 → **8.35/7.23 是变准了**（真实物理株行距）；跨影像版本须重立基线。
- 重跑合并 `lib/mergeEdits.ts`：`keep_manual`/`overwrite`；质心落入 + 外接框 IoU 兜底；
  删除优先；`replayed_from` 留痕；store 的 `deletedFeatures` **存几何**。
- 组件抛错会卸载整棵 React 树 → 白屏；Terra Draw `start()` 必须在 `map.on('load')` 内 + ErrorBoundary。
- 影像 **4 波段**（第 4 恒 255=Alpha）；`Window.intersection` 无交集时**抛错**不是返回空。
- **CHM 林龄档位**（P1-3 化解）：成熟林 5.2/1.2（基线）/ 中龄林 3.5/0.8 / 幼龄林 2.2/0.5，
  按「大疆 DSM 低估约 40%」折算；互锁 `0.2 ≤ veto ≤ core−0.5` **前端与 Rust 都拦**
  （区间反转是静默的）；两参数在参数指纹里 → 换档 = 瓦片缓存全失效 = 重跑。
- 三个 bat 在**项目根**：UTF-8 无 BOM + CRLF；`call 文件.bat 标签` 靠 shift+goto 分发、顶层不能
  `setlocal`；搬家自愈只对项目内 target 生效。⚠️ 别手删安装目录（NSIS 会弹 "Unable to install"）。
- docgen 教训：`gen_gdrive.py` 曾硬编码 `D:/WGR` → 探不到就把体积写成 `0 KB`，**静默改错文档**。

## 4. 红线与硬约定（违反会返工）
- **Git**：绝不自动 commit，必须用户明确同意。提交前先 `git reset` 清空暂存区再按路径 `git add`
  （防 `git stash pop` 恢复的 staged 文件被误卷进提交）。核实远端真实状态用 `git ls-remote`。
  提交信息中文 + Conventional Commits 前缀。合并用 `--no-ff`（保留特性分支边界）。
  ⚠️ **跨分支合并必然在日志/记忆文件上冲突**（纯追加结构）→ 解法是**保留双方 + 章节重编号**，
  不要用 `-X ours/theirs`（会静默丢内容）。
- **文档**：HTML 报告必须同时出「专业版 `<主题>.html` + 小白版 `<主题>-小白版.html`」；
  中文目录/文件名；**含图 HTML 一律把图片内联为 base64 或手写内联 SVG，禁用相对路径**。
  给**历史决策文档**纠错时**不改正文**（会抹掉决策过程）→ 顶部加阅读提示 + 文末加「后记」
  逐条对照"当时判断 vs 实际落地"。桌面端文档在 `docs/08-桌面端/`。
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
## ★ 更正：「油棕-南部」其实是「未开发森林-南部」（2026-10-16 用户核实）

南部（col=30000, row=40000 一带）**是未开发天然林/次生林**。据此：
DINOv2 判它非油棕**是对的**、CHM 仅 2.32 m **也是对的**。
⚠️ 但**不要过度平反 DINOv2** —— 同一次留一验证里真油棕（西北）也被判成草地 79.7%，
它不是可靠的油棕/草地判别器。结论不变：**不采用 DINOv2**。

**判别用「100 m 区块树心密度」，不用连通性**（DSM 平滑会粘连树冠）：
油棕种植区 **110~160 株/ha**（P50=129）／未开发林 **20~60 株/ha**（中位 42）。

**已实现**：`build_forest_mask.py` → `apply_forest_mask.py` → `--forest-mask` →
新类别 `undeveloped`（单独成层，不计入需补种），`export_arcgis.py` 已扩到 8 层。
⚠️ 自动掩膜**对阈值极敏感**（原始<70 → 影响 16.8%；平滑σ1.5<90 → 20.3%）→ **必须人工复核边界**。
（更完整的缺陷台账见 `docs/03-算法教学/算法缺陷与桌面端协同看板.html`）
