from __future__ import annotations

import hashlib
import os
import re
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from dataclasses import dataclass, field, replace
from itertools import repeat

import numpy as np
import scipy.sparse as sp

from odin.index.chunker import MODULE, chunk_file
from odin.index.store import AnalysisCache
from odin.repos import BlobReader, RepoCache, TreeEntry
from odin.search.bm25 import BM25Index, BM25Params, TermVec, Vocab, tf_matrix
from odin.search.tokenize import Tokenizer

_PATH_SPLIT = re.compile(r"[/._-]+")
# Below this many unseen blobs, process start-up and pickling cost more than they save.
_PARALLEL_MIN_BLOBS = 32
# A call whose name resolves to more definitions than this is too ambiguous to follow.
_MAX_CANDIDATES_BEFORE_SCOPE = 64


@dataclass(frozen=True, slots=True)
class BlobDocs:
    """Everything derived from one blob's bytes, flattened for fast snapshot assembly.

    Path-independent, so it is shared by every snapshot containing the blob. Entries of
    function-level units come first (`rows` = unit index), module-level entries last, so a
    function-level build takes a prefix slice and a file-level build takes everything.
    """

    qualnames: tuple[str, ...]
    ids: np.ndarray
    tfs: np.ndarray
    rows: np.ndarray
    n_unit_entries: int
    def_names: np.ndarray  # per unit: interned last component of its qualname
    call_rows: np.ndarray  # per call edge: calling unit
    call_names: np.ndarray  # per call edge: interned callee name
    unit_keys: tuple[bytes, ...]  # per unit: content hash of its text, keys the embedding cache


@dataclass(slots=True)
class SnapshotIndex:
    ids: list[str]
    index: BM25Index
    # Function level only: graph[i, j] > 0 when unit i calls unit j, weighted by 1/ambiguity.
    graph: sp.csr_matrix | None = None
    # Function level only: per document, its content hash and the index of its file.
    unit_keys: list[bytes] | None = None
    file_of_doc: np.ndarray | None = None
    files: list[str] | None = None
    oids: list[str] | None = None  # blob id of each file, to fetch a unit's text on demand


def unit_text(qualname: str, text: str) -> str:
    """What a unit is indexed and embedded as: its qualified name, then its own lines."""
    return f"{qualname}\n{text}"


def unit_key(text: str) -> bytes:
    """Stable content hash (not Python's salted hash), so keys persist across processes."""
    return hashlib.blake2b(text.encode("utf-8", "replace"), digest_size=16).digest()


@dataclass(slots=True)
class IndexStats:
    files_indexed: int = 0
    blobs_parsed: int = 0
    blobs_fetched: int = 0
    blobs_cached: int = 0  # loaded from the on-disk analysis cache instead of parsed

    @property
    def reuse_ratio(self) -> float:
        return 1 - self.blobs_parsed / self.files_indexed if self.files_indexed else 0.0


@dataclass(frozen=True, slots=True)
class BlobAnalysis:
    """Worker output: term counts against a blob-local term table, as compact arrays.

    The main process owns the global vocabulary, so it only has to intern each blob's
    distinct terms and remap `local_ids` with one gather, instead of one dict lookup per
    (chunk, term) pair.
    """

    qualnames: list[str]
    calls: list[tuple[str, ...]]
    terms: list[str]
    local_ids: np.ndarray
    tfs: np.ndarray
    rows: np.ndarray
    n_unit_entries: int
    unit_keys: list[bytes]
    unit_texts: list[str] | None


