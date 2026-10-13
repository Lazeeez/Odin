# 0013: A sealed holdout for the headline claims

## Status

Accepted, 2026-10-13. Written before the holdout's ground truth was built and before anything was evaluated on it. Amended on 2026-10-14 by [ADR 0017](0017-holdout-freeze-and-contamination-set.md): the holdout is not the contamination study's set, odin-fast is frozen only after the conditions listed there, and a final run may report its stages as declared by-products.

## Context

SWE-bench Lite had been scored 33 times by the October 2026 audit ([results/test-evals.log](../../results/test-evals.log)). No number was tuned on it, but one decision was taken on a Lite result, and the accuracy track ahead adds many more experiments. A test set that has been looked at that often cannot carry the headline claims. Lite also predates the models in the cascade: its issues and their fixes may be in their training data.

## Decision

**odin-holdout** is a set of issues nobody has evaluated on, used only for final configurations.

### What is in it

- **Source.** [nebius/SWE-rebench-leaderboard](https://huggingface.co/datasets/nebius/SWE-rebench-leaderboard) (CC-BY-4.0), pinned to the dataset revision recorded in the manifest.
- **Date.** Issues created on or after 2025-09-01. The newest model in the current cascade is `jinaai/jina-code-embeddings-0.5b`, published on 2025-08-19; `Qwen/Qwen3-Reranker-0.6B` was published on 2025-05-29. Neither publishes a training cutoff, so the publication date is used as its upper bound.
- **Projects.** Only projects that appear in no other Odin data: not the twelve SWE-bench projects (training, dev tuning and Lite), not the 120 SWE-rebench projects the website's rankers train on, not the 30 unseen projects.
- **Size.** 324 issues from 189 projects; the largest project contributes 19. Issues whose fix touches no Python function or class are kept at file level and skipped at function level, as on Lite. After ground truth was built: 321 issues have a file-level target and 311, from 184 projects, a function-level target. Of the 13 without one, ten fixes change module-level code only, two change no Python file, and one base commit is no longer on GitHub.
- **Ground truth** is built by the existing pipeline (`odin gold`), from each issue's patch at its base commit.

`data/holdout/manifest.json` lists the selection rule, the dataset revision and every instance. `data/gold/odin_holdout.jsonl` is the ground truth. `data/holdout/SHA256SUMS` holds the hash of both.

### Who may evaluate on it

Three configurations, named in `data/holdout/allowed.json`:

| Name | What it is |
|---|---|
| `odin-fast` | the cheap cascade |
| `odin-max` | the best accuracy at any compute (phase 11) |
| `odin-escalation` | the operating point chosen on the phase 6 curve |

A configuration is evaluated only after its design is frozen: its entry in `allowed.json` names the retriever and the commit it was frozen at. Nothing else is evaluated on the holdout: no ablations, no intermediate stages, no debugging runs.

### How the code enforces it

- `odin eval --dataset holdout` refuses to run without `--unseal` and `--config NAME`, where NAME is in `allowed.json`, is frozen, and has not been evaluated at that level before.
- Every holdout evaluation appends a line to `results/test-evals.log` by itself.
- Loading the holdout without unsealing returns the instances with their issue text blanked, so ground truth can be built, and nothing else can read the reports by accident.
- No other command accepts the holdout: not tuning, not ranker training, not reranker training.
- `odin.eval.holdout.assert_disjoint` fails any training or dev set that contains a holdout project. Every later training-data script calls it.

### Models newer than the issues

A configuration that uses a model published after 2025-09-01 is reported on the holdout issues created after that model's publication date, and the write-up states the subset size. The manifest records each issue's creation date for this. For the website's static embedding model (`minishlab/potion-code-16M`, published 2026-04-02) that leaves 56 issues, too few for a headline number; the website keeps the 30 unseen projects as its test set.

### What Lite is for now

Lite stays as the common ground with published systems (phase 1). The headline claims rest on the holdout. The holdout is also the post-cutoff set of the contamination study (phase 4): comparing each stage on Lite and on the holdout, with the BM25-only stage as the control for how hard the two sets are.

## Consequences

- The holdout can be spent only three times per level. A fourth configuration means amending this ADR first, in a commit that precedes the evaluation.
- Projects in the holdout are permanently out of every training and dev set.
- Building the ground truth reads patches, not rankings, and reveals nothing about how any configuration performs.
- A reviewer can verify the seal: the manifest and gold hashes are committed before the first holdout line appears in the log.
