# 0021: Does the fine-tuned reranker improve the website?

## Status

Proposed, 2026-10-15. The test and its decision rule were written before any candidate list was built. The outcome section is added after the test.

## Context

The website (allfather.dev) runs everything in the visitor's browser: Tree-sitter parsing, BM25, a static embedding model, LambdaMART rankers and a MiniLM rerank stage ([ADR 0011](0011-website-at-scale.md)). On the 30 projects it never trained on, the MiniLM stage adds nothing (function hit@10 0.7724 before and after it). The full pipeline's fine-tuned reranker (two LoRA adapters on Qwen3-Reranker-0.6B, [ADR 0007](0007-fine-tuned-cross-encoder.md)) is the strongest stage Odin has, but it does not fit in a browser:

| In the browser, measured 2026-10-15 | Download | 20 candidates | 50 candidates |
|---|---|---|---|
| Intel integrated graphics, gen-12lp (what Chrome and Edge chose on a Windows laptop) | 433 MB (4-bit) | 57 s | 139 s |
| RTX 4050 laptop GPU, 4-bit | 433 MB | 6.7 s | 15 s |
| RTX 4050 laptop GPU, 8-bit | 653 MB | 10.2 s | 24.6 s |

The 4-bit export also moves scores by up to 4 logits. (`scripts/export_browser_reranker.py`; onnxruntime-web 1.30, WebGPU.)

The alternative is a small server that receives the issue and the website's top candidates (a few kilobytes), runs the reranker on a GPU and returns their scores; everything else stays in the browser, and the browser's own ranking is shown first and kept if the server does not answer. It would run on a free tier (Modal's monthly credits), so it costs nothing, but it adds a moving part to a site that has none. This test decides whether the gain is worth that.

## The test

### Data

The SWE-rebench training issues of the 119 projects the website's rankers train on, with a function-level target. The reranker's adapters were trained on SWE-bench only, so none of these issues or projects was seen by the reranker. SWE-bench issues are excluded: the adapters trained on them.

The website's scores for each issue are out of fold: the instant, semantic and rerank stages are cross-validated by project exactly as `scripts/browser_ltr.py` does when it trains the shipped rankers, so every issue is ranked by models that never saw its project.

### Baseline and candidate

- **Baseline:** the website's final order, as shipped (the rerank stage over the semantic stage's top 20, the semantic order below).
- **Candidate:** the reranker ensemble as the full pipeline runs it (both adapters, bf16, z-scored and averaged), applied to the top K of the website's order and blended with it: `z(base) + w * z(reranker)` over those K, where `base` is minus the log of the website's rank (1-based, plus one). Below K the website's order is kept.
- K is 20 or 50; w is one of 0.25, 0.5, 1, 2, 4 or the reranker alone.

### Choosing K and w without fooling ourselves

The 119 projects are split in two by a seeded random split. K and w are chosen on one half by function hit@10 and applied to the other, then the other way round. Every issue is scored with a setting chosen on projects it is not in, and the results are pooled.

### Decision rule

Fixed before looking:

- **Build the server** if pooled function hit@10 improves by at least 2.0 points with p < 0.05 in a paired bootstrap. A smaller gain does not justify a server on a site that otherwise has none.
- **Otherwise** the result is written up as a negative result, and the website's accuracy work moves to what runs in the browser.
- Hit@1, hit@5, MRR, recall@10 and all@10, and each half's chosen setting, are reported and do not decide.

### What is not touched

Lite, the 30 unseen projects, the sealed holdout and the post-cutoff set are not evaluated. If the server is built, the website's final configuration is scored once on Lite and the 30 unseen projects, and those runs are logged in `results/test-evals.log`.

### Where it runs

The laptop builds the candidate lists (website order, unit texts and gold) into `results/website-rerank/work/`; PACE scores them with `scripts/odin_max.py score` and never sees a label at scoring time; the laptop computes every metric.

## Outcome

Measured 2026-10-15. Result: [server_reranker_current.json](../../results/website-rerank/server_reranker_current.json). PACE scored the candidate lists with the two shipped 0.6B adapters; the laptop computed every metric.

