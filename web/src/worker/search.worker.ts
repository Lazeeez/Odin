/// <reference lib="webworker" />
// All heavy work runs here, off the main thread: downloading, Tree-sitter parsing, indexing
// and the embedding model. The page stays responsive even while indexing django.
import { BM25 } from "../engine/bm25.ts";
import { encodePath } from "../engine/github.ts";
import type { Lang } from "../engine/languages-rules.ts";
import { type Listing, type LoadedRepo, LoadError, type Parsing, type RepoCache, inlineParsing, loadRepo } from "../engine/repo.ts";
import { type Candidate, explain, type FileCandidate, type RankerModel, rankFiles, rankUnits, rerankStage, type Similarity, type Stage, signals } from "../engine/rank.ts";
import { issueFields } from "../engine/mentions.ts";
import { type Embed, SEMANTIC, unitText } from "../engine/semantic.ts";
import { blend, SERVER, ServerUnavailable, serverScores } from "../engine/server.ts";
import { confidence, confidenceFeatures, type ConfidenceModel } from "../engine/confidence.ts";
import { embedText, parseStaticModel, type StaticModel } from "../engine/static.ts";
import type { Unit } from "../engine/types.ts";
import rankerUrl from "../assets/ranker.json?url";
import staticUrl from "../assets/static-model.bin?url";
import type { Backend, FromWorker, ToWorker, WireFile, WireHit } from "./protocol.ts";
import { parserFor } from "./grammars.ts";
import { createPool, type Pool } from "./pool.ts";
import { idbGet, idbGetMany, idbPut, idbPutMany, touchRepo, trimVectors } from "./store.ts";

declare const self: DedicatedWorkerGlobalScope;
const TRANSFORMERS_CDN = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";
const ORT_RUNTIME = "https://unpkg.com/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/";
const post = (msg: FromWorker) => self.postMessage(msg);
// Set at build time when the archive relay is deployed (see proxy/cloudflare-worker.js).
const ARCHIVE_PROXY = import.meta.env.VITE_ARCHIVE_PROXY?.replace(/\/+$/, "");
const CONFIDENCE_URL = Object.values(import.meta.glob("../assets/confidence.json", { query: "?url", import: "default", eager: true }))[0] as string | undefined;
let confidenceModel: Promise<ConfidenceModel | null> | null = null;
const confidenceOf = async (candidates: Candidate[], features: string[], query: string): Promise<number | undefined> => {
  if (!CONFIDENCE_URL || !candidates.length) return undefined;
  confidenceModel ??= fetch(CONFIDENCE_URL).then((r) => (r.ok ? (r.json() as Promise<ConfidenceModel>) : null)).catch(() => null);
  const model = await confidenceModel;
  return model ? confidence(model, confidenceFeatures(candidates, features, query)) : undefined;
};
let rerankServer = import.meta.env.VITE_RERANK_SERVER?.replace(/\/+$/, "") || null;
const BATCH = 16; // texts per embedding call

interface Job {
  id: number;
  computed: number;
  stored: number;
}

const state = {
  repo: null as LoadedRepo | null,
  /** What searches run against: the loaded repository, or the part of it parsed so far. */
  index: null as BM25 | null,
  model: null as Promise<(job: Job) => Embed> | null,
  ranker: null as Promise<RankerModel> | null,
  static: null as Promise<{ model: StaticModel; buffer: ArrayBuffer }> | null,
  /** Static embeddings of every unit of `index`, once the background build finishes. */
  sem: null as { index: BM25; vectors: Float32Array; dim: number } | null,
  controller: null as AbortController | null,
  server: null as AbortController | null,
  latest: 0,
};

class Superseded extends Error {}

// Parser threads when the browser allows workers to start workers, else this thread.
let pool: Pool | null | undefined;
let parsing: Promise<Parsing> | null = null;
const getPool = () => (pool === undefined ? (pool = createPool()) : pool);
const getParsing = () => (parsing ??= Promise.resolve(getPool()).then((p) => p ?? inlineParsing(parserFor)));

