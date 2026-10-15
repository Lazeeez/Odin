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
