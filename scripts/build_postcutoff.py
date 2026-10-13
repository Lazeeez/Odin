import json
import sys
from collections import Counter
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import POSTCUTOFF_MANIFEST, REBENCH_SAMPLE  # noqa: E402
from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.holdout import assert_disjoint, read_manifest  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402

RULES = "docs/decisions/0017-holdout-freeze-and-contamination-set.md"
IDENTITY_COLUMNS = ["instance_id", "repo", "base_commit", "created_at"]


def main() -> int:
    if POSTCUTOFF_MANIFEST.exists():
        sys.exit(f"{POSTCUTOFF_MANIFEST} exists; the set is selected once")
    holdout = read_manifest()
    sealed = {i["instance_id"] for i in holdout["instances"]}
    sample = json.loads((ROOT / REBENCH_SAMPLE).read_text(encoding="utf-8"))
    swe_bench = {g.repo.lower() for g in read_gold(ROOT / "data/gold/swebench_full_test.jsonl")}
    trained_on = swe_bench | {r.lower() for r in sample["train_repos"]}
    training_issues = set(sample["train"]) | set(sample["test"])
    training_issues |= {
        g.instance_id for g in read_gold(ROOT / "data/gold/swebench_full_test.jsonl")
    }

    rows: dict[str, dict] = {}
    for name in holdout["files"]:
        path = hf_hub_download(
            holdout["source"], name, repo_type="dataset", revision=holdout["revision"]
        )
        for row in pq.read_table(path, columns=IDENTITY_COLUMNS).to_pylist():
            rows[row["instance_id"]] = row
    kept = sorted(
        (
            r
            for r in rows.values()
            if r["created_at"][:10] >= holdout["cutoff"]
            and r["instance_id"] not in sealed
            and r["instance_id"] not in training_issues
            and r["repo"].lower() in trained_on
        ),
        key=lambda r: (r["repo"].lower(), r["created_at"], r["instance_id"]),
    )
    assert_disjoint({r["repo"] for r in kept}, "the post-cutoff set")
    per_project = Counter(r["repo"] for r in kept)
    manifest = {
        "name": "odin-postcutoff",
        "rules": RULES,
        "source": holdout["source"],
        "source_licence": "CC-BY-4.0",
        "revision": holdout["revision"],
        "files": holdout["files"],
        "cutoff": holdout["cutoff"],
        "selection": (
            f"every instance created on or after {holdout['cutoff']} that is not in the holdout, "
            "is not a training issue, and belongs to a project Odin trained or tuned on"
        ),
        "counts": {
            "instances": len(kept),
            "projects": len(per_project),
            "from_swe_bench_projects": sum(r["repo"].lower() in swe_bench for r in kept),
            "largest_project": max(per_project.values()),
        },
        "provenance": provenance(),
        "instances": kept,
    }
    POSTCUTOFF_MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    POSTCUTOFF_MANIFEST.write_text(
        json.dumps(manifest, indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    print(json.dumps(manifest["counts"], indent=1))
    print(f"wrote {POSTCUTOFF_MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
