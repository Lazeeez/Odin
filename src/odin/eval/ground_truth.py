from __future__ import annotations

import json
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path

from odin.eval.dataset import Instance
from odin.eval.goldpatch import FileEdit, Insertion, parse_patch
from odin.parsing.python_symbols import (
    CLASS,
    Symbol,
    extract_symbols,
    innermost,
    retrieval_unit,
)
from odin.repos import GitError, RepoCache


@dataclass(slots=True)
class GoldEntry:
    instance_id: str
    repo: str
    base_commit: str
    files: list[str] = field(default_factory=list)
    functions: list[str] = field(default_factory=list)
    classes: list[str] = field(default_factory=list)
    module_level_files: list[str] = field(default_factory=list)
    added_files: list[str] = field(default_factory=list)
    non_python_files: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _insertion_owner(symbols: list[Symbol], ins: Insertion) -> Symbol | None:
    best: Symbol | None = None
    for s in symbols:
        if ins.indent <= s.col:
            continue
        if not (s.contains(ins.after) or s.contains(ins.before)):
            continue
        if best is None or s.span < best.span:
            best = s
    return best


def locate(edit: FileEdit, symbols: list[Symbol]) -> tuple[set[Symbol], bool]:
    owners: set[Symbol] = set()
    module_level = False
    for line in edit.removed_lines:
        s = innermost(symbols, line)
        if s is None:
            module_level = True
        else:
            owners.add(s)
    for ins in edit.insertions:
        s = _insertion_owner(symbols, ins)
        if s is None:
            module_level = True
        else:
            owners.add(s)
    return owners, module_level


def gold_for_instance(inst: Instance, cache: RepoCache) -> GoldEntry:
    entry = GoldEntry(inst.instance_id, inst.repo, inst.base_commit)
    functions: set[str] = set()
    classes: set[str] = set()
    for edit in parse_patch(inst.patch):
        if edit.status == "added":
            entry.added_files.append(edit.path)
            continue
        if not edit.path.endswith(".py"):
            entry.non_python_files.append(edit.path)
            continue
        entry.files.append(edit.path)
        try:
            source = cache.read_file(inst.repo, inst.base_commit, edit.path)
        except GitError as exc:
            entry.errors.append(str(exc))
            continue
        symbols = extract_symbols(source, edit.path)
        owners, module_level = locate(edit, symbols)
        if module_level:
            entry.module_level_files.append(edit.path)
        for s in {retrieval_unit(symbols, o) for o in owners}:
            (classes if s.kind == CLASS else functions).add(s.id)
    entry.functions = sorted(functions)
    entry.classes = sorted(classes)
    return entry


def _prefetch(inst_group: list[Instance], cache: RepoCache) -> None:
    specs: list[str] = []
    for inst in inst_group:
        cache.ensure_commit(inst.repo, inst.base_commit)
        for edit in parse_patch(inst.patch):
            if edit.status != "added" and edit.path.endswith(".py"):
                specs.append(f"{inst.base_commit}:{edit.path}")
    if inst_group:
        cache.prefetch_blobs(inst_group[0].repo, specs)


def build_gold(instances: list[Instance], cache: RepoCache, workers: int = 8) -> list[GoldEntry]:
    by_repo: dict[str, list[Instance]] = defaultdict(list)
    for inst in instances:
        by_repo[inst.repo].append(inst)

    def run(group: list[Instance]) -> list[GoldEntry]:
        _prefetch(group, cache)
        return [gold_for_instance(inst, cache) for inst in group]

    with ThreadPoolExecutor(max_workers=workers) as pool:
        results = [e for group in pool.map(run, by_repo.values()) for e in group]
    order = {inst.instance_id: i for i, inst in enumerate(instances)}
    return sorted(results, key=lambda e: order[e.instance_id])


def write_gold(entries: list[GoldEntry], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Pin encoding and newlines so the committed dataset is byte-identical on every OS.
    with path.open("w", encoding="utf-8", newline="\n") as fh:
        for e in entries:
            fh.write(json.dumps(asdict(e)) + "\n")


def read_gold(path: Path) -> list[GoldEntry]:
    with path.open(encoding="utf-8") as fh:
        return [GoldEntry(**json.loads(line)) for line in fh if line.strip()]
