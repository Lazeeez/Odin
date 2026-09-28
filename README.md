# Odin

Bug localization over any git commit: structural chunking, code-aware BM25 and content-addressed code embeddings for recall, then a learned LambdaMART ranker and a fine-tuned LLM cross-encoder for precision, all measured against real bug fixes.

The question this project answers: **given a bug report, can we find the code that has to change?** Every design decision is scored on SWE-bench issues, where the ground truth is the set of functions the maintainers' actual fix touched, and every claimed improvement comes with a paired significance test.

## Headline results

SWE-bench Lite test, 300 issues across 12 repositories, each searched at its own `base_commit`, out of roughly 10k to 45k candidate functions per snapshot. Nothing was trained or tuned on these issues.

| Final system (`ltr-ce-notests`) | hit@1 | hit@5 | hit@10 | recall@10 | MRR |
|---|---|---|---|---|---|
| **File that must change** | 69.0% | **89.3%** | **93.0%** | 0.930 [0.90, 0.96] | 0.783 |
| **Function that must change** | 45.0% | 73.9% | **79.4%** | 0.772 [0.72, 0.82] | 0.560 |

*hit@k*: at least one location the maintainers' fix touched is in the top k. Brackets are 95% bootstrap intervals.

For reference, the same retrieval stack started this project at 30.8% function recall@10 with plain BM25.

### Every retriever

| Retriever | Level | Recall@1 | Recall@5 | Recall@10 | All@10 | MRR |
|---|---|---|---|---|---|---|
| random | file | 0.003 | 0.013 | 0.017 [0.00, 0.03] | 0.017 | 0.008 |
| bm25-naive | file | 0.340 | 0.617 | 0.693 [0.64, 0.75] | 0.693 | 0.457 |
| bm25-code | file | 0.363 | 0.647 | 0.727 [0.67, 0.78] | 0.727 | 0.487 |
| bm25-code-notests | file | 0.457 | 0.723 | 0.790 [0.74, 0.83] | 0.790 | 0.571 |
| dense-notests | file | 0.483 | 0.800 | 0.873 [0.83, 0.91] | 0.873 | 0.621 |
| hybrid-notests | file | 0.583 | 0.850 | 0.917 [0.88, 0.95] | 0.917 | 0.698 |
| ltr-notests | file | 0.627 | 0.883 | 0.930 [0.90, 0.96] | 0.930 | 0.741 |
| **ltr-ce-notests** | file | **0.690** | **0.893** | **0.930** [0.90, 0.96] | 0.930 | **0.783** |
| bm25-naive | function | 0.141 | 0.249 | 0.308 [0.26, 0.36] | 0.289 | 0.203 |
| bm25-code | function | 0.154 | 0.329 | 0.428 [0.37, 0.49] | 0.406 | 0.247 |
| bm25-code-notests | function | 0.190 | 0.427 | 0.519 [0.46, 0.58] | 0.491 | 0.307 |
| bm25-code-notests-graph | function | 0.194 | 0.427 | 0.523 [0.47, 0.58] | 0.495 | 0.312 |
| dense-notests | function | 0.225 | 0.479 | 0.586 [0.53, 0.64] | 0.564 | 0.365 |
| hybrid-notests | function | 0.269 | 0.569 | 0.642 [0.59, 0.69] | 0.622 | 0.416 |
| ltr-notests | function | 0.344 | 0.643 | 0.729 [0.68, 0.78] | 0.708 | 0.497 |
| **ltr-ce-notests** | function | **0.407** | **0.706** | **0.772** [0.72, 0.82] | 0.746 | **0.560** |

Every tunable choice was made on data disjoint from Lite: a dev set (SWE-bench Verified minus Lite) for fusion and expansion, and SWE-bench test minus Lite (1,941 issues) for the learned rankers.

### What each step bought (paired bootstrap, function level, 291 issues)

