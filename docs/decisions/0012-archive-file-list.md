# 0012: Take the file list from the archive, not from GitHub's API

## Status

Accepted, 2026-10-13. Changes the loading path of [ADR 0011](0011-website-at-scale.md).

## Context

Loading a repository on the website made two or three calls to GitHub's API before downloading anything: one for the repository's default branch, one for the commit, one for the recursive file tree. The tree told the loader which Python files exist, so it could apply its limits (6,000 files, 60 MB, docs, examples and vendored code last) and report progress as "n of m files". The contents then came from one archive download through the relay.

GitHub's API allows 60 requests an hour per address without a token. A visitor behind a shared address (a university, an office, a phone carrier) can be out of budget before the first search, and a visitor who tries ten repositories uses half of it. The October 2026 audit listed this as the website's main reliability risk.

## Decision

When the relay is configured, the loader reads everything from the archive and makes no API call.

- **The commit comes from the archive.** A GitHub archive starts with a pax header whose comment is the commit hash. The loader reads it from the first 512-byte block.
- **The cache is keyed by that commit.** If the browser already holds the parsed units for this commit, scope and test setting, the loader stops reading after the first block and cancels the download.
- **The branch is resolved by trying.** A link such as `owner/repo/tree/a/b/c` is ambiguous between a branch named `a/b` and a folder. The loader asks the relay for each candidate, shortest branch name first, and a 404 moves to the next. With no branch in the link it asks for `HEAD`, which the relay resolves to the default branch.
- **Limits are applied in one pass.** The file list is not known in advance, so files are parsed as they arrive. Files in low-priority places (docs, examples, vendored code) are held in memory, up to the byte limit, and admitted at the end in path order if room is left. Core files are admitted in archive order until a limit is reached.
- **A truncated archive is an error, not a short repository.** The reader requires the end-of-archive marker. Without it the load falls back to the API path.
- **Progress has no total.** The page shows the number of files parsed so far, and the rune ring runs as an indeterminate chase.
- **The API path stays** as the fallback: when no relay is configured, when the relay fails, and when the archive holds no eligible file.

## Consequences

- With the relay on, loading Django, Transformers and a folder link into Flask made zero requests to `api.github.com` (checked by recording the page's network requests on the production build).
- The website now depends on the relay for its rate-limit behaviour. If the relay is down, the old path and its 60-an-hour limit are what remain.
- When a repository exceeds the limits, core files are kept in the order the archive lists them, which is git's tree order. The API path kept them in string order of their paths. The two orders differ only where a file and a folder share a name prefix, so the kept set can differ by a few files on a repository that is over the limits.
- A cached repository is recognised only after the request for the archive has started, so a cache hit still costs one request to the relay. The API path needed GitHub's API for the same check unless it held a recent file listing.
- Load time was not the goal and is not claimed to have changed. Phase 2 measures it.

## Tests

`web/test/engine.test.ts`: the commit is read from the pax header; reading stops when the caller declines the commit; a truncated archive raises; the archive path makes no API call and falls back when the relay fails; the cache is hit by commit. The end-to-end suite runs without a relay and so covers the API path, which is now the fallback.
