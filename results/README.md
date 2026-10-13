# Results

Every number in the top-level README comes from a file in this folder or from `web/public/data/lite.json`. `scripts/check_readme.py` recomputes each of them and CI fails if one drifts (`make check-readme`).

## What a result file holds

`<retriever>_<level>_lite_test.json`, written by `odin eval`:

- `summary`: the metrics (recall@k, hit@k, all@k, MRR), 95% bootstrap intervals, the number of issues scored (`n`) and skipped (`skipped_no_target`), latency and index statistics, and a per-repository breakdown.
- `per_instance`: for each issue, the gold locations, the ranked list and the rank of the first gold item. `odin compare A.json B.json` runs the paired bootstrap from these, so any significance claim can be recomputed from a clone.
- `provenance`: git commit, library versions, hashes of the model files and the command line.

Function-level files score 291 of the 300 Lite issues: the 9 whose fix touches only module-level code have no function or class target and are skipped. File-level files score all 300.

## Files

| File | Backs |
|---|---|
| `random_file`, `oracle_file` | sanity bounds of the harness |
| `bm25-naive_*`, `bm25-code_*`, `bm25-code-notests_*`, `bm25-code-notests-graph_function` | lexical rows and the tokenizer, test-exclusion and call-graph comparisons |
| `dense-notests_*`, `hybrid-notests_*` | dense and hybrid rows ([ADR 0005](../docs/decisions/0005-dense-hybrid-retrieval.md)) |
| `ltr-notests_*` | learning to rank ([ADR 0006](../docs/decisions/0006-learning-to-rank.md)) |
| `ltr-ce-notests_*` | the final system: headline results ([ADR 0007](../docs/decisions/0007-fine-tuned-cross-encoder.md)) |
| `ltr-ce-distilled-notests_*` | the distilled single reranker, tried and not adopted |
| `ltr-v1_*` | the learned ranker measured on the corrupted embedding store; superseded, kept as the record for [ADR 0008](../docs/decisions/0008-embedding-store-corruption.md) |
| `browser_old_vs_new.json` | paired bootstrap of the website's rankers against the ones they replaced ([ADR 0011](../docs/decisions/0011-website-at-scale.md)) |
| `cache_cold.json`, `cache_warm.json` | earlier analysis-cache timings, written without provenance; superseded by `perf/lite_index_2026-10-13.json` and no longer cited |
| `perf/lite_index_2026-10-13.json` | the README's Performance table: indexing every Lite snapshot with no, a cold and a warm analysis cache (`benchmarks/bench_lite_index.py`). No metric is computed, so it is not a test-set evaluation |
| `perf/bench_batching_2026-10-13.json`, `perf/bench_search_2026-10-13.json` | the printed output of the batching and exact-versus-HNSW benchmarks, saved with hardware and provenance (`benchmarks/save_output.py`) |
| `perf/unit_slots_2026-10-13.json` | unit slots and distinct unit texts over the evaluated snapshots (`benchmarks/count_unit_slots.py`) |
| `parity_pinned.json` | the website's TypeScript chunker and BM25 against the Python engine on pinned commits of django, sympy and requests (`scripts/parity_run.py`) |

Each `*` stands for `_file_lite_test.json` and `_function_lite_test.json`.

## Test-set evaluations

[test-evals.log](test-evals.log) lists every evaluation on a held-out test set, with the reason it was run and what was decided from it: 33 on SWE-bench Lite and 2 on the unseen-project set as of 2026-10-13. New evaluations append a line.

Thirteen files (`random`, `oracle`, the `bm25-*`, `dense-notests` and `hybrid-notests` rows) were written before provenance was recorded and have no `provenance` block. Their rankings are deterministic and `bm25-code-notests` at function level was re-run in October 2026 with identical output.

## Not here

Training logs, feature caches and reranker training sets stay local: they are large (2.6 GB) and rebuildable with the commands in the README. Results are never overwritten; a superseded number keeps its file and is marked as superseded where it is cited.
