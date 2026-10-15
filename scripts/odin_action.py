import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

RANKER = ROOT / "web" / "src" / "assets" / "ranker.json"
API = "https://api.github.com"
SITE = "https://allfather.dev"
MARK = "<!-- odin-action -->"
ISSUE_CHARS = 4000


def github(path: str, token: str, method: str = "GET", body: dict | None = None):
    request = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "odin-action",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read() or b"null")


def rank(repo: str, sha: str, text: str, top: int) -> tuple[list[str], list[str], int]:
    import browser_ltr as bl

    from odin.rank.browser import extract, predict_many

    ranker = json.loads(RANKER.read_text(encoding="utf-8"))
    bl.MULTILANG = bool(ranker["meta"].get("multilang"))
    snaps = bl.Snapshots()
    try:
        fn, M, names = snaps.get(repo, sha)
        lex, title_lex, code_lex, sem, tsem, m, _ = snaps.signals(fn, M, text)
        rows, X = extract(fn, lex, title_lex, code_lex, m, names, sem, tsem)
        if rows is None or not len(rows):
            return [], [], len(fn.ids)
        ranked = [fn.ids[rows[i]] for i in bl.order(predict_many(ranker["semantic"], X))]
    finally:
        snaps.close()
    files = list(dict.fromkeys(u.split("::", 1)[0] for u in ranked))
    return ranked[:top], files[:top], len(fn.ids)


def comment(
    repo: str, sha: str, issue_text: str, functions: list[str], files: list[str], units: int
) -> str:
    blob = f"https://github.com/{repo}/blob/{sha}"
    lines = [
        MARK,
        f"**Odin** searched {units:,} functions in `{repo}` at `{sha[:7]}` for this issue. Most likely places to change:",
        "",
        "| # | Function | File |",
        "|---|---|---|",
    ]
    for i, unit in enumerate(functions, 1):
        path, name = unit.split("::", 1)
        lines.append(f"| {i} | `{name}` | [{path}]({blob}/{urllib.parse.quote(path)}) |")
    lines += [
        "",
        "Files: " + ", ".join(f"[`{f}`]({blob}/{urllib.parse.quote(f)})" for f in files),
        "",
    ]
    query = urllib.parse.urlencode({"repo": repo, "q": issue_text[:500]})
    lines.append(
        f"<sub>Ranked by the same models as [allfather.dev]({SITE}) (keywords, what the issue names, and meaning; no GPU), "
        f"[open this search there]({SITE}/#/search?{query}) to see why each ranks where it does. "
        "Odin only reads public code; nothing about this issue is stored.</sub>"
    )
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True)
    ap.add_argument("--issue", type=int)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--text")
    ap.add_argument("--top", type=int, default=int(os.environ.get("ODIN_TOP", "5")))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    token = os.environ.get("GITHUB_TOKEN", "")
    if args.text is None:
        if not args.issue or not token:
            sys.exit("give --text, or --issue with GITHUB_TOKEN set")
        issue = github(f"/repos/{args.repo}/issues/{args.issue}", token)
        if issue.get("pull_request"):
            print("a pull request, not an issue: nothing to do")
            return 0
        args.text = f"{issue['title']}\n\n{(issue.get('body') or '')[:ISSUE_CHARS]}"
    functions, files, units = rank(args.repo, args.sha, args.text, args.top)
    if not functions:
        print("no functions to rank in this repository")
        return 0
    body = comment(args.repo, args.sha, args.text, functions, files, units)
    if args.dry_run or not args.issue:
        print(body)
        return 0
    existing = github(f"/repos/{args.repo}/issues/{args.issue}/comments?per_page=100", token)
    mine = next((c for c in existing if MARK in (c.get("body") or "")), None)
    if mine:
        github(f"/repos/{args.repo}/issues/comments/{mine['id']}", token, "PATCH", {"body": body})
    else:
        github(f"/repos/{args.repo}/issues/{args.issue}/comments", token, "POST", {"body": body})
    print(f"commented on {args.repo}#{args.issue}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
