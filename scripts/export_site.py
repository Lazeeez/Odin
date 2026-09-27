"""Export evaluation results and a code corpus as static JSON for the showcase site.

    uv run python scripts/export_site.py

Reads `results/*_lite_test.json` (written by `odin eval`) and writes `web/public/data/*.json`.
The site is static: it replays these results, and its live search downloads and indexes
repositories in the visitor's browser, so it can be hosted anywhere without a server.
"""

from __future__ import annotations

import json
from pathlib import Path

from odin.eval.dataset import load_instances
from odin.eval.metrics import metric_values, paired_bootstrap, score

RESULTS = Path("results")
OUT = Path("web/public/data")

# The ladder the site walks through, in order, with a sentence on what each step adds.
STAGES = [
    ("bm25-naive", "BM25, naive tokens", "Plain keyword search: `get_queryset` is one opaque word."),
    ("bm25-code-notests", "BM25, code-aware", "Split identifiers (snake_case, camelCase) and skip test files."),
    ("hybrid-notests", "Hybrid", "Fuse BM25 with a code embedding model (jina-code-0.5b)."),
    ("ltr-notests", "Learning to rank", "LambdaMART over 42 signals: mentions, tracebacks, git history, past fixes."),
    ("ltr-ce-notests", "+ LLM reranker", "A fine-tuned Qwen3 cross-encoder reads the issue and code together."),
]  # fmt: skip


def load(name: str, level: str) -> dict | None:
    path = RESULTS / f"{name}_{level}_lite_test.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def summaries() -> dict:
    out: dict = {"stages": [], "significance": {}}
    for level in ("function", "file"):
        runs = {n: load(n, level) for n, _, _ in STAGES}
        prev = None
        for name, label, blurb in STAGES:
            run = runs[name]
            if run is None:
                continue
            s = run["summary"]
            keys = ["recall@1", "recall@5", "recall@10", "hit@1", "hit@5", "hit@10", "mrr"]
            entry = {"level": level, "id": name, "label": label, "blurb": blurb}
            entry |= {k: s[k] for k in keys} | {"ci95": s.get("ci95", {}), "n": s["n"]}
            entry["latency_ms_p50"] = s.get("latency_ms_p50")
            entry["by_repo"] = {
                r: {"n": v["n"], "recall@10": v["recall@10"], "mrr": v["mrr"]}
                for r, v in s["by_repo"].items()
            }
            out["stages"].append(entry)
            if prev is not None:
                out["significance"][f"{level}:{prev}->{name}"] = compare(runs[prev], run)
            prev = name
    return out


def compare(a: dict, b: dict) -> dict:
    rows = [{r["instance_id"]: r for r in run["per_instance"]} for run in (a, b)]
    common = sorted(rows[0].keys() & rows[1].keys())
    res = {}
    for metric in ("recall@1", "recall@10", "mrr"):
        vals = [
            metric_values(
                [score(rows[i][q]["ranked"], rows[i][q]["gold"], [1, 5, 10]) for q in common],
                metric,
            )
            for i in (0, 1)
        ]
        d = paired_bootstrap(vals[0], vals[1])
        res[metric] = {
            "delta": d.delta,
            "ci95": list(d.ci95),
            "p": d.p_value,
            "wins": d.wins,
            "losses": d.losses,
        }
    return res


def issues() -> list[dict]:
    text = {i.instance_id: i.problem_statement for i in load_instances("lite", "test")}
    fn_runs = {n: load(n, "function") for n, _, _ in STAGES}
    file_runs = {n: load(n, "file") for n in ("hybrid-notests", "ltr-ce-notests")}
    per = {
        n: {r["instance_id"]: r for r in run["per_instance"]} for n, run in fn_runs.items() if run
    }
    per_file = {
        n: {r["instance_id"]: r for r in run["per_instance"]} for n, run in file_runs.items() if run
    }
    ids = sorted(set().union(*[p.keys() for p in per_file.values()]))
    out = []
    for iid in ids:
        any_file = next(p[iid] for p in per_file.values() if iid in p)
        item = {
            "id": iid,
            "repo": any_file["repo"],
            "text": text[iid][:2400] + ("\n…" if len(text[iid]) > 2400 else ""),
            "gold_files": any_file["gold"],
            "gold_functions": [],
            "functions": {},
            "files": {n: p[iid]["ranked"][:10] for n, p in per_file.items() if iid in p},
        }
        for name, p in per.items():
            if iid in p:
                item["gold_functions"] = p[iid]["gold"]
                item["functions"][name] = p[iid]["ranked"][:10]
        out.append(item)
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    def write(name: str, obj) -> None:
        path = OUT / name
        path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {path} ({path.stat().st_size / 1024:.0f} KB)")

    summary = summaries()
    write("summary.json", summary)

    # The explorer loads a small index up front (id, title, outcome flags for filtering) and
    # each issue's full rankings only when opened: ~11 KB gzipped instead of ~250 KB.
    items = issues()
    final = [s["id"] for s in summary["stages"] if s["level"] == "function"][-1]
    per_issue = OUT / "issues"
    per_issue.mkdir(exist_ok=True)
    for old in per_issue.glob("*.json"):
        old.unlink()
    (OUT / "issues.json").unlink(missing_ok=True)
    index = []
    for it in items:
        gold = set(it["gold_functions"])
        final_rank = first_rank(it["functions"].get(final, []), gold)
        base_rank = first_rank(it["functions"].get("bm25-naive", []), gold)
        title = next((line for line in it["text"].splitlines() if line.strip()), it["id"])
        index.append({
            "id": it["id"], "repo": it["repo"], "title": title[:200],
            "rescued": bool(gold) and final_rank is not None and base_rank is None,
            "first": bool(gold) and final_rank == 1,
            "missed": bool(gold) and final_rank is None,
        })  # fmt: skip
        (per_issue / f"{it['id']}.json").write_text(
            json.dumps(it, separators=(",", ":")), encoding="utf-8"
        )
    write("issues/index.json", index)
    print(f"wrote {len(items)} per-issue files to {per_issue}")


def first_rank(ranked: list[str], gold: set[str]) -> int | None:
    return next((i + 1 for i, x in enumerate(ranked) if x in gold), None)


if __name__ == "__main__":
    main()