def analyze_blob(source: bytes, tokenizer: Tokenizer, keep_text: bool = False) -> BlobAnalysis:
    """Parse, chunk and count one file. Pure, so it can run in a worker process."""
    chunks = chunk_file(source, "")
    units = [c for c in chunks if c.kind != MODULE]
    texts = [unit_text(c.qualname, c.text) for c in units]
    counts: list[Counter[str]] = [tokenizer(t) for t in texts]
    counts += [tokenizer(c.text) for c in chunks if c.kind == MODULE]
    local: dict[str, int] = {}
    ids = [local.setdefault(t, len(local)) for c in counts for t in c]
    return BlobAnalysis(
        qualnames=[c.qualname for c in units],
        calls=[c.calls for c in units],
        terms=list(local),
        local_ids=np.array(ids, np.int32),
        tfs=np.fromiter((n for c in counts for n in c.values()), np.float32, len(ids)),
        rows=np.repeat(np.arange(len(counts), dtype=np.int32), [len(c) for c in counts]),
        n_unit_entries=sum(len(c) for c in counts[: len(units)]),
        unit_keys=[unit_key(t) for t in texts],
        unit_texts=texts if keep_text else None,
    )


@dataclass(slots=True)
class SnapshotIndexer:
    """Builds BM25 indexes of a repository at any commit, content-addressed by blob oid.

    SWE-bench has many issues per repository at different base commits. Most files are
    byte-identical between nearby commits, so each blob is read, parsed and tokenized once
    and every later snapshot that contains it reuses the result.
    """

    cache: RepoCache
    tokenizer: Tokenizer
    params: BM25Params = field(default_factory=BM25Params)
    exclude_tests: bool = False
    max_fanout: int = 5
    workers: int = field(default_factory=lambda: min(8, os.cpu_count() or 1))
    # Called with (keys, texts) of units in blobs seen for the first time, e.g. to embed them.
    on_new_units: Callable[[list[bytes], list[str]], None] | None = None
    # Returns True when any of these unit keys still needs its text (e.g. to be embedded).
    needs_text: Callable[[Sequence[bytes]], bool] | None = None
    disk: AnalysisCache | None = None
    vocab: Vocab = field(default_factory=Vocab)
    stats: IndexStats = field(default_factory=IndexStats)
    _names: dict[str, int] = field(default_factory=dict)
    _blobs: dict[str, BlobDocs] = field(default_factory=dict)
    _paths: dict[str, TermVec] = field(default_factory=dict)
    _repo: str | None = None
    _reader: BlobReader | None = None
    _pool: ProcessPoolExecutor | None = None
    _text_cache: dict[str, dict[str, str]] = field(default_factory=dict)

    def prefetch(self, repo: str, commits: Iterable[str]) -> None:
        """Fetch every source blob of every commit in one request instead of per file."""
        oids = {e.oid for c in commits for e in self._entries(repo, c)}
        self.stats.blobs_fetched += self.cache.fetch_blobs(repo, oids)

    def build(self, repo: str, commit: str, level: str) -> SnapshotIndex:
        self._switch_repo(repo)
        entries = self._entries(repo, commit)
        blobs = self._blob_docs([e.oid for e in entries])
        path_vecs = [self._path_vec(e.path) for e in entries]

        doc_ids: list[str] = []
        docs_per_file = np.zeros(len(entries), np.int64)
        ids, tfs, rows = [], [], []
        for f, e in enumerate(entries):
            bd = blobs[e.oid]
            if level == "file":
                ids.append(bd.ids)
                tfs.append(bd.tfs)
                doc_ids.append(e.path)
                docs_per_file[f] = 1
            else:
                n = bd.n_unit_entries
                ids.append(bd.ids[:n])
                tfs.append(bd.tfs[:n])
                rows.append(bd.rows[:n] + len(doc_ids))
                doc_ids.extend(f"{e.path}::{q}" for q in bd.qualnames)
                docs_per_file[f] = len(bd.qualnames)

        n_docs, n_terms = len(doc_ids), len(self.vocab)
        if level == "file":
            row = np.repeat(np.arange(len(entries)), [len(a) for a in ids])
        else:
            row = np.concatenate(rows) if rows else np.zeros(0, np.int64)
        content = sp.csc_matrix(
            (_cat(tfs, np.float32), (row, _cat(ids, np.int32))), shape=(n_docs, n_terms)
        )
        # Every document also carries its file's path terms: doc->file indicator @ path terms.
        file_of_doc = np.repeat(np.arange(len(entries)), docs_per_file)
        doc_file = sp.csr_matrix(
            (np.ones(n_docs, np.float32), (np.arange(n_docs), file_of_doc)),
            shape=(n_docs, len(entries)),
        )
        tf = content + doc_file @ tf_matrix(path_vecs, n_terms)
        self.stats.files_indexed += len(entries)
        index = SnapshotIndex(doc_ids, BM25Index(tf, self.params))
        if level == "function":
            index.graph = self._call_graph([blobs[e.oid] for e in entries], file_of_doc)
            index.unit_keys = [k for e in entries for k in blobs[e.oid].unit_keys]
            index.file_of_doc = file_of_doc
            index.files = [e.path for e in entries]
            index.oids = [e.oid for e in entries]
        return index

    def _call_graph(self, blobs: list[BlobDocs], file_of_doc: np.ndarray) -> sp.csr_matrix:
        """Resolve call names to units by name, entirely with array joins.

        Python has no static types, so `x.save()` could be any `save`. Resolution prefers a
        definition in the caller's own file, otherwise every same-named unit in the repo,
        and drops the call when that leaves more than `max_fanout` candidates. Each call's
        weight is split evenly across its candidates.
        """
        n_docs = len(file_of_doc)
        units = np.array([len(b.qualnames) for b in blobs], np.int64)
        offsets = np.cumsum(units) - units
        def_name = _cat([b.def_names for b in blobs], np.int32)
        caller_of_call = _cat(
            [b.call_rows + o for b, o in zip(blobs, offsets, strict=True)], np.int64
        )
        call_name = _cat([b.call_names for b in blobs], np.int32)

        order = np.argsort(def_name, kind="stable")
        by_name = def_name[order]
        lo = np.searchsorted(by_name, call_name, "left")
        n_cand = np.searchsorted(by_name, call_name, "right") - lo
        n_cand[n_cand > _MAX_CANDIDATES_BEFORE_SCOPE] = 0

        # One row per (call, candidate definition) pair.
        call_idx = np.repeat(np.arange(len(call_name)), n_cand)
        first = np.repeat(np.cumsum(n_cand) - n_cand, n_cand)
        cand = order[lo[call_idx] + np.arange(len(call_idx)) - first]
        caller = caller_of_call[call_idx]

        not_self = cand != caller
        same_file = not_self & (file_of_doc[cand] == file_of_doc[caller])
        has_local = np.bincount(call_idx, weights=same_file, minlength=len(call_name)) > 0
        keep = not_self & (same_file | ~has_local[call_idx])
        kept = np.bincount(call_idx[keep], minlength=len(call_name))
        keep &= kept[call_idx] <= self.max_fanout

        weight = 1.0 / kept[call_idx[keep]]
        g = sp.csr_matrix(
            (weight.astype(np.float32), (caller[keep], cand[keep])), shape=(n_docs, n_docs)
        )
        g.sum_duplicates()
        return g

    def _entries(self, repo: str, commit: str) -> list[TreeEntry]:
        entries = self.cache.list_tree(repo, commit, suffix=".py")
        if self.exclude_tests:
            entries = [e for e in entries if not _is_test_path(e.path)]
        return entries

    def _switch_repo(self, repo: str) -> None:
        # Blob memo is per repository; drop the previous one to bound memory.
        if repo != self._repo:
            if self._reader is not None:
                self._reader.close()
            self._blobs.clear()
            self._reader = self.cache.blob_reader(repo)
            self._repo = repo

    def _blob_docs(self, oids: list[str]) -> dict[str, BlobDocs]:
        todo = [o for o in dict.fromkeys(oids) if o not in self._blobs]
        if not todo:
            return {o: self._blobs[o] for o in oids}
        analyses = self.disk.get_many(todo) if self.disk is not None else {}
        if self.needs_text is not None:
            # The disk cache holds no source text; re-parse blobs with units still to embed.
            analyses = {o: a for o, a in analyses.items() if not self.needs_text(a.unit_keys)}
        parse = [o for o in todo if o not in analyses]
        if parse:
            analyses.update(zip(parse, self._analyze(parse), strict=True))
            if self.disk is not None:
                self.disk.put_many((o, replace(analyses[o], unit_texts=None)) for o in parse)
        for oid in todo:
            a = analyses[oid]
            self._blobs[oid] = self._intern(a)
            if self.on_new_units is not None and a.unit_texts:
                self.on_new_units(a.unit_keys, a.unit_texts)
        self.stats.blobs_parsed += len(parse)
        self.stats.blobs_cached += len(todo) - len(parse)
        return {o: self._blobs[o] for o in oids}

    def _analyze(self, oids: list[str]) -> list[BlobAnalysis]:
        assert self._reader is not None and self._repo is not None
        self.cache.fetch_blobs(self._repo, oids)
        sources = [self._reader.read(o) for o in oids]
        keep = self.on_new_units is not None
        if len(oids) >= _PARALLEL_MIN_BLOBS and self.workers > 1:
            # tree-sitter parsing holds the GIL, so fan out to processes, not threads.
            if self._pool is None:
                self._pool = ProcessPoolExecutor(self.workers, mp_context=get_context("spawn"))
            return list(
                self._pool.map(
                    analyze_blob, sources, repeat(self.tokenizer), repeat(keep), chunksize=32
                )
            )
        return [analyze_blob(s, self.tokenizer, keep) for s in sources]

    def _intern(self, a: BlobAnalysis) -> BlobDocs:
        """Map a blob's local term and call names onto the process-wide id spaces."""
        names = self._names
        return BlobDocs(
            qualnames=tuple(a.qualnames),
            ids=self.vocab.intern(a.terms)[a.local_ids],
            tfs=a.tfs,
            rows=a.rows,
            n_unit_entries=a.n_unit_entries,
            def_names=np.array(
                [names.setdefault(q.rsplit(".", 1)[-1], len(names)) for q in a.qualnames],
                np.int32,
            ),
            call_rows=np.repeat(np.arange(len(a.calls), dtype=np.int32), [len(c) for c in a.calls]),
            call_names=np.array(
                [names.setdefault(n, len(names)) for c in a.calls for n in c], np.int32
            ),
            unit_keys=tuple(a.unit_keys),
        )

    def _path_vec(self, path: str) -> TermVec:
        vec = self._paths.get(path)
        if vec is None:
            vec = self._paths[path] = self.vocab.vectorize(
                self.tokenizer(" ".join(_PATH_SPLIT.split(path.removesuffix(".py"))))
            )
        return vec

    def unit_texts(self, index: SnapshotIndex, rows: Sequence[int]) -> list[str]:
        """Source of the given function-level units, re-chunked from their blobs."""
        assert index.oids is not None and index.file_of_doc is not None and self._reader
        out = []
        for r in rows:
            oid = index.oids[index.file_of_doc[r]]
            chunks = self._text_cache.get(oid)
            if chunks is None:
                if len(self._text_cache) > 2048:
                    self._text_cache.clear()
                chunks = self._text_cache[oid] = {
                    c.qualname: unit_text(c.qualname, c.text)
                    for c in chunk_file(self._reader.read(oid), "")
                    if c.kind != MODULE
                }
            out.append(chunks[index.ids[r].split("::", 1)[1]])
        return out

    def close(self) -> None:
        if self._reader is not None:
            self._reader.close()
            self._reader = None
        if self._pool is not None:
            self._pool.shutdown(cancel_futures=True)
            self._pool = None
        if self.disk is not None:
            self.disk.close()
            self.disk = None


def _cat(parts: list[np.ndarray], dtype: type) -> np.ndarray:
    return np.concatenate(parts) if parts else np.zeros(0, dtype)


def _is_test_path(path: str) -> bool:
    parts = path.split("/")
    name = parts[-1]
    return (
        name.startswith("test_")
        or name.endswith("_test.py")
        or name == "conftest.py"
        or any(p in ("tests", "test", "testing") for p in parts[:-1])
    )
