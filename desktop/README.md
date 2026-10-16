# Forest Gap Detection · 桌面端原型（前端）

Tauri v2 桌面端的**前端部分**，同时可脱离 Tauri 直接用浏览器调试。
按 5 步工作流实现：导入渲染 → 圈选 Target Block → 分类渲染与过滤 → 增删多边形 → 估算与导出。

决策依据见 `docs/01-需求与架构/桌面端交互需求与实现映射.md`（v0.4）。

---

## 一、怎么跑起来

```bash
# ① 启动本地瓦片 / 辅助服务（零新依赖：标准库 + rasterio）
#    首次建议加 --build-overviews（一次性建金字塔；否则低缩放级瓦片要 35~100 s/张）
.venv/Scripts/python.exe scripts/tile_server.py --build-overviews

# ② 启动前端（另开一个终端）
cd desktop
npm install      # 首次
npm run dev      # → http://localhost:5173
```

浏览器打开 `http://localhost:5173` 即可。

> **不启后端也能用**：前端会自动退回内置样例数据
> （`public/sample-gaps.geojson`，从真实结果按类别分层抽样 280 个要素），
> 地图上只是没有影像底图，多边形查看 / 编辑 / 估算 / 导出全部可用。

---

## 二、5 步需求 → 实现位置对照

| 需求 | 状态 | 实现位置 |
|---|---|---|
| ① 导入文件并渲染地图 | ✅ 已跑通 | `scripts/tile_server.py`（`/meta` + `/tiles/{z}/{x}/{y}.png`）· `src/components/MapCanvas.tsx` |
| ② 圈选 Target Block，只检测圈内 | 🟡 **前端已就绪，算法侧待实现** | 前端：工具栏「① 圈选 Target Block」→ `store.setRoi` · 算法侧：`process_image.py` 的 ROI 裁剪尚不存在（见决策文档 R-P0-11） |
| ③ 按 class 渲染 + 勾选过滤 | ✅ 已跑通 | `src/lib/classes.ts`（8 类 + 人工新增，配色与 `export_arcgis.py` 一致）· `src/components/LeftPanel.tsx` |
| ④ add / delete / edit polygon | ✅ 已跑通 | Terra Draw（`MapCanvas.tsx` 的绘制/选择模式）+ `store` 的 `addGap` / `deleteGap` / `updateGapGeometry` / `setGapClass` |
| ⑤ 估算可种植数量 + 导出 | 🟡 前端双口径已跑通；交付包导出走后端 | 估算：`src/lib/estimate.ts` · 导出：`POST /export`（geojson / csv / kml） |

---

## 三、目录结构

```
desktop/
├─ index.html · vite.config.ts · tsconfig.json · package.json
├─ public/sample-gaps.geojson     # 离线演示数据（真实结果抽样）
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
- 估算口径与业务数字自洽：确定需补种 309,143 m² → 面积折算约 4,637 株

**未验证 / 未做**
- 后端 `/export` 只出 geojson / csv / kml；**Shapefile 仍由 `scripts/export_arcgis.py` 出**
  （它需要 `blocks` 结构与 CRS 元数据，本机无 `osgeo`/`fiona`）
- `detect`（真正的检测）未接 —— 需先实现算法侧 ROI 裁剪
- 未做 Tauri 外壳（窗口、文件对话框、sidecar 进程监督）
- 未做 1,700+ 多边形在低配机器上的渲染压测

---

## 六、已知坑（都已修，留作记录）

1. **`Window.intersection` 在无交集时抛 `WindowError`**，不是返回空窗口 ——
   园区外的瓦片必须捕获异常后返回透明瓦片，否则每个请求都抛栈。
2. **波段索引别把 Alpha 算进去**：本影像 4 波段（第 4 波段恒 255），
   把 4 个波段送进目标是 3 波段的 `reproject` 会直接报错。
3. **影像没有金字塔**：低缩放级瓦片窗口覆盖大半个影像，GDAL 只能全分辨率读
   → 实测 z=15 约 35 s、z=13 约 104 s。必须 `--build-overviews`（一次性）。
4. **`match` 表达式的 TS 类型**：MapLibre 的表达式是变长元组，TS 无法从 `flatMap`
   推断，已收敛到 `lib/classes.ts` 的 `classColorExpr()` 一处做断言。
