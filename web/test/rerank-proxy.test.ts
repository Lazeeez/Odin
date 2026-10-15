import { afterEach, describe, expect, it, vi } from "vitest";

type Worker = { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };

const worker = ((await import("../../proxy/cloudflare-worker.js" as string)) as { default: Worker }).default;

const SITE = "https://odin.example";
const ENV = { ALLOWED_ORIGINS: SITE, ROUTE_PREFIX: "/relay", RERANK_URL: "https://gpu.example/score", MODAL_KEY: "k", MODAL_SECRET: "s" };
const post = (body: unknown, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) =>
  new Request(`${SITE}/rerank`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const ok = { query: "the theme toggle does nothing", texts: ["a\nx", "b\ny"] };

const upstream = (reply: () => Response = () => new Response(JSON.stringify({ scores: [[1, 2], [3, 4]] }), { status: 200 })) => {
  const calls: { url: string; headers: Headers; body: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers), body: init.body as string });
    return reply();
  });
  return calls;
};

afterEach(() => vi.unstubAllGlobals());

describe("GPU reranker proxy", () => {
  it("forwards a valid request with the Modal credentials and returns only the scores", async () => {
    const calls = upstream();
    const response = await worker.fetch(post({ ...ok, extra: "dropped" }), ENV);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ scores: [[1, 2], [3, 4]] });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ENV.RERANK_URL);
    expect(calls[0].headers.get("Modal-Key")).toBe("k");
    expect(calls[0].headers.get("Modal-Secret")).toBe("s");
    expect(JSON.parse(calls[0].body)).toEqual(ok);
  });

  it("refuses other sites, other methods and malformed requests without calling the server", async () => {
    const calls = upstream();
    expect((await worker.fetch(post(ok, { Origin: "https://elsewhere.example" }), ENV)).status).toBe(403);
    expect((await worker.fetch(new Request(`${SITE}/rerank`, { headers: { "Sec-Fetch-Site": "same-origin" } }), ENV)).status).toBe(405);
    expect((await worker.fetch(post("not json"), ENV)).status).toBe(400);
    expect((await worker.fetch(post({ query: "q", texts: ["only one"] }), ENV)).status).toBe(400);
    expect((await worker.fetch(post({ query: "q", texts: Array(51).fill("t") }), ENV)).status).toBe(400);
    expect((await worker.fetch(post({ query: "q", texts: ["a", "b".repeat(8001)] }), ENV)).status).toBe(400);
    expect((await worker.fetch(post({ query: "", texts: ["a", "b"] }), ENV)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 501 until the server is configured, and 502 when it fails or answers oddly", async () => {
    upstream();
    expect((await worker.fetch(post(ok), { ...ENV, RERANK_URL: undefined })).status).toBe(501);
    upstream(() => new Response("boom", { status: 500 }));
    expect((await worker.fetch(post(ok), ENV)).status).toBe(502);
    upstream(() => new Response(JSON.stringify({ scores: [[1]] }), { status: 200 }));
    expect((await worker.fetch(post(ok), ENV)).status).toBe(502);
  });

  it("wakes the GPU in the background and answers at once", async () => {
    const calls = upstream();
    const waiting: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waiting.push(p) };
    const warmUp = (env: Record<string, unknown>) =>
      (worker as unknown as { fetch(r: Request, e: Record<string, unknown>, c: unknown): Promise<Response> })
        .fetch(new Request(`${SITE}/rerank/warm`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } }), env, ctx);
    expect((await warmUp({ ...ENV, RERANK_URL: "https://me--odin-reranker-reranker-score.modal.run" })).status).toBe(202);
    await Promise.all(waiting);
    expect(calls.map((c) => c.url)).toEqual(["https://me--odin-reranker-reranker-warm.modal.run"]);
    expect(calls[0].headers.get("Modal-Key")).toBe("k");
    expect((await warmUp({ ...ENV, RERANK_URL: undefined })).status).toBe(501);
  });

  it("rate-limits each address", async () => {
    const calls = upstream();
    const LIMITER = { limit: async () => ({ success: false }) };
    expect((await worker.fetch(post(ok), { ...ENV, LIMITER })).status).toBe(429);
    expect(calls).toHaveLength(0);
  });
});
