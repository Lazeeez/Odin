import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import load_instances  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.eval.runner import DEV_SELECTED_FUSION, Query  # noqa: E402
from odin.rank.ce_train import rerank, validation_split  # noqa: E402
from odin.rank.cross_encoder import CrossEncoderEnsemble  # noqa: E402
from odin.rank.features import FeatureExtractor  # noqa: E402
from odin.rank.ltr import LGBM_PARAMS, MODEL_DIR, RankingData, issue_memory  # noqa: E402
from odin.search.dense import SentenceEncoder  # noqa: E402
from odin.search.retriever import HybridRetriever  # noqa: E402

GOLD = ROOT / "data" / "gold" / "swebench_full_test.jsonl"
LITE = ROOT / "data" / "gold" / "swebench_lite_test.jsonl"
FEATURES = ROOT / "results" / "ltr_features_full_minus_lite_function.npz"
OUT = ROOT / "results" / "error-analysis"
TOP = 10
STAGES = (
    "no_unit",
    "not_retrieved",
    "ranker_left_it_below_the_reranker",
    "reranker_left_it_below_the_top",
    "found",
)
TRACEBACK = re.compile(r"Traceback \(most recent call last\)|^\s+File \".+\", line \d+", re.M)
CODE = re.compile(r"```|`[^`\n]+`")


def best_rank(order: np.ndarray, wanted: set[int]) -> int | None:
    for position, item in enumerate(order.tolist(), start=1):
        if item in wanted:
            return position
    return None


def out_of_fold_ranker(held_out: set[str]):
    import lightgbm as lgb

    data = RankingData.load(FEATURES)
    if data is None:
        sys.exit("ranker features are missing or stale; run `odin ltr` first")
    kept = data.split(np.array([i for i, q in enumerate(data.qids) if q not in held_out]))
    rounds = json.loads((MODEL_DIR / "ltr_function.json").read_text(encoding="utf-8"))["rounds"]
    model = lgb.LGBMRanker(n_estimators=rounds, random_state=0, **LGBM_PARAMS)
    model.fit(kept.X, kept.y, group=kept.group)
    return model


def stage_of(row: dict, depth: int) -> str:
    if not row["gold_units_indexed"]:
        return "no_unit"
    if row["rank_in_pool_by_ranker"] is None:
        return "not_retrieved"
    if row["final_rank"] is not None and row["final_rank"] <= TOP:
        return "found"
    if row["rank_in_pool_by_ranker"] > depth:
        return "ranker_left_it_below_the_reranker"
    return "reranker_left_it_below_the_top"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    out = OUT / f"validation_{args.label}.json"
    if out.exists():
        sys.exit(f"{out} exists; results are never overwritten, pick another --label")

    in_lite = {g.instance_id for g in read_gold(LITE)}
    gold = [g for g in read_gold(GOLD) if g.instance_id not in in_lite]
    held_out = validation_split([g.instance_id for g in gold if g.functions or g.classes])
    todo = [g for g in gold if g.instance_id in held_out][: args.limit]
    text = {i.instance_id: i.problem_statement for i in load_instances("full", "test")}

    recipe = json.loads((MODEL_DIR / "reranker.json").read_text(encoding="utf-8"))
    depth, weight = int(recipe["depth"]), float(recipe["function_weight"])
    ranker = out_of_fold_ranker(held_out)
    retriever = HybridRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)
    extractor = FeatureExtractor(retriever, DEV_SELECTED_FUSION, memory=issue_memory(retriever))
    reranker = CrossEncoderEnsemble([Path(a) for a in recipe["adapters"]])

    rows = []
    for n, entry in enumerate(todo, start=1):
        issue = text[entry.instance_id]
        query = Query(entry.instance_id, entry.repo, entry.base_commit, issue)
        retriever.prepare(query, "function")
        candidates = extractor.extract(query)
        _, lexical, dense = retriever.scores(query, "function")
        position = {unit: i for i, unit in enumerate(candidates.index.ids)}
        targets = entry.functions + entry.classes
        wanted = {position[t] for t in targets if t in position}
        in_pool = {i for i, row in enumerate(candidates.rows.tolist()) if row in wanted}

        scores = ranker.predict(candidates.X)
        order = np.argsort(-scores, kind="stable")
        top = order[:depth]
        texts = retriever.indexer.unit_texts(candidates.index, candidates.rows[top])
        blended = rerank(scores[top], reranker.score(issue, texts), weight)
        final = np.concatenate([top[np.argsort(-blended, kind="stable")], order[depth:]])
        found_in_top = sum(i in in_pool for i in final[:TOP].tolist())
        row = {
            "instance_id": entry.instance_id,
            "repo": entry.repo,
            "gold_units": len(targets),
            "gold_units_indexed": len(wanted),
            "gold_files": len(entry.files),
            "gold_units_in_pool": len(in_pool),
            "gold_units_in_final_top": found_in_top,
            "units_in_snapshot": len(position),
            "pool_size": len(candidates.ids),
            "rank_by_keywords": best_rank(np.argsort(-lexical, kind="stable"), wanted),
            "rank_by_embeddings": best_rank(np.argsort(-dense, kind="stable"), wanted),
            "rank_by_fusion": best_rank(np.argsort(-candidates.fallback, kind="stable"), wanted),
            "rank_in_pool_by_ranker": best_rank(order, in_pool),
            "final_rank": best_rank(final, in_pool),
            "issue_characters": len(issue),
            "issue_has_traceback": bool(TRACEBACK.search(issue)),
            "issue_has_code": bool(CODE.search(issue)),
        }
        row["stage"] = stage_of(row, depth)
        rows.append(row)
        if n % 25 == 0:
            print(n, len(todo), flush=True)
    retriever.close()

    stages = Counter(r["stage"] for r in rows)
    report = {
        "what": (
            "where the cascade loses each validation issue: the 250 training issues the "
            "reranker never saw, ranked by a LambdaMART model retrained without them"
        ),
        "top": TOP,
        "reranker_depth": depth,
        "issues": len(rows),
        "stages": {stage: stages.get(stage, 0) for stage in STAGES},
        "per_issue": rows,
        "provenance": provenance() | {"argv": sys.argv[1:]},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report["stages"], indent=1))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
