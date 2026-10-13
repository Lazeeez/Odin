import argparse
import dataclasses
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import load_instances  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.metrics import aggregate, bootstrap_ci, paired_bootstrap, score  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.eval.runner import DEV_SELECTED_FUSION, Query  # noqa: E402
from odin.rank.ltr import (  # noqa: E402
    LGBM_PARAMS,
    MODEL_DIR,
    RankingData,
    build_ranking_data,
    cross_validate,
    train,
)

GOLD = ROOT / "data" / "gold"
OUT = ROOT / "results" / "more-data"
PARTS = OUT / "parts"
MODELS = MODEL_DIR / "more-data"
SWE_BENCH = {
    "function": ROOT / "results" / "ltr_features_full_minus_lite_function.npz",
    "file": ROOT / "results" / "ltr_features_full_minus_lite_file.npz",
}
LEVEL_SETTINGS = {
    "function": ("fused_logrank", "ltr_function"),
    "file": ("file_fused_logrank", "ltr_file"),
}
N_PARTS = 12
FOLDS = 5
KS = (1, 5, 10)
TOP = 10


def merge(parts: list[RankingData]) -> RankingData:
    return RankingData(
        np.concatenate([p.X for p in parts]),
        np.concatenate([p.y for p in parts]),
        np.concatenate([p.group for p in parts]),
        np.concatenate([p.n_gold for p in parts]),
        [q for p in parts for q in p.qids],
        np.concatenate([p.ids for p in parts]),
    )


def rebench_gold() -> list:
    return [g for g in read_gold(GOLD / "swebench_rebench_train.jsonl") if g.files]


def project_parts(gold: list, n: int) -> list[list]:
    repos = sorted({g.repo for g in gold})
    return [[g for g in gold if g.repo in set(repos[i::n])] for i in range(n)]


def build_features() -> int:
    from odin.rank.features import FeatureExtractor
    from odin.rank.past_issues import IssueMemory
    from odin.search.dense import SentenceEncoder
    from odin.search.retriever import HybridRetriever

    gold = rebench_gold()
    instances = load_instances("rebench", "train")
    text = {i.instance_id: i.problem_statement for i in instances}
    retriever = HybridRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)
    memory = IssueMemory(instances, gold, embed=retriever.embed_queries)
    extractor = FeatureExtractor(retriever, DEV_SELECTED_FUSION, memory=memory)
    PARTS.mkdir(parents=True, exist_ok=True)
    for k, part in enumerate(project_parts(gold, N_PARTS)):
        targets = {level: PARTS / f"{k:02d}_{level}.npz" for level in LEVEL_SETTINGS}
        if all(t.exists() for t in targets.values()):
            continue
        started = time.perf_counter()
        embedded = retriever.units_embedded
        data = build_ranking_data(extractor, part, text)
        for level, target in targets.items():
            data[level].save(target)
        log = {
            "part": k,
            "issues": len(part),
            "projects": len({g.repo for g in part}),
            "seconds": round(time.perf_counter() - started),
            "units_embedded": retriever.units_embedded - embedded,
        }
        print(json.dumps(log), flush=True)
        with (OUT / "features.log").open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(log) + "\n")
    retriever.close()
    return 0


def load_parts(level: str) -> RankingData:
    parts = [RankingData.load(PARTS / f"{k:02d}_{level}.npz") for k in range(N_PARTS)]
    if any(p is None for p in parts):
        sys.exit("some feature parts are missing or stale; run the features step")
    return merge(parts)


def per_query(scores: np.ndarray, data: RankingData) -> list:
    out, start = [], 0
    for size, n_gold in zip(data.group, data.n_gold, strict=True):
        s, y = scores[start : start + size], data.y[start : start + size]
        order = np.argsort(-s, kind="stable")[:TOP]
        ranked = [f"gold{j}" if y[i] else f"other{i}" for j, i in enumerate(order)]
        gold = [f"gold{j}" for j, i in enumerate(order) if y[i]]
        gold += [f"missing{j}" for j in range(int(n_gold) - len(gold))]
        out.append(score(ranked, gold, KS))
        start += size
    return out


