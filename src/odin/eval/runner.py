from __future__ import annotations

import random
import time
from collections import defaultdict
from collections.abc import Callable, Sequence
from pathlib import Path

from odin.eval.ground_truth import GoldEntry
from odin.eval.metrics import aggregate, bootstrap_ci, percentile, score
from odin.repos import RepoCache
from odin.search.dense import FusionParams
from odin.search.graph import ExpandParams
from odin.search.retriever import BM25Retriever, HybridRetriever, Indexing, Query, Retriever

# Selected on SWE-bench Verified minus Lite (`odin tune`), never on the Lite test set.
DEV_SELECTED_EXPANSION = ExpandParams(alpha=0.1, seeds=1, indegree_power=0.5)
DEV_SELECTED_FUSION = FusionParams(method="zsum", dense_weight=0.8)

__all__ = ["RETRIEVERS", "Query", "Retriever", "gold_targets", "run_eval"]


def gold_targets(entry: GoldEntry, level: str) -> list[str]:
    if level == "file":
        return entry.files
    return entry.functions + entry.classes


class OracleRetriever:
    name = "oracle"

    def __init__(self, gold: dict[str, GoldEntry] | None = None) -> None:
        self.gold = gold or {}

    def bind(self, gold: dict[str, GoldEntry]) -> None:
        self.gold = gold

    def retrieve(self, query: Query, level: str, k: int) -> list[str]:
        return gold_targets(self.gold[query.instance_id], level)[:k]


class RandomFileRetriever:
    name = "random"

    def __init__(self, cache: RepoCache | None = None, seed: int = 0) -> None:
        self.cache = cache or RepoCache(Path(".cache/repos"))
        self.seed = seed

    def retrieve(self, query: Query, level: str, k: int) -> list[str]:
        if level != "file":
            raise ValueError("random baseline only supports file level")
        files = [
            f for f in self.cache.list_files(query.repo, query.base_commit) if f.endswith(".py")
        ]
        rng = random.Random(f"{self.seed}:{query.instance_id}")
        return rng.sample(files, min(k, len(files)))


RETRIEVERS: dict[str, Callable[[], Retriever]] = {
    "oracle": OracleRetriever,
    "random": RandomFileRetriever,
    "bm25-naive": lambda: BM25Retriever(tokenizer="naive"),
    "bm25-code": lambda: BM25Retriever(tokenizer="code"),
    "bm25-code-notests": lambda: BM25Retriever(tokenizer="code", exclude_tests=True),
    "bm25-code-notests-graph": lambda: BM25Retriever(
        tokenizer="code",
        exclude_tests=True,
        expansion=DEV_SELECTED_EXPANSION,
        name="bm25-code-notests-graph",
    ),
}


def _dense(mode: str) -> Retriever:
    # Imported lazily: dense retrieval needs the optional `dense` extra (PyTorch).
    from odin.search.dense import SentenceEncoder

    return HybridRetriever(SentenceEncoder(), mode=mode, fusion=DEV_SELECTED_FUSION)


RETRIEVERS["dense-notests"] = lambda: _dense("dense")
RETRIEVERS["hybrid-notests"] = lambda: _dense("hybrid")


def _ltr() -> Retriever:
    from odin.rank.ltr import LTRRetriever
    from odin.search.dense import SentenceEncoder

    return LTRRetriever(SentenceEncoder(), DEV_SELECTED_FUSION)


RETRIEVERS["ltr-notests"] = _ltr


def _ltr_ce() -> Retriever:
    from odin.rank.ltr import RerankedLTRRetriever
    from odin.search.dense import SentenceEncoder

    return RerankedLTRRetriever(SentenceEncoder(), DEV_SELECTED_FUSION)


RETRIEVERS["ltr-ce-notests"] = _ltr_ce


def _ltr_ce_distilled() -> Retriever:
    """The same pipeline with the single distilled cross-encoder (ce-train --distill-from)."""
    from odin.rank.ltr import MODEL_DIR, RerankedLTRRetriever
    from odin.search.dense import SentenceEncoder

    return RerankedLTRRetriever(
        SentenceEncoder(), DEV_SELECTED_FUSION,
        recipe=MODEL_DIR / "reranker_distilled.json", name="ltr-ce-distilled-notests",
    )  # fmt: skip


RETRIEVERS["ltr-ce-distilled-notests"] = _ltr_ce_distilled


def run_eval(
    retriever: Retriever,
    gold: Sequence[GoldEntry],
    queries: dict[str, str],
    ks: Sequence[int] = (1, 5, 10),
    level: str = "file",
    progress: Callable[[int, int], None] | None = None,
) -> dict:
    if isinstance(retriever, OracleRetriever):
        retriever.bind({g.instance_id: g for g in gold})
    k_max = max(ks)
    todo = [
        (g, Query(g.instance_id, g.repo, g.base_commit, queries[g.instance_id]))
        for g in gold
        if gold_targets(g, level)
    ]
    hooks = retriever if isinstance(retriever, Indexing) else None

    t_start = time.perf_counter()
    if hooks:
        hooks.warmup([q for _, q in todo])
    warmup_s = time.perf_counter() - t_start

    scores, latencies, index_ms, per_instance = [], [], [], []
    by_repo = defaultdict(list)
    for n, (entry, q) in enumerate(todo, start=1):
        targets = gold_targets(entry, level)
        if hooks:
            t0 = time.perf_counter()
            hooks.prepare(q, level)
            index_ms.append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        ranked = retriever.retrieve(q, level, k_max)
        latencies.append((time.perf_counter() - t0) * 1000)
        s = score(ranked, targets, ks)
        scores.append(s)
        by_repo[entry.repo].append(s)
        per_instance.append(
            {
                "instance_id": entry.instance_id,
                "repo": entry.repo,
                "gold": targets,
                "ranked": ranked,
                "first_rank": s.first_rank,
            }
        )
        if progress:
            progress(n, len(todo))

    if hooks:
        hooks.close()
    summary = aggregate(scores, ks)
    summary.update(
        {
            "retriever": retriever.name,
            "level": level,
            "skipped_no_target": len(gold) - len(todo),
            "ci95": {m: bootstrap_ci(scores, m) for m in ("mrr", f"recall@{ks[-1]}")},
            "latency_ms_p50": round(percentile(latencies, 50), 2),
            "latency_ms_p95": round(percentile(latencies, 95), 2),
            "latency_ms_p99": round(percentile(latencies, 99), 2),
            "wall_s": round(time.perf_counter() - t_start, 1),
        }
    )
    if hooks:
        summary.update(
            {
                "warmup_s": round(warmup_s, 1),
                "index_ms_p50": round(percentile(index_ms, 50), 1),
                "index_ms_p95": round(percentile(index_ms, 95), 1),
            }
        )
        stats = getattr(getattr(retriever, "indexer", None), "stats", None)
        if stats is not None:
            summary["index"] = {
                "files_indexed": stats.files_indexed,
                "blobs_parsed": stats.blobs_parsed,
                "blobs_from_disk_cache": stats.blobs_cached,
                "blob_reuse": round(stats.reuse_ratio, 4),
            }
    report = getattr(retriever, "report", None)
    if callable(report):
        summary.update(report())
    summary["by_repo"] = {repo: aggregate(s, ks) for repo, s in sorted(by_repo.items())}
    return {"summary": summary, "per_instance": per_instance}
