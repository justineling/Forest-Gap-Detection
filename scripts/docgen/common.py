# -*- coding: utf-8 -*-
"""HTML 文档生成公共部件（CSS + 页面外壳 + 通用 SVG 片段）。"""

CSS = """
:root{--bg:#f7f9f7;--card:#fff;--ink:#1c2620;--sub:#5b6b5f;--line:#e2e8e2;
--green:#2f7d1f;--lime:#7dcc29;--brown:#a8763f;--blue:#2f6fa8;--red:#c0392b;
--amber:#c98a00;--violet:#6b4fa8;--teal:#1f7a7a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font-family:-apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;
line-height:1.78;font-size:15px}
.wrap{max-width:1060px;margin:0 auto;padding:34px 24px 84px}
header{border-bottom:3px solid var(--green);padding-bottom:20px;margin-bottom:30px}
h1{font-size:27px;margin:0 0 8px;letter-spacing:-.4px}
.sub{color:var(--sub);font-size:14px}
h2{font-size:20px;margin:46px 0 14px;padding-left:12px;border-left:4px solid var(--green)}
h3{font-size:16px;margin:28px 0 10px;color:#26382c}
h4{font-size:14.5px;margin:20px 0 8px;color:#37473c}
p{margin:10px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:18px 20px;margin:16px 0;box-shadow:0 1px 3px rgba(0,0,0,.03)}
.lead{font-size:16.5px;background:linear-gradient(180deg,#eef7ea,#fff);
border:1px solid #cfe4c6;border-radius:10px;padding:18px 22px;margin:20px 0}
.lead b{color:var(--green)}
table{width:100%;border-collapse:collapse;margin:14px 0;font-size:13.5px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;
vertical-align:top}
th{background:#f0f5ef;font-weight:600;color:#2b3a2f;font-size:13px}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.mono{font-family:"Cascadia Code",Consolas,monospace;font-size:12.5px}
.sw{display:inline-block;width:15px;height:15px;border-radius:3px;
vertical-align:-3px;margin-right:6px;border:1px solid rgba(0,0,0,.15)}
.tag{display:inline-block;padding:1px 9px;border-radius:10px;font-size:11.5px;
font-weight:600;vertical-align:1px;white-space:nowrap}
.t-ok{background:#dff3d5;color:#2b6b1c}
.t-warn{background:#fdecc8;color:#8a5a00}
.t-bad{background:#fbdcd8;color:#a32b1c}
.t-info{background:#dceaf7;color:#1f5c8a}
.t-gray{background:#e8e8e8;color:#555}
.q{border-left:3px solid var(--blue);background:#f4f9fd;padding:12px 16px;
margin:14px 0;border-radius:0 8px 8px 0}
.warn{border-left:3px solid var(--amber);background:#fffaf0;padding:12px 16px;
margin:14px 0;border-radius:0 8px 8px 0}
.good{border-left:3px solid var(--green);background:#f2faf0;padding:12px 16px;
margin:14px 0;border-radius:0 8px 8px 0}
ul,ol{margin:10px 0;padding-left:24px}
li{margin:6px 0}
code{background:#eef2ee;padding:1px 5px;border-radius:3px;
font-family:"Cascadia Code",Consolas,monospace;font-size:13px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);
color:var(--sub);font-size:12.5px}
.step{display:flex;gap:14px;align-items:flex-start;margin:0 0 4px}
.stepno{flex:0 0 34px;height:34px;border-radius:50%;background:var(--green);
color:#fff;display:flex;align-items:center;justify-content:center;
font-weight:700;font-size:14px}
.steptitle{font-weight:700;font-size:15.5px;padding-top:4px}
.hl{background:#fff8dc;padding:1px 4px;border-radius:3px;font-weight:600}
.verdict{display:flex;gap:12px;align-items:flex-start;padding:13px 16px;
border-radius:8px;margin:12px 0;border:1px solid}
.v-yes{background:#f0f9ec;border-color:#bfe0b0}
.v-no{background:#fdf1ef;border-color:#efc4bb}
.v-part{background:#fffaf0;border-color:#f0dfb8}
.vico{font-size:19px;line-height:1.25}
.tl{position:relative;margin:22px 0 22px 8px;padding-left:30px;
border-left:2px solid #d6e2d6}
.tlitem{position:relative;margin:0 0 26px}
.tlitem::before{content:"";position:absolute;left:-39px;top:6px;width:14px;
height:14px;border-radius:50%;background:var(--green);border:3px solid #fff;
box-shadow:0 0 0 1px #cfe0cf}
.tlitem.bad::before{background:var(--red)}
.tlitem.fix::before{background:var(--amber)}
.tlitem.win::before{background:var(--teal)}
.tldate{font-size:12.5px;color:var(--sub);font-weight:600}
.tlhead{font-size:15.5px;font-weight:700;margin:2px 0 6px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}
.big{font-size:26px;font-weight:700;color:var(--green);line-height:1.2}
.kv{display:flex;justify-content:space-between;padding:7px 0;
border-bottom:1px dashed var(--line)}
.kv:last-child{border-bottom:0}
"""


def shell(title: str, subtitle: str, body: str, accent: str = "#2f7d1f") -> str:
    css = CSS.replace("--green:#2f7d1f", f"--green:{accent}")
    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title>
<style>{css}</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>{title}</h1>
  <div class="sub">{subtitle}</div>
