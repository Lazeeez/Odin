import argparse
import json
import sys
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import REBENCH_SAMPLE  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.holdout import (  # noqa: E402
    ALLOWED,
    CHECKSUMS,
    GOLD,
    MANIFEST,
    RULES,
    SOURCE,
    sha256,
)
from odin.eval.provenance import provenance  # noqa: E402

CUTOFF = "2025-09-01"
IDENTITY_COLUMNS = ["instance_id", "repo", "base_commit", "created_at"]
CONFIGS = ("odin-fast", "odin-max", "odin-escalation")


def projects_already_used() -> dict[str, list[str]]:
    used: dict[str, set[str]] = {}
    for path in sorted((ROOT / "data" / "gold").glob("swebench_*.jsonl")):
        used[path.name] = {g.repo.lower() for g in read_gold(path)}
    sample = json.loads((ROOT / REBENCH_SAMPLE).read_text(encoding="utf-8"))
    used[REBENCH_SAMPLE.name] = {r.lower() for r in sample["train_repos"] + sample["test_repos"]}
    return {name: sorted(repos) for name, repos in used.items()}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8", newline="\n")


def build_manifest(revision: str | None) -> int:
    if MANIFEST.exists():
        sys.exit(f"{MANIFEST} exists; the holdout is selected once")
    api = HfApi()
    revision = revision or api.dataset_info(SOURCE).sha
    files = sorted(
        f
        for f in api.list_repo_files(SOURCE, repo_type="dataset", revision=revision)
        if f.endswith(".parquet")
    )
    rows: dict[str, dict] = {}
    for name in files:
        path = hf_hub_download(SOURCE, name, repo_type="dataset", revision=revision)
        for row in pq.read_table(path, columns=IDENTITY_COLUMNS).to_pylist():
            rows[row["instance_id"]] = row
    used = projects_already_used()
    excluded = {repo for repos in used.values() for repo in repos}
    recent = [r for r in rows.values() if r["created_at"][:10] >= CUTOFF]
    kept = sorted(
        (r for r in recent if r["repo"].lower() not in excluded),
        key=lambda r: (r["repo"].lower(), r["created_at"], r["instance_id"]),
    )
    per_project = Counter(r["repo"] for r in kept)
    write_json(
        MANIFEST,
        {
            "name": "odin-holdout",
            "rules": RULES,
            "source": SOURCE,
            "source_licence": "CC-BY-4.0",
            "revision": revision,
            "files": files,
            "cutoff": CUTOFF,
            "selection": (
                f"every instance created on or after {CUTOFF} whose project appears in no other "
                "Odin training, dev or test data"
            ),
            "counts": {
                "source_instances": len(rows),
                "created_on_or_after_cutoff": len(recent),
                "dropped_for_a_used_project": len(recent) - len(kept),
                "instances": len(kept),
                "projects": len(per_project),
                "largest_project": max(per_project.values()),
                "by_month": dict(sorted(Counter(r["created_at"][:7] for r in kept).items())),
            },
            "projects_excluded": {name: len(repos) for name, repos in used.items()},
            "projects_excluded_total": len(excluded),
            "provenance": provenance(),
            "instances": kept,
        },
    )
    write_json(
        ALLOWED,
        {
            "rules": RULES,
            "configs": {
                name: {"retriever": None, "frozen_at": None, "newest_model_published": None}
                for name in CONFIGS
            },
        },
    )
    print(json.dumps(json.loads(MANIFEST.read_text(encoding="utf-8"))["counts"], indent=1))
    print(f"wrote {MANIFEST} and {ALLOWED}")
    return 0


def seal() -> int:
    if CHECKSUMS.exists():
        sys.exit(f"{CHECKSUMS} exists; the holdout is sealed once")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    gold = read_gold(GOLD)
    if [g.instance_id for g in gold] != [i["instance_id"] for i in manifest["instances"]]:
        sys.exit("the ground truth and the manifest list different instances")
    lines = [f"{sha256(path)}  {path.as_posix()}\n" for path in (MANIFEST, GOLD)]
    CHECKSUMS.write_text("".join(lines), encoding="utf-8", newline="\n")
    print("".join(lines), end="")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["manifest", "seal"])
    ap.add_argument("--revision")
    args = ap.parse_args()
    return build_manifest(args.revision) if args.step == "manifest" else seal()


if __name__ == "__main__":
    sys.exit(main())
