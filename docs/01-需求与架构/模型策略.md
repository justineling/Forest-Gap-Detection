# 油棕园空地智能检测 — AI 模型与数据路线研究报告

> 版本：v0.1  
> 作者：AI 研究助理（ai-research）  
> 日期：2026-10-12  
> 状态：**研究结论，供架构与 PRD 决策使用**  
> 说明：本报告明确区分「有据可查的事实」（附来源链接）与「推断」（显式标注）。无公开定论处直说。

---

## ① 结论速览（TL;DR）

**核心结论：项目不需要从零自研模型。开源可复用资产充足，且主力资产（DeepForest、SAM2）均为宽松许可证、可商用。推荐采用「零标注冷启动出 v1 → 少量标注微调迭代」的双阶段路线。**

### 推荐路线（一句话）

> **DeepForest（MIT，直接可用的树冠检测权重）+ SAM2（Apache 2.0）做树冠实例分割 → 树冠掩膜的补集 = 空地候选 → 面积/形态/上下文规则分类 → 栅格转矢量输出 GeoJSON。**

理由：

1. 已有**端到端、无需标注**的公开范式被验证——Shi et al. 2026（*Remote Sensing*）提出 DeepForest + SAM + 无监督聚类的「annotation-free」树冠提取框架，在 OAM-TCD 多生物群区数据集上表现稳健（来源见 ⑦-3）。
2. 油棕树冠是**检测问题中难度最低的一类**（树冠规整、株行距规律、无人机亚分米分辨率），YOLO 系在油棕树冠检测上公开报告的 mAP@0.5 高达 0.99、计数准确率 98.5%–99.45%（来源 ⑦-6、⑦-7）。
3. 「空地 = 无树冠区域」这一反推逻辑让树冠分割的精度直接转化为空地检测精度，工程上闭环。

### 三条最关键结论

| #  | 结论                                                                                                                      | 性质         |
| -- | ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| K1 | **模型来源**：不需要自研，走「开源检测/分割模型 + 轻量微调」即可；零标注冷启动的 v1 可行                                                                      | 事实+推断      |
| K2 | **三类空地判定**：`gap`（林间空隙）与 `hole`（枯死缺株）单期 RGB **几何上可区分**；但 `idle`（长期闲置）与 `hole`（枯死）的**语义**区分，单期 RGB **不足**，需多期影像或光谱/DSM 辅助 | 事实（多篇文献支撑） |
| K3 | **部署**：推荐 **Python sidecar（优先 ONNX Runtime）**，不建议纯 Rust；SAM2 可导出 ONNX 但有工程量与坑                                           | 事实+推断      |

### 对项目三个 Open Question 的初步回答

- **OQ-1（是否已有模型）**：即使没有也能做——零标注冷启动路线可出 v1。
- **OQ-2（是否有标注数据）**：有 50–200 张切片级 polygon 标注即可微调出可用模型；完全没有也能先跑 DeepForest+SAM2。
- **OQ-3（是否有 GPU）**：**推理**可在 CPU 上跑（慢但可行）；**训练/微调**建议至少 8GB 显存的 NVIDIA GPU（详见 ③）。

---

## ② 开源方案盘点对比表

> 筛选标准：① 与「树冠识别 / 林冠空隙 / 油棕」直接相关；② 有公开代码或权重；③ 输入形态与无人机正射影像（RGB/多光谱）匹配。

### 2.1 主对比表

