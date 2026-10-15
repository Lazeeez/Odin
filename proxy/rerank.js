const MAX_TEXTS = 50;
const MAX_CHARS = 8000;
const MAX_BODY = 1_000_000;
const TIMEOUT_MS = 90_000;

const reply = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

const valid = (body) =>
  body && typeof body.query === "string" && body.query.length > 0 && body.query.length <= MAX_CHARS
  && Array.isArray(body.texts) && body.texts.length >= 2 && body.texts.length <= MAX_TEXTS
  && body.texts.every((t) => typeof t === "string" && t.length <= MAX_CHARS);

export async function warm(request, env, ctx) {
  if (request.method !== "POST") return reply({ error: "POST only" }, 405);
  if (!env.RERANK_URL || !env.MODAL_KEY || !env.MODAL_SECRET) return reply({ error: "no reranker configured" }, 501);
  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: `rw:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
    if (!success) return reply({ error: "slow down" }, 429);
  }
  const started = fetch(env.RERANK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "Modal-Key": env.MODAL_KEY, "Modal-Secret": env.MODAL_SECRET },
    body: JSON.stringify({ query: "warm", texts: ["a", "b"] }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (ctx?.waitUntil) ctx.waitUntil(started);
  return reply({ warming: true }, 202);
}

const hex = (buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function rerank(request, env) {
  if (request.method !== "POST") return reply({ error: "POST only" }, 405);
  if (!env.RERANK_URL || !env.MODAL_KEY || !env.MODAL_SECRET) return reply({ error: "no reranker configured" }, 501);
  const raw = await request.text();
  if (raw.length > MAX_BODY) return reply({ error: "too large" }, 413);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: "not JSON" }, 400);
  }
  if (!valid(body)) return reply({ error: "expected a query and 2 to 50 texts of at most 8000 characters" }, 400);
  const clean = JSON.stringify({ query: body.query, texts: body.texts });
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://rerank.cache/${hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean)))}`);
  const hit = cache && (await cache.match(key));
  if (hit) return hit;
  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: `rr:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
    if (!success) return reply({ error: "slow down" }, 429);
  }
  const upstream = await fetch(env.RERANK_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "Modal-Key": env.MODAL_KEY, "Modal-Secret": env.MODAL_SECRET },
    body: clean,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!upstream?.ok) return reply({ error: "reranker unavailable" }, 502);
  const out = await upstream.json().catch(() => null);
  const scores = out?.scores;
  const shaped = Array.isArray(scores) && scores.length > 0
    && scores.every((s) => Array.isArray(s) && s.length === body.texts.length && s.every(Number.isFinite));
  if (!shaped) return reply({ error: "reranker unavailable" }, 502);
  const response = reply({ scores }, 200, { "cache-control": "public, max-age=86400" });
  if (cache) await cache.put(key, response.clone());
  return response;
}
