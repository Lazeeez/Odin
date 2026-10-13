from odin.eval.protocols import (
    locagent_acc_at_k,
    locagent_gold,
    locagent_predictions,
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
