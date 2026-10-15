# -*- coding: utf-8 -*-
"""生成《算法说明与演进史》专业版。"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from common import shell, svg_pipeline, svg_evidence

# 项目根 = 本文件的上两级（scripts/docgen/ → scripts/ → 项目根）
ROOT = Path(__file__).resolve().parent.parent.parent
OUT = ROOT / "docs" / "03-算法教学" / "算法说明与演进史.html"

BODY = f"""
<div class="lead">
本文件是项目的<b>算法权威说明</b>：第 1 节讲清当前处理链的 8 个步骤，
第 2 节讲清这套算法是怎么一步步演进过来的（含走过的弯路与实测证据），
第 3 节是实测数据速查。<br><br>
全部数字均来自 <code>WGR17.tif</code>（47,130×44,686 px，3.3 cm/px，
229 公顷油棕园）及其配套 DSM / 语义分割上的真实测量，非估计值。<br>
<b>最后更新：2026-10-15</b>（接入 DSM 高程 + 语义分割双证据）
</div>

<h2>一、当前处理链（8 步）</h2>
{svg_pipeline()}

<div class="card">
<div class="step"><div class="stepno">0</div><div>
<div class="steptitle">CHM 生成 —— 把 DSM 变成"地物高度"</div>
<p><b>做什么</b>：读航测软件输出的 DSM（数字表面模型），减去估算出的地面高程，
得到每个像素上"东西高出地面多少米"（CHM，冠层高度模型）。</p>
<p><b>四个子步骤</b>：</p>
<ol>
<li><b>去尖峰</b>：偏离中值滤波 &gt;4 m 的像素判为摄影测量伪影（实测剔除 1.10%）</li>
<li><b>mask 水体</b>：水面镜面反射 + 无纹理 → 立体匹配失效 → 会产生 ±20 m 假高程</li>
<li><b>DTM 估算</b>：滑动窗口最小值滤波（30 m）+ 高斯平滑</li>
<li><b>CHM = DSM − DTM</b>，输出到 26 cm 处理网格</li>
</ol>
<p><b>代码</b>：<code>scripts/build_chm.py</code>（一次性预处理，产出 <code>output/chm.tif</code>）</p>
<div class="warn"><b>⚠️ 关键实测结论：DJI 的 DSM 被平滑过。</b>
5×5 局部粗糙度仅 0.09 m（真实冠层应有 0.5~2 m），导致冠层高度被
<b>系统性低估约 40%</b>（油棕真实 7~15 m，CHM 只读到 4~10 m）。
因此<b>不可套用文献里的绝对阈值</b>，必须用本数据标定。</div>
</div></div>
</div>

<div class="card">
<div class="step"><div class="stepno">1</div><div>
<div class="steptitle">树冠分割 —— 双证据融合（全流程核心）</div>
{svg_evidence()}
<p><b>融合规则</b>：</p>
<div class="q"><code>树冠 = (语义分割 == tree) 或 (CHM ≥ 5.2 m)</code><br>
<code>树冠 = 树冠 且 非 (CHM &lt; 1.2 m)</code></div>
<p><b>为什么需要两条证据</b>：</p>
<ul>
<li><b>CHM 救援</b>：高度是物理量，不受航带曝光影响。语义分割漏检的树，
只要够高就能被救回（实测占 other 的 19.2%）</li>
<li><b>CHM 否决</b>：高度明确低矮的一律不是树（实测占 tree 的 2.7%）</li>
<li><b>语义分割</b>：端到端学习，能看整株树冠形状；实测在 5 个真值点上全部判对</li>
</ul>
<p><b>为什么还需要原有 ExG 判据</b>：仅作为<b>缺少 DSM 时</b>的兜底。
有海拔证据时，ExG 判据被语义分割替代（实测严格更优）。</p>
<p><b>代码</b>：<code>scripts/elevation.py</code> 的 <code>fuse_canopy()</code></p>
</div></div>
</div>

