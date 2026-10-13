import { afterEach, describe, expect, it, vi } from "vitest";

type Relay = { fetch(request: Request, env: Record<string, string>): Promise<Response> };

const relay = ((await import("../../proxy/cloudflare-worker.js" as string)) as { default: Relay }).default;

const SITE = "https://odin.example";
const ENV = { ALLOWED_ORIGINS: SITE };

const upstream = () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return new Response("archive", { status: 200, headers: { "content-type": "application/x-gzip" } });
  });
  return calls;
};

afterEach(() => vi.unstubAllGlobals());

describe("archive relay", () => {
  it("passes an archive through for an allowed origin", async () => {
    const calls = upstream();
    const response = await relay.fetch(new Request("https://relay.example/psf/requests/HEAD", { headers: { Origin: SITE } }), ENV);
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(SITE);
    expect(calls).toEqual(["https://codeload.github.com/psf/requests/tar.gz/HEAD"]);
  });

  it("refuses another site", async () => {
    const calls = upstream();
    const response = await relay.fetch(new Request("https://relay.example/psf/requests/HEAD", { headers: { Origin: "https://elsewhere.example" } }), ENV);
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("serves the site's own pages under a route prefix, where browsers send no Origin", async () => {
    const calls = upstream();
    const env = { ...ENV, ROUTE_PREFIX: "/relay" };
    const sameOrigin = new Request(`${SITE}/relay/django/django/stable/5.0.x`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect((await relay.fetch(sameOrigin, env)).status).toBe(200);
    expect(calls).toEqual(["https://codeload.github.com/django/django/tar.gz/stable/5.0.x"]);
    expect((await relay.fetch(new Request(`${SITE}/relay/django/django/main`), env)).status).toBe(403);
    expect((await relay.fetch(new Request(`${SITE}/elsewhere/django/django/main`, { headers: { Origin: SITE } }), env)).status).toBe(404);
  });

  it("proxies nothing but GitHub archives", async () => {
    const calls = upstream();
    const headers = { Origin: SITE };
    expect((await relay.fetch(new Request("https://relay.example/psf", { headers }), ENV)).status).toBe(400);
    expect((await relay.fetch(new Request("https://relay.example/psf/requests/HEAD", { method: "POST", headers }), ENV)).status).toBe(405);
    expect(calls).toEqual([]);
  });
});
