# Odin next to published systems

Where Odin stands on SWE-bench Lite when it is scored the way other papers score themselves. The rules for this page were fixed in [ADR 0014](decisions/0014-comparison-protocols.md) before any number was computed.

## Summary

- **At function level, the current cascade (odin-fast) is level with the best agent in the LocAgent paper and behind SweRank.** Function Acc@10 is 76.3% for Odin, 77.4% for LocAgent with Claude 3.5, and 82.1% to 88.7% for SweRank.
- **Under CoSIL's protocol, odin-fast is ahead of CoSIL, Agentless and OrcaLoca** (each with a 32B model) on nine of ten numbers, and 2.3 points behind CoSIL on function Top-1.
- **Under LocAgent's protocol, at file level Odin is behind both LocAgent and SweRank.** File Acc@1 is 69.0% against 77.7% and 83.2%.
- **Odin's reranker is far smaller.** It has 0.6 billion parameters and runs on a 6 GB laptop GPU. SweRank's rerankers have 7 and 32 billion, and its best retriever 7 billion.
- **Odin costs about a quarter of a cent per issue** on its laptop timings at a public GPU rental price, against one to two cents for SweRank's rerankers and 46 to 79 cents for the agents ([cost.md](cost.md)).
- **Every other system's row is copied from its paper**, except one: SweRankEmbed-Small was also run inside Odin's index, where it scores 8.8 points below its paper at function Acc@10.

## The protocol

LocAgent's, which SweRank reuses. Read from LocAgent's `evaluation/eval_metric.py` and re-implemented in `src/odin/eval/protocols.py`.

- 274 of the 300 Lite issues: those whose fix changes an existing function. Labels are the `edit_functions` of the `czlll/SWE-bench_Lite` dataset.
- Acc@k is all-or-nothing: an issue counts only when every gold location is in the top k.
- Three levels: file; module (a class or a top-level function); function (a method or function, with a constructor counted as its class).

## SWE-bench Lite, 274 issues, Acc@k in %

| System | Model | Source | File @1 | File @3 | File @5 | Module @5 | Module @10 | Function @5 | Function @10 |
|---|---|---|---|---|---|---|---|---|---|
| BM25 | none | reported, L4 | 38.69 | 51.82 | 61.68 | 45.26 | 52.92 | 31.75 | 36.86 |
| CodeRankEmbed | 137M | reported, L4 | 52.55 | 77.74 | 84.67 | 71.90 | 78.83 | 51.82 | 58.76 |
| Agentless | Claude 3.5 | reported, L4 | 72.63 | 79.20 | 79.56 | 68.98 | 68.98 | 58.76 | 58.76 |
| MoatlessTools | Claude 3.5 | reported, L4 | 72.63 | 85.77 | 86.13 | 76.28 | 76.28 | 64.60 | 64.96 |
| SWE-agent | Claude 3.5 | reported, L4 | 77.37 | 87.23 | 90.15 | 77.74 | 78.10 | 64.23 | 64.60 |
| OpenHands | Claude 3.5 | reported, L4 | 76.28 | 89.78 | 90.15 | 83.21 | 83.58 | 68.25 | 70.07 |
| LocAgent | Qwen2.5-7B, fine-tuned | reported, L4 | 70.80 | 84.67 | 88.32 | 81.02 | 82.85 | 64.23 | 71.53 |
| LocAgent | Qwen2.5-32B, fine-tuned | reported, L4 | 75.91 | 90.51 | 92.70 | 85.77 | 87.23 | 71.90 | 77.01 |
| LocAgent | Claude 3.5 | reported, L4 | 77.74 | 91.97 | 94.16 | 86.50 | 87.59 | 73.36 | 77.37 |
| SweRankEmbed-Small | 137M | reported, S1 | 66.42 | 86.50 | 90.88 | 79.56 | 85.04 | 63.14 | 74.45 |
| SweRankEmbed-Small | 137M | in Odin's index | 57.30 | 81.39 | 86.50 | 74.09 | 81.02 | 57.66 | 65.69 |
| SweRankEmbed-Large | 7B | reported, S1 | 72.63 | 91.24 | 94.16 | 84.31 | 89.78 | 71.90 | 82.12 |
| SweRankEmbed-Large + SweRankLLM-Small | 7B + 7B | reported, S1 | 78.10 | 92.34 | 94.53 | 89.05 | 92.70 | 79.56 | 86.13 |
| SweRankEmbed-Large + SweRankLLM-Large | 7B + 32B | reported, S1 | 83.21 | 94.89 | 95.99 | 90.88 | 93.43 | 81.39 | 88.69 |
| SweRankEmbed-Large + GPT-4.1 | 7B + API | reported, S1 | 82.12 | 95.62 | 97.08 | 93.07 | 93.43 | 81.75 | 87.96 |
| Odin: code-aware BM25 | none | scored here | 46.72 | 67.52 | 74.45 | 58.39 | 64.96 | 41.24 | 51.46 |
| Odin: + embeddings (hybrid) | 0.5B | scored here | 58.03 | 79.93 | 86.13 | 71.17 | 76.64 | 56.57 | 64.96 |
| Odin: + LambdaMART | 0.5B | scored here | 63.14 | 86.13 | 89.42 | 77.74 | 81.39 | 64.23 | 72.63 |
| **Odin: + reranker (odin-fast)** | 0.5B + 0.6B | scored here | **68.98** | **87.96** | **90.51** | **81.02** | **82.85** | **70.80** | **76.28** |

