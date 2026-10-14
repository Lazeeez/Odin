# 0022: Counting searches and asking "right place?" on the website

## Status

Accepted, 2026-10-15.

## Context

Every accuracy number Odin reports comes from benchmarks: SWE-bench, SWE-rebench and the sealed holdout. None says whether the website helps the people who use it, on the repositories they bring. Nothing on the site was recorded beyond Cloudflare Web Analytics page views, which do not see a search.

The owner's constraints: no running cost, and a site that stays fast and needs no account.

## Decision

The Worker that serves the site gets three endpoints, backed by a Cloudflare D1 database on the free plan (`deploy/cloudflare/schema.sql`):

| Endpoint | When the site calls it | What is stored |
|---|---|---|
| `POST /api/search` | once a query's results have settled for four seconds | day, repository, how the query was entered (typed, example, GitHub issue, shared link); one counter per day, repository and kind |
| `POST /api/vote` | the visitor presses 👍 or 👎 on one of the top ten results | day, repository, commit, the rated function's id, its rank, the vote, the ranking stage, the GitHub issue's URL if the query came from one, and a random id for the query (so votes on one query can be grouped) |
| `GET /api/stats` | the home page | totals: searches, repositories, first day, votes up and down |

**Never stored:** the bug report's text, IP addresses, cookies, or anything that links two queries to one person. The query id is generated per query in the browser and is not kept by it. A typed bug report can be private; an issue link is public by definition, so it is the only description kept.

**Guards:** the endpoints answer only the site's own pages (the relay's origin check), validate every field against a fixed shape and length, accept bodies up to 2 KB, and are rate-limited per IP (30 a minute, Cloudflare's rate-limiting binding; the IP is not stored). A browser sending Global Privacy Control or Do Not Track is not counted; votes are explicit and are always sent.

**What the site shows:** the home page shows the totals once there are at least 100 searches, and the share of rated results marked right once at least 30 have been rated. The search page says what is recorded, next to the buttons.

## Consequences

- Votes are not a benchmark. Visitors choose what to search and what to rate, and someone who finds the right function may not vote. The share marked right is reported as feedback, never next to benchmark accuracy and never as accuracy.
- A vote with an issue link is a labelled example (public issue, function, verdict). If enough accumulate, using them for training is its own decision, with its own ADR and a check that none overlaps an evaluation set.
- The site now writes to a server, so "no server of ours is involved" was removed from the search page. The search itself still runs entirely in the browser.
- A build without `VITE_API` sends nothing and shows no buttons, so local development and the end-to-end tests are unchanged.
