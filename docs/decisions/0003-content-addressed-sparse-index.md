# 0003: Content-addressed chunks and a precomputed sparse BM25 matrix

## Context

Every SWE-bench issue must be searched against its own `base_commit` (0002). Lite has 300 issues over 12 repositories and 300 distinct commits, so a naive engine indexes 300 full repositories, 451k Python files in total. Measured: 90% of them are byte-identical to the same file in a snapshot already indexed, so only 45k blobs are ever parsed.

## Decision

**Key derived work by git blob id.** A snapshot is the commit's tree listing (`git ls-tree`, local in a blobless mirror). Each blob is read once through a single long-lived `git cat-file --batch` process, chunked with Tree-sitter, tokenized and vectorized, and the result is memoized by object id. Building any later snapshot only processes blobs it has not seen. Path tokens are kept out of the blob memo because the same blob can live at different paths.

**Fetch in bulk, never lazily.** Before evaluation the runner collects every source blob id across all needed commits, asks git which are absent (`cat-file --batch-check` with `GIT_NO_LAZY_FETCH=1`), and fetches them in one `git fetch --stdin` per repository. The previous path of one lazy fetch per missing object would be tens of thousands of round trips.

**Precompute BM25 into the matrix.** Documents are rows of a scipy CSC matrix whose entries are already `idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))`. A query is a column slice plus one sparse mat-vec, so query cost scales with the postings of the query's terms rather than with the corpus, and there is no Python loop over documents.

**Chunk = the unit ground truth is labelled with.** Non-nested functions, methods and classes each get a chunk. A class chunk holds only the lines its methods do not own (header, docstring, attributes), so evidence for "the class" and "a method" is not blended. Lines outside every unit form a module chunk that contributes to file-level search only.

## Alternatives considered

- **Re-read files with `git cat-file blob` per file.** Two subprocesses per file. Fine for 300 gold files, far too slow for full snapshots.
- **Check out a worktree per commit.** Writes 250k files to disk and still needs dedup to avoid re-parsing.
- **A persistent inverted index (Lucene/Tantivy).** Faster in steady state, but hides the scoring function, and a per-commit on-disk index loses the cross-commit sharing that makes this cheap.

## Consequences

- Index build time is dominated by first-seen blobs. It is reported separately from query latency (`index_ms_*` vs `latency_ms_*`) so neither hides the other.
- The vocabulary is process-global and only grows; memory is bounded by dropping the blob memo when the runner moves to the next repository (issues are grouped by repo).
- The same memo is the natural place to cache dense embeddings per chunk hash in the hybrid phase.
