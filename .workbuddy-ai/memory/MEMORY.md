# Forest Gap Detection — 项目长期记忆

> 2026-10-20 精简重写（原 ~7.5 KB → 上限内）。过程见同目录 `YYYY-MM-DD.md`；桌面端坑清单权威版 `desktop/README.md`（45 条）。

## 1. 定位
油棕种植园（**不是普通森林**）空地智能检测桌面应用。KML 范围 + 正射影像 → 全园需补种空地矢量图盘。Tauri v2（Rust+React）+ Python 算法 sidecar。

## 2. 工作区（以当前会话为准）
- `D:/Project/AI/Forest Gap Detection`（git，remote = github.com/justineling/Forest-Gap-Detection，main）。⚠️ 旧记录称此路径是"公司电脑"、本机用 `D:/学习目标_笔记/...`——2026-10-20 起当前工作区就是 D:/Project 版，两条都备查。
- Python 必须用 `.venv/Scripts/python.exe`（系统 python 无 numpy）；PS 执行策略 `-ExecutionPolicy Bypass`。
- 运行态资源（`.venv`、`output/`、`models/`）被 gitignore，新克隆需重建；`.workbuddy-ai/` 已入库。
- 大影像 `drone data/WGR17-002.tif`：47,130×44,686、EPSG:4326、3.3 cm/px、4 波段（第4恒 255）。10-17 手动 `--build-overviews` 后体积增至 4.66 GB（GDAL 写进文件内部，不可逆；原始 3.48 GiB 版本已无副本）。

## 3. 核心实测数据（改算法前必读）
- 株距 8.35 / 行距 7.23 m / 60° 三角形种植 / 165.6 株每公顷。跨影像版本须重立基线。
- 分割判据 v3：阈值 = clip(ExG 40% 分位, 40, 80)；树冠 = (平滑ExG>阈值) 或 (饱和度>0.45)。
- 道路/办公：亮 L>170 + S<0.18 掩膜；fill ratio <0.30=道路，≥0.30 且 ≥400 m²=办公。水体：B≥G>R 或 (L<90 & ExG<15 & std<6)，过 30 m² 连通域。
- 跨航带 ExG 中位 37~116（差 3 倍）→ 阈值必须曝光鲁棒。草地 ExG 159/S 0.64 vs 油棕 64~102/0.37~0.53——**ExG 过高反而不是树**。
- 油棕 vs 未开发林（南部天然林，CHM 2.32 m 是对的）：用 100 m 区块树心密度 110~160 vs 20~60 株/ha。**不采用 DINOv2**。
- 定标法：300 m 窗口「方位 0.5°×相位 8×8」细扫，树心落格点 3 m 内比例（随机 45.8%）→ 最优 59.0°、79~97%。脚本 `tmp/analyze/probe_phase_local.py`。

## 4. 算法修复（2026-10-17，长期有效）
1. 网格方位角按 **6θ（模 60°）** 圆统计（等边三角形 60° 旋转对称）；禁止取算术中位数。
2. 水体并入 `seg==water` 作第三证据（CHM 置 NaN 会把水面推向"非树"）。
3. 需补种三档报（确定/review/not_needed），否则虚胖 14%。
4. 桌面端与 CLI 同路：`run_pipeline` 必须传 `elevation`/`elev_params`；`class_totals` 全量初始化。

## 5. 交付基线（2026-10-17 冻结）
1,726 要素 / 8 类；**确定需补种 702 块 / 309,143 m²（13.49%）**；待复核 465。契约 95/95。⚠️ 当前代码重跑变 **727 块**——新旧数字不可混用，由 150 块真值验证集裁决。
算法封版（Stage 14），缺陷台账 `docs/03-算法教学/算法缺陷与桌面端协同看板.html`。对外红线：React18+TS（非 Vue3）、Terra Draw（非 Leaflet-Geoman）、stdio NDJSON（非 FastAPI，只有瓦片走 HTTP）、掩膜影响上界 26%、CHM 异常区块 14.08~29.99 m。

## 6. 桌面端（Tauri v2）

