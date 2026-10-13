# 模型权重

本目录存放 AI 推理所需的权重文件，**不纳入版本控制**（合计约 430 MB）。
运行 `scripts/setup_env.ps1` 会自动下载，也可手动按下方地址获取。

## 文件清单

| 路径 | 模型 | 体积 | 许可证 |
|---|---|---|---|
| `deepforest-tree/model.safetensors` | DeepForest 树冠检测 | 123 MB | MIT |
| `deepforest-tree/config.json` | 同上，配置 | 1 KB | MIT |
| `sam2/sam2.1_hiera_base_plus.pt` | SAM 2.1 分割 | 308 MB | Apache 2.0 |

## 手动下载

```bash
# DeepForest 树冠检测
curl -L -o deepforest-tree/model.safetensors \
  https://huggingface.co/weecology/deepforest-tree/resolve/main/model.safetensors
curl -L -o deepforest-tree/config.json \
  https://huggingface.co/weecology/deepforest-tree/resolve/main/config.json

# SAM 2.1（base_plus）
curl -L -o sam2/sam2.1_hiera_base_plus.pt \
  https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_base_plus.pt
```

## 使用须知

两个模型的许可均为宽松许可，可商用，保留署名即可。

**但请注意**：DeepForest 的预训练权重训练于北美/温带森林影像，实测**不能直接迁移到油棕正射影像**
（在 WGR17 上置信度中位仅 0.35，检出的框宽约 1.6 m，而油棕冠幅应为 7~9 m）。
当前检测流水线默认走结构法，DeepForest 留待用本地数据微调后再启用。
详见 `docs/gap-detection-feasibility.md` 与 `docs/model-strategy.md`。
