"""从 DSM 生成 CHM，再从 CHM + 树心表生成森林掩膜（供桌面端「生成高度图 / 林地边界」按钮调用）。

## 为什么单独一个模块

`build_chm.py` 与 `build_forest_mask.py` 都是独立 CLI，各自 argparse、各自 print。
桌面端要的不是两个黑盒，而是**一份可跟踪的进度流**。所以这里做一层薄包装：

- 入参由调用方给绝对路径（打包态没有 cwd 概念，相对路径会解析到 py-runtime 里）
- 输出 NDJSON 到 stdout（与 sidecar 同一套事件约定），人类可读日志走 stderr
- **不修改算法脚本本身** —— 只替换它们模块级的 `log()`，把 print 变成事件

## 事件

    {"event":"derived_started","steps":["chm","mask"],"total_steps":2}
    {"event":"derived_progress","stage":"chm","step":1,"ratio":0.3,"message":"..."}
    {"event":"derived_result","ok":true,"chm":{...},"mask":{...},"elapsed_s":142.3}
    {"event":"derived_error","code":"E4001","message":"..."}

`ratio` 是**按阶段估算**的粗粒度值，不是真实进度 —— CHM 里那个 30 m 窗口的最小值滤波
是纯计算、内部没有可插入的进度点。与其编造假精度，不如给粗阶段 + 最新一行日志，
让界面显示"阶段 + 已用时间 + 最近在干什么"。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path


def _emit(obj: dict) -> None:
    """一行 JSON 到 stdout。flush 是必须的 —— 宿主逐行读，不刷会攒到进程退出才出来。"""
    print(json.dumps(obj, ensure_ascii=False), flush=True)


def _elog(msg: str) -> None:
    """人类日志走 stderr（宿主会转进状态栏的滚动日志）。"""
    print(msg, file=sys.stderr, flush=True)


class Progress:
    """把算法脚本的 `log()` 转成事件。

    为什么替换而不是自己 print 进度：两个脚本加起来有几十条 log，
    改写它们等于把算法文件变成 UI 的一部分（以后动算法就得考虑 UI）。
    替换模块级函数是最小侵入 —— 脚本不知道自己被包装了。

    进度比例的估算依据（实测耗时）：CHM 约占 75%（读取 + 最小值滤波 + 高斯 + 重投影 + 写盘），
    掩膜占 25%（读树心、区块统计、连通域、ExG 闸门、写盘）。
    阶段内按日志行数线性推进 **上限**，最后一条日志才到 100% —— 宁可慢也不要早到 100% 后卡住。
    """

    # 阶段权重（**相对耗时**，不是步数）
    WEIGHT = {"chm": 0.75, "mask": 0.25}
    # 每个阶段的日志行数上限（用于把"第几条日志"折成阶段内比例）。
    # 这是经验值：超过上限就当本阶段接近完成，但不到 1.0。
    EXPECT_LINES = {"chm": 12, "mask": 16}

    def __init__(self) -> None:
        self.seen: dict[str, int] = {"chm": 0, "mask": 0}
        self.stage = "chm"
        self.step = 1
        self.t0 = time.time()

    def make_logger(self, stage: str):
        """返回一个可赋给模块级 `log` 的函数。"""

        def _log(msg: str) -> None:
            msg = str(msg).strip()
            if not msg:
                return
            self.seen[stage] = self.seen[stage] + 1
            n = self.seen[stage]
            cap = self.EXPECT_LINES.get(stage, 12)
            # 阶段内比例：0.05 起步（让人看到动了），封顶 0.95（剩下 5% 留给"写盘完成"）
            inner = min(0.05 + (n - 1) / max(cap, 1) * 0.9, 0.95)
            ratio = self._base(stage) + self.WEIGHT.get(stage, 0.5) * inner
            _emit(
                {
                    "event": "derived_progress",
                    "stage": stage,
                    "step": self.step,
                    "total_steps": 2,
                    "ratio": round(min(ratio, 0.98), 4),
                    "elapsed_s": round(time.time() - self.t0, 1),
                    "message": msg,
                }
            )
            _elog(msg)

        return _log

    def _base(self, stage: str) -> float:
        """本阶段开始前的累计比例。"""
        if stage == "chm":
            return 0.0
        return self.WEIGHT.get("chm", 0.0)

    def enter(self, stage: str, step: int) -> None:
        self.stage = stage
        self.step = step
        _emit(
            {
                "event": "derived_progress",
                "stage": stage,
                "step": step,
                "total_steps": 2,
                "ratio": round(self._base(stage), 4),
                "elapsed_s": round(time.time() - self.t0, 1),
                "message": {"chm": "正在生成高度图…", "mask": "正在生成林地边界…"}.get(
                    stage, ""
                ),
            }
        )


class _StdoutGuard:
    """把"不是我们发的 JSON"的输出挡到 stderr。

    ## 为什么需要

    `build_chm.py` / `build_forest_mask.py` 的日志都走模块级 `log()`，
    我们已经把它替换掉了。但**库**（GDAL / rasterio / scipy）偶尔会往
    stdout 打东西（版本警告、proj 提示）。宿主是逐行解析 stdout 的 NDJSON，
    多一行非 JSON 就多一条 `raw` 事件 —— 不致命，但会污染事件通道。

    所以：凡是以 `{` 开头且能解析成 JSON 的才放行到真 stdout，其余转 stderr。
    这样算法脚本和第三方库都被兜住，而我们自己 `_emit()` 不受影响
    （它写的是 `self._real`）。

    ⚠️ 用 `getattr` 而不是属性赋值：`print()` 走的是 `sys.stdout.write`，
       但 `json.dump(obj, sys.stdout)` 会调 `write`；两种都覆盖。
    """

    def __init__(self) -> None:
        self._real = sys.stdout
        self._buf = ""

    def write(self, s: str) -> int:
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._out(line)
        return len(s)

    def _out(self, line: str) -> None:
        t = line.strip()
        if not t:
            return
        if t.startswith("{"):
            self._real.write(line + "\n")
            self._real.flush()
        else:
            # 非事件行：当成人类日志（宁可多一行日志，也不要污染事件流）
            print(line, file=sys.stderr, flush=True)

    def flush(self) -> None:
        if self._buf:
            self._out(self._buf)
            self._buf = ""
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)


def _require(p: str | None, label: str, code: str) -> Path:
    if not p:
        raise _Err(code, f"{label} 没有指定")
    pb = Path(p)
    if not pb.exists():
        raise _Err(code, f"{label} 不存在：{pb}")
    return pb


class _Err(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def run(args: argparse.Namespace) -> dict:
    t0 = time.time()

    # ---- 入参校验：错在哪一个文件、叫什么名字，都要说清 ----
    # （用户看不到命令行的 argparse 报错，只会看到一个"失败"）
    ortho = _require(args.ortho, "正射影像", "E4001")
    dsm = _require(args.dsm, "地表高程 DSM", "E4002")
    out_chm = Path(args.out_chm)
    out_mask = Path(args.out_mask)

    segment: Path | None = None
    if args.segment:
        p = Path(args.segment)
        if p.exists():
            segment = p
        else:
            # 分割图是**可选**的（只影响水面的 CHM 值），缺失不该拦
            _elog(f"⚠️ 语义分割不存在（{p}），水体在 CHM 里不会被置空 —— 继续")
    tree_info: Path | None = None
    mask_skip: str | None = None
    if args.tree_info:
        p = Path(args.tree_info)
        if p.exists():
            tree_info = p
        else:
            # ⚠️ build_forest_mask 的树心表是**必需**输入（没有回退分支）。
            #    所以缺了不是"精度略降"，而是这一步做不了 —— 只能出 CHM。
            #    说清楚比假装成功好：CHM 本身已经能修掉水体漏检和大量误判。
            mask_skip = f"树心表不存在（{p}）—— 林地边界这一步需要它，本次只生成高度图"
            _elog(f"⚠️ {mask_skip}")
    else:
        mask_skip = "没有指定树心表（tree_info.json）—— 本次只生成高度图"
        _elog(f"⚠️ {mask_skip}")

    prog = Progress()
    # 装守卫的时机：**必须在第一条 _emit 之前** —— 否则"装守卫"这件事本身
    # 会让前面已经发出的行进不了新缓冲。而 _emit 内部用的是真 stdout
    # （通过 _StdoutGuard._real），所以装上之后发的事件仍然正常。
    guard = _StdoutGuard()
    sys.stdout = guard
    try:
        return _run_steps(
            ortho, dsm, segment, tree_info, out_chm, out_mask, mask_skip, prog, t0
        )
    finally:
        guard.flush()
        sys.stdout = guard._real


def _run_steps(ortho, dsm, segment, tree_info, out_chm, out_mask, mask_skip, prog, t0):
    _emit(
        {
            "event": "derived_started",
            "steps": ["chm", "mask"],
            "total_steps": 2,
            "ortho": str(ortho),
            "dsm": str(dsm),
            "segment": str(segment) if segment else None,
            "tree_info": str(tree_info) if tree_info else None,
            "out_chm": str(out_chm),
            "out_mask": str(out_mask),
        }
    )

    out_chm.parent.mkdir(parents=True, exist_ok=True)
    out_mask.parent.mkdir(parents=True, exist_ok=True)

    # ---- 步骤 1：CHM ----
    import build_chm as BC

    prog.enter("chm", 1)
    BC.log = prog.make_logger("chm")  # 只替换模块级引用，算法代码一行不动
    chm_stats = BC.build_chm(
        str(dsm),
        str(segment) if segment else None,
        str(ortho),
        str(out_chm),
    )
    _emit(
        {
            "event": "derived_progress",
            "stage": "chm",
            "step": 1,
            "total_steps": 2,
            "ratio": round(Progress.WEIGHT["chm"], 4),
            "elapsed_s": round(time.time() - t0, 1),
            "message": f"高度图已写出：{out_chm.name}",
        }
    )

    # ---- 步骤 2：森林掩膜（缺树心表就跳过）----
    mask_stats: dict | None = None
    if mask_skip is None:
        import build_forest_mask as BM

        prog.enter("mask", 2)
        BM.log = prog.make_logger("mask")
        mask_stats = BM.build_mask(
            str(out_chm),
            str(tree_info),
            str(ortho),
            str(out_mask),
        )
        mask_path: str | None = str(out_mask)
    else:
        mask_path = None
        _emit(
            {
                "event": "derived_progress",
                "stage": "mask",
                "step": 2,
                "total_steps": 2,
                "ratio": 0.75,
                "elapsed_s": round(time.time() - t0, 1),
                "message": f"跳过林地边界：{mask_skip}",
            }
        )

    elapsed = round(time.time() - t0, 1)
    _emit(
        {
            "event": "derived_result",
            "ok": True,
            "elapsed_s": elapsed,
            "chm_path": str(out_chm),
            "mask_path": mask_path,
            "note": mask_skip,
            "chm": {k: v for k, v in (chm_stats or {}).items() if _jsonable(v)},
            "mask": (
                {k: v for k, v in (mask_stats or {}).items() if _jsonable(v)}
                if mask_stats
                else None
            ),
        }
    )
    return {"ok": True, "elapsed_s": elapsed}


def _jsonable(v) -> bool:
    return isinstance(v, (int, float, str, bool)) or v is None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="从 DSM 生成 CHM 与森林掩膜（桌面端按钮的后端）",
    )
    ap.add_argument("--ortho", required=True, help="正射影像（.tif），决定对齐网格")
    ap.add_argument("--dsm", required=True, help="地表高程 DSM（.tif，含树）")
    ap.add_argument("--segment", default="", help="语义分割（可选，用于把水面置空）")
    ap.add_argument("--tree-info", default="", help="大疆树心表（可选）")
    ap.add_argument("--out-chm", required=True)
    ap.add_argument("--out-mask", required=True)
    args = ap.parse_args(argv)

    try:
        run(args)
        return 0
    except _Err as e:
        _emit({"event": "derived_error", "code": e.code, "message": e.message})
        _elog(f"❌ {e.message}")
        return 4
    except Exception as e:  # noqa: BLE001 —— 任何异常都要变成事件，否则前端只会看到"进程退出"
        _emit(
            {
                "event": "derived_error",
                "code": "E4099",
                "message": f"{type(e).__name__}: {e}",
                "trace": traceback.format_exc(limit=6),
            }
        )
        _elog(traceback.format_exc(limit=6))
        return 5


if __name__ == "__main__":
    sys.exit(main())
