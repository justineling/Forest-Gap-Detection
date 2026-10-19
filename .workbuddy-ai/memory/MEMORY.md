# Forest Gap Detection — 项目长期记忆

> 长期约定与关键结论。过程记录见同目录 `YYYY-MM-DD.md`；坑清单权威版在 `desktop/README.md`。
> 2026-10-19 精简重写（原 23 KB → 合并去重，删掉已完成待办）。

## 1. 项目定位
油棕种植园（**不是普通森林**）空地智能检测桌面应用。输入 KML 范围 + 正射影像，
输出全园需补种空地的矢量坐标图盘。Tauri v2（Rust + React）+ Python 算法 sidecar。

## 2. 工作区与运行环境（本机）
- 工作区：`D:/学习目标_笔记/2. 智/计算机/自学/9. 人工智能/项目类型/图像识别/Forest-Gap-Detection`
  （git 仓库，remote = github.com/justineling/Forest-Gap-Detection，main）
- ⚠️ 交接文档里的 `D:/Project/AI/Forest Gap Detection` 是**公司电脑**路径，本机不适用。
- Python：`.venv/Scripts/python.exe`，由 `scripts/配置环境.ps1`（或 `一键配置环境.bat`）生成。
  **禁止用系统 python**（无 numpy）。执行策略需 `-ExecutionPolicy Bypass`。
- 运行态资源（`.venv/`、`output/`、`models/` 权重）被 `.gitignore` 排除，**新克隆后需重建**。
  `.workbuddy-ai/` 自 7f7c1f8 起已入库；`output/arcgis/` 需重跑 `scripts/export_arcgis.py`。
- 大影像实际在用的是 `WGR17-002.tif`（旧名 `WGR17.tif`）：**4.66 GB**，47,130×44,686，EPSG:4326，
  3.3 cm/px，**4 波段**（第4恒 255=Alpha），**内嵌 6 级金字塔 [2,4,8,16,32,64]**（DJI 导出自带，
  不是本项目生成的）。同目录 `WGR17.tif.ovr`(1.08 GB) 是改名前的残留，对不上。
  园区占外接矩形 57%。
- **桌面端从不建金字塔**（`lib.rs` 起 `tile_server.py` 不传 `--build-overviews`，代码零命中）。
  无金字塔时不报错，只提示"低缩放级慢（z=13 约 104 s）"；手动 `--build-overviews` 默认
  生成**外置 .ovr**（不碰源文件），无 gdaladdo 时 auto 会**复制整份副本**到 `output/.tile-cache`
  （4.7 GB 影像 = 额外 4.7 GB 磁盘）；`--ovr-mode inplace` 才真改源文件且不可逆。

## 3. 核心实测数据（改算法前必读）
- 株距 8.35 m / 行距 7.23 m / 错行角 60°（三角形种植）/ 密度 165.6 株/公顷
- 建金字塔后 8.45/7.32 → **8.35/7.23 是变准了**（真实物理值）；跨影像版本须重立基线
- 分割判据 v3（定稿）：`阈值 = clip(ExG 的 40% 分位, 40, 80)`；`树冠 = (平滑ExG>阈值) 或 (饱和度>0.45)`
- 不可种植三类：
  - 道路/办公：「亮 L>170 + 低饱和 S<0.18」掩膜，靠 **fill ratio** 分界 ——
    **< 0.30 线状 = 道路**；**≥ 0.30 且面积 ≥ 400 m² = 办公区**（实测道路 0.013~0.211 / 办公 0.317~0.548，完全分离）
  - 水体：`B≥G>R` 或（暗 L<90 & ExG<15 & 纹理 std<6），过 **30 m² 最小连通域**
- **跨航带曝光差异极大**：ExG 中位 37~116（差 3 倍）→ 所有阈值必须对曝光鲁棒
- 纹理 std：株位空缺 8~15 / 连片空地 22~26 / 油棕 39~47 / 草地 46.3（草地与油棕**重叠**）
- 草地 vs 油棕光谱：草地 ExG 159 / S 0.64 vs 油棕 ExG 64~102 / S 0.37~0.53
  ——「立体的绿」被内部阴影打折，**ExG 过高反而不是树**
