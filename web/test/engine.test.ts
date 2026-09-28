import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BM25 } from "../src/engine/bm25.ts";
import { chunkFile, createParser } from "../src/engine/chunk.ts";
import { isTestPath, parseRepo } from "../src/engine/github.ts";
import { listFiles, refCandidates, selectFiles } from "../src/engine/repo.ts";
import { predict, type RankerModel, rankStage1, rankStage2, type Tree } from "../src/engine/rank.ts";
import { expand, tokenize } from "../src/engine/tokenize.ts";
import type { Unit } from "../src/engine/types.ts";
import { highlightPython, matchedTerms } from "../src/lib/highlight.ts";

const unit = (path: string, qualname: string, text: string): Unit =>
  ({ path, qualname, kind: "function", line: 1, text, id: `${path}::${qualname}` });

describe("tokenizer (mirrors tests/test_search.py)", () => {
  it("splits snake_case and camelCase and keeps the whole identifier", () => {
    const toks = tokenize("self.get_queryset(); HTTPServerError x.parseJSON2");
    expect(toks).toEqual(expect.arrayContaining(["get_queryset", "get", "queryset", "httpservererror", "http", "server", "error", "parse", "json"]));
    expect(toks).not.toContain("self");
  });
  it("drops stopwords and single letters", () => {
    expect(expand("self")).toEqual([]);
    expect(expand("x")).toEqual(["x"]);
    expect(expand("__init__")).toEqual(["init"]);
  });
});

describe("BM25", () => {
  const units = [
    unit("a.py", "render_template", "def render_template(name):\n    return escape_html(name)"),
    unit("b.py", "login", "def login(user, password):\n    return verify_password(password)"),
    unit("c.py", "noise", "def noise():\n    return 1"),
  ];
  it("ranks the unit that shares rare terms first and drops non-matches", () => {
    const { hits, terms } = new BM25(units).search("templates are not HTML escaped", 10);
    expect(hits[0].unit.qualname).toBe("render_template");
    expect(hits.map((h) => h.unit.qualname)).not.toContain("noise");
    expect(terms).toContain("html");
  });
  it("uses path words", () => {
    const idx = new BM25([unit("auth/session.py", "f", "pass"), unit("x.py", "g", "pass")]);
    expect(idx.search("session", 1).hits[0].unit.path).toBe("auth/session.py");
  });
});

describe("learned ranker", () => {
  const FEATURES = ["bm25_rel", "frame_both", "name_in_code"];
  // Hand-written trees in the exported format: node 0 splits, ~0 / ~1 are leaves.
  const split = (f: number, t: number, lo: number, hi: number) => ({ f: [f], t: [t], l: [~0], r: [~1], v: [lo, hi] });
  const model = (trees: Tree[], stage2?: Tree[]): RankerModel => ({
    meta: { pool: { bm25: 100, title: 20, code: 20, files: 5 }, depth: 50 },
    stage1: { features: FEATURES, trees },
    ...(stage2 && { stage2: { features: [...FEATURES, "s1_logrank", "dense_gap", "dense_logrank", "title_dense_gap", "title_dense_logrank"], trees: stage2 } }),
  });
  const units = [
    unit("pkg/views.py", "render", "def render(request):\n    return template(request)"),
    unit("pkg/db.py", "connect", "def connect(url):\n    return pool(url)"),
    unit("pkg/cache.py", "evict", "def evict(key):\n    return store.pop(key)"),
  ];
  const index = new BM25(units);

  it("evaluates trees like LightGBM (x <= threshold goes left)", () => {
    const m = model([split(0, 0.5, -1, 1), { v: [0.25] }]);
    expect(predict(m.stage1, [0.5, 0, 0])).toBe(-0.75);
    expect(predict(m.stage1, [0.6, 0, 0])).toBe(1.25);
  });

  it("ranks the function a traceback names above a keyword match", () => {
    const issue = 'render is slow\n\nTraceback (most recent call last):\n  File "/srv/app/pkg/cache.py", line 2, in evict\nKeyError';
    const { candidates } = rankStage1(index, model([split(1, 0.5, 0, 10)]), issue);
    expect(candidates[0].unit.qualname).toBe("evict"); // no word overlap, but it is in the traceback
    expect(candidates[0].reasons).toContain("where the traceback ends");
    expect(candidates.map((c) => c.unit.qualname)).toContain("render");
  });

  it("stage 2 reorders the top candidates by embedding similarity", async () => {
    const m = model([split(0, 0.5, 0, 1)], [split(FEATURES.length + 1, -0.5, 0, 10)]); // dense_gap
    const ranked = rankStage1(index, m, "render connect evict");
    // Toy embedder: similar to the issue only when the text mentions "pool".
    const embed = async (texts: string[]) => texts.map((t) => Float32Array.from(t.includes("pool") || t.startsWith("render connect") ? [1, 0] : [0, 1]));
    const out = await rankStage2(m, "render connect evict", ranked, embed, (u) => `${u.qualname}\n${u.text}`);
    expect(out[0].unit.qualname).toBe("connect");
    expect(out[0].semantic).toBeCloseTo(1);
  });
});

