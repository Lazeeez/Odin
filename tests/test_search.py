from collections import Counter

import numpy as np
import pytest

from odin.index.chunker import MODULE, chunk_file
from odin.repos import RepoCache
from odin.search.bm25 import BM25Index, Vocab, top_k
from odin.search.graph import ExpandParams
from odin.search.retriever import BM25Retriever, Query
from odin.search.tokenize import code, code_counts, naive

from .conftest import _git

SOURCE = b"""import os

LIMIT = 3


class Box(Base):
    \"\"\"A bounded container.\"\"\"
    size = 1

    def put(self, x):
        def check(v):
            return v
        return check(x)


def free():
    pass
"""


def test_chunks_match_retrieval_units():
    chunks = {c.qualname: c for c in chunk_file(SOURCE, "m.py")}
    assert set(chunks) == {"Box", "Box.put", "free", ""}
    assert "def check" in chunks["Box.put"].text
    # The class chunk keeps its own lines but not its methods'.
    assert "bounded container" in chunks["Box"].text
    assert "def put" not in chunks["Box"].text
    assert chunks[""].kind == MODULE
    assert "LIMIT = 3" in chunks[""].text
    assert chunks["Box.put"].id("m.py") == "m.py::Box.put"


def test_chunks_cover_every_line_once():
    lines = [ln for c in chunk_file(SOURCE, "m.py") for ln in c.text.split("\n")]
    assert sorted(lines) == sorted(SOURCE.decode().splitlines())


def test_code_tokenizer_splits_identifiers():
    toks = code("self.get_queryset(); HTTPServerError x.parseJSON2")
    assert "get_queryset" in toks and "queryset" in toks and "get" in toks
    assert {"httpservererror", "http", "server", "error"} <= set(toks)
    assert {"parse", "json"} <= set(toks)
    assert "self" not in toks


def test_naive_tokenizer_keeps_identifiers_whole():
    assert naive("get_queryset(Foo)") == ["get_queryset", "foo"]


def test_bm25_ranks_rare_term_matches_first():
    vocab = Vocab()
    docs = [vocab.vectorize(d.split()) for d in ["a b c", "a a a", "a zebra", "b c"]]
    index = BM25Index.from_docs(docs, len(vocab))
    scores = index.scores(vocab.lookup(["zebra", "a"]))
    assert top_k(scores, 1)[0] == 2
    assert scores[3] == 0


def test_bm25_ignores_unknown_query_terms():
    vocab = Vocab()
    index = BM25Index.from_docs([vocab.vectorize(["x"])], len(vocab))
    assert index.scores(vocab.lookup(["never", "seen"])).tolist() == [0.0]


def test_bm25_matches_reference_formula():
    vocab = Vocab()
    corpus = [["x", "y", "x"], ["y"], ["z", "z", "z", "y"]]
    index = BM25Index.from_docs([vocab.vectorize(d) for d in corpus], len(vocab))
    k1, b = 1.2, 0.75
    avgdl = np.mean([len(d) for d in corpus])

    def ref(doc, term):
        df = sum(term in d for d in corpus)
        idf = np.log1p((len(corpus) - df + 0.5) / (df + 0.5))
        tf = doc.count(term)
        return idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * len(doc) / avgdl))

    got = index.scores(vocab.lookup(["x", "y"]))
    want = [ref(d, "x") + ref(d, "y") for d in corpus]
    assert got == pytest.approx(want, rel=1e-5)


def test_top_k_is_sorted_and_deterministic():
    scores = np.array([0.1, 0.9, 0.9, 0.5])
    assert top_k(scores, 3).tolist() == [1, 2, 3]
    assert top_k(scores, 10).tolist() == [1, 2, 3, 0]


def test_retriever_end_to_end_with_blob_reuse(local_repo):
    cache, first, second = local_repo
    r = BM25Retriever(cache=cache)
    q1 = Query("q1", "acme/pkg", first, "Session.login rejects a valid password")
    assert r.retrieve(q1, "function", 3)[0] == "pkg/auth.py::Session.login"
    assert r.retrieve(q1, "file", 1) == ["pkg/auth.py"]

    q2 = Query("q2", "acme/pkg", second, "templates are not HTML escaped")
    assert r.retrieve(q2, "function", 1) == ["pkg/render.py::render_template"]
    # auth.py is byte-identical in both commits, so it was parsed exactly once.
    assert r.indexer.stats.blobs_parsed == 3
    r.indexer.close()


