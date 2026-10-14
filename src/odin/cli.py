from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

DEFAULT_CACHE = Path(".cache/repos")
DEFAULT_GOLD_DIR = Path("data/gold")
DATASET_NAMES = ["lite", "verified", "full", "rebench"]
HOLDOUT = "holdout"
EVALUATION_ONLY = [HOLDOUT, "postcutoff"]


def _gold_path(dataset: str, split: str) -> Path:
    if dataset == HOLDOUT:
        from odin.eval.holdout import GOLD

        return GOLD
    return DEFAULT_GOLD_DIR / f"swebench_{dataset}_{split}.jsonl"


def cmd_gold(args: argparse.Namespace) -> None:
    from odin.eval.dataset import load_instances
    from odin.eval.ground_truth import build_gold, write_gold
    from odin.repos import RepoCache

    instances = load_instances(args.dataset, args.split)
    if args.repo:
        instances = [i for i in instances if i.repo == args.repo]
    if args.limit:
        instances = instances[: args.limit]
    start = time.perf_counter()
    entries = build_gold(instances, RepoCache(args.cache), workers=args.workers)
    out = args.out or _gold_path(args.dataset, args.split)
    if args.dataset == HOLDOUT and out.exists():
        sys.exit(f"{out} exists; the holdout's ground truth is built once")
    write_gold(entries, out)
    n = len(entries)
    stats = {
        "instances": n,
        "seconds": round(time.perf_counter() - start, 1),
        "with_function_target": sum(bool(e.functions) for e in entries),
        "module_level_only": sum(
            bool(e.module_level_files) and not e.functions and not e.classes for e in entries
        ),
        "multi_file": sum(len(e.files) > 1 for e in entries),
        "with_added_files": sum(bool(e.added_files) for e in entries),
        "errors": sum(bool(e.errors) for e in entries),
        "avg_files": round(sum(len(e.files) for e in entries) / max(n, 1), 2),
        "avg_functions": round(sum(len(e.functions) for e in entries) / max(n, 1), 2),
        "by_repo": dict(Counter(e.repo for e in entries).most_common()),
    }
    print(json.dumps(stats, indent=2))
    print(f"wrote {out}")


def _progress(done: int, total: int) -> None:
    if done == total or done % 10 == 0:
        print(f"\r  {done}/{total}", end="\n" if done == total else "", file=sys.stderr)


def _load_eval_set(args: argparse.Namespace):
    """Gold entries and issue texts, minus any dataset named in --exclude.

    Tuning on SWE-bench Verified with `--exclude lite` leaves 407 issues from the same repos
    that share no instance with the Lite test set, which keeps reported numbers held out.
    """
    from odin.eval.dataset import load_instances
    from odin.eval.ground_truth import read_gold

    gold = read_gold(args.gold or _gold_path(args.dataset, args.split))
    if args.repo:
        gold = [g for g in gold if g.repo == args.repo]
    for name in args.exclude or []:
        held_out = {g.instance_id for g in read_gold(_gold_path(name, "test"))}
        gold = [g for g in gold if g.instance_id not in held_out]
    queries = {i.instance_id: i.problem_statement for i in load_instances(args.dataset, args.split)}
    return gold, queries


def _load_holdout(args: argparse.Namespace):
    from odin.eval import holdout
    from odin.eval.ground_truth import read_gold

    if args.repo or args.exclude or args.gold or args.out:
        sys.exit("the holdout is evaluated whole: no --repo, --exclude, --gold or --out")
    try:
        queries, seal = holdout.unseal(args.config, args.unseal, args.level, args.retriever)
    except holdout.HoldoutRefused as refusal:
        sys.exit(f"refused: {refusal}")
    gold = [g for g in read_gold(holdout.GOLD) if g.instance_id in queries]
    return gold, queries, seal


