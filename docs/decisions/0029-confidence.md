# 0029: Telling the visitor how likely the answer is right

## Status

Accepted, 2026-10-16. The features, the model, the validation and the decision rule were fixed before any confidence data was built. The outcome is added after the test.

## Context

The website shows ten functions for every bug report with the same assurance, whether the report named the function in a stack trace or said only "the button does nothing". On the 30 unseen projects the right function is in the top 10 for about three bugs in four; a visitor cannot tell which kind of search they are looking at. PLAN.md's phase 6 (confidence-based escalation) needs the same thing: a calibrated estimate, per search, that the answer is right.

## Decision

### What is predicted

The probability that a function the fix changes is in the top 10 of the website's semantic-stage ranking: the ranking the browser computes for every search, with or without the GPU reranker, and the one the GitHub Action comments.

### Features

Ten, computed from what both engines already have for the semantic stage's candidates (their scores, sorted, and their feature rows), so the browser and Python compute them identically and a parity test holds them to each other:

1. the top score;
2. the gap between the first and second scores;
3. the gap between the first and tenth (or last) scores;
4. the first candidate's share of a softmax over the top 10 scores;
5. the entropy of that softmax;
6. log(1 + number of candidates);
7. whether any top-10 candidate is in a stack-trace frame (`frame_name` or `frame_both` above zero);
8. whether any top-10 candidate is named in the issue (`qual_mentioned` or `name_in_code` above zero);
9. whether any top-10 candidate's file or module is mentioned (`path_mentioned` or `module_mentioned` above zero);
10. log(1 + characters in the report).

### Model and validation

- Logistic regression on standardized features, L2 penalty 1.0, fitted by Newton's method in NumPy: ten weights and a bias the browser can evaluate, nothing tuned.
- Training data: the website ranker's out-of-fold semantic scores on its 7,845 training issues (six languages), from the same project-grouped five folds as the ranker's cross-validation, and the confidence model is itself cross-validated with those folds: every issue's probability comes from a model that never saw its project.
- Reported: Brier score, expected calibration error (10 equal-width bins), ROC AUC, and the observed top-10 rate in three bands shown on the site: high (p ≥ 0.8), medium (0.5 ≤ p < 0.8), low (p < 0.5).

### Decision rule

The site shows the estimate if, in cross-validation:

- AUC ≥ 0.70, and
- expected calibration error ≤ 0.05, and
- the Brier score is lower than always predicting the training base rate, with p < 0.05 (paired bootstrap over issues).

Otherwise the result is written up as negative and nothing ships. The held-out sets (Lite, the 30 unseen projects, SWE-bench Multilingual, SWE-PolyBench) are scored once with the shipped model, logged in `results/test-evals.log`, and decide nothing.

## Consequences

- The site shows the band and the probability next to the results, with a suggestion when it is low (add the stack trace, or the name of a function the report is about). The GitHub Action's comment says the same.
- The estimate is calibrated for the browser's ranking; with the GPU reranker on, the shown top 10 is usually a little better (ADR 0021), so the estimate errs on the cautious side, and the site says so.
- Phase 6's escalation (sending low-confidence searches to a stronger stage) can start from this estimate.

## Outcome

Measured 2026-10-16. Results: [cv.json](../../results/confidence/cv.json) (with the model and its provenance) and [held_out.json](../../results/confidence/held_out.json). The features came from the shipped multi-language ranker's out-of-fold scores on PACE; the model was fitted and judged on the laptop.

**The rule is met: the site and the GitHub Action show the estimate.**

Cross-validation, 7,843 issues, every probability from a model that never saw the issue's project:

| AUC | Calibration error | Brier (base rate 0.733) | High (p ≥ 0.8) | Medium | Low (p < 0.5) |
|---|---|---|---|---|---|
| 0.727 | 0.017 | 0.171, 0.025 below the base rate's, 95% interval [0.022, 0.029], p < 0.001 | 3,175 issues, 88.8% in the top 10 | 3,903, 66.8% | 765, 41.8% |

- **By language, AUC:** TypeScript 0.79, JavaScript 0.73, Python 0.73, Rust 0.70, Go 0.69, Java 0.58. The estimate separates likely hits from misses well except in Java, where it is close to a coin flip on its own; the site shows it for every language and this outcome says so.
- **Held out, scored once, decided nothing:** the bands keep their order on every set (high above medium above low: the unseen projects 88% / 63% / 40%, SWE-PolyBench 83% / 66% / 41%, SWE-bench Multilingual 84% / 61% / 27%, Lite 79% / 57% / 40%), with AUC 0.69 to 0.74. Calibration holds on the unseen projects (error 0.031) and SWE-PolyBench (0.027) but runs optimistic on the harder SWE-bench Multilingual (0.084) and Lite (0.109), where fewer bugs are found at all: there the stated percentage is a few points high. The site therefore describes the bands by what was measured, not as exact odds.
