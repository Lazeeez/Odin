"""Embedding throughput under three batching strategies, on real function chunks.

    uv run --extra dense python benchmarks/bench_batching.py

A padded batch costs (items x longest item), and code units are heavily skewed in length
(django: p50 63 tokens, p99 650). The strategies differ only in how items are grouped:

- arrival: fixed-size batches in file order, what a per-file indexing loop would do
- sorted:  one global length sort, fixed batch size (sentence-transformers' default)
- budget:  global length sort, batches packed up to a token budget (odin)
"""

from __future__ import annotations

import random
import time
from pathlib import Path

import numpy as np
import torch

from odin.eval.ground_truth import read_gold
from odin.index.chunker import MODULE, chunk_file
from odin.index.snapshot import _is_test_path, unit_text
from odin.repos import RepoCache
from odin.search.dense import SentenceEncoder, token_budget_batches

N = 4000
BATCH = 32


def sample_chunks() -> list[str]:
    cache = RepoCache(Path(".cache/repos"))
    gold = read_gold(Path("data/gold/swebench_lite_test.jsonl"))
    g = next(g for g in gold if g.repo == "django/django")
    entries = [
        e for e in cache.list_tree(g.repo, g.base_commit, ".py") if not _is_test_path(e.path)
    ]
    with cache.blob_reader(g.repo) as reader:
        texts = [
            unit_text(c.qualname, c.text)
            for e in entries
            for c in chunk_file(reader.read(e.oid), e.path)
            if c.kind != MODULE
        ]
    random.Random(0).shuffle(texts)
    return texts[:N]


def run(enc: SentenceEncoder, texts: list[str], lengths: list[int], groups) -> tuple[float, float]:
    enc.model.max_seq_length = enc.max_doc_tokens
    torch.cuda.synchronize()
    t0 = time.perf_counter()
    for g in groups:
        enc.model.encode(
            [texts[i] for i in g],
            prompt_name=enc.document_prompt,
            batch_size=len(g),
            normalize_embeddings=True,
        )
    torch.cuda.synchronize()
    elapsed = time.perf_counter() - t0
    real = sum(lengths)
    padded = sum(len(g) * max(lengths[i] for i in g) for g in groups)
    return len(texts) / elapsed, real / padded


def main() -> None:
    texts = sample_chunks()
    enc = SentenceEncoder()
    ids = enc.model.tokenizer(texts, add_special_tokens=True)["input_ids"]
    lengths = [min(len(x), enc.max_doc_tokens) for x in ids]
    print(f"{len(texts)} django chunks, tokens p50={np.median(lengths):.0f} max={max(lengths)}")

    arrival = [list(range(i, min(i + BATCH, N))) for i in range(0, N, BATCH)]
    order = np.argsort(lengths, kind="stable")
    by_len = [order[i : i + BATCH].tolist() for i in range(0, N, BATCH)]
    run(enc, texts[:256], lengths[:256], [list(range(256))])  # CUDA warm-up

    print(f"{'strategy':<30}{'chunks/s':>10}{'real/padded tokens':>20}")
    for label, groups in [
        (f"arrival order, batch {BATCH}", arrival),
        (f"length-sorted, batch {BATCH}", by_len),
        *[
            (f"token budget {b}", token_budget_batches(lengths, b))
            for b in (4096, 8192, 16384, 32768)
        ],
    ]:
        rate, efficiency = run(enc, texts, lengths, groups)
        print(f"{label:<30}{rate:>10.0f}{efficiency:>20.1%}")


if __name__ == "__main__":
    main()
