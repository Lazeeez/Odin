# Moving the website to Cloudflare

How to serve Odin from `allfather.dev` on Cloudflare Pages, with the archive relay on the same origin, and turn the GitHub Pages site into a redirect.

**Status.** Everything in the repository is ready and tested locally. Nothing has been deployed to Cloudflare, and the GitHub Pages site and the `workers.dev` relay are untouched. Keep both running until step 5 passes.

## What changes for a visitor

- **One origin.** The site and the relay share `allfather.dev`, so the relay needs no cross-origin setup and no origin allowlist to maintain.
- **Real response headers.** A content security policy, cross-origin isolation and long-lived caching of hashed assets come from the server, where GitHub Pages could only approximate isolation through the service worker.
- **Old links keep working.** `lazeeez.github.io/Odin/#/search?...` redirects to the same route on the new domain.

## Steps

### 1. Check the domain is on Cloudflare

`allfather.dev` must be an active zone in the Cloudflare account that will host the site (it is, if it was bought through Cloudflare Registrar). The domain is already written into `proxy/wrangler.toml` and `deploy/github-pages-redirect/`.

### 2. Create the Pages project

In the Cloudflare dashboard: Workers & Pages → Create → Pages → Connect to Git, and pick this repository.

| Setting | Value |
|---|---|
| Production branch | `main` |
| Root directory | `web` |
| Build command | `npm ci --ignore-scripts && npm run build` |
| Build output directory | `dist` |
| Environment variable `NODE_VERSION` | `24` |
| Environment variable `VITE_ARCHIVE_PROXY` | `/relay` |

Then add the custom domain `allfather.dev` to the project. Pull requests get preview URLs from the Git integration without further setup; previews have no relay route, so they fall back to loading through GitHub's API.

The build writes `dist/_headers`, which Pages applies by itself. Nothing is configured by hand.

### 3. Deploy the relay on the same origin

```sh
cd proxy
npx wrangler deploy --env production
```

This creates a second Worker, `odin-relay`, routed at `allfather.dev/relay/*`. The existing `odin-archive-relay` on `workers.dev` is a separate Worker and keeps serving the GitHub Pages site.

### 4. Check the new site before touching the old one

- `https://allfather.dev/` loads, and the browser console shows no "Refused to" lines.
- Load a large repository (for example `django/django`). In the network tab there is one request to `/relay/django/django/HEAD` and none to `api.github.com`.
- Open a deep link such as `https://allfather.dev/#/explore` directly.
- Run a search that reaches the "rerank" stage. It downloads a model from Hugging Face and a library from jsDelivr, the two paths the local tests do not exercise end to end.
- `curl -sI https://allfather.dev/ | grep -i content-security-policy` prints the policy.
- `curl -s -o /dev/null -w "%{http_code}" https://allfather.dev/relay/psf/requests/HEAD` prints `403`: the relay answers only the site's own pages.

### 5. Turn GitHub Pages into a redirect

Only after step 4 passes.

1. In `.github/workflows/pages.yml`, publish `deploy/github-pages-redirect` instead of `web/dist` (change the `path` of the upload step and drop the two build steps).
2. Push, wait for the Pages run, and open an old link with a route in it: `https://lazeeez.github.io/Odin/#/explore` should land on `https://allfather.dev/#/explore`.
3. Remove the repository variable `ARCHIVE_PROXY` and delete the `odin-archive-relay` Worker.
4. Update the site URL in `README.md`, `CITATION.cff` and `web/index.html` (canonical and social-card tags).

The redirect stays for good; it is two small files.

## What was tested here, and what was not

| Check | How | Result |
|---|---|---|
| The site works under the generated headers | End-to-end suite in Chromium and WebKit against `web/scripts/serve-dist.mjs`, which serves the build with its `_headers` (`WITH_HEADERS=1 npm run e2e`) | passes |
| The policy allows GitHub, jsDelivr and Hugging Face and blocks other origins | A headless page under those headers fetching each origin | allowed ones answer, others are refused |
| Cross-origin isolation is on | `crossOriginIsolated` in that page | true |
| The relay under a path prefix, same-origin and cross-origin | `web/test/relay.test.ts` | passes |
| Cloudflare applying `_headers`, the Worker route, the custom domain | needs the real deployment | not tested |
| The rerank stage under the policy | needs a real browser session on the deployed site (step 4) | not tested |

## Decisions and loose ends

- **No R2 bucket.** The plan put large assets on `assets.allfather.dev`. The largest file is the 16 MB embedding model, under Pages' 25 MB per-file limit, and keeping it on the same origin avoids a cross-origin fetch under the isolation headers. Revisit if a file outgrows the limit.
- **The policy allows `https://*.workers.dev`** so that a build pointed at the old relay still works during the move. Remove that entry from `CONNECT` in `web/vite.config.ts` after step 5.
- **The policy allows inline styles.** The components set style attributes; tightening that means moving them to classes.
- **The service worker still adds isolation headers itself.** It is harmless next to real headers and is what keeps the GitHub Pages copy working until the redirect.
