from odin.parsing.symbols import extract_symbols, language_of


def units(source: str, path: str) -> list[tuple[str, str, int, int, bool]]:
    return [
        (s.qualname, s.kind, s.start_line, s.end_line, s.nested)
        for s in extract_symbols(source.encode(), path)
    ]


def names(source: str, path: str) -> list[str]:
    return [s.qualname for s in extract_symbols(source.encode(), path) if not s.nested]


def test_languages_by_extension():
    assert language_of("src/App.tsx") == "tsx"
    assert language_of("lib/index.mjs") == "javascript"
    assert language_of("types/index.d.ts") is None
    assert language_of("vendor/jquery.min.js") is None
    assert language_of("cmd/main.go") == "go"
    assert language_of("README.md") is None


def test_typescript_react_components_classes_and_types():
    src = """import React from "react";
export const ThemeToggle = ({ theme }: Props) => {
  const next = () => (theme === "dark" ? "light" : "dark");
  return <button onClick={() => setTheme(next())} />;
};
export default function App() {
  return null;
}
export class Store {
  private items = [];
  handle = () => {};
  add(item: Item): void {}
}
interface Props { theme: string }
type Mode = "a" | "b";
enum Color { Red }
export const api = { get() {} };
"""
    assert names(src, "src/ThemeToggle.tsx") == [
        "ThemeToggle",
        "App",
        "Store",
        "Store.handle",
        "Store.add",
        "Props",
        "Mode",
        "Color",
        "api.get",
    ]
    toggle = units(src, "src/ThemeToggle.tsx")
    assert toggle[0] == ("ThemeToggle", "function", 2, 5, False)
    assert ("ThemeToggle.next", "function", 3, 3, True) in toggle
    assert ("Store.add", "method", 12, 12, False) in toggle


def test_javascript_exports_and_prototypes():
    src = """function a() {}
const b = async () => {};
module.exports.c = function () {};
Widget.prototype.render = function () {};
class D extends E { constructor() { super(); } get v() { return 1; } }
"""
    assert names(src, "lib/index.js") == [
        "a",
        "b",
        "c",
        "Widget.render",
        "D",
        "D.constructor",
        "D.v",
    ]


def test_go_methods_are_named_by_receiver():
    src = """package main

type Server struct{ a int }

type Handler interface{ Serve() }

func (s *Server) Start(port int) error { return nil }

func (s Server) Stop() {}

func main() {
\tf := func() {}
\tf()
}
"""
    assert units(src, "cmd/server.go") == [
        ("Server", "class", 3, 3, False),
        ("Handler", "class", 5, 5, False),
        ("Server.Start", "method", 7, 7, False),
        ("Server.Stop", "method", 9, 9, False),
        ("main", "function", 11, 14, False),
    ]


def test_java_classes_methods_and_nested_types():
    src = """package x;
public class Outer {
  public Outer() {}
  void run() { Runnable r = () -> {}; }
  static class Inner { int go() { return 1; } }
}
interface Shape { double area(); }
record Point(int x, int y) { int sum() { return x + y; } }
"""
    assert names(src, "src/main/java/x/Outer.java") == [
        "Outer",
        "Outer.Outer",
        "Outer.run",
        "Outer.Inner",
        "Outer.Inner.go",
        "Shape",
        "Shape.area",
        "Point",
        "Point.sum",
    ]


def test_rust_impl_methods_traits_and_modules():
    src = """struct Theme { dark: bool }
trait Toggle { fn toggle(&mut self); fn default_on() -> bool { true } }
impl Toggle for Theme { fn toggle(&mut self) { self.dark = !self.dark; } }
impl<T> Wrapper<T> { pub fn new() -> Self { todo!() } }
fn main() { let c = |x: i32| x + 1; }
mod inner { pub fn helper() {} }
"""
    assert names(src, "src/lib.rs") == [
        "Theme",
        "Toggle",
        "Toggle.default_on",
        "Theme.toggle",
        "Wrapper.new",
        "main",
        "inner.helper",
    ]
    kinds = {q: k for q, k, *_ in units(src, "src/lib.rs")}
    assert (
        kinds["Theme.toggle"] == "method"
        and kinds["main"] == "function"
        and kinds["Toggle"] == "class"
    )


def test_python_is_unchanged():
    from odin.parsing import python_symbols

    src = b"class A:\n    def f(self):\n        def g():\n            pass\n"
    assert extract_symbols(src, "a.py") == python_symbols.extract_symbols(src, "a.py")


def test_test_files_in_every_language():
    from odin.parsing.symbols import is_test_path

    tests = [
        "src/button.test.tsx",
        "src/__tests__/theme.ts",
        "lib/parse.spec.js",
        "tests/unit/color.tests.ts",
        "pkg/server_test.go",
        "src/test/java/x/OuterTest.java",
        "tests/cli.rs",
        "e2e/login.ts",
        "test_app.py",
    ]
    sources = [
        "src/button.tsx",
        "lib/testing-library.js",
        "pkg/server.go",
        "src/main/java/x/Outer.java",
        "src/latest.rs",
        "src/contest.ts",
    ]
    assert all(is_test_path(p) for p in tests), [p for p in tests if not is_test_path(p)]
    assert not any(is_test_path(p) for p in sources), [p for p in sources if is_test_path(p)]
