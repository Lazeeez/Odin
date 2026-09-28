/// <reference lib="webworker" />
// One of a small pool of parser threads (see pool.ts). Tree-sitter parsing, tokenizing and
// static embedding are the CPU-heavy parts of loading a repository; spread over cores they no
// longer serialize.
import treeSitterWasm from "web-tree-sitter/tree-sitter.wasm?url";
import type { Parser } from "web-tree-sitter";
import grammarWasm from "../assets/tree-sitter-python.wasm?url";
import { unitCounts } from "../engine/bm25.ts";
import { chunkFile, createParser } from "../engine/chunk.ts";
import { embedText, parseStaticModel, type StaticModel } from "../engine/static.ts";
import type { Unit } from "../engine/types.ts";
import type { PoolReply, PoolRequest } from "./pool.ts";

declare const self: DedicatedWorkerGlobalScope;
let parser: Promise<Parser> | null = null;
let staticModel: StaticModel | null = null;

self.onmessage = async ({ data }: MessageEvent<PoolRequest>) => {
  let reply: PoolReply;
  const transfer: Transferable[] = [];
  try {
    if (data.type === "parse") {
      const p = await (parser ??= createParser(treeSitterWasm, grammarWasm));
      const units: Unit[] = [];
      for (const c of chunkFile(p, data.text)) if (c.text.trim()) units.push({ ...c, path: data.path, id: `${data.path}::${c.qualname}` });
      reply = { id: data.id, units, counts: units.map(unitCounts) };
    } else if (data.type === "count") {
      reply = { id: data.id, units: [], counts: data.units.map(unitCounts) };
    } else if (data.type === "static") {
      staticModel = parseStaticModel(data.buffer);
      reply = { id: data.id, units: [], counts: [] };
    } else {
      if (!staticModel) throw new Error("static model not loaded");
      const dim = staticModel.dim;
      const vectors = new Float32Array(data.texts.length * dim);
      data.texts.forEach((t, i) => vectors.set(embedText(staticModel!, t), i * dim));
      reply = { id: data.id, units: [], counts: [], vectors };
      transfer.push(vectors.buffer);
    }
  } catch (err) {
    reply = { id: data.id, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply, transfer);
};