<div class="card">
<div class="step"><div class="stepno">2</div><div>
<div class="steptitle">空地分离 —— 把"一张网"拆成一块块</div>
<p><b>做法</b>：空地取树冠的补集后，是连成一片的"网"（树冠之间的缝隙全连着）。
用<b>圆盘开运算</b>把宽度小于阈值的窄缝断开，只留下"块状"空地。</p>
<p><b>关键参数</b>：<code>min_gap_width_m = 1.6</code>（米）</p>
<div class="warn"><b>性能坑（已修）</b>：圆盘结构元的 <code>binary_opening</code> 是
O(r²) 暴力卷积，在 2304² 上要 <b>11.7 秒</b>，占整条流水线 85% 的时间。
改用<b>距离变换</b>实现等价的圆盘开运算（O(n)）后降到 <b>1.95 秒</b>，快 6 倍，
等价性已逐像素验证。<br>
⚠️ 不能用 <code>np.ones((3,3))</code> 迭代 r 次代替——那是<b>菱形</b>不是圆盘，
实测差 46,092 像素。</div>
</div></div>
</div>

<div class="card">
<div class="step"><div class="stepno">3</div><div>
<div class="steptitle">矢量化 —— 像素变成多边形</div>
<p><b>做法</b>：连通域提取轮廓 → 转投影坐标系算面积 → Douglas-Peucker 简化 →
面积门槛过滤。</p>
<p><b>关键参数</b>：<code>simplify_m = 0.3</code>（简化容差）、
<code>min_area = 30</code>（m²）</p>
<div class="q"><b>坐标系陷阱</b>：GeoJSON 里存的是<b>经纬度</b>（EPSG:4326），
但算面积必须转到投影系（EPSG:32649）。忘了转换会得到 <code>w=0, h=0</code>
这种荒谬结果（本项目踩过，见第 2 节阶段 5）。</div>
</div></div>
</div>

<div class="card">
<div class="step"><div class="stepno">4</div><div>
<div class="steptitle">种植网格估计 —— 反推出人工种植的规律</div>
<p><b>做法</b>：从树冠掩膜里找树心，拟合出规则网格的<b>株距、行距、错行角、方位</b>。</p>
<p><b>实测结果</b>：株距 <b>8.35 m</b> / 行距 <b>7.23 m</b> / 错行角 <b>60°</b>
（三角形种植）/ 网格质量 <b>0.734</b></p>
<div class="good"><b>独立互证</b>：用 DJI 输出的 15,169 个去重树心做最近邻距离直方图，
主峰落在 <b>8.25 m</b> —— 与影像反推的 8.35 m <b>两个独立方法互证</b>，
说明网格间距测量可靠。</div>
<p><b>为什么重要</b>：这是全项目<b>对曝光不变</b>的强信号之一。
树是按几何规则种的，草地是自然长的。</p>
</div></div>
</div>

<div class="card">
<div class="step"><div class="stepno">5</div><div>
<div class="steptitle">空地分类 —— 4 类</div>
<p>对每块空地，用「质心到最近格点的距离」「长宽比」「占单位格的比例」判类：</p>
<table>
<thead><tr><th>类别</th><th>判据要点</th><th>语义</th></tr></thead>
<tbody>
<tr><td><span class="sw" style="background:#e74c3c"></span><b>株位空缺</b></td>
<td>质心贴近格点、形状规整</td><td>单株位缺一株，补 1 株</td></tr>
<tr><td><span class="sw" style="background:#f1c40f"></span><b>林间空隙</b></td>
<td>细长、远离格点、面积小</td><td>树冠正常缝隙，无需补种</td></tr>
<tr><td><span class="sw" style="background:#e67e22"></span><b>连片空地</b></td>
<td>跨多个株位、面积大</td><td>整片补种</td></tr>
<tr><td><span class="sw" style="background:#95a5a6"></span><b>不确定</b></td>
<td>证据不足，或网格质量 &lt; 0.15</td><td>交人工复核</td></tr>
</tbody></table>
</div></div>
</div>

