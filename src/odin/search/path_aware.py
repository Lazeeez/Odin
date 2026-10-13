from __future__ import annotations

from pathlib import Path

import numpy as np

from odin.index.snapshot import SnapshotIndex, unit_key
from odin.search.dense import DenseIndex, EmbeddingStore, Encoder, FusionParams
from odin.search.retriever import DEFAULT_EMBEDDINGS, HybridRetriever, Query

EMBED_BATCH = 4096


def path_header(unit_id: str) -> str:
    path, qualname = unit_id.split("::", 1)
    return f"{path}/{qualname.replace('.', '/')}"


def with_path(unit_id: str, text: str) -> str:
    return f"{path_header(unit_id)}\n{text.partition(chr(10))[2]}"


class PathAwareRetriever(HybridRetriever):
    def __init__(
        self,
        encoder: Encoder,
        mode: str = "hybrid",
        fusion: FusionParams | None = None,
        store_root: Path = DEFAULT_EMBEDDINGS,
        name: str | None = None,
    ) -> None:
        super().__init__(
            encoder, mode=mode, fusion=fusion, store_root=None, name=name or f"{mode}-path-notests"
        )
        slug = encoder.name.replace("/", "__") + "+path"
        self.store = EmbeddingStore(encoder.dim, store_root / slug)
        self.indexer.on_new_units = None
        self.indexer.needs_text = None

    def _path_keys(self, index: SnapshotIndex) -> list[bytes]:
        assert index.unit_keys is not None
        return [
            unit_key(f"{path_header(unit_id)}\0{content.hex()}")
            for unit_id, content in zip(index.ids, index.unit_keys, strict=True)
        ]

    def _embed_missing(self, index: SnapshotIndex, keys: list[bytes]) -> None:
        missing = [row for row, key in enumerate(keys) if key not in self.store]
        for start in range(0, len(missing), EMBED_BATCH):
            rows = missing[start : start + EMBED_BATCH]
            texts = self.indexer.unit_texts(index, rows)
            documents = [with_path(index.ids[r], t) for r, t in zip(rows, texts, strict=True)]
            self.store.add([keys[r] for r in rows], self.encoder.encode_documents(documents))
            self.units_embedded += len(rows)
        if missing:
            self.store.save()

    def _snapshot(self, query: Query, level: str) -> SnapshotIndex:
        fresh = (query.repo, query.base_commit) != self._commit
        index = super(HybridRetriever, self)._snapshot(query, level)
        if fresh or self._dense is None:
            functions = super(HybridRetriever, self)._snapshot(query, "function")
            keys = self._path_keys(functions)
            self._embed_missing(functions, keys)
            self._dense = DenseIndex(np.asarray(self.store.matrix(keys)), self.device)
        return index
