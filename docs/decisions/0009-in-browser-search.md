# 0009: The first two stages, running in the visitor's browser on any repository

## Context

The full pipeline needs a GPU, about 1 GB of caches, and a 0.5B embedding model plus two 0.6B rerankers. The showcase site had to be free to host (GitHub Pages or Vercel, no server) yet let anyone search any public Python repository, not just replay benchmark results.

## Decision

**Run the cheap stages client-side, and measure them.** The browser runs structural chunking, code-aware BM25 and a small embedding rerank. The expensive stages (learned ranker with git-history features, fine-tuned LLM rerankers) are shown as replayed results on the benchmark.

- **Same code, provably.** The chunker, tokenizer and BM25 are TypeScript ports in `web/src/engine/`. A Python test runs that TypeScript source under Node 24 (type stripping, so no build sits between tested and shipped code) and requires identical units on 837 real files (17,369 units, 0 mismatches) and identical BM25 rankings and scores.
- **Any repository.** File lists come from GitHub's tree API (with jsDelivr as a fallback when rate-limited) and files from `raw.githubusercontent.com`, both of which allow browser requests. Parsing is Tree-sitter compiled to WebAssembly, the same grammar version as the Python side.
- **Off the main thread.** A module Web Worker does downloading, parsing, indexing and embedding. The longest main-thread task while loading a repository measured 0 ms. Messages between the page and the worker are typed (`web/src/worker/protocol.ts`), and superseded searches stop between embedding batches.
- **Cached like the backend.** Parsed repositories are stored in IndexedDB keyed by git tree hash, which cannot go stale. Embeddings are keyed by a SHA-256 content hash, so a function embedded once, in any repository, is never embedded again. A reload of a loaded repository takes about 0 s.
- **Semantic rerank measured on the benchmark** (superseded by the learned ranker of [ADR 0010](0010-browser-ranker.md)). `all-MiniLM-L6-v2` reranks BM25's top 50. `scripts/eval_lite_browser.py` (since removed) evaluated exactly this cascade: the fusion weight is chosen on the dev set, then Lite is run once. Held-out hit@10 rose from 54.6% to 58.4% and MRR from 0.307 to 0.339. The browser runs an 8-bit copy of the model (cosine at least 0.987 to the fp32 model measured), or fp16 on WebGPU where the GPU supports it.
- **Depth 50, not 100.** On dev, 100 candidates add 0.3 points of hit@10 for twice the embedding work in the visitor's browser (30 candidates cost 2.3 points). This is a deliberate latency trade, stated on the page.

## Alternatives considered

- **A hosted backend (Hugging Face Spaces, serverless functions).** Free tiers sleep, run on CPU and cannot embed a new repository on the fly. The full pipeline would have been slower and limited to pre-indexed repositories.
- **HNSW in the browser.** With at most 50 candidates per query there is nothing for approximate search to save.
- **A larger browser embedding model.** A 4x bigger download for every visitor, for gains not yet measured. It is the obvious next experiment, and the evaluation script makes it one command.

## Consequences

- The site states its own accuracy next to the full system's (58.4% vs about 80% function hit@10), so no one mistakes the demo for the benchmarked system.
- Build output: 47 KB of page JavaScript (18 KB gzipped), an 87 KB worker, and 150 KB of gzipped parser WebAssembly loaded only when searching. The ML runtime is fetched from jsDelivr on first semantic search and shared, cached, with other sites.
- GitHub's unauthenticated API allows 60 requests an hour per IP. Loading a repository uses two, and the jsDelivr fallback covers listing when that runs out.
