import hashlib

import numpy as np
import pytest

from odin.search.dense import (
    DenseIndex,
    EmbeddingStore,
    FusionParams,
    fuse,
    max_by_group,
    token_budget_batches,
)
from odin.search.retriever import HybridRetriever, Query
from odin.search.tokenize import code


class HashingEncoder:
    """Deterministic stand-in for a neural encoder: hashed bag of code tokens."""

    name = "test/hashing"
    dim = 256

    def __init__(self):
        self.documents_encoded = 0

    def _vec(self, text):
        v = np.zeros(self.dim, np.float32)
        for tok in code(text):
            v[int(hashlib.md5(tok.encode()).hexdigest(), 16) % self.dim] += 1
        n = np.linalg.norm(v)
        return v / n if n else v

    def encode_documents(self, texts):
        self.documents_encoded += len(texts)
        return np.stack([self._vec(t) for t in texts]).astype(np.float16)

    def encode_query(self, text):
        return self._vec(text)


def test_token_budget_batches_respect_budget_and_cover_everything():
    lengths = [5, 500, 7, 60, 3, 480, 40, 9]
    batches = token_budget_batches(lengths, budget=512)
    seen = sorted(i for b in batches for i in b)
    assert seen == list(range(len(lengths)))
    for b in batches:
        assert len(b) * max(lengths[i] for i in b) <= 512 or len(b) == 1
    # Short items share a batch; the two long ones cannot.
    assert len(batches) == 3


def test_token_budget_single_oversized_item_gets_own_batch():
    assert [b.tolist() for b in token_budget_batches([2000, 1], budget=100)] == [[1], [0]]


def test_embedding_store_roundtrip(tmp_path):
    store = EmbeddingStore(4, tmp_path)
    keys = [i.to_bytes(16, "big") for i in range(3000)]  # forces geometric growth
    vecs = np.random.default_rng(0).standard_normal((3000, 4)).astype(np.float16)
    store.add(keys, vecs)
    store.save()
    again = EmbeddingStore(4, tmp_path)
    assert len(again) == 3000
    assert np.array_equal(again.matrix([keys[2999], keys[0]]), vecs[[2999, 0]])
    with pytest.raises(ValueError):
        EmbeddingStore(8, tmp_path)


def test_rrf_rewards_agreement():
    lexical = np.array([3.0, 2.0, 1.0, 0.0])
    dense = np.array([0.1, 0.9, 0.8, 0.0])
    fused = fuse(lexical, dense, FusionParams("rrf", 0.5, k=1))
    assert np.argmax(fused) == 1  # 2nd lexically, 1st densely
    assert fuse(lexical, dense, FusionParams("rrf", 0.0, k=1)).argmax() == 0


def test_zsum_is_scale_invariant():
    lexical = np.array([30.0, 20.0, 10.0])
    dense = np.array([0.2, 0.3, 0.1])
    a = fuse(lexical, dense, FusionParams("zsum", 0.5))
    b = fuse(lexical * 100, dense, FusionParams("zsum", 0.5))
    assert np.allclose(a, b)


def test_max_by_group():
    got = max_by_group(np.array([0.1, 0.7, 0.3, 0.2], np.float32), np.array([0, 0, 2, 2]), 3)
    assert got[0] == pytest.approx(0.7) and got[2] == pytest.approx(0.3)
    assert got[1] == -np.inf


def test_dense_index_exact_inner_product():
    m = np.eye(3, dtype=np.float16)
    assert DenseIndex(m).scores(np.array([0.0, 1.0, 0.0])).tolist() == [0.0, 1.0, 0.0]


def test_hybrid_retriever_end_to_end_embeds_each_unit_once(local_repo, tmp_path):
    cache, first, second = local_repo
    enc = HashingEncoder()
    r = HybridRetriever(enc, mode="dense", store_root=tmp_path / "emb", cache=cache)
    q1 = Query("q1", "acme/pkg", first, "Session login verify password")
    assert r.retrieve(q1, "function", 1) == ["pkg/auth.py::Session.login"]
    assert r.retrieve(q1, "file", 1) == ["pkg/auth.py"]
    embedded_first = enc.documents_encoded
    q2 = Query("q2", "acme/pkg", second, "render template escape html")
    assert r.retrieve(q2, "function", 1) == ["pkg/render.py::render_template"]
    # Only the edited function is new at the second commit.
    assert enc.documents_encoded == embedded_first + 1
    r.close()

    # A fresh process reuses the persisted cache and embeds nothing.
    enc2 = HashingEncoder()
    r2 = HybridRetriever(enc2, mode="hybrid", store_root=tmp_path / "emb", cache=cache)
    assert r2.retrieve(q2, "function", 1) == ["pkg/render.py::render_template"]
    assert enc2.documents_encoded == 0
    r2.close()


def test_fusion_survives_files_without_units():
    # File-level dense scores are a max over units; a file with none is -inf.
    lexical = np.array([1.0, 3.0, 2.0])
    dense = np.array([0.9, -np.inf, 0.1])
    for p in (FusionParams("zsum", 0.8), FusionParams("rrf", 0.8, k=1)):
        fused = fuse(lexical, dense, p)
        assert np.isfinite(fused).all()
        assert fused.argmax() == 0  # dense-heavy fusion follows the dense winner


def test_dense_reparses_cached_blobs_whose_units_are_not_embedded(local_repo, tmp_path):
    from odin.search.retriever import BM25Retriever

    cache, first, _ = local_repo
    q = Query("q", "acme/pkg", first, "Session login verify password")
    BM25Retriever(cache=cache).retrieve(q, "function", 1)  # warms the text-free disk cache
    enc = HashingEncoder()
    r = HybridRetriever(enc, mode="dense", store_root=tmp_path / "emb", cache=cache)
    assert r.retrieve(q, "function", 1) == ["pkg/auth.py::Session.login"]
    assert enc.documents_encoded == 3  # all units embedded despite the cache hit
    r.close()


def test_embedding_store_survives_duplicate_keys_in_a_batch(tmp_path):
    # Regression: two identical issue texts in one batch used to shift every later row.
    store = EmbeddingStore(2, tmp_path)
    k = [bytes([i]) * 16 for i in range(4)]
    store.add([k[0], k[1], k[0]], np.array([[1, 0], [0, 1], [1, 0]], np.float16))
    store.add([k[2], k[1], k[3]], np.array([[2, 2], [9, 9], [3, 3]], np.float16))
    assert len(store) == 4
    want = {k[0]: [1, 0], k[1]: [0, 1], k[2]: [2, 2], k[3]: [3, 3]}
    for key, vec in want.items():
        assert store.matrix([key])[0].tolist() == vec  # k[1] kept its first vector
    store.save()
    again = EmbeddingStore(2, tmp_path)
    for key, vec in want.items():
        assert again.matrix([key])[0].tolist() == vec
