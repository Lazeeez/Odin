"""Train the website's ranker: learning to rank on signals a browser can compute.

    uv run --extra dense python scripts/browser_ltr.py [--stage2]

The server pipeline's strongest features (fused rank, unit length, title match, identifiers
and traceback frames named in the issue) need no GPU, no git history and no big model, so
the browser can compute them over a whole repository in milliseconds. This builds exactly
those features in Python, trains LambdaMART on SWE-bench minus Lite, picks settings by
cross-validation, evaluates once on Lite and exports the trees as JSON for web/.

Stage 1 ranks with lexical and mention features alone (instant, no model download).
Stage 2 (--stage2) adds MiniLM similarity for stage 1's top candidates, the model the site
already runs in the browser. web/src/engine/rank.ts must compute identical features; the
parity test (tests/test_site_engine.py) checks that it does.
"""

from __future__ import annotations

import argparse
import json
import pickle
import time
from collections import Counter
from pathlib import Path

import numpy as np

from odin.cli import _load_eval_set
from odin.eval.metrics import aggregate, score
from odin.eval.runner import gold_targets
from odin.rank.browser import FEATURES, POOL, STAGE2, extract, predict
from odin.rank.features import _logrank, issue_fields
from odin.rank.ltr import LGBM_PARAMS, RankingData
from odin.rank.mentions import Mentions
from odin.search.retriever import BM25Retriever, Query

DEPTH = (
    20  # stage-2 candidates the browser embeds per query: 50 is +0.4 hit@10 in CV for 2.5x the work
)
CACHE = Path("results/browser_ltr")
OUT = Path("web/src/assets/ranker.json")
LITE = Path("web/public/data/lite.json")  # the held-out numbers the site quotes
EMBEDDER = "sentence-transformers/all-MiniLM-L6-v2"


def build(dataset: str, exclude: list[str]) -> dict:
    path = CACHE / f"stage1_{dataset}_minus_{'_'.join(exclude) or 'none'}.pkl"
    if path.exists():
        return pickle.loads(path.read_bytes())
    gold, queries = _load_eval_set(
        argparse.Namespace(gold=None, dataset=dataset, split="test", repo=None, exclude=exclude)
    )
    todo = sorted(
        (g for g in gold if gold_targets(g, "function")), key=lambda g: (g.repo, g.base_commit)
    )
    r = BM25Retriever(tokenizer="code", exclude_tests=True)
    r.warmup([Query(g.instance_id, g.repo, g.base_commit, "") for g in todo])
    out = {
        "qids": [],
        "repo": [],
        "commit": [],
        "rows": [],
        "ids": [],
        "X": [],
        "y": [],
        "n_gold": [],
        "text": [],
    }
    names_key, names = None, Counter()
    t0 = time.time()
    for n, g in enumerate(todo, 1):
        text = queries[g.instance_id]
        q = Query(g.instance_id, g.repo, g.base_commit, text)
        fn, lex = r.lexical_scores(q, "function")
        if names_key != id(fn):
            names = Counter(i.rsplit("::", 1)[1].rsplit(".", 1)[-1] for i in fn.ids)
            names_key = id(fn)
        title, code = issue_fields(text)
        vocab, tok = r.indexer.vocab, r.tokenize
        title_lex = fn.index.scores(vocab.lookup(tok(title)))
        code_lex = fn.index.scores(vocab.lookup(tok(code))) if code else np.zeros(len(lex))
        rows, X = extract(fn, lex, title_lex, code_lex, Mentions.parse(text), names)
        targets = set(gold_targets(g, "function"))
        ids = [fn.ids[i] for i in rows]
        for k, v in (("qids", g.instance_id), ("repo", g.repo), ("commit", g.base_commit), ("rows", rows),
                     ("ids", ids), ("X", X), ("y", np.array([i in targets for i in ids], np.float32)),
                     ("n_gold", len(targets)), ("text", text)):  # fmt: skip
            out[k].append(v)
        if n % 100 == 0:
            print(f"  {n}/{len(todo)} ({time.time() - t0:.0f}s)", flush=True)
    r.close()
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_bytes(pickle.dumps(out))
    return out


def as_ranking(d: dict, X: list[np.ndarray] | None = None) -> RankingData:
    return RankingData(
        np.concatenate(X or d["X"]), np.concatenate(d["y"]),
        np.array([len(x) for x in (X or d["X"])]), np.array(d["n_gold"]), d["qids"],
    )  # fmt: skip


