"""Static embeddings (Model2Vec): a sentence vector is the weighted mean of token vectors.

No neural network runs at encode time, so a whole repository embeds in about a second, in
Python or in a browser. The website's ranker uses these for semantic search over every
function; web/src/engine/static.ts is the same computation, and the tests hold them equal.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

DEFAULT_STATIC = "minishlab/potion-code-16M"


class StaticEncoder:
    def __init__(
        self, repo: str = DEFAULT_STATIC, max_tokens: int = 512, quantize: bool = False
    ) -> None:
        from huggingface_hub import hf_hub_download
        from safetensors.numpy import load_file
        from tokenizers import Tokenizer

        self.name = repo
        self.max_tokens = max_tokens
        self.tokenizer = Tokenizer.from_file(hf_hub_download(repo, "tokenizer.json"))
        # Truncation counts [UNK]s, which are dropped afterwards (web/src/engine/static.ts too).
        self.tokenizer.enable_truncation(max_tokens)
        # The tokenizer file enables padding: batch encoding would pad every text to the longest
        # in its batch, and the [PAD] vectors would join the mean. Each text stands alone.
        self.tokenizer.no_padding()
        t = load_file(hf_hub_download(repo, "model.safetensors"))
        emb = t["embeddings"].astype(np.float32)
        if "mapping" in t:  # quantized vocabulary: token -> shared row, times a per-token weight
            emb = emb[t["mapping"]] * t["weights"].astype(np.float32)[:, None]
        if quantize:
            # What the website ships: int8 rows with one scale each (a quarter of the size).
            # Training on these exact vectors keeps the browser's features identical.
            self.scales = np.abs(emb).max(axis=1) / 127.0
            self.scales[self.scales == 0] = 1.0
            self.q = np.round(emb / self.scales[:, None]).astype(np.int8)
            emb = self.q.astype(np.float32) * self.scales[:, None]
        self.quantized = quantize
        self.table = emb
        self.dim = emb.shape[1]
        unk = self.tokenizer.token_to_id("[UNK]")
        self.unk = unk if unk is not None else -1

    def token_ids(self, text: str) -> list[int]:
        return [
            i for i in self.tokenizer.encode(text, add_special_tokens=False).ids if i != self.unk
        ]

    def encode(self, texts: Sequence[str]) -> np.ndarray:
        out = np.zeros((len(texts), self.dim), np.float32)
        for i, enc in enumerate(self.tokenizer.encode_batch(list(texts), add_special_tokens=False)):
            ids = [t for t in enc.ids if t != self.unk]
            if ids:
                v = self.table[ids].mean(axis=0)
                n = float(np.linalg.norm(v))
                out[i] = v / n if n > 0 else v
        return out


def export_browser_model(enc: StaticEncoder, path) -> int:
    """The format web/src/engine/static.ts reads: uint32 header length, JSON header (dim,
    maxTokens, unk, vocab), padding to 4 bytes, float32 row scales, int8 rows."""
    import json
    import struct
    from pathlib import Path

    assert enc.quantized, "export a quantize=True encoder, so the site matches training"
    vocab = enc.tokenizer.get_vocab()
    tokens = [""] * len(vocab)
    for t, i in vocab.items():
        tokens[i] = t
    header = json.dumps(
        {"dim": enc.dim, "maxTokens": enc.max_tokens, "unk": enc.unk, "pad": enc.tokenizer.token_to_id("[PAD]"), "vocab": tokens},
        ensure_ascii=False, separators=(",", ":"),
    ).encode("utf-8")  # fmt: skip
    pad = (4 - (4 + len(header)) % 4) % 4
    blob = struct.pack("<I", len(header)) + header + b"\0" * pad
    blob += enc.scales.astype("<f4").tobytes() + enc.q.tobytes()
    Path(path).write_bytes(blob)
    return len(blob)
