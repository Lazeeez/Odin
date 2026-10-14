# 0020: odin-max, lever 1: a larger reranker trained on more data

## Status

Proposed, 2026-10-15. The test and its decision rule were written before any training data was built. The outcome section is added after the test.

## Context

odin-max is the operating point with no cost limit (PLAN.md, phase 11). Its levers are taken in the order the error analysis ranks them ([docs/error-analysis.md](../error-analysis.md)):

- the LambdaMART ranker leaves a correct function between 21st and 50th place in 17 of the 46 validation misses, out of the current reranker's reach;
- the reranker itself is 0.6B parameters and trained on 1,691 issues from twelve projects;
- SweRank, reproduced on PACE, reaches 88.7% function Acc@10 on Lite with a 7B retriever and a 32B reranker, against odin-fast's 76.3% ([docs/comparison.md](../comparison.md)).

The owner accepted CC-BY-NC components for odin-max and set this lever as the first.

## The test

### What changes

- **Base model.** `Qwen/Qwen3-Reranker-4B` instead of the 0.6B one, with the same LoRA recipe, prompt, input lengths and listwise loss.
- **Training data.** SWE-bench test minus Lite and minus the 250 validation issues, plus the SWE-rebench training projects, minus one held-out fold of those projects (below). Hard negatives are the top candidates of a LambdaMART ranker that never saw the issue: out-of-fold predictions of the larger-data ranker ([ADR 0019](0019-more-ranker-training-data.md)), 20 per issue, as in the current recipe.
- **Depth.** The reranker sees the ranker's top 20 or top 50. The depth and blend weight are chosen on validation by the existing rule (function MRR); 50 is added to the grid.
- **Everything before the reranker is odin-fast's**: the hybrid retriever, the 52 features and the larger-data rankers.
- **One model, not an ensemble.** The current reranker is two 0.6B adapters; the comparison is against that ensemble as shipped.

### The held-out fold

The fifth of the 119 SWE-rebench training projects that ADR 0019's seeded split calls fold 0 is held out of everything in this test: the ranker that feeds the reranker is retrained without it, and the reranker never trains on it. Its issues measure the new reranker on projects no stage has seen. After the test, the final model may be trained on everything.

### Where it runs

The laptop builds every candidate list and its texts (ranker scores, unit texts, gold labels) and writes them to files; PACE only trains the reranker and scores those lists; the laptop computes every metric. No PACE job sees a gold label at scoring time, and nothing is evaluated on Lite, the 30 unseen projects or the holdout.

### Decision rule

Fixed before looking:

- **odin-max adopts the 4B reranker** if, on the held-out fold, the full cascade's function recall@10 is better than with the current reranker at p < 0.05 in a paired bootstrap, and on the 250 validation issues it is not significantly worse on function recall@10 or MRR.
- Depth is not a separate decision: whichever depth the existing rule chooses on validation is the one tested.
- Hit@10, all@10, recall@1, MRR on the fold, and the file level are reported and do not decide.
- **If it is adopted**, the 8B base is the next step, under the same rule against the 4B one.
- **If it is not**, it is written up as a negative result, and the next lever in the error analysis's order is taken instead.

### A second candidate: full fine-tuning

Added on 2026-10-15, before any training data for this test existed and before either candidate was trained.

- **What differs.** Every weight of the 4B model is updated, instead of a LoRA adapter of rank 16. Learning rate 1e-5 instead of 1e-4, the usual tenfold reduction for full fine-tuning; weights, gradients and optimizer state in bf16 to fit one H100. Same data, epochs, group size, loss and prompt.
- **How it is compared.** Each candidate gets its own depth and weight from validation by the existing rule. Each is tested against the current reranker by the rule above. If both pass, the one with the higher function recall@10 on the held-out fold is adopted, and the difference between them is tested and reported; if that difference is not significant, LoRA is preferred, because its adapter is about a hundred times smaller to store and ship (tens of megabytes against 8 GB).
- **Why it might not help.** With about 4,000 training issues, full fine-tuning can overfit where LoRA does not. The test decides.

### Cost to report

Training GPU-hours, the GPU, scoring time per issue at each depth, and the dollar cost per issue at the public price of that GPU, so the result can go on the accuracy-against-cost chart.

## Outcome

Measured 2026-10-15. Results: [lever1_max-4b-lora.json](../../results/odin-max/lever1_max-4b-lora.json), [lever1_max-4b-full.json](../../results/odin-max/lever1_max-4b-full.json), [lever1_lora_vs_full.json](../../results/odin-max/lever1_lora_vs_full.json). All three rerankers were scored on PACE H100s from the same candidate lists; the current one is the two shipped 0.6B adapters.

**Both candidates pass the rule, and the 4B LoRA adapter is adopted for odin-max.**

Held-out fold, 608 issues from projects no stage had seen, function level:

| | recall@10 | MRR | hit@1 | hit@10 | all@10 |
|---|---|---|---|---|---|
| current (two 0.6B adapters) | 0.520 | 0.600 | 0.492 | 0.814 | 0.344 |
| 4B LoRA | 0.538 | 0.649 | 0.556 | 0.817 | 0.359 |
| 4B full fine-tuning | 0.542 | 0.641 | 0.548 | 0.824 | 0.364 |

| Paired bootstrap, against current | recall@10 (decides) | MRR | recall@1 |
|---|---|---|---|
| 4B LoRA | +0.018, p = 0.018 | +0.050, p < 0.001 | +0.044, p < 0.001 |
| 4B full fine-tuning | +0.022, p < 0.001 | +0.041, p < 0.001 | +0.034, p < 0.001 |

Validation, 250 issues: neither is worse. LoRA: recall@10 +0.019 (p = 0.12), MRR +0.048 (p = 0.001). Full: recall@10 +0.014 (p = 0.14), MRR +0.056 (p < 0.001).

- **Full fine-tuning against LoRA is not significant** on any metric (fold recall@10 +0.005, p = 0.30; MRR -0.009, p = 0.24), so by the rule LoRA is preferred: tens of megabytes to ship instead of 8 GB.
- **Depth 50 was not chosen.** Validation chose depth 20 and weight 2.0 for every reranker, so the 17 misses the error analysis found between 21st and 50th are not reached by this lever.
- **The gain is at the top of the list, not in the top 10.** First place improves by about six points; hit@10 does not move significantly. A larger reranker reorders what the ranker already found; it does not find more.
- **Training cost:** 8,514 steps on one H100, about 58 minutes for LoRA and 48 for full fine-tuning (from the logged step rates). Per-issue scoring time was not measured separately in these jobs; it is measured with the cost benchmark before the result goes on the cost chart.
- **Next**, by the rule, is the 8B base against the 4B LoRA. odin-max work is paused while the website is the priority (2026-10-15).
