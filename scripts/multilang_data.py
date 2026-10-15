import argparse
import collections
import csv
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.dataset import Instance  # noqa: E402
from odin.eval.goldpatch import parse_patch  # noqa: E402
from odin.eval.ground_truth import build_gold, write_gold  # noqa: E402
from odin.parsing import symbols as multi  # noqa: E402
from odin.repos import RepoCache  # noqa: E402

TRAIN = ("ByteDance-Seed/Multi-SWE-RL", "9777648932daa214ba18c70c81e85821b5836f32")
MULTILINGUAL = ("SWE-bench/SWE-bench_Multilingual", "846e647b9f33c0b51b739d005d13d85493c9af09")
POLYBENCH = ("AmazonScience/SWE-PolyBench_500", "546075b4b05d17ba914e72b8f4c6d5b1ea150c1d")
FOLDERS = ("data_20240601_20250331", "data_20250401_20250631")
PHASE1_FOLDERS = ("go", "java", "js", "rust", "ts")
POLYBENCH_LANGUAGES = {"Java", "JavaScript", "TypeScript"}
LANGUAGES = frozenset(
    {multi.JAVASCRIPT, multi.TYPESCRIPT, multi.TSX, multi.GO, multi.JAVA, multi.RUST}
)
FAMILY = {
    multi.JAVASCRIPT: "javascript",
    multi.TYPESCRIPT: "typescript",
    multi.TSX: "typescript",
    multi.GO: "go",
    multi.JAVA: "java",
    multi.RUST: "rust",
}

RAW = ROOT / ".cache" / "multilang"
GOLD = ROOT / "data" / "gold"
SPLITS = {
    "train": "multilang_train",
    "multilingual": "multilang_test_multilingual",
    "polybench": "multilang_test_polybench",
}

csv.field_size_limit(2**31 - 1)


def hf_url(dataset: tuple[str, str], path: str) -> str:
    return f"https://huggingface.co/datasets/{dataset[0]}/resolve/{dataset[1]}/{path}"


def hf_tree(dataset: tuple[str, str], folder: str) -> list[str]:
    url = f"https://huggingface.co/api/datasets/{dataset[0]}/tree/{dataset[1]}/{folder}"
    with urllib.request.urlopen(url, timeout=120) as r:
        return [
            f["path"] for f in json.load(r) if f["type"] == "file" and f["path"].endswith(".jsonl")
        ]


def family_of_patch(patch: str) -> str | None:
    counts = collections.Counter()
    for edit in parse_patch(patch):
        lang = multi.language_of(edit.path)
        if lang is not None:
            counts[FAMILY.get(lang, lang)] += 1
    return counts.most_common(1)[0][0] if counts else None


def problem_text(record: dict) -> str:
    issues = record.get("resolved_issues") or []
    parts = [f"{i.get('title') or ''}\n\n{i.get('body') or ''}".strip() for i in issues]
    return (
        "\n\n".join(p for p in parts if p)
        or f"{record.get('title') or ''}\n\n{record.get('body') or ''}".strip()
    )


def test_sets() -> dict[str, list[dict]]:
    import pyarrow.parquet as pq
    from huggingface_hub import hf_hub_download

    multilingual = []
    path = hf_hub_download(
        MULTILINGUAL[0],
        "data/test-00000-of-00001.parquet",
        repo_type="dataset",
        revision=MULTILINGUAL[1],
    )
    for r in pq.read_table(path).to_pylist():
        family = family_of_patch(r["patch"])
        if family in FAMILY.values():
            multilingual.append({"instance_id": r["instance_id"], "repo": r["repo"], "base_commit": r["base_commit"], "patch": r["patch"],
                                 "problem_statement": r["problem_statement"], "created_at": r["created_at"], "language": family})  # fmt: skip
    polybench = []
    path = hf_hub_download(POLYBENCH[0], "test.csv", repo_type="dataset", revision=POLYBENCH[1])
    with open(path, encoding="utf-8") as handle:
        for r in csv.DictReader(handle):
            if r["language"] in POLYBENCH_LANGUAGES:
                polybench.append({"instance_id": r["instance_id"], "repo": r["repo"], "base_commit": r["base_commit"], "patch": r["patch"],
                                  "problem_statement": r["problem_statement"], "created_at": r["created_at"], "language": r["language"].lower()})  # fmt: skip
    return {"multilingual": multilingual, "polybench": polybench}


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")


