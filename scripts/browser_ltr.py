"""Train the website's rankers: learning to rank on signals a browser can compute.

    uv run --extra dense python scripts/browser_ltr.py

Training data: SWE-bench minus Lite (12 projects) and the SWE-rebench "train" sample (119
other projects). Held out and run once at the end: SWE-bench Lite, and SWE-rebench "test",
30 projects no model ever saw. Cross-validation folds are split by project, so every choice
is judged on projects the model did not train on, which is what the website faces.

The website runs these stages (web/src/engine/rank.ts computes identical features):
  instant   keyword and mention signals; answers in milliseconds, before anything else is ready
  semantic  + static-embedding similarity over every function, computed in the background
  rerank    + MiniLM similarity for the top candidates; shipped only if it earns its download
  file      a ranker over files, for the Files view
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pickle
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from odin.cli import _load_eval_set
from odin.eval.metrics import aggregate, score
from odin.index.chunker import MODULE, chunk_file
from odin.index.snapshot import unit_key, unit_text
from odin.rank.browser import (
    FEATURES,
    FILE_FEATURES,
    POOL,
    SEMANTIC,
    STAGE2,
    extract,
    file_features,
    predict,
)  # fmt: skip
from odin.rank.features import _logrank, issue_fields
from odin.rank.ltr import LGBM_PARAMS, RankingData
from odin.rank.mentions import Mentions
from odin.search.retriever import BM25Retriever, Query
from odin.search.static import StaticEncoder, export_browser_model

STATIC_MODEL, STATIC_TOKENS = "minishlab/potion-code-16M", 512  # chosen by CV (ADR 0011)
EMBEDDER = "sentence-transformers/all-MiniLM-L6-v2"
DEPTH = 20  # candidates the rerank stage embeds with MiniLM
RERANK_MIN_GAIN = 0.005  # declared before looking: CV hit@10 the rerank stage must add
CACHE = Path("results/browser_ltr")
OUT = Path("web/src/assets/ranker.json")
STATIC_OUT = Path("web/src/assets/static-model.bin")
LITE = Path("web/public/data/lite.json")  # the held-out numbers the site quotes

TRAIN = {"swe-bench": ("full", "test", ["lite"]), "rebench": ("rebench", "train", [])}
TEST = {"lite": ("lite", "test", []), "unseen": ("rebench", "test", [])}

MULTILANG = False
ALL_LANGUAGES = frozenset({"python", "javascript", "typescript", "tsx", "go", "java", "rust"})
MULTILANG_SPLITS = {
    "train": "multilang_train",
    "multilingual": "multilang_test_multilingual",
    "polybench": "multilang_test_polybench",
}
LANG_OF: dict[str, str] = {}
LEARNED_MIN_GAIN = 0.02
LIMIT = 0


@dataclass
class Item:
    qid: str
    repo: str
    commit: str
    text: str
    targets: set[str]
    files: set[str]
    ids: list[str] = field(default_factory=list)  # unit id of every unit, by row
    rows_a: np.ndarray | None = None
    xa: np.ndarray | None = None
    rows_b: np.ndarray | None = None
    xb: np.ndarray | None = None
    # filled in pass 2
    sel: np.ndarray | None = None  # positions in rows_b the rerank stage sees
    xc: np.ndarray | None = None
    frows: np.ndarray | None = None
    fpaths: list[str] = field(default_factory=list)
    xf: np.ndarray | None = None


class Snapshots:
    """Repository snapshots with a static embedding of every unit (kept per repository)."""

    def __init__(self) -> None:
        self.r = BM25Retriever(
            tokenizer="code", exclude_tests=True, languages=ALL_LANGUAGES if MULTILANG else None
        )
        self.static = StaticEncoder(STATIC_MODEL, STATIC_TOKENS, quantize=True)
        self._repo: str | None = None
        self._vecs: dict[bytes, np.ndarray] = {}
        self._key: tuple[str, str] | None = None
        self._snap: tuple | None = None

    def get(self, repo: str, commit: str):
        if self._key == (repo, commit):
            return self._snap
        if repo != self._repo:
            self._vecs.clear()  # bounded memory: one repository's units at a time
            self._repo = repo
        fn = self.r._snapshot(Query("", repo, commit, ""), "function")
        missing = {
            int(fn.file_of_doc[d]) for d, k in enumerate(fn.unit_keys) if k not in self._vecs
        }
        texts: dict[bytes, str] = {}
        for f in missing:
            for c in chunk_file(
                self.r.indexer._reader.read(fn.oids[f]), fn.files[f] if MULTILANG else ""
            ):
                if c.kind != MODULE:
                    t = unit_text(c.qualname, c.text)
                    texts[unit_key(t)] = t
        keys = [k for k in texts if k not in self._vecs]
        for k, v in zip(keys, self.static.encode([texts[k] for k in keys]), strict=True):
            self._vecs[k] = v
        M = (
            np.stack([self._vecs[k] for k in fn.unit_keys])
            if fn.unit_keys
            else np.zeros((0, self.static.dim), np.float32)
        )
        names = Counter(i.rsplit("::", 1)[1].rsplit(".", 1)[-1] for i in fn.ids)
        self._key, self._snap = (repo, commit), (fn, M, names)
        return self._snap

    def signals(self, fn, M, text: str):
        """Everything the extractors need for one issue against one snapshot."""
        title, code = issue_fields(text)
        vocab, tok = self.r.indexer.vocab, self.r.tokenize
        lex = fn.index.scores(vocab.lookup(tok(text)))
        title_lex = fn.index.scores(vocab.lookup(tok(title)))
        code_lex = (
            fn.index.scores(vocab.lookup(tok(code))) if code else np.zeros(len(lex), np.float32)
        )
        qv, tv = self.static.encode([text, title])
        return (
            lex,
            title_lex,
            code_lex,
            M @ qv,
            M @ tv,
            Mentions.parse(text, multilang=MULTILANG),
            title,
        )

    def close(self) -> None:
        self.r.close()


def multilang_items(split: str) -> tuple[list, dict[str, str]]:
    from odin.eval.ground_truth import read_gold

    gold = read_gold(Path("data/gold") / f"{MULTILANG_SPLITS[split]}.jsonl")
    queries = {}
    for line in (Path(".cache/multilang") / f"{split}.jsonl").open(encoding="utf-8"):
        r = json.loads(line)
        queries[r["instance_id"]] = r["problem_statement"]
        LANG_OF[r["instance_id"]] = r["language"]
    return gold, queries


def items_of(dataset: str, split: str, exclude: list[str]) -> list[Item]:
    if dataset == "multilang":
        gold, queries = multilang_items(split)
        out = [
            Item(g.instance_id, g.repo, g.base_commit, queries[g.instance_id], set(g.functions + g.classes), set(g.files))
            for g in gold if (g.functions or g.classes) and g.instance_id in queries
        ]  # fmt: skip
        return sorted(out, key=lambda it: (it.repo, it.commit))
    gold, queries = _load_eval_set(
        argparse.Namespace(gold=None, dataset=dataset, split=split, repo=None, exclude=exclude)
    )
    out = [
        Item(g.instance_id, g.repo, g.base_commit, queries[g.instance_id], set(g.functions + g.classes), set(g.files))
        for g in gold if g.functions or g.classes
    ]  # fmt: skip
    return sorted(out, key=lambda it: (it.repo, it.commit))


def build(name: str, spec: tuple, snaps: Snapshots) -> list[Item]:
    """Pass 1: candidate pools and features of the instant and semantic stages."""
    path = CACHE / f"items_{name}.pkl"
    if path.exists():
        return pickle.loads(path.read_bytes())
    items, kept, t0 = items_of(*spec), [], time.time()
    if LIMIT:
        items = [
            it
            for repo in sorted({it.repo for it in items})[:LIMIT]
            for it in items
            if it.repo == repo
        ][: 4 * LIMIT]
    snaps.r.warmup([Query(it.qid, it.repo, it.commit, "") for it in items])
    for n, it in enumerate(items, 1):
        try:
            fn, M, names = snaps.get(it.repo, it.commit)
        except Exception as exc:  # noqa: BLE001 - a snapshot that cannot be read is skipped, and counted
            print(f"  skip {it.qid}: {type(exc).__name__}: {str(exc)[:100]}", flush=True)
            continue
        lex, title_lex, code_lex, sem, tsem, m, _ = snaps.signals(fn, M, it.text)
        it.ids = fn.ids
        it.rows_a, it.xa = extract(fn, lex, title_lex, code_lex, m, names)
        it.rows_b, it.xb = extract(fn, lex, title_lex, code_lex, m, names, sem, tsem)
        kept.append(it)
        if n % 250 == 0:
            print(f"  {name}: {n}/{len(items)} ({time.time() - t0:.0f}s)", flush=True)
    for it in kept:  # only the pooled ids are needed from here on
        it.ids = [it.ids[r] for r in it.rows_b] if it.rows_b is not None else []
    print(
        f"{name}: {len(kept)} of {len(items)} issues built in {time.time() - t0:.0f}s", flush=True
    )
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pickle.dumps(kept))
    return kept


# ---------------------------------------------------------------- ranking data and CV


def unit_ids(it: Item, rows: np.ndarray) -> list[str]:
    pos = {int(r): i for i, r in enumerate(it.rows_b)}
    return [it.ids[pos[int(r)]] if int(r) in pos else f"?{int(r)}" for r in rows]


def repo_folds(items: list[Item], k: int = 5) -> list[tuple[np.ndarray, np.ndarray]]:
    """Folds of whole projects, balanced by issue count: CV scores unseen projects."""
    sizes = Counter(it.repo for it in items)
    load, fold_of = [0] * k, {}
    for repo, n in sorted(sizes.items(), key=lambda kv: (-kv[1], kv[0])):
        f = int(np.argmin(load))
        fold_of[repo] = f
        load[f] += n
    idx = np.arange(len(items))
    fold = np.array([fold_of[it.repo] for it in items])
    return [(idx[fold != f], idx[fold == f]) for f in range(k)]


def cv(data: RankingData, splits, max_rounds: int = 1500, seed: int = 0) -> tuple[int, np.ndarray]:
    """Round count by mean NDCG@10 over project folds, then out-of-fold scores at that count."""
    import lightgbm as lgb

    curves = []
    for tr_q, te_q in splits:
        tr, te = data.split(tr_q), data.split(te_q)
        model = lgb.LGBMRanker(n_estimators=max_rounds, random_state=seed, **LGBM_PARAMS)
        model.fit(
            tr.X, tr.y, group=tr.group, eval_set=[(te.X, te.y)], eval_group=[te.group], eval_at=[10]
        )
        curves.append(model.evals_result_["valid_0"]["ndcg@10"])
    best = int(np.argmax(np.mean(curves, axis=0))) + 1
    oof = np.zeros(len(data.y))
    starts = np.r_[0, np.cumsum(data.group)]
    for tr_q, te_q in splits:
        tr, te = data.split(tr_q), data.split(te_q)
        model = lgb.LGBMRanker(n_estimators=best, random_state=seed, **LGBM_PARAMS)
        model.fit(tr.X, tr.y, group=tr.group)
        pred, at = model.predict(te.X), 0
        for q in te_q:
            oof[starts[q] : starts[q + 1]] = pred[at : at + data.group[q]]
            at += data.group[q]
    return best, oof


def cv_items(items: list[Item], X, Y, n_gold, splits) -> tuple[int, list[np.ndarray], RankingData]:
    """CV over issues. Issues with no candidates are left out of training (LightGBM crashes on
    an empty query group) and get no scores, so they count as misses in every metric."""
    keep = [i for i, x in enumerate(X) if len(x)]
    pos = {i: k for k, i in enumerate(keep)}
    data = RankingData(
        np.concatenate([X[i] for i in keep]), np.concatenate([Y[i] for i in keep]),
        np.array([len(X[i]) for i in keep]), np.array([n_gold[i] for i in keep]),
        [items[i].qid for i in keep],
    )  # fmt: skip
    sub = [
        (np.array([pos[i] for i in tr if i in pos]), np.array([pos[i] for i in te if i in pos]))
        for tr, te in splits
    ]  # fmt: skip
    rounds, oof = cv(data, sub)
    per: list[np.ndarray] = [np.zeros(0)] * len(X)
    at = 0
    for i in keep:
        per[i] = oof[at : at + len(X[i])]
        at += len(X[i])
    return rounds, per, data


def fit(data: RankingData, rounds: int, seed: int = 0):
    import lightgbm as lgb

    model = lgb.LGBMRanker(n_estimators=rounds, random_state=seed, **LGBM_PARAMS)
    model.fit(data.X, data.y, group=data.group)
    return model


def order(s: np.ndarray) -> list[int]:
    return np.argsort(-s, kind="stable").tolist()


def metrics(ranked: list[list[str]], gold: list[set[str]]) -> dict:
    return aggregate(
        [score(r[:10], sorted(g), [1, 5, 10]) for r, g in zip(ranked, gold, strict=True)],
        [1, 5, 10],
    )


def fmt(m: dict) -> str:
    return f"hit@1 {m['hit@1']:.3f}  hit@5 {m['hit@5']:.3f}  hit@10 {m['hit@10']:.3f}  MRR {m['mrr']:.3f}  (n={m['n']})"


# ---------------------------------------------------------------- stages


def stage_rows(items: list[Item], stage: str):
    """Feature rows, labels and unit ids per issue, for the instant (a) or semantic (b) stage."""
    X, Y, ids = [], [], []
    for it in items:
        rows, x = (it.rows_a, it.xa) if stage == "a" else (it.rows_b, it.xb)
        u = unit_ids(it, rows)
        X.append(x)
        Y.append(np.array([i in it.targets for i in u], np.float32))
        ids.append(u)
    return X, Y, ids


def pass2(
    items: list[Item], unit_scores: list[np.ndarray], snaps: Snapshots, embed, name: str
) -> None:
    """Rerank-stage and file-stage features, which need the semantic stage's scores."""
    t0 = time.time()
    for n, (it, s) in enumerate(zip(items, unit_scores, strict=True), 1):
        fn, M, _ = snaps.get(it.repo, it.commit)
        lex, title_lex, code_lex, sem, tsem, m, title = snaps.signals(fn, M, it.text)
        it.frows, it.xf = file_features(
            fn, lex, title_lex, code_lex, sem, tsem, m, it.rows_b, it.xb, s
        )
        it.fpaths = [fn.files[f] for f in it.frows]
        sel = np.array(order(s)[:DEPTH], np.int64)
        it.sel = sel
        if len(sel):
            texts = snaps.r.indexer.unit_texts(fn, it.rows_b[sel].tolist())
            qv, tv, *dv = embed([it.text, title, *texts])
            dv = np.array(dv)
            dense, tdense = dv @ qv, dv @ tv
            extra = np.stack(
                [
                    _logrank(s[sel]),
                    dense - dense.max(),
                    _logrank(dense),
                    tdense - tdense.max(),
                    _logrank(tdense),
                ],
                1,
            )
            it.xc = np.hstack([it.xb[sel], extra]).astype(np.float32)
        else:
            it.xc = np.zeros((0, len(FEATURES) + len(SEMANTIC) + len(STAGE2)), np.float32)
        if n % 500 == 0:
            print(f"  pass 2 {name}: {n}/{len(items)} ({time.time() - t0:.0f}s)", flush=True)


