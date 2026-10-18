# Forest Gap Detection · 桌面端原型（前端）

Tauri v2 桌面端的**前端部分**，同时可脱离 Tauri 直接用浏览器调试。
按 5 步工作流实现：导入渲染 → 圈选 Target Block → 分类渲染与过滤 → 增删多边形 → 估算与导出。

决策依据见 `docs/01-需求与架构/桌面端交互需求与实现映射.md`（v0.4）。

---


## 零、三分钟上手（给第一次用的人）

**第 1 步 · 安装**
双击 `Forest Gap Detection_0.1.0_x64-setup.exe`，一路下一步。
（装到哪都行，默认装在当前用户目录，不需要管理员权限。）

**第 2 步 · 第一次启动会看到「开始使用」卡片**

| 卡片上的步骤 | 你要做的事 |
|---|---|
| ① 选择正射影像（必填） | 点「选择影像文件…」→ 选无人机拍的那张大图（`.tif`，3~5 GB） |
| ② 选择检测结果（可选） | 有之前跑出来的 `.geojson` 就选，没有就跳过 |
| 点「开始使用 →」 | 软件会启动影像服务，首次约 3~10 秒 |

> 选过的路径会记住，下次启动直接进主界面，不用再选。
> 想换数据 → 点右上角「数据」。

**第 3 步 · 干活（三步）**

1. **① 圈选 Target Block** —— 在地图上框出要检测的那块地（不圈就是整幅）
2. **② 开始检测** —— 等 3~6 分钟（圈选后通常 2~3 分钟），结果自动显示
3. **⚡ 估算可种植数量 → 导出交付包** —— 得到株数与可导入 ArcGIS / GPS 的成果

**遇到问题看哪里**

| 现象 | 怎么办 |
|---|---|
| 地图是空的、写着「影像未连接」 | 点右上角「数据」重新选影像；或等几秒（首次要建索引） |
| 启动后窗口一闪就没了 | 看 `%LOCALAPPDATA%\fgd\logs\app.log`（release 版没有控制台） |
| 检测按钮点了没反应 | 需要先在桌面应用里运行；纯浏览器打开不能跑检测 |
| 数字看起来不对 | 先确认选的是**交付版**结果 `wgr17-final-gaps.geojson`（不是 `-elev-` 中间版） |


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

| 脚本（**在项目根目录**） | 给谁用 | 做什么 |
|---|---|---|
| `..\启动桌面端.bat` | **开发** | 检查环境 → 缺什么自动装（调 `scripts/一键配置环境.bat`）→ 挑端口 → `tauri dev` |
| `..\构建安装包.bat` | **发布** | 检查环境 → `npm run build` → `tauri build` → 报告产物并自动弹安装程序 |
| `..\_环境准备.bat` | 上面两个的**共享模块** | 阶段提示 / 心跳 / 端口探测 / 旧产物归档 / 搬家自愈 |

> 三个脚本放在**项目根目录**（与 `drone data/`、`output/` 同级），不是 `desktop/` 下 ——
> 因为要检查影像与结果文件，放根目录路径更直观。脚本内部用 `pushd "%~dp0desktop"`
> 进前端工程跑 npm，跑完 `popd`。

