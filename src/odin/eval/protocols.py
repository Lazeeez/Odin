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
COSIL_LITE = Protocol(
    name="cosil-lite",
    paper="CoSIL (arXiv:2503.22424), evaluation/FLEvalNew.py and evaluation/gt.json",
    labels=LabelSource(
        "https://raw.githubusercontent.com/ZhonghaoJiang/CoSIL",
        "0568e423735b399d5b089996961fea9ae142e4c7",
        "evaluation/gt.json",
    ),
    ks={"file": (1, 3, 5), "function": (1, 3, 5)},
)
COSIL_DEPTH = 5
PROTOCOLS = {LOCAGENT_LITE.name: LOCAGENT_LITE, COSIL_LITE.name: COSIL_LITE}


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


def load_cosil_labels(source: LabelSource) -> dict[str, list[str]]:
    import json
    import urllib.request

    url = f"{source.dataset}/{source.revision}/{source.path}"
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def cosil_gold(entries: Sequence[str]) -> tuple[set[str], set[str]]:
    files, names = set(), set()
    for entry in entries:
        parts = entry.split("::")
        if len(parts) == 2:
            files.add(parts[0])
            names.add(parts[1])
        elif len(parts) == 1:
            files.add(parts[0])
    return files, names


def cosil_names(ranked_units: Sequence[str]) -> list[str]:
    return [unit.split("::")[1] for unit in ranked_units if "::" in unit]


def _average_precision(gold: set[str], predictions: Sequence[str]) -> float:
    if not gold:
        return 0.0
    hits, total = 0, 0.0
    for position, item in enumerate(predictions, start=1):
        if item in gold:
            hits += 1
            total += hits / position
    return total / len(gold)


def _reciprocal_rank(gold: set[str], predictions: Sequence[str]) -> float:
    for position, item in enumerate(predictions, start=1):
        if item in gold:
            return 1.0 / position
    return 0.0


def score_cosil(
    labels: dict[str, list[str]],
    ranked_files: dict[str, list[str]],
    ranked_units: dict[str, list[str]],
) -> dict:
    per_instance: dict[str, dict[str, list[float]]] = {"file": {}, "function": {}}
    for instance, entries in labels.items():
        gold_files, gold_names = cosil_gold(entries)
        files = ranked_files.get(instance, [])[:COSIL_DEPTH]
        names = cosil_names(ranked_units.get(instance, []))[:COSIL_DEPTH] if files else []
        for level, gold, predictions in (
            ("file", gold_files, files),
            ("function", gold_names, names),
        ):
            row = per_instance[level]
            for k in COSIL_LITE.ks[level]:
                hit = any(item in gold for item in predictions[:k])
                row.setdefault(f"top@{k}", []).append(float(hit))
            row.setdefault("map", []).append(_average_precision(gold, predictions))
            row.setdefault("mrr", []).append(_reciprocal_rank(gold, predictions))
    return {
        "instances": len(labels),
        "without_a_file_ranking": sum(i not in ranked_files for i in labels),
        "without_a_unit_ranking": sum(i not in ranked_units for i in labels),
        "scores": {
            level: {metric: sum(values) / len(labels) for metric, values in rows.items()}
            for level, rows in per_instance.items()
        },
        "per_instance": per_instance,
        "instance_ids": list(labels),
    }
