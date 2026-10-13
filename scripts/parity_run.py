import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.provenance import provenance  # noqa: E402
from odin.index.chunker import MODULE, chunk_file  # noqa: E402
from odin.index.snapshot import _is_test_path  # noqa: E402
from odin.repos import RepoCache  # noqa: E402
from odin.search.bm25 import BM25Index, Vocab, top_k  # noqa: E402
from odin.search.tokenize import code_counts  # noqa: E402

PINNED = {
    "django/django": "4a72da71001f154ea60906a2f74898d32b7322a7",
    "sympy/sympy": "d3b4158dea271485e3daa11bf82e69b8dab348ce",
    "psf/requests": "a0df2cbb10419037d11d04352b3175405ab52941",
}
QUERIES_PER_REPO = 20
TOP = 10
SCORE_TOLERANCE = 1e-5
ISSUE_INDEX = ROOT / "web" / "public" / "data" / "issues" / "index.json"
DEFAULT_OUT = ROOT / "results" / "parity_pinned.json"


def node() -> str:
    found = os.environ.get("ODIN_NODE") or shutil.which("node")
    if not found or not (ROOT / "web" / "node_modules" / "web-tree-sitter").exists():
        sys.exit("needs Node 24 on PATH (or ODIN_NODE) and `npm ci` in web/")
    return found


def run_node(script: str, stdin: str) -> object:
    done = subprocess.run(
        [node(), str(ROOT / "tests" / "js" / script)],
        input=stdin,
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    )
    return json.loads(done.stdout)


def python_units(data: bytes, path: str) -> list[dict]:
    return [
        {"qualname": c.qualname, "kind": c.kind, "line": c.start_line, "text": c.text}
        for c in chunk_file(data, path)
        if c.kind != MODULE
    ]


def path_text(path: str) -> str:
    return " ".join(re.split(r"[/._-]+", path.removesuffix(".py")))


def python_ranking(units: list[dict], queries: list[str]) -> list[list[tuple[str, float]]]:
    vocab = Vocab()
    docs = [
        vocab.vectorize(code_counts(f"{u['qualname']}\n{u['text']}\n{path_text(u['path'])}"))
        for u in units
    ]
    index = BM25Index.from_docs(docs, len(vocab))
    ids = [f"{u['path']}::{u['qualname']}" for u in units]
    ranked = []
    for query in queries:
        scores = index.scores(vocab.lookup(code_counts(query)))
        ranked.append([(ids[i], float(scores[i])) for i in top_k(scores, TOP) if scores[i] > 0])
    return ranked


def compare_repo(cache: RepoCache, repo: str, commit: str, queries: list[str], work: Path) -> dict:
    entries = [e for e in cache.list_tree(repo, commit, ".py") if not _is_test_path(e.path)]
    cache.fetch_blobs(repo, cache.missing_blobs(repo, [e.oid for e in entries]))
    folder = work / repo.replace("/", "__")
    local: dict[str, str] = {}
    python: dict[str, list[dict]] = {}
    with cache.blob_reader(repo) as reader:
        for entry in entries:
            data = reader.read(entry.oid)
            target = folder / entry.path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            local[entry.path] = str(target)
            python[entry.path] = python_units(data, entry.path)

    javascript = run_node("chunk_files.mjs", "\n".join(local.values()))
    differing = sorted(path for path in local if javascript[local[path]] != python[path])

    units = [
        {"path": path, **unit}
        for path in sorted(python)
        for unit in python[path]
        if unit["text"].strip()
    ]
    js_ranked = run_node("bm25_rank.mjs", json.dumps({"units": units, "queries": queries}))
    py_ranked = python_ranking(units, queries)
    order_differs = 0
    tied_at_cutoff = 0
    worst = 0.0
    for got, want in zip(js_ranked, py_ranked, strict=True):
        if len(got) != len(want):
            order_differs += 1
            continue
        if not want:
            continue
        js_scores = np.array([g[1] for g in got])
        py_scores = np.array([w[1] for w in want])
        relative = np.abs(js_scores - py_scores) / np.abs(py_scores)
        worst = max(worst, float(np.max(relative)))
        moved = [i for i, (g, w) in enumerate(zip(got, want, strict=True)) if g[0] != w[0]]
        if not moved:
            continue
        order_differs += 1
        cutoff = py_scores[-1]
        same_scores = bool(np.all(relative <= SCORE_TOLERANCE))
        all_at_cutoff = all(abs(py_scores[i] - cutoff) <= SCORE_TOLERANCE * cutoff for i in moved)
        if same_scores and all_at_cutoff:
            tied_at_cutoff += 1
    return {
        "commit": commit,
        "files": len(local),
        "units": sum(len(u) for u in python.values()),
        "files_with_different_units": len(differing),
        "first_differing_files": differing[:10],
        "queries": len(queries),
        "queries_with_different_top10": order_differs,
        "of_which_only_ties_at_the_cutoff": tied_at_cutoff,
        "largest_relative_score_difference": worst,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path, default=ROOT / ".cache" / "repos")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    if not args.check and args.out.exists():
        sys.exit(f"{args.out} exists; results are never overwritten, pass --out or --check")

    titles: dict[str, list[str]] = {}
    for issue in json.loads(ISSUE_INDEX.read_text(encoding="utf-8")):
        titles.setdefault(issue["repo"], []).append(issue["title"])

    cache = RepoCache(args.cache)
    with tempfile.TemporaryDirectory() as work:
        repos = {
            repo: compare_repo(cache, repo, commit, titles[repo][:QUERIES_PER_REPO], Path(work))
            for repo, commit in PINNED.items()
        }
    totals = {
        key: sum(r[key] for r in repos.values())
        for key in (
            "files",
            "units",
            "files_with_different_units",
            "queries",
            "queries_with_different_top10",
            "of_which_only_ties_at_the_cutoff",
        )
    }
    totals["largest_relative_score_difference"] = max(
        r["largest_relative_score_difference"] for r in repos.values()
    )
    passed = (
        totals["files_with_different_units"] == 0
        and totals["queries_with_different_top10"] == totals["of_which_only_ties_at_the_cutoff"]
        and totals["largest_relative_score_difference"] <= SCORE_TOLERANCE
    )
    if args.check:
        recorded = json.loads(DEFAULT_OUT.read_text(encoding="utf-8"))["totals"]
        counts = [key for key in totals if key != "largest_relative_score_difference"]
        drifted = [key for key in counts if totals[key] != recorded[key]]
        print(json.dumps({"passed": passed, "differs_from_recorded": drifted, **totals}, indent=2))
        return 0 if passed and not drifted else 1
    report = {
        "what": "the website's TypeScript chunker and BM25 against the Python engine",
        "passes_when": (
            "every file chunks identically, scores agree within the tolerance, and a top 10 differs "
            "only in which of several units tied exactly at the cut-off score were kept"
        ),
        "score_tolerance": SCORE_TOLERANCE,
        "passed": passed,
        "totals": totals,
        "repos": repos,
        "provenance": provenance(),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"passed": passed, **totals}, indent=2))
    print(f"wrote {args.out}")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