def fetch() -> int:
    tests = test_sets()
    held_out = {r["repo"].lower() for rows in tests.values() for r in rows}
    train, dropped = [], collections.Counter()
    parts = RAW / "parts"
    parts.mkdir(parents=True, exist_ok=True)
    for folder in FOLDERS:
        for sub in PHASE1_FOLDERS:
            for path in hf_tree(TRAIN, f"{folder}/{sub}"):
                part = parts / path.replace("/", "__")
                repo_name = (
                    path.rsplit("/", 1)[-1].removesuffix("_dataset.jsonl").replace("__", "/", 1)
                )
                if repo_name.lower() in held_out:
                    dropped[repo_name] += 1
                    continue
                if not part.exists():
                    rows = []
                    with urllib.request.urlopen(hf_url(TRAIN, path), timeout=600) as response:
                        for line in response:
                            r = json.loads(line)
                            repo = f"{r['org']}/{r['repo']}"
                            if repo.lower() in held_out:
                                continue
                            family = family_of_patch(r.get("fix_patch") or "")
                            if family is None or not (r.get("base") or {}).get("sha"):
                                continue
                            instance_id = (
                                r.get("instance_id") or f"{r['org']}__{r['repo']}-{r['number']}"
                            )
                            rows.append({"instance_id": instance_id, "repo": repo, "base_commit": r["base"]["sha"], "patch": r["fix_patch"],
                                         "problem_statement": problem_text(r), "created_at": r.get("created_at", ""), "language": family})  # fmt: skip
                    write_jsonl(part.with_suffix(".tmp"), rows)
                    part.with_suffix(".tmp").replace(part)
                train += [json.loads(line) for line in part.open(encoding="utf-8")]
                print(f"  {path}: {len(train)} so far", flush=True)
    seen, unique = set(), []
    for r in train:
        if r["instance_id"] not in seen:
            seen.add(r["instance_id"])
            unique.append(r)
    write_jsonl(RAW / "train.jsonl", unique)
    for name, rows in tests.items():
        write_jsonl(RAW / f"{name}.jsonl", rows)
    report = {
        "revisions": {d[0]: d[1] for d in (TRAIN, MULTILINGUAL, POLYBENCH)},
        "train": {"issues": len(unique), "projects": len({r["repo"] for r in unique}), "by_language": collections.Counter(r["language"] for r in unique)},
        "train_dropped_for_test_overlap": dict(dropped),
        **{name: {"issues": len(rows), "projects": len({r["repo"] for r in rows}), "by_language": collections.Counter(r["language"] for r in rows)} for name, rows in tests.items()},
    }  # fmt: skip
    (GOLD.parent / "multilang").mkdir(parents=True, exist_ok=True)
    (GOLD.parent / "multilang" / "manifest.json").write_text(
        json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    print(json.dumps(report, indent=1))
    return 0


def instances(split: str) -> list[Instance]:
    rows = [json.loads(line) for line in (RAW / f"{split}.jsonl").open(encoding="utf-8")]
    return [
        Instance(
            r["instance_id"],
            r["repo"],
            r["base_commit"],
            r["patch"],
            r["problem_statement"],
            r.get("created_at", ""),
        )
        for r in rows
    ]


def gold(split: str, workers: int) -> int:
    entries = build_gold(
        instances(split), RepoCache(ROOT / ".cache" / "repos"), workers=workers, languages=LANGUAGES
    )
    target = GOLD / f"{SPLITS[split]}.jsonl"
    write_gold(entries, target)
    usable = sum(1 for e in entries if e.functions or e.classes)
    errors = sum(1 for e in entries if e.errors)
    print(
        f"wrote {target}: {len(entries)} issues, {usable} with a function or class to find, {errors} with errors"
    )
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["fetch", "gold"])
    ap.add_argument("--split", choices=list(SPLITS), default="train")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    return fetch() if args.step == "fetch" else gold(args.split, args.workers)


if __name__ == "__main__":
    sys.exit(main())
