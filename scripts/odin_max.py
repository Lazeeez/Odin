import argparse
import dataclasses
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

import more_data  # noqa: E402

from odin.eval.dataset import load_instances  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.metrics import aggregate, paired_bootstrap, score  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.eval.runner import DEV_SELECTED_FUSION, Query  # noqa: E402
from odin.rank.ce_train import build_ce_data_from_ltr, rerank, validation_split  # noqa: E402
from odin.rank.ltr import RankingData, cross_validate  # noqa: E402

GOLD = ROOT / "data" / "gold"
OUT = ROOT / "results" / "odin-max"
WORK = OUT / "work"
HELD_OUT_FOLD = 0
DEPTHS = (20, 50)
WEIGHTS = (0.25, 0.5, 1.0, 2.0, 4.0, float("inf"))
TOP = 10
KS = (1, 5, 10)


def gold_entries() -> dict:
    in_lite = {g.instance_id for g in read_gold(GOLD / "swebench_lite_test.jsonl")}
    swe = [g for g in read_gold(GOLD / "swebench_full_test.jsonl") if g.instance_id not in in_lite]
    return {g.instance_id: g for g in swe + more_data.rebench_gold()}


def issue_texts() -> dict:
    texts = {i.instance_id: i.problem_statement for i in load_instances("full", "test")}
    texts |= {i.instance_id: i.problem_statement for i in load_instances("rebench", "train")}
    return texts


def held_out_issues() -> tuple[set[str], set[str]]:
    rebench = more_data.rebench_gold()
    repo_of = {g.instance_id: g.repo for g in rebench}
    repos = sorted({repo_of[q] for q in more_data.load_parts("function").qids})
    order = np.random.default_rng(0).permutation(len(repos))
    fold_of = {repos[r]: i % more_data.FOLDS for i, r in enumerate(order)}
    fold = {g.instance_id for g in rebench if fold_of.get(g.repo) == HELD_OUT_FOLD}
    swe = [g for g in gold_entries().values() if g.instance_id not in repo_of]
    validation = validation_split([g.instance_id for g in swe if g.functions or g.classes])
    return validation, fold


def function_data() -> RankingData:
    return more_data.merge(
        [RankingData.load(more_data.SWE_BENCH["function"]), more_data.load_parts("function")]
    )


def keep(data: RankingData, wanted) -> RankingData:
    rows = [i for i, q in enumerate(data.qids) if wanted(q)]
    starts = np.r_[0, np.cumsum(data.group)]
    flat = np.concatenate([np.arange(starts[i], starts[i + 1]) for i in rows])
    return RankingData(
        data.X[flat],
        data.y[flat],
        data.group[rows],
        data.n_gold[rows],
        [data.qids[i] for i in rows],
        data.ids[flat] if data.ids is not None else None,
    )


def retriever():
    from odin.search.dense import SentenceEncoder
    from odin.search.retriever import HybridRetriever

    return HybridRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)


def train_data() -> int:
    target = WORK / "train_records.jsonl"
    if target.exists():
        sys.exit(f"{target} exists")
    validation, fold = held_out_issues()
    data = keep(function_data(), lambda q: q not in validation and q not in fold)
    names = json.loads((more_data.MODELS / "ltr_function.json").read_text(encoding="utf-8"))[
        "features"
    ]
    cross_validate(data, "fused_logrank", names, folds=more_data.FOLDS)
    r = retriever()
    records = build_ce_data_from_ltr(r, data, list(gold_entries().values()), issue_texts())
    r.close()
    WORK.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")
    print(
        f"{len(records)} training issues ({len(validation)} validation and {len(fold)} held-out issues excluded)"
    )
    return 0


def eval_tasks() -> int:
    target = WORK / "eval_tasks.jsonl"
    if target.exists():
        sys.exit(f"{target} exists")
    validation, fold = held_out_issues()
    full = function_data()
    train = keep(full, lambda q: q not in validation and q not in fold)
    rounds = json.loads((more_data.MODELS / "ltr_function.json").read_text(encoding="utf-8"))[
        "rounds"
    ]
    ranker = more_data.fit(train, rounds)
    tasks = keep(full, lambda q: q in validation or q in fold)
    entries, texts = gold_entries(), issue_texts()
    starts = np.r_[0, np.cumsum(tasks.group)]
    r = retriever()
    r.warmup([Query(q, entries[q].repo, entries[q].base_commit, "") for q in tasks.qids])
    WORK.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for i, qid in enumerate(tasks.qids):
            rows = slice(starts[i], starts[i + 1])
            scores = ranker.predict(tasks.X[rows])
            order = np.argsort(-scores, kind="stable")
            ids = tasks.ids[rows][order].tolist()
            entry = entries[qid]
            query = Query(qid, entry.repo, entry.base_commit, texts[qid])
            index = r._snapshot(query, "function")
            row_of = {unit: n for n, unit in enumerate(index.ids)}
            top = ids[: max(DEPTHS)]
            handle.write(
                json.dumps(
                    {
                        "qid": qid,
                        "set": "validation" if qid in validation else "held-out fold",
                        "query": texts[qid],
                        "ids": ids[:100],
                        "ranker_scores": scores[order][:100].tolist(),
                        "texts": r.indexer.unit_texts(index, [row_of[u] for u in top]),
                        "gold": entry.functions + entry.classes,
                    }
                )
                + "\n"
            )
            if (i + 1) % 50 == 0:
                print(i + 1, len(tasks.qids), flush=True)
    r.close()
    print(f"wrote {target}: {len(tasks.qids)} issues")
    return 0


