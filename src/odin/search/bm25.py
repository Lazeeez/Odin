from __future__ import annotations

from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass

import numpy as np
import scipy.sparse as sp

# A sparse term-frequency vector: parallel arrays of term ids and counts.
TermVec = tuple[np.ndarray, np.ndarray]

EMPTY: TermVec = (np.zeros(0, np.int32), np.zeros(0, np.float32))


def _counts(tokens: Mapping[str, int] | Iterable[str]) -> Mapping[str, int]:
    return tokens if isinstance(tokens, Mapping) else Counter(tokens)


class Vocab:
    """Maps terms to dense column ids. Shared by every index built in one process."""

    def __init__(self) -> None:
        self._ids: dict[str, int] = {}

    def __len__(self) -> int:
        return len(self._ids)

    def vectorize(self, tokens: Mapping[str, int] | Iterable[str]) -> TermVec:
        counts = _counts(tokens)
        ids = self._ids
        n = len(counts)
        return (
            np.fromiter((ids.setdefault(t, len(ids)) for t in counts), np.int32, n),
            np.fromiter(counts.values(), np.float32, n),
        )

    def intern(self, terms: Sequence[str]) -> np.ndarray:
        """Ids for distinct terms, adding unseen ones. Usable as a lookup table."""
        ids = self._ids
        return np.fromiter((ids.setdefault(t, len(ids)) for t in terms), np.int32, len(terms))

    def lookup(self, tokens: Mapping[str, int] | Iterable[str]) -> TermVec:
        """Vectorize a query. Terms never seen in any document cannot score, so drop them."""
        known = {t: c for t, c in _counts(tokens).items() if t in self._ids}
        return (
            np.fromiter((self._ids[t] for t in known), np.int32, len(known)),
            np.fromiter(known.values(), np.float32, len(known)),
        )


@dataclass(frozen=True, slots=True)
class BM25Params:
    k1: float = 1.2
    b: float = 0.75


def tf_matrix(docs: Sequence[TermVec], n_terms: int) -> sp.csc_matrix:
    rows = np.repeat(np.arange(len(docs), dtype=np.int32), [len(d[0]) for d in docs])
    cols = np.concatenate([d[0] for d in docs]) if docs else EMPTY[0]
    tf = np.concatenate([d[1] for d in docs]) if docs else EMPTY[1]
    return sp.csc_matrix((tf, (rows, cols)), shape=(len(docs), n_terms))


class BM25Index:
    """Okapi BM25 with every document-side weight precomputed into a CSC matrix.

    Scoring slices the query's columns and does one sparse mat-vec, so cost scales with the
    postings of the query terms, not with the corpus.
    """

    def __init__(self, tf: sp.spmatrix, params: BM25Params | None = None) -> None:
        params = params or BM25Params()
        m = sp.csc_matrix(tf, dtype=np.float32)
        m.sum_duplicates()
        n_docs, n_terms = m.shape

        lengths = np.asarray(m.sum(axis=1)).ravel()
        avgdl = max(float(lengths.mean()), 1e-9) if n_docs else 1.0
        df = np.diff(m.indptr)
        self.idf = np.log1p((n_docs - df + 0.5) / (df + 0.5)).astype(np.float32)

        k1, b = params.k1, params.b
        doc_norm = (k1 * (1 - b + b * lengths / avgdl)).astype(np.float32)
        term_of_entry = np.repeat(np.arange(n_terms), df)
        m.data = self.idf[term_of_entry] * m.data * (k1 + 1) / (m.data + doc_norm[m.indices])
        self.matrix = m
        self.n_docs = n_docs
        self.lengths = lengths  # tokens per document, a useful ranking feature

    @classmethod
    def from_docs(
        cls, docs: Sequence[TermVec], n_terms: int, params: BM25Params | None = None
    ) -> BM25Index:
        return cls(tf_matrix(docs, n_terms), params)

    def scores(self, query: TermVec) -> np.ndarray:
        ids, qtf = query
        keep = ids < self.matrix.shape[1]
        ids, qtf = ids[keep], qtf[keep]
        if not len(ids):
            return np.zeros(self.n_docs, np.float32)
        return self.matrix[:, ids] @ qtf


def top_k(scores: np.ndarray, k: int) -> np.ndarray:
    """Indices of the k best scores, best first, ties broken by index for determinism."""
    k = min(k, len(scores))
    if k == 0:
        return np.zeros(0, np.int64)
    part = np.argpartition(-scores, k - 1)[:k]
    return part[np.lexsort((part, -scores[part]))]
