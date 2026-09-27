# 0004: Call-graph expansion is opt-in because it does not pay for itself

## Context

Failure analysis of plain BM25 showed a recurring pattern: the retriever finds the function the issue talks about, but the fix lives in something it calls. In `astropy__astropy-12907` BM25 ranks `separability_matrix` first, while the gold patch edits `_cstack`, its callee. Phase 4 was meant to exploit this.

## What was built

- Call sites are extracted with one Tree-sitter query per file (`call` nodes, keeping the final name of `f()` or `obj.attr.f()`), from the same parse the chunker already does.
- Names are resolved to units without type inference. A definition in the caller's own file wins. Otherwise every unit in the repository with that name is a candidate, and a call with more than 5 candidates is dropped as too ambiguous. Each call's weight is split across its candidates.
- The graph is built per snapshot entirely with array joins (sort definitions by interned name, `searchsorted` the call names, expand pairs with `np.repeat`), so it adds tens of milliseconds to an index build.
- Expansion normalizes BM25 scores by the best hit and adds `alpha * weight` to the callees (and optionally callers) of the top `seeds` hits, optionally damped by in-degree.

## How it was evaluated

Parameters were tuned only on a dev set: SWE-bench Verified minus every Lite instance, which is 407 issues (393 with a function target) from the same 12 repositories and zero overlap with the Lite test set (`odin tune`). One configuration was then run once on Lite test.

## Result

On dev, no setting beat BM25 by more than about half a point of recall@10, and every setting with `alpha >= 0.25` was clearly worse, because the boost lifts callees above the correct hit. Reserving the last slots of the top 10 for graph neighbors was also worse than plain BM25.

The reason is a low ceiling. Of the 151 dev issues BM25 misses at 10, the gold function is a one-hop neighbor of a top-5 hit in only 23 (15%), and each seed has about 8 neighbors. A perfect neighbor picker could add at most about 6 points of recall@10, and the actual signal is diluted about 40 to 1.

## Decision

Keep the graph (it is cheap and tested) and ship expansion as the opt-in retriever `bm25-code-notests-graph` with the dev-selected setting `alpha=0.1, seeds=1, indegree_power=0.5`. The default retriever stays plain BM25.

## What would change this

- Better candidates for the seeds, not better propagation: most misses fail because lexical search never reaches the right neighbourhood. Dense or hybrid retrieval attacks that directly.
- A learned reranker that sees the seed, its neighbours and the issue together, rather than a fixed additive boost.
- Type-aware resolution (e.g. via a language server), which would cut the eight-neighbour fan-out.