</header>
{body}
</div>
</body>
</html>
"""


def svg_pipeline() -> str:
    """当前 8 步处理链总览。"""
    steps = [
        ("S0", "CHM 生成", "DSM → 去尖峰\n→ mask 水 → DTM", "#1f5c8a"),
        ("S1", "树冠分割", "ExG + seg\n+ CHM 融合", "#2f7d1f"),
        ("S2", "空地分离", "圆盘开运算\n断开窄缝", "#3f8f2a"),
        ("S3", "矢量化", "简化 + 面积门槛\n→ 多边形", "#5aa03a"),
        ("S4", "网格估计", "株距/行距\n+ 错行角", "#7dcc29"),
        ("S5", "空地分类", "4 类\n（株位/空隙/连片/不确定）", "#c98a00"),
        ("S6", "不可种植", "道路/水体\n/办公区", "#a8763f"),
        ("S7", "密度校验", "对比设计密度\n±10% 告警", "#6b4fa8"),
    ]
    W, H = 680, 258
    o = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
         f'style="width:100%;height:auto;font-family:system-ui,sans-serif">']
    bw, gap = 82, 6
    for i, (no, name, desc, col) in enumerate(steps):
        x = 8 + i * (bw + gap)
        o.append(f'<rect x="{x}" y="52" width="{bw}" height="106" rx="8" '
                 f'fill="{col}" fill-opacity="0.13" stroke="{col}" stroke-width="1.6"/>')
        o.append(f'<text x="{x+bw/2}" y="73" font-size="11" font-weight="700" '
                 f'fill="{col}" text-anchor="middle">{no}</text>')
        o.append(f'<text x="{x+bw/2}" y="91" font-size="12" font-weight="700" '
                 f'fill="#1c2620" text-anchor="middle">{name}</text>')
        for j, ln in enumerate(desc.split("\n")):
            o.append(f'<text x="{x+bw/2}" y="{107+j*13}" font-size="9.5" '
                     f'fill="#5b6b5f" text-anchor="middle">{ln}</text>')
        if i < len(steps) - 1:
            o.append(f'<path d="M{x+bw+1} 104 l{gap-2} 0" stroke="#9ab09a" stroke-width="1.8"/>')
    o.append('<text x="8" y="30" font-size="12.5" font-weight="700" fill="#26382c">'
             '输入：正射影像 + DSM + 语义分割 → 输出：空地多边形 + 7 类标签</text>')
    o.append('<text x="8" y="200" font-size="11.5" fill="#5b6b5f">'
             'S1 是核心：把「绿度」与「高度/语义」两类证据融合，'
             '解决草地与油棕在纯 RGB 上不可分的问题</text>')
    o.append('<text x="8" y="220" font-size="11.5" fill="#5b6b5f">'
             '「需补种面积」= 全部空地 − 不可种植（S6）</text>')
    o.append('<text x="8" y="240" font-size="11.5" fill="#c0392b">'
             '注：原「草地回检」判据已退役，仅在缺少 DSM 时作为兜底</text>')
    o.append("</svg>")
    return "".join(o)


def svg_evidence() -> str:
    """双证据融合示意。"""
    W, H = 680, 210
    o = [f'<svg viewBox="0 0 {W} {H}" xmlns="http://www.w3.org/2000/svg" '
         f'style="width:100%;height:auto;font-family:system-ui,sans-serif">']
    def box(x, y, w, h, t, lines, col):
        o.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" '
                 f'fill="{col}" fill-opacity="0.13" stroke="{col}" stroke-width="1.5"/>')
        o.append(f'<text x="{x+w/2}" y="{y+21}" font-size="12.5" font-weight="700" '
                 f'fill="#1c2620" text-anchor="middle">{t}</text>')
        for i, ln in enumerate(lines):
            o.append(f'<text x="{x+w/2}" y="{y+39+i*14}" font-size="10" '
                     f'fill="#5b6b5f" text-anchor="middle">{ln}</text>')
    box(14, 30, 200, 100, "① CHM 冠层高度",
        ["物理量，不受曝光影响", "油棕 8.5 m vs 非树 1.6 m", "救援 >5.2 / 否决 <1.2"], "#1f5c8a")
    box(240, 30, 200, 100, "② DJI 语义分割",
        ["端到端学习，看整株树冠", "tree 61.5% / other 38.5%", "漏检约 20%（域外模型）"], "#2f6fa8")
    box(466, 30, 200, 100, "③ 融合",
        ["树冠 = seg==tree 或 CHM≥5.2", "再否决 CHM<1.2", "分离度 +85.3 个百分点"], "#2f7d1f")
    o.append('<path d="M216 80 l22 0" stroke="#9ab09a" stroke-width="1.8"/>')
    o.append('<path d="M442 80 l22 0" stroke="#9ab09a" stroke-width="1.8"/>')
    o.append('<text x="14" y="160" font-size="11.5" font-weight="700" fill="#2b6b1c">'
             '为什么必须两个一起用（实测互补性）：</text>')
    o.append('<text x="14" y="180" font-size="11" fill="#5b6b5f">'
             '· seg 判 other 但 CHM≥5.2 → 占 other 的 19.2%：CHM 救回 seg 漏检的树</text>')
    o.append('<text x="14" y="197" font-size="11" fill="#5b6b5f">'
             '· seg 判 tree 但 CHM<1.2 → 占 tree 的 2.7%：CHM 否决 seg 的误判</text>')
    o.append("</svg>")
    return "".join(o)
