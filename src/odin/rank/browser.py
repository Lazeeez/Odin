"""Ranking features a browser can compute, shared by the website and its training script.

The website (web/src/engine/rank.ts) computes exactly these for a repository it has indexed in
the visitor's browser; scripts/browser_ltr.py computes them here to train and evaluate the
model it runs. tests/test_site_engine.py checks the two agree feature by feature.
"""

from __future__ import annotations

import math
from collections import Counter

import numpy as np

from odin.rank.features import _logrank, _rel
from odin.rank.mentions import Mentions, module_name, path_matches
from odin.search.bm25 import top_k

FEATURES = [
    "bm25_rel", "bm25_logrank", "title_bm25_rel", "title_bm25_logrank",
    "code_bm25_rel", "code_bm25_logrank",
    "file_max_rel", "file_max_logrank", "file_sum_rel", "file_sum_logrank",
    "rank_in_file", "units_in_file",
    "is_method", "is_class", "log_len", "is_private", "is_dunder", "is_init", "path_depth",
    "name_ambiguity",
    "name_count", "name_in_code", "qual_mentioned", "class_count", "class_in_code",
    "frame_name", "frame_file", "frame_both", "last_frame_file", "last_frame_both",
    "path_mentioned", "module_mentioned", "stem_count",
]  # fmt: skip
STAGE2 = ["s1_logrank", "dense_gap", "dense_logrank", "title_dense_gap", "title_dense_logrank"]
# Static-embedding similarity over every unit of the repository (computed in the background
# in the browser): semantic candidates keyword search cannot reach, and evidence for all.
SEMANTIC = [
    "sem", "sem_gap", "sem_logrank", "title_sem_gap", "title_sem_logrank",
    "file_sem_gap", "file_sem_logrank",
]  # fmt: skip

POOL = dict(bm25=100, title=20, code=20, files=5, sem=50, title_sem=20)


def semantic_columns(fn, sem: np.ndarray, title_sem: np.ndarray, rows: np.ndarray) -> np.ndarray:
    """SEMANTIC features for `rows`, from cosine similarities of every unit to issue and title."""
    n_files = len(fn.files)
    file_best = np.full(n_files, -1.0)
    np.maximum.at(file_best, fn.file_of_doc, sem)
    fo = fn.file_of_doc[rows]
    return np.stack([
        sem[rows], sem[rows] - sem.max(), _logrank(sem)[rows],
        title_sem[rows] - title_sem.max(), _logrank(title_sem)[rows],
        (file_best - file_best.max())[fo], _logrank(file_best)[fo],
    ], axis=1).astype(np.float32)  # fmt: skip


