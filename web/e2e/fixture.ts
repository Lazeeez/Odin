import type { Page } from "@playwright/test";

/** A small Python project served in place of GitHub, so search results are known exactly. */
export const REPO = "odin-e2e/fixture";

const FILES: Record<string, string> = {
  "pkg/config.py": [
    "import os",
    "",
    "",
    "def load_config(path):",
    '    """Read the settings file; a missing file should fall back to defaults."""',
    "    with open(path) as fh:",
    "        return parse(fh.read())",
    "",
    "",
    "def parse(text):",
    '    return dict(line.split("=", 1) for line in text.splitlines() if line)',
  ].join("\n"),
  "pkg/http.py": [
    "class Client:",
    "    def fetch(self, url, timeout=None):",
    "        response = self.session.get(url)",
    "        return response.json()",
    "",
    "    def close(self):",
    "        self.session.close()",
  ].join("\n"),
  "pkg/__init__.py": "from .config import load_config\n",
  "tests/test_config.py": "def test_load():\n    assert True\n",
};

/** Route GitHub's API and file server to FILES, and keep the ML model off the network. */
export async function serveFixture(page: Page): Promise<void> {
  await page.route("https://api.github.com/repos/odin-e2e/fixture/git/trees/**", (route) =>
    route.fulfill({
      json: {
        sha: "fixture-tree-1",
        url: "https://api.github.com/repos/odin-e2e/fixture/git/trees/fixture-tree-1",
        truncated: false,
        tree: Object.entries(FILES).map(([path, text]) => ({ type: "blob", mode: "100644", path, size: text.length })),
      },
    }),
  );
  await page.route("https://raw.githubusercontent.com/odin-e2e/fixture/**", (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.split("/").slice(4).join("/"));
    return FILES[path] == null ? route.fulfill({ status: 404, body: "" }) : route.fulfill({ body: FILES[path] });
  });
  await page.route("https://api.github.com/repos/odin-e2e/fixture/issues**", (route) => route.fulfill({ json: [] }));
  // The semantic model (tens of MB) is not part of these tests.
  await page.route(/huggingface\.co|cdn\.jsdelivr\.net/, (route) => route.abort());
}
