# 0006: Learn the ranking with LambdaMART over retrieval, structure, mention and history features

## Context

After hybrid retrieval (0005), a gold function was in the top 10 for 64% of Lite issues but first for only 27%. Measured on the dev set, a candidate pool of about 450 units per query (BM25 top 100, dense top 100, every unit of the top 5 files, and call-graph neighbours of the top hits) contained a gold unit 96.7% of the time. The remaining errors were ordering errors, not recall errors.

Hand-tuning more fusion weights would not scale to the number of signals available, so ordering is learned.

## Decision

**Model.** LightGBM LambdaMART (`lambdarank`, NDCG truncated at 20), one model for functions and one for files. 15 leaves, learning rate 0.03, row and column subsampling. The round count is chosen by 5-fold cross-validation grouped by query.

**Training data.** All of SWE-bench test minus Lite: 1,941 issues with a function target (1,992 with a file target), 5x the 393-issue dev set used earlier. The issues come from the same 12 repositories and share nothing with Lite.

**Features (42 per unit, 31 per file).**
- Retrieval: BM25 and dense scores, ranks and gaps to the best hit, and the fused score, each also for the unit's file.
- Query fields: the issue title and its code spans scored on their own, since a title is denser than the whole report.
- Structure: rank within its file, file size, call-graph proximity to the top hits, unit kind, length, privacy, name ambiguity in the repository.
- Explicit mentions: the unit's name, class, dotted path, file path or module named in the issue, in code spans, in traceback frames, and in the innermost frame.
- Git history (BugLocator-style), from ancestors of `base_commit` only, via `git rev-list`: how often the file changed and was fixed in the preceding year, and how much the file was touched by past commits whose messages resemble the issue.
- Earlier bug reports: fix locations of similar SWE-bench issues opened at least 30 days before this one in the same repository, plus how often each unit had been fixed at all.

File candidates add the files named in the issue to the files of the unit pool and the top 50 hybrid files. File features include aggregates of their units' features (best unit rank, pool size, any unit mentioned).

**Integrity.** Features are cached with a fingerprint of every module that computes them, and a model refuses to load against features from different code. History uses only strict ancestors of the base commit (a test covers root and merge commits). Past issues are filtered by time, excluding the query itself (a test covers the boundary cases).

## Results

5-fold cross-validation on training issues:

| | recall@1 | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| Function: hybrid | 0.241 | 0.476 | 0.571 | 0.512 |
| Function: LTR | 0.294 | 0.564 | 0.666 | 0.588 |
| File: hybrid | 0.519 | 0.790 | 0.867 | 0.741 |
| File: LTR | 0.585 | 0.834 | 0.891 | 0.800 |

Lite test, held out:

| | recall@1 | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| Function: hybrid → LTR | 0.269 → 0.327 | 0.569 → 0.628 | 0.642 → 0.744 | 0.416 → 0.485 |
| File: hybrid → LTR | 0.583 → 0.630 | 0.850 → 0.877 | 0.917 → 0.923 | 0.698 → 0.740 |

Against hybrid at function level (first model, before the past-issue features): recall@10 +8.7 points (p < 0.001, 37 wins / 8 losses), recall@1 +5.1 (p = 0.011). Adding the past-issue features moved function recall@10 from 0.730 to 0.744 and file recall@10 from 0.910 to 0.923, a consistent but not individually significant gain.

## What did not work

- **Zero-shot LLM reranking** (Qwen3-Reranker-0.6B, not fine-tuned) on hybrid's top 30 of 80 dev issues matched hybrid's own order (recall@1 0.369 vs 0.365) at 7 s per query. Reading code cold, a small model adds nothing a tuned retriever does not already have. See 0007 for the fine-tuned version.
- **Similar past issues** looked promising (34% of Lite gold functions had been fixed for an earlier issue) but moved results by about one point: textual similarity between reports rarely pins down the same function.

## Consequences

- Query latency rises to about 250 ms, mostly feature extraction (history evidence, title embedding, per-candidate mention checks). Indexing is unchanged.
- Two small model files live in `models/` with a JSON sidecar recording features, parameters, CV scores and feature importance.
