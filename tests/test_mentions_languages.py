from odin.rank.mentions import Mentions, module_name, path_matches

NODE_TRACE = """The theme toggle crashes:
TypeError: Cannot read properties of undefined (reading 'mode')
    at ThemeToggle (webpack-internal:///./src/components/ThemeToggle.tsx:12:31)
    at renderWithHooks (/app/node_modules/react-dom/cjs/react-dom.development.js:16305:18)
    at Object.<anonymous> (/app/src/index.js:5:1)
"""

FIREFOX_TRACE = """toggle@http://localhost:3000/src/theme.js:4:11
@http://localhost:3000/src/main.js:9:3
"""

JAVA_TRACE = """Exception in thread "main" java.lang.NullPointerException
\tat com.example.theme.ThemeManager.toggle(ThemeManager.java:42)
\tat com.example.App.main(App.java:10)
"""

GO_TRACE = """panic: runtime error: invalid memory address or nil pointer dereference
goroutine 1 [running]:
github.com/acme/web/server.(*Server).Start(0x0, 0x1f90)
\t/home/u/web/server/server.go:42 +0x1d
main.main()
\t/home/u/web/main.go:9 +0x25
"""

RUST_TRACE = """thread 'main' panicked at src/theme.rs:17:9:
called `Option::unwrap()` on a `None` value
stack backtrace:
   0: theme::Theme::toggle
             at ./src/theme.rs:17:9
   1: app::main
             at ./src/main.rs:4:5
"""


def test_off_by_default_so_python_features_do_not_change():
    m = Mentions.parse(NODE_TRACE + JAVA_TRACE)
    assert m.frame_paths == () and m.last_frame is None
    assert m.py_paths == ()


def test_node_frames_innermost_last():
    m = Mentions.parse(NODE_TRACE, multilang=True)
    assert m.frame_paths == (
        "/app/src/index.js",
        "/app/node_modules/react-dom/cjs/react-dom.development.js",
        "src/components/ThemeToggle.tsx",
    )
    assert m.last_frame == ("src/components/ThemeToggle.tsx", "ThemeToggle")
    assert "renderWithHooks" in m.frame_names and "" not in m.frame_names


def test_firefox_frames():
    m = Mentions.parse(FIREFOX_TRACE, multilang=True)
    assert m.last_frame == ("http://localhost:3000/src/theme.js", "toggle")


def test_java_frames_carry_their_package_path():
    m = Mentions.parse(JAVA_TRACE, multilang=True)
    assert m.last_frame == ("com/example/theme/ThemeManager.java", "toggle")
    assert path_matches(
        "com/example/theme/ThemeManager.java",
        "src/main/java/com/example/theme/ThemeManager.java",
        multilang=True,
    )
    assert not path_matches(
        "com/example/theme/ThemeManager.java", "src/main/java/com/example/theme/ThemeManager.java"
    )
    assert not path_matches(
        "ThemeManager.java", "src/main/java/com/example/theme/ThemeManager.java", multilang=True
    )


def test_go_frames():
    m = Mentions.parse(GO_TRACE, multilang=True)
    assert m.last_frame == ("/home/u/web/server/server.go", "Start")
    assert path_matches("/home/u/web/server/server.go", "server/server.go", multilang=True)


def test_rust_frames_and_panic_location():
    m = Mentions.parse(RUST_TRACE, multilang=True)
    assert m.frame_paths == ("src/main.rs", "src/theme.rs")
    assert m.last_frame == ("src/theme.rs", "toggle")
    panic_only = Mentions.parse("thread 'main' panicked at src/theme.rs:17:9:", multilang=True)
    assert panic_only.last_frame == ("src/theme.rs", "")


def test_source_paths_in_any_language():
    m = Mentions.parse(
        "See src/theme/toggle.ts and pkg/server.go, not package.json", multilang=True
    )
    assert m.py_paths == ("src/theme/toggle.ts", "pkg/server.go")


def test_module_names_for_other_languages():
    assert module_name("src/main/java/com/example/App.java", multilang=True) == "com.example.App"
    assert module_name("src/components/index.ts", multilang=True) == "components"
    assert module_name("pkg/server/server.go", multilang=True) == "pkg.server.server"
    assert (
        module_name("django/db/__init__.py", multilang=True)
        == module_name("django/db/__init__.py")
        == "django.db"
    )


def test_the_browser_parses_the_same():
    import json
    import os
    import shutil
    import subprocess
    from pathlib import Path

    import pytest

    root = Path(__file__).resolve().parent.parent
    node = os.environ.get("ODIN_NODE") or shutil.which("node")
    if not node or not (root / "web/node_modules/web-tree-sitter").exists():
        pytest.skip("needs Node 24 and `npm ci` in web/")
    texts = [NODE_TRACE, FIREFOX_TRACE, JAVA_TRACE, GO_TRACE, RUST_TRACE, NODE_TRACE + JAVA_TRACE + GO_TRACE,
             "See src/theme/toggle.ts and pkg/server.go, not package.json",
             'File "/x/django/db/models/query.py", line 3, in filter\n    at Foo.bar (src/a.ts:1:2)']  # fmt: skip
    paths = [
        "src/main/java/com/example/App.java",
        "src/components/index.ts",
        "pkg/server/server.go",
        "django/db/__init__.py",
        "lib/a.rs",
    ]
    pairs = [("com/example/App.java", "src/main/java/com/example/App.java"), ("App.java", "src/main/java/com/example/App.java"),
             ("/home/u/web/server/server.go", "server/server.go"), ("src/a.ts", "src/a.ts")]  # fmt: skip
    out = subprocess.run(
        [node, str(root / "tests/js/mentions_multi.mjs")],
        input=json.dumps({"texts": texts, "paths": paths, "pairs": pairs}),
        capture_output=True, check=True, text=True, encoding="utf-8",
    ).stdout  # fmt: skip
    js = json.loads(out)
    for text, got in zip(texts, js["mentions"], strict=True):
        m = Mentions.parse(text, multilang=True)
        assert got["framePaths"] == list(m.frame_paths), text[:40]
        assert got["frameNames"] == sorted(m.frame_names), text[:40]
        assert got["pyPaths"] == list(m.py_paths), text[:40]
        assert (tuple(got["lastFrame"]) if got["lastFrame"] else None) == m.last_frame, text[:40]
    assert js["modules"] == [module_name(p, multilang=True) for p in paths]
    assert js["matches"] == [path_matches(a, b, multilang=True) for a, b in pairs]