// The static embedding model (scripts/browser_ltr.py writes it): a content-hashed asset,
// downloaded once and cached, also handed to the parser threads.
const staticModel = () =>
  (state.static ??= fetch(staticUrl)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`static model: HTTP ${r.status}`))))
    .then(async (buffer) => {
      await getPool()?.loadStatic(buffer.slice(0));
      return { model: parseStaticModel(buffer), buffer };
    })
    .catch((err) => {
      state.static = null;
      throw err;
    }));

/** Embed every unit in the background; searches use the semantic stage once it is ready. */
async function buildSemantic(index: BM25): Promise<void> {
  const t0 = performance.now();
  post({ type: "semantic-index", state: "building", units: index.units.length, ms: 0 });
  try {
    const { model } = await staticModel();
    const texts = index.units.map(unitText);
    const p = getPool();
    let vectors: Float32Array;
    if (p) vectors = await p.embed(texts, model.dim);
    else {
      vectors = new Float32Array(texts.length * model.dim);
      texts.forEach((t, i) => vectors.set(embedText(model, t), i * model.dim));
    }
    if (state.index !== index) return; // another repository was loaded meanwhile
    state.sem = { index, vectors, dim: model.dim };
    post({ type: "semantic-index", state: "ready", units: index.units.length, ms: performance.now() - t0 });
  } catch {
    post({ type: "semantic-index", state: "failed", units: index.units.length, ms: performance.now() - t0 });
  }
}

/** Cosine similarity of every unit to the issue and its title, if the semantic index is ready. */
async function similarity(index: BM25, query: string): Promise<Similarity | undefined> {
  const sem = state.sem;
  if (!sem || sem.index !== index) return undefined;
  const { model } = await staticModel();
  const [title] = issueFields(query);
  const matvec = (q: Float32Array) => {
    const out = new Float32Array(index.units.length);
    const { vectors, dim } = sem;
    for (let u = 0, at = 0; u < out.length; u++, at += dim) {
      let s = 0;
      for (let j = 0; j < dim; j++) s += vectors[at + j] * q[j];
      out[u] = s;
    }
    return out;
  };
  return { issue: matvec(embedText(model, query)), title: matvec(embedText(model, title)) };
}

// The learned ranker's trees (scripts/browser_ltr.py), a content-hashed asset fetched once.
const ranker = () =>
  (state.ranker ??= fetch(rankerUrl)
    .then((r) => (r.ok ? (r.json() as Promise<RankerModel>) : Promise.reject(new Error(`ranker: HTTP ${r.status}`))))
    .catch((err) => {
      state.ranker = null;
      throw err;
    }));