| Change | ΔRecall@10 | 95% CI | p | Wins / losses |
|---|---|---|---|---|
| naive → code-aware tokenizer | **+0.121** | [+0.076, +0.166] | <0.001 | 50 / 11 |
| + exclude test files | **+0.091** | [+0.058, +0.126] | <0.001 | 32 / 2 |
| + call-graph expansion (dev-tuned) | +0.003 | [+0.000, +0.010] | 0.72 | 1 / 0 |
| BM25 → dense embeddings alone | +0.066 | [+0.002, +0.129] | 0.045 | 63 / 43 |
| dense → hybrid (dev-tuned fusion) | **+0.057** | [+0.019, +0.096] | 0.002 | 30 / 11 |
| **BM25 → hybrid, overall** | **+0.123** | [+0.070, +0.174] | <0.001 | 57 / 17 |
| hybrid → learning to rank (LambdaMART) | **+0.087** | [+0.049, +0.128] | <0.001 | 36 / 9 |
| LTR → + fine-tuned cross-encoder (ensemble of 2) | **+0.043** | [+0.013, +0.074] | 0.005 | 24 / 7 |

The cross-encoder's main job is the top of the list: function MRR +0.063 and recall@1 +0.063 (both p < 0.01), file MRR +0.042 and recall@1 +0.063 (p < 0.01). Earlier LTR and cross-encoder numbers were measured on a corrupted embedding store and are superseded ([ADR 0008](docs/decisions/0008-embedding-store-corruption.md)).

- **Code-aware tokenization** splits `get_queryset` and `HTTPServerError` into parts and keeps the whole identifier too, so both prose ("query set") and exact mentions match. It helps most at depth. At recall@1 the gain (+0.012) is not significant.
- **Excluding tests** is the largest single win at recall@1. Test methods reuse every identifier in the issue, so they crowd out the source.
- **Call-graph expansion does not pay for itself.** It was tuned on a held-out dev set and confirmed on test. [ADR 0004](docs/decisions/0004-call-graph-expansion.md) shows why: only 15% of misses are one call away from a top hit, so the ceiling is low. It ships as opt-in.
- **Learning to rank turns many weak signals into one ordering** ([ADR 0006](docs/decisions/0006-learning-to-rank.md)). The candidate pool already held a gold unit for 97% of issues, so the remaining errors were about order. LambdaMART learns it from 42 features: retrieval scores, the issue title and code spans scored separately, traceback frames and names mentioned in the issue, file structure, git history from strict ancestors of the base commit (BugLocator-style churn and similar past commits), and fixes of similar earlier issues.
- **A fine-tuned LLM reranker reads the issue and the code together** ([ADR 0007](docs/decisions/0007-fine-tuned-cross-encoder.md)). Zero-shot it added nothing, but after one LoRA epoch on in-domain hard negatives it lifts the top ranks. It runs only on the top 20, with a shared-prefix KV cache so the issue is encoded once per query rather than once per candidate.
- **Hybrid is the big win, because the two retrievers fail differently.** Dense alone is only marginally better than BM25 (p = 0.045), but fusing them beats both. Recall@10 is +12.7 points at file level too, with 42 wins to 4 losses. The largest gains are where issues aren't written in identifiers: sympy recall@10 went from 0.37 to 0.59 and pytest from 0.30 to 0.56 ([ADR 0005](docs/decisions/0005-dense-hybrid-retrieval.md)).

Reproduce any row: `make eval RETRIEVER=bm25-code-notests LEVEL=function`, then `uv run odin compare results/A.json results/B.json`.

## Performance

Full Lite evaluation at function level (291 snapshots, 451k files) on a 12-core laptop:

| | First working version | Now |
|---|---|---|
| End-to-end wall time | 273 s | **153 s** |
| Index build p50 / p95 | 595 / 2852 ms | **420 / 995 ms** |
| Query latency p50 / p99 | 0.58 / 1.44 ms | 0.60 / 1.33 ms |
| Files indexed / blobs actually parsed | 451k / 45k | 451k / 45k (**90% reuse**) |

Ranked output is byte-identical across every optimization; the eval harness checks this.

A persistent **analysis cache** (SQLite, keyed by blob id plus a fingerprint of the parser and tokenizer *source code*, so editing either invalidates exactly the stale entries) takes a repeat evaluation from 146 s to **43 s**, and index build p95 from 755 ms to 209 ms, again with identical output.

Where the time went, and what fixed it:

