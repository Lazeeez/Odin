// Learning to rank in the browser: the features of odin/rank/browser.py, computed identically
// (tests/test_site_engine.py checks), scored by the LambdaMART trees scripts/browser_ltr.py
// exports. Stages: "instant" (keyword and mention signals), "semantic" (plus static-embedding
// similarity over every function), "rerank" (plus MiniLM similarity for the top candidates),
// and "file" (a ranker over files).
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
  meta: {
    pool: { bm25: number; title: number; code: number; files: number; sem?: number; title_sem?: number };
    depth: number;
    static?: { model: string; maxTokens: number };
  };
  instant: Stage;
  semantic?: Stage;
  rerank?: Stage;
  file?: Stage;
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

function max(xs: ArrayLike<number>): number {
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  return m;
}

/** The k best indices; `positive` keeps only scores above zero (keyword scores). */
function topK(xs: ArrayLike<number>, k: number, positive = true): number[] {
  const out: number[] = [];
  for (const d of order(xs)) {
    if (out.length >= k || (positive && xs[d] <= 0)) break;
    out.push(d);
  }
  return out;
}

/** Per-group maximum (numpy's maximum.at over a group index), starting from `empty`. */
function byGroup(values: ArrayLike<number>, group: Int32Array, n: number, empty: number): Float64Array {
  const out = new Float64Array(n).fill(empty);
  for (let d = 0; d < values.length; d++) if (values[d] > out[group[d]]) out[group[d]] = values[d];
  return out;
}

/** Similarity of every unit to the issue and to its title (static embeddings). */
export interface Similarity {
  issue: Float32Array;
  title: Float32Array;
}

/** What every stage needs about one issue against one repository. */
export interface Signals {
  query: string;
  title: string;
  terms: string[];
  lex: Float64Array;
  titleLex: Float64Array;
  codeLex: Float64Array;
  m: Mentions;
  sim?: Similarity;
}

export function signals(index: BM25, query: string, sim?: Similarity): Signals {
  const [title, code] = issueFields(query);
  const { scores: lex, terms } = index.scores(query);
  return {
    query, title, terms, lex, sim,
    titleLex: index.scores(title).scores,
    codeLex: code ? index.scores(code).scores : new Float64Array(index.units.length),
    m: parseMentions(query),
  };  // prettier-ignore
}

export interface Candidate {
  unit: Unit;
  /** Row in the index. */
  row: number;
  x: Float64Array;
  score: number;
  bm25: number;
  /** Cosine similarity to the issue (static embedding, or MiniLM after the rerank stage). */
  semantic?: number;
  /** Plain-language evidence for the "why" line: what the issue named. */
  reasons: string[];
}

export interface Ranked {
  candidates: Candidate[];
  terms: string[];
  title: string;
}

/**
 * The candidate pool, its features and scores under `stage`, best first. With `sig.sim` the
 * pool also takes the semantic top candidates and the SEMANTIC features are appended.
 */
export function rankUnits(index: BM25, model: RankerModel, stage: Stage, sig: Signals): Ranked {
  const { fileOf, files, unitsInFile, names, nameCount } = repoStats(index);
  const n = index.units.length;
  const P = model.meta.pool;
  const { lex, titleLex, codeLex, m, sim } = sig;

  const fileMax = new Float64Array(files.length);
  const fileSum = new Float64Array(files.length);
  for (let d = 0; d < n; d++) {
    const f = fileOf[d];
    if (lex[d] > fileMax[f]) fileMax[f] = lex[d];
    fileSum[f] += lex[d];
  }

  const pool = new Set<number>([...topK(lex, P.bm25), ...topK(titleLex, P.title), ...topK(codeLex, P.code)]);
  if (sim) for (const d of [...topK(sim.issue, P.sem ?? 50, false), ...topK(sim.title, P.title_sem ?? 20, false)]) pool.add(d);
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
  const sem = sim && (() => {
    const best = byGroup(sim.issue, fileOf, files.length, -1);
    return {
      max: max(sim.issue), lr: logrank(sim.issue), tmax: max(sim.title), tlr: logrank(sim.title),
      fbest: best, fmax: max(best), flr: logrank(best),
    };  // prettier-ignore
  })();
  const [lastPath, lastName] = m.lastFrame ?? ["", ""];
  const count = (id: string) => m.idents.get(id) ?? 0;
  const col = new Map(stage.features.map((f, i) => [f, i]));

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
    if (sim && sem) {
      Object.assign(v, {
        sem: sim.issue[d], sem_gap: sim.issue[d] - sem.max, sem_logrank: sem.lr[d],
        title_sem_gap: sim.title[d] - sem.tmax, title_sem_logrank: sem.tlr[d],
        file_sem_gap: sem.fbest[f] - sem.fmax, file_sem_logrank: sem.flr[f],
      });  // prettier-ignore
    }
    const x = new Float64Array(stage.features.length);
    for (const [k, val] of Object.entries(v)) {
      const i = col.get(k);
      if (i !== undefined) x[i] = Number(val);
    }
    return { unit: u, row: d, x, score: predict(stage, x), bm25: lex[d], semantic: sim?.issue[d], reasons: reasons(v, m, name) };
  });
  candidates.sort((a, b) => b.score - a.score || a.row - b.row);
  return { candidates, terms: sig.terms, title: sig.title };
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

