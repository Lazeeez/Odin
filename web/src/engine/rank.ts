// Learning to rank in the browser: the features of scripts/browser_ltr.py, computed identically
// (tests/test_site_engine.py checks), scored by the LambdaMART trees that script exports to
// data/ranker.json. Stage 1 needs only BM25 and the issue's text; stage 2 adds embedding
// similarity for stage 1's top candidates.
import type { BM25 } from "./bm25.ts";
import { issueFields, type Mentions, moduleName, parseMentions, pathMatches } from "./mentions.ts";
import type { Embed } from "./semantic.ts";
import type { Unit } from "./types.ts";

/** One regression tree as flat arrays: node i sends x[f[i]] <= t[i] to l[i], else r[i]; ~c is leaf c. */
export interface Tree {
  f?: number[];
  t?: number[];
  l?: number[];
  r?: number[];
  v: number[];
}
export interface Stage {
  features: string[];
  trees: Tree[];
}
export interface RankerModel {
  meta: { pool: { bm25: number; title: number; code: number; files: number }; depth: number };
  stage1: Stage;
  stage2?: Stage;
}

export function predict(stage: Stage, x: ArrayLike<number>): number {
  let s = 0;
  for (const tree of stage.trees) {
    if (!tree.f) {
      s += tree.v[0];
      continue;
    }
    let node = 0;
    // Features are float32 as in training; thresholds are exported as float32 (browser_ltr.py).
    while (node >= 0) node = Math.fround(x[tree.f[node]]) <= Math.fround(tree.t![node]) ? tree.l![node] : tree.r![node];
    s += tree.v[~node];
  }
  return s;
}

/** Per-repository facts the features need, computed once per index. */
interface RepoStats {
  fileOf: Int32Array;
  files: string[];
  unitsInFile: Int32Array;
  names: string[];
  nameCount: Map<string, number>;
}
const statsCache = new WeakMap<BM25, RepoStats>();

function repoStats(index: BM25): RepoStats {
  let st = statsCache.get(index);
  if (st) return st;
  const files: string[] = [];
  const fileOf = new Int32Array(index.units.length);
  const names = index.units.map((u) => u.qualname.slice(u.qualname.lastIndexOf(".") + 1));
  const nameCount = new Map<string, number>();
  index.units.forEach((u, d) => {
    if (files.at(-1) !== u.path) files.push(u.path);
    fileOf[d] = files.length - 1;
    nameCount.set(names[d], (nameCount.get(names[d]) ?? 0) + 1);
  });
  const unitsInFile = new Int32Array(files.length);
  for (const f of fileOf) unitsInFile[f]++;
  st = { fileOf, files, unitsInFile, names, nameCount };
  statsCache.set(index, st);
  return st;
}

/** Stable descending order; ties keep index order (numpy argsort(-x, kind="stable")). */
function order(xs: ArrayLike<number>): Int32Array {
  const idx = Int32Array.from({ length: xs.length }, (_, i) => i);
  return idx.sort((a, b) => xs[b] - xs[a] || a - b);
}

function logrank(xs: ArrayLike<number>): Float64Array {
  const out = new Float64Array(xs.length);
  order(xs).forEach((d, r) => {
    out[d] = Math.log(r + 1);
  });
  return out;
}

function rel(xs: ArrayLike<number>): (i: number) => number {
  let top = 0;
  for (let i = 0; i < xs.length; i++) if (xs[i] > top) top = xs[i];
  return (i) => (top > 0 ? xs[i] / top : 0);
}

function topK(xs: ArrayLike<number>, k: number): number[] {
  const out: number[] = [];
  for (const d of order(xs)) {
    if (out.length >= k || xs[d] <= 0) break;
    out.push(d);
  }
  return out;
}

export interface Candidate {
  unit: Unit;
  /** Row in the index. */
  row: number;
  x: Float64Array;
  score: number;
  bm25: number;
  /** Cosine similarity to the issue, once stage 2 has run. */
  semantic?: number;
  /** Plain-language evidence for the "why" line: what the issue named. */
  reasons: string[];
}

