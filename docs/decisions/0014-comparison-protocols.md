# 0014: Compare with published systems under their own protocol

## Status

Accepted, 2026-10-13. Written before any Odin ranking was scored under another paper's protocol.

## Context

Odin's README reports recall@k, hit@k, all@k and MRR on the 291 Lite issues whose fix changes a function or class. Published localization systems report other metrics on other subsets, so the numbers cannot be put side by side. The most common protocol on SWE-bench Lite is LocAgent's, which SweRank and later papers reuse.

## Decision

`src/odin/eval/protocols.py` re-implements each published protocol from its released code, and Odin's stored rankings are scored under it. Nothing in Odin is changed, tuned or re-run to suit a protocol.

### The LocAgent protocol, as its code defines it

Read from `evaluation/eval_metric.py` in the LocAgent repository and the labels in the `czlll/SWE-bench_Lite` dataset, pinned by revision in the code.

- **Instances.** The 274 Lite issues in that dataset: the 300 minus those whose fix changes no existing function.
- **Labels.** The dataset's `edit_functions`, as `file:Qualified.name`. File level keeps the file. Module level keeps the file and the first name (a class or a top-level function). Function level keeps the full name, with a trailing `.__init__` removed, so a constructor counts as its class.
- **Acc@k.** An issue succeeds when the number of gold locations among the top k predictions equals the number of gold locations, or equals k when there are more than k of them. It is all-or-nothing per issue.
- **Reported k.** File 1, 3, 5. Module 5, 10. Function 5, 10.
- **An issue with no prediction fails.**

### How Odin's output is mapped

- File level uses the file ranking. Module and function level use the unit ranking, with each `path::Qualified.name` rewritten to `path:Qualified.name`, `.__init__` removed, and repeats dropped in order.
- Odin ranks classes as units as well as methods. A class in the ranking matches only a gold constructor; that cost is Odin's under this protocol and is not adjusted for.
- The stored result files hold the top 10 units. Module Acc@10 needs ten distinct modules, which ten units may not supply, so module numbers from these files are a lower bound and are marked as such. A deeper run of the same frozen configuration may replace them; it changes no ranking and is logged as an evaluation.

### What is reported

Fixed before looking:

- Every stage with a committed result file at both levels: `bm25-code-notests`, `hybrid-notests`, `ltr-notests`, `ltr-ce-notests`. The last is the row compared with other systems; the others show where the accuracy comes from.
- All seven numbers of the protocol for each, with 95% bootstrap intervals, whatever they turn out to be.
- Next to them, other systems' numbers copied from their papers, each cell citing its table and marked "reported". A system re-run here or on the cluster is marked "reproduced". No cell is filled from memory or from a secondary source.
- Each scoring of stored rankings is appended to `results/test-evals.log`: it is a new look at Lite, even though nothing is re-run.

### The CoSIL protocol, as its code defines it

Added on 2026-10-14, before any Odin ranking was scored under it. Read from `evaluation/FLEvalNew.py` and `evaluation/gt.json` in the CoSIL repository, pinned by commit in the code. The CoSIL paper reports Agentless and OrcaLoca under the same protocol.

- **Instances.** All 300 Lite issues. An issue with no prediction counts as a failure; nothing is skipped.
- **Labels.** `gt.json`: for each issue, `file::Qualified.name` entries, or a bare file where the fix changes no function.
- **Top-N.** An issue succeeds when at least one gold item is among the first N predictions. N is 1, 3 and 5.
- **MAP and MRR** over the predictions, divided by 300.
- **Functions are matched by name alone.** The evaluator compares `Qualified.name` strings and ignores the file, so a same-named function in another file counts as correct. That is the published protocol and is reproduced as it is.
- **How Odin's output is mapped.** Files are the first five of the file ranking. Function names are the qualified names of the first five units of the unit ranking. The evaluated systems can list more than five names, because they list several per file for up to five files; holding Odin to five is the stricter reading.
- **What is reported.** The same four stages, all ten numbers each, with intervals, next to Table 2 of the CoSIL paper (arXiv:2503.22424v1) for the systems run with Qwen2.5-Coder-32B.

### What this comparison cannot show

- Lite has been scored many times in this project (see the log) and predates every model involved, here and in the compared papers. The sealed holdout ([ADR 0013](0013-sealed-holdout.md)) carries the headline claims; this comparison only places Odin among published numbers.
- Reported numbers come from other people's hardware, prompts and model versions. Only reproduced rows are like for like.

## Consequences

- If Odin is behind a published system under this protocol, the table says so.
- Adding a protocol means adding it to `protocols.py` with its source, and a section here.