describe("chunker (WebAssembly Tree-sitter under Node)", async () => {
  const runtime = fileURLToPath(new URL("../node_modules/web-tree-sitter/tree-sitter.wasm", import.meta.url));
  const grammar = fileURLToPath(new URL("../src/assets/tree-sitter-python.wasm", import.meta.url));
  const parser = await createParser(runtime, grammar);
  it("splits classes, methods and functions like the Python chunker", () => {
    const src = "import os\n\n@deco\nclass Box:\n    size = 1\n\n    def put(self, x):\n        def inner():\n            pass\n        return x\n\n\ndef top():\n    return 1\n";
    const chunks = chunkFile(parser, src);
    expect(chunks.map((c) => [c.qualname, c.kind, c.line])).toEqual([["Box", "class", 3], ["Box.put", "method", 7], ["top", "function", 13]]);
    expect(chunks[0].text).not.toContain("def put");
    expect(chunks[1].text).toContain("def inner");
  });
});

describe("highlighting", () => {
  it("escapes repository code so it can never inject markup", () => {
    const html = highlightPython('x = "<img src=x onerror=alert(1)>"  # <script>', new Set());
    expect(html).not.toMatch(/<img|<script/);
    expect(html).toContain("&lt;img");
  });
  it("colours keywords and definitions and marks query terms", () => {
    const html = highlightPython("def rebuild_auth(self):\n    return 1", new Set(["auth"]));
    expect(html).toContain('<span class="tk-kw">def</span>');
    expect(html).toContain('<span class="tk-def"><mark>rebuild_auth</mark></span>');
  });
  it("counts matched query terms", () => {
    expect(matchedTerms("proxy proxy_auth header", ["proxy", "header", "missing"])).toEqual([["proxy", 2], ["header", 1]]);
  });
});

describe("repository input", () => {
  it("accepts owner/name, URLs, .git suffixes, branches", () => {
    expect(parseRepo("psf/requests")).toEqual({ owner: "psf", name: "requests", ref: null });
    expect(parseRepo("https://github.com/pallets/flask.git")).toEqual({ owner: "pallets", name: "flask", ref: null });
    expect(parseRepo("github.com/django/django/tree/stable/5.0.x").ref).toBe("stable/5.0.x");
    expect(() => parseRepo("not a repo")).toThrow();
  });
  it("recognises test files", () => {
    expect(["tests/test_x.py", "pkg/conftest.py", "a_test.py", "src/testing/util.py"].every(isTestPath)).toBe(true);
    expect(isTestPath("src/contest.py")).toBe(false);
  });
});