def extract(
    fn,
    lex,
    title_lex,
    code_lex,
    m: Mentions,
    names: Counter,
    sem: np.ndarray | None = None,
    title_sem: np.ndarray | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Candidate pool and its features, for one query against one snapshot's function index.

    With `sem`/`title_sem` (similarity of every unit to the issue and its title), the pool
    also takes the semantic top candidates and the SEMANTIC columns are appended.
    """  # fmt: skip
    n_files = len(fn.files)
    file_of = fn.file_of_doc
    file_max = np.zeros(n_files)
    np.maximum.at(file_max, file_of, lex)
    file_sum = np.bincount(file_of, weights=lex, minlength=n_files)
    units_in_file = np.bincount(file_of, minlength=n_files)

    pool = {int(i) for i in top_k(lex, POOL["bm25"]) if lex[i] > 0}
    pool |= {int(i) for i in top_k(title_lex, POOL["title"]) if title_lex[i] > 0}
    pool |= {int(i) for i in top_k(code_lex, POOL["code"]) if code_lex[i] > 0}
    if sem is not None and title_sem is not None:
        pool |= {int(i) for i in top_k(sem, POOL["sem"])} | {
            int(i) for i in top_k(title_sem, POOL["title_sem"])
        }
    top_files = {int(f) for f in top_k(file_max, POOL["files"]) if file_max[f] > 0}
    mentioned = {
        f for f, p in enumerate(fn.files)
        if any(path_matches(x, p, m.multilang) for x in (*m.frame_paths, *m.py_paths))
    }  # fmt: skip
    wanted = {n for n, c in m.idents.items() if len(n) > 2} | m.frame_names
    for d, uid in enumerate(fn.ids):
        name = uid.rsplit("::", 1)[1].rsplit(".", 1)[-1]
        f = int(file_of[d])
        if (
            f in top_files
            or (f in mentioned and name in wanted)
            or (name in m.code_idents and len(name) > 2)
        ) or uid.split("::", 1)[1] in m.dotted:
            pool.add(d)
    rows = np.array(sorted(pool), np.int64)
    if not len(rows):
        width = len(FEATURES) + (len(SEMANTIC) if sem is not None else 0)
        return rows, np.zeros((0, width), np.float32)

    # rank of each unit among its file's units, by BM25 (ties: document order)
    order = np.lexsort((np.arange(len(lex)), -lex, file_of))
    rank_in_file = np.empty(len(lex))
    starts = np.r_[0, np.flatnonzero(np.diff(file_of[order])) + 1]
    rank_in_file[order] = np.arange(len(order)) - np.repeat(
        starts, np.diff(np.r_[starts, len(order)])
    )

    fo = file_of[rows]
    cols = {
        "bm25_rel": _rel(lex)[rows], "bm25_logrank": _logrank(lex)[rows],
        "title_bm25_rel": _rel(title_lex)[rows], "title_bm25_logrank": _logrank(title_lex)[rows],
        "code_bm25_rel": _rel(code_lex)[rows], "code_bm25_logrank": _logrank(code_lex)[rows],
        "file_max_rel": _rel(file_max)[fo], "file_max_logrank": _logrank(file_max)[fo],
        "file_sum_rel": _rel(file_sum)[fo], "file_sum_logrank": _logrank(file_sum)[fo],
        "rank_in_file": np.log1p(rank_in_file[rows]), "units_in_file": np.log1p(units_in_file[fo]),
        "log_len": np.log1p(fn.index.lengths[rows]),
    }  # fmt: skip
    col = {f: i for i, f in enumerate(FEATURES)}
    X = np.zeros((len(rows), len(FEATURES)), np.float32)
    for name, values in cols.items():
        X[:, col[name]] = values
    last_path, last_name = m.last_frame or ("", "")
    for k, row in enumerate(rows):
        path, qual = fn.ids[row].split("::", 1)
        parts = qual.split(".")
        name = parts[-1]
        cls = parts[-2] if len(parts) > 1 else ""
        in_frames = any(path_matches(p, path, m.multilang) for p in m.frame_paths)
        last_file = bool(last_path) and path_matches(last_path, path, m.multilang)
        mod = module_name(path, m.multilang)
        stem = path.rsplit("/", 1)[-1].removesuffix(".py")
        x = X[k]
        x[col["is_method"]] = len(parts) > 1
        x[col["is_class"]] = name[:1].isupper()
        x[col["is_private"]] = name.startswith("_") and not name.startswith("__")
        x[col["is_dunder"]] = name.startswith("__")
        x[col["is_init"]] = name == "__init__"
        x[col["path_depth"]] = path.count("/")
        x[col["name_ambiguity"]] = math.log(names[name])
        x[col["name_count"]] = math.log1p(m.idents[name]) if len(name) > 2 else 0.0
        x[col["name_in_code"]] = name in m.code_idents
        x[col["qual_mentioned"]] = len(parts) > 1 and qual in m.dotted
        x[col["class_count"]] = math.log1p(m.idents[cls]) if cls else 0.0
        x[col["class_in_code"]] = bool(cls) and cls in m.code_idents
        x[col["frame_name"]] = name in m.frame_names
        x[col["frame_file"]] = in_frames
        x[col["frame_both"]] = in_frames and name in m.frame_names
        x[col["last_frame_file"]] = last_file
        x[col["last_frame_both"]] = last_file and name == last_name
        x[col["path_mentioned"]] = any(path_matches(p, path, m.multilang) for p in m.py_paths)
        x[col["module_mentioned"]] = mod in m.dotted or ".".join(mod.split(".")[-2:]) in m.dotted
        x[col["stem_count"]] = math.log1p(m.idents[stem]) if stem != "__init__" else 0.0
    if sem is not None and title_sem is not None:
        X = np.hstack([X, semantic_columns(fn, sem, title_sem, rows)])
    return rows, X


def predict(stage: dict, x: np.ndarray) -> float:
    """Score one feature row with exported trees (the format web/src/engine/rank.ts reads)."""
    s = 0.0
    for tree in stage["trees"]:
        if "f" not in tree:
            s += tree["v"][0]
            continue
        node = 0
        while node >= 0:
            # float32 on both sides, as LightGBM trained (thresholds are exported as float32)
            go_left = np.float32(x[tree["f"][node]]) <= np.float32(tree["t"][node])
            node = tree["l"][node] if go_left else tree["r"][node]
        s += tree["v"][~node]
    return s


FILE_FEATURES = [
    # the file's best function, as the semantic stage scored it
    "best_score_gap", "best_score_logrank", "pool_units",
    # keyword evidence for the whole file (over its functions)
    "file_max_rel", "file_max_logrank", "file_sum_rel", "file_sum_logrank",
    "title_max_rel", "title_max_logrank", "code_max_rel",
    # semantic evidence: the file's closest function to the issue and to its title
    "sem_gap", "sem_logrank", "title_sem_gap",
    # what the issue names
    "path_mentioned", "module_mentioned", "stem_count", "frame_file", "last_frame_file",
    "any_name_in_code", "max_name_count", "any_qual_mentioned", "any_frame_both",
    # shape
    "units_in_file", "path_depth", "is_init_file",
]  # fmt: skip
FILE_POOL = dict(lex=20, sem=20)


def file_features(
    fn,
    lex,
    title_lex,
    code_lex,
    sem,
    title_sem,
    m: Mentions,
    rows: np.ndarray,
    X: np.ndarray,
    unit_scores: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Candidate files and FILE_FEATURES, from the semantic stage's pool (`rows`, features `X`
    with FEATURES then SEMANTIC columns) and its scores for those units."""
    n_files = len(fn.files)
    file_of = fn.file_of_doc

    def by_file(values: np.ndarray, empty: float) -> np.ndarray:
        out = np.full(n_files, empty)
        np.maximum.at(out, file_of, values)
        return out

    file_max, title_max, code_max = (
        by_file(lex, 0.0),
        by_file(title_lex, 0.0),
        by_file(code_lex, 0.0),
    )
    file_sum = np.bincount(file_of, weights=lex, minlength=n_files)
    sem_best, title_sem_best = by_file(sem, -1.0), by_file(title_sem, -1.0)
    units_in_file = np.bincount(file_of, minlength=n_files)
    pool_file = file_of[rows]
    best = np.full(n_files, -np.inf)
    np.maximum.at(best, pool_file, unit_scores)
    col = {f: i for i, f in enumerate(FEATURES)}

    def pool_max(name: str) -> np.ndarray:
        out = np.zeros(n_files)
        np.maximum.at(out, pool_file, X[:, col[name]])
        return out

    mentioned = {
        f for f, p in enumerate(fn.files)
        if any(path_matches(x, p, m.multilang) for x in (*m.frame_paths, *m.py_paths))
    }  # fmt: skip
    cand = set(pool_file.tolist()) | mentioned
    cand |= {int(f) for f in top_k(file_max, FILE_POOL["lex"]) if file_max[f] > 0}
    cand |= {int(f) for f in top_k(sem_best, FILE_POOL["sem"])}
    frows = np.array(sorted(cand), np.int64)

    finite = np.isfinite(best)
    floor = best[finite].min() - 1.0 if finite.any() else 0.0
    best_f = np.where(finite, best, floor)
    in_cand = np.full(n_files, floor - 1.0)
    in_cand[frows] = best_f[frows]
    cols = {
        "best_score_gap": (best_f - best_f[frows].max())[frows],
        "best_score_logrank": _logrank(in_cand)[frows],
        "pool_units": np.log1p(np.bincount(pool_file, minlength=n_files))[frows],
        "file_max_rel": _rel(file_max)[frows], "file_max_logrank": _logrank(file_max)[frows],
        "file_sum_rel": _rel(file_sum)[frows], "file_sum_logrank": _logrank(file_sum)[frows],
        "title_max_rel": _rel(title_max)[frows], "title_max_logrank": _logrank(title_max)[frows],
        "code_max_rel": _rel(code_max)[frows],
        "sem_gap": (sem_best - sem_best.max())[frows], "sem_logrank": _logrank(sem_best)[frows],
        "title_sem_gap": (title_sem_best - title_sem_best.max())[frows],
        "any_name_in_code": pool_max("name_in_code")[frows], "max_name_count": pool_max("name_count")[frows],
        "any_qual_mentioned": pool_max("qual_mentioned")[frows], "any_frame_both": pool_max("frame_both")[frows],
        "units_in_file": np.log1p(units_in_file)[frows],
    }  # fmt: skip
    cf = {f: i for i, f in enumerate(FILE_FEATURES)}
    XF = np.zeros((len(frows), len(FILE_FEATURES)), np.float32)
    for name, values in cols.items():
        XF[:, cf[name]] = values
    last_path = m.last_frame[0] if m.last_frame else ""
    for i, f in enumerate(frows):
        path = fn.files[f]
        mod = module_name(path, m.multilang)
        stem = path.rsplit("/", 1)[-1].removesuffix(".py")
        x = XF[i]
        x[cf["path_mentioned"]] = any(path_matches(p, path, m.multilang) for p in m.py_paths)
        x[cf["module_mentioned"]] = mod in m.dotted or ".".join(mod.split(".")[-2:]) in m.dotted
        x[cf["stem_count"]] = math.log1p(m.idents[stem]) if stem != "__init__" else 0.0
        x[cf["frame_file"]] = any(path_matches(p, path, m.multilang) for p in m.frame_paths)
        x[cf["last_frame_file"]] = bool(last_path) and path_matches(last_path, path, m.multilang)
        x[cf["path_depth"]] = path.count("/")
        x[cf["is_init_file"]] = stem == "__init__"
    return frows, XF
