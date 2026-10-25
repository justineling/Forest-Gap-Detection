# 组件语法规范 · depth 3（Ark / Forest Gap Detection 桌面端）

> 在 depth 2 契约之上深化，不推翻既有令牌与两条硬规矩（中性面 ≥75%；青色仅用于 选中 / 进度 / 主操作 / 一条规则线）。
> 数值可直接落 `desktop/src/ark.css`（设计层）；布局与断点改动落 `desktop/src/styles.css`（布局层）。`ark.css` 仍必须后 import。

## 0. 新增令牌（4 个，唯一允许的新增）

| 令牌 | 值 | 用途 |
|---|---|---|
| `--ark-bar` | `3px` | 类别色竖条宽度。左面板类别行 + 复核清单行共用，替换两处「独立色块」 |
| `--ark-hair` | `rgba(244,246,246,.12)` | 叠在航拍影像上的**唯一**细线（舞台刻度/基线）。纸白 12% 是在 3.3cm/px 影像上既能看见又不夺色的上限 |
| `--ark-scan` | `rgba(24,209,255,.10)` | 选中底色统一值。现有代码散落 `.10/.12/.14/.16` 四档，收敛为一档 |
| `--ark-dock-h` | `64px` | 命令条展开态高度。折叠态用字面量 `28px`（= 图标按钮基准，不再新增令牌） |

---

## 1. depth 3 舞台分层：4 层，每层回答一个问题

现状 L1 = 角括号 + 全屏斜纹。depth 3 只加两层，且每层必须能回答「它替用户回答哪个问题」。

| 层 | 名称 | 信息角色 | 落点 |
|---|---|---|---|
| L0 | 航拍影像 | 事实 | MapLibre canvas，**不加任何遮罩** |
| L1 | 舞台框（既有，不动） | 「这里是可操作区」 | 左上/右下 1px `--ark-signal` 55% 角括号，臂长 22px；全屏 45° 斜纹 1.4% |
| **L2 新** | 测量刻度带 | 「这块影像有多大 / 我在哪一档比例」 | 四边内侧 0–14px **边距带**，不压内容 |
| **L3 新** | 底边状态规则线 | 「有没有任务在跑 / 跑到哪」 | 舞台底边 0–2px |

**L2 测量刻度带**
- 结构：`.stage-frame{position:absolute; inset:0; pointer-events:none}` 内放 `.sf-ticks`（上/右两边，纯 gradient，不生成 DOM）+ `.sf-scale`（左下角基线）。
- 数值：`.sf-ticks{background-image:repeating-linear-gradient(90deg, var(--ark-hair) 0 1px, transparent 1px 64px), repeating-linear-gradient(90deg, var(--ark-hair) 0 1px, transparent 1px 256px); background-size:100% 5px, 100% 9px; background-repeat:repeat-x; background-position:0 0, 0 0; height:9px}`，只挂 `top:0` 与 `right:0`（右侧那条旋转 90°）。
- 基线 `.sf-scale`：`left:14px; bottom:14px; width:100px; height:1px; background:var(--ark-hair)`，两端 `::before/::after` 各 1px×5px 竖端帽；标签 `100 px · ≈ 3.3 m`，`--ark-font-mono` 9.5px `--ark-muted`，贴基线右侧 4px。
- 为什么：用户是测绘背景，判「这块是不是 200 m²」靠的是屏上比例直觉而不是读数字；刻度带把「3.3 cm/px」从状态栏的一串字符变成可目测的尺子，且全部落在边距里，影像一个像素都没被压。

**L3 底边状态规则线**
- 结构：`.stage-rule{position:absolute; left:0; right:0; bottom:0; height:1px; background:var(--ark-line); pointer-events:none}`。
- 检测中：`height:2px; background:var(--ark-signal)`，内部 `.sr-fill{width:var(--prog,0%); background:var(--ark-signal-dim); height:100%}` 表示已走过；完成瞬间切 `--ark-state` 保持 600ms 再回落 1px。
- 为什么：这是全系统**唯一被允许的第二条青色规则线**（契约里「一条规则线」就是它）。进度放到影像下边缘而不是压在影像上，6 分钟等待有了不遮挡的读数。

