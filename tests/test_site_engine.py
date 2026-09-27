"""The website's JavaScript chunker must split code exactly like the Python package.

Runs the website's TypeScript engine (web/src/engine) under Node 24 on every Python file in
this repository plus a file of awkward constructs, and compares unit by unit.
"""

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from odin.index.chunker import MODULE, chunk_file

ROOT = Path(__file__).resolve().parents[1]
NODE = os.environ.get("ODIN_NODE") or shutil.which("node")
if not (ROOT / "web/node_modules/web-tree-sitter").exists():
    NODE = None  # run `npm ci` in web/ first

TRICKY = (
    "import os\r\n"
    "\r\n"
    "if os.name == 'nt':\r\n"
    "    @decorator(arg)\r\n"
    "    def windows_only():\r\n"
    "        pass\r\n"
    "\r\n"
    "async def fetch(url):\r\n"
    "    async with session() as s:\r\n"
    "        return await s.get(url)\r\n"
    "\r\n"
    "class Outer:\r\n"
    "    '''docstring\r\n"
    "def not_a_function():\r\n"
    "    '''\r\n"
    "    class Inner:\r\n"
    "        def deep(self):\r\n"
    "            match self.x:\r\n"
    "                case 1:\r\n"
    "                    def in_case(): pass\r\n"
    "            return lambda: 1\r\n"
    "    try:\r\n"
    "        def in_try(self): ...\r\n"
    "    except ImportError:\r\n"
    "        def in_except(self): ...\r\n"
)


def python_units(path: Path) -> list[dict]:
    chunks = chunk_file(path.read_bytes(), str(path))
    return [
        {"qualname": c.qualname, "kind": c.kind, "line": c.start_line, "text": c.text}
        for c in chunks
        if c.kind != MODULE
    ]


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_js_chunker_matches_python(tmp_path):
    tricky = tmp_path / "tricky.py"
    tricky.write_bytes(TRICKY.encode())
    files = [tricky, *sorted((ROOT / "src").rglob("*.py")), *sorted((ROOT / "tests").rglob("*.py"))]
    out = subprocess.run(
        [NODE, str(ROOT / "tests/js/chunk_files.mjs")],
        input="\n".join(map(str, files)),
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    ).stdout
    js = json.loads(out)
    units = 0
    for path in files:
        assert js[str(path)] == python_units(path), path
        units += len(js[str(path)])
    assert units > 300  # the comparison actually covered real code


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_js_bm25_matches_python():
    """Same tokens, same formula: the browser must rank and score exactly like Python."""
    import re

    import numpy as np

    from odin.search.bm25 import BM25Index, Vocab, top_k
    from odin.search.tokenize import code_counts

    units = [
        {"path": str(p.relative_to(ROOT)).replace("\\", "/"), **u}
        for p in sorted((ROOT / "src").rglob("*.py"))
        for u in python_units(p)
        if u["text"].strip()
    ]
    queries = [
        "blob reader returns wrong bytes for a missing object",
        "BM25 scores ignore the query term frequency",
        "tokenizer splits camelCase HTTPServerError incorrectly",
        "embedding store rows shift after duplicate keys",
    ]
    out = subprocess.run(
        [NODE, str(ROOT / "tests/js/bm25_rank.mjs")],
        input=json.dumps({"units": units, "queries": queries}),
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    ).stdout
    js = json.loads(out)

    vocab = Vocab()

    def path_text(path: str) -> str:
        return " ".join(re.split(r"[/._-]+", path.removesuffix(".py")))

    docs = [
        vocab.vectorize(code_counts(f"{u['qualname']}\n{u['text']}\n{path_text(u['path'])}"))
        for u in units
    ]
    index = BM25Index.from_docs(docs, len(vocab))
    ids = [f"{u['path']}::{u['qualname']}" for u in units]
    for q, got in zip(queries, js, strict=True):
        scores = index.scores(vocab.lookup(code_counts(q)))
        want = [(ids[i], float(scores[i])) for i in top_k(scores, 10) if scores[i] > 0]
        assert [g[0] for g in got] == [w[0] for w in want], q
        np.testing.assert_allclose([g[1] for g in got], [w[1] for w in want], rtol=1e-5)


