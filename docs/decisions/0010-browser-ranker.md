# 0010: A learned ranker in the browser

## Status

Accepted. Supersedes the BM25 + MiniLM z-score fusion of [ADR 0009](0009-in-browser-search.md).

## Context

The website searches any repository in the visitor's browser. Its first pipeline, BM25 with MiniLM fused over the top 50, found a fixed function in the top 10 for 58.4% of held-out Lite issues. The server pipeline's LTR reaches 75.3%.

The server model's feature importances show that most of that gap comes from signals that need no GPU:

- the fused lexical rank;
- unit length;
- title matches;
- identifiers and traceback frames the issue names.

Git history, past issues and the 0.5B code embedder are the parts a browser cannot have.

## Decision

A two-stage LambdaMART ranker on browser-computable features. Python and TypeScript implement these features identically: `odin/rank/browser.py` and `web/src/engine/rank.ts`.

- **Stage 1: 33 features over a candidate pool, and instant.**
  - The pool is the BM25 top 100, the title and code-snippet top 20, the units of the top 5 files, and the units the issue names.
  - The features cover lexical scores and ranks for the issue, its title and its quoted code, plus file aggregates.
  - They also cover unit shape: length, method or class, private or dunder, and name ambiguity.
  - The rest are 13 mention features: traceback frames, the innermost frame, quoted names, dotted paths, and module and file mentions.
  - Stage 1 needs no model download.
- **Stage 2: stage 1's top 20, plus 5 similarity features.** It adds MiniLM similarity to the issue and to its title, and the stage-1 rank.
- **Training and tuning.** Both stages are trained on SWE-bench minus Lite (1,941 issues). Round counts come from 5-fold CV on that set, and stage 2 trains on stage 1's out-of-fold top 20.
- **Declared selection rule.** Ship stage 2 if its CV hit@10 beats stage 1's. It did: 0.770 vs 0.748. Lite was then run once.
- **Model format.** Trees are exported as flat JSON arrays, 95 KB gzipped, and served as a content-hashed asset. Thresholds are stored as the largest float32 that is no greater than LightGBM's threshold, which keeps decisions exact for float32 features.

## Results (SWE-bench Lite, held out, 291 issues with function-level gold)

| pipeline | hit@1 | hit@5 | hit@10 | MRR |
|---|---|---|---|---|
| BM25 (code-aware, no tests) | 0.206 | 0.454 | 0.546 | 0.307 |
| BM25 + MiniLM fusion (ADR 0009) | – | – | 0.584 | 0.339 |
| learned ranker, stage 1 | 0.306 | 0.595 | 0.673 | 0.431 |
| learned ranker, stage 2 (top 20) | 0.306 | 0.632 | 0.701 | 0.439 |

Stage 1 alone beats the previous semantic pipeline by 9 points of hit@10 with no model download. Visitors now get the better ranking immediately instead of after a 23 MB model loads.

## Verification

- `tests/test_site_engine.py::test_js_rank_features_match_python` runs the TypeScript ranker under Node. On the same units and issues (with tracebacks, backticks, dotted paths and file paths), it must produce the same candidates, the same 33 features and the same scores as Python.
- `scripts/browser_ltr.py` refuses to write the model unless the JSON evaluator reproduces `LightGBM.predict` on real rows.
- The browser's units are now ordered like Odin's snapshot: files in path order, units in source order. This makes rank tie-breaks match training. The IndexedDB cache key was versioned for this.

## Consequences

- Each result shows the evidence behind it ("where the traceback ends", "named in the issue").
- Stage-2 features in the browser come from transformers.js q8 or fp16 rather than fp32 sentence-transformers. That is a small numeric difference that tree splits on ranks and gaps tolerate.
- Retraining is `make web-data`: about 4 minutes of feature extraction and about 10 minutes of CPU embedding, then cached.

## Addendum: what did not help, and the depth choice

Every candidate change was screened by 5-fold CV hit@10 on the 1,941 training issues. The baseline is stage 1 at 0.748 and stage 2 at 0.770 (depth 50).

- **Text-overlap features: 0.748 → 0.753, rejected as noise.** These covered the issue's quoted error text, found as 3-grams in a unit; the issue's code identifiers used in a unit's body; and whether a unit calls a quoted name. Stage 1 already captures what exact matching offers.
- **LambdaMART settings: rejected, the current settings stay.** Six variants were screened: more leaves, a higher minimum child size, a faster learning rate, a deeper truncation level, and the XE-NDCG objective. All landed within ±0.6 points of the current settings.
- **A tiny fine-tuned cross-encoder: 0.770 → 0.775, rejected.** It was ms-marco MiniLM-L6 (22M parameters), trained listwise 2-fold on stage 1's hard negatives and used as a stage-2 feature. On its own it reached 0.649, below stage 1. It would have added 23 MB and seconds per query for noise.
- **Depth 20 instead of 50.** The rule was declared before looking: take the cheapest setting within 0.5 points of the best. Depth 20 scored 0.766 against 0.770 at depth 50, with MRR equal (0.542), for 2.5x less embedding work per query. Held-out Lite then gave 0.701 hit@10 at depth 20, against 0.698 at depth 50. Reading 128 tokens instead of 256 cost more accuracy (0.761 to 0.763) for a smaller saving.
