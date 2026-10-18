"""一页汇总报告生成器（单文件自包含 HTML）。

设计红线（交接简报 §11 第 2 条）：
  · **100% 单文件自包含** —— 内联 CSS、手写内联 SVG，零外部图片 / CDN / 字体；
  · 兼容浏览器 `Ctrl + P` 一键打印成 A4 PDF；
  · **浅色主题**：应用界面是深色，但交给主管签字的东西必须省墨、可黑白打印。

用法（在 tile_server 的 /export 里调用）：

    from report_summary import build_report_html
    html = build_report_html(data)      # data 结构见 build_report_html 的 docstring

单独自检：

    python scripts/report_summary.py --selftest
"""

from __future__ import annotations

import html
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# 与前端 lib/classes.ts 的分组配色保持一致（浅色版本，打印友好）
TIER_COLORS = {
    "definite_plant": "#d9542b",
    "review": "#b8860b",
    "not_needed": "#8a8a8a",
    "unplantable": "#5b6b7a",
}


def _e(v: Any) -> str:
    return html.escape("" if v is None else str(v))


def _n(v: Any, nd: int = 0) -> str:
    try:
        return f"{float(v):,.{nd}f}"
    except (TypeError, ValueError):
        return "—"


def _bar_svg(tiers: list[dict]) -> str:
    """横向条形图：每档一行，宽度按面积占比。纯 SVG，无外部依赖。"""
    if not tiers:
        return ""
    max_area = max((float(t.get("area_sqm") or 0) for t in tiers), default=0.0) or 1.0
    row_h = 34
    label_w = 108
    bar_w = 420
    h = row_h * len(tiers) + 8
    parts = [
        f'<svg viewBox="0 0 620 {h}" width="100%" role="img" '
        f'aria-label="各口径面积占比" xmlns="http://www.w3.org/2000/svg">'
    ]
    for i, t in enumerate(tiers):
        y = i * row_h + 4
        area = float(t.get("area_sqm") or 0)
        w = max(2.0, bar_w * area / max_area)
        color = TIER_COLORS.get(str(t.get("key")), "#6b7280")
        parts.append(
            f'<text x="0" y="{y + 15}" font-family="system-ui,-apple-system,Segoe UI,sans-serif" '
            f'font-size="12.5" fill="#222">{_e(t.get("label"))}</text>'
        )
        parts.append(
            f'<rect x="{label_w}" y="{y + 4}" width="{bar_w}" height="16" rx="3" fill="#eef1f3"/>'
        )
        parts.append(
            f'<rect x="{label_w}" y="{y + 4}" width="{w:.1f}" height="16" rx="3" fill="{color}"/>'
        )
        parts.append(
            f'<text x="{label_w + bar_w + 10}" y="{y + 16}" '
            f'font-family="system-ui,-apple-system,Segoe UI,sans-serif" font-size="12" fill="#444">'
            f'{_n(area)} m² · {int(t.get("count") or 0)} 块</text>'
        )
    parts.append("</svg>")
    return "".join(parts)


def _stack_svg(tiers: list[dict], total_area: float) -> str:
    """一根堆叠条，直观看出"可补种"占全园多少。"""
    total_area = total_area or sum(float(t.get("area_sqm") or 0) for t in tiers) or 1.0
    w_total = 600
    x = 0.0
    parts = [
        '<svg viewBox="0 0 600 26" width="100%" role="img" aria-label="面积构成" '
        'xmlns="http://www.w3.org/2000/svg">'
    ]
    for t in tiers:
        area = float(t.get("area_sqm") or 0)
        if area <= 0:
            continue
        w = w_total * area / total_area
        color = TIER_COLORS.get(str(t.get("key")), "#6b7280")
        parts.append(
            f'<rect x="{x:.1f}" y="0" width="{w:.1f}" height="26" fill="{color}"/>'
        )
        x += w
    parts.append("</svg>")
    return "".join(parts)