def values(scores: list, metric: str) -> np.ndarray:
    if metric == "mrr":
        return np.array([s.rr for s in scores])
    name, k = metric.split("@")
    field = {"recall": "recall", "hit": "hit", "all": "full"}[name]
    return np.array([getattr(s, field)[int(k)] for s in scores])


def fit(data: RankingData, rounds: int):
    import lightgbm as lgb

    model = lgb.LGBMRanker(n_estimators=rounds, random_state=0, **LGBM_PARAMS)
    model.fit(data.X, data.y, group=data.group)
    return model


def subset(data: RankingData, keep) -> RankingData:
    return data.split(np.array([i for i, q in enumerate(data.qids) if keep(q)]))


def unseen_project_test(level: str) -> dict:
    baseline, name = LEVEL_SETTINGS[level]
    swe = RankingData.load(SWE_BENCH[level])
    new = load_parts(level)
    repo_of = {g.instance_id: g.repo for g in rebench_gold()}
    repos = sorted({repo_of[q] for q in new.qids})
    order = np.random.default_rng(0).permutation(len(repos))
    fold_of = {repos[r]: i % FOLDS for i, r in enumerate(order)}
    rounds_alone = json.loads((MODEL_DIR / f"{name}.json").read_text(encoding="utf-8"))["rounds"]
    rounds_more = json.loads((MODELS / f"{name}.json").read_text(encoding="utf-8"))["rounds"]
    alone = fit(swe, rounds_alone)
    a_scores, b_scores, issues = [], [], 0
    for fold in range(FOLDS):
        held_out = subset(new, lambda q, f=fold: fold_of[repo_of[q]] == f)
        rest = subset(new, lambda q, f=fold: fold_of[repo_of[q]] != f)
        more = fit(merge_training(swe, rest), rounds_more)
        a_scores += per_query(alone.predict(held_out.X), held_out)
        b_scores += per_query(more.predict(held_out.X), held_out)
        issues += len(held_out.group)
    return {
        "level": level,
        "issues": issues,
        "projects": len(repos),
        "folds": FOLDS,
        "swe_bench_only": aggregate(a_scores, KS),
        "with_other_projects": aggregate(b_scores, KS),
        "paired": {
            metric: dataclasses.asdict(
                paired_bootstrap(values(a_scores, metric), values(b_scores, metric))
            )
            for metric in ("recall@10", "mrr", "hit@10", "all@10", "recall@1")
        },
    }


def merge_training(swe: RankingData, new: RankingData) -> RankingData:
    return RankingData(
        np.concatenate([swe.X, new.X]),
        np.concatenate([swe.y, new.y]),
        np.concatenate([swe.group, new.group]),
        np.concatenate([swe.n_gold, new.n_gold]),
        swe.qids + new.qids,
    )


def train_models() -> int:
    from odin.rank.features import FEATURES, FILE_FEATURES

    names = {"function": FEATURES, "file": FILE_FEATURES}
    for level, (baseline, name) in LEVEL_SETTINGS.items():
        target = MODELS / f"{name}.txt"
        if target.exists():
            continue
        data = merge_training(RankingData.load(SWE_BENCH[level]), load_parts(level))
        rounds, cv, base = cross_validate(data, baseline, names[level], folds=FOLDS)
        meta = {"trained_on": "full minus lite, plus rebench train", "cv": cv, "cv_baseline": base}
        train(data, rounds, names[level], target, meta)
        print(level, len(data.group), "queries", rounds, "rounds", cv, flush=True)
    return 0


