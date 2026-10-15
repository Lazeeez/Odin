import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

from odin.eval.dataset import Instance  # noqa: E402
from odin.eval.ground_truth import gold_for_instance  # noqa: E402
from odin.eval.metrics import aggregate, score  # noqa: E402
from odin.index.snapshot import _is_test_path  # noqa: E402
from odin.repos import RepoCache  # noqa: E402

PROJECTS = ROOT / "data" / "live" / "projects.json"
OUT = ROOT / "results" / "live"
RANKER = ROOT / "web" / "src" / "assets" / "ranker.json"
GOLD = ROOT / "data" / "gold"
API = "https://api.github.com"
MAX_PER_NIGHT = 80
WINDOW_DAYS = 7
ISSUE_CHARS = 1500
KS = (1, 5, 10)
CLOSING = re.compile(
    r"\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+(?:(?:https://github\.com/)?([\w.-]+/[\w.-]+)(?:/issues/|#)|#)(\d+)",
    re.IGNORECASE,
)


class RateLimited(Exception):
    pass


def github(path: str, accept: str = "application/vnd.github+json", attempts: int = 4):
    headers = {
        "Accept": accept,
        "User-Agent": "odin-live-eval",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if os.environ.get("GITHUB_TOKEN"):
        headers["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    url = path if path.startswith("http") else f"{API}{path}"
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=60
            ) as response:
                body = response.read()
                return body.decode("utf-8", "replace") if "diff" in accept else json.loads(body)
        except urllib.error.HTTPError as exc:
            if exc.code in (403, 429):
                if attempt + 1 == attempts:
                    raise RateLimited(url) from exc
                reset = int(exc.headers.get("X-RateLimit-Reset", "0") or 0)
                time.sleep(min(120, max(5, reset - time.time() + 1)) if reset else 30)
                continue
            if exc.code >= 500 and attempt + 1 < attempts:
                time.sleep(5 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"giving up on {url}")


def closed_issues(repo: str, body: str) -> set[int]:
    out = set()
    for other, number in CLOSING.findall(body or ""):
        if not other or other.lower() == repo.lower():
            out.add(int(number))
    return out


def scored_before() -> set[str]:
    seen = set()
    for path in sorted(OUT.glob("20*.jsonl")):
        for line in path.open(encoding="utf-8"):
            seen.add(json.loads(line)["id"])
    return seen


def candidates(until: date, days: int) -> list[dict]:
    since = until - timedelta(days=days)
    found = []
    for repo in json.loads(PROJECTS.read_text(encoding="utf-8"))["projects"]:
        q = urllib.parse.quote(
            f"repo:{repo} is:pr is:merged merged:{since.isoformat()}..{(until - timedelta(days=1)).isoformat()}"
        )
        try:
            result = github(f"/search/issues?q={q}&per_page=100&sort=updated")
        except urllib.error.HTTPError as exc:
            print(f"  {repo}: search failed ({exc.code})", flush=True)
            continue
        for pr in result.get("items", []):
            issues = closed_issues(repo, pr.get("body") or "")
            if len(issues) == 1:
                merged = (
                    (pr.get("pull_request") or {}).get("merged_at") or pr.get("closed_at") or ""
                )
                found.append(
                    {
                        "repo": repo,
                        "pr": pr["number"],
                        "issue": issues.pop(),
                        "pr_created": pr["created_at"],
                        "merged": merged,
                    }
                )
        time.sleep(2.5 if os.environ.get("GITHUB_TOKEN") else 6.5)
    return sorted(found, key=lambda c: (c["merged"], c["repo"], c["pr"]))


def instance(c: dict) -> tuple[Instance | None, dict]:
    repo, record = (
        c["repo"],
        {"id": f"{c['repo']}#{c['pr']}", "repo": c["repo"], "pr": c["pr"], "issue": c["issue"]},
    )
    issue = github(f"/repos/{repo}/issues/{c['issue']}")
    if issue.get("pull_request"):
        return None, {**record, "skipped": "the closed number is a pull request, not an issue"}
    if issue["created_at"] > c["pr_created"]:
        return None, {**record, "skipped": "issue opened after the pull request"}
    pr = github(f"/repos/{repo}/pulls/{c['pr']}")
    merge = pr.get("merge_commit_sha")
    if not merge:
        return None, {**record, "skipped": "no merge commit"}
    parent = github(f"/repos/{repo}/commits/{merge}")["parents"][0]["sha"]
    patch = github(
        f"/repos/{repo}/compare/{parent}...{merge}", accept="application/vnd.github.diff"
    )
    text = f"{issue['title']}\n\n{(issue.get('body') or '')[:ISSUE_CHARS]}"
    record |= {
        "issue_created": issue["created_at"], "merged": pr["merged_at"], "base_commit": parent, "merge_commit": merge,
        "labels": [label["name"] for label in issue.get("labels", [])], "issue_chars": len(issue.get("body") or ""),
    }  # fmt: skip
    inst = Instance(record["id"], repo, parent, patch, text, issue["created_at"])
    return inst, record


def trained_projects() -> set[str]:
    repos = set()
    for name in ("swebench_full_test.jsonl", "swebench_rebench_train.jsonl"):
        for line in (GOLD / name).open(encoding="utf-8"):
            repos.add(json.loads(line)["repo"].lower())
    return repos


class Site:
    def __init__(self) -> None:
        import browser_ltr as bl

        self.bl = bl
        self.ranker = json.loads(RANKER.read_text(encoding="utf-8"))
        self.sha = hashlib.sha256(RANKER.read_bytes()).hexdigest()
        self.snaps = bl.Snapshots()
        self.embed = bl.make_embedder()

    def predict(self, stage: str, X: np.ndarray) -> np.ndarray:
        from odin.rank.browser import predict

        return (
            np.array([predict(self.ranker[stage], x) for x in X], np.float64)
            if len(X)
            else np.zeros(0)
        )

    def rank(
        self, inst: Instance, targets: set[str], files: set[str]
    ) -> tuple[list[str], list[str], int]:
        from odin.rank.browser import extract

        bl = self.bl
        fn, M, names = self.snaps.get(inst.repo, inst.base_commit)
        lex, title_lex, code_lex, sem, tsem, m, _ = self.snaps.signals(
            fn, M, inst.problem_statement
        )
        it = bl.Item(
            inst.instance_id, inst.repo, inst.base_commit, inst.problem_statement, targets, files
        )
        it.rows_b, it.xb = extract(fn, lex, title_lex, code_lex, m, names, sem, tsem)
        it.ids = [fn.ids[r] for r in it.rows_b] if it.rows_b is not None else []
        if not it.ids:
            return [], [], len(fn.ids)
        s_b = self.predict("semantic", it.xb)
        bl.pass2([it], [s_b], self.snaps, self.embed, "live")
        if "rerank" in self.ranker and len(it.sel):
            ranked = bl.reranked(it, s_b, self.predict("rerank", it.xc))
        else:
            ranked = [it.ids[i] for i in bl.order(s_b)]
        ranked_files = (
            [it.fpaths[i] for i in bl.order(self.predict("file", it.xf))] if len(it.xf) else []
        )
        return ranked, ranked_files, len(fn.ids)

    def close(self) -> None:
        self.snaps.close()


def first_rank(ranked: list[str], gold: set[str]) -> int | None:
    return next((i + 1 for i, u in enumerate(ranked) if u in gold), None)


def run(until: date, days: int, limit: int) -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"{until.isoformat()}.jsonl"
    if target.exists():
        sys.exit(f"{target} exists")
    seen = scored_before()
    found = [c for c in candidates(until, days) if f"{c['repo']}#{c['pr']}" not in seen]
    print(f"{len(found)} new pull requests close exactly one issue", flush=True)
    trained = trained_projects()
    cache = RepoCache(ROOT / ".cache" / "repos")
    site = Site()
    scored = 0
    attempted = 0
    stopped = None
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for c in found:
            if scored >= limit or attempted >= 2 * limit:
                break
            attempted += 1
            try:
                inst, record = instance(c)
                if inst is not None:
                    gold = gold_for_instance(inst, cache)
                    targets = {
                        u
                        for u in gold.functions + gold.classes
                        if not _is_test_path(u.split("::")[0])
                    }
                    files = {f for f in gold.files if not _is_test_path(f)}
                    record |= {"gold_functions": sorted(targets), "gold_files": sorted(files)}
                    if not targets:
                        record["skipped"] = "the fix changes no function or class outside tests"
                    else:
                        ranked, ranked_files, units = site.rank(inst, targets, files)
                        record |= {
                            "units": units, "top10": ranked[:10], "top10_files": ranked_files[:10],
                            "first_rank": first_rank(ranked, targets), "file_first_rank": first_rank(ranked_files, files),
                            "trained_project": inst.repo.lower() in trained, "ranker_sha256": site.sha,
                        }  # fmt: skip
                        scored += 1
            except RateLimited as exc:
                stopped = f"GitHub's rate limit stopped the night at {exc}"
                break
            except Exception as exc:  # noqa: BLE001
                record = {"id": f"{c['repo']}#{c['pr']}", "repo": c["repo"], "pr": c["pr"], "issue": c["issue"],
                          "skipped": f"error: {type(exc).__name__}: {str(exc)[:200]}"}  # fmt: skip
            handle.write(json.dumps(record) + "\n")
            handle.flush()
            outcome = record.get("skipped") or f"first rank {record.get('first_rank')}"
            print(f"  {record['id']}: {outcome}", flush=True)
    site.close()
    print(f"wrote {target}: {scored} bugs scored{f'; {stopped}' if stopped else ''}")
    return 0


def interval(values: np.ndarray, n: int = 2000) -> list[float]:
    if not len(values):
        return [0.0, 0.0]
    rng = np.random.default_rng(0)
    means = values[rng.integers(0, len(values), (n, len(values)))].mean(axis=1)
    return [round(float(v), 4) for v in np.percentile(means, [2.5, 97.5])]


def summarize(records: list[dict]) -> dict:
    fn = [score(r["top10"], r["gold_functions"], KS) for r in records]
    files = [score(r["top10_files"], r["gold_files"], KS) for r in records if r["gold_files"]]
    out = {"bugs": len(records), "projects": len({r["repo"] for r in records})}
    if not records:
        return out
    hits = np.array([s.hit[10] for s in fn])
    out["function"] = {
        k: round(v, 4)
        for k, v in aggregate(fn, KS).items()
        if k in ("hit@10", "hit@1", "recall@10", "mrr")
    }
    out["function"]["hit@10_ci95"] = interval(hits)
    if files:
        out["file"] = {
            "hit@10": round(aggregate(files, KS)["hit@10"], 4),
            "hit@10_ci95": interval(np.array([s.hit[10] for s in files])),
        }
    out["merged"] = [min(r["merged"] for r in records)[:10], max(r["merged"] for r in records)[:10]]
    return out


def summary(publish: str | None) -> int:
    records = [
        json.loads(line)
        for path in sorted(OUT.glob("20*.jsonl"))
        for line in path.open(encoding="utf-8")
    ]
    scored = [r for r in records if "top10" in r]
    cutoff = (datetime.now(UTC) - timedelta(days=30)).isoformat()
    recent = [r for r in scored if r["merged"] >= cutoff]
    report = {
        "generated": datetime.now(UTC).isoformat(timespec="seconds"),
        "adr": "docs/decisions/0023-live-accuracy.md",
        "last_30_days": summarize(recent),
        "all_time": summarize(scored),
        "all_time_trained_projects": summarize([r for r in scored if r["trained_project"]]),
        "all_time_new_projects": summarize([r for r in scored if not r["trained_project"]]),
        "skipped": {k: sum(1 for r in records if (r.get("skipped") or "").split(":")[0] == k) for k in sorted({(r.get("skipped") or "").split(":")[0] for r in records if r.get("skipped")})},
    }  # fmt: skip
    (OUT / "summary.json").write_text(
        json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    print(json.dumps(report, indent=1))
    if publish:
        token = os.environ.get("LIVE_TOKEN", "")
        if not token:
            sys.exit("LIVE_TOKEN is not set")
        request = urllib.request.Request(
            publish, data=json.dumps(report).encode(), method="POST",
            headers={"Authorization": f"Bearer {token}", "content-type": "application/json", "User-Agent": "odin-live-eval"},
        )  # fmt: skip
        with urllib.request.urlopen(request, timeout=30) as response:
            print("published:", response.status)
    return 0


def main() -> int:
    global OUT
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["run", "summary"])
    ap.add_argument("--until", type=date.fromisoformat, default=datetime.now(UTC).date())
    ap.add_argument("--days", type=int, default=WINDOW_DAYS)
    ap.add_argument("--limit", type=int, default=MAX_PER_NIGHT)
    ap.add_argument("--publish")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args()
    OUT = args.out
    return run(args.until, args.days, args.limit) if args.step == "run" else summary(args.publish)


if __name__ == "__main__":
    sys.exit(main())
