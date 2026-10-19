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

## `--merge-not-plant`：标注口径错位时的补救

真实标注里「无需补种」(2) 与「不可种植」(3) 的分界，普通人分不清 ——
前者是"树冠下、暂时空着"，后者是"路/水/房子，压根不能种"，
两者在正射影像上都是"没树的空地"。第一份真实标注就是 88 个 1 + 62 个 3、零个 2，
于是算法判 `alley_gap`（等价 2）的 15 块里有 13 块被标成 3，全部算错。

这**不是算法错，是标注口径与算法口径没对齐**。加这个开关后：
真值 2/3 合并成「不补」、预测 `not_needed`/`unplantable` 也合并成「不补」，
评估的就变成"这块该不该补"这个业务判断，而不是四分类。
`uncertain` 预测（算法说"要人看"）两边都不算 —— 它不是一个判断，不该记对也不该记错。

⚠️ 不加该参数时输出必须与加之前**逐字节一致**，所以合并口径走独立的
   `evaluate_merged()` / `print_merged()`，不碰 `evaluate()` 的任何计数。

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

# ---- 合并口径（--merge-not-plant）用的标签 ----
# 只有两个真类别 + 一个"不参与计分"的桶。用中文串而不是 int，
# 是为了让混淆矩阵打印出来时直接可读（数字容易和真值 1/2/3 混淆）。
MERGE_PLANT = "补"
MERGE_NOT_PLANT = "不补"
MERGE_REVIEW = "待复核"


def class_to_gt(cls: str) -> int:
    return GROUP_TO_GT.get(CLASS_GROUP.get(cls, ""), 4)


def gt_to_merged(gt: int) -> str | None:
    """真值 → 合并口径标签。gt=4（存疑）返回 None，表示整块排除。

    ⚠️ 2 和 3 都归「不补」，但 4 不能归进来 —— 「存疑」是"人也没看清"，
       不是"不该补"，把它塞进任一边都会凭空制造对/错。
    """
    if gt == 1:
        return MERGE_PLANT
    if gt in (2, 3):
        return MERGE_NOT_PLANT
    return None


def class_to_merged(cls: str) -> str:
    """算法类别 → 合并口径标签。

    `uncertain` 落到 MERGE_REVIEW：算法自己说"要人看"，
    这既不是"补"也不是"不补"，所以既不进分子也不进分母。
    """
    group = CLASS_GROUP.get(cls, "")
    if group == "definite_plant":
        return MERGE_PLANT
    if group in ("not_needed", "unplantable"):
        return MERGE_NOT_PLANT
    return MERGE_REVIEW


def resolve_gt(sample: dict, records: dict) -> int | None:
    """取一块样本的人工真值；没标过（或只点了"跳过"）返回 None。

    「认同算法」这一支（`confirmed` 但没给 gt）把真值取成算法判定的等价类 ——
    用户点了"算法是对的"，等价于把算法类别当成真值。
    """
    rec = records.get(sample["gap_id"])
    if rec and rec.get("gt") is not None:
        return int(rec["gt"])
    if rec and rec.get("confirmed"):
        return class_to_gt(sample.get("algo_class", ""))
    return None


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

        # 「认同算法」→ 真值 = 算法判定的等价类（解析逻辑见 resolve_gt）
        gt = resolve_gt(s, records)
        if gt is None:
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