- **Git reads: 377× faster.** One long-lived `git cat-file --batch` process instead of two subprocesses per file (400 files: 20.3 s → 0.05 s).
- **Content addressing: 10× less parsing.** Work is memoized by blob id. 90% of the files in any snapshot are byte-identical to a snapshot already indexed.
- **Bulk fetch.** Each repository's missing blobs for every needed commit are found with one `cat-file --batch-check` (lazy fetch disabled) and downloaded with one `git fetch --stdin`, instead of one lazy round trip per object.
- **No Python loop over documents.** BM25 weights are precomputed into a scipy CSC matrix, so a query is a column slice plus one sparse mat-vec. Path terms are added to every chunk with a single sparse product, and the call graph is resolved with sorted-array joins.
- **Tokenization collapses repeats in C.** `Counter(re.findall(...))` runs first, so each distinct identifier is split once, not once per occurrence.
- **Parsing in a process pool.** Tree-sitter holds the GIL, so threads did nothing. Workers return compact arrays against a blob-local term table, and the main process interns each blob's distinct terms with one gather.

### Dense retrieval

| | |
|---|---|
| Unit slots across all 698 evaluated snapshots | 6.79M |
| Distinct unit texts actually embedded (content-hash store) | **185k (36.7× fewer)** |
| GPU time to embed everything (RTX 4050, fp16) | ~15 min, instead of ~9.5 h |
| Units that needed embedding for the Lite run after dev tuning | 8.5k |

Batching (4000 django units, `benchmarks/bench_batching.py`):

| Strategy | Units/s | Real / padded tokens |
|---|---|---|
| Fixed batches of 32 in file order | 43 | 21% |
| Length-sorted, batches of 32 | 201 | 98% |
| **Length-sorted, 4096-token budget** | **208** | 98% |

Sorting is nearly all of the 4.8× gain. Budget packing adds about 3%, and larger budgets are slower once the GPU is saturated.

**Why not A\*, WAND or HNSW?** Pruning search (best-first graph search in HNSW, admissible upper bounds in WAND/MaxScore) buys cheaper scoring with extra build work. On a django snapshot (`benchmarks/bench_search.py`):

| Step | ms |
|---|---|
| Encode the issue text (GPU) | 25 |
| BM25 over all units | 0.05 |
| Exact dense search, GPU / CPU | 0.10 / 0.47 |
| HNSW build (FAISS, M=16/32) | ~650 |
| HNSW query | 0.05 to 0.2 |

Each snapshot answers one query, so HNSW would need about 13,000 queries on the same commit to repay its build. Exact search is both faster and lossless here. The time that matters is query encoding and indexing new code, which is where the optimization went.

## Architecture

```mermaid
flowchart LR
    I[issue text] --> T[code-aware tokenizer]
    subgraph index["snapshot index (per base_commit)"]
      G[(blobless git mirror)] -->|ls-tree| E[tree entries: path, blob id]
      E -->|unseen blob ids| P[process pool: tree-sitter parse, chunk, count]
      P --> M[(blob-id memo)]
      M --> X[CSC matrix of BM25 weights]
      M --> CG[call graph via array joins]
      P -->|new unit texts| EM[GPU encoder, length-bucketed]
      EM --> ES[(content-hash embedding store)]
    end
    T --> S[sparse mat-vec]
    X --> S
    I --> QE[query encoder] --> D[exact dense mat-vec]
    ES --> D
    S --> F[z-score fusion]
    D --> F
    F --> R[top-k functions, or files by best function]
```

The ranking cascade on top: each stage is more expensive per candidate and sees fewer of them.

```mermaid
flowchart LR
    A["BM25 + dense<br/>all units (~40k)"] --> B["candidate pool<br/>~450 units, 97% contain a gold unit"]
    B --> C["LambdaMART<br/>42 features: retrieval, mentions,<br/>tracebacks, git history, past fixes"]
    C --> D["fine-tuned cross-encoder<br/>top 20, shared-prefix KV cache"]
    D --> E[ranked functions and files]
```

- **Chunk = the unit ground truth is labelled with.** Each non-nested function, method and class is a chunk. A class chunk holds only the lines its methods don't own (header, docstring, attributes). Everything else is a module chunk used for file-level search.
- **Every issue is searched at its own `base_commit`.** Searching at HEAD leaks the fix ([ADR 0002](docs/decisions/0002-index-at-base-commit.md)).

## Evaluation methodology