<div class="card">
<div class="step"><div class="stepno">6</div><div>
<div class="steptitle">不可种植地物检测 —— 扣掉不该种的地</div>
<p>用户口径：「道路（白色）、河流、油棕树、办公生活区四类算不可种植，
<b>其他的都可以算空地</b>」。油棕树本身就是树冠，天然不在空地里，
所以只需检测另外三类：</p>
<table>
<thead><tr><th>类别</th><th>判据</th><th>实测依据</th></tr></thead>
<tbody>
<tr><td><span class="sw" style="background:#e8e8e8"></span><b>道路</b></td>
<td><code>L&gt;170 &amp; S&lt;0.18</code> + 填充率 &lt; 0.30（线状）</td>
<td>全图 64,689 m²，最大连通域 bbox 1078×1111 m、<b>填充率仅 0.013</b> → 线状网络</td></tr>
<tr><td><span class="sw" style="background:#4a90d9"></span><b>水体</b></td>
<td><code>B≥G&gt;R</code> 或（暗+低 ExG+纹理&lt;6），再过 30 m² 最小连通域</td>
<td><code>B≥G&gt;R</code> 仅命中 0.42%；裸规则会抓到密林阴影散点（最大 11 m²）</td></tr>
<tr><td><span class="sw" style="background:#c9a06a"></span><b>办公生活区</b></td>
<td>同"亮+低饱和"掩膜，但填充率 ≥ 0.30 且面积 ≥ 400 m²</td>
<td>实测 fill 0.317~0.548（与道路的 0.013~0.211 <b>完全分离</b>）</td></tr>
</tbody></table>
<p><b>扣除方式</b>：按像素做几何差集（<code>空地 &amp;= ~(道路|水体|办公区)</code>），
而不是"整块改判"——后者对骑在边界上的多边形会误伤。</p>
</div></div>
</div>

<div class="card">
<div class="step"><div class="stepno">7</div><div>
<div class="steptitle">设计密度交叉校验</div>
<p><b>做法</b>：用户提供园区<b>设计密度</b>（油棕园常规 1 ha 至多 150 株），
与网格估计结果比对，偏差超 ±10% 告警。</p>
<div class="warn"><b>本园区的实测结果</b>：网格估计 165.6 株/ha vs 设计 150 株/ha
（比值 1.10，超出上限）。<br>
<b>但这不是网格错误</b> —— 8.35 m 的株距经两个独立方法互证（影像反推 +
树心最近邻），是可靠的。165.6 是按设计间距的<b>满植密度</b>，
而 150 是扣除道路沟渠后的<b>实际定植数</b>。两者口径不同，差值即空位率
（约 10~11%，与实测空地占比吻合）。</div>
</div></div>
</div>

<h2>二、技术演进史（12 个阶段）</h2>
<p>下面按时间顺序记录每一次路线转折。<b>弯路和结论同样重要</b>——
它们解释了为什么现在是这套算法。</p>

<div class="tl">

<div class="tlitem bad">
<div class="tldate">阶段 1 · 起点</div>
<div class="tlhead">DeepForest 预训练模型 —— 折戟</div>
<p>最初的想法很直接：用现成的树冠检测模型。下载了 DeepForest（MIT 许可，
weecology/deepforest-tree 权重，123 MB）。</p>
<div class="verdict v-no"><div class="vico">❌</div><div>
<b>失败原因：域偏移。</b>该权重训练于北美 NEON 温带林，树种、冠形、光照、
种植密度都与东南亚油棕园差异巨大，在油棕影像上<b>漏检严重</b>。
</div></div>
<p><b>教训</b>：预训练模型不是拿来就能用的，域不匹配时还不如手工规则。
这条教训后来直接影响了「草地识别要不要上分割模型」的决策。</p>
</div>

