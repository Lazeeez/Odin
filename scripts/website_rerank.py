import argparse
import dataclasses
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

import browser_ltr as bl  # noqa: E402

from odin.eval.metrics import aggregate, metric_values, paired_bootstrap, score  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402

OUT = ROOT / "results" / "website-rerank"
WORK = OUT / "work"
TASKS = WORK / "tasks.jsonl"
DEPTHS = (20, 50)
WEIGHTS = (0.25, 0.5, 1.0, 2.0, 4.0, float("inf"))
KS = (1, 5, 10)
KEEP = 100
SEED = 0


def website_orders(train: list, snaps) -> list[list[str]]:
    splits = bl.repo_folds(train)
    n_gold = [len(it.targets) for it in train]
    X, Y, _ = bl.stage_rows(train, "b")
    _, oof_b, _ = bl.cv_items(train, X, Y, n_gold, splits)
    embed = bl.make_embedder()
    bl.pass2(train, oof_b, snaps, embed, "train")
    embed.save()
    XC = [it.xc for it in train]
    YC = [
        np.array(
            [u in it.targets for u in (bl.unit_ids(it, it.rows_b[it.sel]) if len(it.sel) else [])],
            np.float32,
        )
        for it in train
    ]
    _, oof_c, _ = bl.cv_items(train, XC, YC, n_gold, splits)
    orders = [bl.reranked(it, sb, sc) for it, sb, sc in zip(train, oof_b, oof_c, strict=True)]
    print(
        "website, out of fold, all training issues:",
        bl.fmt(bl.metrics(orders, [it.targets for it in train])),
    )
    return orders


def build_tasks() -> int:
    if TASKS.exists():
        sys.exit(f"{TASKS} exists")
    sys.modules["__main__"].Item = bl.Item
    snaps = bl.Snapshots()
    parts = {name: bl.build(name, spec, snaps) for name, spec in bl.TRAIN.items()}
    train = parts["swe-bench"] + parts["rebench"]
    orders = website_orders(train, snaps)
    rebench = {it.qid for it in parts["rebench"]}
    WORK.mkdir(parents=True, exist_ok=True)
    written = 0
    with TASKS.open("w", encoding="utf-8", newline="\n") as handle:
        for it, order in zip(train, orders, strict=True):
            if it.qid not in rebench:
                continue
            fn, _, _ = snaps.get(it.repo, it.commit)
            row_of = dict(zip(bl.unit_ids(it, it.rows_b), it.rows_b.tolist(), strict=True))
            ids = order[:KEEP]
            texts = snaps.r.indexer.unit_texts(fn, [row_of[u] for u in ids[: max(DEPTHS)]])
            handle.write(
                json.dumps(
                    {
                        "qid": it.qid,
                        "repo": it.repo,
                        "query": it.text,
                        "ids": ids,
                        "ranker_scores": (-np.log1p(np.arange(1, len(ids) + 1))).tolist(),
                        "texts": texts,
                        "gold": sorted(it.targets),
                    }
                )
                + "\n"
            )
            written += 1
    snaps.close()
    print(
        f"wrote {TASKS}: {written} issues from {len({it.repo for it in parts['rebench']})} projects"
    )
    return 0


