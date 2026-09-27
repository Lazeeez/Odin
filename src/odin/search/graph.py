from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp

from odin.search.bm25 import top_k


@dataclass(frozen=True, slots=True)
class ExpandParams:
    """One-hop call-graph expansion. `alpha=0` is plain BM25."""

    alpha: float = 0.0
    callers: float = 0.0
    seeds: int = 20
    # Damp the boost into units with many callers: a helper called from everywhere says little.
    indegree_power: float = 0.0

    def __str__(self) -> str:
        return (
            f"alpha={self.alpha} callers={self.callers} seeds={self.seeds}"
            f" indeg^{self.indegree_power}"
        )


def expand(scores: np.ndarray, graph: sp.csr_matrix, p: ExpandParams) -> np.ndarray:
    """Lend the lexical score of the best hits to the units they call (and are called by).

    Bug reports describe symptoms at the API surface, while the fix often lives one call
    below (`separability_matrix` -> `_cstack`). Only the top `seeds` hits propagate, so a
    long tail of weak matches cannot pile onto a popular helper. Scores are normalized by the
    best hit, which keeps `alpha` comparable across queries.
    """
    if p.alpha <= 0 or graph is None or not len(scores):
        return scores
    best = scores.max()
    if best <= 0:
        return scores
    seeds = top_k(scores, p.seeds)
    seed = np.zeros_like(scores)
    seed[seeds] = scores[seeds] / best
    boost = graph.T @ seed
    if p.callers:
        boost += p.callers * (graph @ seed)
    if p.indegree_power:
        indegree = np.maximum(np.diff(graph.tocsc().indptr), 1)
        boost /= indegree**p.indegree_power
    return scores / best + p.alpha * boost