def cv(
    data: RankingData, folds: int = 5, seed: int = 0, max_rounds: int = 1000
) -> tuple[int, np.ndarray]:
    """Round count by mean NDCG@10 across folds, then out-of-fold scores at that count."""
    import lightgbm as lgb

    from odin.rank.ltr import _folds

    splits = _folds(len(data.group), folds, seed)
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


def fit(data: RankingData, rounds: int):
    import lightgbm as lgb

    model = lgb.LGBMRanker(n_estimators=rounds, random_state=0, **LGBM_PARAMS)
    model.fit(data.X, data.y, group=data.group)
    return model


def per_query(scores: np.ndarray, d: dict) -> list[np.ndarray]:
    out, at = [], 0
    for X in d["X"]:
        out.append(scores[at : at + len(X)])
        at += len(X)
    return out


def evaluate(d: dict, ranked_rows: list[list[int]], gold_of: dict[str, list[str]]) -> dict:
    """The eval harness's own metrics (gold outside the pool counts as a miss)."""
    res = [
        score([d["ids"][q][i] for i in rr[:10]], gold_of[d["qids"][q]], [1, 5, 10])
        for q, rr in enumerate(ranked_rows)
    ]
    return aggregate(res, [1, 5, 10])


def order(s: np.ndarray) -> list[int]:
    return np.argsort(-s, kind="stable").tolist()


