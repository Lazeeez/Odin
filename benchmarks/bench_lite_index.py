import argparse
import hashlib
import json
import os
import platform
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import load_instances  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.metrics import percentile  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.eval.runner import Query, gold_targets  # noqa: E402
from odin.index.store import AnalysisCache, analyzer_fingerprint  # noqa: E402
from odin.search.retriever import BM25Retriever  # noqa: E402

GOLD = ROOT / "data" / "gold" / "swebench_lite_test.jsonl"
OUT = ROOT / "results" / "perf"
LEVEL = "function"
TOP = 10
MODES = ("no-cache", "cold-cache", "warm-cache")


def hardware() -> dict:
    return {
        "processor": platform.processor(),
        "logical_cores": os.cpu_count(),
        "platform": platform.platform(),
    }


def timed_run(queries: list[Query], cache_file: Path | None) -> dict:
    retriever = BM25Retriever(tokenizer="code", exclude_tests=True, analysis_cache=False)
    if cache_file:
        retriever.indexer.disk = AnalysisCache(cache_file, analyzer_fingerprint(retriever.tokenize))
    started = time.perf_counter()
    retriever.warmup(queries)
    warmup_s = time.perf_counter() - started
    index_ms, query_ms, ranked = [], [], []
    for query in queries:
        t0 = time.perf_counter()
        retriever.prepare(query, LEVEL)
        index_ms.append((time.perf_counter() - t0) * 1000)
        t0 = time.perf_counter()
        ranked.append(retriever.retrieve(query, LEVEL, TOP))
        query_ms.append((time.perf_counter() - t0) * 1000)
    wall_s = time.perf_counter() - started
    stats = retriever.indexer.stats
    retriever.close()
    return {
        "snapshots": len(queries),
        "wall_s": round(wall_s, 1),
        "warmup_s": round(warmup_s, 1),
        "index_ms_p50": round(percentile(index_ms, 50), 1),
        "index_ms_p95": round(percentile(index_ms, 95), 1),
        "query_ms_p50": round(percentile(query_ms, 50), 2),
        "query_ms_p99": round(percentile(query_ms, 99), 2),
        "files_indexed": stats.files_indexed,
        "blobs_parsed": stats.blobs_parsed,
        "blobs_from_disk_cache": stats.blobs_cached,
        "blob_reuse": round(stats.reuse_ratio, 4),
        "rankings_sha256": hashlib.sha256(json.dumps(ranked).encode()).hexdigest(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    out = OUT / f"lite_index_{args.label}.json"
    if out.exists():
        sys.exit(f"{out} exists; results are never overwritten, pick another --label")

    text = {i.instance_id: i.problem_statement for i in load_instances("lite", "test")}
    queries = [
        Query(g.instance_id, g.repo, g.base_commit, text[g.instance_id])
        for g in read_gold(GOLD)
        if gold_targets(g, LEVEL)
    ][: args.limit]

    runs = {}
    with tempfile.TemporaryDirectory() as scratch:
        cache_file = Path(scratch) / "analysis.sqlite"
        for mode in MODES:
            runs[mode] = timed_run(queries, None if mode == "no-cache" else cache_file)
            print(mode, json.dumps(runs[mode]), flush=True)
    report = {
        "what": (
            "bm25-code-notests indexing every SWE-bench Lite snapshot and answering its issue, "
            "timed without scoring: no metric is computed, so this is not a test-set evaluation"
        ),
        "modes": {
            "no-cache": "no on-disk analysis cache; blobs are reused in memory only",
            "cold-cache": "an empty on-disk analysis cache, filled during the run",
            "warm-cache": "the cache the cold run filled",
        },
        "identical_rankings": len({r["rankings_sha256"] for r in runs.values()}) == 1,
        "hardware": hardware(),
        "runs": runs,
        "provenance": provenance() | {"argv": sys.argv[1:]},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
