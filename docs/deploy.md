# Hosting on allfather.dev

Odin's website and its archive relay run as one Cloudflare Worker: static files from `web/dist`, and the relay at `/relay/*` on the same origin. The configuration is `deploy/cloudflare/wrangler.jsonc`.

## Status, 2026-10-14

| Piece | State |
|---|---|
| The Worker `odin` (site and relay) | deployed and working at https://odin.lajat69.workers.dev |
| `allfather.dev` pointing at it | **blocked**: the domain is not a zone in the Cloudflare account wrangler is logged in to (`lajat69@gmail.com`). See "Attaching the domain" |
| GitHub Pages site and the old `workers.dev` relay | untouched, still serving |
| Redirect from GitHub Pages | prepared in `deploy/github-pages-redirect/`, not published |

## Deploying

```sh
cd web
npm ci --ignore-scripts
VITE_ARCHIVE_PROXY=/relay npm run build
cd ../deploy/cloudflare
npx wrangler deploy
```

In Git Bash on Windows, prefix the build with `MSYS_NO_PATHCONV=1`: without it the shell rewrites `/relay` into a Windows path and the site silently falls back to GitHub's API.

The build writes `dist/_headers` (content security policy, cross-origin isolation, caching of hashed assets). Cloudflare applies it to every static response.

## Attaching the domain

`allfather.dev` uses Cloudflare's nameservers, so it is a zone in some Cloudflare account, but not the one wrangler deploys to. Either:

- **log wrangler in to the account that holds the domain** (`npx wrangler login`), then run the deploy again: `wrangler.jsonc` already asks for `allfather.dev` as a custom domain, and Cloudflare creates the DNS record itself; or
- **move the domain** into the `lajat69@gmail.com` account, then deploy again.

Until one of those is done, every deploy prints an error about the zone after uploading. The upload itself succeeds and the `workers.dev` address is updated.

## Checks after the domain is attached

- `https://allfather.dev/` loads, and the browser console shows no "Refused to" lines.
- Loading `django/django` makes one request to `/relay/django/django/HEAD` and none to `api.github.com` for the file list.
- `https://allfather.dev/#/explore` opens directly.
- A search that reaches the "rerank" stage completes. It downloads a model from Hugging Face and a library from jsDelivr; the policy allows both, but the full path has not been exercised under it.
- `curl -s -o /dev/null -w "%{http_code}" https://allfather.dev/relay/psf/requests/HEAD` prints `403`: the relay answers only the site's own pages.

## Then: retire GitHub Pages

Only after the checks pass.

1. In `.github/workflows/pages.yml`, publish `deploy/github-pages-redirect` instead of `web/dist` (change the `path` of the upload step and drop the two build steps).
2. Push and open an old link with a route in it: `https://lazeeez.github.io/Odin/#/explore` should land on `https://allfather.dev/#/explore`.
3. Remove the repository variable `ARCHIVE_PROXY` and delete the `odin-archive-relay` Worker.
4. Set `"workers_dev": false` in `deploy/cloudflare/wrangler.jsonc`, remove `https://*.workers.dev` from `CONNECT` in `web/vite.config.ts`, and update the site URL in `README.md`, `CITATION.cff` and `web/index.html`.

## What has been tested

| Check | How | Result |
|---|---|---|
| The site under the generated headers | end-to-end suite in Chromium and WebKit against the build served with its `_headers` (`WITH_HEADERS=1 npm run e2e`) | passes |
| The deployed Worker | a headless browser on the `workers.dev` address: home page, search on `psf/requests`, Explore | works; no policy violations; cross-origin isolated |
| The same-origin relay, deployed | the same session: `psf/requests` loads with one relay request and no GitHub API request | works |
| The relay refuses other callers | `curl` without browser headers | 403 |
| The relay's routing and allowlist | `web/test/relay.test.ts` | passes |
| `allfather.dev` itself | needs the domain attached | not tested |
| The rerank stage under the policy | needs a manual session | not tested |

## Decisions

- **One Worker, not Pages plus a Worker.** Cloudflare now steers new static sites to Workers with static assets, and one deployment keeps the site and the relay on one origin with one command.
- **The bare domain, not a subdomain**, by the owner's choice.
- **No R2 bucket.** The largest file is the 16 MB embedding model, under the 25 MB per-file limit, and keeping it on the same origin avoids a cross-origin fetch under the isolation headers.
- **Deploys are manual for now.** A GitHub Action could deploy on every push; it needs a Cloudflare API token stored as a repository secret.
- **The policy allows inline styles**, because the components set style attributes.