**被拒绝的层**（写在这里是为了防止后面有人再加）
- 影像四周暗角 / 渐晕：会让 1,726 个多边形的边缘判断失真，是审美对测量的入侵。
- 经纬网格：MapLibre graticule 已有；3.3cm/px 下密度失控。
- 悬浮 HUD 数字块：与 `.ark-kicker` 重复。

---

## 2. `.command-dock` 语法

替换 `.next-card`（300px 浮层）与 `.next-pill`。DOM 归属：`.body` 的地图列改 `display:flex; flex-direction:column`，内含 `.stage`（`flex:1 1 auto; min-height:0`）+ `.dock-stack`（`flex:0 0 auto`）。

```
<div class="map-col">
  <div class="stage"> … MapLibre + .stage-frame + .stage-rule … </div>
  <div class="dock-stack">
    <div class="bb-wrap"><div class="batch-bar">…</div></div>   ← 仅选中时渲染
    <div class="command-dock is-open">…</div>
  </div>
</div>
```

**展开态**（`height: var(--ark-dock-h)`）
- 结构：`display:grid; grid-template-columns:116px minmax(0,1fr) auto; align-items:center; column-gap:16px; padding:0 8px 0 0; border-top:1px solid var(--ark-line-strong); background:var(--ark-panel);`
  - col1 `.cd-idx`：左沿 3px `--ark-signal` 竖条（高 32px，`::before`）+ 两行——`STEP 04/05`（mono 9.5px `--ark-muted`）/ `复核结果`（13px 半粗 `--ark-paper`）。
  - col2 `.cd-say`：一句话说明，12px，`white-space:nowrap; overflow:hidden; text-overflow:ellipsis`，全量走 `title`。
  - col3 `.cd-act`：`display:flex; align-items:center; gap:8px`——主操作 `.btn.primary`（32px 高、`min-width:104px`）+ 最多 2 个 `.btn`（32px）+ `.cd-toggle`。
- `.cd-toggle`：28×28，图标 `⌄`，`aria-expanded`，永远停在 col3 最右（`right:8px` 位置恒定）。折叠后图标翻 `⌃`，位置不变——**按钮不许移动**。
- 无圆角、无投影、无四边框（只有一条上边线）。

**折叠态**（28px）
- 同 grid，`.cd-say` 换 `.cd-min`（mono 10.5px）：`04 复核 · 280 待看`；col3 只留 `.cd-toggle` + 主操作文字内联（`.btn.primary{height:24px; font-size:11.5px; padding:0 10px}`）。
- 为什么能折到 28px 还不丢决策信息：步骤号 + 待办数 + 主操作三件都在；丢掉的只有那句解释，而解释在 `.ark-kicker` 的 `STEP 04/05` 段与状态栏日志里仍有。

**与 `.batch-bar` 共存**（同一列，dock 之上）
- `.batch-bar` 从 `position:absolute; left:50%; translateX(-50%); border-radius:11px; box-shadow:…` 改为**通栏行**：`height:40px; display:flex; align-items:center; gap:16px; padding:0 12px; background:var(--ark-field); border-top:1px solid var(--ark-line);`（圆角/投影/居中位移全删）。
- 出入场：`.bb-wrap{display:grid; grid-template-rows:0fr; overflow:hidden; transition:grid-template-rows var(--ark-t-out) var(--ark-ease)}` → 选中时 `1fr`。
- 为什么：两栏都变成「栈里的行」后高度是相加而不是互相让位。原方案靠 `.next-card.raised{bottom:72px}` 把卡片顶上去，选中项一多就顶进影像中部；现在地图可用高度少 40px，但**永不被覆盖**。