**编译产物固定在项目内**：`desktop\src-tauri\target\`，安装包在
`desktop\src-tauri\target\release\bundle\nsis\`。

> 脚本会在编译前**临时清空当前进程的 `CARGO_TARGET_DIR`**（只影响这一次运行，
> 不动系统环境变量），否则 cargo 会把产物甩到那个变量指向的目录去。
> 想恢复"用外部 target"（多项目共用编译缓存）：设 `FGD_USE_EXTERNAL_TARGET=1` 再跑脚本。

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

### 打包分发：Python 运行时（`scripts/build_desktop_runtime.ps1`）

桌面端要拉起**两个** Python 进程（tile_server 常驻 + sidecar 按需）。
如果各打一个 `--onedir`，rasterio/numpy/scipy/shapely/pyproj 的动态库会被复制
两遍（~350 MB → ~700 MB）。所以做了**单入口**：

```
desktop_entry.exe --run-tile-server [...]   # 转发给 tile_server
desktop_entry.exe [sidecar 参数...]         # 默认走 sidecar
desktop_entry.exe --self-test               # 冻结态自检（JSON 输出）
```

打包结果：`desktop/runtime/desktop_entry/`（**179 MB**），
`tauri.conf.json` 把它映射成 `py-runtime/desktop_entry/`。

```bat
:: 一条命令：装 PyInstaller（如需）→ 打包 → 可选冒烟
powershell -ExecutionPolicy Bypass -File scripts\build_desktop_runtime.ps1 -Smoke
```

**四条打包红线**

1. **`multiprocessing.freeze_support()` 必须是 `__main__` 的第一行**。
   打包后进程池的子进程是「重新执行同一个 exe」并带 `--multiprocessing-fork`；
   若先跑 argparse，这个参数会被当未知参数拦掉 → `--workers > 1` 直接崩。
2. **`--collect-all rasterio / pyproj / shapely`**：这些包的 Cython `.pyd` 与数据
   文件（`proj.db` / `gdal_data`）静态分析抓不全，漏了就是运行期
   `ModuleNotFoundError` / `Cannot find proj.db`。
3. **`PROJ_DATA` 必须指向 rasterio 的 `proj_data`，不是 pyproj 的**
   （见坑 20）。冻结态还要自己定位（`sys._MEIPASS`），因为这两个库只认环境变量。
4. **打包态的工作目录必须可写**：装到 `Program Files` 时安装目录只读，
   写 `output/` 与瓦片缓存会失败。数据根按
   `FGD_DATA_ROOT` → `resources/data` → `%LOCALAPPDATA%\fgd\data`（自动创建）
   → 主程序同级 的顺序解析。

**Rust 侧双模寻址**（生产优先、开发兜底）：

| 顺序 | 位置 | 场景 |
|---|---|---|
| 1 | `FGD_BACKEND` 环境变量 | 排障时强制指定 |
| 2 | `resources/py-runtime/desktop_entry.exe` | 安装包 |
| 3 | 主程序同级 `py-runtime/desktop_entry.exe` | 免安装 zip |
| 4 | 仓库 `.venv/Scripts/python.exe` + `scripts/*.py` | 日常开发 |

打包态还会把 params 里的**相对路径**（`drone data/...`、`output/chm.tif`）
补成数据根下的绝对路径 —— 打包版没有"仓库根"这回事。

**冻结态实测（脱离 .venv 直接调 exe）**

| 项 | 结果 |
|---|---|
| `--self-test` | ✅ `proj_ok: true` · `gdal_driver_ok: true` · exit 0 |
| 瓦片服务 `/meta` | ✅ 47130×44686 · EPSG:4326 · 0.033 m/px · 金字塔=True |
| 单张瓦片 | ✅ z=15 61 KB / 598 ms · z=17 150 KB / 538 ms（真实影像，非空白） |
| 多进程 + ROI 检测 | ✅ `workers=2` + `limit 4`，ROI 528→121→4，**exit 0，30.9 秒**，输出 227 KB |

**端到端实测（装成安装包 → 启动 → 加载影像）**

安装包 `Forest Gap Detection_0.1.0_x64-setup.exe` = **67.66 MiB**
（179 MB 运行时经 NSIS 压缩），静默装到 `%LOCALAPPDATA%\Forest Gap Detection`：

| 检查 | 结果 |
|---|---|
| 安装包内容 | ✅ 1,447 个 `py-runtime` 文件 · `desktop_entry.exe` / `proj.db`×2 / `gdal_data` 162 项 |
| 安装后自检 | ✅ `frozen: true` · `proj_ok` · `gdal_driver_ok` · exit 0 |
| 启动桌面端 | ✅ 日志：`瓦片服务后端：打包运行时 ...\py-runtime\desktop_entry\desktop_entry.exe` |
| 瓦片服务 | ✅ `/meta` → `ok=True` · 47130×44686 · EPSG:4326 · 0.033 m/px |
| 进程 | ✅ `fgd-desktop.exe` + `desktop_entry.exe` 并存 |

> **排障入口**：release 版没有控制台，所有关键信息写在
> `%LOCALAPPDATA%\fgd\logs\app.log`（后端形态与绝对路径、瓦片服务是否起来、数据根）。

### 导入范围 · 导出交付包 · 一页报告（2026-10-18）

**导入范围**（工具栏「导入范围」）：选 `.kml` / `.geojson` → 解析 → 地图自动
`fitBounds` 到该区块。解析走 `lib/roiImport.ts` 纯函数（28 项断言）。

- **三维坐标会被剥掉**：大疆智图 / Google Earth / 奥维 导出的 KML 是
  `111.205,1.179,0`（lon,lat,alt）。第 3 维混进 geometry 会让面积与 Terra Draw 全错。
- **多多边形取最大**：一个 KML 里常同时有"目标区块 + 图例框"，合并会虚增范围。
- KMZ（压缩包）会明确提示"请先解压"，UTM 米坐标会提示"请先转经纬度"。

**导出交付包**（工具栏「导出交付包」）：

```
POST /export { gaps(编辑后), outdir, clearance_m, planting_grid, audit, image, roi }
  → gaps-all-wgs84.geojson / gaps-all-utm49n.geojson
  → gaps-all-{wgs84,utm49n}-shp.zip
  → by-class/gaps-{类}-utm49n-shp.zip（8 类）
  → gaps-all.kml
  → planting-points-{wgs84,utm49n}.geojson / -shp.zip / .kml / .csv
  → gaps-edited.csv
  → 补种勘察一页报告.html
```

实测（真实数据）：**1,726 要素 → 21 个文件 + 3,691 个放样点**。

输出目录用系统文件夹对话框选（浏览器模式下可手填），存 localStorage。
导出完成后有「📂 打开文件夹」。

**一页报告**（`scripts/report_summary.py`）：五章 —— 参数卡片 / 三档口径
（内联 SVG 堆叠条 + 逐档条形）/ 苗木估算对比 / 人工复核留痕 / Top 20 明细。
**单文件自包含**（内联 CSS + 手写 SVG，零外部依赖），`@media print` 按 A4 排版，
`Ctrl+P` 直接出 PDF。**浅色主题**：给主管签字的东西要省墨、可黑白打印。

### 复核三件套：撤销/重做 · 框选批量 · 复核清单（2026-10-18）

```
① 框选多选（拖矩形）或 Shift/Ctrl + 点击
     ↓ 只命中当前勾选可见的类别（防盲删）
② 地图底部批量栏：已选 3 块 · 合计 553 m² → 改判 / 删除
     ↓ 一次操作 = 一步撤销
③ Ctrl+Z 整批恢复；Ctrl+Y 重做
```

**右面板「复核」标签**：全部 / 待复核(465) / 已改过 / 人工新增 + 最小面积过滤，
**按面积降序** —— 前 30 个大斑块通常占 80% 的争议面积。点一行会自动打开该类别、
选中并飞过去（「不确定」默认隐藏，不打开就飞过去也看不见）。

**撤销栈**：40 步，快照是 `gaps.slice()`（要素对象不可变，结构共享，约 14 KB/步）。
改「并行进程数」这类参数不进历史；载入新结果会清空历史（换基线了）。

| 操作 | 快捷键 |
|---|---|
| 撤销 | `Ctrl+Z` |
| 重做 | `Ctrl+Y` / `Ctrl+Shift+Z` |
| 删除选中（可多选） | `Delete` / `Backspace` |
| 退出当前模式 / 取消选择 | `Esc` |
| 加选 / 减选 | `Shift` / `Ctrl` + 点击 |

> 焦点在输入框（`INPUT` / `TEXTAREA` / `SELECT` / contenteditable）时，
> 以上快捷键**全部让位** —— 否则在搜索框按 Ctrl+Z 会把多边形撤销掉。

### 检测面板：预检 → 参数 → 进度（2026-10-18）

```
点「② 开始检测」
   ↓ preflight_detect(params)          ← Rust：文件 / 掩膜 / 输出目录 / 参数
   ├─ 全绿 ──────────────────────────→ 直接开跑（不打扰）
   └─ 有 warn / error ─→ 预检卡片 ─→「仍然开始」/「去选择数据」
   ↓ run_detect(resolved)
   工具栏下方进度带：检测中 24% · 128/528 块 · 已用 1:25 · 剩余 4:24 · 已发现 312 块
   ↓ result
   进度带变成「✓ 检测完成 · 1,443 块 · 383,426 m² · 用时 5:50」，结果自动载入
```

**为什么要预检**：`chm_path` / `segment_path` 缺失时 sidecar **不报错**，
只回一条 `W1004` 就照常跑完 —— 结果是"纯 RGB"版本。用户 350 秒后拿到一份
看着正常、语义全错的数据，这是最坏的一种失败。

| 预检项 | 缺失后果 | 级别 |
|---|---|---|
| 正射影像 | 无法检测 | error |
| CHM | 退化成纯 RGB，水体/低矮植被大量误判 | warn |
| 语义分割 | 水塘识别率 98% → 8% | warn |
| 森林掩膜 | 未开发林算成可补种，**放样点多 221 个** | warn |
| 输出目录 | 白跑 350 秒才发现写不进去 | error |
| workers / 密度 | sidecar 报 E1002 | error |

森林掩膜按 `output/forest-mask*.geojson` 前缀**自动发现**（文件名随实验变过），
并写回 `resolved.forest_mask_path`。输出目录会**真写一个探针文件再删掉**
（建得出来 ≠ 写不进去）。

**参数**（齿轮按钮）：并行进程数 1/2/4/6 · 目标密度 120/150/180 ·
只跑圈选范围。存 localStorage，改 workers 不会让瓦片缓存失效。

**浏览器预览**：`?detect=1` 看进度条、`?pf=1` 看预检卡片（截图 / 回归用）。

### 检测链路：Tauri ↔ sidecar（stdio NDJSON）

```
点「② 开始检测」
   ↓ invoke('run_detect', { params })     ← params 严格对齐 sidecar 参数表
Rust: spawn python sidecar.py --params-json <json>
   ├─ 线程 A：stdout → 逐行 JSON → emit('sidecar-event') → 前端日志/进度
   └─ 线程 B：stderr → emit('sidecar-log')   → 前端状态栏
   ↓ 收到 event=result
前端: fetch('/gaps') → mergeManualEdits() → 替换要素（重放人工编辑）
```

**三条硬约束（都是会"卡死/白屏/静默错数"的）**

1. **必须两个线程分别读 stdout 与 stderr**。Windows 匿名管道缓冲区只有 ~64 KB，
   只读 stdout 时 stderr 会被每个瓦片的日志填满 → Python 的 `log()` 阻塞在 write
   上 → 整个 sidecar 永久卡死。症状是"进度停在 30%、CPU 归零、没有任何报错"。
2. **参数名必须严格对齐**：`chm_path` / `segment_path` / `target_density_per_ha`
   （不是 `chm` / `segment` / `target_density`）。写错不会报错，只会回一条
   `W1001 未知字段已忽略` 然后**照常跑完** —— 结果退化成"纯 RGB + 默认密度"。
3. **`limit` 必须在 `roi` 之后应用**（先圈定范围再截断试跑数量）。
   顺序反了时 `--limit 3 --roi 中部` 会得到 0 个瓦片并报 E3001。

**ROI 传递**：前端画的多边形以 `roi_geojson` 传进来，Rust 落成临时 `.geojson`
再作为 `roi` 路径给 sidecar（sidecar 的 `roi` 只接受文件路径）。

**取消**：`cancel_detect` 直接 kill 子进程；窗口关闭时也会清（否则关窗后
后台还在跑 350 秒的批处理）。

**浏览器模式（Headless Chrome）**：`isTauri()` 判断 `'__TAURI_INTERNALS__' in window`，
浏览器下 `runDetect` 返回"请用桌面应用打开"的提示而**不碰任何 Tauri API**；
`@tauri-apps/api` 用动态 `import()`，所以浏览器产物里不会多出运行时依赖
（构建后能看到 `core-*.js` 0.2 kB / `event-*.js` 1.1 kB 两个独立分包）。

### 编辑后重跑的合并策略（`lib/mergeEdits.ts`）

算法重跑后 `gap_id` 全部重编。直接替换会让**用户上一轮删掉的误报复活、
改判的类别被算法改回去**。所以重跑要能把人工操作「重放」到新结果上。

| 模式 | 行为 |
|---|---|
| `keep_manual`（默认） | 保留全部人工新增；重放删除与改判 |
| `overwrite` | 完全回到算法结果，丢弃全部人工痕迹 |

匹配判据（**不算真正的多边形 IoU**，前端零依赖）：

1. **质心落入**：新要素质心落在旧多边形内 → 同一对象（强判据）
2. **外接框 IoU > 0.5 且面积比 ∈ [0.5, 2]** → 兜底（弱判据，会写 warning）

重放改判时保留 `original_class` / `edited` / `edited_by`，并新增
`replayed_from`（指向旧 `gap_id`）以便事后核对"这次重放是不是猜错了"。

删除快照存在 store 的 `deletedFeatures`（**存几何不存 id** —— 重跑后 id 全变了，
只能靠几何认）。

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

> ℹ️ **建金字塔后网格从 8.45/7.32 变成 8.35/7.23 —— 这是变准了，不是变差了。**
> 中间影像被建过金字塔（3.48 → 4.66 GB），`order_tiles_by_validity` 用 overview
> 判定有效性，降采样方式一变，边界瓦片的"有效/空白"判定会翻转 → 采样瓦片不同。
> 而 **8.35 m × 7.23 m 恰好是早期用「频域自相关」与「树心 NND 峰值」两套独立方法
> 互证出来的真实物理株行距**（MEMORY.md §3）—— 没建金字塔时全分辨率跨步近邻抽样
> 有混叠噪声，才把网格略微撑大到 8.45/7.32；建完后 `survey_grid` 收敛到了真值。
> 所以这是**影像文件层面的改善**，与 workers 无关；同一影像文件下 workers=1/4
> 已实测逐位一致。跨影像版本的对比仍需重新立基线。

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

**IPC 桥接侧**

17. **只读 stdout 不读 stderr → sidecar 永久死锁**

    Windows 匿名管道缓冲区约 64 KB。跑批时每个瓦片都会往 stderr 写日志，
    若 Rust 只读 stdout、打算"等进程结束再读 stderr"，缓冲区很快填满 →
    Python 的 `log()` 阻塞在 `write` 上 → 整个进程卡死。
    **症状极具误导性**：进度条停在 30% 不动、CPU 归零、**没有任何报错**。
    修法：spawn 之后立刻起**两个线程**分别 `BufReader::new(stdout).lines()` 与
    `stderr.lines()`，各自 `emit` 到前端。

18. **sidecar 参数名写错不会报错，只会静默退化**

    正确名字是 `chm_path` / `segment_path` / `target_density_per_ha`。
    写成 `chm` / `segment` / `target_density` 时只回一条
    `W1001 未知字段已忽略`，然后**照常跑完** —— 结果变成"纯 RGB + 默认密度"，
    数字看起来合理但语义完全不同。前端传参处必须与 `sidecar.PARAM_SPECS` 逐字对齐。

19. **`limit` 必须在 `roi` 之后应用**

    顺序反了（先截前 N 块再按 ROI 过滤）时，如果前 N 块恰好都在圈外，
    会得到 0 个瓦片并报 `E3001 没有可处理的瓦片`。
    正确顺序：**先 ROI 过滤缩小范围，再 limit 截断试跑数量**。

20. **`proj.db` 版本冲突：rasterio 与 pyproj 各带一份，版本可能不同**

    ```
    CRSError: The EPSG code is unknown. PROJ: proj_create_from_database:
    ... proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 4
    whereas a number >= 5 is expected. It comes from another PROJ installation.
    ```

    本机实测：rasterio 1.4.4（GDAL 3.10.3）自带 `rasterio/proj_data/proj.db`
    是 **MINOR=5**，而 pyproj 3.7.2 的 pip 包里带的是 **MINOR=4**（旧）。
    若把 `PROJ_DATA` 指向 pyproj 那份，rasterio 的 GDAL 直接拒绝加载 →
    所有 `CRS.from_epsg(...)` 失败、瓦片服务全崩。

    **修法：`PROJ_DATA` 优先指向 rasterio 的 `proj_data`**（更新），
    pyproj 只作兜底 —— PROJ 向前兼容，pyproj 读新库没问题。
    这个坑**只在冻结态出现**（开发态两个库各自找自己的数据，互不干扰），
    所以必须靠 `--self-test` 里的 `gdal_driver_ok` 才能发现。

21. **`resources` 用 `**/*` 会把子目录展平 → MSI 打包失败**

    ```
    error LGHT0204: ICE30: The target file 'Mountain' is installed in
    '...\py-runtime\desktop_entry\' by two different components
    ```

    PyInstaller 的 `tzdata/zoneinfo/` 下有 `Canada/Mountain` 与 `US/Mountain`
    （还有 `Pacific` 既是文件又是目录）。`"../runtime/desktop_entry/**/*"`
    把它们**平铺**到同一个目标目录 → 同名冲突。

    **修法**：用**目录映射**（不带通配符）：
    `"../runtime/desktop_entry": "py-runtime/desktop_entry"`，子目录结构才会保留。

22. **`bundle.icon` 只列 png → 打包阶段直接失败**

    ```
    failed to bundle project: `Couldn't find a .ico icon`
    ```

    `cargo check` 与 `tauri dev` 都不报，只有 bundle 需要 `.ico`
    （Windows 资源文件）。要同时列 `icons/icon.ico` 与多尺寸 png。

23. **目录映射后，后端路径多一层 → 装好了却"找不到后端"**

    映射产物是 `py-runtime/desktop_entry/desktop_entry.exe`（多一层
    `desktop_entry/`），而 `resolve_backend` 只找了 `py-runtime/desktop_entry.exe`。
    这个错**不会报错**，只会让 `start_tile_server` 返回"找不到后端"、
    前端提示"影像瓦片服务未连接"。

    **修法**：搜索路径同时认两种布局；并靠 `app.log` 里的
    「瓦片服务后端：…」一行确认实际用的是哪个 exe。

24. **反复"静默安装 → 手动删目录 → 再安装"会让 NSIS 弹 `Unable to install`**

    测试安装包时图快，用 `rm -rf` 直接删安装目录（绕过 `uninstall.exe`），
    注册表/文件锁状态就不一致了；再跑安装器时 NSIS 检测到冲突，
    会弹一个安装向导 + 一个 "Unable to install" 错误框。

    **正确姿势**：卸载走 `uninstall.exe` 或「设置 → 应用」；
    测试时想换目录就换个 `/D=` 目标，不要手删。
    （这次的弹窗就是测试副作用，与安装包本身无关。）

25. **`warn` 事件没处理 → 所有"会算偏但不会报错"的告警都被丢掉**

    sidecar 的 `warn`（W1001 未知字段 / W1004 CHM 缺失 / W3001 水体 …）走的是
    独立事件类型。前端事件处理只写了 `progress` / `result` / `error` / `log`，
    **`warn` 直接落进 else 被忽略** —— 界面上一条提示都没有。

    这比报错危险：用户以为检测正常，其实结果已经退化。
    修法：加 `warn` 分支，以 `⚠️ [W1004] ...` 的形式进日志。

26. **`forest_mask_path` 从来没传过 → 桌面端结果一直包含未开发林**

    CLI 版本靠 `--forest-mask` 传掩膜，桌面端拼参数时漏了这个字段 →
    掩膜为空 → 未开发林被算成可补种。这正是 `wgr17-elev-gaps` 与
    `wgr17-final-gaps` 的差（**221 个放样点**）。

    ⚠️ 但**不要**把文件名写死（`forest-mask-50m-exg60.geojson` 是实验名，
    换影像后会变）—— 交给 `preflight_detect` 按前缀自动发现。

27. **`.app` 用 `grid-template-rows: auto 1fr auto` + 可选孩子 → 布局错位**

    加了检测进度条之后，`.app` 的孩子数在 3 与 4 之间变化。
    grid 的固定行数在少一个孩子时会把 `1fr` 分给**状态栏**，
    body 反而变成 `auto` —— 地图区被压成内容高度。

    修法：改成 `display: flex; flex-direction: column`，body 用 `flex: 1`。
    **凡是"可选出现的条带"都别用固定行数的 grid。**

28. **TerraDraw 拖拽的 `change` 洪水会吃光撤销栈**

    拖一个顶点时 TerraDraw **每移动几个像素就触发一次 `change`**，
    一次拖拽能产生几十次 `updateGapGeometry`。如果每次都压历史，
    拖一次就把 40 步栈填满 —— 用户按 `Ctrl+Z` 看到的是"边界一点点回退"，
    而不是"回到拖之前"。

    修法：1.5 秒内**同一要素**的连续几何更新只压第一条快照
    （实测 12 次更新 → 1 步）。`setGaps` 要重置这个窗口，
    否则换基线后的第一次编辑会被误判成"上次拖拽的后续"。

29. **框选必须传 `visibleClasses`，否则会盲删隐藏层**

    默认只勾选「确定需补种」两个类别，`road` / `water` / `alley_gap` 是隐藏的。
    如果框选遍历全部要素，一次"批量删除"就把看不见的道路水塘一起删了，
    **地图上完全看不出来**（它们本来就不显示），交付包却少了 180 条道路。

    修法：`selectGapsInBox(features, bbox, visibleClasses)` 强制传可见性。
    单测里有一条专门反证："全部可见时三个都命中 / 隐藏时只命中空地"。

30. **框选用 `queryRenderedFeatures` 会"看缩放级别给结果"**

    它只认当前渲染出来的要素：同一块地在 z14 命中、z12 因为太小没渲染就漏掉。
    而且它跑在 WebGL 里，`npm test` 完全测不到。

    修法：地图只负责给一个经纬度矩形（`map.unproject` 两个角），
    选谁由 `lib/selection.ts` 的纯函数决定 —— 可测、可复现、与缩放无关。
    另外进框选模式时**必须 disable `dragPan` / `boxZoom`**，
    MapLibre 默认把 `Shift+拖拽` 绑成拉框放大。

31. **KML 的 `<coordinates>` 是三维的（`lon,lat,alt`）**

    大疆智图 / Google Earth / 奥维 导出的 KML 一律带第 3 维：
    `111.205,1.179,0`。第 3 维混进 geometry 后 `polygonAreaM2` 与 Terra Draw
    都会算错，而且**不会报错**，只是面积偏、图形怪。

    修法：解析时显式只取前两维，并回传 `strippedAltitude` 让界面提示
    "已忽略高程"。单测里专门有一条断言 `ring.every(p => p.length === 2)`。

32. **导出的网格参数必须来自磁盘上的算法结果，不能用前端传的**

    前端 `/gaps` 里的 `planting_grid` 只有 `anchor_lon/lat`，
    **缺 `origin_x_m` / `origin_y_m`（UTM 原点）**。
    拿它构造 `GridModel` 会让所有放样点整体平移 —— 数字看着正常，点位全错。

    修法：`/export` 路由把 `tile_server.gaps_path` 读出来，
    用磁盘对象里的完整网格；前端传的只作兜底。

33. **"单文件自包含"的自检不能搜 `"http://"`**

    内联 SVG 必须写 `xmlns="http://www.w3.org/2000/svg"` ——
    那是**命名空间标识符，不会发起任何请求**。用 `"http://" not in html`
    判断会直接误判成"有外部依赖"。

    修法：只查真正会拉资源的 `<link href>` / `<script src>` / `<img src>` /
    `@import` / `url(`。
