# 手工回归（e2e）—— 不进 `npm test`

这里的脚本依赖**浏览器 / 虚拟环境 / 真实数据**，CI 跑不了，所以**刻意不接入 `npm test`**。
它们是"发版前手工跑一遍"的资产，不是单元测试。

```bash
# 单元/逻辑测试（CI 用，445 项）
cd desktop && npm test

# 手工回归（发布前，逐条看输出）
cd <仓库根>
.venv/Scripts/python.exe desktop/tests/e2e/regress_gaps_selection.py
.venv/Scripts/python.exe desktop/tests/e2e/e2e_export_bundle.py
.venv/Scripts/python.exe desktop/tests/e2e/export_grid_ab.py
node desktop/tests/e2e/ui_regress.mjs
```

---

## ⚠️ 头号大坑：仓库根 `output/` 会污染所有验收

`tile_server.gaps_search_dirs()` 的候选目录**永远包含 `ROOT/output`**（ROOT = 仓库根）：

```
① 影像同目录
② 影像目录下的 output/
③ 仓库根 output/          ← 永远会被搜索，与你 cwd 无关
④ 进程 cwd 下的 output/
```

而仓库根 `output/` 里现在躺着 **20 个** `*gaps*.geojson`（A/B 试验、冻结冒烟、
性能测试…），按 mtime 排序最新的是：

| 文件 | 要素数 | 类别数 | 备注 |
|---|---|---|---|
| `frozen-smoke2-gaps.geojson` | 12 | 4 | **当前"最新"，会被自动选中** |
| `frozen-smoke-gaps.geojson` | 12 | 4 | 冻结冒烟残留 |
| `ipc-sim2-gaps.geojson` | 8 | 3 | IPC 联调残留 |
| `sc-workers-test-gaps.geojson` | 14 | 5 | 并发压测残留 |
| … | | | |
| `wgr17-final-gaps.geojson` | **1726** | **8** | 真正要验收的那份，排第 6 |

**后果：任何拿仓库根当 cwd 的验收都会看到 12 块，而不是 1,726 块。**

这不是"导出坏了"。曾有人据此得出"导出只会得到 19 文件 / 919 点"的错误结论，
实际是候选文件选错了 —— 换成隔离数据根立刻是 21 文件 / 3,691 点。

> 数字会随仓库状态变化。**以脚本输出的实际文件名和计数为准**，不要背结论。

### 正确做法

**不要**在仓库根直接验收。两个脚本已经各自处理：

- `regress_gaps_selection.py`：全部在临时目录里造候选，且把临时文件的 mtime
  推到未来（`base + 3600s`），保证盖过仓库残留。
- `e2e_export_bundle.py`：在临时目录造**完整数据根**（桩影像 + 显式结果文件 + 空 `output/`），
  并把显式文件的 mtime 设成**比仓库所有残留都旧** —— 这样"修复前必然失败"，
  用例才有判别力（第一版设成"1 小时前"，而残留是 40 小时前的，于是修复前也通过 = 假绿）。

手工用命令行验收时同理：

```bash
# ❌ 错：会读到 12 块的测试残留
.venv/Scripts/python.exe scripts/tile_server.py

# ✅ 对：显式指定，且数据根里只有这一份
.venv/Scripts/python.exe scripts/tile_server.py \
  --source "drone data/WGR17-002.tif" \
  --gaps "output/wgr17-final-gaps.geojson"
```

**注意**：即使 `--gaps` 显式指定，旧版本仍会被 `ROOT/output` 里 mtime 更新的文件顶掉
（见下方"被验证的缺陷"）。修复后才真正可靠。

---

## 脚本清单

### 1. `regress_gaps_selection.py` —— 结果文件选择逻辑（① ~ ④）

不启 HTTP，直接用真实 `TileServer.__init__` / `_pick_gaps()` / `gaps_json()`，
在临时目录里造候选。**秒级完成，没有外部依赖。**

| 段 | 验什么 | 失败意味着 |
|---|---|---|
| ① | 同一实例依次读到 3 / 7 / 11（同路径覆盖 + 出现新文件） | **检测跑完看不到新结果**（退回历史 bug） |
| ② | 显式指定的文件不被更新的残留顶掉 | 用户选的文件被静默换掉 |
| ③ | 服务启动后新写的文件接管 | 与 ② 的修法互相打架，把 ① 弄坏 |
| ④ | 名字不含 `gaps` 的 geojson（掩膜 / A-B）不被选中 | 把森林掩膜当空地展示 |

> ① 与 ② 是**互相冲突**的需求：既要"每次请求重新发现"（①），又要"显式优先"（②）。
> 修法必须让两者共存，所以 ③ 是 ② 的配套反例，不能省。

### 2. `e2e_export_bundle.py` —— 端到端 /gaps + /export（⑤）

真起服务（临时端口，默认 8799），真发 HTTP。约 15~40 秒。

**做法**：在临时目录造完整数据根
```
<tmp>/WGR17-002.tif              512×512 桩影像（EPSG:4326，只为让 /meta 与导出元数据可用）
<tmp>/wgr17-final-gaps.geojson   从 output/ 复制的真数据
<tmp>/output/                    空
```
以 `--source <tmp>/… --gaps <tmp>/wgr17-final-gaps.geojson` 启动。

**验收基线**（改了算法/交付口径就要同步改脚本顶部常量）：

