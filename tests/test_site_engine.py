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


def _python_index(units):
    """The Python side of the parity tests: a BM25 index over `units`, shaped like a snapshot."""
    from collections import Counter
    from types import SimpleNamespace

    import numpy as np

    from odin.search.bm25 import BM25Index, Vocab
    from odin.search.tokenize import code_counts

    vocab = Vocab()
    paths = [u["path"] for u in units]
    docs = [
        vocab.vectorize(
            code_counts(
                f"{u['qualname']}\n{u['text']}\n{' '.join(re.split(r'[/._-]+', _stem(u['path'])))}"
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

    return fn, names, scores


def _stem(path: str) -> str:
    if path.endswith(".py") or "." not in path:
        return path.removesuffix(".py")
    return path.rsplit(".", 1)[0]


def _src_units():
    return [
        {"path": str(p.relative_to(ROOT)).replace("\\", "/"), **u}
        for p in sorted((ROOT / "src").rglob("*.py"))
        for u in python_units(p)
        if u["text"].strip()
    ]


def _web_units():
    return [
        {"path": str(p.relative_to(ROOT)).replace("\\", "/"), **u}
        for folder in ("web/src/engine", "web/src/worker")
        for p in sorted((ROOT / folder).glob("*.ts"))
        for u in python_units(p)
        if u["text"].strip()
    ]


MULTI_QUERIES = [
    "TypeError: Cannot read properties of undefined (reading 'units')\n"
    "    at rankUnits (web/src/engine/rank.ts:180:12)\n"
    "    at search (web/src/worker/search.worker.ts:331:18)",
    "`blend` puts the GPU reranker's favourite below the browser's order in server.ts",
    "the semantic index never finishes building for repositories with many files",
    "`BM25.search` finds nothing once `pathText` in web/src/engine/tokenize.ts drops the extension"
    " (engine/bm25 module)\n```\nconst kw = index.search(query, k);\nconst text = pathText(u.path);\n```",
]


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_js_rank_features_match_python():
    """Every ranking stage must see the same candidates, features and scores as training."""
    _rank_parity(_src_units(), RANK_QUERIES, multilang=False)


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_js_rank_features_match_python_for_other_languages():
    _rank_parity(_web_units(), MULTI_QUERIES, multilang=True)


def _rank_parity(units: list[dict], queries: list[str], multilang: bool) -> None:
    from collections import Counter

    import numpy as np

    from odin.rank.browser import FEATURES, FILE_FEATURES, SEMANTIC, extract, file_features, predict
    from odin.rank.confidence import confidence_features
    from odin.rank.features import issue_fields
    from odin.rank.mentions import Mentions

    trees = ROOT / "web/src/assets/ranker.json"
    model = json.loads(trees.read_text()) if trees.exists() else {}
    if "semantic" not in model:  # before the first training run: features only
        model = {
            "meta": {"pool": {"bm25": 100, "title": 20, "code": 20, "files": 5, "sem": 50, "title_sem": 20}, "depth": 20},
            "instant": {"features": FEATURES, "trees": []},
            "semantic": {"features": FEATURES + SEMANTIC, "trees": []},
            "file": {"features": FILE_FEATURES, "trees": []},
        }  # fmt: skip
    assert model["instant"]["features"] == FEATURES
    assert model["semantic"]["features"] == FEATURES + SEMANTIC
    assert model["file"]["features"] == FILE_FEATURES
    # Similarities are inputs here (the static encoder has its own test): any fixed values do.
    rng = np.random.default_rng(0)
    sims = [rng.uniform(-0.2, 0.9, (2, len(units))).astype(np.float32) for _ in queries]
    out = subprocess.run(
        [NODE, str(ROOT / "tests/js/rank_features.mjs")],
        input=json.dumps(
            {
                "units": units,
                "queries": queries,
                "multilang": multilang,
                "model": model,
                "sims": [s.tolist() for s in sims],
            }
        ),
        capture_output=True,
        check=True,
        text=True,
        encoding="utf-8",
    ).stdout
    js = json.loads(out)
    fn, names, scores = _python_index(units)

    def same(got, ids, X, stage):
        assert [g[0] for g in got] == ids
        G = np.array([g[1] for g in got]).reshape(X.shape)
        names = model[stage]["features"]
        for c in range(X.shape[1]):
            differing = np.flatnonzero(~np.isclose(G[:, c], X[:, c], rtol=1e-5, atol=1e-5))
            if not len(differing):
                continue
            assert names[c].endswith("logrank"), names[c]
            np.testing.assert_allclose(np.sort(G[differing, c]), np.sort(X[differing, c]))
            assert np.ptp(X[differing, c - 1]) < 1e-4, names[c]
        want = [predict(model[stage], x) for x in G]
        np.testing.assert_allclose([g[2] for g in got], want, rtol=1e-5, atol=1e-5)

    covered = Counter()
    for q, sim, got in zip(queries, sims, js, strict=True):
        title, code = issue_fields(q)
        m = Mentions.parse(q, multilang=multilang)
        lex, tlex = scores(q), scores(title)
        clex = scores(code) if code else np.zeros(len(units))
        rows, X = extract(fn, lex, tlex, clex, m, names)
        same(got["instant"], [fn.ids[r] for r in rows], X, "instant")
        rows_b, XB = extract(fn, lex, tlex, clex, m, names, sim[0], sim[1])
        same(got["semantic"], [fn.ids[r] for r in rows_b], XB, "semantic")
        unit_scores = np.array([predict(model["semantic"], x) for x in XB])
        np.testing.assert_allclose(
            got["confidence"], confidence_features(unit_scores, XB, len(q)), rtol=1e-5, atol=1e-5
        )
        frows, XF = file_features(fn, lex, tlex, clex, sim[0], sim[1], m, rows_b, XB, unit_scores)
        same(got["files"], [fn.files[f] for f in frows], XF, "file")
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


@pytest.mark.skipif(NODE is None, reason="needs Node 24 and `npm ci` in web/")
def test_js_static_embeddings_match_python(tmp_path):
    """The browser's static encoder (tokenizer, int8 model file, mean, normalize) matches Python."""
    import numpy as np

    from odin.search.static import StaticEncoder, export_browser_model

    enc = StaticEncoder(quantize=True)
    model = tmp_path / "static.bin"
    export_browser_model(enc, model)
    texts = [f"{u['qualname']}\n{u['text']}" for u in _src_units()]
    texts += [
        "Café naïve ÅNGSTRÖM",
        "中文 code_x = 1",
        "emoji 🚀 ​ \x07\ttab\r\n",
        "a" * 150,
        "[UNK] raw",
        "",
    ]
    # special tokens in raw text: [UNK] anywhere, [PAD] as a whole word in any case
    texts += [
        "the [PAD] vectors",
        "x[PAD]y",
        "_[PAD]_",
        "[pad]",
        "a [Pad] b",
        "([PAD])",
        "é[PAD]",
        "[PAD][PAD]",
        "x[UNK]y",
    ]
    vocab = enc.tokenizer.get_vocab()
    inv = [""] * len(vocab)
    for t, i in vocab.items():
        inv[i] = t
    pad = enc.tokenizer.token_to_id("[PAD]")
    ids = json.loads(
        subprocess.run(
            [NODE, str(ROOT / "tests/js/static_ids.mjs")],
            input=json.dumps({"vocab": inv, "unk": enc.unk, "pad": pad, "max": enc.max_tokens, "texts": texts}),
            capture_output=True, check=True, text=True, encoding="utf-8",
        ).stdout
    )  # fmt: skip
    assert ids == [enc.token_ids(t) for t in texts]
    got = np.array(
        json.loads(
            subprocess.run(
                [NODE, str(ROOT / "tests/js/static_embed.mjs"), str(model)],
                input=json.dumps(texts), capture_output=True, check=True, text=True, encoding="utf-8",
            ).stdout
        ),
        np.float32,
    )  # fmt: skip
    np.testing.assert_allclose(got, enc.encode(texts), atol=1e-5)


def test_vectorized_tree_scores_match_the_reference():
    import numpy as np

    from odin.rank.browser import predict, predict_many

    model = json.loads((ROOT / "web/src/assets/ranker.json").read_text())
    rng = np.random.default_rng(0)
    for stage in ("instant", "semantic", "file"):
        width = len(model[stage]["features"])
        X = rng.normal(0, 2, (300, width)).astype(np.float32)
        X[::7, ::3] = 0
        np.testing.assert_allclose(
            predict_many(model[stage], X),
            [predict(model[stage], x) for x in X],
            rtol=1e-9,
            atol=1e-9,
        )