def reranked(it: Item, s_b: np.ndarray, s_c: np.ndarray) -> list[str]:
    """The rerank stage orders its candidates; the rest keep the semantic stage's order."""
    chosen = set(it.sel.tolist())
    u = unit_ids(it, it.rows_b)
    return [u[int(it.sel[i])] for i in order(s_c)] + [u[i] for i in order(s_b) if i not in chosen]


def baseline_order(it: Item) -> list[str]:
    def z(v: np.ndarray) -> np.ndarray:
        return (v - v.mean()) / v.std() if len(v) and v.std() > 0 else np.zeros_like(v)

    x = it.xb
    score = z(x[:, FEATURES.index("bm25_rel")].astype(np.float64)) + z(
        x[:, (FEATURES + SEMANTIC).index("sem")].astype(np.float64)
    )
    u = unit_ids(it, it.rows_b)
    return [u[i] for i in order(score)]


def learned_order(it: Item, s_b: np.ndarray, s_c: np.ndarray | None) -> list[str]:
    if s_c is not None and it.sel is not None and len(it.sel) and len(s_c) == len(it.sel):
        return reranked(it, s_b, s_c)
    u = unit_ids(it, it.rows_b)
    return [u[i] for i in order(s_b)]


def per_language(items: list[Item], s_b: list[np.ndarray], s_c: list[np.ndarray] | None) -> dict:
    from odin.eval.metrics import metric_values, paired_bootstrap

    by_lang: dict[str, list[int]] = {}
    for i, it in enumerate(items):
        if it.xb is None or not len(it.xb):
            continue
        by_lang.setdefault(LANG_OF.get(it.qid, "python"), []).append(i)
    out = {}
    for lang, idx in sorted(by_lang.items()):
        learned = [
            score(
                learned_order(items[i], s_b[i], s_c[i] if s_c is not None else None)[:10],
                sorted(items[i].targets),
                [1, 5, 10],
            )
            for i in idx
        ]
        base = [
            score(baseline_order(items[i])[:10], sorted(items[i].targets), [1, 5, 10]) for i in idx
        ]
        test = paired_bootstrap(metric_values(base, "hit@10"), metric_values(learned, "hit@10"))
        out[lang] = {
            "issues": len(idx),
            "projects": len({items[i].repo for i in idx}),
            "learned": aggregate(learned, [1, 5, 10]),
            "keyword_and_meaning": aggregate(base, [1, 5, 10]),
            "hit@10_gain": {"delta": test.delta, "ci95": list(test.ci95), "p": test.p_value},
            "learned_ranker_used": bool(test.delta >= LEARNED_MIN_GAIN and test.p_value < 0.05),
        }
    return out


