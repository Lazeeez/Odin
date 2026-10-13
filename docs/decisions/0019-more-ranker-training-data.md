# 0019: Train the rankers on 120 more projects

## Status

Proposed, 2026-10-14. The test and its decision rule were written before any feature for the new projects was built. The outcome section is added after the test.

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
