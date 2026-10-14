# What the cascade costs

How long the full cascade (odin-fast) takes per issue, stage by stage, and what that is in dollars next to published systems. Measured on a laptop on 2026-10-13 and on a GPU of Georgia Tech's PACE cluster on 2026-10-14.

## Summary

- **0.44 seconds per issue on a data-centre GPU (NVIDIA L40S)**, median 0.40 seconds, once a repository is indexed. On a 6 GB laptop GPU the same cascade takes 8.8 seconds.
- **The reranker is the largest stage on both:** 237 ms of 443 on the L40S, 8.5 s of 8.8 on the laptop. The laptop's reranker is slowed by its small GPU, not by the method.
- **About two hundredths of a cent per issue on the L40S** at a public rental price ($0.0002), and a quarter of a cent with the laptop's timings.
- **That is about 50 times cheaper than the cheapest published ranking system and over 2,000 times cheaper than the agents**, at an accuracy level with the best agent in the LocAgent paper and 12 points below the best ranking system. The dollar comparison rests on assumptions listed below.

![Function Acc@10 against cost per issue on SWE-bench Lite. Odin sits at a quarter of a cent and 76%; SweRank's rerankers at one to two cents and 86 to 89%; agents with Claude 3.5 at 46 to 79 cents and 65 to 77%.](img/cost-accuracy.svg)

The numbers behind the chart are in the two tables below and in [the comparison](comparison.md).

## Time per issue, by stage

All 291 Lite issues with a function target, timed by `benchmarks/bench_cascade.py` on two machines. No ranking was scored, so neither run was a test-set evaluation.

- **Laptop:** Core i5-13420H, 32 GB, RTX 4050 Laptop GPU (6 GB), Windows 11. [results/perf/cascade_2026-10-13.json](../results/perf/cascade_2026-10-13.json).
- **PACE (the ICE cluster):** one NVIDIA L40S (46 GB) with 8 CPU cores and 32 GB of a shared node, Linux, Slurm job 6259577. [results/perf/cascade_pace-l40s-warm.json](../results/perf/cascade_pace-l40s-warm.json), timed after a first pass that filled the embedding store ([cold pass](../results/perf/cascade_pace-l40s-cold.json)). Its provenance marks the working tree as having an uncommitted change to a tracked file; which file was not recorded. The code ran at the pushed commit `642abf0`.

| Stage | Laptop mean | Laptop median / p95 | L40S mean | L40S median / p95 |
|---|---|---|---|---|
| Build the snapshot index (analysis and embeddings cached) | 142 ms | 115 / 273 ms | 87 ms | 68 / 200 ms |
| Embed the issue and its title | 65 ms | 50 / 113 ms | 26 ms | 22 / 25 ms |
| Lexical and dense scoring, candidate pool, 52 features | 128 ms | 97 / 186 ms | 83 ms | 57 / 96 ms |
| LambdaMART, function and file level | 4 ms | 3 / 8 ms | 11 ms | 2 / 72 ms |
| Reranker: two adapters over the top 20 | 8,499 ms | 3,074 / 22,395 ms | 237 ms | 225 / 277 ms |
| **Total** | **8,836 ms** | **3,512 / 22,642 ms** | **443 ms** | **397 / 607 ms** |

- **On the laptop the reranker's time is two-humped:** a quarter of the issues take under 1.6 seconds and a quarter over 15. On the L40S the 95th percentile is within a quarter of the median. That fits the explanation that long candidates overflow the laptop's 6 GB of GPU memory; GPU memory itself was not measured.
- **Loading the models takes 20 seconds**, once per process, and is not in the table.
- **The first issue on a new repository also embeds its functions.** A Lite snapshot has 10,878 function and class units on average; at the laptop's measured 204 units a second that is 53 seconds, once. On the L40S, the first pass over Lite, which embedded every function, averaged 1.9 seconds per issue against 0.44 once embedded. Later commits embed only what changed.

## In dollars

| System | Model | Cost per issue | Function Acc@10 | Source |
|---|---|---|---|---|
| Odin on an L40S, repository already indexed | 0.5B + 0.6B | $0.0002 | 76.28 | measured here |
| Odin on the laptop, repository already indexed | 0.5B + 0.6B | $0.0025 | 76.28 | measured here |
| Odin on the laptop, first issue on a repository | 0.5B + 0.6B | $0.017 | 76.28 | measured here |
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

- **Formula.** Mean seconds per issue, times the hourly price of a rented machine with that kind of GPU, divided by 3,600. On the L40S: 0.443 seconds at $1.861 an hour is $0.00023. On the laptop: 8.84 seconds at $1.006 an hour is $0.0025, and the first-issue figure adds the 53 seconds of embedding.
- **The prices are public list prices, not bills.** $1.861 an hour is an AWS g6e.xlarge (one L40S) and $1.006 an AWS g5.xlarge (one A10G, 24 GB), on demand in us-east-1, as listed on 2026-10-14 and 2026-10-13. Nothing was rented: the L40S belongs to the PACE cluster, and the laptop's seconds are priced at a rentable GPU that is faster than the laptop's.
- **It counts busy time only.** A rented machine bills while idle and while loading models; a service answering a few issues an hour would pay far more per issue than this.
- **The other systems' costs are their authors'**, computed from the token prices of API and inference providers. SweRank's figures cover its reranker only: the paper treats the retriever's embeddings as computed in advance. Odin's repository-already-indexed figure is the matching one.
- **The accuracies are not like for like in one respect.** Odin's is scored here; the others are reported, and the one published model run inside Odin's index scored below its paper ([comparison](comparison.md)).

## What follows

- **The reranker is the stage worth optimizing for latency** on both machines: 54% of the time on the L40S, 96% on the laptop. Skipping it for confident issues (phase 6) attacks most of it.
- **There is room to spend.** On the L40S, a reranker fifty times more expensive would still cost about what SweRank's does. That is the budget odin-max (phase 11) works within.
- **Still to measure:** latency on a repository outside SWE-bench.
