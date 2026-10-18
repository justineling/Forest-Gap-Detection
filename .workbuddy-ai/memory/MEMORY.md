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
- ⚠️ **残树口径（2026-10-17 重测，优先用这版）**：树心 **558 个**落在空地多边形内
  （占 15,190 个树心的 **3.7%**，其中 open_patch 490 个）；空地距树心 ≤2 m 面积 **2.1%**。
  此前"274 个多边形 / 228,838 m²"是按**多边形**计数且"含 1 个即算"的严口径（对大连片块偏严），
  **不要再用它对外表述**。探针：`probe_gaps_truth2.py`。

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

**验收基线**：`npm test`（191 项断言）· `cargo test`（14）·
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
15. **KML 的 `<coordinates>` 是三维的**（`lon,lat,alt`）→ 必须只取前两维，
    否则面积与 Terra Draw 静默算错；多多边形**取最大**（KML 常含图例框）。
16. **导出的网格参数必须来自磁盘上的算法结果**：前端 `planting_grid` 缺
    `origin_x_m/origin_y_m`，拿去构造 GridModel 会让放样点**整体平移**。
17. **"单文件自包含"自检不能搜 `"http://"`**：内联 SVG 的 `xmlns` 是命名空间
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