- 判别「油棕 vs 未开发林」用 **100 m 区块树心密度**（不用连通性，DSM 平滑会粘连树冠）：
  油棕 110~160 株/ha（P50=129）／未开发林 20~60 株/ha（中位 42）
- 非树区 **29% 是绿色植被**（「低矮植被」未实现）；`CHM≥12 m` 区粗糙度 0.604 ≈ 健康油棕 →
  高 CHM 是"伪影叠在真树上"。空地距树心 2 m 内仅 2.0%（基准 14.5%）。

### 定标方法（评估任何"网格对齐"改动时复用）
`tree_info` 树心在 **300 m 窗口**做「方位 0.5° × 相位 8×8」细扫，指标 = 树心落格点 **3 m 内**比例
（随机基准 **45.8%**）→ 实测最优 **59.0°、79~97%**。⚠️ 全幅细扫不可行（1,500 m 上 0.2° 就漂移 5 m）。
脚本 `tmp/analyze/probe_phase_local.py`。

## 4. 2026-10-17 四项修复（长期有效）
1. **网格方位角合成必须按格点对称阶数折叠**：等边三角形格点有 60° 旋转对称 → 按 **6θ（模 60°）**
   做圆统计。旧代码按 2θ → 把 21.2° 当结果（真值 59.0° ≡ −1.0°）。
   ⚠️ **禁止**"先 `angle % 60` 取算术中位数"（真值卡 0/60 边界时算出 30°）；还要剔除对偶轴离群块。
2. **水体：CHM 置 NaN 会把水面推向"非树"**（`canopy &= isfinite(chm)`）→ 并入 `seg==water`
   作第三证据（`water_use_segment` / `--no-water-segment`）。DJI 水塘覆盖 7.9% → 98.0%。
3. **「需补种」必须三档报**（否则虚胖 14%）：`grid_prior.PRIORITY_GROUPS` + `summarize_priority()`。
   确定 = open_patch + vacant_slot；review = uncertain；not_needed = alley_gap。
4. **桌面端必须与 CLI 同一条路**：`sidecar.run_pipeline` 调 `process_tile` 必须传
   `elevation`/`elev_params`（漏传=桌面端退化成纯 RGB）；`class_totals` 要全量初始化，
   否则 `if k in class_totals` 静默丢掉 road/water/office。

### 交付数字（2026-10-17，本机，**基线冻结**）
1,726 要素 / 8 类；**确定需补种 702 块 / 309,143 m²（13.49%）**；待复核 465 / 40,593；
不计入 251 / 13,277；道路 180/34,357、水体 21/9,711、办公 82/7,235、非种植区 25/20,412。
全量 1,048 s；契约测试 95/95。⚠️ 当前代码重跑会变 **727 块**——新旧数字**不能混用**，
702 vs 727 只能由 150 块真值验证集裁决（见 §7）。

## 5. 算法封版（Stage 14）与缺陷台账
算法转入维护冻结，重心移交桌面端。台账：`docs/03-算法教学/算法缺陷与桌面端协同看板.html`（+小白版）。
| # | 缺陷 | 量级 | 桌面端能否化解 |
|---|---|---|---|
| P0-1 | 高草 vs 幼龄油棕不可分 | 122,784 m² 绿色（中高 99,486） | 部分（人工删） |
| P0-2 | 51% 非树判定靠大疆域外分割 | 214,827 m²（有效区 16.7%） | **不能**（→ 验证集量化） |
| P1-3 | CHM 阈值泛化脆弱 | ±1 m ≈ ±30,400 m²（仅 5 点标定） | 可开滑块（已做林龄档位） |
| P1-4 | 单一网格原点对齐率 46% + 558 残树心 | 局部细扫 79~97% | 大幅缓解 |
| P1-5 | 未开发林掩膜阈值敏感 | 影响区间 4%~26% | **彻底消失**（人工复核） |
| P2-6 | 加宽硬化路口被标 office | 对需补种 0 影响 | 无感 |
| P2-7 | 单进程 1,048 s / DSM 尖峰 / 硬编码 / 死参数 | — | 部分（ROI 提速） |

