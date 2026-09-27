from __future__ import annotations

import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from odin.index.snapshot import SnapshotIndex
from odin.rank.history import RepoHistory
from odin.rank.mentions import Mentions, module_name, path_matches
from odin.rank.past_issues import IssueMemory, PastEvidence
from odin.search.bm25 import top_k
from odin.search.dense import FusionParams, fuse, max_by_group
from odin.search.retriever import HybridRetriever, Query

FEATURES = [
    # lexical and dense evidence for the unit itself
    "bm25", "bm25_rel", "bm25_logrank",
    "dense", "dense_gap", "dense_logrank",
    "fused", "fused_logrank",
    # evidence for the unit's file (a file-then-function hierarchy, learned rather than hard)
    "file_bm25_rel", "file_bm25_logrank", "file_dense_gap", "file_dense_logrank",
    "file_fused_logrank", "rank_in_file", "units_in_file",
    # call-graph proximity to the strongest hits
    "callee_of_top", "caller_of_top",
    # shape of the unit
    "is_method", "is_class", "log_len", "is_private", "is_dunder", "is_init", "path_depth",
    "name_ambiguity",
    # explicit mentions in the issue
    "name_count", "name_in_code", "qual_mentioned", "class_count", "class_in_code",
    "frame_name", "frame_file", "frame_both", "last_frame_file", "last_frame_both",
    "path_mentioned", "module_mentioned", "stem_count",
    # the issue's fields scored separately: a title is denser than the whole report
    "title_bm25_rel", "title_bm25_logrank", "title_dense_gap", "title_dense_logrank",
    "code_bm25_rel", "code_bm25_logrank",
    # the file's git history before the base commit
    "file_hist_sim", "file_hist_logrank", "file_churn", "file_fix_churn",
    # earlier bug reports: what was fixed for similar issues, and how often, before this one
    "past_unit_sim", "past_unit_count", "past_file_sim", "past_file_count",
]  # fmt: skip

FILE_FEATURES = [
    "file_bm25_rel", "file_bm25_logrank", "file_dense_gap", "file_dense_logrank",
    "file_fused_logrank", "file_title_bm25_rel", "file_title_bm25_logrank",
    "file_hist_sim", "file_hist_logrank", "file_churn", "file_fix_churn",
    "path_mentioned", "module_mentioned", "stem_count", "frame_file", "last_frame_file",
    "units_in_file", "path_depth", "is_init_file",
    # the file's best units: a file is as relevant as the most relevant code in it
    "best_unit_fused_logrank", "best_unit_bm25_rel", "best_unit_dense_gap",
    "best_unit_title_dense_gap", "pool_units", "max_name_count", "any_name_in_code",
    "any_qual_mentioned", "any_frame_both",
    "past_file_sim", "past_file_count", "best_past_unit_sim",
]  # fmt: skip


@dataclass(slots=True)
class CandidateSet:
    ids: list[str]  # unit ids, function level
    rows: np.ndarray  # candidate -> unit index in the snapshot
    X: np.ndarray  # (candidates, len(FEATURES))
    fallback: np.ndarray  # fused score of every unit, to order non-candidates
    index: SnapshotIndex
    file_fallback: np.ndarray  # fused file score, to order files with no candidate
    file_rows: np.ndarray  # file candidates, as indices into index.files
    Xf: np.ndarray  # (file candidates, len(FILE_FEATURES))


_CODE = re.compile(r"```.*?```|`[^`\n]+`", re.S)
DEFAULT_HISTORY = Path(".cache/history")


def issue_fields(text: str) -> tuple[str, str]:
    """(title, code): SWE-bench issues start with the GitHub title on the first line."""
    title = next((line for line in text.splitlines() if line.strip()), "")
    return title, " ".join(_CODE.findall(text))


def _rel(scores: np.ndarray) -> np.ndarray:
    top = float(scores.max()) if len(scores) else 0.0
    return scores / top if top > 0 else np.zeros_like(scores)


def _logrank(scores: np.ndarray) -> np.ndarray:
    order = np.argsort(-scores, kind="stable")
    ranks = np.empty(len(scores))
    ranks[order] = np.arange(1, len(scores) + 1)
    return np.log(ranks)


