from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np

DEFAULT_MODEL = "jinaai/jina-code-embeddings-0.5b"


class Encoder(Protocol):
    name: str
    dim: int

    def encode_documents(self, texts: Sequence[str]) -> np.ndarray: ...

    def encode_query(self, text: str) -> np.ndarray: ...


class EmbeddingStore:
    """Append-only `content hash -> unit vector` cache, persisted across runs.

    Keys are hashes of a unit's text, so a function that is unchanged across a hundred
    commits (or moves between files) is embedded exactly once. Vectors are stored as float16:
    half the memory, and cosine ranking is insensitive to the lost precision.
    """

    def __init__(self, dim: int, root: Path | None = None) -> None:
        self.dim = dim
        self.root = root
        self._rows: dict[bytes, int] = {}
        self._keys: list[bytes] = []  # row -> key; the invariant is _rows[_keys[i]] == i
        self._vecs = np.zeros((1024, dim), np.float16)
        self._saved = 0
        if root is not None and (root / "vecs.npy").exists():
            keys = (root / "keys.bin").read_bytes()
            vecs = np.load(root / "vecs.npy")
            if vecs.shape[1] != dim or len(keys) != 16 * len(vecs):
                raise ValueError(f"embedding cache at {root} does not match dim={dim}")
            self._vecs = np.array(vecs, np.float16)
            self._keys = [keys[i * 16 : (i + 1) * 16] for i in range(len(vecs))]
            self._rows = {k: i for i, k in enumerate(self._keys)}
            if len(self._rows) != len(self._keys):
                raise ValueError(f"embedding cache at {root} has duplicate keys; rebuild it")
            self._saved = len(vecs)

    def __len__(self) -> int:
        return len(self._keys)

    def __contains__(self, key: bytes) -> bool:
        return key in self._rows

    def add(self, keys: Sequence[bytes], vecs: np.ndarray) -> None:
        """Append vectors for keys not stored yet. Repeated or known keys are skipped.

        Row indices come from an explicit row list, never from the number of distinct keys:
        a batch holding the same key twice (two identical issue texts) must not shift where
        later rows land.
        """
        fresh: dict[bytes, int] = {}
        for i, k in enumerate(keys):
            if k not in self._rows and k not in fresh:
                fresh[k] = i
        if not fresh:
            return
        n = len(self._keys)
        need = n + len(fresh)
        if need > len(self._vecs):
            # Amortized O(1) appends: grow geometrically instead of re-allocating per batch.
            grown = np.zeros((max(need, 2 * len(self._vecs)), self.dim), np.float16)
            grown[:n] = self._vecs[:n]
            self._vecs = grown
        self._vecs[n:need] = np.asarray(vecs)[list(fresh.values())]
        for j, k in enumerate(fresh):
            self._rows[k] = n + j
            self._keys.append(k)

    def matrix(self, keys: Sequence[bytes]) -> np.ndarray:
        return self._vecs[np.fromiter((self._rows[k] for k in keys), np.int64, len(keys))]

    def truncate(self, n: int) -> None:
        """Drop every row from `n` on (used to repair a cache from a known-good prefix)."""
        for k in self._keys[n:]:
            del self._rows[k]
        del self._keys[n:]
        self._saved = -1  # force the next save

    def save(self) -> None:
        n = len(self._keys)
        if self.root is None or n == self._saved:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        keys = b"".join(self._keys)
        # Write-then-rename, so an interrupted save never leaves a torn cache behind.
        tmp_vecs, tmp_keys = self.root / "vecs.tmp.npy", self.root / "keys.tmp"
        np.save(tmp_vecs, self._vecs[:n])
        tmp_keys.write_bytes(keys)
        os.replace(tmp_vecs, self.root / "vecs.npy")
        os.replace(tmp_keys, self.root / "keys.bin")
        self._saved = n


def token_budget_batches(lengths: Sequence[int], budget: int) -> list[np.ndarray]:
    """Group items so each padded batch holds at most `budget` tokens.

    A padded batch costs (items x longest item). Sorting by length makes each batch's
    longest item its last one, and packing greedily up to the budget lets hundreds of short
    functions share one forward pass while long ones go a few at a time.
    """
    order = np.argsort(np.asarray(lengths), kind="stable")
    batches: list[np.ndarray] = []
    start = 0
    for end in range(1, len(order) + 1):
        longest = lengths[order[end - 1]]
        if (end - start) * max(longest, 1) > budget and end - 1 > start:
            batches.append(order[start : end - 1])
            start = end - 1
    if start < len(order):
        batches.append(order[start:])
    return batches


def merge_lora(module, adapter: Path) -> None:
    """Fold low-rank adapters into a model's weights: W += (B @ A) * alpha / r.

    Adapters are stored as just their A and B matrices (`lora.safetensors` + `lora.json`),
    about 2% of the model's size, and merged once at load so inference pays nothing extra.
    """
    import json

    import torch
    from safetensors.torch import load_file

    cfg = json.loads((adapter / "lora.json").read_text(encoding="utf-8"))
    tensors = load_file(str(adapter / "lora.safetensors"))
    params = dict(module.named_parameters())
    scale = cfg["alpha"] / cfg["r"]
    suffix = ".lora_A.default.weight"
    with torch.no_grad():
        for key, a in tensors.items():
            if not key.endswith(suffix):
                continue
            prefix = key[: -len(suffix)]
            b = tensors[f"{prefix}.lora_B.default.weight"]
            w = params[f"{prefix}.weight"]
            w += (b.float() @ a.float() * scale).to(w.device, w.dtype)