def stage2_features(
    d: dict, s1: list[np.ndarray], embed
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Stage-2 rows (stage 1's top DEPTH per query) with dense similarity appended."""
    r = BM25Retriever(tokenizer="code", exclude_tests=True)
    X2, sel_all = [], []
    t0 = time.time()
    for q in range(len(d["qids"])):
        sel = np.array(order(s1[q])[:DEPTH], np.int64)
        fn = r._snapshot(Query(d["qids"][q], d["repo"][q], d["commit"][q], ""), "function")
        texts = r.indexer.unit_texts(fn, d["rows"][q][sel].tolist())
        title, _ = issue_fields(d["text"][q])
        qv, tv, *dv = embed([d["text"][q], title, *texts])
        dv = np.array(dv)
        dense, tdense = dv @ qv, dv @ tv
        extra = np.stack([_logrank(s1[q][sel]), dense - dense.max(), _logrank(dense),
                          tdense - tdense.max(), _logrank(tdense)], axis=1)  # fmt: skip
        X2.append(np.hstack([d["X"][q][sel], extra]).astype(np.float32))
        sel_all.append(sel)
        if (q + 1) % 200 == 0:
            print(f"  embedded {q + 1}/{len(d['qids'])} ({time.time() - t0:.0f}s)", flush=True)
    r.close()
    return X2, sel_all


def make_embedder():
    import hashlib

    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(EMBEDDER, device="cuda" if _cuda() else "cpu")
    model.max_seq_length = 256
    path = CACHE / "minilm.pkl"
    cache: dict[bytes, np.ndarray] = pickle.loads(path.read_bytes()) if path.exists() else {}

    def embed(texts: list[str]) -> list[np.ndarray]:
        keys = [
            hashlib.blake2b(t.encode("utf-8", "replace"), digest_size=16).digest() for t in texts
        ]
        todo = [i for i, k in enumerate(keys) if k not in cache]
        if todo:
            vecs = model.encode([texts[i] for i in todo], normalize_embeddings=True, batch_size=64)
            for i, v in zip(todo, vecs, strict=True):
                cache[keys[i]] = v.astype(np.float32)
        return [cache[k] for k in keys]

    def save() -> None:
        path.write_bytes(pickle.dumps(cache))

    embed.save = save  # type: ignore[attr-defined]
    return embed


def _cuda() -> bool:
    import torch

    return torch.cuda.is_available()


def f32_threshold(t: float) -> float:
    """The largest float32 <= t: for float32 features, x <= t exactly when x <= this.

    Written in its shortest float32 form, which both evaluators read back with fround.
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
        want = model.predict(X)
        got = np.array([predict(out[stage], x) for x in X])
        np.testing.assert_allclose(got, want, rtol=1e-5, atol=1e-5)
        print(f"{stage}: {len(trees)} trees, JSON evaluator matches LightGBM on {len(X)} rows")
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size / 1024:.0f} KB)")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage2", action="store_true")
    args = ap.parse_args()

    train = build("full", ["lite"])
    lite = build("lite", [])
    gold_of = {}
    for ds, ex in (("full", ["lite"]), ("lite", [])):
        gold, _ = _load_eval_set(
            argparse.Namespace(gold=None, dataset=ds, split="test", repo=None, exclude=ex)
        )
        gold_of |= {g.instance_id: gold_targets(g, "function") for g in gold}
    tr1 = as_ranking(train)
    pool_recall = sum(y.sum() > 0 for y in train["y"]) / len(train["y"])
    print(
        f"train: {len(train['qids'])} queries, mean pool {np.mean([len(x) for x in train['X']]):.0f}, pool hit {pool_recall:.3f}"
    )

    rounds1, oof1 = cv(tr1)
    s1_train = per_query(oof1, train)
    bm25 = [order(x[:, FEATURES.index("bm25_rel")]) for x in train["X"]]
    print(f"CV, train  BM25 : {fmt(evaluate(train, bm25, gold_of))}")
    print(
        f"CV, train  stage1 ({rounds1} rounds): {fmt(evaluate(train, [order(s) for s in s1_train], gold_of))}"
    )
    m1 = fit(tr1, rounds1)
    s1_lite = [m1.predict(x) if len(x) else np.zeros(0) for x in lite["X"]]
    lite_bm25 = [order(x[:, FEATURES.index("bm25_rel")]) for x in lite["X"]]
    held_out = {
        "keyword": evaluate(lite, lite_bm25, gold_of),
        "stage1": evaluate(lite, [order(s) for s in s1_lite], gold_of),
    }
    print(f"Lite       BM25 : {fmt(held_out['keyword'])}")
    print(f"Lite       stage1: {fmt(held_out['stage1'])}")
    gain = sorted(
        zip(FEATURES, m1.booster_.feature_importance("gain"), strict=True), key=lambda t: -t[1]
    )
    print("top features:", ", ".join(f"{n}={g:.0f}" for n, g in gain[:12]))
    models = {"stage1": (m1, FEATURES)}
    samples = {"stage1": np.concatenate(lite["X"][:40])}
    meta = {"pool": POOL, "depth": DEPTH, "embedder": EMBEDDER, "trained_on": "SWE-bench full minus Lite",
            "rounds": {"stage1": rounds1}}  # fmt: skip

    if args.stage2:
        embed = make_embedder()
        X2_train, sel_train = stage2_features(train, s1_train, embed)
        X2_lite, sel_lite = stage2_features(lite, s1_lite, embed)
        embed.save()
        y2 = [train["y"][q][s] for q, s in enumerate(sel_train)]
        tr2 = RankingData(np.concatenate(X2_train), np.concatenate(y2), np.array([len(x) for x in X2_train]),
                          np.array(train["n_gold"]), train["qids"])  # fmt: skip
        rounds2, oof2 = cv(tr2)
        names2 = FEATURES + STAGE2

        def combined(sel, s2, s1):
            # stage 2 orders its DEPTH candidates; the rest keep stage 1's order below them
            rest = [i for i in order(s1) if i not in set(sel.tolist())]
            return [int(sel[i]) for i in order(s2)] + rest

        at, cv2 = 0, []
        for q, sel in enumerate(sel_train):
            cv2.append(combined(sel, oof2[at : at + len(sel)], s1_train[q]))
            at += len(sel)
        print(f"CV, train  stage2 ({rounds2} rounds): {fmt(evaluate(train, cv2, gold_of))}")
        m2 = fit(tr2, rounds2)
        lite2 = [
            combined(sel, m2.predict(X2_lite[q]) if len(sel) else np.zeros(0), s1_lite[q])
            for q, sel in enumerate(sel_lite)
        ]
        held_out["stage2"] = evaluate(lite, lite2, gold_of)
        print(f"Lite       stage2: {fmt(held_out['stage2'])}")
        models["stage2"] = (m2, names2)
        samples["stage2"] = np.concatenate(X2_lite[:40])
        meta["rounds"]["stage2"] = rounds2
    export(models, meta, samples)
    LITE.write_text(
        json.dumps({"embedder": EMBEDDER, "depth": DEPTH, "lite": held_out}, indent=1),
        encoding="utf-8",
    )
    print(f"wrote {LITE}")


def fmt(m: dict) -> str:
    return f"hit@1={m['hit@1']:.3f} hit@5={m['hit@5']:.3f} hit@10={m['hit@10']:.3f} recall@10={m['recall@10']:.3f} mrr={m['mrr']:.3f} (n={m['n']})"


if __name__ == "__main__":
    main()