class FeatureExtractor:
    """Turns one query against one snapshot into a candidate pool with ranking features.

    Candidates are the union of the lexical top-N, the dense top-N, every unit of the top
    files and the call-graph neighbours of the top hits. On the dev set that pool holds a
    gold unit for ~97% of issues, so the ranker's job is ordering, not recall.
    """

    def __init__(
        self,
        retriever: HybridRetriever,
        fusion: FusionParams,
        per_retriever: int = 100,
        top_files: int = 5,
        seeds: int = 5,
        history_dir: Path | None = DEFAULT_HISTORY,
        memory: IssueMemory | None = None,
    ) -> None:
        self.r = retriever
        self.memory = memory
        self._past = PastEvidence({}, {}, {}, {})
        self.history_dir = history_dir
        self._history: dict[str, RepoHistory] = {}
        self.fusion = fusion
        self.per_retriever = per_retriever
        self.top_files = top_files
        self.seeds = seeds
        self._snap_key: int | None = None
        self._names: list[str] = []
        self._name_counts: Counter[str] = Counter()

    def _snapshot_stats(self, index: SnapshotIndex) -> None:
        if self._snap_key != id(index):
            self._names = [i.rsplit("::", 1)[1].rsplit(".", 1)[-1] for i in index.ids]
            self._name_counts = Counter(self._names)
            self._snap_key = id(index)

    def extract(self, query: Query) -> CandidateSet:
        r = self.r
        title, code = issue_fields(query.text)
        # One batched encoder call for issue and title; later lookups hit the cache.
        r.embed_queries([query.text, title])
        _, lex, dense = r.scores(query, "function")
        fn = r._indexes["function"]
        _, file_lex = r.lexical_scores(query, "file")
        assert fn.file_of_doc is not None and fn.files is not None and fn.graph is not None
        self._snapshot_stats(fn)
        n_files = len(fn.files)
        file_of = fn.file_of_doc

        fused = fuse(lex, dense, self.fusion)
        file_dense = max_by_group(dense, file_of, n_files)
        file_fused = fuse(file_lex, file_dense, self.fusion)

        top_f = top_k(file_fused, self.top_files)
        seeds = top_k(fused, self.seeds)
        seed_vec = np.zeros(len(fused))
        seed_vec[seeds] = 1.0
        callee = fn.graph.T @ seed_vec
        caller = fn.graph @ seed_vec
        pool = set(top_k(lex, self.per_retriever).tolist())
        pool |= set(top_k(dense, self.per_retriever).tolist())
        pool |= set(np.nonzero(np.isin(file_of, top_f))[0].tolist())
        pool |= set(np.nonzero((callee > 0) | (caller > 0))[0].tolist())
        rows = np.array(sorted(pool), np.int64)

        # Rank of each unit among the units of its own file.
        order = np.lexsort((-fused, file_of))
        rank_in_file = np.empty(len(fused))
        first_of_file = np.r_[0, np.flatnonzero(np.diff(file_of[order])) + 1]
        run = np.arange(len(order)) - np.repeat(
            first_of_file, np.diff(np.r_[first_of_file, len(order)])
        )
        rank_in_file[order] = run
        units_in_file = np.bincount(file_of, minlength=n_files)

        m = Mentions.parse(query.text)
        vocab, tok = r.indexer.vocab, r.tokenize
        title_lex = fn.index.scores(vocab.lookup(tok(title)))
        code_lex = fn.index.scores(vocab.lookup(tok(code))) if code else np.zeros(len(lex))
        assert r._dense is not None
        title_dense = r._dense.scores(r.embed_queries([title])[0])

        hist = np.zeros(n_files)
        churn = np.zeros(n_files)
        fix_churn = np.zeros(n_files)
        if self.history_dir is not None:
            if query.repo not in self._history:
                self._history[query.repo] = RepoHistory(
                    r.indexer.cache, query.repo, self.history_dir
                )
            ev = self._history[query.repo].evidence(query.base_commit, query.text)
            for f, path in enumerate(fn.files):
                hist[f] = ev.similar.get(path, 0.0)
                churn[f] = ev.churn.get(path, 0)
                fix_churn[f] = ev.fix_churn.get(path, 0)
        past = (
            self.memory.evidence(query.instance_id, query.repo, query.text)
            if self.memory is not None
            else PastEvidence({}, {}, {}, {})
        )
        self._past = past
        lex_max = max(float(lex.max()), 1e-9)
        file_lex_max = max(float(file_lex.max()), 1e-9)
        finite_fd = file_dense[np.isfinite(file_dense)]
        fd_max = float(finite_fd.max()) if len(finite_fd) else 0.0
        fd = np.where(np.isfinite(file_dense), file_dense, fd_max - 2.0)
        cols = {
            "bm25": lex[rows],
            "bm25_rel": lex[rows] / lex_max,
            "bm25_logrank": _logrank(lex)[rows],
            "dense": dense[rows],
            "dense_gap": dense[rows] - dense.max(),
            "dense_logrank": _logrank(dense)[rows],
            "fused": fused[rows],
            "fused_logrank": _logrank(fused)[rows],
            "file_bm25_rel": (file_lex / file_lex_max)[file_of[rows]],
            "file_bm25_logrank": _logrank(file_lex)[file_of[rows]],
            "file_dense_gap": (fd - fd_max)[file_of[rows]],
            "file_dense_logrank": _logrank(fd)[file_of[rows]],
            "file_fused_logrank": _logrank(file_fused)[file_of[rows]],
            "rank_in_file": np.log1p(rank_in_file[rows]),
            "units_in_file": np.log1p(units_in_file[file_of[rows]]),
            "callee_of_top": callee[rows],
            "caller_of_top": caller[rows],
            "log_len": np.log1p(fn.index.lengths[rows]),
            "title_bm25_rel": _rel(title_lex)[rows],
            "title_bm25_logrank": _logrank(title_lex)[rows],
            "title_dense_gap": title_dense[rows] - title_dense.max(),
            "title_dense_logrank": _logrank(title_dense)[rows],
            "code_bm25_rel": _rel(code_lex)[rows],
            "code_bm25_logrank": _logrank(code_lex)[rows],
            "file_hist_sim": _rel(hist)[file_of[rows]],
            "file_hist_logrank": _logrank(hist)[file_of[rows]],
            "file_churn": np.log1p(churn)[file_of[rows]],
            "file_fix_churn": np.log1p(fix_churn)[file_of[rows]],
        }
        X = np.zeros((len(rows), len(FEATURES)), np.float32)
        col = {f: i for i, f in enumerate(FEATURES)}
        for name, values in cols.items():
            X[:, col[name]] = values

        last_path, last_name = m.last_frame or ("", "")
        for k, row in enumerate(rows):
            path, qual = fn.ids[row].split("::", 1)
            parts = qual.split(".")
            name = parts[-1]
            cls = parts[-2] if len(parts) > 1 else ""
            in_frames = any(path_matches(p, path) for p in m.frame_paths)
            x = X[k]
            x[col["is_method"]] = len(parts) > 1
            x[col["is_class"]] = name[:1].isupper()
            x[col["is_private"]] = name.startswith("_") and not name.startswith("__")
            x[col["is_dunder"]] = name.startswith("__")
            x[col["is_init"]] = name == "__init__"
            x[col["path_depth"]] = path.count("/")
            x[col["name_ambiguity"]] = math.log(self._name_counts[name])
            x[col["name_count"]] = math.log1p(m.idents[name]) if len(name) > 2 else 0.0
            x[col["name_in_code"]] = name in m.code_idents
            x[col["qual_mentioned"]] = len(parts) > 1 and qual in m.dotted
            x[col["class_count"]] = math.log1p(m.idents[cls]) if cls else 0.0
            x[col["class_in_code"]] = bool(cls) and cls in m.code_idents
            x[col["frame_name"]] = name in m.frame_names
            x[col["frame_file"]] = in_frames
            x[col["frame_both"]] = in_frames and name in m.frame_names
            last_file = bool(last_path) and path_matches(last_path, path)
            x[col["last_frame_file"]] = last_file
            x[col["last_frame_both"]] = last_file and name == last_name
            x[col["path_mentioned"]] = any(path_matches(p, path) for p in m.py_paths)
            mod = module_name(path)
            x[col["module_mentioned"]] = (
                mod in m.dotted or ".".join(mod.split(".")[-2:]) in m.dotted
            )
            stem = path.rsplit("/", 1)[-1].removesuffix(".py")
            x[col["stem_count"]] = math.log1p(m.idents[stem]) if stem != "__init__" else 0.0
            uid = fn.ids[row]
            x[col["past_unit_sim"]] = past.unit_sim.get(uid, 0.0)
            x[col["past_unit_count"]] = math.log1p(past.unit_count.get(uid, 0))
            x[col["past_file_sim"]] = past.file_sim.get(path, 0.0)
            x[col["past_file_count"]] = math.log1p(past.file_count.get(path, 0))
        file_rows, Xf = self._file_features(
            query, fn, m, rows, X, col, file_lex, fd, fd_max, file_fused, hist, churn, fix_churn,
            units_in_file, title,
        )  # fmt: skip
        return CandidateSet(
            ids=[fn.ids[i] for i in rows],
            rows=rows,
            X=X,
            fallback=fused,
            index=fn,
            file_fallback=file_fused,
            file_rows=file_rows,
            Xf=Xf,
        )

    def _file_features(
        self, query, fn, m, rows, X, col, file_lex, fd, fd_max, file_fused, hist, churn,
        fix_churn, units_in_file, title,
    ) -> tuple[np.ndarray, np.ndarray]:  # fmt: skip
        files = fn.files
        file_of_row = fn.file_of_doc[rows]
        mentioned = [
            f
            for f, path in enumerate(files)
            if any(path_matches(p, path) for p in (*m.py_paths, *m.frame_paths))
        ]
        pool = set(file_of_row.tolist()) | set(top_k(file_fused, 50).tolist()) | set(mentioned)
        frows = np.array(sorted(pool), np.int64)
        pos = {f: i for i, f in enumerate(frows)}
        n = len(frows)

        def agg(values: np.ndarray, how: np.ufunc, empty: float) -> np.ndarray:
            out = np.full(n, empty, np.float32)
            how.at(out, [pos[f] for f in file_of_row], values)
            return out

        title_file = self.r._indexes["file"].index.scores(
            self.r.indexer.vocab.lookup(self.r.tokenize(title))
        )
        cfile = {f: i for i, f in enumerate(FILE_FEATURES)}
        Xf = np.zeros((n, len(FILE_FEATURES)), np.float32)
        cols = {
            "file_bm25_rel": _rel(file_lex)[frows],
            "file_bm25_logrank": _logrank(file_lex)[frows],
            "file_dense_gap": (fd - fd_max)[frows],
            "file_dense_logrank": _logrank(fd)[frows],
            "file_fused_logrank": _logrank(file_fused)[frows],
            "file_title_bm25_rel": _rel(title_file)[frows],
            "file_title_bm25_logrank": _logrank(title_file)[frows],
            "file_hist_sim": _rel(hist)[frows],
            "file_hist_logrank": _logrank(hist)[frows],
            "file_churn": np.log1p(churn)[frows],
            "file_fix_churn": np.log1p(fix_churn)[frows],
            "units_in_file": np.log1p(units_in_file[frows]),
            "best_unit_fused_logrank": agg(X[:, col["fused_logrank"]], np.minimum, 15.0),
            "best_unit_bm25_rel": agg(X[:, col["bm25_rel"]], np.maximum, 0.0),
            "best_unit_dense_gap": agg(X[:, col["dense_gap"]], np.maximum, -2.0),
            "best_unit_title_dense_gap": agg(X[:, col["title_dense_gap"]], np.maximum, -2.0),
            "pool_units": np.log1p(agg(np.ones(len(rows)), np.add, 0.0)),
            "max_name_count": agg(X[:, col["name_count"]], np.maximum, 0.0),
            "any_name_in_code": agg(X[:, col["name_in_code"]], np.maximum, 0.0),
            "any_qual_mentioned": agg(X[:, col["qual_mentioned"]], np.maximum, 0.0),
            "any_frame_both": agg(X[:, col["frame_both"]], np.maximum, 0.0),
            "best_past_unit_sim": agg(X[:, col["past_unit_sim"]], np.maximum, 0.0),
        }
        for name, values in cols.items():
            Xf[:, cfile[name]] = values
        last_path = m.last_frame[0] if m.last_frame else ""
        for i, f in enumerate(frows):
            path = files[f]
            mod = module_name(path)
            stem = path.rsplit("/", 1)[-1].removesuffix(".py")
            x = Xf[i]
            x[cfile["path_mentioned"]] = any(path_matches(p, path) for p in m.py_paths)
            x[cfile["module_mentioned"]] = (
                mod in m.dotted or ".".join(mod.split(".")[-2:]) in m.dotted
            )
            x[cfile["stem_count"]] = math.log1p(m.idents[stem]) if stem != "__init__" else 0.0
            x[cfile["frame_file"]] = any(path_matches(p, path) for p in m.frame_paths)
            x[cfile["last_frame_file"]] = bool(last_path) and path_matches(last_path, path)
            x[cfile["path_depth"]] = path.count("/")
            x[cfile["is_init_file"]] = stem == "__init__"
            x[cfile["past_file_sim"]] = self._past.file_sim.get(path, 0.0)
            x[cfile["past_file_count"]] = math.log1p(self._past.file_count.get(path, 0))
        return frows, Xf
