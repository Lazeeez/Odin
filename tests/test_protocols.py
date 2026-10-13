from odin.eval.protocols import (
    cosil_gold,
    cosil_names,
    locagent_acc_at_k,
    locagent_gold,
    locagent_predictions,
    score_cosil,
    score_locagent,
)

EDITS = ["pkg/a.py:Session.__init__", "pkg/a.py:Session.login", "pkg/b.py:render"]


def test_gold_labels_follow_locagent_at_each_level():
    assert locagent_gold(EDITS, "file") == ["pkg/a.py", "pkg/b.py"]
    assert locagent_gold(EDITS, "module") == ["pkg/a.py:Session", "pkg/b.py:render"]
    assert locagent_gold(EDITS, "function") == [
        "pkg/a.py:Session",
        "pkg/a.py:Session.login",
        "pkg/b.py:render",
    ]


def test_odin_units_are_rewritten_to_locagent_names_without_duplicates():
    ranked = ["pkg/a.py::Session.__init__", "pkg/a.py::Session", "pkg/a.py::Session.login"]
    assert locagent_predictions(ranked, "function") == [
        "pkg/a.py:Session",
        "pkg/a.py:Session.login",
    ]
    assert locagent_predictions(ranked, "module") == ["pkg/a.py:Session"]
    assert locagent_predictions(ranked, "file") == ["pkg/a.py"]


def test_success_needs_every_gold_location_in_the_top_k():
    gold = ["a", "b"]
    assert locagent_acc_at_k(["a", "x", "b"], gold, 3)
    assert not locagent_acc_at_k(["a", "x", "b"], gold, 2)
    assert not locagent_acc_at_k(["a", "x", "y"], gold, 3)


def test_with_more_gold_than_k_the_top_k_must_all_be_gold():
    gold = ["a", "b", "c"]
    assert locagent_acc_at_k(["b", "a"], gold, 2)
    assert not locagent_acc_at_k(["b", "x"], gold, 2)


def test_an_instance_without_a_ranking_counts_as_a_failure():
    labels = {"one": ["pkg/b.py:render"], "two": ["pkg/b.py:render"], "empty": []}
    scored = score_locagent(
        labels,
        {"one": ["pkg/b.py"]},
        {"one": ["pkg/b.py::render"]},
        {"file": (1,), "module": (5,), "function": (5,)},
    )
    assert scored["instances"] == 2
    assert scored["without_a_unit_ranking"] == 1
    assert scored["acc"]["function"]["acc@5"] == 0.5
    assert scored["acc"]["file"]["acc@1"] == 0.5


def test_cosil_matches_functions_by_name_without_the_file():
    files, names = cosil_gold(["pkg/a.py::Session.login", "pkg/b.py"])
    assert files == {"pkg/a.py", "pkg/b.py"}
    assert names == {"Session.login"}
    assert cosil_names(["other/c.py::Session.login", "pkg/a.py::render"]) == [
        "Session.login",
        "render",
    ]


def test_cosil_counts_any_gold_in_the_top_n_over_every_issue():
    labels = {
        "found": ["pkg/a.py::Session.login", "pkg/a.py::Session.logout"],
        "missed": ["pkg/b.py::render"],
        "unranked": ["pkg/b.py::render"],
    }
    scored = score_cosil(
        labels,
        {"found": ["pkg/x.py", "pkg/a.py"], "missed": ["pkg/x.py"]},
        {"found": ["pkg/x.py::other", "pkg/a.py::Session.login"], "missed": ["pkg/x.py::other"]},
    )
    function = scored["scores"]["function"]
    assert scored["instances"] == 3
    assert function["top@1"] == 0
    assert function["top@3"] == 1 / 3
    assert function["mrr"] == (1 / 2) / 3
    assert function["map"] == ((1 / 2) / 2) / 3
    assert scored["scores"]["file"]["top@3"] == 1 / 3