def cmd_eval(args: argparse.Namespace) -> None:
    from odin.eval.runner import RETRIEVERS, run_eval

    seal = None
    if args.dataset == HOLDOUT:
        gold, queries, seal = _load_holdout(args)
    else:
        gold, queries = _load_eval_set(args)
    retriever = RETRIEVERS[args.retriever]()
    report = run_eval(retriever, gold, queries, ks=args.k, level=args.level, progress=_progress)
    from odin.eval.provenance import provenance

    if seal:
        from odin.eval import holdout

        args.out = holdout.result_path(seal["config"], args.level)
        report["holdout"] = seal
        holdout.record(
            seal["config"],
            args.retriever,
            args.level,
            len(gold),
            seal["issues_created_on_or_after"],
        )

    models = sorted(Path("models").glob("*.txt")) if args.retriever.startswith("ltr") else []
    if "-ce" in args.retriever:
        models += sorted(Path("models").glob("reranker*.json"))
        models += sorted(Path("models").glob("ce_adapter*/adapter_model.safetensors"))
    report["provenance"] = provenance(models) | {
        "argv": sys.argv[1:],
        "gold_file": str(args.gold or _gold_path(args.dataset, args.split)),
        "fusion": str(getattr(retriever, "fusion", "")),
    }
    out = (
        args.out
        or Path("results") / f"{args.retriever}_{args.level}_{args.dataset}_{args.split}.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    summary = {k: v for k, v in report["summary"].items() if k != "by_repo"}
    print(json.dumps(summary, indent=2))
    print(f"wrote {out}")


def cmd_run(args: argparse.Namespace) -> None:
    from odin.eval import runs

    try:
        if args.fetch_only:
            print(json.dumps(runs.fetch(args.manifest), indent=2))
            return
        if not args.out:
            sys.exit("--out is required unless --fetch-only is given")
        record = runs.execute(args.manifest, args.out, args.local)
    except runs.RunRefused as refusal:
        sys.exit(f"refused: {refusal}")
    print(json.dumps({k: v for k, v in record.items() if k != "provenance"}, indent=2))
    print(f"wrote {args.out}")


def cmd_import_run(args: argparse.Namespace) -> None:
    from odin.eval import runs

    try:
        out = runs.import_run(args.run, args.label)
    except runs.RunRefused as refusal:
        sys.exit(f"refused: {refusal}")
    summary = json.loads(out.read_text(encoding="utf-8"))["summary"]
    print(json.dumps(summary, indent=2))
    print(f"wrote {out}")


def _print_table(rows) -> None:
    rows = sorted(rows, key=lambda r: (r[1]["recall@10"], r[1]["mrr"]), reverse=True)
    print(f"{'setting':<48}{'r@1':>7}{'r@5':>7}{'r@10':>7}{'mrr':>7}")
    for label, m in rows:
        print(
            f"{label!s:<48}{m['recall@1']:>7.3f}{m['recall@5']:>7.3f}"
            f"{m['recall@10']:>7.3f}{m['mrr']:>7.3f}"
        )


def cmd_tune(args: argparse.Namespace) -> None:
    gold, queries = _load_eval_set(args)
    if args.what == "fusion":
        from odin.eval.tune import tune_fusion
        from odin.search.dense import FusionParams, SentenceEncoder
        from odin.search.retriever import HybridRetriever

        grid = [FusionParams("rrf", w, k) for k in (10, 30, 60, 100) for w in (0.3, 0.5, 0.7)]
        grid += [FusionParams("zsum", w) for w in (0.2, 0.35, 0.5, 0.65, 0.8)]
        retriever = HybridRetriever(SentenceEncoder(), exclude_tests=True)
        if args.paths:
            from odin.search.path_aware import PathAwareRetriever

            retriever = PathAwareRetriever(SentenceEncoder())
        _print_table(tune_fusion(retriever, gold, queries, grid, args.level, progress=_progress))
        return

    from odin.eval.tune import tune_expansion
    from odin.search.graph import ExpandParams
    from odin.search.retriever import BM25Retriever

    grid = [ExpandParams()] + [
        ExpandParams(alpha, callers, seeds, indegree_power)
        for alpha in (0.05, 0.1, 0.25, 0.5)
        for callers in (0.0, 0.5)
        for seeds in (1, 5, 20)
        for indegree_power in (0.0, 0.5)
    ]
    retriever = BM25Retriever(tokenizer=args.tokenizer, exclude_tests=args.exclude_tests)
    _print_table(tune_expansion(retriever, gold, queries, grid, progress=_progress))


def cmd_ltr(args: argparse.Namespace) -> None:
    """Learn to rank: build features (cached), cross-validate and train both levels."""
    from odin.eval.runner import DEV_SELECTED_FUSION
    from odin.rank.features import FeatureExtractor
    from odin.rank.ltr import LEVELS, RankingData, build_ranking_data, cross_validate, train
    from odin.search.dense import SentenceEncoder
    from odin.search.retriever import HybridRetriever

    gold, queries = _load_eval_set(args)
    stem = f"results/ltr_features_{args.dataset}_minus_{'_'.join(args.exclude)}"
    if args.paths:
        stem += "_paths"
    paths = {level: Path(f"{stem}_{level}.npz") for level in LEVELS}
    data = {level: RankingData.load(p) for level, p in paths.items()}
    if any(d is None for d in data.values()):
        from odin.rank.ltr import issue_memory

        retriever = HybridRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)
        if args.paths:
            from odin.search.path_aware import PathAwareRetriever

            retriever = PathAwareRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)
        extractor = FeatureExtractor(retriever, DEV_SELECTED_FUSION, memory=issue_memory(retriever))
        data = build_ranking_data(extractor, gold, queries, _progress)
        retriever.close()
        for level, d in data.items():
            d.save(paths[level])
    for level, (names, baseline, model_path) in LEVELS.items():
        if args.paths:
            model_path = model_path.parent / "paths" / model_path.name
        d = data[level]
        print(f"{level}: {len(d.group)} queries, {len(d.y)} candidates, {int(d.y.sum())} gold")
        rounds, cv, base = cross_validate(d, baseline, names, folds=args.folds)
        print(f"{'5-fold CV':<22}{'r@1':>8}{'r@5':>8}{'r@10':>8}{'mrr':>8}")
        for label, m in (("hybrid (baseline)", base), (f"LTR ({rounds} rounds)", cv)):
            print(
                f"{label:<22}{m['recall@1']:>8.3f}{m['recall@5']:>8.3f}"
                f"{m['recall@10']:>8.3f}{m['mrr']:>8.3f}"
            )
        meta = {"trained_on": f"{args.dataset} minus {args.exclude}", "cv": cv, "cv_baseline": base}
        train(d, rounds, names, model_path, meta)
        d.save(paths[level])  # now with out-of-fold scores, for mining reranker negatives
        print(f"wrote {model_path}")


