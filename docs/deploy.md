# Hosting on allfather.dev

Odin's website and its archive relay run as one Cloudflare Worker: static files from `web/dist`, and the relay at `/relay/*` on the same origin. The configuration is `deploy/cloudflare/wrangler.jsonc`.

## Status, 2026-10-14

| Piece | State |
|---|---|
| The Worker `odin` (site and relay) on `allfather.dev` | live, in the Cloudflare account `lajatm9@gmail.com` |
| `www.allfather.dev` | serves the same site; pages declare `allfather.dev` as canonical |
| D1 database `odin` (search counts and votes, [ADR 0022](decisions/0022-website-feedback.md)) | live since 2026-10-15; checked with a real vote from a browser on `allfather.dev`, then the test rows were deleted |
| GitHub API proxy at `/gh/` ([ADR 0024](decisions/0024-github-api-proxy.md)) | deployed 2026-10-15; answers 501 until the `GITHUB_TOKEN` secret is stored, and the site then calls GitHub directly |
| Live accuracy ([ADR 0023](decisions/0023-live-accuracy.md)) | `/api/live` and the D1 table `live` deployed 2026-10-15; the nightly workflow `.github/workflows/live.yml` publishes once the `LIVE_TOKEN` secret is set in both the Worker and the repository; the site shows nothing until then |
| GitHub Pages site | being removed by the owner; see "GitHub Pages" |
| The `lajat69@gmail.com` Cloudflare account | holds only leftovers of the first attempt (`odin`, `odin-archive-relay`); nothing on `allfather.dev` uses it, and the site's policy no longer allows `*.workers.dev`; the owner deletes it from that account's dashboard |

## Deploying

```sh
cd web
npm ci --ignore-scripts
VITE_ARCHIVE_PROXY=/relay VITE_API=/api VITE_GITHUB_PROXY=/gh VITE_RERANK_SERVER=/rerank npm run build
cd ../deploy/cloudflare
npx wrangler deploy
```

`VITE_API=/api` turns on search counts and the 👍/👎 buttons ([ADR 0022](decisions/0022-website-feedback.md)); a build without it sends nothing. They need the D1 database once:

```sh
cd deploy/cloudflare
npx wrangler d1 create odin          # copy the printed database_id into wrangler.jsonc
npx wrangler d1 execute odin --remote --file schema.sql
```

`VITE_GITHUB_PROXY=/gh` sends the site's GitHub API calls (issue import, open issues, "file last changed") through the Worker ([ADR 0024](decisions/0024-github-api-proxy.md)). It uses a token once one is stored; until then the Worker answers 501 and the page calls GitHub directly. To store it, create a fine-grained token at github.com/settings/personal-access-tokens with "Public repositories (read-only)" and no permissions, then:

```sh
cd deploy/cloudflare
npx wrangler secret put GITHUB_TOKEN
```

`VITE_RERANK_SERVER=/rerank` adds the GPU reranker ([ADR 0021](decisions/0021-website-server-reranker.md)): the page sends the bug report and its top 50 functions to `/rerank`, the Worker checks and rate-limits the request and passes it to a Modal endpoint, and the page blends the scores into its order. Until the Worker has the endpoint, it answers 501 and the page stops asking and hides the switch. To set it up, once:

```sh
pip install modal
modal token new                              # logs this machine in to the Modal account
modal deploy deploy/modal/reranker.py        # prints the endpoint's URL, ending in -score.modal.run
```

Then, in the Modal dashboard under Settings → Proxy Auth Tokens, create a token, and store the URL and the token's two halves in the Worker:

```sh
cd deploy/cloudflare
npx wrangler secret put RERANK_URL
npx wrangler secret put MODAL_KEY
npx wrangler secret put MODAL_SECRET
```

The endpoint only answers requests carrying that token, runs on one L4 GPU at most (`max_containers=1`), and shuts down three minutes after the last request, so an idle month costs nothing and a busy one stays within Modal's free monthly credits. A spending limit in the Modal dashboard (Settings → Usage and billing) makes that a guarantee.

