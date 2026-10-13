# 0018: Put the file path in the text that is embedded

## Status

Not adopted, 2026-10-14. Path-aware embeddings passed the retriever test on dev and did not pass the cascade test on validation. Both rules were written before their tests ran; the outcomes were added after.

## Context

Odin embeds each function or class as its qualified name followed by its source. The file path is left out on purpose: the embedding is keyed by the content of the unit, so a function that is identical in a hundred commits, or that moves between files, is embedded once ([ADR 0005](0005-dense-hybrid-retrieval.md)).

Reproducing SweRank showed what that costs a retriever. SweRankEmbed-Small, on its authors' corpus, scores 74.82% function Acc@10 on SWE-bench Lite. Each document there begins with `path/to/file.py/Class/method`. With that first line replaced by `Class.method`, and nothing else changed, the same model on the same corpus scores 64.96%: ten points lower, and file Acc@1 falls from 67.2% to 57.3%. Inside Odin's own index the model scores 65.69% and 57.3%. Input length was tested and is not the cause: cutting issues and functions from 1,024 tokens to 512 leaves the score at 74.82%.

Issues name files, modules and packages. An embedding that has never seen the path cannot use that.

That evidence is for another model on a test set. Whether it holds for Odin's embedding model, and whether it survives fusion with BM25, which already scores path terms, is not known.

## The test

One variant, chosen before running, with no search over formats:

- **Text.** The first line of each embedded unit becomes `path/to/file.py/Class/method`, the form the evidence is for. The source lines are unchanged.
- **Key.** The embedding key becomes the hash of that header and the unit's content hash, so a unit is embedded once per path it appears at.
- **Everything else is as it is:** the same embedding model, prompts, input lengths, fusion parameters and BM25.
- **Data.** The dev set, SWE-bench Verified minus Lite (407 issues). The embedding model was not trained on it. The fusion parameters were tuned on it for the current text, which favours the current text if anything.
- **Runs.** `dense-notests` and `hybrid-notests` against `dense-path-notests` and `hybrid-path-notests`, at function and file level.

### Decision rule

Fixed before looking:

- **Adopt as a candidate for odin-fast** if `hybrid-path-notests` beats `hybrid-notests` on function-level recall@10 in a paired bootstrap at p < 0.05, and is not significantly worse on file-level recall@10.
- **Otherwise it is recorded as a negative result** and nothing changes.
- Dense-only numbers are reported either way; they do not decide.
- Adopting it as a candidate does not change odin-fast by itself. The rankers and the reranker were trained on features from the current embeddings, so the next step would be to rebuild the features, retrain both rankers, and compare the whole cascade on the validation split.

### Cost to report

- Units embedded with paths against units embedded without, on the dev set: the price of giving up pure content addressing.
- Lite is not touched by this test.

## Consequences if adopted

- A function that is identical at two paths is embedded twice. Moves and copies are a small share of units; the measured count goes in the outcome.
- The content-addressed store stays for the current rows, so every published result remains reproducible.

## Outcome

Dev set, 407 issues (393 with a function-level target). Result files are in `results/dev-path/`; the paired bootstrap is `odin compare`, 10,000 resamples.

| Function level | recall@1 | recall@5 | recall@10 | hit@10 | MRR |
|---|---|---|---|---|---|
| `dense-notests` | 0.246 | 0.461 | 0.554 | 0.667 | 0.436 |
| `dense-path-notests` | 0.250 | 0.486 | 0.574 | 0.687 | 0.451 |
| `hybrid-notests` | 0.288 | 0.544 | 0.628 | 0.738 | 0.492 |
| `hybrid-path-notests` | 0.306 | 0.566 | 0.660 | 0.768 | 0.512 |

| File level | recall@1 | recall@5 | recall@10 | hit@10 | MRR |
|---|---|---|---|---|---|
| `dense-notests` | 0.514 | 0.819 | 0.898 | 0.934 | 0.689 |
| `dense-path-notests` | 0.538 | 0.828 | 0.919 | 0.951 | 0.719 |
| `hybrid-notests` | 0.560 | 0.851 | 0.924 | 0.953 | 0.736 |
| `hybrid-path-notests` | 0.595 | 0.867 | 0.929 | 0.961 | 0.764 |

| Paired comparison, with path against without | Difference | 95% interval | p | Wins / losses |
|---|---|---|---|---|
| hybrid, function recall@10 (the deciding test) | +0.032 | [+0.013, +0.052] | 0.001 | 26 / 13 |
| hybrid, file recall@10 (must not be worse) | +0.005 | [-0.006, +0.018] | 0.391 | 6 / 6 |
| hybrid, function MRR | +0.020 | [+0.006, +0.035] | 0.004 | 67 / 38 |
| hybrid, file MRR | +0.028 | [+0.011, +0.046] | 0.002 | 61 / 34 |
| dense, function recall@10 | +0.019 | [-0.004, +0.044] | 0.108 | 27 / 19 |
| dense, function MRR | +0.016 | [-0.004, +0.036] | 0.112 | 64 / 54 |
| dense, file recall@10 | +0.021 | [+0.003, +0.039] | 0.018 | 16 / 7 |
| dense, file MRR | +0.031 | [+0.011, +0.051] | 0.002 | 76 / 44 |

Eight tests were run; two were the declared deciding ones.

