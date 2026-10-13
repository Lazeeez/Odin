import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.ground_truth import read_gold  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.eval.runner import Query, gold_targets  # noqa: E402
from odin.search.retriever import BM25Retriever  # noqa: E402

GOLD = ROOT / "data" / "gold"
OUT = ROOT / "results" / "perf"
LEVEL = "function"


def evaluated_snapshots() -> dict[str, list]:
    lite = [g for g in read_gold(GOLD / "swebench_lite_test.jsonl") if gold_targets(g, LEVEL)]
    in_lite = {g.instance_id for g in read_gold(GOLD / "swebench_lite_test.jsonl")}
    dev = [
        g
        for g in read_gold(GOLD / "swebench_verified_test.jsonl")
        if g.instance_id not in in_lite and gold_targets(g, LEVEL)
    ]
    return {"lite test": lite, "dev (verified minus lite)": dev}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    args = ap.parse_args()
    out = OUT / f"unit_slots_{args.label}.json"
    if out.exists():
        sys.exit(f"{out} exists; results are never overwritten, pick another --label")

    retriever = BM25Retriever(tokenizer="code", exclude_tests=True)
    sets = evaluated_snapshots()
    retriever.warmup(
        [Query(g.instance_id, g.repo, g.base_commit, "") for part in sets.values() for g in part]
    )
    distinct: set = set()
    counts = {}
    for name, part in sets.items():
        slots = 0
        for g in part:
            index = retriever._snapshot(Query(g.instance_id, g.repo, g.base_commit, ""), LEVEL)
            slots += len(index.ids)
            distinct.update(index.unit_keys)
        counts[name] = {"snapshots": len(part), "unit_slots": slots}
        print(name, counts[name], flush=True)
    retriever.close()
    report = {
        "what": "function and class units, excluding tests, summed over every evaluated snapshot",
        "sets": counts,
        "snapshots": sum(c["snapshots"] for c in counts.values()),
        "unit_slots": sum(c["unit_slots"] for c in counts.values()),
        "distinct_unit_texts": len(distinct),
        "provenance": provenance() | {"argv": sys.argv[1:]},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({k: report[k] for k in ("snapshots", "unit_slots", "distinct_unit_texts")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