**`prefers-reduced-motion: reduce`**
- 关掉 `grid-template-rows` 过渡与入场 `translateY`，`.dock-stack` 高度瞬时切换；`.sr-fill` 宽度不过渡（进度直接跳到当前值）。
- 为什么：折叠/展开是用户主动触发的布局变化，不是装饰动画——减弱动效时保留变化本身，只去掉过程。

**实现注意（写进 PR 说明）**：dock / batch-bar 高度变化后必须调 `map.resize()`，否则 MapLibre canvas 仍是旧高度，影像会被纵向拉扁。

---

## 3. `.panel` 头部：288px 里放 5 件事

- 结构（`.panel-head` 由 `justify-content:space-between` 改写为 grid）：
  `display:grid; grid-template-columns:auto minmax(0,1fr) auto auto auto; align-items:center; column-gap:8px; height:36px; padding:0 4px 0 12px; border-bottom:1px solid var(--ark-line);`
  依次：`.ph-idx`（`01`，mono 9.5px `--ark-signal`）→ `.ph-title`（13px 半粗，`overflow:hidden; text-overflow:ellipsis; white-space:nowrap`）→ `.ph-n`（`280`，mono 10.5px `--ark-muted`，`tabular-nums`，右对齐）→ `.ph-help`（`?`，28×28）→ `.ph-collapse`（`«`，28×28）。
- 宽度账（288 − 12 − 4 = 272）：14 + 8 + 65（5 个 CJK）+ 8 + 26 + 28 + 28 = 177，余 95px 全部给标题伸缩。
- `.ph-collapse` 上加 `border-left:1px solid var(--ark-line)`，把「问」和「收」切成两组：一个是信息，一个是布局。
- 折叠态：面板不消失，收成 **28px 竖轨** `.panel.rail{width:28px}`，内含 `»` + `.pr-label`（`writing-mode:vertical-rl`，9.5px，`图层与类别`）+ 竖排计数。
- 为什么必须留竖轨：≤1180px 自动折叠左面板时，没有可见入口用户会认为「图层功能没了」；28px 竖轨与 dock 折叠态同宽，属于同一套「收起」语法。

---

## 4. 右面板筛选行（300px 内不换行）

**方案 A（推荐）· 分两行**
- 行 1 `.fld-state`：`display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:4px; padding:8px 10px 6px;`
  每片 `.chip` 改**双行仪表片**：`height:34px; display:flex; flex-direction:column; justify-content:center; gap:1px; padding:0 6px; border:1px solid var(--ark-line); border-radius:0; background:var(--ark-ink);`
  `.chip-label` 11px `--ark-muted`；`.chip-n` 9.5px mono `--ark-paper` `tabular-nums`。
  选中：`background:var(--ark-scan); border-color:var(--ark-signal)`，`.chip-label`/`.chip-n` 同时转 `--ark-signal`。
- 行 2 `.fld-area`：`position:relative; display:grid; grid-template-columns:minmax(0,1fr) 58px; gap:6px; padding:0 10px 8px; border-bottom:1px solid var(--ark-line);`
  左 `.seg` 五档：`display:grid; grid-template-columns:repeat(5,1fr); height:28px`，字号 10.5px，`padding:0`，档间用 1px 分隔线而不是 gap。
  右 `.rv-area-input`：`width:100%; height:28px; min-width:0; text-align:right; padding:0 16px 0 4px`；单位用 `.fld-area::after{content:'m²'; position:absolute; right:4px; bottom:6px; font:9.5px var(--ark-font-mono); color:var(--ark-muted); pointer-events:none}` 不再占列。
- 宽度账（300 − 20 = 280）：四片各 67px，最宽标签 `人工新增` 44 + 12 padding = 56 ≤ 67 ✓；面积行 216 + 6 + 58 = 280 ✓，`≥1000` 30px 分到 43px 格宽 ✓。
- 为什么：计数是这批筛选片唯一的决策数据（40 待复核 → 今天做不做得完），双行片让 4 个数字落在同一基线上可直接比大小；单行横滚会把「人工新增」永久推到视口外，而那恰好是「我今天改了多少」的自检指标。

