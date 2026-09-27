from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, runtime_checkable

import numpy as np

from odin.index.snapshot import SnapshotIndex, SnapshotIndexer
from odin.index.store import AnalysisCache, analyzer_fingerprint
from odin.repos import RepoCache
from odin.search.bm25 import BM25Params, top_k
from odin.search.dense import (
    DenseIndex,
    EmbeddingStore,
    Encoder,
    FusionParams,
    fuse,
    max_by_group,
)
from odin.search.graph import ExpandParams, expand
from odin.search.tokenize import TOKENIZERS

DEFAULT_CACHE = Path(".cache/repos")
DEFAULT_EMBEDDINGS = Path(".cache/embeddings")


@dataclass(frozen=True, slots=True)
class Query:
    instance_id: str
    repo: str
    base_commit: str
    text: str


class Retriever(Protocol):
    name: str

    def retrieve(self, query: Query, level: str, k: int) -> list[str]: ...


@runtime_checkable
class Indexing(Protocol):
    """Optional hooks. The runner times `prepare` separately so query latency stays honest."""

    def warmup(self, queries: Sequence[Query]) -> None: ...

    def prepare(self, query: Query, level: str) -> None: ...

    def close(self) -> None: ...


class BM25Retriever:
    def __init__(
        self,
        tokenizer: str = "code",
        params: BM25Params | None = None,
        exclude_tests: bool = False,
        expansion: ExpandParams | None = None,
        cache: RepoCache | None = None,
        name: str | None = None,
        analysis_cache: bool = True,
    ) -> None:
        self.name = name or f"bm25-{tokenizer}" + ("-notests" if exclude_tests else "")
        self.tokenize = TOKENIZERS[tokenizer]
        self.expansion = expansion or ExpandParams()
        cache = cache or RepoCache(DEFAULT_CACHE)
        disk = None
        if analysis_cache:
            # Lives beside the git mirrors, so tests with a temporary cache stay isolated.
            disk = AnalysisCache(
                cache.root.parent / "analysis.sqlite", analyzer_fingerprint(self.tokenize)
            )
        self.indexer = SnapshotIndexer(
            cache,
            self.tokenize,
            params or BM25Params(),
            exclude_tests=exclude_tests,
            disk=disk,
        )
        self._commit: tuple[str, str] | None = None
        self._indexes: dict[str, SnapshotIndex] = {}

    def warmup(self, queries: Sequence[Query]) -> None:
        commits: dict[str, set[str]] = defaultdict(set)
        for q in queries:
            commits[q.repo].add(q.base_commit)
        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda r: self.indexer.prefetch(r, commits[r]), commits))

    def prepare(self, query: Query, level: str) -> None:
        self._snapshot(query, level)

    def _snapshot(self, query: Query, level: str) -> SnapshotIndex:
        commit = (query.repo, query.base_commit)
        if commit != self._commit:
            self._indexes.clear()
            self._commit = commit
        if level not in self._indexes:
            self._indexes[level] = self.indexer.build(query.repo, query.base_commit, level)
        return self._indexes[level]

    def lexical_scores(self, query: Query, level: str) -> tuple[SnapshotIndex, np.ndarray]:
        index = self._snapshot(query, level)
        q = self.indexer.vocab.lookup(self.tokenize(query.text))
        return index, index.index.scores(q)

    def retrieve(self, query: Query, level: str, k: int) -> list[str]:
        index, scores = self.lexical_scores(query, level)
        if level == "function" and index.graph is not None:
            scores = expand(scores, index.graph, self.expansion)
        return [index.ids[i] for i in top_k(scores, k) if scores[i] > 0]

    def close(self) -> None:
        self.indexer.close()


