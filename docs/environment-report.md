# 环境检测报告

> 生成时间：2026-10-13 19:03:25
> 机器：MSI · 用户：Justine · 管理员权限：否
> 数据盘：D: · 工具目录：`D:\forest-gap-tools`
> 完成度：11 / 12 （92%）

| 组件 | 状态 | 说明 | 必要性 |
|---|---|---|---|
| Git | ✅ 已安装 | git version 2.46.0.windows.1 | 必需 |
| Python | ✅ 已安装 | 3.11.5 | 必需 |
| Node.js | ✅ 已安装 | v22.22.2 | 前端必需 |
| Rust | ⚪ 需修复 | rustup 未设置默认工具链，脚本会自动修复 | 桌面端必需 |
| MSVC 生成工具 | ✅ 已安装 | Rust MSVC 工具链可用 | 桌面端推荐 |
| WebView2 | ✅ 已安装 | 155.0.4283.45 | 桌面端必需 |
| NVIDIA GPU | ✅ 已安装 | NVIDIA GeForce MX450 / 驱动 596.49 / 2048 MiB | 推荐 |
| Docker | ✅ 已安装 | Docker version 29.0.1, build eedd969 | 可选 |
| pip: 基础科学计算 | ✅ 已安装 | numpy, scipy, pandas | 必需 |
| pip: 地理处理（自带 GDAL） | ✅ 已安装 | rasterio, shapely, pyproj, pyogrio | 必需 |
| pip: 图像处理 | ✅ 已安装 | pillow, opencv-python-headless | 必需 |
| GDAL | ✅ 已安装 | v3.10.3 (随 rasterio) | 必需 |

## 警告记录

- 普通用户权限 —— 脚本将走「用户级安装」路线，多数组件无需管理员
- Rust 已安装，但 rustup 未设置默认工具链（rustc 无法运行）

---
*由 setup_env.ps1 自动生成，可反复运行刷新。日志：`D:\forest-gap-tools\logs\setup-env.log`*

