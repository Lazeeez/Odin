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
_SRC_PATH = re.compile(r"[\w./\\-]+\.(?:py|jsx?|mjs|cjs|tsx?|mts|cts|go|java|rs)\b")
_JS_FRAME = re.compile(
    r"^[ \t]*at (?:async )?(?:new )?(?:([^\s()]+) )?\(?([^\s()]+?):\d+:\d+\)?[ \t]*$", re.M
)
_FIREFOX_FRAME = re.compile(r"^[ \t]*([\w$.<>/]*)@([^\s@]+?):\d+:\d+[ \t]*$", re.M)
_JAVA_FRAME = re.compile(
    r"^[ \t]*at ((?:[\w$]+\.)*)([\w$]+)\.([\w$<>]+)\(([\w$]+\.(?:java|kt)):\d+\)", re.M
)
_GO_FRAME = re.compile(r"^([\w./*()\-]+)\([^()\n]*\)[ \t]*\n[ \t]+(\S+\.go):\d+", re.M)
_RUST_FRAME = re.compile(r"^[ \t]*\d+:[ \t]+(\S+)[ \t]*\n[ \t]+at (\S+\.rs):\d+:\d+", re.M)
_RUST_PANIC = re.compile(r"panicked at ([^\s:]+\.rs):\d+:\d+")
_EXTENSION = re.compile(r"\.(?:py|jsx?|mjs|cjs|tsx?|mts|cts|go|java|rs)$")


def _clean_path(path: str) -> str:
    path = path.replace("\\", "/")
    for prefix in ("file://", "webpack://", "webpack-internal:///"):
        if path.startswith(prefix):
            path = path[len(prefix) :]
    while path.startswith("./"):
        path = path[2:]
    return path


def _last_name(name: str, separators: str = ".") -> str:
    for sep in separators:
        name = name.rsplit(sep, 1)[-1]
    return "" if not name or "<" in name or "{" in name else name


def _other_frames(text: str) -> list[tuple[str, str]]:
    groups: list[list[tuple[str, str]]] = [
        [
            (_clean_path(p), _last_name(n or ""))
            for n, p in _JS_FRAME.findall(text)
            if not p.endswith(".rs")
        ],
        [(_clean_path(p), _last_name(n or "")) for n, p in _FIREFOX_FRAME.findall(text)],
        [((pkg.replace(".", "/") + f), m) for pkg, _, m, f in _JAVA_FRAME.findall(text)],
        [
            (_clean_path(p), _last_name(f.replace("(*", "").replace(")", "")))
            for f, p in _GO_FRAME.findall(text)
        ],
        [(_clean_path(p), _last_name(f, ":")) for f, p in _RUST_FRAME.findall(text)],
    ]
    frames = [frame for g in groups for frame in reversed(g)]
    for path in (_clean_path(p) for p in _RUST_PANIC.findall(text)):
        if not frames or frames[-1][0] != path:
            frames.append((path, ""))
    return frames


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
    def parse(cls, text: str, multilang: bool = False) -> Mentions:
        frames = [(p.replace("\\", "/"), n) for p, n in _FRAME.findall(text)]
        if multilang:
            frames += _other_frames(text)
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
            frame_names=frozenset(n for _, n in frames if n),
            frame_paths=tuple(p for p, _ in frames),
            py_paths=tuple(
                p.replace("\\", "/") for p in (_SRC_PATH if multilang else _PY_PATH).findall(text)
            ),
            last_frame=frames[-1] if frames else None,
        )


def path_matches(mentioned: str, repo_path: str, multilang: bool = False) -> bool:
    """Does a path from the issue (often absolute, from site-packages) name this repo file?"""
    if mentioned == repo_path or mentioned.endswith("/" + repo_path):
        return True
    return multilang and "/" in mentioned and repo_path.endswith("/" + mentioned)


def module_name(repo_path: str, multilang: bool = False) -> str:
    """django/db/models/query.py -> django.db.models.query (src/ layouts keep working)."""
    if multilang and not repo_path.endswith(".py"):
        path = _EXTENSION.sub("", repo_path).removesuffix("/index")
        for root in ("src/main/java/", "src/test/java/", "src/main/kotlin/"):
            if root in path:
                path = path.split(root, 1)[1]
        mod = path.replace("/", ".")
        return mod.removeprefix("src.") if mod.startswith("src.") else mod
    mod = repo_path.removesuffix(".py").removesuffix("/__init__").replace("/", ".")
    return mod.removeprefix("src.") if mod.startswith("src.") else mod
