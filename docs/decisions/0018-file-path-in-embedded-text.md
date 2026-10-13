# 0018: Put the file path in the text that is embedded

## Status

Accepted as a candidate for odin-fast, 2026-10-14. The test and its decision rule below were written before the test ran; the outcome section was added after it.

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
