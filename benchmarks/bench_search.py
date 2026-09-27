"""Where does query time go, and would approximate search (HNSW) help?

    uv run --extra dense --with faiss-cpu python benchmarks/bench_search.py

Pruning algorithms (WAND/MaxScore for BM25, HNSW's best-first graph search for vectors)
trade index-build work and a little recall for faster scoring. That pays off when one index
serves many queries over a large corpus. Here every SWE-bench issue has its own commit, so
an index serves one query, and a snapshot holds tens of thousands of units. This measures
both sides on a real django snapshot whose unit embeddings are already cached.
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import torch

from odin.eval.dataset import load_instances
from odin.eval.ground_truth import read_gold
from odin.search.dense import DenseIndex, SentenceEncoder
from odin.search.retriever import HybridRetriever, Query


def ms(fn, repeat: int = 50) -> float:
    fn()
    t0 = time.perf_counter()
    for _ in range(repeat):
        fn()
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    return (time.perf_counter() - t0) / repeat * 1000


def main() -> None:
    import faiss

    gold = read_gold(Path("data/gold/swebench_lite_test.jsonl"))
    g = next(g for g in gold if g.repo == "django/django")
    text = {i.instance_id: i.problem_statement for i in load_instances()}[g.instance_id]
    enc = SentenceEncoder()
    r = HybridRetriever(enc)
    q = Query(g.instance_id, g.repo, g.base_commit, text)

    t0 = time.perf_counter()
    fn, _ = r.dense_scores(q)
    print(f"snapshot: {len(fn.ids)} units, build (all cached) {time.perf_counter() - t0:.2f} s")
    vecs = r.store.matrix(fn.unit_keys)
    qvec = enc.encode_query(text)
    lookup = r.indexer.vocab.lookup(r.tokenize(text))

    print(f"{'step':<44}{'ms':>10}")
    print(f"{'encode query (GPU, fp16)':<44}{ms(lambda: enc.encode_query(text), 10):>10.2f}")
    print(
        f"{'BM25 score, all units (sparse mat-vec)':<44}{ms(lambda: fn.index.scores(lookup)):>10.2f}"
    )
    cpu, gpu = DenseIndex(vecs, "cpu"), DenseIndex(vecs, "cuda")
    print(f"{'dense exact, CPU fp32':<44}{ms(lambda: cpu.scores(qvec)):>10.2f}")
    print(f"{'dense exact, GPU fp16':<44}{ms(lambda: gpu.scores(qvec)):>10.2f}")

    exact = np.argsort(-cpu.scores(qvec))[:10]
    x = np.ascontiguousarray(vecs.astype(np.float32))
    for m in (16, 32):
        index = faiss.IndexHNSWFlat(x.shape[1], m, faiss.METRIC_INNER_PRODUCT)
        index.hnsw.efConstruction = 200
        t0 = time.perf_counter()
        index.add(x)
        build = (time.perf_counter() - t0) * 1000
        print(f"{f'HNSW M={m} build':<44}{build:>10.0f}")
        for ef in (32, 128):
            index.hnsw.efSearch = ef
            _, got = index.search(qvec[None, :].astype(np.float32), 10)
            recall = len(set(got[0]) & set(exact)) / 10
            t = ms(lambda ix=index: ix.search(qvec[None, :].astype(np.float32), 10))
            print(f"{f'HNSW M={m} ef={ef} query (recall@10 {recall:.1f})':<44}{t:>10.2f}")
    r.close()


if __name__ == "__main__":
    main()
