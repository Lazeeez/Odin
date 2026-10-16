import argparse
import dataclasses
import json
import sys
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "scripts"))

import browser_ltr as bl  # noqa: E402

from odin.eval.metrics import paired_bootstrap  # noqa: E402
from odin.eval.provenance import provenance  # noqa: E402
from odin.rank.confidence import confidence_features, fit_logistic, predict_confidence  # noqa: E402

OUT = ROOT / "results" / "confidence"
MODEL = ROOT / "web" / "src" / "assets" / "confidence.json"
HELD_OUT = ("lite", "unseen", "multilingual", "polybench")
BANDS = {"high": (0.8, 1.01), "medium": (0.5, 0.8), "low": (0.0, 0.5)}


def row(it, scores: np.ndarray) -> dict:
    hit = False
    if len(scores):
        ids = bl.unit_ids(it, it.rows_b)
        hit = any(ids[i] in it.targets for i in bl.order(scores)[:10])
    return {
        "qid": it.qid,
        "repo": it.repo,
        "language": bl.LANG_OF.get(it.qid, "python"),
        "features": confidence_features(
            scores, it.xb if len(scores) else np.zeros((0, 1)), len(it.text)
        ).tolist(),
        "hit": bool(hit),
    }


def features(ranker_path: Path) -> int:
    from odin.rank.browser import predict_many

    OUT.mkdir(parents=True, exist_ok=True)
    sys.modules["__main__"].Item = bl.Item
    ranker = json.loads(ranker_path.read_text(encoding="utf-8"))
    bl.MULTILANG = bool(ranker["meta"].get("multilang"))
    if bl.MULTILANG:
        bl.CACHE = Path(".cache/browser_ltr_multilang")
        bl.TRAIN["multilang"] = ("multilang", "train", [])
        bl.TEST["multilingual"] = ("multilang", "multilingual", [])
        bl.TEST["polybench"] = ("multilang", "polybench", [])
    snaps = bl.Snapshots()
    train = [it for name, spec in bl.TRAIN.items() for it in bl.build(name, spec, snaps)]
    splits = bl.repo_folds(train)
    n_gold = [len(it.targets) for it in train]
    X, Y, _ = bl.stage_rows(train, "b")
    _, oof, _ = bl.cv_items(train, X, Y, n_gold, splits)
    rows = [row(it, s) for it, s in zip(train, oof, strict=True)]
    (OUT / "train.json").write_text(json.dumps(rows), encoding="utf-8", newline="\n")
    print(
        f"train: {len(rows)} issues, top-10 rate {np.mean([r['hit'] for r in rows]):.3f}",
        flush=True,
    )
    for name in HELD_OUT:
        if name not in bl.TEST:
            continue
        items = bl.build(name, bl.TEST[name], snaps)
        held = [
            row(
                it,
                predict_many(ranker["semantic"], it.xb)
                if it.xb is not None and len(it.xb)
                else np.zeros(0),
            )
            for it in items
        ]
        (OUT / f"{name}.json").write_text(json.dumps(held), encoding="utf-8", newline="\n")
        print(f"{name}: {len(held)} issues", flush=True)
    snaps.close()
    return 0


def calibration(p: np.ndarray, y: np.ndarray) -> dict:
    bins = np.minimum((p * 10).astype(int), 9)
    ece = sum(
        abs(p[bins == b].mean() - y[bins == b].mean()) * (bins == b).mean()
        for b in range(10)
        if (bins == b).any()
    )
    order = np.argsort(p)
    ranks = np.empty(len(p))
    ranks[order] = np.arange(1, len(p) + 1)
    positives = y.sum()
    auc = (ranks[y == 1].sum() - positives * (positives + 1) / 2) / (
        positives * (len(y) - positives)
    )
    bands = {
        name: {
            "issues": int(((p >= lo) & (p < hi)).sum()),
            "top10_rate": float(y[(p >= lo) & (p < hi)].mean())
            if ((p >= lo) & (p < hi)).any()
            else None,
        }
        for name, (lo, hi) in BANDS.items()
    }
    return {
        "issues": len(y),
        "base_rate": float(y.mean()),
        "brier": float(((p - y) ** 2).mean()),
        "ece": float(ece),
        "auc": float(auc),
        "bands": bands,
    }


def load(name: str) -> tuple[list[dict], np.ndarray, np.ndarray]:
    rows = json.loads((OUT / f"{name}.json").read_text(encoding="utf-8"))
    return (
        rows,
        np.array([r["features"] for r in rows]),
        np.array([r["hit"] for r in rows], np.float64),
    )


def fit() -> int:
    rows, F, y = load("train")
    items = [SimpleNamespace(repo=r["repo"]) for r in rows]
    oof = np.zeros(len(y))
    for train_idx, test_idx in bl.repo_folds(items):
        oof[test_idx] = predict_confidence(fit_logistic(F[train_idx], y[train_idx]), F[test_idx])
    base = np.full(len(y), y.mean())
    cv = calibration(oof, y)
    test = paired_bootstrap((base - y) ** 2, (oof - y) ** 2)
    cv["brier_vs_base_rate"] = dataclasses.asdict(test)
    met = bool(cv["auc"] >= 0.70 and cv["ece"] <= 0.05 and test.delta < 0 and test.p_value < 0.05)
    report = {
        "adr": "docs/decisions/0029-confidence.md",
        "cv": cv,
        "cv_by_language": {
            lang: calibration(oof[mask], y[mask])
            for lang in sorted({r["language"] for r in rows})
            if (mask := np.array([r["language"] == lang for r in rows])).sum() >= 50
        },
        "decision": {
            "rule": "AUC >= 0.70, ECE <= 0.05, Brier below the base rate with p < 0.05",
            "met": met,
        },
    }
    model = fit_logistic(F, y)
    model["bands"] = {k: v[0] for k, v in BANDS.items()}
    report["model"] = model
    report["provenance"] = provenance()
    (OUT / "cv.json").write_text(
        json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n"
    )
    if met:
        MODEL.write_text(json.dumps(model, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(
        json.dumps(
            {k: v for k, v in report.items() if k not in ("model", "provenance", "cv_by_language")},
            indent=1,
        )
    )
    print("by language:", {k: round(v["auc"], 3) for k, v in report["cv_by_language"].items()})
    return 0


def held_out() -> int:
    model = json.loads(MODEL.read_text(encoding="utf-8"))
    report = {"adr": "docs/decisions/0029-confidence.md"}
    for name in HELD_OUT:
        if not (OUT / f"{name}.json").exists():
            continue
        _, F, y = load(name)
        report[name] = calibration(predict_confidence(model, F), y)
    report["provenance"] = provenance()
    target = OUT / "held_out.json"
    if target.exists():
        sys.exit(f"{target} exists")
    target.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8", newline="\n")
    with (ROOT / "results" / "test-evals.log").open("a", encoding="utf-8", newline="\n") as log:
        for name in HELD_OUT:
            if name in report:
                log.write(
                    f"{date.today().isoformat()} | {name} | confidence (ADR 0029) | calibration | results/confidence/held_out.json | "
                    "scored once with the shipped confidence model; nothing decided\n"
                )
    print(json.dumps({k: v for k, v in report.items() if k != "provenance"}, indent=1))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["features", "fit", "held-out"])
    ap.add_argument("--ranker", type=Path, default=ROOT / "web" / "src" / "assets" / "ranker.json")
    args = ap.parse_args()
    return {"features": lambda: features(args.ranker), "fit": fit, "held-out": held_out}[
        args.step
    ]()


if __name__ == "__main__":
    sys.exit(main())
