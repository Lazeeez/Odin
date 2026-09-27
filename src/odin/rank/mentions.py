from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

# Python traceback frames: File ".../django/db/models/query.py", line 123, in filter
_FRAME = re.compile(r'File "([^"]+)", line \d+, in ([A-Za-z_<][\w<>]*)')
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_DOTTED = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+")
_PY_PATH = re.compile(r"[\w./\\-]+\.py\b")
_FENCE = re.compile(r"```.*?```", re.S)
_INLINE = re.compile(r"`[^`\n]+`")


@dataclass(frozen=True, slots=True)
class Mentions:
    """What an issue explicitly names: the strongest and cheapest localization evidence.

    Reporters paste tracebacks, quote method names in backticks and cite module paths. These
    are exact-match signals that bag-of-words scoring dilutes among hundreds of other terms.
    """

    idents: Counter[str]  # every identifier, case-sensitive
    code_idents: frozenset[str]  # identifiers inside code fences or backticks
    dotted: frozenset[str]  # a.b.c names and every contiguous sub-path of them
    frame_names: frozenset[str]  # function names in traceback frames
    frame_paths: tuple[str, ...]  # file paths in traceback frames, '/'-separated
    py_paths: tuple[str, ...]  # any *.py path mentioned
    last_frame: tuple[str, str] | None  # innermost frame (path, name): where it blew up

    @classmethod
    def parse(cls, text: str) -> Mentions:
        frames = [(p.replace("\\", "/"), n) for p, n in _FRAME.findall(text)]
        code = " ".join(_FENCE.findall(text) + _INLINE.findall(text))
        dotted: set[str] = set()
        for d in _DOTTED.findall(text):
            parts = d.split(".")
            for i in range(len(parts)):
                for j in range(i + 2, len(parts) + 1):
                    dotted.add(".".join(parts[i:j]))
        return cls(
            idents=Counter(_IDENT.findall(text)),
            code_idents=frozenset(_IDENT.findall(code)),
            dotted=frozenset(dotted),
            frame_names=frozenset(n for _, n in frames),
            frame_paths=tuple(p for p, _ in frames),
            py_paths=tuple(p.replace("\\", "/") for p in _PY_PATH.findall(text)),
            last_frame=frames[-1] if frames else None,
        )


def path_matches(mentioned: str, repo_path: str) -> bool:
    """Does a path from the issue (often absolute, from site-packages) name this repo file?"""
    return mentioned == repo_path or mentioned.endswith("/" + repo_path)


def module_name(repo_path: str) -> str:
    """django/db/models/query.py -> django.db.models.query (src/ layouts keep working)."""
    mod = repo_path.removesuffix(".py").removesuffix("/__init__").replace("/", ".")
    return mod.removeprefix("src.") if mod.startswith("src.") else mod