解冻后顺序：① ROI 裁剪 → ② 补种点位 → ③ 多进程（已完成）→ ④ 清工程债 →
⑤ 残树挖孔 + 局域相位（须等验证集）→ ⑥ CHM 自适应 → ⑦ 轻量分割头 → ⑧ 低矮植被（需多时相）。

**三条对外表述红线**：① 前端是 React 18 + TS（不是 Vue 3），绘图用 Terra Draw（不是 Leaflet-Geoman）；
② 主链路是 stdio NDJSON sidecar，不是 FastAPI；**只有瓦片走 HTTP**；
③ 掩膜影响区间上界 **26%**（非 26.5%）；CHM 异常区块 **14.08~29.99 m**（非 17~30 m）。

**「南部」是未开发天然林/次生林**（用户核实）→ CHM 仅 2.32 m 是对的。但**别过度平反 DINOv2**：
同一次留一验证里真油棕（西北）也被判成草地 79.7% → 结论不变：**不采用 DINOv2**。
已实现 `build_forest_mask.py` → `apply_forest_mask.py` → `--forest-mask` → 新类别 `undeveloped`
（单独成层，不计需补种），`export_arcgis.py` 已扩到 8 层。

## 6. 桌面端（Tauri v2）
栈已冻结：React 18 + TS + Vite 5 + MapLibre GL 4 + Terra Draw + zustand（手写 CSS）。
Rust 外壳 + stdio NDJSON sidecar。**坑清单权威版：`desktop/README.md`（45 条 / 8 组，连续编号）**。

- **验收基线**：`npm test` 529 项断言 · `cargo test` 全绿 · 契约 95/95 · `cargo check`
- **打包**：`desktop_entry.py` 单入口 → PyInstaller onedir 179 MB → NSIS **67.7 MiB**，
  装到 `%LOCALAPPDATA%\Forest Gap Detection`；release 无控制台，排障看 `logs/app.log`。
  产物固定在 `desktop/src-tauri/target`（脚本会中和 `CARGO_TARGET_DIR`）。
- **打包三红线**：`freeze_support()` 是 `__main__` 第一行；**`PROJ_DATA` 优先 rasterio 的 proj_data**；
  `[profile.release]` 用 `codegen-units=4` + `lto="thin"`（极限配置让 rustc 0xc0000005 崩）。
- **最致命的 5 条**（其余见 README）：
  1. `output/*.geojson` 是 `blocks[].gaps` 结构、**无顶层 features** → 按 features 读会静默空数组。
  2. **结果路径不能写死文件名**：只能"扫目录 + 名含 gaps + 按 mtime 取最新"；打包态 `ROOT`
     指向 `py-runtime/desktop_entry/`（无 output/）→ 候选目录**必须含 `cwd/output`**；
     缓存按 `(path, mtime_ns, size)` 失效；`/gaps` 空时**绝不能 applyRerun([])**。
  3. **检测前必须预检**（`preflight_detect`/`preflight_core`）：chm/segment/掩膜缺了 sidecar
     **不报错只回 W1004 照常跑完**；`warn` 事件必须有处理分支（W1001/W1004/W3001 都是"算偏不报错"）。
     掩膜按 `output/forest-mask*.geojson` 前缀自动发现，别写死。
  4. **Tauri ↔ sidecar 必须两个线程分别读 stdout/stderr**（64 KB 管道填满 → 永久死锁且无报错）。
  5. **撤销栈**：快照 = `gaps.slice()`（结构共享 14 KB/步，上限 40）；批量只压 1 步；
     ⚠️ TerraDraw 拖拽每几像素发 change → **必须 1.5 s 时间窗合并**。框选必须传 `visibleClasses`
     （否则一次批量删除静默抹掉 180 条道路），不用 `queryRenderedFeatures`。
