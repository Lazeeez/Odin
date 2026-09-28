# 0011: The website at scale: 150 more projects, semantic search, faster loading

## Status

Accepted. Extends [ADR 0010](0010-browser-ranker.md).

## Context

The website's ranker (ADR 0010) was trained and tested on SWE-bench, whose 12 projects are the same in training and test. Visitors paste repositories it has never seen, and large ones took up to a minute and a half to load file by file. The goal of this round: more accurate on unseen projects, faster on new repositories, and a better experience.

## Decisions

### Data: 150 more projects, 30 of them never trained on

- **SWE-rebench** (CC-BY-4.0) has about 21,000 real issues with merged fixes from about 3,500 Python projects. `scripts/sample_rebench.py` draws, with a fixed seed, 150 projects that have at least 20 bugs, none of SWE-bench's twelve, with up to 30 bugs each.
- **Split by project, not by bug.** 120 projects (3,289 bugs) are for training. 30 projects (785 bugs) are held out entirely as the "unseen" benchmark. The sample is committed (`data/rebench_sample.json`), with its ground truth (`data/gold/swebench_rebench_*.jsonl`).
- **Training** uses SWE-bench minus Lite plus rebench train: 5,115 issues with a function-level target, from 131 projects.
- **Cross-validation folds are whole projects.** Every choice below was made on projects the model was not trained on, the situation the website is in.
- **Robustness found along the way.** Building ground truth for 150 projects surfaced a deleted repository and a patch format (`\ No newline at end of file` after an addition) that crashed the build. Both are now handled, and the patch format has a regression test.

### Semantic search over every function, with static embeddings

- **Four models compared** as whole-repository semantic features in 5-fold CV on the 1,941 SWE-bench training issues. Static embeddings (Model2Vec) have no neural network at encode time: a text's vector is the mean of its tokens' vectors.

  | Semantic features over every function | CV hit@10 |
  |---|---|
  | none (the instant ranker) | 0.748 |
  | potion-code-16M (static, code-trained) | **0.766** |
  | potion-retrieval-32M (static) | 0.759 |
  | potion-base-8M (static) | 0.759 |
  | MiniLM (a transformer; about 25 functions/s on a CPU) | 0.775 |

- **Choice: potion-code-16M.** The rule, declared beforehand, was the best CV hit@10 among models a browser can run over a whole repository. MiniLM is the ceiling reference: it cannot embed a large repository in a browser in reasonable time.
- **Size.** The model ships as int8 rows with one scale each: 16.8 MB, 14.5 MB gzipped. Its vectors keep a cosine similarity of at least 0.9998 to the float32 originals, and the ranker is trained on the quantized vectors, so the browser's features are exactly the training features.
- **Browser port.** `web/src/engine/static.ts` reimplements BERT's normalizer, pre-tokenizer and WordPiece. It is token-identical to the Rust `tokenizers` library, including the special-token rules (`[UNK]` anywhere, `[PAD]` as a whole word in any case). It embeds about 3,300–4,200 functions per second per thread, and runs on the parser threads in the background after a repository loads.

### Stages the website runs

| Stage | Features | When |
|---|---|---|
| instant | 33: keyword scores for the issue, title and quoted code; mentions and tracebacks; file evidence; code shape | at once, and while a large repository is still loading |
| semantic | + 7 from the static index: similarity to the issue and title, and ranks, for each function and its file; the pool also takes the 50 functions closest to the issue and the 20 closest to its title | once the background index is ready (about 1–5 s) |
| rerank | + 5 MiniLM features for the top 20 | only if it adds ≥ 0.5 points of CV hit@10 over semantic (declared beforehand) |
| file | 25 file-level features | the Files view, once the semantic index is ready |

### Faster loading

- **Parser threads.** Parsing and word counting run on up to four worker threads. On transformers they took 8.3 s and 2.5 s on one thread.
- **Search while loading.** A partial index is published every 2.5 s during long loads; transformers is searchable after 3.4 s.
- **One archive per repository.** An optional CORS relay (`proxy/cloudflare-worker.js`, free Cloudflare plan) serves GitHub's `.tar.gz` of a repository, streamed and unpacked in the browser. Complete loads, file by file against the relay:

  | Repository | File by file | Relay |
  |---|---|---|
  | transformers | 57 s | 5.0 s |
  | Home Assistant | 102 s | 4.2 s |
  | CPython | 15 s | 5.0 s |
  | Django | 12 s | 1.5 s |

  It is off until the relay is deployed. If the relay fails, loading falls back to file by file.
- **Caching.** Repository listings are reused for ten minutes, so a reload costs no GitHub API request. Cached repositories are evicted least-recently-used (12 repositories, about 400 MB).

## Verification

`tests/test_site_engine.py` runs the TypeScript under Node against Python:

- the chunker and BM25;
- every ranking stage's candidates, features and scores;
- static embeddings: token ids and vectors, on this repository's code plus unicode, CJK, emoji, control characters and special tokens.

That last test caught a real bug. The Python encoder batch-padded texts with `[PAD]` (the tokenizer file enables padding) and averaged the padding into short texts' vectors, most visibly the issue *title*, encoded in a batch with the long issue body. The browser was correct; Python was fixed (`no_padding()`) and the model comparison above was rerun. potion-code went from 0.759 to 0.766 and stayed the choice.

## Results

From `scripts/browser_ltr.py` (`web/public/data/lite.json`) and a paired bootstrap of the new rankers against the ones they replace (ADR 0010, trained on SWE-bench only), over the same issues.

**30 projects never trained on (747 bugs)**, the situation of every repository a visitor pastes:

| In-browser stage | hit@1 | hit@10 | MRR |
|---|---|---|---|
| keyword search only | 0.328 | 0.661 | 0.435 |
| instant | 0.438 | 0.755 | 0.543 |
| + semantic index | 0.434 | 0.772 | 0.542 |
| + MiniLM rerank of the top 20 | 0.439 | 0.772 | 0.551 |
| **file ranker** (files, not functions) | 0.692 | **0.944** | 0.781 |

- Against the previous ranker: function hit@10 0.759 → **0.772** (p = 0.049), file hit@10 0.925 → **0.944** (p = 0.005). MRR and hit@1 did not change significantly.

**SWE-bench Lite (291 bugs)**, the 12 projects the previous ranker was trained on:

| In-browser stage | hit@1 | hit@10 | MRR |
|---|---|---|---|
| instant | 0.289 | 0.670 | 0.420 |
| + semantic index | 0.327 | 0.673 | 0.441 |
| + MiniLM rerank | 0.299 | 0.691 | 0.430 |
| file ranker | 0.639 | 0.890 | 0.731 |

- Against the previous ranker: rerank hit@10 0.701 → 0.691 (p = 0.39, not significant); the semantic stage alone is lower, 0.701 → 0.674 (p = 0.017). Training on 131 projects bought generality to new projects, not extra accuracy on the familiar ones, and the site's default (rerank on) is no worse there.
- The full GPU pipeline still leads on Lite (0.794 hit@10): larger models, git history and a fine-tuned LLM reranker that a browser can't run.
