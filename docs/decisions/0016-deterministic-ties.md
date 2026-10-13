# 0016: Ties at a cut-off are broken by index

## Status

Accepted, 2026-10-13. The rules below were written before the re-runs; the outcome section was added after them.

## Context

`top_k` picks the k best-scoring items. When several items had exactly the same score at the cut-off, the Python version kept an arbitrary subset of them: it selected with `numpy.argpartition`, which makes no promise about ties, and only then sorted what it had selected. The website's TypeScript version sorts everything by score and then by index, so it always keeps the lowest indices.

The audit found the consequence twice: two of 46 queries in the pinned browser-against-Python check kept different tied units, and a parity test on Odin's own source failed when a tie landed on a pool boundary. `top_k` is called in 25 places: every retriever's final ranking, the candidate pools of both rankers, graph expansion and history features.

## Decision

`top_k` keeps every item above the cut-off score and then the lowest indices among those equal to it. It now does what its docstring always said, and what the browser does.

Nothing is retrained. The rankers and the reranker adapters are fixed files; they were trained on pools built with the old tie handling, and a tie at a pool boundary changes at most which of several equally scored candidates entered a pool.

### What is run again, and how it is reported

Fixed before running:

- Every Lite row with a committed result file is run again into `results/ties/`: `random`, `oracle`, the six lexical files, `bm25-code-notests-graph`, and `dense-notests`, `hybrid-notests`, `ltr-notests` and `ltr-ce-notests` at both levels. The earlier files stay where they are.
- Each re-run is logged in `results/test-evals.log` as a re-evaluation of an unchanged configuration.
- The outcome section lists, per file, how many rankings changed and every metric that changed. The baseline for the comparison is the most recent earlier file of the same row, so that this change is not confounded with the dense and hybrid differences already recorded in `results/README.md`.
- The README is then checked against the new files. Every number that changes is listed here with its old and new value, and the README is updated to the new value whichever direction it moves.
- The website's rankers and their published numbers are not re-run: its TypeScript engine already broke ties by index, so the shipped behaviour is unchanged. Their training pools were built by the Python code with the old tie handling; that is recorded here as a known difference between what was trained on and what is served.

## Consequences

- Python and the browser now agree on the pinned check with no exceptions: 46 of 46 top-10 lists identical, where two differed by tied units before.
- One difference remains and is not a tie in the same sense: the browser scores in 64-bit floats and Python in 32-bit, so two units whose scores agree to seven digits can swap adjacent ranks. The parity test accepts a rank difference only between units whose scores agree to that precision, and nothing else.
