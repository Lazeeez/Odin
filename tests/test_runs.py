import json
from types import SimpleNamespace

import pytest

from odin.eval import runs

ISSUES = ("pkg__one-1", "pkg__one-2")


def invocation(manifest_digest, **changes):
    record = {
        "manifest_sha256": manifest_digest,
        "local": False,
        "provenance": {"git_commit": "abc123", "git_dirty": False},
    }
    return record | changes


@pytest.fixture
def finished_run(tmp_path, monkeypatch):
    manifests = tmp_path / "manifests"
    manifest = {"name": "toy", "dataset": "lite", "split": "test", "level": "function"}
    runs.write_json(manifests / "toy.json", manifest)
    monkeypatch.setattr(runs, "MANIFESTS", manifests)
    monkeypatch.setattr(runs, "_committed", lambda commit: commit == "abc123")
    monkeypatch.setattr(
        runs, "issues_of", lambda manifest, limit: [SimpleNamespace(instance_id=i) for i in ISSUES]
    )
    run = tmp_path / "run"
    run.mkdir()
    (run / "manifest.json").write_bytes((manifests / "toy.json").read_bytes())
    for issue in ISSUES:
        runs.write_json(run / "rankings" / f"{issue}.json", {"instance_id": issue, "ranked": []})
    digest = runs.sha256(run / "manifest.json")
    runs.write_json(run / "run.json", {"invocations": [invocation(digest)]})
    runs.seal(run)
    return run


def rewrite_invocation(run, **changes):
    digest = runs.sha256(run / "manifest.json")
    runs.write_json(run / "run.json", {"invocations": [invocation(digest, **changes)]})
    runs.seal(run)


def test_a_complete_clean_run_verifies(finished_run):
    manifest, rankings = runs.verify(finished_run)
    assert manifest["name"] == "toy"
    assert sorted(rankings) == sorted(ISSUES)


def test_a_changed_ranking_is_refused(finished_run):
    target = finished_run / "rankings" / f"{ISSUES[0]}.json"
    target.write_text(target.read_text() + " ")
    with pytest.raises(runs.RunRefused, match="checksum mismatch"):
        runs.verify(finished_run)


def test_an_added_file_is_refused(finished_run):
    runs.write_json(finished_run / "rankings" / "extra.json", {"ranked": []})
    with pytest.raises(runs.RunRefused, match="checksum list differ"):
        runs.verify(finished_run)


def test_a_missing_issue_is_refused(finished_run):
    (finished_run / "rankings" / f"{ISSUES[1]}.json").unlink()
    runs.seal(finished_run)
    with pytest.raises(runs.RunRefused, match="ranked 1 issues, the manifest names 2"):
        runs.verify(finished_run)


@pytest.mark.parametrize(
    ("changes", "reason"),
    [
        ({"local": True}, "--local"),
        ({"provenance": {"git_commit": "abc123", "git_dirty": True}}, "uncommitted"),
        ({"provenance": {"git_commit": "ffffff", "git_dirty": False}}, "does not have"),
        ({"manifest_sha256": "0" * 64}, "different manifest"),
    ],
)
def test_runs_that_cannot_be_traced_are_refused(finished_run, changes, reason):
    rewrite_invocation(finished_run, **changes)
    with pytest.raises(runs.RunRefused, match=reason):
        runs.verify(finished_run)


def test_a_manifest_that_is_not_the_committed_one_is_refused(finished_run):
    edited = json.loads((finished_run / "manifest.json").read_text()) | {"top_k": 5}
    runs.write_json(finished_run / "manifest.json", edited)
    rewrite_invocation(finished_run)
    with pytest.raises(runs.RunRefused, match="not the committed"):
        runs.verify(finished_run)


def test_a_manifest_cannot_name_the_holdout(tmp_path):
    runs.write_json(tmp_path / "m.json", {"name": "x", "dataset": "holdout"})
    with pytest.raises(runs.RunRefused, match="holdout"):
        runs.load_manifest(tmp_path / "m.json")


def test_every_committed_manifest_is_well_formed():
    for path in sorted(runs.MANIFESTS.glob("*.json")):
        manifest = runs.load_manifest(path)
        assert manifest["name"] == path.stem
        assert {"what", "why", "dataset", "split", "level", "top_k", "retriever"} <= set(manifest)
