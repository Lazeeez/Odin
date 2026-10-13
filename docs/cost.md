# What the cascade costs

How long the full cascade (odin-fast) takes per issue, stage by stage, and what that is in dollars next to published systems. Measured on 2026-10-13.

## Summary

- **8.8 seconds per issue on a laptop GPU**, median 3.5 seconds, once a repository is indexed.
- **The reranker is 96% of it.** Retrieval, features and the LambdaMART ranker together take about a third of a second.
- **About a quarter of a cent per issue** at a public GPU rental price, and under two cents for the first issue on a repository, which also pays for embedding its functions.
- **That is roughly 4 times cheaper than the cheapest published ranking system and 270 times cheaper than the agents**, at an accuracy level with the best agent in the LocAgent paper and 12 points below the best ranking system. The dollar comparison rests on assumptions listed below.

![Function Acc@10 against cost per issue on SWE-bench Lite. Odin sits at a quarter of a cent and 76%; SweRank's rerankers at one to two cents and 86 to 89%; agents with Claude 3.5 at 46 to 79 cents and 65 to 77%.](img/cost-accuracy.svg)

The numbers behind the chart are in the two tables below and in [the comparison](comparison.md).

## Time per issue, by stage

All 291 Lite issues with a function target, on one laptop: Core i5-13420H, 32 GB, RTX 4050 Laptop GPU (6 GB), Windows 11. No ranking was scored, so this was not a test-set evaluation. Output: [results/perf/cascade_2026-10-13.json](../results/perf/cascade_2026-10-13.json), from `benchmarks/bench_cascade.py`.

| Stage | Mean | Median | 95th percentile |
|---|---|---|---|
| Build the snapshot index (analysis and embeddings cached) | 142 ms | 115 ms | 273 ms |
| Embed the issue and its title (GPU) | 65 ms | 50 ms | 113 ms |
| Lexical and dense scoring, candidate pool, 52 features | 128 ms | 97 ms | 186 ms |
| LambdaMART, function and file level | 4 ms | 3 ms | 8 ms |
| Reranker: two adapters over the top 20 (GPU) | 8,499 ms | 3,074 ms | 22,395 ms |
| **Total** | **8,836 ms** | **3,512 ms** | **22,642 ms** |

- **The reranker's time is two-humped.** A quarter of the issues take under 1.6 seconds and a quarter take over 15. The suspicion, not yet tested, is that long candidates overflow the 6 GB of GPU memory. A run on a larger GPU would settle it and is the second hardware column this table still lacks.
- **Loading the models takes 20 seconds**, once per process, and is not in the table.
- **The first issue on a new repository also embeds its functions.** A Lite snapshot has 10,878 function and class units on average; at the measured 204 units a second that is 53 seconds, once. Later commits embed only what changed.

## In dollars

| System | Model | Cost per issue | Function Acc@10 | Source |
|---|---|---|---|---|
| Odin, repository already indexed | 0.5B + 0.6B | $0.0025 | 76.28 | measured here |
| Odin, first issue on a repository | 0.5B + 0.6B | $0.017 | 76.28 | measured here |
| SweRankLLM-Small | 7B | $0.011 | 86.13 | reported, S5 and S1 |
| SweRankLLM-Large | 32B | $0.015 | 88.69 | reported, S5 and S1 |
| LocAgent | Qwen2.5-7B, fine-tuned | $0.05 | 71.53 | reported, L5 and L4 |
| LocAgent | Qwen2.5-32B, fine-tuned | $0.09 | 77.01 | reported, L5 and L4 |
| SweRank reranker | GPT-4.1 | $0.16 | 87.96 | reported, S5 and S1 |
| MoatlessTools | Claude 3.5 | $0.46 | 64.96 | reported, L5 and L4 |
| LocAgent | Claude 3.5 | $0.66 | 77.37 | reported, L5 and L4 |
| SWE-agent | Claude 3.5 | $0.67 | 64.60 | reported, L5 and L4 |
| OpenHands | Claude 3.5 | $0.79 | 70.07 | reported, L5 and L4 |

L4 and L5 are Tables 4 and 5 of LocAgent ([arXiv:2503.09089v2](https://arxiv.org/abs/2503.09089v2)); S1 and S5 are Tables 1 and 5 of SweRank ([arXiv:2505.07849v1](https://arxiv.org/abs/2505.07849v1)). The copied values are in [docs/data/published_cost_accuracy.json](data/published_cost_accuracy.json).

How Odin's figure is computed, and what it assumes:

- **Formula.** Mean seconds per issue, times the hourly price of a rented GPU machine, divided by 3,600. 8.84 seconds at $1.006 an hour is $0.0025. The first-issue figure adds the 53 seconds of embedding.
- **The price is a public list price, not a bill.** $1.006 an hour is an AWS g5.xlarge (one A10G, 24 GB) on demand in us-east-1, as listed on 2026-10-13. Nothing was rented.
- **The seconds are the laptop's.** An A10G is a faster GPU with four times the memory, so the same work would likely take less time there. That has not been measured.
- **It counts busy time only.** A rented machine bills while idle and while loading models; a service answering a few issues an hour would pay far more per issue than this.
- **The other systems' costs are their authors'**, computed from the token prices of API and inference providers. SweRank's figures cover its reranker only: the paper treats the retriever's embeddings as computed in advance. Odin's repository-already-indexed figure is the matching one.
- **The accuracies are not like for like in one respect.** Odin's is scored here; the others are reported, and the one published model run inside Odin's index scored below its paper ([comparison](comparison.md)).

## What follows

- **The reranker is the only stage worth optimizing for latency.** Skipping it for confident issues (phase 6) attacks 96% of the time.
- **There is room to spend.** A reranker ten times larger would still cost about what SweRank's does. That is the budget odin-max (phase 11) works within.
- **Still to measure:** the same table on a cluster GPU, and latency on a repository outside SWE-bench.
