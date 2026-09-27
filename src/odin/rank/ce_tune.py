from __future__ import annotations

import json
import math
from collections.abc import Callable, Sequence
from pathlib import Path

import numpy as np

from odin.eval.ground_truth import GoldEntry
from odin.rank.ce_train import rerank, validation_split
from odin.rank.cross_encoder import CrossEncoder
from odin.rank.features import FeatureExtractor
from odin.rank.ltr import LEVELS, LGBM_PARAMS, RankingData, issue_memory
from odin.search.dense import FusionParams
from odin.search.retriever import HybridRetriever, Query

DEPTHS = (10, 20, 30)
WEIGHTS = (0.0, 0.25, 0.5, 1.0, 2.0, 4.0, math.inf)


def _metrics(ranked: list[str], gold: set[str]) -> np.ndarray:
    hits = [i for i, d in enumerate(ranked) if d in gold]
    recall = [sum(d in gold for d in ranked[:k]) / len(gold) for k in (1, 5, 10)]
    return np.array([*recall, 1 / (hits[0] + 1) if hits else 0.0])


def _without(data: RankingData, held_out: set[str]) -> RankingData:
    return data.split(np.array([i for i, q in enumerate(data.qids) if q not in held_out]))


def tune_cross_encoder(
    retriever: HybridRetriever,
    fusion: FusionParams,
    ce: CrossEncoder,
    gold: Sequence[GoldEntry],
    queries: dict[str, str],
    data: dict[str, RankingData],
    progress: Callable[[int, int], None] | None = None,
) -> dict:
    """Choose reranking depth and blend weights on validation issues the reranker never saw.

    First-stage scores for those issues come from LTR models retrained without them, so the
    blend is tuned against out-of-sample scores, as it will meet them at test time.
    """
    import lightgbm as lgb

    val = validation_split([g.instance_id for g in gold if g.functions or g.classes])
    models = {}
    for level, (_, _, path) in LEVELS.items():
        rounds = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))["rounds"]
        d = _without(data[level], val)
        m = lgb.LGBMRanker(n_estimators=rounds, random_state=0, **LGBM_PARAMS)
        m.fit(d.X, d.y, group=d.group)
        models[level] = m
    extractor = FeatureExtractor(retriever, fusion, memory=issue_memory(retriever))
    todo = [g for g in gold if g.instance_id in val]
    fn_scores = {(k, w): [] for k in DEPTHS for w in WEIGHTS}
    file_scores = {w: [] for w in WEIGHTS}
    for n, g in enumerate(todo, start=1):
        cs = extractor.extract(Query(g.instance_id, g.repo, g.base_commit, queries[g.instance_id]))
        p = models["function"].predict(cs.X)
        order = np.argsort(-p, kind="stable")
        top = order[: max(DEPTHS)]
        texts = retriever.indexer.unit_texts(cs.index, cs.rows[top])
        ce_all = ce.score(queries[g.instance_id], texts)
        targets = set(g.functions + g.classes)
        for k in DEPTHS:
            for w in WEIGHTS:
                new = np.argsort(-rerank(p[top[:k]], ce_all[:k], w), kind="stable")
                ranked = [cs.ids[i] for i in top[:k][new]] + [cs.ids[i] for i in order[k:]]
                fn_scores[(k, w)].append(_metrics(ranked, targets))

        # Files: blend the file model with the best cross-encoder score among the file's
        # reranked units; files without one get the lowest.
        assert cs.index.files is not None
        pf = models["file"].predict(cs.Xf)
        unit_file = cs.index.file_of_doc[cs.rows[top]]
        best = {}
        for f, s in zip(unit_file.tolist(), ce_all.tolist(), strict=True):
            best[f] = max(best.get(f, -math.inf), s)
        floor = float(ce_all.min()) - 1.0
        ce_file = np.array([best.get(int(f), floor) for f in cs.file_rows])
        for w in WEIGHTS:
            new = np.argsort(-rerank(pf, ce_file, w), kind="stable")
            file_scores[w].append(
                _metrics([cs.index.files[cs.file_rows[i]] for i in new], set(g.files))
            )
        if progress:
            progress(n, len(todo))

    def table(scores: dict) -> list[dict]:
        rows = []
        for key, vals in scores.items():
            m = np.mean(vals, axis=0)
            rows.append(
                {"setting": key, "recall@1": m[0], "recall@5": m[1], "recall@10": m[2], "mrr": m[3]}
            )
        return rows

    fn_rows, file_rows = table(fn_scores), table(file_scores)
    # Declared before looking: a reranker exists to fix the top, so choose by MRR.
    pick = lambda rows: max(rows, key=lambda r: (round(r["mrr"], 4), r["recall@10"]))  # noqa: E731
    return {
        "validation_issues": len(todo),
        "function": fn_rows,
        "file": file_rows,
        "chosen_function": pick(fn_rows)["setting"],
        "chosen_file": pick(file_rows)["setting"],
    }


def save_choice(result: dict, path: Path, adapters: list[Path]) -> None:
    """The reranking recipe the cascade retriever loads: which models, how deep, how much."""
    k, w = result["chosen_function"]
    choice = {
        "adapters": [a.as_posix() for a in adapters],
        "depth": k,
        "function_weight": w,
        "file_weight": result["chosen_file"],
        "validation": {
            "function": next(r for r in result["function"] if r["setting"] == (k, w)),
            "file": next(r for r in result["file"] if r["setting"] == result["chosen_file"]),
        },
    }
    path.write_text(json.dumps(choice, indent=2, default=list), encoding="utf-8")
