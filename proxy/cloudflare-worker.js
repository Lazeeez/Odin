// A CORS relay for GitHub repository archives, so the website can download a whole repository
// in one request instead of one per file (seconds instead of a minute for large projects).
// GitHub serves archives from codeload.github.com without CORS headers for other sites; this
// passes them through, streaming, with those headers added. Nothing else is proxied.
//
// Deploy (free plan is plenty): `npx wrangler deploy` in this folder, then set the repository
// variable ARCHIVE_PROXY to the worker's URL (Settings -> Secrets and variables -> Actions ->
// Variables). The next Pages build picks it up; without it the site downloads file by file.

import { api } from "./api.js";

const PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_./-]+)$/;

// Only the site itself may use the relay, so nobody else spends this account's free quota:
// ALLOWED_ORIGINS (wrangler.toml) lists the site's origins, comma-separated. Browsers always
// send Origin on these cross-origin requests; unset, the relay is open to any site.
const allowed = (env, request, origin) => {
  const list = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sameSite = !origin && request.headers.get("Sec-Fetch-Site") === "same-origin";
  return !list.length || list.includes(origin) || sameSite;
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") ?? "";
    const cors = { "Access-Control-Allow-Origin": origin || "*", "Cross-Origin-Resource-Policy": "cross-origin", Vary: "Origin" };
    if (!allowed(env, request, origin)) return new Response("origin not allowed", { status: 403, headers: cors });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return api(request, env, url.pathname.slice(4));
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (request.method !== "GET") return new Response("GET only", { status: 405, headers: cors });
    const prefix = (env.ROUTE_PREFIX ?? "").replace(/\/+$/, "");
    const pathname = url.pathname;
    if (prefix && !pathname.startsWith(`${prefix}/`)) return new Response("not found", { status: 404, headers: cors });
    const m = pathname.slice(prefix.length).match(PATH);
    if (!m) return new Response("usage: /<owner>/<repo>/<ref>", { status: 400, headers: cors });
    const [, owner, repo, ref] = m;
    const upstream = await fetch(`https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}`, {
      cf: { cacheEverything: true, cacheTtl: ref === "HEAD" ? 300 : 86400 },
    });
    const headers = new Headers(cors);
    for (const h of ["content-type", "content-length", "etag"]) if (upstream.headers.get(h)) headers.set(h, upstream.headers.get(h));
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
