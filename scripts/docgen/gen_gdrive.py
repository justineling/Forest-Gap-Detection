# -*- coding: utf-8 -*-
"""生成《跨机器协同：Google Drive 放置清单》HTML。"""
import sys, os
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from common import shell

ROOT = Path(__file__).resolve().parent.parent.parent

def du(p: Path) -> int:
    if p.is_file(): return p.stat().st_size
    if not p.exists(): return 0
    t = 0
    for dp, _, fns in os.walk(p):
        for fn in fns:
            try: t += (Path(dp)/fn).stat().st_size
            except OSError: pass
    return t

def mb(n): return f"{n/1024/1024:,.0f} MB" if n >= 1024*1024 else f"{n/1024:,.0f} KB"
def human(n):
    if n >= 1024**3: return f"{n/1024**3:.1f} GB"
    return mb(n)

sizes = {
    "output": du(ROOT/"output"),
    "arcgis": du(ROOT/"output"/"arcgis"),
    "jobs": du(ROOT/"output"/"jobs"),
    "chm": du(ROOT/"output"/"chm.tif"),
    "elev_geojson": du(ROOT/"output"/"wgr17-elev-gaps.geojson"),
}

# 原始数据在不同机器上放在不同目录：公司机 D:/WGR，家里机放在仓库内的
# drone data/。逐个探测取第一个存在的目录。
# ⚠️ 2026-10-17 修：原来硬编码 D:/WGR，在家里机上探不到就把所有体积写成
#    "0 KB"，把一份正确的文档改成了错的 —— 自动重生成文档时务必让路径可移植。
EXT_CANDIDATES = [Path(r"D:/WGR"), ROOT/"drone data", ROOT/"WGR"]
EXT = next((d for d in EXT_CANDIDATES if d.is_dir()), EXT_CANDIDATES[0])
EXT_LABEL = str(EXT).replace("\\", "/")

def ext_du(*names: str) -> int:
    """按候选文件名探测（正射影像公司机叫 WGR17.tif、家里机叫 WGR17-002.tif）。"""
    for n in names:
        s = du(EXT/n)
        if s:
            return s
    return 0

ext_sizes = {
    "dsm.tif": du(EXT/"dsm.tif"),
    "segment.tif": du(EXT/"segment.tif"),
    "tree_info.json": du(EXT/"tree_info.json"),
    "WGR17.tif": ext_du("WGR17.tif", "WGR17-002.tif"),
}
EXT_SMALL = ext_sizes["segment.tif"] + ext_sizes["tree_info.json"]
ORTHO_NAME = "WGR17-002.tif" if du(EXT/"WGR17-002.tif") else "WGR17.tif"
ORTHO_HAS_PYR = (EXT/"WGR17-002.tif.ovr").exists()
# 金字塔可能在文件内部（BigTIFF）而非 .ovr 边车，用「明显大于原始 3.5 GB」判断
ORTHO_SIZE_GB = ext_sizes["WGR17.tif"] / 1024**3
ORTHO_PYR_NOTE = (
    "<br><span style=\"font-size:11.5px;color:var(--muted)\">"
    "（该体积已含瓦片服务建的金字塔，比原始文件多约 1.2 GB；"
    "原始下载体积约 3.5 GB。见 <code>desktop/README.md</code>）</span>"
    if ORTHO_SIZE_GB > 3.9 else ""
)

