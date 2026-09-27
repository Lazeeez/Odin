# 0001: Build the evaluation harness before the search engine

## Context

Code search systems are easy to demo and hard to judge. Without a fixed benchmark, every change (chunking strategy, tokenizer, fusion constant, graph depth) is justified by a handful of hand-picked queries.

## Decision

Start with a retrieval benchmark derived from SWE-bench Lite: the issue text is the query, and the functions touched by the maintainers' gold patch are the relevant results. All retrievers implement one interface and are scored by the same runner.

## Alternatives considered

- **CodeSearchNet-style docstring-to-function pairs.** Plentiful, but the query is written from the code rather than from a problem, so it rewards lexical overlap and says little about bug localization.
- **Hand-written queries against a single repo.** Fast to start, impossible to defend in a review.
- **End-to-end SWE-bench resolve rate.** The true downstream metric, but slow, expensive, and dominated by the LLM rather than retrieval.

## Consequences

- Lite is Python-only and heavily weighted toward django (114/300) and sympy (77/300). Results are reported per repo as well as overall so one repo cannot hide regressions.
- Every Lite gold patch touches a single file, so file-level recall is optimistic compared to multi-file changes. SWE-bench Verified can be swapped in with `--dataset verified`.
- The gold patch is one valid fix. Other correct locations exist and are scored as misses. This lowers absolute numbers but applies equally to every retriever, so comparisons stay fair.