**高度图归属**（2026-10-24）：`build_chm.py` 写完 tif 补 `<同名>.json`（`schema: fgd-chm/1`，记 `image_path`+`source_image`）；
Rust 侧 `chm_owner_at` / `usable_chm` / `job_slot_is_free` 第三判据 / 预检 四处读它。
⚠️ 文件名规则两边必须一致（Py `with_suffix(".json")` = Rust `with_extension("json")`）。
⚠️ **没有元数据 → 照用**（判不出就不拦）：否则"生成→检测"无限换名，且迁移后区块名会变。

**取消必须是无操作**（2026-10-24）：向导 ×/Esc/遮罩=取消，弹窗 ×/Esc/遮罩=继续；
**打开向导/弹窗不许预清状态**（`onPickNewResume` 曾先 `setGaps([])` → 点× 落到第2步）。
续跑弹窗渲染条件 `resumeAsk && !wizard`；清 resume 状态放 `onWizardDone` 顶部。
语义表 `docs/08-桌面端/五步流转与弹窗语义.md`。

**多区块入口**（2026-10-24）：`list_blocks` / `switch_block` 两个命令 + 工具栏 `BlockSwitcher`；
启动提示走 `AppStatus.notices`（后端 `current_notices()` **不清空**，前端 `seenNotices` 去重）→ `NoticeBar`。
⚠️ 提示**不能"取走即清空"**：向导路径会忽略 `set_data_paths` 的返回值，清了就丢消息。
⚠️ 单实例用 `windows-sys` 的 `CreateMutexW`（`Local\fgd-desktop-single-instance`），
不要换 `tauri-plugin-single-instance`（要联网拉 crate）；`CreateMutexW` 被 **`Win32_Security`** 门控，少这个 feature 会 unresolved import。
栈：React 18 + TS + Vite 5 + MapLibre GL 4 + Terra Draw + zustand（手写 CSS）。
**视觉 = Ark UI 工业信息系统**（2026-10-24 起；**2026-10-25 升到 depth=3**，分支 `feat/ui-ark-v2`）：
布局 = 地图列 flex（舞台 + 批量栏 40 + 命令条 64|28），「下一步」不再是浮层；
左右面板可折成 28px 竖轨（断点 1180/980 自动）；状态栏 56px 只留最新一条日志。
语法 = 步进器只留 2px 下划线（无圆底徽章/无底块）、类别色只以 3px 竖条出现、
右面板三档平级页签「清单｜验证集｜属性」、7 弹窗一套外壳、圆角全 0。
⚠️ 四条硬坑：① 日志折叠禁用 `display:none`（innerText 会丢 → verify_render 假红），
用 `max-height` 裁；② 布局层写 `display` 会被 ark.css 覆盖（要写进设计层）；
③ MapLibre 不监听容器 resize，容器高度变化必须 `ResizeObserver → map.resize()`；
④ 每行独立 grid 的 `auto` 列宽逐行不同，面积列必须定宽。
验收：815 单测 / verify_render 188 / 窄窗无溢出 / ark 审计 0 错 0 警。
**2026-10-25 下午再补 10 条**：状态栏 has-stale 88px、`.nc-body` title、styles.css 51 处圆角归零、
帮助文案去写死、批量栏主按钮改描边、复选框改淡青底、检测进度搬进命令条槽位（零跳动）、
`store.tilesState` 单一真值（绿点/kicker/状态栏/空舞台四处一致）、多选聚合块、清单键盘流+已处理下沉。
⚠️ `DetectBar` 组件**没删**（搬进槽位）：`verify_render` 8 条断言 + React #310 回归网挂在它的类名上。