def validation_test() -> int:
    from odin.rank.ce_train import rerank, validation_split
    from odin.rank.cross_encoder import CrossEncoderEnsemble
    from odin.rank.features import FeatureExtractor
    from odin.rank.ltr import issue_memory
    from odin.search.dense import SentenceEncoder
    from odin.search.retriever import HybridRetriever

    in_lite = {g.instance_id for g in read_gold(GOLD / "swebench_lite_test.jsonl")}
    gold = [g for g in read_gold(GOLD / "swebench_full_test.jsonl") if g.instance_id not in in_lite]
    held_out = validation_split([g.instance_id for g in gold if g.functions or g.classes])
    todo = [g for g in gold if g.instance_id in held_out]
    text = {i.instance_id: i.problem_statement for i in load_instances("full", "test")}
    swe = subset(RankingData.load(SWE_BENCH["function"]), lambda q: q not in held_out)
    rounds = {
        "current": json.loads((MODEL_DIR / "ltr_function.json").read_text(encoding="utf-8")),
        "more-data": json.loads((MODELS / "ltr_function.json").read_text(encoding="utf-8")),
    }
    rankers = {
        "current": fit(swe, rounds["current"]["rounds"]),
        "more-data": fit(
            merge_training(swe, load_parts("function")), rounds["more-data"]["rounds"]
        ),
    }
    recipe = json.loads((MODEL_DIR / "reranker.json").read_text(encoding="utf-8"))
    depth, weight = int(recipe["depth"]), float(recipe["function_weight"])
    reranker = CrossEncoderEnsemble([Path(a) for a in recipe["adapters"]])
    retriever = HybridRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)
    extractor = FeatureExtractor(retriever, DEV_SELECTED_FUSION, memory=issue_memory(retriever))
    rows = {(v, s): [] for v in rankers for s in ("ranker", "reranker")}
    scores = {key: [] for key in rows}
    for n, entry in enumerate(todo, start=1):
        issue = text[entry.instance_id]
        query = Query(entry.instance_id, entry.repo, entry.base_commit, issue)
        retriever.prepare(query, "function")
        candidates = extractor.extract(query)
        targets = entry.functions + entry.classes
        for variant, ranker in rankers.items():
            predicted = ranker.predict(candidates.X)
            order = np.argsort(-predicted, kind="stable")
            top = order[:depth]
            texts = retriever.indexer.unit_texts(candidates.index, candidates.rows[top])
            blended = rerank(predicted[top], reranker.score(issue, texts), weight)
            final = np.concatenate([top[np.argsort(-blended, kind="stable")], order[depth:]])
            for stage, ranking in (("ranker", order), ("reranker", final)):
                ranked = [candidates.ids[i] for i in ranking[:TOP]]
                result = score(ranked, targets, KS)
                scores[(variant, stage)].append(result)
                rows[(variant, stage)].append(
                    {
                        "instance_id": entry.instance_id,
                        "repo": entry.repo,
                        "gold": targets,
                        "ranked": ranked,
                        "first_rank": result.first_rank,
                    }
                )
        if n % 25 == 0:
            print(n, len(todo), flush=True)
    retriever.close()
    for (variant, stage), per_instance in rows.items():
        summary = aggregate(scores[(variant, stage)], KS) | {
            "retriever": f"{variant}-{stage}",
            "level": "function",
            "ci95": {m: bootstrap_ci(scores[(variant, stage)], m) for m in ("mrr", "recall@10")},
        }
        body = {"summary": summary, "per_instance": per_instance, "provenance": provenance()}
        target = OUT / f"validation_{variant}_{stage}_function.json"
        target.write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8", newline="\n")
        print(variant, stage, {k: summary[k] for k in ("recall@10", "hit@10", "all@10", "mrr")})
    return 0


def unseen_projects() -> int:
    target = OUT / "unseen_project_folds.json"
    if target.exists():
        sys.exit(f"{target} exists; results are never overwritten")
    report = {
        "what": (
            "rankers trained on SWE-bench alone against rankers that also saw the other four "
            "folds of SWE-rebench training projects, scored on the held-out fold's issues"
        ),
        "levels": [unseen_project_test(level) for level in LEVEL_SETTINGS],
        "provenance": provenance(),
    }
    target.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    for level in report["levels"]:
        print(level["level"], level["issues"], level["paired"]["recall@10"], level["paired"]["mrr"])
    return 0


STEPS = {
    "features": build_features,
    "train": train_models,
    "unseen-projects": unseen_projects,
    "validation": validation_test,
}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=sorted(STEPS))
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    return STEPS[args.step]()


if __name__ == "__main__":
    sys.exit(main())