class SentenceEncoder:
    """A sentence-transformers model with task prompts, fp16 on GPU, and budgeted batches."""

    def __init__(
        self,
        model: str = DEFAULT_MODEL,
        device: str | None = None,
        max_doc_tokens: int = 512,
        max_query_tokens: int = 1024,
        token_budget: int = 4096,
        query_prompt: str = "nl2code_query",
        document_prompt: str = "nl2code_document",
        adapter: Path | None = None,
        revision: str | None = None,
        trust_remote_code: bool = False,
    ) -> None:
        import torch
        from sentence_transformers import SentenceTransformer

        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        dtype = torch.float16 if self.device.startswith("cuda") else torch.float32
        self.model = SentenceTransformer(
            model,
            device=self.device,
            model_kwargs={"torch_dtype": dtype},
            revision=revision,
            trust_remote_code=trust_remote_code,
        )
        self.name = model
        if adapter is not None:
            merge_lora(self.model[0].auto_model, Path(adapter))
            # A fine-tuned model embeds differently: give it its own cache namespace.
            self.name = f"{model}+{Path(adapter).name}"
        dimension = getattr(self.model, "get_embedding_dimension", None)
        self.dim = (dimension or self.model.get_sentence_embedding_dimension)()
        self.max_doc_tokens = max_doc_tokens
        self.max_query_tokens = max_query_tokens
        self.token_budget = token_budget
        self.query_prompt = query_prompt
        self.document_prompt = document_prompt
        self.tokens_encoded = 0
        self.padded_tokens = 0

    def encode_documents(self, texts: Sequence[str]) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.dim), np.float16)
        self.model.max_seq_length = self.max_doc_tokens
        ids = self.model.tokenizer(
            list(texts), add_special_tokens=True, truncation=True, max_length=self.max_doc_tokens
        )["input_ids"]
        lengths = [len(x) for x in ids]
        out = np.zeros((len(texts), self.dim), np.float16)
        for batch in token_budget_batches(lengths, self.token_budget):
            vecs = self.model.encode(
                [texts[i] for i in batch],
                prompt_name=self.document_prompt,
                batch_size=len(batch),
                normalize_embeddings=True,
                convert_to_numpy=True,
            )
            out[batch] = vecs
            self.tokens_encoded += sum(lengths[i] for i in batch)
            self.padded_tokens += len(batch) * max(lengths[i] for i in batch)
        return out

    def encode_query(self, text: str) -> np.ndarray:
        return self.encode_queries([text])[0]

    def encode_queries(self, texts: Sequence[str]) -> np.ndarray:
        """Several queries in one forward pass (e.g. an issue and its title)."""
        self.model.max_seq_length = self.max_query_tokens
        return self.model.encode(
            list(texts), prompt_name=self.query_prompt, normalize_embeddings=True
        ).astype(np.float32)


class DenseIndex:
    """Exact inner-product search over one snapshot's unit vectors.

    At tens of thousands of vectors an exact mat-vec is about a millisecond, cheaper than
    building any approximate index (HNSW, IVF) per commit, and it never misses a neighbour.
    """

    def __init__(self, vectors: np.ndarray, device: str = "cpu") -> None:
        self.device = device
        if device.startswith("cuda"):
            import torch

            self._matrix = torch.from_numpy(vectors).to(device)
        else:
            self._matrix = vectors.astype(np.float32)

    def scores(self, query: np.ndarray) -> np.ndarray:
        if self.device.startswith("cuda"):
            import torch

            q = torch.from_numpy(query.astype(np.float16)).to(self.device)
            return (self._matrix @ q).float().cpu().numpy()
        return self._matrix @ query.astype(np.float32)


@dataclass(frozen=True, slots=True)
class FusionParams:
    """How lexical and dense rankings are combined.

    `rrf`: reciprocal rank fusion, sum of w / (k + rank), which ignores score scales.
    `zsum`: weighted sum of per-query z-scored scores, which keeps how far ahead a hit is.
    """

    method: str = "rrf"
    dense_weight: float = 0.5
    k: int = 60
    depth: int = 1000

    def __str__(self) -> str:
        extra = f" k={self.k}" if self.method == "rrf" else ""
        return f"{self.method} w_dense={self.dense_weight}{extra}"


def _ranks(scores: np.ndarray, depth: int) -> np.ndarray:
    """1-based rank of each document within the top `depth`, and inf beyond it."""
    from odin.search.bm25 import top_k

    ranks = np.full(len(scores), np.inf)
    top = top_k(scores, depth)
    ranks[top] = np.arange(1, len(top) + 1)
    return ranks


def _z(scores: np.ndarray) -> np.ndarray:
    """Z-score over the finite entries; non-finite ones (a file with no units) go last."""
    finite = np.isfinite(scores)
    if not finite.any():
        return np.zeros(len(scores))
    vals = scores[finite]
    std = vals.std()
    z = np.full(len(scores), 0.0)
    z[finite] = (vals - vals.mean()) / std if std > 0 else 0.0
    z[~finite] = z[finite].min() - 1.0
    return z


def fuse(lexical: np.ndarray, dense: np.ndarray, p: FusionParams) -> np.ndarray:
    w = p.dense_weight
    if p.method == "rrf":
        return (1 - w) / (p.k + _ranks(lexical, p.depth)) + w / (p.k + _ranks(dense, p.depth))
    if p.method == "zsum":
        return (1 - w) * _z(lexical) + w * _z(dense)
    raise ValueError(f"unknown fusion method {p.method!r}")


def max_by_group(scores: np.ndarray, group: np.ndarray, n_groups: int) -> np.ndarray:
    """Per-group maximum (e.g. a file's best function) in one unbuffered ufunc pass."""
    out = np.full(n_groups, -np.inf, np.float32)
    np.maximum.at(out, group, scores)
    return out
