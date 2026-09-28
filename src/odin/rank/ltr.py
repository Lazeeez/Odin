from __future__ import annotations

import json
import math
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from odin.eval.ground_truth import GoldEntry
from odin.index.store import code_fingerprint
from odin.rank import features as features_module
from odin.rank import history, mentions, past_issues
from odin.rank.features import FEATURES, FILE_FEATURES, FeatureExtractor
from odin.rank.past_issues import IssueMemory
from odin.search.bm25 import top_k
from odin.search.dense import Encoder, FusionParams
from odin.search.retriever import HybridRetriever, Query

MODEL_DIR = Path("models")
LEVELS = {
    # level: (feature names, the hybrid baseline column, where the model lives)
    "function": (FEATURES, "fused_logrank", MODEL_DIR / "ltr_function.txt"),
    "file": (FILE_FEATURES, "file_fused_logrank", MODEL_DIR / "ltr_file.txt"),
}


def feature_fingerprint() -> str:
    """Covers every module whose code decides a feature value, not just the feature list."""
    return code_fingerprint(
        features_module,
        history,
        mentions,
        past_issues,
        ",".join(FEATURES),
        ",".join(FILE_FEATURES),
    )


@dataclass(slots=True)
class RankingData:
    """Candidates of many queries, stacked, in LightGBM's grouped layout."""

    X: np.ndarray
    y: np.ndarray
    group: np.ndarray  # candidates per query, in order
    n_gold: np.ndarray  # gold items per query, including any outside the candidate pool
    qids: list[str]
    ids: np.ndarray | None = None  # candidate ids (unit ids or file paths), row-aligned
    oof: np.ndarray | None = None  # out-of-fold model scores, once cross-validated

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        extra = {k: v for k, v in (("oof", self.oof), ("ids", self.ids)) if v is not None}
        np.savez_compressed(
            path, X=self.X, y=self.y, group=self.group, n_gold=self.n_gold,
            qids=np.array(self.qids), fingerprint=feature_fingerprint(), **extra,
        )  # fmt: skip

    def query_rows(self) -> dict[str, slice]:
        starts = np.r_[0, np.cumsum(self.group)]
        return {q: slice(starts[i], starts[i + 1]) for i, q in enumerate(self.qids)}

    @classmethod
    def load(cls, path: Path) -> RankingData | None:
        if not path.exists():
            return None
        z = np.load(path)
        if str(z["fingerprint"]) != feature_fingerprint():
            return None  # features changed since this was written
        return cls(
            z["X"], z["y"], z["group"], z["n_gold"], z["qids"].tolist(),
            z.get("ids"), z.get("oof"),
        )  # fmt: skip

    def split(self, queries: np.ndarray) -> RankingData:
        starts = np.r_[0, np.cumsum(self.group)[:-1]]
        rows = np.concatenate([np.arange(starts[q], starts[q] + self.group[q]) for q in queries])
        return RankingData(
            self.X[rows], self.y[rows], self.group[queries], self.n_gold[queries],
            [self.qids[q] for q in queries],
        )  # fmt: skip


class _Builder:
    def __init__(self) -> None:
        self.X: list[np.ndarray] = []
        self.y: list[np.ndarray] = []
        self.group: list[int] = []
        self.n_gold: list[int] = []
        self.qids: list[str] = []
        self.ids: list[list[str]] = []

    def add(self, qid: str, X: np.ndarray, labels: np.ndarray, n_gold: int, ids: list[str]) -> None:
        self.ids.append(ids)
        self.X.append(X)
        self.y.append(labels.astype(np.float32))
        self.group.append(len(X))
        self.n_gold.append(n_gold)
        self.qids.append(qid)

    def done(self) -> RankingData:
        return RankingData(
            np.concatenate(self.X), np.concatenate(self.y), np.array(self.group),
            np.array(self.n_gold), self.qids,
            np.array([i for ids in self.ids for i in ids]),
        )  # fmt: skip


def build_ranking_data(
    extractor: FeatureExtractor,
    gold: Sequence[GoldEntry],
    queries: dict[str, str],
    progress: Callable[[int, int], None] | None = None,
) -> dict[str, RankingData]:
    """Function- and file-level training data from one feature-extraction pass."""
    todo = [g for g in gold if g.files]
    extractor.r.warmup([Query(g.instance_id, g.repo, g.base_commit, "") for g in todo])
    fn, fl = _Builder(), _Builder()
    for n, g in enumerate(todo, start=1):
        cs = extractor.extract(Query(g.instance_id, g.repo, g.base_commit, queries[g.instance_id]))
        targets = set(g.functions + g.classes)
        if targets:
            fn.add(
                g.instance_id, cs.X, np.array([i in targets for i in cs.ids]), len(targets), cs.ids
            )
        assert cs.index.files is not None
        gold_files = set(g.files)
        fl.add(
            g.instance_id,
            cs.Xf,
            np.array([cs.index.files[f] in gold_files for f in cs.file_rows]),
            len(gold_files),
            [cs.index.files[f] for f in cs.file_rows],
        )
        if progress:
            progress(n, len(todo))
    return {"function": fn.done(), "file": fl.done()}


