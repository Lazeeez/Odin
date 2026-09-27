from __future__ import annotations

import json
import math
import random
import time
from collections.abc import Callable
from pathlib import Path

from odin.search.dense import DEFAULT_MODEL


def save_lora(module, out_dir: Path, r: int, alpha: int) -> None:
    """Save only the adapter matrices (fp16), in the format `dense.merge_lora` reads."""
    from safetensors.torch import save_file

    out_dir.mkdir(parents=True, exist_ok=True)
    tensors = {
        name.replace("base_model.model.", ""): p.detach().half().cpu().contiguous()
        for name, p in module.named_parameters()
        if "lora_" in name
    }
    save_file(tensors, str(out_dir / "lora.safetensors"))
    (out_dir / "lora.json").write_text(json.dumps({"r": r, "alpha": alpha}), encoding="utf-8")


def hard_negative_mrr(encoder, records: list[dict]) -> dict[str, float]:
    """How well an encoder ranks gold units against the ranker's hardest wrong candidates.

    A cheap proxy for retrieval quality: it needs only ~21 documents per issue instead of
    re-embedding whole repositories, and it measures exactly the confusions that matter.
    """
    import numpy as np

    rr, hit1 = [], []
    for r in records:
        if not r["pos"] or not r["neg"]:
            continue
        docs = r["pos"][:1] + r["neg"][:20]
        d = encoder.encode_documents(docs).astype(np.float32)
        s = d @ encoder.encode_query(r["query"])
        rank = 1 + int((s[1:] > s[0]).sum())
        rr.append(1 / rank)
        hit1.append(rank == 1)
    return {"mrr": float(np.mean(rr)), "hit@1": float(np.mean(hit1)), "n": len(rr)}


def train_embedder(
    records: list[dict],
    out_dir: Path,
    base: str = DEFAULT_MODEL,
    epochs: int = 1,
    batch: int = 16,
    lr: float = 5e-5,
    temperature: float = 0.05,
    max_query_tokens: int = 1024,
    max_doc_tokens: int = 512,
    seed: int = 0,
    log: Callable[[str], None] = print,
) -> None:
    """Contrastive LoRA fine-tuning of the code embedding model on bug reports.

    Each step takes `batch` issues with one gold unit and one hard negative each (a unit
    the learned ranker put near the top but the fix did not touch). Every issue must pick
    its gold unit out of all 2 x `batch` documents in the step, so it sees its own hard
    negative plus every other issue's gold and negative for free (InfoNCE with in-batch
    negatives). Only low-rank adapters are trained; the saved adapter is ~20 MB.
    """
    import torch
    from peft import LoraConfig, get_peft_model
    from sentence_transformers import SentenceTransformer

    random.seed(seed)
    torch.manual_seed(seed)
    model = SentenceTransformer(base, device="cuda", model_kwargs={"torch_dtype": torch.bfloat16})
    transformer = model[0]
    transformer.auto_model = get_peft_model(
        transformer.auto_model,
        LoraConfig(
            r=16, lora_alpha=32, lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
        ),
    )  # fmt: skip
    params = [p for p in model.parameters() if p.requires_grad]
    for p in params:
        p.data = p.data.float()
    transformer.auto_model.gradient_checkpointing_enable(
        gradient_checkpointing_kwargs={"use_reentrant": False}
    )
    transformer.auto_model.enable_input_require_grads()
    model.train()
    query_prompt = model.prompts["nl2code_query"]
    doc_prompt = model.prompts["nl2code_document"]

    def embed(texts: list[str], limit: int) -> torch.Tensor:
        model.max_seq_length = limit
        features = model.tokenize(texts)
        features = {k: v.to("cuda") if hasattr(v, "to") else v for k, v in features.items()}
        with torch.autocast("cuda", dtype=torch.bfloat16):
            out = model(features)["sentence_embedding"]
        return torch.nn.functional.normalize(out.float(), dim=-1)

    usable = [r for r in records if r["pos"] and r["neg"]]
    steps_per_epoch = len(usable) // batch
    total = epochs * steps_per_epoch
    warmup = max(1, total // 20)
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.LambdaLR(
        opt,
        lambda s: (
            (s + 1) / warmup
            if s < warmup
            else 0.5 * (1 + math.cos(math.pi * (s - warmup) / max(1, total - warmup)))
        ),
    )
    step, running, t0 = 0, 0.0, time.perf_counter()
    for _ in range(epochs):
        random.shuffle(usable)
        for i in range(steps_per_epoch):
            group = usable[i * batch : (i + 1) * batch]
            queries = [query_prompt + r["query"] for r in group]
            # The hardest negatives are the ranker's top mistakes; sample among the top 5.
            docs = [doc_prompt + random.choice(r["pos"]) for r in group]
            docs += [doc_prompt + random.choice(r["neg"][:5]) for r in group]
            q = embed(queries, max_query_tokens)
            d = embed(docs, max_doc_tokens)
            logits = q @ d.T / temperature
            loss = torch.nn.functional.cross_entropy(
                logits, torch.arange(len(group), device="cuda")
            )
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, 1.0)
            opt.step()
            sched.step()
            opt.zero_grad(set_to_none=True)
            running = 0.98 * running + 0.02 * loss.item() if step else loss.item()
            step += 1
            if step % 25 == 0 or step == total:
                log(
                    f"step {step}/{total} loss {running:.3f} ({step / (time.perf_counter() - t0):.2f} steps/s)"
                )
    save_lora(transformer.auto_model, out_dir, r=16, alpha=32)
    (out_dir / "training.json").write_text(
        json.dumps(
            {"base": base, "records": len(usable), "epochs": epochs, "batch": batch, "lr": lr}
        ),
        encoding="utf-8",
    )