BODY = f"""
<div class="lead">
这份是<b>跨机器协同的操作清单</b>：为了让公司机与家用机看到同一份结果，
你需要往 Google Drive 放哪些东西、怎么放、以及<b>哪些千万别放</b>。<br><br>
一句话结论：<b>放 <code>output/</code>（检测结果，{mb(sizes['output'])}）+ <code>segment.tif</code> 和 <code>tree_info.json</code>（共 {mb(EXT_SMALL)}）；
{mb(ext_sizes['dsm.tif'])} 的 <code>dsm.tif</code> 和 {human(ext_sizes['WGR17.tif'])} 的正射影像都不用放。</b>
</div>

<h2>一、必须放的：<code>output/</code> 整个目录</h2>
<div class="card">
<div class="kv"><span>整个 output/ 目录</span><span class="mono"><b>{mb(sizes['output'])}</b></span></div>
<div class="kv"><span>├─ arcgis/（ArcGIS 交付包，最重要）</span><span class="mono">{mb(sizes['arcgis'])}</span></div>
<div class="kv"><span>├─ jobs/（瓦片缓存 + 运行日志）</span><span class="mono">{mb(sizes['jobs'])}</span></div>
<div class="kv"><span>├─ chm.tif（冠层高度模型）</span><span class="mono">{mb(sizes['chm'])}</span></div>
<div class="kv"><span>└─ wgr17-elev-gaps.geojson（最新检测结果）</span><span class="mono">{mb(sizes['elev_geojson'])}</span></div>
</div>

<p><b>为什么必须放</b>：</p>
<ul>
<li><code>output/</code> 是<b>运行产物</b>，每次重跑内容全变，进 git 会让仓库迅速膨胀</li>
<li><code>output/arcgis/</code> 是<b>要交给业务方的交付包</b>，两台机器都得能取到</li>
<li><code>output/chm.tif</code> 是海拔证据的输入，缺了它精度会掉（见第四节）</li>
</ul>

<div class="warn"><b>⚠️ 放之前先看一眼时间戳。</b>
<code>output/</code> 随时可能被重跑覆盖。跨机器取用时，
先确认文件时间是不是你要的那一版，避免拿到旧结果。</div>

<h2>二、建议放的：DSM 相关文件（区分"必须"与"可选"）</h2>
<p>这几个文件在 <code>{EXT_LABEL}/</code>，是航测工程的原产物。
<b>它们的必要性差别很大，别一股脑全放</b>：</p>
<table>
<thead><tr><th>文件</th><th class="num">体积</th><th>作用</th><th>必要性</th></tr></thead>
<tbody>
<tr><td class="mono">segment.tif</td><td class="num">{mb(ext_sizes['segment.tif'])}</td>
<td>航测软件 AI 的语义分割（树/水/建筑）</td>
<td><span class="tag t-bad">必须放</span><br>管线<b>运行时直接读它</b>，
缺了精度会明显下降</td></tr>
<tr><td class="mono">tree_info.json</td><td class="num">{mb(ext_sizes['tree_info.json'])}</td>
<td>16,544 个树心坐标（含高程）</td>
<td><span class="tag t-warn">建议放</span><br>用于网格互证与参考点重建</td></tr>
<tr><td class="mono">dsm.tif</td><td class="num">{mb(ext_sizes['dsm.tif'])}</td>
<td>立体高度图 —— <b>生成 CHM 的原料</b></td>
<td><span class="tag t-gray">可选</span><br>见下方说明</td></tr>
</tbody></table>

<div class="good"><b>关键：<code>dsm.tif</code> 其实可以不放在网盘。</b><br>
因为 <code>output/chm.tif</code>（{mb(sizes['chm'])}）<b>已经在同步范围内</b>——
它正是由 dsm.tif 加工出来的成品。所以另一台机器<b>直接就有 CHM 可用</b>。<br><br>
只有当你要<b>重新生成 CHM</b>（改了参数、或换了新的园区影像）时，才需要 dsm.tif。
那种情况把 {mb(ext_sizes['dsm.tif'])} 单独拷一次就行，不必长期占用网盘配额。</div>

<div class="q"><b>放与不放的取舍</b>：<br>
· 放 <code>segment.tif</code> + <code>tree_info.json</code> = 约 <b>{mb(EXT_SMALL)}</b>，
换来另一台机器<b>完整精度</b> —— 非常划算；<br>
· <code>dsm.tif</code> {mb(ext_sizes['dsm.tif'])} 长期占配额，而它的产物 CHM 已在同步，
<b>按需临时拷贝更合理</b>。</div>

<h2>三、千万不要放的</h2>
<table>
<thead><tr><th>内容</th><th class="num">体积</th><th>为什么不放</th><th>替代方案</th></tr></thead>
<tbody>
<tr><td class="mono">{ORTHO_NAME}（正射影像）</td><td class="num">{human(ext_sizes['WGR17.tif'])}</td>
<td>太大，且是<b>原始数据</b>，不会变</td>
<td>每台机器本地各存一份{ORTHO_PYR_NOTE}</td></tr>
<tr><td class="mono">models/（模型权重）</td><td class="num">约 430 MB</td>
<td>体积大，且有公开下载地址</td>
<td>跑 <code>一键配置环境.bat</code> 自动获取</td></tr>
<tr><td class="mono">.venv/（Python 环境）</td><td class="num">约 1 GB</td>
<td>与环境相关，换机器必须重建</td>
<td>跑 <code>一键配置环境.bat</code></td></tr>
<tr><td class="mono">.git/</td><td class="num">—</td>
<td>会与本地 git 冲突，可能损坏仓库</td>
<td>用 git push/pull</td></tr>
</tbody></table>
<div class="verdict v-no"><div class="vico">🚫</div><div>
<b>特别提醒：不要把整个项目文件夹放进 Google Drive 同步。</b><br>
其中的 <code>.git/</code> 与 <code>.venv/</code> 被网盘同步会出各种奇怪问题
（文件锁冲突、软链接失效、仓库损坏）。<b>只同步 <code>output/</code> 和 DSM 三件套。</b>
</div></div>

<h2>四、建议的 Google Drive 目录结构</h2>
<div class="card">
<pre class="mono" style="background:#f4f7f4;padding:14px;border-radius:8px;overflow-x:auto;line-height:1.7">Google Drive/
└── ForestGapDetection/
    ├── output/                  ← 直接同步整个目录（{mb(sizes['output'])}）
    │   ├── arcgis/              ← ArcGIS 交付包（要交出去的）
    │   ├── jobs/                ← 瓦片缓存与日志
    │   ├── chm.tif              ← 冠层高度模型
    │   └── wgr17-elev-gaps.geojson
    └── 航测原产物/               ← 只放小文件（{mb(EXT_SMALL)}）
        ├── segment.tif          ← 必须
        └── tree_info.json       ← 建议</pre>
<p><b>两台机器怎么用</b>：</p>
<ol>
<li>每台机器把 <code>ForestGapDetection/output</code> 设为本地 <code>output/</code>
的<b>同步目标</b>（Google Drive 桌面版可指定任意本地文件夹同步）</li>
<li>DSM 三件套解压/复制到各机器本地 <code>{EXT_LABEL}/</code></li>
<li>跑管线时把 <code>--segment</code> 指到本地的 <code>segment.tif</code></li>
</ol>
</div>

<h2>五、每次干活的标准流程</h2>
<div class="card">
<pre class="mono" style="background:#f4f7f4;padding:14px;border-radius:8px;overflow-x:auto;line-height:1.7">【开始前】
  1. git pull                      ← 拉取另一台机器的代码/文档改动
  2. 确认 output/ 已同步完（看时间戳）

【干活中】
  3. 改代码 / 跑算法

【结束后】
  4. 跑契约测试：期望 95/95
     python scripts/test_sidecar_contract.py
  5. git add / git commit / git push   ← 代码与文档走 git
  6. 等 Google Drive 同步完 output/     ← 结果走网盘
  7. 在下班前确认同步图标变绿</pre>
</div>

<h2>六、一句话速查表</h2>
<table>
<thead><tr><th>东西</th><th>走哪条路</th><th>放哪</th></tr></thead>
<tbody>
<tr><td>代码 <code>scripts/</code></td><td><b>git</b></td><td>仓库</td></tr>
<tr><td>文档 <code>docs/</code></td><td><b>git</b></td><td>仓库</td></tr>
<tr><td>项目记忆 <code>.workbuddy-ai/memory/</code></td><td><b>git</b></td><td>仓库</td></tr>
<tr><td>检测结果 <code>output/</code></td><td><b>Google Drive</b></td><td>ForestGapDetection/output/</td></tr>
<tr><td><code>segment.tif</code> + <code>tree_info.json</code></td><td><b>Google Drive</b></td><td>ForestGapDetection/航测原产物/</td></tr>
<tr><td><code>dsm.tif</code>（{mb(ext_sizes['dsm.tif'])}）</td><td><b>按需临时拷</b></td><td>不用长期放；CHM 已在 output/ 里</td></tr>
<tr><td>正射影像 / 模型权重 / Python 环境</td><td><b>都不同步</b></td><td>各机器本地准备</td></tr>
</tbody></table>

<footer>
生成时间：2026-10-15 &nbsp;·&nbsp; 体积为实测值（脚本实时统计）<br>
相关文档：《跨机器协同工作流》（Markdown 详版）、<code>docs/README.md</code>
</footer>
"""

OUT = ROOT / "docs" / "05-环境与部署" / "跨机器协同-GoogleDrive放置清单.html"
OUT.write_text(shell(
    "跨机器协同：Google Drive 放置清单",
    "公司机 ↔ 家用机 · 什么走 git、什么走网盘、放之前注意什么 &nbsp;·&nbsp; 2026-10-15",
    BODY), encoding="utf-8")
print(f"已生成 {OUT.name}  {OUT.stat().st_size/1024:.1f} KB")
print(f"  实测：output/ = {mb(sizes['output'])}（其中 arcgis {mb(sizes['arcgis'])}、jobs {mb(sizes['jobs'])}）")
print(f"  DSM 三件套 = {mb(ext_sizes['dsm.tif']+ext_sizes['segment.tif']+ext_sizes['tree_info.json'])}")
