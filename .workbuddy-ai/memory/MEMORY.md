# Forest Gap Detection — 项目长期记忆

> 2026-11-15 精简重写（17.3 KB → 本版）。逐日过程见同目录 `YYYY-MM-DD.md`；
> 桌面端坑清单权威版 `desktop/README.md`（45 条 + 后续 63~70）。

## 1. 定位
油棕种植园（**不是普通森林**）空地智能检测桌面应用。KML 范围 + 正射影像 → 全园需补种空地矢量盘。
Tauri v2（Rust + React）+ Python 算法 sidecar。**对外红线**：React18+TS（非 Vue3）、
Terra Draw（非 Leaflet-Geoman）、stdio NDJSON（非 FastAPI，只有瓦片走 HTTP）、
掩膜影响上界 26%、CHM 异常区块 14.08~29.99 m。

## 2. 工作区与运行
- 当前工作区 `D:/学习目标_笔记/.../Forest-Gap-Detection`；另有 `D:/Project/AI/Forest Gap Detection`
  （同仓库，remote = github.com/justineling/Forest-Gap-Detection，main）。两边都备查。
- Python 必须 `.venv/Scripts/python.exe`（系统 python 无 numpy）；PS 用 `-ExecutionPolicy Bypass`。
- `.venv` / `output/` / `models/` 被 gitignore，新克隆要重建；`.workbuddy-ai/` 已入库。
- 大影像 `drone data/WGR17-002.tif`：47,130×44,686、EPSG:4326、3.3 cm/px、4 波段（第4恒 255）。
  10-17 手动 `--build-overviews` 后 4.66 GB（写进文件内部，不可逆）。

## 3. 核心实测数据（改算法前必读）
- 株距 8.35 / 行距 7.23 m / 60° 三角形 / 165.6 株每公顷。跨影像版本须重立基线。
- 分割 v3：阈值 = clip(ExG 40% 分位, 40, 80)；树冠 = (平滑ExG>阈值) 或 (饱和度>0.45)。
- 道路/办公：亮 L>170 + S<0.18 掩膜；fill ratio <0.30=道路，≥0.30 且 ≥400 m²=办公。
  水体：B≥G>R 或 (L<90 & ExG<15 & std<6)，过 30 m² 连通域。
- 跨航带 ExG 中位 37~116（差 3 倍）→ 阈值必须曝光鲁棒。草地 ExG 159/S 0.64 vs 油棕 64~102/0.37~0.53
  —— **ExG 过高反而不是树**。
- 油棕 vs 未开发林（南部天然林，CHM 2.32 m 是对的）：100 m 区块树心密度 110~160 vs 20~60 株/ha。
  **不采用 DINOv2**。
- 定标：300 m 窗口「方位 0.5°×相位 8×8」细扫，树心落格点 3 m 内比例（随机 45.8%）→ 59.0°、79~97%。
  脚本 `tmp/analyze/probe_phase_local.py`。

## 4. 算法关键修复（长期有效）
1. 网格方位角按 **6θ（模 60°）** 圆统计（等边三角 60° 旋转对称）；禁止取算术中位数。
2. 水体并入 `seg==water` 作第三证据（CHM 置 NaN 会把水面推向"非树"）。
3. 需补种三档报（确定/review/not_needed），否则虚胖 14%。
4. 桌面端与 CLI 同路：`run_pipeline` 必须传 `elevation`/`elev_params`；`class_totals` 全量初始化。
5. **网格 = CHM 树冠顶点周期图**（`grid_from_chm`）+ 每块空地局部相位；只认落在**本次影像** UTM
   范围内的顶点（R14），剩余 < `CHM_GRID_MIN_TOPS=200` 退回 RGB 勘察。
6. **去重阈值 = `min(1.05R, 0.95·min(a,b,c))`**（R3a），格点三角形外接圆 R=abc/(2·pitch·row)；
   本园 5.123 m（0.606×株距）。同优先级内 `vacant_slot` 优先于 `open_patch`/`manual_add`。
   旧 `0.5×株距` 挡不住"落在三角形中心"的点（最坏 112 点 vs 56）。
