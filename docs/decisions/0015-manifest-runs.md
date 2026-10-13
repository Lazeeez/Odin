# 0015: Heavy experiments are manifest runs, scored only at import

## Status

Accepted, 2026-10-13. Written before the first baseline run.

## Context

The experiments ahead (larger rerankers, published baselines, agents) need a GPU cluster the repository's author submits jobs to by hand. A result that arrives from another machine has to be as trustworthy as one produced by `odin eval` on the laptop: which code, which issues, which model, and proof that nothing was edited on the way.

## Decision

- **A manifest defines an experiment.** `cluster/manifests/NAME.json` names the dataset, the level, the depth, the retriever with its model revision, any packages that replace the locked ones, and the reason for the run. It is committed before the job runs.
- **A job only ranks.** `odin run --manifest M --out DIR` writes one ranking file per issue. It loads no ground truth, so nothing on the cluster can be tuned against the answer.
- **Runs are resumable per issue.** An existing ranking file is skipped. Files are written whole and then renamed, so a killed job leaves no half-written issue.
- **A run directory describes itself.** It holds the manifest, one record per invocation (commit, clean or dirty tree, library versions, GPU, node, Slurm job id, duration) and a checksum of every file.
- **Scoring happens at import.** `odin import-run DIR` refuses a run unless every checksum matches, the manifest is byte-identical to the committed one, each invocation ran from a clean tree at a commit this repository has, and every issue of the manifest is present. Only then does it score the rankings, write `results/runs/NAME/result.json` and, for a test set, append a line to `results/test-evals.log`.
- **`--local N` tests the job, not the hypothesis.** It runs the same code on the first N issues and marks the run so that it cannot be imported.
- **The sealed holdout cannot appear in a manifest.** Holdout evaluations go through `odin eval --unseal` ([ADR 0013](0013-sealed-holdout.md)); a cluster path for them will be added with its own guard when a frozen configuration needs it.

## Three kinds of row for other people's systems

[ADR 0014](0014-comparison-protocols.md) had two: reported and reproduced. Running a published model through Odin's own index is neither, so there are now three.

| Mark | Meaning |
|---|---|
| reported | copied from the paper's table |
| reproduced | the authors' code and data, run again |
| in Odin's index | the published model, run through Odin's chunker, index and harness |

The third isolates the model: the same units, the same exclusion of test files, the same issues as every Odin row. It can differ from the paper's number because the corpus differs, and the difference is reported, not explained away.

## The first run

`swerank-embed-small-lite`: SweRankEmbed-Small (137M parameters, CC-BY-NC-4.0), pinned by revision, as the only retriever at function level on Lite, depth 100. Fixed before running:

- It is reported under the LocAgent protocol next to the paper's row for the same model (function Acc@10 74.45%), marked "in Odin's index", and under Odin's own metrics next to `dense-notests`.
- It is a baseline. Nothing in Odin is chosen from it. If a later phase wants this model as a component, that choice is made on dev data.
- The model's own code needs `transformers` 4, so the manifest carries that overlay; the locked environment is unchanged.

## Consequences

- The cluster scripts in `cluster/` are thin wrappers around `odin run`. They have not been run on the cluster yet; `cluster/preflight.sh` checks the account, partition and paths first.
- A run made from uncommitted code is lost work. That is the intended cost.
