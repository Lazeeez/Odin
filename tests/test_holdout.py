import json

import pytest

from odin import cli
from odin.eval import holdout
from odin.eval.dataset import REBENCH_SAMPLE
from odin.eval.ground_truth import read_gold

FROZEN = {
    "configs": {
        "odin-fast": {
            "retriever": "ltr-ce-notests",
            "frozen_at": "abc123",
            "newest_model_published": None,
        },
        "odin-max": {"retriever": None, "frozen_at": None, "newest_model_published": None},
    }
}
FAST_FUNCTION_LINE = (
    "2027-01-05 | holdout | odin-fast (ltr-ce-notests) | function | "
    "results/holdout/odin-fast_function.json | sealed holdout, ADR 0013\n"
)


def authorize(**changes):
    request = {
        "config": "odin-fast",
        "unseal": True,
        "level": "function",
        "retriever": "ltr-ce-notests",
        "allowed": FROZEN,
        "log_text": "",
        "tree_is_dirty": False,
        "head_contains": True,
    } | changes
    return holdout.authorize(**request)


def test_a_frozen_configuration_is_allowed_once():
    assert authorize()["retriever"] == "ltr-ce-notests"


@pytest.mark.parametrize(
    "changes",
    [
        {"unseal": False},
        {"config": None},
        {"config": "bm25-code"},
        {"config": "odin-max", "retriever": "anything"},
        {"retriever": "ltr-notests"},
        {"tree_is_dirty": True},
        {"head_contains": False},
        {"log_text": FAST_FUNCTION_LINE},
    ],
)
def test_everything_else_is_refused(changes):
    with pytest.raises(holdout.HoldoutRefused):
        authorize(**changes)


def test_the_other_level_is_still_available_after_one_evaluation():
    assert authorize(level="file", log_text=FAST_FUNCTION_LINE)


def test_lite_lines_do_not_spend_the_holdout():
    line = "2026-10-13 | lite | odin-fast | function | results/x.json | nothing decided\n"
    assert not holdout.already_evaluated(line, "odin-fast", "function")


def test_eval_refuses_the_holdout_without_unsealing():
    with pytest.raises(SystemExit, match="sealed"):
        cli.main(["eval", "--retriever", "bm25-code", "--dataset", "holdout"])


def test_eval_refuses_a_configuration_that_is_not_listed():
    argv = ["eval", "--retriever", "bm25-code", "--dataset", "holdout", "--unseal"]
    with pytest.raises(SystemExit, match="not one of the holdout configurations"):
        cli.main([*argv, "--config", "bm25-code"])


def test_eval_refuses_part_of_the_holdout():
    argv = ["eval", "--retriever", "bm25-code", "--dataset", "holdout", "--unseal"]
    with pytest.raises(SystemExit, match="evaluated whole"):
        cli.main([*argv, "--config", "odin-fast", "--repo", "tobymao/sqlglot"])


@pytest.mark.parametrize("command", ["tune", "ltr", "ce-train", "ce-tune"])
def test_training_and_tuning_commands_do_not_accept_the_holdout(command, capsys):
    with pytest.raises(SystemExit) as stopped:
        cli.main([command, "--dataset", "holdout"])
    assert stopped.value.code == 2
    assert "invalid choice: 'holdout'" in capsys.readouterr().err


def test_the_manifest_and_ground_truth_are_unchanged_since_sealing():
    assert holdout.changed_since_sealing() == []


def test_the_ground_truth_lists_exactly_the_manifest():
    manifest = holdout.read_manifest()
    listed = [i["instance_id"] for i in manifest["instances"]]
    assert [g.instance_id for g in read_gold(holdout.GOLD)] == listed
    assert len(set(listed)) == len(listed) == manifest["counts"]["instances"]
    assert all(i["created_at"][:10] >= manifest["cutoff"] for i in manifest["instances"])


def test_no_holdout_project_is_in_any_other_set():
    used = set()
    for path in holdout.GOLD.parent.glob("swebench_*.jsonl"):
        used |= {g.repo for g in read_gold(path)}
    sample = json.loads(REBENCH_SAMPLE.read_text(encoding="utf-8"))
    used |= set(sample["train_repos"]) | set(sample["test_repos"])
    holdout.assert_disjoint(used, "the existing data")


def test_a_set_with_a_holdout_project_is_rejected():
    project = holdout.read_manifest()["instances"][0]["repo"]
    with pytest.raises(holdout.HoldoutRefused, match="1 holdout projects"):
        holdout.assert_disjoint(["django/django", project.upper()], "a training set")
