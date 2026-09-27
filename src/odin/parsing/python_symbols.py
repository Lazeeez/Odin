from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import tree_sitter_python
from tree_sitter import Language, Node, Parser, Query, QueryCursor, Tree

FUNCTION = "function"
METHOD = "method"
CLASS = "class"

_DEFS = frozenset({"function_definition", "class_definition"})
_CONTAINERS = frozenset(
    {
        "module",
        "block",
        "if_statement",
        "elif_clause",
        "else_clause",
        "for_statement",
        "while_statement",
        "try_statement",
        "except_clause",
        "except_group_clause",
        "finally_clause",
        "with_statement",
        "match_statement",
        "case_clause",
    }
)


@dataclass(frozen=True, slots=True)
class Symbol:
    path: str
    qualname: str
    kind: str
    start_line: int
    end_line: int
    col: int = 0
    nested: bool = False

    @property
    def id(self) -> str:
        return f"{self.path}::{self.qualname}"

    @property
    def span(self) -> int:
        return self.end_line - self.start_line

    def contains(self, line: int) -> bool:
        return self.start_line <= line <= self.end_line


@lru_cache(maxsize=1)
def _language() -> Language:
    return Language(tree_sitter_python.language())


@lru_cache(maxsize=1)
def _parser() -> Parser:
    return Parser(_language())


@lru_cache(maxsize=1)
def _call_query() -> Query:
    # f(...) -> f, obj.attr.m(...) -> m. Only the final name is resolvable without types.
    return Query(
        _language(),
        "(call function: [(identifier) @callee (attribute attribute: (identifier) @callee)])",
    )


def parse(source: bytes) -> Tree:
    return _parser().parse(source)


def call_sites(tree: Tree) -> list[tuple[str, int]]:
    """Every call in the file as (callee name, 1-based line). Runs as one C-side query."""
    nodes = QueryCursor(_call_query()).captures(tree.root_node).get("callee", [])
    return [(n.text.decode("utf-8", "replace"), n.start_point[0] + 1) for n in nodes]


def _name(node: Node) -> str:
    ident = node.child_by_field_name("name")
    return ident.text.decode("utf-8", "replace") if ident is not None else "<anonymous>"


def _kind(node: Node, parent_kind: str | None) -> str:
    if node.type == "class_definition":
        return CLASS
    return METHOD if parent_kind == CLASS else FUNCTION


def extract_symbols(source: bytes, path: str, tree: Tree | None = None) -> list[Symbol]:
    tree = tree or parse(source)
    out: list[Symbol] = []
    stack: list[tuple[Node, tuple[str, ...], str | None, bool]] = [
        (tree.root_node, (), None, False)
    ]
    while stack:
        node, scope, parent_kind, in_func = stack.pop()
        for child in node.children:
            target = child
            if child.type == "decorated_definition":
                target = child.child_by_field_name("definition")
                if target is None:
                    continue
            if target.type in _DEFS:
                qual = (*scope, _name(target))
                kind = _kind(target, parent_kind)
                out.append(
                    Symbol(
                        path=path,
                        qualname=".".join(qual),
                        kind=kind,
                        start_line=child.start_point[0] + 1,
                        end_line=target.end_point[0] + 1,
                        col=child.start_point[1],
                        nested=in_func,
                    )
                )
                body = target.child_by_field_name("body")
                if body is not None:
                    stack.append((body, qual, kind, in_func or kind != CLASS))
            elif child.type in _CONTAINERS:
                stack.append((child, scope, parent_kind, in_func))
    out.sort(key=lambda s: (s.start_line, -s.end_line))
    return out


def innermost(
    symbols: list[Symbol], line: int, kinds: frozenset[str] | None = None
) -> Symbol | None:
    best: Symbol | None = None
    for s in symbols:
        if kinds is not None and s.kind not in kinds:
            continue
        if s.contains(line) and (best is None or s.span < best.span):
            best = s
    return best


def retrieval_unit(symbols: list[Symbol], sym: Symbol) -> Symbol:
    if not sym.nested:
        return sym
    best = sym
    for s in symbols:
        if s.nested or s.kind == CLASS:
            continue
        encloses = s.start_line <= sym.start_line and sym.end_line <= s.end_line
        if encloses and (best is sym or s.span < best.span):
            best = s
    return best
