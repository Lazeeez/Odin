import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { RESULTS, SEMANTIC } from "../engine/semantic.ts";
import { SERVER } from "../engine/server.ts";
import { overallProgress } from "../lib/progress.ts";
import { duration } from "../lib/format.ts";
import { load as stored } from "../lib/storage.ts";
import type { Backend, FromWorker, RankStage, RepoInfo, ToWorker, WireFile, WireHit } from "../worker/protocol.ts";

export interface LoadStatus {
  text: string;
  fraction: number | null;
  error: boolean;
}

export interface Results {
  stage: RankStage;
  hits: WireHit[];
  /** From the file ranker, once the semantic index is ready. */
  files?: WireFile[];
  terms: string[];
  ms: number;
  computed?: number;
  stored?: number;
}

/** Everything the page needs from the background search worker, as reactive state. */
export function useSearchWorker() {
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const gpu = useRef<boolean>(stored("gpuRerank", true));
  const loadingRef = useRef(false);
  /** The furthest overall progress of the current load: never shown going backwards. */
  const furthest = useRef(0);
  /** A repository asked for while another was loading: it starts once that load is cancelled. */
  const pending = useRef<{ input: string; includeTests: boolean } | null>(null);
  const start = useRef<(input: string, includeTests: boolean) => void>(() => {});
  /** Starts the queued request, if any; true when it did. */
  const startPending = () => {
    const next = pending.current;
    if (!next) return false;
    pending.current = null;
    start.current(next.input, next.includeTests);
    return true;
  };
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<LoadStatus | null>(null);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [semantic, setSemantic] = useState("");
  const [server, setServer] = useState("");
  const [serverReady, setServerReady] = useState(!!import.meta.env.VITE_RERANK_SERVER);
  const [backend, setBackend] = useState<Backend | null>(null);
  /** The background semantic index of the loaded repository. */
  const [semanticIndex, setSemanticIndex] = useState<{ state: "building" | "ready" | "failed"; units: number; ms: number } | null>(null);
  /** Which optional stages the ranker ships (it is trained and exported by scripts/browser_ltr.py). */
  const [stages, setStages] = useState<{ rerank: boolean; file: boolean } | null>(null);
  /** Files and their unit counts, fetched on demand for the repository map. */
  const [map, setMap] = useState<[string, number][] | null>(null);

  const setLoadingBoth = (v: boolean) => {
    loadingRef.current = v;
    setLoading(v);
  };

  const onMessage = useCallback((msg: FromWorker) => {
    switch (msg.type) {
      case "progress": {
        if (!loadingRef.current) return; // late reports from downloads in flight at cancel
        const totalUnknown = msg.total === 0;
        const files = msg.total > 1 ? ` ${msg.done.toLocaleString()} / ${msg.total.toLocaleString()} files`
          : totalUnknown && msg.done > 0 ? ` ${msg.done.toLocaleString()} files` : "";
        furthest.current = Math.max(furthest.current, overallProgress(msg.phase, msg.done, msg.total));
        setStatus({ text: `${msg.phase}…${files}`, fraction: totalUnknown ? null : furthest.current, error: false });
        return;
      }
      case "loaded":
        setLoadingBoth(false);
        // The cancel came too late to stop that load (it was nearly done): start the newer one now.
        if (startPending()) return;
        setStatus(null);
        setInfo(msg.info);
        return;
      case "semantic-index":
        setSemanticIndex({ state: msg.state, units: msg.units, ms: msg.ms });
        return;
      case "stages":
        setStages({ rerank: msg.rerank, file: msg.file });
        return;
      case "partial":
        // Searchable while the rest loads; the status line keeps reporting progress.
        if (loadingRef.current) setInfo(msg.info);
        return;
      case "error":
        setLoadingBoth(false);
        if (startPending()) return;
        setInfo((prev) => (prev?.partial ? null : prev)); // never leave a half-loaded repository on screen
        setStatus({ text: msg.message, fraction: null, error: !msg.cancelled });
        return;
      case "results":
        if (msg.id !== seq.current) return;
        setResults(msg);
        if (msg.stage === "rerank") {
          const parts = [];
          if (msg.computed) parts.push(`embedded ${msg.computed} new functions`);
          if (msg.stored) parts.push(`${msg.stored} from your browser's cache`);
          setSemantic(`Reranked the top ${SEMANTIC.depth} with a language model in ${duration(msg.ms)}${parts.length ? ` (${parts.join(", ")})` : " (already embedded this session)"}`);
        }
        if (msg.stage === "server") setServer(`Re-read the top ${SERVER.depth} with Odin's fine-tuned reranker on a GPU server in ${duration(msg.ms)}`);
        return;
      case "semantic-start":
        if (msg.id === seq.current) setSemantic("Reranking the top candidates with a language model…");
        return;
      case "embedding":
        if (msg.id === seq.current) setSemantic(`Embedding candidates… ${msg.done} / ${msg.total}`);
        return;
      case "model":
        setSemantic(`Downloading the language model (${msg.backend === "webgpu" ? "GPU" : "CPU"} build, once)… ${msg.pct}%`);
        return;
      case "model-ready":
        setBackend(msg.backend);
        return;
      case "map":
        setMap(msg.files);
        return;
      case "semantic-error":
        if (msg.id === seq.current) setSemantic(`Language-model rerank unavailable (${msg.message}); showing the ranking without it.`);
        return;
      case "server-start":
        if (msg.id === seq.current) setServer("Re-reading the top candidates with the fine-tuned reranker on a GPU server (the first search can take half a minute while it starts)…");
        return;
      case "server-error":
        if (msg.permanent) setServerReady(false);
        if (msg.id === seq.current) setServer(msg.permanent ? "" : `GPU reranker unavailable (${msg.message}); showing the browser's ranking.`);
    }
  }, []);

  const send = useCallback((msg: ToWorker) => {
    if (!worker.current) {
      worker.current = new Worker(new URL("../worker/search.worker.ts", import.meta.url), { type: "module" });
      worker.current.onmessage = (e: MessageEvent<FromWorker>) => onMessage(e.data);
      worker.current.onerror = (e) => {
        setLoadingBoth(false);
        setStatus({ text: `The background worker failed (${e.message || "unknown error"}). Try reloading.`, fraction: null, error: true });
      };
    }
    worker.current.postMessage(msg);
  }, [onMessage]);

  useEffect(() => () => worker.current?.terminate(), []);

  const load = useCallback((input: string, includeTests: boolean) => {
    if (loadingRef.current) {
      // A newer request wins: cancel the load in progress, then start this one.
      pending.current = { input, includeTests };
      send({ type: "cancel" });
      return;
    }
    pending.current = null;
    furthest.current = 0;
    setLoadingBoth(true);
    setResults(null);
    setSemantic("");
    setSemanticIndex(null);
    setMap(null);
    setStatus({ text: "Starting…", fraction: 0, error: false });
    send({ type: "load", input, includeTests, gpu: gpu.current });
  }, [send]);

  start.current = load;
  const cancel = useCallback(() => {
    pending.current = null;
    send({ type: "cancel" });
  }, [send]);
  const requestMap = useCallback(() => send({ type: "map" }), [send]);
  const warm = useCallback(() => send({ type: "warm" }), [send]);
  const preferGpu = useCallback((on: boolean) => {
    gpu.current = on;
  }, []);

  const search = useCallback((query: string, useSemantic: boolean, useServer: boolean) => {
    const id = ++seq.current;
    setSemantic("");
    setServer("");
    if (!query.trim()) {
      setResults(null);
      return;
    }
    send({ type: "search", id, query, semantic: useSemantic, server: useServer, k: RESULTS });
  }, [send]);

  return { loading, status, info, results, semantic, server, serverReady, backend, semanticIndex, stages, map, load, cancel, search, requestMap, warm, preferGpu };
}