def cmd_ce_train(args: argparse.Namespace) -> None:
    """Fine-tune the cross-encoder reranker on training issues, minus a validation split."""
    from odin.eval.runner import DEV_SELECTED_FUSION
    from odin.rank.ce_train import (
        build_ce_data,
        build_ce_data_from_ltr,
        train_cross_encoder,
        validation_split,
    )
    from odin.rank.ltr import RankingData
    from odin.search.dense import SentenceEncoder
    from odin.search.retriever import HybridRetriever

    gold, queries = _load_eval_set(args)
    val = validation_split([g.instance_id for g in gold if g.functions or g.classes])
    if args.data.exists():
        records = [json.loads(line) for line in args.data.open(encoding="utf-8")]
    else:
        retriever = HybridRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)
        stem = f"results/ltr_features_{args.dataset}_minus_{'_'.join(args.exclude)}"
        ltr = RankingData.load(Path(f"{stem}_function.npz"))
        if args.negatives == "ltr" and ltr is not None and ltr.oof is not None:
            records = build_ce_data_from_ltr(retriever, ltr, gold, queries, progress=_progress)
        else:
            records = build_ce_data(
                retriever, DEV_SELECTED_FUSION, gold, queries, progress=_progress
            )
        retriever.close()
        args.data.parent.mkdir(parents=True, exist_ok=True)
        with args.data.open("w", encoding="utf-8", newline="\n") as fh:
            for r in records:
                fh.write(json.dumps(r) + "\n")
    train_records = [r for r in records if r["qid"] not in val]
    if args.limit:
        train_records = train_records[: args.limit]
    print(f"{len(train_records)} training issues, {len(val)} held out for validation")
    if args.distill_from:
        # Soft labels from the current ensemble, cached next to the training data.
        from odin.rank.ce_train import score_teacher
        from odin.rank.cross_encoder import CrossEncoderEnsemble

        cache = args.data.with_name(args.data.stem + "_teacher.jsonl")
        if cache.exists():
            scored = {r["qid"]: r["teacher"] for r in map(json.loads, cache.open(encoding="utf-8"))}
            for r in train_records:
                if r["qid"] in scored:
                    r["teacher"] = scored[r["qid"]]
        if any("teacher" not in r for r in train_records):
            recipe = json.loads(args.distill_from.read_text(encoding="utf-8"))
            teacher = CrossEncoderEnsemble([Path(a) for a in recipe["adapters"]])
            score_teacher(train_records, teacher)
            del teacher
            with cache.open("w", encoding="utf-8", newline="\n") as fh:
                for r in train_records:
                    fh.write(json.dumps({"qid": r["qid"], "teacher": r["teacher"]}) + "\n")
    train_cross_encoder(
        train_records, args.out, epochs=args.epochs, group=args.group, lr=args.lr,
        distill=args.distill if args.distill_from else 0.0,
    )  # fmt: skip
    print(f"wrote {args.out}")