def make_embedder():
    import torch
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(EMBEDDER, device="cuda" if torch.cuda.is_available() else "cpu")
    model.max_seq_length = 256
    path = CACHE / "minilm.pkl"
    cache: dict[bytes, np.ndarray] = pickle.loads(path.read_bytes()) if path.exists() else {}

    def embed(texts: list[str]) -> list[np.ndarray]:
        keys = [
            hashlib.blake2b(t.encode("utf-8", "replace"), digest_size=16).digest() for t in texts
        ]
        todo = [i for i, k in enumerate(keys) if k not in cache]
        if todo:
            vecs = model.encode([texts[i] for i in todo], normalize_embeddings=True, batch_size=128)
            for i, v in zip(todo, vecs, strict=True):
                cache[keys[i]] = v.astype(np.float32)
        return [cache[k] for k in keys]

    embed.save = lambda: path.write_bytes(pickle.dumps(cache))  # type: ignore[attr-defined]
    return embed


# ---------------------------------------------------------------- export


def f32_threshold(t: float) -> float:
    """The largest float32 <= t: for float32 features, x <= t exactly when x <= this.

    Written in its shortest float32 form, which both evaluators read back as float32.
    """
    f = np.float32(t)
    if float(f) > t:
        f = np.nextafter(f, np.float32(-np.inf))
    return float(str(f))


