# Docker 使用说明（可选方案）

> ⚠️ **使用前提**：需要管理员权限安装 Docker Desktop + WSL2。
> 如果你暂时拿不到管理员权限，请用 `scripts/setup_env.ps1`（原生方案，零权限）。
> 两种方案的详细对比见 [`../docs/docker-alternative.md`](../docs/docker-alternative.md)。

---

## 一、准备工作

### 1. 安装 Docker Desktop

下载：https://www.docker.com/products/docker-desktop/

安装时勾选 **Use WSL 2 instead of Hyper-V**。

### 2. ⚠️ 务必先把镜像存储改到 D 盘

**不做这一步，Docker 会把 C 盘塞满**（本项目镜像 6~8 GB，你 C 盘只剩约 25 GB）。

```powershell
# 以管理员身份打开 PowerShell

# 关闭 Docker Desktop 和 WSL
wsl --shutdown

# 把 docker-desktop-data 迁到 D 盘
wsl --export docker-desktop-data D:\docker\docker-desktop-data.tar
wsl --unregister docker-desktop-data
wsl --import docker-desktop-data D:\docker\docker-desktop-data D:\docker\docker-desktop-data.tar --version 2

# 再打开 Docker Desktop -> Settings -> Resources -> Advanced
# 把 "Disk image location" 改成 D:\docker
```

### 3. （仅 GPU 版需要）安装 NVIDIA Container Toolkit

Windows 下通过 WSL2 使用 GPU，需要：

1. 宿主机装好 **较新的 NVIDIA 驱动**（支持 WSL 的版本）
2. 在 WSL2 的 Ubuntu 里安装 nvidia-container-toolkit

验证：

```bash
docker run --rm --gpus all nvidia/cuda:12.1.1-base-ubuntu22.04 nvidia-smi
```

能看到显卡信息就说明 GPU 直通配好了。

---

## 二、构建与运行

```bash
# 进入项目根目录
cd "D:/Project/AI/Forest Gap Detection"

# GPU 版（推荐）
docker compose -f docker/docker-compose.yml --profile gpu build
docker compose -f docker/docker-compose.yml --profile gpu up -d

# 或者 CPU 版（体积小一半）
docker compose -f docker/docker-compose.yml --profile cpu build
docker compose -f docker/docker-compose.yml --profile cpu up -d
```

## 三、跑一次检测

```bash
# 影像已通过 compose 挂载到容器内的 /data
docker compose -f docker/docker-compose.yml run --rm ai-gpu \
  python detect.py --input /data/WGR17.tif --output /output/result.json
```

结果会出现在项目的 `output/` 目录。

## 四、目录挂载对照表

| 宿主机路径 | 容器内路径 | 权限 | 说明 |
|---|---|---|---|
| `./models` | `/models` | 只读 | DeepForest + SAM2 权重 |
| `D:/WGR` | `/data` | 只读 | 原始影像目录 |
| `./output` | `/output` | 读写 | 输出结果 |

**如果你的影像不在 `D:/WGR`**，改 `docker-compose.yml` 里这一行即可：

```yaml
- D:/WGR:/data:ro      # 左边改成你的实际路径
```

---

## 五、常见问题

**Q: 报错 `could not select device driver "" with capabilities: [[gpu]]`**
→ NVIDIA Container Toolkit 没装好，回到第一步第 3 节。

**Q: 构建时下载 PyTorch 特别慢**
→ 在 `Dockerfile` 里把 `--index-url https://download.pytorch.org/whl/cu121` 换成国内镜像，或者给 Docker Desktop 配代理。

**Q: C 盘又满了**
→ 说明第 2 步没做全。执行 `docker system df` 看看镜像占了多少，再用 `docker system prune -a` 清理。

**Q: 读 3.5 GB 的 tif 很慢**
→ Windows 下 bind mount 有性能损耗，属正常现象。可以把影像先复制到 WSL2 文件系统内（`\\wsl$\...`）再处理，会快很多。

---

## 六、什么时候真的需要 Docker

| 场景 | 需要 Docker 吗 |
|---|:---:|
| 你一个人在本机开发 | ❌ 不需要，用原生脚本更省事 |
| 团队多人，要环境完全一致 | ✅ 需要 |
| 上 CI/CD 自动测试 | ✅ 需要 |
| 云端批量处理几十上百张影像 | ✅ **必需** |

**现阶段（单人开发）用 `scripts/setup_env.ps1` 就够了。**
