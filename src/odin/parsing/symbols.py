from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from functools import cache

from tree_sitter import Language, Node, Parser, Tree

from odin.parsing import python_symbols
from odin.parsing.python_symbols import CLASS, FUNCTION, METHOD, Symbol

PYTHON = "python"
JAVASCRIPT = "javascript"
TYPESCRIPT = "typescript"
TSX = "tsx"
GO = "go"
JAVA = "java"
RUST = "rust"

EXTENSIONS = {
    ".py": PYTHON,
    ".js": JAVASCRIPT,
    ".jsx": JAVASCRIPT,
    ".mjs": JAVASCRIPT,
    ".cjs": JAVASCRIPT,
    ".ts": TYPESCRIPT,
    ".mts": TYPESCRIPT,
    ".cts": TYPESCRIPT,
    ".tsx": TSX,
    ".go": GO,
    ".java": JAVA,
    ".rs": RUST,
}


SAMPLE_PATH = {
    PYTHON: "",
    JAVASCRIPT: "_.js",
    TYPESCRIPT: "_.ts",
    TSX: "_.tsx",
    GO: "_.go",
    JAVA: "_.java",
    RUST: "_.rs",
}

_TEST_DIRS = frozenset({"__tests__", "__mocks__", "e2e", "cypress", "testdata", "test-utils"})


def is_test_path(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1].lower()
    dirs = parts[:-1]
    if (
        name.startswith("test_")
        or name.endswith("_test.py")
        or name == "conftest.py"
        or any(p in ("tests", "test", "testing") for p in dirs)
    ):
        return True
    stem = name.rsplit(".", 1)[0]
    return (
        any(stem.endswith(s) for s in (".test", ".spec", ".tests", ".specs", "_test"))
        or any(p in _TEST_DIRS for p in dirs)
        or (
            name.endswith(".java")
            and (stem.endswith("test") or stem.endswith("tests") or stem.endswith("it"))
            and "src" in dirs
        )
    )


def language_of(path: str) -> str | None:
    dot = path.rfind(".")
    if dot < 0 or path.endswith(".d.ts") or path.endswith(".min.js"):
        return None
    return EXTENSIONS.get(path[dot:].lower())


@cache
def _grammar(lang: str) -> Language:
    if lang == JAVASCRIPT:
        import tree_sitter_javascript as m

        return Language(m.language())
    if lang in (TYPESCRIPT, TSX):
        import tree_sitter_typescript as m

        return Language(m.language_typescript() if lang == TYPESCRIPT else m.language_tsx())
    if lang == GO:
        import tree_sitter_go as m

        return Language(m.language())
    if lang == JAVA:
        import tree_sitter_java as m

        return Language(m.language())
    if lang == RUST:
        import tree_sitter_rust as m

        return Language(m.language())
    raise ValueError(f"no grammar for {lang}")


@cache
def _parser(lang: str) -> Parser:
    return Parser(_grammar(lang))


def parse(source: bytes, lang: str) -> Tree:
    if lang == PYTHON:
        return python_symbols.parse(source)
    return _parser(lang).parse(source)


@dataclass(frozen=True, slots=True)
class Found:
    name: str
    kind: str | None
    body: Node | None
    start: Node
    end: Node
    unit: bool = True


def _text(node: Node | None) -> str | None:
    return node.text.decode("utf-8", "replace") if node is not None else None


def _field(node: Node, name: str) -> Node | None:
    return node.child_by_field_name(name)


_JS_FUNCTION_VALUES = frozenset(
    {"arrow_function", "function_expression", "function", "generator_function"}
)
_JS_STATEMENTS = frozenset({"lexical_declaration", "variable_declaration", "export_statement"})


def _statement_start(node: Node) -> Node:
    top = node
    while top.parent is not None and top.parent.type in _JS_STATEMENTS:
        top = top.parent
    return top


