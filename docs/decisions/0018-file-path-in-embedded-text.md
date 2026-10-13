# 0018: Put the file path in the text that is embedded

## Status

Proposed, 2026-10-14. The test and its decision rule below were written before the test ran. The outcome section is added after it.

## Context

Odin embeds each function or class as its qualified name followed by its source. The file path is left out on purpose: the embedding is keyed by the content of the unit, so a function that is identical in a hundred commits, or that moves between files, is embedded once ([ADR 0005](0005-dense-hybrid-retrieval.md)).

Reproducing SweRank showed what that costs a retriever. SweRankEmbed-Small, on its authors' corpus, scores 74.82% function Acc@10 on SWE-bench Lite. Each document there begins with `path/to/file.py/Class/method`. With that first line replaced by `Class.method`, and nothing else changed, the same model on the same corpus scores 64.96%: ten points lower, and file Acc@1 falls from 67.2% to 57.3%. Inside Odin's own index the model scores 65.69% and 57.3%. Input length was tested and is not the cause: cutting issues and functions from 1,024 tokens to 512 leaves the score at 74.82%.

Issues name files, modules and packages. An embedding that has never seen the path cannot use that.

That evidence is for another model on a test set. Whether it holds for Odin's embedding model, and whether it survives fusion with BM25, which already scores path terms, is not known.

## The test

One variant, chosen before running, with no search over formats:

- **Text.** The first line of each embedded unit becomes `path/to/file.py/Class/method`, the form the evidence is for. The source lines are unchanged.
- **Key.** The embedding key becomes the hash of that header and the unit's content hash, so a unit is embedded once per path it appears at.
- **Everything else is as it is:** the same embedding model, prompts, input lengths, fusion parameters and BM25.
- **Data.** The dev set, SWE-bench Verified minus Lite (407 issues). The embedding model was not trained on it. The fusion parameters were tuned on it for the current text, which favours the current text if anything.
- **Runs.** `dense-notests` and `hybrid-notests` against `dense-path-notests` and `hybrid-path-notests`, at function and file level.

### Decision rule

Fixed before looking:

- **Adopt as a candidate for odin-fast** if `hybrid-path-notests` beats `hybrid-notests` on function-level recall@10 in a paired bootstrap at p < 0.05, and is not significantly worse on file-level recall@10.
- **Otherwise it is recorded as a negative result** and nothing changes.
- Dense-only numbers are reported either way; they do not decide.
- Adopting it as a candidate does not change odin-fast by itself. The rankers and the reranker were trained on features from the current embeddings, so the next step would be to rebuild the features, retrain both rankers, and compare the whole cascade on the validation split.

### Cost to report

- Units embedded with paths against units embedded without, on the dev set: the price of giving up pure content addressing.
- Lite is not touched by this test.

## Consequences if adopted

- A function that is identical at two paths is embedded twice. Moves and copies are a small share of units; the measured count goes in the outcome.
- The content-addressed store stays for the current rows, so every published result remains reproducible.