class HybridRetriever(BM25Retriever):
    """Dense retrieval over function units, alone (`mode="dense"`) or fused with BM25.

    Units are embedded the first time any snapshot contains them, keyed by content hash in a
    persistent store, so re-running an evaluation or indexing a nearby commit embeds only
    what changed. File-level dense scores are each file's best unit (MaxP).
    """

    def __init__(
        self,
        encoder: Encoder,
        mode: str = "hybrid",
        fusion: FusionParams | None = None,
        exclude_tests: bool = True,
        store_root: Path | None = DEFAULT_EMBEDDINGS,
        cache: RepoCache | None = None,
        name: str | None = None,
    ) -> None:
        if mode not in ("dense", "hybrid"):
            raise ValueError(f"mode must be 'dense' or 'hybrid', not {mode!r}")
        super().__init__(
            tokenizer="code",
            exclude_tests=exclude_tests,
            cache=cache,
            name=name or (f"{mode}-notests" if exclude_tests else mode),
        )
        self.encoder = encoder
        self.mode = mode
        self.fusion = fusion or FusionParams()
        slug = encoder.name.replace("/", "__")
        self.store = EmbeddingStore(encoder.dim, store_root / slug if store_root else None)
        self.device = getattr(encoder, "device", "cpu")
        self.indexer.on_new_units = self._queue
        self.indexer.needs_text = lambda keys: any(k not in self.store for k in keys)
        self._pending: dict[bytes, str] = {}
        self._dense: DenseIndex | None = None
        self.units_embedded = 0

    def _queue(self, keys: list[bytes], texts: list[str]) -> None:
        for k, t in zip(keys, texts, strict=True):
            if k not in self.store:
                self._pending.setdefault(k, t)

    def _flush(self) -> None:
        if self._pending:
            keys = list(self._pending)
            self.store.add(keys, self.encoder.encode_documents(list(self._pending.values())))
            self.units_embedded += len(keys)
            self._pending.clear()
            if self.units_embedded % 5000 < len(keys):
                self.store.save()  # checkpoint long runs

    def _snapshot(self, query: Query, level: str) -> SnapshotIndex:
        fresh = (query.repo, query.base_commit) != self._commit
        index = super()._snapshot(query, level)
        if fresh or self._dense is None:
            fn = super()._snapshot(query, "function")
            self._flush()
            assert fn.unit_keys is not None
            self._dense = DenseIndex(self.store.matrix(fn.unit_keys), self.device)
        return index

    def embed_queries(self, texts: list[str]) -> np.ndarray:
        """Query-side embeddings, cached in the same content-addressed store as units."""
        from odin.index.snapshot import unit_key

        keys = [unit_key("query:" + t) for t in texts]
        missing = [(k, t) for k, t in zip(keys, texts, strict=True) if k not in self.store]
        if missing:
            batch = getattr(self.encoder, "encode_queries", None)
            texts_missing = [t for _, t in missing]
            vecs = (
                batch(texts_missing)
                if batch is not None
                else np.stack([self.encoder.encode_query(t) for t in texts_missing])
            )
            self.store.add([k for k, _ in missing], vecs.astype(np.float16))
        return self.store.matrix(keys).astype(np.float32)

    def dense_scores(self, query: Query) -> tuple[SnapshotIndex, np.ndarray]:
        fn = self._snapshot(query, "function")
        assert self._dense is not None
        return fn, self._dense.scores(self.embed_queries([query.text])[0])

    def scores(self, query: Query, level: str) -> tuple[list[str], np.ndarray, np.ndarray]:
        """Document ids with their lexical and dense scores at the requested level."""
        fn, dense = self.dense_scores(query)
        if level == "function":
            _, lexical = self.lexical_scores(query, "function")
            return fn.ids, lexical, dense
        files_index, lexical = self.lexical_scores(query, "file")
        assert fn.files == files_index.ids and fn.file_of_doc is not None
        return files_index.ids, lexical, max_by_group(dense, fn.file_of_doc, len(fn.files))

    def retrieve(self, query: Query, level: str, k: int) -> list[str]:
        ids, lexical, dense = self.scores(query, level)
        scores = dense if self.mode == "dense" else fuse(lexical, dense, self.fusion)
        return [ids[i] for i in top_k(scores, k) if np.isfinite(scores[i])]

    def report(self) -> dict:
        out = {"units_embedded": self.units_embedded, "embedding_store_size": len(self.store)}
        padded = getattr(self.encoder, "padded_tokens", 0)
        if padded:
            # Share of GPU work spent on real tokens rather than padding.
            out["padding_efficiency"] = round(self.encoder.tokens_encoded / padded, 3)
        return out

    def close(self) -> None:
        self._flush()
        self.store.save()
        super().close()
