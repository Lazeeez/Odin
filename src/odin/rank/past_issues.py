from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np

from odin.eval.dataset import Instance
from odin.eval.ground_truth import GoldEntry
from odin.search.bm25 import BM25Index, Vocab, top_k
from odin.search.tokenize import code_counts

# A fix is only usable once merged. SWE-bench records when a pull request was opened, not
# merged, so a past issue must predate the query by this margin to count as history.
MERGE_MARGIN = timedelta(days=30)


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


@dataclass(frozen=True, slots=True)
class PastEvidence:
    unit_sim: dict[str, float]  # unit id -> similarity mass of past issues that fixed it
    file_sim: dict[str, float]
    unit_count: dict[str, int]  # how many earlier fixes touched the unit at all
    file_count: dict[str, int]


class IssueMemory:
    """Fixed bug reports of a project, searchable as of any point in time.

    This is the "similar bug reports" signal of BugLocator: code that was changed to fix
    reports resembling the new one is likely to need changing again. Only issues opened
    before the query (with a merge margin) are visible, and never the query itself.
    """

    def __init__(
        self,
        instances: list[Instance],
        gold: list[GoldEntry],
        embed=None,
        top: int = 10,
    ) -> None:
        by_id = {g.instance_id: g for g in gold}
        self.items = [i for i in instances if i.instance_id in by_id and i.created_at]
        self.gold = [by_id[i.instance_id] for i in self.items]
        self.created = {i.instance_id: _parse(i.created_at) for i in self.items}
        self.times = np.array([self.created[i.instance_id].timestamp() for i in self.items])
        self.repos = np.array([i.repo for i in self.items])
        self.top = top
        vocab = Vocab()
        self.vocab = vocab
        self.bm25 = BM25Index.from_docs(
            [vocab.vectorize(code_counts(i.problem_statement)) for i in self.items], len(vocab)
        )
        # texts -> unit vectors; optional, adds dense similarity to the lexical one
        self.embed = embed
        self._vecs: np.ndarray | None = None

    def _dense(self) -> np.ndarray | None:
        if self.embed is None:
            return None
        if self._vecs is None:
            self._vecs = self.embed([i.problem_statement for i in self.items])
        return self._vecs

    def evidence(self, instance_id: str, repo: str, text: str) -> PastEvidence:
        now = self.created.get(instance_id)
        cutoff = (now - MERGE_MARGIN).timestamp() if now else float("inf")
        visible = (self.repos == repo) & (self.times < cutoff)
        visible &= np.array([i.instance_id != instance_id for i in self.items])
        rows = np.flatnonzero(visible)
        unit_sim: dict[str, float] = defaultdict(float)
        file_sim: dict[str, float] = defaultdict(float)
        unit_count: dict[str, int] = defaultdict(int)
        file_count: dict[str, int] = defaultdict(int)
        if not len(rows):
            return PastEvidence({}, {}, {}, {})
        for r in rows:
            g = self.gold[r]
            for u in g.functions + g.classes:
                unit_count[u] += 1
            for f in g.files:
                file_count[f] += 1

        lex = self.bm25.scores(self.vocab.lookup(code_counts(text)))[rows]
        sim = lex / lex.max() if lex.max() > 0 else np.zeros(len(rows))
        vecs = self._dense()
        if vecs is not None and self.embed is not None:
            dense = vecs[rows] @ self.embed([text])[0]
            sim = 0.5 * sim + 0.5 * np.clip(dense, 0, None) / max(float(dense.max()), 1e-9)
        for j in top_k(sim, self.top):
            if sim[j] <= 0:
                break
            g = self.gold[rows[j]]
            for u in g.functions + g.classes:
                unit_sim[u] += float(sim[j])
            for f in g.files:
                file_sim[f] += float(sim[j])
        return PastEvidence(dict(unit_sim), dict(file_sim), dict(unit_count), dict(file_count))
