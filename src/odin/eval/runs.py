from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path

from odin.eval.provenance import provenance

MANIFESTS = Path("cluster/manifests")
IMPORTED = Path("results/runs")
EVAL_LOG = Path("results/test-evals.log")
TEST_SETS = {("lite", "test"), ("rebench", "test")}
KS = (1, 5, 10)


class RunRefused(Exception):
    pass


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    scratch = path.with_suffix(path.suffix + ".part")
    scratch.write_text(json.dumps(value, indent=1) + "\n", encoding="utf-8", newline="\n")
    scratch.replace(path)


def load_manifest(path: Path) -> dict:
    manifest = read_json(path)
    if manifest["dataset"] == "holdout":
        raise RunRefused("the holdout is evaluated only through `odin eval --unseal` (ADR 0013)")
    return manifest


def hardware() -> dict:
    gpu = ""
    try:
        import torch

        if torch.cuda.is_available():
            gpu = torch.cuda.get_device_name(0)
    except ImportError:
        pass
    return {
        "processor": platform.processor(),
        "logical_cores": os.cpu_count(),
        "gpu": gpu,
        "node": platform.node() if os.environ.get("SLURM_JOB_ID") else "",
        "slurm_job": os.environ.get("SLURM_JOB_ID", ""),
        "platform": platform.platform(),
    }


def build_retriever(spec: dict):
    if spec["kind"] == "registered":
        from odin.eval.runner import RETRIEVERS

        return RETRIEVERS[spec["name"]]()
    if spec["kind"] == "dense":
        from odin.search.dense import SentenceEncoder
        from odin.search.retriever import HybridRetriever

        encoder = SentenceEncoder(
            spec["model"],
            max_doc_tokens=spec["max_doc_tokens"],
            max_query_tokens=spec["max_query_tokens"],
            query_prompt=spec["query_prompt"],
            document_prompt=spec["document_prompt"],
            revision=spec["revision"],
            trust_remote_code=spec.get("trust_remote_code", False),
        )
        return HybridRetriever(encoder, mode="dense", exclude_tests=spec["exclude_tests"])
    raise RunRefused(f"unknown retriever kind {spec['kind']}")


def issues_of(manifest: dict, limit: int | None) -> list:
    from odin.eval.dataset import load_instances

    instances = load_instances(manifest["dataset"], manifest["split"])
    wanted = manifest.get("issues")
    if wanted:
        instances = [i for i in instances if i.instance_id in set(wanted)]
    return instances[:limit] if limit else instances


def fetch(manifest_path: Path) -> dict:
    from odin.eval.runner import Query
    from odin.search.retriever import BM25Retriever

    manifest = load_manifest(manifest_path)
    instances = issues_of(manifest, None)
    spec = manifest["retriever"]
    if spec["kind"] == "dense":
        from huggingface_hub import snapshot_download

        snapshot_download(spec["model"], revision=spec["revision"])
    mirrors = BM25Retriever(exclude_tests=spec.get("exclude_tests", True), analysis_cache=False)
    mirrors.warmup([Query(i.instance_id, i.repo, i.base_commit, "") for i in instances])
    mirrors.close()
    return {"issues": len(instances), "repositories": len({i.repo for i in instances})}


def execute(manifest_path: Path, out: Path, limit: int | None = None) -> dict:
    from odin.eval.runner import Query

    manifest = load_manifest(manifest_path)
    code = provenance()
    out.mkdir(parents=True, exist_ok=True)
    kept = out / "manifest.json"
    if kept.exists() and sha256(kept) != sha256(manifest_path):
        raise RunRefused(f"{out} holds a run of a different manifest")
    kept.write_bytes(manifest_path.read_bytes())

    instances = issues_of(manifest, limit)
    rankings = out / "rankings"
    todo = [i for i in instances if not (rankings / f"{i.instance_id}.json").exists()]
    started = time.perf_counter()
    if todo:
        retriever = build_retriever(manifest["retriever"])
        level, top = manifest["level"], manifest["top_k"]
        queries = [Query(i.instance_id, i.repo, i.base_commit, i.problem_statement) for i in todo]
        retriever.warmup(queries)
        for query in queries:
            t0 = time.perf_counter()
            retriever.prepare(query, level)
            t1 = time.perf_counter()
            ranked = retriever.retrieve(query, level, top)
            t2 = time.perf_counter()
            write_json(
                rankings / f"{query.instance_id}.json",
                {
                    "instance_id": query.instance_id,
                    "repo": query.repo,
                    "ranked": ranked,
                    "index_ms": round((t1 - t0) * 1000, 1),
                    "query_ms": round((t2 - t1) * 1000, 2),
                },
            )
        retriever.close()
    record = {
        "name": manifest["name"],
        "manifest_sha256": sha256(kept),
        "local": limit is not None,
        "issues": len(instances),
        "ranked_in_this_invocation": len(todo),
        "seconds_this_invocation": round(time.perf_counter() - started, 1),
        "finished": datetime.now(UTC).isoformat(timespec="seconds"),
        "hardware": hardware(),
        "provenance": code,
    }
    invocations = read_json(out / "run.json")["invocations"] if (out / "run.json").exists() else []
    write_json(out / "run.json", {"invocations": [*invocations, record]})
    seal(out)
    return record