def flatten(root: dict) -> dict:
    """One tree as flat arrays: node i sends x[f[i]] <= t[i] to l[i], else r[i]; ~c is leaf c."""
    out: dict[str, list] = {"f": [], "t": [], "l": [], "r": [], "v": []}

    def walk(node: dict) -> int:
        if "leaf_value" in node:
            out["v"].append(float(f"{node['leaf_value']:.7g}"))
            return ~(len(out["v"]) - 1)
        assert node["decision_type"] == "<=" and node["missing_type"] != "Zero", node
        i = len(out["f"])
        out["f"].append(node["split_feature"])
        out["t"].append(f32_threshold(node["threshold"]))
        out["l"].append(0)
        out["r"].append(0)
        out["l"][i] = walk(node["left_child"])
        out["r"][i] = walk(node["right_child"])
        return i

    return out if walk(root) >= 0 else {"v": out["v"]}


def export(models: dict, meta: dict, samples: dict) -> None:
    """Every stage's trees, checked against LightGBM's own predictions before writing."""
    out: dict = {"meta": meta}
    for stage, (model, names) in models.items():
        trees = [flatten(t["tree_structure"]) for t in model.booster_.dump_model()["tree_info"]]
        out[stage] = {"features": names, "trees": trees}
        X = samples[stage]
        got = np.array([predict(out[stage], x) for x in X])
        np.testing.assert_allclose(got, model.predict(X), rtol=1e-5, atol=1e-5)
        print(f"  {stage}: {len(trees)} trees, JSON evaluator matches LightGBM on {len(X)} rows")
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


