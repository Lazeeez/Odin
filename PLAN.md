# Plan

Target claim, once the work is done:

> Odin localizes bugs with near-agent accuracy at a small fraction of an agent's cost and latency, holds up on projects it has never seen, and measurably improves downstream issue resolution.

**Reframed target, 2026-10-13. A hypothesis, not a result.** SweRank already published the claim that ranking matches agents at a fraction of their cost, with better numbers than Odin's ([docs/comparison.md](docs/comparison.md)). What the measurements so far suggest Odin could claim instead, for odin-fast only:

> odin-fast (BM25, the 0.5B `jina-code-embeddings-0.5b` embedding model, a LambdaMART ranker and two LoRA adapters on the 0.6B `Qwen3-Reranker-0.6B`) localizes bugs at function level as accurately as the agents of the LocAgent paper running Claude 3.5 Sonnet, on a 6 GB laptop GPU, for about a quarter of a cent per issue, and keeps that accuracy on issues created after every one of its models was published.

- It is not smaller than every published ranking system: SweRankEmbed-Small is 137M parameters. It is smaller than SweRank's 7B retriever and its 7B and 32B rerankers, and those are the comparisons to name.
- It says nothing about odin-max, which will use large models.
- The last clause is untested: nothing has been evaluated on the sealed holdout.
- The README keeps stating only what is measured. The wording is revisited after the SweRank reproduction explains the gap between its paper and its score in Odin's index, and the owner sees the proposed sentence before it goes into the README.

Odin will ship two named operating points on one accuracy-versus-cost frontier: **odin-fast**, the current cascade, and **odin-max**, the best accuracy at any compute, with the phase 6 escalation curve between them.

## Status

Phases are worked in this order, with a report to the owner after each.

| Order | Phase | Deliverable | Needs | Status |
|---|---|---|---|---|
| 1 | 0. Audit | [docs/audit-2026-10.md](docs/audit-2026-10.md), this file, result files in the repo, the rate-limit fix | laptop | done; the follow-up decisions are tracked below |
| 1b | Sealed holdout | `data/holdout/`, `data/gold/odin_holdout.jsonl`, the guard in `odin eval`, [ADR 0013](docs/decisions/0013-sealed-holdout.md) | laptop | done; nothing evaluated on it |
| 2 | 1. Comparison with published systems | `eval/protocols.py`, `docs/comparison.md`, README section; baseline reproductions as PACE bundles; ends with the escalation novelty search | laptop, PACE for reproductions | LocAgent and CoSIL protocols, [docs/comparison.md](docs/comparison.md), the [novelty search](docs/novelty-escalation.md) and the run machinery done; SweRankEmbed-Small run in Odin's index; the SweRank reproduction with its own pipeline is in progress, and its 7B and 32B models wait for PACE |
| 3 | 2. Cost and latency of the full cascade | per-stage timings, dollars per issue, accuracy-vs-cost chart | laptop now, PACE as a second hardware column | laptop done: [docs/cost.md](docs/cost.md); the cluster column waits for PACE |
| 4 | 3. Error analysis | `docs/error-analysis.md`, labelled misses | laptop, owner labels the residue | not started |
| 4 | 4. Contamination study | `docs/contamination.md` | laptop | not started |
| any time | 9. Hosting and presentation | one Cloudflare Worker serving the site and the relay on allfather.dev, a redirect from GitHub Pages, [docs/deploy.md](docs/deploy.md), README restructure | the domain's zone in the deploying Cloudflare account | deployed and working on its workers.dev address; attaching allfather.dev is blocked on the zone being in another account; the README restructure is still to do |
| 5 | 11. Accuracy track | odin-max: levers ranked from the error analysis, one ablation row each | PACE allocation | not started |
| 6 | 6. Confidence-based escalation | selective-prediction curves, escalation with a self-hosted model, the frontier between odin-fast and odin-max | PACE | not started |
| 7 | 7. Downstream issue resolution | resolve rate: baseline vs odin-fast vs odin-max vs oracle localization | PACE, WSL for the harness if Apptainer fails | not started |
| 8 | 5. Harder and broader benchmarks | leak-free Verified, a non-SWE-bench Python benchmark, Java, both operating points | PACE | not started |
| 9 | 8. A running system | incremental index, GitHub Action, online evaluation | laptop | not started |
| 10 | 10. External validation | technical report, Hugging Face release, posts | everything above | not started |

## Ground rules

1. Never tune on a test set. The headline claims rest on the sealed holdout, which only the final odin-fast, odin-max and escalation configurations touch, once each per level ([ADR 0013](docs/decisions/0013-sealed-holdout.md)). Lite stays for comparison with published work and is run once per final configuration; any new knob is tuned on data disjoint from what it is evaluated on, and a new dev split is committed with its definition.
2. Every test-set evaluation is appended to [results/test-evals.log](results/test-evals.log), and write-ups report how many there were.
3. Every claim gets a paired bootstrap (`odin compare`): Δ, 95% CI, p-value, wins and losses. A result that is not significant is reported as such.
4. Every result file carries provenance: git commit, library versions, model hashes, command line.
5. For anything with a choice, the selection rule is written in the ADR before the results are looked at.
6. Results are never overwritten. A superseded number keeps its file and is marked where it is cited.
7. One ADR per decision in `docs/decisions/`, from 0012 on. Negative results get ADRs too.
8. One task per commit, with a descriptive message and passing tests.
9. No comments in new code; decisions are explained in ADRs and through naming.
10. No invented baseline numbers. A number attributed to another system comes from its paper or released outputs, with the table cited, or from our own reproduction, and every row says which.
11. Money is spent only after an estimate and the owner's approval. Paid API use is optional: at most one small frontier-model reference run.
12. Latency always names the hardware it was measured on. Laptop and PACE numbers share a table only with a hardware column.