7. **R13 分单元相位**：单圆求相位失败的大空地，按世界坐标 **80 m 整数倍**切单元
   （`grid_prior.LATTICE_CELL_M` 唯一真值），单元中心 `40√2+40` m 内顶点单独求相位，
   门槛 `max(0.2, sqrt(ln(1/α)/(2N)))`（α=1%，R2 落地后复用）。新增 `lattice_cells` +
   `lattice_phase="cells"`；**分类仍用单一网格**（离质心最近可信单元原点），只有放样点按单元分相位。
   `fill_cell_nearests` 必须**两阶段**（先汇总全部 own 池再补 nearest），否则要素顺序依赖会让两种切法不一致。

## 5. 交付基线（数字随算法变，**新旧不可混用**）
- 10-17 冻结（旧算法）：1,726 要素 / 8 类；确定需补种 702 块 / 309,143 m²。
- 11-04 修跨瓦片重复计数（P0，旧 702 里 18% 是相邻瓦片各算一遍）→ 451 块 / 261,710 m²。
  做法：瓦片只留 core 内几何（经纬度下 `clip_by_rect`，缝两侧顶点完全相等）→ `stitch_seams`
  全局缝合 → 完整几何重分类；林地掩膜**沿掩膜切开**；CLI 与 sidecar 共用 `finalize_features`。
- 11-05 第四轮（不钉网格）：597 块 / 268,820 m²；对称差 4.17% → 0.40%；P50 3.32 → 1.16 m。
- **11-14 第五轮 R13 后（当前最新）**：确定需补种 **602 块 / 269,279 m²**（1536 切法 599 / 268,519）；
  放样点 **3,369**（1536: 3,365）；**全幅 P50 0.54 m / 1 m 内 76.9%**；2 m 内有树心 4.4%；
  `cells` 空地 26 块 P50 0.59 m / 74.0%，`local` 994 块行为未动（0.50 m / 81.0%）；
  空地并集 302,841、对称差 1,212 m² (0.40%)、∩不可种植 0、重叠对 0、跨缝矛盾 0、失败瓦片 0。
- ⚠️ `output/wgr17-final-gaps.geojson` 仍是**旧算法**产物，正式交付待重跑 + 重抽验证集。
- 评估脚本在 `desktop/tmp/ab/`：`run_final.sh`（A/B，瓦片缓存命中时 52 s）/ `eval_phase.py` /
  `eval_grid.py` / `eval_class.py` / `metrics.py` / `inv.py`。
- 验证集（10-19）：150 块 Neyman 分层 + H-T 权重（**Σwᵢ 必须精确 = 1726.0**）；
  `scripts/eval_validation.py --selftest` 13 项；`uncertain` 不允许"确认"。

## 6. 桌面端（Tauri v2）
**栈**：React 18 + TS + Vite 5 + MapLibre GL 4 + Terra Draw + zustand（手写 CSS）。
**视觉 = Ark UI 工业信息系统**（depth=3，分支 `feat/ui-ark-v2`）：CSS 分两层 —— `styles.css` 管布局、
`ark.css` 管语法（**必须后 import，顺序反了静默失效**）；圆角全 0；类别色只以 3px 竖条出现
（唯一来源 `lib/classes.ts` 的 CLASS_STYLES）。
⚠️ 改视觉只改 ark.css；布局层写 `display` 会被 ark.css 覆盖（要写进设计层）；
日志折叠禁用 `display:none`（innerText 会丢 → verify_render 假红），用 `max-height` 裁；
MapLibre 不监听容器 resize，高度变化必须 `ResizeObserver → map.resize()`；
每行独立 grid 的 `auto` 列宽逐行不同，面积列必须定宽；
`DetectBar` 组件**没删**（搬进命令条槽位）——verify_render 8 条断言 + React #310 回归网挂在它的类名上。
平行方案 `feat/ui-rhine-lab`（Rhine Lab 纸感）未合并。

