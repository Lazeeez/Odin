import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import load_instances  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.metrics import percentile  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.eval.runner import RETRIEVERS, Query, gold_targets  # noqa: E402
from odin.eval.runs import hardware  # noqa: E402
from odin.rank.features import issue_fields  # noqa: E402

GOLD = ROOT / "data" / "gold" / "swebench_lite_test.jsonl"
OUT = ROOT / "results" / "perf"
LEVEL = "function"
STAGES = ("index", "embed_query", "features", "ranker", "reranker")
ON_GPU = ("embed_query", "reranker")


def synchronize() -> None:
    import torch

    if torch.cuda.is_available():
        torch.cuda.synchronize()


def timed(action) -> tuple[float, object]:
    synchronize()
    started = time.perf_counter()
    value = action()
    synchronize()
    return (time.perf_counter() - started) * 1000, value


def one_issue(retriever, query: Query) -> dict:
    ms = {}
    embedded_before = retriever.units_embedded
    ms["index"], _ = timed(lambda: retriever.prepare(query, LEVEL))
    title, _ = issue_fields(query.text)
    ms["embed_query"], _ = timed(lambda: retriever.encoder.encode_queries([query.text, title]))
    ms["features"], candidates = timed(lambda: retriever.extractor.extract(query))

    def rank():
        scores = retriever.models["function"].predict(candidates.X)
        retriever.models["file"].predict(candidates.Xf)
        return scores

    ms["ranker"], scores = timed(rank)
    top = np.argsort(-scores, kind="stable")[: retriever.depth]
    texts = retriever.indexer.unit_texts(candidates.index, candidates.rows[top])
    ms["reranker"], _ = timed(lambda: retriever.ce.score(query.text, texts))
    return {
        "instance_id": query.instance_id,
        "repo": query.repo,
        "units_in_snapshot": len(candidates.index.ids),
        "candidates": len(candidates.ids),
        "units_embedded_while_indexing": retriever.units_embedded - embedded_before,
        "ms": {stage: round(value, 2) for stage, value in ms.items()},
    }


def summarize(rows: list[dict]) -> dict:
    stages = {}
    for stage in (*STAGES, "total", "gpu"):
        if stage == "total":
            values = [sum(r["ms"].values()) for r in rows]
        elif stage == "gpu":
            values = [sum(r["ms"][s] for s in ON_GPU) for r in rows]
        else:
            values = [r["ms"][stage] for r in rows]
        stages[stage] = {
            "mean_ms": round(float(np.mean(values)), 1),
            "p50_ms": round(percentile(values, 50), 1),
            "p95_ms": round(percentile(values, 95), 1),
        }
    return stages


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()
    out = OUT / f"cascade_{args.label}.json"
    if out.exists():
        sys.exit(f"{out} exists; results are never overwritten, pick another --label")

    text = {i.instance_id: i.problem_statement for i in load_instances("lite", "test")}
    queries = [
        Query(g.instance_id, g.repo, g.base_commit, text[g.instance_id])
        for g in read_gold(GOLD)
        if gold_targets(g, LEVEL)
    ][: args.limit]

    load_ms, retriever = timed(RETRIEVERS["ltr-ce-notests"])
    retriever.warmup(queries)
    rows = []
    for n, query in enumerate(queries, start=1):
        rows.append(one_issue(retriever, query))
        if n % 25 == 0:
            print(n, len(queries), flush=True)
    retriever.close()
    report = {
        "what": (
            "the ltr-ce-notests cascade timed stage by stage on every SWE-bench Lite issue with a "
            "function target; no ranking is scored, so this is not a test-set evaluation"
        ),
        "stages": {
            "index": "build the snapshot index; embeds units not yet in the embedding store",
            "embed_query": "embed the issue and its title (GPU), bypassing the query cache",
            "features": "lexical and dense scoring, candidate pool, 52 features",
            "ranker": "LambdaMART at function and file level",
            "reranker": "both adapters over the top candidates (GPU)",
        },
        "issues": len(rows),
        "model_load_s": round(load_ms / 1000, 1),
        "embedding_store_was_warm": sum(r["units_embedded_while_indexing"] for r in rows) == 0,
        "summary": summarize(rows),
        "mean_units_in_snapshot": round(float(np.mean([r["units_in_snapshot"] for r in rows]))),
        "hardware": hardware(),
        "per_issue": rows,
        "provenance": provenance() | {"argv": sys.argv[1:]},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(report["summary"], indent=1))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
