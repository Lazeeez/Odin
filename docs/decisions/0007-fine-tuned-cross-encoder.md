# 0007: A fine-tuned cross-encoder as the last stage of a ranking cascade

## Context

After learning to rank (0006), the answer was in the top 10 for about three quarters of issues but first for only a third. Every earlier stage scores the issue and the code separately: BM25 and embeddings compare two independent representations, and LambdaMART combines their outputs. A model that reads the issue and a candidate function in one pass can use interactions those stages cannot, such as the issue describing exactly the branch a function takes.

A zero-shot LLM reranker (Qwen3-Reranker-0.6B) had matched, not beaten, the hybrid order (0006). The question was whether in-domain fine-tuning changes that.

## Decision

**Model and training.** Qwen3-Reranker-0.6B scores a pair as logit("yes") minus logit("no") at the final position. It is fine-tuned with LoRA (rank 16 on every attention and MLP projection, fp32 adapters on a bf16 base, gradient checkpointing) on 1,691 training issues: all of SWE-bench test minus Lite, minus a 250-issue validation split. Each step is listwise. The model sees one gold function and the 3 hardest wrong candidates for the same issue (taken from hybrid's top 30) and is trained with softmax cross-entropy to put the gold one first. One epoch takes about 32 minutes on an RTX 4050 laptop GPU. Issues are truncated to 512 tokens and functions to 256.

**Where it runs.** Only on LambdaMART's top K. Scores are blended as `z(ltr) + w * z(ce)` over those K, and the rest keep their LTR order. Files blend the file model's score with the best reranker score among their units. K and both weights were chosen on the 250 validation issues by MRR, a rule fixed before looking, with LTR models retrained without those issues so the blend meets out-of-sample scores: K = 20, w = 2.0 for functions, w = 0.5 for files.

**Shared-prefix KV cache.** All K candidates of a query share the prompt prefix (instructions plus issue, up to about 550 tokens), while a function is typically about 60. The prefix is run once, its key/value cache is replicated across the candidate batch, and only candidate tokens are computed. Scores match an uncached reference to bf16 rounding (at most 0.125 on a range of about ±10, same ordering). The cache is 2x faster on a synthetic test, and it is what makes 20 candidates per query affordable. Sequences are left-padded and only the last position is projected onto the 151k-token vocabulary (`logits_to_keep=1`), which is also what lets training fit in 6 GB.

## Results

Validation (250 held-out training issues), function level: MRR 0.554 → 0.608, recall@1 0.279 → 0.316. Using the reranker alone (w = ∞) was worse than LTR alone, so blending is essential.

Lite test, held out:

| | recall@1 | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| Function: LTR → LTR + CE | 0.327 → 0.366 | 0.628 → 0.678 | 0.744 → 0.776 | 0.485 → 0.530 |
| File: LTR → LTR + CE | 0.630 → 0.663 | 0.877 → 0.897 | 0.923 → 0.920 | 0.740 → 0.768 |

Significant at function level on MRR (p = 0.007), recall@5 (p = 0.023) and recall@10 (p = 0.035), and at file level on recall@5 (p = 0.005, 6 wins / 0 losses) and MRR (p = 0.008). File recall@10 is unchanged.

## Notes

- The training loss stayed near ln 4 (the loss of guessing among 4), which looked like failure. It was not: the negatives are the hardest candidates the system knows, many of them near-duplicates or genuinely related code. On validation groups of 8 (1 gold, 7 hard negatives), the fine-tuned model put the gold function first 58% of the time against 48% for the base model. Judge a reranker on held-out ranking, not on its training loss.
- Query latency is about 0.85 s p50: 20 reranker passes plus feature extraction. That is interactive for a search tool, and the reranker runs on a fixed-size candidate set, so it does not grow with the repository.
- The adapter (39 MB) is not committed; `odin ce-train` rebuilds it, and `models/ce_adapter/choice.json` records the chosen depth and weights.

## Addendum: final system (supersedes the Results table above)

The Results table above was measured on an embedding store corrupted by duplicate keys ([ADR 0008](0008-embedding-store-corruption.md)). After the store was repaired, the features were rebuilt and the rankers retrained. Three decisions were made on the validation split:

- **Negatives from the ranker itself.** A second adapter is trained on hard negatives mined from out-of-fold LTR rankings, the candidates the reranker actually sees at query time, for 2 epochs instead of 1.
- **An ensemble of two adapters.** The hybrid-negative adapter (v1) and the LTR-negative adapter (v2) are combined as the mean of z-scored scores. The ensemble beat either adapter alone on validation MRR (`models/reranker.json`).
- **A negative result: fine-tuning the embedder.** Contrastive LoRA on jina-code with in-batch and hard negatives did not improve hard-negative MRR on validation, so it was dropped.

Lite test, held out, final:

| | recall@1 | recall@5 | recall@10 | MRR |
|---|---|---|---|---|
| Function: LTR → LTR + CE ensemble | 0.344 → 0.407 | 0.643 → 0.706 | 0.729 → 0.772 | 0.497 → 0.560 |
| File: LTR → LTR + CE ensemble | 0.627 → 0.690 | 0.883 → 0.893 | 0.930 → 0.930 | 0.741 → 0.783 |

Significance:

- **Function level:** recall@1 +0.063 (p = 0.006), recall@5 +0.064 (p = 0.001), recall@10 +0.043 (p = 0.005) and MRR +0.063 (p < 0.001).
- **File level:** recall@1 +0.063 (p = 0.002) and MRR +0.042 (p < 0.001). File recall@10 is unchanged, as expected from a reranker that reorders only the top 20.

Latency grew with the second adapter: p50 is 3.3 s per function query on the laptop GPU (two reranker passes over 20 candidates). The file level reranks the units of more candidate files, so its p50 is 12 s. The system is built for accuracy over speed; the website's in-browser pipeline ([ADR 0010](0010-browser-ranker.md)) is the fast path.
