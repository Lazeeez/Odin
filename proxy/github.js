const NAME = "[A-Za-z0-9_.-]{1,100}";
const ROUTES = [
  { path: new RegExp(`^/repos/${NAME}/${NAME}/issues/\\d{1,9}$`), query: [], ttl: 600 },
  { path: new RegExp(`^/repos/${NAME}/${NAME}/issues$`), query: ["state", "per_page", "sort", "labels"], ttl: 600 },
  { path: new RegExp(`^/repos/${NAME}/${NAME}/commits$`), query: ["path", "per_page", "sha"], ttl: 3600 },
  { path: new RegExp(`^/repos/${NAME}/${NAME}/git/trees/[^/]{1,200}$`), query: ["recursive"], ttl: 3600 },
];
const KEPT_HEADERS = ["content-type", "etag", "last-modified"];

const reply = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } });

export async function github(request, env, url) {
  if (request.method !== "GET") return reply({ error: "GET only" }, 405);
  if (!env.GITHUB_TOKEN) return reply({ error: "no token configured" }, 501);
  const path = url.pathname.slice("/gh".length);
  const route = ROUTES.find((r) => r.path.test(path));
  if (!route) return reply({ error: "not an allowed GitHub request" }, 404);
  const query = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!route.query.includes(k) || v.length > 300) return reply({ error: "not an allowed GitHub request" }, 404);
    query.set(k, v);
  }
  query.sort();
  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: `gh:${request.headers.get("CF-Connecting-IP") ?? "unknown"}` });
    if (!success) return reply({ error: "slow down" }, 429);
  }
  const upstream = `https://api.github.com${path}${query.size ? `?${query}` : ""}`;
  const ttl = path.includes("/git/trees/HEAD") ? 300 : route.ttl;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(upstream);
  const hit = cache && (await cache.match(key));
  if (hit) return hit;
  const response = await fetch(upstream, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "User-Agent": "odin-allfather.dev",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const headers = new Headers({ "cache-control": `public, max-age=${ttl}` });
  for (const h of KEPT_HEADERS) if (response.headers.get(h)) headers.set(h, response.headers.get(h));
  const out = new Response(response.body, { status: response.status, headers });
  if (cache && (response.status === 200 || response.status === 404)) await cache.put(key, out.clone());
  return out;
}
