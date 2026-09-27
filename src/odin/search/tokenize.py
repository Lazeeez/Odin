from __future__ import annotations

import re
from collections import Counter
from collections.abc import Callable
from functools import lru_cache

_WORD = re.compile(r"\w+")
_IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
# HTTPServerError -> HTTP, Server, Error; parse2d -> parse, 2, d is dropped by min length
_SUBWORD = re.compile(r"[A-Z]+(?=[A-Z][a-z])|[A-Z]?[a-z]+|[A-Z]+|\d+")

_STOPWORDS = """
    a an and are as at be but by for from has have if in into is it its of on or so that the
    their then there these this to was were will with not no can do does i we you when which
    self cls def return none true false import pass else elif try except raise lambda class
"""
STOPWORDS = frozenset(_STOPWORDS.split())

# Text -> term counts. Counting is the only thing BM25 needs, and it lets both tokenizers
# collapse repeated words in C (Counter over re.findall) before any per-token Python work.
Tokenizer = Callable[[str], Counter[str]]


def naive(text: str) -> list[str]:
    """Baseline: lowercase `\\w+` runs. `get_queryset` stays one opaque token."""
    return _WORD.findall(text.lower())


@lru_cache(maxsize=1 << 18)
def _expand(ident: str) -> tuple[str, ...]:
    parts = [p.lower() for piece in ident.split("_") for p in _SUBWORD.findall(piece)]
    parts = [p for p in parts if len(p) > 1 and p not in STOPWORDS]
    whole = ident.lower().strip("_")
    if len(parts) > 1 or not parts:
        # Keep the full identifier too: exact mentions in an issue are the strongest signal.
        return (whole, *parts) if whole and whole not in STOPWORDS else tuple(parts)
    return tuple(parts)


def code(text: str) -> list[str]:
    """Identifier-aware: split snake_case and camelCase, keep the whole name, drop noise."""
    return [t for ident in _IDENT.findall(text) for t in _expand(ident)]


def naive_counts(text: str) -> Counter[str]:
    return Counter(naive(text))


def code_counts(text: str) -> Counter[str]:
    out: Counter[str] = Counter()
    for ident, n in Counter(_IDENT.findall(text)).items():
        for t in _expand(ident):
            out[t] += n
    return out


TOKENIZERS: dict[str, Tokenizer] = {"naive": naive_counts, "code": code_counts}
