# Where the cascade loses issues

Which stage loses each issue the current cascade fails on, measured on validation data so that the answer can steer what gets built next without touching a test set.

## Summary

- **The cascade puts a correct function in the top 10 for 204 of 250 validation issues (81.6%).**
- **More than half of the 46 misses are lost by the ranker, not by retrieval or the reranker.** In 26 the correct function was in the candidate pool but LambdaMART ranked it below 20th, so the reranker never saw it. In 17 of those 26 it was between 21st and 50th.
- **Retrieval is rarely the problem.** Only 8 of 250 issues had no correct function in the pool.
- **The reranker helps the top and is a wash at the edge of the top 10.** It lifts first-place accuracy from 44.4% to 51.6%, but it brought 8 issues into the top 10 and pushed 7 out.
- **Finding every changed function is much harder than finding one.** Of the 123 issues whose fix changes more than one function, all of them are in the top 10 for 43; some but not all for 63.

## The data

The 250 training issues the reranker never saw (`validation_split` in `src/odin/rank/ce_train.py`), ranked by a LambdaMART model retrained without them, then by the shipped reranker settings (two adapters over the top 20, blend weight 2.0). They come from 11 of the 12 SWE-bench projects, the same projects the models trained on, so this measures the cascade on familiar projects.

Output: [results/error-analysis/validation_2026-10-13.json](../results/error-analysis/validation_2026-10-13.json), from `scripts/error_analysis.py`. The stage definitions were fixed in the script before it ran.

## Where each issue ends

| Outcome | Issues | Share of the 46 misses |
|---|---|---|
| A correct function is in the top 10 | 204 | |
| The ranker left it below the reranker's depth of 20 | 26 | 57% |
| The reranker saw it and left it below the top 10 | 12 | 26% |
| It was never in the candidate pool | 8 | 17% |
| The fix has no indexed function or class | 0 | |

Along the cascade, for at least one correct function:

| Point | Issues that still have it |
|---|---|
| In the candidate pool (median 429 candidates of 8,858 units) | 96.8% |
| In the ranker's top 20 | 86.4% |
| In the ranker's top 10 | 81.2% |
| In the final top 10 | 81.6% |
| First, by the ranker | 44.4% |
| First, after the reranker | 51.6% |

## The three kinds of miss

**Lost by the ranker (26).** The correct function's rank by LambdaMART:

| Ranked | Issues |
|---|---|
| 21st to 50th | 17 |
| 51st to 100th | 4 |
| below 100th | 5 |

**Lost by the reranker (12).** In 7 the ranker had the function in its top 10 and the blend pushed it out, to between 11th and 19th. In 5 the ranker had it at 11th to 20th and the reranker did not lift it.

**Lost by retrieval (8).** In most of them the correct function is hundreds of places down for both keywords and embeddings; these are issues whose text does not point at the code that changes.

## Who gets missed

| Group | Issues | Found |
|---|---|---|
| Issue contains code or backticked names | 136 | 76% |
| Issue contains neither | 114 | 89% |
| Issue shorter than 600 characters | 66 | 91% |
| Issue longer than 3,000 characters | 39 | 74% |
| Issue contains a traceback | 41 | 80% |
| One function to find | 127 | 77% |
| Two or three | 67 | 87% |
| Four or more | 56 | 86% |

| Project | Issues | Found |
|---|---|---|
| django | 100 | 86% |
| sympy | 34 | 76% |
| matplotlib | 26 | 65% |
| scikit-learn | 26 | 96% |
| sphinx | 26 | 81% |
| xarray | 13 | 85% |
| pytest | 10 | 70% |
| the other four | 15 | 73% |

- **Long issues and issues with code in them do worse**, the opposite of what one might expect. Long issues are cut at 512 tokens for the reranker and 1,024 for the embedding model, and a pasted snippet names many functions that are not the one to change. Both are hypotheses.
- **matplotlib is the weak project** among those with enough issues to say so.
- The groups overlap and are small; none of these differences was tested for significance.

## What this says about the phase 11 levers

Ordered by how many of the 46 misses each could reach. "Could reach" is an upper bound, not a prediction.

| Lever | Misses it could reach | Cost class |
|---|---|---|
| A better ranker: more training data for LambdaMART, more features | up to 26 | odin-fast: no cost per query |
| A deeper reranker: 50 candidates instead of 20 | up to 17 of those 26 | 2.5 times the reranker's time, which is 96% of a query |
| A stronger reranker | up to 12, and the top-1 gap | larger model: odin-max, unless a 0.6B model can be trained better |
| Better retrieval: embeddings, input length, query expansion | up to 8 | varies; input length is nearly free |
| Predicting how many locations to return | none of the 46: it targets the 63 issues found only in part | odin-fast |

- **The ranker comes first.** It is the largest group, it costs nothing at query time, and it fits odin-fast. It is also the stage trained on the least data: 1,941 issues from 12 projects.
- **Depth 50 was tried before on validation and not chosen** (`ce-tune` picked 20). That choice was made by MRR, which depth does not help; by hit@10 the 17 issues between 21st and 50th are the argument for looking again, at a known cost.
- **Retrieval is a small lever on these projects.** That may not hold on unfamiliar projects, where the pool was never measured; the SweRank comparison ([comparison.md](comparison.md)) also suggests Odin's input handling loses accuracy at this stage.
- **Multi-location output is its own problem.** It does not show up in hit@10 but decides the all-or-nothing metric the published comparisons use.

## Limits

- **Familiar projects only.** Every validation issue comes from a project the models trained on. The mix of failures on unseen projects may differ, and nothing here measures it.
- **250 issues, 46 misses.** The split between the three kinds of miss is uncertain by several issues either way.
- **Upper bounds.** A lever that "could reach" a miss fixes it only if it works.
- **Not yet labelled by hand.** The 46 misses are listed below for the owner to read and label by cause.

## The 46 misses

Never in the candidate pool (8): django-11299, django-13281, django-14387, django-15111, matplotlib-13859, pytest-11041, pytest-6202, sympy-18630.

Below the reranker's depth (26): django-11279, django-12396, django-12965, django-13233, django-13924, django-14727, matplotlib-20676, matplotlib-21568, matplotlib-24177, matplotlib-24971, matplotlib-26078, xarray-7105, pylint-5446, pylint-6358, pylint-6526, pytest-5787, sphinx-11510, sphinx-7593, sphinx-9104, sphinx-9128, sphinx-9350, sympy-14248, sympy-17067, sympy-17115, sympy-17173, sympy-17821.

Seen by the reranker, left below the top 10 (12): django-11205, django-13689, django-14011, django-14407, matplotlib-26208, matplotlib-26342, matplotlib-26466, requests-4356, xarray-7101, scikit-learn-10687, sympy-15586, sympy-20476.