def build_report_html(d: dict) -> str:
    """生成报告 HTML。

    `d` 结构（缺字段一律按 0 / 空处理，不会抛错）：

        project      str   工程名（默认 Forest Gap Detection）
        generated_at str   生成时间（已格式化）
        image        dict  {name, width, height, res_m, crs}
        roi          dict  {has_roi, area_sqm}
        grid         dict  {plant_pitch_m, row_pitch_m, azimuth_deg, density_per_ha}
        clearance_m  float 排坑退让距离
        tiers        list  [{key, label, count, area_sqm, hint}]
        estimate     dict  {by_grid, by_area, divergence_pct,
                            points_total, points_grid, points_slot}
        audit        dict  {added, edited, deleted}
        top          list  [{gap_id, cls_label, area_sqm, plants, lon, lat}]
    """
    img = d.get("image") or {}
    roi = d.get("roi") or {}
    grid = d.get("grid") or {}
    est = d.get("estimate") or {}
    audit = d.get("audit") or {}
    tiers = d.get("tiers") or []
    top = d.get("top") or []

    total_area = sum(float(t.get("area_sqm") or 0) for t in tiers)
    total_count = sum(int(t.get("count") or 0) for t in tiers)
    definite = next((t for t in tiers if t.get("key") == "definite_plant"), {})
    def_area = float(definite.get("area_sqm") or 0)
    share = (def_area / total_area * 100) if total_area else 0.0

    tier_rows = "".join(
        "<tr>"
        f'<td><span class="sw" style="background:{TIER_COLORS.get(str(t.get("key")), "#6b7280")}"></span>'
        f'{_e(t.get("label"))}</td>'
        f'<td class="num">{int(t.get("count") or 0):,}</td>'
        f'<td class="num">{_n(t.get("area_sqm"))}</td>'
        f'<td class="num">{(float(t.get("area_sqm") or 0) / total_area * 100) if total_area else 0:.1f}%</td>'
        f'<td class="hint">{_e(t.get("hint", ""))}</td>'
        "</tr>"
        for t in tiers
    )

    top_rows = "".join(
        "<tr>"
        f'<td class="num">{i + 1}</td>'
        f'<td class="mono">{_e(r.get("gap_id"))}</td>'
        f'<td>{_e(r.get("cls_label"))}</td>'
        f'<td class="num">{_n(r.get("area_sqm"))}</td>'
        f'<td class="num"><b>{_n(r.get("plants"))}</b></td>'
        f'<td class="mono">{float(r.get("lon") or 0):.6f}, {float(r.get("lat") or 0):.6f}</td>'
        "</tr>"
        for i, r in enumerate(top)
    )

    div = float(est.get("divergence_pct") or 0)
    div_note = (
        f'<span class="warn">差异 {div:.1f}%，形状破碎或退让吃掉面积，建议复核</span>'
        if div > 30
        else f'<span class="ok">差异 {div:.1f}%，两个口径互相印证</span>'
    )

    scope = (
        f'圈选范围（{_n(roi.get("area_sqm"))} m²）'
        if roi.get("has_roi")
        else "整幅影像"
    )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>补种勘察一页报告 · {_e(img.get("name") or "Forest Gap Detection")}</title>
