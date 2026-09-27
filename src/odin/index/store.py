from __future__ import annotations

import hashlib
import inspect
import pickle
import sqlite3
import zlib
from collections.abc import Callable, Iterable, Sequence
from importlib.metadata import version
from pathlib import Path
from types import ModuleType
from typing import Any


def code_fingerprint(*parts: ModuleType | Callable | str) -> str:
    """Hash of the source code (and versions) that produced some derived data.

    Cached results are keyed by this, so editing the chunker or a tokenizer invalidates
    exactly the entries it could have changed, with no version number to remember to bump.
    """
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode() if isinstance(p, str) else inspect.getsource(p).encode())
    return h.hexdigest()[:16]


class AnalysisCache:
    """A content-addressed, on-disk key/value store in one SQLite file.

    Keys are (blob id, fingerprint of the code that analyzed it), so an entry can never be
    stale: a blob's bytes never change, and a code change produces new keys. Values are
    pickled and zlib-compressed. WAL mode lets parallel evaluation runs share the file.
    """

    def __init__(self, path: Path, namespace: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.namespace = namespace
        self._db = sqlite3.connect(path, timeout=60, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.execute("CREATE TABLE IF NOT EXISTS kv (k BLOB PRIMARY KEY, v BLOB) WITHOUT ROWID")
        self.hits = 0
        self.misses = 0

    def _key(self, oid: str) -> bytes:
        return f"{self.namespace}:{oid}".encode()

    def get_many(self, oids: Sequence[str]) -> dict[str, Any]:
        out: dict[str, Any] = {}
        by_key = {self._key(o): o for o in oids}
        keys = list(by_key)
        for i in range(0, len(keys), 500):
            chunk = keys[i : i + 500]
            marks = ",".join("?" * len(chunk))
            for k, v in self._db.execute(f"SELECT k, v FROM kv WHERE k IN ({marks})", chunk):
                out[by_key[k]] = pickle.loads(zlib.decompress(v))
        self.hits += len(out)
        self.misses += len(oids) - len(out)
        return out

    def put_many(self, items: Iterable[tuple[str, Any]]) -> None:
        rows = [
            (self._key(o), zlib.compress(pickle.dumps(v, pickle.HIGHEST_PROTOCOL), 1))
            for o, v in items
        ]
        with self._db:
            self._db.executemany("INSERT OR REPLACE INTO kv VALUES (?, ?)", rows)

    def close(self) -> None:
        self._db.close()


def analyzer_fingerprint(tokenizer: Callable) -> str:
    from odin.index import chunker, snapshot
    from odin.parsing import python_symbols
    from odin.search import tokenize

    return code_fingerprint(
        chunker,
        python_symbols,
        tokenize,
        snapshot.analyze_blob,
        snapshot.BlobAnalysis,
        tokenizer.__qualname__,
        version("tree-sitter"),
        version("tree-sitter-python"),
    )