describe("listing a repository when GitHub's API fails", () => {
  const repo = { owner: "o", name: "r", ref: null };
  const mirror = { files: [{ name: "/pkg/a.py", size: 10 }] };
  const respond = (routes: Record<string, () => Response>) =>
    vi.fn(async (url: string) => {
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (!key) throw new TypeError("Failed to fetch");
      return routes[key]();
    });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the tree API once, at HEAD, when it works", async () => {
    const fetch = respond({ "api.github.com": () => Response.json({ sha: "t1", truncated: false, tree: [{ type: "blob", path: "a.py", size: 3 }] }) });
    vi.stubGlobal("fetch", fetch);
    const listing = await listFiles(repo);
    expect(listing).toMatchObject({ branch: "HEAD", sha: "t1", via: "GitHub API" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to jsDelivr when the API can't be reached at all", async () => {
    vi.stubGlobal("fetch", respond({ "@main": () => Response.json(mirror) })); // api.github.com throws
    const listing = await listFiles(repo);
    expect(listing).toMatchObject({ branch: "main", via: "jsDelivr" });
    expect(listing.files).toEqual([{ path: "pkg/a.py", size: 10 }]);
  });

  it("falls back to jsDelivr when rate-limited, trying master after main", async () => {
    vi.stubGlobal("fetch", respond({
      "api.github.com": () => new Response("", { status: 403 }),
      "@main": () => new Response("", { status: 404 }),
      "@master": () => Response.json(mirror),
    }));
    expect(await listFiles(repo)).toMatchObject({ branch: "master", via: "jsDelivr" });
  });

  it("explains what to do when both are unavailable", async () => {
    vi.stubGlobal("fetch", respond({}));
    await expect(listFiles(repo)).rejects.toThrow(/Couldn't reach api\.github\.com.*jsDelivr.*blocker/);
  });
});

describe("loading any repository", () => {
  it("accepts the ways people paste a repository", () => {
    const cases: [string, string, string | null][] = [
      ["git@github.com:psf/requests.git", "psf/requests", null],
      ["https://www.github.com/psf/requests/", "psf/requests", null],
      ["https://github.com/psf/requests/issues/6710", "psf/requests", null],
      ["https://github.com/psf/requests/pull/12#discussion_r1", "psf/requests", null],
      ["https://github.com/AtsushiSakai/PythonRobotics?tab=readme-ov-file", "AtsushiSakai/PythonRobotics", null],
      ["https://github.com/pallets/flask/tree/main/src/flask", "pallets/flask", "main/src/flask"],
      ["https://github.com/psf/requests/blob/main/src/requests/api.py#L12", "psf/requests", "main"],
      ["psf/requests@v2.31.0", "psf/requests", "v2.31.0"],
    ];
    for (const [input, repo, ref] of cases) {
      const r = parseRepo(input);
      expect(`${r.owner}/${r.name}`, input).toBe(repo);
      expect(r.ref, input).toBe(ref);
    }
    expect(() => parseRepo("https://gitlab.com/a/b")).toThrow();
  });

  it("tries the shortest branch prefix first, the rest is a folder", () => {
    expect(refCandidates(null)).toEqual([["HEAD", null]]);
    expect(refCandidates("main/src/flask")).toEqual([["main", "src/flask"], ["main/src", "flask"], ["main/src/flask", null]]);
  });

  it("keeps the project's own code first when over budget, and skips virtualenvs", () => {
    const f = (path: string, size = 10) => ({ path, size });
    const notes: string[] = [];
    const kept = selectFiles({ scope: null, files: [
      f("docs/conf.py"), f("pkg/core.py"), f(".venv/lib/python3.12/site-packages/six.py"), f("tests/test_core.py"),
      f("pkg/huge_pb2.py", 5e6), f("README.md"), f("pkg/sub/util.PY"),
    ] }, false, notes);
    expect(kept.map((x) => x.path)).toEqual(["pkg/core.py", "pkg/sub/util.PY", "docs/conf.py"]);
    expect(notes.join(" ")).toMatch(/over 1 MB/);
  });

  it("limits a /tree/<branch>/<folder> link to that folder", () => {
    const kept = selectFiles({ scope: "src/flask", files: [{ path: "src/flask/app.py", size: 1 }, { path: "src/other.py", size: 1 }] }, false, []);
    expect(kept.map((x) => x.path)).toEqual(["src/flask/app.py"]);
  });

  it("includes tests when tests are all there is", () => {
    const notes: string[] = [];
    expect(selectFiles({ scope: null, files: [{ path: "tests/test_a.py", size: 1 }] }, false, notes)).toHaveLength(1);
    expect(notes[0]).toMatch(/all tests/);
  });

  it("follows renames: raw files come from the canonical owner/name", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      sha: "t", truncated: false, url: "https://api.github.com/repos/NewOwner/new-name/git/trees/t",
      tree: [{ type: "blob", mode: "100644", path: "a.py", size: 1 }, { type: "blob", mode: "120000", path: "link.py", size: 1 }],
    })));
    const l = await listFiles({ owner: "old", name: "name", ref: null });
    expect([l.owner, l.name]).toEqual(["NewOwner", "new-name"]);
    expect(l.files.map((x) => x.path)).toEqual(["a.py"]); // the symlink is left out
    vi.unstubAllGlobals();
  });
});
