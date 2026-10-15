import { describe, expect, it } from "vitest";
import { LanguageCensus } from "../src/engine/languages.ts";

const census = (paths: string[]) => {
  const c = new LanguageCensus();
  paths.forEach((p) => c.add(p));
  return c;
};

describe("language census", () => {
  it("warns when most of the code is not Python, naming the languages", () => {
    const c = census(["src/app.tsx", "src/theme.ts", "src/button.tsx", "src/util.js", "scripts/build.py"]);
    expect(c.note()).toBe(
      "Most of this repository is TypeScript (3 files), JavaScript (1 file). Odin reads Python only for now, so it searched just the 1 Python file; code in other languages isn't in these results.",
    );
  });

  it("says nothing when Python is the main language", () => {
    expect(census(["a.py", "b.py", "web/app.js"]).note()).toBeNull();
    expect(census(["a.py", "b.pyi"]).note()).toBeNull();
  });

  it("ignores dependencies, build output, minified files and type declarations", () => {
    const c = census(["pkg/a.py", "node_modules/x/index.js", "dist/app.js", "static/vendor/jquery.js", "web/app.min.js", "types/index.d.ts"]);
    expect(c.note()).toBeNull();
    expect(c.others()).toEqual([]);
  });

  it("explains a repository with no Python at all", () => {
    expect(census(["main.go", "util.go", "README.md"]).noPython()).toBe("No Python files found: this repository is Go (2 files). Odin reads Python only for now.");
    expect(census(["README.md"]).noPython()).toBe("No Python files found. Odin searches Python code only for now.");
  });
});

describe("file selection reports the languages it leaves out", async () => {
  const { selectFiles } = await import("../src/engine/repo.ts");
  const listing = (paths: string[]) => ({ scope: null, files: paths.map((path) => ({ path, size: 100 })) });

  it("adds a note when Python is a small part of the repository", () => {
    const notes: string[] = [];
    const kept = selectFiles(listing(["web/src/ThemeToggle.tsx", "web/src/App.tsx", "web/src/main.ts", "server/app.py"]), false, notes);
    expect(kept.map((f) => f.path)).toEqual(["server/app.py"]);
    expect(notes).toEqual([expect.stringContaining("Most of this repository is TypeScript (3 files)")]);
  });

  it("names the repository's languages when there is no Python to search", () => {
    expect(() => selectFiles(listing(["cmd/main.go", "pkg/theme.go"]), false, [])).toThrow("this repository is Go (2 files)");
  });
});

describe("loading a repository in several languages", async () => {
  const { fileURLToPath } = await import("node:url");
  const { createParser } = await import("../src/engine/chunk.ts");
  const { inlineParsing, loadRepo, PYTHON_ONLY } = await import("../src/engine/repo.ts");
  const { vi } = await import("vitest");
  const runtime = fileURLToPath(new URL("../node_modules/web-tree-sitter/tree-sitter.wasm", import.meta.url));
  const grammar = (lang: string) => fileURLToPath(new URL(`../src/assets/tree-sitter-${lang}.wasm`, import.meta.url));
  const parsers = new Map<string, ReturnType<typeof createParser>>();
  const parserFor = (lang: string) => {
    if (!parsers.has(lang)) parsers.set(lang, createParser(runtime, grammar(lang)));
    return parsers.get(lang)!;
  };
  const entry = (name: string, body: string, type = "0") => {
    const data = new TextEncoder().encode(body);
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(new TextEncoder().encode(s), at);
    put(name, 0);
    put(data.length.toString(8).padStart(11, "0"), 124);
    put(type, 156);
    put("ustar\u000000", 257);
    const out = new Uint8Array(512 + Math.ceil(data.length / 512) * 512);
    out.set(h);
    out.set(data, 512);
    return out;
  };
  const archive = () => {
    const parts = [
      entry("pax_global_header", "52 comment=d086db856be187255b8ec61ef409357393020f32\n", "g"),
      entry("repo-abc/web/src/ThemeToggle.tsx", "export const ThemeToggle = () => {\n  return <button onClick={toggleTheme} />;\n};\nfunction toggleTheme() {}\n"),
      entry("repo-abc/web/src/store.ts", 'export class Store {\n  mode = "light";\n  setTheme(mode: string) {\n    this.mode = mode;\n  }\n}\n'),
      entry("repo-abc/web/src/ThemeToggle.test.tsx", "test('toggles', () => {});\n"),
      entry("repo-abc/web/dist/bundle.js", "function minified(){}\n"),
      entry("repo-abc/server/app.py", "def theme():\n    return 'dark'\n"),
    ];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + 1024);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    return new Blob([all]).stream().pipeThrough(new CompressionStream("gzip"));
  };
  const relay = (owner: string, name: string, ref: string) => `https://relay.test/${owner}/${name}/${ref}`;

  it("indexes every enabled language, leaving tests and build output out", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(archive())));
    const languages = new Set(["python", "typescript", "tsx", "javascript"] as const);
    const loaded = await loadRepo(inlineParsing(parserFor as never), "o/r", { archive: relay, languages: languages as never });
    expect(loaded.units.map((u) => u.id).sort()).toEqual([
      "server/app.py::theme", "web/src/ThemeToggle.tsx::ThemeToggle", "web/src/ThemeToggle.tsx::toggleTheme", "web/src/store.ts::Store", "web/src/store.ts::Store.setTheme",
    ]);
    expect(loaded.notes).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("stays Python-only, as before, unless asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(archive())));
    const loaded = await loadRepo(inlineParsing(parserFor as never), "o/r", { archive: relay, languages: PYTHON_ONLY });
    expect(loaded.units.map((u) => u.id)).toEqual(["server/app.py::theme"]);
    expect(loaded.notes).toEqual([expect.stringContaining("Most of this repository is TypeScript")]);
    vi.unstubAllGlobals();
  });
});
