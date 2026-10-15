import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from odin.index.chunker import MODULE, chunk_file
from odin.parsing.symbols import is_test_path, language_of

ROOT = Path(__file__).resolve().parent.parent
NODE = os.environ.get("ODIN_NODE") or shutil.which("node")
if NODE and not (ROOT / "web/node_modules/web-tree-sitter").exists():
    NODE = None

SAMPLES = {
    "ThemeToggle.tsx": """import React, { useState } from "react";
export const ThemeToggle = ({ theme }: Props) => {
  const next = () => (theme === "dark" ? "light" : "dark");
  return <button onClick={() => setTheme(next())}>{theme}</button>;
};
export default function App() {
  const [t, setT] = useState("light");
  return <ThemeToggle theme={t} />;
}
export class Store<T> {
  private items: T[] = [];
  handle = (e: Event) => { this.items = []; };
  add(item: T): void { this.items.push(item); }
}
interface Props { theme: string }
type Mode = "a" | "b";
enum Color { Red, Green }
export const api = { get() { return 1; }, put: () => 2 };
""",
    "server.js": """'use strict';
function createServer(opts) {
  const handler = function (req, res) { res.end(); };
  return handler;
}
const listen = async (port) => {};
module.exports.close = function () {};
Server.prototype.route = function (path) {};
class Router extends Base {
  constructor() { super(); }
  get size() { return 0; }
  static of() {}
}
""",
    "server.go": """package server

import "net/http"

type Server struct {
\taddr string
}

type (
\tHandler interface{ Serve() }
\tID      int
)

func (s *Server) Start(port int) error {
\tgo func() {}()
\treturn nil
}

func New[T any](v T) *Server { return &Server{} }
""",
    "Outer.java": """package x;

public class Outer<T> {
  private int n;
  public Outer() {}
  @Override
  public String toString() { return "x"; }
  static class Inner { int go() { return 1; } }
  enum Mode { A, B; void flip() {} }
}
interface Shape { double area(); default double twice() { return 2 * area(); } }
record Point(int x, int y) { Point { } int sum() { return x + y; } }
""",
    "lib.rs": """use std::fmt;

pub struct Theme { dark: bool }
pub enum Mode { Light, Dark }
pub trait Toggle {
    fn toggle(&mut self);
    fn default_on() -> bool { true }
}
impl Toggle for Theme {
    fn toggle(&mut self) { self.dark = !self.dark; }
}
impl<T: fmt::Debug> Wrapper<T> {
    pub fn new() -> Self { todo!() }
}
impl fmt::Display for &Theme {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result { Ok(()) }
}
mod inner { pub fn helper() {} }
fn main() { let c = |x: i32| x + 1; }
""",
}


def python_units(path: Path) -> list[dict]:
    return [
        {"qualname": c.qualname, "kind": c.kind, "line": c.start_line, "text": c.text}
        for c in chunk_file(path.read_bytes(), str(path))
        if c.kind != MODULE
    ]


def node_units(files: list[Path]) -> dict:
    out = subprocess.run(
        [NODE, str(ROOT / "tests/js/chunk_files.mjs")],
        input="\n".join(map(str, files)),
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    ).stdout
    return json.loads(out)


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_every_language_chunks_the_same_in_the_browser(tmp_path):
    samples = []
    for name, text in SAMPLES.items():
        path = tmp_path / name
        path.write_bytes(text.encode())
        samples.append(path)
    real = [
        p
        for p in sorted((ROOT / "web/src").rglob("*"))
        if p.is_file() and language_of(p.name) in ("typescript", "tsx")
    ]
    real += sorted((ROOT / "proxy").glob("*.js")) + sorted((ROOT / "web/e2e").glob("*.ts"))
    files = samples + real
    js = node_units(files)
    covered = {}
    for path in files:
        assert js[str(path)] == python_units(path), path
        covered[language_of(path.name)] = covered.get(language_of(path.name), 0) + len(
            js[str(path)]
        )
    assert set(covered) == {"tsx", "javascript", "go", "java", "rust", "typescript"}
    assert covered["typescript"] + covered["tsx"] > 300


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_test_file_rules_match_in_the_browser():
    paths = [
        "src/button.test.tsx",
        "src/__tests__/theme.ts",
        "lib/parse.spec.js",
        "tests/unit/color.tests.ts",
        "pkg/server_test.go",
        "src/test/java/x/OuterTest.java",
        "tests/cli.rs",
        "e2e/login.ts",
        "test_app.py",
        "src/button.tsx",
        "lib/testing-library.js",
        "pkg/server.go",
        "src/main/java/x/Outer.java",
        "src/latest.rs",
        "src/contest.ts",
        "Test_Upper.py",
        "src/IT.java",
    ]
    script = (
        "const { isTestPathAny } = await import(process.argv[1]);"
        "const paths = JSON.parse(require('fs').readFileSync(0, 'utf8'));"
        "process.stdout.write(JSON.stringify(paths.map(isTestPathAny)));"
    )
    rules = (ROOT / "web/src/engine/languages-rules.ts").as_uri()
    out = subprocess.run(
        [NODE, "--input-type=commonjs", "-e", f"(async () => {{ {script} }})()", rules],
        input=json.dumps(paths),
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    assert json.loads(out) == [is_test_path(p) for p in paths]