**（depth 2 时期记录，仍有效）**（2026-10-24，分支 `feat/ui-ark`，family=ark × depth=2）：
CSS 分两层 —— `styles.css` 管布局、`ark.css` 管语法（**必须后 import，顺序反了静默失效**）；
旧变量名保留为别名。规范见 `docs/08-桌面端/界面设计规范-ArkUI.md`。
另有平行方案 `feat/ui-rhine-lab`（Rhine Lab 纸感，`rhine.css`），两者都从 main 起、未合并。
⚠️ 改视觉只改 ark.css；⚠️ 类别色唯一来源 `lib/classes.ts` 的 CLASS_STYLES。
⚠️ 窄窗验证用 `desktop/tests/e2e/shot-narrow.mjs`（CDP 精确视口 + 溢出断言）。验收基线：`npm test` **801** 断言 · `cargo test` **81** 项 · `test_block_jobs` **60** · 契约 95/95 · `test_overviews` **42** 项 · `verify_render` **171**（需 dev server）。
**端口不再写死 8765**（坑 48）：`pick_backend_port()` 试 8765~8776，空闲就用/自己的服务复用/别人的跳过；实际端口在 `ACTIVE_PORT`，前端用 `backend.ts` 的 `ensurePort()` + `backendUrl()` 跟随，`MapCanvas` 用 `tileUrlTemplate()`。
致命 5 条：① `output/*.geojson` 是 `blocks[].gaps` 结构、无顶层 features；② 结果路径只按"扫目录+名含 gaps+mtime 取最新"，候选目录必须含 `cwd/output`，`/gaps` 空时绝不能 `applyRerun([])`；③ 检测前必须预检（W1001/W1004/W3001 都是"算偏不报错"）；④ Tauri↔sidecar 两线程分读 stdout/stderr（64 KB 管道填满→死锁）；⑤ 撤销栈 1.5 s 时间窗合并 TerraDraw change，框选必须传 `visibleClasses`。
⚠️ 第 6 条（2026-10-20 交付事故）：**8765 有人监听 ≠ 我们的服务在跑** —— 复用前必须验 `/meta` 的 `app` 字段；子进程 stderr 必须落 `app.log`（release 无控制台，`eprintln!` 是黑洞）并用 `try_wait` 记退出码；启动失败要当场抛回前端。详见坑 47。
打包：`desktop_entry.py` 单入口 → PyInstaller onedir → NSIS 67.7 MiB。红线：`freeze_support()` 是 `__main__` 第一行；`PROJ_DATA` 优先 rasterio；`codegen-units=4` + `lto="thin"`。
验证集（10-19）：150 块 Neyman 分层 + H-T 权重（**Σwᵢ 必须精确 = 1726.0**）；`scripts/eval_validation.py --selftest` 13 项；`uncertain` 不允许"确认"；`initValidation` effect deps 必须含 scope/samples.length。

## 7. 批处理脚本（项目根，UTF-8 无 BOM + CRLF）
- 入口**按功能编号**（2026-10-21 改名）：`1. 启动桌面端.bat` / `2. 构建安装包.bat` / `3. Build Installer.bat`（英文）/ `4. 诊断影像服务.bat`；共享库 `_环境准备.bat` **不能改名**（各入口用 `%~dp0` 相对调用）。
- ⚠️ **"产物新鲜"≠"产物完整"**（2026-10-22 血案，比坑 49 更隐蔽）：
  PyInstaller 在 COLLECT 阶段被打断会留下**半截 `_internal`**（1161/1459 个文件，缺 unicodedata），
  但 exe 时间戳是新的 → `-CheckStale` 判"新鲜"→ 照样复用 → 打出 rasterio 不可用的坏包，
  真机上报"影像读取失败"，完全看不出是打包问题。
  现 `ensure_py_runtime` 在时间戳检查后再跑 `desktop_entry.exe --self-test`（失败返回 3），
  不过就 `[损坏]` 并强制重建。**教训：永远不要中途 Ctrl+C 杀正在打包的构建。**
