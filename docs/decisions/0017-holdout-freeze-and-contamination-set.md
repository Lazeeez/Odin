# 0017: When the holdout is spent, and a separate set for the contamination study

## Status

Accepted, 2026-10-14. Amends [ADR 0013](0013-sealed-holdout.md). Written before the contamination set's ground truth was built and before anything was evaluated on it.

## Context

ADR 0013 sealed a holdout for three final configurations and, in the same breath, called it the post-cutoff set of the contamination study. Those two uses conflict: the study compares every stage on old and new issues and may drive decisions, and the holdout allows neither intermediate stages nor decisions. The owner resolved it on 2026-10-14.

## Decision

### The holdout is not used for the contamination study

It is spent only on final configurations. A pre- and post-cutoff breakdown of the holdout's own issues may be reported from a final run, as description, and nothing is decided from it.

### When odin-fast is frozen

Not before all of these are done:

- the tie-breaking fix ([ADR 0016](0016-deterministic-ties.md)), which is done;
- the SweRank reproduction, and a decision on any indexing change it motivates;
- the phase 11 levers that keep odin-fast in its cost class, each decided on validation: more training data for the LambdaMART rankers and the reranker, the Action-ranker features, and anything else cheap.

Until then progress is tracked on validation and Lite only. At the freeze, the configuration is written to `data/holdout/allowed.json` with its commit, its models and their hashes, and it is then evaluated once. odin-max and the escalation operating point are each evaluated once when they are frozen.

### Per-stage numbers from the one holdout run

A final run may report its intermediate stages as by-products, under these conditions:

- every stage is frozen with the configuration;
- an ADR written before the run lists every stage, metric and paired comparison to be reported: all cascade stages; hit, recall and all at k, and MRR, at file and function level; per-stage latency; the pre- and post-cutoff breakdown;
- every listed number is reported whatever it is, and nothing is selected or changed afterwards because of them;
- the paired comparisons are the declared stage-against-previous-stage ones only, and the report says how many tests were run;
- the run is one entry in `results/test-evals.log`, which names the declaration ADR.

The guard in `odin eval` does not produce per-stage output yet. It is extended, with tests, before the first freeze.

### A separate set for the contamination study: odin-postcutoff

- **Source.** The same pinned revision of `nebius/SWE-rebench-leaderboard` as the holdout.
- **Selection.** Every issue created on or after 2025-09-01 that is not in the holdout and whose project is one Odin trained or tuned on: the twelve SWE-bench projects and the 120 SWE-rebench training projects. Issues from the 30 unseen projects are left out.
- **Size.** 73 issues from 27 projects, 24 of them from SWE-bench's own projects. None of the 73 is a training issue. After ground truth was built: 66 have a function-level target, 3 change module-level code only, and none failed to build.
- **Why these.** They are new issues in projects the models know. Comparing them with older issues from the same projects separates "this issue was seen" from "this project is familiar", which the holdout, made of unfamiliar projects, cannot do.
- **Disjoint from** the holdout (other projects), from every training and dev issue (other issues, created later), and from the 30 unseen projects.
- **Not sealed.** It may be evaluated repeatedly and decisions may rest on it. Every evaluation is still logged. Because decisions may rest on it, it must never be used to train or tune a ranker; `odin tune`, `odin ltr` and the reranker commands do not accept it.
- **Small.** 73 issues give intervals of about ten points either side. The study reports them and does not claim more than they support.

`data/contamination/manifest.json` lists the selection and the instances; `data/gold/swebench_postcutoff_test.jsonl` is the ground truth, built by the existing pipeline.

## Consequences

- The sentence in ADR 0013 that makes the holdout the contamination study's post-cutoff set no longer applies; this ADR replaces it.
- The contamination study (phase 4) has its design ADR still to write: which older issues are the comparison, and which stages and tests are reported.
