import numpy as np
import pytest

from odin.rank.features import FEATURES, FILE_FEATURES, FeatureExtractor, issue_fields
from odin.rank.history import RepoHistory
from odin.rank.ltr import RankingData, ranking_metrics
from odin.rank.mentions import Mentions, module_name, path_matches
from odin.search.dense import FusionParams
from odin.search.retriever import HybridRetriever, Query

from .conftest import _git
from .test_dense import HashingEncoder

ISSUE = """QuerySet.none() on combined queries returns all results

Calling `qs.none()` after `union()` breaks:

```
Traceback (most recent call last):
  File "/venv/lib/python3.8/site-packages/django/db/models/query.py", line 90, in __iter__
  File "/venv/lib/python3.8/site-packages/django/db/models/sql/compiler.py", line 12, in execute_sql
django.db.utils.ProgrammingError: boom
```
see django/db/models/sql/query.py
"""


def test_mentions_parse_traceback_code_and_paths():
    m = Mentions.parse(ISSUE)
    assert m.frame_names == {"__iter__", "execute_sql"}
    assert m.last_frame == (
        "/venv/lib/python3.8/site-packages/django/db/models/sql/compiler.py",
        "execute_sql",
    )
    assert "none" in m.code_idents and "union" in m.code_idents
    assert "QuerySet.none" in m.dotted and "db.utils" in m.dotted
    assert "django/db/models/sql/query.py" in m.py_paths
    assert m.idents["QuerySet"] == 1


def test_path_and_module_helpers():
    assert path_matches(
        "/venv/site-packages/django/db/models/query.py", "django/db/models/query.py"
    )
    assert not path_matches("/x/notdjango/db/query.py", "django/db/query.py")
    assert module_name("django/db/models/__init__.py") == "django.db.models"
    assert module_name("src/requests/sessions.py") == "requests.sessions"


def test_issue_fields():
    title, code = issue_fields(ISSUE)
    assert title.startswith("QuerySet.none()")
    assert "`qs.none()`" in code and "Traceback" in code


def test_ranking_metrics_counts_gold_outside_the_pool_as_missed():
    # Query 1: 2 gold, one in the pool at rank 2. Query 2: gold at rank 1.
    data = RankingData(
        X=np.zeros((5, 1)),
        y=np.array([0, 1, 0, 1, 0], np.float32),
        group=np.array([3, 2]),
        n_gold=np.array([2, 1]),
        qids=["a", "b"],
    )
    m = ranking_metrics(np.array([3.0, 2.0, 1.0, 5.0, 4.0]), data, ks=(1, 5))
    assert m["recall@1"] == pytest.approx((0 + 1) / 2)
    assert m["recall@5"] == pytest.approx((0.5 + 1) / 2)
    assert m["mrr"] == pytest.approx((1 / 2 + 1) / 2)


def test_ranking_data_split_and_roundtrip(tmp_path):
    data = RankingData(
        X=np.arange(10, dtype=np.float32).reshape(5, 2),
        y=np.array([1, 0, 0, 1, 0], np.float32),
        group=np.array([2, 3]),
        n_gold=np.array([1, 1]),
        qids=["a", "b"],
    )
    second = data.split(np.array([1]))
    assert second.qids == ["b"] and second.X[:, 0].tolist() == [4, 6, 8]
    data.save(tmp_path / "d.npz")
    again = RankingData.load(tmp_path / "d.npz")
    assert again is not None and np.array_equal(again.X, data.X) and again.qids == ["a", "b"]


def test_history_uses_only_strict_ancestors(local_repo):
    cache, first, second = local_repo
    h = RepoHistory(cache, "acme/pkg", cache.root.parent / "history")
    assert [h.hashes[r] for r in h.ancestors(second)] == [first]
    assert len(h.ancestors(first)) == 0
    ev = h.evidence(second, "render the template")
    assert ev.churn == {"pkg/auth.py": 1, "pkg/render.py": 1}