<div class="tlitem">
<div class="tldate">阶段 2</div>
<div class="tlhead">结构法 —— 用植被指数 + 形态学代替深度学习</div>
<p>改用可解释的经典方法：ExG 植被指数 + 高斯平滑 + 形态学后处理。
不依赖训练数据，参数可解释，能在任意影像上重标定。</p>
</div>

<div class="tlitem">
<div class="tldate">阶段 3</div>
<div class="tlhead">空地分离 —— 从"一张网"到"一块块"</div>
<p>发现树冠补集是连成一片的网，无法直接矢量化统计。引入圆盘开运算断开窄缝，
并由此发现圆盘开运算的性能瓶颈（11.7 秒/瓦片），改用距离变换降到 1.95 秒。</p>
</div>

<div class="tlitem">
<div class="tldate">阶段 4</div>
<div class="tlhead">网格先验 —— 用种植几何给空地区分类型</div>
<p>仅有"空地"无法指导补种。观察到油棕是<b>规则种植</b>的，
于是从树心反推株距/行距/错行角，再用"空地相对格点的位置"把空地分成 4 类。</p>
</div>

<div class="tlitem">
<div class="tldate">阶段 5</div>
<div class="tlhead">整幅工程化 —— 229 公顷分块处理 + 断点续跑</div>
<p>3.5 GB 大图无法一次性载入。改为 2048 px 瓦片 + 128 px 外扩，
用「质心落在本瓦片 core 区」的规则避免跨边界空地重复输出或丢失。</p>
<div class="warn"><b>续跑机制的一个真 bug（已修）</b>：原先只校验参数指纹、
不校验瓦片状态，导致<b>失败瓦片被当作缓存静默跳过、永远补不回来</b>。</div>
</div>

<div class="tlitem fix">
<div class="tldate">阶段 6</div>
<div class="tlhead">判据纠错 —— 分割阈值迭代了三代</div>
<table>
<thead><tr><th>版本</th><th>判据</th><th>结果</th></tr></thead>
<tbody>
<tr><td>v1</td><td>纯分位数（ExG &gt; 40% 分位）</td>
<td>密植区整片误报，全园 18% 被标成空地 <span class="tag t-bad">失败</span></td></tr>
<tr><td>v2</td><td>纯绝对阈值（ExG &gt; 60）</td>
<td>对曝光过敏：亮航带 84% / 暗航带 31% <span class="tag t-bad">失败</span></td></tr>
<tr><td><b>v3</b></td><td><b>混合：<code>clip(40%分位, 40, 80)</code> + 饱和度辅助</b></td>
<td>跨曝光稳定 <span class="tag t-ok">定稿</span></td></tr>
</tbody></table>
</div>

<div class="tlitem">
<div class="tldate">阶段 7</div>
<div class="tlhead">分类补全 —— 新增不可种植三类</div>
<p>用户提供关键领域知识：<b>道路是白色的</b>、图内有河流水塘、办公区周围是白色土地。
据此实测并新增 <code>road</code> / <code>water</code> / <code>office</code> 三类，
从"需补种面积"中按像素扣除。</p>
</div>

<div class="tlitem">
<div class="tldate">阶段 8</div>
<div class="tlhead">草地回检 —— 发现"草地比树还绿"</div>
<p>用户指出「油棕与绿地色彩差距很大，可种植的土地不只有褐色的，也有绿色的」。
实测证实：<b>草地 ExG 136.8 vs 油棕 88.6，草地更绿 54%</b>，
现有判据会把草地判成树 → 漏检。</p>
<p>实施方案 A（颜色+形态）+ 方案 B（株行距网格周期性回检）。</p>
</div>

