const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^(commit:)?[0-9a-f]{40}$/;
const SESSION = /^[0-9a-z-]{8,40}$/;
const ISSUE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/issues\/\d{1,9}$/;
const STAGES = new Set(["instant", "semantic", "rerank"]);
const SOURCES = new Set(["typed", "preset", "issue", "link"]);
const MAX_BODY = 2048;
const STATS_TTL = 300;

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const day = () => new Date().toISOString().slice(0, 10);

async function readBody(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

export function validSearch(b) {
  return REPO.test(b.repo ?? "") && SOURCES.has(b.source) && STAGES.has(b.stage) && SESSION.test(b.session ?? "");
}

export function validVote(b) {
  return (
    REPO.test(b.repo ?? "") &&
    (b.sha == null || SHA.test(b.sha)) &&
    typeof b.unit === "string" && b.unit.length > 0 && b.unit.length <= 400 &&
    Number.isInteger(b.rank) && b.rank >= 1 && b.rank <= 50 &&
    (b.vote === 1 || b.vote === -1) &&
    STAGES.has(b.stage) &&
    (b.issue == null || ISSUE.test(b.issue)) &&
    SESSION.test(b.session ?? "")
  );
}

async function limited(env, request) {
  if (!env.LIMITER) return false;
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await env.LIMITER.limit({ key });
  return !success;
}

async function stats(env) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request("https://stats.internal/v1");
  const hit = cache && (await cache.match(key));
  if (hit) return hit;
  const searches = await env.DB.prepare(
    "SELECT COALESCE(SUM(n), 0) AS searches, COUNT(DISTINCT repo) AS repos, MIN(day) AS since FROM searches",
  ).first();
  const votes = await env.DB.prepare(
    "SELECT COALESCE(SUM(vote = 1), 0) AS up, COALESCE(SUM(vote = -1), 0) AS down FROM votes",
  ).first();
  const response = json({ ...searches, ...votes }, 200, { "cache-control": `public, max-age=${STATS_TTL}` });
  if (cache) await cache.put(key, response.clone());
  return response;
}

const MAX_LIVE = 65536;
const LIVE_TTL = 600;

const sameToken = (given, expected) => {
  if (typeof given !== "string" || typeof expected !== "string" || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
};

export async function publishLive(request, env) {
  if (!env.DB) return json({ error: "storage not configured" }, 503);
  const token = (request.headers.get("Authorization") ?? "").replace(/^Bearer /, "");
  if (!sameToken(token, env.LIVE_TOKEN)) return json({ error: "unauthorized" }, 401);
  const text = await request.text();
  if (text.length > MAX_LIVE) return json({ error: "too large" }, 413);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "bad request" }, 400);
  }
  if (!body || typeof body !== "object" || !body.last_30_days || !body.all_time || typeof body.generated !== "string") {
    return json({ error: "bad request" }, 400);
  }
  await env.DB.prepare(
    "INSERT INTO live (id, body, updated) VALUES (1, ?1, ?2) ON CONFLICT (id) DO UPDATE SET body = excluded.body, updated = excluded.updated",
  ).bind(JSON.stringify(body), new Date().toISOString()).run();
  return json({ ok: true });
}

async function live(env) {
  const row = await env.DB.prepare("SELECT body FROM live WHERE id = 1").first();
  if (!row) return json({ error: "no live results yet" }, 404, { "cache-control": "public, max-age=60" });
  return new Response(row.body, { headers: { "content-type": "application/json", "cache-control": `public, max-age=${LIVE_TTL}` } });
}

export async function api(request, env, path) {
  if (!env.DB) return json({ error: "storage not configured" }, 503);
  if (path === "/stats") {
    return request.method === "GET" ? stats(env) : json({ error: "GET only" }, 405);
  }
  if (path === "/live") {
    return request.method === "GET" ? live(env) : json({ error: "GET only" }, 405);
  }
  if (path !== "/search" && path !== "/vote") return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (await limited(env, request)) return json({ error: "slow down" }, 429);
  const b = await readBody(request);
  if (!b) return json({ error: "bad request" }, 400);
  if (path === "/search") {
    if (!validSearch(b)) return json({ error: "bad request" }, 400);
    await env.DB.prepare(
      "INSERT INTO searches (day, repo, source, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, repo, source) DO UPDATE SET n = n + 1",
    ).bind(day(), b.repo.toLowerCase(), b.source).run();
    return json({ ok: true });
  }
  if (!validVote(b)) return json({ error: "bad request" }, 400);
  await env.DB.prepare(
    `INSERT INTO votes (day, repo, sha, unit, rank, vote, stage, issue, session) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT (session, repo, unit) DO UPDATE SET vote = excluded.vote, rank = excluded.rank, stage = excluded.stage, day = excluded.day`,
  ).bind(day(), b.repo.toLowerCase(), b.sha ?? null, b.unit, b.rank, b.vote, b.stage, b.issue ?? null, b.session).run();
  return json({ ok: true });
}
