from __future__ import annotations

from collections.abc import Callable, Sequence

import numpy as np

from odin.eval.ground_truth import GoldEntry
from odin.eval.metrics import QueryScore, aggregate, score
from odin.eval.runner import gold_targets
from odin.search.bm25 import top_k
from odin.search.dense import FusionParams, fuse
from odin.search.graph import ExpandParams, expand
from odin.search.retriever import BM25Retriever, HybridRetriever, Query


def tune_expansion(
    retriever: BM25Retriever,
    gold: Sequence[GoldEntry],
    queries: dict[str, str],
    grid: Sequence[ExpandParams],
    ks: Sequence[int] = (1, 5, 10),
    progress: Callable[[int, int], None] | None = None,
) -> list[tuple[ExpandParams, dict[str, float]]]:
    """Score every expansion setting on the same queries at the cost of one BM25 pass.

    Index construction and lexical scoring dominate, and neither depends on the expansion
    parameters, so each snapshot is built once and every grid point re-ranks its scores.
    """
    todo = [
        Query(g.instance_id, g.repo, g.base_commit, queries[g.instance_id])
        for g in gold
        if gold_targets(g, "function")
    ]
    targets = {g.instance_id: gold_targets(g, "function") for g in gold}
    retriever.warmup(todo)
    per_setting: list[list[QueryScore]] = [[] for _ in grid]
    for n, q in enumerate(todo, start=1):
        index, base = retriever.lexical_scores(q, "function")
        for i, p in enumerate(grid):
            s = expand(base, index.graph, p)
            ranked = [index.ids[j] for j in top_k(s, max(ks)) if s[j] > 0]
            per_setting[i].append(score(ranked, targets[q.instance_id], ks))
        if progress:
            progress(n, len(todo))
    retriever.close()
    return [(p, aggregate(s, ks)) for p, s in zip(grid, per_setting, strict=True)]


def tune_fusion(
    retriever: HybridRetriever,
    gold: Sequence[GoldEntry],
    queries: dict[str, str],
    grid: Sequence[FusionParams],
    level: str = "function",
    ks: Sequence[int] = (1, 5, 10),
    progress: Callable[[int, int], None] | None = None,
) -> list[tuple[str, dict[str, float]]]:
    """Score lexical-only, dense-only and every fusion setting from one pass of each."""
    todo = [
        Query(g.instance_id, g.repo, g.base_commit, queries[g.instance_id])
        for g in gold
        if gold_targets(g, level)
    ]
    targets = {g.instance_id: gold_targets(g, level) for g in gold}
    retriever.warmup(todo)
    labels = ["bm25 only", "dense only", *map(str, grid)]
    per_setting: list[list[QueryScore]] = [[] for _ in labels]
    for n, q in enumerate(todo, start=1):
        ids, lexical, dense = retriever.scores(q, level)
        for i, s in enumerate([lexical, dense, *(fuse(lexical, dense, p) for p in grid)]):
            ranked = [ids[j] for j in top_k(s, max(ks)) if np.isfinite(s[j])]
            per_setting[i].append(score(ranked, targets[q.instance_id], ks))
        if progress:
            progress(n, len(todo))
    retriever.close()
    return [(label, aggregate(s, ks)) for label, s in zip(labels, per_setting, strict=True)]