def cmd_ce_tune(args: argparse.Namespace) -> None:
    from odin.eval.runner import DEV_SELECTED_FUSION
    from odin.rank.ce_tune import save_choice, tune_cross_encoder
    from odin.rank.cross_encoder import CrossEncoderEnsemble
    from odin.rank.ltr import LEVELS, RankingData
    from odin.search.dense import SentenceEncoder
    from odin.search.retriever import HybridRetriever

    gold, queries = _load_eval_set(args)
    stem = f"results/ltr_features_{args.dataset}_minus_{'_'.join(args.exclude)}"
    data = {level: RankingData.load(Path(f"{stem}_{level}.npz")) for level in LEVELS}
    if any(d is None for d in data.values()):
        raise SystemExit("LTR features are missing or stale; run `odin ltr` first")
    retriever = HybridRetriever(SentenceEncoder(), fusion=DEV_SELECTED_FUSION)
    ce = CrossEncoderEnsemble(args.adapter)
    result = tune_cross_encoder(
        retriever, DEV_SELECTED_FUSION, ce, gold, queries, data, progress=_progress
    )
    retriever.close()
    for level in ("function", "file"):
        print(f"\n{level} (validation, {result['validation_issues']} issues)")
        print(f"{'setting':<24}{'r@1':>8}{'r@5':>8}{'r@10':>8}{'mrr':>8}")
        for r in sorted(result[level], key=lambda r: -r["mrr"]):
            print(
                f"{str(r['setting']):<24}{r['recall@1']:>8.3f}{r['recall@5']:>8.3f}"
                f"{r['recall@10']:>8.3f}{r['mrr']:>8.3f}"
            )
    save_choice(result, args.out, args.adapter)
    print(f"wrote {args.out}")
    print(f"chosen: {result['chosen_function']} (function), {result['chosen_file']} (file)")


def cmd_dense_train(args: argparse.Namespace) -> None:
    """Fine-tune the embedding model on training issues; report a held-out proxy score."""
    from odin.rank.ce_train import validation_split
    from odin.search.dense import SentenceEncoder
    from odin.search.dense_train import hard_negative_mrr, train_embedder

    records = [json.loads(line) for line in args.data.open(encoding="utf-8")]
    val = validation_split([r["qid"] for r in records])
    train_records = [r for r in records if r["qid"] not in val]
    val_records = [r for r in records if r["qid"] in val]
    if not args.skip_train:
        print(f"{len(train_records)} training issues, {len(val_records)} held out")
        train_embedder(train_records, args.out, epochs=args.epochs, batch=args.batch, lr=args.lr)
    for label, adapter in (("base", None), ("fine-tuned", args.out)):
        enc = SentenceEncoder(adapter=adapter)
        m = hard_negative_mrr(enc, val_records)
        print(
            f"{label:<11} gold vs 20 hardest negatives: MRR {m['mrr']:.3f}  hit@1 {m['hit@1']:.3f}"
        )
        del enc


def cmd_compare(args: argparse.Namespace) -> None:
    from odin.eval.metrics import metric_values, paired_bootstrap, score

    runs = [json.loads(p.read_text(encoding="utf-8")) for p in (args.a, args.b)]
    rows = [{r["instance_id"]: r for r in run["per_instance"]} for run in runs]
    common = sorted(rows[0].keys() & rows[1].keys())
    names = [run["summary"]["retriever"] for run in runs]
    ks = sorted({int(m.split("@")[1]) for m in args.metrics if "@" in m} | {1})
    print(f"{names[0]} -> {names[1]} on {len(common)} shared queries\n")
    print(f"{'metric':<12}{'A':>8}{'B':>8}{'delta':>9}{'95% CI':>20}{'p':>8}{'W/L':>9}")
    for metric in args.metrics:
        vals = [
            metric_values(
                [score(rows[i][q]["ranked"], rows[i][q]["gold"], ks) for q in common], metric
            )
            for i in (0, 1)
        ]
        d = paired_bootstrap(vals[0], vals[1])
        ci = f"[{d.ci95[0]:+.3f}, {d.ci95[1]:+.3f}]"
        print(
            f"{metric:<12}{vals[0].mean():>8.3f}{vals[1].mean():>8.3f}{d.delta:>+9.3f}"
            f"{ci:>20}{d.p_value:>8.3f}{f'{d.wins}/{d.losses}':>9}"
        )