def ranking_metrics(
    scores: np.ndarray, data: RankingData, ks: Sequence[int] = (1, 5, 10)
) -> dict[str, float]:
    """Recall@k and MRR over queries, counting gold items the pool missed as misses."""
    out = {f"recall@{k}": 0.0 for k in ks} | {"mrr": 0.0}
    start = 0
    for size, n_gold in zip(data.group, data.n_gold, strict=True):
        s, y = scores[start : start + size], data.y[start : start + size]
        order = top_k(s, max(ks))
        for k in ks:
            out[f"recall@{k}"] += y[order[:k]].sum() / n_gold
        hits = np.flatnonzero(y[np.argsort(-s, kind="stable")])
        out["mrr"] += 1.0 / (hits[0] + 1) if len(hits) else 0.0
        start += size
    return {k: round(v / len(data.group), 4) for k, v in out.items()}


LGBM_PARAMS = dict(
    objective="lambdarank",
    learning_rate=0.03,
    num_leaves=15,
    min_child_samples=40,
    colsample_bytree=0.8,
    subsample=0.8,
    subsample_freq=1,
    reg_lambda=1.0,
    lambdarank_truncation_level=20,
    verbose=-1,
)


def _folds(n: int, folds: int, seed: int) -> list[tuple[np.ndarray, np.ndarray]]:
    parts = np.array_split(np.random.default_rng(seed).permutation(n), folds)
    return [
        (np.sort(np.concatenate([p for j, p in enumerate(parts) if j != i])), np.sort(parts[i]))
        for i in range(folds)
    ]


def cross_validate(
    data: RankingData, baseline: str, names: list[str], folds: int = 5, seed: int = 0,
    max_rounds: int = 1500,
) -> tuple[int, dict[str, float], dict[str, float]]:  # fmt: skip
    """K-fold CV grouped by query: the round count to use, CV scores, baseline scores.

    Every candidate of a query stays in one fold, so no query is ever both trained and
    scored. Rounds are picked by mean NDCG@10 across folds, then out-of-fold predictions
    are re-made with that count so the reported score is not tuned on its own test folds.
    """
    import lightgbm as lgb

    splits = _folds(len(data.group), folds, seed)
    curves = []
    for train, test in splits:
        tr, te = data.split(train), data.split(test)
        model = lgb.LGBMRanker(n_estimators=max_rounds, random_state=seed, **LGBM_PARAMS)
        model.fit(
            tr.X, tr.y, group=tr.group,
            eval_set=[(te.X, te.y)], eval_group=[te.group], eval_at=[10],
        )  # fmt: skip
        curves.append(model.evals_result_["valid_0"]["ndcg@10"])
    best = int(np.argmax(np.mean(curves, axis=0))) + 1

    oof = np.zeros(len(data.y))
    starts = np.r_[0, np.cumsum(data.group)]
    for train, test in splits:
        tr, te = data.split(train), data.split(test)
        model = lgb.LGBMRanker(n_estimators=best, random_state=seed, **LGBM_PARAMS)
        model.fit(tr.X, tr.y, group=tr.group)
        pred, at = model.predict(te.X), 0
        for q in test:
            oof[starts[q] : starts[q + 1]] = pred[at : at + data.group[q]]
            at += data.group[q]
    base = -data.X[:, names.index(baseline)]
    data.oof = oof
    return best, ranking_metrics(oof, data), ranking_metrics(base, data)


def train(
    data: RankingData, rounds: int, names: list[str], path: Path, meta: dict, seed: int = 0
) -> None:
    import lightgbm as lgb

    model = lgb.LGBMRanker(n_estimators=rounds, random_state=seed, **LGBM_PARAMS)
    model.fit(data.X, data.y, group=data.group)
    path.parent.mkdir(parents=True, exist_ok=True)
    model.booster_.save_model(str(path))
    gain = model.booster_.feature_importance("gain")
    ranked = sorted(zip(names, gain.tolist(), strict=True), key=lambda t: -t[1])
    meta = meta | {
        "rounds": rounds,
        "params": LGBM_PARAMS,
        "features": names,
        "feature_fingerprint": feature_fingerprint(),
        "importance_gain": {f: round(g, 1) for f, g in ranked},
    }
    path.with_suffix(".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _load(path: Path):
    import lightgbm as lgb

    meta = json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))
    if meta["feature_fingerprint"] != feature_fingerprint():
        raise RuntimeError(f"{path} was trained on different features; run `odin ltr`")
    return lgb.Booster(model_file=str(path))


FULL_GOLD = Path("data/gold/swebench_full_test.jsonl")


def issue_memory(retriever: HybridRetriever) -> IssueMemory:
    """Every SWE-bench issue with its fix locations; each query sees only earlier ones."""
    from odin.eval.dataset import load_instances
    from odin.eval.ground_truth import read_gold

    return IssueMemory(
        load_instances("full", "test"), read_gold(FULL_GOLD), embed=retriever.embed_queries
    )