def evaluate_merged(gt_blob: dict, features: dict[str, dict], name: str) -> dict:
    """合并口径打分：只回答"这块该不该补"，不区分 2 与 3。

    与 `evaluate()` 分开写而不是加一堆 if：严格口径的每个数字（含混淆矩阵的
    行和列）都要保持原样，混在一处最容易"改一个口径顺手把另一个算错"。
    代价是多遍历一遍 samples —— 150 块，无所谓。

    分母 = 真值非 4 且预测不是 `uncertain` 的块。
    `uncertain` 单列（块数 + 权重），既不记对也不记错。
    """
    samples = gt_blob.get("samples") or []
    records = gt_blob.get("records") or {}

    labeled = 0
    unsure = 0
    correct = 0
    w_sum = 0.0
    w_correct = 0.0
    review_n = 0
    review_w = 0.0
    missing = 0
    confusion: Counter = Counter()

    for s in samples:
        gt = resolve_gt(s, records)
        if gt is None:
            continue
        truth = gt_to_merged(gt)
        if truth is None:  # gt=4 存疑
            unsure += 1
            continue

        feat = features.get(s["gap_id"])
        if feat is None:
            missing += 1
            continue

        pred = class_to_merged(feat.get("class", ""))
        weight = float(s.get("weight") or 1.0)

        if pred == MERGE_REVIEW:
            review_n += 1
            review_w += weight
            continue

        labeled += 1
        ok = pred == truth
        if ok:
            correct += 1
        w_sum += weight
        if ok:
            w_correct += weight
        confusion[(pred, truth)] += 1

    return {
        "name": name,
        "total": len(samples),
        "labeled": labeled,
        "unsure": unsure,
        "pending": len(samples) - labeled - unsure - review_n,
        "missing_in_result": missing,
        "correct": correct,
        "weight_sum": w_sum,
        "review_n": review_n,
        "review_w": review_w,
        # 两个口径加起来必须等于"全部可评估样本"的权重 —— 自检里钉死这一点，
        # 防止某天有人把 `continue` 写漏导致权重凭空消失
        "weight_all": w_sum + review_w,
        "sample_acc": correct / labeled if labeled else 0.0,
        "weighted_acc": w_correct / w_sum if w_sum else 0.0,
        "confusion": confusion,
    }


def print_merged(r: dict) -> None:
    """打印合并口径的两行（待复核单列 + 结果行）。"""
    print()
    if r["review_n"]:
        print(
            f"  待复核 {r['review_n']} 块 / 权重 {r['review_w']:.0f}（不计分 —— "
            f"算法说\"要人看\"，不是一个判断）"
        )
    if r["labeled"] == 0:
        print("  合并口径：没有可计分的块")
        return
    print(
        f"  合并口径（2+3=不补，待复核不计分）  样本 {pct(r['sample_acc'])}"
        f"  加权 {pct(r['weighted_acc'])}  "
        f"（{r['labeled']} 块 / 权重 {r['weight_sum']:.0f}）"
    )


