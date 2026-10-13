# 环境检测报告

> 生成时间：2026-10-13 08:52:10
> 机器：54BJ862 · 用户：kyling · 管理员权限：否
> 数据盘：D: · 工具目录：`D:\forest-gap-tools`
> 完成度：5 / 9 （56%）

| 组件 | 状态 | 说明 | 必要性 |
|---|---|---|---|
| Git | ✅ 已安装 | git version 2.52.0.windows.1 | 必需 |
| Python | ✅ 已安装 | 3.14.5 | 必需 |
| Python (AI 环境) | ⚪ 需替换 | 将自动装 3.12 供 PyTorch 使用 | AI 必需 |
| Node.js | ✅ 已安装 | v22.22.2 | 前端必需 |
| Rust | ⚪ 需修复 | rustup 未设置默认工具链，脚本会自动修复 | 桌面端必需 |
| MSVC 生成工具 | ✅ 已安装 | Rust MSVC 工具链可用 | 桌面端推荐 |
| WebView2 | ✅ 已安装 | 154.0.4258.62 | 桌面端必需 |
| NVIDIA GPU | ❌ 缺失 | CPU 推理可用但较慢 | 推荐 |
| Docker | ❌ 缺失 | 可选替代方案 | 可选 |

## 需要手动下载 / 安装

| 组件 | 下载地址 | 说明 |
|---|---|---|
| Docker Desktop | <https://www.docker.com/products/docker-desktop/> | 需管理员 + WSL2；Docker 镜像也可改到 D 盘 |

## 警告记录

- 普通用户权限 —— 脚本将走「用户级安装」路线，多数组件无需管理员
- Python 3.14.5 版本过新 —— PyTorch 官方 wheel 目前覆盖 3.10~3.13，脚本会另外装一个 Python 3.12 专供 AI 环境
- Rust 已安装，但 rustup 未设置默认工具链（rustc 无法运行）
- 未检测到 NVIDIA GPU（nvidia-smi 不存在）—— CPU 推理可用但较慢
- 当前为「仅检测」模式，跳过所有安装步骤（不会修改系统）。

---
*由 setup_env.ps1 自动生成，可反复运行刷新。日志：`D:\forest-gap-tools\logs\setup-env.log`*

