import { afterEach, describe, expect, it, vi } from "vitest";
import { blend, ServerUnavailable, serverScores } from "../src/engine/server.ts";
import cases from "./server-blend.json";

afterEach(() => vi.unstubAllGlobals());

describe("GPU reranker blend", () => {
  it("orders candidates exactly as scripts/website_rerank.py did when ADR 0021 was measured", () => {
    for (const c of cases as { n: number; depth: number; scores: number[][]; order: string[] }[]) {
      const ids = Array.from({ length: c.n }, (_, i) => `u${i}`);
      expect(blend(ids, c.scores, c.depth, 1)).toEqual(c.order);
    }
  });

  it("keeps the browser's order when there is nothing to blend", () => {
    expect(blend(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    expect(blend(["a"], [[3]])).toEqual(["a"]);
  });
});

describe("GPU reranker call", () => {
  const answer = (status: number, body: unknown = {}) =>
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("sends at most 50 texts, each cut to 8000 characters, and returns the scores", async () => {
    answer(200, { scores: [[1, 2], [3, 4]] });
    const texts = Array.from({ length: 60 }, () => "x".repeat(9000));
    expect(await serverScores("/rerank", "q".repeat(9000), texts)).toEqual([[1, 2], [3, 4]]);
    const sent = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(sent.texts).toHaveLength(50);
    expect(sent.texts[0]).toHaveLength(8000);
    expect(sent.query).toHaveLength(8000);
  });

  it("treats a site without a server as permanent, and other failures as passing", async () => {
    answer(501);
    await expect(serverScores("/rerank", "q", ["a", "b"])).rejects.toMatchObject({ permanent: true });
    answer(429);
    await expect(serverScores("/rerank", "q", ["a", "b"])).rejects.toMatchObject({ permanent: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    await expect(serverScores("/rerank", "q", ["a", "b"])).rejects.toBeInstanceOf(ServerUnavailable);
  });
});