## Cluster jobs (PACE)

Heavy jobs run on Georgia Tech PACE. The owner submits them and brings results back; nothing in the repository may assume a job ran.

- `cluster/` holds parameterized Slurm scripts (partition, GPU type and count, time limit, array size), Apptainer definitions, `setup.sh` (uv, pinned to the lockfile), `fetch.sh` (models, datasets, images and git mirrors, run on the login node: compute jobs get no internet) and `RUNBOOK.md` with the exact commands, expected runtime and GPU hours, and where outputs land.
- Each experiment has a committed manifest: which issues, which configuration, which model. A run is defined by its manifest and the commit.
- Every job has a `--local` mode that runs the same code path on a few issues on the laptop, with a small stand-in model where needed, and is tested before hand-off.
- Jobs are resumable and idempotent per issue: a rerun skips finished issues, and a killed job loses at most the issue in progress.
- A run writes one self-describing directory: provenance (commit, manifest hash, library versions, model hashes, GPU type, node, timings) and a checksum file, copied off scratch at the end.
- `odin import-run <dir>` verifies checksums and provenance against the repository. Only imported runs are used.
- SWE-bench environment images are tried through Apptainer first. If that fails, patches are generated on PACE and the evaluation harness runs on the laptop under WSL.

## Phase 11: accuracy track

Start from the phase 3 error analysis, rank the levers by how many misses each could fix, and write that ranking in an ADR before building.

| Lever | What it is |
|---|---|
| 1. Larger fine-tuned reranker | larger bases (Qwen3 8B/14B, an open coder model of 14B to 32B), the existing listwise loss, more epochs, depth 50, the shared-prefix KV cache kept |
| 2. More training data | more SWE-rebench issues and other permissively licensed bug-fix pairs, disjoint from every evaluation set, with a learning curve |
| 3. LLM listwise reranking | a large open model on vLLM, sliding windows, permutation self-consistency |
| 4. Agentic exploration | a bounded agent seeded with the top k, with file, search and call-graph tools |
| 5. Execution signals | LLM-written reproduction scripts, tracebacks and coverage as features; build rate reported separately |
| 6. Query understanding | LLM query expansion, measured on pool recall and final ranking |
| 7. Stronger embeddings | larger code embedding models; fine-tuning retried only with the larger training set |
| 8. Ensembling | learned or dev-tuned fusion of the strongest stages |
| 9. Multi-location output | predict how many locations to return, optimized for all@k |

Each lever is an ablation on top of the previous best, with a paired bootstrap and its added GPU-seconds and latency on the cost chart. A lever that is not significant on dev stops there and is recorded as a negative result. odin-max is also reported on the sealed holdout, which is the post-cutoff issue set of the contamination study, and under each published system's own protocol.

## Decisions on record

| Date | Decision |
|---|---|
| 2026-10-13 | Result files are committed; large per-query data would go to a Hugging Face dataset or a Release asset with checksums. CI checks every README number against a committed result. |
| 2026-10-13 | One task per commit with descriptive messages; existing history is not rewritten. |
| 2026-10-13 | The GitHub Action (phase 8b) uses the browser ranker in Python. An "Action ranker" (browser features plus git history) is trained with the same project-grouped cross-validation and scored once on the 30 unseen projects; the better one ships. |
| 2026-10-13 | With the relay on, the website takes the file list from the archive, so GitHub's API limit no longer applies ([ADR 0012](docs/decisions/0012-archive-file-list.md)). |
| 2026-10-13 | Phase 6 is framed as a generalization of the `ce-tune` skip margin, and its ADR says so. |
| 2026-10-13 | The escalation novelty search is done at the end of phase 1, before any phase 6 design. |
| 2026-10-13 | GitHub Pages and the workers.dev relay stay until the new deploy is verified. The old site then becomes a permanent redirect that preserves the hash route. |
| 2026-10-13 | A sealed holdout carries the headline claims: SWE-rebench leaderboard issues created on or after 2025-09-01 from projects used nowhere else, selected and hashed before anything is evaluated on it. |
| 2026-10-13 | Performance numbers that cannot be traced to a saved output are measured again on one machine, or dropped. |
| 2026-10-13 | The 13 result files without provenance are run again into new files; the old ones are kept. |
| 2026-10-13 | The two reranker adapters are published on Hugging Face, private at first, with checksums and a download step. |
| 2026-10-13 | The repository is prepared to go public after the audit follow-ups; the owner makes the call. |
| 2026-10-13 | Ties at a top-k cut-off are broken by index in Python as in the browser; all 17 Lite rows were re-run and no metric changed ([ADR 0016](docs/decisions/0016-deterministic-ties.md)). |
| 2026-10-13 | The error analysis uses the 250-issue validation split, not Lite. |
| 2026-10-13 | The headline claim is reframed as a hypothesis in this file; the README changes only after the holdout result and the owner's review of the sentence. |
| 2026-10-13 | Where a baseline reports results with an open model, it is reproduced on PACE with the same model in preference to quoting the paper. |

## Constraints

- The laptop GPU is an RTX 4050 (6 GB). Cross-encoder training and a Lite run fit; anything larger goes to PACE.
- Where agents beat Odin, the write-up says so plainly.
