#!/usr/bin/env python3
"""多区块（job）选结果的测试：**同名影像不得串台**。

## 为什么必须单独测这一条

多区块功能里，用户真正会丢的东西不是缓存（重算一次就好），而是**结果**：
block B 的结果写到 block A 的文件上，A 跑 6 分钟的成果就没了；
更糟的是反向的读错 —— 切回 A 时读到 B 的结果，于是
**A 的影像上画着 B 的空地**：数字自洽、没有报错、报告完整，
只有到现场放样才发现坑挖错了地方。这类"看起来正常"的错是最贵的。

## 最容易漏的形态：两张影像**文件名相同**

```
区块A/WGR17-002.tif
区块B/WGR17-002.tif     ← 文件名一模一样，只有目录不同
```

`job` 由文件名算出，所以两者都算出 `wgr17-002`。此时：

| 侧 | 规则 | 结果 |
|---|---|---|
| Rust 写 | `job_id_for_output` 有冲突消解 + 归属校验 | A → `wgr17-002`，B → `wgr17-002-2` |
| Python 读 | `job_gaps_path` 必须**同规则**（候选名 + 归属校验） | 找 A 拿到 A 的，找 B 拿到 B 的 |

只比文件名（`source_image`）是**判不出来**的 —— 两边都叫 `WGR17-002.tif`。
所以归属判据的第一优先是结果里的 `inputs_snapshot.image.path`（完整路径），
文件名只是老结果的兜底。本文件第 C 段专门钉这一点。

## 用法

    .venv/Scripts/python.exe scripts/test_block_jobs.py

退出码 0 = 全过。
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tile_server as ts  # noqa: E402
from tile_server import (  # noqa: E402
    TileServer,
    export_outdir,
    gaps_belongs_to,
    gaps_owner,
    job_gaps_path,
    job_id_for,
    sanitize_job,
)

failures = 0


def check(ok: bool, label: str, detail: str = "") -> None:
    global failures
    print(f"  [{'OK  ' if ok else 'FAIL'}] {label}" + (f"  ·  {detail}" if detail else ""))
    if not ok:
        failures += 1


def use_root(p: Path) -> None:
    """把"仓库根"与 cwd 都指到临时目录（**隔离**）。

    为什么必须做：`gaps_search_dirs()` 除了影像目录，还会加
    `ROOT/output` 与 `cwd/output`（开发态下就是仓库的 `output/`）。
    仓库里有历史结果（`wgr17-final-gaps.geojson` 之类，`source_image`
    正好也叫 `WGR17-002.tif`），不隔离的话这个测试会被它们污染 ——
    "测试跑绿了但什么都没验到"是最坏的一种绿。
    """
    p.mkdir(parents=True, exist_ok=True)
    ts.ROOT = p
    os.chdir(p)


def write_result(
    p: Path,
    *,
    source_path: Path | None,
    marker: str,
    source_image: str | None = None,
    age_s: int = 0,
) -> None:
    """造一份"结果文件"（结构对齐 process_image.py 的产物）。

    `source_path` 为 None 时**不写** `inputs_snapshot`（模拟老结果）。
    `source_image` 为 None 时连 `source_image` 也不写（模拟损坏 / 非本程序产物）。
    """
    p.parent.mkdir(parents=True, exist_ok=True)
    obj: dict = {"type": "FeatureCollection", "schema_version": "0.3"}
    if source_image is not None:
        obj["source_image"] = source_image
    if source_path is not None:
        obj["inputs_snapshot"] = {
            "image": {"path": str(source_path), "mtime": 0, "size": 1},
        }
    obj["features"] = [
        {
            "type": "Feature",
            "properties": {"gap_id": marker},
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[0, 0], [0, 0.001], [0.001, 0.001], [0, 0]]],
            },
        }
    ]
    p.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
    if age_s:
        import time

        t = time.time() - age_s
        os.utime(p, (t, t))


def served_markers(server: TileServer) -> list[str]:
    """走真实服务路径（`/gaps` 背后的 `gaps_json`），取出要素里的 gap_id。"""
    obj = json.loads(server.gaps_json())
    return [f["properties"]["gap_id"] for f in obj.get("features", [])]


def main() -> int:
    cwd0 = Path.cwd()
    tmp = Path(tempfile.mkdtemp(prefix="fgd-blockjobs-"))
    try:
        use_root(tmp)
        out = tmp / "output"
        # ---- 两张**同名**影像（只有目录不同）----
        img_a = tmp / "区块A" / "WGR17-002.tif"
        img_b = tmp / "区块B" / "WGR17-002.tif"
        for p, blob in ((img_a, b"AAAA"), (img_b, b"BBBBBBBB")):
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(blob)

        print("\nA. job 名规则（与 Rust 的 job_id_for 同一套）")
        check(job_id_for(img_a) == "wgr17-002", "同名影像 → 都算出 wgr17-002", str(job_id_for(img_a)))
        check(job_id_for(img_b) == "wgr17-002", "…B 也一样（所以必须靠归属校验分开）")
        check(sanitize_job("Block A") == "block-a", "空格换成 -")
        check(sanitize_job("中文名") == "block", "全非法字符 → 兜底 block")
        check(len(sanitize_job("a" * 200)) == 40, "超长截到 40")

        print("\nB. ★ 同名影像：各自选到各自那份（含冲突消解 job-2）")
        # Rust 侧的分配结果：A 拿到 wgr17-002，B 拿到 wgr17-002-2
        a_gaps = out / "wgr17-002-gaps.geojson"
        b_gaps = out / "wgr17-002-2-gaps.geojson"
        write_result(a_gaps, source_path=img_a, marker="A-1", age_s=3600)  # A 旧
        write_result(b_gaps, source_path=img_b, marker="B-1", age_s=10)  # B 新（刚跑完）

        srv_a = TileServer(img_a, None)
        srv_b = TileServer(img_b, None)

        picked_a = srv_a._pick_gaps()
        picked_b = srv_b._pick_gaps()
        check(
            picked_a is not None and picked_a.name == "wgr17-002-gaps.geojson",
            "★ 当前 A → 选 A 的 wgr17-002-gaps.geojson",
            picked_a.name if picked_a else "(None)",
        )
        check(
            picked_b is not None and picked_b.name == "wgr17-002-2-gaps.geojson",
            "★ 当前 B → 选 B 的 wgr17-002-2-gaps.geojson（不是最新的 A）",
            picked_b.name if picked_b else "(None)",
        )
        # 内容层面：A 的影像上绝不能出现 B 的空地
        ma, mb = served_markers(srv_a), served_markers(srv_b)
        check(ma == ["A-1"], "★ 当前 A 的 /gaps 只含 A 的要素", str(ma))
        check(mb == ["B-1"], "★ 当前 B 的 /gaps 只含 B 的要素", str(mb))
        check("B-1" not in ma and "A-1" not in mb, "★ 两边不串台")

        # 归属判据本身：同一份结果对 A 为真、对 B 为假（同名但不同文件）
        check(gaps_belongs_to(a_gaps, img_a), "A 的结果属于 A")
        check(not gaps_belongs_to(a_gaps, img_b), "★ A 的结果**不**属于 B（同名也判得出）")
        check(gaps_belongs_to(b_gaps, img_b), "B 的结果属于 B")
        check(not gaps_belongs_to(b_gaps, img_a), "★ B 的结果**不**属于 A")

        # ★ 反证：只按 job 找、不做归属校验（修之前的规则）会拿到 **A 的** 文件。
        #   这条断言的价值是"证明上面那些用例真的能抓到这个洞"——
        #   否则将来有人把归属校验去掉，测试可能还是绿的。
        naive = None
        for d in ts.gaps_search_dirs(img_b):
            cand = d / f"{job_id_for(img_b)}-gaps.geojson"
            if cand.is_file():
                naive = cand
                break
        check(
            naive is not None and naive.name == "wgr17-002-gaps.geojson",
            "反证：只按 job 找（不验归属）会拿到 A 的 wgr17-002-gaps.geojson —— 即被修掉的那个洞",
            naive.name if naive else "(None)",
        )
        check(
            naive is not None and not gaps_belongs_to(naive, img_b),
            "反证：那份文件按归属判据确实**不属于** B（所以新规则会跳过它）",
        )

        print("\nC. 归属判据：路径优先，文件名兜底，读不出就不认")
        # 只有 source_image（老结果）→ 退回文件名；同名影像此时**判不出来**，
        # 所以这里只能用不同名的影像验证兜底分支本身是通的
        img_c = tmp / "区块C" / "other.tif"
        img_c.parent.mkdir(parents=True, exist_ok=True)
        img_c.write_bytes(b"CC")
        legacy = out / "other-gaps.geojson"
        write_result(legacy, source_path=None, marker="C-1", source_image="OTHER.TIF")
        check(gaps_belongs_to(legacy, img_c), "老结果（无快照）按文件名认，大小写不敏感")
        check(not gaps_belongs_to(legacy, img_a), "老结果的文件名对不上 → 不认")
        broken = out / "broken-gaps.geojson"
        write_result(broken, source_path=None, marker="X", source_image=None)
        check(not gaps_belongs_to(broken, img_c), "★ 读不出 source_image → 不认（保守）")
        check(not gaps_belongs_to(broken, img_a), "…对任何影像都不认")

        # 三态：`unknown` 在"自动找"里当不是，在"用户亲手指定"里必须认
        check(gaps_owner(broken, img_c) == "unknown", "无元数据 → 三态里的 unknown")
        check(gaps_owner(a_gaps, img_a) == "own", "A 的结果 → own")
        check(gaps_owner(a_gaps, img_b) == "foreign", "★ 同名影像的 A 结果对 B → foreign")
        srv_unknown = TileServer(img_c, broken)
        got_unknown = srv_unknown._pick_gaps()
        check(
            got_unknown is not None and got_unknown.name == "broken-gaps.geojson",
            "★ 用户亲手指定的无元数据结果仍然生效（不因 unknown 被拒）",
            got_unknown.name if got_unknown else "(None)",
        )

        print("\nD. 只跑过一个区块时：另一个区块不能借它的结果")
        tmp2 = Path(tempfile.mkdtemp(prefix="fgd-blockjobs2-"))
        try:
            use_root(tmp2)
            out2 = tmp2 / "output"
            ia = tmp2 / "区块A" / "WGR17-002.tif"
            ib = tmp2 / "区块B" / "WGR17-002.tif"
            for p in (ia, ib):
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b"x")
            write_result(out2 / "wgr17-002-gaps.geojson", source_path=ia, marker="A-1")
            srv_b2 = TileServer(ib, None)
            check(srv_b2._pick_gaps() is None, "★ B 还没跑过 → 找不到结果（不借 A 的）")
            srv_a2 = TileServer(ia, None)
            got = srv_a2._pick_gaps()
            check(
                got is not None and got.name == "wgr17-002-gaps.geojson",
                "A 仍然能找到自己的",
                got.name if got else "(None)",
            )
            # 显式 `--gaps` 指向别人的结果也不能认
            srv_b3 = TileServer(ib, out2 / "wgr17-002-gaps.geojson")
            check(
                srv_b3._pick_gaps() is None,
                "★ 显式指定的结果属于别人 → 也不认（返回 None 而不是 A 的空地）",
            )
        finally:
            import shutil

            shutil.rmtree(tmp2, ignore_errors=True)

        print("\nE. 候选名上限：1..99 找得到，第 100 个找不到（与 Rust 的 JOB_MAX_TRIES 同值）")
        # ⚠️ 这一段以前标题写"上限与 Rust 一致（99）"，实际只造到第 15 张 ——
        #    把 JOB_MAX_TRIES 改成 15 仍然全绿，正好漏掉边界。
        #    现在真的打到边界，三条都要成立：
        #      ① 第 15 张（现实里会遇到的量级）找得到；
        #      ② 第 99 张（上限本身）找得到；
        #      ③ `-100`（Rust 旧版兜底会造出来的名字）**找不到** ——
        #         否则"Rust 写 100、Python 只扫 99"就退化成
        #         "检测成功了但界面没有空地"。
        tmp3 = Path(tempfile.mkdtemp(prefix="fgd-blockjobs3-"))
        try:
            use_root(tmp3)
            out3 = tmp3 / "output"
            imgs = []
            for i in range(100):
                p = tmp3 / f"dir{i}" / "WGR17-002.tif"
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(b"x" * (i + 1))
                imgs.append(p)
            # 第 15、99、100 张各自有一份结果（内容是空的都行，只验"找不找得到"）
            write_result(out3 / "wgr17-002-15-gaps.geojson", source_path=imgs[14], marker="O-15")
            write_result(out3 / "wgr17-002-99-gaps.geojson", source_path=imgs[98], marker="O-99")
            write_result(out3 / "wgr17-002-100-gaps.geojson", source_path=imgs[99], marker="O-100")

            got15 = job_gaps_path(imgs[14], "wgr17-002")
            check(
                got15 is not None and got15.name == "wgr17-002-15-gaps.geojson",
                "第 15 个同名影像的结果找得到",
                got15.name if got15 else "(None)",
            )

            got99 = job_gaps_path(imgs[98], "wgr17-002")
            check(
                got99 is not None and got99.name == "wgr17-002-99-gaps.geojson",
                "★ 第 99 个（上限本身）也找得到 —— 上限不是 9 也不是 15",
                got99.name if got99 else "(None)",
            )

            got100 = job_gaps_path(imgs[99], "wgr17-002")
            check(
                got100 is None,
                "★ 第 100 个找不到（上限就是 99；Rust 用尽时改为报错，不再分配 -100）",
                got100.name if got100 else "(None)",
            )

            check(
                ts.JOB_MAX_TRIES == 99,
                "常量与 Rust 的 JOB_MAX_TRIES 同为 99（改一个就必须改另一个）",
                str(ts.JOB_MAX_TRIES),
            )
        finally:
            import shutil

            shutil.rmtree(tmp3, ignore_errors=True)

        print("\nF. 导出目录：用户选过目录也**必须**按区块分家（否则两块静默互相覆盖）")
        # 交付包里的文件名是固定的（gaps-all-wgs84.geojson / gaps-all.kml / 报告 html），
        # 而前端会记住上次选的导出目录 —— 所以"带 outdir 进来"是第二次导出之后的常态。
        # 旧实现 `outdir = payload["outdir"] or default_dir` 只要 outdir 非空就整个
        # 绕过 `<job>/` 那层，block B 会把 block A 的交付包整个盖掉，且不报错。
        tmp4 = Path(tempfile.mkdtemp(prefix="fgd-blockjobs4-"))
        try:
            use_root(tmp4)
            shared = tmp4 / "交付" / "2026-10"

            # ① 同一个 outdir 连导两次（两个不同区块）→ 两个子目录都在，互不覆盖
            dir_a = export_outdir(str(shared), "wgr17-002")
            dir_b = export_outdir(str(shared), "wgr17-003")
            dir_a.mkdir(parents=True, exist_ok=True)
            dir_b.mkdir(parents=True, exist_ok=True)
            (dir_a / "gaps-all-wgs84.geojson").write_text("A", encoding="utf-8")
            (dir_b / "gaps-all-wgs84.geojson").write_text("B", encoding="utf-8")
            check(dir_a != dir_b, "★ 两个区块的导出目录必须不同", f"{dir_a.name} vs {dir_b.name}")
            check(
                (dir_a / "gaps-all-wgs84.geojson").read_text(encoding="utf-8") == "A",
                "★ A 的交付包没有被 B 覆盖（这就是原来那个静默覆盖）",
            )
            check(
                dir_a.parent == shared and dir_b.parent == shared,
                "两者都落在用户选的父目录下",
                str(dir_a.parent),
            )

            # ② outdir 末段已经是区块名 → 不再套一层（否则 wgr17-002/wgr17-002/）
            mine = export_outdir(str(shared / "wgr17-002"), "wgr17-002")
            check(mine == shared / "wgr17-002", "★ 末段已是区块名 → 不套娃", str(mine))
            check(
                "wgr17-002/wgr17-002" not in str(mine).replace("\\", "/"),
                "不出现重复的区块目录",
                str(mine),
            )
            # 大小写不同也算"已经分好了"（Windows 用户可能手打大写）
            check(
                export_outdir(str(shared / "WGR17-002"), "wgr17-002") == shared / "WGR17-002",
                "末段大小写不同 → 同样不套娃",
            )

            # ③ outdir 留空 → 仍落到默认的 output/desktop-export/<job>/
            d_default = export_outdir("", "wgr17-002")
            check(
                d_default == tmp4 / "output" / "desktop-export" / "wgr17-002",
                "outdir 留空 → 默认 output/desktop-export/<区块>/",
                str(d_default),
            )
            check(
                export_outdir(None, None) == tmp4 / "output" / "desktop-export" / "block",
                "没有区块名 → 兜底 block",
            )

            # ④ 相对路径按 ROOT 解析；脏值（数字 / 空白）当没给
            rel = export_outdir("交付/2026-10", "wgr17-002")
            check(
                rel == tmp4 / "交付" / "2026-10" / "wgr17-002",
                "相对 outdir 按数据根解析，再拼区块名",
                str(rel),
            )
            check(
                export_outdir("   ", "wgr17-002") == d_default,
                "只有空白的 outdir → 当没给",
            )
            check(
                export_outdir(123, "wgr17-002") == d_default,
                "非字符串的 outdir → 当没给（不崩）",
            )
        finally:
            import shutil

            shutil.rmtree(tmp4, ignore_errors=True)
    finally:
        import shutil

        os.chdir(cwd0)
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if failures == 0:
        print("✅ 全部通过")
        return 0
    print(f"❌ {failures} 项失败")
    return 1


if __name__ == "__main__":
    sys.exit(main())