**致命 5 条**：① `output/*.geojson` 是 `blocks[].gaps` 结构、无顶层 features；② 结果路径只按
"扫目录+名含 gaps+mtime 取最新"，候选目录必须含 `cwd/output`，`/gaps` 空时绝不能 `applyRerun([])`；
③ 检测前必须预检（W1001/W1004/W3001 都是"算偏不报错"）；④ Tauri↔sidecar 两线程分读
stdout/stderr（64 KB 管道填满→死锁）；⑤ 撤销栈 1.5 s 时间窗合并 TerraDraw change，框选必须传 `visibleClasses`。
**第 6 条**（10-20 交付事故）：**8765 有人监听 ≠ 我们的服务在跑** —— 复用前必须验 `/meta` 的 `app` 字段；
子进程 stderr 必须落 `app.log`（release 无 console，`eprintln!` 是黑洞）+ `try_wait` 记退出码。

**高度图归属**（10-24）：`build_chm.py` 写完 tif 补 `<同名>.json`（`schema: fgd-chm/1`）；
Rust 侧 `chm_owner_at`/`usable_chm`/`job_slot_is_free`/预检四处读它。⚠️ 文件名规则两边一致
（Py `with_suffix(".json")` = Rust `with_extension("json")`）。⚠️ **没有元数据 → 照用**（判不出就不拦）。
**取消必须是无操作**：向导 ×/Esc/遮罩=取消，弹窗 ×/Esc/遮罩=继续；打开向导/弹窗**不许预清状态**。
续跑弹窗渲染条件 `resumeAsk && !wizard`。语义表 `docs/08-桌面端/五步流转与弹窗语义.md`。
**多区块**：`list_blocks`/`switch_block` + `BlockSwitcher`；提示走 `AppStatus.notices`
（后端 `current_notices()` **不清空**，前端 `seenNotices` 去重）—— 清了会丢消息。
单实例用 `windows-sys` 的 `CreateMutexW`（需 **`Win32_Security`** feature），不用 tauri 插件。
**端口**（坑 48）：`pick_backend_port()` 试 8765~8776；前端 `backend.ts` 的 `ensurePort()`/`backendUrl()` 跟随。
**几何/持久化**（坑 63~68）：经纬度乘法累加先减局部原点；外环/洞按环序不按绕向；质心≠面内点
（`insidePoint` 与 Python `_slot_point` 同规则）；重跑合并强判据要 ≥50% 面内采样点落入；
`HistoryEntry` 必须带 `baseGaps/baseSig/draftRestored`**（R4 起还要带 `plantingGrid`）**；
导出过期用 `editRev` 发号器 + `exportSnap` → `exportStaleReason` → 第 ⑤ 步「需重导」。
**R4 教训**：重跑分支只 `applyRerun(feats)` 不读 `fc.planting_grid` → 预览用旧网格 + 新要素的局部相位。
**打包**：`desktop_entry.py` 单入口 → PyInstaller onedir → NSIS 67.7 MiB。红线：`freeze_support()`
是 `__main__` 第一行；`PROJ_DATA` 优先 rasterio；`codegen-units=4` + `lto="thin"`。

## 7. 批处理脚本（项目根，UTF-8 无 BOM + CRLF）
- 入口按功能编号：`1. 启动桌面端.bat` / `2. 构建安装包.bat` / `3. Build Installer.bat`（英文）/
  `4. 诊断影像服务.bat`；共享库 `_环境准备.bat` **不能改名**（`%~dp0` 相对调用）。
- ⚠️ **"产物新鲜"≠"产物完整"**（10-22 血案）：PyInstaller 在 COLLECT 阶段被打断留下半截
  `_internal`（1161/1459 文件，缺 unicodedata），但 exe 时间戳是新的 → 判"新鲜"→ 复用 → 打出
  rasterio 不可用的坏包。现时间戳检查后再跑 `desktop_entry.exe --self-test`（失败返回 3）→ 强制重建。
  **永远不要中途 Ctrl+C 杀正在打包的构建。**
- ⚠️ **"产物存在"≠"产物新鲜"**（坑 49）：走 `build_desktop_runtime.ps1 -CheckStale`（比 LastWriteTimeUtc）。
- ⚠️ **`.gitkeep` 会丢**（坑 50）：打包清理 `desktop\runtime` 连带删除 → CI 干净 clone 上 tauri-build
  存在性检查失败（本地全绿）。打包完自动补回 + `check_all.py` 第 10 层把关。
