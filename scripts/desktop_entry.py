"""桌面端统一入口（PyInstaller 单入口）。

================================================================================
为什么需要这个文件
================================================================================
桌面端要拉起**两个** Python 进程：
  · `tile_server.py` —— 常驻的瓦片 / 结果 / 点位服务（HTTP 8765）
  · `sidecar.py`     —— 按需的算法跑批（stdio NDJSON）

如果分别用 PyInstaller 打两个 `--onedir`，`rasterio / numpy / scipy / shapely /
pyproj / gdal` 的数千个动态库会被**复制两遍**，安装包直接翻倍（~350 MB → ~700 MB）。

所以这里做**一个**入口：靠第一个参数分发，两个服务共享同一份 `_internal`
动态库目录。

```
desktop_entry.exe --build-derived [build_derived 的参数...]  # 生成 CHM + 森林掩膜
desktop_entry.exe --run-tile-server [tile_server 的参数...]
desktop_entry.exe [sidecar 的参数...]          # 默认走 sidecar
desktop_entry.exe --self-test                  # 冻结态冒烟自检
```

================================================================================
★ 两条硬红线（违反必崩）
================================================================================
1. **`multiprocessing.freeze_support()` 必须是 `__main__` 里的第一行**。
   Windows 下 `ProcessPoolExecutor` 的子进程是「重新执行同一个 .exe」并带上
   `--multiprocessing-fork` 参数。若先跑 argparse / 模式分发，这个参数会被
   当成未知参数拦掉 → 多进程池瞬间崩（`--workers > 1` 直接不可用）。
   freeze_support() 会在子进程里直接接管并退出，不会走到下面的分发逻辑。

2. **冻结态必须自己定位 PROJ / GDAL 数据目录**。
   `pyproj` 需要 `proj.db`，`rasterio` 需要 `gdal_data`。PyInstaller 把它们
   放进 `_MEIPASS` 下的不同位置，而这两个库**只认环境变量**（`PROJ_DATA` /
   `PROJ_LIB` / `GDAL_DATA`）。不设的话，冻结后一调坐标转换就报
   "Cannot find proj.db" —— 而且**开发态完全复现不出来**。
   所以这里在 import rasterio/pyproj **之前**就把环境变量设好，让 Rust 侧
   完全不用操心路径拼接。
================================================================================
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# 脚本所在目录（开发态是 scripts/，冻结态是 _MEIPASS）
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))


def _frozen_base() -> Path | None:
    """冻结态的根目录；非冻结返回 None。"""
    if not getattr(sys, "frozen", False):
        return None
    return Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))


def _bootstrap_frozen_runtime() -> dict:
    """冻结态自定位数据目录。**必须在 import rasterio / pyproj 之前调用。**

    返回诊断信息（`--self-test` 会打印），非冻结态返回空 dict。
    """
    base = _frozen_base()
    if base is None:
        return {}

    def first_existing(*rels: str) -> Path | None:
        for rel in rels:
            p = base / rel
            if p.exists():
                return p
        return None

    info: dict = {"meipass": str(base)}

    # proj.db 所在目录。
    #
    # ⚠️ **顺序很关键，踩过**：rasterio 与 pyproj 各自带一份 proj.db，版本可能不同。
    #    本机实测：rasterio 1.4.4（GDAL 3.10.3）带的是 DATABASE.LAYOUT.VERSION.MINOR=5，
    #    而 pyproj 3.7.2 的 pip 包里带的是 MINOR=4（旧）。
    #    若把 PROJ_DATA 指向 pyproj 那份，rasterio 的 GDAL 会报
    #      "proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 4 whereas a number >= 5
    #       is expected. It comes from another PROJ installation."
    #    → 所有 `CRS.from_epsg(...)` 直接失败，瓦片服务与坐标转换全崩。
    #    反之用 rasterio 那份（更新）时，pyproj 也能正常读（PROJ 向前兼容）。
    #    所以：**优先 rasterio 的 proj_data，pyproj 只作兜底**。
    proj = first_existing(
        "rasterio/proj_data",
        "_internal/rasterio/proj_data",
        "pyproj/proj_dir/share/proj",
        "_internal/pyproj/proj_dir/share/proj",
        "share/proj",
        "proj",
    )
    if proj is not None:
        # PROJ 9+ 用 PROJ_DATA，旧版用 PROJ_LIB —— 两个都设，兼容各版本
        os.environ["PROJ_DATA"] = str(proj)
        os.environ["PROJ_LIB"] = str(proj)
        info["proj_dir"] = str(proj)

    # rasterio / GDAL：gdal_data 里有 gcs.csv、pcs.csv 等
    gdal = first_existing(
        "rasterio/gdal_data",
        "rasterio/gdal_data/gdal",
        "share/gdal",
        "gdal",
        "_internal/rasterio/gdal_data",
        "_internal/share/gdal",
    )
    if gdal is not None:
        os.environ["GDAL_DATA"] = str(gdal)
        info["gdal_dir"] = str(gdal)

    # 打包后 multiprocessing 的子进程也要能 import 到本目录的模块
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    return info


# 环境变量必须在任何 geo 库 import 之前设好（各模块是懒 import，但保险起见）
_FROZEN_INFO = _bootstrap_frozen_runtime()


def _self_test() -> int:
    """冻结态冒烟自检：import + 坐标转换 + 数据目录定位。输出单行 JSON。"""
    out: dict = {
        "event": "self_test",
        "frozen": bool(getattr(sys, "frozen", False)),
        "executable": sys.executable,
        "python": sys.version.split()[0],
    }
    out.update(_FROZEN_INFO)
    ok = True

    for name in ("numpy", "rasterio", "shapely", "pyproj", "scipy"):
        try:
            mod = __import__(name)
            out[name] = getattr(mod, "__version__", "?")
        except Exception as e:  # noqa: BLE001
            out[name] = f"IMPORT_FAIL: {type(e).__name__}: {e}"
            ok = False

    # 坐标转换：本园区的 EPSG:4326 → EPSG:32649（UTM 49N）
    try:
        from pyproj import Transformer

        t = Transformer.from_crs("EPSG:4326", "EPSG:32649", always_xy=True)
        e, n = t.transform(111.2, 1.18)
        # 园区在 UTM 49N 约 (522000, 130000)；容差 2 万米足够判断"没跑飞"
        proj_ok = abs(e - 522_000) < 20_000 and abs(n - 130_000) < 20_000
        out["proj_sample"] = [round(e, 1), round(n, 1)]
        out["proj_ok"] = proj_ok
        ok = ok and proj_ok
    except Exception as e:  # noqa: BLE001
        out["proj_ok"] = False
        out["proj_error"] = f"{type(e).__name__}: {e}"
        ok = False

    # rasterio 能否真的打开一个内存 GTiff（验证 GDAL 驱动与数据目录都正常）
    try:
        import numpy as np
        import rasterio
        from rasterio.io import MemoryFile

        with MemoryFile() as mem:
            with mem.open(
                driver="GTiff", width=8, height=8, count=1, dtype="uint8",
                crs="EPSG:32649", transform=rasterio.transform.from_origin(522000, 131000, 1, 1),
            ) as ds:
                ds.write(np.ones((1, 8, 8), dtype="uint8"))
        out["gdal_driver_ok"] = True
    except Exception as e:  # noqa: BLE001
        out["gdal_driver_ok"] = False
        out["gdal_error"] = f"{type(e).__name__}: {e}"
        ok = False

    out["ok"] = ok
    print(json.dumps(out, ensure_ascii=False), flush=True)
    return 0 if ok else 3


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)

    if args and args[0] == "--self-test":
        return _self_test()

    if args and args[0] in ("--run-tile-server", "--tile-server"):
        import tile_server

        # tile_server.main() 读的是 sys.argv，这里替它摆好
        sys.argv = ["tile_server", *args[1:]]
        return tile_server.main()

    if args and args[0] == "--build-derived":
        # 生成高度图 / 林地边界。与 sidecar 一样走 NDJSON 事件流，
        # 只是事件名不同（derived-*）—— 宿主按事件名分派，不靠进程参数区分。
        import build_derived

        return build_derived.main(args[1:])

    # 默认：sidecar（算法跑批）
    import sidecar

    return sidecar.main(args)


if __name__ == "__main__":
    # ★ 红线 1：必须第一行，且必须在任何 argparse / 模式分发之前。
    #   Windows 下进程池的子进程会带 --multiprocessing-fork 重新执行本 exe，
    #   这一行会把它们接管并直接返回，不会走到 main()。
    import multiprocessing

    multiprocessing.freeze_support()
    sys.exit(main())