**方案 B（备选）· 单行横向滚动**
- `.fld-state{display:flex; gap:5px; overflow-x:auto; scroll-snap-type:x proximity; padding:8px 10px; scrollbar-width:none; mask-image:linear-gradient(90deg,#000 88%,transparent)}`，`.chip{flex:0 0 auto; scroll-snap-align:start}`。
- 只在面板被拖宽时启用：给 `.panel.right` 加 `container-type:inline-size`，用 `@container (min-width:340px)` 切换——媒体查询判断的是视口，判断不了面板。
- 为什么只作备选：28px 带里的滚动条不可见，右侧渐隐是唯一提示；工具界面里这种「隐藏的可选项」会被当成不存在。

---

## 5. 复核清单行

- 用 **grid** 不用 flex：面积要右对齐、`gap_id` 要定宽右对齐，flex 的 `justify-content` 锁不住两条基线。
- 结构：`.rv-item{display:grid; grid-template-columns:var(--ark-bar) minmax(64px,auto) minmax(0,1fr) 46px; align-items:center; column-gap:8px; height:30px; padding:0 8px 0 0; border:0; background:transparent;}`（`margin-bottom:2px` 留在 `li` 上）
  - col1 `.rv-bar`：`width:var(--ark-bar); height:16px; background:<类别色>`。**删掉 `.rv-swatch` 那个 8×8 方块**，类别色只以行左沿竖条出现。
  - col2 `.rv-area`：11.5px，`font-variant-numeric:tabular-nums; text-align:right`，格式 `5,771.53`，单位 `m²` 降为 9.5px `--ark-muted` 同格内。
  - col3 `.rv-cls`：12px，`display:flex; align-items:center; gap:6px; overflow:hidden`，内含 `.rv-cls-name`（`min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`）+ `.rv-hidden`（9px，`flex:0 0 auto`）。
  - col4 `.rv-id`：9.5px mono `--ark-muted`，右对齐。
- 选中态：`background:var(--ark-scan); outline:1px solid rgba(24,209,255,.45); outline-offset:-1px;`。**不用 box-shadow**，也**不抢左沿竖条**——竖条属于类别，选中属于行。
- 为什么：两个相邻小方块（复选框 + 色块）在 12px 字号下会被读成「两个勾选框」；3px 竖条的长宽比天然不像控件，同时它沿整行高度标注类别，扫视时眼睛沿左沿就能分块。

---

## 6. 左面板类别行

- 结构：`.cls-list li{display:grid; grid-template-columns:var(--ark-bar) 18px minmax(0,1fr) auto; align-items:center; column-gap:8px; height:28px; padding:0 8px 0 0;}`（删掉 `padding-left:14px`，竖条自己就是缩进标记）
  - col1 `.cls-bar`：`width:var(--ark-bar); height:16px`，类别色。
  - col2 `input[type=checkbox]`：16×16，`accent-color:var(--ark-signal)`；点击目标由外层 `label.chk` 撑到整行 28px。
  - col3 `.cls-label`：12.5px，`overflow:hidden; text-overflow:ellipsis`。
  - col4 `.cls-n`：10.5px mono `--ark-muted`，`tabular-nums`，右对齐。
- 分组标题 vs 类别行：用**三种不同的"重量"**分层，不靠字号堆叠。

  | | 底色 | 左沿竖条 | 复选框 | 字 |
  |---|---|---|---|---|
  | 分组 `.group-head` | `--ark-field` 通栏填充 | 无 | 有（整组） | 11.5px 半粗，字距 .3px |
  | 类别 `.cls-list li` | 透明 | 3px 类别色 | 有（单项） | 12.5px 常规 |
  | 组说明 `.group-hint` | 透明 | 无 | 无 | 11px `--ark-muted`，左缩进 `calc(var(--ark-bar) + 8px)` |

