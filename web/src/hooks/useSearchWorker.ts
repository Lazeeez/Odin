import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { RESULTS, SEMANTIC } from "../engine/semantic.ts";
import type { Backend, FromWorker, RepoInfo, ToWorker, WireHit } from "../worker/protocol.ts";

export interface LoadStatus {
  text: string;
  fraction: number | null;
  error: boolean;
}

export interface Results {
  stage: "keyword" | "semantic";
  hits: WireHit[];
  terms: string[];
  ms: number;
  computed?: number;
  stored?: number;
}

/** Everything the page needs from the background search worker, as reactive state. */
export function useSearchWorker() {
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const loadingRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<LoadStatus | null>(null);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [semantic, setSemantic] = useState("");
  const [backend, setBackend] = useState<Backend | null>(null);

  const setLoadingBoth = (v: boolean) => {
    loadingRef.current = v;
    setLoading(v);
  };

  const onMessage = useCallback((msg: FromWorker) => {
    switch (msg.type) {
      case "progress": {
        if (!loadingRef.current) return; // late reports from downloads in flight at cancel
        const files = msg.total > 1 ? ` ${msg.done.toLocaleString()} / ${msg.total.toLocaleString()} files` : "";
        setStatus({ text: `${msg.phase}…${files}`, fraction: msg.total ? msg.done / msg.total : 0, error: false });
        return;
      }
      case "loaded":
        setLoadingBoth(false);
        setStatus(null);
        setInfo(msg.info);
        return;
      case "error":
        setLoadingBoth(false);
        setStatus({ text: msg.message, fraction: null, error: !msg.cancelled });
        return;
      case "results":
        if (msg.id !== seq.current) return;
        setResults(msg);
        if (msg.stage === "semantic") {
          const parts = [];
          if (msg.computed) parts.push(`embedded ${msg.computed} new functions`);
          if (msg.stored) parts.push(`${msg.stored} from your browser's cache`);
          setSemantic(`semantic rerank of the top ${SEMANTIC.depth}: ${msg.ms.toFixed(0)} ms${parts.length ? ` (${parts.join(", ")})` : " (already embedded this session)"}`);
        }
        return;
      case "semantic-start":
        if (msg.id === seq.current) setSemantic("Reranking the top candidates semantically…");
        return;
      case "embedding":
        if (msg.id === seq.current) setSemantic(`Embedding candidates… ${msg.done} / ${msg.total}`);
        return;
      case "model":
        setSemantic(`Downloading the semantic model (${msg.backend === "webgpu" ? "GPU" : "CPU"} build, once)… ${msg.pct}%`);
        return;
      case "model-ready":
        setBackend(msg.backend);
        return;
      case "semantic-error":
        if (msg.id === seq.current) setSemantic(`Semantic rerank unavailable (${msg.message}); showing the instant ranking.`);
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
    if (loadingRef.current) return;
    setLoadingBoth(true);
    setResults(null);
    setSemantic("");
    setStatus({ text: "Starting…", fraction: 0, error: false });
    send({ type: "load", input, includeTests });
  }, [send]);

  const cancel = useCallback(() => send({ type: "cancel" }), [send]);

  const search = useCallback((query: string, useSemantic: boolean) => {
    const id = ++seq.current;
    setSemantic("");
    if (!query.trim()) {
      setResults(null);
      return;
    }
    send({ type: "search", id, query, semantic: useSemantic, k: RESULTS });
  }, [send]);

  return { loading, status, info, results, semantic, backend, load, cancel, search };
}
