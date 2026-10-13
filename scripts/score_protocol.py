import argparse
import hashlib
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from odin.eval.protocols import LEVELS, PROTOCOLS, load_labels, score_locagent  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402

RESULTS = ROOT / "results"
OUT = RESULTS / "comparison"
EVAL_LOG = RESULTS / "test-evals.log"
STAGES = ("bm25-code-notests", "hybrid-notests", "ltr-notests", "ltr-ce-notests")
RESAMPLES = 10_000


def rankings(directory: Path, retriever: str, level: str) -> tuple[dict[str, list[str]], Path]:
    path = directory / f"{retriever}_{level}_lite_test.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    return {row["instance_id"]: row["ranked"] for row in stored["per_instance"]}, path


def interval(outcomes: list[int]) -> list[float]:
    rng = np.random.default_rng(0)
    values = np.asarray(outcomes, dtype=float)
    means = values[rng.integers(0, len(values), (RESAMPLES, len(values)))].mean(axis=1)
    return [round(float(x), 4) for x in np.percentile(means, [2.5, 97.5])]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--protocol", default="locagent-lite", choices=sorted(PROTOCOLS))
    ap.add_argument("--rankings", type=Path, default=RESULTS)
    ap.add_argument("--run", help="score one imported run; its file ranking is its unit ranking")
    ap.add_argument("--label", required=True)
    args = ap.parse_args()
    out = OUT / f"{args.protocol}_{args.label}.json"
    if out.exists():
        sys.exit(f"{out} exists; results are never overwritten, pick another --label")

    protocol = PROTOCOLS[args.protocol]
    labels = load_labels(protocol.labels)
    stages = {}
    for stage in [args.run] if args.run else STAGES:
        if args.run:
            unit_path = file_path = RESULTS / "runs" / args.run / "result.json"
            stored = json.loads(unit_path.read_text(encoding="utf-8"))["per_instance"]
            units = files = {row["instance_id"]: row["ranked"] for row in stored}
        else:
            files, file_path = rankings(args.rankings, stage, "file")
            units, unit_path = rankings(args.rankings, stage, "function")
        scored = score_locagent(labels, files, units, protocol.ks)
        scored["ci95"] = {
            level: {k: interval(v) for k, v in scored["per_instance"][level].items()}
            for level in LEVELS
        }
        scored["rankings"] = {
            "file": file_path.relative_to(ROOT).as_posix(),
            "function": unit_path.relative_to(ROOT).as_posix(),
            "units_stored_per_issue": max(len(r) for r in units.values()),
        }
        stages[stage] = scored
        print(stage, json.dumps(scored["acc"]))
    report = {
        "protocol": protocol.name,
        "paper": protocol.paper,
        "labels": {
            "dataset": protocol.labels.dataset,
            "revision": protocol.labels.revision,
            "sha256": hashlib.sha256(json.dumps(labels, sort_keys=True).encode()).hexdigest(),
        },
        "stages": stages,
        "provenance": provenance() | {"argv": sys.argv[1:]},
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    today = datetime.now(UTC).date().isoformat()
    with EVAL_LOG.open("a", encoding="utf-8", newline="\n") as log:
        for stage in stages:
            log.write(
                f"{today} | lite | {stage} | file and function | "
                f"{out.relative_to(ROOT).as_posix()} | stored rankings scored under the "
                f"{protocol.name} protocol (ADR 0014); nothing re-run, nothing decided\n"
            )
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
