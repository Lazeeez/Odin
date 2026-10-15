# 0026: Skipping the browser's language model when the GPU reranker answers

## Status

Proposed, 2026-10-16. The test and its decision rule were written before the semantic-stage orders were rebuilt. The outcome section is added after the test.

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
