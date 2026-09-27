# 0008: An embedding-store corruption bug: detection, cause, repair

## What happened

After an unrelated change (query vectors routed through the content-hash cache), rebuilt learning-to-rank features were obviously wrong. The hybrid baseline column dropped from recall@10 0.571 to 0.103, and candidate pools held 4,271 gold units instead of 5,600. A cached query vector had cosine 0.027 with the same query encoded directly.

## Cause

`EmbeddingStore.add` computed the next free row as `len(self._rows)`, the number of distinct keys. A batch containing the same key twice wrote two rows but advanced that count by one, so every later batch overwrote rows owned by other keys. `save` then wrote keys sorted by row next to sequential vectors, which on reload misaligned every entry after the first collision.

The first duplicates came from the "similar past issues" memory: SWE-bench contains 19 duplicate problem statements, and all 2,294 issues were embedded in one batch. Later, embedding an issue together with its title duplicated keys for the two one-line issues whose title is the whole text.

## Detection

The collapse was caught because every feature rebuild prints the hybrid baseline next to the learned model under the same cross-validation. A baseline that suddenly scores worse than BM25 alone cannot be a modelling effect.

## Fix

- `add` deduplicates within a batch, skips keys already stored, and appends through an explicit row-to-key list, keeping the invariant `rows[keys[i]] == i`. Loading rejects a file with duplicate keys.
- A regression test adds a batch with a repeated key followed by more batches, saves, reloads, and checks every vector.
- The store was repaired rather than rebuilt. Query-derived keys can be recomputed from the dataset, so the first row holding one marks where corruption began (row 201,194 of 205,444). The store was truncated there and the prefix verified by re-encoding 64 real functions from a Lite snapshot: minimum cosine 1.0000. Only 4,250 rows were lost, and they are recomputed on demand.

## Which results were affected

Unit embeddings written before the first bad batch were intact, so the BM25, dense, hybrid and first learning-to-rank results stand. The learning-to-rank v2 and LTR + cross-encoder numbers published before this fix used a "similar past issues" feature whose dense half was partly noise. They were re-measured on the repaired store with retrained models. The README reports only the re-measured numbers.

## Lesson

A content-addressed cache must treat "same key twice in one write" as a first-class case, and a cheap invariant check on load (one row per key) turns silent corruption into a loud error.