- **Ground truth** comes from the gold patch, mapped onto a Tree-sitter parse of each file *as it existed at `base_commit`* (details below).
- **Held-out tuning.** Anything with a knob is tuned off Lite: fusion and expansion on SWE-bench Verified minus Lite (407 issues, `odin tune`), learned rankers on SWE-bench test minus Lite (1,941 issues, `odin ltr`, 5-fold CV grouped by query), and the reranker's depth and weights on 250 issues held out from its training (`odin ce-tune`), with the selection rule written down before looking. Lite test is run once per final configuration.
- **No leakage through features.** Git history uses only strict ancestors of the base commit (`git rev-list`). Earlier-issue features only see issues opened at least 30 days before the query. Both boundaries have tests.
- **Reproducibility.** Cached features and trained models carry a fingerprint of the source code that produced them, and a model refuses to load against different feature code. Every result file records the git commit, library versions, model hashes and command line.
- **Significance.** `odin compare` runs a paired bootstrap over queries (10k resamples) and reports Δ, a 95% CI, a two-sided p-value and win/loss counts. A difference that isn't significant is reported as such.
- **Honest latency.** Index construction is timed separately from query latency, and both are reported with p50/p95/p99.
- **Per-repo breakdown** is in every result file, so django (108 of 291 issues) cannot hide a regression elsewhere.

<details>
<summary>Per-repository results, function level: BM25 vs hybrid</summary>

| Repository | Issues | BM25 recall@10 | Hybrid recall@10 | BM25 MRR | Hybrid MRR |
|---|---|---|---|---|---|
| django/django | 108 | 0.59 | 0.67 | 0.37 | 0.45 |
| sympy/sympy | 75 | 0.37 | **0.59** | 0.20 | **0.41** |
| matplotlib/matplotlib | 23 | 0.45 | 0.53 | 0.34 | 0.32 |
| scikit-learn/scikit-learn | 23 | 0.61 | 0.70 | 0.38 | 0.49 |
| pytest-dev/pytest | 16 | 0.30 | **0.56** | 0.13 | 0.20 |
| sphinx-doc/sphinx | 16 | 0.66 | 0.75 | 0.28 | 0.35 |
| astropy/astropy | 6 | 0.67 | 0.71 | 0.45 | 0.62 |
| psf/requests | 6 | 0.83 | 0.83 | 0.48 | 0.47 |
| pylint-dev/pylint | 6 | 0.67 | 0.50 | 0.44 | 0.38 |
| pydata/xarray | 5 | 0.40 | 0.60 | 0.25 | 0.37 |
| mwaskom/seaborn | 4 | 0.75 | 0.75 | 0.21 | 0.21 |
| pallets/flask | 3 | 0.50 | 1.00 | 0.39 | 0.78 |

sympy and pytest were the hard cases for BM25: sympy issues are often written in mathematical notation rather than identifiers, and pytest issues describe the behaviour of a tool whose source shares its vocabulary with its tests. Those are exactly the repos where embeddings helped most. The small repos have too few issues to read much into.
</details>

## Quick start

```bash
uv sync                                          # lexical engine only, no PyTorch
uv sync --extra dense                            # + CUDA PyTorch and the embedding model
make gold                                        # ground truth (committed; rebuild to verify)
make eval RETRIEVER=hybrid-notests LEVEL=function
uv run odin gold --dataset full                  # training ground truth (2,294 issues)
uv run odin ltr                                  # LambdaMART models (committed in models/)
uv run odin ce-train && uv run odin ce-tune      # reranker adapter (~35 min, not committed)
make eval RETRIEVER=ltr-ce-notests LEVEL=function
uv run odin compare results/bm25-code_function_lite_test.json \
                    results/bm25-code-notests_function_lite_test.json
uv run odin search psf/requests "redirect drops the authorization header" --no-tests
make test
```

The first evaluation clones 12 blobless mirrors (about 400 MB) and fetches the source blobs for every needed commit in one request per repository. Later runs are offline.

Retrievers: `random`, `oracle`, `bm25-naive`, `bm25-code`, `bm25-code-notests`, `bm25-code-notests-graph`, and with the `dense` extra `dense-notests`, `hybrid-notests`, `ltr-notests` and `ltr-ce-notests`. The first dense run embeds about 185k units (about 15 minutes on a laptop GPU). Later runs reuse `.cache/embeddings`.

## Website

`web/` is the product site: **TypeScript + Vite + Preact**, deployed to GitHub Pages by `.github/workflows/pages.yml` (or Vercel via `vercel.json`). Everything runs in the visitor's browser; there is no server. Pages are hash routes, so any static host works: Home, `#/search`, `#/how-it-works`, `#/benchmarks` and `#/explore/<issue>`; older `?repo=` and `#issue=` links redirect.

