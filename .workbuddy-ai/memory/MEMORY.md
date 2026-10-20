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
栈：React 18 + TS + Vite 5 + MapLibre GL 4 + Terra Draw + zustand（手写 CSS）。验收基线：`npm test` 529 断言 · `cargo test` 全绿 · 契约 95/95。
致命 5 条：① `output/*.geojson` 是 `blocks[].gaps` 结构、无顶层 features；② 结果路径只按"扫目录+名含 gaps+mtime 取最新"，候选目录必须含 `cwd/output`，`/gaps` 空时绝不能 `applyRerun([])`；③ 检测前必须预检（W1001/W1004/W3001 都是"算偏不报错"）；④ Tauri↔sidecar 两线程分读 stdout/stderr（64 KB 管道填满→死锁）；⑤ 撤销栈 1.5 s 时间窗合并 TerraDraw change，框选必须传 `visibleClasses`。
打包：`desktop_entry.py` 单入口 → PyInstaller onedir → NSIS 67.7 MiB。红线：`freeze_support()` 是 `__main__` 第一行；`PROJ_DATA` 优先 rasterio；`codegen-units=4` + `lto="thin"`。
验证集（10-19）：150 块 Neyman 分层 + H-T 权重（**Σwᵢ 必须精确 = 1726.0**）；`scripts/eval_validation.py --selftest` 13 项；`uncertain` 不允许"确认"；`initValidation` effect deps 必须含 scope/samples.length。

## 7. 批处理脚本（项目根，UTF-8 无 BOM + CRLF）
- 入口：`构建安装包.bat`（中文）/ **`Build Installer.bat`（英文，2026-10-20 新增，动机：cmd 乱码）** / `启动桌面端.bat`；共享库 `_环境准备.bat`（子命令派发，顶层禁 setlocal）。
- **`FG_LANG=en` → 共享库英文输出**（21 处 if/else，默认中文零变化）；英文入口在 setlocal 后设置；心跳子进程经环境变量继承。
- ⚠️ **if (...) 块内的 echo 文本禁用 ASCII 括号**（提前闭合代码块 → `. was unexpected at this time.`）。中文原版靠全角（）天然规避；英文翻译必须替换（扫描器见 10-20 日志）。
- ✅ 已修复（2026-10-20）：dba6d11 曾把 `park_stale` 跑到 `set FG_REL/FG_STALE_DIR` 之前 → 旧安装包挪走保护静默失效。现两行 `park_stale`（含注释块）必须位于 `set "FG_STALE_DIR=…"` 之后、`mark_project_path` 之前（两入口同改；坑清单第 46 条；QA 桩测 56/56）。
- 测试法：桩 helper + 桩 npm.bat + 假产物目录干跑全部分支（见 10-20 日志，42 断言）。

## 8. 红线与硬约定（违反会返工）
- **Git**：绝不自动 commit，必须用户明确同意；提交前 `git reset` 清暂存再按路径 `git add`；合并 `--no-ff`；跨分支冲突保留双方+章节重编号，不用 `-X ours/theirs`。
- **文档**：HTML 报告必须同时出「专业版 + `-小白版`」；中文文件名；含图 HTML 内联 base64/SVG，禁相对路径；历史决策文档纠错时不改正文（顶部提示+文末后记）。
- **代码**：标识符纯 ASCII，中文只在注释/显示字符串；`sidecar.py` 的 stdout 是 NDJSON 数据通道，禁 print 污染，人类日志走 stderr。组件抛错会卸载整棵 React 树 → 白屏，需 ErrorBoundary。
- 契约测试 `scripts/test_sidecar_contract.py` 期望 95/95；PowerShell 5.1 读 `.ps1` 必须有 UTF-8 BOM；别手删安装目录（NSIS 弹 "Unable to install"）。
- **CI（2026-10-20 修复）**：Python 依赖唯一清单是根目录 `requirements.txt`（CI 与本地共用，别再手写 pip 清单——漏过 Pillow 导致 CI 从未绿）；`desktop/runtime/desktop_entry/.gitkeep` 必须保留（tauri-build 对 bundle.resources 做存在性硬检查，目录没了 `cargo test` 编译期就挂）；frontend 钉 `ubuntu-24.04`（latest 已迁 Ubuntu 26）；`cargo test`(debug) 不需要 `dist`（codegen 仅在非 dev 且无 devUrl 时 panic）。
- `check_all.py` 9 层静态检查（tsc/npm test/ruff/CLI --help/cargo test/契约等）；ruff 抓不到 possibly-unbound，靠 CLI `--help` 补。

## 9. 待办
- ⏳ 真实 150 块打标（用户亲自做）→ 裁决 702 vs 727、解锁算法后续项。
- ⏳ 安装包签名；`active_learning.py` 仍未跑过。
