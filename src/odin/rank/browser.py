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

POOL = dict(bm25=100, title=20, code=20, files=5)


def extract(
    fn, lex, title_lex, code_lex, m: Mentions, names: Counter
) -> tuple[np.ndarray, np.ndarray]:
    """Candidate pool and its features, for one query against one snapshot's function index."""
    n_files = len(fn.files)
    file_of = fn.file_of_doc
    file_max = np.zeros(n_files)
    np.maximum.at(file_max, file_of, lex)
    file_sum = np.bincount(file_of, weights=lex, minlength=n_files)
    units_in_file = np.bincount(file_of, minlength=n_files)

    pool = {int(i) for i in top_k(lex, POOL["bm25"]) if lex[i] > 0}
    pool |= {int(i) for i in top_k(title_lex, POOL["title"]) if title_lex[i] > 0}
    pool |= {int(i) for i in top_k(code_lex, POOL["code"]) if code_lex[i] > 0}
    top_files = {int(f) for f in top_k(file_max, POOL["files"]) if file_max[f] > 0}
    mentioned = {
        f for f, p in enumerate(fn.files)
        if any(path_matches(x, p) for x in (*m.frame_paths, *m.py_paths))
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
        return rows, np.zeros((0, len(FEATURES)), np.float32)

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
        in_frames = any(path_matches(p, path) for p in m.frame_paths)
        last_file = bool(last_path) and path_matches(last_path, path)
        mod = module_name(path)
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
        x[col["path_mentioned"]] = any(path_matches(p, path) for p in m.py_paths)
        x[col["module_mentioned"]] = mod in m.dotted or ".".join(mod.split(".")[-2:]) in m.dotted
        x[col["stem_count"]] = math.log1p(m.idents[stem]) if stem != "__init__" else 0.0
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
