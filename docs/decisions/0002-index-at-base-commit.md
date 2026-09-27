# 0002: Index and label every issue at its base_commit

## Context

Each SWE-bench issue records the commit the fix was written against. Repositories keep moving afterwards, and later history contains the fix, its tests, and often refactors of the surrounding code.

## Decision

Ground truth is computed from files read at `base_commit`, and every retriever is required to index the repository at that same commit. Retrieving against HEAD is treated as a bug.

## Why

Indexing at HEAD leaks the answer. The fixed function may have been renamed, new helper functions added by the fix become retrievable, and embeddings see the post-fix code. Scores would look better and mean nothing.

## Implementation

Repositories are cloned once as bare, blobless mirrors (`--filter=blob:none`). Commits and trees for full history are local, and file contents are fetched on demand. All blobs needed for a repo's gold files are prefetched in one batched fetch, so building ground truth for all 300 issues takes about 15 seconds after the first clone instead of one network round trip per file.

## Consequences

Many issues share a repository but not a commit, so a naive index is rebuilt per issue. This is the motivation for content-addressed chunk storage in phase 5: most functions are byte-identical across nearby commits and should be parsed and embedded once.