| 项 | 期望 |
|---|---|
| `/gaps` 要素数 | **1,726** |
| 类别数 | **8** |
| `/export` 文件数 | **21** |
| 放样点位数 | **3,691** |
| 一页报告 | 含 `3,691` |

**⑤-c 额外验"网格是否跟着换批次"**：服务启动后往 `output/` 放一份更新的小样本，
`/gaps` 应当切过去（期望行为），且 `planting_grid` 必须**跟着**换成新样本的
（断言对齐绝对値 `origin_x_m == 159.3191`，不用前后比较——比较式在"首读就错"时会假绿）。

`--keep` 保留临时目录便于排障。

### 3. `export_grid_ab.py` —— "块数对得上 ≠ 点位对得上"

要素固定 1,726 不变，只换 `base_obj.planting_grid`，比对交付点位。

证明一个隐蔽耦合：`/export` 里
- **要素** ← 前端 POST
- **网格** ← 磁盘上"被发现的"那个文件

两者串批次时，**块数完全正确，放样点位却按另一批数据平移**。报告看着正常，坑挖错地方。
（实测：3691 → 3713 点，首点坐标偏移 `origin_x 158.95→159.32`、`pitch 8.45→8.35`）

> 若哪天 `/export` 改成"网格也走 POST"，本脚本会打印"风险不存在"，
> 那时应把断言反过来并更新本文档。

### 4. `ui_regress.mjs` —— 界面回归（13 条 UI 改造）

headless Chrome + CDP，派发**真实鼠标/键盘事件**。

**依赖**
- dev server：`cd desktop && npm run dev`（默认 <http://localhost:5173>）
- Chrome：默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`，
  可用 `CHROME_PATH` 覆盖
- 其他端口冲突：`CDP_PORT=9444`、`APP_URL=http://localhost:5174/`

**场景**
| 场景 | 对应改造 | 关键断言 |
|---|---|---|
| `A1` | 引导可取消 | × / 取消 / Esc / 遮罩 四个出口；**Esc 后地图选中仍在**（capture 拦住了全局 Esc） |
| `A3` | 最小面积任意值 | `abc` / `-5` / `0` / `1e999` / 空格 / 超大值都不崩、不双档高亮；**筛选跨标签不丢** |
| `B` | 三处帮助弹窗 | 左栏 / 右栏 / header 都能开；Esc 不误清选中；点内部不关、点遮罩关 |
| `C1` | 右栏「复核\|属性」 | 未选中只有「复核」；选中自动切「属性」；删除/Esc 后回「复核」 |
| `D1` | 右键取消 | `preventDefault`；**取消后仍能正常画完多边形**（不只验"渲染出来了"） |
| `M` | 已知问题看门狗 | `?mock=ready` 下地图**不应崩**（当前会崩，见下） |
| `X` | 导出拍平 | 顶层 `features` 空、要素在 `blocks[].gaps` 时，请求体是扁平数组、无 `blocks` 键 |

单跑某条：`node desktop/tests/e2e/ui_regress.mjs A1 C1`

#### ⚠️ 为什么本脚本不用 `?mock=ready`

该开关伪造的 `/meta` **缺 `bounds_wgs84`**，`MapCanvas.tsx:246` 解构抛
`undefined is not iterable`，整块地图被 ErrorBoundary 顶掉（DOM 里只剩「地图渲染出错」）。

所以"在 `?mock=ready` 下点一遍"其实是在**没有地图**的界面上点 ——
右键取消、框选、绘制这些涉图交互**全都没被测到**。

本脚本改用 `Page.addScriptToEvaluateOnNewDocument` 拦截 `fetch('/meta')`，
返回**结构完整**的 meta，地图能正常初始化，交互才是真的。
`M` 场景保留下来当看门狗：`App.tsx` 的 mock 补上 `bounds_wgs84` 后它会转绿。

---

## 被这几个脚本验证过的缺陷（存档）

1. **显式 `--gaps` 被 mtime 更新的文件顶掉**（`tile_server._pick_gaps`）
   - 后果不止"块数不对"：`/export` 的 `planting_grid` 也来自同一发现结果，
     造成**块数正确、放样点位串批次**的交付级错误
   - `regress_gaps_selection.py` 第 ② 段是它的回归用例
2. **`?mock=ready` 的地图 meta 缺 `bounds_wgs84`** → 地图区整块崩
   （`ui_regress.mjs` 的 `M` 场景）
3. **`WorldWizard`/`pickFile` 的 `data_root` 边界**：`appStatus === null` 时为 `undefined`，
   选「检测结果」会抛 TypeError 被 catch 成"打开文件选择框失败…"；空串会拼出 `/output`
   （低概率，未写脚本，见代码审查记录）
4. **文案与实现不一致**：帮助里说「确定需补种」是**两类**，但该分组实际含
   `manual_add` 共 **3 类**（组勾选会一起打开）。由
   `desktop/tests/helpContent.test.ts` 覆盖类别名一致性，但分组数量这条未断言

---

## 约定

- 脚本一律**只读 + 只在临时目录写**，不修改仓库数据、不写 `output/`
- 断言写**期望值**而非当前值：修复前应当是红的（这是回归测试的意义）
- 改了算法交付口径（要素数 / 点数 / 文件数）时，同步改脚本顶部的 `EXPECT_*` 常量
