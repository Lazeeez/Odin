from __future__ import annotations

from dataclasses import dataclass

from odin.parsing.python_symbols import call_sites, extract_symbols, parse

MODULE = "module"


@dataclass(frozen=True, slots=True)
class Chunk:
    """One retrieval unit. `qualname` is empty for the module-level remainder."""

    qualname: str
    kind: str
    start_line: int
    end_line: int
    text: str
    calls: tuple[str, ...] = ()

    def id(self, path: str) -> str:
        return f"{path}::{self.qualname}" if self.qualname else path


def chunk_file(source: bytes, path: str) -> list[Chunk]:
    """Split a file into the same units ground truth is labelled with.

    Each non-nested function, method and class becomes a chunk. A chunk owns only the lines
    no inner unit claims, so a class chunk holds its header, docstring and attributes while
    each method is its own chunk. Nested functions stay inside their enclosing unit. Lines
    outside every unit (imports, constants) form a module chunk, used for file-level search.
    Each unit also records the names it calls, for call-graph expansion.
    """
    tree = parse(source)
    lines = source.decode("utf-8", "replace").splitlines()
    units = [s for s in extract_symbols(source, path, tree) if not s.nested]
    owner = [-1] * (len(lines) + 2)
    # Symbols are sorted outer-first by start line, so inner units overwrite their parents.
    for i, s in enumerate(units):
        for ln in range(s.start_line, min(s.end_line, len(lines)) + 1):
            owner[ln] = i
    owned: list[list[str]] = [[] for _ in units]
    module: list[str] = []
    for ln, text in enumerate(lines, start=1):
        (module if owner[ln] < 0 else owned[owner[ln]]).append(text)
    calls: list[dict[str, None]] = [{} for _ in units]
    for name, ln in call_sites(tree):
        if 0 < ln < len(owner) and owner[ln] >= 0:
            calls[owner[ln]][name] = None
    chunks = [
        Chunk(s.qualname, s.kind, s.start_line, s.end_line, "\n".join(owned[i]), tuple(calls[i]))
        for i, s in enumerate(units)
    ]
    if any(t.strip() for t in module):
        chunks.append(Chunk("", MODULE, 1, len(lines), "\n".join(module)))
    return chunks