class LTRRetriever(HybridRetriever):
    """Hybrid candidate generation, reranked by learned LambdaMART models per level.

    Anything outside a candidate pool keeps its hybrid order below every candidate.
    """

    def __init__(
        self, encoder: Encoder, fusion: FusionParams, name: str = "ltr-notests", **kwargs
    ) -> None:
        super().__init__(encoder, mode="hybrid", fusion=fusion, name=name, **kwargs)
        self.models = {level: _load(path) for level, (_, _, path) in LEVELS.items()}
        self.extractor = FeatureExtractor(self, fusion, memory=issue_memory(self))

    def retrieve(self, query: Query, level: str, k: int) -> list[str]:
        cs = self.extractor.extract(query)
        if level == "function":
            pred = self.models["function"].predict(cs.X)
            ranked = [cs.ids[i] for i in np.argsort(-pred, kind="stable")[:k]]
            backfill, ids = cs.fallback, cs.index.ids
        else:
            assert cs.index.files is not None
            pred = self.models["file"].predict(cs.Xf)
            ranked = [cs.index.files[cs.file_rows[i]] for i in np.argsort(-pred, kind="stable")[:k]]
            backfill, ids = cs.file_fallback, cs.index.files
        if len(ranked) < k:
            seen = set(ranked)
            ranked += [ids[i] for i in top_k(backfill, 2 * k + len(ranked)) if ids[i] not in seen]
        return ranked[:k]


class RerankedLTRRetriever(LTRRetriever):
    """LTR, then a fine-tuned cross-encoder over its top candidates: a three-stage cascade.

    Each stage is more expensive per candidate and sees fewer of them: sparse and dense
    retrieval score every unit, LambdaMART a pool of ~450, the cross-encoder the top K.
    Depth and blend weights come from `odin ce-tune`, chosen on held-out training issues.
    """

    def __init__(
        self,
        encoder: Encoder,
        fusion: FusionParams,
        recipe: Path = MODEL_DIR / "reranker.json",
        name: str = "ltr-ce-notests",
        **kwargs,
    ) -> None:
        from odin.rank.cross_encoder import CrossEncoderEnsemble

        super().__init__(encoder, fusion, name=name, **kwargs)
        choice = json.loads(recipe.read_text(encoding="utf-8"))
        self.depth = int(choice["depth"])
        self.function_weight = float(choice["function_weight"])
        self.file_weight = float(choice["file_weight"])
        self.ce = CrossEncoderEnsemble([Path(a) for a in choice["adapters"]])
        # Confident queries skip the reranker (chosen on validation, see ce_tune.SKIP_MARGINS).
        self.skip_margin = float(choice.get("skip_margin") or math.inf)
        self._scored: tuple[tuple, tuple] | None = None
        self.skipped = 0

    def _score(self, query: Query) -> tuple:
        """Candidates, LTR scores and reranker scores for a query, computed once for both
        levels: asking for functions and then files costs one reranker pass, not two."""
        from odin.rank.ce_train import ltr_margin

        key = (query.repo, query.base_commit, query.text)
        if self._scored is None or self._scored[0] != key:
            cs = self.extractor.extract(query)
            p = self.models["function"].predict(cs.X)
            order = np.argsort(-p, kind="stable")
            top = order[: self.depth]
            if ltr_margin(p[top]) > self.skip_margin:
                self.skipped += 1
                ce = None  # LTR is confident: keep its order
            else:
                ce = self.ce.score(query.text, self.indexer.unit_texts(cs.index, cs.rows[top]))
            self._scored = (key, (cs, p, order, top, ce))
        return self._scored[1]

    def retrieve(self, query: Query, level: str, k: int) -> list[str]:
        import math

        from odin.rank.ce_train import rerank

        cs, p, order, top, ce = self._score(query)
        if ce is None:
            return super().retrieve(query, level, k)
        if level == "function":
            new = np.argsort(-rerank(p[top], ce, self.function_weight), kind="stable")
            ranked = [cs.ids[i] for i in top[new]] + [cs.ids[i] for i in order[self.depth :]]
            return ranked[:k]
        assert cs.index.files is not None and cs.index.file_of_doc is not None
        pf = self.models["file"].predict(cs.Xf)
        best: dict[int, float] = {}
        for f, s in zip(cs.index.file_of_doc[cs.rows[top]].tolist(), ce.tolist(), strict=True):
            best[f] = max(best.get(f, -math.inf), s)
        floor = float(ce.min()) - 1.0 if len(ce) else 0.0
        ce_file = np.array([best.get(int(f), floor) for f in cs.file_rows])
        new = np.argsort(-rerank(pf, ce_file, self.file_weight), kind="stable")
        ranked = [cs.index.files[cs.file_rows[i]] for i in new]
        if len(ranked) < k:
            seen = set(ranked)
            ranked += [
                cs.index.files[i]
                for i in top_k(cs.file_fallback, 2 * k)
                if cs.index.files[i] not in seen
            ]
        return ranked[:k]