RANK_QUERIES = [
    # a traceback through real files, a backticked name and a dotted path
    "EmbeddingStore.add corrupts rows\n\nTraceback (most recent call last):\n"
    '  File "/home/dev/odin/src/odin/search/dense.py", line 88, in add\n'
    "    self._keys.extend(keys)\n"
    '  File "/home/dev/odin/src/odin/index/snapshot.py", line 12, in unit_key\n'
    "ValueError: bad key\n\nCalling `truncate` first does not help; see odin.search.dense.",
    "tokenizer splits camelCase HTTPServerError incorrectly in `expand`",
    "path_matches in src/odin/rank/mentions.py rejects Windows paths",
]


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_js_rank_features_match_python():
    """The browser ranker must see the same candidates with the same features as training."""
    from collections import Counter
    from types import SimpleNamespace

    import numpy as np

    from odin.rank.browser import FEATURES, extract, predict
    from odin.rank.features import issue_fields
    from odin.rank.mentions import Mentions
    from odin.search.bm25 import BM25Index, Vocab
    from odin.search.tokenize import code_counts

    units = [
        {"path": str(p.relative_to(ROOT)).replace("\\", "/"), **u}
        for p in sorted((ROOT / "src").rglob("*.py"))
        for u in python_units(p)
        if u["text"].strip()
    ]
    trees = ROOT / "web/src/assets/ranker.json"
    model = json.loads(trees.read_text()) if trees.exists() else {
        "meta": {"pool": {"bm25": 100, "title": 20, "code": 20, "files": 5}, "depth": 50},
        "stage1": {"features": FEATURES, "trees": []},
    }  # fmt: skip
    assert model["stage1"]["features"] == FEATURES
    out = subprocess.run(
        [NODE, str(ROOT / "tests/js/rank_features.mjs")],
        input=json.dumps({"units": units, "queries": RANK_QUERIES, "model": model}),
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    ).stdout
    js = json.loads(out)

    vocab = Vocab()
    paths = [u["path"] for u in units]
    docs = [
        vocab.vectorize(
            code_counts(
                f"{u['qualname']}\n{u['text']}\n{' '.join(re.split(r'[/._-]+', u['path'].removesuffix('.py')))}"
            )
        )
        for u in units
    ]
    index = BM25Index.from_docs(docs, len(vocab))
    files = list(dict.fromkeys(paths))
    fn = SimpleNamespace(
        ids=[f"{u['path']}::{u['qualname']}" for u in units],
        files=files,
        file_of_doc=np.array([files.index(p) for p in paths]),
        index=index,
    )
    names = Counter(u["qualname"].rsplit(".", 1)[-1] for u in units)

    def scores(text: str) -> np.ndarray:
        return index.scores(vocab.lookup(code_counts(text)))

    covered = Counter()
    for q, got in zip(RANK_QUERIES, js, strict=True):
        title, code = issue_fields(q)
        m = Mentions.parse(q)
        rows, X = extract(
            fn, scores(q), scores(title), scores(code) if code else np.zeros(len(units)), m, names
        )
        assert [g[0] for g in got] == [fn.ids[r] for r in rows], q
        np.testing.assert_allclose(np.array([g[1] for g in got]), X, rtol=1e-5, atol=1e-6)
        want = [predict(model["stage1"], x) for x in X]
        np.testing.assert_allclose([g[2] for g in got], want, rtol=1e-5, atol=1e-6)
        covered.update(f for i, f in enumerate(FEATURES) if X[:, i].any())
    # the queries exercise the mention features, not just the lexical ones
    for f in (
        "frame_both",
        "last_frame_file",
        "name_in_code",
        "qual_mentioned",
        "module_mentioned",
        "path_mentioned",
    ):
        assert covered[f], f
