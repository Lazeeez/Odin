// A pool of parser threads (parse.worker.ts). Each request goes to the least busy thread;
// replies carry ready-made term counts, so building the index is only a merge, and static
// embeddings, so the semantic index builds on every core.
import type { TermCounts } from "../engine/bm25.ts";
import type { Parsing } from "../engine/repo.ts";
import type { Unit } from "../engine/types.ts";

type Body =
  | { type: "parse"; path: string; text: string }
  | { type: "count"; units: Unit[] }
  | { type: "static"; buffer: ArrayBuffer }
  | { type: "embed"; texts: string[] };
export type PoolRequest = Body & { id: number };
export type PoolReply = { id: number; units: Unit[]; counts: TermCounts[]; vectors?: Float32Array } | { id: number; error: string };

interface Slot {
  worker: Worker;
  busy: number;
}

export interface Pool extends Parsing {
  /** Give every thread the static embedding model (a copy each). */
  loadStatic(buffer: ArrayBuffer): Promise<void>;
  /** Static embeddings of `texts`, row-major, `dim` floats each, spread over the threads. */
  embed(texts: string[], dim: number): Promise<Float32Array>;
}

/** One thread per spare core, up to four; null where workers cannot start workers. */
export function createPool(): Pool | null {
  const size = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  let slots: Slot[];
  try {
    slots = Array.from({ length: size }, () => ({
      worker: new Worker(new URL("./parse.worker.ts", import.meta.url), { type: "module" }),
      busy: 0,
    }));
  } catch {
    return null;
  }
  let next = 0;
  type Ok = Extract<PoolReply, { units: Unit[] }>;
  const waiting = new Map<number, { slot: Slot; resolve: (r: PoolReply) => void }>();
  for (const slot of slots) {
    slot.worker.onmessage = ({ data }: MessageEvent<PoolReply>) => {
      const w = waiting.get(data.id);
      if (!w) return;
      waiting.delete(data.id);
      w.slot.busy--;
      w.resolve(data);
    };
  }
  const sendTo = (slot: Slot, req: Body): Promise<Ok> => {
    const id = next++;
    slot.busy++;
    return new Promise((resolve, reject) => {
      waiting.set(id, { slot, resolve: (r) => ("error" in r ? reject(new Error(r.error)) : resolve(r)) });
      slot.worker.postMessage({ ...req, id } satisfies PoolRequest);
    });
  };
  const send = (req: Body) => sendTo(slots.reduce((a, b) => (b.busy < a.busy ? b : a)), req);
  return {
    threads: size,
    parse: (path, text) => send({ type: "parse", path, text }),
    async count(units) {
      // Big cached repositories: split so every thread tokenizes a share.
      const per = Math.max(500, Math.ceil(units.length / size));
      const parts: Promise<{ counts: TermCounts[] }>[] = [];
      for (let i = 0; i < units.length; i += per) parts.push(send({ type: "count", units: units.slice(i, i + per) }));
      return (await Promise.all(parts)).flatMap((p) => p.counts);
    },
    async loadStatic(buffer) {
      await Promise.all(slots.map((s) => sendTo(s, { type: "static", buffer })));
    },
    async embed(texts, dim) {
      const per = Math.max(200, Math.ceil(texts.length / (size * 4))); // several chunks per thread: even finish
      const parts: Promise<Ok>[] = [];
      for (let i = 0; i < texts.length; i += per) parts.push(send({ type: "embed", texts: texts.slice(i, i + per) }));
      const out = new Float32Array(texts.length * dim);
      let at = 0;
      for (const p of await Promise.all(parts)) {
        out.set(p.vectors!, at);
        at += p.vectors!.length;
      }
      return out;
    },
  };
}
