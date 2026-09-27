from __future__ import annotations

import pickle
import re
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from odin.repos import RepoCache, _git
from odin.search.bm25 import BM25Index, Vocab, top_k
from odin.search.tokenize import code_counts

_FIX = re.compile(r"\b(fix(e[sd])?|bug|regression|crash|error|incorrect|wrong)\b", re.I)
YEAR = 365 * 24 * 3600


@dataclass(frozen=True, slots=True)
class FileHistory:
    """History evidence per file path, computed from ancestors of one commit only."""

    similar: dict[str, float]  # how much commits resembling the issue touched the file
    churn: dict[str, int]  # commits touching the file in the preceding year
    fix_churn: dict[str, int]  # of those, commits whose message looks like a fix


class RepoHistory:
    """Commit messages and changed files for one repository, searchable per base commit.

    Bug localization research (BugLocator, Locus) finds that code fixed often, and code
    fixed by commits worded like the new report, is likely to be fixed again. Only commits
    reachable from the issue's base commit are used, so the fix itself can never leak in.
    """

    def __init__(self, cache: RepoCache, repo: str, cache_dir: Path) -> None:
        self.cache = cache
        self.repo = repo
        path = cache_dir / f"{repo.replace('/', '__')}.v2.pkl"
        if path.exists():
            self.hashes, self.times, self.messages, self.files, parent_hashes = pickle.loads(
                path.read_bytes()
            )
        else:
            parent_hashes = self._load_log()
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = (self.hashes, self.times, self.messages, self.files, parent_hashes)
            path.write_bytes(pickle.dumps(payload, protocol=5))
        self.row = {h: i for i, h in enumerate(self.hashes)}
        # The commit DAG as row indices, so ancestry is an in-memory walk, not a subprocess.
        self.parents = [tuple(self.row[p] for p in ps if p in self.row) for ps in parent_hashes]
        # Commit -> changed file ids in CSR form, so churn is a gather plus a bincount.
        path_id: dict[str, int] = {}
        ids = [path_id.setdefault(f, len(path_id)) for fs in self.files for f in fs]
        self.paths = list(path_id)
        self.file_ids = np.array(ids, np.int64)
        self.file_ptr = np.r_[0, np.cumsum([len(fs) for fs in self.files])].astype(np.int64)
        self.fix = np.array([bool(_FIX.search(m)) for m in self.messages])
        vocab = Vocab()
        self.vocab = vocab
        self.index = BM25Index.from_docs(
            [vocab.vectorize(code_counts(m)) for m in self.messages], len(vocab)
        )
        self._ancestors: dict[str, np.ndarray] = {}

    def _load_log(self) -> None:
        mirror = self.cache.ensure_mirror(self.repo)
        out = _git(
            ["log", "--all", "--no-renames", "--name-only", "--format=%x00%H %ct %P%n%B%x01"],
            cwd=mirror,
        ).decode("utf-8", "replace")
        self.hashes, self.times, self.messages, self.files = [], [], [], []
        parents: list[list[str]] = []
        for rec in out.split("\0")[1:]:
            head, _, rest = rec.partition("\n")
            message, _, names = rest.partition("\x01")
            h, t, *ps = head.split()
            parents.append(ps)
            self.hashes.append(h)
            self.times.append(int(t))
            self.messages.append(message.strip())
            self.files.append([n for n in names.split("\n") if n.endswith(".py")])
        self.times = np.array(self.times, np.int64)
        return parents

    def ancestors(self, commit: str) -> np.ndarray:
        """Rows of commits reachable from `commit`, excluding `commit` itself.

        All parents are followed (not just the first), and a root commit has none.
        """
        if commit not in self._ancestors:
            start = self.row.get(commit)
            if start is None:  # not reachable from any logged ref: ask git
                out = _git(["rev-list", commit], cwd=self.cache.ensure_mirror(self.repo))
                rows = [self.row[h] for h in out.decode().split() if h in self.row and h != commit]
            else:
                seen = bytearray(len(self.hashes))
                stack = list(self.parents[start])
                rows = []
                while stack:
                    r = stack.pop()
                    if not seen[r]:
                        seen[r] = 1
                        rows.append(r)
                        stack.extend(self.parents[r])
            self._ancestors[commit] = np.sort(np.array(rows, np.int64))
        return self._ancestors[commit]

    def _count_files(self, rows: np.ndarray) -> dict[str, int]:
        """How many of these commits touched each file: one gather and one bincount."""
        if not len(rows):
            return {}
        starts = self.file_ptr[rows]
        lengths = self.file_ptr[rows + 1] - starts
        if not lengths.sum():
            return {}
        # Flatten the CSR row slices: entry j of commit i sits at starts[i] + j.
        offsets = np.repeat(starts - np.r_[0, np.cumsum(lengths)[:-1]], lengths)
        counts = np.bincount(self.file_ids[np.arange(lengths.sum()) + offsets])
        return {self.paths[i]: int(counts[i]) for i in np.flatnonzero(counts)}

    def evidence(self, commit: str, issue: str, top: int = 50) -> FileHistory:
        rows = self.ancestors(commit)
        if not len(rows):
            return FileHistory({}, {}, {})
        base_time = self.times[self.row[commit]] if commit in self.row else self.times[rows].max()
        scores = self.index.scores(self.vocab.lookup(code_counts(issue)))[rows]
        similar: dict[str, float] = defaultdict(float)
        for j in top_k(scores, top):
            if scores[j] <= 0:
                break
            touched = self.files[rows[j]]
            for f in touched:
                similar[f] += float(scores[j]) / np.sqrt(len(touched))
        recent = rows[self.times[rows] >= base_time - YEAR]
        churn = self._count_files(recent)
        fix_churn = self._count_files(recent[self.fix[recent]])
        return FileHistory(dict(similar), churn, fix_churn)