# ---------------------------------------------------------------- main


def main() -> None:
    global MULTILANG, CACHE, OUT, STATIC_OUT, LITE, LIMIT
    ap = argparse.ArgumentParser()
    ap.add_argument("--multilang", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    if args.multilang:
        MULTILANG = True
        CACHE = Path(".cache/browser_ltr_multilang")
        out = Path("results/browser_ltr_multilang")
        OUT, STATIC_OUT, LITE = out / "ranker.json", out / "static-model.bin", out / "report.json"
        TRAIN["multilang"] = ("multilang", "train", [])
        TEST["multilingual"] = ("multilang", "multilingual", [])
        TEST["polybench"] = ("multilang", "polybench", [])
    if args.limit:
        LIMIT = args.limit
        CACHE = Path(f".cache/browser_ltr_smoke_{LIMIT}")
        OUT, STATIC_OUT, LITE = (
            CACHE / "ranker.json",
            CACHE / "static-model.bin",
            CACHE / "report.json",
        )
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    t_start = time.time()
    snaps = Snapshots()
    train = [it for name, spec in TRAIN.items() for it in build(name, spec, snaps)]
    tests = {name: build(name, spec, snaps) for name, spec in TEST.items()}
    print(f"train: {len(train)} issues in {len({it.repo for it in train})} projects", flush=True)
    splits = repo_folds(train)
    gold = [it.targets for it in train]
    n_gold = [len(it.targets) for it in train]
    report: dict = {"cv": {}, "held_out": {}}

    # Instant and semantic stages, CV by project.
    stage_models = {}
    oof_b = None
    for stage, names in (("a", FEATURES), ("b", FEATURES + SEMANTIC)):
        X, Y, ids = stage_rows(train, stage)
        rounds, per, data = cv_items(train, X, Y, n_gold, splits)
        m = metrics([[u[i] for i in order(s)] for u, s in zip(ids, per, strict=True)], gold)
        report["cv"][stage] = m
        print(
            f"CV {'instant ' if stage == 'a' else 'semantic'} ({rounds:4} rounds): {fmt(m)}",
            flush=True,
        )
        if stage == "a":
            base = metrics(
                [
                    [u[i] for i in order(x[:, FEATURES.index("bm25_rel")])]
                    for u, x in zip(ids, X, strict=True)
                ],
                gold,
            )
            report["cv"]["keyword"] = base
            print(f"CV keyword only          : {fmt(base)}", flush=True)
        stage_models[stage] = (fit(data, rounds), names, rounds)
        if stage == "b":
            oof_b = per

    # Rerank and file stages need the semantic stage's (out-of-fold) scores.
    embed = make_embedder()
    pass2(train, oof_b, snaps, embed, "train")
    XC = [it.xc for it in train]
    YC = [
        np.array(
            [u in it.targets for u in (unit_ids(it, it.rows_b[it.sel]) if len(it.sel) else [])],
            np.float32,
        )
        for it in train
    ]
    rounds_c, per_c, data_c = cv_items(train, XC, YC, n_gold, splits)
    m_c = metrics(
        [reranked(it, sb, sc) for it, sb, sc in zip(train, oof_b, per_c, strict=True)],
        gold,
    )
    report["cv"]["c"] = m_c
    print(f"CV rerank   ({rounds_c:4} rounds): {fmt(m_c)}", flush=True)
    ship_c = m_c["hit@10"] - report["cv"]["b"]["hit@10"] >= RERANK_MIN_GAIN
    print(
        f"  rerank stage {'ships' if ship_c else 'is left out'} (needs +{RERANK_MIN_GAIN:.3f} hit@10 over semantic)",
        flush=True,
    )
    if MULTILANG:
        report["cv_per_language"] = per_language(train, oof_b, per_c if ship_c else None)
        for lang, r in report["cv_per_language"].items():
            print(
                f"  CV {lang:10} n={r['issues']:5} learned hit@10 {r['learned']['hit@10']:.3f} vs keyword+meaning {r['keyword_and_meaning']['hit@10']:.3f}  gain {r['hit@10_gain']['delta']:+.3f} p={r['hit@10_gain']['p']}  -> {'learned' if r['learned_ranker_used'] else 'simple'}",
                flush=True,
            )

    XF = [it.xf for it in train]
    YF = [np.array([p in it.files for p in it.fpaths], np.float32) for it in train]
    fgold = [it.files for it in train]
    rounds_f, per_f, data_f = cv_items(train, XF, YF, [len(it.files) for it in train], splits)
    m_f = metrics(
        [[it.fpaths[i] for i in order(s)] for it, s in zip(train, per_f, strict=True)],
        fgold,
    )
    col = FILE_FEATURES.index("best_score_gap")
    m_f0 = metrics(
        [[it.fpaths[i] for i in order(x[:, col])] for it, x in zip(train, XF, strict=True)], fgold
    )
    report["cv"]["file"], report["cv"]["file_best_function"] = m_f, m_f0
    print(f"CV files, best function : {fmt(m_f0)}", flush=True)
    print(f"CV files, file ranker   ({rounds_f:4} rounds): {fmt(m_f)}", flush=True)
    embed.save()

    model_a, _, rounds_a = stage_models["a"]
    model_b, _, rounds_b = stage_models["b"]
    model_c = fit(data_c, rounds_c) if ship_c else None
    model_f = fit(data_f, rounds_f)

    # Held out: run once.
    for name, items in tests.items():
        g = [it.targets for it in items]
        Xa, _, ida = stage_rows(items, "a")
        Xb, _, idb = stage_rows(items, "b")
        s_b = [model_b.predict(x) if len(x) else np.zeros(0) for x in Xb]
        res = {
            "keyword": metrics(
                [
                    [u[i] for i in order(x[:, FEATURES.index("bm25_rel")])]
                    for u, x in zip(ida, Xa, strict=True)
                ],
                g,
            ),
            "instant": metrics(
                [
                    [u[i] for i in order(model_a.predict(x) if len(x) else np.zeros(0))]
                    for u, x in zip(ida, Xa, strict=True)
                ],
                g,
            ),
            "semantic": metrics(
                [[u[i] for i in order(s)] for u, s in zip(idb, s_b, strict=True)], g
            ),
        }
        pass2(items, s_b, snaps, embed, name)
        if model_c is not None:
            res["rerank"] = metrics(
                [
                    reranked(it, sb, model_c.predict(it.xc) if len(it.sel) else np.zeros(0))
                    for it, sb in zip(items, s_b, strict=True)
                ],
                g,
            )
        fg = [it.files for it in items]
        res["files_best_function"] = metrics(
            [[it.fpaths[i] for i in order(it.xf[:, col])] for it in items], fg
        )
        res["files"] = metrics(
            [
                [it.fpaths[i] for i in order(model_f.predict(it.xf) if len(it.xf) else np.zeros(0))]
                for it in items
            ],
            fg,
        )
        report["held_out"][name] = res
        if MULTILANG:
            s_c_held = [
                model_c.predict(it.xc) if model_c is not None and len(it.sel) else None
                for it in items
            ]
            report.setdefault("held_out_per_language", {})[name] = per_language(
                items, s_b, s_c_held
            )
        for k, v in res.items():
            print(f"{name:7} {k:20}: {fmt(v)}", flush=True)
    embed.save()

    # Export: trees, the static model the browser downloads, and the numbers the site quotes.
    sample = lambda X: np.concatenate([x for x in X if len(x)][:40])  # noqa: E731
    models = {
        "instant": (model_a, FEATURES),
        "semantic": (model_b, FEATURES + SEMANTIC),
        "file": (model_f, FILE_FEATURES),
    }
    samples = {
        "instant": sample([it.xa for it in train]),
        "semantic": sample([it.xb for it in train]),
        "file": sample(XF),
    }
    if model_c is not None:
        models["rerank"] = (model_c, FEATURES + SEMANTIC + STAGE2)
        samples["rerank"] = sample(XC)
    meta = {
        "pool": POOL, "depth": DEPTH, "static": {"model": STATIC_MODEL, "maxTokens": STATIC_TOKENS}, "embedder": EMBEDDER,
        "trained_on": {k: f"{v[0]}:{v[1]}" for k, v in TRAIN.items()},
        **({"multilang": True, "languages": sorted(ALL_LANGUAGES),
            "simple_languages": sorted(lang for lang, r in report.get("cv_per_language", {}).items() if not r["learned_ranker_used"])} if MULTILANG else {}),
        "rounds": {"instant": rounds_a, "semantic": rounds_b, "rerank": rounds_c if ship_c else None, "file": rounds_f},
    }  # fmt: skip
    export(models, meta, samples)
    size = export_browser_model(snaps.static, STATIC_OUT)
    print(f"wrote {STATIC_OUT} ({size / 1e6:.1f} MB)")
    LITE.write_text(
        json.dumps(
            {"embedder": EMBEDDER, "static": STATIC_MODEL, "depth": DEPTH, **report}, indent=1
        ),
        encoding="utf-8",
    )
    print(f"wrote {LITE}; total {time.time() - t_start:.0f}s")
    snaps.close()


if __name__ == "__main__":  # parsing fans out to processes: required on Windows
    main()