def _js(node: Node, parent_kind: str | None) -> Found | None:
    t = node.type
    if t in ("function_declaration", "generator_function_declaration"):
        return Found(
            _text(_field(node, "name")) or "default",
            FUNCTION,
            _field(node, "body"),
            _statement_start(node),
            node,
        )
    if t in ("class_declaration", "abstract_class_declaration", "class"):
        name = _text(_field(node, "name"))
        if name is None and t == "class":
            return None
        return Found(name or "default", CLASS, _field(node, "body"), _statement_start(node), node)
    if t in ("interface_declaration", "enum_declaration"):
        return Found(
            _text(_field(node, "name")) or "<anonymous>",
            CLASS,
            _field(node, "body"),
            _statement_start(node),
            node,
        )
    if t == "type_alias_declaration":
        return Found(
            _text(_field(node, "name")) or "<anonymous>", CLASS, None, _statement_start(node), node
        )
    if t == "method_definition":
        return Found(
            _text(_field(node, "name")) or "<anonymous>", FUNCTION, _field(node, "body"), node, node
        )
    if t in ("public_field_definition", "field_definition"):
        value = _field(node, "value")
        name = _field(node, "name") or _field(node, "property")
        if value is not None and value.type in _JS_FUNCTION_VALUES and name is not None:
            return Found(_text(name) or "<anonymous>", FUNCTION, _field(value, "body"), node, node)
        return None
    if t == "variable_declarator":
        name, value = _field(node, "name"), _field(node, "value")
        if name is None or name.type != "identifier" or value is None:
            return None
        if value.type in _JS_FUNCTION_VALUES:
            return Found(
                _text(name) or "<anonymous>",
                FUNCTION,
                _field(value, "body"),
                _statement_start(node),
                node,
            )
        if value.type == "object":
            return Found(_text(name) or "<anonymous>", None, value, node, node, unit=False)
        return None
    if t == "assignment_expression":
        left, right = _field(node, "left"), _field(node, "right")
        if (
            left is None
            or right is None
            or left.type != "member_expression"
            or right.type not in _JS_FUNCTION_VALUES
        ):
            return None
        qual = (_text(left) or "").replace(".prototype.", ".")
        for prefix in ("module.exports.", "exports."):
            if qual.startswith(prefix):
                qual = qual[len(prefix) :]
        start = (
            node.parent
            if node.parent is not None and node.parent.type == "expression_statement"
            else node
        )
        return Found(qual, FUNCTION, _field(right, "body"), start, node)
    return None


def _go_receiver(node: Node) -> str:
    receiver = _field(node, "receiver")
    if receiver is None:
        return ""
    names = [n for n in _descendants(receiver) if n.type == "type_identifier"]
    return _text(names[0]) or "" if names else ""


def _descendants(node: Node):
    stack = [node]
    while stack:
        n = stack.pop()
        yield n
        stack.extend(reversed(n.named_children))


def _go(node: Node, parent_kind: str | None) -> Found | None:
    t = node.type
    if t == "function_declaration":
        return Found(
            _text(_field(node, "name")) or "<anonymous>", FUNCTION, _field(node, "body"), node, node
        )
    if t == "method_declaration":
        name = _text(_field(node, "name")) or "<anonymous>"
        receiver = _go_receiver(node)
        return Found(
            f"{receiver}.{name}" if receiver else name, METHOD, _field(node, "body"), node, node
        )
    if t in ("type_spec", "type_alias"):
        start = (
            node.parent
            if node.parent is not None
            and node.parent.type == "type_declaration"
            and node.parent.named_child_count == 1
            else node
        )
        return Found(_text(_field(node, "name")) or "<anonymous>", CLASS, None, start, node)
    return None


_JAVA_TYPES = frozenset(
    {
        "class_declaration",
        "interface_declaration",
        "enum_declaration",
        "record_declaration",
        "annotation_type_declaration",
    }
)
_JAVA_METHODS = frozenset(
    {"method_declaration", "constructor_declaration", "compact_constructor_declaration"}
)