<div class="tlitem bad">
<div class="tldate">阶段 9</div>
<div class="tlhead">真值校验 —— 用户指认的草地一个都没检出</div>
<p>用户提供两个草地真值坐标做终检，结果<b>两个点都不在检出空地里</b>。</p>
<div class="verdict v-no"><div class="vico">🔍</div><div>
定位到两个独立原因：<br>
① <b>方案 B 的判据缺陷（真 bug）</b>：格点距离中位判据对大块连片区域必然命中
→ 真值点1 的 305 m² 草地被 100% 剔除；<br>
② <b>浅色草地与油棕在 RGB 上不可分</b>：真值点2 那片草地 ExG 仅 87，
而本园区油棕 ExG 跨 1~112，<b>区间完全重叠</b>。
</div></div>
</div>

<div class="tlitem fix">
<div class="tldate">阶段 10</div>
<div class="tlhead">尺寸闸门修复 —— 真值点1 被救回</div>
<p>给格点回检加<b>尺寸闸门</b>：面积超 2 个单位格（≈122 m²）的连通域不剔除。
单棵树的受光面不可能横跨两个以上种植单元。</p>
<p><b>实测依据</b>：纯油棕候选斑块最大 1.6 / 9.9 / 70.9 / 6.1 m²；
草地真值区最大 <b>365.3 m²</b>。</p>
<div class="good"><b>双赢结果</b>：真值点1 草地 0 → <b>446 m²</b>；
同时南部油棕 219 m² 的误报归零。</div>
</div>

<div class="tlitem">
<div class="tldate">阶段 11</div>
<div class="tlhead">穷举特征 —— 证明纯 RGB 走不通</div>
<p>为回答「能不能换个特征解决浅色草地」，穷举了所有手工特征与深度特征：</p>
<table>
<thead><tr><th>特征</th><th>草地</th><th>油棕</th><th>结论</th></tr></thead>
<tbody>
<tr><td>ExG 绿度</td><td>83~95</td><td><b>1~112</b></td><td>❌ 完全重叠</td></tr>
<tr><td>纹理 / 梯度 / 动态范围</td><td>—</td><td>—</td><td>❌ 重叠</td></tr>
<tr><td>8.45 m 排列周期性</td><td>8.7~15.1%</td><td>0~11.0%</td><td>❌ 重叠</td></tr>
<tr><td>DINOv2 深度特征（留一验证）</td><td>—</td><td>—</td><td>❌ 5 个区域只对 1 个</td></tr>
</tbody></table>
<div class="verdict v-no"><div class="vico">⛔</div><div>
<b>根因：跨航带曝光差 3 倍。</b>同一片油棕的 ExG 从 1 到 112，
把草地的 83~95 <b>完整包住</b>。<br>
→ 不是"特征不够强"，而是 <b>RGB 这个观测维度不够</b>。
</div></div>
</div>

<div class="tlitem win">
<div class="tldate">阶段 12 · 最新</div>
<div class="tlhead">引入 DSM 高程 + 语义分割 —— 问题解决</div>
<p>用户提供 DJI Terra 完整工程输出（含 <code>dsm.tif</code>、
<code>segment.tif</code>、<code>tree_info.json</code>）。</p>
<p><b>两个关键发现</b>：</p>
<ol>
<li><b>DSM 被平滑过</b>（粗糙度 0.09 m），冠层高度低估约 40%
→ 不可套用文献阈值，必须实测标定</li>
<li><b>DJI 的语义分割在油棕上意外地准</b>（虽属域外模型），
但会漏检约 20% 的树 → 必须叠加 CHM 互补</li>
</ol>
<div class="verdict v-yes"><div class="vico">🎯</div><div>
<b>融合后 5 个真值点分离度 +85.3 个百分点</b>（纯 RGB 上不可分）。<br>
真值点复核 <b>5/5 全部正确</b>，且与 DJI 独立交叉验证一致性 <b>95%</b>。
</div></div>
<p>同时解开了长期悬案：原「油棕-南部」参考点<b>其实是树间空地</b>
（CHM 仅 2.32 m、语义分割判 0% tree，两者都正确），
此前一直误以为是"草地与油棕混淆"。</p>
</div>