- **UI 五步工作流**（`lib/workflow.ts` + `StepRail` + `NextStepCard` + `MoreMenu`）：
  header 只留 品牌/进度/影像灯/↶↷/⋯。三处语义必须分开：**「可选」≠「不阻塞」**、
  **「当前有要素」≠「载入过结果」**（`hasGaps` vs `hasResult`）、**`reviewed` 纳入 `exported`**。
- **界面可直接生成 CHM/掩膜**（`build_derived.py` + `--build-derived` + `DerivedDialog`，约 42 s）：
  薄包装不改算法；`_StdoutGuard` 把非 JSON 输出转 stderr；`tree_info.json` 是 build_forest_mask
  的**必需**输入；生成**不可取消**；与检测**双向互锁**；生成完必须重跑检测。
- 其它：KML `<coordinates>` 是三维的（只取前两维，多多边形取最大）；导出网格参数必须来自磁盘
  结果（前端 `planting_grid` 缺 `origin_x_m/origin_y_m` → 放样点整体平移）；选结果文件要区分
  「用户指定时刻」与「文件 mtime」（串批次会块数对、点位全偏）；CHM 林龄档位（成熟 5.2/1.2、
  中龄 3.5/0.8、幼龄 2.2/0.5）互锁 `0.2 ≤ veto ≤ core−0.5` 前端与 Rust 都拦，两参数在指纹里。

## 7. 验证集（Q1 / P0-2，2026-10-19）
- `desktop/src/lib/validation.ts`：三层分层抽样 **150 块**（Neyman），配额
  L1_top_area 40 / L2_uncertain 60 / L3_plantable 25 / L3_alley 15 / L3_unplantable 10；
  mulberry32 确定性 PRNG（seed=42）。
- **Horvitz-Thompson 逆概率权重** `Σ(wᵢ·correctᵢ)/Σ(wᵢ)`；★ **自检一眼法：`Σwᵢ` 必须精确等于全园
  1,726.0**（权重算错时这个和不成立）。
- `scripts/eval_validation.py`：三档准确率（样本 / 全园无偏 / 面积加权）+ 混淆矩阵 + 分层表 +
  可补种 precision/recall；多结果对比时 <2pp 视为不可区分；`--selftest` 13 项。
- ⚠️ **`uncertain` 不允许"确认"**：第一版 `Space` 在 L2 上直接存成"存疑"，60 块里 51 块无信息，
  该层贡献归零。已加 `canConfirm(cls)` 拦，`Space` 提示"请按 1/2/3 选真值"。
- ⚠️ `initValidation` 的 effect deps 必须含 `validation.scope` / `samples.length`，
  否则 StrictMode 双跑复用旧闭包 → **重新抽样、抹掉进度**（UI 显示 0 行）。
- 真值 ≠ 复核：GT 记录单独存 localStorage，与复核结果分离；快捷键 4 条护栏在 `lib/hotkeys.ts`。

## 8. 可复现性 / 静态检查（踩过的坑）
- **「可复现」的准确表述**：同影像 + 同参数（**含 workers 1 vs 6**）→ by_class 逐位一致
  （2026-10-19 全量 528 瓦片 × 2 次实测）；但**网格参数变了 → 类别归属会变**
  （8.45/7.3179 → 8.35/7.2313 使 open_patch +15 / vacant_slot +10 / uncertain −26，总数仍 1,726）。
  "1,726 / 1,762 / 1,751" 的差异来自**输入不同**，不是随机性。
- **ruff `F821/F823/E9` 抓不到 possibly-unbound**（只抓完全未定义的名字 + 语法错）→
  补一层**每个 CLI 跑 `--help`**（2 s / 9 个脚本）。它抓到 `process_image.py --help` 崩的真 bug
  （help 里裸 `7.9%` → argparse %-格式化）。
