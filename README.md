# Forest Gap Detection · 油棕园空地智能检测

> 把一张 5 GB 的无人机正射影像，变成一份「哪里该补种、补多少株、点位在哪」的可交付清单。

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Tests](https://img.shields.io/badge/tests-692%20assertions-brightgreen)
![Runtime](https://img.shields.io/badge/runtime-Tauri%20v2%20%2B%20Python-24C8DB)

---

## 这是什么

**Forest Gap Detection** 是一套面向**油棕种植园**（不是普通森林）的 Windows 桌面应用。
它读入无人机拍的正射影像，自动找出「本该有树、实际是空」的地块，把候选地整理成清单，
最后导出可直接导入 ArcGIS / 手簿 / GPS 的补种成果。

一句话概括它的角色：**它不替代你的判断，它把全园 1,726 块候选地按大小和类型摊在你面前，
让你用最短时间做完人工确认。**

## 它解决什么问题

| | 传统做法 | 本项目 |
|---|---|---|
| 找空地 | 人工走园或盯着航拍图逐块画 | 算法自动圈出候选地，附带面积、类型、置信度 |
| 工作量 | 全园上千块，人工勾画要几天 | 机器出候选，人工只做"是/否"确认 |
| 一致性 | 换个人画法就变，无法追溯 | 参数、输入、结果全部落盘，可复现 |
| 交付 | 手画 KML，坐标精度靠猜 | 直接出 Shapefile / KML / CSV + 一页汇总报告 |

**实测基线**（一块 47,130 × 44,686 像素、5 GB 的园区影像）：

- 全园识别出 **1,726 块 / 8 类**要素；
- 其中**确定需补种 702 块 / 309,143 m²**（占园区 13.49%），折算约 3,691 株；
- 150 块真实标注验证：大块（≥1,500 m²）**40/40 全对**；误差集中在小块（≤220 m²）。

## 核心特性

- **双证据融合**：DSM 冠层高度 + 大疆语义分割 + 绿度判据，三条证据互相校验，不靠单一阈值。
- **种植网格先验**：按实测株距 8.35 m / 行距 7.23 m / 60° 三角形种植反推格点，区分"真空缺"与"林间缝隙"。
- **八类分类**：确定需补种 / 待复核 / 林间缝隙 / 道路 / 水体 / 办公区 / 未开发林 / 非种植区。
- **五步工作流**：导入渲染 → 圈选范围 → 检测 → 复核（撤销 / 框选 / 清单）→ 估算导出。
- **大图可用**：分块 + 多进程（6 workers 全园约 6 分钟），瓦片服务让 5 GB 影像在界面上流畅浏览。
- **可交付**：一次导出 21 件成果（8 层矢量 + 双坐标系 + 放样点 + 一页报告）。
- **可复现**：同影像 + 同参数 → 结果逐位一致；契约测试锁死算法与外壳的接口。

## 快速开始

### 一、给使用者（不需要懂代码）

1. **安装**：双击 `Forest Gap Detection_0.1.0_x64-setup.exe`（约 72 MB，**已内置完整 Python 运行时**），一路下一步，无需管理员权限。
2. **首次启动**：点「选择影像文件…」选无人机拍的那张 `.tif`（3~5 GB），等 3~10 秒影像服务就绪。
3. **干活三步**：① 圈选要检测的地块（不圈就是整幅）→ ② 开始检测（3~6 分钟）→ ③ 估算株数并导出交付包。

> 选过的路径会记住，下次直接进主界面。
> 完整图文步骤、快捷键、复核技巧见 **[桌面端使用手册](docs/08-桌面端/桌面端使用手册.md)**。

**构建会产出两个文件，别拿错**：

| 产物 | 体积 | 能独立运行吗 | 给谁 |
|---|---|---|---|
| `bundle/nsis/*-setup.exe`（安装包） | **72 MB** | ✅ 外壳 + 完整 Python 运行时 | **发给别人用这个** |
| `fgd-desktop.exe`（便携 exe） | 7 MB | ❌ 只是外壳，需要外部 `py-runtime/` | 仅开发机自测 |

7 MB 那个之所以小，是因为 Python 运行时（275 MB，含 numpy/rasterio/scipy/shapely/pyproj 及其 DLL）
没有打进去；安装包把它一起压缩进去了，所以是 72 MB。

### 二、给开发者

**环境要求**：Windows 10/11 64 位、Python 3.11+、Node.js 20+、Rust 工具链（MSVC）、
[VS 2022 生成工具](https://visualstudio.microsoft.com/visual-cpp-build-tools/)（勾选「使用 C++ 的桌面开发」）。

```bat
:: ① 一键配齐环境（Python venv / 依赖 / Node / Rust，约 5-15 分钟）
scripts\一键配置环境.bat

:: ② 开发态启动桌面端（自动拉起 vite + 瓦片服务）
1. 启动桌面端.bat

:: ③ 打安装包（会自动 PyInstaller 打包 Python 运行时，首次约 20-30 分钟）
2. 构建安装包.bat
```

> 中文会在部分 cmd 窗口显示为方块时，用英文入口 **`3. Build Installer.bat`**（输出全英文）。

## 工作原理

```
正射影像 + DSM + 语义分割 + 种植网格
        │
        ▼
① 分块读取 → ② 分割判据（ExG 分位 + 饱和度）→ ③ 形态学开运算
        │
        ▼
④ 网格先验（60° 三角格点，8.35 / 7.23 m）→ ⑤ 双证据融合（CHM 高度 + 分割类别）
        │
        ▼
⑥ 八类归属（补种 / 待复核 / 缝隙 / 道路 / 水体 / 办公 / 未开发林 / 非种植）
        │
        ▼
⑦ 多边形简化 + 面积闸门 → ⑧ 导出矢量 + 放样点 + 汇总报告
```

**进程模型**：Tauri 外壳（Rust）负责窗口、文件、子进程管理；算法跑在独立的 Python 进程里，
通过 **stdio NDJSON** 与外壳通信（主链路不走 HTTP）；只有瓦片服务走本地 HTTP
（端口从 8765 起，被占用会自动往后挪，前端自动跟随）。

## 技术栈

| 层 | 选型 |
|---|---|
| 桌面外壳 | Tauri v2（Rust）+ NSIS 打包 |
| 前端 | React 18 + TypeScript + Vite 5 + MapLibre GL 4 + Terra Draw + zustand |
| 算法 | Python 3.11 + numpy / rasterio / scipy / shapely / pyproj |
| 通信 | stdio NDJSON（算法主链路）、HTTP（仅瓦片与元数据） |
| 打包 | PyInstaller onedir（Python 运行时）+ Tauri bundle.resources |

## 项目结构

```
├── 1. 启动桌面端.bat        开发态一键启动（自动拉起 vite + 瓦片服务）
├── 2. 构建安装包.bat        一键出安装包（自动打包 Python 运行时）
├── 3. Build Installer.bat   英文版构建入口（cmd 中文乱码时用）
├── 4. 诊断影像服务.bat      影像服务排障（只读，生成诊断报告）
├── _环境准备.bat            内部共享库，被上面几个脚本调用，不直接双击
│
├── desktop/                桌面端工程（Tauri + React）
│   ├── src/                前端：五步工作流 / 复核 / 估算导出
│   ├── src-tauri/          Rust 外壳：sidecar 进程 + 瓦片服务监督
│   └── README.md           ★ 坑清单（50 条）与实测数字，开发前必读
├── scripts/                算法与工具（纯 CLI，可单独运行）
│   ├── process_image.py    整幅检测主入口
│   ├── sidecar.py          桌面端调算法用的 NDJSON 通道
│   ├── tile_server.py      唯一的 HTTP 服务（瓦片）
│   └── check_all.py        10 层自检（类型 / 断言 / 静态检查 / 契约）
└── docs/                   全部项目资料（索引见 docs/README.md）
```

## 开发与测试

```bash
# 前端类型检查 + 断言（561 项）
cd desktop && npx tsc --noEmit && npm test

# Rust 单测（44 项）
cd desktop/src-tauri && cargo test

# 算法契约测试（95 项，改算法后必跑）
.venv\Scripts\python.exe scripts\test_sidecar_contract.py

# 全量自检（10 层，约 55 秒；--fast 跳过契约测试）
.venv\Scripts\python.exe scripts\check_all.py
```

**验收基线**：`npm test` 561 · `cargo test` 44 · 契约 95/95 · `check_all.py` 10 层全绿。
任何一项掉了都算回归。

## 文档索引

| 想看什么 | 去哪 |
|---|---|
| 全部文档总目录 | [docs/README.md](docs/README.md) |
| 软件怎么用（图文） | [桌面端使用手册](docs/08-桌面端/桌面端使用手册.md) |
| 实现原理（技术） | [桌面端实现说明](docs/08-桌面端/桌面端实现说明.html) |
| 算法怎么想出来的 | [算法说明与演进史](docs/03-算法教学/算法说明与演进史.html) |
| 需要准备哪些文件 | [输入输出文件清单](docs/09-数据与产物/输入输出文件清单.html) |
| 当前缺陷与优先级 | [算法缺陷看板](docs/03-算法教学/算法缺陷与桌面端协同看板.html) |
| 接手开发（最新状态） | [交接文档 2026-10-21](docs/01-需求与架构/交接文档-2026-10-21.md) |
| 开发坑清单（50 条） | [desktop/README.md](desktop/README.md) |

> 所有 HTML 文档都是单文件自包含（图片内联），双击即可看，且都提供「专业版 + 小白版」两份。

## 已知限制

- **高草与幼龄油棕不可分**：约 122,784 m² 的绿色区域存在混淆，需人工删减。
- **小块易误判**：面积 ≤220 m² 的地块约 1/3 判断不一致（大块基本无误差）。
- **「待复核」占全园 31%**，其中 48% 确实该补——跳过复核等于放弃约 15% 的可补面积。
- **换影像需重标定**：株距/行距、分割阈值都随影像版本变化，不保证跨影像直接可用。
- **Windows 专属**：NSIS 打包与路径处理按 Windows 设计，未适配 macOS/Linux。

## 维护

单人项目，由 [@justineling](https://github.com/justineling) 维护。
问题反馈请附上 `%LOCALAPPDATA%\fgd\logs\app.log`（release 版没有控制台，日志是唯一线索）。

> 仓库未附带开源许可证文件；如需对外开源，请补充 `LICENSE`。