export interface Ranked {
  candidates: Candidate[];
  terms: string[];
  title: string;
}

/** Stage 1: the candidate pool, its features and stage-1 scores, best first. */
export function rankStage1(index: BM25, model: RankerModel, query: string): Ranked {
  const { fileOf, files, unitsInFile, names, nameCount } = repoStats(index);
  const n = index.units.length;
  const { pool: P } = model.meta;
  const [title, code] = issueFields(query);
  const { scores: lex, terms } = index.scores(query);
  const titleLex = index.scores(title).scores;
  const codeLex = code ? index.scores(code).scores : new Float64Array(n);
  const m = parseMentions(query);

  const fileMax = new Float64Array(files.length);
  const fileSum = new Float64Array(files.length);
  for (let d = 0; d < n; d++) {
    const f = fileOf[d];
    if (lex[d] > fileMax[f]) fileMax[f] = lex[d];
    fileSum[f] += lex[d];
  }

  const pool = new Set<number>([...topK(lex, P.bm25), ...topK(titleLex, P.title), ...topK(codeLex, P.code)]);
  const topFiles = new Set(topK(fileMax, P.files));
  const mentioned = new Set<number>();
  files.forEach((p, f) => {
    if ([...m.framePaths, ...m.pyPaths].some((x) => pathMatches(x, p))) mentioned.add(f);
  });
  for (let d = 0; d < n; d++) {
    const name = names[d];
    const f = fileOf[d];
    const wanted = (name.length > 2 && m.idents.has(name)) || m.frameNames.has(name);
    if (topFiles.has(f) || (mentioned.has(f) && wanted) || (m.codeIdents.has(name) && name.length > 2)) pool.add(d);
    else if (m.dotted.has(index.units[d].qualname)) pool.add(d);
  }
  const rows = [...pool].sort((a, b) => a - b);

  // Rank of each unit among its own file's units, by BM25.
  const rankInFile = new Float64Array(n);
  const byFile = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => fileOf[a] - fileOf[b] || lex[b] - lex[a] || a - b);
  byFile.forEach((d, i) => {
    rankInFile[d] = i > 0 && fileOf[byFile[i - 1]] === fileOf[d] ? rankInFile[byFile[i - 1]] + 1 : 0;
  });

  const lr = { lex: logrank(lex), title: logrank(titleLex), code: logrank(codeLex), fmax: logrank(fileMax), fsum: logrank(fileSum) };
  const rl = { lex: rel(lex), title: rel(titleLex), code: rel(codeLex), fmax: rel(fileMax), fsum: rel(fileSum) };
  const [lastPath, lastName] = m.lastFrame ?? ["", ""];
  const count = (id: string) => m.idents.get(id) ?? 0;
  const names1 = model.stage1.features;
  const col = new Map(names1.map((f, i) => [f, i]));

  const candidates = rows.map((d): Candidate => {
    const u = index.units[d];
    const f = fileOf[d];
    const parts = u.qualname.split(".");
    const name = parts.at(-1)!;
    const cls = parts.length > 1 ? parts.at(-2)! : "";
    const inFrames = m.framePaths.some((p) => pathMatches(p, u.path));
    const lastFile = !!lastPath && pathMatches(lastPath, u.path);
    const mod = moduleName(u.path);
    const stem = u.path.slice(u.path.lastIndexOf("/") + 1).replace(/\.py$/, "");
    const v: Record<string, number | boolean> = {
      bm25_rel: rl.lex(d), bm25_logrank: lr.lex[d],
      title_bm25_rel: rl.title(d), title_bm25_logrank: lr.title[d],
      code_bm25_rel: rl.code(d), code_bm25_logrank: lr.code[d],
      file_max_rel: rl.fmax(f), file_max_logrank: lr.fmax[f], file_sum_rel: rl.fsum(f), file_sum_logrank: lr.fsum[f],
      rank_in_file: Math.log1p(rankInFile[d]), units_in_file: Math.log1p(unitsInFile[f]),
      is_method: parts.length > 1, is_class: /^[A-Z]/.test(name),
      log_len: Math.log1p(index.lengths[d]),
      is_private: name.startsWith("_") && !name.startsWith("__"), is_dunder: name.startsWith("__"), is_init: name === "__init__",
      path_depth: u.path.split("/").length - 1,
      name_ambiguity: Math.log(nameCount.get(name)!),
      name_count: name.length > 2 ? Math.log1p(count(name)) : 0,
      name_in_code: m.codeIdents.has(name),
      qual_mentioned: parts.length > 1 && m.dotted.has(u.qualname),
      class_count: cls ? Math.log1p(count(cls)) : 0,
      class_in_code: !!cls && m.codeIdents.has(cls),
      frame_name: m.frameNames.has(name), frame_file: inFrames, frame_both: inFrames && m.frameNames.has(name),
      last_frame_file: lastFile, last_frame_both: lastFile && name === lastName,
      path_mentioned: m.pyPaths.some((p) => pathMatches(p, u.path)),
      module_mentioned: m.dotted.has(mod) || m.dotted.has(mod.split(".").slice(-2).join(".")),
      stem_count: stem !== "__init__" ? Math.log1p(count(stem)) : 0,
    };  // prettier-ignore
    const x = new Float64Array(names1.length);
    for (const [k, val] of Object.entries(v)) {
      const i = col.get(k);
      if (i !== undefined) x[i] = Number(val);
    }
    return { unit: u, row: d, x, score: predict(model.stage1, x), bm25: lex[d], reasons: reasons(v, m, name) };
  });
  candidates.sort((a, b) => b.score - a.score || a.row - b.row);
  return { candidates, terms, title };
}

