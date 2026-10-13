import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import load_instances  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.metrics import aggregate, bootstrap_ci, score  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.eval.runner import DEV_SELECTED_FUSION, Query  # noqa: E402
from odin.rank.ce_train import rerank, validation_split  # noqa: E402
from odin.rank.cross_encoder import CrossEncoderEnsemble  # noqa: E402
from odin.rank.features import FeatureExtractor  # noqa: E402
from odin.rank.ltr import LGBM_PARAMS, MODEL_DIR, RankingData, issue_memory  # noqa: E402
from odin.search.dense import SentenceEncoder  # noqa: E402
from odin.search.path_aware import PathAwareRetriever  # noqa: E402
from odin.search.retriever import HybridRetriever  # noqa: E402

GOLD = ROOT / "data" / "gold" / "swebench_full_test.jsonl"
LITE = ROOT / "data" / "gold" / "swebench_lite_test.jsonl"
OUT = ROOT / "results" / "validation-path"
KS = (1, 5, 10)
TOP = 10
VARIANTS = {
    "current": ("results/ltr_features_full_minus_lite_function.npz", HybridRetriever),
    "paths": ("results/ltr_features_full_minus_lite_paths_function.npz", PathAwareRetriever),
}


def out_of_fold_ranker(features: Path, held_out: set[str]):
    import lightgbm as lgb

    data = RankingData.load(features)
    if data is None:
        sys.exit(f"{features} is missing or stale")
    kept = data.split(np.array([i for i, q in enumerate(data.qids) if q not in held_out]))
    rounds = json.loads((MODEL_DIR / "ltr_function.json").read_text(encoding="utf-8"))["rounds"]
    model = lgb.LGBMRanker(n_estimators=rounds, random_state=0, **LGBM_PARAMS)
    model.fit(kept.X, kept.y, group=kept.group)
    return model, len(kept.group)


def report(name: str, stage: str, rows: list[dict], scores: list, extra: dict) -> Path:
    summary = aggregate(scores, KS) | {
        "retriever": f"{name}-{stage}",
        "level": "function",
        "ci95": {m: bootstrap_ci(scores, m) for m in ("mrr", "recall@10")},
    }
    path = OUT / f"{name}_{stage}_function_validation.json"
    body = {"summary": summary, "per_instance": rows, "provenance": provenance() | extra}
    path.write_text(json.dumps(body, indent=1) + "\n", encoding="utf-8", newline="\n")
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    wanted = [n for n in VARIANTS if not (OUT / f"{n}_reranker_function_validation.json").exists()]
    if not wanted:
        sys.exit(f"{OUT} already holds both variants; results are never overwritten")

    in_lite = {g.instance_id for g in read_gold(LITE)}
    gold = [g for g in read_gold(GOLD) if g.instance_id not in in_lite]
    held_out = validation_split([g.instance_id for g in gold if g.functions or g.classes])
    todo = [g for g in gold if g.instance_id in held_out][: args.limit]
    text = {i.instance_id: i.problem_statement for i in load_instances("full", "test")}
    recipe = json.loads((MODEL_DIR / "reranker.json").read_text(encoding="utf-8"))
    depth, weight = int(recipe["depth"]), float(recipe["function_weight"])
    reranker = CrossEncoderEnsemble([Path(a) for a in recipe["adapters"]])
    encoder = SentenceEncoder()

    for name in wanted:
        features, kind = VARIANTS[name]
        ranker, trained_on = out_of_fold_ranker(ROOT / features, held_out)
        retriever = kind(encoder, fusion=DEV_SELECTED_FUSION)
        extractor = FeatureExtractor(retriever, DEV_SELECTED_FUSION, memory=issue_memory(retriever))
        stages: dict[str, tuple[list, list]] = {"ranker": ([], []), "reranker": ([], [])}
        for n, entry in enumerate(todo, start=1):
            issue = text[entry.instance_id]
            query = Query(entry.instance_id, entry.repo, entry.base_commit, issue)
            retriever.prepare(query, "function")
            candidates = extractor.extract(query)
            scores = ranker.predict(candidates.X)
            order = np.argsort(-scores, kind="stable")
            top = order[:depth]
            texts = retriever.indexer.unit_texts(candidates.index, candidates.rows[top])
            blended = rerank(scores[top], reranker.score(issue, texts), weight)
            final = np.concatenate([top[np.argsort(-blended, kind="stable")], order[depth:]])
            targets = entry.functions + entry.classes
            for stage, ranking in (("ranker", order), ("reranker", final)):
                ranked = [candidates.ids[i] for i in ranking[:TOP]]
                result = score(ranked, targets, KS)
                stages[stage][1].append(result)
                stages[stage][0].append(
                    {
                        "instance_id": entry.instance_id,
                        "repo": entry.repo,
                        "gold": targets,
                        "ranked": ranked,
                        "first_rank": result.first_rank,
                    }
                )
            if n % 25 == 0:
                print(name, n, len(todo), flush=True)
        retriever.close()
        extra = {"argv": sys.argv[1:], "features": features, "ranker_trained_on_issues": trained_on}
        for stage, (rows, scores) in stages.items():
            path = report(name, stage, rows, scores, extra)
            summary = json.loads(path.read_text(encoding="utf-8"))["summary"]
            print(name, stage, {k: summary[k] for k in ("recall@10", "hit@10", "all@10", "mrr")})
    return 0


if __name__ == "__main__":
    sys.exit(main())