| #  | 方案                                    | 用途                   | 输入                  | 输出                | 公开精度                                                                           | 许可证                                   | 需重训？           | 成熟度              | 备注                                                                   |
| -- | ------------------------------------- | -------------------- | ------------------- | ----------------- | ------------------------------------------------------------------------------ | ------------------------------------- | -------------- | ---------------- | -------------------------------------------------------------------- |
| 1  | **DeepForest**（weecology）             | 单木树冠**检测**           | RGB 正射影像            | 树冠**边界框**（bbox）   | 生态遥感领域事实标准，被大量引用                                                               | **MIT**（可商用）                          | 可直接用预训练权重；建议微调 | 高（PyPI 包，维护活跃）   | 基于 torchvision 目标检测；含树冠+鸟类两个预训练模型；支持自定义类别训练                          |
| 2  | **ForestSAM**（jpsuarezq）              | 油棕树冠**实例分割**         | 航拍影像                | 树冠多边形             | Dice **0.826** / IoU **0.712**（CIARP 2025）〔数值来自任务书，未逐字核验，见注〕                   | 需查仓库 LICENSE                          | 需按论文复现         | 中（研究代码）          | DeepForest 出框 + SAM2 出 mask，**与本项目最贴合**                              |
| 3  | **canopy-gap-detection**（FloFranz）    | 林冠**空隙分割**           | RGBI（含近红外）+ nDSM 高度 | 空隙 mask           | IoU **0.67–0.77**，F1 **0.56–0.74**                                             | **CC-BY-4.0**（Zenodo 数据/模型）           | 提供已训练模型可直接用    | 中（R+Python，论文级）  | U-Net(ResNet34)；模型文件 272MB；训练标签由 ALS-CHM 自动生成                        |
| 4  | **PalmAI QGIS 插件**（Anovvy）            | 油棕树计数/中心/健康三分类 + 道路  | 无人机正射影像             | Shapefile（点/框/折线） | 未公开具体指标                                                                        | **MIT**（可商用）                          | 需自训权重          | 中（QGIS 插件，含切片推理） | YOLOv8 + DeepLabV3+；**健康三分类=健康/黄化/死亡**，直接对应 B 类枯死；含多 GB 影像切片推理逻辑     |
| 5  | **CanopyLens**（sujayx07）              | 树冠实例分割 + 郁闭度         | 多光谱 GeoTIFF         | 矢量树冠多边形           | 未公开具体指标                                                                        | 需查仓库 LICENSE                          | 端到端管线          | 中                | 滑窗切片 + DeepForest + SAM2 + Shapely 矢量化，**工程链路与本项目几乎一致**              |
| 6  | **OAM-TCD**（Restor + ETH Zurich）      | 树冠**实例分割**数据集 + 基线模型 | 10cm/px 航拍影像        | 实例 mask           | 5 篇 CV 参考基线；跨数据集泛化验证                                                           | 数据 **CC-BY-4.0**，代码/模型 **Apache 2.0** | 可作为微调数据集       | 高（论文+公开数据+代码）    | 5072 张 2048×2048 图，28 万棵单木 + 5.6 万树簇实例标注；**做微调的最佳公开数据源**             |
| 7  | **YOLO 系油棕树冠检测**（多篇论文 + Roboflow 数据集） | 油棕树**检测/计数**         | RGB 无人机影像           | bbox/点            | mAP@0.5 **0.995**、F1 **0.989**（WorldView-3）；YOLOv8m F1 **99.31%**；1ha 精度 98.5% | 视具体仓库；Roboflow 数据集需查                  | 需训练（数据集公开）     | 中高               | Roboflow 有 2730/3131/4063 张公开油棕标注数据集；Mendeley 有 Ganoderma 病株 RGB 数据集 |
| 8  | **MADAN**（rs-dl）                      | 跨区域油棕计数与检测           | 遥感影像                | 树冠检测              | 论文级                                                                            | 需查仓库                                  | 需训练            | 中                | 多级注意力域自适应，解决**跨园区/跨区域泛化**问题（本项目重要风险）                                 |
| 9  | **UniTree**（jqyang22）                 | 跨区域/跨传感器树冠分割         | 遥感影像                | 树冠 mask           | RSE 2026 论文                                                                    | 需查仓库                                  | 需训练            | 中（新）             | 统一知识迁移，**无需场景特定标签**提升单木树冠分割——与本项目泛化需求相关                              |
| 10 | **FM-SAM**                            | 单木树冠分割与分类            | 遥感影像                | 树冠 mask + 类别      | 论文级                                                                            | 需查仓库                                  | 需训练            | 中                | YOLOv10 + SAM 组合                                                     |

> **注（诚实标注）**：ForestSAM 的 Dice 0.826 / IoU 0.712 数值来自任务书给定的已知参考，本次检索到 Springer 章节（CIARP 2025）确认其「achieved a Dice coefficient (DSC)…」，但**未能逐字核验具体小数位**（Springer 链接需登录跳转）。建议以论文原文为准。

### 2.2 许可证速查（决定能否商用）