</div>

<h2>三、实测数据速查</h2>

<h3>3.1 影像与种植</h3>
<table>
<thead><tr><th>项目</th><th class="num">数值</th><th>说明</th></tr></thead>
<tbody>
<tr><td>正射影像</td><td class="num">47,130 × 44,686</td><td>3.3 cm/px，3.48 GB，4 波段（第 4 波段恒 255=Alpha）</td></tr>
<tr><td>DSM</td><td class="num">23,565 × 22,343</td><td>6.6 cm/px，正射的 1/2 分辨率</td></tr>
<tr><td>语义分割</td><td class="num">6,222 × 5,899</td><td>24.9 cm/px，类别 other/tree/building/pole/ground/water</td></tr>
<tr><td>CHM（产出）</td><td class="num">5,891 × 5,585</td><td>26 cm/px，63 MB</td></tr>
<tr><td>园区面积</td><td class="num">229 公顷</td><td>占外接矩形 57%</td></tr>
<tr><td>株距 / 行距</td><td class="num">8.35 / 7.23 m</td><td>三角形种植，错行角 60°；树心 NND 独立互证 8.25 m</td></tr>
<tr><td>设计密度</td><td class="num">≤150 株/ha</td><td>用户给定；满植密度 166~170 株/ha</td></tr>
</tbody></table>

<h3>3.2 双证据的标定与验证</h3>
<table>
<thead><tr><th>类别</th><th class="num">样本</th><th class="num">CHM P25</th>
<th class="num">CHM P50</th><th class="num">CHM P75</th></tr></thead>
<tbody>
<tr><td><span class="sw" style="background:#2f7d1f"></span>油棕（树心 2 m 内）</td>
<td class="num">2998</td><td class="num">7.41</td><td class="num"><b>8.51</b></td><td class="num">9.54</td></tr>
<tr><td><span class="sw" style="background:#8fd14f"></span>非树（seg=other 且距树心&gt;5 m）</td>
<td class="num">3000</td><td class="num">0.88</td><td class="num"><b>1.56</b></td><td class="num">2.69</td></tr>
</tbody></table>
<p><b>最优单阈值 5.20 m</b>；大样本一致性 tree 保留 97.3% / other 否决 80.8%。</p>

<h3>3.3 真值点复核（10 m 窗口判树比例）</h3>
<table>
<thead><tr><th>真值点</th><th>真实类别</th><th class="num">CHM中位</th>
<th class="num">seg=tree</th><th class="num">融合后判树</th></tr></thead>
<tbody>
<tr><td>草地-点1</td><td>草地</td><td class="num">3.05</td><td class="num">6.9%</td><td class="num">17.2%</td></tr>
<tr><td>草地-点2</td><td>草地</td><td class="num">1.03</td><td class="num">0.0%</td><td class="num">0.0%</td></tr>
<tr><td>油棕-内部</td><td>油棕</td><td class="num">8.34</td><td class="num">84.4%</td><td class="num">87.5%</td></tr>
<tr><td>油棕-西北</td><td>油棕</td><td class="num">7.59</td><td class="num">77.5%</td><td class="num">98.0%</td></tr>
<tr><td>空地（原误标"南部"）</td><td>空地</td><td class="num">2.32</td><td class="num">0.0%</td><td class="num">5.2%</td></tr>
</tbody></table>
<p>树冠点均值 <b>92.8%</b> vs 非树冠点 <b>7.5%</b>，分离度 <b>+85.3 个百分点</b>。</p>