- ⚠️ **"产物存在"≠"产物新鲜"**（坑 49）：`ensure_py_runtime` 曾只判 exe 存在 → Python 侧修复（如 `[E4099]` 编码）永远打不进包，真机验证必然假阴性。现走 `build_desktop_runtime.ps1 -CheckStale`（比 `scripts/*.py` + `requirements.txt` 与 exe 的 LastWriteTimeUtc），过期自动重建；「[过期]」与「[缺失]」文案分开。
- ⚠️ **`.gitkeep` 一天丢两次**（坑 50）：打包清理 `desktop\runtime` 会连带删除，随后 `git add` 一起提交 → CI 干净 clone 上 tauri-build 存在性检查失败（本地因有真产物而全绿）。现打包完成自动补回 + `check_all.py` 第 10 层用 `git ls-files --error-unmatch` 把关。
- **`FG_LANG=en` → 共享库英文输出**（21 处 if/else，默认中文零变化）；英文入口在 setlocal 后设置；心跳子进程经环境变量继承。
- ⚠️ **if (...) 块内的 echo 文本禁用 ASCII 括号**（提前闭合代码块）。两种症状：① 显性：`. was unexpected at this time.` 脚本静默死亡；② **隐性：if/else 双双执行、`set` 丢失**（公司电脑实测 `(cargo)` → [缺失]/[ready] 同屏、FG_NEED_RUST 没置位、跳过自动安装直到构建才失败）。中文原版靠全角（）天然规避；英文翻译必须替换。兜底：`scripts/check_bat_safety.py`（13 项 selftest，覆盖块内裸 echo 与**任意嵌套深度的单行 if-echo**，已进 check_all 第 9 层与 CI）。
- **check_runtime 的 Rust 判定必须真跑 `cargo --version`**（rustup 无默认工具链时 cargo 是能 where 到、一执行就报错的 shim，只 where 会误判"就绪"）。
- ✅ 已修复（2026-10-20）：dba6d11 曾把 `park_stale` 跑到 `set FG_REL/FG_STALE_DIR` 之前 → 旧安装包挪走保护静默失效。现两行 `park_stale`（含注释块）必须位于 `set "FG_STALE_DIR=…"` 之后、`mark_project_path` 之前（两入口同改；坑清单第 46 条；QA 桩测 56/56）。
- 测试法：桩 helper + 桩 npm.bat + 假产物目录干跑全部分支（见 10-20 日志，42 断言）。

## 8. 红线与硬约定（违反会返工）
- **Git**：绝不自动 commit，必须用户明确同意；提交前 `git reset` 清暂存再按路径 `git add`；合并 `--no-ff`；跨分支冲突保留双方+章节重编号，不用 `-X ours/theirs`。
- **文档**：HTML 报告必须同时出「专业版 + `-小白版`」；中文文件名；含图 HTML 内联 base64/SVG，禁相对路径；历史决策文档纠错时不改正文（顶部提示+文末后记）。
- **代码**：标识符纯 ASCII，中文只在注释/显示字符串；`sidecar.py` 的 stdout 是 NDJSON 数据通道，禁 print 污染，人类日志走 stderr。组件抛错会卸载整棵 React 树 → 白屏，需 ErrorBoundary。
- 契约测试 `scripts/test_sidecar_contract.py` 期望 95/95；PowerShell 5.1 读 `.ps1` 必须有 UTF-8 BOM；别手删安装目录（NSIS 弹 "Unable to install"）。
- **CI（2026-10-20 修复）**：Python 依赖唯一清单是根目录 `requirements.txt`（CI 与本地共用，别再手写 pip 清单——漏过 Pillow 导致 CI 从未绿）；`desktop/runtime/desktop_entry/.gitkeep` 必须保留（tauri-build 对 bundle.resources 做存在性硬检查，目录没了 `cargo test` 编译期就挂）；frontend 钉 `ubuntu-24.04`（latest 已迁 Ubuntu 26）；`cargo test`(debug) 不需要 `dist`（codegen 仅在非 dev 且无 devUrl 时 panic）。
- **"装了包但服务起不来"的排查顺序**（2026-10-21 实战）：① `py-runtime\desktop_entry\desktop_entry.exe --self-test`（证明 exe 可跑，`ok:true` 即排除 DLL/依赖/杀软）；② 手动 `--run-tile-server --source <tif> --port 8799` 看 `/meta` 与 stderr；③ 完全按外壳方式起（cwd=`%LOCALAPPDATA%\fgd\data`、8765、三个 PYTHON* 变量）；④ 以上全绿才怀疑外壳（旧版无 stderr 转存/退出码，管道 64 KB 填满会让服务阻塞）。⚠️ 别用开发机的 `desktop/runtime` 判断包是否完整——那里没打包就只有 `.gitkeep`。
- `check_all.py` **12 层**静态检查（tsc/npm test/ruff/CLI --help/cargo test/仓库卫生/契约/金字塔冒烟/多区块选结果等）；ruff 抓不到 possibly-unbound，靠 CLI `--help` 补。验收基线 **801 / 81 / 60 / 95 / 42 / 12 层**；⚠️ 看退出码，不要只看 grep 输出。

## 9. 待办
- ⏳ 真实 150 块打标（用户亲自做）→ 裁决 702 vs 727、解锁算法后续项。
- ⏳ 安装包签名；`active_learning.py` 仍未跑过。