def cmd_search(args: argparse.Namespace) -> None:
    from odin.repos import RepoCache
    from odin.search.retriever import BM25Retriever, Query

    cache = RepoCache(args.cache)
    commit = args.commit
    if commit is None:
        from odin.repos import _git

        commit = _git(["rev-parse", "HEAD"], cwd=cache.ensure_mirror(args.repo)).decode().strip()
    retriever = BM25Retriever(tokenizer=args.tokenizer, exclude_tests=args.no_tests, cache=cache)
    q = Query("adhoc", args.repo, commit, " ".join(args.query))
    t0 = time.perf_counter()
    retriever.prepare(q, args.level)
    t1 = time.perf_counter()
    ranked = retriever.retrieve(q, args.level, args.k)
    t2 = time.perf_counter()
    print(
        f"{args.repo}@{commit[:10]}  index {1000 * (t1 - t0):.0f} ms  query {1000 * (t2 - t1):.1f} ms"
    )
    for i, item in enumerate(ranked, start=1):
        print(f"{i:>3}. {item}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="odin")
    sub = parser.add_subparsers(dest="command", required=True)

    gold = sub.add_parser("gold", help="build ground truth from SWE-bench gold patches")
    gold.add_argument("--dataset", default="lite", choices=[*DATASET_NAMES, *EVALUATION_ONLY])
    gold.add_argument("--split", default="test")
    gold.add_argument("--repo")
    gold.add_argument("--limit", type=int)
    gold.add_argument("--workers", type=int, default=8)
    gold.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    gold.add_argument("--out", type=Path)
    gold.set_defaults(func=cmd_gold)

    ev = sub.add_parser("eval", help="score a retriever against ground truth")
    ev.add_argument("--retriever", required=True)
    ev.add_argument("--level", default="file", choices=["file", "function"])
    ev.add_argument("--dataset", default="lite", choices=[*DATASET_NAMES, *EVALUATION_ONLY])
    ev.add_argument("--unseal", action="store_true")
    ev.add_argument("--config")
    ev.add_argument("--split", default="test")
    ev.add_argument("--repo", help="only evaluate issues from this repository")
    ev.add_argument("--exclude", nargs="+", choices=DATASET_NAMES, help="hold out")
    ev.add_argument("--gold", type=Path)
    ev.add_argument("--k", type=int, nargs="+", default=[1, 5, 10])
    ev.add_argument("--out", type=Path)
    ev.set_defaults(func=cmd_eval)

    rn = sub.add_parser("run", help="rank every issue of a manifest into a run directory")
    rn.add_argument("--manifest", type=Path, required=True)
    rn.add_argument("--out", type=Path)
    rn.add_argument("--fetch-only", action="store_true", help="download what the job needs")
    rn.add_argument("--local", type=int, metavar="N", help="test the job on the first N issues")
    rn.set_defaults(func=cmd_run)

    im = sub.add_parser("import-run", help="verify a run directory and score it")
    im.add_argument("run", type=Path)
    im.add_argument("--label", help="import under this name instead of the manifest's")
    im.set_defaults(func=cmd_import_run)

    tu = sub.add_parser("tune", help="grid-search call-graph expansion on a dev set")
    tu.add_argument("--dataset", default="verified", choices=DATASET_NAMES)
    tu.add_argument("--split", default="test")
    tu.add_argument("--exclude", nargs="+", default=["lite"], choices=DATASET_NAMES)
    tu.add_argument("--repo")
    tu.add_argument("--gold", type=Path)
    tu.add_argument("--tokenizer", default="code", choices=["naive", "code"])
    tu.add_argument("--exclude-tests", action="store_true")
    tu.add_argument("--what", default="expansion", choices=["expansion", "fusion"])
    tu.add_argument("--level", default="function", choices=["file", "function"])
    tu.add_argument("--paths", action="store_true", help="embed units with their file path")
    tu.set_defaults(func=cmd_tune)

    lt = sub.add_parser("ltr", help="train the learning-to-rank model on the dev set")
    lt.add_argument("--dataset", default="full", choices=DATASET_NAMES)
    lt.add_argument("--split", default="test")
    lt.add_argument("--exclude", nargs="+", default=["lite"], choices=DATASET_NAMES)
    lt.add_argument("--repo")
    lt.add_argument("--gold", type=Path)
    lt.add_argument("--folds", type=int, default=5)
    lt.add_argument("--paths", action="store_true", help="embed units with their file path")
    lt.set_defaults(func=cmd_ltr)

    ct = sub.add_parser("ce-train", help="fine-tune the cross-encoder reranker")
    ct.add_argument("--dataset", default="full", choices=DATASET_NAMES)
    ct.add_argument("--split", default="test")
    ct.add_argument("--exclude", nargs="+", default=["lite"], choices=["lite", "verified"])
    ct.add_argument("--repo")
    ct.add_argument("--gold", type=Path)
    ct.add_argument("--data", type=Path, default=Path("results/ce_train_ltr_negatives.jsonl"))
    ct.add_argument("--out", type=Path, default=Path("models/ce_adapter"))
    ct.add_argument(
        "--distill-from", type=Path, default=None,
        help="a reranker recipe (e.g. models/reranker.json) whose ensemble to distill into one model",
    )  # fmt: skip
    ct.add_argument("--distill", type=float, default=0.5, help="weight of the soft-label loss")
    ct.add_argument("--epochs", type=int, default=1)
    ct.add_argument("--group", type=int, default=4)
    ct.add_argument("--lr", type=float, default=1e-4)
    ct.add_argument("--limit", type=int, help="train on the first N issues (smoke tests)")
    ct.add_argument(
        "--negatives", default="ltr", choices=["ltr", "hybrid"],
        help="mine hard negatives from out-of-fold LTR scores or from hybrid retrieval",
    )  # fmt: skip
    ct.set_defaults(func=cmd_ce_train)

    cu = sub.add_parser("ce-tune", help="choose reranking depth and weights on validation")
    cu.add_argument("--dataset", default="full", choices=DATASET_NAMES)
    cu.add_argument("--split", default="test")
    cu.add_argument("--exclude", nargs="+", default=["lite"], choices=["lite", "verified"])
    cu.add_argument("--repo")
    cu.add_argument("--gold", type=Path)
    cu.add_argument("--adapter", type=Path, nargs="+", default=[Path("models/ce_adapter")])
    cu.add_argument("--out", type=Path, default=Path("models/reranker.json"))
    cu.set_defaults(func=cmd_ce_tune)

    dt = sub.add_parser("dense-train", help="fine-tune the embedding model on bug reports")
    dt.add_argument("--data", type=Path, default=Path("results/ce_train_ltr_negatives.jsonl"))
    dt.add_argument("--out", type=Path, default=Path("models/embed_adapter"))
    dt.add_argument("--epochs", type=int, default=1)
    dt.add_argument("--batch", type=int, default=16)
    dt.add_argument("--lr", type=float, default=5e-5)
    dt.add_argument("--skip-train", action="store_true", help="only score existing adapter")
    dt.set_defaults(func=cmd_dense_train)

    cmp = sub.add_parser("compare", help="paired bootstrap significance test between two runs")
    cmp.add_argument("a", type=Path)
    cmp.add_argument("b", type=Path)
    cmp.add_argument("--metrics", nargs="+", default=["recall@1", "recall@5", "recall@10", "mrr"])
    cmp.set_defaults(func=cmd_compare)

    se = sub.add_parser("search", help="search a repository at a commit")
    se.add_argument("repo", help="owner/name, e.g. psf/requests")
    se.add_argument("query", nargs="+")
    se.add_argument("--commit", help="defaults to the mirror's HEAD")
    se.add_argument("--level", default="function", choices=["file", "function"])
    se.add_argument("--tokenizer", default="code", choices=["naive", "code"])
    se.add_argument("--no-tests", action="store_true", help="skip test files")
    se.add_argument("-k", type=int, default=10)
    se.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    se.set_defaults(func=cmd_search)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