<style>
  :root {{
    --ink: #1b2126;
    --ink-2: #4a5560;
    --line: #d7dee3;
    --bg-soft: #f5f7f8;
    --accent: #1f7a4d;
    --warn: #b45309;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0;
    padding: 26px 30px 40px;
    background: #fff;
    color: var(--ink);
    font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-size: 13px;
    line-height: 1.6;
    max-width: 900px;
    margin-inline: auto;
  }}
  h1 {{ font-size: 21px; margin: 0 0 4px; letter-spacing: .3px; }}
  h2 {{
    font-size: 14px; margin: 22px 0 8px; padding-bottom: 4px;
    border-bottom: 1px solid var(--line); color: var(--ink);
  }}
  .sub {{ color: var(--ink-2); font-size: 12px; margin: 0 0 16px; }}
  .cards {{ display: flex; flex-wrap: wrap; gap: 8px; }}
  .card {{
    flex: 1 1 130px; border: 1px solid var(--line); border-radius: 8px;
    padding: 8px 10px; background: var(--bg-soft);
  }}
  .card .k {{ font-size: 11px; color: var(--ink-2); }}
  .card .v {{ font-size: 14px; font-weight: 600; margin-top: 1px; }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12.5px; }}
  th, td {{ padding: 5px 6px; border-bottom: 1px solid var(--line); text-align: left; }}
  th {{ font-size: 11.5px; color: var(--ink-2); font-weight: 600; background: var(--bg-soft); }}
  td.num, th.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
  td.hint {{ color: var(--ink-2); font-size: 11.5px; }}
  .mono {{ font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }}
  .sw {{ display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; }}
  .kpi {{ display: flex; gap: 22px; flex-wrap: wrap; margin: 8px 0 4px; }}
  .kpi div {{ }}
  .kpi .n {{ font-size: 20px; font-weight: 700; }}
  .kpi .l {{ font-size: 11.5px; color: var(--ink-2); }}
  .ok {{ color: var(--accent); }}
  .warn {{ color: var(--warn); font-weight: 600; }}
  .note {{
    margin-top: 18px; padding: 10px 12px; border-radius: 8px;
    background: var(--bg-soft); color: var(--ink-2); font-size: 11.5px; line-height: 1.7;
  }}
  .foot {{ margin-top: 14px; color: var(--ink-2); font-size: 11px; }}
  @media print {{
    @page {{ size: A4 portrait; margin: 12mm 12mm 14mm; }}
    body {{ padding: 0; max-width: none; font-size: 11.5px; }}
    h2 {{ page-break-after: avoid; }}
    table {{ page-break-inside: auto; }}
    tr {{ page-break-inside: avoid; }}
    .note {{ background: #fff; border: 1px solid var(--line); }}
  }}
</style>
</head>
<body>

<h1>补种勘察一页报告</h1>
<p class="sub">
  {_e(d.get("project") or "Forest Gap Detection")} ·
  生成于 {_e(d.get("generated_at") or datetime.now().strftime("%Y-%m-%d %H:%M"))}
</p>

<h2>一、影像与检测参数</h2>
<div class="cards">
  <div class="card"><div class="k">正射影像</div><div class="v" style="font-size:12.5px">{_e(img.get("name") or "—")}</div></div>
  <div class="card"><div class="k">影像尺寸</div><div class="v">{_n(img.get("width"))} × {_n(img.get("height"))} px</div></div>
  <div class="card"><div class="k">地面分辨率</div><div class="v">{_n(img.get("res_m"), 3)} m/px</div></div>
  <div class="card"><div class="k">坐标系</div><div class="v" style="font-size:12.5px">{_e(img.get("crs") or "EPSG:4326")}</div></div>
</div>
<div class="cards" style="margin-top:8px">
  <div class="card"><div class="k">检测范围</div><div class="v" style="font-size:12.5px">{_e(scope)}</div></div>
  <div class="card"><div class="k">株距 × 行距</div><div class="v">{_n(grid.get("plant_pitch_m"), 2)} × {_n(grid.get("row_pitch_m"), 2)} m</div></div>
  <div class="card"><div class="k">行向方位角</div><div class="v">{_n(grid.get("azimuth_deg"), 2)}°</div></div>
  <div class="card"><div class="k">排坑退让</div><div class="v">{_n(d.get("clearance_m"), 1)} m</div></div>
</div>

<h2>二、业务口径汇总</h2>
{_stack_svg(tiers, total_area)}
<p class="sub" style="margin:6px 0 10px">全园共 <b>{total_count:,}</b> 个多边形，合计 <b>{_n(total_area)}</b> m²；
其中可直接用于苗木量的「确定需补种」为 <b class="ok">{int(definite.get("count") or 0):,}</b> 块 /
<b class="ok">{_n(def_area)}</b> m²，占 <b>{share:.1f}%</b>。</p>
<table>
  <thead><tr><th>口径</th><th class="num">块数</th><th class="num">面积 (m²)</th><th class="num">占比</th><th>说明</th></tr></thead>
  <tbody>{tier_rows}</tbody>
</table>

<h2>三、苗木采购与放样估算</h2>
<div class="kpi">
  <div><div class="n ok">{_n(est.get("by_grid"))}</div><div class="l">网格排坑法（权威放样点数）</div></div>
  <div><div class="n">{_n(est.get("by_area"))}</div><div class="l">面积折算法（快速估算）</div></div>
  <div><div class="n">{_n(est.get("points_total"))}</div><div class="l">实际生成放样点</div></div>
</div>
<p class="sub" style="margin:2px 0 0">
  放样点构成：连片空地排坑 <b>{_n(est.get("points_grid"))}</b> 个 + 单株空缺 <b>{_n(est.get("points_slot"))}</b> 个 ·
  {div_note}
</p>

<h2>四、人工复核留痕</h2>
<div class="kpi">
  <div><div class="n">{_n(audit.get("added"))}</div><div class="l">人工新增（补画漏检）</div></div>
  <div><div class="n">{_n(audit.get("edited"))}</div><div class="l">人工改判（含边界修正）</div></div>
  <div><div class="n">{_n(audit.get("deleted"))}</div><div class="l">人工剔除（误报）</div></div>
</div>
<p class="sub" style="margin:2px 0 0">
  以上为本交付包相对算法原始结果的净改动；改判与剔除的原始记录保存在交付包的
  <span class="mono">gaps-all-wgs84.geojson</span> 属性字段中（<span class="mono">edited</span> /
  <span class="mono">original_class</span> / <span class="mono">source</span>）。
</p>

<h2>五、重点连片空地 Top {len(top)}</h2>
<table>
  <thead><tr><th class="num">#</th><th>编号</th><th>类别</th><th class="num">面积 (m²)</th><th class="num">预计株数</th><th>中心经纬度</th></tr></thead>
  <tbody>{top_rows or '<tr><td colspan="6" style="color:#8a8a8a">无数据</td></tr>'}</tbody>
</table>

<div class="note">
  <b>口径说明</b><br>
  ① 「确定需补种」= 连片空地 + 株位空缺，可直接用于苗木采购；「待复核」需人工确认后才计入；
  「无需补种」为林间空隙（正常行间缝隙）；「不可种植」为道路 / 水体 / 办公生活区 / 未开发林，已按像素扣除。<br>
  ② 排坑法按 <span class="mono">{_n(grid.get("plant_pitch_m"), 2)} m × {_n(grid.get("row_pitch_m"), 2)} m</span>
  三角种植网格逐格判定，退让 <span class="mono">{_n(d.get("clearance_m"), 1)} m</span>；
  面积法按 66.67 m²/株折算（150 株/公顷）。两者差异大于 30% 时说明斑块形状破碎，应以排坑法为准。<br>
  ③ 本报告为单文件 HTML，可直接 <span class="mono">Ctrl + P</span> 打印为 A4 PDF，无外部依赖。
</div>

<p class="foot">Forest Gap Detection · 补种勘察一页报告 · 由桌面端自动生成</p>

</body>
</html>
"""


# ============================================================================
#  自检
# ============================================================================
def _selftest() -> int:
    sample = {
        "project": "WGR17 油棕园",
        "generated_at": "2026-10-18 17:40",
        "image": {"name": "WGR17-002.tif", "width": 47130, "height": 44686,
                  "res_m": 0.033, "crs": "EPSG:4326"},
        "roi": {"has_roi": True, "area_sqm": 1_234_567},
        "grid": {"plant_pitch_m": 8.35, "row_pitch_m": 7.23,
                 "azimuth_deg": 0.67, "density_per_ha": 161.7},
        "clearance_m": 0.5,
        "tiers": [
            {"key": "definite_plant", "label": "确定需补种", "count": 702,
             "area_sqm": 309143, "hint": "连片空地 + 株位空缺"},
            {"key": "review", "label": "待复核", "count": 465,
             "area_sqm": 40593, "hint": "证据不足"},
            {"key": "not_needed", "label": "无需补种", "count": 251,
             "area_sqm": 13277, "hint": "林间空隙"},
            {"key": "unplantable", "label": "不可种植", "count": 308,
             "area_sqm": 71715, "hint": "道路/水体/建筑/未开发"},
        ],
        "estimate": {"by_grid": 3691, "by_area": 4637, "divergence_pct": 25.7,
                     "points_total": 3691, "points_grid": 3400, "points_slot": 291},
        "audit": {"added": 12, "edited": 37, "deleted": 64},
        "top": [
            {"gap_id": "r038912_c020480-G0001", "cls_label": "连片空地",
             "area_sqm": 5771.53, "plants": 86, "lon": 111.2039, "lat": 1.1838},
        ],
    }
    out = build_report_html(sample)
    # ⚠️ 不能直接搜 "http://" —— 内联 SVG 的 xmlns 就是 http://www.w3.org/2000/svg，
    #    那是**命名空间标识符，不会发起请求**。要查的是真正会拉资源的东西。
    import re as _re
    external = _re.findall(
        r'(?:<link\b[^>]*href|<script\b[^>]*src|<img\b[^>]*src|@import|url\()\s*["\']?(https?:)?//',
        out,
        _re.I,
    )
    checks = [
        ("单文件自包含（无外部 link/script/img/@import）", not external),
        ("无外部图片", "<img" not in out),
        ("有打印样式", "@media print" in out and "A4" in out),
        ("有内联 SVG", "<svg" in out),
        ("含三档口径", "确定需补种" in out and "待复核" in out and "不可种植" in out),
        ("含放样估算", "网格排坑法" in out and "3,691" in out),
        ("含人工留痕", "人工新增" in out and "人工剔除" in out),
        ("含 Top 表", "r038912_c020480-G0001" in out),
        ("含参数卡片", "8.35" in out and "7.23" in out and "0.67" in out),
        ("HTML 结构完整", out.startswith("<!DOCTYPE html>") and out.rstrip().endswith("</html>")),
    ]
    bad = 0
    for label, ok in checks:
        print(f"  [{'OK  ' if ok else 'FAIL'}] {label}")
        if not ok:
            bad += 1
    # 空数据不能崩
    try:
        build_report_html({})
        print("  [OK  ] 空数据不崩")
    except Exception as e:  # noqa: BLE001
        print(f"  [FAIL] 空数据不崩：{e}")
        bad += 1
    print(f"\n{'✅ 全部通过' if bad == 0 else f'❌ {bad} 项失败'}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    if "--demo" in sys.argv:
        p = Path("output/补种勘察一页报告.html")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(build_report_html(json.loads(sys.stdin.read() or "{}")), encoding="utf-8")
        print(p)
        sys.exit(0)
    print("用法：python scripts/report_summary.py --selftest | --demo < data.json")