- **HTML 里写 Markdown `**加粗**` 会显示字面星号** —— 这个错犯过三次。已有 `scripts/check_docs.py`
  （自包含 / 无 Markdown 残留 / 标签平衡）。⚠️ 检查前必须**逐个剥离 `<code>`/`<pre>`/`span.code`**
  （`**/*` 是合法 glob；带 `\1` 反向引用的非贪婪会跨过相邻 `</span>`）。
- **"单文件自包含"不能搜 `"http://"`**（内联 SVG 的 `xmlns` 是命名空间）：查 `<link href>` /
  `<script src>` / `<img src>` / `@import` / `url(`。
- **`check_all.py` 9 层**（tsc / npm test / ruff / CLI `--help` / cargo test / test_stale /
  eval_validation selftest / check_docs / 契约）：快跑 21 s，全跑 73~83 s。
  Windows 下 `npx`/`npm` 要用 `shutil.which()` 解析（不能 `shell=True`，路径含 "2. 智"）。

## 9. 性能（2026-10-17）
- 单瓦片 ~2 s（2304² 含 128px 外扩）；全量 528 瓦片 **1,048 s** → `--workers 6` **350 s**；
  ROI 121 瓦片 462 → 195 s（4 workers）。
- **教训1**：连通域统计别逐域 `lab == i` / `comp.sum()`，改 `np.bincount(lab.ravel())` 一次算完
  + 只在各 bbox 内取局部数组（43 s/瓦片 → 3 s/瓦片，等价性逐像素验证）。
- **教训2**：栅格层 `min_area` 粗筛是**负优化**（1336 s→2400 s）——绝大多数连通域本就 > 30 m²。
- `--workers` 四条护栏：tile_idx 排序 / initializer 句柄 / 锁 BLAS+GDAL 线程 / 子进程不写 stdout；
  **workers 不进指纹**；瓦片 < max(4, workers*2) 退回串行。

## 10. 红线与硬约定（违反会返工）
- **Git**：绝不自动 commit，必须用户明确同意。提交前先 `git reset` 清暂存再按路径 `git add`。
  核实远端真实状态用 `git ls-remote`。提交信息中文 + Conventional Commits。
  合并用 `--no-ff`。⚠️ **跨分支合并必然在日志/记忆文件冲突**（纯追加）→ **保留双方 + 章节重编号**，
  不要 `-X ours/theirs`（静默丢内容）。
- **文档**：HTML 必须同时出「专业版 + `-小白版`」；中文目录/文件名；含图 HTML 一律内联 base64
  或手写内联 SVG，**禁用相对路径**。给**历史决策文档**纠错时**不改正文** → 顶部阅读提示 +
  文末「后记」逐条对照"当时判断 vs 实际落地"。桌面端文档在 `docs/08-桌面端/`。
- **代码**：标识符纯 ASCII，中文只在注释/显示字符串；`sidecar.py` 的 **stdout 是 NDJSON 数据通道**，
  禁止 print 污染，人类日志走 stderr。
- **测试**：`scripts/test_sidecar_contract.py` 期望 **95/95**（约 1 分钟，合成影像）。
- PowerShell 5.1 读 `.ps1` 必须有 UTF-8 BOM；三个 bat 在**项目根**（UTF-8 无 BOM + CRLF）。
  别手删安装目录（NSIS 会弹 "Unable to install"）。
- docgen 教训：`gen_gdrive.py` 曾硬编码 `D:/WGR` → 探不到就把体积写成 `0 KB`，**静默改错文档**。
- 组件抛错会卸载整棵 React 树 → 白屏；Terra Draw `start()` 必须在 `map.on('load')` 内 + ErrorBoundary。

## 11. 待办
- ⏳ **真实 150 块打标**（用户亲自做）→ 才能裁决 702 vs 727、才能解锁 ⑤⑥⑦⑧
- ⏳ `active_learning.py` 仍未跑过
- ⏳ 安装包签名
