import numpy as np
import pytest

from odin.eval.metrics import aggregate, bootstrap_ci, paired_bootstrap, percentile, score


def test_score_basic():
    s = score(["a", "b", "c", "d"], {"c", "x"}, ks=[1, 3, 5])
    assert s.first_rank == 3
    assert s.rr == pytest.approx(1 / 3)
    assert s.recall == {1: 0.0, 3: 0.5, 5: 0.5}
    assert s.hit == {1: 0.0, 3: 1.0, 5: 1.0}
    assert s.full == {1: 0.0, 3: 0.0, 5: 0.0}


def test_duplicates_do_not_inflate_rank_budget():
    s = score(["a", "a", "a", "b"], {"b"}, ks=[2])
    assert s.first_rank == 2
    assert s.recall[2] == 1.0


def test_miss():
    s = score(["a"], {"b"}, ks=[10])
    assert s.first_rank is None
    assert s.rr == 0.0


def test_empty_gold_rejected():
    with pytest.raises(ValueError):
        score(["a"], set(), ks=[1])


def test_aggregate():
    scores = [score(["a"], {"a"}, [1]), score(["b"], {"a"}, [1])]
    agg = aggregate(scores, [1])
    assert agg["n"] == 2
    assert agg["recall@1"] == 0.5
    assert agg["mrr"] == 0.5


def test_bootstrap_ci_brackets_mean():
    scores = [score(["a"], {"a"}, [1])] * 30 + [score(["b"], {"a"}, [1])] * 70
    lo, hi = bootstrap_ci(scores, "recall@1")
    assert lo < 0.3 < hi
    assert bootstrap_ci([score(["a"], {"a"}, [1])] * 5, "mrr") == [1.0, 1.0]


def test_paired_bootstrap_detects_real_difference():
    a = np.array([0.0] * 50 + [1.0] * 50)
    b = np.array([1.0] * 90 + [0.0] * 10)
    d = paired_bootstrap(a, b)
    assert d.delta == pytest.approx(0.4)
    assert d.p_value < 0.01
    assert d.ci95[0] > 0


def test_paired_bootstrap_identical_runs_are_not_significant():
    a = np.array([0.0, 1.0] * 50)
    d = paired_bootstrap(a, a.copy())
    assert d.delta == 0
    assert d.p_value == 1.0


def test_percentile():
    assert percentile([5, 1, 3], 50) == 3
    assert percentile([], 99) == 0.0
