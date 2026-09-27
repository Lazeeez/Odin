/// <reference lib="webworker" />
// All heavy work runs here, off the main thread: downloading, Tree-sitter parsing, indexing
// and the embedding model. The page stays responsive even while indexing django.
import treeSitterWasm from "web-tree-sitter/tree-sitter.wasm?url";
import type { Parser } from "web-tree-sitter";
import grammarWasm from "../assets/tree-sitter-python.wasm?url";
import { createParser } from "../engine/chunk.ts";
import { type LoadedRepo, LoadError, loadRepo } from "../engine/repo.ts";
import { type Candidate, type RankerModel, rankStage1, rankStage2 } from "../engine/rank.ts";
import { type Embed, SEMANTIC, unitText } from "../engine/semantic.ts";
import type { Unit } from "../engine/types.ts";
import rankerUrl from "../assets/ranker.json?url";
import type { Backend, FromWorker, ToWorker, WireHit } from "./protocol.ts";
import { idbGet, idbGetMany, idbPut, idbPutMany } from "./store.ts";

declare const self: DedicatedWorkerGlobalScope;
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
const post = (msg: FromWorker) => self.postMessage(msg);
const BATCH = 16; // texts per embedding call

interface Job {
  id: number;
  computed: number;
  stored: number;
}

const state = {
  parser: null as Promise<Parser> | null,
  repo: null as LoadedRepo | null,
  model: null as Promise<(job: Job) => Embed> | null,
  ranker: null as Promise<RankerModel> | null,
  controller: null as AbortController | null,
  latest: 0,
};

class Superseded extends Error {}

const parser = () => (state.parser ??= createParser(treeSitterWasm, grammarWasm));

// The learned ranker's trees (scripts/browser_ltr.py), a content-hashed asset fetched once.
const ranker = () =>
  (state.ranker ??= fetch(rankerUrl)
    .then((r) => (r.ok ? (r.json() as Promise<RankerModel>) : Promise.reject(new Error(`ranker: HTTP ${r.status}`))))
    .catch((err) => {
      state.ranker = null;
      throw err;
    }));

// Parsed repositories are cached by git tree hash: same hash, same code, never stale.
const repoCache = {
  get: (key: string) => idbGet<Unit[]>("repos", key),
  put: (key: string, units: Unit[]) => idbPut("repos", key, units),
};