- 组间 `border-top:1px solid var(--ark-line-strong)`，组内行之间**不加线**。
- 为什么：填充 = 容器，竖条 = 类别，两套不重叠的语法。原来是「方块 + 方块」两个同形符号挨着，必须读标签才知道哪个能勾。副作用收益：竖条让类别色成为一列节奏，扫 4 组 11 个类别时不用逐字读。

---

## 7. 统一弹窗外壳（7 个窗，一套语法）

**唯一的 DOM 让步**：每个窗根加 `class="dlg"`，可滚动区加 `dlg-body`，底部操作条加 `dlg-foot`（`.wizard` 无 body 包裹层，见下方例外）。其余全用选择器组。

- 遮罩组 `:is(.help-mask, .wizard-mask, .ds-mask)`：`position:fixed; inset:0; z-index:1050; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(6,10,12,.72); backdrop-filter:blur(2px);`（把 `.wizard-mask` 的 .78 / blur 6px 统一到这个值）
- 窗根 `.dlg`：`width:min(var(--dlg-w), calc(100vw - 48px)); max-height:calc(100vh - 48px); display:flex; flex-direction:column; background:var(--ark-panel); border:1px solid var(--ark-line-strong); border-radius:0; box-shadow:none; overflow:hidden;`
  三条硬改：**圆角 14/12/11 → 0**；**投影 → 无**（分离感来自遮罩压暗 + 1px 强边框）；**根不再滚动**。
- 宽度三档（只有这三档）：`.dlg{--dlg-w:620px}`；`.help-dialog{--dlg-w:680px}`（帮助正文最长）；`.detect-settings{--dlg-w:460px}`（参数最少）。
- 头部 `:is(.help-head, .wizard-head, .ds-head)`：`flex:0 0 auto; display:grid; grid-template-columns:auto minmax(0,1fr) auto; align-items:center; gap:12px; height:56px; padding:0 20px; border-bottom:1px solid var(--ark-line-strong);`
  标题收口到 15px 半粗（`.wizard-head h1` 25px → 20px 主引导例外）；索引 `.dlg-idx`（mono 9.5px `--ark-signal`，形如 `04 / 复核`）放标题前，与面板头、命令条同一套索引语法；关闭 `.help-close` 提到 28×28。
- 滚动区 `:is(.help-body, .dlg-body)`：`flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:16px 20px;`
- 吸底操作条 `:is(.help-foot, .wizard-foot, .dlg-foot)`：`flex:0 0 auto; display:flex; justify-content:flex-end; gap:8px; padding:12px 20px; border-top:1px solid var(--ark-line-strong); background:var(--ark-panel);` —— 用真 flex 定位，**不用 `position:sticky`**（sticky 在 `overflow:hidden` 的根里不生效，这正是原来两处被裁的原因之一）。
- **`.wizard` 例外**（无 body 层，只能改 CSS）：`.wizard{overflow-y:auto; overscroll-behavior:contain}`；`.wizard-head{position:sticky; top:0; z-index:1; margin:-26px -28px 0; padding:26px 28px 14px; background:var(--ark-panel)}`；`.wizard-foot{position:sticky; bottom:-20px; margin:0 -28px -20px; padding:16px 28px 20px; background:var(--ark-panel)}`。负 margin 抵消根 padding，让 sticky 贴到真实边缘。
- Esc / 遮罩语义（全窗一致）：
  - `Esc` = 关闭；唯一例外是 `busy`（检测中/导出中）——此时 Esc 无效、按钮禁用、关闭键 `disabled`（复用现有 `.help-close:disabled`）。
  - 点遮罩 = 关闭，**仅限可丢弃的窗**（帮助、派生说明、更多菜单）；含表单输入的窗（引导、检测参数、导出）点遮罩**不关**，避免误触丢参数。
  - 破坏性确认窗（删除、放弃）焦点默认落「取消」。
