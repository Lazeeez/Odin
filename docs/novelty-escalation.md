# Is confidence-based escalation new? A first search

Phase 6 plans to let the cheap cascade answer when it is confident and pass the issue to a more expensive localizer when it is not. This page records what a literature search on 2026-10-13 found, before any phase 6 design.

**Status of this page.** Five web searches, and the abstracts or summaries of what they returned. Only LocAgent and SweRank were read in full (for [the comparison](comparison.md)). Everything else below is known from its abstract and must be read before phase 6 cites or builds on it.

## Summary

- **The general idea is well established.** Cheap-model-first cascades with a calibrated confidence threshold are published for LLM question answering, classification, judging and moderation.
- **The retrieval version exists too.** Skipping or choosing a reranker per query, from a prediction of how hard the query is, is published.
- **Odin already holds a small instance of it.** `ce-tune` measures skipping the reranker when the ranker's first candidate leads its second by a margin (`SKIP_MARGINS` in `src/odin/rank/ce_tune.py`).
- **No paper found applies it to issue localization** as a ranker that abstains and hands over to an agent, with a measured accuracy-versus-cost curve. That is the gap phase 6 could fill. Five searches are not proof that it is empty.
- **So the contribution can only be an application and a measurement, not a method.** It should be written up that way.

## What exists

| Work | What it does | How close |
|---|---|---|
| [A Unified Approach to Routing and Cascading for LLMs](https://arxiv.org/abs/2410.10347) (Dekoninck et al.) | Derives an optimal strategy that combines routing and cascading across models; evaluated on RouterBench and on SWE-bench issue resolution | The theory phase 6 should use or cite. It targets resolution, not localization, and models, not a ranker and an agent |
| [UCCI: Calibrated Uncertainty for Cost-Optimal LLM Cascade Routing](https://arxiv.org/abs/2605.18796) | Maps token-margin uncertainty to an error probability with isotonic regression, then minimizes cost under an accuracy constraint | The same recipe as the planned one: calibrate, then threshold |
| [Trust or Escalate: LLM Judges with Provable Guarantees](https://proceedings.iclr.cc/paper_files/paper/2025/file/08dabd5345b37fffcbe335bd578b15a0-Paper-Conference.pdf) (ICLR 2025) | A cascade of judges that escalates when confidence is low, with a guarantee on agreement | A source for the guarantee side: a risk bound instead of a tuned threshold |
| [Adaptive Re-Ranking](https://arxiv.org/abs/2606.25249) | Routes each query to BM25 only, a light reranker or a heavy one by query complexity | The retrieval analogue, on general text search |
| Query performance prediction, and early exit in ranking ensembles (LEAR and related) | Predict a query's retrieval quality without labels; stop scoring early | The older line of work the confidence features come from |
| [SweRank+](https://arxiv.org/abs/2512.20482), with SweRankAgent | A ranker followed by a light multi-turn agent that refines the candidates | The nearest system in the same task. From the abstract the agent runs on every issue; whether it is gated by confidence needs checking in the paper |
| [BLAgent](https://arxiv.org/abs/2605.17965) | Retrieval plus two-phase agentic reranking for file-level localization; reports 78.6% top-1 on Lite with an open model at a fraction of the baseline cost | A competitor on the cost claim at file level, and a row to add to the comparison |

## What phase 6 would have to show to be worth writing up

1. **A risk-coverage curve for the ranker alone:** if Odin answers only the most confident x% of issues, how accurate is it on those? Without a usable confidence signal there is nothing to escalate on.
2. **The frontier:** accuracy against cost per issue as the threshold moves, between odin-fast on every issue and the expensive localizer on every issue, and whether any point beats both a random mix of the two and each alone.
3. **Calibration that transfers:** a threshold chosen on dev data that still gives the promised accuracy on the sealed holdout, on projects never seen.
4. **Baselines from the papers above:** at least the cascade of Dekoninck et al. and a plain margin threshold, so the result is placed against the known methods.

## Before phase 6 starts

- Read SweRank+ in full: does its agent run conditionally?
- Read the cascade-routing paper's SWE-bench experiment: what was the quality estimator, and why did the plain cascade do badly there?
- Search again for work citing SweRank and LocAgent that mentions abstention, deferral or selective prediction.
