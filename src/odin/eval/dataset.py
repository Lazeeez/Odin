from __future__ import annotations

from dataclasses import dataclass

import pyarrow.parquet as pq
from huggingface_hub import hf_hub_download

DATASETS = {
    "lite": "princeton-nlp/SWE-bench_Lite",
    "verified": "princeton-nlp/SWE-bench_Verified",
    "full": "princeton-nlp/SWE-bench",
}


@dataclass(frozen=True, slots=True)
class Instance:
    instance_id: str
    repo: str
    base_commit: str
    patch: str
    problem_statement: str
    created_at: str = ""  # when the fixing pull request was opened (ISO 8601)


def load_instances(name: str = "lite", split: str = "test") -> list[Instance]:
    path = hf_hub_download(
        DATASETS[name], f"data/{split}-00000-of-00001.parquet", repo_type="dataset"
    )
    rows = pq.read_table(
        path,
        columns=["instance_id", "repo", "base_commit", "patch", "problem_statement", "created_at"],
    ).to_pylist()
    return [Instance(**row) for row in rows]
