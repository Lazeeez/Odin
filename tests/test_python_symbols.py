from odin.parsing.python_symbols import (
    CLASS,
    FUNCTION,
    METHOD,
    extract_symbols,
    innermost,
    retrieval_unit,
)

SOURCE = b"""import os


def top(a):
    def helper(x):
        return x
    return helper(a)


@decorator
class Widget(Base):
    size = 1

    @property
    def area(self):
        return self.size ** 2

    class Inner:
        def deep(self):
            pass


if os.name == "nt":
    def windows_only():
        pass
"""


def by_name():
    return {s.qualname: s for s in extract_symbols(SOURCE, "pkg/mod.py")}


def test_qualnames_and_kinds():
    syms = by_name()
    assert syms["top"].kind == FUNCTION
    assert syms["top.helper"].kind == FUNCTION
    assert syms["Widget"].kind == CLASS
    assert syms["Widget.area"].kind == METHOD
    assert syms["Widget.Inner.deep"].kind == METHOD
    assert syms["windows_only"].kind == FUNCTION


def test_decorators_are_part_of_span():
    syms = by_name()
    assert syms["Widget"].start_line == 10
    assert syms["Widget.area"].start_line == 14
    assert syms["Widget.area"].end_line == 16


def test_nested_flag():
    syms = by_name()
    assert syms["top.helper"].nested
    assert not syms["top"].nested
    assert not syms["Widget.Inner.deep"].nested


def test_innermost_and_retrieval_unit():
    symbols = extract_symbols(SOURCE, "pkg/mod.py")
    s = innermost(symbols, 6)
    assert s.qualname == "top.helper"
    assert retrieval_unit(symbols, s).qualname == "top"
    assert innermost(symbols, 12).qualname == "Widget"
    assert innermost(symbols, 1) is None


def test_ids_are_path_qualified():
    assert by_name()["Widget.area"].id == "pkg/mod.py::Widget.area"


def test_survives_syntax_errors():
    symbols = extract_symbols(b"def ok():\n    pass\n\ndef broken(:\n", "x.py")
    assert "ok" in {s.qualname for s in symbols}
