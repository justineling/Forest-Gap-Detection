# 界面设计规范 · Ark UI（工业信息系统）

> 2026-10-24 起，桌面端视觉按《Ark UI 设计系统》重做。本文只记**这个项目怎么落地**，
> 不复制规范原文（规范在 `~/.workbuddy-ai/skills/ark-ui/`）。

## 1. 设计契约（改样式前先读）

```
family   ark        黑白青工业信息系统（近黑底 / 纸白字 / 青色信号）
depth    2 / moderate
证据      design-language.md「Stage plus instrumentation / Editorial hierarchy /
          Controlled accent / Layered flatness」+ recipes.md「Ark」+ depth-levels 的 2 级清单
主屏任务  一眼看清「当前在哪一块、走到第几步、下一步点什么」，其余面积留给地图
不做什么  不做启动序列、不做角色美术、不加第二信号色、不用圆角 / 卡片 / 投影
```

**为什么选 ark**：这个工具的本质是"看一张大影像 + 一堆读数"，ark 的
*stage plus instrumentation*（舞台 + 边缘仪器）正好是这件事的形状；青色作为唯一信号色，
在深色影像上辨识度最高，也不会和类别色（数据色）打架。

**为什么是 2 级**：产品型 UI 的默认档。外壳与共享控件（工具栏 / 步进器 / 面板 / 弹窗 /
菜单 / 状态栏）全覆盖 + 一层蓝图舞台（地图四角括号 + 底纹），不做多区舞台与逐屏编排。

## 2. 两层结构

| 层 | 文件 | 职责 |
|---|---|---|
| 布局层 | `desktop/src/styles.css` | 网格、定位、响应式、动画（别动布局） |
| 设计层 | `desktop/src/ark.css` | 外壳语法、索引、细线、信号色、动效 |

`main.tsx` 里 **`ark.css` 必须在 `styles.css` 之后 import** —— 顺序反了整层静默失效。
改配色/语法只改设计层；改布局只改布局层。

## 3. 令牌（`styles.css` 的 `:root`）

| 用途 | 变量 | 值 |
|---|---|---|
| 舞台底（近黑，不是纯黑） | `--ark-ink` | `#080a0b` |
| 面板 / 浮层 | `--ark-panel` | `#0c1114` |
| 输入底 | `--ark-field` | `#141b1f` |
| 主线 / 次线 | `--ark-line` / `--ark-line-strong` | `#2b353a` / `#3d494f` |
| 主文字（纸白，不是纯白） | `--ark-paper` | `#f4f6f6` |
| 次要文字 | `--ark-muted` | `#8d9396` |
| **唯一信号色** | `--ark-signal` | `#18d1ff` |
| 状态：已验证 / 在线 | `--ark-state` | `#c8eb21` |
| 状态：注意 / 错误 | `--ark-warn` / `--ark-error` | `#ffb020` / `#ff5a5f` |

旧的 `--bg/--panel/--text/--dim/--accent` 保留为**别名**（值换成 ark 的）——
3000 行样式里引用 300+ 次，改名只产生纯机械的大 diff。

**为什么近黑不纯黑**：纯黑会和深色影像焊死，看不出地图边界；`#080a0b` 留了一点分离度。

## 4. 语法（这一层决定"像不像 ark"）

| 元素 | 做法 |
|---|---|
| 外壳 | 56px 黑顶栏：品牌块（压缩体大写 + 微标签 + 左侧青色信号条）→ 步进器 → 工具图标 |
| 索引条 | 顶栏下方 26px 等宽小字：`BLOCK / STEP 02/05 / RECORDS / SERVICE`，**只放真实数据** |
| 步进器 | `01`–`05` 编号 + CJK 标签；当前步 = 青色文字 + **2px 青色下划线**（全系统唯一的"我在哪"信号） |
| 面板标题 | `01 / 图层与类别`、`02 / 复核` —— 索引用等宽青色，标题用 CJK 半粗 |
| 读数块 | **不做卡片**：一条 1px 顶线 + 21px 压缩体大数字 + 11px 微标签（Editorial hierarchy） |
| 分组 | 只用横线分隔，不用盒子（盒子会把 4 个分组读成 4 张卡片） |
| 按钮 | 方形 1px 描边；主操作 = 青色实心 + 深色字 + 左侧 3px 信号条；悬停只改色 |
| 弹窗 | 黑面 + 1px 边 + **顶部 2px 青色规则线**；入场是 clip-path 自上而下揭开（位移+裁切，不是缩放） |
| 检测参数窗 | 与其它弹窗**同一层**（`.ds-mask`，z-index 1050）：居中 + 窗内自滚 + 标题吸顶 / 主操作吸底 |
| 地图舞台 | 左上/右下**两个角括号**（1px 青色 55%）+ 全屏 45° 细斜纹底（1.4% 不透明） |
| 状态栏 | 底部等宽元信息基线；在线点用 `--ark-state` |
| 动效 | 直接交互 180–220ms；只有"检测中"的进度填充做 1.8s 呼吸（全系统唯一循环动画） |

## 4.1 两条容易踩的布局约束

1. **工具栏必须有确定高度**（`height: 56px`）。只写 `min-height` 时，步进器的
   `height: 100%` 会解析成 `auto`，当前步那条 2px 下划线就贴在第二行文字上
   （用户截图里"运行中"被线切了）。
2. **模态不要用 `position: absolute`**。绝对定位的后代同样计入文档可滚动区域 ——
   参数窗内容一长就把整页撑出滚动条，滚轮滚的是页面而不是窗内。用
   `position: fixed` 遮罩 + `max-height` + `overflow-y: auto` + `overscroll-behavior: contain`。

## 5. 有意偏差（都不是遗漏）

1. **语义状态色有三个**（青=信号、酸绿=已验证、琥珀/红=注意/错误）。规范说"一个信号色"，
   但这是数据工具：过期结果与错误必须能和"正常选中"区分。三个里只有青色进入装饰层，
   另外两个只出现在小面积文字/左沿。
2. **窄窗（≤1180px）恢复步骤标签**。`styles.css` 原本在这个断点把除当前步以外的标签全藏了，
   导航退化成 `01 02 03 04 05` 五个光秃秃的编号 —— 规范明令禁止"把决策 UI 压成无标签编号"。
   设计层恢复了标签，让步进器横向滚动；真正省掉的只有 `.sr-sub`（副信息在索引条里也有）。
3. **类别色仍是数据色**（`lib/classes.ts` 的 9 个）。它们同时用于地图填充与图例，
   属"产品数据"而非装饰；已按深底提亮一档（见 `CLASS_STYLES`）。

## 6. 验收

```bash
cd desktop && npx tsc --noEmit            # 0 错
cd desktop && npm test                     # 810 项
node desktop/tests/e2e/verify_render.mjs   # 171 项（需 dev server），出 12 张截图
node desktop/tests/e2e/shot-narrow.mjs     # 窄窗 900×760，检查横向溢出
node ~/.workbuddy-ai/skills/ark-ui/scripts/audit-ark-ui.mjs desktop/src/ark.css
```

审计基线：**0 error / 0 warning**（12 项 pass）。

窄窗另有两个尺寸可跑：`W=760 H=900 NAME=narrow-760x900 node desktop/tests/e2e/shot-narrow.mjs`。