- ⚠️ **if (...) 块内 echo 禁用 ASCII 括号**：显性脚本静默死亡；**隐性 if/else 双双执行、`set` 丢失**。
  中文原版靠全角（）规避。兜底 `scripts/check_bat_safety.py`（13 项，已进 check_all 第 9 层与 CI）。
- **check_runtime 的 Rust 判定必须真跑 `cargo --version`**（无默认工具链时 cargo 是坏 shim）；
  `park_stale` 两行必须在 `set "FG_STALE_DIR=…"` 之后（坑 46）；`FG_LANG=en` → 英文输出（21 处 if/else）。

## 8. 红线与硬约定
- **Git**：绝不自动 commit，必须用户明确同意；提交前 `git reset` 清暂存再按路径 `git add`；
  合并 `--no-ff`；跨分支冲突保留双方 + 章节重编号，不用 `-X ours/theirs`；**未获许可不 push**。
- **文档**：HTML 报告必须同时出「专业版 + `-小白版`」；中文文件名；含图 HTML 内联 base64/SVG，
  禁相对路径；历史决策文档纠错时**不改正文**（顶部提示 + 文末后记）。
- **代码**：标识符纯 ASCII，中文只在注释/显示字符串；`sidecar.py` 的 stdout 是 NDJSON 数据通道，
  禁 print 污染，人类日志走 stderr。组件抛错会卸载整棵 React 树 → 白屏，需 ErrorBoundary。
- PowerShell 5.1 读 `.ps1` 必须有 UTF-8 BOM；别手删安装目录（NSIS 弹 "Unable to install"）。
- **CI**：Python 依赖唯一清单是根目录 `requirements.txt`（漏过 Pillow 导致 CI 从未绿）；
  `desktop/runtime/desktop_entry/.gitkeep` 必须保留；frontend 钉 `ubuntu-24.04`。
- **验收基线（2026-11-14）**：`check_all.py` **17 层**退出码 0 · 契约 **117/117** ·
  `npm test` **23 套件零失败** · `tsc --noEmit` 0 错误 · `cargo test` 81 · `test_block_jobs` 60 ·
  `test_overviews` 42 · `verify_render` 191（需 dev server；Node 20 要 `node --experimental-websocket`）。
  ⚠️ **看退出码，不要只看 grep 输出**。ruff 抓不到 possibly-unbound，靠 CLI `--help` 补。
- **"装了包但服务起不来"排查顺序**：① `py-runtime\desktop_entry\desktop_entry.exe --self-test`
  （`ok:true` 即排除 DLL/依赖/杀软）；② 手动 `--run-tile-server --source <tif> --port 8799` 看 `/meta`
  与 stderr；③ 完全按外壳方式起（cwd=`%LOCALAPPDATA%\fgd\data`、三个 PYTHON* 变量）；④ 才怀疑外壳。
  ⚠️ 别用开发机 `desktop/runtime` 判断包是否完整。

## 9. 协作分工与待办
- **11-05 起分工**：决策 AI 只出文档/审查，**不改代码**；本会话是**执行方 AI**。
  入口 `docs/03-算法教学/第四轮审查意见与执行单_20261105.md`（正文 R1~R17 + 第 7 节 11-14 复审）。
- ✅ 已落地：R1 / R3 / R4 / R11 / R14 / R3a / R13（每项单独提交，均未 push）。
- ⏭ **下一项 R2**，之后 R6 → R5 → R15 → R8 → R12 → R16 → R17 → R7 → R9 → R10。
- ⏳ 待审查方确认：R13「分类用单一可信单元原点」的取舍；`rect_lonlat` 是字段清单外的实现细节。
- ⏳ **正式交付**：按新算法重跑全幅 + 重抽验证集（缝合后 ID 全变）→ 150 块真值打标（用户亲自做）。
- ⏳ 幼树/矮树判据（4.4% 放样点 2 m 内有树心）；不可种植地物连通块判据仍依赖窗口。
- ⏳ 安装包签名；`active_learning.py` 仍未跑过；Tauri 真机验 §21.5 四项。