async function contentKey(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SEMANTIC.model}\n${text}`));
  return Array.from(new Uint8Array(digest.slice(0, 16)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** WebGPU with fp16 weights where the GPU supports it, otherwise 8-bit weights on WASM. */
async function pickBackend(): Promise<{ device: Backend; dtype: "fp16" | "q8" }> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  try {
    const adapter = await gpu?.requestAdapter();
    if (adapter?.features.has("shader-f16")) return { device: "webgpu", dtype: "fp16" };
  } catch {
    /* no usable GPU */
  }
  return { device: "wasm", dtype: "q8" };
}

// The embedding model, loaded once. Vectors are also persisted by content hash, so a function
// embedded in any earlier visit, in any repository, is never embedded again.
function embedder(): Promise<(job: Job) => Embed> {
  state.model ??= (async () => {
    // Loaded from the CDN at runtime (types come from the npm package): its 27 MB ONNX runtime is
    // then served compressed and edge-cached, shared with every site that uses it.
    const { AutoModel, AutoTokenizer, env, mean_pooling } = (await import(/* @vite-ignore */ TRANSFORMERS_CDN)) as typeof import("@huggingface/transformers");
    env.allowLocalModels = false;
    // Threads need SharedArrayBuffer, which needs cross-origin isolation (set up by sw.js).
    const wasm = env.backends.onnx.wasm;
    if (wasm) wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    const tokenizer = await AutoTokenizer.from_pretrained(SEMANTIC.model);
    let backend = await pickBackend();
    let lastPct = -1;
    const load = (b: typeof backend) =>
      AutoModel.from_pretrained(SEMANTIC.model, {
        device: b.device,
        dtype: b.dtype,
        progress_callback: (p: { status: string; file?: string; progress?: number }) => {
          if (p.status !== "progress" || !p.file?.endsWith(".onnx")) return;
          const pct = Math.min(100, Math.floor(p.progress ?? 0)); // the raw callback fires hundreds of times
          if (pct !== lastPct) post({ type: "model", pct: (lastPct = pct), backend: b.device });
        },
      });
    let net;
    try {
      net = await load(backend);
    } catch (err) {
      if (backend.device !== "webgpu") throw err;
      backend = { device: "wasm", dtype: "q8" }; // WebGPU present but unusable: fall back
      net = await load(backend);
    }
    post({ type: "model-ready", backend: backend.device });

    const encode = async (texts: string[], job: Job): Promise<Float32Array[]> => {
      const out: Float32Array[] = new Array(texts.length);
      // Batch texts of similar length: a batch is padded to its longest member, so mixing a
      // 3-line helper with a 200-line method wastes most of the compute on padding. Masked
      // mean pooling makes the vectors independent of how texts are batched.
      const byLength = texts.map((_, i) => i).sort((a, b) => texts[a].length - texts[b].length);
      for (let i = 0; i < byLength.length; i += BATCH) {
        // A newer query makes this one pointless: stop instead of finishing its batches.
        if (job.id !== state.latest) throw new Superseded();
        post({ type: "embedding", id: job.id, done: i, total: texts.length });
        const ids = byLength.slice(i, i + BATCH);
        // As in the Python evaluation: truncate at 256 tokens, mean-pool, L2-normalize.
        const inputs = tokenizer(ids.map((j) => texts[j]), { padding: true, truncation: true, max_length: SEMANTIC.maxTokens });
        const { last_hidden_state } = await net(inputs);
        const pooled = mean_pooling(last_hidden_state, inputs.attention_mask).normalize(2, -1);
        (pooled.tolist() as number[][]).forEach((v, k) => {
          out[ids[k]] = Float32Array.from(v);
        });
      }
      return out;
    };
    // An embed function bound to one search, with its own counters.
    return (job: Job): Embed => async (texts) => {
      const keys = await Promise.all(texts.map(contentKey));
      const stored = await idbGetMany<Float32Array>("vectors", keys);
      const missing = texts.map((_, i) => i).filter((i) => !stored[i]);
      job.stored += texts.length - missing.length;
      if (missing.length) {
        job.computed += missing.length;
        const fresh = await encode(missing.map((i) => texts[i]), job);
        missing.forEach((i, j) => {
          stored[i] = fresh[j];
        });
        void idbPutMany("vectors", missing.map((i, j) => [keys[i], fresh[j]]));
      }
      return stored as Float32Array[];
    };
  })().catch((err) => {
    state.model = null;
    throw err;
  });
  return state.model;
}

const wire = (c: Pick<Candidate, "unit" | "score" | "bm25"> & Partial<Candidate>): WireHit => ({
  id: c.unit.id, path: c.unit.path, qualname: c.unit.qualname, kind: c.unit.kind, line: c.unit.line,
  text: c.unit.text, score: c.score, bm25: c.bm25, semantic: c.semantic ?? null, reasons: c.reasons ?? [],
});

async function load(input: string, includeTests: boolean): Promise<void> {
  state.controller = new AbortController();
  ranker().catch(() => {}); // fetched while the repository downloads
  try {
    const repo = await loadRepo(await parser(), input, {
      includeTests,
      cache: repoCache,
      signal: state.controller.signal,
      progress: (phase, done, total) => post({ type: "progress", phase, done, total }),
    });
    state.repo = repo;
    const { index: _index, units, ...info } = repo;
    post({ type: "loaded", info: { ...info, units: units.length } });
    // Warm the embedding model while the visitor reads the keyword results.
    embedder().catch(() => {});
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err), cancelled: err instanceof LoadError && err.cancelled });
  }
}

async function search(id: number, query: string, semantic: boolean, k: number): Promise<void> {
  state.latest = id;
  const repo = state.repo;
  if (!repo) return;
  const t0 = performance.now();
  const model = await ranker().catch(() => null);
  if (id !== state.latest) return;
  if (!model) {
    // Without the learned ranker (it failed to download), plain BM25 still works.
    const kw = repo.index.search(query, k);
    post({ type: "results", id, stage: "keyword", hits: kw.hits.map((h) => wire({ ...h, bm25: h.score })), terms: kw.terms, ms: performance.now() - t0 });
    return;
  }
  // Stage 1: learned ranking over lexical and mention features, in milliseconds.
  const ranked = rankStage1(repo.index, model, query);
  post({ type: "results", id, stage: "keyword", hits: ranked.candidates.slice(0, k).map(wire), terms: ranked.terms, ms: performance.now() - t0 });
  if (!semantic || !model.stage2 || ranked.candidates.length < 2) return;
  // Stage 2: the same ranker, now also seeing embedding similarity for the top candidates.
  try {
    const bind = await embedder();
    if (id !== state.latest) return;
    post({ type: "semantic-start", id });
    const t1 = performance.now();
    const job: Job = { id, computed: 0, stored: 0 };
    const base = bind(job);
    const units = { computed: 0, stored: 0 };
    let calls = 0;
    // The first call embeds the issue and its title; count only the code units after it.
    const embed: Embed = async (texts) => {
      const before = { computed: job.computed, stored: job.stored };
      const out = await base(texts);
      if (calls++ > 0) {
        units.computed += job.computed - before.computed;
        units.stored += job.stored - before.stored;
      }
      return out;
    };
    const hits = await rankStage2(model, query, ranked, embed, unitText);
    if (id !== state.latest) return;
    post({
      type: "results", id, stage: "semantic", hits: hits.slice(0, k).map(wire), terms: ranked.terms,
      ms: performance.now() - t1, computed: units.computed, stored: units.stored,
    });
  } catch (err) {
    if (!(err instanceof Superseded)) post({ type: "semantic-error", id, message: err instanceof Error ? err.message : String(err) });
  }
}

self.onmessage = ({ data }: MessageEvent<ToWorker>) => {
  if (data.type === "load") void load(data.input, data.includeTests);
  else if (data.type === "cancel") state.controller?.abort();
  else void search(data.id, data.query, data.semantic, data.k);
};