- 入场：`@keyframes dlg-in{from{opacity:0; transform:translateY(6px)}}`；窗 `animation:dlg-in var(--ark-t-fast) var(--ark-ease)`，遮罩 `opacity` 120ms。`@media (prefers-reduced-motion:reduce){.dlg{animation:none} :is(.help-mask,.wizard-mask,.ds-mask){animation:none}}`
- 为什么：三套外壳真正的差异不在外观，而在**滚动归属**——一个根滚（头脚跟着跑）、一个 body 滚但没给头部留位（内容被裁）、一个整块 absolute 没高度上限（滚轮滚到页面上）。把滚动权收归 body 一层，7 个窗就只剩宽度一个变量。

---

## 8. 状态栏：1 行日志 + 可展开

- 高度：`--status-h` 默认 **56px**（原 120）；展开态 **168px**；拖拽范围改 56–320（`Resizer` 的 min 同步改）。
- 结构（不改 DOM，只改 grid）：`.statusbar{display:grid; grid-template-columns:minmax(0,auto) minmax(0,1fr); grid-template-rows:auto minmax(0,1fr); gap:12px; height:var(--status-h); padding:6px 12px; overflow:hidden}`
- 日志折叠：`.sb-logs{display:flex; flex-direction:column; overflow:hidden}` + `.sb-logs.is-1line .log-line:not(:last-child){display:none}`（日志按时间追加，最后一条即最新）；折叠态给最后一条加 `white-space:nowrap; overflow:hidden; text-overflow:ellipsis`。
- 展开控件 `.sb-more`：28×28，放 `.sb-left` 末尾（`margin-left:auto`），`⌃/⌄` + `aria-expanded`；点击给 `.statusbar` 加 `.is-open`（`--status-h:168px`）。与顶部拖拽手柄并存：拖 = 任意高度，点 = 两档。
- 900px 宽下的取舍（`.sb-left` 由 340px 改 `auto`，日志吃剩余）：

  | 元信息 | ≤980px | 为什么可以隐藏（它在别处还有） |
  |---|---|---|
  | 在线点 + 文案 | 留 6px 点，文案 `display:none` | 「影像已就绪」在步进器第 01 步副标里；点必须留，因为**离线**是唯一需要立刻看见的状态 |
  | `ROI：已圈选/未圈选` | 隐藏 | `.ark-kicker` 有 `ROI` 段 |
  | `47130×44686` | 隐藏 | `.ark-kicker` 有同一串；`3.3 cm/px` 保留（它只在检测参数与导出报告里，主屏别处没有） |
  | `加速结构` | 隐藏 | 检测启动时日志里有一条完整打印 |
  | `人工编辑 +0/−0/✎0` | 隐藏 | 右面板复核页签的 `已改过 / 人工新增` 计数同源同值 |

  CSS：`@media (max-width:980px){.sb-left .sb-opt{display:none}}`，`.sb-opt` 加在上述四项外层。**没有一项是"只在这里有"的信息被隐藏。**
- 为什么默认只留 1 行：6 分钟检测里日志是流水，用户真正看的是最后一条；把 120px 常态让给地图，需要回看时再展开，而不是让状态栏长期占掉 1/8 屏高。

---

## 附录 · 落地检查清单

- **青色预算**：主屏同屏可见青色元素 ≤ 4 处（命令条竖条 / 底边规则线 / 选中片或选中行 / 面板索引）。超过就说明有一处该降成 `--ark-line-strong`。
- **圆角归零**：现存 `border-radius` 8/11/12/14/999 共 5 档，全部改 0；胶囊 `.next-pill` 随卡片一起删除。
- **断点表**：`1180`（折左面板 → 竖轨）/ `980`（折右面板 + 状态栏瘦身）/ `860`（kicker 只留 BLOCK·STEP）/ `760`（工具栏步进器横滚，`flex-wrap:nowrap`，右侧图标组 `flex:0 0 auto` 不参与收缩——这是 900×760 崩坏的直接原因：`.toolbar{flex-wrap:wrap}` 让图标组把步进器挤断行）。
- **禁止**：新增第二个信号色、卡片式四边盒、任何 `box-shadow`（遮罩压暗除外）、`font-size < 9px`、正文 `< 12px`、交互目标 `< 28px`。
