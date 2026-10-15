import { afterEach, describe, expect, it, vi } from "vitest";

type Worker = { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };

const worker = ((await import("../../proxy/cloudflare-worker.js" as string)) as { default: Worker }).default;

const SITE = "https://odin.example";
const ENV = { ALLOWED_ORIGINS: SITE, ROUTE_PREFIX: "/relay", GITHUB_TOKEN: "test-token" };
const get = (path: string, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) =>
  new Request(`${SITE}/gh${path}`, { headers });

const upstream = () => {
  const calls: { url: string; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url, auth: new Headers(init?.headers).get("Authorization") });
    return new Response(JSON.stringify({ title: "A bug" }), { status: 200, headers: { "content-type": "application/json", "set-cookie": "x=1" } });
  });
  return calls;
};

afterEach(() => vi.unstubAllGlobals());

describe("GitHub proxy", () => {
  it("forwards the allowed requests with the token, and only their known parameters", async () => {
    const calls = upstream();
    expect((await worker.fetch(get("/repos/psf/requests/issues/6643"), ENV)).status).toBe(200);
    expect((await worker.fetch(get("/repos/psf/requests/issues?state=open&per_page=30&sort=comments&labels=bug"), ENV)).status).toBe(200);
    expect((await worker.fetch(get("/repos/psf/requests/commits?path=src%2Frequests%2Fapi.py&per_page=1"), ENV)).status).toBe(200);
    expect((await worker.fetch(get("/repos/psf/requests/git/trees/HEAD?recursive=1"), ENV)).status).toBe(200);
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/psf/requests/issues/6643",
      "https://api.github.com/repos/psf/requests/issues?labels=bug&per_page=30&sort=comments&state=open",
      "https://api.github.com/repos/psf/requests/commits?path=src%2Frequests%2Fapi.py&per_page=1",
      "https://api.github.com/repos/psf/requests/git/trees/HEAD?recursive=1",
    ]);
    expect(calls.every((c) => c.auth === "Bearer test-token")).toBe(true);
  });

  it("never passes GitHub's cookies or other headers back", async () => {
    upstream();
    const response = await worker.fetch(get("/repos/psf/requests/issues/1"), ENV);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("content-type")).toBe("application/json");
  });

  it("refuses anything outside the allowed shapes", async () => {
    const calls = upstream();
    for (const path of ["/user", "/repos/psf/requests", "/repos/psf/requests/issues/1/comments", "/repos/psf/requests/issues/abc",
      "/repos/psf/requests/issues/1?access_token=x", "/repos/psf/requests/commits?path=a&author=me", "/search/issues?q=x"]) {
      expect((await worker.fetch(get(path), ENV)).status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("says it is not configured until a token exists, so the site asks GitHub directly", async () => {
    const calls = upstream();
    expect((await worker.fetch(get("/repos/psf/requests/issues/1"), { ...ENV, GITHUB_TOKEN: undefined })).status).toBe(501);
    expect(calls).toEqual([]);
  });

  it("answers only the site's own pages, only GET, and within the rate limit", async () => {
    const calls = upstream();
    expect((await worker.fetch(get("/repos/psf/requests/issues/1", { Origin: "https://elsewhere.example" }), ENV)).status).toBe(403);
    expect((await worker.fetch(get("/repos/psf/requests/issues/1", {}), ENV)).status).toBe(403);
    expect((await worker.fetch(new Request(`${SITE}/gh/repos/psf/requests/issues/1`, { method: "POST", headers: { Origin: SITE } }), ENV)).status).toBe(405);
    const limited = { ...ENV, LIMITER: { limit: async () => ({ success: false }) } };
    expect((await worker.fetch(get("/repos/psf/requests/issues/1"), limited)).status).toBe(429);
    expect(calls).toEqual([]);
  });
});
