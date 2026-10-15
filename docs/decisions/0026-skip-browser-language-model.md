# 0026: Skipping the browser's language model when the GPU reranker answers

## Status

Accepted, 2026-10-16. The test and its decision rule were written before the semantic-stage orders were rebuilt; the outcome is below.

## Context

Since [ADR 0021](0021-website-server-reranker.md) the website's final order comes from two re-reading stages: the browser's language model (MiniLM) reorders the top 20, then the GPU reranker blends its scores into the top 50 of that order. Measured on the live site on 2026-10-16, a first visit to `pallets/flask` showed the first results after 4.4 s, and the browser's language model then took until 19.8 s: 22 MB of model and a 27 MB runtime to download, then the embedding itself. The GPU reranker's answer is blended into the language model's order, so a visitor waits for both.

The language model only reorders the top 20, so the top 50 that the GPU reranker scores are the same functions with or without it. If the GPU reranker does as well over the semantic stage's order, the browser can skip the language model whenever the GPU answers, and keep it as the fallback when the GPU is off or does not answer.

## The test

### Data

The 3,174 SWE-rebench training issues of ADR 0021, with the GPU reranker's scores already computed there (`results/website-rerank/work/scores_current.jsonl`). The semantic stage's order for each issue is rebuilt out of fold, cross-validated by project exactly as `website_rerank.py` built the language model's order. No test set is touched.

### Baseline and candidate

- **Baseline:** what the site ships since ADR 0021: the GPU reranker blended into the top 50 of the language model's order (K = 50, w = 1).
- **Candidate:** the same blend, with the same K and w, into the top 50 of the semantic stage's order.
- Nothing is tuned: K and w are the setting ADR 0021 chose.

### Decision rule

Fixed before looking:

- **Skip the browser's language model when the GPU reranker answers** if the candidate's pooled function hit@10 is at most 0.5 points below the baseline's, and the upper end of the 95% interval of the loss (paired bootstrap over issues) is under 1.0 point.
- **Otherwise** the site keeps both stages, and the time is recovered elsewhere.
- Hit@1, hit@5, MRR and recall@10 are reported and do not decide.
- The check that the two top 50s hold the same functions is reported: if they differ for any issue, the test stops and the difference is investigated first.

## Consequences

If the rule is met, a visitor with the GPU reranker on never downloads the language model unless the GPU fails, which removes about 50 MB and most of the first-search wait; visitors with it off keep today's behaviour.

## Outcome

Measured 2026-10-16. Result: [skip_language_model_current.json](../../results/website-rerank/skip_language_model_current.json). No GPU work was rerun: the semantic stage's orders were rebuilt out of fold on the laptop, and ADR 0021's scores were blended into them.

**The rule is met: the site skips the browser's language model whenever the GPU reranker answers.**

3,174 issues from 119 projects. For every issue the two top 50s held the same functions, as expected.

| GPU reranker blended into | hit@1 | hit@5 | hit@10 | MRR | recall@10 |
|---|---|---|---|---|---|
| the language model's order (since ADR 0021) | 0.500 | 0.749 | 0.819 | 0.607 | 0.526 |
| the semantic stage's order | 0.498 | 0.750 | 0.817 | 0.604 | 0.525 |

- **hit@10 (decides):** -0.25 points, 95% interval [-0.69, +0.19], p = 0.30; 21 issues better, 29 worse. Both limits of the rule hold (loss at most 0.5 points, the interval's loss end under 1 point).
- **Nothing else moves significantly:** hit@1 -0.19 (p = 0.60), hit@5 +0.13 (p = 0.74), MRR -0.24 (p = 0.23), recall@10 -0.08 (p = 0.64).
- **What changes on the site:** with the GPU reranker on, a search shows the semantic results, then the GPU's order, and the language model (22 MB of model, a 27 MB runtime, 15 s on a first visit to `django/django`) is downloaded only if the GPU does not answer. With the GPU reranker off, nothing changes.
