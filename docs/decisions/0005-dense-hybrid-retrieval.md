# 0005: Dense embeddings cached by content hash, fused with BM25, searched exactly

## Context

After phases 3a and 4, most BM25 misses were issues that never reach the right neighbourhood lexically: sympy reports written in mathematical notation, pytest reports describing behaviour in prose. Graph expansion cannot fix that (0004). An embedding model that maps "the derivative of a piecewise function is wrong" near `Piecewise._eval_derivative` can.

## Decision

**Model.** `jinaai/jina-code-embeddings-0.5b` (Qwen2.5-Coder based, 896 dimensions, last-token pooling, trained for text-to-code retrieval), fp16 on GPU, with its `nl2code` query and document prompts. Units are truncated at 512 tokens (django: p50 63, p99 ~650) and issues at 1024. The first choice, CodeRankEmbed, ships custom model code that no longer runs on transformers 5. A natively supported architecture was preferred over pinning an old transformers.

**Embed each distinct function once, ever.** Units are keyed by a BLAKE2b hash of their text (qualified name plus own lines) and stored in an append-only, float16, on-disk store. Across the 698 snapshots of Lite plus the dev set there are 6.79M unit slots but only 185k distinct unit texts, a 36.7x reduction. At about 200 units/s that is roughly 15 minutes of GPU time instead of about 9.5 hours. The store is shared by every configuration and split: the Lite run after dev tuning had to embed only 8.5k new units.

**Batch by length.** Texts are sorted by token length and packed into batches of at most 4096 padded tokens. On 4000 django units (RTX 4050) this gives 208 units/s against 43 units/s for fixed batches in file order, whose padding wastes 79% of the compute. Nearly all of the gain comes from sorting (fixed batches of 32 after sorting reach 201/s); budget packing adds about 3%, and larger budgets are slower once the GPU is saturated. See `benchmarks/bench_batching.py`.

**Search exactly.** Each snapshot's unit vectors are gathered into one matrix and scored with a mat-vec. On a django snapshot that is 0.10 ms on GPU and 0.47 ms on CPU. HNSW (FAISS) queries in 0.05 to 0.2 ms but takes about 650 ms to build. Every SWE-bench snapshot answers exactly one query, so approximate search would need about 13,000 queries per snapshot to break even. Best-first graph search (HNSW, the A*-like family) and dynamic pruning (WAND/MaxScore for BM25) both trade build work for per-query speed, and this workload has nothing to amortize it over. See `benchmarks/bench_search.py`. Query latency is dominated by encoding the issue (about 25 ms), not by search.

**Fuse with BM25.** Both score vectors are z-normalized per query and combined as `0.2 * bm25 + 0.8 * dense`. Reciprocal rank fusion and z-score fusion were grid-searched on the dev set (Verified minus Lite, 393 issues). The top settings were within noise of each other. The choice followed the rule declared before looking: best recall@10, ties broken by MRR. File-level scores use each file's best unit (MaxP) and the same fusion weights.

## Results (Lite test, held out)

| | Function recall@10 | Function MRR | File recall@10 | File MRR |
|---|---|---|---|---|
| BM25 (code tokens, no tests) | 0.519 | 0.307 | 0.790 | 0.571 |
| Dense | 0.586 | 0.365 | 0.873 | 0.621 |
| Hybrid | **0.642** | **0.416** | **0.917** | **0.698** |

Hybrid against BM25: +12.3 points function recall@10 and +12.7 file recall@10, p < 0.001 on every metric. Hybrid against dense alone is also significant (recall@10 +5.7, p = 0.002). Dense alone beats BM25 only marginally (p = 0.045). The value is in the combination: the two retrievers fail on different issues.

## Consequences

- Query latency rises from under 1 ms to about 30 to 50 ms p50, almost all of it query encoding. Truncating issues to 512 tokens or a smaller encoder would cut it, at a quality cost to be measured on dev.
- Dense retrieval needs the optional `dense` extra (PyTorch). The core package, its tests and CI do not. Tests use a deterministic hashing encoder to exercise the store, batching, fusion and caching.
- A bug worth recording: at file level, a file with no functions has a MaxP of `-inf`, which turned the z-scores into `nan` and silently reduced hybrid to BM25. The symptom was hybrid matching BM25 to four decimals. Z-scores are now computed over finite scores only, and a regression test covers it.
