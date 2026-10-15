import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

type Worker = { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };

const worker = ((await import("../../proxy/cloudflare-worker.js" as string)) as { default: Worker }).default;
const schema = readFileSync(new URL("../../deploy/cloudflare/schema.sql", import.meta.url), "utf-8");

const SITE = "https://odin.example";

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);
  const binding = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          args = values;
          return statement;
        },
        async run() {
          db.prepare(sql).run(...(args as never[]));
          return { success: true };
        },
        async first() {
          return db.prepare(sql).get(...(args as never[])) ?? null;
        },
      };
      return statement;
    },
  };
  return { db, binding };
}

const vote = {
  repo: "psf/requests", sha: `commit:${"a".repeat(40)}`, unit: "src/requests/sessions.py::SessionRedirectMixin.rebuild_auth",
  rank: 3, vote: 1, stage: "rerank", issue: "https://github.com/psf/requests/issues/1234", session: "0f8c5a1e-3b4d-4c2a-9e7f-1a2b3c4d5e6f",
};

const post = (path: string, body: unknown, origin = SITE) =>
  new Request(`${SITE}/api${path}`, { method: "POST", headers: { Origin: origin, "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });

const setup = () => {
  const { db, binding } = d1();
  return { db, env: { ALLOWED_ORIGINS: SITE, ROUTE_PREFIX: "/relay", DB: binding } };
};

describe("feedback API", () => {
  it("stores a vote, and a second vote on the same result replaces the first", async () => {
    const { db, env } = setup();
    expect((await worker.fetch(post("/vote", vote), env)).status).toBe(200);
    expect((await worker.fetch(post("/vote", { ...vote, vote: -1 }), env)).status).toBe(200);
    const rows = db.prepare("SELECT repo, unit, rank, vote, issue FROM votes").all();
    expect(rows).toEqual([{ repo: "psf/requests", unit: vote.unit, rank: 3, vote: -1, issue: vote.issue }]);
  });

  it("counts searches by day, repository and source, and never stores text", async () => {
    const { db, env } = setup();
    const search = { repo: "Django/Django", source: "issue", stage: "semantic", session: "abcdef12" };
    await worker.fetch(post("/search", search), env);
    await worker.fetch(post("/search", { ...search, session: "abcdef13" }), env);
    const rows = db.prepare("SELECT repo, source, n FROM searches").all();
    expect(rows).toEqual([{ repo: "django/django", source: "issue", n: 2 }]);
  });

  it("rejects anything that is not exactly a vote", async () => {
    const { db, env } = setup();
    const bad = [
      { ...vote, repo: "not a repo" },
      { ...vote, rank: 0 },
      { ...vote, rank: 51 },
      { ...vote, vote: 2 },
      { ...vote, stage: "other" },
      { ...vote, issue: "https://example.com/psf/requests/issues/1" },
      { ...vote, sha: "main" },
      { ...vote, unit: "x".repeat(401) },
      { ...vote, session: "short" },
      "not json",
      [vote],
      { ...vote, padding: "x".repeat(3000) },
    ];
    for (const body of bad) expect((await worker.fetch(post("/vote", body), env)).status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM votes").get()).toEqual({ n: 0 });
  });

  it("answers only the site's own pages, and only the right methods", async () => {
    const { env } = setup();
    expect((await worker.fetch(post("/vote", vote, "https://elsewhere.example"), env)).status).toBe(403);
    expect((await worker.fetch(new Request(`${SITE}/api/vote`, { headers: { Origin: SITE } }), env)).status).toBe(405);
    expect((await worker.fetch(post("/stats", {}), env)).status).toBe(405);
    expect((await worker.fetch(post("/other", {}), env)).status).toBe(404);
    expect((await worker.fetch(post("/vote", vote), { ALLOWED_ORIGINS: SITE })).status).toBe(503);
  });

  it("is rate limited when a limiter is bound", async () => {
    const { env } = setup();
    const limited = { ...env, LIMITER: { limit: async () => ({ success: false }) } };
    expect((await worker.fetch(post("/vote", vote), limited)).status).toBe(429);
  });

  it("accepts the nightly live summary only with the shared token, and serves it to the site", async () => {
    const { env } = setup();
    const withToken = { ...env, LIVE_TOKEN: "s3cret-token-value" };
    const summary = { generated: "2026-10-16T03:00:00+00:00", last_30_days: { bugs: 41 }, all_time: { bugs: 41 } };
    const publish = (token: string | null, body: unknown = summary) =>
      new Request(`${SITE}/api/live`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    const read = () => worker.fetch(new Request(`${SITE}/api/live`, { headers: { "Sec-Fetch-Site": "same-origin" } }), withToken);
    expect((await read()).status).toBe(404);
    expect((await worker.fetch(publish(null), withToken)).status).toBe(401);
    expect((await worker.fetch(publish("s3cret-token-valuX"), withToken)).status).toBe(401);
    expect((await worker.fetch(publish("s3cret-token-value"), env)).status).toBe(401);
    expect((await worker.fetch(publish("s3cret-token-value", "not json"), withToken)).status).toBe(400);
    expect((await worker.fetch(publish("s3cret-token-value", { generated: "x" }), withToken)).status).toBe(400);
    expect((await worker.fetch(publish("s3cret-token-value", { ...summary, pad: "x".repeat(70000) }), withToken)).status).toBe(413);
    expect((await worker.fetch(publish("s3cret-token-value"), withToken)).status).toBe(200);
    expect(await (await read()).json()).toEqual(summary);
    expect((await worker.fetch(publish("s3cret-token-value", { ...summary, last_30_days: { bugs: 50 } }), withToken)).status).toBe(200);
    expect(((await (await read()).json()) as { last_30_days: { bugs: number } }).last_30_days.bugs).toBe(50);
  });

  it("reports totals", async () => {
    const { env } = setup();
    await worker.fetch(post("/search", { repo: "psf/requests", source: "typed", stage: "rerank", session: "abcdef12" }), env);
    await worker.fetch(post("/search", { repo: "pallets/flask", source: "preset", stage: "rerank", session: "abcdef13" }), env);
    await worker.fetch(post("/vote", vote), env);
    await worker.fetch(post("/vote", { ...vote, unit: "src/requests/sessions.py::Session.send", vote: -1 }), env);
    const response = await worker.fetch(new Request(`${SITE}/api/stats`, { headers: { "Sec-Fetch-Site": "same-origin" } }), env);
    const stats = (await response.json()) as Record<string, unknown>;
    expect(stats).toMatchObject({ searches: 2, repos: 2, up: 1, down: 1 });
    expect(stats.since).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