def sealed_files(run: Path) -> list[Path]:
    files = [run / "manifest.json", run / "run.json", *sorted((run / "rankings").glob("*.json"))]
    return [f for f in files if f.exists()]


def seal(run: Path) -> None:
    lines = [f"{sha256(f)}  {f.relative_to(run).as_posix()}\n" for f in sealed_files(run)]
    (run / "SHA256SUMS").write_text("".join(lines), encoding="utf-8", newline="\n")


def _committed(commit: str) -> bool:
    done = subprocess.run(
        ["git", "merge-base", "--is-ancestor", commit, "HEAD"], capture_output=True
    )
    return bool(commit) and done.returncode == 0


def verify(run: Path) -> tuple[dict, dict[str, dict]]:
    recorded = {}
    for line in (run / "SHA256SUMS").read_text(encoding="utf-8").splitlines():
        digest, name = line.split(maxsplit=1)
        recorded[name] = digest
    present = {f.relative_to(run).as_posix() for f in sealed_files(run)}
    if present != set(recorded):
        raise RunRefused("the run's files and its checksum list differ")
    wrong = [name for name, digest in recorded.items() if sha256(run / name) != digest]
    if wrong:
        raise RunRefused(f"checksum mismatch: {wrong[:5]}")

    manifest = read_json(run / "manifest.json")
    committed = MANIFESTS / f"{manifest['name']}.json"
    if not committed.exists() or sha256(committed) != sha256(run / "manifest.json"):
        raise RunRefused(f"the run's manifest is not the committed {committed}")
    invocations = read_json(run / "run.json")["invocations"]
    for record in invocations:
        if record["manifest_sha256"] != sha256(committed):
            raise RunRefused("an invocation used a different manifest")
        if record["local"]:
            raise RunRefused("a --local invocation is a test of the job, not a result")
        if record["provenance"]["git_dirty"]:
            raise RunRefused("an invocation ran from a tree with uncommitted changes")
        if not _committed(record["provenance"]["git_commit"]):
            raise RunRefused("an invocation ran from a commit this repository does not have")
    rankings = {f.stem: read_json(f) for f in sorted((run / "rankings").glob("*.json"))}
    expected = {i.instance_id for i in issues_of(manifest, None)}
    if set(rankings) != expected:
        raise RunRefused(
            f"the run ranked {len(rankings)} issues, the manifest names {len(expected)}"
        )
    return manifest, rankings


def import_run(run: Path) -> Path:
    from odin.eval.ground_truth import read_gold
    from odin.eval.metrics import aggregate, bootstrap_ci, percentile, score
    from odin.eval.runner import gold_targets

    manifest, rankings = verify(run)
    out = IMPORTED / manifest["name"] / "result.json"
    if out.exists():
        raise RunRefused(f"{out} exists; results are never overwritten")
    level = manifest["level"]
    gold_file = Path("data/gold") / f"swebench_{manifest['dataset']}_{manifest['split']}.jsonl"
    scores, per_instance = [], []
    for entry in read_gold(gold_file):
        targets = gold_targets(entry, level)
        if entry.instance_id not in rankings or not targets:
            continue
        ranked = rankings[entry.instance_id]["ranked"]
        s = score(ranked, targets, KS)
        scores.append(s)
        per_instance.append(
            {
                "instance_id": entry.instance_id,
                "repo": entry.repo,
                "gold": targets,
                "ranked": ranked,
                "first_rank": s.first_rank,
            }
        )
    summary = aggregate(scores, KS) | {
        "retriever": manifest["name"],
        "level": level,
        "skipped_no_target": len(rankings) - len(scores),
        "ci95": {m: bootstrap_ci(scores, m) for m in ("mrr", f"recall@{KS[-1]}")},
        "query_ms_p50": round(percentile([r["query_ms"] for r in rankings.values()], 50), 2),
        "index_ms_p50": round(percentile([r["index_ms"] for r in rankings.values()], 50), 1),
    }
    invocations = read_json(run / "run.json")["invocations"]
    write_json(
        out,
        {
            "summary": summary,
            "per_instance": per_instance,
            "manifest": manifest,
            "run": invocations,
            "provenance": provenance() | {"imported_from": run.as_posix()},
        },
    )
    if (manifest["dataset"], manifest["split"]) in TEST_SETS:
        today = datetime.now(UTC).date().isoformat()
        with EVAL_LOG.open("a", encoding="utf-8", newline="\n") as log:
            log.write(
                f"{today} | {manifest['dataset']} | {manifest['name']} | {level} | "
                f"{out.as_posix()} | {manifest['why']}\n"
            )
    return out