def _java(node: Node, parent_kind: str | None) -> Found | None:
    t = node.type
    if t in _JAVA_TYPES:
        return Found(
            _text(_field(node, "name")) or "<anonymous>", CLASS, _field(node, "body"), node, node
        )
    if t in _JAVA_METHODS:
        return Found(
            _text(_field(node, "name")) or "<anonymous>", FUNCTION, _field(node, "body"), node, node
        )
    return None


def _rust_type_name(node: Node | None) -> str:
    if node is None:
        return "<anonymous>"
    if node.type in ("generic_type", "scoped_type_identifier"):
        inner = _field(node, "type") or _field(node, "name")
        return _rust_type_name(inner)
    if node.type in ("reference_type", "pointer_type"):
        return _rust_type_name(_field(node, "type"))
    return _text(node) or "<anonymous>"


def _rust_test_module(node: Node) -> bool:
    if _text(_field(node, "name")) in ("tests", "test"):
        return True
    prev = node.prev_named_sibling
    while prev is not None and prev.type == "attribute_item":
        if "cfg(test)" in "".join((_text(prev) or "").split()):
            return True
        prev = prev.prev_named_sibling
    return False


def _rust(node: Node, parent_kind: str | None) -> Found | None:
    t = node.type
    if t == "function_item":
        return Found(
            _text(_field(node, "name")) or "<anonymous>", FUNCTION, _field(node, "body"), node, node
        )
    if t in ("struct_item", "enum_item", "union_item"):
        return Found(_text(_field(node, "name")) or "<anonymous>", CLASS, None, node, node)
    if t == "trait_item":
        return Found(
            _text(_field(node, "name")) or "<anonymous>", CLASS, _field(node, "body"), node, node
        )
    if t == "impl_item":
        return Found(
            _rust_type_name(_field(node, "type")),
            CLASS,
            _field(node, "body"),
            node,
            node,
            unit=False,
        )
    if t == "mod_item" and _field(node, "body") is not None:
        return Found(
            _text(_field(node, "name")) or "<anonymous>",
            None,
            None if _rust_test_module(node) else _field(node, "body"),
            node,
            node,
            unit=False,
        )
    return None


_RULES: dict[str, Callable[[Node, str | None], Found | None]] = {
    JAVASCRIPT: _js,
    TYPESCRIPT: _js,
    TSX: _js,
    GO: _go,
    JAVA: _java,
    RUST: _rust,
}


def _walk(
    node: Node,
    rule,
    path: str,
    scope: tuple[str, ...],
    parent_kind: str | None,
    in_func: bool,
    out: list[Symbol],
) -> None:
    stack = [(iter(node.named_children), scope, parent_kind, in_func)]
    while stack:
        children, scope, parent_kind, in_func = stack[-1]
        child = next(children, None)
        if child is None:
            stack.pop()
            continue
        found = rule(child, parent_kind)
        if found is None:
            stack.append((iter(child.named_children), scope, parent_kind, in_func))
            continue
        qual = (*scope, found.name)
        if not found.unit:
            if found.body is not None:
                stack.append((iter(found.body.named_children), qual, found.kind, in_func))
            continue
        kind = found.kind
        if kind == FUNCTION and parent_kind == CLASS:
            kind = METHOD
        out.append(
            Symbol(
                path=path,
                qualname=".".join(qual),
                kind=kind,
                start_line=found.start.start_point[0] + 1,
                end_line=found.end.end_point[0] + 1,
                col=found.start.start_point[1],
                nested=in_func,
            )
        )
        if found.body is not None:
            stack.append((iter(found.body.named_children), qual, kind, in_func or kind != CLASS))


def extract_symbols(source: bytes, path: str, tree: Tree | None = None) -> list[Symbol]:
    lang = language_of(path)
    if lang is None:
        return []
    if lang == PYTHON:
        return python_symbols.extract_symbols(source, path, tree)
    tree = tree or parse(source, lang)
    out: list[Symbol] = []
    _walk(tree.root_node, _RULES[lang], path, (), None, False, out)
    out.sort(key=lambda s: (s.start_line, -s.end_line))
    return out