def test_blob_reader_round_trips(local_repo):
    cache, first, _ = local_repo
    (entry,) = [e for e in cache.list_tree("acme/pkg", first) if e.path.endswith("render.py")]
    with cache.blob_reader("acme/pkg") as reader:
        assert reader.read(entry.oid).startswith(b"def render_template")
        assert reader.read(entry.oid) == cache.read_file("acme/pkg", first, entry.path)


def test_counting_tokenizer_matches_list_tokenizer():
    text = "get_queryset get_queryset HTTPError self.parseJSON(x) # get_queryset"
    assert code_counts(text) == Counter(code(text))


@pytest.fixture
def graph_repo(tmp_path):
    work = tmp_path / "work"
    (work / "pkg").mkdir(parents=True)
    _git(work, "init", "-q")
    _git(work, "config", "user.email", "t@t")
    _git(work, "config", "user.name", "t")
    (work / "pkg" / "sep.py").write_text(
        "def separability_matrix(model):\n    return _cstack(model)\n\n\n"
        "def _cstack(left):\n    return left\n\n\n"
        "def _unrelated():\n    return 0\n"
    )
    # A same-named helper elsewhere must not steal the edge from the local definition.
    (work / "pkg" / "other.py").write_text("def _cstack(x):\n    return x\n")
    _git(work, "add", ".")
    _git(work, "commit", "-qm", "one")
    cache = RepoCache(tmp_path / "cache")
    _git(tmp_path, "clone", "-q", "--bare", str(work), str(cache.mirror_path("acme/sep")))
    return cache, _git(work, "rev-parse", "HEAD")


def test_call_graph_prefers_same_file_definition(graph_repo):
    cache, commit = graph_repo
    r = BM25Retriever(cache=cache)
    r.prepare(Query("q", "acme/sep", commit, ""), "function")
    idx = r._indexes["function"]
    pos = {doc: i for i, doc in enumerate(idx.ids)}
    g = idx.graph.toarray()
    caller = pos["pkg/sep.py::separability_matrix"]
    assert g[caller, pos["pkg/sep.py::_cstack"]] == 1.0
    assert g[caller, pos["pkg/other.py::_cstack"]] == 0.0
    assert g.sum() == 1.0
    r.close()


def test_expansion_surfaces_callee_of_top_hit(graph_repo):
    cache, commit = graph_repo
    q = Query("q", "acme/sep", commit, "separability matrix is wrong for nested models")
    plain = BM25Retriever(cache=cache).retrieve(q, "function", 3)
    assert "pkg/sep.py::_cstack" not in plain
    expanded = BM25Retriever(cache=cache, expansion=ExpandParams(alpha=0.5)).retrieve(
        q, "function", 3
    )
    assert expanded[:2] == ["pkg/sep.py::separability_matrix", "pkg/sep.py::_cstack"]


def test_disk_cache_skips_parsing_in_a_new_process(local_repo):
    cache, first, second = local_repo
    q = Query("q", "acme/pkg", second, "templates are not HTML escaped")
    a = BM25Retriever(cache=cache)
    expected = a.retrieve(q, "function", 3)
    a.close()
    assert a.indexer.stats.blobs_parsed == 2 and a.indexer.stats.blobs_cached == 0

    b = BM25Retriever(cache=cache)
    assert b.retrieve(q, "function", 3) == expected
    assert b.indexer.stats.blobs_parsed == 0 and b.indexer.stats.blobs_cached == 2
    b.close()


def test_fingerprint_separates_analyzers():
    from odin.index.store import analyzer_fingerprint
    from odin.search.tokenize import code_counts, naive_counts

    assert analyzer_fingerprint(code_counts) == analyzer_fingerprint(code_counts)
    assert analyzer_fingerprint(code_counts) != analyzer_fingerprint(naive_counts)