- **Search any public Python repository.** It accepts `owner/name`, https or ssh URLs, and links to a branch, a folder (the search is then limited to it), a file, an issue or a pull request. Over the browser budget (6,000 files, 60 MB) it keeps the project's own code and drops docs, examples and vendored code first; committed virtualenvs are skipped. A Web Worker lists the repository through GitHub's API, downloads its Python files, splits them into functions with Tree-sitter compiled to WebAssembly, and builds the project's code-aware BM25 index. A learned ranker (LambdaMART, exported as JSON trees) orders candidates using what the issue names: traceback frames, quoted identifiers, module paths, and title matches. It then refines the top 20 with a small embedding model, running on WebGPU (fp16) where available and WebAssembly (8-bit) otherwise. Parsed repositories are cached in IndexedDB by git tree hash, so they are never stale, and embeddings by content hash, so a revisit is instant. The main thread never blocks.
- **Measured, not claimed.** `scripts/browser_ltr.py` trains the browser's ranker on 1,941 SWE-bench issues (settings chosen by cross-validation) and scores this exact pipeline once on held-out Lite. Hit@10 is 54.6% with keyword search alone, 67.3% with the instant learned ranking (no model download), and 70.1% after the semantic stage (MRR 0.307 → 0.431 → 0.439). A parity test runs the TypeScript features against the Python ones, and the export checks the JSON trees against LightGBM's own predictions. See [ADR 0010](docs/decisions/0010-browser-ranker.md).
- **Replayed results of the full pipeline.** Stage-by-stage metrics with confidence intervals, significance tests, per-repository tables, and an explorer showing each stage's top 10 for all 300 Lite issues. Explorer views are deep-linkable (`#/explore/django__django-11019`).
- **UX.** Real open issues from the loaded repository as one-click queries, an explanation of why each result matched, a Functions/Files view, syntax-highlighted code with line numbers, shareable `#/search?repo=&q=` links, cancel, recent repositories, `/` to focus, and a light/dark toggle.

The engine in `web/src/engine/` is a port of the chunker, tokenizer and BM25. `tests/test_site_engine.py` runs that TypeScript source directly under Node 24 and requires unit-for-unit agreement with the Python chunker and identical BM25 rankings and scores. On 837 files from django, sympy and requests (17,369 units) there are zero mismatches. `web/test/` holds Vitest unit tests, including a check that highlighted repository code can never inject markup.

```bash
cd web && npm ci && npm run dev        # http://localhost:5173
npm test && npm run typecheck          # Vitest + strict TypeScript
uv run python scripts/export_site.py   # refresh web/public/data/ from results/*.json
```

The build is about 47 KB of JavaScript for the page (18 KB gzipped), an 87 KB worker, and 150 KB (gzipped) of parser WebAssembly, loaded only when searching. The ML runtime comes from jsDelivr's CDN on first semantic search.

One-time setup for Pages: repository Settings → Pages → Source: GitHub Actions.

## How ground truth is built

For each issue the gold patch is parsed hunk by hunk against the file **as it existed at `base_commit`**, never at HEAD, since later history contains the fix itself.

- **Removed or modified lines** map to the innermost enclosing symbol (function, method, or class) from a Tree-sitter parse of the original file.
- **Pure insertions** have no original line, so they are attributed by indentation. The owner is the innermost symbol adjacent to the insertion point whose definition is indented less than the inserted code. Appending a line to a method's body lands in that method, while adding a new method lands in the class.
- **Nested functions** are normalized to their enclosing top-level function or method, which is the unit the index retrieves.
- **Blank and comment-only additions** are ignored.
- Edits outside any symbol (imports, module constants) mark the file as module-level. Those issues count at file level but are skipped at function level.

Of the 300 Lite issues, 275 have a function or method target, 16 more are class-level only (new methods, class attributes), and 9 are module-level only. Every Lite gold patch touches exactly one file.

## Metrics

Per issue, with gold set *G* and ranked list *R*:

- **recall@k**: |top-k(R) ∩ G| / |G|
- **hit@k**: at least one gold item in top-k
- **all@k**: every gold item in top-k, which is what a downstream editing agent actually needs
- **MRR**: reciprocal rank of the first gold item

## Layout

