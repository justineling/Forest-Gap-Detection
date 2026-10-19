#!/usr/bin/env python3
"""用人工验证集给检测结果打分。

## 用法

    # 单份结果
    python scripts/eval_validation.py validation-gt-150.json output/wgr17-final-gaps.geojson

    # 两份结果同台对比（702 版 vs 727 版 —— 决定该用哪套网格）
    python scripts/eval_validation.py validation-gt-150.json \
        output/wgr17-final-gaps.geojson output/_tests/repro-b-gaps.geojson

## 三种准确率回答三个不同的问题

| 指标 | 回答什么 | 为什么不能只看这个 |
|---|---|---|
| **样本准确率** | 我标的这 150 块里对了多少 | 有偏 —— L1 必抽、L2 只抽 13%，简单平均不代表全园 |
| **加权准确率** | 全园 1,726 块大概对了多少 | Horvitz-Thompson 无偏估计。**对外报数用这个** |
| **面积准确率** | 需补种的总面积误差多大 | 业务真正付钱的那个数（大斑块判错代价远大于小碎斑） |

## 为什么权重必须由抽样端写入

每块被抽中的概率不同（L1 = 100%，L2 = 60/465 ≈ 13%）。
直接在评估端"猜"权重会错 —— 它不知道抽样时的分层配额。
所以 `validation-gt-*.json` 里每块都带 `stratum` / `weight` / `stratum_total`。

## 退出码

0 = 打分成功；非 0 = 输入有问题（文件缺失 / 标注为空 / 结果文件读不到）。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

# 真值 4 类的名字（与前端 lib/validation.ts 的 GT_LABEL_META 保持一致）
GT_LABEL = {1: "真需补种", 2: "无需补种", 3: "不可种植", 4: "存疑"}

# 算法类别 → 真值等价类。
# ⚠️ 必须与前端 classToGt() 一字不差，否则两边打分不同 —— 那比不打分更糟。
CLASS_GROUP = {
    "open_patch": "definite_plant",
    "vacant_slot": "definite_plant",
    "manual_add": "definite_plant",
    "alley_gap": "not_needed",
    "road": "unplantable",
    "water": "unplantable",
    "office": "unplantable",
    "undeveloped": "unplantable",
    "uncertain": "review",
}
GROUP_TO_GT = {
    "definite_plant": 1,
    "not_needed": 2,
    "unplantable": 3,
    "review": 4,
}

STRATUM_LABEL = {
    "L1_top_area": "L1 最大连片空地",
    "L2_uncertain": "L2 待复核",
    "L3_plantable": "L3 其余可补种",
    "L3_alley": "L3 林间空隙",
    "L3_unplantable": "L3 不可种植",
}


def class_to_gt(cls: str) -> int:
    return GROUP_TO_GT.get(CLASS_GROUP.get(cls, ""), 4)


def load_features(path: Path) -> dict[str, dict]:
    """读检测结果，返回 {gap_id: properties}。

    ⚠️ 顶层 features 可能是空的 —— 整幅结果把要素放在 blocks[*].gaps 下。
       只读顶层会得到 0 块（这个坑在桌面端踩过）。
    """
    obj = json.loads(path.read_text(encoding="utf-8"))
    feats = obj.get("features") or []
    if not feats:
        for b in obj.get("blocks", []):
            feats.extend(b.get("gaps", []))
    out: dict[str, dict] = {}
    for f in feats:
        p = f.get("properties") or {}
        gid = p.get("gap_id")
        if gid:
            out[gid] = p
    return out


def evaluate(gt_blob: dict, features: dict[str, dict], name: str) -> dict:
    samples = gt_blob.get("samples") or []
    records = gt_blob.get("records") or {}

    labeled = 0
    unsure = 0
    correct = 0
    w_sum = 0.0
    w_correct = 0.0
    a_sum = 0.0
    a_correct = 0.0
    confusion: Counter = Counter()
    by_stratum: dict[str, dict] = defaultdict(
        lambda: {"sampled": 0, "labeled": 0, "correct": 0}
    )
    # 需补种口径（gt=1 为正类）
    tp = fp = fn = 0
    # 结果文件里找不到的样本（换了一批数据？）
    missing = 0

    for s in samples:
        gid = s["gap_id"]
        stratum = s.get("stratum", "?")
        st = by_stratum[stratum]
        st["sampled"] += 1

        rec = records.get(gid)
        # 「认同算法」→ 真值 = 算法判定的等价类
        if rec and rec.get("gt") is not None:
            gt = int(rec["gt"])
        elif rec and rec.get("confirmed"):
            gt = class_to_gt(s.get("algo_class", ""))
        else:
            continue

        if gt == 4:
            unsure += 1
            continue

        feat = features.get(gid)
        if feat is None:
            missing += 1
            continue

        pred = class_to_gt(feat.get("class", ""))
        weight = float(s.get("weight") or 1.0)
        area = float(s.get("area_sqm") or 0.0)

        labeled += 1
        st["labeled"] += 1
        ok = pred == gt
        if ok:
            correct += 1
            st["correct"] += 1

        w_sum += weight
        if ok:
            w_correct += weight
        a_sum += area
        if ok:
            a_correct += area

        confusion[(pred, gt)] += 1

        if gt == 1 and pred == 1:
            tp += 1
        elif gt != 1 and pred == 1:
            fp += 1
        elif gt == 1 and pred != 1:
            fn += 1

    return {
        "name": name,
        "total": len(samples),
        "labeled": labeled,
        "unsure": unsure,
        "pending": len(samples) - labeled - unsure,
        "missing_in_result": missing,
        "sample_acc": correct / labeled if labeled else 0.0,
        "weighted_acc": w_correct / w_sum if w_sum else 0.0,
        "area_acc": a_correct / a_sum if a_sum else 0.0,
        "confusion": confusion,
        "by_stratum": dict(by_stratum),
        "plantable": {
            "tp": tp,
            "fp": fp,
            "fn": fn,
            "precision": tp / (tp + fp) if tp + fp else 0.0,
            "recall": tp / (tp + fn) if tp + fn else 0.0,
        },
    }


def pct(v: float) -> str:
    return f"{v * 100:5.1f}%"


def print_report(r: dict) -> None:
    print("=" * 70)
    print(f"  {r['name']}")
    print("=" * 70)
    print(f"  抽样 {r['total']} 块 · 已标 {r['labeled']} · 存疑 {r['unsure']} · 未标 {r['pending']}")
    if r["missing_in_result"]:
        print(f"  ⚠️ 有 {r['missing_in_result']} 块在结果文件里找不到（换了一批数据？）")
    if r["labeled"] == 0:
        print("  ❌ 没有可用标注，无法打分")
        return

    print()
    print(f"  样本准确率        {pct(r['sample_acc'])}   （这 {r['labeled']} 块里对了多少）")
    print(f"  ★ 全园无偏准确率  {pct(r['weighted_acc'])}   （Horvitz-Thompson 加权，对外报数用这个）")
    print(f"  面积加权准确率    {pct(r['area_acc'])}   （需补种总面积的误差口径）")

    p = r["plantable"]
    print()
    print(
        f"  「确定需补种」口径：精确率 {pct(p['precision'])} · 召回率 {pct(p['recall'])}"
        f"   （tp={p['tp']} fp={p['fp']} fn={p['fn']}）"
    )
    if p["fp"] > p["tp"] * 0.2:
        print("    ⚠️ 精确率偏低：算法报了很多「实际不用补」的块 → 多数为误报")
    if p["fn"] > p["tp"] * 0.2:
        print("    ⚠️ 召回率偏低：漏掉了很多「实际需要补」的块 → 现场会漏挖")

    print()
    print("  各层明细：")
    for k in sorted(r["by_stratum"]):
        s = r["by_stratum"][k]
        acc = s["correct"] / s["labeled"] if s["labeled"] else 0.0
        print(
            f"    {STRATUM_LABEL.get(k, k):<16} 抽 {s['sampled']:>3} · "
            f"标 {s['labeled']:>3} · 对 {s['correct']:>3} · {pct(acc)}"
        )

    print()
    print("  混淆矩阵（行=算法判定，列=人工真值）：")
    preds = sorted({p_ for p_, _ in r["confusion"]})
    actuals = sorted({a for _, a in r["confusion"]})
    head = "        " + "".join(f"{GT_LABEL[a]:>10}" for a in actuals)
    print(head)
    for pr in preds:
        row = f"  {GT_LABEL[pr]:<6}"
        for ac in actuals:
            n = r["confusion"].get((pr, ac), 0)
            row += f"{n if n else '·':>10}"
        print(row)
    print()


def selftest() -> int:
    """用内置 fixture 跑一遍，确认权重与准确率算法正确。

    为什么值得有：这套打分逻辑的价值全在"数字对"。
    如果权重算错，输出依然是**一个看起来正常的百分数** —— 不会报错，只会误导决策。
    所以用能手算的小例子钉死它。
    """
    bad = 0

    def ck(ok: bool, label: str, detail: str = "") -> None:
        nonlocal bad
        print(f"  [{'OK  ' if ok else 'FAIL'}] {label}" + (f"  ·  {detail}" if detail else ""))
        if not ok:
            bad += 1

    # 4 块，权重 1 / 7 / 16 / 30；3 对 1 错
    blob = {
        "samples": [
            {"gap_id": "a", "stratum": "L1_top_area", "weight": 1, "algo_class": "open_patch", "area_sqm": 100},
            {"gap_id": "b", "stratum": "L2_uncertain", "weight": 7, "algo_class": "uncertain", "area_sqm": 50},
            {"gap_id": "c", "stratum": "L3_alley", "weight": 16, "algo_class": "alley_gap", "area_sqm": 20},
            {"gap_id": "d", "stratum": "L3_unplantable", "weight": 30, "algo_class": "road", "area_sqm": 300},
        ],
        "records": {
            "a": {"gt": 1, "confirmed": False},
            "b": {"gt": 1, "confirmed": False},   # 算法判 uncertain → 漏判
            "c": {"gt": 2, "confirmed": False},
            "d": {"gt": 3, "confirmed": False},
        },
    }
    feats = {
        "a": {"class": "open_patch"},
        "b": {"class": "uncertain"},
        "c": {"class": "alley_gap"},
        "d": {"class": "road"},
    }
    r = evaluate(blob, feats, "fixture")

    ck(r["labeled"] == 4, "标注数 4", str(r["labeled"]))
    ck(abs(r["sample_acc"] - 0.75) < 1e-9, "样本准确率 3/4", f"{r['sample_acc']:.4f}")
    ck(
        abs(r["weighted_acc"] - 47 / 54) < 1e-9,
        "★ 加权准确率 47/54（必须 ≠ 3/4，否则权重没生效）",
        f"{r['weighted_acc']:.4f}",
    )
    ck(
        abs(r["area_acc"] - 420 / 470) < 1e-9,
        "面积加权 420/470",
        f"{r['area_acc']:.4f}",
    )
    ck(
        r["weighted_acc"] != r["sample_acc"],
        "★ 加权与样本准确率不相同",
    )
    ck(r["plantable"]["tp"] == 1 and r["plantable"]["fp"] == 0 and r["plantable"]["fn"] == 1,
       "需补种口径 tp/fp/fn = 1/0/1",
       f"{r['plantable']['tp']}/{r['plantable']['fp']}/{r['plantable']['fn']}")
    ck(abs(r["plantable"]["recall"] - 0.5) < 1e-9, "召回率 0.5")
    ck(abs(r["plantable"]["precision"] - 1.0) < 1e-9, "精确率 1.0")

    # 认同算法 → 真值 = 算法等价类
    blob2 = {
        "samples": [{"gap_id": "x", "stratum": "L1_top_area", "weight": 1,
                     "algo_class": "open_patch", "area_sqm": 10}],
        "records": {"x": {"gt": None, "confirmed": True}},
    }
    r2 = evaluate(blob2, {"x": {"class": "open_patch"}}, "confirm")
    ck(r2["labeled"] == 1 and abs(r2["sample_acc"] - 1.0) < 1e-9, "认同算法 → 判对")

    # 存疑单列
    blob3 = {
        "samples": [{"gap_id": "y", "stratum": "L1_top_area", "weight": 1,
                     "algo_class": "open_patch", "area_sqm": 10}],
        "records": {"y": {"gt": 4, "confirmed": False}},
    }
    r3 = evaluate(blob3, {"y": {"class": "open_patch"}}, "unsure")
    ck(r3["unsure"] == 1 and r3["labeled"] == 0, "存疑单列、不计入分母")

    # 结果文件里找不到该块
    blob4 = {
        "samples": [{"gap_id": "z", "stratum": "L1_top_area", "weight": 1,
                     "algo_class": "open_patch", "area_sqm": 10}],
        "records": {"z": {"gt": 1, "confirmed": False}},
    }
    r4 = evaluate(blob4, {}, "missing")
    ck(r4["missing_in_result"] == 1, "结果里缺该块 → 记 missing 而不是崩")

    # 类别映射必须与前端一致
    ck(class_to_gt("open_patch") == 1 and class_to_gt("uncertain") == 4,
       "class_to_gt 与前端 classToGt 一致")
    ck(class_to_gt("undeveloped") == 3, "undeveloped → 不可种植")

    print()
    if bad == 0:
        print("  ✅ 全部通过")
        return 0
    print(f"  ❌ {bad} 项失败")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description="用人工验证集给检测结果打分")
    ap.add_argument("gt", nargs="?", help="validation-gt-*.json（桌面端「导出标注 JSON」产出的）")
    ap.add_argument("results", nargs="*", help="一个或多个检测结果 geojson（同台对比）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出（给脚本用）")
    ap.add_argument("--selftest", action="store_true", help="用内置 fixture 自检（不需要真实数据）")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    if not args.gt or not args.results:
        ap.error("需要 gt 与至少一个 results（或用 --selftest）")

    gt_path = Path(args.gt)
    if not gt_path.exists():
        print(f"❌ 找不到标注文件：{gt_path}", file=sys.stderr)
        return 2
    blob = json.loads(gt_path.read_text(encoding="utf-8"))
    if not blob.get("samples"):
        print("❌ 标注文件里没有 samples（是不是导错了文件？）", file=sys.stderr)
        return 2

    if not blob.get("records"):
        print("⚠️ 标注文件里没有 records —— 一块都还没标", file=sys.stderr)

    reports = []
    for rp in args.results:
        p = Path(rp)
        if not p.exists():
            print(f"❌ 找不到结果文件：{p}", file=sys.stderr)
            return 2
        feats = load_features(p)
        reports.append(evaluate(blob, feats, p.name))

    if args.json:
        out = []
        for r in reports:
            out.append(
                {
                    k: v
                    for k, v in r.items()
                    if k not in ("confusion", "by_stratum")
                }
                | {
                    "confusion": [
                        {"pred": k[0], "actual": k[1], "count": v}
                        for k, v in r["confusion"].items()
                    ],
                    "by_stratum": r["by_stratum"],
                }
            )
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    for r in reports:
        print_report(r)

    # 多份结果时给一句结论，省得用户自己比
    if len(reports) > 1:
        print("=" * 70)
        print("  对比结论（按全园无偏准确率）")
        print("=" * 70)
        best = max(reports, key=lambda x: x["weighted_acc"])
        for r in sorted(reports, key=lambda x: -x["weighted_acc"]):
            mark = " ★ 更优" if r is best else ""
            print(f"    {r['name']:<40} {pct(r['weighted_acc'])}{mark}")
        if len(reports) == 2 and abs(
            reports[0]["weighted_acc"] - reports[1]["weighted_acc"]
        ) < 0.02:
            print()
            print("    ⚠️ 两者差距 < 2 个百分点 —— **在当前标注量下不可区分**。")
            print("       要么加标更多块，要么认为二者等价（那就保持交付基线不动）。")
        print()

    return 0


if __name__ == "__main__":
    sys.exit(main())