Sources:

- **L4** is Table 4 of LocAgent, [arXiv:2503.09089v2](https://arxiv.org/abs/2503.09089v2). The agent rows use Claude 3.5 Sonnet (2024-10-22); the paper also gives GPT-4o rows, omitted here.
- **S1** is Table 1 of SweRank, [arXiv:2505.07849v1](https://arxiv.org/abs/2505.07849v1). Its rerankers run on SweRankEmbed-Large's candidates.
- **In Odin's index** means the published model run through Odin's chunker, index and harness as the only retriever ([ADR 0015](decisions/0015-manifest-runs.md)): run `swerank-embed-small-lite`, imported into `results/runs/` and scored into [results/comparison/locagent-lite_swerank-embed-small_2026-10-13.json](../results/comparison/locagent-lite_swerank-embed-small_2026-10-13.json).
- **Scored here** means Odin's committed rankings (`results/*_lite_test.json`) scored by `scripts/score_protocol.py` into [results/comparison/locagent-lite_2026-10-13.json](../results/comparison/locagent-lite_2026-10-13.json). The Odin rows exclude test files from the index, as every Odin row does.

Reading the Odin rows:

- **95% intervals are wide at this size.** For odin-fast, function Acc@10 is 76.3% [71.2, 81.0] and file Acc@5 is 90.5% [86.9, 93.8]. The 1.1-point gap to LocAgent with Claude 3.5 is inside the interval; the 12.4-point gap to the best SweRank row is not. The other systems' per-issue outcomes are not available here, so no paired test was run.
- **Odin's module numbers are a lower bound.** The stored files hold ten units per issue, which can be fewer than ten distinct modules.
- **Odin's code-aware BM25 is well above the BM25 row of the papers** (function Acc@10 51.5% against 36.9%). The two differ in tokenizer, in what is indexed, and in excluding tests, so this is not a like-for-like pair.
- **Each stage adds at every level.** Function Acc@10 goes 51.5 → 65.0 → 72.6 → 76.3.

## Under CoSIL's protocol: all 300 issues, any correct location in the top N

CoSIL's evaluator, which its paper also applies to Agentless and OrcaLoca. It differs from LocAgent's in three ways: all 300 Lite issues count, an issue succeeds when any one gold location is in the top N, and functions are matched by qualified name without the file.

| System | Model | Source | File Top-1 | File Top-3 | File Top-5 | File MAP | File MRR | Func Top-1 | Func Top-3 | Func Top-5 | Func MAP | Func MRR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Agentless | Qwen2.5-Coder-32B | reported, C2 | 0.583 | 0.730 | 0.733 | 0.669 | 0.659 | 0.247 | 0.397 | 0.427 | 0.308 | 0.325 |
| OrcaLoca | Qwen2.5-Coder-32B | reported, C2 | 0.590 | 0.640 | 0.640 | 0.615 | 0.615 | 0.217 | 0.417 | 0.447 | 0.302 | 0.317 |
| CoSIL | Qwen2.5-Coder-32B | reported, C2 | 0.607 | 0.773 | 0.827 | 0.698 | 0.694 | 0.430 | 0.543 | 0.577 | 0.461 | 0.489 |
| Odin: code-aware BM25 | none | scored here | 0.457 | 0.660 | 0.723 | 0.562 | 0.562 | 0.190 | 0.317 | 0.390 | 0.257 | 0.260 |
| Odin: + embeddings (hybrid) | 0.5B | scored here | 0.583 | 0.790 | 0.850 | 0.689 | 0.689 | 0.273 | 0.430 | 0.527 | 0.372 | 0.368 |
| Odin: + LambdaMART | 0.5B | scored here | 0.627 | 0.850 | 0.883 | 0.735 | 0.735 | 0.337 | 0.530 | 0.600 | 0.430 | 0.437 |
| **Odin: + reranker (odin-fast)** | 0.5B + 0.6B | scored here | **0.690** | **0.870** | **0.893** | **0.778** | **0.778** | **0.407** | **0.583** | **0.673** | **0.500** | **0.500** |

- **C2** is Table 2 of CoSIL, [arXiv:2503.22424v1](https://arxiv.org/abs/2503.22424v1); the paper also gives 7B and 14B rows, omitted here. Odin's rows are in [results/comparison/cosil-lite_2026-10-14.json](../results/comparison/cosil-lite_2026-10-14.json).
- **odin-fast is ahead of all three at file level** (Top-1 0.690 against CoSIL's 0.607) **and at function Top-3, Top-5, MAP and MRR.** At function Top-1 it is 2.3 points behind CoSIL (0.407 [0.350, 0.463] against 0.430), which is inside the interval.
- **Odin was held to five function names per issue.** The compared systems list several names per file for up to five files, so they can have more than five chances; the direction of that difference favours them.
- **Nine issues have no function-level target** in Odin's ground truth and count as failures in Odin's function columns, as the protocol requires.
- **The three compared systems use a 32B model with several calls per issue.** The paper reports no cost per issue.

## One published model inside Odin's index

SweRankEmbed-Small was run as the only retriever over Odin's own units, with test files excluded like every Odin row.

| Retriever alone, function level | Odin's recall@10 (291 issues) | LocAgent protocol, function Acc@10 (274 issues) |
|---|---|---|
| Odin's embedding model (`dense-notests`, 0.5B) | 0.586 | not scored |
| SweRankEmbed-Small (137M), in Odin's index | 0.641 | 65.69 |
| SweRankEmbed-Small, as its paper reports it | | 74.45 |
| Odin's hybrid of BM25 and its embedding model | 0.642 | 64.96 |

- **In Odin's index the model scores 8.8 points below its paper** at function Acc@10 (65.7% [59.9, 71.2] against 74.45%). The corpus is the likely reason and has not been pinned down: Odin ranks classes as units alongside methods, prefixes each unit with its qualified name, and excludes tests, while the paper's preprocessed corpus is distributed separately and was not used here. Until the paper's own pipeline is re-run, the gap between Odin's rows and the reported rows cannot be read as a pure model difference.
- **It is a stronger retriever than Odin's embedding model**, at about a quarter of the size: recall@10 0.641 against 0.586 on the same units. It alone matches Odin's hybrid.
- **Nothing was chosen from this run.** Whether a SweRank retriever belongs in odin-max is a question for dev data.

## Cost

| System | Model | Cost per issue | Source |
|---|---|---|---|
| OpenHands | Claude 3.5 | $0.79 | reported, S5 |
| SWE-agent | Claude 3.5 | $0.67 | reported, S5 |
| LocAgent | Claude 3.5 | $0.66 | reported, L5 |
| LocAgent | Qwen2.5-32B, fine-tuned | $0.09 | reported, L5 |
| LocAgent | Qwen2.5-7B, fine-tuned | $0.05 | reported, L5 |
| SweRank reranker | GPT-4.1 | $0.16 | reported, S5 |
| SweRankLLM-Large | 32B | $0.015 | reported, S5 |
| SweRankLLM-Small | 7B | $0.011 | reported, S5 |
| Odin (odin-fast) | 0.5B + 0.6B | $0.0025, or $0.017 for the first issue on a repository | measured here: [cost.md](cost.md) |

L5 and S5 are Table 5 of each paper.

## What this means for the plan

- **"Ranking can match agents at a fraction of the cost" is already published.** SweRank makes that claim and backs it with larger models and training data mined from 3,387 projects (67,341 issue and codebase pairs before filtering). Odin cannot present it as new.
- **What Odin can still claim, if the measurements bear it out:** the same class of accuracy as the 2025 agents from models an order of magnitude smaller, on a laptop GPU; and whatever the sealed holdout shows about how each approach holds up on issues newer than its models.
- **The gap to close is known.** About 12 points of function Acc@10 and 14 points of file Acc@1 separate odin-fast from the best published ranking system. That is the target for odin-max (phase 11): its first two levers, a larger reranker and more training data, are the two things SweRank has and Odin lacks.
- **File level is the weaker side.** Odin is level with LocAgent's best row at function level but 3.7 points behind it at file Acc@5 and 8.8 at file Acc@1.

## Not done yet

- **No baseline has been reproduced with its authors' pipeline.** SweRank's preprocessed corpora are distributed outside its repository; re-running its own scripts on them is the next step, and the 7B and 32B models need the cluster.
- **Other protocols.** Agentless and OrcaLoca also report match rates in their own papers, on their own subsets; only CoSIL's evaluation of them is implemented here.
- **Loc-Bench**, the non-SWE-bench benchmark both papers also report on (560 issues), belongs to phase 5.
- **A deeper Odin run** to replace the module lower bound.