function reasons(v: Record<string, number | boolean>, m: Mentions, name: string): string[] {
  const out: string[] = [];
  if (v.last_frame_both) out.push("where the traceback ends");
  else if (v.frame_both) out.push("in the traceback");
  else if (v.frame_file) out.push("file in the traceback");
  if (v.qual_mentioned) out.push("named in the issue");
  else if (v.name_in_code) out.push("quoted in the issue's code");
  else if (name.length > 2 && m.idents.has(name)) out.push("name appears in the issue");
  if (v.path_mentioned || v.module_mentioned) out.push("module mentioned");
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * Stage 2: rescore stage 1's top `depth` with embedding similarity to the issue and its title.
 * The rest keep stage 1's order below them.
 */
export async function rankStage2(
  model: RankerModel, query: string, ranked: Ranked, embed: Embed, unitText: (u: Unit) => string,
): Promise<Candidate[]> {
  const stage = model.stage2;
  const all = ranked.candidates;
  if (!stage || all.length < 2) return all;
  const top = all.slice(0, model.meta.depth);
  const [qv, tv] = await embed([query, ranked.title]);
  const dv = await embed(top.map((c) => unitText(c.unit)));
  const dense = dv.map((v) => dot(v, qv));
  const tdense = dv.map((v) => dot(v, tv));
  const s1 = logrank(top.map((c) => c.score));
  const dl = logrank(dense);
  const tl = logrank(tdense);
  const dmax = Math.max(...dense);
  const tmax = Math.max(...tdense);
  const k = model.stage1.features.length;
  const rescored = top.map((c, i) => {
    const x = new Float64Array(k + 5);
    x.set(c.x);
    x.set([s1[i], dense[i] - dmax, dl[i], tdense[i] - tmax, tl[i]], k);
    return { ...c, x, score: predict(stage, x), semantic: dense[i] };
  });
  rescored.sort((a, b) => b.score - a.score || a.row - b.row);
  return [...rescored, ...all.slice(top.length)];
}
