# 0023: Live accuracy on bugs fixed this week

## Status

Accepted, 2026-10-15. The collection rules and the metric were written before any issue was collected.

## Context

Every number Odin quotes comes from a fixed benchmark. Fixed benchmarks age: their issues are older than the models that read them, so a model may have seen them, and they say nothing about whether the website still works on the code people search today. The sealed holdout and the post-cutoff set answer the first problem once ([ADR 0013](0013-sealed-holdout.md), [ADR 0017](0017-holdout-freeze-and-contamination-set.md)); nothing answers it continuously.

## Decision

A nightly job (`scripts/live_eval.py`, run by `.github/workflows/live.yml`) scores the website's pipeline on bugs that popular Python projects fixed in the previous seven days, and keeps every result.

### Which bugs

- **Projects:** the fixed list in `data/live/projects.json`, Python projects that track bugs in GitHub issues. Changing the list is a commit that says why; results are reported per project as well as pooled, so a change is visible.
- **A bug** is a pull request merged in the window whose description closes exactly one issue of the same project with GitHub's closing keywords ("fixes #12", "closes owner/repo#12", "resolves" and their forms, or the issue's URL), where the issue was opened before the pull request.
- **The bug report** is that issue's title and the first 1,500 characters of its body, exactly what the site imports when a visitor pastes the issue's link.
- **The answer key** is built the way Odin builds all its ground truth ([How ground truth is built](../../README.md#how-ground-truth-is-built)): the merge commit's diff against its first parent, mapped onto the functions and classes it changes at that parent. Tests are excluded. A bug whose fix changes no function or class (only module-level code, new files or non-Python files) is recorded and skipped.
- **Each pull request is scored once,** on the first night it qualifies. Up to 80 bugs a night, in order of merge time, so a busy week cannot exhaust the free CI minutes; a night stops at 160 attempts, and stops early if GitHub's rate limit is reached.

### What is scored

The website's pipeline as shipped: the instant, semantic and rerank stages and the file ranker, from the exported trees in `web/src/assets/ranker.json` and the same static and MiniLM models, computed by the Python twin of the site's engine that the parity tests hold to the browser value for value. One difference: the Python twin indexes every non-test Python file, while the browser stops at 6,000 files or 60 MB on very large projects. Each record carries the SHA-256 of `ranker.json`, so a change to the site's models shows up in the results.

### Metrics

- **Function hit@10** (a function the fix changed is in the top 10) and **file hit@10**, the website's own metrics, with recall@10, hit@1 and MRR alongside.
- Reported for the last 30 days and for all time, pooled and split into projects the website's rankers trained on (SWE-bench and SWE-rebench training projects, on older issues) and projects they never saw, each with a bootstrap 95% interval.

### Rules

- **Monitoring only.** These bugs are never used to train, tune or choose anything. A change motivated by what the live results show is decided on other data, by its own ADR.
- **Append-only.** Each night writes `results/live/<date>.jsonl` and never edits an earlier file. A failed night is a gap, not a backfill.
- **Not a test set in the sense of `results/test-evals.log`:** that log counts evaluations on fixed sets whose reuse matters. These issues are new every night and nothing is selected on them.
- **Shown as it is:** the site shows the 30-day function hit@10, the number of bugs behind it, its interval and the date range, and links to this ADR. Below 30 bugs it shows the count and no percentage.

## Consequences

- The website gets an accuracy number that cannot have leaked into any model, refreshed every night.
- Bugs whose issue does not describe the problem (a one-line issue, a feature request filed as a bug) count as they are. That is closer to what visitors paste than a curated benchmark, and is expected to score lower than SWE-bench.
- The job reads public GitHub data with the workflow's own token, commits each night's file and `results/live/summary.json` to the repository (`[skip ci]`, so the nightly commit does not run the test suite), and posts the summary to the Worker's `/api/live` with a secret shared with it (`LIVE_TOKEN`, a repository secret and a Worker secret). The Worker keeps only the latest summary (D1 table `live`); the Benchmarks page and the home page read it from there.
