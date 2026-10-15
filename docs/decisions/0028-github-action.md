# 0028: Odin as a GitHub Action

## Status

Accepted, 2026-10-16.

## Context

PLAN.md's phase 8 asks for Odin where bugs are reported, not only on its website. A GitHub App would need a server that receives webhooks, an app registration and its keys. A GitHub Action runs in the repository that installs it, on GitHub's runners, with the token the workflow already has, and costs Odin nothing.

## Decision

- **`action.yml` at the repository root**, used as `uses: Lazeeez/Odin@main` from a workflow that runs when an issue is opened. It installs Odin's base dependencies with uv (no PyTorch), ranks the repository at the default branch's latest commit, and comments the top five functions with links, the files they are in, and a link that opens the same search on allfather.dev. A second run on the same issue edits its comment instead of adding one.
- **The ranking is the website's, minus what needs a GPU or a second model:** the shipped `ranker.json` (all six languages), its semantic stage over keywords, what the issue names and the static embeddings, run by the Python twin of the site's engine that the parity tests hold to the browser value for value. Files are listed in the order of their best function, because the website's file ranker needs the browser's language-model stage; on the 30 unseen projects the two orders differ by under a point of file hit@10 (94.2% against 93.7%, [lite.json](../../web/public/data/lite.json)).
- **Public repositories only** for now: the snapshot is cloned from GitHub without credentials. The issue text is sent nowhere; the comment links to allfather.dev with the issue's first 500 characters in the address, which the visitor chooses to open.
- **This repository runs it on its own issues** (`.github/workflows/odin-issue.yml`, `uses: ./`), which is also its end-to-end test.
- PLAN.md's "Action ranker" (website features plus git history, scored once on the 30 unseen projects) remains a separate decision; until then the Action uses the website's ranker, as recorded on 2026-10-13.
