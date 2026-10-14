# 0019: Train the rankers on 120 more projects

## Status

Accepted, 2026-10-14: the larger training set is adopted for odin-fast. The test and its decision rule were written before any feature for the new projects was built; the outcome section was added after the test.

## Context

The error analysis ([docs/error-analysis.md](../error-analysis.md)) found that the LambdaMART ranker loses more validation issues than retrieval and the reranker together: in 26 of 46 misses a correct function was in the candidate pool and the ranker put it below 20th. The ranker is also the stage trained on the least varied data: 1,941 issues from the twelve SWE-bench projects.

The website's rankers were already retrained on 120 more projects from SWE-rebench ([ADR 0011](0011-website-at-scale.md)). The full pipeline's rankers never were. The 3,289 issues of those 120 projects have ground truth in the repository (`data/gold/swebench_rebench_train.jsonl`); 3,174 of them have a function-level target. None of them is in Lite, in the 30 unseen projects, in the holdout or in the post-cutoff set.

More data costs nothing at query time, so it fits odin-fast.

## The test

- **Training data.** The current set (SWE-bench test minus Lite) plus the SWE-rebench training projects. The 52 features, the candidate pool, the LambdaMART settings and the way the round count is chosen (5-fold cross-validation by NDCG@10) are unchanged.
- **One addition to a feature's input, declared here.** The "similar earlier issues" features look up earlier fixed issues of the same project. Their memory holds SWE-bench issues only, so for a SWE-rebench issue they would always be empty. The SWE-rebench training issues get a memory of their own, built the same way. Each query still sees only issues of its own project opened before it. The SWE-bench memory is left exactly as it is, so the existing SWE-bench features are reused unchanged.
- **Models** go to `models/more-data/`. The shipped rankers are not touched.
- **The reranker** is used as it is.

Two questions, two tests:

1. **Does it hurt on familiar projects?** The 250 validation issues, with each ranker retrained without them, through the full cascade, as in [ADR 0018](0018-file-path-in-embedded-text.md).
2. **Does it help on projects the ranker has not seen?** Five folds of whole SWE-rebench training projects. For each fold, a ranker trained on SWE-bench plus the other four folds is compared, on the held-out fold's issues, with a ranker trained on SWE-bench alone. Ranker stage, function level. This is the situation the unseen-project claim is about, measured without touching the 30 unseen projects.

### Decision rule

Fixed before looking:

- **odin-fast adopts the larger training set** if, on test 2, function recall@10 is better at p < 0.05 in a paired bootstrap over the held-out issues, and, on test 1, the full cascade is not significantly worse on function recall@10 or MRR.
- **Otherwise it is not adopted.**
- Hit@10, all@10, recall@1, the file level and the ranker-only stage of test 1 are reported and do not decide.
- The 30 unseen projects, Lite and the holdout are not evaluated as part of this.

### What adoption would and would not mean

- The final rankers would be retrained on everything, into `models/more-data/`, and odin-fast would use them when it is frozen.
- The reranker's depth and blend weights were chosen against the current ranker's scores; they would be chosen again on validation by the existing rule.
- Whether the reranker itself should train on the new projects is a separate lever with its own test.

## Cost to report

Units embedded for the new projects, GPU time for embedding and feature extraction, and the size of the new feature files.

## Outcome

Result files are in `results/more-data/`; the new rankers are in `models/more-data/`.

### Test 2: projects the ranker has not seen (the first half of the rule)

Five folds of whole projects, 119 projects, ranker stage. A ranker trained on SWE-bench plus the other four folds, against one trained on SWE-bench alone, on the held-out fold.

| Function level, 3,174 issues | recall@1 | recall@10 | hit@10 | all@10 | MRR |
|---|---|---|---|---|---|
| Trained on SWE-bench alone | 0.212 | 0.536 | 0.824 | 0.354 | 0.594 |
| Also trained on the other projects | 0.216 | 0.543 | 0.826 | 0.365 | 0.601 |

| File level, 3,261 issues | recall@1 | recall@10 | hit@10 | all@10 | MRR |
|---|---|---|---|---|---|
| Trained on SWE-bench alone | 0.459 | 0.818 | 0.960 | 0.663 | 0.816 |
| Also trained on the other projects | 0.456 | 0.828 | 0.964 | 0.676 | 0.816 |