export interface FileCandidate {
  path: string;
  row: number;
  x: Float64Array;
  score: number;
  /** The file's functions among the ranked candidates, best first. */
  units: Candidate[];
}

/**
 * The file stage (FILE_FEATURES of odin/rank/browser.py): candidate files from the semantic
 * stage's pool, what the issue names and the strongest keyword and semantic files.
 */
export function rankFiles(
  index: BM25, stage: Stage, unitStage: Stage, sig: Signals, ranked: Ranked, filePool = { lex: 20, sem: 20 },
): FileCandidate[] {
  const { fileOf, files, unitsInFile } = repoStats(index);
  const nf = files.length;
  const { lex, titleLex, codeLex, m, sim } = sig;
  const fileMax = byGroup(lex, fileOf, nf, 0);
  const titleMax = byGroup(titleLex, fileOf, nf, 0);
  const codeMax = byGroup(codeLex, fileOf, nf, 0);
  const fileSum = new Float64Array(nf);
  for (let d = 0; d < lex.length; d++) fileSum[fileOf[d]] += lex[d];
  const semBest = sim ? byGroup(sim.issue, fileOf, nf, -1) : new Float64Array(nf).fill(-1);
  const titleSemBest = sim ? byGroup(sim.title, fileOf, nf, -1) : new Float64Array(nf).fill(-1);
  const best = new Float64Array(nf).fill(-Infinity);
  const poolUnits = new Float64Array(nf);
  const pooled = ranked.candidates;
  // Candidate features were built for the unit stage; read the mention columns by name.
  const agg = { name_in_code: new Float64Array(nf), name_count: new Float64Array(nf), qual_mentioned: new Float64Array(nf), frame_both: new Float64Array(nf) };
  const byFileUnits = new Map<number, Candidate[]>();
  for (const c of pooled) {
    const f = fileOf[c.row];
    if (c.score > best[f]) best[f] = c.score;
    poolUnits[f]++;
    (byFileUnits.get(f) ?? byFileUnits.set(f, []).get(f)!).push(c);
  }
  for (const c of pooled) {
    const f = fileOf[c.row];
    for (const k of Object.keys(agg) as (keyof typeof agg)[]) {
      const i = unitStage.features.indexOf(k);
      const v = i >= 0 ? c.x[i] : 0;
      if (v > agg[k][f]) agg[k][f] = v;
    }
  }
  const mentioned = new Set<number>();
  files.forEach((p, f) => {
    if ([...m.framePaths, ...m.pyPaths].some((x) => pathMatches(x, p))) mentioned.add(f);
  });
  const cand = new Set<number>([...byFileUnits.keys(), ...mentioned, ...topK(fileMax, filePool.lex), ...topK(semBest, filePool.sem, false)]);
  const frows = [...cand].sort((a, b) => a - b);

  let finiteMin = Infinity;
  for (const b of best) if (Number.isFinite(b) && b < finiteMin) finiteMin = b;
  const floor = Number.isFinite(finiteMin) ? finiteMin - 1 : 0;
  const bestF = Float64Array.from(best, (b) => (Number.isFinite(b) ? b : floor));
  const inCand = new Float64Array(nf).fill(floor - 1);
  for (const f of frows) inCand[f] = bestF[f];
  let bestTop = -Infinity;
  for (const f of frows) if (bestF[f] > bestTop) bestTop = bestF[f];
  const lr = { best: logrank(inCand), fmax: logrank(fileMax), fsum: logrank(fileSum), title: logrank(titleMax), sem: logrank(semBest) };
  const rl = { fmax: rel(fileMax), fsum: rel(fileSum), title: rel(titleMax), code: rel(codeMax) };
  const semTop = max(semBest);
  const titleSemTop = max(titleSemBest);
  const [lastPath] = m.lastFrame ?? [""];
  const col = new Map(stage.features.map((f, i) => [f, i]));
  const out = frows.map((f): FileCandidate => {
    const path = files[f];
    const mod = moduleName(path);
    const stem = path.slice(path.lastIndexOf("/") + 1).replace(/\.py$/, "");
    const v: Record<string, number | boolean> = {
      best_score_gap: bestF[f] - bestTop, best_score_logrank: lr.best[f], pool_units: Math.log1p(poolUnits[f]),
      file_max_rel: rl.fmax(f), file_max_logrank: lr.fmax[f], file_sum_rel: rl.fsum(f), file_sum_logrank: lr.fsum[f],
      title_max_rel: rl.title(f), title_max_logrank: lr.title[f], code_max_rel: rl.code(f),
      sem_gap: semBest[f] - semTop, sem_logrank: lr.sem[f], title_sem_gap: titleSemBest[f] - titleSemTop,
      path_mentioned: m.pyPaths.some((p) => pathMatches(p, path)),
      module_mentioned: m.dotted.has(mod) || m.dotted.has(mod.split(".").slice(-2).join(".")),
      stem_count: stem !== "__init__" ? Math.log1p(m.idents.get(stem) ?? 0) : 0,
      frame_file: m.framePaths.some((p) => pathMatches(p, path)),
      last_frame_file: !!lastPath && pathMatches(lastPath, path),
      any_name_in_code: agg.name_in_code[f], max_name_count: agg.name_count[f],
      any_qual_mentioned: agg.qual_mentioned[f], any_frame_both: agg.frame_both[f],
      units_in_file: Math.log1p(unitsInFile[f]), path_depth: path.split("/").length - 1, is_init_file: stem === "__init__",
    };  // prettier-ignore
    const x = new Float64Array(stage.features.length);
    for (const [k, val] of Object.entries(v)) {
      const i = col.get(k);
      if (i !== undefined) x[i] = Number(val);
    }
    return { path, row: f, x, score: predict(stage, x), units: byFileUnits.get(f) ?? [] };
  });
  out.sort((a, b) => b.score - a.score || a.row - b.row);
  return out;
}

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/**
 * The rerank stage: MiniLM similarity to the issue and its title for the top `depth`
 * candidates, blended in by the stage's trees. The rest keep their order below them.
 */