| 资产                          | 许可证                        | 可商用    | 来源      |
| --------------------------- | -------------------------- | ------ | ------- |
| DeepForest（代码+权重）           | **MIT**                    | ✅      | ⑦-1     |
| SAM / SAM2（代码+checkpoint）   | **Apache 2.0**             | ✅      | ⑦-4、⑦-5 |
| canopy-gap-detection（数据+模型） | **CC-BY-4.0**              | ✅（需署名） | ⑦-2     |
| OAM-TCD（数据 / 代码+模型）         | CC-BY-4.0 / **Apache 2.0** | ✅      | ⑦-3     |
| PalmAI QGIS 插件              | **MIT**                    | ✅      | ⑦-8     |
| ONNX Runtime                | MIT                        | ✅      | ⑦-12    |
| `ort` crate（Rust）           | MIT/Apache-2.0 双许可         | ✅      | ⑦-12    |

**结论（推断）**：主力方案许可证组合（MIT + Apache 2.0 + CC-BY-4.0）**无商用障碍**，仅需保留署名/NOTICE。这是本项目选型的一个显著利好。

---

## ③ 三条模型获取路线对比

### 3.1 路线 A：迁移学习 / 微调（**推荐**，前提：有少量标注）

**最小可行路径：**

1. 用 OAM-TCD（公开 28 万单木实例标注）或 Roboflow 油棕数据集做**预训练/继续预训练**；
2. 用户在自己的园区影像上标注 **50–200 张 512×512 或 1024×1024 切片**的树冠 polygon（或 bbox）；
3. 微调 U-Net / SegFormer / YOLOv8-seg 等分割模型。

| 项     | 说明                                                                                                         | 性质          |
| ----- | ---------------------------------------------------------------------------------------------------------- | ----------- |
| 标注形式  | **polygon mask 优于 bbox**（本项目要输出 polygon，且实例分割直接可用）；如只做检测则 bbox 亦可                                          | 事实          |
| 标注样本量 | **约 50–200 张切片**可出可用模型；OAM-TCD 论文显示在 5000 张级别数据上训练的基线模型泛化良好                                                | 推断（基于文献量级）  |
| 标注工具  | LabelMe / CVAT / QGIS 手工勾绘（PRD 已列为 R-P2-1）                                                                 | 事实          |
| 训练显存  | 512×512 切片、U-Net/SegFormer-B0 类模型 **8GB 显存可训**；Mask2Former 类 Transformer 分割需 **≥15GB 显存**（NVIDIA TAO 文档明示） | 事实（⑦-10）+推断 |
| 训练时长  | 8GB GPU 上 50–200 张切片微调 **数小时量级**；从 OAM-TCD 全量训练则需数十小时                                                      | 推断          |
| 可用骨干  | SAM/SAM2、SegFormer、U-Net、Mask2Former 均有公开预训练权重                                                             | 事实          |
| 成本    | 低（数据已有公开源，仅需标注人力 + 一块 GPU）                                                                                 | 推断          |
| 风险    | 跨园区/跨区域域偏移（不同品种、株龄、光照、传感器）→ 需域自适应（见 MADAN / UniTree）                                                       | 事实          |

### 3.2 路线 B：零标注冷启动（**v1 首选**，前提：无模型无标注）

**可行，且是本项目落地成本最低的起点。** 组合方式：

```
① 树冠检测     DeepForest（预训练权重，零样本）→ 树冠 bbox
       ↓
② 树冠分割     SAM2（box 提示）→ 树冠精确 mask
       ↓
③ 空地提取     树冠 mask 的「补集」→ 候选空地
       ↓
④ 株行距规律   对树冠中心点做规则/网格拟合，识别"应种未种"的位置
       ↓
⑤ 缺口识别     补集区域 ∩ 株行距网格空位 → 空地多边形
       ↓
⑥ 面积/形态过滤 + 三类规则分类（见 ④）
       ↓
⑦ 矢量化输出   mask → polygon → 简化/平滑 → GeoJSON
```

**证据支撑：**

- Shi et al. 2026（*Remote Sensing*）验证了 **DeepForest + SAM + 无监督聚类** 的「annotation-free」树冠提取框架，在 OAM-TCD 多生物群区场景上「robust performance」，定位为「low-cost baseline tool」（⑦-3）。
- ForestSAM 直接证明了 **DeepForest + SAM2 在油棕**上的可行性（⑦-9）。
- CanopyLens 证明了整条「滑窗切片 → DeepForest → SAM2 → Shapely 矢量化」工程链路在**多 GB 正射影像**上可跑通（⑦-11）。

