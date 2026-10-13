from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass

LEVELS = ("file", "module", "function")


@dataclass(frozen=True)
class LabelSource:
    dataset: str
    revision: str
    path: str


@dataclass(frozen=True)
class Protocol:
    name: str
    paper: str
    labels: LabelSource
    ks: dict[str, tuple[int, ...]]


LOCAGENT_LITE = Protocol(
    name="locagent-lite",
    paper="LocAgent (arXiv:2503.09089), evaluation/eval_metric.py; also used by SweRank",
    labels=LabelSource(
        "czlll/SWE-bench_Lite",
        "97f9af8814fe7eb15dcd9b2abaa9010e1eadda63",
        "data/test-00000-of-00001.parquet",
    ),
    ks={"file": (1, 3, 5), "module": (5, 10), "function": (5, 10)},
)
PROTOCOLS = {LOCAGENT_LITE.name: LOCAGENT_LITE}


def _unique(items: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _without_init(qualname: str) -> str:
    return qualname.removesuffix(".__init__")


def locagent_gold(edit_functions: Sequence[str], level: str) -> list[str]:
    split = [entry.split(":") for entry in edit_functions]
    if level == "file":
        return _unique(parts[0] for parts in split)
    if level == "module":
        return _unique(f"{parts[0]}:{parts[-1].split('.')[0]}" for parts in split)
    return _unique(f"{parts[0]}:{_without_init(parts[-1])}" for parts in split)


def locagent_predictions(ranked: Sequence[str], level: str) -> list[str]:
    if level == "file":
        return _unique(unit.split("::")[0] for unit in ranked)
    split = [unit.split("::") for unit in ranked if "::" in unit]
    if level == "module":
        return _unique(f"{path}:{qualname.split('.')[0]}" for path, qualname in split)
    return _unique(f"{path}:{_without_init(qualname)}" for path, qualname in split)


def locagent_acc_at_k(predictions: Sequence[str], gold: Sequence[str], k: int) -> bool:
    found = sum(p in gold for p in predictions[:k])
    return found == min(len(gold), k)


def load_labels(source: LabelSource) -> dict[str, list[str]]:
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    path = hf_hub_download(
        source.dataset, source.path, repo_type="dataset", revision=source.revision
    )
    rows = pq.read_table(path, columns=["instance_id", "edit_functions"]).to_pylist()
    return {row["instance_id"]: list(row["edit_functions"]) for row in rows}


def score_locagent(
    labels: dict[str, list[str]],
    ranked_files: dict[str, list[str]],
    ranked_units: dict[str, list[str]],
    ks: dict[str, tuple[int, ...]],
) -> dict:
    scored = [i for i, edits in labels.items() if edits]
    hits = {level: {k: [] for k in ks[level]} for level in LEVELS}
    for instance in scored:
        for level in LEVELS:
            ranked = (ranked_files if level == "file" else ranked_units).get(instance, [])
            predictions = locagent_predictions(ranked, level)
            gold = locagent_gold(labels[instance], level)
            for k in ks[level]:
                hits[level][k].append(locagent_acc_at_k(predictions, gold, k))
    return {
        "instances": len(scored),
        "without_a_file_ranking": sum(i not in ranked_files for i in scored),
        "without_a_unit_ranking": sum(i not in ranked_units for i in scored),
        "acc": {
            level: {f"acc@{k}": sum(h) / len(h) for k, h in by_k.items()}
            for level, by_k in hits.items()
        },
        "per_instance": {
            level: {f"acc@{k}": [int(x) for x in h] for k, h in by_k.items()}
            for level, by_k in hits.items()
        },
        "instance_ids": scored,
    }