To try the Worker and the database locally, put `ALLOWED_ORIGINS="http://localhost:8787,http://allfather.dev"` in `deploy/cloudflare/.dev.vars` (ignored by git; in local mode wrangler rewrites the Origin header to the route's host), apply the schema with `--local` instead of `--remote`, and run `npx wrangler dev --local --port 8787`.

Reading the data: `npx wrangler d1 execute odin --remote --command "SELECT repo, SUM(n) FROM searches GROUP BY repo ORDER BY 2 DESC LIMIT 20"`.

In Git Bash on Windows, prefix the build with `MSYS_NO_PATHCONV=1`: without it the shell rewrites `/relay` into a Windows path and the site silently falls back to GitHub's API.

The build writes `dist/_headers` (content security policy, cross-origin isolation, caching of hashed assets). Cloudflare applies it to every static response.

## The account

The domain's zone is in the `lajatm9@gmail.com` Cloudflare account, so wrangler must be logged in to that one (`npx wrangler login`). `wrangler.jsonc` pins that account (`account_id`), so wrangler uses it even when it remembers another account from an earlier login. `wrangler.jsonc` asks for `allfather.dev` as a custom domain and Cloudflare creates the DNS record itself.

## Checks after a deploy

- `https://allfather.dev/` loads, and the browser console shows no "Refused to" lines.
- Loading `django/django` makes one request to `/relay/django/django/HEAD` and none to `api.github.com` for the file list.
- `https://allfather.dev/#/explore` opens directly.
- A search that reaches the "rerank" stage completes. It downloads a model from Hugging Face and a library from jsDelivr; the policy allows both, but the full path has not been exercised under it.
- `curl -s -o /dev/null -w "%{http_code}" https://allfather.dev/relay/psf/requests/HEAD` prints `403`: the relay answers only the site's own pages.

## GitHub Pages

The owner is removing the GitHub Pages site by hand. Its workflow (`.github/workflows/pages.yml`) and the prepared redirect page were deleted from the repository on 2026-10-14, so links to `lazeeez.github.io/Odin` stop working once Pages is turned off.

Left to clean up in the accounts, not in the repository:

- the repository variable `ARCHIVE_PROXY` (no longer read by anything);
- the `odin-archive-relay` Worker and the first copy of `odin`, both in the `lajat69@gmail.com` Cloudflare account;

## What has been tested

| Check | How | Result |
|---|---|---|
| The site under the generated headers | end-to-end suite in Chromium and WebKit against the build served with its `_headers` (`WITH_HEADERS=1 npm run e2e`) | passes |
| The relay refuses other callers | `curl` without browser headers | 403 |
| The relay's routing and allowlist | `web/test/relay.test.ts` | passes |
| `allfather.dev` itself | a headless browser on the live domain: home page, a search on `psf/requests` through `/relay`, Explore, Benchmarks | works; cross-origin isolated; the relay answers 403 to `curl` and to another origin |
| Cloudflare Web Analytics | the zone injects its beacon script; the policy allows `static.cloudflareinsights.com` and `cloudflareinsights.com` | the script loads on the live site with no policy violation |
| The rerank stage under the policy | a headless browser on the live domain, after a visitor reported "Language-model rerank unavailable" | failed until 2026-10-15: the ONNX runtime imports its module from a `blob:` URL, which `script-src` did not allow, so both the WebGPU and the WASM backends failed; with `blob:` added, the rerank of the top 20 completes (1.1 s) with no policy violation |

## Decisions

- **One Worker, not Pages plus a Worker.** Cloudflare now steers new static sites to Workers with static assets, and one deployment keeps the site and the relay on one origin with one command.
- **The bare domain, not a subdomain**, by the owner's choice.
- **No R2 bucket.** The largest file is the 16 MB embedding model, under the 25 MB per-file limit, and keeping it on the same origin avoids a cross-origin fetch under the isolation headers.
- **Deploys are manual for now.** A GitHub Action could deploy on every push; it needs a Cloudflare API token stored as a repository secret.
- **The policy allows inline styles**, because the components set style attributes.