| 项     | 说明                                                            | 性质    |
| ----- | ------------------------------------------------------------- | ----- |
| 精度天花板 | 树冠检测 Dice 量级 **0.7–0.83**（ForestSAM 报告）；空地作为补集，精度受树冠漏检/误检直接影响 | 事实+推断 |
| 主要风险  | ① 树冠粘连（密植重叠）→ 漏检成片；② 非树冠地物（道路/建筑/水面/裸土）被误判为空地；③ 阴影/云被误判       | 推断    |
| 缓解手段  | ① 上下文规则（道路/水系掩膜排除）；② 株行距网格约束；③ 面积/长宽比过滤                       | 推断    |
| 成本    | **极低**（纯推理，无标注、无训练）                                           | 推断    |
| 结论    | **建议作为 v1**，先交付「有树/无树 + 空地几何」，语义三类降级为「规则初判 + 人工复核」            | 推断    |

### 3.3 路线 C：完全自研（不推荐）

| 项     | 说明                                                 |
| ----- | -------------------------------------------------- |
| 何时才需要 | 仅当①开源方案在本园区精度不达标 **且** ②有充足标注数据 + 充足 GPU + 长期算法团队时 |
| 成本    | 高（标注数万张、GPU 集群、算法团队、迭代周期长）                         |
| 风险    | 高（重复造轮子，泛化问题开源方案同样存在）                              |
| 建议    | **不推荐作为起点**；可在路线 A 迭代 2–3 轮后，视效果决定是否部分自研           |

### 3.4 路线对比总表

| 维度     | A 迁移微调              | B 零标注冷启动           | C 完全自研             |
| ------ | ------------------- | ------------------ | ------------------ |
| 前置条件   | 少量标注 + 1 块 GPU      | 无（仅需影像）            | 大量标注 + GPU 集群 + 团队 |
| 冷启动速度  | 中（数天–数周）            | **快（数天）**          | 慢（数月+）             |
| 精度预期   | **高**（可到 Dice 0.8+） | 中（Dice 0.7–0.8 量级） | 高（但风险大）            |
| 成本     | 低                   | **极低**             | 高                  |
| 风险     | 中（域偏移）              | 中（粘连/误检）           | 高                  |
| **推荐** | ✅ 第二阶段              | ✅ **第一阶段（v1）**     | ❌ 暂不考虑             |

**综合建议**：**B（v1）→ A（迭代）** 双阶段。先用路线 B 交付可演示的 v1 并采集真实园区数据，再用真实数据做路线 A 的微调迭代。

---

## ④ 三类空地判定可行性

### 4.1 三类的技术依据

| 类别                | 业务定义       | 影像/几何依据                             | 单期 RGB 可行性                                   |
| ----------------- | ---------- | ----------------------------------- | -------------------------------------------- |
| **A `idle` 长期闲置** | 大面积连续无树冠   | 大块连续无树冠区域；**但与「新开垦/未种植/其他地物」需语义区分** | **不足**（见 4.2）                                |
| **B `hole` 枯死缺株** | 小面积零散、成排缺失 | 株行距网格上的**离散缺位**；面积小、形状≈单株/数株树冠大小    | **几何可判**（`hole` 的"位置规律性"可判）；**语义"枯死"需光谱/多期** |
| **C `gap` 林间空隙**  | 树冠间隙/光照空隙  | 树冠 mask 的**自然间隙**；面积中小、形状不规则        | **可判**（纯几何）                                  |

### 4.2 关键判断：单期 RGB 是否够？

**结论（有文献支撑）：不够完整。**

- **`gap` 与 `hole` 的几何区分**：单期 RGB 足够——两者都是「树冠补集」，可通过**面积、形状、是否落在株行距网格空位**区分（推断，但依据充分）。
- **`idle` 与 `hole`（枯死）的语义区分**：单期 RGB **不足**。证据：
  - 油棕枯死主因是 **Ganoderma（基腐病/BSR）**，多篇研究明确指出**早期检测困难**，需要**多光谱（红边/近红外）**、**热红外**、**结构特征（DSM）** 联合建模——例如 MDPI *Remote Sensing* 2022 综述评估 Ganoderma 遥感检测，以及 2026 年 UAV「RGB + 热红外 + 结构特征」多类 BSR 严重度检测研究、Frontiers 2026 高光谱深度学习检测研究（⑦-13、⑦-14、⑦-15）。
  - **耕地撂荒（abandoned/idle land）识别**文献普遍强调**物候与影像时相选择**、**长时序/变化检测**是关键，单期影像易混淆（⑦-16、⑦-17）。
