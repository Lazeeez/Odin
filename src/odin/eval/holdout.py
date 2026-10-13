from __future__ import annotations

import hashlib
import json
import subprocess
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from odin.eval.dataset import Instance

SOURCE = "nebius/SWE-rebench-leaderboard"
HOLDOUT_DIR = Path("data/holdout")
MANIFEST = HOLDOUT_DIR / "manifest.json"
ALLOWED = HOLDOUT_DIR / "allowed.json"
CHECKSUMS = HOLDOUT_DIR / "SHA256SUMS"
GOLD = Path("data/gold/odin_holdout.jsonl")
EVAL_LOG = Path("results/test-evals.log")
RESULTS = Path("results/holdout")
RULES = "docs/decisions/0013-sealed-holdout.md"
LEVELS = ("file", "function")
SEALED_COLUMNS = ["instance_id", "repo", "base_commit", "patch", "created_at"]


class HoldoutRefused(Exception):
    pass


def read_manifest() -> dict:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def holdout_repos() -> set[str]:
    return {i["repo"].lower() for i in read_manifest()["instances"]}


def assert_disjoint(repos: Iterable[str], what: str) -> None:
    shared = sorted({r.lower() for r in repos} & holdout_repos())
    if shared:
        raise HoldoutRefused(
            f"{what} contains {len(shared)} holdout projects ({', '.join(shared[:5])}); "
            f"holdout projects stay out of every training and dev set ({RULES})"
        )


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def recorded_checksums() -> dict[str, str]:
    pairs = (line.split() for line in CHECKSUMS.read_text(encoding="utf-8").splitlines() if line)
    return {name: digest for digest, name in pairs}


def changed_since_sealing() -> list[str]:
    return [name for name, digest in recorded_checksums().items() if sha256(Path(name)) != digest]


def _instances(with_issue_text: bool) -> list[Instance]:
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    manifest = read_manifest()
    wanted = {i["instance_id"] for i in manifest["instances"]}
    columns = [*SEALED_COLUMNS, "problem_statement"] if with_issue_text else SEALED_COLUMNS
    found: dict[str, Instance] = {}
    for name in manifest["files"]:
        path = hf_hub_download(SOURCE, name, repo_type="dataset", revision=manifest["revision"])
        for row in pq.read_table(path, columns=columns).to_pylist():
            if row["instance_id"] in wanted:
                found[row["instance_id"]] = Instance(**({"problem_statement": ""} | row))
    missing = wanted - found.keys()
    if missing:
        raise HoldoutRefused(f"{len(missing)} holdout instances are missing from {SOURCE}")
    return [found[i["instance_id"]] for i in manifest["instances"]]


def sealed_instances() -> list[Instance]:
    return _instances(with_issue_text=False)


def already_evaluated(log_text: str, config: str, level: str) -> bool:
    for line in log_text.splitlines():
        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 4 or cells[1] != "holdout" or cells[3] != level:
            continue
        if cells[2].split(" ")[0] == config:
            return True
    return False


def authorize(
    config: str | None,
    unseal: bool,
    level: str,
    retriever: str,
    allowed: dict,
    log_text: str,
    tree_is_dirty: bool,
    head_contains: bool,
) -> dict:
    if not unseal or not config:
        raise HoldoutRefused(f"the holdout is sealed: pass --unseal and --config NAME ({RULES})")
    entry = allowed["configs"].get(config)
    if entry is None:
        names = ", ".join(sorted(allowed["configs"]))
        raise HoldoutRefused(f"{config} is not one of the holdout configurations ({names})")
    if not entry.get("frozen_at") or not entry.get("retriever"):
        raise HoldoutRefused(f"{config} has no frozen design in {ALLOWED} yet")
    if entry["retriever"] != retriever:
        raise HoldoutRefused(f"{config} was frozen as {entry['retriever']}, not {retriever}")
    if level not in LEVELS:
        raise HoldoutRefused(f"unknown level {level}")
    if tree_is_dirty:
        raise HoldoutRefused("the working tree has uncommitted changes; commit before unsealing")
    if not head_contains:
        raise HoldoutRefused(f"HEAD does not contain the commit {config} was frozen at")
    if already_evaluated(log_text, config, level):
        raise HoldoutRefused(f"{config} has already been evaluated on the holdout at {level} level")
    return entry


def _git_ok(*args: str) -> bool:
    return subprocess.run(["git", *args], capture_output=True).returncode == 0


def _tree_is_dirty() -> bool:
    out = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=no"], capture_output=True, text=True
    )
    return out.returncode != 0 or bool(out.stdout.strip())


def result_path(config: str, level: str) -> Path:
    return RESULTS / f"{config}_{level}.json"


def unseal(config: str | None, unseal_flag: bool, level: str, retriever: str) -> tuple[dict, dict]:
    allowed = json.loads(ALLOWED.read_text(encoding="utf-8"))
    frozen_at = (allowed["configs"].get(config or "") or {}).get("frozen_at") or ""
    entry = authorize(
        config,
        unseal_flag,
        level,
        retriever,
        allowed,
        EVAL_LOG.read_text(encoding="utf-8") if EVAL_LOG.exists() else "",
        _tree_is_dirty(),
        bool(frozen_at) and _git_ok("merge-base", "--is-ancestor", frozen_at, "HEAD"),
    )
    changed = changed_since_sealing()
    if changed:
        raise HoldoutRefused(f"changed since sealing: {', '.join(changed)}")
    if result_path(config, level).exists():
        raise HoldoutRefused(f"{result_path(config, level)} exists; results are never overwritten")
    manifest = read_manifest()
    since = entry.get("newest_model_published") or manifest["cutoff"]
    since = max(since, manifest["cutoff"])
    eligible = {i["instance_id"] for i in manifest["instances"] if i["created_at"][:10] >= since}
    queries = {
        i.instance_id: i.problem_statement
        for i in _instances(with_issue_text=True)
        if i.instance_id in eligible
    }
    return queries, {"config": config, "issues_created_on_or_after": since, "frozen": entry}


def record(config: str, retriever: str, level: str, issues: int, since: str) -> str:
    line = " | ".join(
        [
            datetime.now(UTC).date().isoformat(),
            "holdout",
            f"{config} ({retriever})",
            level,
            result_path(config, level).as_posix(),
            f"sealed holdout, ADR 0013; {issues} issues created on or after {since}",
        ]
    )
    with EVAL_LOG.open("a", encoding="utf-8", newline="\n") as log:
        log.write(line + "\n")
    return line