def test_feature_extractor_shapes_and_mentions(local_repo, tmp_path):
    cache, _, second = local_repo
    r = HybridRetriever(HashingEncoder(), store_root=tmp_path / "emb", cache=cache)
    fx = FeatureExtractor(r, FusionParams("zsum", 0.8), history_dir=tmp_path / "hist")
    q = Query("q", "acme/pkg", second, "render_template does not escape\n`render_template(x)`")
    cs = fx.extract(q)
    assert cs.X.shape == (len(cs.ids), len(FEATURES))
    assert cs.Xf.shape == (len(cs.file_rows), len(FILE_FEATURES))
    row = cs.ids.index("pkg/render.py::render_template")
    assert cs.X[row, FEATURES.index("name_in_code")] == 1
    assert cs.X[row, FEATURES.index("name_count")] > 0
    assert np.isfinite(cs.X).all() and np.isfinite(cs.Xf).all()
    r.close()


def test_git_helper_is_shared():
    assert callable(_git)


def test_issue_memory_only_sees_issues_merged_before_the_query():
    from odin.eval.dataset import Instance
    from odin.eval.ground_truth import GoldEntry
    from odin.rank.past_issues import IssueMemory

    def inst(i, repo, created):
        return Instance(i, repo, "c", "", "session login password bug", created)

    def gold(i, repo, fn):
        return GoldEntry(i, repo, "c", files=["a.py"], functions=[fn])

    instances = [
        inst("old", "o/r", "2020-01-01T00:00:00Z"),  # visible: well before the query
        inst("recent", "o/r", "2020-03-20T00:00:00Z"),  # inside the merge margin: hidden
        inst("query", "o/r", "2020-04-01T00:00:00Z"),  # the query itself: hidden
        inst("future", "o/r", "2020-06-01T00:00:00Z"),  # after the query: hidden
        inst("other", "x/y", "2019-01-01T00:00:00Z"),  # another repository: hidden
    ]
    golds = [
        gold("old", "o/r", "a.py::old_fix"),
        gold("recent", "o/r", "a.py::recent_fix"),
        gold("query", "o/r", "a.py::the_answer"),
        gold("future", "o/r", "a.py::future_fix"),
        gold("other", "x/y", "a.py::other_fix"),
    ]
    ev = IssueMemory(instances, golds).evidence("query", "o/r", "session login password bug")
    assert set(ev.unit_count) == {"a.py::old_fix"}
    assert set(ev.unit_sim) == {"a.py::old_fix"}


def test_history_walks_both_parents_of_a_merge(tmp_path):
    from odin.repos import RepoCache

    work = tmp_path / "work"
    work.mkdir()
    for args in (
        ("init", "-q", "-b", "main"),
        ("config", "user.email", "t@t"),
        ("config", "user.name", "t"),
    ):
        _git(work, *args)
    (work / "a.py").write_text("x = 1\n")
    _git(work, "add", ".")
    _git(work, "commit", "-qm", "root")
    _git(work, "checkout", "-qb", "side")
    (work / "b.py").write_text("y = 1\n")
    _git(work, "add", ".")
    _git(work, "commit", "-qm", "fix side bug")
    _git(work, "checkout", "-q", "main")
    (work / "a.py").write_text("x = 2\n")
    _git(work, "commit", "-qam", "main change")
    _git(work, "merge", "-q", "--no-ff", "side", "-m", "merge side")
    merge = _git(work, "rev-parse", "HEAD")
    cache = RepoCache(tmp_path / "cache")
    _git(tmp_path, "clone", "-q", "--bare", str(work), str(cache.mirror_path("acme/m")))

    h = RepoHistory(cache, "acme/m", tmp_path / "hist")
    expected = set(_git(work, "rev-list", merge).split()) - {merge}
    assert {h.hashes[r] for r in h.ancestors(merge)} == expected
    assert len(expected) == 3  # root, the side-branch fix, and the main change
    assert h.evidence(merge, "side bug").churn == {"a.py": 2, "b.py": 1}