- **推断**：区分「长期闲置」与「枯死」，本质上是**时间维度**问题（闲置=长期无树；枯死=近期失去树冠），单期快照无法表达"长期"与"近期"的差异。

### 4.3 如果单期 RGB 不够，需要什么额外数据

| 需求                  | 补充数据                        | 作用                | 成本                              |
| ------------------- | --------------------------- | ----------------- | ------------------------------- |
| 区分 `idle` vs `hole` | **多期正射影像**（至少 2 期，间隔数月–数年）  | 变化检测：长期无树 vs 近期变化 | 中（需历史影像）                        |
| 枯死早期识别              | **多光谱（含红边/近红外）**            | 植被胁迫光谱特征          | 中高（需多光谱相机）                      |
| 枯死/株高               | **DSM/DTM 或 DAP-CHM（高度模型）** | 树高、冠层结构           | 中（canopy-gap-detection 即用 nDSM） |
| 热胁迫                 | 热红外                         | 病害热特征             | 高                               |

### 4.4 对项目的务实建议（推断）

1. **v1 只承诺几何分类**：把三类降级为「**大块连续无树（候选 idle）/ 网格缺位（候选 hole）/ 树冠间隙（候选 gap）**」，并在 UI 标注为"候选类别，需人工确认"（PRD 已有复核流程 R-P0-8）。
2. **`class` 字段保留，但增加 `class_confidence` 与 `class_method`**，明确标注是几何规则判定还是光谱判定。
3. **若用户能提供多期影像或多光谱影像**，再升级为真正的语义三类分类——这应作为**必须问用户的问题**（见 ⑧）。

---

## ⑤ 推理引擎与部署建议

### 5.1 方案对比

| 维度       | Python sidecar（PyInstaller / 独立进程）                              | 纯 Rust（`ort` crate）                                                                                                             |
| -------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 模型支持     | **全**（PyTorch 原生，SAM2/DeepForest 直接跑）                           | 需先导出 ONNX；复杂动态图模型有坑                                                                                                             |
| 包体大小     | 大：含 PyTorch + CUDA 时，PyInstaller 打包**通常 1.5–3GB**（社区普遍抱怨"打包巨兽"） | 小：ONNX Runtime CPU 约几十 MB；GPU 版约 200MB 级 + CUDA/cuDNN 运行时                                                                       |
| CUDA 依赖  | 重：需匹配 torch 的 CUDA 版本，分发需打包/引导安装 CUDA                           | 中：`ort` 支持 CUDA/TensorRT/OpenVINO/DirectML 执行提供器，但仍需 CUDA/cuDNN 运行时                                                             |
| SAM2 可行性 | **原生可行**                                                        | **可导出 ONNX**（samexporter、SAM2ONNX 等），但需拆分 image encoder / prompt encoder / mask decoder，**动态轴、memory_attention、onnxsim 简化均易踩坑** |
| 开发速度     | 快（算法侧复用开源 Python 生态）                                            | 慢（需手写预处理/后处理、矢量化）                                                                                                               |
| 许可证      | PyTorch（BSD）、各模型见 ②                                             | `ort`（MIT/Apache）、ONNX Runtime（MIT）均宽松                                                                                          |
| 跨平台      | 一般（PyInstaller 跨平台打包繁琐）                                         | 好（Rust 交叉编译）                                                                                                                    |
| 与本项目匹配   | **高**（算法全部是 Python 生态）                                          | 中（GIS/矢量化有 Rust 库，但 AI 侧受限）                                                                                                     |

> 大小数字为量级估算（来源为社区打包经验文，⑦-18/⑦-19；ONNX Runtime CUDA 依赖见 ⑦-12）。**具体数值随版本浮动，属推断量级。**

### 5.2 推荐（推断）

**推荐：Python sidecar 进程 + ONNX Runtime 推理（而非纯 Rust）。**

架构建议：

