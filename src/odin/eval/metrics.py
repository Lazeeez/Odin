from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

import numpy as np


@dataclass(frozen=True, slots=True)
class QueryScore:
    recall: dict[int, float]
    hit: dict[int, float]
    full: dict[int, float]
    rr: float
    first_rank: int | None


def score(ranked: Sequence[str], gold: Iterable[str], ks: Sequence[int]) -> QueryScore:
    gold_set = set(gold)
    if not gold_set:
        raise ValueError("gold set is empty")
    seen: list[str] = []
    dedup: set[str] = set()
    for item in ranked:
        if item not in dedup:
            dedup.add(item)
            seen.append(item)
    first_rank = next((i + 1 for i, item in enumerate(seen) if item in gold_set), None)
    recall, hit, full = {}, {}, {}
    for k in ks:
        found = len(gold_set.intersection(seen[:k]))
        recall[k] = found / len(gold_set)
        hit[k] = float(found > 0)
        full[k] = float(found == len(gold_set))
    return QueryScore(recall, hit, full, 1.0 / first_rank if first_rank else 0.0, first_rank)


def aggregate(scores: Sequence[QueryScore], ks: Sequence[int]) -> dict[str, float]:
    n = len(scores)
    if n == 0:
        return {"n": 0}
    out: dict[str, float] = {"n": n, "mrr": sum(s.rr for s in scores) / n}
    for k in ks:
        out[f"recall@{k}"] = sum(s.recall[k] for s in scores) / n
        out[f"hit@{k}"] = sum(s.hit[k] for s in scores) / n
        out[f"all@{k}"] = sum(s.full[k] for s in scores) / n
    return {key: round(v, 4) if isinstance(v, float) else v for key, v in out.items()}


def metric_values(scores: Sequence[QueryScore], metric: str) -> np.ndarray:
    """Per-query values of an aggregate metric name such as `mrr` or `recall@10`."""
    if metric == "mrr":
        return np.array([s.rr for s in scores])
    name, k = metric.split("@")
    attr = {"recall": "recall", "hit": "hit", "all": "full"}[name]
    return np.array([getattr(s, attr)[int(k)] for s in scores])


def bootstrap_ci(
    scores: Sequence[QueryScore], metric: str, n: int = 2000, seed: int = 0
) -> list[float]:
    """95% percentile-bootstrap interval of the mean over queries."""
    values = metric_values(scores, metric)
    if not len(values):
        return [0.0, 0.0]
    rng = np.random.default_rng(seed)
    means = values[rng.integers(0, len(values), (n, len(values)))].mean(axis=1)
    return [round(float(x), 4) for x in np.percentile(means, [2.5, 97.5])]


@dataclass(frozen=True, slots=True)
class PairedDiff:
    delta: float
    ci95: tuple[float, float]
    p_value: float
    wins: int
    losses: int


def paired_bootstrap(a: np.ndarray, b: np.ndarray, n: int = 10000, seed: int = 0) -> PairedDiff:
    """Is b better than a on the same queries? Resamples queries, keeping pairs together.

    The p-value is two-sided: how often the resampled mean difference lands on the other
    side of zero from the observed one.
    """
    diff = np.asarray(b, float) - np.asarray(a, float)
    rng = np.random.default_rng(seed)
    means = diff[rng.integers(0, len(diff), (n, len(diff)))].mean(axis=1)
    observed = diff.mean()
    flipped = np.mean(means <= 0) if observed > 0 else np.mean(means >= 0)
    lo, hi = np.percentile(means, [2.5, 97.5])
    return PairedDiff(
        round(float(observed), 4),
        (round(float(lo), 4), round(float(hi), 4)),
        round(float(min(1.0, 2 * flipped)), 4),
        int((diff > 0).sum()),
        int((diff < 0).sum()),
    )


def percentile(values: Sequence[float], p: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(p / 100 * (len(ordered) - 1))))
    return ordered[idx]