**The rule is met: the server is built.**

3,174 issues from 119 projects, every issue ranked with a setting chosen on the other half of the projects, function level:

| | hit@1 | hit@5 | hit@10 | MRR | recall@10 | all@10 |
|---|---|---|---|---|---|---|
| website, as shipped | 0.443 | 0.708 | 0.793 | 0.557 | 0.503 | 0.328 |
| website with the server reranker | 0.500 | 0.749 | 0.819 | 0.607 | 0.526 | 0.345 |

| Paired bootstrap | delta | 95% CI | p | issues won / lost |
|---|---|---|---|---|
| hit@10 (decides) | +0.026 | [0.018, 0.034] | < 0.001 | 134 / 52 |
| hit@1 | +0.057 | [0.044, 0.071] | < 0.001 | 351 / 169 |
| MRR | +0.050 | [0.041, 0.058] | < 0.001 | 783 / 404 |
| recall@10 | +0.023 | [0.017, 0.030] | < 0.001 | 499 / 294 |
| all@10 | +0.017 | [0.009, 0.026] | < 0.001 | 118 / 63 |

- **Both halves chose the same setting:** the top 50 of the website's order, blended with equal weight (K = 50, w = 1). It is the setting the server uses.
- **The gain clears the 2-point bar, but the interval reaches below it** (lower bound 1.8 points). The rule asked for the point estimate and p, and both are met; the interval is reported so the margin is not overstated.
- **The reranker alone is worse than the blend** (K = 50, reranker alone: hit@10 0.752 and 0.770 on the two choosing halves, against 0.814 and 0.824 blended): the website's order carries signal the reranker does not.
- **The largest gain is at the top of the list:** first place improves by almost six points, as it did for odin-max ([ADR 0020](0020-odin-max-larger-reranker.md)).
- **Next:** the server runs the two 0.6B adapters on Modal's free credits, scoring at most 50 candidates per search; the browser shows its own order first and keeps it if the server does not answer. Once built, the website's final configuration is scored once on Lite and the 30 unseen projects, and both runs are logged in `results/test-evals.log`.

## The held-out run, defined 2026-10-16

Written before the candidate lists were built. Since ADR 0021's outcome the site changed in three ways: it ranks six languages with a retrained ranker ([ADR 0025](0025-more-languages.md), [ADR 0027](0027-rust-test-modules.md)), and the GPU reranker is blended into the semantic stage's order, without the browser's language model ([ADR 0026](0026-skip-browser-language-model.md)). The one held-out run scores what the site runs after those changes:

- **Sets:** SWE-bench Lite (291 issues with a function to find) and the 30 unseen projects (747), each once.
- **Ranker:** the multi-language ranker that ships after ADR 0027's retrain, applied to the same cached candidates the training run scored.
- **Compared:** the website without the GPU (the semantic stage's order) and with it (the reranker's two adapters blended into that order's top 50, K = 50, w = 1, as chosen in this ADR's test).
- **Reported:** function hit@1, hit@5, hit@10, MRR and recall@10 for both, and the paired bootstrap of the difference per set. Nothing is decided from it: the server is already built and its setting fixed. Both runs are logged in `results/test-evals.log`.

## The held-out run, 2026-10-16

Result: [heldout_heldout.json](../../results/website-rerank/heldout_heldout.json), scored once as defined above with the ranker that shipped after ADR 0027, and logged in `results/test-evals.log`. Nothing was decided from it.

| Function level | Issues | Website without the GPU (hit@10) | With the GPU reranker | hit@10 change | hit@1 change |
|---|---|---|---|---|---|
| SWE-bench Lite | 291 | 67.0% | 73.5% | +6.5 points, 95% interval [3.4, 10.0], p < 0.001; 21 issues better, 2 worse | +5.8, [1.4, 10.3], p = 0.013 |
| The 30 unseen projects | 747 | 76.6% | 79.3% | +2.7 points, [1.1, 4.3], p = 0.002; 30 better, 10 worse | +7.4, [4.6, 10.2], p < 0.001 |

The cross-validated gain (+2.6 points) holds on projects nothing was trained on, and is larger on Lite.
