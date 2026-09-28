"""Can the fine-tuned reranker run without a GPU? CPU latency and ranking fidelity, fp32 vs int8.

    uv run --extra dense python benchmarks/bench_reranker_cpu.py [--adapter models/ce_adapter] [--n 30]

Dynamic int8 quantization (torch.ao) stores every Linear layer's weights in 8 bits and
quantizes activations on the fly: a quarter of the memory and usually faster matrix products
on CPU. This scores validation issues (never used for training) three ways: on the GPU in
bf16 (the reference the evaluation uses), and on the CPU in fp32 and int8. It reports seconds
per query and how often each CPU variant agrees with the reference and finds the fix first.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np


def load(adapter: Path, device: str, int8: bool = False):
    import torch

    from odin.rank.cross_encoder import CrossEncoder

    ce = CrossEncoder(adapter=adapter, device=device)
    if device == "cpu":
        ce.model = ce.model.float()
        if int8:
            ce.model = torch.ao.quantization.quantize_dynamic(
                ce.model, {torch.nn.Linear}, dtype=torch.qint8
            )
    return ce


def main() -> None:
    import torch

    from odin.cli import _load_eval_set
    from odin.rank.ce_train import validation_split

    ap = argparse.ArgumentParser()
    ap.add_argument("--adapter", type=Path, default=Path("models/ce_adapter"))
    ap.add_argument("--data", type=Path, default=Path("results/ce_train_ltr_negatives.jsonl"))
    ap.add_argument("--n", type=int, default=30, help="validation issues to score")
    ap.add_argument(
        "--docs", type=int, default=20, help="candidates per issue (the cascade's depth)"
    )
    args = ap.parse_args()
    torch.set_num_threads(max(1, torch.get_num_threads()))

    gold, _ = _load_eval_set(
        argparse.Namespace(gold=None, dataset="full", split="test", repo=None, exclude=["lite"])
    )
    val = validation_split([g.instance_id for g in gold if g.functions or g.classes])
    records = [
        r for r in map(json.loads, args.data.open(encoding="utf-8")) if r["qid"] in val and r["pos"]
    ][: args.n]
    groups = [
        (r["query"], [r["pos"][0], *r["neg"][: args.docs - 1]]) for r in records
    ]  # gold first

    def run(ce) -> tuple[list[np.ndarray], float]:
        t0 = time.perf_counter()
        out = [ce.score(q, docs) for q, docs in groups]
        return out, (time.perf_counter() - t0) / len(groups)

    ref, gpu_s = run(load(args.adapter, "cuda")) if torch.cuda.is_available() else (None, None)
    results = {"issues": len(groups), "candidates": args.docs, "threads": torch.get_num_threads()}
    if gpu_s is not None:
        results["gpu_bf16"] = {
            "seconds_per_query": round(gpu_s, 3),
            "gold_first": float(np.mean([s.argmax() == 0 for s in ref])),
        }
    for name, int8 in (("cpu_fp32", False), ("cpu_int8", True)):
        scores, secs = run(load(args.adapter, "cpu", int8))
        row = {
            "seconds_per_query": round(secs, 3),
            "gold_first": float(np.mean([s.argmax() == 0 for s in scores])),
        }
        if ref is not None:
            row["same_top1_as_gpu"] = float(
                np.mean([a.argmax() == b.argmax() for a, b in zip(scores, ref, strict=True)])
            )
            row["spearman_vs_gpu"] = float(
                np.mean(
                    [
                        np.corrcoef(np.argsort(np.argsort(a)), np.argsort(np.argsort(b)))[0, 1]
                        for a, b in zip(scores, ref, strict=True)
                    ]
                )
            )
        results[name] = row
        print(name, row, flush=True)
    out = Path("results/bench_reranker_cpu.json")
    out.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