<h3>3.4 当前检测结果（7 类）</h3>
<table>
<thead><tr><th>类别</th><th class="num">块数</th><th class="num">面积 m²</th><th>是否计入需补种</th></tr></thead>
<tbody>
<tr><td><span class="sw" style="background:#e74c3c"></span>株位空缺</td><td class="num">283</td><td class="num">17,421.6</td><td>✅ 计入</td></tr>
<tr><td><span class="sw" style="background:#f1c40f"></span>林间空隙</td><td class="num">225</td><td class="num">12,444.7</td><td>✅ 计入</td></tr>
<tr><td><span class="sw" style="background:#e67e22"></span>连片空地</td><td class="num">489</td><td class="num">328,999.8</td><td>✅ 计入</td></tr>
<tr><td><span class="sw" style="background:#95a5a6"></span>不确定</td><td class="num">466</td><td class="num">40,478.1</td><td>✅ 计入</td></tr>
<tr><td><span class="sw" style="background:#8a8a8a"></span>道路</td><td class="num">180</td><td class="num">34,357.3</td><td>❌ 不可种植</td></tr>
<tr><td><span class="sw" style="background:#4a90d9"></span>水体</td><td class="num">8</td><td class="num">605.4</td><td>❌ 不可种植</td></tr>
<tr><td><span class="sw" style="background:#c9a06a"></span>办公生活区</td><td class="num">4</td><td class="num">2,597.2</td><td>❌ 不可种植</td></tr>
<tr><td colspan="2"><b>合计 1,655 块</b></td><td class="num"><b>436,904</b></td>
<td>需补种 <b>399,344 m²</b>（占 17.43%）</td></tr>
</tbody></table>
<div class="q"><b>与纯 RGB 版本的对比</b>：需补种 309,792 → <b>399,344 m²</b>（+28.9%）。
增幅主要来自此前被 ExG 误判为树冠的草地 ——
新增 1036 块中 84.1% 落于 DJI 的 other 类，面积加权一致性 95%。</div>

<h2>四、已知局限</h2>
<ol>
<li><b>紧邻油棕的草地仍有残留误判</b>：DSM 被平滑，周围树冠高度会"渗"到草地像素上
（真值点1 的 CHM 达 3.05 m），融合后仍有 17.2% 被判为树冠。需人工复核。</li>
<li><b>语义分割属域外推断</b>：DJI 果树模型的支持列表里<b>没有油棕</b>
（只有 orange/litchi/banana/plum/persimmon/wogan），仍会漏检约 20% 的树。
这是必须叠加 CHM 的原因。</li>
<li><b>DSM 不可得时</b>：退化为纯 RGB + 草地回检，草地漏检问题会重新出现。</li>
<li><b>水体类 CHM 异常</b>：水面立体匹配失效会产生 ±20 m 假高程，
已在算 DTM 前 mask 掉，但分割误标的水体边缘仍可能残留。</li>
<li><b>办公区若与路网直接相连</b>会合成一个连通域，被整体判为道路——
仍属"不可种植"，不影响补种统计，只是少一个独立类别。</li>
<li><b>大影像与 DSM 需另行获取</b>（不在仓库里）。</li>
</ol>

<footer>
生成时间：2026-10-15 &nbsp;·&nbsp; 对应代码版本 <span class="mono">d0e368b</span><br>
数据来源：WGR17.tif 真实影像实测 + DSM/语义分割实测 + 项目 git 提交历史<br>
相关文档：《DSM高程辅助检测方案》《算法说明与演进史-小白版》
《分割判据说明》《空地分离算法讲解》《方法对比-DeepForest与结构法》
《草地与油棕区分方案》
</footer>
"""

OUT.write_text(shell(
    "算法说明与演进史",
    "Forest Gap Detection（油棕园空地智能检测）· 专业版 &nbsp;·&nbsp; "
    "2026-10-15 更新（接入 DSM 高程 + 语义分割）&nbsp;·&nbsp; "
    "对应代码版本 d0e368b",
    BODY), encoding="utf-8")
print(f"已生成 {OUT.name}  {OUT.stat().st_size/1024:.1f} KB")
