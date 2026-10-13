import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np
import torch
from datasets import load_dataset
from sentence_transformers import SentenceTransformer

QUERY_PREFIX = "Represent this query for searching relevant code"
TOP = 100


def key_of(text: str) -> bytes:
    return hashlib.sha256(text.encode("utf-8")).digest()[:16]


def read_jsonl(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


class Cache:
    def __init__(self, folder: Path, dim: int) -> None:
        self.folder = folder
        self.dim = dim
        self.rows: dict[bytes, int] = {}
        self.vectors = np.zeros((0, dim), np.float32)
        if (folder / "vectors.npy").exists():
            keys = (folder / "keys.bin").read_bytes()
            self.vectors = np.load(folder / "vectors.npy")
            self.rows = {keys[i * 16 : (i + 1) * 16]: i for i in range(len(self.vectors))}

    def add(self, keys: list[bytes], vectors: np.ndarray) -> None:
        start = len(self.vectors)
        self.vectors = np.concatenate([self.vectors, vectors.astype(np.float32)])
        self.rows.update({key: start + i for i, key in enumerate(keys)})

    def save(self) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        ordered = sorted(self.rows, key=self.rows.get)
        np.save(self.folder / "vectors.npy", self.vectors)
        (self.folder / "keys.bin").write_bytes(b"".join(ordered))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset_dir", type=Path, required=True)
    ap.add_argument("--model", default="Salesforce/SweRankEmbed-Small")
    ap.add_argument("--revision", default="745d2a06103a66d3cfa600aa52fc0d3523010daa")
    ap.add_argument("--sequence_length", type=int, default=1024)
    ap.add_argument("--batch_size", type=int, default=32)
    ap.add_argument("--cache", type=Path, required=True)
    ap.add_argument("--results_file", type=Path, required=True)
    ap.add_argument("--only", type=Path, help="a file listing the instance folders to run")
    args = ap.parse_args()
    if args.results_file.exists():
        sys.exit(f"{args.results_file} exists; results are never overwritten")

    model = SentenceTransformer(args.model, revision=args.revision, trust_remote_code=True)
    model = model.to(torch.bfloat16)
    model.max_seq_length = args.sequence_length
    cache = Cache(args.cache, model.get_sentence_embedding_dimension())

    folders = sorted(
        f for f in os.listdir(args.dataset_dir) if f.startswith("swe-bench-lite-function_")
    )
    if args.only:
        wanted = set(args.only.read_text(encoding="utf-8").split())
        folders = [f for f in folders if f in wanted]
    top_docs: dict[str, list[str]] = {}
    started = time.perf_counter()
    for n, folder in enumerate(folders, start=1):
        corpus = read_jsonl(args.dataset_dir / folder / "corpus.jsonl")
        texts = [(doc.get("title", "") + " " + doc["text"]).strip() for doc in corpus]
        keys = [key_of(text) for text in texts]
        missing = {
            key: text for key, text in zip(keys, texts, strict=True) if key not in cache.rows
        }
        if missing:
            ordered = sorted(missing, key=lambda key: -len(missing[key]))
            vectors = model.encode(
                [missing[key] for key in ordered],
                batch_size=args.batch_size,
                convert_to_tensor=True,
                show_progress_bar=False,
            )
            cache.add(ordered, vectors.float().cpu().numpy())
        matrix = torch.from_numpy(cache.vectors[[cache.rows[key] for key in keys]])
        for query in read_jsonl(args.dataset_dir / folder / "queries.jsonl"):
            vector = model.encode(
                [f"{QUERY_PREFIX}: {query['text']}", "dummy"],
                batch_size=args.batch_size,
                convert_to_tensor=True,
                show_progress_bar=False,
            )[0]
            scores = matrix @ vector.float().cpu()
            best = torch.topk(scores, min(TOP, len(corpus))).indices.tolist()
            top_docs[query["_id"]] = [corpus[i]["_id"] for i in best]
        if n % 10 == 0 or n == len(folders):
            cache.save()
            elapsed = time.perf_counter() - started
            print(n, len(folders), len(cache.rows), f"{elapsed:.0f}s", flush=True)

    dataset = load_dataset("princeton-nlp/SWE-bench_Lite")["test"]
    dataset = dataset.add_column("docs", [top_docs.get(i, []) for i in dataset["instance_id"]])
    args.results_file.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_json(str(args.results_file))
    print(f"wrote {args.results_file}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