- Tauri 主进程（Rust）负责 UI、文件、GIS 渲染；
- **独立 Python 推理进程（sidecar）**，通过本地 IPC（stdin/stdout JSON 或本地 HTTP/命名管道）通信；
- Python 侧优先用 **ONNX Runtime** 跑推理（比原生 PyTorch 更轻、更快、部署更简单），**PyTorch 仅用于训练/导出**；
- 模型以 ONNX 形式分发，**避免把整个 PyTorch+CUDA 打进安装包**（这是包体膨胀的根因）；
- 若需 GPU，明确要求/引导用户安装匹配版本的 CUDA/cuDNN，或提供 CPU 兜底。

**为什么不全 Rust：**

- SAM2 在纯 Rust/ONNX 下**可跑但有显著工程量与不确定性**（动态 shape、decoder 的 prompt 输入），不适合作为项目初期主线；
- 整个 AI 生态（DeepForest、SAM2、训练链路、矢量化 geopandas/shapely）都在 Python，纯 Rust 等于重写全部后处理。
- **备选**：若后期追求极致包体，可把**稳定的检测模型**（如 YOLOv8）导出 ONNX 走 `ort`，把 SAM2 保留在 Python 侧。

---

## ⑥ 精度验收基线建议

> 以下目标值为**建议起步基线**（推断，基于同类文献报告精度下调留安全余量），供用户拍板 OQ-6。建议分**两档**：v1（零标注冷启动）与 v2（微调后）。

| 指标               | 定义                | v1 起步目标（零标注） | v2 目标（微调后） | 依据                                      |
| ---------------- | ----------------- | ------------ | ---------- | --------------------------------------- |
| **树冠分割 Dice**    | 2·|A∩B|/(|A|+|B|) | ≥ 0.70       | **≥ 0.80** | ForestSAM 报告 0.826；canopy-gap 0.67–0.77 |
| **树冠分割 IoU**     | |A∩B|/|A∪B|       | ≥ 0.60       | **≥ 0.70** | ForestSAM 0.712                         |
| **空地 mIoU**      | 全类别平均 IoU         | ≥ 0.55       | **≥ 0.65** | canopy-gap U-Net IoU 0.67–0.77（同类）      |
| **空地 Precision** | TP/(TP+FP)        | ≥ 0.80       | **≥ 0.90** | 误检=误报空地，业务代价高                           |
| **空地 Recall**    | TP/(TP+FN)        | ≥ 0.75       | **≥ 0.85** | 漏检=漏补种                                  |
| **空地 F1**        | 调和平均              | ≥ 0.77       | **≥ 0.87** | canopy-gap F1 0.56–0.74（其任务更难）          |
| **树冠计数误差**       | |预测数−真值|/真值       | ≤ 10%        | **≤ 5%**   | 油棕 YOLO 计数准确率 98.5%–99.45%              |
| **空地面积误差**       | 平均 |面积差|/真值面积     | ≤ 20%        | **≤ 10%**  | 推断                                      |
| **polygon 合法性**  | 无自相交、闭合、CRS 正确    | 100%         | 100%       | PRD R-P0-4（硬性）                          |


**验收建议（推断）：**

1. **主验收指标**建议用「**空地 F1 + 面积误差**」，而非单纯树冠指标——因为业务交付物是空地。
2. **必须建独立验证集**（不同地块/不同时相），并在 PRD R-P2-3 落地自动混淆矩阵。
3. 分类精度（三类）**单列**，且明确标注为"候选类别"，不纳入 v1 硬性验收。

---

## ⑦ 来源清单