| Paired comparison | Difference | 95% interval | p | Wins / losses |
|---|---|---|---|---|
| function recall@10 (the deciding test) | +0.007 | [+0.003, +0.012] | 0.002 | 307 / 217 |
| function MRR | +0.008 | [+0.002, +0.013] | 0.008 | 443 / 353 |
| function all@10 | +0.010 | [+0.005, +0.016] | < 0.001 | 61 / 28 |
| function hit@10 | +0.002 | [-0.004, +0.008] | 0.580 | 56 / 50 |
| function recall@1 | +0.005 | [-0.001, +0.010] | 0.096 | 117 / 99 |
| file recall@10 | +0.010 | [+0.007, +0.014] | < 0.001 | 186 / 93 |
| file all@10 | +0.013 | [+0.007, +0.019] | < 0.001 | 70 / 28 |
| file hit@10 | +0.004 | [+0.001, +0.007] | 0.016 | 21 / 8 |
| file MRR | 0.000 | [-0.004, +0.004] | 0.968 | 193 / 162 |
| file recall@1 | -0.002 | [-0.007, +0.003] | 0.365 | 59 / 69 |

### Test 1: the full cascade on validation (the second half of the rule)

250 validation issues, function level, each ranker retrained without them.

| | recall@1 | recall@10 | hit@10 | all@10 | MRR |
|---|---|---|---|---|---|
| Current ranker | 0.277 | 0.663 | 0.812 | 0.560 | 0.554 |
| Larger-data ranker | 0.290 | 0.651 | 0.796 | 0.548 | 0.560 |
| Current ranker, then the reranker | 0.316 | 0.663 | 0.816 | 0.564 | 0.619 |
| Larger-data ranker, then the reranker | 0.315 | 0.680 | 0.844 | 0.580 | 0.617 |

| Paired comparison, larger-data against current | Difference | 95% interval | p | Wins / losses |
|---|---|---|---|---|
| full cascade, recall@10 (must not be worse) | +0.018 | [-0.001, +0.038] | 0.068 | 13 / 6 |
| full cascade, MRR (must not be worse) | -0.002 | [-0.015, +0.011] | 0.804 | 22 / 20 |
| full cascade, hit@10 | +0.028 | [+0.004, +0.052] | 0.023 | 8 / 1 |
| full cascade, all@10 | +0.016 | [-0.004, +0.040] | 0.207 | 6 / 2 |
| full cascade, recall@1 | -0.002 | [-0.017, +0.013] | 0.867 | 3 / 4 |
| after the ranker, recall@10 | -0.012 | [-0.034, +0.009] | 0.256 | 7 / 15 |
| after the ranker, MRR | +0.007 | [-0.012, +0.025] | 0.490 | 32 / 33 |
| after the ranker, hit@10 | -0.016 | [-0.040, +0.008] | 0.259 | 3 / 7 |
| after the ranker, all@10 | -0.012 | [-0.040, +0.012] | 0.446 | 4 / 7 |
| after the ranker, recall@1 | +0.013 | [-0.010, +0.038] | 0.303 | 8 / 6 |

Twenty tests were run across the two; three were the declared deciding ones.

- **The rule is met.** On unseen projects, function recall@10 is better (p = 0.002). On validation, the full cascade is not worse on recall@10 (+1.8 points, p = 0.068) or on MRR (-0.2 points, p = 0.80).
- **The gain on unseen projects is real and small:** under one point of recall@10 at function level and one point at file level. It is significant because there are more than three thousand issues.
- **On familiar projects the ranker alone is slightly lower and the cascade slightly higher.** Neither is significant. One reading is that the larger-data ranker leaves the reranker a better top 20 on these projects even where its own top 10 is no better; that was not tested.
- **Hit@10 of the full cascade rises 2.8 points on validation (p = 0.023).** It was not a deciding test, and with twenty tests run, one at that level is not surprising. It is not claimed.

### Cost

475,737 units embedded for the new projects and 1.8 hours of GPU for embedding and feature extraction on the laptop's RTX 4050; 62 MB of feature files, kept out of the repository. The new function ranker has 969 rounds against 584, which changes nothing measurable at query time: the ranker stage is 4 ms of an 8.8 s query.

### What follows

- odin-fast's rankers are the ones in `models/more-data/` from now on. The shipped `models/ltr_*.txt` stay as they are until odin-fast is frozen, so every published row still reproduces.
- The reranker's depth and blend weights are chosen again on validation against the new ranker's scores, by the existing rule.
- Lite, the 30 unseen projects and the holdout were not evaluated.
