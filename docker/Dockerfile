# =============================================================================
# Forest Gap Detection — AI 推理环境（GPU 版）
# =============================================================================
# 用途：为「树冠检测 + 空地分割」提供可复现的 Python / GDAL / PyTorch 环境
# 体积：约 6~8 GB（含 CUDA 运行时与 PyTorch）
# 前提：已安装 Docker Desktop + WSL2 + NVIDIA Container Toolkit
# 构建：docker build -f docker/Dockerfile -t forest-gap-ai:gpu .
# =============================================================================
FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TZ=Asia/Kuala_Lumpur

# --- 系统依赖：Python 3.12 + GDAL 运行时 + OpenCV 所需图形库 ---
RUN apt-get update && apt-get install -y --no-install-recommends \
        software-properties-common \
        ca-certificates \
        curl \
        git \
    && add-apt-repository -y ppa:deadsnakes/ppa \
    && apt-get update && apt-get install -y --no-install-recommends \
        python3.12 python3.12-venv python3.12-dev \
        gdal-bin libgdal32 \
        libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 \
    && curl -sS https://bootstrap.pypa.io/get-pip.py | python3.12 \
    && rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/bin/python3.12 /usr/local/bin/python && \
    ln -sf /usr/bin/python3.12 /usr/local/bin/python3

WORKDIR /app

# --- Python 依赖（分层缓存：先装依赖，再拷代码）---
COPY sidecar/requirements.txt /app/requirements.txt
RUN python -m pip install --upgrade pip setuptools wheel && \
    python -m pip install \
        numpy scipy pandas \
        rasterio shapely pyproj pyogrio \
        pillow opencv-python-headless \
        scikit-image \
        onnxruntime-gpu && \
    python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121

# --- 应用代码 ---
COPY sidecar/ /app/

# 模型权重目录（通过 volume 挂载，不打进镜像，避免镜像膨胀）
VOLUME ["/models", "/data", "/output"]

ENV FGD_MODEL_DIR=/models \
    FGD_DATA_DIR=/data \
    FGD_OUTPUT_DIR=/output

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD python -c "import rasterio, torch; print('ok')" || exit 1

CMD ["python", "infer_server.py"]
