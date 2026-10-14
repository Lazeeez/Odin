from __future__ import annotations

import copy
from collections.abc import Sequence
from pathlib import Path

import numpy as np

BASE_MODEL = "Qwen/Qwen3-Reranker-0.6B"
INSTRUCTION = (
    "Given a GitHub issue, judge whether this function is code that must be edited to "
    "resolve the issue"
)
_PREFIX = (
    "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query "
    'and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n'
    "<|im_start|>user\n"
)
_SUFFIX = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"


class CrossEncoderEnsemble:
    """Several fine-tuned rerankers voting: the mean of their per-query z-scored scores.

    Models trained on different negatives make different mistakes, so averaging them is a
    cheap way to cut variance. Each shares the same prompt; each pays its own forward pass.
    """

    def __init__(self, adapters: Sequence[Path], **kwargs) -> None:
        self.members = [CrossEncoder(adapter=a, **kwargs) for a in adapters]

    def score(self, query: str, docs: Sequence[str]) -> np.ndarray:
        if len(self.members) == 1:
            return self.members[0].score(query, docs)
        out = np.zeros(len(docs), np.float32)
        for m in self.members:
            s = m.score(query, docs)
            out += (s - s.mean()) / (s.std() + 1e-6)
        return out / len(self.members)


def base_model_of(adapter: Path | None) -> str:
    import json

    config = Path(adapter) / "adapter_config.json" if adapter is not None else None
    if config is not None and config.exists():
        return json.loads(config.read_text(encoding="utf-8"))["base_model_name_or_path"]
    return BASE_MODEL


class CrossEncoder:
    """An LLM reranker that reads the issue and one candidate together and answers yes/no.

    The relevance score is logit(yes) - logit(no) at the final position. Every candidate of
    a query shares the same long prefix (instructions + issue), so it is run once and its
    key/value cache is reused for all candidates: only each candidate's own tokens are
    computed, which is most of the cost saved when the issue is long and functions short.
    """

    def __init__(
        self,
        adapter: Path | None = None,
        device: str = "cuda",
        max_query_tokens: int = 512,
        max_doc_tokens: int = 256,
        batch: int = 32,
        base: str | None = None,
    ) -> None:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.torch = torch
        self.device = device
        base = base or base_model_of(adapter)
        self.base = base
        self.tok = AutoTokenizer.from_pretrained(base)
        dtype = torch.bfloat16 if device.startswith("cuda") else torch.float32
        model = AutoModelForCausalLM.from_pretrained(base, dtype=dtype).to(device)
        if adapter is not None:
            from peft import PeftModel

            model = PeftModel.from_pretrained(model, str(adapter)).merge_and_unload()
        self.model = model.eval()
        self.yes = self.tok.convert_tokens_to_ids("yes")
        self.no = self.tok.convert_tokens_to_ids("no")
        self.max_query_tokens = max_query_tokens
        self.max_doc_tokens = max_doc_tokens
        self.batch = batch
        self.tokens_computed = 0
        self._fixed_ids: dict[str, list[int]] = {}

    def _ids(self, text: str, limit: int) -> list[int]:
        return self.tok(text, add_special_tokens=False)["input_ids"][:limit]

    def _fixed(self, text: str) -> list[int]:
        if text not in self._fixed_ids:  # prompt scaffolding: tokenize once, not per call
            self._fixed_ids[text] = self.tok(text, add_special_tokens=False)["input_ids"]
        return self._fixed_ids[text]

    def prefix_ids(self, query: str) -> list[int]:
        head = self._fixed(f"{_PREFIX}<Instruct>: {INSTRUCTION}\n<Query>: ")
        return head + self._ids(query, self.max_query_tokens) + self._fixed("\n<Document>: ")

    def doc_ids(self, doc: str) -> list[int]:
        return self._ids(doc, self.max_doc_tokens) + self._fixed(_SUFFIX)

    def score(self, query: str, docs: Sequence[str]) -> np.ndarray:
        if not docs:
            return np.zeros(0, np.float32)
        torch = self.torch
        prefix = torch.tensor([self.prefix_ids(query)], device=self.device)
        with torch.no_grad():
            cache = self.model(prefix, use_cache=True, logits_to_keep=1).past_key_values
            self.tokens_computed += prefix.shape[1]
            out = np.zeros(len(docs), np.float32)
            encoded = [self.doc_ids(d) for d in docs]
            # Similar lengths share a batch, so right-padding wastes little.
            order = np.argsort([len(e) for e in encoded])
            for start in range(0, len(order), self.batch):
                idx = order[start : start + self.batch]
                out[idx] = self._score_batch(cache, prefix.shape[1], [encoded[i] for i in idx])
        return out

    def forward_last(self, seqs: list[list[int]], cache=None, n_prefix: int = 0):
        """yes-minus-no logit at each sequence's final token.

        Sequences are left-padded so every final token sits in the last column; with
        `logits_to_keep=1` only that column is projected onto the 151k-token vocabulary,
        instead of every position (gigabytes at training batch sizes).
        """
        torch = self.torch
        width = max(len(q) for q in seqs)
        # Build on the host and transfer once: per-row writes into device tensors would be
        # a separate host-to-device copy (and sync) for every sequence.
        ids = np.zeros((len(seqs), width), np.int64)
        mask = np.zeros((len(seqs), n_prefix + width), np.int64)
        mask[:, :n_prefix] = 1
        positions = np.zeros((len(seqs), width), np.int64)
        for i, q in enumerate(seqs):
            ids[i, width - len(q) :] = q
            mask[i, n_prefix + width - len(q) :] = 1
            positions[i, width - len(q) :] = np.arange(n_prefix, n_prefix + len(q))
        logits = self.model(
            input_ids=torch.from_numpy(ids).to(self.device, non_blocking=True),
            attention_mask=torch.from_numpy(mask).to(self.device, non_blocking=True),
            position_ids=torch.from_numpy(positions).to(self.device, non_blocking=True),
            past_key_values=cache,
            use_cache=cache is not None,
            logits_to_keep=1,
        ).logits[:, -1]
        self.tokens_computed += sum(len(q) for q in seqs)
        return logits[:, self.yes] - logits[:, self.no]

    def _score_batch(self, cache, n_prefix: int, docs: list[list[int]]) -> np.ndarray:
        batch_cache = copy.deepcopy(cache)
        batch_cache.batch_repeat_interleave(len(docs))
        return self.forward_last(docs, batch_cache, n_prefix).float().cpu().numpy()

    def score_uncached(self, query: str, docs: Sequence[str]) -> np.ndarray:
        """Reference implementation (full prompt per candidate), used to test the cache."""
        torch = self.torch
        pre = self.prefix_ids(query)
        out = []
        with torch.no_grad():
            for d in docs:
                ids = torch.tensor([pre + self.doc_ids(d)], device=self.device)
                final = self.model(ids).logits[0, -1]
                out.append(float(final[self.yes] - final[self.no]))
        return np.array(out, np.float32)