// Parsed repositories are cached by git tree hash: same hash, same code, never stale.
// Listings are reused for ten minutes: a reload or a second load of the same repository
// then needs no GitHub API request (anonymous visitors get 60 an hour).
const LISTING_TTL_MS = 10 * 60 * 1000;
const repoCache: RepoCache = {
  async get(key) {
    const units = await idbGet<Unit[]>("repos", key);
    if (units) void touchRepo(key);
    return units;
  },
  async put(key, units) {
    await idbPut("repos", key, units);
    await touchRepo(key, units.reduce((n, u) => n + 2 * (u.text.length + u.path.length + u.qualname.length) + 64, 0));
  },
  async getListing(ref) {
    const hit = await idbGet<{ at: number; listing: Listing }>("meta", `listing|${ref}`);
    return hit && Date.now() - hit.at < LISTING_TTL_MS ? hit.listing : undefined;
  },
  putListing: (ref, listing) => idbPut("meta", `listing|${ref}`, { at: Date.now(), listing }),
  getNotes: (key) => idbGet<string[]>("meta", `notes|${key}`),
  putNotes: (key, notes) => idbPut("meta", `notes|${key}`, notes),
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
    if (wasm) {
      wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      wasm.wasmPaths = ORT_RUNTIME;
    }
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
const wireFile = (f: FileCandidate): WireFile => ({ path: f.path, score: f.score, functions: f.units.slice(0, 4).map(wire), count: f.units.length });

async function load(input: string, includeTests: boolean, gpu: boolean): Promise<void> {
  state.controller = new AbortController();
  ranker().catch(() => {}); // fetched while the repository downloads
  staticModel().catch(() => {});
  try {
    const model = await ranker().catch(() => null);
    const languages = new Set<Lang>((model?.meta.languages as Lang[] | undefined) ?? ["python"]);
    const repo = await loadRepo(await getParsing(), input, {
      includeTests,
      languages,
      cache: repoCache,
      signal: state.controller.signal,
      progress: (phase, done, total) => post({ type: "progress", phase, done, total }),
      archive: ARCHIVE_PROXY ? (owner, name, ref) => `${ARCHIVE_PROXY}/${owner}/${name}/${encodePath(ref)}` : undefined,
      partial: (units, counts, filesDone, filesTotal, where) => {
        if (state.controller?.signal.aborted) return;
        state.index = new BM25(units, { counts });
        post({
          type: "partial",
          info: {
            ...where, via: "", sha: null, files: filesTotal, units: units.length, notes: [], fromCache: false,
            timings: { loadMs: 0, indexMs: 0 }, partial: { filesDone, filesTotal },
          },
        });
      },
    });
    state.repo = repo;
    state.index = repo.index;
    state.sem = null;
    const { index: _index, units, ...info } = repo;
    post({ type: "loaded", info: { ...info, units: units.length } });
    void buildSemantic(repo.index);
    void ranker().then((m) => {
      post({ type: "stages", rerank: !!m.rerank, file: !!m.file });
      // Warm the rerank model while the visitor reads the first results, if it is used at all:
      // not on a Data Saver connection, and not when the GPU reranker will answer instead.
      const saveData = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
      if (m.rerank && !saveData && !(gpu && rerankServer && SERVER.skipLanguageModel)) embedder().catch(() => {});
    }, () => {});
    void trimVectors(); // keep stored embeddings within budget
  } catch (err) {
    // Back to the previous repository (if any), not a half-loaded one.
    state.index = state.repo?.index ?? null;
    post({ type: "error", message: err instanceof Error ? err.message : String(err), cancelled: err instanceof LoadError && err.cancelled });
  }
}

/** File paths and unit counts of the loaded index, for the repository map. */
function postMap() {
  const counts = new Map<string, number>();
  for (const u of state.index?.units ?? []) counts.set(u.path, (counts.get(u.path) ?? 0) + 1);
  post({ type: "map", files: [...counts] });
}

/** The top `k` on the wire, the first ten with their explanations. */
function explained(stage: Stage, all: Candidate[], k: number) {
  const hits = all.slice(0, k).map(wire);
  explain(stage, all.slice(0, 10), all).forEach((why, i) => {
    hits[i].why = why;
  });
  return hits;
}

async function search(id: number, query: string, semantic: boolean, server: boolean, k: number): Promise<void> {
  state.latest = id;
  state.server?.abort();
  const index = state.index;
  if (!index) return;
  const t0 = performance.now();
  const model = await ranker().catch(() => null);
  if (id !== state.latest) return;
  if (!model) {
    // Without the learned ranker (it failed to download), plain BM25 still works.
    const kw = index.search(query, k);
    post({ type: "results", id, stage: "instant", hits: kw.hits.map((h) => wire({ ...h, bm25: h.score })), terms: kw.terms, ms: performance.now() - t0 });
    return;
  }
  const sim = await similarity(index, query);
  if (id !== state.latest) return;
  const semanticStage = sim ? model.semantic : undefined;
  const stage = semanticStage ?? model.instant;
  const sig = signals(index, query, semanticStage ? sim : undefined, !!model.meta.multilang);
  const ranked = rankUnits(index, model, stage, sig);
  const files = semanticStage && model.file ? rankFiles(index, model.file, stage, sig, ranked).slice(0, 10).map(wireFile) : undefined;
  const sure = semanticStage ? await confidenceOf(ranked.candidates, semanticStage.features, query) : undefined;
  if (id !== state.latest) return;
  post({
    type: "results", id, stage: semanticStage ? "semantic" : "instant", hits: explained(stage, ranked.candidates, k),
    files, terms: ranked.terms, ms: performance.now() - t0, confidence: sure,
  });
  // The rerank stage was trained on the semantic stage's candidates.
  if (!semantic || !model.rerank || !semanticStage || ranked.candidates.length < 2) return;
  const gpu = server && rerankServer ? askServer(id, query, ranked.candidates) : null;
  if (gpu && SERVER.skipLanguageModel && ((await serverStage(id, gpu, stage, ranked.candidates, files, ranked.terms, k, sure)) || id !== state.latest)) return;
  let final = ranked.candidates;
  let finalStage: Stage = stage;
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
    const hits = await rerankStage(model, ranked, embed, unitText, query);
    if (id !== state.latest) return;
    post({
      type: "results", id, stage: "rerank", hits: explained(model.rerank, hits, k), files, terms: ranked.terms,
      ms: performance.now() - t1, computed: units.computed, stored: units.stored, confidence: sure,
    });
    final = hits;
    finalStage = model.rerank;
  } catch (err) {
    if (err instanceof Superseded) return;
    post({ type: "semantic-error", id, message: err instanceof Error ? err.message : String(err) });
  }
  if (gpu && !SERVER.skipLanguageModel && id === state.latest) await serverStage(id, gpu, finalStage, final, files, ranked.terms, k, sure);
}