- **The rule is met.** With the path, the hybrid retriever gains 3.2 points of function recall@10 (p = 0.001) and is not worse at file level. Path-aware embedding becomes a candidate for odin-fast.
- **The gain is a third of what the same change is worth to SweRank's model.** That model lost ten points without the path; Odin's embedding model gains two alone (not significant) and the hybrid three. BM25 already scores path terms, which is the likely reason.
- **It survives fusion,** which was the open question: the hybrid gains more than the embedding model alone.
- **The cost is 2.1% more embeddings.** The dev snapshots hold 176,610 distinct units by content and 180,372 by content and path.

### What happens next, and what does not

- Nothing in odin-fast changes yet. The rankers and the reranker were trained on features from embeddings without paths.
- The next step is to rebuild the ranking features with path-aware embeddings, retrain the two LambdaMART rankers into new model files, and compare the whole cascade with the current one on the validation split. Only that comparison decides whether odin-fast adopts it.
- The fusion parameters were tuned for embeddings without paths and were left alone here. Re-tuning them on dev belongs to the same step.

## The cascade test on validation

Written on 2026-10-14, before the path-aware rankers were trained.

- **Fusion re-tuned first.** The same grid and rule as the original tuning (`odin tune --what fusion`, best function recall@10 on dev) were run with path-aware embeddings. The same setting wins, a z-score sum with weight 0.8 on the embedding score (recall@10 0.660), so the fusion parameters stay as they are.
- **Rankers.** The 52 features are rebuilt over the training issues (SWE-bench test minus Lite) with path-aware embeddings, and both LambdaMART rankers are trained with the unchanged settings into `models/paths/`. The shipped rankers are not touched.
- **Reranker.** The two adapters are used as they are, with the shipped depth and blend weights. They were trained on candidates from the current retriever; that favours the current cascade if anything.
- **Data.** The 250 validation issues the reranker never saw. For each variant the function ranker is retrained without those issues, as in the error analysis.
- **What is compared.** The current cascade against the path-aware cascade, at function level, after the ranker and after the reranker.

### Decision rule

- **odin-fast adopts path-aware embeddings** if the full path-aware cascade beats the current one on function recall@10 in a paired bootstrap at p < 0.05 and is not significantly worse on MRR.
- **Otherwise it is not adopted** and stays recorded as a retriever-level gain that did not carry through the cascade.
- Hit@10, all@10 and the ranker-only comparison are reported and do not decide.
- Adoption would still mean retraining the final rankers on all training issues and, separately, deciding whether the reranker should be retrained on the new candidates. Nothing is evaluated on Lite or the holdout as part of this test.

### Outcome of the cascade test

250 validation issues, function level. Result files are in `results/validation-path/`. The path-aware rankers are in `models/paths/`.

| | recall@1 | recall@10 | hit@10 | all@10 | MRR |
|---|---|---|---|---|---|
| Current cascade, after the ranker | 0.277 | 0.663 | 0.812 | 0.560 | 0.554 |
| Path-aware, after the ranker | 0.282 | 0.668 | 0.824 | 0.564 | 0.570 |
| Current cascade, after the reranker | 0.316 | 0.663 | 0.816 | 0.564 | 0.619 |
| Path-aware, after the reranker | 0.315 | 0.676 | 0.832 | 0.572 | 0.617 |

| Paired comparison, path-aware against current | Difference | 95% interval | p | Wins / losses |
|---|---|---|---|---|
| full cascade, recall@10 (the deciding test) | +0.014 | [-0.005, +0.035] | 0.164 | 10 / 9 |
| full cascade, MRR (must not be worse) | -0.002 | [-0.018, +0.014] | 0.839 | 27 / 17 |
| full cascade, hit@10 | +0.016 | [-0.004, +0.040] | 0.195 | 6 / 2 |
| full cascade, all@10 | +0.008 | [-0.012, +0.032] | 0.587 | 5 / 3 |
| full cascade, recall@1 | -0.002 | [-0.018, +0.015] | 0.837 | 3 / 5 |
| after the ranker, recall@10 | +0.005 | [-0.026, +0.037] | 0.744 | 17 / 18 |
| after the ranker, MRR | +0.016 | [-0.007, +0.040] | 0.171 | 47 / 33 |
| after the ranker, hit@10 | +0.012 | [-0.020, +0.044] | 0.545 | 10 / 7 |
| after the ranker, all@10 | +0.004 | [-0.032, +0.040] | 0.897 | 11 / 10 |
| after the ranker, recall@1 | +0.006 | [-0.020, +0.032] | 0.687 | 13 / 10 |

Ten tests were run; two were the declared deciding ones.

- **The rule is not met.** The full path-aware cascade is 1.4 points ahead on recall@10, and that is not significant (p = 0.164). odin-fast does not adopt it.
- **The retriever's gain mostly disappears by the end of the cascade.** Three points of recall@10 at the hybrid stage become half a point after the ranker and 1.4 after the reranker. The ranker already has features computed from the path, and the candidate pool already held a correct function for 97% of these issues, so better retrieval had little left to add here.
- **Every difference points the same way except two that are flat,** and none is significant at 250 issues. This is a result the test could not resolve, not evidence that the path hurts.
- **Familiar projects.** The validation issues come from projects the rankers trained on. On unseen projects the ranker's path features may carry less and the retriever more; that was not tested.

### What is kept

- The path-aware mode (`src/odin/search/path_aware.py`, `--paths`), the rankers in `models/paths/` and every result file stay in the repository.
- The finding stands for the comparison with SweRank: a retriever evaluated without paths is understated by about ten points for that model and two to three for Odin's.
- It can be looked at again where it is more likely to matter: with more training data, on the unseen-project set's validation folds, or for odin-max. Each would need its own rule written first.