def score_tasks(name: str, adapters: list[Path], base: str | None) -> int:
    from odin.rank.cross_encoder import CrossEncoder

    target = WORK / f"scores_{name}.jsonl"
    done = set()
    if target.exists():
        done = {json.loads(line)["qid"] for line in target.open(encoding="utf-8")}
    members = [CrossEncoder(adapter=a, base=base) for a in adapters] or [CrossEncoder(base=base)]
    with target.open("a", encoding="utf-8", newline="\n") as handle:
        for n, line in enumerate((WORK / "eval_tasks.jsonl").open(encoding="utf-8"), start=1):
            task = json.loads(line)
            if task["qid"] in done:
                continue
            raw = [m.score(task["query"], task["texts"]) for m in members]
            handle.write(
                json.dumps({"qid": task["qid"], "scores": [s.tolist() for s in raw]}) + "\n"
            )
            handle.flush()
            if n % 25 == 0:
                print(n, flush=True)
    print(f"wrote {target}")
    return 0


def blended(task: dict, member_scores: list[list[float]], depth: int, weight: float) -> list[str]:
    def z(x):
        x = np.asarray(x, float)
        return (x - x.mean()) / x.std() if x.std() > 0 else np.zeros_like(x)

    ce = np.mean([z(s[:depth]) for s in member_scores], axis=0)
    base = np.asarray(task["ranker_scores"][:depth])
    order = np.argsort(-rerank(base, ce, weight), kind="stable")
    head = [task["ids"][i] for i in order]
    return head + task["ids"][depth:]


def scores_for(tasks: list[dict], name: str, depth: int, weight: float) -> list:
    raw = {
        r["qid"]: r["scores"]
        for r in map(json.loads, (WORK / f"scores_{name}.jsonl").open(encoding="utf-8"))
    }
    return [score(blended(t, raw[t["qid"]], depth, weight)[:TOP], t["gold"], KS) for t in tasks]


def values(scores: list, metric: str) -> np.ndarray:
    return more_data.values(scores, metric)


def evaluate(current: str, candidate: str) -> int:
    tasks = [json.loads(line) for line in (WORK / "eval_tasks.jsonl").open(encoding="utf-8")]
    tasks = [t for t in tasks if t["gold"]]
    validation = [t for t in tasks if t["set"] == "validation"]
    fold = [t for t in tasks if t["set"] == "held-out fold"]

    def choose(name: str, depths) -> tuple[int, float]:
        grid = {
            (d, w): aggregate(scores_for(validation, name, d, w), KS)["mrr"]
            for d in depths
            for w in WEIGHTS
        }
        return max(grid, key=grid.get)

    settings = {current: choose(current, (20,)), candidate: choose(candidate, DEPTHS)}
    report = {"settings_chosen_on_validation": {k: list(v) for k, v in settings.items()}}
    for label, subset in (("held-out fold", fold), ("validation", validation)):
        a = scores_for(subset, current, *settings[current])
        b = scores_for(subset, candidate, *settings[candidate])
        report[label] = {
            "issues": len(subset),
            current: aggregate(a, KS),
            candidate: aggregate(b, KS),
            "paired": {
                m: dataclasses.asdict(paired_bootstrap(values(a, m), values(b, m)))
                for m in ("recall@10", "mrr", "hit@10", "all@10", "recall@1")
            },
        }
    report["provenance"] = provenance()
    target = OUT / f"lever1_{candidate}.json"
    target.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({k: v for k, v in report.items() if k != "provenance"}, indent=1)[:3000])
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["train-data", "eval-tasks", "score", "evaluate"])
    ap.add_argument("--name")
    ap.add_argument("--adapter", type=Path, nargs="*", default=[])
    ap.add_argument("--base")
    ap.add_argument("--current", default="current")
    ap.add_argument("--candidate")
    args = ap.parse_args()
    if args.step == "train-data":
        return train_data()
    if args.step == "eval-tasks":
        return eval_tasks()
    if args.step == "score":
        return score_tasks(args.name, args.adapter, args.base)
    return evaluate(args.current, args.candidate)


if __name__ == "__main__":
    sys.exit(main())