| #  | 标题                                                                                                                        | URL                                                                                                                                    | 用途                                     |
| -- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1  | DeepForest（weecology）README / 文档                                                                                          | <https://github.com/weecology/DeepForest> ；<https://raw.githubusercontent.com/weecology/DeepForest/main/README.md>                     | 许可证 MIT、输入输出、预训练模型                     |
| 2  | canopy-gap-detection + Zenodo 模型                                                                                          | <https://github.com/FloFranz/canopy-gap-detection> ；<https://zenodo.org/records/17829462>                                              | U-Net、IoU 0.67–0.77、CC-BY-4.0、272MB 模型 |
| 3  | Shi et al. 2026, "Automating Tree Crown Delineation in UAV Orthomosaics Without Annotation"（*Remote Sensing* 18(17):2897） | <https://www.mdpi.com/2072-4292/18/17/2897> ；<https://www.semanticscholar.org/paper/0c88818668cec63ebb56b15c65206a53112d8a7b>          | DeepForest+SAM+聚类 零标注框架                |
| 4  | facebookresearch/sam2 LICENSE                                                                                             | <https://github.com/facebookresearch/sam2/blob/main/LICENSE>                                                                           | SAM2 = Apache 2.0                      |
| 5  | facebookresearch/segment-anything（SAM v1）                                                                                 | <https://github.com/facebookresearch/segment-anything>                                                                                 | SAM v1 = Apache 2.0                    |
| 6  | IOP: "Automated Oil Palm Tree Detection… YOLOv8 / PreciPalm"                                                              | <https://iopscience.iop.org/article/10.1088/1755-1315/1650/1/012022>                                                                   | 油棕 mAP@0.5 0.995 / F1 0.989            |
| 7  | ACM: "Detection of Oil Palm Trees Using Deep Learning… High-Resolution Aerial Image"                                      | <https://dl.acm.org/doi/fullHtml/10.1145/3626641.3626667>                                                                              | 油棕检测精度 98.5%，16.1ms/图                  |
| 8  | PalmAI QGIS 插件（Anovvy）                                                                                                    | <https://github.com/Anovvy/PalmAI_Plugin> ；<https://www.jxxy.net/ai/articles/a-gh-20261006-06-palmai-qgis-oil-palm-plugin/>            | MIT；YOLOv8 健康三分类（含死亡）；切片推理             |
| 9  | ForestSAM（jpsuarezq）GitHub + Springer CIARP 2025                                                                          | <https://github.com/jpsuarezq/ForestSAM> ；<https://link.springer.com/chapter/10.1007/978-3-032-23161-1_3>                              | DeepForest+SAM2 油棕分割                   |
| 10 | NVIDIA TAO Mask2Former 微调文档                                                                                               | <https://docs.nvidia.com/tao/tao-toolkit/latest/text/cv_finetuning/pytorch/instance_segmentation/mask2former.html>                     | Mask2Former 需 ≥15GB 显存                 |
| 11 | CanopyLens（sujayx07）                                                                                                      | <https://github.com/sujayx07/CanopyLens>                                                                                               | 滑窗切片+DeepForest+SAM2+Shapely 工程链路      |
| 12 | ONNX Runtime CUDA EP 文档 / ort crate                                                                                       | <https://onnxruntime.ai/docs/execution-providers/CUDA-ExecutionProvider.html> ；<https://ort.pyke.io/> ；<https://github.com/pykeio/ort> | 部署选型、CUDA 依赖、许可证                       |
| 13 | MDPI *Remote Sensing* 2022, "UAV-Based Remote Sensing for Early Ganoderma Detection"                                      | <https://www.mdpi.com/2072-4292/14/5/1239>                                                                                             | Ganoderma 遥感检测需多源数据                    |
| 14 | ScienceDirect 2026, "UAV-based integration of RGB, thermal, and structural features… BSR severity"                        | <https://www.sciencedirect.com/science/article/pii/S266615432600030X>                                                                  | 枯死识别需 RGB+热+结构                         |
| 15 | Frontiers 2026, "Spectral detection of basal stem rot… hyperspectral"                                                     | <https://www.frontiersin.org/journals/remote-sensing/articles/10.3389/frsen.2026.1788857/full>                                         | 高光谱检测 BSR，RGB 不足                       |
| 16 | MDPI *Remote Sensing* 2021, "Spatial and Temporal Pattern of Changes in Abandoned Farmland…"                              | <https://www.mdpi.com/2072-4292/13/13/2549>                                                                                            | 撂荒地识别依赖长时序                             |
| 17 | ScienceDirect 2026, "Remote sensing monitoring of cropland abandonment…"                                                  | <https://www.sciencedirect.com/science/article/pii/S1574954126000385>                                                                  | 地块级变化检测                                |
| 18 | 社区：PyInstaller 打包 PyTorch 体积优化                                                                                            | <https://blog.csdn.net/weixin_30308101/article/details/162118528>                                                                      | PyInstaller+torch 包体膨胀                 |
| 19 | 社区：PyInstaller 打包 PyTorch+CUDA 避坑                                                                                         | <https://blog.csdn.net/weixin_29044157/article/details/159072433>                                                                      | CUDA 分发难点                              |
| 20 | Restor/ETH, OAM-TCD 数据集                                                                                                   | <https://restor-foundation.github.io/tcd/dataset/> ；<https://arxiv.org/abs/2407.11743>                                                 | 5072 图 / 28 万实例；CC-BY-4.0              |
| 21 | samexporter / SAM2ONNX（SAM→ONNX 导出）                                                                                       | <https://github.com/vietanhdev/samexporter> ；<https://github.com/DmitryYurov/SAM2ONNX>                                                 | SAM2 可导 ONNX，需拆分模块                     |
| 22 | UniTree（RSE 2026）                                                                                                         | <https://github.com/jqyang22/UniTree>                                                                                                  | 跨区域/跨传感器树冠分割迁移                         |
| 23 | MADAN（rs-dl）                                                                                                              | <https://github.com/rs-dl/MADAN>                                                                                                       | 跨区域油棕检测域自适应                            |
| 24 | Roboflow 油棕公开数据集                                                                                                          | <https://universe.roboflow.com/personal-utility/oil-palm-tree-crown-detection-from-aerial-image-ljham>                                 | 油棕树冠标注数据集                              |
| 25 | Mendeley UAV RGB Ganoderma 数据集                                                                                            | <https://data.mendeley.com/datasets/s23jvbpnr3/2>                                                                                      | 病株冠层级标注数据集                             |

