from __future__ import annotations

import json
import math
import random
import time
from collections.abc import Callable, Sequence
from pathlib import Path

import numpy as np

from odin.eval.ground_truth import GoldEntry
from odin.rank.cross_encoder import CrossEncoder
from odin.search.bm25 import top_k
from odin.search.dense import FusionParams, fuse
from odin.search.retriever import HybridRetriever, Query

LORA_TARGETS = ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]


def validation_split(qids: Sequence[str], n: int = 250, seed: int = 0) -> set[str]:
    """Queries held out from reranker training, to choose how much to trust it."""
    ordered = sorted(qids)
    random.Random(seed).shuffle(ordered)
    return set(ordered[:n])


def build_ce_data(
    retriever: HybridRetriever,
    fusion: FusionParams,
    gold: Sequence[GoldEntry],
    queries: dict[str, str],
    n_neg: int = 30,
    progress: Callable[[int, int], None] | None = None,
) -> list[dict]:
    """Per issue: its gold units' source and the source of the hardest wrong candidates."""
    todo = [g for g in gold if g.functions or g.classes]
    retriever.warmup([Query(g.instance_id, g.repo, g.base_commit, "") for g in todo])
    records = []
    for n, g in enumerate(todo, start=1):
        q = Query(g.instance_id, g.repo, g.base_commit, queries[g.instance_id])
        ids, lex, dense = retriever.scores(q, "function")
        fn = retriever._indexes["function"]
        targets = set(g.functions + g.classes)
        pos = [i for i, d in enumerate(ids) if d in targets]
        neg = [int(i) for i in top_k(fuse(lex, dense, fusion), 4 * n_neg) if ids[i] not in targets]
        neg = neg[:n_neg]
        texts = retriever.indexer.unit_texts(fn, pos + neg)
        records.append(
            {
                "qid": g.instance_id,
                "query": q.text,
                "pos": texts[: len(pos)],
                "neg": texts[len(pos) :],
            }
        )
        if progress:
            progress(n, len(todo))
    return records


def build_ce_data_from_ltr(
    retriever: HybridRetriever,
    data,
    gold: Sequence[GoldEntry],
    queries: dict[str, str],
    n_neg: int = 20,
    progress: Callable[[int, int], None] | None = None,
) -> list[dict]:
    """Like `build_ce_data`, but the negatives are what the reranker will actually face.

    At test time the cross-encoder reorders LambdaMART's top K, so its hardest mistakes are
    LambdaMART's top-ranked wrong units. Those are mined from out-of-fold LTR scores: the
    model that ranked each training issue never saw that issue, as at test time.
    """
    assert data.ids is not None and data.oof is not None, "run `odin ltr` first"
    rows_of = data.query_rows()
    by_id = {g.instance_id: g for g in gold}
    todo = [q for q in data.qids if q in by_id]
    retriever.warmup([Query(q, by_id[q].repo, by_id[q].base_commit, "") for q in todo])
    records = []
    for n, qid in enumerate(todo, start=1):
        g = by_id[qid]
        q = Query(qid, g.repo, g.base_commit, queries[qid])
        fn = retriever._snapshot(q, "function")
        row_of = {d: i for i, d in enumerate(fn.ids)}
        sl = rows_of[qid]
        ranked = data.ids[sl][np.argsort(-data.oof[sl], kind="stable")]
        targets = set(g.functions + g.classes)
        neg = [row_of[i] for i in ranked if i not in targets and i in row_of][:n_neg]
        pos = [row_of[t] for t in targets if t in row_of]
        texts = retriever.indexer.unit_texts(fn, pos + neg)
        records.append(
            {"qid": qid, "query": q.text, "pos": texts[: len(pos)], "neg": texts[len(pos) :]}
        )
        if progress:
            progress(n, len(todo))
    return records


def train_cross_encoder(
    records: list[dict],
    out_dir: Path,
    epochs: int = 1,
    group: int = 8,
    lr: float = 1e-4,
    seed: int = 0,
    log: Callable[[str], None] = print,
) -> None:
    """LoRA fine-tuning with a listwise loss: gold vs its hardest negatives, same issue."""
    import torch
    from peft import LoraConfig, get_peft_model

    random.seed(seed)
    torch.manual_seed(seed)
    ce = CrossEncoder()
    model = get_peft_model(
        ce.model,
        LoraConfig(
            r=16, lora_alpha=32, lora_dropout=0.05, target_modules=LORA_TARGETS,
            task_type="CAUSAL_LM",
        ),
    )  # fmt: skip
    for p in model.parameters():
        if p.requires_grad:
            p.data = p.data.float()  # fp32 adapters on a bf16 base for stable updates
    model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    model.enable_input_require_grads()
    model.train()
    ce.model = model
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    usable = [r for r in records if r["pos"] and r["neg"]]
    total = epochs * len(usable)
    warmup = max(1, total // 20)

    def schedule(step: int) -> float:
        if step < warmup:
            return (step + 1) / warmup
        return 0.5 * (1 + math.cos(math.pi * (step - warmup) / max(1, total - warmup)))

    sched = torch.optim.lr_scheduler.LambdaLR(opt, schedule)
    step, running, t0 = 0, 0.0, time.perf_counter()
    for _ in range(epochs):
        random.shuffle(usable)
        for rec in usable:
            docs = [random.choice(rec["pos"])] + random.sample(
                rec["neg"], min(group - 1, len(rec["neg"]))
            )
            prefix = ce.prefix_ids(rec["query"])
            with torch.autocast("cuda", dtype=torch.bfloat16):
                s = ce.forward_last([prefix + ce.doc_ids(d) for d in docs]).float()
            loss = torch.nn.functional.cross_entropy(
                s[None], torch.zeros(1, dtype=torch.long, device=s.device)
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            running = 0.98 * running + 0.02 * loss.item() if step else loss.item()
            step += 1
            if step % 50 == 0 or step == total:
                rate = step / (time.perf_counter() - t0)
                log(f"step {step}/{total} loss {running:.3f} ({rate:.2f} steps/s)")
    out_dir.mkdir(parents=True, exist_ok=True)
    # fp32 was for stable updates; inference merges into a bf16 model, so ship fp16 (half size).
    for p in params:
        p.data = p.data.half()
    model.save_pretrained(str(out_dir))
    (out_dir / "training.json").write_text(
        json.dumps({"records": len(usable), "epochs": epochs, "group": group, "lr": lr}),
        encoding="utf-8",
    )


def rerank(base: np.ndarray, ce_scores: np.ndarray, weight: float) -> np.ndarray:
    """Blend a first-stage score with cross-encoder scores for the same candidates.

    Both are z-normalized over the reranked candidates, so `weight` means the same thing
    for every query. `weight=inf` trusts the cross-encoder alone.
    """

    def z(x: np.ndarray) -> np.ndarray:
        return (x - x.mean()) / x.std() if x.std() > 0 else np.zeros_like(x)

    if math.isinf(weight):
        return ce_scores
    return z(base) + weight * z(ce_scores)