def z(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / x.std() if len(x) and x.std() > 0 else np.zeros_like(x)


def blended(task: dict, members: list[list[float]], depth: int, weight: float) -> list[str]:
    n = min(depth, len(task["ids"]), len(members[0]))
    ce = np.mean([z(np.asarray(s[:n], float)) for s in members], axis=0)
    base = z(np.asarray(task["ranker_scores"][:n], float))
    combined = ce if np.isinf(weight) else base + weight * ce
    head = [task["ids"][i] for i in np.argsort(-combined, kind="stable")]
    return head + task["ids"][n:]


def scored(tasks: list[dict], raw: dict, setting) -> list:
    out = []
    for t in tasks:
        ranked = t["ids"] if setting is None else blended(t, raw[t["qid"]], *setting)
        out.append(score(ranked[:10], t["gold"], KS))
    return out


def evaluate(name: str) -> int:
    tasks = [json.loads(line) for line in TASKS.open(encoding="utf-8")]
    tasks = [t for t in tasks if t["gold"] and t["ids"]]
    raw = {
        r["qid"]: r["scores"]
        for r in map(json.loads, (WORK / f"scores_{name}.jsonl").open(encoding="utf-8"))
    }
    missing = [t["qid"] for t in tasks if t["qid"] not in raw]
    if missing:
        sys.exit(f"{len(missing)} issues have no scores, e.g. {missing[:3]}")
    repos = sorted({t["repo"] for t in tasks})
    half = set(
        np.asarray(repos)[np.random.default_rng(SEED).permutation(len(repos))[: len(repos) // 2]]
    )
    halves = [[t for t in tasks if t["repo"] in half], [t for t in tasks if t["repo"] not in half]]
    grid = [(d, w) for d in DEPTHS for w in WEIGHTS]
    report: dict = {"issues": len(tasks), "projects": len(repos), "halves": []}
    pooled_base, pooled_cand = [], []
    for k in (0, 1):
        choose_on, apply_to = halves[k], halves[1 - k]
        hits = {s: aggregate(scored(choose_on, raw, s), KS)["hit@10"] for s in grid}
        best = max(grid, key=lambda s: (hits[s], -s[0]))
        base, cand = scored(apply_to, raw, None), scored(apply_to, raw, best)
        pooled_base += base
        pooled_cand += cand
        report["halves"].append(
            {
                "chosen_on_projects": len({t["repo"] for t in choose_on}),
                "applied_to_issues": len(apply_to),
                "setting": [best[0], None if np.isinf(best[1]) else best[1]],
                "grid_hit@10_on_choosing_half": {
                    f"{d}/{w}": round(v, 4) for (d, w), v in hits.items()
                },
                "website": aggregate(base, KS),
                "with_reranker": aggregate(cand, KS),
            }
        )
    report["pooled"] = {
        "website": aggregate(pooled_base, KS),
        "with_reranker": aggregate(pooled_cand, KS),
        "paired": {
            m: dataclasses.asdict(
                paired_bootstrap(metric_values(pooled_base, m), metric_values(pooled_cand, m))
            )
            for m in ("hit@10", "hit@1", "hit@5", "mrr", "recall@10", "all@10")
        },
    }
    gain = report["pooled"]["paired"]["hit@10"]
    report["decision"] = {
        "rule": "build the server if pooled function hit@10 improves by >= 0.020 with p < 0.05",
        "met": bool(gain["delta"] >= 0.02 and gain["p_value"] < 0.05),
    }
    report["provenance"] = provenance()
    target = OUT / f"server_reranker_{name}.json"
    if target.exists():
        sys.exit(f"{target} exists")
    target.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(
        json.dumps({k: v for k, v in report.items() if k not in ("provenance", "halves")}, indent=1)
    )
    for h in report["halves"]:
        print(
            "setting",
            h["setting"],
            "website",
            round(h["website"]["hit@10"], 4),
            "with reranker",
            round(h["with_reranker"]["hit@10"], 4),
        )
    return 0


SEMANTIC_ORDERS = WORK / "semantic_orders.jsonl"


def semantic_orders() -> int:
    if SEMANTIC_ORDERS.exists():
        sys.exit(f"{SEMANTIC_ORDERS} exists")
    sys.modules["__main__"].Item = bl.Item
    snaps = bl.Snapshots()
    parts = {name: bl.build(name, spec, snaps) for name, spec in bl.TRAIN.items()}
    train = parts["swe-bench"] + parts["rebench"]
    rebench = {it.qid for it in parts["rebench"]}
    splits = bl.repo_folds(train)
    n_gold = [len(it.targets) for it in train]
    X, Y, _ = bl.stage_rows(train, "b")
    _, oof_b, _ = bl.cv_items(train, X, Y, n_gold, splits)
    with SEMANTIC_ORDERS.open("w", encoding="utf-8", newline="\n") as handle:
        for it, sb in zip(train, oof_b, strict=True):
            if it.qid in rebench:
                ids = bl.unit_ids(it, it.rows_b)
                order = [ids[i] for i in bl.order(sb)] if len(sb) else []
                handle.write(json.dumps({"qid": it.qid, "ids": order[:KEEP]}) + "\n")
    snaps.close()
    print(f"wrote {SEMANTIC_ORDERS}")
    return 0


def skip_language_model(name: str) -> int:
    depth, weight = 50, 1.0
    tasks = [json.loads(line) for line in TASKS.open(encoding="utf-8")]
    tasks = [t for t in tasks if t["gold"] and t["ids"]]
    raw = {
        r["qid"]: r["scores"]
        for r in map(json.loads, (WORK / f"scores_{name}.jsonl").open(encoding="utf-8"))
    }
    semantic = {r["qid"]: r["ids"] for r in map(json.loads, SEMANTIC_ORDERS.open(encoding="utf-8"))}
    differ = [t["qid"] for t in tasks if set(semantic[t["qid"]][:depth]) != set(t["ids"][:depth])]
    if differ:
        sys.exit(f"{len(differ)} issues have different top {depth}s, e.g. {differ[:3]}")
    base, cand = [], []
    for t in tasks:
        base.append(score(blended(t, raw[t["qid"]], depth, weight)[:10], t["gold"], KS))
        n = min(depth, len(t["ids"]), len(raw[t["qid"]][0]))
        by_id = {u: [s[i] for s in raw[t["qid"]]] for i, u in enumerate(t["ids"][:n])}
        order = semantic[t["qid"]]
        members = [[by_id[u][m] for u in order[:n]] for m in range(len(raw[t["qid"]]))]
        swapped = {**t, "ids": order}
        cand.append(score(blended(swapped, members, depth, weight)[:10], t["gold"], KS))
    paired = {
        m: dataclasses.asdict(paired_bootstrap(metric_values(base, m), metric_values(cand, m)))
        for m in ("hit@10", "hit@1", "hit@5", "mrr", "recall@10")
    }
    gain = paired["hit@10"]
    report = {
        "issues": len(tasks),
        "projects": len({t["repo"] for t in tasks}),
        "setting": [depth, weight],
        "same_top_50": True,
        "gpu_over_language_model_order": aggregate(base, KS),
        "gpu_over_semantic_order": aggregate(cand, KS),
        "paired": paired,
        "decision": {
            "rule": "skip the language model if hit@10 loss <= 0.005 and the 95% interval's loss end < 0.010",
            "met": bool(gain["delta"] >= -0.005 and gain["ci95"][0] > -0.010),
        },
        "provenance": provenance(),
    }
    target = OUT / f"skip_language_model_{name}.json"
    if target.exists():
        sys.exit(f"{target} exists")
    target.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({k: v for k, v in report.items() if k != "provenance"}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["tasks", "evaluate", "semantic-orders", "skip-language-model"])
    ap.add_argument("--name", default="current")
    args = ap.parse_args()
    steps = {
        "tasks": build_tasks,
        "evaluate": lambda: evaluate(args.name),
        "semantic-orders": semantic_orders,
        "skip-language-model": lambda: skip_language_model(args.name),
    }
    return steps[args.step]()


if __name__ == "__main__":
    sys.exit(main())