```
src/odin/
  repos.py                    blobless mirrors, batch blob reader, bulk missing-blob fetch
  parsing/python_symbols.py   Tree-sitter symbols (qualified names, spans, nesting), call sites
  index/chunker.py            file -> retrieval-unit chunks with their outgoing calls
  index/snapshot.py           content-addressed snapshot indexer, process pool, call graph
  index/store.py              SQLite analysis cache keyed by blob id + source-code fingerprint
  search/tokenize.py          naive vs identifier-aware tokenizers
  search/bm25.py              vocabulary, precomputed-weight sparse BM25, top-k
  search/graph.py             one-hop call-graph expansion
  search/dense.py             embedding store, length-bucketed encoder, exact search, fusion
  search/retriever.py         Query, Retriever protocol, BM25Retriever, HybridRetriever
  eval/dataset.py             SWE-bench loader
  eval/goldpatch.py           unified diff -> removed lines + indented insertion points
  eval/ground_truth.py        diff + symbols -> gold files/functions per issue
  eval/metrics.py             recall/hit/all@k, MRR, bootstrap CIs, paired bootstrap test
  eval/runner.py              eval loop, baselines, retriever registry
  eval/tune.py                dev-set grid search (expansion, fusion) reusing one pass of scores
  eval/provenance.py          git commit, versions and model hashes recorded with every result
  rank/mentions.py            names, dotted paths, code spans and traceback frames in an issue
  rank/history.py             git history evidence from ancestors of the base commit
  rank/past_issues.py         fixes of similar earlier issues, visible only after they merged
  rank/features.py            candidate pools and ranking features, per function and per file
  rank/ltr.py                 LambdaMART training, grouped CV, LTR and cascade retrievers
  rank/cross_encoder.py       LLM reranker with shared-prefix KV caching
  rank/ce_train.py            LoRA fine-tuning with a listwise loss over hard negatives
  rank/ce_tune.py             reranker depth and blend weights on held-out training issues
benchmarks/                   batching throughput; query-time breakdown and exact vs HNSW
docs/decisions/               why things are the way they are
```

## Design decisions

1. [Build the evaluation harness before the search engine](docs/decisions/0001-eval-first.md)
2. [Index and label every issue at its base_commit](docs/decisions/0002-index-at-base-commit.md)
3. [Content-addressed chunks and a precomputed sparse BM25 matrix](docs/decisions/0003-content-addressed-sparse-index.md)
4. [Call-graph expansion is opt-in because it does not pay for itself](docs/decisions/0004-call-graph-expansion.md)
5. [Dense embeddings cached by content hash, fused with BM25, searched exactly](docs/decisions/0005-dense-hybrid-retrieval.md)
6. [Learn the ranking with LambdaMART over retrieval, structure, mention and history features](docs/decisions/0006-learning-to-rank.md)
7. [A fine-tuned cross-encoder as the last stage of a ranking cascade](docs/decisions/0007-fine-tuned-cross-encoder.md)

## Adding a retriever

Implement `retrieve(query, level, k) -> list[str]`, returning file paths for `level="file"` or `path::Qualified.name` ids for `level="function"`, and register it in `RETRIEVERS`. Optionally implement `warmup`, `prepare` and `close` (the `Indexing` protocol) so index construction is timed apart from queries.

## Status and next steps

| Phase | Scope | State |
|---|---|---|
| 1 | Eval harness: SWE-bench ground truth, metrics, runner | done |
| 2 | Tree-sitter chunker, content-addressed snapshot index | done |
| 3a | BM25, naive vs code-aware tokens, significance testing | done |
| 4 | Call graph + one-hop expansion, dev-tuned | done (negative result, ADR 0004) |
| 3b | Dense code embeddings cached by content hash, hybrid fusion | done (ADR 0005) |
| 6 | Learning to rank (LambdaMART), git history and past-issue features | done (ADR 0006) |
| 7 | Fine-tuned cross-encoder reranking, shared-prefix KV cache | done (ADR 0007) |
| 8 | LLM listwise reranking of the top 10 (needs an API model) | next |
| 5 | Persistent on-disk index, incremental updates | planned |

What would move the numbers further, in expected order of impact:

1. **A frontier LLM as the final stage.** Published SWE-bench localization agents get their precision from large models reading candidate code. The cascade already reduces each issue to about 20 candidates, which keeps that affordable.
2. **A bigger reranker base model** where memory allows. More epochs, LTR-mined negatives and a two-adapter ensemble were already tried and kept ([ADR 0007](docs/decisions/0007-fine-tuned-cross-encoder.md)). Fine-tuning the embedding model was tried and did not help.

## License

[MIT](LICENSE)
