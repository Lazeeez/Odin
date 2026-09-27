from __future__ import annotations

from dataclasses import dataclass, field

from unidiff import PatchSet


@dataclass(frozen=True, slots=True)
class Insertion:
    after: int
    before: int
    indent: int


@dataclass(slots=True)
class FileEdit:
    path: str
    status: str
    removed_lines: set[int] = field(default_factory=set)
    insertions: set[Insertion] = field(default_factory=set)


def _indent(text: str) -> int | None:
    stripped = text.lstrip(" \t")
    if not stripped.strip() or stripped.startswith("#"):
        return None
    return len(text) - len(stripped)


def parse_patch(patch: str) -> list[FileEdit]:
    edits: list[FileEdit] = []
    for pf in PatchSet(patch):
        if pf.is_added_file:
            edits.append(FileEdit(path=pf.path, status="added"))
            continue
        if pf.is_removed_file:
            status = "removed"
        elif pf.is_rename:
            status = "renamed"
        else:
            status = "modified"
        edit = FileEdit(path=pf.source_file.removeprefix("a/"), status=status)
        for hunk in pf:
            prev = hunk.source_start if hunk.source_length == 0 else hunk.source_start - 1
            pending: int | None = None
            for line in hunk:
                if line.is_added:
                    ind = _indent(line.value)
                    if ind is not None:
                        pending = ind if pending is None else min(pending, ind)
                    continue
                if pending is not None:
                    edit.insertions.add(Insertion(prev, line.source_line_no, pending))
                    pending = None
                if line.is_removed:
                    edit.removed_lines.add(line.source_line_no)
                prev = line.source_line_no
            if pending is not None:
                edit.insertions.add(Insertion(prev, prev + 1, pending))
        edits.append(edit)
    return edits
