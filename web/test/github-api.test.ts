import { afterEach, describe, expect, it, vi } from "vitest";

const load = async () => {
  vi.resetModules();
  vi.stubEnv("VITE_GITHUB_PROXY", "/gh");
  return (await import("../src/engine/github.ts")).githubApi;
};

const answer = (status: number) => new Response("{}", { status });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GitHub API calls from the page", () => {
  it("go through the site's proxy when it answers", async () => {
    const githubApi = await load();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (calls.push(url), answer(200)));
    expect((await githubApi("/repos/psf/requests/issues/1")).status).toBe(200);
    expect(calls).toEqual(["/gh/repos/psf/requests/issues/1"]);
  });

  it("go straight to GitHub, from then on, when the proxy has no token", async () => {
    const githubApi = await load();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => (calls.push(url), answer(url.startsWith("/gh") ? 501 : 200)));
    await githubApi("/repos/a/b/issues/1");
    await githubApi("/repos/a/b/issues/2");
    expect(calls).toEqual(["/gh/repos/a/b/issues/1", "https://api.github.com/repos/a/b/issues/1", "https://api.github.com/repos/a/b/issues/2"]);
  });

  it("fall back to GitHub when the proxy is unreachable or overloaded, and keep GitHub's own answers", async () => {
    const githubApi = await load();
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      if (url === "/gh/repos/a/b/issues/1") throw new TypeError("offline");
      if (url === "/gh/repos/a/b/issues/2") return answer(429);
      return answer(url.startsWith("/gh") ? 404 : 200);
    });
    expect((await githubApi("/repos/a/b/issues/1")).status).toBe(200);
    expect((await githubApi("/repos/a/b/issues/2")).status).toBe(200);
    expect((await githubApi("/repos/a/b/issues/3")).status).toBe(404);
    expect(calls).toEqual([
      "/gh/repos/a/b/issues/1", "https://api.github.com/repos/a/b/issues/1",
      "/gh/repos/a/b/issues/2", "https://api.github.com/repos/a/b/issues/2",
      "/gh/repos/a/b/issues/3",
    ]);
  });
});
