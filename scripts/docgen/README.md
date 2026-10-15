# 文档生成器

用脚本生成 HTML 文档，好处是：**改数据 → 重跑 → 文档自动更新**，
不用手工去 HTML 里翻数字。

## 文件

| 文件 | 产出 | 说明 |
|---|---|---|
| **`build_all.py`** | — | **一键生成全部文档 + 自动校验**（推荐入口） |
| `common.py` | — | 公共部件：CSS 样式表、页面外壳 `shell()`、通用 SVG 片段 |
| `gen_algo_pro.py` | `docs/03-算法教学/算法说明与演进史.html` | 算法权威说明（专业版）：8 步处理链 + 12 阶段演进史 + 数据速查 |
| `gen_algo_lite.py` | `docs/03-算法教学/算法说明与演进史-小白版.html` | 同上的人话版：闯 8 道关 + 11 次尝试 |
| `gen_gdrive.py` | `docs/05-环境与部署/跨机器协同-GoogleDrive放置清单.html` | 跨机器协同清单，**体积为脚本实时统计**，不会过期 |

## 用法

```bash
# ★ 一条命令生成全部（推荐）
python scripts/docgen/build_all.py

# 只生成其中某几份
python scripts/docgen/build_all.py --only algo --only lite

# 航测原产物不在默认位置时（影响体积统计）
python scripts/docgen/build_all.py --wgr-dir "E:/航测/WGR"
# 或设环境变量
set WGR_DIR=E:/航测/WGR

# 跳过生成后的校验 / 精简输出
python scripts/docgen/build_all.py --no-check --quiet
```

`build_all.py` 会依次跑三个生成器，**最后自动校验全部 `docs/` 下的 HTML**
（有无外部相对引用、有无 f-string 占位符残留），有问题会返回非零退出码。

也可以单独跑某个生成器（调试时方便）：

```bash
python scripts/docgen/gen_algo_pro.py
python scripts/docgen/gen_algo_lite.py
python scripts/docgen/gen_gdrive.py
```

所有脚本从自身位置推断项目根（`scripts/docgen/` 的上两级），**换机器无需改代码**。

## 约定（改脚本时请遵守）

1. **图片一律内联**：用内联 SVG 或 base64 data URI，**禁用相对路径**
   （预览面板只给单文件，相对路径会显示不出来）
2. **中文文件名**，输出到 `docs/` 下对应主题的子目录
3. **HTML 必出双版本**（专业版 + 小白版）—— 除纯操作清单类文档
4. 改完跑一次，并检查生成物无 `{变量名}` 残留

## 校验

`build_all.py` 已内置校验（跑完自动执行）。手动校验：

```bash
python scripts/docgen/build_all.py --only algo   # 任意一个生成器，校验都会跑
```

或者用下面这段独立脚本：

```python
import re
from pathlib import Path

bad = 0
for f in sorted(Path("docs").rglob("*.html")):
    h = f.read_text(encoding="utf-8")
    ext = [u for u in re.findall(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', h)
           if not u.startswith(("#", "data:", "http", "//"))]
    ph = re.findall(r'\{(?:mb|sizes|ext_sizes|BODY|CSS|shell|svg_)[^}]*\}', h)
    if ext or ph:
        print(f"⚠️ {f}: 外部引用={ext} 占位符={ph}")
        bad += 1
print("✅ 全部干净" if not bad else f"{bad} 个文件有问题")
```

## 历史

2026-10-15 从 `.workbuddy-ai/tmp/docgen/` 移入版本控制
（tmp 目录不纳入 git，随时可能被清理），并新增 `build_all.py` 一键入口。