export async function rerankStage(
  model: RankerModel, ranked: Ranked, embed: Embed, unitText: (u: Unit) => string, query: string,
): Promise<Candidate[]> {
  const stage = model.rerank;
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
  const k = top[0].x.length;
  const rescored = top.map((c, i) => {
    const x = new Float64Array(k + 5);
    x.set(c.x);
    x.set([s1[i], dense[i] - dmax, dl[i], tdense[i] - tmax, tl[i]], k);
    return { ...c, x, score: predict(stage, x), semantic: dense[i] };
  });
  rescored.sort((a, b) => b.score - a.score || a.row - b.row);
  return [...rescored, ...all.slice(top.length)];
}

/** Evidence groups for explanations: each is a set of ranker features one sentence can name. */
const EVIDENCE: [label: string, features: string[]][] = [
  ["Words shared with the issue", ["bm25_rel", "bm25_logrank"]],
  ["Words shared with the title", ["title_bm25_rel", "title_bm25_logrank"]],
  ["Matches the issue's quoted code", ["code_bm25_rel", "code_bm25_logrank"]],
  ["Its file matches the issue", ["file_max_rel", "file_max_logrank", "file_sum_rel", "file_sum_logrank", "rank_in_file", "units_in_file"]],
  ["Named in the issue", ["name_count", "name_in_code", "qual_mentioned", "class_count", "class_in_code", "name_ambiguity"]],
  ["In the traceback", ["frame_name", "frame_file", "frame_both", "last_frame_file", "last_frame_both"]],
  ["Module or path mentioned", ["path_mentioned", "module_mentioned", "stem_count"]],
  ["Close in meaning", ["sem", "sem_gap", "sem_logrank", "title_sem_gap", "title_sem_logrank", "file_sem_gap", "file_sem_logrank",
    "dense_gap", "dense_logrank", "title_dense_gap", "title_dense_logrank"]],
  ["Ranked high by the first pass", ["s1_logrank"]],
  ["Shape of the code", ["is_method", "is_class", "log_len", "is_private", "is_dunder", "is_init", "path_depth"]],
];

/**
 * Why each of `top` scored as it did: for every evidence group, how much the score drops when that
 * group's features are set to the pool's median, i.e. what the evidence adds over a typical
 * candidate. Occlusion, not TreeSHAP: the exported trees carry leaf values only. About
 * groups x top tree walks, a few milliseconds.
 */
export function explain(stage: Stage, top: Candidate[], pool: Candidate[]): [string, number][][] {
  const k = stage.features.length;
  const rows = pool.filter((c) => c.x.length === k);
  const col = new Map(stage.features.map((f, i) => [f, i]));
  const median = new Float64Array(k);
  for (let i = 0; i < k; i++) {
    const v = rows.map((c) => c.x[i]).sort((a, b) => a - b);
    median[i] = v.length ? v[v.length >> 1] : 0;
  }
  const groups = EVIDENCE.map(([label, fs]) => [label, fs.map((f) => col.get(f)).filter((i): i is number => i !== undefined)] as const)
    .filter(([, idx]) => idx.length);
  return top.map((c) => {
    if (c.x.length !== k) return [];
    const out: [string, number][] = [];
    for (const [label, idx] of groups) {
      const x = Float64Array.from(c.x);
      for (const i of idx) x[i] = median[i];
      const delta = c.score - predict(stage, x);
      if (Math.abs(delta) > 1e-3) out.push([label, delta]);
    }
    return out.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 5);
  });
}
