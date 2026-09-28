// Messages between the page and the search worker. Both sides import these types, so a
// mismatched field is a compile error instead of a silent bug in a visitor's browser.
import type { UnitKind } from "../engine/types.ts";

export interface RepoInfo {
  repo: string;
  branch: string;
  /** The folder the search is limited to, if the link named one. */
  scope: string | null;
  via: string;
  sha: string | null;
  files: number;
  units: number;
  notes: string[];
  fromCache: boolean;
  timings: { loadMs: number; indexMs: number };
  /** Set while a long load is still running: search covers the files parsed so far. */
  partial?: { filesDone: number; filesTotal: number };
}

/** A search hit, flattened for postMessage (structured clone). */
export interface WireHit {
  id: string;
  path: string;
  qualname: string;
  kind: UnitKind;
  line: number;
  text: string;
  score: number;
  bm25: number;
  semantic: number | null;
  /** What the issue explicitly named that points here (traceback, quoted name, module). */
  reasons: string[];
  /** For the top results: evidence groups and what each added to the score, largest first. */
  why?: [string, number][];
}

export type Backend = "webgpu" | "wasm";

/** A file as the file ranker scored it, with its best functions. */
export interface WireFile {
  path: string;
  score: number;
  functions: WireHit[];
}

/** Which ranker produced a result list: see web/src/engine/rank.ts. */
export type RankStage = "instant" | "semantic" | "rerank";

export type ToWorker =
  | { type: "load"; input: string; includeTests: boolean }
  | { type: "cancel" }
  | { type: "search"; id: number; query: string; semantic: boolean; k: number }
  | { type: "map" };

export type FromWorker =
  | { type: "progress"; phase: string; done: number; total: number }
  | { type: "loaded"; info: RepoInfo }
  | { type: "partial"; info: RepoInfo }
  | { type: "error"; message: string; cancelled: boolean }
  | { type: "results"; id: number; stage: RankStage; hits: WireHit[]; files?: WireFile[]; terms: string[]; ms: number; computed?: number; stored?: number }
  | { type: "semantic-index"; state: "building" | "ready" | "failed"; units: number; ms: number }
  | { type: "stages"; rerank: boolean; file: boolean }
  | { type: "semantic-start"; id: number }
  | { type: "embedding"; id: number; done: number; total: number }
  | { type: "model"; pct: number; backend: Backend }
  | { type: "model-ready"; backend: Backend }
  | { type: "semantic-error"; id: number; message: string }
  /** Every indexed file with its number of functions and classes, for the repository map. */
  | { type: "map"; files: [path: string, units: number][] };
