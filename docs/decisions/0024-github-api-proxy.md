# 0024: GitHub API calls through the site's Worker

## Status

Accepted, 2026-10-15.

## Context

Repositories load through the archive relay without touching GitHub's API ([ADR 0012](0012-archive-file-list.md)), but four features still call it from the visitor's browser: importing an issue from a pasted link, listing a repository's open issues, the "file last changed" line under a result (fetched for the first result of every search), and the file listing when the relay is down. GitHub allows 60 anonymous API requests an hour per network. A visitor who works through 20 to 30 issues uses about two requests per search and runs out within the hour; a shared office or campus network runs out sooner.

## Decision

The Worker answers `/gh/<GitHub API path>` with a GitHub token held as a Worker secret (`GITHUB_TOKEN`: a fine-grained token with read-only access to public repositories and no permissions), which raises the limit to 5,000 requests an hour, and caches answers at the edge: an issue or an issue list for 10 minutes, a file's last commit and a file listing for an hour (five minutes for the default branch's listing).

- **Only four request shapes are forwarded**, each with a fixed set of query parameters (`proxy/github.js`); anything else is refused. The token never reaches the browser, and GitHub's cookies and other headers are not passed back.
- **Same guards as the rest of the Worker:** only the site's own pages, GET only, and the per-IP rate limit.
- **The page falls back to calling GitHub directly** when the proxy has no token (it answers 501, and the page stops asking it), is unreachable, or is overloaded. A build without `VITE_GITHUB_PROXY` never uses it.

## Consequences

- Visitors share the token's 5,000 requests an hour, and repeated lookups (the same issue, the same file) are served from the edge cache without using it.
- The token's owner is accountable for its use; it can be revoked at any time, after which the site falls back to direct calls.
- The token has no permissions beyond reading public data, so leaking it would expose nothing private.
