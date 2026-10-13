from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

DATASETS = {
    "lite": "princeton-nlp/SWE-bench_Lite",
    "verified": "princeton-nlp/SWE-bench_Verified",
    "full": "princeton-nlp/SWE-bench",
    # Real issues and merged fixes from ~1,800 other Python projects (CC-BY-4.0). Used through
    # a fixed sample (scripts/sample_rebench.py): "train" and "test" are disjoint projects.
    "rebench": "nebius/SWE-rebench",
}
REBENCH_SAMPLE = Path("data/rebench_sample.json")
_COLUMNS = ["instance_id", "repo", "base_commit", "patch", "problem_statement", "created_at"]


@dataclass(frozen=True, slots=True)
class Instance:
    instance_id: str
    repo: str
    base_commit: str
    patch: str
    problem_statement: str
    created_at: str = ""  # when the fixing pull request was opened (ISO 8601)


def _rows(dataset: str, split: str, parts: int = 1) -> list[dict]:
    rows: list[dict] = []
    for i in range(parts):
        path = hf_hub_download(
            dataset, f"data/{split}-{i:05d}-of-{parts:05d}.parquet", repo_type="dataset"
        )
        rows += pq.read_table(path, columns=_COLUMNS).to_pylist()
    return rows


POSTCUTOFF_MANIFEST = Path("data/contamination/manifest.json")


def _postcutoff_instances() -> list[Instance]:
    manifest = json.loads(POSTCUTOFF_MANIFEST.read_text(encoding="utf-8"))
    wanted = [i["instance_id"] for i in manifest["instances"]]
    found: dict[str, Instance] = {}
    for name in manifest["files"]:
        path = hf_hub_download(
            manifest["source"], name, repo_type="dataset", revision=manifest["revision"]
        )
        for row in pq.read_table(path, columns=_COLUMNS).to_pylist():
            if row["instance_id"] in set(wanted):
                found[row["instance_id"]] = Instance(**row)
    return [found[i] for i in wanted]


def load_instances(name: str = "lite", split: str = "test") -> list[Instance]:
    if name == "holdout":
        from odin.eval.holdout import sealed_instances

        return sealed_instances()
    if name == "postcutoff":
        return _postcutoff_instances()
    if name == "rebench":
        rows = _rows(DATASETS[name], "test", parts=2)  # all ~21k; "filtered" is a subset
        if split in ("train", "test"):
            keep = set(json.loads(REBENCH_SAMPLE.read_text(encoding="utf-8"))[split])
            rows = [r for r in rows if r["instance_id"] in keep]
        return [Instance(**row) for row in rows]
    return [Instance(**row) for row in _rows(DATASETS[name], split)]