def print_report(r: dict, merged: dict | None = None) -> None:
    print("=" * 70)
    print(f"  {r['name']}")
    print("=" * 70)
    print(f"  抽样 {r['total']} 块 · 已标 {r['labeled']} · 存疑 {r['unsure']} · 未标 {r['pending']}")
    if r["missing_in_result"]:
        print(f"  ⚠️ 有 {r['missing_in_result']} 块在结果文件里找不到（换了一批数据？）")
    if r["labeled"] == 0:
        print("  ❌ 没有可用标注，无法打分")
        if merged is not None:
            print_merged(merged)
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

    # 合并口径单独成段，并把它自己的混淆矩阵一并打印 ——
    # 只给一个百分数而不给矩阵，用户无法判断"哪些块被合并救了回来"，
    # 也就无法判断这个数是可信还是被合并硬凑出来的。
    if merged is not None:
        print()
        print("  ── 合并口径（--merge-not-plant）──")
        print_merged(merged)
        if merged["labeled"]:
            mp = sorted({p_ for p_, _ in merged["confusion"]})
            ma = sorted({a for _, a in merged["confusion"]})
            print("  合并混淆矩阵（行=算法判定，列=人工真值）：")
            print("        " + "".join(f"{a:>10}" for a in ma))
            for pr in mp:
                row = f"  {pr:<6}"
                for ac in ma:
                    n = merged["confusion"].get((pr, ac), 0)
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

    # ---- 合并口径（--merge-not-plant）三项 ----
    # ① 同一块：算法判 alley_gap（等价 gt=2），人工标 3。
    #    严格口径算错，合并口径算对 —— 这正是第一份真实标注里
    #    L3_alley 层 15 块里 13 块被判错的原因（不是算法错，是口径错位）。
    blob5 = {
        "samples": [{"gap_id": "m1", "stratum": "L3_alley", "weight": 16,
                     "algo_class": "alley_gap", "area_sqm": 40}],
        "records": {"m1": {"gt": 3, "confirmed": False}},
    }
    f5 = {"m1": {"class": "alley_gap"}}
    s5 = evaluate(blob5, f5, "strict")
    m5 = evaluate_merged(blob5, f5, "merged")
    ck(s5["sample_acc"] == 0.0 and m5["sample_acc"] == 1.0,
       "合并口径：alley_gap 预测 + gt=3 算对（严格口径算错）",
       f"严格 {s5['sample_acc']:.2f} / 合并 {m5['sample_acc']:.2f}")

    # ② `uncertain` 预测不进分母：算法说"要人看"不是一个判断，
    #    记它对会把待复核桶虚报成准确，记它错会把算法冤枉成很差。
    blob6 = {
        "samples": [
            {"gap_id": "u1", "stratum": "L2_uncertain", "weight": 7,
             "algo_class": "uncertain", "area_sqm": 50},
            {"gap_id": "u2", "stratum": "L2_uncertain", "weight": 7,
             "algo_class": "uncertain", "area_sqm": 50},
            {"gap_id": "u3", "stratum": "L1_top_area", "weight": 1,
             "algo_class": "open_patch", "area_sqm": 100},
        ],
        "records": {"u1": {"gt": 1}, "u2": {"gt": 3}, "u3": {"gt": 1}},
    }
    f6 = {"u1": {"class": "uncertain"}, "u2": {"class": "uncertain"},
          "u3": {"class": "open_patch"}}
    m6 = evaluate_merged(blob6, f6, "merged")
    ck(m6["labeled"] == 1 and m6["review_n"] == 2 and abs(m6["sample_acc"] - 1.0) < 1e-9,
       "合并口径：uncertain 预测不进分母",
       f"计分 {m6['labeled']} / 待复核 {m6['review_n']}")

    # ③ 权重守恒：计分的那部分 + 待复核那部分必须等于全部可评估权重。
    #    这条是防"某天有人把 continue 写漏 / 逻辑改写后某桶权重凭空消失"——
    #    权重丢一半时，准确率照样是个漂亮的百分数，没人看得出来。
    ck(abs(m6["weight_all"] - 15.0) < 1e-9,
       "合并口径：计分权重 + 待复核权重 = 总权重（没有凭空消失）",
       f"{m6['weight_sum']:.0f} + {m6['review_w']:.0f} = {m6['weight_all']:.0f}")

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
    ap.add_argument(
        "--merge-not-plant",
        action="store_true",
        help="把真值 2/3 与预测 not_needed/unplantable 合并成「不补」，"
        "uncertain 预测不计分（标注分不清 2 与 3 时用）",
    )
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
    merged_reports = []
    for rp in args.results:
        p = Path(rp)
        if not p.exists():
            print(f"❌ 找不到结果文件：{p}", file=sys.stderr)
            return 2
        feats = load_features(p)
        reports.append(evaluate(blob, feats, p.name))
        if args.merge_not_plant:
            merged_reports.append(evaluate_merged(blob, feats, p.name))

    if args.json:
        out = []
        for i, r in enumerate(reports):
            d = {
                k: v
                for k, v in r.items()
                if k not in ("confusion", "by_stratum")
            } | {
                "confusion": [
                    {"pred": k[0], "actual": k[1], "count": v}
                    for k, v in r["confusion"].items()
                ],
                "by_stratum": r["by_stratum"],
            }
            if args.merge_not_plant:
                m = merged_reports[i]
                d["merged"] = {
                    k: v
                    for k, v in m.items()
                    if k != "confusion"
                } | {
                    "confusion": [
                        {"pred": k[0], "actual": k[1], "count": v}
                        for k, v in m["confusion"].items()
                    ]
                }
            out.append(d)
        print(json.dumps(out, ensure_ascii=False, indent=2))
        return 0

    for i, r in enumerate(reports):
        print_report(r, merged_reports[i] if args.merge_not_plant else None)

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
