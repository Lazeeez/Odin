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
| `comparison/locagent-lite_2026-10-13.json` | the stored rankings of four stages scored under the LocAgent protocol, with per-issue outcomes ([docs/comparison.md](../docs/comparison.md), `scripts/score_protocol.py`) |
| `comparison/cosil-lite_2026-10-14.json` | the four stages scored under the CoSIL protocol |
| `reproductions/swerank-embed-small_lite_2026-10-14.json` | SweRankEmbed-Small reproduced with its authors' corpora and evaluator: sources, settings, the check against their unmodified script, and the rankings |
| `runs/NAME/result.json` | a manifest run, verified and scored by `odin import-run` ([ADR 0015](../docs/decisions/0015-manifest-runs.md)). `swerank-embed-small-lite` is SweRankEmbed-Small inside Odin's index |
| `perf/unit_slots_2026-10-13.json` | unit slots and distinct unit texts over the evaluated snapshots (`benchmarks/count_unit_slots.py`) |
| `ties/*_lite_test.json` | all 17 rows run again after ties at a cut-off were made deterministic ([ADR 0016](../docs/decisions/0016-deterministic-ties.md)): 33 of 5,019 rankings changed, no metric changed. The README check reads these first |
| `parity_pinned_2026-10-13b.json` | the pinned parity check after that fix: 46 of 46 top-10 lists identical. `parity_pinned.json` is the run before it |
| `parity_pinned.json` | the website's TypeScript chunker and BM25 against the Python engine on pinned commits of django, sympy and requests (`scripts/parity_run.py`) |

Each `*` stands for `_file_lite_test.json` and `_function_lite_test.json`.

## Test-set evaluations

[test-evals.log](test-evals.log) lists every evaluation on a held-out test set, with the reason it was run and what was decided from it: 80 on SWE-bench Lite and 2 on the unseen-project set as of 2026-10-14. New evaluations append a line.

Thirteen files in this folder (`random`, `oracle`, the `bm25-*`, `dense-notests` and `hybrid-notests` rows) were written before provenance was recorded. They are kept, and each was run again on 2026-10-13 into `provenance/` with a provenance block; the README check reads the re-run where one exists.

- The nine lexical and sanity rows reproduce exactly, ranking for ranking.
- The four dense and hybrid rows reproduce every recall, hit and all@k figure, and every number the README prints. Their MRR differs in the fourth decimal (at most 0.0006) and 24 to 35 issues per file have near-tied items in a different order. Two runs today are identical to each other, so this is not run-to-run noise. The likely cause, not confirmed, is that the stored files predate the change that routed query vectors through the embedding cache ([ADR 0008](../docs/decisions/0008-embedding-store-corruption.md)).

## Not here

Training logs, feature caches and reranker training sets stay local: they are large (2.6 GB) and rebuildable with the commands in the README. Results are never overwritten; a superseded number keeps its file and is marked as superseded where it is cited.
