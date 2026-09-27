import { inlineCode } from "../lib/format.ts";

const CARDS: [string, string, string][] = [
  ["377×", "faster git reads", "One long-lived `git cat-file --batch` process instead of two subprocesses per file."],
  ["36.7×", "fewer embeddings", "6.79M function slots across 698 commits, 185k distinct: each function is embedded once, keyed by content hash."],
  ["90%", "of files never re-parsed", "Parsing is memoized by git blob id; a persistent cache keyed by the parser's own source makes re-runs 3.4× faster."],
  ["4.8×", "embedding throughput", "Length-sorted, token-budgeted batches: padding waste falls from 79% to 2%."],
  ["~10 ms", "git-history features", "The commit DAG lives in memory, replacing a 100 ms `git rev-list` per query with an identical walk."],
  ["0 of 17,369", "chunking mismatches", "This page's WebAssembly chunker and its BM25 are tested against the Python ones on real django, sympy and requests code."],
];

export function Engineering() {
  return (
    <section id="engineering" class="band">
      <h2>Engineering highlights</h2>
      <div class="cards">
        {CARDS.map(([big, t, p]) => (
          <div class="ecard" key={t}>
            <div class="big">{big}</div>
            <div class="t">{t}</div>
            <p dangerouslySetInnerHTML={{ __html: inlineCode(p) }} />
          </div>
        ))}
      </div>
      <h3>What didn't work (and why that's in here)</h3>
      <ul class="negatives">
        <li><b>Call-graph expansion:</b> tuned on a dev set, +0.3 points, not significant. Only 15% of misses were one call away from a top hit, so the ceiling was low.</li>
        <li><b>Zero-shot LLM rerankers:</b> Qwen3-Reranker 0.6B and a 4-bit 4B both matched, not beat, the existing ranking. Fine-tuning the 0.6B on in-domain hard negatives is what made the reranker work.</li>
        <li><b>ANN search (HNSW):</b> building it costs ~650 ms to save ~0.05 ms per query; every commit answers one query, so exact search is faster and lossless.</li>
        <li><b>LightGBM tuning:</b> seven hyperparameter variants all landed within ±0.005 of the defaults, a plateau worth knowing about.</li>
      </ul>
      <h3>How the numbers are kept honest</h3>
      <ul class="method">
        <li>Every issue is searched at its own <code>base_commit</code>. Indexing HEAD would leak the fix.</li>
        <li>Nothing is tuned on the reported test set: fusion on SWE-bench Verified minus Lite, learned rankers on 1,941 other SWE-bench issues, reranker weights on a held-out split.</li>
        <li>Git-history features use only ancestors of the base commit; "similar past bugs" only see issues opened 30+ days earlier. Both boundaries have tests.</li>
        <li>Every improvement comes with a paired bootstrap test; non-significant ones are reported as such.</li>
      </ul>
    </section>
  );
}