interface ServerJob {
  controller: AbortController;
  sent: number;
  scores: Promise<Map<number, number[]>>;
}

// The language-model stage only reorders the top 20, so the top 50 are the same functions before
// and after it: the server scores them while it runs, and its scores are blended into its order.
function askServer(id: number, query: string, candidates: Candidate[]): ServerJob {
  const controller = (state.server = new AbortController());
  const top = candidates.slice(0, SERVER.depth);
  const job: ServerJob = { controller, sent: 0, scores: Promise.resolve(new Map()) };
  job.scores = (async () => {
    await new Promise((r) => setTimeout(r, SERVER.settleMs));
    if (id !== state.latest || !rerankServer) throw new Superseded();
    post({ type: "server-start", id });
    job.sent = performance.now();
    const scores = await serverScores(rerankServer, query, top.map((c) => unitText(c.unit)), controller.signal);
    return new Map(top.map((c, i) => [c.row, scores.map((s) => s[i])]));
  })();
  job.scores.catch(() => {});
  return job;
}

async function serverStage(id: number, job: ServerJob, stage: Stage, order: Candidate[], files: WireFile[] | undefined, terms: string[], k: number, sure?: number): Promise<boolean> {
  try {
    const byRow = await job.scores;
    if (id !== state.latest) return false;
    const head = order.slice(0, SERVER.depth);
    if (!head.length || !head.every((c) => byRow.has(c.row))) return false;
    const members = byRow.get(head[0].row)!.length;
    const scores = Array.from({ length: members }, (_, m) => head.map((c) => byRow.get(c.row)![m]));
    const prior = new Map(order.map((c, i) => [c.row, i + 1]));
    const blended = blend(order, scores);
    const hits = explained(stage, blended, k);
    hits.forEach((h, i) => {
      const was = prior.get(blended[i].row);
      if (was != null && was !== i + 1) h.before = was;
    });
    post({ type: "results", id, stage: "server", hits, files, terms, ms: performance.now() - job.sent, confidence: sure });
    return true;
  } catch (err) {
    if (err instanceof Superseded || id !== state.latest || job.controller.signal.aborted) return false;
    const permanent = err instanceof ServerUnavailable && err.permanent;
    if (permanent) rerankServer = null;
    post({ type: "server-error", id, message: err instanceof Error ? err.message : String(err), permanent });
    return false;
  }
}

let lastWarm = 0;

function warmServer(): void {
  if (!rerankServer || Date.now() - lastWarm < 60_000) return;
  lastWarm = Date.now();
  void fetch(`${rerankServer}/warm`, { method: "POST" }).then((r) => {
    if (r.status === 501 || r.status === 404) rerankServer = null;
  }).catch(() => {});
}

self.onmessage = ({ data }: MessageEvent<ToWorker>) => {
  if (data.type === "load") void load(data.input, data.includeTests, data.gpu);
  else if (data.type === "warm") warmServer();
  else if (data.type === "cancel") state.controller?.abort();
  else if (data.type === "map") postMap();
  else void search(data.id, data.query, data.semantic, data.server, data.k);
};