---

## ⑧ 仍无法确定、必须问用户的问题

> 以下问题**无公开定论**，或**必须由用户提供项目特定信息**才能定案，直接影响算法路线。建议合并进 PRD Open Questions。

1. **【最高优先级】是否有可用的历史/多期影像？**
   - 决定 `idle`（长期闲置）与 `hole`（枯死）能否真正区分。**若只有单期 RGB，建议 v1 明确降级为几何分类。**
2. **【最高优先级】影像波段？**
   - 单 RGB，还是含近红外/红边的多光谱？是否附带 DSM/DTM（高度模型）？
   - 决定能否复用 canopy-gap-detection（需 RGBI + nDSM）等方案，以及枯死识别精度上限。
3. **【高】是否有已训练好的模型 / 权重？**
   - 若有，直接评估其输入输出与精度；若无，走路线 B。
4. **【高】是否有标注数据？规模与形式（bbox/polygon）？**
   - 决定走路线 B 还是 A。
5. **【高】训练/推理 GPU 条件？**
   - 训练侧显存（8GB 可行 / 15GB+ 更从容）；终端用户机器是否有 NVIDIA GPU。
6. **【中】空地最小面积阈值 & 三类判定的量化标准？**
   - `idle`/`hole`/`gap` 各自的面积区间、形状、上下文规则由谁定义？（PRD OQ-4）
7. **【中】株行距规格？**
   - 用于「株行距网格建模 → 缺口识别」与 `estimated_replant_points`（PRD OQ-5）。
8. **【中】是否允许联网/云推理，还是必须纯离线？**
   - 决定能否用云 API，以及是否必须把模型完全本地化（影响包体与部署方案）。
9. **【中】精度验收指标与验收方？**
   - 本报告 ⑥ 给出建议基线，需用户拍板（PRD OQ-6）。
10. **【低】油棕品种 / 株龄 / 种植密度范围？**
    - 影响树冠尺寸先验与域偏移风险（是否需要域自适应）。
11. **【低】影像空间分辨率（cm/px）？**
    - 决定切片尺寸与模型选型（亚分米 vs 分米级差异大）。

---

## 附：本报告的事实 / 推断边界声明

- **事实**（有来源）：所有 ⑦ 中可点开的链接所载内容——许可证、精度数值、模型架构、数据集规模、部署依赖等。
- **推断**（本报告判断）：路线推荐、精度目标值、包体量级估算、三类判定降级建议、架构选型建议。均已显式标注「推断」。
- **未逐字核验**：ForestSAM 的具体 Dice/IoU 小数位（Springer 需登录）；部分包体大小数值（社区经验，随版本浮动）。
- **无公开定论**：单期 RGB 能否可靠区分「长期闲置」与「枯死」——文献普遍倾向"需多源/多期数据"，但**没有**针对油棕园区空地三分类的公开基准结论。这是本项目需要用户输入才能闭环的核心不确定点。
