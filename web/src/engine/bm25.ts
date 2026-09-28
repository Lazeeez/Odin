// Okapi BM25 with the same formula, k1 and b as odin/search/bm25.py.
import { pathText, tokenize } from "./tokenize.ts";
import type { SearchResult, Unit } from "./types.ts";

/** A unit's indexed terms and their counts: parallel arrays, cheap to post between threads. */
export type TermCounts = [terms: string[], tfs: number[]];

/** What a unit is indexed as: its qualified name, its code and its path's words. */
export function unitCounts(u: { qualname: string; text: string; path: string }): TermCounts {
  const counts = new Map<string, number>();
  const text = [u.qualname, u.text, pathText(u.path)].join("\n");
  for (const t of tokenize(text)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [[...counts.keys()], [...counts.values()]];
}

export class BM25 {
  readonly units: readonly Unit[];
  // term -> flat [doc, tf, doc, tf, ...]: compact, and cheap to walk for one query term.
  private readonly postings = new Map<string, number[]>();
  private readonly norm: Float64Array;
  private readonly k1: number;
  /** Tokens per unit, a ranking feature (short units are likelier fixes). */
  readonly lengths: Float64Array;

  /** `counts` (one per unit, from `unitCounts`) lets tokenizing happen elsewhere, e.g. in parallel. */
  constructor(units: readonly Unit[], { counts, k1 = 1.2, b = 0.75 }: { counts?: readonly TermCounts[]; k1?: number; b?: number } = {}) {
    this.units = units;
    this.k1 = k1;
    const lengths = (this.lengths = new Float64Array(units.length));
    units.forEach((u, d) => {
      const [terms, tfs] = counts?.[d] ?? unitCounts(u);
      let len = 0;
      for (let i = 0; i < terms.length; i++) {
        len += tfs[i];
        let p = this.postings.get(terms[i]);
        if (!p) this.postings.set(terms[i], (p = []));
        p.push(d, tfs[i]);
      }
      lengths[d] = len;
    });
    const avg = lengths.reduce((a, c) => a + c, 0) / Math.max(1, units.length);
    this.norm = lengths.map((l) => k1 * (1 - b + (b * l) / avg));
  }

  /** BM25 score of every unit for `query`, and the distinct query terms. */
  scores(query: string): { scores: Float64Array; terms: string[] } {
    const qtf = new Map<string, number>();
    for (const t of tokenize(query)) qtf.set(t, (qtf.get(t) ?? 0) + 1);
    const n = this.units.length;
    const scores = new Float64Array(n);
    for (const [t, q] of qtf) {
      const p = this.postings.get(t);
      if (!p) continue;
      const df = p.length / 2;
      const idf = Math.log1p((n - df + 0.5) / (df + 0.5));
      for (let i = 0; i < p.length; i += 2) {
        const tf = p[i + 1];
        scores[p[i]] += (q * idf * (tf * (this.k1 + 1))) / (tf + this.norm[p[i]]);
      }
    }
    return { scores, terms: [...qtf.keys()] };
  }

  search(query: string, k = 10): SearchResult {
    const { scores, terms } = this.scores(query);
    const idx: number[] = [];
    scores.forEach((s, i) => {
      if (s > 0) idx.push(i);
    });
    idx.sort((a, b) => scores[b] - scores[a] || a - b);
    return { hits: idx.slice(0, k).map((i) => ({ unit: this.units[i], score: scores[i] })), terms };
  }
}
